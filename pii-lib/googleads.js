// Google Ads request detection & parsing — pure functions, no DOM / chrome APIs,
// so they run both in the panel and under `node --test`. Mirrors the shape of the
// other provider modules; the panel treats every provider uniformly.
//
// Google Ads is unusual: ONE user action fans out into a *bundle* of mirrored
// beacons across many endpoints. A single purchase conversion, captured live,
// produced five hits — client twins `pagead/conversion` + `ccm/conversion`, plus
// a server-side EC chain `viewthroughconversion` (302) → `1p-conversion` (.com +
// .de) — and the client twins carry a *different* `random` than the server chain.
// Remarketing fans out the same way: `viewthroughconversion` + `rmkt/collect` +
// `1p-user-list` (.com + .de), all sharing one `random`. So we classify each hit
// into one of four LOGICAL SIGNAL TYPES and let the panel collapse the whole
// transport bundle of one signal into a single card (see googleAdsCollapseKey).
//
//   conversion   pagead/conversion · ccm/conversion · 1p-conversion ·
//                viewthroughconversion(en=conversion)   → label, value, oid, EC em
//   remarketing  viewthroughconversion(en≠conversion) · rmkt/collect ·
//                1p-user-list                            → en, product `data`
//   measurement  ccm/collect (tid=AW-…)                 → en, ep/epn.value
//   upd          pagead/form-data · ccm/form-data        → hashed `em` user data
//
// Noise we drop: `ad.doubleclick.net/ccm/s/collect` (server beacon, no en/label),
// and anything without an Ads conversion-id signature (Privacy Sandbox / telemetry).
//
// Scope (per AGENTS.md): detect requests, read parameters. We surface the hashed
// `em`/`emd` enhanced-conversions tokens (reading, not validating) — no hash
// recomputation, no compliance verdicts.

import { extractParams } from './params.js';
import { parseGcs, parseGcd } from './ga4.js';   // consent decoders, ported once, reused here

// ---------------------------------------------------------------------------
// Host / path detection
// ---------------------------------------------------------------------------

// Google-owned hosts that carry Ads beacons. www.google.<tld> covers the EU TLD
// mirrors (google.de etc.) that the 1p-* endpoints duplicate to.
export function isGoogleAdsHost(host) {
  const h = (host || '').toLowerCase();
  return (
    h === 'googleads.g.doubleclick.net' ||
    h === 'www.googleadservices.com' || h === 'googleadservices.com' ||
    h === 'ad.doubleclick.net' ||
    /^(www\.)?google\.[a-z.]+$/.test(h)
  );
}

