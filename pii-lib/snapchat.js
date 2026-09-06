// Snapchat Pixel request detection & parsing — pure functions, no DOM / chrome
// APIs, so they run both in the panel and under `node --test`. Mirrors
// lib/pinterest.js so the panel treats every provider uniformly.
//
// Snapchat fires to tr.snapchat.com/p (loader: sc-static.net/scevent.min.js). There
// are two request shapes under /p:
//   GET  /p  — the TRACKING EVENT. Carries the identifiers + e-commerce in the query
//              string. This is what we surface.
//   POST /p  — internal telemetry (ctx{session,screen,ua,url,perf} + req[] batches:
//              logs, page metadata, form-field detection). No user identifiers, so we
//              intentionally ignore it (it lacks pid/ev in the query, so requiring
//              those below excludes it cleanly).
//
// GET /p payload (all identifier/geo fields are SHA-256 of the lower-cased value):
//   pid / pids   pixel id (UUID) · ev  event (PAGE_VIEW | PURCHASE | …)
//   u_hem u_hpn  hashed email / phone      u_fn u_ln  hashed first / last name
//   u_age        hashed age                l_city l_gc l_gpc l_gr  hashed city / country /
//                postal / region           u_hed  a derived/composite hash (no single field)
//   u_c1         client id (uuid)          u_sclid u_scsid  click / session id
//   e_*          e-commerce: e_cur e_pr e_tid e_ni e_iids e_ic e_desc e_ss e_bds and
//                the extras cdid(=dedup) e_cs du e_dm et e_lv e_pia e_sm e_su
//   pl page url · rf referrer · ts time · v version · intg integration

import { extractParams, makeGetter, piiField } from './params.js';

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

// Event beacons go to tr.snapchat.com / tr6.snapchat.com (numbered mirrors).
export function isSnapchatHost(host) {
  return /^tr\d*\.snapchat\.com$/.test((host || '').toLowerCase());
}

function isEventPath(pathname) {
  return /^\/p$/.test(pathname || '');
}

// Snapchat's standard events (lower-cased). Unknown → custom.
const STANDARD_EVENTS = new Set([
  'page_view', 'view_content', 'add_cart', 'signup', 'sign_up', 'purchase', 'search',
  'subscribe', 'start_checkout', 'add_billing', 'save', 'login', 'list_view', 'reserve',
  'ad_click', 'ad_view', 'complete_tutorial', 'level_complete', 'invite', 'share',
  'custom_event_1', 'custom_event_2', 'custom_event_3', 'custom_event_4', 'custom_event_5',
]);

// ---------------------------------------------------------------------------
// Identifiers (u_* / l_*), all SHA-256 hashed
// ---------------------------------------------------------------------------

const U_FIELD = {
  u_hem:  { bucket: 'email',     label: 'Email' },
  u_hpn:  { bucket: 'phone',     label: 'Phone' },
  u_fn:   { bucket: 'firstName', label: 'First name' },
  u_ln:   { bucket: 'lastName',  label: 'Last name' },
  u_age:  { bucket: 'age',       label: 'Age' },
  l_city: { bucket: 'city',      label: 'City' },
  l_gc:   { bucket: 'country',   label: 'Country' },
  l_gpc:  { bucket: 'postal',    label: 'Postal code' },
  l_gr:   { bucket: 'region',    label: 'Region' },
  u_hed:  { bucket: 'other',     label: 'Hashed data (u_hed)' },
};

// Returns { <key>: { bucket, label, hashed, algo } } or null.
export function extractSnapchatUserData(get) {
  const ud = {};
  for (const [key, def] of Object.entries(U_FIELD)) {
    const v = get(key);
    if (v == null || v === '') continue;
    ud[key] = piiField(def.bucket, def.label, v);
  }
  return Object.keys(ud).length ? ud : null;
}

// Compact { email, phone, name, address } summary — same shape as the other
// providers. age / other are surfaced separately (not in the four buckets).
export function summarizeSnapchatIdentifiers(userData) {
  const b = { email: 0, phone: 0, firstName: 0, lastName: 0, city: 0, country: 0, postal: 0, region: 0 };
  for (const f of Object.values(userData || {})) {
    if (f.bucket && f.bucket in b) b[f.bucket] += 1;
  }
  return {
    email: b.email,
    phone: b.phone,
    name: Math.max(b.firstName, b.lastName),
    address: Math.max(b.city, b.country, b.postal, b.region),
  };
}

