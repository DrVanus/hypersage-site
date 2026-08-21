"""Render the four app-subsite og-images (1200x630) from each SITE'S OWN pieces.

    python3 tools/build_app_og.py                 # all eleven
    python3 tools/build_app_og.py nightshelf …    # a subset
    python3 tools/build_app_og.py --check         # fail if a page moved under a card

Same philosophy as build_og.py one directory up: these are not design files
drawn beside the site — every card is composed from the subsite's own color
tokens (copied verbatim from its :root), its own Google-Fonts stack, its own
hero copy, and an art asset already shipped in the subsite folder. If the page
rebrands, rerun this; nothing here invents a claim the page doesn't make.

Layout follows the fleet's card pattern (rowan/quietoak): left column carries
kicker -> display headline -> one-breath subhead; right side carries the art.
Two renderer lessons inherited from build_og.py, kept:
  * render from the SUBSITE dir so relative art paths resolve like they do live;
  * judge the result downscaled to ~460px (message-bubble size), not at 1200.
"""
from __future__ import annotations

import hashlib
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
W, H = 1200, 630

FONTS = {
    'nightshelf': 'family=Fraunces:ital,opsz,wght@0,9..144,400..700;1,9..144,400..700&family=Inter:wght@400;500;600;700',
    'mythwright': 'family=Cinzel:wght@500..800&family=Inter:wght@400..800',
    'storyvault': 'family=Inter:wght@400;500;600;700;800&family=Playfair+Display:ital,wght@0,500;0,600;0,700;0,800;1,500;1,600;1,700',
    'saffra': 'family=Inter:wght@400;500;600;700;800&family=Playfair+Display:ital,wght@1,600',
    'quietoak': 'family=Nunito:ital,wght@0,400;0,500;0,600;0,700;0,800;1,600',
    'rowan': '',
    'alder': '',
    'wingmate': 'family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600;700',
    'waddleton': '',
    'mythkin': '',
    'hexhunter': 'family=Cinzel:wght@500;600;700;800;900&family=Inter:wght@400;500;600;700;800',
    'gemburrow': 'family=Baloo+2:wght@600;700;800&family=Inter:wght@400;500;600;700;800',
}

