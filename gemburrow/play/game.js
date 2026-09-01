/* Gemburrow — single-file canvas engine.
 * Scaffolded by new-game-scaffold. READ HANDOFF.md before editing: the RNG
 * firewall (§3a) and the fixed-timestep loop (§3b) are load-bearing.
 *
 * Layout (top-down, so greps land):
 *   CFG / WORLD constants -> RNG FIREWALL (3 lanes) -> GEM/ORDER tables
 *   -> WORLD sampling (pure: jarBodySpec / orderSpec) -> Jar (DOM-free sim)
 *   -> node export -> [DOM guard] -> Sfx -> Game (loop) -> boot + dev
 */
(function () {
  'use strict';

  // ===== CFG / WORLD =======================================================
  var CFG = {
    stepHz: 120,          // fixed physics substep rate. NOT the frame rate.
    gravity: 1500,        // world px/s^2 inside the jar
    // 0.90, not 0.985. THE PILE NEVER STOPPED MOVING.
    //
    // step() derives velocity from the solver's positional correction
    // (`b.vx = (b.x - b.px) / STEP * CFG.damping`), so at 0.985 a seated body
    // re-injects almost all of the overlap push it just received and trades it
    // against gravity forever instead of decaying. Measured over 60 jars at
    // 1/120: at 0.985, 36 of 60 NEVER reach rest and the same 36 are still
    // moving 600 steps after anyone last touched them — an untouched pile that
    // clacks at the player indefinitely. It also means `settled()` can never
    // fire, so `start()`'s `fastForward(2400)` runs its full cap on every
    // level start, every RETRY, every AGAIN and every archive dig.
    //
    //   damping   never settle   still moving when idle   p50 steps   worst
    //   0.985        36/60             36/60                2400      2400
    //   0.95         21/60             21/60                 670      2400
    //   0.92          3/60              3/60                 827      2400
    //   0.90          0/60              0/60                 961      1198
    //   0.85          0/60              0/60                1313      1481
    //
    // 0.90 is where both columns reach zero and the worst case (1198) drops
    // clear of the 2400 cap. It also moves TOWARD the documented feel — see
    // Jar.step: "heavy dead-stop gems are the feel we want (restitution ~0)".
    //
    // THIS IS A LOAD-BEARING SIM CONSTANT: it changes where every body settles,
    // so every daily board, every career seed and every store frame move with
    // it. Changing it REQUIRES the full sweep cycle and a frame re-shoot.
    damping: 0.90,        // velocity keep when derived from displacement
    solverIters: 4,
    sleepMove2: 0.0025,   // (px/step)^2 net movement below which a body rests —
                          // velocity is NOISE in a stack (gravity in, impulse
                          // out every step); net position delta is the truth
    sleepSteps: 20,       // rest steps before sleep
    slop: 0.5,            // resting overlap the solver tolerates (anti-jitter)
    correction: 0.6,      // fraction of excess overlap corrected per iteration
    fillTarget: 0.70,     // pour until body area hits this fraction of jar area
    // POUR AT THE SAME MARK CAREER USES. This was 0.30 while every career level
    // pours at 0.45, and the career comment already gave the reason ("surface
    // starvation — pour sooner"). Free and daily have exactly the same problem
    // and were the modes left waiting. Measured on a live free jar: at 36
    // bodies the fill reads 0.40, so the old threshold could not fire, and that
    // jar had ONE legal tap in it — a rock. The drained middle of a shift is
    // where the game died, and 0.30 is what kept it there.
    // 0.68, not 0.66 — and CFG.junkRatio moves 0.30 -> 0.28 with it.
    //
    // CFG.damping moved 0.985 -> 0.90, every pile now settles differently, and
    // one of the next 120 shared daily boards went DEAD: day 20706 finished
    // 7/10 with 62% of its swings starved. A dead career level is one player's
    // retry; a dead DAILY is every player on earth getting an unwinnable jar on
    // the same day, with no reroll and no second seed.
    //
    // THE FIRST ATTEMPT WAS FITTED TO ITS OWN WINDOW. restockBelow 0.72 alone
    // cleared all 120 screened days — and screening 260 found a DIFFERENT dead
    // day (20903) further out. seedForDay runs forever, so a dial tuned until
    // one finite window is clean has only moved the failure past the edge of
    // the window. Re-searched over 260 days, both dials together:
    //
    //   junk  restock   clearable   DEAD
    //   0.26   0.66      253/260      0
    //   0.26   0.68      256/260      0
    //   0.28   0.66      253/260      2
    //   0.28   0.68      255/260      0     <- here
    //   0.30   0.66      247/260      3     <- was shipping
    //   0.30   0.68      255/260      1
    //   0.32   0.66      250/260      3
    //   0.32   0.68      252/260      2
    //
    // restock 0.68 beats 0.66 at every junk level, and 0.28 is the smallest
    // move off the shipped rock density that reaches zero. 0.26 scores one
    // better but thins the rock the dig is supposed to be about.
    //
    // CAREER IS UNAFFECTED by both: it overrides restockBelow with its own 0.45
    // and careerCfg computes its own per-level `junk` (0.26 + tier*0.016).
    restockBelow: 0.68,   // pour again when fill drains below this fraction
    pourMax: 200,         // hard cap of bodies per pour (safety)
    ordersPerShift: 10,   // complete this many orders -> epilogue payout
    swings: 55,           // pickaxe budget per shift — THE constraint that
                          // makes spam ruinous and planning the game (the
                          // verb probe always assumed this; now it ships;
                          // tuned by sweep: expert bot completes 84.5%)
    epilogueCoin: 5,      // leftover swings pay out (Sugar-Crush epilogue)
    bagCap: 7,            // satchel slots — the per-tap tension engine: spam
                          // jams the bag; assembly is why you READ the cards
    timedDur: 45,         // seconds a timed order stays on the line
    // FREE AND DAILY WERE TUNED HARDER THAN CAREER LEVEL 40. Swings-per-order
    // 5.50 vs the ladder's floor of 5.48, verbs at career mid-ladder rates, and
    // a restock threshold 0.15 lower than any level — on unscreened seeds,
    // where career's 40 are hand-picked (CAREER_REROLL). tools/screen_daily.cjs
    // put a number on the result: 13 of the next 120 SHARED daily boards went
    // dead, one of them leaving the expert bot 4 orders done with 26 swings it
    // had nothing legal to spend. These three dials, with the exposure cone
    // below, take that to zero.
    // UNDER A COVER RULE, ROCK IS A MANDATORY SWING, NOT A CHOICE.
    // The old 0.45 was tuned for the support rule, where a rock could be left
    // alone and the gem beside it taken instead. Digging downward you cannot
    // route around anything: every rock on the face has to come out before
    // what is under it exists. Measured over 300 free shifts at the new rule —
    // 0.45 -> 75.0% of shifts complete, 0.38 -> 84.0%, 0.32 -> 90.3%,
    // 0.30 -> 92.0% with zero dead daily boards, which is where it sits.
    // 0.26, paired with restockBelow 0.68 — searched TOGETHER, and the search
    // is the interesting part.
    //
    // CFG.damping 0.985 -> 0.90 moved every settled pile and pushed one of the
    // next 120 shared daily boards to DEAD. Three rounds of tuning followed,
    // and the first two were wrong in the same way:
    //   restock 0.72 alone   -> clean over 120, a DIFFERENT dead day at 260
    //   junk 0.28 / rb 0.68  -> clean over 260, a DIFFERENT dead day at 500
    // A dial tuned until one finite window is clean has only pushed the failure
    // past the edge of that window. seedForDay runs forever.
    //
    // Over 500 days (~16 months of the boards players will actually get):
    //   junk 0.26  restock 0.68   489/500 clearable   0 DEAD   <- here
    //   junk 0.27  restock 0.68   485/500             4 DEAD
    //   junk 0.28  restock 0.68   491/500             1 DEAD
    // The response is CHAOTIC, not smooth — 0.27 sits between two better
    // neighbours — so this is a sampled result, not a proof. RE-RUN
    // `node tools/screen_daily.cjs 500` before the coverage runs out, and treat
    // any change to damping, the exposure cone or the pour as invalidating it.
    //
    // A starvation rescue was tried instead of dials and made it worse; the
    // reason is recorded at the restock in update().
    junkRatio: 0.26,
    freeLode: 0.06,       // lodestone rate in FREE and DAILY jars
    // SHALE IS OFF IN FREE AND DAILY, BECAUSE ITS VERB CANNOT FIRE THERE.
    // The collapse gate is `fill() < CFG.fillTarget - 0.04` = 0.66; free and
    // daily restock at `restockBelow` 0.68; and the largest single body is
    // pi*29^2/JAR_AREA = 0.0172 of the jar. So one extraction floors fill at
    // 0.6628 > 0.66 and the slab cannot bring anything down: measured 194
    // shale digs across 400 shifts, 0 collapses, min observed fill 0.66295.
    // It was a sixth grey rock pretending to be a special. Career keeps it —
    // `cc.restockBelow` is 0.66, which is exactly the gate, so it fires there.
    // Do NOT "fix" this by lowering restockBelow: that dial pair was settled
    // by a 500-day search (see junkRatio) and 0.66 shipped 3 dead boards.
    freeShale: 0,         // shale rate in FREE and DAILY jars (see above)
    // THE PRISM WAS 7.5x OVERSUPPLIED AND ITS DECISION ALMOST NEVER FIRED.
    // Measured over 200 free shifts: 10.4% of gems poured, 1.4% demanded, and
    // because almost nothing consumed them they silted the working surface —
    // 18.6% of every gem the player could reach was one no card wanted. The
    // sell-vs-hoard prompt only fires when an ORDER wants the prism (see
    // _route), so DESIGN's "best decision in the game" was firing on 1.4% of
    // demand. Closed from both ends rather than one: supply 0.10 -> 0.07 and
    // the BIG card's prism roll 0.30 -> 0.60. Oversupply 7.5x -> 2.9x, surface
    // silt -> 11.6%, and the dilemma fires nearly twice as often. It stays
    // oversupplied ON PURPOSE — a prism is mostly dragon food, and the hoard
    // ladder is what it feeds.
    rareChance: 0.07,
    // What fraction of rock_l bodies are a GREAT GEM instead. 0.12 of rock_l
    // is 4.0% of rocks and 1.04% of all bodies: measured 1.27 seen and 0.54
    // dug per free shift, so roughly one great stone a shift is visible and
    // half of them are worth the slot. Raising this is safe for the pour (the
    // radius is held) but not for the economy — each one is three gems for one
    // swing, the best rate in the game alongside the crust.
    greatGem: 0.12,
  };
  var VIEW_H = 720;       // reference world height (world units)
  // Portrait zoom knob. scale = min(ch/VIEW_H, cw/VIEW_MIN_W): in portrait the
  // WIDTH term wins, so view.w collapses to exactly VIEW_MIN_W on every phone
  // and the world is identical for everyone. Portrait lock is load-bearing.
  var VIEW_MIN_W = 420;
  var JAR = { l: 38, r: 382, top: 196, bot: 642 };
  var ORDER_Y = 44, ORDER_H = 96, ORDER_W = 70;
  var BAG_Y = 148, BAG_SLOT = 28, BAG_GAP = 4;
  function bagSlotX(i) { return 100 + i * (BAG_SLOT + BAG_GAP); }
  // The bag slot is DRAWN 28 world units square, which is only ~25 CSS px on a
  // phone (scale ~0.89) — barely half Apple's 44pt minimum, and a missed drop
  // is silent. The HIT box is therefore padded well past the art: ~46x32 world
  // (~41x29 CSS). Bounded deliberately — the top edge clears the order cards
  // (they end at ORDER_Y + ORDER_H = 140) and the bottom clears the jar mouth
  // (JAR.top = 196), so widening it steals no tap from either neighbour.
  var BAG_HIT_TOP = BAG_Y - 6, BAG_HIT_BOT = BAG_Y + BAG_SLOT + 12;
  var PAY = { easy: 30, med: 60, big: 150, timed: 90 };
  var SLOT_CLS = ['easy', 'med', 'med', 'big', 'timed'];
  // THE BIG CARD ASKED FOR FIVE GEMS AND 68.5% OF THEM NEVER PAID.
  //
  // Measured over 250 free shifts: dealt 365, paid 115. A card that does not
  // pay is not merely a missed 150c — it holds one of the five order slots for
  // a mean of 18.7 swings, a third of the shift, doing nothing, and it is the
  // one card that cannot be abandoned cheaply because five of the satchel's
  // seven slots are already committed to it. Two slots of slack is not enough
  // room to dig anything else, so a BIG card in progress turns every other
  // card off.
  //
  // Four gems at the same 150c fixes the waste rather than the price: pay-rate
  // 31.5% -> 46.5%, slot held 18.7 -> 15.2 swings, and 467 dealt instead of
  // 365 because they now complete and refill. It stays the ambition card —
  // 9.9 c/swing-held, second only to RUSH's 11.5 — without switching the other
  // four cards off while it is on the line.
  var SLOT_N = { easy: 2, med: 3, big: 4, timed: 3 };

  // THE DAILY'S CHARACTER. Free and Daily were the same shift with different
  // seeds and banking rules — and the DAILY, the one mode everybody plays on
  // the same jar, was the LESS varied of the two, because free at least rolls
  // a new jar every time. This gives the shared day a shape of its own without
  // touching the jar, the swing budget, or lane-1 body generation: only WHICH
  // CARD CLASS hangs in each of the five slots, which orderSpec already takes
  // as `clsOverride`.
  //
  // A pure function of the UTC day number, so every player on every device
  // gets the same board on the same day — the same guarantee dailySeed()
  // makes, derived the same way, consuming no RNG lane at all.
  //
  // Free mode deliberately keeps the standard vector: it is the earning and
  // practice mode and its economy is what tools/sweep_difficulty.cjs gates.
  var DAILY_CHARACTERS = [
    { id: 'standard', name: 'a steady day',    cls: ['easy', 'med', 'med', 'big', 'timed'] },
    { id: 'rush',     name: 'RUSH DAY',        cls: ['easy', 'med', 'timed', 'big', 'timed'] },
    { id: 'haul',     name: 'BIG HAUL',        cls: ['easy', 'med', 'big', 'big', 'timed'] },
    { id: 'steady',   name: 'STEADY HANDS',    cls: ['easy', 'med', 'med', 'med', 'timed'] },
    { id: 'scatter',  name: 'SMALL ORDERS',    cls: ['easy', 'easy', 'med', 'big', 'timed'] },
  ];
  function dailyCharacter(day) {
    return DAILY_CHARACTERS[((day % DAILY_CHARACTERS.length) + DAILY_CHARACTERS.length)
                            % DAILY_CHARACTERS.length];
  }

  // ===== RNG FIREWALL (§3a) — THREE LANES ==================================
  // Keep them separate or a shared seed forks silently, for only some players.
  //
  //  LANE 1  noise*()      POSITIONAL hash. Stateless, order-independent,
  //                        random-access, integer-exact on every device. THE
  //                        gameplay-world lane: jar body i / order refill k is
  //                        identical no matter how many frames ran or in what
  //                        order players completed things.
  //  LANE 2  rng*()        seeded mulberry32 STREAM. Sequential. ONLY for a
  //                        bounded, order-fixed set of per-run rolls (drawn at
  //                        reset, never per frame).
  //  LANE 3  Math.random   COSMETIC lane (particles, shake, flavour). Never
  //                        touches world layout. Two players SHOULD differ.
  //
  // The audit question: could two players hit this line a DIFFERENT NUMBER of
  // times, or in a different frame order? If yes, lanes 1/2 are off-limits.
  // Order REFILLS are exactly that case — a player-paced event — so refill
  // content comes from lane-1 (slot, refillIndex) positional draws, never the
  // stream. (See seeded-rng-audit.)

  // --- LANE 1: SquirrelNoise3 (Squirrel Eiserloh). uint32 out. ---
  function squirrel3(pos, seed) {
    var m = pos | 0;
    m = Math.imul(m, 0x68E31DA4);
    m = (m + (seed | 0)) | 0;
    m ^= m >>> 8;
    m = (m + 0xB5297A4D) | 0;
    m ^= m << 8;
    m = Math.imul(m, 0x1B56C4E9);
    m ^= m >>> 8;
    return m >>> 0;
  }
  function noise01(i, seed) { return squirrel3(i | 0, seed >>> 0) / 4294967296; }
  function noise2(x, y, seed) {
    return squirrel3((x | 0) + Math.imul(y | 0, 198491317), seed >>> 0) / 4294967296;
  }

  // --- LANE 2: mulberry32 stream (bounded per-run rolls ONLY) ---
  var _stream = 1;
  function seedStream(s) { _stream = (s | 0) || 1; }
  function streamFloat() {
    _stream = (_stream + 0x6D2B79F5) | 0;
    var z = Math.imul(_stream ^ (_stream >>> 15), 1 | _stream);
    z = (z + Math.imul(z ^ (z >>> 7), 61 | z)) ^ z;
    return ((z ^ (z >>> 14)) >>> 0) / 4294967296;
  }
  function rngRange(a, b) { return a + streamFloat() * (b - a); }
  function rngInt(a, b) { return Math.floor(rngRange(a, b + 1)); }

  // Daily seed: same integer for everyone on the same UTC day.
  function dayNumber() { return Math.floor(Date.now() / 86400000); }
  // dailySeed generalised to ANY day — the whole archive rests on this being
  // the same arithmetic, so a past day rebuilds byte-identically.
  function seedForDay(d) { return ((d + 1) * 2654435761) >>> 0 || 1; }
  function dailySeed() { return seedForDay(dayNumber()); }

  // ===== GEM / ROCK tables =================================================
  // Grey-box palette; the art pass replaces draws, NEVER these keys. Radii are
  // gameplay (collision + exposure) — sprite metrics must match them later.
  var GEMS = [
    { k: 'ruby',     col: '#d94560', hi: '#ff9db1', r: 17 },
    { k: 'emerald',  col: '#2fae62', hi: '#9fe8bf', r: 19 },
    { k: 'sapphire', col: '#3f6fd8', hi: '#a5bef5', r: 21 },
    { k: 'amber',    col: '#e8a53c', hi: '#ffdf9a', r: 15 },
    { k: 'prism',    col: '#b56fe0', hi: '#f2d7ff', r: 22, rare: true },
  ];
  var HEART = { k: 'heartstone', col: '#c9a0f0', hi: '#ffffff', r: 56 };
  // A great gem's radius. It MUST stay equal to rock_l's — it is the radius
  // the area-budgeted pour already spent on the body being replaced, and the
  // moment it differs every seed in the game repours.
  var GREAT_R = 29;
  // How many cut gems a great stone breaks into. Same shape as the crusted
  // rock's payout — one swing, several gems, several satchel slots — but this
  // one you can SEE coming, which is the difference between a surprise and a
  // decision.
  var GREAT_YIELD = 3;
  // Crust rate and payload BY ROCK SIZE. The rates average to the flat 0.13
  // they replace (ROCKS is picked uniformly), so this redistributes the crust
  // budget toward the big rocks rather than adding to it.
  var CRUST_RATE  = { rock_s: 0.06, rock_m: 0.13, rock_l: 0.20 };
  var CRUST_YIELD = { rock_s: 1,    rock_m: 2,    rock_l: 3    };
  // What the colossus pays. See the note at the sell/hoard resolution: it
  // costs ~46 of 55 swings to reach, so these are priced against most of a
  // shift, not against a single dig.
  var HEART_GIFT = 12;                 // hoard — most of a rank step (15)
  var HEART_SELL = 600;                // coins — a shift's whole take again
  // How long the hover-choice stands before it resolves itself. ONE number for
  // both rares: the prism ran 4.5s and the colossus 4.0s, and the draw repeated
  // both as literals to size its countdown arc, so the clock on screen and the
  // clock being counted were two facts that had to agree by hand.
  //
  // 6.0 because 4.5 was measured to be too short by the player it was raised
  // for: read two plates, work out which future you want, and reach one, on a
  // phone, with a pile still settling behind them. It resolves FOR you when it
  // lapses, so a clock that outruns the reading does not look broken — it just
  // never obeys, which is exactly how this survived twice.
  var CHOICE_SECS = 6.0;

  // THE DRAGON'S OWN SIZE, from the hoard alone. _drawHoardLedge clamps this by
  // the counter's height, which is DEVICE-derived; the clamp only ever makes
  // him SMALLER, so a tap region sized on the unclamped value contains him on
  // every phone without update() ever reading the phone (the floorY law,
  // HANDOFF §3e2).
  function hoardDragonSize(total) {
    return 74 + Math.sqrt(Math.max(0, total || 0)) * 3.2;
  }
  // ...and the half-plane that answers for a tap on him during the dilemma.
  //
  // It was the flat literal `x < 120`, authored when the dragon stopped growing
  // at hoard 24 (74 + a clamped sprinkle ≈ 90 wide). "THE DRAGON KEEPS GROWING"
  // then removed that ceiling and nothing widened the target with him. Measured
  // through the shipped pointer path at 430x932: he draws x 10..133 at hoard
  // 231, 10..150 at hoard 423, 10..176 at hoard 900. So at Vanus's own hoard of
  // 423 the right FIFTH of the dragon was a DEAD TAP during the one moment in
  // the game that asks you to tap him — a second, independent cause of "when
  // you try to hoard, it doesn't actually go to the dragon below".
  //
  // +60 takes in the ×N tally chip, which is drawn beside him and rides with
  // him, and is just as much "the hoard" to a thumb. Capped at 240 so that a
  // hoard in the thousands can never creep into the gear at c.r-60 (>=360).
  function hoardTapRight() {
    return Math.min(240, Math.max(120, 10 + hoardDragonSize(Meta.data.hoardTotal) + 60));
  }
  var ROCKS = [
    { k: 'rock_s', col: '#8d8578', hi: '#b5ac9d', r: 16 },
    { k: 'rock_m', col: '#83796c', hi: '#a89e8f', r: 22 },
    { k: 'rock_l', col: '#776e62', hi: '#9c9284', r: 29 },
  ];
  var TYPE = {};
  GEMS.concat(ROCKS).concat([HEART]).forEach(function (t) { TYPE[t.k] = t; });
  var ORDER_POOL = ['ruby', 'emerald', 'sapphire', 'amber'];

  // ===== WORLD sampling — PURE functions of (index, seed) ==================
  // Lane 1 all the way down: any order, any device, same answer. Seeds are
  // XOR-salted per feature so features don't correlate.
  // `lode` and `shale` are the L16+/L24+ verbs. They ride as FLAGS on rocks
  // that were already going to be poured, never as new body types: the pour is
  // area-budgeted against fill(), so a new radius terminates the fill loop at a
  // different body count and repours every seed in the game. Each rolls on its
  // own (y-index, seed-salt) pair — indices 1,2,3,4,5,6,8,9,10 were taken, so
  // 11 and 12 are fresh — and because every feature is salted independently,
  // adding them provably does not perturb key/r/x/y/geode. A level with both
  // turned off pours byte-identically to before they existed, which is what
  // keeps the 40 screened CAREER_REROLL seeds valid for levels 1-15.
  function jarBodySpec(i, batch, seed, junk, rare, lode, shale) {
    if (junk === undefined) junk = CFG.junkRatio;
    if (rare === undefined) rare = CFG.rareChance;
    if (lode === undefined) lode = 0;
    if (shale === undefined) shale = 0;
    var p = i + Math.imul(batch, 100003);
    var u = noise2(p, 1, (seed ^ 0x0B0D1) >>> 0);
    var t;
    if (u < junk) {
      t = ROCKS[Math.floor(noise2(p, 2, (seed ^ 0x0B0D2) >>> 0) * ROCKS.length)];
    } else if (noise2(p, 3, (seed ^ 0x0B0D3) >>> 0) < rare) {
      t = TYPE.prism;
    } else {
      t = TYPE[ORDER_POOL[Math.floor(noise2(p, 4, (seed ^ 0x0B0D4) >>> 0) * ORDER_POOL.length)]];
    }
    // THE GREAT GEM — the answer to "what happened to the bigger gems".
    //
    // Every gem you can be asked for is r15-21 and every rock is r16-29, so
    // the physically largest object in the jar has always been a ROCK, and all
    // three specials the game ever shipped (crust, lodestone, shale) ride on
    // rocks. There was no big-gem tier at all; there was one r56 colossus and
    // nothing between it and a 21px sapphire.
    //
    // A new radius is what made that expensive: `pour()` breaks on
    // `fill() >= targetFill` and `fill()` sums pi*r^2, so any r outside
    // {15,16,17,19,21,22,29,56} terminates the pour at a different index and
    // repours every seed in the game — 40 CAREER_REROLL entries invalid, a
    // 500-day daily re-screen, every store frame re-shot. That cost is why the
    // cheap slot was rock-shaped, and it is why the content went there.
    //
    // So this takes a body that is ALREADY r29 and swaps its KEY. A great gem
    // is a rock_l-sized gem: `r` is held at 29, the pour is byte-identical, and
    // the whole class of cost above is simply not paid. Nothing in the Jar
    // prototype reads `.key` — physics, fill(), pour(), _solvePair, exposed()
    // and blockersOf() all read `r` — so a settled pile is unchanged.
    //
    // It ties rock_l at 59.7px of ink; it does not beat it. Only the colossus
    // (115px) is bigger. Do not claim otherwise in a caption.
    var great = t.k === 'rock_l' &&
                noise2(p, 13, (seed ^ 0x0B0DD) >>> 0) < CFG.greatGem;
    if (great) {
      // Weighted, so the four order gems stop being interchangeable: a great
      // stone is usually a sapphire and almost never an amber. This is the
      // first thing in the game that distinguishes them at all.
      var gu = noise2(p, 15, (seed ^ 0x0B0DF) >>> 0);
      t = TYPE[gu < 0.45 ? 'sapphire' : gu < 0.75 ? 'emerald'
             : gu < 0.95 ? 'ruby' : 'amber'];
    }
    // A CRUST IS WORTH WHAT THE ROCK IS BIG.
    //
    // This was a flat 0.13 on every rock with a flat payload of two, so a
    // pebble and a boulder were the same lottery ticket and nothing about the
    // picture told you which rock to crack. Splitting it by size gives the
    // biggest rocks a reason to be tapped and pairs with the great gem: the
    // r29 class goes from ~13% reward to ~30%.
    //
    // The rates are the SAME DRAW re-thresholded, not a new one, and `ROCKS`
    // is picked uniformly, so (0.06 + 0.13 + 0.20) / 3 = 0.1300 — the mean
    // crust rate is conserved exactly and redistributed by size rather than
    // inflated. (rock_l loses a little to the great-gem roll above it, which
    // is why the measured mean lands a shade under 0.13.)
    var geode = !great && t.k.indexOf('rock') === 0 &&
                noise2(p, 8, (seed ^ 0x0B0D8) >>> 0) < CRUST_RATE[t.k];
    // spawn stagger above the jar: pure fn, so a pour is replayable
    var lane = Math.floor(noise2(p, 5, (seed ^ 0x0B0D5) >>> 0) * 8);
    var sx = JAR.l + 30 + lane * ((JAR.r - JAR.l - 60) / 7)
           + (noise2(p, 6, (seed ^ 0x0B0D6) >>> 0) - 0.5) * 18;
    var sy = JAR.top - 40 - Math.floor(i / 8) * 64 - (i % 8) * 7;
    var inner = null;
    if (geode) {
      // ...and it holds as many gems as the rock is big: 1 / 2 / 3. The third
      // gem needs a fresh index — 9 and 10 are the existing two, and 1-13,15
      // are taken, so 17 is the next free (y, salt) pair.
      inner = [
        ORDER_POOL[Math.floor(noise2(p, 9, (seed ^ 0x0B0D9) >>> 0) * ORDER_POOL.length)],
      ];
      if (CRUST_YIELD[t.k] > 1) inner.push(
        ORDER_POOL[Math.floor(noise2(p, 10, (seed ^ 0x0B0DA) >>> 0) * ORDER_POOL.length)]);
      if (CRUST_YIELD[t.k] > 2) inner.push(
        ORDER_POOL[Math.floor(noise2(p, 17, (seed ^ 0x0B0E1) >>> 0) * ORDER_POOL.length)]);
    }
    // A rock is at most ONE special. Order matters and is fixed: geode wins,
    // then lode, then shale — otherwise a rock could be a crusted lodestone
    // and the tells would have to composite.
    var isRock = !great && t.k.indexOf('rock') === 0;
    var lodeF = isRock && !geode && lode > 0 &&
                noise2(p, 11, (seed ^ 0x0B0DB) >>> 0) < lode;
    var shaleF = isRock && !geode && !lodeF && shale > 0 &&
                 noise2(p, 12, (seed ^ 0x0B0DC) >>> 0) < shale;
    // `r` is GREAT_R, not t.r — that is the whole trick. Holding the radius
    // at the rock_l value the pour already budgeted is what keeps this free.
    return { key: t.k, r: great ? GREAT_R : t.r, x: sx, y: sy, geode: inner,
             lode: lodeF, shale: shaleF, great: great };
  }
  // Order refill k of slot s. POSITIONAL on (slot, k): players who complete
  // orders in different sequences still see identical refill content.
  function orderSpec(slot, k, seed, clsOverride, noPrism) {
    var cls = clsOverride || SLOT_CLS[slot];
    var n = SLOT_N[cls === 'timed' ? 'timed' : cls];
    var need = {};
    var base = Math.imul(slot, 7919) + Math.imul(k, 104729);
    for (var j = 0; j < n; j++) {
      var pool = ORDER_POOL;
      if (!noPrism && cls === 'big' && j === 0 && noise2(base, 90 + j, (seed ^ 0x0AD51) >>> 0) < 0.60) {
        pool = ['prism'];
      }
      var g = pool[Math.floor(noise2(base, 10 + j, (seed ^ 0x0AD52) >>> 0) * pool.length)];
      need[g] = (need[g] || 0) + 1;
    }
    return { cls: cls, need: need, pay: PAY[cls] };
  }

  // Career level N — a PURE function of the level number, so every player
  // digs the identical shaft (shareable, and the ladder is sweepable).
  // Shape: 5-level bands; slot 3 of each band spikes, slot 4 breathes
  // (the genre's sawtooth). RUSH orders unlock at 3, prisms at 5.
  // Seeds are SCREENED: an expert bot must clear every level's fixed jar
  // with 6-28 swings to spare, or the seed rerolls (tools/ladder docs).
  // The table is data — identical for every player, like a designed level.
  // 37: 2 was added when the support-audit/wake-cascade physics fix landed —
  // settling changed, and L37's old seed stalled at 10/11 orders. Screened
  // 1/2/3/4: reroll 1 clears with 37 swings to spare (above the whole ladder's
  // max margin of 31 — that level would play as a freebie), 3 fails outright,
  // 2 lands at 21, nearest the ladder's p50 of 23.
  //
  // 38: 1 was added when delivery started choosing the best-paying card.
  // Career counts ORDERS, not coins, and serving the big card churns the slow
  // slot — L38's margin fell to 2 swings. Screened 1/2/3/4/5 (margins
  // 9/6/33/26/19); 1 keeps a level-38-of-40 genuinely tight without the gate
  // sitting on the edge. ANY physics or routing change can invalidate these
  // seeds; re-run tools/sweep_career.cjs.
  // RE-SCREENED after the swings-per-order squeeze landed (tier 0 6.60 ->
  // tier 7 5.48). The old table was screened against a flat curve, so the
  // levels it had rescued were rescued against a budget that no longer
  // exists: 28 and 38 became unclearable and 31 fell to a 2-swing margin.
  // Re-screened with tools/screen_reroll.cjs, which targets a margin that
  // FALLS with the level rather than one flat number —
  //   28: 2 -> 0 (margin 21, target 17)
  //   31: 2 -> 4 (margin 16, target 15)
  //   38: 1 -> 0 (margin 11, target 13)
  // Then re-screened again against the new FREEBIE report — a level the expert
  // bot finishes 30+ swings early is a corridor, not a level, and six of them
  // were hiding inside a healthy-looking p50:
  //   5: 1 -> 5 (was +35),  10: 0 -> 6 (was +36),  12: 0 -> 1 (was +37),
  //   22: 1 -> 4 (was +36), 30: 0 -> 6 (was +35).
  // L1 is left generous ON PURPOSE: it is the level the coach runs on.
  // And once more when career orders were allowed to ask for a prism: L8's
  // fixed jar could no longer cover its own card (8/9). 8: 0 -> 3 (margin 25).
  // And again for the L16+ lodestone and L24+ shale: four levels past the
  // lodestone gate could no longer be cleared with the seeds that were
  // screened before blockers existed (17, 28, 37, 38), and 26 fell to +0.
  // Levels 1-15 are untouched — they pour byte-identically to before the
  // verbs, because both roll on their own salted noise index and both rates
  // are 0 below their gate.
  //   17: 2->7 (21)   26: 0->1 (15)   28: 0->2 (15)
  //   37: 2->5 (12)   38: 0->6 (12)
  // FINALLY, screened for SHAPE rather than only for clearable. The gate now
  // reports each level's margin against the intended curve, and eight levels
  // were more than 10 swings off it: L23/L24 were a wall in the middle (6 and
  // 3 swings of slack against a target of 18) while L35, L39 and L40 were
  // freebies at the end — the FINALE cleared with 27 spare against a target
  // of 13, so the ladder's hardest stretch sat at level 24 and the last level
  // played as relief.
  //   16: 0->3 (20)  21: 0->6 (19)  23: 0->5 (18)  24: 0->2 (17)
  //   32: 3->2 (16)  35: 0->4 (14)  39: 1->2 (14)  40: 0->1 (18)
  // RE-SCREENED AT THE DESIGN'S OWN PACE. Every prior pass screened this table
  // at SEC_PER_SWING 0.375 — the sim's settle time mistaken for a human
  // cadence — at which a 45s RUSH card can never expire, so the game's only
  // real-time pressure was switched OFF for the whole run. At the 2.5s/swing
  // implied by DESIGN.md metric 6 the ladder FAILED its own gate: L27 cleared
  // with 0 swings to spare and L32 with 2.
  //   27: 0->2 (16)  32: 2->4 (13)  24: 2->7 (22)  35: 4->5 (16)  29: 1->7 (25)
  // RE-SCREENED after the career gate learned the lodestone's two-swing rule.
  // sweep_career.cjs had no `pick.lode` branch at all — screen_daily.cjs and
  // sweep_difficulty.cjs both mirror it, the CAREER gate did not — so every
  // level from 16 up (careerCfg pours lodestones at 0.30 on L16 and 0.14 from
  // L19) was certified against a bot paying ONE swing per lodestone where the
  // player pays two. With the rule mirrored, L19 fell to a margin of 4 and L32
  // to 2, both under the floor of 6. L28 (7) was screened in the same pass.
  //   19: 0 -> 8   margin  4 -> 19  (target 20)
  //   32: 6 -> 4   margin  2 -> 15  (target 15)
  //   28: 6 -> 5   margin  7 -> 17  (target 17)
  // ...and four levels that had drifted the OTHER way, off the curve as
  // freebies. The gate does not fail on those — it only reports them — but a
  // level clearing 13 swings above its own target is a level that teaches
  // nothing, and every spare swing is 5c of epilogue paid into a shop sink the
  // gate below has to keep honest.
  //    5: 5 -> 0   margin 38 -> 26  (target 26)
  //    6: 1 -> 9   margin 35 -> 22  (target 24)
  //   15: 1 -> 8   margin 33 -> 27  (target 22)
  //   18: 0 -> 1   margin 33 -> 20  (target 20)
  // RE-SCREENED AGAIN after CFG.damping moved 0.985 -> 0.90. Damping decides
  // where every body comes to rest, so every one of the forty fixed seeds
  // settles into a different jar — L32 and L34 became unclearable outright and
  // eight more drifted off their curve target. This is the cycle that constant
  // demands; it is not optional.
  //   32: 4 -> 7  (uncleared -> 16)      34: 2 -> 4  (uncleared -> 18)
  //   26: 1 -> 6  (6  -> 17)             39: 6 -> 0  (3  -> 11)
  //   21: 5 -> 6  (9  -> 15)             24: 7 -> 3  (10 -> 16)
  //   36: 0 -> 2  (5  -> 11)             8:  3 -> 7  (33 -> 25)
  //    9: 1 -> 5  (32 -> 23)             10: 6 -> 8  (33 -> 24)
  var CAREER_REROLL = { 5: 0, 6: 9, 7: 1, 8: 7, 9: 5, 10: 8, 11: 1, 12: 1,
                        14: 3, 15: 8, 16: 3, 17: 7, 18: 1, 19: 8, 20: 4, 21: 6, 22: 2,
                        23: 5, 24: 3, 25: 0, 26: 6, 27: 1, 28: 5, 29: 8,
                        30: 6, 31: 6, 32: 7, 34: 4, 35: 5, 36: 2, 37: 8,
                        38: 4, 39: 0, 40: 6 };
  // The ladder ends where the SCREENING ends. careerCfg(n) happily returns a
  // config for any n, but past the screened range the swing budget decays
  // (-tier*0.5 forever) while orders cap at 12, so swings-per-order falls
  // through the floor and levels become unclearable — measured 76% clear at
  // L41-120, 13% at L300-330. A retry re-runs the identical impossible seed.
  // Extending this number REQUIRES re-screening with tools/sweep_career.cjs.
  var CAREER_MAX = 40;
  function careerCfg(n) {
    var tier = Math.floor((n - 1) / 5);
    var inBand = (n - 1) % 5;
    // ORDERS reach the authored 12 exactly at L40 (tier 7). The old
    // `8 + floor(tier/2)` topped out at 11 and the `min(12, ...)` clamp was
    // dead code inside the shipped range — the ladder never reached the top of
    // its own envelope.
    var orders = Math.min(12, 8 + Math.round(tier * 4 / 7));
    var rr = CAREER_REROLL[n] || 0;
    // THE SQUEEZE. Swings used to be `orders * 6.4 - tier*0.5`, which scales
    // the budget WITH the length, so swings-per-order stayed in a 5.91..7.13
    // band across all 40 levels — a late level was LONGER, not harder.
    // Measured with the curve report below, the back 10 levels cleared with
    // MORE room than the front 10 (mean margin 26.6 vs 24.2, squeeze -2.4),
    // and L31-35 was the easiest band in the game. That is what "it gets
    // boring after a certain level" is: the ladder stops asking for anything.
    //
    // Now the RATE tightens with tier — 6.60 swings/order at L1 down to 5.48
    // at L40 — so a late level is both longer and meaner. Re-screening is
    // mandatory after any change to this line (tools/sweep_career.cjs).
    var perOrder = 7.00 - tier * 0.32;

    // TEACH, THEN TEST. A verb's debut level introduces THAT VERB AND NOTHING
    // ELSE — the ritual the genre runs on, and one this ladder was only
    // claiming to follow. L16 previously turned the lodestone on while
    // simultaneously moving orders 9->10, swings 63->61, junk 0.428->0.452 and
    // dropping the heartstone, so four things changed at once and the new one
    // was the least visible of them. L24 was worse: shale debuted on the
    // band's SPIKE slot, at the highest junk so far, alongside four lodestones
    // and seven crusted rocks.
    //
    // On an intro level the dials HOLD at the previous level's values, the
    // other special is suppressed, and the debuting verb pours at roughly
    // double rate so the player actually meets it. The tier squeeze resumes
    // the level after.
    var intro = n === 16 ? 'lode' : n === 24 ? 'shale' : null;
    if (intro) {
      var prev = careerCfg(n - 1);
      return {
        level: n,
        seed: (squirrel3(n, (0xCAFE01 + Math.imul(rr, 0x9E3779B9)) | 0) >>> 0) || 1,
        restockBelow: 0.66,
        orders: prev.orders,          // hold every dial at the previous level
        swings: prev.swings,
        junk: prev.junk,
        rare: prev.rare,
        timed: prev.timed,
        heart: false,                 // nothing else new competes for attention
        lode: intro === 'lode' ? 0.30 : 0,
        shale: intro === 'shale' ? 0.26 : 0,
        intro: intro,
      };
    }

    return {
      level: n,
      seed: (squirrel3(n, (0xCAFE01 + Math.imul(rr, 0x9E3779B9)) | 0) >>> 0) || 1,
      restockBelow: 0.66,   // the dig face: keep the surface fed as it recedes
                            // sooner (batch content is identical for everyone)
      orders: orders,
      swings: Math.max(46, Math.round(orders * perOrder
              + (inBand === 3 ? -2 : 0) + (inBand === 4 ? 6 : 0))),
      junk: Math.min(0.44, 0.26 + tier * 0.016 + (inBand === 3 ? 0.04 : 0)),
      rare: n >= 5 ? CFG.rareChance : 0,
      timed: n >= 3,
      heart: n % 5 === 0,             // every band finale hides a colossus
      // THE NEW VERBS. Introduced on their own level and then reused, the way
      // the genre teaches: L16 is the lodestone's tutorial and L24 the
      // shale's. Levels below each gate pour byte-identically to before the
      // verb existed, so the screened seeds for L1-15 are untouched.
      lode: n >= 16 ? 0.14 : 0,
      shale: n >= 24 ? 0.12 : 0,
    };
  }

  // May a CAREER order ask for a prism?
  //
  // It never could: _makeOrder passed `noPrism = !!this.career`, so in 40
  // levels no career card ever wanted one. That made L5's "prisms enter the
  // pool" an introduction of nothing — the sell-vs-hoard prompt only fires
  // when an order actually wants the rare (see _route), so in career every
  // prism fell straight to the dragon with no decision at all. The game's best
  // moment was unreachable in its main mode except via the heartstone, eight
  // times in forty levels.
  //
  // The reason for the blanket ban was real: a career seed is FIXED, so a jar
  // that happens to contain one prism can strand a card that demands one. So
  // the ban becomes conditional on the jar rather than on the mode — count the
  // prisms this level actually pours and require a surplus, so the player can
  // feed one to the dragon and still fill the card. Levels 1-4 have `rare = 0`
  // and answer false here for free.
  //
  // PURE and memoised per level: careerCfg(n) is a pure function of n and the
  // Jar constructor only pours (settling happens later in start()), so this is
  // the same answer for every player on every device — which is what lets the
  // screening sweep share the rule instead of mirroring it.
  // Memoised on the SEED, not the level. Keying by level looks equivalent —
  // careerCfg(n) is pure, so a level has one seed — but tools/screen_reroll.cjs
  // exists precisely to try DIFFERENT seeds under a fixed level number, and a
  // level-keyed cache hands it the previous candidate's answer. That silently
  // screened L39 to a reroll the gate then failed, because the screener and
  // the gate disagreed about whether that jar could carry a prism order.
  var _prismOk = {};
  function careerPrismOk(cfg) {
    if (!cfg) return false;
    var k = cfg.seed >>> 0;
    if (_prismOk[k] !== undefined) return _prismOk[k];
    var j = new Jar(cfg.seed, cfg.junk, cfg.rare, cfg.heart), n = 0;
    for (var i = 0; i < j.bodies.length; i++) if (j.bodies[i].key === 'prism') n++;
    return (_prismOk[k] = n >= 3);
  }

  // ===== Jar — the DOM-free deterministic sim ==============================
  // Circle dynamics, fixed step, index-ordered solver: no Math.random, no
  // transcendentals (sqrt only), no window/ctx — node can run it verbatim,
  // which is how tools/prove-determinism.js proves the pile can't fork.
  var JAR_AREA = (JAR.r - JAR.l) * (JAR.bot - JAR.top);

  function Jar(seed, junk, rare, heart, lode, shale) {
    this.seed = seed >>> 0;
    this.junk = junk === undefined ? CFG.junkRatio : junk;
    this.rare = rare === undefined ? CFG.rareChance : rare;
    this.lode = lode || 0;              // L16+ verb rate; 0 pours as before
    this.shale = shale || 0;            // L24+ verb rate; 0 pours as before
    this.bodies = [];
    this.nextId = 1;
    this.batches = 0;
    if (heart) {
      // THE COLOSSUS FALLS WITH THE POUR, NOT AHEAD OF IT.
      //
      // This spawned at `JAR.top - 60`, which is pour index 3's spawn height
      // (`JAR.top - 40 - floor(i/8)*64 - (i%8)*7`, jarBodySpec). The headline
      // object was therefore the third thing into the jar and every one of the
      // other ~81 bodies landed on top of it. Under the top-down cover rule
      // that is not "deep", it is SEALED: measured over 120 heart jars it sat
      // under 23.5 bodies (p90 27), and the restock refills the jar as fast as
      // you dig, so the cover set is a FIXED POINT, not a cost. A bot that
      // spent every one of its 55 swings on nothing but the colossus's own
      // column moved it 25 -> 21 and left the jar exactly as full as it found
      // it. Across every probe and sweep in this repo the Heartstone had been
      // extracted ZERO times, ever, while the game painted it 99% un-occluded
      // and told the player "23 rocks still pin the Heartstone" — a true and
      // actionable-sounding instruction for an impossible task.
      //
      // -488 is pour index 56's spawn height (40 + floor(56/8)*64), so the
      // colossus arrives in the rain when body 56 does and lands INSIDE the
      // pile instead of under it. Blockers 23.5 -> 5.7 (p90 8, max 11).
      //
      // THIS DOES NOT REPOUR ANYTHING. `fill()` sums pi*r^2 and never reads y,
      // and the colossus is pushed before `pour()`, so its area is already in
      // the budget at any spawn height: `pour()` breaks at the identical index
      // with an identical (key, r, x, y) list. Verified at dy 60/424/488/552 —
      // 81.35 bodies/jar and the same pour hash at all four. Only the SETTLE
      // of a heart-bearing jar changes, so the gates re-run; they do not
      // re-screen, and no CAREER_REROLL entry moves.
      //
      // Do not push it further. At -552 the colossus is already exposed at
      // t=0 on 3 of 72 jars — a free 600c on the first tap.
      var hx = JAR.l + 60 + noise01(7, (this.seed ^ 0x4EA47) >>> 0) * (JAR.r - JAR.l - 120);
      this.bodies.push({
        id: this.nextId++, key: 'heartstone', r: HEART.r,
        x: hx, y: JAR.top - 488, px: hx, py: JAR.top - 488, vx: 0, vy: 0,
        rest: 0, asleep: false, pry: 0,
      });
    }
    this.pour(CFG.fillTarget);
  }

  Jar.prototype.fill = function () {
    var a = 0;
    for (var i = 0; i < this.bodies.length; i++) {
      var r = this.bodies[i].r;
      a += 3.14159265 * r * r;
    }
    return a / JAR_AREA;
  };

  // Area-budgeted pour: circles pack to ~90% at BEST — pouring more area than
  // the jar holds makes the solver boil forever. Deterministic: the stop point
  // is a pure function of the specs (same for every player).
  Jar.prototype.pour = function (targetFill) {
    var b = this.batches++;
    for (var i = 0; i < CFG.pourMax; i++) {
      if (this.fill() >= targetFill) break;
      var s = jarBodySpec(i, b, this.seed, this.junk, this.rare,
                          this.lode, this.shale);
      this.bodies.push({
        id: this.nextId++, key: s.key, r: s.r, geode: s.geode || null,
        lode: !!s.lode, shale: !!s.shale, great: !!s.great,
        // WHERE THIS BODY WAS POURED FROM — the one pair of numbers that names
        // a body identically for every player on a shared seed. `id` is a
        // creation counter and is NOT that (see the shale collapse). Nothing
        // in the sim or in stateHash reads these; they exist so a rule that
        // must be positional has a positional key available.
        pb: b, pi: i,
        x: s.x, y: s.y, px: s.x, py: s.y, vx: 0, vy: 0,
        rest: 0, asleep: false,
      });
    }
  };

  // Position-based dynamics: integrate, solve POSITIONS, then derive velocity
  // from actual displacement. An impulse solver here left bodies pinned by the
  // solver while carrying huge phantom velocities (gravity in, impulse out,
  // position frozen) — which blocked sleep forever. Deriving v from what
  // actually MOVED makes phantom momentum structurally impossible, and heavy
  // dead-stop gems are the feel we want (restitution ~0).
  Jar.prototype.step = function (STEP) {
    var bs = this.bodies, n = bs.length, i, j, b;
    for (i = 0; i < n; i++) {
      b = bs[i];
      b.px = b.x; b.py = b.y;
      if (b.asleep) continue;
      b.vy += CFG.gravity * STEP;
      b.x += b.vx * STEP; b.y += b.vy * STEP;
    }
    // candidate pairs once per step (cheap reject), solved iteratively
    var pairs = [];
    for (i = 0; i < n; i++) {
      var bi = bs[i];
      for (j = i + 1; j < n; j++) {
        var bj = bs[j];
        var rr2 = bi.r + bj.r + 2;
        if (bj.x - bi.x > rr2 || bi.x - bj.x > rr2) continue;
        if (bj.y - bi.y > rr2 || bi.y - bj.y > rr2) continue;
        pairs.push(i, j);
      }
    }
    for (var it = 0; it < CFG.solverIters; it++) {
      for (var p = 0; p < pairs.length; p += 2) {
        this._solvePair(bs[pairs[p]], bs[pairs[p + 1]]);
      }
      for (i = 0; i < n; i++) {
        b = bs[i];
        if (b.asleep) continue;
        if (b.x - b.r < JAR.l) b.x = JAR.l + b.r;
        if (b.x + b.r > JAR.r) b.x = JAR.r - b.r;
        if (b.y + b.r > JAR.bot) b.y = JAR.bot - b.r;
      }
    }
    // wake pass: a sleeper wakes only when a body with real NET movement this
    // step presses into it. Deciding this after the solver (not inside it)
    // keeps mid-iteration transients from resetting rest counters forever.
    for (var p2 = 0; p2 < pairs.length; p2 += 2) {
      var ba = bs[pairs[p2]], bb = bs[pairs[p2 + 1]];
      if (ba.asleep === bb.asleep) continue;
      var mover = ba.asleep ? bb : ba, sleeper = ba.asleep ? ba : bb;
      var ndx = mover.x - mover.px, ndy = mover.y - mover.py;
      if (ndx * ndx + ndy * ndy <= 0.25) continue;
      var cdx = bb.x - ba.x, cdy = bb.y - ba.y;
      var crs = ba.r + bb.r - CFG.slop - 0.5;
      if (cdx * cdx + cdy * cdy < crs * crs) this._wake(sleeper);
    }
    for (i = 0; i < n; i++) {
      b = bs[i];
      if (b.asleep) continue;
      // velocity IS displacement — no phantom momentum survives the solver
      b.vx = (b.x - b.px) / STEP * CFG.damping;
      b.vy = (b.y - b.py) / STEP * CFG.damping;
      var mdx = b.x - b.px, mdy = b.y - b.py;
      // hysteresis: a body 10+ steps into resting tolerates the ~0.08px load
      // burp that ripples out each time a NEIGHBOR falls asleep and anchors
      var tol = b.rest >= 10 ? 0.01 : CFG.sleepMove2;
      if (mdx * mdx + mdy * mdy < tol) {
        if (++b.rest >= CFG.sleepSteps) { b.asleep = true; b.vx = 0; b.vy = 0; }
      } else {
        b.rest = 0;
      }
    }

    // SUPPORT AUDIT — the backstop that makes "nothing hangs in mid-air" an
    // invariant instead of a hope.
    //
    // The wake cascade in extract() catches the common case, but a body can
    // still be orphaned mid-settle: it rests briefly on a neighbour, banks 20
    // quiet steps, sleeps — and only then does that neighbour slide out from
    // under it. Sleep is the trap, because a sleeping body is an immovable
    // anchor in _solvePair, so it never falls on its own again.
    //
    // Rather than chase every path that can orphan a body, re-check the
    // invariant periodically and wake anything holding itself up by nothing.
    // O(n^2) but amortised over 30 steps, and it self-heals within half a
    // second. Deterministic: keyed on the step count, not on wall time.
    this.steps = (this.steps || 0) + 1;
    if (this.steps % 30 === 0) this._auditSupport();
  };

  // Wake sleeping bodies with nothing beneath them. "Beneath" means a contact
  // whose normal actually points downward (>0.25 of the way from horizontal) —
  // a neighbour level with a body braces it sideways but cannot hold it up.
  Jar.prototype._auditSupport = function () {
    var bs = this.bodies;
    for (var i = 0; i < bs.length; i++) {
      var b = bs[i];
      if (!b.asleep) continue;
      if (b.y + b.r >= JAR.bot - 1.5) continue;          // sitting on the floor
      var held = false;
      for (var j = 0; j < bs.length && !held; j++) {
        var o = bs[j];
        if (o === b) continue;
        var dx = o.x - b.x, dy = o.y - b.y;
        if (dy <= 0) continue;                            // not below
        var d2 = dx * dx + dy * dy;
        var rs = b.r + o.r + 1.5;
        if (d2 > rs * rs) continue;                       // not in contact
        if (dy * dy > 0.0625 * d2) held = true;           // dy/d > 0.25
      }
      if (!held) this._wake(b);
    }
  };

  Jar.prototype._solvePair = function (a, b) {
    if (a.asleep && b.asleep) return;            // a resting pile stays resting
    var dx = b.x - a.x, dy = b.y - a.y;
    var rsum = a.r + b.r;
    var d2 = dx * dx + dy * dy;
    if (d2 >= rsum * rsum || d2 === 0) return;
    var d = Math.sqrt(d2);
    var nx = dx / d, ny = dy / d;
    var overlap = rsum - d;
    var ex = overlap - CFG.slop;
    if (ex <= 0) return;
    var corr = ex * CFG.correction;
    // asleep bodies are immovable anchors; the awake side takes the whole push
    if (a.asleep) { b.x += nx * corr; b.y += ny * corr; return; }
    if (b.asleep) { a.x -= nx * corr; a.y -= ny * corr; return; }
    var ma = a.r * a.r, mb = b.r * b.r, mt = ma + mb;
    a.x -= nx * corr * (mb / mt); a.y -= ny * corr * (mb / mt);
    b.x += nx * corr * (ma / mt); b.y += ny * corr * (ma / mt);
  };

  Jar.prototype._wake = function (b) {
    if (b.asleep) { b.asleep = false; }
    b.rest = 0;
  };

  Jar.prototype.settled = function () {
    for (var i = 0; i < this.bodies.length; i++) {
      var b = this.bodies[i];
      if (!b.asleep && b.y > JAR.top - 200) return false;
    }
    return true;
  };

  Jar.prototype.fastForward = function (maxSteps) {
    var STEP = 1 / CFG.stepHz;
    for (var s = 0; s < maxSteps; s++) {
      this.step(STEP);
      if ((s % 30) === 29 && this.settled()) return s + 1;
    }
    return maxSteps;
  };

  // YOU DIG FROM THE TOP DOWN. Nothing above you, at any height.
  //
  // This replaces a support test ("is anything RESTING on me") with a cover
  // test ("is anything OVER me at all"), and the difference is the whole game.
  // The support rule let a gem be taken from the bottom of the jar whenever it
  // happened to sit in a pocket, which is legal, playable, and completely
  // illegible: Vanus asked three separate times why he could collect gems that
  // were not on top, and finally said "i thought the purpose of the game is to
  // dig to the bottom". He is right that that is the fantasy the mole, the
  // pickaxe and the burrow all promise, and no amount of marking the reachable
  // bodies was going to make the old rule mean that.
  //
  // Dropping the dy limit is what makes it TRULY top-down: a body high above
  // now blocks all the way down its column, so the pile has a real surface
  // that recedes as you dig, instead of a scatter of local maxima.
  //
  // 0.85 is the horizontal tolerance — how much overlap counts as "over me".
  // 1.00 (any overlap at all) is defensible but punishing, because two circles
  // grazing by a pixel block each other. Measured over 100 seeds:
  //   1.00 -> 4.10 reachable, 12.4% of swings with no gem, 81/100 shifts done
  //   0.85 -> 5.49 reachable,  9.2%                        85/100
  //   0.78 -> 6.01 reachable,  8.3%                        81/100  (starts to
  //                                                        read as sideways)
  // Settled at 0.82 against the REAL gates rather than that probe: paired with
  // junkRatio 0.30 it clears 117 of the next 120 daily boards with none dead,
  // where 0.85/0.32 left one dead and 0.80/0.32 left two.
  //
  // THE LODESTONE'S GRIP IS GONE FROM HERE, and not by oversight: under a
  // cover rule a lodestone sitting above you already blocks you, so the grip
  // could only ever add blocking for a stone at the SAME height, which is not
  // a rule anyone could see. It earns its keep as a HARD STONE instead — see
  // `hits` in _route.
  //
  // Changing this re-screens EVERYTHING: sweep_career, sweep_difficulty and
  // screen_daily all read exposed().
  var COVER_X = 0.82;

  Jar.prototype.exposed = function (b) {
    var bs = this.bodies, i, o, dx;
    for (i = 0; i < bs.length; i++) {
      o = bs[i];
      if (o === b || o.y >= b.y) continue;
      dx = o.x - b.x; if (dx < 0) dx = -dx;
      if (dx < (o.r + b.r) * COVER_X) return false;
    }
    return true;
  };

  // Is a lodestone holding this body? Split from exposed() so the tap handler
  // can tell the two refusal reasons apart without re-deriving them.
  // WHICH bodies are covering this one — the same test exposed() runs,
  // collected instead of short-circuited, so a refused tap can point at them.
  //
  // Under the cover rule this is usually a short list and often a single body:
  // the thing directly above. That is the point — the answer to "why can't I
  // take that" should be one object the player can see and go clear.
  // WHAT IS ON TOP OF THIS GEM — and `limit` is the whole point.
  //
  // Uncapped, this returns the entire column above the target. Measured over
  // 3,268 refused taps across 40 settled jars: the median marks EIGHT bodies,
  // p90 fourteen, worst twenty-four, and 71.6% mark more than four. Ringing a
  // whole column with lines converging on the gem does not read as "clear these
  // first" — it reads as a rendering fault. I mistook it for one myself, on a
  // phone, having worked on this game all day.
  //
  // The actionable answer is the handful actually resting on it, so callers ask
  // for the NEAREST few: sorted by how far above the target they sit, closest
  // first. This is the same lesson as capping the first-run rings at two —
  // a teaching cue that marks everything teaches nothing.
  //
  // Uncapped remains available (omit `limit`) for anything that COUNTS rather
  // than draws.
  Jar.prototype.blockersOf = function (b, limit) {
    var out = [], bs = this.bodies, i, o, dx;
    for (i = 0; i < bs.length; i++) {
      o = bs[i];
      if (o === b || o.y >= b.y) continue;
      dx = o.x - b.x; if (dx < 0) dx = -dx;
      if (dx < (o.r + b.r) * COVER_X) out.push(o);
    }
    if (!limit || out.length <= limit) return out;
    // closest above the target first — the ones a player would lift off
    out.sort(function (p, q) { return q.y - p.y; });
    return out.slice(0, limit);
  };

  // THE LODESTONE'S GRIP IS GONE, AND SO IS THE CODE THAT DREW IT.
  // `lodeHolding()` and `heldBy()` were kept as null/[] stubs when the cover
  // rule replaced the grip (bc82081), which left a violet grip-arc renderer
  // and a refusal toast in the file that no input could ever reach. Dead
  // spectacle is how this project got `rock_crusted_hit` — 91KB of art nothing
  // could draw. Nothing may resurrect a grip without re-screening the ladder;
  // the reason it went is recorded above `COVER_X`.

  Jar.prototype.bodyAt = function (wx, wy) {
    var best = null, bestD = 1e9;
    for (var i = 0; i < this.bodies.length; i++) {
      var b = this.bodies[i];
      var dx = wx - b.x, dy = wy - b.y;
      var d = dx * dx + dy * dy;
      var lim = (b.r + 12) * (b.r + 12);
      if (d < lim && d < bestD) { best = b; bestD = d; }
    }
    return best;
  };

  Jar.prototype.extract = function (b) {
    if (!this.exposed(b)) return false;
    var i = this.bodies.indexOf(b);
    if (i < 0) return false;
    this.bodies.splice(i, 1);

    // Pulling a body out takes the floor from everything stacked on it, so the
    // wake must CASCADE UP the contact graph — not stop at the hole's own
    // neighbours.
    //
    // Why the old one-ring wake was not enough: step()'s wake pass only wakes a
    // sleeper that an awake body is pressing INTO (it tests overlap). When the
    // ring-1 body wakes and falls, it stops pressing on whatever rested on IT —
    // separation, not contact — so the column above was never woken and hung
    // in mid-air. Measured before this fix: 29/40 seeds finished a dig sequence
    // with asleep bodies that had nothing beneath them.
    //
    // Ring 1 is every neighbour of the hole (a body beside it may also lose its
    // brace); past that, propagate only UPWARD, since bodies below the hole are
    // still held by whatever was already holding them.
    var frontier = [{ x: b.x, y: b.y, r: b.r }];
    var woken = [];
    var ring = 0;
    while (frontier.length) {
      var c = frontier.pop();
      for (var j = 0; j < this.bodies.length; j++) {
        var o = this.bodies[j];
        if (woken.indexOf(o) >= 0) continue;
        var dx = o.x - c.x, dy = o.y - c.y;
        var rs = (o.r + c.r) * 1.6;
        if (dx * dx + dy * dy >= rs * rs) continue;
        if (ring > 0 && o.y >= c.y) continue;      // only things resting ON c
        woken.push(o);
        this._wake(o);
        frontier.push(o);
      }
      ring = 1;
    }
    return true;
  };

  Jar.prototype.countGems = function () {
    var c = 0;
    for (var i = 0; i < this.bodies.length; i++) {
      if (TYPE[this.bodies[i].key].col !== undefined && this.bodies[i].key.indexOf('rock') !== 0) c++;
    }
    return c;
  };

  Jar.prototype.stateHash = function () {
    var h = 0 >>> 0;
    for (var i = 0; i < this.bodies.length; i++) {
      var b = this.bodies[i];
      h = (Math.imul(h, 31) + b.id) >>> 0;
      h = (Math.imul(h, 31) + Math.round(b.x * 8)) >>> 0;
      h = (Math.imul(h, 31) + Math.round(b.y * 8)) >>> 0;
    }
    return this.bodies.length + ':' + h.toString(16);
  };

  // MOVED ABOVE THE NODE EXPORT ON PURPOSE. This table used to live below
  // the `typeof window === 'undefined'` guard, so under node it was
  // undefined and the economy could not be gated at all. It is pure data —
  // nothing here touches the DOM.
  // ===== THE SHOP — cosmetic unlocks, and the only place coins GO ===========
  // Coins used to evaporate at the bell, so progressing bought nothing. These
  // are what the wallet spends on.
  //
  // COSMETIC ONLY, and that is a hard rule, not modesty: the daily satchel is
  // locked at 7 and all 40 career levels are screened against exact numbers
  // (CAREER_REROLL), so ANY unlock granting power would fork daily fairness and
  // invalidate the ladder. A skin cannot.
  //
  // The wall variants are colour GRADES of the painted dig wall, composited
  // with 'color' so the original luminance — every painted crack and stratum —
  // survives untouched and only hue/saturation move. That reads as a different
  // mineral seam rather than a wash. Bespoke art can replace any of these
  // without touching this table: swap `tint` for a `spr` key.
  // The stuck-player lever. Priced at roughly one free dig's payout so it is a
  // real decision, not a formality — and it is EARNED, never sold for money.
  var DEEPER_PICK_COST = 250, DEEPER_PICK_SWINGS = 8;

  // PRICED AGAINST THE MEASURED LADDER, not by feel. `sweep_career.cjs --econ`
  // sums the expert bot's first-clear payout across all 40 levels: **14,178c**,
  // and that is the only BOUNDED income the game has (free digs bank every time,
  // the daily banks once a day). The old table totalled 6,200c, so the entire
  // shop was bought out around L18 of 40 and the back half of the ladder paid
  // into a wallet with nothing to want — the exact complaint the wallet was
  // built to answer, just moved 18 levels later. 13,200c now lands the last
  // item at roughly L38. `npm test` gates BOTH sides of that (see the econ gate
  // in sweep_career.cjs): the shop must be affordable eventually, and must not
  // be covered three-quarters of the way up.
  // `note` is the line under the name. Every locked row used to read the same
  // three words — "keep digging" — six times down the screen, which reads as
  // placeholder text nobody came back to write. A seam should say what it is
  // like to dig in it; that is the whole reason to want one.
  var WALL_SKINS = [
    { id: 'clay',     name: 'Burrow Clay',  price: 0,    tint: null,
      note: 'plain worked earth' },
    { id: 'amber',    name: 'Amber Seam',   price: 700,  tint: '#c98a2e', amt: 0.55,
      note: 'warm ochre, lantern-lit' },
    { id: 'frost',    name: 'Frost Vein',   price: 1400, tint: '#6fa8c9', amt: 0.55,
      note: 'cold blue, gems pop' },
    { id: 'malach',   name: 'Malachite',    price: 2500, tint: '#3f9e6b', amt: 0.55,
      note: 'green copper, deep quiet' },
    // Re-priced when crusted rocks started feeding the satchel. That change
    // raised a full career's income 14,178c -> 19,012c, which put the ENTIRE
    // shop inside the first 30 levels and tripped sweep_career's econ gate:
    // "the back of the ladder pays into a wallet with nothing to want."
    // The sink has to scale with the income, so the top two tiers absorb it.
    // The gate's window is (income by L30, income by L40) = (13,957c, 19,012c);
    // stock is 16,600c, which sits ~2.6k above the floor and ~2.4k below the
    // ceiling. Prices — not more ROWS: shopRowY(i) is 250 + i*64 and the view
    // is 720 tall, so a seventh row would draw its bottom edge at 754.
    // RE-PRICED FOR THE DIG-DOWN RULE. Career income rose from 16,444c to
    // ~23,900c when the cover rule landed, because excavating downward digs
    // far more rock and every rock is a coin. A 15,000c shop was then bought
    // out by L30 and the back third of the ladder paid into a wallet with
    // nothing left to want — the gate's other half, and it caught it.
    // 17,000c sits between the two bars: covered eventually (18,972c), not
    // covered early (14,200c at L30). Tightening perOrder pulled income back
    // down from 23,900c, so this was priced twice — the sink follows income,
    // and income follows every rule change.
    // RE-PRICED against an income the gate could finally SEE. sweep_career.cjs
    // granted coins in two places — order payouts and 1c a rock — and modelled
    // neither the epilogue (5c per leftover swing, which every cleared level
    // pays) nor the fact that a crusted rock pays no coin at all. Correcting
    // both moved a full career from a reported 19,661c to 25,405c, and
    // cumulative-at-L30 from 14,719c to 19,177c, which put the entire 17,000c
    // shop inside the first three-quarters of the ladder: the gate's other bar,
    // and it fired the moment it could measure.
    //
    // 22,000c sits between the two: not covered at L30 (19,177c) and covered
    // eventually (25,405c). The top two tiers absorb the increase, as they did
    // last time — the early rows pace the first hours and moving them would
    // slow a new player down to fix a problem that only exists at the end.
    { id: 'rose',     name: 'Rose Quartz',  price: 6300, tint: '#c96f8a', amt: 0.50,
      note: 'pink shot with white' },
    { id: 'basalt',   name: 'Deep Basalt',  price: 11100, tint: '#5a4a7a', amt: 0.60, dark: 0.22,
      note: 'darkest seam, all aglow' },
  ];

  // Node/test export of the PURE surface (determinism prover requires this).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      squirrel3: squirrel3, noise01: noise01, noise2: noise2,
      jarBodySpec: jarBodySpec, orderSpec: orderSpec, Jar: Jar, CFG: CFG,
      careerCfg: careerCfg, CAREER_MAX: CAREER_MAX,
      // SHARED, not mirrored: the screening sweep must ask the same question
      // the game asks, or it screens a ladder nobody plays.
      careerPrismOk: careerPrismOk,
      // Exported BY REFERENCE so tools/screen_reroll.cjs can try candidate
      // seeds without editing this file between every run. careerCfg reads it
      // live, so a mutation takes effect on the next call.
      CAREER_REROLL: CAREER_REROLL,
      bestDelivery: bestDelivery,
      SLOT_CLS: SLOT_CLS, PAY: PAY, TYPE: TYPE,
      DAILY_CHARACTERS: DAILY_CHARACTERS, dailyCharacter: dailyCharacter,
      seedStream: seedStream, streamFloat: streamFloat, rngInt: rngInt,
      dayNumber: dayNumber, dailySeed: dailySeed,
      WALL_SKINS: WALL_SKINS,
      DEEPER_PICK_COST: DEEPER_PICK_COST, DEEPER_PICK_SWINGS: DEEPER_PICK_SWINGS,
      // EXPORTED SO THE GATES STOP GUESSING. Four separate divergences were
      // found between _route and the sweeps that mirror it, and three of them
      // were a constant the tool could not see: the shale collapse's drop
      // height (JAR.top), the colossus's free/daily payout (HEART_SELL) and
      // its career payout (HEART_GIFT). A mirror can only be faithful to
      // numbers it can read.
      JAR: JAR, HEART_SELL: HEART_SELL, HEART_GIFT: HEART_GIFT,
      COVER_X: COVER_X,
    };
  }

  // Everything below needs a DOM. Under node (tests) we stop here.
  if (typeof window === 'undefined' || !window.document) return;

  // ===== Sprites ==========================================================
  // Painted art from tools/gen_art.py (artcore). Draw sizes are the collision
  // circles — sprite radius must hug the body radius or taps feel wrong.
  // A missing file falls back to the procedural facet-circle AND warns once:
  // silent fallbacks hide missing assets.
  var SPR_FILES = {
    gem_ruby: 'art/gem_ruby.png', gem_emerald: 'art/gem_emerald.png',
    gem_sapphire: 'art/gem_sapphire.png', gem_amber: 'art/gem_amber.png',
    gem_prism: 'art/gem_prism.png',
    rock_s: 'art/rock_s.png', rock_m: 'art/rock_m.png', rock_l: 'art/rock_l.png',
    // CUT VARIANTS (tools/gen_art_variants.py). One seed drew emerald 12x and
    // amber 14x pixel-identical: five sprites painting 45 bodies is why the
    // jar read as rubber stamps rather than a hoard. Variants are draw-side
    // ONLY — same key, same radius, so no seed repours.
    gem_ruby_b: 'art/gem_ruby_b.png', gem_ruby_c: 'art/gem_ruby_c.png',
    gem_emerald_b: 'art/gem_emerald_b.png', gem_emerald_c: 'art/gem_emerald_c.png',
    gem_sapphire_b: 'art/gem_sapphire_b.png', gem_sapphire_c: 'art/gem_sapphire_c.png',
    gem_amber_b: 'art/gem_amber_b.png', gem_amber_c: 'art/gem_amber_c.png',
    // THE CRUSTED GEM — see bodySpr(). Its predecessor's only tell was two
    // 1.6px flecks painted BEFORE the opaque rock sprite covered them.
    rock_crusted: 'art/rock_crusted.png',
    // The L16+/L24+ verbs. Both are flags on ordinary rocks, so they swap the
    // SPRITE only — the collision radius stays whatever the rock rolled.
    rock_lode: 'art/rock_lode.png',
    rock_shale: 'art/rock_shale.png',
    dragon_hoardling: 'art/dragon_hoardling.png',
    ui_coin: 'art/ui_coin.png',
    gem_heartstone: 'art/gem_heartstone.png',
    prop_pickaxe: 'art/prop_pickaxe.png',
    mole_keeper: 'art/mole_keeper.png',
    backdrop_burrow: 'art/backdrop_burrow.jpg',   // MENU only — the shop's face
    bg_dig_wall: 'art/bg_dig_wall.jpg',           // PLAY only — quiet, and TALL
  };
  var SPR = {};

  // ASSET URLS ARE BUILD-STAMPED, AND THE CODEC IS CHOSEN BY THE BUILD.
  //
  // Sprite filenames never change, so a CDN, WKWebView's URLCache and Safari's
  // PWA store will all serve the original bytes forever — Hoardling shipped new
  // art on 2026-08-13 and Vanus got "it's all the old art". `?v=<build>` is the
  // only thing that dislodges them. Both globals are published by
  // tools/build-web.py BEFORE game.js runs; in dev neither exists, so this is
  // the identity function and the PNG masters load straight off the dev server.
  var BUILD   = window.__BUILD__   || '';
  var ART_EXT = window.__ART_EXT__ || '';
  function assetURL(p) {
    if (ART_EXT) p = p.replace(/\.(png|jpg)$/, '.' + ART_EXT);
    return BUILD ? p + '?v=' + BUILD : p;
  }

  (function loadSprites() {
    var keys = Object.keys(SPR_FILES);
    var total = keys.length, done = 0;
    // The splash is a DOM overlay (index.html #boot) sitting over the canvas.
    // The game constructs and starts its loop immediately — but until the art
    // has DECODED it draws procedural fallback shapes, which read as a broken
    // or half-finished product. The splash simply covers that window, and this
    // is what tells it when the window has closed.
    var fill = document.getElementById('boot-fill');
    var boot = document.getElementById('boot');
    function tick() {
      done++;
      if (fill) fill.style.width = Math.round(done / total * 100) + '%';
      if (done < total || !boot) return;
      boot.classList.add('gone');
      setTimeout(function () {
        if (boot.parentNode) boot.parentNode.removeChild(boot);
      }, 450);
    }
    keys.forEach(function (k) {
      var im = new Image();
      im.onload = function () { SPR[k] = im; tick(); };
      im.onerror = function () {
        console.warn('[gemburrow] sprite missing: ' + SPR_FILES[k]);
        tick();                       // a missing file must not wedge the splash
      };
      im.src = assetURL(SPR_FILES[k]);
    });
  })();
  var BODY_SPR = {
    ruby: 'gem_ruby', emerald: 'gem_emerald', sapphire: 'gem_sapphire',
    amber: 'gem_amber', prism: 'gem_prism',
    rock_s: 'rock_s', rock_m: 'rock_m', rock_l: 'rock_l',
  };
  // Alternate CUTS per gem key. Chosen for SILHOUETTE contrast, not facet
  // style: a body paints at ~30-58 world px, where only outline and colour
  // survive. Colour stays locked to the key so an order card still reads.
  var GEM_CUTS = {
    ruby: ['gem_ruby', 'gem_ruby_b', 'gem_ruby_c'],
    emerald: ['gem_emerald', 'gem_emerald_b', 'gem_emerald_c'],
    sapphire: ['gem_sapphire', 'gem_sapphire_b', 'gem_sapphire_c'],
    amber: ['gem_amber', 'gem_amber_b', 'gem_amber_c'],
  };

  // Which sprite a body paints with. PURE and stable per body — the cut is
  // hashed off b.id, never rolled per frame, or a gem would flicker between
  // cuts as it fell.
  //
  // RNG lane: this is a DRAW-SIDE cosmetic choice and touches no gameplay
  // value, so it is deliberately keyed on id alone and NOT on this.seed — it
  // consumes nothing from lanes 1 or 2 and cannot fork a daily. noise01 is
  // used (rather than Math.random) purely so a body's cut is stable across
  // frames, which Math.random could not give.
  //
  // Falls back to the base sprite whenever a variant has not loaded, so a
  // missing or failed art file degrades to pass-1 art instead of dropping the
  // body to the procedural facet-circle.
  function bodySpr(b) {
    // A crusted rock is ONE hit — b.crack was never assigned anywhere, so the
    // two-stage sprite and its glint branch were unreachable code shipping a
    // 91KB asset nothing could draw. (The art was also wrong: the model drew a
    // literal pickaxe embedded in the stone.) If a multi-hit crust is ever
    // wanted, add the stage AND the art together.
    if (b.geode) {
      if (SPR.rock_crusted) return 'rock_crusted';
      return BODY_SPR[b.key];            // no crust art yet: plain rock
    }
    if (b.lode && SPR.rock_lode) return 'rock_lode';
    if (b.shale && SPR.rock_shale) return 'rock_shale';
    var cuts = GEM_CUTS[b.key];
    if (!cuts) return BODY_SPR[b.key];
    var pick = cuts[Math.floor(noise01(b.id, 0x0C07A1) * cuts.length) % cuts.length];
    return SPR[pick] ? pick : BODY_SPR[b.key];
  }

  // Per-sprite draw multiplier: d = SPR_FIT[key] * r, so each body's PAINTED
  // disc lands on its collision circle. Every sprite is a 256px square with a
  // different transparent margin, so the old flat d = r * 2.12 painted rock_s
  // at 1.47r and rock_l at 1.84r against a 2.0r collision circle — bodies that
  // were physically touching showed a band of air between them, unevenly, and
  // the pile read as loose and half-broken instead of packed.
  //
  // GENERATED — do not hand-edit. `python3 tools/measure_sprite_fit.py` prints
  // this table; `--check` (in npm test) fails if it drifts from the art, so
  // regenerating a sprite cannot silently bring the gaps back.
  var SPR_FIT = {
    gem_ruby: 2.624,              // ink fills 78.5% of its frame
    gem_emerald: 2.441,           // ink fills 84.4% of its frame
    gem_sapphire: 2.585,          // ink fills 79.7% of its frame
    gem_amber: 2.805,             // ink fills 73.4% of its frame
    gem_prism: 2.866,             // ink fills 71.9% of its frame
    rock_s: 2.979,                // ink fills 69.2% of its frame
    rock_m: 2.946,                // ink fills 69.9% of its frame
    rock_l: 2.375,                // ink fills 86.7% of its frame
    gem_heartstone: 2.419,        // ink fills 85.2% of its frame
    gem_ruby_b: 2.488,            // ink fills 82.8% of its frame
    gem_ruby_c: 2.523,            // ink fills 81.7% of its frame
    gem_emerald_b: 2.441,         // ink fills 84.4% of its frame
    gem_emerald_c: 2.244,         // ink fills 91.8% of its frame
    gem_sapphire_b: 2.476,        // ink fills 83.2% of its frame
    gem_sapphire_c: 2.354,        // ink fills 87.5% of its frame
    gem_amber_b: 2.323,           // ink fills 88.7% of its frame
    gem_amber_c: 2.293,           // ink fills 89.8% of its frame
    rock_crusted: 2.313,          // ink fills 89.1% of its frame
    rock_lode: 2.283,             // ink fills 90.2% of its frame
    rock_shale: 2.408,            // ink fills 85.5% of its frame
  };
  function sprFit(key) { return SPR_FIT[key] || 2.12; }

  function skinById(id) {
    for (var i = 0; i < WALL_SKINS.length; i++) if (WALL_SKINS[i].id === id) return WALL_SKINS[i];
    return WALL_SKINS[0];
  }
  function equippedWallId() {
    var id = (Meta.data.equipped && Meta.data.equipped.wall) || 'clay';
    // never render something the player does not own (a cleared save, a hand-
    // edited store): fall back rather than show a locked skin for free
    if (id !== 'clay' && !(Meta.data.owned && Meta.data.owned[id])) return 'clay';
    return id;
  }
  // HOARDLING SKINS — the payoff for the hoard ranks.
  //
  // The rank ladder repeats forever but only ever changed a LABEL: climbing to
  // Vault Dragon rewrote a line of text and nothing you could look at. These
  // are unlocked by rank rather than bought, because the hoard is already the
  // meta-currency the design leans on and coins have their own sink in the
  // walls. Cosmetic by construction, so no fairness constraint: `rank` gates
  // what you may WEAR, never swings, bag size or jar content.
  //
  // `rank` indexes HOARD_RANKS (0 = Pebble Keeper at hoard 20). -1 is the
  // default and is always available.
  var DRAGON_SKINS = [
    { id: 'lilac',  name: 'Lilac',        rank: -1, tint: null },
    { id: 'ember',  name: 'Ember',        rank: 0, tint: '#e06a2c', amt: 0.85 },
    { id: 'jade',   name: 'Jade',         rank: 1, tint: '#2fa96b', amt: 0.85 },
    { id: 'azure',  name: 'Azure',        rank: 2, tint: '#3f7fd8', amt: 0.85 },
    { id: 'rose',   name: 'Rose Gold',    rank: 3, tint: '#e08aa0', amt: 0.80 },
    { id: 'gilt',   name: 'Gilded',       rank: 4, tint: '#e8b23c', amt: 0.90 },
    { id: 'onyx',   name: 'Onyx',         rank: 5, tint: '#4a4358', amt: 0.90, dark: 0.30 },
    { id: 'star',   name: 'Starlight',    rank: 6, tint: '#9fd8ff', amt: 0.75 },
  ];
  function dragonSkinById(id) {
    for (var i = 0; i < DRAGON_SKINS.length; i++) {
      if (DRAGON_SKINS[i].id === id) return DRAGON_SKINS[i];
    }
    return DRAGON_SKINS[0];
  }
  // A skin is unlocked when the hoard has reached its rank. hoardRank returns
  // null below 20, which is exactly the default-only case.
  function dragonUnlocked(sk) {
    if (sk.rank < 0) return true;
    var r = hoardRank(Meta.data.hoardTotal);
    return !!r && r.idx >= sk.rank;
  }
  function equippedDragonId() {
    var id = (Meta.data.equipped && Meta.data.equipped.dragon) || 'lilac';
    // never render something the player cannot have — a cleared save, a hoard
    // that was reset, or a hand-edited store
    var sk = dragonSkinById(id);
    return dragonUnlocked(sk) ? sk.id : 'lilac';
  }
  var _dragonCache = {};
  function dragonImage() {
    var base = SPR.dragon_hoardling;
    if (!base) return null;
    var id = equippedDragonId();
    if (id === 'lilac') return base;
    if (_dragonCache[id]) return _dragonCache[id];
    var sk = dragonSkinById(id);
    try {
      var c = document.createElement('canvas');
      c.width = base.width; c.height = base.height;
      var x = c.getContext('2d');
      x.drawImage(base, 0, 0);
      if (sk.dark) {
        x.fillStyle = 'rgba(0,0,0,' + sk.dark + ')';
        x.fillRect(0, 0, c.width, c.height);
      }
      x.globalCompositeOperation = 'color';
      x.globalAlpha = sk.amt;
      x.fillStyle = sk.tint;
      x.fillRect(0, 0, c.width, c.height);
      // RESTORE THE CUTOUT. A blend mode still composites source-over, so the
      // fillRect above paints the transparent margin solid — the wall skin
      // never had to care because its base is a full-bleed JPEG, but the
      // dragon is a cutout and would ship as a coloured rectangle. Masking
      // back to the original alpha is what keeps it a dragon.
      x.globalCompositeOperation = 'destination-in';
      x.globalAlpha = 1;
      x.drawImage(base, 0, 0);
      x.globalCompositeOperation = 'source-over';
      _dragonCache[id] = c;
      return c;
    } catch (e) { return base; }
  }
  // PICKAXE SKINS — the star sink.
  //
  // 120 career stars were earnable and gated NOTHING: they were summed on the
  // menu, shown on the records screen, and bought, unlocked and changed
  // absolutely nothing. Stars measure mastery of the ladder, so the reward is
  // the tool you master it with. Coins buy walls, hoard dresses the dragon,
  // stars sharpen the pick — three currencies, three shelves, no overlap.
  //
  // Cosmetic by construction: `stars` gates what you may WEAR. The pick's
  // SWING BUDGET is untouched, so this cannot fork the daily or re-screen the
  // ladder.
  var PICK_SKINS = [
    { id: 'iron',  name: 'Worn Iron',  stars: 0,   tint: null },
    { id: 'copper', name: 'Copper',    stars: 15,  tint: '#c87e3a', amt: 0.85 },
    { id: 'silver', name: 'Silver',    stars: 35,  tint: '#b9c4cf', amt: 0.80 },
    { id: 'gold',   name: 'Goldhead',  stars: 60,  tint: '#e8b23c', amt: 0.90 },
    { id: 'onyxp',  name: 'Obsidian',  stars: 85,  tint: '#4a4358', amt: 0.90, dark: 0.28 },
    { id: 'starp',  name: 'Starforged', stars: 110, tint: '#9fd8ff', amt: 0.78 },
  ];
  function starTotal() {
    var n = 0, cs = Meta.data.careerStars || {};
    for (var k in cs) n += cs[k] || 0;
    return n;
  }
  function pickSkinById(id) {
    for (var i = 0; i < PICK_SKINS.length; i++) if (PICK_SKINS[i].id === id) return PICK_SKINS[i];
    return PICK_SKINS[0];
  }
  function pickUnlocked(sk) { return starTotal() >= sk.stars; }
  function equippedPickId() {
    var id = (Meta.data.equipped && Meta.data.equipped.pick) || 'iron';
    var sk = pickSkinById(id);
    return pickUnlocked(sk) ? sk.id : 'iron';   // never render an unearned pick
  }
  // Same cutout-safe recipe as the dragon: colour blend, then destination-in
  // to restore the original alpha, or the transparent margin ships solid.
  function tintCutout(base, sk, cache, key) {
    if (!base || !sk.tint) return base;
    if (cache[key]) return cache[key];
    try {
      var c = document.createElement('canvas');
      c.width = base.width; c.height = base.height;
      var x = c.getContext('2d');
      x.drawImage(base, 0, 0);
      if (sk.dark) { x.fillStyle = 'rgba(0,0,0,' + sk.dark + ')'; x.fillRect(0, 0, c.width, c.height); }
      x.globalCompositeOperation = 'color';
      x.globalAlpha = sk.amt; x.fillStyle = sk.tint;
      x.fillRect(0, 0, c.width, c.height);
      x.globalCompositeOperation = 'destination-in';
      x.globalAlpha = 1; x.drawImage(base, 0, 0);
      x.globalCompositeOperation = 'source-over';
      return (cache[key] = c);
    } catch (e) { return base; }
  }
  var _pickCache = {};
  function pickImage() {
    var base = SPR.prop_pickaxe;
    if (!base) return null;
    var id = equippedPickId();
    if (id === 'iron') return base;
    return tintCutout(base, pickSkinById(id), _pickCache, id);
  }
  var _wallCache = {};
  // ONE grader, keyed by id, because the shop has to be able to show you the
  // wall you are actually buying. The shop used to paint a flat #6b5a45 square
  // with the tint over it — a paint chip, not a wall — while the real seam is a
  // painted 1024x2400 rock face. The two could never agree, and the cheaper one
  // was the one on the price tag. Now the row draws THIS, so a preview that
  // disagrees with the dig is not a bug that can occur.
  function gradedWall(id) {
    var base = SPR.bg_dig_wall;
    if (!base) return null;
    if (id === 'clay') return base;
    if (_wallCache[id]) return _wallCache[id];
    var sk = skinById(id);
    if (!sk || !sk.tint) return base;
    try {
      var c = document.createElement('canvas');
      c.width = base.width; c.height = base.height;
      var x = c.getContext('2d');
      x.drawImage(base, 0, 0);
      if (sk.dark) {
        x.globalCompositeOperation = 'source-over';
        x.fillStyle = 'rgba(0,0,0,' + sk.dark + ')';
        x.fillRect(0, 0, c.width, c.height);
      }
      // 'color' keeps the base's LUMINANCE and takes hue+saturation from the
      // fill — a grade, not a tint wash, so the painting is still visible.
      x.globalCompositeOperation = 'color';
      x.globalAlpha = sk.amt;
      x.fillStyle = sk.tint;
      x.fillRect(0, 0, c.width, c.height);
      x.globalCompositeOperation = 'source-over';
      x.globalAlpha = 1;
      _wallCache[id] = c;
      return c;
    } catch (e) { return base; }
  }
  function wallImage() { return gradedWall(equippedWallId()); }
  // Where a body's PAINT ends, as a multiple of r — the HUG baked into SPR_FIT.
  // Halos and selection rings must be placed against THIS, not against r: the
  // collision radius is not what the player sees. When the fit changed, rings
  // anchored to r kept their old numbers and closed to 3px of the art.
  var BODY_INK = 1.03;
  function inkR(b) { return b.r * BODY_INK; }

  // ===== Meta — persistent progression (hoard total, bests, tutorial) =====
  // WKWebView localStorage is EVICTABLE under storage pressure: every write
  // mirrors to Capacitor Preferences (fire-and-forget), and boot restores
  // from native when localStorage comes up empty. No-ops on plain web.
  var Meta = (function () {
    var K = 'gb_meta_v1';
    // `coins` is the WALLET — banked across shifts, spent in the shop. Coins
    // were previously a per-shift score that evaporated at the bell, which is
    // why "what's the point of progressing" had no answer. `owned` is a set of
    // purchased cosmetic ids; `equipped` is what is currently worn.
    // Object.assign below merges over these defaults, so a save written before
    // the wallet existed loads with coins 0 and nothing owned — no migration.
    // `stats` threads one session to the next. Before it, a shift ended and
    // took everything with it except hoard and career level — there was no
    // record that you had ever played, which is the last structural reason to
    // stop. Object.assign is a SHALLOW merge, so a save written before stats
    // existed loads this whole object as-is; no migration, and a save that
    // already has it keeps its own.
    var data = { hoardTotal: 0, tutorialDone: false, bestDaily: {}, bestFree: 0,
                 clientId: '', playerName: '', pendingScore: null,
                 coins: 0, owned: {}, equipped: {},
                 stats: { shifts: 0, gems: 0, crusts: 0, hearts: 0,
                          bestCombo: 0, days: 0, streak: 0, bestStreak: 0,
                          lastDay: 0, earned: 0 },
                 // Declared here AND repaired lazily in contractsDone(). The
                 // merge below is SHALLOW, so a save written before this field
                 // existed keeps whatever it had and gains this default — but
                 // a save written with a corrupted value would keep the
                 // corruption, which is what the lazy guard is for.
                 contracts: {},
                 // WHICH VERBS THE PLAYER HAS HAD EXPLAINED, once ever.
                 // The lodestone and shale shipped into free and daily with no
                 // teaching beat at all: the coach is three steps, dies around
                 // swing 5, and names neither, while careerCfg's `intro` flag
                 // was written and read by nothing. Vanus met the lodestone on
                 // his phone and asked what it was and whether he liked it —
                 // which is the report of a mechanic that was never introduced.
                 taught: {},
                 // 1 = show the gold "a card wants it" and violet "something
                 // holds it" marks; 0 = quiet jar. Never gates the dig-light.
                 hints: 1,
                 // GEM SYMBOLS — a second identity channel, default OFF.
                 //
                 // Measured from the source art: every gem is a CIRCLE (aspect
                 // 0.98-1.06, filling 99%+ of its bounding ellipse), so shape
                 // carries no information at all and colour is the only channel
                 // the player has. Pair separation in raw RGB — ruby/amber 63,
                 // and under protanopia ruby/emerald collapses to 41, the
                 // classic red/green collision. A player who cannot separate
                 // those two cannot read an order card.
                 //
                 // Off by default because the painted gems are the game's whole
                 // look and most players do not need this; on, it stamps a small
                 // shape on every gem in the jar AND on the order-card icons, so
                 // matching works on silhouette alone.
                 marks: 0,
                 // ---- IAP -------------------------------------------------
                 // `full` is the one purchasable entitlement (see
                 // store/iap-catalog.json). `iapSeen` is the exactly-once
                 // journal, keyed by a hash of platform:transactionId, so a
                 // purchase interrupted mid-fulfilment retries on the next
                 // launch without granting twice.
                 full: 0, iapSeen: {} };
    var hadLocal = false;
    // IS THE LOCAL COPY PROVISIONAL? A session that could not read the native
    // backup still writes localStorage — with `data` at DEFAULTS if the read
    // failed before any play. That blob then made the NEXT boot take the
    // `hadLocal` branch below, which declares "localStorage IS the truth here",
    // latches nativeOK and mirrors the defaults straight over the only
    // surviving copy of the save. One transient bridge reject on the eviction
    // path — the exact case this mirror exists for — armed a total wipe on the
    // boot after it. Reproduced across two boots in a sandbox: backup coins
    // 1830 -> 0, hoard 42 -> 0, careerLevel 27 -> undefined.
    //
    // probe_meta_restore.cjs boots each mode exactly ONCE, so the gate could
    // not see it; the second boot is the whole defect.
    var provisional = false;
    try { provisional = localStorage.getItem(K + '.prov') === '1'; } catch (e) {}
    try {
      var s = localStorage.getItem(K);
      if (s) { data = Object.assign(data, JSON.parse(s)); hadLocal = true; }
    } catch (e) {}
    var Prefs = (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Preferences) || null;
    // MAY WE WRITE TO THE NATIVE BACKUP AT ALL? A latch, not a per-call
    // argument — see the restore block below. While it is false every save is
    // localStorage-only, so nothing this session can overwrite a backup we have
    // not successfully read.
    var nativeOK = false;
    function save(localOnly) {
      var s2 = JSON.stringify(data);
      try { localStorage.setItem(K, s2); } catch (e) {}
      // ...and say which of the two it is. The mark rides beside the save, not
      // inside it, so it can never travel to the native backup and cannot
      // affect a payload any other code reads.
      try {
        if (Prefs && !nativeOK) localStorage.setItem(K + '.prov', '1');
        else localStorage.removeItem(K + '.prov');
      } catch (e) {}
      if (Prefs && !localOnly && nativeOK) {
        try { Prefs.set({ key: K, value: s2 }).catch(function () {}); } catch (e) {}
      }
    }
    // How much life is in a save. Only consulted when a PROVISIONAL local copy
    // meets a readable native backup and one of them has to win.
    //
    // It reads SIX fields, not the obvious one. `stats.shifts` alone looked
    // like the monotone answer and is a trap: `stats` shipped later than the
    // save format, so every device that played before it has shifts = 0 while
    // holding a full career — and scoring shifts highest made the blank copy
    // beat a 27-level backup. The probe's REAL blob is deliberately that
    // pre-stats shape, and it is what caught this.
    //
    // Native wins ties by construction (>=), because a provisional copy started
    // from DEFAULTS with a freshly minted identity: it has to be clearly bigger
    // to be believed, not merely equal.
    function progress(d) {
      if (!d) return 0;
      var st = d.stats || {}, owned = 0, k;
      for (k in (d.owned || {})) owned++;
      return (st.shifts || 0)
           + (d.careerLevel || 0) * 4
           + (d.hoardTotal || 0)
           + Math.floor((d.coins || 0) / 100)
           + owned * 5
           + Math.floor((d.bestFree || 0) / 100);
    }
    function mint() {
      if (data.clientId) return;
      data.clientId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        var r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
      });
      data.playerName = 'MOLE-' + data.clientId.slice(0, 4).toUpperCase();
    }
    // THE WIPE TRAP: on the localStorage-eviction path — the exact case this
    // mirror exists for — minting a clientId and save()ing it synchronously
    // pushes the DEFAULT payload over the native backup before the restore
    // lands. Capacitor does not order independent bridge calls, so the set can
    // beat the get and the player's hoard/career is gone with no second copy.
    // Nothing may write until the restore settles.
    var settled = false, waiting = [];
    function settle(localOnly) {
      if (settled) return;
      settled = true;
      mint();
      save(localOnly);
      for (var i = 0; i < waiting.length; i++) waiting[i]();
      waiting.length = 0;
    }
    // A PROVISIONAL local copy must re-enter the restore, not skip it. Without
    // `|| provisional` the second boot after a failed read never reads the
    // backup again — and then overwrites it.
    if (Prefs && (!hadLocal || provisional)) {
      // THE SECOND HALF OF THE WIPE TRAP. The trap above is about ORDER; this
      // one is about OUTCOME. A restore has THREE outcomes, and the old code
      // had two: it swallowed the reject in a `.catch` and then ran the same
      // terminal `.then` as the success path, calling the NATIVE-writing
      // `save()` with `data` still at defaults. So on the eviction path — the
      // exact case this mirror exists for — one rejected or unparseable
      // `Prefs.get` overwrote the only surviving copy of the hoard, the career,
      // every star and the wallet with a blank save. The 250ms-timeout variant
      // was sharper still: `settle(true)` had already left the backup intact,
      // and the late rejection actively converted a safe state into a wipe.
      //
      //   restored / nothing stored -> we KNOW the native state: writing is safe
      //   could not read            -> we know NOTHING: never write, this session
      //
      // a hung bridge must never block launch — but the timeout path writes
      // localStorage ONLY, so a late restore still has a native copy to find
      var t = setTimeout(function () { settle(true); }, 250);
      Prefs.get({ key: K }).then(function (r) {
        if (r && r.value) {
          // Present but unreadable is NOT 'nothing stored'. Quarantine it and
          // stay local-only, so a parse bug cannot eat a real save.
          try {
            var nat = JSON.parse(r.value);
            // On an ORDINARY boot (no local copy) the backup simply wins. On a
            // provisional one the local copy may be a whole week of play made
            // while the bridge was down, so the fuller save wins and the other
            // is published over on the next write either way.
            if (!provisional || progress(nat) >= progress(data)) Object.assign(data, nat);
            nativeOK = true;
          } catch (e) {
            try { Prefs.set({ key: K + '.bad', value: r.value }).catch(function () {}); } catch (e2) {}
          }
        } else {
          nativeOK = true;                      // definitively empty: safe to seed it
        }
      }).catch(function () {
        // could not read — leave nativeOK false and never touch the backup
      }).then(function () {
        clearTimeout(t);
        if (settled) { mint(); save(); }        // timeout beat us: persist the restore now
        else settle();
      });
    } else {
      // localStorage IS the truth here; mirroring it out cannot lose anything.
      nativeOK = true;
      settle();
    }
    return { data: data, save: save, ready: function (cb) { if (settled) cb(); else waiting.push(cb); } };
  })();

  // ===== Lb — daily leaderboard client (Supabase REST, lane 3) ============
  // The publishable key SHIPS BY DESIGN (RLS is the boundary; probed against
  // the live project: 401 wrong-day OR missing privilege, 400 implausible
  // payload). All network is fire-and-forget cosmetic — the sim never waits.
  // ===== IAP — one non-consumable, and a hard wall between it and the sim ===
  //
  // THE MODEL, in full: the game is free, and ONE purchase unlocks career
  // levels 11-40 plus the 14-day archive. No subscription (there is no account
  // and no server to renew against), no consumable, no currency pack, no ads.
  // Coins are dug, never sold. store/iap-catalog.json is the source of truth
  // and its `_LAW` is the one to read first: a product id is PERMANENT.
  //
  // THE LINE THIS MUST NEVER CROSS. The daily is one seed shared by every
  // player on earth, and the forty career seeds are hand-screened against a
  // fixed swing budget. An entitlement that changed swings, satchel size, jar
  // content or the restock valve would fork the daily between buyers and
  // non-buyers — and the divergence would correlate exactly with who paid,
  // which is indistinguishable from cheating on the leaderboard. So the gate is
  // CONTENT (which levels you may enter) and never POWER, and no seeded draw
  // may sit on a branch that reads this entitlement. tools/probe_iap_fairness.js
  // proves the daily is byte-identical for a fresh save and an owns-everything
  // save; tools/validate.py fails the build if a seeded call appears near one.
  var FULL_PRODUCT = 'gemburrow.full.unlock';
  var FREE_CAREER_LEVELS = 10;

  var Ent = (function () {
    // FNV-1a over `platform:transactionId`. Play purchase tokens run to
    // hundreds of characters and have no business sitting in the save; the hash
    // dedupes just as well. Keyed on the TRANSACTION, not the product, so a
    // non-consumable restored five times still grants once.
    function receiptKey(platform, txId) {
      var h = 2166136261 >>> 0, str = platform + ':' + txId;
      for (var i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
      }
      return h.toString(16);
    }
    function owned() { return !!Meta.data.full; }
    // THE DEFER-FINISH HANDSHAKE's middle step. Native verifies the transaction
    // and hands it over WITHOUT finishing it; we journal 'fulfilling', grant,
    // then journal 'fulfilled'. Only then may the caller finalize. If the app
    // dies anywhere in here the transaction is still unfinished, so the next
    // launch re-yields it and this runs again — idempotently.
    function fulfill(platform, txId, productId) {
      if (productId !== FULL_PRODUCT) return { granted: false, reason: 'unknown product' };
      var key = receiptKey(platform, txId);
      if (!Meta.data.iapSeen) Meta.data.iapSeen = {};
      if (Meta.data.iapSeen[key] === 'fulfilled' && owned()) {
        return { granted: false, reason: 'already fulfilled', key: key };
      }
      Meta.data.iapSeen[key] = 'fulfilling';
      Meta.save();
      var was = owned();
      Meta.data.full = 1;
      Meta.data.iapSeen[key] = 'fulfilled';
      Meta.save();
      return { granted: !was, key: key };
    }
    return { owned: owned, fulfill: fulfill, receiptKey: receiptKey, PRODUCT: FULL_PRODUCT };
  })();

  // How far up the ladder this save may go. The ONLY thing the entitlement
  // changes anywhere in the game.
  function careerCap() {
    // NO STORE, NO WALL. On a build where the player physically cannot pay —
    // the web build, and any platform whose native store plugin does not exist
    // — walling them at level 10 is not a paywall, it is a dead end with no
    // door. The paywall already told the truth about this ("This build has no
    // store — the full ladder ships with the app"); careerCap did not, and
    // asking for level 11 quietly handed back level 10. A promise printed on
    // the screen is a claim, and this is the code that has to honour it.
    //
    // The revenue risk runs the other way — if the iOS plugin ever failed to
    // register, the ladder would be given away — so check_release_bundle.py
    // asserts GemburrowStore is in the shipped registration list.
    if (!Store.available()) return CAREER_MAX;
    return Ent.owned() ? CAREER_MAX : FREE_CAREER_LEVELS;
  }

  // The native bridge. Absent on the web build and in any browser, where the
  // game stays free and the paywall says so rather than pretending to sell.
  var Store = (function () {
    function plugin() {
      var C = window.Capacitor;
      return (C && C.Plugins && C.Plugins.GemburrowStore) || null;
    }
    var api = {
      available: function () { return !!plugin(); },
      // The localized price string from the storefront, or null. NEVER a
      // number we made up: a hardcoded "$4.99" is a 3.1.2 rejection on every
      // non-USD storefront, so the paywall prints "Price unavailable" instead.
      price: null,
      busy: false,
      note: null,
    };
    function handle(rows, done) {
      var granted = false;
      rows = rows || [];
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        var res = Ent.fulfill(r.platform || 'ios', r.transactionId, r.productId);
        if (res.granted) granted = true;
        // finalize LAST — this is what lets native call finish()/acknowledge
        var p = plugin();
        if (p && p.finalize) { try { p.finalize({ transactionId: r.transactionId }); } catch (e) {} }
      }
      if (done) done(granted);
    }
    api.load = function () {
      var p = plugin(); if (!p || !p.products) return;
      try {
        p.products({ ids: [FULL_PRODUCT] }).then(function (r) {
          var list = (r && r.products) || [];
          for (var i = 0; i < list.length; i++) {
            if (list[i].id === FULL_PRODUCT) api.price = list[i].displayPrice || null;
          }
        }).catch(function () {});
      } catch (e) {}
    };
    // Silent, on launch: re-yields anything verified but not finished.
    api.recover = function () {
      var p = plugin(); if (!p || !p.recover) return;
      try { p.recover().then(function (r) { handle(r && r.transactions); }).catch(function () {}); } catch (e) {}
    };
    api.buy = function (done) {
      var p = plugin();
      if (!p || !p.purchase) { api.note = 'The store is not available here.'; if (done) done(false); return; }
      api.busy = true; api.note = null;
      try {
        p.purchase({ id: FULL_PRODUCT }).then(function (r) {
          api.busy = false;
          if (r && r.cancelled) { if (done) done(false); return; }
          handle(r && r.transactions, function (g) {
            api.note = g ? null : 'Nothing to unlock.';
            if (done) done(g || Ent.owned());
          });
        }).catch(function (e) {
          api.busy = false; api.note = 'The purchase did not go through.';
          if (done) done(false);
        });
      } catch (e) { api.busy = false; api.note = 'The purchase did not go through.'; if (done) done(false); }
    };
    // Loud, user-tapped. Apple REQUIRES this for a non-consumable (3.1.1), and
    // finding the entitlement already present is a SUCCESS, not a no-op.
    api.restore = function (done) {
      var p = plugin();
      if (!p || !p.restore) { api.note = 'The store is not available here.'; if (done) done(false); return; }
      api.busy = true; api.note = null;
      try {
        p.restore().then(function (r) {
          api.busy = false;
          handle(r && r.transactions, function () {
            api.note = Ent.owned() ? 'Purchase restored.' : 'No purchase found on this Apple ID.';
            if (done) done(Ent.owned());
          });
        }).catch(function () {
          api.busy = false; api.note = 'Could not reach the store.'; if (done) done(false);
        });
      } catch (e) { api.busy = false; api.note = 'Could not reach the store.'; if (done) done(false); }
    };
    return api;
  })();

  var Lb = (function () {
    var URL = 'https://lrnupqottbfjfzsgtciq.supabase.co/rest/v1/gemburrow_daily_scores';
    var RPC = 'https://lrnupqottbfjfzsgtciq.supabase.co/rest/v1/rpc/gemburrow_submit_score';
    var LEAGUE = 'https://lrnupqottbfjfzsgtciq.supabase.co/rest/v1/gemburrow_league_14d';
    var KEY = 'sb_publishable_dSBtw3ULEeg9raBNXGuYJg_0fTlCKD6';
    var H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };
    // WRITES DO NOT TOUCH THE TABLE. This used to POST an upsert straight at
    // gemburrow_daily_scores, which meant anon needed UPDATE on it — and an
    // update privilege cannot be bound to "your own row" when the only identity
    // is a client_id the caller supplies, so anyone with this publishable key
    // could raise AND RENAME any of today's rows (the S5 hole). Submissions now
    // go through a SECURITY DEFINER function that stamps the day server-side,
    // re-checks every bound, and refuses any name that is not a minted
    // MOLE-XXXX. See tools/leaderboard-rpc.sql.
    //
    // BEST-OF-DAY is unchanged and still SERVER-side: the gemburrow_keep_best
    // trigger drops a replay that does not beat the stored row, so a worse
    // attempt cannot lower your score or regress your name.
    function submit(payload, done) {
      if (!window.fetch) return;
      fetch(RPC, {
        method: 'POST',
        headers: H,
        body: JSON.stringify({
          p_day: payload.day, p_seed: payload.seed, p_player: payload.player,
          p_coins: payload.coins, p_pops: payload.pops, p_client_id: payload.client_id,
        }),
      }).then(function (r) {
        // THE STATUS IS NOT THE VERDICT. A refused submission still answers
        // 200 with {"ok":false,...} — the function reports, it does not throw —
        // so trusting the transport alone would clear pendingScore for a score
        // that never landed. Never enumerate statuses either: that is the old
        // bug in the other direction (a merge answers 200, a new row 201, and
        // the shipped list 201/204/409 read every personal best as a failure).
        // Transport ok AND the function said ok.
        if (!r.ok) return false;
        return r.json().then(function (j) { return !!(j && j.ok); });
      }).then(function (ok) {
        if (done) done(ok);
      }).catch(function () { if (done) done(false); });
    }
    function top(day, limit, done) {
      if (!window.fetch) return done(null);
      fetch(URL + '?day=eq.' + day + '&select=player,coins&order=coins.desc&limit=' + limit, { headers: H })
        .then(function (r) { return r.json(); })
        .then(function (rows) { done(Array.isArray(rows) ? rows : null); })
        .catch(function () { done(null); });
    }
    // THE FORTNIGHT LEAGUE — a rolling 14-day view (tools/leaderboard-league.sql).
    // Read-only like top(). A 404 here is the EXPECTED state until that
    // migration is run, and is reported as 'closed' rather than 'error' so the
    // client can say something true instead of something broken.
    function league(limit, done) {
      if (!window.fetch) return done('error', null);
      fetch(LEAGUE + '?select=player,total,days&order=total.desc&limit=' + limit,
            { headers: H })
        .then(function (r) {
          // READ THE REASON, NOT THE TRANSPORT. "The view is not published
          // yet" and "the network is down" are different things to tell a
          // player, but the difference is in PostgREST's error BODY, not in
          // the status line — and enumerating status codes here is exactly
          // the bug that made every personal best read as a failure
          // (validate.py gates on it). PGRST205/42P01 are "no such table".
          if (!r.ok) {
            return r.json().then(function (e) {
              var c = e && e.code;
              done(c === 'PGRST205' || c === '42P01' ? 'closed' : 'error', null);
            }, function () { done('error', null); });
          }
          return r.json().then(function (rows) {
            done(Array.isArray(rows) ? 'ok' : 'error', Array.isArray(rows) ? rows : null);
          });
        })
        .catch(function () { done('error', null); });
    }
    return { submit: submit, top: top, league: league };
  })();

  // ===== Hap — haptics through Capacitor (no-op on web) ===================
  var Hap = (function () {
    var last = 0;
    function fire(style) {
      var P = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Haptics;
      if (!P) return;
      var now = performance.now();
      if (now - last < 30) return;                 // never machine-gun the Taptic
      last = now;
      try { P.impact({ style: style }).catch(function () {}); } catch (e) {}
    }
    return {
      light: function () { fire('LIGHT'); },
      medium: function () { fire('MEDIUM'); },
      heavy: function () { fire('HEAVY'); },
    };
  })();

  // Never trust the shape of a loaded save: `stats` can be absent, null, or a
  // half-written object from an interrupted write. Everything reads through
  // here so one bad field cannot take the records screen down.
  function stats() {
    var d = Meta.data;
    if (!d.stats || typeof d.stats !== 'object') {
      d.stats = { shifts: 0, gems: 0, crusts: 0, hearts: 0, bestCombo: 0,
                  days: 0, streak: 0, bestStreak: 0, lastDay: 0 };
    }
    return d.stats;
  }
  function bump(k, by) {
    var st = stats();
    st[k] = (st[k] || 0) + (by === undefined ? 1 : by);
  }

  var MILESTONES = [
    { n: 3, label: 'Hoardling wakes up!' },
    { n: 7, label: 'The hoard sparkles!' },
    { n: 12, label: 'Bigger bag on free digs!' },
    { n: 20, label: 'Golden Hoardling!' },
  ];

  // Named ranks BEYOND the authored milestones. The hoard is the game's only
  // real meta-currency and its ladder ended at 20 — while a full 40-level
  // career yields 27, so the ceremony stopped before the content did and a
  // player who kept hoarding got nothing back. Three of the four milestones
  // are flavour anyway, which is fine: flavour is what a hoard is FOR.
  //
  // These repeat forever by design. Past the named ranks the tier keeps
  // advancing every HOARD_STEP with a numbered name, so there is always a next
  // one — the point is that the number the player is growing never stops being
  // acknowledged, not that the reward escalates.
  //
  // STRICTLY COSMETIC, and that is load-bearing: any grant touching swing
  // budget, bag size or jar content must be free-mode-only or the daily is
  // unfair and all 40 career levels need re-screening. A title costs nothing.
  // ===== THE CONTRACT BOARD ================================================
  // The medium horizon: between a 3-minute shift and a 68-minute career there
  // was nothing at all. A permanent field guide of one-off conditions over
  // events the engine already emits — no new physics, no new body type, no
  // live-ops, no content treadmill.
  //
  // THEY PAY HOARD, NOT COINS. Hoard is strictly cosmetic (see the note on
  // DRAGON_SKINS), so a hoard grant carries no free-mode-only constraint and
  // cannot fork a daily or re-screen a level; and hoardRank() suffixes forever
  // past its table, so the ladder never ends. Coins would walk straight into
  // the ~4,000c of econ-gate headroom that killed the sink idea.
  //
  // THE FAUCET IS BOUNDED BY CONSTRUCTION. Every contract pays once and the
  // list is finite: 27 contracts, 121 hoard in total — about one pass of the
  // named rank ladder, which tops out at 110 for Star Hoard. So a player who
  // clears the whole board sits roughly one ladder ahead of where digging
  // alone would put them, and no further: it cannot run away and cheapen the
  // eight Hoardling skins gated on rank. If the list grows, re-check that sum.
  //
  // NO CLOCK. No expiry, no season, no window — those are appointment
  // mechanics wearing a rosette.
  //
  // `t` receives { s: this-shift summary, L: lifetime stats, M: Meta.data }.
  var CONTRACTS = [
    // --- one shift ---
    { id: 'perfect',  name: 'Full slate',        desc: 'fill every order in one shift',      h: 3, t: function (c) { return c.s.done >= c.s.goal; } },
    { id: 'spare20',  name: 'Room to spare',     desc: 'finish with 20 swings left',         h: 3, t: function (c) { return c.s.done >= c.s.goal && c.s.left >= 20; } },
    { id: 'spare30',  name: 'Barely broke a sweat', desc: 'finish with 30 swings left',      h: 5, t: function (c) { return c.s.done >= c.s.goal && c.s.left >= 30; } },
    { id: 'rich700',  name: 'Good haul',         desc: 'bank 700c in one shift',             h: 3, t: function (c) { return c.s.coins >= 700; } },
    { id: 'rich900',  name: 'Very good haul',    desc: 'bank 900c in one shift',             h: 5, t: function (c) { return c.s.coins >= 900; } },
    { id: 'heart1',   name: 'The colossus',      desc: 'take a Heartstone',                  h: 4, t: function (c) { return c.s.hearts >= 1; } },
    { id: 'crust3',   name: 'Rock hound',        desc: 'crack 3 crusted rocks in one shift', h: 3, t: function (c) { return c.s.crusts >= 3; } },
    { id: 'crust6',   name: 'Seam reader',       desc: 'crack 6 crusted rocks in one shift', h: 5, t: function (c) { return c.s.crusts >= 6; } },
    { id: 'chain10',  name: 'Steady hands',      desc: 'chain 10 gems without a jam',        h: 3, t: function (c) { return c.s.combo >= 10; } },
    { id: 'chain15',  name: 'Unbroken',          desc: 'chain 15 gems without a jam',        h: 5, t: function (c) { return c.s.combo >= 15; } },
    { id: 'star3',    name: 'Clean sheet',       desc: 'three-star a career level',          h: 4, t: function (c) { return c.s.stars >= 3; } },
    // --- lifetime ---
    { id: 'shift10',  name: 'Apprentice',        desc: 'work 10 shifts',                     h: 2, t: function (c) { return c.L.shifts >= 10; } },
    { id: 'shift50',  name: 'Journeyman',        desc: 'work 50 shifts',                     h: 4, t: function (c) { return c.L.shifts >= 50; } },
    { id: 'shift150', name: 'Old hand',          desc: 'work 150 shifts',                    h: 6, t: function (c) { return c.L.shifts >= 150; } },
    { id: 'gems100',  name: 'A hundred gems',    desc: 'deliver 100 gems',                   h: 2, t: function (c) { return c.L.gems >= 100; } },
    { id: 'gems500',  name: 'Five hundred gems', desc: 'deliver 500 gems',                   h: 4, t: function (c) { return c.L.gems >= 500; } },
    { id: 'gems2000', name: 'Two thousand gems', desc: 'deliver 2000 gems',                  h: 6, t: function (c) { return c.L.gems >= 2000; } },
    { id: 'crL50',    name: 'Crust breaker',     desc: 'crack 50 crusted rocks',             h: 3, t: function (c) { return c.L.crusts >= 50; } },
    { id: 'crL250',   name: 'Geode master',      desc: 'crack 250 crusted rocks',            h: 6, t: function (c) { return c.L.crusts >= 250; } },
    { id: 'hrt5',     name: 'Colossus hunter',   desc: 'take 5 Heartstones',                 h: 4, t: function (c) { return c.L.hearts >= 5; } },
    { id: 'hrt20',    name: 'Deep prospector',   desc: 'take 20 Heartstones',                h: 7, t: function (c) { return c.L.hearts >= 20; } },
    { id: 'streak3',  name: 'Three days running', desc: 'dig three days in a row',           h: 3, t: function (c) { return c.L.bestStreak >= 3; } },
    { id: 'streak7',  name: 'A week of digging', desc: 'dig seven days in a row',            h: 5, t: function (c) { return c.L.bestStreak >= 7; } },
    { id: 'streak14', name: 'A fortnight',       desc: 'dig fourteen days in a row',         h: 8, t: function (c) { return c.L.bestStreak >= 14; } },
    { id: 'career10', name: 'Down the shaft',    desc: 'reach career level 10',              h: 3, t: function (c) { return (c.M.careerLevel || 1) >= 10; } },
    { id: 'career25', name: 'Deeper still',      desc: 'reach career level 25',              h: 5, t: function (c) { return (c.M.careerLevel || 1) >= 25; } },
    { id: 'careerAll', name: 'End of the shaft', desc: 'clear every career level',           h: 10, t: function (c) { return (c.M.careerLevel || 1) > CAREER_MAX; } },
  ];
  function contractsDone() {
    var d = Meta.data.contracts;
    if (!d || typeof d !== 'object') { d = Meta.data.contracts = {}; }
    return d;
  }

  var HOARD_RANKS = [
    'Pebble Keeper', 'Gem Warden', 'Deep Hoarder', 'Vault Dragon',
    'Treasure Wyrm', 'Mountain Hoard', 'Star Hoard',
  ];
  var HOARD_STEP = 15;                 // one rank per 15 hoard past the named ones
  function hoardRank(total) {
    if (total < 20) return null;       // the named MILESTONES own this range
    var i = Math.floor((total - 20) / HOARD_STEP);
    return {
      idx: i,
      at: 20 + i * HOARD_STEP,
      next: 20 + (i + 1) * HOARD_STEP,
      name: i < HOARD_RANKS.length
        ? HOARD_RANKS[i]
        : HOARD_RANKS[HOARD_RANKS.length - 1] + ' ' + (i - HOARD_RANKS.length + 2),
    };
  }

  // ===== Snd — procedural audio, lane 3 ONLY ==============================
  // Two buses (music/sfx) with independent mutes — an energetic effect must
  // never force the player to kill the score (two-bus law). All buffers are
  // synthesized; zero audio files. Every random draw here is Math.random —
  // audio NEVER touches lanes 1/2 (count/timing is per-player).
  var Snd = (function () {
    var ac = null, master = null, musicBus = null, sfxBus = null;
    var live = [];                        // voice pool: cap concurrent one-shots
    var MAXV = 8;                         // voices allowed to SOUND at once
    // Runaway backstop only — it counts QUEUED voices, so it must clear the
    // biggest legitimate burst by a wide margin or it silently eats a phrase.
    // One tier-3 fanfare queues 13, and _deliver fires one per delivery while
    // _checkDeliveries loops, so a satchel paying four cards is a real 52 in a
    // single tick. 24 clipped a chained pair; 48 clipped a quad. Peak LOUDNESS
    // is not the concern here — MAXV caps what actually sounds, and the mix is
    // tuned to peak at 0.979 just under clipping — this is purely a leak guard.
    var MAXQ = 64;
    var lastAt = {};                      // per-name rate limit
    var api = {
      // THROUGH Meta, not through two bare localStorage keys.
      //
      // Every other persisted setting — hints, marks, tutorialDone, the wallet,
      // the hoard, the stars — lives in Meta.data and is mirrored to Capacitor
      // Preferences precisely because, in the module's own words, "WKWebView
      // localStorage is EVICTABLE under storage pressure". These two were
      // written with a raw setItem to 'gb_music_mute'/'gb_sfx_mute' and mirrored
      // nowhere, so they were the only settings in the game an eviction could
      // silently undo — and the one it undoes loudly, by turning the sound back
      // on for someone who deliberately turned it off.
      //
      // The legacy keys are still READ once, so nobody's existing choice is
      // lost on the upgrade; the first toggle writes the new home.
      musicMuted: Meta.data.musicMuted !== undefined
                  ? !!Meta.data.musicMuted : localStorage.getItem('gb_music_mute') === '1',
      sfxMuted: Meta.data.sfxMuted !== undefined
                ? !!Meta.data.sfxMuted : localStorage.getItem('gb_sfx_mute') === '1',
    };

    function ensure() {
      if (!ac) {
        try {
          ac = new (window.AudioContext || window.webkitAudioContext)();
          master = ac.createGain(); master.connect(ac.destination);
          musicBus = ac.createGain(); musicBus.connect(master);
          sfxBus = ac.createGain(); sfxBus.connect(master);
          musicBus.gain.value = api.musicMuted ? 0 : 0.5;
          sfxBus.gain.value = api.sfxMuted ? 0 : 1;
        } catch (e) { ac = null; }
      }
      if (ac && ac.state !== 'running') { try { ac.resume(); } catch (e) {} }
      return ac;
    }

    function n2f(m) { return 440 * Math.pow(2, (m - 69) / 12); }

    // tiny sample synth: shape osc + noise mix, AR envelope, pitch slide/jump,
    // one echo tap, soft clip. Generates a short buffer per voice (cheap).
    function gen(p) {
      var sr = ac.sampleRate;
      var dur = (p.a || 0.005) + (p.s || 0.02) + (p.r || 0.12);
      var total = dur + (p.echo ? (p.echoT || 0.12) * 2 : 0);
      var n = Math.max(8, Math.floor(total * sr));
      var buf = ac.createBuffer(1, n, sr);
      var d = buf.getChannelData(0);
      var f = p.f * (1 + (p.jit || 0) * (Math.random() * 2 - 1));
      var phase = 0;
      for (var i = 0; i < n; i++) {
        var t = i / sr;
        var ff = f * Math.pow(2, (p.slide || 0) * t);
        if (p.jump && t > (p.jumpT || 0.05)) ff += p.jump;
        phase += ff / sr;
        var x = phase - Math.floor(phase);
        var v;
        var sh = p.shape || 'tri';
        if (sh === 'sine') v = Math.sin(6.28318 * x);
        else if (sh === 'saw') v = 2 * x - 1;
        else if (sh === 'sq') v = (x < 0.5 ? 1 : -1) * 0.6;
        else v = x < 0.5 ? 4 * x - 1 : 3 - 4 * x;       // tri
        if (p.noise) v = v * (1 - p.noise) + (Math.random() * 2 - 1) * p.noise;
        var env;
        var A = p.a || 0.005, S = p.s || 0.02, R = p.r || 0.12;
        if (t < A) env = t / A;
        else if (t < A + S) env = 1;
        else if (t < dur) env = Math.pow(1 - (t - A - S) / R, p.curve || 1.6);
        else env = 0;
        v *= env * (p.vol || 0.2);
        d[i] += v / (1 + Math.abs(v));
      }
      if (p.echo) {
        var off = Math.floor((p.echoT || 0.12) * sr);
        for (var j = n - 1; j >= off; j--) d[j] += d[j - off] * p.echo;
      }
      return buf;
    }

    function voice(buf, bus, when) {
      // MAXV caps voices that are SOUNDING, which is not the same as voices
      // queued. A phrase schedules its notes ahead of time, so counting the
      // queue makes a spread-out phrase look like a pile-up.
      //
      // That is what the tier-3 fanfare did to itself: 13 voices queued in ONE
      // synchronous call, spread over 0.66s. The queue hit 8 before a single
      // note had begun, so the pool evicted the five OLDEST — the whole opening
      // chord plus two thirds of the second layer — and because stop() on a
      // voice scheduled in the future deletes it outright, they were never
      // heard at all. Measured: 13 requested, 5 stopped, all 5 before playing.
      // The biggest payout in the game opened mid-phrase. Its real peak
      // concurrency is only 7; it always fitted, the accounting was wrong.
      //
      // Tap-spam voices start immediately, so they count as sounding at once
      // and the cap still bites exactly as intended.
      var at = when || ac.currentTime;
      var now = ac.currentTime, sounding = 0, victim = -1;
      for (var vi = 0; vi < live.length; vi++) {
        if (live[vi].at <= now) { sounding++; if (victim < 0) victim = vi; }
      }
      if (sounding >= MAXV && victim >= 0) {
        try { live[victim].src.stop(); } catch (e) {}   // oldest SOUNDING voice
        live.splice(victim, 1);
      } else if (live.length >= MAXQ) {
        return;                    // runaway backstop; drop the NEW voice
      }
      var src = ac.createBufferSource();
      src.buffer = buf; src.connect(bus || sfxBus);
      var rec = { src: src, at: at };
      src.onended = function () { var i = live.indexOf(rec); if (i >= 0) live.splice(i, 1); };
      src.start(when || 0); live.push(rec);
    }

    function sfx(name, p, limitMs) {
      if (!ensure() || api.sfxMuted) return;
      var now = performance.now();
      if (limitMs && lastAt[name] && now - lastAt[name] < limitMs) return;
      lastAt[name] = now;
      voice(gen(p));
    }

    // ---- music: composed beds rendered by tools/generate_music.py through
    // ---- the fleet pipeline (hexmusic/score — the Hexhunter lane). The
    // ---- ladder/fanfares harmonize to the LIVE bed's bar via music_map.json.
    // ---- Fallback chords cover the seconds before the files decode.
    var FALLBACK_CHORD = [43, 47, 50];   // G major, the suite's home
    var SRC_SR = 44100;                  // render rate; decode may resample
    var Music = {
      map: null, buffers: {}, loaded: false,
      cur: null, curGain: null, curName: '', startedAt: 0, durSec: 0,
      pending: 'shop', duck: null,
    };

    function musicLoad() {
      if (Music.loading || !window.fetch) return;
      Music.loading = true;
      // assetURL stamps ?v=<build> but leaves the extension alone (it only
      // swaps .png/.jpg), so the beds keep their codec and still bust caches.
      fetch(assetURL('audio/music_map.json')).then(function (r) { return r.json(); }).then(function (map) {
        Music.map = map;
        ['music_shop', 'music_dig', 'music_perfect'].forEach(function (name) {
          fetch(assetURL('audio/' + name + '.m4a')).then(function (r) { return r.arrayBuffer(); }).then(function (ab) {
            if (!ensure()) return;
            ac.decodeAudioData(ab, function (buf) {
              // decodeAudioData resamples to the context rate and does NOT
              // reliably honor gapless metadata — trim to the exact length
              var want = Math.round(map[name].samples * ac.sampleRate / SRC_SR);
              var out = ac.createBuffer(buf.numberOfChannels, Math.min(want, buf.length), ac.sampleRate);
              for (var c = 0; c < buf.numberOfChannels; c++) {
                out.getChannelData(c).set(buf.getChannelData(c).subarray(0, out.length));
              }
              Music.buffers[name] = out;
              if (name !== 'music_perfect') Music.loaded = true;
              if (Music.pending) { var p = Music.pending; Music.pending = null; startBed(p); }
            }, function () {});
          }).catch(function () {});
        });
      }).catch(function () {});
    }

    function startBed(scene) {
      var name = scene === 'dig' ? 'music_dig' : 'music_shop';
      if (!ac) { Music.pending = scene; return; }
      if (!Music.buffers[name]) { Music.pending = scene; return; }
      if (Music.curName === name) return;
      var t = ac.currentTime;
      if (Music.cur) {
        var old = Music.cur, og = Music.curGain;
        og.gain.cancelScheduledValues(t);      // kill pending duck-restores —
                                               // a later ramp resurrects a bed
        og.gain.setValueAtTime(og.gain.value, t);
        og.gain.linearRampToValueAtTime(0, t + 1.4);       // the 1.4s law
        setTimeout(function () { try { old.stop(); } catch (e) {} }, 1600);
      }
      var src = ac.createBufferSource();
      src.buffer = Music.buffers[name];
      src.loop = true;
      var gn = ac.createGain();
      gn.gain.setValueAtTime(0, t);
      gn.gain.linearRampToValueAtTime(1, t + 1.4);
      src.connect(gn); gn.connect(musicBus);
      src.start(t);
      Music.cur = src; Music.curGain = gn; Music.curName = name;
      Music.startedAt = t;
      Music.durSec = src.buffer.duration;
    }

    api.scene = function (scene) {
      Music.lastScene = scene;
      if (!ac || !Music.loaded) { Music.pending = scene; return; }
      startBed(scene);
    };

    // the epilogue sting: one-shot layered over the dig bed, which ducks
    // beneath it and returns — same key, so they agree
    api.perfect = function () {
      if (!ensure()) return;
      var buf = Music.buffers.music_perfect;
      if (!buf || Music.curName !== 'music_dig') return;
      var t = ac.currentTime;
      if (Music.curGain) {
        var gv = Music.curGain.gain;
        gv.setValueAtTime(gv.value, t);
        gv.linearRampToValueAtTime(0.22, t + 0.4);
        gv.setValueAtTime(0.22, t + buf.duration - 1.2);
        gv.linearRampToValueAtTime(1, t + buf.duration);
      }
      var src = ac.createBufferSource();
      src.buffer = buf;
      src.connect(musicBus);
      src.start(t);
    };

    // A gem landing on the pile: the "marbles in a jar" sound.
    //
    // Deliberately NOT routed through sfx(name, p, limitMs). That limiter keys
    // on the NAME, so a single shared 'clack' would collapse a five-body
    // collapse — the exact moment worth hearing — into one tick. Throttling is
    // the CALLER's job (a per-frame budget in _cosmetic), because only the
    // caller knows how many bodies actually landed this frame.
    //
    // `force` is the speed the body lost on impact (px/s) and `r` its radius.
    // Pitch falls with size the way a real marble does — a 15px chip rings
    // near 880Hz, a 29px boulder thuds near 300 — and both the volume and the
    // click's brightness scale with force, so a settling pile whispers and a
    // collapse actually knocks.
    api.clack = function (force, r) {
      if (!ensure() || api.sfxMuted) return;
      var f = Math.max(0, Math.min(1, (force - 45) / 220));   // 0..1
      var size = Math.max(0, Math.min(1, (r - 14) / 16));     // 0 small, 1 big
      voice(gen({
        f: 880 - size * 580,
        shape: size > 0.55 ? 'tri' : 'sine',
        a: 0.001,
        s: 0.006 + size * 0.010,
        r: 0.045 + size * 0.055,
        slide: -0.35 - size * 0.35,
        vol: (0.045 + f * 0.085) * (1 - size * 0.15),
        jit: 0.05,
        noise: 0.05 + f * 0.10,
      }));
    };

    api.unlock = function () {
      if (!ensure()) return;
      musicLoad();
      if (Music.pending && Music.loaded) { var p = Music.pending; Music.pending = null; startBed(p); }
      // self-heal: any tap restarts a bed that died to an iOS interruption
      else if (Music.loaded && !Music.cur && Music.lastScene) startBed(Music.lastScene);
    };

    api.chord = function () {
      var m = Music.map && Music.map.music_dig;
      if (m && Music.curName === 'music_dig' && ac) {
        var t = (ac.currentTime - Music.startedAt) % Music.durSec;
        var barSec = (60 / m.bpm) * m.beatsPerBar;
        var bar = Math.floor(t / barSec) % m.bars;
        var ch = m.chords[bar];
        if (ch && ch.length) return ch;
      }
      if (m && Music.map.music_shop && Music.curName === 'music_shop' && ac) {
        var ms = Music.map.music_shop;
        var t2 = (ac.currentTime - Music.startedAt) % Music.durSec;
        var bs2 = (60 / ms.bpm) * ms.beatsPerBar;
        var ch2 = ms.chords[Math.floor(t2 / bs2) % ms.bars];
        if (ch2 && ch2.length) return ch2;
      }
      return FALLBACK_CHORD;
    };

    api.setMusicMuted = function (m) {
      api.musicMuted = m; Meta.data.musicMuted = !!m; Meta.save();
      if (!m) ensure();                        // unmute must also revive a
                                               // suspended/interrupted context
      if (musicBus) {
        try { musicBus.gain.cancelScheduledValues(ac.currentTime); } catch (e) {}
        musicBus.gain.value = m ? 0 : 0.5;
      }
      if (!m && Music.loaded && !Music.cur) startBed(Music.lastScene || 'shop');
    };
    api.setSfxMuted = function (m) {
      api.sfxMuted = m; Meta.data.sfxMuted = !!m; Meta.save();
      if (sfxBus) sfxBus.gain.value = m ? 0 : 1;
    };

    // ---- the event vocabulary ----
    api.pop = function () {                          // extraction: punchy pluck
      sfx('pop', { f: 420, shape: 'tri', a: 0.004, s: 0.03, r: 0.11, slide: -1.2, vol: 0.30, jit: 0.03, noise: 0.06 }, 30);
    };
    api.thunk = function () {                        // refused: damped low knock
      sfx('thunk', { f: 95, shape: 'sq', a: 0.004, s: 0.02, r: 0.09, slide: -0.8, vol: 0.22, noise: 0.18 }, 60);
    };
    api.scrap = function () {                        // rock to the spare bin
      sfx('scrap', { f: 260, shape: 'tri', a: 0.004, s: 0.01, r: 0.07, vol: 0.10, jit: 0.04 }, 40);
    };
    // fill ladder: combo n climbs the LIVE CHORD's tones, +1 octave per lap,
    // capped 2 octaves up then a sparkle layer joins instead of climbing.
    api.fill = function (combo) {
      if (!ensure() || api.sfxMuted) return;
      var chord = api.chord();
      var step = Math.max(0, (combo || 1) - 1);
      var oct = Math.min(2, Math.floor(step / 3));
      var m = chord[step % 3] + 24 + oct * 12;
      voice(gen({ f: n2f(m), shape: 'tri', a: 0.004, s: 0.04, r: 0.16, vol: 0.24, jit: 0.006 }));
      if (step >= 6) {
        voice(gen({ f: n2f(m + 12), shape: 'sine', a: 0.006, s: 0.03, r: 0.22, vol: 0.10 }));
      }
    };
    // fanfare tiers scale with REAL payout — magnitude reads as DURATION.
    // Never called on a net loss (pillar 2).
    api.fanfare = function (pay) {
      if (!ensure() || api.sfxMuted) return;
      var chord = api.chord();
      var tier = pay >= 150 ? 3 : pay >= 90 ? 2 : 1;
      var t = ac.currentTime;
      for (var i = 0; i < 3; i++) {
        voice(gen({ f: n2f(chord[i] + 24), shape: 'tri', a: 0.005, s: 0.05, r: 0.25, vol: 0.20 }), sfxBus, t + i * 0.055);
      }
      if (tier >= 2) {
        for (var j = 0; j < 3; j++) {
          voice(gen({ f: n2f(chord[j] + 36), shape: 'sine', a: 0.005, s: 0.04, r: 0.30, vol: 0.10 }), sfxBus, t + 0.18 + j * 0.06);
        }
      }
      if (tier >= 3) {
        for (var k = 0; k < 6; k++) {
          var m2 = chord[k % 3] + 24 + 12 * Math.floor(k / 3);
          voice(gen({ f: n2f(m2), shape: 'tri', a: 0.004, s: 0.03, r: 0.22, vol: 0.14, jit: 0.01 }), sfxBus, t + 0.34 + k * 0.05);
        }
        voice(gen({ f: n2f(chord[0] + 48), shape: 'sine', a: 0.01, s: 0.10, r: 0.5, vol: 0.09 }), sfxBus, t + 0.66);
      }
    };
    api.tick = function () {                         // coin rollup ticks
      sfx('tick', { f: 1180, shape: 'sine', a: 0.002, s: 0.008, r: 0.045, vol: 0.07, jit: 0.045 }, 40);
    };
    api.slam = function () {                         // rollup lands
      sfx('slam', { f: 140, shape: 'tri', a: 0.004, s: 0.03, r: 0.16, slide: -0.6, vol: 0.20, noise: 0.10 }, 120);
    };
    api.hoard = function () {                        // dragon coo: soft rising third
      if (!ensure() || api.sfxMuted) return;
      var t = ac.currentTime;
      voice(gen({ f: n2f(76), shape: 'sine', a: 0.02, s: 0.06, r: 0.30, vol: 0.16 }), sfxBus, t);
      voice(gen({ f: n2f(80), shape: 'sine', a: 0.02, s: 0.08, r: 0.40, vol: 0.14 }), sfxBus, t + 0.12);
    };
    api.expire = function () {                       // comic descending, never a sting
      if (!ensure() || api.sfxMuted) return;
      var t = ac.currentTime;
      voice(gen({ f: n2f(64), shape: 'tri', a: 0.01, s: 0.04, r: 0.18, vol: 0.12 }), sfxBus, t);
      voice(gen({ f: n2f(60), shape: 'tri', a: 0.01, s: 0.05, r: 0.26, slide: -0.5, vol: 0.12 }), sfxBus, t + 0.14);
    };
    // A LOST ORDER NEEDS ITS OWN VOICE. This used to reuse api.expire — the
    // same two notes that mean "the pick is wearing", so the one audio tell for
    // a missed 90c order was indistinguishable from a routine budget warning.
    api.orderLost = function () {                    // a paper card slipping off the line
      if (!ensure() || api.sfxMuted) return;
      var t = ac.currentTime;
      voice(gen({ f: 220, shape: 'tri', a: 0.004, s: 0.03, r: 0.10, vol: 0.10, noise: 0.35 }), sfxBus, t);
      voice(gen({ f: n2f(59), shape: 'sine', a: 0.01, s: 0.07, r: 0.34, slide: -0.9, vol: 0.15 }), sfxBus, t + 0.05);
      voice(gen({ f: n2f(52), shape: 'sine', a: 0.02, s: 0.10, r: 0.42, vol: 0.12 }), sfxBus, t + 0.20);
    };
    api.pour = function () {                         // restock rumble + rattle
      if (!ensure() || api.sfxMuted) return;
      var t = ac.currentTime;
      voice(gen({ f: 70, shape: 'tri', a: 0.03, s: 0.25, r: 0.4, vol: 0.16, noise: 0.55 }), sfxBus, t);
      for (var i = 0; i < 5; i++) {
        voice(gen({ f: 300 + Math.random() * 260, shape: 'tri', a: 0.003, s: 0.01, r: 0.06, vol: 0.07, noise: 0.2 }), sfxBus, t + 0.08 + Math.random() * 0.4);
      }
    };

    document.addEventListener('visibilitychange', function () {
      if (!ac) return;
      if (document.hidden) { try { ac.suspend(); } catch (e) {} }
      else if (ac.state !== 'running') { try { ac.resume(); } catch (e) {} }
    });

    return api;
  })();

  // ===== Game =============================================================
  function Game(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.view = { cw: 1, ch: 1, dpr: 1, scale: 1, w: VIEW_MIN_W, h: VIEW_H, ox: 0, oy: 0 };
    this._last = 0; this._acc = 0;
    this._taps = [];
    this.fliers = []; this.sparks = []; this.rings = []; this.picks = [];
    this.bursts = [];   // sim-requested particle bursts, sampled in _cosmetic
    this.displayCoins = 0;
    this.hitStop = 0;
    this.state = 'menu';                 // 'menu' | 'playing' | 'results' | 'paused'
    // `?seed=` USED TO BE READ HERE, outside the dev IIFE, so it survived
    // `build-web.py --release` and shipped a query-parameter world-chooser in
    // the store bundle. §3c is explicit: query parameters must never steer a
    // release artifact. It now lives in the dev block at the bottom, which the
    // release strip removes — and check_release_bundle.py proves it gone.
    this.resize();
    this.watchInsets();
    this._frame = this._frame.bind(this);
    requestAnimationFrame(this._frame);
  }

  // `level` (career only) replays an ALREADY-CLEARED level from the map. Safe
  // by construction and it always was — the code just had no way to ask:
  //   * careerCfg(n) is pure, so a replay is the identical jar (which is also
  //     what makes a star score fair to compare)
  //   * stars keep the MAX, so a bad replay cannot demote a 3-star
  //   * coins bank on FIRST CLEAR only, so a replay is not a farm
  //   * careerLevel only advances when you clear the level you were ON
  // The clamp is the whole guard: you can never select past what you reached.
  // THE ARCHIVE. A daily playable only on its own day is an APPOINTMENT
  // WINDOW, which the design forbids in the same breath as energy and lives —
  // and it was in the shipped build. dailySeed() is a pure function of the day
  // number, so any past day can be rebuilt exactly; nothing about the jar
  // needed to change.
  //
  // An archive run NEVER SUBMITS and NEVER BANKS, and neither is a taste call:
  //   - the leaderboard RPC stamps `day` from the SERVER clock, so a past-day
  //     score would post as TODAY's and corrupt a board it never belonged to
  //   - `Meta.data.bankedDay` is one value, not a set, so a bankable archive
  //     would be farmable by alternating between two past days forever
  // It DOES update bestDaily, so filling in your archive and beating your own
  // past score is the reason to play one.
  Game.prototype.start = function (seed, mode, level, archiveDay) {
    if (mode === true) mode = 'daily';               // legacy callers
    this.mode = mode || 'free';
    this.isDaily = this.mode === 'daily';
    this.archiveDay = (this.isDaily && archiveDay && archiveDay !== dayNumber())
                    ? archiveDay : null;
    // THE ENTITLEMENT GATE, AND THE ONLY PLACE IT EXISTS.
    //
    // careerCap() is FREE_CAREER_LEVELS on a free save and CAREER_MAX on a
    // bought one, so the purchase decides WHICH LEVELS YOU MAY ENTER and
    // nothing else. It cannot reach the jar: `cc` below is careerCfg(want), a
    // pure function of the level number, so level 7's jar is byte-identical
    // for a buyer and a non-buyer, and the daily never consults it at all.
    // Keep it that way — see the note above Ent.
    var reached = Math.min(careerCap(), Meta.data.careerLevel || 1);
    var want = level ? Math.max(1, Math.min(reached, level | 0)) : reached;
    // clamped: past CAREER_MAX the seeds are unscreened and often unclearable
    var cc = this.mode === 'career' ? careerCfg(want) : null;
    this.career = cc;
    this.day = this.archiveDay || dayNumber();   // bound to the JAR, not the clock at the end
    this.seed = cc ? cc.seed
              : this.archiveDay ? seedForDay(this.archiveDay)
              : ((seed >>> 0) || dailySeed());
    this.goalOrders = cc ? cc.orders : CFG.ordersPerShift;
    this.shiftSwings = cc ? cc.swings : CFG.swings;
    // THE DAILY WEARS THE DAY'S CHARACTER. Free keeps the standard board (it
    // is the earning mode and its economy is what the free sweep gates);
    // career keeps its own. Only the shared day changes shape, which is what
    // makes it a different MODE rather than the same shift with a leaderboard
    // bolted on. Pure function of this.day, so identical for everyone.
    this.dayChar = this.isDaily ? dailyCharacter(this.day) : null;
    this.slotCls = this.dayChar ? this.dayChar.cls.slice() : SLOT_CLS.slice();
    if (cc && !cc.timed) this.slotCls[4] = 'med';
    // milestone 12 widens the bag on FREE digs only — daily AND career stay
    // 7 for everyone (shared seeds must be fair)
    this.bagCap = (this.mode === 'free' && Meta.data.hoardTotal >= 12) ? CFG.bagCap + 1 : CFG.bagCap;
    this.shiftCrusts = 0; this.shiftHearts = 0; this.shiftCombo = 0;
    this.contractsWon = null;
    // ...AND THE CAREER RESULT, which was reset nowhere. It is only ever
    // written in _endShift's career branch, so it outlived its own shift: play
    // career L7, three-star it, then start a FREE dig and lose it, and
    // _checkContracts still read `stars: 3` from the career run two shifts ago
    // and awarded 'Clean sheet' on a failed free shift. The results screen
    // reads it too (`this.careerResult || {won:false}`), so a stale one could
    // paint the career result over a mode that has none.
    this.careerResult = null;
    this.banked = 0;                     // same reason: it is written at the END of a shift
    seedStream(this.seed);               // LANE 2 seeded once, at reset
    var wildHeart = noise01(1, (this.seed ^ 0x4EA48) >>> 0) < 0.35;   // lane-1
    // FREE AND DAILY GET THE VERBS TOO. Lodestone and shale were gated behind
    // careerCfg, so the two mechanics added most recently existed only inside
    // the 40-level ladder — and the modes a player settles into afterwards,
    // which are the ones the economy actually runs on, were the least
    // mechanically interesting jars in the game. A career graduate went
    // BACKWARDS in content.
    //
    // Rates sit at the career mid-ladder values rather than the L16/L24 debut
    // rates: free and daily have no tutorial beat to lean on, and these jars
    // are already harder than L1 on every other dial. Both still ride the same
    // lane-1 salted indices, so the daily stays identical for every player.
    this.jar = cc ? new Jar(this.seed, cc.junk, cc.rare, cc.heart, cc.lode, cc.shale)
                  : new Jar(this.seed, undefined, undefined, wildHeart,
                            CFG.freeLode, CFG.freeShale);
    this.jar.fastForward(2400);          // arrive at a settled pile
    this.worldT = 0;
    this.coins = 0; this.displayCoins = 0;
    this.pops = 0; this.ordersDone = 0; this.hoard = 0;
    this.swings = this.shiftSwings;
    // a purchased deeper pick, armed on the results screen, spends itself into
    // exactly one attempt. NEVER daily — that jar is one budget for everyone.
    // Remember the assist: stars are scored from the swings LEFT at the bell
    // (thresholds 5 and 11), so +8 free swings walks a clear across BOTH tiers.
    // 250c must buy a way past a wall, never a better score on it — stars are
    // the career's only permanent record. See §3q.
    this.pickBonus = 0;
    if (this.pendingPick && cc) {
      this.swings += this.pendingPick;
      this.shiftSwings += this.pendingPick;
      this.pickBonus = this.pendingPick;
    }
    this.pendingPick = 0;
    this.swingsAtGoal = -1;
    this.epilogue = 0; this._epilogueT = 0;
    this._ending = false;
    // The one line that names the goal, the budget AND the failure condition.
    // It was assigned here and nulled fourteen lines below, so it had never
    // rendered in any build. Suppressed on the first run only, where the coach
    // card teaches the same thing one step at a time.
    this.toast = Meta.data.tutorialDone ? {
      text: (this.career ? 'LEVEL ' + this.career.level + ' · ' : '')
            + this.goalOrders + ' orders before the pick wears out',
      until: 4.0,
    } : null;
    // AN INTRO LEVEL NAMES ITS VERB. `cc.intro` has been set since the teach-
    // then-test pass and read by nothing, so L16 held every dial steady to
    // introduce a lodestone it never mentioned and L24 did the same for shale.
    // The level's whole purpose is the one sentence it was not saying. This
    // outranks the generic goal line above — the goal is the same on all forty
    // levels; the verb is why THIS one exists.
    if (cc && cc.intro && Meta.data.tutorialDone) {
      // IT MUST NAME THE RULE THE GAME ACTUALLY RUNS. This described the GRIP —
      // "pins everything under it, lift it off first" — and the grip was
      // deleted outright, because the top-down cover rule made a grip
      // redundant (a stone above you
      // already blocks you by being above you). What a lodestone does now is
      // cost TWO swings, and the only sentence in the game that says so lives in
      // _route's _teach('lode', ...) LONG form — which this line then made
      // unreachable for every career player by marking the verb taught below.
      // So L16, the level whose entire purpose is one sentence, was saying the
      // wrong one and silencing the right one.
      this.toast = cc.intro === 'lode'
        ? { text: 'NEW — LODESTONE: dense striped stone. It takes two swings to break through.', until: 4.6 }
        : { text: 'NEW — SHALE: the cracked slab brings more rock down when you break it.', until: 4.6 };
      if (!Meta.data.taught) Meta.data.taught = {};
      Meta.data.taught[cc.intro] = 1;      // taught here, so the in-jar hint stays short
      Meta.save();
    }
    this.refill = [0, 0, 0, 0, 0];
    this.orders = [];
    for (var s = 0; s < 5; s++) this.orders.push(this._makeOrder(s));
    this.combo = 0;
    this.bag = [];                       // assembled gems (keys, ordered)
    this.bagFlash = 0;
    this.tossFlash = 0; this.tossSlot = -1;
    this.scanUntil = 0; this.scanSlot = 0;
    this.tutStep = Meta.data.tutorialDone ? 3 : 0;
    this.tutClearAt = 0;
    // a tap queued against the PREVIOUS jar must never spend a swing in this one
    this._taps.length = 0;
    this.shakeT = 0;
    this.showSettings = false;
    this.choice = null; this.dragonPulse = 0;
    // cleared with the jar: body ids are reused across shifts, so a stale
    // blame set would ring whatever inherited those ids in the NEXT jar
    this.blame = null;
    this.fliers.length = 0; this.sparks.length = 0; this.bursts.length = 0;
    this.state = 'playing';
    Snd.scene('dig');
  };

  // WHICH complete order gets the satchel, when more than one is complete.
  //
  // The old rule was an ascending slot scan, and SLOT_CLS is
  // ['easy','med','med','big','timed'] — so the 30c card at slot 0 was served
  // before the 150c card at slot 3. Cards SHARE one satchel, so the loser's
  // gems are spent, not merely delayed. Measured over 120 shifts: two or more
  // orders were complete at 12.5% of deliveries and the scan took the cheaper
  // card at 11.7%, misrouting 57.8c per shift, always against the player.
  //
  // But greedy-by-pay is not the fix either, and measuring said so: taking the
  // big card first consumes more gems and can strand a cheap card that taking
  // the cheap one first would ALSO have paid. Pure pay-first raised coins p50
  // 412 -> 439 but dropped the career ladder's minimum margin from 8 swings to
  // 2, because career counts ORDERS, not coins. The ascending scan had been
  // accidentally throughput-friendly.
  //
  // So search the chain rather than guessing a priority: try each complete
  // order, recurse on what the satchel still holds, and keep the sequence
  // worth the most. Bounded hard — at most 5 cards, and depth 4 because the
  // biggest satchel (8) cannot pay more than four 2-gem cards. Ties go to the
  // card expiring soonest so a RUSH is never left to rot.
  function bestDelivery(counts, orders, depth) {
    var best = { pay: 0, first: null };
    if (depth <= 0) return best;
    for (var i = 0; i < orders.length; i++) {
      var o = orders[i];
      if (!o) continue;
      var g, ok = true;
      for (g in o.need) if ((counts[g] || 0) < o.need[g]) { ok = false; break; }
      if (!ok) continue;
      for (g in o.need) counts[g] -= o.need[g];
      orders[i] = null;
      var sub = bestDelivery(counts, orders, depth - 1);
      orders[i] = o;
      for (g in o.need) counts[g] += o.need[g];
      var total = o.pay + sub.pay;
      if (total > best.pay ||
          (total === best.pay && best.first && o.expiresAt < best.first.expiresAt)) {
        best = { pay: total, first: o };
      }
    }
    return best;
  }

  Game.prototype._makeOrder = function (slot) {
    var k = this.refill[slot]++;
    // career: a FIXED seed can starve a required prism — rares stay pure
    // hoard-dilemma bonuses there, never requirements
    var spec = orderSpec(slot, k, this.seed, this.slotCls ? this.slotCls[slot] : null,
                         this.career ? !careerPrismOk(this.career) : false);
    var need = {}, total = {};
    for (var g in spec.need) { need[g] = spec.need[g]; total[g] = spec.need[g]; }
    return {
      slot: slot, cls: spec.cls, need: need, total: total, pay: spec.pay,
      expiresAt: spec.cls === 'timed' ? this.worldT + CFG.timedDur : Infinity,
      flash: 0, dropT: k > 0 ? 1 : 0,
    };
  };

  Game.prototype.setPaused = function (v) {
    if (this.state === 'playing' && v) this.state = 'paused';
    // The settings panel HOLDS the pause. Without this guard the lifecycle
    // callback wins the argument: open settings mid-shift (state -> paused),
    // background the app, come back, and `__game.pause(false)` resumes the sim
    // underneath a panel that is still on screen — the jar runs while the
    // player thinks the game is stopped.
    else if (this.state === 'paused' && !v && !this.showSettings) this.state = 'playing';
  };

  Game.prototype.resize = function () {
    var cw = Math.max(320, window.innerWidth || 0);
    var ch = Math.max(240, window.innerHeight || 0);
    var dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.canvas.width = Math.round(cw * dpr);
    this.canvas.height = Math.round(ch * dpr);
    var scale = Math.min(ch / VIEW_H, cw / VIEW_MIN_W);
    // Notch/Dynamic-Island inset, as a CAMERA shift only: the world's geometry
    // is identical on every device (daily-fairness law); we just draw it lower
    // and un-shift taps. Read from the CSS env() probe.
    var probe = document.getElementById('safe-probe');
    var inset = probe ? probe.getBoundingClientRect().top : 0;
    // THE ISLAND TRAP. native/ios Info.plist hides the status bar, and a hidden
    // status bar reports env(safe-area-inset-top) as 0 — so the probe returns
    // nothing and the HUD rides up under the cutout. Vanus's device screenshot
    // caught it: the swing counter (world x=152) sat directly behind the
    // Dynamic Island. Every notch/island iPhone is >= 2.0 tall-to-wide; the SE
    // family is 1.78, so aspect alone separates them. The floor clears the
    // island's 48pt underside with room to spare. Still draw-side only.
    if (inset < 44 && ch / cw >= 2.0) inset = Math.max(inset, 54);
    // Bottom inset: the home indicator. The counter sits ABOVE it.
    var pb = document.getElementById('safe-probe-bottom');
    var insetBot = pb ? Math.max(0, ch - pb.getBoundingClientRect().bottom) : 0;
    if (insetBot < 20 && ch / cw >= 2.0) insetBot = Math.max(insetBot, 34);
    var uiTop = Math.max(0, inset) / scale;
    this.view = {
      cw: cw, ch: ch, dpr: dpr, scale: scale,
      w: cw / scale, h: ch / scale,
      ox: (cw / scale - VIEW_MIN_W) / 2,   // centre the fixed-width world
      oy: 0,
      uiTop: uiTop,
      // floorY — the deepest DRAWABLE world row, in the same translated frame
      // the HUD draws in. Bottom furniture anchors here instead of to VIEW_H,
      // which is an AUTHORING constant, not the bottom of anybody's phone.
      // Sim-side geometry must never read this (see update(): daily fairness).
      floorY: ch / scale - uiTop - insetBot / scale,
    };
  };

  // Safe-area insets resolve asynchronously in WKWebView: the first read at
  // construction time can legitimately be 0 with no resize event to follow.
  // Re-probe over the first couple of seconds, and whenever the app comes back.
  Game.prototype.watchInsets = function () {
    var self = this, tries = 0;
    var tick = function () {
      var before = self.view.uiTop;
      self.resize();
      if (++tries < 12 && Math.abs(self.view.uiTop - before) < 0.5) setTimeout(tick, 160);
      else if (tries < 12) setTimeout(tick, 160);
    };
    setTimeout(tick, 60);
    document.addEventListener('visibilitychange', function () { self.resize(); });
  };

  Game.prototype.toWorld = function (clientX, clientY) {
    var v = this.view;
    return { x: clientX / v.scale - v.ox, y: clientY / v.scale - v.oy - v.uiTop };
  };

  // Dedupe byte-identical taps within 80ms: some automation/compat layers
  // double-dispatch the first pointer event. Human re-taps differ in coords.
  Game.prototype.tapAt = function (wx, wy) {
    var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    if (this._lastTap && now - this._lastTap.t < 80 &&
        this._lastTap.x === wx && this._lastTap.y === wy) return;
    this._lastTap = { x: wx, y: wy, t: now };
    this._taps.push({ x: wx, y: wy });
  };

  // ---- FIXED-TIMESTEP SIM. Physics + order timers ONLY. No ctx. No Math.random. ----
  Game.prototype.update = function (STEP) {
    this.worldT += STEP;
    this.jar.step(STEP);
    // landing squash: fast fall arrested this step (cosmetic field; sim never
    // reads it, no RNG — deterministic by construction)
    for (var bi = 0; bi < this.jar.bodies.length; bi++) {
      var bb = this.jar.bodies[bi];
      if (bb.lastVy > 260 && bb.vy < 60) bb.squash = Math.min(1, bb.lastVy / 900);
      bb.lastVy = bb.vy;
    }

    // The epilogue is a payout animation, not a play state: a tap landing here
    // used to fall through and spend a swing, driving swings to 0 with leftover
    // epilogue still owed and forfeiting 5c per remaining swing.
    if (this.epilogue > 0) this._taps.length = 0;

    while (this._taps.length) {
      var t = this._taps.shift();
      // a tap that outlived the shift must not score into the next one
      if (this.state !== 'playing') { this._taps.length = 0; break; }
      if (this.choice) {
        // EVERY TARGET COMES FROM choiceRects(), WHICH IS ALSO WHAT DRAWS THEM.
        //
        // The previous pass gave this screen the targets Vanus said were
        // missing ("i dont understand this sell or hoard option and it doesnt
        // let me interact with it") but authored their boxes as literals beside
        // the literals that painted the labels — and the two never matched. The
        // gem's r=60 circle was tested FIRST and swallowed the left half of the
        // HOARD caption, so the word HOARD bagged the gem. See choiceRects().
        //
        // Order still matters, but nothing overlaps now: two plates, then the
        // dragon, then the glowing card, then a dead gutter that eats the tap
        // rather than letting it dig.
        var CR = this.choiceRects();
        if (inRect(t, CR.use))   { this._choiceTapped = true; this._resolveChoice('order'); continue; }
        if (inRect(t, CR.hoard)) { this._choiceTapped = true; this._resolveChoice('hoard'); continue; }
        if (t.x < hoardTapRight() && t.y > VIEW_H - 120) { this._choiceTapped = true; this._resolveChoice('hoard'); continue; }
        if (this.choice.slot >= 0) {
          var ccx = 14 + this.choice.slot * (ORDER_W + 8);
          if (t.x >= ccx && t.x <= ccx + ORDER_W && t.y >= ORDER_Y && t.y <= ORDER_Y + ORDER_H) {
            this._choiceTapped = true; this._resolveChoice('order'); continue;
          }
        }
        // the gutter the gem hovers in: swallow, never resolve. A tap here fell
        // through to the dig path and spent a swing on whatever body happened
        // to sit under the hover — the one place on screen where a miss cost
        // something.
        if (inRect(t, CR.gutter)) continue;
      }
      // Bag slot tap = TOSS that gem. It leaves the game: no swing spent, no
      // coin earned (an undelivered gem earns nothing), ladder reset.
      //
      // It used to do this SILENTLY — no flier, no particle, nothing — which is
      // the only reason it read as broken. Returning the gem to the jar was
      // tried instead and reverted: a poured jar is full to the brim, so it
      // could only take a gem back about nine times in ten and had to toss it
      // the rest of the time. Two outcomes for one tap is worse than one honest
      // outcome, and handing gems back softens the satchel's whole point, which
      // is that committing a slot to the wrong gem costs you. So: always toss,
      // and make the toss unmistakable.
      //
      // The gap between slots routes to the slot on its left rather than
      // rejecting the tap: a 4-unit dead lane between 28-unit targets is a
      // miss the player cannot see or explain.
      if (t.y >= BAG_HIT_TOP && t.y <= BAG_HIT_BOT) {
        var bi2 = Math.floor((t.x - bagSlotX(0)) / (BAG_SLOT + BAG_GAP));
        if (bi2 >= 0 && bi2 < this.bag.length) {
          var dropKey = this.bag[bi2];
          this.bag.splice(bi2, 1);
          this.combo = 0;
          this._tossFromBag(dropKey, bi2);
          continue;
        }
      }
      // order card tap = scan: briefly halo the jar gems that card still needs
      if (t.y >= ORDER_Y && t.y <= ORDER_Y + ORDER_H) {
        var cs2 = Math.floor((t.x - 14) / (ORDER_W + 8));
        if (cs2 >= 0 && cs2 < 5 && t.x - (14 + cs2 * (ORDER_W + 8)) <= ORDER_W) {
          this.scanSlot = cs2;
          this.scanUntil = this.worldT + 1.4;
          continue;
        }
      }
      var b = this.jar.bodyAt(t.x, t.y);
      if (!b) continue;
      if (b.key === 'heartstone') {
        if (!this.jar.exposed(b)) {
          // This used to be byte-identical to tapping a buried pebble, so the
          // one object in the jar that IS "clear the rocks off me first" said
          // nothing at all — and since the solver leaves it 97.2% visible, it
          // does not even look covered. Name the blockers and it becomes a
          // goal instead of a dead tap.
          // NAME THE BLOCKER THAT IS ACTUALLY THERE. The colossus has two
          // refusal reasons and this only ever spoke one of them, so a
          // heartstone held purely by a lodestone printed the sentence
          // "0 rocks still pin the Heartstone" — a count of nothing, offered
          // as an instruction. The old fallback named a lodestone GRIP that
          // has not existed since the cover rule, so it could never fire and
          // could never have been true. A refused tap on an unblocked body is
          // not reachable; if it ever becomes so, say something honest.
          b.wiggle = 1; Snd.thunk();
          var hb = this._heartBlockers(b);
          this.toast = {
            text: hb > 0
              ? hb + (hb === 1 ? ' rock still pins' : ' rocks still pin') + ' the Heartstone'
              : 'Clear the pile off the Heartstone first.',
            until: this.worldT + 2,
          };
          continue;
        }
        b.pry++;
        b.wiggle = 1.4;
        Hap.medium();
        Snd.thunk();
        this.rings.push({ x: b.x, y: b.y, r: b.r, t: 0 });
        this.picks.push({ x: b.x, y: b.y - 20, t: 0, heavy: true, cracked: this.swings <= 5 });
        if (b.pry >= 3) {
          this.jar.extract(b);
          this.pops++;
          this.swings--;
          this.hitStop = 0.22;
          this.shakeT = 0.5;
          Hap.heavy();
          Snd.fanfare(300);
          // CAREER HAS NO SELL, AND MUST NOT DRAW ONE.
          //
          // `_resolveChoice` forced the hoard lane only on an untouched
          // TIMEOUT (`&& !tapped`), so a career player who actually reached
          // for SELL banked 600c — six times at or before L30 (heart levels
          // are n%5===0). `sweep_career --econ` fails the build when income at
          // L30 reaches the shop's 22,000c stock and the headroom is 3,143c,
          // so six sells is 3,600c and a red gate. The bot could never see it:
          // it always gifts. Now that the colossus is reachable this stops
          // being theoretical.
          //
          // Resolving straight to the dragon is also the honest shape: on a
          // replay the plate already said "no coins on a replay", so in career
          // the second plate was either unaffordable or a lie. Free and daily
          // keep the real dilemma.
          if (this.career) { this._resolveChoice('hoard'); }
          else this.choice = { key: 'heartstone', slot: -1, until: this.worldT + CHOICE_SECS, x: b.x, y: b.y };
          if (this.swings <= 0 && this.state === 'playing') this._endShift();
        }
        continue;
      }
      // THE LODESTONE IS A HARD STONE NOW: two swings, not one.
      //
      // Its old job was to GRIP its neighbours, and the cover rule made that
      // job vanish — a stone above you already blocks you by being above you,
      // so a grip could only ever add blocking for a stone at the same height,
      // which is not a rule a player could see. Rather than delete the verb,
      // give it the one that means something while you are digging DOWNWARD: a
      // seam of stone that does not come out on the first hit. Same art, same
      // rarity, legible without a word of UI, and it costs the player exactly
      // what a blocker should cost — a swing.
      //
      // Checked BEFORE extract so the first hit cannot remove it, and only
      // when the body is actually diggable, so a covered lodestone still
      // refuses without eating the swing.
      if (b.lode && this.jar.exposed(b) && (b.hits || 0) < 1) {
        b.hits = 1;
        b.wiggle = 1.2;
        this.swings--;
        Hap.medium();
        Snd.thunk();
        this._rockChips(b.x, b.y);
        this.picks.push({ x: b.x, y: b.y, t: 0, heavy: true, cracked: this.swings <= 5 });
        this.toast = this._teach('lode',
          'LODESTONE — dense stone. It takes two swings to break through.',
          'The lodestone cracks — one more swing.');
        if (this.swings <= 0 && this.state === 'playing') this._endShift();
        continue;
      }
      if (this.jar.extract(b)) {
        this.pops++;
        this.swings--;
        if (this.swings === 5) Snd.expire();     // gentle "pick is wearing" cue
        Snd.pop();
        Hap.light();
        this.rings.push({ x: b.x, y: b.y, r: b.r, t: 0 });
        var isRock = b.key.indexOf('rock') === 0;
        this.picks.push({ x: b.x, y: b.y, t: 0, heavy: isRock, cracked: this.swings <= 5 });
        if (isRock) this._rockChips(b.x, b.y);
        this._route(b);
        if (this.swings <= 0 && this.state === 'playing') this._endShift();
      } else {
        b.wiggle = 1;                    // read by draw only; decays in _cosmetic
        Snd.thunk();
        // POINT AT WHAT IS HOLDING IT. Cosmetic-only state: draw reads it,
        // update never does, no RNG, so two players on the same jar still
        // diverge in nothing that matters.
        // TEACH IT, THEN GET OUT OF THE WAY.
        //
        // Shipped as a full-strength cue on EVERY refused tap, forever, and
        // Vanus's next words were "why are there circles now around rocks and
        // gems". Of course: a player probing the pile refuses several taps a
        // minute, each painting up to five hard amber circles for 1.9s, so the
        // teaching cue became permanent furniture. The lesson only needs
        // teaching once — after that the player knows what a refused tap
        // means, and the rings are answering a question they have stopped
        // asking.
        //
        // First six refusals ever: the full 1.9s cue. After that a brief, dim
        // version — the information stays available for the moment you DO want
        // it, at a fifth of the ink.
        var seen = (Meta.data.taught && Meta.data.taught.blocked) || 0;
        if (seen < 6) {
          if (!Meta.data.taught) Meta.data.taught = {};
          Meta.data.taught.blocked = seen + 1;
          Meta.save();
        }
        var loud = seen < 6;
        // THREE, not the whole column — see blockersOf. The cue has to name a
        // next action, and "lift these three off" is one.
        var blk = this.jar.blockersOf(b, 3);
        // 1.9s, not the 1.15s this started at. This is a TEACHING cue, not a
        // hit-flash: the player has to look away from where their finger was,
        // find the ringed bodies, and connect them to the gem they wanted.
        // Tested on the simulator at device scale — a cue this carries has to
        // outlast the glance that finds it.
        this.blame = { until: this.worldT + (loud ? 1.9 : 0.75), loud: loud,
                       ids: {}, tid: b.id, x: b.x, y: b.y, r: b.r };
        for (var qi = 0; qi < blk.length; qi++) this.blame.ids[blk[qi].id] = 1;
        // Say WHY, when the reason is the new rule rather than the obvious
        // one. "Something is on top of it" is legible from the pile; "a
        // lodestone is holding it" is not, and a refused tap the player cannot
        // explain reads as a bug. Only fires when nothing is stacked above, so
        // it never argues with what the player can already see.
        //
        // THE FIRST TIME, TEACH IT. Everything after that is a reminder. A
        // player meeting the lodestone for the first time does not need the
        // instruction, they need the RULE — otherwise "dig that out first"
        // reads as the game blaming them for a tap it never explained.

      }
    }

    if (this.epilogue > 0) {
      // THE EPILOGUE OWNS THE STAGE, INCLUDING AN OPEN CHOICE.
      //
      // Taps are discarded above (the epilogue is a payout animation, not a
      // play state) and this block returns before the timeout check below — so
      // a prism dug on the swing that finished the last order used to FREEZE
      // mid-air with a full clock for the whole rain of coins, and then be
      // resolved blind by _endShift into a satchel nobody was going to deliver.
      // Resolve it here, the moment the stage changes, and resolve it the way
      // that is actually worth something.
      if (this.choice) this._resolveChoice(this._choicePays() ? 'order' : 'hoard');
      this._epilogueT += STEP;
      if (this._epilogueT >= 0.15) {
        this._epilogueT = 0;
        this.epilogue--;
        this.swings--;
        this.coins += CFG.epilogueCoin;
        Snd.fill(this.goalOrders + (this.epilogue % 8));
        this._celebrate(this.orders[this.epilogue % 5]);
        if (this.epilogue <= 0) this._endShift();
      }
      return;                            // the epilogue owns the stage
    }
    if (this.choice && this.worldT > this.choice.until) this._resolveChoice('order');
    if (this.tutStep === 2 && this.worldT > this.tutClearAt) {
      this.tutStep = 3;
      Meta.data.tutorialDone = true;
      Meta.save();
    }

    // timed orders expire on the SIM clock
    for (var s = 0; s < 5; s++) {
      var o = this.orders[s];
      if (this.worldT > o.expiresAt) {
        this.orders[s] = this._makeOrder(s);
        this.orders[s].dropT = 0.001;      // the new card drops in — a visible swap
        // SAY WHAT ACTUALLY HAPPENED. This read "RUSH ORDER LOST — 90c gone",
        // and 90c did not go anywhere: the slot immediately re-deals another
        // timed card at the same price on a fresh clock, no swing is spent and
        // no order is deducted from the goal. Over 250 shifts the toast
        // claimed 16,020c of losses that never occurred. The real cost is the
        // ladder — combo resets, so the fill run and its rising pitch restart
        // — plus the swings already spent toward that card's gems, and those
        // are worth naming honestly. Pillar 2 forbids manufacturing a loss;
        // announcing one that did not happen is the same lie the PACE line was
        // telling in the other direction.
        this.combo = 0;
        this.toast = { text: 'RUSH EXPIRED — new card, ladder reset',
                       until: this.worldT + 2.2 };
        Snd.orderLost();
      }
    }

    // restock pour when the jar runs dry (batch content is lane-1 positional:
    // WHEN you trigger it is your play; WHAT pours is the same for everyone)
    //
    // A STARVATION RESCUE WAS TRIED HERE AND REVERTED — it made things worse,
    // and the reason is worth keeping. `fill()` measures AREA, so a jar can sit
    // at its target and hold nothing an order wants in reach; every reachable
    // body is rock and the restock never fires. The obvious answer is to pour
    // anyway when nothing wanted is reachable. Measured over 500 shared daily
    // boards: dead boards went 1 -> 3. `pour()` drops bodies at the TOP of the
    // jar, so an emergency batch onto an already-full pile BURIES the few
    // useful gems that were reachable. The rescue caused the condition it was
    // written to relieve.
    //
    // What is left is the dial pair, searched over 500 days rather than the
    // 120 the first attempt was fitted to — see CFG.junkRatio / restockBelow.
    var rsb = this.career ? this.career.restockBelow : CFG.restockBelow;
    if (this.jar.fill() < rsb && this.ordersDone < this.goalOrders) {
      this.jar.pour(CFG.fillTarget);
      Snd.pour();
    }
  };

  // Route an extracted body. Gems ASSEMBLE in the satchel; an order pays only
  // when its full requirement is present (then the set flies out together).
  // This is the per-tap tension engine: spam jams the bag in bagCap taps, so
  // reading the cards is load-bearing (probed: 34.6% blind penalty vs 21%
  // for instant auto-routing — docs/PROBE-FINDINGS.md).
  Game.prototype._route = function (b) {
    var key = b.key;
    if (key.indexOf('rock') === 0) {
      if (b.geode) {
        // THE CRUSTED GEM cracks open and its gems go STRAIGHT INTO THE
        // SATCHEL.
        //
        // They used to tumble back into the pile as live bodies, which meant
        // each one still had to be dug out for its own swing: 3 swings for 2
        // gems, against 1.0 for digging an exposed gem directly. A crust was
        // therefore a WORSE rock — strictly dominated — so making its tell
        // visible would only have advertised a bad deal. Into the bag it is 1
        // swing for 2 gems, the best rate in the game, which is what makes
        // reading the new tell worth doing.
        //
        // Bag room is the cost, and that is the decision: cracking a crust
        // with one slot free jams the satchel exactly like over-digging does.
        // Overflow falls into the pile on the OLD path rather than being
        // destroyed, so a full bag degrades instead of eating the gems.
        var got = 0;
        for (var gi = 0; gi < b.geode.length; gi++) {
          var gk = b.geode[gi];
          var gt = TYPE[gk];
          if (this.bag.length < this.bagCap) {
            this.bag.push(gk);
            this._bumpCombo();
            got++;
            this._fly({ x: b.x, y: b.y, key: gk, r: gt.r }, 'bag', this.bag.length - 1);
          } else {
            this.jar.bodies.push({
              id: this.jar.nextId++, key: gk, r: gt.r, geode: null,
              x: b.x + (gi === 0 ? -8 : 8), y: b.y - 4,
              px: b.x, py: b.y,
              vx: (gi === 0 ? -1 : 1) * 90, vy: -160,
              rest: 0, asleep: false,
            });
          }
        }
        bump('crusts');
        this.shiftCrusts = (this.shiftCrusts || 0) + 1;
        this.hitStop = 0.06;
        this.shakeT = Math.max(this.shakeT, 0.18);
        Hap.medium();
        Snd.fanfare(60);
        this.toast = {
          text: got === 2 ? 'CRACKED IT! Two gems straight to the bag!'
              : got === 1 ? 'CRACKED IT! Bag full — one rolled back in.'
              : 'CRACKED IT! Bag full — they rolled back in.',
          until: this.worldT + 2,
        };
        this._burst(b.x, b.y, 12, 260, 240, 2, 2.5, 0.7, '#ffe9a8');
        if (this.tutStep === 0 && got) this.tutStep = 1;
        if (got) { Snd.fill(this.combo); this._checkDeliveries(); }
        return;
      }
      // SHALE (L24+) — the pile fights back.
      //
      // Ordinary junk is free to clear: it costs a swing and pays a coin, so
      // the only question is whether the swing was worth more elsewhere. Shale
      // makes clearing itself a cost — pulling a slab out brings more rock
      // down on top of what you were digging toward, so a shale rock in front
      // of a gem is a genuine "is it worth it" decision rather than a chore.
      //
      // The collapse pours from the CURRENT batch, so its content is lane-1
      // like any other pour and cannot fork between players. It is capped at
      // three bodies and only fires when the jar has headroom — dropping rock
      // into a full jar is how you get an eternal boil.
      if (b.shale) {
        this.coins += 1;
        this._fly(b, 'scrap');
        var room = this.jar.fill() < CFG.fillTarget - 0.04;
        if (room) {
          // POSITIONAL, LIKE EVERY OTHER LANE-1 DRAW. This used to read
          // `this.jar.batches++` — the counter pour() draws from — so every
          // shale dig silently advanced the restock stream and the NEXT pour
          // delivered a different batch than it would have. The restock comment
          // two hundred lines up promises the opposite ("WHEN you trigger it is
          // your play; WHAT pours is the same for everyone"), and that was only
          // true for a player who never touched a shale rock.
          //
          // A private COUNTER fixes that but is still order-dependent: two
          // players who dig the same two slabs in opposite orders get different
          // rubble. Keying on the slab itself makes the collapse a pure
          // function of which rock you broke — the same rule §3a already
          // demands of jar packing and order refills.
          //
          // IT MUST BE THE POUR COORDINATES, NOT `b.id`. This read
          // `100000 + b.id` and called itself positional; `id` is
          // `jar.nextId++`, a single creation counter that two PLAYER-PACED
          // sites advance — the crusted-rock overflow push (fires only when the
          // satchel happens to be full, and costs no swing) and this collapse's
          // own rubble. So every body created after either event carries an id
          // offset by that player's history, and two players could hold
          // byte-identical jars, break the same slab, and bring down different
          // rock. On a shared daily seed that is a fork, which is the one thing
          // lane 1 exists to make impossible. (pb, pi) is stamped at pour time
          // and is the same pair on every device.
          //
          // The 100000 offset keeps these indices clear of every pour batch a
          // shift can reach (batches count up from 0), and pi < pourMax keeps
          // one batch's slabs from colliding with the next batch's.
          var bt = 100000 + (b.pb || 0) * CFG.pourMax + (b.pi || 0);
          for (var si = 0; si < 3; si++) {
            var sp = jarBodySpec(si, bt, this.jar.seed, 1, 0, 0, 0);  // junk=1: rock
            this.jar.bodies.push({
              id: this.jar.nextId++, key: sp.key, r: sp.r, geode: null,
              lode: false, shale: false,
              x: sp.x, y: JAR.top - 30 - si * 40, px: sp.x, py: JAR.top - 30 - si * 40,
              vx: 0, vy: 40, rest: 0, asleep: false,
            });
          }
          this.shakeT = Math.max(this.shakeT, 0.22);
          Hap.medium();
          Snd.thunk();
          this.toast = this._teach('shale',
            'SHALE — the cracked slab brings more rock down. Clearing it is not free.',
            'The shale gives way — more rock!');
        } else {
          Snd.scrap();
        }
        return;
      }
      this.coins += 1;
      this._fly(b, 'scrap');
      Snd.scrap();
      return;
    }
    // A RARE NEVER FALLS THROUGH TO THE JAM PATH.
    //
    // The guard was `rare && !this.choice`, so a prism dug while an EARLIER
    // hover-choice was still open skipped this whole branch and landed in the
    // bag-full scrap below — destroyed for nothing, the one outcome the
    // sell-vs-hoard design explicitly forbids ("a payout is never silently
    // stolen"). One hover-choice at a time is still correct; the answer for
    // the second rare is to give it to the dragon, which is the resolution
    // that cannot lose the player anything.
    if (TYPE[key].rare) {
      if (this.choice) { this._gainHoard(b); return; }
      var wanted = false;
      for (var s = 0; s < 5; s++) if ((this.orders[s].need[key] || 0) > 0) wanted = true;
      if (wanted && this.bag.length < this.bagCap) {
        // the dilemma: an order wants this prism, the dragon wants it forever.
        // Tap the card to bag it, the dragon to hoard; timeout bags it (a
        // payout is never silently stolen).
        var bslot = null;
        for (var s2 = 0; s2 < 5; s2++) if ((this.orders[s2].need[key] || 0) > 0) { bslot = s2; break; }
        this.choice = { key: key, slot: bslot, until: this.worldT + CHOICE_SECS, x: b.x, y: b.y };
        Snd.hoard();
        return;
      }
      // SAY WHAT JUST HAPPENED, ONCE. A prism no card wants flies to the
      // dragon and +1's a counter, and _gainHoard only ever speaks on a
      // MILESTONE — so the common case is silent. Vanus, at 421 hoard: "those
      // white gems i dont know the point of them either or if they are special
      // but they usually arent part of an order". Both halves are true: they
      // ARE special, they usually are NOT on a card, and nothing ever said so.
      // Kept to the first one ever, because this fires ~4 times a shift.
      var priorToast = this.toast;
      this._gainHoard(b);
      if (!(Meta.data.taught && Meta.data.taught.prism)) {
        if (!Meta.data.taught) Meta.data.taught = {};
        Meta.data.taught.prism = 1;
        Meta.save();
        // never stomp a milestone announcement — that one is rarer and louder
        if (this.toast === priorToast) {
          this.toast = { text: 'PRISM — no card wants it, so Hoardling keeps it. The hoard is your collection.',
                         until: this.worldT + 3.6 };
        }
      }
      return;
    }
    if (this.bag.length >= this.bagCap) {
      // bag jammed: the gem is LOST and the ladder resets — a gem not
      // delivered earns nothing (sweep: this is what keeps spam beaten)
      this.combo = 0;
      this.bagFlash = 1;
      this._fly(b, 'scrap');
      Snd.thunk();
      return;
    }
    this.bag.push(key);
    this._bumpCombo();
    if (this.tutStep === 0) this.tutStep = 1;
    this._fly(b, 'bag', this.bag.length - 1);
    // A GREAT STONE BREAKS INTO THREE CUT GEMS.
    //
    // Same payout shape as the crusted rock — one swing, several gems,
    // several satchel slots — and deliberately so: the crust is the best rate
    // in the game and it was the ONLY thing in the jar that paid like that.
    // The difference is that a crust is a surprise inside a rock and this is a
    // prize you can see from across the jar, so it is a decision rather than a
    // reward: three slots of a seven-slot satchel is most of your working room.
    //
    // Overflow rolls back into the pile on the crust's own degrade path rather
    // than being destroyed — and at GREAT_R, not TYPE[key].r, or the gem
    // visibly shrinks as it falls back in.
    if (b.great) {
      for (var gq = 1; gq < GREAT_YIELD; gq++) {
        if (this.bag.length < this.bagCap) {
          this.bag.push(key);
          this._bumpCombo();
          this._fly(b, 'bag', this.bag.length - 1);
        } else {
          this.jar.bodies.push({
            id: this.jar.nextId++, key: key, r: TYPE[key].r, geode: null,
            lode: false, shale: false, great: false,
            x: b.x + (gq === 1 ? -9 : 9), y: b.y - 4, px: b.x, py: b.y,
            vx: (gq === 1 ? -1 : 1) * 95, vy: -165,
            rest: 0, asleep: false,
          });
        }
      }
      this.hitStop = 0.06;
      this.shakeT = Math.max(this.shakeT, 0.16);
      Hap.medium();
      this.toast = { text: this.bag.length >= this.bagCap
        ? 'A GREAT ' + key.toUpperCase() + '! Bag full — the rest rolled back in.'
        : 'A GREAT ' + key.toUpperCase() + '! Three gems from one swing.',
        until: this.worldT + 2 };
      this._burst(b.x, b.y, 14, 250, 235, 2, 2.6, 0.7, TYPE[key].hi);
    }
    Snd.fill(this.combo);                // ladder climbs the LIVE music chord
    this._checkDeliveries();
  };

  // How many bodies are currently sitting ON the Heartstone — the same
  // overlap test exposed() uses, counted instead of short-circuited. Read-only
  // and called on a refused tap, so it costs one O(n) pass per blocked tap.
  //
  // IT MUST READ `COVER_X`, NOT A COPY OF ITS VALUE. This is the second copy
  // of exposed()'s test, and when the cone last moved the literal here did not
  // move with it — so the toast counted rocks that no longer blocked anything
  // (2.52 reported against 1.82 real across 21,478 refused heartstone taps).
  // The comment above claiming "the same overlap test" is the invariant; a
  // literal cannot hold it.
  Game.prototype._heartBlockers = function (b) {
    var bs = this.jar.bodies, n = 0;
    for (var i = 0; i < bs.length; i++) {
      var o = bs[i];
      if (o === b || o.y >= b.y) continue;
      var dx = o.x - b.x;
      if (dx < 0) dx = -dx;
      if (dx < (o.r + b.r) * COVER_X) n++;
    }
    return n;
  };

  // ONE-SHOT VERB TEACHING. Returns the toast to show: the long form the first
  // time this player ever meets the verb, the short reminder every time after.
  //
  // Persisted in Meta rather than per-shift, because meeting the lodestone for
  // the first time in shift forty is still the first time. Held on the LONG
  // form for 3.4s against the reminder's 2s — a rule takes longer to read than
  // an instruction. Writes at most twice per save, so the save cost is nil.
  //
  // This is what careerCfg's `intro` flag was supposed to drive and never did:
  // it is set at game.js:405 and read by nothing, so L16 and L24 hold their
  // dials for a verb they never name, and free and daily — which now pour both
  // verbs — had no teaching beat at all.
  Game.prototype._teach = function (verb, long, short) {
    var first = !(Meta.data.taught && Meta.data.taught[verb]);
    if (first) {
      if (!Meta.data.taught) Meta.data.taught = {};
      Meta.data.taught[verb] = 1;
      Meta.save();
    }
    return { text: first ? long : short, until: this.worldT + (first ? 3.4 : 2) };
  };

  // GEM SYMBOLS — the second identity channel, drawn only when Meta.data.marks
  // is on. One shape per ORDER gem, at the gem's centre, sized to the body so
  // it works at 13px on an order card and at r15-22 in the jar.
  //
  // Deliberately geometric and few-sided: at 13 CSS px a glyph has about 8x8
  // usable pixels, so anything with fine detail becomes a smudge. Drawn as a
  // dark outline under a cream fill so it survives on both a pale amber and a
  // dark sapphire without a per-gem colour table.
  //
  //   ruby      diamond      emerald   bar (the emerald cut)
  //   sapphire  circle       amber     triangle
  //   prism     four-point star
  //
  // Rocks and the heartstone get nothing: they are never an order requirement,
  // so they are never the thing being matched.
  var GEM_MARK = { ruby: 'diamond', emerald: 'bar', sapphire: 'circle',
                   amber: 'tri', prism: 'star' };
  function gemMark(ctx, key, x, y, s) {
    var m = GEM_MARK[key];
    if (!m) return;
    ctx.save();
    ctx.beginPath();
    if (m === 'diamond') {
      ctx.moveTo(x, y - s); ctx.lineTo(x + s, y); ctx.lineTo(x, y + s); ctx.lineTo(x - s, y);
    } else if (m === 'bar') {
      ctx.rect(x - s, y - s * 0.42, s * 2, s * 0.84);
    } else if (m === 'circle') {
      ctx.arc(x, y, s * 0.82, 0, 6.283);
    } else if (m === 'tri') {
      ctx.moveTo(x, y - s); ctx.lineTo(x + s * 0.92, y + s * 0.72); ctx.lineTo(x - s * 0.92, y + s * 0.72);
    } else {
      for (var i = 0; i < 8; i++) {
        var a = i * 0.7854 - 1.5708, rr = (i % 2 ? s * 0.40 : s);
        ctx[i ? 'lineTo' : 'moveTo'](x + Math.cos(a) * rr, y + Math.sin(a) * rr);
      }
    }
    ctx.closePath();
    ctx.strokeStyle = 'rgba(18,10,4,0.78)';
    ctx.lineWidth = Math.max(1.5, s * 0.42);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,250,238,0.94)';
    ctx.fill();
    ctx.restore();
  }

  Game.prototype._bagCount = function (key) {
    var n = 0;
    for (var i = 0; i < this.bag.length; i++) if (this.bag[i] === key) n++;
    return n;
  };

  // Deliver every order whose FULL need the bag now covers (slot order, then
  // re-scan — removing gems can un-cover a later order; deterministic).
  // WOULD RESOLVING THIS CHOICE INTO THE SATCHEL ACTUALLY PAY, RIGHT NOW?
  //
  // During play the answer does not matter — a bagged prism can still be
  // delivered on a later swing, which is why the ordinary 4-and-a-bit-second
  // timeout bags it ("a payout is never silently stolen"). It matters at the
  // two moments where there IS no later swing: the epilogue, and _endShift.
  // There, 'order' drops the gem into a satchel that is about to be thrown
  // away, while the dragon's +1 is permanent — so the default has to know the
  // difference instead of always guessing 'order'.
  //
  // The heartstone is not a satchel gem: its 'order' branch SELLS for real
  // coins, so it always pays. (Career on an already-starred level banks
  // nothing, and _resolveChoice's own untouched-timeout rule already sends
  // that one to the dragon.)
  Game.prototype._choicePays = function () {
    var c = this.choice;
    if (!c) return false;
    if (c.key === 'heartstone') return true;
    if (this.bag.length >= this.bagCap) return false;
    var counts = {};
    for (var i = 0; i < this.bag.length; i++) counts[this.bag[i]] = (counts[this.bag[i]] || 0) + 1;
    counts[c.key] = (counts[c.key] || 0) + 1;
    return bestDelivery(counts, this.orders.slice(), 4).pay > 0;
  };

  Game.prototype._checkDeliveries = function () {
    var again = true;
    while (again) {
      again = false;
      var counts = {};
      for (var bi = 0; bi < this.bag.length; bi++) {
        counts[this.bag[bi]] = (counts[this.bag[bi]] || 0) + 1;
      }
      var pick = bestDelivery(counts, this.orders.slice(), 4).first;
      if (pick) {
        var o = pick;
        var s = pick.slot;
        for (var g2 in o.need) {
          for (var n = 0; n < o.need[g2]; n++) {
            var idx = this.bag.indexOf(g2);
            this.bag.splice(idx, 1);
            this._flyBagToCard(idx, g2, s);
          }
        }
        this._deliver(o);
        // loop again: one satchel can complete a second card once the first
        // card's gems are gone. (This used to `break` the FOR scan; with the
        // scan hoisted out, a break here would exit the WHILE and drop the
        // chained delivery entirely.)
        again = this.ordersDone < this.goalOrders;
      }
    }
  };

  // ONE chain counter, THREE places that grow it.
  //
  // Only the satchel push kept the records; the crusted-rock overflow and the
  // dilemma's USE IT branch did a bare `this.combo++`, so a chain built through
  // either of them counted for the pitch ladder and for nothing else. The two
  // chain contracts read shiftCombo and the records screen reads bestCombo, so
  // the longest run a player ever made could be a number the game never saw —
  // and a 15-chain that happened to pass through one crust reported as
  // whatever it was before the crust.
  Game.prototype._bumpCombo = function () {
    this.combo++;
    if (this.combo > stats().bestCombo) stats().bestCombo = this.combo;
    if (this.combo > (this.shiftCombo || 0)) this.shiftCombo = this.combo;
  };

  Game.prototype._gainHoard = function (from) {
    this.hoard++;
    Meta.data.hoardTotal++;
    Meta.save();
    this._fly(from, 'hoard');
    Snd.hoard();
    // THE DRAGON HAS TO ANSWER, not only on a milestone.
    //
    // A hoard used to be a flier and a coo — and the coo is the SAME tone that
    // plays when the choice opens, so the confirmation was a sound the player
    // had already heard two seconds earlier while nothing on the ledge moved.
    // Only the milestone branch below ever pulsed him, and past hoard 20 a
    // milestone is one gem in fifteen. Vanus at hoard 423: "when you try to
    // hoard, it doesn't actually go to the dragon below" — the tap was landing
    // wrong (see choiceRects), and on the runs where it landed right, nothing
    // said so. He bounces and throws a few violet sparks now, every time; the
    // milestone keeps its heavier haptic, its fanfare and its bigger burst.
    this.dragonPulse = 1;
    Hap.light();
    this._burst(0, 0, 8, 220, 190, 1.4, 2.4, 0.7, '#e8c9ff', 'ledge');
    var hit = null;
    for (var m = 0; m < MILESTONES.length; m++) {
      if (Meta.data.hoardTotal === MILESTONES[m].n) hit = MILESTONES[m].label;
    }
    // Past 20 the named list is exhausted, so ranks take over and repeat
    // forever — a hoard that keeps growing keeps being answered.
    if (!hit) {
      var rk = hoardRank(Meta.data.hoardTotal);
      if (rk && rk.at === Meta.data.hoardTotal) {
        // NAME THE SKIN. A rank unlocks a Hoardling colour, and the wardrobe
        // said so only if the player happened to open the shop's second tab —
        // so the reward for the game's deepest currency arrived in silence.
        // A full 40-level career yields ~27 hoard, which is ONE rank, so most
        // players would have met this at most once and never known.
        var sk = null;
        for (var di = 0; di < DRAGON_SKINS.length; di++) {
          if (DRAGON_SKINS[di].rank === rk.idx) { sk = DRAGON_SKINS[di]; break; }
        }
        hit = sk ? rk.name + '! ' + sk.name + ' unlocked' : rk.name + '!';
      }
    }
    if (hit) {
      Hap.heavy();
      this.dragonPulse = 1;
      this.toast = { text: hit, until: this.worldT + 3.2 };
      Snd.fanfare(150);
      // burst over the ledge. _counter is a DRAW-side cache; it is read here
      // only to place decoration, and the authored value covers the frame
      // before the first draw. No scored value depends on it.
      this._burst(0, 0, 26, 300, 280, 2, 3, 0.9, '#e8c9ff', 'ledge');
    }
  };

  // resolve the hover-choice: 'order' (into the bag) or 'hoard'. The orders
  // or the bag may have changed — if nothing wants it or the bag is jammed,
  // the dragon wins by default (never scrap a rare).
  Game.prototype._resolveChoice = function (dest) {
    var c = this.choice;
    if (!c) return;
    this.choice = null;
    var tapped = !!this._choiceTapped;
    this._choiceTapped = false;
    if (c.key === 'heartstone') {
      bump('hearts');
      this.shiftHearts = (this.shiftHearts || 0) + 1;
      var hFrom = { x: VIEW_MIN_W / 2, y: JAR.top + 48, r: 34, key: 'gem_prism_big' };
      // career banks no coins, so an untouched timeout must not "sell" the
      // colossus into nothing — the dragon takes it
      if (this.career) dest = 'hoard';       // career banks no colossus coins — see the pry
      if (dest === 'hoard') {
        // PRICED AGAINST WHAT IT COSTS. The 46.3-swing figure this comment
        // used to quote was measured BEFORE the top-down cover rule
        // (bc82081); against that rule the true cost was unbounded — 0 of 120
        // jars reached at any budget up to 800 swings — so the payout was
        // tripled on the strength of a number the game had already invalidated.
        // With the colossus poured into the pile rather than under it, reach +
        // pry costs 9-15 swings against 18.2 leftover, so it is spent out of
        // slack rather than traded against orders. Say that plainly: this is
        // "the headline object becomes obtainable", not "a hard decision".
        //
        // Cosmetic by construction, so this carries no fairness constraint:
        // hoard buys ranks and dragon growth, never swings, bag slots or jar
        // content.
        this.hoard += HEART_GIFT;            // the dragon's crown jewel
        Meta.data.hoardTotal += HEART_GIFT;
        Meta.save();
        this._fly({ x: hFrom.x, y: hFrom.y, r: 34, key: 'prism' }, 'hoard');
        this.dragonPulse = 1;
        Hap.heavy();
        Snd.hoard();
        this.toast = { text: 'Hoardling is OVERJOYED! +' + HEART_GIFT + ' hoard',
                       until: this.worldT + 3 };
      } else {
        this.coins += HEART_SELL;
        this._fly({ x: hFrom.x, y: hFrom.y, r: 34, key: 'prism' }, 'scrap');
        Snd.fanfare(300);
        this.toast = { text: 'The Heartstone sells for ' + HEART_SELL + 'c!',
                       until: this.worldT + 3 };
      }
      return;
    }
    var from = { x: VIEW_MIN_W / 2, y: JAR.top + 48, r: 22, key: c.key };
    var stillWanted = false;
    for (var s = 0; s < 5; s++) if ((this.orders[s].need[c.key] || 0) > 0) stillWanted = true;
    if (dest === 'order' && stillWanted && this.bag.length < this.bagCap) {
      this.bag.push(c.key);
      this._bumpCombo();
      this._fly(from, 'bag', this.bag.length - 1);
      Snd.fill(this.combo);
      this._checkDeliveries();
    } else {
      this._gainHoard(from);
    }
  };

  Game.prototype._deliver = function (o) {
    this.coins += o.pay;
    this.ordersDone++;
    var gsum = 0;
    for (var gk in o.need) gsum += o.need[gk];
    bump('gems', gsum);
    o.flash = 1;
    if (this.tutStep === 1) { this.tutStep = 2; this.tutClearAt = this.worldT + 4; }
    if (o.pay >= 150) this.shakeT = 0.4;   // tier-3 deliveries rock the shop
    this.hitStop = o.pay >= 150 ? 0.13 : 0.07;   // the beat that sells the hit
    Hap.medium();
    Snd.fanfare(o.pay);                  // tier scales with REAL payout only
    this._celebrate(o);
    if (this.ordersDone >= this.goalOrders) {
      if (this.swingsAtGoal < 0) this.swingsAtGoal = this.swings;
      if (this.swings > 0 && this.epilogue === 0) {
        this.epilogue = this.swings;     // leftover swings rain down as coins
        this.toast = { text: 'PERFECT SHIFT! Leftover swings pay out!', until: this.worldT + 3 };
        Snd.perfect();
        return;
      }
      // a late delivery (a choice resolving on its timeout) must not cut the
      // payout short — the epilogue loop ends the shift when it drains
      if (this.epilogue > 0) return;
      this._endShift();
      return;
    }
    this.orders[o.slot] = this._makeOrder(o.slot);
  };

  // Evaluate every unclaimed contract against this shift and the lifetime
  // counters. One-shot: a contract that fires is recorded and never pays
  // again. Deliberately runs AFTER the lifetime stats are updated so a
  // contract like "work 10 shifts" can close on the shift that reaches 10.
  Game.prototype._checkContracts = function () {
    var done = contractsDone(), L = stats(), won = [];
    var ctx = {
      L: L, M: Meta.data,
      s: {
        coins: this.coins,
        done: this.ordersDone,
        goal: this.goalOrders,
        // SWINGS AT THE BELL, not swings on the clock.
        //
        // This read `this.swings`, and the only way to satisfy `done >= goal`
        // is to fill the last order — which sets `epilogue = swings` and then
        // decrements BOTH in lockstep until epilogue hits 0. So `left` was
        // exactly 0 on every finished shift in every mode, and 'Room to spare'
        // (20 left, 3 hoard) and 'Barely broke a sweat' (30 left, 5 hoard) were
        // unwinnable by construction while the jobs board counted them in its
        // completion total. swingsAtGoal is the number the star scorer already
        // uses for the same question, and the bought pick is subtracted for the
        // same reason it is there: 250c may not mint a contract either.
        left: this.swingsAtGoal >= 0
              ? Math.max(0, this.swingsAtGoal - (this.pickBonus || 0)) : 0,
        crusts: this.shiftCrusts || 0,
        hearts: this.shiftHearts || 0,
        combo: this.shiftCombo || 0,
        stars: (this.careerResult && this.careerResult.stars) || 0,
      },
    };
    for (var i = 0; i < CONTRACTS.length; i++) {
      var c = CONTRACTS[i];
      if (done[c.id]) continue;
      var ok = false;
      try { ok = !!c.t(ctx); } catch (e) { ok = false; }
      if (!ok) continue;
      done[c.id] = 1;
      Meta.data.hoardTotal = (Meta.data.hoardTotal || 0) + c.h;
      this.hoard += c.h;
      won.push(c);
    }
    if (won.length) {
      Meta.save();
      this.contractsWon = won;          // the results screen names them
    }
  };

  Game.prototype._endShift = function () {
    if (this.state !== 'playing' || this._ending) return;
    // A prism or Heartstone dug on the LAST swing opens its hover-choice on the
    // very tick the shift ends. update() stops running at 'results', so the
    // choice never resolves and 200c or +4 permanent hoard evaporate. Resolve it
    // here on its own timeout default, BEFORE the coins are read into the
    // leaderboard payload. _resolveChoice can re-enter through
    // _checkDeliveries -> _deliver -> _endShift; the sentinel makes that a no-op.
    this._ending = true;
    // ...and it must resolve the way that PAYS. 'order' drops the gem into a
    // satchel that is discarded one line below; the dragon's +1 is forever.
    if (this.choice) this._resolveChoice(this._choicePays() ? 'order' : 'hoard');
    this._taps.length = 0;
    this.state = 'results';

    // LIFETIME RECORD + STREAK. Counted once per finished shift, after the
    // hover-choice has resolved so a Heartstone taken on the last swing is
    // included.
    //
    // The streak is bound to the UTC day number, the same clock the daily seed
    // uses. A device clock that goes BACKWARD must never cost a streak — a
    // timezone change or a manual clock edit is not a missed day — so a day
    // earlier than the last one recorded is ignored entirely rather than
    // treated as a break. Forward jumps of more than one day do break it,
    // which is correct: that really is a missed day.
    var st = stats();
    st.shifts = (st.shifts || 0) + 1;

    // CONTRACTS ARE CHECKED HERE, AND NOT ON THE DAILY.
    //
    // The daily's board is a date-derived character, so a RUSH DAY makes any
    // timed-card contract free and the shared jar becomes the farm route — the
    // whole board could be cleared on the right Tuesday. Contracts tick in
    // FREE and CAREER only; the daily still feeds every lifetime stat, so a
    // daily run still moves the counters those contracts read, it just cannot
    // be the thing that closes one. (Balatro's rule: meta-progression is off
    // inside a warped run.)
    //
    // Archive runs are daily runs and are excluded by the same test.
    // CONTRACTS ARE SCORED LAST, not here. Four of the twenty-seven read state
    // this function has not written yet — careerResult.stars ('Clean sheet')
    // and Meta.data.careerLevel ('Down the shaft', 'Deeper still', 'End of the
    // shaft') — and three more read st.bestStreak, which the block just below
    // is about to advance. Checking before those writes meant a contract could
    // only ever fire on the shift AFTER the one that earned it, and 'End of the
    // shaft' could never fire at all: clearing level 40 sets careerLevel to
    // CAREER_MAX+1 further down this function, and the finale button then sends
    // the player to the DAILY, which is the one mode contracts are deliberately
    // switched off in.
    var d = dayNumber();
    if (d > (st.lastDay || 0)) {
      st.days = (st.days || 0) + 1;
      st.streak = (d === st.lastDay + 1 || !st.lastDay) ? (st.streak || 0) + 1 : 1;
      if (st.streak > (st.bestStreak || 0)) st.bestStreak = st.streak;
      st.lastDay = d;
    }
    // THE HAND-OVER GUARD. The last swing of a shift is a tap on the pile, and
    // the results buttons arm on the very next pointerdown over the same
    // pixels: DEEPER PICK's rect (x 100..320, y 490..546) covers 8% of the jar
    // interior, and RETRY another 8%. A player mid-flurry lands one more tap and
    // has spent 250c on a screen they never saw. Wall-clock is legitimate here —
    // it is read only by the pointer listener, never by update(). See §3p.
    this._uiLockUntil = nowMs() + UI_LOCK_MS;
    if (this.career) {
      var won = this.ordersDone >= this.goalOrders;
      this.careerResult = { won: won, stars: 0 };
      if (won) {
        // The bought swings are subtracted before scoring: an assisted clear is
        // rated on the budget every player gets, so 250c cannot mint a 3-star.
        var left = this.swingsAtGoal - (this.pickBonus || 0);
        this.careerResult.stars = left >= 11 ? 3 : left >= 5 ? 2 : 1;
        this.careerResult.assisted = (this.pickBonus || 0) > 0;
        var lv = this.career.level;
        if (!Meta.data.careerStars) Meta.data.careerStars = {};
        // FIRST CLEAR ONLY. A career level's seed is FIXED, so banking a
        // replay's payout would make level 1 an infinite coin farm — which is
        // exactly why career never banked at all before the wallet existed.
        // Paying the first clear keeps progression worth something without
        // opening the farm: the ladder is 40 levels, so it pays out 40 times.
        var firstClear = !(Meta.data.careerStars[lv] > 0);
        if (this.careerResult.stars > (Meta.data.careerStars[lv] || 0)) {
          Meta.data.careerStars[lv] = this.careerResult.stars;
        }
        if (firstClear) {
          this.banked = this.coins;
          Meta.data.coins = (Meta.data.coins || 0) + this.coins;
          bump('earned', this.coins);
        }
        this.careerResult.banked = firstClear ? this.coins : 0;
        // CAREER_MAX+1 is the "shaft complete" sentinel; start() clamps back so
        // the button replays the finale instead of a level nobody screened
        if (lv === (Meta.data.careerLevel || 1)) {
          Meta.data.careerLevel = Math.min(CAREER_MAX + 1, lv + 1);
        }
      }
      // A LOSS IS STILL A SHIFT, and this save used to sit inside `if (won)`.
      //
      // stats() hands back Meta.data.stats BY REFERENCE, so st.shifts, st.days,
      // st.streak, st.bestStreak and st.lastDay above — plus the bestCombo
      // written during the run itself — were all mutated in memory and then
      // dropped on every failed career attempt. A player whose only session on
      // a given day was one lost level did not count that day: the streak stayed
      // where it was, and two days later the gap read as 2 and reset it to 1.
      // It only ever appeared to work because some unrelated later write (a
      // hoard gain, a purchase, a settings toggle) happened to flush it.
      if (!this.isDaily) this._checkContracts();
      Meta.save();
      return;
    }
    {
      // BANK THE COINS. The wallet is what the shop spends and the answer to
      // "why progress" — but WHICH runs may pay is a farming question, and the
      // answer is different per mode because the SEED is:
      //   free   random every time, so playing IS the earn loop — always banks
      //   daily  ONE seed for the whole day, so a replay would be a farm —
      //          banks the first run of each day only
      //   career fixed per level — first clear only (handled above)
      // an archive run pays nothing: see the note on start(). It is a replay
      // of a fixed seed, which is the definition of a farm.
      var payable = !this.archiveDay &&
                    (!this.isDaily || Meta.data.bankedDay !== this.day);
      this.banked = payable ? this.coins : 0;
      if (payable) {
        Meta.data.coins = (Meta.data.coins || 0) + this.coins;
        bump('earned', this.coins);
        if (this.isDaily) Meta.data.bankedDay = this.day;
      }
      Meta.save();
      if (this.isDaily) {
        // the day the JAR belongs to, sampled at start() — a run that crosses
        // UTC midnight is scored against the jar it was actually dug from
        var day = this.day;
        if (this.coins > (Meta.data.bestDaily[day] || 0)) Meta.data.bestDaily[day] = this.coins;
        // AN ARCHIVE RUN STOPS HERE. Your personal record for that day is
        // kept above — that is the point of playing one — but nothing is
        // queued and nothing is sent. The RPC stamps `day` from the SERVER
        // clock (tools/leaderboard-rpc.sql), so a past-day payload would land
        // on TODAY's board carrying a jar nobody else played. That is not a
        // policy choice, it is the only correct behaviour.
        if (this.archiveDay) { Meta.save(); return; }
        var payload = {
          day: day, seed: this.seed, player: Meta.data.playerName,
          coins: this.coins, pops: this.pops, client_id: Meta.data.clientId,
        };
        // THE QUEUE KEEPS THE BEST, because there is only one slot and the
        // daily is unlimited-replay by design. An unconditional assignment
        // meant a 512 queued offline was overwritten by the next run's 300, and
        // the boot retry then posted 300 — a personal best destroyed by playing
        // again. This is exactly the rule the server's gemburrow_keep_best
        // trigger already applies, so client and server now agree.
        var q = Meta.data.pendingScore;
        if (!q || q.day !== day || payload.coins > q.coins) Meta.data.pendingScore = payload;
        Meta.save();
        // Send the BEST known score for today, not necessarily this run's, and
        // clear the queue only if what succeeded IS what was queued — otherwise
        // a worse run's 200 OK would drop a better score that never landed.
        var send = Meta.data.pendingScore;
        var self = this;
        this.board = null;
        Lb.submit(send, function (ok) {
          if (ok && Meta.data.pendingScore === send) { Meta.data.pendingScore = null; Meta.save(); }
          // fetch AFTER the submit settles so your own row is on the board
          Lb.top(day, 10, function (rows) { self.board = rows; });
        });
      } else if (this.coins > Meta.data.bestFree) {
        Meta.data.bestFree = this.coins;
        Meta.save();
      }
      // ...and the free path's contracts, for the same reason the career branch
      // scores its own last: bestStreak, shifts and gems have all been written
      // by now. The daily is excluded here exactly as it was before — a shared
      // board with a date-derived character would make the right Tuesday a farm.
      if (!this.isDaily) { this._checkContracts(); Meta.save(); }
    }
  };

  // REQUEST a particle burst from the sim without drawing a single random
  // number there. update() may only say WHERE and HOW MANY; _cosmetic (which
  // runs off _frame, not off the fixed step) does the sampling. This is what
  // keeps the firewall gate's transitive walk green — before this, Math.random
  // was reachable from update() through four helpers, and _route pushes real
  // jar bodies fourteen lines above one of them.
  Game.prototype._burst = function (x, y, n, sx, sy, r0, r1, life, col, anchor) {
    this.bursts.push({ x: x, y: y, n: n, sx: sx, sy: sy,
                       r0: r0, r1: r1, life: life, col: col, anchor: anchor });
  };

  // ---- COSMETIC lane. Per-frame, variable dt, Math.random. Never the sim. ----
  // MARBLE CLACKS — contact audio, read entirely off the RENDER side.
  //
  // step() sets b.px/b.py at the top of every step and never restores them, so
  // after the sim runs each body still carries where it started. (x-px, y-py)
  // is therefore that step's true displacement, and displacement/STEP is its
  // speed — which means impacts can be heard without the deterministic sim
  // emitting anything at all. Nothing here is read by step(); the speed table
  // is keyed by body id and lives on the Game, so no sim state is polluted and
  // Jar.stateHash is untouched.
  //
  // An IMPACT is a body that suddenly LOST speed: it was falling, now it is
  // not. The existing landing detector was not reusable — measured, its
  // `lastVy > 260 && vy < 60` fired exactly ONCE across 60 dig collapses,
  // because per-dig peak fall speed is only ~107px/s. This gate is tuned to
  // the speeds the pile actually reaches.
  //
  // BUDGET, not a rate limiter: a collapse is a chord, and the whole point is
  // hearing several stones settle. But a restock pour drops ~30 bodies at once
  // and MAXV would evict the front of the phrase, so the loudest few per frame
  // win and the rest are dropped silently.
  // Speed (px/s) a body must LOSE in one step to count as an impact.
  //
  // Tuned through the REAL frame loop, driving real taps — an out-of-loop
  // harness that stepped the jar directly overstated this by ~30x (it promised
  // 2.27 clacks/dig at 130; the shipped path delivered 0.07) and would have
  // shipped a feature that is silent in the product and loud only in its own
  // test. Swept in-loop over 20 digs:
  //     40 -> 2.85/dig   55 -> 1.85   70 -> 1.15   90 -> 1.05   130 -> 0.50
  // 55 gives a tick or two on a normal dig and a small cascade when a column
  // collapses, which is the "marbles in a jar" the ad sells. It has to sit
  // this low because the pile is deliberately dead-stop — restitution is ~0
  // and peak fall speed is only ~107px/s, so a "loud" threshold is silence.
  Game.prototype._clackMin = 55;
  Game.prototype._clacks = function () {
    if (this.state !== 'playing') return;
    var bs = this.jar.bodies, STEP = 1 / CFG.stepHz;
    var spd = this._spd || (this._spd = {});
    var hits = null, t = this.worldT;
    for (var i = 0; i < bs.length; i++) {
      var b = bs[i];
      var dx = b.x - b.px, dy = b.y - b.py;
      var sp = Math.sqrt(dx * dx + dy * dy) / STEP;
      var rec = spd[b.id];
      if (rec === undefined) { spd[b.id] = { s: sp, t: -9 }; continue; }
      var lost = rec.s - sp;
      rec.s = sp;
      if (lost < this._clackMin) continue;      // not an impact, just settling
      // ONE STONE, ONE CLACK. A body does not stop cleanly — it jitters as the
      // solver seats it, and each of those wobbles is another speed loss over
      // the threshold. Without this cooldown a 12-body restock rang 71 times,
      // about six per stone, which reads as a rattle rather than a pour. 0.25s
      // thins a sustained restock without touching a single dig, whose stones
      // each land once anyway.
      if (t - rec.t < 0.25) continue;
      rec.t = t;
      (hits || (hits = [])).push({ f: lost, r: b.r });
    }
    if (!hits) return;
    // loudest first, then take the budget — a collapse should sound like its
    // biggest stone, not like whichever body happens to sit lowest in the array
    hits.sort(function (p, q) { return q.f - p.f; });

    // CLACKS MAY NEVER CROWD OUT GAMEPLAY AUDIO. Snd's pool allows 8 SOUNDING
    // voices and evicts the oldest one when it overflows — which is how a
    // tier-3 fanfare once lost its whole opening chord (HANDOFF §3g3).
    // Measured here: a 19-body restock peaked at TEN concurrent clacks on its
    // own, so ambience alone would have started stopping delivery fanfares and
    // fill-ladder notes mid-phrase. A clack carries no information; a fanfare
    // does. So clacks get a hard slice of the pool — 3 of the 8 — enforced on
    // the CALLER side over the voice's real ~0.11s life.
    var log = this._clackLog || (this._clackLog = []);
    var t0 = t - 0.12;
    while (log.length && log[0] < t0) log.shift();
    var room = 3 - log.length;
    if (room <= 0) return;
    var n = Math.min(hits.length, room, 2);
    for (var h = 0; h < n; h++) { Snd.clack(hits[h].f, hits[h].r); log.push(t); }
    // ids of extracted bodies would otherwise accumulate for the whole shift
    if (bs.length * 3 < Object.keys(spd).length) this._spd = {};
  };

  // Which bodies the first-run ring may point at. Order 0's needs FIRST, and
  // only the diggable ones; if none of them can be reached this frame, fall
  // back to any diggable gem — a jar with rings on nothing teaches worse than
  // a jar that rings the wrong colour, and at tutStep 0 the lesson is only
  // "tap a gem, it goes in the bag". Rocks are never ringed.
  Game.prototype._ringTargets = function () {
    if (this.tutStep !== 0 || this.state !== 'playing' || !this.jar) { this._ringSet = null; return; }
    var bs = this.jar.bodies, to = this.orders && this.orders[0];
    var want = [], any = [];
    for (var i = 0; i < bs.length; i++) {
      var b = bs[i];
      if (b.key.indexOf('rock') === 0 || b.key === 'heartstone') continue;
      if (!(this._expo && this._expo[b.id])) continue;      // must be diggable
      any.push(b);
      if (to && (to.need[b.key] || 0) > this._bagCount(b.key)) want.push(b);
    }
    // AT MOST TWO RINGS, AND THIS CAP IS LOAD-BEARING.
    //
    // The set used to be "every diggable gem order 0 wants", which was ~2.5
    // bodies back when only ~11 of 80 were diggable at all. The exposure fix
    // raised reachability 2-3x and this count went with it: caught on the
    // iPhone 17 simulator at NINE gold rings on the first screen a new player
    // ever sees — precisely the floating-circles debug-overlay look the ring
    // pass was deleted for everywhere else, reintroduced by a change nowhere
    // near it. A derived count that nobody bounded is a defect waiting for the
    // day the thing it derives from moves.
    //
    // Two is what the lesson needs: tutStep 0 teaches "tap a gem, it goes in
    // the bag", and one example plus an alternative says that. Highest in the
    // jar first — smallest y — because those are the ones nearest the surface
    // the specular has just taught the player to read, and a stable sort on a
    // deterministic body list keeps the choice identical for every player.
    var pool = want.length ? want : any;
    pool.sort(function (p, q) { return p.y - q.y || p.id - q.id; });
    var set = {};
    for (var k = 0; k < pool.length && k < 2; k++) set[pool[k].id] = 1;
    this._ringSet = set;
  };

  Game.prototype._cosmetic = function (dtRaw) {
    var i, f;
    // expand any bursts the sim requested this tick
    while (this.bursts.length) {
      var bq = this.bursts.shift();
      var bx = bq.x, by = bq.y;
      if (bq.anchor === 'ledge') {
        var lq = this._counter;
        bx = lq ? lq.l + 46 : 60;
        by = lq ? lq.y + lq.h - 44 : VIEW_H - 70;
      }
      for (var qi = 0; qi < bq.n; qi++) {
        this.sparks.push({
          x: bx, y: by,
          vx: (Math.random() - 0.5) * bq.sx, vy: -Math.random() * bq.sy,
          r: bq.r0 + Math.random() * (bq.r1 - bq.r0), life: bq.life, col: bq.col,
        });
      }
    }
    var ledge = this._counter;
    for (i = this.fliers.length - 1; i >= 0; i--) {
      f = this.fliers[i];
      // late-bind the hoard destination to the bottom-anchored ledge (draw lane)
      if (f.toFloor && ledge) { f.tx = ledge.l + 44; f.ty = ledge.y + ledge.h - 34; }
      f.t += dtRaw / f.dur;
      if (f.t >= 1) {
        this.fliers.splice(i, 1);
        for (var s = 0; s < 6; s++) {
          this.sparks.push({
            x: f.tx, y: f.ty,
            vx: (Math.random() - 0.5) * 160, vy: -Math.random() * 130,
            r: 1.5 + Math.random() * 2.5, life: 0.5, col: f.col,
          });
        }
      }
    }
    for (i = this.sparks.length - 1; i >= 0; i--) {
      var p = this.sparks[i];
      p.x += p.vx * dtRaw; p.y += p.vy * dtRaw; p.vy += 500 * dtRaw;
      p.life -= dtRaw;
      if (p.life <= 0) this.sparks.splice(i, 1);
    }
    for (i = this.rings.length - 1; i >= 0; i--) {
      this.rings[i].t += dtRaw * 3.2;
      if (this.rings[i].t >= 1) this.rings.splice(i, 1);
    }
    for (i = this.picks.length - 1; i >= 0; i--) {
      this.picks[i].t += dtRaw * 7.0;
      if (this.picks[i].t >= 1) this.picks.splice(i, 1);
    }
    // coin rollup: display chases truth; ticks while rolling, slams on big lands
    var gap = this.coins - this.displayCoins;
    if (gap > 0) {
      if (!this._rolling) this._rolling = gap;
      var before = Math.floor(this.displayCoins);
      this.displayCoins = Math.min(this.coins, this.displayCoins + Math.max(1, gap * 4) * dtRaw * 4);
      if (Math.floor(this.displayCoins) > before) Snd.tick();
      if (this.displayCoins >= this.coins) {
        if (this._rolling >= 25) Snd.slam();
        this._rolling = 0;
      }
    }
    if (this.dragonPulse) { this.dragonPulse -= dtRaw * 2; if (this.dragonPulse < 0) this.dragonPulse = 0; }
    if (this.bagFlash) { this.bagFlash -= dtRaw * 2.2; if (this.bagFlash < 0) this.bagFlash = 0; }
    if (this.tossFlash) { this.tossFlash -= dtRaw * 2.4; if (this.tossFlash < 0) this.tossFlash = 0; }
    if (this.shakeT) { this.shakeT -= dtRaw; if (this.shakeT < 0) this.shakeT = 0; }
    if (!this.jar) return;
    for (i = 0; i < this.jar.bodies.length; i++) {
      var b = this.jar.bodies[i];
      if (b.wiggle) { b.wiggle -= dtRaw * 3; if (b.wiggle < 0) b.wiggle = 0; }
      if (b.squash) { b.squash -= dtRaw * 5; if (b.squash < 0) b.squash = 0; }
    }
    for (var s2 = 0; s2 < 5; s2++) {
      var o = this.orders[s2];
      if (o && o.flash > 0) { o.flash -= dtRaw * 2.5; if (o.flash < 0) o.flash = 0; }
      if (o && o.dropT > 0) { o.dropT -= dtRaw * 2.8; if (o.dropT < 0) o.dropT = 0; }
    }
  };

  Game.prototype._fly = function (b, kind, slot) {
    var t = TYPE[b.key];
    var tx, ty;
    if (kind === 'order') { tx = 14 + slot * (ORDER_W + 8) + ORDER_W / 2; ty = ORDER_Y + ORDER_H / 2; }
    else if (kind === 'bag') { tx = bagSlotX(slot) + BAG_SLOT / 2; ty = BAG_Y + BAG_SLOT / 2; }
    // 'hoard' resolves its destination at DRAW time (toFloor) — the ledge is
    // bottom-anchored and therefore device-dependent, and no device number may
    // enter update(), which is where _fly is called from.
    else if (kind === 'hoard') { tx = 52; ty = VIEW_H - 40; }
    // 'toss' exits STAGE LEFT, deliberately not to the scrap corner. Scrap is
    // where rock rubble flies to become 1c, and it sits under the coin counter
    // — sending a tossed gem there would say it paid, when tossing a gem is
    // precisely the move that earns nothing. Off the side reads as "gone".
    else if (kind === 'toss') { tx = -40; ty = BAG_Y + 6; }
    else { tx = VIEW_MIN_W - 60; ty = 16; }
    this.fliers.push({
      toFloor: kind === 'hoard',
      x: b.x, y: b.y, tx: tx, ty: ty, t: 0,
      dur: kind === 'order' ? 0.32 : kind === 'bag' ? 0.26 : kind === 'toss' ? 0.5 : 0.42,
      r: b.r, col: t.col, hi: t.hi, key: b.key,
    });
  };

  // the delivery burst: the assembled set leaps from the bag into the card
  Game.prototype._flyBagToCard = function (bagIdx, key, slot) {
    var t = TYPE[key];
    this.fliers.push({
      x: bagSlotX(Math.max(0, bagIdx)) + BAG_SLOT / 2, y: BAG_Y + BAG_SLOT / 2,
      tx: 14 + slot * (ORDER_W + 8) + ORDER_W / 2, ty: ORDER_Y + ORDER_H / 2,
      t: 0, dur: 0.22, r: 12, col: t.col, hi: t.hi, key: key,
    });
  };

  // The satchel toss, made unmistakable. The bug this replaces was the ABSENCE
  // of feedback — the gem simply stopped existing between frames — so the fix
  // is three cues on three channels that cannot all be missed:
  //   sight   the gem leaps out of the slot and sails off the side of the frame
  //   debris  a puff of grit kicked out of the slot it vacated
  //   touch   a light tap plus the scrap knock
  // The vacated slot also pulses, because with a full bag the remaining gems
  // re-flow one slot left and the change is otherwise easy to miss entirely.
  Game.prototype._tossFromBag = function (key, slot) {
    var sx = bagSlotX(slot) + BAG_SLOT / 2, sy = BAG_Y + BAG_SLOT / 2;
    this._fly({ x: sx, y: sy, r: 12, key: key }, 'toss');
    this._burst(sx, sy + 6, 7, 150, 130, 1, 2, 0.45, '#c9a86a');
    this.tossSlot = slot;
    this.tossFlash = 1;
    Hap.light();
    Snd.scrap();
  };

  Game.prototype._rockChips = function (x, y) {
    this._burst(x, y - 6, 5, 220, 200, 1.5, 2, 0.5, '#a89e8f');
  };

  Game.prototype._celebrate = function (o) {
    var cx = 14 + o.slot * (ORDER_W + 8) + ORDER_W / 2;
    this._burst(cx, ORDER_Y + ORDER_H / 2, 26, 320, 300, 2, 3, 0.9, '#ffd75e');
  };

  // ---- RENDER ONLY. Reads state, draws back-to-front. No sim, no lane-2 draws. ----
  Game.prototype.draw = function (alpha) {
    var ctx = this.ctx, v = this.view;
    ctx.setTransform(v.dpr * v.scale, 0, 0, v.dpr * v.scale, 0, 0);
    // the backdrop is the one asset that ever gets resampled — ask for the
    // good filter, not WebKit's default 'low' bilinear
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // LAYER 1 — the DIG WALL. The menu keeps the painted shop (SPR
    // .backdrop_burrow); play gets a quiet wall whose centre is empty, so the
    // jar is the only thing in the frame worth looking at. It is authored tall
    // (1024x2400) specifically so cover-fit DOWNSCALES it on a phone — the old
    // shared backdrop was magnified 1.39x and was the softest thing on screen.
    // wallImage() returns the base wall, or the equipped colour-graded variant
    // from the shop (cached; see WALL_SKINS).
    var bg = (this.state === 'menu' ? SPR.backdrop_burrow
                                    : (wallImage() || SPR.backdrop_burrow));
    if (bg) {
      var s = Math.max(v.w / bg.width, v.h / bg.height);
      var bw = bg.width * s, bh = bg.height * s;
      ctx.drawImage(bg, (v.w - bw) / 2, (v.h - bh) / 2, bw, bh);
      ctx.fillStyle = this.state === 'menu' ? 'rgba(20,14,10,0.30)'
                                            : 'rgba(16,10,6,0.18)';
      ctx.fillRect(0, 0, v.w, v.h);
      // vignette: pull the eye to the jar without dimming the whole painting
      if (this.state !== 'menu') {
        var vg = ctx.createRadialGradient(v.w / 2, v.h * 0.42, v.h * 0.18,
                                          v.w / 2, v.h * 0.42, v.h * 0.72);
        vg.addColorStop(0, 'rgba(10,6,3,0)');
        vg.addColorStop(1, 'rgba(10,6,3,0.55)');
        ctx.fillStyle = vg;
        ctx.fillRect(0, 0, v.w, v.h);
      }
    } else {
      ctx.fillStyle = '#2b2320';
      ctx.fillRect(0, 0, v.w, v.h);
      ctx.fillStyle = '#3a2e26';
      ctx.fillRect(0, 0, v.w, JAR.top - 26);
      ctx.fillStyle = '#4a3a2c';
      ctx.fillRect(0, JAR.bot, v.w, v.h - JAR.bot);
    }

    ctx.save();
    ctx.translate(v.ox, v.oy + v.uiTop);
    if (this.shakeT > 0) {
      var amp = 5 * (this.shakeT / 0.4);
      ctx.translate((Math.random() - 0.5) * amp, (Math.random() - 0.5) * amp);
    }

    if (this.state === 'menu') { this._drawMenu(); this._drawSettings(); ctx.restore(); return; }
    if (this.state === 'shop') { this._drawShop(); this._drawSettings(); ctx.restore(); return; }
    if (this.state === 'records') { this._drawRecords(); this._drawSettings(); ctx.restore(); return; }
    if (this.state === 'levels') { this._drawLevels(); this._drawSettings(); ctx.restore(); return; }
    if (this.state === 'paywall') { this._drawPaywall(); this._drawSettings(); ctx.restore(); return; }

    // lantern breath: the backdrop's lamp flickers (smoothed lane-3 noise)
    this._lampT = (this._lampT || 0.5) + (Math.random() - 0.5) * 0.08;
    this._lampT = Math.max(0.3, Math.min(0.7, this._lampT));
    var lg = ctx.createRadialGradient(VIEW_MIN_W / 2, 120, 10, VIEW_MIN_W / 2, 120, 260);
    lg.addColorStop(0, 'rgba(255,190,90,' + (0.10 + this._lampT * 0.08).toFixed(3) + ')');
    lg.addColorStop(1, 'rgba(255,190,90,0)');
    ctx.fillStyle = lg;
    ctx.fillRect(-v.ox, -v.uiTop, v.w, 420);

    // LAYER 2 — jar back glass
    ctx.fillStyle = 'rgba(190,225,255,0.08)';
    rr(ctx, JAR.l - 10, JAR.top - 16, JAR.r - JAR.l + 20, JAR.bot - JAR.top + 26, 18);
    ctx.fill();

    // LAYER 3 — bodies (interpolated between fixed steps)
    //
    // "Diggable" is computed ONCE PER FRAME here, not per body inside
    // _drawBody, because exposed() is O(n) per call and the heartstone branch
    // alone was already paying for it every frame.
    //
    // Why it needs drawing at all: only ~11.5 of ~80.8 settled bodies are
    // exposed, and because _solvePair keeps circles from overlapping, a
    // settled pile has almost no occlusion — the heartstone measures 97.2%
    // visible while being completely unreachable. So "buried" was a predicate
    // with no pixels, and most taps a new player made were refused with a
    // wiggle and a thunk that looked identical to a miss.
    this._expo = {};
    for (var ei = 0; ei < this.jar.bodies.length; ei++) {
      var eb = this.jar.bodies[ei];
      this._expo[eb.id] = this.jar.exposed(eb);
    }
    // the first-run ring reads the SAME map, so it can never point at a body
    // the shadow pass is busy dimming
    this._ringTargets();
    for (var i = 0; i < this.jar.bodies.length; i++) {
      this._drawBody(this.jar.bodies[i], alpha);
    }

    // LAYER 4 — jar front glass edge
    ctx.strokeStyle = 'rgba(230,245,255,0.35)';
    ctx.lineWidth = 3;
    rr(ctx, JAR.l - 10, JAR.top - 16, JAR.r - JAR.l + 20, JAR.bot - JAR.top + 26, 18);
    ctx.stroke();
    // glass sheen — faint, upper third only (a full-height bar reads as a wall)
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(JAR.l + 10, JAR.top + 16);
    ctx.lineTo(JAR.l + 10, JAR.top + 150);
    ctx.stroke();

    // LAYER 4b — the shop counter. Drawn BEFORE the fliers so a gem flying to
    // the hoard lands ON the ledge rather than behind it.
    this._drawCounter();

    // LAYER 5 — order line + satchel (+ the prism choice hover above both)
    this._drawOrders();
    this._drawBag();
    if (this.choice) this._drawChoice();

    // LAYER 6 — fliers + sparks (lane 3)
    for (i = 0; i < this.fliers.length; i++) this._drawFlier(this.fliers[i]);
    for (i = 0; i < this.sparks.length; i++) {
      var p = this.sparks[i];
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 2));
      ctx.fillStyle = p.col;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.283); ctx.fill();
    }
    for (i = 0; i < this.picks.length; i++) this._drawPick(this.picks[i]);
    for (i = 0; i < this.rings.length; i++) {
      var rg = this.rings[i];
      ctx.globalAlpha = (1 - rg.t) * 0.7;
      ctx.strokeStyle = '#ffe9a8'; ctx.lineWidth = 2.5 * (1 - rg.t) + 0.5;
      ctx.beginPath(); ctx.arc(rg.x, rg.y, rg.r + rg.t * 26, 0, 6.283); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    this._hud();
    if (this.state === 'results') this._drawResults();
    // The bare lifecycle pause (app backgrounded). Settings draws its own scrim
    // on top of everything, so the two must not stack.
    if (this.state === 'paused' && !this.showSettings) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(-v.ox, -v.uiTop, v.w, v.h + v.uiTop);
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillStyle = '#fff'; ctx.font = fD(34);
      // 'PAUSED — tap to resume' at 40px measures ~480 units against a 420-unit
      // world: it ran off both edges. Two lines, and it fits.
      ctx.fillText('PAUSED', VIEW_MIN_W / 2, v.h / 2 - 40);
      ctx.fillStyle = 'rgba(232,220,200,0.7)'; ctx.font = fT(15);
      ctx.fillText('tap to resume', VIEW_MIN_W / 2, v.h / 2 + 4);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }
    this._drawSettings();
    ctx.restore();
  };

  // "r,g,b" of a crusted rock's contents, blended across the pair and washed
  // 45% toward white so the seam reads as glinting crystal, not as a coloured
  // lamp. Pure function of the body; safe to call every frame.
  function crustHue(b) {
    var rr = 0, gg = 0, bb = 0, n = 0;
    for (var i = 0; i < b.geode.length; i++) {
      var t = TYPE[b.geode[i]];
      if (!t) continue;
      var h = t.col.charAt(0) === '#' ? t.col.slice(1) : t.col;
      rr += parseInt(h.slice(0, 2), 16);
      gg += parseInt(h.slice(2, 4), 16);
      bb += parseInt(h.slice(4, 6), 16);
      n++;
    }
    if (!n) return '255,238,190';
    var w = 0.45;                       // wash toward white
    rr = Math.round(rr / n + (255 - rr / n) * w);
    gg = Math.round(gg / n + (255 - gg / n) * w);
    bb = Math.round(bb / n + (255 - bb / n) * w);
    return rr + ',' + gg + ',' + bb;
  }

  // SHALE trickles dust. Checked at true draw size, the shale sprite is the
  // weakest tell of the three specials: the lodestone and the crusted rock
  // both announce themselves with COLOUR (iron-blue bands, a crystal seam)
  // while shale is a brown rock with a crack — and rock_m already has a
  // crack. In a settled pile nothing else moves, so motion is the strongest
  // signal available, and it says the right thing: this one is crumbling.
  //
  // Pure function of worldT and b.id — no RNG lane, no per-frame state, and
  // identical on every device.
  Game.prototype._shaleDust = function (x, y, b) {
    var ctx = this.ctx;
    for (var i = 0; i < 3; i++) {
      // each fleck falls on its own offset loop, ~1.1s long
      var ph = (this.worldT * 0.9 + b.id * 0.37 + i * 0.33) % 1;
      var fx = x + ((i - 1) * 0.34 + Math.sin(b.id + i) * 0.08) * b.r;
      var fy = y + b.r * (0.15 + ph * 0.95);
      var a = 0.55 * (1 - ph) * (ph < 0.12 ? ph / 0.12 : 1);
      if (a <= 0.01) continue;
      ctx.fillStyle = 'rgba(214,196,168,' + a.toFixed(2) + ')';
      ctx.beginPath();
      ctx.arc(fx, fy, 1.3 + (1 - ph) * 0.7, 0, 6.283);
      ctx.fill();
    }
  };

  // The crusted rock's live tell: a slow twinkle over the painted seam, plus a
  // ring once it has been cracked. Draw-side only, driven by worldT and b.id
  // (no RNG lane, deterministic, stable per body).
  Game.prototype._crustGlint = function (x, y, b) {
    var ctx = this.ctx;
    var tw = 0.5 + 0.5 * Math.sin(this.worldT * 2.4 + b.id * 1.7);
    // The seam bleeds the COLOUR of what is inside. Deep Rock Galactic's
    // grammar for a buried gem: the rock advertises its contents with a
    // coloured tell, so digging toward it is an informed choice rather than a
    // lottery. Blended across both inner gems and washed toward white, so it
    // hints ("something green in there") without giving the pair away.
    var inner = crustHue(b);
    var gy = y - b.r * 0.06;
    var gr = b.r * (0.30 + 0.10 * tw);
    var g = ctx.createRadialGradient(x, gy, 0, x, gy, gr);
    g.addColorStop(0, 'rgba(255,252,232,' + (0.45 + 0.35 * tw).toFixed(2) + ')');
    g.addColorStop(0.55, 'rgba(' + inner + ',' + (0.30 + 0.22 * tw).toFixed(2) + ')');
    g.addColorStop(1, 'rgba(' + inner + ',0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, gy, gr, 0, 6.283); ctx.fill();
    // a four-point star glint — the universal "treasure here" mark
    var sr = b.r * (0.34 + 0.08 * tw);
    ctx.strokeStyle = 'rgba(255,255,245,' + (0.55 + 0.35 * tw).toFixed(2) + ')';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(x - sr, y); ctx.lineTo(x + sr, y);
    ctx.moveTo(x, y - sr); ctx.lineTo(x, y + sr);
    ctx.stroke();
  };

  Game.prototype._drawBody = function (b, alpha) {
    var ctx = this.ctx;
    // Read ONCE at the top: `var` hoists but the assignment does not, and the
    // first consumer (the scan halo) sits above where this used to be
    // declared — so it evaluated `undefined` and the halo silently never drew.
    var _hints = Meta.data.hints !== 0;
    var x = b.px + (b.x - b.px) * alpha;
    var y = b.py + (b.y - b.py) * alpha;
    if (b.wiggle) x += Math.sin(this.worldT * 42) * b.wiggle * 3;
    // TUTORIAL RING — only ever on a gem the player can ACTUALLY DIG.
    //
    // It used to ring every body order 0 still needed, with no diggability
    // test at all. Measured over 300 free jars: 16.7 rings per jar of which
    // 2.5 are diggable — 84.9% of the game's FIRST instruction pointed at a
    // dead tap, and 8.3% of jars had rings where not one was diggable. The
    // refusal is a wiggle and a thunk, byte-identical to hitting empty space,
    // so the new player got no diagnosis either. The ring also strokes at
    // inkR+4, outside the buried-shadow fill at inkR, so it painted at full
    // brightness OVER a shadowed sprite — the loudest mark on screen sitting
    // on the one body that could not be taken.
    //
    // _ringSet is computed once per frame in _cosmetic and already knows both
    // things: what order 0 wants, and what the pick can reach.
    if (this.tutStep === 0 && this.state === 'playing' &&
        this._ringSet && this._ringSet[b.id]) {
      this.ctx.strokeStyle = 'rgba(255,215,94,0.8)';
      this.ctx.lineWidth = 3;
      this.ctx.beginPath(); this.ctx.arc(x, y, inkR(b) + 4, 0, 6.283); this.ctx.stroke();
    }
    // SCAN HALO: the tapped card's still-needed gems glow in the jar — and it
    // must obey the same rule the tutorial ring above was fixed to obey.
    //
    // It didn't. This drew the IDENTICAL gold ring at the IDENTICAL radius with
    // no diggability test at all, so tapping a card lit up every gem of that
    // colour anywhere in the pile. Measured over 12,000 simulated card-taps:
    // 19.10 gems lit, 1.37 of them diggable — 92.8% of the glow pointed at a
    // tap the game refuses, and on 37.7% of card-taps NOT ONE lit gem could be
    // taken. Vanus reported it from the phone as "some gems glow ... when they
    // are anywhere inside under rocks".
    //
    // A gem that is wanted but buried still deserves an answer, so it gets one
    // in a different voice: a dim violet ring means "this card wants it, you
    // cannot reach it yet". Gold has one meaning in this jar and it is
    // "tappable right now".
    if (_hints && this.scanUntil > this.worldT && this.state === 'playing') {
      var so = this.orders[this.scanSlot];
      if (so && (so.need[b.key] || 0) > this._bagCount(b.key)) {
        var fade = Math.min(1, (this.scanUntil - this.worldT) / 0.4);
        var reach = this._expo && this._expo[b.id];
        this.ctx.strokeStyle = reach
          ? 'rgba(255,215,94,' + (0.85 * fade).toFixed(2) + ')'
          : 'rgba(178,142,224,' + (0.34 * fade).toFixed(2) + ')';
        this.ctx.lineWidth = reach ? 3 : 2;
        this.ctx.beginPath(); this.ctx.arc(x, y, inkR(b) + 4, 0, 6.283); this.ctx.stroke();
      }
    }
    if (b.key === 'heartstone') {
      var hs = SPR.gem_heartstone || SPR.gem_prism;
      // NOTHING BEHIND IT. This carried a pulsing amber ready-ring and a white
      // halo; the ring went when Vanus asked why the colossus had a circle
      // that breathed, and the halo goes now that he has spotted the disc left
      // behind. Both were the same error the dragon's aura made: a flat arc
      // fill at a solid alpha draws a hard EDGE, so it reads as a UI badge
      // rather than as light — and the one body in the jar at r56 against
      // r15-29 never needed help being seen. Its own art is luminous opal and
      // the shadow model already says whether it can be dug.
      //
      // same ink-to-circle fit as every other body; falls back to the prism's
      // multiplier when the dedicated heartstone art is missing
      var hd = b.r * sprFit(SPR.gem_heartstone ? 'gem_heartstone' : 'gem_prism');
      if (hs) this.ctx.drawImage(hs, x - hd / 2, y - hd / 2, hd, hd);
      else {
        this.ctx.fillStyle = HEART.col;
        this.ctx.beginPath(); this.ctx.arc(x, y, b.r, 0, 6.283); this.ctx.fill();
      }
      if (b.pry > 0) {
        this.ctx.strokeStyle = 'rgba(60,30,80,0.55)'; this.ctx.lineWidth = 2.5;
        this.ctx.beginPath();
        this.ctx.moveTo(x - b.r * 0.5, y - b.r * 0.3);
        this.ctx.lineTo(x - b.r * 0.1, y + b.r * 0.1);
        if (b.pry > 1) {
          this.ctx.lineTo(x + b.r * 0.3, y - b.r * 0.15);
          this.ctx.moveTo(x + b.r * 0.1, y + b.r * 0.45);
          this.ctx.lineTo(x + b.r * 0.4, y + b.r * 0.1);
        }
        this.ctx.stroke();
      }
      // BURIED IS SHADOW, HERE TOO. The colossus used to be the one body that
      // opted out of the lighting model and announced its diggability with a
      // pulsing amber ring instead — which is exactly the debug-overlay look
      // the ring pass was deleted for everywhere else. It now reads the same
      // way every other body does: in shadow while something holds it, lit
      // when the pick can reach it.
      if (this._expo && !this._expo[b.id]) {
        this.ctx.fillStyle = 'rgba(16,10,6,0.34)';
        this.ctx.beginPath(); this.ctx.arc(x, y, inkR(b), 0, 6.283); this.ctx.fill();
      }
      return;
    }
    var sk = bodySpr(b);
    var spr = SPR[sk];
    var sq = b.squash || 0;                     // landing squash (cosmetic)
    if (spr) {
      var d = b.r * sprFit(sk);                 // ink lands ON the circle
      if (sq > 0) {
        ctx.save();
        ctx.translate(x, y + b.r * sq * 0.3);
        ctx.scale(1 + sq * 0.22, 1 - sq * 0.26);
        ctx.drawImage(spr, -d / 2, -d / 2, d, d);
        ctx.restore();
      } else {
        ctx.drawImage(spr, x - d / 2, y - d / 2, d, d);
      }
      // THE BLAME PASS — "this is what is on it". Drawn BEFORE the diggable
      // specular below, so a body that is both a blocker and itself diggable
      // still keeps its own lamplight on top.
      //
      // THE JAR HAS EXACTLY THREE MARKS AND THEY DO NOT SHARE COLOURS.
      // Vanus, looking at the result of the last two passes: "are the circles
      // only when toggled on in settings ... i dont get it". Fair — five cues
      // had accumulated in warm gold and amber and they all read as the same
      // thing. The vocabulary is now one colour per QUESTION:
      //
      //   warm light, an ARC and never a ring   you can dig this  (ambient)
      //   GOLD ring                             a card wants this (you asked)
      //   VIOLET ring                           something holds this / is
      //                                         holding it (you asked)
      //
      // Violet was already the jar's "held" colour — the lodestone's grip arcs
      // and the scan halo's pinned-gem ring both use it — so this pass moved
      // off amber and onto it rather than minting a fourth meaning. A player
      // who learns "violet means stuck" learns it once and it holds everywhere.
      //
      // First, the gem the player ASKED FOR, dashed, so the cue reads as one
      // sentence — "those are holding THIS" — rather than as a couple of rocks
      // lighting up for no stated reason. Both halves dim hard once the player
      // has seen the lesson six times (blame.loud); see the tap handler.
      if (_hints && this.blame && this.worldT < this.blame.until && this.blame.tid === b.id) {
        var _af = Math.min(1, (this.blame.until - this.worldT) / 0.35);
        ctx.save();
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = 'rgba(188,150,255,' + ((this.blame.loud ? 0.55 : 0.24) * _af).toFixed(2) + ')';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(x, y, inkR(b) + 3, 0, 6.283); ctx.stroke();
        ctx.restore();
      }
      if (_hints && this.blame && this.worldT < this.blame.until && this.blame.ids[b.id]) {
        var _bf = Math.min(1, (this.blame.until - this.worldT) / 0.35);
        ctx.save();
        ctx.strokeStyle = 'rgba(196,150,255,' + ((this.blame.loud ? 0.85 : 0.30) * _bf).toFixed(2) + ')';
        ctx.lineWidth = this.blame.loud ? 2.5 : 1.5;
        ctx.beginPath(); ctx.arc(x, y, inkR(b) + 3, 0, 6.283); ctx.stroke();
        // a short tether toward the gem the player actually tapped, so the
        // sentence reads "THAT one is holding THIS one" rather than "these
        // three rocks are highlighted for some reason"
        var _vx = this.blame.x - b.x, _vy = this.blame.y - b.y;
        var _d = Math.sqrt(_vx * _vx + _vy * _vy) || 1;
        ctx.strokeStyle = 'rgba(196,150,255,' + ((this.blame.loud ? 0.5 : 0.18) * _bf).toFixed(2) + ')';
        ctx.lineWidth = this.blame.loud ? 2 : 1.5;
        ctx.beginPath();
        ctx.moveTo(x + _vx / _d * (inkR(b) + 3), y + _vy / _d * (inkR(b) + 3));
        ctx.lineTo(x + _vx / _d * (_d - this.blame.r * 1.03), y + _vy / _d * (_d - this.blame.r * 1.03));
        ctx.stroke();
        ctx.restore();
      }
      // NOTHING MARKS WHAT IS DIGGABLE ANY MORE, and that is the payoff of
      // the cover rule rather than an omission.
      //
      // Under the old support rule the reachable set was a scatter the picture
      // could not express, so it had to be painted on: a specular arc on every
      // reachable body. Vanus read the result, twice, as "circles around the
      // gems and rocks and everything" — and he was right, because 21 marks on
      // 74 bodies is not a highlight. Now the reachable set is exactly the top
      // of the pile, which the player can already see. A mark would be
      // restating the picture.
      //
      // The buried shadow below stays: it is depth, not instruction.
      // WHAT IS BURIED SITS IN SHADOW.
      //
      // Only ~11 of ~80 settled bodies can actually be dug, and nothing said
      // which — so most taps a new player makes are refused with a wiggle and
      // a thunk. The root cause is that this engine has no occlusion: bodies
      // are non-overlapping circles, so a stone at the bottom of a full jar is
      // still 97% visible and "buried" is a predicate the player cannot see.
      //
      // The first attempt drew a warm RING around every diggable body, which
      // read as a debug overlay — a dozen circles floating over the art. This
      // says the same thing with light instead: buried bodies fall into
      // shadow, so the diggable ones are simply the ones catching the lantern.
      // No new marks on screen, and the jar reads DEEPER rather than busier.
      if (this._expo && !this._expo[b.id]) {
        ctx.fillStyle = 'rgba(16,10,6,0.34)';
        ctx.beginPath(); ctx.arc(x, y, inkR(b), 0, 6.283); ctx.fill();
      }
      // The symbol goes ON TOP of the buried shadow: identity must survive
      // being in shadow, or the channel that exists for players who cannot use
      // colour switches off for exactly the gems they most need to identify.
      if (Meta.data.marks === 1) gemMark(ctx, b.key, x, y, Math.max(3.5, b.r * 0.30));
      // Crusted rocks twinkle ON TOP of their sprite. The old tell was two
      // 1.6px flecks drawn BEFORE this drawImage — sampled alpha at both
      // fleck positions is 255 on all three rock PNGs, so the sprite painted
      // straight over them and no player has ever seen a crusted gem. This
      // pass is the whole reason the mechanic becomes visible; keep it AFTER
      // the sprite.
      if (b.geode) this._crustGlint(x, y, b);
      if (b.shale) this._shaleDust(x, y, b);
      // (The lodestone's grip-arc renderer lived here. `heldBy()` has returned
      // [] since the cover rule landed, so this drew nothing for its entire
      // life — see the note where the stubs were deleted.)
      return;
    }
    var t = TYPE[b.key];
    var rock = b.key.indexOf('rock') === 0;
    ctx.fillStyle = t.col;
    ctx.beginPath(); ctx.arc(x, y, b.r, 0, 6.283); ctx.fill();
    if (rock) {
      ctx.fillStyle = 'rgba(0,0,0,0.14)';
      ctx.beginPath(); ctx.arc(x + b.r * 0.3, y + b.r * 0.25, b.r * 0.4, 0, 6.283); ctx.fill();
    } else {
      ctx.fillStyle = t.hi;
      ctx.beginPath();
      ctx.moveTo(x - b.r * 0.45, y - b.r * 0.5);
      ctx.lineTo(x + b.r * 0.1, y - b.r * 0.75);
      ctx.lineTo(x + b.r * 0.35, y - b.r * 0.1);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, b.r - 1, 0, 6.283); ctx.stroke();
    }
  };

  // a fast pick strike: wind-up already passed, we draw the swing-through.
  // Vector pick (painterly-adjacent), cracked head when the tool is nearly out.
  Game.prototype._drawPick = function (pk) {
    var ctx = this.ctx;
    var e = pk.t < 0.4 ? pk.t / 0.4 : 1;
    var ang = -1.15 + e * (pk.heavy ? 1.75 : 1.45);
    var fade = pk.t > 0.6 ? 1 - (pk.t - 0.6) / 0.4 : 1;
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.translate(pk.x + 20, pk.y - 14);
    ctx.rotate(ang);
    var ps = pickImage();
    if (ps) {
      if (pk.cracked) ctx.globalAlpha = fade * 0.85;
      ctx.drawImage(ps, -24, -52, 48, 48);
      if (pk.cracked) {
        ctx.strokeStyle = 'rgba(226,75,74,0.9)'; ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(-8, -44); ctx.lineTo(-2, -38); ctx.lineTo(-7, -32);
        ctx.stroke();
      }
    } else {
      ctx.strokeStyle = pk.cracked ? '#5a3d24' : '#8a5f38';
      ctx.lineWidth = 5; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -30); ctx.stroke();
      ctx.strokeStyle = pk.cracked ? '#7c8894' : '#aeb9c4';
      ctx.lineWidth = 6;
      ctx.beginPath(); ctx.arc(0, -30, 14, 3.5, 5.9); ctx.stroke();
      if (pk.cracked) {
        ctx.strokeStyle = 'rgba(226,75,74,0.85)'; ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(-6, -38); ctx.lineTo(-1, -33); ctx.lineTo(-5, -28);
        ctx.stroke();
      }
    }
    ctx.restore();
    // THE MOMENT OF CONTACT. This used to draw a five-pointed cartoon STAR at
    // the impact point — a sticker sitting on top of four effects that already
    // sell the hit: the swung pick itself, the extraction ring, the rock chips
    // and the hit-stop plus shake. It read as clip-art rather than as force,
    // and it was the one thing on screen nobody could explain.
    //
    // What replaces it says "struck": a hard white core that dies in ~0.07s,
    // and four short streaks thrown back along the swing. A heavy hit (rock)
    // throws them further than a gem, so the effect carries information the
    // star never did.
    if (pk.t > 0.38 && pk.t < 0.62) {
      var im = (0.62 - pk.t) * 4;                 // 1 -> 0 across the window
      var reach = (pk.heavy ? 15 : 10) * (1.25 - im * 0.5);
      ctx.save();
      ctx.translate(pk.x, pk.y - 4);
      ctx.strokeStyle = 'rgba(255,244,214,' + Math.min(0.85, im).toFixed(2) + ')';
      ctx.lineWidth = pk.heavy ? 2.2 : 1.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (var sk2 = 0; sk2 < 4; sk2++) {
        // fanned back along the pick's arc, not a symmetric asterisk
        var a2 = -2.5 + sk2 * 0.55;
        ctx.moveTo(Math.cos(a2) * reach * 0.35, Math.sin(a2) * reach * 0.35);
        ctx.lineTo(Math.cos(a2) * reach, Math.sin(a2) * reach);
      }
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,252,238,' + Math.min(0.9, im * 1.1).toFixed(2) + ')';
      ctx.beginPath(); ctx.arc(0, 0, (pk.heavy ? 4.2 : 3.2) * im, 0, 6.283); ctx.fill();
      ctx.restore();
    }
  };

  Game.prototype._drawFlier = function (f) {
    var ctx = this.ctx;
    var e = f.t * f.t * (3 - 2 * f.t);           // smoothstep ease
    var x = f.x + (f.tx - f.x) * e;
    var y = f.y + (f.ty - f.y) * e - Math.sin(f.t * 3.1416) * 60;
    var r = f.r * (1 - 0.45 * f.t);
    var spr = SPR[BODY_SPR[f.key]];
    if (spr) {
      // same fit as the pile, or the gem would visibly pop to a new size the
      // instant it left the jar
      var d = r * sprFit(BODY_SPR[f.key]);
      ctx.drawImage(spr, x - d / 2, y - d / 2, d, d);
      return;
    }
    ctx.fillStyle = f.col;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill();
    ctx.fillStyle = f.hi;
    ctx.beginPath(); ctx.arc(x - r * 0.25, y - r * 0.3, r * 0.35, 0, 6.283); ctx.fill();
  };

  // THE CURRENCY HAS A FACE NOW. Three screens drew the coin as a filled arc
  // with two stroked rings on top — the in-shift HUD, the menu chrome and the
  // shop's price rows — which made the one symbol every screen shares the only
  // thing still built from primitives. Vanus: "on the top right it's just a
  // basic circle and on the homepage on the top left there's no icon".
  //
  // One helper, so a coin is the same object wherever it appears, and it falls
  // back to the old primitive if the sprite has not loaded yet (a cold
  // WKWebView boot paints a frame or two before the art arrives).
  function drawCoin(ctx, x, y, r) {
    var spr = SPR.ui_coin;
    if (spr) { ctx.drawImage(spr, x - r, y - r, r * 2, r * 2); return; }
    ctx.fillStyle = '#e8a53c';
    ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill();
    ctx.strokeStyle = '#8a5f1c'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.stroke();
  }

  Game.prototype._drawOrders = function () {
    var ctx = this.ctx;
    // the clothesline the ad promised: a rope sagging gently across the top
    ctx.strokeStyle = '#6b4a2f'; ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-8, ORDER_Y - 10);
    ctx.quadraticCurveTo(VIEW_MIN_W / 2, ORDER_Y - 2, VIEW_MIN_W + 8, ORDER_Y - 10);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,235,200,0.25)'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-8, ORDER_Y - 11);
    ctx.quadraticCurveTo(VIEW_MIN_W / 2, ORDER_Y - 3, VIEW_MIN_W + 8, ORDER_Y - 11);
    ctx.stroke();
    for (var s = 0; s < 5; s++) {
      var o = this.orders[s];
      var x = 14 + s * (ORDER_W + 8);
      var sway = Math.sin(this.worldT * 1.15 + s * 1.7) * 0.022
               + (o.flash > 0 ? Math.sin(this.worldT * 14) * 0.05 * o.flash : 0);
      var dropY = o.dropT ? -(o.dropT * o.dropT) * 150 : 0;
      ctx.save();
      ctx.translate(x + ORDER_W / 2, ORDER_Y - 6 + dropY);
      ctx.rotate(sway);
      ctx.translate(-(x + ORDER_W / 2), -(ORDER_Y - 6));
      // clothespin clip
      ctx.fillStyle = '#a97c4f';
      rr(ctx, x + ORDER_W / 2 - 5, ORDER_Y - 14, 10, 16, 3); ctx.fill();
      ctx.strokeStyle = 'rgba(60,35,18,0.5)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x + ORDER_W / 2, ORDER_Y - 12); ctx.lineTo(x + ORDER_W / 2, ORDER_Y - 2); ctx.stroke();
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      rr(ctx, x + 1.5, ORDER_Y + 3, ORDER_W, ORDER_H, 9); ctx.fill();
      ctx.fillStyle = o.flash > 0 ? mix('#fbf3e2', '#ffe9a8', o.flash) : '#fbf3e2';
      rr(ctx, x, ORDER_Y, ORDER_W, ORDER_H, 9); ctx.fill();
      ctx.fillStyle = 'rgba(201,168,106,0.22)';
      rr(ctx, x, ORDER_Y, ORDER_W, 16, 9); ctx.fill();
      ctx.strokeStyle = o.cls === 'timed' ? '#d98a3c' : '#c0ac8a';
      ctx.lineWidth = o.cls === 'timed' ? 2 : 1.5;
      rr(ctx, x, ORDER_Y, ORDER_W, ORDER_H, 9); ctx.stroke();
      ctx.fillStyle = o.cls === 'timed' ? '#b0552a' : '#6b5d49';
      ctx.font = fT(10, 'bold');
      ctx.textBaseline = 'top';
      // RUSH cards give up the centre: the countdown dial sits on the right
      if (o.cls === 'timed') {
        ctx.textAlign = 'left';
        ctx.fillText('RUSH', x + 8, ORDER_Y + 6);
      } else {
        ctx.textAlign = 'center';
        ctx.fillText('ORDER', x + ORDER_W / 2, ORDER_Y + 6);
      }
      ctx.textAlign = 'center';
      // every requirement stays visible; filled rows get a check, never vanish
      var keys = Object.keys(o.total);
      var rowH = keys.length > 3 ? 14 : 19;     // a 5-type big order must fit
      var icon = keys.length > 3 ? 13 : 17;
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var gy = ORDER_Y + 22 + i * rowH;
        var spr = SPR[BODY_SPR[key]];
        if (spr) ctx.drawImage(spr, x + 8, gy - 2, icon, icon);
        // the SAME symbol the jar stamps, so a card and a gem are matched on
        // silhouette rather than on hue
        if (Meta.data.marks === 1) gemMark(ctx, key, x + 8 + icon / 2, gy - 2 + icon / 2, icon * 0.30);
        else {
          ctx.fillStyle = TYPE[key].col;
          ctx.beginPath(); ctx.arc(x + 16, gy + 6, 7, 0, 6.283); ctx.fill();
        }
        var n = o.need[key];
        var cov = Math.min(this._bagCount(key), n);
        ctx.font = fT(12, 'bold');
        ctx.textAlign = 'left';
        if (cov >= n) {
          ctx.fillStyle = '#3f8f4f';
          ctx.fillText('✓', x + 30, gy);
        } else {
          ctx.fillStyle = cov > 0 ? '#8a6f2f' : '#4c4234';
          ctx.fillText(cov + '/' + n, x + 30, gy);
        }
      }
      ctx.fillStyle = '#8a7b62'; ctx.font = fT(11, 'bold');
      ctx.textAlign = 'center';
      ctx.fillText(o.pay + 'c', x + ORDER_W / 2, ORDER_Y + ORDER_H - 16);
      // THE RUSH CLOCK. This is the game's only clock, and it used to be a
      // 62x3 hairline with no number — 2.8pt on a phone — so a 45-second
      // countdown was running that the player could not see. It is now the
      // shrinking-arc idiom the choice hover already uses, with the seconds
      // spelled out and the whole card breathing under 12s.
      if (o.cls === 'timed' && o.expiresAt < Infinity) {
        var remain = Math.max(0, o.expiresAt - this.worldT);
        var frac = Math.max(0, Math.min(1, remain / CFG.timedDur));
        var urgent = remain <= 12;
        var kcol = remain <= 6 ? '#e2402c' : urgent ? '#e8843c' : '#d9a44c';
        var kx = x + ORDER_W - 14, ky = ORDER_Y + 10;
        if (urgent) {                        // the card itself gets anxious
          var beat = 0.5 + 0.5 * Math.sin(this.worldT * (remain <= 6 ? 11 : 7));
          ctx.strokeStyle = kcol;
          ctx.globalAlpha = 0.35 + beat * 0.5;
          ctx.lineWidth = 2.5;
          rr(ctx, x - 2, ORDER_Y - 2, ORDER_W + 4, ORDER_H + 4, 10); ctx.stroke();
          ctx.globalAlpha = 1;
        }
        // the dial lives in the card's header band — the requirement rows below
        // are already full at three gem types
        ctx.fillStyle = 'rgba(255,248,232,0.95)';
        ctx.beginPath(); ctx.arc(kx, ky, 10.5, 0, 6.28318); ctx.fill();
        ctx.strokeStyle = 'rgba(120,96,64,0.30)'; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.arc(kx, ky, 9, 0, 6.28318); ctx.stroke();
        ctx.strokeStyle = kcol; ctx.lineWidth = 2.5; ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.arc(kx, ky, 9, -1.5708, -1.5708 + 6.28318 * frac);
        ctx.stroke();
        ctx.lineCap = 'butt';
        ctx.fillStyle = kcol;
        ctx.font = fT(10, 'bold');
        ctx.textBaseline = 'middle';
        ctx.fillText(String(Math.ceil(remain)), kx, ky + 0.5);
        ctx.textBaseline = 'top';
      }
      ctx.restore();
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }
  };

  Game.prototype._drawBag = function () {
    var ctx = this.ctx;
    var bx0 = bagSlotX(0) - 10, bw = this.bagCap * (BAG_SLOT + BAG_GAP) - BAG_GAP + 20;
    ctx.fillStyle = 'rgba(0,0,0,0.30)';
    rr(ctx, bx0 + 2, BAG_Y - 4 + 3, bw, BAG_SLOT + 8, 10); ctx.fill();
    ctx.fillStyle = '#5c4128';
    rr(ctx, bx0, BAG_Y - 4, bw, BAG_SLOT + 8, 10); ctx.fill();
    ctx.strokeStyle = 'rgba(255,235,200,0.35)'; ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    rr(ctx, bx0 + 3, BAG_Y - 1, bw - 6, BAG_SLOT + 2, 8); ctx.stroke();
    ctx.setLineDash([]);
    for (var i = 0; i < this.bagCap; i++) {
      var x = bagSlotX(i);
      var jam = this.bagFlash > 0;
      ctx.fillStyle = 'rgba(30,22,16,0.72)';
      rr(ctx, x, BAG_Y, BAG_SLOT, BAG_SLOT, 7); ctx.fill();
      ctx.strokeStyle = jam ? mix('#8a6a4a', '#e24b4a', this.bagFlash)
                            : (i < this.bag.length ? '#c9a86a' : 'rgba(201,168,106,0.35)');
      ctx.lineWidth = 1.5;
      rr(ctx, x, BAG_Y, BAG_SLOT, BAG_SLOT, 7); ctx.stroke();
      // the slot a gem was just tossed from: a brief ring that expands and
      // fades, so the eye is told WHICH slot emptied even though the gems
      // behind it have already shuffled one place left
      if (this.tossFlash > 0 && this.tossSlot === i) {
        var tf = this.tossFlash, grow = (1 - tf) * 7;
        ctx.strokeStyle = 'rgba(226,75,74,' + (0.75 * tf).toFixed(2) + ')';
        ctx.lineWidth = 2;
        rr(ctx, x - grow, BAG_Y - grow, BAG_SLOT + grow * 2, BAG_SLOT + grow * 2, 7 + grow);
        ctx.stroke();
      }
      if (i < this.bag.length) {
        var spr = SPR[BODY_SPR[this.bag[i]]];
        // WHICH SLOT IS WASTED. The old test asked "does ANY card want this
        // colour" and stopped there, so a fourth emerald read as live while
        // the whole line between them wanted three — the surplus copies are
        // the ones that jam the satchel, and they were the ones with no mark.
        //
        // The right question is how many of this colour the five cards can
        // absorb IN TOTAL. Cards are paid one full set at a time and the
        // satchel is shared, so a gem whose running copy-index passes the sum
        // of every card's need for it cannot be spent against this line at
        // all. Left-to-right, so the marked copies are the RIGHTMOST ones —
        // which is where a spam-dug run of the same gem piles up.
        var bk = this.bag[i], capacity = 0, held = 0;
        for (var os2 = 0; os2 < 5; os2++) capacity += (this.orders[os2].need[bk] || 0);
        for (var bj = 0; bj <= i; bj++) if (this.bag[bj] === bk) held++;
        var dead = held > capacity;
        if (spr) {
          if (dead) ctx.globalAlpha = 0.35;
          ctx.drawImage(spr, x + 2, BAG_Y + 2, BAG_SLOT - 4, BAG_SLOT - 4);
          ctx.globalAlpha = 1;
          if (Meta.data.marks === 1) {
            gemMark(ctx, bk, x + BAG_SLOT / 2, BAG_Y + BAG_SLOT / 2, BAG_SLOT * 0.22);
          }
          if (dead) {
            ctx.strokeStyle = 'rgba(226,75,74,0.8)'; ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(x + 7, BAG_Y + BAG_SLOT - 7); ctx.lineTo(x + BAG_SLOT - 7, BAG_Y + 7);
            ctx.stroke();
          }
        }
      }
    }
    ctx.font = fT(10, 'bold'); ctx.textBaseline = 'top';
    if (this.bag.length >= this.bagCap) {
      ctx.fillStyle = '#f0a090'; ctx.textAlign = 'center';
      ctx.fillText('BAG FULL — tap a gem to toss it', VIEW_MIN_W / 2, BAG_Y + BAG_SLOT + 4);
    } else {
      ctx.fillStyle = 'rgba(232,220,200,0.5)'; ctx.textAlign = 'left';
      ctx.fillText('BAG', bagSlotX(0) - 32, BAG_Y + 9);
    }
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  };

  Game.prototype._hud = function () {
    var ctx = this.ctx;
    ctx.textBaseline = 'top';
    // coins (rollup display) with a drawn coin
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ffd75e'; ctx.font = fD(20);
    ctx.fillText(String(Math.round(this.displayCoins)), VIEW_MIN_W - 40, 4);
    drawCoin(ctx, VIEW_MIN_W - 25, 15, 10);
    // shift progress
    ctx.fillStyle = '#e8dcc8'; ctx.font = fT(13, 'bold');
    ctx.textAlign = 'left';
    ctx.fillText((this.career ? 'LV ' + this.career.level + ' · ' : '') +
                 'orders ' + this.ordersDone + '/' + this.goalOrders, 15, 1, 150);
    if (this.isDaily) {
      ctx.textAlign = 'center';
      ctx.fillStyle = '#ffd75e'; ctx.font = fT(11, 'bold');
      ctx.fillText('DAILY DIG', VIEW_MIN_W / 2, 6);
      ctx.textAlign = 'left';
    }
    // Toast and coach card: BELOW the jar, not over the pile. They used to
    // print at VIEW_H-130/-118 — inside JAR.bot=642 — so the line telling the
    // player to "dig the glowing gems" painted over twelve glowing gems while
    // 200 world units sat empty underneath.
    // sit ON the counter's plank, clear of both the pile above and the pace below
    var bandY = this._counter ? this._counter.y + 42 : VIEW_H - 130;
    // THE TOAST AND THE COACH SHARED ONE ROW. Both drew their plate at
    // bandY-34 and their text at bandY-20, in two independent ifs with no
    // else — so during the first run any live toast printed underneath the
    // coach's darker plate and the two strings overlapped. It is guaranteed
    // on the first crusted rock, where the CRACKED-IT toast is set on the
    // very tick that promotes tutStep 0 -> 1, and it fires again on the
    // Heartstone hint, on RUSH ORDER LOST, and on both new-verb toasts. Only
    // ever on the first run, which is the worst place for it.
    //
    // ONE OWNER FOR THE ROW, and it is the TRANSIENT one. Stacking them was
    // the first fix and it was wrong: lifting the toast 34 units puts it back
    // over the jar, which is the exact problem the note above records, and
    // there is no room below either — the PACE block sits there. So the toast
    // keeps the safe row and the coach yields for the two or three seconds a
    // toast is alive. The coach is persistent guidance and loses nothing by
    // waiting; "CRACKED IT! Two gems straight to the bag" is feedback about
    // something that just happened and cannot be shown later.
    var toastLive = !!(this.toast && this.worldT < this.toast.until);
    var coachOn = !Meta.data.tutorialDone && this.tutStep < 3 && !toastLive;
    if (toastLive) {
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(20,14,10,0.72)';
      rr(ctx, VIEW_MIN_W / 2 - 172, bandY - 34, 344, 28, 8); ctx.fill();
      ctx.fillStyle = '#ffd75e'; ctx.font = fD(16);
      ctx.textBaseline = 'middle';
      ctx.fillText(this.toast.text, VIEW_MIN_W / 2, bandY - 20, 330);
      ctx.textBaseline = 'top';
    }
    // first-run coach banners (cosmetic guidance; never touches the sim)
    if (coachOn) {
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(20,14,10,0.82)';
      rr(ctx, VIEW_MIN_W / 2 - 168, bandY - 34, 336, 28, 8); ctx.fill();
      ctx.fillStyle = '#ffe9a8'; ctx.font = fT(12, 'bold');
      ctx.textBaseline = 'middle';
      // "skip the rest" taught the player to ignore every rock — including
      // the crusted ones, which are the single best swing in the game. The
      // line was training players out of the mechanic they were asking for.
      // Must fit the 336-wide banner drawn just above: this is one fillText
      // with no wrapping, and the first rewrite overflowed the view on BOTH
      // edges at 72.
      var msg = this.tutStep === 0 ? 'Every swing counts — dig gems, crack sparkly rocks.'
              : this.tutStep === 1 ? 'Nice! Complete the FULL set and the order pays out.'
              : 'That\'s the job! Tap a bagged gem to toss it back.';
      ctx.fillText(msg, VIEW_MIN_W / 2, bandY - 20);
      ctx.textBaseline = 'top';
    }
    // THE CEILING IS 30, NOT 44. _drawOrders hangs the clothesline from
    // ORDER_Y-10=34 (sagging to 42 at centre) and its clothespins start at
    // ORDER_Y-14=30. The meter used to sit at y=31..41, which drew the swing
    // budget \u2014 the single most important number in the game \u2014 straight THROUGH
    // the rope and through the pins above cards 1 and 2. Nothing in this row
    // may extend past y=28.
    // Clamped at 1: the fill is `104 * sfrac` with no bound, so any state where
    // swings exceeds the shift budget draws the bar straight out of its track
    // and under the order cards. Not reachable today — but the cost of the
    // clamp is one call and the cost of being wrong is a bar across the HUD.
    var sfrac = Math.min(1, Math.max(0, this.swings) / this.shiftSwings);
    ctx.font = fT(13);
    ctx.fillStyle = 'rgba(232,220,200,0.9)';
    ctx.fillText('\u26cf', 15, 15);
    ctx.fillStyle = 'rgba(20,12,6,0.6)';
    rr(ctx, 33, 18, 104, 9, 4.5); ctx.fill();
    ctx.fillStyle = sfrac > 0.35 ? '#ffd75e' : sfrac > 0.15 ? '#e8a53c' : '#e24b4a';
    if (sfrac > 0) { rr(ctx, 33, 18, Math.max(6, 104 * sfrac), 9, 4.5); ctx.fill(); }
    ctx.strokeStyle = 'rgba(201,168,106,0.5)'; ctx.lineWidth = 1;
    rr(ctx, 33, 18, 104, 9, 4.5); ctx.stroke();
    // LEFT-ALIGNED, and it has to be. textAlign is still 'center' from the
    // tutorial line above, so this number was centred on x=143 — a two-digit
    // count spanned 136..150 against a bar whose right edge is 137, and it
    // drew straight through it. Three digits (the deeper pick can push the
    // budget past 99) would have been worse. Centred vertically on the bar
    // rather than sharing its 'top' baseline, so the pair reads as one gauge;
    // digits have no descender, so 12px on the bar's midline stays inside the
    // y<=28 ceiling the comment above defends.
    ctx.fillStyle = this.swings <= 5 ? '#f0a090' : 'rgba(232,220,200,0.85)';
    ctx.font = fT(12, 'bold');
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(Math.max(0, this.swings)), 143, 22.5);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
  };

  // ===== THE SHOP COUNTER =================================================
  // The band under the jar is 15-30% of a modern iPhone and was pure backdrop,
  // with the dragon, the hoard, the gear and the toast all pinned to VIEW_H —
  // an AUTHORING constant, not the bottom of anybody's phone — so they floated
  // ~130px above the physical edge and read as broken rather than spacious.
  //
  // The counter is bottom-anchored furniture. It is DRAW-SIDE ONLY: nothing
  // here is ever read by update(). The hoard tap region stays the authored
  // half-plane (x<120, y>VIEW_H-120), which the ledge sits inside on every
  // device, so the scored sell-vs-hoard decision is identical for everyone.
  Game.prototype._layoutCounter = function () {
    var v = this.view;
    var y = JAR.bot + 10;                    // the jar's drawn bottom edge
    var h = Math.max(0, (v.floorY || VIEW_H) - y);
    this._counter = { y: y, h: h, compact: h < 84, l: -v.ox, r: v.w - v.ox };
    return this._counter;
  };

  Game.prototype._drawCounter = function () {
    var ctx = this.ctx, c = this._layoutCounter();
    if (c.h <= 8) return;                    // iPad: the world already reaches the floor
    var w = c.r - c.l;

    // the plank: a lit worktop edge, then the shadowed face below it
    var g = ctx.createLinearGradient(0, c.y, 0, c.y + c.h);
    g.addColorStop(0, 'rgba(96,64,38,0.96)');
    g.addColorStop(0.10, 'rgba(74,48,29,0.96)');
    g.addColorStop(1, 'rgba(34,22,14,0.98)');
    ctx.fillStyle = g;
    ctx.fillRect(c.l, c.y, w, c.h);
    ctx.fillStyle = 'rgba(214,168,104,0.55)';       // the front lip catches the lamp
    ctx.fillRect(c.l, c.y, w, 3);
    ctx.fillStyle = 'rgba(0,0,0,0.30)';
    ctx.fillRect(c.l, c.y + 3, w, 4);
    // plank seams
    ctx.strokeStyle = 'rgba(20,12,6,0.35)'; ctx.lineWidth = 1;
    for (var pk = 1; pk < 4; pk++) {
      var px = c.l + (w / 4) * pk;
      ctx.beginPath(); ctx.moveTo(px, c.y + 7); ctx.lineTo(px, c.y + c.h); ctx.stroke();
    }

    this._drawHoardLedge(c);
    this._drawPace(c);
    // NOT on the results screen. _drawResults paints its own live gear over its
    // scrim (§3n); this one would sit under it, dimmed but visible, as a second
    // gear on the same screen that answers to nothing.
    if (this.state !== 'results') this._drawGear(c);
  };

  // the dragon's ledge: he GROWS with the hoard, and every kept gem is painted
  // on the pile (positions from a hash of the index — render-only, stable)
  Game.prototype._drawHoardLedge = function (c) {
    var ctx = this.ctx;
    var total = Meta.data.hoardTotal;
    // THE DRAGON KEEPS GROWING. He used to be `+ min(total, 24)`, so he
    // stopped at hoard 24 — on the SE's compact counter, at hoard 15 — while
    // the rank ladder now runs past 110 and repeats forever. The collection
    // meta's only VISIBLE payoff saturated in about twenty shifts and every
    // gem after that changed nothing on screen.
    //
    // sqrt keeps early gems feeling generous and late ones still moving, and
    // the physical clamp below (c.h - 6) is what actually bounds him, so the
    // counter can never be overrun whatever the hoard reaches.
    var ds = (c.compact ? 54 : 74) + Math.sqrt(total) * (c.compact ? 1.6 : 3.2);
    if (this.dragonPulse) ds *= 1 + this.dragonPulse * 0.12;
    // he grows with the hoard but never climbs back into the jar — on a short
    // phone (SE, counter 95 units) a maxed dragon would otherwise poke through
    ds = Math.min(ds, c.h - 6);
    var base = c.y + c.h - (c.compact ? 4 : 10);         // where he sits
    var dx = c.l + 10;
    if (total >= 20) {
      // LAMPLIGHT ON GOLD, not a yellow disc. This was a flat arc fill at a
      // solid alpha, so it drew a hard-edged circle behind the dragon that
      // read as a UI badge nobody could explain — Vanus asked what it was.
      // A radial gradient falling to zero reads as the hoard catching light,
      // which is what it was always meant to be. Brightness still climbs with
      // rank; it just stops announcing itself as a shape.
      var arank = hoardRank(total);
      var aa = Math.min(0.30, 0.14 + (arank ? arank.idx : 0) * 0.028);
      var acx = dx + ds / 2, acy = base - ds * 0.42, ar = ds * 0.72;
      var ag = ctx.createRadialGradient(acx, acy, ds * 0.12, acx, acy, ar);
      ag.addColorStop(0, 'rgba(255,222,120,' + aa.toFixed(2) + ')');
      ag.addColorStop(0.55, 'rgba(255,215,94,' + (aa * 0.45).toFixed(2) + ')');
      ag.addColorStop(1, 'rgba(255,215,94,0)');
      ctx.fillStyle = ag;
      ctx.beginPath(); ctx.arc(acx, acy, ar, 0, 6.283); ctx.fill();
    }
    var n = Math.min(total, 24);          // the pile deepens past 16 too
    for (var hi = 0; hi < n; hi++) {
      var hk = hi % 2 === 0 ? 'gem_prism' : ['gem_ruby', 'gem_sapphire', 'gem_amber'][hi % 3];
      var hspr = SPR[hk];
      if (!hspr) continue;
      var gx = dx + 4 + noise01(hi * 3 + 1, 99) * (ds * 0.92);
      var gy = base - 13 - noise01(hi * 3 + 2, 99) * 13;
      ctx.drawImage(hspr, gx, gy, 14, 14);
    }
    var dimg = dragonImage();
    if (dimg) {
      ctx.drawImage(dimg, dx, base - ds, ds, ds);
    }
    // Where he actually landed, for the decorations that must point AT him
    // rather than at the plank he used to sit on. DRAW-side cache, exactly like
    // this._counter: the scored hoard target reads hoardTapRight() instead, so
    // no device value can reach update() through here.
    this._dragonRect = { x: dx, y: base - ds, w: ds, h: ds };
    // the tally sits on the plank BESIDE him, not across his tail
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    var tw = c.compact ? 12 : 14;
    ctx.fillStyle = 'rgba(20,12,6,0.55)';
    rr(ctx, dx + ds - 6, base - ds * 0.30 - 11, 46, 22, 8); ctx.fill();
    ctx.fillStyle = '#e8c9ff';
    ctx.font = fD(tw);
    ctx.fillText('×' + total, dx + ds + 17, base - ds * 0.30);
    if (this.hoard) {
      ctx.fillStyle = '#8fd08a'; ctx.font = fT(11, 'bold');
      ctx.fillText('+' + this.hoard, dx + ds + 17, base - ds * 0.30 + 18);
    }
  };

  // THE CHEAPEST POSSIBLE FINISH, in swings. A lower bound, deliberately —
  // it must never tell a player a shift is over that isn't.
  //
  // The five cards on the line are known exactly: sum what each still needs
  // after the satchel. Orders beyond those five are not drawn yet, so they are
  // costed at SLOT_N.easy = 2, the smallest card the game can deal. Then halve
  // it: a crusted rock pays TWO gems for one swing, which is the best rate in
  // the game, so an unbroken run of perfect crusts is the theoretical floor.
  //
  // Nothing here is seeded, sampled or device-dependent — it is arithmetic over
  // state both players in the same position already share.
  // GEMS STILL OWED to finish the shift. The five cards on the line are known
  // exactly; orders past them are costed at SLOT_N.easy, the smallest card the
  // game can deal. Cheapest-first, so this is a floor and never an alarmist
  // over-estimate.
  Game.prototype._gemsOwed = function () {
    var left = Math.max(0, this.goalOrders - this.ordersDone);
    if (left === 0) return 0;
    var cards = [], s, k, o, rem;
    for (s = 0; s < 5; s++) {
      o = this.orders[s];
      rem = 0;
      for (k in o.need) rem += Math.max(0, o.need[k] - this._bagCount(k));
      cards.push(rem);
    }
    cards.sort(function (a, b) { return a - b; });
    var gems = 0;
    for (var i = 0; i < left; i++) gems += i < cards.length ? cards[i] : SLOT_N.easy;
    return gems;
  };

  // The absolute floor in SWINGS — gems owed, halved, because a crusted rock
  // pays two gems for one swing and that is the best rate in the game. Only
  // the DEAD test may use this: an unbroken run of perfect crusts is not a
  // plan, it is a proof that no plan exists below it.
  Game.prototype._minSwingsLeft = function () {
    return Math.ceil(this._gemsOwed() / 2);
  };

  // THE PACE LINE — the one number the player could never derive. Purely
  // derived state: no new sim input, nothing seeded, identical for two players
  // in the same position. This is what the empty band is FOR.
  //
  // It used to read swings-per-ORDER against the budget's par, which is a fine
  // signal while a shift is alive and a lie once it isn't. Vanus's screenshot:
  // six swings, five orders left — five orders cannot be filled in six swings
  // by any sequence of taps — and the line said "behind — pick your gems", as
  // if picking better would still save it. Measured across 200 shifts, a lost
  // shift plays a mean of 9.24 more swings under that unchanged red label.
  // Pillar 2 forbids manufacturing a loss; quietly implying a won game is
  // still recoverable is the same dishonesty pointed the other way.
  //
  // So the dead case gets its own tier and its own words. The shift does NOT
  // end — free and daily still score coins per rock, and taking that away
  // would punish the player for the jar's failure — but the line stops
  // pretending and says what the remaining swings are actually worth.
  Game.prototype._drawPace = function (c) {
    var ctx = this.ctx;
    var left = Math.max(0, this.goalOrders - this.ordersDone);
    // PAR HAS TO BE THE PAR FOR *THIS* MOMENT, NOT THE SHIFT AVERAGE.
    //
    // It was `shiftSwings / goalOrders` — 5.50 for a 55/10 shift — compared
    // against `swings / left`, which starts at exactly 5.50 and drops below it
    // on the FIRST swing, because a swing is spent before any order can
    // possibly be filled. So the line went amber on swing 2 of 55 in 200 of
    // 200 measured shifts and mostly stayed there, and its red tier was a
    // false alarm in 54.5% of the shifts that later finished fine. A warning
    // that is on almost always is not a warning; it is the background.
    //
    // The honest comparison is against the GEMS STILL OWED, because that is
    // what the swings have to buy. A gem costs about one swing — geodes pay
    // two and rock in the way costs extra, and those roughly cancel — so
    // owed x1.25 is comfortable, owed x0.9 is on the line, and below the
    // geode-optimistic floor it is over. The floor is used ONLY for the dead
    // test; using it as the "you're fine" bar would call 24 swings against 29
    // owed gems comfortable, which it is not.
    var owed = left > 0 ? this._gemsOwed() : 0;
    var floor = Math.ceil(owed / 2);
    var dead = left > 0 && this.swings < floor;
    var have = this.swings;
    var ok = left === 0 || have >= owed * 1.25;
    var tight = have >= owed * 0.9;
    var col = left === 0 ? '#ffd75e' : dead ? '#b8867a'
            : ok ? '#8fd08a' : tight ? '#e8c45e' : '#e2705a';
    var cx = c.l + (c.r - c.l) / 2 + (c.compact ? 30 : 18);
    var cy = c.y + (c.compact ? c.h / 2 : c.h * 0.42);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(232,220,200,0.45)';
    ctx.font = fT(9, 'bold');
    ctx.fillText('PACE', cx, cy - (c.compact ? 11 : 15));
    ctx.fillStyle = col;
    ctx.font = fD((c.compact ? 15 : 19));
    ctx.fillText(left === 0 ? 'ALL FILLED'
               : dead ? "can't fill " + left + ' more'
               : this.swings + ' swings · ' + left + ' left', cx, cy + 2);
    // The sub-line is the only place the words live, so the dead state must
    // survive the compact band too — a colour-only signal for "this shift is
    // over" is exactly the unreadable state this whole pass is about.
    if (!c.compact || dead) {
      ctx.fillStyle = 'rgba(232,220,200,0.5)';
      ctx.font = fT(11);
      ctx.fillText(left === 0 ? 'cash out the leftovers'
                 : dead ? this.swings + ' swings left · dig rock for coins'
                 : ok ? 'comfortably ahead' : tight ? 'on the line' : 'behind — pick your gems',
                 cx, cy + (c.compact ? 13 : 20));
    }
  };

  // a real 44pt-class button, not a floating glyph with its hit box elsewhere
  Game.prototype._drawGear = function (c) {
    this._drawGearAt(this.gearRect());
  };

  // The same gear, drawn from whatever rect the screen owns. Settings used to
  // be reachable ONLY from the shift — the home screen had no way to turn the
  // music off at all, which is where a player actually wants that switch.
  Game.prototype._drawGearAt = function (b) {
    var ctx = this.ctx;
    var ta = ctx.textAlign, tb = ctx.textBaseline;
    ctx.fillStyle = 'rgba(20,12,6,0.45)';
    rr(ctx, b.x, b.y, b.w, b.h, 10); ctx.fill();
    ctx.strokeStyle = 'rgba(201,168,106,0.35)'; ctx.lineWidth = 1;
    rr(ctx, b.x, b.y, b.w, b.h, 10); ctx.stroke();
    // DRAWN, not typed. '⚙' has no text glyph on iOS, so system-ui falls
    // through to Apple Color Emoji and the gear renders as a full-colour icon
    // in an otherwise monochrome gold-and-cream chrome row — in three places
    // now (menu, shop, in-shift). A path obeys the palette and scales cleanly.
    var cx = b.x + b.w / 2, cy = b.y + b.h / 2, R = Math.min(b.w, b.h) * 0.28;
    ctx.fillStyle = 'rgba(232,220,200,0.82)';
    ctx.beginPath();
    for (var i = 0; i < 8; i++) {
      var a0 = i * 0.7854 - 0.15, a1 = i * 0.7854 + 0.15;
      var a2 = a1 + 0.13, a3 = a0 + 0.7854 - 0.13;
      ctx.lineTo(cx + Math.cos(a0) * R * 1.36, cy + Math.sin(a0) * R * 1.36);
      ctx.lineTo(cx + Math.cos(a1) * R * 1.36, cy + Math.sin(a1) * R * 1.36);
      ctx.lineTo(cx + Math.cos(a2) * R, cy + Math.sin(a2) * R);
      ctx.lineTo(cx + Math.cos(a3) * R, cy + Math.sin(a3) * R);
    }
    ctx.closePath();
    // The hub is a REVERSED subpath filled even-odd — a donut in one fill.
    // 'destination-out' would have been the obvious way to punch it and is
    // wrong: it erases every layer already painted, so the hole went through
    // the chip, the wallpaper and the canvas to the page behind.
    ctx.moveTo(cx + R * 0.44, cy);
    ctx.arc(cx, cy, R * 0.44, 0, 6.283, true);
    ctx.fill('evenodd');
    ctx.textAlign = ta; ctx.textBaseline = tb;
  };

  // ===== SETTINGS — one panel, reachable everywhere, dismissable ============
  // It used to live inside the `state === 'paused'` draw branch, which had two
  // consequences the owner hit immediately:
  //   1. the HOME screen could not open it at all, so the music could only be
  //      turned off from inside a shift;
  //   2. taps that missed the four buttons did NOTHING, so the panel was a trap
  //      you could only leave through RESUME. Every other phone game closes on
  //      an outside tap.
  // Now it is an overlay drawn on top of WHATEVER screen is underneath, with
  // one rect table shared by the draw and the hit test.
  // SET_FOOT, not SET_PAD, at the bottom: the 'tap outside to close' hint needs
  // its own band. At 18 the hint cleared the last row by 3 units and _menuBtn
  // draws its soft shadow 4 below the button, so the two collided.
  var SET_ROW_H = 52, SET_GAP = 12, SET_HEAD = 56, SET_PAD = 18, SET_FOOT = 40, SET_W = 300;
  Game.prototype.settingsRects = function () {
    // Derived from state, never stored: a flag set at open time is one more
    // thing that can disagree with reality after a lifecycle pause.
    var inShift = this.state === 'paused' || this.state === 'playing';
    // HINTS is a real setting, not an apology for one. The jar's three marks
    // (dig-light, gold "a card wants it", violet "something holds it") are
    // meant to be legible without being asked for — but Vanus's first read of
    // them was "are the circles only when toggled on in settings ... i dont
    // get it", and a player who finds the jar busy should be able to quiet it
    // rather than put the game down. Default ON, and it never touches the
    // dig-light: which gems are reachable is the game's core readability, not
    // a hint, and turning THAT off would recreate the bug this whole pass
    // exists to fix.
    // RESTORE IS NOT OPTIONAL. Apple rejects any app with a non-consumable IAP
    // that lacks an explicit, user-tapped Restore Purchases control (3.1.1).
    // It also has to be FINDABLE by someone who has already bought — such a
    // player never opens the paywall again, so the paywall's own restore button
    // is not enough on its own. Hidden once owned, because there is then
    // nothing left to restore and a dead control invites a support email.
    var canRestore = Store.available() && !Ent.owned();
    var ids = inShift ? ['music', 'sound', 'hints', 'marks', 'resume', 'quit']
                      : ['music', 'sound', 'hints', 'marks']
                          .concat(canRestore ? ['restore'] : [])
                          .concat(['done']);
    var ph = SET_HEAD + SET_PAD + ids.length * SET_ROW_H + (ids.length - 1) * SET_GAP + SET_FOOT;
    var px = VIEW_MIN_W / 2 - SET_W / 2;
    var py = Math.round(VIEW_H / 2 - ph / 2);
    var out = {
      panel: { x: px, y: py, w: SET_W, h: ph },
      // 50 square: this was 40 (35.7pt on an SE3) and it is the explicit way
      // out of the settings panel for anyone who does not guess the scrim.
      close: { x: px + SET_W - 56, y: py + 6, w: 50, h: 50 },
      rows: [],
    };
    for (var i = 0; i < ids.length; i++) {
      out.rows.push({
        id: ids[i], x: px + 20, y: py + SET_HEAD + SET_PAD + i * (SET_ROW_H + SET_GAP),
        w: SET_W - 40, h: SET_ROW_H,
      });
    }
    return out;
  };

  Game.prototype.openSettings = function () {
    this.showSettings = true;
    this._quitArmed = 0;              // never open already armed
    // Pausing is only meaningful mid-shift; from the menu there is nothing to
    // pause, and setPaused would have been a silent no-op that left the panel
    // undrawn (it was gated on state === 'paused').
    if (this.state === 'playing') this.setPaused(true);
  };
  Game.prototype.closeSettings = function () {
    this.showSettings = false;                       // BEFORE setPaused — it consults this
    if (this.state === 'paused') this.setPaused(false);
  };

  Game.prototype._drawSettings = function () {
    if (!this.showSettings) return;
    var ctx = this.ctx, v = this.view;
    var R = this.settingsRects(), p = R.panel;
    ctx.fillStyle = 'rgba(12,8,5,0.68)';
    ctx.fillRect(-v.ox, -v.uiTop, v.w, v.h + v.uiTop);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';

    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    rr(ctx, p.x + 3, p.y + 6, p.w, p.h, 18); ctx.fill();
    ctx.fillStyle = '#2b2018';
    rr(ctx, p.x, p.y, p.w, p.h, 18); ctx.fill();
    ctx.strokeStyle = 'rgba(201,168,106,0.8)'; ctx.lineWidth = 2;
    rr(ctx, p.x, p.y, p.w, p.h, 18); ctx.stroke();

    ctx.fillStyle = '#ffe9a8'; ctx.font = fD(24);
    ctx.fillText('SETTINGS', p.x + p.w / 2, p.y + 16);
    ctx.strokeStyle = 'rgba(201,168,106,0.3)'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(p.x + 22, p.y + SET_HEAD - 4); ctx.lineTo(p.x + p.w - 22, p.y + SET_HEAD - 4);
    ctx.stroke();

    // ✕ — the explicit way out, for anyone who does not try the scrim
    ctx.fillStyle = 'rgba(232,220,200,0.65)'; ctx.font = fD(20);
    ctx.fillText('✕', R.close.x + R.close.w / 2, R.close.y + 14);   // centred in the 50-square

    for (var i = 0; i < R.rows.length; i++) {
      var r = R.rows[i];
      if (r.id === 'music' || r.id === 'sound' || r.id === 'hints' || r.id === 'marks') {
        var on = r.id === 'music' ? !Snd.musicMuted
               : r.id === 'sound' ? !Snd.sfxMuted
               : r.id === 'hints' ? Meta.data.hints !== 0
               : Meta.data.marks === 1;
        ctx.fillStyle = 'rgba(20,12,6,0.5)';
        rr(ctx, r.x, r.y, r.w, r.h, 12); ctx.fill();
        ctx.strokeStyle = 'rgba(201,168,106,0.35)'; ctx.lineWidth = 1.5;
        rr(ctx, r.x, r.y, r.w, r.h, 12); ctx.stroke();
        ctx.textAlign = 'left';
        ctx.fillStyle = '#e8dcc8'; ctx.font = fD(17);
        ctx.fillText(r.id === 'music' ? 'Music'
                   : r.id === 'sound' ? 'Sound effects'
                   : r.id === 'hints' ? 'Hints in the jar'
                   : 'Gem symbols', r.x + 16, r.y + 17);
        // a switch that shows its state in COLOUR as well as in words, so it
        // still reads without the label
        var sw = { x: r.x + r.w - 76, y: r.y + 11, w: 60, h: 30 };
        ctx.fillStyle = on ? '#6a8f4a' : 'rgba(70,56,44,0.9)';
        rr(ctx, sw.x, sw.y, sw.w, sw.h, 15); ctx.fill();
        ctx.fillStyle = on ? '#eaf6d8' : 'rgba(200,186,166,0.7)';
        ctx.beginPath();
        ctx.arc(on ? sw.x + sw.w - 15 : sw.x + 15, sw.y + 15, 11, 0, 6.283); ctx.fill();
        ctx.textAlign = 'center';
        ctx.fillStyle = on ? '#dfeecb' : 'rgba(200,186,166,0.65)';
        ctx.font = fT(10, 'bold');
        ctx.fillText(on ? 'ON' : 'OFF', on ? sw.x + 19 : sw.x + 42, sw.y + 10);
      } else {
        // QUIT is two-step. It sits one row from RESUME in a uniform stack and
        // destroys an in-progress run — including a 250c deeper-pick attempt —
        // with a single tap and no undo.
        var armed = r.id === 'quit' && this._quitArmed > nowMs();
        var label = r.id === 'resume' ? 'RESUME'
                  : r.id === 'quit' ? (armed ? 'TAP AGAIN TO QUIT' : 'QUIT SHIFT')
                  : r.id === 'restore' ? (Store.busy ? 'RESTORING\u2026' : 'RESTORE PURCHASE')
                  : 'DONE';
        this._menuBtn(label, r.y, { w: r.w, h: r.h,
                                    quiet: (r.id === 'quit' && !armed) || r.id === 'restore',
                                    disabled: r.id === 'restore' && Store.busy });
      }
    }

    ctx.fillStyle = 'rgba(232,220,200,0.42)'; ctx.font = fT(11);
    ctx.fillText('tap outside to close', p.x + p.w / 2, p.y + p.h - 22, p.w - 40);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  };

  Game.prototype._settingsTap = function (w) {
    var R = this.settingsRects();
    if (inRect(w, R.close)) { Snd.pop(); this.closeSettings(); return; }
    for (var i = 0; i < R.rows.length; i++) {
      var r = R.rows[i];
      if (!inRect(w, r)) continue;
      if (r.id === 'restore') {
        // Loud and user-tapped, as 3.1.1 requires. Finding the entitlement
        // already present is a SUCCESS, not a no-op — say so either way.
        Snd.pop();
        Store.restore(function (got) { if (got) { Snd.fanfare(150); Hap.medium(); } });
        return;
      }
      if (r.id === 'music') { Snd.setMusicMuted(!Snd.musicMuted); Snd.pop(); }
      else if (r.id === 'sound') { Snd.setSfxMuted(!Snd.sfxMuted); Snd.pop(); }
      else if (r.id === 'hints') {
        Meta.data.hints = Meta.data.hints === 0 ? 1 : 0;
        Meta.save(); Snd.pop();
      }
      else if (r.id === 'marks') {
        Meta.data.marks = Meta.data.marks === 1 ? 0 : 1;
        Meta.save(); Snd.pop();
      }
      else if (r.id === 'resume' || r.id === 'done') { Snd.pop(); this.closeSettings(); }
      else if (r.id === 'quit') {
        if (this._quitArmed > nowMs()) {
          this._quitArmed = 0;
          this.showSettings = false;
          this.state = 'menu';
          Snd.scene('shop');
        } else {
          this._quitArmed = nowMs() + 2600;   // the row re-labels itself
          Snd.thunk();
        }
      }
      return;
    }
    // Anywhere else — scrim included — closes. This is the whole point.
    if (!inRect(w, R.panel)) { this.closeSettings(); }
  };

  // ONE definition of the gear box, shared by the draw and the pointer
  // listener — they used to be ~20 units apart.
  Game.prototype.gearRect = function () {
    var c = this._counter || this._layoutCounter();
    // 50 world units clears the 44pt touch floor on the SMALLEST device
    // (SE3 scale 0.893 -> 44.6pt); everything else is bigger.
    var s = 50;
    return { x: c.r - s - 10, y: c.y + Math.max(6, (c.h - s) / 2), w: s, h: s };
  };

  // THE DILEMMA'S TAP TARGETS — ONE definition, shared by _drawChoice and the
  // pointer chain. It is the law gearRect() and menuRect() already live under,
  // and the choice was the last surface still keeping two sets of magic numbers.
  //
  // They disagreed, and the disagreement WAS the bug. The gem's hit circle
  // (r=60 at cx) was tested FIRST and reached x=270, while "↙ HOARD" was
  // PAINTED from x=238 — so the left 56% of the word HOARD, the arrow glyph
  // included, resolved as USE IT and flew the prism into the satchel. Measured
  // through the shipped pointer path at 430x932: taps at x=236..260 on the
  // HOARD caption all bagged the gem; only x>=264 hoarded. The colossus was
  // worse — "↙ GIFT (+12 hoard)" runs x=233..343, of which the first third
  // SOLD it, the middle third gifted it, and the last third fell past the
  // caption box (which stopped at x=306) into nothing at all.
  //
  // Vanus, from the phone: "when you try to hoard, it doesn't actually go to
  // the dragon below ... when I say use it it just goes to my bag". Both halves
  // are one defect. The previous pass added the targets he said were missing;
  // it did not check that they covered the words they were named after.
  //
  // Two labelled plates now. 50 world units tall is 44.6pt on an SE3 — the
  // floor gearRect() is authored against — and the 104-unit gutter between them
  // belongs to NEITHER, with the hovering gem sitting in it, so a finger that
  // misses cannot resolve the choice by accident in either direction.
  Game.prototype.choiceRects = function () {
    var cy = JAR.top + 48, h = 50, w = 150;
    return {
      cx: VIEW_MIN_W / 2, cy: cy,
      use:   { x: 8,   y: cy - h / 2, w: w, h: h },
      hoard: { x: 262, y: cy - h / 2, w: w, h: h },
      // the dead band between them: swallowed, never resolved. A tap here used
      // to fall through to the dig path and spend a swing on whatever body sat
      // under the hover.
      gutter: { x: 158, y: cy - h / 2, w: 104, h: h },
    };
  };

  // One plate of the dilemma, drawn in _menuBtn's grammar (cast shadow,
  // vertical gradient body, top bevel, dark under-edge, toned rim) so the pair
  // reads as furniture from the same shop and not as two debug rectangles.
  //
  // The SUB LINE is the teaching. "USE IT" never said where the gem went, and
  // the answer — the satchel, not the card the arrow pointed at — is the other
  // half of what Vanus could not work out. A permanent line on the plate beats
  // a toast: it is there every time the dilemma opens, not once ever.
  function choicePlate(ctx, r, title, sub, tone, dim) {
    var t = BTN_TONE[tone] || BTN_TONE.wood;
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    rr(ctx, r.x + 2, r.y + 4, r.w, r.h, 12); ctx.fill();
    var g = ctx.createLinearGradient(0, r.y, 0, r.y + r.h);
    g.addColorStop(0, dim ? '#3a2f26' : t.top);
    g.addColorStop(1, dim ? '#2d251e' : t.bot);
    ctx.fillStyle = g;
    rr(ctx, r.x, r.y, r.w, r.h, 12); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    rr(ctx, r.x, r.y + r.h - 6, r.w, 6, 12); ctx.fill();
    ctx.strokeStyle = dim ? 'rgba(150,132,110,0.30)' : t.rim;
    ctx.lineWidth = dim ? 1.5 : 2;
    rr(ctx, r.x, r.y, r.w, r.h, 12); ctx.stroke();
    if (!dim) {
      ctx.strokeStyle = 'rgba(255,246,220,0.30)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(r.x + 14, r.y + 4); ctx.lineTo(r.x + r.w - 14, r.y + 4); ctx.stroke();
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = dim ? 'rgba(200,186,166,0.55)' : t.ink;
    fitT(ctx, title, r.x + r.w / 2, r.y + 23, r.w - 20, 15, 'bold');
    ctx.fillStyle = dim ? 'rgba(200,186,166,0.42)' : 'rgba(255,248,232,0.66)';
    fitT(ctx, sub, r.x + r.w / 2, r.y + 39, r.w - 14, 10.5);
    ctx.textAlign = 'left';
  }

  // The prism dilemma: the gem hovers between its two futures. The wanting
  // card glows gold, the dragon glows violet, a shrinking arc is the clock.
  Game.prototype._drawChoice = function () {
    var ctx = this.ctx, c = this.choice, R = this.choiceRects();
    // hover INSIDE the jar's top: above it sits the bag row now
    var cx = R.cx, cy = R.cy;
    var pulse = 1 + Math.sin(this.worldT * 6) * 0.06;
    var frac = Math.max(0, (c.until - this.worldT) / CHOICE_SECS);
    if (c.slot >= 0) {
      var ox = 14 + c.slot * (ORDER_W + 8);
      ctx.strokeStyle = 'rgba(255,215,94,0.9)'; ctx.lineWidth = 3;
      rr(ctx, ox - 2, ORDER_Y - 2, ORDER_W + 4, ORDER_H + 4, 10); ctx.stroke();
    }
    // The dragon's "give it to me" ring, ON THE DRAGON.
    //
    // It was anchored to the COUNTER (l+46, y+h-44) at a fixed radius of 46,
    // which was right while he was a fixed 74 units wide and wrong from the
    // moment he started growing. Measured at 430x932: the ring's centre sits
    // 3.2 units off his at hoard 0, 26.6 at hoard 110 and 49.4 at hoard 423 —
    // by then it is a circle drawn low and left of him, around the plank. The
    // one mark that says "give it to me" stopped pointing at the thing.
    //
    // _dragonRect is a DRAW-side cache (like this._counter) and the scored
    // region reads hoardTapRight() instead, so following the art here still
    // cannot let the phone reach the decision.
    var dr = this._dragonRect;
    var lgx = dr ? dr.x + dr.w / 2 : 50, lgy = dr ? dr.y + dr.h / 2 : VIEW_H - 70;
    var lgr = dr ? Math.max(46, dr.w * 0.54) : 46;
    ctx.strokeStyle = 'rgba(232,201,255,0.8)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(lgx, lgy, lgr + Math.sin(this.worldT * 5) * 4, 0, 6.283); ctx.stroke();
    // Career used to bank NO coins, which made "SELL 200c" a dominated choice
    // dressed up with a fanfare, and the label said so. The wallet changed
    // that: a FIRST clear banks its payout, so on a level you have not cleared
    // yet the coins are real money and the dilemma is a genuine one. On a
    // replay it is still dominated — so the plate tells the truth about THIS
    // run rather than about the mode.
    var heart = c.key === 'heartstone';
    var coinsCount = !this.career ||
                     !(Meta.data.careerStars && Meta.data.careerStars[this.career.level] > 0);
    // "SELL" was a lie for the prism: _resolveChoice('order') puts it in the
    // SATCHEL toward the highlighted card, it does not pay coins. Only the
    // heartstone is actually sold — and the sub line now says where the gem
    // goes, which is the question the old one-word label never answered.
    choicePlate(ctx, R.use,
                heart ? 'SELL' : 'USE IT',
                heart ? (coinsCount ? HEART_SELL + ' coins' : 'no coins on a replay')
                      : 'into your satchel',
                'wood', heart && !coinsCount);
    choicePlate(ctx, R.hoard,
                heart ? 'GIFT' : 'HOARD',
                heart ? '+' + HEART_GIFT + ' hoard' : 'Hoardling keeps it',
                'hoard', false);
    // the gem last, in the gutter, ON TOP of nothing it could be confused with
    var spr = (c.key === 'heartstone' && SPR.gem_heartstone) || SPR.gem_prism;
    var d = (c.key === 'heartstone' ? 84 : 52) * pulse;
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 4;
    ctx.arc(cx, cy, 46, -1.5708, -1.5708 + 6.28318 * frac);
    ctx.stroke();
    if (spr) ctx.drawImage(spr, cx - d / 2, cy - d / 2, d, d);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  };

  // ===== THE HOME SCREEN ===================================================
  // ONE definition of every tap target on the menu, shared by _drawMenu and the
  // pointer listener — the same law the gear already lives under (gearRect).
  // Two lists of magic y's is how a button ends up drawn 20 units from the box
  // that answers for it.
  //
  // ALL AUTHORED, never device-derived. `view.floorY` would let the bottom
  // furniture follow the phone, and on a short device (SE, ratio 1.78) it rides
  // UP into the last button while on a tall one it drifts away — an overlap
  // that exists on only some hardware is the worst kind. The whole screen
  // therefore fits inside VIEW_H=720 and reads identically everywhere.
  //
  // The vertical budget, and why nothing may quietly grow:
  //   20  chrome row    coins (left) · SHOP · gear (right). CHROME DOES NOT
  //                     SHIFT (see _menuShift) — it hugs the top like a top bar
  //                     should, and it is the only row allowed above the hero.
  //   80  title         Georgia, matching THE MOLE'S SHOP — the screen that
  //                     already looked right
  //  130  tagline + rule
  //  172  THE MOLE      200 tall on a lit stage. He is the game's face and the
  //                     whole cast law in one image, and the first pass hid him:
  //                     the coin chip sat on his chest, the SHOP button cut him
  //                     off at the waist, and shrinking him to 146 to make room
  //                     for chrome was solving it from the wrong end.
  //  400  career strip  nodes AND their stars, which the CAREER button used to
  //                     cover completely (button top 442 vs stars at 448)
  //  440  status card   daily best + hoard
  //  502  CAREER / 572 DAILY / 642 FREE — captions live INSIDE the buttons now,
  //                     which buys back the 24 units each caption used to spend
  //                     crowding the next button
  //  702  end (18 to spare)
  var MENU = {
    // 50, NOT 46. gearRect() — the in-shift gear — carries the arithmetic in a
    // comment: "50 world units clears the 44pt touch floor on the SMALLEST
    // device (SE3 scale 0.893 -> 44.6pt)". These four copies of the same
    // affordance were authored at 46, which is 41.1pt, and they are the
    // settings door on the menu, the shop, records, the level map and the
    // results screen — every screen except the one that got the arithmetic
    // right. The row keeps its 46 height: it is a wide button, not a square,
    // and 92 x 46 is not a thumb-sized-target problem.
    gear:   { x: VIEW_MIN_W - 64, y: 18, w: 50, h: 50 },
    shop:   { x: VIEW_MIN_W - 164, y: 18, w: 92, h: 50 },   // 44.6pt, and level with the gear
    // the career strip: it painted five tappable-looking nodes and dropped
    // every tap. It is the door to the level map now.
    // wraps the nodes (400 ± 13) and their star pips (420 ± 3.5), and stops at
    // 432 because the status card starts at 440
    strip:  { x: VIEW_MIN_W / 2 - 118, y: 382, w: 236, h: 50 },
    career: { x: VIEW_MIN_W / 2 - 122, y: 502, w: 244, h: 60 },
    daily:  { x: VIEW_MIN_W / 2 - 122, y: 572, w: 244, h: 60 },
    free:   { x: VIEW_MIN_W / 2 - 122, y: 642, w: 244, h: 60 },
  };
  var MENU_BOTTOM = 702;
  var MENU_CHROME = { gear: 1, shop: 1 };   // pinned to the top bar, never shifted
  // the shop screen's own chrome — same gear, same corner, so it is never a
  // dead end without sound controls either
  var SHOP_GEAR = { x: VIEW_MIN_W - 64, y: 18, w: 50, h: 50 };   // 44.6pt on an SE3 — see MENU.gear

  // ===== THE JOB LADDER — the level map ====================================
  // The home strip PAINTED five tappable-looking nodes and dropped every tap,
  // and `careerStars` was write-once with no way back in: a 1-star clear was
  // permanent, which quietly removed the reason to replay the best content in
  // the game. One authored grid, read by the draw and the hit test.
  // LV_GAPY was 9 and the eighth row ran to y=643, straight through the
  // "Levels 1-N are free" line at 622 — the hint was printed across the
  // bottom row of tiles. Nothing could catch it by looking at either piece
  // alone; it is the SUM (LV_TOP + 8 cells + 7 gaps) that collides, so
  // validate.py now computes that sum. VIEW_H is 720 and BACK already ends
  // at 712, so the space has to come out of the grid, not the bottom.
  // LV_CELL stays 52: at the SE3 scale that is 46.4pt, and 48 would put the
  // tap target under the 44pt floor.
  var LV_COLS = 5, LV_CELL = 52, LV_GAPX = 9, LV_GAPY = 6, LV_TOP = 164;
  var LV_X0 = VIEW_MIN_W / 2 - (LV_COLS * LV_CELL + (LV_COLS - 1) * LV_GAPX) / 2;
  var LEVELS_BACK_Y = 656;
  function levelRect(i) {                    // i is 0-based; level = i + 1
    var c = i % LV_COLS, r = (i / LV_COLS) | 0;
    return { x: LV_X0 + c * (LV_CELL + LV_GAPX), y: LV_TOP + r * (LV_CELL + LV_GAPY),
             w: LV_CELL, h: LV_CELL };
  }
  function inRect(w, b) {
    return w.x >= b.x && w.x <= b.x + b.w && w.y >= b.y && w.y <= b.y + b.h;
  }

  // A screen that appears UNDER the player's finger must not accept the tap
  // that is already in flight. 320ms is longer than a flurry's inter-tap gap
  // and shorter than a deliberate reach. DRAW/INPUT SIDE ONLY — `nowMs` is
  // wall-clock and must never be reachable from update().
  var UI_LOCK_MS = 320;
  // Every menu/shop/results button used to commit in total silence with no
  // pressed state — and a screen that changes with no sound is most of what
  // reads as "not a finished game". One tick, used everywhere a chrome button
  // fires. Actions with their own voice (purchases fanfare, the deeper pick
  // fanfares) keep it and do not double up.
  function uiTick() { Snd.pop(); Hap.light(); }
  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
  }

  // The board's `player` column is anon-WRITABLE (the recorded S5 hole: the
  // publishable key ships by design, and the best-of-day grant let anon UPDATE
  // today's rows). Whatever lands there gets painted on the results screen of a
  // 4+ game, so the RENDER refuses to be a billboard: every honest name is
  // minted as 'MOLE-' + 4 hex (game.js ~695) and nothing else is drawn. Zero
  // false positives by construction, and it holds until writes move behind the
  // Edge Function. Belt and braces for the server-side fix, not a substitute.
  function safeName(s) {
    return /^MOLE-[0-9A-F]{4}$/.test(String(s)) ? String(s) : 'MOLE-????';
  }

  // The menu body is authored to 720 so it can never overlap on the SHORTEST
  // phone. On a tall one that leaves ~110 units of bare floor under the last
  // button and the whole screen reads as top-heavy — pinned to the ceiling with
  // a hole beneath it. Centre the body in whatever slack the device actually
  // has. Draw-side only, and it is chrome rather than a scored decision, so
  // §3e2 permits the floorY read; the pointer listener is likewise the one
  // place device geometry is allowed. ONE function feeds both the draw and the
  // hit test, so they cannot disagree about where a button ended up.
  Game.prototype._menuShift = function () {
    // 72, not 48: a 430x932 phone has 122 units of slack, so a 48 cap stopped
    // short of centring and left the body sitting high with a hole beneath it —
    // the very thing the shift exists to fix. The cap is a bound against a
    // freakishly tall viewport, not the working value; half the slack is.
    var slack = (this.view.floorY || VIEW_H) - MENU_BOTTOM;
    return Math.max(0, Math.min(72, Math.round(slack / 2)));
  };
  // WHERE THE SHOP'S BACK BUTTON SITS. One definition, read by the draw AND by
  // the pointer handler, because this file has shipped a drifting pair before.
  //
  // The shop is authored against VIEW_H=720, which is the GUARANTEED budget —
  // the walls and pickaxe tabs end at 696, so on a short device the layout is
  // already full. A 430x932 phone resolves ~910 units, and the extra 190 landed
  // as blurred backdrop under a BACK button floating mid-screen with a void
  // beneath it. That is what read as an unfinished panel.
  //
  // So BACK drops toward the floor and becomes a footer, the way the shop
  // counter under the jar already does. `authoredY` is the floor of the value:
  // on a device with no slack nothing moves at all, and the button can never
  // ride UP into the last row.
  Game.prototype._shopBackY = function (authoredY) {
    var floor = this.view.floorY || VIEW_H;
    return Math.max(authoredY, Math.round(floor - 78));
  };
  Game.prototype.menuRect = function (id) {
    var b = MENU[id];
    if (MENU_CHROME[id]) return b;
    var d = this._menuShift();
    return { x: b.x, y: b.y + d, w: b.w, h: b.h };
  };

  Game.prototype._drawMenu = function () {
    var ctx = this.ctx, v = this.view;
    var cx = VIEW_MIN_W / 2;
    var bg = SPR.backdrop_burrow;
    if (bg) {
      var s = Math.max(v.w / bg.width, v.h / bg.height);
      ctx.drawImage(bg, (v.w - bg.width * s) / 2 - v.ox, (v.h - bg.height * s) / 2 - v.uiTop, bg.width * s, bg.height * s);
      ctx.fillStyle = 'rgba(20,14,10,0.46)';
      ctx.fillRect(-v.ox, -v.uiTop, v.w, v.h + v.uiTop);
    }
    // Vignette. The shop wallpaper is a BUSY painting — shelves of jars edge to
    // edge — and every element sat on top of it at equal contrast, which is
    // most of what made the screen feel cluttered. Darkening the edges and
    // opening a warm pool in the middle gives the hero somewhere to stand.
    var vig = ctx.createRadialGradient(cx, 300, VIEW_MIN_W * 0.30, cx, 320, VIEW_H * 0.78);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(8,5,3,0.62)');
    ctx.fillStyle = vig;
    ctx.fillRect(-v.ox, -v.uiTop, v.w, v.h + v.uiTop);

    ctx.textAlign = 'center'; ctx.textBaseline = 'top';

    // --- chrome row: wallet left, SHOP + gear right -------------------------
    // The coin chip used to be centred at y=258, which is the middle of the
    // mole. Up here it reads as status, and SHOP joins it because a wallet and
    // the place to spend it belong side by side — as a full-width button in the
    // body SHOP was both louder than DAILY DIG and the thing cutting the mole
    // off at the waist.
    var coins = Meta.data.coins || 0;
    ctx.fillStyle = 'rgba(20,12,6,0.62)';
    rr(ctx, 16, 20, 112, 46, 12); ctx.fill();
    ctx.strokeStyle = 'rgba(255,215,94,0.45)'; ctx.lineWidth = 1.5;
    rr(ctx, 16, 20, 112, 46, 12); ctx.stroke();
    ctx.fillStyle = 'rgba(232,220,200,0.55)'; ctx.font = fT(10);
    ctx.fillText('COINS', 78, 26);
    // the chip carried a label and a number and no coin — the one place the
    // currency is named is the one place it had no face
    drawCoin(ctx, 34, 46, 11);
    ctx.fillStyle = '#ffd75e'; ctx.font = fN(20);
    fitText(ctx, coins.toLocaleString() + 'c', 80, 38, 82, fN, 20);
    var sb = MENU.shop;
    ctx.fillStyle = 'rgba(20,12,6,0.62)';
    rr(ctx, sb.x, sb.y, sb.w, sb.h, 12); ctx.fill();
    ctx.strokeStyle = 'rgba(255,215,94,0.45)'; ctx.lineWidth = 1.5;
    rr(ctx, sb.x, sb.y, sb.w, sb.h, 12); ctx.stroke();
    ctx.fillStyle = '#ffe9a8'; ctx.font = fT(15, 'bold');
    ctx.fillText('SHOP', sb.x + sb.w / 2, sb.y + 15);
    this._drawGearAt(MENU.gear);

    // Everything below the top bar rides the centring shift together, so the
    // spacing the layout was authored with survives on every phone.
    var dy = this._menuShift();
    ctx.save();
    ctx.translate(0, dy);

    // --- hero ---------------------------------------------------------------
    // Georgia, not system-ui: the shop screen's serif title is the one heading
    // in the game that already looked professional, and the order cards and
    // parchment are the same family. The floating prism that used to sit on the
    // final W is gone — at 46px the word is wider than the offset assumed, so
    // it landed ON the letter and read as a bubble stuck to the title.
    // A plate under the title band. The backdrop hangs a LIT LANTERN at dead
    // centre, directly behind the wordmark, and gold-on-lantern-glow is the one
    // place this screen loses contrast no matter how the type is weighted.
    var tg = ctx.createLinearGradient(0, 58, 0, 176);
    tg.addColorStop(0, 'rgba(10,6,3,0)');
    tg.addColorStop(0.35, 'rgba(10,6,3,0.46)');
    tg.addColorStop(0.72, 'rgba(10,6,3,0.36)');
    tg.addColorStop(1, 'rgba(10,6,3,0)');
    ctx.fillStyle = tg;
    ctx.fillRect(-v.ox, 58, v.w, 118);

    ctx.font = fD(40);
    ctx.fillStyle = 'rgba(20,12,6,0.8)';
    ctx.fillText('GEMBURROW', cx + 2, 80 + 3, VIEW_MIN_W - 48);
    ctx.fillStyle = '#ffd75e';
    ctx.fillText('GEMBURROW', cx, 80, VIEW_MIN_W - 48);
    ctx.fillStyle = '#e8dcc8'; ctx.font = fD(14, 'italic');
    ctx.fillText('dig gems · fill orders · feed the dragon', cx, 130, VIEW_MIN_W - 40);
    // letterpress rule with a gem for a diamond — the ornament the title lost
    ctx.strokeStyle = 'rgba(201,168,106,0.45)'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - 96, 156); ctx.lineTo(cx - 12, 156);
    ctx.moveTo(cx + 12, 156); ctx.lineTo(cx + 96, 156);
    ctx.stroke();
    if (SPR.gem_prism) ctx.drawImage(SPR.gem_prism, cx - 9, 147, 18, 18);

    // --- THE MOLE, on a lit stage -------------------------------------------
    // 200 units — half the world's width — because he is the cast law, the
    // shop's face and the reason the gem in his hand means anything. Drawn
    // AFTER the pool of light and BEFORE everything else, and nothing is
    // painted over him.
    // MEASURED, not eyeballed. art/mole_keeper.png is a 320px frame whose ink
    // runs y 0.072..0.950 and x 0.091..0.872, so drawn at (cx-100, 172, 200,
    // 200) his feet land at y=362 and his mass centres at cx-4 — not cx. A hard
    // ellipse at 374 sat 12 units BELOW his feet and read as a black hole in
    // the floor rather than a shadow.
    if (SPR.mole_keeper) {
      var spot = ctx.createRadialGradient(cx - 4, 272, 10, cx - 4, 284, 172);
      spot.addColorStop(0, 'rgba(255,214,140,0.22)');
      spot.addColorStop(0.55, 'rgba(255,196,110,0.10)');
      spot.addColorStop(1, 'rgba(255,196,110,0)');
      ctx.fillStyle = spot;
      ctx.fillRect(cx - 194, 128, 388, 310);
      ctx.save();
      ctx.translate(cx - 4, 360);
      ctx.scale(1, 0.185);
      var sh = ctx.createRadialGradient(0, 0, 0, 0, 0, 74);
      sh.addColorStop(0, 'rgba(16,9,4,0.46)');
      sh.addColorStop(0.55, 'rgba(16,9,4,0.22)');
      sh.addColorStop(1, 'rgba(16,9,4,0)');
      ctx.fillStyle = sh;
      ctx.beginPath(); ctx.arc(0, 0, 74, 0, 6.283); ctx.fill();
      ctx.restore();
      ctx.drawImage(SPR.mole_keeper, cx - 100, 172, 200, 200);
    }

    // --- career strip: nodes AND their stars, both visible -------------------
    // It is a BUTTON now (MENU.strip -> the level map), so it has to look like
    // one. Painting five node-shaped targets that swallow every tap was the
    // defect; making them live without saying so would only be quieter.
    var lvl = Meta.data.careerLevel || 1;
    var done = lvl > CAREER_MAX;
    var band0 = Math.floor((Math.min(lvl, CAREER_MAX) - 1) / 5) * 5 + 1;
    var sbx = MENU.strip;
    ctx.fillStyle = 'rgba(20,12,6,0.34)';
    rr(ctx, sbx.x, sbx.y, sbx.w, sbx.h, 14); ctx.fill();
    ctx.strokeStyle = 'rgba(201,168,106,0.3)'; ctx.lineWidth = 1;
    rr(ctx, sbx.x, sbx.y, sbx.w, sbx.h, 14); ctx.stroke();
    ctx.strokeStyle = 'rgba(201,168,106,0.4)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx - 104, 400); ctx.lineTo(cx + 104, 400); ctx.stroke();
    for (var bi2 = 0; bi2 < 5; bi2++) {
      var ln = band0 + bi2;
      var nx = cx - 88 + bi2 * 44;
      var isCur = ln === lvl, done2 = ln < lvl;
      ctx.fillStyle = done2 ? '#c9a86a' : isCur ? '#ffd75e' : 'rgba(90,70,50,0.9)';
      ctx.beginPath(); ctx.arc(nx, 400, isCur ? 13 : 10, 0, 6.283); ctx.fill();
      if (ln % 5 === 0 && SPR.gem_prism) ctx.drawImage(SPR.gem_prism, nx - 8, 392, 16, 16);
      ctx.fillStyle = done2 || isCur ? '#3a2a18' : 'rgba(232,220,200,0.55)';
      ctx.font = fT(11, 'bold'); ctx.textBaseline = 'middle';
      if (ln % 5 !== 0) ctx.fillText(String(ln), nx, 401);
      ctx.textBaseline = 'top';
      var st2 = (Meta.data.careerStars || {})[ln] || 0;
      for (var si2 = 0; si2 < st2; si2++) drawStar(ctx, nx - 8 + si2 * 8, 420, 3.5, '#ffd75e');
    }
    // the chevron does the "this opens something" work a label would, without
    // the 12 vertical units a label would cost between the mole and the card
    ctx.fillStyle = 'rgba(232,220,200,0.55)'; ctx.font = fD(16);
    ctx.textBaseline = 'middle';
    ctx.fillText('›', sbx.x + sbx.w - 13, sbx.y + sbx.h / 2);
    ctx.textBaseline = 'top';

    // --- status card: today's best + the hoard -------------------------------
    var day = dayNumber();
    var best = Meta.data.bestDaily[day] || 0;
    // Drawn THROUGH recordsRects().card, not beside it — the box and the art
    // were two copies of 440/46 and there is no reason for a second.
    var rcard = this.recordsRects().card;
    ctx.fillStyle = 'rgba(30,20,12,0.72)';
    rr(ctx, rcard.x, rcard.y, rcard.w, rcard.h, 12); ctx.fill();
    ctx.strokeStyle = 'rgba(201,168,106,0.5)'; ctx.lineWidth = 1.5;
    rr(ctx, rcard.x, rcard.y, rcard.w, rcard.h, 12); ctx.stroke();
    ctx.fillStyle = '#ffd75e'; ctx.font = fT(13, 'bold');
    // The card carries TWO text lines, a dragon AND a records chevron, so the
    // text column is narrowed and re-centred to leave the right third free.
    // At 196 wide centred on cx-14 the lines run to cx+84, which put the hoard
    // line straight under the RECORDS label and the chevron on top of the
    // dragon — invisible at a high hoard, where the rank line is short, and
    // obvious the moment a save is FRESH and the line reads "hoard: 0 gems".
    fitT(ctx, best > 0 ? ("today's best: " + best.toLocaleString() + 'c') : "today's daily dig awaits",
         cx - 44, 448, 130, 13, 'bold');
    ctx.fillStyle = '#e8c9ff'; ctx.font = fT(12);
    // Show the RANK once the named milestones run out, with the next threshold
    // beside it — otherwise the hoard readout is a number that stopped meaning
    // anything at 20. maxWidth 196 is already enforced by fillText, and the
    // rank line is deliberately the shorter of the two forms.
    var hrk = hoardRank(Meta.data.hoardTotal);
    fitT(ctx, hrk
      ? hrk.name + ' · ' + Meta.data.hoardTotal + '/' + hrk.next
      : 'hoard: ' + Meta.data.hoardTotal + ' gems', cx - 44, 466, 130, 12);
    // dragon, then the records affordance, both in the right third the text
    // column above now leaves clear
    var mdrag = dragonImage();
    if (mdrag) ctx.drawImage(mdrag, cx + 32, 447, 32, 32);
    // The card is the door to RECORDS, and says so. A tappable region with no
    // mark reads as a missing feature, not as a secret.
    ctx.fillStyle = 'rgba(232,201,255,0.7)'; ctx.font = fT(9, 'bold');
    ctx.fillText('RECORDS', cx + 100, 452, 44);
    ctx.fillStyle = 'rgba(255,215,94,0.8)'; ctx.font = fT(14, 'bold');
    ctx.fillText('\u203A', cx + 100, 464);

    // --- the three ways to play ---------------------------------------------
    // THREE UNLABELLED BUTTONS was the whole legibility problem: nothing said
    // what a daily is, that it is shared, or that free is practice. The lines
    // now ride INSIDE each button, where they cannot crowd the next one.
    var totalStars = 0;
    if (Meta.data.careerStars) {
      for (var sk in Meta.data.careerStars) totalStars += Meta.data.careerStars[sk];
    }
    // FIRST RUN POINTS AT CAREER L1, AND ONLY AT CAREER L1.
    //
    // All three doors rendered identically, and tutStep is initialised from
    // tutorialDone inside start() regardless of mode — so the coach ran in
    // whichever button was tapped first and latched permanently four seconds
    // after the first delivery. L1 is the only jar built for it: 8 orders, 53
    // swings, junk 0.38, no prisms, no RUSH, no colossus, and the reroll table
    // deliberately leaves it generous BECAUSE the coach runs there. A free dig
    // is 10 orders / junk 0.45 / a RUSH card ticking from t=0 / 35% heartstone,
    // and the daily is that same harder jar plus a leaderboard row and a
    // once-a-day banking gate — so a fumbled first-ever run also spent the
    // day's only bankable daily. Free carried the most tempting caption of the
    // three.
    var firstRun = !Meta.data.tutorialDone;
    this._menuBtn(done ? 'CAREER · COMPLETE' : 'CAREER · LEVEL ' + lvl, MENU.career.y, {
      w: MENU.career.w, h: MENU.career.h, tone: 'career', icon: 'gem_ruby',
      sub: firstRun ? 'START HERE · the mole shows you the ropes'
         : done ? 'every level cleared · replay the finale'
                : 'the mole’s job ladder · ★ ' + totalStars + '/' + (CAREER_MAX * 3),
    });
    // NAME TODAY. A character nobody can see before they commit is another
    // invisible system, and this project has shipped enough of those.
    var todayChar = dailyCharacter(dayNumber());
    this._menuBtn('DAILY DIG', MENU.daily.y, {
      w: MENU.daily.w, h: MENU.daily.h, tone: 'daily', icon: 'gem_sapphire',
      disabled: firstRun,
      // "after your first shift" WAS NOT TRUE — the button worked. The handler
      // has no tutorialDone test, and the consequences the note above already
      // names all fire: start() sets tutStep from tutorialDone with no mode
      // test, so the three-step coach written for career L1 (8 orders, 53
      // swings, no prisms, no RUSH) runs inside a daily jar that is 10 orders
      // with a RUSH card ticking from t=0 — and the daily banks once per UTC
      // day, so a fumbled first-ever run also spends the day's only payout.
      //
      // Enforced rather than reworded: the caption said what this screen was
      // designed to do, and it is the right thing to do. See the menu handler.
      sub: firstRun ? 'one shared jar · after your first shift'
                    : todayChar.name + ' · one jar, everyone',
    });
    this._menuBtn('FREE DIG', MENU.free.y, {
      w: MENU.free.w, h: MENU.free.h, tone: 'free', icon: 'gem_emerald',
      quiet: firstRun,
      // NOT "practice · no stakes". Free banks coins EVERY shift while career
      // banks first-clear only, so ~33 free digs out-earn the entire 40-level
      // ladder — the mode carrying the economy was labelled as the one that
      // does not count.
      sub: 'a fresh jar · banks coins every shift',
    });
    ctx.restore();
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  };

  // ===== THE SHOP SCREEN ===================================================
  // Rows are authored at fixed y so the hit test and the draw cannot drift —
  // SHOP_ROW_Y/H are read by BOTH _drawShop and the pointer handler.
  var SHOP_ROW_Y = 250, SHOP_ROW_H = 56, SHOP_ROW_GAP = 8;
  // The shop grew a second category and could not grow more ROWS: shopRowY(i)
  // is 250 + i*64 against a 720-tall view, so a seventh wall row would draw
  // its bottom edge at 754. Tabs, matching the records screen.
  var SHOP_TAB_W = 132, SHOP_TAB_H = 34, SHOP_TAB_Y = 210;
  // Eight skins need a tighter row than the wall shop's 56+8, or the last one
  // lands past the view bottom — the same arithmetic that forced these tabs.
  // THE WARDROBE ROWS REACH THE TOUCH FLOOR, and the space came from a band
  // that was already empty.
  //
  // They were 40 tall on a 46 pitch — 41.1pt at the SE3 scale, under the 44pt
  // floor, for a control that EQUIPS something. Growing them looked impossible:
  // the rank line sat at 258 and eight rows of 50 would have ended at 686,
  // past the BACK button, which `_shopBackY` pins no lower than floorY-78
  // (669 on an SE3). But the WALLET CHIP at 168..208 is drawn on the walls tab
  // ONLY — "nothing in the wardrobe costs coins" — so on the two tabs that
  // needed the room, forty units of it were sitting unused above the tabs.
  //
  // The rank/star line moves up into that band, the rows start right under the
  // tabs, and eight of them at a 51 pitch (50 of art, 44.6pt) run 254..662 with
  // BACK still landing at 669. The gap is 1 rather than 6, and the hit band
  // takes the whole pitch, so there is no dead strip between two equip targets.
  var DRAGON_ROW_Y = 254, DRAGON_ROW_H = 50, DRAGON_ROW_GAP = 1;
  function dragonRowY(i) { return DRAGON_ROW_Y + i * (DRAGON_ROW_H + DRAGON_ROW_GAP); }
  // The tally line for both wardrobe tabs, in the wallet chip's empty band.
  var WARDROBE_TALLY_Y = 176;
  // HALF-OPEN, so the bands PARTITION the column: row i owns [y, y+pitch) and
  // the next row owns the boundary. An inclusive `<=` on both ends makes the
  // earlier row win the shared pixel, which is a tap on the top edge of a row
  // equipping the one above it.
  var DRAGON_HIT_H = DRAGON_ROW_H + DRAGON_ROW_GAP;
  // The tab strips are the same problem with room to solve it upward: 34 units
  // is 30.4pt, and every one of them has empty header space above. Growing the
  // pill instead would move the content under it on five screens, and 34 is the
  // right SIZE — it was only ever the wrong TARGET.
  function padHitUp(r, h) {
    h = h || 50;
    return { x: r.x, y: r.y - (h - r.h), w: r.w, h: h };
  }
  // Tinted preview of ONE skin, independent of what is equipped.
  var _skinPrev = {};
  var _pickPrev = {};
  function skinPreview(sk) {
    var base = SPR.dragon_hoardling;
    if (!base) return null;
    if (!sk.tint) return base;
    if (_skinPrev[sk.id]) return _skinPrev[sk.id];
    try {
      var c = document.createElement('canvas');
      c.width = base.width; c.height = base.height;
      var x = c.getContext('2d');
      x.drawImage(base, 0, 0);
      if (sk.dark) { x.fillStyle = 'rgba(0,0,0,' + sk.dark + ')'; x.fillRect(0, 0, c.width, c.height); }
      x.globalCompositeOperation = 'color';
      x.globalAlpha = sk.amt; x.fillStyle = sk.tint;
      x.fillRect(0, 0, c.width, c.height);
      x.globalCompositeOperation = 'destination-in';
      x.globalAlpha = 1; x.drawImage(base, 0, 0);
      x.globalCompositeOperation = 'source-over';
      _skinPrev[sk.id] = c;
      return c;
    } catch (e) { return base; }
  }
  // THREE tabs at 132 need 404 plus gaps against a 420 view. 128 with 4-unit
  // gaps is 392, centred with 14 either side — the sizing the records screen
  // settled on for the same problem.
  function shopTabs() {
    var cx = VIEW_MIN_W / 2, W = 128, G = 4;
    var x0 = cx - (W * 1.5 + G);
    return {
      walls:  { x: x0,               y: SHOP_TAB_Y, w: W, h: SHOP_TAB_H },
      dragon: { x: x0 + W + G,       y: SHOP_TAB_Y, w: W, h: SHOP_TAB_H },
      pick:   { x: x0 + (W + G) * 2, y: SHOP_TAB_Y, w: W, h: SHOP_TAB_H },
    };
  }
  function shopRowY(i) { return SHOP_ROW_Y + i * (SHOP_ROW_H + SHOP_ROW_GAP); }

  // ONE definition, read by the draw AND the hit test — the settings panel
  // shipped with these ~20 units apart once already. BACK is a plain y like
  // every other menu button: _menuBtn takes (label, y, opt) and hitBtn takes
  // (world, y), both assuming the shared 220x56 centred box. Passing a RECT
  // here drew nothing at all — every coordinate inside _menuBtn went NaN and
  // the button silently did not exist, while its hit test still worked.
  var RECORDS_BACK_Y = 640;
  // THREE tabs at 132 would need 404 units plus gaps against a 420-wide view.
  // 128 with 4-unit gaps is 392, centred with 14 either side, and 128 is still
  // a comfortable target — well past the 44pt floor on the smallest phone.
  // FOUR tabs. 4x96 + 3 gaps = 396 in a 420 view, leaving 12 either side, and
  // 96 world units is ~89pt on a 390pt phone — comfortably past the 44pt
  // floor even at four across. Labels are short BECAUSE the row is: this was
  // measured before the tab was added, not after it overflowed.
  // FIVE tabs. 5x76 + 4 gaps = 396 in a 420 view; 76 world units is ~71pt on
  // a 390pt phone, still well past the 44pt floor. Measured before the tab was
  // added, as with the fourth.
  var REC_TAB_Y = 78, REC_TAB_H = 34, REC_TAB_W = 76, REC_TAB_GAP = 4;
  Game.prototype.recordsRects = function () {
    var cx = VIEW_MIN_W / 2, W = REC_TAB_W, G = REC_TAB_GAP;
    var x0 = cx - (W * 2.5 + G * 2);
    return {
      backY: RECORDS_BACK_Y,
      // 50, not 46: this card is the ONLY door to the records screen — the
      // board, the league, the archive and the whole contract board are behind
      // it — and at 46 it was 41.1pt on an SE3, under the floor this file
      // enforces on every other control. The strip above ends at 432 and the
      // CAREER button starts at 502, so the four units come out of the slack
      // and nothing else moves.
      card: { x: cx - 132, y: 438, w: 264, h: 50 },
      tabStats:  { x: x0,                 y: REC_TAB_Y, w: W, h: REC_TAB_H },
      tabBoard:  { x: x0 + (W + G),       y: REC_TAB_Y, w: W, h: REC_TAB_H },
      tabLeague: { x: x0 + (W + G) * 2,   y: REC_TAB_Y, w: W, h: REC_TAB_H },
      tabPast:   { x: x0 + (W + G) * 3,   y: REC_TAB_Y, w: W, h: REC_TAB_H },
      tabJobs:   { x: x0 + (W + G) * 4,   y: REC_TAB_Y, w: W, h: REC_TAB_H },
    };
  };

  // The 14-day league, cached like the daily board. `state` carries a fourth
  // value the board does not have: 'closed', meaning the view is not published
  // yet (tools/leaderboard-league.sql has not been run). That is a normal
  // state, not a failure, so it gets its own copy.
  Game.prototype._loadLeague = function (force) {
    var b = this._league;
    if (!force && b && nowMs() - b.at < 120000) return;
    this._league = { at: nowMs(), state: 'loading', rows: null };
    var self = this;
    Lb.league(12, function (state, rows) {
      if (!self._league) return;
      self._league.state = state;
      self._league.rows = rows;
      self._league.at = nowMs();
    });
  };

  // TODAY'S BOARD, fetched lazily and cached.
  //
  // The daily leaderboard already existed and was visible for exactly one
  // moment in the whole game: the results screen straight after a daily run.
  // There was no way to go back and look, so the one competitive surface the
  // game has could not be revisited and a streak had nothing to measure
  // itself against.
  //
  // Read-only by construction — anon may SELECT every column EXCEPT client_id
  // (see tools/leaderboard-rpc.sql); writes go through the definer RPC. So the
  // worst this can do is show a stale or empty board.
  // A FETCH THAT NEVER CALLS BACK MUST STILL RESOLVE ON SCREEN.
  //
  // Both boards sit in `state: 'loading'` until their callback fires, and the
  // draw renders that as a bare "reading the board…" line. The 'error' state
  // already has the right copy AND the retry affordance ("tap the tab again"),
  // but nothing promotes a stuck load into it — so a request that hangs rather
  // than rejecting (a captive-portal Wi-Fi, a dead DNS, a phone that lost the
  // network mid-flight) leaves a spinner on screen with no way out and nothing
  // to tap. Reading the clock at DRAW time needs no timer and no new state.
  //
  // 12s: the board is a 10-row read of one indexed table over HTTPS. Anything
  // past that is not slow, it is gone.
  var FETCH_PATIENCE = 12000;
  function fetchStalled(b) {
    return !!b && b.state === 'loading' && nowMs() - b.at > FETCH_PATIENCE;
  }

  Game.prototype._loadBoard = function (force) {
    var day = dayNumber();
    var b = this._board;
    // refetch on a new UTC day, on an explicit retry, or after 60s
    if (!force && b && b.day === day && nowMs() - b.at < 60000) return;
    this._board = { day: day, at: nowMs(), state: 'loading', rows: null };
    var self = this;
    Lb.top(day, 10, function (rows) {
      // a fetch that lands after the day rolled over belongs to yesterday
      if (!self._board || self._board.day !== day) return;
      self._board.state = rows ? 'ok' : 'error';
      self._board.rows = rows || null;
      self._board.at = nowMs();
    });
  };

  // THE RECORDS SCREEN. Every number here was already persisted and none of it
  // was ever shown together: bestDaily accumulated a day->coins map that was
  // read only for TODAY, bestFree and the star total lived on separate
  // screens, and nothing at all recorded that you had played before. A shift
  // ended and took itself with it, which is the last structural reason to stop
  // playing.
  Game.prototype._drawRecords = function () {
    var ctx = this.ctx, v = this.view, cx = VIEW_MIN_W / 2;
    ctx.fillStyle = '#241a12';
    ctx.fillRect(-v.ox, -v.uiTop, v.w, v.h);
    var bg = SPR.backdrop_burrow;
    if (bg) {
      ctx.globalAlpha = 0.22;
      var sc = Math.max(v.w / bg.width, v.h / bg.height);
      ctx.drawImage(bg, -v.ox + (v.w - bg.width * sc) / 2, -v.uiTop, bg.width * sc, bg.height * sc);
      ctx.globalAlpha = 1;
    }
    var st = stats();
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffe9a8'; ctx.font = fD(28);
    ctx.fillText('RECORDS', cx, 34);

    // --- tabs ---------------------------------------------------------------
    var R = this.recordsRects();
    var tab = this.recTab || 'stats';
    [[R.tabStats, 'YOU', tab === 'stats'],
     [R.tabBoard, 'TODAY', tab === 'board'],
     [R.tabLeague, 'LEAGUE', tab === 'league'],
     [R.tabPast, 'PAST', tab === 'past'],
     [R.tabJobs, 'JOBS', tab === 'jobs']]
      .forEach(function (t) {
        var box = t[0], on = t[2];
        ctx.fillStyle = on ? 'rgba(90,70,50,0.95)' : 'rgba(20,12,6,0.45)';
        rr(ctx, box.x, box.y, box.w, box.h, 9); ctx.fill();
        ctx.strokeStyle = on ? 'rgba(255,215,94,0.9)' : 'rgba(201,168,106,0.35)';
        ctx.lineWidth = on ? 2 : 1;
        rr(ctx, box.x, box.y, box.w, box.h, 9); ctx.stroke();
        ctx.fillStyle = on ? '#ffd75e' : 'rgba(232,220,200,0.6)';
        ctx.font = fT(12, 'bold');
        ctx.fillText(t[1], box.x + box.w / 2, box.y + 11, box.w - 12);
      });

    if (tab === 'board') { this._drawBoardTab(); this._menuBtn('BACK', RECORDS_BACK_Y); return; }
    if (tab === 'league') { this._drawLeagueTab(); this._menuBtn('BACK', RECORDS_BACK_Y); return; }
    if (tab === 'past') { this._drawPastTab(); this._menuBtn('BACK', RECORDS_BACK_Y); return; }
    if (tab === 'jobs') { this._drawJobsTab(); this._menuBtn('BACK', RECORDS_BACK_Y); return; }

    // the hoard rank is the headline — it is the one number that never stops
    var hrk = hoardRank(Meta.data.hoardTotal);
    ctx.fillStyle = '#e8c9ff'; ctx.font = fD(17);
    ctx.fillText(hrk ? hrk.name : 'Keeper of ' + Meta.data.hoardTotal, cx, 126);
    ctx.fillStyle = 'rgba(232,201,255,0.75)'; ctx.font = fT(12);
    ctx.fillText(hrk ? Meta.data.hoardTotal + ' hoarded · next rank at ' + hrk.next
                     : Meta.data.hoardTotal + ' gems hoarded', cx, 148);

    // best-of-all-days, computed from the map that was only ever read for today
    var bestEver = 0, dayCount = 0;
    for (var k in Meta.data.bestDaily) {
      dayCount++;
      if (Meta.data.bestDaily[k] > bestEver) bestEver = Meta.data.bestDaily[k];
    }
    var starTotal = 0;
    var cs = Meta.data.careerStars || {};
    for (var lv in cs) starTotal += cs[lv] || 0;

    var rows = [
      ['Career', Math.min(CAREER_MAX, Meta.data.careerLevel || 1) + ' of ' + CAREER_MAX],
      ['Stars', starTotal + ' / ' + (CAREER_MAX * 3)],
      ['Best daily', bestEver ? bestEver + 'c' : '—'],
      ['Best free dig', Meta.data.bestFree ? Meta.data.bestFree + 'c' : '—'],
      ['Day streak', (st.streak || 0) + (st.bestStreak > (st.streak || 0)
                      ? '  (best ' + st.bestStreak + ')' : '')],
      ['Shifts worked', st.shifts || 0],
      ['Days dug', st.days || dayCount],
      ['Gems delivered', st.gems || 0],
      ['Crusted rocks cracked', st.crusts || 0],
      ['Heartstones found', st.hearts || 0],
      ['Longest chain', st.bestCombo || 0],
      // COINS EARNED, not the wallet balance. `Meta.data.coins` is spendable
      // and is decremented on purchase, so labelling it "banked" made a
      // LIFETIME RECORD that fell by 7,600c the moment a player bought Deep
      // Basalt — a stat that punishes you for using the shop it belongs to.
      //
      // The split is also the honest answer to "coins go inert". The shop is
      // FINISHABLE by design and the econ gate proves it: stock must exceed
      // what L30 pays and must not exceed a whole career, which leaves ~4,000c
      // of headroom in total — about eight more shifts. There is no sink to
      // add here. What was missing is a number that keeps counting, so the
      // coins earned after the last purchase still land somewhere.
      ['Coins earned', (stats().earned || Meta.data.coins || 0) + 'c'],
      ['In the purse', (Meta.data.coins || 0) + 'c'],
    ];
    // 13 rows at H=36 end at y=644 and BACK sits at 640. H=33 ends at 605,
    // leaving the button clear — measured, not eyeballed, because this screen
    // grew a row when the coin stat was split in two.
    var y = 176, H = 33;
    for (var i = 0; i < rows.length; i++) {
      ctx.fillStyle = i % 2 ? 'rgba(20,12,6,0.30)' : 'rgba(20,12,6,0.48)';
      rr(ctx, cx - 150, y, 300, H - 4, 8); ctx.fill();
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(240,226,200,0.82)'; ctx.font = fT(13);
      ctx.fillText(rows[i][0], cx - 138, y + 9, 180);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#ffd75e'; ctx.font = fT(14, 'bold');
      ctx.fillText(String(rows[i][1]), cx + 138, y + 8, 130);
      y += H;
    }
    ctx.textAlign = 'center';
    this._menuBtn('BACK', RECORDS_BACK_Y);
  };

  // How many past days the archive offers. 14 matches the league window, so
  // the two surfaces describe the same fortnight.
  var ARCHIVE_DAYS = 14;
  Game.prototype.archiveRows = function () {
    var today = dayNumber(), out = [];
    for (var i = 1; i <= ARCHIVE_DAYS; i++) {
      var d = today - i;
      out.push({ day: d, ago: i, ch: dailyCharacter(d),
                 best: (Meta.data.bestDaily && Meta.data.bestDaily[d]) || 0 });
    }
    return out;
  };

  // THE CONTRACT BOARD. Scrolls by page rather than by drag — a canvas drag
  // scroller is a whole input surface and this list is 27 entries.
  var JOBS_PER_PAGE = 13;
  // The archive list, paged for the same reason and to the same shape. 49 world
  // units is 43.7pt on an SE3 — the floor, near enough — and eight of them plus
  // a pager fit between the header at 118 and the BACK button at 640.
  var PAST_ROW_Y = 138, PAST_ROW_H = 49, PAST_PER_PAGE = 8;
  Game.prototype._drawJobsTab = function () {
    var ctx = this.ctx, cx = VIEW_MIN_W / 2;
    var done = contractsDone();
    var nDone = 0, hEarned = 0, hTotal = 0;
    for (var i = 0; i < CONTRACTS.length; i++) {
      hTotal += CONTRACTS[i].h;
      if (done[CONTRACTS[i].id]) { nDone++; hEarned += CONTRACTS[i].h; }
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffd75e'; ctx.font = fT(13, 'bold');
    ctx.fillText(nDone + ' of ' + CONTRACTS.length + ' contracts · ' +
                 hEarned + '/' + hTotal + ' hoard', cx, 118, 300);
    ctx.fillStyle = 'rgba(232,201,255,0.6)'; ctx.font = fT(10);
    ctx.fillText('free digs and career only · no clock, they keep', cx, 136, 300);

    var page = this.jobsPage || 0;
    var pages = Math.ceil(CONTRACTS.length / JOBS_PER_PAGE);
    var from = page * JOBS_PER_PAGE;
    var y = 154, H = 33;
    for (var j = from; j < Math.min(from + JOBS_PER_PAGE, CONTRACTS.length); j++) {
      var c = CONTRACTS[j], got = !!done[c.id];
      ctx.fillStyle = got ? 'rgba(70,60,34,0.72)'
                          : (j % 2 ? 'rgba(20,12,6,0.30)' : 'rgba(20,12,6,0.48)');
      rr(ctx, cx - 150, y, 300, H - 4, 8); ctx.fill();
      ctx.textAlign = 'left';
      ctx.fillStyle = got ? '#ffd75e' : 'rgba(240,226,200,0.35)';
      ctx.font = fT(12, 'bold');
      ctx.fillText(got ? '\u2714' : '\u25CB', cx - 141, y + 8, 14);
      ctx.fillStyle = got ? '#f0e2c8' : 'rgba(240,226,200,0.8)';
      ctx.font = (got ? 'bold ' : '') + fT(11);
      ctx.fillText(c.name, cx - 122, y + 3, 128);
      ctx.fillStyle = 'rgba(240,226,200,0.45)'; ctx.font = fT(9);
      ctx.fillText(c.desc, cx - 122, y + 16, 160);
      ctx.textAlign = 'right';
      ctx.fillStyle = got ? 'rgba(232,201,255,0.8)' : 'rgba(232,201,255,0.45)';
      ctx.font = fT(11, 'bold');
      ctx.fillText('+' + c.h, cx + 140, y + 9, 40);
      ctx.textAlign = 'center';
      y += H;
    }
    if (pages > 1) {
      // drawn THROUGH the rect the pointer answers on — see jobsPageRect
      var pr = this.jobsPageRect();
      ctx.fillStyle = 'rgba(20,12,6,0.42)';
      rr(ctx, pr.x, pr.y, pr.w, pr.h, 10); ctx.fill();
      ctx.strokeStyle = 'rgba(232,201,255,0.30)'; ctx.lineWidth = 1.5;
      rr(ctx, pr.x, pr.y, pr.w, pr.h, 10); ctx.stroke();
      ctx.fillStyle = 'rgba(232,220,200,0.85)'; ctx.font = fT(12, 'bold');
      ctx.fillText('\u2039  page ' + (page + 1) + ' of ' + pages + '  \u203A',
                   cx, pr.y + 18, pr.w - 20);
    }
  };

  // THE PAGER MOVES WITH THE PAGE, SO ITS BOX HAS TO MOVE TOO.
  //
  // This hardcoded `154 + JOBS_PER_PAGE * 33 + 2` — it assumed every page is
  // FULL. With 27 contracts at 13 a page the pages are 13/13/1, so on the last
  // page _drawJobsTab's loop runs once, y ends at 187 and the control paints at
  // 195, while the only box that answers for it sits at 585: 390 world units
  // (~348pt on an SE3) apart. The one visible pager in the game did nothing,
  // and there was no way off page 3.
  //
  // 44 tall rather than 26, because it was under the touch floor as well
  // (26 * 0.893 = 23pt). _drawJobsTab draws THROUGH this, so they cannot
  // disagree again.
  Game.prototype.jobsPageRect = function () {
    var page = this.jobsPage || 0;
    var rows = Math.min(JOBS_PER_PAGE, Math.max(0, CONTRACTS.length - page * JOBS_PER_PAGE));
    return { x: VIEW_MIN_W / 2 - 100, y: 154 + rows * 33 - 6, w: 200, h: 50 };
  };

  Game.prototype._drawPastTab = function () {
    var ctx = this.ctx, cx = VIEW_MIN_W / 2;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(232,201,255,0.75)'; ctx.font = fT(11);
    ctx.fillText('every past jar, still diggable · no coins, no board', cx, 118, 300);

    // PAGED, AND EACH ROW IS A REAL TARGET.
    //
    // Fourteen days at a 33 pitch drew a 29-unit row — 25.9pt on an SE3, barely
    // half the 44pt floor — with a 4-unit dead gap between neighbours, and each
    // row LAUNCHES A DIG. A mis-hit either did nothing or started the wrong
    // day's jar. Fourteen 44pt rows do not fit under a header at 138 with a
    // BACK button at 640, so the list pages instead, exactly as the contract
    // board next door does: 8 rows of 49 (43.7pt) run 138..530 and leave the
    // pager its own 44-unit box at 534.
    var all = this.archiveRows();
    var page = this.pastPage || 0;
    var pages = Math.ceil(all.length / PAST_PER_PAGE);
    if (page >= pages) page = this.pastPage = 0;
    var rows = all.slice(page * PAST_PER_PAGE, page * PAST_PER_PAGE + PAST_PER_PAGE);
    var y = PAST_ROW_Y, H = PAST_ROW_H;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i], dug = r.best > 0;
      ctx.fillStyle = i % 2 ? 'rgba(20,12,6,0.30)' : 'rgba(20,12,6,0.48)';
      rr(ctx, cx - 150, y, 300, H - 4, 8); ctx.fill();
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(240,226,200,0.55)'; ctx.font = fT(11);
      ctx.fillText(r.ago === 1 ? 'yesterday' : r.ago + ' days ago', cx - 140, y + 16, 74);
      ctx.fillStyle = dug ? 'rgba(240,226,200,0.9)' : 'rgba(240,226,200,0.5)';
      ctx.font = fT(11);
      ctx.fillText(r.ch.name, cx - 62, y + 16, 118);
      ctx.textAlign = 'right';
      if (dug) {
        ctx.fillStyle = '#ffd75e'; ctx.font = fT(12, 'bold');
        ctx.fillText(r.best + 'c', cx + 140, y + 15, 70);
      } else {
        ctx.fillStyle = 'rgba(201,168,106,0.75)'; ctx.font = fT(11, 'bold');
        ctx.fillText('dig it', cx + 140, y + 16, 70);
      }
      ctx.textAlign = 'center';
      y += H;
    }
    if (pages > 1) {
      var pr = this.pastPageRect();
      ctx.fillStyle = 'rgba(20,12,6,0.42)';
      rr(ctx, pr.x, pr.y, pr.w, pr.h, 10); ctx.fill();
      ctx.strokeStyle = 'rgba(232,201,255,0.30)'; ctx.lineWidth = 1.5;
      rr(ctx, pr.x, pr.y, pr.w, pr.h, 10); ctx.stroke();
      ctx.fillStyle = 'rgba(232,220,200,0.85)'; ctx.font = fT(12, 'bold');
      ctx.fillText('\u2039  page ' + (page + 1) + ' of ' + pages + '  \u203A',
                   cx, pr.y + 18, pr.w - 20);
    }
  };

  // ONE definition, shared by _drawPastTab and the pointer listener.
  Game.prototype.pastPageRect = function () {
    var page = this.pastPage || 0;
    var n = Math.min(PAST_PER_PAGE, Math.max(0, ARCHIVE_DAYS - page * PAST_PER_PAGE));
    return { x: VIEW_MIN_W / 2 - 100, y: PAST_ROW_Y + n * PAST_ROW_H, w: 200, h: 50 };
  };

  Game.prototype._drawLeagueTab = function () {
    var ctx = this.ctx, cx = VIEW_MIN_W / 2, b = this._league;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';

    if (!b || (b.state === 'loading' && !fetchStalled(b))) {
      ctx.fillStyle = 'rgba(232,220,200,0.6)'; ctx.font = fT(13);
      ctx.fillText('counting the fortnight…', cx, 300);
      return;
    }
    if (fetchStalled(b)) {
      ctx.fillStyle = 'rgba(232,220,200,0.6)'; ctx.font = fT(13);
      ctx.fillText('the league is out of reach right now', cx, 292);
      ctx.fillStyle = 'rgba(232,220,200,0.4)'; ctx.font = fT(11);
      ctx.fillText('tap the tab again to retry', cx, 314);
      return;
    }
    if (b.state === 'closed') {
      // The view is not published yet. Say something TRUE and unalarming
      // rather than an error — this is the expected state before
      // tools/leaderboard-league.sql is run.
      ctx.fillStyle = '#ffd75e'; ctx.font = fT(14, 'bold');
      ctx.fillText('the league opens soon', cx, 288);
      ctx.fillStyle = 'rgba(232,220,200,0.55)'; ctx.font = fT(12);
      ctx.fillText('your daily digs are already being counted', cx, 314);
      return;
    }
    if (b.state === 'error') {
      ctx.fillStyle = 'rgba(232,220,200,0.6)'; ctx.font = fT(13);
      ctx.fillText('the league is out of reach right now', cx, 292);
      ctx.fillStyle = 'rgba(232,220,200,0.4)'; ctx.font = fT(11);
      ctx.fillText('tap the tab again to retry', cx, 314);
      return;
    }
    var rows = b.rows || [];
    if (!rows.length) {
      ctx.fillStyle = 'rgba(232,220,200,0.6)'; ctx.font = fT(13);
      ctx.fillText('no digs in the last fortnight', cx, 292);
      ctx.fillStyle = '#ffd75e'; ctx.font = fT(13, 'bold');
      ctx.fillText('a daily dig starts your run', cx, 316);
      return;
    }

    ctx.fillStyle = 'rgba(232,201,255,0.75)'; ctx.font = fT(11);
    ctx.fillText('every daily dig of the last 14 days, added up', cx, 118, 300);

    var me = Meta.data.playerName, mine = -1;
    var y = 140, H = 32;
    for (var i = 0; i < rows.length && i < 12; i++) {
      var isMe = rows[i].player === me;
      if (isMe) mine = i;
      ctx.fillStyle = isMe ? 'rgba(90,70,40,0.85)'
                           : (i % 2 ? 'rgba(20,12,6,0.30)' : 'rgba(20,12,6,0.48)');
      rr(ctx, cx - 150, y, 300, H - 4, 8); ctx.fill();
      if (isMe) {
        ctx.strokeStyle = 'rgba(255,215,94,0.8)'; ctx.lineWidth = 1.5;
        rr(ctx, cx - 150, y, 300, H - 4, 8); ctx.stroke();
      }
      ctx.textAlign = 'left';
      ctx.fillStyle = i < 3 ? '#ffd75e' : 'rgba(240,226,200,0.55)';
      ctx.font = fT(12, 'bold');
      ctx.fillText(String(i + 1), cx - 140, y + 8, 22);
      // safeName at the point of PAINT, same as the daily board
      ctx.fillStyle = isMe ? '#ffe9a8' : 'rgba(240,226,200,0.9)';
      ctx.font = (isMe ? 'bold ' : '') + fT(12);
      ctx.fillText(safeName(rows[i].player), cx - 114, y + 8, 118);
      ctx.fillStyle = 'rgba(232,201,255,0.6)'; ctx.font = fT(10);
      ctx.fillText((rows[i].days | 0) + 'd', cx + 12, y + 9, 30);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#ffd75e'; ctx.font = fT(13, 'bold');
      ctx.fillText((rows[i].total | 0) + 'c', cx + 140, y + 8, 78);
      y += H;
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(232,201,255,0.8)'; ctx.font = fT(12);
    ctx.fillText(mine >= 0 ? 'you are ' + (mine + 1) + ' of ' + rows.length + ' this fortnight'
                           : 'dig the daily to enter the league', cx, y + 8, 290);
  };

  Game.prototype._drawBoardTab = function () {
    var ctx = this.ctx, cx = VIEW_MIN_W / 2;
    var b = this._board;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';

    if (!b || (b.state === 'loading' && !fetchStalled(b))) {
      ctx.fillStyle = 'rgba(232,220,200,0.6)'; ctx.font = fT(13);
      ctx.fillText('reading the board…', cx, 300);
      return;
    }
    if (b.state === 'error' || fetchStalled(b)) {
      ctx.fillStyle = 'rgba(232,220,200,0.6)'; ctx.font = fT(13);
      ctx.fillText('the board is out of reach right now', cx, 292);
      ctx.fillStyle = 'rgba(232,220,200,0.4)'; ctx.font = fT(11);
      ctx.fillText('tap the tab again to retry', cx, 314);
      return;
    }
    var rows = b.rows || [];
    if (!rows.length) {
      ctx.fillStyle = 'rgba(232,220,200,0.6)'; ctx.font = fT(13);
      ctx.fillText('nobody has dug today yet', cx, 292);
      ctx.fillStyle = '#ffd75e'; ctx.font = fT(13, 'bold');
      ctx.fillText('be first — the daily jar is the same for everyone', cx, 316);
      return;
    }

    var me = Meta.data.playerName, mine = -1;
    var y = 126, H = 34;
    for (var i = 0; i < rows.length && i < 10; i++) {
      var isMe = rows[i].player === me;
      if (isMe) mine = i;
      ctx.fillStyle = isMe ? 'rgba(90,70,40,0.85)'
                           : (i % 2 ? 'rgba(20,12,6,0.30)' : 'rgba(20,12,6,0.48)');
      rr(ctx, cx - 150, y, 300, H - 4, 8); ctx.fill();
      if (isMe) {
        ctx.strokeStyle = 'rgba(255,215,94,0.8)'; ctx.lineWidth = 1.5;
        rr(ctx, cx - 150, y, 300, H - 4, 8); ctx.stroke();
      }
      ctx.textAlign = 'left';
      ctx.fillStyle = i < 3 ? '#ffd75e' : 'rgba(240,226,200,0.55)';
      ctx.font = fT(13, 'bold');
      ctx.fillText(String(i + 1), cx - 140, y + 8, 24);
      // ALWAYS through safeName. `player` is written by the RPC, which refuses
      // anything that is not a minted MOLE-XXXX — but this is a 4+ game and
      // the column is the one field a caller supplies, so it is sanitised at
      // the point of PAINT too rather than trusting the write path alone.
      ctx.fillStyle = isMe ? '#ffe9a8' : 'rgba(240,226,200,0.9)';
      ctx.font = (isMe ? 'bold ' : '') + fT(13);
      ctx.fillText(safeName(rows[i].player), cx - 112, y + 8, 150);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#ffd75e'; ctx.font = fT(14, 'bold');
      ctx.fillText((rows[i].coins | 0) + 'c', cx + 140, y + 7, 80);
      y += H;
    }
    ctx.textAlign = 'center';

    // Your own standing, when you are not in the visible top ten — otherwise
    // the board is just other people and says nothing about you.
    var best = Meta.data.bestDaily[dayNumber()] || 0;
    ctx.fillStyle = 'rgba(232,201,255,0.8)'; ctx.font = fT(12);
    var line;
    if (mine >= 0) {
      line = 'you are ' + (mine + 1) + ' of ' + rows.length + ' today';
    } else if (best > 0) {
      // "not in the top 1" is what a naive rows.length prints on a board with
      // one row, and it is also WRONG about the cause: a local best that is
      // absent from a short board did not miss the cut, it has not posted.
      // pendingScore is the queue a failed submission sits in.
      line = 'your best today: ' + best + 'c'
           + (Meta.data.pendingScore ? ' · waiting to post'
              : rows.length >= 10 ? ' · outside the top 10' : '');
    } else {
      line = 'you have not dug today';
    }
    ctx.fillText(line, cx, y + 10, 290);
  };

  // The Hoardling wardrobe. Unlocked by RANK, not bought — so the rows show a
  // threshold, never a price, and there is no wallet interaction at all.
  // The pick rack. Star-gated, so rows show a THRESHOLD, never a price.
  Game.prototype._drawPickTab = function () {
    var ctx = this.ctx, cx = VIEW_MIN_W / 2;
    var eq = equippedPickId(), have = starTotal();
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(255,215,94,0.85)'; ctx.font = fT(12);
    ctx.fillText('\u2605 ' + have + ' of ' + (CAREER_MAX * 3) + ' career stars', cx, WARDROBE_TALLY_Y, 300);

    var base = SPR.prop_pickaxe;
    for (var i = 0; i < PICK_SKINS.length; i++) {
      var sk = PICK_SKINS[i], y = dragonRowY(i);
      var open = pickUnlocked(sk), isEq = eq === sk.id;
      var x0 = cx - 150;
      ctx.fillStyle = isEq ? 'rgba(90,70,42,0.92)' : 'rgba(30,22,16,0.82)';
      rr(ctx, x0, y, 300, DRAGON_ROW_H, 10); ctx.fill();
      ctx.strokeStyle = isEq ? '#ffd75e' : open ? 'rgba(201,168,106,0.7)' : 'rgba(140,120,100,0.28)';
      ctx.lineWidth = isEq ? 2.5 : 1.5;
      rr(ctx, x0, y, 300, DRAGON_ROW_H, 10); ctx.stroke();
      if (base) {
        ctx.save();
        ctx.globalAlpha = open ? 1 : 0.28;
        ctx.drawImage(tintCutout(base, sk, _pickPrev, sk.id) || base,
                      x0 + 8, y + 3, DRAGON_ROW_H - 6, DRAGON_ROW_H - 6);
        ctx.restore();
      }
      ctx.textAlign = 'left';
      ctx.fillStyle = open ? '#f0e2c8' : 'rgba(200,186,166,0.45)';
      ctx.font = fT(14, 'bold');
      ctx.fillText(sk.name, x0 + 58, y + 15, 150);
      ctx.textAlign = 'right';
      ctx.font = fT(12, 'bold');
      if (isEq) { ctx.fillStyle = '#ffd75e'; ctx.fillText('WORN', x0 + 290, y + 18, 90); }
      else if (open) { ctx.fillStyle = 'rgba(201,168,106,0.9)'; ctx.fillText('wear', x0 + 290, y + 18, 90); }
      else { ctx.fillStyle = 'rgba(200,186,166,0.5)';
             ctx.fillText('\u2605 ' + sk.stars, x0 + 290, y + 18, 90); }
      ctx.textAlign = 'center';
    }
    this._menuBtn('BACK', this._shopBackY(dragonRowY(PICK_SKINS.length) + 6));
  };

  Game.prototype._drawDragonTab = function () {
    var ctx = this.ctx, cx = VIEW_MIN_W / 2;
    var eq = equippedDragonId();
    var rk = hoardRank(Meta.data.hoardTotal);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(232,201,255,0.85)'; ctx.font = fT(12);
    ctx.fillText(rk ? rk.name + ' · hoard ' + Meta.data.hoardTotal
                    : 'hoard ' + Meta.data.hoardTotal + ' · first skin at 20',
                 cx, WARDROBE_TALLY_Y, 300);

    var base = SPR.dragon_hoardling;
    for (var i = 0; i < DRAGON_SKINS.length; i++) {
      var sk = DRAGON_SKINS[i], y = dragonRowY(i);
      var open = dragonUnlocked(sk), isEq = eq === sk.id;
      var x0 = cx - 150;
      ctx.fillStyle = isEq ? 'rgba(90,70,42,0.92)' : 'rgba(30,22,16,0.82)';
      rr(ctx, x0, y, 300, DRAGON_ROW_H, 10); ctx.fill();
      ctx.strokeStyle = isEq ? '#ffd75e'
                        : open ? 'rgba(201,168,106,0.7)' : 'rgba(140,120,100,0.28)';
      ctx.lineWidth = isEq ? 2.5 : 1.5;
      rr(ctx, x0, y, 300, DRAGON_ROW_H, 10); ctx.stroke();

      // swatch: the dragon actually wearing it, dimmed while locked
      if (base) {
        ctx.save();
        ctx.globalAlpha = open ? 1 : 0.28;
        var img = skinPreview(sk) || base;
        ctx.drawImage(img, x0 + 8, y + 3, DRAGON_ROW_H - 6, DRAGON_ROW_H - 6);
        ctx.restore();
      }
      ctx.textAlign = 'left';
      ctx.fillStyle = open ? '#f0e2c8' : 'rgba(200,186,166,0.45)';
      ctx.font = fT(14, 'bold');
      ctx.fillText(sk.name, x0 + 58, y + 15, 150);
      ctx.textAlign = 'right';
      ctx.font = fT(12, 'bold');
      if (isEq) {
        ctx.fillStyle = '#ffd75e'; ctx.fillText('WORN', x0 + 290, y + 18, 90);
      } else if (open) {
        ctx.fillStyle = 'rgba(201,168,106,0.9)'; ctx.fillText('wear', x0 + 290, y + 18, 90);
      } else {
        ctx.fillStyle = 'rgba(200,186,166,0.5)';
        ctx.fillText('hoard ' + (20 + sk.rank * HOARD_STEP), x0 + 290, y + 18, 110);
      }
      ctx.textAlign = 'center';
    }
    this._menuBtn('BACK', this._shopBackY(dragonRowY(DRAGON_SKINS.length) + 6));
  };

  Game.prototype._drawShop = function () {
    var ctx = this.ctx, v = this.view;
    ctx.fillStyle = '#241a12';
    ctx.fillRect(-v.ox, -v.uiTop, v.w, v.h);
    var bg = SPR.backdrop_burrow;
    if (bg) {
      ctx.globalAlpha = 0.30;
      var sc = Math.max(v.w / bg.width, v.h / bg.height);
      ctx.drawImage(bg, -v.ox + (v.w - bg.width * sc) / 2, -v.uiTop, bg.width * sc, bg.height * sc);
      ctx.globalAlpha = 1;
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffe9a8'; ctx.font = fD(28);
    ctx.fillText("THE MOLE'S SHOP", VIEW_MIN_W / 2, 96);
    ctx.fillStyle = 'rgba(232,220,200,0.75)'; ctx.font = fT(13);
    // Tab-aware: the wardrobe is unlocked by HOARD, so telling the player
    // their gems pay for it is simply false on that tab.
    ctx.fillText(this.shopTab === 'dragon' ? 'what you hoard, the Hoardling wears'
               : this.shopTab === 'pick'   ? 'what you master, the pick remembers'
               : 'dig walls · every gem you sell pays for these', VIEW_MIN_W / 2, 134);
    this._drawGearAt(SHOP_GEAR);

    // Wallet — WALLS TAB ONLY. Nothing in the wardrobe costs coins, and a
    // purse sitting over a list of rank unlocks reads as a price list.
    if (this.shopTab !== 'dragon' && this.shopTab !== 'pick') {
      ctx.fillStyle = 'rgba(20,12,6,0.55)';
      rr(ctx, VIEW_MIN_W / 2 - 78, 168, 156, 40, 12); ctx.fill();
      ctx.strokeStyle = 'rgba(255,215,94,0.5)'; ctx.lineWidth = 1.5;
      rr(ctx, VIEW_MIN_W / 2 - 78, 168, 156, 40, 12); ctx.stroke();
      ctx.fillStyle = '#ffd75e'; ctx.font = fN(22);
      ctx.fillText((Meta.data.coins || 0).toLocaleString() + 'c', VIEW_MIN_W / 2, 178);
    }

    // --- tabs ---------------------------------------------------------------
    var TB = shopTabs(), st = this.shopTab || 'walls';
    [[TB.walls, 'DIG WALLS', st === 'walls'],
     [TB.dragon, 'HOARDLING', st === 'dragon'],
     [TB.pick, 'PICKAXE', st === 'pick']]
      .forEach(function (t) {
        var box = t[0], on = t[2];
        ctx.fillStyle = on ? 'rgba(90,70,50,0.95)' : 'rgba(20,12,6,0.45)';
        rr(ctx, box.x, box.y, box.w, box.h, 9); ctx.fill();
        ctx.strokeStyle = on ? 'rgba(255,215,94,0.9)' : 'rgba(201,168,106,0.35)';
        ctx.lineWidth = on ? 2 : 1;
        rr(ctx, box.x, box.y, box.w, box.h, 9); ctx.stroke();
        ctx.fillStyle = on ? '#ffd75e' : 'rgba(232,220,200,0.6)';
        ctx.font = fT(12, 'bold');
        ctx.fillText(t[1], box.x + box.w / 2, box.y + 11, box.w - 12);
      });
    if (st === 'dragon') { this._drawDragonTab(); return; }
    if (st === 'pick') { this._drawPickTab(); return; }

    var eq = equippedWallId();
    for (var i = 0; i < WALL_SKINS.length; i++) {
      var sk = WALL_SKINS[i], y = shopRowY(i);
      var owned = sk.price === 0 || !!(Meta.data.owned && Meta.data.owned[sk.id]);
      var isEq = eq === sk.id;
      var afford = (Meta.data.coins || 0) >= sk.price;
      var x0 = VIEW_MIN_W / 2 - 150;

      ctx.fillStyle = isEq ? 'rgba(90,70,42,0.92)' : 'rgba(30,22,16,0.82)';
      rr(ctx, x0, y, 300, SHOP_ROW_H, 12); ctx.fill();
      ctx.strokeStyle = isEq ? '#ffd75e' : (owned ? 'rgba(201,168,106,0.7)'
                                                  : (afford ? 'rgba(201,168,106,0.45)'
                                                            : 'rgba(140,120,100,0.28)'));
      ctx.lineWidth = isEq ? 2.5 : 1.5;
      rr(ctx, x0, y, 300, SHOP_ROW_H, 12); ctx.stroke();

      // THE THUMBNAIL IS THE ACTUAL WALL. gradedWall() is the same function the
      // dig renders through, cropped to a tall slice of the seam, so what is on
      // the price tag is what you get \u2014 the old flat #6b5a45 swatch was a paint
      // chip standing in for a painting, and it is most of why this screen read
      // as cheap. Cached per id by gradedWall, so this costs one drawImage.
      var tw = 44, th = SHOP_ROW_H - 16, tX = x0 + 10, tY = y + 8;
      ctx.save();
      ctx.beginPath(); rr(ctx, tX, tY, tw, th, 8); ctx.clip();
      var wimg = gradedWall(sk.id);
      if (wimg) {
        // A centred slice of the seam at roughly the on-screen scale of the dig.
        var sw = Math.min(wimg.width, Math.round(wimg.width * 0.42));
        var sh = Math.round(sw * th / tw);
        ctx.drawImage(wimg, (wimg.width - sw) / 2, (wimg.height - sh) / 2, sw, sh, tX, tY, tw, th);
      } else {
        ctx.fillStyle = '#6b5a45'; ctx.fillRect(tX, tY, tw, th);
      }
      if (!owned && !afford) { ctx.fillStyle = 'rgba(12,8,5,0.42)'; ctx.fillRect(tX, tY, tw, th); }
      ctx.restore();
      ctx.strokeStyle = isEq ? 'rgba(255,215,94,0.85)' : 'rgba(255,240,200,0.22)';
      ctx.lineWidth = isEq ? 2 : 1;
      rr(ctx, tX, tY, tw, th, 8); ctx.stroke();

      // TWO LINES OF TEXT, NOT THREE. The third line sat at y+45 in a 56-tall
      // row and crossed the bottom border on every unowned item \u2014 and it said
      // "YOU CAN AFFORD THIS \u00b7 TAP TO BUY" four times down one screen, which is
      // repetition, not a system. Affordability now rides on the PRICE, where
      // the player is already looking, and costs no vertical space at all:
      //
      //   affordable   gold price + a gold rail down the left edge of the row
      //   too dear     dim price + a slim bar under it showing how close
      //   owned        WEAR
      //   worn         \u2713 WORN
      var tx0 = x0 + 66, rightX = x0 + 288, textRoom = 150;
      ctx.textAlign = 'left';
      ctx.fillStyle = owned ? '#ffe9a8' : (afford ? '#f0e3cc' : 'rgba(200,186,166,0.55)');
      fitD(ctx, sk.name, tx0, y + 11, textRoom, 17);
      // 144, not textRoom+18. The note sits at y+33 and the "how close" bar at
      // y+38 spanning x 274..348; at 168 the note reached 294 and ran straight
      // through the bar on Deep Basalt. 144 stops it at 270, four units clear
      // of the price column — the same lane the name already respects.
      ctx.fillStyle = 'rgba(232,220,200,0.5)';
      fitT(ctx, sk.note || '', tx0, y + 33, 144, 11.5);

      // The "available now" mark: a gold rail on the row's leading edge. Silent,
      // scannable, and it costs no words.
      if (!owned && afford) {
        ctx.fillStyle = 'rgba(255,215,94,0.85)';
        rr(ctx, x0 + 2, y + 12, 3, SHOP_ROW_H - 24, 1.5); ctx.fill();
      }

      ctx.textAlign = 'right';
      if (isEq) {
        ctx.fillStyle = '#ffd75e';
        ctx.font = fT(12, 'bold');
        ctx.fillText('\u2713 WORN', rightX, y + 22);
      } else if (owned) {
        ctx.fillStyle = 'rgba(255,233,168,0.8)';
        ctx.font = fT(12, 'bold');
        ctx.fillText('WEAR', rightX, y + 22);
      } else {
        // fN: lining figures. Georgia's old-style numerals made the price
        // column ripple \u2014 5 and 7 dropping below the baseline next to an
        // x-height 0 \u2014 which read as broken rather than as a typeface.
        ctx.fillStyle = afford ? '#ffd75e' : 'rgba(200,186,166,0.5)';
        ctx.font = fN(afford ? 18 : 17);
        var ptxt = sk.price.toLocaleString();
        var py = afford ? y + 20 : y + 13;
        ctx.fillText(ptxt, rightX, py);
        // the coin replaces the trailing 'c' — the shop is where the currency
        // is actually spent, so it is the last place it should be an initial
        ctx.globalAlpha = afford ? 1 : 0.5;
        drawCoin(ctx, rightX - ctx.measureText(ptxt).width - 11, py + 9, 8);
        ctx.globalAlpha = 1;
        if (!afford) {
          var have = Meta.data.coins || 0;
          var bw2 = 74, bx = rightX - bw2, byy = y + 38;
          ctx.fillStyle = 'rgba(0,0,0,0.38)'; rr(ctx, bx, byy, bw2, 4, 2); ctx.fill();
          ctx.fillStyle = 'rgba(255,215,94,0.5)';
          rr(ctx, bx, byy, Math.max(2, bw2 * Math.min(1, have / sk.price)), 4, 2); ctx.fill();
        }
      }
      ctx.textAlign = 'center';
    }
    this._menuBtn('BACK', this._shopBackY(shopRowY(WALL_SKINS.length) + 6));
    ctx.textBaseline = 'alphabetic';
  };

  // opt: { w, h, sub, quiet }
  //   sub    — a second line drawn INSIDE the button. The home screen's captions
  //            used to sit in the gap below each button, which is what made the
  //            stack read as crowded: every caption stole 24 units from the next
  //            button's breathing room.
  //   quiet  — secondary weight (SHOP), so a chrome button does not shout as
  //            loudly as DAILY DIG.
  //   disabled — the action cannot be taken right now. A button that LOOKS live
  //            and answers with a thunk is the same lie as an unlabelled one;
  //            DEEPER PICK shipped at full gold strength whether or not the
  //            player could afford it, and it is hit-tested BEFORE RETRY.
  // Callers set textAlign='center' and textBaseline='top'.
  Game.prototype._drawLevels = function () {
    var ctx = this.ctx, v = this.view, cx = VIEW_MIN_W / 2;
    ctx.fillStyle = '#241a12';
    ctx.fillRect(-v.ox, -v.uiTop, v.w, v.h + v.uiTop);
    var bg = SPR.backdrop_burrow;
    if (bg) {
      ctx.globalAlpha = 0.22;
      var sc = Math.max(v.w / bg.width, v.h / bg.height);
      ctx.drawImage(bg, -v.ox + (v.w - bg.width * sc) / 2, -v.uiTop, bg.width * sc, bg.height * sc);
      ctx.globalAlpha = 1;
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = '#ffe9a8'; ctx.font = fD(26);
    ctx.fillText('THE JOB LADDER', cx, 92, VIEW_MIN_W - 48);
    this._drawGearAt(SHOP_GEAR);

    var stars = Meta.data.careerStars || {};
    var total = 0, key;
    for (key in stars) total += stars[key];
    ctx.fillStyle = 'rgba(232,220,200,0.75)'; ctx.font = fT(13);
    ctx.fillText('replay any level for a better score · stars keep the best', cx, 124, VIEW_MIN_W - 40);
    drawStar(ctx, cx - 30, 150, 8, '#ffd75e');
    ctx.fillStyle = '#ffd75e'; ctx.font = fT(15, 'bold');
    ctx.textAlign = 'left';
    ctx.fillText(total + ' / ' + (CAREER_MAX * 3), cx - 18, 142);
    ctx.textAlign = 'center';

    // THE LADDER IS DRAWN IN FULL, ALWAYS — all forty nodes, on a free save
    // too. A storefront that hides what it sells is both worse selling and
    // worse manners: a player should be able to see the shape of the thing
    // before deciding, and the levels past the wall look locked rather than
    // absent so nobody wonders whether the game just ends at ten.
    var reached = Math.min(careerCap(), Meta.data.careerLevel || 1);
    var wall = careerCap();                       // last level this save may enter
    for (var i = 0; i < CAREER_MAX; i++) {
      var b = levelRect(i), lv = i + 1;
      var got = stars[lv] || 0;
      var paywalled = lv > wall;
      var open = lv <= reached, cur = lv === reached && got === 0;
      var band = lv % 5 === 0;                       // band finale: heartstone
      ctx.fillStyle = paywalled ? 'rgba(46,32,58,0.62)'
                    : !open ? 'rgba(30,22,16,0.55)'
                    : got > 0 ? 'rgba(74,58,40,0.95)' : 'rgba(90,70,42,0.95)';
      rr(ctx, b.x, b.y, b.w, b.h, 11); ctx.fill();
      ctx.strokeStyle = cur ? '#ffd75e'
                      : paywalled ? 'rgba(232,201,255,0.38)'
                      : !open ? 'rgba(140,120,100,0.22)'
                      : band ? 'rgba(232,201,255,0.55)' : 'rgba(201,168,106,0.5)';
      ctx.lineWidth = cur ? 2.5 : 1.5;
      rr(ctx, b.x, b.y, b.w, b.h, 11); ctx.stroke();
      ctx.fillStyle = !open ? 'rgba(200,186,166,0.35)' : got > 0 ? '#ffe9a8' : '#fff';
      ctx.font = fD(17);
      ctx.fillText(String(lv), b.x + b.w / 2, b.y + 8);
      if (open) {
        for (var s = 0; s < 3; s++) {
          drawStar(ctx, b.x + b.w / 2 - 11 + s * 11, b.y + 38, 4.5,
                   s < got ? '#ffd75e' : 'rgba(255,255,255,0.16)');
        }
      } else if (paywalled) {
        // a small violet key, the same colour the hoard and the prism use for
        // "this is a thing you keep" — not a padlock, which reads as punishment
        ctx.strokeStyle = 'rgba(232,201,255,0.55)'; ctx.lineWidth = 1.6;
        var kx = b.x + b.w / 2, ky = b.y + 36;
        ctx.beginPath(); ctx.arc(kx, ky - 3, 3.4, 0, 6.283); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(kx, ky); ctx.lineTo(kx, ky + 7);
        ctx.moveTo(kx, ky + 5); ctx.lineTo(kx + 3, ky + 5); ctx.stroke();
      } else if (band && SPR.gem_prism) {
        ctx.globalAlpha = 0.30;
        ctx.drawImage(SPR.gem_prism, b.x + b.w / 2 - 8, b.y + 30, 16, 16);
        ctx.globalAlpha = 1;
      }
    }
    // ONE honest line under the ladder, and only when there IS a wall.
    if (wall < CAREER_MAX) {
      ctx.fillStyle = 'rgba(232,201,255,0.85)'; ctx.font = fT(12, 'bold');
      ctx.fillText('Levels 1-' + wall + ' are free. Tap a locked level to see the rest.',
                   cx, LEVELS_BACK_Y - 18, VIEW_MIN_W - 40);
    }
    this._menuBtn('BACK', LEVELS_BACK_Y);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  };

  // THE BUTTON MATERIAL. Every plate in the game comes out of here.
  //
  // What it replaced: a flat rounded rect in one brown, so CAREER, DAILY DIG
  // and FREE DIG were the same 244x60 slab differing only by their words —
  // three primary actions with no way to tell them apart at a glance — and
  // every label was drawn in `system-ui` over oil-painted art.
  //
  // Three things do the work now. A LIT EDGE: a vertical gradient plus a bright
  // top bevel and a dark under-edge, so the plate reads as a carved object
  // catching the lantern rather than a rectangle pasted on the wallpaper. A
  // TONE per mode (opt.tone), pulled toward the burrow rather than toward
  // saturated primaries — the point is "distinguishable", not "neon". And a
  // GEM MEDALLION (opt.icon), which is the fastest possible read: you know
  // which button you want before you have finished the first word.
  //
  // Geometry is byte-for-byte what it was — same x, same w/h, same radius — so
  // every existing hit test stays correct. This is a pure-cosmetic change.
  Game.prototype._menuBtn = function (label, y, opt) {
    var ctx = this.ctx;
    opt = opt || {};
    var bw = opt.w || 220, bh = opt.h || 56;
    var dim = !!opt.disabled;
    var t = BTN_TONE[opt.tone] || BTN_TONE.wood;
    var x = VIEW_MIN_W / 2 - bw / 2;

    ctx.fillStyle = 'rgba(0,0,0,' + (dim ? 0.18 : 0.38) + ')';
    rr(ctx, x + 2, y + 5, bw, bh, 14); ctx.fill();           // cast shadow

    if (dim) {
      ctx.fillStyle = '#3a2f26';
    } else {
      var g = ctx.createLinearGradient(0, y, 0, y + bh);
      g.addColorStop(0, opt.quiet ? '#4e3c2d' : t.top);
      g.addColorStop(1, opt.quiet ? '#3a2c21' : t.bot);
      ctx.fillStyle = g;
    }
    rr(ctx, x, y, bw, bh, 14); ctx.fill();

    if (!dim) {
      // Under-edge: the plate has thickness, and thickness is what stops a
      // shape reading as a sticker.
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      rr(ctx, x, y + bh - 7, bw, 7, 14); ctx.fill();
    }

    ctx.strokeStyle = dim ? 'rgba(150,132,110,0.28)'
                          : opt.quiet ? 'rgba(201,168,106,0.55)' : t.rim;
    ctx.lineWidth = dim ? 1.5 : 2;
    rr(ctx, x, y, bw, bh, 14); ctx.stroke();
    if (!dim) {
      ctx.strokeStyle = 'rgba(255,246,220,0.32)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(x + 15, y + 4); ctx.lineTo(x + bw - 15, y + 4); ctx.stroke();
    }

    // The medallion: a sunken disc with the mode's gem sitting in it.
    var tx = VIEW_MIN_W / 2, avail = bw - 24;
    var spr = opt.icon && SPR[opt.icon];
    if (spr && !dim) {
      // Tucked into the corner rather than centred in a left gutter: the first
      // version sat at x+30 with r=16 and charged the label 46 units, which is
      // what pushed 'today: … · same jar for everyone' into visible condensing.
      // At x+25/r=14 it costs 34 and reads the same at arm's length.
      var cx = x + 25, cy = y + bh / 2, rad = 14;
      ctx.fillStyle = 'rgba(0,0,0,0.30)';
      ctx.beginPath(); ctx.arc(cx, cy, rad, 0, 6.283); ctx.fill();
      ctx.strokeStyle = 'rgba(255,240,200,0.22)'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(cx, cy, rad, 0, 6.283); ctx.stroke();
      ctx.drawImage(spr, cx - 12.5, cy - 12.5, 25, 25);
      tx += 14; avail -= 34;                 // label recentres out of the disc
    }

    ctx.fillStyle = dim ? 'rgba(200,186,166,0.42)' : opt.quiet ? '#e8dcc8' : t.ink;
    // maxWidth on every fillText: a caption that outgrows its button bleeds
    // past both edges onto the wallpaper and reads as a layout bug, which is
    // exactly what 'the same jar for everyone · new at midnight UTC' did at
    // 11px in a 244-unit button. Canvas condenses instead. It is also the only
    // thing standing between this screen and a longer translation.
    // fitText, never a raw maxWidth — see its definition. These are the lines
    // that read as squished on Vanus's phone.
    if (opt.sub) {
      fitD(ctx, label, tx, y + 9, avail, 21);
      ctx.fillStyle = dim ? 'rgba(200,186,166,0.34)' : 'rgba(240,228,206,0.72)';
      fitT(ctx, opt.sub, tx, y + 37, avail, 12);
    } else {
      fitD(ctx, label, tx, y + (bh - 21) / 2, avail, opt.quiet ? 18 : 21);
    }
  };

  // ONE definition of the results buttons, shared by the draw and the pointer.
  // A career WIN prints far less than a loss does — no deeper-pick offer, no
  // "N/M orders filled" consolation — so holding the buttons at the loss
  // layout's y left ~180 units of empty panel under the payout line. It read as
  // an unfinished screen, which a store frame then advertised. Losses and the
  // free/daily results (which carry a leaderboard down to y≈519) keep the roomy
  // layout; only the win closes up.
  function resultsRects(g) {
    var careerWin = !!(g.career && g.careerResult && g.careerResult.won);
    return careerWin ? { again: 470, menu: 546, pick: -1 }
                     : { again: 560, menu: 636, pick: 490 };
  }

  // Is the results screen showing the END OF THE SHAFT? Shared, because the
  // draw and the pointer handler disagreed about it: the button rendered
  // 'DAILY DIG' on the finale while the handler ran the generic career branch
  // and restarted level 40. The label promised one mode and the tap gave
  // another — on the single screen a player reaches by finishing the game.
  // ===== THE PAYWALL =======================================================
  // Reached only by tapping a locked level or the wall on the results screen —
  // it is never thrown at anyone unprompted, never interrupts a run, and never
  // appears on the daily or a free dig. The free half of this game is meant to
  // be playable forever by someone who never intends to pay.
  // NOT `PAY` — that name is taken, 6800 lines up, by the order payout table
  // `{ easy: 30, med: 60, big: 150, timed: 90 }`. Both were `var` in the same
  // function scope, so there was only ever ONE binding: this assignment ran
  // later, won, and every order card in the game drew "undefinedc" and paid
  // nothing. No gate caught it — the sweeps drive `Jar` directly and never
  // read a card's payout — and it took looking at the running screen.
  var PAY_RECTS = {
    buy:     { x: VIEW_MIN_W / 2 - 122, y: 500, w: 244, h: 60 },
    restore: { x: VIEW_MIN_W / 2 - 122, y: 572, w: 244, h: 44 },
    back:    { x: VIEW_MIN_W / 2 - 122, y: 630, w: 244, h: 52 },
  };
  Game.prototype.paywallRects = function () { return PAY_RECTS; };

  Game.prototype.openPaywall = function () {
    this.state = 'paywall';
    Store.note = null;
    Store.load();                 // refresh displayPrice while the player reads
  };

  Game.prototype._drawPaywall = function () {
    var ctx = this.ctx, v = this.view, cx = VIEW_MIN_W / 2;
    ctx.fillStyle = '#241a12';
    ctx.fillRect(-v.ox, -v.uiTop, v.w, v.h + v.uiTop);
    var bg = SPR.backdrop_burrow;
    if (bg) {
      ctx.globalAlpha = 0.22;
      var sc = Math.max(v.w / bg.width, v.h / bg.height);
      ctx.drawImage(bg, -v.ox + (v.w - bg.width * sc) / 2, -v.uiTop, bg.width * sc, bg.height * sc);
      ctx.globalAlpha = 1;
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';

    ctx.fillStyle = '#ffe9a8'; ctx.font = fD(28);
    ctx.fillText('THE FULL BURROW', cx, 96, VIEW_MIN_W - 40);
    ctx.fillStyle = 'rgba(232,220,200,0.8)'; ctx.font = fT(13);
    ctx.fillText('One purchase. No subscription, nothing else to buy.', cx, 134, VIEW_MIN_W - 40);

    // WHAT YOU GET, and — just as important — what you already have.
    var yy = 178;
    var give = ['Career levels ' + (FREE_CAREER_LEVELS + 1) + '-' + CAREER_MAX + ' — the rest of the ladder',
                'Every past daily jar, still playable'];
    ctx.font = fT(13); ctx.textAlign = 'left';
    for (var i = 0; i < give.length; i++) {
      ctx.fillStyle = '#ffd75e';
      ctx.fillText('+', cx - 128, yy);
      ctx.fillStyle = '#f0e2c8';
      fitT(ctx, give[i], cx - 108, yy, 236, 13);
      yy += 24;
    }
    yy += 8;
    var keep = ['Free digs, the daily jar and its board stay free',
                'No ads, no energy, no timers — same as before'];
    for (var k = 0; k < keep.length; k++) {
      ctx.fillStyle = 'rgba(232,201,255,0.75)';
      ctx.fillText('\u2713', cx - 128, yy);
      ctx.fillStyle = 'rgba(232,220,200,0.72)';
      fitT(ctx, keep[k], cx - 108, yy, 236, 12);
      yy += 22;
    }
    ctx.textAlign = 'center';

    // THE LADDER ITSELF, because "levels 11-40" is a sentence and this is the
    // thing it describes. 222 world units sat empty between the copy and the
    // buttons — on the one screen in the game that has to make a case for
    // itself. Forty tiles at a glance: ten lit, thirty locked, and the shape of
    // what is missing is the whole argument.
    //
    // Geometry only — no seeded draw, no entitlement read beyond the same
    // careerCap() the levels screen uses.
    var pw = careerCap();
    var mC = 10, mS = 15, mG = 4;
    var mX = cx - (mC * mS + (mC - 1) * mG) / 2, mY = 322;
    for (var t = 0; t < CAREER_MAX; t++) {
      var mc = t % mC, mr = (t / mC) | 0;
      var tx = mX + mc * (mS + mG), ty = mY + mr * (mS + mG);
      var locked = t + 1 > pw;
      ctx.fillStyle = locked ? 'rgba(120,88,150,0.34)' : 'rgba(255,215,94,0.82)';
      rr(ctx, tx, ty, mS, mS, 4); ctx.fill();
      if (locked) {
        ctx.strokeStyle = 'rgba(200,170,230,0.30)'; ctx.lineWidth = 1;
        rr(ctx, tx + 0.5, ty + 0.5, mS - 1, mS - 1, 4); ctx.stroke();
      }
    }
    ctx.fillStyle = 'rgba(232,220,200,0.5)'; ctx.font = fT(11);
    ctx.fillText(pw + ' of ' + CAREER_MAX + ' levels open', cx, mY + 4 * (mS + mG) + 8,
                 VIEW_MIN_W - 40);

    // THE PRICE COMES FROM THE STOREFRONT OR IT DOES NOT COME AT ALL.
    // A hardcoded figure is wrong on every non-USD storefront and is an App
    // Review 3.1.2 rejection; saying so plainly beats inventing a number.
    var have = Ent.owned();
    var label = have ? 'ALREADY YOURS'
              : Store.busy ? 'ONE MOMENT\u2026'
              : Store.price ? 'UNLOCK  \u00b7  ' + Store.price
              : 'PRICE UNAVAILABLE';
    this._menuBtn(label, PAY_RECTS.buy.y, { w: PAY_RECTS.buy.w, h: PAY_RECTS.buy.h, tone: 'career',
                                      icon: 'gem_prism',
                                      disabled: have || Store.busy || !Store.price });
    this._menuBtn('RESTORE PURCHASE', PAY_RECTS.restore.y,
                  { w: PAY_RECTS.restore.w, h: PAY_RECTS.restore.h, quiet: true, disabled: Store.busy });
    this._menuBtn('NOT NOW', PAY_RECTS.back.y, { w: PAY_RECTS.back.w, h: PAY_RECTS.back.h, quiet: true });

    if (Store.note) {
      ctx.fillStyle = 'rgba(232,220,200,0.8)'; ctx.font = fT(12);
      ctx.fillText(Store.note, cx, PAY_RECTS.back.y + PAY_RECTS.back.h + 10, VIEW_MIN_W - 40);
    } else if (!Store.available()) {
      ctx.fillStyle = 'rgba(232,220,200,0.55)'; ctx.font = fT(11);
      ctx.fillText('This build has no store — the full ladder ships with the app.',
                   cx, PAY_RECTS.back.y + PAY_RECTS.back.h + 10, VIEW_MIN_W - 40);
    }
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  };

  Game.prototype.careerFinale = function () {
    return !!(this.career && this.careerResult && this.careerResult.won &&
              this.career.level >= CAREER_MAX);
  };

  Game.prototype._drawResults = function () {
    var ctx = this.ctx, v = this.view;
    // 0.82 left the whole pile legible THROUGH the results, so the headline and
    // the star row sat on a field of gems — the same noise the home screen was
    // called out for. Darker scrim, plus a plate under the column so the text
    // has a surface. Both branches end with MENU at 636 (+56), so 150..706
    // covers the career and the free/daily layouts alike.
    ctx.fillStyle = 'rgba(20,14,10,0.90)';
    ctx.fillRect(-v.ox, -v.uiTop, v.w, v.h + v.uiTop);
    // the plate ends 14 under the last button, so it closes up with them
    var plateH = resultsRects(this).menu + 56 + 14 - 150;
    ctx.fillStyle = 'rgba(43,32,24,0.72)';
    rr(ctx, VIEW_MIN_W / 2 - 168, 150, 336, plateH, 20); ctx.fill();
    ctx.strokeStyle = 'rgba(201,168,106,0.30)'; ctx.lineWidth = 1.5;
    rr(ctx, VIEW_MIN_W / 2 - 168, 150, 336, plateH, 20); ctx.stroke();
    // Results was the one screen with neither a working control nor a way in:
    // _hud paints the in-shift gear every frame, this scrim then buries it, and
    // the results branch never hit-tested it. Draw a live one ON TOP.
    this._drawGearAt(MENU.gear);
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    if (this.career) {
      var cr = this.careerResult || { won: false, stars: 0 };
      ctx.fillStyle = cr.won ? '#ffd75e' : '#f0a090';
      fitD(ctx, cr.won ? 'LEVEL ' + this.career.level + ' CLEARED!'
                       : 'THE PICK GAVE OUT', VIEW_MIN_W / 2, 180, 304, 32);
      for (var st = 0; st < 3; st++) {
        var sx = VIEW_MIN_W / 2 + (st - 1) * 54;
        drawStar(ctx, sx, 258, 22, st < cr.stars ? '#ffd75e' : 'rgba(255,255,255,0.18)');
      }
      // Stars are the career currency and still lead. Coins are banked on a
      // FIRST clear only (the level seed is fixed, so paying replays would be
      // farmable) — so the payout is shown as a secondary line, and only when
      // it actually paid.
      ctx.fillStyle = '#fff'; ctx.font = fD(22);
      ctx.fillText(cr.won ? (cr.stars === 3 ? 'A FLAWLESS SHIFT' : 'THE ORDERS ARE FILLED')
                          : this.ordersDone + '/' + this.goalOrders + ' orders filled',
                   VIEW_MIN_W / 2, 300);
      ctx.fillStyle = 'rgba(232,220,200,0.75)'; ctx.font = fT(14);
      ctx.fillText(cr.won ? 'swings left at the bell: ' + Math.max(0, this.swingsAtGoal)
                          : 'plan the dig — every swing counts', VIEW_MIN_W / 2, 334);
      if (cr.banked > 0) {
        ctx.fillStyle = '#ffd75e'; ctx.font = fT(15, 'bold');
        ctx.fillText('+' + cr.banked + 'c banked  ·  first clear', VIEW_MIN_W / 2, 356);
      }
      if (this.hoard) {
        ctx.fillStyle = '#e8c9ff'; ctx.font = fT(14, 'bold');
        ctx.fillText('+' + this.hoard + ' to the hoard (kept)', VIEW_MIN_W / 2, cr.banked > 0 ? 378 : 358);
      }
      var last = this.careerFinale();
      if (last) {
        ctx.fillStyle = '#ffd75e'; ctx.font = fT(15, 'bold');
        ctx.fillText('END OF THE SHAFT — for now.', VIEW_MIN_W / 2, 392);
        ctx.fillStyle = 'rgba(232,220,200,0.7)'; ctx.font = fT(13);
        ctx.fillText('The daily dig is where the diggers are.', VIEW_MIN_W / 2, 414);
      }
      // THE OUT. A career seed is FIXED, so a stuck player was retrying the
      // identical jar forever with no lever — the single worst thing in the
      // game. Coins buy a deeper pick for the retry. Career/free only: the
      // daily must stay one jar, one budget, for everyone.
      if (!cr.won) {
        var canAfford = (Meta.data.coins || 0) >= DEEPER_PICK_COST;
        ctx.fillStyle = canAfford ? '#ffd75e' : 'rgba(200,186,166,0.45)';
        ctx.font = fT(14, 'bold');
        ctx.fillText(canAfford ? 'RETRY WITH A DEEPER PICK  ·  ' + DEEPER_PICK_COST + 'c'
                               : 'a deeper pick costs ' + DEEPER_PICK_COST + 'c  ·  you have '
                                 + (Meta.data.coins || 0) + 'c',
                     VIEW_MIN_W / 2, 450);
        ctx.fillStyle = 'rgba(232,220,200,0.6)';
        // 55 IS THE FREE BUDGET AND THIS BUTTON CANNOT REACH IT. Career budgets
        // come from careerCfg and run 54..66 — level 14 is the only one that is
        // 55 — so the line named the one number that is wrong on 39 of the 40
        // levels it can appear on. The rule it was trying to state is real and
        // better said plainly: stars score on `swingsAtGoal - pickBonus`, i.e.
        // on THIS level's own budget with the bought swings taken back off.
        fitT(ctx, '+' + DEEPER_PICK_SWINGS + ' swings next attempt · the bought swings do not count toward stars',
             VIEW_MIN_W / 2, 470, 300, 12);
        // Drawn DISABLED when it cannot be bought. It used to render at full
        // gold strength either way, so a broke player tapped a live-looking
        // button and got a thunk — and this is the button hit-tested BEFORE
        // RETRY, i.e. the one that must never look more inviting than it is.
        this._menuBtn(canAfford ? 'DEEPER PICK · ' + DEEPER_PICK_COST + 'c' : 'DEEPER PICK',
                      490, { disabled: !canAfford });
      }
      var RB = resultsRects(this);
      // The label has to tell the truth about where the button goes: on a free
      // save that just cleared its last free level, it opens the paywall.
      var atWall = !!(cr.won && this.career && this.career.level + 1 > careerCap());
      this._menuBtn(last ? 'DAILY DIG'
                  : atWall ? 'UNLOCK TO CONTINUE'
                  : cr.won ? 'NEXT LEVEL' : 'RETRY', RB.again);
      this._menuBtn('MENU', RB.menu);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      return;
    }
    // A shift that ran out of swings short of the goal is a LOSS. This used to
    // print celebratory gold either way, so the player could not tell that
    // failing was even possible (Pillar 2: never celebrate a net loss).
    var won = this.ordersDone >= this.goalOrders;
    ctx.fillStyle = won ? '#ffd75e' : '#f0a090';
    ctx.font = fD(34);
    ctx.fillText(won ? 'SHIFT COMPLETE' : 'THE PICK GAVE OUT', VIEW_MIN_W / 2, 180);
    ctx.fillStyle = '#fff'; ctx.font = fD(26);
    ctx.fillText(this.coins + ' coins', VIEW_MIN_W / 2, 250);
    // DID IT GO IN THE PURSE? `this.banked` has been computed by _endShift
    // since the wallet shipped and read by NOTHING — grep found only its two
    // write sites. So a daily replay and an archive dig, neither of which pays,
    // printed the same confident coin total as a run that did, and the only
    // way to find out was to go and look at the shop. The career screen has
    // always been careful about exactly this ("+Nc banked · first clear"); this
    // branch was the inconsistency.
    if (this.banked > 0) {
      ctx.fillStyle = '#8fd08a'; ctx.font = fT(12, 'bold');
      ctx.fillText('+' + this.banked + 'c banked · purse ' + (Meta.data.coins || 0) + 'c',
                   VIEW_MIN_W / 2, 272, 320);
    } else if (this.coins > 0) {
      ctx.fillStyle = 'rgba(232,220,200,0.62)'; ctx.font = fT(12);
      ctx.fillText(this.archiveDay ? 'archive dig · coins not banked'
                                   : "today's daily has already paid · coins not banked",
                   VIEW_MIN_W / 2, 272, 320);
    }
    ctx.fillStyle = won ? '#e8dcc8' : '#f0a090';
    ctx.font = won ? fD(16, 'normal') : fD(17);
    ctx.fillText(this.ordersDone + '/' + this.goalOrders + ' orders · ' + this.pops + ' swings · hoard +' + this.hoard, VIEW_MIN_W / 2, 295);
    // NAME THE CONTRACTS JUST CLOSED. A reward the player cannot see is the
    // mistake this project has made with almost every system it added — the
    // crusted rock, the skins, the ranks. At most two are listed; the rest are
    // counted, because the results screen has ~40 units here before the
    // personal-best line at 320.
    if (this.contractsWon && this.contractsWon.length) {
      var cw = this.contractsWon;
      ctx.fillStyle = '#e8c9ff'; ctx.font = fT(13, 'bold');
      var label = cw.length === 1 ? 'CONTRACT: ' + cw[0].name
                : cw.length === 2 ? 'CONTRACTS: ' + cw[0].name + ' · ' + cw[1].name
                : cw.length + ' CONTRACTS CLOSED';
      var hsum = 0;
      for (var ci = 0; ci < cw.length; ci++) hsum += cw[ci].h;
      ctx.fillText(label + '  +' + hsum + ' hoard', VIEW_MIN_W / 2, 313, 320);
    }
    // AN ARCHIVE RUN IS NOT TODAY. `isDaily` is true for one, so this whole
    // block called a jar up to fourteen days old "today": the record line said
    // "today's best", and the board below it painted rows Lb.top fetched for
    // the CURRENT day beside a score from a different game entirely (an archive
    // run returns from _endShift before `this.board = null`, so it could even be
    // a board left over from an earlier run this session). The archive tab
    // itself is honest about which day it is; the results screen was not.
    var arch = !!this.archiveDay;
    var best = this.isDaily ? (Meta.data.bestDaily[this.day] || 0) : Meta.data.bestFree;
    if (this.coins >= best && this.coins > 0) {
      ctx.fillStyle = '#ffd75e'; ctx.font = fT(15, 'bold');
      ctx.fillText(arch ? 'BEST ON THIS DAY!'
                        : this.isDaily ? 'BEST DAILY DIG TODAY!' : 'BEST FREE DIG EVER!',
                   VIEW_MIN_W / 2, 328);
    } else {
      ctx.fillStyle = 'rgba(232,220,200,0.7)'; ctx.font = fT(14);
      ctx.fillText((arch ? "best on this day: " : this.isDaily ? "today's best: " : 'best: ') + best,
                   VIEW_MIN_W / 2, 328);
    }
    if (arch) {
      // say WHY there is no board, rather than leaving a hole where one was
      ctx.fillStyle = 'rgba(232,201,255,0.65)'; ctx.font = fT(12);
      ctx.fillText('archive dig · not scored on the board', VIEW_MIN_W / 2, 362, 320);
    }
    if (this.isDaily && !arch && this.board && this.board.length) {
      ctx.fillStyle = '#c9a86a'; ctx.font = fT(13, 'bold');
      ctx.fillText("TODAY'S DIGGERS", VIEW_MIN_W / 2, 362);
      for (var bi = 0; bi < this.board.length && bi < 8; bi++) {
        var row = this.board[bi];
        var mine = row.player === Meta.data.playerName;
        ctx.fillStyle = mine ? '#ffd75e' : '#e8dcc8';
        ctx.font = (mine ? 'bold ' : '') + fT(13);
        ctx.textAlign = 'left';
        ctx.fillText((bi + 1) + '.  ' + safeName(row.player), VIEW_MIN_W / 2 - 110, 386 + bi * 19);
        ctx.textAlign = 'right';
        ctx.fillText(row.coins + 'c', VIEW_MIN_W / 2 + 110, 386 + bi * 19);
        ctx.textAlign = 'center';
      }
    }
    var RB2 = resultsRects(this);
    this._menuBtn('AGAIN', RB2.again);
    this._menuBtn('MENU', RB2.menu);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  };

  // ---- MainLoop pattern: accumulate real time, step at a FIXED rate, render
  // ---- once with an interpolation alpha. 60 Hz phone and 120 Hz tablet run the
  // ---- IDENTICAL simulation.
  Game.prototype._frame = function (ts) {
    requestAnimationFrame(this._frame);
    if (!this._last) this._last = ts;
    // Clamped at BOTH ends. The 0.1 ceiling stops a backgrounded tab from
    // stepping the world 200 times on resume; the 0 floor stops a timestamp
    // that goes BACKWARD from running every cosmetic age in reverse. Without
    // the floor, one negative dt drives ring.t to about -41, and the
    // extraction ring is drawn at `r + t*26` — an arc with radius -1051, which
    // throws IndexSizeError and kills the render loop outright.
    var dtRaw = Math.max(0, Math.min(0.1, (ts - this._last) / 1000));
    this._last = ts;
    if (!this._ft) this._ft = [];
    this._ft.push(dtRaw * 1000);
    if (this._ft.length > 240) this._ft.shift();
    var STEP = 1 / CFG.stepHz;
    if (this.hitStop > 0) {
      this.hitStop -= dtRaw;             // the world holds its breath
    } else if (this.state === 'playing') {
      this._acc += dtRaw;
      var n = 0;
      // _clacks samples per STEP, not per frame. b.px/b.py hold the START of
      // the step that just ran, so an impact is only visible in the step it
      // happens in — and at stepHz 120 against a 60Hz frame, a once-per-frame
      // sampler sees every other step and misses most landings outright.
      // Measured: sampling in _cosmetic gave 1 clack across 15 real digs
      // (0.07/dig) where a per-step harness predicted 2.27. The voice budget
      // inside _clacks is what keeps 12 possible calls per frame safe.
      while (this._acc >= STEP && n < 12) {
        this.update(STEP); this._clacks(); this._acc -= STEP; n++;
      }
    }
    this._cosmetic(dtRaw);
    this.draw(this.state === 'playing' ? this._acc / STEP : 0);
  };

  // ---- TYPE. One definition, because there were 101 of them. ----------------
  //
  // 94% of this game's `ctx.font` sites said `system-ui, sans-serif` — the
  // operating system's own UI face, set over hand-painted oil art. That single
  // fact is most of why the interface read as cheap next to the mole: the art
  // was authored and the words were not. Two places already used Georgia (the
  // title, the shop sign) and they were the best-looking type in the build, so
  // the fix is to make the good thing the system rather than invent a new one.
  //
  // WHY A SYSTEM FACE AND NOT A WEBFONT. Canvas `ctx.font` silently falls back
  // when the family has not finished loading, and there is no event that tells
  // you it happened — you just ship a frame in Helvetica. Gating first paint on
  // `document.fonts.ready` fixes that but adds a load step that a cold WKWebView
  // boot can stall on. Georgia ships with iOS, macOS, Windows and Android's
  // fallback chain, so it cannot fail, cannot flash, and costs zero bytes. If we
  // later want the marketing site's Baloo 2 in here, it arrives as a bundled
  // woff2 + a FontFace().load() gate — a deliberate change, not a stack tweak.
  var F_DISP = 'Georgia, "Iowan Old Style", "Times New Roman", serif';
  var F_TEXT = '"Avenir Next", "Segoe UI", Roboto, system-ui, sans-serif';
  function fD(px, w) { return (w || 'bold') + ' ' + px + 'px ' + F_DISP; }   // display
  function fT(px, w) { return (w ? w + ' ' : '') + px + 'px ' + F_TEXT; }    // text/UI

  // NUMBERS USE THE TEXT FACE, ALWAYS. Georgia's numerals are OLD-STYLE: 3,4,5,7,9
  // descend below the baseline and 0,1,2 sit at x-height. In a display heading
  // that is elegant; in a data readout it looks broken, and "5670c" in the coin
  // pill was the first thing Vanus called out as "not right". F_TEXT has lining
  // figures — equal height, sitting on the baseline — which is what a counter,
  // a price, a score or a timer needs.
  function fN(px, w) { return (w || 'bold') + ' ' + px + 'px ' + F_TEXT; }   // numeric

  // TEXT THAT FITS BY GETTING SMALLER, NOT NARROWER.
  //
  // fillText's 4th argument CONDENSES glyphs horizontally — it does not scale
  // them — so a string 20% too long is drawn at 80% width with full-height
  // letterforms. That is exactly the "squished" look, and this file passed a
  // maxWidth at 36 sites. Adding the gem medallion to _menuBtn cut the label
  // budget by 46 units and pushed several menu subtitles well past the point
  // where the distortion is visible.
  //
  // This measures first and scales the SIZE, preserving letterforms. Condensing
  // is kept only as the last resort below FIT_MIN, where an unreadably small
  // line would be worse than a slightly narrow one.
  var FIT_MIN = 9;
  function fitText(ctx, text, x, y, maxW, mk, px) {
    ctx.font = mk(px);
    var w = ctx.measureText(text).width;
    if (w <= maxW) { ctx.fillText(text, x, y); return; }
    var scaled = Math.max(FIT_MIN, Math.floor(px * (maxW / w) * 10) / 10);
    ctx.font = mk(scaled);
    if (ctx.measureText(text).width > maxW) ctx.fillText(text, x, y, maxW);
    else ctx.fillText(text, x, y);
  }
  function fitD(ctx, t, x, y, maxW, px, w) {
    fitText(ctx, t, x, y, maxW, function (p) { return fD(p, w); }, px);
  }
  function fitT(ctx, t, x, y, maxW, px, w) {
    fitText(ctx, t, x, y, maxW, function (p) { return fT(p, w); }, px);
  }

  // ---- BUTTON TONES. One row per mode, so three identical slabs become three
  // recognisable objects. Deliberately pulled toward the burrow: these are lit
  // garnet / lapis / moss in lamplight, not saturated red/blue/green, because
  // the job is "tell them apart", not "look like every other mobile game".
  // Every tone keeps a brown floor and a warm rim: these are stones lit by ONE
  // lantern, so nothing may read as its own light source. The first pass used
  // brighter cooler rims and the blue and green plates floated off the wall
  // like plastic — the hue carries the identity, the warmth keeps them in the room.
  var BTN_TONE = {
    career: { top: '#5e332c', bot: '#3a1f1a', rim: 'rgba(226,150,112,0.62)', ink: '#f7dccd' },
    daily:  { top: '#2e405e', bot: '#1b2739', rim: 'rgba(190,178,150,0.58)', ink: '#dde5f2' },
    free:   { top: '#375138', bot: '#213221', rim: 'rgba(196,190,130,0.58)', ink: '#dfeadb' },
    wood:   { top: '#5a4632', bot: '#3f3123', rim: 'rgba(255,215,94,0.85)',  ink: '#ffe9a8' },
    // The dilemma's dragon plate. Violet is already the hoard's colour on this
    // screen (the ledge ring, the milestone burst), so the plate inherits it
    // rather than inventing a seventh hue — and it keeps the brown floor and
    // the warm rim every other tone keeps, for the reason written above.
    hoard:  { top: '#4b3760', bot: '#2f2242', rim: 'rgba(232,201,255,0.80)', ink: '#eddcff' },
  };

  // ---- tiny draw helpers ----
  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function drawStar(ctx, x, y, r, col) {
    ctx.fillStyle = col;
    ctx.beginPath();
    for (var i = 0; i < 10; i++) {
      var ang = -1.5708 + i * 0.62832;
      var rr2 = i % 2 === 0 ? r : r * 0.45;
      var px = x + Math.cos(ang) * rr2, py = y + Math.sin(ang) * rr2;
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.closePath(); ctx.fill();
  }

  function mix(h1, h2, t) {
    var a = parseInt(h1.slice(1), 16), b = parseInt(h2.slice(1), 16);
    var r = Math.round(((a >> 16) & 255) + (((b >> 16) & 255) - ((a >> 16) & 255)) * t);
    var g = Math.round(((a >> 8) & 255) + (((b >> 8) & 255) - ((a >> 8) & 255)) * t);
    var c = Math.round((a & 255) + ((b & 255) - (a & 255)) * t);
    return 'rgb(' + r + ',' + g + ',' + c + ')';
  }

  // ===== boot + input + DEV-GATED debug surface ===========================
  var canvas = document.getElementById('game-canvas');
  var game = new Game(canvas);
  // AFTER the native restore settles — the queued payload lives in Meta, and
  // a payload from a day that has already turned can never be accepted.
  // IAP boot: load the storefront price, and silently re-yield any transaction
  // that was verified but never finished — the app can be killed between the
  // grant and the finish, and the retry is what makes the handshake
  // exactly-once rather than best-effort. Both are no-ops without the plugin.
  Meta.ready(function () { Store.load(); Store.recover(); });
  // ...and again on resume: a purchase completed while the app was backgrounded
  // (Ask to Buy, a slow Apple ID prompt) arrives with no launch to catch it.
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) Store.recover();
  });

  Meta.ready(function () {
    var p = Meta.data.pendingScore;
    if (!p) return;
    if (p.day !== dayNumber()) { Meta.data.pendingScore = null; Meta.save(); return; }
    Lb.submit(p, function (ok) {
      if (ok) { Meta.data.pendingScore = null; Meta.save(); }
    });
  });
  window.addEventListener('resize', function () { game.resize(); });

  // UI routing happens HERE (listener), sim taps are queued for update() —
  // that keeps Math.random-free update() while menus can pick free seeds.
  window.addEventListener('pointerdown', function (e) {
    Snd.unlock();
    // THE HAND-OVER GUARD (§3p). Every screen in this game appears under the
    // finger that summoned it, and the next tap is routed by the NEW screen: a
    // stray tap after the bell spends 250c on DEEPER PICK, and a stray tap
    // after RETRY spends a swing on the fresh jar. Arming is automatic —
    // whenever a tap changes `state` or `showSettings`, the lock is set below,
    // so a new branch cannot forget to do it.
    if (game._uiLockUntil && nowMs() < game._uiLockUntil) return;
    var _st0 = game.state, _ss0 = game.showSettings;
    _routeTap(game.toWorld(e.clientX, e.clientY));
    if (game.state !== _st0 || game.showSettings !== _ss0) {
      game._uiLockUntil = nowMs() + UI_LOCK_MS;
    }
  });

  function _routeTap(w) {
    // The settings overlay is drawn on top of every screen, so it must eat the
    // tap before any screen routes it — otherwise a tap aimed at the panel
    // reaches the button underneath.
    if (game.showSettings) { game._settingsTap(w); return; }
    if (game.state === 'records') {
      if (inRect(w, SHOP_GEAR)) { uiTick(); game.openSettings(); return; }
      // recordsRects(), not the literals — the same promise SHOP_ROW_Y makes.
      var RR = game.recordsRects();
      if (inRect(w, padHitUp(RR.tabStats))) { uiTick(); game.recTab = 'stats'; return; }
      if (inRect(w, padHitUp(RR.tabPast))) { uiTick(); game.recTab = 'past'; return; }
      if (inRect(w, padHitUp(RR.tabJobs))) { uiTick(); game.recTab = 'jobs'; return; }
      if (game.recTab === 'jobs') {
        var pr = game.jobsPageRect();
        if (inRect(w, pr)) {
          uiTick();
          var pgs = Math.ceil(CONTRACTS.length / JOBS_PER_PAGE);
          // left half pages back, right half pages forward — the chevrons say so
          var dir = w.x < pr.x + pr.w / 2 ? -1 : 1;
          game.jobsPage = ((game.jobsPage || 0) + dir + pgs) % pgs;
          return;
        }
      }
      if (game.recTab === 'past') {
        var ppr = game.pastPageRect();
        var ppgs = Math.ceil(ARCHIVE_DAYS / PAST_PER_PAGE);
        if (ppgs > 1 && inRect(w, ppr)) {
          uiTick();
          game.pastPage = ((game.pastPage || 0) + (w.x < ppr.x + ppr.w / 2 ? -1 : 1) + ppgs) % ppgs;
          return;
        }
        // tap a day to dig it. dailyCharacter and seedForDay are both pure
        // functions of the day number, so the jar rebuilds exactly.
        var apage = game.pastPage || 0;
        var ar = game.archiveRows().slice(apage * PAST_PER_PAGE, apage * PAST_PER_PAGE + PAST_PER_PAGE);
        for (var ai = 0; ai < ar.length; ai++) {
          var ay = PAST_ROW_Y + ai * PAST_ROW_H;
          // the FULL pitch, not the drawn height: a 4-unit dead gap between two
          // rows that each launch a dig is a mis-hit that silently does nothing
          if (w.y >= ay && w.y < ay + PAST_ROW_H &&
              w.x > VIEW_MIN_W / 2 - 150 && w.x < VIEW_MIN_W / 2 + 150) {
            uiTick();
            // The archive is part of the unlock (store/iap-catalog.json).
            // Today's daily is always free — only the PAST jars are behind it.
            if (!Ent.owned()) { uiTick(); game.openPaywall(); return; }
            game.start(0, 'daily', 0, ar[ai].day);
            return;
          }
        }
      }
      if (inRect(w, padHitUp(RR.tabLeague))) {
        uiTick();
        game._loadLeague(game.recTab === 'league');   // same-tab tap retries
        game.recTab = 'league';
        return;
      }
      if (inRect(w, padHitUp(RR.tabBoard))) {
        uiTick();
        // Tapping the tab it is already on RETRIES — that is what the error
        // state tells the player to do, and it is the only retry affordance
        // on the screen.
        game._loadBoard(game.recTab === 'board');
        game.recTab = 'board';
        return;
      }
      if (hitBtn(w, RR.backY)) {
        uiTick(); game.state = 'menu'; Snd.scene('shop'); return;
      }
      return;
    }
    if (game.state === 'shop') {
      if (inRect(w, SHOP_GEAR)) { uiTick(); game.openSettings(); return; }
      var TBs = shopTabs();
      // padded UPWARD only: the wall rows start at 250 and a downward pad
      // would steal the top of row 0, which is a purchase
      if (inRect(w, padHitUp(TBs.walls)))  { uiTick(); game.shopTab = 'walls'; return; }
      if (inRect(w, padHitUp(TBs.dragon))) { uiTick(); game.shopTab = 'dragon'; return; }
      if (inRect(w, padHitUp(TBs.pick)))   { uiTick(); game.shopTab = 'pick'; return; }

      if (game.shopTab === 'pick') {
        for (var pi = 0; pi < PICK_SKINS.length; pi++) {
          var py = dragonRowY(pi);
          if (w.y >= py && w.y < py + DRAGON_HIT_H &&
              w.x > VIEW_MIN_W / 2 - 150 && w.x < VIEW_MIN_W / 2 + 150) {
            var psk = PICK_SKINS[pi];
            if (!pickUnlocked(psk)) { Snd.thunk(); return; }
            uiTick();
            Meta.data.equipped = Meta.data.equipped || {};
            Meta.data.equipped.pick = psk.id;
            Meta.save();
            return;
          }
        }
        if (hitBtn(w, game._shopBackY(dragonRowY(PICK_SKINS.length) + 6))) {
          uiTick(); game.state = 'menu'; Snd.scene('shop'); return;
        }
        return;
      }
      if (game.shopTab === 'dragon') {
        // dragonRowY/DRAGON_ROW_H, not the literals — same promise as the
        // wall rows below.
        for (var di = 0; di < DRAGON_SKINS.length; di++) {
          var dy = dragonRowY(di);
          if (w.y >= dy && w.y < dy + DRAGON_HIT_H &&
              w.x > VIEW_MIN_W / 2 - 150 && w.x < VIEW_MIN_W / 2 + 150) {
            var dsk = DRAGON_SKINS[di];
            if (!dragonUnlocked(dsk)) { Snd.thunk(); return; }
            uiTick();
            Meta.data.equipped = Meta.data.equipped || {};
            Meta.data.equipped.dragon = dsk.id;
            Meta.save();
            game.dragonPulse = 1;
            return;
          }
        }
        if (hitBtn(w, game._shopBackY(dragonRowY(DRAGON_SKINS.length) + 6))) {
          uiTick(); game.state = 'menu'; Snd.scene('shop'); return;
        }
        return;
      }
      var backY = game._shopBackY(shopRowY(WALL_SKINS.length) + 6);
      if (hitBtn(w, backY)) { uiTick(); game.state = 'menu'; Snd.scene('shop'); return; }
      for (var si = 0; si < WALL_SKINS.length; si++) {
        // shopRowY/SHOP_ROW_H, not the literals they expand to today — the
        // comment on SHOP_ROW_Y promises both sides read the same source, and
        // re-deriving the geometry here is how that promise silently breaks.
        var ry = shopRowY(si);
        if (w.y < ry || w.y > ry + SHOP_ROW_H) continue;
        if (w.x < VIEW_MIN_W / 2 - 150 || w.x > VIEW_MIN_W / 2 + 150) continue;
        var sk = WALL_SKINS[si];
        var owned = sk.price === 0 || !!(Meta.data.owned && Meta.data.owned[sk.id]);
        if (!owned) {
          if ((Meta.data.coins || 0) < sk.price) { Snd.thunk(); return; }   // can't afford
          Meta.data.coins -= sk.price;
          Meta.data.owned = Meta.data.owned || {};
          Meta.data.owned[sk.id] = 1;
          Snd.fanfare(150);
        } else {
          Snd.pop();
        }
        Meta.data.equipped = Meta.data.equipped || {};
        Meta.data.equipped.wall = sk.id;      // buying also wears it
        Meta.save();
        return;
      }
      return;
    }
    if (game.state === 'levels') {
      if (inRect(w, SHOP_GEAR)) { uiTick(); game.openSettings(); return; }
      if (hitBtn(w, LEVELS_BACK_Y)) { uiTick(); game.state = 'menu'; return; }
      var payWall = careerCap();
      var reachedLv = Math.min(payWall, Meta.data.careerLevel || 1);
      for (var li = 0; li < CAREER_MAX; li++) {
        if (!inRect(w, levelRect(li))) continue;
        // A LOCKED LEVEL IS THE STOREFRONT. Tapping one past the wall is the
        // only unprompted route to the paywall in the whole game — the player
        // asked what is over there, so answer.
        if (li + 1 > payWall) { uiTick(); game.openPaywall(); return; }
        if (li + 1 > reachedLv) { Snd.thunk(); return; }     // reachable, not reached yet
        uiTick();
        game.start(0, 'career', li + 1);
        return;
      }
      return;
    }
    if (game.state === 'paywall') {
      if (inRect(w, SHOP_GEAR)) { uiTick(); game.openSettings(); return; }
      var PR = game.paywallRects();
      if (hitBtn(w, PR.buy.y) && !Ent.owned() && !Store.busy && Store.price) {
        uiTick();
        Store.buy(function (got) { if (got) { Snd.fanfare(300); Hap.heavy(); } });
        return;
      }
      if (hitBtn(w, PR.restore.y) && !Store.busy) {
        uiTick();
        Store.restore(function (got) { if (got) { Snd.fanfare(150); Hap.medium(); } });
        return;
      }
      if (hitBtn(w, PR.back.y)) { uiTick(); game.state = 'levels'; return; }
      return;
    }
    if (game.state === 'menu') {
      // MENU, not a second list of magic y's that has to be kept in step with
      // the draw by hand.
      // menuRect(), not MENU — the body rides a device-dependent centring shift
      // and the hit test has to ride it too.
      if (inRect(w, game.menuRect('gear'))) { uiTick(); game.openSettings(); return; }
      if (inRect(w, game.menuRect('strip'))) { uiTick(); game.state = 'levels'; return; }
      // SHOP's only sound WAS `Snd.scene('shop')`, and startBed early-returns on
      // `curName === name` — the shop bed is already playing on the menu, so the
      // most-tapped button in the game answered with literal silence.
      if (inRect(w, game.menuRect('shop'))) { uiTick(); game.state = 'shop'; game.shopTab = game.shopTab || 'walls'; Snd.scene('shop'); return; }
      // the status card is the door to RECORDS. It shifts with the rest of the
      // menu body on short devices, so it reads _menuShift the same way
      // menuRect does rather than using the authored y.
      var rc = game.recordsRects().card;
      if (inRect(w, { x: rc.x, y: rc.y + game._menuShift(), w: rc.w, h: rc.h })) {
        uiTick();
        game.state = 'records';
        game.recTab = game.recTab || 'stats';
        game._loadBoard(false);      // warm it now; the tab is one tap away
        game._loadLeague(false);
        Snd.scene('shop'); return;
      }
      if (inRect(w, game.menuRect('career'))) { uiTick(); game.start(0, 'career'); }
      else if (inRect(w, game.menuRect('daily'))) {
        // THE BUTTON NOW KEEPS THE CAPTION'S PROMISE. It reads "after your
        // first shift" on a fresh save and used to start anyway — dropping a
        // brand-new player into a 10-order jar with a RUSH card already
        // counting down, running the coach written for career L1, and spending
        // the day's only bankable daily on the attempt.
        // A refusal must be VISIBLE. this.toast is drawn by the in-play HUD and
        // by nothing on the menu, so a toast here would have been a silent
        // thunk on a button that still looked live — the same defect this pass
        // has been fixing all day. The button is drawn DISABLED on a fresh save
        // instead, so the caption, the art and the tap all say the same thing.
        if (!Meta.data.tutorialDone) { Snd.thunk(); return; }
        uiTick(); game.start(dailySeed(), 'daily');
      }
      else if (inRect(w, game.menuRect('free'))) { uiTick(); game.start((Math.random() * 4294967296) >>> 0, 'free'); }
      return;
    }
    if (game.state === 'results') {
      // the chrome gear _drawResults paints over its own scrim
      if (inRect(w, MENU.gear)) { uiTick(); game.openSettings(); return; }
      // FREE is sold as "a fresh random jar" — AGAIN must actually deal one.
      // Daily keeps its seed (it IS the shared jar); career is seeded by level.
      // the deeper pick: spend, arm it, and relaunch the SAME level
      var RB = resultsRects(game);
      if (RB.pick > 0 && game.career && game.careerResult && !game.careerResult.won && hitBtn(w, RB.pick)) {
        if ((Meta.data.coins || 0) < DEEPER_PICK_COST) { Snd.thunk(); return; }
        Meta.data.coins -= DEEPER_PICK_COST;
        Meta.save();
        Snd.fanfare(150);
        game.pendingPick = DEEPER_PICK_SWINGS;
        // THE SAME LEVEL — which is what the line above this block already
        // promised and what the code did not do. start()'s `level` argument
        // defaults to the FRONTIER (start(): `want = level ? ... : reached`),
        // so a player replaying an earlier level for a better star, who failed
        // and bought the deeper pick, was charged 250c and then dealt their
        // highest level instead. The level map has always passed the level
        // (game.start(0, 'career', li + 1)); both ways OUT of a shift did not.
        game.start(0, 'career', game.career.level);
        return;
      }
      if (hitBtn(w, RB.again)) {
        uiTick();
        // DAILY RE-DERIVES ITS SEED, it does not reuse game.seed. start() takes
        // `this.day = dayNumber()` fresh, so replaying across UTC midnight with
        // yesterday's seed produced a run whose jar is day N and whose day
        // stamp is N+1: the bank gate (bankedDay !== this.day) opens for a
        // SECOND payout, and the leaderboard payload posts yesterday's jar as
        // today's score. Re-deriving makes the two agree by construction.
        // The finale button says DAILY DIG, so it must START the daily.
        if (game.careerFinale()) {
          game.start(dailySeed(), 'daily');
        } else if (game.career) {
          // ONE BUTTON, TWO VERBS — and it only ever did one of them.
          //
          // The label is NEXT LEVEL on a win and RETRY on a loss, and this
          // branch passed `game.career.level` for both, so NEXT LEVEL replayed
          // the level just cleared. I introduced that fixing RETRY: RETRY MEANS
          // THIS LEVEL was right, and I applied it to a handler both labels
          // share without checking what the other one needed.
          var wonIt = !!(game.careerResult && game.careerResult.won);
          var nextLv = game.career.level + (wonIt ? 1 : 0);
          // ...and the wall is exactly here. A free save that just cleared its
          // last free level would otherwise be handed level 10 again, forever,
          // with a button that says NEXT LEVEL. Ask instead.
          if (wonIt && nextLv > careerCap()) { game.openPaywall(); return; }
          game.start(0, 'career', nextLv);
        } else if (game.archiveDay) {
          // AN ARCHIVE RUN'S AGAIN MUST RE-DEAL *THAT* DAY'S JAR. start() takes
          // archiveDay as its fourth argument and this call never passed it, so
          // AGAIN on a past-day run swapped in today's jar under a screen still
          // labelled with the archive date — and today's jar is the one the
          // leaderboard is for.
          game.start(0, 'daily', 0, game.archiveDay);
        } else {
          game.start(game.mode === 'free' ? ((Math.random() * 4294967296) >>> 0)
                   : game.mode === 'daily' ? dailySeed() : game.seed, game.mode);
        }
      }
      else if (hitBtn(w, RB.menu)) { uiTick(); game.state = 'menu'; Snd.scene('shop'); }
      return;
    }
    if (game.state === 'paused') {
      // showSettings was handled at the top; a bare lifecycle pause resumes on
      // any tap, as the on-screen text promises.
      game.setPaused(false);
      return;
    }
    if (game.state === 'playing') {
      // UI routing lives in the listener, where device geometry is allowed.
      // Same rect the gear is drawn from — these used to drift ~20 units apart.
      if (inRect(w, game.gearRect())) { game.openSettings(); return; }
      game.tapAt(w.x, w.y);
    }
  }
  function hitBtn(w, y) {
    return w.x > VIEW_MIN_W / 2 - 110 && w.x < VIEW_MIN_W / 2 + 110 && w.y > y && w.y < y + 56;
  }

  // Production exposes lifecycle pause only; it never exports the game object.
  // THE LIFECYCLE SURFACE — the ONLY part of window.__game a release build keeps.
  //
  // `pauseIfPlaying` exists because the Android back button asks a question the
  // release build could not answer. MainActivity used to eval
  // the `.game` handle's `state`, and that handle is exactly what the
  // release strip REMOVES — so on a store build the check read undefined, fell
  // through to 'exit', and back QUIT the app mid-run instead of pausing it. The
  // debug build worked, which is what would have kept it hidden.
  //
  // It answers with a string rather than exposing state, so it grants a store
  // build no reading or writing of the game beyond the pause it already had.
  window.__game = { pause: function (v) { game.setPaused(v); } };
  window.__game.pauseIfPlaying = function () {
    if (game.state !== 'playing') return 'exit';
    game.setPaused(true);
    return 'paused';
  };


})();
