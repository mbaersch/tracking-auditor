// Echter Audit-Lauf (Chromium, headful) gegen test-pages/csp-test.html: Auto-Erkennung der CMP
// (Fakecentrics), Accept/Reject-Klick und CSP-Blockaden im Report. Braucht Playwright (NODE_PATH).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startServer } from '../../test-pages/server.mjs';

const AUDIT = fileURLToPath(new URL('../../audit.js', import.meta.url));

// Asynchron starten: der Testseiten-Server laeuft in diesem Prozess und muss weiter antworten.
function audit(args) {
  return new Promise((ok, fail) => {
    const p = spawn(process.execPath, [AUDIT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', fail);
    p.on('close', (code) => ok({ code, out }));
  });
}

test('Audit gegen die CSP-Testseite', { timeout: 240_000 }, async () => {
  const server = await startServer();
  try {
    const { port } = server.address();
    const { code, out } = await audit(['--url', `http://127.0.0.1:${port}/csp-test.html`, '--project', 'ci-browser']);
    assert.equal(code, 0, out);
    assert.match(out, /CMP erkannt: Fakecentrics/);
    assert.match(out, /Accept-Button geklickt/);
    assert.match(out, /Reject-Button geklickt/);

    const reportFile = out.match(/Report: (.+\.md)/)?.[1].trim();
    assert.ok(reportFile, out);
    const report = readFileSync(reportFile, 'utf-8');
    assert.match(report, /\*\*CMP:\*\* Fakecentrics/);
    const csp = report.split('## CSP-Blockaden')[1]?.split('\n## ')[0] ?? '';
    const hosts = new Set([...csp.matchAll(/\| https:\/\/([^/]+)\//g)].map(m => m[1]));
    assert.deepEqual([...hosts].sort(), [
      'analytics.tiktok.com', 'connect.facebook.net', 'googleads.g.doubleclick.net',
      'region1.analytics.google.com', 'snap.licdn.com',
    ]);
  } finally {
    server.close();
  }
});
