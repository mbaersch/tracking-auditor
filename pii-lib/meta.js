// Meta (Facebook) Pixel request detection & parsing — pure functions, no DOM /
// chrome APIs, so they run both in the panel and under `node --test`. Mirrors the
// shape of lib/ga4.js so the panel can treat both providers uniformly.
//
// A browser pixel hit goes to https://www.facebook.com/tr/ as a GET beacon or,
// for larger payloads, a form POST (rqm=formPOST) carrying the params in the body.
// The loader connect.facebook.net/.../fbevents.js is not an event and is ignored.

import { extractParams, hashAlgo, makeGetter } from './params.js';
import { isSameSiteUrl } from './domain.js';   // eTLD+1 same-site test for the first-party call

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export function isFacebookHost(host) {
  const h = (host || '').toLowerCase();
  return h === 'facebook.com' || h.endsWith('.facebook.com');
}

function isTrPath(pathname) {
  return /\/tr\/?$/.test(pathname || '');
}

// Standard Meta events. Anything else in `ev` is treated as a custom event.
const STANDARD_EVENTS = new Set([
  'PageView', 'ViewContent', 'Search', 'AddToCart', 'AddToWishlist',
  'InitiateCheckout', 'AddPaymentInfo', 'Purchase', 'Lead', 'CompleteRegistration',
  'Contact', 'CustomizeProduct', 'Donate', 'FindLocation', 'Schedule',
  'StartTrial', 'SubmitApplication', 'Subscribe', 'SubscribedButtonClick', 'Microdata',
]);

// ---------------------------------------------------------------------------
// user_data (advanced matching)
// ---------------------------------------------------------------------------
//
// A single field arrives in up to four parallel representations, e.g. for email:
//   ud[em]   = SHA-256 hash (the actual advanced-matching payload)
//   aud[em]  = SHA-256 hash (automatic / additional advanced matching)
//   cud[em]  = masked raw value, e.g. ****@****.**   (# = digit, * = letter)
//   ncud[em] = masked normalized value
// We key by the inner field so a field counts once regardless of representation,
// and keep the mask for an honest, PII-free detail view.

const META_FIELD = {
  em:          { bucket: 'email',      label: 'Email' },
  ph:          { bucket: 'phone',      label: 'Phone' },
  fn:          { bucket: 'firstName',  label: 'First name' },
  ln:          { bucket: 'lastName',   label: 'Last name' },
  ct:          { bucket: 'city',       label: 'City' },
  st:          { bucket: 'region',     label: 'State' },     // Meta st = state, not street
  zp:          { bucket: 'postal',     label: 'Zip' },
  country:     { bucket: 'country',    label: 'Country' },
  ge:          { bucket: 'gender',     label: 'Gender' },
  db:          { bucket: 'dob',        label: 'Date of birth' },
  external_id: { bucket: 'externalId', label: 'External ID' },
};

const UD_KEY_RE = /^(ud|udff|cud|ncud|aud)\[([\w]+)\]$/;

// Returns { <fieldKey>: { bucket, label, mask, normalizedMask, hashed, algo } } or null.
export function extractMetaUserData(queryParams, bodyParams) {
  const fields = {};
  const consider = (params) => {
    for (const [k, v] of Object.entries(params || {})) {
      const m = UD_KEY_RE.exec(k);
      if (!m) continue;
      const rep = m[1], key = m[2];
      const def = META_FIELD[key];
      if (!def) continue; // unknown advanced-matching subfield
      const f = fields[key] || (fields[key] = {
        bucket: def.bucket, label: def.label, mask: null, normalizedMask: null, hashed: false, algo: null,
      });
      if (rep === 'ud' || rep === 'udff' || rep === 'aud') { f.hashed = true; f.algo = hashAlgo(v); }
      else if (rep === 'cud') f.mask = v;
      else if (rep === 'ncud') f.normalizedMask = v;
    }
  };
  consider(queryParams);
  consider(bodyParams);
  return Object.keys(fields).length ? fields : null;
}

// Compact summary { email, phone, name, address } — same shape as GA4's, so the
// panel can render it with one function. Each field counts once (the four
// representations are merged in extractMetaUserData); name = persons, address =
// presence of any address component.
export function summarizeMetaIdentifiers(userData) {
  const b = { email: 0, phone: 0, firstName: 0, lastName: 0, city: 0, region: 0, postal: 0, country: 0 };
  for (const key of Object.keys(userData || {})) {
    const bucket = (META_FIELD[key] || {}).bucket;
    if (bucket && bucket in b) b[bucket] += 1;
  }
  return {
    email: b.email,
    phone: b.phone,
    name: Math.max(b.firstName, b.lastName),
    address: Math.max(b.city, b.region, b.postal, b.country),
  };
}

// ---------------------------------------------------------------------------
// Custom data & consent
// ---------------------------------------------------------------------------

const CD_KEY_RE = /^cd\[([\w.]+)\]$/;

