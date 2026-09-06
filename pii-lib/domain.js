// Registrable-domain (eTLD+1) helpers — pure, no DOM / chrome APIs, so they run
// in the panel and under `node --test`. Used to decide whether a collection
// endpoint is genuinely first-party: its registrable domain must equal the
// visited page's registrable domain (an sGTM proxy on a subdomain of the site).
//
// This is deliberately NOT a full Public Suffix List. It covers what the
// extension actually compares — a page host vs. a tag/sGTM endpoint host — with
// plain TLDs (taggrs.io) and the common two-level ccTLD registries
// (example.co.uk). Exotic suffixes fall back to last-two-labels, which is only
// wrong for hosts we don't meet in practice.

const TWO_LEVEL_TLDS = new Set([
  'co.uk', 'org.uk', 'gov.uk', 'ac.uk', 'me.uk',
  'co.jp', 'ne.jp', 'or.jp',
  'com.au', 'net.au', 'org.au',
  'com.br', 'com.mx', 'com.tr', 'com.cn', 'com.sg', 'com.hk',
  'co.nz', 'co.za', 'co.in', 'co.kr',
]);

// Registrable domain of a host, lowercased. IPs and single-label hosts
// (localhost) are returned as-is.
export function registrableDomain(host) {
  const h = String(host || '').toLowerCase().replace(/\.+$/, '');
  if (!h || h === 'localhost') return h;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return h;   // IPv4
  if (h.includes(':')) return h;                     // IPv6 / host:port — caller should strip port
  const labels = h.split('.');
  if (labels.length <= 2) return h;
  const lastTwo = labels.slice(-2).join('.');
  const take = TWO_LEVEL_TLDS.has(lastTwo) ? 3 : 2;
  return labels.slice(-take).join('.');
}

// True when both hosts share one registrable domain (same-site). Empty / invalid
// input never matches.
export function isSameSite(a, b) {
  const ra = registrableDomain(a);
  const rb = registrableDomain(b);
  return !!ra && ra === rb;
}

// Same-site test where the second argument is a full page URL (the inspected
// page). Returns false when the URL is missing or unparseable — first-party is
// NEVER assumed from the absence of evidence.
export function isSameSiteUrl(host, pageUrl) {
  let pageHost = '';
  try { pageHost = new URL(pageUrl || '').host; } catch (e) { return false; }
  return isSameSite(host, pageHost);
}