# Per-site card: colors are the site's own :root values, copy is the page's own
# hero/og copy (shortened, never reworded into new claims), art ships with the site.
CARDS = {
    "nightshelf": {
        "art": "app-icon.png",
        "css": """
  .og { background:
        radial-gradient(circle at 79% 46%, rgba(232,177,92,0.16), transparent 58%),
        linear-gradient(160deg, #111527 0%, #0B0E19 62%); }
  .kicker { color: #E8B15C; }
  h1 { font-family: 'Fraunces', Georgia, serif; font-weight: 640; font-size: 78px;
       background-image: linear-gradient(178deg, #FBF6EA 4%, #F6C877 70%, #C68B36 108%); }
  h1 em { font-style: italic; }
  .sub { color: #B7B2C4; }
  .art { width: 424px; height: 424px; border-radius: 96px;
         box-shadow: 0 24px 70px rgba(0,0,0,0.55), 0 0 90px rgba(232,177,92,0.20); }
""",
        "kicker_svg": '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
        "kicker": "Bedtime stories · Coming to iOS",
        "h1": "Stories to <em>drift&nbsp;off</em>&nbsp;to",
        # "with Nightshelf Pro" is load-bearing and must never be trimmed away:
        # conjuring a story is Pro-only with NO free allowance (the backend hard-402s,
        # index.html:706-711). An unqualified "AI stories" line overclaims the free tier.
        "sub": "Eighty-two timeless classics, and calm new ones written by AI with Nightshelf&nbsp;Pro, read aloud in a soft, sleepy voice with ambient sound underneath.",
    },
    "mythwright": {
        "art": "app-icon.png",
        "css": """
  .og { background:
        radial-gradient(circle at 79% 46%, rgba(224,179,76,0.13), transparent 58%),
        linear-gradient(160deg, #1C1509 0%, #0E0B06 62%); }
  .kicker { color: #E0B34C; }
  h1 { font-family: 'Cinzel', Georgia, serif; font-weight: 800; font-size: 72px;
       background-image: linear-gradient(180deg, #FBF3DD 0%, #F6CE6A 70%, #B08526 100%); }
  .sub { color: #C4B189; }
  /* The icon is near-black on a near-black card: lifted so the quill-and-sword
     still reads in a 460px message bubble. */
  .art { width: 424px; height: 424px; border-radius: 28px;
         filter: brightness(1.22) saturate(1.06);
         border: 1px solid rgba(224,179,76,0.30);
         box-shadow: 0 20px 60px rgba(0,0,0,0.55), 0 0 90px rgba(224,179,76,0.16); }
""",
        "kicker": "Collectible card game · Coming to iOS",
        "h1": "Collect.<br>Build.<br>Battle.",
        "sub": "The heroes and monsters of classic literature, at war across three lanes. 256 cards, six factions, a full campaign.",
    },
    "storyvault": {
        "art": "storyvault-mark.png",
        "css": """
  /* Every hex below is copied verbatim from storyvault/index.html :root —
     --card #171030, --bg #0D0620, --bg-deeper #060312, --accent #D9B57F,
     --fg #F5F1E8, --muted-fg #B8AEC6, and --gold-grad for the italic line.
     The site has ONE scheme (no prefers-color-scheme block), so this is it. */
  .og { background: linear-gradient(160deg, #171030 0%, #0D0620 52%, #060312 100%); }
  .kicker { color: #D9B57F; }
  /* Mirrors .hero-text h1: Playfair Display 700, letter-spacing -0.02em. */
  h1 { font-family: 'Playfair Display', 'Iowan Old Style', Georgia, serif; font-weight: 700;
       font-size: 63px; letter-spacing: -0.02em;
       background-image: linear-gradient(178deg, #F5F1E8 30%, #B8AEC6 108%); }
  /* The page's own accent span is .italic-anything.grad — italic 600 painted
     with --gold-grad. "written with you." must stay ONE line; a wrapped orphan
     "you." killed the 460px read, hence 63px + nowrap (measured: 449px in a
     548px column, so it clears). */
  h1 .grad { font-style: italic; font-weight: 600; white-space: nowrap;
       background-image: linear-gradient(115deg, #F3E3BD 0%, #E4C48F 38%, #D9B57F 62%, #C09A62 100%); }
  .sub { color: #B8AEC6; }
  /* The mark's own nebula feathers into the card bg instead of sitting in a box. */
  .art { width: 560px; height: 560px; border-radius: 0;
         -webkit-mask-image: radial-gradient(closest-side, #000 55%, transparent 98%);
         mask-image: radial-gradient(closest-side, #000 55%, transparent 98%); }
""",
        # The page's own eyebrow ornament: .hero-eyebrow::before { content: '✦' }.
        "kicker_svg": '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 1.6l2.3 7.8 7.8 2.3-7.8 2.3-2.3 7.8-2.3-7.8L1.9 11.7l7.8-2.3z"/></svg>',
        # Was "· Coming to iOS", justified by "the page's eyebrow says Coming to
        # iOS and links no App Store". BOTH halves of that premise expired: the app
        # went live 2026-08-17, the page eyebrow now reads "Available now", and it
        # carries 3 App Store links (fetched 2026-08-21). The card is the image every
        # share renders, so it was telling people a shipped app was not out yet.
        "kicker": "AI Adventures · iOS",
        "h1": 'Branching tales,<br><span class="grad">written with you.</span>',
        "sub": "Step into Beowulf, Dracula, or a world only the AI has dreamed. Every choice rewrites the next page.",
    },
    "saffra": {
        "art": "saffra-hat.png",
        "css": """
  .og { background:
        radial-gradient(circle at 79% 52%, rgba(224,130,48,0.16), transparent 55%),
        linear-gradient(160deg, #1A1612 0%, #0E0C0A 62%); }
  /* The page is pre-release ("Coming Soon to iOS", waitlist CTA, no App Store
     link), so the kicker carries that instead of the fleet's "<category> · iOS".
     It is longer, so it is sized down and pinned to one row — a wrapped kicker
     shoves the headline off the card. Measured: 424px of the 568px column. */
  .kicker { color: #E08230; font-size: 19px; letter-spacing: 0.10em; white-space: nowrap; }
  h1 { font-family: 'Inter', sans-serif; font-weight: 800; font-size: 78px;
       background-image: linear-gradient(178deg, #F5EFE5 40%, #9A8E80 122%); }
  /* Exactly the page's own .italic-anything: Playfair italic 600 over the site's
     three-stop warm gradient (--primary-light / --primary / --primary-dark),
     plus its padding-right so the final "d." can't clip on the italic overhang. */
  h1 .ital { font-family: 'Playfair Display', Georgia, serif; font-style: italic; font-weight: 600;
       background-image: linear-gradient(135deg, #F5C088 0%, #E08230 50%, #B8651C 100%);
       padding-right: 0.08em; }
  .sub { color: #9A8E80; }
  .art { width: 470px; height: 470px; }
""",
        "kicker": "AI recipe app · Coming soon to iOS",
        "h1": 'Your kitchen,<br><span class="ital">understood.</span>',
        # 2026-08-19: was "built from a weighted consensus of tested, editor-vetted
        # sources" — a sourcing claim saffra-api cannot support (no request to any
        # recipe publication is ever made; the trust weights were never computed).
        # It shipped INTO THE RENDERED PNG, which is the card people see when the
        # link is shared, so fixing the page alone would have left it live.
        # Completeness is measured and gated: see saffra-ios store/check_frame_claims.py.
        "sub": "Premium recipes you can trust — every amount measured, every step cued, then rewritten for your pantry.",
    },
    "quietoak": {
        "art": "companions/group-painting.png",
        "css": """
  /* The page's own calm-daytime atmosphere (body::before) over --bg, plus the
     sage glow the hero already puts behind this same painting (.hero-image::after).
     Every value is copied out of the subsite's :root — nothing new is mixed. */
  .og { background:
        radial-gradient(ellipse 26% 44% at 78% 52%, rgba(157,191,168,0.20), transparent 65%),
        radial-gradient(ellipse 80% 60% at 20% 0%, rgba(157,191,168,0.22), transparent 60%),
        radial-gradient(ellipse 70% 50% at 85% 15%, rgba(241,201,165,0.18), transparent 70%),
        radial-gradient(ellipse 70% 50% at 50% 100%, rgba(62,125,138,0.05), transparent 70%),
        #F3F6F5; }
  /* The kicker slot carries the BRAND LOCKUP, not a category line. Quietoak has
     no store link — the hero eyebrow says "Coming to iOS" and the CTA is a
     notify-me mailto — so the fleet's "<category> · iOS" kicker would read as an
     availability claim this page does not make. Split exactly the way the nav
     splits it: "Quiet" in --fg, "oak" in --sage-deep. display:block because the
     shared .kicker is a flex row whose 10px gap opened it to "Quiet oak". */
  .kicker { display: block; font-family: 'Nunito', ui-rounded, sans-serif;
            font-size: 100px; font-weight: 800; letter-spacing: -0.01em;
            text-transform: none; color: #21353B; }
  .kicker .oak { color: #6F9C82; }
  /* Flat ink, not a gradient: this site is a declared light, flat design whose
     headline is one token (--fg) with one accent (--primary). The shell's
     background-clip:text machinery is switched off rather than fed an invented ramp. */
  h1 { font-family: 'Nunito', ui-rounded, sans-serif; font-weight: 800; font-size: 58px;
       letter-spacing: -0.025em;
       background-image: none; -webkit-background-clip: border-box; background-clip: border-box;
       color: #21353B; }
  h1 em { font-style: normal; color: #3E7D8A; }   /* the page's own <span class="soft"> */
  .sub { font-family: 'Nunito', ui-rounded, sans-serif; color: #4A5E64;
         /* 440px keeps the page's sentence break ("...DBT skills." / "A crisis
            kit...") instead of orphaning "A crisis" onto the first line. */
         max-width: 440px; }
  /* 506x310 is group-painting.png's own 640x392 aspect to within 0.03%, so
     object-fit: cover crops nothing off the six companions. */
  .art { width: 506px; height: 310px; }
""",
        "kicker": 'Quiet<span class="oak">oak</span>',
        "h1": 'A calmer way to<br><em>practice DBT&nbsp;skills.</em>',
        "sub": "Choose a companion. Real DBT skills. A crisis kit that's always free.",
    },
    "rowan": {
        "art": "art/rowan_welcome.png",
        "css": """
  /* Rowan's page is warm cream, not violet: --bg #FBF4EF under the three
     body::before radial washes, copied verbatim. The third stop is the page's
     own --primary-glow (the .hero-image::after halo) moved under the art. */
  .og { background:
        radial-gradient(ellipse 85% 55% at 15% 0%, rgba(251,227,214,0.85), transparent 62%),
        radial-gradient(ellipse 70% 50% at 88% 10%, rgba(241,234,247,0.90), transparent 68%),
        radial-gradient(ellipse 34% 62% at 78% 50%, rgba(111,91,197,0.14), transparent 65%),
        radial-gradient(ellipse 70% 45% at 50% 100%, rgba(111,91,197,0.05), transparent 70%),
        #FBF4EF; }
  /* No webfonts on this site — the page's own system stacks, or the card
     renders in a face Rowan never uses. .eyebrow is --primary-dark. */
  .kicker { font-family: -apple-system, 'SF Pro Text', BlinkMacSystemFont, system-ui, sans-serif;
            color: #5B49A8; }
  /* Flat --fg ink, not a gradient: kill the shell's background-clip:text or the
     headline renders as transparent glyphs on a light card. */
  h1 { font-family: ui-serif, 'New York', Charter, Georgia, 'Times New Roman', serif;
       font-weight: 700; font-size: 60px; letter-spacing: -0.025em;
       background-image: none; color: #3B2D4F; }
  /* .hero-text h1 .soft — --primary, and upright: the page never italicises it. */
  h1 em { font-style: normal; color: #6F5BC5; }
  .sub { font-family: -apple-system, 'SF Pro Text', BlinkMacSystemFont, system-ui, sans-serif;
         color: #6E5E7C; }
  /* The 712x800 hero sprite at its own ratio — contain, not the shell's cover,
     and no drop-shadow: on cream it greys the halo the art already paints. */
  .art { width: 432px; height: 486px; object-fit: contain; }
""",
        "kicker_svg": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
        "kicker": "Health companion · Coming to iOS",
        "h1": "The health<br>companion that<br><em>knows your story.</em>",
        "sub": "Talk about your day in plain words. Rowan turns it into a record you can use — and a brief you hand your doctor.",
    },
    "alder": {
        "art": "art/alder_steady.png",
        "css": """
  /* Alder is committed-dark ("Hearth"): the page's own --bg #171310 under its own
     glows — the hero halo rgba(224,164,88,0.18) moved to the art side, plus the two
     body::before lamps (amber 0.13, healing green 0.07). */
  .og { background:
        radial-gradient(ellipse 48% 66% at 79% 50%, rgba(224,164,88,0.18), transparent 66%),
        radial-gradient(ellipse 65% 45% at 10% -12%, rgba(224,164,88,0.13), transparent 62%),
        radial-gradient(ellipse 55% 45% at 94% 4%, rgba(143,185,150,0.07), transparent 66%),
        #171310; }
  /* The site's eyebrow is a pill, not bare text: --tint on --tint-soft, --border-strong. */
  .kicker { display: inline-flex; font-size: 19px; letter-spacing: 0.16em; color: #E0A458;
            font-family: -apple-system, 'SF Pro Text', BlinkMacSystemFont, system-ui, sans-serif;
            padding: 9px 20px; background: #3A2E1F; border: 1px solid #4A3D30; border-radius: 999px; }
  /* Alder loads no webfont: h1 is the page's ui-serif stack, body text its system stack. */
  h1 { font-family: ui-serif, Georgia, 'Times New Roman', serif; font-weight: 700; font-size: 72px;
       background-image: linear-gradient(180deg, #F5EDE3 0%, #F5EDE3 100%); }
  /* The hero's .soft span is flat --tint and NOT italic. The shell only clips
     .grad/.ital, so em carries its own clip; nowrap keeps "at 3am." whole. */
  h1 em { font-style: normal; white-space: nowrap; color: transparent;
          -webkit-background-clip: text; background-clip: text;
          background-image: linear-gradient(180deg, #E0A458 0%, #E0A458 100%); }
  .sub { font-family: -apple-system, 'SF Pro Text', BlinkMacSystemFont, system-ui, sans-serif;
         color: #A99C8C; }
  /* The companion ships RGB with a baked dark field, so the page's own mask feathers
     it into the card instead of pasting a square onto it. */
  .art { width: 470px; height: 470px;
         -webkit-mask-image: radial-gradient(closest-side, #000 58%, transparent 92%);
         mask-image: radial-gradient(closest-side, #000 58%, transparent 92%); }
""",
        "kicker": "Sobriety companion · Coming to iOS · 18+",
        "h1": "Someone to<br>talk to <em>at 3am.</em>",
        "sub": "It counts your sober time, sits with you through an urge, and never makes you feel small for having one. No account, no name, no email.",
    },
    "wingmate": {
        "art": "app-icon.png",
        "css": """
  /* body::before's mesh, verbatim, over --bg — plus the hero-art's own amber
     halo (rgba(232,168,56,0.14)) moved to where the icon sits on the card. */
  .og { background:
        radial-gradient(ellipse 44% 62% at 79% 50%, rgba(232,168,56,0.14), transparent 62%),
        radial-gradient(ellipse 60% 50% at 10% -8%, rgba(232,168,56,0.10), transparent 55%),
        radial-gradient(ellipse 50% 40% at 95% 5%, rgba(167,139,250,0.07), transparent 55%),
        radial-gradient(ellipse 70% 45% at 50% 110%, rgba(52,211,153,0.05), transparent 65%),
        #13151A; }
  .kicker { color: #E8A838; }
  /* The page's h1 is flat --fg-strong, but the shell clips h1 to a gradient — so
     white is spelled as a flat two-stop rather than invented as a ramp. */
  h1 { font-family: 'Space Grotesk', 'Inter', sans-serif; font-weight: 700; font-size: 66px;
       line-height: 1.18; letter-spacing: -0.02em;
       background-image: linear-gradient(#FFFFFF, #FFFFFF); }
  /* .grad-text — the page's own accent on "actually get it." (not italic there). */
  h1 em { font-style: normal;
       -webkit-background-clip: text; background-clip: text; color: transparent;
       background-image: linear-gradient(135deg, #F5CC6A 10%, #E8A838 90%); }
  .sub { color: #9CA3B4; }
  /* Radius is the site's own icon treatment (.brand img = 10px on 36px, scaled);
     the halo is --amber-glow-strong so a near-black tile leaves a near-black card. */
  .art { width: 424px; height: 424px; border-radius: 118px;
         box-shadow: 0 24px 70px rgba(0,0,0,0.55), 0 0 90px rgba(232,168,56,0.24); }
""",
        "kicker_svg": '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
        # Live since 2026-08-20; page links the App Store and says nothing about
        # "coming". Follows the fleet's "<category> · iOS" kicker convention.
        "kicker": "Dating coach · iOS",
        "h1": 'AI dating<br>coaches that<br><em>actually get&nbsp;it.</em>',
        "sub": "Four coaches, four perspectives. Drop a screenshot and get exact replies to send — platform-aware advice for Tinder, Hinge, Bumble, and texting.",
    },
    "waddleton": {
        "art": "waddleton-icon.png",
        "css": """
  .og { background:
        radial-gradient(circle at 78% 44%, rgba(79,208,192,0.20), transparent 56%),
        radial-gradient(circle at 97% 88%, rgba(176,138,255,0.16), transparent 50%),
        linear-gradient(160deg, #0A1230 0%, #0B1026 64%); }
  /* Waddleton loads no webfont, so FONTS["waddleton"] is "" — these two rules put the
     site's own system stack back over the shell's 'Inter' default. */
  .kicker, .sub { font-family: -apple-system, 'Avenir Next', 'Segoe UI', system-ui, sans-serif; }
  .kicker { color: #4FD0C0; }
  h1 { font-family: -apple-system, 'Avenir Next', 'Segoe UI', system-ui, sans-serif;
       font-weight: 800; font-size: 58px;
       background-image: linear-gradient(178deg, #F4F9FF 8%, #EAF4FF 100%); }
  /* The page's own .hero h1 .grad, tokens resolved: aurora-teal -> ice -> aurora-violet.
     58px is the size at which "A snowy island to" still holds one line in the 568px
     column — at 60px "to" drops to an orphan line. */
  h1 .grad { background-image: linear-gradient(110deg, #4FD0C0 0%, #59C8FF 45%, #B08AFF 100%); }
  .sub { color: #A8BEDE; }
  .art { width: 424px; height: 424px; border-radius: 96px;
         border: 1px solid rgba(255,255,255,0.17);
         box-shadow: 0 24px 70px rgba(0,0,0,0.55), 0 0 100px rgba(79,208,192,0.22); }
""",
        "kicker_svg": '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.5v19M3.77 7.25l16.46 9.5M20.23 7.25L3.77 16.75"/><path d="M9.4 5.1L12 6.9l2.6-1.8M9.4 18.9L12 17.1l2.6 1.8"/><path d="M4.2 10.9l3.1.9-.8 3.1M19.8 13.1l-3.1-.9.8-3.1"/><path d="M19.8 10.9l-3.1.9.8 3.1M4.2 13.1l3.1-.9-.8-3.1"/></svg>',
        "kicker": "Free · Plays in your browser",
        "h1": 'A snowy island to<br><span class="grad">waddle&nbsp;around.</span>',
        "sub": "Make a penguin, wander a painted arctic island, meet other players, and dive into 15 arcade games. No sign-up, no cost.",
    },
    "mythkin": {
        "art": "mythkin-icon.png",
        "css": """
  /* EMBER, NOT PLUM. Every value below was the pre-Ember purple brand and had
     to be re-copied: the card was still rendering --tint #6B3FA0 and --text
     #1A1526 long after the site and the app moved to the hearth palette, so a
     link shared into iMessage showed a purple card for a terracotta product,
     under a headline the page had already stopped using. Tokens verbatim from
     mythkin/style.css :root — --bg #FBF6EC, --surface #FFFFFF, --text #1F1512,
     --dim #6E6058, --tint #8C3A2B, --goldText #7E6010.

     The page's own hero sits on a warm radial in the tint; this is that wash,
     which is also what stops a cream card reading as a blank rectangle at
     message-bubble size. */
  .og { background:
        radial-gradient(circle at 78% 48%, rgba(140,58,43,0.17), transparent 56%),
        radial-gradient(ellipse 70% 60% at 12% 8%, rgba(180,97,28,0.10), transparent 62%),
        linear-gradient(160deg, #FFFFFF 0%, #FBF6EC 44%); }
  .kicker { color: #7E6010; }
  h1 { font-family: 'New York', 'Iowan Old Style', Georgia, serif; font-weight: 700; font-size: 56px;
       background-image: linear-gradient(178deg, #1F1512 26%, #8C3A2B 116%); }
  h1 em { font-style: italic; }
  /* Mythkin loads no webfont at all: --serif above and --sans here are its own
     stacks, so the card uses them instead of the shell's Inter. */
  .kicker, .sub { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .sub { color: #6E6058; }
  /* 106px is the site's own icon rounding — .mark img is 11px on a 44px tile —
     and the dark painted tile is what carries this otherwise pale card. */
  .art { width: 424px; height: 424px; border-radius: 106px;
         box-shadow: 0 26px 60px rgba(31,21,18,0.30), 0 0 90px rgba(140,58,43,0.20); }
""",
        # The page's own spark glyph (.bf-glyph--spark, drawn in var(--gold)).
        "kicker_svg": '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 3l1.9 6.1L20 11l-6.1 1.9L12 19l-1.9-6.1L4 11l6.1-1.9z"/></svg>',
        # No "· iOS" here, unlike the other four: the page says Mythkin is not in
        # the app stores yet, so the card must not imply it ships.
        # The card's copy is the PAGE's copy. Both were rewritten on 2026-08-16
        # when the site stopped leading on memory — which is table stakes and
        # sold nobody — and started leading on the cast, which is the reason
        # anyone installs this. The old card said "Characters made by people,
        # alive with you" over a subhead ending "and they remember", neither of
        # which appears on the page any more.
        "kicker": "AI characters · 18+",
        "h1": "Every conversation<br><em>you never got to have.</em>",
        "sub": "Cleopatra. Sherlock Holmes. Marcus Aurelius. Ada Lovelace. Hundreds of figures out of history, myth and literature — written at length, painted once, and ready to talk.",
    },
    "gemburrow": {
        "art": "shots/daily.jpg",
        "css": """
  /* The page's own lantern wash (body::before) over --bg-2 -> --bg, with one
     extra warm pass at the top so the card carries the same light the shop room
     does at message-bubble size. Every colour below is a :root token from
     gemburrow/index.html — nothing new is mixed. */
  .og { background:
        radial-gradient(ellipse 74% 60% at 20% -6%, rgba(255,205,110,0.18), transparent 60%),
        radial-gradient(ellipse 85% 55% at 50% -8%, rgba(255,205,110,0.14), transparent 58%),
        radial-gradient(ellipse 60% 40% at 12% 22%, rgba(224,138,60,0.07), transparent 62%),
        radial-gradient(ellipse 75% 55% at 50% 106%, rgba(120,74,30,0.16), transparent 66%),
        linear-gradient(160deg, #1E1510 0%, #17100A 62%); }
  /* One row or the headline gets shoved down (the saffra lesson): the full
     "Cozy gem-digging puzzle · Coming to iPhone" wrapped at 21px, so it is
     sized down and pinned. Measured: 519px of the 568px column. */
  .kicker { color: #E08A3C; font-size: 19px; letter-spacing: 0.10em; white-space: nowrap; }
  /* Baloo 2 at 800 is the page's own display face; 54px keeps "Feed the dragon."
     on one line at this width. */
  h1 { font-family: 'Baloo 2', 'Trebuchet MS', system-ui, sans-serif; font-weight: 800;
       font-size: 54px; letter-spacing: -0.01em;
       background-image: linear-gradient(178deg, #F6ECDC 62%, #CBB79C 165%); }
  h1 .grad { background-image: linear-gradient(100deg, #FFE9A8, #E3A24A 55%, #E0475B); }
  .sub { color: #CBB79C; max-width: 540px; }
  /* The Daily Dig frame, bled full height and feathered into the lantern glow —
     828x1795 at h=630 is w=291, so nothing is cropped off the jar. */
  .art { width: 291px; height: 630px; object-position: 50% 42%;
         -webkit-mask-image: linear-gradient(90deg, transparent 0%, #000 26%, #000 100%);
         mask-image: linear-gradient(90deg, transparent 0%, #000 26%, #000 100%); }
""",
        "kicker": "Cozy gem-digging puzzle \u00b7 Coming to iPhone",
        "h1": 'Dig the jar.<br>Feed the <span class="grad">dragon.</span>',
        "sub": "Every gem and rock is real physics: pull one out and the whole pile settles. Fill the orders on the line \u2014 and decide what the dragon keeps.",
    },
    "holohound": {
        "art": "app-icon.png",
        "css": """
  /* Midnight Holo, re-keyed from holohound/style.css :root (dark block) --
     every hex below is one of that file's own --bg/--surface/--tint/--holo
     tokens, nothing invented for this card. */
  .og { background:
        radial-gradient(circle at 80% 40%, rgba(157,139,255,0.16), transparent 58%),
        linear-gradient(160deg, #131829 0%, #0A0D18 62%); }
  .kicker { color: #9D8BFF; }
  h1 { font-weight: 800; font-size: 66px; letter-spacing: -0.01em;
       background-image: linear-gradient(120deg, #4EE1FF, #8B7BFF 38%, #FF7BD5 68%, #F5C84C); }
  .sub { color: #96A0B8; max-width: 540px; }
  /* The icon on a holo card, same treatment as the app's own tab-bar mark:
     a rounded square lifted off the dark ground with the holo gradient as glow. */
  .art { width: 340px; height: 340px; border-radius: 76px;
         box-shadow: 0 24px 70px rgba(0,0,0,0.55), 0 0 90px rgba(157,139,255,0.22); }
""",
        "kicker": "Pok\u00e9mon card scanner + AI companion \u00b7 Coming to iOS",
        "h1": "Hound knows your binder \u2014<br>and the market.",
        "sub": "Ask what you\u2019re missing, what\u2019s worth flipping, or what a card is really worth \u2014 sources named every time. Scanning stays free and unlimited.",
    },
    "hexhunter": {
        "art": "assets/art/cover.jpg",
        "css": """
  /* The page's own atmosphere (body::before) over --bg-2 -> --bg, plus one extra
     --violet-glow pass so the top-left burns as hot as the 640px card this replaces. */
  .og { background:
        radial-gradient(ellipse 78% 62% at 14% -4%, rgba(139,92,246,0.22), transparent 60%),
        radial-gradient(ellipse 90% 60% at 15% -5%, rgba(139,92,246,0.16), transparent 55%),
        radial-gradient(ellipse 70% 50% at 90% 5%, rgba(212,175,55,0.07), transparent 60%),
        radial-gradient(ellipse 80% 60% at 50% 108%, rgba(109,40,217,0.14), transparent 65%),
        linear-gradient(160deg, #120E1F 0%, #0C0A14 62%); }
  .kicker { color: #D4AF37; }
  /* Cinzel has no true lowercase, so this reads as caps exactly like the page's
     hero h1; the 18-character first line sets the ceiling at 52px (56px wraps to 4). */
  h1 { font-family: 'Cinzel', Georgia, serif; font-weight: 800; font-size: 52px;
       background-image: linear-gradient(178deg, #ECE7F5 60%, #A99EC2 165%); }
  h1 .grad { background-image: linear-gradient(180deg, #F0D875 0%, #D4AF37 78%); }
  .sub { color: #A99EC2; }
  /* The hero's own cover plate (the page's .hero-bg), bled full-height like the
     card it replaces and feathered into the violet so the huntress faces the horde. */
  .art { width: 540px; height: 630px; object-position: 60% 45%; opacity: 0.82;
         -webkit-mask-image: linear-gradient(90deg, transparent 0%, #000 40%, #000 100%);
         mask-image: linear-gradient(90deg, transparent 0%, #000 40%, #000 100%); }
""",
        "kicker": "Gothic horde-survivor · Coming to iOS",
        "h1": 'Survive the Horde.<br>Draft Your <span class="grad">Doom.</span>',
        "sub": "Pick a hero, draft upgrades every level, evolve your weapons into ascended forms, and fight to survive the endless dark.",
    },
}

