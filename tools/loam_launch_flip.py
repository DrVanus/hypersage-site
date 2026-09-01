#!/usr/bin/env python3
"""Loam launch-day flip: coming-soon -> live, in the safe order.

Usage:
  python3 tools/loam_launch_flip.py --check                # anchors + preflight only
  python3 tools/loam_launch_flip.py --app-id 1234567890    # perform the flip

What it does (recipe verified against the live pages 2026-09-01):
  1. loam/index.html — all 5 notify-me mailto CTAs become App Store links
     (fleet pattern: styled text buttons, target=_blank rel=noopener; the
     fleet uses NO Apple badge image anywhere); hero eyebrow, FAQ answer,
     and cta lede flip to their live wording.
  2. Root index.html — the Loam grid card gains the 'live' status + a
     btn-store anchor; the rail entry drops its 'Coming soon' chip.
  3. sitemaps — lastmod bumped in loam/sitemap.xml (4 urls) AND the loam
     entry of the root sitemap index.
  4. og — build_app_og.py's loam kicker flips to '· iOS' AFTER the page has
     store links (its own check enforces that order), the card re-renders
     (og-image.inputs.sha256 restamps), and the og ?v= bumps.
  5. Runs audit_sites for loam + root and prints what remains manual.

HARD PREFLIGHTS (the flip refuses without them):
  - the App Store URL returns 200 (a dead store link is a rejection)
  - loam-app store.js has PLUS_ENABLED = true (the site must never lead the
    binary on PRICING surfaces; the same release also rewrites the two
    plus-dark flow_drive checks — see loam-app/store/subscriptions.md)
  - loam-api /healthz still serves the limits block (tier-parity stays probed)

Deliberately NOT automated: dollar amounts (the site never prints one —
rowan pattern: 'price and renewal terms are shown in the App Store');
terms.html's paid-tier hedge (legal pages deploy WITH the release, reworded
by hand); the fleet site-contract facts entry (a numbered allowance claim
may only ship once the enforcing constant is live — the snippet is printed
for fleet/site-contracts/loam.json).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOAM_APP = Path.home() / "Developer/DrVanus/loam-app"
MAILTO = "mailto:support@hypersage.ai?subject=Notify%20me%20when%20Loam%20launches"

def store_url(app_id: str) -> str:
    return f"https://apps.apple.com/app/id{app_id}"

# (anchor-that-must-exist-today, replacement-template) — {URL} substituted.
PAGE_EDITS = [
    # nav CTA
    ('<a href="' + MAILTO + '" class="btn-nav">Get notified</a>',
     '<a href="{URL}" target="_blank" rel="noopener" class="btn-nav" aria-label="Download Loam on the App Store">Download</a>'),
    # mobile menu
    ('<a href="' + MAILTO + '">Get notified at launch</a>',
     '<a href="{URL}" target="_blank" rel="noopener">Download on the App Store <span aria-hidden="true">↗</span></a>'),
    # hero button
    ('''<a href="''' + MAILTO + '''" class="btn-warm">
              <span>Be first to hear</span>
              <span aria-hidden="true">↗</span>
            </a>''',
     '''<a href="{URL}" target="_blank" rel="noopener" class="btn-warm" aria-label="Download Loam on the App Store">
              <span>Download on the App Store</span>
              <span aria-hidden="true">↗</span>
            </a>'''),
    # eyebrow
    ('<span class="eyebrow">Coming to iOS</span>',
     '<span class="eyebrow">On the App Store · iOS</span>'),
    # FAQ answer
    ('<p>Loam is coming to the App Store for iPhone. <a href="' + MAILTO + '">Email us</a> and we\'ll tell you the moment it\'s live.</p>',
     '<p>Now — <a href="{URL}" target="_blank" rel="noopener">Loam is on the App Store</a> for iPhone.</p>'),
    # FAQ question stays honest with the answer above
    ('<summary>When can I get it?</summary>',
     '<summary>Where can I get it?</summary>'),
    # cta band
    ('''<p class="lede">Be first to hear when Loam reaches the App Store.</p>''',
     '''<p class="lede">Loam is on the App Store for iPhone.</p>'''),
    ('''<a href="''' + MAILTO + '''" class="btn-warm">
          <span>Get notified at launch</span>
          <span aria-hidden="true">↗</span>
        </a>''',
     '''<a href="{URL}" target="_blank" rel="noopener" class="btn-warm" aria-label="Download Loam on the App Store">
          <span>Download on the App Store</span>
          <span aria-hidden="true">↗</span>
        </a>'''),
]

ROOT_EDITS = [
    ('<span class="status">iOS · Coming soon</span>',
     '<span class="status live">iOS · Live</span>'),
    ('<a class="link" aria-label="Visit the Loam site" href="loam/">Visit Loam <span aria-hidden="true">→</span></a>',
     '<a class="btn-store" target="_blank" rel="noopener" aria-label="Download Loam on the App Store" href="{URL}">Download on the App Store <span aria-hidden="true">↗</span></a>\n            <a class="link" aria-label="Visit the Loam site" href="loam/">Visit Loam <span aria-hidden="true">→</span></a>'),
    (' <span class="soon">Coming soon</span>', ''),
]

OG_KICKER = ('"kicker": "Notes, tended \\u00b7 Coming to iOS"', '"kicker": "Notes, tended \\u00b7 iOS"')

FACT_SNIPPET = {
    "id": "loam_free_allowance",
    "value": "five companion actions a day",
    "evidence": [
        "loam-app/store.js FREE_DAILY_ACTIONS = 5 (the client meter the paywall interpolates)",
        "loam-api /healthz limits.device_daily_free (server breaker above it)",
    ],
    "surfaces": ["index.html"],
    "forbidden_values": ["ten companion actions a day"],
    "_why": "add ONLY if launch copy names the number; keep the sentence one prose run so the audit's raw-substring check can see it",
}


def preflight(app_id: str | None, strict: bool) -> list[str]:
    problems = []
    idx = (ROOT / "loam/index.html").read_text()
    root_idx = (ROOT / "index.html").read_text()
    og = (ROOT / "tools/build_app_og.py").read_text()
    for anchor, _ in PAGE_EDITS:
        if anchor.format(URL="X") if False else anchor not in idx:
            problems.append(f"loam/index.html anchor missing: {anchor[:70]!r}")
    for anchor, _ in ROOT_EDITS:
        if anchor not in root_idx:
            problems.append(f"index.html anchor missing: {anchor[:70]!r}")
    if OG_KICKER[0] not in og:
        problems.append("build_app_og.py loam kicker anchor missing")
    if strict:
        sk = (LOAM_APP / "store.js").read_text()
        if not re.search(r"export const PLUS_ENABLED = true", sk):
            problems.append("loam-app store.js PLUS_ENABLED is not true — the site must not lead the binary on pricing surfaces")
        try:
            with urllib.request.urlopen("https://loam-api.fly.dev/healthz", timeout=10) as r:
                if "limits" not in json.load(r):
                    problems.append("loam-api /healthz lost its limits block")
        except Exception as e:
            problems.append(f"loam-api healthz unreachable: {e}")
        if app_id:
            req = urllib.request.Request(store_url(app_id), method="GET",
                                         headers={"User-Agent": "Mozilla/5.0"})
            try:
                with urllib.request.urlopen(req, timeout=15) as r:
                    if r.status != 200:
                        problems.append(f"store URL returned {r.status}")
            except Exception as e:
                problems.append(f"store URL failed: {e}")
    return problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--app-id", help="numeric App Store id (digits only)")
    ap.add_argument("--check", action="store_true", help="verify anchors/preflight, change nothing")
    args = ap.parse_args()

    if args.check:
        problems = preflight(args.app_id, strict=False)
        for p in problems: print("ANCHOR ROT:", p)
        print("check:", "FAIL" if problems else "ok — every flip anchor exists on today's pages")
        return 1 if problems else 0

    if not args.app_id or not args.app_id.isdigit():
        print("--app-id <digits> is required to flip"); return 2
    problems = preflight(args.app_id, strict=True)
    if problems:
        for p in problems: print("PREFLIGHT FAIL:", p)
        return 1

    url = store_url(args.app_id)
    today = dt.date.today().isoformat()
    stamp = today.replace("-", "") + "a"

    p = ROOT / "loam/index.html"; s = p.read_text()
    for anchor, repl in PAGE_EDITS:
        s = s.replace(anchor, repl.format(URL=url))
    p.write_text(s)

    p = ROOT / "index.html"; s = p.read_text()
    for anchor, repl in ROOT_EDITS:
        s = s.replace(anchor, repl.format(URL=url))
    p.write_text(s)

    for sm in (ROOT / "loam/sitemap.xml", ROOT / "sitemap.xml"):
        s = sm.read_text()
        if sm.parent == ROOT:  # index: only the loam entry
            s = re.sub(r"(loam/sitemap\.xml</loc>\s*<lastmod>)[0-9-]+", r"\g<1>" + today, s)
        else:
            s = re.sub(r"<lastmod>[0-9-]+", "<lastmod>" + today, s)
        sm.write_text(s)

    og = ROOT / "tools/build_app_og.py"; s = og.read_text()
    s = s.replace(OG_KICKER[0], OG_KICKER[1]); og.write_text(s)
    subprocess.run([sys.executable, str(og), "loam"], check=True, cwd=ROOT)
    p = ROOT / "loam/index.html"; s = p.read_text()
    s = re.sub(r"og-image\.png\?v=\w+", f"og-image.png?v={stamp}", s)
    p.write_text(s)

    subprocess.run([sys.executable, "tools/audit_sites.py"], cwd=ROOT)
    print(f"""
FLIPPED to {url}. Still manual, same release:
  - terms.html paid-tier hedge: reword by hand (legal ships WITH the release)
  - if launch copy names the free allowance, add this fact to
    fleet/site-contracts/loam.json:\n{json.dumps(FACT_SNIPPET, indent=2)}
  - commit + push hypersage-site, then VERIFY the Pages run rebuilt and
    diff the live page against the commit (a green run is not proof)
  - re-scrape the og (bump ?v= done; use a link-preview debugger)
  - fleet tier-parity + store/subscriptions.md same-release checklist""")
    return 0


if __name__ == "__main__":
    sys.exit(main())
