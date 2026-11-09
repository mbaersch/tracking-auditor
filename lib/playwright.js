// Playwright liegt global (NODE_PATH). ESM-Imports ignorieren NODE_PATH, daher hier per require laden
// und nicht auf `import ... from 'playwright'` zurückstellen. Erst beim launch laden: npm test
// importiert audit.js/compare.js ohne installiertes Playwright (CI-Job "tests").
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const chromium = { launch: (options) => require('playwright').chromium.launch(options) };
