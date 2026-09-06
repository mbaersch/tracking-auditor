// Taboola pixel detection & parsing — pure functions, no DOM / chrome APIs, so
// they run in the panel and under `node --test`. Mirrors the other lib/*.js
// providers so the panel treats every provider uniformly.
//
// Taboola loads its base tag from cdn.taboola.com/libtrc/unip/<account>/tfa.js
// (account = numeric id, e.g. 1733840) and fires to trc.taboola.com. Two tracking
// shapes matter (everything else — the loader, pips/cds/sync-* id-sync, p3p.xml —
// is not a tracking event and is ignored):
//   GET /<account>/trc/3/json?tim=…&data=<JSON>   the PAGE VIEW. The event lives
//        inside the URL-encoded JSON `data` param as data.mpvd.en ("page_view"),
//        with the page url (u), previous page (e), user id (ui) and consent
//        (cbp / tcs / ccpa) alongside.
//   GET /<account>/log/3/<action>?en=<event>&…    an EVENT (unip | action | mark).
//        The event name is the flat `en` param; a conversion adds flat
//        revenue / currency / orderid / quantity. item-url = page, ref = referrer.
// Engagement pings (en=pre_d_eng_tb — time-on-site / scroll telemetry) are flagged
// as noise, the same signal the Taboola Pixel Helper blacklists.
//
// Taboola tracking is cookie/id based (ui = user id, sd = opaque session token),
// but it also carries a hashed-email identity when configured: AudienceMatch's
// `unified_id` = the SHA-256 of the lower-cased email. It rides as a flat query
// param on the request — verified on a real /log/3/unip event
// (…?en=lead&unified_id=<sha256>&…) — whether set pre-init via
// _taboola.push({unified_id}) or passed at event level via
// _tfa.push({notify:'event', …, unified_id}). We surface it as a hashed Email
// identifier (the only PII the pixel carries). Consent is surfaced verbatim (TCF
// `tcs` string + US-privacy `ccpaPs` + the CMP name `cbp`); the TCF is not decoded.

import { extractParams, piiField } from './params.js';

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

// Tracking hits land on trc.taboola.com and the trc-events.taboola.com mirror.
// cdn./pips./cds./sync-*.taboola.com are the loader and id-sync, not events.
export function isTaboolaHost(host) {
  const h = (host || '').toLowerCase();
  return h === 'trc.taboola.com' || h === 'trc-events.taboola.com';
}

// Taboola's standard events (lower-cased). Unknown → custom.
const STANDARD_EVENTS = new Set([
  'page_view', 'view_content', 'view_category', 'add_to_cart', 'add_to_wishlist',
  'start_checkout', 'add_payment_info', 'make_purchase', 'purchase', 'search',
  'lead', 'complete_registration', 'sign_up', 'subscribe', 'contact', 'download',
  'schedule', 'start_trial', 'submit_application',
]);

const ENGAGEMENT_EVENT = 'pre_d_eng_tb';   // time-on-site / scroll telemetry (helper blacklists it)

// ---------------------------------------------------------------------------
// Full parse
// ---------------------------------------------------------------------------

// Path shapes: /<account>/trc/<n>/json (page view) · /<account>/log/<n>/<action> (event).
const PAGEVIEW_RE = /^\/(\d+)\/trc\/\d+\/json$/;
const EVENT_RE    = /^\/(\d+)\/log\/\d+\/(unip|action|mark|actions)$/;

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

// Pull the consent trio (TCF string, US-privacy, CMP) from either the flat query
// (log events) or the decoded data JSON (page view). Returns null if none present.
function consentFrom(get) {
  const tcf = get('tcs');
  const usPrivacy = get('ccpaPs') || get('ccpa');
  const cmp = get('cbp');
  if (!tcf && !usPrivacy && !cmp) return null;
  return {
    tcf: tcf || null,               // full TCF consent string, surfaced not decoded
    usPrivacy: usPrivacy || null,   // e.g. "1---"
    cmp: cmp || null,               // consent platform name, e.g. "ConsentManager"
    cmpVersion: get('cbpv') || null,
  };
}

export function parseTaboolaRequest(url, postData) {
  let host = '', pathname = '', search = null;
  try { const u = new URL(url); host = u.host; pathname = u.pathname; search = u.searchParams; }
  catch (e) { return null; }

  if (!isTaboolaHost(host)) return null;

  const pv = pathname.match(PAGEVIEW_RE);
  const ev = pathname.match(EVENT_RE);
  if (!pv && !ev) return null;                 // loader / sync / p3p.xml / anything else

  const account = (pv || ev)[1];
  const { queryParams, bodyParams } = extractParams(url, postData);

  let shape, event, get, pageUrl, referrer, revenue = null, orderId = null, quantity = null, engagement = false;

  if (pv) {
    // Page view: the interesting fields live inside the decoded `data` JSON.
    shape = 'pageview';
    const data = safeJsonParse(search.get('data') || '') || {};
    const mpvd = (data && typeof data.mpvd === 'object' && data.mpvd) || {};
    get = (k) => {
      if (k in data && typeof data[k] !== 'object') return data[k];
      if (k in mpvd) return mpvd[k];
      return null;
    };
    event = (mpvd.en || 'page_view');
    pageUrl = data.u || mpvd['item-url'] || null;
    referrer = data.e || mpvd.ref || null;
  } else {
    // Event: flat query params, event name in `en`.
    shape = 'event';
    get = (k) => search.get(k);
    event = get('en') || 'unknown';
    pageUrl = get('item-url') || null;
    referrer = get('ref') || null;
    engagement = event === ENGAGEMENT_EVENT;
    const rev = get('revenue');
    if (rev != null && rev !== '') revenue = { value: String(rev), currency: get('currency') || null };
    orderId = get('orderid') || null;
    quantity = get('quantity') != null && get('quantity') !== '' ? String(get('quantity')) : null;
  }

  const standardEvent = STANDARD_EVENTS.has(String(event).toLowerCase());
  const consent = consentFrom(get);

  // unified_id = SHA-256 of the lower-cased email (AudienceMatch identity). Rides
  // as a flat query param when present; check the data JSON (via get) and the raw
  // query (page view keeps its params outside data).
  const unifiedId = get('unified_id') || (search && search.get('unified_id')) || null;
  const userData = unifiedId
    ? { unified_id: piiField('email', 'Email (unified_id)', unifiedId) }
    : null;

  const flags = {
    standardEvent,
    custom: !standardEvent && !engagement,
    ecommerce: !!revenue,
    engagement,                        // pre_d_eng_tb — time-on-site telemetry, not a real event
    hashedEmail: !!userData,           // unified_id present (AudienceMatch)
  };

  return {
    provider: 'taboola',
    transport: 'standard',
    host,
    pathname,
    effectiveUrl: url,
    effectivePath: pathname,
    method: postData ? 'POST' : 'GET',
    shape,                             // 'pageview' | 'event'
    event: String(event),
    account: String(account),
    pageUrl,
    referrer,
    userId: get('ui') || null,         // Taboola cookie user id
    version: get('cv') || null,        // client version (e.g. 20260712-3-RELEASE)
    revenue,
    orderId,
    quantity,
    consent,
    standardEvent,
    flags,
    userData,                          // { unified_id: { bucket:'email', hashed, algo } } or null
    identifiers: { email: userData ? 1 : 0, phone: 0, name: 0, address: 0 },
    queryParams,
    bodyParams,
  };
}