SHELL = """<!DOCTYPE html><html><head><meta charset="utf-8">
{font_link}
<style>
  * {{ margin: 0; padding: 0; box-sizing: border-box; }}
  .og {{ width: {w}px; height: {h}px; overflow: hidden; display: flex; align-items: center; }}
  .og-left {{ width: 660px; padding: 0 8px 0 84px; }}
  .kicker {{ display: flex; align-items: center; gap: 10px; font-family: 'Inter', sans-serif;
            font-size: 21px; font-weight: 700; letter-spacing: 0.13em; text-transform: uppercase;
            margin-bottom: 30px; }}
  .kicker svg {{ width: 22px; height: 22px; }}
  h1 {{ line-height: 1.12; letter-spacing: 0.005em; padding-bottom: 0.12em;
       -webkit-background-clip: text; background-clip: text; color: transparent;
       margin-bottom: 26px; }}
  h1 .grad, h1 .ital {{ -webkit-background-clip: text; background-clip: text; color: transparent; }}
  .sub {{ font-family: 'Inter', sans-serif; font-size: 26px; line-height: 1.5; max-width: 560px; }}
  .og-right {{ flex: 1; display: flex; align-items: center; justify-content: center; }}
  .art {{ object-fit: cover; }}
{css}
</style></head><body>
<div class="og">
  <div class="og-left">
    <div class="kicker">{kicker_svg}{kicker}</div>
    <h1>{h1}</h1>
    <p class="sub">{sub}</p>
  </div>
  <div class="og-right"><img class="art" src="{art}"></div>
</div>
</body></html>"""



