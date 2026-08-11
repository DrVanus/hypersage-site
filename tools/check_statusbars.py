#!/usr/bin/env python3
"""Flag phone screenshots whose STATUS BAR was captured without the marketing override.

    python3 tools/check_statusbars.py            # every subsite
    python3 tools/check_statusbars.py wingmate   # one

Why
---
Marketing captures are supposed to run under:

    xcrun simctl status_bar <udid> override --time "9:41" \\
        --batteryState discharging --batteryLevel 100 --cellularBars 4 --wifiBars 3

When a capture session forgets it, the shot ships the simulator's real status
bar. Two different tells, and looking for only one of them is how this hid:

  * `--batteryLevel 100` WITHOUT `--batteryState discharging` draws a GREEN
    CHARGING battery. That is what 50 images across five subsites shipped.
  * NO override at all leaves a plain white battery, the wall-clock time and
    (on a fresh sim) NO cellular bars. A green-fraction test reads that as
    perfectly clean — storyvault/tales-dark.jpg fooled exactly that test.

This tool detects the FIRST mode only, and that is deliberate. The second was
implemented and withdrawn: measuring ink in the cellular-bars band separates a
posed capture (~14%) from tales-dark.jpg (4.9%), but it cannot survive the
fleet's mix of shapes. mythkin's captures crop the status bar away entirely and
scored 0-3% — flagged as broken when nothing is wrong; wingmate's Dynamic
Island fills the middle band that the "is there even a status bar here" guard
depended on. A gate that reports nine false alarms to catch one real defect is
one people learn to skip, so the charging check — colour-specific, and confirmed
by eye on wingmate and storyvault — ships alone.

To catch the second mode, LOOK at the top strip of any screenshot you are about
to publish: the clock must read 9:41 and the cellular bars must be present.
storyvault/tales-dark.jpg (10:28, no bars) is the worked example.

It reports; it never edits. Fixing means re-capturing from the app.
"""
from __future__ import annotations

import pathlib
import sys

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITES = ["quietoak", "rowan", "wingmate", "alder", "waddleton", "mythkin",
         "hexhunter", "nightshelf", "mythwright", "storyvault", "saffra"]


def is_phone_shot(im: Image.Image) -> bool:
    w, h = im.size
    return h >= 600 and 0.42 < w / h < 0.52


def measure(im: Image.Image) -> dict:
    w, h = im.size
    bar = im.crop((0, int(h * 0.010), w, int(h * 0.048))).convert("RGB")
    bw, bh = bar.size

    right = bar.crop((int(bw * 0.72), 0, bw, bh))
    px = list(right.getdata())
    green = sum(1 for r, g, b in px if g > 110 and g > r + 35 and g > b + 35) / max(1, len(px))

    return {"green": green}


def main() -> int:
    picked = [a for a in sys.argv[1:] if not a.startswith("-")] or SITES
    bad: list[tuple[str, str]] = []
    for site in picked:
        for f in sorted((ROOT / site).rglob("*")):
            if f.suffix.lower() not in (".jpg", ".jpeg", ".png"):
                continue
            try:
                im = Image.open(f)
            except Exception:
                continue
            if not is_phone_shot(im):
                continue
            m = measure(im)
            why = None
            if m["green"] > 0.008:
                why = f"CHARGING battery (green {m['green']*100:.2f}%)"
            if why:
                rel = str(f.relative_to(ROOT))
                bad.append((rel, why))
                print(f"FAIL {rel:52} {why}")
    print()
    if bad:
        print(f"{len(bad)} screenshot(s) ship a CHARGING battery. Re-capture from "
              f"the app with the override above, and eyeball the clock and "
              f"cellular bars while you are in there (see the module docstring).")
        return 1
    print("every phone screenshot carries a posed status bar")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
