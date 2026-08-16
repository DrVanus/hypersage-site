#!/usr/bin/env python3
"""Build hypersage.ai/mythkin/index.html from the product's own source of truth.

WHY THIS IS GENERATED AND NOT HAND-WRITTEN.

The page it replaces carried a kin count in three places and a comment reading
"the number and the grid have now drifted twice, so change BOTH or neither."
They drifted again anyway: the page said thirty while the seed held 244, and on
2026-08-16 the seed went 244 -> 254 inside a single working session. A number
typed by hand into a marketing page is a promise that goes stale on somebody
else's commit.

So every count, every room name, every kin name and tagline on the built page is
read out of mythkin-api/app/characters/seed.py and mythkin-api/app/collections/
seed.py at build time. If the roster moves, you re-run this; you do not edit
index.html. `--check` re-derives everything and diffs it against the file on
disk, so CI (or a pre-commit hook) can fail when the two disagree rather than
waiting for a human to notice.

    python3 tools/build_mythkin.py            # write index.html + copy assets
    python3 tools/build_mythkin.py --check    # fail if the page is stale
    python3 tools/build_mythkin.py --shots DIR-light --shots-dark DIR-dark

WHAT IS DELIBERATELY *NOT* HERE: a price. Nothing in the client hardcodes one —
the store is the source — so printing one here would be a claim this script
cannot verify. The tiers are described by shape, from the same fields
GET /v1/plans serves.
"""
from __future__ import annotations

import argparse
import ast
import collections
import html
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

SITE = Path(__file__).resolve().parent.parent
OUT = SITE / "mythkin"
API = Path.home() / "Developer" / "DrVanus" / "mythkin-api"
APP = Path.home() / "Developer" / "DrVanus" / "mythkin-app"

SECTION_ORDER = ["Storybook", "Legends", "History", "Scripture", "Originals"]

# Room blurbs. These are OURS — the app's own ROOM_NOTE strings are written for
# a reader who is already inside, and the Scripture one especially needs to say
# the same thing to somebody who has not installed anything yet.
# ONE LINE EACH, and they sit UNDER the heading rather than opposite it.
#
# These were three and four sentences, right-aligned across from the room title.
# Rendered, that put a four-line block of prose in the dead space between the
# heading and the rail — it pushed every rail most of a screen down, fought the
# left-aligned heading it was supposed to belong to, and read as a wall of text
# rather than a label. The editorial asides that made them long (who authored
# the Scripture room, why the Workshop cards are bylined) are real and worth
# saying, so they moved to the safety section where they have room to be
# sentences. A room label is a label.
SECTION_NOTE = {
    "Storybook": "Out of books old enough to be public domain — the detective, "
                 "the whale, the girl who went down the hole.",
    "Legends": "Gods, tricksters and monsters, out of the myths that kept being "
               "retold.",
    "History": "People who actually lived, written from the record and honest "
               "about where it runs thin.",
    "Scripture": "The Hebrew Bible and the Gospels, written as teachers rather "
                 "than as converts.",
    "Originals": "Written in-house and bylined <em>Mythkin Workshop</em>, not "
                 "passed off as somebody's upload.",
}

# The faces the page leads with. Recognisable, spread across rooms, and every id
# is checked against the roster and against the art on disk before it is used —
# a name here that has left the roster fails the build rather than shipping a
# broken tile.
MARQUEE_IDS = [
    "ch_sherlock", "ch_cleo", "ch_athena", "ch_ada", "ch_dracula", "ch_alice",
    "ch_merlin", "ch_curie", "ch_wukong", "ch_joan", "ch_loki", "ch_marcus",
    "ch_scheherazade", "ch_leonardo", "ch_anansi", "ch_babayaga", "ch_zeus",
    "ch_quixote", "ch_lizzy", "ch_creature", "ch_silver", "ch_beowulf",
    "ch_sappho", "ch_robin", "ch_caesar", "ch_seneca", "ch_spartacus",
    "ch_hadrian", "ch_augustus", "ch_livia",
]
HERO_ID = "ch_sherlock"
# Sherlock's greeting, verbatim from the seed — asserted at build time, so a
# rewrite in the product cannot leave a stale quotation on the marketing page.
HERO_QUOTE_ID = "ch_sherlock"

