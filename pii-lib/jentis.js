// JENTIS (server-side tracking platform) — pure functions, no DOM / chrome APIs.
//
// JENTIS has no fixed endpoint: every instance runs on its own random subdomain
// (https://<id>.<site>/<random>.js loader, POST https://<id>.<site>/ for data), and
// some instances add a cookie-only POST to a path on the main domain. So detection
// is by BODY SIGNATURE, never by URL:
//
//   { client: { clientTimestamp, domain }, cmd: {…}, requestType,
//     data: [ { _id, action: new|upd, account: "<name>.<env>", documentType,
//               pluginid?, parent, property: {…}, system: { href, consent } } ] }
//
// Verified on three live sites (11/2026). Sent by XHR as application/json and on
// page leave by sendBeacon as text/plain — same JSON either way.
//
// documentType is user | session | event | consent. user/session ride along in
// every request (action "upd") and say nothing on their own, so they get no card.
// Each event/consent document becomes one record.
//
// What is stable across sites, and what is not: `property` carries ONLY the
// variables configured in the site's JENTIS container. A live test pushed full
// product/order objects (`_jts.push({ track: 'product', … })`) to a container
// without e-commerce variables — the request carried no id, no price, nothing;
// only `jtspushedcommands: ["product","order","submit"]`. So the command list,
// pluginid, account, documentType and the per-vendor consent are the readable
// facts; everything else in `property` is shown as "sent by the container",
// never interpreted — except product_* columns, which are zipped into items
// (see zipProducts).
//
// Events sent before the consent decision are SENT AGAIN after it with the same
// _id and more fields. `_collapseKey` folds both into one card; the richer copy
// wins via `_transportRank`.

import { extractParams } from './params.js';

// Commands from the JENTIS data layer docs ("Set up JENTIS Data Layer"): page
// views, events and the e-commerce product types. `product` and `submit` only
// frame a call (product data / "send now"), they are never the event itself.
export const STANDARD_COMMANDS = new Set([
  'pageview', 'virtualpageview', 'event',
  'categoryview', 'productview', 'addtocart', 'removefromcart', 'cartview',
  'checkout', 'order', 'productlist', 'productlistclick', 'search',
]);
const FRAMING = new Set(['product', 'submit']);

// Events the JENTIS client raises by itself (no _jts.push), seen on live sites.
// Plain labels for the card; an unknown pluginid is shown as-is.
const PLUGIN_LABELS = {
  scroll_tracking: 'scroll',
  page_transition_event: 'page transition (engagement)',
  jts_framework_loaded: 'framework loaded',
  new_jentis_user: 'new user',
  new_jentis_session: 'new session',
};

function bodyText(postData) {
  if (typeof postData === 'string') return postData;
  return postData && typeof postData.text === 'string' ? postData.text : null;
}

/** The parsed body when it has the JENTIS shape, else null. Cheap enough to run on every POST. */
export function jentisBody(postData) {
  const text = bodyText(postData);
  if (!text || text[0] !== '{' || text.indexOf('"documentType"') === -1) return null;
  let obj;
  try { obj = JSON.parse(text); } catch (e) { return null; }
  if (!obj || typeof obj !== 'object' || !('client' in obj) || !Array.isArray(obj.data)) return null;
  return obj.data.some((d) => d && typeof d.documentType === 'string') ? obj : null;
}

/** The pushed command that names the event: the last one that isn't framing (product / submit). */
export function commandOf(pushed) {
  if (!Array.isArray(pushed)) return null;
  const real = pushed.filter((c) => typeof c === 'string' && !FRAMING.has(c));
  return real.length ? real[real.length - 1] : null;
}

/** vendor → 'granted' | 'denied' | 'ncm' | raw string; counts per state. */
export function readVendorConsent(vendors) {
  if (!vendors || typeof vendors !== 'object') return null;
  const states = {};
  const counts = { granted: 0, denied: 0, ncm: 0, other: 0 };
  for (const [vendor, v] of Object.entries(vendors)) {
    // "ncm" appears instead of true/false for vendors run in consent mode after a
    // denial (seen on Google Ads, Meta, Bing, LinkedIn …). Shown verbatim — what
    // the server does with it is not visible in the browser.
    const s = v === true ? 'granted' : v === false ? 'denied' : v === 'ncm' ? 'ncm' : String(v);
    states[vendor] = s;
    counts[s in counts ? s : 'other']++;
  }
  return { vendors: states, counts };
}

function present(v) {
  return v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length);
}

// Containers that map e-commerce send products COLUMN-wise: one array per field
// (product_id, product_name, product_price, … each with one entry per item; seen
// live with 18 items in a product list). Read row-wise they are one product per
// index. product_id is the anchor; every product field with the same length joins
// in, empty slots are dropped. Scalars instead of arrays = a single product.
const PRODUCT_KEY = /^product_|_of_product$/;
const productLabel = (k) => k.replace(/^product_/, '').replace(/_of_product$/, '');

