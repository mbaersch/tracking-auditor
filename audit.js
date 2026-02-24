#!/usr/bin/env node

/**
 * audit.js – Automated tagging audit for consent and tracking verification
 *
 * Usage:
 *   node audit.js --url <startseite> --project <name> [options]
 *
 * Required:
 *   --url         Start page URL
 *   --project     Project name (determines report path)
 *
 * Optional:
 *   --cmp         CMP name (skips auto-detection if provided)
 *   --disable-sw  Deregister service workers via CDP
 *   --ecom        Interactive E-Commerce mode (navigate manually in browser)
 *
 * E-Commerce (--category activates the path):
 *   --category    Category page URL (relative or absolute)
 *   --product     Product page URL
 *   --add-to-cart CSS selector for Add-to-Cart button
 *   --view-cart   Cart page URL (skipped if not provided)
 *   --checkout    Checkout page URL (skipped if not provided)
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  showMessage, showClickPrompt, showSelectorResult,
  showTextInput, showConfirm, showCMPMatch, showCMPNameInput,
  showStatusBar, updateStatusBar, enableCMPSelect, removeStatusBar,
  showEcomStepPrompt, showEcomClickWait,
} from './browser-ui.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIBRARY_PATH = resolve(__dirname, 'cmp-library.json');

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const has = (flag) => args.indexOf(flag) !== -1;

const url       = get('--url');
const project   = get('--project');
const cmpFlag   = get('--cmp');
const disableSW = has('--disable-sw');
const ecomInteractive = has('--ecom');
const noPayloadAnalysis = has('--no-payload-analysis');

// E-Commerce (fix Git Bash path mangling for relative URLs)
const categoryUrl  = fixMangledPath(get('--category'), '--category');
const productUrl   = fixMangledPath(get('--product'), '--product');
const addToCartSel = get('--add-to-cart');
const viewCartUrl  = fixMangledPath(get('--view-cart'), '--view-cart');
const checkoutUrl  = fixMangledPath(get('--checkout'), '--checkout');

if (!url || !project) {
  console.error('Usage: node audit.js --url <url> --project <name> [--cmp <name>] [--disable-sw]');
  console.error('  E-Commerce: [--category <url>] [--product <url>] [--add-to-cart <sel>] [--view-cart <url>] [--checkout <url>]');
  console.error('  Interaktiv: [--ecom] (E-Commerce-Pfad manuell im Browser durchlaufen)');
  console.error('  Analyse: [--no-payload-analysis] (Deep Analysis deaktivieren)');
  process.exit(1);
}

// ── Git Bash path mangling protection ────────────────────────────────────────
// Git Bash on Windows converts CLI args starting with / to local paths
// e.g. /akkus-batterien/ → c:/Program Files/Git/akkus-batterien/
function fixMangledPath(value, flagName) {
  if (!value) return value;
  // Detect Git Bash mangling: drive letter followed by /Program Files/Git/ or similar
  const mangledRe = /^[a-zA-Z]:[\\/].*$/;
  if (mangledRe.test(value) && !value.startsWith('http://') && !value.startsWith('https://')) {
    // Try to recover: extract the part after the Git installation path
    const gitPrefixRe = /^[a-zA-Z]:[\\/](?:Program Files(?:\s*\(x86\))?[\\/]Git)?(.*)$/i;
    const match = value.match(gitPrefixRe);
    if (match) {
      const recovered = match[1].replace(/\\/g, '/');
      console.warn(`  WARNUNG: ${flagName} "${value}" sieht nach Git-Bash-Path-Mangling aus.`);
      console.warn(`  → Korrigiert zu "${recovered}"`);
      console.warn(`  Tipp: Volle URLs (https://...) verwenden oder MSYS_NO_PATHCONV=1 setzen.\n`);
      return recovered;
    }
  }
  return value;
}

// ── Tracking Domain Classification ────────────────────────────────────────────

const TRACKING_DOMAINS = {
  'Google':    ['google-analytics.com', 'googletagmanager.com', 'doubleclick.net', 'googleadservices.com', 'googlesyndication.com', 'googleads.g.doubleclick.net'],
  'Meta':      ['connect.facebook.net', 'facebook.com/tr', 'fbcdn.net'],
  'TikTok':    ['analytics.tiktok.com'],
  'Pinterest': ['ct.pinterest.com'],
  'LinkedIn':  ['snap.licdn.com', 'linkedin.com/px'],
  'Microsoft': ['bat.bing.com', 'clarity.ms'],
  'Criteo':    ['dis.criteo.com'],
  'Taboola':   ['trc.taboola.com'],
  'Outbrain':  ['outbrain.com'],
  'Hotjar':    ['hotjar.com', 'hotjar.io'],
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadLibrary() {
  if (!existsSync(LIBRARY_PATH)) return {};
  return JSON.parse(readFileSync(LIBRARY_PATH, 'utf-8'));
}

function saveLibrary(lib) {
  writeFileSync(LIBRARY_PATH, JSON.stringify(lib, null, 2), 'utf-8');
}

const INTERACTIVE_TAGS = ['BUTTON', 'A', 'INPUT', 'SELECT'];

function isPlausibleResult(result) {
  if (['div', 'span', 'section', 'aside'].includes(result.tag)) return false;
  if (INTERACTIVE_TAGS.includes(result.tag.toUpperCase())) return true;
  if (result.stableDataAttr) return true;
  return false;
}

function truncate(str, max = 80) {
  if (!str) return '';
  const s = String(str);
  return s.length > max ? s.slice(0, max) + '...' : s;
}

function resolveUrl(base, relative) {
  if (!relative) return null;
  try {
    const resolved = new URL(relative, base);
    const baseOrigin = new URL(base).origin;
    // Safety: resolved URL must share the same origin as the base URL
    if (resolved.origin !== baseOrigin) {
      console.warn(`  WARNUNG: "${relative}" löst zu fremdem Host auf: ${resolved.href}`);
      console.warn(`  → Erzwinge Basis-Origin: ${baseOrigin}`);
      // Re-attach the path to the correct origin
      return new URL(resolved.pathname + resolved.search + resolved.hash, baseOrigin).href;
    }
    return resolved.href;
  } catch {
    // Fallback: treat as path and prepend base origin
    try {
      const baseOrigin = new URL(base).origin;
      const safePath = relative.startsWith('/') ? relative : '/' + relative;
      console.warn(`  WARNUNG: "${relative}" konnte nicht aufgelöst werden, verwende ${baseOrigin}${safePath}`);
      return new URL(safePath, baseOrigin).href;
    } catch {
      return null;
    }
  }
}

function getHostname(urlStr) {
  try {
    return new URL(urlStr).hostname;
  } catch {
    return null;
  }
}

function getSiteDomain(urlStr) {
  const h = getHostname(urlStr);
  if (!h) return null;
  const parts = h.split('.');
  return parts.length >= 2 ? parts.slice(-2).join('.') : h;
}

/**
 * Determines the specific Google product from a request URL.
 * Returns 'GA4', 'Google Ads', 'Floodlight', 'Google Tag', or null.
 */
function getGoogleSubType(requestUrl) {
  try {
    const u = new URL(requestUrl);
    const host = u.hostname;
    const path = u.pathname;

    // GA4 Collect
    if (path.includes('/g/collect') || path.includes('/collect')) {
      const tid = u.searchParams.get('tid');
      if (tid && /^G-/i.test(tid)) return 'GA4';
    }

    // gtag/js loader – classify by ID prefix
    if (path.includes('/gtag/js')) {
      const id = u.searchParams.get('id');
      if (id) {
        if (/^G-/i.test(id)) return 'GA4';
        if (/^AW-/i.test(id)) return 'Google Ads';
        if (/^GT-/i.test(id)) return 'Google Tag';
        if (/^DC-/i.test(id)) return 'Floodlight';
      }
    }

    // Google Ads endpoints
    if (path.includes('/pagead/conversion') || path.includes('/pagead/1p-user-list')) return 'Google Ads';
    if (host === 'googleads.g.doubleclick.net') return 'Google Ads';
    if (host === 'www.googleadservices.com') return 'Google Ads';

    // Floodlight
    if ((host === 'ad.doubleclick.net' || host === 'fls.doubleclick.net') &&
        (path.startsWith('/activity') || path.includes('/activity;'))) return 'Floodlight';

    return null;
  } catch { return null; }
}

/**
 * Classify a request URL.
 * Returns { vendor, hostname, subType } for known trackers,
 * { vendor: 'Sonstige Third-Party', hostname, subType: null } for unknown third-party,
 * or null for same-domain.
 */
function classifyRequest(requestUrl, siteHost) {
  const hostname = getHostname(requestUrl);
  if (!hostname) return null;

  const siteDomain = getSiteDomain(siteHost);
  const reqDomain = getSiteDomain(requestUrl);

  // Same-domain → ignore
  if (reqDomain === siteDomain) return null;

  // Check known trackers
  for (const [vendor, domains] of Object.entries(TRACKING_DOMAINS)) {
    for (const d of domains) {
      // d can contain a path component (e.g. 'facebook.com/tr')
      // Check if the full URL contains the tracking domain pattern
      if (d.includes('/')) {
        try {
          const u = new URL(requestUrl);
          const check = u.hostname + u.pathname;
          if (check.includes(d)) {
            const subType = vendor === 'Google' ? getGoogleSubType(requestUrl) : null;
            return { vendor, hostname, subType };
          }
        } catch { /* ignore */ }
      } else {
        if (hostname === d || hostname.endsWith('.' + d)) {
          const subType = vendor === 'Google' ? getGoogleSubType(requestUrl) : null;
          return { vendor, hostname, subType };
        }
      }
    }
  }

  return { vendor: 'Sonstige Third-Party', hostname, subType: null };
}

/**
 * Extract Consent Mode parameters (gcs, gcd) from Google request URLs.
 */
function extractConsentModeParams(requests) {
  const params = [];
  for (const reqUrl of requests) {
    const hostname = getHostname(reqUrl);
    if (!hostname) continue;

    const isGoogle = TRACKING_DOMAINS['Google'].some(d =>
      hostname === d || hostname.endsWith('.' + d)
    );
    if (!isGoogle) continue;

    try {
      const u = new URL(reqUrl);
      const gcs = u.searchParams.get('gcs');
      const gcd = u.searchParams.get('gcd');
      if (gcs || gcd) {
        params.push({ url: truncate(reqUrl, 120), gcs: gcs || '-', gcd: gcd || '-' });
      }
    } catch { /* ignore */ }
  }
  return params;
}

/**
 * Deduplicate requests by vendor+hostname. Returns array of { vendor, hostnames, subTypes }.
 */
function deduplicateRequests(classified) {
  const map = new Map();
  for (const c of classified) {
    if (!c) continue;
    if (!map.has(c.vendor)) map.set(c.vendor, { hostnames: new Set(), subTypes: new Set() });
    const entry = map.get(c.vendor);
    entry.hostnames.add(c.hostname);
    if (c.subType) entry.subTypes.add(c.subType);
  }
  const result = [];
  for (const [vendor, { hostnames, subTypes }] of map.entries()) {
    result.push({ vendor, hostnames: [...hostnames], subTypes: [...subTypes] });
  }
  return result;
}

