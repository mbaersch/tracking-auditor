// Awin (affiliate) tracking detection & parsing — pure functions, no DOM / chrome
// APIs, so they run in the panel and under `node --test`.
//
// Awin loads a MasterTag (www.dwin1.com/<MID>.js, MID = advertiser/merchant id) and
// fires to www.awin1.com (and whitelabel mirror domains). The tracking endpoints:
//   /sread.img · /sread.php · /sread.js   the SALE / conversion. One sale fans out
//        across these transports (image / server / JS) + whitelabel mirrors, all
//        sharing (merchant, orderRef) — folded into one card. TWO parameter namings
//        exist for the same fields: long (merchant, amount, ref, parts, testmode) on
//        /sread.img, short (a, b, c, d, t) on /sread.php|.js.
//   /basket.php   PRODUCT-LEVEL TRACKING. `product_line` holds one row per product,
//        rows joined by \r\n, each: AW:P|advertiserId|orderRef|productId|productName|
//        price|quantity|sku|commissionGroup|category.
//   /alt.php      the affiliate landing / click tag (mid + the relayed sale url).
// The MasterTag loader (dwin1.com/<MID>.js) and p3p.xml are not tracking hits.
//
// `parts` / `d` is the commission split: group:amount pairs, `|`-separated, amounts
// may use a comma decimal (01:22|02:12,50). No hashed PII rides these requests.

import { extractParams } from './params.js';

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const SALE_RE   = /^\/sread\.(img|php|js)$/;
const BASKET_RE = /^\/basket\.php$/;
const LANDING_RE = /^\/alt\.php$/;

export function isAwinHost(host) {
  const h = (host || '').toLowerCase();
  return /(^|\.)awin1\.com$/.test(h) || /(^|\.)dwin1\.com$/.test(h);
}

// A tracking endpoint on an Awin host, or on a whitelabel mirror domain that still
// carries the Awin sale signature (merchant/a + tv). Keeps whitelabel domains
// (e.g. awinblackfriday.com/sread.js) in scope without matching random sites.
function isAwinEndpoint(host, pathname, hasSig) {
  const known = SALE_RE.test(pathname) || BASKET_RE.test(pathname) || LANDING_RE.test(pathname);
  return known && (isAwinHost(host) || hasSig);
}

// ---------------------------------------------------------------------------
// Parsers per shape
// ---------------------------------------------------------------------------

const dec = (v) => { if (v == null) return null; try { return decodeURIComponent(v); } catch (e) { return v; } };

// Parse a money string that may use either a comma or a dot decimal, with or
// without a thousands separator. The rightmost separator is the decimal one;
// any other '.'/',' is grouping and is stripped. "1.234,56" and "1,234.56" both
// -> 1234.56; "12,50" -> 12.5; "49.90" -> 49.9. Returns NaN if not numeric.
export function toAmount(v) {
  if (v == null) return NaN;
  let s = String(v).trim();
  const lastComma = s.lastIndexOf(','), lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    const decSep = lastComma > lastDot ? ',' : '.';
    const grpSep = decSep === ',' ? '.' : ',';
    s = s.split(grpSep).join('').replace(decSep, '.');
  } else if (lastComma > -1) {
    s = s.replace(',', '.');   // lone comma -> decimal comma (the common EU case)
  }
  return parseFloat(s);
}

// "01:22|02:12,50" -> [{ group:'01', amount:'22' }, { group:'02', amount:'12,50' }]
export function parseAwinParts(s) {
  if (!s) return null;
  const out = s.split('|').filter(Boolean).map((g) => {
    const i = g.indexOf(':');
    return i < 0 ? { group: g, amount: null } : { group: g.slice(0, i), amount: g.slice(i + 1) };
  });
  return out.length ? out : null;
}

// product_line rows -> [{ id, name, price, quantity, sku, commissionGroup, category }]
export function parseAwinProducts(productLine) {
  if (!productLine) return null;
  const rows = productLine.split(/\r\n|\n|\r/).map((r) => r.trim()).filter((r) => r.indexOf('AW:P') === 0);
  const out = rows.map((r) => {
    const f = r.split('|');
    return {
      advertiserId: f[1] || null, orderRef: f[2] || null,
      id: f[3] || null, name: f[4] || null,
      price: f[5] || null, quantity: f[6] || null,
      sku: f[7] || null, commissionGroup: f[8] || null, category: f[9] || null,
    };
  });
  return out.length ? out : null;
}

