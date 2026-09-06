// HubSpot tracking-code request detection & parsing — pure functions, no DOM /
// chrome APIs, so they run both in the panel and under `node --test`. Mirrors
// lib/reddit.js so the panel treats every provider uniformly.
//
// HubSpot spreads its tracking across two surfaces we recognise:
//
// 1. Tracking-code GET .gif beacons to track-<region>.hubspot.com:
//      /__ptq.gif    page view      (trackPageView / automatic)
//      /__ptbe.gif   behavioral hit (trackCustomBehavioralEvent) — event name in `n`
//      /__ptc.gif    click / interaction on a tracked element (_hs_* describe it)
//    Shared query params: a (hub / portal id = the account), pu (page url),
//    t (title), vi (visitor id), u / b (anonymous usertoken composites).
//    Custom event properties ride as `_<name>` (not `_hs_*`, which are internal).
//    The identify() payload rides on any of these beacons in the `i` param — a
//    URL-encoded querystring nested inside the outer one — decoded here into
//    { email, firstname, … }. Those identity fields travel in CLEARTEXT
//    (HubSpot does not hash), which the shared PII block reports as "not hashed".
//
// 2. Collected Forms POST to forms-<region>.hscollectedforms.net:
//      /collected-forms/submit/form   a scraped form submission (type SCRAPED)
//    JSON body: contactFields { email, firstName, phone, … } in CLEARTEXT,
//    portalId (the account), formValues (every submitted field), pageUrl/Title.
//    This is HubSpot silently shipping filled-in form data — the loudest PII
//    surface of the lot, surfaced honestly as cleartext user data.
//
// Not tracking hits (ignored): the loader/config JS (hs-scripts.com,
// hs-analytics.net, hs-banner.com, cta *.hubspot.com/web-interactives) and the
// forms embed counters (hsforms.com/embed/v3/counters.gif — no portal id / PII).

import { extractParams, makeGetter, piiField } from './params.js';

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

// track.hubspot.com (US) and regional mirrors like track-eu1.hubspot.com.
export function isHubspotHost(host) {
  return /^track(-[a-z0-9]+)?\.hubspot\.com$/i.test(host || '');
}

// forms.hscollectedforms.net + regional mirrors (forms-eu1.hscollectedforms.net).
export function isHubspotFormsHost(host) {
  return /^forms(-[a-z0-9]+)?\.hscollectedforms\.net$/i.test(host || '');
}

// Returns 'pageview' | 'event' | 'click' | null for the track beacons.
function hubspotBeaconKind(pathname) {
  if (/^\/__ptq\.gif$/i.test(pathname || '')) return 'pageview';
  if (/^\/__ptbe\.gif$/i.test(pathname || '')) return 'event';
  if (/^\/__ptc\.gif$/i.test(pathname || '')) return 'click';
  return null;
}

// ---------------------------------------------------------------------------
// Identify → user data (shared by the `i` beacon param and collected forms)
// ---------------------------------------------------------------------------

// Known HubSpot contact properties → identifier bucket + label. Anything else in
// the payload is surfaced too (bucket 'other', label = the raw key), so nothing
// sent is hidden.
const IDENTIFY_FIELD = {
  email:       { bucket: 'email',     label: 'Email' },
  firstname:   { bucket: 'firstName', label: 'First name' },
  lastname:    { bucket: 'lastName',  label: 'Last name' },
  phone:       { bucket: 'phone',     label: 'Phone' },
  mobilephone: { bucket: 'phone',     label: 'Mobile phone' },
  company:     { bucket: 'other',     label: 'Company' },
  jobtitle:    { bucket: 'other',     label: 'Job title' },
  city:        { bucket: 'city',      label: 'City' },
  state:       { bucket: 'region',    label: 'State' },
  zip:         { bucket: 'postal',    label: 'Zip' },
  country:     { bucket: 'country',   label: 'Country' },
};

// Decode the nested identify querystring into { <field>: <value> } or null. The
// URL layer already decoded one level, so `iRaw` looks like a plain querystring.
export function extractHubspotIdentify(iRaw) {
  if (!iRaw) return null;
  const params = new URLSearchParams(String(iRaw));   // string ctor never throws
  const out = {};
  for (const [k, v] of params) {
    if (v === '') continue;
    out[k.toLowerCase()] = v;
  }
  return Object.keys(out).length ? out : null;
}

// Returns { <field>: { bucket, label, hashed, algo } } or null. HubSpot sends
// these in cleartext, so hashed is false / algo null — reported plainly, no leak
// alarm (that framing was deliberately dropped from the PII block). Keys are
// lower-cased so the collected-forms camelCase (firstName) and the beacon
// lowercase (firstname) map to the same field.
export function extractHubspotUserData(identify) {
  if (!identify) return null;
  const ud = {};
  for (const [rawKey, v] of Object.entries(identify)) {
    if (v == null || v === '') continue;
    const k = rawKey.toLowerCase();
    const def = IDENTIFY_FIELD[k] || { bucket: 'other', label: rawKey };
    ud[k] = piiField(def.bucket, def.label, String(v));
  }
  return Object.keys(ud).length ? ud : null;
}

// Compact { email, phone, name, address } summary — same shape as the other
// providers. Presence-based (1 per bucket).
export function summarizeHubspotIdentifiers(userData) {
  const vals = Object.values(userData || {});
  const has = (...buckets) => vals.some((f) => buckets.includes(f.bucket));
  return {
    email: has('email') ? 1 : 0,
    phone: has('phone') ? 1 : 0,
    name: has('firstName', 'lastName') ? 1 : 0,
    address: has('city', 'region', 'postal', 'country', 'street') ? 1 : 0,
  };
}

