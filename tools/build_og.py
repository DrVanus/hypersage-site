"""Render hypersage.ai's og-image FROM THE SITE'S OWN MARKUP.

    python3 tools/build_og.py            # writes og-image.png (1200x630)
    python3 tools/build_og.py --check    # fail if the product list has drifted

WHY THIS IS A RENDERER AND NOT A DESIGN FILE
--------------------------------------------
The previous og-image was drawn separately from the site and drifted, exactly the
way a second copy of anything drifts:

  * It showed an ORBITAL diagram — "PRODUCT INTELLIGENCE" ringed by KNOWLEDGE /
    CONTEXT / RESULT / SAFEGUARDS. The site shows a left-to-right PIPELINE:
    three input cards -> Product system -> Result. Two different diagrams making
    two different claims about how the product works. Someone shares the link,
    sees one thing, clicks, and sees another.
  * It listed THIRTEEN products including "The One". The site has twelve, and
    "The One" is not among them.

So this does not draw anything. It lifts the site's own <style> block and its
own hero markup, drops them on a 1200x630 canvas, and screenshots it. The
diagram in the preview is the diagram on the page because it is literally the
same DOM. The product list is read out of the page's `id="product-*"` anchors,
so adding or removing a product updates the preview on the next build and
`--check` fails loudly if someone forgets.
"""
from __future__ import annotations

import argparse
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
INDEX = ROOT / "index.html"
OUT = ROOT / "og-image.png"
W, H = 1200, 630

# Display names for the product ids found on the page. Anything on the page but
# missing here is a hard error rather than a silently-skipped tile.
NAMES = {
    "wingmate": "Wingmate", "quietoak": "Quietoak", "cryptosage": "CryptoSage",
    "saffra": "Saffra", "storyvault": "StoryVault", "nightshelf": "Nightshelf",
    "hexhunter": "Hexhunter", "mythwright": "Mythwright", "rowan": "Rowan",
    "alder": "Alder", "waddleton": "Waddleton", "mythkin": "Mythkin",
}


def site_parts() -> tuple[str, str, list[str]]:
    html = INDEX.read_text()
    style = re.search(r"<style>(.*?)</style>", html, re.S)
    if not style:
        sys.exit("no <style> block in index.html")
    fig = re.search(r'(<figure class="context-engine".*?</figure>)', html, re.S)
    if not fig:
        sys.exit("no .context-engine figure in index.html — the hero diagram moved")
    ids = re.findall(r'id="product-([a-z]+)"', html)
    seen: list[str] = []
    for i in ids:
        if i not in seen:
            seen.append(i)
    unknown = [i for i in seen if i not in NAMES]
    if unknown:
        sys.exit(f"product(s) on the page with no display name: {unknown} — add to NAMES")
    return style.group(1), fig.group(1), [NAMES[i] for i in seen]


def build_html() -> str:
    style, figure, products = site_parts()
    half = (len(products) + 1) // 2
    row1 = " · ".join(products[:half])
    row2 = " · ".join(products[half:])
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>{style}</style>
<style>
  html,body {{ margin:0; padding:0; width:{W}px; height:{H}px; overflow:hidden; }}
  body {{ background:#080B0F; }}
  .og {{ position:relative; width:{W}px; height:{H}px;
         background:
           radial-gradient(900px 460px at 12% -10%, rgba(45,212,191,.13), transparent 60%),
           radial-gradient(760px 420px at 96% 8%, rgba(167,139,250,.14), transparent 62%),
           #080B0F;
         padding:48px 56px; box-sizing:border-box; display:flex; gap:24px; }}
  .og-left {{ width:520px; flex:0 0 520px; }}
  .og-right {{ flex:1; display:flex; align-items:center; justify-content:center; }}
  .og-brand {{ display:flex; align-items:center; gap:12px; margin-bottom:30px; }}
  .og-brand img {{ width:38px; height:42px; }}
  .og-brand .t1 {{ font: 600 11px/1.1 ui-sans-serif,-apple-system,'Segoe UI',sans-serif;
                   letter-spacing:.22em; text-transform:uppercase; color:#5EEAD4; }}
  .og-brand .t2 {{ font: 700 17px/1.3 ui-sans-serif,-apple-system,'Segoe UI',sans-serif; color:#F2F6F8; margin-top:3px; }}
  .og h1 {{ font: 800 54px/1.06 ui-sans-serif,-apple-system,'Segoe UI',sans-serif;
            color:#F2F6F8; margin:0 0 22px; letter-spacing:-.022em; }}
  /* The SAME gradient the live headline uses — teal -> blue -> violet. The old
     preview flattened this to one teal, which is half the brand. */
  .og h1 .grad {{ background:linear-gradient(96deg,#2DD4BF 0%,#5AA9E6 52%,#A78BFA 100%);
                  -webkit-background-clip:text; background-clip:text; color:transparent; }}
  .og .rule {{ width:330px; height:2px; margin:0 0 22px;
               background:linear-gradient(90deg,#2DD4BF,#A78BFA); border-radius:2px; }}
  .og p {{ font: 400 18px/1.5 ui-sans-serif,-apple-system,'Segoe UI',sans-serif;
           color:#B9C6CE; margin:0; max-width:470px; }}
  .og .apps {{ position:absolute; left:56px; bottom:44px; font: 400 13px/1.75 ui-sans-serif,-apple-system,sans-serif;
               color:#7C8B95; letter-spacing:.005em; }}
  /* The figure is the site's, so pin only its BOX — never its internals.
     Scaled UP, and that is the whole point: a link preview is rendered ~460px
     wide in a message bubble, and at that size the pipeline's three input cards
     turned to mush. The old orbital art survived shrinking because it was one
     bold ring saying nothing; this one carries real labels, so it has to be
     big enough to still read them. Checked by downscaling to preview width, not
     by looking at the 1200px render. */
  .og-right .context-engine {{ transform:scale(1.24); transform-origin:center; margin:0; }}
</style></head><body>
<div class="og">
  <div class="og-left">
    <div class="og-brand">
      <img src="logo.png" alt="">
      <div><div class="t1">Independent Product Studio</div><div class="t2">Hypersage AI Labs</div></div>
    </div>
    <h1>Software with<br><span class="grad">a point of view.</span></h1>
    <div class="rule"></div>
    <p>Distinctive consumer apps and original games.<br>Context-aware AI where it improves the product.</p>
  </div>
  <div class="og-right">{figure}</div>
  <div class="apps">{row1}<br>{row2}</div>
</div>
</body></html>"""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="verify the product list resolves; render nothing")
    args = ap.parse_args()
    _, _, products = site_parts()
    print(f"{len(products)} products from index.html: {', '.join(products)}")
    if args.check:
        return
    # Written to the SITE ROOT, not tools/, so every relative asset in the
    # lifted markup (logo.png, and anything added to the hero later) resolves
    # exactly as it does on the live page. Rendering from tools/ silently broke
    # both logos into placeholder glyphs.
    tmp = ROOT / "_og_render.html"
    tmp.write_text(build_html())
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        pg = b.new_page(viewport={"width": W, "height": H}, device_scale_factor=1)
        pg.goto(tmp.as_uri())
        pg.wait_for_timeout(700)          # let the figure's CSS animation settle
        pg.screenshot(path=str(OUT))
        b.close()
    tmp.unlink(missing_ok=True)
    print(f"wrote {OUT.name}  {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
