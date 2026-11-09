# Flow-Aufnahme: baseline

| | |
|---|---|
| Datum | 2026-01-01 12:00 |
| URL | https://www.example.com/ |
| Label | baseline |
| Quelle | har |
| Erreichte Phasen | start -> checkout -> purchase |
| Requests gesamt | 13 |

## TL;DR
- **8** Tracking-Produkte erkannt
- **2** Vendor(en) mit PII-Versand: Google Ads, Meta Pixel
- Consent (gcs beobachtet): G100×1, G111×5 · G100-Pings (trotz Deny): 1
- SST/Loader: Container keine | Custom Loader: nein

## PII-Versand pro Vendor

| Vendor | E-Mail | Telefon | Name | Adresse | Gehasht | Phasen | Transport |
|--------|:------:|:-------:|:----:|:-------:|:-------:|--------|-----------|
| Google Ads | JA | - | - | - | ja | checkout | google |
| Meta Pixel | JA | - | - | - | ja | checkout | standard |

## Erkannte Tracker

| Produkt | Kategorie | Phasen | Transport | Events |
|---------|-----------|--------|-----------|--------|
| LinkedIn Insight Tag | advertising | start | request | event |
| Google Ads | advertising | checkout | request | conversion |
| Meta Pixel | advertising | checkout | script, request | pageview, event |
| Microsoft Ads (UET) | advertising | checkout | request | event |
| TikTok Pixel | advertising | checkout | request | event |
| OpenAI Ads Pixel | advertising | checkout | request | event |
| Floodlight | advertising | purchase | request | conversion |
| Google Analytics 4 | analytics | start, checkout | request | pageview, event |

## Consent Mode (gcs/gcd)

- beobachtete gcs-Werte: `G100` ×1, `G111` ×5
- Pings im vollstaendig denied-Zustand (G100): 1

> **Hinweis:** Basic vs. Advanced ist aus gcs-Werten allein nicht bestimmbar -- entscheidend ist, ob Pings VOR der Consent-Interaktion bzw. trotz denied Defaults feuern (zeitliche Zuordnung, die dieser Request-Snapshot nicht leistet). G101/G110 sind Teil-Consent, kein Advanced-Indiz; nur G100-Pings zaehlen als "trotz Deny gefeuert".

| Phase | gcs | gcd |
|-------|-----|-----|
| start | `G100` | `13p3p3p2p5l1` |
| checkout | `G111` | `13t3t3t2t5l1` |
| checkout | `G111` | `-` |

## SST / Custom Loader

Keine Loader erkannt.

## Artefakte
- Snapshot (fuer Delta): `flow-baseline.json`
