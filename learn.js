#!/usr/bin/env node

/**
 * learn.js – Collect accept/reject button selectors for known CMPs
 *
 * Usage:
 *   node learn.js --url https://example.com [--cmp "Usercentrics"]
 *
 * Default: Browser-UI overlay for interaction.
 * --terminal: Uses readline (old behavior).
 *
 * Opens a visible browser and waits for you to click accept, then reject.
 * Automatically detects Shadow DOM CMPs and falls back to manual selector
 * input with Playwright verification. Saves both selectors to cmp-library.json.
 */

import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import {
  showMessage, showClickPrompt, showSelectorResult,
  showTextInput, showConfirm, showCMPMatch, showCMPNameInput,
} from './browser-ui.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIBRARY_PATH = resolve(__dirname, 'cmp-library.json');

const STABLE_DATA_ATTRS = [
  'data-testid', 'data-id', 'data-action', 'data-key', 'data-name',
  'data-cy', 'data-qa', 'data-element', 'data-role', 'data-type',
];

const INTERACTIVE_TAGS = ['BUTTON', 'A', 'INPUT', 'SELECT'];

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };

const url = get('--url');
let cmpName = get('--cmp');
const twoStepReject = args.indexOf('--two-step-reject') !== -1;
const useTerminal = args.indexOf('--terminal') !== -1;

if (!url) {
  console.error('Usage: node learn.js --url <url> [--cmp "<CMP Name>"] [--two-step-reject] [--terminal]');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function loadLibrary() {
  if (!existsSync(LIBRARY_PATH)) return {};
  return JSON.parse(readFileSync(LIBRARY_PATH, 'utf-8'));
}

function saveLibrary(lib) {
  writeFileSync(LIBRARY_PATH, JSON.stringify(lib, null, 2), 'utf-8');
}

function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((res) => rl.question(question, (ans) => { rl.close(); res(ans.trim()); }));
}

function isPlausibleResult(result) {
  if (['div', 'span', 'section', 'aside'].includes(result.tag)) return false;
  if (INTERACTIVE_TAGS.includes(result.tag.toUpperCase())) return true;
  if (result.stableDataAttr) return true;
  return false;
}

/**
 * Injects a one-time click listener into the page's main document.
 * Resolves with element info or null if Shadow DOM is suspected.
 */
async function waitForClick(page) {
  return page.evaluate((stableAttrs) => {
    return new Promise((resolve) => {
      document.addEventListener('click', (e) => {
        const t = e.target;
        const INTERACTIVE = ['BUTTON', 'A', 'INPUT', 'SELECT'];
        const el = INTERACTIVE.includes(t.tagName) || t.getAttribute('role') === 'button'
          ? t
          : t.closest('button, a, [role="button"], input[type="button"], input[type="submit"]') || t;

        const id = el.id ? `#${el.id}` : null;
        const stableDataAttr = Array.from(el.attributes)
          .filter(a => stableAttrs.includes(a.name))
          .map(a => `[${a.name}="${a.value}"]`)[0] || null;
        const allDataAttrs = Array.from(el.attributes)
          .filter(a => a.name.startsWith('data-'))
          .map(a => `[${a.name}="${a.value}"]`);
        const classes = el.className && typeof el.className === 'string'
          ? '.' + el.className.trim().split(/\s+/).join('.')
          : null;
        const tag = el.tagName.toLowerCase();

        resolve({
          selector: id || stableDataAttr || classes || tag,
          id: el.id || null,
          stableDataAttr,
          allDataAttrs,
          classes: el.className || null,
          tag,
          text: el.innerText?.trim().slice(0, 80) || null,
        });
      }, { once: true, capture: true });
    });
  }, STABLE_DATA_ATTRS);
}

async function verifySelector(page, selector) {
  try {
    return await page.locator(selector).count();
  } catch {
    return 0;
  }
}

/**
 * Terminal-mode manual selector input (old behavior).
 */
async function manualSelectorInput(page, label) {
  console.log(`\n⚠ Click captured on a non-interactive element (likely Shadow DOM).`);
  console.log(`  Open DevTools, find the ${label} button, and copy its selector.`);

  while (true) {
    const input = await prompt(`  Enter selector for ${label} button: `);
    if (!input) continue;

    const count = await verifySelector(page, input);
    if (count > 0) {
      console.log(`  ✓ Selector verified – found ${count} matching element(s).`);
      return input;
    } else {
      console.log(`  ✗ No elements found for "${input}". Try again.`);
    }
  }
}

