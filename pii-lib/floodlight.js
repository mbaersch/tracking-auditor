// Google Marketing Platform Floodlight (CM360 / DV360) request detection &
// parsing — pure functions, no DOM / chrome APIs, so they run in the panel and
// under `node --test`. Sits next to Google Ads (same DoubleClick infrastructure).
//
// A Floodlight fire is a pair of mirror requests carrying MATRIX params (`;`-
// delimited in the path, NOT a normal query string):
//   ad.doubleclick.net/activity;src=…;type=…;cat=…;ord=…;u1=…    (the counter)
//   <src>.fls.doubleclick.net/activityi;src=…;type=…;cat=…;ord=…  (image mirror)
// The two share (src,type,cat,ord), so we fold them into one card via the panel's
// generic transport-collapse (see _collapseKey / _transportLabel below).
//
// Fields:
//   src   advertiser / Floodlight config id (the fls.* subdomain)
//   type  activity GROUP tag        cat   activity tag   (both advertiser-defined,
//                                          cryptic, surfaced verbatim)
//   ord   ordinal — random for counter activities, the order id for sales
//   num   counter cache-buster · cost/qty  sales value / quantity
//   u1..uN  custom Floodlight variables (page url, product id, … — whatever the
//           advertiser mapped; can carry PII, so we scan for cleartext emails)
//   gcs/gcd/dma/npa/gpp  consent · auiddc DoubleClick id · ~oref referring page

import { parseGcs, parseGcd } from './ga4.js';   // consent decoders, reused
import { piiField } from './params.js';

// ---------------------------------------------------------------------------
// Detection + matrix parsing
// ---------------------------------------------------------------------------

export function isFloodlightHost(host) {
  const h = (host || '').toLowerCase();
  return h === 'ad.doubleclick.net' || h === 'fls.doubleclick.net' || /\.fls\.doubleclick\.net$/.test(h);
}

// Split "…/activity;src=1;type=x;u1=%2F?dc_random=…" into { host, base, params }.
// Values stay URL-encoded; callers decode on read. Matrix params live in the
// PATH (JS URL keeps them in pathname), a couple of tech params may trail in ?query.
function parseActivity(url) {
  let u;
  try { u = new URL(url); } catch (e) { return null; }
  const segs = u.pathname.split(';');
  const base = segs[0];
  const params = {};
  for (const s of segs.slice(1)) {
    if (!s) continue;
    const i = s.indexOf('=');
    if (i < 0) { params[s] = ''; continue; }
    params[s.slice(0, i)] = s.slice(i + 1);
  }
  for (const [k, v] of u.searchParams) if (!(k in params)) params[k] = v;   // trailing ?query tech params
  return { host: u.host, base, params };
}

const dec = (v) => {
  if (typeof v !== 'string') return v;
  try { return decodeURIComponent(v); } catch (e) { return v; }
};

// ---------------------------------------------------------------------------
// Custom vars + PII
// ---------------------------------------------------------------------------

// { u1: '…', u3: '…' } (decoded), in numeric order, or null.
function extractCustomVars(params) {
  const out = {};
  for (const k of Object.keys(params).filter((k) => /^u\d+$/.test(k)).sort((a, b) => +a.slice(1) - +b.slice(1))) {
    out[k] = dec(params[k]);
  }
  return Object.keys(out).length ? out : null;
}

// Floodlight custom vars are opaque, so we only classify what is unambiguous: a
// value containing '@' is a cleartext email. Hash-shaped values are left alone
// (they are just as likely to be product/order ids) to avoid false PII alarms.
export function extractFloodlightUserData(customVars) {
  if (!customVars) return null;
  const ud = {};
  for (const [k, v] of Object.entries(customVars)) {
    if (typeof v === 'string' && v.includes('@') && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) {
      ud[k] = piiField('email', `Email (${k})`, v);
    }
  }
  return Object.keys(ud).length ? ud : null;
}

// ---------------------------------------------------------------------------
// Full parse
// ---------------------------------------------------------------------------

