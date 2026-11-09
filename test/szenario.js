// Synthetisches Szenario fuer die Report-Baselines, gebaut aus abgleich/referenz-requests.json
// (nur example.com, Test-IDs). Aendert sich dort ein Request, aendern sich auch die Baselines.
import { readFileSync } from 'node:fs';

const ref = JSON.parse(readFileSync(new URL('../abgleich/referenz-requests.json', import.meta.url), 'utf-8'));
const byId = new Map(ref.requests.map(r => [r.id, r]));

export const SEITE = ref.seite;

/** Referenz-Request als Collector-Eintrag; extra haengt Query-Parameter an (z. B. gcs). */
export function req(id, phase, extra = {}) {
  const r = byId.get(id);
  if (!r) throw new Error(`Referenz-Request ${id} fehlt in abgleich/referenz-requests.json`);
  const u = new URL(r.url);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return { url: u.toString(), method: r.method || 'GET', postData: r.body ?? null, phase };
}

const DENIED = { gcs: 'G100', gcd: '13p3p3p2p5l1' };
const GRANTED = { gcs: 'G111', gcd: '13t3t3t2t5l1' };

/** Direktes Setup: GA4, Ads, Meta, Bing, TikTok, OpenAI; LinkedIn feuert schon vor dem Consent. */
export function direkt(prePhase, postPhase) {
  return {
    pre: [
      req('ga4-get', prePhase, DENIED),
      req('linkedin-collect', prePhase),
    ],
    post: [
      req('ga4-get', postPhase, GRANTED),
      req('ga4-batch', postPhase, GRANTED),
      req('ads-conversion', postPhase),
      req('ads-form-data', postPhase),
      { url: 'https://connect.facebook.net/en_US/fbevents.js', method: 'GET', postData: null, phase: postPhase },
      req('meta-get', postPhase),
      req('meta-form', postPhase),
      req('uet', postPhase),
      req('tiktok-pixel', postPhase),
      req('openai-events', postPhase),
    ],
  };
}

/** Server-Side-Setup: GA4 ueber sGTM und Stape-Tunnel, Data Client, Meta per Form-POST. */
export function serverSide(prePhase, postPhase) {
  return {
    pre: [
      req('ga4-sgtm', prePhase, DENIED),
    ],
    post: [
      req('ga4-sgtm', postPhase, GRANTED),
      req('ga4-stape-b64', postPhase),
      req('stape-data-client', postPhase),
      req('meta-form', postPhase),
      req('uet', postPhase),
    ],
  };
}
