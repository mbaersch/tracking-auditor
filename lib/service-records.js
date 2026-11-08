// ── lib/service-records.js ───────────────────────────────────────────────────
//
// Wertet Requests mit den Parsern der pii-lib aus und verdichtet sie je Dienst und
// Phase (Events, Werte, Nutzerdaten, Consent-Signal). Gemeinsame Quelle fuer
// audit.js und compare.js, damit dort keine eigene, schwaechere Payload-Logik noetig ist.

import { parseRequestsAsync, piiFromRecord, eventName, accountId, PROVIDER_LABEL } from '../pii-lib/index.js';

const PII_FIELDS = ['email', 'phone', 'name', 'address'];

/** Consent-Signal eines Records als kurzer Text, oder null. Form je Dienst verschieden. */
export function consentLabel(rec) {
  const c = rec.consent;
  if (!c || typeof c !== 'object') return null;
  if (c.gcs) return `gcs=${c.gcs}`;
  if (c.gcd) return `gcd=${c.gcd}`;
  if ('asc' in c) return `asc=${c.asc ?? '–'}`;
  if ('ldu' in c) return c.ldu ? 'LDU' : null;
  if (typeof c.granted === 'boolean') return c.granted ? 'granted' : 'denied';
  return null;
}

export function newServiceMap() { return new Map(); }

/**
 * Parst alle Requests und traegt die Records in services ein (mutiert).
 * requests: [{ url, postData, phase }]. Liefert die Records je Request zurueck.
 */
export async function collectServiceRecords(requests, siteUrl, services) {
  const perRequest = await Promise.all(requests.map(r => parseRequestsAsync(r.url, r.postData, siteUrl)));
  requests.forEach((r, i) => {
    const phase = r.phase || '-';
    for (const rec of perRequest[i]) {
      const provider = rec.provider;
      if (!services.has(provider)) {
        services.set(provider, {
          label: PROVIDER_LABEL[provider] || provider,
          transports: new Set(), accounts: new Set(), phases: new Map(),
        });
      }
      const s = services.get(provider);
      if (rec.transport) s.transports.add(rec.transport);
      const acc = accountId(rec); if (acc) s.accounts.add(String(acc));
      if (!s.phases.has(phase)) {
        s.phases.set(phase, {
          records: 0, events: new Map(), withValue: 0, currencies: new Set(), withTransaction: 0,
          withItems: 0, pii: { email: false, phone: false, name: false, address: false }, hashed: false,
          consent: new Set(), collapsed: new Set(),
        });
      }
      const p = s.phases.get(phase);
      p.records++;
      // Google Ads spiegelt ein Signal auf mehrere Endpunkte (_collapseKey wie im Panel der
      // Extension): je Signal nur einmal zaehlen, sonst wirkt ein page_view wie acht.
      if (rec._collapseKey) {
        if (p.collapsed.has(rec._collapseKey)) continue;
        p.collapsed.add(rec._collapseKey);
      }
      const ev = eventName(rec) || rec.signalType || '(ohne Name)';
      p.events.set(ev, (p.events.get(ev) || 0) + 1);
      if (rec.revenue) {
        p.withValue++;
        if (rec.revenue.currency) p.currencies.add(rec.revenue.currency);
      }
      if (rec.transactionId || rec.orderId || rec.oid) p.withTransaction++;
      if ((Array.isArray(rec.items) && rec.items.length) || rec.contentIds || (rec.flags && rec.flags.itemCount)) p.withItems++;
      const pf = piiFromRecord(rec);
      for (const k of PII_FIELDS) p.pii[k] = p.pii[k] || pf.fields[k];
      p.hashed = p.hashed || pf.hashed;
      const cl = consentLabel(rec); if (cl) p.consent.add(cl);
    }
  });
  return perRequest;
}

const PII_LABEL = { email: 'E-Mail', phone: 'Telefon', name: 'Name', address: 'Adresse' };

/** Markdown-Tabelle: eine Zeile je Dienst und Phase. */
export function formatServiceTable(services) {
  if (!services || services.size === 0) return '';
  let md = '| Dienst | Phase | Events | Wert | Transaktion | Artikel | Nutzerdaten | Consent-Signal |\n';
  md += '|--------|-------|--------|------|-------------|---------|-------------|----------------|\n';
  for (const s of services.values()) {
    for (const [phase, p] of s.phases) {
      const events = [...p.events].map(([n, c]) => c > 1 ? `${n} ×${c}` : n).join(', ');
      const value = p.withValue ? `${p.withValue}×${p.currencies.size ? ' (' + [...p.currencies].join(', ') + ')' : ''}` : '–';
      const pii = PII_FIELDS.filter(k => p.pii[k]).map(k => PII_LABEL[k]);
      const piiText = pii.length ? `${pii.join(', ')}${p.hashed ? ' (gehasht)' : ' (⚠ nicht gehasht erkannt)'}` : '–';
      const consent = p.consent.size ? [...p.consent].slice(0, 4).join(', ') + (p.consent.size > 4 ? ' …' : '') : '–';
      md += `| ${s.label} | ${phase} | ${events} | ${value} | ${p.withTransaction || '–'} | ${p.withItems || '–'} | ${piiText} | ${consent} |\n`;
    }
  }
  return md + '\n';
}

/**
 * Enhanced Conversions (Google): aus GA4- und Google-Ads-Records abgeleitet, Form wie
 * frueher checkEnhancedConversions ({ active, hasHashedEmail, eventName }).
 */
export function enhancedConversionsFrom(records) {
  for (const rec of records) {
    if (rec.provider !== 'ga4' && rec.provider !== 'googleads') continue;
    const pf = piiFromRecord(rec);
    const ec = pf.any || (rec.flags && rec.flags.enhancedConversions);
    if (!ec) continue;
    return { active: true, hasHashedEmail: pf.fields.email && pf.hashed, eventName: eventName(rec) || null };
  }
  return null;
}

/**
 * Dynamic Remarketing (Google Ads): Remarketing-Records mit Produktdaten im data-Parameter
 * (event;google_business_vertical;id) bzw. Conversion-Artikeln. Form wie frueher
 * checkRemarketingPayload ({ active, hasProductIds, pageType }).
 */
export function remarketingFrom(records) {
  const out = [];
  for (const rec of records) {
    if (rec.provider !== 'googleads') continue;
    // Legacy-Tags senden ecomm_*/dynx_* als eigene Parameter, gtag packt es in data=…
    const top = (k) => (rec.queryParams && rec.queryParams[k]) || (rec.bodyParams && rec.bodyParams[k]) || null;
    const pd = { ...rec.productData };
    for (const k of ['ecomm_prodid', 'ecomm_pagetype', 'dynx_itemid', 'dynx_pagetype']) pd[k] = pd[k] || top(k);
    const hasIds = !!(pd.id || pd.items || pd.ecomm_prodid || pd.dynx_itemid);
    const ev = pd.event && !String(pd.event).startsWith('gtag.') ? pd.event : null;
    const pageType = ev || pd.ecomm_pagetype || pd.dynx_pagetype || null;
    if (!hasIds && !pageType) continue;
    out.push({ active: true, hasProductIds: hasIds, pageType });
  }
  return out;
}
