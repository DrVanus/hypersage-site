# HyperSage AI Labs — studio site

> **This file is served publicly at `https://hypersage.ai/README.md`.** GitHub Pages
> serves every tracked file in the branch, including this one. Nothing in here may
> contradict the live site, name a mailbox that does not work, or quote a number the
> pages do not quote. If you need to write something internal, write it somewhere that
> is not in this tree.

Static, no-build site for **HyperSage AI Labs**, the parent studio, plus the product
sites that live under it as subfolders.

Sixteen products: Holohound, Wingmate, Loam, Quietoak, CryptoSage AI, Saffra, StoryVault AI,
Nightshelf, Rowan, Alder, Mythkin, Hexhunter, Mythwright, Waddleton, Hoardling and Gemburrow.
Thirteen are iOS apps; **Waddleton, Hoardling and Gemburrow are browser games**. Portfolio
copy should say "consumer products" unless it is intentionally describing a specific
platform. The page's own `id="product-*"` anchors are the count of record.

## Two names, and they are not interchangeable

- **`HyperSage`** — capital H and capital S, one word — is the wordmark. It is what the
  `<title>`s, JSON-LD `name`, nav and body copy use (press.html's fact sheet is canonical).
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

The product sites are **subfolders of this repo**, not separate origins — one folder per
product on the studio page (`/alder/`, `/gemburrow/`, `/hexhunter/`, `/hoardling/`,
`/holohound/`, `/loam/`, `/mythkin/`, `/mythwright/`, `/nightshelf/`, `/quietoak/`,
`/rowan/`, `/saffra/`, `/storyvault/`, `/waddleton/`, `/wingmate/`). One domain and one
certificate serve the whole portfolio. CryptoSage AI (`cryptosageai.io`) is the one product
still on its own origin.

### Studio pages

- `index.html` — the landing page: inline CSS, small enhancement scripts, no build
  step. Section order is `hero → products → ai → about → contact`; the desktop and
  mobile navigation must point to those public sections in the same order.
- `privacy.html` — studio-site privacy policy. Scoped to the studio pages by name,
  because the subfolders are the same origin and each product page has its own
  policy.
- `terms.html` — website-only terms.
- `support.html` — contact, per-product site index, billing/refunds, security reporting.
- `404.html` — branded not-found page (noindex, links home). The eight nested `404.html`
  files in product subfolders are never served; only the root one is.

## Assets

- `logo.png` / `favicon.png` / `apple-touch-icon.png` — the HyperSage mark (teal→violet
  infinity). Source in `brand/`.
- `icons/` — 256px app icons for all 16 products, as `.png` (the press-kit downloads)
  and `.webp` (what `index.html` displays: the hero strip, the grid and the rail).
- `og-image.png` — 1200×630 social card, referenced with a `?v=` cache-buster on all
  five studio pages (index, press, privacy, support, terms) and in index.html's JSON-LD.
  Bump the suffix whenever the bytes change, in all of them —
  and **only** when they change; a new `?v=` on identical bytes just forces a pointless
  refetch, while changed bytes under an old `?v=` keep the stale picture forever.
- **Every og-image in this repo is GENERATED. Never hand-draw or hand-edit one.**
  `tools/build_og.py` renders the studio card by lifting the page's own `<style>` and
  hero figure; `tools/build_app_og.py` renders every product card from each
  subsite's own `:root` tokens, webfont stack, hero words and shipped art. Seven were
  hand-made until 2026-08-11 and every one had drifted from its page — see the
  header comment in each tool for what that cost.
- `*/og-image.inputs.sha256` — the stamp each renderer writes, recording what its card
  was built from. It is what makes `--check` able to say "the page moved".
- `shots/` — **orphaned.** Two leftover screenshots (`quietoak.jpg`, `theone.jpg`) from a
  removed "A look at the work" showcase. Nothing in this repo references them.
- `legal.css` — shared stylesheet for the three legal pages.
- `robots.txt`, `sitemap.xml`, `sitemap-main.xml`, `.nojekyll` — deploy/discovery.

`robots.txt` at the repo root is the **only** one that does anything, because a crawler
reads robots.txt from an origin root only. Eight subfolders still carry an inert one each;
delete them when convenient and do not add more.

`sitemap.xml` is a sitemap **index**. Every product subfolder that has a `sitemap.xml`
needs a child entry there or its pages go undeclared.

## Availability copy

The studio homepage deliberately does not rank products by launch state. Availability
belongs on each product page and in the destination of its call to action. A product card
may link to a live experience when one exists, but studio-level copy should explain the
portfolio rather than compare release status.

## Audit tooling

Run these two first — unlike the legacy auditor below, they ARE pass/fail and they are
cheap:

```bash
python3 tools/build_og.py --check        # studio card still matches the studio page
python3 tools/build_app_og.py --check    # every product card still matches its page
```

They fail when a page moves under its card (CSS tokens, `<h1>`, `og:title`,
`og:description`, or the art file's bytes), when a number in a card appears nowhere on
its page, when a kicker claims iOS while the page links no App Store listing, or when a
card uses a colour that is not one of the site's own. An unrelated copy edit does not
trip them. Fix by re-rendering that site, then bumping its `?v=`.

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
