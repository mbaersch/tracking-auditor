#!/usr/bin/env node

/**
 * flow-analyze.js – Analysiert ein selbst aufgenommenes HAR (Chrome/Edge DevTools
 * -> Network -> "Save all as HAR") und erzeugt denselben Snapshot + Report wie
 * flow-recorder.js. Damit ist die Aufzeichnung von der Analyse entkoppelt:
 * du nimmst den Checkout-Flow im eigenen Browser auf, dieses Tool wertet aus.
 *
 * Der erzeugte <base>-snapshot.json ist die Grundlage fuer flow-delta.js
 * (asynchroner Vorher/Nachher-Vergleich).
 *
 * Usage:
 *   node flow-analyze.js --har <datei.har> --project <name> --label <label> [--url <shop-url>]
 *
 * Required:
 *   --har       Pfad zur HAR-Datei
 *   --project   Projektname (bestimmt reports/<project>/)
 *   --label     Lauf-Label, z.B. "baseline" oder "post-gtm"
 *
 * Optional:
 *   --url       Shop-Start-URL (bestimmt First-Party-Domain; sonst aus HAR ermittelt)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

import {
  analyze, generateReport, harToRequests, inferSiteUrl,
  getHostname, hostForFilename, slug, timestamp,
} from './flow-lib.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };

const harArg = get('--har');
const project = get('--project');
const label = get('--label');
const urlOverride = get('--url');

if (!harArg || !project || !label) {
  console.error('Usage: node flow-analyze.js --har <datei.har> --project <name> --label <label> [--url <shop-url>]');
  process.exit(1);
}

const harPathIn = resolve(process.cwd(), harArg);
if (!existsSync(harPathIn)) {
  console.error(`  FEHLER: HAR-Datei nicht gefunden: ${harPathIn}`);
  process.exit(1);
}

let har;
try {
  har = JSON.parse(readFileSync(harPathIn, 'utf-8'));
} catch (e) {
  console.error(`  FEHLER: HAR nicht lesbar/kein JSON: ${e.message}`);
  process.exit(1);
}

const requests = harToRequests(har);
if (requests.length === 0) {
  console.error('  FEHLER: HAR enthaelt keine Requests (log.entries leer).');
  process.exit(1);
}

const siteUrl = inferSiteUrl(har, urlOverride);
if (!siteUrl) {
  console.error('  FEHLER: Shop-URL konnte nicht ermittelt werden -- bitte --url angeben.');
  process.exit(1);
}

const analysis = analyze(requests, siteUrl);

// Report-Verzeichnis + Dateinamen
const reportDir = resolve(__dirname, 'reports', project);
if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });

const ts = timestamp();
const base = `flow-${hostForFilename(siteUrl)}-${slug(label)}-${ts}`;
const snapshotFile = `${base}-snapshot.json`;
const reportFile = `${base}-report.md`;
const harFile = `${base}.har`;

// HAR neben Snapshot/Report ablegen (Beweisartefakt, einheitlich benannt)
try { copyFileSync(harPathIn, resolve(reportDir, harFile)); } catch { /* nicht kritisch */ }

const meta = {
  url: siteUrl, label, project, timestamp: ts,
  host: getHostname(siteUrl), source: `HAR (${basename(harPathIn)})`,
  phasesReached: Object.keys(analysis.requestCounts.perPhase),
  harFile, snapshotFile, reportFile,
};

const snapshot = { meta, ...analysis };
writeFileSync(resolve(reportDir, snapshotFile), JSON.stringify(snapshot, null, 2), 'utf-8');
writeFileSync(resolve(reportDir, reportFile), generateReport(analysis, meta), 'utf-8');

console.log(`\n  HAR analysiert: ${basename(harPathIn)}`);
console.log(`  Shop-Host:   ${meta.host}`);
console.log(`  Requests:    ${requests.length}`);
console.log(`  Trackers:    ${analysis.trackers.length}`);
console.log(`  PII-Vendors: ${analysis.pii.length}  (${analysis.pii.map(p => p.vendor).join(', ') || 'keine'})`);
console.log(`\n  Snapshot: ${resolve(reportDir, snapshotFile)}`);
console.log(`  Report:   ${resolve(reportDir, reportFile)}`);
console.log(`  HAR:      ${resolve(reportDir, harFile)}\n`);