# ---------------------------------------------------------------------------
# Drift gate
#
# The cards' copy is deliberately NOT lifted from the page the way build_og.py
# lifts the root's figure: a card subhead is a shortened, line-broken rewrite of
# a hero lede, and blind-lifting produces four-line paragraphs that shrink the
# type to nothing. What can be automated is noticing when the page has moved
# out from under a card, and refusing the two kinds of lie found in the
# 2026-08-11 audit:
#
#   * a NUMBER in the picture the page contradicts — waddleton's card said
#     "14 arcade games" while its own og:description said 15;
#   * an AVAILABILITY claim the store does not support — four cards said
#     "· iOS" for apps with no App Store listing anywhere on their page.
#
# The digest deliberately covers only what a card depends on — the site's CSS
# custom properties, its <h1>, its og:description, and the art file's bytes — so
# an FAQ rewrite does not cry stale while a rebrand, a retitle, a repositioning
# or a repainted icon does.
# ---------------------------------------------------------------------------

def _site_css(name: str) -> str:
    """The subsite's CSS, inline or linked — where its :root tokens live."""
    html = (ROOT / name / "index.html").read_text()
    css = "\n".join(re.findall(r"<style>(.*?)</style>", html, re.S))
    for href in re.findall(r'<link rel="stylesheet" href="([^"]+\.css)[^"]*"', html):
        f = ROOT / name / href.split("?")[0]
        if f.exists():
            css += "\n" + f.read_text()
    return css


