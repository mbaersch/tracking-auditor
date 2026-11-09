# Tagging Audit: baseline

**URL:** https://www.example.com/ | **Datum:** 2026-01-01 12:00 | **CMP:** Fakecentrics

## Zusammenfassung

**Consent Mode:**

| Phase | gcs | gcd |
|-------|-----|-----|
| Pre-Consent | G100 | 13p3p3p2p5l1 |
| Post-Accept | G111 | 13t3t3t2t5l1 |

**Advanced Consent Mode:** G100 → G111 (Update korrekt)

**Microsoft UET Consent Mode:** Post-Accept asc=- · Post-Reject asc=-

**Bekannte Tracker nach Consent-Phase:**

| Produkt | Pre-Consent | Post-Accept | Post-Reject |
|---------|-------------|-------------|-------------|
| Google Analytics 4 | ja | ja | ja |
| LinkedIn Insight Tag | ja | – | – |
| Google Ads | – | ja | – |
| Meta Pixel | – | ja | – |
| Microsoft Ads (UET) | – | ja | ja |
| TikTok Pixel | – | ja | – |
| OpenAI Ads Pixel | – | ja | – |

**Sonstige Third-Party Domains:** Pre-Consent 0, Post-Accept +0, Post-Reject +0

**✓ Enhanced Conversions aktiv (hashed email)**

**⚠ Meta:** Browser Pixel aktiv, kein CAPI-Endpunkt erkannt

## Hinweise

- Keine Service Worker erkannt

## Tracking Features

**Enhanced Conversions (Google)**
- ✓ Aktiv (hashed email vorhanden)

**Meta**
- Browser Pixel aktiv (connect.facebook.net)
- ⚠ Kein CAPI-Endpunkt erkannt

## Requests je Dienst

Ausgewertet mit den Parsern der pii-lib (wie die Browser-Extension): Events, Werte und Nutzerdaten je Phase. Nutzerdaten = Felder vorhanden, nicht ihre Werte.

| Dienst | Phase | Events | Wert | Transaktion | Artikel | Nutzerdaten | Consent-Signal |
|--------|-------|--------|------|-------------|---------|-------------|----------------|
| Google Analytics 4 | pre-consent | page_view | – | – | – | – | gcs=G100 |
| Google Analytics 4 | post-accept | page_view ×2, purchase | 1× (EUR) | 1 | – | – | gcs=G111 |
| Google Analytics 4 | post-reject | page_view | – | – | – | – | gcs=G100 |
| LinkedIn Insight Tag | pre-consent | PageView | – | – | – | – | – |
| Google Ads | post-accept | conversion, upd | 1× (EUR) | 1 | – | E-Mail (gehasht) | gcs=G111 |
| Meta Pixel | post-accept | PageView, Lead | – | – | – | E-Mail (gehasht) | – |
| Microsoft UET (Bing Ads) | post-accept | pageLoad | – | – | – | – | asc=– |
| Microsoft UET (Bing Ads) | post-reject | pageLoad | – | – | – | – | asc=– |
| TikTok Pixel | post-accept | Pageview | – | – | – | – | – |
| OpenAI Pixel | post-accept | page_view | – | – | – | – | denied |

## OpenAI Ads Pixel

### Pixel pxtest

- SDK-Version: 1

**Consent-Zustand laut Pixel**

| Phase | Zustand | Transport |
|-------|---------|----------|
| post-accept | verweigert | ohne Credentials |

**Events**

| Phase | Event | Typ | Betrag | Items | Dedup-ID |
|-------|-------|-----|--------|-------|----------|
| post-accept | page_view (custom) | - | - | - | ja |

## Pre-Consent

### dataLayer

```json
{
  "event": "gtm.js"
}
```

### Netzwerk-Requests (Third-Party)

#### Bekannte Tracker

| Produkt | Kategorie | Richtung | Typen |
|---------|-----------|----------|-------|
| Google Analytics 4 | analytics | request | pageview |
| LinkedIn Insight Tag | advertising | request | event |

#### Sonstige Third-Party

_Keine sonstigen Third-Party Requests._