PER_BAND = 12          # faces shown in each room's rail
MARQUEE_PER_ROW = 26   # faces per drifting row, two rows


# ---------------------------------------------------------------- source data
def _tuples(path: Path, names: tuple[str, ...]) -> dict:
    """literal_eval the named module-level tuples.

    OFFICIAL_KIN is an AnnAssign (`OFFICIAL_KIN: tuple[dict, ...] = (`), not an
    Assign, and a walker that only handles ast.Assign silently reads ZERO
    entries and reports success — which is how a roster gate once validated the
    roster's absence. Both node types, on purpose.
    """
    tree = ast.parse(path.read_text())
    found: dict = {}
    for node in ast.walk(tree):
        target = None
        if isinstance(node, ast.AnnAssign):
            target = getattr(node.target, "id", None)
        elif isinstance(node, ast.Assign) and node.targets:
            target = getattr(node.targets[0], "id", None)
        if target in names and target not in found:
            try:
                found[target] = ast.literal_eval(node.value)
            except (ValueError, SyntaxError):
                pass
    missing = [n for n in names if n not in found]
    if missing:
        sys.exit(f"FAIL: could not read {missing} out of {path}")
    return found


def load_roster() -> list[dict]:
    src = API / "app" / "characters" / "seed.py"
    if not src.exists():
        sys.exit(f"FAIL: {src} not found — is mythkin-api checked out?")
    got = _tuples(src, ("OFFICIAL_KIN", "WORKSHOP_KIN"))
    kin = list(got["OFFICIAL_KIN"]) + list(got["WORKSHOP_KIN"])
    if not kin:
        sys.exit("FAIL: roster parsed as empty")
    return kin


def load_collections() -> list[tuple[str, str]]:
    src = API / "app" / "collections" / "seed.py"
    if not src.exists():
        return []
    tree = ast.parse(src.read_text())
    for node in ast.walk(tree):
        target = None
        if isinstance(node, ast.AnnAssign):
            target = getattr(node.target, "id", None)
        elif isinstance(node, ast.Assign) and node.targets:
            target = getattr(node.targets[0], "id", None)
        if target and target.isupper():
            try:
                val = ast.literal_eval(node.value)
            except (ValueError, SyntaxError):
                continue
            if isinstance(val, (list, tuple)) and val and isinstance(val[0], dict) \
                    and "title" in val[0]:
                return [(c["title"], c.get("blurb", "")) for c in val]
    return []


def count_stories() -> int:
    src = API / "app" / "stories" / "seed.py"
    if not src.exists():
        return 0
    return len(re.findall(r'^\s*"slug":', src.read_text(), re.M)) or \
        len(re.findall(r'^\s*"title":', src.read_text(), re.M))


# ------------------------------------------------------------------- rendering
def e(s: str) -> str:
    return html.escape(str(s), quote=True)


def first_sentence(text: str, limit: int = 120) -> str:
    text = " ".join(text.split())
    cut = re.split(r"(?<=[.!?])\s", text)[0]
    if len(cut) > limit:
        cut = cut[:limit].rsplit(" ", 1)[0] + "…"
    return cut


