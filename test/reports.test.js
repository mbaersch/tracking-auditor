// Report-Baselines: synthetische Requests -> Analyse -> Markdown, verglichen mit test/baselines/*.md.
// Gewollte Aenderung: `npm run test:baseline`, dann den Diff der Baselines pruefen.
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  matchRequest, deduplicateMatches, extractStapeMatches, extractStapeFindings, extractFirstPartyCollectMatches,
  detectSSTFromUrls, detectSSTFromStape, extractConsentModeParams, extractUetConsentParams,
} from '../lib/tracking-classify.js';
import { newServiceMap } from '../lib/service-records.js';
import { generateReport, analyzeRequestPayloads, analyzeConsentModeTransition, mergeSST } from '../audit.js';
import { analyzeSide, buildDiff, generateCompareReport } from '../compare.js';
import { analyze, generateReport as generateFlowReport, harToRequests } from '../flow-lib.js';
import { SEITE, req, direkt, serverSide } from './szenario.js';

const baseline = (name) => fileURLToPath(new URL(`./baselines/${name}.md`, import.meta.url));
const roh = { serializers: [(v) => v] };

// Spiegelt die Auswertung in audit.js (main) ohne Browser; der echte Ablauf laeuft in test/browser/.
async function auditDaten(phasen) {
  const tracker = (rs) => deduplicateMatches([
    ...rs.map(r => matchRequest(r.url, SEITE)).filter(Boolean),
    ...extractStapeMatches(rs, SEITE),
    ...extractFirstPartyCollectMatches(rs.map(r => r.url), SEITE),
  ]);
  const urls = (rs) => rs.map(r => r.url);
  const data = {
    project: 'baseline', url: SEITE, cmpName: 'Fakecentrics', timestamp: '2026-01-01 12:00',
    serviceWorkers: [], disabledSW: false, ecommerce: [], ecommerceAnalysis: null,
    deepAnalysis: {
      cspViolations: [], features: { enhancedConversions: null, remarketing: [], metaSetup: null },
      services: newServiceMap(), stapeTransports: [], taggrsTransports: [], dataClientTransports: [],
      googleSubTypes: new Set(), measurementIds: [],
      openai: { sdkLoads: new Set(), configFetches: [], pixels: new Map() },
    },
  };
  const cookie = (name) => ({ name, domain: '.example.com', path: '/', secure: true, httpOnly: false, sameSite: 'Lax', expires: -1 });

  data.preConsent = {
    dataLayer: [{ event: 'gtm.js' }], trackers: tracker(phasen.pre), consentMode: extractConsentModeParams(urls(phasen.pre)),
    uetConsent: extractUetConsentParams(urls(phasen.pre)), cookies: [cookie('fakeconsent')], localStorage: {},
  };
  await analyzeRequestPayloads(phasen.pre, data.preConsent.cookies, SEITE, data.deepAnalysis);

  data.postAccept = {
    dataLayerDiff: [{ event: 'consent_update' }], trackers: tracker(phasen.accept),
    consentMode: extractConsentModeParams(urls(phasen.accept)), uetConsent: extractUetConsentParams(urls(phasen.accept)),
    cookiesDiff: [cookie('_ga'), cookie('_fbp')], localStorageDiff: { _tt_enable_cookie: '1' },
  };
  const stape = extractStapeFindings([...phasen.pre, ...phasen.accept]).decodedRequests;
  data.sst = mergeSST(detectSSTFromUrls(urls(phasen.pre), SEITE), detectSSTFromUrls(urls(phasen.accept), SEITE),
    stape.length ? detectSSTFromStape(stape, SEITE) : null);
  await analyzeRequestPayloads(phasen.accept, [...data.preConsent.cookies, ...data.postAccept.cookiesDiff], SEITE, data.deepAnalysis);

  data.postReject = {
    dataLayerDiff: [], trackers: tracker(phasen.reject), uetConsent: extractUetConsentParams(urls(phasen.reject)),
    cookiesDiff: [], localStorageDiff: {},
  };
  await analyzeRequestPayloads(phasen.reject, data.preConsent.cookies, SEITE, data.deepAnalysis);

  data.deepAnalysis.googleSubTypes = [...data.deepAnalysis.googleSubTypes];
  data.consentModeTransition = analyzeConsentModeTransition(data);
  return data;
}

test('Audit-Report', async (t) => {
  const d = direkt('pre-consent', 'post-accept');
  const data = await auditDaten({
    pre: d.pre,
    accept: d.post,
    reject: [req('ga4-get', 'post-reject', { gcs: 'G100' }), req('uet', 'post-reject')],
  });
  t.assert.fileSnapshot(generateReport(data), baseline('audit'), roh);
});

test('Vergleichs-Report', async (t) => {
  const seite = (s) => ({
    getAll: () => [...s.pre, ...s.post],
    getByPhase: (p) => (p === 'pre-consent' ? s.pre : p === 'post-consent' ? s.post : []),
  });
  const a = await analyzeSide(seite(direkt('pre-consent', 'post-consent')), SEITE);
  const b = await analyzeSide(seite(serverSide('pre-consent', 'post-consent')), SEITE);
  const meta = { urlA: SEITE, urlB: SEITE, labelA: 'Live', labelB: 'sGTM', timestamp: '2026-01-01 12:00',
    harFileA: 'compare-live.har', harFileB: 'compare-sgtm.har' };
  t.assert.fileSnapshot(generateCompareReport(a, b, buildDiff(a, b), meta), baseline('compare'), roh);
});

test('Flow-Report', async (t) => {
  const entries = [...direkt('start', 'start').pre, ...direkt('start', 'checkout').post, req('floodlight', 'purchase')]
    .map(r => ({ pageref: r.phase, request: { url: r.url, method: r.method, ...(r.postData ? { postData: { text: r.postData } } : {}) } }));
  const analysis = await analyze(harToRequests({ log: { entries } }), SEITE);
  const meta = { label: 'baseline', timestamp: '2026-01-01 12:00', url: SEITE, source: 'har', phasesReached: ['start', 'checkout', 'purchase'], snapshotFile: 'flow-baseline.json' };
  t.assert.fileSnapshot(generateFlowReport(analysis, meta), baseline('flow'), roh);
});
