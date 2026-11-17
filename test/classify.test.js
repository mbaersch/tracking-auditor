// Kernregeln der Klassifizierung, die der Abgleich (abgleich/) nicht abdeckt: Domain-Grenzen,
// SST-Erkennung, Consent-Parameter, Verdichtung. Erkennung je Dienst prueft der Abgleich.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getSiteDomain, matchRequest, deduplicateMatches, isGa4CollectUrl, tryDecodeStapeTransport,
  extractFirstPartyCollectMatches, detectSSTFromUrls, extractConsentModeParams, extractUetConsentParams,
} from '../lib/tracking-classify.js';
import { consentLabel } from '../lib/service-records.js';
import { gcsState } from '../flow-lib.js';

const SEITE = 'https://www.example.com/';

test('getSiteDomain: zweistufige Suffixe bleiben eine eigene Domain', () => {
  assert.equal(getSiteDomain('https://shop.example.co.uk/x'), 'example.co.uk');
  assert.equal(getSiteDomain('https://a.b.example.de/'), 'example.de');
  assert.equal(getSiteDomain('kein url'), null);
});

test('matchRequest: eigene Domain ist kein Tracker, fremde Subdomain eines Co.uk-Nachbarn schon', () => {
  assert.equal(matchRequest('https://cdn.example.com/app.js', SEITE), null);
  const fremd = matchRequest('https://cdn.other.co.uk/app.js', 'https://www.example.co.uk/');
  assert.ok(fremd, 'andere *.co.uk-Domain muss als Third-Party gelten');
  assert.equal(fremd.key, null);
});

const CZ_PAGE = 'https://www.example.com/';
const SEM_ID = 'abc123def456ghi789jkl012';

test('matchRequest: SEM loader only with a 24-character alphanumeric ID', () => {
  const m = matchRequest(`https://l.seznam.cz/sul.js?id=${SEM_ID}`, CZ_PAGE);
  assert.equal(m.key, 'seznam-sem');
  assert.equal(m.vendor, 'Seznam');
  assert.equal(m.product, 'Seznam Event Measurement (SEM)');
  assert.equal(m.category, 'advertising');
  assert.equal(m.direction, 'script');
  assert.equal(m.type, null);
  for (const query of ['', '?id=12345', `?id=${SEM_ID.slice(1)}`, `?id=${SEM_ID}-`, `?uid=${SEM_ID}`]) {
    assert.equal(matchRequest(`https://l.seznam.cz/sul.js${query}`, CZ_PAGE).key, null, query);
  }
});

test('matchRequest: SEM endpoint stays event, the event name is in the POST body', () => {
  const m = matchRequest('https://sem.seznam.cz/rtgconv', CZ_PAGE);
  assert.equal(m.key, 'seznam-sem');
  assert.equal(m.direction, 'request');
  assert.equal(m.type, 'event');
  // A query parameter must not fake body parsing that does not exist.
  assert.equal(matchRequest('https://sem.seznam.cz/rtgconv?event_name=Purchase', CZ_PAGE).type, 'event');
});

test('matchRequest: other Seznam requests are not SEM', () => {
  for (const url of [
    'https://h.seznam.cz/udid',
    'https://h.seznam.cz/sid',
    'https://login.seznam.cz/',
    'https://h.seznam.cz/js/cmp2/scmp.js',
    'https://confessor.iva.seznam.cz/sem?msg=error',
    'https://l.seznam.cz/static/js/sem.js?szn_loader=1',
    'https://c.seznam.cz/conv?id=12345',
  ]) {
    const m = matchRequest(url, CZ_PAGE);
    assert.equal(m.key, null, url);
    assert.equal(m.category, null, url);
    assert.equal(m.direction, 'unknown', url);
  }
});

test('isGa4CollectUrl: nur v=2 mit G-ID, unabhaengig vom Host', () => {
  assert.ok(isGa4CollectUrl('https://sst.example.com/g/collect?v=2&tid=G-ABC123'));
  assert.ok(!isGa4CollectUrl('https://sst.example.com/g/collect?v=1&tid=G-ABC123'));
  assert.ok(!isGa4CollectUrl('https://sst.example.com/g/collect?v=2&tid=UA-1'));
});

test('extractFirstPartyCollectMatches: GA4 an den Server-Container der eigenen Domain', () => {
  const [m, ...rest] = extractFirstPartyCollectMatches(['https://sst.example.com/g/collect?v=2&tid=G-ABC123&en=page_view'], SEITE);
  assert.equal(rest.length, 0);
  assert.equal(m.direction, 'sst-collect');
  assert.equal(m.hostname, 'sst.example.com');
  assert.equal(m.product, 'Google Analytics 4');
});

