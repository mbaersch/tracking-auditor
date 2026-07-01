#!/usr/bin/env node

/**
 * flow-recorder.js – Zeichnet EINEN Checkout-Flow-Lauf auf (Baseline oder
 * Post-Umstellung). Du klickst den Funnel durch (Produkt -> Warenkorb ->
 * Checkout -> Adresse), ein Overlay markiert die Phasen. Erzeugt pro Lauf:
 *   - <base>.har         natives Playwright-HAR (Roh-Beweis)
 *   - <base>-snapshot.json  delta-freundliche Analyse (Trackers/PII/Consent/SST)
 *   - <base>-report.md   menschenlesbarer Einzelreport
 *
 * Der Snapshot ist die dauerhafte Grundlage fuer flow-delta.js (asynchroner
 * Vorher/Nachher-Vergleich). Analyse + Report kommen aus flow-lib.js, damit
 * Recorder und flow-analyze.js (HAR-Input) exakt dasselbe Schema erzeugen.
 *
 * Hinweis: Der Live-Recorder ist der komfortablere, aber fragilere Weg (Overlay
 * kann hinter CMP-Bannern liegen). Robuster ist meist: HAR im eigenen Browser
 * aufnehmen (DevTools -> "Save all as HAR") und mit flow-analyze.js auswerten.
 *
 * Usage:
 *   node flow-recorder.js --url <url> --project <name> --label <label> [options]
 *
 * Required:
 *   --url       Start-URL (Shop-Startseite)
 *   --project   Projektname (bestimmt reports/<project>/)
 *   --label     Lauf-Label, z.B. "baseline" oder "post-gtm"
 *
 * Optional:
 *   --headless  Headless statt sichtbar (Default: sichtbar -- du musst klicken!)
 */