def _page_text(name: str) -> str:
    html = (ROOT / name / "index.html").read_text()
    html = re.sub(r"<(script|style)\b.*?</\1>", " ", html, flags=re.S)
    return re.sub(r"<[^>]+>", " ", html)


def signals(name: str) -> dict:
    html = (ROOT / name / "index.html").read_text()
    tokens = sorted(set(re.findall(r"(--[\w-]+)\s*:\s*([^;]+);", _site_css(name))))
    h1 = re.search(r"<h1[^>]*>(.*?)</h1>", html, re.S)
    og = re.search(r'<meta property="og:description" content="([^"]*)"', html)
    # og:title too: a RETITLE is exactly the drift that would not show up in the
    # h1 or the tokens — storyvault was renamed mid-audit on 2026-08-11 — and the
    # card's headline is the page's title in shortened form.
    ogt = re.search(r'<meta property="og:title" content="([^"]*)"', html)
    art = (ROOT / name / CARDS[name]["art"])
    return {
        "tokens": ["%s:%s" % (k, v.strip()) for k, v in tokens],
        "h1": re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", h1.group(1))).strip() if h1 else "",
        "og_description": og.group(1) if og else "",
        "og_title": ogt.group(1) if ogt else "",
        "art_sha": hashlib.sha256(art.read_bytes()).hexdigest() if art.exists() else "MISSING",
    }