function saleRecord(url, host, pathname, get, queryParams, bodyParams) {
  const merchant = get('merchant') || get('a');
  if (!merchant) return null;                            // an empty sread template, not a real fire

  const amount = get('amount') || get('b') || null;
  const currency = get('cr') || null;
  const orderRef = get('ref') || get('c') || null;
  const parts = get('parts') || get('d') || null;
  const voucher = get('vc') || null;
  const testRaw = get('testmode') || get('t') || null;
  const channel = get('ch') || null;
  const landing = dec(get('l'));
  const tt = get('tt') || null;                          // ns / ia / js / et — the transport variant

  return {
    provider: 'awin',
    shape: 'sale',
    transport: tt || 'sread',
    host, pathname, effectiveUrl: url, effectivePath: pathname, method: 'GET',
    merchantId: String(merchant),
    orderRef, channel, voucher: voucher || null,
    testMode: testRaw === '1' || testRaw === 'true',
    trackingType: tt, trackingVersion: get('tv') || null,
    clickChecksum: get('cks') || null,
    parts: parseAwinParts(parts),
    partsRaw: parts,
    revenue: amount != null && amount !== '' ? { value: String(amount), currency } : null,
    currency,
    pageUrl: landing || null,
    userData: null,
    identifiers: { email: 0, phone: 0, name: 0, address: 0 },
    // Fold the sale's transport mirrors (sread.img/php/js + whitelabel) into one card.
    _collapseKey: `awin:sale:${merchant}:${orderRef || ''}`,
    _transportLabel: `${host}${pathname}`,
    _transportRank: pathname === '/sread.php' ? 100 : (pathname === '/sread.js' ? 90 : 80),
    queryParams, bodyParams,
  };
}

function basketRecord(url, host, pathname, get, queryParams, bodyParams) {
  const productLine = dec(get('product_line'));
  const products = parseAwinProducts(productLine);
  if (!products) return null;                            // empty basket template, not a real fire

  const merchant = products[0].advertiserId || null;
  const orderRef = products[0].orderRef || null;
  // Derived basket total (Σ price×qty) — Awin sends no total on basket.php.
  let total = 0, haveTotal = true;
  for (const p of products) {
    const price = toAmount(p.price);
    const qty = toAmount(p.quantity);
    if (isNaN(price) || isNaN(qty)) { haveTotal = false; break; }
    total += price * qty;
  }

  return {
    provider: 'awin',
    shape: 'plt',
    transport: 'basket',
    host, pathname, effectiveUrl: url, effectivePath: pathname, method: 'GET',
    merchantId: merchant ? String(merchant) : null,
    orderRef,
    products,
    revenue: haveTotal ? { value: total.toFixed(2), currency: null, computed: true } : null,
    pageUrl: null,
    userData: null,
    identifiers: { email: 0, phone: 0, name: 0, address: 0 },
    queryParams, bodyParams,
  };
}

function landingRecord(url, host, pathname, get, queryParams, bodyParams) {
  const mid = get('mid');
  if (!mid) return null;                                 // empty alt.php template
  return {
    provider: 'awin',
    shape: 'landing',
    transport: 'alt',
    host, pathname, effectiveUrl: url, effectivePath: pathname, method: 'GET',
    merchantId: String(mid),
    orderRef: null,
    relayedUrl: dec(get('l')) || null,                   // alt.php relays the sread url
    version: get('gv') || null,
    revenue: null,
    pageUrl: null,
    userData: null,
    identifiers: { email: 0, phone: 0, name: 0, address: 0 },
    queryParams, bodyParams,
  };
}

// ---------------------------------------------------------------------------
// Full parse
// ---------------------------------------------------------------------------

export function parseAwinRequest(url, postData) {
  let host = '', pathname = '', search = null;
  try { const u = new URL(url); host = u.host; pathname = u.pathname; search = u.searchParams; }
  catch (e) { return null; }

  const hasSig = !!(search.get('merchant') || search.get('a')) && !!search.get('tv');
  if (!isAwinEndpoint(host, pathname, hasSig)) return null;

  const { queryParams, bodyParams } = extractParams(url, postData);
  const get = (k) => search.get(k);

  if (SALE_RE.test(pathname))    return saleRecord(url, host, pathname, get, queryParams, bodyParams);
  if (BASKET_RE.test(pathname))  return basketRecord(url, host, pathname, get, queryParams, bodyParams);
  if (LANDING_RE.test(pathname)) return landingRecord(url, host, pathname, get, queryParams, bodyParams);
  return null;
}