export function parseFloodlightRequest(url) {
  const a = parseActivity(url);
  if (!a) return null;
  if (!isFloodlightHost(a.host)) return null;
  if (a.base !== '/activity' && a.base !== '/activityi') return null;

  const p = a.params;
  const src = p.src;
  if (!src) return null;                                  // every Floodlight fire carries its advertiser id

  const type = p.type || null;
  const cat = p.cat || null;
  const customVars = extractCustomVars(p);
  const userData = extractFloodlightUserData(customVars);

  const cost = p.cost != null && p.cost !== '' ? dec(p.cost) : null;
  const isSales = cost != null;

  const consent = (() => {
    const gcs = parseGcs(p.gcs), gcd = parseGcd(p.gcd);
    if (!gcs && !gcd && !p.gcs && !p.gcd && !p.dma && !p.npa) return null;
    return {
      adStorage: gcs ? gcs.adStorage : null,
      analyticsStorage: gcs ? gcs.analyticsStorage : null,
      gcs: gcs ? gcs.raw : (p.gcs || null),
      gcd: p.gcd || null,
      gcdDecoded: gcd,
      dma: p.dma || null,
      npa: p.npa || null,
      gpp: p.gpp || null,
      gppSid: p.gpp_sid || null,
    };
  })();

  const transport = a.base === '/activityi' ? 'activityi' : 'activity';

  // Two DoubleClick /activity fires can look almost identical, but the parameter
  // set tells them apart by PURPOSE. A fire carrying Google-Click linking (gcl*)
  // and/or enhanced-conversions markers (em / user_data_mode) is one that gtag's
  // Google Ads / Google-Signals integration sent — a remarketing / conversion
  // signal riding the Floodlight endpoint — as opposed to a classic advertiser
  // activity counter, which instead carries custom variables (u1..uN). We flag
  // this so the card can say WHY it fired without pretending it's a different
  // provider (the endpoint is still Floodlight).
  const gcl = ['gclaw', 'gclgs', 'gclst', 'gcllp', 'gclid'].filter((k) => p[k] != null && p[k] !== '');
  const googleAdsLinked = gcl.length > 0;
  const enhancedConversions = (p.user_data_mode != null && p.user_data_mode !== '') || (p.em != null && p.em !== '');

  return {
    provider: 'floodlight',
    transport,
    host: a.host,
    pathname: a.base,
    effectiveUrl: url,
    effectivePath: a.base,
    method: 'GET',
    advertiserId: String(src),
    group: type,
    activityTag: cat,
    event: [type, cat].filter(Boolean).join('/') || null,   // advertiser-defined, verbatim
    ord: p.ord || null,
    num: p.num || null,
    revenue: isSales ? { value: String(cost), currency: dec(p.cost_currency || p.currency) || null } : null,
    quantity: p.qty != null && p.qty !== '' ? String(p.qty) : null,
    customVars,
    pageUrl: dec(p['~oref']) || (customVars && /^https?:\/\//.test(customVars.u1 || '') ? customVars.u1 : null),
    dcUserId: p.auiddc || null,
    gclid: dec(p.gclaw) || null,          // the Google Ads click id, if this activity is Ads-linked
    consent,
    userData,
    identifiers: { email: userData ? Object.keys(userData).length : 0, phone: 0, name: 0, address: 0 },
    flags: {
      sales: isSales,
      counter: !isSales,
      cleartextEmail: !!(userData && Object.values(userData).some((f) => !f.hashed)),
      googleAdsLinked,
      enhancedConversions,
    },
    // transport-collapse: the activity + activityi mirrors of one fire fold into
    // one card (they share src/type/cat/ord).
    _collapseKey: `fl:${src}:${type || ''}:${cat || ''}:${p.ord || ''}`,
    _transportLabel: transport,
    _transportRank: a.base === '/activity' ? 100 : 90,
    queryParams: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, dec(v)])),
    bodyParams: null,
  };
}