// ── Server-Side Tagging Detection ────────────────────────────────────────────

/**
 * Detect SST setups from raw request URLs.
 * Scans for GTM/gtag loaders on any host and GA4 first-party collect endpoints.
 */
function detectSSTFromUrls(requestUrls, siteHost) {
  const siteDomain = getSiteDomain(siteHost);
  const loaders = [];
  const collectEndpoints = [];
  const containers = new Set();
  const measurementIds = new Set();
  const seenLoaders = new Set();
  const seenCollects = new Set();

  for (const reqUrl of requestUrls) {
    let u;
    try { u = new URL(reqUrl); } catch { continue; }

    const host = u.hostname;
    const path = u.pathname;
    const isFirstParty = getSiteDomain(reqUrl) === siteDomain;
    const isStandardHost = host === 'www.googletagmanager.com' || host === 'googletagmanager.com';

    // GTM Loader: /gtm.js with id=GTM-XXX
    if (path.endsWith('/gtm.js') || path.includes('/gtm.js')) {
      const id = u.searchParams.get('id');
      if (id && /^GTM-[A-Z0-9]+$/i.test(id)) {
        const key = `gtm|${host}|${id}`;
        if (!seenLoaders.has(key)) {
          seenLoaders.add(key);
          containers.add(id.toUpperCase());
          loaders.push({
            type: 'GTM',
            host,
            path: path + u.search,
            id,
            isStandard: isStandardHost,
            isFirstParty,
          });
        }
      }
    }

    // gtag Loader: /gtag/js with id=G-XXX
    if (path.includes('/gtag/js')) {
      const id = u.searchParams.get('id');
      if (id && /^G-[A-Z0-9]+$/i.test(id)) {
        const key = `gtag|${host}|${id}`;
        if (!seenLoaders.has(key)) {
          seenLoaders.add(key);
          measurementIds.add(id.toUpperCase());
          loaders.push({
            type: 'gtag',
            host,
            path: path + u.search,
            id,
            isStandard: isStandardHost,
            isFirstParty,
          });
        }
      }
    }

    // GA4 First-Party Collect: same-domain /g/collect or /collect with v=2 + tid=G-XXX
    if (isFirstParty && (path.includes('/g/collect') || path.includes('/collect'))) {
      const tid = u.searchParams.get('tid');
      const v = u.searchParams.get('v');
      if (tid && /^G-[A-Z0-9]+$/i.test(tid) && v === '2') {
        const key = `${host}|${tid}`;
        if (!seenCollects.has(key)) {
          seenCollects.add(key);
          measurementIds.add(tid.toUpperCase());
          collectEndpoints.push({ host, path, tid });
        }
      }
    }
  }

  return { containers, measurementIds, loaders, collectEndpoints };
}

/**
 * Scan first-party JS response bodies for GTM/gtag fingerprints.
 * Skips files already identified as loaders by URL pattern.
 */
function detectSSTFromResponseBodies(responseBodies, siteHost) {
  const results = [];
  const gtmIdRe = /GTM-[A-Z0-9]{5,}/gi;
  const gTagIdRe = /G-[A-Z0-9]{5,}/gi;

  for (const { url, body } of responseBodies) {
    if (!body) continue;

    // Skip known loader URLs
    try {
      const u = new URL(url);
      if (u.pathname.includes('/gtm.js') || u.pathname.includes('/gtag/js')) continue;
    } catch { continue; }

    const fingerprints = [];
    const hasGtmRef = body.includes('googletagmanager');
    const hasGtagCall = body.includes('gtag(');

    if (hasGtmRef) {
      const ids = [...body.matchAll(gtmIdRe)].map(m => m[0].toUpperCase());
      const unique = [...new Set(ids)];
      if (unique.length > 0) {
        fingerprints.push({ type: 'GTM Container Code', ids: unique });
      }
    }

    if (hasGtagCall) {
      const ids = [...body.matchAll(gTagIdRe)].map(m => m[0].toUpperCase());
      const unique = [...new Set(ids)];
      if (unique.length > 0) {
        fingerprints.push({ type: 'gtag Code', ids: unique });
      }
    }

    if (fingerprints.length > 0) {
      results.push({ url, fingerprints });
    }
  }

  return results;
}

/**
 * Merge SST results from multiple phases (deduplicated).
 */
function mergeSST(...sstResults) {
  const containers = new Set();
  const measurementIds = new Set();
  const loaderMap = new Map();
  const collectMap = new Map();

  for (const r of sstResults) {
    if (!r) continue;
    for (const c of r.containers) containers.add(c);
    for (const m of r.measurementIds) measurementIds.add(m);
    for (const l of r.loaders) {
      const key = `${l.type}|${l.host}|${l.id}`;
      if (!loaderMap.has(key)) loaderMap.set(key, l);
    }
    for (const e of r.collectEndpoints) {
      const key = `${e.host}|${e.tid}`;
      if (!collectMap.has(key)) collectMap.set(key, e);
    }
  }

  return {
    containers,
    measurementIds,
    loaders: [...loaderMap.values()],
    collectEndpoints: [...collectMap.values()],
    customLoaders: [],
  };
}

/**
 * Check if any SST indicators were detected.
 */
function hasSSTDetected(sstData) {
  if (!sstData) return false;
  const hasCustomLoader = sstData.loaders.some(l => !l.isStandard);
  const hasCollect = sstData.collectEndpoints.length > 0;
  const hasCustomFromBody = sstData.customLoaders && sstData.customLoaders.length > 0;
  return hasCustomLoader || hasCollect || hasCustomFromBody;
}

// ── E-Commerce Product Analysis ──────────────────────────────────────────────

const EXPECTED_EVENTS = {
  'Kategorie-Seite': ['view_item_list', 'view_product_list', 'productList', 'impressions'],
  'Produkt-Seite': ['view_item', 'view_product', 'detail', 'productDetail'],
  'Add-to-Cart': ['add_to_cart', 'addToCart', 'added_to_cart', 'add'],
  'Warenkorb': ['view_cart', 'cart', 'basket'],
  'Checkout': ['begin_checkout', 'checkout', 'checkoutStep'],
};

/**
 * Check if an object looks like a product (has identifier + price).
 */
function isProductLike(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const keys = Object.keys(obj).map(k => k.toLowerCase());
  const hasIdentifier = keys.some(k =>
    ['id', 'item_id', 'product_id', 'sku', 'name', 'item_name', 'product_name', 'title'].includes(k)
  );
  const hasPrice = keys.some(k => ['price', 'item_price', 'product_price'].includes(k));
  return hasIdentifier && hasPrice;
}

/**
 * Recursively scan an object for product arrays (up to maxDepth levels).
 * Handles wrappers like entry.value.data.products.
 */
function findProductArray(obj, maxDepth, currentPath = '') {
  if (maxDepth <= 0 || !obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const productKeys = ['products', 'items', 'product', 'cart_data', 'cart_items', 'order_items'];

  for (const key of Object.keys(obj)) {
    const val = obj[key];
    const path = currentPath ? `${currentPath}.${key}` : key;

    if (productKeys.includes(key.toLowerCase())) {
      if (Array.isArray(val) && val.length > 0 && isProductLike(val[0])) {
        return { products: val, path };
      }
      if (isProductLike(val)) {
        return { products: [val], path };
      }
    }

    if (val && typeof val === 'object') {
      const result = findProductArray(val, maxDepth - 1, path);
      if (result) return result;
    }
  }

  return null;
}

/**
 * Detect E-Commerce data format in a dataLayer entry.
 * Returns { format, products, event, path } or null.
 */
function detectEcomFormat(dlEntry) {
  if (!dlEntry || typeof dlEntry !== 'object') return null;

  // GA4: entry.ecommerce.items is array
  if (dlEntry.ecommerce && Array.isArray(dlEntry.ecommerce.items) && dlEntry.ecommerce.items.length > 0) {
    return { format: 'ga4', products: dlEntry.ecommerce.items, event: dlEntry.event || null, path: 'ecommerce.items' };
  }

  // UA: entry.ecommerce.{action}.products is array
  if (dlEntry.ecommerce) {
    for (const action of ['detail', 'add', 'checkout', 'purchase', 'click', 'remove']) {
      if (dlEntry.ecommerce[action] && Array.isArray(dlEntry.ecommerce[action].products) && dlEntry.ecommerce[action].products.length > 0) {
        return { format: 'ua', products: dlEntry.ecommerce[action].products, event: dlEntry.event || null, path: `ecommerce.${action}.products` };
      }
    }
    // UA impressions: ecommerce.impressions is directly an array (not .products)
    if (Array.isArray(dlEntry.ecommerce.impressions) && dlEntry.ecommerce.impressions.length > 0 && isProductLike(dlEntry.ecommerce.impressions[0])) {
      return { format: 'ua', products: dlEntry.ecommerce.impressions, event: dlEntry.event || null, path: 'ecommerce.impressions' };
    }
  }

  // Proprietary: recursive scan up to depth 4 (catches value.data.products etc.)
  const found = findProductArray(dlEntry, 4);
  if (found) {
    return { format: 'proprietary', products: found.products, event: dlEntry.event || null, path: found.path };
  }

  return null;
}

/**
 * Normalize a product object to a common schema.
 */
function normalizeProduct(product) {
  if (!product || typeof product !== 'object') return null;

  const get = (...keys) => {
    for (const k of keys) {
      if (product[k] !== undefined && product[k] !== null && product[k] !== '') return String(product[k]);
    }
    return null;
  };

  return {
    id: get('id', 'item_id', 'product_id', 'sku'),
    name: get('name', 'item_name', 'product_name', 'title'),
    price: get('price', 'item_price', 'product_price'),
    brand: get('brand', 'item_brand', 'product_brand'),
    category: get('category', 'item_category', 'product_category'),
    variant: get('variant', 'item_variant', 'product_variant'),
    quantity: get('quantity', 'item_quantity', 'qty'),
  };
}

/**
 * Analyze product data consistency across E-Commerce steps.
 */
function analyzeEcommerceProducts(ecomSteps) {
  const stepProducts = [];

  for (const step of ecomSteps) {
    const products = [];
    let format = null;
    let formatPath = null;

    for (const entry of step.dataLayerDiff) {
      const detected = detectEcomFormat(entry);
      if (detected) {
        format = format || detected.format;
        formatPath = formatPath || detected.path;
        for (const p of detected.products) {
          products.push({
            normalized: normalizeProduct(p),
            event: detected.event,
            format: detected.format,
          });
        }
      }
    }

    stepProducts.push({ name: step.name, products, format, formatPath });
  }

  // Determine primary format
  const formats = stepProducts.map(s => s.format).filter(Boolean);
  const primaryFormat = formats.length > 0 ? formats[0] : null;
  const formatPath = stepProducts.find(s => s.formatPath)?.formatPath || null;

  // Find focus product: prefer single-product events (view_product, view_item, detail)
  // over list events (view_product_list, view_item_list) since lists contain cross-sells
  let focusProduct = null;
  const pdpStep = stepProducts.find(s => s.name === 'Produkt-Seite');
  const atcStep = stepProducts.find(s => s.name === 'Add-to-Cart');
  const singleProductEvents = ['view_product', 'view_item', 'detail', 'productDetail'];

  if (pdpStep && pdpStep.products.length > 0) {
    const singleProduct = pdpStep.products.find(p =>
      p.event && singleProductEvents.some(e => p.event.toLowerCase() === e.toLowerCase())
    );
    focusProduct = singleProduct ? singleProduct.normalized : pdpStep.products[0].normalized;
  }
  if (!focusProduct && atcStep && atcStep.products.length > 0) {
    focusProduct = atcStep.products[0].normalized;
  }

  // Check for missing expected events per step
  const missingEvents = [];
  for (const step of stepProducts) {
    const expected = EXPECTED_EVENTS[step.name];
    if (!expected) continue;

    const actualEvents = step.products.map(p => p.event).filter(Boolean);
    const hasExpected = expected.some(e =>
      actualEvents.some(a => a.toLowerCase() === e.toLowerCase())
    );

    if (!hasExpected && step.products.length === 0) {
      missingEvents.push({ step: step.name, expected });
    }
  }

  // Consistency check across steps
  const consistency = { stepsWithProduct: [], consistentProps: [], inconsistentProps: [] };
  if (focusProduct && focusProduct.id) {
    const properties = ['id', 'name', 'price', 'brand', 'category', 'variant'];

    for (const step of stepProducts) {
      const match = step.products.find(p => p.normalized.id === focusProduct.id);
      if (match) {
        consistency.stepsWithProduct.push({ name: step.name, product: match.normalized });
      }
    }

    for (const prop of properties) {
      if (!focusProduct[prop]) continue;

      const values = consistency.stepsWithProduct
        .filter(s => s.product[prop])
        .map(s => ({ step: s.name, value: s.product[prop] }));

      if (values.length <= 1) continue;

      if (values.every(v => v.value === values[0].value)) {
        consistency.consistentProps.push(prop);
      } else {
        consistency.inconsistentProps.push({ prop, values });
      }
    }
  }

  return { format: primaryFormat, formatPath, focusProduct, stepProducts, missingEvents, consistency };
}

/**
 * Collect cookies from a browser context.
 */
async function collectCookies(context) {
  const cookies = await context.cookies();
  return cookies.map(c => ({
    name: c.name,
    domain: c.domain,
    value: truncate(c.value),
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: c.sameSite,
  }));
}

/**
 * Collect localStorage from a page.
 */
async function collectLocalStorage(page) {
  try {
    return await page.evaluate(() => {
      const items = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        items[key] = localStorage.getItem(key);
      }
      return items;
    });
  } catch {
    return {};
  }
}

