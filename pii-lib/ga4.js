// GA4 request detection & parsing — pure functions, no DOM / chrome APIs, so it
// runs both in the panel and under `node --test`. Detection logic (incl. the
// custom-loader decode) is ported from the EC-Validator.

import { extractParams, BUCKET_LABEL, piiField } from './params.js';
import { isSameSiteUrl } from './domain.js';   // eTLD+1 same-site test for the first-party call
// Re-exported so existing importers (panel, tests) keep getting it from here.
export { extractParams };

// ---------------------------------------------------------------------------
// Custom-loader decode (Stape base64 + plaintext custom path)
// ---------------------------------------------------------------------------

// UTF-8-safe base64 decode. atob() yields a Latin-1 binary string; the bytes
// must go through TextDecoder for correct non-ASCII characters.
export function decodeBase64Utf8(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

function looksLikeGa4Path(s) {
  return s.startsWith('/g/collect') || s.startsWith('/collect') || s.startsWith('/gtag/js');
}

// { kind: 'stape-b64', url } | { kind: 'custom-path', url } | { kind: 'skip' } | null
export function tryDecodeCustomLoader(url) {
  let u;
  try { u = new URL(url); } catch (e) { return null; }

  // Fall A: Stape base64 transport — der GA4-Pfad steckt base64-codiert in einem
  // Query-Parameter der getarnten Loader-URL.
  for (const [, value] of u.searchParams) {
    if (!value || value.length < 10) continue;
    let decoded;
    try { decoded = decodeBase64Utf8(decodeURIComponent(value)); } catch (e) { continue; }
    if (looksLikeGa4Path(decoded)) {
      if (decoded.startsWith('/gtag/js')) return { kind: 'skip' };
      return { kind: 'stape-b64', url: 'https://' + u.host + decoded };
    }
  }

  // Fall B: Klartext-Custom-Pfad (Tag Gateway / sGTM mit kryptischem Pfad). Streng,
  // um Fehlalarme zu vermeiden: v=2 + gueltige G-Mess-ID + Eventname.
  const path = u.pathname || '';
  if (!path.includes('/collect')) {
    const v   = u.searchParams.get('v');
    const tid = u.searchParams.get('tid');
    const en  = u.searchParams.get('en');
    if (v === '2' && tid && /^G-[A-Z0-9]+$/i.test(tid) && en) {
      return { kind: 'custom-path', url };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// GA4 detection
// ---------------------------------------------------------------------------

export function isGoogleHost(host) {
  const h = (host || '').toLowerCase();
  return h.endsWith('google-analytics.com') || h.endsWith('analytics.google.com');
}

// A GA4 POST can carry MORE THAN ONE event: the body is newline-delimited, one
// urlencoded parameter set per event, while the query string holds only what all
// of them share. Parsing such a body as a single form data set glues the next
// line onto the previous value ("dl=…/result\nen=check_finished") and lets the
// first event swallow the others' parameters. Returns the lines of a batch, or
// null for a single-event (or JSON) body.
export function splitGa4BodyLines(postData) {
  const text = typeof postData === 'string' ? postData : (postData && postData.text) || '';
  if (!text || text.trimStart().startsWith('{')) return null;   // JSON payload is never batched
  const lines = text.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim() !== '');
  return lines.length > 1 ? lines : null;
}

// Full parse of a request. Returns null for non-GA4 requests, one record for a
// single event, and an ARRAY of records for a batched POST (one per body line).
// `pageUrl` is the inspected page's real URL (from the panel) — the only trusted
// source for the first-party call; absent under `node --test` unless a test
// supplies it.
// transport: 'standard' | 'first-party' | 'unknown' | 'stape-b64' | 'custom-path'
export function parseGa4Request(url, postData, pageUrl) {
  let host = '', pathname = '', parsedUrl = null;
  try { parsedUrl = new URL(url); host = parsedUrl.host; pathname = parsedUrl.pathname; }
  catch (e) { return null; }

  let transport = null;
  let effectiveUrl = url;
  let effectivePath = pathname;

  if (isGoogleHost(host) && pathname.includes('/g/collect')) {
    transport = 'standard';
  } else {
    const decoded = tryDecodeCustomLoader(url);
    if (decoded && decoded.kind === 'skip') return null; // gtag/js loader, no event
    if (decoded && decoded.kind === 'stape-b64') {
      transport = 'stape-b64'; effectiveUrl = decoded.url; effectivePath = '/g/collect';
    } else if (decoded && decoded.kind === 'custom-path') {
      transport = 'custom-path'; effectivePath = '/g/collect';
    } else if (pathname.includes('/g/collect') || pathname.includes('/collect')) {
      // GA4 on a standard collect path but not a Google host: either a genuine
      // first-party endpoint (sGTM / Tag Gateway on the site's OWN registrable
      // domain) or a server proxy on a foreign domain (e.g. a shared sGTM vendor
      // host). Only claim first-party when the endpoint is same-site as the
      // inspected page; without that evidence it stays 'unknown', not first-party.
      const v = parsedUrl.searchParams.get('v');
      const tid = parsedUrl.searchParams.get('tid');
      if (v === '2' && tid && /^G-[A-Z0-9]+$/i.test(tid)) {
        transport = isSameSiteUrl(host, pageUrl) ? 'first-party' : 'unknown';
      }
    }
  }
  if (!transport) return null;

  const shared = { transport, host, pathname, effectiveUrl, effectivePath };
  const lines = splitGa4BodyLines(postData);
  if (lines) {
    return lines.map((line, i) =>
      buildGa4Record(line, shared, { index: i + 1, total: lines.length }));
  }
  return buildGa4Record(postData, shared, null);
}

// Build one record from one event payload. `postData` is that event's body (a
// single batch line, the whole body, or null for a GET); the query params of the
// request are shared by every event of a batch.
function buildGa4Record(postData, shared, batch) {
  const { transport, host, pathname, effectiveUrl, effectivePath } = shared;
  const { queryParams, bodyParams, bodyJson } = extractParams(effectiveUrl, postData);
  // Body before query: the body carries this event's own payload, so a virtual
  // pageview's dl (or any per-event override) must win over the shared query
  // value. An empty body value is treated as absent, not as an override.
  const get = (k) => {
    const b = bodyParams ? bodyParams[k] : undefined;
    return (b !== undefined && b !== '') ? b : (queryParams[k] ?? null);
  };

  // Event characteristics readable straight from the request.
  const epKeys = new Set();
  for (const k of Object.keys(queryParams)) if (k.startsWith('ep.') || k.startsWith('epn.')) epKeys.add(k);
  if (bodyParams) for (const k of Object.keys(bodyParams)) if (k.startsWith('ep.') || k.startsWith('epn.')) epKeys.add(k);
  const upKeys = new Set();
  for (const k of Object.keys(queryParams)) if (k.startsWith('up.') || k.startsWith('upn.')) upKeys.add(k);
  if (bodyParams) for (const k of Object.keys(bodyParams)) if (k.startsWith('up.') || k.startsWith('upn.')) upKeys.add(k);
  const flags = {
    sessionStart:  get('_ss') === '1',  // GA4: session start
    firstVisit:    get('_fv') === '1',  // GA4: first visit
    conversion:    get('_c')  === '1',  // GA4: event flagged as conversion / key event
    externalEvent: get('_ee') === '1',  // GA4: external event (created via GA4 configuration)
    epCount:       epKeys.size,         // custom event params ep.* / epn.*
    upCount:       upKeys.size,         // user properties up.* / upn.*
  };

  const userData = extractUserData(queryParams, bodyParams, bodyJson);
  const em = get('em');
  const identifiers = summarizeIdentifiers(userData, em);
  const consent = parseConsent(queryParams, bodyParams);
  const items = parseGa4Products(queryParams, bodyParams);
  if (items) flags.itemCount = items.length;

  return {
    provider: 'ga4',
    transport,
    host,
    pathname,
    effectiveUrl,
    effectivePath,
    method: postData ? 'POST' : 'GET',
    _batch: batch,
    en: get('en'),
    tid: get('tid'),
    em,
    flags,
    queryParams,
    bodyParams,
    userData,
    piiFields: ga4PiiFields(userData, em),
    identifiers,
    consent,
    items,
    currency: get('cu'),
  };
}

// ---------------------------------------------------------------------------
// user_data extraction & identifier summary
// ---------------------------------------------------------------------------

function userDataPath(key) {
  if (typeof key !== 'string') return null;
  if (key.startsWith('ep.user_data.')) return key.substring('ep.user_data.'.length).split('.');
  if (key.startsWith('user_data.'))    return key.substring('user_data.'.length).split('.');
  return null;
}

function setNested(target, path, value) {
  if (!path.length) return;
  let cur = target;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    if (!cur[seg] || typeof cur[seg] !== 'object') cur[seg] = {};
    cur = cur[seg];
  }
  cur[path[path.length - 1]] = value;
}

function mergeUserDataObject(target, src) {
  if (!src || typeof src !== 'object' || Array.isArray(src)) return;
  for (const [k, v] of Object.entries(src)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      mergeUserDataObject(target[k], v);
    } else {
      target[k] = v;
    }
  }
}

const KNOWN_USERDATA_KEYS = new Set([
  'email', 'email_address', 'sha256_email_address',
  'phone_number', 'sha256_phone_number',
  'first_name', 'sha256_first_name',
  'last_name', 'sha256_last_name',
  'street', 'sha256_street',
  'city', 'region', 'postal_code', 'country'
]);

function hasKnownIdentifier(node) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node)) return node.some(hasKnownIdentifier);
  for (const k of Object.keys(node)) {
    if (KNOWN_USERDATA_KEYS.has(k)) return true;
    if (node[k] && typeof node[k] === 'object' && hasKnownIdentifier(node[k])) return true;
  }
  return false;
}