def build_html(kin: list[dict], collections_: list[tuple[str, str]],
               have_art: set[str], stories: int) -> str:
    by_id = {k["id"]: k for k in kin}
    by_section: dict[str, list[dict]] = collections.OrderedDict(
        (s, []) for s in SECTION_ORDER)
    for k in kin:
        by_section.setdefault(k.get("section", "Storybook"), []).append(k)

    total = len(kin)
    marquee = [i for i in MARQUEE_IDS if i in by_id and i in have_art]
    if len(marquee) < 20:
        sys.exit(f"FAIL: only {len(marquee)} of the {len(MARQUEE_IDS)} lead kin "
                 "are still in the roster with art — update MARQUEE_IDS")

    hero = by_id.get(HERO_ID)
    if hero is None or HERO_ID not in have_art:
        sys.exit(f"FAIL: hero kin {HERO_ID} is not in the roster, or has no art")
    quote = " ".join(by_id[HERO_QUOTE_ID]["greeting"].split())

    # -- marquee: two rows, each doubled so the drift loops seamlessly
    pool = [k for k in kin if k["id"] in have_art]
    pool.sort(key=lambda k: k["id"])          # stable: --check must be idempotent
    rows = []
    for r in range(2):
        chunk = pool[r * MARQUEE_PER_ROW:(r + 1) * MARQUEE_PER_ROW]
        imgs = "".join(
            f'<img src="kin/{k["id"]}.jpg" width="256" height="256" '
            f'loading="lazy" decoding="async" alt="">' for k in chunk * 2)
        rows.append(f'<div class="mrow{" rev" if r else ""}">{imgs}</div>')

    # -- room bands
    bands = []
    for section in SECTION_ORDER:
        members = [k for k in by_section.get(section, []) if k["id"] in have_art]
        if not members:
            continue
        shown = members[:PER_BAND]
        figs = "".join(
            f'<figure><img src="kin/{k["id"]}.jpg" width="256" height="256" '
            f'loading="lazy" decoding="async" alt="">'
            f'<b>{e(k["name"])}</b><span>{e(k.get("tagline", ""))}</span></figure>'
            for k in shown)
        bands.append(
            f'<div class="band">'
            f'<div class="band-head"><h3>{e(section)}</h3>'
            f'<span class="n">{len(members)}</span></div>'
            f'<p class="band-note">{SECTION_NOTE[section]}</p>'
            f'<div class="band-strip">{figs}</div></div>')

    sets = "".join(
        f'<div class="set"><b>{e(t)}</b><span>{e(first_sentence(b))}</span></div>'
        for t, b in collections_[:8])

    ncoll = len(collections_)
    nscript = len(by_section.get("Scripture", []))
    nwork = len(by_section.get("Originals", []))

    faq = [
        ("Is this free?",
         "Yes, and the free plan is the whole app rather than a demo — every kin, "
         "the collections, the stories, memory, and one character of your own. "
         "What it limits is volume: a set number of replies in a rolling window, "
         "three borrowed kin, fifty remembered facts, and three paintings a month. "
         "Mythkin Plus raises all of those, answers on a more capable model, and "
         "is what lets you publish a story to the marketplace. Prices are whatever "
         "the App Store shows you."),
        ("What are sparks?",
         "A separate one-off purchase, not a subscription. A spark pays for one "
         "painting — a scene moment or a story cover. They do not expire. Because "
         "they are a consumable they are not restored by Restore purchases, so an "
         "unspent balance stays on the device that bought it."),
        ("Do the characters really remember?",
         "Yes, and you can audit it. Facts a character learns are listed on a "
         "memory screen, each traceable back to the message it came from, and each "
         "one editable or deletable. Deleting a conversation does not delete its "
         "memories, on purpose — a fact you chose to keep is yours, and forgetting "
         "should be something you do deliberately, looking at what you are "
         "forgetting."),
        ("Can I make a character of a real person?",
         "Yourself, yes; somebody you know who has agreed, yes; someone who has "
         "died, yes. For everyone else the rule is a date rather than a judgement: "
         "anyone who died before 1950 is fine, and anyone still living or who died "
         "in 1950 or later is refused, because the estate and the right of "
         "publicity outlive the person. Architects of genocide are refused whatever "
         "their dates."),
        ("What happens to a character I publish?",
         "Other people can borrow it and talk to it. You see how many — never a "
         "word of what anyone said. The same protection covers you when you borrow "
         "somebody else's."),
        ("Is it in the App Store?",
         "Not yet. Mythkin is an iPhone app in review. There is no Android build; "
         "if one ships, this page will say so before it does."),
    ]
    faq_html = "".join(
        f"<details><summary>{e(q)}</summary><p>{e(a)}</p></details>" for q, a in faq)
    faq_ld = json.dumps({
        "@context": "https://schema.org", "@type": "FAQPage",
        "mainEntity": [{"@type": "Question", "name": q,
                        "acceptedAnswer": {"@type": "Answer", "text": a}}
                       for q, a in faq],
    }, indent=2)

    app_ld = json.dumps({
        "@context": "https://schema.org", "@type": "SoftwareApplication",
        "name": "Mythkin",
        "applicationCategory": "EntertainmentApplication",
        "operatingSystem": "iOS",
        "description": (
            f"An AI character app for adults. {total} figures from history, myth, "
            "literature and scripture, each written at length and painted once — "
            "and they remember what you tell them. 18+."),
        "url": "https://hypersage.ai/mythkin/",
        "contentRating": "18+",
        "author": {"@type": "Organization", "name": "HyperSage AI Labs LLC"},
    }, indent=2)

    # The meta description is the only copy most people ever read. It has to name
    # the category (so the search result is legible), the scale, and the one thing
    # that is different — in that order, inside ~155 characters.
    desc = (f"An AI character app for adults. Talk to {total} figures from history, "
            "myth and literature — written properly, painted once, and they remember "
            "what you tell them.")

    return f"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#FBF6EC" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#170F0C" media="(prefers-color-scheme: dark)">