/**
 * Diff cookies: return only those in `after` that are not in `before` (by name+domain).
 */
function diffCookies(before, after) {
  const beforeKeys = new Set(before.map(c => `${c.name}||${c.domain}`));
  return after.filter(c => !beforeKeys.has(`${c.name}||${c.domain}`));
}

/**
 * Diff localStorage: return only those keys in `after` that are not in `before`.
 */
function diffLocalStorage(before, after) {
  const diff = {};
  for (const [key, val] of Object.entries(after)) {
    if (!(key in before)) {
      diff[key] = val;
    }
  }
  return diff;
}

/**
 * Collect dataLayer snapshot from page.
 */
async function collectDataLayer(page) {
  try {
    return await page.evaluate(() => window.dataLayer || []);
  } catch {
    return [];
  }
}

/**
 * Diff dataLayer: entries in `after` that were not in `before` (by index, since dataLayer is append-only).
 */
function diffDataLayer(before, after) {
  return after.slice(before.length);
}

/**
 * Check for service workers on the page.
 */
async function checkServiceWorkers(page) {
  try {
    return await page.evaluate(() => {
      if (!navigator.serviceWorker) return [];
      return navigator.serviceWorker.getRegistrations().then(regs =>
        regs.map(r => r.scope)
      );
    });
  } catch {
    return [];
  }
}

/**
 * Deregister all service workers.
 */
async function deregisterServiceWorkers(page) {
  try {
    await page.evaluate(() => {
      if (!navigator.serviceWorker) return;
      return navigator.serviceWorker.getRegistrations().then(regs =>
        Promise.all(regs.map(r => r.unregister()))
      );
    });
  } catch { /* ignore */ }
}

/**
 * Set up request collection on a page. Returns a getter function for collected URLs.
 */
function setupRequestCollector(page) {
  const requests = [];
  page.on('request', (req) => {
    requests.push({
      url: req.url(),
      method: req.method(),
      postData: req.method() === 'POST' ? (req.postData() || null) : null,
    });
  });
  // Backward-compatible: calling the function returns URL array
  const getUrls = () => requests.map(r => r.url);
  // .full() returns enriched objects for payload analysis
  getUrls.full = () => [...requests];
  // .clear() resets the buffer (used for discard-and-restart patterns)
  getUrls.clear = () => { requests.length = 0; };
  return getUrls;
}

/**
 * Set up response body collection for first-party JS resources.
 * Returns an async getter that resolves to [{ url, body }].
 */
function setupResponseBodyCollector(page, siteHost) {
  const siteDomain = getSiteDomain(siteHost);
  const pending = [];

  page.on('response', (response) => {
    const reqUrl = response.url();
    const reqDomain = getSiteDomain(reqUrl);
    if (reqDomain !== siteDomain) return;

    const contentType = response.headers()['content-type'] || '';
    const isJS = contentType.includes('javascript') || contentType.includes('ecmascript');
    let isJSExt = false;
    try { isJSExt = new URL(reqUrl).pathname.endsWith('.js'); } catch {}

    if (!isJS && !isJSExt) return;

    const bodyPromise = response.body()
      .then(buf => {
        if (buf.length > 500 * 1024) return null; // skip >500KB
        return { url: reqUrl, body: buf.toString('utf-8') };
      })
      .catch(() => null);

    pending.push(bodyPromise);
  });

  return async () => {
    const results = await Promise.all(pending);
    return results.filter(Boolean);
  };
}

/**
 * Listens for CSP violations via securitypolicyviolation events.
 * Uses addInitScript to survive navigations.
 * Returns getter for accumulated violations.
 */
async function setupCSPViolationCollector(page) {
  const violations = [];
  await page.exposeFunction('__reportCSPViolation', (blockedURI, violatedDirective, effectiveDirective) => {
    violations.push({ blockedURI, violatedDirective, effectiveDirective });
  });
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      try {
        window.__reportCSPViolation(
          e.blockedURI || '',
          e.violatedDirective || '',
          e.effectiveDirective || '',
        );
      } catch { /* page context may be torn down */ }
    });
  });
  return () => [...violations];
}

/**
 * Wait for network to settle (approximation: wait fixed time after load).
 */
async function waitForSettle(page, ms = 3000) {
  await page.waitForTimeout(ms);
}

// ── CMP Detection ─────────────────────────────────────────────────────────────

async function tryCMPSelectors(page, library, { onProgress, signal } = {}) {
  const matches = [];
  const entries = Object.entries(library);
  const total = entries.length;
  for (let i = 0; i < total; i++) {
    if (signal?.skipped) return matches;
    const [key, entry] = entries[i];
    if (onProgress) onProgress(i + 1, total, entry.name || key);
    try {
      await page.locator(entry.accept).first().waitFor({ state: 'visible', timeout: 3000 });
      matches.push({ key, ...entry });
    } catch { /* not found, try next */ }
  }
  return matches;
}

async function disambiguateCMP(page, matches) {
  if (matches.length === 0) return null;
  if (matches.length === 1) {
    console.log(`  CMP erkannt: ${matches[0].name} (${matches[0].key})`);
    return matches[0];
  }

  // Mehrere CMPs matchen auf accept – detect-Selektoren prüfen
  console.log(`  ${matches.length} CMPs matchen: ${matches.map(m => m.name).join(', ')}`);
  console.log('  Disambiguierung via detect-Selektoren...');

  for (const match of matches) {
    if (!match.detect || !Array.isArray(match.detect)) continue;
    for (const selector of match.detect) {
      try {
        const count = await page.locator(selector).count();
        if (count > 0) {
          console.log(`  CMP eindeutig: ${match.name} (${match.key}) via detect "${selector}"`);
          return match;
        }
      } catch { /* selector invalid or not found */ }
    }
  }

  // Fallback: ersten Match nehmen
  console.log(`  WARNUNG: Keine detect-Disambiguierung möglich, verwende ersten Match: ${matches[0].name}`);
  return matches[0];
}

async function detectCMP(page, library) {
  // Signal object for CMP select – shared across all passes
  const signal = { skipped: false };

  // Sort library by priority (lower = first, no priority = Infinity)
  const sortedLibrary = Object.fromEntries(
    Object.entries(library).sort(([, a], [, b]) =>
      (a.priority ?? Infinity) - (b.priority ?? Infinity)
    )
  );

  // Build alphabetically sorted CMP list for the dropdown
  const cmpEntries = Object.entries(library)
    .map(([key, entry]) => ({ key, name: entry.name || key }))
    .sort((a, b) => a.name.localeCompare(b.name));

  // Enable CMP select UI and set up race
  let userChoice = null;
  const selectPromise = enableCMPSelect(page, cmpEntries).then((result) => {
    signal.skipped = true;
    userChoice = result;
  });

  const onProgress = (current, total, name) => {
    updateStatusBar(page, 'Phase 0', `CMP ${current}/${total}: ${name}`, 'Auto-Erkennung...').catch(() => {});
  };

  // Erster Durchlauf (nach Prioritaet sortiert)
  let matches = await tryCMPSelectors(page, sortedLibrary, { onProgress, signal });
  if (signal.skipped) {
    if (userChoice.type === 'select') {
      console.log(`  CMP manuell gewählt: ${library[userChoice.key].name}`);
      return { key: userChoice.key, ...library[userChoice.key] };
    }
    return null; // manual mode
  }
  let result = await disambiguateCMP(page, matches);
  if (result) return result;

  // Scroll-Retry: manche CMPs (z.B. Borlabs) erscheinen erst nach Scroll
  console.log('  Kein CMP-Banner gefunden, versuche Scroll...');
  await updateStatusBar(page, 'Phase 0', 'Scroll-Retry...', 'Kein Banner beim 1. Durchlauf');
  await page.evaluate(() => window.scrollBy(0, 400));
  await page.waitForTimeout(2000);
  if (signal.skipped) {
    if (userChoice.type === 'select') {
      console.log(`  CMP manuell gewählt: ${library[userChoice.key].name}`);
      return { key: userChoice.key, ...library[userChoice.key] };
    }
    return null; // manual mode
  }

  matches = await tryCMPSelectors(page, sortedLibrary, { onProgress, signal });
  if (signal.skipped) {
    if (userChoice.type === 'select') {
      console.log(`  CMP manuell gewählt: ${library[userChoice.key].name}`);
      return { key: userChoice.key, ...library[userChoice.key] };
    }
    return null; // manual mode
  }
  result = await disambiguateCMP(page, matches);
  if (result) console.log('  CMP nach Scroll erkannt!');
  return result;
}

