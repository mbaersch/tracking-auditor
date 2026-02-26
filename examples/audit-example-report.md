# Tagging Audit: borg-collective

**URL:** https://www.locutus.borg/ | **Datum:** 2026-02-26 14:03 | **CMP:** Borg Consent Collective

## Zusammenfassung

**Consent Mode:**

| Phase | gcs | gcd |
|-------|-----|-----|
| Post-Accept | G111 | 13r3r3r2r5l1 |

**Bekannte Tracker nach Consent-Phase:**

| Produkt | Pre-Consent | Post-Accept | Post-Reject |
|---------|-------------|-------------|-------------|
| Google Tag Manager | ja | ja | – |
| Google Analytics 4 | – | ja | – |
| Google Tag | – | ja | – |
| Google Ads | – | ja | – |
| Floodlight | – | ja | – |
| Meta Pixel | – | ja | ja |
| Microsoft Clarity | – | ja | – |
| Hotjar | – | ja | – |
| TikTok Pixel | – | CSP-blockiert | – |

**Sonstige Third-Party Domains:** Pre-Consent 2, Post-Accept +3, Post-Reject +0

**Server-Side Tagging:** 2 Custom Loader, 1 Collect Endpoint | Stape-Transport auf picard.locutus.borg

**E-Commerce – Tracker pro Schritt:**

| Schritt | Bekannte Tracker | gcs |
|---------|------------------|-----|
| Kategorie-Seite | Google Analytics 4 | G111 |
| Produkt-Seite | Google Analytics 4, Google Ads | G111 |
| Add-to-Cart | Google Analytics 4, Google Ads, Meta Pixel | G111 |
| Checkout | Google Analytics 4, Floodlight, Meta Pixel | G111 |

**⚠ CSP blockiert 3 Tracking-Requests**

**✓ Enhanced Conversions aktiv (hashed email)**

**✓ Dynamic Remarketing: Produkt-IDs in 2 Ads-Requests**

## Hinweise

- Keine Service Worker erkannt

## CSP-Blockaden

| Blockierte Ressource | Direktive |
|----------------------|-----------|
| https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=BORG7TK (TikTok) | script-src-elem |
| https://snap.licdn.com/li.lms-analytics/insight.min.js (LinkedIn) | script-src-elem |
| https://www.facebook.com/tr/?id=1701170117011&ev=PageView&noscript=1 (Meta) | connect-src |

## Server-Side Tagging Analyse

**Custom Loader Transport (Stape):**

- picard.locutus.borg – Base64-encodierter Transport erkannt

**Custom Loader (Response-Analyse):**

- `https://www.locutus.borg/scripts/borg-loader.js?v=2.4.1` enthaelt GTM Container Code (GTM-B0RG42)
- `https://picard.locutus.borg/qzxw7kcvbn.js?st=UkVTSVNUQU5DRSBJUyBGVVRJTEU%3D` enthaelt GTM Container Code (GTM-B0RG42)

**Collect Endpoints:**

| Endpoint | Host | Pfad | Measurement ID |
|----------|------|------|----------------|
| GA4 Collect | picard.locutus.borg | /g/collect | G-1701DNCC |

## Tracking Features

**Erkannte Tag-IDs (aus Payload-Analyse):**

| Typ | ID | Host |
|-----|----|------|
| GA4 | G-1701DNCC | picard.locutus.borg |
| Google Tag | GT-WARP7FLD | picard.locutus.borg |
| Google Ads | AW-PHASER01 | googleads.g.doubleclick.net |
| Floodlight | DC-DEFLECT9 | ad.doubleclick.net |

**Enhanced Conversions (Google)**
- ✓ Aktiv (hashed email vorhanden)
- Event: purchase

**Dynamic Remarketing (Google Ads)**
- ✓ Produkt-IDs in 2 Request(s)
- Seiten-Typen: product, cart

## Pre-Consent

### dataLayer

