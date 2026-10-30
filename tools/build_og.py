"""Render the 1200x630 social preview from the studio homepage.

    python3 tools/build_og.py
    python3 tools/build_og.py --check

The heading, introduction, aurora, product screenshots and icon roster come
from index.html. The digest covers their source and image bytes, local fonts
and this renderer so the card cannot silently drift behind the page.
"""
from __future__ import annotations

import argparse
import hashlib
import pathlib
import re
import sys
from urllib.parse import unquote, urlsplit

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
    "loam": "Loam",
}


def site_parts() -> tuple[str, str, list[str], list[str], str]:
    html = INDEX.read_text()
    style = re.search(r"<style>(.*?)</style>", html, re.S)
    if not style:
        sys.exit("no <style> block in index.html")
    fig = re.search(r'(<figure class="product-universe".*?</figure>)', html, re.S)
    if not fig:
        sys.exit("no .product-universe figure in index.html — the product showcase moved")
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
    # The strip's label is the portfolio section's own eyebrow, and it carries NO
    # COUNT. It used to read "16 apps and games · 10 live now", counted off the
    # page's status chips. A number inside a picture is a claim that goes stale
    # between rebuilds and then sits in X's card cache for a week per URL, and
    # Vanus judged a count unprofessional on the page itself (2026-09-13), so the
    # page's at-a-glance band dropped its numbers in the same change.
    cap = re.search(r'id="products".{0,400}?class="eyebrow">([^<]+)<', html, re.S)
    if not cap:
        sys.exit("no eyebrow in the #products section — the strip label has no source")
    return (style.group(1), fig.group(1), [NAMES[i] for i in seen],
            [icons[i] for i in seen], cap.group(1).strip())


def build_html() -> str:
    """Compose the social card from the live heading, copy, showcase and icons."""
    style, figure, products, icons, cap = site_parts()
    source = INDEX.read_text()
    headline = re.search(r"<h1[^>]*>(.*?)</h1>", source, re.S).group(1)
    lede = re.search(r'<p class="lede">(.*?)</p>', source, re.S).group(1)
    aurora = re.search(r'(<div class="aurora-scene".*?</div>)', source, re.S).group(1)
    tiles = "".join(f'<img src="{src}" alt="">' for src in icons)
    return f"""<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="fonts/fonts.css"><style>{style}</style>
<style>
html,body {{margin:0;width:1200px;height:630px;overflow:hidden}}
body::before {{display:none}}
.og {{position:relative;isolation:isolate;width:1200px;height:630px;padding:36px 48px;background:#080B14}}
.og .aurora-scene {{inset:-50px;opacity:.85}}
.og-brand {{display:flex;align-items:center;gap:12px;font-size:21px;font-weight:650;margin-bottom:14px}}
.og-brand img {{width:40px;height:27px;object-fit:contain}}
.og-brand span {{color:#9AA8BE;font-weight:400}}
.og-hero {{display:grid;grid-template-columns:1fr 1fr;align-items:center;gap:30px;height:448px}}
.og h1 {{font-size:54px;line-height:1.06;font-weight:650;letter-spacing:-.055em;margin:0 0 22px}}
.og h1 .hero-line {{display:block}}
.og .lede {{font-size:17px;line-height:1.65;color:var(--muted);max-width:490px}}
.og .grad-text {{background-image:linear-gradient(105deg,#81E3D2,#9EB7F9 60%,#CFABF5)}}
.og .product-universe {{grid-area:auto;width:94%;height:448px;margin:0}}
.og .showcase-stage {{height:448px}}
.og .showcase-controls,.og .showcase-note {{display:none}}
.og .phone-left,.og .phone-right {{top:50px}}
.og .phone-night {{top:8px}}
.og .phone-caption {{font-size:12px;margin-top:12px}}
.og .phone-caption small {{display:none}}
.og .phone-caption span[aria-hidden] {{display:none}}
.og .phone-glass {{padding:4px;border-radius:23px}}
.og .phone-glass img {{border-radius:19px}}
.og-apps {{border-top:1px solid #FFFFFF15;display:flex;align-items:center;gap:18px;margin-top:18px;padding-top:15px}}
.og-apps .cap {{font:10px 'JetBrains Mono',monospace;text-transform:uppercase;letter-spacing:.15em;color:#A9B5C9;white-space:nowrap}}
.og-apps .tiles {{display:flex;gap:12px}}
.og-apps img {{width:34px;height:34px;border-radius:9px;border:1px solid #FFFFFF25}}
</style></head><body><div class="og">
{aurora}
<div class="og-brand"><img src="logo.png" alt="">HyperSage <span>AI Labs</span></div>
<div class="og-hero"><div><h1>{headline}</h1><p class="lede">{lede}</p></div>{figure}</div>
<div class="og-apps"><div class="cap">{cap}</div><div class="tiles">{tiles}</div></div>
</div></body></html>"""


STAMP = ROOT / "og-image.inputs.sha256"


def inputs_digest() -> str:
    """Hash the rendered source, image bytes, fonts and renderer configuration."""
    style, figure, products, icons, cap = site_parts()
    html = INDEX.read_text()
    h1 = re.search(r"<h1[^>]*>(.*?)</h1>", html, re.S)
    h1 = h1.group(1) if h1 else ""
    ogt = re.search(r'<meta property="og:title" content="([^"]*)"', html)
    h = hashlib.sha256()
    # Lifecycle chips are deliberately NOT in here any more: the card stopped
    # counting them, so an app going live changes no pixel, and a stale verdict
    # would only force a ?v= bump on identical bytes.
    for part in (style, figure, "\n".join(products), "\n".join(icons), cap,
                 h1, ogt.group(1) if ogt else "",
                 re.search(r'<p class="lede">(.*?)</p>', html, re.S).group(1),
                 re.search(r'(<div class="aurora-scene".*?</div>)', html, re.S).group(1)):
        h.update(part.encode())
        h.update(b"\0")
    # The brand mark is pixels in the card; a swapped logo.png must read as stale.
    # The app icons are pixels in it too, for exactly the same reason — a redrawn
    # icon changes what the card shows while every string stays put.
    # Screenshot bytes participate, so replacing a frame invalidates the card.
    shots = re.findall(r'<img[^>]+src="([^"]+)"', figure)
    for rel in ["logo.png"] + [s.split("?", 1)[0] for s in icons + shots]:
        h.update((ROOT / rel).read_bytes())
        h.update(b"\0")
    # The renderer supplies its own layout overrides, and the linked font CSS
    # and local font files supply the actual type. Changes to any of them must
    # invalidate the preview even when the homepage itself has not changed.
    font_css = ROOT / "fonts/fonts.css"
    render_files = [pathlib.Path(__file__).resolve(), font_css]
    for ref in re.findall(r"url\(\s*['\"]?([^'\"\s)]+)['\"]?\s*\)", font_css.read_text()):
        url = urlsplit(ref)
        if url.scheme or url.netloc:
            continue
        path = unquote(url.path)
        render_files.append(ROOT / path.lstrip("/") if path.startswith("/")
                            else font_css.parent / path)
    for path in dict.fromkeys(render_files):
        h.update(path.read_bytes())
        h.update(b"\0")
    return h.hexdigest()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="verify the product list resolves AND that og-image.png "
                         "was rendered from the page as it stands now; render nothing")
    args = ap.parse_args()
    _, _, products, _, cap = site_parts()
    print(f"{len(products)} products from index.html under “{cap}”: {', '.join(products)}")
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
