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
  showConsentCard,
  showConfirm,
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
    // Overlay (showSelectorResult, showConfirm, etc.)
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
    // Consent card (audit)
    for (const id of ['__audit-consent-card', '__audit-consent-style']) {
      const el = document.getElementById(id);
      if (el) el.remove();
    }
    // Shadow DOM hint (learn.js)
    for (const id of ['__audit-shadowhint', '__audit-shadowhint-style']) {
      const el = document.getElementById(id);
      if (el) el.remove();
    }
    // Compare card (compare.js)
    for (const id of ['__compare-card', '__compare-card-style']) {
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

let screenshotIndex = 0;
const TOTAL_SCREENSHOTS = 11;

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

// ── 3 + 4: Learn mode screenshots (gandke.de) ───────────────────────────────

async function captureLearnMode() {
  // Screenshot 3: Learn click prompt (Accept)
  await withBrowser(async (page) => {
    logStep('Learn Click-Prompt', 'gandke.de');
    try {
      await navigateTo(page, 'https://www.gandke.de');
    } catch (err) {
      console.warn(`    WARN: Seite konnte nicht geladen werden: ${err.message} -- ueberspringe`);
      screenshotIndex++; // skip #4 as well
      return;
    }

    const clickPromise = showClickPrompt(page, 'Accept');
    clickPromise.catch(() => {});

    await page.waitForTimeout(RENDER_SETTLE_MS);
    await screenshot(page, 'learn-click-prompt.png');
  });

  // Screenshot 4: Learn selector result
  await withBrowser(async (page) => {
    logStep('Learn Selektor-Ergebnis', 'gandke.de');
    try {
      await navigateTo(page, 'https://www.gandke.de');
    } catch (err) {
      console.warn(`    WARN: Seite konnte nicht geladen werden: ${err.message} -- ueberspringe`);
      return;
    }

    const mockCookiebot = {
      selector: '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
      id: 'CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
      tag: 'button',
      text: 'Alle Cookies akzeptieren',
      classes: 'CybotCookiebotDialogBodyButton',
      allDataAttrs: [],
    };
    const resultPromise = showSelectorResult(page, mockCookiebot, 'Accept-Selektor');
    resultPromise.catch(() => {});

    await page.waitForTimeout(RENDER_SETTLE_MS);
    await screenshot(page, 'learn-selector-result.png');
  });
}

// ── 5 + 6: Learn extras -- Shadow DOM Hint + Two-Step Reject (markus-baersch.de) ──

async function captureLearnExtras() {
  // Screenshot 5: Shadow DOM Hint Card (injected inline -- function is local to learn.js)
  await withBrowser(async (page) => {
    logStep('Shadow DOM Hint', 'markus-baersch.de');
    try {
      await navigateTo(page, 'https://www.markus-baersch.de');
    } catch (err) {
      console.warn(`    WARN: ${err.message} -- ueberspringe`);
      screenshotIndex++; // skip #6 as well
      return;
    }

    // Inject the Shadow DOM hint card HTML directly (matches learn.js showShadowDomHint)
    await page.evaluate(() => {
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
          'Klick auf <strong>ACCEPT</strong> konnte nicht erfasst werden.<br>' +
          'Bitte oeffne DevTools (F12), inspiziere den Button und kopiere den Selektor.<br>' +
          'Klicke <strong>Bereit</strong> wenn du den Selektor hast.</div>' +
        '<button id="__audit-shadowhint-btn" style="' +
          'background:#2563eb !important;color:#fff !important;border:none !important;' +
          'border-radius:8px !important;padding:10px 28px !important;font-size:14px !important;' +
          'font-weight:600 !important;cursor:pointer !important;font-family:inherit !important;' +
          'width:100% !important;' +
        '">Bereit</button>';
      document.body.appendChild(card);
    });

    await page.waitForTimeout(RENDER_SETTLE_MS);
    await screenshot(page, 'learn-shadow-dom-hint.png');
  });

  // Screenshot 6: Two-Step Reject confirmation dialog
  await withBrowser(async (page) => {
    logStep('Two-Step Reject Dialog', 'markus-baersch.de');
    try {
      await navigateTo(page, 'https://www.markus-baersch.de');
    } catch (err) {
      console.warn(`    WARN: ${err.message} -- ueberspringe`);
      return;
    }

    // showConfirm waits for button click -- don't await
    const confirmPromise = showConfirm(page, 'Ist der <b>Ablehnen-Button</b> direkt sichtbar?');
    confirmPromise.catch(() => {});

    await page.waitForTimeout(RENDER_SETTLE_MS);
    await screenshot(page, 'learn-two-step-reject.png');
  });
}

// ── 7: Consent Card (gandke.de) ──────────────────────────────────────────────

async function captureConsentCard() {
  await withBrowser(async (page) => {
    logStep('Consent Card', 'gandke.de');
    try {
      await navigateTo(page, 'https://www.gandke.de');
    } catch (err) {
      console.warn(`    WARN: ${err.message} -- ueberspringe`);
      return;
    }

    // showConsentCard waits for click -- don't await, just screenshot
    const consentPromise = showConsentCard(page, 'ACCEPT');
    consentPromise.catch(() => {});

    // Wait for the 2s disabled→ready transition, then screenshot
    await page.waitForTimeout(2500);
    await page.waitForTimeout(RENDER_SETTLE_MS);
    await screenshot(page, 'consent-card.png');
  });
}

// ── 8: Compare Card (gandke.de) ──────────────────────────────────────────────

async function captureCompareCard() {
  await withBrowser(async (page) => {
    logStep('Compare Consent Card', 'gandke.de');
    try {
      await navigateTo(page, 'https://www.gandke.de');
    } catch (err) {
      console.warn(`    WARN: ${err.message} -- ueberspringe`);
      return;
    }

    // Inject compare card HTML directly (compare.js has its own implementation)
    // Show in "ready" state with button enabled
    await page.evaluate(() => {
      const style = document.createElement('style');
      style.id = '__compare-card-style';
      style.textContent = `
        #__compare-card {
          position: fixed !important; bottom: 24px !important; right: 24px !important;
          z-index: 2147483647 !important;
          background: #fff !important; border-radius: 12px !important;
          padding: 20px 24px !important; max-width: 360px !important; width: auto !important;
          box-shadow: 0 8px 32px rgba(0,0,0,0.25), 0 0 0 1px rgba(0,0,0,0.08) !important;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
          font-size: 14px !important; color: #333 !important;
          box-sizing: border-box !important; margin: 0 !important;
          line-height: 1.5 !important; cursor: grab !important; user-select: none !important;
        }
        #__compare-card-title {
          font-size: 15px !important; font-weight: 700 !important; color: #111 !important;
          margin: 0 0 8px 0 !important; display: block !important;
        }
        #__compare-card-msg {
          font-size: 13px !important; color: #555 !important;
          margin: 0 0 14px 0 !important; display: block !important;
        }
        #__compare-card-btn {
          background: #2563eb !important; color: #fff !important; border: none !important;
          border-radius: 8px !important; padding: 10px 20px !important;
          font-size: 14px !important; font-weight: 600 !important; cursor: pointer !important;
          display: block !important; width: 100% !important; text-align: center !important;
        }
        #__compare-card-btn:hover:not(:disabled) { background: #1d4ed8 !important; }
      `;
      document.head.appendChild(style);

      const card = document.createElement('div');
      card.id = '__compare-card';
      card.innerHTML =
        '<div id="__compare-card-title">Seite A: Live</div>' +
        '<div id="__compare-card-msg">Bitte Consent erteilen, dann best\u00e4tigen:</div>' +
        '<button id="__compare-card-btn">Consent gegeben</button>';
      document.body.appendChild(card);
    });

    await page.waitForTimeout(RENDER_SETTLE_MS);
    await screenshot(page, 'compare-consent-card.png');
  });
}

// ── 9 + 10 + 11: E-Commerce screenshots (atomkraftwerke24.de) ───────────────

async function captureEcomPrompts() {
  // Screenshot 9: Ecom step navigate prompt
  await withBrowser(async (page) => {
    logStep('Ecom Schritt Navigate', 'atomkraftwerke24.de');
    try {
      await navigateTo(page, 'https://atomkraftwerke24.de/shop/');
    } catch (err) {
      console.warn(`    WARN: Seite konnte nicht geladen werden: ${err.message} -- ueberspringe`);
      screenshotIndex += 2; // skip #10 and #11 as well
      return;
    }

    // showEcomStepPrompt waits for button click -- don't await
    const stepPromise = showEcomStepPrompt(page, 'Kategorie-Seite', 1, 5);
    stepPromise.catch(() => {});

    await page.waitForTimeout(RENDER_SETTLE_MS);
    await screenshot(page, 'ecom-step-navigate.png');
  });

  // Screenshot 10: Ecom ATC "Bereit" prompt (fresh browser for clean exposeFunction)
  await withBrowser(async (page) => {
    logStep('Ecom Schritt ATC Bereit', 'atomkraftwerke24.de');
    try {
      await navigateTo(page, 'https://atomkraftwerke24.de/produkt/atomkraftwerk-klein/');
    } catch (err) {
      console.warn(`    WARN: Seite konnte nicht geladen werden: ${err.message} -- ueberspringe`);
      screenshotIndex++; // skip #11 as well
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

  // Screenshot 11: Ecom click-wait prompt (fresh browser)
  await withBrowser(async (page) => {
    logStep('Ecom ATC Click-Wait', 'atomkraftwerke24.de');
    try {
      await navigateTo(page, 'https://atomkraftwerke24.de/produkt/atomkraftwerk-klein/');
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

  await captureCMPStatusBar();       // #1 + #2
  await captureLearnMode();          // #3 + #4
  await captureLearnExtras();        // #5 + #6
  await captureConsentCard();        // #7
  await captureCompareCard();        // #8
  await captureEcomPrompts();        // #9 + #10 + #11

  console.log(`\nFertig. ${TOTAL_SCREENSHOTS} Screenshots in ${IMAGES_DIR}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
