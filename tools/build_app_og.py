"""Render the four app-subsite og-images (1200x630) from each SITE'S OWN pieces.

    python3 tools/build_app_og.py                 # all four
    python3 tools/build_app_og.py nightshelf …    # a subset

Same philosophy as build_og.py one directory up: these are not design files
drawn beside the site — every card is composed from the subsite's own color
tokens (copied verbatim from its :root), its own Google-Fonts stack, its own
hero copy, and an art asset already shipped in the subsite folder. If the page
rebrands, rerun this; nothing here invents a claim the page doesn't make.

Layout follows the fleet's card pattern (rowan/quietoak): left column carries
kicker -> display headline -> one-breath subhead; right side carries the art.
Two renderer lessons inherited from build_og.py, kept:
  * render from the SUBSITE dir so relative art paths resolve like they do live;
  * judge the result downscaled to ~460px (message-bubble size), not at 1200.
"""
from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
W, H = 1200, 630

FONTS = {
    "nightshelf": "family=Fraunces:ital,opsz,wght@0,9..144,400..700;1,9..144,400..700&family=Inter:wght@400..800",
    "mythwright": "family=Cinzel:wght@500..800&family=Inter:wght@400..800",
    "storyvault": "family=Playfair+Display:ital,wght@0,500..800;1,500..800&family=Inter:wght@400..800",
    "saffra":     "family=Playfair+Display:ital,wght@1,600&family=Inter:wght@400..800",
}

# Per-site card: colors are the site's own :root values, copy is the page's own
# hero/og copy (shortened, never reworded into new claims), art ships with the site.
CARDS = {
    "nightshelf": {
        "art": "app-icon.png",
        "css": """
  .og { background:
        radial-gradient(circle at 79% 46%, rgba(232,177,92,0.16), transparent 58%),
        linear-gradient(160deg, #111527 0%, #0B0E19 62%); }
  .kicker { color: #E8B15C; }
  h1 { font-family: 'Fraunces', Georgia, serif; font-weight: 640; font-size: 78px;
       background-image: linear-gradient(178deg, #FBF6EA 4%, #F6C877 70%, #C68B36 108%); }
  h1 em { font-style: italic; }
  .sub { color: #B7B2C4; }
  .art { width: 424px; height: 424px; border-radius: 96px;
         box-shadow: 0 24px 70px rgba(0,0,0,0.55), 0 0 90px rgba(232,177,92,0.20); }
""",
        "kicker_svg": '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
        "kicker": "Bedtime stories · iOS",
        "h1": "Stories to <em>drift&nbsp;off</em>&nbsp;to",
        "sub": "Eighty-two timeless classics and calm new AI stories, read aloud in a soft, sleepy voice with ambient sound underneath.",
    },
    "mythwright": {
        "art": "app-icon.png",
        "css": """
  .og { background:
        radial-gradient(circle at 79% 46%, rgba(224,179,76,0.13), transparent 58%),
        linear-gradient(160deg, #1C1509 0%, #0E0B06 62%); }
  .kicker { color: #E0B34C; }
  h1 { font-family: 'Cinzel', Georgia, serif; font-weight: 800; font-size: 72px;
       background-image: linear-gradient(180deg, #FBF3DD 0%, #F6CE6A 70%, #B08526 100%); }
  .sub { color: #C4B189; }
  /* The icon is near-black on a near-black card: lifted so the quill-and-sword
     still reads in a 460px message bubble. */
  .art { width: 424px; height: 424px; border-radius: 28px;
         filter: brightness(1.22) saturate(1.06);
         border: 1px solid rgba(224,179,76,0.30);
         box-shadow: 0 20px 60px rgba(0,0,0,0.55), 0 0 90px rgba(224,179,76,0.16); }
""",
        "kicker": "Collectible card game · iOS",
        "h1": "Collect.<br>Build.<br>Battle.",
        "sub": "The heroes and monsters of classic literature, at war across three lanes. 256 cards, six factions, a full campaign.",
    },
    "storyvault": {
        "art": "storyvault-mark.png",
        "css": """
  .og { background: linear-gradient(160deg, #171030 0%, #0D0620 52%, #060312 100%); }
  .kicker { color: #D9B57F; }
  h1 { font-family: 'Playfair Display', Georgia, serif; font-weight: 700; font-size: 63px;
       background-image: linear-gradient(178deg, #F5F1E8 30%, #B8AEC6 108%); }
  /* "written with you." must stay ONE line — a wrapped orphan "you." killed the
     460px read. Sized 63px so the nowrap span still clears the column. */
  h1 .grad { font-style: italic; white-space: nowrap;
       background-image: linear-gradient(115deg, #F3E3BD 0%, #E4C48F 38%, #D9B57F 62%, #C09A62 100%); }
  .sub { color: #B8AEC6; }
  /* The mark's own nebula feathers into the card bg instead of sitting in a box. */
  .art { width: 560px; height: 560px; border-radius: 0;
         -webkit-mask-image: radial-gradient(closest-side, #000 55%, transparent 98%);
         mask-image: radial-gradient(closest-side, #000 55%, transparent 98%); }
""",
        "kicker": "AI story adventures · iOS",
        "h1": 'Branching tales,<br><span class="grad">written with you.</span>',
        "sub": "Step into Beowulf, Dracula, or a world only the AI has dreamed. Every choice rewrites the next page.",
    },
    "saffra": {
        "art": "saffra-hat.png",
        "css": """
  .og { background:
        radial-gradient(circle at 79% 52%, rgba(224,130,48,0.16), transparent 55%),
        linear-gradient(160deg, #1A1612 0%, #0E0C0A 62%); }
  .kicker { color: #E08230; }
  h1 { font-family: 'Inter', sans-serif; font-weight: 800; font-size: 78px;
       background-image: linear-gradient(178deg, #F5EFE5 40%, #CDBFA9 108%); }
  h1 .ital { font-family: 'Playfair Display', Georgia, serif; font-style: italic; font-weight: 600;
       background-image: linear-gradient(115deg, #F5C088 0%, #E08230 100%); }
  .sub { color: #9A8E80; }
  .art { width: 470px; height: 470px; }
""",
        "kicker": "AI recipe app · iOS",
        "h1": 'Your kitchen,<br><span class="ital">understood.</span>',
        "sub": "Premium recipes you can trust — built from a weighted consensus of tested, editor-vetted sources, then rewritten for your pantry.",
    },
}

