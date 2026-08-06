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

Twelve of the thirteen are iOS apps. **Waddleton is a browser game** — it is on neither
store and is played free at <https://waddleton.pages.dev/>. Copy that describes the
portfolio should say "iOS apps and a browser game", not "iOS apps".

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

- `index.html` — the landing page: inline CSS, one small scroll-reveal script, no build
  step. Section order is `products → ai → approach → about → contact` and it must match
  the nav in both the desktop links and the mobile `<details>` menu.
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
- `icons/` — 256px app icons for all 13 products (hero strip + product grid). All 13 are
  referenced by `index.html`.
- `og-image.png` — 1200×630 social card, referenced with the `?v=20260806b` cache-buster
  on all four studio pages. Bump the suffix whenever the bytes change, in all four.
- `shots/` — **orphaned.** Two leftover screenshots (`quietoak.jpg`, `theone.jpg`) from a
  removed "A look at the work" showcase. Nothing in this repo references them.
- `legal.css` — shared stylesheet for the three legal pages.
- `robots.txt`, `sitemap.xml`, `sitemap-main.xml`, `.nojekyll` — deploy/discovery.

`robots.txt` at the repo root is the **only** one that does anything, because a crawler
reads robots.txt from an origin root only. Eight subfolders still carry an inert one each;
delete them when convenient and do not add more.

`sitemap.xml` is a sitemap **index**. Every product subfolder that has a `sitemap.xml`
needs a child entry there or its pages go undeclared — all eleven are listed today.

## Status vocabulary

Product cards use one of: `Coming soon`, `In development`, `In beta`, `Live now`. Only
Waddleton is `Live now`, and it is live in a browser — **nothing is on the App Store
yet**. The gradient `badge-spotlight` style ("✦ New") is currently unused; keep it for
the first product that genuinely ships to a store.

Each card's status must match what that product's own site says, and the two launch
sentences on `index.html` (the `#approach` intro and the `#about` paragraph) must move
the week the first App Store approval lands.

## Audit gate

```bash
python3 ~/.claude/skills/no-build-marketing-site/site_audit.py . --contract site-audit-contract.json
```

`--contract` takes a **bare filename relative to the site directory**. It must end with
`0 failure(s)`. The contract records the evidence behind the site's absolute claims
(`no_account`, `no_ads`, `offline`, `no_tracking`) — add evidence there before adding any
new absolute claim to a page, and **re-derive the evidence when the code moves**. A gate
that certifies a stale fact is worse than no gate.

## Deploy (GitHub Pages)

```bash
cd ~/Developer/DrVanus/hypersage-site
git add -A && git commit -m "…" && git push origin main
```

Remote is `git@github.com:DrVanus/hypersage-site.git`; Pages serves the default branch at
`https://hypersage.ai/`.