```json
{
  "orgPageTitle": "USS Enterprise Crew Shop | Sternenflotten-Bedarf",
  "documentPath": "Home",
  "documentGroup": "Home"
}
{
  "gtm.start": 1772110980000,
  "event": "gtm.js",
  "gtm.uniqueEventId": 3
}
{
  "0": "set",
  "1": "developer_id.dB0rG42",
  "2": true
}
{
  "0": "consent",
  "1": "default",
  "2": {
    "ad_storage": "denied",
    "ad_user_data": "denied",
    "ad_personalization": "denied",
    "analytics_storage": "denied",
    "functionality_storage": "denied",
    "personalization_storage": "denied",
    "security_storage": "denied",
    "wait_for_update": 500
  }
}
{
  "0": "set",
  "1": "ads_data_redaction",
  "2": true
}
{
  "event": "BorgConsentLoaded",
  "BorgActiveGroups": ",essential,",
  "gtm.uniqueEventId": 7
}
{
  "event": "gtm.dom",
  "gtm.uniqueEventId": 8
}
{
  "event": "gtm.load",
  "gtm.uniqueEventId": 9
}
```

### Netzwerk-Requests (Third-Party)

#### Bekannte Tracker

| Produkt | Kategorie | Richtung | Typen |
|---------|-----------|----------|-------|
| Google Tag Manager | tag-management | script | - |

#### Sonstige Third-Party

| Hostname |
|----------|
| cdn.borg-consent.collective |
| fonts.googleapis.com |

### Consent Mode Parameter

_Keine Consent Mode Parameter gefunden._

### Cookies

| Name | Domain | Value | httpOnly | secure | sameSite |
|------|--------|-------|----------|--------|----------|
| borg_session | www.locutus.borg | `s%3Abf7d2a91c3e8.assimilation_pending` | true | true | Strict |
| BorgConsentStatus | .locutus.borg | `essential_only=1&timestamp=2026-02-26T13%3A03%3A01.442Z` | false | false | Lax |

### localStorage

_Kein localStorage._

## Post-Consent: Accept

### dataLayer (Diff)

```json
{
  "event": "borg_consent_accept",
  "borgConsentAction": "Accept All",
  "gtm.uniqueEventId": 10
}
{
  "event": "BorgConsentLoaded",
  "BorgActiveGroups": ",essential,analytics,marketing,personalization,",
  "gtm.uniqueEventId": 11
}
{
  "0": "consent",
  "1": "update",
  "2": {
    "ad_storage": "granted",
    "ad_user_data": "granted",
    "ad_personalization": "granted",
    "analytics_storage": "granted",
    "functionality_storage": "granted",
    "personalization_storage": "granted",
    "security_storage": "granted"
  }
}
{
  "0": "set",
  "1": "ads_data_redaction",
  "2": false
}
{
  "event": "BorgGroupsUpdated",
  "BorgActiveGroups": ",essential,analytics,marketing,personalization,",
  "gtm.uniqueEventId": 14
}
```

### Neue Requests

#### Bekannte Tracker

| Produkt | Kategorie | Richtung | Typen |
|---------|-----------|----------|-------|
| Google Analytics 4 | analytics | script, request | pageview, event |
| Google Tag | tag-management | script | - |
| Google Ads | advertising | request | conversion |
| Floodlight | advertising | request | conversion |
| Meta Pixel | advertising | script, request | pageview |
| Microsoft Clarity | session-recording | script, request | event |
| Hotjar | session-recording | script, request | event |
| Google Tag Manager | tag-management | domain | - |

#### Sonstige Third-Party

| Hostname |
|----------|
| www.google.de |
| www.google.com |
| www.facebook.com |

### Consent Mode Parameter

| gcs | gcd | Request URL |
|-----|-----|-------------|
| G111 | 13r3r3r2r5l1 | `https://picard.locutus.borg/g/collect?v=2&tid=G-1701DNCC&gtm=45je62o1h1v882563677z8541661za20gzb541661zd54166...` |
| G111 | 13r3r3r2r5l1 | `https://stats.g.doubleclick.net/g/collect?v=2&tid=G-1701DNCC&cid=1471047239.1772110980&gtm=45je62o1h1v88256...` |
| - | 13r3r3r2r5l1 | `https://googleads.g.doubleclick.net/pagead/viewthroughconversion/PHASER01/?random=1772110983170&cv=11&fst=17...` |
| G111 | 13r3r3r2r5l1 | `https://picard.locutus.borg/g/collect?v=2&tid=G-1701DNCC&gtm=45je62o1h1v882563677za20gzb541661zd541661&_p=1772...` |

### Cookies (Diff)

