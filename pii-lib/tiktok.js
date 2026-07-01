// TikTok Pixel request detection & parsing — pure functions, no DOM / chrome
// APIs, so they run both in the panel and under `node --test`. Mirrors the shape
// of lib/ga4.js / lib/meta.js so the panel can treat every provider uniformly.
//
// A browser pixel hit goes to analytics.tiktok.com/api/v2/pixel (and the /act
// batch / shopify_pixel variants) as a POST with a JSON body, OR as a GET with
// the same JSON base64-encoded in ?analytics_message= (decode → JSON, same as
// the Stape custom-loader trick for GA4). Telemetry sub-paths (/inter, /perf)
// and the pixel.js loader are not events and are ignored.
//
// Unlike Meta, the identifiers live in a nested JSON object (context.user), and
// TikTok ships its OWN data-quality verdict in the payload
// (signal_diagnostic_labels + _inspection.identity_params) — we surface that
// verbatim (reading parameters, not validating).

import { extractParams } from './params.js';
import { decodeBase64Utf8 } from './ga4.js';

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export function isTiktokHost(host) {
  const h = (host || '').toLowerCase();
  return h === 'analytics.tiktok.com' || h.endsWith('.analytics.tiktok.com');
}

// The event endpoints are /api/v2/pixel and /api/v2/pixel/act, plus the Shopify
// equivalents. Heartbeat/telemetry sub-paths (/inter, /perf, /monitor) carry no
// event and are filtered out.
function isPixelPath(pathname) {
  const p = pathname || '';
  if (!/\/api\/v2\/(shopify_)?pixel(\/|$)/.test(p)) return false;
  if (/\/(inter|perf|monitor|enrich_ipv6)(\/|$)/.test(p)) return false;
  return true;
}

// E-commerce events (helper-hardcoded — these trigger content/value/currency
// expectations). Kept separate from the wider standard-event list so we can flag
// "ecommerce" precisely.
const ECOMMERCE_EVENTS = new Set([
  'CompletePayment', 'InitiateCheckout', 'AddToCart', 'PlaceAnOrder',
  'ViewContent', 'AddToWishlist',
]);

// All recognised TikTok web standard events. Anything else is a custom event.
const STANDARD_EVENTS = new Set([
  ...ECOMMERCE_EVENTS,
  'Pageview', 'Search', 'Contact', 'Subscribe', 'SubmitForm',
  'AddPaymentInfo', 'CompleteRegistration', 'ClickButton', 'Download',
]);

// ---------------------------------------------------------------------------
// context.user (advanced matching)
// ---------------------------------------------------------------------------
//
// TikTok hashes identifiers client-side (SHA-256 hex), so context.user values
// are normally 64-char hex. We key by the field, note whether the value looks
// hashed, and keep external_id (which has no slot in the four-bucket summary)
// addressable on its own.

const TIKTOK_USER_FIELD = {
  email:        { bucket: 'email',      label: 'Email' },
  phone_number: { bucket: 'phone',      label: 'Phone' },
  external_id:  { bucket: 'externalId', label: 'External ID' },
  first_name:   { bucket: 'firstName',  label: 'First name' },
  last_name:    { bucket: 'lastName',   label: 'Last name' },
  zip_code:     { bucket: 'postal',     label: 'Zip' },
  city:         { bucket: 'city',       label: 'City' },
  state:        { bucket: 'region',     label: 'State' },
  country:      { bucket: 'country',    label: 'Country' },
};

function looksHashed(v) {
  return typeof v === 'string' && /^[0-9a-f]{64}$/i.test(v.trim());
}

// Returns { <fieldKey>: { bucket, label, hashed } } from a context.user object,
// or null when no recognised non-empty identifier is present.
export function extractTiktokUserData(user) {
  if (!user || typeof user !== 'object' || Array.isArray(user)) return null;
  const fields = {};
  for (const [k, v] of Object.entries(user)) {
    const def = TIKTOK_USER_FIELD[k];
    if (!def) continue;                                  // unknown / non-identifier
    if (v == null || v === '') continue;                 // present but empty
    fields[k] = { bucket: def.bucket, label: def.label, hashed: looksHashed(v) };
  }
  return Object.keys(fields).length ? fields : null;
}