// ── Emergency CMP Learning (Manueller Modus) ────────────────────────────────────────

/**
 * Interactive fallback when CMP auto-detection fails.
 * Uses browser overlays to let the user click accept/reject buttons,
 * matches against library, and optionally saves a new CMP entry.
 * Returns a cmp object compatible with the normal flow.
 */
async function emergencyLearnCMP(page, library) {
  console.log('  Manueller Modus: CMP einlernen...');

  await updateStatusBar(page, 'Manuell', 'CMP manuell einlernen...', '');

  await showMessage(page, 'CMP nicht automatisch erkannt. Manueller Modus aktiv – bitte Accept- und Reject-Button manuell klicken.', {
    type: 'warning', title: 'Manuell',
  });

  // ── Learn Accept ──
  await updateStatusBar(page, 'Manuell', 'Warte auf Accept-Klick...', '');
  const acceptResult = await showClickPrompt(page, 'ACCEPT');
  let acceptSelector;

  if (!acceptResult || !isPlausibleResult(acceptResult)) {
    // Shadow DOM fallback
    if (acceptResult) {
      await showMessage(page, `Klick landete auf <${acceptResult.tag}> – vermutlich Shadow DOM. Bitte Selektor manuell eingeben.`, { type: 'warning' });
    }
    acceptSelector = await showTextInput(page, 'Accept-Selektor eingeben');
  } else {
    const { confirmed } = await showSelectorResult(page, acceptResult, 'ACCEPT');
    if (confirmed) {
      acceptSelector = acceptResult.selector;
    } else {
      acceptSelector = await showTextInput(page, 'Accept-Selektor eingeben');
    }
  }

  // ── Learn Reject ──
  // Fresh context needed – the accept click may have dismissed the banner
  await updateStatusBar(page, 'Manuell', 'Accept OK – Seite wird neu geladen...', '');
  await showMessage(page, 'Accept-Selektor gespeichert. Seite wird neu geladen fuer den Reject-Button.', { type: 'info' });

  const currentUrl = page.url();
  const context = page.context();
  await context.clearCookies();
  // Use domcontentloaded instead of networkidle to avoid hanging on slow sites
  await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(3000);

  // Re-inject status bar after navigation (page.goto destroys injected DOM)
  await showStatusBar(page, 'Manuell', 'Warte auf Reject-Klick...', '');

  // Scroll-retry for banner visibility
  try {
    await page.locator(acceptSelector).first().waitFor({ state: 'visible', timeout: 3000 });
  } catch {
    await page.evaluate(() => window.scrollBy(0, 400));
    await page.waitForTimeout(2000);
  }

  const rejectResult = await showClickPrompt(page, 'REJECT');
  let rejectSelector;

  if (!rejectResult || !isPlausibleResult(rejectResult)) {
    if (rejectResult) {
      await showMessage(page, `Klick landete auf <${rejectResult.tag}> – vermutlich Shadow DOM. Bitte Selektor manuell eingeben.`, { type: 'warning' });
    }
    rejectSelector = await showTextInput(page, 'Reject-Selektor eingeben');
  } else {
    const { confirmed } = await showSelectorResult(page, rejectResult, 'REJECT');
    if (confirmed) {
      rejectSelector = rejectResult.selector;
    } else {
      rejectSelector = await showTextInput(page, 'Reject-Selektor eingeben');
    }
  }

  // ── Library matching ──
  for (const [key, entry] of Object.entries(library)) {
    if (entry.accept === acceptSelector || entry.reject === rejectSelector) {
      const { useExisting } = await showCMPMatch(page, { key, ...entry });
      if (useExisting) {
        console.log(`  Manuell: Verwende bestehendes CMP "${entry.name}" aus Library`);
        await context.clearCookies();
        await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await page.waitForTimeout(3000);
        return { key, ...entry };
      }
    }
  }

  // ── Save new CMP ──
  const cmpName = await showCMPNameInput(page);
  const key = cmpName.toLowerCase().replace(/\s+/g, '-');

  const newEntry = {
    name: cmpName,
    accept: acceptSelector,
    reject: rejectSelector,
    shadowDom: false,
    learnedAt: new Date().toISOString(),
  };

  library[key] = newEntry;
  saveLibrary(library);
  console.log(`  Manuell: Neues CMP "${cmpName}" in Library gespeichert`);

  await showMessage(page, `CMP "${cmpName}" gespeichert. Audit wird fortgesetzt.`, { type: 'info', title: 'Manuell' });

  // Reload page with clean cookies for the normal audit flow
  await context.clearCookies();
  await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
  await page.waitForTimeout(3000);

  return { key, ...newEntry };
}

// ── Consent Mode Transition Analysis ─────────────────────────────────────────

/**
 * Analyze Consent Mode gcs transition across phases.
 * Returns { preGcs, postGcs, ecomGcs[], status }
 *   status: 'update_ok' | 'no_update' | 'no_consent_mode' | 'ecom_stale'
 */
function analyzeConsentModeTransition(reportData) {
  const preParams = reportData.preConsent.consentMode || [];
  const postParams = reportData.postAccept.consentMode || [];

  const preGcs = preParams.length > 0 ? preParams[0].gcs : null;
  const postGcs = postParams.length > 0 ? postParams[0].gcs : null;

  // Collect E-Commerce gcs values
  const ecomGcs = [];
  if (reportData.ecommerce) {
    for (const step of reportData.ecommerce) {
      if (step.consentMode && step.consentMode.length > 0) {
        ecomGcs.push({ step: step.name, gcs: step.consentMode[0].gcs });
      }
    }
  }

  // No consent mode at all
  if (!preGcs || preGcs === '-') {
    return { preGcs, postGcs, ecomGcs, status: 'no_consent_mode' };
  }

  // Check if post-accept shows an update (G100 → G1xx where at least one digit changed)
  if (!postGcs || postGcs === '-' || postGcs === preGcs) {
    return { preGcs, postGcs, ecomGcs, status: 'no_update' };
  }

  // Post-accept updated – check E-Commerce steps for stale values
  const hasStaleEcom = ecomGcs.some(e => e.gcs === preGcs);
  if (hasStaleEcom) {
    return { preGcs, postGcs, ecomGcs, status: 'ecom_stale' };
  }

  return { preGcs, postGcs, ecomGcs, status: 'update_ok' };
}

// ── Report Generation ─────────────────────────────────────────────────────────

function formatCookieTable(cookies) {
  if (!cookies.length) return '_Keine Cookies._\n';
  let md = '| Name | Domain | Value | httpOnly | secure | sameSite |\n';
  md += '|------|--------|-------|----------|--------|----------|\n';
  for (const c of cookies) {
    md += `| ${c.name} | ${c.domain} | \`${truncate(c.value, 60)}\` | ${c.httpOnly} | ${c.secure} | ${c.sameSite} |\n`;
  }
  return md;
}

function formatLocalStorageTable(ls) {
  const entries = Object.entries(ls);
  if (!entries.length) return '_Kein localStorage._\n';
  let md = '| Key | Value |\n';
  md += '|-----|-------|\n';
  for (const [key, val] of entries) {
    md += `| ${key} | \`${truncate(val, 60)}\` |\n`;
  }
  return md;
}

function formatDataLayer(dl) {
  if (!dl.length) return '_dataLayer leer oder nicht vorhanden._\n';
  let md = '```json\n';
  for (const entry of dl) {
    md += JSON.stringify(entry, null, 2) + '\n';
  }
  md += '```\n';
  return md;
}

function formatTrackerSection(deduped) {
  const known = deduped.filter(d => d.vendor !== 'Sonstige Third-Party');
  const other = deduped.filter(d => d.vendor === 'Sonstige Third-Party');

  let md = '';

  md += '#### Bekannte Tracker\n\n';
  if (!known.length) {
    md += '_Keine bekannten Tracker._\n\n';
  } else {
    md += '| Vendor | Hostnames |\n';
    md += '|--------|-----------|\n';
    for (const d of known) {
      md += `| ${d.vendor} | ${d.hostnames.join(', ')} |\n`;
    }
    md += '\n';
  }

  md += '#### Sonstige Third-Party\n\n';
  if (!other.length) {
    md += '_Keine sonstigen Third-Party Requests._\n\n';
  } else {
    md += '| Hostnames |\n';
    md += '|-----------|\n';
    for (const d of other) {
      for (const h of d.hostnames) {
        md += `| ${h} |\n`;
      }
    }
    md += '\n';
  }

  return md;
}

function formatConsentMode(params) {
  if (!params.length) return '_Keine Consent Mode Parameter gefunden._\n';
  let md = '| gcs | gcd | Request URL |\n';
  md += '|-----|-----|-------------|\n';
  for (const p of params) {
    md += `| ${p.gcs} | ${p.gcd} | \`${p.url}\` |\n`;
  }
  return md;
}

function formatSSTSection(sstData) {
  if (!sstData || !hasSSTDetected(sstData)) return '';

  let md = '## Server-Side Tagging Analyse\n\n';

  // Container IDs
  if (sstData.containers.size > 0) {
    const customLoaders = sstData.loaders.filter(l => !l.isStandard && l.type === 'GTM');
    for (const id of sstData.containers) {
      const loader = customLoaders.find(l => l.id.toUpperCase() === id);
      if (loader) {
        md += `**GTM Container:** ${id} (geladen von \`${loader.host}${loader.path.split('?')[0]}\`)\n\n`;
      } else {
        md += `**GTM Container:** ${id}\n\n`;
      }
    }
  }

  // Loader table
  if (sstData.loaders.length > 0) {
    md += '**Loader:**\n\n';
    md += '| Typ | Host | Pfad | Standard? |\n';
    md += '|-----|------|------|-----------|\n';
    for (const l of sstData.loaders) {
      const standard = l.isStandard ? 'Standard' : 'Custom (First-Party)';
      md += `| ${l.type} | ${l.host} | \`${truncate(l.path, 60)}\` | ${standard} |\n`;
    }
    md += '\n';
  }

  // Collect endpoints table
  if (sstData.collectEndpoints.length > 0) {
    md += '**Collect Endpoints:**\n\n';
    md += '| Endpoint | Host | Pfad | Measurement ID |\n';
    md += '|----------|------|------|----------------|\n';
    for (const e of sstData.collectEndpoints) {
      md += `| GA4 Collect | ${e.host} | ${e.path} | ${e.tid} |\n`;
    }
    md += '\n';
  }

  // Custom loaders from response body analysis
  if (sstData.customLoaders && sstData.customLoaders.length > 0) {
    md += '**Custom Loader (Response-Analyse):**\n\n';
    for (const cl of sstData.customLoaders) {
      for (const fp of cl.fingerprints) {
        md += `- \`${cl.url}\` enthaelt ${fp.type} (${fp.ids.join(', ')})\n`;
      }
    }
    md += '\n';
  }

  return md;
}

