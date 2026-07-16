// ── lib/tracking-classify.js ─────────────────────────────────────────────────
//
// Gemeinsamer Tracking-Klassifikations- und SST-Kern fuer audit.js, compare.js
// und flow-lib.js. Frueher lagen diese Funktionen wortgleich in audit.js UND
// compare.js (und flow-lib.js importierte sie ausgerechnet aus dem CLI-Skript
// compare.js) -- das ist auseinandergedriftet (Consent-Mode-Erkennung). Ab jetzt
// EINE kanonische Quelle. Aenderungen hier wirken auf alle drei Consumer.

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Vendor Library (Single Source) ───────────────────────────────────────────
export const VENDORS = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'tracking-vendors.json'), 'utf-8')
);

// ── URL-Helpers ───────────────────────────────────────────────────────────────

export function getHostname(urlStr) {
  try { return new URL(urlStr).hostname; } catch { return null; }
}

// Zweistufige Public-Suffixe, bei denen die reine slice(-2)-Heuristik die
// Registrable Domain falsch bestimmt (example.co.uk -> "co.uk", wodurch jeder
// *.co.uk-Host faelschlich als First-Party gilt). Kuratierte Liste der gaengigen
// Faelle (EU/DACH + haeufige internationale) statt voller PSL-Abhaengigkeit.
const SECOND_LEVEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'gov.uk', 'ac.uk', 'ltd.uk', 'plc.uk', 'net.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz',
  'co.za', 'org.za', 'net.za',
  'com.br', 'net.br', 'org.br', 'gov.br',
  'co.jp', 'or.jp', 'ne.jp', 'go.jp',
  'com.tr', 'org.tr', 'net.tr',
  'co.in', 'net.in', 'org.in', 'gov.in',
  'com.mx', 'com.ar', 'com.co', 'com.sg', 'com.hk', 'com.tw', 'com.cn', 'com.ua',
]);

export function getSiteDomain(urlStr) {
  const h = getHostname(urlStr);
  if (!h) return null;
  const parts = h.split('.');
  if (parts.length < 2) return h;
  const lastTwo = parts.slice(-2).join('.');
  // Zweistufiges Suffix (co.uk) -> dritte Ebene mitnehmen (example.co.uk)
  if (parts.length >= 3 && SECOND_LEVEL_SUFFIXES.has(lastTwo)) {
    return parts.slice(-3).join('.');
  }
  return lastTwo;
}

export function truncate(str, max = 80) {
  if (!str) return '';
  const s = String(str);
  return s.length > max ? s.slice(0, max) + '...' : s;
}

// ── Vendor-Klassifikation ─────────────────────────────────────────────────────

/**
 * Match a request URL against the vendor library.
 * Returns { key, vendor, product, category, direction, type, hostname } or null (same-domain).
 * Priority: scripts (with identify) > scripts (without) > endpoints > domains > unknown third-party.
 */