// Compact summary { email, phone, name, address } — same shape as GA4/Meta so
// the panel renders it with one function. external_id is intentionally excluded
// (it is surfaced separately as its own pill).
export function summarizeTiktokIdentifiers(userData) {
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
// properties (e-commerce / custom data)
// ---------------------------------------------------------------------------

function toNumber(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

// Returns { value, currency, contents:[...], contentType, query, raw } or null.
export function extractTiktokEcommerce(properties) {
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return null;

  const out = {};
  if (properties.value != null && properties.value !== '') {
    out.value = String(properties.value);
    const n = toNumber(properties.value);
    if (n !== null) out.valueNum = n;
  }
  if (properties.currency) out.currency = String(properties.currency);
  if (properties.content_type) out.contentType = String(properties.content_type);
  if (properties.query) out.query = String(properties.query);

  // contents[] is the richest form; content_id / content_ids are the scalar
  // fallbacks (single id / list of ids).
  if (Array.isArray(properties.contents) && properties.contents.length) {
    out.contents = properties.contents.map((it) => ({
      id:       it.content_id != null ? String(it.content_id) : null,
      name:     it.content_name != null ? String(it.content_name) : null,
      brand:    it.brand != null ? String(it.brand) : null,
      category: it.content_category != null ? String(it.content_category) : null,
      price:    it.price != null ? String(it.price) : null,
      quantity: it.quantity != null ? String(it.quantity) : null,
    }));
  } else if (properties.content_ids != null) {
    out.contentIds = Array.isArray(properties.content_ids)
      ? properties.content_ids.map(String)
      : [String(properties.content_ids)];
  } else if (properties.content_id != null) {
    out.contentIds = [String(properties.content_id)];
  }

  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------------------
// Signal diagnostics (TikTok's own data-quality verdict)
// ---------------------------------------------------------------------------
//
// signal_diagnostic_labels: { <field>: { label, abnormal_types?, suggested_values? } }.
// Most fields are "missing" (not provided) — noise. We surface only fields with a
// non-missing verdict (a value was actually sent), since that is where TikTok is
// telling us something actionable ("valid" / "invalid" + why).
// _inspection.identity_params describes the hashing status of the input.

export function extractTiktokDiagnostics(payload) {
  const out = { signals: [], identityParams: null, hasInvalid: false };

  const labels = payload && payload.signal_diagnostic_labels;
  if (labels && typeof labels === 'object') {
    for (const [field, info] of Object.entries(labels)) {
      const label = info && info.label;
      if (!label || label === 'missing') continue;       // not provided → skip
      const sig = { field, label };
      if (Array.isArray(info.abnormal_types) && info.abnormal_types.length) {
        sig.abnormal = info.abnormal_types.slice();
      }
      if (Array.isArray(info.suggested_values) && info.suggested_values.length) {
        sig.suggested = true;
      }
      if (label === 'invalid') out.hasInvalid = true;
      out.signals.push(sig);
    }
  }

  const ip = payload && payload._inspection && payload._inspection.identity_params;
  if (ip && typeof ip === 'object') out.identityParams = ip;

  return (out.signals.length || out.identityParams) ? out : null;
}

// ---------------------------------------------------------------------------
// Full parse
// ---------------------------------------------------------------------------

// Returns a normalized record or null for non-TikTok requests.
// transport: 'standard' (POST JSON) | 'base64' (GET ?analytics_message=)
export function parseTiktokRequest(url, postData) {
  let host = '', pathname = '';
  try { const u = new URL(url); host = u.host; pathname = u.pathname; }
  catch (e) { return null; }

  if (!isTiktokHost(host)) return null;
  if (!isPixelPath(pathname)) return null;

  const { queryParams, bodyParams, bodyJson } = extractParams(url, postData);

  // Payload source: POST JSON body, or base64 JSON in the analytics_message query
  // param (GET transport). Same payload shape either way.
  let payload = bodyJson;
  let transport = 'standard';
  let method = postData ? 'POST' : 'GET';
  if (!payload && queryParams.analytics_message) {
    try {
      const decoded = decodeBase64Utf8(decodeURIComponent(queryParams.analytics_message));
      const obj = JSON.parse(decoded);
      if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
        payload = obj; transport = 'base64'; method = 'GET';
      }
    } catch (e) { /* not a decodable TikTok message */ }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;

  const event = payload.event;
  if (!event || typeof event !== 'string') return null;
  if (event === 'EnrichAM') return null;                 // internal advanced-matching probe

  const context = (payload.context && typeof payload.context === 'object') ? payload.context : {};
  const pixel = (context.pixel && typeof context.pixel === 'object') ? context.pixel : {};
  // A single hit carries pixel.code; an /act batch carries pipe-separated codes.
  const code = pixel.code != null ? String(pixel.code)
             : (pixel.codes != null ? String(pixel.codes).split('|')[0] : null);
  if (!code) return null;                                // a pixel event always has its id

  const page = (context.page && typeof context.page === 'object') ? context.page : {};
  const library = (context.library && typeof context.library === 'object') ? context.library : {};

  const userData = extractTiktokUserData(context.user);
  const identifiers = summarizeTiktokIdentifiers(userData);
  const ecommerce = extractTiktokEcommerce(payload.properties);
  const diagnostics = extractTiktokDiagnostics(payload);

  const eventId = payload.event_id != null && payload.event_id !== '' ? String(payload.event_id) : null;
  const messageId = payload.message_id != null && payload.message_id !== '' ? String(payload.message_id) : null;
  const standardEvent = STANDARD_EVENTS.has(event);

  const revenue = (ecommerce && ecommerce.value != null)
    ? { value: ecommerce.value, currency: ecommerce.currency || null }
    : null;

  const flags = {
    standardEvent,
    dedup: !!eventId,                                    // event_id → CAPI deduplication id
    ecommerce: ECOMMERCE_EVENTS.has(event) || !!(ecommerce && ecommerce.contents),
    advancedMatching: !!userData,
    externalId: !!(userData && userData.external_id),
    invalidSignal: !!(diagnostics && diagnostics.hasInvalid),
  };

  return {
    provider: 'tiktok',
    transport,
    host,
    pathname,
    effectiveUrl: url,
    effectivePath: pathname,
    method,
    event,
    code,
    eventId,
    messageId,
    pageUrl: page.url != null ? String(page.url) : null,
    referrer: page.referrer != null ? String(page.referrer) : null,
    library: library.name ? `${library.name}${library.version ? ' ' + library.version : ''}` : null,
    standardEvent,
    revenue,
    flags,
    userData,
    identifiers,
    ecommerce,
    diagnostics,
    consent: null,                                       // TikTok pixel surfaces no consent signal
    queryParams,
    bodyParams,
  };
}