| Name | Domain | Value | httpOnly | secure | sameSite |
|------|--------|-------|----------|--------|----------|
| BorgConsentAccepted | .locutus.borg | `2026-02-26T13:03:05.891Z` | false | false | Lax |
| _ga | .locutus.borg | `GA1.1.1471047239.1772110980` | false | false | Lax |
| _ga_1701DNCC | .locutus.borg | `GS2.1.s1772110983$o1$g0$t1772110983$j60$l0$h807881317` | false | false | Lax |
| _gcl_au | .locutus.borg | `1.1.942073156.1772110983` | false | false | Lax |
| _gcl_aw | .locutus.borg | `GCL.1772110983.Cj0KCQiA-qG9BhC-ARIsACGOlPhas3rD4...` | false | false | Lax |
| _fbp | .locutus.borg | `fb.1.1772110983204.1701170117` | false | true | Lax |
| _fbc | .locutus.borg | `fb.1.1772110983204.fbclid_abc123warp` | false | true | Lax |
| FPID | .locutus.borg | `FPID2.2.rK8pQ7zBorg2assimilate%3D.1772110980` | true | true | Lax |
| FPLC | .locutus.borg | `QijHuIzResistanceIsFutile%2BfSenAXvPCHm...` | false | true | Lax |
| FPGSID | .locutus.borg | `1.1772110983.1772110983.G-1701DNCC.aJ8OCcSyndO4MYMrLu_Ybg` | false | true | Strict |
| _clck | .locutus.borg | `b8pe9j%5E2%5Eg3w%5E1%5E2248` | false | false | Lax |
| _clsk | .locutus.borg | `borg71%5E1772110984999%5E5%5E1%5Ez.clarity.ms%2Fcollect` | false | false | Lax |
| _hjSessionUser_1701 | .locutus.borg | `eyJpZCI6ImJvcmctdXNlci0xNzAxIiwiY3JlYXRlZCI6MTc3MjExMDk4M...` | false | true | Lax |
| _hjSession_1701 | .locutus.borg | `eyJpZCI6ImJvcmctc2Vzc2lvbi0xNzAxIn0=` | false | true | Lax |
| test_cookie | .doubleclick.net | `CheckForPermission` | false | true | None |

### localStorage (Diff)

| Key | Value |
|-----|-------|
| _gcl_ls | `{"schema":"gcl","version":1,"gcl_ctr":{"value":{"value":0,"t...` |
| _hjTLDTest | `1` |
| _hjActiveViewportIds | `["1772110983-borg"]` |

## Post-Consent: Reject

### dataLayer (Diff)

```json
{
  "event": "borg_consent_reject",
  "borgConsentAction": "Reject All",
  "gtm.uniqueEventId": 10
}
{
  "event": "BorgConsentLoaded",
  "BorgActiveGroups": ",essential,",
  "gtm.uniqueEventId": 11
}
{
  "0": "consent",
  "1": "update",
  "2": {
    "ad_storage": "denied",
    "ad_user_data": "denied",
    "ad_personalization": "denied",
    "analytics_storage": "denied",
    "functionality_storage": "denied",
    "personalization_storage": "denied",
    "security_storage": "granted"
  }
}
{
  "0": "set",
  "1": "ads_data_redaction",
  "2": true
}
{
  "event": "BorgGroupsUpdated",
  "BorgActiveGroups": ",essential,",
  "gtm.uniqueEventId": 14
}
```

### Neue Requests

#### Bekannte Tracker

| Produkt | Kategorie | Richtung | Typen |
|---------|-----------|----------|-------|
| Meta Pixel | advertising | request | event |

#### Sonstige Third-Party

_Keine sonstigen Third-Party Requests._

### Cookies (Diff)

| Name | Domain | Value | httpOnly | secure | sameSite |
|------|--------|-------|----------|--------|----------|
| BorgConsentRejected | .locutus.borg | `2026-02-26T13:03:14.205Z` | false | false | Lax |

### localStorage (Diff)

_Kein localStorage._

### Auffaelligkeiten (Tracker trotz Reject?)

**WARNUNG:** Folgende bekannte Tracker wurden trotz Reject gefunden:

- **Meta Pixel**: connect.facebook.net

## E-Commerce Pfad