SHELL = """<!DOCTYPE html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?{fonts}&display=block" rel="stylesheet">
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  .og {{ width: {w}px; height: {h}px; overflow: hidden; display: flex; align-items: center; }}
  .og-left {{ width: 660px; padding: 0 8px 0 84px; }}
  .kicker {{ display: flex; align-items: center; gap: 10px; font-family: 'Inter', sans-serif;
            font-size: 21px; font-weight: 700; letter-spacing: 0.13em; text-transform: uppercase;
            margin-bottom: 30px; }}
  .kicker svg {{ width: 22px; height: 22px; }}
  h1 {{ line-height: 1.12; letter-spacing: 0.005em; padding-bottom: 0.12em;
       -webkit-background-clip: text; background-clip: text; color: transparent;
       margin-bottom: 26px; }}
  h1 .grad, h1 .ital {{ -webkit-background-clip: text; background-clip: text; color: transparent; }}
  .sub {{ font-family: 'Inter', sans-serif; font-size: 26px; line-height: 1.5; max-width: 560px; }}
  .og-right {{ flex: 1; display: flex; align-items: center; justify-content: center; }}
  .art {{ object-fit: cover; }}
{css}
</style></head><body>
<div class="og">
  <div class="og-left">
    <div class="kicker">{kicker_svg}{kicker}</div>
    <h1>{h1}</h1>
    <p class="sub">{sub}</p>
  </div>
  <div class="og-right"><img class="art" src="{art}"></div>
</div>
</body></html>"""


def render(names: list[str]) -> None:
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        pg = b.new_page(viewport={"width": W, "height": H}, device_scale_factor=1)
        for name in names:
            c = CARDS[name]
            html = SHELL.format(w=W, h=H, fonts=FONTS[name], css=c["css"],
                                kicker_svg=c.get("kicker_svg", ""), kicker=c["kicker"],
                                h1=c["h1"], sub=c["sub"], art=c["art"])
            # Written into the SUBSITE dir so the art path resolves as it does live.
            tmp = ROOT / name / "_og_render.html"
            tmp.write_text(html)
            try:
                pg.goto(tmp.as_uri())
                # Webfonts or bust: a fallback-font card is a broken card.
                pg.wait_for_function("document.fonts.status === 'loaded'", timeout=15000)
                pg.wait_for_timeout(150)
                out = ROOT / name / "og-image.png"
                pg.screenshot(path=str(out))
                print(f"wrote {name}/og-image.png  {out.stat().st_size // 1024} KB")
            finally:
                tmp.unlink(missing_ok=True)
        b.close()


if __name__ == "__main__":
    picked = sys.argv[1:] or list(CARDS)
    unknown = [n for n in picked if n not in CARDS]
    if unknown:
        sys.exit(f"unknown site(s): {', '.join(unknown)} — know: {', '.join(CARDS)}")
    render(picked)
