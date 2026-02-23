# Tracking Auditor

Node.js-Toolkit zur automatisierten Analyse von Tracking-Setups auf Websites. Erfasst dataLayer-Events, Netzwerk-Requests, Cookies und localStorage in verschiedenen Consent-Zustaenden und generiert strukturierte Markdown-Reports.

## Voraussetzungen

- **Node.js** (ES Modules)
- **Playwright** mit Chromium

```bash
npm install
npx playwright install chromium
```

## Aufbau

```
audit.js          Automatisierter Audit-Runner (Consent + E-Commerce)
learn.js          CMP-Selektoren einsammeln und in cmp-library.json speichern
cmp-library.json  Datenbank bekannter CMP-Selektoren (accept/reject)
reports/          Ablageort fuer generierte Audit-Reports (lokal, nicht im Repo)
```

## Verwendung

### 1. CMP einlernen

Bevor ein Audit laeuft, muss die Consent Management Platform (CMP) der Zielseite bekannt sein. `learn.js` oeffnet einen sichtbaren Browser und erkennt die Accept/Reject-Selektoren interaktiv:

```bash
node learn.js --url https://example.com --cmp "Usercentrics"
```

**Ablauf:**
1. Browser oeffnet die URL
2. Du klickst den Accept-Button -- das Script erkennt den Selektor automatisch
3. Bei Shadow DOM CMPs (z.B. Usercentrics): automatischer Fallback auf manuelle Eingabe
4. Browser-Neustart, dann Reject-Button
5. Beide Selektoren werden in `cmp-library.json` gespeichert

Die `cmp-library.json` wird mit dem Repo ausgeliefert und enthaelt bereits bekannte CMPs.

### 2. Audit durchfuehren

**Nur Consent-Check:**

```bash
node audit.js --url https://example.com --project mein-projekt
```

**Mit E-Commerce-Pfad:**

```bash
node audit.js \
  --url https://example.com \
  --project mein-projekt \
  --category /kategorie/schuhe \
  --product /produkt/sneaker-xyz \
  --add-to-cart ".add-to-cart-btn" \
  --view-cart /warenkorb \
  --checkout /kasse
```

### Parameter

| Parameter | Pflicht | Beschreibung |
|-----------|---------|-------------|
| `--url` | ja | Startseite URL |
| `--project` | ja | Projektname, bestimmt Report-Pfad |
| `--cmp` | nein | CMP-Name, ueberspringt Auto-Erkennung |
| `--disable-sw` | nein | Service Worker deregistrieren |
| `--category` | nein | Kategorie-URL (aktiviert E-Commerce-Pfad) |
| `--product` | nein | Produkt-URL |
| `--add-to-cart` | nein | CSS-Selektor fuer Add-to-Cart-Button |
| `--view-cart` | nein | Warenkorb-URL |
| `--checkout` | nein | Checkout-URL |

## Audit-Phasen

Der Audit durchlaeuft folgende Phasen:

1. **CMP-Erkennung** -- Prueft alle Selektoren aus `cmp-library.json` gegen die Seite
2. **Pre-Consent** -- dataLayer, Third-Party-Requests, Consent Mode (gcs/gcd), Cookies, localStorage
3. **Post-Accept** -- CMP Accept klicken, Diffs gegenueber Pre-Consent erfassen
4. **E-Commerce** (optional) -- Pro Schritt: Navigation/Klick + dataLayer + Requests + Cookie/localStorage-Diff
5. **Post-Reject** -- Komplett neuer Browser, Reject klicken, Diffs erfassen
6. **Report** -- Markdown-Ausgabe nach `reports/<project>/audit-<YYYY-MM-DD>.md`

## Report-Inhalte

Der generierte Report enthaelt:

- **Zusammenfassung** -- Tracker-Uebersicht ueber alle Consent-Phasen, Consent Mode Status
- **Pre-Consent** -- Tracking vor jeglicher Consent-Entscheidung (Verstoesse sofort erkennbar)
- **Post-Accept / Post-Reject** -- Diffs bei Cookies, localStorage, Requests, dataLayer
- **E-Commerce-Pfad** -- dataLayer-Events und Tracker pro Schritt (Kategorie bis Checkout)
- **Produktdaten-Analyse** -- Format-Erkennung (GA4/UA/Proprietary), Konsistenz-Check ueber alle E-Commerce-Schritte, fehlende Events

## Tracking-Domain-Klassifizierung

Bekannte Tracker werden automatisch zugeordnet: Google, Meta, TikTok, Pinterest, LinkedIn, Microsoft, Criteo, Taboola, Outbrain, Hotjar. Alles andere wird als "Sonstige Third-Party" gefuehrt.

## Hinweise

- Der Browser laeuft immer sichtbar (`headless: false`)
- Der Reject-Durchlauf nutzt einen komplett separaten Browser-Prozess
- Service Worker koennen dazu fuehren, dass Requests nicht erfasst werden (gtag nutzt SW wenn verfuegbar). Mit `--disable-sw` werden sie deregistriert
- Auf Windows mit Git Bash werden relative URL-Pfade (z.B. `/kategorie/`) manchmal zu lokalen Pfaden umgeschrieben. Das Script erkennt und korrigiert das automatisch, alternativ volle URLs verwenden oder `MSYS_NO_PATHCONV=1` setzen