// ── Core flow: Terminal mode ──────────────────────────────────────────────────

async function learnSelectorTerminal(browser, page, label, { knownShadowDom = false } = {}) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  // Shadow DOM bereits bekannt → direkt manuelle Eingabe
  if (knownShadowDom) {
    console.log(`\n→ Shadow DOM CMP – bitte ${label}-Selektor manuell eingeben.`);
    console.log(`  Open DevTools, find the ${label} button, and copy its selector.`);
    const selector = await manualSelectorInput(page, label);
    return { selector, shadowDom: true };
  }

  console.log(`\n→ Browser is open. Please click the ${label} button now...`);
  console.log(`  (If nothing happens after clicking, the CMP uses Shadow DOM – just press Enter)`);

  const result = await Promise.race([
    waitForClick(page),
    new Promise(res => {
      const rl = readline.createInterface({ input: process.stdin });
      rl.once('line', () => { rl.close(); res(null); });
    }),
  ]);

  if (!result || !isPlausibleResult(result)) {
    if (result) console.log(`\n⚠ Click landed on <${result.tag}> – likely Shadow DOM.`);
    console.log(`  Neuer Browser-Kontext (saubere Cookies) wird erstellt...`);
    const freshContext = await browser.newContext();
    const freshPage = await freshContext.newPage();
    await freshPage.goto(url, { waitUntil: 'domcontentloaded' });
    await freshPage.waitForTimeout(1500);
    const selector = await manualSelectorInput(freshPage, label);
    await freshContext.close();
    return { selector, shadowDom: true };
  }

  console.log(`\n✓ Click captured:`);
  console.log(`  Selector   : ${result.selector}`);
  console.log(`  ID         : ${result.id ?? '—'}`);
  console.log(`  Data attrs : ${result.allDataAttrs?.join(', ') || '—'}`);
  console.log(`  Classes    : ${result.classes ?? '—'}`);
  console.log(`  Tag        : ${result.tag}`);
  console.log(`  Text       : ${result.text ?? '—'}`);

  const confirmed = await prompt('\n  Use this selector? [Y/n] ');
  if (confirmed.toLowerCase() === 'n') {
    console.log(`  Neuer Browser-Kontext (saubere Cookies) wird erstellt...`);
    const freshContext = await browser.newContext();
    const freshPage = await freshContext.newPage();
    await freshPage.goto(url, { waitUntil: 'domcontentloaded' });
    await freshPage.waitForTimeout(1500);
    const selector = await manualSelectorInput(freshPage, label);
    await freshContext.close();
    return { selector, shadowDom: false };
  }

  return { selector: result.selector, shadowDom: false };
}

