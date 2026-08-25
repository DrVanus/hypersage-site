"""Render hypersage.ai's og-image FROM THE SITE'S OWN MARKUP.

    python3 tools/build_og.py            # writes og-image.png (1200x630)
    python3 tools/build_og.py --check    # fail if the preview no longer matches the page

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
import hashlib
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
    "holohound": "Holohound", "hoardling": "Hoardling", "gemburrow": "Gemburrow",
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
    # Each product's icon comes off the card that DECLARES that product, in page
    # order — never a hardcoded list, for the same reason the names are read out
    # of the page: a second list is a second thing to forget. The bounded span
    # stops a card with no icon from silently borrowing the next card's, and the
    # filename check catches a mis-grab that a bounded regex could still make.
    icons: dict[str, str] = {}
    for m in re.finditer(
        r'id="product-([a-z]+)"[^>]*>.{0,400}?class="app-icon" src="([^"]+)"', html, re.S
    ):
        icons.setdefault(m.group(1), m.group(2))
    missing = [i for i in seen if i not in icons]
    if missing:
        sys.exit(f"product(s) on the page with no .app-icon image: {missing}")
    for i in seen:
        if i not in icons[i].rsplit("/", 1)[-1]:
            sys.exit(f"icon for product-{i} is {icons[i]} — the file does not name "
                     f"the product it was matched to; the card would show the wrong art")
    # Each card's lifecycle chip, in page order. The card renders fifteen
    # identical tiles, but the PAGE qualifies seven of them as unshipped — so a
    # bare "15 apps and games" under a row of store-looking icons asserts a
    # shipping portfolio nearly half of which you cannot get yet, to an audience
    # that mostly never clicks through. The count of live products is read off
    # the page's own `status live` marker rather than typed, so it moves on its
    # own the day something ships; a hardcoded number here would rot at exactly
    # the moment the news is good.
    statuses = re.findall(r'class="status( live)?">([^<]*)<', html)
    if len(statuses) != len(seen):
        sys.exit(f"{len(seen)} product cards but {len(statuses)} status chips — "
                 f"the card cannot say how many are live if the page's own "
                 f"lifecycle markers do not line up with its products")
    return (style.group(1), fig.group(1), [NAMES[i] for i in seen],
            [icons[i] for i in seen], [t for _, t in statuses],
            sum(1 for cls, _ in statuses if cls.strip() == "live"))


def build_html() -> str:
    style, figure, products, icons, _, live = site_parts()
    tiles = "".join(f'<img src="{s}" alt="">' for s in icons)
    cap = f"The portfolio · {len(products)} apps and games · {live} live now"
    return f"""<!doctype html><html><head><meta charset="utf-8">
<!-- The site's @font-face rules live HERE, not in index.html's <style> block, so
     lifting that block alone rendered the whole card — including the lifted
     figure, whose CSS asks for these families BY NAME — in system fallback.
     A preview set in a different typeface than the page it previews is the same
     drift this renderer exists to prevent, wearing a font instead of a claim. -->