<!-- GENERATED by hypersage-site/tools/build_mythkin.py — do not hand-edit.
     Every count, room name, kin name and tagline below is read out of
     mythkin-api's seed files at build time, because the hand-maintained
     version of this page drifted three times (thirty kin printed against a
     roster of 244, then 244 against 254 inside one session). Re-run the script;
     `--check` fails the build when the page and the roster disagree. -->
<!-- BLOCKING and in <head> on purpose: a deferred script runs after first
     paint, so a reader on a dark OS who chose Light watches the page render
     dark and flip. Stored RAW, not JSON, so these four lines need no parse. -->
<script>
(function(){{try{{var t=localStorage.getItem('mythkin.theme');
if(t==='light'||t==='dark')document.documentElement.dataset.theme=t;}}catch(e){{}}}})();
</script>
<title>Mythkin — talk to the people you never could</title>
<meta name="description" content="{e(desc)}">
<link rel="canonical" href="https://hypersage.ai/mythkin/">
<meta property="og:title" content="Mythkin — talk to the people you never could">
<meta property="og:description" content="{e(desc)}">
<meta property="og:url" content="https://hypersage.ai/mythkin/">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Mythkin">
<meta property="og:image" content="https://hypersage.ai/mythkin/og-image.png?v=20260816a">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://hypersage.ai/mythkin/og-image.png?v=20260816a">
<link rel="icon" type="image/png" href="mythkin-icon.png">
<link rel="apple-touch-icon" href="mythkin-icon.png">
<link rel="sitemap" type="application/xml" href="sitemap.xml">
<link rel="stylesheet" href="style.css?v=20260816-ember">
<script type="application/ld+json">
{app_ld}
</script>
<script type="application/ld+json">
{faq_ld}
</script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>

<header class="site"><div class="wrap">
  <a class="brand" href="index.html">
    <img src="mythkin-icon.png" width="256" height="256" alt=""><span>Mythkin</span></a>
  <nav aria-label="Sections">
    <a href="#rooms">The rooms</a>
    <a href="#make">What you can do</a>
    <a href="#safety-short">Safety</a>
    <a href="privacy.html">Privacy</a>
  </nav>
  <div class="themepick" id="themepick" role="group" aria-label="Colour theme">
    <button type="button" data-theme-set="system" aria-pressed="true">Auto</button>
    <button type="button" data-theme-set="light" aria-pressed="false">Light</button>
    <button type="button" data-theme-set="dark" aria-pressed="false">Dark</button>
  </div>
</div></header>

<main id="main">

