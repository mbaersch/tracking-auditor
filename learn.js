#!/usr/bin/env node

/**
 * learn.js – Collect accept/reject button selectors for known CMPs
 *
 * Usage:
 *   node learn.js --url https://example.com --cmp "Usercentrics"
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
  showTextInput, showConfirm,
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
const cmpName = get('--cmp');
const twoStepReject = args.indexOf('--two-step-reject') !== -1;
const useTerminal = args.indexOf('--terminal') !== -1;

if (!url || !cmpName) {
  console.error('Usage: node learn.js --url <url> --cmp "<CMP Name>" [--two-step-reject] [--terminal]');
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

async function learnSelectorTerminal(browser, page, label) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

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
    return selector;
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
    return selector;
  }

  return result.selector;
}

async function learnTwoStepRejectTerminal(browser, url) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  console.log(`\n→ TWO-STEP REJECT: Bitte klicke den Settings/More-Button (1. Schritt)...`);
  console.log(`  (Wenn nichts passiert, drücke Enter für manuelle Eingabe)`);

  const result1 = await Promise.race([
    waitForClick(page),
    new Promise(res => {
      const rl = readline.createInterface({ input: process.stdin });
      rl.once('line', () => { rl.close(); res(null); });
    }),
  ]);

  let step1Selector;

  if (!result1 || !isPlausibleResult(result1)) {
    if (result1) console.log(`\n⚠ Click landed on <${result1.tag}> – likely Shadow DOM.`);
    console.log(`  Neuer Browser-Kontext (saubere Cookies) wird erstellt...`);
    const freshContext = await browser.newContext();
    const freshPage = await freshContext.newPage();
    await freshPage.goto(url, { waitUntil: 'domcontentloaded' });
    await freshPage.waitForTimeout(1500);
    step1Selector = await manualSelectorInput(freshPage, 'SETTINGS/MORE (Step 1)');
    await freshContext.close();

    await context.close();
    const ctx2 = await browser.newContext();
    const pg2 = await ctx2.newPage();
    await pg2.goto(url, { waitUntil: 'domcontentloaded' });
    await pg2.waitForTimeout(1500);

    console.log(`  Klicke Step 1 (${step1Selector})...`);
    await pg2.locator(step1Selector).click({ timeout: 10000 });
    await pg2.waitForTimeout(2000);

    console.log(`\n→ TWO-STEP REJECT: Bitte klicke den Reject-Button (2. Schritt)...`);
    console.log(`  (Wenn nichts passiert, drücke Enter für manuelle Eingabe)`);

    const result2 = await Promise.race([
      waitForClick(pg2),
      new Promise(res => {
        const rl = readline.createInterface({ input: process.stdin });
        rl.once('line', () => { rl.close(); res(null); });
      }),
    ]);

    let step2Selector;
    if (!result2 || !isPlausibleResult(result2)) {
      if (result2) console.log(`\n⚠ Click landed on <${result2.tag}> – likely Shadow DOM.`);
      step2Selector = await manualSelectorInput(pg2, 'REJECT (Step 2)');
    } else {
      console.log(`\n✓ Click captured: ${result2.selector} (${result2.text ?? '—'})`);
      const confirmed = await prompt('\n  Use this selector? [Y/n] ');
      if (confirmed.toLowerCase() === 'n') {
        step2Selector = await manualSelectorInput(pg2, 'REJECT (Step 2)');
      } else {
        step2Selector = result2.selector;
      }
    }

    await ctx2.close();
    console.log(`\n✓ Two-Step Reject gelernt:`);
    console.log(`  Step 1 (Settings/More): ${step1Selector}`);
    console.log(`  Step 2 (Reject):        ${step2Selector}`);
    return [step1Selector, step2Selector];
  }

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

  await context.close();
  const ctx2 = await browser.newContext();
  const pg2 = await ctx2.newPage();
  await pg2.goto(url, { waitUntil: 'domcontentloaded' });
  await pg2.waitForTimeout(1500);

  console.log(`\n  Klicke Step 1 (${step1Selector}) um zweiten Layer zu öffnen...`);
  await pg2.locator(step1Selector).click({ timeout: 10000 });
  await pg2.waitForTimeout(2000);

  console.log(`\n→ TWO-STEP REJECT: Bitte klicke den Reject-Button (2. Schritt)...`);
  console.log(`  (Wenn nichts passiert, drücke Enter für manuelle Eingabe)`);

  const result2 = await Promise.race([
    waitForClick(pg2),
    new Promise(res => {
      const rl = readline.createInterface({ input: process.stdin });
      rl.once('line', () => { rl.close(); res(null); });
    }),
  ]);

  let step2Selector;
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

  await ctx2.close();

  console.log(`\n✓ Two-Step Reject gelernt:`);
  console.log(`  Step 1 (Settings/More): ${step1Selector}`);
  console.log(`  Step 2 (Reject):        ${step2Selector}`);
  return [step1Selector, step2Selector];
}

// ── Core flow: Browser-UI mode ────────────────────────────────────────────────

async function learnSelectorBrowserUI(browser, page, label) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const result = await showClickPrompt(page, label);

  if (!result || !isPlausibleResult(result)) {
    if (result) {
      await showMessage(page, `Klick landete auf <${result.tag}> – vermutlich Shadow DOM. Bitte Selektor manuell eingeben.`, { type: 'warning' });
    }
    console.log(`  Neuer Browser-Kontext (saubere Cookies) wird erstellt...`);
    const freshContext = await browser.newContext();
    const freshPage = await freshContext.newPage();
    await freshPage.goto(url, { waitUntil: 'domcontentloaded' });
    await freshPage.waitForTimeout(1500);
    const selector = await showTextInput(freshPage, `${label}-Selektor eingeben`);
    await freshContext.close();
    return selector;
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
    return selector;
  }

  return result.selector;
}

async function learnTwoStepRejectBrowserUI(browser, url) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  // Step 1: Settings/More button
  await showMessage(page, 'Two-Step Reject: Bitte klicke den Settings/More-Button (1. Schritt).', { type: 'info', title: 'Two-Step Reject' });

  const result1 = await showClickPrompt(page, 'SETTINGS/MORE (Step 1)');

  let step1Selector;

  if (!result1 || !isPlausibleResult(result1)) {
    if (result1) {
      await showMessage(page, `Klick landete auf <${result1.tag}> – vermutlich Shadow DOM.`, { type: 'warning' });
    }
    console.log(`  Neuer Browser-Kontext (saubere Cookies) wird erstellt...`);
    const freshContext = await browser.newContext();
    const freshPage = await freshContext.newPage();
    await freshPage.goto(url, { waitUntil: 'domcontentloaded' });
    await freshPage.waitForTimeout(1500);
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

  // Fresh context, execute step 1 to reveal step 2
  await context.close();
  const ctx2 = await browser.newContext();
  const pg2 = await ctx2.newPage();
  await pg2.goto(url, { waitUntil: 'domcontentloaded' });
  await pg2.waitForTimeout(1500);

  console.log(`  Klicke Step 1 (${step1Selector}) um zweiten Layer zu oeffnen...`);
  await pg2.locator(step1Selector).click({ timeout: 10000 });
  await pg2.waitForTimeout(2000);

  // Step 2: Reject button
  await showMessage(pg2, 'Zweiter Layer geoeffnet. Bitte klicke den Reject-Button (2. Schritt).', { type: 'info', title: 'Two-Step Reject' });

  const result2 = await showClickPrompt(pg2, 'REJECT (Step 2)');

  let step2Selector;
  if (!result2 || !isPlausibleResult(result2)) {
    if (result2) {
      await showMessage(pg2, `Klick landete auf <${result2.tag}> – vermutlich Shadow DOM.`, { type: 'warning' });
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

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  console.log(`\n═══════════════════════════════════════`);
  console.log(` CMP Learn Mode`);
  console.log(` CMP  : ${cmpName}`);
  console.log(` URL  : ${url}`);
  if (twoStepReject) console.log(` Mode : Two-Step Reject`);
  console.log(` UI   : ${useTerminal ? 'Terminal' : 'Browser-Overlay'}`);
  console.log(`═══════════════════════════════════════`);

  const learnSelector = useTerminal ? learnSelectorTerminal : learnSelectorBrowserUI;
  const learnTwoStep = useTerminal ? learnTwoStepRejectTerminal : learnTwoStepRejectBrowserUI;

  let acceptSelector, rejectSelector, rejectSteps;

  // Accept: always learned normally
  const { browser: b1, page: p1 } = await launchFresh();
  try {
    acceptSelector = await learnSelector(b1, p1, 'ACCEPT');
  } finally {
    await b1.close();
  }

  if (twoStepReject) {
    console.log('\n─ Restarting browser fresh for two-step reject ─');
    const { browser: b2 } = await launchFresh();
    try {
      rejectSteps = await learnTwoStep(b2, url);
      rejectSelector = rejectSteps[1];
    } finally {
      await b2.close();
    }
  } else {
    console.log('\n─ Restarting browser fresh for reject button ─');
    const { browser: b2, page: p2 } = await launchFresh();
    try {
      rejectSelector = await learnSelector(b2, p2, 'REJECT');
    } finally {
      await b2.close();
    }
  }

  const lib = loadLibrary();
  const key = cmpName.toLowerCase().replace(/\s+/g, '-');

  if (lib[key]) {
    let overwrite;
    if (useTerminal) {
      const answer = await prompt(`\n⚠ "${cmpName}" already exists in library. Overwrite? [y/N] `);
      overwrite = answer.toLowerCase() === 'y';
    } else {
      // Browser is closed at this point – use a temporary page for the confirm dialog
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
    shadowDom: acceptSelector.startsWith('[data-') || !acceptSelector.startsWith('#'),
    learnedAt: new Date().toISOString(),
  };

  saveLibrary(lib);

  console.log(`\n✓ Saved to cmp-library.json:`);
  console.log(`  ${key}.accept = ${acceptSelector}`);
  console.log(`  ${key}.reject = ${rejectSelector}`);
  if (rejectSteps) {
    console.log(`  ${key}.rejectSteps = ${JSON.stringify(rejectSteps)}`);
  }
})();
