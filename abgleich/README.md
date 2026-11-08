# Abgleich der Dienst-Erkennung
Vier öffentliche Werkzeuge erkennen dieselben Tracking-Dienste, jedes mit eigenem Code. Ohne regelmäßigen Abgleich driften sie auseinander: Ein Werkzeug lernt eine neue Request-Variante, die anderen übersehen sie weiter. Diese Seite beschreibt, welches Werkzeug wofür die Quelle ist, und wie ein Skript den Stand prüft.

| Werkzeug | Repo | Wo die Dienste stehen |
|---|---|---|
| Tracking Auditor | [tracking-auditor](https://github.com/mbaersch/tracking-auditor) | `tracking-vendors.json` (Endpunkte), `lib/tracking-classify.js` (First-Party, Stape, TAGGRS, Data Client), `pii-lib/` (Parser) |
| Tracking Auditor Extension | [tracking-auditor-extension](https://github.com/mbaersch/tracking-auditor-extension) | `lib/*.js` (Parser je Dienst) |
| EC Data Validator | [ec-data-validator](https://github.com/mbaersch/ec-data-validator) | `detectors.js` (Detektoren), `background.js` (Google-Pfad, Listener-Muster) |
| Stage in a Box | [stage-in-a-box](https://github.com/mbaersch/stage-in-a-box) | `STANDARD_DIENSTE` in `lib/stage.ts` (Regeln), `lib/dienstprofile.ts` (Klick-IDs, Conversion-Felder) |

## Wer ist Quelle wofür
- **Request-Formate und Feldnamen:** die Parser der Extension (`lib/*.js`). `pii-lib/` im Auditor ist eine unveränderte Kopie davon, nur `pii-lib/index.js` ist eigen. Änderungen immer in der Extension machen und dann kopieren.
- **Endpunkte für die Klassifikation im Report:** `tracking-vendors.json`. Neue Pfade aus den Parsern hier nachziehen.
- **EC Data Validator:** eine angepasste Portierung, keine Kopie. Er kennt nur Dienste mit Nutzerdaten-Bezug und sieht nur Requests, für die er ein Listener-Muster hat.
- **Klick-IDs (Ablage, Parameter im Request):** die Profile der Stage. Dort steht nur, was an einer echten Website belegt ist.
- **Stage-Regeln:** steuern Requests (abfangen, blockieren, verzögern). Fehlt eine Regel, geht ein Request auch im Modus „abfangen“ echt raus; Begleit-Requests bekommen deshalb eine Regel, die nicht protokolliert.

## Absicht gegen Lücke
Werkzeuge lassen Varianten zum Teil absichtlich aus, um Rauschen zu vermeiden, zum Beispiel TikTok `pixel/act` oder `ccm/s/collect` im Parser. Eine fehlende Erkennung ist erst eine Lücke, wenn weder Code noch Kommentar noch Test eine Absicht zeigen. Absichten stehen mit Begründung in `abgleich/erwartet.json` und erscheinen in der Ausgabe als „– (Absicht)“.

Transportformate wie der Stape Data Client sind keine Dienste. Sie werden höchstens als Hinweis gemeldet. JSON Client und walkerOS werden nicht erkannt: Ihr Format ist frei wählbar, eine Erkennung bliebe lückenhaft.

## Prüfen
```sh
npm run abgleich -- --extension <klon der extension> --validator <klon des validators> --stage <klon der stage>
```
Das Skript schickt jeden Request aus `abgleich/referenz-requests.json` durch alle Werkzeuge und vergleicht mit `abgleich/erwartet.json`:

| Spalte | Was geprüft wird |
|---|---|
| `auditor` | `tracking-vendors.json` über `matchRequest`, dazu First-Party- und Stape-Tunnel-Erkennung |
| `parser` | `pii-lib` (= Parser der Extension), Data Client als Hinweis |
| `validator` | `background.js` und `detectors.js` in einer Node-vm, alle Detektoren an; nur Requests, die die Listener-Muster durchlassen |
| `stage` | die erste passende Regel aus `STANDARD_DIENSTE`; `*` = Regel steuert, protokolliert aber nicht |

Zusätzlich vergleicht es `pii-lib/` mit `lib/` der Extension. Fehlt ein Pfad, fehlt die Spalte. Exit-Code 1 bei jeder Abweichung.

## Pflegen
- **Neue Variante entdeckt** (Pfad, Body-Format, Kodierung): einen Referenz-Request in `abgleich/referenz-requests.json` ergänzen, mit der Form des echten Requests, aber `example.com`, Test-IDs und Platzhalter-Hashes. Dann den Erwartungswert je Werkzeug in `abgleich/erwartet.json` eintragen, absichtliche Lücken mit `grund`.
- **Werkzeug geändert:** Skript laufen lassen. Eine neue Abweichung ist entweder eine Lücke (in den anderen Werkzeugen nachziehen) oder eine gewollte Änderung (Erwartung anpassen).
- **Parser in der Extension geändert:** nach `pii-lib/` kopieren; das Skript meldet sonst die Abweichung.
- Keine echten Kunden-Domains, Konto-IDs oder Nutzerdaten in die Referenz-Requests.