export function extractMetaCustomData(queryParams, bodyParams) {
  const out = {};
  const consider = (params) => {
    for (const [k, v] of Object.entries(params || {})) {
      const m = CD_KEY_RE.exec(k);
      if (m && !(m[1] in out)) out[m[1]] = v;
    }
  };
  consider(queryParams);
  consider(bodyParams);
  return out;
}

// Meta has no Google-style gcs/gcd. Its consent signal is Limited Data Use:
// dpo (data_processing_options), dpoco (country), dpost (state).
export function parseMetaConsent(get) {
  const dpo = get('dpo');
  const country = get('dpoco');
  const stateCode = get('dpost');
  if (dpo == null && country == null && stateCode == null) return null;
  const ldu = dpo != null && dpo !== '' && dpo !== '[]' && dpo !== '0';
  return { ldu, dpo, country, state: stateCode };
}

// ---------------------------------------------------------------------------
// Pixel-init signal (silent-pixel detection)
// ---------------------------------------------------------------------------
//
// Every pixel fetches its config on init:
//   connect.facebook.net/signals/config/<id>?v=…&domain=…&optin_meta_enabled_capi=…
// This request fires whether or not the pixel is allowed to send events, so it's
// a reliable "a pixel exists here" anchor. If we see the config but no /tr/ event
// with the same id, the pixel is very likely silently blocked (Meta "traffic
// permission" settings). The config itself is NOT a tracking event — it's only
// used to drive the absence diagnosis, never rendered on its own.

const SIGNAL_CONFIG_RE = /^\/signals\/config\/(\d+)\/?$/;

// Returns { id, domain, capiOptin, version } for a pixel-init config fetch, else null.
export function parseMetaSignal(url) {
  let host = '', pathname = '';
  try { const u = new URL(url); host = u.host.toLowerCase(); pathname = u.pathname; }
  catch (e) { return null; }
  if (host !== 'connect.facebook.net' && !host.endsWith('.connect.facebook.net')) return null;
  const m = SIGNAL_CONFIG_RE.exec(pathname);
  if (!m) return null;
  const { queryParams } = extractParams(url, null);
  return {
    id: m[1],
    domain: queryParams.domain || null,
    capiOptin: queryParams.optin_meta_enabled_capi === 'true',
    version: queryParams.v || null,
  };
}

// Given the pixel ids seen via config and the ids that actually fired a /tr/
// event, return the ids that initialised but stayed silent. Pure set difference.
export function metaUnfiredPixelIds(configIds, firedIds) {
  const fired = firedIds instanceof Set ? firedIds : new Set(firedIds || []);
  return Array.from(new Set(configIds || [])).filter((id) => !fired.has(id));
}

// ---------------------------------------------------------------------------
// Full parse
// ---------------------------------------------------------------------------

// Returns a normalized record or null for non-Meta requests. `pageUrl` is the
// inspected page's real URL (from the panel) — the only trusted source for the
// first-party call; absent under `node --test` unless a test supplies it.
// transport: 'standard' | 'first-party' | 'unknown'
export function parseMetaRequest(url, postData, pageUrl) {
  let host = '', pathname = '';
  try { const u = new URL(url); host = u.host; pathname = u.pathname; }
  catch (e) { return null; }

  if (!isTrPath(pathname)) return null;

  const { queryParams, bodyParams } = extractParams(url, postData);
  const get = makeGetter(queryParams, bodyParams);

  const id = get('id');
  const ev = get('ev');
  if (!id) return null; // a pixel event always carries its pixel id

  // A /tr hit on a non-Facebook host looks like a proxied pixel (numeric id + ev).
  // Only call it first-party when the host is same-site as the inspected page;
  // otherwise keep the hit visible but label it 'unknown' (no first-party claim).
  let transport = null;
  if (isFacebookHost(host)) transport = 'standard';
  else if (/^\d+$/.test(String(id)) && ev) transport = isSameSiteUrl(host, pageUrl) ? 'first-party' : 'unknown';
  if (!transport) return null;

  const userData = extractMetaUserData(queryParams, bodyParams);
  const customData = extractMetaCustomData(queryParams, bodyParams);
  const identifiers = summarizeMetaIdentifiers(userData);
  const eid = get('eid');
  const standardEvent = !!ev && STANDARD_EVENTS.has(ev);
  const consent = parseMetaConsent(get);

  const flags = {
    standardEvent,
    dedup: !!eid,                          // eid present → CAPI deduplication id
    cdCount: Object.keys(customData).length,
    ldu: !!(consent && consent.ldu),
    advancedMatching: !!userData,
  };

  return {
    provider: 'meta',
    transport,
    host,
    pathname,
    effectiveUrl: url,
    effectivePath: pathname,
    method: get('rqm') === 'formPOST' ? 'POST' : (postData ? 'POST' : 'GET'),
    ev,
    id,
    standardEvent,
    eid,
    flags,
    customData,
    userData,
    identifiers,
    consent,
    sourceLib: get('a') || null,           // e.g. "stape-gtm-1.2.0-pb"
    fbp: get('fbp'),
    queryParams,
    bodyParams,
  };
}
