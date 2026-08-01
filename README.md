# Hypersage AI Labs — studio site

Static, no-build marketing site for **Hypersage AI Labs**, the parent studio for a
twelve-product portfolio: Wingmate, Quietoak, CryptoSage AI, Saffra, StoryVault AI,
Nightshelf, Hexhunter, Mythwright, The One, Rowan, Alder and Waddleton.

Eleven of the twelve are iOS apps. **Waddleton is a browser game** — it is on neither
store and is played free at <https://waddleton.pages.dev/>. Copy that describes the
portfolio should say "iOS apps and a browser game", not "iOS apps".

**Studio-name spelling: `Hypersage`** — one capital H, lowercase `s`. That is the
spelling used everywhere on this site (titles, JSON-LD `name`, copyright lines, nav and
footer wordmarks). The three newest product sites currently sign their footers
"A HyperSage Studio App/Game" with a capital S; those are separate repos and should be
matched to `Hypersage` there, not here.

## Canonical domain — read this first

`hypersage.ai` is the **intended** brand domain and it is **not registered**. A DNS
lookup returns `NXDOMAIN`: no A record, no NS, no MX. There is no `CNAME` file in this
repo either. The site is actually served from the GitHub Pages project URL:

```
https://drvanus.github.io/hypersage-site/
```

Every self-referencing URL on the site now points there — `<link rel="canonical">`,
`og:url`, `og:image`, `twitter:image`, the JSON-LD `url`/`logo`/`image`, `sitemap.xml`,
`robots.txt`, and `canonical_url` in `site-audit-contract.json`.

When `hypersage.ai` is registered, the switch-over checklist lives in an HTML comment
beside the canonical link in `index.html` `<head>`. In short: update the four HTML pages,
`sitemap.xml`, `robots.txt` and the audit contract, add a `CNAME` file containing
`hypersage.ai`, point DNS at GitHub Pages — and stand up the mailbox, because
**`hi@hypersage.ai` cannot receive mail today** (no MX record on an unregistered domain)
even though it is the contact address on every page. That is the highest-priority
follow-up on this site.

## Pages

- `index.html` — the whole landing page: inline CSS, a small scroll-reveal script, no build step.
- `privacy.html` — website-only privacy policy (this site collects nothing; discloses GitHub Pages and Google Fonts by name).
- `terms.html` — website-only terms.
- `support.html` — contact, per-product site index, billing/refunds, security reporting.
- `404.html` — branded not-found page (noindex, links home).
- `marketing.html` — **internal artifact.** A gallery of App Store screenshots and social ad creatives under `marketing/assets/`. Nothing on the public site links to it; it is `noindex` and deliberately carries no canonical/OG tags. Its `<head>` does now declare `color-scheme` / `theme-color` so its hardcoded dark palette renders correctly.

## Assets

- `logo.png` / `favicon.png` / `apple-touch-icon.png` — the Hypersage mark (teal→violet infinity). Source in `brand/`.
- `icons/` — 256px app icons for all 12 products (hero strip + product grid). All 12 are referenced by `index.html`.
- `og-image.png` — 1200×630 social card. Referenced with the `?v=20260731a` cache-buster on all four public pages; bump the suffix whenever the bytes change.
- `shots/` — **orphaned.** Eight app screenshots (`cryptosage`, `hexhunter`, `mythwright`, `nightshelf`, `quietoak`, `saffra`, `storyvault`, `theone`) left over from a removed "A look at the work" showcase. No page in this repo references `shots/` any more. They are kept, not deleted, in case the showcase returns — but nothing renders them today.
- `legal.css` — shared stylesheet for the three legal pages.
- `robots.txt`, `sitemap.xml`, `.nojekyll` — deploy/discovery support.

## Status vocabulary

Product cards use one of: `Coming soon`, `In development`, `In beta`, `Live now`. Only
Waddleton is `Live now`. The gradient `badge-spotlight` style ("✦ New") is currently
unused — it read as *newly shipped* next to that vocabulary, and none of the products
carrying it had launched. Keep it for the first product that genuinely ships.

Each card's status must match what that product's own site says. Check before changing one.

## Audit gate

```bash
python3 ~/.claude/skills/no-build-marketing-site/site_audit.py . --contract site-audit-contract.json
```

`--contract` takes a **bare filename relative to the site directory**. It must end with
`0 failure(s)`. The contract file records the evidence behind the site's absolute claims
(`no_account`, `no_ads`, `offline`, `no_tracking`) — add evidence there before adding any
new absolute claim to a page.

## Deploy (GitHub Pages, same pattern as the app sites)

```bash
cd ~/Developer/DrVanus/hypersage-site
git add -A && git commit -m "…" && git push origin main
```

Remote is `git@github.com:DrVanus/hypersage-site.git`; Pages serves the default branch at
the project URL above.
