# Tracking-Vergleich: Live vs. sGTM

| | Details |
|---|---|
| Datum | 2026-01-01 12:00 |
| URL A (Live) | https://www.example.com/ |
| URL B (sGTM) | https://www.example.com/ |
| Requests A | 12 (2 pre / 10 post) |
| Requests B | 6 (1 pre / 5 post) |

## TL;DR

- **3** Tracking-Produkte auf beiden Seiten
- **4** nur auf Live: LinkedIn Insight Tag, Google Ads, TikTok Pixel, OpenAI Ads Pixel
- Container-IDs: identisch (A: keine | B: keine)
- Measurement-IDs: ABWEICHEND (A: keine | B: G-TEST000001)
- Custom Loader: A=nein | B=sst.example.com
- Consent Mode: identisch (Advanced)

## Tracking-Vergleich (Post-Consent)

| Produkt | Kategorie | Live | sGTM | Status |
|---------|-----------|--------|--------|--------|
| Google Analytics 4 | analytics | pageview, event | generate_lead, pageview (sst-tunnel) | ABWEICHEND |
| Meta Pixel | advertising | pageview, event | event | ABWEICHEND |
| Microsoft Ads (UET) | advertising | event | event | identisch |
| LinkedIn Insight Tag | advertising | vorhanden | - | nur Live |
| Google Ads | advertising | vorhanden | - | nur Live |
| TikTok Pixel | advertising | vorhanden | - | nur Live |
| OpenAI Ads Pixel | advertising | vorhanden | - | nur Live |

## Pre-Consent Requests

| Produkt | Live | sGTM |
|---------|--------|--------|
| Google Analytics 4 | pageview | pageview |
| LinkedIn Insight Tag | event | - |

## Consent Mode

| | Live | sGTM |
|---|---|---|
| Typ | Advanced | Advanced |
| Pre-Consent gcs | `G100` | `G100` |
| Post-Consent gcs | `G111` | `G111` |
| Pre-Consent gcd | `13p3p3p2p5l1` | `13p3p3p2p5l1` |
| Post-Consent gcd | `13t3t3t2t5l1` | `13t3t3t2t5l1` |

## Requests je Dienst

Ausgewertet mit den Parsern der pii-lib: Events, Werte und Nutzerdaten je Phase (Felder vorhanden, nicht ihre Werte).

### Live

| Dienst | Phase | Events | Wert | Transaktion | Artikel | Nutzerdaten | Consent-Signal |
|--------|-------|--------|------|-------------|---------|-------------|----------------|
| Google Analytics 4 | pre-consent | page_view | – | – | – | – | gcs=G100 |
| Google Analytics 4 | post-consent | page_view ×2, purchase | 1× (EUR) | 1 | – | – | gcs=G111 |
| LinkedIn Insight Tag | pre-consent | PageView | – | – | – | – | – |
| Google Ads | post-consent | conversion, upd | 1× (EUR) | 1 | – | E-Mail (gehasht) | gcs=G111 |
| Meta Pixel | post-consent | PageView, Lead | – | – | – | E-Mail (gehasht) | – |
| Microsoft UET (Bing Ads) | post-consent | pageLoad | – | – | – | – | asc=– |
| TikTok Pixel | post-consent | Pageview | – | – | – | – | – |
| OpenAI Pixel | post-consent | page_view | – | – | – | – | denied |

### sGTM

| Dienst | Phase | Events | Wert | Transaktion | Artikel | Nutzerdaten | Consent-Signal |
|--------|-------|--------|------|-------------|---------|-------------|----------------|
| Google Analytics 4 | pre-consent | page_view | – | – | – | – | gcs=G100 |
| Google Analytics 4 | post-consent | page_view, generate_lead | – | – | – | E-Mail (⚠ nicht gehasht erkannt) | gcs=G111 |
| Meta Pixel | post-consent | Lead | – | – | – | E-Mail (gehasht) | – |
| Microsoft UET (Bing Ads) | post-consent | pageLoad | – | – | – | – | asc=– |

## SST / Custom Loader Details

### Live
Keine Loader erkannt.

### sGTM
- **Stape Custom Loader**: `sst.example.com`
- Collect-Endpoints:
  - `sst.example.com/g/collect` (G-TEST000001)

## HAR-Dateien

- Live: `compare-live.har`
- sGTM: `compare-sgtm.har`
