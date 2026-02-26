# Tracking-Vergleich: Standard GTM vs. sGTM Custom Loader

| | Details |
|---|---|
| Datum | 2026-02-26 15:30:42 |
| URL A (Standard GTM) | https://www.locutus.borg/ |
| URL B (sGTM Custom Loader) | https://www.locutus.borg/ |
| Requests A | 38 (32 pre / 6 post) |
| Requests B | 42 (32 pre / 10 post) |

## TL;DR

- **9** Tracking-Produkte auf Setup B, **7** auf Setup A
- Exklusiv auf B: **Hotjar**, **Floodlight**
- Container-IDs: identisch (A: GTM-B0RG42 | B: GTM-B0RG42)
- Measurement-IDs: identisch (A: G-1701DNCC | B: G-1701DNCC)
- Consent Mode: identisch (Advanced)
- **Setup B nutzt Stape Custom Loader** auf mot.locutus.borg

## Tracking-Vergleich (Post-Consent)

| Produkt | Kategorie | Standard GTM | sGTM Custom Loader | Status |
|---------|-----------|-------------|-------------------|--------|
| Sonstige Third-Party | - | unknown | unknown | identisch |
| Google Tag Manager | tag-management | script | script | identisch |
| Google Analytics 4 | analytics | pageview | pageview, event | Typen-Unterschied |
| Google Tag | tag-management | script | script | identisch |
| Google Ads | advertising | conversion | conversion | identisch |
| Meta Pixel | advertising | pageview | pageview | identisch |
| Microsoft Clarity | session-recording | script, event | script, event | identisch |
| Hotjar | session-recording | – | script, event | nur B |
| Floodlight | advertising | – | conversion | nur B |

## Pre-Consent Requests

| Produkt | Standard GTM | sGTM Custom Loader |
|---------|-------------|-------------------|
| Sonstige Third-Party | vorhanden | vorhanden |
| Google Tag Manager | vorhanden | vorhanden |
| Google Analytics 4 | pageview | pageview |

## Consent Mode

| | Standard GTM | sGTM Custom Loader |
|---|---|---|
| Typ | Advanced | Advanced |
| Pre-Consent gcd | `13r3r3r2r5l1` | `13r3r3r2r5l1` |

## SST / Custom Loader Details

### Standard GTM
- **GTM** GTM-B0RG42: `www.googletagmanager.com` (Standard)
- **gtag** G-1701DNCC: `www.googletagmanager.com` (Standard)
- **gtag** GT-WARP7FLD: `www.googletagmanager.com` (Standard)

### sGTM Custom Loader
- **GTM** GTM-B0RG42: `mot.locutus.borg` (Custom Loader, Stape)
- **gtag** G-1701DNCC: `mot.locutus.borg` (Custom Loader, Stape)
- **gtag** GT-WARP7FLD: `mot.locutus.borg` (Custom Loader, Stape)
- **Collect** G-1701DNCC: `mot.locutus.borg` (First-Party Endpoint)

## HAR-Dateien

- Standard GTM: `compare-www_locutus_borg-2026-02-26-153042-a.har`
- sGTM Custom Loader: `compare-www_locutus_borg-2026-02-26-153042-b.har`
