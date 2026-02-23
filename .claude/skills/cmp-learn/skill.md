---
name: cmp-learn
description: Use when user wants to learn, add, or teach a new CMP (Consent Management Platform) to the library. Triggers on keywords like CMP einlernen, learn CMP, CMP hinzufuegen, neue CMP, Consent-Banner lernen, CMP-Selektoren. NOT for running audits -- use tagging-audit skill for that.
---

# CMP einlernen

Interaktives Einlernen von Accept- und Reject-Selektoren fuer eine Consent Management Platform (CMP). Die gelernten Selektoren werden in `cmp-library.json` gespeichert und stehen dann fuer alle zukuenftigen Audits zur Verfuegung.

## Toolkit Location

`c:\Users\mbaer\Documents\Dev\tracking-auditor\`

All commands run from this directory.

## Wann diesen Skill nutzen

- User will gezielt eine CMP einlernen (ohne Audit)
- User sagt "lerne diese CMP", "fuege CMP hinzu", "CMP-Selektoren einsammeln"
- NICHT wenn ein Audit gewuenscht ist -- dafuer den **tagging-audit** Skill nutzen
- Hinweis: Waehrend eines Audits kann die CMP auch ueber den manuellen Modus gelernt werden. Dieser Skill ist fuer den Fall, dass man NUR die CMP lernen will.

## Workflow

### 1. Parameter erfragen

**Pflicht:**
- **URL** -- eine Seite, auf der das CMP-Banner erscheint
- **CMP-Name** -- wie die CMP in der Library heissen soll (z.B. "Cookiebot", "Usercentrics v2")

**Optional -- aktiv vorschlagen wenn passend:**
- **Two-Step Reject?** -- Manche CMPs zeigen keinen direkten Reject-Button. Stattdessen: Settings/More -> dann Reject. Wenn der User das beschreibt oder die CMP dafuer bekannt ist, `--two-step-reject` verwenden.

### 2. Library pruefen

Lies `cmp-library.json` und pruefe ob die CMP bereits existiert. Wenn ja: User informieren und fragen ob sie aktualisiert werden soll. Wenn nein: weiter.

### 3. Learn starten

```bash
# Standard (einstufiger Reject)
node learn.js --url https://example.com --cmp "MyCMP"

# Zweistufiger Reject (Settings -> Reject)
node learn.js --url https://example.com --cmp "MyCMP" --two-step-reject
```

**Was passiert:** Ein sichtbarer Browser oeffnet sich. Ein Overlay am unteren Rand fuehrt durch den Prozess:

1. "Klicke den Accept-Button" -> User klickt, Selektor wird erkannt
2. Erkannter Selektor wird zur Bestaetigung angezeigt
3. Bei Shadow DOM: automatischer Fallback auf manuelle Eingabe mit Live-Validierung
4. Browser-Neustart fuer Reject-Button
5. Gleicher Ablauf fuer Reject (bzw. bei `--two-step-reject`: Settings + Reject in einer Session)
6. Selektoren werden in `cmp-library.json` gespeichert

### 4. Ergebnis bestaetigen

Nach Abschluss: `cmp-library.json` lesen und die neuen Selektoren anzeigen. Bestaetigen, dass die CMP jetzt fuer Audits verfuegbar ist.

## Bekannte CMPs mit Two-Step Reject

Diese CMPs brauchen typischerweise `--two-step-reject`:
- Usercentrics v2
- Borlabs Cookie

## Alle Parameter (Referenz)

| Parameter | Beschreibung |
|-----------|-------------|
| `--url` | Seite mit CMP-Banner (Pflicht) |
| `--cmp` | Name fuer die Library (Pflicht) |
| `--two-step-reject` | Zweistufigen Reject einlernen (Settings -> Reject) |
| `--terminal` | Terminal-Modus statt Browser-UI (Legacy, nicht empfohlen) |
