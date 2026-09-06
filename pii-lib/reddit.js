// Reddit Pixel request detection & parsing — pure functions, no DOM / chrome APIs,
// so they run both in the panel and under `node --test`. Mirrors lib/pinterest.js /
// lib/tiktok.js so the panel treats every provider uniformly.
//
// A Reddit Pixel hit goes to alb.reddit.com/rp.gif as a GET beacon (loader:
// redditstatic.com/ads/pixel.js). The payload rides in the query string:
//   id            pixel / account id (format a2_<...>)
//   event         PageVisit | ViewContent | Search | AddToCart | Purchase | Lead |
//                 SignUp | Custom (the custom name then sits in m.customEventName)
//   m.*           conversion / metadata: value, valueDecimal (comma-decimal!),
//                 currency, transactionId, conversionId, customEventName, products
//   em / pn       manually-set hashed email / phone (SHA-256)
//   auto_em       auto-collected hashed emails — a comma-separated list
//   auto_pn       auto-collected hashed phones — a pipe-separated <weight>~<hash> list
//   external_id   hashed external id
//   esurl         page url · uuid session id · v pixel instance (rdt_<...>)
// This is the ONLY place the Reddit Pixel sends user identifiers — the hashed email
// travels here, there is no separate advanced-matching beacon.

import { extractParams, hashAlgo, looksHashed, makeGetter, piiField } from './params.js';

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export function isRedditHost(host) {
  return (host || '').toLowerCase() === 'alb.reddit.com';
}

function isPixelPath(pathname) {
  return /^\/rp\.gif$/.test(pathname || '');
}

// Reddit's standard events (lowercased for comparison). 'custom' is itself a
// standard *type* — the real event name then rides in m.customEventName.
const STANDARD_EVENTS = new Set([
  'pagevisit', 'viewcontent', 'search', 'addtocart', 'addtowishlist',
  'purchase', 'lead', 'signup', 'custom',
]);

// ---------------------------------------------------------------------------
// Identifiers (em / pn / external_id + auto-collected auto_em / auto_pn)
// ---------------------------------------------------------------------------

function splitList(v, sep) {
  return (v == null ? '' : String(v)).split(sep).map((s) => s.trim()).filter(Boolean);
}

// Returns { <key>: { bucket, label, hashed, algo, [list] } } or null.
// f = { em, pn, external_id, auto_em, auto_pn }
export function extractRedditUserData(f) {
  const ud = {};
  if (f.em)          ud.em = piiField('email', 'Email', f.em);
  if (f.pn)          ud.pn = piiField('phone', 'Phone', f.pn);
  if (f.external_id) ud.external_id = piiField('externalId', 'External ID', f.external_id);

  const autoEm = splitList(f.auto_em, ',');
  if (autoEm.length) {
    ud.auto_em = { bucket: 'email', label: `Auto email ×${autoEm.length}`, hashed: autoEm.every(looksHashed), algo: hashAlgo(autoEm[0]), list: autoEm };
  }
  // auto_pn entries are "<weight>~<hash>"; keep both parts.
  const autoPn = splitList(f.auto_pn, '|').map((e) => {
    const i = e.indexOf('~');
    return i > 0 ? { weight: e.slice(0, i), hash: e.slice(i + 1) } : { weight: null, hash: e };
  });
  if (autoPn.length) {
    ud.auto_pn = { bucket: 'phone', label: `Auto phone ×${autoPn.length}`, hashed: autoPn.every((x) => looksHashed(x.hash)), algo: hashAlgo(autoPn[0].hash), list: autoPn };
  }

  return Object.keys(ud).length ? ud : null;
}

// Compact { email, phone, name, address } summary — same shape as the other
// providers. Presence-based (1 per bucket); external_id is surfaced separately.
export function summarizeRedditIdentifiers(userData) {
  const has = (bucket) => Object.values(userData || {}).some((f) => f.bucket === bucket);
  return {
    email: has('email') ? 1 : 0,
    phone: has('phone') ? 1 : 0,
    name: 0,
    address: 0,
  };
}

