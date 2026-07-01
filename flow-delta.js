#!/usr/bin/env node

/**
 * flow-delta.js – Vergleicht zwei Flow-Snapshots (flow-analyze.js / flow-recorder.js)
 * ueber die Zeit: Baseline (vorher) gegen Current (nach der Umstellung). Fokus:
 * Was kam an Trackern/PII dazu, was fiel weg, was aenderte sich (Consent, Server-Side).
 *
 * Usage:
 *   node flow-delta.js --baseline <snapshot.json> --current <snapshot.json> --project <name>
 *
 * Required:
 *   --baseline   Snapshot-JSON des Vorher-Laufs
 *   --current    Snapshot-JSON des Nachher-Laufs
 *   --project    Projektname (bestimmt reports/<project>/)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { timestamp } from './flow-lib.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };

const baselineArg = get('--baseline');
const currentArg = get('--current');
const project = get('--project');

if (!baselineArg || !currentArg || !project) {
  console.error('Usage: node flow-delta.js --baseline <snapshot.json> --current <snapshot.json> --project <name>');
  process.exit(1);
}

function loadSnapshot(p) {
  const full = resolve(process.cwd(), p);
  if (!existsSync(full)) { console.error(`  FEHLER: Snapshot nicht gefunden: ${full}`); process.exit(1); }
  try { return JSON.parse(readFileSync(full, 'utf-8')); }
  catch (e) { console.error(`  FEHLER: Snapshot kein JSON: ${e.message}`); process.exit(1); }
}

const base = loadSnapshot(baselineArg);
const curr = loadSnapshot(currentArg);

// ── Diff-Helfer ───────────────────────────────────────────────────────────────

// Bekannte Tracker per Library-Key, unbekannte Third-Parties per Host -- sonst
// kollabieren alle "Sonstige Third-Party" zu einem Key und die Churn wird unsichtbar.
const trackerKey = (t) => t.key || `tp:${(t.hostnames && t.hostnames[0]) || t.vendor}`;
const trackerName = (t) => t.key ? t.product : `${t.product} (${(t.hostnames && t.hostnames[0]) || '?'})`;

function diffTrackers(a, b) {
  const ma = new Map(a.map(t => [trackerKey(t), t]));
  const mb = new Map(b.map(t => [trackerKey(t), t]));
  const onlyA = [...ma.keys()].filter(k => !mb.has(k)).map(k => ma.get(k));
  const onlyB = [...mb.keys()].filter(k => !ma.has(k)).map(k => mb.get(k));
  const both = [...ma.keys()].filter(k => mb.has(k)).map(k => ({ a: ma.get(k), b: mb.get(k) }));
  return { onlyA, onlyB, both };
}

// PII pro Provider indizieren.
function piiIndex(arr) {
  const m = new Map();
  for (const p of arr) m.set(p.provider, p);
  return m;
}

const FIELDS = ['email', 'phone', 'name', 'address'];

function diffPii(a, b) {
  const ia = piiIndex(a), ib = piiIndex(b);
  const providers = [...new Set([...ia.keys(), ...ib.keys()])];
  const rows = [];
  for (const prov of providers) {
    const pa = ia.get(prov), pb = ib.get(prov);
    const fa = pa ? pa.fields : { email: false, phone: false, name: false, address: false };
    const fb = pb ? pb.fields : { email: false, phone: false, name: false, address: false };
    const added = FIELDS.filter(f => !fa[f] && fb[f]);
    const removed = FIELDS.filter(f => fa[f] && !fb[f]);
    const hashedA = pa ? pa.hashed : false;
    const hashedB = pb ? pb.hashed : false;
    let status = 'identisch';
    if (!pa && pb) status = 'NEU (PII)';
    else if (pa && !pb) status = 'entfallen';
    else if (added.length || removed.length) status = 'geaendert';
    else if (hashedA !== hashedB) status = 'geaendert (Hash)';
    rows.push({
      provider: prov,
      vendor: (pb || pa).vendor,
      fa, fb, added, removed, hashedA, hashedB, status,
      transportsA: pa ? pa.transports : [], transportsB: pb ? pb.transports : [],
    });
  }
  return rows;
}

const trackerDiff = diffTrackers(base.trackers || [], curr.trackers || []);
const piiRows = diffPii(base.pii || [], curr.pii || []);

// ── Report ────────────────────────────────────────────────────────────────────

const L = [];
const ln = (s = '') => L.push(s);
const yn = (b) => b ? 'JA' : '-';
const nmeta = base.meta || {}, cmeta = curr.meta || {};

ln(`# Flow-Delta: ${nmeta.label || 'baseline'} -> ${cmeta.label || 'current'}`);
ln();
ln(`| | Baseline | Current |`);
ln(`|---|---|---|`);
ln(`| Label | ${nmeta.label || '-'} | ${cmeta.label || '-'} |`);
ln(`| Aufnahme | ${nmeta.timestamp || '-'} | ${cmeta.timestamp || '-'} |`);
ln(`| URL | ${nmeta.url || '-'} | ${cmeta.url || '-'} |`);
ln(`| Requests | ${base.requestCounts?.total ?? '-'} | ${curr.requestCounts?.total ?? '-'} |`);
ln(`| Tracker | ${(base.trackers || []).length} | ${(curr.trackers || []).length} |`);
ln();

// TL;DR
ln(`## TL;DR`);
const piiNew = piiRows.filter(r => r.status.startsWith('NEU'));
const piiChanged = piiRows.filter(r => r.status.startsWith('geaendert'));
const piiGone = piiRows.filter(r => r.status === 'entfallen');
if (trackerDiff.onlyB.length) ln(`- ⚠️ **${trackerDiff.onlyB.length} neue Tracker**: ${trackerDiff.onlyB.map(trackerName).join(', ')}`);
if (trackerDiff.onlyA.length) ln(`- **${trackerDiff.onlyA.length} entfallene Tracker**: ${trackerDiff.onlyA.map(trackerName).join(', ')}`);
if (piiNew.length) ln(`- ⚠️ **${piiNew.length} Vendor(en) senden NEU PII**: ${piiNew.map(r => r.vendor).join(', ')}`);
if (piiChanged.length) ln(`- ⚠️ **${piiChanged.length} Vendor(en) mit geaenderter PII**: ${piiChanged.map(r => `${r.vendor} (+${r.added.join(',') || '-'})`).join('; ')}`);
if (piiGone.length) ln(`- **${piiGone.length} Vendor(en) senden keine PII mehr**: ${piiGone.map(r => r.vendor).join(', ')}`);
if (!trackerDiff.onlyA.length && !trackerDiff.onlyB.length && !piiNew.length && !piiChanged.length && !piiGone.length) {
  ln(`- Keine Aenderungen bei Trackern oder PII.`);
}
const gcsStr = (cm) => Object.entries(cm?.gcsCounts || {}).map(([g, n]) => `${g}×${n}`).join(', ') || 'keine';
const gA = gcsStr(base.consentMode), gB = gcsStr(curr.consentMode);
ln(`- Consent (gcs): ${gA === gB ? `identisch (${gA})` : `${gA} -> ${gB}`}`);
const fdA = base.consentMode?.fullyDeniedPings || 0, fdB = curr.consentMode?.fullyDeniedPings || 0;
if (fdA !== fdB) ln(`- ⚠️ G100-Pings (trotz Deny gefeuert): ${fdA} -> ${fdB}`);
const contA = (base.sst?.containers || []).join(', ') || 'keine';
const contB = (curr.sst?.containers || []).join(', ') || 'keine';
ln(`- GTM-Container: ${contA === contB ? `identisch (${contA})` : `**ABWEICHEND** (${contA} -> ${contB})`}`);
ln();

// PII-Delta — Kernstueck
ln(`## PII-Delta pro Vendor`);
ln();
ln(`| Vendor | Feld Baseline -> Current | Neu | Entfallen | Hash (B->C) | Status |`);
ln(`|--------|--------------------------|-----|-----------|-------------|--------|`);
if (piiRows.length === 0) ln(`| _keine PII in beiden Laeufen_ | - | - | - | - | - |`);
const fstr = (f) => FIELDS.filter(x => f[x]).join('+') || 'keine';
for (const r of piiRows.sort((a, b) => a.status.localeCompare(b.status))) {
  ln(`| ${r.vendor} | ${fstr(r.fa)} -> ${fstr(r.fb)} | ${r.added.join(', ') || '-'} | ${r.removed.join(', ') || '-'} | ${r.hashedA ? 'ja' : 'nein'} -> ${r.hashedB ? 'ja' : 'nein'} | ${r.status} |`);
}
ln();

// Tracker-Delta
ln(`## Tracker-Delta`);
ln();
if (trackerDiff.onlyB.length) {
  ln(`### Neu (nur Current)`);
  for (const t of trackerDiff.onlyB) ln(`- **${trackerName(t)}** (${t.category || '-'}) — ${t.transports.join(', ')} ${t.events.length ? '· ' + t.events.join(', ') : ''}`);
  ln();
}
if (trackerDiff.onlyA.length) {
  ln(`### Entfallen (nur Baseline)`);
  for (const t of trackerDiff.onlyA) ln(`- **${trackerName(t)}** (${t.category || '-'})`);
  ln();
}
ln(`### Auf beiden (mit Aenderungen)`);
ln();
ln(`| Produkt | Transport B->C | Events B->C |`);
ln(`|---------|----------------|-------------|`);
for (const { a, b } of trackerDiff.both) {
  const tChg = JSON.stringify([...a.transports].sort()) !== JSON.stringify([...b.transports].sort());
  const eChg = JSON.stringify([...a.events].sort()) !== JSON.stringify([...b.events].sort());
  if (!tChg && !eChg) continue;
  ln(`| ${trackerName(b)} | ${a.transports.join(', ')} ${tChg ? '→ ' + b.transports.join(', ') : '(=)'} | ${a.events.join(', ') || '-'} ${eChg ? '→ ' + (b.events.join(', ') || '-') : '(=)'} |`);
}
ln();

// Consent Mode
ln(`## Consent Mode`);
ln();
ln(`| | Baseline | Current |`);
ln(`|---|---|---|`);
ln(`| gcs-Werte | ${gcsStr(base.consentMode)} | ${gcsStr(curr.consentMode)} |`);
ln(`| G100-Pings (trotz Deny) | ${base.consentMode?.fullyDeniedPings ?? '-'} | ${curr.consentMode?.fullyDeniedPings ?? '-'} |`);
ln();
ln(`> Basic vs. Advanced ist aus gcs allein nicht bestimmbar (zeitliche Frage: Pings vor der Consent-Interaktion?). Nur G100-Pings zaehlen als "trotz Deny gefeuert".`);
ln();

// SST
ln(`## SST / Server-Side & Loader`);
ln();
ln(`| | Baseline | Current |`);
ln(`|---|---|---|`);
ln(`| Container | ${(base.sst?.containers || []).join(', ') || '-'} | ${(curr.sst?.containers || []).join(', ') || '-'} |`);
ln(`| Measurement-IDs | ${(base.sst?.measurementIds || []).join(', ') || '-'} | ${(curr.sst?.measurementIds || []).join(', ') || '-'} |`);
ln(`| Custom Loader | ${(base.sst?.stape || []).map(s => s.host).join(', ') || 'nein'} | ${(curr.sst?.stape || []).map(s => s.host).join(', ') || 'nein'} |`);
ln();

// ── Schreiben ─────────────────────────────────────────────────────────────────

const reportDir = resolve(__dirname, 'reports', project);
if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });
const ts = timestamp();
const outFile = `delta-${ts}.md`;
writeFileSync(resolve(reportDir, outFile), L.join('\n'), 'utf-8');

console.log(`\n  Delta erstellt.`);
console.log(`  Neue Tracker: ${trackerDiff.onlyB.length} | Entfallen: ${trackerDiff.onlyA.length}`);
console.log(`  PII neu: ${piiNew.length} | geaendert: ${piiChanged.length} | entfallen: ${piiGone.length}`);
console.log(`  Report: ${resolve(reportDir, outFile)}\n`);