// ---------------------------------------------------------------------------
// E-commerce (e_*)
// ---------------------------------------------------------------------------

// Returns { value, currency, transactionId, numItems, itemIds:[…], category, brands:[…], … } or null.
export function extractSnapchatEcommerce(get) {
  const out = {};
  if (get('e_pr') != null && get('e_pr') !== '')   out.value = String(get('e_pr'));
  if (get('e_cur'))                                 out.currency = String(get('e_cur'));
  if (get('e_tid'))                                 out.transactionId = String(get('e_tid'));
  if (get('e_ni') != null && get('e_ni') !== '')   out.numItems = String(get('e_ni'));
  if (get('e_ic'))                                  out.category = String(get('e_ic'));
  if (get('e_desc'))                                out.description = String(get('e_desc'));
  if (get('e_ss'))                                  out.searchString = String(get('e_ss'));
  if (get('e_iids'))  out.itemIds = String(get('e_iids')).split(',').map((s) => s.trim()).filter(Boolean);
  if (get('e_bds'))   out.brands = String(get('e_bds')).split(',').map((s) => s.trim()).filter(Boolean);
  return Object.keys(out).length ? out : null;
}

// The remaining e_* / purchase flags kept aside for the detail view.
const EXTRA_FIELD = {
  cdid: 'client_deduplication_id',
  e_cs: 'customer_status',
  du:   'data_use',
  e_dm: 'delivery_method',
  et:   'event_tag',
  e_lv: 'level',
  e_pia: 'payment_info_available',
  e_sm: 'sign_up_method',
  e_su: 'success',
};

export function extractSnapchatExtras(get) {
  const out = {};
  for (const [key, label] of Object.entries(EXTRA_FIELD)) {
    const v = get(key);
    if (v == null || v === '') continue;
    out[label] = String(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Full parse
// ---------------------------------------------------------------------------

// Returns a normalized record or null for non-Snapchat / non-event requests.
export function parseSnapchatRequest(url, postData) {
  let host = '', pathname = '';
  try { const u = new URL(url); host = u.host; pathname = u.pathname; }
  catch (e) { return null; }

  if (!isSnapchatHost(host)) return null;
  if (!isEventPath(pathname)) return null;

  const { queryParams, bodyParams } = extractParams(url, postData);
  const get = makeGetter(queryParams, bodyParams);

  const pid = get('pid') || get('pids');
  const eventRaw = get('ev');
  // The GET event carries both; the POST telemetry beacon carries neither → ignored.
  if (!pid || !eventRaw) return null;

  const event = String(eventRaw);
  const standardEvent = STANDARD_EVENTS.has(event.toLowerCase());

  const userData = extractSnapchatUserData(get);
  const identifiers = summarizeSnapchatIdentifiers(userData);
  const ecommerce = extractSnapchatEcommerce(get);
  const extras = extractSnapchatExtras(get);

  const revenue = (ecommerce && ecommerce.value != null)
    ? { value: ecommerce.value, currency: ecommerce.currency || null }
    : null;
  const dedupId = get('cdid') || null;

  const flags = {
    standardEvent,
    custom: !standardEvent,
    ecommerce: !!ecommerce,
    dedup: !!dedupId,                                     // cdid → client_deduplication_id
    advancedMatching: !!userData,                        // any hashed u_* / l_* identifier
  };

  return {
    provider: 'snapchat',
    transport: 'standard',
    host,
    pathname,
    effectiveUrl: url,
    effectivePath: pathname,
    method: postData ? 'POST' : 'GET',
    event,
    pixelId: String(pid),
    pageUrl: get('pl') || null,
    referrer: get('rf') || null,
    version: get('v') || null,
    integration: get('intg') || null,
    standardEvent,
    revenue,
    dedupId,
    clientId: get('u_c1') || null,
    clickId: get('u_sclid') || null,
    sessionId: get('u_scsid') || null,
    flags,
    userData,
    identifiers,
    ecommerce,
    extras,
    consent: null,                                        // 'du' (data_use) surfaced under extras
    queryParams,
    bodyParams,
  };
}
