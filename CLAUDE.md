# Tagging Audit Toolkit

Dieses Projekt ist ein Node.js-basiertes Toolkit zur Unterstützung von Tag-Audits auf Kundenwebsites. Es automatisiert die Erhebung von dataLayer-Ereignissen, Netzwerk-Requests und Consent-Verhalten und dokumentiert die Ergebnisse als Markdown-Report.

## Dateien

```
learn.js          – CMP-Selektoren einsammeln und in cmp-library.json speichern
audit.js          – automatisierter Audit-Runner (Consent + E-Commerce)
cmp-library.json  – Datenbank bekannter CMP-Selektoren (accept/reject)
reports/          – Ablageort für Audit-Markdown-Reports (nach Projekt strukturieren)
```

## Abhängigkeiten

- Node.js (ES Modules, `"type": "module"` in package.json)
- Playwright (`npm install playwright` lokal im Projektordner, global funktioniert unter Windows nicht zuverlässig mit ES Modules)
- Playwright-Browser: `npx playwright install chromium`

## learn.js

Sammelt Accept- und Reject-Selektoren für eine CMP ein und schreibt sie in `cmp-library.json`.

```bash
node learn.js --url https://example.com --cmp "Usercentrics"
```

Bei CMPs mit zweistufigem Reject (Settings → Reject):
```bash
node learn.js --url https://example.com --cmp "Borlabs Cookie" --two-step-reject
```

**Parameter:**
- `--url` (Pflicht) – Ziel-URL
- `--cmp` (Pflicht) – CMP-Name für die Library
- `--two-step-reject` – Zweistufigen Reject-Ablauf einlernen (Settings → Reject)

**Ablauf:**
1. Browser öffnet die URL (sichtbar, headless: false)
2. Du klickst den Accept-Button – Script erkennt Selektor automatisch
3. Bei Shadow DOM CMPs (z.B. Usercentrics): Klick landet auf Host-div, Script erkennt das, lädt die Seite neu und fordert manuelle Selector-Eingabe
4. Playwright verifiziert den eingegebenen Selektor (Shadow DOM-aware via `page.locator()`)
5. Browser-Neustart (kompletter Prozess, nicht nur Context) für den Reject-Button
6. Bei `--two-step-reject`: `learnTwoStepReject()` lernt Schritt 1 (Settings/More) und Schritt 2 (Reject) in einer Browser-Session (kein Reload zwischen Schritten, da die zweite Ebene sonst verschwindet). Speichert `reject` = Schritt-2-Selektor und `rejectSteps` = [Schritt 1, Schritt 2].
7. Beide Selektoren werden in `cmp-library.json` gespeichert

**Shadow DOM Handling:**
- Klick-Listener läuft im normalen document, erreicht Shadow DOM nicht
- Erkennung: `e.target` ist ein div/span statt button → automatischer Fallback
- Nutzer kann per Enter auch manuell in den Fallback-Modus wechseln
- Nach Erkennung: Seite wird neu geladen damit das Banner wieder sichtbar ist
- Manuelle Eingabe wird via `page.locator()` gegen die lebende Seite verifiziert

**cmp-library.json Format:**
```json
{
  "usercentrics-v2": {
    "name": "Usercentrics v2",
    "accept": "[data-action=\"consent\"][data-action-type=\"accept\"]",
    "reject": "[data-action=\"consent\"][data-action-type=\"deny\"]",
    "rejectSteps": [
      "[data-action=\"consent\"][data-action-type=\"more\"]",
      "[data-action=\"consent\"][data-action-type=\"deny\"]"
    ],
    "detect": ["#usercentrics-cmp-ui", "#usercentrics-root"],
    "shadowDom": true,
    "learnedAt": "2026-02-23T01:15:00.000Z"
  }
}
```

**Felder:**
- `accept`, `reject` – Pflichtfelder, direkte Selektoren
- `rejectSteps` – Optional. Array mit Selektoren für mehrstufigen Reject (z.B. [Settings-Button, Deny-Button]). `audit.js` versucht zuerst direkten Reject, fällt bei Fehlschlag auf die Steps zurück.
- `detect` – Optional. Array mit CSS-Selektoren für das CMP-Wrapper-/Host-Element (nicht die Buttons). Wird zur Disambiguierung genutzt wenn mehrere CMPs auf den Accept-Selektor matchen.
- `shadowDom` – Flag für Shadow DOM CMPs; steuert ob `page.locator()` oder direktes DOM-Klicken verwendet wird
- `learnedAt` – ISO-Timestamp des letzten Einlernens

**Bekannte Eigenheiten:**
- Usercentrics ist sehr persistent – Browser-Neustart zwischen Accept und Reject ist zwingend, Context-Reset reicht nicht
- Das `shadowDom`-Flag in der Library wird von `audit.js` genutzt um zu entscheiden ob `page.locator()` oder direktes DOM-Klicken verwendet wird
- Selektor-Priorität: ID > stable data-attrs (data-testid, data-id, data-action, data-cy, data-qa...) > Klassen

