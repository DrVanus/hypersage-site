/* Hoardkeep — single-file canvas tower-defense engine.
 * Defend the sleeping Elder Dragon's gold hoard from waves of "hero" raiders.
 * Raiders that reach the hoard STEAL treasure and flee; kill them to recover it.
 * The hoard is the life bar. Scaffolded by new-game-scaffold — READ HANDOFF.md:
 * the RNG firewall (§3a) and the fixed-timestep loop (§3b) are load-bearing.
 *
 * Layout (top-down, so greps land):
 *   CFG / WORLD constants -> RNG FIREWALL (3 lanes) -> GAME DATA (towers,
 *   enemies, waves, map) -> PATH (pure) -> daily wave gen (pure) -> node export
 *   -> [DOM guard] -> Sfx -> Art registry -> Input -> Game (loop) -> boot + dev
 */
(function () {
  'use strict';

  // ===== CFG / WORLD =======================================================
  var CFG = {
    stepHz: 60,          // fixed physics substep rate. NOT the frame rate.
    sellRefund: 0.7,
    fleeBase: 1.5,       // thieves run home faster than they marched...
    fleeWeight: 0.05,    // ...but slow by this per coin carried (loot-weight rule)
    fleeMin: 0.9,        // floor on the flee multiplier
    grabTime: 0.5,       // grab animation at the hoard before turning to flee
    // --- Wick: vulnerability and THE TOLL --------------------------------
    heroHp: 100,
    heroContact: 24,     // a raider this close is in melee with him
    heroDpsTaken: 5,     // per adjacent raider, per second (boss hits far harder)
    heroRegen: 9,        // per second, once nothing has been near him for a beat
    heroSafeAfter: 2.0,  // seconds clear of raiders before he starts recovering
    heroDownTime: 9,     // seconds out of the fight after he drops
    tollRange: 34,       // body-block reach. 26 was narrower than Wick's own
                         // sprite (44 wide) and the toll never once fired in
                         // bot play — a mechanic that cannot be reached is not
                         // a mechanic. Still demands real contact.
    tollEvery: 0.30,     // seconds between coins shaken loose
    startGold: 120,
    startHoard: 60,      // treasure coins = the life bar
    breathAt: 15,        // hoard level that wakes Mother's Breath (once per level)
    // 12s of dead air between waves is most of why the game "goes slow and
    // nothing is happening" (VANUS). 7s still leaves room to spend and
    // reposition, and the early-call bonus is unchanged — it just pays less
    // per wave, which is the correct direction: the reward for playing fast
    // should be tempo, not a fatter purse.
    waveCountdown: 7,    // seconds between waves; calling early pays the remainder
  };
  var WORLD_W = 420, WORLD_H = 780;   // fixed world; whole map on one screen
  var VIEW_MIN_W = 420;               // portrait collapses view.w to this (§3d)
  var VIEW_H = WORLD_H;

  // ===== RNG FIREWALL (§3a) — THREE LANES ==================================
  // Keep them separate or a shared seed forks silently, for only some players.
  //
  //  LANE 1  noise*()      POSITIONAL hash. Stateless, order-independent,
  //                        random-access, integer-exact on every device. THE
  //                        gameplay lane: daily wave W is identical no matter
  //                        how you got there. Safe to read on the render path.
  //  LANE 2  rng*()        seeded mulberry32 STREAM. Sequential. ONLY for a
  //                        bounded, order-fixed set of per-run rolls (drawn at
  //                        reset, never per frame).
  //  LANE 3  Math.random   COSMETIC lane (particles, shake, flavour). Never
  //                        touches sim state. Two players SHOULD differ here.
  //
  // The audit question is never "is this random?" It is: could two players
  // reach this line a DIFFERENT NUMBER OF TIMES, or in a different frame
  // order? If yes it must not touch lane 1 or lane 2.

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
  function vnoise(x, seed) {
    var i = Math.floor(x), f = x - i;
    var a = noise01(i, seed), b = noise01(i + 1, seed);
    var t = f * f * (3 - 2 * f);
    return a + (b - a) * t;
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
  function rngChance(p) { return streamFloat() < p; }
  function rngPick(arr) { return arr[Math.floor(streamFloat() * arr.length)]; }

  // Daily seed: same integer for everyone on the same UTC day.
  function dayNumber() { return Math.floor(Date.now() / 86400000); }
  function dailySeed() { return ((dayNumber() + 1) * 2654435761) >>> 0 || 1; }

  // ===== GAME DATA =========================================================
  // Balance tables are DATA on purpose: economy-and-curve-harness reads them,
  // and the design-studio numbers merge here without touching systems code.
  // Numbers merged from the design-studio balance pass (design/studio-output.json):
  // 1 path tile = 42 world units; ranges/speeds below are that table in world units.
  // L3 is a FORK: upgrading a level-2 machine commits to one of two workshop
  // mods (same price, different identity). forks[0] descends from the old L3
  // special so veterans keep what they know; forks[1] is the new answer.
  // Every special is DETERMINISTIC — counters and flags, no rolls at all.
  var TOWER_TYPES = {
    mimic: {
      name: 'Latch Mimic', cost: 80, hitsAir: false,
      aims: true,
      // RANGE 40 MADE THIS MACHINE UNBUILDABLE, not merely weak. Measured pad
      // distance to the road centreline: level 1 has 2 of 8 pads inside 40,
      // level 2 has 1 of 9, and LEVEL 3 HAS ZERO OF EIGHT at every tier —
      // its nearest pad is 49.4 out and both L3 forks only reached 44/48.
      // So the third machine a new player can buy costs more than the Crossbow
      // (which reaches the road from every pad on every level) and, on the last
      // map, could not hit anything at all from anywhere it was allowed to sit.
      // It stays the SHORT-range brawler — it just has to be able to reach.
      levels: [
        // ...and range was only half the problem. Measured against the Kobold
        // Crossbow it was dominated on EVERY axis: cost 80 vs 70, dps 8.0 vs
        // 14.4 then 15.4 vs 28.0, range 72 vs 105. Nothing it did was better,
        // so there was never a reason to buy it. It now WINS on damage — a real
        // trade of reach for punch, which is what a short-range brawler is for.
        { dmg: 18, rate: 1.0, range: 72, upgradeCost: 70 },
        { dmg: 32, rate: 1.1, range: 80, upgradeCost: 120 },
      ],
      forks: [
        { key: 'rend', name: 'Gearjaw', pitch: 'Grinding gears rend 4/s — armor can\'t shave it.',
          dmg: 44, rate: 1.2, range: 84, special: 'rend', rendDps: 4, rendDur: 2.5 },
        { key: 'coinback', name: 'Magnet Jaws', pitch: 'Bites shake stolen coins loose — they fly home.',
          // The forks were tuned against the OLD level-2 damage of 14. Raising
          // L2 to 32 without them made the L3 upgrade a DOWNGRADE (22 and 16),
          // which is also why the first bot run showed no change at all: it
          // upgrades on sight, so both runs were really measuring the forks.
          dmg: 34, rate: 1.5, range: 88, special: 'coinback', coinCap: 2 },
      ],
    },
    ballista: {
      name: 'Kobold Crossbow', cost: 70, hitsAir: true,
      aims: true,
      levels: [
        { dmg: 12, rate: 1.2, range: 105, upgradeCost: 60 },
        { dmg: 20, rate: 1.4, range: 118, upgradeCost: 110 },
      ],
      forks: [
        { key: 'overwind', name: 'Overwinder', pitch: 'Every 5th bolt overwinds for double damage.',
          dmg: 34, rate: 1.6, range: 130, special: 'overwind', overwindEvery: 5, overwindMul: 2 },
        { key: 'lockramp', name: 'Windlass Rig', pitch: 'Locks on: each hit on one target adds +5.',
          dmg: 26, rate: 1.6, range: 130, special: 'lockramp', rampAdd: 5, rampMax: 40 },
      ],
    },
    brazier: {
      name: 'Soot Brazier', cost: 100, hitsAir: false,
      levels: [
        { dmg: 9,  rate: 0.8, range: 92,  splash: 38, upgradeCost: 90 },
        { dmg: 15, rate: 0.9, range: 101, splash: 38, upgradeCost: 160, burn: 4 },
      ],
      forks: [
        { key: 'scald', name: 'Whistlepot', pitch: 'Scalding burn — burning raiders can\'t be healed.',
          dmg: 24, rate: 1.0, range: 109, splash: 50, burn: 9, special: 'scald', scaldDur: 3 },
        { key: 'tarpatch', name: 'Tar Boiler', pitch: 'Slag patches burn both trips: in, and back out.',
          dmg: 16, rate: 1.0, range: 109, splash: 38, burn: 4, special: 'tarpatch',
          tarDps: 8, tarDur: 4, tarWidth: 30, maxPatches: 3 },
      ],
    },
    crystal: {
      name: 'Gemsinger', cost: 50, hitsAir: true,
      levels: [
        { dmg: 3, rate: 1.0, range: 92,  slow: 0.30, slowDur: 1.5, upgradeCost: 50 },
        { dmg: 5, rate: 1.1, range: 105, slow: 0.40, slowDur: 2.0, upgradeCost: 90 },
      ],
      forks: [
        { key: 'deepchill', name: 'Deepchill Coil', pitch: 'Deep chill: no blinking, deaf to the war drum.',
          dmg: 8, rate: 1.2, range: 118, slow: 0.55, slowDur: 2.5, special: 'deepchill' },
        { key: 'resonance', name: 'Tuning Fork', pitch: 'Chilled foes ring brittle — all hits do +25%.',
          dmg: 6, rate: 1.2, range: 118, slow: 0.40, slowDur: 2.0, special: 'resonance', brittleMul: 1.25 },
      ],
    },
    perch: {
      name: 'Gargoyle Roost', cost: 90, hitsAir: true, airBonus: 1.5,
      aims: true,
      levels: [
        { dmg: 18, rate: 0.6, range: 134, pierce: 2, upgradeCost: 80 },
        { dmg: 30, rate: 0.7, range: 147, pierce: 3, upgradeCost: 140 },
      ],
      forks: [
        { key: 'shieldbreak', name: 'Drillbolt', pitch: 'Drill-tip bolts bore through pavise and ranks.',
          dmg: 48, rate: 0.8, range: 160, pierce: 6, special: 'shieldbreak', airBonus3: 1.5 },
        { key: 'downdraft', name: 'Netcaster', pitch: 'Netted flyers crash low — ground towers can bite.',
          dmg: 38, rate: 0.9, range: 160, pierce: 4, special: 'downdraft', groundDur: 3, airBonus3: 2 },
      ],
    },
    // SUPPORT — buffs its neighbours, never fires. Free placement made
    // clustering possible; this is the first reason to actually want it.
    bellows: {
      name: 'Bellows Post', cost: 120, hitsAir: false, support: true,
      // Wick at the crank drives the bellows harder. A support machine used to
      // offer MAN IT (+70%) and deliver NOTHING — the tower loop bails on
      // supports before any manning flag is read. This is the effect that
      // button was always promising.
      mannedAura: 1.6,
      levels: [
        { rate: 0, range: 96,  auraRate: 0.15, upgradeCost: 90 },
        { rate: 0, range: 110, auraRate: 0.22, upgradeCost: 150 },
      ],
      forks: [
        { key: 'gale', name: 'Gale Bellows', pitch: 'A wider draught: +32% fire rate to neighbours.',
          rate: 0, range: 132, auraRate: 0.32, special: 'gale' },
        { key: 'temper', name: 'Tempering Post', pitch: 'Tempers their strikes: +28% damage instead.',
          rate: 0, range: 118, auraRate: 0, auraDmg: 0.28, special: 'temper' },
      ],
    },
    // ECONOMY — the Banana-Farm role from the game VANUS likes. Pays at the
    // END of a wave, so it is a bet on surviving long enough to collect.
    press: {
      name: 'Coin Press', cost: 140, hitsAir: false, support: true,
      mannedGold: 1.5,   // see Bellows Post: MAN IT on a press paid nothing at all
      levels: [
        { rate: 0, range: 0, waveGold: 26, upgradeCost: 110 },
        { rate: 0, range: 0, waveGold: 44, upgradeCost: 170 },
      ],
      forks: [
        { key: 'mint', name: 'Royal Mint', pitch: 'Stamps 78 gold at the end of every wave.',
          rate: 0, range: 0, waveGold: 78, special: 'mint' },
        { key: 'tithe', name: 'Tithe Press', pitch: 'Pays 62 a wave, plus 2 gold per raider slain.',
          rate: 0, range: 0, waveGold: 62, killGold: 2, special: 'tithe' },
      ],
    },
  };
  // ===== DEPTH KIT — the renderer's half of the 3D read ====================
  // The art is pre-rendered 3D (the same technique Clash of Clans ships), but
  // the ENGINE was not finishing the job: shadows were drawn narrower than the
  // sprites that covered them (so nothing ever touched the ground), sprite
  // size was constant across a 530-unit depth range on a background painted
  // with real floor perspective, and the six torches each map declares lit
  // nothing at all. These four helpers fix that. All render-lane, no sim state.
  var LIGHT_DX = 0.55, LIGHT_DY = 0.34;      // key light from upper-left, one law for everything
  function depth01(y) { return clamp((y - 150) / (WORLD_H - 180), 0, 1); }
  // nearer the camera (down-screen) = bigger. Matches the painted floor.
  function depthScale(y) { return 0.90 + 0.22 * depth01(y); }
  // A body sits on the ground when it has BOTH a tight dark contact patch and
  // a soft cast shadow thrown along the light. One ellipse can't do both.
  function groundShadow(ctx, x, y, w, lift, strength) {
    var s = strength === undefined ? 1 : strength;
    var rise = 1 + (lift || 0) / 46;                     // airborne = bigger, fainter, further
    ctx.fillStyle = 'rgba(6,4,3,' + (0.34 * s / rise) + ')';
    ctx.beginPath();
    ctx.ellipse(x + LIGHT_DX * w * 0.30 * rise, y + 2 + LIGHT_DY * w * 0.12 * rise,
                w * 0.56 * rise, w * 0.23 * rise, 0, 0, 6.283);
    ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,' + (0.42 * s / (rise * rise)) + ')';   // contact AO
    ctx.beginPath();
    ctx.ellipse(x, y + 2, w * 0.31, w * 0.12, 0, 0, 6.283);
    ctx.fill();
  }
  // Torchlight that actually touches a body: warm additive keyed to the
  // nearest declared light. The maps have always carried these six positions.
  function torchWarm(x, y) {
    var t = MAP.torches, best = 0;
    for (var i = 0; i < t.length; i++) {
      var dx = x - t[i][0], dy = y - t[i][1];
      var d2 = dx * dx + dy * dy;
      var f = 1 - Math.min(1, d2 / (132 * 132));
      if (f > best) best = f;
    }
    return best * best;                       // falls off fast: pools, not a wash
  }

  // The row a tower actually runs on: its level row, or its chosen fork at L3.
  function lvlRow(tw) {
    var tt = TOWER_TYPES[tw.type];
    return tw.level >= 2 ? tt.forks[tw.fork | 0] : tt.levels[tw.level];
  }
  // A netted flyer fights as ground troops until the net wears off.
  function eFly(e) { return e.flyer && !(e.groundedT > 0); }
  var TOWER_ORDER = ['crystal', 'ballista', 'mimic', 'perch', 'brazier', 'bellows', 'press']; // cheap -> dear

  // MACHINE UNLOCKS — campaign stars needed before a machine appears on the
  // shelf. Every one of the seven used to be affordable on wave 0 of level 1
  // (the dearest costs 112 on a pad against 120 starting gold), so the game
  // handed over its entire vocabulary in the first minute and had no new toy
  // to give for the remaining fifty-nine waves. A drip is the progression.
  //
  // KEYED ON STARS, NOT ON LEVEL, so the Forge and the campaign share one
  // currency and a player who three-stars level 1 is rewarded with a machine
  // rather than only with Forge points.
  var MACHINE_UNLOCK = { crystal: 0, ballista: 0, mimic: 0, perch: 1, brazier: 2, bellows: 4, press: 6 };

  /// The Daily ALWAYS offers all seven.
  ///
  /// This is the load-bearing half. The Daily is the one fight every player
  /// shares — same seed, same layout, one leaderboard — so if the shelf were
  /// gated by campaign progress there, two players would be running different
  /// games against the same scoreboard, and a veteran's board would simply be
  /// wider than a newcomer's. Progression gates the CAMPAIGN; the shared fight
  /// stays identical for everyone.
  function towerUnlocked(id, mode) {
    // The DUEL is a shared fight for the same reason the Daily is, so it takes
    // the same answer: both sides get all seven. The rival's curve was baked
    // with the full shelf, so gating the player's would hand them a narrower
    // game than the opponent they are being scored against.
    if (mode === 'daily' || mode === 'duel') return true;
    return Save.starsTotal() >= (MACHINE_UNLOCK[id] || 0);
  }
  // How long a killed raider keeps rendering as a white-hot husk. ~7 frames:
  // long enough to read as a hit landing, short enough that a wave of kills
  // does not leave a queue of corpses standing on the road.
  var HUSK_T = 0.12;
  var PAD_SNAP = 34;          // build within this of a free pad and you snap to it
  var PAD_DISCOUNT = 0.8;     // ...and it costs 20% less: the authored spots still matter
  // FREE PLACEMENT DELETED THE OLD CAP. With 8 pads you could own 8 machines;
  // with the whole floor a bot built 32 and 3-starred every level losing 0-2
  // coins. Rather than cap the count (which takes the freedom away) or stiffen
  // the waves (which punishes every playstyle), each machine you already own
  // makes the NEXT one dearer. Placement stays free; hoarding is what costs.
  // The two campaign difficulty levers, in one place so tools/bot.js can sweep
  // them without a reload. Mutating TUNE is dev-only (see the debug surface);
  // shipped play always uses the numbers written here.
  var TUNE = {
    // Crowding tax: each machine owned made the NEXT one dearer. It was added
    // to stop a bot that built 32 machines and 3-starred everything — but the
    // strategy it taxes LOSES on merit once measured (spam 1-stars level 1;
    // upgrading 3-stars every level with 6 machines), so it was punishing the
    // weaker playstyle and doing it invisibly: prices climbed 56, 62, 67, 73...
    // with nothing on screen to explain why. Off.
    crowdStep: 0,
    crowdMax: 2.3,
    // Campaign HP ramp, PER LEVEL. The campaign had NO failure mode — 45 of 45
    // bot runs across 3 levels x 3 strategies x 5 seeds won, including a
    // deliberately stupid never-upgrade policy. Raiders in the back half of a
    // level now toughen, so a run has somewhere to go wrong.
    //
    // Per level, not global, because the two requirements pull apart: any
    // single ramp steep enough to punish never-upgrading (>=0.22, measured)
    // also makes LEVEL ONE unwinnable for a beginner doing exactly what a
    // beginner does. The first keep stays forgiving and teaches; the Coldroot
    // Stair is where the same mistake costs the hoard.
    campRampByLevel: [0.10, 0.20, 0.32],
    campRampFrom: 8,
  };
  function crowdMul(n) { return Math.min(TUNE.crowdMax, 1 + TUNE.crowdStep * n); }
  /** Campaign-only HP multiplier for wave w on level `li`. The Daily has its
   *  own curve (dailyHpMul) and must never be touched from here — it is the
   *  one fight every player shares. */
  function campHpMul(w, li) {
    var r = TUNE.campRampByLevel[li | 0];
    if (r === undefined) r = TUNE.campRampByLevel[TUNE.campRampByLevel.length - 1];
    return 1 + r * Math.max(0, w - TUNE.campRampFrom);
  }

  var ENEMY_TYPES = {
    looter:   { name: 'Scrapling',     hp: 30,   spd: 42, bounty: 4,   steals: 1,  flyer: false },
    scout:    { name: 'Filcher',       hp: 22,   spd: 76, bounty: 6,   steals: 3,  flyer: false },
    brute:    { name: 'Bulwark',       hp: 220,  spd: 25, bounty: 18,  steals: 5,  flyer: false, armor: 5 },
    shield:   { name: 'Shellback',     hp: 90,   spd: 38, bounty: 12,  steals: 2,  flyer: false, pavise: true }, // halves bolt damage
    bat:      { name: 'Gloomwing',     hp: 45,   spd: 59, bounty: 10,  steals: 2,  flyer: true  },
    warlock:  { name: 'Greed Hexer',   hp: 80,   spd: 34, bounty: 16,  steals: 2,  flyer: false, heals: 10, healR: 63 },
    blinker:  { name: 'Blinker',       hp: 60,   spd: 46, bounty: 14,  steals: 3,  flyer: false, blink: 84, blinkEvery: 4 },
    boss:     { name: 'The Hoard King', hp: 3000, spd: 19, bounty: 150, steals: 25, flyer: false, auraR: 84, auraSpd: 1.2, summonAtHalf: 6 },
    // SAPPER — the first raider that threatens the MACHINES. Until now every
    // tower was untouchable, so a built board was a solved board; a raider who
    // can silence your best gun forces you to defend the defences.
    sapper:   { name: 'Pry-Hand',      hp: 70,   spd: 44, bounty: 15,  steals: 2,  flyer: false,
                // 76 measured against the real geometry: pads and free-build
                // spots sit 35-308 units off the road, so this reaches the
                // road-hugging band (wide coverage, now vulnerable) and leaves
                // machines set further back safe. That IS the trade-off.
                sapR: 76, sapEvery: 3.2, sapStun: 2.6 },
    // SPLITTER — dies into two Scraplings. Punishes single-target builds and
    // rewards splash, which is the Bloons lesson VANUS liked: one kill can
    // make your problem WORSE if you brought the wrong tool.
    splitter: { name: 'Cracked Keg',   hp: 130,  spd: 33, bounty: 14,  steals: 3,  flyer: false,
                splitInto: 'looter', splitCount: 2, splitHp: 0.55 },
  };

  // Campaign level 1 — the design-studio 20-wave table, with its deliberate
  // economy gates (W7 pays for the Roost before the first flyers in W8; W9
  // funds the first L3 before the W10 spike). Each wave = groups of
  // { type, count, gap (s between spawns), delay (s after wave start) }.
  var LEVEL1_WAVES = [
    [{ type: 'looter', count: 12, gap: 1.5, delay: 0 }],
    [{ type: 'looter', count: 16, gap: 1.0, delay: 0 }],
    [{ type: 'looter', count: 10, gap: 1.2, delay: 0 }, { type: 'scout', count: 4, gap: 0.8, delay: 13 }],
    [{ type: 'looter', count: 18, gap: 0.9, delay: 0 }, { type: 'scout', count: 6, gap: 3.0, delay: 1.5 }],
    [{ type: 'brute',  count: 2,  gap: 8.0, delay: 0 }, { type: 'looter', count: 12, gap: 1.0, delay: 1 }],
    [{ type: 'scout',  count: 4,  gap: 0.6, delay: 0 }, { type: 'scout', count: 4, gap: 0.6, delay: 7.4 }, { type: 'looter', count: 8, gap: 1.2, delay: 3 }],
    [{ type: 'shield', count: 4,  gap: 2.5, delay: 0 }, { type: 'looter', count: 12, gap: 1.0, delay: 1 }],
    [{ type: 'bat',    count: 6,  gap: 1.5, delay: 0 }, { type: 'looter', count: 10, gap: 1.0, delay: 1 }],
    [{ type: 'looter', count: 20, gap: 0.5, delay: 0 }, { type: 'scout', count: 8, gap: 1.0, delay: 2 }],
    [{ type: 'brute',  count: 4,  gap: 4.0, delay: 0 }, { type: 'warlock', count: 2, gap: 8.0, delay: 5 }, { type: 'looter', count: 12, gap: 1.0, delay: 2 }],
    [{ type: 'bat',    count: 8,  gap: 1.2, delay: 0 }, { type: 'scout', count: 8, gap: 0.8, delay: 0 }],
    [{ type: 'shield', count: 6,  gap: 2.0, delay: 0 }, { type: 'warlock', count: 2, gap: 5.0, delay: 3 }, { type: 'looter', count: 10, gap: 1.0, delay: 2 }],
    [{ type: 'blinker', count: 6, gap: 2.0, delay: 0 }, { type: 'looter', count: 12, gap: 0.8, delay: 1 }],
    [{ type: 'brute',  count: 6,  gap: 2.5, delay: 0 }, { type: 'shield', count: 4, gap: 2.0, delay: 2 }],
    [{ type: 'scout',  count: 12, gap: 0.5, delay: 0 }, { type: 'blinker', count: 6, gap: 2.0, delay: 2 }],
    [{ type: 'bat',    count: 10, gap: 1.0, delay: 0 }, { type: 'warlock', count: 3, gap: 3.5, delay: 1 }],
    [{ type: 'looter', count: 30, gap: 0.35, delay: 0 }, { type: 'scout', count: 10, gap: 0.7, delay: 2 }],
    [{ type: 'brute',  count: 6,  gap: 2.5, delay: 0 }, { type: 'shield', count: 4, gap: 2.0, delay: 2 }, { type: 'warlock', count: 2, gap: 5.0, delay: 4 }],
    [{ type: 'shield', count: 6,  gap: 4.0, delay: 0 }, { type: 'bat', count: 6, gap: 4.0, delay: 1 }, { type: 'blinker', count: 6, gap: 4.0, delay: 2 }, { type: 'scout', count: 6, gap: 4.0, delay: 3 }],
    [{ type: 'boss',   count: 1,  gap: 1.0, delay: 0 }, { type: 'looter', count: 12, gap: 1.5, delay: 2 }, { type: 'warlock', count: 4, gap: 6.0, delay: 5 }],
  ];

  // Level 2 — everything arrives sooner, flyers ride the long gallery, and
  // filcher packs test the double-pass coverage.
  var LEVEL2_WAVES = [
    [{ type: 'looter', count: 12, gap: 1.2, delay: 0 }],
    [{ type: 'looter', count: 12, gap: 0.9, delay: 0 }, { type: 'scout', count: 3, gap: 1.2, delay: 8 }],
    [{ type: 'scout',  count: 6,  gap: 0.8, delay: 0 }, { type: 'looter', count: 10, gap: 1.0, delay: 2 }],
    [{ type: 'bat',    count: 5,  gap: 1.6, delay: 0 }, { type: 'looter', count: 10, gap: 0.9, delay: 1 }],
    [{ type: 'brute',  count: 2,  gap: 7.0, delay: 0 }, { type: 'scout', count: 8, gap: 0.8, delay: 2 }],
    [{ type: 'shield', count: 4,  gap: 2.2, delay: 0 }, { type: 'bat', count: 4, gap: 1.5, delay: 3 }],
    [{ type: 'looter', count: 18, gap: 0.6, delay: 0 }, { type: 'scout', count: 6, gap: 1.0, delay: 3 }],
    [{ type: 'blinker', count: 4, gap: 2.2, delay: 0 }, { type: 'looter', count: 10, gap: 0.9, delay: 1 }, { type: 'sapper', count: 1, gap: 1, delay: 8 }],
    [{ type: 'bat',    count: 8,  gap: 1.1, delay: 0 }, { type: 'shield', count: 4, gap: 2.0, delay: 2 }],
    [{ type: 'brute',  count: 4,  gap: 3.5, delay: 0 }, { type: 'warlock', count: 2, gap: 7.0, delay: 3 }, { type: 'scout', count: 8, gap: 0.8, delay: 6 }],
    [{ type: 'scout',  count: 14, gap: 0.5, delay: 0 }, { type: 'bat', count: 6, gap: 1.2, delay: 4 }],
    [{ type: 'shield', count: 6,  gap: 1.8, delay: 0 }, { type: 'blinker', count: 4, gap: 2.0, delay: 3 }, { type: 'sapper', count: 2, gap: 4, delay: 6 }],
    [{ type: 'brute',  count: 5,  gap: 2.6, delay: 0 }, { type: 'bat', count: 6, gap: 1.2, delay: 4 }, { type: 'warlock', count: 1, gap: 1, delay: 8 }],
    [{ type: 'looter', count: 24, gap: 0.45, delay: 0 }, { type: 'scout', count: 8, gap: 0.8, delay: 3 }],
    [{ type: 'blinker', count: 6, gap: 1.6, delay: 0 }, { type: 'shield', count: 6, gap: 1.6, delay: 2 }, { type: 'warlock', count: 2, gap: 5.0, delay: 6 }],
    [{ type: 'bat',    count: 12, gap: 0.8, delay: 0 }, { type: 'brute', count: 3, gap: 3.0, delay: 4 }],
    [{ type: 'boss',   count: 1,  gap: 1.0, delay: 0, hpMul: 0.45 }, { type: 'scout', count: 10, gap: 0.8, delay: 3 }],
    [{ type: 'brute',  count: 7,  gap: 2.0, delay: 0 }, { type: 'warlock', count: 3, gap: 4.0, delay: 3 }],
    [{ type: 'shield', count: 8,  gap: 1.3, delay: 0 }, { type: 'bat', count: 8, gap: 1.0, delay: 3 }, { type: 'blinker', count: 5, gap: 1.8, delay: 6 }],
    [{ type: 'boss',   count: 1,  gap: 1.0, delay: 0 }, { type: 'shield', count: 8, gap: 1.6, delay: 3 }, { type: 'warlock', count: 3, gap: 5.0, delay: 8 }],
  ];

  // Level 3 — the switchback wall: centre pads see three lanes, so the waves
  // bring armor, healers and a double-boss finale to answer it.
  var LEVEL3_WAVES = [
    [{ type: 'looter', count: 14, gap: 1.0, delay: 0 }],
    [{ type: 'scout',  count: 8,  gap: 0.8, delay: 0 }, { type: 'looter', count: 8, gap: 0.9, delay: 2 }],
    [{ type: 'shield', count: 3,  gap: 2.5, delay: 0 }, { type: 'looter', count: 12, gap: 0.8, delay: 1 }],
    [{ type: 'bat',    count: 6,  gap: 1.3, delay: 0 }, { type: 'scout', count: 6, gap: 0.9, delay: 2 }],
    [{ type: 'brute',  count: 3,  gap: 5.0, delay: 0 }, { type: 'looter', count: 12, gap: 0.8, delay: 1 }],
    [{ type: 'blinker', count: 5, gap: 1.8, delay: 0 }, { type: 'shield', count: 4, gap: 2.0, delay: 2 }, { type: 'splitter', count: 3, gap: 3.5, delay: 5 }],
    [{ type: 'warlock', count: 2, gap: 6.0, delay: 0 }, { type: 'brute', count: 3, gap: 3.5, delay: 1 }, { type: 'looter', count: 10, gap: 0.8, delay: 4 }],
    [{ type: 'bat',    count: 10, gap: 0.9, delay: 0 }, { type: 'scout', count: 8, gap: 0.8, delay: 3 }],
    [{ type: 'looter', count: 30, gap: 0.35, delay: 0 }, { type: 'blinker', count: 5, gap: 1.6, delay: 4 }, { type: 'splitter', count: 2, gap: 5, delay: 2 }],
    [{ type: 'boss',   count: 1,  gap: 1.0, delay: 0, hpMul: 0.45 }, { type: 'warlock', count: 3, gap: 4.0, delay: 2 }],
    [{ type: 'shield', count: 8,  gap: 1.3, delay: 0 }, { type: 'bat', count: 9, gap: 1.0, delay: 3 }],
    [{ type: 'brute',  count: 7,  gap: 2.0, delay: 0 }, { type: 'warlock', count: 3, gap: 4.0, delay: 4 }],
    [{ type: 'scout',  count: 20, gap: 0.4, delay: 0 }, { type: 'blinker', count: 7, gap: 1.3, delay: 3 }],
    [{ type: 'shield', count: 8,  gap: 1.4, delay: 0 }, { type: 'brute', count: 5, gap: 2.4, delay: 2 }, { type: 'warlock', count: 3, gap: 4.0, delay: 6 }],
    [{ type: 'bat',    count: 16, gap: 0.65, delay: 0 }, { type: 'scout', count: 10, gap: 0.7, delay: 4 }],
    [{ type: 'blinker', count: 9, gap: 1.2, delay: 0 }, { type: 'warlock', count: 3, gap: 4.0, delay: 3 }, { type: 'looter', count: 16, gap: 0.5, delay: 6 }],
    [{ type: 'brute',  count: 9,  gap: 1.6, delay: 0 }, { type: 'shield', count: 8, gap: 1.4, delay: 4 }],
    [{ type: 'boss',   count: 1,  gap: 1.0, delay: 0, hpMul: 0.55 }, { type: 'bat', count: 10, gap: 0.9, delay: 3 }, { type: 'blinker', count: 6, gap: 1.5, delay: 7 }],
    [{ type: 'looter', count: 34, gap: 0.32, delay: 0 }, { type: 'scout', count: 14, gap: 0.55, delay: 3 }, { type: 'warlock', count: 3, gap: 4.0, delay: 8 }],
    [{ type: 'boss',   count: 2,  gap: 24.0, delay: 0, hpMul: 0.85 }, { type: 'shield', count: 10, gap: 1.3, delay: 4 }, { type: 'warlock', count: 5, gap: 4.5, delay: 10 }],
  ];

  var WAVE_TABLES = [LEVEL1_WAVES, LEVEL2_WAVES, LEVEL3_WAVES];

  // The maps — hand-authored to echo the reference fantasy: a torch-lit
  // cavern, the keep on a mountain of gold at the top, raiders entering from a
  // cave mouth and winding up through chokepoints. Three campaign levels with
  // distinct path geometry; the keep/mound sit fixed so the fantasy reads the
  // same on every map.
  var MAPS = [
    { // Level 1 — "The Long Sleep": the gentle S-curve
      name: 'The Long Sleep',
      keep: { x: 175, y: 200 },
      mound: { x: 180, y: 248, rx: 118, ry: 46 },
      path: [
        [398, 748], [330, 722], [222, 702], [122, 668], [80, 612],
        [120, 560], [232, 540], [322, 506], [346, 452], [300, 402],
        [200, 386], [110, 360], [88, 302], [130, 262], [196, 238], [176, 232],
      ],
      // The first two pads used to sit at y 758 and 736 — UNDER the shop shelf
      // on a 375-wide phone, where the shop's hit test returns before the world
      // ever sees the tap. They were not merely hard to see, they could not be
      // built on at all. Lifted clear of the shelf (world y <= 688) onto ground
      // that passes _placeCheck and keeps >70u from every neighbour.
      pads: [
        { x: 328, y: 686 }, { x: 248, y: 672 }, { x: 56, y: 684 },
        { x: 192, y: 612 }, { x: 332, y: 574 }, { x: 252, y: 448 },
        { x: 58, y: 424 }, { x: 158, y: 312 },
      ],
      torches: [[86, 648], [336, 478], [92, 332], [244, 692], [306, 366], [46, 552]],
      heroStart: { x: 210, y: 470 },
      pathW: 34,
    },
    { // Level 2 — "The Undergallery": a long double-pass gallery mid-map;
      // pads inside the loop cover BOTH passes
      name: 'The Undergallery',
      keep: { x: 175, y: 200 },
      mound: { x: 180, y: 248, rx: 118, ry: 46 },
      path: [
        [28, 752], [140, 722], [300, 702], [368, 640], [330, 572],
        [180, 556], [72, 520], [58, 442], [150, 410], [300, 420],
        [362, 362], [300, 302], [190, 292], [122, 252], [176, 232],
      ],
      pads: [
        { x: 218, y: 646 }, { x: 78, y: 674 }, { x: 296, y: 664 },
        { x: 226, y: 486 }, { x: 138, y: 328 }, { x: 356, y: 262 },
        { x: 44, y: 348 }, { x: 288, y: 356 }, { x: 140, y: 630 },
      ],
      torches: [[40, 690], [368, 580], [40, 480], [330, 250], [230, 726], [368, 420]],
      heroStart: { x: 124, y: 636 },   // was (150,600): 18u from the road, inside the toll reach
      pathW: 34,
    },
    { // Level 3 — "The Coldroot Stair": five switchback rungs; centre pads
      // see three lanes at once, but the waves know it
      name: 'The Coldroot Stair',
      keep: { x: 175, y: 200 },
      mound: { x: 180, y: 248, rx: 118, ry: 46 },
      path: [
        [395, 762], [300, 734], [160, 734], [90, 682], [152, 632],
        [290, 636], [358, 586], [298, 532], [150, 536], [86, 482],
        [150, 432], [290, 436], [354, 386], [288, 332], [170, 332],
        [122, 282], [176, 232],
      ],
      pads: [
        { x: 224, y: 684 }, { x: 224, y: 584 }, { x: 222, y: 484 },
        { x: 222, y: 384 }, { x: 62, y: 584 }, { x: 372, y: 484 },
        { x: 62, y: 384 }, { x: 300, y: 282 },
      ],
      torches: [[46, 730], [380, 660], [46, 530], [380, 410], [60, 300], [250, 750]],
      heroStart: { x: 385, y: 675 },   // was (300,610): 2.8u from the road — standing ON it
      pathW: 32,
    },
  ];
  var MAP = MAPS[0];   // switched by setLevel(); every drawer/updater reads MAP

  // ===== PATH — pure geometry, built once ==================================
  // Catmull-Rom smooth through MAP.path, sampled to an arc-length table so
  // enemies address the path by DISTANCE (order-independent, replay-exact).
  function smoothPath(pts, subdiv) {
    var out = [];
    for (var i = 0; i < pts.length - 1; i++) {
      var p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
      for (var s = 0; s < subdiv; s++) {
        var t = s / subdiv, t2 = t * t, t3 = t2 * t;
        out.push([
          0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
          0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
        ]);
      }
    }
    out.push([pts[pts.length - 1][0], pts[pts.length - 1][1]]);
    return out;
  }
  function buildPathFrom(ctrl) {
    var pts = smoothPath(ctrl, 8);
    var cum = [0];
    for (var i = 1; i < pts.length; i++) {
      var dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1];
      cum.push(cum[i - 1] + Math.sqrt(dx * dx + dy * dy));
    }
    return { pts: pts, cum: cum, len: cum[cum.length - 1] };
  }
  var PATHS = [];
  for (var _m = 0; _m < MAPS.length; _m++) PATHS.push(buildPathFrom(MAPS[_m].path));
  var PATH = PATHS[0];
  // Level switch — called ONLY from reset() (deterministic; never mid-run)
  function setLevel(i) {
    i = Math.max(0, Math.min(MAPS.length - 1, i | 0));
    MAP = MAPS[i];
    PATH = PATHS[i];
    return i;
  }
  function buildPath() { return buildPathFrom(MAPS[0].path); }   // legacy export shape
  function pathPointAt(d) {
    if (d <= 0) { var a0 = PATH.pts[0]; return { x: a0[0], y: a0[1] }; }
    if (d >= PATH.len) { var aN = PATH.pts[PATH.pts.length - 1]; return { x: aN[0], y: aN[1] }; }
    var lo = 0, hi = PATH.cum.length - 1;
    while (lo + 1 < hi) { var mid = (lo + hi) >> 1; if (PATH.cum[mid] <= d) lo = mid; else hi = mid; }
    var t = (d - PATH.cum[lo]) / (PATH.cum[hi] - PATH.cum[lo] || 1);
    var a = PATH.pts[lo], b = PATH.pts[hi];
    return { x: a[0] + (b[0] - a[0]) * t, y: a[1] + (b[1] - a[1]) * t };
  }

  // ===== DAILY SIEGE wave gen — LANE 1, pure fn of (waveIdx, seed) =========
  // Every draw is keyed positionally on (waveIdx, slot) so wave 7 is the same
  // for every player regardless of how or when they got there.
  var DAILY_ROSTER = ['looter', 'scout', 'brute', 'shield', 'bat', 'warlock', 'blinker', 'sapper', 'splitter'];
  function dailyWaveComp(w, seed) {
    var groups = [];
    if ((w + 1) % 10 === 0) {
      groups.push({ type: 'boss', count: 1 + Math.floor(w / 20), gap: 3.0, delay: 0 });
    }
    var n = 2 + Math.floor(w / 5);
    for (var s = 0; s < n; s++) {
      var k = w * 64 + s * 7;                       // positional key, never a counter
      var tier = Math.min(DAILY_ROSTER.length, 2 + Math.floor(w / 3));
      var ti = Math.floor(noise01(k + 1, (seed ^ 0xDA11) >>> 0) * tier);
      var type = DAILY_ROSTER[ti];
      var base = ENEMY_TYPES[type].hp > 100 ? 2 : 5;
      var count = base + Math.floor(noise01(k + 2, (seed ^ 0xC0DE) >>> 0) * (2 + w * 0.30));
      groups.push({
        type: type,
        count: count,
        gap: 0.55 + noise01(k + 3, (seed ^ 0x9A9) >>> 0) * 0.9,
        delay: s * (2.5 + noise01(k + 4, (seed ^ 0x51DE) >>> 0) * 3),
      });
    }
    return groups;
  }
  // Daily HP scaling — pure fn of wave index; endless past 20. Built from
  // IEEE-exact multiplies (correctly rounded, bit-identical on every engine);
  // Math.pow is NOT cross-engine exact and could fork a daily.
  function dailyHpMul(w) {
    var m = 1;
    for (var i = 0; i < w; i++) m *= 1.08;   // swept 2026-08-13: 1.16 killed a FULL kill-box by w8; 1.10 by w11
    return m;
  }

  // Node/test export of the PURE surface (determinism prover requires this).
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      squirrel3: squirrel3, noise01: noise01, noise2: noise2, vnoise: vnoise,
      seedStream: seedStream, streamFloat: streamFloat, rngInt: rngInt,
      dayNumber: dayNumber, dailySeed: dailySeed,
      dailyWaveComp: dailyWaveComp, dailyHpMul: dailyHpMul,
      buildPath: buildPath, buildPathFrom: buildPathFrom, pathPointAt: pathPointAt,
      PATH_LEN: PATH.len, setLevel: setLevel,
      TOWER_TYPES: TOWER_TYPES, ENEMY_TYPES: ENEMY_TYPES, LEVEL1_WAVES: LEVEL1_WAVES,
      WAVE_TABLES: WAVE_TABLES, MAPS: MAPS, MAP: MAP, CFG: CFG,
    };
  }

  // Everything below needs a DOM. Under node (tests) we stop here.
  if (typeof window === 'undefined' || !window.document) return;

  // ===== ZzFX SFX + ambience (lane 3; zero audio files) ===================
  // zzfxG adapted from LittleJS engineAudio.js (MIT, Frank Force) — GENERATE
  // samples only; playback routes through OUR buses so mute, volume, and
  // visibility-suspend apply, and a native shell's AVAudioSession .ambient
  // governs everything (see the audio-and-sfx skill).
  var ZZFX_RATE = 44100;
  function zzfxG(volume, randomness, frequency, attack, sustain, release, shape,
    shapeCurve, slide, deltaSlide, pitchJump, pitchJumpTime, repeatTime, noise,
    modulation, bitCrush, delay, sustainVolume, decay, tremolo, filter) {
    volume = volume === undefined ? 1 : volume;
    randomness = randomness === undefined ? 0.05 : randomness;
    frequency = frequency === undefined ? 220 : frequency;
    attack = attack || 0; sustain = sustain || 0;
    release = release === undefined ? 0.1 : release;
    shape = shape || 0; shapeCurve = shapeCurve === undefined ? 1 : shapeCurve;
    slide = slide || 0; deltaSlide = deltaSlide || 0;
    pitchJump = pitchJump || 0; pitchJumpTime = pitchJumpTime || 0;
    repeatTime = repeatTime || 0; noise = noise || 0;
    modulation = modulation || 0; bitCrush = bitCrush || 0; delay = delay || 0;
    sustainVolume = sustainVolume === undefined ? 1 : sustainVolume;
    decay = decay || 0; tremolo = tremolo || 0; filter = filter || 0;
    var PI2 = Math.PI * 2, sign = function (v) { return v > 0 ? 1 : -1; };
    var sampleRate = ZZFX_RATE;
    var startSlide = slide *= 500 * PI2 / sampleRate / sampleRate;
    var startFrequency = frequency *=
      (1 + (Math.random() * 2 - 1) * randomness) * PI2 / sampleRate;
    var modOffset = 0, repeat = 0, crush = 0, jump = 1;
    var length, b = [], t = 0, i = 0, s = 0, f;
    var quality = 2, w = PI2 * Math.abs(filter) * 2 / sampleRate;
    var cosw = Math.cos(w), alpha = Math.sin(w) / 2 / quality;
    var a0 = 1 + alpha, a1 = -2 * cosw / a0, a2 = (1 - alpha) / a0;
    var b0 = (1 + sign(filter) * cosw) / 2 / a0;
    var b1 = -(sign(filter) + cosw) / a0, b2 = b0;
    var x2 = 0, x1 = 0, y2 = 0, y1 = 0;
    attack = attack * sampleRate || 9;
    decay *= sampleRate; sustain *= sampleRate; release *= sampleRate;
    delay *= sampleRate;
    deltaSlide *= 500 * PI2 / Math.pow(sampleRate, 3);
    modulation *= PI2 / sampleRate;
    pitchJump *= PI2 / sampleRate;
    pitchJumpTime *= sampleRate;
    repeatTime = repeatTime * sampleRate | 0;
    for (length = attack + decay + sustain + release + delay | 0;
      i < length; b[i++] = s * volume) {
      if (!(++crush % (bitCrush * 100 | 0))) {
        s = shape ? shape > 1 ? shape > 2 ? shape > 3 ? shape > 4 ?
          (t / PI2 % 1 < shapeCurve / 2 ? 1 : -1) :
          Math.sin(Math.pow(t, 3)) :
          Math.max(Math.min(Math.tan(t), 1), -1) :
          1 - (2 * t / PI2 % 2 + 2) % 2 :
          1 - 4 * Math.abs(Math.round(t / PI2) - t / PI2) :
          Math.sin(t);
        s = (repeatTime ? 1 - tremolo + tremolo * Math.sin(PI2 * i / repeatTime) : 1) *
          (shape > 4 ? s : sign(s) * Math.pow(Math.abs(s), shapeCurve)) *
          (i < attack ? i / attack :
            i < attack + decay ? 1 - ((i - attack) / decay) * (1 - sustainVolume) :
              i < attack + decay + sustain ? sustainVolume :
                i < length - delay ? (length - i - delay) / release * sustainVolume : 0);
        s = delay ? s / 2 + (delay > i ? 0 :
          (i < length - delay ? 1 : (length - i) / delay) *
          b[i - delay | 0] / 2 / volume) : s;
        if (filter) s = y1 = b2 * x2 + b1 * (x2 = x1) + b0 * (x1 = s) - a2 * y2 - a1 * (y2 = y1);
      }
      f = (frequency += slide += deltaSlide) * Math.cos(modulation * modOffset++);
      t += f + f * noise * Math.sin(Math.pow(i, 5));
      if (jump && ++jump > pitchJumpTime) {
        frequency += pitchJump; startFrequency += pitchJump; jump = 0;
      }
      if (repeatTime && !(++repeat % repeatTime)) {
        frequency = startFrequency; slide = startSlide; jump = jump || 1;
      }
    }
    return b;
  }

  var Sfx = (function () {
    // Every sound is a ZzFX parameter array (dial at zzfx.3d2k.com). Envelope
    // law: a hit's release matches its hitstop/shake decay — breath (0.45s)
    // rings just past the 0.35s hitstop; ticks are gone in 60ms.
    var SFX = {
      place:  [0.9, , 270, 0.01, 0.06, 0.15, 1, 1.6, , , 220, 0.04],
      upg:    [0.9, , 523, 0.02, 0.15, 0.30, 1, 1.8, , , 262, 0.06, 0.08],
      sell:   [0.8, , 330, 0.01, 0.08, 0.20, 1, 1.4, -4],
      // a machine going silent should SOUND like it: a metal clank that dies
      // fast, distinct from 'sell' so you know a Pry-Hand reached something
      jam:    [1.0, , 190, 0.01, 0.06, 0.22, 3, 0.9, -12, , , , , 0.8],
      // and a keg cracking apart: a low pop with a wooden splinter tail
      split:  [1.0, , 110, 0.02, 0.10, 0.28, 4, 1.1, -3, , , , , 1.2],
      shoot:  [0.5, , 880, , 0.02, 0.06, 1, 1.8, , , , , , 0.1],
      lob:    [0.7, , 160, 0.02, 0.08, 0.25, 4, 1.2, 6, , , , , 0.6],
      bite:   [0.9, , 130, 0.01, 0.05, 0.18, 3, 1.5, -6, , , , , 0.4],
      hit:    [0.8, , 150, 0.01, 0.03, 0.16, 4, 1.4, -6, , , , , 0.7, , 0.2],
      coin:   [0.7, , 1046, , 0.04, 0.16, 1, 1.9, , , 540, 0.05],
      steal:  [1.0, , 320, 0.02, 0.12, 0.40, 2, 1.3, -4, , -80, 0.10, , 0.2, , , 0.10],
      recover:[0.9, , 660, 0.01, 0.10, 0.30, 1, 1.7, , , 330, 0.06],
      leak:   [1.0, , 110, 0.03, 0.20, 0.60, 2, 1.2, -2, , , , , 0.3, , 0.2, 0.15],
      wave:   [0.9, , 196, 0.05, 0.30, 0.40, 2, 1.5, 2, , , , 0.12, , , , 0.10],
      breath: [1.1, , 90, 0.02, 0.25, 0.45, 4, 1.3, 3, , , , , 0.8, , 0.3, 0.15],
      win:    [0.9, , 523, 0.04, 0.30, 0.50, 1, 1.7, , , 392, 0.10, 0.15, , , , 0.20],
      lose:   [1.0, , 220, 0.05, 0.25, 0.80, 1, 1.5, -3, , -60, 0.15, , 0.15, , 0.2, 0.20],
      crackle:[0.25, 0.3, 700, , 0.01, 0.08, 4, 2, -20, , , , , 1.5],
    };
    var RATE_MS = { shoot: 70, hit: 60, coin: 70, bite: 90, lob: 90 };
    var MAX_VOICES = 8;
    var ac = null, master = null, sfxBus = null, musicBus = null;
    var cache = {}, live = [], lastPlay = {}, ambienceOn = false, crackleTimer = null;
    var muted = false;
    try { muted = localStorage.getItem('hoardling.muted') === '1'; } catch (e) {}

    function ctx() {
      if (ac) return ac;
      try {
        ac = new (window.AudioContext || window.webkitAudioContext)();
        master = ac.createGain(); master.connect(ac.destination);
        master.gain.value = muted ? 0 : 1;
        sfxBus = ac.createGain(); sfxBus.gain.value = 0.9; sfxBus.connect(master);
        // 0.63, not 0.5: the whole music suite masters to -18 LUFS rather than
        // the fleet's usual -16, so that no crossfade between two tracks is
        // also a level jump. 0.5 * 10^(2/20) = 0.629 puts it back where the
        // old placeholder sat relative to the SFX bus.
        musicBus = ac.createGain(); musicBus.gain.value = 0.63; musicBus.connect(master);
      } catch (e) { ac = null; }
      return ac;
    }
    function buffer(name) {
      if (cache[name]) return cache[name];
      var params = SFX[name];
      if (!params || !ac) return null;
      var samples = zzfxG.apply(null, params);
      var buf = ac.createBuffer(1, samples.length, ZZFX_RATE);
      buf.getChannelData(0).set(samples);
      return (cache[name] = buf);
    }
    function voice(buf, bus, rate) {
      if (live.length >= MAX_VOICES) { try { live.shift().stop(); } catch (e) {} }
      var src = ac.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      src.connect(bus);
      src.onended = function () { var i = live.indexOf(src); if (i >= 0) live.splice(i, 1); };
      src.start();
      live.push(src);
    }
    function startAmbience() {
      if (ambienceOn || !ac) return;
      ambienceOn = true;
      // cavern air: looped noise -> deep lowpass, breathing very slowly
      var len = ZZFX_RATE * 2, nb = ac.createBuffer(1, len, ZZFX_RATE);
      var ch = nb.getChannelData(0);
      for (var i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
      var src = ac.createBufferSource();
      src.buffer = nb; src.loop = true;
      var lp = ac.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 140; lp.Q.value = 0.5;
      var g = ac.createGain(); g.gain.value = 0.05;
      var lfo = ac.createOscillator(), lfoG = ac.createGain();
      lfo.frequency.value = 0.07; lfoG.gain.value = 0.02;
      lfo.connect(lfoG); lfoG.connect(g.gain);
      src.connect(lp); lp.connect(g); g.connect(musicBus);
      src.start(); lfo.start();
      // distant ember crackles, sparse and randomly timed (cosmetic clock)
      (function crackle() {
        crackleTimer = setTimeout(function () {
          if (ac && ac.state === 'running' && !document.hidden) {
            var b = buffer('crackle');
            if (b) voice(b, musicBus, 0.8 + Math.random() * 0.4);
          }
          crackle();
        }, 3000 + Math.random() * 6000);
      })();
    }
    // ===== Music ==========================================================
    // Pre-rendered beds + phase-locked stems, authored by tools/generate_music.py
    // and gated by tools/check_music.py. The score's own reasoning lives in that
    // generator's docstring; what matters HERE is three mechanical rules.
    //
    // 1. THE BAR IS 2.400s IN EVERY TRACK, and every track is a whole number of
    //    bars. So if the bed and the stems are all started with loop=true at
    //    times that differ by a whole number of bars, their bar lines coincide
    //    forever — no drift, no re-sync, no scheduler.
    // 2. A STEM IS NEVER RE-CUED. It runs from the moment it decodes until the
    //    level ends, and "turning a layer on" is a gain ramp. Re-cueing a source
    //    on a wave flag is what makes adaptive music pop, and a wave here starts
    //    every ~7s (CFG.waveCountdown), so it would pop constantly.
    // 3. THE STEM LENGTHS ARE COPRIME WITH THE BED (36 / 7 / 5 bars). The layers
    //    therefore land on a different chord each lap, and the combination does
    //    not repeat for 10.1 minutes.
    //
    // Everything below is COSMETIC and consumes nothing from the seeded stream —
    // the only randomness is one Math.random() for the retry re-entry offset.
    var BAR_SEC = 2.4;
    var XFADE = 1.4;                     // the fleet's crossfade law
    var SRC_SR = 44100;                  // render rate; decode may resample
    var Music = {
      map: null, buf: {}, loading: false, ready: false,
      bedName: '', bedSrc: null, bedGain: null, bedAt: 0, bedDur: 0,
      stems: {}, pending: null, lp: null, wantScene: null,
      chordValid: true,
    };
    // Runtime layer levels. The mix balance lives HERE, not baked into the
    // files: every track masters to the same -18 LUFS so no crossfade is ever a
    // level jump, and the relative weight of a layer is a number we can change
    // without re-rendering anything.
    var STEM_GAIN = { works: 0.55, guild: 0.45, court: 0.55 };

    function musicLoad() {
      // Called AFTER the art gate releases (see boot in index.html). Music must
      // never be in front of first render: this game cut its cold start from
      // 19 MB to 1.4 MB and the whole point was to paint sooner.
      if (Music.loading || !window.fetch || !ac) return;
      Music.loading = true;
      fetch('audio/music_map.json').then(function (r) { return r.json(); })
        .then(function (map) {
          Music.map = map;
          // Staged: the two beds first (one of them is needed immediately),
          // then the stems, which are not audible until a wave starts anyway.
          ['music_hall', 'music_keep'].forEach(fetchTrack);
          setTimeout(function () {
            ['stem_works', 'stem_guild', 'stem_court',
             'sting_win', 'sting_lose', 'sting_boss'].forEach(fetchTrack);
          }, 400);
        }).catch(function () { Music.loading = false; });
    }

    function fetchTrack(name) {
      fetch('audio/' + name + '.m4a')
        .then(function (r) { return r.arrayBuffer(); })
        .then(function (ab) {
          if (!ac) return;
          ac.decodeAudioData(ab, function (buf) {
            // decodeAudioData resamples to the context rate and does NOT
            // reliably honour gapless metadata, so a decoded buffer can carry a
            // few encoder-priming samples on the end. Trim to the sample count
            // the renderer recorded, or the loop drifts a few ms every pass and
            // walks off the bar grid the stems depend on.
            var want = Math.round(Music.map[name].samples * ac.sampleRate / SRC_SR);
            var n = Math.min(want, buf.length);
            var out = ac.createBuffer(buf.numberOfChannels, n, ac.sampleRate);
            for (var c = 0; c < buf.numberOfChannels; c++) {
              out.getChannelData(c).set(buf.getChannelData(c).subarray(0, n));
            }
            Music.buf[name] = out;
            if (name === 'music_hall' || name === 'music_keep') {
              Music.ready = true;
              if (Music.wantScene) startBed(Music.wantScene);
            } else if (name.indexOf('stem_') === 0 && Music.bedSrc) {
              startStem(name.slice(5));
            }
          }, function () {});
        }).catch(function () {});
    }

    // A stem that decodes late cannot start at the bed's t0 — that instant has
    // passed. Start it at the next WHOLE BAR after now, measured from the bed's
    // own origin, and rule 1 still holds.
    function nextBarAfter(t) {
      var since = t - Music.bedAt;
      return Music.bedAt + Math.ceil(since / BAR_SEC) * BAR_SEC;
    }

    function startStem(key) {
      var name = 'stem_' + key;
      if (!ac || !Music.buf[name] || !Music.bedSrc || Music.stems[key]) return;
      var t = nextBarAfter(ac.currentTime + 0.08);
      var src = ac.createBufferSource();
      src.buffer = Music.buf[name];
      src.loop = true;
      var gn = ac.createGain();
      gn.gain.value = 0;                        // always running, silent by default
      src.connect(gn); gn.connect(Music.lp || musicBus);
      src.start(t);
      Music.stems[key] = { src: src, gain: gn, want: 0 };
    }

    function stopStems() {
      Object.keys(Music.stems).forEach(function (k) {
        try { Music.stems[k].src.stop(); } catch (e) {}
      });
      Music.stems = {};
    }

    function startBed(scene) {
      var name = scene === 'hall' ? 'music_hall' : 'music_keep';
      Music.wantScene = scene;
      if (!ac || !Music.buf[name]) return;
      if (Music.bedName === name) return;
      var t = ac.currentTime;
      if (Music.bedSrc) {
        var old = Music.bedSrc, og = Music.bedGain;
        og.gain.cancelScheduledValues(t);   // kill pending duck-restores, or a
        og.gain.setValueAtTime(og.gain.value, t);   // later ramp resurrects it
        og.gain.linearRampToValueAtTime(0, t + XFADE);
        setTimeout(function () { try { old.stop(); } catch (e) {} }, (XFADE + 0.2) * 1000);
      }
      stopStems();
      if (!Music.lp) {
        // The intensity dial. A filter cannot thrash: there is no threshold to
        // chatter across and no phase to lose, so three audible tiers come out
        // of two files and one setTargetAtTime.
        Music.lp = ac.createBiquadFilter();
        Music.lp.type = 'lowpass';
        Music.lp.frequency.value = 3600;
        Music.lp.Q.value = 0.4;
        Music.lp.connect(musicBus);
      }
      var src = ac.createBufferSource();
      src.buffer = Music.buf[name];
      src.loop = true;
      var gn = ac.createGain();
      gn.gain.setValueAtTime(0, t);
      gn.gain.linearRampToValueAtTime(1, t + XFADE);
      src.connect(gn); gn.connect(Music.lp);
      // Re-entering a level after a defeat should not replay bar 1 for the
      // fifth time — retrying wave 18 is normal, and "the beginning plays a
      // hundred times a session" is the genre's most-documented complaint.
      var off = Music.replayOffset || 0;
      Music.replayOffset = 0;
      src.start(t, off);
      Music.bedSrc = src; Music.bedGain = gn; Music.bedName = name;
      Music.bedDur = src.buffer.duration;
      Music.bedAt = t - off;              // the bar clock's true origin
      ['works', 'guild', 'court'].forEach(startStem);
    }

    // Which bar of the bed is playing right now (for live harmonisation).
    function bedBar() {
      if (!ac || !Music.bedSrc || !Music.map) return -1;
      var e = Music.map[Music.bedName];
      if (!e || !e.chords) return -1;
      var el = (ac.currentTime - Music.bedAt) % (Music.bedDur || 1);
      return Math.floor(el / BAR_SEC) % e.bars;
    }

    function ramp(param, to, secs) {
      if (!ac) return;
      var t = ac.currentTime;
      param.cancelScheduledValues(t);
      param.setValueAtTime(param.value, t);
      param.linearRampToValueAtTime(to, t + secs);
    }

    document.addEventListener('visibilitychange', function () {
      if (!ac) return;
      if (document.hidden) { ac.suspend(); }
      else if (!muted) { ac.resume(); }
    });
    var api = {
      unlock: function () {
        var a = ctx();
        if (a && a.state !== 'running') a.resume();
        if (a) { startAmbience(); musicLoad(); }
      },
      // Which room we are in. 'hall' = title/forge/trials, 'keep' = a level.
      scene: function (s) {
        if (!ac) { Music.wantScene = s; return; }
        startBed(s);
      },
      // The whole intensity model, in one call, drained from _cosmetic().
      //
      // There are exactly two gain decisions (machines on, raiders on) plus one
      // continuous filter. Both booleans change only when a wave starts or ends,
      // and CFG.waveCountdown puts >=7s between those, so a dwell rule would
      // have nothing to do.
      setPhase: function (p) {
        if (!ac || !Music.bedSrc) return;
        var wave = p.waveActive ? 1 : 0;
        // The machines run whenever Wick is holding the cave, and run HARDER
        // during a wave — they never cut, because the workshop never stops.
        var works = p.playing ? (wave ? 1 : 0.42) : 0;
        // The raiders' own tune only exists once they have actually shown up.
        // Wave 1 is deliberately marchless: the reveal lands on the player
        // instead of being explained to them.
        var guild = (wave && p.wave >= 2 && !p.boss) ? 1 : 0;
        var court = (wave && p.boss) ? 1 : 0;
        // The bed's drop bars were composed as the ear's reset. A build phase
        // is 7s, so if the stems stayed up over them the drop would never once
        // be heard in a whole level. Mask the machines across those bars.
        var e = Music.map && Music.map[Music.bedName];
        if (e && e.dropBars && e.dropBars.indexOf(bedBar()) >= 0) works *= 0.25;
        var set = { works: works, guild: guild, court: court };
        Object.keys(Music.stems).forEach(function (k) {
          var s = Music.stems[k], to = (set[k] || 0) * (STEM_GAIN[k] || 0.5);
          if (Math.abs(s.want - to) < 0.004) return;
          s.want = to;
          // Escalation completes on its own time; de-escalation starts NOW.
          // The player's win must be acknowledged immediately; the threat's
          // arrival can afford to arrive.
          ramp(s.gain.gain, to, to > 0 ? 1.1 : 0.6);
        });
        // Warmth: the cave opens up as the hoard drains. A full hoard is a
        // closed, warm room; losing it takes the lid off.
        if (Music.lp) {
          var open = p.playing ? (wave ? 0.55 + 0.45 * (1 - (p.hoardFrac || 1)) : 0.28) : 1;
          var fc = 900 * Math.pow(16, open);
          var t = ac.currentTime;
          Music.lp.frequency.cancelScheduledValues(t);
          Music.lp.frequency.setTargetAtTime(Math.max(700, Math.min(16000, fc)), t, 1.2);
        }
      },
      // One-shot cues. These ride the music bus, NOT voice()/sfxBus — the SFX
      // pool caps at 8 concurrent voices and is shared with the ember crackles,
      // so a musical cue routed there can be evicted mid-phrase during combat.
      cue: function (name, opts) {
        if (!ac || muted) return;
        var buf = Music.buf['sting_' + name];
        if (!buf) return;
        opts = opts || {};
        var t = ac.currentTime;
        var src = ac.createBufferSource();
        src.buffer = buf;
        var gn = ac.createGain();
        gn.gain.value = 1;
        src.connect(gn); gn.connect(musicBus);
        src.start(t);
        if (Music.bedGain) {
          var bg = Music.bedGain.gain;
          bg.cancelScheduledValues(t);
          bg.setValueAtTime(bg.value, t);
          if (opts.stop) {
            bg.linearRampToValueAtTime(0, t + 2.0);      // defeat: the room stops
            Object.keys(Music.stems).forEach(function (k) {
              ramp(Music.stems[k].gain.gain, 0, 1.2);
            });
          } else {
            bg.linearRampToValueAtTime(0.10, t + 0.4);   // victory: it listens
            bg.setValueAtTime(0.10, t + buf.duration - 1.2);
            bg.linearRampToValueAtTime(1, t + buf.duration);
          }
        }
      },
      // The wave-clear answer is played LIVE, harmonised to whatever bar the
      // bed is actually on, so it can never say the same thing twice running —
      // and it costs zero bytes. A pre-rendered clear stinger is the single
      // most dangerous asset you can author: it fires 20 times a level.
      clear: function () {
        if (!ac || muted || !Music.bedSrc || !Music.chordValid) return;
        var e = Music.map && Music.map[Music.bedName];
        var bar = bedBar();
        if (!e || !e.chords || bar < 0) return;
        var ch = e.chords[bar];
        if (!ch || !ch.length) return;
        var t = ac.currentTime + 0.02;
        for (var i = 0; i < 3; i++) {
          var m = ch[i % ch.length] + 24;                 // two octaves up: it
          var f = 440 * Math.pow(2, (m - 69) / 12);       // rings over the bed
          var o = ac.createOscillator(), g = ac.createGain();
          o.type = 'triangle'; o.frequency.value = f;
          var at = t + i * 0.075;
          g.gain.setValueAtTime(0.0001, at);
          g.gain.exponentialRampToValueAtTime(0.075, at + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, at + 1.1);
          o.connect(g); g.connect(musicBus);
          o.start(at); o.stop(at + 1.2);
        }
      },
      // Called when a level is (re)entered, before scene('keep').
      replayVaried: function () {
        // Lane 3, cosmetic, Math.random by law — never the seeded stream.
        if (Music.buf.music_keep) {
          var bars = (Music.map.music_keep.bars) | 0;
          var b = Math.floor(Math.random() * Math.max(1, bars >> 1));
          Music.replayOffset = b * BAR_SEC;      // whole bars only
        }
      },
      stopAll: function () {
        if (!ac) return;
        stopStems();
        if (Music.bedSrc) {
          try { Music.bedSrc.stop(); } catch (e) {}
          Music.bedSrc = null; Music.bedName = '';
        }
      },
      play: function (name) {
        if (!ac || muted) return;                     // consumes NOTHING seeded
        var now = Date.now();
        if (RATE_MS[name] && lastPlay[name] && now - lastPlay[name] < RATE_MS[name]) return;
        lastPlay[name] = now;
        var buf = buffer(name);
        if (!buf) return;
        // per-play pitch jitter — ZzFX's own flavour, NEVER the gameplay seed
        voice(buf, sfxBus, 1 + (Math.random() - 0.5) * 0.06);
      },
      isMuted: function () { return muted; },
      setMuted: function (v) {
        muted = !!v;
        try { localStorage.setItem('hoardling.muted', muted ? '1' : '0'); } catch (e) {}
        if (master) master.gain.value = muted ? 0 : 1;
      },
      toggle: function () { api.setMuted(!muted); return muted; },
    };
    return api;
  })();

  // ===== Save — tiny, versioned, quarantined on parse failure =============
  // v2 (levels): stars is an array, one slot per campaign level. A v1 save's
  // single campaignStars migrates into stars[0]; unknown/corrupt data never
  // crashes the boot.
  // The Forge — the star-tree the design studio specced. 9 total ranks = the
  // 9 campaign stars; free respec; CAMPAIGN-ONLY effects (daily-neutrality law).
  var FORGE_NODES = [
    { id: 'dmg',    name: 'Whetted Fangs',   desc: '+8% tower damage / rank',  ranks: 3 },
    { id: 'range',  name: 'Far-Seeing Eyes', desc: '+6% tower range / rank',   ranks: 2 },
    { id: 'gold',   name: 'Seed Purse',      desc: '+25 starting gold / rank', ranks: 2 },
    { id: 'breath', name: 'Deep Lungs',      desc: "Wick's breath: 14s -> 11s", ranks: 1 },
    { id: 'refund', name: 'Honest Fences',   desc: 'sell refund 70% -> 80%',   ranks: 1 },
  ];

  // TRIALS — replayable campaign mutators, unlocked per level after its first
  // win. One badge per (level, trial). Pure DATA riding this.mods; the Daily
  // never sees any of it (the Daily takes no input but the seed — LAW).
  var TRIALS = {
    purse:   { name: 'One Good Purse', pitch: 'No bounties. One purse, full refunds. Spend it well.',
               mods: { bountyMul: 0, startGold: 480, sellRefund: 1 } },
    picnic:  { name: 'Kobold Picnic',  pitch: 'Crossbow crews are picnicking — build without them.',
               mods: { bannedTower: 'ballista' } },
    greased: { name: 'Greased Boots',  pitch: 'Slick soles: the getaway is a sprint. Hold the door.',
               mods: { fleeMul: 1.5 } },
    // Three more, because a mutator is the cheapest content this game can make:
    // it multiplies the three authored maps instead of asking for a fourth. Each
    // changes the PLAN, not the numbers — a run you have to solve differently is
    // content; a run that is the same run with bigger health bars is not.
    guttered:  { name: 'Guttered Torches', pitch: 'The lights are low. Every machine sees less — build close.',
                 mods: { rangeMul: 0.72 } },
    lean:      { name: 'Lean Season',      pitch: 'Almost nothing to start. The raiders pay for everything.',
                 // startGold was ADDITIVE and landed on top of the Forge's purse,
                 // so the harshest-sounding trial started you richer than normal
                 // AND paid 1.6x bounties — the softest run in the game.
                 mods: { startGoldSet: 60, bountyMul: 1.6 } },
    smothered: { name: 'Smothered Fire',   pitch: "Wick's flame is out. The machines answer alone.",
                 // NOT breathCd: 9999 — the hero inits breathCd 6, so that still
                 // granted one free breath, and two meters hardcode 14 and would
                 // have drawn a permanently full bar. An off switch is honest.
                 mods: { breathOff: true } },
  };
  var TRIAL_ORDER = ['purse', 'picnic', 'greased', 'guttered', 'lean', 'smothered'];

  // ---- RIVAL SIEGE — the duel mode ---------------------------------------
  // The Guild posted TWO caves on the board tonight. You and a rival hoardling
  // face THE SAME raiding party, split down the middle: same map, same seed,
  // same wave sequence, wave for wave. Whoever still has gold at the end wins.
  //
  // WHY THE RIVAL IS A RECORDING, AND WHY THAT IS NOT A CHEAT.
  // In mirrored-wave versus (the Kingdom Rush Battles / Legion TD 2 fairness
  // pattern, and the format Rush Royale twice rebuilt its ranked ladder to
  // reach) the opponent NEVER REACTS TO YOU. There is no interference channel:
  // both sides simply race the same waves. So a rival's whole run is a pure
  // function of (map, seed, policy) — which means a recorded run is not an
  // approximation of an opponent, it IS the opponent, at full fidelity. The
  // curves below were produced by tools/bake-rivals.js driving the real
  // tools/bot.js through real injected taps: real economy, real crowd pricing,
  // real placement validation. Nothing here is a hand-authored difficulty
  // number, and no bot code ships in the bundle.
  //
  // This is also what makes the mode work at a population of one. A live queue
  // needs an opponent online right now; Element TD 2 ships with the literal
  // subtitle "Multiplayer Tower Defense" and averages 51 concurrent players.
  // A recording is always home.
  var DUEL_WAVES = 12;                    // a phone session, not an evening
  // Arenas rotate daily so a duel is not a fixed puzzle, but hold still WITHIN
  // a day so a loss can be avenged on the same ground.
  // An arena is a SEED PLUS ITS MAP, stated, not derived. Deriving the map as
  // (seed % MAPS.length) was tried first and the six seeds landed 5-0-1 across
  // the three maps — a distribution nobody chose and nobody would have noticed,
  // and one that would silently re-scramble the day a fourth map is authored.
  // Two arenas per map, written down.
  var DUEL_ARENAS = [
    { seed: 0x5eed1a3f, map: 0 },
    { seed: 0xd00dfeed, map: 1 },
    { seed: 0x7a11ba5e, map: 2 },
    { seed: 0x0dd1e5ec, map: 0 },
    { seed: 0x1ceb00da, map: 1 },
    { seed: 0xa11ecafe, map: 2 },
  ];
  var RIVALS = [
    { id: 'tallow', name: 'Tallow', rank: 'APPRENTICE', policy: 'spam', wick: false,
      blurb: 'Builds wide and cheap. Never upgrades anything.' },
    { id: 'flint', name: 'Flint', rank: 'JOURNEYMAN', policy: 'balanced', wick: false,
      blurb: 'Spreads his brass evenly and calls it craft.' },
    { id: 'ember', name: 'Ember', rank: 'ARTIFICER', policy: 'depth', wick: false,
      blurb: 'Few machines. All of them monsters.' },
    { id: 'cinder', name: 'Cinder', rank: 'DRAKE', policy: 'depth', wick: true,
      blurb: 'Works the cavern floor herself. Good luck.' },
  ];
  var RIVAL_ORDER = ['tallow', 'flint', 'ember', 'cinder'];
  // RIVAL_CURVES[rivalId][seedIdx] = hoard after each wave, DUEL_WAVES+1 long
  // (index 0 = the starting hoard, index W = after wave W resolved). A rival
  // whose hoard reaches 0 has been sacked and the duel ends early.
  // BAKED — regenerate with: node tools/bake-rivals.js  (writes this block)
  var RIVAL_CURVES = {};                  // filled by the baked table below
  // A rival's arena for today. Pure function of the day and the rival, so both
  // sides of a duel are the same fight and tomorrow is computable today (which
  // is how the curves get baked ahead of time).
  function duelSeedIdx(rivalIdx) { return (dayNumber() + rivalIdx) % DUEL_ARENAS.length; }
  // The arena's MAP is a function of the arena, never of the day. Deriving it
  // from the day instead would mean a baked curve and the run it is scored
  // against could sit on different ground — the one failure this whole mode
  // has to make impossible.
  function duelMapAt(seedIdx) { return (DUEL_SEEDS[seedIdx] >>> 0) % MAPS.length; }
  function duelMapFor(rivalIdx) { return duelMapAt(duelSeedIdx(rivalIdx)); }   // tonight's, for the picker
  /** The rival's hoard after wave w, or null if this duel has no baked curve. */
  function rivalHoardAt(rivalIdx, seedIdx, w) {
    var row = RIVAL_CURVES[RIVAL_ORDER[rivalIdx]];
    if (!row || !row[seedIdx]) return null;
    var c = row[seedIdx];
    return c[Math.max(0, Math.min(c.length - 1, w | 0))];
  }

  var Save = (function () {
    var KEY2 = 'hoardling.save.v2', KEY1 = 'hoardling.save.v1';
    // duels: { <rivalId>: { w: 1, m: <best margin> } } — an OBJECT, not a bare
    // number, because the best margin can legitimately be 0 (a duel won on the
    // tiebreak) and a falsy value would read as "never beaten". Same trap the
    // bountyMul null-check exists for.
    var data = { stars: [0, 0, 0], dailyBestWave: 0, tut: 0, daily: { day: 0, best: 0 }, forge: {}, seen: {}, trials: {}, duels: {} };
    try {
      var raw = localStorage.getItem(KEY2);
      if (raw) {
        var p = JSON.parse(raw);
        if (Array.isArray(p.stars)) {
          for (var i = 0; i < data.stars.length; i++) data.stars[i] = (p.stars[i] | 0) || 0;
        }
        if (typeof p.dailyBestWave === 'number') data.dailyBestWave = p.dailyBestWave | 0;
        if (typeof p.tut === 'number') data.tut = p.tut | 0;
        if (p.daily && typeof p.daily.day === 'number') data.daily = { day: p.daily.day | 0, best: p.daily.best | 0 };
        if (p.seen && typeof p.seen === 'object') {
          // same whitelist discipline: ENEMY_TYPES['toString'] is truthy too
          for (var sk in ENEMY_TYPES) if (p.seen[sk]) data.seen[sk] = 1;
        }
        if (p.forge && typeof p.forge === 'object') {
          for (var fi = 0; fi < FORGE_NODES.length; fi++) {
            var nid = FORGE_NODES[fi].id;
            data.forge[nid] = Math.min(FORGE_NODES[fi].ranks, (p.forge[nid] | 0) || 0);
          }
        }
        if (p.trials && typeof p.trials === 'object') {
          for (var tl in p.trials) {
            var li = tl | 0;
            // exact-key check: 'junk'|0 is 0 and must not touch level 0's row
            if (String(li) !== tl || li < 0 || li > 2) continue;
            if (!p.trials[tl] || typeof p.trials[tl] !== 'object') continue;
            data.trials[li] = data.trials[li] || {};
            // whitelist-iterate OUR keys, never for-in over hostile input —
            // TRIALS['constructor'] is truthy via Object.prototype
            for (var to = 0; to < TRIAL_ORDER.length; to++) {
              if (p.trials[tl][TRIAL_ORDER[to]]) data.trials[li][TRIAL_ORDER[to]] = 1;
            }
          }
        }
        if (p.duels && typeof p.duels === 'object') {
          // whitelist-iterate OUR ids, never for-in over hostile input
          for (var ro = 0; ro < RIVAL_ORDER.length; ro++) {
            var rid = RIVAL_ORDER[ro], rec = p.duels[rid];
            if (!rec || typeof rec !== 'object' || !rec.w) continue;
            data.duels[rid] = { w: 1, m: Math.max(0, Math.min(CFG.startHoard, rec.m | 0)) };
          }
        }
      } else {
        var raw1 = localStorage.getItem(KEY1);
        if (raw1) {
          var p1 = JSON.parse(raw1);
          if (typeof p1.campaignStars === 'number') data.stars[0] = p1.campaignStars | 0;
          if (typeof p1.dailyBestWave === 'number') data.dailyBestWave = p1.dailyBestWave | 0;
          if (typeof p1.tut === 'number') data.tut = p1.tut | 0;
        }
      }
    } catch (e) { /* corrupt save: keep defaults */ }
    function write() { try { localStorage.setItem(KEY2, JSON.stringify(data)); } catch (e) {} }
    function unlocked(level) { return level === 0 || data.stars[level - 1] > 0; }
    function starsTotal() { return (data.stars[0] | 0) + (data.stars[1] | 0) + (data.stars[2] | 0); }
    function forgeSpent() {
      var s = 0;
      for (var i = 0; i < FORGE_NODES.length; i++) s += data.forge[FORGE_NODES[i].id] | 0;
      return s;
    }
    function forgeMods() {
      var f = data.forge;
      return {
        dmgMul: 1 + 0.08 * ((f.dmg | 0) || 0),
        rangeMul: 1 + 0.06 * ((f.range | 0) || 0),
        startGold: 25 * ((f.gold | 0) || 0),
        breathCd: (f.breath | 0) ? 11 : 14,
        sellRefund: (f.refund | 0) ? 0.8 : 0,
      };
    }
    return { data: data, write: write, unlocked: unlocked,
             starsTotal: starsTotal, forgeSpent: forgeSpent, forgeMods: forgeMods };
  })();

  // ===== Daily leaderboard — the WADDLETON foundation (fail-soft, lane 3) ==
  // Hoardling is board 'hoardling_daily' in the proven multi-board Supabase
  // schema PenguinArcade ships (registry + authenticated-only RPCs +
  // server-timed single-use tokens + monotonic best). Identity: Supabase
  // NATIVE ANONYMOUS sign-in (probed live 2026-08-13: mints a session
  // directly, no relay/captcha). Config via optional lb-config.js
  // (window.HOARDLING_LB = {url, key, board}); absent config = board off =
  // every path silently no-ops. NOTHING here touches the seeded stream.
  var Lb = (function () {
    var cfg = (typeof window !== 'undefined' && window.HOARDLING_LB) || null;
    function on() { return !!(cfg && cfg.url && cfg.key && cfg.board); }
    var sess = null;
    try { sess = JSON.parse(localStorage.getItem('hoardling.sb') || 'null'); } catch (e) {}
    function saveSess() { try { localStorage.setItem('hoardling.sb', JSON.stringify(sess)); } catch (e) {} }
    function hdrs() {
      return { 'apikey': cfg.key, 'Authorization': 'Bearer ' + (sess && sess.access_token || cfg.key), 'Content-Type': 'application/json' };
    }
    // ensureSession(cb): reuse -> refresh -> anonymous signup, all fail-soft
    function ensureSession(cb) {
      if (!on()) { cb(false); return; }
      var now = Date.now() / 1000;
      if (sess && sess.access_token && sess.expires_at - 60 > now) { cb(true); return; }
      var doSignup = function () {
        fetch(cfg.url + '/auth/v1/signup', { method: 'POST', headers: { 'apikey': cfg.key, 'Content-Type': 'application/json' }, body: '{}' })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d && d.access_token) {
              sess = { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: now + (d.expires_in || 3600) };
              saveSess(); cb(true);
            } else cb(false);
          })
          .catch(function () { cb(false); });
      };
      if (sess && sess.refresh_token) {
        fetch(cfg.url + '/auth/v1/token?grant_type=refresh_token', {
          method: 'POST', headers: { 'apikey': cfg.key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: sess.refresh_token }),
        }).then(function (r) { return r.json(); })
          .then(function (d) {
            if (d && d.access_token) {
              sess = { access_token: d.access_token, refresh_token: d.refresh_token, expires_at: Date.now() / 1000 + (d.expires_in || 3600) };
              saveSess(); cb(true);
            } else doSignup();   // refresh rejected: mint a fresh anonymous user
          })
          .catch(function () { cb(false); });   // network: not a reason to re-mint
      } else doSignup();
    }
    function tag() {   // WICK-XXXX derived from the stored session — no input UI
      var s = (sess && sess.refresh_token) || 'wick';
      var h = 0;
      for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
      return 'WICK-' + ('0000' + ((h >>> 0) % 65536).toString(16).toUpperCase()).slice(-4);
    }
    // strict-pattern render guard (the Gemburrow safeName lesson): any name
    // that isn't exactly our tag shape paints as WICK-???? — no sanitizer gaps
    function safeName(s) { return /^WICK-[0-9A-F]{4}$/.test(s) ? s : 'WICK-????'; }
    var token = null;
    function beginRun() {
      token = null;
      if (!on()) return;
      ensureSession(function (ok) {
        if (!ok) return;
        fetch(cfg.url + '/rest/v1/rpc/waddleton_start_run', {
          method: 'POST', headers: hdrs(), body: JSON.stringify({ p_board: cfg.board }),
        }).then(function (r) { return r.json(); })
          .then(function (t) { if (typeof t === 'string' && t) token = t; })
          .catch(function () {});
      });
    }
    var VERDICTS = { 'bad-body': 1, 'bad-token': 1, 'too-fast': 1, 'over-rate': 1 };
    function readQ() { try { return JSON.parse(localStorage.getItem('hoardling.lbq') || '[]'); } catch (e) { return []; } }
    function writeQ(v) { try { localStorage.setItem('hoardling.lbq', JSON.stringify(v.slice(-10))); } catch (e) {} }
    var flushing = false;
    function flush(done) {
      if (!on() || flushing) { if (done) done(); return; }
      var list = readQ();
      if (!list.length) { if (done) done(); return; }
      flushing = true;
      ensureSession(function (ok) {
        if (!ok) { flushing = false; if (done) done(); return; }
        (function step(i) {
          if (i >= list.length) {
            flushing = false;
            writeQ(list.filter(function (e) { return !e._drop; }));
            if (done) done(); return;
          }
          var e = list[i];
          fetch(cfg.url + '/rest/v1/rpc/waddleton_submit_run', {
            method: 'POST', headers: hdrs(),
            body: JSON.stringify({ p_token: e.token, p_board: cfg.board, p_name: tag(), p_value: e.wave }),
          }).then(function (r) { if (!r.ok) throw new Error('http'); return r.json(); })
            .then(function (v) {
              if (v && (v.ok || VERDICTS[v.error])) e._drop = 1;   // verdicts never retry
              step(i + 1);
            })
            .catch(function () {
              e.tries = (e.tries || 0) + 1;
              if (e.tries > 6 || Date.now() - (e.ts || 0) > 36e5) e._drop = 1;
              flushing = false;
              writeQ(list.filter(function (x) { return !x._drop; }));
              if (done) done();
            });
        })(0);
      });
    }
    function finishRun(wave, kills, seed, done) {
      if (!on() || !token || wave < 1) { if (done) done(); return; }
      var list = readQ(), dup = false;
      for (var i = 0; i < list.length; i++) if (list[i].token === token) dup = true;
      if (!dup) { list.push({ token: token, wave: wave, kills: kills, seed: seed, ts: Date.now() }); writeQ(list); }
      token = null;
      flush(done);
    }
    function top(n, cb) {
      if (!on()) { cb(null); return; }
      ensureSession(function (ok) {
        if (!ok) { cb(null); return; }
        fetch(cfg.url + '/rest/v1/waddleton_scores?board=eq.' + cfg.board +
              '&select=display_name,value,updated_at&order=value.desc,updated_at.asc&limit=' + n,
              { headers: hdrs() })
          .then(function (r) { return r.json(); })
          .then(function (rows) { cb(Array.isArray(rows) ? rows : null); })
          .catch(function () { cb(null); });
      });
    }
    if (typeof window !== 'undefined') window.addEventListener('online', function () { flush(); });
    return { on: on, beginRun: beginRun, finishRun: finishRun, top: top, tag: tag, safeName: safeName, flush: flush };
  })();

  // Placeholder + preview tint per enemy (shared by the enemy drawer and the
  // next-wave preview so the icons teach the colors before the wave arrives).
  // native sprite facing: -1 = art faces LEFT (mirror when moving right).
  var ENEMY_CARDS = {
    looter:  ['SCRAPLING', 'Fodder with a loot sack. Everything works on him.'],
    scout:   ['FILCHER', 'Fast — grabs 3 coins. Chomps and chills catch him.'],
    brute:   ['BULWARK', 'Armor shrugs 5 off every hit. Flame and magic ignore it.'],
    shield:  ['SHELLBACK', 'Pavise halves bolts. Roost L3 breaks it; fire does not care.'],
    bat:     ['GLOOMWING', 'Flies over ground defenses. Bolt-thrower and Roost answer.'],
    warlock: ['GREED HEXER', 'Heals the whole pack around him. Drop him first.'],
    blinker: ['BLINKER', 'Teleports up the road. A chilled rogue cannot blink.'],
    boss:    ['THE HOARD KING', 'War drums drive his court. At half health he calls more.'],
    sapper:  ['PRY-HAND', 'Jams your machines silent. Kill him BEFORE he reaches them.'],
    splitter:['CRACKED KEG', 'Breaks into two Scraplings. Bring splash, not a sniper.'],
  };

  var ENEMY_FACING = {
    looter: -1, scout: -1, brute: -1, shield: -1,
    bat: -1, warlock: -1, blinker: -1, boss: -1, sapper: -1, splitter: -1,
  };

  var ENEMY_COLORS = {
    looter: '#6fae52', scout: '#4fc978', brute: '#4a8a3a', shield: '#9aa2ad',
    bat: '#8a6ad6', warlock: '#7b3fa0', blinker: '#d6a64f', boss: '#c9b8a8',
    sapper: '#8a7a4a', splitter: '#5f8f96',
  };

  // ===== ART registry — the seam the art pipeline fills ===================
  // Sprites land as PNG cutouts in art/. Until then every drawer has a chunky
  // procedural fallback. The fallback is LOUD in dev: missing ids are listed
  // on screen (silent fallbacks hide assets — see HANDOFF invariants).
  // walk-cycle frames (masked-inpaint legs; upper bodies identical to the
  // master plate by construction). Behind a toggle per the animation memory.
  var WALK_FRAMES = !/[?&]frames=0/.test(location.search);
  // Reduce-motion, cached and live-updating. Used to PIN the title's clock at
  // t=0 rather than delete anything: the room keeps its embers, its firelight
  // and its call-to-action ring, all frozen at their mean values. The screen
  // goes still, not dead.
  var RM = false;
  try {
    var _mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    RM = _mq.matches;
    if (_mq.addEventListener) _mq.addEventListener('change', function (e) { RM = e.matches; });
    else if (_mq.addListener) _mq.addListener(function (e) { RM = e.matches; });
  } catch (e) {}
  // Build stamp, published by build-web.py before this script runs. Art
  // filenames are stable forever, so WITHOUT this every cache in the chain
  // (proxy, WKWebView URLCache, PWA store) can serve the original bytes
  // indefinitely — the "it's all the old art" bug. New build => new URL.
  var BUILD = (typeof window !== 'undefined' && window.__BUILD__) || '';
  // tools/optimize_art.py compiles art/ down to a phone-sized WebP set at build
  // time (18.4 MB of masters -> 1.5 MB shipped) and build-web.py publishes the
  // extension here. Dev runs straight off the PNG masters, so both paths use
  // the same manifest and the same ids.
  var ART_EXT = (typeof window !== 'undefined' && window.__ART_EXT__) || '';
  function assetURL(p) {
    if (ART_EXT) p = p.replace(/\.png$/, '.' + ART_EXT);
    return BUILD ? p + '?v=' + BUILD : p;
  }
  var ANIM = { meta: {}, images: {} };
  // Walk-cycle frames are an ENHANCEMENT: without them a raider still walks,
  // it just uses the static plate. So they load AFTER the boot set rather than
  // competing with it for the connection.
  function loadWalkFrames() {
    if (!WALK_FRAMES || typeof window === 'undefined' || !window.fetch) return;
    fetch(assetURL('art/anim/meta.json')).then(function (r) { return r.ok ? r.json() : {}; }).then(function (m) {
      ANIM.meta = m || {};
      Object.keys(ANIM.meta).forEach(function (k) {
        ['a', 'b'].forEach(function (tag) {
          var img = new Image();
          img.onload = function () { ANIM.images[k + '_' + tag] = img; };
          img.src = assetURL('art/anim/' + k + '_' + tag + '.png');
        });
      });
    }).catch(function () {});
  }

  var ART = {
    manifest: {
      keep:      'art/keep.png',
      mound:     'art/gold_mound.png',
      hero:      'art/hero_whelp.png',
      hero_back: 'art/hero_back.png',
      hero_title: 'art/hero_title.png',
      t_mimic:   'art/tower_mimic.png',
      t_ballista:'art/tower_ballista.png',
      t_brazier: 'art/tower_brazier.png',
      t_crystal: 'art/tower_crystal.png',
      t_perch:   'art/tower_perch.png',
      t_bellows: 'art/tower_bellows.png',
      t_press:   'art/tower_press.png',
      // Wick painted ONTO each machine, swapped in whole while he mans it.
      t_mimic_manned:    'art/tower_mimic_manned.png',
      t_ballista_manned: 'art/tower_ballista_manned.png',
      t_brazier_manned:  'art/tower_brazier_manned.png',
      t_crystal_manned:  'art/tower_crystal_manned.png',
      t_perch_manned:    'art/tower_perch_manned.png',
      t_bellows_manned:  'art/tower_bellows_manned.png',
      t_press_manned:    'art/tower_press_manned.png',
      e_looter:  'art/enemy_looter.png',
      e_scout:   'art/enemy_scout.png',
      e_brute:   'art/enemy_brute.png',
      e_shield:  'art/enemy_shield.png',
      e_bat:     'art/enemy_bat.png',
      e_warlock: 'art/enemy_warlock.png',
      e_blinker: 'art/enemy_blinker.png',
      e_boss:    'art/enemy_boss.png',
      e_sapper:  'art/enemy_sapper.png',
      e_splitter:'art/enemy_splitter.png',
      pad:       'art/build_pad.png',
      torch:     'art/torch.png',
      bg:        'art/cavern_bg.png',
      road:      'art/road.png',
    },
    images: {}, missing: {}, ready: false,
    // onProgress(0..1) drives the splash bar; onReady(loaded, total) starts the
    // game. onReady fires EXACTLY ONCE, and it is guaranteed to fire: a dead
    // connection, a 404, or a hung CDN must still land the player on the title
    // screen. A slow load is a bad first impression; a permanent splash is a
    // broken game, and this boot chain is the only thing standing between the
    // player and a black screen.
    load: function (onProgress, onReady) {
      var self = this;
      var ids = Object.keys(this.manifest);
      var total = ids.length, done = 0, fired = false;
      function finish() {
        if (fired) return;
        fired = true;
        self.ready = true;
        var loaded = 0;
        for (var i = 0; i < ids.length; i++) if (self.images[ids[i]]) loaded++;
        if (onReady) onReady(loaded, total);
      }
      function tick() {
        done++;
        if (onProgress) onProgress(done / total);
        if (done >= total) finish();
      }
      // The escape hatch. 12s is well past a cold 1.5 MB load on 3G.
      var bail = setTimeout(finish, 12000);
      ids.forEach(function (id) {
        var img = new Image();
        img.onload = function () {
          self.images[id] = img;
          delete self.missing[id];
          // Warm the decode so the first drawImage cannot stall a frame — but
          // NEVER WAIT ON IT. In an embedded WebView, decode() on an image
          // that is not in the document can stay pending forever: measured
          // here, onload fired at 7ms and the decode promise had still not
          // settled 3s later on a fully-loaded 519px PNG. Counting the asset
          // on that promise hung the whole boot behind the 12s bail and put
          // the player on a splash that looked broken.
          if (img.decode) { try { img.decode().catch(function () {}); } catch (e) {} }
          tick();
        };
        img.onerror = function () { self.missing[id] = 1; tick(); };
        img.src = assetURL(self.manifest[id]);
      });
      if (!total) { clearTimeout(bail); finish(); }
    },
  };

  // ===== Input — tap queue (consumed inside the fixed-step sim) ===========
  // Taps are converted to WORLD coordinates at CAPTURE time, with the view
  // that was live at that instant — so the sim's inputs are device- and
  // resize-independent, and a replay log of world-space taps is portable.
  var Input = (function () {
    var taps = [];
    var convert = null;                       // installed by Game
    window.addEventListener('pointerdown', function (e) {
      Sfx.unlock();
      if (convert) taps.push(convert(e.clientX, e.clientY));
    });
    return {
      setConverter: function (fn) { convert = fn; },
      inject: function (wx, wy, vx, vy) { taps.push({ x: wx, y: wy, vx: vx, vy: vy }); },
      drain: function () { var t = taps; taps = []; return t; },
    };
  })();

  // ===== R3D — the low-poly 3D renderer (?r3d=1) ==========================
  // The sim never knew it was 2D: update() emits state, a renderer draws it.
  // This module is a SECOND renderer — three.js, low-poly primitives in the
  // Kingshot-ad style VANUS chose — under the existing 2D canvas, which goes
  // transparent and keeps drawing ONLY the HUD/menus/screens on top.
  // Contract: R3D reads sim state, never writes it, never touches the seeded
  // stream. Taps are raycast to the ground so the SAME input logic runs.
  var R3D = {
    // OPT-IN PREVIEW — ?r3d=1. The painted 2D renderer is the default again.
    // 3D shipped as the default for one build; VANUS's verdict on the phone was
    // "maybe more 3-D but very basic, needs a ton of work" — the geometry is
    // real but it is competing with finished painted art, and losing. It stays
    // live behind the flag so the work is not lost and can be judged again once
    // its art matures.
    on: /[?&]r3d=1/.test(location.search),
    ready: false, T: null, scene: null, cam: null, gl: null,
    pools: { tower: {}, enemy: {}, proj: {}, tar: {} },
    hero: null, sceneLevel: -1,
    _v: null, _mats: null,
    boot: function (game) {
      if (!this.on || this.ready || this._loading) return;
      this._loading = true;
      var self = this;
      import('./proto3d/three.module.js').then(function (T) {
        self.T = T;
        var gl = new T.WebGLRenderer({ antialias: true });
        gl.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
        gl.shadowMap.enabled = true;
        gl.shadowMap.type = T.PCFSoftShadowMap;
        gl.domElement.style.cssText = 'position:absolute;inset:0;z-index:0;';
        var wrap = document.getElementById('game-wrap');
        wrap.insertBefore(gl.domElement, wrap.firstChild);
        game.canvas.style.position = 'relative';
        game.canvas.style.zIndex = '1';
        self.gl = gl;
        var scene = new T.Scene();
        scene.background = new T.Color(0x2c1e14);
        scene.fog = new T.Fog(0x2c1e14, 1150, 2400);   // beyond the keep, not before it
        self.scene = scene;
        self.cam = new T.PerspectiveCamera(44, 1, 1, 2600);
        var key = new T.DirectionalLight(0xffdfb0, 3.0);
        key.position.set(-260, 420, 120);            // the measured upper-left law
        key.castShadow = true;
        key.shadow.mapSize.set(2048, 2048);
        key.shadow.camera.left = -420; key.shadow.camera.right = 420;
        key.shadow.camera.top = 520; key.shadow.camera.bottom = -520;
        key.shadow.camera.near = 10; key.shadow.camera.far = 1400;
        scene.add(key);
        scene.add(new T.HemisphereLight(0x8a9cc8, 0x5a4530, 1.6));
        var M = function (c, r) { return new T.MeshStandardMaterial({ color: c, roughness: r === undefined ? 0.95 : r, flatShading: true }); };
        self._mats = {
          floor: M(0x6a5344), road: M(0x93826e), roadEdge: M(0x3a2d24),
          rock: M(0x54402f), wood: M(0x9c6532), wood2: M(0xc08448),
          stone: M(0x9a8f80), stoneD: M(0x6e6458), iron: M(0x8d94a0, 0.5),
          brass: M(0xe0aa3e, 0.3), gold: M(0xf0b429, 0.4), red: M(0xc0392b),
          dragon: M(0xe85535), belly: M(0xf0cc84), teal: M(0x4fc3d0, 0.5),
          roofBlue: M(0x3f6fc0), flame: new T.MeshBasicMaterial({ color: 0xff9a3c }),
          tar: M(0x1a120c, 0.99), purple: M(0x7b3fa0), pale: M(0xd8cdb8),
          green: M(0x6a8a4a), skin: M(0xe8c8a0),
        };
        self.ready = true; self._loading = false;
        self.resize(game);
      }).catch(function (e) { console.error('r3d boot failed', e); self.on = false; });
    },
    W: function (wx, wy, h) { return new this.T.Vector3(wx - 210, h || 0, wy - 390); },
    resize: function (game) {
      if (!this.ready) return;
      var v = game.view;
      this.gl.setSize(v.cw, v.ch, false);
      this.gl.domElement.style.width = v.cw + 'px';
      this.gl.domElement.style.height = v.ch + 'px';
      this.cam.aspect = v.cw / v.ch;
      // Frame the whole world in portrait with a documentary tilt: camera
      // beyond the cave mouth, looking up the road toward the keep.
      // frame the world into the band between the HUD and the shop bar:
      // centre on the mid-road so the cave mouth clears the bottom UI
      this._camBase = { x: 0, y: 780, z: 930 };
      this.cam.position.set(this._camBase.x, this._camBase.y, this._camBase.z);
      this.cam.lookAt(0, -10, -60);
      this.cam.updateProjectionMatrix();
      this._v = v;
    },
    // world(x,y) -> the 2D overlay's world coords, so menus/floats/hp bars on
    // the 2D canvas land exactly over the 3D object they belong to.
    remap: function (wx, wy, h) {
      if (!this.ready) return { x: wx, y: wy };
      var v = this._v;
      var p = this.W(wx, wy, h || 0).project(this.cam);
      var cssX = (p.x * 0.5 + 0.5) * v.cw, cssY = (-p.y * 0.5 + 0.5) * v.ch;
      return { x: cssX / v.scale - v.ox, y: cssY / v.scale - v.oy };
    },
    // view tap -> world coords via ground-plane raycast (the input contract)
    pick: function (vx, vy, game) {
      if (!this.ready) return null;
      var v = this._v;
      var ndc = new this.T.Vector2((vx * v.scale) / v.cw * 2 - 1, -((vy * v.scale) / v.ch * 2 - 1));
      var ray = new this.T.Raycaster();
      ray.setFromCamera(ndc, this.cam);
      // TALL OBJECTS FIRST. A ground-plane-only pick resolves a tap on a
      // machine's BODY 40-200 units up-road (offset = h/(camH-h) * distance),
      // so tapping a manned machine walked Wick off it instead of opening its
      // menu. Hit the real meshes, then fall back to the floor.
      if (game && game.towers) {
        var objs = [];
        for (var pid in this.pools.tower) objs.push(this.pools.tower[pid]);
        if (objs.length) {
          var hits = ray.intersectObjects(objs, true);
          if (hits.length) {
            var node = hits[0].object;
            while (node && objs.indexOf(node) === -1) node = node.parent;
            if (node) {
              for (var ti2 = 0; ti2 < game.towers.length; ti2++) {
                if (this.pools.tower['w' + game.towers[ti2].tid] === node) {
                  return { x: game.towers[ti2].x, y: game.towers[ti2].y };
                }
              }
            }
          }
        }
      }
      var t = -ray.ray.origin.y / ray.ray.direction.y;
      if (!(t > 0)) return null;
      var hit = ray.ray.origin.clone().addScaledVector(ray.ray.direction, t);
      return { x: hit.x + 210, y: hit.z + 390 };
    },
    buildWorld: function (game) {
      if (!this.ready || this.sceneLevel === game.levelIdx) return;
      var T = this.T, m = this._mats, scene = this.scene, self = this;
      if (this._worldGroup) scene.remove(this._worldGroup);
      for (var k in this.pools) {
        for (var id in this.pools[k]) scene.remove(this.pools[k][id]);
        this.pools[k] = {};
      }
      if (this.hero) { scene.remove(this.hero); this.hero = null; }
      var g = new T.Group(); this._worldGroup = g;
      var floor = new T.Mesh(new T.PlaneGeometry(1500, 1500), m.floor);
      floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; g.add(floor);
      // the road: a flat ribbon sampled off the real path (same arc length
      // the sim marches, so what you see IS where they walk)
      var half = MAP.pathW * 0.62, pts = [], up = [], dn = [];
      for (var d = 0; d <= PATH.len; d += 10) {
        var a = pathPointAt(d), b = pathPointAt(Math.min(PATH.len, d + 10));
        var dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
        var nx = -dy / L * half, ny = dx / L * half;
        up.push([a.x + nx, a.y + ny]); dn.push([a.x - nx, a.y - ny]);
      }
      var verts = [], road = new T.BufferGeometry();
      for (var i = 0; i < up.length - 1; i++) {
        var A = this.W(up[i][0], up[i][1], 0.6), B = this.W(dn[i][0], dn[i][1], 0.6),
            C = this.W(up[i + 1][0], up[i + 1][1], 0.6), D = this.W(dn[i + 1][0], dn[i + 1][1], 0.6);
        verts.push(A.x, A.y, A.z, B.x, B.y, B.z, C.x, C.y, C.z,
                   B.x, B.y, B.z, D.x, D.y, D.z, C.x, C.y, C.z);
      }
      road.setAttribute('position', new T.Float32BufferAttribute(verts, 3));
      road.computeVertexNormals();
      m.road.side = T.DoubleSide;
      var roadMesh = new T.Mesh(road, m.road);
      roadMesh.receiveShadow = true; g.add(roadMesh);
      // THE KEEP — the painted one is a battlemented castle with a dragon
      // crest, lit windows and torches at the door. The first 3D pass was a
      // box with three cones, and it sits in the top third of every frame, so
      // it did more damage to the "unfinished" read than anything else.
      var keep = new T.Group();
      var body = new T.Mesh(new T.BoxGeometry(120, 84, 92), m.stone);
      body.position.y = 42; body.castShadow = body.receiveShadow = true; keep.add(body);
      // battlements: alternating merlons along the front and sides
      for (var mr = 0; mr < 7; mr++) {
        var me = new T.Mesh(new T.BoxGeometry(11, 12, 11), m.stoneD);
        me.position.set(-54 + mr * 18, 90, 40); me.castShadow = true; keep.add(me);
        var me2 = new T.Mesh(new T.BoxGeometry(11, 12, 11), m.stoneD);
        me2.position.set(-54 + mr * 18, 90, -40); keep.add(me2);
      }
      // a course line to break the flat wall + lit windows
      var course = new T.Mesh(new T.BoxGeometry(122, 5, 94), m.stoneD);
      course.position.y = 56; keep.add(course);
      for (var wn = -1; wn <= 1; wn += 2) {
        var win = new T.Mesh(new T.BoxGeometry(11, 17, 3), m.flame);
        win.position.set(wn * 30, 64, 47); keep.add(win);
      }
      for (var t2 = 0; t2 < 2; t2++) {
        var sx2 = t2 ? 62 : -62;
        var tw2 = new T.Mesh(new T.CylinderGeometry(21, 25, 118, 9), m.stone);
        tw2.position.set(sx2, 59, 8); tw2.castShadow = true; keep.add(tw2);
        var ring2 = new T.Mesh(new T.CylinderGeometry(27, 27, 7, 9), m.stoneD);
        ring2.position.set(sx2, 116, 8); ring2.castShadow = true; keep.add(ring2);
        var cap = new T.Mesh(new T.ConeGeometry(29, 44, 9), m.roofBlue);
        cap.position.set(sx2, 142, 8); cap.castShadow = true; keep.add(cap);
        var fin = new T.Mesh(new T.SphereGeometry(4, 6, 5), m.gold);
        fin.position.set(sx2, 166, 8); keep.add(fin);
        var twin = new T.Mesh(new T.BoxGeometry(7, 12, 3), m.flame);
        twin.position.set(sx2, 78, 33); keep.add(twin);
      }
      var mainRing = new T.Mesh(new T.CylinderGeometry(50, 50, 8, 10), m.stoneD);
      mainRing.position.y = 96; mainRing.castShadow = true; keep.add(mainRing);
      var mainCap = new T.Mesh(new T.ConeGeometry(48, 62, 10), m.roofBlue);
      mainCap.position.y = 130; mainCap.castShadow = true; keep.add(mainCap);
      var spire = new T.Mesh(new T.CylinderGeometry(1.6, 1.6, 26, 5), m.brass);
      spire.position.y = 172; keep.add(spire);
      var flag = new T.Mesh(new T.BoxGeometry(26, 12, 1), m.red);
      flag.position.set(13, 180, 0); keep.add(flag);
      this._flag = flag;
      // the arched door with its dragon crest, and a torch either side
      var arch = new T.Mesh(new T.CylinderGeometry(19, 19, 7, 10, 1, false, 0, Math.PI), m.stoneD);
      arch.position.set(0, 44, 47); arch.rotation.x = Math.PI / 2; keep.add(arch);
      var door = new T.Mesh(new T.BoxGeometry(34, 44, 6), m.wood);
      door.position.set(0, 22, 47); keep.add(door);
      for (var bb = -1; bb <= 1; bb += 2) {
        var bandD = new T.Mesh(new T.BoxGeometry(36, 4, 7), m.brass);
        bandD.position.set(0, 22 + bb * 13, 47.4); keep.add(bandD);
        var kt = new T.Mesh(new T.SphereGeometry(4.4, 6, 5), m.flame);
        kt.position.set(bb * 30, 40, 50); keep.add(kt);
        var ktp = new T.PointLight(0xff9a3c, 2.2, 130, 1.8);
        ktp.position.set(bb * 30, 40, 56); keep.add(ktp);
      }
      var crest = new T.Mesh(new T.OctahedronGeometry(9, 0), m.gold);
      crest.position.set(0, 52, 49); keep.add(crest);
      var kp = this.W(MAP.keep.x, MAP.keep.y); keep.position.set(kp.x, 0, kp.z - 26);
      g.add(keep); this._keep = keep;
      var mound = new T.Group();
      for (var c2 = 0; c2 < 130; c2++) {
        var coin = new T.Mesh(new T.CylinderGeometry(6.5, 6.5, 2, 7), m.gold);
        var ang = Math.random() * 6.283, rr2 = Math.random();
        var rad = rr2 * rr2 * 95;
        coin.position.set(Math.cos(ang) * rad * 1.15, 1 + (1 - rr2) * 26 + Math.random() * 6, Math.sin(ang) * rad * 0.8);
        coin.rotation.set(Math.random() * 0.5, Math.random() * 3, Math.random() * 0.5);
        coin.castShadow = coin.receiveShadow = true;
        mound.add(coin);
      }
      mound.position.set(kp.x, 0, kp.z + 30); g.add(mound); this._mound = mound;
      // torches: emissive flames + a few real point lights (phones can carry ~6)
      this._flames = [];
      for (var ti = 0; ti < MAP.torches.length; ti++) {
        var tp = this.W(MAP.torches[ti][0], MAP.torches[ti][1]);
        var post = new T.Mesh(new T.CylinderGeometry(3, 4, 42, 6), m.wood);
        post.position.set(tp.x, 21, tp.z); post.castShadow = true; g.add(post);
        var fl = new T.Mesh(new T.ConeGeometry(7, 16, 6), m.flame);
        fl.position.set(tp.x, 50, tp.z); g.add(fl); this._flames.push(fl);
        var pl = new T.PointLight(0xff9a3c, 3.2, 190, 1.6);
        pl.position.set(tp.x, 46, tp.z); g.add(pl);
      }
      // authored pads: stone discs (the discount ground you can see)
      for (var pi = 0; pi < MAP.pads.length; pi++) {
        var pp = this.W(MAP.pads[pi].x, MAP.pads[pi].y);
        var disc = new T.Mesh(new T.CylinderGeometry(30, 33, 5, 9), m.stoneD);
        disc.position.set(pp.x, 2.5, pp.z); disc.receiveShadow = true; g.add(disc);
      }
      // cavern dressing: rocks OUTSIDE the play rect (x beyond ±230 or z
      // beyond the ends), never on the floor the raiders walk
      for (var ri = 0; ri < 34; ri++) {
        var ra = ri / 34 * 6.283, rr3 = 395 + Math.sin(ri * 2.7) * 55;
        var rx = Math.cos(ra) * rr3, rz = Math.sin(ra) * rr3 * 1.15 - 40;
        if (Math.abs(rx) < 250 && rz > -420 && rz < 430) rx = (rx < 0 ? -1 : 1) * (250 + Math.random() * 60);
        var rk = new T.Mesh(new T.DodecahedronGeometry(38 + Math.sin(ri * 1.3) * 16, 0), m.rock);
        rk.position.set(rx, 20, rz);
        rk.rotation.set(Math.sin(ri), ri, 0.3);
        rk.castShadow = true; g.add(rk);
      }
      // the cavern BACK WALL: fills the void above the keep with scenery
      for (var bw = 0; bw < 14; bw++) {
        var bx = -420 + bw * 65 + Math.sin(bw * 3.1) * 22;
        var col = new T.Mesh(new T.CylinderGeometry(34 + Math.sin(bw * 1.7) * 12, 46, 320 + Math.sin(bw * 2.3) * 70, 6), m.rock);
        col.position.set(bx, 130, -520 - Math.abs(Math.sin(bw * 1.3)) * 90);
        col.rotation.y = bw;
        g.add(col);
      }
      scene.add(g);
      this.sceneLevel = game.levelIdx;
    },
    machine: function (type) {
      // The painted machines are WOOD + BRASS contraptions with rivets, crews
      // and working parts. The first 3D pass was a stone disc with a box on
      // top — which is why they read as placeholders. Each rig now carries the
      // three things that say "built": a PLANKED base with brass banding, a
      // visible MECHANISM (crank, wheel, coil, bellows), and a warm lamp.
      var T = this.T, m = this._mats, g = new T.Group();
      var deck = new T.Mesh(new T.CylinderGeometry(25, 29, 7, 9), m.wood);
      deck.position.y = 3.5; deck.castShadow = deck.receiveShadow = true; g.add(deck);
      var band = new T.Mesh(new T.TorusGeometry(26, 1.8, 5, 12), m.brass);
      band.position.y = 6.4; band.rotation.x = Math.PI / 2; g.add(band);
      for (var rv = 0; rv < 6; rv++) {                    // rivets catch the key light
        var a4 = rv / 6 * 6.283;
        var riv = new T.Mesh(new T.SphereGeometry(1.5, 5, 4), m.brass);
        riv.position.set(Math.cos(a4) * 24, 6.5, Math.sin(a4) * 24); g.add(riv);
      }
      var lamp = new T.Mesh(new T.SphereGeometry(3.4, 6, 5), m.flame);
      lamp.position.set(20, 13, 14); g.add(lamp);
      g.scale.set(1.15, 1.15, 1.15);
      var add = function (mesh, x, y, z) { mesh.position.set(x || 0, y || 0, z || 0); mesh.castShadow = true; g.add(mesh); return mesh; };
      if (type === 'ballista') {
        add(new T.Mesh(new T.CylinderGeometry(11, 13, 15, 8), m.wood2), 0, 14);
        var head = new T.Group(); head.position.y = 27; g.add(head);
        var bow = new T.Mesh(new T.BoxGeometry(48, 3.4, 3.4), m.wood2); bow.castShadow = true; head.add(bow);
        var arms = new T.Mesh(new T.BoxGeometry(44, 1.2, 1.2), m.iron); arms.position.z = -3; head.add(arms);
        var stock = new T.Mesh(new T.BoxGeometry(5, 4, 30), m.wood); stock.position.z = 5; stock.castShadow = true; head.add(stock);
        var wheel = new T.Mesh(new T.TorusGeometry(6, 1.4, 5, 10), m.brass);
        wheel.position.set(9, -3, -6); head.add(wheel);
        var kob = new T.Mesh(new T.CapsuleGeometry(3.4, 5, 3, 6), m.green);
        kob.position.set(-9, -2, -8); kob.castShadow = true; head.add(kob);
        g.userData.head = head; g.userData.wheel = wheel;
      } else if (type === 'mimic') {
        var chest = add(new T.Mesh(new T.BoxGeometry(34, 20, 26), m.wood2), 0, 17);
        for (var bnd = -1; bnd <= 1; bnd += 2) {
          add(new T.Mesh(new T.BoxGeometry(3, 22, 27), m.brass), bnd * 12, 17, 0);
        }
        var lid = new T.Mesh(new T.BoxGeometry(34, 7, 26), m.wood);
        lid.position.set(0, 31, -8); lid.rotation.x = -0.75; lid.castShadow = true; g.add(lid);
        for (var th = 0; th < 5; th++) add(new T.Mesh(new T.ConeGeometry(2.4, 6, 4), m.pale), -12 + th * 6, 28, 11);
        add(new T.Mesh(new T.SphereGeometry(6, 8, 6), m.gold), 0, 23, 3);
        g.userData.lid = lid;
      } else if (type === 'brazier') {
        add(new T.Mesh(new T.SphereGeometry(17, 10, 8), m.iron), 0, 22);
        add(new T.Mesh(new T.TorusGeometry(13, 1.6, 5, 10), m.brass), 0, 22).rotation.x = Math.PI / 2;
        var flue = add(new T.Mesh(new T.CylinderGeometry(4, 5, 18, 6), m.brass), 11, 40);
        flue.rotation.z = -0.22;
        var glow = add(new T.Mesh(new T.SphereGeometry(8, 8, 6), m.flame), 0, 22, 13);
        glow.scale.z = 0.45;
        g.userData.glow = glow;
      } else if (type === 'crystal') {
        for (var cr = 0; cr < 5; cr++) {
          var ring = add(new T.Mesh(new T.TorusGeometry(9 - cr * 1.2, 1.6, 5, 10), m.brass), 0, 14 + cr * 8);
          ring.rotation.x = Math.PI / 2;
        }
        add(new T.Mesh(new T.CylinderGeometry(2, 2, 44, 6), m.iron), 0, 32);
        var gem = add(new T.Mesh(new T.OctahedronGeometry(11, 0), m.teal), 0, 60);
        g.userData.gem = gem;
      } else if (type === 'perch') {
        add(new T.Mesh(new T.CylinderGeometry(8, 12, 42, 7), m.stone), 0, 28);
        add(new T.Mesh(new T.TorusGeometry(9, 1.5, 5, 10), m.brass), 0, 46).rotation.x = Math.PI / 2;
        var gar = new T.Group(); gar.position.y = 56; g.add(gar);
        var bod = new T.Mesh(new T.SphereGeometry(10, 9, 7), m.stoneD); bod.castShadow = true; gar.add(bod);
        var gh = new T.Mesh(new T.SphereGeometry(5.5, 8, 6), m.stoneD); gh.position.set(0, 8, 4); gar.add(gh);
        for (var s2 = -1; s2 <= 1; s2 += 2) {
          var wing = new T.Mesh(new T.BoxGeometry(2.6, 13, 17), m.brass);
          wing.position.set(s2 * 11, 5, -2); wing.rotation.z = s2 * 0.55; wing.castShadow = true; gar.add(wing);
        }
        g.userData.head = gar;
      } else if (type === 'bellows') {
        var frame = add(new T.Mesh(new T.BoxGeometry(6, 30, 6), m.wood2), -8, 20);
        var fan = add(new T.Mesh(new T.CylinderGeometry(17, 17, 7, 12, 1, false, 0, 3.14), m.wood2), 2, 30);
        fan.rotation.z = Math.PI / 2; fan.rotation.y = Math.PI / 2;
        var horn = add(new T.Mesh(new T.ConeGeometry(8, 16, 8), m.brass), 6, 48);
        horn.rotation.x = -0.55;
        add(new T.Mesh(new T.TorusGeometry(5, 1.3, 5, 9), m.brass), -8, 34).rotation.y = 0.4;
        g.userData.fan = fan;
      } else if (type === 'press') {
        add(new T.Mesh(new T.BoxGeometry(24, 9, 24), m.iron), 0, 12);
        for (var pl = -1; pl <= 1; pl += 2) add(new T.Mesh(new T.CylinderGeometry(2, 2, 34, 6), m.brass), pl * 9, 30);
        add(new T.Mesh(new T.CylinderGeometry(3.4, 3.4, 30, 8), m.brass), 0, 32);
        var star = add(new T.Mesh(new T.BoxGeometry(26, 3.4, 4.4), m.brass), 0, 48);
        add(new T.Mesh(new T.BoxGeometry(4.4, 3.4, 26), m.brass), 0, 48);
        add(new T.Mesh(new T.CylinderGeometry(8, 8, 2.4, 9), m.gold), 0, 18);
        add(new T.Mesh(new T.BoxGeometry(11, 7, 11), m.wood), -15, 16, 8);
        g.userData.screw = star;
      }
      return g;
    },
    // Shared rig geometry — built once, reused by every raider. A capsule is
    // not a person: readability at ~30px needs a WAIST (torso over hips), a
    // SHOULDER LINE (pauldrons widen where the eye lands), SWINGING limbs, and
    // a held object to break the outline. Proven in proto3d before porting.
    rigGeo: function () {
      var T = this.T;
      return this._rg || (this._rg = {
        torso: new T.BoxGeometry(9.2, 10.5, 6.2), hips: new T.BoxGeometry(7.8, 3.4, 5.6),
        leg: new T.BoxGeometry(3.0, 8.6, 3.2), boot: new T.BoxGeometry(3.6, 2.2, 4.6),
        arm: new T.BoxGeometry(2.6, 7.8, 2.8), pauld: new T.BoxGeometry(3.4, 3.0, 5.0),
        head: new T.SphereGeometry(4.2, 9, 7), helm: new T.CylinderGeometry(4.4, 4.6, 3.0, 8),
        brim: new T.CylinderGeometry(6.0, 6.0, 0.7, 9), plume: new T.ConeGeometry(1.3, 5, 5),
        sack: new T.SphereGeometry(4.2, 7, 6), hilt: new T.BoxGeometry(0.9, 6.2, 0.9),
        blade: new T.BoxGeometry(1.5, 9.5, 0.5), pav: new T.BoxGeometry(1.6, 15, 11),
        staff: new T.CylinderGeometry(0.8, 0.8, 26, 5), orb: new T.SphereGeometry(3.2, 7, 6),
        club: new T.CylinderGeometry(2.2, 3.8, 18, 6), wing: new T.BoxGeometry(1.4, 9, 14),
        crown: new T.CylinderGeometry(5.2, 5.6, 3.2, 6),
      });
    },
    raiderRig: function (type) {
      var T = this.T, m = this._mats, G = this.rigGeo(), g = new T.Group();
      var big = type === 'boss' ? 1.55 : type === 'brute' ? 1.22 : 1;
      var cloth = type === 'warlock' ? m.purple : type === 'blinker' ? m.brass :
                  type === 'bat' ? m.purple : type === 'shield' ? m.iron : m.red;
      var leather = m.wood, steel = m.iron;
      var put = function (geo, mm, x, y, z) {
        var o = new T.Mesh(geo, mm); o.position.set(x, y, z); o.castShadow = true; g.add(o); return o;
      };
      put(G.hips, leather, 0, 9.8, 0);
      var legL = put(G.leg, leather, -2.2, 5.5, 0), legR = put(G.leg, leather, 2.2, 5.5, 0);
      put(G.boot, m.stoneD, -2.2, 1.3, 0.6); put(G.boot, m.stoneD, 2.2, 1.3, 0.6);
      put(G.torso, cloth, 0, 19.2, 0);
      put(G.pauld, steel, -6.0, 22.4, 0); put(G.pauld, steel, 6.0, 22.4, 0);
      var armL = put(G.arm, cloth, -6.0, 18.2, 0.4), armR = put(G.arm, cloth, 6.0, 18.2, 0.4);
      put(G.head, m.skin, 0, 27.2, 0.2);
      if (type === 'boss') put(G.crown, m.gold, 0, 30.4, 0);
      else if (type === 'warlock') put(G.plume, m.purple, 0, 31, 0);
      else { put(G.helm, steel, 0, 29.2, 0); put(G.brim, steel, 0, 28.0, 0); }
      // per-type weapon: the outline break that says WHICH raider this is
      if (type === 'brute' || type === 'boss') {
        var club = put(G.club, m.wood, 8.5, 20, 1); club.rotation.z = 0.5;
      } else if (type === 'warlock') {
        put(G.staff, m.wood, 7.5, 17, 1); put(G.orb, m.teal, 7.5, 31, 1);
      } else if (type === 'shield') {
        put(G.pav, m.pale, -7.5, 17, 1);
        var sw2 = put(G.blade, steel, 7.4, 22, 1); sw2.rotation.z = -0.35;
      } else if (type === 'bat') {
        for (var w3 = -1; w3 <= 1; w3 += 2) {
          var wg = put(G.wing, m.purple, w3 * 8, 22, -1); wg.rotation.z = w3 * 0.4;
          g.userData['wing' + w3] = wg;
        }
      } else {
        put(G.hilt, m.wood, 7.2, 19, 1.2);
        var bl = put(G.blade, steel, 7.2, 26, 1.2); bl.rotation.z = -0.12;
      }
      var sack = put(G.sack, m.wood2, -1.2, 21.6, -4.6);
      sack.scale.set(1, 0.86, 0.9); sack.visible = false;
      g.userData.sack = sack;
      g.userData.legL = legL; g.userData.legR = legR;
      g.userData.armL = armL; g.userData.armR = armR;
      g.scale.set(big, big, big);
      return g;
    },
    heroRig: function () {
      var T = this.T, m = this._mats, g = new T.Group();
      g.scale.set(1.18, 1.18, 1.18);
      var body = new T.Mesh(new T.CapsuleGeometry(9, 12, 4, 8), m.dragon);
      body.position.y = 15; body.rotation.x = 0.2; body.castShadow = true; g.add(body);
      var bel = new T.Mesh(new T.CapsuleGeometry(6.4, 8, 3, 7), m.belly);
      bel.position.set(0, 13.5, 4); bel.rotation.x = 0.2; g.add(bel);
      var head = new T.Mesh(new T.SphereGeometry(7.6, 9, 7), m.dragon);
      head.position.set(0, 28, 4); head.castShadow = true; g.add(head);
      g.userData.head = head;
      var snout = new T.Mesh(new T.BoxGeometry(6.4, 5, 8), m.dragon);
      snout.position.set(0, 26.5, 11); g.add(snout);
      g.userData.snout = snout;
      var jaw = new T.Mesh(new T.BoxGeometry(5.6, 2.2, 6.4), m.belly);
      jaw.position.set(0, 24.2, 10.4); g.add(jaw);
      g.userData.jaw = jaw;
      for (var s = -1; s <= 1; s += 2) {
        var horn = new T.Mesh(new T.ConeGeometry(1.8, 6.6, 5), m.belly);
        horn.position.set(3.7 * s, 34, 1.6); horn.rotation.z = 0.3 * s; g.add(horn);
        var wing = new T.Mesh(new T.BoxGeometry(1.2, 13, 18), m.dragon);
        wing.position.set(9.4 * s, 19, -3); wing.rotation.z = 0.45 * s;
        wing.castShadow = true; g.add(wing);
        g.userData['wing' + s] = wing;
      }
      var tail = new T.Mesh(new T.ConeGeometry(4.8, 22, 6), m.dragon);
      tail.position.set(0, 11, -14.5); tail.rotation.x = 1.35; tail.castShadow = true; g.add(tail);
      return g;
    },
    fx: [],
    event: function (fx) {
      // cosmetic-lane 3D effects fed off the SAME event stream the 2D
      // renderer spends. Math.random only — never the seeded stream.
      var T = this.T; if (!T) return;
      var mk = this._mkFx || (this._mkFx = { bursts: [], rings: [] });
      if (fx.k === 'boom' || fx.k === 'death' || fx.k === 'recover' || fx.k === 'blink' || fx.k === 'steal' || fx.k === 'fireburst') {
        var col = fx.k === 'recover' || fx.k === 'steal' ? 0xf0b429 :
                  fx.k === 'blink' ? 0xb39dff : fx.k === 'death' ? 0xc0392b : 0xff9a3c;
        this.fx.push({ kind: 'burst', x: fx.x, y: fx.y, t: 0, col: col,
                       n: fx.k === 'boom' ? 10 : 7, group: null });
      } else if (fx.k === 'breath') {
        this.fx.push({ kind: 'ring', x: fx.x, y: fx.y, t: 0, col: 0xff9a3c, R: 80, group: null });
      } else if (fx.k === 'pulse') {
        this.fx.push({ kind: 'ring', x: fx.x, y: fx.y, t: 0, col: 0x4fc3d0, R: fx.r || 90, group: null });
      }
      if (this.fx.length > 24) this.fx.splice(0, this.fx.length - 24);
    },
    _fxTick: function (dt) {
      var T = this.T, scene = this.scene;
      for (var i = this.fx.length - 1; i >= 0; i--) {
        var f = this.fx[i];
        f.t += dt;
        var life = f.kind === 'ring' ? 0.5 : 0.55;
        if (f.t >= life) {
          if (f.group) scene.remove(f.group);
          if (f.mat) f.mat.dispose();
          this.fx.splice(i, 1); continue;
        }
        if (!f.group) {
          var g = new T.Group();
          var P = this.W(f.x, f.y);
          g.position.set(P.x, 6, P.z);
          // SHARED geometries (never disposed), ONE cloneable material per
          // event (disposed on retire) — hundreds of fx events per run must
          // not each mint geometry, or GPU memory grows for the whole run
          var FG = this._fxGeo || (this._fxGeo = {
            cube: new T.BoxGeometry(4, 4, 4),
            ring: new T.RingGeometry(6, 10, 24),
          });
          if (f.kind === 'burst') {
            var mat2 = new T.MeshBasicMaterial({ color: f.col, transparent: true });
            f.mat = mat2;
            for (var b2 = 0; b2 < f.n; b2++) {
              var cube = new T.Mesh(FG.cube, mat2);
              var a3 = Math.random() * 6.283, sp = 40 + Math.random() * 90;
              cube.userData.v = { x: Math.cos(a3) * sp, y: 60 + Math.random() * 70, z: Math.sin(a3) * sp };
              g.add(cube);
            }
          } else {
            var rmat = new T.MeshBasicMaterial({ color: f.col, transparent: true, side: T.DoubleSide });
            f.mat = rmat;
            var ring = new T.Mesh(FG.ring, rmat);
            ring.rotation.x = -Math.PI / 2; g.add(ring);
          }
          scene.add(g); f.group = g;
        }
        var k2 = f.t / life;
        if (f.kind === 'burst') {
          for (var c4 = 0; c4 < f.group.children.length; c4++) {
            var cu = f.group.children[c4], v2 = cu.userData.v;
            cu.position.set(v2.x * f.t, v2.y * f.t - 160 * f.t * f.t, v2.z * f.t);
            cu.rotation.x += dt * 9; cu.rotation.y += dt * 7;
            cu.material.opacity = 1 - k2;
          }
        } else {
          var sc = 1 + k2 * (f.R / 8);
          f.group.children[0].scale.set(sc, sc, 1);
          f.group.children[0].material.opacity = 0.9 * (1 - k2);
        }
      }
    },
    sync: function (game, alpha) {
      if (!this.ready) { this.boot(game); return; }
      var T = this.T, m = this._mats, scene = this.scene, self = this;
      this.buildWorld(game);
      var now = game.worldT;
      var seen = { tower: {}, enemy: {}, proj: {}, tar: {} };
      // machines
      for (var i = 0; i < game.towers.length; i++) {
        var tw = game.towers[i], id = 'w' + tw.tid;
        var o = this.pools.tower[id];
        if (!o) { o = this.machine(tw.type); scene.add(o); this.pools.tower[id] = o; o.userData.type = tw.type; }
        var P = this.W(tw.x, tw.y);
        o.position.set(P.x, 0, P.z);
        var lvS = 1 + tw.level * 0.09;
        o.scale.set(lvS, lvS, lvS);
        var st = tw.shotT === undefined ? 9 : tw.shotT;
        var kick = st < 0.34 ? Math.pow(1 - st / 0.34, 2) : 0;
        o.scale.y = lvS * (1 - kick * 0.1);
        if (o.userData.head) {
          var tgt = game._r3dAim && game._r3dAim[tw.tid];
          if (tgt) o.userData.head.rotation.y = Math.atan2(tgt.x - tw.x, tgt.y - tw.y) + Math.PI;
        }
        if (o.userData.gem) o.userData.gem.rotation.y = now * 1.5;
        if (o.userData.wheel) o.userData.wheel.rotation.z = -st * 7;   // crank winds back
        if (o.userData.glow) {
          var gk = st < 0.4 ? 1 - st / 0.4 : 0;
          o.userData.glow.scale.set(1 + gk * 0.5, 1 + gk * 0.5, 0.4 + gk * 0.3);
        }
        if (o.userData.screw) o.userData.screw.rotation.y = now * 0.8;
        if (o.userData.fan) o.userData.fan.rotation.x = Math.sin(now * 3) * 0.25;
        seen.tower[id] = 1;
      }
      // raiders
      for (var e = 0; e < game.enemies.length; e++) {
        var en = game.enemies[e], eid = 'e' + en.id;
        var r = this.pools.enemy[eid];
        if (!r) { r = this.raiderRig(en.type); scene.add(r); this.pools.enemy[eid] = r; }
        var EP = this.W(en.px, en.py);
        var fly = en.flyer && !(en.groundedT > 0);
        var walk = Math.abs(Math.sin(now * 9 + en.id * 1.3));
        r.position.set(EP.x, (fly ? 30 : 0) + (en.grabT > 0 ? Math.abs(Math.sin(now * 22)) * 3 : walk * 3), EP.z);
        var ahead = pathPointAt(en.fleeing ? Math.max(0, en.d - 8) : Math.min(PATH.len, en.d + 8));
        r.rotation.y = Math.atan2(ahead.x - en.px, ahead.y - en.py);
        r.rotation.z = Math.sin(now * 9 + en.id) * 0.06;
        if (r.userData.sack) r.userData.sack.visible = en.stolen > 0;
        // MARCH: counter-swinging limbs. Static limbs on a moving body read as
        // a statue sliding along the floor — this is most of the "alive".
        if (r.userData.legL && en.grabT <= 0) {
          if (fly) {
            // AIRBORNE: legs tuck, arms trail, wings beat, body banks with the
            // turn. Marching limbs on a flyer read as a man walking on air.
            var beat = Math.sin(now * 15 + en.id);
            r.userData.legL.rotation.x = -0.75; r.userData.legR.rotation.x = -0.6;
            r.userData.armL.rotation.x = -0.5; r.userData.armR.rotation.x = -0.5;
            if (r.userData['wing-1']) {
              r.userData['wing-1'].rotation.z = -0.4 - beat * 0.5;
              r.userData['wing1'].rotation.z = 0.4 + beat * 0.5;
            }
            r.rotation.z = Math.sin(now * 2 + en.id) * 0.12;
          } else {
            var sw3 = Math.sin(now * 9 + en.id * 1.3);
            r.userData.legL.rotation.x = sw3 * 0.55;
            r.userData.legR.rotation.x = -sw3 * 0.55;
            r.userData.armL.rotation.x = -sw3 * 0.40;
            r.userData.armR.rotation.x = sw3 * 0.40;
          }
        }
        if (r.userData['wing-1']) {
          r.userData['wing-1'].rotation.z = -0.4 - Math.sin(now * 16) * 0.35;
          r.userData['wing1'].rotation.z = 0.4 + Math.sin(now * 16) * 0.35;
        }
        var flash = en.flashT > 0 ? 1.12 : 1;
        r.scale.set(flash, flash * (en.slowT > 0 ? 0.94 : 1), flash);
        seen.enemy[eid] = 1;
      }
      // projectiles: bolts are ARROWS, lobs are embers, fire is a comet
      for (var p2 = 0; p2 < game.projectiles.length; p2++) {
        var pr = game.projectiles[p2];
        if (pr._r3dId === undefined) pr._r3dId = 'p' + (this._pid = (this._pid || 0) + 1);
        var po = this.pools.proj[pr._r3dId];
        if (!po) {
          po = new T.Group();
          var PG = this._projGeo || (this._projGeo = {
            shaft: new T.CylinderGeometry(0.9, 0.9, 20, 5),
            head: new T.ConeGeometry(2.2, 6, 5),
            tail: new T.ConeGeometry(1.6, 16, 5),
            ball: new T.SphereGeometry(5, 7, 6),
            lob: new T.SphereGeometry(4.4, 7, 6),
          });
          if (pr.kind === 'bolt') {
            var sh = new T.Mesh(PG.shaft, m.wood);
            sh.rotation.x = Math.PI / 2; po.add(sh);
            var hd = new T.Mesh(PG.head, m.iron);
            hd.rotation.x = Math.PI / 2; hd.position.z = 12; po.add(hd);
            var tmat = this._tailMat || (this._tailMat = new T.MeshBasicMaterial({ color: 0xfff0c0, transparent: true, opacity: 0.35 }));
            var tail = new T.Mesh(PG.tail, tmat);
            tail.rotation.x = -Math.PI / 2; tail.position.z = -16; po.add(tail);
          } else if (pr.kind === 'fire') {
            po.add(new T.Mesh(PG.ball, m.flame));
          } else {
            po.add(new T.Mesh(PG.lob, m.flame));
          }
          scene.add(po); this.pools.proj[pr._r3dId] = po;
        }
        var h2 = pr.kind === 'lob' ? Math.max(4, 30 - Math.abs(pr.y - pr.ty) * 0.2) : 14;
        var PP = this.W(pr.x, pr.y, 0);
        po.position.set(PP.x, pr.kind === 'lob' ? 10 + Math.sin(Math.min(1, pr.t / pr.dur) * Math.PI) * 34 : 16, PP.z);
        if (pr.dx !== undefined) po.rotation.y = Math.atan2(pr.dx, pr.dy);
        seen.proj[pr._r3dId] = 1;
      }
      // tar slag
      for (var t3 = 0; t3 < game.tar.length; t3++) {
        var tp2 = game.tar[t3], tid2 = 't' + Math.round(tp2.d) + '_' + tp2.tid;
        var to2 = this.pools.tar[tid2];
        if (!to2) {
          var a2 = pathPointAt(tp2.d), TP = this.W(a2.x, a2.y);
          to2 = new T.Mesh(new T.CylinderGeometry(tp2.w * 0.6, tp2.w * 0.66, 1.6, 9), m.tar);
          to2.position.set(TP.x, 1.4, TP.z);
          scene.add(to2); this.pools.tar[tid2] = to2;
        }
        seen.tar[tid2] = 1;
      }
      // Wick
      if (!this.hero) { this.hero = this.heroRig(); scene.add(this.hero); }
      var hh = game.hero;
      var HP = this.W(hh.x, hh.y);
      var hMoving = Math.abs(hh.tx - hh.x) + Math.abs(hh.ty - hh.y) > 3;
      this.hero.position.set(HP.x, (hh.manned ? 34 : 0) + (hMoving ? Math.abs(Math.sin(now * 9)) * 3.5 : Math.sin(now * 2.2) * 1.2), HP.z);
      if (hMoving) this.hero.rotation.y = Math.atan2(hh.tx - hh.x, hh.ty - hh.y);
      this.hero.userData['wing-1'].rotation.z = -0.45 - Math.sin(now * 7) * 0.18;
      this.hero.userData['wing1'].rotation.z = 0.45 + Math.sin(now * 7) * 0.18;
      // MOUTH-ORIGIN FIRE, 3D half: same beat clock as the 2D jaw
      // (game._breathT 0.42 -> 0), so both renderers fire from one moment
      var bt = game._breathT || 0;
      if (this.hero.userData.jaw) {
        var open = bt > 0 ? Math.sin((bt / 0.42) * Math.PI) : 0;
        this.hero.userData.jaw.rotation.x = open * 0.85;           // jaw drops
        this.hero.userData.jaw.position.y = 24.2 - open * 2.6;
        this.hero.userData.head.rotation.x = -open * 0.30;         // head kicks back
        this.hero.userData.snout.rotation.x = -open * 0.22;
      }
      // flames flicker (cosmetic clock, render lane)
      if (this._flames) for (var f2 = 0; f2 < this._flames.length; f2++) {
        this._flames[f2].scale.y = 0.8 + Math.sin(now * 7 + f2 * 2.1) * 0.25;
      }
      // retire dead objects — but a RAIDER topples first. Popping a body out
      // of existence is the single cheapest way to make combat feel weightless;
      // 0.45s of falling costs nothing and sells every kill.
      for (var pool in this.pools) {
        for (var pid in this.pools[pool]) {
          if (seen[pool][pid]) continue;
          var dead = this.pools[pool][pid];
          if (pool === 'enemy' && dead.userData.fallT === undefined) dead.userData.fallT = 0;
          if (pool === 'enemy') {
            dead.userData.fallT += Math.min(0.05, this._rdt || 0.016);
            var fk = dead.userData.fallT / 0.45;
            if (fk < 1) {
              dead.rotation.x = -fk * 1.5;                  // topples backward
              dead.position.y = Math.max(0, dead.position.y - fk * 26);
              dead.scale.setScalar((dead.scale.x || 1) * 0.995);
              continue;                                    // keep it one more frame
            }
          }
          scene.remove(dead); delete this.pools[pool][pid];
        }
      }
      // fx particles tick on a render-lane clock (never the sim's)
      var rnow = performance.now() / 1000;
      var rdt = Math.min(0.05, rnow - (this._rlast || rnow));
      this._rlast = rnow; this._rdt = rdt;
      this._fxTick(rdt);
      // screenshake reaches the 3D camera: jitter around the stored base
      if (this._camBase) {
        var sh = game.shake > 0 ? game.shake : 0;
        this.cam.position.set(
          this._camBase.x + (sh ? (Math.random() - 0.5) * 26 * sh : 0),
          this._camBase.y + (sh ? (Math.random() - 0.5) * 14 * sh : 0),
          this._camBase.z);
      }
      this.gl.render(this.scene, this.cam);
      // The shake is a RENDER effect only. Left in the matrix it would feed
      // the next frame's tap raycast and every projected UI anchor through
      // Math.random — taps missing by ±13-20 units after a big hit, and a
      // replay's world-space taps re-mapped. Restore the base immediately.
      if (this._camBase) {
        this.cam.position.set(this._camBase.x, this._camBase.y, this._camBase.z);
        this.cam.updateMatrixWorld();
      }
    },
  };

  // ===== Game =============================================================
  function Game(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.view = { cw: 1, ch: 1, dpr: 1, scale: 1, w: VIEW_MIN_W, h: VIEW_H, ox: 0, oy: 0 };
    this._last = 0; this._acc = 0;
    this.particles = []; this.floats = []; this.husks = []; this.shake = 0;
    this.fxQueue = [];                      // update() emits events; _cosmetic() spends them
    this.mode = 'campaign';                 // 'campaign' | 'daily'
    this.state = 'menu';                    // 'menu' | 'playing' | 'won' | 'lost' | 'paused'
    this.speed = 1;                         // 1x / 2x — multiplies the ACCUMULATOR, not dt
    this.reset((location && /[?&]seed=(\d+)/.exec(location.search) || [])[1] | 0 || dailySeed());
    this.resize();
    var self = this;
    Input.setConverter(function (cx, cy) {
      var w = self.toWorld(cx, cy);
      // view coords ride along for the screen-anchored HUD hit tests
      w.vx = cx / self.view.scale;
      w.vy = cy / self.view.scale;
      return w;
    });
    this._frame = this._frame.bind(this);
    requestAnimationFrame(this._frame);
  }

  Game.prototype.reset = function (seed, mode, level, trialKey, rivalIdx) {
    this.mode = mode || this.mode;
    // DUEL: the arena is DERIVED, never passed. The rival's curve is indexed by
    // (rival, seedIdx), so letting a caller supply a seed would allow a duel to
    // run on ground the recording was never made on — the two sides would
    // silently be fighting different maps and the scoreboard would be a lie.
    // One source of truth, and it lives here.
    this.rivalIdx = (this.mode === 'duel') ? clamp(rivalIdx | 0, 0, RIVALS.length - 1) : -1;
    this.rival = this.rivalIdx >= 0 ? RIVALS[this.rivalIdx] : null;
    this.duelSeedIdx = -1;
    if (this.rivalIdx >= 0) {
      // An explicit seed is honoured ONLY if it is one of the baked arenas —
      // that is what lets tools/bake-rivals.js walk every (rival, arena) pair
      // through the ordinary code path instead of needing a private one. Any
      // other value (normal play passes 0) takes tonight's derived arena. The
      // effect is that a duel can never run on ground with no curve slot.
      var si = DUEL_SEEDS.indexOf(seed >>> 0);
      this.duelSeedIdx = si >= 0 ? si : duelSeedIdx(this.rivalIdx);
      seed = DUEL_SEEDS[this.duelSeedIdx];
    }
    this.seed = (seed >>> 0) || dailySeed();
    // level select: campaign takes the chosen map; the Daily rotates its map
    // as a PURE function of the seed, so every player fights the same layout
    if (this.mode === 'daily') this.levelIdx = setLevel(this.seed % MAPS.length);
    else if (this.mode === 'duel') this.levelIdx = setLevel(duelMapAt(this.duelSeedIdx));
    else this.levelIdx = setLevel(level !== undefined ? level : (this.levelIdx || 0));
    seedStream(this.seed);                  // LANE 2 seeded once, at reset
    this.worldT = 0;
    this.gold = CFG.startGold;
    this.hoard = CFG.startHoard;
    this.wave = 0;                          // waves completed; current = wave index while active
    this.waveActive = false;
    this._bossWave = false;
    this._mCue = null; this._mClear = false; this._mScene = null;
    // Come back into the level at a different bar than last time. Retrying
    // wave 18 six times is normal here; hearing the bed's first bar six times
    // is what makes people reach for the SOUND pill. Whole bars only, so the
    // stems stay phase-locked, and Math.random by law — lane 3 never touches
    // the seeded stream (and this runs after seedStream anyway).
    Sfx.replayVaried();
    this.waveT = 0;
    this.countdown = 6;                     // grace before wave 1
    this.spawnQueue = [];                   // built at wave start, drained by time
    this.enemies = []; this.towers = []; this.projectiles = [];
    this.tar = [];                          // Tar Boiler slag patches {d,w,dps,until,tw}
    // cosmetic state must die with the run — a quit-to-title mid-battle must
    // not spray the LAST run's celebration into the next one (caught on film)
    this.particles = []; this.floats = []; this.husks = []; this.fxQueue = []; this.shake = 0;
    this._breathT = 0; this._heroFace = 1; this._resultT = 0;
    this.nextId = 1;
    var hs = MAP.heroStart || { x: 210, y: 470 };
    this.hero = { x: hs.x, y: hs.y, tx: hs.x, ty: hs.y, range: 76, dmg: 9, rate: 1.25, cd: 0,
                  breathCd: 6, spd: 85, selected: false, castBreath: false,
                  manTid: -1, manned: false,     // manTid: stable tower id (survives splices)
                  // Wick has SKIN IN THE GAME now. He could not be hurt, so
                  // there was never a reason to move him — a bot won 45 of 45
                  // runs without touching him once. hp/downT are sim state:
                  // graded, replay-identical, never read from the render lane.
                  hp: CFG.heroHp, maxHp: CFG.heroHp, downT: 0, safeT: 0, tollCd: 0 };
    this.menu = null;                       // { padIdx } build menu | { towerIdx } manage menu
    this.shopPick = -1;                     // index into TOWER_ORDER while placing, else -1
    this.placeHint = null;                  // {x,y,ok,why} — the last previewed spot
    this.stolenLost = 0;
    // The rival's side of the duel. rivalHoard steps ONCE PER WAVE off the
    // baked curve — it is display + scoring state only and is never read by
    // anything that can change the player's sim, so a duel is bit-identical to
    // the same seed played solo.
    this.rivalHoard = CFG.startHoard;
    this.rivalPrev = CFG.startHoard;
    this.rivalDrop = 0;                     // coins the rival lost on the last wave
    // The HUD pulse is DERIVED from (worldT - rivalStepT), not carried in a
    // countdown: a timer would need decaying somewhere, and the only two places
    // to do that are the sim (where a cosmetic has no business) and the render
    // lane (where sim-written state has no business). A timestamp needs neither.
    this.rivalStepT = -99;
    this.duelResolved = false;              // a duel ends once, on one code path
    this.kills = 0;
    this.leaks = {};   // per-raider-type leak ledger, graded state (see the escape path)
    this.tollRecovered = 0;                 // coins Wick personally shook loose
    this.breathUsed = false;                // Mother's Breath spends once per level
    this.motherReady = false; this.castMother = false;
    // Forge mods: CAMPAIGN ONLY — the Daily sim takes no input but the seed.
    // The DUEL is bound by the same law, and harder: every rival curve was
    // baked by a bot with no Forge at all, so granting the player forge power
    // here would not be an advantage, it would make the scoreboard meaningless.
    // A shared fight has to be the SAME fight. {} for daily AND duel: LAW.
    this.mods = (this.mode === 'campaign') ? Save.forgeMods() : {};
    // Trial mutator: campaign-only by construction; forge power still applies
    this.trial = (this.mode === 'campaign' && trialKey && TRIALS[trialKey]) ? trialKey : null;
    if (this.trial) {
      // THIS WAS A HAND-MAINTAINED WHITELIST AND IT SILENTLY DROPPED KEYS.
      // rangeMul (Guttered Torches) and breathCd (Smothered Fire) were declared
      // in TRIALS and copied by nothing, so both trials were a label on an
      // unmodified run — and the win stamped the badge anyway. bannedTower had
      // already been found dead the same way; fixing that ONE key instead of the
      // mechanism is why two more were still broken hours later.
      // Copy by RULE now, and validate.py asserts every declared key is handled.
      var tm = TRIALS[this.trial].mods;
      // absolutes: the trial's number wins outright
      if (tm.startGoldSet != null) this.mods.startGoldSet = tm.startGoldSet;
      if (tm.sellRefund != null) this.mods.sellRefund = Math.max(this.mods.sellRefund || 0, tm.sellRefund);
      if (tm.bountyMul != null) this.mods.bountyMul = tm.bountyMul;   // 0 is meaningful — never || it
      if (tm.bannedTower) this.mods.bannedTower = tm.bannedTower;
      if (tm.fleeMul) this.mods.fleeMul = tm.fleeMul;
      if (tm.breathOff) this.mods.breathOff = true;
      // multiplicative: STACKS with forge power instead of clobbering it
      if (tm.rangeMul != null) this.mods.rangeMul = (this.mods.rangeMul || 1) * tm.rangeMul;
      if (tm.startGold) this.mods.startGold = (this.mods.startGold | 0) + tm.startGold;
    }
    // A trial that SETS the purse replaces it; the Forge's +25/rank must not be
    // added on top, or 'Almost nothing to start' hands you MORE than a normal run.
    if (this.mods.startGoldSet != null) this.gold = this.mods.startGoldSet;
    if (this.mods.startGold) this.gold += this.mods.startGold;
    this.hitstopT = 0;
    this.resultLockT = 0;
    this._ocSeen = false;
    this.infoCard = null;
    this.speed = 1;                         // every run starts at 1x
    this.result = null;
  };

  Game.prototype.setPaused = function (v) {
    if (this.state === 'playing' && v) this.state = 'paused';
    else if (this.state === 'paused' && !v) this.state = 'playing';
  };

  Game.prototype.resize = function () {
    var cw = Math.max(320, window.innerWidth || 0);
    var ch = Math.max(240, window.innerHeight || 0);
    var dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.canvas.width = Math.round(cw * dpr);
    this.canvas.height = Math.round(ch * dpr);
    var scale = Math.min(ch / VIEW_H, cw / VIEW_MIN_W);
    // real safe-area insets, read from the env() probe div (canvas can't env())
    var st = 0, sb = 0;
    var probe = document.getElementById('safe-probe');
    if (probe) {
      var cs = getComputedStyle(probe);
      st = parseFloat(cs.paddingTop) || 0;
      sb = parseFloat(cs.paddingBottom) || 0;
    }
    // centre the fixed SIM world; the RENDER fills the whole viewport (bands
    // get painted scenery + the screen-anchored HUD, never dead black)
    R3D.on && R3D.ready && setTimeout(function (g) { return function () { R3D.resize(g); }; }(this), 0);
    this.view = {
      cw: cw, ch: ch, dpr: dpr, scale: scale,
      w: cw / scale, h: ch / scale,
      ox: (cw / scale - WORLD_W) / 2, oy: (ch / scale - WORLD_H) / 2,
      safeT: st / scale, safeB: sb / scale,
    };
  };
  Game.prototype.toWorld = function (cx, cy) {
    var v = this.view;
    return { x: cx / v.scale - v.ox, y: cy / v.scale - v.oy };
  };

  // ---- wave construction (deterministic: static tables or lane-1 gen) ----
  Game.prototype.buildWave = function (w) {
    // A duel draws its waves from the SEEDED generator, not a hand-authored
    // table: that is what makes "the same raiding party hit both caves" true
    // rather than a story. Same call, same seed, same twelve waves.
    var seeded = this.mode === 'daily' || this.mode === 'duel';
    var groups = seeded ? dailyWaveComp(w, this.seed) : WAVE_TABLES[this.levelIdx][w];
    var hpMul = seeded ? dailyHpMul(w) : campHpMul(w, this.levelIdx);
    var q = [];
    for (var g = 0; g < groups.length; g++) {
      var gr = groups[g];
      for (var i = 0; i < gr.count; i++) {
        q.push({ t: gr.delay + i * gr.gap, type: gr.type, hpMul: hpMul * (gr.hpMul || 1) });
      }
    }
    q.sort(function (a, b) { return a.t - b.t || (a.type < b.type ? -1 : 1); });
    return q;
  };
  Game.prototype.totalWaves = function () {
    if (this.mode === 'daily') return Infinity;
    if (this.mode === 'duel') return DUEL_WAVES;   // a duel has a finish line
    return WAVE_TABLES[this.levelIdx].length;
  };

  Game.prototype.startWave = function () {
    if (this.waveActive || this.state !== 'playing') return;
    if (this.countdown > 0.5 && this.wave > 0) {           // early-call bonus
      var bonus = Math.ceil(this.countdown);
      this.gold += bonus;
      this.fxQueue.push({ k: 'float', x: WORLD_W / 2, y: 700, txt: '+' + bonus + 'g early!', c: '#ffd75e' });
    }
    this.spawnQueue = this.buildWave(this.wave);
    // Stamp whether the King is in this wave. It has to be stamped HERE, from
    // the composition, rather than discovered later by scanning live enemies:
    // the court music and its telegraph need to be up during the countdown,
    // before a single boss has spawned.
    this._bossWave = this.spawnQueue.some(function (s) { return s.type === 'boss'; });
    if (this._bossWave) this._mCue = { name: 'boss' };
    this.waveActive = true;
    this.waveT = 0;
    this.countdown = 0;
    if (!Save.data.tut && this.mode === 'campaign' && this.towers.length) {
      Save.data.tut = 1; Save.write();       // taught: build, then call the wave
    }
    // daily: the server-timed run token starts at the FIRST wave call
    if (this.mode === 'daily' && this.wave === 0) Lb.beginRun();
    Sfx.play('wave');
  };

  // ---- FIXED-TIMESTEP SIM. Deterministic. No ctx. No Math.random. --------
  Game.prototype.update = function (STEP) {
    this.worldT += STEP;
    if (this.infoCard && (this.infoCard.t -= STEP) <= 0) this.infoCard = null;
    if (this.resultLockT > 0) this.resultLockT -= STEP;
    var taps = Input.drain();
    for (var ti = 0; ti < taps.length; ti++) {
      var preState = this.state;
      this._handleTap(taps[ti]);
      if (this.state !== preState) break;   // no same-frame chaining through screens
    }
    if (this.state !== 'playing') return;

    // hit-stop: an event-driven, DETERMINISTIC beat of frozen sim (same for
    // every replay of the same run — it lives in the sim, not the renderer)
    if (this.hitstopT > 0) { this.hitstopT -= STEP; return; }

    // -- countdown / auto-start --
    if (!this.waveActive) {
      if (this.wave >= this.totalWaves()) return;          // shouldn't happen; guarded at clear
      this.countdown -= STEP;
      if (this.countdown <= 0) this.startWave();
    }

    // -- spawner --
    if (this.waveActive) {
      this.waveT += STEP;
      while (this.spawnQueue.length && this.spawnQueue[0].t <= this.waveT) {
        var sp = this.spawnQueue.shift();
        var base = ENEMY_TYPES[sp.type];
        if (!Save.data.seen[sp.type] && ENEMY_CARDS[sp.type]) {
          Save.data.seen[sp.type] = 1; Save.write();
          this.infoCard = { type: sp.type, t: 6 };   // display-only; sim ignores it
        }
        this.enemies.push({
          id: this.nextId++, type: sp.type, d: 0,
          hp: Math.round(base.hp * sp.hpMul), maxHp: Math.round(base.hp * sp.hpMul),
          spd: base.spd, slowT: 0, slowF: 1, burnT: 0, burnDps: 0, bleedT: 0, bleedDps: 0,
          scaldT: 0, brittleT: 0, brittleMul: 1, deepT: 0, groundedT: 0, shaken: 0, sapT: 0,
          blinkT: base.blinkEvery || 0, healT: 1, grabT: 0, auraF: 1,
          stolen: 0, fleeing: false, flyer: !!base.flyer, summoned: false, shieldBroken: false,
          flashT: 0, px: PATH.pts[0][0], py: PATH.pts[0][1],
        });
      }
    }

    // -- Mother's Breath: when the hoard runs cold Auremma half-wakes and the
    // KEEP starts glowing — the PLAYER unleashes her by tapping it (audit:
    // never auto-resolve the game's tensest beat). Armed once per level and
    // stays armed until spent.
    if (!this.breathUsed && !this.motherReady && this.hoard <= CFG.breathAt) {
      this.motherReady = true;
      this.fxQueue.push({ k: 'float', x: MAP.keep.x, y: MAP.keep.y + 70, txt: 'MOTHER STIRS — TAP THE KEEP!', c: '#ffcf6a' });
      Sfx.play('wave');
    }
    if (this.castMother && this.motherReady) {
      this.castMother = false;
      this.motherReady = false;
      this.breathUsed = true;
      for (var mb = 0; mb < this.enemies.length; mb++) this.enemies[mb].hp -= 60;
      this.hitstopT = 0.12;   // ultimate beat, just inside the hitch ceiling
      this.fxQueue.push({ k: 'mother' });
      Sfx.play('breath');
    } else this.castMother = false;

    // -- boss war-drum aura: +speed to allies near the Hoard King --
    for (var au = 0; au < this.enemies.length; au++) this.enemies[au].auraF = 1;
    for (var ab = 0; ab < this.enemies.length; ab++) {
      var bossE = this.enemies[ab], bossB = ENEMY_TYPES[bossE.type];
      if (!bossB.auraR) continue;
      for (var aj = 0; aj < this.enemies.length; aj++) {
        var ally = this.enemies[aj];
        if (ally === bossE) continue;
        var adx = ally.px - bossE.px, ady = ally.py - bossE.py;
        if (ally.deepT > 0) continue;         // Deepchill Coil: deaf to the war drum
        // NO enrage bonus here: the King is INSIDE HIS OWN AURA, so a '+0.25
        // to his court' was secretly a 21% speed buff to HIM. He then reached
        // the hoard on every run and one boss theft (25 coins) blew the 5-coin
        // 3-star budget — every level silently collapsed to 1 star.
        if (adx * adx + ady * ady <= bossB.auraR * bossB.auraR) ally.auraF = bossB.auraSpd;
      }
      // at half HP the King roars in reinforcements, once
      if (!bossE.summoned && bossE.hp <= bossE.maxHp / 2 && bossB.summonAtHalf) {
        bossE.summoned = true;
        // summons scale like the spawner's units do (daily HP ramp)
        var sMul = this.mode === 'daily' ? dailyHpMul(this.wave) : 1;
        for (var sm = 0; sm < bossB.summonAtHalf; sm++) {
          var lb = ENEMY_TYPES.looter;
          var sd = Math.max(0, bossE.d - sm * 14);
          var sp2 = pathPointAt(sd);
          this.enemies.push({
            id: this.nextId++, type: 'looter', d: sd,
            hp: Math.round(lb.hp * sMul), maxHp: Math.round(lb.hp * sMul),
            spd: lb.spd, slowT: 0, slowF: 1, burnT: 0, burnDps: 0, bleedT: 0, bleedDps: 0,
            scaldT: 0, brittleT: 0, brittleMul: 1, deepT: 0, groundedT: 0, shaken: 0, sapT: 0,
            blinkT: 0, healT: 1, grabT: 0, auraF: 1,
            stolen: 0, fleeing: false, flyer: false, summoned: false, shieldBroken: false,
            flashT: 0, px: sp2.x, py: sp2.y,
          });
        }
        // ENRAGE is the fight's turning point — make it land. Hitstop just
        // under the hitch ceiling, a hard shake, a ring at his feet, and he
        // genuinely speeds up so the player FEELS the fight change, not just
        // reads a word.
        bossE.enraged = true;
        this.hitstopT = 0.11;
        this.fxQueue.push({ k: 'float', x: bossE.px, y: bossE.py - 34, txt: 'THE KING ROARS!', c: '#ff7b7b' });
        this.fxQueue.push({ k: 'pulse', x: bossE.px, y: bossE.py, r: 120, n: 1 });
        this.fxQueue.push({ k: 'boom', x: bossE.px, y: bossE.py, r: 70 });
        Sfx.play('wave');
      }
    }

    // -- tar patches expire on the world clock --
    for (var tx2 = this.tar.length - 1; tx2 >= 0; tx2--) {
      if (this.tar[tx2].until <= this.worldT) this.tar.splice(tx2, 1);
    }

    // -- enemies --
    var keepD = PATH.len;
    for (var i = this.enemies.length - 1; i >= 0; i--) {
      var e = this.enemies[i];
      var base2 = ENEMY_TYPES[e.type];
      // status
      if (e.slowT > 0) { e.slowT -= STEP; if (e.slowT <= 0) e.slowF = 1; }
      if (e.burnT > 0) { e.burnT -= STEP; e.hp -= e.burnDps * STEP; if (e.burnT <= 0) e.burnDps = 0; }
      if (e.bleedT > 0) { e.bleedT -= STEP; e.hp -= (e.bleedDps || 3) * STEP; }
      if (e.scaldT > 0) e.scaldT -= STEP;
      if (e.brittleT > 0) { e.brittleT -= STEP; if (e.brittleT <= 0) e.brittleMul = 1; }
      if (e.deepT > 0) e.deepT -= STEP;
      if (e.groundedT > 0) e.groundedT -= STEP;
      // Tar Boiler slag: 1D overlap on the path's arc length — both trips pay
      for (var tp2 = 0; tp2 < this.tar.length; tp2++) {
        var tpc = this.tar[tp2];
        if (!eFly(e) && Math.abs(e.d - tpc.d) < tpc.w * 0.5) e.hp -= tpc.dps * STEP;
      }
      if (e.flashT > 0) e.flashT -= STEP;
      // THE death check — BEFORE any movement. A corpse (DOT tick above,
      // Mother's Breath, or a pulse from last step) must never march, steal,
      // or escape; killing a carrier is the game's core promise.
      if (e.hp <= 0) { this._killEnemy(i, false); continue; }
      // warlock heal pulse
      if (base2.heals) {
        e.healT -= STEP;
        if (e.healT <= 0) {
          e.healT = 1;
          for (var j = 0; j < this.enemies.length; j++) {
            var o = this.enemies[j];
            if (o === e || o.hp <= 0) continue;
            if (o.scaldT > 0) continue;       // Whistlepot: the mend boils off as steam
            var dx = o.px - e.px, dy = o.py - e.py;
            if (dx * dx + dy * dy < base2.healR * base2.healR) {
              o.hp = Math.min(o.maxHp, o.hp + base2.heals);
            }
          }
          this.fxQueue.push({ k: 'heal', x: e.px, y: e.py });
        }
      }
      // SAPPER — jams the nearest machine silent for a few seconds. The first
      // threat to the towers themselves: a built board is no longer a solved
      // board. Deterministic (a timer and a distance), never a roll.
      if (base2.sapR && !e.fleeing) {
        e.sapT -= STEP;
        if (e.sapT <= 0) {
          var sBest = -1, sD = base2.sapR * base2.sapR;
          for (var sj = 0; sj < this.towers.length; sj++) {
            var stw = this.towers[sj];
            if (stw.jamT > 0) continue;                 // already silenced
            var sdx = stw.x - e.px, sdy = stw.y - e.py, sdd = sdx * sdx + sdy * sdy;
            if (sdd < sD) { sD = sdd; sBest = sj; }
          }
          if (sBest >= 0) {
            e.sapT = base2.sapEvery;
            this.towers[sBest].jamT = base2.sapStun;
            this.fxQueue.push({ k: 'float', x: this.towers[sBest].x, y: this.towers[sBest].y - 46,
                                txt: 'JAMMED!', c: '#ff9a9a' });
            this.fxQueue.push({ k: 'hit', x: this.towers[sBest].x, y: this.towers[sBest].y - 20, c: '#ff9a9a' });
            Sfx.play('jam');
          } else e.sapT = 0.35;                          // nothing in reach: rescan
        }
      }
      // blink — a chilled rogue cannot blink (Gemsinger's hard counter)
      if (base2.blink && !e.fleeing && e.slowT <= 0) {
        e.blinkT -= STEP;
        if (e.blinkT <= 0) {
          e.blinkT = base2.blinkEvery;
          var from = pathPointAt(e.d);
          e.d = Math.min(keepD - 1, e.d + base2.blink);
          var to = pathPointAt(e.d);
          this.fxQueue.push({ k: 'blink', x1: from.x, y1: from.y, x2: to.x, y2: to.y });
        }
      }
      // grab pause at the hoard
      if (e.grabT > 0) {
        e.grabT -= STEP;
        var gp2 = pathPointAt(e.d); e.px = gp2.x; e.py = gp2.y;
        continue;
      }
      // march / flee
      // NO speed change on enrage. Measured: it made the King reach the hoard
      // on EVERY run, and one boss theft is 25 coins against a 5-coin 3-star
      // budget — every level collapsed to 1 star. The enrage is a BEAT (roar,
      // hitstop, shake, his court driven harder), not a speed buff.
      var v = e.spd * e.slowF * e.auraF * STEP;
      if (e.fleeing) {
        // loot-weight rule: the more they carry, the slower they run.
        // Greased Boots multiplies the whole getaway leg (march-in untouched).
        var fleeMul = Math.max(CFG.fleeMin, CFG.fleeBase - CFG.fleeWeight * e.stolen) * (this.mods.fleeMul || 1);
        e.d -= v * fleeMul;
        if (e.d <= 0) {                                    // escaped with treasure
          this.stolenLost += e.stolen;
          // THE LEAK LEDGER — who actually took the hoard, and when.
          // A player could previously only tell that "stuff got through": the
          // result screen reported a total and nothing else, so a loss carried
          // no information about what to do differently. Sim-side (not
          // cosmetic) because it is graded state and must be replay-identical.
          var lk = this.leaks[e.type] || (this.leaks[e.type] = { coins: 0, runs: 0, firstWave: this.wave + 1 });
          lk.coins += e.stolen; lk.runs++;
          this.enemies.splice(i, 1);
          // n is an ADDITIVE cosmetic payload on an event that already exists
          // to feed the render lane: reads e.stolen, writes nothing
          this.fxQueue.push({ k: 'escape', x: PATH.pts[0][0], y: PATH.pts[0][1], n: e.stolen });
          Sfx.play('leak');
          continue;
        }
      } else {
        e.d += v;
        if (e.d >= keepD) {                                // reached the hoard: steal + turn
          var take = Math.min(base2.steals, this.hoard);
          this.hoard -= take;
          e.stolen = take;
          e.fleeing = true;
          e.grabT = CFG.grabTime;
          e.d = keepD - 1;
          var kp = pathPointAt(keepD);
          this.fxQueue.push({ k: 'steal', x: kp.x, y: kp.y, n: take });
          Sfx.play('steal');
          if (this.hoard <= 0) { this._gameOver(false); return; }
        }
      }
      // cache the position ONCE per step — targeting, splash, heal, aura and
      // the renderer all read px/py instead of re-deriving pathPointAt each
      var pp = pathPointAt(e.d); e.px = pp.x; e.py = pp.y;
    }

    // -- Overclock: the inventor at his machine. The nearest tower within
    // reach of Wick runs 25% faster — positioning is the input (deterministic).
    var ocIdx = -1, ocD = 62 * 62;
    for (var oc = 0; oc < this.towers.length; oc++) {
      var op2 = this.towers[oc];
      var odx = op2.x - this.hero.x, ody = op2.y - this.hero.y;
      var odd = odx * odx + ody * ody;
      if (odd < ocD) { ocD = odd; ocIdx = oc; }
      this.towers[oc]._oc = false;
    }
    // BELLOWS AURA — recomputed each step so selling a post takes its buff
    // with it. O(towers^2) but towers are a handful, not a crowd.
    for (var ai = 0; ai < this.towers.length; ai++) {
      var at = this.towers[ai];
      at._auraRate = 0; at._auraDmg = 0;
      if (TOWER_TYPES[at.type].support) continue;
      for (var aj = 0; aj < this.towers.length; aj++) {
        var src = this.towers[aj];
        if (src.type !== 'bellows') continue;
        var sr = lvlRow(src);
        var adx2 = at.x - src.x, ady2 = at.y - src.y;
        if (adx2 * adx2 + ady2 * ady2 > sr.range * sr.range) continue;
        // Read the hero directly: the _manned flags are stamped BELOW this loop,
        // so src._manned would be a frame stale and the buff would lag the art.
        if (src.jamT > 0) continue;            // a jammed post buffs nothing
        var sMan = this.hero.manned && this.hero.manTid === src.tid;
        var sBoost = sMan ? (TOWER_TYPES.bellows.mannedAura || 1) : 1;
        at._auraRate = Math.max(at._auraRate, (sr.auraRate || 0) * sBoost);  // strongest post wins,
        at._auraDmg = Math.max(at._auraDmg, (sr.auraDmg || 0) * sBoost);     // posts do NOT stack
      }
    }

    // MANNED beats mere proximity: Wick at the crank IS the buff, and it is
    // visible (he is sitting on the machine) instead of an invisible aura.
    for (var mi = 0; mi < this.towers.length; mi++) {
      this.towers[mi]._manned = this.hero.manned && this.towers[mi].tid === this.hero.manTid;
      if (this.towers[mi]._manned) { this.towers[mi]._oc = false; if (ocIdx === mi) ocIdx = -1; }
    }
    if (ocIdx !== -1) {
      this.towers[ocIdx]._oc = true;
      if (!this._ocSeen) {
        this._ocSeen = true;
        var ocp = this.towers[ocIdx];
        this.fxQueue.push({ k: 'float', x: ocp.x, y: ocp.y - 46, txt: 'OVERCLOCKED!', c: '#ffcf6a' });
      }
    }

    // -- towers --
    for (var t = 0; t < this.towers.length; t++) {
      var tw = this.towers[t];
      var tt = TOWER_TYPES[tw.type], lv = lvlRow(tw);
      // JAM FIRST, THEN THE SUPPORT BAIL. This was the other way round, so a
      // sapper could jam a Bellows or Press and the countdown -- the only place
      // jamT is ever decremented -- sat below the bail and never ran. The jam
      // did nothing AND never expired, which then made that machine permanently
      // immune to sapping (the scan skips anything with jamT > 0). A red
      // 'JAMMED!' float landed on a machine that went on buffing and minting.
      if (tw.jamT > 0) {
        // WICK CLEARS THE JAM. A Pry-Hand silences a machine for 2.6s and there
        // was nothing anyone could do but wait — which is the whole problem
        // with this game's real-time layer in one line. A playtest bot won 45
        // of 45 runs without ever moving Wick, breathing, or manning anything,
        // because none of it was load-bearing.
        //
        // Now he is the answer to a jam: standing on the machine clears it
        // ~5x faster, standing next to it ~2.5x. That is a real-time decision
        // with a real cost — the seconds he spends unjamming are seconds he is
        // not manning his best machine — and it gives the Pry-Hand a counter
        // that is a PLAYER ACTION rather than a different purchase.
        var jdx = this.hero.x - tw.x, jdy = this.hero.y - tw.y;
        var jd2 = jdx * jdx + jdy * jdy;
        var pry = (this.hero.manned && this.hero.manTid === tw.tid) ? 5
                : jd2 < 52 * 52 ? 2.5 : 1;
        tw.jamT -= STEP * pry;
        if (tw.jamT <= 0 && pry > 1) {
          this.fxQueue.push({ k: 'float', x: tw.x, y: tw.y - 46, txt: 'UNJAMMED!', c: '#9ef58f' });
        }
        continue;
      }
      if (tt.support) continue;              // bellows/press do their work elsewhere
      // Time since this machine ACTUALLY fired. The recoil used to be driven
      // by the cooldown, but an idle machine rescans every 0.1s, which
      // retriggered the wind-up ~8x a second forever — every contraption on
      // the board vibrated even with nothing to shoot at.
      tw.shotT = (tw.shotT === undefined ? 9 : tw.shotT) + STEP;
      tw.cd -= STEP * (tw._manned ? 1.7 : tw._oc ? 1.25 : 1) * (1 + (tw._auraRate || 0));
      if (tw.cd > 0) continue;
      var pad = tw;
      // crystal: pulse-slow everything in range, no target needed.
      // BACKWARDS: _damage can kill+splice, and a forward loop would skip
      // the enemy shifted into the vacated slot.
      if (tw.type === 'crystal') {
        var hitAny = 0;
        for (var c = this.enemies.length - 1; c >= 0; c--) {
          var ce = this.enemies[c];
          if (ce.hp <= 0) continue;
          var cR = lv.range * (this.mods.rangeMul || 1);
          var cdx = ce.px - pad.x, cdy = ce.py - pad.y;
          if (cdx * cdx + cdy * cdy <= cR * cR) {
            ce.slowF = Math.min(ce.slowF, ce.type === 'boss' ? 0.75 : 1 - lv.slow);
            // max, not assign: a weaker crystal must never TRUNCATE a deep
            // chill (deepT <= slowT must hold — blink immunity reads slowT)
            ce.slowT = Math.max(ce.slowT, lv.slowDur);
            if (lv.special === 'deepchill') ce.deepT = lv.slowDur;
            if (lv.special === 'resonance') { ce.brittleT = lv.slowDur; ce.brittleMul = lv.brittleMul; }
            if (lv.dmg) this._damage(ce, lv.dmg * (this.mods.dmgMul || 1) * (tw._manned ? 1.3 : 1), { kind: 'magic', tower: tw });
            hitAny++;
          }
        }
        if (hitAny) tw.shotT = 0;
        if (hitAny) this.fxQueue.push({ k: 'pulse', x: pad.x, y: pad.y, r: lv.range, n: hitAny });
        tw.cd = hitAny ? 1 / lv.rate : 0.1;   // idle rescan at 6 Hz, not 60
        continue;
      }
      var mDmg = (this.mods.dmgMul || 1) * (tw._manned ? 1.3 : 1) * (1 + (tw._auraDmg || 0)), mRng = this.mods.rangeMul || 1;
      var target = this._pickTarget(pad, lv.range * mRng, tt.hitsAir, tt.airBonus, tw.targeting | 0);
      if (!target) { tw.cd = 0.1; continue; }
      (this._r3dAim = this._r3dAim || {})[tw.tid] = { x: target.px, y: target.py };   // miss: rescan at 6 Hz, not 60
      // THE MACHINES DID NOT TURN. A crossbow drew in one fixed pose and fired
      // at whatever it liked, so a raider on its left was shot by a bow aimed
      // up-RIGHT. Nothing in a tower-defense frame reads as broken faster.
      // The plate's base is a round turntable, so the art is built to swivel.
      // Cosmetic cache: written here, read ONLY by the renderer, exactly like
      // the _r3dAim line above — the sim never reads it back, so no fork.
      tw._aimX = target.px; tw._aimY = target.py;
      tw.cd = 1 / lv.rate;
      var tp = { x: target.px, y: target.py };
      if (tw.type === 'mimic') {                            // instant bite
        tw.shotT = 0;
        this._damage(target, lv.dmg * mDmg, { kind: 'melee', tower: tw });
        if (lv.special === 'rend') { target.bleedT = lv.rendDur; target.bleedDps = lv.rendDps; }
        // Magnet Jaws: shake a stolen coin home (cap 2/raider). Losing weight
        // makes the thief RUN FASTER — you save the coin, not the bounty.
        if (lv.special === 'coinback' && target.hp > 0 && target.stolen > 0 && target.shaken < lv.coinCap) {
          target.stolen--; target.shaken++;
          this.hoard++;
          this.fxQueue.push({ k: 'recover', x: tp.x, y: tp.y, n: 1 });
        }
        this.fxQueue.push({ k: 'bite', x: tp.x, y: tp.y });
        Sfx.play('bite');
      } else if (tw.type === 'brazier') {                   // lobbed splash
        tw.shotT = 0;
        this.projectiles.push({
          kind: 'lob', x: pad.x, y: pad.y - 26, sx: pad.x, sy: pad.y - 26, tx: tp.x, ty: tp.y,
          t: 0, dur: 0.55, dmg: lv.dmg * mDmg, splash: lv.splash, burn: lv.burn || 0, tower: t,
          scald: lv.special === 'scald' ? lv.scaldDur : 0,
          // Tar Boiler: the patch lands at the TARGET's path distance at fire
          // time — 1D arc-length address, deterministic, no inverse projection.
          // Keyed by PAD, not array index: a sell splices the towers array.
          tar: lv.special === 'tarpatch' ? { d: target.d, w: lv.tarWidth, dps: lv.tarDps, dur: lv.tarDur, max: lv.maxPatches, tid: tw.tid } : null,
        });
        Sfx.play('lob');
      } else {                                              // homing bolt (crossbow / roost)
        var dmg = lv.dmg * mDmg;
        if (tw.type === 'perch' && eFly(target)) dmg *= (lv.airBonus3 || tt.airBonus || 1);
        tw.shots = (tw.shots || 0) + 1;
        // Overwinder: every Nth crank THUMPS — a countable crit, zero RNG
        var crit = lv.special === 'overwind' && tw.shots % lv.overwindEvery === 0;
        if (crit) dmg *= lv.overwindMul;
        // Windlass Rig: the crosshair stays put and winds tighter per hit
        if (lv.special === 'lockramp') {
          if (tw.lockId === target.id) tw.ramp = Math.min(lv.rampMax, (tw.ramp || 0) + lv.rampAdd);
          else { tw.lockId = target.id; tw.ramp = 0; }
          dmg += tw.ramp;
        }
        tw.shotT = 0;
        this.projectiles.push({
          kind: 'bolt', x: pad.x, y: pad.y - 30, target: target.id, spd: 340,
          dmg: dmg, crit: crit, hops: lv.pierce || 0,
          shieldbreak: lv.special === 'shieldbreak',
          net: lv.special === 'downdraft' ? lv.groundDur : 0, tower: t,
        });
        // the STRING SNAP: a real crossbow releases, it doesn't just emit
        this.fxQueue.push({ k: 'snap', x: pad.x, y: pad.y - 26, tx: tp.x, ty: tp.y });
        Sfx.play('shoot');
      }
    }

    // -- projectiles --
    for (var p = this.projectiles.length - 1; p >= 0; p--) {
      var pr = this.projectiles[p];
      if (pr.kind === 'lob') {
        pr.t += STEP;
        var a = Math.min(1, pr.t / pr.dur);
        pr.x = pr.sx + (pr.tx - pr.sx) * a;
        pr.y = pr.sy + (pr.ty - pr.sy) * a - Math.sin(a * Math.PI) * 60;
        if (a >= 1) {
          this.projectiles.splice(p, 1);
          this.fxQueue.push({ k: 'boom', x: pr.tx, y: pr.ty, r: pr.splash });
          if (pr.tar) {                     // Tar Boiler: lay slag on the road
            var mine = [];
            for (var tf = 0; tf < this.tar.length; tf++) if (this.tar[tf].tid === pr.tar.tid) mine.push(tf);
            if (mine.length >= pr.tar.max) this.tar.splice(mine[0], 1);   // evict oldest
            this.tar.push({ d: pr.tar.d, w: pr.tar.w, dps: pr.tar.dps, until: this.worldT + pr.tar.dur, tid: pr.tar.tid });
          }
          // BACKWARDS: _damage can kill+splice mid-loop
          for (var b = this.enemies.length - 1; b >= 0; b--) {
            var be = this.enemies[b];
            if (eFly(be) || be.hp <= 0) continue;
            var bdx = be.px - pr.tx, bdy = be.py - pr.ty;
            if (bdx * bdx + bdy * bdy <= pr.splash * pr.splash) {
              this._damage(be, pr.dmg, { kind: 'splash', tower: this.towers[pr.tower] });
              if (pr.burn) { be.burnT = 3; be.burnDps = Math.max(be.burnDps, pr.burn); }
              if (pr.scald) be.scaldT = pr.scald;  // Whistlepot: heal-block rides the burn (duration is DATA)
            }
          }
          Sfx.play('hit');
        }
      } else if (pr.kind === 'fire') {                      // Wick's fireball
        var ft = null;
        for (var fq = 0; fq < this.enemies.length; fq++) if (this.enemies[fq].id === pr.target) { ft = this.enemies[fq]; break; }
        if (!ft) { this.projectiles.splice(p, 1); continue; }
        var fdx = ft.px - pr.x, fdy = ft.py - pr.y;
        var fdist = Math.sqrt(fdx * fdx + fdy * fdy);
        if (fdist < 11) {
          this._damage(ft, pr.dmg, { kind: 'hero' });
          this.fxQueue.push({ k: 'fireburst', x: ft.px, y: ft.py });
          this.projectiles.splice(p, 1);
        } else {
          pr.dx = fdx / fdist; pr.dy = fdy / fdist;
          pr.x += pr.dx * pr.spd * STEP;
          pr.y += pr.dy * pr.spd * STEP;
        }
      } else {                                              // bolt
        var tgt = null;
        for (var q = 0; q < this.enemies.length; q++) if (this.enemies[q].id === pr.target) { tgt = this.enemies[q]; break; }
        if (!tgt) { this.projectiles.splice(p, 1); continue; }
        var gp = { x: tgt.px, y: tgt.py };
        var pdx = gp.x - pr.x, pdy = gp.y - pr.y;
        var dist = Math.sqrt(pdx * pdx + pdy * pdy);
        if (dist < 10) {
          this._damage(tgt, pr.dmg, { kind: 'bolt', tower: this.towers[pr.tower], shieldbreak: pr.shieldbreak });
          this.fxQueue.push({ k: 'hit', x: gp.x, y: gp.y, c: pr.crit ? '#ff9a3c' : '#ffd75e' });
          if (pr.crit) this.fxQueue.push({ k: 'float', x: gp.x, y: gp.y - 14, txt: 'OVERWOUND!', c: '#ff9a3c' });
          // Netcaster: a netted flyer crashes low and fights as ground troops
          if (pr.net && tgt.flyer && !(tgt.groundedT > 0) && tgt.hp > 0) {
            tgt.groundedT = pr.net;
            this.fxQueue.push({ k: 'float', x: gp.x, y: gp.y - 24, txt: 'netted!', c: '#a8e6ff' });
          }
          // pierce: hop to the next enemy behind, at 60% damage per hop
          if (pr.hops > 0) {
            var nxt = this._nextBehind(tgt);
            if (nxt) { pr.target = nxt.id; pr.hops--; pr.dmg = Math.round(pr.dmg * 0.6) || 1; continue; }
          }
          this.projectiles.splice(p, 1);
        } else {
          pr.dx = pdx / dist; pr.dy = pdy / dist;   // renderer draws the trail along this
          pr.x += pr.dx * pr.spd * STEP;
          pr.y += pr.dy * pr.spd * STEP;
        }
      }
    }

    // -- hero whelp --
    var h = this.hero;
    // MANNING: if his post is a pad that still holds a machine, walk to it and
    // mount. The pad index (not a towers[] index) is the key, so selling some
    // other tower can never silently re-point him at the wrong machine.
    if (h.manTid >= 0) {
      var mtw = this._towerByTid(h.manTid);
      if (!mtw) { h.manTid = -1; h.manned = false; }        // machine sold
      else { h.tx = mtw.x; h.ty = mtw.y - 6; }
    }
    var hdx = h.tx - h.x, hdy = h.ty - h.y;
    var hd = Math.sqrt(hdx * hdx + hdy * hdy);
    if (hd > 2) { h.x += hdx / hd * Math.min(h.spd * STEP, hd); h.y += hdy / hd * Math.min(h.spd * STEP, hd); }
    var wasManned = h.manned;
    h.manned = h.manTid >= 0 && hd <= 3;
    if (h.manned && !wasManned) {
      var mp2 = this._towerByTid(h.manTid);
      if (mp2) {
        this.fxQueue.push({ k: 'float', x: mp2.x, y: mp2.y - 54, txt: 'MANNING!', c: '#ffcf6a' });
        this.fxQueue.push({ k: 'place', x: mp2.x, y: mp2.y });
      }
    }
    h.cd -= STEP; h.breathCd -= STEP;
    if (h.tollCd > 0) h.tollCd -= STEP;

    // ===== DOWNED ==========================================================
    // Not a run-loss — an ABSENCE. While he is out you lose his manning bonus,
    // his breath, his jam-clearing and the toll, which is exactly the set of
    // things that were free before. He comes back at the keep at full health,
    // so the punishment is tempo, never a dead run.
    if (h.downT > 0) {
      h.downT -= STEP;
      h.manTid = -1; h.manned = false;
      if (h.downT <= 0) {
        var rs = MAP.heroStart || { x: 210, y: 470 };
        h.x = h.tx = rs.x; h.y = h.ty = rs.y;
        h.hp = h.maxHp; h.safeT = 0;
        this.fxQueue.push({ k: 'float', x: h.x, y: h.y - 44, txt: 'WICK IS BACK', c: '#9ef58f' });
      }
      return;
    }

    // ===== CONTACT DAMAGE + THE TOLL ======================================
    // One pass over the raiders near him: the ones marching in HURT him, the
    // ones fleeing with treasure get SHAKEN. That pairing is the decision —
    // the coins he can win back are being carried through the pack that is
    // hurting him, so chasing is a real risk and parking him is a real cost.
    var contact2 = CFG.heroContact * CFG.heroContact;
    var toll2 = CFG.tollRange * CFG.tollRange;
    var taking = 0, nearAny = false;
    for (var hz = 0; hz < this.enemies.length; hz++) {
      var hz_e = this.enemies[hz];
      if (hz_e.hp <= 0) continue;
      var hzx = hz_e.px - h.x, hzy = hz_e.py - h.y, hz2 = hzx * hzx + hzy * hzy;
      if (hz2 > 3600) continue;                       // 60u: nothing to do out here
      nearAny = true;
      if (hz_e.fleeing) {
        // THE TOLL — body-block a thief and shake the hoard back out of him.
        // Only Wick can do this; a machine can only kill. It is his job in
        // every single wave, because every wave produces carriers.
        // PER-CARRIER cooldown, not a global one. A single timer on Wick
        // capped him at 3.3 coins a second no matter how many thieves he was
        // standing in, which made a perfectly-placed interception worth the
        // same as bumping into one straggler — it punished the exact skill the
        // mechanic exists to reward. Now each carrier is shaken on its own
        // clock, so standing in the stream pays for standing in the stream.
        if (hz_e.tollT > 0) hz_e.tollT -= STEP;
        if (hz2 <= toll2 && (hz_e.tollT || 0) <= 0 && hz_e.stolen > 0) {
          hz_e.stolen--;
          this.hoard++;
          this.tollRecovered++;
          hz_e.tollT = CFG.tollEvery;
          this.fxQueue.push({ k: 'recover', x: hz_e.px, y: hz_e.py, n: 1 });
          Sfx.play('recover');
        }
      } else if (hz2 <= contact2) {
        var hzBase = ENEMY_TYPES[hz_e.type];
        taking += hzBase.hp > 500 ? CFG.heroDpsTaken * 4 : hzBase.armor ? CFG.heroDpsTaken * 1.8
                                                                       : CFG.heroDpsTaken;
      }
    }
    if (taking > 0) {
      h.hp -= taking * STEP;
      h.safeT = 0;
      if (h.hp <= 0) {
        h.hp = 0;
        h.downT = CFG.heroDownTime;
        h.manTid = -1; h.manned = false;
        this.fxQueue.push({ k: 'herodown', x: h.x, y: h.y });
        Sfx.play('leak');
        return;
      }
    } else if (!nearAny) {
      h.safeT += STEP;
      if (h.safeT >= CFG.heroSafeAfter) h.hp = Math.min(h.maxHp, h.hp + CFG.heroRegen * STEP);
    }

    var inR = [];
    for (var e2 = 0; e2 < this.enemies.length; e2++) {
      var en2 = this.enemies[e2];
      if (en2.hp <= 0) continue;
      var ndx = en2.px - h.x, ndy = en2.py - h.y;
      if (ndx * ndx + ndy * ndy <= h.range * h.range) inR.push(en2);
    }
    if (h.castBreath && this.mods.breathOff) h.castBreath = false;   // Smothered Fire
    if (h.castBreath) {
      h.castBreath = false;
      if (h.breathCd <= 0 && inR.length) {          // player-cast; needs a target
        h.breathCd = this.mods.breathCd || 14;
        // breath is armor-piercing (kind 'breath' — the _damage contract)
        for (var br = inR.length - 1; br >= 0; br--) this._damage(inR[br], 26, { kind: 'breath' });
        this.fxQueue.push({ k: 'breath', x: h.x, y: h.y, r: h.range });
        Sfx.play('breath');
      } else if (h.breathCd <= 0) {
        this.fxQueue.push({ k: 'float', x: h.x, y: h.y - 40, txt: 'no raiders in reach', c: '#c9b8ff' });
      }
    }
    if (h.cd <= 0 && inR.length) {
      var pick = inR[0];
      for (var pk = 1; pk < inR.length; pk++) if (inR[pk].d > pick.d) pick = inR[pk];
      h.cd = 1 / h.rate;
      // He spits FIRE, and it looks like fire: a travelling fireball that
      // bursts on the target (the old tell was a 1px tracer nobody could see).
      this.projectiles.push({ kind: 'fire', x: h.x, y: h.y - 14, target: pick.id,
                              spd: 300, dmg: h.dmg, hero: true });
      this.fxQueue.push({ k: 'muzzle', x: h.x, y: h.y - 14, tx: pick.px, ty: pick.py });
      Sfx.play('shoot');
    }

    // -- wave clear (no flat gold bonus: the balance table's income = start +
    // bounties; the early-call button is the only extra tap) --
    if (this.waveActive && !this.spawnQueue.length && !this.enemies.length) {
      this.waveActive = false;
      this._bossWave = false;
      this._mClear = true;                  // drained by _cosmetic(): a live,
                                            // bar-harmonised answer, not a file
      this.menu = null;                     // no stale menu into the intermission
      this.wave++;
      // COIN PRESSES pay out at wave end — a bet on surviving to collect
      var minted = 0;
      for (var pz = 0; pz < this.towers.length; pz++) {
        var pt2 = this.towers[pz];
        if (pt2.type !== 'press') continue;
        var pr2 = lvlRow(pt2);
        if (!pr2.waveGold || pt2.jamT > 0) continue;   // a jammed press mints nothing
        var pMan = this.hero.manned && this.hero.manTid === pt2.tid;
        var pay = Math.round(pr2.waveGold * (pMan ? (TOWER_TYPES.press.mannedGold || 1) : 1));
        minted += pay;
        this.fxQueue.push({ k: 'float', x: pt2.x, y: pt2.y - 40, txt: '+' + pay + 'g', c: '#ffd75e' });
      }
      if (minted) { this.gold += minted; Sfx.play('coin'); }
      this.fxQueue.push({ k: 'float', x: WORLD_W / 2, y: 300, txt: 'Wave ' + this.wave + ' held!', c: '#9ef58f' });
      // ---- THE RIVAL'S WAVE ------------------------------------------------
      // Their cave took the same wave at the same time. Step their hoard off
      // the baked curve and SAY what it cost them — a number that only moves
      // in the corner of the HUD is a scoreboard; a number that announces
      // itself the moment yours moves is an opponent.
      if (this.mode === 'duel' && this.rival) {
        var rh = rivalHoardAt(this.rivalIdx, this.duelSeedIdx, this.wave);
        if (rh !== null) {
          this.rivalPrev = this.rivalHoard;
          this.rivalHoard = rh;
          this.rivalDrop = Math.max(0, this.rivalPrev - this.rivalHoard);
          this.rivalStepT = this.worldT;
          if (this.rivalDrop > 0) {
            this.fxQueue.push({ k: 'float', x: WORLD_W / 2, y: 336,
                                txt: this.rival.name + ' lost ' + this.rivalDrop, c: '#ff9a6a' });
          } else {
            this.fxQueue.push({ k: 'float', x: WORLD_W / 2, y: 336,
                                txt: this.rival.name + ' held clean', c: '#a8e6ff' });
          }
        }
        // Their cave falls: the duel is over the moment it does, however many
        // waves are left. Checked BEFORE the wave-count finish so a rival who
        // is sacked on the final wave still reads as a knockout, not a decision.
        if (this.rivalHoard <= 0) { this._gameOver(true); return; }
      }
      if (this.wave >= this.totalWaves()) {
        // A duel is decided on the MARGIN, not on survival — both sides
        // reaching the end is the normal case. Ties go to the defender who
        // still has the gold in front of them: >= , not >.
        if (this.mode === 'duel') { this._gameOver(this.hoard >= this.rivalHoard); return; }
        this._gameOver(true); return;
      }
      this.countdown = CFG.waveCountdown;
    }
  };

  var AIM_MODES = ['FIRST', 'STRONG', 'LAST'];
  Game.prototype._pickTarget = function (pad, range, hitsAir, airBonus, mode) {
    // Fleeing thieves ALWAYS lead (they carry OUR gold), closest-to-escaping
    // first. The player-set mode picks the focus among marchers:
    //   FIRST = furthest along · STRONG = most HP · LAST = newest arrivals.
    // Deterministic tie-break on id.
    var best = null, bestKey = -Infinity;
    for (var i = 0; i < this.enemies.length; i++) {
      var e = this.enemies[i];
      if (e.hp <= 0) continue;
      if (eFly(e) && !hitsAir) continue;    // a netted flyer is fair game for anyone
      var dx = e.px - pad.x, dy = e.py - pad.y;
      if (dx * dx + dy * dy > range * range) continue;
      var metric;
      if (e.fleeing) metric = PATH.len - e.d;
      else if (mode === 1) metric = e.hp * 0.001;           // STRONG
      else if (mode === 2) metric = PATH.len - e.d;         // LAST
      else metric = e.d;                                    // FIRST
      var key = (e.fleeing ? 1e6 : 0) + (eFly(e) && airBonus ? 5e5 : 0) + metric - e.id * 1e-7;
      if (key > bestKey) { bestKey = key; best = e; }
    }
    return best;
  };
  Game.prototype._nextBehind = function (tgt) {
    var best = null;
    for (var i = 0; i < this.enemies.length; i++) {
      var e = this.enemies[i];
      if (e === tgt || e.hp <= 0 || eFly(e)) continue;
      if (e.d < tgt.d && (!best || e.d > best.d)) best = e;
    }
    return best;
  };
  Game.prototype._nearestOther = function (p, tgt, r) {
    var best = null, bd = r * r;
    for (var i = 0; i < this.enemies.length; i++) {
      var e = this.enemies[i];
      if (e === tgt || e.hp <= 0) continue;
      var dx = e.px - p.x, dy = e.py - p.y, dd = dx * dx + dy * dy;
      if (dd < bd) { bd = dd; best = e; }
    }
    return best;
  };
  // opts: { kind: 'melee'|'bolt'|'splash'|'magic'|'hero'|'breath', tower, shieldbreak }
  Game.prototype._damage = function (e, dmg, opts) {
    opts = opts || {};
    var base = ENEMY_TYPES[e.type];
    // Shellback pavise halves bolt damage — unless a Roost L3 has broken it
    if (base.pavise && opts.kind === 'bolt' && !e.shieldBroken) {
      if (opts.shieldbreak) { e.shieldBroken = true; this.fxQueue.push({ k: 'float', x: pathPointAt(e.d).x, y: pathPointAt(e.d).y - 16, txt: 'shield broken!', c: '#c9d2dd' }); }
      else dmg *= 0.5;
    }
    // Tuning Fork: a brittle (chill-rung) raider takes +25% from EVERY tower
    if (e.brittleT > 0) dmg *= e.brittleMul;
    // Bulwark armor shaves flat damage off every direct hit (min 1);
    // magic (Gemsinger pulse) and breath ignore armor
    if (base.armor && opts.kind !== 'breath' && opts.kind !== 'magic') dmg = Math.max(1, dmg - base.armor);
    e.hp -= dmg;
    e.flashT = 0.1;                       // white-flash + pop, read by the renderer only
    if (e.hp <= 0 && !e._counted) {
      e._counted = true;
      var idx = this.enemies.indexOf(e);
      if (idx >= 0) this._killEnemy(idx, false);
    }
  };
  Game.prototype._killEnemy = function (i, greed) {
    var e = this.enemies[i];
    var base = ENEMY_TYPES[e.type];
    // NULL-check, not ||: One Good Purse sets bountyMul to 0 and zero must hold
    var bMul = this.mods.bountyMul != null ? this.mods.bountyMul : 1;
    var bounty = Math.round((greed ? base.bounty * 1.5 : base.bounty) * bMul);
    for (var kp = 0; kp < this.towers.length; kp++) {     // Tithe Press takes its cut
      var kt = this.towers[kp];
      if (kt.level >= 2 && kt.type === 'press') {
        var kr = lvlRow(kt);
        if (kr.killGold) {
          var kMan = this.hero.manned && this.hero.manTid === kt.tid;
          bounty += Math.round(kr.killGold * (kMan ? (TOWER_TYPES.press.mannedGold || 1) : 1));
        }
      }
    }
    this.gold += bounty;
    this.kills++;
    var p = { x: e.px, y: e.py };
    if (e.stolen > 0) {                                     // recover the treasure!
      this.hoard += e.stolen;
      this.fxQueue.push({ k: 'recover', x: p.x, y: p.y, n: e.stolen });
      Sfx.play('recover');
    }
    // SPLITTER — breaks into two smaller raiders where it fell. Queued as a
    // spawn so the halves enter through the same path the sim already owns.
    if (base.splitInto && !e.summoned) {
      var sb = ENEMY_TYPES[base.splitInto];
      for (var sp2 = 0; sp2 < base.splitCount; sp2++) {
        this.enemies.push({
          id: this.nextId++, type: base.splitInto,
          d: Math.max(0, Math.min(PATH.len - 1, e.d + (sp2 ? 9 : -9))),
          hp: Math.round(sb.hp * base.splitHp), maxHp: Math.round(sb.hp * base.splitHp),
          spd: sb.spd, slowT: 0, slowF: 1, burnT: 0, burnDps: 0, bleedT: 0, bleedDps: 0,
          scaldT: 0, brittleT: 0, brittleMul: 1, deepT: 0, groundedT: 0, shaken: 0, sapT: 0,
          blinkT: 0, healT: 1, grabT: 0, auraF: 1,
          stolen: 0, fleeing: e.fleeing, flyer: false, summoned: true, shieldBroken: false,
          flashT: 0, px: e.px, py: e.py,
        });
      }
      this.fxQueue.push({ k: 'float', x: p.x, y: p.y - 30, txt: 'IT SPLITS!', c: '#a8e6ff' });
      this.fxQueue.push({ k: 'boom', x: p.x, y: p.y, r: 26 });
      Sfx.play('split');
    }
    if (e.type === 'boss') {
      // the payoff of a 20-wave level: freeze, shake, and a gold burst worth
      // the wait. Still inside the hitch ceiling (>120ms reads as a stutter).
      this.hitstopT = 0.12;
      this.fxQueue.push({ k: 'float', x: p.x, y: p.y - 40, txt: 'THE KING FALLS!', c: '#ffd75e' });
      this.fxQueue.push({ k: 'pulse', x: p.x, y: p.y, r: 150, n: 1 });
      for (var bd = 0; bd < 3; bd++) {
        this.fxQueue.push({ k: 'boom', x: p.x + (bd - 1) * 26, y: p.y + (bd % 2 ? 14 : -10), r: 54 });
      }
    }
    this.fxQueue.push({ k: 'death', x: p.x, y: p.y, g: bounty, boss: e.type === 'boss' });
    Sfx.play('coin');
    // THE KILL WAS THE ONE HIT IN THE GAME THAT RENDERED NO IMPACT FRAME.
    // _damage sets e.flashT for the white re-draw, then removes a lethally hit
    // raider in the SAME sim step — so the flash was written onto an object that
    // never reached another draw(). Every glancing blow flashed; the kill, the
    // beat the whole tower is FOR, just blinked out under a gold puff.
    // The husk is that missing frame: the corpse keeps rendering for ~7 frames,
    // white-hot and fading, while the sim has already forgotten it. Cosmetic
    // only — the sim never reads this list, so removal timing is untouched and
    // determinism holds.
    this.husks.push({ e: e, x: p.x, y: p.y, t: HUSK_T, T: HUSK_T });
    this.enemies.splice(i, 1);
  };
  Game.prototype._gameOver = function (won) {
    this.state = won ? 'won' : 'lost';
    this._bossWave = false;
    // Victory: the bed ducks and comes back — the cave is still his.
    // Defeat: the bed STOPS. They carried it out, and the room has nothing to
    // say about it. The asymmetry is the point.
    this._mCue = won ? { name: 'win' } : { name: 'lose', stop: true };
    this.menu = null; this.infoCard = null; // an open chooser/menu must not outlive the run
    this.resultLockT = 0.8;                 // battle taps can't skip the screen
    this._resultT = 0;                      // cosmetic: drives the star landings
    // stars grade COINS LOST FOREVER (escaped carriers), not the closing balance
    var stars = this.stolenLost <= 5 ? 3 : this.stolenLost <= 20 ? 2 : 1;
    // leaks ride along, worst first — the result screen's only job beyond the
    // score is telling the player what to do differently next time.
    var leakRows = [];
    for (var lt in this.leaks) leakRows.push({ type: lt, coins: this.leaks[lt].coins,
                                               runs: this.leaks[lt].runs, wave: this.leaks[lt].firstWave });
    leakRows.sort(function (a, b) { return b.coins - a.coins || a.wave - b.wave; });
    this.result = { won: won, stars: stars, hoard: this.hoard, lost: this.stolenLost, kills: this.kills, wave: this.wave,
                    leaks: leakRows, toll: this.tollRecovered,
                    trial: this.trial ? TRIALS[this.trial].name : null,
                    // duel scoreboard: both closing hoards and the margin that
                    // decided it. knockout = their cave fell before the bell.
                    rival: this.rival ? this.rival.name : null,
                    rivalHoard: this.rival ? this.rivalHoard : null,
                    margin: this.rival ? (this.hoard - this.rivalHoard) : null,
                    knockout: this.rival ? (this.rivalHoard <= 0 || this.hoard <= 0) : false };
    if (this.mode === 'duel' && won && this.rival) {
      var prevD = Save.data.duels[this.rival.id];
      var mgn = Math.max(0, this.hoard - this.rivalHoard);
      // record OBJECT, never a bare number — a duel won on the tiebreak has a
      // margin of 0, and a falsy record would erase the badge that earned it
      if (!prevD || !prevD.w || mgn > (prevD.m | 0)) Save.data.duels[this.rival.id] = { w: 1, m: mgn };
    }
    if (this.mode === 'campaign' && won && stars > Save.data.stars[this.levelIdx]) Save.data.stars[this.levelIdx] = stars;
    if (this.mode === 'campaign' && won && this.trial) {           // trial badge
      if (!Save.data.trials[this.levelIdx]) Save.data.trials[this.levelIdx] = {};
      Save.data.trials[this.levelIdx][this.trial] = 1;
    }
    if (this.mode === 'daily') {
      var today2 = dayNumber();
      if (Save.data.daily.day !== today2) Save.data.daily = { day: today2, best: 0 };
      if (this.wave > Save.data.daily.best) Save.data.daily.best = this.wave;
      if (this.wave > Save.data.dailyBestWave) Save.data.dailyBestWave = this.wave;
    }
    Save.write();
    // daily board: submit this run, then pull today's top — UI-only state
    if (this.mode === 'daily' && Lb.on()) {
      var self = this;
      this.lbRows = 'loading';
      Lb.finishRun(this.wave, this.kills, this.seed, function () {
        Lb.top(10, function (rows) { self.lbRows = rows || 'error'; });
      });
    } else this.lbRows = null;
    Sfx.play(won ? 'win' : 'lose');
  };

  // ---- tap handling (runs inside update — deterministic order) ----------
  // Priority: letterbox reject -> screens -> OPEN MENU -> hero -> towers/pads
  // -> HUD buttons -> start-wave. Interactive elements always beat big rects.
  Game.prototype._handleTap = function (tap) {
    var w = tap;   // world-space + .vx/.vy view-space (converted at capture)
    // TWO coordinate systems in R3D mode. The GROUND (pads, towers, walking,
    // placement) lives under the 3D camera -> raycast. 2D-DRAWN UI (title,
    // forge/trials screens, menu buttons, fork cards) is laid out in linear
    // overlay coords -> keep the linear conversion. Mixing them up puts every
    // button's hit zone somewhere else than its pixels.
    var wl = { x: tap.x, y: tap.y, vx: tap.vx, vy: tap.vy };   // linear (2D UI)
    if (R3D.on && R3D.ready && this.state === 'playing' && tap.vx !== undefined) {
      var w3 = R3D.pick(tap.vx, tap.vy, this);
      if (w3) w = { x: w3.x, y: w3.y, vx: tap.vx, vy: tap.vy };
    }
    var v = this.view;
    var vx = w.vx !== undefined ? w.vx : w.x + v.ox;
    var vy = w.vy !== undefined ? w.vy : w.y + v.oy;

    // FORK CHOOSER IS MODAL — it swallows every tap before any other surface
    // (HUD, start-wave, info card). A card buys; anywhere else closes. Bands
    // included: w is out-of-world there, which simply reads as "close".
    if (this.state === 'playing' && this.menu && this.menu.forkFor !== undefined) {
      var ftw = this.towers[this.menu.forkFor];
      if (ftw && ftw.level === 1) {
        var fcost = TOWER_TYPES[ftw.type].levels[1].upgradeCost;
        var cards = this._forkCards(ftw);
        for (var fc = 0; fc < 2; fc++) {
          var cr = cards[fc];
          if (w.x >= cr.x && w.x <= cr.x + cr.w && w.y >= cr.y && w.y <= cr.y + cr.h) {
            if (this.gold >= fcost) {
              this.gold -= fcost; ftw.level = 2; ftw.fork = fc;
              var fpad = ftw;
              var fkRow = TOWER_TYPES[ftw.type].forks[fc];
              this.fxQueue.push({ k: 'place', x: fpad.x, y: fpad.y });
              this.fxQueue.push({ k: 'float', x: fpad.x, y: fpad.y - 52, txt: fkRow.name + '!', c: fc ? '#a8e6ff' : '#ffd75e' });
              Sfx.play('upg');
            }
            this.menu = null; return;
          }
        }
      }
      this.menu = null; return;                              // tapped elsewhere: close
    }
    // an open enemy card swallows its tap (dismiss) — x-bounded to the panel,
    // so a world tap beside the card still reaches pads under the band
    if (this.infoCard && this.state === 'playing') {
      var Gc = this._hudGeom();
      var cw2 = Math.min(this.view.w - 24, 372);
      if (vy > Gc.topY + 56 && vy < Gc.topY + 114 &&
          vx > this.view.w / 2 - cw2 / 2 && vx < this.view.w / 2 + cw2 / 2) { this.infoCard = null; return; }
    }
    // SCREEN-ANCHORED HUD first — it lives in the bands on tall phones
    if (this.state === 'playing') {
      var G = this._hudGeom();
      if (vy >= G.btnY && vy <= G.btnY + 34) {
        if (vx >= G.spd && vx <= G.spd + 44) { this.speed = this.speed === 1 ? 2 : 1; return; }
        if (vx >= G.pause && vx <= G.pause + 44) { this.setPaused(true); return; }
        if (vx >= G.mute && vx <= G.mute + 44) { Sfx.toggle(); return; }
      }
      // A MACHINE IN HAND MEANS THE NEXT TAP ON LEGAL GROUND IS A BUILD.
      //
      // The action row sits over the bottom of the cavern floor, so without
      // this the START WAVE and BREATH buttons eat taps aimed at the ground
      // beneath them. Measured against the engine's own _placeCheck: 680
      // buildable positions sit under START WAVE and 460 under BREATH. A
      // player aiming at any of them with a machine in hand loses their whole
      // build phase to a button they were not pressing.
      //
      // fb78c1a separately lifted the authored pads clear of the shelf, which
      // fixed the worst case (a pad you could not build on). It does not fix
      // this one: free placement means the whole floor is a build target, so
      // the ~1,140 positions above are still live without this guard.
      //
      // Deliberately narrow: it only defers a HUD button when a machine is
      // armed AND the ground under the finger is actually buildable. Armed
      // over illegal ground still starts the wave, so the button never goes
      // dead and needs no second tap to reach.
      var armedOverGround = this.shopPick >= 0 && this._placeCheck(w.x, w.y).ok;
      // ...and it did NOT cover the management direction, which is the common
      // one. Once a machine STANDS on that ground, _placeCheck returns false
      // ('too close to another machine'), so armedOverGround goes false and the
      // button eats the tap forever after. Measured on stock pads: L1 pad (56,684)
      // sits inside the BREATH rect and L3 pad (224,684) inside START WAVE on
      // EVERY device tested -- so tapping your own machine fired the breath, or
      // started the next wave and took the early-call bonus with it.
      // The file already claims this priority twice ('towers / pads beat the HUD
      // bands and the start-wave rect'); this makes it true.
      var twUnder = false;
      if (this.shopPick < 0) {                    // a machine in hand still places
        for (var tu = 0; tu < this.towers.length; tu++) {
          var tud = this.towers[tu], ux = w.x - tud.x, uy = w.y - tud.y;
          if (ux * ux + uy * uy < 32 * 32) { twUnder = true; break; }
        }
      }
      if (!armedOverGround && !twUnder) {
        if (!this.waveActive && this.wave < this.totalWaves() &&
            vx >= G.cx - 92 && vx <= G.cx + 92 && vy >= G.startY && vy <= G.startY + 52) {
          this.startWave(); return;
        }
        if (vx >= G.breathX && vx <= G.breathX + 62 && vy >= G.breathY && vy <= G.breathY + 62) {
          if (!this.mods.breathOff) this.hero.castBreath = true;
          return;                                  // the breath's own button
        }
      }
      // THE SHOP: pick a machine, then tap the cavern to place it.
      // The card test is EXACT — it used to claim the whole width of the band
      // and, when a machine was armed, swallow anything that landed in it. On
      // a screen with no letterbox band the shop sits over the cavern floor,
      // so a tap aimed at the ground behind it silently disarmed the shop
      // instead of building. Now only the cards themselves consume a tap and
      // everything between and around them falls through to the world.
      if (vy >= G.shopY && vy <= G.shopY + G.shopH) {
        var shelfT = this._shelf();
        for (var sc = 0; sc < shelfT.length; sc++) {
          var sxp = G.shopX + sc * G.shopStep;
          if (vx >= sxp && vx <= sxp + G.shopW) {
            this.shopPick = this.shopPick === sc ? -1 : sc;
            this.placeHint = null;
            Sfx.play('place');
            return;
          }
        }
      }
    }

    if (this.state === 'menu') {
      // Geometry comes from _titleGeom(), the same call _drawTitle draws from,
      // so a layout change can never move a button away from its hit box.
      var TG = this._titleGeom();
      // Bound by the ROWS, not by MAPS.length. These had drifted apart: the
      // geometry hands back exactly three rows while this loop counted maps,
      // so the day a fourth map is authored TG.rows[3] is undefined and hit()
      // throws on the first tap the title screen ever receives. Defusing it
      // costs one Math.min and removes a crash that is one array entry away.
      var nRows = Math.min(MAPS.length, TG.rows.length);
      for (var lv = 0; lv < nRows; lv++) {
        if (hit(w, TG.rows[lv])) {
          if (!Save.unlocked(lv)) return;        // locked: tap does nothing
          this.reset(1, 'campaign', lv); this.state = 'playing'; return;
        }
      }
      if (hit(w, TG.daily)) { this.reset(dailySeed(), 'daily'); this.state = 'playing'; return; }
      if (hit(w, TG.duel)) { this.state = 'duel'; return; }
      if (hit(w, TG.pills[0])) { this.state = 'forge'; return; }
      if (hit(w, TG.pills[1])) { if (Save.starsTotal() > 0) this.state = 'trials'; return; }
      if (hit(w, TG.pills[2])) { Sfx.toggle(); return; }
      return;
    }
    if (this.state === 'duel') {
      var DGt = duelGeom();
      for (var rq = 0; rq < RIVAL_ORDER.length; rq++) {
        var ryq = DGt.top + rq * DGt.pitch;
        if (w.y > ryq && w.y < ryq + DGt.h && w.x > DGt.x && w.x < DGt.x + DGt.w) {
          // A rival with no baked curve cannot be fought: there is nobody on
          // the other side. Refuse the tap rather than starting a duel that
          // would score against a frozen 60 and always be won.
          if (rivalHoardAt(rq, duelSeedIdx(rq), 0) === null) return;
          this.reset(0, 'duel', 0, null, rq);
          this.state = 'playing'; return;
        }
      }
      if (w.y > DGt.backY && w.y < DGt.backY + 40 &&
          w.x > WORLD_W / 2 - 70 && w.x < WORLD_W / 2 + 70) { this.state = 'menu'; return; }
      return;
    }
    if (this.state === 'trials') {
      var TGt = trialGeom();
      for (var tr = 0; tr < TRIAL_ORDER.length; tr++) {
        var try2 = TGt.top + tr * TGt.pitch;
        if (w.y > try2 && w.y < try2 + TGt.h) {
          for (var tlv = 0; tlv < MAPS.length; tlv++) {
            var chx = WORLD_W - 168 + tlv * 46;
            if (w.x > chx && w.x < chx + 40 && w.y > try2 + TGt.chipY && w.y < try2 + TGt.chipY + TGt.chipH) {
              if (!(Save.data.stars[tlv] > 0)) return;       // trial needs the level won first
              this.reset(1, 'campaign', tlv, TRIAL_ORDER[tr]);
              this.state = 'playing'; return;
            }
          }
        }
      }
      if (w.y > 640 && w.y < 680 && w.x > WORLD_W / 2 - 70 && w.x < WORLD_W / 2 + 70) {
        this.state = 'menu'; return;
      }
      return;
    }
    if (this.state === 'forge') {
      var rows0 = 250;
      for (var fn = 0; fn < FORGE_NODES.length; fn++) {
        var ry = rows0 + fn * 74;
        if (w.y > ry && w.y < ry + 62 && w.x > WORLD_W - 118 && w.x < WORLD_W - 30) {
          var node = FORGE_NODES[fn];
          var cur = Save.data.forge[node.id] | 0;
          if (cur < node.ranks && Save.starsTotal() - Save.forgeSpent() > 0) {
            Save.data.forge[node.id] = cur + 1; Save.write(); Sfx.play('upg');
          }
          return;
        }
      }
      if (w.y > 640 && w.y < 680) {
        if (w.x > WORLD_W / 2 - 150 && w.x < WORLD_W / 2 - 10) {   // respec
          Save.data.forge = {}; Save.write(); Sfx.play('sell'); return;
        }
        if (w.x > WORLD_W / 2 + 10 && w.x < WORLD_W / 2 + 150) {   // back
          this.state = 'menu'; return;
        }
      }
      return;
    }
    if (this.state === 'won' || this.state === 'lost') {
      if (this.resultLockT > 0) return;      // a mid-battle tap can't skip the screen
      // Leaving a duel drops OUT of duel mode: a reset that stayed in 'duel'
      // would carry this.rival back to the title, and every later reset would
      // re-derive an arena for a fight nobody asked for.
      this.reset(this.mode === 'daily' ? dailySeed() : 1,
                 this.mode === 'duel' ? 'campaign' : this.mode);
      this.state = 'menu';
      return;
    }
    if (this.state === 'paused') {
      // QUIT TO TITLE button on the pause overlay
      if (w.x > WORLD_W / 2 - 90 && w.x < WORLD_W / 2 + 90 && w.y > WORLD_H / 2 + 56 && w.y < WORLD_H / 2 + 104) {
        this.reset(1, 'campaign'); this.state = 'menu'; return;
      }
      this.setPaused(false); return;
    }

    // world interactions only within the sim world (bands are HUD territory)
    if (w.x < 0 || w.x > WORLD_W || w.y < 0 || w.y > WORLD_H) return;

    // OPEN MENU first — its buttons beat everything else on screen
    // (the fork chooser was already handled modally above, before the HUD)
    if (this.menu) {
      var m = this.menu;
      if (m.towerIdx !== undefined) {                 // manage menu — nearest-wins
        var tw = this.towers[m.towerIdx];
        if (tw) {
          var pad2 = tw;
          pad2 = this._uiAnchor(pad2);
          // MUST mirror the draw: supports have no AIM, so they have 3 buttons.
          // If these two ever disagree, a tap sells the machine the player meant
          // to man. Derived from the same predicate, deliberately.
          var isSup2 = !!TOWER_TYPES[tw.type].support;
          var nb2 = isSup2 ? 3 : 4;
          var btns = [];
          for (var qb = 0; qb < nb2; qb++) btns.push(this._menuBtnPos(pad2, qb, nb2));
          var lvl = lvlRow(tw);
          var bi2 = -1, bd2 = 24 * 24;
          for (var mb2 = 0; mb2 < btns.length; mb2++) {
            var mdx = wl.x - btns[mb2].x, mdy = wl.y - btns[mb2].y, mdd = mdx * mdx + mdy * mdy;
            if (mdd < bd2) { bd2 = mdd; bi2 = mb2; }
          }
          if (bi2 !== -1) {
            if (bi2 === 0) {                                 // upgrade
              if (tw.level === 0 && this.gold >= lvl.upgradeCost) {
                this.gold -= lvl.upgradeCost; tw.level++;
                this.fxQueue.push({ k: 'place', x: pad2.x, y: pad2.y });
                Sfx.play('upg');
                this.menu = null;
              } else if (tw.level === 1 && this.gold >= lvl.upgradeCost) {
                // L3 is a commitment: open the fork chooser, charge on the pick
                this.menu = { forkFor: m.towerIdx };
                Sfx.play('place');
              }
            } else if (!isSup2 && bi2 === 1) {               // cycle aim mode (menu stays open)
              tw.targeting = ((tw.targeting | 0) + 1) % 3;
              Sfx.play('place');
            } else if (bi2 === (isSup2 ? 1 : 2)) {           // MAN / LEAVE the machine
              if (this.hero.manTid === tw.tid) { this.hero.manTid = -1; this.hero.manned = false; }
              else { this.hero.manTid = tw.tid; }
              Sfx.play('place');
              this.menu = null;
            } else {                                         // sell
              this.gold += this._sellValue(tw);
              this.towers.splice(m.towerIdx, 1);
              Sfx.play('sell');
              this.menu = null;
            }
            return;
          }
        }
      }
      this.menu = null;                                     // tapped elsewhere: close
      return;
    }

    // Mother's Breath: the armed keep eats the tap
    if (this.motherReady) {
      var kdx = w.x - MAP.keep.x, kdy = w.y - (MAP.keep.y - 20);
      if (kdx * kdx + kdy * kdy < 70 * 70) { this.castMother = true; return; }
    }

    // towers / pads beat the HUD bands and the start-wave rect
    for (var t = 0; t < this.towers.length; t++) {
      var pd = this.towers[t];
      var tdx = w.x - pd.x, tdy = w.y - pd.y;
      if (tdx * tdx + tdy * tdy < 32 * 32) { this.menu = { towerIdx: t }; return; }
    }
    // (empty pads are no longer tap-to-build — the shop owns building now, and
    // a pad is simply cheaper ground. That frees the whole floor for walking.)

    // PLACING a machine from the shop: this tap is the placement.
    if (this.shopPick >= 0) {
      var stid = this._shelf()[this.shopPick];
      if (!stid) { this.shopPick = -1; return; }
      var chk = this._placeCheck(w.x, w.y);
      if (!chk.ok) {
        this.fxQueue.push({ k: 'float', x: w.x, y: w.y - 18, txt: chk.why, c: '#ff9a9a' });
        return;                                   // stay armed: let them try again
      }
      var cost = Math.round(TOWER_TYPES[stid].cost * (chk.discount ? PAD_DISCOUNT : 1) * crowdMul(this.towers.length));
      if (this.gold < cost) {
        this.fxQueue.push({ k: 'float', x: w.x, y: w.y - 18, txt: 'not enough gold', c: '#ff9a9a' });
        return;
      }
      var bx = w.x, by = w.y;
      if (chk.pad >= 0) { bx = MAP.pads[chk.pad].x; by = MAP.pads[chk.pad].y; }   // snap to the pad
      this.gold -= cost;
      this.towers.push({ tid: this.nextId++, type: stid, level: 0, fork: 0,
                         x: bx, y: by, padIdx: chk.pad, cd: 0, targeting: 0, shotT: 9 });
      this.fxQueue.push({ k: 'place', x: bx, y: by });
      if (chk.discount) this.fxQueue.push({ k: 'float', x: bx, y: by - 40, txt: 'PAD BONUS -20%', c: '#9ef58f' });
      Sfx.play('place');
      this.shopPick = -1; this.placeHint = null;
      return;
    }

    // ANY other world tap WALKS WICK THERE. He used to need selecting first,
    // and tapping him fired his breath instead of selecting — so once breath
    // was charged (i.e. nearly always) he could not be moved at all.
    var hh = this.hero;
    hh.manTid = -1; hh.manned = false;      // walking off a machine leaves it
    var tx = clamp(w.x, 20, WORLD_W - 20), ty = clamp(w.y, 120, WORLD_H - 30);
    for (var pj = 0; pj < MAP.pads.length; pj++) {   // never park ON a pad's tap target
      var pp = MAP.pads[pj];
      var pdx2 = tx - pp.x, pdy2 = ty - pp.y;
      var dist2 = Math.sqrt(pdx2 * pdx2 + pdy2 * pdy2);
      if (dist2 < 40) {
        if (dist2 < 0.001) { tx = pp.x + 40; }
        else { tx = pp.x + pdx2 / dist2 * 40; ty = pp.y + pdy2 / dist2 * 40; }
      }
    }
    hh.tx = clamp(tx, 20, WORLD_W - 20); hh.ty = clamp(ty, 120, WORLD_H - 30);
  };
  // Where UI anchored to a world object should DRAW: identity in 2D, the
  // 3D projection remapped into overlay coords when the 3D world is live.
  Game.prototype._uiAnchor = function (o) {
    return (R3D.on && R3D.ready) ? R3D.remap(o.x, o.y) : o;
  };
  Game.prototype._towerByTid = function (tid) {
    for (var i = 0; i < this.towers.length; i++) if (this.towers[i].tid === tid) return this.towers[i];
    return null;
  };
  // FREE PLACEMENT (VANUS asked for the Bloons shop model): a machine may go
  // anywhere off the road. The old pads are not gone — they are DISCOUNT
  // ground, so the hand-authored chokepoints still mean something.
  Game.prototype._nearestPad = function (x, y) {
    var best = -1, bd = PAD_SNAP * PAD_SNAP;
    for (var i = 0; i < MAP.pads.length; i++) {
      if (this._padTower(i) !== -1) continue;
      var p = MAP.pads[i], dx = x - p.x, dy = y - p.y, d2 = dx * dx + dy * dy;
      if (d2 < bd) { bd = d2; best = i; }
    }
    return best;
  };
  /// The machines currently on the shelf, in shelf order. shopPick indexes
  /// THIS, not TOWER_ORDER — the draw loop and both tap sites must agree or a
  /// tap buys a different machine from the one under the finger.
  Game.prototype._shelf = function () {
    var out = [], mode = this.mode;
    for (var i = 0; i < TOWER_ORDER.length; i++) {
      // THE KOBOLD PICNIC TRIAL WAS INERT. Its whole pitch is "Crossbow crews
      // are picnicking — build without them", and mods.bannedTower was written
      // by reset() and then read by NOTHING: the shelf offered the crossbow,
      // the tap armed it, the build placed it, and the win stamped the badge
      // regardless. A third of the trial content was a normal run wearing a
      // label, and the star it awarded was for a challenge nobody performed.
      // Enforcing it HERE is why _shelf exists — one source, so the draw loop
      // and both tap sites cannot disagree about what is buyable.
      if (this.mods.bannedTower === TOWER_ORDER[i]) continue;
      if (towerUnlocked(TOWER_ORDER[i], mode)) out.push(TOWER_ORDER[i]);
    }
    return out;
  };

  Game.prototype._placeCheck = function (x, y) {
    // An authored pad is ALWAYS valid ground — it was placed by hand and may
    // sit outside the free-build bounds (several are below WORLD_H - 34, and
    // they hug the road by design). Check it first or the game refuses to
    // build on its own pads.
    var padFirst = this._nearestPad(x, y);
    if (padFirst >= 0) {
      for (var q = 0; q < this.towers.length; q++) {
        var qt = this.towers[q], qdx = MAP.pads[padFirst].x - qt.x, qdy = MAP.pads[padFirst].y - qt.y;
        if (qdx * qdx + qdy * qdy < 30 * 30) return { ok: false, why: 'too close to another machine' };
      }
      return { ok: true, pad: padFirst, discount: true };
    }
    if (x < 26 || x > WORLD_W - 26 || y < 190 || y > WORLD_H - 34) return { ok: false, why: 'off the cavern floor' };
    var kdx = x - MAP.keep.x, kdy = y - MAP.keep.y;
    if (kdx * kdx + kdy * kdy < 96 * 96) return { ok: false, why: 'too close to the hoard' };
    // the road: a machine must not stand in the raiders' way
    var lim = MAP.pathW * 0.5 + 16;
    for (var d = 0; d <= PATH.len; d += 7) {
      var pt = pathPointAt(d), rdx = x - pt.x, rdy = y - pt.y;
      if (rdx * rdx + rdy * rdy < lim * lim) return { ok: false, why: 'on the road' };
    }
    for (var t = 0; t < this.towers.length; t++) {
      var tw = this.towers[t], tdx = x - tw.x, tdy = y - tw.y;
      if (tdx * tdx + tdy * tdy < 46 * 46) return { ok: false, why: 'too close to another machine' };
    }
    var pi = this._nearestPad(x, y);
    return { ok: true, pad: pi, discount: pi >= 0 };
  };
  Game.prototype._padTower = function (padIdx) {
    for (var t = 0; t < this.towers.length; t++) if (this.towers[t].padIdx === padIdx) return t;
    return -1;
  };
  Game.prototype._sellValue = function (tw) {
    var tt = TOWER_TYPES[tw.type], spent = tt.cost;
    for (var l = 0; l < tw.level; l++) spent += tt.levels[l].upgradeCost;
    return Math.round(spent * (this.mods.sellRefund || CFG.sellRefund));
  };
  Game.prototype._forkCards = function (tw) {
    // two stacked cards above the pad, clamped fully on-world
    var pad = this._uiAnchor(tw);
    var w = 200, h = 64, gap = 10;
    var cx = clamp(pad.x, w / 2 + 8, WORLD_W - w / 2 - 8);
    var y0 = clamp(pad.y - 170, 96, WORLD_H - (h * 2 + gap + 40));
    return [
      { x: cx - w / 2, y: y0, w: w, h: h },
      { x: cx - w / 2, y: y0 + h + gap, w: w, h: h },
    ];
  };
  Game.prototype._menuBtnPos = function (pad, i, n) {
    // arc of buttons above the pad, clamped inside the world
    var spread = Math.min(2.4, 0.55 * n);
    var a0 = -Math.PI / 2 - spread / 2 + (n > 1 ? spread * (i / (n - 1)) : 0);
    var r = 56;
    var x = clamp(pad.x + Math.cos(a0) * r, 30, WORLD_W - 30);
    var y = clamp(pad.y + Math.sin(a0) * r, 90, WORLD_H - 40);
    return { x: x, y: y };
  };

  // ---- COSMETIC lane. Per-frame, variable dt, Math.random. ----------------
  Game.prototype._cosmetic = function (dtRaw) {
    // spend the fx queue emitted by the deterministic sim
    // note: handlers may push follow-up events (coinfly); the loop length is
    // re-read each pass so chained events spend in the same frame
    for (var q = 0; q < this.fxQueue.length; q++) {
      var fx = this.fxQueue[q];
      // R3D taps the same event stream (cosmetic -> cosmetic, sim untouched)
      if (R3D.on && R3D.ready) R3D.event(fx);
      if (fx.k === 'hit' || fx.k === 'bite') this._burst(fx.x, fx.y, fx.c || '#ffb14e', 5, 60);
      else if (fx.k === 'coinfly') {
        for (var cf = 0; cf < fx.n; cf++) {
          this.particles.push({
            kind: 'coin', x: fx.x + (Math.random() - 0.5) * 14, y: fx.y + (Math.random() - 0.5) * 8,
            tx: fx.tx, ty: fx.ty, arc: 30 + Math.random() * 40,
            life: 0.5 + Math.random() * 0.2, T: 0.7,
          });
        }
      }
      else if (fx.k === 'death') {
        this._burst(fx.x, fx.y, '#ffd75e', fx.boss ? 26 : 9, 90);
        this.floats.push({ x: fx.x, y: fx.y, txt: '+' + fx.g, c: '#ffd75e', t: 1 });
        this.fxQueue.push({ k: 'coinfly', x: fx.x, y: fx.y, tx: 100, ty: 40, n: fx.boss ? 6 : 2 });
        if (fx.boss) this.shake = Math.min(1, this.shake + 0.7);
      }
      else if (fx.k === 'herodown') {
        this._burst(fx.x, fx.y - 12, '#ff7b7b', 18, 120);
        this.floats.push({ x: fx.x, y: fx.y - 40, txt: 'WICK IS DOWN!', c: '#ff7b7b', t: 1.8 });
        this.shake = Math.min(1, this.shake + 0.5);
      }
      else if (fx.k === 'boom') { this._burst(fx.x, fx.y, '#ff8a3c', 14, 110); this.shake = Math.min(1, this.shake + 0.25); }
      else if (fx.k === 'steal') {
        // THE SCOOP — coins fly OFF THE PILE and INTO him. Direction is the
        // whole story of this beat; the old outward red burst read as damage
        // at the one moment the game is about a TRANSFER.
        var sn = fx.n || 1, sc = Math.min(8, 2 + Math.round(sn * 0.3));
        for (var sp2 = 0; sp2 < sc; sp2++) {
          this.particles.push({
            kind: 'coin',
            x: MAP.mound.x + (Math.random() - 0.5) * MAP.mound.rx * 1.4,
            y: MAP.mound.y + (Math.random() - 0.5) * 14,
            tx: fx.x, ty: fx.y - 18, arc: 24 + Math.random() * 30,
            life: 0.22 + sp2 * 0.035, T: 0.22 + sp2 * 0.035,
          });
        }
        this._burst(fx.x, fx.y, '#ff5b5b', 4, 70);
        this.floats.push({ x: fx.x, y: fx.y, txt: '-' + sn + ' treasure!', c: '#ff7b7b', t: 1.4 });
        this.shake = Math.min(1, this.shake + 0.12 + 0.014 * sn);   // was a flat 0.45 for ANY amount
      }
      else if (fx.k === 'recover') {
        this._burst(fx.x, fx.y, '#9ef58f', 10, 90);
        // SHAKE-LOOSE flash: a near-white ring is the most detectable transient
        // on a dark floor — it tells the eye WHERE, the shorter Ledger is WHAT
        this.particles.push({ kind: 'ring', x: fx.x, y: fx.y, r: 8, R: 26, life: 0.25, T: 0.25, c: '#fff8dc' });
        this.floats.push({ x: fx.x, y: fx.y, txt: '+' + fx.n + ' recovered!', c: '#9ef58f', t: 1.4 });
        this.fxQueue.push({ k: 'coinfly', x: fx.x, y: fx.y, tx: MAP.mound.x, ty: MAP.mound.y, n: Math.min(5, fx.n) });
      }
      else if (fx.k === 'escape') {
        var en2 = fx.n || 1;
        this.floats.push({ x: fx.x + 30, y: fx.y - 20, txt: 'stolen!', c: '#ff5b5b', t: 1.2 });
        this.shake = Math.min(1, this.shake + 0.10 + 0.030 * en2);   // 0.13 @1 coin -> 0.85 @25
        // gone FOREVER flies OUT through the mouth — the exact opposite
        // direction of 'recover's flight home to the mound
        this.fxQueue.push({ k: 'coinfly', x: fx.x, y: fx.y, n: Math.min(8, en2),
          tx: fx.x + (fx.x < WORLD_W / 2 ? -110 : 110), ty: fx.y + 90 });
      }
      else if (fx.k === 'breath') {
        // FROM THE MOUTH. The burst used to spawn at fx.y — Wick's FEET — so
        // the one thing the game is named after looked like it came out of the
        // floor. The muzzle offset is a RENDER fact (sprite height, facing), so
        // it is computed here in the cosmetic lane and never enters the sim.
        var mz = this._muzzle();
        this._burst(mz.x, mz.y, '#ff9a3c', 30, 140);
        // a directed jet on top of the radial burst: the breath has a SOURCE
        for (var bj = 0; bj < 14; bj++) {
          var ja = mz.f * (0.15 + Math.random() * 0.55) - 0.35;
          var js = 90 + Math.random() * 120;
          this.particles.push({ kind: 'dot', x: mz.x, y: mz.y,
                                vx: Math.cos(ja) * js * mz.f, vy: Math.sin(ja) * js - 30,
                                r: 2 + Math.random() * 3, life: 0.28 + Math.random() * 0.22,
                                T: 0.5, c: bj % 3 ? '#ffd75e' : '#fff3cf' });
        }
        this._breathT = 0.42;                 // drives the open jaw + head recoil
        this.shake = Math.min(1, this.shake + 0.35);
      }
      else if (fx.k === 'mother') {
        // Auremma half-stirs: full-screen warm exhale
        this.particles.push({ kind: 'flash', life: 0.9, T: 0.9 });
        this.particles.push({ kind: 'ring', x: MAP.keep.x + 55, y: MAP.keep.y - 68, r: 20, R: 900, life: 0.9, T: 0.9, c: '#ff9a3c' });
        this._burst(MAP.keep.x + 55, MAP.keep.y - 68, '#ffcf6a', 40, 220);
        this.floats.push({ x: WORLD_W / 2, y: 340, txt: 'MOTHER STIRS…', c: '#ffcf6a', t: 2.2 });
        this.shake = 1;
      }
      else if (fx.k === 'place') this._burst(fx.x, fx.y, '#c9b8ff', 10, 80);
      else if (fx.k === 'blink') { this._burst(fx.x1, fx.y1, '#b39dff', 6, 70); this._burst(fx.x2, fx.y2, '#b39dff', 6, 70); }
      else if (fx.k === 'heal') this._burst(fx.x, fx.y, '#8fffd0', 6, 50);
      else if (fx.k === 'pulse') this.particles.push({ kind: 'ring', x: fx.x, y: fx.y, r: 10, R: fx.r, life: 0.35, T: 0.35, c: '#a8e6ff' });
      else if (fx.k === 'spit') this.particles.push({ kind: 'tracer', x1: fx.x1, y1: fx.y1, x2: fx.x2, y2: fx.y2, life: 0.1, T: 0.1, c: '#ffb14e' });
      else if (fx.k === 'snap') {            // crossbow release: dust off the rail
        var sang = Math.atan2(fx.ty - fx.y, fx.tx - fx.x);
        this.particles.push({ kind: 'tracer', x1: fx.x, y1: fx.y,
          x2: fx.x + Math.cos(sang) * 16, y2: fx.y + Math.sin(sang) * 16,
          life: 0.06, T: 0.06, c: 'rgba(255,240,200,0.9)' });
        for (var sn = 0; sn < 3; sn++) {
          var sa2 = sang + Math.PI + (Math.random() - 0.5) * 1.5;
          this.particles.push({ kind: 'dot', x: fx.x, y: fx.y,
            vx: Math.cos(sa2) * (18 + Math.random() * 26), vy: Math.sin(sa2) * (18 + Math.random() * 26) - 8,
            r: 0.8 + Math.random(), life: 0.16, T: 0.16, c: 'rgba(214,196,160,0.8)' });
        }
      }
      else if (fx.k === 'muzzle') {          // the puff of flame leaving his jaws
        var mang = Math.atan2(fx.ty - fx.y, fx.tx - fx.x);
        for (var mz = 0; mz < 5; mz++) {
          var ma = mang + (Math.random() - 0.5) * 0.7;
          this.particles.push({ kind: 'dot', x: fx.x, y: fx.y, vx: Math.cos(ma) * (40 + Math.random() * 70),
            vy: Math.sin(ma) * (40 + Math.random() * 70) - 12, r: 1.4 + Math.random() * 1.8,
            life: 0.16 + Math.random() * 0.1, T: 0.26, c: mz < 2 ? '#fff0b0' : '#ff8a3c' });
        }
      }
      else if (fx.k === 'fireburst') {       // it LANDS as fire, not a dot
        this.particles.push({ kind: 'ring', x: fx.x, y: fx.y, r: 3, R: 20, life: 0.22, T: 0.22, c: '#ffb14e' });
        for (var fb = 0; fb < 9; fb++) {
          var fa = Math.random() * 6.283;
          this.particles.push({ kind: 'dot', x: fx.x, y: fx.y, vx: Math.cos(fa) * (30 + Math.random() * 80),
            vy: Math.sin(fa) * (30 + Math.random() * 80) - 30, r: 1.3 + Math.random() * 2.2,
            life: 0.22 + Math.random() * 0.18, T: 0.4, c: fb < 3 ? '#fff0b0' : fb < 7 ? '#ff8a3c' : '#d64545' });
        }
      }
      else if (fx.k === 'float') this.floats.push({ x: fx.x, y: fx.y, txt: fx.txt, c: fx.c, t: 1.6 });
    }
    this.fxQueue.length = 0;

    for (var i = this.particles.length - 1; i >= 0; i--) {
      var pa = this.particles[i];
      pa.life -= dtRaw;
      if (pa.kind === 'dot') { pa.x += pa.vx * dtRaw; pa.y += pa.vy * dtRaw; pa.vy += 160 * dtRaw; }
      else if (pa.kind === 'coin') {
        var ct = 1 - Math.max(0, pa.life / pa.T);          // 0 -> 1 over flight
        pa.cx = pa.x + (pa.tx - pa.x) * ct;
        pa.cy = pa.y + (pa.ty - pa.y) * ct - Math.sin(ct * Math.PI) * pa.arc;
      }
      if (pa.life <= 0) this.particles.splice(i, 1);
    }
    for (var f = this.floats.length - 1; f >= 0; f--) {
      var fl = this.floats[f];
      fl.t -= dtRaw; fl.y -= 26 * dtRaw;
      if (fl.t <= 0) this.floats.splice(f, 1);
    }
    for (var hk = this.husks.length - 1; hk >= 0; hk--) {
      var hu = this.husks[hk];
      hu.t -= dtRaw;
      if (hu.t <= 0) this.husks.splice(hk, 1);
    }
    // overclocked machine throws brass sparks (cosmetic)
    for (var os = 0; os < this.towers.length; os++) {
      if (this.towers[os]._oc && Math.random() < dtRaw * 5) {
        var osp = this.towers[os];
        this.particles.push({ kind: 'dot', x: osp.x + (Math.random() - 0.5) * 22, y: osp.y - 20 - Math.random() * 18, vx: (Math.random() - 0.5) * 40, vy: -20 - Math.random() * 30, r: 1.2 + Math.random() * 1.4, life: 0.3, T: 0.3, c: '#ffcf6a' });
      }
    }
    // heavy footfalls kick dust; laden thieves drip gold sparks (cosmetic scan)
    for (var ci = 0; ci < this.enemies.length; ci++) {
      var ce2 = this.enemies[ci];
      if (ce2.hp <= 0) continue;
      if (!ce2.flyer && (ce2.type === 'brute' || ce2.type === 'boss') && ce2.grabT <= 0 && Math.random() < dtRaw * 5) {
        this.particles.push({ kind: 'dot', x: ce2.px + (Math.random() - 0.5) * 10, y: ce2.py + 2, vx: (Math.random() - 0.5) * 30, vy: -10 - Math.random() * 18, r: 1.5 + Math.random() * 2, life: 0.3 + Math.random() * 0.2, T: 0.5, c: 'rgba(120,100,80,0.5)' });
      }
      // GLITTER WAKE: drip rate scales with the LOAD — a Scrapling sheds the
      // odd spark; the Hoard King lays a trail down the whole switchback
      if (ce2.fleeing && ce2.stolen > 0 && Math.random() < dtRaw * Math.min(20, 2 + 1.4 * ce2.stolen)) {
        this.particles.push({ kind: 'dot', x: ce2.px + (Math.random() - 0.5) * (6 + ce2.stolen), y: ce2.py - 8, vx: (Math.random() - 0.5) * 16, vy: 12 + Math.random() * 14, r: 1.0 + 0.05 * ce2.stolen + Math.random() * 1.2, life: 0.35, T: 0.35, c: '#ffd75e' });
      }
    }
    this.shake = Math.max(0, this.shake - dtRaw * 2.2);
    // the open-jaw / recoil beat, cosmetic lane only — never read by update()
    if (this._breathT > 0) this._breathT = Math.max(0, this._breathT - dtRaw);
    if (this.state === 'won' || this.state === 'lost') this._resultT = (this._resultT || 0) + dtRaw;
    // ---- music director (cosmetic lane; consumes nothing from the seed) ----
    // Everything the score reacts to is read HERE, in _cosmetic(), never in
    // update(). update() may only set a flag; this is where it is spent. That
    // boundary is load-bearing: validate.py's firewall check is a substring
    // test and cannot see a seeded draw that happens inside an audio helper.
    var playing = this.state === 'playing' || this.state === 'paused';
    var scene = playing ? 'keep' : 'hall';
    if (scene !== this._mScene) { this._mScene = scene; Sfx.scene(scene); }
    Sfx.setPhase({
      playing: this.state === 'playing',
      waveActive: this.waveActive,
      wave: this.wave,
      boss: !!this._bossWave,
      hoardFrac: Math.max(0, Math.min(1, this.hoard / CFG.startHoard)),
    });
    // One-shot cues, drained from flags that update() raised.
    if (this._mCue) { var c = this._mCue; this._mCue = null; Sfx.cue(c.name, c); }
    if (this._mClear) { this._mClear = false; Sfx.clear(); }
  };
  /// Where Wick's mouth is, in world space, and which way it points.
  ///
  /// RENDER-LANE ONLY. The sim knows he is at (h.x, h.y) standing on the floor;
  /// the muzzle is a fact about the SPRITE — 44 units wide, bottom-anchored at
  /// h.y+5, snout roughly 72% of the way up and a little forward of centre. The
  /// sim must never see these numbers or a resized sprite would fork a replay.
  // Where the snout sits on hero_whelp.png, as a fraction of sprite height from
  // the feet, and how far forward of centre. Measured against the plate, and
  // shared by _muzzle() (world space, for particles) and the jaw drawn inside
  // the sprite's own transform — if these two disagree the fire leaves his face.
  // Re-measured 2026-08-14 against the REBUILT plate (the old one had 45% of
  // its height sliced flat off the right edge — see art/hero_whelp_CLIPPED_backup.png).
  // HERO_H drives the sprite instead of a fixed WIDTH: front and back plates have
  // different aspects, so a fixed width made him CHANGE HEIGHT when he turned away.
  var HERO_H = 57.2;
  var MUZZLE_UP = 0.685, MUZZLE_FWD = 0.321;
  Game.prototype._muzzle = function () {
    var h = this.hero;
    var img = ART.images.hero_whelp || ART.images.hero;
    var hh = HERO_H;
    var mw2 = HERO_H * (img ? img.width / img.height : 0.77);
    // Facing is derived from hero state with the SAME expression the drawer
    // uses (hflip = (tx-x) > 0.5 ? -1 : 1, sprite faces left natively, so world
    // facing is its negation). Reading the drawer's stored value instead would
    // lag by a frame — _cosmetic() spends the fx queue BEFORE draw() runs — so
    // a breath cast in the same frame he turns would leave his mouth.
    var f = (h.tx - h.x) > 0.5 ? 1 : -1;
    return { x: h.x + f * (mw2 * MUZZLE_FWD), y: h.y + 5 - hh * MUZZLE_UP, f: f };
  };

  Game.prototype._burst = function (x, y, c, n, v) {
    for (var i = 0; i < n; i++) {
      var a = Math.random() * 6.283, s = v * (0.4 + Math.random() * 0.8);
      this.particles.push({ kind: 'dot', x: x, y: y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 40, r: 1.5 + Math.random() * 2.5, life: 0.35 + Math.random() * 0.35, T: 0.7, c: c });
    }
  };

  // ---- RENDER ONLY. Back-to-front off world state. No lane-2 draws. -------
  Game.prototype.draw = function (alpha) {
    var ctx = this.ctx, v = this.view;
    // R3D: the WebGL canvas underneath draws the WORLD; this canvas goes
    // transparent and keeps only UI. Until three has booted, draw 2D as ever.
    // The title screen composes its OWN room (see _drawTitle) — it is not the
    // level with a scrim over it any more. So the menu neither boots the 3D
    // world nor renders the 2D one: it draws 4 art files instead of 8, and
    // _buildSceneCache stops running before the player has tapped anything.
    var menuish = this.state === 'menu';
    var use3d = R3D.on && R3D.ready && !menuish;
    if (R3D.on && !menuish) R3D.sync(this, alpha);   // boots itself on first call
    ctx.setTransform(v.dpr * v.scale, 0, 0, v.dpr * v.scale, 0, 0);
    if (use3d) {
      ctx.clearRect(0, 0, v.w, v.h);
    } else if (menuish) {
      ctx.clearRect(0, 0, v.w, v.h);          // _drawTitle paints its own backdrop
    } else {
      ctx.fillStyle = '#17100e';
      ctx.fillRect(0, 0, v.w, v.h);
      // the bands are SCENERY, not dead space: the cavern painting covers the
      // whole viewport (cover-cropped), dimmed so the sim world reads brighter
      if (ART.images.bg) {
        var bimg2 = ART.images.bg;
        var bs2 = Math.max(v.w / bimg2.width, v.h / bimg2.height);
        var bw2 = bimg2.width * bs2, bh2 = bimg2.height * bs2;
        ctx.drawImage(bimg2, (v.w - bw2) / 2, (v.h - bh2) / 2, bw2, bh2);
        ctx.fillStyle = 'rgba(10,6,4,0.45)';
        ctx.fillRect(0, 0, v.w, v.h);
      }
    }
    ctx.save();
    // cosmetic screenshake (lane 3 state, applied at render)
    var shx = this.shake > 0 ? (Math.random() - 0.5) * 8 * this.shake : 0;
    var shy = this.shake > 0 ? (Math.random() - 0.5) * 6 * this.shake : 0;
    ctx.translate(v.ox + shx, v.oy + shy);

    if (menuish) {
      /* the title owns the whole screen; no world beneath it */
    } else if (use3d) {
      this._drawOverlay3d(ctx);     // hp bars, coins, floats — over the 3D world
    } else {
    this._drawCavern(ctx);
    this._drawMoundAndKeep(ctx);   // mound + halo (keep sprite drawn AFTER the path)
    this._drawPath(ctx);
    this._drawMouthAlarm(ctx);    // escape pressure, UNDER the entities
    this._drawTar(ctx);           // slag sits ON the road, under everyone
    this._drawKeep(ctx);          // the door arch overlaps the road's end
    this._drawPads(ctx);
    this._drawEntities(ctx);
    this._drawParticles(ctx);
    this._drawWorldHints(ctx);
    }
    if (this.menu) this._drawMenus(ctx);
    if (this.state === 'menu') this._drawTitle(ctx);
    if (this.state === 'forge') this._drawForge(ctx);
    if (this.state === 'trials') this._drawTrials(ctx);
    if (this.state === 'duel') this._drawDuelSelect(ctx);
    if (this.state === 'won' || this.state === 'lost') this._drawResult(ctx);
    if (this.state === 'paused') {
      ctx.fillStyle = 'rgba(10,6,4,0.55)';
      ctx.fillRect(-v.ox - 60, -v.oy - 60, v.w + 120, v.h + 120);   // full view
      ctx.fillStyle = '#ffe9c4'; ctx.font = 'bold 40px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('PAUSED', WORLD_W / 2, WORLD_H / 2);
      ctx.font = '16px system-ui, sans-serif'; ctx.fillText('tap to resume', WORLD_W / 2, WORLD_H / 2 + 30);
      ctx.fillStyle = 'rgba(214,69,69,0.9)';
      rr(ctx, WORLD_W / 2 - 90, WORLD_H / 2 + 56, 180, 48, 12); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 17px system-ui, sans-serif';
      ctx.fillText('QUIT TO TITLE', WORLD_W / 2, WORLD_H / 2 + 86);
      ctx.textAlign = 'left';
    }
    ctx.restore();

    // soft seams where the brighter sim world meets the dimmed band scenery
    if (v.oy > 2) {
      var gt2 = ctx.createLinearGradient(0, v.oy - 14, 0, v.oy + 10);
      gt2.addColorStop(0, 'rgba(10,6,4,0.5)');
      gt2.addColorStop(1, 'rgba(10,6,4,0)');
      ctx.fillStyle = gt2;
      ctx.fillRect(0, v.oy - 14, v.w, 24);
      var gb2 = ctx.createLinearGradient(0, v.oy + WORLD_H - 10, 0, v.oy + WORLD_H + 14);
      gb2.addColorStop(0, 'rgba(10,6,4,0)');
      gb2.addColorStop(1, 'rgba(10,6,4,0.5)');
      ctx.fillStyle = gb2;
      ctx.fillRect(0, v.oy + WORLD_H - 10, v.w, 24);
    }
    // screen-anchored HUD (drawn over everything except the dev overlay)
    this._drawHudView(ctx);

    // dev overlay: LOUD missing-art list (never silent fallbacks)
    if (_dev) {
      var miss = Object.keys(ART.missing);
      if (miss.length) {
        ctx.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
        ctx.fillStyle = 'rgba(255,80,80,0.85)'; ctx.font = '11px monospace';
        ctx.fillText('missing art: ' + miss.slice(0, 6).join(' ') + (miss.length > 6 ? ' +' + (miss.length - 6) : ''), 8, v.ch - 10);
      }
    }
  };

  // Static scenery is painted ONCE into offscreen canvases (rebuilt only when
  // the bg art arrives) — the per-frame cost of the cavern + path drops to two
  // blits instead of gradients, 26 ellipses, and four wide path strokes.
  Game.prototype._buildSceneCache = function () {
    var key = (ART.images.bg ? 'art' : 'proc') + (ART.images.road ? '+road' : '') + ':' + this.levelIdx;
    if (this._bgKey === key && this._bgCache) return;
    this._bgKey = key;
    var res = 2;
    var cv = this._bgCache = document.createElement('canvas');
    cv.width = WORLD_W * res; cv.height = WORLD_H * res;
    var c = cv.getContext('2d');
    c.scale(res, res);
    if (ART.images.bg) {
      // cover-crop, never stretch: scale to fill, center the overflow
      var bimg = ART.images.bg;
      var bsc = Math.max(WORLD_W / bimg.width, WORLD_H / bimg.height);
      var bw = bimg.width * bsc, bh = bimg.height * bsc;
      c.drawImage(bimg, (WORLD_W - bw) / 2, (WORLD_H - bh) / 2, bw, bh);
    } else {
      var g = c.createLinearGradient(0, 0, 0, WORLD_H);
      g.addColorStop(0, '#241612');
      g.addColorStop(0.45, '#2e211b');
      g.addColorStop(1, '#231913');
      c.fillStyle = g;
      c.fillRect(0, 0, WORLD_W, WORLD_H);
      // rocky wall blobs (positional noise — deterministic decoration)
      for (var i = 0; i < 26; i++) {
        var rx = noise01(i * 3 + 1, 77) * WORLD_W;
        var ry = noise01(i * 3 + 2, 77) * WORLD_H;
        var rr2 = 18 + noise01(i * 3 + 3, 77) * 42;
        c.fillStyle = 'rgba(0,0,0,' + (0.10 + noise01(i, 99) * 0.12) + ')';
        c.beginPath(); c.ellipse(rx, ry, rr2, rr2 * 0.6, 0, 0, 6.283); c.fill();
      }
    }
    var pv = this._pathCache = document.createElement('canvas');
    pv.width = WORLD_W * res; pv.height = WORLD_H * res;
    var pc = pv.getContext('2d');
    pc.scale(res, res);
    pc.lineCap = 'round'; pc.lineJoin = 'round';
    // under-shadow beds the road into the floor either way
    strokePath(pc, PATH.pts, MAP.pathW + 8, 'rgba(18,10,6,0.55)');
    if (ART.images.road) {
      // PAINTED road: tile the cobble texture, then mask it to the path
      // ribbon with a destination-in stroke; edge wear on top.
      var rl = document.createElement('canvas');
      rl.width = WORLD_W * res; rl.height = WORLD_H * res;
      var rc = rl.getContext('2d');
      rc.scale(res, res);
      var tile = 148;                                   // ~12 world px per cobble
      for (var ty = 0; ty < WORLD_H; ty += tile)
        for (var tx = 0; tx < WORLD_W; tx += tile)
          rc.drawImage(ART.images.road, tx, ty, tile, tile);
      rc.globalCompositeOperation = 'destination-in';
      rc.lineCap = 'round'; rc.lineJoin = 'round';
      strokePath(rc, PATH.pts, MAP.pathW, 'rgba(0,0,0,1)');
      rc.globalCompositeOperation = 'source-over';
      strokePath(rc, PATH.pts, MAP.pathW - 4, 'rgba(216,190,149,0.07)');   // lit crown
      rc.save();
      rc.globalCompositeOperation = 'source-atop';
      strokePath(rc, PATH.pts, MAP.pathW - 20, 'rgba(20,12,8,0.16)');      // boot-worn centre
      rc.restore();
      pc.drawImage(rl, 0, 0, WORLD_W, WORLD_H);
    } else {
      // procedural fallback: warm worn-stone strokes
      strokePath(pc, PATH.pts, MAP.pathW, '#7b6a55');
      strokePath(pc, PATH.pts, MAP.pathW - 8, '#8b7a68');
      strokePath(pc, PATH.pts, MAP.pathW - 20, 'rgba(216,190,149,0.18)');
      pc.save();
      pc.setLineDash([5, 13]);
      strokePath(pc, PATH.pts, MAP.pathW - 24, 'rgba(30,18,10,0.28)');
      pc.restore();
    }
    var e0 = PATH.pts[0];
    pc.fillStyle = '#0d0805';
    pc.beginPath(); pc.ellipse(e0[0] + 8, e0[1], 34, 26, 0.4, 0, 6.283); pc.fill();
  };

  Game.prototype._drawCavern = function (ctx) {
    this._buildSceneCache();
    ctx.drawImage(this._bgCache, 0, 0, WORLD_W, WORLD_H);
    // torch glows breathe on the world clock
    for (var t = 0; t < MAP.torches.length; t++) {
      var tc = MAP.torches[t];
      var pulse = 0.75 + 0.25 * Math.sin(this.worldT * 5 + t * 1.7);
      var rg = ctx.createRadialGradient(tc[0], tc[1], 2, tc[0], tc[1], 60 * pulse);
      rg.addColorStop(0, 'rgba(255,170,60,0.55)');
      rg.addColorStop(1, 'rgba(255,120,30,0)');
      ctx.fillStyle = rg;
      ctx.beginPath(); ctx.arc(tc[0], tc[1], 60 * pulse, 0, 6.283); ctx.fill();
      if (!drawSpriteBottom(ctx, 'torch', tc[0], tc[1] + 16, 26)) {
        // flame + stick fallback
        ctx.fillStyle = '#ffcf6a';
        ctx.beginPath(); ctx.ellipse(tc[0], tc[1] - 4, 3.5, 6 + pulse * 2, 0, 0, 6.283); ctx.fill();
        ctx.fillStyle = '#6b4a33';
        ctx.fillRect(tc[0] - 1.5, tc[1], 3, 12);
      }
    }
  };

  Game.prototype._drawMoundAndKeep = function (ctx) {
    var m = MAP.mound, k = MAP.keep;
    // Mother's warmth — a halo BEHIND the keep (never tint the castle itself).
    // It dims as the hoard thins: the life bar is a sleeping mother you can
    // watch getting colder (the studio's ambient-story graft).
    var warmth = 0.3 + 0.7 * (this.hoard / CFG.startHoard);
    var br = (0.5 + 0.5 * Math.sin(this.worldT * (0.6 + 0.5 * warmth))) * warmth;
    var mg = ctx.createRadialGradient(k.x, k.y - 30, 10, k.x, k.y - 30, 150 + br * 12);
    mg.addColorStop(0, 'rgba(255,150,80,' + (0.10 + br * 0.12) + ')');
    mg.addColorStop(1, 'rgba(255,120,40,0)');
    ctx.fillStyle = mg;
    ctx.beginPath();
    ctx.arc(k.x, k.y - 30, 160 + br * 12, 0, 6.283);
    ctx.fill();
    if (drawSpriteBottom(ctx, 'mound', m.x, m.y + m.ry + 6, m.rx * 2 + 30)) { /* sprite */ }
    else {
      // gold mound: layered warm ellipses + sparkle
      for (var l = 0; l < 3; l++) {
        ctx.fillStyle = ['#8a5a1d', '#c98a1e', '#ffd75e'][l];
        ctx.beginPath();
        ctx.ellipse(m.x, m.y - l * 7, m.rx - l * 18, m.ry - l * 8, 0, 0, 6.283);
        ctx.fill();
      }
      for (var s = 0; s < 22; s++) {
        var sx = m.x + (noise01(s * 5 + 1, 41) - 0.5) * 2 * (m.rx - 20);
        var sy = m.y - 6 - noise01(s * 5 + 2, 41) * 26;
        var tw2 = 0.5 + 0.5 * Math.sin(this.worldT * 3 + s * 2.4);
        ctx.fillStyle = 'rgba(255,240,170,' + (0.25 + 0.55 * tw2) + ')';
        ctx.fillRect(sx, sy, 2.5, 2.5);
      }
    }
  };

  Game.prototype._drawKeep = function (ctx) {
    var k = MAP.keep;
    if (this.motherReady) {
      var mp2 = 0.5 + 0.5 * Math.sin(this.worldT * 7);
      var mg2 = ctx.createRadialGradient(k.x, k.y - 30, 8, k.x, k.y - 30, 120 + mp2 * 24);
      mg2.addColorStop(0, 'rgba(255,190,90,' + (0.30 + mp2 * 0.25) + ')');
      mg2.addColorStop(1, 'rgba(255,140,40,0)');
      ctx.fillStyle = mg2;
      ctx.beginPath(); ctx.arc(k.x, k.y - 30, 150 + mp2 * 24, 0, 6.283); ctx.fill();
    }
    if (drawSpriteBottom(ctx, 'keep', k.x, k.y + 40, 158)) { /* sprite */ }
    else {
      // chunky keep: main cylinder + two side turrets, blue conical roofs
      drawTurret(ctx, k.x - 46, k.y - 6, 26, 52, '#8d8577', '#655e52', '#3e6bd6');
      drawTurret(ctx, k.x + 46, k.y - 6, 26, 52, '#8d8577', '#655e52', '#3e6bd6');
      drawTurret(ctx, k.x, k.y - 26, 38, 74, '#9a917f', '#6d6557', '#4a77e8');
      // door + windows
      ctx.fillStyle = '#4a3423';
      rr(ctx, k.x - 12, k.y + 8, 24, 26, 10); ctx.fill();
      ctx.fillStyle = '#ffcf6a';
      ctx.fillRect(k.x - 30 - 3, k.y - 26, 6, 9);
      ctx.fillRect(k.x + 30 - 3, k.y - 26, 6, 9);
      ctx.fillRect(k.x - 3, k.y - 58, 6, 10);
      // banner
      ctx.fillStyle = '#e8b23a';
      ctx.fillRect(k.x - 1.5, k.y - 118, 3, 26);
      ctx.beginPath(); ctx.moveTo(k.x + 1.5, k.y - 118); ctx.lineTo(k.x + 26, k.y - 111); ctx.lineTo(k.x + 1.5, k.y - 103); ctx.closePath();
      ctx.fillStyle = '#d64545'; ctx.fill();
    }
    // placeholder silhouette of the sleeping Elder Dragon — vector-art era
    // only; with the painted keep the blobs read as a smear, so they retire
    if (!ART.images.keep) {
      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = '#5e3a4e';
      ctx.beginPath();
      ctx.ellipse(MAP.keep.x + 55, MAP.keep.y - 68, 64, 26, -0.18, 0, 6.283);
      ctx.fill();
      ctx.beginPath();
      ctx.ellipse(MAP.keep.x + 116, MAP.keep.y - 84, 22, 15, 0.3, 0, 6.283);
      ctx.fill();
      ctx.restore();
    }
  };

  Game.prototype._drawPath = function (ctx) {
    // stone road + cave mouth, pre-painted in _buildSceneCache
    ctx.drawImage(this._pathCache, 0, 0, WORLD_W, WORLD_H);
  };

  Game.prototype._drawPads = function (ctx) {
    for (var i = 0; i < MAP.pads.length; i++) {
      if (this._padTower(i) !== -1) continue;
      var p = MAP.pads[i];
      var afford = this.gold >= 60;
      var pulse = afford ? 0.6 + 0.4 * Math.sin(this.worldT * 3 + i) : 0.35;
      if (ART.images.pad) { ctx.globalAlpha = 0.6 + pulse * 0.4; ctx.drawImage(ART.images.pad, p.x - 26, p.y - 18, 52, 36); ctx.globalAlpha = 1; }
      else {
        ctx.strokeStyle = 'rgba(255,215,94,' + pulse + ')';
        ctx.lineWidth = 2.5; ctx.setLineDash([7, 5]);
        ctx.beginPath(); ctx.ellipse(p.x, p.y, 24, 15, 0, 0, 6.283); ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(60,45,30,0.55)';
        ctx.beginPath(); ctx.ellipse(p.x, p.y, 22, 13, 0, 0, 6.283); ctx.fill();
        ctx.fillStyle = 'rgba(255,215,94,' + (0.5 + pulse * 0.5) + ')';
        ctx.font = 'bold 16px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText('+', p.x, p.y + 1);
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      }
    }
  };

  // y-sorted world entities: towers, enemies, hero, projectiles.
  // Pooled records + cached enemy positions: zero per-frame path lookups.
  function byY(a, b) { return a.y - b.y; }
  Game.prototype._drawEntities = function (ctx) {
    var draws = this._draws || (this._draws = []);
    var n = 0, i, rec;
    function slot() { return draws[n] || (draws[n] = { y: 0, kind: '', ref: null, px: 0, py: 0 }); }
    for (i = 0; i < this.towers.length; i++) {
      rec = slot(); n++;
      rec.y = this.towers[i].y; rec.kind = 'tower'; rec.ref = this.towers[i];
    }
    for (i = 0; i < this.enemies.length; i++) {
      var en = this.enemies[i];
      rec = slot(); n++;
      rec.y = en.py + (en.flyer ? 28 : 0); rec.kind = 'enemy'; rec.ref = en; rec.px = en.px; rec.py = en.py;
    }
    for (i = 0; i < this.husks.length; i++) {
      var hs = this.husks[i];
      rec = slot(); n++;
      rec.y = hs.y + (hs.e.flyer ? 28 : 0); rec.kind = 'husk'; rec.ref = hs;
      rec.px = hs.x; rec.py = hs.y;
    }
    rec = slot(); n++;
    // manning: sort just AFTER his machine so he sits ON it, not behind it
    var mtw2 = this.hero.manned ? this._towerByTid(this.hero.manTid) : null;
    rec.y = mtw2 ? mtw2.y + 1 : this.hero.y;
    rec.kind = 'hero'; rec.ref = null;
    draws.length = n;
    draws.sort(byY);
    for (i = 0; i < n; i++) {
      var d = draws[i];
      if (d.kind === 'tower') this._drawTower(ctx, d.ref);
      else if (d.kind === 'enemy') this._drawEnemy(ctx, d.ref, { x: d.px, y: d.py });
      else if (d.kind === 'husk') {
        // Replay the raider's own sprite, white-hot and fading. Driving it
        // through flashT means the corpse inherits the SAME white re-draw and
        // squash pop a non-lethal hit gets — the kill stops being the one
        // impact the renderer never showed.
        var hv = d.ref, hr = Math.max(0, hv.t / hv.T);
        hv.e.flashT = 0.11 * hr;
        ctx.save();
        ctx.globalAlpha = hr;
        this._drawEnemy(ctx, hv.e, { x: d.px, y: d.py });
        ctx.restore();
        ctx.globalAlpha = 1;
      }
      else this._drawHero(ctx);
    }
    // projectiles on top
    for (i = 0; i < this.projectiles.length; i++) {
      var pr = this.projectiles[i];
      if (pr.kind === 'lob') {
        ctx.fillStyle = '#ff8a3c';
        ctx.beginPath(); ctx.arc(pr.x, pr.y, 5, 0, 6.283); ctx.fill();
        ctx.fillStyle = 'rgba(255,180,90,0.5)';
        ctx.beginPath(); ctx.arc(pr.x, pr.y, 8, 0, 6.283); ctx.fill();
      } else if (pr.kind === 'fire') {   // Wick's fireball: a comet with a tail
        var fdx2 = pr.dx || 1, fdy2 = pr.dy || 0;
        var flick = 0.75 + 0.25 * Math.sin(this.worldT * 40 + pr.target);
        for (var tl = 3; tl >= 1; tl--) {
          ctx.fillStyle = 'rgba(255,110,40,' + (0.13 * tl * flick) + ')';
          ctx.beginPath(); ctx.arc(pr.x - fdx2 * tl * 6, pr.y - fdy2 * tl * 6, 3 + tl * 1.7, 0, 6.283); ctx.fill();
        }
        ctx.fillStyle = 'rgba(255,140,50,0.85)';
        ctx.beginPath(); ctx.arc(pr.x, pr.y, 6.2 * flick, 0, 6.283); ctx.fill();
        ctx.fillStyle = '#fff0b0';
        ctx.beginPath(); ctx.arc(pr.x, pr.y, 3.1 * flick, 0, 6.283); ctx.fill();
      } else {
        // A REAL ARROW, not a light streak: shaft, iron head, fletching, all
        // rotated to its heading. This is a crossbow bolt — it should look
        // like one in flight.
        var tdx = pr.dx || 1, tdy = pr.dy || 0;
        var ang = Math.atan2(tdy, tdx);
        var isPierce = pr.hops > 0;
        ctx.save();
        ctx.translate(pr.x, pr.y);
        ctx.rotate(ang);
        ctx.strokeStyle = 'rgba(255,220,150,0.22)'; ctx.lineWidth = 3.5;   // motion smear
        ctx.beginPath(); ctx.moveTo(-22, 0); ctx.lineTo(-6, 0); ctx.stroke();
        ctx.strokeStyle = '#6b4a26'; ctx.lineWidth = 2.2;                   // wooden shaft
        ctx.beginPath(); ctx.moveTo(-11, 0); ctx.lineTo(4, 0); ctx.stroke();
        ctx.fillStyle = isPierce ? '#dfe6ee' : '#cfd6de';                   // iron head
        ctx.beginPath(); ctx.moveTo(10, 0); ctx.lineTo(2.5, -2.9); ctx.lineTo(3.6, 0); ctx.lineTo(2.5, 2.9);
        ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#c2503f';                                          // fletching
        ctx.beginPath(); ctx.moveTo(-11, 0); ctx.lineTo(-16.5, -3.4); ctx.lineTo(-12.5, 0); ctx.closePath(); ctx.fill();
        ctx.beginPath(); ctx.moveTo(-11, 0); ctx.lineTo(-16.5, 3.4); ctx.lineTo(-12.5, 0); ctx.closePath(); ctx.fill();
        if (pr.crit) {                                                      // an overwound bolt glows
          ctx.strokeStyle = 'rgba(255,154,60,0.75)'; ctx.lineWidth = 1.2;
          ctx.beginPath(); ctx.moveTo(-14, 0); ctx.lineTo(9, 0); ctx.stroke();
        }
        ctx.restore();
      }
    }
  };

  // BEAT 4 — THE MOUTH WAKES. One scalar for the whole screen: how close the
  // nearest loaded carrier is to escaping forever. Permanent loss used to be
  // unforeshadowed (a carrier simply popped at d<=0), which is what made the
  // coins-lost star grade feel arbitrary. O(1): two path ops per FRAME.
  Game.prototype._drawMouthAlarm = function (ctx) {
    var esc = 0;
    for (var q = 0; q < this.enemies.length; q++) {
      var c = this.enemies[q];
      if (c.fleeing && c.stolen > 0) esc = Math.max(esc, 1 - Math.min(1, c.d / 220));
    }
    if (esc <= 0.02) return;                       // its mere presence is the alarm
    var m0 = PATH.pts[0];
    var pul = 0.65 + 0.35 * Math.sin(this.worldT * (4 + 8 * esc));   // rate rises as it closes
    ctx.fillStyle = 'rgba(255,60,50,' + (0.08 + 0.20 * esc) + ')';
    ctx.beginPath(); ctx.ellipse(m0[0], m0[1], 34 + 40 * esc, 26 + 30 * esc, 0.4, 0, 6.283); ctx.fill();
    ctx.strokeStyle = 'rgba(255,123,123,' + (0.20 + 0.65 * esc * pul) + ')';
    ctx.lineWidth = 1.5 + 5 * esc;
    ctx.beginPath(); ctx.ellipse(m0[0], m0[1], 34 + 14 * esc, 26 + 11 * esc, 0.4, 0, 6.283); ctx.stroke();
  };
  Game.prototype._drawTar = function (ctx) {
    for (var i = 0; i < this.tar.length; i++) {
      var tp = this.tar[i];
      var fade = Math.min(1, (tp.until - this.worldT) / 0.6);   // last 0.6s cools off
      var a = pathPointAt(tp.d);
      var gl = 0.55 + 0.25 * Math.sin(this.worldT * 5 + tp.d);  // ember shimmer
      ctx.fillStyle = 'rgba(24,14,8,' + (0.75 * fade) + ')';
      ctx.beginPath(); ctx.ellipse(a.x, a.y, tp.w * 0.62, tp.w * 0.30, 0, 0, 6.283); ctx.fill();
      ctx.fillStyle = 'rgba(255,120,40,' + (0.30 * gl * fade) + ')';
      ctx.beginPath(); ctx.ellipse(a.x, a.y, tp.w * 0.45, tp.w * 0.20, 0, 0, 6.283); ctx.fill();
      ctx.fillStyle = 'rgba(255,190,90,' + (0.35 * gl * fade) + ')';
      for (var s = 0; s < 3; s++) {
        var sa = pathPointAt(tp.d + (s - 1) * tp.w * 0.3);
        ctx.beginPath(); ctx.arc(sa.x + Math.sin(this.worldT * 3 + s * 2.1 + tp.d) * 4, sa.y - 1, 1.6, 0, 6.283); ctx.fill();
      }
    }
  };
  Game.prototype._drawTower = function (ctx, tw) {
    var p = tw;
    var lvl = tw.level;
    // MANNED machines swap to a combined plate with Wick painted onto them.
    // He used to be the standing sprite drawn 26px higher, which read as a
    // decal hovering over the machine rather than a dragon working it — and
    // manning is worth +70% fire rate and +30% damage, so it deserves to look
    // like something. _drawHero skips him entirely while this plate is up.
    var spriteId = 't_' + tw.type;
    if (tw._manned && ART.images[spriteId + '_manned']) spriteId += '_manned';
    // range ring while its menu is open
    if (this.menu && this.menu.towerIdx !== undefined && this.towers[this.menu.towerIdx] === tw) {
      var rr3 = lvlRow(tw).range;
      ctx.fillStyle = 'rgba(255,215,94,0.10)';
      ctx.beginPath(); ctx.arc(p.x, p.y, rr3, 0, 6.283); ctx.fill();
      ctx.strokeStyle = 'rgba(255,215,94,0.45)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(p.x, p.y, rr3, 0, 6.283); ctx.stroke();
    }
    groundShadow(ctx, p.x, p.y + 2, 54 * (1 + lvl * 0.06), 0, 1.05);   // machines sit on the floor too
    if (tw._oc || tw._manned) {   // Wick nearby (thin ring) or ON it (hot ring)
      var ocp2 = 0.6 + 0.4 * Math.sin(this.worldT * (tw._manned ? 11 : 8));
      ctx.strokeStyle = tw._manned ? 'rgba(255,180,64,' + ocp2 + ')' : 'rgba(212,168,64,' + ocp2 + ')';
      ctx.lineWidth = tw._manned ? 4 : 2.5;
      ctx.beginPath(); ctx.ellipse(p.x, p.y + 4, 26 + ocp2 * 3, 12 + ocp2 * 2, 0, 0, 6.283); ctx.stroke();
      if (tw._manned) {
        ctx.strokeStyle = 'rgba(255,120,40,' + (ocp2 * 0.5) + ')'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.ellipse(p.x, p.y + 4, 33 + ocp2 * 4, 16 + ocp2 * 3, 0, 0, 6.283); ctx.stroke();
      }
    }
    var timg = ART.images[spriteId];
    var tt2 = TOWER_TYPES[tw.type];
    if (timg) {
      // recoil press-down right after firing + gentle idle breathing
      var tlv = lvlRow(tw);
      // ONE recoil envelope per real shot: a hard kick that settles over 0.34s
      // and then holds perfectly still. Keyed to shotT, never to the cooldown,
      // so an idle machine does not vibrate.
      var st = tw.shotT === undefined ? 9 : tw.shotT;
      var kick = st < 0.34 ? (1 - st / 0.34) : 0;
      kick *= kick;                                   // sharp attack, soft tail
      var tsq = 1 - 0.10 * kick + Math.sin(this.worldT * 1.6 + tw.padIdx) * 0.008;
      var tw0 = 54 * (1 + lvl * 0.12);
      var th0 = tw0 * (timg.height / timg.width);
      // FACING. The plate is painted aiming up-LEFT at about 45 degrees, on a
      // round turntable base. So: mirror to put the barrel on the target's side
      // (that is the error the player actually sees — shooting backwards), then
      // swivel the remainder, clamped, about the base so the perspective holds.
      // Eased toward the target rather than snapped: a turret that teleports its
      // aim reads as cheap even when the angle is right.
      var fSign = 1, fRot = 0;
      if (tt2 && tt2.aims && tw._aimX !== undefined) {
        var fdx = tw._aimX - p.x, fdy = tw._aimY - (p.y - th0 * 0.55);
        fSign = fdx >= 0 ? -1 : 1;                  // -1 mirrors it to face right
        var want = Math.atan2(fdy, Math.abs(fdx)) + Math.PI / 4;   // native is 45deg up
        // 0.30, measured: the mirror does the real work, and anything past
        // ~0.3 rad visibly CANTS the round turntable base — the machine reads
        // as tipping over rather than traversing. Rendered all 8 compass
        // directions at 0.55 and 0.30 to pick this.
        fRot = Math.max(-0.30, Math.min(0.30, want));
        // ease in RENDER time; cosmetic only, so wall-clock is correct here
        var prev = tw._faceRot === undefined ? fRot : tw._faceRot;
        var prevS = tw._faceSign === undefined ? fSign : tw._faceSign;
        tw._faceRot = prev + (fRot - prev) * 0.18;
        tw._faceSign = fSign;                        // the mirror snaps; the angle eases
        fRot = tw._faceRot; fSign = prevS === fSign ? fSign : fSign;
      }
      ctx.save();
      ctx.translate(p.x, p.y + 8);
      ctx.rotate(fRot * fSign);
      ctx.scale((2 - tsq) * fSign, tsq);
      ctx.drawImage(timg, -tw0 / 2, -th0, tw0, th0);
      ctx.restore();
      this._drawForkBadge(ctx, tw, p, p.y - th0 * 0.72);
    }
    else {
      var h = 30 + lvl * 8;
      if (tw.type === 'mimic') {
        ctx.fillStyle = '#7a4d26'; rr(ctx, p.x - 16, p.y - h * 0.6, 32, h * 0.6, 5); ctx.fill();
        ctx.fillStyle = '#5c3a1c'; rr(ctx, p.x - 16, p.y - h * 0.62, 32, 8, 4); ctx.fill();
        ctx.fillStyle = '#ffd75e';
        ctx.fillRect(p.x - 10, p.y - h * 0.35, 20, 3);
        ctx.fillStyle = '#fff';
        for (var th = 0; th < 4; th++) { ctx.beginPath(); ctx.moveTo(p.x - 9 + th * 6, p.y - h * 0.55); ctx.lineTo(p.x - 6 + th * 6, p.y - h * 0.42); ctx.lineTo(p.x - 3 + th * 6, p.y - h * 0.55); ctx.fill(); }
      } else if (tw.type === 'ballista') {
        drawTurret(ctx, p.x, p.y - 6, 15, h * 0.7, '#8d8577', '#655e52', null);
        ctx.strokeStyle = '#4a3423'; ctx.lineWidth = 4;
        ctx.beginPath(); ctx.moveTo(p.x - 15, p.y - h - 2); ctx.quadraticCurveTo(p.x, p.y - h - 15, p.x + 15, p.y - h - 2); ctx.stroke();
        ctx.strokeStyle = '#e8d9b8'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(p.x - 14, p.y - h - 3); ctx.lineTo(p.x + 14, p.y - h - 3); ctx.stroke();
      } else if (tw.type === 'brazier') {
        drawTurret(ctx, p.x, p.y - 4, 13, h * 0.55, '#6d6557', '#4c463c', null);
        ctx.fillStyle = '#2e2620'; ctx.beginPath(); ctx.ellipse(p.x, p.y - h * 0.62, 16, 6, 0, 0, 6.283); ctx.fill();
        var fl = 0.7 + 0.3 * Math.sin(this.worldT * 6 + p.x);
        ctx.fillStyle = '#ff8a3c'; ctx.beginPath(); ctx.ellipse(p.x, p.y - h * 0.72, 9, 12 * fl, 0, 0, 6.283); ctx.fill();
        ctx.fillStyle = '#ffcf6a'; ctx.beginPath(); ctx.ellipse(p.x, p.y - h * 0.70, 5, 7 * fl, 0, 0, 6.283); ctx.fill();
      } else if (tw.type === 'crystal') {
        ctx.fillStyle = '#5c5470'; rr(ctx, p.x - 10, p.y - 14, 20, 14, 4); ctx.fill();
        var glow = 0.6 + 0.4 * Math.sin(this.worldT * 2.5 + p.y);
        ctx.fillStyle = 'rgba(140,200,255,' + (0.35 + glow * 0.3) + ')';
        ctx.beginPath(); ctx.moveTo(p.x, p.y - h - 10); ctx.lineTo(p.x + 9, p.y - h * 0.55); ctx.lineTo(p.x, p.y - 10); ctx.lineTo(p.x - 9, p.y - h * 0.55); ctx.closePath(); ctx.fill();
        ctx.strokeStyle = '#a8e6ff'; ctx.lineWidth = 1.5; ctx.stroke();
      } else if (tw.type === 'perch') {
        drawTurret(ctx, p.x, p.y - 4, 12, h * 0.8, '#7a6a55', '#584c3d', null);
        // wyrmling: tiny dragon sitting on top
        ctx.fillStyle = '#c94f7c';
        ctx.beginPath(); ctx.ellipse(p.x, p.y - h - 8, 10, 7, 0, 0, 6.283); ctx.fill();
        ctx.beginPath(); ctx.ellipse(p.x + 8, p.y - h - 13, 5, 4, 0.3, 0, 6.283); ctx.fill();
        ctx.beginPath(); ctx.moveTo(p.x - 4, p.y - h - 12); ctx.lineTo(p.x - 12, p.y - h - 20); ctx.lineTo(p.x - 2, p.y - h - 16); ctx.closePath(); ctx.fill();
      }
      // level pips
      for (var lp = 0; lp <= lvl; lp++) {
        ctx.fillStyle = '#ffd75e';
        ctx.beginPath(); ctx.arc(p.x - 8 + lp * 8, p.y + 12, 2.5, 0, 6.283); ctx.fill();
      }
      this._drawForkBadge(ctx, tw, p, p.y - h - 14);   // fallback branch keeps the badge too
    }
  };
  Game.prototype._drawForkBadge = function (ctx, tw, p, topY) {
    if (tw.level < 2) return;              // badge: which mod this machine keeps
    var bc = tw.fork ? '#a8e6ff' : '#ffd75e';
    ctx.fillStyle = 'rgba(28,20,14,0.9)';
    ctx.beginPath(); ctx.arc(p.x + 20, topY, 6, 0, 6.283); ctx.fill();
    ctx.strokeStyle = bc; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(p.x + 20, topY, 6, 0, 6.283); ctx.stroke();
    ctx.fillStyle = bc;
    ctx.beginPath(); ctx.arc(p.x + 20, topY, 2.4, 0, 6.283); ctx.fill();
  };

  // THE LOOT LEDGER — the carried amount, baked once into an atlas of 6 cells
  // (1..5 coins as a constant-width column; 6+ as the boss's sack). Count and
  // LENGTH and SHAPE carry the read, never hue: colour-blind safe and static,
  // so it survives reduce-motion too. Cost per carrier: one drawImage.
  // BOT margin: the capsule and the sack halo both hang ~2u BELOW their own
  // origin, which without a margin bleeds into the next cell of the atlas and
  // paints a stray sliver of the neighbouring glyph on every badge.
  var LEDGER_CELL = 34, LEDGER_S = 3, LEDGER_BOT = 3;
  Game.prototype._bakeLedger = function () {
    var c = document.createElement('canvas');
    c.width = LEDGER_CELL * LEDGER_S; c.height = LEDGER_CELL * LEDGER_S * 6;
    var x = c.getContext('2d');
    x.scale(LEDGER_S, LEDGER_S);
    var gw = [], gh = [];
    for (var i = 0; i < 6; i++) {
      x.save();
      x.translate(LEDGER_CELL / 2, (i + 1) * LEDGER_CELL - LEDGER_BOT);   // cell origin
      if (i < 5) {                                  // 1..5 coins: stacked column
        var n = i + 1, sh = 4.6 + (n - 1) * 5.6;
        x.fillStyle = 'rgba(14,9,5,0.88)';
        rr(x, -5.8, -sh - 1.6, 11.6, sh + 3.2, 5.8); x.fill();
        x.fillStyle = 'rgba(120,78,26,0.85)';
        x.fillRect(-0.8, -2.2, 1.6, 3.4);           // tether stub to the crown
        for (var k = 0; k < n; k++) {
          var cy = -2.3 - k * 5.6;
          x.fillStyle = '#ffd75e';
          x.beginPath(); x.ellipse(0, cy, 3.8, 2.3, 0, 0, 6.283); x.fill();
          x.fillStyle = 'rgba(255,247,214,0.9)';
          x.beginPath(); x.ellipse(0, cy - 0.7, 2.3, 0.9, 0, 0, 6.283); x.fill();
        }
        gw.push(11.6); gh.push(sh + 3.2);
      } else {                                      // 6+: a SACK — a different SHAPE, not a taller stack
        // Kept deliberately TIGHT (~21u): an earlier 32u version out-massed the
        // 36u raider sprites and read as a pale blob competing with the cast.
        x.fillStyle = 'rgba(12,8,4,0.92)';          // dark rim carries the silhouette
        x.beginPath(); x.moveTo(-10.6, -6.4);
        x.bezierCurveTo(-11.4, -15.6, -6.2, -17.4, -4.2, -19.2);
        x.lineTo(4.2, -19.2);
        x.bezierCurveTo(6.2, -17.4, 11.4, -15.6, 10.6, -6.4);
        x.bezierCurveTo(9.6, -0.6, -9.6, -0.6, -10.6, -6.4);
        x.closePath(); x.fill();
        x.fillStyle = '#e8b23c';                    // deeper gold: pale reads as washed out
        x.beginPath(); x.moveTo(-8.8, -6.6);
        x.bezierCurveTo(-9.5, -14.6, -5.0, -16.2, -3.4, -17.8);
        x.lineTo(3.4, -17.8);
        x.bezierCurveTo(5.0, -16.2, 9.5, -14.6, 8.8, -6.6);
        x.bezierCurveTo(8.0, -1.8, -8.0, -1.8, -8.8, -6.6);
        x.closePath(); x.fill();
        x.strokeStyle = 'rgba(96,58,14,0.75)'; x.lineWidth = 1.1;   // burlap seams
        for (var bd = 0; bd < 2; bd++) {
          x.beginPath(); x.ellipse(0, -5.4 + bd * 2.6, 7.6 - bd * 2.6, 2.4 - bd * 0.7, 0, 3.34, 6.08); x.stroke();
        }
        x.fillStyle = 'rgba(92,58,16,0.95)';        // cinched neck
        rr(x, -3.6, -21.4, 7.2, 3.6, 1.4); x.fill();
        x.fillStyle = '#ffd75e';                    // coins spilling over the tie
        for (var s2 = 0; s2 < 3; s2++) {
          x.beginPath(); x.ellipse(-4.2 + s2 * 4.2, -22.6 + (s2 === 1 ? -1.4 : 0), 2.2, 1.6, 0, 0, 6.283); x.fill();
        }
        gw.push(21.2); gh.push(23);
      }
      x.restore();
    }
    return { c: c, gw: gw, gh: gh };
  };

  Game.prototype._drawEnemy = function (ctx, e, p) {
    var base = ENEMY_TYPES[e.type];
    var bob = Math.sin(this.worldT * 9 + e.id * 1.3) * 2;
    // a netted flyer sits on the road (groundedT), wings clipped
    var fy = eFly(e) ? -26 + Math.sin(this.worldT * 4 + e.id) * 4 : 0;
    // BEAT 1a — the shadow REACHES as he closes on the hoard: it darkens,
    // widens and flattens over the last 70 units. Zero extra draw calls.
    var near = e.fleeing ? 0 : Math.max(0, 1 - (PATH.len - e.d) / 70);
    // depth: units grow toward the camera, matching the painted floor
    var dsc = depthScale(p.y);
    var baseW = (e.type === 'boss' ? 62 : e.type === 'brute' ? 46 : 36) * dsc;
    // A REAL contact shadow, sized off the body and thrown along the key light
    // (measured upper-left across the sprite set). The old one was 20u wide
    // under a 36u body and centred ABOVE the feet, so it read as an ankle
    // smudge. BEAT 1a is preserved: `near` still widens and darkens it as he
    // closes on the hoard.
    groundShadow(ctx, p.x, p.y, baseW * (1 + 0.22 * near), eFly(e) ? 26 : 0, 1 + 0.45 * near);
    var sid = 'e_' + e.type;
    var img = ART.images[sid];
    if (img) {
      // ALIVE pass — procedural sprite animation, all render-lane:
      // facing flip along travel, walk-waddle rotation, volume-preserving
      // squash & stretch, step-hop, dig-frenzy while grabbing, boss stomp.
      var t = this.worldT, ph = e.id * 1.7;
      var boss = e.type === 'boss';
      var moving = e.grabT <= 0;
      var ahead = pathPointAt(e.fleeing ? Math.max(0, e.d - 8) : Math.min(PATH.len, e.d + 8));
      // face the TRAVEL direction: mirror when it opposes the art's native side
      var native = ENEMY_FACING[e.type] || -1;
      var flip = (ahead.x - p.x) < -0.5 ? -native : native;
      if (Math.abs(ahead.x - p.x) <= 0.5) flip = native;   // vertical stretch: hold facing
      var wsp = boss ? 6 : 9 + (e.spd / 42) * 3;          // stride matches speed
      // LOOT-WEIGHT GAIT: the sim already slows a laden thief; mirror that on
      // the animation clock (read-only) so a heavy carrier MOVES heavy. The
      // min() ceiling keeps frame-swaps inside the legibility band — nothing
      // already in band moves (Recipe 9: saturate, don't clamp the symptom).
      if (e.fleeing) {
        var fmG = Math.max(CFG.fleeMin, CFG.fleeBase - CFG.fleeWeight * e.stolen) * (this.mods.fleeMul || 1);
        wsp = Math.min(wsp * fmG, 13);
      }
      var animKey = e.type === 'looter' ? 'looter' : e.type;   // meta keys match types
      var hasFrames = WALK_FRAMES && ANIM.meta[animKey] && ANIM.images[animKey + '_a'] && ANIM.images[animKey + '_b'];
      if (hasFrames && moving && !e.flyer) {
        var phase = ((t * wsp + ph) / 6.283) % 1;
        var fi = Math.floor(phase * 4) % 4;                 // A -> rest -> B -> rest
        if (fi === 0) img = ANIM.images[animKey + '_a'];
        else if (fi === 2) img = ANIM.images[animKey + '_b'];
      }
      var amp = (boss ? 0.05 : 0.085) * (hasFrames ? 0.55 : 1);   // frames carry the stride
      var waddle = (moving && !e.flyer) ? Math.sin(t * wsp + ph) * amp : 0;
      var squash;
      if (e.flyer) squash = 1 + Math.sin(t * 16 + ph) * 0.06;         // wing-beat
      else squash = 1 + Math.abs(Math.sin(t * wsp + ph)) * (boss ? 0.05 : 0.08);
      var hop = (moving && !e.flyer) ? -Math.abs(Math.sin(t * wsp + ph)) * (boss ? 1.5 : 2.5) * (hasFrames ? 0.75 : 1) : 0;
      // BEAT 2 — THE GRAB, in three acts, plus the turn. Every term is a pure
      // function of grabT (sim state), so it is frame-rate independent and
      // replay-identical: no latch, no per-enemy render state.
      var face = flip;
      if (e.grabT > 0) {
        var gg = 1 - e.grabT / CFG.grabTime;                  // 0 -> 1 across the grab
        if (gg < 0.20) squash = 0.80 + 0.14 * (gg / 0.20);    // PLUNGE into the pile
        else if (gg < 0.68)                                   // DIG: frenzy that DECAYS
          squash = 0.96 + Math.sin(t * 24 + ph) * 0.075 * (1 - (gg - 0.20) / 0.48);
        else {                                                // HAUL: stands up under it
          var uu = (gg - 0.68) / 0.32;
          squash = 1 + 0.20 * Math.sin(uu * 3.6) * (1 - uu * 0.4); hop = -uu * 3.5;
        }
        // the turn gets 0.12s instead of one invisible frame — this is the
        // instant he becomes a target worth chasing
        face = -flip * Math.cos(Math.min(1, gg / 0.24) * Math.PI);
      }
      if (e.flashT > 0) squash *= 1 + e.flashT * 0.9;                 // impact pop
      if (e.fleeing) hop *= 1 - 0.30 * Math.min(1, e.stolen / 8);     // laden: barely leaves the ground
      // BEAT 1b — the rear-back wind-up over the last 26 units before the hoard
      var lean = 0;
      if (!e.fleeing && e.grabT <= 0) {
        var toKeep = PATH.len - e.d;
        if (toKeep < 26) {
          var aw = 1 - toKeep / 26;
          // TRAVEL direction, never `flip` (which is relative to each sprite's
          // native side and would rear half the cast backwards)
          lean = -((ahead.x - p.x) < -0.5 ? -1 : 1) * 0.26 * Math.sin(aw * Math.PI);
          hop -= 2.4 * aw;
        }
      }
      var w0 = baseW;                       // depth-scaled above
      var hh2 = w0 * (img.height / img.width);
      ctx.save();
      ctx.translate(p.x, p.y + 6 + fy + hop);
      ctx.rotate(waddle + lean);
      ctx.scale(face * (2 - squash), squash);
      ctx.drawImage(img, -w0 / 2, -hh2, w0, hh2);
      // TORCHLIGHT: the six lights each map declares used to illuminate
      // nothing — they were painted before the entities. Now a body that
      // walks past a torch actually catches its warmth.
      var tw2 = torchWarm(p.x, p.y);
      if (tw2 > 0.02) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.30 * tw2;
        ctx.drawImage(img, -w0 / 2, -hh2, w0, hh2);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
      if (e.flashT > 0) {                       // white-flash: re-draw lighter
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = Math.min(1, e.flashT * 9);
        ctx.drawImage(img, -w0 / 2, -hh2, w0, hh2);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.restore();
      if (e.stolen > 0) { // CARRYING our gold (not merely fleeing empty-handed)
        ctx.fillStyle = 'rgba(255,120,90,0.35)';
        ctx.beginPath(); ctx.ellipse(p.x, p.y + 3, 12, 5, 0, 0, 6.283); ctx.fill();
      }
    } else {
      var col = ENEMY_COLORS[e.type];
      var r = e.type === 'boss' ? 19 : e.type === 'brute' ? 13 : 9;
      var yy = p.y - r + fy + bob * 0.3;
      ctx.fillStyle = col;
      ctx.beginPath(); ctx.ellipse(p.x, yy, r, r * 1.12, 0, 0, 6.283); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.beginPath(); ctx.ellipse(p.x + r * 0.3, yy, r * 0.7, r * 0.95, 0, 0, 6.283); ctx.fill();
      // eyes
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(p.x - r * 0.3, yy - r * 0.2, r * 0.22, 0, 6.283); ctx.fill();
      ctx.beginPath(); ctx.arc(p.x + r * 0.15, yy - r * 0.2, r * 0.22, 0, 6.283); ctx.fill();
      ctx.fillStyle = '#1c1c1c';
      ctx.beginPath(); ctx.arc(p.x - r * 0.26, yy - r * 0.2, r * 0.1, 0, 6.283); ctx.fill();
      ctx.beginPath(); ctx.arc(p.x + r * 0.19, yy - r * 0.2, r * 0.1, 0, 6.283); ctx.fill();
      if (e.flyer) {
        var wf = Math.sin(this.worldT * 18 + e.id) * 0.6;
        ctx.fillStyle = 'rgba(160,130,230,0.8)';
        ctx.beginPath(); ctx.ellipse(p.x - r - 4, yy, 7, 3.5 + wf * 3, 0.5, 0, 6.283); ctx.fill();
        ctx.beginPath(); ctx.ellipse(p.x + r + 4, yy, 7, 3.5 - wf * 3, -0.5, 0, 6.283); ctx.fill();
      }
      if (e.type === 'shield') { ctx.fillStyle = '#c9d2dd'; rr(ctx, p.x - r - 6, yy - 7, 7, 14, 3); ctx.fill(); }
      if (e.type === 'boss') {
        ctx.fillStyle = '#ffd75e';
        ctx.beginPath(); ctx.moveTo(p.x - 10, yy - r - 2); ctx.lineTo(p.x - 6, yy - r - 10); ctx.lineTo(p.x - 2, yy - r - 3); ctx.lineTo(p.x + 2, yy - r - 11); ctx.lineTo(p.x + 6, yy - r - 3); ctx.lineTo(p.x + 10, yy - r - 2); ctx.closePath(); ctx.fill();
      }
    }
    // THE LOOT LEDGER — how much of OUR gold this one is holding, anchored to
    // the sprite's REAL drawn height (a fixed offset buries it in tall sprites
    // and floats it off short ones). Inflates + reddens as the mouth nears, so
    // the biggest badge on screen is always the most urgent target.
    if (e.stolen > 0) {
      var L = this._ledger || (this._ledger = this._bakeLedger());
      var ci2 = e.stolen >= 6 ? 5 : e.stolen - 1;
      var kk = e.fleeing ? Math.max(0, 1 - e.d / 220) : 0;
      ctx.save();
      ctx.translate(p.x, p.y + 6 + fy - Math.min(hh2 || 30, 78) - 8);
      ctx.scale(1 + 0.45 * kk, 1 + 0.45 * kk);
      if (kk > 0.02) {
        ctx.fillStyle = 'rgba(255,123,123,' + (0.10 + 0.30 * kk) + ')';
        ctx.beginPath();
        ctx.ellipse(0, -L.gh[ci2] * 0.5, L.gw[ci2] * 0.5 + 3 + 4 * kk, L.gh[ci2] * 0.5 + 3 + 4 * kk, 0, 0, 6.283);
        ctx.fill();
      }
      var cell = LEDGER_CELL * LEDGER_S;
      ctx.drawImage(L.c, 0, ci2 * cell, cell, cell,
        -LEDGER_CELL / 2, -(LEDGER_CELL - LEDGER_BOT), LEDGER_CELL, LEDGER_CELL);
      ctx.restore();
    }
    // hp bar (only when hurt)
    if (e.hp < e.maxHp) {
      var w = e.type === 'boss' ? 36 : 20;
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(p.x - w / 2, p.y - 20 + fy - (e.type === 'boss' ? 14 : 0), w, 3.5);
      ctx.fillStyle = e.fleeing ? '#ff7b7b' : '#9ef58f';
      ctx.fillRect(p.x - w / 2, p.y - 20 + fy - (e.type === 'boss' ? 14 : 0), w * Math.max(0, e.hp / e.maxHp), 3.5);
    }
    // burn flicker
    if (e.burnT > 0) {
      ctx.fillStyle = 'rgba(255,138,60,0.6)';
      ctx.beginPath(); ctx.arc(p.x + Math.sin(this.worldT * 20 + e.id) * 3, p.y - 16 + fy, 3, 0, 6.283); ctx.fill();
    }
    // slow tint
    if (e.slowT > 0) {
      ctx.fillStyle = 'rgba(140,200,255,0.25)';
      ctx.beginPath(); ctx.ellipse(p.x, p.y - 9 + fy, 12, 13, 0, 0, 6.283); ctx.fill();
    }
  };

  Game.prototype._drawHero = function (ctx) {
    var h = this.hero;
    // While a manned plate is up, Wick is PAINTED INTO the machine sprite, so
    // his own sprite must not be drawn or there are two of him on one machine.
    // Only the BODY is skipped — the selection ring, the charged-breath ring
    // and the breath meter are his UI and stay anchored to him.
    //
    // Falls back to the old lifted sprite for any machine whose manned plate
    // has not loaded or does not exist, so manning never has a frame with no
    // dragon in it.
    // DOWNED — he is not on the field. Drawing him greyed out in place would
    // read as "still there but sad"; a scorch mark and a countdown reads as
    // gone, which is what the sim means.
    if (h.downT > 0) {
      var dz = 1 - h.downT / CFG.heroDownTime;
      ctx.save();
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = 'rgba(20,12,8,0.8)';
      ctx.beginPath(); ctx.ellipse(h.x, h.y, 20, 8, 0, 0, 6.283); ctx.fill();
      ctx.globalCompositeOperation = 'lighter';
      for (var sm = 0; sm < 3; sm++) {
        var sp3 = (this.worldT * 0.6 + sm * 0.33) % 1;
        ctx.fillStyle = 'rgba(150,130,120,' + (0.30 * (1 - sp3)).toFixed(3) + ')';
        ctx.beginPath();
        ctx.arc(h.x + Math.sin(sp3 * 6 + sm) * 7, h.y - 10 - sp3 * 34, 4 + sp3 * 8, 0, 6.283);
        ctx.fill();
      }
      ctx.restore();
      ctx.textAlign = 'center';
      ctx.font = 'bold 12px system-ui, sans-serif';
      inkText(ctx, Math.ceil(h.downT) + 's', h.x, h.y - 34, '#ff9a9a', 4, 1);
      ctx.font = 'bold 9px system-ui, sans-serif';
      inkText(ctx, 'WICK IS DOWN', h.x, h.y - 20, 'rgba(255,170,170,0.85)', 3, 1);
      // a thin ring closing as he recovers
      ctx.strokeStyle = 'rgba(158,245,143,0.75)'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(h.x, h.y, 22, -1.5708, -1.5708 + 6.283 * dz); ctx.stroke();
      ctx.textAlign = 'left';
      return;
    }

    var inPlate = false;
    if (h.manned) {
      var mtw = this._towerByTid(h.manTid);
      inPlate = !!(mtw && ART.images['t_' + mtw.type + '_manned']);
    }
    if (h.selected) {
      ctx.strokeStyle = 'rgba(158,245,143,0.8)'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.arc(h.x, h.y, 26, 0, 6.283); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(158,245,143,0.08)';
      ctx.beginPath(); ctx.arc(h.x, h.y, h.range, 0, 6.283); ctx.fill();
    }
    // MANNED: he is perched ON the machine, so lift him and drop the ground
    // shadow (he is not standing on the floor any more).
    var lift = h.manned ? 26 : 0;
    if (!h.manned) groundShadow(ctx, h.x, h.y, 44 * depthScale(h.y), 0, 1);
    var hdx2 = h.tx - h.x, hdy2 = h.ty - h.y;
    var hMoving2 = Math.abs(hdx2) + Math.abs(hdy2) > 3;
    var goingAway = hMoving2 && hdy2 < -Math.abs(hdx2) * 0.7;   // mostly up-screen
    // inPlate: his body lives in the machine's own sprite this frame
    var himg = inPlate ? null
             : (goingAway && ART.images.hero_back) ? ART.images.hero_back : ART.images.hero;
    if (himg) {
      // hover bob + sway; face the direction he's headed
      var ht = this.worldT;
      var hflip = (h.tx - h.x) > 0.5 ? -1 : 1;   // sprite faces left natively
      var hmoving = Math.abs(h.tx - h.x) + Math.abs(h.ty - h.y) > 3;
      var hsq = 1 + Math.sin(ht * (hmoving ? 9 : 5)) * (hmoving ? 0.05 : 0.035);
      var hh0 = HERO_H, hw0 = hh0 * (himg.width / himg.height);
      // the sprite is drawn facing LEFT natively, so world-facing is -hflip.
      // _muzzle() reads this to put the breath where his mouth is.
      this._heroFace = -hflip;
      // BREATH RECOIL — a short kick back and up, easing out. b runs 1 -> 0.
      var b = Math.max(0, (this._breathT || 0) / 0.42);
      var kick = b * b;
      ctx.save();
      ctx.translate(h.x - (this._heroFace) * kick * 4,
                    h.y + 5 - lift - kick * 3 + Math.sin(ht * (hmoving ? 8 : 4)) * (hmoving ? 2.2 : 1.5));
      ctx.rotate(Math.sin(ht * 3) * 0.04 + (hmoving ? -hflip * 0.07 : 0) + this._heroFace * kick * 0.22);
      ctx.scale(hflip * (2 - hsq) * (1 + kick * 0.10), hsq * (1 + kick * 0.06));
      ctx.drawImage(himg, -hw0 / 2, -hh0, hw0, hh0);
      // THE MOUTH OPENS. The painted plate has a closed muzzle and there is no
      // open-mouthed variant, so the jaw is drawn: a dark throat wedge at the
      // snout with a hot core, scaled by the same eased kick. It sits inside
      // the sprite's own transform, so the mirror puts it on whichever side he
      // is facing and it can never drift off his face.
      if (b > 0.01) {
        var mx = -hw0 * MUZZLE_FWD, my = -hh0 * MUZZLE_UP;
        var open = Math.sin(Math.min(1, b * 1.35) * Math.PI) * 0.9 + 0.1;
        ctx.save();
        ctx.translate(mx, my);
        ctx.scale(1, open);
        ctx.fillStyle = 'rgba(28,8,4,0.92)';                 // the open throat
        ctx.beginPath(); ctx.ellipse(0, 0, 5.2, 4.6, 0, 0, 6.283); ctx.fill();
        ctx.fillStyle = 'rgba(255,120,40,0.85)';             // fire down the gullet
        ctx.beginPath(); ctx.ellipse(-0.6, 0.6, 3.4, 3.0, 0, 0, 6.283); ctx.fill();
        ctx.fillStyle = 'rgba(255,240,190,0.9)';
        ctx.beginPath(); ctx.ellipse(-1.0, 0.8, 1.6, 1.4, 0, 0, 6.283); ctx.fill();
        ctx.restore();
        // the jet leaving the mouth, drawn in the sprite's local frame so it
        // always leaves the snout and never the floor
        // A CONE, narrow at the lips and wide at the far end — a lens shape
        // reads as a spark, not as breath. Brightness peaks mid-beat rather
        // than tracking b, so the jet is at its hottest while the jaw is at
        // its widest instead of already fading by the time the mouth is open.
        var jb = Math.sin(Math.min(1, b * 1.25) * Math.PI);
        var jl = 30 + 52 * (1 - b);            // it REACHES as the beat plays out
        var jw = 5 + 17 * (1 - b);             // and spreads
        ctx.globalCompositeOperation = 'lighter';
        for (var jp = 0; jp < 2; jp++) {       // outer flame, then the white core
          var k2 = jp ? 0.42 : 1;
          var jg = ctx.createLinearGradient(mx, my, mx - jl * k2, my);
          if (jp) {
            jg.addColorStop(0, 'rgba(255,252,235,' + (0.95 * jb).toFixed(3) + ')');
            jg.addColorStop(1, 'rgba(255,220,140,0)');
          } else {
            jg.addColorStop(0.00, 'rgba(255,236,170,' + (0.90 * jb).toFixed(3) + ')');
            jg.addColorStop(0.40, 'rgba(255,150,50,' + (0.72 * jb).toFixed(3) + ')');
            jg.addColorStop(1.00, 'rgba(210,60,20,0)');
          }
          ctx.fillStyle = jg;
          ctx.beginPath();
          ctx.moveTo(mx, my - 3.2 * open);
          ctx.quadraticCurveTo(mx - jl * k2 * 0.55, my - jw * k2 * 0.55,
                               mx - jl * k2, my - jw * k2);
          ctx.quadraticCurveTo(mx - jl * k2 * 1.06, my, mx - jl * k2, my + jw * k2);
          ctx.quadraticCurveTo(mx - jl * k2 * 0.55, my + jw * k2 * 0.55,
                               mx, my + 3.2 * open);
          ctx.closePath(); ctx.fill();
        }
        // Muzzle bloom — the light the jet throws back onto his own snout.
        // BIASED FORWARD. Centred on the muzzle at r=16 it reached 21 world
        // units BEHIND his head (measured off the canvas: recoil suppressed,
        // fire alone still lit pixels a third of a body-length back), which
        // read as a pale bar across his brow rather than as flame. Offsetting
        // the centre down the jet keeps the backscatter to a few units.
        var mbx = mx - 7;
        var mb = ctx.createRadialGradient(mbx, my, 0, mbx, my, 12);
        mb.addColorStop(0, 'rgba(255,210,130,' + (0.55 * jb).toFixed(3) + ')');
        mb.addColorStop(1, 'rgba(255,160,60,0)');
        ctx.fillStyle = mb;
        ctx.beginPath(); ctx.arc(mbx, my, 12, 0, 6.283); ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.restore();
    }
    else if (!inPlate) {
      // procedural fallback ONLY when he genuinely has no sprite. Guarded on
      // inPlate too, or a manned machine would get a chunky drawn dragon
      // stacked on top of the painted one.
      var bob = Math.sin(this.worldT * 4) * 1.5;
      // ember the whelp: round ruby dragonling
      ctx.fillStyle = '#d64545';
      ctx.beginPath(); ctx.ellipse(h.x, h.y - 14 + bob, 13, 15, 0, 0, 6.283); ctx.fill();
      ctx.fillStyle = '#ff8a63';
      ctx.beginPath(); ctx.ellipse(h.x, h.y - 10 + bob, 8, 9, 0, 0, 6.283); ctx.fill();
      // wings
      var wb = Math.sin(this.worldT * 6) * 0.5;
      ctx.fillStyle = '#a83838';
      ctx.beginPath(); ctx.ellipse(h.x - 14, h.y - 20 + bob, 8, 4 + wb * 2, 0.6, 0, 6.283); ctx.fill();
      ctx.beginPath(); ctx.ellipse(h.x + 14, h.y - 20 + bob, 8, 4 - wb * 2, -0.6, 0, 6.283); ctx.fill();
      // eyes + horns
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(h.x - 4, h.y - 20 + bob, 3.2, 0, 6.283); ctx.fill();
      ctx.beginPath(); ctx.arc(h.x + 4, h.y - 20 + bob, 3.2, 0, 6.283); ctx.fill();
      ctx.fillStyle = '#1c1c1c';
      ctx.beginPath(); ctx.arc(h.x - 3.4, h.y - 20 + bob, 1.5, 0, 6.283); ctx.fill();
      ctx.beginPath(); ctx.arc(h.x + 4.6, h.y - 20 + bob, 1.5, 0, 6.283); ctx.fill();
      ctx.fillStyle = '#ffcf6a';
      ctx.beginPath(); ctx.moveTo(h.x - 8, h.y - 26 + bob); ctx.lineTo(h.x - 10, h.y - 33 + bob); ctx.lineTo(h.x - 4, h.y - 28 + bob); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(h.x + 8, h.y - 26 + bob); ctx.lineTo(h.x + 10, h.y - 33 + bob); ctx.lineTo(h.x + 4, h.y - 28 + bob); ctx.closePath(); ctx.fill();
    }
    // charged: a pulsing flame ring says TAP ME
    if (h.breathCd <= 0 && this.state === 'playing') {
      var rp = 0.6 + 0.4 * Math.sin(this.worldT * 6);
      ctx.strokeStyle = 'rgba(255,154,60,' + rp + ')';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(h.x, h.y - 14, 24 + rp * 4, 0, 6.283); ctx.stroke();
      ctx.fillStyle = 'rgba(255,207,106,' + (0.7 + rp * 0.3) + ')';
      ctx.beginPath(); ctx.ellipse(h.x, h.y - 46, 4, 7 + rp * 2, 0, 0, 6.283); ctx.fill();
    }
    // HEALTH — shown only when hurt, so a healthy Wick keeps a clean silhouette
    if (h.hp < h.maxHp) {
      var hpf = Math.max(0, h.hp / h.maxHp);
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(h.x - 16, h.y - 50, 32, 4);
      ctx.fillStyle = hpf > 0.5 ? '#9ef58f' : hpf > 0.25 ? '#ffd75e' : '#ff5b5b';
      ctx.fillRect(h.x - 16, h.y - 50, 32 * hpf, 4);
    }
    // breath meter
    if (h.breathCd > 0 && h.breathCd < 14) {
      ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fillRect(h.x - 12, h.y - 42, 24, 3);
      ctx.fillStyle = '#ff9a3c'; ctx.fillRect(h.x - 12, h.y - 42, 24 * (1 - h.breathCd / 14), 3);
    }
  };

  // R3D overlay: the sim UI that used to ride _drawEnemy/_drawParticles,
  // re-anchored through R3D.remap so it sits exactly over the 3D bodies.
  Game.prototype._drawOverlay3d = function (ctx) {
    for (var i = 0; i < this.enemies.length; i++) {
      var e = this.enemies[i];
      var p = R3D.remap(e.px, e.py, e.flyer && !(e.groundedT > 0) ? 30 : 0);
      if (e.hp < e.maxHp) {
        var w = e.type === 'boss' ? 36 : 20;
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(p.x - w / 2, p.y - 46, w, 3.5);
        ctx.fillStyle = e.fleeing ? '#ff7b7b' : '#9ef58f';
        ctx.fillRect(p.x - w / 2, p.y - 46, w * Math.max(0, e.hp / e.maxHp), 3.5);
      }
      if (e.stolen > 0) {
        ctx.fillStyle = '#ffd75e';
        ctx.beginPath(); ctx.arc(p.x, p.y - 54, 5, 0, 6.283); ctx.fill();
        ctx.strokeStyle = '#8a5a1d'; ctx.lineWidth = 1; ctx.stroke();
      }
      if (e.slowT > 0) {
        ctx.fillStyle = 'rgba(140,200,255,0.30)';
        ctx.beginPath(); ctx.ellipse(p.x, p.y - 20, 12, 14, 0, 0, 6.283); ctx.fill();
      }
    }
    // floats + simple particles, remapped
    for (var f2 = 0; f2 < this.floats.length; f2++) {
      var fl2 = this.floats[f2];
      var fp = R3D.remap(fl2.x, fl2.y);
      ctx.globalAlpha = Math.min(1, fl2.t);
      ctx.fillStyle = fl2.c;
      ctx.font = 'bold 15px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(fl2.txt, fp.x, fp.y);
    }
    ctx.globalAlpha = 1; ctx.textAlign = 'left';
    // escape pressure at the cave mouth (the O(1) alarm, remapped)
    var esc = 0;
    for (var q2 = 0; q2 < this.enemies.length; q2++) {
      var c3 = this.enemies[q2];
      if (c3.fleeing && c3.stolen > 0) esc = Math.max(esc, 1 - Math.min(1, c3.d / 220));
    }
    if (esc > 0.02) {
      var m1 = pathPointAt(0), mp3 = R3D.remap(m1.x, m1.y);
      var pul2 = 0.65 + 0.35 * Math.sin(this.worldT * (4 + 8 * esc));
      ctx.strokeStyle = 'rgba(255,123,123,' + (0.2 + 0.6 * esc * pul2) + ')';
      ctx.lineWidth = 2 + 5 * esc;
      ctx.beginPath(); ctx.ellipse(mp3.x, mp3.y, 40 + 26 * esc, 18 + 12 * esc, 0, 0, 6.283); ctx.stroke();
    }
    // Mother's Breath prompt still needs its tap target visible
    if (this.motherReady) {
      var kp2 = R3D.remap(MAP.keep.x, MAP.keep.y - 20);
      var kg = 0.5 + 0.5 * Math.sin(this.worldT * 4);
      ctx.strokeStyle = 'rgba(255,207,106,' + (0.35 + 0.5 * kg) + ')'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(kp2.x, kp2.y, 46 + kg * 6, 0, 6.283); ctx.stroke();
    }
  };

  Game.prototype._drawParticles = function (ctx) {
    for (var i = 0; i < this.particles.length; i++) {
      var pa = this.particles[i];
      var a = Math.max(0, pa.life / pa.T);
      if (pa.kind === 'dot') {
        ctx.globalAlpha = a;
        ctx.fillStyle = pa.c;
        ctx.beginPath(); ctx.arc(pa.x, pa.y, pa.r, 0, 6.283); ctx.fill();
      } else if (pa.kind === 'flash') {
        ctx.globalAlpha = a * 0.4;
        ctx.fillStyle = '#ff9a3c';
        ctx.fillRect(-40, -40, WORLD_W + 80, WORLD_H + 80);
      } else if (pa.kind === 'coin') {
        ctx.globalAlpha = Math.min(1, a * 2);
        ctx.fillStyle = '#ffd75e';
        ctx.beginPath(); ctx.arc(pa.cx || pa.x, pa.cy || pa.y, 4, 0, 6.283); ctx.fill();
        ctx.strokeStyle = '#8a5a1d'; ctx.lineWidth = 1; ctx.stroke();
      } else if (pa.kind === 'ring') {
        ctx.globalAlpha = a * 0.7;
        ctx.strokeStyle = pa.c; ctx.lineWidth = 2;
        var rr4 = pa.R * (1 - a);
        ctx.beginPath(); ctx.arc(pa.x, pa.y, Math.max(pa.r, rr4), 0, 6.283); ctx.stroke();
      } else if (pa.kind === 'tracer') {
        ctx.globalAlpha = a;
        ctx.strokeStyle = pa.c; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(pa.x1, pa.y1); ctx.lineTo(pa.x2, pa.y2); ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    for (var f = 0; f < this.floats.length; f++) {
      var fl = this.floats[f];
      ctx.globalAlpha = Math.min(1, fl.t);
      ctx.fillStyle = fl.c;
      ctx.font = 'bold 15px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(fl.txt, fl.x, fl.y);
      ctx.textAlign = 'left';
    }
    ctx.globalAlpha = 1;
  };

  // world-anchored hints only (the pad ring); everything else lives in the
  // view-anchored HUD so it hugs the REAL screen edges on every device
  Game.prototype._drawWorldHints = function (ctx) {
    // The first-run hint used to pulse a ring around MAP.pads[3] and say "Tap a
    // stone ring to build a defender". Free placement removed tap-to-build from
    // pads — the shop owns building now and a pad is just cheaper ground — so
    // the very first instruction a new player received was a dead end: the tap
    // it asked for does nothing at all. The hint lives on the shop now, in
    // _drawHudView, where the thing it points at actually is.
  };

  // gold-trimmed slate panel — the art-bible UI language
  function uiPanel(ctx, x, y, w, h, r) {
    var g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, 'rgba(48,33,22,0.95)');
    g.addColorStop(1, 'rgba(22,15,12,0.95)');
    ctx.fillStyle = g;
    rr(ctx, x, y, w, h, r); ctx.fill();
    ctx.strokeStyle = 'rgba(212,168,64,0.55)'; ctx.lineWidth = 1.5;
    rr(ctx, x + 0.75, y + 0.75, w - 1.5, h - 1.5, Math.max(2, r - 1)); ctx.stroke();
  }

  // VIEW-space HUD: screen-anchored, safe-area aware. Returns nothing; the tap
  // handler recomputes identical geometry from this.view.
  Game.prototype._hudGeom = function () {
    var v = this.view;
    var topY = Math.max(8, v.safeT + 4);
    var cx = v.w / 2;
    var bm = Math.max(10, v.safeB + 6);       // bottom margin, safe-area aware
    return {
      topY: topY, cx: cx,
      barX: Math.max(8, v.ox + 8),
      barW: Math.min(v.w - 16, WORLD_W - 16),
      btnY: topY + 7,
      mute: v.w / 2 + WORLD_W / 2 - 168, pause: v.w / 2 + WORLD_W / 2 - 112, spd: v.w / 2 + WORLD_W / 2 - 56,
      // ---- bottom stack -------------------------------------------------
      // The machine shop is the BOTTOM-MOST row and the action row sits above
      // it, per VANUS. It used to be the other way up, which put the shop bar
      // across world y 713..767 — right on top of two of level 1's eight build
      // pads (300,758) and (168,736). They were not merely hard to see: the
      // shop's hit test claimed the whole band before the world-tap path ran,
      // so those pads could not be tapped at all.
      //
      // Anchoring the shop to the very bottom pushes it below world y 780 on
      // any phone with letterbox bands, which clears the map completely. On a
      // bandless screen (SE-class, 375x667) some overlap is unavoidable while
      // those two pads sit that low — see HANDOFF; moving them is a balance
      // change and therefore VANUS's call, not a layout fix.
      shopY: v.h - bm - 56,
      shopX: v.w / 2 - WORLD_W / 2 + 12,
      shopW: 52, shopStep: 56, shopH: 56,
      // Wick's breath lives on its own button. It used to fire when you tapped
      // HIM, which ate the tap that was supposed to pick him up and move him.
      breathX: v.w / 2 - WORLD_W / 2 + 10,
      breathY: v.h - bm - 56 - 10 - 62,
      startY: v.h - bm - 56 - 10 - 57,
    };
  };

  // TITLE geometry — ONE source, consumed by both _drawTitle and the 'menu'
  // branch of the tap handler, exactly like _hudGeom does for the HUD. These
  // were 14 hand-duplicated magic numbers sitting ~1,650 lines apart; they
  // happened to agree, and a screen this dense would not have kept it up.
  //
  // Hit rects are INFLATED past the visual rects and derived from view.scale,
  // so every target clears Apple's 44pt minimum BY CONSTRUCTION rather than on
  // the devices someone happened to test. The old bottom row was 36 world
  // units — 26-37 CSS px — and failed on every device made.
  /// Trials-screen geometry. Derived, not hardcoded, so adding a seventh
  /// mutator re-fits the list instead of pushing the last row off-screen —
  /// which is exactly what six rows did at the original 108px pitch
  /// (250 + 5*108 + 96 = 886 against a 780-unit world).
  // Rival picker geometry — ONE source for draw and tap, same discipline as
  // trialGeom/_titleGeom. Rows are the tap targets and are derived from the
  // back-button position, so adding a fifth rival re-flows instead of
  // overflowing off the bottom of the screen.
  function duelGeom() {
    var n = RIVAL_ORDER.length;
    var top = 226, backY = 664, gap = 10;
    var pitch = Math.min(104, Math.floor((backY - 24 - top + gap) / n));
    return { top: top, pitch: pitch, h: pitch - gap, backY: backY,
             x: 30, w: WORLD_W - 60 };
  }

  function trialGeom() {
    var n = TRIAL_ORDER.length;
    var top = 214, backY = 664, gap = 8;
    // last row's BOTTOM is top + n*pitch - gap, and it must clear BACK
    var pitch = Math.min(108, Math.floor((backY - 24 - top + gap) / n));
    var h = pitch - gap;
    // The level chips run the FULL height of the row and are the tap targets,
    // so a compact row shrinks the text, never the thing you have to hit. At
    // the old (h - 46) they collapsed to 14 units on a six-trial list — about
    // 14 CSS px, a third of the 44pt minimum.
    return { top: top, pitch: pitch, h: h, chipY: 8, chipH: Math.max(30, h - 16),
             backY: backY };
  }

  Game.prototype._titleGeom = function () {
    var s = this.view.scale || 1;
    var minH = Math.max(62, 44 / s);
    function row(y, h) {
      var pad = (minH - h) / 2;
      return { x: 80, y: y, w: 260, h: h,
               hx: 62, hy: y - pad, hw: 296, hh: minH };
    }
    var pillY = 676, pillH = 52, pillPad = (minH - pillH) / 2;
    var pills = [];
    for (var i = 0; i < 3; i++) {
      pills.push({ x: 48 + i * 102, y: pillY, w: 120, h: pillH,
                   hx: 44 + i * 102, hy: pillY - pillPad, hw: 128, hh: minH });
    }
    // TONIGHT band: two half-width plates instead of one full-width row.
    // WORLD_H is 780 and the campaign ladder already spends 348..540; a fifth
    // full-width row needs 62 more (minH is the 44pt floor, and it BINDS on
    // every phone) and there are only 35 free above the utility pills. Two
    // columns cost zero vertical. They also read correctly: the Daily and the
    // Duel are both "one fight tonight" against the campaign's ladder.
    // Hit boxes are 38..208 and 212..382 — a deliberate 4px gutter, because
    // hit() is inclusive on both bounds and touching rects would make the
    // shared edge belong to whichever branch the tap handler tested first.
    function half(x, y, w, h) {
      var pad = (minH - h) / 2;
      return { x: x, y: y, w: w, h: h, hx: x - 4, hy: y - pad, hw: w + 8, hh: minH };
    }
    return { rows: [row(368, 52), row(430, 52), row(492, 52)],
             daily: half(42, 578, 162, 54), duel: half(216, 578, 162, 54),
             pills: pills };
  };

  function hit(w, r) {
    return w.x >= r.hx && w.x <= r.hx + r.hw && w.y >= r.hy && w.y <= r.hy + r.hh;
  }

  Game.prototype._drawHudView = function (ctx) {
    var v = this.view, G = this._hudGeom();
    // The resource bar belongs to a RUN. It used to draw unconditionally, so
    // the title screen wore an opaque "60 / GOLD 120 / WAVE 1/20" slab for a
    // game that had not started — inert, but it read as leftover UI and it is
    // the first thing on the screen.
    if (this.state === 'menu' || this.state === 'forge' || this.state === 'trials' ||
        this.state === 'duel') return;
    // top bar
    uiPanel(ctx, G.barX, G.topY, G.barW, 48, 13);
    var lx = G.barX + 14;
    ctx.fillStyle = '#ffd75e';
    ctx.beginPath(); ctx.arc(lx + 10, G.topY + 24, 10, 0, 6.283); ctx.fill();
    ctx.strokeStyle = '#8a5a1d'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#fff2d8'; ctx.font = 'bold 20px Georgia, serif';
    ctx.fillText(String(this.hoard), lx + 27, G.topY + 31);
    ctx.fillStyle = '#b9a27f'; ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.fillText('GOLD', lx + 82, G.topY + 18);
    ctx.fillStyle = '#fff2d8'; ctx.font = 'bold 19px Georgia, serif';
    ctx.fillText(String(this.gold), lx + 82, G.topY + 38);
    ctx.fillStyle = '#b9a27f'; ctx.font = 'bold 11px system-ui, sans-serif';
    ctx.fillText('WAVE', lx + 152, G.topY + 18);
    ctx.fillStyle = '#fff2d8'; ctx.font = 'bold 19px Georgia, serif';
    var tot = this.totalWaves();
    ctx.fillText((this.waveActive ? this.wave + 1 : Math.min(this.wave + 1, tot === Infinity ? this.wave + 1 : tot)) + (tot === Infinity ? '' : '/' + tot), lx + 152, G.topY + 38);
    if (this.trial) {   // which trial this run is — always visible, never loud
      ctx.fillStyle = 'rgba(168,230,255,0.85)'; ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.fillText('TRIAL: ' + TRIALS[this.trial].name.toUpperCase(), lx + 27, G.topY + 50);
    }
    // ---- THE DUEL STRIP ---------------------------------------------------
    // A second, dimmer hoard under your own. It sits in the band the TRIAL line
    // uses — the two can never collide, because a duel takes no trial.
    // The number that matters is the MARGIN, so the margin is the loud element
    // and the rival's raw hoard is the quiet one: "am I ahead" is the question
    // being asked every three seconds, and it should not need arithmetic.
    if (this.rival && (this.state === 'playing' || this.state === 'paused')) {
      var dsY = G.topY + 52;
      uiPanel(ctx, G.barX, dsY, G.barW, 26, 9);
      var pulse = Math.max(0, 1 - (this.worldT - this.rivalStepT) / 1.2);
      var dlx = G.barX + 14;
      // rival's coin pip — deliberately cool and dim against your warm gold,
      // so a glance never mistakes their pile for yours
      ctx.fillStyle = '#7f93a8';
      ctx.beginPath(); ctx.arc(dlx + 7, dsY + 13, 7, 0, 6.283); ctx.fill();
      ctx.strokeStyle = '#3f4c5a'; ctx.lineWidth = 1.5; ctx.stroke();
      ctx.fillStyle = '#cfe0f0'; ctx.font = 'bold 15px Georgia, serif';
      ctx.textAlign = 'left';
      ctx.fillText(String(Math.max(0, this.rivalHoard)), dlx + 20, dsY + 19);
      ctx.fillStyle = 'rgba(190,210,230,0.78)'; ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.fillText(this.rival.name.toUpperCase(), dlx + 52, dsY + 17);
      // the margin chip
      var mg = this.hoard - this.rivalHoard;
      var ahead = mg >= 0;
      var chipW = 62, chipX = G.barX + G.barW - chipW - 10;
      ctx.fillStyle = ahead ? 'rgba(60,120,64,0.55)' : 'rgba(140,54,44,0.55)';
      rr(ctx, chipX, dsY + 4, chipW, 18, 7); ctx.fill();
      if (pulse > 0) {                     // the swing announces itself, briefly
        ctx.strokeStyle = (ahead ? 'rgba(158,245,143,' : 'rgba(255,154,106,') + (0.85 * pulse).toFixed(3) + ')';
        ctx.lineWidth = 2; rr(ctx, chipX, dsY + 4, chipW, 18, 7); ctx.stroke();
      }
      ctx.textAlign = 'center';
      ctx.font = 'bold 12px system-ui, sans-serif';
      inkText(ctx, (ahead ? '+' : '') + mg, chipX + chipW / 2, dsY + 17,
              ahead ? '#bdf5b0' : '#ffc0ae', 3, 1);
      ctx.textAlign = 'left';
    }
    // Smothered Fire takes the flame away, so the button goes with it — an
    // unusable control that still sits there reads as a bug, not a rule.
    if (this.state === 'playing' && !this.mods.breathOff) {
      // BREATH button — charged is loud, cooling is a shrinking dark wedge
      var bReady = this.hero.breathCd <= 0;
      var bFrac = bReady ? 1 : 1 - this.hero.breathCd / (this.mods.breathCd || 14);
      var bcx = G.breathX + 31, bcy = G.breathY + 31;
      ctx.fillStyle = bReady ? 'rgba(90,40,14,0.95)' : 'rgba(34,26,22,0.9)';
      ctx.beginPath(); ctx.arc(bcx, bcy, 28, 0, 6.283); ctx.fill();
      if (!bReady) {
        ctx.fillStyle = 'rgba(255,138,60,0.30)';
        ctx.beginPath(); ctx.moveTo(bcx, bcy);
        ctx.arc(bcx, bcy, 28, -1.5708, -1.5708 + 6.283 * bFrac); ctx.closePath(); ctx.fill();
      }
      var bpul = bReady ? 0.72 + 0.28 * Math.sin(this.worldT * 5) : 0.3;
      if (bReady) {                            // charged: the button throws light
        ctx.globalCompositeOperation = 'lighter';
        var bg3 = ctx.createRadialGradient(bcx, bcy, 4, bcx, bcy, 46);
        bg3.addColorStop(0, 'rgba(255,140,50,' + (0.16 + 0.06 * Math.sin(this.worldT * 5)).toFixed(3) + ')');
        bg3.addColorStop(1, 'rgba(255,140,50,0)');
        ctx.fillStyle = bg3;
        ctx.beginPath(); ctx.arc(bcx, bcy, 46, 0, 6.283); ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.strokeStyle = 'rgba(255,150,60,' + bpul + ')'; ctx.lineWidth = bReady ? 3 : 1.5;
      ctx.beginPath(); ctx.arc(bcx, bcy, 28, 0, 6.283); ctx.stroke();
      flameGlyph(ctx, bcx, bcy - 4, 1.15, this.worldT, bReady);
      ctx.textAlign = 'center';
      ctx.font = 'bold 9px system-ui, sans-serif';
      inkText(ctx, bReady ? 'BREATH' : Math.ceil(this.hero.breathCd) + 's', bcx, bcy + 21,
              bReady ? '#ffcf6a' : '#8a7f72', 3, 1);
      // WHAT IT DOES, on the button. VANUS: "I'm not even sure what the breath
      // does exactly" — and nothing in the game had ever said. It is a 26-damage
      // burst on everything within Wick's radius that ignores armour, which is
      // the only answer to a Bulwark pack, so the armour clause is the half
      // worth the pixels.
      // ABOVE the button, not below: below is the machine shelf, and the label
      // sat on top of the first two cards.
      if (bReady) {
        ctx.font = 'bold 8px system-ui, sans-serif';
        inkText(ctx, 'BURNS ARMOR', bcx, bcy - 36, 'rgba(255,190,120,0.92)', 4, 1);
      }
      ctx.textAlign = 'left';
      // THE SHOP — pick a machine, then tap the cavern floor to place it
      var shelf = this._shelf();
      for (var sc2 = 0; sc2 < shelf.length; sc2++) {
        var sid2 = shelf[sc2], stt = TOWER_TYPES[sid2];
        var sxx = G.shopX + sc2 * G.shopStep, syy = G.shopY;
        var picked = this.shopPick === sc2;
        var chipCost = Math.round(stt.cost * crowdMul(this.towers.length));
        var can = this.gold >= Math.round(chipCost * PAD_DISCOUNT);
        forgePlate(ctx, { x: sxx, y: syy, w: G.shopW, h: G.shopH }, picked ? 'brasslit' : 'util');
        if (picked) {
          ctx.strokeStyle = '#ffd75e'; ctx.lineWidth = 2.5;
          rr(ctx, sxx + 1, syy + 1, G.shopW - 2, G.shopH - 2, 11); ctx.stroke();
        }
        var sIm = ART.images['t_' + sid2];
        if (sIm) {
          // FIT the machine INSIDE its card. It used to be blitted at a fixed
          // 34px wide with its baseline at syy+26, so a 700px-tall master
          // overhung the card by ~17px and floated out over the cavern floor.
          // Seven of them doing that is what made the row read as a heap of
          // stacked clutter instead of a shelf of buttons.
          var boxW = G.shopW - 12, boxH = 32;
          var sc3 = Math.min(boxW / sIm.width, boxH / sIm.height);
          var siw = sIm.width * sc3, sih = sIm.height * sc3;
          ctx.globalAlpha = can ? 1 : 0.42;
          ctx.drawImage(sIm, sxx + G.shopW / 2 - siw / 2, syy + 5 + (boxH - sih), siw, sih);
          ctx.globalAlpha = 1;
        }
        ctx.textAlign = 'center';
        ctx.font = 'bold 11px system-ui, sans-serif';
        inkText(ctx, chipCost + 'g', sxx + G.shopW / 2, syy + G.shopH - 8,
                can ? '#ffd75e' : '#8a7f72', 3, 1);
        ctx.textAlign = 'left';
      }
      if (this.shopPick >= 0) {
        ctx.textAlign = 'center';
        ctx.font = 'bold 12px system-ui, sans-serif';
        inkText(ctx, 'tap the cavern floor to build  ·  pads cost 20% less',
                G.cx, G.shopY - 8, '#ffe9c4', 4, 1);
        ctx.textAlign = 'left';
      } else if (this.mode === 'campaign' && !Save.data.tut && !this.towers.length) {
        // FIRST RUN, step 1: point at the shelf, which is where building now
        // starts. Step 2 is the line above, which the shop already showed.
        var tp = 0.6 + 0.4 * Math.sin(this.worldT * 5);
        ctx.strokeStyle = 'rgba(158,245,143,' + tp.toFixed(3) + ')';
        ctx.lineWidth = 3;
        rr(ctx, G.shopX - 3, G.shopY - 3, G.shopW + 6, G.shopH + 6, 13); ctx.stroke();
        // ABOVE the action row. Sitting it just over the shelf put it inside
        // the START WAVE button's band (measured: plate 810..838, button
        // 777..829), and the button draws after it, so the hint was invisible.
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(16,10,7,0.88)';
        rr(ctx, G.cx - 118, G.startY - 38, 236, 28, 9); ctx.fill();
        ctx.font = 'bold 13px system-ui, sans-serif';
        inkText(ctx, 'Pick a machine, then tap the floor', G.cx, G.startY - 19, '#9ef58f', 4, 1);
        ctx.textAlign = 'left';
      }
      uiPanel(ctx, G.mute, G.btnY, 44, 34, 9);
      uiPanel(ctx, G.pause, G.btnY, 44, 34, 9);
      uiPanel(ctx, G.spd, G.btnY, 44, 34, 9);
      drawSpeaker(ctx, G.mute + 22, G.btnY + 17, Sfx.isMuted());
      ctx.fillStyle = '#ffe9c4';
      ctx.fillRect(G.pause + 14, G.btnY + 9, 5, 16); ctx.fillRect(G.pause + 25, G.btnY + 9, 5, 16);
      ctx.font = 'bold 16px system-ui, sans-serif';
      ctx.fillText(this.speed + 'x', G.spd + 10, G.btnY + 22);
    }
    // first-encounter enemy card: sprite + the counter line
    if (this.infoCard && this.state === 'playing') {
      var card = ENEMY_CARDS[this.infoCard.type];
      var fade = Math.min(1, this.infoCard.t / 0.4);
      ctx.globalAlpha = fade;
      var cw2 = Math.min(v.w - 24, 372);
      var cx2 = v.w / 2 - cw2 / 2, cy2 = G.topY + 56;
      uiPanel(ctx, cx2, cy2, cw2, 58, 12);
      var ei2 = ART.images['e_' + this.infoCard.type];
      if (ei2) {
        var eh2 = 44, ew2 = eh2 * (ei2.width / ei2.height);
        ctx.drawImage(ei2, cx2 + 10, cy2 + 7, ew2, eh2);
      }
      ctx.fillStyle = '#ffd75e'; ctx.font = 'bold 14px system-ui, sans-serif'; ctx.textAlign = 'left';
      ctx.fillText(card[0], cx2 + 58, cy2 + 22);
      ctx.fillStyle = '#e8dcc8'; ctx.font = '11.5px system-ui, sans-serif';
      ctx.fillText(card[1], cx2 + 58, cy2 + 40);
      ctx.globalAlpha = 1;
    }
    // bottom: start-wave button + sprite wave preview + hint
    if (this.state === 'playing' && !this.waveActive && this.wave < this.totalWaves()) {
      var pulse = 0.75 + 0.25 * Math.sin(this.worldT * 4);
      var bx = G.cx - 92, by = G.startY;
      var bg2 = ctx.createLinearGradient(0, by, 0, by + 52);
      bg2.addColorStop(0, 'rgba(226,88,74,' + (0.85 + 0.12 * pulse) + ')');
      bg2.addColorStop(1, 'rgba(168,48,42,' + (0.85 + 0.12 * pulse) + ')');
      ctx.fillStyle = bg2;
      rr(ctx, bx, by, 184, 52, 14); ctx.fill();
      ctx.strokeStyle = '#ffcf6a'; ctx.lineWidth = 2;
      rr(ctx, bx, by, 184, 52, 14); ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = 'bold 19px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(this.wave === 0 ? 'BEGIN THE SIEGE' : 'NEXT WAVE', G.cx, by + (this.wave === 0 ? 32 : 24));
      if (this.wave > 0) {
        ctx.font = 'bold 11px system-ui, sans-serif'; ctx.fillStyle = '#ffe9c4';
        ctx.fillText('auto in ' + Math.ceil(this.countdown) + 's — early pays gold', G.cx, by + 42);
      }
      // preview: ACTUAL enemy sprites, not ambiguous dots
      var groups = this.mode === 'daily' ? dailyWaveComp(this.wave, this.seed) : WAVE_TABLES[this.levelIdx][this.wave];
      var counts = {}, order = [];
      for (var gi = 0; gi < groups.length; gi++) {
        var gt = groups[gi].type;
        if (!counts[gt]) { counts[gt] = 0; order.push(gt); }
        counts[gt] += groups[gi].count;
      }
      var cellW = 58, pw = order.length * cellW;
      // ABOVE THE START BUTTON, not on top of it. This read shopY-30, whose
      // panel rect (py-18..py+18 = shopY-48..shopY-12) covered 33 of the START
      // WAVE plate's 52 units on EVERY viewport: frame one of a new player's
      // first game rendered 'BEGI[scouts]IEGE', and from wave 2 the only tempo
      // instruction in the game -- 'auto in Ns, early pays gold' -- was
      // unreadable, so the early-call bonus was undiscoverable.
      // The panel is draw-only (no hit test), so raising it cannot strand a tap;
      // the BUTTON must not move -- startY-40 was measured to land its rect on
      // level 1's build pad at (248,672).
      var py = G.startY - 32;
      uiPanel(ctx, G.cx - pw / 2 - 10, py - 18, pw + 20, 36, 10);
      for (var oi = 0; oi < order.length; oi++) {
        var px = G.cx - pw / 2 + cellW * oi + 16;
        var eimg = ART.images['e_' + order[oi]];
        if (eimg) {
          var eh = 30, ew = eh * (eimg.width / eimg.height);
          ctx.drawImage(eimg, px - ew / 2, py - 15, ew, eh);
        } else {
          ctx.fillStyle = ENEMY_COLORS[order[oi]] || '#fff';
          ctx.beginPath(); ctx.ellipse(px, py, 8, 9, 0, 0, 6.283); ctx.fill();
        }
        ctx.fillStyle = '#fff2d8'; ctx.font = 'bold 13px system-ui, sans-serif'; ctx.textAlign = 'left';
        ctx.fillText('×' + counts[order[oi]], px + 12, py + 5);
      }
      // second tutorial hint rides above the preview
      if (this.mode === 'campaign' && !Save.data.tut && this.towers.length && this.wave === 0) {
        ctx.textAlign = 'center';
        ctx.fillStyle = 'rgba(16,10,7,0.85)';
        rr(ctx, G.cx - 118, py - 52, 236, 28, 9); ctx.fill();
        ctx.fillStyle = '#ffd75e'; ctx.font = 'bold 13px system-ui, sans-serif';
        ctx.fillText('Ready? Call the wave — early calls pay gold', G.cx, py - 33);
      }
      ctx.textAlign = 'left';
    }
  };

  Game.prototype._drawMenus = function (ctx) {
    var m = this.menu;
    if (m.forkFor !== undefined) {                 // L3 fork chooser cards
      var ftw = this.towers[m.forkFor];
      if (!ftw) return;
      var ftt = TOWER_TYPES[ftw.type];
      var fcost = ftt.levels[1].upgradeCost;
      var cards = this._forkCards(ftw);
      var v = this.view;
      ctx.fillStyle = 'rgba(10,6,4,0.55)';         // scrim: this is a commitment
      ctx.fillRect(-v.ox - 60, -v.oy - 60, v.w + 120, v.h + 120);   // FULL view, bands included
      for (var fc = 0; fc < 2; fc++) {
        var fk = ftt.forks[fc], cr = cards[fc];
        var col = fc ? '#a8e6ff' : '#ffd75e';
        ctx.fillStyle = 'rgba(38,26,18,0.97)';
        rr(ctx, cr.x, cr.y, cr.w, cr.h, 10); ctx.fill();
        ctx.strokeStyle = col; ctx.lineWidth = 2;
        rr(ctx, cr.x, cr.y, cr.w, cr.h, 10); ctx.stroke();
        ctx.textAlign = 'left';
        ctx.fillStyle = col; ctx.font = 'bold 14px system-ui, sans-serif';
        ctx.fillText(fk.name, cr.x + 12, cr.y + 22);
        ctx.fillStyle = '#ffd75e'; ctx.font = 'bold 11px system-ui, sans-serif';
        ctx.textAlign = 'right'; ctx.fillText(fcost + 'g', cr.x + cr.w - 10, cr.y + 22);
        ctx.textAlign = 'left';
        ctx.fillStyle = '#ffe9c4'; ctx.font = '11px system-ui, sans-serif';
        // pitch wraps to two lines at the nearest space to the middle
        var words = fk.pitch.split(' '), l1 = '', l2 = '';
        for (var wd = 0; wd < words.length; wd++) {
          if (l1.length < fk.pitch.length / 2) l1 += (l1 ? ' ' : '') + words[wd];
          else l2 += (l2 ? ' ' : '') + words[wd];
        }
        ctx.fillText(l1, cr.x + 12, cr.y + 40);
        ctx.fillText(l2, cr.x + 12, cr.y + 54);
      }
      ctx.textAlign = 'center';
      ctx.fillStyle = '#c9b8a8'; ctx.font = '11px system-ui, sans-serif';
      ctx.fillText('Pick one — this machine keeps it', cards[0].x + cards[0].w / 2, cards[0].y - 10);
      ctx.textAlign = 'left';
      return;
    }
    if (m.towerIdx !== undefined) {
      var tw = this.towers[m.towerIdx];
      if (!tw) return;
      var pad2 = tw;
      var lvl = lvlRow(tw);
      pad2 = this._uiAnchor(pad2);
      // A SUPPORT MACHINE NEVER TARGETS ANYTHING, so AIM was three taps of
      // visible state change and zero behaviour. It is gone for supports, and
      // the button COUNT changes with it — the draw and the tap handler derive
      // their indices from the same two lines so they cannot disagree about
      // which circle is under the finger.
      var isSup = !!TOWER_TYPES[tw.type].support;
      var nb = isSup ? 3 : 4;
      var up = this._menuBtnPos(pad2, 0, nb);
      var aim = isSup ? null : this._menuBtnPos(pad2, 1, nb);
      var man = this._menuBtnPos(pad2, isSup ? 1 : 2, nb);
      var sell = this._menuBtnPos(pad2, isSup ? 2 : 3, nb);
      var isManned = this.hero.manTid === tw.tid;
      ctx.fillStyle = isManned ? 'rgba(70,52,20,0.97)' : 'rgba(38,26,18,0.95)';
      ctx.beginPath(); ctx.arc(man.x, man.y, 22, 0, 6.283); ctx.fill();
      ctx.strokeStyle = '#ffcf6a'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(man.x, man.y, 22, 0, 6.283); ctx.stroke();
      ctx.fillStyle = '#ffe9c4'; ctx.font = 'bold 9px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(isManned ? 'LEAVE' : 'MAN IT', man.x, man.y - 2);
      ctx.fillStyle = '#ffcf6a';
      // '+70%' is the ATTACK machine's fire-rate bonus. On a support it was a
      // flat lie: the number described a code path supports never reach.
      var manLbl = tw.type === 'bellows' ? '+60% AURA'
                 : tw.type === 'press'   ? '+50% GOLD'
                 : '+70%';
      if (isSup) ctx.font = 'bold 7px system-ui, sans-serif';
      ctx.fillText(isManned ? '' : manLbl, man.x, man.y + 10);
      ctx.font = 'bold 9px system-ui, sans-serif';
      ctx.textAlign = 'left';
      if (aim) {
        ctx.fillStyle = 'rgba(38,26,18,0.95)';
        ctx.beginPath(); ctx.arc(aim.x, aim.y, 22, 0, 6.283); ctx.fill();
        ctx.strokeStyle = '#a8e6ff'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(aim.x, aim.y, 22, 0, 6.283); ctx.stroke();
        ctx.fillStyle = '#ffe9c4'; ctx.font = 'bold 9px system-ui, sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('AIM', aim.x, aim.y - 3);
        ctx.fillStyle = '#a8e6ff';
        ctx.fillText(AIM_MODES[tw.targeting | 0], aim.x, aim.y + 9);
        ctx.textAlign = 'left';
      }
      var canUp = tw.level < 2, affordUp = canUp && this.gold >= lvl.upgradeCost;
      ctx.fillStyle = affordUp ? 'rgba(38,26,18,0.95)' : 'rgba(28,20,16,0.7)';
      ctx.beginPath(); ctx.arc(up.x, up.y, 22, 0, 6.283); ctx.fill();
      ctx.strokeStyle = affordUp ? '#9ef58f' : '#5c5147'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(up.x, up.y, 22, 0, 6.283); ctx.stroke();
      ctx.fillStyle = affordUp ? '#ffe9c4' : '#8a7f72';
      ctx.font = 'bold 10px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(!canUp ? 'MAX' : (tw.level === 1 ? 'FORK' : 'UP'), up.x, up.y - 2);
      if (canUp) ctx.fillText(lvl.upgradeCost + 'g', up.x, up.y + 10);
      ctx.fillStyle = 'rgba(38,26,18,0.95)';
      ctx.beginPath(); ctx.arc(sell.x, sell.y, 22, 0, 6.283); ctx.fill();
      ctx.strokeStyle = '#ff7b7b';
      ctx.beginPath(); ctx.arc(sell.x, sell.y, 22, 0, 6.283); ctx.stroke();
      ctx.fillStyle = '#ffe9c4';
      ctx.fillText('SELL', sell.x, sell.y - 2);
      ctx.fillStyle = '#ffd75e';
      ctx.fillText(this._sellValue(tw) + 'g', sell.x, sell.y + 10);
      ctx.textAlign = 'left';
    }
  };

  // ===== TITLE — Wick's workshop, lit ====================================
  // This used to be level 1 rendered in full, buried under a flat 66% black
  // rect, with four single-colour rounded rectangles stacked on it. It read as
  // an unstyled prototype sitting on top of someone else's painting.
  //
  // Now the title composes its OWN room: Wick at proper size on his hoard
  // between two braziers, under a hanging nameplate, with embers rising past
  // the wordmark and dying before they reach the buttons. Motion above, calm
  // below — the separation is most of why it reads premium instead of busy.
  Game.prototype._drawTitle = function (ctx) {
    var v = this.view;
    var t = RM ? 0 : this.worldT;              // reduce-motion PINS the clock
    var X = -v.ox - 60, Y = -v.oy - 60, W = v.w + 120, H = v.h + 120;

    // ---- 1. backdrop -----------------------------------------------------
    ctx.fillStyle = '#0c0705';
    ctx.fillRect(X, Y, W, H);
    if (ART.images.bg) {
      var bi = ART.images.bg;
      var bs = Math.max(v.w / bi.width, v.h / bi.height);
      ctx.drawImage(bi, -v.ox + (v.w - bi.width * bs) / 2, -v.oy + (v.h - bi.height * bs) / 2,
                    bi.width * bs, bi.height * bs);
    }
    // A GRADED scrim, not a flat one: the painting survives at the top where
    // nothing sits on it and is buried under the buttons where legibility is
    // non-negotiable. The old flat 0.66 did neither well. Stops are keyed to
    // world y so they land on the layout, not on the viewport.
    var sg = ctx.createLinearGradient(0, 0, 0, WORLD_H);
    sg.addColorStop(0.00, 'rgba(12,7,5,0.34)');
    sg.addColorStop(0.28, 'rgba(12,7,5,0.52)');
    sg.addColorStop(0.46, 'rgba(11,6,4,0.84)');
    sg.addColorStop(1.00, 'rgba(8,4,3,0.93)');
    ctx.fillStyle = sg; ctx.fillRect(X, Y, W, H);
    // forge glow — two irrational frequencies never repeat on a visible
    // period, so the room breathes instead of strobing
    var heat = 0.13 + 0.035 * Math.sin(t * 1.9) + 0.020 * Math.sin(t * 4.3);
    ctx.globalCompositeOperation = 'lighter';
    var fg = ctx.createRadialGradient(196, 236, 10, 196, 236, 300);
    fg.addColorStop(0.00, 'rgba(255,150,62,' + heat.toFixed(4) + ')');
    fg.addColorStop(0.55, 'rgba(214,69,69,' + (heat * 0.42).toFixed(4) + ')');
    fg.addColorStop(1.00, 'rgba(255,120,40,0)');
    ctx.fillStyle = fg; ctx.fillRect(X, Y, W, H);
    ctx.globalCompositeOperation = 'source-over';
    var vg = ctx.createRadialGradient(210, 360, 150, 210, 360, 470);
    vg.addColorStop(0.00, 'rgba(6,3,2,0)');
    vg.addColorStop(0.62, 'rgba(6,3,2,0.30)');
    vg.addColorStop(1.00, 'rgba(4,2,1,0.86)');
    ctx.fillStyle = vg; ctx.fillRect(X, Y, W, H);

    embers(ctx, t, 0, 18, 1.0, 1.0);           // back layer, behind the sign

    // ---- 2. the hanging nameplate ---------------------------------------
    ctx.textAlign = 'center';
    ctx.font = 'bold 54px Georgia, serif';
    var fs = Math.min(54, 54 * 300 / ctx.measureText('HOARDLING').width);
    ctx.font = 'bold ' + fs.toFixed(1) + 'px Georgia, serif';
    var plateW = Math.max(300, ctx.measureText('HOARDLING').width + 44);
    var px = 210 - plateW / 2, py = 26, ph = 78, ch = 16;
    for (var cxi = 0; cxi < 2; cxi++) {        // two short brass chains
      var chx = cxi ? 285 : 135;
      var cg = ctx.createLinearGradient(0, 0, 0, 30);
      cg.addColorStop(0, '#8f7038'); cg.addColorStop(1, '#d4a840');
      ctx.strokeStyle = cg; ctx.lineWidth = 2;
      for (var lk = 0; lk < 3; lk++) {
        ctx.beginPath(); ctx.ellipse(chx, 2 + lk * 9, 3.5, 4.5, 0, 0, 6.283); ctx.stroke();
      }
    }
    ctx.globalCompositeOperation = 'lighter';
    var pg = ctx.createRadialGradient(210, 64, 0, 210, 64, 190);
    pg.addColorStop(0, 'rgba(255,150,62,0.10)'); pg.addColorStop(1, 'rgba(255,150,62,0)');
    ctx.fillStyle = pg; ctx.fillRect(X, Y, W, H);
    ctx.globalCompositeOperation = 'source-over';
    function platePath(x, y, w, h, c) {        // chamfered lozenge, not a rect
      ctx.beginPath();
      ctx.moveTo(x + c, y); ctx.lineTo(x + w - c, y); ctx.lineTo(x + w, y + h / 2);
      ctx.lineTo(x + w - c, y + h); ctx.lineTo(x + c, y + h); ctx.lineTo(x, y + h / 2);
      ctx.closePath();
    }
    var bg2 = ctx.createLinearGradient(0, py, 0, py + ph);
    bg2.addColorStop(0, 'rgba(46,28,18,0.92)'); bg2.addColorStop(1, 'rgba(18,10,8,0.95)');
    ctx.fillStyle = bg2; platePath(px, py, plateW, ph, ch); ctx.fill();
    ctx.strokeStyle = 'rgba(212,168,64,0.62)'; ctx.lineWidth = 2;
    platePath(px + 1, py + 1, plateW - 2, ph - 2, ch); ctx.stroke();
    for (var rvi = 0; rvi < 4; rvi++) {
      var rvx = px + (rvi % 2 ? plateW - 22 : 22), rvy = py + (rvi < 2 ? 18 : ph - 18);
      ctx.fillStyle = '#d4a840';
      ctx.beginPath(); ctx.arc(rvx, rvy, 2.4, 0, 6.283); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.42)';
      ctx.beginPath(); ctx.arc(rvx, rvy, 2.4, 0.5, 2.6); ctx.fill();
    }

    // ---- 3. the wordmark: six passes over one position -------------------
    var bx = 210, by = 76;
    ctx.fillStyle = 'rgba(8,4,3,0.78)'; ctx.fillText('HOARDLING', bx, by + 3);
    ctx.strokeStyle = '#5b2a10'; ctx.lineWidth = 3.5; ctx.lineJoin = 'round';
    ctx.strokeText('HOARDLING', bx, by);
    var mg = ctx.createLinearGradient(0, by - fs * 0.72, 0, by + fs * 0.10);
    mg.addColorStop(0.00, '#fff3cf'); mg.addColorStop(0.42, '#ffd75e');
    mg.addColorStop(0.78, '#e8a02a'); mg.addColorStop(1.00, '#b96a12');
    ctx.fillStyle = mg; ctx.fillText('HOARDLING', bx, by);
    var hg = ctx.createLinearGradient(0, by - fs * 0.72, 0, by + fs * 0.10);
    hg.addColorStop(0.00, 'rgba(255,255,235,0.55)');
    hg.addColorStop(0.30, 'rgba(255,255,235,0.10)');
    hg.addColorStop(0.46, 'rgba(255,255,235,0)');
    ctx.fillStyle = hg; ctx.fillText('HOARDLING', bx, by);
    ctx.strokeStyle = 'rgba(255,225,160,0.42)'; ctx.lineWidth = 1;
    ctx.strokeText('HOARDLING', bx, by);
    ctx.globalCompositeOperation = 'lighter';   // warms and cools WITH the fire
    ctx.fillStyle = 'rgba(255,190,90,' + (0.10 + 0.06 * Math.sin(t * 1.7)).toFixed(3) + ')';
    ctx.fillText('HOARDLING', bx, by);
    ctx.globalCompositeOperation = 'source-over';
    // eyebrow — manual letterspacing; ctx.letterSpacing is not portable
    ctx.font = 'bold 10px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(201,168,106,0.85)';
    var eb = "WICK'S WORKSHOP", ebw = 0, ebi;
    for (ebi = 0; ebi < eb.length; ebi++) ebw += ctx.measureText(eb[ebi]).width + 2.6;
    var ebx = 210 - ebw / 2;
    for (ebi = 0; ebi < eb.length; ebi++) {
      ctx.textAlign = 'left';
      ctx.fillText(eb[ebi], ebx, 96);
      ebx += ctx.measureText(eb[ebi]).width + 2.6;
    }
    ctx.textAlign = 'center';

    // ---- 4. the room: braziers, hoard, Wick ------------------------------
    var torch = ART.images.torch;
    if (torch) {
      for (var ti = 0; ti < 2; ti++) {
        // deliberately NOT mirrored: the right brazier is smaller, higher and
        // dimmer, and that asymmetry is the whole depth cue
        var tw = ti ? 56 : 72, th = tw * (torch.height / torch.width);
        var tx = ti ? 352 : 2, tbase = ti ? 282 : 300;
        var amp = ti ? 0.5 : 1, phz = ti ? 1.9 : 0;
        ctx.globalCompositeOperation = 'lighter';
        var tg = ctx.createRadialGradient(tx + tw / 2, tbase - th * 0.62, 0,
                                          tx + tw / 2, tbase - th * 0.62, ti ? 76 : 110);
        tg.addColorStop(0, 'rgba(255,150,62,' +
          ((0.30 + 0.10 * Math.sin(t * 3.1 + phz)) * amp).toFixed(3) + ')');
        tg.addColorStop(1, 'rgba(255,150,62,0)');
        ctx.fillStyle = tg; ctx.fillRect(X, Y, W, H);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = ti ? 0.72 : 1;
        ctx.drawImage(torch, tx, tbase - th, tw, th);
        ctx.globalAlpha = 1;
        // ---- ALIVE ------------------------------------------------------
        // The braziers were a static blit under a slow glow: a painted torch,
        // not a burning one. Three cheap additions, all pure functions of the
        // world clock so nothing touches the seeded stream.
        var fx0 = tx + tw / 2, fy0 = tbase - th * 0.80;   // the flame's mouth
        // 1. the fire's own core, breathing on two irrational frequencies so
        //    it never visibly repeats
        var lick = 0.55 + 0.28 * Math.sin(t * 7.3 + phz) + 0.17 * Math.sin(t * 11.9 + phz);
        ctx.globalCompositeOperation = 'lighter';
        var core = ctx.createRadialGradient(fx0, fy0, 0, fx0, fy0, (ti ? 15 : 21) * lick);
        core.addColorStop(0, 'rgba(255,244,206,' + (0.50 * amp).toFixed(3) + ')');
        core.addColorStop(0.45, 'rgba(255,166,60,' + (0.30 * amp).toFixed(3) + ')');
        core.addColorStop(1, 'rgba(255,120,30,0)');
        ctx.fillStyle = core;
        ctx.beginPath(); ctx.arc(fx0, fy0, (ti ? 15 : 21) * lick, 0, 6.283); ctx.fill();
        // 2. sparks climbing out of the bowl and dying — the thing that reads
        //    as "burning" rather than "lit"
        for (var sk = 0; sk < (ti ? 3 : 5); sk++) {
          var sf = (sk * 0.6180339887) % 1;
          var sp4 = (t * (0.30 + 0.22 * sf) + sf) % 1;
          var sa = Math.sin(sp4 * Math.PI); sa *= sa * 0.75 * amp;
          var sx4 = fx0 + Math.sin(t * (1.3 + sf) + sk * 2.1) * (5 + 9 * sf);
          var sy4 = fy0 - sp4 * (ti ? 52 : 74);
          ctx.fillStyle = 'rgba(255,' + (170 + ((60 * sf) | 0)) + ',90,' + sa.toFixed(3) + ')';
          ctx.beginPath(); ctx.arc(sx4, sy4, 1.1 + 1.5 * sf, 0, 6.283); ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
        // 3. the light it throws on its own stone, so the brazier is lit BY
        //    its fire instead of merely standing near a glow
        var pool = ctx.createRadialGradient(fx0, tbase - 4, 2, fx0, tbase - 4, tw * 0.95);
        pool.addColorStop(0, 'rgba(255,150,60,' + (0.20 * amp * lick).toFixed(3) + ')');
        pool.addColorStop(1, 'rgba(255,150,60,0)');
        ctx.fillStyle = pool;
        ctx.save(); ctx.translate(fx0, tbase - 4); ctx.scale(1, 0.30);
        ctx.beginPath(); ctx.arc(0, 0, tw * 0.95, 0, 6.283); ctx.fill(); ctx.restore();
      }
    }
    var mound = ART.images.mound;
    if (mound) {
      // the SAME asset twice, same x / width / baseline, so the two halves can
      // never misregister: back bank behind Wick, front lip in front of him
      //
      // THE BACK BANK USED TO BE A CROP FROM 45% DOWN, and that crop line was a
      // GUILLOTINE: it sliced the pile across its widest point, so the hoard had
      // a razor-straight horizontal top edge running out either side of Wick and
      // read as a flat slab rather than a heap of coins. Drawing the WHOLE pile
      // restores its own domed silhouette — there is no cut to see, because
      // there is no cut. The peak tucks behind Wick's chest, which is what the
      // crop was clumsily trying to achieve in the first place.
      // ASPECT. The whole pile was being squeezed into 330x150 — an aspect of
      // 2.20 against the master's true 1.443 — so everything in it was
      // squashed 34% vertically. VANUS spotted it on the goblet, which is the
      // one object in the art with a silhouette you can check by eye.
      //
      // Fixing it means cropping rather than scaling, because the master is a
      // tall dome and this needs a low wide bank. Cropping alone was tried
      // before and left a razor-straight top edge running out either side of
      // Wick — a "guillotine" through the pile. So: crop at the CORRECT aspect
      // and then feather the cut, which is the half the earlier attempt was
      // missing. No straight edge, no squash.
      // NO CROP AT ALL. Cropping for aspect and feathering the cut was tried
      // and was worse than the squash: the feather read as a black slab laid
      // across the coins and the cut line still showed. The pile is drawn
      // WHOLE, at its true 1.443 aspect, sized so it fits between the hanging
      // sign and the tagline — 190 units of headroom gives 274 wide. Nothing
      // is sliced, so there is no edge to hide, and a 274-wide hoard behind a
      // 150-wide dragon reads as a bank he is sitting in.
      var mBaseY = 300, mH = 190, mW = mH * (mound.width / mound.height);
      var mX = 210 - mW / 2;
      ctx.globalAlpha = 0.94;
      ctx.drawImage(mound, mX, mBaseY - mH, mW, mH);
      ctx.globalAlpha = 1;
    }
    // WICK'S GROUNDING. He read as pasted onto the gold rather than sitting in
    // it: one faint ellipse under a 168-unit character. Three passes now — a
    // tight dark contact patch where he actually meets the coins, a wider soft
    // cast shadow, and a warm bounce of gold light thrown back up onto him.
    ctx.save();
    ctx.translate(210, 262);
    ctx.scale(1, 0.20);
    var cgA = ctx.createRadialGradient(0, 0, 2, 0, 0, 40);
    cgA.addColorStop(0, 'rgba(4,2,1,0.72)'); cgA.addColorStop(1, 'rgba(4,2,1,0)');
    ctx.fillStyle = cgA; ctx.beginPath(); ctx.arc(0, 0, 40, 0, 6.283); ctx.fill();
    var cgB = ctx.createRadialGradient(6, 0, 8, 6, 0, 84);
    cgB.addColorStop(0, 'rgba(6,3,2,0.42)'); cgB.addColorStop(1, 'rgba(6,3,2,0)');
    ctx.fillStyle = cgB; ctx.beginPath(); ctx.arc(6, 0, 84, 0, 6.283); ctx.fill();
    ctx.restore();
    // gold bounce — the hoard is a light source, so it should light him back
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    var bnc = ctx.createRadialGradient(210, 252, 6, 210, 252, 96);
    bnc.addColorStop(0, 'rgba(255,196,86,' + (0.20 + 0.05 * Math.sin(t * 1.6)).toFixed(3) + ')');
    bnc.addColorStop(1, 'rgba(255,170,60,0)');
    ctx.fillStyle = bnc;
    ctx.beginPath(); ctx.arc(210, 252, 96, 0, 6.283); ctx.fill();
    ctx.restore();
    var wick = ART.images.hero_title || ART.images.hero;
    if (wick) {
      // 150 world px, not the 78px corner sticker that used to cover 59% of
      // the sound button. This is the 918 KB hero asset finally used as a hero.
      var ww = 150, wh = ww * (wick.height / wick.width);
      var bob = RM ? 0 : Math.sin(t * 0.9) * 1.5;    // was sin(t*4)*2 — a twitch
      ctx.drawImage(wick, 210 - ww / 2, 264 - wh + bob, ww, wh);
    }
    if (mound) {
      // the front lip is the SAME asset at the SAME x/width/baseline, so the
      // two halves cannot misregister — it must track the sizing above
      var lH = 190, lW = lH * (mound.width / mound.height), lX = 210 - lW / 2;
      ctx.drawImage(mound, 0, mound.height * 0.78, mound.width, mound.height * 0.22,
                    lX, 300 - lH * 0.22, lW, lH * 0.22);
    }
    embers(ctx, t, 18, 22, 1.4, 0.70);         // near-field parallax layer

    ctx.font = 'italic 16px Georgia, serif';
    inkText(ctx, 'Too young for dragonfire. Built his own.', 210, 326, '#ffb469', 5, 2);

    // ---- 5. sections ------------------------------------------------------
    var G = this._titleGeom();
    var self = this;
    function rule(y, label, col, alpha) {
      ctx.font = 'bold 10px system-ui, sans-serif';
      var lw = ctx.measureText(label).width + 18;
      ctx.strokeStyle = 'rgba(' + col + ',' + alpha + ')'; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(40, y); ctx.lineTo(210 - lw / 2, y);
      ctx.moveTo(210 + lw / 2, y); ctx.lineTo(380, y); ctx.stroke();
      ctx.fillStyle = 'rgba(' + col + ',' + (alpha + 0.5) + ')';
      ctx.fillText(label, 210, y + 4);
    }
    rule(356, 'CAMPAIGN', '212,168,64', 0.28);

    // which keep to hold next — the first unlocked level short of 3 stars
    var next = -1;
    for (var ri = 0; ri < MAPS.length; ri++) {
      if (Save.unlocked(ri) && (Save.data.stars[ri] | 0) < 3) { next = ri; break; }
    }
    // bounded by rows, not maps — same landmine as the tap side (see there)
    for (var li = 0; li < Math.min(MAPS.length, G.rows.length); li++) {
      var r = G.rows[li], open = Save.unlocked(li);
      if (open && li === next) {
        // the recommended row breathes; nothing else on the screen moves
        var pulse = 0.35 + 0.28 * (RM ? 0.5 : (0.5 + 0.5 * Math.sin(t * 2.2)));
        ctx.strokeStyle = 'rgba(255,215,94,' + pulse.toFixed(3) + ')';
        ctx.lineWidth = 2.5;
        rr(ctx, r.x - 3, r.y - 3, r.w + 6, r.h + 6, 15); ctx.stroke();
      }
      forgePlate(ctx, r, open ? 'ember' : 'lock');
      numeralSeal(ctx, r.x + 2, r.y + r.h / 2, li + 1, open);
      ctx.textAlign = 'left';
      ctx.font = 'bold 17px system-ui, sans-serif';
      if (open) {
        inkText(ctx, MAPS[li].name, r.x + 30, r.y + 32, '#fff6e6', 4, 1.5);
        for (var si = 0; si < 3; si++) {
          starCoin(ctx, r.x + r.w - 62 + si * 22, r.y + r.h / 2, 9,
                   si < (Save.data.stars[li] | 0));
        }
      } else {
        ctx.fillStyle = '#7a6a5c';
        ctx.fillText(MAPS[li].name, r.x + 30, r.y + 27);
        ctx.font = '11px system-ui, sans-serif';
        ctx.fillStyle = 'rgba(180,150,120,0.65)';
        // say WHAT unlocks it — a bare padlock is a dead end
        ctx.fillText('hold keep ' + li + ' to open', r.x + 30, r.y + 42);
        lockGlyph(ctx, r.x + r.w - 26, r.y + r.h / 2, 1.25, '#6b5b4c');
      }
      ctx.textAlign = 'center';
    }

    rule(566, 'TONIGHT', '157,138,214', 0.30);
    var D = G.daily, DU = G.duel;
    var dcx = D.x + D.w / 2, ducx = DU.x + DU.w / 2;
    forgePlate(ctx, D, 'cold');
    ctx.font = 'bold 16px system-ui, sans-serif';
    inkText(ctx, 'DAILY SIEGE', dcx, D.y + 33, '#f0eaff', 5, 2);
    if (Lb.on() && (!this._lbTopT || Date.now() - this._lbTopT > 300000)) {
      this._lbTopT = Date.now();
      Lb.top(1, function (rows) { self._lbTop = (rows && rows[0]) || null; });
    }
    ctx.font = '11px system-ui, sans-serif';
    var todayBest = (Save.data.daily.day === dayNumber()) ? Save.data.daily.best : 0;
    inkText(ctx, MAPS[dailySeed() % MAPS.length].name, dcx, 648, '#c9b8ff', 4, 1);
    var dl2 = todayBest ? 'your best wave ' + todayBest
      : (Save.data.dailyBestWave > 0 ? 'all-time wave ' + Save.data.dailyBestWave : 'endless — no finish line');
    inkText(ctx, dl2, dcx, 662, 'rgba(201,184,255,0.75)', 4, 1);

    // ---- the DUEL plate ---------------------------------------------------
    forgePlate(ctx, DU, 'cold');
    ctx.font = 'bold 16px system-ui, sans-serif';
    inkText(ctx, 'DUEL', ducx, DU.y + 33, '#ffd9c4', 5, 2);
    // crossed-wrench mark: this is the one mode with somebody on the other side
    ctx.strokeStyle = 'rgba(255,190,150,0.85)'; ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(ducx - 30, DU.y + 20); ctx.lineTo(ducx - 20, DU.y + 30);
    ctx.moveTo(ducx - 20, DU.y + 20); ctx.lineTo(ducx - 30, DU.y + 30);
    ctx.stroke();
    var beaten = 0;
    for (var rvi = 0; rvi < RIVAL_ORDER.length; rvi++) {
      var rvr = Save.data.duels[RIVAL_ORDER[rvi]];
      if (rvr && rvr.w) beaten++;
    }
    ctx.font = '11px system-ui, sans-serif';
    inkText(ctx, 'same waves, two caves', ducx, 648, '#ffc9a8', 4, 1);
    inkText(ctx, beaten ? 'beaten ' + beaten + '/' + RIVAL_ORDER.length : 'four rivals waiting',
            ducx, 662, 'rgba(255,201,168,0.75)', 4, 1);

    // ---- 6. utility row ---------------------------------------------------
    var fAvail = Save.starsTotal() - Save.forgeSpent();
    var anyWon = Save.starsTotal() > 0;
    var tDone = 0;
    for (var tb = 0; tb < 3; tb++) { var tRow = Save.data.trials[tb] || {}; for (var tk in tRow) tDone++; }
    for (var pi = 0; pi < 3; pi++) {
      var pl = G.pills[pi];
      var live = pi === 0 ? true : pi === 1 ? anyWon : true;
      forgePlate(ctx, pl, 'util');
      var pcx = pl.x + pl.w / 2, pcy = pl.y + pl.h / 2;
      ctx.font = 'bold 12px system-ui, sans-serif';
      if (pi === 0) {
        starCoin(ctx, pcx, pcy - 9, 8, fAvail > 0);
        inkText(ctx, fAvail > 0 ? 'FORGE  ' + fAvail : 'FORGE', pcx, pcy + 17,
                fAvail > 0 ? '#ffe9c4' : 'rgba(255,233,196,0.55)', 3, 1);
      } else if (pi === 1) {
        ctx.strokeStyle = live ? 'rgba(217,242,255,0.9)' : 'rgba(138,127,114,0.7)';
        ctx.lineWidth = 2;
        rr(ctx, pcx - 8, pcy - 17, 16, 14, 3); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(pcx - 4, pcy - 13); ctx.lineTo(pcx + 4, pcy - 13);
        ctx.moveTo(pcx - 4, pcy - 8); ctx.lineTo(pcx + 4, pcy - 8); ctx.stroke();
        // 6 trials x 3 levels = 18 badges. '/9' dated from when there were
        // three trials and quietly told the player they were twice as done
        // as they were — and it can never be reached, so it reads as broken.
        inkText(ctx, live ? 'TRIALS ' + tDone + '/' + (TRIAL_ORDER.length * MAPS.length) : 'TRIALS', pcx, pcy + 17,
                live ? '#d9f2ff' : '#8a7f72', 3, 1);
      } else {
        drawSpeaker(ctx, pcx - 4, pcy - 9, Sfx.isMuted());
        inkText(ctx, Sfx.isMuted() ? 'SOUND OFF' : 'SOUND ON', pcx, pcy + 17, '#ffe9c4', 3, 1);
      }
    }
    ctx.textAlign = 'left';
  };


  Game.prototype._drawForge = function (ctx) {
    var v = this.view;
    ctx.fillStyle = 'rgba(12,7,5,0.85)';
    ctx.fillRect(-v.ox - 60, -v.oy - 60, v.w + 120, v.h + 120);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffd75e'; ctx.font = 'bold 34px Georgia, serif';
    ctx.fillText('THE FORGE', WORLD_W / 2, 150);
    ctx.fillStyle = '#c9b8ff'; ctx.font = '13px system-ui, sans-serif';
    ctx.fillText('Campaign stars buy lasting craft. Campaign only —', WORLD_W / 2, 182);
    ctx.fillText('the Daily Siege is the same fair fight for everyone.', WORLD_W / 2, 198);
    var avail = Save.starsTotal() - Save.forgeSpent();
    ctx.font = 'bold 17px Georgia, serif';
    var spendTxt = avail + ' to spend';
    var spendW = ctx.measureText(spendTxt).width;
    starCoin(ctx, WORLD_W / 2 - spendW / 2 - 13, 222, 11, avail > 0);
    ctx.textAlign = 'left';
    inkText(ctx, spendTxt, WORLD_W / 2 - spendW / 2 + 4, 228, '#fff2d8', 4, 1);
    ctx.textAlign = 'center';
    for (var i = 0; i < FORGE_NODES.length; i++) {
      var node = FORGE_NODES[i], ry = 250 + i * 74;
      var cur = Save.data.forge[node.id] | 0;
      uiPanel(ctx, 26, ry, WORLD_W - 52, 62, 11);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#fff2d8'; ctx.font = 'bold 15px system-ui, sans-serif';
      ctx.fillText(node.name, 42, ry + 24);
      ctx.fillStyle = '#b9a27f'; ctx.font = '12px system-ui, sans-serif';
      ctx.fillText(node.desc, 42, ry + 43);
      for (var rp2 = 0; rp2 < node.ranks; rp2++) {
        ctx.fillStyle = rp2 < cur ? '#ffd75e' : 'rgba(255,215,94,0.2)';
        ctx.beginPath(); ctx.arc(42 + rp2 * 16, ry + 54, 4, 0, 6.283); ctx.fill();
      }
      var can = cur < node.ranks && avail > 0;
      ctx.fillStyle = can ? 'rgba(214,69,69,0.9)' : 'rgba(70,52,44,0.7)';
      rr(ctx, WORLD_W - 118, ry + 12, 88, 38, 10); ctx.fill();
      ctx.fillStyle = can ? '#fff' : '#8a7f72';
      ctx.font = 'bold 14px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(cur >= node.ranks ? 'MAX' : 'FORGE ★', WORLD_W - 74, ry + 36);
      ctx.textAlign = 'left';
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(80,60,140,0.9)';
    rr(ctx, WORLD_W / 2 - 150, 640, 140, 40, 10); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 14px system-ui, sans-serif';
    ctx.fillText('RESPEC (free)', WORLD_W / 2 - 80, 665);
    ctx.fillStyle = 'rgba(214,69,69,0.9)';
    rr(ctx, WORLD_W / 2 + 10, 640, 140, 40, 10); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText('BACK', WORLD_W / 2 + 80, 665);
    ctx.textAlign = 'left';
  };

  Game.prototype._drawDuelSelect = function (ctx) {
    var v = this.view, DG = duelGeom();
    ctx.fillStyle = 'rgba(12,7,5,0.85)';
    ctx.fillRect(-v.ox - 60, -v.oy - 60, v.w + 120, v.h + 120);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffc9a8'; ctx.font = 'bold 34px Georgia, serif';
    ctx.fillText('DUEL', WORLD_W / 2, 142);
    ctx.fillStyle = '#e8cbb4'; ctx.font = '13px system-ui, sans-serif';
    ctx.fillText('The Guild posted two caves tonight. The same raiders', WORLD_W / 2, 172);
    ctx.fillText('hit both. Keep more gold than they do.', WORLD_W / 2, 188);
    ctx.fillStyle = 'rgba(232,203,180,0.6)'; ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(DUEL_WAVES + ' waves · no forge craft · all seven machines', WORLD_W / 2, 208);

    for (var i = 0; i < RIVAL_ORDER.length; i++) {
      var rv = RIVALS[i], ry = DG.top + i * DG.pitch;
      var rec = Save.data.duels[rv.id];
      var ready = rivalHoardAt(i, duelSeedIdx(i), 0) !== null;
      uiPanel(ctx, DG.x, ry, DG.w, DG.h, 11);
      ctx.textAlign = 'left';
      // name + rank
      ctx.fillStyle = ready ? '#ffe4cf' : '#7a6a5c';
      ctx.font = 'bold 17px system-ui, sans-serif';
      ctx.fillText(rv.name, DG.x + 14, ry + 24);
      ctx.fillStyle = ready ? 'rgba(255,190,150,0.75)' : 'rgba(140,124,110,0.7)';
      ctx.font = 'bold 9px system-ui, sans-serif';
      ctx.fillText(rv.rank, DG.x + 14 + ctx.measureText(rv.name).width + 46, ry + 23);
      ctx.fillStyle = ready ? 'rgba(232,203,180,0.8)' : 'rgba(122,106,92,0.8)';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(rv.blurb, DG.x + 14, ry + 42);
      // tonight's ground — the arena rotates daily, so name it
      ctx.fillStyle = 'rgba(201,184,255,0.7)'; ctx.font = '10px system-ui, sans-serif';
      ctx.fillText(ready ? 'tonight: ' + MAPS[duelMapFor(i)].name : 'no recording yet',
                   DG.x + 14, ry + DG.h - 8);
      // the badge: beaten, and by how much
      ctx.textAlign = 'right';
      if (rec && rec.w) {
        ctx.fillStyle = '#9ef58f'; ctx.font = 'bold 12px system-ui, sans-serif';
        ctx.fillText('BEATEN', DG.x + DG.w - 14, ry + 24);
        ctx.fillStyle = 'rgba(158,245,143,0.7)'; ctx.font = '10px system-ui, sans-serif';
        ctx.fillText('best margin +' + (rec.m | 0), DG.x + DG.w - 14, ry + 40);
      } else if (ready) {
        ctx.fillStyle = 'rgba(255,201,168,0.85)'; ctx.font = 'bold 12px system-ui, sans-serif';
        ctx.fillText('FIGHT', DG.x + DG.w - 14, ry + 30);
      }
      ctx.textAlign = 'center';
    }
    ctx.fillStyle = '#e8cbb4'; ctx.font = 'bold 15px system-ui, sans-serif';
    ctx.fillText('BACK', WORLD_W / 2, DG.backY + 26);
    ctx.textAlign = 'left';
  };

  Game.prototype._drawTrials = function (ctx) {
    var v = this.view;
    ctx.fillStyle = 'rgba(12,7,5,0.85)';
    ctx.fillRect(-v.ox - 60, -v.oy - 60, v.w + 120, v.h + 120);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#a8e6ff'; ctx.font = 'bold 34px Georgia, serif';
    ctx.fillText('TRIALS', WORLD_W / 2, 150);
    ctx.fillStyle = '#c9b8ff'; ctx.font = '13px system-ui, sans-serif';
    ctx.fillText('Wick sets himself a challenge on a keep he has held.', WORLD_W / 2, 182);
    ctx.fillText('Win the level first; forge craft still counts.', WORLD_W / 2, 198);
    for (var i = 0; i < TRIAL_ORDER.length; i++) {
      var TG = trialGeom();
      var key = TRIAL_ORDER[i], tr = TRIALS[key], ry = TG.top + i * TG.pitch;
      uiPanel(ctx, 26, ry, WORLD_W - 52, TG.h, 11);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#d9f2ff'; ctx.font = 'bold 15px system-ui, sans-serif';
      var textW = (WORLD_W - 168) - 42 - 10;   // stop before the L1 chip
      ctx.fillText(fitText(ctx, tr.name, textW), 42, ry + 24);
      ctx.fillStyle = '#b9a27f'; ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(fitText(ctx, tr.pitch, textW), 42, ry + 42);
      for (var lv2 = 0; lv2 < MAPS.length; lv2++) {
        var chx = WORLD_W - 168 + lv2 * 46;
        var wonLv = Save.data.stars[lv2] > 0;
        var badge = wonLv && Save.data.trials[lv2] && Save.data.trials[lv2][key];
        ctx.fillStyle = badge ? 'rgba(255,215,94,0.9)' : wonLv ? 'rgba(214,69,69,0.85)' : 'rgba(70,52,44,0.6)';
        rr(ctx, chx, ry + TG.chipY, 40, TG.chipH, 8); ctx.fill();
        ctx.fillStyle = badge ? '#3a2c14' : wonLv ? '#fff' : '#8a7f72';
        ctx.font = 'bold 12px system-ui, sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(badge ? '\u2605' : 'L' + (lv2 + 1), chx + 20, ry + TG.chipY + TG.chipH * 0.66);
        ctx.textAlign = 'left';
      }
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(214,69,69,0.9)';
    rr(ctx, WORLD_W / 2 - 70, 640, 140, 40, 10); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 14px system-ui, sans-serif';
    ctx.fillText('BACK', WORLD_W / 2, 665);
    ctx.textAlign = 'left';
  };

  Game.prototype._drawResult = function (ctx) {
    var r = this.result || {};
    ctx.fillStyle = 'rgba(12,7,5,0.75)';
    ctx.fillRect(-40, -40, WORLD_W + 80, WORLD_H + 80);
    ctx.textAlign = 'center';
    ctx.fillStyle = r.won ? '#9ef58f' : '#ff7b7b';
    ctx.font = 'bold 42px Georgia, serif';
    // A duel is won on the MARGIN, so it gets its own headline: "HOARD HELD"
    // on a run you finished 3 coins behind would be a lie about the only
    // number the mode is about.
    if (r.rival) {
      ctx.font = 'bold 38px Georgia, serif';
      ctx.fillText(r.won ? (r.knockout && (r.rivalHoard | 0) <= 0 ? 'SACKED THEM!' : 'DUEL WON!')
                         : 'DUEL LOST', WORLD_W / 2, 314);
      ctx.font = 'bold 15px system-ui, sans-serif';
      ctx.fillStyle = r.won ? 'rgba(158,245,143,0.9)' : 'rgba(255,154,106,0.9)';
      var mg2 = r.margin | 0;
      ctx.fillText('you ' + (r.hoard | 0) + '   ·   ' + r.rival + ' ' + Math.max(0, r.rivalHoard | 0) +
                   '   ·   ' + (mg2 >= 0 ? '+' + mg2 : String(mg2)), WORLD_W / 2, 340);
    } else {
      ctx.fillText(r.won ? 'HOARD HELD!' : 'HOARD LOST', WORLD_W / 2, 320);
    }
    if (r.trial) {
      ctx.font = 'bold 15px system-ui, sans-serif';
      ctx.fillStyle = '#a8e6ff';
      ctx.fillText(r.won ? 'TRIAL COMPLETE — ' + r.trial + ' ★' : 'TRIAL: ' + r.trial, WORLD_W / 2, 345);
    }
    // Stars grade coins lost forever, which is not what a duel is scored on —
    // and the medallion row would land on top of the margin line. A duel is
    // won or lost, full stop.
    if (r.won && !r.rival) {
      // The payoff moment gets the same struck-coin medallions the title
      // screen uses, not a row of '★' characters in whatever face the platform
      // picks. Earned stars land one at a time so the third reads as a result
      // rather than as decoration that was always there.
      for (var s = 0; s < 3; s++) {
        var earned = s < r.stars;
        var pop = 1;
        if (earned && !RM) {
          var since = (this._resultT || 0) - (0.22 + s * 0.26);
          if (since <= 0) continue;                       // not landed yet
          pop = 1 + 0.55 * Math.exp(-since * 9) * Math.cos(since * 22);
        }
        starCoin(ctx, WORLD_W / 2 - 46 + s * 46, 360, 19 * pop, earned);
      }
    }
    ctx.fillStyle = '#ffe9c4'; ctx.font = '17px system-ui, sans-serif';
    ctx.fillText('treasure kept: ' + (r.hoard | 0) + ' / ' + CFG.startHoard, WORLD_W / 2, 420);
    ctx.fillText('coins carried off: ' + (r.lost | 0), WORLD_W / 2, 446);
    ctx.fillText('raiders slain: ' + (r.kills | 0), WORLD_W / 2, 472);
    if (r.toll > 0) {
      ctx.fillStyle = '#9ef58f';
      ctx.fillText('Wick shook loose: ' + (r.toll | 0), WORLD_W / 2, 472 + 26);
      ctx.fillStyle = '#ffe9c4';
    }
    // WHO TOOK IT. "coins carried off: 25" told the player they had failed and
    // nothing about why. The top three thieves, with the wave they first got
    // through, turn a loss into a next attempt: the answer to a Gloomwing is a
    // different machine from the answer to a Bulwark, and the player could not
    // previously tell which one had beaten them.
    // The block is only drawn when something LEAKED, so a clean run keeps the
    // old tight layout and the story beat stays where it was.
    var leakTop = (this.mode === 'daily' ? 522 : 496) + (r.toll > 0 ? 26 : 0);
    var storyY = 528;
    if (r.leaks && r.leaks.length) {
      storyY = leakTop + 18 + Math.min(3, r.leaks.length) * 19 + 14;
      ctx.font = 'bold 11px system-ui, sans-serif';
      ctx.fillStyle = '#c9b8a8';
      ctx.fillText('WHO GOT THROUGH', WORLD_W / 2, 496);
      for (var lz = 0; lz < Math.min(3, r.leaks.length); lz++) {
        var lr = r.leaks[lz], ly = leakTop + 18 + lz * 19;
        var card = ENEMY_CARDS[lr.type];
        var lname = card ? card[0] : lr.type.toUpperCase();
        var li2 = ART.images['e_' + lr.type];
        if (li2) {
          var lih = 17, liw = lih * (li2.width / li2.height);
          ctx.drawImage(li2, WORLD_W / 2 - 104 - liw, ly - 13, liw, lih);
        }
        ctx.textAlign = 'left';
        ctx.fillStyle = ENEMY_COLORS[lr.type] || '#ffe9c4';
        ctx.font = 'bold 13px system-ui, sans-serif';
        ctx.fillText(lname, WORLD_W / 2 - 98, ly);
        ctx.textAlign = 'right';
        ctx.fillStyle = '#ff7b7b';
        ctx.fillText('-' + lr.coins, WORLD_W / 2 + 28, ly);
        ctx.fillStyle = 'rgba(201,184,168,0.85)';
        ctx.font = '11px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('from wave ' + lr.wave, WORLD_W / 2 + 40, ly);
        ctx.textAlign = 'center';
      }
    }
    if (this.mode === 'daily') ctx.fillText('waves survived: ' + (r.wave | 0), WORLD_W / 2, 498);
    // the story beat this whole game is for
    ctx.font = 'italic 15px Georgia, serif'; ctx.fillStyle = '#ff9a3c';
    if (r.won) {
      ctx.fillText('Auremma stirs, half-dreaming:', WORLD_W / 2, storyY);
      ctx.fillText('“You kept the warm in, little one.”', WORLD_W / 2, storyY + 21);
    } else {
      ctx.fillText('The cavern grows colder.', WORLD_W / 2, storyY);
      ctx.fillText('Wick will not let it happen twice.', WORLD_W / 2, storyY + 21);
    }
    // daily: the global best-runs ladder (names render through safeName ONLY)
    if (this.mode === 'daily' && Lb.on()) {
      ctx.fillStyle = '#ffd75e'; ctx.font = 'bold 14px system-ui, sans-serif';
      ctx.fillText('— ALL-TIME BEST SIEGES —', WORLD_W / 2, 584);
      if (this.lbRows === 'loading') {
        ctx.fillStyle = '#c9b8ff'; ctx.font = '13px system-ui, sans-serif';
        ctx.fillText('fetching the ladder…', WORLD_W / 2, 610);
      } else if (this.lbRows === 'error' || !this.lbRows) {
        ctx.fillStyle = '#8a7f72'; ctx.font = '13px system-ui, sans-serif';
        ctx.fillText('ladder unreachable — your run is queued', WORLD_W / 2, 610);
      } else if (!this.lbRows.length) {
        ctx.fillStyle = '#c9b8ff'; ctx.font = '13px system-ui, sans-serif';
        ctx.fillText('no siegers yet — yours could be first', WORLD_W / 2, 610);
      } else {
        ctx.font = '13px ui-monospace, Menlo, monospace';
        var mine = Lb.tag();
        for (var bi = 0; bi < Math.min(8, this.lbRows.length); bi++) {
          var row = this.lbRows[bi];
          var nm = Lb.safeName(String(row.display_name || ''));
          ctx.fillStyle = nm === mine ? '#9ef58f' : '#ffe9c4';
          ctx.textAlign = 'left';
          ctx.fillText((bi + 1) + '.  ' + nm, WORLD_W / 2 - 105, 606 + bi * 17);
          ctx.textAlign = 'right';
          ctx.fillText('wave ' + (row.value | 0), WORLD_W / 2 + 105, 606 + bi * 17);
        }
        ctx.textAlign = 'center';
      }
    } else {
      var rimg = ART.images.hero;
      if (rimg) {
        // HEIGHT-first, like _drawHero: the plate's aspect is not a constant of
        // the universe (it changed the day the clipped tail was restored), so
        // sizing off WIDTH silently rescaled him on this screen.
        var rh = 109.3, rw = rh * (rimg.width / rimg.height);
        var rb = Math.sin(this.worldT * 4) * 2;
        ctx.drawImage(rimg, WORLD_W / 2 - rw / 2, 668 - rh + rb, rw, rh);
      }
    }
    ctx.font = 'bold 15px system-ui, sans-serif'; ctx.fillStyle = '#c9b8ff';
    ctx.fillText('tap for menu', WORLD_W / 2, 748);
    ctx.textAlign = 'left';
  };

  // ---- MainLoop pattern: accumulate real time, step the sim at a FIXED rate,
  // ---- render once. 60 Hz phone and 120 Hz tablet run the IDENTICAL sim.
  // ---- this.speed multiplies the ACCUMULATOR (2x = 2x fixed steps), so fast-
  // ---- forward is deterministically the same sim, just denser in wall time.
  Game.prototype._frame = function (ts) {
    requestAnimationFrame(this._frame);
    if (!this._last) this._last = ts;
    var dtRaw = Math.min(0.1, (ts - this._last) / 1000);
    this._last = ts;
    // frozen: the harness owns the sim via __game.step(); rAF renders only,
    // so headless pumping and the compositor can never double-step one sim
    if (this._freeze) { this._acc = 0; this._cosmetic(dtRaw); this.draw(0); return; }
    var STEP = 1 / CFG.stepHz;
    this._acc += dtRaw * (this.state === 'playing' ? this.speed : 1);
    var n = 0, cap = 8 * this.speed;
    while (this._acc >= STEP && n < cap) { this.update(STEP); this._acc -= STEP; n++; }
    if (this._acc >= STEP) this._acc = 0;   // hard drop after a stall; never spiral
    this._cosmetic(dtRaw);
    this.draw(this._acc / STEP);
  };

  // ---- tiny draw helpers ----
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  // Bottom-anchored aspect-correct sprite blit: sprites stand ON baseY.
  // Returns false when the image is missing so callers fall back LOUDLY.
  function drawSpriteBottom(ctx, id, cx, baseY, drawW) {
    var img = ART.images[id];
    if (!img) return false;
    var h = drawW * (img.height / img.width);
    ctx.drawImage(img, cx - drawW / 2, baseY - h, drawW, h);
    return true;
  }
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
  // ===== UI material kit ==================================================
  // Wick's interface is meant to look like something he BUILT: cast plates
  // bolted to the cave wall, engraved labels, struck-coin stars. The title
  // screen used flat single-colour rounded rects, which read as an unstyled
  // prototype sitting on top of the painted art. Everything below is vector —
  // no new assets, and nothing that can fail to load.

  /// Text with a real drop shadow. Nothing in this file had one before, so
  /// every label was a flat fill fighting a busy painted background.
  function inkText(ctx, txt, x, y, fill, blur, oy, shadow) {
    ctx.save();
    ctx.shadowColor = shadow || 'rgba(0,0,0,0.85)';
    ctx.shadowBlur = blur === undefined ? 6 : blur;
    ctx.shadowOffsetY = oy === undefined ? 2 : oy;
    ctx.fillStyle = fill;
    ctx.fillText(txt, x, y);
    ctx.restore();
  }

  /// Engraved label: a light bottom edge under a dark top edge reads as a
  /// letter cut INTO metal rather than painted on it.
  function engrave(ctx, txt, x, y, fill) {
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillText(txt, x, y - 1);
    ctx.fillStyle = 'rgba(255,226,170,0.16)';
    ctx.fillText(txt, x, y + 1.5);
    ctx.fillStyle = fill;
    ctx.fillText(txt, x, y);
  }

  /// THE PLATE LANGUAGE. Every button on the title is one of four tones of the
  /// same cast object — that consistency is most of what separates a shipped
  /// game from a set of coloured rectangles.
  function forgePlate(ctx, r, tone) {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)'; ctx.shadowBlur = 8; ctx.shadowOffsetY = 3;
    var g = ctx.createLinearGradient(0, r.y, 0, r.y + r.h);
    if (tone === 'ember') { g.addColorStop(0, '#e05a4a'); g.addColorStop(0.52, '#b93636'); g.addColorStop(1, '#8e2626'); }
    else if (tone === 'cold') { g.addColorStop(0, '#6a4fb0'); g.addColorStop(0.55, '#4c357f'); g.addColorStop(1, '#3b2a6e'); }
    else if (tone === 'lock') { g.addColorStop(0, '#3b2c25'); g.addColorStop(1, '#241a16'); }
    else if (tone === 'brasslit') { g.addColorStop(0, '#8a5f22'); g.addColorStop(0.55, '#634214'); g.addColorStop(1, '#4a3110'); }
    else { g.addColorStop(0, 'rgba(46,28,18,0.88)'); g.addColorStop(1, 'rgba(18,10,8,0.92)'); }
    ctx.fillStyle = g; rr(ctx, r.x, r.y, r.w, r.h, 12); ctx.fill();
    ctx.restore();
    // a 1px lit lip along the top — the entire "this is metal" cue
    ctx.strokeStyle = tone === 'cold' ? 'rgba(190,175,255,0.42)' : 'rgba(255,220,170,0.34)';
    ctx.lineWidth = 1; ctx.beginPath();
    ctx.moveTo(r.x + 13, r.y + 1.5); ctx.lineTo(r.x + r.w - 13, r.y + 1.5); ctx.stroke();
    ctx.strokeStyle = tone === 'cold' ? 'rgba(160,138,223,0.72)'
                    : tone === 'lock' ? 'rgba(212,168,64,0.20)' : 'rgba(255,215,94,0.55)';
    ctx.lineWidth = 1.5; rr(ctx, r.x + 0.75, r.y + 0.75, r.w - 1.5, r.h - 1.5, 11); ctx.stroke();
    // four struck rivets: the contraption cue, and what stops it reading as a sticker
    var rv = [[r.x + 11, r.y + 11], [r.x + r.w - 11, r.y + 11],
              [r.x + 11, r.y + r.h - 11], [r.x + r.w - 11, r.y + r.h - 11]];
    for (var i = 0; i < 4; i++) {
      ctx.fillStyle = tone === 'cold' ? '#8f7cc4' : '#d4a840';
      ctx.beginPath(); ctx.arc(rv[i][0], rv[i][1], 2.4, 0, 6.283); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.42)';
      ctx.beginPath(); ctx.arc(rv[i][0], rv[i][1], 2.4, 0.5, 2.6); ctx.fill();
    }
    // The Daily Siege is the one COLD object in a hot room, so it gets an edge
    // the forge cannot reach. Inverting the light source is what makes it read
    // as a different mode rather than a differently-coloured button.
    if (tone === 'cold') {
      var cl = ctx.createLinearGradient(r.x, 0, r.x + 9, 0);
      cl.addColorStop(0, 'rgba(160,140,255,0.50)'); cl.addColorStop(1, 'rgba(160,140,255,0)');
      ctx.fillStyle = cl; rr(ctx, r.x + 1, r.y + 1, 9, r.h - 2, 10); ctx.fill();
    }
  }

  /// A star struck into a coin. The screen used the '★' / '☆' / '🔒' CHARACTERS
  /// before; those fall through to the platform's colour-emoji font, so on iOS
  /// the padlock rendered as a full-colour Apple glyph from a different game
  /// and the stars changed typeface between devices. Paths render identically
  /// everywhere.
  function starCoin(ctx, cx, cy, rad, earned) {
    ctx.save();
    ctx.translate(cx, cy);
    var g = ctx.createRadialGradient(-rad * 0.3, -rad * 0.4, rad * 0.15, 0, 0, rad);
    if (earned) { g.addColorStop(0, '#fff3c4'); g.addColorStop(0.55, '#ffd24a'); g.addColorStop(1, '#a86c14'); }
    else { g.addColorStop(0, 'rgba(120,102,86,0.45)'); g.addColorStop(1, 'rgba(50,40,33,0.45)'); }
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, rad, 0, 6.283); ctx.fill();
    ctx.strokeStyle = earned ? 'rgba(120,74,12,0.9)' : 'rgba(90,76,62,0.45)';
    ctx.lineWidth = 1.2; ctx.stroke();
    ctx.beginPath();
    for (var i = 0; i < 10; i++) {
      var a = -Math.PI / 2 + i * Math.PI / 5;
      var rr2 = (i % 2 ? rad * 0.36 : rad * 0.78);
      ctx[i ? 'lineTo' : 'moveTo'](Math.cos(a) * rr2, Math.sin(a) * rr2);
    }
    ctx.closePath();
    ctx.fillStyle = earned ? '#fffbe8' : 'rgba(28,22,18,0.55)';
    ctx.fill();
    ctx.restore();
  }

  /// A brass medallion carrying the level numeral, hung half off the plate's
  /// left edge so the row reads as an anchored object, not text in a box.
  function numeralSeal(ctx, cx, cy, n, live) {
    var g = ctx.createRadialGradient(cx - 4, cy - 5, 2, cx, cy, 17);
    if (live) { g.addColorStop(0, '#f4d98c'); g.addColorStop(1, '#8f6a20'); }
    else { g.addColorStop(0, '#6a5a4a'); g.addColorStop(1, '#332721'); }
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 5; ctx.shadowOffsetY = 2;
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, 17, 0, 6.283); ctx.fill();
    ctx.restore();
    ctx.strokeStyle = live ? '#5b3d12' : '#241c17'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, 17, 0, 6.283); ctx.stroke();
    ctx.textAlign = 'center';
    ctx.font = 'bold 17px Georgia, serif';
    ctx.fillStyle = live ? '#2a1a08' : '#0f0b09';
    ctx.fillText(String(n), cx, cy + 6);
  }

  /// Ember field. A PURE function of t — no RNG at all, so it cannot touch the
  /// seeded stream, and two players on the same frame see the same room.
  /// alpha = sin(p*PI)^2 means every ember is born at 0 and dies at 0, so none
  /// ever pops into or out of existence.
  function embers(ctx, t, from, to, sz, aMul) {
    ctx.globalCompositeOperation = 'lighter';
    for (var i = from; i < to; i++) {
      var f = i * 0.6180339887; f -= (f | 0);      // golden ratio: even spread
      var g = i * 0.7548776662; g -= (g | 0);      // a second irrational: no moiré
      var p = t * (0.055 + 0.045 * g) + f; p -= Math.floor(p);
      var y = 300 - p * 240;                       // the hoard line up to y=60
      var x = 26 + g * 368 + Math.sin(t * (0.7 + 0.5 * f) + i) * (7 + 9 * f);
      var a = Math.sin(p * Math.PI); a = a * a * 0.62 * aMul;
      var r = (0.8 + 1.5 * f) * sz;
      ctx.fillStyle = 'rgba(255,183,87,' + a.toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill();
      if ((i & 3) === 0) {
        ctx.fillStyle = 'rgba(255,215,94,' + (a * 0.30).toFixed(3) + ')';
        ctx.beginPath(); ctx.arc(x, y, r * 2.6, 0, 6.283); ctx.fill();
      }
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  /// Truncate to fit a width, with an ellipsis. ctx.fillText's own maxWidth
  /// SQUEEZES the glyphs instead of cutting them, which looks broken; the
  /// trials list needs the pitch line to stop before the level chips rather
  /// than run underneath them.
  function fitText(ctx, txt, maxW) {
    if (ctx.measureText(txt).width <= maxW) return txt;
    var lo = 0, hi = txt.length;
    while (lo < hi) {
      var mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(txt.slice(0, mid) + '\u2026').width <= maxW) lo = mid; else hi = mid - 1;
    }
    return txt.slice(0, lo).replace(/[ ,.;:]+$/, '') + '\u2026';
  }

  /// Wick's flame, drawn. The breath button used to render the '🔥' CHARACTER,
  /// so the one ability the game is named after was represented by whatever
  /// colour-emoji the platform happened to ship — a different artwork on iOS,
  /// Android and desktop, in a typeface that belongs to no part of this game.
  /// Three nested teardrops (outer/mid/core) read as flame at 20px and hold up
  /// at 60. `t` drives a flicker that is a pure function of the world clock.
  function flameGlyph(ctx, cx, cy, s, t, alive) {
    var f = alive ? 1 + Math.sin(t * 9) * 0.05 + Math.sin(t * 21) * 0.025 : 1;
    var lean = alive ? Math.sin(t * 6.3) * 0.055 : 0;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(lean);
    ctx.scale(s, s * f);
    var LAYERS = alive
      ? [[1.00, '#b8290d'], [0.70, '#ff8a2c'], [0.40, '#ffd75e'], [0.17, '#fffbe8']]
      : [[1.00, '#4a3a33'], [0.70, '#5d4a40'], [0.40, '#6b5b4c'], [0.17, '#7d6c5c']];
    for (var i = 0; i < LAYERS.length; i++) {
      var k = LAYERS[i][0];
      ctx.fillStyle = LAYERS[i][1];
      ctx.beginPath();
      ctx.moveTo(0, -13 * k);                                  // the tip
      ctx.bezierCurveTo(6.5 * k, -7 * k, 8 * k, -1 * k, 8 * k, 3 * k);
      ctx.bezierCurveTo(8 * k, 9 * k, 3.6 * k, 12.5 * k, 0, 12.5 * k);
      ctx.bezierCurveTo(-3.6 * k, 12.5 * k, -8 * k, 9 * k, -8 * k, 3 * k);
      ctx.bezierCurveTo(-8 * k, -1 * k, -3.2 * k, -5 * k, -2.2 * k, -9.5 * k);
      // the kink that stops it reading as a plain teardrop
      ctx.bezierCurveTo(-1.0 * k, -6.5 * k, 1.6 * k, -7.5 * k, 0, -13 * k);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  /// Vector padlock — shackle + body, drawn to the same weight as the labels.
  function lockGlyph(ctx, cx, cy, s, col) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.strokeStyle = col; ctx.lineWidth = 2 * s; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.arc(0, -2.2 * s, 3.1 * s, Math.PI, 0); ctx.stroke();
    ctx.fillStyle = col;
    rr(ctx, -5 * s, -1.4 * s, 10 * s, 8 * s, 1.6 * s); ctx.fill();
    ctx.restore();
  }

  function drawTurret(ctx, x, baseY, rad, h, lit, shade, roof) {
    ctx.fillStyle = shade;
    ctx.fillRect(x - rad, baseY - h, rad * 2, h);
    ctx.fillStyle = lit;
    ctx.fillRect(x - rad, baseY - h, rad * 1.2, h);
    ctx.beginPath(); ctx.ellipse(x, baseY, rad, rad * 0.4, 0, 0, 6.283); ctx.fill();
    if (roof) {
      ctx.fillStyle = roof;
      ctx.beginPath();
      ctx.moveTo(x - rad - 4, baseY - h);
      ctx.lineTo(x, baseY - h - rad * 1.9);
      ctx.lineTo(x + rad + 4, baseY - h);
      ctx.closePath(); ctx.fill();
    } else {
      // crenellations
      ctx.fillStyle = shade;
      for (var c = -1; c <= 1; c++) ctx.fillRect(x + c * rad * 0.7 - 2.5, baseY - h - 6, 5, 6);
    }
  }
  function drawSpeaker(ctx, cx, cy, muted) {
    ctx.fillStyle = '#ffe9c4';
    ctx.beginPath();
    ctx.moveTo(cx - 8, cy - 4); ctx.lineTo(cx - 3, cy - 4); ctx.lineTo(cx + 3, cy - 9);
    ctx.lineTo(cx + 3, cy + 9); ctx.lineTo(cx - 3, cy + 4); ctx.lineTo(cx - 8, cy + 4);
    ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#ffe9c4'; ctx.lineWidth = 2;
    if (muted) {
      ctx.beginPath(); ctx.moveTo(cx + 6, cy - 6); ctx.lineTo(cx + 14, cy + 6); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(cx + 14, cy - 6); ctx.lineTo(cx + 6, cy + 6); ctx.stroke();
    } else {
      ctx.beginPath(); ctx.arc(cx + 4, cy, 7, -0.9, 0.9); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx + 4, cy, 11, -0.9, 0.9); ctx.stroke();
    }
  }
  function strokePath(ctx, pts, w, style) {
    ctx.strokeStyle = style; ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.stroke();
  }

  // ===== boot + DEV-GATED debug surface (§3c) =============================
  var _dev = /[?&]dev=1/.test(location.search);   // DEV-HARNESS-COMPILE-TIME: strip
  var canvas = document.getElementById('game-canvas');
  var game = null;

  // Production exposes lifecycle pause only. Declared before boot so a shell
  // that calls pause() during the splash cannot throw.
  window.__game = { pause: function (v) { if (game) game.setPaused(v); } };

  // Replaced by the dev harness at the bottom of this file. It has to exist in
  // a stripped build too, because boot calls it unconditionally.
  var bootDev = function () {};

  // ===== BOOT ==============================================================
  // Nothing renders until the art is DECODED. The game used to construct
  // immediately and run its render loop against an empty ART.images, so the
  // first seconds were the chunky procedural fallbacks — a flat blue-roofed
  // box where the painted keep goes, a bare ellipse for the hoard. VANUS read
  // that (correctly) as broken/stale art that "fixes itself up after a while".
  // A splash that says "loading" is honest; a wrong-looking game is not.
  //
  // decode() rather than onload: onload only promises the bytes parsed, and
  // Safari can still stall on the first drawImage of a large texture. Decoding
  // up front moves that cost into the splash where it belongs.
  ART.load(
    function (frac) {
      var fill = document.getElementById('boot-fill');
      if (fill) fill.style.width = Math.round(frac * 100) + '%';
    },
    function (loaded, total) {
      game = new Game(canvas);
      window.addEventListener('resize', function () { game.resize(); });
      loadWalkFrames();                    // enhancement: never blocks the boot
      var boot = document.getElementById('boot');
      if (boot) {
        boot.classList.add('gone');
        setTimeout(function () { if (boot.parentNode) boot.parentNode.removeChild(boot); }, 450);
      }
      if (loaded < total) {
        // Loud in dev, silent for the player — a silent fallback hides missing
        // assets, which is exactly how bad art ships unnoticed.
        try { console.warn('hoardling: booted with ' + (total - loaded) + '/' + total +
                           ' assets missing: ' + Object.keys(ART.missing).join(', ')); } catch (e) {}
      }
      bootDev();
    });

  

})();