// Custom event properties ride as `_<name>` params (trackCustomBehavioralEvent).
// `_hs_*` are HubSpot-internal (click geometry etc.), never user properties.
export function extractHubspotProperties(queryParams) {
  const props = {};
  for (const [k, v] of Object.entries(queryParams || {})) {
    if (k.length > 1 && k[0] === '_' && !/^_hs_/i.test(k)) props[k.slice(1)] = v;
  }
  return Object.keys(props).length ? props : null;
}

// ---------------------------------------------------------------------------
// Full parse
// ---------------------------------------------------------------------------

// Returns a normalized record or null for non-HubSpot requests.
export function parseHubspotRequest(url, postData) {
  let host = '', pathname = '';
  try { const u = new URL(url); host = u.host; pathname = u.pathname; }
  catch (e) { return null; }

  if (isHubspotHost(host)) {
    const kind = hubspotBeaconKind(pathname);
    if (kind) return parseHubspotBeacon(url, host, pathname, kind, postData);
  }
  if (isHubspotFormsHost(host) && /^\/collected-forms\/submit\/form$/i.test(pathname)) {
    return parseHubspotCollectedForm(url, host, pathname, postData);
  }
  return null;
}

// The track-<region>.hubspot.com GET beacons (page view / event / click).
function parseHubspotBeacon(url, host, pathname, kind, postData) {
  const { queryParams, bodyParams } = extractParams(url, postData);
  const get = makeGetter(queryParams, bodyParams);

  const accountId = get('a');
  if (!accountId) return null;                             // every hit carries its hub id

  const eventNameRaw = kind === 'event' ? get('n') : null;
  const event = kind === 'pageview' ? 'Page View'
    : kind === 'click' ? 'Click'
      : (eventNameRaw || '(unnamed event)');

  const identify = extractHubspotIdentify(get('i'));
  const userData = extractHubspotUserData(identify);
  const identifiers = summarizeHubspotIdentifiers(userData);
  const properties = kind === 'event' ? extractHubspotProperties(queryParams) : null;

  // Click interaction details (_hs_*) — kept readable, geometry left in the raw
  // query dump.
  let click = null;
  if (kind === 'click') {
    const c = {
      tag: get('_hs_tag_name'), text: get('_hs_element_text'),
      href: get('_hs_link_href'), elementId: get('_hs_element_id'),
      elementClass: get('_hs_element_class'),
      isNavigation: get('_hs_is_navigation') === 'true',
    };
    if (c.tag || c.text || c.href || c.elementId || c.elementClass) click = c;
  }

  const flags = {
    pageview: kind === 'pageview',
    customEvent: kind === 'event',
    click: kind === 'click',
    identify: !!identify,                                  // identify() data rode on this beacon
  };

  return {
    provider: 'hubspot',
    transport: 'standard',
    host,
    pathname,
    effectiveUrl: url,
    effectivePath: pathname,
    method: postData ? 'POST' : 'GET',
    eventType: kind,
    event,
    eventNameRaw,
    accountId: String(accountId),
    pageUrl: get('pu') || null,
    pageTitle: get('t') || null,
    visitorId: get('vi') || null,
    version: get('v') || null,
    properties,
    click,
    identify,
    flags,
    userData,
    identifiers,
    consent: null,
    queryParams,
    bodyParams,
  };
}

// The Collected Forms submission (POST JSON) — HubSpot scraping a filled form and
// shipping contactFields + every form value in cleartext.
function parseHubspotCollectedForm(url, host, pathname, postData) {
  const { queryParams, bodyParams, bodyJson } = extractParams(url, postData);
  if (!bodyJson || bodyJson.portalId == null) return null;  // ignores the OPTIONS preflight too

  // contactFields carry the identity payload (camelCase); normalise to the shared
  // lowercase identify shape.
  const identify = {};
  const cf = bodyJson.contactFields;
  if (cf && typeof cf === 'object') {
    for (const [k, v] of Object.entries(cf)) {
      if (v != null && v !== '') identify[k.toLowerCase()] = String(v);
    }
  }
  const identifyOrNull = Object.keys(identify).length ? identify : null;
  const userData = extractHubspotUserData(identifyOrNull);
  const identifiers = summarizeHubspotIdentifiers(userData);

  // formValues is a { <label>: <value> } map of what was actually typed.
  const fv = (bodyJson.formValues && typeof bodyJson.formValues === 'object') ? bodyJson.formValues : null;
  const formValues = fv
    ? Object.fromEntries(Object.entries(fv).map(([k, v]) => [k, v == null ? '' : String(v)]))
    : null;

  const flags = { form: true, identify: !!userData };

  return {
    provider: 'hubspot',
    transport: 'collected-forms',
    host,
    pathname,
    effectiveUrl: url,
    effectivePath: pathname,
    method: 'POST',
    eventType: 'form',
    event: 'Form submission',
    eventNameRaw: null,
    accountId: String(bodyJson.portalId),
    pageUrl: bodyJson.pageUrl || null,
    pageTitle: bodyJson.pageTitle || null,
    visitorId: bodyJson.utk || null,
    version: bodyJson.version || null,
    formId: bodyJson.collectedFormId || null,
    formType: bodyJson.type || null,                       // e.g. SCRAPED
    formValues,
    identify: identifyOrNull,
    flags,
    userData,
    identifiers,
    consent: null,
    queryParams,
    bodyParams,
  };
}
