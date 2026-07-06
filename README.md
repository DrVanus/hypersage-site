# Hypersage AI Labs — company site

Single-file static marketing site for **Hypersage AI Labs**, the parent studio for the product portfolio (Saffra, StoryVault AI, Nightshelf, Quietoak, CryptoSage AI, Mythwright, The One).

## Structure
- `index.html` — the entire site (inline CSS + a tiny scroll-reveal script, no build step).
- `icons/` — real 256px app icons for all 7 products (used in the hero strip + product grid).
- `shots/` — real app screenshots (480px, web-light) shown in the "A look at the work" showcase.
- `og-image.png` — 1200×630 social-share card.
- `robots.txt`, `sitemap.xml`, `.nojekyll` — deploy support.

## Deploy (GitHub Pages, same pattern as the app sites)
```bash
cd ~/Desktop/hypersage-site
git init && git add -A && git commit -m "Hypersage AI Labs site"
# push to a GitHub repo, enable Pages on the default branch
```

## Before going live — confirm/replace
- **Company name:** built as *Hypersage AI Labs* (per request). The operating manual lists the legal entity as *Hyper Safe AI Labs LLC* — reconcile which is canonical.
- **Contact email:** placeholder `hello@hypersage.ai`. Register the domain + mailbox, or swap in a real address.
- **Domain / canonical:** `https://hypersage.ai` used in canonical + OG tags. Update if the real domain differs.

## Done
- Real app icons for all 7 products (hero strip + product grid).
- "A look at the work" showcase — real screenshots of 6 apps in device frames (horizontal scroll gallery).
- Live "Visit site" links: Saffra, StoryVault AI, Quietoak, CryptoSage AI, The One (Nightshelf & Mythwright show an "In TestFlight" caption until their sites exist).
- Subtle scroll-reveal animation (reduced-motion + no-JS safe).
- `og-image.png` generated for rich link previews.
