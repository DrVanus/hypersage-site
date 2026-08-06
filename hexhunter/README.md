# Hexhunter — marketing site

Static landing page for **Hexhunter**, a gothic illustrated horde-survivor for iOS,
built by [HyperSage](https://drvanus.github.io/hypersage-site/).

Dark gothic theme (obsidian `#0C0A14`, arcane violet `#8B5CF6`, evolution gold
`#D4AF37`; Cinzel + Inter). Single-file `index.html` with inline CSS, plus shared
`legal.css` for the legal pages. No build step, no JS framework — deploys as-is to
GitHub Pages (same pattern as the Quietoak / HyperSage sites).

## Files

- `index.html` — landing page (hero, features, 8 heroes, 3 biomes, 18 weapons, about, CTA)
- `privacy-policy.html` / `terms.html` — legal, wrapped from `~/Hexhunter/legal/*.md`
- `legal.css` — shared stylesheet for the legal pages
- `404.html` — themed not-found page
- `sitemap.xml`, `robots.txt`, `.nojekyll` — SEO / Pages config
- `app-icon.png` (1024²) / `app-icon-512.png` — the App Store icon
- `assets/heroes/` — the 8 hero portraits (from the game's gpt-image-2 art pipeline)
- `assets/biomes/` — the 3 biome floor tiles
- `assets/art/` — cover art, bosses, and a few enemy/card plates

All game data (hero names, stat lines, starting weapons, biomes, bosses, weapon
list + evolved forms) is sourced from `~/Hexhunter/Sources/Game/` so the copy stays
accurate to the shipping game.

## Deploy

Push to a public GitHub repo and enable Pages (branch = default, root). Custom
domain `hexhunter.app` is aspirational — not yet registered.

## To do before publish

- [ ] Generate a real `og-image.png` (1200×630) — currently referenced but not baked
- [ ] Wire the "Watch Trailer" button to a real trailer
- [ ] Register `hexhunter.app` + add a `CNAME` file if using the custom domain