### Consent Mode Parameter

| gcs | gcd | Event | Request URL |
|-----|-----|-------|-------------|
| G100 | 13p3p3p2p5l1 | page_view | `https://region1.google-analytics.com/g/collect?v=2&tid=G-TEST000001&cid=1.2&en=page_view&dl=https%3A%2F%2Fwww.example.co...` |

### Cookies

| Name | Domain | Value | httpOnly | secure | sameSite |
|------|--------|-------|----------|--------|----------|
| fakeconsent | .example.com | `` | false | true | Lax |

### localStorage

_Kein localStorage._

## Post-Consent: Accept

### dataLayer (Diff)

```json
{
  "event": "consent_update"
}
```

### Neue Requests

#### Bekannte Tracker

| Produkt | Kategorie | Richtung | Typen |
|---------|-----------|----------|-------|
| Google Analytics 4 | analytics | request | pageview, event |
| Google Ads | advertising | request | conversion |
| Meta Pixel | advertising | script, request | pageview, event |
| Microsoft Ads (UET) | advertising | request | event |
| TikTok Pixel | advertising | request | event |
| OpenAI Ads Pixel | advertising | request | event |

#### Sonstige Third-Party

_Keine sonstigen Third-Party Requests._

### Consent Mode Parameter

| gcs | gcd | Event | Request URL |
|-----|-----|-------|-------------|
| G111 | 13t3t3t2t5l1 | page_view | `https://region1.google-analytics.com/g/collect?v=2&tid=G-TEST000001&cid=1.2&en=page_view&dl=https%3A%2F%2Fwww.example.co...` |
| G111 | 13t3t3t2t5l1 | – | `https://region1.google-analytics.com/g/collect?v=2&tid=G-TEST000001&cid=1.2&cu=EUR&gcs=G111&gcd=13t3t3t2t5l1` |
| G111 | - | conversion | `https://www.googleadservices.com/pagead/conversion/123456789/?random=1&en=conversion&gcs=G111&label=AbCdEf&value=10&curr...` |
| G111 | - | – | `https://www.google.com/ccm/form-data/123456789?gcs=G111&ec_mode=a&em=tv.1~em.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa...` |

> **Advanced Consent Mode Update:** G100 → G111 ✓

### Microsoft UET Consent

| asc | Event | src | Request URL |
|-----|-------|-----|-------------|
| - | pageLoad | – | `https://bat.bing.com/action/0?ti=12345678&tm=gtm002&Ver=2&mid=x&evt=pageLoad&sid=1&vid=2&p=https%3A%2F%2Fwww.example.com...` |

### Cookies (Diff)

| Name | Domain | Value | httpOnly | secure | sameSite |
|------|--------|-------|----------|--------|----------|
| _ga | .example.com | `` | false | true | Lax |
| _fbp | .example.com | `` | false | true | Lax |

### localStorage (Diff)

| Key | Value |
|-----|-------|
| _tt_enable_cookie | `1` |

## Post-Consent: Reject

### dataLayer (Diff)

_dataLayer leer oder nicht vorhanden._

### Neue Requests

#### Bekannte Tracker

| Produkt | Kategorie | Richtung | Typen |
|---------|-----------|----------|-------|
| Google Analytics 4 | analytics | request | pageview |
| Microsoft Ads (UET) | advertising | request | event |

#### Sonstige Third-Party

_Keine sonstigen Third-Party Requests._

### Microsoft UET Consent

| asc | Event | src | Request URL |
|-----|-------|-----|-------------|
| - | pageLoad | – | `https://bat.bing.com/action/0?ti=12345678&tm=gtm002&Ver=2&mid=x&evt=pageLoad&sid=1&vid=2&p=https%3A%2F%2Fwww.example.com...` |

### Cookies (Diff)

_Keine Cookies._

### localStorage (Diff)

_Kein localStorage._

### Auffaelligkeiten (Tracker trotz Reject?)

**WARNUNG:** Folgende bekannte Tracker wurden trotz Reject gefunden:

- **Google Analytics 4**: region1.google-analytics.com
- **Microsoft Ads (UET)**: bat.bing.com