async function learnTwoStepRejectTerminal(browser, url, { knownShadowDom = false } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  let step1Selector;

  if (knownShadowDom) {
    // Shadow DOM bekannt → direkt manuelle Eingabe
    console.log(`\n→ Shadow DOM CMP – bitte SETTINGS/MORE-Selektor (Step 1) manuell eingeben.`);
    step1Selector = await manualSelectorInput(page, 'SETTINGS/MORE (Step 1)');
  } else {
    console.log(`\n→ TWO-STEP REJECT: Bitte klicke den Settings/More-Button (1. Schritt)...`);
    console.log(`  (Wenn nichts passiert, drücke Enter für manuelle Eingabe)`);

    const result1 = await Promise.race([
      waitForClick(page),
      new Promise(res => {
        const rl = readline.createInterface({ input: process.stdin });
        rl.once('line', () => { rl.close(); res(null); });
      }),
    ]);

    if (!result1 || !isPlausibleResult(result1)) {
      if (result1) console.log(`\n⚠ Click landed on <${result1.tag}> – likely Shadow DOM.`);
      console.log(`  Neuer Browser-Kontext (saubere Cookies) wird erstellt...`);
      const freshContext = await browser.newContext();
      const freshPage = await freshContext.newPage();
      await freshPage.goto(url, { waitUntil: 'domcontentloaded' });
      await freshPage.waitForTimeout(1500);
      step1Selector = await manualSelectorInput(freshPage, 'SETTINGS/MORE (Step 1)');
      await freshContext.close();
    } else {
      // Step 1 auto-detected
      console.log(`\n✓ Click captured: ${result1.selector} (${result1.text ?? '—'})`);
      const confirmed1 = await prompt('\n  Use this selector for Step 1? [Y/n] ');
      if (confirmed1.toLowerCase() === 'n') {
        console.log(`  Neuer Browser-Kontext (saubere Cookies) wird erstellt...`);
        const freshContext = await browser.newContext();
        const freshPage = await freshContext.newPage();
        await freshPage.goto(url, { waitUntil: 'domcontentloaded' });
        await freshPage.waitForTimeout(1500);
        step1Selector = await manualSelectorInput(freshPage, 'SETTINGS/MORE (Step 1)');
        await freshContext.close();
      } else {
        step1Selector = result1.selector;
      }
    }
  }

  // Fresh context, execute step 1 to reveal step 2
  await context.close();
  const ctx2 = await browser.newContext();
  const pg2 = await ctx2.newPage();
  await pg2.goto(url, { waitUntil: 'domcontentloaded' });
  await pg2.waitForTimeout(1500);

  console.log(`\n  Klicke Step 1 (${step1Selector}) um zweiten Layer zu oeffnen...`);
  await pg2.locator(step1Selector).first().click({ timeout: 10000 });
  await pg2.waitForTimeout(2000);

  let step2Selector;

  if (knownShadowDom) {
    // Shadow DOM bekannt → direkt manuelle Eingabe
    console.log(`\n→ Shadow DOM CMP – bitte REJECT-Selektor (Step 2) manuell eingeben.`);
    step2Selector = await manualSelectorInput(pg2, 'REJECT (Step 2)');
  } else {
    console.log(`\n→ TWO-STEP REJECT: Bitte klicke den Reject-Button (2. Schritt)...`);
    console.log(`  (Wenn nichts passiert, drücke Enter für manuelle Eingabe)`);

    const result2 = await Promise.race([
      waitForClick(pg2),
      new Promise(res => {
        const rl = readline.createInterface({ input: process.stdin });
        rl.once('line', () => { rl.close(); res(null); });
      }),
    ]);

    if (!result2 || !isPlausibleResult(result2)) {
      if (result2) console.log(`\n⚠ Click landed on <${result2.tag}> – likely Shadow DOM.`);
      step2Selector = await manualSelectorInput(pg2, 'REJECT (Step 2)');
    } else {
      console.log(`\n✓ Click captured: ${result2.selector} (${result2.text ?? '—'})`);
      const confirmed2 = await prompt('\n  Use this selector for Step 2? [Y/n] ');
      if (confirmed2.toLowerCase() === 'n') {
        step2Selector = await manualSelectorInput(pg2, 'REJECT (Step 2)');
      } else {
        step2Selector = result2.selector;
      }
    }
  }

  await ctx2.close();

  console.log(`\n✓ Two-Step Reject gelernt:`);
  console.log(`  Step 1 (Settings/More): ${step1Selector}`);
  console.log(`  Step 2 (Reject):        ${step2Selector}`);
  return [step1Selector, step2Selector];
}

/**
 * Floating hint card (no overlay) for Shadow DOM CMPs.
 * Page stays fully interactive so the user can open DevTools and find the selector.
 * Resolves when user clicks "Bereit".
 */
