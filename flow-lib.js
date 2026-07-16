// ── flow-lib.js ─────────────────────────────────────────────────────────────
//
// Gemeinsame Analyse- und Report-Logik fuer flow-analyze.js (HAR-Input) und
// flow-recorder.js (Live-Aufnahme). Beide erzeugen dasselbe snapshot.json-Schema,
// damit flow-delta.js Baseline und Post-Umstellung vergleichen kann.
//
// Eingabe von analyze(): eine Liste normalisierter Requests
//   { url, method, postData, phase }
// egal ob aus HAR-Entries oder aus dem Live-Collector.

import {
  matchRequest, detectSSTFromUrls, extractStapeFindings, extractStapeMatches,
} from './lib/tracking-classify.js';
import {
  parseRequest, piiFromRecord, eventName, accountId, PROVIDER_LABEL,
} from './pii-lib/index.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

export function getHostname(u) { try { return new URL(u).hostname; } catch { return null; } }
export function hostForFilename(u) { const h = getHostname(u); return h ? h.replace(/\./g, '_') : 'unknown'; }
export function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
export function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// gcs hat die Form "G1XY": X = ad_storage, Y = analytics_storage (0=denied,
// 1=granted, -=unset). "fullyDenied" = beide Purposes denied (G100). NUR das ist
// ein belastbares Indiz -- ein Ping, der trotz komplettem Deny feuert. G101/G110
// sind Teil-Consent und im Basic Mode voellig normal (z.B. keine Ads-Einwilligung).
// Basic vs. Advanced laesst sich aus gcs allein NICHT bestimmen -- das ist eine
// zeitliche Frage (feuert etwas VOR der Consent-Interaktion?), nicht eine des Werts.
export function gcsState(gcs) {
  if (typeof gcs !== 'string' || !/^G1[01-][01-]/.test(gcs)) return null;
  const ad = gcs[2], an = gcs[3];
  return { ad, an, fullyDenied: ad === '0' && an === '0' };
}

// ── Analyse ───────────────────────────────────────────────────────────────────