function formatProductAnalysis(analysis) {
  if (!analysis || !analysis.format) return '';

  let md = '### Produktdaten-Analyse\n\n';

  // Format
  const formatLabels = {
    ga4: 'GA4 (`ecommerce.items[]`)',
    ua: 'Universal Analytics (`ecommerce.{action}.products[]`)',
    proprietary: `Proprietary (\`${analysis.formatPath || 'custom'}\`)`,
  };
  md += `**Format:** ${formatLabels[analysis.format] || analysis.format}\n\n`;

  // Focus product
  if (analysis.focusProduct) {
    const fp = analysis.focusProduct;
    const label = [fp.id, fp.name].filter(Boolean).join(' – ');
    md += `**Fokus-Produkt:** ID ${label || '_unbekannt_'}\n\n`;

    // Consistency table across steps
    const stepsWithData = analysis.stepProducts.filter(s => s.products.length > 0);
    if (stepsWithData.length > 0) {
      const properties = ['id', 'name', 'price', 'brand', 'category', 'variant', 'quantity'];
      const stepNames = stepsWithData.map(s => s.name);

      md += '| Eigenschaft | ' + stepNames.join(' | ') + ' |\n';
      md += '|-------------|' + stepNames.map(() => '---').join('|') + '|\n';

      for (const prop of properties) {
        const values = stepsWithData.map(s => {
          const match = s.products.find(p => p.normalized.id === fp.id);
          return match ? (match.normalized[prop] || '–') : '–';
        });
        if (values.some(v => v !== '–')) {
          md += `| ${prop} | ${values.map(v => truncate(String(v), 40)).join(' | ')} |\n`;
        }
      }
      md += '\n';
    }
  } else {
    md += '**Fokus-Produkt:** _Kein Produkt über mehrere Schritte identifizierbar._\n\n';
  }

  // Missing events
  if (analysis.missingEvents.length > 0) {
    md += '**Fehlende Events:**\n\n';
    for (const m of analysis.missingEvents) {
      md += `- ${m.step}: Kein \`${m.expected[0]}\` Event gefunden\n`;
    }
    md += '\n';
  }

  // Consistency summary
  const c = analysis.consistency;
  if (c.stepsWithProduct.length > 1) {
    const stepsInvolved = c.stepsWithProduct.map(s => s.name).join(' → ');
    if (c.consistentProps.length > 0) {
      md += `**Konsistenz:** ${c.consistentProps.join(', ')} stimmen über ${stepsInvolved} überein.\n`;
    }
    if (c.inconsistentProps.length > 0) {
      md += '\n**Inkonsistenzen:**\n\n';
      for (const inc of c.inconsistentProps) {
        const details = inc.values.map(v => `${v.step}: "${v.value}"`).join(', ');
        md += `- **${inc.prop}**: ${details}\n`;
      }
    }
    md += '\n';
  }

  return md;
}

function generateTLDR(data) {
  let md = '## Zusammenfassung\n\n';

  // Consent Mode parameters
  const preGcs = data.preConsent.consentMode?.[0];
  const postAcceptGcs = data.postAccept.consentMode?.[0];
  if (preGcs || postAcceptGcs) {
    md += '**Consent Mode:**\n\n';
    md += '| Phase | gcs | gcd |\n';
    md += '|-------|-----|-----|\n';
    if (preGcs) md += `| Pre-Consent | ${preGcs.gcs} | ${preGcs.gcd} |\n`;
    if (postAcceptGcs) md += `| Post-Accept | ${postAcceptGcs.gcs} | ${postAcceptGcs.gcd} |\n`;
    md += '\n';

    // Advanced Consent Mode transition verdict
    const cmt = data.consentModeTransition;
    if (cmt) {
      if (cmt.status === 'update_ok') {
        md += `**Advanced Consent Mode:** ${cmt.preGcs} → ${cmt.postGcs} (Update korrekt)\n\n`;
      } else if (cmt.status === 'no_update') {
        md += `**Advanced Consent Mode:** ⚠️ ${cmt.preGcs} → kein Update nach Accept erkannt\n`;
        md += `> Basic Consent Mode aktiv. Nach Accept wurden keine neuen Google-Pings mit aktualisiertem gcs erfasst. `;
        md += `Fuer Advanced Consent Mode muss der CMP-Consent ueber \`gtag('consent', 'update', ...)\` an Google weitergegeben werden, `;
        md += `damit nach Accept ein Ping mit z.B. G111 gesendet wird.\n\n`;
      } else if (cmt.status === 'ecom_stale') {
        md += `**Advanced Consent Mode:** ⚠️ ${cmt.preGcs} → ${cmt.postGcs} (Update ok, aber E-Commerce-Steps haben noch ${cmt.preGcs})\n`;
        md += `> Consent Mode Update nach Accept erkannt, aber im E-Commerce-Pfad wurden weiterhin Pings mit ${cmt.preGcs} erfasst.\n\n`;
      }
    }
  }

  // Tracker overview across all phases
  const preKnown = data.preConsent.trackers.filter(t => t.vendor !== 'Sonstige Third-Party');
  const acceptKnown = data.postAccept.trackers.filter(t => t.vendor !== 'Sonstige Third-Party');
  const rejectKnown = data.postReject.trackers.filter(t => t.vendor !== 'Sonstige Third-Party');

  // Collect all vendor names
  const allVendors = new Set();
  for (const t of [...preKnown, ...acceptKnown, ...rejectKnown]) allVendors.add(t.vendor);

  if (allVendors.size > 0) {
    md += '**Bekannte Tracker nach Consent-Phase:**\n\n';
    md += '| Vendor | Pre-Consent | Post-Accept | Post-Reject |\n';
    md += '|--------|-------------|-------------|-------------|\n';
    for (const vendor of allVendors) {
      const pre = preKnown.find(t => t.vendor === vendor);
      const accept = acceptKnown.find(t => t.vendor === vendor);
      const reject = rejectKnown.find(t => t.vendor === vendor);
      md += `| ${vendor} | ${pre ? 'ja' : '–'} | ${accept ? 'ja' : '–'} | ${reject ? 'ja' : '–'} |\n`;
    }
    md += '\n';
  }

  // Sonstige Third-Party count per phase
  const preOther = data.preConsent.trackers.filter(t => t.vendor === 'Sonstige Third-Party');
  const acceptOther = data.postAccept.trackers.filter(t => t.vendor === 'Sonstige Third-Party');
  const rejectOther = data.postReject.trackers.filter(t => t.vendor === 'Sonstige Third-Party');
  const preCount = preOther.reduce((n, t) => n + t.hostnames.length, 0);
  const acceptCount = acceptOther.reduce((n, t) => n + t.hostnames.length, 0);
  const rejectCount = rejectOther.reduce((n, t) => n + t.hostnames.length, 0);
  md += `**Sonstige Third-Party Domains:** Pre-Consent ${preCount}, Post-Accept +${acceptCount}, Post-Reject +${rejectCount}\n\n`;

  // SST summary
  if (data.sst && hasSSTDetected(data.sst)) {
    const customLoaderCount = data.sst.loaders.filter(l => !l.isStandard).length + (data.sst.customLoaders?.length || 0);
    const collectCount = data.sst.collectEndpoints.length;
    md += `**Server-Side Tagging:** Erkannt (${customLoaderCount} Custom Loader, ${collectCount} Collect Endpoints)\n\n`;
  }

  // E-Commerce: tracker per step (with consent mode if available)
  if (data.ecommerce && data.ecommerce.length > 0) {
    const hasConsentMode = data.ecommerce.some(s => s.consentMode && s.consentMode.length > 0);

    md += '**E-Commerce – Tracker pro Schritt:**\n\n';
    if (hasConsentMode) {
      md += '| Schritt | Bekannte Tracker | gcs |\n';
      md += '|---------|------------------|-----|\n';
    } else {
      md += '| Schritt | Bekannte Tracker |\n';
      md += '|---------|------------------|\n';
    }
    for (const step of data.ecommerce) {
      const trackers = step.trackers
        .filter(t => t.vendor !== 'Sonstige Third-Party')
        .map(t => t.vendor)
        .join(', ') || '_keine_';
      if (hasConsentMode) {
        const gcs = step.consentMode?.[0]?.gcs || '–';
        const preGcs = data.consentModeTransition?.preGcs;
        const warning = (preGcs && gcs === preGcs) ? ' ⚠️' : '';
        md += `| ${step.name} | ${trackers} | ${gcs}${warning} |\n`;
      } else {
        md += `| ${step.name} | ${trackers} |\n`;
      }
    }
    md += '\n';
  }

  return md;
}

