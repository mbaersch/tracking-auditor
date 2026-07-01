// Microsoft Bing UET request detection & parsing — pure functions, no DOM /
// chrome APIs, so they run both in the panel and under `node --test`. Mirrors the
// shape of lib/ga4.js / lib/meta.js so the panel can treat all providers uniformly.
//
// A UET hit goes to https://bat.bing.com/action/0 (or /actionp/0), and CST/Flex
// tags to https://commerce.bing.com/cst/0 — both GET beacons. evt distinguishes
// pageLoad / custom (conversion, e-commerce) events; a missing evt is a plain
// "beacon". User data (enhanced conversions) rides inside the `pid` parameter as
// a nested querystring: em=<sha256>&ph=<sha256>.

import { extractParams } from './params.js';

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

export function isBingHost(host) {
  const h = (host || '').toLowerCase();
  return h === 'bat.bing.com' || h === 'commerce.bing.com' || h.endsWith('.bing.com');
}

// /action/0, /actionp/0 (bat.bing.com) or /cst/0 (commerce.bing.com — CST/Flex tag)
function isUetPath(pathname) {
  return /\/actionp?(\/|$)/.test(pathname || '') || /\/cst(\/|$)/.test(pathname || '');
}

// ---------------------------------------------------------------------------
// user data (enhanced conversions) — inside the pid sub-querystring
// ---------------------------------------------------------------------------

const UET_FIELD = {
  em: { bucket: 'email',     label: 'Email' },
  ph: { bucket: 'phone',     label: 'Phone' },
  fn: { bucket: 'firstName', label: 'First name' },
  ln: { bucket: 'lastName',  label: 'Last name' },
};

// pid looks like "em=<hash>&ph=<hash>" (already %-decoded by extractParams).
// Returns { <key>: { bucket, label, hashed } } or null.
export function parseUetUserData(pid) {
  if (!pid) return null;
  const fields = {};
  let params;
  try { params = new URLSearchParams(pid); } catch (e) { return null; }
  for (const [k, v] of params) {
    const def = UET_FIELD[k];
    if (!def) continue;
    fields[k] = { bucket: def.bucket, label: def.label, hashed: /^[a-f0-9]{64}$/i.test(v) };
  }
  return Object.keys(fields).length ? fields : null;
}

export function summarizeUetIdentifiers(userData) {
  const b = { email: 0, phone: 0, firstName: 0, lastName: 0 };
  for (const key of Object.keys(userData || {})) {
    const bucket = (UET_FIELD[key] || {}).bucket;
    if (bucket && bucket in b) b[bucket] += 1;
  }
  return {
    email: b.email,
    phone: b.phone,
    name: Math.max(b.firstName, b.lastName),
    address: 0,
  };
}

// ---------------------------------------------------------------------------
// Consent — Microsoft Consent Mode
// ---------------------------------------------------------------------------
//
// asc carries the ad_storage consent: "G" = granted, "D" = denied. Its ABSENCE
// is itself meaningful (no consent signal sent), so we always report a state and
// surface "unset" rather than silently omitting it.
export function parseUetConsent(get) {
  const asc = get('asc');
  const cdb = get('cdb');
  let adStorage;
  if (asc === 'G') adStorage = 'granted';
  else if (asc === 'D') adStorage = 'denied';
  else adStorage = 'unset';
  return { adStorage, asc: asc ?? null, cdb: cdb ?? null };
}

// ---------------------------------------------------------------------------
// Full parse
// ---------------------------------------------------------------------------

// Returns a normalized record or null for non-UET requests.
// transport: 'standard' | 'first-party'
export function parseUetRequest(url, postData) {
  let host = '', pathname = '';
  try { const u = new URL(url); host = u.host; pathname = u.pathname; }
  catch (e) { return null; }

  if (!isUetPath(pathname)) return null;

  const { queryParams, bodyParams } = extractParams(url, postData);
  const get = (k) => queryParams[k] ?? (bodyParams && bodyParams[k]) ?? null;

  const ti = get('ti');
  const evt = get('evt');
  if (!ti) return null; // a UET hit always carries its tag id

  let transport = null;
  if (isBingHost(host)) transport = 'standard';
  else if (/^\d+$/.test(String(ti)) && evt) transport = 'first-party'; // proxied /action on own domain
  if (!transport) return null;

  const userData = parseUetUserData(get('pid'));
  const identifiers = summarizeUetIdentifiers(userData);
  const consent = parseUetConsent(get);

  // Friendly event name:
  //  - pageLoad → "pageLoad"
  //  - consent  → "consent default" / "consent update" (these are consent
  //    signals, not custom events — they fire repeatedly and carry no ec/ea)
  //  - pid      → "personal data" (payload is user data / enhanced conversions only)
  //  - custom   → "category – action" (label stays in the detail)
  //  - no evt   → "beacon"
  const ea = get('ea'), ec = get('ec'), el = get('el'), ev = get('ev');
  const src = get('src');
  const catAction = [ec, ea].filter(Boolean).join(' – ');
  let eventName;
  if (evt === 'pageLoad') {
    eventName = 'pageLoad';
  } else if (evt === 'consent') {
    eventName = src === 'update' ? 'consent update' : src === 'default' ? 'consent default' : 'consent';
  } else if (evt === 'pid') {
    eventName = 'personal data';
  } else if (evt) {
    eventName = catAction || el || 'custom event';
  } else {
    eventName = catAction || 'beacon';
  }

  // gc is the legacy currency; `currency` the new-syntax (en=1) field.
  const gv = get('gv'), gc = get('gc') || get('currency'), ecv = get('ecomm_totalvalue');
  const revVal = gv != null ? gv : ecv;
  const revenue = revVal != null ? { value: revVal, currency: gc || null } : null;

  const ecommerce = {};
  for (const [out, ins] of [
    ['prodid', ['prodid', 'ecomm_prodid']],
    ['pagetype', ['pagetype', 'ecomm_pagetype']],
    ['ecomm_totalvalue', ['ecomm_totalvalue']],
    ['ecomm_category', ['ecomm_category']],
  ]) {
    for (const k of ins) { const v = get(k); if (v != null) { ecommerce[out] = v; break; } }
  }
  const hasEcommerce = Object.keys(ecommerce).length > 0;

  const flags = {
    custom: !!evt && !['pageLoad', 'consent', 'pid'].includes(evt),
    consentEvent: evt === 'consent',     // evt=consent — a pure consent signal, not a tracking event
    personalData: evt === 'pid',         // evt=pid — payload is user data only
    beacon: !evt,
    revenue: !!revenue,
    enhancedConv: !!userData,
    ecommerce: hasEcommerce,
    iframe: get('ifm') === '1',
    spa: get('spa') === '1',
  };

  return {
    provider: 'uet',
    transport,
    host,
    pathname,
    effectiveUrl: url,
    effectivePath: pathname,
    method: postData ? 'POST' : 'GET',
    ti,
    evt,
    src,                                 // consent events: 'default' | 'update'
    eventName,
    ec, ea, el, ev,
    revenue,
    ecommerce: hasEcommerce ? ecommerce : null,
    userData,
    identifiers,
    flags,
    consent,
    tagManager: get('tm') || null,
    mid: get('mid') || null,
    queryParams,
    bodyParams,
  };
}