export function analyze(requests, siteUrl) {
  const siteHost = getHostname(siteUrl);
  const allUrls = requests.map(r => r.url);

  // — Trackers (Praesenz ueber tracking-vendors.json, inkl. Stape-Tunnel) —
  const trackerMap = new Map();
  const addTracker = (m, phase) => {
    if (!m) return;
    const gk = m.key || ('_tp_' + m.hostname);
    if (!trackerMap.has(gk)) {
      trackerMap.set(gk, {
        key: m.key, vendor: m.vendor, product: m.product, category: m.category,
        hostnames: new Set(), phases: new Set(), transports: new Set(), events: new Set(),
      });
    }
    const t = trackerMap.get(gk);
    if (m.hostname) t.hostnames.add(m.hostname);
    if (phase) t.phases.add(phase);
    t.transports.add(m.direction);
    if (m.type) t.events.add(m.type);
  };

  // — PII je Provider (aus den Extension-Parsern) —
  const piiMap = new Map();
  const addPii = (provider, rec, phase) => {
    const pf = piiFromRecord(rec);
    if (!pf.any) return;
    if (!piiMap.has(provider)) {
      piiMap.set(provider, {
        provider,
        vendor: PROVIDER_LABEL[provider] || provider,
        hosts: new Set(), transports: new Set(), phases: new Set(),
        events: new Set(), account: new Set(),
        fields: { email: false, phone: false, name: false, address: false },
        hashed: false,
      });
    }
    const p = piiMap.get(provider);
    p.hosts.add(rec.host || getHostname(rec.effectiveUrl) || '?');
    if (rec.transport) p.transports.add(rec.transport);
    if (phase) p.phases.add(phase);
    const ev = eventName(rec); if (ev) p.events.add(ev);
    const acc = accountId(rec); if (acc) p.account.add(String(acc));
    for (const k of ['email', 'phone', 'name', 'address']) p.fields[k] = p.fields[k] || pf.fields[k];
    p.hashed = p.hashed || pf.hashed;
  };

  for (const r of requests) {
    addTracker(matchRequest(r.url, siteHost), r.phase);
    const rec = parseRequest(r.url, r.postData);
    if (rec) addPii(rec.provider, rec, r.phase);
  }

  // Stape Custom Loader: getunnelte Hits klassifizieren und als eigene Tracker-
  // Richtung ('sst-tunnel') mergen; ausserdem die synthetischen Google-URLs durch
  // die PII-Parser schicken, damit getunnelte PII nicht verloren geht.
  const stapeMatches = extractStapeMatches(requests, siteHost);
  for (const m of stapeMatches) addTracker(m, 'tunnel');
  const stape = extractStapeFindings(requests);
  for (const d of stape.decodedRequests) {
    const rec = parseRequest(d.syntheticUrl, null);
    if (rec) addPii(rec.provider, rec, 'tunnel');
  }

  // — SST / Consent Mode —
  const sst = detectSSTFromUrls(allUrls, siteHost);
  if (stape.decodedRequests.length) {
    const sstStape = detectSSTFromUrls(stape.decodedRequests.map(d => d.syntheticUrl), siteHost);
    for (const id of sstStape.containers) sst.containers.add(id);
    for (const id of sstStape.measurementIds) sst.measurementIds.add(id);
    sst.loaders.push(...sstStape.loaders);
    sst.collectEndpoints.push(...sstStape.collectEndpoints);
  }

  // Consent Mode aus den GA4/Ads-Records (gcs/gcd), mit Phase.
  // Echte Klassifikation: "Advanced" heisst, dass Pings bereits im DENIED-Zustand
  // feuern (gcs=G10x, cookieless vor Consent). Nur volle-Consent-Pings (G111) zu
  // sehen beweist KEIN Advanced -- dann fehlt evtl. nur das denied-Fenster in der
  // Aufnahme. gcs-lose Pings (nur gcd) sind NICHT "fehlende Flags".
  const gcsCounts = {};
  let fullyDeniedPings = 0;
  const consentSamples = [];
  const seenCm = new Set();
  for (const r of requests) {
    const rec = parseRequest(r.url, r.postData);
    if (!rec || !rec.consent) continue;
    const gcs = rec.consent.gcs || null;
    if (gcs) {
      gcsCounts[gcs] = (gcsCounts[gcs] || 0) + 1;
      const st = gcsState(gcs);
      if (st && st.fullyDenied) fullyDeniedPings++;
    }
    if (gcs || rec.consent.gcd) {
      const key = `${r.phase}|${gcs || '-'}|${rec.consent.gcd || '-'}`;
      if (!seenCm.has(key)) {
        seenCm.add(key);
        consentSamples.push({ phase: r.phase || '-', gcs: gcs || '(kein gcs)', gcd: rec.consent.gcd || '-' });
      }
    }
  }

  const perPhase = {};
  for (const r of requests) { const ph = r.phase || 'flow'; perPhase[ph] = (perPhase[ph] || 0) + 1; }

  const arr = (s) => [...s];
  return {
    trackers: [...trackerMap.values()].map(t => ({
      key: t.key, vendor: t.vendor, product: t.product || t.vendor, category: t.category,
      hostnames: arr(t.hostnames),
      phases: arr(t.phases), transports: arr(t.transports), events: arr(t.events),
    })),
    pii: [...piiMap.values()].map(p => ({
      provider: p.provider, vendor: p.vendor,
      hosts: arr(p.hosts), transports: arr(p.transports), phases: arr(p.phases),
      events: arr(p.events), account: arr(p.account),
      fields: p.fields, hashed: p.hashed,
    })),
    consentMode: {
      gcsCounts,
      fullyDeniedPings,
      note: 'Basic vs. Advanced ist aus gcs-Werten allein nicht bestimmbar -- entscheidend ist, ob Pings VOR der Consent-Interaktion bzw. trotz denied Defaults feuern (zeitliche Zuordnung, die dieser Request-Snapshot nicht leistet). G101/G110 sind Teil-Consent, kein Advanced-Indiz; nur G100-Pings zaehlen als "trotz Deny gefeuert".',
      samples: consentSamples,
    },
    sst: {
      containers: [...sst.containers], measurementIds: [...sst.measurementIds],
      loaders: sst.loaders, collectEndpoints: sst.collectEndpoints,
      stape: stape.transports,
    },
    requestCounts: { perPhase, total: requests.length },
  };
}

