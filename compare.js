#!/usr/bin/env node

/**
 * compare.js – Tracking Setup Vergleich zwischen zwei URLs
 *
 * Usage:
 *   node compare.js --url-a <url> --url-b <url> --project <name> [options]
 *
 * Required:
 *   --url-a       Erste URL (typischerweise Live/Referenz)
 *   --url-b       Zweite URL (Staging/Test)
 *   --project     Projektname (bestimmt Report-Pfad)
 *
 * Optional:
 *   --label-a             Anzeigename fuer Seite A (Default: Host aus url-a)
 *   --label-b             Anzeigename fuer Seite B (Default: Host aus url-b)
 *   --post-consent-wait   Wartezeit in ms nach Consent (Default: 5000)
 */

import { chromium } from 'playwright';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };

const urlA = get('--url-a');
const urlB = get('--url-b');
const project = get('--project');
const labelA = get('--label-a');
const labelB = get('--label-b');
const postConsentWait = parseInt(get('--post-consent-wait') || '5000', 10);

if (!urlA || !urlB || !project) {
  console.error('Usage: node compare.js --url-a <url> --url-b <url> --project <name>');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getHostname(urlStr) {
  try { return new URL(urlStr).hostname; } catch { return null; }
}

function getSiteDomain(urlStr) {
  const h = getHostname(urlStr);
  if (!h) return null;
  const parts = h.split('.');
  return parts.length >= 2 ? parts.slice(-2).join('.') : h;
}

function hostForFilename(urlStr) {
  const h = getHostname(urlStr);
  return h ? h.replace(/\./g, '_') : 'unknown';
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function truncate(str, max = 80) {
  if (!str) return '';
  const s = String(str);
  return s.length > max ? s.slice(0, max) + '...' : s;
}

const effectiveLabelA = labelA || getHostname(urlA) || 'Seite A';
const effectiveLabelB = labelB || getHostname(urlB) || 'Seite B';

// ── Tracking Domain Classification (from audit.js) ───────────────────────────

const TRACKING_DOMAINS = {
  'Google':    ['google-analytics.com', 'analytics.google.com', 'googletagmanager.com', 'doubleclick.net', 'googleadservices.com', 'googlesyndication.com', 'googleads.g.doubleclick.net'],
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

function getGoogleSubType(requestUrl) {
  try {
    const u = new URL(requestUrl);
    const host = u.hostname;
    const path = u.pathname;
    if (path.includes('/g/collect') || path.includes('/collect')) {
      const tid = u.searchParams.get('tid');
      if (tid && /^G-/i.test(tid)) return 'GA4';
    }
    if (path.includes('/gtag/js')) {
      const id = u.searchParams.get('id');
      if (id) {
        if (/^G-/i.test(id)) return 'GA4';
        if (/^AW-/i.test(id)) return 'Google Ads';
        if (/^GT-/i.test(id)) return 'Google Tag';
        if (/^DC-/i.test(id)) return 'Floodlight';
      }
    }
    if (path.includes('/pagead/conversion') || path.includes('/pagead/1p-user-list')) return 'Google Ads';
    if (host === 'googleads.g.doubleclick.net') return 'Google Ads';
    if (host === 'www.googleadservices.com') return 'Google Ads';
    if ((host === 'ad.doubleclick.net' || host === 'fls.doubleclick.net') &&
        (path.startsWith('/activity') || path.includes('/activity;'))) return 'Floodlight';
    return null;
  } catch { return null; }
}

function classifyRequest(requestUrl, siteHost) {
  const hostname = getHostname(requestUrl);
  if (!hostname) return null;
  const siteDomain = getSiteDomain(siteHost);
  const reqDomain = getSiteDomain(requestUrl);
  if (reqDomain === siteDomain) return null;
  for (const [vendor, domains] of Object.entries(TRACKING_DOMAINS)) {
    for (const d of domains) {
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

// ── Stape Custom Loader Detection (from audit.js) ────────────────────────────

function tryDecodeStapeTransport(requestUrl) {
  try {
    const u = new URL(requestUrl);
    for (const [key, value] of u.searchParams) {
      if (!value || value.length < 10) continue;
      try {
        const decoded = Buffer.from(decodeURIComponent(value), 'base64').toString('utf-8');
        if (decoded.startsWith('/gtag/js') ||
            decoded.startsWith('/g/collect') ||
            decoded.startsWith('/collect')) {
          return { host: u.hostname, encodedParam: key, decodedPath: decoded, originalUrl: requestUrl };
        }
      } catch { continue; }
    }
  } catch { /* invalid URL */ }
  return null;
}

function extractStapeFindings(fullRequests) {
  const transports = [];
  const decodedUrls = [];
  const seenHosts = new Set();
  for (const req of fullRequests) {
    const stape = tryDecodeStapeTransport(req.url);
    if (!stape) continue;
    if (!seenHosts.has(stape.host)) {
      seenHosts.add(stape.host);
      transports.push({ host: stape.host, type: 'Stape Custom Loader' });
    }
    try {
      decodedUrls.push('https://' + stape.host + stape.decodedPath);
    } catch { /* malformed decoded path */ }
  }
  return { transports, decodedUrls };
}

// ── SST Detection (from audit.js) ────────────────────────────────────────────

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

    if (path.endsWith('/gtm.js') || path.includes('/gtm.js')) {
      const id = u.searchParams.get('id');
      if (id && /^GTM-[A-Z0-9]+$/i.test(id)) {
        const key = `gtm|${host}|${id}`;
        if (!seenLoaders.has(key)) {
          seenLoaders.add(key);
          containers.add(id.toUpperCase());
          loaders.push({ type: 'GTM', host, path: path + u.search, id, isStandard: isStandardHost, isFirstParty });
        }
      }
    }

    if (path.includes('/gtag/js')) {
      const id = u.searchParams.get('id');
      if (id && /^(G|AW|GT|DC)-[A-Z0-9]+$/i.test(id)) {
        const key = `gtag|${host}|${id}`;
        if (!seenLoaders.has(key)) {
          seenLoaders.add(key);
          if (/^G-/i.test(id)) measurementIds.add(id.toUpperCase());
          loaders.push({ type: 'gtag', host, path: path + u.search, id, isStandard: isStandardHost, isFirstParty });
        }
      }
    }

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

// ── Request Collector ─────────────────────────────────────────────────────────

function setupRequestCollector(page) {
  const requests = [];
  let currentPhase = 'pre-consent';

  page.on('request', (req) => {
    requests.push({
      url: req.url(),
      method: req.method(),
      headers: req.headers(),
      postData: req.method() === 'POST' ? (req.postData() || null) : null,
      phase: currentPhase,
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

  return {
    getAll: () => [...requests],
    getByPhase: (phase) => requests.filter(r => r.phase === phase),
    setPhase: (phase) => { currentPhase = phase; },
  };
}

// ── Browser-UI: Consent Card ──────────────────────────────────────────────────

async function injectConsentCard(page, label) {
  const callbackName = '__compareConsentGiven_' + label.replace(/\W/g, '_');

  let resolveConsent;
  const consentPromise = new Promise((resolve) => { resolveConsent = resolve; });

  await page.exposeFunction(callbackName, () => {
    resolveConsent(Date.now());
  });

  await page.evaluate(({ label, cbName }) => {
    const style = document.createElement('style');
    style.id = '__compare-card-style';
    style.textContent = `
      #__compare-card {
        position: fixed !important; bottom: 24px !important; right: 24px !important;
        z-index: 2147483647 !important;
        background: #fff !important; border-radius: 12px !important;
        padding: 20px 24px !important; max-width: 360px !important; width: auto !important;
        box-shadow: 0 8px 32px rgba(0,0,0,0.25), 0 0 0 1px rgba(0,0,0,0.08) !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
        font-size: 14px !important; color: #333 !important;
        box-sizing: border-box !important; margin: 0 !important;
        line-height: 1.5 !important; cursor: grab !important; user-select: none !important;
      }
      #__compare-card.--dragging { cursor: grabbing !important; }
      #__compare-card-title {
        font-size: 15px !important; font-weight: 700 !important; color: #111 !important;
        margin: 0 0 8px 0 !important; display: block !important;
      }
      #__compare-card-msg {
        font-size: 13px !important; color: #555 !important;
        margin: 0 0 14px 0 !important; display: block !important;
      }
      #__compare-card-btn {
        background: #2563eb !important; color: #fff !important; border: none !important;
        border-radius: 8px !important; padding: 10px 20px !important;
        font-size: 14px !important; font-weight: 600 !important; cursor: pointer !important;
        display: block !important; width: 100% !important; text-align: center !important;
      }
      #__compare-card-btn:hover:not(:disabled) { background: #1d4ed8 !important; }
      #__compare-card-btn:disabled { background: #9ca3af !important; cursor: default !important; pointer-events: none !important; }
      #__compare-card-btn.--ready { background: #2563eb !important; cursor: pointer !important; pointer-events: auto !important; }
      #__compare-card-btn.--done { background: #22c55e !important; cursor: default !important; pointer-events: none !important; }
    `;
    document.head.appendChild(style);

    const card = document.createElement('div');
    card.id = '__compare-card';
    card.innerHTML =
      '<div id="__compare-card-title">' + label + '</div>' +
      '<div id="__compare-card-msg">Seite l\u00e4dt...</div>' +
      '<button id="__compare-card-btn" disabled>Seite l\u00e4dt...</button>';
    document.body.appendChild(card);

    document.getElementById('__compare-card-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      const btn = document.getElementById('__compare-card-btn');
      if (!btn.classList.contains('--ready')) return;
      btn.disabled = true;
      btn.classList.remove('--ready');
      btn.classList.add('--done');
      btn.textContent = 'Warte auf andere Seite...';
      window[cbName]();
    });

    // Drag handling (pattern from browser-ui.js)
    let dragging = false, startX, startY, origX, origY;
    card.addEventListener('mousedown', (e) => {
      if (e.target.id === '__compare-card-btn') return;
      dragging = true;
      card.classList.add('--dragging');
      const rect = card.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      origX = rect.left; origY = rect.top;
      card.style.setProperty('bottom', 'auto', 'important');
      card.style.setProperty('right', 'auto', 'important');
      card.style.setProperty('left', origX + 'px', 'important');
      card.style.setProperty('top', origY + 'px', 'important');
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      card.style.setProperty('left', (origX + e.clientX - startX) + 'px', 'important');
      card.style.setProperty('top', (origY + e.clientY - startY) + 'px', 'important');
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      card.classList.remove('--dragging');
    });
  }, { label, cbName: callbackName });

  return consentPromise;
}

async function updateConsentCard(page, message, color) {
  await page.evaluate(({ message, color }) => {
    const btn = document.getElementById('__compare-card-btn');
    if (btn) {
      btn.textContent = message;
      btn.disabled = true;
      if (color) btn.style.setProperty('background', color, 'important');
    }
  }, { message, color }).catch(() => {});
}

async function removeConsentCard(page) {
  await page.evaluate(() => {
    const card = document.getElementById('__compare-card');
    const style = document.getElementById('__compare-card-style');
    if (card) card.remove();
    if (style) style.remove();
  }).catch(() => {});
}

async function updateConsentCardReady(page) {
  await page.evaluate(() => {
    const btn = document.getElementById('__compare-card-btn');
    const msg = document.getElementById('__compare-card-msg');
    if (btn) {
      btn.disabled = false;
      btn.classList.add('--ready');
      btn.textContent = 'Consent gegeben';
    }
    if (msg) {
      msg.textContent = 'Bitte Consent erteilen, dann best\u00e4tigen:';
    }
  }).catch(() => {});
}

// ── Consent Mode Extraction (from audit.js) ──────────────────────────────────

function extractConsentModeParams(requestUrls) {
  const params = [];
  for (const reqUrl of requestUrls) {
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

// ── Analysis ──────────────────────────────────────────────────────────────────

function analyzeSide(collector, siteUrl) {
  const preConsent = collector.getByPhase('pre-consent');
  const postConsent = collector.getByPhase('post-consent');
  const allRequests = collector.getAll();

  const preClassified = preConsent.map(r => classifyRequest(r.url, siteUrl)).filter(Boolean);
  const postClassified = postConsent.map(r => classifyRequest(r.url, siteUrl)).filter(Boolean);
  const allClassified = allRequests.map(r => classifyRequest(r.url, siteUrl)).filter(Boolean);

  const preDeduped = deduplicateRequests(preClassified);
  const postDeduped = deduplicateRequests(postClassified);
  const allDeduped = deduplicateRequests(allClassified);

  // SST Detection
  const allUrls = allRequests.map(r => r.url);
  const sst = detectSSTFromUrls(allUrls, siteUrl);

  // Stape Custom Loader
  const stape = extractStapeFindings(allRequests);
  if (stape.decodedUrls.length > 0) {
    const sstFromStape = detectSSTFromUrls(stape.decodedUrls, siteUrl);
    for (const id of sstFromStape.containers) sst.containers.add(id);
    for (const id of sstFromStape.measurementIds) sst.measurementIds.add(id);
    sst.loaders.push(...sstFromStape.loaders);
    sst.collectEndpoints.push(...sstFromStape.collectEndpoints);
  }

  // Consent Mode
  const preUrls = preConsent.map(r => r.url);
  const postUrls = postConsent.map(r => r.url);
  const preConsentMode = extractConsentModeParams(preUrls);
  const postConsentMode = extractConsentModeParams(postUrls);

  return {
    preConsent: preDeduped,
    postConsent: postDeduped,
    all: allDeduped,
    sst: {
      containers: [...sst.containers],
      measurementIds: [...sst.measurementIds],
      loaders: sst.loaders,
      collectEndpoints: sst.collectEndpoints,
    },
    stape: stape.transports,
    consentMode: {
      pre: preConsentMode,
      post: postConsentMode,
      type: preConsentMode.length > 0 ? 'Advanced' : 'Basic',
    },
    requestCount: { pre: preConsent.length, post: postConsent.length, total: allRequests.length },
  };
}

function buildDiff(analysisA, analysisB) {
  const vendorsA = new Set(analysisA.all.map(d => d.vendor));
  const vendorsB = new Set(analysisB.all.map(d => d.vendor));

  const onlyA = [...vendorsA].filter(v => !vendorsB.has(v));
  const onlyB = [...vendorsB].filter(v => !vendorsA.has(v));
  const both = [...vendorsA].filter(v => vendorsB.has(v));

  const details = [];
  for (const vendor of both) {
    const a = analysisA.all.find(d => d.vendor === vendor);
    const b = analysisB.all.find(d => d.vendor === vendor);
    const hostsMatch = JSON.stringify(a.hostnames.sort()) === JSON.stringify(b.hostnames.sort());
    const subTypesMatch = JSON.stringify(a.subTypes.sort()) === JSON.stringify(b.subTypes.sort());
    details.push({
      vendor,
      hostnamesA: a.hostnames, hostnamesB: b.hostnames,
      subTypesA: a.subTypes, subTypesB: b.subTypes,
      hostsIdentical: hostsMatch, subTypesIdentical: subTypesMatch,
    });
  }

  const sstDiff = {
    containersMatch: JSON.stringify(analysisA.sst.containers.sort()) === JSON.stringify(analysisB.sst.containers.sort()),
    measurementIdsMatch: JSON.stringify(analysisA.sst.measurementIds.sort()) === JSON.stringify(analysisB.sst.measurementIds.sort()),
  };

  const cmA = analysisA.consentMode;
  const cmB = analysisB.consentMode;
  const consentModeDiff = {
    typeA: cmA.type,
    typeB: cmB.type,
    typesMatch: cmA.type === cmB.type,
    preGcsA: cmA.pre.length > 0 ? cmA.pre[0].gcs : '-',
    preGcsB: cmB.pre.length > 0 ? cmB.pre[0].gcs : '-',
    postGcsA: cmA.post.length > 0 ? cmA.post[0].gcs : '-',
    postGcsB: cmB.post.length > 0 ? cmB.post[0].gcs : '-',
    preGcdA: cmA.pre.length > 0 ? cmA.pre[0].gcd : '-',
    preGcdB: cmB.pre.length > 0 ? cmB.pre[0].gcd : '-',
    postGcdA: cmA.post.length > 0 ? cmA.post[0].gcd : '-',
    postGcdB: cmB.post.length > 0 ? cmB.post[0].gcd : '-',
    preGcsMatch: (cmA.pre.length > 0 ? cmA.pre[0].gcs : '-') === (cmB.pre.length > 0 ? cmB.pre[0].gcs : '-'),
    postGcsMatch: (cmA.post.length > 0 ? cmA.post[0].gcs : '-') === (cmB.post.length > 0 ? cmB.post[0].gcs : '-'),
  };

  return { onlyA, onlyB, both, details, sstDiff, consentModeDiff };
}

// ── HAR Export ────────────────────────────────────────────────────────────────

function buildHAR(collector, pageUrl, label) {
  const requests = collector.getAll();
  const entries = requests.map(r => ({
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
      creator: { name: 'compare.js', version: '1.0' },
      pages: [{
        startedDateTime: entries.length > 0 ? entries[0].startedDateTime : new Date().toISOString(),
        id: 'page_1',
        title: `${label}: ${pageUrl}`,
        pageTimings: {},
      }],
      entries,
    },
  };
}

// ── Report Generation ─────────────────────────────────────────────────────────

function generateCompareReport(analysisA, analysisB, diff, meta) {
  const lines = [];
  const ln = (s = '') => lines.push(s);

  ln(`# Tracking-Vergleich: ${meta.labelA} vs. ${meta.labelB}`);
  ln();
  ln(`| | Details |`);
  ln(`|---|---|`);
  ln(`| Datum | ${new Date().toISOString().replace('T', ' ').slice(0, 19)} |`);
  ln(`| URL A (${meta.labelA}) | ${meta.urlA} |`);
  ln(`| URL B (${meta.labelB}) | ${meta.urlB} |`);
  ln(`| Requests A | ${analysisA.requestCount.total} (${analysisA.requestCount.pre} pre / ${analysisA.requestCount.post} post) |`);
  ln(`| Requests B | ${analysisB.requestCount.total} (${analysisB.requestCount.pre} pre / ${analysisB.requestCount.post} post) |`);
  ln();

  // TL;DR
  ln(`## TL;DR`);
  ln();
  ln(`- **${diff.both.length}** Vendoren auf beiden Seiten`);
  if (diff.onlyA.length) ln(`- **${diff.onlyA.length}** nur auf ${meta.labelA}: ${diff.onlyA.join(', ')}`);
  if (diff.onlyB.length) ln(`- **${diff.onlyB.length}** nur auf ${meta.labelB}: ${diff.onlyB.join(', ')}`);
  if (!diff.onlyA.length && !diff.onlyB.length) ln(`- Keine exklusiven Vendoren`);
  ln(`- Container-IDs: ${diff.sstDiff.containersMatch ? 'identisch' : 'ABWEICHEND'} (A: ${analysisA.sst.containers.join(', ') || 'keine'} | B: ${analysisB.sst.containers.join(', ') || 'keine'})`);
  ln(`- Measurement-IDs: ${diff.sstDiff.measurementIdsMatch ? 'identisch' : 'ABWEICHEND'} (A: ${analysisA.sst.measurementIds.join(', ') || 'keine'} | B: ${analysisB.sst.measurementIds.join(', ') || 'keine'})`);
  if (analysisA.stape.length || analysisB.stape.length) {
    const stapeA = analysisA.stape.map(s => s.host).join(', ') || 'nein';
    const stapeB = analysisB.stape.map(s => s.host).join(', ') || 'nein';
    ln(`- Custom Loader: A=${stapeA} | B=${stapeB}`);
  }
  const cmTypeA = analysisA.consentMode.type;
  const cmTypeB = analysisB.consentMode.type;
  if (cmTypeA === cmTypeB) {
    ln(`- Consent Mode: identisch (${cmTypeA})`);
  } else {
    ln(`- Consent Mode: ABWEICHEND (A: ${cmTypeA} | B: ${cmTypeB})`);
  }
  ln();

  // Vendor-Vergleich (Post-Consent)
  ln(`## Vendor-Vergleich (Post-Consent)`);
  ln();
  ln(`| Vendor | ${meta.labelA} | ${meta.labelB} | Status |`);
  ln(`|--------|--------|--------|--------|`);
  for (const d of diff.details) {
    const aInfo = d.hostnamesA.join(', ');
    const bInfo = d.hostnamesB.join(', ');
    let status = 'identisch';
    if (!d.hostsIdentical && !d.subTypesIdentical) status = 'ABWEICHEND';
    else if (!d.hostsIdentical) status = 'Hosts abweichend';
    else if (!d.subTypesIdentical) status = 'SubTypes abweichend';
    ln(`| ${d.vendor} | ${aInfo} | ${bInfo} | ${status} |`);
  }
  for (const v of diff.onlyA) {
    const a = analysisA.all.find(d => d.vendor === v);
    ln(`| ${v} | ${a ? a.hostnames.join(', ') : '-'} | - | nur A |`);
  }
  for (const v of diff.onlyB) {
    const b = analysisB.all.find(d => d.vendor === v);
    ln(`| ${v} | - | ${b ? b.hostnames.join(', ') : '-'} | nur B |`);
  }
  ln();

  // Pre-Consent
  const preVendorsA = new Set(analysisA.preConsent.map(d => d.vendor));
  const preVendorsB = new Set(analysisB.preConsent.map(d => d.vendor));
  if (preVendorsA.size > 0 || preVendorsB.size > 0) {
    ln(`## Pre-Consent Requests`);
    ln();
    ln(`| Vendor | ${meta.labelA} | ${meta.labelB} |`);
    ln(`|--------|--------|--------|`);
    const allPreVendors = [...new Set([...preVendorsA, ...preVendorsB])].sort();
    for (const v of allPreVendors) {
      const aEntry = analysisA.preConsent.find(d => d.vendor === v);
      const bEntry = analysisB.preConsent.find(d => d.vendor === v);
      ln(`| ${v} | ${aEntry ? aEntry.hostnames.join(', ') : '-'} | ${bEntry ? bEntry.hostnames.join(', ') : '-'} |`);
    }
    ln();
  }

  // Consent Mode
  const cmd = diff.consentModeDiff;
  ln(`## Consent Mode`);
  ln();
  ln(`| | ${meta.labelA} | ${meta.labelB} |`);
  ln(`|---|---|---|`);
  const typeLine = !cmd.typesMatch ? `| **Typ** | **${cmd.typeA}** | **${cmd.typeB}** |` : `| Typ | ${cmd.typeA} | ${cmd.typeB} |`;
  ln(typeLine);
  const fmtVal = (v) => v === '-' ? 'Nicht erkannt' : `\`${v}\``;
  if (cmd.preGcsA !== '-' || cmd.preGcsB !== '-') {
    const preGcsLine = !cmd.preGcsMatch ? `| **Pre-Consent gcs** | **${fmtVal(cmd.preGcsA)}** | **${fmtVal(cmd.preGcsB)}** |` : `| Pre-Consent gcs | ${fmtVal(cmd.preGcsA)} | ${fmtVal(cmd.preGcsB)} |`;
    ln(preGcsLine);
  }
  if (cmd.postGcsA !== '-' || cmd.postGcsB !== '-') {
    const postGcsLine = !cmd.postGcsMatch ? `| **Post-Consent gcs** | **${fmtVal(cmd.postGcsA)}** | **${fmtVal(cmd.postGcsB)}** |` : `| Post-Consent gcs | ${fmtVal(cmd.postGcsA)} | ${fmtVal(cmd.postGcsB)} |`;
    ln(postGcsLine);
  }
  if (cmd.preGcdA !== '-' || cmd.preGcdB !== '-') {
    const preGcdMatch = cmd.preGcdA === cmd.preGcdB;
    const preGcdLine = !preGcdMatch ? `| **Pre-Consent gcd** | **${fmtVal(cmd.preGcdA)}** | **${fmtVal(cmd.preGcdB)}** |` : `| Pre-Consent gcd | ${fmtVal(cmd.preGcdA)} | ${fmtVal(cmd.preGcdB)} |`;
    ln(preGcdLine);
  }
  if (cmd.postGcdA !== '-' || cmd.postGcdB !== '-') {
    const postGcdMatch = cmd.postGcdA === cmd.postGcdB;
    const postGcdLine = !postGcdMatch ? `| **Post-Consent gcd** | **${fmtVal(cmd.postGcdA)}** | **${fmtVal(cmd.postGcdB)}** |` : `| Post-Consent gcd | ${fmtVal(cmd.postGcdA)} | ${fmtVal(cmd.postGcdB)} |`;
    ln(postGcdLine);
  }
  if (cmd.typeA === 'Basic' && cmd.typeB === 'Basic' && cmd.preGcsA === '-' && cmd.postGcsA === '-' && cmd.preGcsB === '-' && cmd.postGcsB === '-') {
    ln(`| | Nicht erkannt (Basic oder kein Consent Mode) | Nicht erkannt (Basic oder kein Consent Mode) |`);
  }
  ln();

  // SST Details
  ln(`## SST / Custom Loader Details`);
  ln();

  for (const [label, analysis] of [[meta.labelA, analysisA], [meta.labelB, analysisB]]) {
    ln(`### ${label}`);
    if (analysis.sst.loaders.length === 0 && analysis.stape.length === 0) {
      ln(`Keine Loader erkannt.`);
    } else {
      for (const l of analysis.sst.loaders) {
        ln(`- **${l.type}** ${l.id}: \`${l.host}\` (${l.isStandard ? 'Standard' : 'Custom/First-Party'})`);
      }
      for (const s of analysis.stape) {
        ln(`- **${s.type}**: \`${s.host}\``);
      }
    }
    if (analysis.sst.collectEndpoints.length > 0) {
      ln(`- Collect-Endpoints:`);
      for (const c of analysis.sst.collectEndpoints) ln(`  - \`${c.host}${c.path}\` (${c.tid})`);
    }
    ln();
  }

  // HAR-Referenzen
  ln(`## HAR-Dateien`);
  ln();
  ln(`- ${meta.labelA}: \`${meta.harFileA}\``);
  ln(`- ${meta.labelB}: \`${meta.harFileB}\``);
  ln();

  return lines.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function measureSide(browser, url, label, postWait) {
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    const collector = setupRequestCollector(page);

    console.log(`  Lade ${label}: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});

    // Consent-Card injizieren (Button startet deaktiviert)
    const consentPromise = injectConsentCard(page, label);

    // Warten bis Seite vollstaendig geladen + 3s Offset, dann Button freischalten
    console.log(`  Warte auf load-Event fuer ${label}...`);
    await page.waitForLoadState('load', { timeout: 15000 }).catch(() => {
      console.log(`  (load-Timeout fuer ${label}, schalte trotzdem frei)`);
    });
    await new Promise(r => setTimeout(r, 3000));
    await updateConsentCardReady(page);
    console.log(`  Warte auf Consent fuer ${label}...\n`);
    await consentPromise;

    collector.setPhase('post-consent');
    console.log(`  + ${label}: Consent bestaetigt`);
    await updateConsentCard(page, 'Sammle Daten...', '#f59e0b');

    console.log(`  Sammle Post-Consent-Daten (${postWait / 1000}s)...`);
    await new Promise(r => setTimeout(r, postWait));
    await removeConsentCard(page);

    console.log(`  ${label} abgeschlossen.\n`);
    return collector;
  } finally {
    await context.close();
  }
}

async function main() {
  console.log(`\n  Tracking-Vergleich`);
  console.log(`  A: ${urlA}  (${effectiveLabelA})`);
  console.log(`  B: ${urlB}  (${effectiveLabelB})\n`);

  const browser = await chromium.launch({ headless: false });

  try {
    // Seite A messen (eigener Context, schliesst sich danach)
    const collectorA = await measureSide(browser, urlA, effectiveLabelA, postConsentWait);

    // Seite B messen (eigener Context, gleiches Browser-Fenster)
    const collectorB = await measureSide(browser, urlB, effectiveLabelB, postConsentWait);

    // Analyse
    console.log('  Analysiere...');
    const analysisA = analyzeSide(collectorA, urlA);
    const analysisB = analyzeSide(collectorB, urlB);
    const diff = buildDiff(analysisA, analysisB);

    console.log(`  Seite A: ${analysisA.requestCount.total} Requests (${analysisA.all.length} Vendoren)`);
    console.log(`  Seite B: ${analysisB.requestCount.total} Requests (${analysisB.all.length} Vendoren)`);
    console.log(`  Nur A: ${diff.onlyA.length} | Nur B: ${diff.onlyB.length} | Beide: ${diff.both.length}\n`);

    // Report-Verzeichnis
    const reportDir = resolve(__dirname, 'reports', project);
    if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });

    const ts = timestamp();
    const hostSlug = hostForFilename(urlA);
    const baseName = `compare-${hostSlug}-${ts}`;

    // HAR-Export
    const harA = buildHAR(collectorA, urlA, effectiveLabelA);
    const harB = buildHAR(collectorB, urlB, effectiveLabelB);
    const harFileA = `${baseName}-a.har`;
    const harFileB = `${baseName}-b.har`;
    writeFileSync(resolve(reportDir, harFileA), JSON.stringify(harA, null, 2), 'utf-8');
    writeFileSync(resolve(reportDir, harFileB), JSON.stringify(harB, null, 2), 'utf-8');

    // Markdown-Report
    const report = generateCompareReport(analysisA, analysisB, diff, {
      labelA: effectiveLabelA, labelB: effectiveLabelB,
      urlA, urlB,
      harFileA, harFileB,
    });
    const reportPath = resolve(reportDir, `${baseName}.md`);
    writeFileSync(reportPath, report, 'utf-8');

    console.log(`  Report: ${reportPath}`);
    console.log(`  HAR A:  ${resolve(reportDir, harFileA)}`);
    console.log(`  HAR B:  ${resolve(reportDir, harFileB)}\n`);

  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error('\n  FEHLER:', err.message);
  process.exit(1);
});