// Returns the structured user_data object, or null if none with a known
// identifier is present.
export function extractUserData(queryParams, bodyParams, bodyJson) {
  const out = {};
  let found = false;

  for (const [k, v] of Object.entries(queryParams || {})) {
    const path = userDataPath(k);
    if (path) { setNested(out, path, v); found = true; }
  }
  if (bodyJson && bodyJson.user_data && typeof bodyJson.user_data === 'object' && !Array.isArray(bodyJson.user_data)) {
    mergeUserDataObject(out, bodyJson.user_data); found = true;
  }
  for (const [k, v] of Object.entries(bodyParams || {})) {
    const path = userDataPath(k);
    if (path) { setNested(out, path, v); found = true; }
  }

  if (!found) return null;
  if (!hasKnownIdentifier(out)) return null;
  return out;
}

// Maps a user_data field name to an identifier bucket.
function udKeyToBucket(k) {
  if (k === 'email' || k === 'email_address' || k === 'sha256_email_address') return 'email';
  if (k === 'phone_number' || k === 'sha256_phone_number') return 'phone';
  if (k === 'first_name' || k === 'sha256_first_name') return 'firstName';
  if (k === 'last_name' || k === 'sha256_last_name') return 'lastName';
  if (k === 'street' || k === 'sha256_street') return 'street';
  if (k === 'city') return 'city';
  if (k === 'region') return 'region';
  if (k === 'postal_code') return 'postal';
  if (k === 'country') return 'country';
  return null;
}

