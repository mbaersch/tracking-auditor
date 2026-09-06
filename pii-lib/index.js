// ── PII/Event-Parser Dispatcher ─────────────────────────────────────────────
//
// VENDORED SNAPSHOT der Per-Vendor-Parser aus der separaten Tracking-Auditor-
// Browser-Extension (eigenes Repo). Die Dateien ga4.js/meta.js/tiktok.js/
// pinterest.js/googleads.js/uet.js/openai.js/params.js sind eine VERBATIM-Kopie
// und duerfen hier NICHT editiert werden -- bei Aenderungen in der Extension neu
// kopieren. Nur dieses index.js ist tracking-auditor-eigen.
//
// Jeder Parser gibt fuer einen passenden Request einen normalisierten Record mit
//   .provider, .identifiers {email,phone,name,address}, .userData, .transport,
//   .consent und Event-Infos zurueck -- oder null.

import { parseGa4Request } from './ga4.js';
import { parseMetaRequest } from './meta.js';
import { parseUetRequest } from './uet.js';
import { parseTiktokRequest } from './tiktok.js';
import { parsePinterestRequest } from './pinterest.js';
import { parseGoogleAdsRequest } from './googleads.js';
import { parseOpenAiRequest } from './openai.js';

export const PARSERS = [
  { id: 'ga4', parse: parseGa4Request },
  { id: 'meta', parse: parseMetaRequest },
  { id: 'uet', parse: parseUetRequest },
  { id: 'tiktok', parse: parseTiktokRequest },
  { id: 'pinterest', parse: parsePinterestRequest },
  { id: 'googleads', parse: parseGoogleAdsRequest },
  { id: 'openai', parse: parseOpenAiRequest },
];

// Anzeigename je Provider (fuer Report/Snapshot).
export const PROVIDER_LABEL = {
  ga4: 'Google Analytics 4',
  meta: 'Meta Pixel',
  uet: 'Microsoft UET (Bing Ads)',
  tiktok: 'TikTok Pixel',
  pinterest: 'Pinterest Tag',
  googleads: 'Google Ads',
  openai: 'OpenAI Pixel',
};

// Erster passender Parser gewinnt (Reihenfolge wie im Extension-Panel).
// Rueckgabe ist IMMER eine Liste: ein Request kann mehrere Events tragen (OpenAI
// batcht mehrere Events in einen POST), und ein Parser darf deshalb ein Array
// liefern. Nie auf das erste Element verkuerzen -- das unterschlaegt den Rest.
export function parseRequests(url, postData) {
  for (const p of PARSERS) {
    let rec = null;
    try { rec = p.parse(url, postData); } catch { rec = null; }
    if (!rec) continue;
    return Array.isArray(rec) ? rec : [rec];
  }
  return [];
}

// Normalisiert die PII-Praesenz eines Records in eine stabile, delta-freundliche Form.
// Wir weisen die EXISTENZ der Felder nach (nicht die Werte).
export function piiFromRecord(rec) {
  const ids = rec.identifiers || {};
  const fields = {
    email: !!ids.email,
    phone: !!ids.phone,
    name: !!ids.name,
    address: !!ids.address,
  };
  const any = fields.email || fields.phone || fields.name || fields.address;
  return { fields, any, hashed: recordHashed(rec) };
}

// Best-effort: sind die uebertragenen Identifier gehasht? Flache Parser
// (meta/tiktok/pinterest/uet/googleads) tragen .hashed pro Feld; GA4 nutzt ein
// verschachteltes user_data-Objekt mit sha256_*-Keys fuer gehashte Werte.
function recordHashed(rec) {
  const ud = rec.userData;
  if (!ud) return false;
  const vals = Object.values(ud);
  if (vals.length && vals.every(v => v && typeof v === 'object' && 'hashed' in v)) {
    return vals.some(v => v.hashed);
  }
  let hashed = false;
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    for (const k of Object.keys(node)) {
      if (/^sha256_/.test(k)) hashed = true;
      else if (node[k] && typeof node[k] === 'object') walk(node[k]);
    }
  })(ud);
  return hashed;
}

// Best-effort Eventname ueber alle Provider hinweg.
export function eventName(rec) {
  return rec.event || rec.en || rec.ev || rec.eventName || null;
}

// Best-effort Konto-/Tag-ID.
export function accountId(rec) {
  return rec.accountId || rec.tid || rec.id || rec.ti || rec.code || rec.convId || rec.pixelId || null;
}
