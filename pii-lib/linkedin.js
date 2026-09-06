// LinkedIn Insight Tag request detection & parsing — pure functions, no DOM /
// chrome APIs, so they run both in the panel and under `node --test`. Mirrors the
// shape of the other provider modules so the panel treats every provider uniformly.
//
// A LinkedIn Insight Tag hit goes to px.ads.linkedin.com/collect as a GET beacon,
// and is mirrored 1:1 to px4.ads.linkedin.com/collect — the px4 twin adds an
// `e_ipv6` param (an encrypted/hashed client IP) but is otherwise identical. We
// collapse the two into a single card (the px4 mirror wins as survivor because it
// carries the IP hash). The payload rides entirely in the query string:
//   pid          partner id (the Insight Tag / ad account id)
//   conversionId present ONLY on a conversion — its absence means a plain page view
//   url          page url · tm  tag manager (gtmv2) · time  timestamp · v/fmt  version
//
// One neighbouring endpoint is intentionally ignored by the synchronous parser:
// `/attribution_trigger` (pid/time/url only — a redundant duplicate of the collect
// signal).
//
// The `/wa/` endpoint IS captured, but NOT by the synchronous parser below: its
// body is `base64(gzip(JSON))` and decoding needs an async `DecompressionStream`,
// which would break the synchronous contract the other providers rely on. It is
// handled by `parseLinkedInWaRequest` (async, exported separately) and wired into
// the panel on a side-path. The /wa/ JSON is the ONLY place LinkedIn's enhanced-
// conversions PII leaves the browser — it carries `hem` (SHA-256 of the lower-cased
// email; present on ANY signalType once `lintrk('setUserData')` has run, null
// otherwise), `pids`, `signalType` (PAGE_VISIT | CLICK | …), page context
// (url/pageTitle), the clicked element on interaction signals (domAttributes /
// elementCrumbsTree), and LinkedIn's first-party ad-tracking ids (liFatId/liGiant).
// The /collect beacon carries no user identifiers.

import { extractParams, hashAlgo, makeGetter } from './params.js';

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

// px.ads.linkedin.com, px4.ads.linkedin.com, bare ads.linkedin.com.
export function isLinkedInHost(host) {
  const h = (host || '').toLowerCase();
  return /(^|\.)ads\.linkedin\.com$/.test(h);
}

function isCollectPath(pathname) {
  return /\/collect(\/|$)/.test(pathname || '');
}

// The subdomain label (px / px4) used as the transport mirror label on collapse.
function subdomainLabel(host) {
  const h = (host || '').toLowerCase();
  const m = h.match(/^([^.]+)\.ads\.linkedin\.com$/);
  return m ? m[1] : 'linkedin';
}

// ---------------------------------------------------------------------------
// Full parse
// ---------------------------------------------------------------------------

// Returns a normalized record or null for non-LinkedIn / ignored requests.
export function parseLinkedInRequest(url, postData) {
  let host = '', pathname = '';
  try { const u = new URL(url); host = u.host; pathname = u.pathname; }
  catch (e) { return null; }

  if (!isLinkedInHost(host)) return null;
  if (!isCollectPath(pathname)) return null;              // /wa/, /attribution_trigger → ignored

  const { queryParams, bodyParams } = extractParams(url, postData);
  const get = makeGetter(queryParams, bodyParams);

  const pid = get('pid');
  if (!pid) return null;                                  // a collect hit always carries its partner id

  const conversionId = get('conversionId');
  const isConversion = conversionId != null && conversionId !== '';
  const ipHash = get('e_ipv6');
  const label = subdomainLabel(host);

  const flags = {
    conversion: isConversion,
    ipHash: !!ipHash,                                     // e_ipv6 present (px4 mirror)
  };

  return {
    provider: 'linkedin',
    transport: 'standard',
    _endpoint: 'collect',
    host,
    pathname,
    effectiveUrl: url,
    effectivePath: pathname,
    method: postData ? 'POST' : 'GET',
    pid: String(pid),
    conversionId: isConversion ? String(conversionId) : null,
    eventName: isConversion ? 'Conversion' : 'PageView',
    isConversion,
    pageUrl: get('url') || null,
    tagManager: get('tm') || null,
    version: get('v') || null,
    ipHash: ipHash || null,
    time: get('time') || null,
    // no user identifiers travel in the collect beacon (hem rides in the ignored
    // /wa/ POST) — keep the standard shape so summary rendering stays uniform.
    userData: null,
    identifiers: { email: 0, phone: 0, name: 0, address: 0 },
    consent: null,                                        // no consent signal in the collect request
    flags,
    queryParams,
    bodyParams,
    // transport bundling (consumed by the panel's generic collapse step): the px4
    // mirror carries e_ipv6, so it outranks the plain px hit and wins as survivor.
    _collapseKey: `li:${pid}:${isConversion ? conversionId : 'pv'}:${get('time') || ''}`,
    _transportLabel: label,
    _transportRank: ipHash ? 100 : 90,
  };
}

