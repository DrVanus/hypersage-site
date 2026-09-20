# HyperSage AI Labs — studio site

> **Everything tracked in this branch is published.** GitHub Pages serves the whole
> tree, including this file, at `https://hypersage.ai/README.md`. Keep this README to
> what a visitor could already learn from the live site: nothing unreleased, no
> internal paths or process, and no figure the pages themselves do not print. Notes
> that are not for the public belong outside this repo.

Static, no-build site for HyperSage AI Labs — the studio pages at the origin root,
plus one subfolder per product site. No framework and no build step: edit the HTML.

## Two names, and they are not interchangeable

- **`HyperSage`** — capital H and capital S, one word — is the wordmark. It is what
  the `<title>`s, JSON-LD `name`, nav and body copy use; `press.html`'s fact sheet is
  canonical.
- **`HyperSage AI Labs LLC`** — capital S, **no comma before LLC** — is the registered
  Delaware entity. It belongs in copyright lines, liability and indemnity clauses and
  the JSON-LD `legalName`, and nowhere else. The footers that carry the entity name are
  correct as written; do not "fix" them to match the wordmark.

## Canonical domain

`hypersage.ai` is attached to this repo: `CNAME` holds the apex and Enforce HTTPS is
on. Keep the apex records unproxied — proxying breaks Pages' certificate issuance. The
old `drvanus.github.io/hypersage-site/*` paths 301 to the domain, path preserved.

Every self-referencing URL — `<link rel="canonical">`, `og:url`, `og:image`,
`twitter:image`, JSON-LD `url`/`logo`/`image`, `sitemap.xml` and `robots.txt` — is on
`https://hypersage.ai/`. `support@hypersage.ai` is the contact address on every page
and reaches a real mailbox.

## Layout

The product sites are **subfolders of this repo**, not separate origins, so one domain
and one certificate serve the whole portfolio. CryptoSage AI (`cryptosageai.io`) is the
one product still on its own origin.

### Studio pages

- `index.html` — the landing page: inline CSS, small enhancement scripts, no build
  step. The hero comes first, then `#products`, `#ai`, `#about` and `#contact`; the
  desktop and mobile navigation must point at those sections in the same order.
- `privacy.html` — studio-site privacy policy, scoped to the studio pages by name,
  because the subfolders share this origin and each product page has its own policy.
- `terms.html` — website-only terms.
- `support.html` — contact, per-product site index, billing and refunds, security
  reporting.
- `press.html` — press kit: boilerplate, fact sheet, downloadable marks.
- `404.html` — branded not-found page (noindex, links home). Only the root one is ever
  served; the copies inside product subfolders are not.
- `legal.css` — shared stylesheet for the legal and press pages.

### Product folders

A product folder holds that product's marketing page and, where the App Store listing
links them there, its own privacy, terms and support pages. A playable browser build
under a product folder is written by that game's own ship script — never hand-edit one
here.

## Assets

- `logo.png` / `favicon.png` / `apple-touch-icon.png` — the HyperSage mark
  (teal→violet infinity). Source art in `brand/`.
- `icons/` — one 256px app icon per product: `.png` for the press-kit downloads,
  `.webp` for what `index.html` displays.
- `og-image.png` — the 1200×630 social card, referenced with a `?v=` cache-buster on
  every studio page and in `index.html`'s JSON-LD. Bump the suffix whenever the bytes
  change, everywhere at once — and **only** when they change: a new `?v=` on identical
  bytes forces a pointless refetch, while changed bytes under an old `?v=` keep the
  stale picture forever.
- **Every og-image in this repo is GENERATED from the page it advertises. Never
  hand-draw or hand-edit one.** Re-render the card, then bump that page's `?v=`.

## Discovery files

`robots.txt`, `sitemap.xml`, `sitemap-main.xml` and `.nojekyll` are the deploy and
discovery files.

- Only the root `robots.txt` does anything: a crawler reads robots.txt from an origin
  root only. Subfolder copies are inert — delete them when convenient, and add no more.
- `sitemap.xml` is a sitemap **index**. Every product subfolder that ships a
  `sitemap.xml` needs a child entry there or its pages go undeclared. In the index,
  `<lastmod>` is the date the child sitemap *file* changed; in `sitemap-main.xml` it is
  the date the page *file* changed.
- **A page edit and its `<lastmod>` belong in the same commit.** A `<lastmod>` behind
  the bytes tells crawlers not to re-fetch the change.

## Before you commit

The `tools/` directory holds the checks this site is gated on; each script's header
comment says what it proves and how to run it. Run them from the repo root, and fix
what they flag instead of editing the check.

## Deploy

GitHub Pages serves the default branch at `https://hypersage.ai/`, so a push to it
publishes. Everything in the branch goes with it: do not commit anything to this tree
that is not meant to be public.