| Schritt | dataLayer Events | Tracking Requests | Neue Cookies |
|---------|-----------------|-------------------|---------------|
| Kategorie-Seite | gtm.js, gtm.dom, BorgConsentLoaded, BorgGroupsUpdated, view_item_list, gtm.load | GA4 (picard.locutus.borg) | - |
| Produkt-Seite | gtm.js, gtm.dom, BorgConsentLoaded, BorgGroupsUpdated, view_item, gtm.load | GA4 (picard.locutus.borg), Google Ads (googleads.g.doubleclick.net) | - |
| Add-to-Cart | add_to_cart | GA4 (picard.locutus.borg), Google Ads (googleads.g.doubleclick.net), Meta (connect.facebook.net) | - |
| Checkout | begin_checkout | GA4 (picard.locutus.borg), Floodlight (ad.doubleclick.net), Meta (www.facebook.com) | - |

### Kategorie-Seite

#### dataLayer (Diff)

```json
{
  "orgPageTitle": "Waffen & Verteidigung | USS Enterprise Crew Shop",
  "documentPath": "/kategorie/waffen-verteidigung/",
  "documentGroup": "Kategorie"
}
{
  "gtm.start": 1772111040000,
  "event": "gtm.js",
  "gtm.uniqueEventId": 3
}
{
  "event": "gtm.dom",
  "gtm.uniqueEventId": 6
}
{
  "event": "BorgConsentLoaded",
  "BorgActiveGroups": ",essential,analytics,marketing,personalization,",
  "gtm.uniqueEventId": 7
}
{
  "0": "consent",
  "1": "update",
  "2": {
    "ad_storage": "granted",
    "ad_user_data": "granted",
    "ad_personalization": "granted",
    "analytics_storage": "granted"
  }
}
{
  "event": "BorgGroupsUpdated",
  "BorgActiveGroups": ",essential,analytics,marketing,personalization,",
  "gtm.uniqueEventId": 9
}
{
  "event": "view_item_list",
  "ecommerce": {
    "item_list_id": "waffen-verteidigung",
    "item_list_name": "Waffen & Verteidigung",
    "items": [
      {
        "item_id": "BORG-PH2",
        "item_name": "Phaser Typ-2",
        "item_category": "Waffen & Verteidigung",
        "price": 299.99,
        "index": 0
      },
      {
        "item_id": "BORG-TR7",
        "item_name": "Tricorder Mark VII",
        "item_category": "Wissenschaft & Medizin",
        "price": 549.00,
        "index": 1
      },
      {
        "item_id": "BORG-KB1",
        "item_name": "Kommunikator Badge",
        "item_category": "Kommunikation",
        "price": 89.95,
        "index": 2
      }
    ]
  },
  "gtm.uniqueEventId": 10
}
{
  "event": "gtm.load",
  "gtm.uniqueEventId": 11
}
```

#### Netzwerk-Requests

#### Bekannte Tracker

| Produkt | Kategorie | Richtung | Typen |
|---------|-----------|----------|-------|
| Google Analytics 4 | analytics | request | view_item_list |

#### Sonstige Third-Party

_Keine sonstigen Third-Party Requests._

#### Cookies (Diff)

_Keine Cookies._

#### localStorage (Diff)

_Kein localStorage._

### Produkt-Seite

#### dataLayer (Diff)

```json
{
  "orgPageTitle": "Phaser Typ-2 | USS Enterprise Crew Shop",
  "documentPath": "/produkt/phaser-typ-2/",
  "documentGroup": "Produkt"
}
{
  "gtm.start": 1772111060000,
  "event": "gtm.js",
  "gtm.uniqueEventId": 3
}
{
  "event": "gtm.dom",
  "gtm.uniqueEventId": 6
}
{
  "event": "BorgConsentLoaded",
  "BorgActiveGroups": ",essential,analytics,marketing,personalization,",
  "gtm.uniqueEventId": 7
}
{
  "0": "consent",
  "1": "update",
  "2": {
    "ad_storage": "granted",
    "ad_user_data": "granted",
    "ad_personalization": "granted",
    "analytics_storage": "granted"
  }
}
{
  "event": "BorgGroupsUpdated",
  "BorgActiveGroups": ",essential,analytics,marketing,personalization,",
  "gtm.uniqueEventId": 9
}
{
  "event": "view_item",
  "ecommerce": {
    "currency": "EUR",
    "value": 299.99,
    "items": [
      {
        "item_id": "BORG-PH2",
        "item_name": "Phaser Typ-2",
        "item_category": "Waffen & Verteidigung",
        "item_variant": "Gold-Pressung, Sternenflotten-Edition",
        "price": 299.99,
        "quantity": 1
      }
    ]
  },
  "gtm.uniqueEventId": 10
}
{
  "adwords": {
    "remarketing": {
      "ecomm_prodid": "BORG-PH2",
      "ecomm_pagetype": "product",
      "ecomm_totalvalue": "299.99"
    }
  }
}
{
  "event": "gtm.load",
  "gtm.uniqueEventId": 12
}
```