async function showShadowDomHint(page, label) {
  const cbName = '__audit_shadowhint_' + Date.now();

  let resolvePromise;
  const ready = new Promise((resolve) => { resolvePromise = resolve; });

  try { await page.exposeFunction(cbName, () => resolvePromise()); } catch { /* */ }

  await page.evaluate(({ cbName, label }) => {
    const old = document.getElementById('__audit-shadowhint');
    if (old) old.remove();

    const card = document.createElement('div');
    card.id = '__audit-shadowhint';
    card.style.cssText = [
      'position:fixed !important', 'bottom:24px !important', 'left:50% !important',
      'transform:translateX(-50%) !important', 'z-index:2147483647 !important',
      'background:#fff !important', 'border-radius:12px !important',
      'padding:20px 28px !important', 'max-width:500px !important', 'width:90% !important',
      'box-shadow:0 8px 32px rgba(0,0,0,0.25),0 0 0 1px rgba(0,0,0,0.08) !important',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif !important',
      'font-size:14px !important', 'color:#333 !important',
      'text-align:center !important', 'box-sizing:border-box !important',
      'cursor:grab !important', 'user-select:none !important',
    ].join(';');
    card.innerHTML =
      '<div style="font-size:15px !important;font-weight:700 !important;color:#b45309 !important;margin:0 0 8px 0 !important;">' +
        '\u26A0\uFE0F Shadow DOM erkannt</div>' +
      '<div style="font-size:14px !important;color:#444 !important;margin:0 0 14px 0 !important;">' +
        'Klick auf <strong>' + label + '</strong> konnte nicht erfasst werden.<br>' +
        'Bitte oeffne DevTools (F12), inspiziere den Button und kopiere den Selektor.<br>' +
        'Klicke <strong>Bereit</strong> wenn du den Selektor hast.</div>' +
      '<button id="__audit-shadowhint-btn" style="' +
        'background:#2563eb !important;color:#fff !important;border:none !important;' +
        'border-radius:8px !important;padding:10px 28px !important;font-size:14px !important;' +
        'font-weight:600 !important;cursor:pointer !important;font-family:inherit !important;' +
      '">Bereit</button>';
    document.body.appendChild(card);

    // Bereit-Button
    document.getElementById('__audit-shadowhint-btn').addEventListener('click', () => {
      window[cbName]();
    });

    // Drag handling (mousedown auf Button wird ignoriert → Button-Klick funktioniert immer)
    let dragging = false, startX, startY, origX, origY;
    card.addEventListener('mousedown', (e) => {
      if (e.target.id === '__audit-shadowhint-btn') return;
      dragging = true;
      card.style.setProperty('cursor', 'grabbing', 'important');
      const rect = card.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      origX = rect.left; origY = rect.top;
      card.style.setProperty('bottom', 'auto', 'important');
      card.style.setProperty('left', origX + 'px', 'important');
      card.style.setProperty('top', origY + 'px', 'important');
      card.style.setProperty('transform', 'none', 'important');
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      card.style.setProperty('left', (origX + dx) + 'px', 'important');
      card.style.setProperty('top', (origY + dy) + 'px', 'important');
    });
    document.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      card.style.setProperty('cursor', 'grab', 'important');
    });
  }, { cbName, label });

  await ready;

  await page.evaluate(() => {
    const el = document.getElementById('__audit-shadowhint');
    if (el) el.remove();
  });
}

// ── Core flow: Browser-UI mode ────────────────────────────────────────────────

async function learnSelectorBrowserUI(browser, page, label, { knownShadowDom = false } = {}) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  // Shadow DOM bereits bekannt → Klick-Prompt ueberspringen
  if (knownShadowDom) {
    await showShadowDomHint(page, label);
    const selector = await showTextInput(page, `${label}-Selektor eingeben`);
    return { selector, shadowDom: true };
  }

  const result = await showClickPrompt(page, label);

  if (!result || !isPlausibleResult(result)) {
    console.log(`  Shadow DOM erkannt – neuer Browser-Kontext wird erstellt...`);
    const freshContext = await browser.newContext();
    const freshPage = await freshContext.newPage();
    await freshPage.goto(url, { waitUntil: 'domcontentloaded' });
    await freshPage.waitForTimeout(1500);
    if (result) {
      await showShadowDomHint(freshPage, label);
    }
    const selector = await showTextInput(freshPage, `${label}-Selektor eingeben`);
    await freshContext.close();
    return { selector, shadowDom: true };
  }

  const { confirmed } = await showSelectorResult(page, result, label);
  if (!confirmed) {
    console.log(`  Neuer Browser-Kontext (saubere Cookies) wird erstellt...`);
    const freshContext = await browser.newContext();
    const freshPage = await freshContext.newPage();
    await freshPage.goto(url, { waitUntil: 'domcontentloaded' });
    await freshPage.waitForTimeout(1500);
    const selector = await showTextInput(freshPage, `${label}-Selektor eingeben`);
    await freshContext.close();
    return { selector, shadowDom: false };
  }

  return { selector: result.selector, shadowDom: false };
}

