// OpenAI ads pixel (oaiq) detection & parsing — pure functions, no DOM / chrome
// APIs, so they run in the panel and under `node --test`.
//
// The SDK loads from bzrcdn.openai.com/sdk/oaiq.min.js, fetches a per-pixel
// config from bzrcdn.openai.com/pixel-config/v1/<pixelId>.json and posts events
// to bzr.openai.com/v1/sdk/events. Only the events endpoint is a tracking hit.
//
//   POST /v1/sdk/events?pid=<pixelId>&st=oaiq-web&sv=<sdkVersion>&t=<ms>&ec=<n>
//   body (JSON, sent as text/plain):
//     { obref, oppref, user, events: [ { type, timestamp_ms, id, source_url,
//                                        referrer_url, opt_out, custom_event_name,
//                                        data } ] }
//
// Batching is the normal case (the SDK flushes 1 s after the last event, at the
// latest 4 s after the first), so one request carries several events — we return
// one record per event, like the GA4 batch POST.
//
// Two things ride along that are not marketing events: `openai::sdk_init` and
// `oai::diagnostic`. The diagnostic is worth a card of its own: it reports the
// consent state the SDK acted on, and the events it DROPPED with their reasons
// (unsupported_event_name / missing_event_props / invalid_event_props /
// invalid_event_options) — the pixel telling us the site's implementation is
// broken. Reading it is reading the payload, not validating anything.
//
// Consent shows up twice, and both readings come off the wire: the diagnostic's
// `consent` boolean, and the shape of the request itself — a denied session
// posts a stripped body (`events` only, no obref / oppref / user) that the SDK
// sends with `credentials: "omit"`, and drops every marketing event before it
// gets there.
//
// User data is nested by SOURCE, which no other provider does: `user.in` is what
// the site passed to oaiq("init"), while `user.fm` / `user.js` / `user.ht` are
// what Automatic Advanced Matching scraped from the page's forms, JS variables
// and HTML. Same wire keys in each (em / ph / fn / ln / eid / co / ct / rg / pc),
// so the card can say whether an identifier was set deliberately or collected by
// the SDK. Verified against real captures: scraped values whose hash equals one
// already passed to init are dropped by the SDK, so a populated `fm` block means
// the page really did carry a second identity.

import { extractParams, piiField } from './params.js';

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export function isOpenAiPixelHost(host) {
  return (host || '').toLowerCase() === 'bzr.openai.com';
}

// The CDN host serves the SDK and the per-pixel config — never an event.
export function isOpenAiSdkHost(host) {
  return (host || '').toLowerCase() === 'bzrcdn.openai.com';
}

const EVENTS_PATH = '/v1/sdk/events';

export const STANDARD_EVENTS = new Set([
  'order_created', 'items_added', 'checkout_started',
  'page_viewed', 'contents_viewed',
  'lead_created', 'registration_completed', 'appointment_scheduled',
  'subscription_created', 'trial_started',
]);

// SDK-internal event types. They share the transport with real events but mean
// nothing to a marketer, so the panel renders them as diagnostics.
export const INTERNAL_EVENTS = new Set(['oai::diagnostic', 'openai::sdk_init']);

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

// `amount` is an integer in the currency's SMALLEST unit — 12497 EUR-cents, but
// 12497 whole yen. Dividing blindly would invent a hundredfold error on the
// zero-decimal currencies, so those are listed out (ISO 4217 exponent 0).
const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW', 'PYG',
  'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

export function formatMinorAmount(amount, currency) {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return null;
  const cur = (currency || '').toUpperCase();
  if (!cur || ZERO_DECIMAL.has(cur)) return String(amount);
  return (amount / 100).toFixed(2);
}

// ---------------------------------------------------------------------------
// User data (nested by source)
// ---------------------------------------------------------------------------

// Wire key → identifier bucket + label. Shared by every source block.
const USER_KEYS = {
  em:  ['email', 'Email'],
  ph:  ['phone', 'Phone'],
  fn:  ['firstName', 'First name'],
  ln:  ['lastName', 'Last name'],
  eid: ['externalId', 'External ID'],
  co:  ['country', 'Country'],
  ct:  ['city', 'City'],
  rg:  ['region', 'Region'],
  pc:  ['postal', 'Postal code'],
};

// Source block → how it got there. `in` is the site's own doing; the other three
// are Automatic Advanced Matching reading the page.
const USER_SOURCES = {
  in: 'init',
  fm: 'form (auto)',
  js: 'JS variable (auto)',
  ht: 'HTML (auto)',
};

