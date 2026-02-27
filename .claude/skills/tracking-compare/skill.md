---
name: tracking-compare
description: Use when user wants to compare tracking setups between two URLs (e.g., live vs. staging, standard GTM vs. sGTM custom loader). Triggers on keywords like compare tracking, vergleich, live vs staging, sGTM test, setup vergleich, vorher nachher, diff tracking. NOT for auditing a single page -- use tagging-audit skill for that.
---

# Tracking-Vergleich

Deterministischer Vergleich von Tracking-Setups auf zwei URLs. Erfasst Netzwerk-Requests pre- und post-consent, erkennt Vendoren, SST/Custom Loader, Container-IDs und erstellt einen Diff-Report mit HAR-Export.

## Toolkit Location

All commands run from the **repository root** (where `compare.js` lives).

## Workflow

### 1. URLs erfragen

Zwei URLs werden benoetigt. Typische Szenarien:

- **Live vs. Staging:** Gleiche Domain, unterschiedliche Pfade oder Subdomains
- **Standard GTM vs. sGTM:** Gleiche Seite mit unterschiedlichem Loader
- **Vorher vs. Nachher:** Gleiche URL, aber Setup-Aenderung dazwischen

### 2. Vergleich starten

```bash
node compare.js --url-a <url-a> --url-b <url-b> --project <name> [--label-a "Live"] [--label-b "Staging"]
```

**Project name:** Automatisch aus URL ableiten als `subdomain_domain_tld` (wie bei tagging-audit). Nicht fragen.

**Labels:** Wenn der User die Seiten benennt (z.B. "Live" und "sGTM"), als `--label-a` / `--label-b` uebergeben. Sonst weglassen (Default: Hostname).

### 3. Browser-Interaktion

Der Browser oeffnet sich mit **einem Fenster** (sequenziell, nicht parallel):

1. **Seite A** laedt. Button startet deaktiviert ("Seite laedt...") und wird erst nach dem load-Event + 3s Offset freigeschaltet. User gibt Consent manuell, klickt "Consent gegeben" in der Floating Card.
2. Nach Post-Consent-Wartezeit schliesst sich Seite A.
3. **Seite B** laedt. Gleicher Ablauf.
4. Browser schliesst sich, Analyse startet.

Wichtig: Jede Seite hat ihren eigenen isolierten Browser-Kontext (kein Cookie-Sharing).

### 4. Report auswerten

Report liegt unter `reports/<project>/compare-<host>-<timestamp>.md`. Daneben zwei HAR-Files fuer Nachanalysen. **Lies den Report mit dem Read-Tool** und erstelle eine bewertete Zusammenfassung.

#### Checkliste (in dieser Reihenfolge durchgehen)

**Tracking-Produkte (Datenquelle: `tracking-vendors.json`):**
- Reports zeigen jetzt Produkt-Level Detail: z.B. "Google Analytics 4 [analytics]", "Google Ads [advertising]" statt nur "Google"
- Spalten: Produkt, Kategorie, Request-Typen (pageview/conversion/event) und Richtung (script/request)
- Identische Produkte auf beiden Seiten -> OK, kurz erwaehnen
- Exklusive Produkte (nur auf einer Seite) -> **Hervorheben.** Fehlendes Produkt auf Staging = potentiell nicht migriert. Neues Produkt auf Staging = neue Integration, bewusst pruefen
- Unterschiedliche Request-Typen (z.B. A hat Conversions, B nicht) -> **Hervorheben**

**Container- und Measurement-IDs:**
- Identisch -> erwartbar bei gleichem GTM-Container
- Abweichend -> **Hervorheben.** Verschiedene Container = verschiedene Konfigurationen, verschiedene Measurement-IDs = verschiedene GA4-Properties. Beides kann gewollt sein (Test-Property), muss aber explizit benannt werden

**SST / Custom Loader:**
- Das ist oft der Kern des Vergleichs (Standard GTM vs. sGTM/Stape). Klar benennen:
  - Welche Seite laedt GTM/gtag von `www.googletagmanager.com` (Standard)?
  - Welche Seite nutzt einen Custom Loader (Stape First-Party-Domain)?
  - Werden die gleichen Container-IDs ueber den Custom Loader geladen?
  - Stape Transport-URLs dekodiert -> welche Google-Endpoints werden proxied?

**Pre-Consent Verhalten:**
- Gleiche Tracker pre-consent auf beiden Seiten -> konsistentes Setup
- Unterschiedliche Tracker pre-consent -> **Hervorheben.** Typisches Problem: Staging feuert mehr/weniger vor Consent als Live. Kann auf unterschiedliche Consent-Mode-Konfiguration oder fehlende CMP-Integration hindeuten

**Consent Mode Flags (gcs/gcd):**
- Sind auf beiden Seiten Consent Mode Signale vorhanden?
- **Advanced vs. Basic Consent Mode:** Advanced sendet Pings mit denied-Status (gcs=G100), Basic blockiert Requests komplett bis Consent. Wenn eine Seite Advanced und die andere Basic nutzt, ist das ein wesentlicher Unterschied
- Unterschiedliche Flag-Werte nach Accept -> verschiedene Consent-Kategorien aktiv, deutet auf abweichende CMP-Konfiguration oder GTM-Trigger hin
- gcs-Update nach Accept vorhanden (G100 -> G1xx) vs. nicht vorhanden -> **Hervorheben**

**Gesamtbewertung:**
- Kurzes Fazit: Ist das Staging-Setup bereit fuer Live? Was muss noch geprueft/korrigiert werden?
- Bei identischen Ergebnissen: "Setups sind funktional identisch" -- kein kuenstliches Problem suchen

### Parameter (Referenz)

| Parameter | Pflicht | Default | Beschreibung |
|-----------|---------|---------|--------------|
| `--url-a` | ja | - | Erste URL (Referenz/Live) |
| `--url-b` | ja | - | Zweite URL (Staging/Test) |
| `--project` | ja | - | Projektname |
| `--label-a` | nein | Host A | Anzeigename Seite A |
| `--label-b` | nein | Host B | Anzeigename Seite B |
| `--post-consent-wait` | nein | 5000 | Wartezeit nach Consent in ms |

### Output

```
reports/<project>/compare-<host_domain_tld>-<YYYY-MM-DD-HHmmss>.md
reports/<project>/compare-<host_domain_tld>-<YYYY-MM-DD-HHmmss>-a.har
reports/<project>/compare-<host_domain_tld>-<YYYY-MM-DD-HHmmss>-b.har
```

## Abgrenzung

- **Einzelseiten-Audit** (Consent-Phasen, E-Commerce, Deep Analysis) -> `tagging-audit` Skill
- **CMP einlernen** -> `cmp-learn` Skill
- **Setup-Vergleich zweier URLs** -> dieser Skill