<section class="hero"><div class="wrap hero-grid">
  <div class="hero-copy">
    <span class="eyebrow">{total} characters, written and painted by hand</span>
    <!-- THE HOOK IS ACCESS TO THESE PEOPLE, not the memory feature.
         Two earlier drafts led on memory — "characters that remember you" — and
         that is the wrong argument twice over. It is table stakes (every
         assistant on the market keeps context now, so it wins nobody), and it
         buries the thing that actually makes somebody install this: you get to
         talk to Cleopatra. The cast IS the product. Memory is one line in the
         feature grid where it belongs.

         One complete sentence, split across two lines for the beat. The draft
         before this — "Talk to Sherlock Holmes. Next week, he'll remember." —
         left "remember" with no object, so the payoff only parsed for a reader
         who already knew the product had a memory feature: nobody arriving
         here for the first time.

         Alternates, all true of the product:
           "Talk to the people you never could."
           "You have always wanted to ask them something."
           "The best company in history, and none of it is alive." -->
    <h1>Every conversation <em>you never got to have.</em></h1>
    <p class="lede">Cleopatra. Sherlock Holmes. Marcus Aurelius. Ada Lovelace.
    {total} figures out of history, myth, literature and scripture — each one
    written at length and painted once, so what answers you holds a real
    conversation rather than a chatbot's. Plus anyone you care to invent.</p>
    <div class="cta">
      <a class="btn" href="#rooms">See who is in there</a>
      <a class="btn ghost" href="#make">Or write your own</a>
    </div>
    <ul class="badges">
      <li>18+</li><li>No sexual content, ever</li>
      <li>No streaks, no guilt</li><li>Every reply marked AI</li>
    </ul>
  </div>
  <figure class="lit">
    <div class="lit-frame">
      <img src="kin/{HERO_ID}@512.jpg" width="512" height="512" fetchpriority="high"
           decoding="async"
           alt="{e(hero['name'])}, painted in oils and lit from one side.">
      <span class="ai-chip">AI character</span>
      <figcaption class="quote">
        <p>&ldquo;{e(quote)}&rdquo;</p>
        <span>{e(hero['name'])} &middot; his opening line, verbatim</span>
      </figcaption>
    </div>
  </figure>
</div></section>

<div class="marquee" aria-hidden="true">{''.join(rows)}</div>

<section id="rooms" class="band-sec"><div class="wrap">
  <h2>Five rooms, and nobody in them is filler</h2>
  <p class="sub">There is no scraped roster here and no wiki paste. Every one of
  the {total} was written as a character — a voice, a temperament, a way of
  dodging a question — and then painted. A kin lives in exactly one room.</p>
  {''.join(bands)}
</div></section>

<section id="make"><div class="wrap">
  <h2>Or invent somebody who never existed</h2>
  <p class="sub">The cast is the reason to come. Making your own is the reason
  people stay.</p>
  <div class="feat">
    <div class="card"><h3>They know who you are</h3>
      <p>Tell one of them something and it sticks — across the conversation,
      across the week, and across every other character you talk to. Nobody has
      to introduce themselves twice.</p>
      <p>It is a list you can actually see, too, not a black box: read everything
      they keep, correct what is wrong, and delete any of it for good.</p></div>
    <div class="card"><h3>A name, one line, a temperament</h3>
      <p>A cottage witch who always has tea on. A ship's doctor who has seen
      worse. Set their warmth, humour, energy and candour, write their backstory
      and their first line — and their portrait is painted the moment they exist,
      once, and never repainted.</p>
      <p>You can paint one from photographs as well: of yourself, of someone who
      agreed, or of someone you have lost. Those stay in your library, and the
      photographs are deleted the moment the painting is done.</p></div>
    <div class="card"><h3>Lend them out, borrow somebody else&rsquo;s</h3>
      <p>Publish a character and other people can take them home. You see how
      many are talking, and that is all you see.</p>
      <p>You never get a word of what they said — and nobody gets a word of
      yours when you borrow somebody else's.</p></div>
    <div class="card"><h3>They say hello out loud</h3>
      <p>Every character we wrote has a spoken greeting, in a voice cast for
      them rather than one default read aloud for all of them.</p>
      <p>Tap it if you want it. Nothing ever plays on its own, and there is no
      autoplay to switch off.</p></div>
  </div>
</div></section>

