// Playwright liegt global (NODE_PATH). ESM-Imports ignorieren NODE_PATH, daher hier per require laden
// und nicht auf `import ... from 'playwright'` zurückstellen.
import { createRequire } from 'node:module';

export const { chromium } = createRequire(import.meta.url)('playwright');
