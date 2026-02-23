---
name: tagging-audit
description: Use when user wants to audit tagging, tracking, consent, or dataLayer on a website. Triggers on keywords like audit, tagging check, consent check, tracking verification, CMP test, dataLayer inspection.
---

# Tagging Audit

Run automated tagging audits on websites using Playwright. Collects dataLayer, network requests, cookies, and localStorage across consent states and e-commerce paths.

## Toolkit Location

Project root directory (where this skill lives).

All commands run from this directory.

## Workflow

### 1. Collect Parameters

Ask for (use AskUserQuestion):

**Required:**
- URL (start page)
- Project name: Derive automatically from the URL as `subdomain_domain_tld` (e.g. `www_gandke_de`, `visit_freiburg_de`, `shop_example_co_uk`). Do not ask the user for this – just derive it. If the URL has no subdomain, use `domain_tld` (e.g. `gandke_de`).

**Optional - ask if e-commerce site:**
- Category page URL
- Product page URL
- Add-to-cart CSS selector
- View cart URL
- Checkout URL

### 2. Check CMP Library

Read `cmp-library.json` from the toolkit directory. Show user which CMPs are known.

If the site's CMP is unknown or uncertain, run auto-detection first (audit.js does this automatically). If detection fails, run learn.js first:

```bash
node learn.js --url <url> --cmp "<CMP Name>"
```

Then restart the audit.

### 3. Run Audit

```bash
node audit.js --url <url> --project <name> [options]
```

**Options:**
- `--disable-sw` - deregister service workers (use on second run if SW warning in report)
- `--category <url>` - activates e-commerce path
- `--product <url>`
- `--add-to-cart "<selector>"`
- `--view-cart <url>`
- `--checkout <url>`

**WICHTIG:** Niemals `--cmp` verwenden. Immer die Auto-Erkennung nutzen.

### 4. Present Results

Read the report from `reports/<project>/audit-<date>.md`.

Summarize key findings, especially:
- **Pre-consent tracking** - any trackers firing before consent? (violation)
- **Tracking after reject** - any known trackers despite reject? (violation)
- **Consent Mode** - are gcs/gcd parameters present and correct?
- **Cookie inventory** - how many cookies pre vs post consent?
- **E-commerce events** - are expected dataLayer events firing?

## Quick Reference

| Scenario | Command |
|----------|---------|
| Consent-only audit | `node audit.js --url <url> --project <name>` |
| With e-commerce | Add `--category`, `--product`, `--add-to-cart` |
| Service worker issue | Add `--disable-sw` on second run |
| Unknown CMP | Run `node learn.js --url <url> --cmp "<Name>"` first |