// Flatten `user` into the panel's flat PII map, keeping the source in the key so
// "Email (init)" and "Email (form (auto))" can stand next to each other. Values
// may be a single string or an array (the auto sources send em/ph as arrays).
export function flattenUserData(user) {
  if (!user || typeof user !== 'object') return null;
  const out = {};
  for (const [src, srcLabel] of Object.entries(USER_SOURCES)) {
    const block = user[src];
    if (!block || typeof block !== 'object') continue;
    for (const [key, [bucket, label]] of Object.entries(USER_KEYS)) {
      const raw = block[key];
      if (raw == null || raw === '') continue;
      const list = Array.isArray(raw) ? raw.filter((v) => v != null && v !== '') : null;
      if (list && !list.length) continue;
      const first = list ? list[0] : raw;
      const field = piiField(bucket, `${label} (${srcLabel})`, first);
      field.source = src;
      if (list && list.length > 1) field.list = list;
      out[`${src}.${key}`] = field;
    }
  }
  return Object.keys(out).length ? out : null;
}

export function summarizeIdentifiers(userData) {
  const ids = { email: 0, phone: 0, name: 0, address: 0 };
  for (const f of Object.values(userData || {})) {
    const n = f.list ? f.list.length : 1;
    if (f.bucket === 'email') ids.email += n;
    else if (f.bucket === 'phone') ids.phone += n;
    else if (f.bucket === 'firstName' || f.bucket === 'lastName') ids.name += n;
    else if (f.bucket === 'country' || f.bucket === 'city' || f.bucket === 'region' || f.bucket === 'postal') ids.address += n;
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Contents / diagnostics
// ---------------------------------------------------------------------------

function parseContents(list) {
  if (!Array.isArray(list) || !list.length) return null;
  return list.map((c) => ({
    id: c && c.id != null ? String(c.id) : null,
    name: c && c.name != null ? String(c.name) : null,
    contentType: c && c.content_type != null ? String(c.content_type) : null,
    quantity: c && c.quantity != null ? String(c.quantity) : null,
    amount: c && typeof c.amount === 'number' ? c.amount : null,
    amountText: c ? formatMinorAmount(c.amount, c.currency) : null,
    currency: c && c.currency != null ? String(c.currency).toUpperCase() : null,
  }));
}

// The diagnostic event's own payload: what the SDK decided and what it threw
// away. Counters are objects keyed by reason / event name / phase.
function parseDiagnostic(data) {
  if (!data || typeof data !== 'object') return null;
  const counts = (o) => (o && typeof o === 'object' && Object.keys(o).length ? o : null);
  return {
    schemaVersion: data.schema_version != null ? String(data.schema_version) : null,
    consent: typeof data.consent === 'boolean' ? data.consent : null,
    firstVisit: data.is_first_visit_in_session === true,
    firstConsentGrant: data.is_first_consent_grant_in_session === true,
    // "enabled" / "disabled" — whether the account has Automatic Advanced
    // Matching turned on, straight from the SDK's config telemetry.
    autoMatching: data.config && data.config.automatic_advanced_matching != null
      ? String(data.config.automatic_advanced_matching) : null,
    droppedCount: typeof data.dropped_event_count === 'number' ? data.dropped_event_count : 0,
    droppedReasons: counts(data.dropped_event_reason_counts),
    droppedNames: counts(data.dropped_event_name_counts),
    droppedPhases: counts(data.dropped_event_phase_counts),
    droppedDetails: Array.isArray(data.dropped_event_details) && data.dropped_event_details.length
      ? data.dropped_event_details : null,
  };
}

// A v4 UUID is what the SDK generates when the site passed no event_id. Anything
// else in `id` was supplied by the site as a deduplication key for the
// Conversions API. A site that happens to pass a v4 UUID of its own is
// indistinguishable here — hence a flag, not a claim about intent.
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

// A "session marker" is the diagnostic that reports first visit / first consent
// grant. The SDK sends a batch made up ONLY of those credentially-omitted even
// when consent was granted (`!w() || events.every(Qe)` in the SDK), so the
// stripped body on its own does not prove a denial — hence the third state.
function isSessionMarker(e) {
  const d = e && e.data;
  return e && e.type === 'oai::diagnostic' && !!d &&
    (d.is_first_visit_in_session === true || d.is_first_consent_grant_in_session === true);
}

// Three readings, most reliable first:
//   the diagnostic states it · a full body means consent was not denied (the SDK
//   would have stripped it otherwise) · a stripped body carrying anything but a
//   session marker means it was. Anything else stays unknown rather than guessed.
export function readConsent(events, credentialless, diagnostic) {
  if (diagnostic && diagnostic.consent != null) {
    return { granted: diagnostic.consent, credentialless, source: 'diagnostic' };
  }
  if (!credentialless) return { granted: true, credentialless, source: 'transport' };
  if (events.some((e) => !isSessionMarker(e))) {
    return { granted: false, credentialless, source: 'transport' };
  }
  return { granted: null, credentialless, source: null };
}

// ---------------------------------------------------------------------------
// Full parse
// ---------------------------------------------------------------------------

export function parseOpenAiRequest(url, postData) {
  let host = '', pathname = '', search = null;
  try { const u = new URL(url); host = u.host; pathname = u.pathname; search = u.searchParams; }
  catch (e) { return null; }

  if (!isOpenAiPixelHost(host) || pathname !== EVENTS_PATH) return null;

  const { queryParams, bodyParams, bodyJson } = extractParams(url, postData);
  const body = bodyJson && typeof bodyJson === 'object' ? bodyJson : {};
  const events = Array.isArray(body.events) ? body.events : [];
  if (!events.length) return null;

  const pixelId = search.get('pid') || null;
  const browserRef = body.obref != null ? String(body.obref) : null;
  const clickId = body.oppref != null ? String(body.oppref) : null;
  const userData = flattenUserData(body.user);

  // A stripped body — events only, no obref / oppref / user — is what the SDK
  // sends with `credentials: "omit"`.
  const credentialless = !browserRef && !body.user;

  const diagEvent = events.find((e) => e && e.type === 'oai::diagnostic');
  const diagConsent = diagEvent ? parseDiagnostic(diagEvent.data) : null;
  const consent = readConsent(events, credentialless, diagConsent);

  const total = events.length;
  const records = events.map((e, i) => {
    const type = e && e.type != null ? String(e.type) : 'unknown';
    const data = e && e.data && typeof e.data === 'object' ? e.data : {};
    const internal = INTERNAL_EVENTS.has(type);
    const custom = type === 'custom';
    const standard = STANDARD_EVENTS.has(type);
    const customEventName = e && e.custom_event_name != null ? String(e.custom_event_name) : null;
    const diagnostic = type === 'oai::diagnostic' ? parseDiagnostic(data) : null;

    const amount = typeof data.amount === 'number' ? data.amount : null;
    const currency = data.currency != null ? String(data.currency).toUpperCase() : null;
    const revenue = amount != null
      ? { value: formatMinorAmount(amount, currency), currency, minor: amount }
      : null;
    const contents = parseContents(data.contents);
    const eventId = e && e.id != null ? String(e.id) : null;

    // `user` sits on the envelope, so every event of a batch technically shares
    // it. Repeating it on the SDK's own telemetry cards would suggest the
    // diagnostic carried the visitor's identity — it counts the identifiers
    // instead and points at its siblings.
    const eventUserData = internal ? null : userData;
    const envelopeUserFields = internal && userData ? Object.keys(userData).length : 0;

    return {
      provider: 'openai',
      transport: 'standard',
      host,
      pathname,
      effectiveUrl: url,
      effectivePath: pathname,
      method: 'POST',
      pixelId,
      // custom events are named by custom_event_name — that is what shows up in
      // Ads Manager, so it is the card's event name.
      event: custom && customEventName ? customEventName : type,
      eventType: type,
      customEventName,
      dataType: data.type != null ? String(data.type) : null,   // contents | customer_action | plan_enrollment | custom | diagnostic | sdk_lifecycle
      eventId,
      timestamp: typeof e.timestamp_ms === 'number' ? e.timestamp_ms : null,
      pageUrl: e && e.source_url != null ? String(e.source_url) : null,
      referrer: e && e.referrer_url != null ? String(e.referrer_url) : null,
      optOut: e && e.opt_out === true,
      planId: data.plan_id != null ? String(data.plan_id) : null,
      revenue,
      contents,
      browserRef,
      clickId,
      sdkVersion: search.get('sv') || null,
      sdkType: search.get('st') || null,
      diagnostic,
      consent,
      flags: {
        internal,
        standardEvent: standard,
        custom,
        ecommerce: !!contents,
        itemCount: contents ? contents.length : 0,
        optOut: e && e.opt_out === true,
        dedupeId: !internal && !!(eventId && !UUID_V4.test(eventId)),
        autoMatching: !!(eventUserData && Object.keys(eventUserData).some((k) => !k.startsWith('in.'))),
        advancedMatching: !!eventUserData,
        droppedEvents: diagnostic ? diagnostic.droppedCount : 0,
      },
      envelopeUserFields,
      userData: eventUserData,
      identifiers: summarizeIdentifiers(eventUserData),
      queryParams,
      bodyParams,
      _batch: total > 1 ? { index: i + 1, total } : null,
    };
  });

  return records;
}