<link rel="stylesheet" href="fonts/fonts.css">
<style>{style}</style>
<style>
  html,body {{ margin:0; padding:0; width:{W}px; height:{H}px; overflow:hidden; }}
  body {{ background:#080B0F; }}
  .og {{ position:relative; width:{W}px; height:{H}px;
         background:
           radial-gradient(900px 460px at 12% -10%, rgba(45,212,191,.13), transparent 60%),
           radial-gradient(760px 420px at 96% 8%, rgba(167,139,250,.14), transparent 62%),
           #080B0F;
         padding:48px 56px; box-sizing:border-box; display:flex; gap:20px; }}
  /* 500 + a 20px gutter, tuned WITH the figure's scale below so the card has
     even air on both sides — see that rule for the arithmetic. The floor on this
     width is the tile strip: 8 tiles per row needs 477px of content box, and at
     7 per row fifteen products spill into a third row that collides upward. */
  .og-left {{ width:500px; flex:0 0 500px; display:flex; flex-direction:column; }}
  .og-right {{ flex:1; display:flex; align-items:center; justify-content:center; }}
  .og-brand {{ display:flex; align-items:center; gap:12px; margin-bottom:30px; }}
  /* object-fit, and a box that matches the ASSET's aspect rather than restating
     it. This pair was 38x42 — the exact aspect of the old logo.png, which was a
     portrait canvas with the mark floating inside it. When logo.png was
     re-cropped to the mark's own 3:2, the pin silently stretched it 61% too
     tall. A box that hardcodes one asset's proportions is a second definition
     of that asset, and it does not travel when the asset is fixed. */
  .og-brand img {{ width:38px; height:26px; object-fit:contain; }}
  .og-brand .t1 {{ font: 600 11px/1.1 'JetBrains Mono',ui-monospace,monospace;
                   letter-spacing:.22em; text-transform:uppercase; color:#5EEAD4; }}
  .og-brand .t2 {{ font: 700 17px/1.45 'Space Grotesk','Inter',sans-serif; color:#F2F6F8;
                   margin-top:3px; letter-spacing:-.01em; }}
  /* 58px, not 54: the two lines are hard-broken, and at 58 the longer of them
     ("a point of view.") still measures ~410px inside a 520px column. Sized up
     with the portfolio strip below so the column reads as one filled composition
     rather than two islands with a hole between them. */
  .og h1 {{ font: 700 58px/1.14 'Space Grotesk','Inter',sans-serif;
            color:#F2F6F8; margin:0 0 24px; letter-spacing:-.02em; padding-bottom:.1em; }}
  /* The SAME gradient the live headline uses — teal -> blue -> violet. The old
     preview flattened this to one teal, which is half the brand. */
  .og h1 .grad {{ background:linear-gradient(96deg,#2DD4BF 0%,#5AA9E6 52%,#A78BFA 100%);
                  -webkit-background-clip:text; background-clip:text; color:transparent; }}
  .og .rule {{ width:330px; height:2px; margin:0 0 22px;
               background:linear-gradient(90deg,#2DD4BF,#A78BFA); border-radius:2px; }}
  .og p {{ font: 400 19px/1.55 'Inter',ui-sans-serif,-apple-system,sans-serif;
           color:#B9C6CE; margin:0; max-width:477px; }}
  /* THE PORTFOLIO, AS PICTURES. This column used to end with the fifteen product
     NAMES set in two 13px rows, absolutely positioned at the bottom — and above
     them sat a 204px hole, a third of the card's height, which is what Vanus saw
     as "a lot of empty space". Both halves of that were the same mistake: a link
     preview is drawn ~460px wide in a message bubble, where 13px becomes ~5px and
     no name is ever read, so the card spent its whole lower third on type nobody
     can see. Icons survive the downscale — each tile is still ~18px in that
     bubble and reads as a portfolio at a glance. The label is the live page's own
     strip label and the tiles are the live page's own icons, so this section
     mirrors the site exactly like the figure does.
     50px + 11px gap = 8 tiles per row inside 492px, so fifteen products land as
     8 + 7. Check the arithmetic if the count changes; a third row would collide
     with the paragraph above. */
  .og-apps {{ margin-top:auto; }}
  .og-apps .cap {{ font: 600 11px/1 'JetBrains Mono',ui-monospace,monospace;
                   letter-spacing:.18em; text-transform:uppercase; color:#7C8B95;
                   margin:0 0 16px; }}
  .og-apps .tiles {{ display:flex; flex-wrap:wrap; gap:11px; max-width:477px; }}
  .og-apps img {{ width:50px; height:50px; border-radius:13px; object-fit:cover;
                  border:1px solid rgba(255,255,255,.14);
                  background:rgba(255,255,255,.05);
                  box-shadow:0 3px 10px rgba(0,0,0,.45); }}
  /* The figure is the site's, so pin only its BOX — never its internals.
     Scaled UP, and that is the whole point: a link preview is rendered ~460px
     wide in a message bubble, and at that size the pipeline's three input cards
     turned to mush. The old orbital art survived shrinking because it was one
     bold ring saying nothing; this one carries real labels, so it has to be
     big enough to still read them. Checked by downscaling to preview width, not
     by looking at the 1200px render.
     1.17, retuned 2026-08-25 with the left column at 500: at 1.24 the 500px
     figure rendered 620 wide inside a 544px column, overhanging its box by 38px
     a side, so the card carried a 56px left margin against an 18px right one —
     an asymmetry that reads as "not quite right" without announcing why. The
     column is 568 wide now and 1.17 makes the figure 585, so it overhangs 8.5px
     and the right margin lands at ~47 against the left's 56. That costs 5.6% of
     the diagram's size, which at a 460px preview is 0.5px of glyph height on
     strings that are marginal at either scale — the balance is worth more than
     the half pixel. Re-derive both numbers together if either moves. */
  .og-right .context-engine {{ transform:scale(1.17); transform-origin:center; margin:0; }}
</style></head><body>
<div class="og">
  <div class="og-left">
    <div class="og-brand">
      <img src="logo.png" alt="">
      <div><div class="t1">Independent Product Studio</div><div class="t2">HyperSage AI Labs</div></div>
    </div>
    <h1>Software with<br><span class="grad">a point of view.</span></h1>
    <div class="rule"></div>
    <p>Distinctive consumer apps and original games.<br>Context-aware AI where it improves the product.</p>
    <div class="og-apps">
      <div class="cap">{cap}</div>
      <div class="tiles">{tiles}</div>
    </div>
  </div>
  <div class="og-right">{figure}</div>
</div>
</body></html>"""


STAMP = ROOT / "og-image.inputs.sha256"


def inputs_digest() -> str:
    """Hash exactly what the render is made of: the page's style block, its hero
    figure, and the product list. Nothing else about index.html matters — an FAQ
    edit must not report the preview as stale, and a change to the diagram must.

    The headline and og:title are in here too even though this file HARDCODES
    the left column: that is precisely why they belong. If the page's hero
    headline is rewritten, nothing about the lifted figure changes, and the
    preview would keep promising the old line in silence."""
    style, figure, products, icons, statuses, _ = site_parts()
    html = INDEX.read_text()
    h1 = re.search(r"<h1[^>]*>(.*?)</h1>", html, re.S)
    h1 = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", h1.group(1))).strip() if h1 else ""
    ogt = re.search(r'<meta property="og:title" content="([^"]*)"', html)
    h = hashlib.sha256()
    # Statuses are in here because the card COUNTS them. An app going live
    # changes no style, no figure and no name — without this the preview would
    # keep announcing the old number in silence, which is this stamp's whole job.
    for part in (style, figure, "\n".join(products), "\n".join(icons),
                 "\n".join(statuses), h1, ogt.group(1) if ogt else ""):
        h.update(part.encode())
        h.update(b"\0")
    # The brand mark is pixels in the card; a swapped logo.png must read as stale.
    # The fifteen app icons are pixels in it too, for exactly the same reason —
    # a redrawn icon changes what the card shows while every string stays put.
    for rel in ["logo.png"] + [s.split("?", 1)[0] for s in icons]:
        h.update((ROOT / rel).read_bytes())
        h.update(b"\0")
    return h.hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="verify the product list resolves AND that og-image.png "
                         "was rendered from the page as it stands now; render nothing")
    args = ap.parse_args()
    _, _, products, _, _, live = site_parts()
    print(f"{len(products)} products from index.html ({live} live): {', '.join(products)}")
    if args.check:
        # The failure this catches actually happened: the hero diagram's result
        # changed from "Fit to the task" to "The best possible answer", nobody
        # re-ran this, and every shared link kept promising the old thing. A
        # renderer that CAN stay in sync still needs something to notice when it
        # has not — same lesson as store frames going stale silently.
        want = inputs_digest()
        have = STAMP.read_text().strip() if STAMP.exists() else "(never stamped)"
        if want != have:
            sys.exit(f"og-image.png is STALE — the hero style/figure/products it was\n"
                     f"rendered from have changed since it was built.\n"
                     f"  stamped: {have}\n  current: {want}\n"
                     f"Fix: python3 tools/build_og.py   (then bump the ?v= cache-buster)")
        print(f"og-image.png is current ({have[:16]}…)")
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
        # SUPERSAMPLED. Rendered at 2x and resampled down to exactly WxH, because
        # a card drawn at 1x puts 17px text and a 26px mark on a whole-pixel grid:
        # descenders came out a single thin row and read as CHOPPED at the size a
        # message bubble actually shows this (~460px wide). Downsampling from 2x
        # gives those strokes real coverage. The file stays WxH — the site
        # auditor fails og-image.png at any other dimensions, and social scrapers
        # size against the declared og:image:width/height.
        pg = b.new_page(viewport={"width": W, "height": H}, device_scale_factor=2)
        pg.goto(tmp.as_uri())
        # The families are ours and self-hosted, but font-display:swap means the
        # first paint can still be fallback metrics. Screenshotting through that
        # window is how a card ends up in a typeface the site does not use.
        pg.wait_for_function("document.fonts.status === 'loaded'", timeout=10_000)
        # Every image must have actually DECODED. A missing icon still reports
        # complete=true with naturalWidth 0, so without this the card ships with
        # silent holes where products used to be — the failure mode this whole
        # renderer exists to prevent, in pixels instead of prose. Timing out
        # loudly is the correct outcome.
        pg.wait_for_function(
            "Array.from(document.images).every(i => i.complete && i.naturalWidth > 0)",
            timeout=10_000)
        pg.wait_for_timeout(700)          # let the figure's CSS animation settle
        shot = ROOT / "_og_2x.png"
        pg.screenshot(path=str(shot))
        b.close()
    from PIL import Image
    with Image.open(shot) as im:
        im.convert("RGB").resize((W, H), Image.LANCZOS).save(OUT, optimize=True)
    shot.unlink(missing_ok=True)
    tmp.unlink(missing_ok=True)
    # Stamp what this render was made of, so --check can tell later whether
    # the page moved on without it.
    STAMP.write_text(inputs_digest() + "\n")
    print(f"wrote {OUT.name}  {OUT.stat().st_size // 1024} KB  (stamped {STAMP.name})")


if __name__ == "__main__":
    main()