#### Netzwerk-Requests

#### Bekannte Tracker

| Produkt | Kategorie | Richtung | Typen |
|---------|-----------|----------|-------|
| Google Analytics 4 | analytics | request | view_item |
| Google Ads | advertising | request | remarketing |

#### Sonstige Third-Party

_Keine sonstigen Third-Party Requests._

#### Cookies (Diff)

_Keine Cookies._

#### localStorage (Diff)

_Kein localStorage._

### Add-to-Cart

#### dataLayer (Diff)

```json
{
  "event": "add_to_cart",
  "ecommerce": {
    "currency": "EUR",
    "value": 299.99,
    "items": [
      {
        "item_id": "BORG-PH2",
        "item_name": "Phaser Typ-2",
        "item_category": "Waffen & Verteidigung",
        "item_variant": "Gold-Pressung, Sternenflotten-Edition",
        "price": 299.99,
        "quantity": 1
      }
    ]
  },
  "gtm.uniqueEventId": 13
}
{
  "adwords": {
    "remarketing": {
      "ecomm_prodid": "BORG-PH2",
      "ecomm_pagetype": "cart",
      "ecomm_totalvalue": "299.99"
    }
  }
}
```

#### Netzwerk-Requests

#### Bekannte Tracker

| Produkt | Kategorie | Richtung | Typen |
|---------|-----------|----------|-------|
| Google Analytics 4 | analytics | request | add_to_cart |
| Google Ads | advertising | request | conversion |
| Meta Pixel | advertising | request | AddToCart |

#### Sonstige Third-Party

_Keine sonstigen Third-Party Requests._

#### Cookies (Diff)

_Keine Cookies._

#### localStorage (Diff)

_Kein localStorage._

### Checkout

#### dataLayer (Diff)

```json
{
  "orgPageTitle": "Checkout | USS Enterprise Crew Shop",
  "documentPath": "/checkout/",
  "documentGroup": "Checkout"
}
{
  "gtm.start": 1772111120000,
  "event": "gtm.js",
  "gtm.uniqueEventId": 3
}
{
  "event": "begin_checkout",
  "ecommerce": {
    "currency": "EUR",
    "value": 299.99,
    "items": [
      {
        "item_id": "BORG-PH2",
        "item_name": "Phaser Typ-2",
        "item_category": "Waffen & Verteidigung",
        "item_variant": "Gold-Pressung, Sternenflotten-Edition",
        "price": 299.99,
        "quantity": 1
      }
    ]
  },
  "gtm.uniqueEventId": 14
}
```

#### Netzwerk-Requests

#### Bekannte Tracker

| Produkt | Kategorie | Richtung | Typen |
|---------|-----------|----------|-------|
| Google Analytics 4 | analytics | request | begin_checkout |
| Floodlight | advertising | request | conversion |
| Meta Pixel | advertising | request | InitiateCheckout |

#### Sonstige Third-Party

_Keine sonstigen Third-Party Requests._

#### Cookies (Diff)

_Keine Cookies._

#### localStorage (Diff)

_Kein localStorage._

### Produktdaten-Analyse

**Format:** GA4 (`ecommerce.items[]`)

**Fokus-Produkt:** ID BORG-PH2 – Phaser Typ-2

| Eigenschaft | Kategorie-Seite | Produkt-Seite | Add-to-Cart | Checkout |
|-------------|-----------------|---------------|-------------|----------|
| item_id | BORG-PH2 | BORG-PH2 | BORG-PH2 | BORG-PH2 |
| item_name | Phaser Typ-2 | Phaser Typ-2 | Phaser Typ-2 | Phaser Typ-2 |
| item_category | Waffen & Verteidigung | Waffen & Verteidigung | Waffen & Verteidigung | Waffen & Verteidigung |
| price | 299.99 | 299.99 | 299.99 | 299.99 |
| quantity | - | 1 | 1 | 1 |
| item_variant | - | Gold-Pressung, Sternenflotten-Edition | Gold-Pressung, Sternenflotten-Edition | Gold-Pressung, Sternenflotten-Edition |