// Maps an `em` token key (em, pn, fn0, ln0, sa0, ct0, rg0, pc0, co0) to a bucket.
function emKeyToBucket(k) {
  const base = k.replace(/\d+$/, '');
  switch (base) {
    case 'em': return 'email';
    case 'pn': return 'phone';
    case 'fn': return 'firstName';
    case 'ln': return 'lastName';
    case 'sa': return 'street';
    case 'ct': return 'city';
    case 'rg': return 'region';
    case 'pc': return 'postal';
    case 'co': return 'country';
    default: return null;
  }
}

// Counts identifiers across structured user_data AND `em` tokens, returning a
// compact summary { email, phone, name, address } where name = max(firstName,
// lastName) values (≈ persons) and address = max over address-field counts
// (≈ addresses). Email/phone are counted per value.
export function summarizeIdentifiers(userData, em) {
  const b = { email: 0, phone: 0, firstName: 0, lastName: 0, street: 0, city: 0, region: 0, postal: 0, country: 0 };

  (function walk(node) {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      const bucket = udKeyToBucket(k);
      if (bucket) {
        if (Array.isArray(v)) b[bucket] += v.length;
        else if (v && typeof v === 'object') walk(v);
        else b[bucket] += 1;
      } else if (v && typeof v === 'object') {
        walk(v);
      }
    }
  })(userData);

  if (em) {
    let s = String(em).trim();
    try { s = decodeURIComponent(s); } catch (e) { /* keep raw */ }
    for (const tok of s.split('~')) {
      const i = tok.indexOf('.');
      if (i === -1) continue;
      const bucket = emKeyToBucket(tok.substring(0, i));
      if (bucket) b[bucket] += 1;
    }
  }

  return {
    email: b.email,
    phone: b.phone,
    name: Math.max(b.firstName, b.lastName),
    address: Math.max(b.street, b.city, b.region, b.postal, b.country),
  };
}