## audit.js

Automatisierter Tagging-Audit-Runner. Erfasst dataLayer, Netzwerk-Requests, Cookies und localStorage in verschiedenen Consent-Zuständen und generiert einen Markdown-Report.

**Nur Consent-Check:**
```bash
node audit.js --url https://example.com --project kunde-xyz
```

**Mit E-Commerce-Pfad:**
```bash
node audit.js \
  --url https://example.com \
  --project kunde-xyz \
  --category /kategorie/schuhe \
  --product /produkt/sneaker-xyz \
  --add-to-cart ".add-to-cart-btn" \
  --view-cart /warenkorb \
  --checkout /kasse
```

**Alle Parameter:**
- `--url` (Pflicht) – Startseite URL
- `--project` (Pflicht) – Projektname, bestimmt Report-Ablageort
- `--cmp` – CMP-Name, überspringt Auto-Erkennung (z.B. "Cookiebot")
- `--disable-sw` – Service Worker deregistrieren, damit alle Requests erfasst werden
- `--category` – Kategorie-URL (aktiviert E-Commerce-Pfad)
- `--product` – Produkt-URL
- `--add-to-cart` – CSS-Selektor für Add-to-Cart-Button
- `--view-cart` – Warenkorb-URL (optional)
- `--checkout` – Checkout-URL (optional)

**Ablauf:**
1. **CMP-Erkennung** – Zwei Durchläufe: erster Pass prüft alle Selektoren aus `cmp-library.json`. Kein Treffer: scrollt 400px nach unten, wartet 2s, zweiter Pass (manche CMPs wie Borlabs zeigen Banner erst nach Scroll). Mehrere Treffer: `disambiguateCMP()` prüft `detect`-Selektoren jedes Treffers; erste CMP mit passendem detect-Selektor gewinnt, sonst erster Treffer mit Warnung. Kein Treffer gesamt: Exit mit Hinweis auf `learn.js`. `--cmp` überspringt die Erkennung.
2. **Pre-Consent** – dataLayer-Snapshot, Third-Party-Requests klassifizieren (bekannte Tracker vs. sonstige), Consent Mode Parameter (gcs/gcd), Cookies, localStorage, Service Worker prüfen
3. **Post-Accept** – CMP Accept klicken, Diffs erfassen (dataLayer, Requests, Cookies, localStorage, Consent Mode)
4. **E-Commerce** (nur wenn `--category`) – Pro Schritt (Kategorie, PDP, Add to Cart, View Cart, Checkout): Navigation/Klick + dataLayer + Requests + Cookie/localStorage-Diff
5. **Post-Reject** – Komplett neuer Browser, Startseite. CMP-Banner suchen mit Scroll-Retry (konsistent mit Phase 0). Reject klicken: zuerst direkter Reject-Selektor (5s Timeout), bei Fehlschlag und vorhandenem `rejectSteps` (2 Einträge): rejectSteps[0] klicken, 2s warten, rejectSteps[1] klicken. Diffs erfassen. Kein E-Commerce-Pfad nach Reject.
6. **Markdown-Report** – Strukturierte Ausgabe nach `reports/<project>/audit-<YYYY-MM-DD>.md`

**Tracking-Domain-Klassifizierung:**
Bekannte Tracker (Google, Meta, TikTok, Pinterest, LinkedIn, Microsoft, Criteo, Taboola, Outbrain, Hotjar) werden mit Vendor-Name zugeordnet. Alles was nicht zur Site-Domain gehört und nicht in der Liste steht: "Sonstige Third-Party".

**Service Worker:**
- Default: Erkennung + Hinweis im Report (gtag nutzt Service Worker wenn verfügbar, Requests laufen dann nicht durch `page.on('request')`)
- `--disable-sw`: Deregistrierung via `page.evaluate()`, damit alle Requests erfasst werden

**Bekannte Eigenheiten:**
- Browser immer `headless: false` – wir müssen sehen was passiert
- Reject-Durchlauf: komplett separater Browser-Start (nicht nur Context)
- dataLayer wird immer frisch via `page.evaluate()` abgefragt
- CMP-Klick via `page.locator()` (Shadow DOM-aware)
- Bei Auto-Erkennung wird ein zusätzlicher Browser gestartet und nach Erkennung wieder geschlossen
- Disambiguierung greift nur wenn mehrere CMPs auf denselben Accept-Selektor matchen; `detect`-Felder in der Library verbessern die Treffsicherheit
- Zweistufiger Reject (`rejectSteps`) wird nur ausgeführt wenn der direkte Reject-Selektor nach 5s nicht gefunden wurde