// ---------------------------------------------------------------------------
// /wa/ enhanced-conversions (async side-path)
// ---------------------------------------------------------------------------

// base64 text → raw bytes, and gzip bytes → text (async, via DecompressionStream —
// global in both the panel and Node 18+). The /wa/ body is base64(gzip(JSON)).
function base64ToBytes(b64) {
  const bin = atob(b64);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}

async function gunzipToText(bytes) {
  const stream = new Response(bytes).body.pipeThrough(new DecompressionStream('gzip'));
  const buf = await new Response(stream).arrayBuffer();
  return new TextDecoder('utf-8').decode(buf);
}

// Synchronous guard: is this a LinkedIn /wa/ request? (used by the panel before
// it commits to the async decode path).
export function isLinkedInWaRequest(url) {
  try {
    const u = new URL(url);
    return isLinkedInHost(u.host) && /\/wa(\/|$)/.test(u.pathname);
  } catch (e) { return false; }
}

// Async parse of the /wa/ POST. Resolves to a normalized record (same shape as the
// /collect record so panel rendering stays uniform) or null on any failure. hem is
// the SHA-256 of the lower-cased email; present on ANY signalType once user data
// has been set, null otherwise. Never throws.
export async function parseLinkedInWaRequest(url, postData) {
  let host = '', pathname = '';
  try { const u = new URL(url); host = u.host; pathname = u.pathname; }
  catch (e) { return null; }
  if (!isLinkedInHost(host) || !/\/wa(\/|$)/.test(pathname)) return null;

  const text = typeof postData === 'string' ? postData : (postData && postData.text) || '';
  if (!text) return null;

  let json;
  try { json = JSON.parse(await gunzipToText(base64ToBytes(text.trim()))); }
  catch (e) { return null; }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null;

  const pids = Array.isArray(json.pids) ? json.pids : [];
  const pid = pids.length ? String(pids[0]) : null;
  const signalType = json.signalType != null ? String(json.signalType) : null;
  const hem = (typeof json.hem === 'string' && json.hem.trim() !== '') ? json.hem.trim() : null;
  const liFatId = json.liFatId || null;
  const liGiant = json.liGiant || null;
  const hasEmail = !!hem;

  return {
    provider: 'linkedin',
    transport: 'standard',
    host,
    pathname,
    effectiveUrl: url,
    effectivePath: pathname,
    method: 'POST',
    pid,
    conversionId: null,
    eventName: signalType || 'Signal',
    isConversion: false,
    signalType,
    pageUrl: json.url || null,
    pageTitle: json.pageTitle || null,
    tagManager: null,
    version: json.scriptVersion != null ? String(json.scriptVersion) : null,
    ipHash: null,
    time: json.time != null ? String(json.time) : null,
    hem,
    liFatId,
    liGiant,
    userData: hasEmail ? { hem: { bucket: 'email', label: 'Email', hashed: true, algo: hashAlgo(hem) } } : null,
    identifiers: { email: hasEmail ? 1 : 0, phone: 0, name: 0, address: 0 },
    consent: null,
    flags: {
      signal: signalType,
      hashedEmail: hasEmail,
      liFat: !!(liFatId || liGiant),
    },
    waPayload: json,
    queryParams: {},
    bodyParams: {},
    _endpoint: 'wa',
    _collapseKey: json.websiteSignalRequestId ? ('li-wa:' + json.websiteSignalRequestId) : null,
    _transportLabel: subdomainLabel(host),
    _transportRank: 100,
  };
}
