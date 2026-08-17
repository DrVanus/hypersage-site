#!/usr/bin/env python3
"""Drive the Mythkin hero rotation in a real browser.

WHY THIS EXISTS. The hero rotates through ten characters on a timer, and every
failure mode of a timer is silent: a stuck carousel, a carousel nobody can stop,
one that keeps running under Reduce Motion, one that keeps burning a timer in a
background tab. None of them throws, and `--check` cannot see any of them
because the markup is identical either way.

It also exists because the first attempt to verify this by hand was WRONG in a
way worth writing down: driven through an embedded review pane, the page
reported `document.hidden === true`, so the rotation correctly refused to run
and the probe read that as "the rotation is broken". The pane was the pause.
Playwright pages are visible, so this measures the code.

    python3 tools/mythkin_hero_drive.py
"""
from __future__ import annotations

import http.server
import socketserver
import sys
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DWELL_MS = 7000

fails: list[str] = []


def check(ok: bool, label: str, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + (f"  ({detail})" if detail else ""))
    if not ok:
        fails.append(label)


def serve(root: Path):
    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *a, **kw):
            super().__init__(*a, directory=str(root), **kw)

        def log_message(self, *a):
            pass

        def copyfile(self, source, outputfile):
            # Closing a page mid-response raises BrokenPipeError out of the
            # body write and dumps a traceback into the middle of the results.
            # It is the test tearing down, not a failure — and a gate whose PASS
            # lines are buried in noise is a gate people stop reading.
            # Caught HERE rather than in handle_error, which does not see it:
            # the exception escapes from inside do_GET's own body copy.
            try:
                super().copyfile(source, outputfile)
            except (BrokenPipeError, ConnectionResetError):
                pass

    httpd = socketserver.TCPServer(("127.0.0.1", 0), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, httpd.server_address[1]


NAME = """() => {
  const s = [...document.querySelectorAll('#lit-frame .slide')];
  const i = s.findIndex(x => x.classList.contains('on'));
  return i < 0 ? null : s[i].querySelector('.quote b').textContent;
}"""


def main() -> int:
    from playwright.sync_api import sync_playwright

    httpd, port = serve(ROOT)
    url = f"http://127.0.0.1:{port}/mythkin/"

    with sync_playwright() as p:
        b = p.chromium.launch()

        # ---- it rotates, and exactly one slide is ever shown
        pg = b.new_page(viewport={"width": 1280, "height": 900})
        pg.goto(url, wait_until="load")
        pg.wait_for_timeout(600)
        n = pg.eval_on_selector_all("#lit-frame .slide", "e => e.length")
        check(n >= 5, "the hero holds a cast, not a portrait", f"{n} slides")

        first = pg.evaluate(NAME)
        seen = [first]
        for _ in range(3):
            pg.wait_for_timeout(DWELL_MS + 1200)
            cur = pg.evaluate(NAME)
            if cur != seen[-1]:
                seen.append(cur)
        check(len(seen) >= 3, "it advances on its own", " -> ".join(map(str, seen)))
        check(len(set(seen)) == len(seen), "and does not repeat inside one lap",
              " -> ".join(map(str, seen)))
        one_on = pg.eval_on_selector_all(
            "#lit-frame .slide", "e => e.filter(x => x.classList.contains('on')).length")
        hidden = pg.eval_on_selector_all(
            "#lit-frame .slide",
            "e => e.filter(x => x.getAttribute('aria-hidden') === 'true').length")
        check(one_on == 1 and hidden == n - 1,
              "exactly one slide is shown, and the rest are hidden from a reader",
              f"on={one_on} aria-hidden={hidden}")

        # ---- WCAG 2.2.2: it can be stopped, and stopping it stops it
        pg.click("#lit-pause")
        held = pg.evaluate(NAME)
        state = pg.get_attribute("#lit-pause", "data-state")
        label = pg.get_attribute("#lit-pause", "aria-label")
        pg.wait_for_timeout(DWELL_MS + 2500)
        check(pg.evaluate(NAME) == held and state == "paused",
              "pause holds the slide it was pressed on", f"{held!r}")
        check("resume" in (label or "").lower(),
              "and the button then offers to resume", f"{label!r}")
        pg.click("#lit-pause")
        pg.wait_for_timeout(DWELL_MS + 2500)
        check(pg.evaluate(NAME) != held, "resume starts it again")
        pg.close()

        # ---- Reduce Motion: it never starts, and the control stands down
        pg = b.new_page(viewport={"width": 1280, "height": 900},
                        reduced_motion="reduce")
        pg.goto(url, wait_until="load")
        pg.wait_for_timeout(600)
        start = pg.evaluate(NAME)
        pg.wait_for_timeout(DWELL_MS * 2 + 1500)
        check(pg.evaluate(NAME) == start,
              "Reduce Motion means it never moves", f"{start!r}")
        check(pg.get_attribute("#lit-pause", "hidden") is not None,
              "and there is no pause control for a thing that is not moving")
        pg.close()

        # ---- the byline is a byline, not a quotation, on every slide
        pg = b.new_page(viewport={"width": 1280, "height": 900})
        pg.goto(url, wait_until="load")
        bylines = pg.eval_on_selector_all(
            "#lit-frame .slide .quote span",
            "e => e.map(x => x.textContent.replace(/\\s+/g, ' ').trim())")
        bad = [t for t in bylines if "written for Mythkin" not in t]
        check(not bad,
              "every painted first-person line says who wrote it",
              f"{len(bad)} without a byline: {bad[:2]}")
        # And no slide still carries the old blanket "AI character" badge where
        # the room belongs. `all(rooms)` was the first version of this and it
        # PASSED the mutation that put "AI character" back — a non-empty string
        # is not a room, and a check that only asserts presence cannot see a
        # wrong value ([[a-gate-that-asserts-presence-not-property]]). The set
        # is closed, so name it.
        rooms = pg.eval_on_selector_all(
            "#lit-frame .room-chip", "e => e.map(x => x.textContent.trim())")
        known = {"Storybook", "Legends", "History", "Scripture", "Originals"}
        stray = sorted(set(rooms) - known)
        check(len(rooms) == n and not stray,
              "and names a real room, not a badge", f"stray={stray or None}")

        # THE QUOTE MAY NOT EAT THE FACE, and this is measured in PIXELS rather
        # than in characters because characters were what failed. The greetings
        # live in the product's seed and get rewritten there: a pass on
        # 2026-08-17 took Sherlock's opening line from ~100 characters to 274,
        # and the block climbed most of a square portrait, out of the scrim it
        # needs for legibility, over the face it is captioning. The builder now
        # trims to whole sentences under a budget — but a budget is arithmetic
        # about a font it cannot see, so the thing that must hold is the
        # rendered fraction. 55% leaves the top of every painting clear.
        tall = pg.evaluate("""() => {
          const f = document.getElementById('lit-frame');
          const h = f.getBoundingClientRect().height;
          return [...f.querySelectorAll('.slide')].map(s => {
            const q = s.querySelector('.quote').getBoundingClientRect().height;
            return { who: s.querySelector('.quote b').textContent,
                     pct: Math.round(q / h * 100) };
          }).filter(x => x.pct > 55);
        }""")
        check(not tall, "no quote covers more than 55% of its portrait",
              ", ".join(f"{t['who']} {t['pct']}%" for t in tall) or "worst is under")
        pg.close()

        # ---- the marquee does not drift holes through itself
        # The strip carries the whole roster and moves by `transform`, which
        # native lazy-loading tracks badly: tiles arrive without a scroll event,
        # so the loader runs behind the animation and blank plates ride through
        # the visible band. Measured over a minute rather than at load, because
        # at load it looked fine — and the screenshot rig forced every image
        # eager before shooting, so no capture could ever have shown it.
        # Only tiles FULLY inside the un-masked band count: .marquee fades to
        # transparent outside 8%..92%, and a plate under the fade is not
        # something a reader can see.
        band = """() => {
          const im = [...document.querySelectorAll('.mrow img')];
          const lo = innerWidth * 0.08, hi = innerWidth * 0.92;
          const v = im.filter(i => { const r = i.getBoundingClientRect();
            return r.left >= lo && r.right <= hi && r.bottom > 0 && r.top < innerHeight; });
          return { seen: v.length, blank: v.filter(i => i.naturalWidth === 0).length };
        }"""
        for label, vp, scroll in (("desktop", {"width": 1280, "height": 900}, 0),
                                  ("phone", {"width": 402, "height": 874}, 900)):
            pg = b.new_page(viewport=vp, device_scale_factor=2)
            pg.goto(url, wait_until="load")
            if scroll:
                pg.evaluate(f"window.scrollTo(0, {scroll})")
            worst, prev, least = 0, 0, 10 ** 6
            for t in (2, 12, 30, 50):
                pg.wait_for_timeout((t - prev) * 1000)
                prev = t
                v = pg.evaluate(band)
                worst = max(worst, v["blank"])
                least = min(least, v["seen"])
            check(worst == 0 and least > 0,
                  f"[{label}] no blank plate rides through the marquee",
                  f"worst {worst} blank of {least}+ visible over 50s")
            pg.close()

        b.close()
    httpd.shutdown()

    print()
    if fails:
        print(f"MYTHKIN-HERO-DRIVE: {len(fails)} FAILED")
        return 1
    print("MYTHKIN-HERO-DRIVE: PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