test('tryDecodeStapeTransport: Base64-Pfad im Query-Parameter', () => {
  const pfad = '/g/collect?v=2&tid=G-ABC123&en=page_view';
  const url = `https://sst.example.com/x1?p=${encodeURIComponent(Buffer.from(pfad).toString('base64'))}`;
  const t = tryDecodeStapeTransport(url);
  assert.equal(t.host, 'sst.example.com');
  assert.equal(t.googleHost, 'www.google-analytics.com');
  assert.equal(t.decodedPath, pfad);
  assert.equal(t.encoding, 'base64');
  assert.equal(tryDecodeStapeTransport('https://sst.example.com/x1?p=kurz'), null);
});

test('detectSSTFromUrls: Standard-Loader, First-Party-Loader und Collect-Endpunkt', () => {
  const r = detectSSTFromUrls([
    'https://www.googletagmanager.com/gtm.js?id=GTM-STD1',
    'https://sst.example.com/gtm.js?id=GTM-OWN1',
    'https://sst.example.com/gtag/js?id=G-ABC123',
    'https://sst.example.com/g/collect?v=2&tid=G-ABC123',
    'https://sst.example.com/g/collect?v=2&tid=G-ABC123',
  ], SEITE);
  assert.deepEqual([...r.containers], ['GTM-STD1', 'GTM-OWN1']);
  assert.deepEqual([...r.measurementIds], ['G-ABC123']);
  assert.deepEqual(r.loaders.map(l => [l.type, l.id, l.isStandard, l.isFirstParty]), [
    ['GTM', 'GTM-STD1', true, false],
    ['GTM', 'GTM-OWN1', false, true],
    ['gtag', 'G-ABC123', false, true],
  ]);
  assert.deepEqual(r.collectEndpoints, [{ host: 'sst.example.com', path: '/g/collect', tid: 'G-ABC123' }]);
});

test('extractConsentModeParams: Google-Hosts, google.<tld> und GA4 an eigener Domain; fremde Hosts nicht', () => {
  const p = extractConsentModeParams([
    'https://region1.google-analytics.com/g/collect?v=2&tid=G-A1&gcs=G100&en=page_view',
    'https://www.google.de/ccm/collect?en=consent_update&gcs=G111',
    'https://sst.example.com/g/collect?v=2&tid=G-A1&gcd=13t3t3',
    'https://tracker.example.org/x?gcs=G111',
  ]);
  assert.deepEqual(p.map(x => [x.gcs, x.gcd, x.event]), [
    ['G100', '-', 'page_view'],
    ['G111', '-', 'consent_update'],
    ['-', '13t3t3', null],
  ]);
});

test('extractUetConsentParams: nur /action-Hits, fehlendes asc bleibt "-"', () => {
  const p = extractUetConsentParams([
    'https://bat.bing.com/action/0?ti=1&evt=pageLoad&asc=D',
    'https://bat.bing.com/action/0?ti=1&evt=custom',
    'https://bat.bing.com/bat.js',
  ]);
  assert.deepEqual(p.map(x => [x.asc, x.event]), [['D', 'pageLoad'], ['-', 'custom']]);
});

test('deduplicateMatches: je Produkt eine Zeile, unbekannte Third-Parties je Host', () => {
  const d = deduplicateMatches([
    { key: 'ga4', product: 'GA4', hostname: 'a.example.org', direction: 'request', type: 'pageview' },
    { key: 'ga4', product: 'GA4', hostname: 'b.example.org', direction: 'sst-collect', type: 'event' },
    { key: null, product: 'Sonstige', hostname: 'x.example.net', direction: 'request' },
    { key: null, product: 'Sonstige', hostname: 'y.example.net', direction: 'request' },
    null,
  ]);
  assert.equal(d.length, 3);
  assert.deepEqual(d[0].hostnames, ['a.example.org', 'b.example.org']);
  assert.deepEqual(d[0].directions, ['request', 'sst-collect']);
  assert.deepEqual(d[0].types, ['pageview', 'event']);
});

test('consentLabel: Form je Dienst', () => {
  assert.equal(consentLabel({ consent: { gcs: 'G100' } }), 'gcs=G100');
  assert.equal(consentLabel({ consent: { asc: null } }), 'asc=–');
  assert.equal(consentLabel({ consent: { ldu: true } }), 'LDU');
  assert.equal(consentLabel({ consent: { granted: false } }), 'denied');
  assert.equal(consentLabel({}), null);
});

test('gcsState: G100 ist vollstaendig denied, Teil-Consent nicht', () => {
  assert.deepEqual(gcsState('G100'), { ad: '0', an: '0', fullyDenied: true });
  assert.equal(gcsState('G101').fullyDenied, false);
  assert.equal(gcsState('X'), null);
});
