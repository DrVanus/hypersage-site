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
      levels: [
        { dmg: 8,  rate: 1.0, range: 40, upgradeCost: 70 },
        { dmg: 14, rate: 1.1, range: 40, upgradeCost: 120 },
      ],
      forks: [
        { key: 'rend', name: 'Gearjaw', pitch: 'Grinding gears rend 4/s — armor can\'t shave it.',
          dmg: 22, rate: 1.2, range: 44, special: 'rend', rendDps: 4, rendDur: 2.5 },
        { key: 'coinback', name: 'Magnet Jaws', pitch: 'Bites shake stolen coins loose — they fly home.',
          dmg: 16, rate: 1.5, range: 48, special: 'coinback', coinCap: 2 },
      ],
    },
    ballista: {
      name: 'Kobold Crossbow', cost: 70, hitsAir: true,
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
  var TOWER_ORDER = ['crystal', 'ballista', 'mimic', 'perch', 'brazier']; // cheap -> dear
  var PAD_SNAP = 34;          // build within this of a free pad and you snap to it
  var PAD_DISCOUNT = 0.8;     // ...and it costs 20% less: the authored spots still matter

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
  };
  var TRIAL_ORDER = ['purse', 'picnic', 'greased'];

  var Save = (function () {
    var KEY2 = 'hoardling.save.v2', KEY1 = 'hoardling.save.v1';
    var data = { stars: [0, 0, 0], dailyBestWave: 0, tut: 0, daily: { day: 0, best: 0 }, forge: {}, seen: {}, trials: {} };
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
  };

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
  // Build stamp, published by build-web.py before this script runs. Art
  // filenames are stable forever, so WITHOUT this every cache in the chain
  // (proxy, WKWebView URLCache, PWA store) can serve the original bytes
  // indefinitely — the "it's all the old art" bug. New build => new URL.
  var BUILD = (typeof window !== 'undefined' && window.__BUILD__) || '';
  function assetURL(p) { return BUILD ? p + '?v=' + BUILD : p; }
  var ANIM = { meta: {}, images: {} };
  if (WALK_FRAMES && typeof window !== 'undefined' && window.fetch) {
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
        img.src = assetURL(self.manifest[id]);
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

  Game.prototype.reset = function (seed, mode, level, trialKey) {
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
    this.tar = [];                          // Tar Boiler slag patches {d,w,dps,until,tw}
    // cosmetic state must die with the run — a quit-to-title mid-battle must
    // not spray the LAST run's celebration into the next one (caught on film)
    this.particles = []; this.floats = []; this.fxQueue = []; this.shake = 0;
    this.nextId = 1;
    var hs = MAP.heroStart || { x: 210, y: 470 };
    this.hero = { x: hs.x, y: hs.y, tx: hs.x, ty: hs.y, range: 76, dmg: 9, rate: 1.25, cd: 0,
                  breathCd: 6, spd: 85, selected: false, castBreath: false,
                  manTid: -1, manned: false };   // manTid: stable tower id (survives splices)
    this.menu = null;                       // { padIdx } build menu | { towerIdx } manage menu
    this.shopPick = -1;                     // index into TOWER_ORDER while placing, else -1
    this.placeHint = null;                  // {x,y,ok,why} — the last previewed spot
    this.stolenLost = 0; this.kills = 0;
    this.breathUsed = false;                // Mother's Breath spends once per level
    this.motherReady = false; this.castMother = false;
    // Forge mods: CAMPAIGN ONLY — the Daily sim takes no input but the seed
    this.mods = (this.mode === 'campaign') ? Save.forgeMods() : {};   // {} for daily: LAW
    // Trial mutator: campaign-only by construction; forge power still applies
    this.trial = (this.mode === 'campaign' && trialKey && TRIALS[trialKey]) ? trialKey : null;
    if (this.trial) {
      var tm = TRIALS[this.trial].mods;
      if (tm.startGold) this.mods.startGold = (this.mods.startGold | 0) + tm.startGold;
      if (tm.sellRefund != null) this.mods.sellRefund = Math.max(this.mods.sellRefund || 0, tm.sellRefund);
      if (tm.bountyMul != null) this.mods.bountyMul = tm.bountyMul;   // 0 is meaningful — never || it
      if (tm.bannedTower) this.mods.bannedTower = tm.bannedTower;
      if (tm.fleeMul) this.mods.fleeMul = tm.fleeMul;
    }
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
          scaldT: 0, brittleT: 0, brittleMul: 1, deepT: 0, groundedT: 0, shaken: 0,
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
            scaldT: 0, brittleT: 0, brittleMul: 1, deepT: 0, groundedT: 0, shaken: 0,
            blinkT: 0, healT: 1, grabT: 0, auraF: 1,
            stolen: 0, fleeing: false, flyer: false, summoned: false, shieldBroken: false,
            flashT: 0, px: sp2.x, py: sp2.y,
          });
        }
        this.fxQueue.push({ k: 'float', x: bossE.px, y: bossE.py - 30, txt: 'ROAR!', c: '#ff7b7b' });
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
        // loot-weight rule: the more they carry, the slower they run.
        // Greased Boots multiplies the whole getaway leg (march-in untouched).
        var fleeMul = Math.max(CFG.fleeMin, CFG.fleeBase - CFG.fleeWeight * e.stolen) * (this.mods.fleeMul || 1);
        e.d -= v * fleeMul;
        if (e.d <= 0) {                                    // escaped with treasure
          this.stolenLost += e.stolen;
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
      // Time since this machine ACTUALLY fired. The recoil used to be driven
      // by the cooldown, but an idle machine rescans every 0.1s, which
      // retriggered the wind-up ~8x a second forever — every contraption on
      // the board vibrated even with nothing to shoot at.
      tw.shotT = (tw.shotT === undefined ? 9 : tw.shotT) + STEP;
      tw.cd -= STEP * (tw._manned ? 1.7 : tw._oc ? 1.25 : 1);
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
      var mDmg = (this.mods.dmgMul || 1) * (tw._manned ? 1.3 : 1), mRng = this.mods.rangeMul || 1;
      var target = this._pickTarget(pad, lv.range * mRng, tt.hitsAir, tt.airBonus, tw.targeting | 0);
      if (!target) { tw.cd = 0.1; continue; }   // miss: rescan at 6 Hz, not 60
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
    var inR = [];
    for (var e2 = 0; e2 < this.enemies.length; e2++) {
      var en2 = this.enemies[e2];
      if (en2.hp <= 0) continue;
      var ndx = en2.px - h.x, ndy = en2.py - h.y;
      if (ndx * ndx + ndy * ndy <= h.range * h.range) inR.push(en2);
    }
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
      this.menu = null;                     // no stale menu into the intermission
      this.wave++;
      this.fxQueue.push({ k: 'float', x: WORLD_W / 2, y: 300, txt: 'Wave ' + this.wave + ' held!', c: '#9ef58f' });
      if (this.wave >= this.totalWaves()) { this._gameOver(true); return; }
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
    this.menu = null; this.infoCard = null; // an open chooser/menu must not outlive the run
    this.resultLockT = 0.8;                 // battle taps can't skip the screen
    // stars grade COINS LOST FOREVER (escaped carriers), not the closing balance
    var stars = this.stolenLost <= 5 ? 3 : this.stolenLost <= 20 ? 2 : 1;
    this.result = { won: won, stars: stars, hoard: this.hoard, lost: this.stolenLost, kills: this.kills, wave: this.wave,
                    trial: this.trial ? TRIALS[this.trial].name : null };
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
      if (!this.waveActive && this.wave < this.totalWaves() &&
          vx >= G.cx - 92 && vx <= G.cx + 92 && vy >= G.startY && vy <= G.startY + 52) {
        this.startWave(); return;
      }
      if (vx >= G.breathX && vx <= G.breathX + 62 && vy >= G.breathY && vy <= G.breathY + 62) {
        this.hero.castBreath = true; return;         // the breath's own button
      }
      // THE SHOP: pick a machine, then tap the cavern to place it
      if (vy >= G.shopY && vy <= G.shopY + 54) {
        for (var sc = 0; sc < TOWER_ORDER.length; sc++) {
          var sxp = G.shopX + sc * G.shopStep;
          if (vx >= sxp && vx <= sxp + G.shopW) {
            this.shopPick = this.shopPick === sc ? -1 : sc;
            this.placeHint = null;
            Sfx.play('place');
            return;
          }
        }
        if (this.shopPick >= 0) { this.shopPick = -1; this.placeHint = null; return; }
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
      if (w.y > 686 && w.y < 722) {
        if (w.x > WORLD_W / 2 - 186 && w.x < WORLD_W / 2 - 70) { this.state = 'forge'; return; }
        if (w.x > WORLD_W / 2 - 58 && w.x < WORLD_W / 2 + 58) {
          if (Save.starsTotal() > 0) this.state = 'trials';
          return;
        }
        if (w.x > WORLD_W / 2 + 70 && w.x < WORLD_W / 2 + 186) { Sfx.toggle(); return; }
      }
      return;
    }
    if (this.state === 'trials') {
      for (var tr = 0; tr < TRIAL_ORDER.length; tr++) {
        var try2 = 250 + tr * 108;
        if (w.y > try2 && w.y < try2 + 96) {
          for (var tlv = 0; tlv < MAPS.length; tlv++) {
            var chx = WORLD_W - 168 + tlv * 46;
            if (w.x > chx && w.x < chx + 40 && w.y > try2 + 50 && w.y < try2 + 88) {
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
    // (the fork chooser was already handled modally above, before the HUD)
    if (this.menu) {
      var m = this.menu;
      if (m.towerIdx !== undefined) {                 // manage menu — nearest-wins
        var tw = this.towers[m.towerIdx];
        if (tw) {
          var pad2 = tw;
          var btns = [this._menuBtnPos(pad2, 0, 4), this._menuBtnPos(pad2, 1, 4),
                      this._menuBtnPos(pad2, 2, 4), this._menuBtnPos(pad2, 3, 4)];
          var lvl = lvlRow(tw);
          var bi2 = -1, bd2 = 24 * 24;
          for (var mb2 = 0; mb2 < 4; mb2++) {
            var mdx = w.x - btns[mb2].x, mdy = w.y - btns[mb2].y, mdd = mdx * mdx + mdy * mdy;
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
            } else if (bi2 === 1) {                          // cycle aim mode (menu stays open)
              tw.targeting = ((tw.targeting | 0) + 1) % 3;
              Sfx.play('place');
            } else if (bi2 === 2) {                          // MAN / LEAVE the machine
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
      var stid = TOWER_ORDER[this.shopPick];
      var chk = this._placeCheck(w.x, w.y);
      if (!chk.ok) {
        this.fxQueue.push({ k: 'float', x: w.x, y: w.y - 18, txt: chk.why, c: '#ff9a9a' });
        return;                                   // stay armed: let them try again
      }
      var cost = Math.round(TOWER_TYPES[stid].cost * (chk.discount ? PAD_DISCOUNT : 1));
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
    var pad = tw;
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
    this._drawMouthAlarm(ctx);    // escape pressure, UNDER the entities
    this._drawTar(ctx);           // slag sits ON the road, under everyone
    this._drawKeep(ctx);          // the door arch overlaps the road's end
    this._drawPads(ctx);
    this._drawEntities(ctx);
    this._drawParticles(ctx);
    this._drawWorldHints(ctx);
    if (this.menu) this._drawMenus(ctx);
    if (this.state === 'menu') this._drawTitle(ctx);
    if (this.state === 'forge') this._drawForge(ctx);
    if (this.state === 'trials') this._drawTrials(ctx);
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
    var spriteId = 't_' + tw.type;
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
      ctx.save();
      ctx.translate(p.x, p.y + 8);
      ctx.scale(2 - tsq, tsq);
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
    var himg = (goingAway && ART.images.hero_back) ? ART.images.hero_back : ART.images.hero;
    if (himg) {
      // hover bob + sway; face the direction he's headed
      var ht = this.worldT;
      var hflip = (h.tx - h.x) > 0.5 ? -1 : 1;   // sprite faces left natively
      var hmoving = Math.abs(h.tx - h.x) + Math.abs(h.ty - h.y) > 3;
      var hsq = 1 + Math.sin(ht * (hmoving ? 9 : 5)) * (hmoving ? 0.05 : 0.035);
      var hw0 = 44, hh0 = hw0 * (himg.height / himg.width);
      ctx.save();
      ctx.translate(h.x, h.y + 5 - lift + Math.sin(ht * (hmoving ? 8 : 4)) * (hmoving ? 2.2 : 1.5));
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
    // charged: a pulsing flame ring says TAP ME
    if (h.breathCd <= 0 && this.state === 'playing') {
      var rp = 0.6 + 0.4 * Math.sin(this.worldT * 6);
      ctx.strokeStyle = 'rgba(255,154,60,' + rp + ')';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(h.x, h.y - 14, 24 + rp * 4, 0, 6.283); ctx.stroke();
      ctx.fillStyle = 'rgba(255,207,106,' + (0.7 + rp * 0.3) + ')';
      ctx.beginPath(); ctx.ellipse(h.x, h.y - 46, 4, 7 + rp * 2, 0, 0, 6.283); ctx.fill();
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
      // Wick's breath lives on its own button. It used to fire when you tapped
      // HIM, which ate the tap that was supposed to pick him up and move him.
      breathX: v.w / 2 - WORLD_W / 2 + 10,
      breathY: v.h - Math.max(10, v.safeB + 6) - 58,
      shopY: v.h - Math.max(10, v.safeB + 6) - 122,
      shopX: v.w / 2 - WORLD_W / 2 + 12,
      shopW: 72, shopStep: 79,
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
    if (this.trial) {   // which trial this run is — always visible, never loud
      ctx.fillStyle = 'rgba(168,230,255,0.85)'; ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.fillText('TRIAL: ' + TRIALS[this.trial].name.toUpperCase(), lx + 27, G.topY + 50);
    }
    if (this.state === 'playing') {
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
      ctx.strokeStyle = 'rgba(255,150,60,' + bpul + ')'; ctx.lineWidth = bReady ? 3 : 1.5;
      ctx.beginPath(); ctx.arc(bcx, bcy, 28, 0, 6.283); ctx.stroke();
      ctx.textAlign = 'center';
      ctx.fillStyle = bReady ? '#ffcf6a' : '#8a7f72';
      ctx.font = 'bold 20px system-ui, sans-serif';
      ctx.fillText('🔥', bcx, bcy + 3);
      ctx.font = 'bold 9px system-ui, sans-serif';
      ctx.fillText(bReady ? 'BREATH' : Math.ceil(this.hero.breathCd) + 's', bcx, bcy + 19);
      ctx.textAlign = 'left';
      // THE SHOP — pick a machine, then tap the cavern floor to place it
      for (var sc2 = 0; sc2 < TOWER_ORDER.length; sc2++) {
        var sid2 = TOWER_ORDER[sc2], stt = TOWER_TYPES[sid2];
        var sxx = G.shopX + sc2 * G.shopStep, syy = G.shopY;
        var picked = this.shopPick === sc2;
        var can = this.gold >= Math.round(stt.cost * PAD_DISCOUNT);
        ctx.fillStyle = picked ? 'rgba(96,66,22,0.97)' : can ? 'rgba(30,22,16,0.92)' : 'rgba(24,18,15,0.8)';
        rr(ctx, sxx, syy, G.shopW, 54, 10); ctx.fill();
        ctx.strokeStyle = picked ? '#ffd75e' : can ? 'rgba(255,215,94,0.45)' : 'rgba(120,105,90,0.35)';
        ctx.lineWidth = picked ? 2.5 : 1.3;
        rr(ctx, sxx, syy, G.shopW, 54, 10); ctx.stroke();
        var sIm = ART.images['t_' + sid2];
        if (sIm) {
          var siw = 34, sih = siw * (sIm.height / sIm.width);
          ctx.globalAlpha = can ? 1 : 0.42;
          ctx.drawImage(sIm, sxx + G.shopW / 2 - siw / 2, syy + 26 - sih, siw, sih);
          ctx.globalAlpha = 1;
        }
        ctx.textAlign = 'center';
        ctx.fillStyle = can ? '#ffd75e' : '#8a7f72';
        ctx.font = 'bold 11px system-ui, sans-serif';
        ctx.fillText(stt.cost + 'g', sxx + G.shopW / 2, syy + 46);
        ctx.textAlign = 'left';
      }
      if (this.shopPick >= 0) {
        ctx.textAlign = 'center';
        ctx.fillStyle = '#ffe9c4'; ctx.font = 'bold 12px system-ui, sans-serif';
        ctx.fillText('tap the cavern floor to build  ·  pads cost 20% less',
                     G.cx, G.shopY - 8);
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
      var py = G.shopY - 30;   // ABOVE the shop bar, not on top of its chips
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
      var up = this._menuBtnPos(pad2, 0, 4), aim = this._menuBtnPos(pad2, 1, 4),
          man = this._menuBtnPos(pad2, 2, 4), sell = this._menuBtnPos(pad2, 3, 4);
      var isManned = this.hero.manTid === tw.tid;
      ctx.fillStyle = isManned ? 'rgba(70,52,20,0.97)' : 'rgba(38,26,18,0.95)';
      ctx.beginPath(); ctx.arc(man.x, man.y, 22, 0, 6.283); ctx.fill();
      ctx.strokeStyle = '#ffcf6a'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(man.x, man.y, 22, 0, 6.283); ctx.stroke();
      ctx.fillStyle = '#ffe9c4'; ctx.font = 'bold 9px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(isManned ? 'LEAVE' : 'MAN IT', man.x, man.y - 2);
      ctx.fillStyle = '#ffcf6a';
      ctx.fillText(isManned ? '' : '+70%', man.x, man.y + 10);
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(38,26,18,0.95)';
      ctx.beginPath(); ctx.arc(aim.x, aim.y, 22, 0, 6.283); ctx.fill();
      ctx.strokeStyle = '#a8e6ff'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(aim.x, aim.y, 22, 0, 6.283); ctx.stroke();
      ctx.fillStyle = '#ffe9c4'; ctx.font = 'bold 9px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('AIM', aim.x, aim.y - 3);
      ctx.fillStyle = '#a8e6ff';
      ctx.fillText(AIM_MODES[tw.targeting | 0], aim.x, aim.y + 9);
      ctx.textAlign = 'left';
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

  Game.prototype._drawTitle = function (ctx) {
    ctx.fillStyle = 'rgba(12,7,5,0.66)';
    ctx.fillRect(-40, -40, WORLD_W + 80, WORLD_H + 80);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#ffd75e';
    ctx.font = 'bold 54px Georgia, serif';
    ctx.fillText('HOARDLING', WORLD_W / 2, 290);
    ctx.fillStyle = '#ff9a3c';
    ctx.font = 'italic 17px Georgia, serif';
    ctx.fillText('Too young for dragonfire. Built his own.', WORLD_W / 2, 322);
    ctx.fillStyle = '#ffe9c4';
    ctx.font = '14px system-ui, sans-serif';
    ctx.fillText('A dragon too young for dragonfire —', WORLD_W / 2, 356);
    ctx.fillText('so he built his own.', WORLD_W / 2, 376);
    ctx.fillText('Guard the gold. Overclock the machines. Recover every coin.', WORLD_W / 2, 396);
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
    var todaysMap = MAPS[dailySeed() % MAPS.length].name;
    var todayBest = (Save.data.daily.day === dayNumber()) ? Save.data.daily.best : 0;
    var dl = 'today: ' + todaysMap + (todayBest ? ' — your best wave ' + todayBest : '');
    ctx.fillText(dl, WORLD_W / 2, 660);
    var dl2 = this._lbTop
      ? 'all-time: ' + Lb.safeName(String(this._lbTop.display_name || '')) + ' holds wave ' + (this._lbTop.value | 0)
      : (Save.data.dailyBestWave > 0 ? 'your all-time best: wave ' + Save.data.dailyBestWave : '');
    if (dl2) { ctx.fillStyle = 'rgba(201,184,255,0.75)'; ctx.fillText(dl2, WORLD_W / 2, 675); }
    // FORGE | TRIALS | SOUND row
    var fAvail = Save.starsTotal() - Save.forgeSpent();
    var anyWon = Save.starsTotal() > 0;
    ctx.font = 'bold 12px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,215,94,0.16)';
    rr(ctx, WORLD_W / 2 - 186, 686, 116, 36, 10); ctx.fill();
    ctx.strokeStyle = fAvail > 0 ? '#ffd75e' : 'rgba(255,215,94,0.3)'; ctx.lineWidth = 1.5;
    rr(ctx, WORLD_W / 2 - 186, 686, 116, 36, 10); ctx.stroke();
    ctx.fillStyle = '#ffe9c4';
    ctx.fillText('FORGE' + (fAvail > 0 ? ' (' + fAvail + '★)' : ''), WORLD_W / 2 - 128, 709);
    var tDone = 0;
    for (var tb = 0; tb < 3; tb++) { var tRow = Save.data.trials[tb] || {}; for (var tbk in tRow) tDone++; }
    ctx.fillStyle = anyWon ? 'rgba(168,230,255,0.14)' : 'rgba(255,233,196,0.06)';
    rr(ctx, WORLD_W / 2 - 58, 686, 116, 36, 10); ctx.fill();
    ctx.strokeStyle = anyWon ? 'rgba(168,230,255,0.6)' : 'rgba(255,233,196,0.15)';
    rr(ctx, WORLD_W / 2 - 58, 686, 116, 36, 10); ctx.stroke();
    ctx.fillStyle = anyWon ? '#d9f2ff' : '#8a7f72';
    ctx.fillText(anyWon ? 'TRIALS ' + tDone + '/9' : 'TRIALS', WORLD_W / 2, 709);
    ctx.fillStyle = 'rgba(255,233,196,0.12)';
    rr(ctx, WORLD_W / 2 + 70, 686, 116, 36, 10); ctx.fill();
    drawSpeaker(ctx, WORLD_W / 2 + 92, 704, Sfx.isMuted());
    ctx.fillStyle = '#ffe9c4';
    ctx.fillText(Sfx.isMuted() ? 'OFF' : 'ON', WORLD_W / 2 + 140, 709);
    // Wick keeps watch from the corner (title pose when we have it)
    var wimg = ART.images.hero_title || ART.images.hero;
    if (wimg) {
      var ww = 78, wh = ww * (wimg.height / wimg.width);
      var wb = Math.sin(this.worldT * 4) * 2;
      ctx.drawImage(wimg, WORLD_W - ww - 14, 766 - wh + wb, ww, wh);
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
    ctx.fillStyle = '#fff2d8'; ctx.font = 'bold 17px Georgia, serif';
    ctx.fillText('★ ' + avail + ' to spend', WORLD_W / 2, 228);
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
      var key = TRIAL_ORDER[i], tr = TRIALS[key], ry = 250 + i * 108;
      uiPanel(ctx, 26, ry, WORLD_W - 52, 96, 11);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#d9f2ff'; ctx.font = 'bold 15px system-ui, sans-serif';
      ctx.fillText(tr.name, 42, ry + 24);
      ctx.fillStyle = '#b9a27f'; ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(tr.pitch, 42, ry + 42);
      for (var lv2 = 0; lv2 < MAPS.length; lv2++) {
        var chx = WORLD_W - 168 + lv2 * 46;
        var wonLv = Save.data.stars[lv2] > 0;
        var badge = wonLv && Save.data.trials[lv2] && Save.data.trials[lv2][key];
        ctx.fillStyle = badge ? 'rgba(255,215,94,0.9)' : wonLv ? 'rgba(214,69,69,0.85)' : 'rgba(70,52,44,0.6)';
        rr(ctx, chx, ry + 50, 40, 38, 8); ctx.fill();
        ctx.fillStyle = badge ? '#3a2c14' : wonLv ? '#fff' : '#8a7f72';
        ctx.font = 'bold 12px system-ui, sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(badge ? '★' : 'L' + (lv2 + 1), chx + 20, ry + 73);
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
    ctx.fillText(r.won ? 'HOARD HELD!' : 'HOARD LOST', WORLD_W / 2, 320);
    if (r.trial) {
      ctx.font = 'bold 15px system-ui, sans-serif';
      ctx.fillStyle = '#a8e6ff';
      ctx.fillText(r.won ? 'TRIAL COMPLETE — ' + r.trial + ' ★' : 'TRIAL: ' + r.trial, WORLD_W / 2, 345);
    }
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