// ---------------------------------------------------------------------------
// Conversion / metadata (m.*)
// ---------------------------------------------------------------------------

// Returns { value, currency, transactionId, conversionId, customEventName, products } or null.
export function extractRedditConversion(m) {
  const out = {};
  const val = (m.valueDecimal != null && m.valueDecimal !== '')
    ? m.valueDecimal
    : ((m.value != null && m.value !== '') ? m.value : null);
  if (val != null)           out.value = String(val);                 // note: comma-decimal, e.g. "12,55"
  if (m.currency)            out.currency = String(m.currency);
  if (m.transactionId)       out.transactionId = String(m.transactionId);
  if (m.conversionId)        out.conversionId = String(m.conversionId);
  if (m.customEventName)     out.customEventName = String(m.customEventName);
  if (m.products)            out.products = String(m.products);
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------------------
// Full parse
// ---------------------------------------------------------------------------

// Returns a normalized record or null for non-Reddit requests.
export function parseRedditRequest(url, postData) {
  let host = '', pathname = '';
  try { const u = new URL(url); host = u.host; pathname = u.pathname; }
  catch (e) { return null; }

  if (!isRedditHost(host)) return null;
  if (!isPixelPath(pathname)) return null;

  const { queryParams, bodyParams } = extractParams(url, postData);
  const get = makeGetter(queryParams, bodyParams);

  const id = get('id');
  if (!id) return null;                                   // a pixel hit always carries its account id (a2_…)

  const eventRaw = get('event');
  const event = eventRaw ? String(eventRaw) : 'PageVisit';
  const standardEvent = STANDARD_EVENTS.has(event.toLowerCase());

  const conversion = extractRedditConversion({
    value: get('m.value'), valueDecimal: get('m.valueDecimal'), currency: get('m.currency'),
    transactionId: get('m.transactionId'), conversionId: get('m.conversionId'),
    customEventName: get('m.customEventName'), products: get('m.products'),
  });

  const externalIdRaw = get('external_id');
  const userData = extractRedditUserData({
    em: get('em'), pn: get('pn'), external_id: externalIdRaw,
    auto_em: get('auto_em'), auto_pn: get('auto_pn'),
  });
  const identifiers = summarizeRedditIdentifiers(userData);

  const revenue = (conversion && conversion.value != null)
    ? { value: conversion.value, currency: conversion.currency || null }
    : null;
  const dedupId = (conversion && (conversion.transactionId || conversion.conversionId)) || null;

  const flags = {
    standardEvent,
    custom: event.toLowerCase() === 'custom' || (!!eventRaw && !standardEvent),
    dedup: !!dedupId,                                     // m.transactionId / m.conversionId → CAPI dedup
    advancedMatching: !!(userData && (userData.em || userData.pn || userData.external_id)),
    autoMatching: !!(userData && (userData.auto_em || userData.auto_pn)),
    externalId: !!(userData && userData.external_id),
    optOut: get('opt_out') === '1',
  };

  return {
    provider: 'reddit',
    transport: 'standard',
    host,
    pathname,
    effectiveUrl: url,
    effectivePath: pathname,
    method: postData ? 'POST' : 'GET',
    event,
    eventRaw: eventRaw || null,
    pixelId: String(id),
    customEventName: (conversion && conversion.customEventName) || null,
    pageUrl: get('esurl') || null,
    uuid: get('uuid') || null,
    version: get('v') || null,
    integration: get('integration') || null,
    standardEvent,
    revenue,
    transactionId: (conversion && conversion.transactionId) || null,
    conversionId: (conversion && conversion.conversionId) || null,
    externalId: externalIdRaw || null,
    flags,
    userData,
    identifiers,
    conversion,
    consent: null,                                        // dpm/dpcc/dprc are data-processing flags, empty in practice
    queryParams,
    bodyParams,
  };
}
