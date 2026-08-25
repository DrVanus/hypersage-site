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

# Room blurbs. Four of these are OURS — the app's own ROOM_NOTE strings are
# written for a reader who is already inside, and these say the same thing to
# somebody who has not installed anything yet.
#
# SCRIPTURE IS THE EXCEPTION: it is the app's own ROOM_NOTE string, copied
# verbatim from mythkin-app/app.js (const ROOM_NOTE, ~line 5325), and it must
# stay that way. This slot used to read "The Hebrew Bible and the Gospels,
# written as teachers rather than as converts." The app DELETED that exact
# enumeration and left a comment saying why: the room files a kin by WHERE THEY
# COME FROM ("canonical religious text -> Scripture", generically), so naming
# two corpora described 63 of the then-64 kin and implied the Pali Canon is not
# scripture — a claim about somebody's religion that a shelf caption has no
# business making. The seed proves it: app/characters/seed.py currently files
# Siddhartha Gautama, Mahapajapati Gotami, Thorani, Gargi Vachaknavi and Asiya
# bint Muzahim into Scripture, plus Peter, Paul of Tarsus, Priscilla, Barnabas
# and Lydia, who are not in the Gospels either. An enumeration also cannot
# survive the roster — it goes false the day one kin arrives from anywhere
# else, silently, with every gate green. DO NOT re-list corpora here; if the
# app's ROOM_NOTE changes, copy the new string, do not compose one.
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
    "Scripture": "Figures whose stories reach us through scripture, written as "
                 "teachers — warm, story-first, and never here to convert you.",
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

# THE HERO ROTATES, AND THE CAST IS PROPORTIONAL TO THE ROOMS.
# It was one id — Sherlock — for the life of the page, which sold a roster of
# 254 with a single face and made the largest claim on the page ("254
# characters") the one thing the art never demonstrated. Reported from the
# phone: "it should be switching characters not every second but every so often
# so it's not just Sherlock all the time".
#
# Ten slides, weighted roughly by room size (Storybook 78, Legends 62,
# History 60, Scripture 38, Originals 16 → 3/2/3/1/1). Every id is checked
# against the roster AND against the art on disk at build time, so a name that
# leaves the seed fails the build rather than shipping a blank frame.
#
# Scripture is in the rotation ON PURPOSE and is the one judgement call here: a
# painted first-person line from a biblical figure is a stronger claim than a
# tagline, so the byline under every slide says the line was written for
# Mythkin rather than implying it is a quotation. Drop "ch_deborah" from this
# list if that call should go the other way — nothing else needs to change.
HERO_CAST = [
    "ch_sherlock", "ch_cleo", "ch_zeus", "ch_alice", "ch_curie",
    "ch_babayaga", "ch_marcus", "ch_deborah", "ch_wren", "ch_dracula",
]
HERO_MS = 7000         # dwell per slide; "every so often", not every second

PER_BAND = 12          # faces shown in each room's rail
MARQUEE_ROWS = 3       # drifting rows; the whole roster is dealt across them


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


SHOT_V = "20260824a"   # bump when any screenshot is re-exported
# Which captures reach the page, in order, with the caption each one earns.
# site_shots.py writes more than this; a gallery is an edit, not a dump.
SHOTS = [
    ("01-discover",
     "The Discover shelf: a featured character of the week above rows of painted "
     "portraits and collections.",
     "The shelf you open on."),
    ("02-chat",
     "A conversation with Sherlock Holmes, who is reasoning about a torn ticket "
     "found in a coat pocket.",
     "A character, mid-conversation."),
    ("04-create",
     "The New kin form, part filled in: a name, a one-line description, and dials "
     "for warmth, humour, energy and candour.",
     "Or write one of your own."),
]


def shot_figures() -> str:
    """Both schemes, same alt on each: only one is ever displayed, and
    display:none takes the other out of the accessibility tree too, so a
    screen-reader user hears the picture once and hears the right one."""
    out = []
    for key, alt, cap in SHOTS:
        imgs = "".join(
            f'<img class="{cls}" src="screens/{key}{suf}.jpg?v={SHOT_V}" '
            f'width="786" height="1704" loading="lazy" decoding="async" '
            f'alt="{e(alt)}">'
            for cls, suf in (("lt", ""), ("dk", "-dark")))
        out.append(f'<figure class="shot"><div class="pic">{imgs}</div>'
                   f'<figcaption>{e(cap)}</figcaption></figure>')
    return "".join(out)


