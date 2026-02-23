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
browser-ui.js     Browser-Overlay-Komponenten (Dialoge, Status Bar, Click-Prompts)
cmp-library.json  Datenbank bekannter CMP-Selektoren (accept/reject, ~40 CMPs)
reports/          Ablageort fuer generierte Audit-Reports (lokal, nicht im Repo)
```

## Verwendung

### 1. CMP einlernen

Bevor ein Audit laeuft, muss die Consent Management Platform (CMP) der Zielseite bekannt sein. `learn.js` oeffnet einen sichtbaren Browser und erkennt die Accept/Reject-Selektoren interaktiv:

```bash
node learn.js --url https://example.com --cmp "Usercentrics"
```

Bei CMPs mit zweistufigem Reject (Settings -> Reject):

```bash
node learn.js --url https://example.com --cmp "Borlabs Cookie" --two-step-reject
```

**Ablauf:**
1. Browser oeffnet die URL
2. Ein Overlay am unteren Rand zeigt Anweisungen -- du klickst den Accept-Button auf der Seite
3. Das Script erkennt den Selektor automatisch und zeigt ihn zur Bestaetigung an
4. Bei Shadow DOM CMPs: automatischer Fallback auf manuelle Selektor-Eingabe mit Live-Validierung
5. Browser-Neustart, dann Reject-Button
6. Beide Selektoren werden in `cmp-library.json` gespeichert

Die Interaktion findet komplett im Browser-Overlay statt. Mit `--terminal` kann auf den alten readline-Modus gewechselt werden.

### 2. Audit durchfuehren

**Nur Consent-Check:**

```bash
node audit.js --url https://example.com --project mein-projekt
```

**E-Commerce automatisch (URLs/Selektoren vorab bekannt):**

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

**E-Commerce interaktiv (ohne Vorbereitung):**

```bash
node audit.js --url https://example.com --project mein-projekt --ecom
```

Im interaktiven Modus navigierst du selbst durch den Shop. Eine schwebende Card fuehrt durch 5 Schritte (Kategorie, PDP, Add-to-Cart, Warenkorb, Checkout). Jeder Schritt ist per "Audit abschliessen" ueberspringbar -- es wird ausgewertet was erhoben wurde.

### Parameter

| Parameter | Pflicht | Beschreibung |
|-----------|---------|-------------|
| `--url` | ja | Startseite URL |
| `--project` | ja | Projektname, bestimmt Report-Pfad |
| `--cmp` | nein | CMP-Name, ueberspringt Auto-Erkennung |
| `--disable-sw` | nein | Service Worker deregistrieren |
| `--ecom` | nein | Interaktiver E-Commerce-Modus (manuell navigieren) |
| `--category` | nein | Kategorie-URL (aktiviert automatischen E-Commerce-Pfad) |
| `--product` | nein | Produkt-URL |
| `--add-to-cart` | nein | CSS-Selektor fuer Add-to-Cart-Button |
| `--view-cart` | nein | Warenkorb-URL |
| `--checkout` | nein | Checkout-URL |

## Audit-Phasen

Eine rote Status Bar im Browser zeigt den aktuellen Fortschritt in Echtzeit.

1. **CMP-Erkennung** -- Prueft alle Selektoren aus `cmp-library.json` nach Prioritaet (haeufigste CMPs zuerst). Waehrend der Auto-Erkennung kann per Dropdown eine CMP aus der Liste gewaehlt oder in den manuellen Modus gewechselt werden.
2. **Pre-Consent** -- dataLayer, Third-Party-Requests, Consent Mode (gcs/gcd), Cookies, localStorage, SST-Erkennung
3. **Post-Accept** -- CMP Accept klicken, Diffs gegenueber Pre-Consent erfassen
4. **E-Commerce** (optional) -- Automatisch (`--category`) oder interaktiv (`--ecom`). Pro Schritt: dataLayer + Requests + Consent Mode + Cookie/localStorage-Diff
5. **Post-Reject** -- Komplett neuer Browser, Reject klicken, Diffs erfassen
6. **Report** -- Markdown-Ausgabe nach `reports/<project>/audit-<YYYY-MM-DD-HHMM>.md`

### Manueller Modus

Wenn die CMP-Auto-Erkennung fehlschlaegt oder per Skip-Button uebersprungen wird, aktiviert sich der manuelle Modus:

1. Browser-Overlay fordert zum Klick auf Accept-Button auf
2. Erkannter Selektor wird zur Bestaetigung angezeigt (oder manuelle Eingabe)
3. Seite wird neu geladen fuer den Reject-Button
4. Selektoren werden gegen die Library abgeglichen -- bei Match kann das bestehende CMP verwendet werden
5. Ansonsten: neues CMP benennen und in `cmp-library.json` speichern
6. Audit laeuft mit den neuen Selektoren weiter

Der manuelle Modus wird maximal einmal pro Audit ausgeloest.

## Report-Inhalte

Der generierte Report enthaelt:

- **Zusammenfassung** -- Tracker-Uebersicht ueber alle Consent-Phasen, Consent Mode Status
- **Consent Mode Verification** -- Prueft ob nach Accept ein gcs-Update erfolgt (G100 -> G1xx). Zeigt Advanced vs. Basic Consent Mode Diagnose mit Erklaerung
- **Pre-Consent** -- Tracking vor jeglicher Consent-Entscheidung (Verstoesse sofort erkennbar)
- **Post-Accept / Post-Reject** -- Diffs bei Cookies, localStorage, Requests, dataLayer
- **Server-Side Tagging** -- Erkennung von Custom GTM/gtag-Loadern und First-Party Collect Endpoints
- **E-Commerce-Pfad** -- dataLayer-Events und Tracker pro Schritt (Kategorie bis Checkout), inkl. Consent Mode Status pro Step
- **Produktdaten-Analyse** -- Format-Erkennung (GA4/UA/Proprietary), Konsistenz-Check ueber alle E-Commerce-Schritte, fehlende Events

## Browser-UI

Alle interaktiven Elemente (Dialoge, Click-Prompts, Selektor-Eingabe) werden als Browser-Overlays direkt auf der Zielseite angezeigt:

- **Dialoge** sind per Drag verschiebbar, falls sie CMP-Banner verdecken
- **Click-Prompts** erscheinen als schwebende Card am unteren Rand ohne die Seite zu verdecken
- **E-Commerce-Prompts** fuehren durch die interaktiven Schritte; sie ueberleben Seitennavigation (automatische Re-Injection)
- **Status Bar** zeigt Phase, Fortschritt und CMP-Auswahl-Dropdown waehrend der Erkennung
- CSS ist gegen globale Resets gehaertet (funktioniert auf jeder Seite)

## Interaktiver E-Commerce-Modus

Mit `--ecom` laeuft der E-Commerce-Pfad ohne Vorbereitung. Du navigierst selbst, das Tool sammelt die Daten:

| Schritt | Typ | Ablauf |
|---------|-----|--------|
| Kategorie-Seite | Navigate | Zur Kategorieseite surfen, "Schritt abschliessen" klicken |
| Produkt-Seite | Navigate | Zur PDP surfen, "Schritt abschliessen" klicken |
| Add-to-Cart | Click | "Bereit" klicken, dann den Warenkorb-Button auf der Seite -- der Klick wird automatisch erkannt |
| Warenkorb | Navigate | Zum Warenkorb surfen, "Schritt abschliessen" klicken |
| Checkout | Navigate | Zum Checkout surfen, "Schritt abschliessen" klicken |

**Add-to-Cart Besonderheiten:**
- Nach "Bereit" startet der Request-Collector und ein dataLayer-Monkey-Patch
- Der naechste Klick auf der Seite wird automatisch als Add-to-Cart erkannt
- Falls der Klick eine Navigation ausloest (z.B. Redirect zum Warenkorb), werden dataLayer-Events von _beiden_ Seiten erfasst: die Events vor der Navigation (per Monkey-Patch + `exposeFunction`) und die Events auf der neuen Seite

Jeder Schritt ist per "Audit abschliessen" ueberspringbar. Der Report enthaelt nur die Schritte, die tatsaechlich durchlaufen wurden.

## Tracking-Domain-Klassifizierung

Bekannte Tracker werden automatisch zugeordnet: Google, Meta, TikTok, Pinterest, LinkedIn, Microsoft, Criteo, Taboola, Outbrain, Hotjar. Alles andere wird als "Sonstige Third-Party" gefuehrt.

## Hinweise

- Der Browser laeuft immer sichtbar (`headless: false`)
- Der Reject-Durchlauf nutzt einen komplett separaten Browser-Prozess
- Service Worker koennen dazu fuehren, dass Requests nicht erfasst werden (gtag nutzt SW wenn verfuegbar). Mit `--disable-sw` werden sie deregistriert
- Auf Windows mit Git Bash werden relative URL-Pfade (z.B. `/kategorie/`) manchmal zu lokalen Pfaden umgeschrieben. Das Script erkennt und korrigiert das automatisch, alternativ volle URLs verwenden oder `MSYS_NO_PATHCONV=1` setzen
