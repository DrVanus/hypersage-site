#!/usr/bin/env python3
"""Gate: the visit counter runs on exactly the pages the privacy policy names.

privacy.html#visit-counter says a script of ours counts visits "On the studio
pages and the Wingmate, Saffra, StoryVault AI, Nightshelf and Hexhunter pages"
and that every other page carries no counter. This checks that sentence against
the tree, in both directions, and against the counter's own path allowlist:

  1. The policy names exactly the counted products (COUNTED below).
  2. Every page of the studio root and of each counted folder loads
     <script src="/v.js" defer></script> exactly once (redirect stubs and the
     search-console verification file excepted), and no other page, script,
     stylesheet or manifest in the repo mentions v.js or hs-tally.
  3. v.js treats exactly those folders as counted (its 404 folder list).
  4. The Worker's COUNTED_FILES block (fleet/worker/hs-tally/src/index.mjs,
     or $HS_TALLY_SRC) lists exactly the tagged pages. Pass --no-worker to
     skip this when the fleet checkout is not on this machine.
  5. The retired sentences ("we run no analytics", "collects nothing", ...)
     appear on no counted page, privacy.html carries id="visit-counter", and
     each counted product's privacy page links to it.

    python3 tools/test_counter_claims.py            # exit 1 on any failure
    python3 tools/test_counter_claims.py --no-worker
"""
import html
import os
import re
import sys

REPO = os.path.dirname(os.path.abspath(os.path.dirname(__file__)))
WORKER_SRC = os.environ.get("HS_TALLY_SRC") or os.path.expanduser(
    "~/Developer/DrVanus/fleet/worker/hs-tally/src/index.mjs")

# folder -> the name the policy uses for it
COUNTED = {"wingmate": "Wingmate", "saffra": "Saffra", "storyvault": "StoryVault AI",
           "nightshelf": "Nightshelf", "hexhunter": "Hexhunter"}
PRIVACY_PAGE = {"hexhunter": "hexhunter/privacy-policy.html"}
TAG = '<script src="/v.js" defer></script>'
RETIRED = ("we run no analytics", "collects nothing", "holds nothing about you",
           "it collects nothing, sets no cookies", "runs no analytics")
SKIP_DIRS = {".git", "node_modules"}
LOADABLE = (".html", ".htm", ".js", ".mjs", ".cjs", ".css", ".svg", ".xml", ".json", ".webmanifest")

failures = []


def fail(msg):
    failures.append(msg)


def read(rel):
    with open(os.path.join(REPO, rel), encoding="utf-8", errors="replace") as f:
        return f.read()


def all_files():
    for root, dirs, files in os.walk(REPO):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for name in files:
            yield os.path.relpath(os.path.join(root, name), REPO).replace(os.sep, "/")


def is_stub(rel, text):
    return (re.search(r'<meta[^>]+http-equiv="refresh"', text, re.I) is not None
            or re.fullmatch(r"google[0-9a-f]+\.html", os.path.basename(rel)) is not None)


def visible_text(text):
    t = re.sub(r"<script(?![^>]*ld\+json)[^>]*>.*?</script>|<style.*?</style>", " ", text, flags=re.S | re.I)
    metas = " ".join(re.findall(r'<meta[^>]+content="([^"]*)"', t))
    t = re.sub(r"<[^>]+>", " ", t) + " " + metas
    return re.sub(r"\s+", " ", html.unescape(t)).lower()


def main(argv):
    files = sorted(all_files())
    html_files = [f for f in files if f.endswith(".html")]

    # 1. the policy sentence
    policy = visible_text(read("privacy.html"))
    m = re.search(r"on the studio pages and the (.+?) pages, a short script of ours", policy)
    if not m:
        fail("privacy.html: the sentence naming the counted pages was not found")
    else:
        named = [n.strip() for n in re.split(r",| and ", m.group(1)) if n.strip()]
        want = sorted(v.lower() for v in COUNTED.values())
        if sorted(named) != want:
            fail("privacy.html names %s as counted, the gate expects %s" % (named, want))
    if 'id="visit-counter"' not in read("privacy.html"):
        fail('privacy.html has no id="visit-counter" anchor')

    # 2. which pages load the counter, and which should
    tagged, expected = set(), set()
    for f in html_files:
        text = read(f)
        top = f.split("/")[0] if "/" in f else ""
        if (top == "" or top in COUNTED) and not is_stub(f, text):
            expected.add(f)
        n = text.count(TAG)
        if n:
            tagged.add(f)
        if n > 1:
            fail("%s loads v.js %d times" % (f, n))
    for f in sorted(expected - tagged):
        fail("%s is a counted page but does not load v.js" % f)
    for f in sorted(tagged - expected):
        fail("%s loads v.js but is not a counted page (the policy says it carries no counter)" % f)
    for f in files:
        # Anything a browser could run or load (docs such as README.md are fine).
        if f in tagged or f == "v.js" or not f.endswith(LOADABLE):
            continue
        if re.search(r"/v\.js\b|hs-tally", read(f)):
            fail("%s mentions v.js or hs-tally outside the counted pages" % f)

    # 3. v.js's own idea of the counted folders
    vjs = read("v.js")
    m = re.search(r"/\^\(([a-z|]+)\)\$/\.test\(f\)", vjs)
    if not m or sorted(m.group(1).split("|")) != sorted(COUNTED):
        fail("v.js's counted-folder list %s != %s" % (m and m.group(1), "|".join(sorted(COUNTED))))

    # 4. the Worker's allowlist
    if "--no-worker" not in argv:
        try:
            src = open(WORKER_SRC, encoding="utf-8").read()
        except OSError:
            fail("cannot read the Worker source at %s (set HS_TALLY_SRC or pass --no-worker)" % WORKER_SRC)
        else:
            block = re.search(r"// BEGIN COUNTED_FILES hypersage\.ai(.*?)// END COUNTED_FILES hypersage\.ai", src, re.S)
            listed = set(re.findall(r'"([^"]+\.html)"', block.group(1))) if block else None
            if listed is None:
                fail("the Worker source has no COUNTED_FILES block")
            elif listed != tagged:
                fail("Worker COUNTED_FILES differs from the tagged pages: only in Worker %s, only tagged %s"
                     % (sorted(listed - tagged), sorted(tagged - listed)))

    # 5. retired sentences and the per-product pointer
    for f in sorted(tagged):
        text = visible_text(read(f))
        for phrase in RETIRED:
            if phrase in text:
                fail('%s still says "%s"' % (f, phrase))
    for folder in COUNTED:
        page = PRIVACY_PAGE.get(folder, folder + "/privacy.html")
        if "privacy.html#visit-counter" not in read(page):
            fail("%s does not link to the website policy's #visit-counter section" % page)

    if failures:
        for msg in failures:
            print("FAIL " + msg)
        print("%d failure(s)" % len(failures))
        return 1
    print("ok   %d counted pages; policy, v.js%s agree; no retired sentence on a counted page"
          % (len(tagged), "" if "--no-worker" in argv else " and the Worker allowlist"))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
