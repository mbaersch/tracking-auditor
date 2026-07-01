// Pinterest Tag request detection & parsing — pure functions, no DOM / chrome
// APIs, so they run both in the panel and under `node --test`. Mirrors the shape
// of lib/ga4.js / lib/meta.js / lib/tiktok.js so the panel treats every provider
// uniformly.
//
// A browser tag hit goes to ct.pinterest.com/v3/ as a GET beacon. The payload
// rides in three URL-encoded JSON query params:
//   ed = event data (value/currency/order_id/line_items[]/custom fields)
//   pd = partner data / enhanced match (em/ph/… hashes, pin_unauth, np)
//   ad = app/device data (loc = page url, ref = referrer, is_eu, browser info)
// A POST exists for large payloads (params then sit in the body) — we read both.
// The /user endpoint carries only a subset and is intentionally ignored (the /v3
// hit already has everything). The noscript/img bracket-param variant
// (ed[value]=…, pd[em]=…) is a later add.

import { extractParams } from './params.js';

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export function isPinterestHost(host) {
  const h = (host || '').toLowerCase();
  return h === 'ct.pinterest.com';
}

function isV3Path(pathname) {
  return /^\/v3(\/|$)/.test(pathname || '');
}

// Known standard events (lowercase). Aliases map common names onto the canonical
// CAPI vocabulary; anything unmapped and not in the set is a custom event.
const STANDARD_EVENTS = new Set([
  'pagevisit', 'signup', 'checkout', 'custom', 'addtocart', 'lead', 'search',
  'viewcategory', 'watchvideo', 'init', 'base code page load',
]);
const EVENT_ALIASES = {
  pageview: 'pagevisit', page_visit: 'pagevisit', view: 'pagevisit',
  viewcategory: 'viewcategory', view_category: 'viewcategory',
  purchase: 'checkout', buy: 'checkout', pay: 'checkout', completepayment: 'checkout',
  completeregistration: 'signup', register: 'signup',
  add_to_cart: 'addtocart', watch_video: 'watchvideo',
};
// Events (canonical) that imply an e-commerce payload.
const ECOMMERCE_EVENTS = new Set(['addtocart', 'checkout']);

function canonicalEvent(raw) {
  if (!raw) return 'base code page load';
  const e = String(raw).toLowerCase();
  return EVENT_ALIASES[e] || e;
}

// ---------------------------------------------------------------------------
// Enhanced match (pd)
// ---------------------------------------------------------------------------
//
// pd carries the hashed identifiers plus Pinterest plumbing (np, gtm_version,
// pin_unauth cookie id, aem_eligible_list). We key by the identifier field, note
// whether the value looks hashed, and keep the non-identifier plumbing aside.

const PD_FIELD = {
  em:           { bucket: 'email',      label: 'Email' },
  ph:           { bucket: 'phone',      label: 'Phone' },
  fn:           { bucket: 'firstName',  label: 'First name' },
  ln:           { bucket: 'lastName',   label: 'Last name' },
  ct:           { bucket: 'city',       label: 'City' },
  st:           { bucket: 'region',     label: 'State' },
  zp:           { bucket: 'postal',     label: 'Zip' },
  country:      { bucket: 'country',    label: 'Country' },
  ge:           { bucket: 'gender',     label: 'Gender' },
  db:           { bucket: 'dob',        label: 'Date of birth' },
  external_id:  { bucket: 'externalId', label: 'External ID' },
  hashed_maids: { bucket: 'maid',       label: 'Mobile ad ID' },
};

function looksHashed(v) {
  // Pinterest accepts SHA-256 (64), SHA-1 (40) or MD5 (32) hex.
  if (typeof v !== 'string') return false;
  const s = v.trim();
  return [32, 40, 64].includes(s.length) && /^[0-9a-f]+$/i.test(s);
}

// Returns { <fieldKey>: { bucket, label, hashed } } or null.
export function extractPinterestUserData(pd) {
  if (!pd || typeof pd !== 'object' || Array.isArray(pd)) return null;
  const fields = {};
  for (const [k, v] of Object.entries(pd)) {
    const def = PD_FIELD[k];
    if (!def) continue;
    if (v == null || v === '') continue;
    const val = Array.isArray(v) ? v[0] : v;            // some fields can be arrays
    fields[k] = { bucket: def.bucket, label: def.label, hashed: looksHashed(val) };
  }
  return Object.keys(fields).length ? fields : null;
}

// Compact summary { email, phone, name, address } — same shape as the other
// providers. external_id / maid are excluded (surfaced separately).
export function summarizePinterestIdentifiers(userData) {
  const b = { email: 0, phone: 0, firstName: 0, lastName: 0, city: 0, region: 0, postal: 0, country: 0 };
  for (const f of Object.values(userData || {})) {
    if (f.bucket && f.bucket in b) b[f.bucket] += 1;
  }
  return {
    email: b.email,
    phone: b.phone,
    name: Math.max(b.firstName, b.lastName),
    address: Math.max(b.city, b.region, b.postal, b.country),
  };
}

// ---------------------------------------------------------------------------
// Event data (ed) — e-commerce + custom
// ---------------------------------------------------------------------------