def digest(name: str) -> str:
    s = signals(name)
    h = hashlib.sha256()
    for part in ("\n".join(s["tokens"]), s["h1"], s["og_title"],
                 s["og_description"], s["art_sha"]):
        h.update(part.encode())
        h.update(b"\0")
    return h.hexdigest()


def stamp_path(name: str) -> pathlib.Path:
    return ROOT / name / "og-image.inputs.sha256"


def check(names: list[str]) -> int:
    bad = 0
    for name in names:
        c = CARDS[name]
        problems = []

        art = ROOT / name / c["art"]
        if not art.exists():
            problems.append(f'art {c["art"]} does not exist')

        # THE THING THIS GATE IS ABOUT HAS TO EXIST. Everything below compares
        # the card's INPUTS against the page, which is the interesting check and
        # was the only one — so deleting og-image.png outright reported `ok`.
        # A missing card is not a subtle drift: the link unfurls with no image
        # at all, which is the worst outcome the whole tool exists to prevent,
        # and it was the one state that passed silently.
        out = ROOT / name / "og-image.png"
        if not out.exists():
            problems.append("og-image.png does not exist — the link unfurls blank")
        else:
            size = out.stat().st_size
            if size < 20_000:
                problems.append(
                    f"og-image.png is only {size // 1024}KB — these render at "
                    "1200x630 and land 200KB+; this is a blank or truncated write")
            # Facebook and iMessage both reject or letterbox a card that is not
            # close to 1.91:1, and a wrong-sized PNG here means someone rendered
            # it by hand rather than with this tool.
            head = out.read_bytes()[:33]
            if head[:8] == b"\x89PNG\r\n\x1a\n" and head[12:16] == b"IHDR":
                w = int.from_bytes(head[16:20], "big")
                h = int.from_bytes(head[20:24], "big")
                if (w, h) != (W, H):
                    problems.append(f"og-image.png is {w}x{h}, not {W}x{H}")

        page = _page_text(name)
        copy = " ".join(str(c.get(k, "")) for k in ("kicker", "h1", "sub"))
        copy_text = re.sub(r"<[^>]+>", " ", copy)
        # Digits only: a card that spells "Eighty-two" cannot be checked this
        # way, and pretending otherwise would be a gate that reports safety it
        # does not provide.
        for n in sorted(set(re.findall(r"\b\d[\d,]*\+?\b", copy_text))):
            if n not in page:
                problems.append(f'card says "{n}" — not found anywhere on the page')

        kicker = re.sub(r"<[^>]+>", "", str(c.get("kicker", ""))).lower()
        if "ios" in kicker and "coming" not in kicker:
            if "apps.apple.com" not in (ROOT / name / "index.html").read_text():
                problems.append('kicker claims "iOS" but the page links no App Store listing '
                                '— say "Coming to iOS" until it ships')

        # Compare colours NORMALIZED. mythkin declares --surface:#fff and the
        # card writes #FFFFFF; those are the same colour, and a gate that calls
        # that drift is a gate people learn to ignore.
        def _hexes(text: str) -> set[str]:
            out = set()
            for h in re.findall(r"#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b", text):
                h = h.lower()
                out.add("".join(ch * 2 for ch in h) if len(h) == 3 else h)
            return out

        # Pure black and white are structural, not brand: hexhunter's #000 is a
        # mask-image alpha stop and every card's shadow is some rgba(0,0,0,..).
        # The point of this check is catching an INVENTED palette after a
        # rebrand, not policing scrims.
        site_hexes = _hexes(_site_css(name)) | {"000000", "ffffff"}
        for hexcol in sorted(_hexes(c["css"]) - site_hexes):
            problems.append(f'card colour #{hexcol} appears nowhere in the site CSS '
                            f'— it is not one of this site\'s tokens')

        sp = stamp_path(name)
        have = sp.read_text().strip() if sp.exists() else "(never stamped)"
        want = digest(name)
        if have != want:
            problems.append("never stamped — render it once so drift can be detected"
                            if not sp.exists() else
                            f"page moved since this card was rendered "
                            f"(stamped {have[:12]}, now {want[:12]}) — re-render it")

        if problems:
            bad += 1
            print(f"FAIL {name}")
            for p in problems:
                print(f"       - {p}")
        else:
            print(f"ok   {name}")
    if bad:
        print(f"\n{bad} card(s) need attention. Re-render with: "
              f"python3 tools/build_app_og.py <site>")
    return 1 if bad else 0