function generateReport(data) {
  let md = '';

  md += `# Tagging Audit: ${data.project}\n\n`;
  md += `**URL:** ${data.url} | **Datum:** ${data.timestamp} | **CMP:** ${data.cmpName}\n\n`;

  // ── TL;DR ──
  md += generateTLDR(data);

  // ── Hinweise ──
  md += '## Hinweise\n\n';
  if (data.serviceWorkers && data.serviceWorkers.length > 0) {
    md += `- Service Worker gefunden: ${data.serviceWorkers.join(', ')}\n`;
    if (data.disabledSW) {
      md += '- Service Worker wurden deregistriert (--disable-sw)\n';
    }
  } else {
    md += '- Keine Service Worker erkannt\n';
  }
  md += '\n';

  // ── SST ──
  md += formatSSTSection(data.sst);

  // ── Pre-Consent ──
  md += '## Pre-Consent\n\n';

  md += '### dataLayer\n\n';
  md += formatDataLayer(data.preConsent.dataLayer);
  md += '\n';

  md += '### Netzwerk-Requests (Third-Party)\n\n';
  md += formatTrackerSection(data.preConsent.trackers);

  md += '### Consent Mode Parameter\n\n';
  md += formatConsentMode(data.preConsent.consentMode);
  md += '\n';

  md += '### Cookies\n\n';
  md += formatCookieTable(data.preConsent.cookies);
  md += '\n';

  md += '### localStorage\n\n';
  md += formatLocalStorageTable(data.preConsent.localStorage);
  md += '\n';

  // ── Post-Consent: Accept ──
  md += '## Post-Consent: Accept\n\n';

  md += '### dataLayer (Diff)\n\n';
  md += formatDataLayer(data.postAccept.dataLayerDiff);
  md += '\n';

  md += '### Neue Requests\n\n';
  md += formatTrackerSection(data.postAccept.trackers);

  md += '### Consent Mode Parameter\n\n';
  md += formatConsentMode(data.postAccept.consentMode);
  // Highlight transition in detail section
  const cmt = data.consentModeTransition;
  if (cmt && cmt.status !== 'no_consent_mode') {
    md += '\n';
    if (cmt.status === 'update_ok') {
      md += `> **Advanced Consent Mode Update:** ${cmt.preGcs} → ${cmt.postGcs} ✓\n`;
    } else if (cmt.status === 'no_update') {
      md += `> **⚠️ Kein Consent Mode Update:** gcs ist nach Accept immer noch ${cmt.preGcs}\n`;
    } else if (cmt.status === 'ecom_stale') {
      md += `> **⚠️ Consent Mode Update teilweise:** ${cmt.preGcs} → ${cmt.postGcs}, aber E-Commerce-Steps haben noch ${cmt.preGcs}\n`;
    }
  }
  md += '\n';

  md += '### Cookies (Diff)\n\n';
  md += formatCookieTable(data.postAccept.cookiesDiff);
  md += '\n';

  md += '### localStorage (Diff)\n\n';
  md += formatLocalStorageTable(data.postAccept.localStorageDiff);
  md += '\n';

  // ── Post-Consent: Reject ──
  md += '## Post-Consent: Reject\n\n';

  md += '### dataLayer (Diff)\n\n';
  md += formatDataLayer(data.postReject.dataLayerDiff);
  md += '\n';

  md += '### Neue Requests\n\n';
  md += formatTrackerSection(data.postReject.trackers);

  md += '### Cookies (Diff)\n\n';
  md += formatCookieTable(data.postReject.cookiesDiff);
  md += '\n';

  md += '### localStorage (Diff)\n\n';
  md += formatLocalStorageTable(data.postReject.localStorageDiff);
  md += '\n';

  md += '### Auffaelligkeiten (Tracker trotz Reject?)\n\n';
  const rejectTrackers = data.postReject.trackers.filter(t => t.vendor !== 'Sonstige Third-Party');
  if (rejectTrackers.length > 0) {
    md += '**WARNUNG:** Folgende bekannte Tracker wurden trotz Reject gefunden:\n\n';
    for (const t of rejectTrackers) {
      md += `- **${t.vendor}**: ${t.hostnames.join(', ')}\n`;
    }
    md += '\n';
  } else {
    md += '_Keine bekannten Tracker nach Reject erkannt._\n\n';
  }

  // ── E-Commerce Pfad ──
  if (data.ecommerce && data.ecommerce.length > 0) {
    md += '## E-Commerce Pfad\n\n';

    // Summary table
    md += '| Schritt | dataLayer Events | Tracking Requests | Neue Cookies |\n';
    md += '|---------|-----------------|-------------------|---------------|\n';
    for (const step of data.ecommerce) {
      const dlEvents = step.dataLayerDiff
        .filter(e => e.event)
        .map(e => e.event)
        .join(', ') || '-';
      const trackingReqs = step.trackers
        .filter(t => t.vendor !== 'Sonstige Third-Party')
        .map(t => `${t.vendor} (${t.hostnames.join(', ')})`)
        .join(', ') || '-';
      const newCookies = step.cookiesDiff.map(c => c.name).join(', ') || '-';
      md += `| ${step.name} | ${dlEvents} | ${trackingReqs} | ${newCookies} |\n`;
    }
    md += '\n';

    // Detail per step
    for (const step of data.ecommerce) {
      md += `### ${step.name}\n\n`;

      md += '#### dataLayer (Diff)\n\n';
      md += formatDataLayer(step.dataLayerDiff);
      md += '\n';

      md += '#### Netzwerk-Requests\n\n';
      md += formatTrackerSection(step.trackers);

      md += '#### Cookies (Diff)\n\n';
      md += formatCookieTable(step.cookiesDiff);
      md += '\n';

      md += '#### localStorage (Diff)\n\n';
      md += formatLocalStorageTable(step.localStorageDiff);
      md += '\n';
    }

    // Product analysis section
    if (data.ecommerceAnalysis) {
      md += formatProductAnalysis(data.ecommerceAnalysis);
    }
  }

  return md;
}

// ── E-Commerce Step Data Collection ──────────────────────────────────────────

/**
 * Collect tracking data for a single E-Commerce step.
 * Used by both automatic and interactive E-Commerce modes.
 */
