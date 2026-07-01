---
name: flow-compare
description: Use when user wants an asynchronous before/after comparison of a checkout/funnel flow over time (e.g. before vs. after a GTM/consent/server-side migration), or wants to prove which PII fields (email, phone, name, address) a vendor receives. Triggers on keywords like flow vergleich, baseline, vorher nachher HAR, delta, PII nachweis, checkout tracking, HAR auswerten. NOT for comparing two URLs synchronously in one run -- use tracking-compare for that. NOT for a single-page audit -- use tagging-audit.
---

# Asynchroner Flow-Vergleich (HAR-basiert)

Vergleicht EINEN Checkout-/Funnel-Flow ueber die Zeit: Baseline (vorher) gegen einen zweiten Lauf (nachher, z.B. nach GTM-/Consent-/Server-Side-Umstellung). Schwerpunkt: mehrstufiger Flow (Startseite -> Produkt -> Warenkorb -> Checkout -> Adresse) und **Nachweis, welche PII-Felder an welchen Vendor** gehen (inkl. gehashter Formen).

Abgrenzung zu `tracking-compare`: Das vergleicht zwei URLs **synchron in einem Lauf**. Dieser Skill ist **asynchron** (zwei Laeufe zu verschiedenen Zeitpunkten) und mehrstufig.

## Arbeitsverzeichnis

Alle Befehle laufen im **Repository-Root** (dort wo `flow-analyze.js` liegt).

## Zwei Wege der Aufnahme

1. **HAR selbst aufnehmen (empfohlen, robust):** DevTools -> Network -> **"Preserve log" AN** -> Funnel durchklicken (bis Adresseingabe, **kein Kaufabschluss**) -> **"Save all as HAR with content"**. Dann mit `flow-analyze.js` auswerten.
2. **Live-Recorder (`flow-recorder.js`):** komfortabler, aber fragiler (Phasen-Overlay kann hinter CMP-Bannern liegen). Nur nutzen, wenn der User es ausdruecklich will oder die zeitliche Consent-Phase (vor/nach Consent) gebraucht wird.

## Workflow

### 1. Baseline auswerten

```bash
node flow-analyze.js --har <pfad/baseline.har> --project <name> --label baseline --url <shop-url>
```

- **`--url` moeglichst immer mitgeben** -- bestimmt die First-Party-Domain sicher (sonst aus HAR geraten, was bei GTM-lastigen HARs danebenliegen kann).
- **Project name:** wie bei tagging-audit aus der URL als `subdomain_domain_tld` ableiten, nicht fragen.
- Ausgabe: `flow-<host>-baseline-<ts>-snapshot.json` (dauerhafte Grundlage), `-report.md`, HAR-Kopie.

### 2. Nachher-Lauf auswerten (nach der Umstellung)

```bash
node flow-analyze.js --har <pfad/nachher.har> --project <name> --label post-change --url <shop-url>
```

Wichtig fuer Vergleichbarkeit: **gleiche Flow-Tiefe** wie die Baseline (gleiche Produktkategorie, bis Adresseingabe). Unterschiedliche Tiefe erzeugt Schein-Deltas (fehlende Checkout-Hosts/Events sind dann Flow-Artefakte, keine Setup-Aenderungen).

### 3. Delta bestimmen

```bash
node flow-delta.js --baseline <baseline-snapshot.json> --current <post-change-snapshot.json> --project <name>
```

Ausgabe: `reports/<project>/delta-<ts>.md`. **Mit Read lesen** und bewertet zusammenfassen.

### 4. Report bewerten -- Checkliste

**PII pro Vendor (Kernstueck):**
- Welcher Vendor bekommt E-Mail/Telefon/Name/Adresse -- und gehasht oder Klartext?
- **NEU/entfallen/geaendert** pro Vendor hervorheben. Neue PII an einen Vendor ist datenschutzrelevant -> immer benennen.
- Achtung Stub: Google Ads `ccm/form-data` mit `em=tv.1` ist ein **Enhanced-Conversions-Stub ohne Wert** (Feld scharf, aber keine PII uebertragen) -- nicht als PII-Send werten.
- Shopify & Co. senden Conversion-PII oft erst beim Kaufabschluss/server-side -> pre-purchase 0 PII ist plausibel, kein Fehler.

**Tracker-Delta:**
- Bekannte Produkte per Library-Key, unbekannte Third-Parties **per Host** verglichen.
- Neue/entfallene Tracker hervorheben -- aber Checkout-stufige Hosts (paypal, pay.google, checkout.*) auf **Flow-Tiefe** pruefen, bevor man eine echte Aenderung behauptet.

**Container / Measurement-IDs / Server-Side:**
- GTM-Container- oder Measurement-ID-Wechsel klar benennen (oft der Kern der Umstellung).
- Test-/Platzhalter-IDs (z.B. `G-12345`), die verschwinden -> als Cleanup vermerken.
- Custom Loader (Stape) neu/weg -> Server-Side-Wechsel.

**Consent (gcs) -- WICHTIG, vorsichtig formulieren:**
- Die Reports melden nur **Fakten**: beobachtete `gcs`-Werte + Zahl der **G100-Pings** (Ping trotz vollstaendigem Deny).
- **Kein Basic/Advanced-Verdict aus gcs ableiten.** Advanced vs. Basic ist eine **zeitliche** Frage (feuern Pings VOR der Consent-Interaktion / trotz denied Defaults?), die ein reiner Request-Snapshot nicht beantwortet.
- `G101`/`G110` sind **Teil-Consent** (z.B. keine Ads-Einwilligung) und im Basic Mode voellig normal -- **kein** Advanced-Indiz.
- Nur wenn das denied-Fenster wirklich aufgezeichnet wurde (Aufnahme ab Erstaufruf, vor Consent-Klick) laesst sich Basic/Advanced beurteilen -- dafuer `flow-recorder.js` mit "Consent erteilt"-Marker.

**Gesamtbewertung:**
- Verlaessliche Befunde (flow-unabhaengig) von Flow-Artefakten trennen.
- Bei identischem Setup: klar sagen "keine relevante Aenderung" -- kein kuenstliches Problem suchen.

### Parameter (Referenz)

| Tool | Parameter | Pflicht | Beschreibung |
|------|-----------|---------|--------------|
| `flow-analyze.js` | `--har` | ja | Pfad zur HAR-Datei |
| | `--project` | ja | Projektname (Report-Pfad) |
| | `--label` | ja | Lauf-Label (`baseline` / `post-change`) |
| | `--url` | nein | Shop-Start-URL (First-Party-Domain) |
| `flow-delta.js` | `--baseline` | ja | Snapshot-JSON Vorher |
| | `--current` | ja | Snapshot-JSON Nachher |
| | `--project` | ja | Projektname |
| `flow-recorder.js` | `--url`/`--project`/`--label` | ja | Live-Aufnahme statt HAR |
| | `--headless` | nein | Ohne sichtbaren Browser |

### Datengrundlage

- PII/Event-Erkennung: vendored Parser unter `pii-lib/` (GA4, Meta, TikTok, Pinterest, Google Ads, Microsoft UET) -- Snapshot aus der separaten Tracking-Auditor-Browser-Extension.
- Vendoren ohne dedizierten Parser (z.B. Awin): Praesenz-Erkennung ueber `tracking-vendors.json`.

## Abgrenzung

- **Zwei URLs synchron vergleichen** -> `tracking-compare` Skill
- **Einzelseiten-Audit** (Consent-Phasen, E-Commerce) -> `tagging-audit` Skill
- **CMP einlernen** -> `cmp-learn` Skill