// ── Report ────────────────────────────────────────────────────────────────────

export function generateReport(analysis, meta) {
  const L = [];
  const ln = (s = '') => L.push(s);
  const yn = (b) => b ? 'JA' : '-';

  ln(`# Flow-Aufnahme: ${meta.label}`);
  ln();
  ln(`| | |`);
  ln(`|---|---|`);
  ln(`| Datum | ${meta.timestamp} |`);
  ln(`| URL | ${meta.url} |`);
  ln(`| Label | ${meta.label} |`);
  ln(`| Quelle | ${meta.source || 'live'} |`);
  if (meta.phasesReached && meta.phasesReached.length) ln(`| Erreichte Phasen | ${meta.phasesReached.join(' -> ')} |`);
  ln(`| Requests gesamt | ${analysis.requestCounts.total} |`);
  ln();

  ln(`## TL;DR`);
  ln(`- **${analysis.trackers.length}** Tracking-Produkte erkannt`);
  const piiVendors = analysis.pii.filter(p => p.fields.email || p.fields.phone || p.fields.name || p.fields.address);
  ln(`- **${piiVendors.length}** Vendor(en) mit PII-Versand: ${piiVendors.map(p => p.vendor).join(', ') || 'keiner'}`);
  const gcsTl = Object.entries(analysis.consentMode.gcsCounts || {}).map(([g, n]) => `${g}×${n}`).join(', ') || 'keine';
  ln(`- Consent (gcs beobachtet): ${gcsTl} · G100-Pings (trotz Deny): ${analysis.consentMode.fullyDeniedPings}`);
  ln(`- SST/Loader: Container ${analysis.sst.containers.join(', ') || 'keine'} | Custom Loader: ${analysis.sst.stape.map(s => s.host).join(', ') || 'nein'}`);
  ln();

  // PII — Kernstueck
  ln(`## PII-Versand pro Vendor`);
  ln();
  ln(`| Vendor | E-Mail | Telefon | Name | Adresse | Gehasht | Phasen | Transport |`);
  ln(`|--------|:------:|:-------:|:----:|:-------:|:-------:|--------|-----------|`);
  if (analysis.pii.length === 0) {
    ln(`| _kein PII-Versand erkannt_ | - | - | - | - | - | - | - |`);
  }
  for (const p of analysis.pii) {
    ln(`| ${p.vendor} | ${yn(p.fields.email)} | ${yn(p.fields.phone)} | ${yn(p.fields.name)} | ${yn(p.fields.address)} | ${p.hashed ? 'ja' : 'nein'} | ${p.phases.join(', ') || '-'} | ${p.transports.join(', ') || '-'} |`);
  }
  ln();

  // Trackers
  ln(`## Erkannte Tracker`);
  ln();
  ln(`| Produkt | Kategorie | Phasen | Transport | Events |`);
  ln(`|---------|-----------|--------|-----------|--------|`);
  for (const t of analysis.trackers.sort((a, b) => (a.category || '').localeCompare(b.category || ''))) {
    // Unbekannte Third-Parties per Host ausweisen, sonst kollabieren sie zu einer Zeile.
    const name = t.key ? t.product : `${t.product} — ${(t.hostnames && t.hostnames[0]) || '?'}`;
    ln(`| ${name} | ${t.category || '-'} | ${t.phases.join(', ') || '-'} | ${t.transports.join(', ')} | ${t.events.join(', ') || '-'} |`);
  }
  ln();

  // Consent Mode
  const cm = analysis.consentMode;
  ln(`## Consent Mode (gcs/gcd)`);
  ln();
  const gcsList = Object.entries(cm.gcsCounts || {}).map(([g, n]) => `\`${g}\` ×${n}`).join(', ');
  ln(`- beobachtete gcs-Werte: ${gcsList || 'keine'}`);
  ln(`- Pings im vollstaendig denied-Zustand (G100): ${cm.fullyDeniedPings}`);
  ln();
  ln(`> **Hinweis:** ${cm.note}`);
  ln();
  if (cm.samples.length) {
    ln(`| Phase | gcs | gcd |`);
    ln(`|-------|-----|-----|`);
    for (const s of cm.samples) ln(`| ${s.phase} | \`${s.gcs}\` | \`${s.gcd}\` |`);
    ln();
  }

  // SST
  ln(`## SST / Custom Loader`);
  ln();
  if (analysis.sst.loaders.length === 0 && analysis.sst.stape.length === 0) {
    ln(`Keine Loader erkannt.`);
  } else {
    for (const l of analysis.sst.loaders) ln(`- **${l.type}** ${l.id}: \`${l.host}\` (${l.isStandard ? 'Standard' : 'Custom/First-Party'})`);
    for (const s of analysis.sst.stape) ln(`- **${s.type}**: \`${s.host}\``);
  }
  if (analysis.sst.collectEndpoints.length) {
    ln(`- Collect-Endpoints:`);
    for (const c of analysis.sst.collectEndpoints) ln(`  - \`${c.host}${c.path}\` (${c.tid})`);
  }
  ln();

  ln(`## Artefakte`);
  if (meta.harFile) ln(`- HAR: \`${meta.harFile}\``);
  ln(`- Snapshot (fuer Delta): \`${meta.snapshotFile}\``);
  ln();

  return L.join('\n');
}