export function matchRequest(requestUrl, siteHost) {
  let u;
  try { u = new URL(requestUrl); } catch { return null; }

  const hostname = u.hostname;
  const hostpath = hostname + u.pathname;
  const siteDomain = getSiteDomain(siteHost);
  const reqDomain = getSiteDomain(requestUrl);

  if (reqDomain === siteDomain) return null;

  // Pass 1: Scripts with identify constraint (most specific)
  for (const [key, v] of Object.entries(VENDORS)) {
    for (const s of (v.scripts || [])) {
      if (!s.identify) continue;
      if (!hostpath.includes(s.pattern)) continue;
      const paramVal = u.searchParams.get(s.identify.param);
      if (paramVal && new RegExp(s.identify.match, 'i').test(paramVal)) {
        return { key, vendor: v.vendor, product: v.product, category: v.category, direction: 'script', type: null, hostname };
      }
    }
  }

  // Pass 2: Scripts without identify constraint
  for (const [key, v] of Object.entries(VENDORS)) {
    for (const s of (v.scripts || [])) {
      if (s.identify) continue;
      if (hostpath.includes(s.pattern)) {
        return { key, vendor: v.vendor, product: v.product, category: v.category, direction: 'script', type: null, hostname };
      }
    }
  }

  // Pass 3: Endpoints (with optional classify)
  for (const [key, v] of Object.entries(VENDORS)) {
    for (const ep of (v.endpoints || [])) {
      if (!hostpath.includes(ep.pattern)) continue;
      let type = ep.type || null;
      if (ep.classify) {
        const paramVal = u.searchParams.get(ep.classify.param);
        if (paramVal && ep.classify.values[paramVal]) {
          type = ep.classify.values[paramVal];
        } else {
          type = ep.classify.default || 'event';
        }
      }
      return { key, vendor: v.vendor, product: v.product, category: v.category, direction: 'request', type, hostname };
    }
  }

  // Pass 4: Domain fallback
  for (const [key, v] of Object.entries(VENDORS)) {
    for (const d of (v.domains || [])) {
      if (d.includes('/')) {
        if (hostpath.includes(d)) {
          return { key, vendor: v.vendor, product: v.product, category: v.category, direction: 'domain', type: null, hostname };
        }
      } else {
        if (hostname === d || hostname.endsWith('.' + d)) {
          return { key, vendor: v.vendor, product: v.product, category: v.category, direction: 'domain', type: null, hostname };
        }
      }
    }
  }

  // Unknown third-party
  return { key: null, vendor: 'Sonstige Third-Party', product: null, category: null, direction: 'unknown', type: null, hostname };
}

/**
 * Deduplicate matched requests by product key (or hostname for unknown).
 * Returns [{ key, vendor, product, category, hostnames, directions, types }].
 */
export function deduplicateMatches(matches) {
  const map = new Map();
  for (const m of matches) {
    if (!m) continue;
    const groupKey = m.key || ('_tp_' + m.hostname);
    if (!map.has(groupKey)) {
      map.set(groupKey, {
        key: m.key, vendor: m.vendor, product: m.product, category: m.category,
        hostnames: new Set(), directions: new Set(), types: new Set(),
      });
    }
    const entry = map.get(groupKey);
    if (m.hostname) entry.hostnames.add(m.hostname);
    entry.directions.add(m.direction);
    if (m.type) entry.types.add(m.type);
  }
  return [...map.values()].map(e => ({
    ...e,
    hostnames: [...e.hostnames],
    directions: [...e.directions],
    types: [...e.types],
  }));
}

// ── Stape Custom Loader Detection ─────────────────────────────────────────────

/**
 * Maps a decoded Google transport path to its canonical first-party Google host.
 * The vendor-library endpoint patterns are host-bound (e.g. "google-analytics.com/g/collect"),
 * so a Stape-tunneled hit (which carries the first-party loader host) can only be
 * classified after the synthetic URL is rebuilt on the original Google host.
 */
export const STAPE_PATH_HOSTS = [
  { prefix: '/g/collect', host: 'www.google-analytics.com' },
  { prefix: '/j/collect', host: 'www.google-analytics.com' },
  { prefix: '/collect', host: 'www.google-analytics.com' },
  { prefix: '/gtag/js', host: 'www.googletagmanager.com' },
  { prefix: '/pagead/', host: 'googleadservices.com' },
  { prefix: '/activity', host: 'fls.doubleclick.net' },
];

export function canonicalGoogleHost(decodedPath) {
  for (const { prefix, host } of STAPE_PATH_HOSTS) {
    if (decodedPath.startsWith(prefix)) return host;
  }
  return null;
}

/**
 * Detects Stape custom loader transport: Query params with Base64-encoded
 * Google URLs (e.g. /gtag/js?id=G-XXX or /g/collect?v=2&tid=G-XXX).
 * Returns { host, googleHost, encodedParam, decodedPath, originalUrl } or null.
 */