async function collectEcomStepData(page, context, step, prevCookies, prevLocalStorage, prevDataLayer, siteHost) {
  const getStepRequests = setupRequestCollector(page);
  await waitForSettle(page, 3000);

  const stepDataLayer = await collectDataLayer(page);
  const stepBaseline = step.type === 'navigate' ? [] : prevDataLayer;
  const stepDataLayerDiff = diffDataLayer(stepBaseline, stepDataLayer);

  const stepRequestUrls = getStepRequests();
  const stepFullRequests = getStepRequests.full();
  const stepClassified = stepRequestUrls.map(r => classifyRequest(r, siteHost)).filter(Boolean);
  const stepTrackers = deduplicateRequests(stepClassified);

  const stepConsentMode = extractConsentModeParams(
    stepRequestUrls.filter(r => {
      const c = classifyRequest(r, siteHost);
      return c && c.vendor === 'Google';
    })
  );

  const stepCookies = await collectCookies(context);
  const stepLocalStorage = await collectLocalStorage(page);
  const stepCookiesDiff = diffCookies(prevCookies, stepCookies);
  const stepLocalStorageDiff = diffLocalStorage(prevLocalStorage, stepLocalStorage);

  return {
    data: {
      name: step.name,
      dataLayerDiff: stepDataLayerDiff,
      trackers: stepTrackers,
      consentMode: stepConsentMode,
      cookiesDiff: stepCookiesDiff,
      localStorageDiff: stepLocalStorageDiff,
    },
    stepDataLayer,
    stepCookies,
    stepLocalStorage,
    stepClassified,
    stepFullRequests,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`\n=======================================`);
  console.log(` Tagging Audit`);
  console.log(` Project : ${project}`);
  console.log(` URL     : ${url}`);
  if (cmpFlag) console.log(` CMP     : ${cmpFlag}`);
  if (categoryUrl) console.log(` E-Commerce Pfad aktiv`);
  if (ecomInteractive) console.log(` E-Commerce Pfad interaktiv`);
  if (disableSW) console.log(` Service Worker werden deregistriert`);
  if (noPayloadAnalysis) console.log(` Payload-Analyse: deaktiviert`);
  console.log(`=======================================\n`);

  const library = loadLibrary();
  const siteHost = url;

  // ── Phase 0: CMP Detection ─────────────────────────────────────────────────

  console.log('Phase 0: CMP-Erkennung...');

  let cmp;
  let cmpFromManualMode = false;  // Track if CMP came from manual mode to prevent re-triggering

  if (cmpFlag) {
    // Direct lookup by key
    const key = cmpFlag.toLowerCase().replace(/\s+/g, '-');
    if (!library[key]) {
      console.error(`CMP "${cmpFlag}" nicht in cmp-library.json gefunden.`);
      console.error(`Verfuegbare CMPs: ${Object.keys(library).join(', ')}`);
      process.exit(1);
    }
    cmp = { key, ...library[key] };
    console.log(`  CMP aus Flag: ${cmp.name}`);
  }

  // ── Phase 1: Pre-Consent (fresh browser) ────────────────────────────────────

  console.log('\nPhase 1: Pre-Consent...');

  const browser1 = await chromium.launch({ headless: false });
  const context1 = await browser1.newContext();
  const page1 = await context1.newPage();

  let getPreRequests = setupRequestCollector(page1);
  let getPreResponseBodies = setupResponseBodyCollector(page1, siteHost);
  let getCSPViolations1 = () => [];
  if (!noPayloadAnalysis) {
    getCSPViolations1 = await setupCSPViolationCollector(page1);
  }

  try {
    await page1.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
  } catch {
    // networkidle timeout — page is still loading but DOM is ready enough
    console.log('  networkidle Timeout, fahre fort...');
  }
  await showStatusBar(page1, 'Phase 0', 'CMP-Erkennung...');
  await waitForSettle(page1, 3000);

  // Auto-detect CMP if not provided via flag
  if (!cmp) {
    await updateStatusBar(page1, 'Phase 0', 'Starte CMP-Erkennung...');
    cmp = await detectCMP(page1, library);
    if (!cmp) {
      console.log('  CMP nicht automatisch erkannt – starte manuellen Modus...');
      cmp = await emergencyLearnCMP(page1, library);
      cmpFromManualMode = true;
      // Manual mode did page.goto() — flush old collectors and set up fresh ones
      // so Phase 1 captures clean pre-consent data from the reloaded page
      getPreRequests(); // discard
      getPreRequests = setupRequestCollector(page1);
      getPreResponseBodies = setupResponseBodyCollector(page1, siteHost);
    }
  }

  const reportData = {
    project,
    url,
    cmpName: cmp.name,
    serviceWorkers: [],
    disabledSW: disableSW,
    preConsent: {},
    postAccept: {},
    postReject: {},
    ecommerce: [],
    ecommerceAnalysis: null,
    deepAnalysis: {
      cspViolations: [],
      features: {
        enhancedConversions: null,
        remarketing: [],
        metaSetup: null,
      },
      stapeTransports: [],
      googleSubTypes: new Set(),
      measurementIds: [],
    },
    sst: null,
  };

  await showStatusBar(page1, 'Phase 1', `Pre-Consent – CMP: ${cmp.name}`, 'Sammle Daten...');
  await updateStatusBar(page1, 'Phase 1', `Pre-Consent – CMP: ${cmp.name}`, 'Sammle Daten...');

  // dataLayer
  const preDataLayer = await collectDataLayer(page1);
  console.log(`  dataLayer: ${preDataLayer.length} Eintraege`);

  // Network requests
  const preRequestUrls = getPreRequests();
  const preClassified = preRequestUrls.map(r => classifyRequest(r, siteHost)).filter(Boolean);
  const preTrackers = deduplicateRequests(preClassified);
  console.log(`  Requests: ${preRequestUrls.length} total, ${preClassified.length} third-party`);
  await updateStatusBar(page1, 'Phase 1', `Pre-Consent – CMP: ${cmp.name}`, `DL: ${preDataLayer.length} | 3P: ${preClassified.length}`);

  // Cookies & localStorage
  const preCookies = await collectCookies(context1);
  const preLocalStorage = await collectLocalStorage(page1);
  console.log(`  Cookies: ${preCookies.length}, localStorage: ${Object.keys(preLocalStorage).length} Keys`);

  // Service Workers
  const serviceWorkers = await checkServiceWorkers(page1);
  reportData.serviceWorkers = serviceWorkers;
  if (serviceWorkers.length > 0) {
    console.log(`  Service Worker gefunden: ${serviceWorkers.join(', ')}`);
    if (disableSW) {
      await deregisterServiceWorkers(page1);
      console.log('  Service Worker deregistriert');
    }
  }

  // Consent Mode params
  const preConsentMode = extractConsentModeParams(
    preRequestUrls.filter(r => {
      const c = classifyRequest(r, siteHost);
      return c && c.vendor === 'Google';
    })
  );

  reportData.preConsent = {
    dataLayer: preDataLayer,
    trackers: preTrackers,
    consentMode: preConsentMode,
    cookies: preCookies,
    localStorage: preLocalStorage,
  };

  // SST detection from pre-consent requests
  const preSSTUrls = detectSSTFromUrls(preRequestUrls, siteHost);
  const preResponseBodies = await getPreResponseBodies();
  const preSSTBodies = detectSSTFromResponseBodies(preResponseBodies, siteHost);

  // ── Phase 2: Post-Accept (same browser) ─────────────────────────────────────

  console.log('\nPhase 2: Post-Accept...');
  await updateStatusBar(page1, 'Phase 2', 'Post-Accept – klicke Accept...', '');

  // Clear request collector and set up fresh one for this phase
  const getPostAcceptRequests = setupRequestCollector(page1);
  const getPostAcceptResponseBodies = setupResponseBodyCollector(page1, siteHost);

  // Click accept – wait for banner to appear, then click
  let acceptClicked = false;
  try {
    await page1.locator(cmp.accept).first().waitFor({ state: 'visible', timeout: 5000 });
    await page1.locator(cmp.accept).first().click({ timeout: 10000 });
    acceptClicked = true;
    console.log('  Accept-Button geklickt');
    await updateStatusBar(page1, 'Phase 2', 'Post-Accept – Accept geklickt, sammle Daten...', '');
  } catch {
    // Scroll-retry
    console.log('  Accept-Button nicht sichtbar, versuche Scroll...');
    await page1.evaluate(() => window.scrollBy(0, 400));
    await page1.waitForTimeout(2000);
    try {
      await page1.locator(cmp.accept).first().click({ timeout: 5000 });
      acceptClicked = true;
      console.log('  Accept-Button nach Scroll geklickt');
    } catch { /* still failed */ }
  }

  if (!acceptClicked && !cmpFromManualMode) {
    // Only trigger manual mode if we haven't already been through it
    console.log('  Accept-Button nicht klickbar – starte manuellen Modus...');
    const freshCmp = await emergencyLearnCMP(page1, library);
    cmp = freshCmp;
    cmpFromManualMode = true;
    reportData.cmpName = cmp.name;
    await showStatusBar(page1, 'Phase 2', 'Post-Accept – klicke Accept (manuell)...', '');
    try {
      await page1.locator(cmp.accept).first().waitFor({ state: 'visible', timeout: 5000 });
      await page1.locator(cmp.accept).first().click({ timeout: 10000 });
      acceptClicked = true;
      console.log('  Accept-Button geklickt (manueller Selektor)');
    } catch (err2) {
      console.error(`  FEHLER: Accept auch mit manueller Selektor nicht klickbar: ${err2.message}`);
    }
  } else if (!acceptClicked) {
    console.error('  FEHLER: Accept-Button nicht klickbar (Manueller Modus war bereits aktiv, kein erneuter Versuch)');
  }

  await waitForSettle(page1, 3000);

  // dataLayer diff
  const postAcceptDataLayer = await collectDataLayer(page1);
  const postAcceptDataLayerDiff = diffDataLayer(preDataLayer, postAcceptDataLayer);
  console.log(`  dataLayer Diff: ${postAcceptDataLayerDiff.length} neue Eintraege`);

  // New requests
  const postAcceptRequestUrls = getPostAcceptRequests();
  const postAcceptClassified = postAcceptRequestUrls.map(r => classifyRequest(r, siteHost)).filter(Boolean);
  const postAcceptTrackers = deduplicateRequests(postAcceptClassified);
  console.log(`  Neue Requests: ${postAcceptRequestUrls.length} total, ${postAcceptClassified.length} third-party`);
  await updateStatusBar(page1, 'Phase 2', 'Post-Accept – Daten gesammelt', `DL: +${postAcceptDataLayerDiff.length} | 3P: +${postAcceptClassified.length}`);

  // Cookie/localStorage diff
  const postAcceptCookies = await collectCookies(context1);
  const postAcceptLocalStorage = await collectLocalStorage(page1);
  const postAcceptCookiesDiff = diffCookies(preCookies, postAcceptCookies);
  const postAcceptLocalStorageDiff = diffLocalStorage(preLocalStorage, postAcceptLocalStorage);
  console.log(`  Neue Cookies: ${postAcceptCookiesDiff.length}, Neue localStorage Keys: ${Object.keys(postAcceptLocalStorageDiff).length}`);

  // Consent Mode params after accept
  const postAcceptConsentMode = extractConsentModeParams(
    postAcceptRequestUrls.filter(r => {
      const c = classifyRequest(r, siteHost);
      return c && c.vendor === 'Google';
    })
  );

  reportData.postAccept = {
    dataLayerDiff: postAcceptDataLayerDiff,
    trackers: postAcceptTrackers,
    consentMode: postAcceptConsentMode,
    cookiesDiff: postAcceptCookiesDiff,
    localStorageDiff: postAcceptLocalStorageDiff,
  };

  // SST detection from post-accept requests + merge with pre-consent
  const postAcceptSSTUrls = detectSSTFromUrls(postAcceptRequestUrls, siteHost);
  reportData.sst = mergeSST(preSSTUrls, postAcceptSSTUrls);

  // Response body analysis for custom loaders
  const postAcceptResponseBodies = await getPostAcceptResponseBodies();
  const allResponseBodies = [...preResponseBodies, ...postAcceptResponseBodies];
  const sstBodies = detectSSTFromResponseBodies(allResponseBodies, siteHost);
  reportData.sst.customLoaders = sstBodies;

  if (hasSSTDetected(reportData.sst)) {
    const customCount = reportData.sst.loaders.filter(l => !l.isStandard).length;
    const collectCount = reportData.sst.collectEndpoints.length;
    console.log(`  SST erkannt: ${customCount} Custom Loader, ${collectCount} Collect Endpoints, ${sstBodies.length} Body-Fingerprints`);
  }

  // ── Phase 3: E-Commerce (same browser, --category or --ecom) ────────────────

  if (categoryUrl || ecomInteractive) {
    console.log('\nPhase 3: E-Commerce Pfad...');
    await updateStatusBar(page1, 'Phase 3', 'E-Commerce Pfad...', '');

    // We track cumulative cookies/localStorage for diffing between steps
    let prevCookies = postAcceptCookies;
    let prevLocalStorage = postAcceptLocalStorage;
    let prevDataLayer = postAcceptDataLayer;

    if (ecomInteractive) {
      // ── Interaktiver Modus: User navigiert selbst ──
      const interactiveSteps = [
        { name: 'Kategorie-Seite', type: 'navigate' },
        { name: 'Produkt-Seite', type: 'navigate' },
        { name: 'Add-to-Cart', type: 'click' },
        { name: 'Warenkorb', type: 'navigate' },
        { name: 'Checkout', type: 'navigate' },
      ];

      // Re-inject status bar after user navigation (DOM is destroyed on page load)
      let currentStepLabel = '';
      const onLoadStatusBar = async () => {
        try { await showStatusBar(page1, 'Phase 3', currentStepLabel); } catch { /* page may close */ }
      };
      page1.on('load', onLoadStatusBar);

      for (let i = 0; i < interactiveSteps.length; i++) {
        const step = interactiveSteps[i];
        currentStepLabel = `E-Commerce: ${step.name} (interaktiv)`;
        await updateStatusBar(page1, 'Phase 3', currentStepLabel, `Schritt ${i + 1}/${interactiveSteps.length}`);

        if (step.type === 'click') {
          // ── Click-Step (z.B. Add-to-Cart): Bereit → Klick-Erkennung → Auto-Collect ──

          // Phase A: User bereitet vor (Menge, Variante etc.)
          const prepAction = await showEcomStepPrompt(page1, step.name, i + 1, interactiveSteps.length, {
            nextLabel: 'Bereit',
            instruction: 'Bereite alles vor (Menge, Variante, Optionen...). Klicke "Bereit" wenn du gleich den Button klicken wirst.',
          });
          if (prepAction === 'done') {
            console.log(`  Audit abgeschlossen nach Schritt ${i} von ${interactiveSteps.length}`);
            break;
          }

          // Collectors starten VOR dem Klick
          const getStepRequests = setupRequestCollector(page1);
          const urlBeforeClick = page1.url();

          // dataLayer-Capture: Monkey-Patch fängt DL-Pushes ab und schickt sie
          // per exposeFunction an Node.js – überlebt Navigation
          const dlCapture = [];
          const dlCapCbName = '__audit_dlcap_' + Date.now();
          try {
            await page1.exposeFunction(dlCapCbName, (json) => {
              try { dlCapture.push(JSON.parse(json)); } catch { /* */ }
            });
          } catch { /* */ }
          await page1.evaluate((cbName) => {
            if (!window.dataLayer) return;
            const origPush = window.dataLayer.push.bind(window.dataLayer);
            window.dataLayer.push = function(...args) {
              for (const a of args) {
                try { window[cbName](JSON.stringify(a)); } catch {}
              }
              return origPush(...args);
            };
          }, dlCapCbName);

          // Phase B: Nächster Klick auf der Seite = ATC (automatische Erkennung)
          const clickResult = await showEcomClickWait(page1);
          if (clickResult === 'done') {
            console.log(`  Audit abgeschlossen nach Schritt ${i} von ${interactiveSteps.length}`);
            break;
          }

          console.log(`  Schritt: ${step.name} (interaktiv, click)...`);

          // Settle – Navigation kann stattfinden
          await waitForSettle(page1, 3000);

          // Daten sammeln
          const navigated = page1.url() !== urlBeforeClick;
          if (navigated) console.log(`    Navigation erkannt: ${urlBeforeClick} → ${page1.url()}`);

          const dlAfterSettle = await collectDataLayer(page1);
          // Bei Navigation: DL-Events von der alten Seite (monkey-patch) + neue Seite komplett
          // Ohne Navigation: normaler Diff gegen vorherigen Stand
          const stepDataLayerDiff = navigated
            ? [...dlCapture, ...dlAfterSettle]
            : diffDataLayer(prevDataLayer, dlAfterSettle);

          const stepRequestUrls = getStepRequests();
          const stepClassified = stepRequestUrls.map(r => classifyRequest(r, siteHost)).filter(Boolean);
          const stepTrackers = deduplicateRequests(stepClassified);
          const stepConsentMode = extractConsentModeParams(
            stepRequestUrls.filter(r => { const c = classifyRequest(r, siteHost); return c && c.vendor === 'Google'; })
          );

          const stepCookies = await collectCookies(context1);
          const stepLocalStorage = await collectLocalStorage(page1);
          const stepCookiesDiff = diffCookies(prevCookies, stepCookies);
          const stepLocalStorageDiff = diffLocalStorage(prevLocalStorage, stepLocalStorage);

          console.log(`    dataLayer Diff: ${stepDataLayerDiff.length} (${dlCapture.length} pre-nav, ${dlAfterSettle.length} post), Requests: ${stepClassified.length} 3P, Cookies: +${stepCookiesDiff.length}`);

          reportData.ecommerce.push({
            name: step.name,
            dataLayerDiff: stepDataLayerDiff,
            trackers: stepTrackers,
            consentMode: stepConsentMode,
            cookiesDiff: stepCookiesDiff,
            localStorageDiff: stepLocalStorageDiff,
          });

          prevCookies = stepCookies;
          prevLocalStorage = stepLocalStorage;
          prevDataLayer = dlAfterSettle;

        } else {
          // ── Navigate-Steps: User navigiert, dann bestätigt ──
          const action = await showEcomStepPrompt(page1, step.name, i + 1, interactiveSteps.length);
          if (action === 'done') {
            console.log(`  Audit abgeschlossen nach Schritt ${i} von ${interactiveSteps.length}`);
            break;
          }

          console.log(`  Schritt: ${step.name} (interaktiv)...`);

          const result = await collectEcomStepData(page1, context1, step, prevCookies, prevLocalStorage, prevDataLayer, siteHost);

          console.log(`    dataLayer Diff: ${result.data.dataLayerDiff.length}, Requests: ${result.stepClassified.length} 3P, Cookies: +${result.data.cookiesDiff.length}`);

          reportData.ecommerce.push(result.data);

          prevCookies = result.stepCookies;
          prevLocalStorage = result.stepLocalStorage;
          prevDataLayer = result.stepDataLayer;
        }
      }

      page1.off('load', onLoadStatusBar);
    } else {
      // ── Automatischer Modus (--category etc.) ──
      const ecomSteps = [
        { name: 'Kategorie-Seite', type: 'navigate', value: resolveUrl(url, categoryUrl) },
        productUrl ? { name: 'Produkt-Seite', type: 'navigate', value: resolveUrl(url, productUrl) } : null,
        addToCartSel ? { name: 'Add-to-Cart', type: 'click', value: addToCartSel } : null,
        viewCartUrl ? { name: 'Warenkorb', type: 'navigate', value: resolveUrl(url, viewCartUrl) } : null,
        checkoutUrl ? { name: 'Checkout', type: 'navigate', value: resolveUrl(url, checkoutUrl) } : null,
      ].filter(Boolean);

      for (const step of ecomSteps) {
        console.log(`  Schritt: ${step.name}...`);
        await updateStatusBar(page1, 'Phase 3', `E-Commerce: ${step.name}`, '');

        // Safety: skip navigate steps where URL resolution failed
        if (step.type === 'navigate' && !step.value) {
          console.error(`    ÜBERSPRUNGEN: URL für "${step.name}" konnte nicht aufgelöst werden.`);
          continue;
        }

        if (step.type === 'navigate') {
          console.log(`    → ${step.value}`);
          try {
            await page1.goto(step.value, { waitUntil: 'networkidle', timeout: 20000 });
          } catch { /* networkidle timeout, continue */ }
        } else if (step.type === 'click') {
          try {
            await page1.locator(step.value).first().click({ timeout: 10000 });
          } catch (err) {
            console.error(`    FEHLER: Klick auf "${step.value}" fehlgeschlagen: ${err.message}`);
          }
        }

        const result = await collectEcomStepData(page1, context1, step, prevCookies, prevLocalStorage, prevDataLayer, siteHost);

        console.log(`    dataLayer Diff: ${result.data.dataLayerDiff.length}, Requests: ${result.stepClassified.length} 3P, Cookies: +${result.data.cookiesDiff.length}`);

        reportData.ecommerce.push(result.data);

        prevCookies = result.stepCookies;
        prevLocalStorage = result.stepLocalStorage;
        prevDataLayer = result.stepDataLayer;
      }
    }

    // Product consistency analysis
    reportData.ecommerceAnalysis = analyzeEcommerceProducts(reportData.ecommerce);
    if (reportData.ecommerceAnalysis.format) {
      console.log(`\n  Produktdaten-Analyse: Format=${reportData.ecommerceAnalysis.format}, Fokus-Produkt=${reportData.ecommerceAnalysis.focusProduct?.id || 'keins'}`);
    }
  }

  // Close first browser
  await browser1.close();
  console.log('\n  Browser 1 geschlossen.');

  // ── Phase 4: Post-Reject (completely fresh browser) ─────────────────────────

  console.log('\nPhase 4: Post-Reject (neuer Browser)...');

  const browser2 = await chromium.launch({ headless: false });
  const context2 = await browser2.newContext();
  const page2 = await context2.newPage();

  // Pre-consent baseline in fresh browser
  const getRejectPreRequests = setupRequestCollector(page2);
  let getCSPViolations2 = () => [];
  if (!noPayloadAnalysis) {
    getCSPViolations2 = await setupCSPViolationCollector(page2);
  }

  try {
    await page2.goto(url, { waitUntil: 'networkidle', timeout: 20000 });
  } catch {
    console.log('  networkidle Timeout, fahre fort...');
  }
  await showStatusBar(page2, 'Phase 4', 'Post-Reject – Neuer Browser, sammle Baseline...');
  await waitForSettle(page2, 3000);

  const rejectPreDataLayer = await collectDataLayer(page2);
  const rejectPreCookies = await collectCookies(context2);
  const rejectPreLocalStorage = await collectLocalStorage(page2);

  // Consume pre-consent requests so they don't bleed into post-reject
  getRejectPreRequests();

  // Set up fresh collector for post-reject
  const getRejectPostRequests = setupRequestCollector(page2);

  // Scroll-Retry: CMP-Banner muss sichtbar sein vor Reject-Klick
  const rejectFirstSelector = (cmp.rejectSteps && cmp.rejectSteps.length >= 1) ? cmp.rejectSteps[0] : cmp.reject;
  try {
    await page2.locator(rejectFirstSelector).first().waitFor({ state: 'visible', timeout: 3000 });
  } catch {
    console.log('  CMP-Banner nicht sichtbar, versuche Scroll...');
    await page2.evaluate(() => window.scrollBy(0, 400));
    await page2.waitForTimeout(2000);
  }

  // Click reject (direct or two-step)
  let rejectClicked = false;

  // Versuch 1: Direkter Reject-Button
  await updateStatusBar(page2, 'Phase 4', 'Post-Reject – klicke Reject...', '');
  try {
    const rejectLocator = page2.locator(cmp.reject).first();
    await rejectLocator.click({ timeout: 5000 });
    rejectClicked = true;
    console.log('  Reject-Button geklickt');
    await updateStatusBar(page2, 'Phase 4', 'Post-Reject – Reject geklickt, sammle Daten...', '');
  } catch {
    // Reject-Button nicht direkt gefunden
  }

  // Versuch 2: Two-Step Fallback (rejectSteps)
  if (!rejectClicked && cmp.rejectSteps && cmp.rejectSteps.length === 2) {
    try {
      console.log('  Reject nicht direkt gefunden, versuche Two-Step...');
      await page2.locator(cmp.rejectSteps[0]).first().click({ timeout: 5000 });
      console.log(`  Step 1 geklickt (${cmp.rejectSteps[0]})`);
      await page2.waitForTimeout(2000);
      await page2.locator(cmp.rejectSteps[1]).first().click({ timeout: 5000 });
      rejectClicked = true;
      console.log(`  Step 2 geklickt (${cmp.rejectSteps[1]})`);
    } catch (err) {
      console.error(`  FEHLER: Two-Step Reject fehlgeschlagen: ${err.message}`);
    }
  }

  if (!rejectClicked) {
    console.log('  Reject konnte nicht geklickt werden – Manueller Modus fuer Reject...');
    await showMessage(page2, 'Reject-Button konnte nicht automatisch geklickt werden. Bitte manuell klicken.', { type: 'warning', title: 'Manuell' });
    const rejectResult = await showClickPrompt(page2, 'REJECT');
    if (rejectResult && isPlausibleResult(rejectResult)) {
      const { confirmed } = await showSelectorResult(page2, rejectResult, 'REJECT');
      if (confirmed) {
        try {
          await page2.locator(rejectResult.selector).first().click({ timeout: 5000 });
          rejectClicked = true;
          console.log(`  Reject-Button geklickt (Manuell: ${rejectResult.selector})`);
        } catch { /* still failed */ }
      }
    }
    if (!rejectClicked) {
      const manualSel = await showTextInput(page2, 'Reject-Selektor eingeben');
      try {
        await page2.locator(manualSel).first().click({ timeout: 5000 });
        rejectClicked = true;
        console.log(`  Reject-Button geklickt (manuell: ${manualSel})`);
      } catch (err) {
        console.error(`  FEHLER: Reject auch mit manuellem Selektor nicht klickbar: ${err.message}`);
      }
    }
  }

  await waitForSettle(page2, 3000);

  // Post-reject data
  const rejectPostDataLayer = await collectDataLayer(page2);
  const rejectDataLayerDiff = diffDataLayer(rejectPreDataLayer, rejectPostDataLayer);
  console.log(`  dataLayer Diff: ${rejectDataLayerDiff.length} neue Eintraege`);

  const rejectPostRequestUrls = getRejectPostRequests();
  const rejectPostClassified = rejectPostRequestUrls.map(r => classifyRequest(r, siteHost)).filter(Boolean);
  const rejectPostTrackers = deduplicateRequests(rejectPostClassified);
  console.log(`  Neue Requests: ${rejectPostRequestUrls.length} total, ${rejectPostClassified.length} third-party`);

  const rejectPostCookies = await collectCookies(context2);
  const rejectPostLocalStorage = await collectLocalStorage(page2);
  const rejectCookiesDiff = diffCookies(rejectPreCookies, rejectPostCookies);
  const rejectLocalStorageDiff = diffLocalStorage(rejectPreLocalStorage, rejectPostLocalStorage);
  console.log(`  Neue Cookies: ${rejectCookiesDiff.length}, Neue localStorage Keys: ${Object.keys(rejectLocalStorageDiff).length}`);

  reportData.postReject = {
    dataLayerDiff: rejectDataLayerDiff,
    trackers: rejectPostTrackers,
    cookiesDiff: rejectCookiesDiff,
    localStorageDiff: rejectLocalStorageDiff,
  };

  await updateStatusBar(page2, 'Phase 5', 'Fertig – Report wird generiert...', `DL: +${rejectDataLayerDiff.length} | 3P: +${rejectPostClassified.length}`);
  await browser2.close();
  console.log('  Browser 2 geschlossen.');

  // ── CSP Violation Merge ────────────────────────────────────────────────────
  if (!noPayloadAnalysis) {
    const allViolations = [...getCSPViolations1(), ...getCSPViolations2()];
    // Deduplicate by blockedURI + effectiveDirective
    const seen = new Set();
    reportData.deepAnalysis.cspViolations = allViolations.filter(v => {
      const key = `${v.blockedURI}|${v.effectiveDirective}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (reportData.deepAnalysis.cspViolations.length > 0) {
      console.log(`  CSP-Violations: ${reportData.deepAnalysis.cspViolations.length} blockierte Requests`);
    }
  }

  // ── Consent Mode Transition Analysis ──────────────────────────────────────
  reportData.consentModeTransition = analyzeConsentModeTransition(reportData);
  if (reportData.consentModeTransition.status !== 'no_consent_mode') {
    console.log(`\n  Consent Mode: ${reportData.consentModeTransition.preGcs} → ${reportData.consentModeTransition.postGcs} (${reportData.consentModeTransition.status})`);
  }

  // ── Phase 5: Report Generation ──────────────────────────────────────────────

  console.log('\nPhase 5: Report generieren...');

  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const time = now.toTimeString().slice(0, 5).replace(':', '');
  const timestamp = `${date}-${time}`;
  reportData.timestamp = `${date} ${now.toTimeString().slice(0, 5)}`;
  const reportDir = resolve(__dirname, 'reports', project);
  const reportFile = resolve(reportDir, `audit-${timestamp}.md`);

  if (!existsSync(reportDir)) {
    mkdirSync(reportDir, { recursive: true });
  }

  const markdown = generateReport(reportData);
  writeFileSync(reportFile, markdown, 'utf-8');

  console.log(`\n=======================================`);
  console.log(` Audit abgeschlossen!`);
  console.log(` Report: ${reportFile}`);
  console.log(`=======================================\n`);
})();