// ── HAR-Parsing ───────────────────────────────────────────────────────────────

// Wandelt HAR-Entries in normalisierte Requests { url, method, postData, phase }.
// phase kommt aus dem HAR-pageref (falls vorhanden), sonst 'flow'. postData wird
// aus request.postData.text bzw. params rekonstruiert.
export function harToRequests(har) {
  const entries = (har && har.log && Array.isArray(har.log.entries)) ? har.log.entries : [];
  return entries.map((e) => {
    const req = e.request || {};
    let postData = null;
    if (req.postData) {
      if (typeof req.postData.text === 'string' && req.postData.text.length) {
        postData = req.postData.text;
      } else if (Array.isArray(req.postData.params) && req.postData.params.length) {
        postData = req.postData.params
          .map(p => `${encodeURIComponent(p.name || '')}=${encodeURIComponent(p.value || '')}`)
          .join('&');
      }
    }
    return {
      url: req.url || '',
      method: req.method || 'GET',
      postData,
      phase: e.pageref || 'flow',
    };
  }).filter(r => r.url);
}

// Ermittelt den Shop-Host aus dem HAR: bevorzugt das erste HTML-Dokument, sonst
// der haeufigste First-Party-Host, sonst der Host des ersten Requests.
export function inferSiteUrl(har, override) {
  if (override) return override;
  const entries = (har && har.log && Array.isArray(har.log.entries)) ? har.log.entries : [];
  for (const e of entries) {
    const mime = e.response && e.response.content && e.response.content.mimeType || '';
    if (/text\/html/i.test(mime) && e.request && e.request.url) return e.request.url;
  }
  const pageUrl = har && har.log && Array.isArray(har.log.pages) && har.log.pages[0] && har.log.pages[0].title;
  if (pageUrl && /^https?:\/\//.test(pageUrl)) return pageUrl;
  return entries[0] && entries[0].request ? entries[0].request.url : null;
}