export function zipProducts(property) {
  const anchor = property && property.product_id;
  if (!present(anchor)) return null;
  const n = Array.isArray(anchor) ? anchor.length : 1;
  const cols = Object.entries(property).filter(([k, v]) => PRODUCT_KEY.test(k)
    && (Array.isArray(anchor) ? Array.isArray(v) && v.length === n : !Array.isArray(v)));
  const products = [];
  for (let i = 0; i < n; i++) {
    const p = {};
    for (const [k, v] of cols) {
      const x = Array.isArray(anchor) ? v[i] : v;
      if (present(x)) p[productLabel(k)] = typeof x === 'object' ? JSON.stringify(x) : String(x);
    }
    products.push(p);
  }
  return { products, keys: cols.map(([k]) => k) };
}

export function parseJentisRequest(url, postData) {
  const body = jentisBody(postData);
  if (!body) return null;
  let host = '', pathname = '';
  try { const u = new URL(url); host = u.host; pathname = u.pathname; } catch (e) { return null; }
  const { queryParams, bodyParams } = extractParams(url, postData);
  const sentAt = body.client && body.client.clientTimestamp != null ? String(body.client.clientTimestamp) : null;

  const records = [];
  for (const d of body.data) {
    if (!d || (d.documentType !== 'event' && d.documentType !== 'consent')) continue;
    const p = d.property && typeof d.property === 'object' ? d.property : {};
    const isConsent = d.documentType === 'consent';
    const command = isConsent ? null : commandOf(p.jtspushedcommands);
    const pluginId = d.pluginid != null ? String(d.pluginid) : null;
    const eventName = present(p.event_name) ? String(p.event_name) : null;

    let event, eventType;
    if (isConsent) { event = 'consent'; eventType = 'consent'; }
    else if (command === 'event') { event = eventName || 'event'; eventType = 'event'; }
    else if (command) { event = command; eventType = 'command'; }
    else { event = PLUGIN_LABELS[pluginId] || pluginId || 'event'; eventType = 'plugin'; }

    // Consent documents list the vendors in property.vendors; every event carries
    // the state it was sent under in system.consent.
    const consent = readVendorConsent(isConsent ? p.vendors : (d.system && d.system.consent));
    if (consent) consent.source = isConsent ? 'consent document (property.vendors)' : 'system.consent';

    const zipped = isConsent ? null : zipProducts(p);
    const products = zipped ? zipped.products : null;

    // Everything else the container chose to send, minus what is shown elsewhere.
    const SHOWN = new Set(['jtspushedcommands', 'event_name', 'event_group', 'event_value', 'vendors', 'vendorsConsentMode', 'vendorsChanged', ...(zipped ? zipped.keys : [])]);
    const properties = {};
    for (const [k, v] of Object.entries(p)) {
      if (SHOWN.has(k) || !present(v)) continue;
      properties[k] = v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v);
    }

    const pageUrl = present(p.window_location_href) ? String(p.window_location_href)
      : (d.system && d.system.href) || null;
    const richness = Object.keys(properties).length + (consent ? Object.keys(consent.vendors).length : 0) + (products ? products.length : 0);

    records.push({
      provider: 'jentis',
      transport: 'standard',
      host,
      pathname,
      effectiveUrl: url,
      effectivePath: pathname,
      method: 'POST',
      account: d.account != null ? String(d.account) : null,
      event,
      eventType,                      // event | command | plugin | consent
      command,
      pushedCommands: Array.isArray(p.jtspushedcommands) ? p.jtspushedcommands.map(String) : null,
      pluginId,
      eventGroup: present(p.event_group) ? String(p.event_group) : null,
      eventValue: present(p.event_value) ? String(p.event_value) : null,
      documentType: d.documentType,
      docId: d._id != null ? String(d._id) : null,
      action: d.action != null ? String(d.action) : null,
      consent,
      consentModes: isConsent && p.vendorsConsentMode && typeof p.vendorsConsentMode === 'object' ? p.vendorsConsentMode : null,
      requestType: body.requestType != null ? String(body.requestType) : null,
      pageUrl,
      properties: Object.keys(properties).length ? properties : null,
      products,
      flags: {
        itemCount: products ? products.length : 0,
        standardCommand: !!(command && STANDARD_COMMANDS.has(command)),
        unknownCommand: !!(command && !STANDARD_COMMANDS.has(command)),
        custom: eventType === 'event',
        plugin: eventType === 'plugin',
        consentDoc: isConsent,
        ecommerce: !!products || !!(command && STANDARD_COMMANDS.has(command) && !['pageview', 'virtualpageview', 'event'].includes(command)),
        propertyCount: Object.keys(properties).length,
      },
      identifiers: { email: 0, phone: 0, name: 0, address: 0 },
      userData: null,
      queryParams,
      bodyParams,
      // One card per document: the resend after the consent decision folds in.
      _collapseKey: d._id != null ? `jentis:${d.documentType}:${d._id}` : undefined,
      _transportRank: richness,
      // The resend carries the SAME clientTimestamp as the first copy (seen live),
      // so the label tells the copies apart by the consent they were sent under.
      _transportLabel: consent ? `with consent state of ${Object.keys(consent.vendors).length} vendor(s)` : (sentAt ? `sent ${sentAt}` : 'sent'),
    });
  }
  return records.length ? records : null;
}
