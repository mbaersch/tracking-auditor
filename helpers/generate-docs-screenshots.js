/**
 * generate-docs-screenshots.js
 *
 * Oeffnet reale Websites, injiziert browser-ui.js Komponenten und erstellt
 * Screenshots fuer die README-Dokumentation.
 *
 * Ausfuehrung:  node helpers/generate-docs-screenshots.js
 * Voraussetzung: Playwright + Chromium installiert, sichtbarer Desktop (headless: false)
 */

import { chromium } from 'playwright';
import {
  showStatusBar,
  enableCMPSelect,
  showClickPrompt,
  showSelectorResult,
  showTextInput,
  showEcomStepPrompt,
  showEcomClickWait,
} from '../browser-ui.js';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ── Config ───────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const IMAGES_DIR = path.join(PROJECT_ROOT, 'images');

const VIEWPORT = { width: 1280, height: 800 };
const GOTO_OPTIONS = { waitUntil: 'domcontentloaded', timeout: 15000 };
const PAGE_SETTLE_MS = 2000;   // wait for CMP banners / page content
const RENDER_SETTLE_MS = 500;  // wait after UI injection before screenshot

// ── Helpers ──────────────────────────────────────────────────────────────────

async function ensureImagesDir() {
  await mkdir(IMAGES_DIR, { recursive: true });
}

/**
 * Opens a browser, runs the callback, then closes the browser.
 * Callback receives a fresh page with the configured viewport.
 */
async function withBrowser(fn) {
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  try {
    await fn(page);
  } finally {
    await browser.close();
  }
}

async function navigateTo(page, url) {
  await page.goto(url, GOTO_OPTIONS);
  await page.waitForTimeout(PAGE_SETTLE_MS);
}

async function screenshot(page, filename) {
  const filepath = path.join(IMAGES_DIR, filename);
  await page.screenshot({ path: filepath, fullPage: false });
  console.log(`    -> ${filename}`);
}

async function removeAllUI(page) {
  await page.evaluate(() => {
    // Overlay (showSelectorResult, showTextInput, etc.)
    for (const id of ['__audit-overlay', '__audit-overlay-style']) {
      const el = document.getElementById(id);
      if (el) el.remove();
    }
    // Click prompt
    for (const id of ['__audit-clickprompt', '__audit-clickprompt-style']) {
      const el = document.getElementById(id);
      if (el) el.remove();
    }
    // Status bar
    for (const id of ['__audit-statusbar', '__audit-statusbar-style']) {
      const el = document.getElementById(id);
      if (el) el.remove();
    }
    // Ecom prompt
    for (const id of ['__audit-ecomprompt', '__audit-ecomprompt-style']) {
      const el = document.getElementById(id);
      if (el) el.remove();
    }
  });
}

// ── Screenshot Scenarios ─────────────────────────────────────────────────────

const CMP_DROPDOWN_ENTRIES = [
  { key: 'cookiebot', name: 'Cookiebot' },
  { key: 'usercentrics-v2', name: 'Usercentrics v2' },
  { key: 'onetrust', name: 'OneTrust' },
  { key: 'consentmanager', name: 'consentmanager.net' },
];

const MOCK_SELECTOR_RESULT = {
  selector: '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  id: 'CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  tag: 'button',
  text: 'Alle akzeptieren',
  classes: 'CybotCookiebotDialogBodyButton',
  allDataAttrs: [],
};

let screenshotIndex = 0;
const TOTAL_SCREENSHOTS = 8;

function logStep(label, site) {
  screenshotIndex++;
  console.log(`[${screenshotIndex}/${TOTAL_SCREENSHOTS}] ${label} (${site})`);
}

// ── 1 + 2: CMP Status Bar screenshots (gandke.de) ───────────────────────────

async function captureCMPStatusBar() {
  await withBrowser(async (page) => {
    // Screenshot 1: StatusBar with spinner + CMP dropdown
    logStep('CMP-Erkennung', 'gandke.de');
    try {
      await navigateTo(page, 'https://www.gandke.de');
    } catch (err) {
      console.warn(`    WARN: Seite konnte nicht geladen werden: ${err.message} -- ueberspringe`);
      screenshotIndex++; // skip #2 as well
      return;
    }

    await showStatusBar(page, 'CMP-Erkennung...', 'Pruefe bekannte CMP-Selektoren');
    // enableCMPSelect returns a Promise that waits for user input -- don't await it
    const cmpSelectPromise = enableCMPSelect(page, CMP_DROPDOWN_ENTRIES);
    cmpSelectPromise.catch(() => {}); // suppress rejection on browser.close()

    await page.waitForTimeout(RENDER_SETTLE_MS);
    await screenshot(page, 'cmp-detection-statusbar.png');

    // Screenshot 2: StatusBar showing detected CMP
    logStep('CMP erkannt', 'gandke.de');
    await removeAllUI(page);
    await showStatusBar(page, 'CMP erkannt: Cookiebot', 'Selektoren geladen');

    await page.waitForTimeout(RENDER_SETTLE_MS);
    await screenshot(page, 'cmp-detected.png');
  });
}

// ── 3 + 4 + 5: Manual mode screenshots (markus-baersch.de) ──────────────────

