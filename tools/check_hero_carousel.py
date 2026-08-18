#!/usr/bin/env python3
"""Assert a subsite's hero carousel never shows an empty phone frame.

    python3 tools/check_hero_carousel.py               # every site that has one
    python3 tools/check_hero_carousel.py holohound     # named sites only

WHY THIS EXISTS. Holohound shipped with keyframes that ramped each screenshot
from opacity 1 to 0 across the first 22% of the cycle and left it at 0 for the
remaining 78%. Every image loaded (200 OK, correct natural size, correct box),
every link resolved, and site_audit.py passed — the defect was purely in the
TIMING, so nothing static could see it. The live page measured 0.15/0/0/0 and
the hero device read as a broken image. Vanus reported it as "screenshots
broken"; it took sampling the animation to find out what was actually wrong.

WHAT IT MEASURES, and why it is not max-opacity. During a legitimate crossfade
two stacked screenshots overlap, so the single largest opacity dips well below 1
while the frame is still completely covered. Gating on max-opacity therefore
fails a healthy carousel. The honest quantity is COMPOSITE coverage of the
stack, 1 - prod(1 - alpha), which is what a viewer actually sees over the
device's own background. Three assertions, because one is not enough:

  1. coverage never drops below COVERAGE_FLOOR  — the frame is never near-empty;
  2. a fully-visible screenshot is on screen for most of the cycle — catches a
     carousel that technically always has *something* faintly painted but never
     settles on a readable frame;
  3. the FIRST sample is a fully-visible screenshot — a cycle starting at the 0%
     stop paints an empty phone for the first quarter-second of every page load,
     which is the one moment the hero has to land. This one caught a second,
     separate defect after the keyframes were already fixed.

The server is started here rather than assumed, so the gate cannot silently
measure a stale build someone else happens to be serving.
"""

from __future__ import annotations

import functools
import http.server
import pathlib
import re
import socket
import socketserver
import sys
import threading

REPO = pathlib.Path(__file__).resolve().parent.parent

COVERAGE_FLOOR = 0.70   # composite coverage of the stacked images
SETTLED_FLOOR = 0.85    # "this screenshot is readable, not mid-fade"
MIN_SETTLED_FRACTION = 0.70
SAMPLES = 25


def sites_with_carousel(names: list[str]) -> list[str]:
    found = []
    for d in sorted(p for p in REPO.iterdir() if p.is_dir()):
        if d.name.startswith((".", "_")):
            continue
        index = d / "index.html"
        if index.exists() and "hero-carousel" in index.read_text(errors="replace"):
            found.append(d.name)
    return [n for n in found if n in names] if names else found


def serve(root: pathlib.Path):
    handler = functools.partial(http.server.SimpleHTTPRequestHandler,
                                directory=str(root))
    with socket.socket() as s:          # let the OS pick a free port
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]

    class Quiet(socketserver.TCPServer):
        allow_reuse_address = True

    httpd = Quiet(("127.0.0.1", port), handler)
    httpd.RequestHandlerClass.log_message = lambda *a, **k: None
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, port


def check(page, name: str) -> list[str]:
    page.wait_for_function(
        "Array.from(document.querySelectorAll('.hero-carousel img'))"
        ".every(i => i.complete && i.naturalWidth > 0)", timeout=20000)

    n_imgs = page.evaluate(
        "document.querySelectorAll('.hero-carousel img').length")
    duration = page.evaluate(
        "getComputedStyle(document.querySelector('.hero-carousel img'))"
        ".animationDuration")
    secs = float(re.match(r"([\d.]+)", duration).group(1)) if duration else 0.0
    if secs <= 0:
        print(f"     {n_imgs} image(s), no animation — static hero, nothing to sample")
        return []

    interval = secs / SAMPLES
    rows = []
    for i in range(SAMPLES):
        vals = page.evaluate(
            "Array.from(document.querySelectorAll('.hero-carousel img'))"
            ".map(im => parseFloat(getComputedStyle(im).opacity))")
        coverage = 1.0
        for v in vals:
            coverage *= (1.0 - v)
        rows.append((round(i * interval, 2), max(vals), 1.0 - coverage))
        page.wait_for_timeout(int(interval * 1000))

    thin = [r for r in rows if r[2] < COVERAGE_FLOOR]
    settled = [r for r in rows if r[1] >= SETTLED_FLOOR]
    fraction = len(settled) / len(rows)

    print(f"     {n_imgs} image(s) over {secs:g}s · min coverage "
          f"{min(r[2] for r in rows):0.3f} · fully visible "
          f"{len(settled)}/{len(rows)} · t=0 {rows[0][1]:0.2f}")

    problems = []
    if thin:
        worst = min(thin, key=lambda r: r[2])
        problems.append(
            f"frame is near-empty at t={worst[0]}s (coverage {worst[2]:0.3f} "
            f"< {COVERAGE_FLOOR}) — {len(thin)} of {len(rows)} samples")
    if fraction < MIN_SETTLED_FRACTION:
        problems.append(
            f"only {len(settled)}/{len(rows)} samples ({fraction:.0%}) show a "
            f"fully-visible screenshot, need {MIN_SETTLED_FRACTION:.0%}")
    if rows[0][1] < SETTLED_FLOOR:
        problems.append(
            f"first paint is not a fully-visible screenshot "
            f"(opacity {rows[0][1]:0.3f}) — the hero loads empty")
    return problems


def main(argv: list[str]) -> int:
    names = [a for a in argv if not a.startswith("-")]
    targets = sites_with_carousel(names)
    unknown = set(names) - set(targets)
    if unknown:
        have = ", ".join(sites_with_carousel([])) or "(none)"
        sys.exit(f"no hero carousel in: {', '.join(sorted(unknown))} — have: {have}")
    if not targets:
        print("no subsite has a .hero-carousel")
        return 0

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        sys.exit("playwright is required: pip install playwright && playwright install chromium")

    httpd, port = serve(REPO)
    bad = 0
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            pg = browser.new_page(viewport={"width": 1280, "height": 800})
            for name in targets:
                print(f"---> {name}")
                pg.goto(f"http://127.0.0.1:{port}/{name}/")
                problems = check(pg, name)
                if problems:
                    bad += 1
                    print(f"FAIL {name}")
                    for p in problems:
                        print(f"       - {p}")
                else:
                    print(f"ok   {name}")
            browser.close()
    finally:
        httpd.shutdown()

    print(f"\n{len(targets)} carousel(s) checked, {bad} failing")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
