// Criteo OneTag request detection & parsing — pure functions, no DOM / chrome
// APIs, so they run both in the panel and under `node --test`. Mirrors the shape
// of the other provider modules.
//
// Criteo fires its tracking to sslwidget.criteo.com/event (GET). The loader is
// dynamic.criteo.com/js/ld/ld.js; gum/dis/mug.criteo.com are identity / cookie
// sync (Criteo syncs its user id out to a whole RTB ecosystem) and are NOT
// tracking events — the /event path check below excludes them cleanly.
//
// One /event request BATCHES several slots p0..pN, each its own querystring
// `e=<code>&…`. Codes seen on real delife.de captures (browse + console-fired):
//   vh  viewHome            vl  viewList (ca, p)        vp  viewItem (pr, p)
//   ac  addToCart (p[])     vb  viewBasket (c, p[])     vc  transaction (id, p[])
//   vpg viewPage            ce  setEmail (m=[email])    trackleads  lead (leadType)
//   exd external data · dis display  → technical, hidden from the card
// Unknown codes are surfaced verbatim, never dropped.
//
// Item arrays ride as p=[i=<id>&pr=<price>&q=<qty>] (repeatable) — their inner
// &/= are single-encoded at the slot level, so we must parse each slot from the
// once-decoded raw value WITHOUT a second blanket decode (which would shred the
// array), giving the bracket group special handling.
//
// PII: setEmail (e=ce) carries the email in `m`. On delife it arrives in PLAIN
// TEXT (un-hashed) — surfaced honestly via looksHashed/hashAlgo → "not hashed",
// like HubSpot. No leak alarm, no validation.

import { extractParams, hashAlgo, looksHashed, makeGetter, piiField } from './params.js';

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export function isCriteoHost(host) {
  return /(^|\.)criteo\.com$/.test((host || '').toLowerCase());
}

function isEventPath(pathname) {
  return /^\/event\/?$/.test(pathname || '');
}

// code → friendly name. Missing codes render verbatim.
const EVENT_NAME = {
  vh: 'view home', vl: 'view list', vp: 'view item', ac: 'add to cart',
  vb: 'view basket', vc: 'transaction', vpg: 'view page',
  ce: 'set email', trackleads: 'lead',
};
const TECHNICAL = new Set(['exd', 'dis']);

// ---------------------------------------------------------------------------
// Slot + item parsing
// ---------------------------------------------------------------------------

// Decode a value all the way down. Item arrays / emails are nested values whose
// inner &/= are encoded one (browse tag) or two (console-fired) levels deeper
// than the slot's own separators — so once a value is ISOLATED we can safely
// unwrap it fully without the inner separators colliding with slot ones.
function fullyDecode(s) {
  if (typeof s !== 'string') return s;
  for (let i = 0; i < 4; i++) {
    let n;
    try { n = decodeURIComponent(s); } catch (e) { break; }
    if (n === s) break;
    s = n;
  }
  return s;
}

// Parse one once-decoded slot string ("e=vb&c=EUR&p=[i=28249&pr=159.9&q=1]") into
// { code, params }. Splitting on the slot's own literal `&` isolates each value
// intact — the array/email inner separators are still encoded at this level, so
// they never split. Isolated values are unwrapped by the callers as needed.
function parseSlot(decoded) {
  const params = {};
  let code = null;
  for (const pair of decoded.split('&')) {
    if (!pair) continue;
    const i = pair.indexOf('=');
    const k = i < 0 ? pair : pair.slice(0, i);
    const v = i < 0 ? '' : pair.slice(i + 1);
    if (k === 'e') code = v;
    else if (k) params[k] = v;
  }
  return code ? { code, params } : null;
}

// p=[i=<id>&pr=<price>&q=<qty>] (repeatable) → [{ id, price, quantity, … }].
// Fully decodes first so both browse-tag and console-fired encodings normalize.
export function parseCriteoItems(p) {
  const s = fullyDecode(p);
  if (typeof s !== 'string' || !s.startsWith('[')) return null;
  const items = [];
  for (const m of s.matchAll(/\[([^\]]*)\]/g)) {
    const it = {};
    for (const pair of m[1].split('&')) {
      const i = pair.indexOf('=');
      if (i < 0) continue;
      const k = pair.slice(0, i), v = pair.slice(i + 1);
      if (k === 'i') it.id = v;
      else if (k === 'pr') it.price = v;
      else if (k === 'q') it.quantity = v;
      else it[k] = v;
    }
    if (Object.keys(it).length) items.push(it);
  }
  return items.length ? items : null;
}

const stripBrackets = (v) => (typeof v === 'string' ? v.replace(/^\[|\]$/g, '') : v);
// Isolated email value → the address, fully decoded, brackets stripped.
const decodeEmail = (v) => stripBrackets(fullyDecode(v));

// Σ price × quantity across items, or null when no item carries a price. Criteo
// sends no order total, so this is a DERIVED figure (marked computed by callers).
function itemsTotal(items) {
  if (!Array.isArray(items)) return null;
  let sum = 0, any = false;
  for (const it of items) {
    const pr = parseFloat(it.price);
    if (Number.isNaN(pr)) continue;
    any = true;
    sum += pr * (parseInt(it.quantity, 10) || 1);
  }
  return any ? Math.round(sum * 100) / 100 : null;
}