// Path → { family, signal }. `signal` is the logical bucket; `family` is the raw
// endpoint (used for the transport label + survivor ranking on collapse).
// `en` disambiguates viewthroughconversion (conversion vs remarketing audience).
function classifyPath(pathname, en) {
  const p = pathname || '';
  // Server-side ccm beacon: /ccm/s/collect — telemetry, no en/label. Drop it
  // BEFORE the generic /ccm/collect check below.
  if (/\/ccm\/s\/collect/.test(p)) return null;

  if (/\/pagead\/conversion\//.test(p))        return { family: 'pagead/conversion', signal: 'conversion' };
  if (/\/ccm\/conversion\//.test(p))           return { family: 'ccm/conversion', signal: 'conversion' };
  if (/\/pagead\/1p-conversion\//.test(p))     return { family: '1p-conversion', signal: 'conversion' };
  if (/\/pagead\/viewthroughconversion\//.test(p)) {
    return en === 'conversion'
      ? { family: 'viewthroughconversion', signal: 'conversion' }
      : { family: 'viewthroughconversion', signal: 'remarketing' };
  }
  if (/\/rmkt\/collect\//.test(p))             return { family: 'rmkt/collect', signal: 'remarketing' };
  if (/\/pagead\/1p-user-list\//.test(p))      return { family: '1p-user-list', signal: 'remarketing' };
  if (/\/pagead\/form-data(\/|\b)/.test(p))    return { family: 'pagead/form-data', signal: 'upd' };
  if (/\/ccm\/form-data(\/|\b)/.test(p))       return { family: 'ccm/form-data', signal: 'upd' };
  if (/\/ccm\/collect\b/.test(p))              return { family: 'ccm/collect', signal: 'measurement' };
  return null;
}

// Survivor ranking on collapse: when several mirrors share a collapse key, the
// richest endpoint's record is the one we display. Higher = preferred.
//  - conversion: client pagead/conversion carries item/em/category; server
//    1p-conversion mirrors carry redirect cruft → prefer the client tag.
//  - upd: ccm/form-data carries em + ecsid; pagead/form-data is often empty.
//  - remarketing: viewthrough/rmkt carry the product `data`; 1p-user-list mirrors it.
const FAMILY_RANK = {
  'pagead/conversion': 100, 'ccm/conversion': 90, '1p-conversion': 80, 'viewthroughconversion': 70,
  'rmkt/collect': 100, '1p-user-list': 80,
  'ccm/form-data': 100, 'pagead/form-data': 80,
  'ccm/collect': 100,
};

// ---------------------------------------------------------------------------
// Enhanced-conversions `em` token  (tv.1~em.<v>~pn.<v>~fn0.<v>~…)
// ---------------------------------------------------------------------------
//
// The `em` field is a tilde-joined token: a `tv.<n>` version marker followed by
// `<field><idx>.<value>` pairs. A bare `tv.1` is a stub (the hashed data rode in
// a separate form-data hit). Field prefixes map onto the usual buckets; some
// values are SHA-256 hex (hashed), others (postal/country) come through plain.

const EM_FIELD = {
  em: { bucket: 'email',     label: 'Email' },
  pn: { bucket: 'phone',     label: 'Phone' },
  fn: { bucket: 'firstName', label: 'First name' },
  ln: { bucket: 'lastName',  label: 'Last name' },
  sa: { bucket: 'street',    label: 'Street address' },
  ct: { bucket: 'city',      label: 'City' },
  pc: { bucket: 'postal',    label: 'Postal code' },
  rg: { bucket: 'region',    label: 'Region' },
  co: { bucket: 'country',   label: 'Country' },
};

function looksHashed(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  // Hex SHA-256/SHA-1/MD5 (conversion `em`) …
  if ([32, 40, 64].includes(s.length) && /^[0-9a-f]+$/i.test(s)) return true;
  // … or base64url SHA-256 (form-data `em` ships 32 bytes as 43 chars, no padding).
  if ((s.length === 43 || s.length === 44) && /^[A-Za-z0-9_-]+={0,2}$/.test(s)) return true;
  return false;
}

// Returns { <fieldKey>: { bucket, label, hashed } } or null. The version marker
// and a bare `tv.1` stub yield null.
export function parseEmToken(em) {
  if (!em || typeof em !== 'string') return null;
  const parts = em.split('~');
  const fields = {};
  for (const part of parts) {
    if (!part || /^tv\./.test(part)) continue;          // version marker
    const dot = part.indexOf('.');
    if (dot < 0) continue;
    const rawKey = part.slice(0, dot);
    const val = part.slice(dot + 1);
    const prefix = rawKey.replace(/\d+$/, '');           // fn0 → fn
    const def = EM_FIELD[prefix];
    if (!def || val === '') continue;
    fields[rawKey] = { bucket: def.bucket, label: def.label, hashed: looksHashed(val) };
  }
  return Object.keys(fields).length ? fields : null;
}

// Compact { email, phone, name, address } summary — same shape as other providers.
export function summarizeAdsIdentifiers(userData) {
  const b = { email: 0, phone: 0, firstName: 0, lastName: 0, street: 0, city: 0, postal: 0, region: 0, country: 0 };
  for (const f of Object.values(userData || {})) {
    if (f.bucket && f.bucket in b) b[f.bucket] += 1;
  }
  return {
    email: b.email,
    phone: b.phone,
    name: Math.max(b.firstName, b.lastName),
    address: Math.max(b.street, b.city, b.postal, b.region, b.country),
  };
}

// ---------------------------------------------------------------------------
// `data` param  (semicolon-delimited key=value)
// ---------------------------------------------------------------------------
//
// Interpreted PER BUCKET, so the same param name never lands in the wrong topf:
//  - remarketing: event;google_business_vertical;id (+value)  → dynamic product feed
//  - conversion : country;shipping;…                          → conversion context
export function parseDataParam(data) {
  if (!data || typeof data !== 'string') return null;
  const out = {};
  for (const pair of data.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    if (k) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

// Conversion line items: item=(price*qty*sku**)(price*qty*sku**)
export function parseAdsItems(item) {
  if (!item || typeof item !== 'string') return null;
  const items = [];
  for (const m of item.matchAll(/\(([^)]*)\)/g)) {
    const f = m[1].split('*');
    items.push({ price: f[0] || null, quantity: f[1] || null, sku: f[2] || null });
  }
  return items.length ? items : null;
}

// ---------------------------------------------------------------------------
// Collapse key — the heart of the de-fan-out
// ---------------------------------------------------------------------------
//
// Records sharing a key WITHIN A BLOCK collapse to one card. Keys are pinned
// against the real atomkraftwerke24.de capture:
//  - conversion : random-independent (label+value) so the client twins AND the
//    server 302 chain (which use different `random`s) merge. oid is intentionally
//    omitted — the server mirrors drop it.
//  - remarketing: shares one `random` across viewthrough/rmkt/1p-user-list/.de;
//    gtag.config init is aggregated per page (drop random) per the agreed scope.
//  - measurement: one ccm/collect per event; `en` separates page_view vs add_to_cart.
//  - upd       : pairs pagead+ccm form-data of one burst via gtm+gap.fsrc; the
//    three temporal UPD episodes (auto fill / explicit / post-submit) stay distinct.
export function googleAdsCollapseKey(r) {
  const id = r.convId || '';
  const q = r.queryParams || {};
  if (r.signalType === 'conversion') {
    return `aw:${id}:conv:${r.label || ''}:${r.revenue ? r.revenue.value : ''}`;
  }
  if (r.signalType === 'remarketing') {
    if (r.event === 'gtag.config') return `aw:${id}:rmkt:config`;
    return `aw:${id}:rmkt:${r.event || ''}:${q.random || ''}`;
  }
  if (r.signalType === 'measurement') {
    return `aw:${id}:collect:${r.event || ''}`;
  }
  if (r.signalType === 'upd') {
    return `aw:${id}:upd:${q.gtm || ''}:${q['gap.fsrc'] || ''}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Full parse
// ---------------------------------------------------------------------------

function firstPathId(pathname) {
  const m = (pathname || '').match(/\/(\d{6,})(?:\/|$)/);
  return m ? m[1] : null;
}

// Returns a normalized record or null for non-Ads / noise requests.
export function parseGoogleAdsRequest(url, postData) {
  let host = '', pathname = '';
  try { const u = new URL(url); host = u.host; pathname = u.pathname; }
  catch (e) { return null; }

  const { queryParams, bodyParams } = extractParams(url, postData);
  const get = (k) => queryParams[k] ?? (bodyParams && bodyParams[k]) ?? null;

  const en = get('en');
  const cls = classifyPath(pathname, en);
  if (!cls) return null;

  const googleHost = isGoogleAdsHost(host);
  const onAdsPath = true;                                // classifyPath already vouched for it
  if (!googleHost && !onAdsPath) return null;
  const transport = googleHost ? 'google' : 'first-party';

  // Conversion id: from the path (…/<id>/) for most families, else from tid (AW-…)
  // for ccm/collect. Without one this isn't a real tag hit → drop as noise.
  const tid = get('tid') || get('tids');
  let convId = firstPathId(pathname);
  if (!convId && tid) { const m = String(tid).match(/(\d{6,})/); convId = m ? m[1] : null; }
  if (!convId) return null;
  if (cls.signal === 'measurement' && !(tid && /AW-/i.test(String(tid)))) return null; // GA4 ccm? require AW-

  const consent = (() => {
    const gcsRaw = get('gcs'), gcdRaw = get('gcd');
    const gcs = parseGcs(gcsRaw), gcd = parseGcd(gcdRaw);
    if (!gcs && !gcd && !gcsRaw && !gcdRaw) return null;
    return {
      adStorage: gcs ? gcs.adStorage : null,
      analyticsStorage: gcs ? gcs.analyticsStorage : null,
      gcs: gcs ? gcs.raw : (gcsRaw || null),
      gcd: gcdRaw || null,
      gcdDecoded: gcd,
      dma: get('dma'),
      npa: get('npa'),
    };
  })();

  const r = {
    provider: 'googleads',
    signalType: cls.signal,
    family: cls.family,
    transport,
    host,
    pathname,
    effectiveUrl: url,
    effectivePath: pathname,
    method: postData ? 'POST' : 'GET',
    event: en || null,
    convId,
    accountId: `AW-${convId}`,
    pageUrl: get('url') || get('dl') || null,
    title: get('tiba') || get('dt') || null,
    referrer: get('ref') || get('dr') || null,
    consent,
    queryParams,
    bodyParams,
    // transport bundling (consumed by the panel's generic collapse step)
    _transportLabel: cls.family,
    _transportRank: FAMILY_RANK[cls.family] || 0,
  };

  // --- per-signal payload -------------------------------------------------
  const emRaw = get('em');
  const userData = parseEmToken(emRaw);
  const identifiers = summarizeAdsIdentifiers(userData);
  const ecActive = !!(userData || get('capi') || get('ec_mode') || (emRaw && emRaw !== ''));

  if (cls.signal === 'conversion') {
    const value = get('value');
    const currency = get('currency_code');
    r.label = get('label') || null;
    r.bttype = get('bttype') || null;
    r.oid = get('oid') || null;
    r.category = get('category') || null;
    r.gclCtr = get('gcl_ctr') || null;
    r.ecsid = get('ecsid') || null;
    r.revenue = (value != null && value !== '') ? { value: String(value), currency: currency || null } : null;
    r.items = parseAdsItems(get('item'));
    r.contextData = parseDataParam(get('data'));        // country/shipping context
    r.userData = userData;
    r.identifiers = identifiers;
  } else if (cls.signal === 'remarketing') {
    r.productData = parseDataParam(get('data'));         // event;google_business_vertical;id
    const value = get('value');
    r.revenue = (value != null && value !== '') ? { value: String(value), currency: null } : null;
    r.userData = null;
    r.identifiers = summarizeAdsIdentifiers(null);
  } else if (cls.signal === 'measurement') {
    const value = get('epn.value') ?? get('ep.value');
    const currency = get('ep.currency') ?? get('epn.currency');
    r.revenue = (value != null && value !== '') ? { value: String(value), currency: currency || null } : null;
    r.userData = null;
    r.identifiers = summarizeAdsIdentifiers(null);
  } else { // upd
    r.userData = userData;
    r.identifiers = identifiers;
    r.emd = get('emd') || null;
    r.ecMode = get('ec_mode') || null;
    r.ecsid = get('ecsid') || null;
    r.revenue = null;
  }

  r.flags = {
    conversion: cls.signal === 'conversion',
    enhancedConversions: ecActive,
    advancedMatching: !!userData,
    hasLabel: !!r.label,
    isEu: get('dma') === '1',
  };

  r._collapseKey = googleAdsCollapseKey(r);
  return r;
}