def load_limits() -> dict[str, int]:
    """The tier numbers, read from the settings that ENFORCE them.

    Same argument as the roster above, and the FAQ used to lose it: the answer
    said "a set number of replies in a rolling window" — true, and it named
    nothing, so a reader learned no more than that a limit existed. Meanwhile
    the standalone mythkin-site source carried a hand-typed "200 replies a day"
    against a server that allows 600. That is the drift this whole file exists
    to stop, so the cure is the same: parse app/config.py, never retype it.

    These are the same fields app/plans.py renders into GET /v1/plans, which is
    what the app's own paywall draws — so the page and the paywall cannot say
    different things about the same limit.
    """
    src = API / "app" / "config.py"
    if not src.exists():
        sys.exit(f"FAIL: {src} not found — is mythkin-api checked out?")
    want = {
        "free_window_messages", "free_window_hours", "plus_window_messages",
        "free_max_borrowed_characters", "free_max_memories",
        "plus_max_created_characters", "moment_paint_free", "moment_paint_plus",
        "moment_paint_window_hours",
    }
    got: dict[str, int] = {}
    for node in ast.walk(ast.parse(src.read_text())):
        if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            name = node.target.id
            if name in want and isinstance(node.value, ast.Constant) \
                    and isinstance(node.value.value, int):
                got[name] = node.value.value
    missing = want - set(got)
    if missing:
        sys.exit("FAIL: config.py no longer defines " + ", ".join(sorted(missing))
                 + " — the FAQ's numbers cannot be derived, so the page is not built")
    return got


# The page spells small numbers out; anything not here falls back to digits
# rather than inventing a spelling.
_WORDS = {1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six",
          7: "seven", 8: "eight", 9: "nine", 10: "ten", 12: "twelve",
          20: "twenty", 24: "twenty-four", 30: "thirty", 50: "fifty",
          100: "a hundred", 200: "two hundred", 500: "five hundred",
          600: "six hundred"}


def _w(n: int) -> str:
    return _WORDS.get(n, f"{n:,}")


def _paint_window(L: dict[str, int]) -> str:
    """720 hours is 30 days is 'a month'. Any other window says its own
    length rather than being rounded into a word that would be wrong."""
    days = L["moment_paint_window_hours"] // 24
    return "a month" if days == 30 else f"every {_w(days)} days"


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


FLEET_STATE = Path.home() / "Developer" / "DrVanus" / "fleet" / "state" / "current.json"

# WHAT THE PAGE MAY SAY ABOUT THE STORE, KEYED ON WHAT ASC ACTUALLY SAYS.
# The FAQ answered "Mythkin is an iPhone app in review" while App Store Connect
# had it at PREPARE_FOR_SUBMISSION with build 3 sitting unsubmitted — a typed
# status, on a page whose entire reason for being generated is that typed
# statuses go stale on somebody else's commit. Every other number here is
# derived; this one now is too.
#
# A state that is not in this table FAILS the build. That is the point: the
# alternative to failing is printing whichever sentence was nearest, and the
# defect being fixed is exactly a sentence that was nearest once and stopped
# being true.
STORE_ANSWER = {
    "PREPARE_FOR_SUBMISSION": (
        "Not yet. Mythkin is an iPhone app; the build is finished and the "
        "listing has not gone to review yet. There is no Android build; if one "
        "ships, this page will say so before it does."),
    "WAITING_FOR_REVIEW": (
        "Not yet. Mythkin is an iPhone app, submitted and waiting on Apple. "
        "There is no Android build; if one ships, this page will say so before "
        "it does."),
    "IN_REVIEW": (
        "Not yet. Mythkin is an iPhone app, in review with Apple right now. "
        "There is no Android build; if one ships, this page will say so before "
        "it does."),
    "REJECTED": (
        "Not yet. Mythkin is an iPhone app; the last submission came back with "
        "changes to make, and it goes again once they are done. There is no "
        "Android build; if one ships, this page will say so before it does."),
    "READY_FOR_SALE": (
        "Yes — Mythkin is on the App Store, for iPhone. There is no Android "
        "build; if one ships, this page will say so before it does."),
}


def store_answer() -> tuple[str, str]:
    """The App Store FAQ answer, read out of the fleet poller's own state file.

    Returns (answer, state). Fails the build rather than guessing: a marketing
    page that invents a store status is the defect, and a missing poll is not a
    licence to invent one.
    """
    if not FLEET_STATE.exists():
        sys.exit(f"FAIL: {FLEET_STATE} not found — the App Store answer is "
                 "derived from it. Run `fleet status` to refresh, or check out "
                 "the fleet repo.")
    data = json.loads(FLEET_STATE.read_text())
    app = next((a for a in data.get("apps", []) if a.get("key") == "mythkin"), None)
    if not app or not app.get("versions"):
        sys.exit("FAIL: fleet state has no mythkin version — cannot derive the "
                 "App Store answer.")
    state = app["versions"][0].get("state", "")
    if state not in STORE_ANSWER:
        sys.exit(f"FAIL: App Store state {state!r} has no approved sentence in "
                 "STORE_ANSWER. Add one — do not let the page print the last "
                 "one that happened to be there.")
    return STORE_ANSWER[state], state


# ------------------------------------------------------------------- rendering
def e(s: str) -> str:
    return html.escape(str(s), quote=True)


HERO_QUOTE_BUDGET = 150


