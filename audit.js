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
  showMessage, showConfirm,
  showStatusBar, updateStatusBar, enableCMPSelect, showCMPOverride, removeStatusBar,
  showEcomStepPrompt, showEcomClickWait,
  showConsentCard, removeConsentCard,
} from './browser-ui.js';
import {
  VENDORS, getHostname, getSiteDomain, truncate,
  matchRequest, deduplicateMatches, detectSSTFromUrls, extractConsentModeParams,
  STAPE_PATH_HOSTS, canonicalGoogleHost, tryDecodeStapeTransport,
  extractStapeFindings, extractStapeMatches,
  extractTaggrsTransports,
} from './lib/tracking-classify.js';
import { parseOpenAiRequest, isOpenAiSdkHost } from './pii-lib/openai.js';

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
const exportHAR = has('--har');

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
  console.error('  Export:  [--har] (HAR-Datei mit allen Requests exportieren)');
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadLibrary() {
  if (!existsSync(LIBRARY_PATH)) return {};
  return JSON.parse(readFileSync(LIBRARY_PATH, 'utf-8'));
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

/**
 * Checks GA4 collect requests for Enhanced Conversions indicators.
 * Params 'ect' or 'em' signal EC is active.
 */
function checkEnhancedConversions(requestUrl, postData) {
  try {
    const u = new URL(requestUrl);
    const urlParams = u.searchParams;
    const bodyParams = postData ? new URLSearchParams(postData) : new URLSearchParams();

    const hasEct = urlParams.has('ect') || bodyParams.has('ect');
    const hasEm = urlParams.has('em') || bodyParams.has('em');

    if (!hasEct && !hasEm) return null;

    return {
      active: true,
      hasHashedEmail: hasEm,
      eventName: urlParams.get('en') || bodyParams.get('en') || null,
    };
  } catch { return null; }
}

/**
 * Checks Google Ads requests for Dynamic Remarketing product data.
 */
function checkRemarketingPayload(requestUrl, postData) {
  try {
    const combined = requestUrl + (postData ? '&' + postData : '');
    const paramStr = combined.includes('?') ? combined.split('?').slice(1).join('?') : postData || '';
    const params = new URLSearchParams(paramStr);

    const prodId = params.get('ecomm_prodid') || params.get('dynx_itemid');
    const pageType = params.get('ecomm_pagetype') || params.get('dynx_pagetype');

    if (!prodId && !pageType) return null;

    return {
      active: true,
      hasProductIds: !!prodId,
      pageType: pageType || null,
    };
  } catch { return null; }
}

/**
 * Determines Meta tracking setup: Browser Pixel, CAPI indicator, or both.
 */
function detectMetaSetup(fullRequests, cookies, siteHost) {
  const siteDomain = getSiteDomain(siteHost);

  const hasBrowserPixel = fullRequests.some(r =>
    r.url.includes('connect.facebook.net')
  );

  // CAPI-Events sind POST-Beacons. Nur "/events" im Pfad matcht sonst auch einen
  // redaktionellen /events/-Bereich (Veranstaltungskalender = GET-Navigation) und
  // meldet faelschlich "Meta CAPI".
  const hasFirstPartyEvents = fullRequests.some(r => {
    if (r.method !== 'POST') return false;
    try {
      const u = new URL(r.url);
      return getSiteDomain(r.url) === siteDomain &&
             u.pathname.includes('/events');
    } catch { return false; }
  });

  const hasFbpCookie = cookies.some(c => c.name === '_fbp');

  if (!hasBrowserPixel && !hasFirstPartyEvents && !hasFbpCookie) return null;

  return { hasBrowserPixel, hasFirstPartyEvents, hasFbpCookie };
}

// ── OpenAI Ads Pixel (oaiq) ──────────────────────────────────────────────────
//
// Das Pixel ist Opt-out: ohne expliziten oaiq('consent', false) misst es, und es
// kennt weder TCF noch Consent Mode. Es feuert also typischerweise schon vor
// jeder Consent-Entscheidung -- deshalb traegt hier jedes Event seine Phase.
//
// Die Pixel-ID steht NICHT in der SDK-URL. Sie kommt entweder aus dem Pfad des
// Config-Fetches oder aus ?pid= am Event-Request. Bleiben beide aus, ist nur
// belegt, DASS ein Pixel geladen wurde -- was der Report so ausweist, statt eine
// ID zu erfinden.

const OPENAI_UNKNOWN_PIXEL = '(ID unbekannt)';
const OPENAI_CONFIG_PATH = /\/pixel-config\/v\d+\/([^/]+)\.json$/;

function openAiConfigPixelId(requestUrl) {
  try {
    const m = new URL(requestUrl).pathname.match(OPENAI_CONFIG_PATH);
    return m ? m[1] : null;
  } catch { return null; }
}

/**
 * Sammelt SDK-Loads, Config-Fetches und geparste Events in deepAnalysis.openai.
 * Wird wie die uebrigen Payload-Analysen pro Phase aufgerufen und akkumuliert.
 */
function analyzeOpenAiPixel(fullRequests, openai) {
  const pixelEntry = (id) => {
    if (!openai.pixels.has(id)) {
      openai.pixels.set(id, {
        sdkVersions: new Set(), events: [], consent: [], consentSeen: new Set(),
        diagnostics: [], userData: new Map(),
      });
    }
    return openai.pixels.get(id);
  };

  for (const req of fullRequests) {
    const phase = req.phase || '-';

    // Der CDN-Host liefert SDK und Config -- nie ein Event.
    if (isOpenAiSdkHost(getHostname(req.url) || '')) {
      const configId = openAiConfigPixelId(req.url);
      if (configId) {
        pixelEntry(configId);
        if (!openai.configFetches.some(c => c.pixelId === configId && c.phase === phase)) {
          openai.configFetches.push({ pixelId: configId, phase });
        }
      } else if (req.url.includes('/sdk/oaiq')) {
        openai.sdkLoads.add(phase);
      }
      continue;
    }

    for (const rec of parseOpenAiRequest(req.url, req.postData) || []) {
      const entry = pixelEntry(rec.pixelId || OPENAI_UNKNOWN_PIXEL);
      if (rec.sdkVersion) entry.sdkVersions.add(rec.sdkVersion);

      if (rec.diagnostic) entry.diagnostics.push({ phase, ...rec.diagnostic });

      if (rec.consent) {
        const key = `${phase}|${rec.consent.granted}|${rec.consent.source}`;
        if (!entry.consentSeen.has(key)) {
          entry.consentSeen.add(key);
          entry.consent.push({ phase, ...rec.consent });
        }
      }

      // openai::sdk_init und oai::diagnostic teilen den Transport mit echten
      // Events, sind aber keine Messung -- sie stehen in eigenen Bloecken.
      if (!rec.flags.internal) {
        entry.events.push({
          phase,
          event: rec.event,
          dataType: rec.dataType,
          revenue: rec.revenue,
          items: rec.flags.itemCount,
          dedupeId: rec.flags.dedupeId,
          optOut: rec.flags.optOut,
          standard: rec.flags.standardEvent,
        });
      }

      // Der user-Block haengt am Batch-Envelope, nicht am einzelnen Event -- also
      // Praesenz je Feld sammeln, nicht zaehlen. Die Phasen zeigen, ob schon vor
      // der Consent-Entscheidung Identifier geflossen sind.
      for (const [k, f] of Object.entries(rec.userData || {})) {
        const cur = entry.userData.get(k) || {
          bucket: f.bucket, source: f.source, hashed: f.hashed, algo: f.algo,
          values: f.list ? f.list.length : 1, phases: new Set(),
        };
        cur.values = Math.max(cur.values, f.list ? f.list.length : 1);
        cur.phases.add(phase);
        entry.userData.set(k, cur);
      }
    }
  }
}

/**
 * Runs all payload analyses on enriched request objects.
 * Called after each phase, accumulates findings into deepAnalysis.
 *
 * @param {Array} fullRequests - [{url, method, postData}]
 * @param {Array} cookies - current cookies
 * @param {string} siteHost - site URL for domain comparison
 * @param {object} deepAnalysis - reportData.deepAnalysis (mutated)
 */
function analyzeRequestPayloads(fullRequests, cookies, siteHost, deepAnalysis) {
  // 1. Stape transport decode
  const { transports, decodedRequests } = extractStapeFindings(fullRequests);
  for (const t of transports) {
    if (!deepAnalysis.stapeTransports.some(s => s.host === t.host)) {
      deepAnalysis.stapeTransports.push(t);
    }
  }

  // 1b. TAGGRS transport fingerprint (AES-verschluesselt -> nur Existenz, kein Decrypt)
  for (const t of extractTaggrsTransports(fullRequests)) {
    if (!deepAnalysis.taggrsTransports.some(s => s.host === t.host)) {
      deepAnalysis.taggrsTransports.push(t);
    }
  }

  // 2. Combine original + decoded URLs for analysis. Decoded URLs are rebuilt on
  // the canonical Google host so matchRequest() classifies the tunneled hits.
  const allRequests = [
    ...fullRequests,
    ...decodedRequests.map(d => ({ url: d.syntheticUrl, method: 'GET', postData: null })),
  ];

  // 3. Google sub-types collection
  for (const req of allRequests) {
    const match = matchRequest(req.url, siteHost);
    if (match && match.vendor === 'Google' && match.product) {
      deepAnalysis.googleSubTypes.add(match.product);
    }
  }

  // 4. Measurement IDs from decoded Stape URLs. Type is resolved via the synthetic
  // (Google-host) URL, but the reported host is the real first-party transport host.
  for (const d of decodedRequests) {
    try {
      const u = new URL(d.syntheticUrl);
      const id = u.searchParams.get('id') || u.searchParams.get('tid');
      if (id && /^(G|AW|GT|DC)-/i.test(id)) {
        const m = matchRequest(d.syntheticUrl, siteHost);
        deepAnalysis.measurementIds.push({
          id: id.toUpperCase(),
          type: m && m.product ? m.product : 'unknown',
          host: d.stapeHost,
        });
      }
    } catch { /* */ }
  }

  // 5. Enhanced Conversions (check GA4 collect requests)
  for (const req of allRequests) {
    // Enhanced Conversions ist GA4-spezifisch (/g/collect). Das generische "/collect"
    // wuerde fremde Endpunkte mit em-Param faelschlich als aktiv melden.
    const isCollect = req.url.includes('/g/collect');
    if (!isCollect) continue;
    const ec = checkEnhancedConversions(req.url, req.postData);
    if (ec && !deepAnalysis.features.enhancedConversions) {
      deepAnalysis.features.enhancedConversions = ec;
    }
  }

  // 6. Dynamic Remarketing (check Google Ads requests)
  for (const req of allRequests) {
    // Dynamic Remarketing laeuft ueber Google-Ads-Hosts. Reine URL-Substrings
    // ("/pagead/", "googleads") matchen sonst auch fremde Endpunkte.
    const adsHost = getHostname(req.url) || '';
    const isGoogleAdsHost = adsHost.endsWith('doubleclick.net') || adsHost.endsWith('googleadservices.com') || adsHost.startsWith('googleads.');
    const isAds = isGoogleAdsHost && req.url.includes('/pagead/');
    if (!isAds) continue;
    const rm = checkRemarketingPayload(req.url, req.postData);
    if (rm) {
      deepAnalysis.features.remarketing.push(rm);
    }
  }

  // 7. Meta Setup (once, uses all requests + cookies)
  if (!deepAnalysis.features.metaSetup) {
    deepAnalysis.features.metaSetup = detectMetaSetup(allRequests, cookies, siteHost);
  }

  // 8. OpenAI Ads Pixel -- die Original-Requests, nicht allRequests: die Events
  // stehen im POST-Body, den die synthetischen Stape-URLs nicht tragen.
  analyzeOpenAiPixel(fullRequests, deepAnalysis.openai);
}

// ── Server-Side Tagging Detection ────────────────────────────────────────────

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
  const hasTaggrs = sstData.taggrsTransports && sstData.taggrsTransports.length > 0;
  return hasCustomLoader || hasCollect || hasCustomFromBody || hasTaggrs;
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
  // Normalfall append-only -> nur die neuen Eintraege ab before.length. Bei SPA-Reset
  // (dataLayer neu initialisiert) ist after KEIN Praefix-Anhang von before; dann waere
  // slice(before.length) falsch (verloere Eintraege) -> ganzes after zurueckgeben.
  const isAppendOnly = after.length >= before.length &&
    before.every((e, i) => JSON.stringify(e) === JSON.stringify(after[i]));
  return isAppendOnly ? after.slice(before.length) : after;
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
 * When phase is provided, each request is tagged for HAR export.
 */
function setupRequestCollector(page, phase = 'unknown') {
  const requests = [];
  page.on('request', (req) => {
    requests.push({
      url: req.url(),
      method: req.method(),
      headers: req.headers(),
      postData: req.method() === 'POST' ? (req.postData() || null) : null,
      phase,
      startTime: Date.now(),
    });
  });
  page.on('response', (resp) => {
    const entry = requests.findLast(r => r.url === resp.url() && !r.status);
    if (entry) {
      entry.status = resp.status();
      entry.responseHeaders = resp.headers();
      entry.endTime = Date.now();
    }
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
 * Sammelt den Zustand nach einer Consent-Entscheidung -- identisch fuer Phase 2
 * (Post-Accept) und Phase 4 (Post-Reject): dataLayer-Diff, klassifizierte Tracker
 * (inkl. Stape) sowie Cookie-/localStorage-Diff gegen eine Pre-Consent-Baseline.
 * Consent-Mode- und SST-Auswertung bleiben phasenspezifisch beim Aufrufer.
 *
 * @param {object} baseline - { dataLayer, cookies, localStorage } aus der Pre-Consent-Phase
 * @returns {Promise<object>} Rohwerte + Diffs: { dataLayer, dataLayerDiff, requestUrls,
 *   classified, trackers, cookies, localStorage, cookiesDiff, localStorageDiff }
 */
async function collectPostConsentState(page, context, siteHost, getRequests, baseline, noPayloadAnalysis) {
  const dataLayer = await collectDataLayer(page);
  const dataLayerDiff = diffDataLayer(baseline.dataLayer, dataLayer);
  console.log(`  dataLayer Diff: ${dataLayerDiff.length} neue Eintraege`);

  const requestUrls = getRequests();
  const classified = requestUrls.map(r => matchRequest(r, siteHost)).filter(Boolean);
  const stapeMatches = noPayloadAnalysis ? [] : extractStapeMatches(getRequests.full(), siteHost);
  const trackers = deduplicateMatches([...classified, ...stapeMatches]);
  console.log(`  Neue Requests: ${requestUrls.length} total, ${classified.length} third-party`);

  const cookies = await collectCookies(context);
  const localStorage = await collectLocalStorage(page);
  const cookiesDiff = diffCookies(baseline.cookies, cookies);
  const localStorageDiff = diffLocalStorage(baseline.localStorage, localStorage);
  console.log(`  Neue Cookies: ${cookiesDiff.length}, Neue localStorage Keys: ${Object.keys(localStorageDiff).length}`);

  return { dataLayer, dataLayerDiff, requestUrls, classified, trackers, cookies, localStorage, cookiesDiff, localStorageDiff };
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

async function tryCMPSelectors(page, library, { signal } = {}) {
  const entries = Object.entries(library);

  // Paralleler Visibility-Check: alle CMPs gleichzeitig, kein Timeout
  const visResults = await Promise.all(
    entries.map(async ([, entry]) => {
      try { return await page.locator(entry.accept).first().isVisible(); }
      catch { return false; }
    })
  );
  if (signal?.skipped) return [];

  const matches = [];
  for (let i = 0; i < entries.length; i++) {
    if (visResults[i]) {
      const [key, entry] = entries[i];
      matches.push({ key, ...entry });
    }
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
  // Erster Durchlauf: paralleler Schnell-Scan
  await updateStatusBar(page, 'Phase 0', 'Schnell-Scan...', 'Prüfe bekannte CMPs');
  let matches = await tryCMPSelectors(page, library);
  let result = await disambiguateCMP(page, matches);
  if (result) return result;

  // Scroll-Retry: manche CMPs (z.B. Borlabs) erscheinen erst nach Scroll
  console.log('  Kein CMP-Banner gefunden, versuche Scroll...');
  await updateStatusBar(page, 'Phase 0', 'Scroll-Retry...', 'Kein Banner beim 1. Durchlauf');
  await page.evaluate(() => window.scrollBy(0, 400));
  await page.waitForTimeout(2000);

  matches = await tryCMPSelectors(page, library);
  result = await disambiguateCMP(page, matches);
  if (result) {
    console.log('  CMP nach Scroll erkannt!');
    return result;
  }

  // Keine bekannte CMP gefunden – Dropdown zur Auswahl anzeigen, sonst manueller Modus
  console.log('  Keine bekannte CMP gefunden – zeige CMP-Auswahl...');
  await updateStatusBar(page, 'Phase 0', 'CMP nicht erkannt', 'Bitte CMP wählen oder manueller Modus startet');

  const cmpEntries = Object.entries(library)
    .map(([key, entry]) => ({ key, name: entry.name || key }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const userChoice = await enableCMPSelect(page, cmpEntries);
  if (userChoice.type === 'select') {
    console.log(`  CMP manuell gewählt: ${library[userChoice.key].name}`);
    return { key: userChoice.key, ...library[userChoice.key] };
  }
  return null;
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

  // Look for an actual update signal: either en=consent_update, or any gcs value
  // that indicates granted consent (G1x1 / G11x pattern) and differs from preGcs.
  const postUpdate = postParams.find(p =>
    p.event === 'consent_update' || (p.gcs && p.gcs !== '-' && p.gcs !== preGcs && /^G1[01][01]$/.test(p.gcs))
  );
  const postEntry = postUpdate || (postParams.length > 0 ? postParams[0] : null);
  const postGcs = postEntry ? postEntry.gcs : null;
  const postGcd = postEntry ? postEntry.gcd : null;

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
    return { preGcs, postGcs, postGcd, ecomGcs, status: 'no_consent_mode' };
  }

  // Check if post-accept shows an update (G100 → G1xx where at least one digit changed)
  if (!postUpdate) {
    return { preGcs, postGcs, postGcd, ecomGcs, status: 'no_update' };
  }

  // Post-accept updated – check E-Commerce steps for stale values
  const hasStaleEcom = ecomGcs.some(e => e.gcs === preGcs);
  if (hasStaleEcom) {
    return { preGcs, postGcs, postGcd, ecomGcs, status: 'ecom_stale' };
  }

  return { preGcs, postGcs, postGcd, ecomGcs, status: 'update_ok' };
}

// ── HAR Export ────────────────────────────────────────────────────────────────

function buildHAR(collectors, pageUrl) {
  const allRequests = collectors.flatMap(c => c.full());
  const entries = allRequests.map(r => ({
    startedDateTime: new Date(r.startTime).toISOString(),
    time: r.endTime ? r.endTime - r.startTime : 0,
    request: {
      method: r.method,
      url: r.url,
      httpVersion: 'HTTP/1.1',
      headers: Object.entries(r.headers || {}).map(([name, value]) => ({ name, value })),
      queryString: (() => {
        try { return [...new URL(r.url).searchParams].map(([name, value]) => ({ name, value })); }
        catch { return []; }
      })(),
      cookies: [],
      headersSize: -1,
      bodySize: r.postData ? r.postData.length : 0,
      ...(r.postData ? { postData: { mimeType: 'application/x-www-form-urlencoded', text: r.postData } } : {}),
    },
    response: {
      status: r.status || 0,
      statusText: '',
      httpVersion: 'HTTP/1.1',
      headers: Object.entries(r.responseHeaders || {}).map(([name, value]) => ({ name, value })),
      cookies: [],
      content: { size: 0, mimeType: '' },
      redirectURL: '',
      headersSize: -1,
      bodySize: -1,
    },
    cache: {},
    timings: { send: 0, wait: r.endTime ? r.endTime - r.startTime : 0, receive: 0 },
    _phase: r.phase,
  }));

  return {
    log: {
      version: '1.2',
      creator: { name: 'audit.js', version: '1.0' },
      pages: [{
        startedDateTime: entries.length > 0 ? entries[0].startedDateTime : new Date().toISOString(),
        id: 'page_1',
        title: `Audit: ${pageUrl}`,
        pageTimings: {},
      }],
      entries,
    },
  };
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
  const known = deduped.filter(d => d.key !== null);
  const other = deduped.filter(d => d.key === null);

  let md = '';

  md += '#### Bekannte Tracker\n\n';
  if (!known.length) {
    md += '_Keine bekannten Tracker._\n\n';
  } else {
    md += '| Produkt | Kategorie | Richtung | Typen |\n';
    md += '|---------|-----------|----------|-------|\n';
    for (const d of known) {
      const dirs = d.directions.join(', ');
      const types = d.types.length > 0 ? d.types.join(', ') : '-';
      md += `| ${d.product} | ${d.category || '-'} | ${dirs} | ${types} |\n`;
    }
    md += '\n';
  }

  md += '#### Sonstige Third-Party\n\n';
  if (!other.length) {
    md += '_Keine sonstigen Third-Party Requests._\n\n';
  } else {
    md += '| Hostname |\n';
    md += '|----------|\n';
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
  let md = '| gcs | gcd | Event | Request URL |\n';
  md += '|-----|-----|-------|-------------|\n';
  for (const p of params) {
    md += `| ${p.gcs} | ${p.gcd} | ${p.event || '–'} | \`${p.url}\` |\n`;
  }
  return md;
}

function formatSSTSection(sstData) {
  if (!sstData || !hasSSTDetected(sstData)) return '';

  let md = '## Server-Side Tagging Analyse\n\n';

  // Stape Custom Loader transport
  if (sstData.stapeTransports && sstData.stapeTransports.length > 0) {
    md += '**Custom Loader Transport (Stape):**\n\n';
    for (const t of sstData.stapeTransports) {
      md += `- ${t.host} – Base64-encodierter Transport erkannt\n`;
    }
    md += '\n';
  }

  // TAGGRS Custom Loader transport (AES-verschluesselt -- nur Existenz nachweisbar)
  if (sstData.taggrsTransports && sstData.taggrsTransports.length > 0) {
    md += '**Custom Loader Transport (TAGGRS):**\n\n';
    for (const t of sstData.taggrsTransports) {
      md += `- ${t.host} – AES-verschluesselter Envelope erkannt\n`;
    }
    md += '\n> Der TAGGRS-Loader tunnelt die Hits verschluesselt. Die **Existenz** des serverseitigen Trackings ist damit belegt; die **Detail-Parameter** (Events, IDs, Consent-Mode-Status) sind aus dem Netzwerk-Mitschnitt nicht auslesbar.\n\n';
  }

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

function formatCSPViolationsSection(violations) {
  if (!violations || violations.length === 0) return '';

  let md = '## CSP-Blockaden\n\n';
  md += '| Blockierte Ressource | Direktive |\n';
  md += '|----------------------|-----------|\n';

  for (const v of violations) {
    const match = matchRequest(v.blockedURI, 'csp-check.invalid');
    const vendor = match ? (match.product || match.vendor) : 'Unbekannt';
    const vendorLabel = vendor && vendor !== 'Sonstige Third-Party' ? ` (${vendor})` : '';
    md += `| ${v.blockedURI}${vendorLabel} | ${v.effectiveDirective} |\n`;
  }
  md += '\n';

  return md;
}

function formatTrackingFeaturesSection(deepAnalysis) {
  if (!deepAnalysis) return '';

  const { features, measurementIds } = deepAnalysis;
  const hasFindings = features.enhancedConversions?.active ||
                      features.remarketing.length > 0 ||
                      (features.metaSetup && (features.metaSetup.hasBrowserPixel || features.metaSetup.hasFirstPartyEvents || features.metaSetup.hasFbpCookie));

  if (!hasFindings && measurementIds.length === 0) return '';

  let md = '## Tracking Features\n\n';

  if (measurementIds.length > 0) {
    md += '**Erkannte Tag-IDs (aus Payload-Analyse):**\n\n';
    md += '| Typ | ID | Host |\n';
    md += '|-----|----|------|\n';
    for (const m of measurementIds) {
      md += `| ${m.type} | ${m.id} | ${m.host} |\n`;
    }
    md += '\n';
  }

  if (features.enhancedConversions?.active) {
    const ec = features.enhancedConversions;
    md += '**Enhanced Conversions (Google)**\n';
    md += `- ✓ Aktiv${ec.hasHashedEmail ? ' (hashed email vorhanden)' : ''}\n`;
    if (ec.eventName) md += `- Event: ${ec.eventName}\n`;
    md += '\n';
  }

  if (features.remarketing.length > 0) {
    md += '**Dynamic Remarketing (Google Ads)**\n';
    const withProducts = features.remarketing.filter(r => r.hasProductIds);
    const pageTypes = [...new Set(features.remarketing.map(r => r.pageType).filter(Boolean))];
    if (withProducts.length > 0) md += `- ✓ Produkt-IDs in ${withProducts.length} Request(s)\n`;
    if (pageTypes.length > 0) md += `- Seitentypen: ${pageTypes.join(', ')}\n`;
    md += '\n';
  }

  if (features.metaSetup) {
    const ms = features.metaSetup;
    md += '**Meta**\n';
    if (ms.blockedByCSP) md += '- ⚠ Browser Pixel durch CSP blockiert (connect.facebook.net)\n';
    else if (ms.hasBrowserPixel) md += '- Browser Pixel aktiv (connect.facebook.net)\n';
    if (ms.hasFirstPartyEvents) md += '- ✓ First-Party Events Endpunkt erkannt (CAPI-Indikator)\n';
    if (!ms.hasBrowserPixel && ms.hasFbpCookie) md += '- _fbp Cookie ohne Browser Pixel (vermutlich CAPI-only)\n';
    if (ms.hasBrowserPixel && !ms.hasFirstPartyEvents) md += '- ⚠ Kein CAPI-Endpunkt erkannt\n';
    md += '\n';
  }

  return md;
}

const OPENAI_SOURCE_LABELS = [
  ['in', 'init'],
  ['fm', 'Formular (auto)'],
  ['js', 'JS-Variable (auto)'],
  ['ht', 'HTML (auto)'],
];

const OPENAI_BUCKET_LABELS = [
  ['email', 'E-Mail'], ['phone', 'Telefon'],
  ['firstName', 'Vorname'], ['lastName', 'Nachname'],
  ['externalId', 'Externe ID'],
  ['country', 'Land'], ['region', 'Region'], ['city', 'Stadt'], ['postal', 'PLZ'],
];

// Phasen, die vor einer Consent-Entscheidung liegen. Ein Event oder Identifier
// hier ist der eigentliche Befund -- das Pixel misst per Default.
const PRE_CONSENT_PHASES = new Set(['pre-consent', 'reject-pre']);

function openAiConsentLabel(c) {
  if (c.granted === false) return 'verweigert';
  if (c.granted === true) {
    return c.source === 'diagnostic' ? 'erteilt (Diagnostic)' : 'nicht verweigert (voller Payload)';
  }
  return 'unbekannt';
}

function formatOpenAiSection(openai) {
  if (!openai) return '';
  const hasEvents = [...openai.pixels.values()].some(p => p.events.length > 0);
  if (!openai.pixels.size && !openai.sdkLoads.size) return '';

  let md = '## OpenAI Ads Pixel\n\n';

  // Die Zustaende ohne Events unterscheiden sich an FEHLENDEN Requests, nicht an
  // vorhandenen -- deshalb hier explizit benannt. Eine ID kann aus dem Config-Pfad
  // ODER aus ?pid= eines Marker-Requests stammen.
  const knownIds = [...openai.pixels.keys()].filter(id => id !== OPENAI_UNKNOWN_PIXEL);
  const denied = [...openai.pixels.values()].some(p => p.consent.some(c => c.granted === false));

  if (!hasEvents) {
    if (denied) {
      md += 'Consent verweigert. Das SDK laedt trotzdem -- die Einwilligung steuert nur den '
          + 'Config-Fetch und die Messung, nicht den Download. Gesendet wurde allein der '
          + 'Session-Marker des Pixels, ohne Identifier.\n\n';
    } else if (!knownIds.length) {
      md += 'SDK geladen, aber weder Config-Fetch noch Events. Das Pixel ist verbaut, seine ID '
          + 'bleibt unbekannt: entweder wurde Consent verweigert (dann unterbleibt der '
          + 'Config-Fetch) oder das Pixel wurde nie initialisiert.\n\n';
    } else {
      md += 'Pixel initialisiert und Consent nicht verweigert -- gemessen wurde in diesem Audit '
          + 'trotzdem nichts.\n\n';
    }
  }

  if (openai.sdkLoads.size) {
    md += `**SDK geladen in Phase(n):** ${[...openai.sdkLoads].join(', ')}\n\n`;
  }

  for (const [pixelId, p] of openai.pixels) {
    md += `### Pixel ${pixelId}\n\n`;

    const sdk = [...p.sdkVersions];
    const cfgPhases = openai.configFetches.filter(c => c.pixelId === pixelId).map(c => c.phase);
    if (sdk.length) md += `- SDK-Version: ${sdk.join(', ')}\n`;
    if (cfgPhases.length) md += `- Config-Fetch in Phase(n): ${[...new Set(cfgPhases)].join(', ')}\n`;
    if (sdk.length || cfgPhases.length) md += '\n';

    if (p.consent.length) {
      md += '**Consent-Zustand laut Pixel**\n\n';
      md += '| Phase | Zustand | Transport |\n';
      md += '|-------|---------|----------|\n';
      for (const c of p.consent) {
        md += `| ${c.phase} | ${openAiConsentLabel(c)} | ${c.credentialless ? 'ohne Credentials' : 'vollstaendig'} |\n`;
      }
      md += '\n';
      // Der Hinweis gilt nur fuer erteilten Consent -- unter einer Tabelle, die
      // "verweigert" sagt, waere er irrefuehrend.
      if (p.consent.some(c => c.granted === true)) {
        md += 'Das Pixel kennt weder TCF noch Consent Mode und misst per Default. '
            + '"Nie gefragt" und "aktiv zugestimmt" sind auf der Leitung nicht unterscheidbar -- '
            + 'beides meldet das Pixel als erteilt.\n\n';
      }
    }

    if (p.events.length) {
      md += '**Events**\n\n';
      md += '| Phase | Event | Typ | Betrag | Items | Dedup-ID |\n';
      md += '|-------|-------|-----|--------|-------|----------|\n';
      for (const e of p.events) {
        const betrag = e.revenue && e.revenue.value
          ? `${String(e.revenue.value).replace('.', ',')} ${e.revenue.currency || ''}`.trim()
          : '-';
        const name = e.standard ? e.event : `${e.event} (custom)`;
        md += `| ${e.phase} | ${name}${e.optOut ? ' ⚠ opt_out' : ''} | ${e.dataType || '-'} | `
            + `${betrag} | ${e.items || '-'} | ${e.dedupeId ? 'ja' : '-'} |\n`;
      }
      md += '\n';

      const preConsent = p.events.filter(e => PRE_CONSENT_PHASES.has(e.phase));
      if (preConsent.length) {
        md += `⚠ ${preConsent.length} Event(s) vor der Consent-Entscheidung gefeuert.\n\n`;
      }
    }

    const diag = p.diagnostics;
    if (diag.length) {
      const aam = diag.map(d => d.autoMatching).find(Boolean);
      if (aam) md += `**Automatic Advanced Matching (Konto-Einstellung):** ${aam}\n\n`;

      const dropped = diag.filter(d => d.droppedCount > 0);
      if (dropped.length) {
        md += '**Vom Pixel verworfene Events**\n\n';
        for (const d of dropped) {
          const reasons = d.droppedReasons
            ? Object.entries(d.droppedReasons).map(([r, n]) => `${r}: ${n}`).join(', ') : '-';
          const names = d.droppedNames ? Object.keys(d.droppedNames).join(', ') : null;
          md += `- ⚠ ${d.droppedCount} verworfen in Phase ${d.phase} (${reasons})`;
          md += names ? ` -- betroffen: ${names}\n` : '\n';
        }
        md += '\nDas Pixel meldet fehlerhafte Aufrufe selbst. Verworfene Events werden nicht '
            + 'gesendet und sind sonst unsichtbar -- die Zahl kommt aus dem Diagnostic-Event.\n\n';
      }
    }

    if (p.userData.size) {
      const sources = OPENAI_SOURCE_LABELS.filter(([src]) =>
        [...p.userData.values()].some(f => f.source === src));

      md += '**User-Daten nach Herkunft**\n\n';
      md += `| Feld | ${sources.map(([, l]) => l).join(' | ')} |\n`;
      md += `|------|${sources.map(() => '------').join('|')}|\n`;
      for (const [bucket, label] of OPENAI_BUCKET_LABELS) {
        const cells = sources.map(([src]) => {
          const f = [...p.userData.values()].find(v => v.bucket === bucket && v.source === src);
          if (!f) return '-';
          const form = f.hashed ? (f.algo === 'sha256' ? 'SHA-256' : f.algo) : 'Klartext';
          return f.values > 1 ? `${form} (${f.values} Werte)` : form;
        });
        if (cells.every(c => c === '-')) continue;
        md += `| ${label} | ${cells.join(' | ')} |\n`;
      }
      md += '\n';

      const auto = [...p.userData.values()].some(f => f.source !== 'in');
      if (auto) {
        md += 'Die auto-Spalten hat das SDK selbst von der Seite gelesen (Automatic Advanced '
            + 'Matching), nicht die Website uebergeben. Geo-Felder werden bauartbedingt im '
            + 'Klartext uebertragen.\n\n';
      }
      const early = [...p.userData.values()].filter(f => [...f.phases].some(ph => PRE_CONSENT_PHASES.has(ph)));
      if (early.length) {
        md += '⚠ Identifier flossen bereits vor der Consent-Entscheidung.\n\n';
      }
    }
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
  const cmtForSummary = data.consentModeTransition;
  // Prefer the transition-detected post-accept entry (finds the real G1xx update
  // even if an earlier request with gcs=- appeared first in the array).
  const postAcceptGcs = cmtForSummary && cmtForSummary.postGcs
    ? { gcs: cmtForSummary.postGcs, gcd: cmtForSummary.postGcd || '-' }
    : data.postAccept.consentMode?.[0];
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

  // Collect all product keys
  const allProducts = new Set();
  for (const t of [...preKnown, ...acceptKnown, ...rejectKnown]) allProducts.add(t.key || t.vendor);

  if (allProducts.size > 0) {
    md += '**Bekannte Tracker nach Consent-Phase:**\n\n';
    md += '| Produkt | Pre-Consent | Post-Accept | Post-Reject |\n';
    md += '|---------|-------------|-------------|-------------|\n';
    for (const prodKey of allProducts) {
      const pre = preKnown.find(t => (t.key || t.vendor) === prodKey);
      const accept = acceptKnown.find(t => (t.key || t.vendor) === prodKey);
      const reject = rejectKnown.find(t => (t.key || t.vendor) === prodKey);
      const label = (pre || accept || reject).product || prodKey;
      md += `| ${label} | ${pre ? 'ja' : '–'} | ${accept ? 'ja' : '–'} | ${reject ? 'ja' : '–'} |\n`;
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

  // SST summary (merged: response-body detection + Stape transport)
  {
    const hasSST = data.sst && hasSSTDetected(data.sst);
    const stapeHosts = data.deepAnalysis?.stapeTransports?.map(t => t.host) || [];
    if (hasSST || stapeHosts.length > 0) {
      const parts = [];
      if (hasSST) {
        const customLoaderCount = data.sst.loaders.filter(l => !l.isStandard).length + (data.sst.customLoaders?.length || 0);
        const collectCount = data.sst.collectEndpoints.length;
        parts.push(`${customLoaderCount} Custom Loader, ${collectCount} Collect Endpoints`);
      }
      if (stapeHosts.length > 0) {
        parts.push(`Stape-Transport auf ${stapeHosts.join(', ')}`);
      }
      md += `**Server-Side Tagging:** ${parts.join(' | ')}\n\n`;
    }
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
        .map(t => t.product || t.vendor)
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

  // Deep Analysis findings
  if (data.deepAnalysis) {
    const da = data.deepAnalysis;

    // CSP Violations
    if (da.cspViolations.length > 0) {
      md += `**⚠ CSP blockiert ${da.cspViolations.length} Tracking-Request${da.cspViolations.length > 1 ? 's' : ''}**\n\n`;
    }

    // Enhanced Conversions
    if (da.features.enhancedConversions?.active) {
      const detail = da.features.enhancedConversions.hasHashedEmail ? ' (hashed email)' : '';
      md += `**✓ Enhanced Conversions aktiv${detail}**\n\n`;
    }

    // Dynamic Remarketing
    if (da.features.remarketing.length > 0) {
      const withProducts = da.features.remarketing.filter(r => r.hasProductIds);
      if (withProducts.length > 0) {
        md += `**✓ Dynamic Remarketing: Produkt-IDs in ${withProducts.length} Ads-Request${withProducts.length > 1 ? 's' : ''}**\n\n`;
      }
    }

    // Meta Setup
    if (da.features.metaSetup) {
      const ms = da.features.metaSetup;
      if (ms.blockedByCSP) {
        // Don't add Meta TL;DR line – CSP blockade is already shown in CSP section
      } else if (ms.hasBrowserPixel && ms.hasFirstPartyEvents) {
        md += '**Meta:** Browser Pixel + First-Party Events Endpunkt (CAPI-Indikator)\n\n';
      } else if (ms.hasBrowserPixel && !ms.hasFirstPartyEvents) {
        md += '**⚠ Meta:** Browser Pixel aktiv, kein CAPI-Endpunkt erkannt\n\n';
      } else if (!ms.hasBrowserPixel && ms.hasFbpCookie) {
        md += '**Meta:** Kein Browser Pixel, aber _fbp Cookie – vermutlich CAPI-only\n\n';
      }
    }
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

  // Merge Stape/TAGGRS transport findings into SST data for display
  if (data.deepAnalysis?.stapeTransports?.length > 0 || data.deepAnalysis?.taggrsTransports?.length > 0) {
    if (!data.sst) data.sst = { containers: new Set(), measurementIds: new Set(), loaders: [], collectEndpoints: [] };
    data.sst.stapeTransports = data.deepAnalysis.stapeTransports;
    data.sst.taggrsTransports = data.deepAnalysis.taggrsTransports;
  }

  // ── SST ──
  md += formatSSTSection(data.sst);

  // ── CSP Violations ──
  if (data.deepAnalysis) {
    md += formatCSPViolationsSection(data.deepAnalysis.cspViolations);
  }

  // ── Tracking Features ──
  if (data.deepAnalysis) {
    md += formatTrackingFeaturesSection(data.deepAnalysis);
  }

  // ── OpenAI Ads Pixel ──
  if (data.deepAnalysis) {
    md += formatOpenAiSection(data.deepAnalysis.openai);
  }

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
      md += `- **${t.product || t.vendor}**: ${t.hostnames.join(', ')}\n`;
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
        .map(t => `${t.product || t.vendor} (${t.hostnames.join(', ')})`)
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
async function collectEcomStepData(page, context, step, prevCookies, prevLocalStorage, prevDataLayer, siteHost, harCollectors = []) {
  const getStepRequests = setupRequestCollector(page, `ecom-${step.name}`);
  harCollectors.push(getStepRequests);
  await waitForSettle(page, 3000);

  const stepDataLayer = await collectDataLayer(page);
  const stepBaseline = step.type === 'navigate' ? [] : prevDataLayer;
  const stepDataLayerDiff = diffDataLayer(stepBaseline, stepDataLayer);

  const stepRequestUrls = getStepRequests();
  const stepFullRequests = getStepRequests.full();
  const stepClassified = stepRequestUrls.map(r => matchRequest(r, siteHost)).filter(Boolean);
  const stepStapeMatches = noPayloadAnalysis ? [] : extractStapeMatches(stepFullRequests, siteHost);
  const stepTrackers = deduplicateMatches([...stepClassified, ...stepStapeMatches]);

  const stepConsentMode = extractConsentModeParams(stepRequestUrls);

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
  if (exportHAR) console.log(` HAR-Export: aktiviert`);
  console.log(`=======================================\n`);

  const library = loadLibrary();
  const siteHost = url;
  const harCollectors = []; // all request collectors for HAR export

  // ── Phase 0: CMP Detection ─────────────────────────────────────────────────

  console.log('Phase 0: CMP-Erkennung...');

  let cmp;

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

  const browser1 = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
  const context1 = await browser1.newContext();
  let page1 = await context1.newPage();

  let getPreRequests = setupRequestCollector(page1, 'pre-consent');
  harCollectors.push(getPreRequests);

  // Neu geoeffnete Tabs im selben Context (z.B. Produktseiten, die per
  // target="_blank" oeffnen) bekommen sofort einen eigenen Request-Collector,
  // sonst sind ihre Requests (u.a. GA4-Hits) fuer den Audit unsichtbar, weil
  // page.on('request') strikt pro Page-Objekt gilt.
  context1.on('page', (newPage) => {
    console.log(`  Neuer Tab geoeffnet (${newPage.url() || 'wird geladen...'})`);
    const getNewTabRequests = setupRequestCollector(newPage, 'new-tab');
    harCollectors.push(getNewTabRequests);
  });

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
  let manualOverride = false;
  if (!cmp) {
    await updateStatusBar(page1, 'Phase 0', 'Starte CMP-Erkennung...');
    cmp = await detectCMP(page1, library);
    if (!cmp) {
      console.log('  CMP nicht automatisch erkannt – manueller Modus aktiv');
    }
  }

  // After CMP detection (auto or --cmp flag): show override button
  if (cmp) {
    const { overridePromise } = await showCMPOverride(page1, cmp.name);
    overridePromise.then(() => {
      manualOverride = true;
      console.log('  Manueller Modus aktiviert (Override)');
    });
  }

  const reportData = {
    project,
    url,
    cmpName: cmp ? cmp.name : '(manuell)',
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
      taggrsTransports: [],
      googleSubTypes: new Set(),
      measurementIds: [],
      openai: {
        sdkLoads: new Set(),   // Phasen mit oaiq-SDK-Load (ohne dass eine ID bekannt waere)
        configFetches: [],     // { pixelId, phase } -- belegt ein Pixel auch ohne Event
        pixels: new Map(),
      },
    },
    sst: null,
  };

  const cmpLabel = cmp ? cmp.name : '(manuell)';
  await showStatusBar(page1, 'Phase 1', `Pre-Consent – CMP: ${cmpLabel}`, 'Sammle Daten...');
  await updateStatusBar(page1, 'Phase 1', `Pre-Consent – CMP: ${cmpLabel}`, 'Sammle Daten...');

  // dataLayer
  const preDataLayer = await collectDataLayer(page1);
  console.log(`  dataLayer: ${preDataLayer.length} Eintraege`);

  // Network requests
  const preRequestUrls = getPreRequests();
  const preClassified = preRequestUrls.map(r => matchRequest(r, siteHost)).filter(Boolean);
  const preStapeMatches = noPayloadAnalysis ? [] : extractStapeMatches(getPreRequests.full(), siteHost);
  const preTrackers = deduplicateMatches([...preClassified, ...preStapeMatches]);
  console.log(`  Requests: ${preRequestUrls.length} total, ${preClassified.length} third-party`);
  await updateStatusBar(page1, 'Phase 1', `Pre-Consent – CMP: ${cmpLabel}`, `DL: ${preDataLayer.length} | 3P: ${preClassified.length}`);

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
  const preConsentMode = extractConsentModeParams(preRequestUrls);

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

  // Deep Analysis: Phase 1
  if (!noPayloadAnalysis) {
    const preFullRequests = getPreRequests.full();
    analyzeRequestPayloads(preFullRequests, preCookies, siteHost, reportData.deepAnalysis);
  }

  // ── Phase 2: Post-Accept (same browser) ─────────────────────────────────────

  console.log('\nPhase 2: Post-Accept...');
  await updateStatusBar(page1, 'Phase 2', 'Post-Accept – klicke Accept...', '');

  // Clear request collector and set up fresh one for this phase
  const getPostAcceptRequests = setupRequestCollector(page1, 'post-accept');
  harCollectors.push(getPostAcceptRequests);
  const getPostAcceptResponseBodies = setupResponseBodyCollector(page1, siteHost);

  // Click accept – auto-click if CMP known (and not overridden), otherwise manual consent card
  let acceptClicked = false;
  if (cmp && !manualOverride) {
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
  }

  if (!acceptClicked) {
    console.log('  Accept manuell – zeige Consent-Card...');
    await updateStatusBar(page1, 'Phase 2', 'Warte auf manuellen Accept...', '');
    await showConsentCard(page1, 'ACCEPT');
    await removeConsentCard(page1);
    acceptClicked = true;
    console.log('  Accept manuell bestaetigt');
  }

  await waitForSettle(page1, 3000);

  // Post-Accept-Zustand einsammeln (dataLayer-, Tracker-, Cookie-/localStorage-Diff);
  // Consent-Mode- und SST-Auswertung folgen phasenspezifisch weiter unten.
  const postAccept = await collectPostConsentState(
    page1, context1, siteHost, getPostAcceptRequests,
    { dataLayer: preDataLayer, cookies: preCookies, localStorage: preLocalStorage },
    noPayloadAnalysis,
  );
  const postAcceptDataLayer = postAccept.dataLayer;
  const postAcceptDataLayerDiff = postAccept.dataLayerDiff;
  const postAcceptRequestUrls = postAccept.requestUrls;
  const postAcceptTrackers = postAccept.trackers;
  const postAcceptCookies = postAccept.cookies;
  const postAcceptLocalStorage = postAccept.localStorage;
  const postAcceptCookiesDiff = postAccept.cookiesDiff;
  const postAcceptLocalStorageDiff = postAccept.localStorageDiff;
  await updateStatusBar(page1, 'Phase 2', 'Post-Accept – Daten gesammelt', `DL: +${postAcceptDataLayerDiff.length} | 3P: +${postAccept.classified.length}`);

  // Consent Mode params after accept
  const postAcceptConsentMode = extractConsentModeParams(postAcceptRequestUrls);

  reportData.postAccept = {
    dataLayerDiff: postAcceptDataLayerDiff,
    trackers: postAcceptTrackers,
    consentMode: postAcceptConsentMode,
    cookiesDiff: postAcceptCookiesDiff,
    localStorageDiff: postAcceptLocalStorageDiff,
  };

  // SST detection from post-accept requests + merge with pre-consent
  const postAcceptSSTUrls = detectSSTFromUrls(postAcceptRequestUrls, siteHost);
  // Stape Custom Loader: decodierte (Google-Host-)Synthetik-URLs ebenfalls in die
  // SST-Erkennung einspeisen -- sonst fehlen getunnelte Container/Measurement-IDs in
  // reportData.sst (sie tauchten bisher nur in der Deep-Analysis auf). Spiegelt compare.js/analyzeSide.
  const stapeDecoded = noPayloadAnalysis ? [] :
    extractStapeFindings([...getPreRequests.full(), ...getPostAcceptRequests.full()]).decodedRequests;
  const stapeSSTUrls = stapeDecoded.length > 0
    ? detectSSTFromUrls(stapeDecoded.map(d => d.syntheticUrl), siteHost)
    : null;
  reportData.sst = mergeSST(preSSTUrls, postAcceptSSTUrls, stapeSSTUrls);

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

  // Deep Analysis: Phase 2
  if (!noPayloadAnalysis) {
    const postAcceptFullRequests = getPostAcceptRequests.full();
    analyzeRequestPayloads(postAcceptFullRequests, postAcceptCookies, siteHost, reportData.deepAnalysis);
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
          const { action: prepAction, page: prepPage } = await showEcomStepPrompt(page1, step.name, i + 1, interactiveSteps.length, {
            nextLabel: 'Bereit',
            instruction: 'Bereite alles vor (Menge, Variante, Optionen...). Klicke "Bereit" wenn du gleich den Button klicken wirst.',
          }, context1);
          if (prepAction === 'done') {
            console.log(`  Audit abgeschlossen nach Schritt ${i} von ${interactiveSteps.length}`);
            break;
          }
          if (prepPage !== page1) {
            console.log(`  Neuer Tab erkannt, Tracking wechselt zu: ${prepPage.url()}`);
            page1.off('load', onLoadStatusBar);
            page1 = prepPage;
            page1.on('load', onLoadStatusBar);
          }

          // Collectors starten VOR dem Klick
          const getStepRequests = setupRequestCollector(page1, `ecom-${step.name}`);
          harCollectors.push(getStepRequests);
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
          const stepClassified = stepRequestUrls.map(r => matchRequest(r, siteHost)).filter(Boolean);
          const stepTrackers = deduplicateMatches(stepClassified);
          const stepConsentMode = extractConsentModeParams(stepRequestUrls);

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

          // Deep Analysis: E-Commerce Click-Step
          if (!noPayloadAnalysis) {
            const stepFullRequests = getStepRequests.full();
            analyzeRequestPayloads(stepFullRequests, stepCookies, siteHost, reportData.deepAnalysis);
          }

          prevCookies = stepCookies;
          prevLocalStorage = stepLocalStorage;
          prevDataLayer = dlAfterSettle;

        } else {
          // ── Navigate-Steps: User navigiert, dann bestätigt ──
          const { action, page: navPage } = await showEcomStepPrompt(page1, step.name, i + 1, interactiveSteps.length, {}, context1);
          if (action === 'done') {
            console.log(`  Audit abgeschlossen nach Schritt ${i} von ${interactiveSteps.length}`);
            break;
          }
          if (navPage !== page1) {
            console.log(`  Neuer Tab erkannt, Tracking wechselt zu: ${navPage.url()}`);
            page1.off('load', onLoadStatusBar);
            page1 = navPage;
            page1.on('load', onLoadStatusBar);
          }

          console.log(`  Schritt: ${step.name} (interaktiv)...`);

          const result = await collectEcomStepData(page1, context1, step, prevCookies, prevLocalStorage, prevDataLayer, siteHost, harCollectors);

          console.log(`    dataLayer Diff: ${result.data.dataLayerDiff.length}, Requests: ${result.stepClassified.length} 3P, Cookies: +${result.data.cookiesDiff.length}`);

          reportData.ecommerce.push(result.data);

          // Deep Analysis: E-Commerce Navigate-Step
          if (!noPayloadAnalysis && result.stepFullRequests) {
            analyzeRequestPayloads(result.stepFullRequests, result.stepCookies, siteHost, reportData.deepAnalysis);
          }

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

        // Deep Analysis: E-Commerce Step
        if (!noPayloadAnalysis && result.stepFullRequests) {
          analyzeRequestPayloads(result.stepFullRequests, result.stepCookies, siteHost, reportData.deepAnalysis);
        }

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

  const browser2 = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled'] });
  const context2 = await browser2.newContext();
  const page2 = await context2.newPage();

  // Pre-consent baseline in fresh browser
  const getRejectPreRequests = setupRequestCollector(page2, 'reject-pre');
  harCollectors.push(getRejectPreRequests);
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
  const getRejectPostRequests = setupRequestCollector(page2, 'post-reject');
  harCollectors.push(getRejectPostRequests);

  // Click reject – auto-click if CMP known (and not overridden), otherwise manual consent card
  let rejectClicked = false;

  if (cmp && !manualOverride) {
    // Scroll-Retry: CMP-Banner muss sichtbar sein vor Reject-Klick
    const rejectFirstSelector = (cmp.rejectSteps && cmp.rejectSteps.length >= 1) ? cmp.rejectSteps[0] : cmp.reject;
    try {
      await page2.locator(rejectFirstSelector).first().waitFor({ state: 'visible', timeout: 3000 });
    } catch {
      console.log('  CMP-Banner nicht sichtbar, versuche Scroll...');
      await page2.evaluate(() => window.scrollBy(0, 400));
      await page2.waitForTimeout(2000);
    }

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
  }

  if (!rejectClicked) {
    console.log('  Reject manuell – zeige Consent-Card...');
    await updateStatusBar(page2, 'Phase 4', 'Warte auf manuellen Reject...', '');
    await showConsentCard(page2, 'REJECT');
    await removeConsentCard(page2);
    rejectClicked = true;
    console.log('  Reject manuell bestaetigt');
  }

  await waitForSettle(page2, 3000);

  // Post-Reject-Zustand einsammeln (identische Sammel-Logik wie Post-Accept).
  const postReject = await collectPostConsentState(
    page2, context2, siteHost, getRejectPostRequests,
    { dataLayer: rejectPreDataLayer, cookies: rejectPreCookies, localStorage: rejectPreLocalStorage },
    noPayloadAnalysis,
  );
  const rejectDataLayerDiff = postReject.dataLayerDiff;
  const rejectPostTrackers = postReject.trackers;
  const rejectPostCookies = postReject.cookies;
  const rejectCookiesDiff = postReject.cookiesDiff;
  const rejectLocalStorageDiff = postReject.localStorageDiff;

  reportData.postReject = {
    dataLayerDiff: rejectDataLayerDiff,
    trackers: rejectPostTrackers,
    cookiesDiff: rejectCookiesDiff,
    localStorageDiff: rejectLocalStorageDiff,
  };

  // Deep Analysis: Phase 4
  if (!noPayloadAnalysis) {
    const rejectFullRequests = getRejectPostRequests.full();
    analyzeRequestPayloads(rejectFullRequests, rejectPostCookies, siteHost, reportData.deepAnalysis);
  }

  await updateStatusBar(page2, 'Phase 5', 'Fertig – Report wird generiert...', `DL: +${rejectDataLayerDiff.length} | 3P: +${postReject.classified.length}`);
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

  // Fix false positives: if Meta pixel was blocked by CSP, it's not actually active
  if (!noPayloadAnalysis && reportData.deepAnalysis.features.metaSetup) {
    const cspBlockedUrls = reportData.deepAnalysis.cspViolations.map(v => v.blockedURI);
    const metaBlockedByCSP = cspBlockedUrls.some(u => u.includes('connect.facebook.net'));
    if (metaBlockedByCSP && reportData.deepAnalysis.features.metaSetup.hasBrowserPixel) {
      reportData.deepAnalysis.features.metaSetup.hasBrowserPixel = false;
      reportData.deepAnalysis.features.metaSetup.blockedByCSP = true;
      // Re-check: if nothing remains, clear the metaSetup
      const ms = reportData.deepAnalysis.features.metaSetup;
      if (!ms.hasBrowserPixel && !ms.hasFirstPartyEvents && !ms.hasFbpCookie) {
        reportData.deepAnalysis.features.metaSetup = null;
      }
    }
  }

  // Deep Analysis summary
  if (!noPayloadAnalysis) {
    const da = reportData.deepAnalysis;
    if (da.stapeTransports.length > 0) {
      console.log(`  Stape-Transport: ${da.stapeTransports.map(t => t.host).join(', ')}`);
    }
    if (da.taggrsTransports.length > 0) {
      console.log(`  TAGGRS-Transport (verschluesselt): ${da.taggrsTransports.map(t => t.host).join(', ')}`);
    }
    if (da.features.enhancedConversions) {
      console.log(`  Enhanced Conversions: aktiv (hashed email: ${da.features.enhancedConversions.hasHashedEmail})`);
    }
    if (da.features.remarketing.length > 0) {
      console.log(`  Dynamic Remarketing: ${da.features.remarketing.length} Requests mit Produktdaten`);
    }
    if (da.features.metaSetup) {
      const ms = da.features.metaSetup;
      console.log(`  Meta: Pixel=${ms.hasBrowserPixel}, CAPI=${ms.hasFirstPartyEvents}, fbp=${ms.hasFbpCookie}`);
    }
    // Deduplicate measurement IDs
    const idMap = new Map();
    for (const m of da.measurementIds) {
      idMap.set(m.id, m);
    }
    da.measurementIds = [...idMap.values()];
    // Convert googleSubTypes Set to array for JSON serialization
    da.googleSubTypes = [...da.googleSubTypes];
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
  const hostSlug = (getHostname(url) || 'unknown').replace(/\./g, '_');
  const reportFile = resolve(reportDir, `audit-${hostSlug}-${timestamp}.md`);

  if (!existsSync(reportDir)) {
    mkdirSync(reportDir, { recursive: true });
  }

  const markdown = generateReport(reportData);
  writeFileSync(reportFile, markdown, 'utf-8');

  // HAR-Export (optional)
  let harFile = null;
  if (exportHAR) {
    const har = buildHAR(harCollectors, url);
    harFile = resolve(reportDir, `audit-${hostSlug}-${timestamp}.har`);
    writeFileSync(harFile, JSON.stringify(har, null, 2), 'utf-8');
  }

  console.log(`\n=======================================`);
  console.log(` Audit abgeschlossen!`);
  console.log(` Report: ${reportFile}`);
  if (harFile) console.log(` HAR:    ${harFile}`);
  console.log(`=======================================\n`);
})();