async function captureManualMode() {
  // Screenshot 3: Click prompt
  await withBrowser(async (page) => {
    logStep('Click-Prompt', 'markus-baersch.de');
    try {
      await navigateTo(page, 'https://www.markus-baersch.de');
    } catch (err) {
      console.warn(`    WARN: Seite konnte nicht geladen werden: ${err.message} -- ueberspringe`);
      screenshotIndex += 2; // skip #4 and #5 as well
      return;
    }

    // showClickPrompt waits for a real click -- don't await, just screenshot
    const clickPromise = showClickPrompt(page, 'Accept');
    clickPromise.catch(() => {});

    await page.waitForTimeout(RENDER_SETTLE_MS);
    await screenshot(page, 'manual-mode-click.png');
  });

  // Screenshot 4: Selector result dialog (needs fresh browser to avoid exposeFunction conflicts)
  await withBrowser(async (page) => {
    logStep('Selektor-Ergebnis', 'markus-baersch.de');
    try {
      await navigateTo(page, 'https://www.markus-baersch.de');
    } catch (err) {
      console.warn(`    WARN: Seite konnte nicht geladen werden: ${err.message} -- ueberspringe`);
      screenshotIndex++; // skip #5 as well
      return;
    }

    // showSelectorResult waits for button click -- don't await
    const resultPromise = showSelectorResult(page, MOCK_SELECTOR_RESULT, 'Accept');
    resultPromise.catch(() => {});

    await page.waitForTimeout(RENDER_SETTLE_MS);
    await screenshot(page, 'manual-mode-selector.png');

    // Screenshot 5: Text input dialog (same page -- removeOverlay first, fresh exposeFunction names)
    logStep('Selektor-Eingabe', 'markus-baersch.de');
    await removeAllUI(page);

    // showTextInput waits for user input -- don't await
    const inputPromise = showTextInput(page, 'Accept-Selektor eingeben');
    inputPromise.catch(() => {});

    await page.waitForTimeout(RENDER_SETTLE_MS);
    await screenshot(page, 'manual-mode-input.png');
  });
}

// ── 6 + 7 + 8: E-Commerce screenshots (atomkraftwerke24.de) ─────────────────

async function captureEcomPrompts() {
  // Screenshot 6: Ecom step navigate prompt
  await withBrowser(async (page) => {
    logStep('Ecom Schritt Navigate', 'atomkraftwerke24.de');
    try {
      await navigateTo(page, 'https://www.atomkraftwerke24.de');
    } catch (err) {
      console.warn(`    WARN: Seite konnte nicht geladen werden: ${err.message} -- ueberspringe`);
      screenshotIndex += 2; // skip #7 and #8 as well
      return;
    }

    // showEcomStepPrompt waits for button click -- don't await
    const stepPromise = showEcomStepPrompt(page, 'Kategorie-Seite', 1, 5);
    stepPromise.catch(() => {});

    await page.waitForTimeout(RENDER_SETTLE_MS);
    await screenshot(page, 'ecom-step-navigate.png');
  });

  // Screenshot 7: Ecom ATC "Bereit" prompt (fresh browser for clean exposeFunction)
  await withBrowser(async (page) => {
    logStep('Ecom Schritt ATC Bereit', 'atomkraftwerke24.de');
    try {
      await navigateTo(page, 'https://www.atomkraftwerke24.de');
    } catch (err) {
      console.warn(`    WARN: Seite konnte nicht geladen werden: ${err.message} -- ueberspringe`);
      screenshotIndex++; // skip #8 as well
      return;
    }

    // showEcomStepPrompt with custom "Bereit" button
    const atcPromise = showEcomStepPrompt(page, 'Add-to-Cart', 3, 5, {
      nextLabel: 'Bereit',
      instruction: 'Mache ggf. Mengenangaben o.ae. und klicke dann "Bereit". Dein naechster Klick auf der Seite wird als Add-to-Cart erfasst.',
    });
    atcPromise.catch(() => {});

    await page.waitForTimeout(RENDER_SETTLE_MS);
    await screenshot(page, 'ecom-step-atc-ready.png');
  });

  // Screenshot 8: Ecom click-wait prompt (fresh browser)
  await withBrowser(async (page) => {
    logStep('Ecom ATC Click-Wait', 'atomkraftwerke24.de');
    try {
      await navigateTo(page, 'https://www.atomkraftwerke24.de');
    } catch (err) {
      console.warn(`    WARN: Seite konnte nicht geladen werden: ${err.message} -- ueberspringe`);
      return;
    }

    // showEcomClickWait waits for a page click -- don't await
    const clickWaitPromise = showEcomClickWait(page);
    clickWaitPromise.catch(() => {});

    await page.waitForTimeout(RENDER_SETTLE_MS);
    await screenshot(page, 'ecom-step-atc-waiting.png');
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Generating documentation screenshots...\n');
  await ensureImagesDir();

  await captureCMPStatusBar();
  await captureManualMode();
  await captureEcomPrompts();

  console.log(`\nFertig. ${TOTAL_SCREENSHOTS} Screenshots in ${IMAGES_DIR}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
