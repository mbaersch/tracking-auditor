// GA4 request detection & parsing — pure functions, no DOM / chrome APIs, so it
// runs both in the panel and under `node --test`. Detection logic (incl. the
// custom-loader decode) is ported from the EC-Validator.

import { extractParams } from './params.js';
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

// Full parse of a request. Returns null for non-GA4 requests.
// transport: 'standard' | 'first-party' | 'stape-b64' | 'custom-path'
export function parseGa4Request(url, postData) {
  let host = '', pathname = '';
  try { const u = new URL(url); host = u.host; pathname = u.pathname; }
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
      // First-party sGTM / Google Tag Gateway on a standard collect path.
      const u = new URL(url);
      const v = u.searchParams.get('v');
      const tid = u.searchParams.get('tid');
      if (v === '2' && tid && /^G-[A-Z0-9]+$/i.test(tid)) transport = 'first-party';
    }
  }
  if (!transport) return null;

  const { queryParams, bodyParams, bodyJson } = extractParams(effectiveUrl, postData);
  const get = (k) => queryParams[k] ?? (bodyParams && bodyParams[k]) ?? null;

  // Event characteristics readable straight from the request.
  const epKeys = new Set();
  for (const k of Object.keys(queryParams)) if (k.startsWith('ep.') || k.startsWith('epn.')) epKeys.add(k);
  if (bodyParams) for (const k of Object.keys(bodyParams)) if (k.startsWith('ep.') || k.startsWith('epn.')) epKeys.add(k);
  const flags = {
    sessionStart:  get('_ss') === '1',  // GA4: session start
    firstVisit:    get('_fv') === '1',  // GA4: first visit
    conversion:    get('_c')  === '1',  // GA4: event flagged as conversion / key event
    externalEvent: get('_ee') === '1',  // GA4: external event (created via GA4 configuration)
    epCount:       epKeys.size,         // custom event params ep.* / epn.*
  };

  const userData = extractUserData(queryParams, bodyParams, bodyJson);
  const em = get('em');
  const identifiers = summarizeIdentifiers(userData, em);
  const consent = parseConsent(queryParams, bodyParams);

  return {
    provider: 'ga4',
    transport,
    host,
    pathname,
    effectiveUrl,
    effectivePath,
    method: postData ? 'POST' : 'GET',
    en: get('en'),
    tid: get('tid'),
    em,
    flags,
    queryParams,
    bodyParams,
    userData,
    identifiers,
    consent,
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