export function tryDecodeStapeTransport(requestUrl) {
  try {
    const u = new URL(requestUrl);
    for (const [key, value] of u.searchParams) {
      if (!value || value.length < 10) continue;
      try {
        const decoded = Buffer.from(decodeURIComponent(value), 'base64').toString('utf-8');
        const googleHost = canonicalGoogleHost(decoded);
        if (googleHost) {
          return {
            host: u.hostname,
            googleHost,
            encodedParam: key,
            decodedPath: decoded,
            originalUrl: requestUrl,
          };
        }
      } catch { continue; }
    }
  } catch { /* invalid URL */ }
  return null;
}

/**
 * Processes all requests, decodes Stape transports, extracts IDs.
 * Returns { transports, decodedRequests } where each decodedRequest carries both
 * the real first-party transport host (stapeHost) and a synthetic URL rebuilt on
 * the canonical Google host, so existing detection/classification functions match
 * the host-bound vendor patterns.
 */
export function extractStapeFindings(fullRequests) {
  const transports = [];
  const decodedRequests = [];
  const seenHosts = new Set();

  for (const req of fullRequests) {
    const stape = tryDecodeStapeTransport(req.url);
    if (!stape) continue;

    if (!seenHosts.has(stape.host)) {
      seenHosts.add(stape.host);
      transports.push({ host: stape.host, type: 'Stape Custom Loader' });
    }

    try {
      const syntheticUrl = 'https://' + stape.googleHost + stape.decodedPath;
      decodedRequests.push({
        stapeHost: stape.host,
        googleHost: stape.googleHost,
        decodedPath: stape.decodedPath,
        syntheticUrl,
      });
    } catch { /* malformed decoded path */ }
  }

  return { transports, decodedRequests };
}

/**
 * Classifies Stape-tunneled requests against the vendor library.
 * Returns matchRequest-style objects (known vendors only), tagged with the real
 * transport host and an 'sst-tunnel' direction.
 */
export function extractStapeMatches(fullRequests, siteHost) {
  const { decodedRequests } = extractStapeFindings(fullRequests);
  const matches = [];
  for (const d of decodedRequests) {
    const m = matchRequest(d.syntheticUrl, siteHost);
    if (m && m.key) {
      matches.push({ ...m, direction: 'sst-tunnel', hostname: d.stapeHost });
    }
  }
  return matches;
}

// ── SST Detection ─────────────────────────────────────────────────────────────

/**
 * Detect SST setups from raw request URLs.
 * Scans for GTM/gtag loaders on any host and GA4 first-party collect endpoints.
 */
export function detectSSTFromUrls(requestUrls, siteHost) {
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
          loaders.push({ type: 'GTM', host, path: path + u.search, id, isStandard: isStandardHost, isFirstParty });
        }
      }
    }

    // gtag Loader: /gtag/js with known id prefix
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

// ── Consent Mode ──────────────────────────────────────────────────────────────

/**
 * Extract Consent Mode parameters (gcs, gcd) from Google request URLs.
 * Covers both vendor-library Google domains and generic www.google.<tld>
 * endpoints used by Advanced Consent Mode (en=consent_update pings).
 */
export function extractConsentModeParams(requests) {
  const googleDomains = Object.values(VENDORS)
    .filter(v => v.vendor === 'Google')
    .flatMap(v => v.domains || []);

  const params = [];
  for (const reqUrl of requests) {
    const hostname = getHostname(reqUrl);
    if (!hostname) continue;

    const isVendorGoogle = googleDomains.some(d =>
      hostname === d || hostname.endsWith('.' + d)
    );
    // Advanced Consent Mode consent_update pings go to www.google.<tld>/ccm/collect
    const isGoogleConsentEndpoint = /^www\.google\.[a-z.]{2,}$/.test(hostname);
    if (!isVendorGoogle && !isGoogleConsentEndpoint) continue;

    try {
      const u = new URL(reqUrl);
      const gcs = u.searchParams.get('gcs');
      const gcd = u.searchParams.get('gcd');
      if (gcs || gcd) {
        const en = u.searchParams.get('en');
        params.push({
          url: truncate(reqUrl, 120),
          gcs: gcs || '-',
          gcd: gcd || '-',
          event: en || null,
        });
      }
    } catch { /* ignore */ }
  }
  return params;
}