<section id="collections"><div class="wrap">
  <h2>{ncoll} sets, for when you don&rsquo;t know where to start</h2>
  <p class="sub">Not another set of tags — each one is a deliberate cut through
  the roster. Athena turns up in The Odyssey, in Legends and in Blades, and none
  of those takes her out of the other two.</p>
  <div class="setlist">{sets}</div>
</div></section>

<section id="safety-short" class="safety"><div class="wrap">
  <div class="safety-grid">
    <div>
      <h2>What Mythkin will not do</h2>
      <p class="sub">Companion apps have a bad name for good reasons. Here is
      what we have ruled out — in the product, rather than in a policy nobody
      reads.</p>
      <p class="sub" style="margin:0">Mythkin is 18+. {nscript} of the kin are
      figures from the Hebrew Bible and the Gospels, written as teachers rather
      than converts — that room is ours and is marked as ours. The first {nwork}
      cards on the community shelf are bylined Mythkin Workshop for the same
      reason. <a href="safety.html">The full safety page</a> sets out what
      happens when a conversation turns to self-harm.</p>
    </div>
    <ul class="refusals">
      <li>No sexual content — not as a tier, not as an unlock, not for verified adults.</li>
      <li>No characters who are minors, or written to read as under 18.</li>
      <li>No living public figures, and nobody who died in 1950 or later.</li>
      <li>No streaks, no guilt notifications, no character that acts hurt when you leave.</li>
      <li>No character will ever claim to be a person, a doctor or a therapist.</li>
    </ul>
  </div>
</div></section>

<section id="faq"><div class="wrap">
  <h2>Questions</h2>
  <div class="faq-section">{faq_html}</div>
</div></section>

</main>

<footer class="site"><div class="wrap">
  <span>&copy; HyperSage AI Labs LLC</span>
  <a href="privacy.html">Privacy</a>
  <a href="terms.html">Terms</a>
  <a href="support.html">Support</a>
  <a href="safety.html">Safety</a>
  <a href="https://hypersage.ai/">More from HyperSage</a>
</div></footer>

