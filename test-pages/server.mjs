// Statischer Server fuer die Testseiten (ohne Abhaengigkeiten), Vorbild: stage-in-a-box/beispiel/demo/server.mjs.
//   node test-pages/server.mjs [port]
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const verzeichnis = fileURLToPath(new URL('.', import.meta.url));

export function startServer(port = 0) {
  const server = createServer(async (req, res) => {
    const pfad = new URL(req.url ?? '/', 'http://localhost').pathname;
    const datei = normalize(join(verzeichnis, pfad));
    if (!datei.startsWith(verzeichnis) || !datei.endsWith('.html')) {
      res.writeHead(404).end('nicht gefunden');
      return;
    }
    try {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(await readFile(datei));
    } catch {
      res.writeHead(404).end('nicht gefunden');
    }
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok(server)));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const server = await startServer(Number(process.argv[2] ?? 4174));
  console.log(`Testseiten auf http://127.0.0.1:${server.address().port}/`);
}
