# Hypersage AI Labs — studio site

> **This file is served publicly at `https://hypersage.ai/README.md`.** GitHub Pages
> serves every tracked file in the branch, including this one. Nothing in here may
> contradict the live site, name a mailbox that does not work, or quote a number the
> pages do not quote. If you need to write something internal, write it somewhere that
> is not in this tree.

Static, no-build site for **Hypersage AI Labs**, the parent studio, plus the eleven
product sites that live under it as subfolders.

Thirteen products: Wingmate, Quietoak, CryptoSage AI, Saffra, StoryVault AI, Nightshelf,
Hexhunter, Mythwright, The One, Rowan, Alder, Waddleton and Mythkin.

Eleven of the thirteen currently have iOS app code. **Waddleton is a browser game**,
played at <https://waddleton.pages.dev/>; **The One is currently a landing-page concept**.
Portfolio copy should say "consumer products" unless it is intentionally describing a
specific platform.

## Two names, and they are not interchangeable

- **`Hypersage`** — one capital H, lowercase `s` — is the trading style. It is what the
  wordmark, `<title>`s, JSON-LD `name`, nav and body copy use.
- **`HyperSage AI Labs LLC`** — capital S, **no comma before LLC** — is the registered
  Delaware entity. It belongs in copyright lines, liability clauses, indemnity clauses
  and the JSON-LD `legalName`, and nowhere else. `index.html`'s footer and
  `privacy.html`'s footer both carry it correctly; do not "fix" either to match the
  wordmark.

Some product footers still sign "A HyperSage Studio App/Game" as a *style*; those should
become `© 2026 HyperSage AI Labs LLC`, which is the entity, not a restyled wordmark.

## Canonical domain

`hypersage.ai` is registered, live, and attached to this repo. `CNAME` in the repo root
contains `hypersage.ai`; DNS is Cloudflare Registrar with apex A records pointing at
GitHub Pages, **DNS-only / grey cloud** (proxying breaks Pages' certificate issuance);
Enforce HTTPS is on. GitHub 301s the old `drvanus.github.io/hypersage-site/*` paths to
the domain, path preserved.

`support@hypersage.ai` is live via Cloudflare Email Routing. It is the contact address on
every page and the `mailto:` links reach a real mailbox.

Every self-referencing URL — `<link rel="canonical">`, `og:url`, `og:image`,
`twitter:image`, JSON-LD `url`/`logo`/`image`, `sitemap.xml`, `robots.txt` and
`canonical_url` in `site-audit-contract.json` — is on `https://hypersage.ai/`.

## Layout

The eleven app sites are **subfolders of this repo**, not separate origins: `/alder/`,
`/hexhunter/`, `/mythkin/`, `/mythwright/`, `/nightshelf/`, `/quietoak/`, `/rowan/`,
`/saffra/`, `/storyvault/`, `/waddleton/`, `/wingmate/`. One domain and one certificate
serve the whole portfolio. CryptoSage AI (`cryptosageai.io`) and The One
(`drvanus.github.io/theone-app/`) are still on their own origins.

### Studio pages

- `index.html` — the landing page: inline CSS, small enhancement scripts, no build
  step. Section order is `hero → products → ai → about → contact`; the desktop and
  mobile navigation must point to those public sections in the same order.
- `privacy.html` — studio-site privacy policy. Scoped to the studio pages by name,
  because the subfolders are now the same origin and `/saffra/` runs a Firebase-backed
  email form.
- `terms.html` — website-only terms.
- `support.html` — contact, per-product site index, billing/refunds, security reporting.
- `404.html` — branded not-found page (noindex, links home). The eight nested `404.html`
  files in product subfolders are never served; only the root one is.

## Assets

- `logo.png` / `favicon.png` / `apple-touch-icon.png` — the Hypersage mark (teal→violet
  infinity). Source in `brand/`.
- `icons/` — 256px app icons, 13 on disk but **12 referenced** by `index.html` (hero strip
  + product grid). `theone.png` is orphaned: The One was pulled from the portfolio
  2026-08-08 and nothing references its icon.
- `og-image.png` — 1200×630 social card, referenced with the `?v=20260810y` cache-buster
  on all **five** pages that carry it: `index.html`, `press.html`, `privacy.html`,
  `terms.html`, `support.html`. Bump the suffix whenever the bytes change, in all five —
  the 2026-08-10 re-render bumped only `index.html` and left the other four advertising a
  version that no longer existed, so scrapers kept serving the superseded art.
- `shots/` — **orphaned.** Two leftover screenshots (`quietoak.jpg`, `theone.jpg`) from a
  removed "A look at the work" showcase. Nothing in this repo references them.
- `legal.css` — shared stylesheet for the three legal pages.
- `robots.txt`, `sitemap.xml`, `sitemap-main.xml`, `.nojekyll` — deploy/discovery.

`robots.txt` at the repo root is the **only** one that does anything, because a crawler
reads robots.txt from an origin root only. Eight subfolders still carry an inert one each;
delete them when convenient and do not add more.

`sitemap.xml` is a sitemap **index**. Every product subfolder that has a `sitemap.xml`
needs a child entry there or its pages go undeclared — all eleven are listed today.

## Availability copy

The studio homepage deliberately does not rank products by launch state. Availability
belongs on each product page and in the destination of its call to action. A product card
may link to a live experience when one exists, but studio-level copy should explain the
portfolio and its shared product architecture rather than compare release status.

## Audit tooling

```bash
python3 ~/.claude/skills/no-build-marketing-site/site_audit.py . --contract site-audit-contract.json
```

The legacy script is useful for a single standalone marketing site, but it is **not a
release gate for this consolidated multi-site tree**. It currently misreads same-origin
subfolder links, sitemap-index semantics, nested product contracts, and intentionally
reused screenshots. Treat its output as leads to inspect, not a pass/fail result, until a
repo-specific validator replaces it. The contracts still record evidence behind absolute
claims (`no_account`, `no_ads`, `offline`, `no_tracking`); re-derive that evidence whenever
the product code moves. A gate that certifies a stale fact is worse than no gate.

## Deploy (GitHub Pages)

```bash
cd ~/Developer/DrVanus/hypersage-site
git add -A && git commit -m "…" && git push origin main
```

Remote is `git@github.com:DrVanus/hypersage-site.git`; Pages serves the default branch at
`https://hypersage.ai/`.
