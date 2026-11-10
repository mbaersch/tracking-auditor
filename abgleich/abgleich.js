// Abgleich der Dienst-Erkennung: schickt die Referenz-Requests durch jedes Werkzeug und
// vergleicht mit dem erwarteten Ergebnis. Erklaerung und Pflege: abgleich/README.md.
//
//   node abgleich/abgleich.js [--extension <repo>] [--validator <repo>] [--stage <repo>]
//
// Ohne Pfad fehlt die Spalte. Exit-Code 1 bei Abweichung vom Erwarteten oder wenn die
// pii-lib nicht mehr der lib der Extension entspricht.
import { readFileSync, readdirSync, existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import vm from 'vm';
import { matchRequest, extractFirstPartyCollectMatches, extractStapeMatches } from '../lib/tracking-classify.js';
import { parseRequestsAsync } from '../pii-lib/index.js';
import { parseStapeDataClient } from '../pii-lib/stapedata.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? resolve(args[i + 1]) : null; };
const paths = { extension: arg('--extension'), validator: arg('--validator'), stage: arg('--stage') };

const ref = JSON.parse(readFileSync(join(ROOT, 'abgleich', 'referenz-requests.json'), 'utf-8'));
const erwartet = JSON.parse(readFileSync(join(ROOT, 'abgleich', 'erwartet.json'), 'utf-8'));
const SEITE = ref.seite;

// Namen je Werkzeug auf gemeinsame Kennungen abbilden
const VENDOR = { 'google-ads': 'googleads', 'meta-pixel': 'meta', 'tiktok-pixel': 'tiktok', 'pinterest-tag': 'pinterest',
  'linkedin-insight': 'linkedin', 'microsoft-ads': 'uet', 'reddit-pixel': 'reddit', 'openai-pixel': 'openai', 'snapchat-pixel': 'snapchat' };
const ECV = { ga: 'ga4', ads: 'googleads', bing: 'uet', stape: 'stape-data' };
const STAGE = { 'GA4': 'ga4', 'GA4 Begleit': 'ga4*', 'GA4 Measurement Protocol': 'ga4-mp', 'Google Ads': 'googleads', 'Floodlight': 'floodlight',
  'Meta': 'meta', 'Microsoft Ads': 'uet', 'Microsoft Ads Insights': 'uet*', 'Microsoft Clarity': 'clarity', 'OpenAI Ads': 'openai',
  'TikTok': 'tiktok', 'TikTok Begleit': 'tiktok*', 'Pinterest': 'pinterest', 'LinkedIn': 'linkedin', 'Reddit': 'reddit', 'Snap': 'snapchat' };

const fehler = [];

// ── Auditor: tracking-vendors.json (inkl. First-Party und Stape-Tunnel) ──────────
function auditor(r) {
  const m = matchRequest(r.url, SEITE)
    || extractFirstPartyCollectMatches([r.url], SEITE)[0]
    || extractStapeMatches([{ url: r.url, postData: r.body ?? null }], SEITE)[0];
  return m && m.key ? (VENDOR[m.key] || m.key) : '–';
}

// ── Parser: pii-lib (= lib der Extension), Data Client nur als Hinweis ───────────
async function parser(r) {
  const recs = await parseRequestsAsync(r.url, r.body ?? null, SEITE);
  if (recs.length) return [...new Set(recs.map(x => x.provider))].join('+');
  return parseStapeDataClient(r.url, r.body ?? null) ? 'stape-data' : '–';
}

function kopieGleich() {
  if (!paths.extension) return null;
  const lib = join(paths.extension, 'lib');
  const abw = [];
  for (const f of readdirSync(join(ROOT, 'pii-lib'))) {
    if (f === 'index.js' || !f.endsWith('.js')) continue;
    const quelle = join(lib, f);
    if (!existsSync(quelle)) { abw.push(`${f} fehlt in der Extension`); continue; }
    if (readFileSync(quelle, 'utf-8').replace(/\r\n/g, '\n') !== readFileSync(join(ROOT, 'pii-lib', f), 'utf-8').replace(/\r\n/g, '\n')) abw.push(f);
  }
  return abw;
}

// ── EC Data Validator: background.js + detectors.js in einer vm ─────────────────
function validatorLaden() {
  if (!paths.validator) return null;
  const stub = new Proxy(function () {}, { get: (t, p) => (p === 'then' ? undefined : stub), apply: () => Promise.resolve({}) });
  const ctx = vm.createContext({ chrome: stub, console: { log() {}, error() {}, warn() {} }, URL, URLSearchParams, TextEncoder, TextDecoder,
    atob, btoa, Response, DecompressionStream, crypto, setTimeout, clearTimeout });
  ctx.self = ctx;
  ctx.importScripts = (f) => vm.runInContext(readFileSync(join(paths.validator, f), 'utf-8'), ctx, { filename: f });
  vm.runInContext(readFileSync(join(paths.validator, 'background.js'), 'utf-8'), ctx, { filename: 'background.js' });
  vm.runInContext('state.recording = true; enabledDetectors = Object.fromEntries(EcDetectors.registry.map(d => [d.id, true]));', ctx);
  // Was der Validator ueberhaupt sieht: feste Google-Muster, Detektor-Hosts, eigene Hosts (vom Nutzer freigegeben)
  const glob = (g) => new RegExp('^' + g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  const muster = [...vm.runInContext('STATIC_PATTERNS', ctx), ...vm.runInContext('EcDetectors.registry.flatMap(d => d.permissionOrigins)', ctx)].map(glob);
  return { ctx, sieht: (url) => muster.some(m => m.test(url)) || !/google|doubleclick|facebook|tiktok|pinterest|bing|linkedin|snapchat|reddit|openai/.test(new URL(url).hostname) };
}

function formData(r) {
  const out = {};
  if (r.bodyType === 'form') for (const [k, v] of new URLSearchParams(r.body)) (out[k] ||= []).push(v);
  else for (const m of r.body.matchAll(/name="([^"]+)"\r\n\r\n([\s\S]*?)\r\n--/g)) (out[m[1]] ||= []).push(m[2]);
  return out;
}

async function validator(v, r) {
  if (!v.sieht(r.url)) return '–';
  vm.runInContext('state.captures = [];', v.ctx);
  // Chrome liefert Form- und multipart-Bodies als formData, alles andere roh
  const requestBody = r.body == null ? null
    : (r.bodyType === 'form' || r.bodyType === 'multipart') ? { formData: formData(r) }
    : { raw: [{ bytes: new TextEncoder().encode(r.body).buffer }] };
  v.ctx.handleRequest({ url: r.url, method: r.method || 'GET', timeStamp: 1, tabId: -1, initiator: SEITE, requestBody });
  await new Promise(res => setTimeout(res, 50)); // Detektoren parsen asynchron
  const caps = vm.runInContext('state.captures', v.ctx);
  return caps.length ? [...new Set(caps.map(c => ECV[c.source] || c.source))].join('+') : '–';
}

// ── Stage: STANDARD_DIENSTE aus lib/stage.ts (Text, die Datei ist nicht direkt ladbar) ──
function stageLaden() {
  if (!paths.stage) return null;
  const text = readFileSync(join(paths.stage, 'lib', 'stage.ts'), 'utf-8');
  const block = text.slice(text.indexOf('export const STANDARD_DIENSTE'), text.indexOf('\n];', text.indexOf('export const STANDARD_DIENSTE')));
  const regeln = [];
  for (const m of block.matchAll(/\{\s*name:\s*'([^']+)',\s*muster:\s*(\/.+\/[a-z]*)\s*(?:,\s*(?:nichtProtokollieren:\s*true|dekodieren:\s*\w+)\s*)*\},?\s*$/gm)) {
    regeln.push({ name: m[1], muster: new Function(`return ${m[2]}`)() });
  }
  if (regeln.length < 10) throw new Error(`STANDARD_DIENSTE in lib/stage.ts nicht lesbar (${regeln.length} Regeln)`);
  return regeln;
}

function stage(regeln, r) {
  const regel = regeln.find(x => x.muster.test(r.url));
  return regel ? (STAGE[regel.name] || regel.name) : '–';
}

// ── Lauf ─────────────────────────────────────────────────────────────────────
const v = validatorLaden();
const regeln = stageLaden();
const spalten = ['auditor', 'parser', ...(v ? ['validator'] : []), ...(regeln ? ['stage'] : [])];
const zeilen = [];
for (const r of ref.requests) {
  const ist = { auditor: auditor(r), parser: await parser(r) };
  if (v) ist.validator = await validator(v, r);
  if (regeln) ist.stage = stage(regeln, r);
  const soll = erwartet[r.id] || {};
  const zelle = (s) => {
    const e = soll[s];
    const erw = typeof e === 'object' && e ? e.wert : e;
    if (erw === undefined) { fehler.push(`${r.id}/${s}: kein Erwartungswert (ist: ${ist[s]})`); return `? ${ist[s]}`; }
    if (erw !== ist[s]) { fehler.push(`${r.id}/${s}: erwartet ${erw}, ist ${ist[s]}`); return `✗ ${ist[s]} (erwartet ${erw})`; }
    return ist[s] === '–' && typeof e === 'object' ? '– (Absicht)' : ist[s];
  };
  zeilen.push(`| ${r.id} | ${spalten.map(zelle).join(' | ')} |`);
}

console.log(`| Variante | ${spalten.join(' | ')} |`);
console.log(`|---|${spalten.map(() => '---').join('|')}|`);
console.log(zeilen.join('\n'));

const kopie = kopieGleich();
if (kopie === null) console.log('\npii-lib gegen Extension: nicht geprueft (--extension fehlt)');
else if (kopie.length) { console.log(`\npii-lib weicht von der Extension ab: ${kopie.join(', ')}`); fehler.push('pii-lib'); }
else console.log('\npii-lib entspricht der lib der Extension.');

if (fehler.length) { console.log(`\n${fehler.length} Abweichung(en):\n- ${fehler.join('\n- ')}`); process.exit(1); }
console.log('\nKeine Abweichungen.');
