---
name: cmp-learn
description: Use when user wants to learn, add, or teach a new CMP (Consent Management Platform) to the library. Triggers on keywords like CMP einlernen, learn CMP, CMP hinzufuegen, neue CMP, Consent-Banner lernen, CMP-Selektoren. NOT for running audits -- use tagging-audit skill for that.
---

# CMP einlernen

Interaktives Einlernen von Accept-, Reject- und Detect-Selektoren fuer eine Consent Management Platform (CMP). Die gelernten Selektoren werden in `cmp-library.json` gespeichert und stehen dann fuer alle zukuenftigen Audits zur Verfuegung.

## Toolkit Location

`c:\Users\mbaer\Documents\Dev\tracking-auditor\`

All commands run from this directory.

## Wann diesen Skill nutzen

- User will gezielt eine CMP einlernen (ohne Audit)
- User sagt "lerne diese CMP", "fuege CMP hinzu", "CMP-Selektoren einsammeln"
- NICHT wenn ein Audit gewuenscht ist -- dafuer den **tagging-audit** Skill nutzen
- Audits lernen keine CMPs mehr -- der manuelle Modus zeigt nur eine Consent Card. Diesen Skill nutzen um CMPs VOR dem Audit einzulernen.

## Workflow

### 1. Parameter erfragen

**Pflicht:**
- **URL** -- eine Seite, auf der das CMP-Banner erscheint

**Optional:**
- **CMP-Name** -- kann via `--cmp` angegeben werden; wird sonst am Ende im Browser oder Terminal abgefragt
- **Two-Step Reject** -- wird bei Shadow DOM CMPs interaktiv erfragt ("Ist der Ablehnen-Button direkt sichtbar?"). `--two-step-reject` nur als CLI-Override noetig.

### 2. Learn starten

```bash
# Standard: nur URL, alles andere wird interaktiv erfragt
node learn.js --url https://example.com

# Mit vorgegebenem CMP-Namen
node learn.js --url https://example.com --cmp "MyCMP"

# CLI-Override fuer Two-Step (selten noetig, wird normalerweise interaktiv erkannt)
node learn.js --url https://example.com --two-step-reject
```

**Was passiert:** Ein sichtbarer Browser oeffnet sich und fuehrt interaktiv durch den Prozess:

1. **Accept lernen:** Schwebende Card am unteren Rand -> User klickt Accept-Button -> Selektor wird erkannt und zur Bestaetigung angezeigt
2. **Shadow DOM:** Falls der Klick auf ein nicht-interaktives Element trifft, erscheint eine schwebende Hint-Card (kein Overlay). Die Seite bleibt fuer DevTools zugaenglich. User sucht den Selektor, klickt "Bereit", gibt ihn ein und er wird live validiert.
3. **Reject lernen:** Frischer Browser-Kontext. Bei Shadow DOM wird gefragt ob der Reject-Button direkt sichtbar ist oder ein Zwischenschritt noetig ist (Two-Step). Beim normalen Flow wird der Klick erfasst wie bei Accept.
4. **Library-Matching:** Gelernte Selektoren werden gegen bestehende Library-Eintraege geprueft (Substring-Matching). Bei Match: User kann den existierenden Eintrag wiederverwenden (fertig) oder ein neues CMP anlegen.
5. **Detect-Selektoren:** Automatischer Vorschlag von Container-IDs (z.B. `#usercentrics-root`, `#CybotCookiebotDialog`) aus der DOM-Umgebung. User kann bestaetigen, anpassen oder ueberspringen. Detect-Selektoren ermoeglichen Auto-Erkennung im Audit ohne `--cmp`.
6. **CMP-Name:** Falls nicht via `--cmp` angegeben, wird der Name im Browser-Overlay oder Terminal abgefragt.
7. **Speichern:** Alle Selektoren (accept, reject, rejectSteps, detect) werden in `cmp-library.json` gespeichert.

### 3. Ergebnis bestaetigen

Nach Abschluss: `cmp-library.json` lesen und die neuen Selektoren anzeigen. Bestaetigen, dass die CMP jetzt fuer Audits verfuegbar ist.

## Alle Parameter (Referenz)

| Parameter | Beschreibung |
|-----------|-------------|
| `--url` | Seite mit CMP-Banner (Pflicht) |
| `--cmp` | Name fuer die Library (optional, wird sonst interaktiv abgefragt) |
| `--two-step-reject` | CLI-Override: Zweistufigen Reject erzwingen (wird bei Shadow DOM automatisch erfragt) |
| `--terminal` | Terminal-Modus statt Browser-UI (Legacy, nicht empfohlen) |