import { chromium } from 'playwright';
import { writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Analyse + Report zentral aus flow-lib (Single Source of Truth, geteilt mit
// flow-analyze.js) -- kein eigener Klassifikations-Code mehr im Recorder.
import {
  analyze, generateReport, getHostname, hostForFilename, slug, timestamp,
} from './flow-lib.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const has = (flag) => args.includes(flag);

const url = get('--url');
const project = get('--project');
const label = get('--label');
const headless = has('--headless');

if (!url || !project || !label) {
  console.error('Usage: node flow-recorder.js --url <url> --project <name> --label <label>');
  process.exit(1);
}

// Funnel-Phasen (Reihenfolge = Anzeige im Overlay). Der Recorder startet in
// 'start'; jeder Button-Klick stempelt die folgenden Requests mit dieser Phase.
const PHASES = [
  { id: 'consent', label: 'Consent erteilt' },
  { id: 'product', label: 'Produktseite' },
  { id: 'cart', label: 'In den Warenkorb' },
  { id: 'checkout', label: 'Checkout gestartet' },
  { id: 'address', label: 'Adresse eingegeben' },
];

// ── Request Collector (mit Phasen-Stempel) ────────────────────────────────────

function setupRequestCollector(page) {
  const requests = [];
  let currentPhase = 'start';
  const reached = new Set(['start']);

  page.on('request', (req) => {
    requests.push({
      url: req.url(),
      method: req.method(),
      postData: (() => { try { return req.postData() || null; } catch { return null; } })(),
      phase: currentPhase,
      startTime: Date.now(),
    });
  });

  return {
    getAll: () => [...requests],
    setPhase: (phase) => { currentPhase = phase; reached.add(phase); },
    getPhase: () => currentPhase,
    getReached: () => [...reached],
  };
}

// ── Overlay: Phasen-Steuerung ─────────────────────────────────────────────────

// Exposed-Functions EINMAL registrieren (persistieren ueber Navigationen hinweg;
// erneutes exposeFunction wuerde werfen). Liefert das Finish-Promise.
async function exposeFlowControls(page, collector) {
  let resolveFinish;
  const finishPromise = new Promise((r) => { resolveFinish = r; });
  await page.exposeFunction('__flowSetPhase', (phaseId) => {
    collector.setPhase(phaseId);
    console.log(`  Phase -> ${phaseId}`);
  });
  await page.exposeFunction('__flowFinish', () => resolveFinish(Date.now()));
  return finishPromise;
}

// Das Overlay-DOM per addInitScript bei JEDER Navigation automatisch aufbauen
// (muss vor page.goto gesetzt werden, damit es auch beim ersten Load greift).
async function installOverlay(page, meta) {
  await page.addInitScript(({ phases, meta }) => {
    function build() {
      if (!document.body) return;
      if (document.getElementById('__flow-card')) return;
      const style = document.createElement('style');
      style.id = '__flow-style';
      style.textContent = `
        #__flow-card{position:fixed!important;bottom:20px!important;right:20px!important;z-index:2147483647!important;
          background:#fff!important;border-radius:12px!important;padding:16px 18px!important;width:300px!important;
          box-shadow:0 8px 32px rgba(0,0,0,.28),0 0 0 1px rgba(0,0,0,.08)!important;
          font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif!important;color:#222!important;
          box-sizing:border-box!important;line-height:1.4!important;cursor:grab!important;user-select:none!important}
        #__flow-card.--drag{cursor:grabbing!important}
        #__flow-title{font-size:14px!important;font-weight:700!important;margin:0 0 2px!important}
        #__flow-sub{font-size:11px!important;color:#666!important;margin:0 0 10px!important}
        #__flow-cur{font-size:12px!important;margin:0 0 10px!important}
        #__flow-cur b{color:#2563eb!important}
        .__flow-btn{display:block!important;width:100%!important;text-align:left!important;margin:0 0 6px!important;
          padding:8px 10px!important;border:1px solid #d1d5db!important;border-radius:7px!important;background:#f9fafb!important;
          font-size:12px!important;font-weight:600!important;color:#374151!important;cursor:pointer!important}
        .__flow-btn:hover{background:#eff6ff!important;border-color:#93c5fd!important}
        .__flow-btn.--done{background:#dcfce7!important;border-color:#86efac!important;color:#166534!important}
        #__flow-fin{display:block!important;width:100%!important;margin-top:8px!important;padding:10px!important;border:none!important;
          border-radius:8px!important;background:#dc2626!important;color:#fff!important;font-size:13px!important;
          font-weight:700!important;cursor:pointer!important}
        #__flow-fin:hover{background:#b91c1c!important}`;
      document.head.appendChild(style);

      const card = document.createElement('div');
      card.id = '__flow-card';
      card.innerHTML =
        '<div id="__flow-title">Flow-Recorder</div>' +
        '<div id="__flow-sub">' + meta.label + ' &middot; ' + meta.host + '</div>' +
        '<div id="__flow-cur">Phase: <b id="__flow-curval">start</b></div>' +
        '<div id="__flow-btns"></div>' +
        '<button id="__flow-fin">Aufnahme beenden</button>';
      document.body.appendChild(card);

      const btnWrap = card.querySelector('#__flow-btns');
      for (const p of phases) {
        const b = document.createElement('button');
        b.className = '__flow-btn';
        b.textContent = p.label;
        b.dataset.phase = p.id;
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          window.__flowSetPhase(p.id);
          document.getElementById('__flow-curval').textContent = p.id;
          b.classList.add('--done');
        });
        btnWrap.appendChild(b);
      }
      card.querySelector('#__flow-fin').addEventListener('click', (e) => {
        e.stopPropagation();
        e.currentTarget.textContent = 'Beende...';
        e.currentTarget.disabled = true;
        window.__flowFinish();
      });

      // Drag (nur an der Karte, nicht an Buttons)
      let drag = false, sx, sy, ox, oy;
      card.addEventListener('mousedown', (e) => {
        if (e.target.tagName === 'BUTTON') return;
        drag = true; card.classList.add('--drag');
        const r = card.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
        card.style.setProperty('bottom', 'auto', 'important');
        card.style.setProperty('right', 'auto', 'important');
        card.style.setProperty('left', ox + 'px', 'important');
        card.style.setProperty('top', oy + 'px', 'important');
        e.preventDefault();
      });
      document.addEventListener('mousemove', (e) => {
        if (!drag) return;
        card.style.setProperty('left', (ox + e.clientX - sx) + 'px', 'important');
        card.style.setProperty('top', (oy + e.clientY - sy) + 'px', 'important');
      });
      document.addEventListener('mouseup', () => { drag = false; card.classList.remove('--drag'); });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
    else build();
    window.addEventListener('load', build);
  }, { phases: PHASES, meta });
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const host = getHostname(url);
  const reportDir = resolve(__dirname, 'reports', project);
  if (!existsSync(reportDir)) mkdirSync(reportDir, { recursive: true });

  const ts = timestamp();
  const base = `flow-${hostForFilename(url)}-${slug(label)}-${ts}`;
  const harFile = `${base}.har`;
  const snapshotFile = `${base}-snapshot.json`;
  const reportFile = `${base}-report.md`;
  const harPath = resolve(reportDir, harFile);

  console.log(`\n  Flow-Recorder — ${label}`);
  console.log(`  URL: ${url}`);
  console.log(`  Klick den Funnel durch und markiere die Phasen im Overlay.`);
  console.log(`  "Aufnahme beenden" schliesst die Aufzeichnung.\n`);

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    recordHar: { path: harPath, content: 'embed' },
    viewport: null,
  });
  const page = await context.newPage();

  const collector = setupRequestCollector(page);
  const overlayMeta = { label, host };

  try {
    // Reihenfolge wichtig: Controls exposen + Overlay-InitScript setzen VOR goto,
    // damit das Overlay schon beim ersten Load erscheint und ueber Navigationen bleibt.
    const finishPromise = await exposeFlowControls(page, collector);
    await installOverlay(page, overlayMeta);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});

    await finishPromise;
    console.log(`\n  Aufnahme beendet — analysiere...`);
  } finally {
    // Context schliessen flusht das HAR auf die Platte.
    await context.close();
    await browser.close();
  }

  const requests = collector.getAll();
  const analysis = analyze(requests, url);

  const meta = {
    url, label, project, timestamp: ts,
    host, source: 'live', phasesReached: collector.getReached(),
    harFile, snapshotFile, reportFile,
  };

  const snapshot = { meta, ...analysis };
  writeFileSync(resolve(reportDir, snapshotFile), JSON.stringify(snapshot, null, 2), 'utf-8');
  writeFileSync(resolve(reportDir, reportFile), generateReport(analysis, meta), 'utf-8');

  console.log(`\n  Requests:  ${requests.length}`);
  console.log(`  Trackers:  ${analysis.trackers.length}`);
  console.log(`  PII-Vendors: ${analysis.pii.length}`);
  console.log(`\n  Snapshot: ${resolve(reportDir, snapshotFile)}`);
  console.log(`  Report:   ${resolve(reportDir, reportFile)}`);
  console.log(`  HAR:      ${harPath}\n`);
}

main().catch(err => { console.error('\n  FEHLER:', err.stack || err.message); process.exit(1); });
