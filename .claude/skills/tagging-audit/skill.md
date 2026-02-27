---
name: tagging-audit
description: Use when user wants to audit tagging, tracking, consent, or dataLayer on a website. Triggers on keywords like audit, tagging check, consent check, tracking verification, CMP test, dataLayer inspection. NOT for learning/adding CMPs -- use cmp-learn skill for that.
---

# Tagging Audit

Automatisierte Analyse von Tracking-Setups auf Websites. Erfasst dataLayer, Netzwerk-Requests, Cookies und localStorage in verschiedenen Consent-Zustaenden.

## Arbeitsverzeichnis

Alle Befehle laufen im **Repository-Root** (dort wo `audit.js` liegt).

## Default-Workflow (bevorzugt)

Der Normalfall ist maximal einfach. Keine CMP-Auswahl, keine Vorbereitung.

### 1. URL erfragen

Nur die URL ist noetig. Alles andere ergibt sich:

- **Project name:** Automatisch aus URL ableiten als `subdomain_domain_tld` (z.B. `www_gandke_de`, `shop_example_co_uk`). Ohne Subdomain: `domain_tld`. Nicht fragen -- einfach ableiten.
- **CMP:** Wird automatisch erkannt. Nicht fragen, nicht angeben.

### 2. E-Commerce?

Wenn erkennbar ein Shop (oder User sagt es): Frage ob E-Commerce-Pfad gewuenscht ist.

- **Ja** -> `--ecom` (interaktiv, der User navigiert selbst durch den Shop)
- **Nein** -> nur Consent-Check

Im Zweifelsfall: einfach ohne `--ecom` starten. E-Commerce kann beim naechsten Lauf ergaenzt werden.

### 3. Audit starten

```bash
# Consent-only (Normalfall)
node audit.js --url https://example.com --project example_com

# Mit interaktivem E-Commerce
node audit.js --url https://example.com --project example_com --ecom
```

Das ist alles. Der Browser oeffnet sich, die CMP wird automatisch erkannt (Dropdown + manueller Modus als Fallback), der Audit laeuft durch.

### 4. Report auswerten

Report liegt unter `reports/<project>/audit-<YYYY-MM-DD-HHMM>.md`. Lies ihn und fasse die wichtigsten Findings zusammen:

- **Pre-Consent Tracking** -- Tracker vor Consent-Entscheidung? (Verstoss)
- **Tracking nach Reject** -- Bekannte Tracker trotz Reject? (Verstoss)
- **Consent Mode** -- gcs/gcd Parameter vorhanden und korrekt?
- **Cookie-Inventar** -- Anzahl Cookies pre vs. post Consent
- **E-Commerce Events** -- dataLayer-Events vorhanden? Produktdaten konsistent?

**Report-Format:** Die Tracker-Tabellen zeigen Produkt-Level Detail (z.B. "Google Analytics 4", "Google Ads" statt nur "Google"). Spalten: Produkt, Kategorie, Richtung (script/request), Typen (pageview/conversion/event). Datenquelle ist `tracking-vendors.json`.

## Wenn es Probleme gibt

Folgende Parameter helfen bei Sonderfaellen. Sie sind NICHT fuer den Normalfall gedacht.

### CMP wird nicht erkannt

Die Auto-Erkennung deckt ~40 CMPs ab und bietet im Browser ein Dropdown zur manuellen Auswahl sowie einen Skip-Button. Im manuellen Modus erscheint eine Consent Card -- der User klickt Accept/Reject selbst und bestaetigt per Button. Falls die CMP unbekannt ist:

1. CMP zuerst einlernen mit dem **cmp-learn** Skill
2. Dann Audit erneut starten (ohne `--cmp` -- die Auto-Erkennung findet die neu gelernte CMP)

### Service Worker blockiert Requests

Wenn der Report eine SW-Warnung enthaelt: zweiten Lauf mit `--disable-sw`.

```bash
node audit.js --url https://example.com --project example_com --disable-sw
```

### E-Commerce automatisch (URLs bekannt)

Wenn alle E-Commerce-URLs und der ATC-Selektor vorab bekannt sind, kann statt `--ecom` auch der automatische Modus genutzt werden:

```bash
node audit.js --url https://example.com --project example_com \
  --category /kategorie/schuhe \
  --product /produkt/sneaker-xyz \
  --add-to-cart ".add-to-cart-btn" \
  --view-cart /warenkorb \
  --checkout /kasse
```

### Alle Parameter (Referenz)

| Parameter | Beschreibung |
|-----------|-------------|
| `--url` | Startseite URL (Pflicht) |
| `--project` | Projektname fuer Report-Pfad (Pflicht) |
| `--ecom` | Interaktiver E-Commerce-Modus |
| `--disable-sw` | Service Worker deregistrieren |
| `--category` | Kategorie-URL (automatischer E-Commerce) |
| `--product` | Produkt-URL |
| `--add-to-cart` | CSS-Selektor fuer ATC-Button |
| `--view-cart` | Warenkorb-URL |
| `--checkout` | Checkout-URL |
| `--cmp` | CMP-Name, ueberspringt Auto-Erkennung (nur Notfall) |
| `--no-payload-analysis` | Deep Analysis deaktivieren (CSP, Payloads, Stape-Decode) |
| `--har` | HAR-Datei mit allen Requests exportieren (neben dem Report) |