def render(names: list[str]) -> None:
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        pg = b.new_page(viewport={"width": W, "height": H}, device_scale_factor=1)
        for name in names:
            c = CARDS[name]
            # Four of the eleven subsites ship no webfont at all; handing them an
            # empty css2? query would request a broken stylesheet and leave
            # document.fonts.status pending. They style their own stack in css.
            q = FONTS.get(name, "")
            font_link = (f'<link href="https://fonts.googleapis.com/css2?{q}&display=block" '
                         f'rel="stylesheet">') if q else ""
            html = SHELL.format(w=W, h=H, font_link=font_link, css=c["css"],
                                kicker_svg=c.get("kicker_svg", ""), kicker=c["kicker"],
                                h1=c["h1"], sub=c["sub"], art=c["art"])
            # Written into the SUBSITE dir so the art path resolves as it does live.
            tmp = ROOT / name / "_og_render.html"
            tmp.write_text(html)
            try:
                pg.goto(tmp.as_uri())
                # Webfonts or bust: a fallback-font card is a broken card.
                pg.wait_for_function("document.fonts.status === 'loaded'", timeout=15000)
                pg.wait_for_timeout(150)
                out = ROOT / name / "og-image.png"
                pg.screenshot(path=str(out))
                # Stamp what this render was made of, so --check can tell later
                # whether the page moved on without it.
                stamp_path(name).write_text(digest(name) + "\n")
                print(f"wrote {name}/og-image.png  {out.stat().st_size // 1024} KB")
            finally:
                tmp.unlink(missing_ok=True)
        b.close()


if __name__ == "__main__":
    args = sys.argv[1:]
    checking = "--check" in args
    picked = [a for a in args if not a.startswith("-")] or list(CARDS)
    unknown = [n for n in picked if n not in CARDS]
    if unknown:
        sys.exit(f"unknown site(s): {', '.join(unknown)} — know: {', '.join(CARDS)}")
    sys.exit(check(picked)) if checking else render(picked)