def hero_quote(greeting: str, budget: int = HERO_QUOTE_BUDGET) -> str:
    """As many whole sentences of an opening line as the frame can hold.

    THE FRAME IS FIXED AND THE GREETINGS ARE NOT. This printed the greeting
    whole, which was fine while Sherlock's was ~100 characters — and on
    2026-08-17 a rewrite ("54 kin stop opening the same way") took it to 274.
    Rendered, the quote climbed most of a square portrait, pushed out of the
    scrim it relies on for legibility, and left the face it is captioning
    barely visible.

    `first_sentence` is the wrong tool here and measuring proved it: Zeus opens
    "MORTAL." (7 characters) and Baba Yaga opens "So." (3). One sentence is not
    a quote. So: whole sentences, accumulated until the next would break the
    budget, and NEVER a cut inside a sentence — a pull quote that stops
    mid-clause reads as a rendering fault, and a quotation cut mid-word is a
    misquotation. A first sentence that is already over budget is kept whole
    for the same reason; the frame can wear one long line, and the gate
    measures the rendered block rather than trusting this arithmetic.

    An ellipsis marks a real elision, so a reader can see there is more.
    """
    text = " ".join(greeting.split())
    parts = re.split(r"(?<=[.!?…])\s+", text)
    out = parts[0]
    for nxt in parts[1:]:
        if len(out) + 1 + len(nxt) > budget:
            break
        out += " " + nxt
    return out if out == text else out.rstrip(" .") + "…"


def first_sentence(text: str, limit: int = 120) -> str:
    text = " ".join(text.split())
    cut = re.split(r"(?<=[.!?])\s", text)[0]
    if len(cut) > limit:
        cut = cut[:limit].rsplit(" ", 1)[0] + "…"
    return cut


