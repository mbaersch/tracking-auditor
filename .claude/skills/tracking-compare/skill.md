---
name: tracking-compare
description: Use when user wants to compare tracking setups between two URLs (e.g., live vs. staging, standard GTM vs. sGTM custom loader). Triggers on keywords like compare tracking, vergleich, live vs staging, sGTM test, setup vergleich, vorher nachher, diff tracking. NOT for auditing a single page -- use tagging-audit skill for that.
---

# Tracking-Vergleich

Deterministischer Vergleich von Tracking-Setups auf zwei URLs. Erfasst Netzwerk-Requests pre- und post-consent, erkennt Vendoren, SST/Custom Loader, Container-IDs und erstellt einen Diff-Report mit HAR-Export.

## Toolkit Location

`c:\Users\mbaer\Documents\Dev\tracking-auditor\`

All commands run from this directory.

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

1. **Seite A** laedt. User gibt Consent manuell, klickt "Consent gegeben" in der Floating Card.
2. Nach Post-Consent-Wartezeit schliesst sich Seite A.
3. **Seite B** laedt. Gleicher Ablauf.
4. Browser schliesst sich, Analyse startet.

Wichtig: Jede Seite hat ihren eigenen isolierten Browser-Kontext (kein Cookie-Sharing).

### 4. Report auswerten

Report liegt unter `reports/<project>/compare-<host>-<timestamp>.md`. Daneben zwei HAR-Files fuer Nachanalysen. Lies den Report und fasse zusammen:

- **TL;DR:** Wie viele Vendoren identisch, wie viele exklusiv?
- **Container/Measurement-IDs:** Identisch oder abweichend?
- **Custom Loader:** Standard GTM vs. Stape/First-Party-Loader?
- **Pre-Consent:** Feuern vor Consent die gleichen Tracker?
- **Exklusive Vendoren:** Was fehlt auf einer der beiden Seiten?

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