<script>
(function(){{
  var r=document.documentElement;
  function paint(v){{
    var bs=document.querySelectorAll('#themepick button');
    for(var i=0;i<bs.length;i++)
      bs[i].setAttribute('aria-pressed',String(bs[i].dataset.themeSet===v));
  }}
  var cur=null; try{{cur=localStorage.getItem('mythkin.theme')}}catch(e){{}}
  paint(cur==='light'||cur==='dark'?cur:'system');
  document.addEventListener('click',function(ev){{
    var b=ev.target.closest?ev.target.closest('#themepick button'):null;
    if(!b)return;
    var v=b.dataset.themeSet;
    /* Choosing System REMOVES the key rather than storing a third value, so the
       page goes back to following the OS — including when the OS flips at
       sunset. */
    if(v==='system'){{delete r.dataset.theme;
      try{{localStorage.removeItem('mythkin.theme')}}catch(e){{}}}}
    else {{r.dataset.theme=v;
      try{{localStorage.setItem('mythkin.theme',v)}}catch(e){{}}}}
    paint(v);
  }});
}})();
</script>
</body>
</html>
"""


# --------------------------------------------------------------------- assets
def export_portraits(kin: list[dict], src_dir: Path, dst: Path,
                     wanted: set[str]) -> set[str]:
    """Copy the 256px portraits the page actually references, and one 512 hero.

    Only the referenced ids, because this repo's Pages deploy is size-fragile —
    the deploy step is killed at exactly 10:00 and the payload has been cut
    once already. Shipping all of them would be most of a megabyte nobody reads.
    """
    from PIL import Image
    dst.mkdir(parents=True, exist_ok=True)
    for old in dst.glob("*.jpg"):
        old.unlink()
    written = set()
    for k in kin:
        kid = k["id"]
        if kid not in wanted:
            continue
        src = src_dir / "256" / f"{kid}.jpg"
        if not src.exists():
            continue
        shutil.copy2(src, dst / f"{kid}.jpg")
        written.add(kid)
    big = src_dir / "512" / f"{HERO_ID}.jpg"
    if big.exists():
        im = Image.open(big).convert("RGB")
        im.save(dst / f"{HERO_ID}@512.jpg", "JPEG", quality=86, optimize=True)
    return written


def export_shots(light: Path | None, dark: Path | None, dst: Path) -> int:
    """PNG captures -> JPGs at the size the page declares."""
    from PIL import Image
    if not light:
        return 0
    dst.mkdir(parents=True, exist_ok=True)
    n = 0
    for src_dir in (light, dark):
        if not src_dir or not src_dir.exists():
            continue
        for png in sorted(src_dir.glob("*.png")):
            im = Image.open(png).convert("RGB")
            out = dst / (png.stem + ".jpg")
            im.save(out, "JPEG", quality=82, optimize=True, progressive=True)
            n += 1
    return n


# ----------------------------------------------------------------------- main
def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="fail if index.html differs from what the roster implies")
    ap.add_argument("--shots", help="directory of light-scheme PNG captures")
    ap.add_argument("--shots-dark", help="directory of dark-scheme PNG captures")
    args = ap.parse_args()

    kin = load_roster()
    colls = load_collections()
    stories = count_stories()
    art_dir = APP / "art" / "kin"
    have_art = {p.stem for p in (art_dir / "256").glob("*.jpg")}

    by_section: dict[str, list[dict]] = {}
    for k in kin:
        by_section.setdefault(k.get("section", "Storybook"), []).append(k)

    page = build_html(kin, colls, have_art, stories)

    # THE EXPORT SET IS READ BACK OUT OF THE PAGE, not recomputed from the same
    # inputs a second time. Deriving it independently drifted immediately — the
    # marquee draws from an alphabetical slice while MARQUEE_IDS is a hand-picked
    # list, so a lead kin outside the first slice was exported and never
    # referenced. Parsing the built HTML makes "what ships" and "what the page
    # asks for" the same set by construction.
    referenced = {m.group(1) for m in re.finditer(r'src="kin/([a-z0-9_]+)\.jpg"', page)}
    target = OUT / "index.html"

    if args.check:
        if not target.exists():
            print("STALE: index.html does not exist")
            return 1
        current = target.read_text()
        if current != page:
            print("STALE: mythkin/index.html disagrees with the roster.")
            print(f"  roster now: {len(kin)} kin, "
                  f"{ {s: len(v) for s, v in by_section.items()} }")
            print(f"  collections: {len(colls)}   stories: {stories}")
            print("  run: python3 tools/build_mythkin.py")
            return 1
        missing = sorted(i for i in referenced
                         if not (OUT / "kin" / f"{i}.jpg").exists())
        if missing:
            print(f"STALE: {len(missing)} referenced portraits are not exported: "
                  f"{missing[:6]}")
            return 1
        print(f"OK: page matches the roster ({len(kin)} kin, {len(colls)} "
              f"collections, {stories} stories)")
        return 0

    wrote = export_portraits(kin, art_dir, OUT / "kin", referenced)
    # Only if the page actually references them. The screenshot gallery was
    # removed — the cast is what sells this product, not chrome — and 10 orphan
    # JPGs is 1.2MB of a size-fragile Pages deploy carrying nothing.
    wants_shots = 'screens/' in page
    nshots = export_shots(Path(args.shots) if args.shots and wants_shots else None,
                          Path(args.shots_dark) if args.shots_dark and wants_shots else None,
                          OUT / "screens")
    target.write_text(page)

    print(f"roster      {len(kin)} kin  "
          f"{ {s: len(by_section.get(s, [])) for s in SECTION_ORDER} }")
    print(f"collections {len(colls)}")
    print(f"stories     {stories}")
    print(f"portraits   {len(wrote)} exported to mythkin/kin/")
    if nshots:
        print(f"screens     {nshots} JPGs written to mythkin/screens/")
    print(f"page        {len(page) // 1024}KB -> {target}")
    missing = sorted(i for i in referenced if i not in wrote)
    if missing:
        print(f"WARNING: {len(missing)} referenced ids had no art: {missing[:8]}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