def build_html(kin: list[dict], collections_: list[tuple[str, str]],
               have_art: set[str], stories: int, store_line: str) -> str:
    by_id = {k["id"]: k for k in kin}
    by_section: dict[str, list[dict]] = collections.OrderedDict(
        (s, []) for s in SECTION_ORDER)
    for k in kin:
        by_section.setdefault(k.get("section", "Storybook"), []).append(k)

    # THE HEADLINE COUNTS WHAT IT CAN PROVE, WHICH IS THE PAINTED ONES.
    # `total = len(kin)` read the API seed straight, and on 2026-08-17 a
    # concurrent session added 30 kin ahead of their art. The page immediately
    # rendered "284 characters, written and painted by hand" in the eyebrow, the
    # meta description and the make-your-own sub — over five room rails whose
    # counts are filtered by `have_art` and still summed to 254. So the page
    # contradicted itself AND the larger of the two numbers was the one carrying
    # the word "painted", for thirty characters with no painting.
    # Every rail, every tile and every count below already filters on art. The
    # headline is the one place that did not, so it was the one place that could
    # lie. Under-reporting while art is in flight is the safe direction: a kin
    # appears on this page the day it has a face, not the day it has an id.
    painted = [k for k in kin if k["id"] in have_art]
    total = len(painted)
    by_section = collections.OrderedDict((s, []) for s in SECTION_ORDER)
    for k in painted:
        by_section.setdefault(k.get("section", "Storybook"), []).append(k)

    lead = [i for i in MARQUEE_IDS if i in by_id and i in have_art]
    if len(lead) < 20:
        sys.exit(f"FAIL: only {len(lead)} of the {len(MARQUEE_IDS)} lead kin "
                 "are still in the roster with art — update MARQUEE_IDS")

    cast = [i for i in HERO_CAST if i in by_id and i in have_art]
    if len(cast) < len(HERO_CAST):
        sys.exit(f"FAIL: hero cast {sorted(set(HERO_CAST) - set(cast))} is not in "
                 "the roster, or has no art — update HERO_CAST")

    # -- marquee: THE WHOLE ROSTER, dealt across the rows.
    # It used to take `pool[:26]` and `pool[26:52]` off an ALPHABETICAL sort, so
    # the strip that is supposed to say "254 of them" opened on Aaron, Abigail,
    # Abraham, Adam and Amos and never got past the Bs. Worse, `marquee` — the
    # hand-picked recognisable list, validated three lines up — was computed and
    # then never used: a dead variable guarding a list nothing read. Now the lead
    # faces really do lead, the rest follow in a stable order, and every kin with
    # art appears exactly once. Two rows became three because 254 across two rows
    # is a strip you cannot see the end of at any width.
    pool = [k for k in kin if k["id"] in have_art]
    pool.sort(key=lambda k: k["id"])          # stable: --check must be idempotent
    ordered = ([by_id[i] for i in lead]
               + [k for k in pool if k["id"] not in set(lead)])
    per = -(-len(ordered) // MARQUEE_ROWS)    # ceil, so the last row is the short one
    rows = []
    for r in range(MARQUEE_ROWS):
        chunk = ordered[r * per:(r + 1) * per]
        if not chunk:
            continue
        # Doubled so the -50% drift loops seamlessly; `loading="lazy"` means the
        # copies cost nothing until the row has actually drifted that far.
        # THE FIRST SCREENFUL CANNOT BE LAZY. Measured on the built page at
        # 1280x900: of the ~36 tiles inside the viewport, 1-3 were still blank
        # at +2s, +10s, +25s AND +45s — native lazy-loading does not keep up
        # with content that arrives by `transform` rather than by scrolling, so
        # the strip ran with a rolling hole in it. Not visible in a capture,
        # either: the screenshot rig forced every image eager before shooting,
        # which is a rig that cannot photograph this bug.
        # 16 covers a 1280px row (1280/117 ≈ 11) with buffer; eager, but without
        # fetchpriority, so they queue behind the hero portrait rather than
        # racing the largest element on the page.
        # NAME THE FACE UNDER THE CURSOR.
        # Reported: "not interactable if i move my mouse on it to show who it is
        # etc?" — and that was the whole flaw in the strip. A wall of 314
        # paintings that will not tell you who any of them are is a screensaver;
        # the moment it names them it becomes the roster, which is the argument
        # this page is making. Each tile now carries its name, revealed on hover,
        # and `.mrow:hover` stops that row so the tile does not slide out from
        # under the pointer before it can be read — a moving target cannot be
        # inspected, so the pause is part of the feature, not a nicety.
        #
        # The strip stays aria-hidden. 628 tiles is not navigation, and the
        # rooms below name their kin as real content for every reader; adding
        # 628 announced labels would make the page WORSE for the people
        # aria-hidden exists to protect. The name is a pointer affordance on top
        # of decoration, not the only place the information lives.
        EAGER = 16
        imgs = "".join(
            f'<span class="mtile">'
            f'<img src="kin/{k["id"]}.jpg" width="256" height="256" '
            f'loading="{"eager" if n < EAGER else "lazy"}" decoding="async" alt="">'
            f'<b>{e(k["name"])}</b></span>'
            for n, k in enumerate(chunk * 2))
        # THE DURATION HAS TO FOLLOW THE LENGTH. `drift` translates the row by
        # -50%, so a fixed 78s means SPEED is whatever the row happens to be:
        # tripling the roster tripled the pace to ~127px/s, which is a blur, not
        # a drift. 3s per tile holds the old ~39px/s at any roster size — and it
        # is the same class of bug as a ceiling typed once
        # ([[a-ceiling-typed-once-rots-in-a-day]]), so it is derived, not typed.
        dur = max(60, round(len(chunk) * 3.0))
        rows.append(f'<div class="mrow{" rev" if r % 2 else ""}" '
                    f'style="--drift:{dur}s">{imgs}</div>')

    # -- hero: every slide in the DOM, stacked, crossfaded by hero.js.
    # NO NAKED FIRST-PERSON QUOTE. Each slide's line is the character's real
    # greeting out of the seed — but a painted portrait with an unattributed
    # quotation under it is a claim that the person said it, and this rotation
    # now runs through Marie Curie, Cleopatra and a figure from the book of
    # Judges. The byline says who wrote it. ([[a-caption-is-a-claim-about-its-picture]])
    #
    # The chip carried the words "AI character" and has been given the room
    # instead: it was doing disclosure work that the badge row does better and
    # in a sentence ("Every reply marked AI"), while telling a reader nothing
    # about the face they are looking at. The room is a fact about that face and
    # it changes with the slide.
    slides = []
    for n, kid in enumerate(cast):
        k = by_id[kid]
        line = hero_quote(k["greeting"])
        room = k.get("section", "Storybook")
        first = n == 0
        img = (f'<img src="kin/{kid}@512.jpg" width="512" height="512" '
               + ('fetchpriority="high" decoding="async"' if first
                  else 'loading="lazy" decoding="async"')
               + f' alt="{e(k["name"])}, painted in oils and lit from one side.">')
        cls = "slide on" if first else "slide"
        hide = "" if first else ' aria-hidden="true"'
        slides.append(
            f'<div class="{cls}"{hide}>'
            + img
            + f'<span class="room-chip">{e(room)}</span>'
            + '<figcaption class="quote">'
            + f'<p>&ldquo;{e(line)}&rdquo;</p>'
            + f'<span><b>{e(k["name"])}</b> &middot; opening line, '
              'written for Mythkin</span>'
            + '</figcaption></div>')

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
        # WHERE THE RAIL ENDS, AND WHY. Twelve of seventy-eight scroll off the
        # right edge mid-card, which reads as a layout fault rather than as a
        # sample — the count beside the heading says 78 and the rail shows 12
        # with nothing joining the two numbers up. An end tile says it in the
        # place the reader hits the question.
        more = len(members) - len(shown)
        if more > 0:
            figs += (f'<figure class="band-more" aria-hidden="true">'
                     f'<b>+{more}</b><span>more in {e(section)}</span></figure>')
        bands.append(
            f'<div class="band">'
            f'<div class="band-head"><h3>{e(section)}</h3>'
            f'<span class="n">{len(members)}</span></div>'
            f'<p class="band-note">{SECTION_NOTE[section]}</p>'
            f'<div class="band-strip">{figs}</div></div>')

    # ALL OF THEM, AND NOT CUT MID-WORD. This printed eight of the thirty-one
    # under a heading that says "31 sets", each blurb hard-truncated at 120
    # characters — so the section that exists to show the roster has depth read
    # as "Gas-lit streets after dark — London mostly, Paris when it suits them:
    # the detectives, the monsters, and the respectable…". A heading that counts
    # 31 and a list that shows 8 is the same defect as a marquee that shows the
    # letter A: the page keeps claiming a scale it will not display.
    # 200 characters clears every blurb in the set today, and `first_sentence`
    # still breaks on a sentence end rather than a character count where it can.
    # SIX WITH THEIR ARGUMENT, THE REST BY NAME — and nothing cut mid-word.
    # This printed eight of the thirty-one under a heading that counts 31, each
    # blurb hard-truncated at 120 characters, so the section that exists to show
    # the roster has depth read as "…the detectives, the monsters, and the
    # respectable…". Printing all 31 at full length fixed the honesty and made a
    # 31-item wall of grey prose — the bottom of the page was already three text
    # sections in a row. Six carry the flavour; the other 25 are names, which is
    # the whole of what a reader needs to believe the number. Nothing truncates:
    # the longest blurb in the set is 202 characters, so 240 is a ceiling with
    # room rather than a cut. Measured, not guessed — and it will fail LOUD
    # rather than silently, because `first_sentence` marks a cut with an ellipsis
    # the CSS no longer hides behind a line clamp.
    FEATURED = 6
    sets = "".join(
        f'<div class="set"><b>{e(t)}</b><span>{e(first_sentence(b, 240))}</span></div>'
        for t, b in collections_[:FEATURED])
    rest = collections_[FEATURED:]
    setrest = ""
    if rest:
        # BEHIND A DISCLOSURE, AND THAT IS A LENGTH DECISION.
        # The roster went 31 -> 54 sets, so the flat chip list went from 25 names
        # to 48 — on a 390pt phone that is ~24 rows of small type, and the
        # collections section became the tallest thing on the page for the least
        # reason. A <details> is the right tool and needs no script: closed, the
        # section is six sets and one line; open, it is all 54, so nothing is
        # hidden from anyone who wants the proof of depth. Native, keyboard
        # operable, and announced as an expander without a line of ARIA.
        chips = "".join(f'<li>{e(t)}</li>' for t, _ in rest)
        # len(collections_), not ncoll: ncoll is bound eight lines BELOW this,
        # so naming it here is a NameError that only fires when a roster has
        # more sets than FEATURED — i.e. always, but silently never in a test
        # with a short fixture.
        setrest = (f'<details class="setall"><summary>See all {len(collections_)} sets'
                   f'<span> — {len(rest)} more cuts through the same {total}</span>'
                   f'</summary><ul class="setchips">{chips}</ul></details>')

    ncoll = len(collections_)
    nscript = len(by_section.get("Scripture", []))
    nwork = len(by_section.get("Originals", []))

    # Read here rather than passed in: the FAQ is the only consumer, and a
    # missing field must stop the build rather than print a blank number.
    L = load_limits()
    shots = shot_figures()

    faq = [
        ("Is this free?",
         "Yes, and the free plan is the whole app rather than a demo — every kin, "
         "the collections, the stories, memory, and one character of your own. "
         f"What it limits is volume: {_w(L['free_window_messages'])} replies every "
         f"{_w(L['free_window_hours'])} hours, {_w(L['free_max_borrowed_characters'])} "
         f"borrowed kin, {_w(L['free_max_memories'])} remembered facts, and "
         f"{_w(L['moment_paint_free'])} paintings {_paint_window(L)}. Mythkin Plus "
         f"raises those to {_w(L['plus_window_messages'])} replies a day with no "
         f"{_w(L['free_window_hours'])}-hour window, memory with no "
         f"{_w(L['free_max_memories'])}-fact cap, {_w(L['plus_max_created_characters'])} "
         f"characters of your own and {_w(L['moment_paint_plus'])} paintings "
         f"{_paint_window(L)}. It also answers on a more capable model, and is what "
         "lets you publish a story to the marketplace. Prices are whatever "
         "the App Store shows you."),
        # SPARKS FAQ REMOVED 2026-08-22, and it must stay out until they can be
        # BOUGHT. Both consumables sit in MISSING_METADATA on App Store Connect
        # with no price schedule, so StoreKit prices neither and the app's own
        # sparks row — gated on SELLABLE-or-OWNED, app.js:8973 — correctly never
        # renders at 1.0. A public FAQ answering "what are sparks?" for a
        # feature nobody can reach or see is the site describing a product the
        # binary does not have. It also described their persistence in terms the
        # app contradicts on screen: the app says a reinstall leaves the balance
        # unreachable until support relinks it, not that it "stays on the
        # device". Restore this entry in the same change that gives the
        # consumables a price.
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
        ("Is it in the App Store?", store_line),
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
<!-- BUMP THIS WHENEVER og-image.png IS RE-RENDERED. Deliberately typed and
     not a content hash of the PNG: build_app_og.py stamps the card with a
     hash of THIS PAGE, so a token derived from the image would change the
     page, which would stale the stamp, which would re-render the image —
     a loop with no fixed point. A date token converges in one pass.
     Facebook and iMessage cache the old bytes without it.
     It did NOT move for the 2026-08-17 pass: re-rendering produced a
     byte-identical PNG (the card's copy and tokens did not change, only the
     page hash it is stamped against), and a token that moves without the
     bytes moving costs every reader a refetch and makes the next person
     distrust the invariant. Token changes IFF the image changes. -->
<meta property="og:image" content="https://hypersage.ai/mythkin/og-image.png?v=20260816a">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="https://hypersage.ai/mythkin/og-image.png?v=20260816a">
<link rel="icon" type="image/png" href="mythkin-icon.png">
<link rel="apple-touch-icon" href="mythkin-icon.png">
<link rel="sitemap" type="application/xml" href="sitemap.xml">
<link rel="stylesheet" href="style.css?v=20260824-screens">
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
    conversation rather than a chatbot's. Plus anyone else you care to write.</p>
    <div class="cta">
      <a class="btn" href="#rooms">See who is in there</a>
      <a class="btn ghost" href="#make">Or write your own</a>
    </div>
    <ul class="badges">
      <!-- "No sexual content, ever" used to sit in this slot, directly beside
           18+, and it raised the question instead of settling it: half the row
           was what the app refuses, on a page about Cleopatra and Sherlock.
           The refusal is not softened, only moved to where a reader who cares
           goes looking — it keeps its full sentence in the safety block below
           ("not as a tier, not as an unlock, not for verified adults") and its
           own heading on safety.html.
           What replaces it is a claim this repo can actually stand behind:
           `no_account` is an APPROVED absolute claim in
           mythkin/site-audit-contract.json, evidenced down to the line —
           identity is a client-minted device UUID in X-Device-Id
           (mythkin-api/app/deps.py), and the API has no auth routes, no email
           field and no password anywhere. Deliberately NOT "314 characters,
           painted by hand", which was the first draft: the eyebrow six lines
           above already says exactly that, and a badge that repeats the
           headline is a badge doing nothing. -->
      <li>18+</li><li>No account, no email</li>
      <li>No streaks, no guilt</li><li>Every reply marked AI</li>
    </ul>
  </div>
  <figure class="lit" id="lit">
    <!-- The caption said "his opening line" with the name interpolated beside
         it — correct for exactly one hero and wrong for six of the ten now in
         the rotation. There is no gender in the seed and there does not need to
         be one: the byline names the writer, not the pronoun. -->
    <div class="lit-frame" id="lit-frame">{''.join(slides)}
      <!-- WCAG 2.2.2. Content that moves on its own for more than five seconds
           needs a way to stop it, and "we turn it off under Reduce Motion" is
           not that mechanism — it serves one group and leaves everyone else
           watching. Rendered by the page rather than injected by script so it
           exists even if hero.js never runs; hero.js is what gives it a job. -->
      <button type="button" class="lit-pause" id="lit-pause"
              aria-label="Pause the changing portrait" hidden></button>
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
  <!-- "Or invent somebody who never existed" was the heading here, and it
       described a corner of the feature as if it were the feature. Reported
       from the phone: the app "can create people that didn't exist ... but it's
       mostly about the characters that we already have listed, which are mostly
       based in realism or mythological people or historical figures, so it's
       not just about that, and they can create all of those as well if they
       think they can do it better than we did".
       That is three corrections in one sentence: the cast leads, the tool is
       not limited to invention, and the honest pitch for it is that it is the
       same tool we used. The heading now says what it does; the sub says what
       it is allowed to do, and the limit it shares with ours. -->
  <h2>Or write one yourself</h2>
  <p class="sub">The {total} above are the reason to come, and they were written
  with the tools you get. Take a figure we have not reached yet, retell a legend
  the way you think it should go, or write somebody who never existed at all —
  the same rules bind yours as bind ours: nobody living, and nobody who died in
  1950 or later.</p>
  <!-- MARKS, BECAUSE THE BOTTOM OF THIS PAGE HAD STOPPED BEING THE SAME PAGE.
       Above this line every section is paintings; from here down it was four
       text sections in a row — this grid, thirty-one set blurbs, the refusals
       and the FAQ — on one flat ground. Reported as "the bottom half of the
       website seems off", and that is the shape of it: not a bug in any one
       block, a page that runs out of pictures and does not change anything else
       to compensate.
       Stroked SVG in an ember disc, the same idiom the app's own rows use, and
       the ink is --on-tint because the disc IS the tint
       ([[accent-as-ink-on-its-own-tint]]). aria-hidden: each one repeats its own
       heading and adds nothing to a reader who cannot see it. -->
  <div class="feat">
    <div class="card"><span class="card-mark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.6h12a1 1 0 0 1 1 1v15.8l-7-4-7 4V4.6a1 1 0 0 1 1-1Z"/></svg></span><h3>They know who you are</h3>
      <p>Tell one of them something and it sticks — across the conversation,
      across the week, and across every other character you talk to. Nobody has
      to introduce themselves twice.</p>
      <p>It is a list you can actually see, too, not a black box: read everything
      they keep, correct what is wrong, and delete any of it for good.</p></div>
    <div class="card"><span class="card-mark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17.3 3.9 20.1 6.7 8.4 18.4 4 19.8l1.4-4.4L17.3 3.9Z"/><path d="M15.3 5.9l2.8 2.8"/></svg></span><h3>A name, one line, a temperament</h3>
      <!-- Both examples used to be invented people, which quietly repeated the
           heading's old mistake one level down: a historical figure and a god
           are the same three fields as a cottage witch.
           NAMED examples were drafted here and pulled — "Hypatia of Alexandria"
           and "a Norse goddess we never got to" both turned out to be ON the
           roster (Hypatia is seeded; so are Freyja, Skadi and Idun), so the
           copy would have advertised a gap that is not there. A KIND of
           character claims nothing a roster change can falsify. -->
      <p>A philosopher out of a footnote. A river god from your own county. A
      cottage witch who always has tea on. Set their warmth, humour, energy and
      candour, write their backstory and their first line — and their portrait
      is painted the moment they exist, once, and never repainted.</p>
      <p>You can paint one from photographs as well: of yourself, of someone who
      agreed, or of someone you have lost. Those stay in your library, and the
      photographs are deleted the moment the painting is done.</p></div>
    <div class="card"><span class="card-mark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8.4h13.4"/><path d="M14.2 5.2 17.4 8.4l-3.2 3.2"/><path d="M20 15.6H6.6"/><path d="M9.8 12.4 6.6 15.6l3.2 3.2"/></svg></span><h3>Lend them out, borrow somebody else&rsquo;s</h3>
      <p>Publish a character and other people can take them home. You see how
      many are talking, and that is all you see.</p>
      <p>You never get a word of what they said — and nobody gets a word of
      yours when you borrow somebody else's.</p></div>
    <div class="card"><span class="card-mark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11.4 4.6 6.8 8.3H3.6v7.4h3.2l4.6 3.7V4.6Z"/><path d="M15.4 9.2a4 4 0 0 1 0 5.6"/><path d="M18.1 6.5a7.8 7.8 0 0 1 0 11"/></svg></span><h3>They say hello out loud</h3>
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
  {setrest}
</div></section>

<!-- A SCREENSHOT IS A CLAIM. These are captures of the RUNNING app, posed by
     clicking what a user clicks (mythkin-app/tools/site_shots.py, pointed at
     the live API): the reply in the chat shot is whatever the model actually
     wrote, and any count on any screen is whatever the server held. Nothing is
     mocked and nothing may be retouched.
     RE-SHOOT WHEN THE INTERFACE CHANGES, and bump SHOT_V below — a screenshot
     of a build that no longer exists is a false claim rather than a stale
     asset, and a cache still serving the old one makes it a durable one.
     BOTH SCHEMES SHIP, and the swap is CSS rather than a <picture> with a
     prefers-color-scheme <source>: this page has an explicit theme picker, and
     a <picture> resolves before any attribute on <html> is read, so it would
     hand a reader who PICKED Dark the light screenshots. See .shot .pic in
     style.css. -->
<section id="screens"><div class="wrap">
  <h2>What it actually looks like</h2>
  <p class="sub">Captures of the running app, not pictures drawn for this page.
  The reply in the middle one is whatever the character wrote when the shot was
  taken.</p>
  <div class="shots">{shots}</div>
</div></section>

<section id="safety-short" class="safety"><div class="wrap">
  <div class="safety-grid">
    <div>
      <h2>What Mythkin will not do</h2>
      <p class="sub">Companion apps have a bad name for good reasons. Here is
      what we have ruled out — in the product, rather than in a policy nobody
      reads.</p>
      <!-- SAME RULE AS SECTION_NOTE["Scripture"] ABOVE: no corpus is named
           here. This read "figures from the Hebrew Bible and the Gospels" over
           a room that also holds Siddhartha Gautama, Gargi Vachaknavi and Asiya
           bint Muzahim. Say WHERE THEY COME FROM generically, as the app's own
           ROOM_NOTE does, or say nothing. -->
      <p class="sub" style="margin:0">Mythkin is 18+. {nscript} of the kin are
      figures whose stories reach us through scripture, written as teachers —
      warm, story-first, and never here to convert you. That room is ours and is
      marked as ours. The first {nwork}
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
<script>
/* THE MARQUEE STANDS DOWN WHEN IT IS OFF SCREEN.
   CSS can pause it on hover but cannot know whether the strip is in view, and
   three rows of 628 tiles animating behind four screenfuls of other content is
   battery for nothing. One observer, no per-frame work, and it degrades to the
   old always-on behaviour if IntersectionObserver is missing. */
(function(){{
  var m=document.querySelector('.marquee');
  if(!m||!('IntersectionObserver' in window))return;
  new IntersectionObserver(function(es){{
    es.forEach(function(en){{ m.classList.toggle('idle', !en.isIntersecting); }});
  }},{{rootMargin:'120px'}}).observe(m);
}})();
</script>
<script>
/* THE HERO ROTATES. Progressive enhancement all the way down: every slide is
   already in the HTML with the first one carrying `.on`, so with this script
   removed the page is exactly what it was — one composed portrait — rather
   than an empty frame waiting on JS. */
(function(){{
  var frame=document.getElementById('lit-frame');
  if(!frame)return;
  var slides=frame.querySelectorAll('.slide');
  if(slides.length<2)return;
  var btn=document.getElementById('lit-pause');
  var reduce=window.matchMedia?matchMedia('(prefers-reduced-motion: reduce)'):null;
  var i=0,timer=null,paused=false,hover=false;

  function show(n){{
    slides[i].classList.remove('on');
    slides[i].setAttribute('aria-hidden','true');
    i=n;
    slides[i].classList.add('on');
    slides[i].removeAttribute('aria-hidden');
    /* Wake the NEXT slide's image while the current one is still on screen. A
       lazy image that only starts loading as it fades in arrives after the
       crossfade has finished, so the frame shows its own background for a beat
       — the one failure a carousel cannot hide. */
    var nx=slides[(i+1)%slides.length].querySelector('img');
    if(nx&&nx.loading==='lazy')nx.loading='eager';
  }}
  function moving(){{
    return !paused && !hover && !document.hidden && !(reduce&&reduce.matches);
  }}
  function sync(){{
    if(timer){{clearInterval(timer);timer=null;}}
    if(moving())timer=setInterval(function(){{show((i+1)%slides.length);}},{HERO_MS});
    if(btn){{
      /* Nothing to pause when Reduce Motion has already stopped it. */
      btn.hidden=!!(reduce&&reduce.matches);
      btn.dataset.state=paused?'paused':'playing';
      btn.setAttribute('aria-label',
        paused?'Resume the changing portrait':'Pause the changing portrait');
    }}
  }}
  /* hover/focus is a TRANSIENT hold, not the reader's setting — it stops the
     timer without touching `paused`, so the button keeps telling the truth
     about the choice they actually made. */
  ['pointerenter','focusin'].forEach(function(ev){{
    frame.addEventListener(ev,function(){{hover=true;sync();}});
  }});
  ['pointerleave','focusout'].forEach(function(ev){{
    frame.addEventListener(ev,function(){{hover=false;sync();}});
  }});
  document.addEventListener('visibilitychange',sync);
  if(reduce&&reduce.addEventListener)reduce.addEventListener('change',sync);
  if(btn)btn.addEventListener('click',function(){{
    paused=!paused;
    /* A press is a decision, so it outranks the hover hold that the press
       itself created — without this, tapping pause on a touch device leaves
       `hover` true and the button appears to do nothing. */
    hover=false;
    sync();
  }});
  sync();
}})();
</script>
</body>
</html>
"""


# --------------------------------------------------------------------- assets
def export_portraits(kin: list[dict], src_dir: Path, dst: Path,
                     wanted: set[str]) -> set[str]:
    """Copy the 256px portraits the page references, and a 512 for each hero slide.

    Only the referenced ids, because this repo's Pages deploy is size-fragile —
    the deploy step is killed at exactly 10:00 and the payload has been cut
    once already.

    The referenced set is now the WHOLE roster, because the marquee is: ~2.6MB
    of 256px portraits against sibling folders already carrying 6-8MB
    (quietoak 8.5, gemburrow 8.1), so the budget is not the constraint the
    docstring above was written against. What that note still buys is the rule
    that nothing ships unless the page asks for it — `wanted` is parsed back out
    of the built HTML, so an orphan is impossible by construction.
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
    # One 512 per hero slide, not one for the page. Re-encoded rather than
    # copied so a 37KB master does not become the thing that decides how fast
    # the largest element on the page paints.
    for kid in HERO_CAST:
        big = src_dir / "512" / f"{kid}.jpg"
        if not big.exists():
            continue
        im = Image.open(big).convert("RGB")
        im.save(dst / f"{kid}@512.jpg", "JPEG", quality=86, optimize=True)
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

    # Painted-only, to agree with the page. The unfiltered version printed a
    # room census the page does not render and cannot support.
    painted = [k for k in kin if k["id"] in have_art]
    by_section: dict[str, list[dict]] = {}
    for k in painted:
        by_section.setdefault(k.get("section", "Storybook"), []).append(k)
    waiting = [k["id"] for k in kin if k["id"] not in have_art]

    store_line, store_state = store_answer()
    page = build_html(kin, colls, have_art, stories, store_line)

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
        # `{len(kin)} kin` here read 284 while the page it had just verified said
        # 254 everywhere — a green line printing the number the page is
        # deliberately NOT using. Report both, in the order the page cares about.
        print(f"OK: page matches the roster ({len(painted)} painted of "
              f"{len(kin)} seeded, {len(colls)} "
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

    print(f"roster      {len(painted)} painted of {len(kin)} seeded  "
          f"{ {s: len(by_section.get(s, [])) for s in SECTION_ORDER} }")
    print(f"collections {len(colls)}")
    print(f"store       {store_state} (from fleet/state/current.json)")
    print(f"stories     {stories}")
    print(f"portraits   {len(wrote)} exported to mythkin/kin/")
    if nshots:
        print(f"screens     {nshots} JPGs written to mythkin/screens/")
    print(f"page        {len(page) // 1024}KB -> {target}")
    if waiting:
        # NOT a failure: art lands after the seed entry, routinely. But it
        # must be SAID, or "254" quietly becomes the number nobody
        # remembers was ever supposed to be 284.
        print(f"waiting     {len(waiting)} seeded kin have no portrait yet "
              f"and are held off the page: {', '.join(sorted(waiting)[:6])}"
              + (" ..." if len(waiting) > 6 else ""))
    missing = sorted(i for i in referenced if i not in wrote)
    if missing:
        print(f"WARNING: {len(missing)} referenced ids had no art: {missing[:8]}")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