// Recognised ed keys; everything else is treated as custom data.
const ED_KNOWN = new Set([
  'value', 'currency', 'order_id', 'order_quantity', 'product_id', 'line_items',
  'promo_code', 'search_query', 'video_title', 'lead_type', 'event_id',
  'content_ids', 'content_id', 'np', 'gtm_version',
]);

// Returns { value, currency, orderId, orderQuantity, lineItems:[…], … } or null.
export function extractPinterestEcommerce(ed) {
  if (!ed || typeof ed !== 'object' || Array.isArray(ed)) return null;
  const out = {};
  if (ed.value != null && ed.value !== '')           out.value = String(ed.value);
  if (ed.currency)                                   out.currency = String(ed.currency);
  if (ed.order_id != null && ed.order_id !== '')     out.orderId = String(ed.order_id);
  if (ed.order_quantity != null && ed.order_quantity !== '') out.orderQuantity = String(ed.order_quantity);
  if (ed.promo_code)                                 out.promoCode = String(ed.promo_code);
  if (ed.search_query)                               out.searchQuery = String(ed.search_query);

  if (Array.isArray(ed.line_items) && ed.line_items.length) {
    out.lineItems = ed.line_items.map((it) => ({
      id:       it.product_id != null ? String(it.product_id) : null,
      name:     it.product_name != null ? String(it.product_name) : null,
      price:    it.product_price != null ? String(it.product_price) : null,
      category: it.product_category != null ? String(it.product_category) : null,
      variant:  it.product_variant != null ? String(it.product_variant) : null,
      quantity: it.product_quantity != null ? String(it.product_quantity) : null,
      brand:    it.product_brand != null ? String(it.product_brand) : null,
    }));
  } else if (ed.content_ids != null) {
    out.contentIds = Array.isArray(ed.content_ids) ? ed.content_ids.map(String) : [String(ed.content_ids)];
  } else if (ed.product_id != null) {
    out.contentIds = [String(ed.product_id)];
  }

  return Object.keys(out).length ? out : null;
}

// ed fields that are neither e-commerce nor Pinterest plumbing → custom data.
export function extractPinterestCustomData(ed) {
  if (!ed || typeof ed !== 'object' || Array.isArray(ed)) return {};
  const out = {};
  for (const [k, v] of Object.entries(ed)) {
    if (ED_KNOWN.has(k)) continue;
    out[k] = (v !== null && typeof v === 'object') ? JSON.stringify(v) : String(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSON-in-query helpers
// ---------------------------------------------------------------------------

function parseJsonParam(v) {
  if (v == null || v === '') return null;
  try { const o = JSON.parse(v); return (o && typeof o === 'object') ? o : null; }
  catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// Full parse
// ---------------------------------------------------------------------------

// Returns a normalized record or null for non-Pinterest requests.
export function parsePinterestRequest(url, postData) {
  let host = '', pathname = '';
  try { const u = new URL(url); host = u.host; pathname = u.pathname; }
  catch (e) { return null; }

  if (!isPinterestHost(host)) return null;
  if (!isV3Path(pathname)) return null;

  const { queryParams, bodyParams } = extractParams(url, postData);
  const get = (k) => queryParams[k] ?? (bodyParams && bodyParams[k]) ?? null;

  const tid = get('tid');
  if (!tid) return null;                                // a tag hit always carries its tag id

  const ed = parseJsonParam(get('ed'));
  const pd = parseJsonParam(get('pd'));
  const ad = parseJsonParam(get('ad'));

  const eventRaw = get('event');
  const event = canonicalEvent(eventRaw);
  const standardEvent = STANDARD_EVENTS.has(event);

  const userData = extractPinterestUserData(pd);
  const identifiers = summarizePinterestIdentifiers(userData);
  const ecommerce = extractPinterestEcommerce(ed);
  const customData = extractPinterestCustomData(ed);
  const eventId = ed && ed.event_id != null && ed.event_id !== '' ? String(ed.event_id) : null;

  const revenue = (ecommerce && ecommerce.value != null)
    ? { value: ecommerce.value, currency: ecommerce.currency || null }
    : null;

  const flags = {
    standardEvent,
    dedup: !!eventId,                                   // ed.event_id → CAPI deduplication id
    ecommerce: ECOMMERCE_EVENTS.has(event) || !!(ecommerce && ecommerce.lineItems),
    advancedMatching: !!userData,
    cdCount: Object.keys(customData).length,
    isEu: !!(ad && ad.is_eu),                           // EU region flag (privacy context)
  };

  return {
    provider: 'pinterest',
    transport: 'standard',
    host,
    pathname,
    effectiveUrl: url,
    effectivePath: pathname,
    method: postData ? 'POST' : 'GET',
    event,
    eventRaw: eventRaw || null,
    tid: String(tid),
    eventId,
    pageUrl: ad && ad.loc != null ? String(ad.loc) : null,
    referrer: ad && ad.ref != null ? String(ad.ref) : null,
    standardEvent,
    revenue,
    flags,
    userData,
    identifiers,
    ecommerce,
    customData,
    pinUnauth: pd && pd.pin_unauth != null ? String(pd.pin_unauth) : null,
    aemEligible: pd && Array.isArray(pd.aem_eligible_list) ? pd.aem_eligible_list.slice() : null,
    consent: null,                                      // Pinterest's ppce is a response header — not in the request
    queryParams,
    bodyParams,
  };
}
