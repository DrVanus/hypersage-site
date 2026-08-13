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
    startGold: 120,
    startHoard: 60,      // treasure coins = the life bar
    breathAt: 15,        // hoard level that wakes Mother's Breath (once per level)
    waveCountdown: 12,   // seconds between waves; calling early pays the remainder
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
  var TOWER_TYPES = {
    mimic: {
      name: 'Latch Mimic', cost: 80, hitsAir: false,
      levels: [
        { dmg: 8,  rate: 1.0, range: 40, upgradeCost: 70 },
        { dmg: 14, rate: 1.1, range: 40, upgradeCost: 120 },
        { dmg: 22, rate: 1.2, range: 44, upgradeCost: 0, special: 'bleed' }, // 3 dmg/s for 2s
      ],
    },
    ballista: {
      name: 'Kobold Crossbow', cost: 70, hitsAir: true,
      levels: [
        { dmg: 12, rate: 1.2, range: 105, upgradeCost: 60 },
        { dmg: 20, rate: 1.4, range: 118, upgradeCost: 110 },
        { dmg: 34, rate: 1.6, range: 130, upgradeCost: 0, special: 'crit' }, // 20% for 2x (lane-1 keyed on shot index)
      ],
    },
    brazier: {
      name: 'Soot Brazier', cost: 100, hitsAir: false,
      levels: [
        { dmg: 9,  rate: 0.8, range: 92,  splash: 38, upgradeCost: 90 },
        { dmg: 15, rate: 0.9, range: 101, splash: 38, upgradeCost: 160, burn: 4 },
        { dmg: 24, rate: 1.0, range: 109, splash: 50, upgradeCost: 0, burn: 8, special: 'inferno' },
      ],
    },
    crystal: {
      name: 'Gemsinger', cost: 50, hitsAir: true,
      levels: [
        { dmg: 3, rate: 1.0, range: 92,  slow: 0.30, slowDur: 1.5, upgradeCost: 50 },
        { dmg: 5, rate: 1.1, range: 105, slow: 0.40, slowDur: 2.0, upgradeCost: 90 },
        { dmg: 8, rate: 1.2, range: 118, slow: 0.50, slowDur: 2.0, upgradeCost: 0, special: 'deepchill' },
      ],
    },
    perch: {
      name: 'Gargoyle Roost', cost: 90, hitsAir: true, airBonus: 1.5,
      levels: [
        { dmg: 18, rate: 0.6, range: 134, pierce: 2, upgradeCost: 80 },
        { dmg: 30, rate: 0.7, range: 147, pierce: 3, upgradeCost: 140 },
        { dmg: 48, rate: 0.8, range: 160, pierce: 4, upgradeCost: 0, special: 'shieldbreak', airBonus3: 1.75 },
      ],
    },
  };
  var TOWER_ORDER = ['crystal', 'ballista', 'mimic', 'perch', 'brazier']; // cheap -> dear

  var ENEMY_TYPES = {
    looter:   { name: 'Scrapling',     hp: 30,   spd: 42, bounty: 4,   steals: 1,  flyer: false },
    scout:    { name: 'Filcher',       hp: 22,   spd: 76, bounty: 6,   steals: 3,  flyer: false },
    brute:    { name: 'Bulwark',       hp: 220,  spd: 25, bounty: 18,  steals: 5,  flyer: false, armor: 5 },
    shield:   { name: 'Shellback',     hp: 90,   spd: 38, bounty: 12,  steals: 2,  flyer: false, pavise: true }, // halves bolt damage
    bat:      { name: 'Gloomwing',     hp: 45,   spd: 59, bounty: 10,  steals: 2,  flyer: true  },
    warlock:  { name: 'Greed Hexer',   hp: 80,   spd: 34, bounty: 16,  steals: 2,  flyer: false, heals: 10, healR: 63 },
    blinker:  { name: 'Blinker',       hp: 60,   spd: 46, bounty: 14,  steals: 3,  flyer: false, blink: 84, blinkEvery: 4 },
    boss:     { name: 'The Hoard King', hp: 3000, spd: 19, bounty: 150, steals: 25, flyer: false, auraR: 84, auraSpd: 1.2, summonAtHalf: 6 },
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
    [{ type: 'blinker', count: 4, gap: 2.2, delay: 0 }, { type: 'looter', count: 10, gap: 0.9, delay: 1 }],
    [{ type: 'bat',    count: 8,  gap: 1.1, delay: 0 }, { type: 'shield', count: 4, gap: 2.0, delay: 2 }],
    [{ type: 'brute',  count: 4,  gap: 3.5, delay: 0 }, { type: 'warlock', count: 2, gap: 7.0, delay: 3 }, { type: 'scout', count: 8, gap: 0.8, delay: 6 }],
    [{ type: 'scout',  count: 14, gap: 0.5, delay: 0 }, { type: 'bat', count: 6, gap: 1.2, delay: 4 }],
    [{ type: 'shield', count: 6,  gap: 1.8, delay: 0 }, { type: 'blinker', count: 4, gap: 2.0, delay: 3 }],
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
    [{ type: 'blinker', count: 5, gap: 1.8, delay: 0 }, { type: 'shield', count: 4, gap: 2.0, delay: 2 }],
    [{ type: 'warlock', count: 2, gap: 6.0, delay: 0 }, { type: 'brute', count: 3, gap: 3.5, delay: 1 }, { type: 'looter', count: 10, gap: 0.8, delay: 4 }],
    [{ type: 'bat',    count: 10, gap: 0.9, delay: 0 }, { type: 'scout', count: 8, gap: 0.8, delay: 3 }],
    [{ type: 'looter', count: 30, gap: 0.35, delay: 0 }, { type: 'blinker', count: 5, gap: 1.6, delay: 4 }],
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
      pads: [
        { x: 300, y: 758 }, { x: 168, y: 736 }, { x: 56, y: 684 },
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
        { x: 218, y: 646 }, { x: 78, y: 674 }, { x: 356, y: 724 },
        { x: 226, y: 486 }, { x: 138, y: 328 }, { x: 356, y: 262 },
        { x: 44, y: 348 }, { x: 288, y: 356 }, { x: 168, y: 770 },
      ],
      torches: [[40, 690], [368, 580], [40, 480], [330, 250], [230, 726], [368, 420]],
      heroStart: { x: 150, y: 600 },
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
      heroStart: { x: 300, y: 610 },
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
  var DAILY_ROSTER = ['looter', 'scout', 'brute', 'shield', 'bat', 'warlock', 'blinker'];
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
        musicBus = ac.createGain(); musicBus.gain.value = 0.5; musicBus.connect(master);
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
    // --- music: a slow D-minor cavern loop, scheduled ahead (BBH pattern).
    // 'calm' = drone + sparse bells; 'battle' layers a bass pulse + war drums.
    var musicOn = false, musicMode = 'calm', seqTimer = null, stepIdx = 0, nextT = 0, mNoise = null;
    var M_BASS = [73.4, 73.4, 87.3, 87.3, 98, 98, 110, 110];   // D D F F G G A A
    var M_MEL = [
      294, 0, 0, 0, 349, 0, 0, 0, 440, 0, 0, 392, 0, 0, 349, 0,
      0, 0, 294, 0, 0, 262, 0, 0, 349, 0, 330, 0, 294, 0, 0, 0,
      392, 0, 0, 0, 440, 0, 0, 0, 523, 0, 0, 440, 0, 392, 0, 0,
      349, 0, 392, 0, 440, 0, 0, 0, 294, 0, 0, 0, 0, 0, 0, 0,
    ];
    function mnote(freq, t, dur, type, vol) {
      var o = ac.createOscillator(), g = ac.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(vol, t + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(musicBus);
      o.start(t); o.stop(t + dur + 0.05);
    }
    function mthump(t, vol) {
      if (!mNoise) return;
      var src = ac.createBufferSource();
      src.buffer = mNoise;
      var f = ac.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = 180;
      var g = ac.createGain();
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      src.connect(f); f.connect(g); g.connect(musicBus);
      src.start(t); src.stop(t + 0.25);
    }
    function schedule() {
      if (!musicOn || !ac || ac.state !== 'running') return;
      if (nextT < ac.currentTime) nextT = ac.currentTime + 0.05;   // no catch-up blast after resume
      var stepDur = 60 / 76 / 2;                                   // 8ths at 76 bpm
      while (nextT < ac.currentTime + 0.3) {
        var s = stepIdx % 64, bar = (s / 8) | 0, inBar = s % 8;
        var t = nextT;
        if (inBar === 0) {
          mnote(M_BASS[bar], t, stepDur * 6, 'triangle', 0.09);    // drone root
          mnote(M_BASS[bar] * 3, t, stepDur * 5, 'sine', 0.02);    // high shimmer
        }
        if (M_MEL[s]) mnote(M_MEL[s], t, stepDur * 2.4, 'sine', 0.045);
        if (musicMode === 'battle') {
          mnote(M_BASS[bar] * 2, t, stepDur * 0.5, 'sawtooth', 0.028);
          if (inBar === 0 || inBar === 4) mthump(t, 0.14);
        }
        nextT += stepDur; stepIdx++;
      }
    }
    function startMusic() {
      if (musicOn || !ac) return;
      musicOn = true;
      if (!mNoise) {
        var len = ZZFX_RATE, nb = ac.createBuffer(1, len, ZZFX_RATE);
        var ch = nb.getChannelData(0);
        for (var i = 0; i < len; i++) ch[i] = Math.random() * 2 - 1;
        mNoise = nb;
      }
      nextT = ac.currentTime + 0.1;
      seqTimer = setInterval(schedule, 100);
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
        if (a) { startAmbience(); startMusic(); }
      },
      setMusicMode: function (m) { musicMode = m; },
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
  var Save = (function () {
    var KEY2 = 'hoardling.save.v2', KEY1 = 'hoardling.save.v1';
    var data = { stars: [0, 0, 0], dailyBestWave: 0, tut: 0 };
    try {
      var raw = localStorage.getItem(KEY2);
      if (raw) {
        var p = JSON.parse(raw);
        if (Array.isArray(p.stars)) {
          for (var i = 0; i < data.stars.length; i++) data.stars[i] = (p.stars[i] | 0) || 0;
        }
        if (typeof p.dailyBestWave === 'number') data.dailyBestWave = p.dailyBestWave | 0;
        if (typeof p.tut === 'number') data.tut = p.tut | 0;
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
    return { data: data, write: write, unlocked: unlocked };
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
  var ENEMY_FACING = {
    looter: -1, scout: -1, brute: -1, shield: -1,
    bat: -1, warlock: -1, blinker: -1, boss: -1,
  };

  var ENEMY_COLORS = {
    looter: '#6fae52', scout: '#4fc978', brute: '#4a8a3a', shield: '#9aa2ad',
    bat: '#8a6ad6', warlock: '#7b3fa0', blinker: '#d6a64f', boss: '#c9b8a8',
  };

  // ===== ART registry — the seam the art pipeline fills ===================
  // Sprites land as PNG cutouts in art/. Until then every drawer has a chunky
  // procedural fallback. The fallback is LOUD in dev: missing ids are listed
  // on screen (silent fallbacks hide assets — see HANDOFF invariants).
  // walk-cycle frames (masked-inpaint legs; upper bodies identical to the
  // master plate by construction). Behind a toggle per the animation memory.
  var WALK_FRAMES = !/[?&]frames=0/.test(location.search);
  var ANIM = { meta: {}, images: {} };
  if (WALK_FRAMES && typeof window !== 'undefined' && window.fetch) {
    fetch('art/anim/meta.json').then(function (r) { return r.ok ? r.json() : {}; }).then(function (m) {
      ANIM.meta = m || {};
      Object.keys(ANIM.meta).forEach(function (k) {
        ['a', 'b'].forEach(function (tag) {
          var img = new Image();
          img.onload = function () { ANIM.images[k + '_' + tag] = img; };
          img.src = 'art/anim/' + k + '_' + tag + '.png';
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
      t_mimic:   'art/tower_mimic.png',
      t_ballista:'art/tower_ballista.png',
      t_brazier: 'art/tower_brazier.png',
      t_crystal: 'art/tower_crystal.png',
      t_perch:   'art/tower_perch.png',
      e_looter:  'art/enemy_looter.png',
      e_scout:   'art/enemy_scout.png',
      e_brute:   'art/enemy_brute.png',
      e_shield:  'art/enemy_shield.png',
      e_bat:     'art/enemy_bat.png',
      e_warlock: 'art/enemy_warlock.png',
      e_blinker: 'art/enemy_blinker.png',
      e_boss:    'art/enemy_boss.png',
      pad:       'art/build_pad.png',
      torch:     'art/torch.png',
      bg:        'art/cavern_bg.png',
      road:      'art/road.png',
    },
    images: {}, missing: {},
    load: function () {
      var self = this;
      Object.keys(this.manifest).forEach(function (id) {
        var img = new Image();
        img.onload = function () { self.images[id] = img; delete self.missing[id]; };
        img.onerror = function () { self.missing[id] = 1; };
        img.src = self.manifest[id];
      });
    },
  };
  ART.load();

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

  // ===== Game =============================================================
  function Game(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.view = { cw: 1, ch: 1, dpr: 1, scale: 1, w: VIEW_MIN_W, h: VIEW_H, ox: 0, oy: 0 };
    this._last = 0; this._acc = 0;
    this.particles = []; this.floats = []; this.shake = 0;
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

  Game.prototype.reset = function (seed, mode, level) {
    this.seed = (seed >>> 0) || dailySeed();
    this.mode = mode || this.mode;
    // level select: campaign takes the chosen map; the Daily rotates its map
    // as a PURE function of the seed, so every player fights the same layout
    if (this.mode === 'daily') this.levelIdx = setLevel(this.seed % MAPS.length);
    else this.levelIdx = setLevel(level !== undefined ? level : (this.levelIdx || 0));
    seedStream(this.seed);                  // LANE 2 seeded once, at reset
    this.worldT = 0;
    this.gold = CFG.startGold;
    this.hoard = CFG.startHoard;
    this.wave = 0;                          // waves completed; current = wave index while active
    this.waveActive = false;
    this.waveT = 0;
    this.countdown = 6;                     // grace before wave 1
    this.spawnQueue = [];                   // built at wave start, drained by time
    this.enemies = []; this.towers = []; this.projectiles = [];
    this.nextId = 1;
    var hs = MAP.heroStart || { x: 210, y: 470 };
    this.hero = { x: hs.x, y: hs.y, tx: hs.x, ty: hs.y, range: 76, dmg: 9, rate: 1.25, cd: 0, breathCd: 6, spd: 85, selected: false };
    this.menu = null;                       // { padIdx } build menu | { towerIdx } manage menu
    this.stolenLost = 0; this.kills = 0;
    this.breathUsed = false;                // Mother's Breath fires once per level
    this.hitstopT = 0;
    this.resultLockT = 0;
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
    var groups = this.mode === 'daily' ? dailyWaveComp(w, this.seed) : WAVE_TABLES[this.levelIdx][w];
    var hpMul = this.mode === 'daily' ? dailyHpMul(w) : 1;
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
  Game.prototype.totalWaves = function () { return this.mode === 'daily' ? Infinity : WAVE_TABLES[this.levelIdx].length; };

  Game.prototype.startWave = function () {
    if (this.waveActive || this.state !== 'playing') return;
    if (this.countdown > 0.5 && this.wave > 0) {           // early-call bonus
      var bonus = Math.ceil(this.countdown);
      this.gold += bonus;
      this.fxQueue.push({ k: 'float', x: WORLD_W / 2, y: 700, txt: '+' + bonus + 'g early!', c: '#ffd75e' });
    }
    this.spawnQueue = this.buildWave(this.wave);
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
        this.enemies.push({
          id: this.nextId++, type: sp.type, d: 0,
          hp: Math.round(base.hp * sp.hpMul), maxHp: Math.round(base.hp * sp.hpMul),
          spd: base.spd, slowT: 0, slowF: 1, burnT: 0, burnDps: 0, bleedT: 0,
          blinkT: base.blinkEvery || 0, healT: 1, grabT: 0, auraF: 1,
          stolen: 0, fleeing: false, flyer: !!base.flyer, summoned: false, shieldBroken: false,
          flashT: 0, px: PATH.pts[0][0], py: PATH.pts[0][1],
        });
      }
    }

    // -- Mother's Breath: once per level, when the hoard runs cold, Auremma
    // half-stirs and exhales — a screen-wide wave that scours every raider.
    if (!this.breathUsed && this.hoard <= CFG.breathAt) {
      this.breathUsed = true;
      for (var mb = 0; mb < this.enemies.length; mb++) this.enemies[mb].hp -= 60;
      this.hitstopT = 0.12;   // ultimate beat, just inside the hitch ceiling
      this.fxQueue.push({ k: 'mother' });
      Sfx.play('breath');
    }

    // -- boss war-drum aura: +speed to allies near the Hoard King --
    for (var au = 0; au < this.enemies.length; au++) this.enemies[au].auraF = 1;
    for (var ab = 0; ab < this.enemies.length; ab++) {
      var bossE = this.enemies[ab], bossB = ENEMY_TYPES[bossE.type];
      if (!bossB.auraR) continue;
      for (var aj = 0; aj < this.enemies.length; aj++) {
        var ally = this.enemies[aj];
        if (ally === bossE) continue;
        var adx = ally.px - bossE.px, ady = ally.py - bossE.py;
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
            spd: lb.spd, slowT: 0, slowF: 1, burnT: 0, burnDps: 0,
            bleedT: 0, blinkT: 0, healT: 1, grabT: 0, auraF: 1,
            stolen: 0, fleeing: false, flyer: false, summoned: false, shieldBroken: false,
            flashT: 0, px: sp2.x, py: sp2.y,
          });
        }
        this.fxQueue.push({ k: 'float', x: bossE.px, y: bossE.py - 30, txt: 'ROAR!', c: '#ff7b7b' });
        Sfx.play('wave');
      }
    }

    // -- enemies --
    var keepD = PATH.len;
    for (var i = this.enemies.length - 1; i >= 0; i--) {
      var e = this.enemies[i];
      var base2 = ENEMY_TYPES[e.type];
      // status
      if (e.slowT > 0) { e.slowT -= STEP; if (e.slowT <= 0) e.slowF = 1; }
      if (e.burnT > 0) { e.burnT -= STEP; e.hp -= e.burnDps * STEP; if (e.burnT <= 0) e.burnDps = 0; }
      if (e.bleedT > 0) { e.bleedT -= STEP; e.hp -= 3 * STEP; }
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
            var dx = o.px - e.px, dy = o.py - e.py;
            if (dx * dx + dy * dy < base2.healR * base2.healR) {
              o.hp = Math.min(o.maxHp, o.hp + base2.heals);
            }
          }
          this.fxQueue.push({ k: 'heal', x: e.px, y: e.py });
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
      var v = e.spd * e.slowF * e.auraF * STEP;
      if (e.fleeing) {
        // loot-weight rule: the more they carry, the slower they run
        var fleeMul = Math.max(CFG.fleeMin, CFG.fleeBase - CFG.fleeWeight * e.stolen);
        e.d -= v * fleeMul;
        if (e.d <= 0) {                                    // escaped with treasure
          this.stolenLost += e.stolen;
          this.enemies.splice(i, 1);
          this.fxQueue.push({ k: 'escape', x: PATH.pts[0][0], y: PATH.pts[0][1] });
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

    // -- towers --
    for (var t = 0; t < this.towers.length; t++) {
      var tw = this.towers[t];
      var tt = TOWER_TYPES[tw.type], lv = tt.levels[tw.level];
      tw.cd -= STEP;
      if (tw.cd > 0) continue;
      var pad = MAP.pads[tw.padIdx];
      // crystal: pulse-slow everything in range, no target needed.
      // BACKWARDS: _damage can kill+splice, and a forward loop would skip
      // the enemy shifted into the vacated slot.
      if (tw.type === 'crystal') {
        var hitAny = 0;
        for (var c = this.enemies.length - 1; c >= 0; c--) {
          var ce = this.enemies[c];
          if (ce.hp <= 0) continue;
          var cdx = ce.px - pad.x, cdy = ce.py - pad.y;
          if (cdx * cdx + cdy * cdy <= lv.range * lv.range) {
            ce.slowF = Math.min(ce.slowF, ce.type === 'boss' ? 0.75 : 1 - lv.slow);
            ce.slowT = lv.slowDur;
            if (lv.dmg) this._damage(ce, lv.dmg, { kind: 'magic', tower: tw });
            hitAny++;
          }
        }
        if (hitAny) this.fxQueue.push({ k: 'pulse', x: pad.x, y: pad.y, r: lv.range, n: hitAny });
        tw.cd = hitAny ? 1 / lv.rate : 0.1;   // idle rescan at 6 Hz, not 60
        continue;
      }
      var target = this._pickTarget(pad, lv.range, tt.hitsAir, tt.airBonus);
      if (!target) { tw.cd = 0.1; continue; }   // miss: rescan at 6 Hz, not 60
      tw.cd = 1 / lv.rate;
      var tp = { x: target.px, y: target.py };
      if (tw.type === 'mimic') {                            // instant bite
        this._damage(target, lv.dmg, { kind: 'melee', tower: tw });
        if (lv.special === 'bleed') target.bleedT = 2;
        this.fxQueue.push({ k: 'bite', x: tp.x, y: tp.y });
        Sfx.play('bite');
      } else if (tw.type === 'brazier') {                   // lobbed splash
        this.projectiles.push({ kind: 'lob', x: pad.x, y: pad.y - 26, sx: pad.x, sy: pad.y - 26, tx: tp.x, ty: tp.y, t: 0, dur: 0.55, dmg: lv.dmg, splash: lv.splash, burn: lv.burn || 0, tower: t });
        Sfx.play('lob');
      } else {                                              // homing bolt (crossbow / roost)
        var dmg = lv.dmg;
        if (tw.type === 'perch' && target.flyer) dmg *= (lv.airBonus3 || tt.airBonus || 1);
        // crit: LANE 1 keyed on this tower's shot index — deterministic, order-free
        tw.shots = (tw.shots || 0) + 1;
        var crit = lv.special === 'crit' && noise01(tw.shots, (this.seed ^ (0xC217 + tw.padIdx * 131)) >>> 0) < 0.2;
        if (crit) dmg *= 2;
        this.projectiles.push({
          kind: 'bolt', x: pad.x, y: pad.y - 30, target: target.id, spd: 340,
          dmg: dmg, crit: crit, hops: lv.pierce || 0,
          shieldbreak: lv.special === 'shieldbreak', tower: t,
        });
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
          // BACKWARDS: _damage can kill+splice mid-loop
          for (var b = this.enemies.length - 1; b >= 0; b--) {
            var be = this.enemies[b];
            if (be.flyer || be.hp <= 0) continue;
            var bdx = be.px - pr.tx, bdy = be.py - pr.ty;
            if (bdx * bdx + bdy * bdy <= pr.splash * pr.splash) {
              this._damage(be, pr.dmg, { kind: 'splash', tower: this.towers[pr.tower] });
              if (pr.burn) { be.burnT = 3; be.burnDps = Math.max(be.burnDps, pr.burn); }
            }
          }
          Sfx.play('hit');
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
          if (pr.crit) this.fxQueue.push({ k: 'float', x: gp.x, y: gp.y - 14, txt: 'crit!', c: '#ff9a3c' });
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
    var hdx = h.tx - h.x, hdy = h.ty - h.y;
    var hd = Math.sqrt(hdx * hdx + hdy * hdy);
    if (hd > 2) { h.x += hdx / hd * Math.min(h.spd * STEP, hd); h.y += hdy / hd * Math.min(h.spd * STEP, hd); }
    h.cd -= STEP; h.breathCd -= STEP;
    var inR = [];
    for (var e2 = 0; e2 < this.enemies.length; e2++) {
      var en2 = this.enemies[e2];
      if (en2.hp <= 0) continue;
      var ndx = en2.px - h.x, ndy = en2.py - h.y;
      if (ndx * ndx + ndy * ndy <= h.range * h.range) inR.push(en2);
    }
    if (h.breathCd <= 0 && inR.length >= 3) {
      h.breathCd = 14;
      // breath is armor-piercing (kind 'breath' — the _damage contract)
      for (var br = inR.length - 1; br >= 0; br--) this._damage(inR[br], 26, { kind: 'breath' });
      this.fxQueue.push({ k: 'breath', x: h.x, y: h.y, r: h.range });
      Sfx.play('breath');
    } else if (h.cd <= 0 && inR.length) {
      var pick = inR[0];
      for (var pk = 1; pk < inR.length; pk++) if (inR[pk].d > pick.d) pick = inR[pk];
      h.cd = 1 / h.rate;
      this.fxQueue.push({ k: 'spit', x1: h.x, y1: h.y - 14, x2: pick.px, y2: pick.py });
      this._damage(pick, h.dmg, { kind: 'hero' });
      Sfx.play('shoot');
    }

    // -- wave clear (no flat gold bonus: the balance table's income = start +
    // bounties; the early-call button is the only extra tap) --
    if (this.waveActive && !this.spawnQueue.length && !this.enemies.length) {
      this.waveActive = false;
      this.menu = null;                     // no stale menu into the intermission
      this.wave++;
      this.fxQueue.push({ k: 'float', x: WORLD_W / 2, y: 300, txt: 'Wave ' + this.wave + ' held!', c: '#9ef58f' });
      if (this.wave >= this.totalWaves()) { this._gameOver(true); return; }
      this.countdown = CFG.waveCountdown;
    }
  };

  Game.prototype._pickTarget = function (pad, range, hitsAir, airBonus) {
    // Priority: fleeing thieves (they carry OUR gold) — and among fleers the
    // one CLOSEST TO ESCAPING (smallest d) — then furthest-along marcher.
    // Deterministic tie-break on id.
    var best = null, bestKey = -Infinity;
    for (var i = 0; i < this.enemies.length; i++) {
      var e = this.enemies[i];
      if (e.hp <= 0) continue;
      if (e.flyer && !hitsAir) continue;
      var dx = e.px - pad.x, dy = e.py - pad.y;
      if (dx * dx + dy * dy > range * range) continue;
      var urgency = e.fleeing ? (PATH.len - e.d) : e.d;
      var key = (e.fleeing ? 1e6 : 0) + (e.flyer && airBonus ? 5e5 : 0) + urgency - e.id * 1e-7;
      if (key > bestKey) { bestKey = key; best = e; }
    }
    return best;
  };
  Game.prototype._nextBehind = function (tgt) {
    var best = null;
    for (var i = 0; i < this.enemies.length; i++) {
      var e = this.enemies[i];
      if (e === tgt || e.hp <= 0 || e.flyer) continue;
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
    var bounty = greed ? Math.round(base.bounty * 1.5) : base.bounty;
    this.gold += bounty;
    this.kills++;
    var p = { x: e.px, y: e.py };
    if (e.stolen > 0) {                                     // recover the treasure!
      this.hoard += e.stolen;
      this.fxQueue.push({ k: 'recover', x: p.x, y: p.y, n: e.stolen });
      Sfx.play('recover');
    }
    if (e.type === 'boss') this.hitstopT = 0.09;   // ~5 frames; >120ms reads as a hitch
    this.fxQueue.push({ k: 'death', x: p.x, y: p.y, g: bounty, boss: e.type === 'boss' });
    Sfx.play('coin');
    this.enemies.splice(i, 1);
  };
  Game.prototype._gameOver = function (won) {
    this.state = won ? 'won' : 'lost';
    this.resultLockT = 0.8;                 // battle taps can't skip the screen
    // stars grade COINS LOST FOREVER (escaped carriers), not the closing balance
    var stars = this.stolenLost <= 5 ? 3 : this.stolenLost <= 20 ? 2 : 1;
    this.result = { won: won, stars: stars, hoard: this.hoard, lost: this.stolenLost, kills: this.kills, wave: this.wave };
    if (this.mode === 'campaign' && won && stars > Save.data.stars[this.levelIdx]) Save.data.stars[this.levelIdx] = stars;
    if (this.mode === 'daily' && this.wave > Save.data.dailyBestWave) Save.data.dailyBestWave = this.wave;
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
    var v = this.view;
    var vx = w.vx !== undefined ? w.vx : w.x + v.ox;
    var vy = w.vy !== undefined ? w.vy : w.y + v.oy;

    // SCREEN-ANCHORED HUD first — it lives in the bands on tall phones
    if (this.state === 'playing') {
      var G = this._hudGeom();
      if (vy >= G.btnY && vy <= G.btnY + 34) {
        if (vx >= G.spd && vx <= G.spd + 44) { this.speed = this.speed === 1 ? 2 : 1; return; }
        if (vx >= G.pause && vx <= G.pause + 44) { this.setPaused(true); return; }
        if (vx >= G.mute && vx <= G.mute + 44) { Sfx.toggle(); return; }
      }
      if (!this.waveActive && this.wave < this.totalWaves() &&
          vx >= G.cx - 92 && vx <= G.cx + 92 && vy >= G.startY && vy <= G.startY + 52) {
        this.startWave(); return;
      }
    }

    if (this.state === 'menu') {
      if (w.x > WORLD_W / 2 - 130 && w.x < WORLD_W / 2 + 130) {
        for (var lv = 0; lv < MAPS.length; lv++) {
          var by = 414 + lv * 60;
          if (w.y > by && w.y < by + 52) {
            if (!Save.unlocked(lv)) return;      // locked: tap does nothing
            this.reset(1, 'campaign', lv); this.state = 'playing'; return;
          }
        }
        if (w.y > 596 && w.y < 648) { this.reset(dailySeed(), 'daily'); this.state = 'playing'; return; }
      }
      if (w.x > WORLD_W / 2 - 70 && w.x < WORLD_W / 2 + 70 && w.y > 676 && w.y < 712) { Sfx.toggle(); return; }
      return;
    }
    if (this.state === 'won' || this.state === 'lost') {
      if (this.resultLockT > 0) return;      // a mid-battle tap can't skip the screen
      this.reset(this.mode === 'daily' ? dailySeed() : 1, this.mode);
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
    if (this.menu) {
      var m = this.menu;
      if (m.padIdx !== undefined) {                          // build menu — nearest-wins
        var pad = MAP.pads[m.padIdx];
        var bestB = -1, bestD = 24 * 24;
        for (var b = 0; b < TOWER_ORDER.length; b++) {
          var bp = this._menuBtnPos(pad, b, TOWER_ORDER.length);
          var dx = w.x - bp.x, dy = w.y - bp.y, dd = dx * dx + dy * dy;
          if (dd < bestD) { bestD = dd; bestB = b; }
        }
        if (bestB !== -1) {
          var tid = TOWER_ORDER[bestB];
          if (this.gold >= TOWER_TYPES[tid].cost) {
            this.gold -= TOWER_TYPES[tid].cost;
            this.towers.push({ type: tid, level: 0, padIdx: m.padIdx, cd: 0 });
            this.fxQueue.push({ k: 'place', x: pad.x, y: pad.y });
            Sfx.play('place');
          }
          this.menu = null; return;
        }
      } else if (m.towerIdx !== undefined) {                 // manage menu — nearest-wins
        var tw = this.towers[m.towerIdx];
        if (tw) {
          var pad2 = MAP.pads[tw.padIdx];
          var up = this._menuBtnPos(pad2, 0, 2), sell = this._menuBtnPos(pad2, 1, 2);
          var lvl = TOWER_TYPES[tw.type].levels[tw.level];
          var ud = (w.x - up.x) * (w.x - up.x) + (w.y - up.y) * (w.y - up.y);
          var sd = (w.x - sell.x) * (w.x - sell.x) + (w.y - sell.y) * (w.y - sell.y);
          if (Math.min(ud, sd) < 24 * 24) {
            if (ud <= sd) {
              if (tw.level < 2 && this.gold >= lvl.upgradeCost) {
                this.gold -= lvl.upgradeCost; tw.level++;
                this.fxQueue.push({ k: 'place', x: pad2.x, y: pad2.y });
                Sfx.play('upg');
              }
            } else {
              this.gold += this._sellValue(tw);
              this.towers.splice(m.towerIdx, 1);
              Sfx.play('sell');
            }
            this.menu = null; return;
          }
        }
      }
      this.menu = null;                                     // tapped elsewhere: close
      return;
    }

    // hero select / move
    var hh = this.hero;
    var hdx = w.x - hh.x, hdy = w.y - hh.y;
    if (hdx * hdx + hdy * hdy < 30 * 30) { hh.selected = !hh.selected; return; }
    if (hh.selected) {
      var tx = clamp(w.x, 20, WORLD_W - 20), ty = clamp(w.y, 120, WORLD_H - 30);
      // keep Wick OFF the pads so he can never mask a pad's tap target
      for (var pj = 0; pj < MAP.pads.length; pj++) {
        var pp = MAP.pads[pj];
        var pdx2 = tx - pp.x, pdy2 = ty - pp.y;
        var dist2 = Math.sqrt(pdx2 * pdx2 + pdy2 * pdy2);
        if (dist2 < 44) {
          if (dist2 < 0.001) { tx = pp.x + 44; }
          else { tx = pp.x + pdx2 / dist2 * 44; ty = pp.y + pdy2 / dist2 * 44; }
        }
      }
      hh.tx = clamp(tx, 20, WORLD_W - 20); hh.ty = clamp(ty, 120, WORLD_H - 30);
      hh.selected = false; return;
    }

    // towers / pads beat the HUD bands and the start-wave rect
    for (var t = 0; t < this.towers.length; t++) {
      var pd = MAP.pads[this.towers[t].padIdx];
      var tdx = w.x - pd.x, tdy = w.y - pd.y;
      if (tdx * tdx + tdy * tdy < 32 * 32) { this.menu = { towerIdx: t }; return; }
    }
    for (var pI = 0; pI < MAP.pads.length; pI++) {
      if (this._padTower(pI) !== -1) continue;
      var pd2 = MAP.pads[pI];
      var pdx = w.x - pd2.x, pdy = w.y - pd2.y;
      if (pdx * pdx + pdy * pdy < 34 * 34) { this.menu = { padIdx: pI }; return; }
    }

  };
  Game.prototype._padTower = function (padIdx) {
    for (var t = 0; t < this.towers.length; t++) if (this.towers[t].padIdx === padIdx) return t;
    return -1;
  };
  Game.prototype._sellValue = function (tw) {
    var tt = TOWER_TYPES[tw.type], spent = tt.cost;
    for (var l = 0; l < tw.level; l++) spent += tt.levels[l].upgradeCost;
    return Math.round(spent * CFG.sellRefund);
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
      else if (fx.k === 'boom') { this._burst(fx.x, fx.y, '#ff8a3c', 14, 110); this.shake = Math.min(1, this.shake + 0.25); }
      else if (fx.k === 'steal') { this._burst(fx.x, fx.y, '#ff5b5b', 12, 100); this.floats.push({ x: fx.x, y: fx.y, txt: '-' + fx.n + ' treasure!', c: '#ff7b7b', t: 1.4 }); this.shake = Math.min(1, this.shake + 0.45); }
      else if (fx.k === 'recover') { this._burst(fx.x, fx.y, '#9ef58f', 10, 90); this.floats.push({ x: fx.x, y: fx.y, txt: '+' + fx.n + ' recovered!', c: '#9ef58f', t: 1.4 }); this.fxQueue.push({ k: 'coinfly', x: fx.x, y: fx.y, tx: MAP.mound.x, ty: MAP.mound.y, n: Math.min(5, fx.n) }); }
      else if (fx.k === 'escape') { this.floats.push({ x: fx.x + 30, y: fx.y - 20, txt: 'stolen!', c: '#ff5b5b', t: 1.2 }); this.shake = Math.min(1, this.shake + 0.3); }
      else if (fx.k === 'breath') { this._burst(fx.x, fx.y, '#ff9a3c', 30, 140); this.shake = Math.min(1, this.shake + 0.35); }
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
    // heavy footfalls kick dust; laden thieves drip gold sparks (cosmetic scan)
    for (var ci = 0; ci < this.enemies.length; ci++) {
      var ce2 = this.enemies[ci];
      if (ce2.hp <= 0) continue;
      if (!ce2.flyer && (ce2.type === 'brute' || ce2.type === 'boss') && ce2.grabT <= 0 && Math.random() < dtRaw * 5) {
        this.particles.push({ kind: 'dot', x: ce2.px + (Math.random() - 0.5) * 10, y: ce2.py + 2, vx: (Math.random() - 0.5) * 30, vy: -10 - Math.random() * 18, r: 1.5 + Math.random() * 2, life: 0.3 + Math.random() * 0.2, T: 0.5, c: 'rgba(120,100,80,0.5)' });
      }
      if (ce2.fleeing && ce2.stolen > 0 && Math.random() < dtRaw * 7) {
        this.particles.push({ kind: 'dot', x: ce2.px, y: ce2.py - 8, vx: (Math.random() - 0.5) * 16, vy: 12 + Math.random() * 14, r: 1.2 + Math.random() * 1.4, life: 0.35, T: 0.35, c: '#ffd75e' });
      }
    }
    this.shake = Math.max(0, this.shake - dtRaw * 2.2);
    // music intensity follows the battle (cosmetic lane)
    Sfx.setMusicMode(this.state === 'playing' && this.waveActive ? 'battle' : 'calm');
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
    ctx.setTransform(v.dpr * v.scale, 0, 0, v.dpr * v.scale, 0, 0);
    ctx.fillStyle = '#17100e';
    ctx.fillRect(0, 0, v.w, v.h);
    // the bands are SCENERY, not dead space: the cavern painting covers the
    // whole viewport (cover-cropped), dimmed so the sim world reads brighter,
    // with a soft blend at the world's edges
    if (ART.images.bg) {
      var bimg2 = ART.images.bg;
      var bs2 = Math.max(v.w / bimg2.width, v.h / bimg2.height);
      var bw2 = bimg2.width * bs2, bh2 = bimg2.height * bs2;
      ctx.drawImage(bimg2, (v.w - bw2) / 2, (v.h - bh2) / 2, bw2, bh2);
      ctx.fillStyle = 'rgba(10,6,4,0.45)';
      ctx.fillRect(0, 0, v.w, v.h);
    }
    ctx.save();
    // cosmetic screenshake (lane 3 state, applied at render)
    var shx = this.shake > 0 ? (Math.random() - 0.5) * 8 * this.shake : 0;
    var shy = this.shake > 0 ? (Math.random() - 0.5) * 6 * this.shake : 0;
    ctx.translate(v.ox + shx, v.oy + shy);

    this._drawCavern(ctx);
    this._drawMoundAndKeep(ctx);   // mound + halo (keep sprite drawn AFTER the path)
    this._drawPath(ctx);
    this._drawKeep(ctx);          // the door arch overlaps the road's end
    this._drawPads(ctx);
    this._drawEntities(ctx);
    this._drawParticles(ctx);
    this._drawWorldHints(ctx);
    if (this.menu) this._drawMenus(ctx);
    if (this.state === 'menu') this._drawTitle(ctx);
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
      rec.y = MAP.pads[this.towers[i].padIdx].y; rec.kind = 'tower'; rec.ref = this.towers[i];
    }
    for (i = 0; i < this.enemies.length; i++) {
      var en = this.enemies[i];
      rec = slot(); n++;
      rec.y = en.py + (en.flyer ? 28 : 0); rec.kind = 'enemy'; rec.ref = en; rec.px = en.px; rec.py = en.py;
    }
    rec = slot(); n++;
    rec.y = this.hero.y; rec.kind = 'hero'; rec.ref = null;
    draws.length = n;
    draws.sort(byY);
    for (i = 0; i < n; i++) {
      var d = draws[i];
      if (d.kind === 'tower') this._drawTower(ctx, d.ref);
      else if (d.kind === 'enemy') this._drawEnemy(ctx, d.ref, { x: d.px, y: d.py });
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
      } else {
        var tdx = pr.dx || 1, tdy = pr.dy || 0;
        ctx.strokeStyle = 'rgba(232,217,184,0.35)'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(pr.x - tdx * 14, pr.y - tdy * 14); ctx.lineTo(pr.x, pr.y); ctx.stroke();
        ctx.strokeStyle = '#e8d9b8'; ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(pr.x - tdx * 5, pr.y - tdy * 5); ctx.lineTo(pr.x, pr.y); ctx.stroke();
      }
    }
  };

  Game.prototype._drawTower = function (ctx, tw) {
    var p = MAP.pads[tw.padIdx];
    var lvl = tw.level;
    var spriteId = 't_' + tw.type;
    // range ring while its menu is open
    if (this.menu && this.menu.towerIdx !== undefined && this.towers[this.menu.towerIdx] === tw) {
      var rr3 = TOWER_TYPES[tw.type].levels[lvl].range;
      ctx.fillStyle = 'rgba(255,215,94,0.10)';
      ctx.beginPath(); ctx.arc(p.x, p.y, rr3, 0, 6.283); ctx.fill();
      ctx.strokeStyle = 'rgba(255,215,94,0.45)'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(p.x, p.y, rr3, 0, 6.283); ctx.stroke();
    }
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.ellipse(p.x, p.y + 4, 22, 10, 0, 0, 6.283); ctx.fill();
    var timg = ART.images[spriteId];
    if (timg) {
      // recoil press-down right after firing + gentle idle breathing
      var tlv = TOWER_TYPES[tw.type].levels[lvl];
      var re = Math.max(0, Math.min(1, tw.cd * tlv.rate));
      var press = re > 0.7 ? (re - 0.7) / 0.3 : 0;
      var windup = (re > 0 && re < 0.18) ? (0.18 - re) / 0.18 : 0;   // pre-shot rise
      var tsq = 1 - 0.09 * press + windup * 0.05 + Math.sin(this.worldT * 3 + tw.padIdx) * 0.015;
      var tw0 = 54 * (1 + lvl * 0.12);
      var th0 = tw0 * (timg.height / timg.width);
      ctx.save();
      ctx.translate(p.x, p.y + 8);
      ctx.scale(2 - tsq, tsq);
      ctx.drawImage(timg, -tw0 / 2, -th0, tw0, th0);
      ctx.restore();
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
    }
  };

  Game.prototype._drawEnemy = function (ctx, e, p) {
    var base = ENEMY_TYPES[e.type];
    var bob = Math.sin(this.worldT * 9 + e.id * 1.3) * 2;
    var fy = e.flyer ? -26 + Math.sin(this.worldT * 4 + e.id) * 4 : 0;
    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath(); ctx.ellipse(p.x, p.y + 3, e.type === 'boss' ? 20 : 10, e.type === 'boss' ? 8 : 4.5, 0, 0, 6.283); ctx.fill();
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
      if (e.grabT > 0) squash = 1 + Math.sin(t * 26 + ph) * 0.12;     // digging!
      else if (e.flyer) squash = 1 + Math.sin(t * 16 + ph) * 0.06;    // wing-beat
      else squash = 1 + Math.abs(Math.sin(t * wsp + ph)) * (boss ? 0.05 : 0.08);
      if (e.flashT > 0) squash *= 1 + e.flashT * 0.9;                 // impact pop
      var hop = (moving && !e.flyer) ? -Math.abs(Math.sin(t * wsp + ph)) * (boss ? 1.5 : 2.5) * (hasFrames ? 0.75 : 1) : 0;
      var w0 = boss ? 62 : e.type === 'brute' ? 46 : 36;
      var hh2 = w0 * (img.height / img.width);
      ctx.save();
      ctx.translate(p.x, p.y + 6 + fy + hop);
      ctx.rotate(waddle);
      ctx.scale(flip * (2 - squash), squash);
      ctx.drawImage(img, -w0 / 2, -hh2, w0, hh2);
      if (e.flashT > 0) {                       // white-flash: re-draw lighter
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = Math.min(1, e.flashT * 9);
        ctx.drawImage(img, -w0 / 2, -hh2, w0, hh2);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.restore();
      if (e.fleeing) { // carrying OUR gold: warm loot glint underfoot
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
    // stolen coins over their head
    if (e.stolen > 0) {
      ctx.fillStyle = '#ffd75e';
      ctx.beginPath(); ctx.arc(p.x, p.y - 26 + fy, 5, 0, 6.283); ctx.fill();
      ctx.strokeStyle = '#8a5a1d'; ctx.lineWidth = 1; ctx.stroke();
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
    if (h.selected) {
      ctx.strokeStyle = 'rgba(158,245,143,0.8)'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.arc(h.x, h.y, 26, 0, 6.283); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(158,245,143,0.08)';
      ctx.beginPath(); ctx.arc(h.x, h.y, h.range, 0, 6.283); ctx.fill();
    }
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.beginPath(); ctx.ellipse(h.x, h.y + 3, 13, 5.5, 0, 0, 6.283); ctx.fill();
    var hdx2 = h.tx - h.x, hdy2 = h.ty - h.y;
    var hMoving2 = Math.abs(hdx2) + Math.abs(hdy2) > 3;
    var goingAway = hMoving2 && hdy2 < -Math.abs(hdx2) * 0.7;   // mostly up-screen
    var himg = (goingAway && ART.images.hero_back) ? ART.images.hero_back : ART.images.hero;
    if (himg) {
      // hover bob + sway; face the direction he's headed
      var ht = this.worldT;
      var hflip = (h.tx - h.x) > 0.5 ? -1 : 1;   // sprite faces left natively
      var hmoving = Math.abs(h.tx - h.x) + Math.abs(h.ty - h.y) > 3;
      var hsq = 1 + Math.sin(ht * (hmoving ? 9 : 5)) * (hmoving ? 0.05 : 0.035);
      var hw0 = 44, hh0 = hw0 * (himg.height / himg.width);
      ctx.save();
      ctx.translate(h.x, h.y + 5 + Math.sin(ht * (hmoving ? 8 : 4)) * (hmoving ? 2.2 : 1.5));
      ctx.rotate(Math.sin(ht * 3) * 0.04 + (hmoving ? -hflip * 0.07 : 0));
      ctx.scale(hflip * (2 - hsq), hsq);
      ctx.drawImage(himg, -hw0 / 2, -hh0, hw0, hh0);
      ctx.restore();
    }
    else {
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
    // breath meter
    if (h.breathCd > 0 && h.breathCd < 14) {
      ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fillRect(h.x - 12, h.y - 42, 24, 3);
      ctx.fillStyle = '#ff9a3c'; ctx.fillRect(h.x - 12, h.y - 42, 24 * (1 - h.breathCd / 14), 3);
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
    if (this.state === 'playing' && this.mode === 'campaign' && !Save.data.tut && !this.towers.length) {
      var tpulse = 0.6 + 0.4 * Math.sin(this.worldT * 5);
      var tp2 = MAP.pads[3];
      ctx.strokeStyle = 'rgba(158,245,143,' + tpulse + ')';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.ellipse(tp2.x, tp2.y, 32 + tpulse * 6, 20 + tpulse * 4, 0, 0, 6.283); ctx.stroke();
      ctx.fillStyle = 'rgba(16,10,7,0.8)';
      rr(ctx, tp2.x - 108, tp2.y - 64, 216, 30, 9); ctx.fill();
      ctx.fillStyle = '#9ef58f'; ctx.font = 'bold 14px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('Tap a stone ring to build a defender', tp2.x, tp2.y - 44);
      ctx.textAlign = 'left';
    }
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
    return {
      topY: topY, cx: cx,
      barX: Math.max(8, v.ox + 8),
      barW: Math.min(v.w - 16, WORLD_W - 16),
      btnY: topY + 7,
      mute: v.w / 2 + WORLD_W / 2 - 168, pause: v.w / 2 + WORLD_W / 2 - 112, spd: v.w / 2 + WORLD_W / 2 - 56,
      startY: v.h - Math.max(10, v.safeB + 6) - 56,
    };
  };

  Game.prototype._drawHudView = function (ctx) {
    var v = this.view, G = this._hudGeom();
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
    if (this.state === 'playing') {
      uiPanel(ctx, G.mute, G.btnY, 44, 34, 9);
      uiPanel(ctx, G.pause, G.btnY, 44, 34, 9);
      uiPanel(ctx, G.spd, G.btnY, 44, 34, 9);
      drawSpeaker(ctx, G.mute + 22, G.btnY + 17, Sfx.isMuted());
      ctx.fillStyle = '#ffe9c4';
      ctx.fillRect(G.pause + 14, G.btnY + 9, 5, 16); ctx.fillRect(G.pause + 25, G.btnY + 9, 5, 16);
      ctx.font = 'bold 16px system-ui, sans-serif';
      ctx.fillText(this.speed + 'x', G.spd + 10, G.btnY + 22);
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
      var py = by - 24;
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
    if (m.padIdx !== undefined) {
      var pad = MAP.pads[m.padIdx];
      for (var b = 0; b < TOWER_ORDER.length; b++) {
        var tid = TOWER_ORDER[b], tt = TOWER_TYPES[tid];
        var bp = this._menuBtnPos(pad, b, TOWER_ORDER.length);
        var afford = this.gold >= tt.cost;
        ctx.fillStyle = afford ? 'rgba(38,26,18,0.95)' : 'rgba(28,20,16,0.7)';
        ctx.beginPath(); ctx.arc(bp.x, bp.y, 22, 0, 6.283); ctx.fill();
        ctx.strokeStyle = afford ? '#ffd75e' : '#5c5147'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(bp.x, bp.y, 22, 0, 6.283); ctx.stroke();
        ctx.fillStyle = afford ? '#ffe9c4' : '#8a7f72';
        ctx.font = 'bold 10px system-ui, sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(tt.name.split(' ')[0], bp.x, bp.y - 2);
        ctx.fillStyle = afford ? '#ffd75e' : '#8a7f72';
        ctx.fillText(tt.cost + 'g', bp.x, bp.y + 10);
        ctx.textAlign = 'left';
      }
    } else if (m.towerIdx !== undefined) {
      var tw = this.towers[m.towerIdx];
      if (!tw) return;
      var pad2 = MAP.pads[tw.padIdx];
      var lvl = TOWER_TYPES[tw.type].levels[tw.level];
      var up = this._menuBtnPos(pad2, 0, 2), sell = this._menuBtnPos(pad2, 1, 2);
      var canUp = tw.level < 2, affordUp = canUp && this.gold >= lvl.upgradeCost;
      ctx.fillStyle = affordUp ? 'rgba(38,26,18,0.95)' : 'rgba(28,20,16,0.7)';
      ctx.beginPath(); ctx.arc(up.x, up.y, 22, 0, 6.283); ctx.fill();
      ctx.strokeStyle = affordUp ? '#9ef58f' : '#5c5147'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(up.x, up.y, 22, 0, 6.283); ctx.stroke();
      ctx.fillStyle = affordUp ? '#ffe9c4' : '#8a7f72';
      ctx.font = 'bold 10px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(canUp ? 'UP' : 'MAX', up.x, up.y - 2);
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

  Game.prototype._drawTitle = function (ctx) {
    ctx.fillStyle = 'rgba(12,7,5,0.66)';
    ctx.fillRect(-40, -40, WORLD_W + 80, WORLD_H + 80);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffd75e';
    ctx.font = 'bold 54px Georgia, serif';
    ctx.fillText('HOARDLING', WORLD_W / 2, 290);
    ctx.fillStyle = '#ff9a3c';
    ctx.font = 'italic 17px Georgia, serif';
    ctx.fillText('Keep the warm in.', WORLD_W / 2, 322);
    ctx.fillStyle = '#ffe9c4';
    ctx.font = '14px system-ui, sans-serif';
    ctx.fillText('Mother sleeps beneath the hoard, healing.', WORLD_W / 2, 356);
    ctx.fillText('The Guild has posted her gold on every job board.', WORLD_W / 2, 376);
    ctx.fillText('Hold the chokepoints, little Wick. Recover every coin.', WORLD_W / 2, 396);
    // campaign level buttons — locked levels grey out until the previous
    // keep is held (any stars)
    for (var li = 0; li < MAPS.length; li++) {
      var by = 414 + li * 60;
      var open = Save.unlocked(li);
      ctx.fillStyle = open ? '#d64545' : 'rgba(70,52,44,0.85)';
      rr(ctx, WORLD_W / 2 - 130, by, 260, 52, 13); ctx.fill();
      ctx.fillStyle = open ? '#fff' : '#8a7f72';
      ctx.font = 'bold 17px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText((li + 1) + '.  ' + MAPS[li].name, WORLD_W / 2 - 112, by + 32);
      ctx.textAlign = 'right';
      if (open) {
        var st = '';
        for (var si = 0; si < 3; si++) st += si < Save.data.stars[li] ? '★' : '☆';
        ctx.fillStyle = '#ffd75e'; ctx.font = '15px system-ui, sans-serif';
        ctx.fillText(st, WORLD_W / 2 + 114, by + 33);
      } else {
        ctx.fillStyle = '#8a7f72'; ctx.font = '16px system-ui, sans-serif';
        ctx.fillText('🔒', WORLD_W / 2 + 114, by + 34);
      }
      ctx.textAlign = 'center';
    }
    ctx.fillStyle = 'rgba(80,60,140,0.92)';
    rr(ctx, WORLD_W / 2 - 130, 596, 260, 52, 13); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 18px system-ui, sans-serif';
    ctx.fillText('DAILY SIEGE', WORLD_W / 2, 629);
    // ladder peek: the world-best run on the caption line (throttled cosmetic
    // fetch — render-lane IO, touches nothing in the sim)
    if (Lb.on() && (!this._lbTopT || Date.now() - this._lbTopT > 300000)) {
      this._lbTopT = Date.now();
      var self2 = this;
      Lb.top(1, function (rows) { self2._lbTop = (rows && rows[0]) || null; });
    }
    ctx.font = '12px system-ui, sans-serif'; ctx.fillStyle = '#c9b8ff';
    var dl = this._lbTop
      ? Lb.safeName(String(this._lbTop.display_name || '')) + ' holds wave ' + (this._lbTop.value | 0)
      : 'same siege + map for everyone today';
    if (Save.data.dailyBestWave > 0) dl += ' — your best: wave ' + Save.data.dailyBestWave;
    ctx.fillText(dl, WORLD_W / 2, 664);
    // sound toggle
    ctx.fillStyle = 'rgba(255,233,196,0.12)';
    rr(ctx, WORLD_W / 2 - 70, 676, 140, 36, 10); ctx.fill();
    drawSpeaker(ctx, WORLD_W / 2 - 46, 694, Sfx.isMuted());
    ctx.fillStyle = '#ffe9c4'; ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.fillText(Sfx.isMuted() ? 'SOUND OFF' : 'SOUND ON', WORLD_W / 2 + 12, 699);
    // Wick keeps watch from the corner
    var wimg = ART.images.hero;
    if (wimg) {
      var ww = 78, wh = ww * (wimg.height / wimg.width);
      var wb = Math.sin(this.worldT * 4) * 2;
      ctx.drawImage(wimg, WORLD_W - ww - 14, 766 - wh + wb, ww, wh);
    }
    ctx.textAlign = 'left';
  };

  Game.prototype._drawResult = function (ctx) {
    var r = this.result || {};
    ctx.fillStyle = 'rgba(12,7,5,0.75)';
    ctx.fillRect(-40, -40, WORLD_W + 80, WORLD_H + 80);
    ctx.textAlign = 'center';
    ctx.fillStyle = r.won ? '#9ef58f' : '#ff7b7b';
    ctx.font = 'bold 42px Georgia, serif';
    ctx.fillText(r.won ? 'HOARD HELD!' : 'HOARD LOST', WORLD_W / 2, 320);
    if (r.won) {
      ctx.font = '34px system-ui, sans-serif';
      var stars = '';
      for (var s = 0; s < 3; s++) stars += s < r.stars ? '★ ' : '☆ ';
      ctx.fillStyle = '#ffd75e';
      ctx.fillText(stars.trim(), WORLD_W / 2, 370);
    }
    ctx.fillStyle = '#ffe9c4'; ctx.font = '17px system-ui, sans-serif';
    ctx.fillText('treasure kept: ' + (r.hoard | 0) + ' / ' + CFG.startHoard, WORLD_W / 2, 420);
    ctx.fillText('coins carried off: ' + (r.lost | 0), WORLD_W / 2, 446);
    ctx.fillText('raiders slain: ' + (r.kills | 0), WORLD_W / 2, 472);
    if (this.mode === 'daily') ctx.fillText('waves survived: ' + (r.wave | 0), WORLD_W / 2, 498);
    // the story beat this whole game is for
    ctx.font = 'italic 15px Georgia, serif'; ctx.fillStyle = '#ff9a3c';
    if (r.won) {
      ctx.fillText('Auremma stirs, half-dreaming:', WORLD_W / 2, 528);
      ctx.fillText('“You kept the warm in, little one.”', WORLD_W / 2, 549);
    } else {
      ctx.fillText('The cavern grows colder.', WORLD_W / 2, 528);
      ctx.fillText('Wick will not let it happen twice.', WORLD_W / 2, 549);
    }
    // daily: the global best-runs ladder (names render through safeName ONLY)
    if (this.mode === 'daily' && Lb.on()) {
      ctx.fillStyle = '#ffd75e'; ctx.font = 'bold 14px system-ui, sans-serif';
      ctx.fillText('— GLOBAL BEST SIEGES —', WORLD_W / 2, 584);
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
        var rw = 84, rh = rw * (rimg.height / rimg.width);
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
  var game = new Game(canvas);
  window.addEventListener('resize', function () { game.resize(); });

  // Production exposes lifecycle pause only.
  window.__game = { pause: function (v) { game.setPaused(v); } };

  

})();