// Flatten the identifier surface (structured user_data + the em token) into the
// same { rawKey: { bucket, label, hashed, algo } } field-map every other
// provider produces, so the panel renders one uniform PII block. Reads only —
// a cleartext value simply reports algo null ("not hashed").
export function ga4PiiFields(userData, em) {
  const out = {};
  (function walk(node) {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (v && typeof v === 'object') { walk(v); continue; }
      const bucket = udKeyToBucket(k);
      if (!bucket) continue;
      out[k] = piiField(bucket, BUCKET_LABEL[bucket] || k, String(v));
    }
  })(userData);

  if (em) {
    let s = String(em).trim();
    try { s = decodeURIComponent(s); } catch (e) { /* keep raw */ }
    for (const tok of s.split('~')) {
      const i = tok.indexOf('.');
      if (i === -1) continue;
      const key = tok.substring(0, i);
      const val = tok.substring(i + 1);
      const bucket = emKeyToBucket(key);
      if (!bucket || val === '') continue;
      out[key] = piiField(bucket, BUCKET_LABEL[bucket] || key, val);
    }
  }
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------------------
// Consent (gcs / gcd) — ported from the EC-Validator
// ---------------------------------------------------------------------------

export function parseGcs(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!/^G1[01-][01-]/.test(s)) return null;
  const map = { '0': 'denied', '1': 'granted', '-': 'unset' };
  return { adStorage: map[s[2]] || null, analyticsStorage: map[s[3]] || null, raw: s };
}

const GCD_PURPOSES = ['ad_storage', 'analytics_storage', 'ad_user_data', 'ad_personalization'];
const GCD_LETTER_MAP = {
  l: { text: 'not set',                    state: 'unset',   updated: false, manual: false },
  p: { text: 'denied (default)',           state: 'denied',  updated: false, manual: false },
  q: { text: 'denied (default + update)',  state: 'denied',  updated: true,  manual: false },
  t: { text: 'granted (default)',          state: 'granted', updated: false, manual: false },
  r: { text: 'denied → granted',           state: 'granted', updated: true,  manual: false },
  m: { text: 'denied (update)',            state: 'denied',  updated: true,  manual: false },
  n: { text: 'granted (update)',           state: 'granted', updated: true,  manual: false },
  u: { text: 'granted → denied',           state: 'denied',  updated: true,  manual: false },
  v: { text: 'granted (default + update)', state: 'granted', updated: true,  manual: false },
  L: { text: 'not set',                    state: 'unset',   updated: false, manual: true  },
  P: { text: 'granted (default + update)', state: 'granted', updated: true,  manual: true  },
  Q: { text: 'denied + update',            state: 'denied',  updated: true,  manual: true  },
  T: { text: 'granted',                    state: 'granted', updated: false, manual: true  },
  R: { text: 'denied → granted',           state: 'granted', updated: true,  manual: true  },
  M: { text: 'denied (update)',            state: 'denied',  updated: true,  manual: true  },
  N: { text: 'granted (update)',           state: 'granted', updated: true,  manual: true  },
  U: { text: 'granted → denied',           state: 'denied',  updated: true,  manual: true  },
};