async function learnTwoStepRejectBrowserUI(browser, url, { knownShadowDom = false } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  let step1Selector;

  if (knownShadowDom) {
    // Shadow DOM bekannt → Klick-Prompt ueberspringen
    await showShadowDomHint(page, 'SETTINGS/MORE (Step 1)');
    step1Selector = await showTextInput(page, 'Settings/More-Selektor eingeben (Step 1)');
  } else {
    // Step 1: Settings/More button
    await showMessage(page, 'Two-Step Reject: Bitte klicke den Settings/More-Button (1. Schritt).', { type: 'info', title: 'Two-Step Reject' });

    const result1 = await showClickPrompt(page, 'SETTINGS/MORE (Step 1)');

    if (!result1 || !isPlausibleResult(result1)) {
      console.log(`  Shadow DOM erkannt – neuer Browser-Kontext wird erstellt...`);
      const freshContext = await browser.newContext();
      const freshPage = await freshContext.newPage();
      await freshPage.goto(url, { waitUntil: 'domcontentloaded' });
      await freshPage.waitForTimeout(1500);
      if (result1) {
        await showShadowDomHint(freshPage, 'SETTINGS/MORE (Step 1)');
      }
      step1Selector = await showTextInput(freshPage, 'Settings/More-Selektor eingeben (Step 1)');
      await freshContext.close();
    } else {
      const { confirmed } = await showSelectorResult(page, result1, 'SETTINGS/MORE (Step 1)');
      if (!confirmed) {
        console.log(`  Neuer Browser-Kontext (saubere Cookies) wird erstellt...`);
        const freshContext = await browser.newContext();
        const freshPage = await freshContext.newPage();
        await freshPage.goto(url, { waitUntil: 'domcontentloaded' });
        await freshPage.waitForTimeout(1500);
        step1Selector = await showTextInput(freshPage, 'Settings/More-Selektor eingeben (Step 1)');
        await freshContext.close();
      } else {
        step1Selector = result1.selector;
      }
    }
  }

  // Fresh context, execute step 1 to reveal step 2
  await context.close();
  const ctx2 = await browser.newContext();
  const pg2 = await ctx2.newPage();
  await pg2.goto(url, { waitUntil: 'domcontentloaded' });
  await pg2.waitForTimeout(1500);

  console.log(`  Klicke Step 1 (${step1Selector}) um zweiten Layer zu oeffnen...`);
  await pg2.locator(step1Selector).first().click({ timeout: 10000 });
  await pg2.waitForTimeout(2000);

  let step2Selector;

  if (knownShadowDom) {
    // Shadow DOM bekannt → direkt Hint + Input
    await showShadowDomHint(pg2, 'REJECT (Step 2)');
    step2Selector = await showTextInput(pg2, 'Reject-Selektor eingeben (Step 2)');
  } else {
    // Step 2: Reject button
    await showMessage(pg2, 'Zweiter Layer geoeffnet. Bitte klicke den Reject-Button (2. Schritt).', { type: 'info', title: 'Two-Step Reject' });

    const result2 = await showClickPrompt(pg2, 'REJECT (Step 2)');

    if (!result2 || !isPlausibleResult(result2)) {
      // Seite neu laden + Step 1 erneut klicken damit zweiter Layer wieder sichtbar ist
      await pg2.goto(url, { waitUntil: 'domcontentloaded' });
      await pg2.waitForTimeout(1500);
      await pg2.locator(step1Selector).first().click({ timeout: 10000 });
      await pg2.waitForTimeout(2000);
      if (result2) {
        await showShadowDomHint(pg2, 'REJECT (Step 2)');
      }
      step2Selector = await showTextInput(pg2, 'Reject-Selektor eingeben (Step 2)');
    } else {
      const { confirmed } = await showSelectorResult(pg2, result2, 'REJECT (Step 2)');
      if (!confirmed) {
        step2Selector = await showTextInput(pg2, 'Reject-Selektor eingeben (Step 2)');
      } else {
        step2Selector = result2.selector;
      }
    }
  }

  await ctx2.close();

  console.log(`\n✓ Two-Step Reject gelernt:`);
  console.log(`  Step 1 (Settings/More): ${step1Selector}`);
  console.log(`  Step 2 (Reject):        ${step2Selector}`);
  return [step1Selector, step2Selector];
}

// ── Shared ────────────────────────────────────────────────────────────────────