// Read the raw p0..pN slots straight off the URL (each decoded exactly once), so
// the item array survives. Returns [{ code, name, params }] in slot order.
function readSlots(url) {
  let search = '';
  try { search = new URL(url).search.slice(1); } catch (e) { return []; }
  const slots = [];
  for (const pair of search.split('&')) {
    const i = pair.indexOf('=');
    if (i < 0) continue;
    const k = pair.slice(0, i);
    if (!/^p\d+$/.test(k)) continue;
    let decoded = pair.slice(i + 1);
    try { decoded = decodeURIComponent(decoded); } catch (e) { /* leave raw */ }
    const parsed = parseSlot(decoded);
    if (parsed) slots.push({ code: parsed.code, name: EVENT_NAME[parsed.code] || parsed.code, params: parsed.params, index: parseInt(k.slice(1), 10) });
  }
  slots.sort((a, b) => a.index - b.index);
  return slots;
}

// ---------------------------------------------------------------------------
// PII (setEmail → e=ce&m=[email])
// ---------------------------------------------------------------------------

// Returns { m: { bucket, label, hashed, algo } } for the email carried in a ce
// slot, or null. The value itself is not stored here (it appears verbatim in the
// query-param detail, like every provider) — this only classifies its form.
export function extractCriteoUserData(slots) {
  const ce = slots.find((s) => s.code === 'ce');
  if (!ce) return null;
  const email = decodeEmail(ce.params.m);
  if (!email) return null;
  return { m: piiField('email', 'Email', email) };
}

export function summarizeCriteoIdentifiers(userData) {
  const email = userData && userData.m ? 1 : 0;
  return { email, phone: 0, name: 0, address: 0 };
}

// ---------------------------------------------------------------------------
// Full parse
// ---------------------------------------------------------------------------

// Returns a normalized record or null for non-Criteo / non-event requests.
export function parseCriteoRequest(url, postData) {
  let host = '', pathname = '';
  try { const u = new URL(url); host = u.host; pathname = u.pathname; }
  catch (e) { return null; }

  if (!isCriteoHost(host) || !isEventPath(pathname)) return null;

  const { queryParams, bodyParams } = extractParams(url, postData);
  const get = makeGetter(queryParams, bodyParams);

  const account = stripBrackets(get('a'));
  if (!account) return null;                               // every OneTag hit carries its account

  const slots = readSlots(url);
  if (!slots.length) return null;                          // no event slots → not a real event hit

  // Primary event = the first meaningful slot (skip technical exd/dis and the ce
  // email setter, which rides along on every hit). Fall back to whatever is left.
  const meaningful = slots.filter((s) => !TECHNICAL.has(s.code));
  const primary = meaningful.find((s) => s.code !== 'ce') || meaningful[0] || slots[0];

  // Product / commerce data from the primary slot.
  const p = primary.params.p;
  let items = parseCriteoItems(p);                         // [...] arrays (ac/vb/vc)
  if (!items && p) {                                       // vp/vl scalar product id
    const id = fullyDecode(p);
    if (id && !id.startsWith('[')) items = [{ id, price: primary.params.pr || null, quantity: null }];
  }
  const currency = primary.params.c || null;
  const transactionId = primary.params.id || null;         // vc
  const category = primary.params.ca || null;              // vl

  const userData = extractCriteoUserData(slots);
  const identifiers = summarizeCriteoIdentifiers(userData);

  // Criteo sends no order total — the value lives per-item in the p array. For a
  // single viewItem the price IS the value; for cart/basket/transaction we derive
  // the total (Σ price × qty) and mark it computed, so an auditor sees the order
  // value without us pretending Criteo sent it.
  let revenue = null;
  if (primary.code === 'vp' && primary.params.pr) {
    revenue = { value: String(primary.params.pr), currency, computed: false };
  } else {
    const total = itemsTotal(items);
    if (total != null) revenue = { value: String(total), currency, computed: true };
  }

  const flags = {
    knownEvent: primary.code in EVENT_NAME,
    commerce: !!(items || currency || transactionId),
    hasEmail: !!userData,
    cleartextEmail: !!(userData && userData.m && !userData.m.hashed),
  };

  return {
    provider: 'criteo',
    transport: 'standard',
    host,
    pathname,
    effectiveUrl: url,
    effectivePath: pathname,
    method: postData ? 'POST' : 'GET',
    event: primary.name,
    eventCode: primary.code,
    account: String(account),
    version: get('v') || null,
    pageUrl: fullyDecode(get('fu')) || null,             // fu is double-encoded → unwrap for display
    referrer: fullyDecode(get('pu')) || null,
    eventId: get('ceid') || null,
    category,
    currency,
    transactionId,
    items,
    revenue,
    slots,                                                 // all slots for the detail view
    flags,
    userData,
    identifiers,
    consent: {                                             // stored; surfaced in the detail
      usPrivacy: get('cs') || null,
      gpp: get('gpp') || null,
      gppSid: get('gpp_sid') || null,
    },
    sharedCookies: get('sc') || null,                      // e.g. {"fbp":…} — cross-vendor id sharing
    queryParams,
    bodyParams,
  };
}