export function parseGcd(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!/^1[13]/.test(s)) return null;
  const letters = [];
  const re = /[a-zA-Z]/g;
  let m;
  while ((m = re.exec(s)) !== null) letters.push(m[0]);
  if (letters.length === 0) return null;
  return GCD_PURPOSES.map((purpose, i) => {
    const letter = letters[i] || null;
    const info = letter ? GCD_LETTER_MAP[letter] : null;
    return {
      purpose,
      letter,
      text:    info ? info.text    : (letter ? 'unknown' : 'absent'),
      state:   info ? info.state   : null,
      updated: info ? info.updated : false,
      manual:  info ? info.manual  : false,
    };
  });
}

export function parseConsent(queryParams, bodyParams) {
  const gcsRaw = (queryParams && queryParams.gcs) || (bodyParams && bodyParams.gcs) || null;
  const gcdRaw = (queryParams && queryParams.gcd) || (bodyParams && bodyParams.gcd) || null;
  const gcs = parseGcs(gcsRaw);
  const gcd = parseGcd(gcdRaw);
  if (!gcs && !gcd && !gcsRaw && !gcdRaw) return null;
  return {
    adStorage:        gcs ? gcs.adStorage : null,
    analyticsStorage: gcs ? gcs.analyticsStorage : null,
    gcs:              gcs ? gcs.raw : (gcsRaw || null),
    gcd:              gcdRaw,
    gcdDecoded:       gcd,
  };
}

// ---------------------------------------------------------------------------
// E-commerce items (pr1..prN)
// ---------------------------------------------------------------------------
//
// GA4 packs each item into a prN param: `~`-delimited tokens where every token
// is a 2-char field code immediately followed by its value (idca528821, pr76.9,
// qt1…). Item-scoped custom parameters ride as k<n>/v<n> pairs (k0 = the key
// name, v0 = its value), so k/v prefixes are the only variable-length codes.
// Codes derived empirically from a real view_item on atomkraftwerke24.de (see
// tests/ga4.test.js). A literal `~` in a value corrupts this encoding — a known
// GA4 limitation we mirror rather than try to repair.

const GA4_ITEM_CODES = {
  id: 'item_id',        nm: 'item_name',       br: 'item_brand',
  ca: 'item_category',  c2: 'item_category2',  c3: 'item_category3',
  c4: 'item_category4', c5: 'item_category5',  va: 'item_variant',
  pr: 'price',          qt: 'quantity',        cp: 'coupon',
  ds: 'discount',       af: 'affiliation',     lp: 'index',
  li: 'item_list_id',   ln: 'item_list_name',  lo: 'location_id',
  pi: 'promotion_id',   pn: 'promotion_name',  cn: 'creative_name',
  cs: 'creative_slot',
};

// Parse one prN string into { fields, custom, unknown } — all string values,
// insertion order matches the wire order. `unknown` holds any 2-char code not in
// the table so nothing is silently dropped.
export function parseGa4ProductItem(s) {
  const fields = {}, unknown = {};
  const customKeys = {}, customVals = {};
  for (const tok of String(s == null ? '' : s).split('~')) {
    if (!tok) continue;
    let m;
    if ((m = /^k(\d+)([\s\S]*)$/.exec(tok))) { customKeys[m[1]] = m[2]; continue; }
    if ((m = /^v(\d+)([\s\S]*)$/.exec(tok))) { customVals[m[1]] = m[2]; continue; }
    const code = tok.slice(0, 2), val = tok.slice(2);
    if (GA4_ITEM_CODES[code]) fields[GA4_ITEM_CODES[code]] = val;
    else unknown[code] = val;
  }
  const custom = {};
  for (const idx of Object.keys(customKeys)) custom[customKeys[idx]] = customVals[idx] ?? '';
  return { fields, custom, unknown };
}

// Collect and decode every pr1..prN in the request, in numeric order. Returns an
// array of parsed items, or null when the request carries no product data.
export function parseGa4Products(queryParams, bodyParams) {
  const found = [];
  const collect = (params) => {
    for (const k of Object.keys(params || {})) {
      const m = /^pr(\d+)$/.exec(k);
      if (m) found.push({ n: Number(m[1]), raw: params[k] });
    }
  };
  collect(queryParams);
  collect(bodyParams);
  if (!found.length) return null;
  found.sort((a, b) => a.n - b.n);
  return found.map((it) => ({ raw: it.raw, ...parseGa4ProductItem(it.raw) }));
}