async function launchFresh() {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  return { browser, page };
}

function selectorsOverlap(a, b) {
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function findLibraryMatches(lib, acceptSelector, rejectSelector) {
  const matches = [];
  for (const [key, entry] of Object.entries(lib)) {
    if (selectorsOverlap(entry.accept, acceptSelector) || selectorsOverlap(entry.reject, rejectSelector)) {
      matches.push({ key, ...entry });
    }
  }
  return matches;
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`\n═══════════════════════════════════════`);
  console.log(` CMP Learn Mode`);
  if (cmpName) console.log(` CMP  : ${cmpName}`);
  console.log(` URL  : ${url}`);
  if (twoStepReject) console.log(` Mode : Two-Step Reject`);
  console.log(` UI   : ${useTerminal ? 'Terminal' : 'Browser-Overlay'}`);
  console.log(`═══════════════════════════════════════`);

  const learnSelector = useTerminal ? learnSelectorTerminal : learnSelectorBrowserUI;
  const learnTwoStep = useTerminal ? learnTwoStepRejectTerminal : learnTwoStepRejectBrowserUI;

  let acceptSelector, rejectSelector, rejectSteps;
  let shadowDomDetected = false;

  // ── Phase 1: Accept lernen ──
  const { browser: b1, page: p1 } = await launchFresh();
  try {
    const result = await learnSelector(b1, p1, 'ACCEPT');
    acceptSelector = result.selector;
    shadowDomDetected = result.shadowDom;
    if (shadowDomDetected) console.log('  → Shadow DOM erkannt, wird fuer Reject uebernommen.');
  } finally {
    await b1.close();
  }

  // ── Phase 2: Reject lernen ──
  if (shadowDomDetected) {
    // Shadow DOM: interaktiv fragen ob One-Step oder Two-Step
    console.log('\n─ Shadow DOM: Reject lernen ─');
    const { browser: b2, page: p2 } = await launchFresh();
    try {
      await p2.goto(url, { waitUntil: 'domcontentloaded' });
      await p2.waitForTimeout(1500);

      let needsTwoStep = twoStepReject; // CLI-Flag als Default
      if (!twoStepReject) {
        if (useTerminal) {
          const answer = await prompt('\n  Ist der Ablehnen-Button direkt sichtbar? [Y/n] ');
          needsTwoStep = answer.toLowerCase() === 'n';
        } else {
          needsTwoStep = !(await showConfirm(p2, 'Ist der Ablehnen-Button direkt sichtbar?'));
        }
      }

      if (needsTwoStep) {
        // Two-Step: Step 1 (Settings/More)
        let step1;
        if (useTerminal) {
          console.log('\n→ Bitte SETTINGS/MORE-Selektor (Step 1) eingeben.');
          step1 = await manualSelectorInput(p2, 'SETTINGS/MORE (Step 1)');
        } else {
          await showShadowDomHint(p2, 'SETTINGS/MORE (Step 1)');
          step1 = await showTextInput(p2, 'Settings/More-Selektor eingeben (Step 1)');
        }

        // Frischer Kontext → Step 1 klicken → zweiten Layer oeffnen
        const ctx2 = await b2.newContext();
        const pg2 = await ctx2.newPage();
        await pg2.goto(url, { waitUntil: 'domcontentloaded' });
        await pg2.waitForTimeout(1500);
        console.log(`  Klicke Step 1 (${step1}) um zweiten Layer zu oeffnen...`);
        await pg2.locator(step1).first().click({ timeout: 10000 });
        await pg2.waitForTimeout(2000);

        // Step 2 (Reject)
        let step2;
        if (useTerminal) {
          console.log('\n→ Bitte REJECT-Selektor (Step 2) eingeben.');
          step2 = await manualSelectorInput(pg2, 'REJECT (Step 2)');
        } else {
          await showShadowDomHint(pg2, 'REJECT (Step 2)');
          step2 = await showTextInput(pg2, 'Reject-Selektor eingeben (Step 2)');
        }

        await ctx2.close();
        rejectSteps = [step1, step2];
        rejectSelector = step2;
        console.log(`\n✓ Two-Step Reject gelernt:`);
        console.log(`  Step 1 (Settings/More): ${step1}`);
        console.log(`  Step 2 (Reject):        ${step2}`);
      } else {
        // One-Step: direkt Reject-Selektor
        if (useTerminal) {
          console.log('\n→ Bitte REJECT-Selektor eingeben.');
          rejectSelector = await manualSelectorInput(p2, 'REJECT');
        } else {
          await showShadowDomHint(p2, 'REJECT');
          rejectSelector = await showTextInput(p2, 'REJECT-Selektor eingeben');
        }
      }
    } finally {
      await b2.close();
    }
  } else if (twoStepReject) {
    // CLI-Flag Two-Step ohne Shadow DOM
    console.log('\n─ Restarting browser fresh for two-step reject ─');
    const { browser: b2 } = await launchFresh();
    try {
      rejectSteps = await learnTwoStep(b2, url);
      rejectSelector = rejectSteps[1];
    } finally {
      await b2.close();
    }
  } else {
    // Normal: Klick-Erfassung
    console.log('\n─ Restarting browser fresh for reject button ─');
    const { browser: b2, page: p2 } = await launchFresh();
    try {
      const result = await learnSelector(b2, p2, 'REJECT');
      rejectSelector = result.selector;
    } finally {
      await b2.close();
    }
  }

  // ── Phase 3: Library-Matching ──
  const lib = loadLibrary();
  const matches = findLibraryMatches(lib, acceptSelector, rejectSelector);

  if (matches.length > 0) {
    console.log(`\n🔍 ${matches.length} Library-Match(es) gefunden:`);
    for (const m of matches) {
      console.log(`  - ${m.name} (${m.key}): accept=${m.accept}, reject=${m.reject}`);
    }

    for (const match of matches) {
      let useExisting;
      if (useTerminal) {
        console.log(`\n  Match: ${match.name} (${match.key})`);
        console.log(`    Accept: ${match.accept}`);
        console.log(`    Reject: ${match.reject}`);
        const answer = await prompt('  Diesen Eintrag verwenden? [y/N] ');
        useExisting = answer.toLowerCase() === 'y';
      } else {
        const { browser: bMatch, page: pMatch } = await launchFresh();
        try {
          await pMatch.goto(url, { waitUntil: 'domcontentloaded' });
          await pMatch.waitForTimeout(1000);
          ({ useExisting } = await showCMPMatch(pMatch, match));
        } finally {
          await bMatch.close();
        }
      }

      if (useExisting) {
        console.log(`\n✓ Verwende bestehenden Eintrag "${match.name}" (${match.key}).`);
        console.log('  Keine Aenderungen an der Library.');
        process.exit(0);
      }
    }
    console.log('\n→ Kein Match gewaehlt, neues CMP wird angelegt...');
  }

  // ── Phase 4: Detect-Selektoren lernen ──
  let detectSelectors = [];
  console.log('\n─ Detect-Selektoren ermitteln ─');

  const { browser: bDetect, page: pDetect } = await launchFresh();
  try {
    await pDetect.goto(url, { waitUntil: 'domcontentloaded' });
    await pDetect.waitForTimeout(1500);

    // Playwright locator kann Shadow DOM – von dort Parent-IDs sammeln
    const candidates = await pDetect.locator(acceptSelector).first().evaluate((el) => {
      let current = el?.parentElement;
      const found = [];
      while (current) {
        if (current.id) found.push('#' + current.id);
        // Shadow Root Grenze: Host-Element ID holen und stoppen
        if (current.parentNode instanceof ShadowRoot) {
          const host = current.parentNode.host;
          if (host?.id) found.push('#' + host.id);
          break;
        }
        if (current === document.body) break;
        current = current.parentElement;
      }
      return found;
    }).catch(() => []);

    if (useTerminal) {
      if (candidates.length > 0) {
        console.log(`  Vorschlag: ${candidates[0]}`);
        if (candidates.length > 1) console.log(`  Weitere Kandidaten: ${candidates.slice(1).join(', ')}`);
      } else {
        console.log('  Kein automatischer Vorschlag gefunden.');
      }
      const input = await prompt(`  Detect-Selektor(en) (komma-getrennt, leer=skip)${candidates.length > 0 ? ` [${candidates[0]}]` : ''}: `);
      if (input) {
        detectSelectors = input.split(',').map(s => s.trim()).filter(Boolean);
      } else if (candidates.length > 0) {
        detectSelectors = [candidates[0]];
      }
    } else {
      if (candidates.length > 0) {
        const suggestion = candidates[0];
        const info = candidates.length > 1
          ? `Detect-Vorschlag: ${suggestion}\nWeitere: ${candidates.slice(1).join(', ')}\n\nVerwenden?`
          : `Detect-Selektor "${suggestion}" gefunden. Verwenden?`;
        const useSuggestion = await showConfirm(pDetect, info);
        if (useSuggestion) {
          detectSelectors = [suggestion];
        } else {
          const enterCustom = await showConfirm(pDetect, 'Eigenen Detect-Selektor eingeben?');
          if (enterCustom) {
            const sel = await showTextInput(pDetect, 'Detect-Selektor eingeben', suggestion);
            detectSelectors = sel.split(',').map(s => s.trim()).filter(Boolean);
          }
        }
      } else {
        const enterManual = await showConfirm(pDetect, 'Kein Detect-Vorschlag gefunden. Manuell eingeben?');
        if (enterManual) {
          const sel = await showTextInput(pDetect, 'Detect-Selektor eingeben');
          detectSelectors = sel.split(',').map(s => s.trim()).filter(Boolean);
        }
      }
    }
  } finally {
    await bDetect.close();
  }

  if (detectSelectors.length > 0) {
    console.log(`  ✓ Detect-Selektoren: ${detectSelectors.join(', ')}`);
  } else {
    console.log('  → Kein Detect-Selektor gesetzt (CMP braucht --cmp).');
  }

  // ── Phase 5: CMP-Name und Priority abfragen ──
  let priority = 3;
  if (!cmpName) {
    if (useTerminal) {
      cmpName = await prompt('\nCMP-Name eingeben: ');
      const prioInput = await prompt('Priority (1=sehr haeufig, 3=normal, 9=sehr selten) [3]: ');
      priority = parseInt(prioInput, 10) || 3;
    } else {
      const { browser: bName, page: pName } = await launchFresh();
      try {
        await pName.goto(url, { waitUntil: 'domcontentloaded' });
        await pName.waitForTimeout(1000);
        const result = await showCMPNameInput(pName);
        cmpName = result.name;
        priority = result.priority;
      } finally {
        await bName.close();
      }
    }
  }

  if (!cmpName) {
    console.error('Kein CMP-Name angegeben. Abbruch.');
    process.exit(1);
  }
  priority = Math.max(1, Math.min(9, priority));

  // ── Phase 6: Speichern ──
  const key = cmpName.toLowerCase().replace(/\s+/g, '-');

  if (lib[key]) {
    let overwrite;
    if (useTerminal) {
      const answer = await prompt(`\n⚠ "${cmpName}" existiert bereits in der Library. Ueberschreiben? [y/N] `);
      overwrite = answer.toLowerCase() === 'y';
    } else {
      const { browser: bConfirm, page: pConfirm } = await launchFresh();
      try {
        await pConfirm.goto(url, { waitUntil: 'domcontentloaded' });
        await pConfirm.waitForTimeout(1000);
        overwrite = await showConfirm(pConfirm, `"${cmpName}" existiert bereits in der Library. Ueberschreiben?`);
      } finally {
        await bConfirm.close();
      }
    }

    if (!overwrite) {
      console.log('Aborted. Library unchanged.');
      process.exit(0);
    }
  }

  lib[key] = {
    name: cmpName,
    accept: acceptSelector,
    reject: rejectSelector,
    ...(rejectSteps ? { rejectSteps } : {}),
    ...(detectSelectors.length > 0 ? { detect: detectSelectors } : {}),
    shadowDom: acceptSelector.startsWith('[data-') || !acceptSelector.startsWith('#'),
    priority,
    learnedAt: new Date().toISOString(),
  };

  saveLibrary(lib);

  console.log(`\n✓ Saved to cmp-library.json:`);
  console.log(`  ${key}.accept = ${acceptSelector}`);
  console.log(`  ${key}.reject = ${rejectSelector}`);
  if (rejectSteps) {
    console.log(`  ${key}.rejectSteps = ${JSON.stringify(rejectSteps)}`);
  }
  if (detectSelectors.length > 0) {
    console.log(`  ${key}.detect = ${JSON.stringify(detectSelectors)}`);
  }
})();
