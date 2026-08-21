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
      name: 'Latch Mimic', cost: 80,
      short: 'MIMIC', hitsAir: false,
      mount: { dx:  13, up: 40 },
      blurb: 'Hard bite, short reach. Ground only.',
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
      name: 'Kobold Crossbow', cost: 70,
      short: 'CROSSBOW', hitsAir: true,
      mount: { dx:  16, up: 24 },
      blurb: 'Fast bolts, long reach. Hits flyers.',
      aims: true,
      // The crossbow assembly and its gunner sit ON a round wooden turntable.
      // Split there so only the TOP turns: rotating the whole plate tipped the
      // barrel and made every machine look like it was falling over.
      turret: { cut: 0.68, pvx: 0.50, pvy: 0.66 },
      // NATIVE FACING, measured off the plate: the bolt's iron head sits at
      // ~0.60 of the width with the fletching lower-LEFT, so this machine is
      // painted aiming up-RIGHT. Every other aiming plate (gargoyle snout,
      // mimic maw) is painted facing LEFT, and the drawer assumed left for all
      // of them — so the crossbow, the machine on screen most, was mirrored
      // exactly backwards and fired out of the BACK of its own bow. The engine
      // already solved this on the other lane with ENEMY_FACING; towers never
      // got the table.
      face: 1,
      muzzle: { fwd: 7, up: 52 },    // measured to the bolt head at (0.60w, 0.12h)
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
      name: 'Soot Brazier', cost: 100,
      // the flared mouth. The sprite went 54x64 -> 54x74 when the closed pot
      // became an open-topped boiler, so the mouth moved up with it.
      muzzle: { fwd: 0, up: 48 },    // it lobs straight up, so no side offset
      short: 'BRAZIER', hitsAir: false,
      mount: { dx: -20, up: 18 },
      blurb: 'Lobs fire — splashes a crowd. Ground only.',
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
      name: 'Gemsinger', cost: 50,
      short: 'GEMSINGER', hitsAir: true,
      mount: { dx: -20, up: 14 },
      blurb: 'Chills raiders slow. Hits flyers. Low damage.',
      levels: [
        { dmg: 3, rate: 1.0, range: 92,  slow: 0.30, slowDur: 1.5, upgradeCost: 50 },
        { dmg: 5, rate: 1.1, range: 105, slow: 0.40, slowDur: 2.0, upgradeCost: 90 },
      ],
      forks: [
        // PITCH REWRITTEN TO WHAT IS TRUE. It used to read "no blinking, deaf
        // to the war drum" -- but blink is gated on `e.slowT <= 0`, so ANY
        // Gemsinger at ANY level already hard-counters the Blinker, and a 50g
        // L1 was selling a 190g fork's headline feature. Boss-aura immunity
        // (deepT) is the one thing only this fork does.
        { key: 'deepchill', name: 'Deepchill Coil', pitch: 'Deep chill: the war drum cannot reach them.',
          dmg: 8, rate: 1.2, range: 118, slow: 0.55, slowDur: 2.5, special: 'deepchill' },
        { key: 'resonance', name: 'Tuning Fork', pitch: 'Chilled foes ring brittle — all hits do +25%.',
          dmg: 6, rate: 1.2, range: 118, slow: 0.40, slowDur: 2.0, special: 'resonance', brittleMul: 1.25 },
      ],
    },
    perch: {
      name: 'Gargoyle Roost', cost: 90,
      short: 'ROOST', hitsAir: true, airBonus: 1.5,
      mount: { dx: -25, up: 34 },
      // "pierces 2. Best vs flyers" put two true clauses side by side and
      // implied a third that is FALSE: _nextBehind (game.js, the only source of
      // pierce hops) skips flyers outright, so against a flock of Gloomwings a
      // Roost's pierce 2/3/6 does literally nothing. It is a single-target
      // sniper up there, carried by airBonus, not by pierce.
      blurb: 'Longest reach. Best vs air. Ground pierce only.',
      aims: true,
      turret: { cut: 0.46, pvx: 0.50, pvy: 0.46 },   // gargoyle turns, plinth does not
      muzzle: { fwd: 15, up: 63 },   // measured to the gargoyle's snout (0.22w, 0.21h)
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
      name: 'Bellows Post', cost: 120,
      short: 'BELLOWS', hitsAir: false, support: true,
      mount: { dx: 18, up: 16 },
      blurb: 'NOT A WEAPON — machines near it fire +15%.',
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
    // ANTI-AIR AoE — the ONE measured coverage hole in the roster. Nothing else
    // does area damage to flyers: the Soot Brazier is hitsAir:false AND its
    // splash loop skips flyers outright, pierce can never chain to a flyer
    // (_nextBehind excludes them), and the only air-capable radial tick is the
    // Gemsinger at 9.6 dps. Measured demand on the worst wave (L3 w15, sixteen
    // Gloomwings under a 2.92x ramp) is ~216 sustained anti-air dps against a
    // best-single-machine 68.4.
    //
    // Engine shape is a CLONE of the crystal branch: targetless radial tick, no
    // _pickTarget, no projectile, no muzzle. Like that branch it carries no
    // eFly test, so it cuts ground and air alike. Both specials are counters and
    // flags -- zero rolls -- so the determinism surface does not grow.
    //
    // It does NOT solve the hole alone, and that was checked: radius 74 from a
    // pad 50 units off the road covers a chord of 2*sqrt(74^2-50^2) = 109 path
    // units; Gloomwings at gap 0.65 and speed 59 sit 38 apart, so ~2.8 are in
    // the ring -> ~141 air dps against that 216. PLACEMENT is the dial.
    rotor: {
      name: 'Whirlyjack', cost: 110,
      short: 'ROTOR', hitsAir: true,
      blurb: 'Spinning blades cut a whole ring. Hits flyers.',
      mount: { dx: -18, up: 30 },
      levels: [
        { dmg: 10, rate: 1.00, range: 56, upgradeCost: 100 },
        { dmg: 16, rate: 1.15, range: 64, upgradeCost: 120 },
      ],
      forks: [
        { key: 'updraft', name: 'Updraft Rotor', pitch: 'The wash flips couriers — flyers take 75% more.',
          dmg: 22, rate: 1.2, range: 74, special: 'updraft', airMul: 1.75 },
        { key: 'thresh', name: 'Threshing Rotor', pitch: 'Every 4th sweep shoves the ring back down the road.',
          dmg: 20, rate: 1.4, range: 74, special: 'thresh', threshEvery: 4, threshPush: 26 },
      ],
    },
    // ECONOMY — the Banana-Farm role from the game VANUS likes. Pays at the
    // END of a wave, so it is a bet on surviving long enough to collect.
    press: {
      name: 'Coin Press', cost: 140,
      short: 'PRESS', hitsAir: false, support: true,
      mount: { dx:  15, up: 26 },
      blurb: 'NOT A WEAPON — mints 26g when a wave ends.',
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
  // WHERE WICK SITS WHEN HE MANS A MACHINE, and how big he is when he does.
  //
  // This replaces seven COMBINED "manned plates" (tower_*_manned.png) that
  // painted Wick into the machine sprite. They were generated one at a time
  // with no size law between them, so his scale was different on every single
  // one -- tiny on the crossbow, brazier, bellows and press; oversized on the
  // mimic, perch and crystal -- and the machine underneath was repainted by
  // 20-59% of its pixels, so it visibly morphed the instant he climbed on.
  // Owner, on the phone: "when the dragon mans stuff it looks weird and dragon
  // gets much smaller".
  //
  // Drawing his OWN sprite at ONE scale on a per-machine mount fixes all of it
  // by construction: one Wick, always the same size, the machine never changes,
  // and a machine added later needs a two-number mount rather than a generated
  // plate. It also drops 289 KB -- about a fifth of the whole art payload -- off
  // a cold load that the boot work fought to get to 1.4 MB.
  //
  // `up` and `dx` are in DRAWN units at level 0 (tw0 = 54 wide); the drawer
  // scales them with the machine so a level-3 plate does not leave him behind.
  // 0.86 -> 0.8694 -> 0.8788 as the manned trio was repacked, first to fit
  // wing frames that are no longer clipped. Same rule as HERO_H: this is a
  // fraction of the CANVAS, so admitting more canvas shrinks the drawn body
  // unless it is carried through.
  var MAN_SCALE = 0.8788;     // perched and working, not standing on the furniture
  var TOWER_ORDER = ['crystal', 'ballista', 'mimic', 'perch', 'rotor', 'brazier', 'bellows', 'press']; // cheap -> dear

  // MACHINE UNLOCKS — campaign stars needed before a machine appears on the
  // shelf. Every one of the seven used to be affordable on wave 0 of level 1
  // (the dearest costs 112 on a pad against 120 starting gold), so the game
  // handed over its entire vocabulary in the first minute and had no new toy
  // to give for the remaining fifty-nine waves. A drip is the progression.
  //
  // KEYED ON STARS, NOT ON LEVEL, so the Forge and the campaign share one
  // currency and a player who three-stars level 1 is rewarded with a machine
  // rather than only with Forge points.
  // slot 3 was free between perch(1)/brazier(2) and bellows(4): the anti-air
  // answer should arrive BEFORE the flyer-heavy back half, not after it.
  var MACHINE_UNLOCK = { crystal: 0, ballista: 0, mimic: 0, perch: 1, brazier: 2, rotor: 3, bellows: 4, press: 6 };

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
  // How long Wick's breath PERFORMS: the open jaw, the head recoil and the
  // drawn jet all ease on this. It was written as a literal in the setter and
  // divided by a SECOND literal in the drawer, so lengthening the beat in one
  // place would have quietly broken the easing in the other.
  var BREATH_BEAT = 0.60;
  // THE ORDINARY SHOT OPENS HIS MOUTH TOO. Breath got a real open-jaw frame and
  // his normal fireball did not, so the attack he uses every 0.8s all game was
  // the one where nothing on his face moved -- VANUS: "the normal fireball
  // attack, there's nothing for it, it doesn't even open his mouth". Same plate,
  // a much shorter beat: a spit, not a roar. No jet is drawn for it (the
  // fireball IS the payload) and the existing muzzle puff already leaves his
  // jaws, so this only has to hold the mouth open long enough to read.
  var SPIT_BEAT = 0.20;
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
    // MEASURED INERT AT THE OLD MAGNITUDE. Four different settings of this
    // returned byte-identical bot results, because a board that blankets the
    // road kills a 2x raider as dead as a 1x one -- the lever only moves boards
    // already on the edge. It becomes a real lever at roughly twice this, which
    // is what these are. from 8 -> 4 because 120 starting gold buys ONE machine:
    // waves 1-3 must stay free while the player learns the shop, and 4-7 are
    // where a second machine should start to matter and today are flat.
    // CAMPAIGN ONLY -- the Daily and the Duel take dailyHpMul, so the shared
    // fight and the leaderboard are untouched.
    // L1 is 0.16 and not 0.18 because the discrimination there is a CLIFF, not
    // a slope: measured, at <=0.16 a careless 8-crossbow board scrapes a win
    // losing 55 of 60 coins (a 1-star it deserves) and a 6-machine board
    // 3-stars; at 0.18 that careless board LOSES at wave 19 of 20. There is
    // no setting that both lets a beginner finish and makes 6 machines work
    // for it. Level one is the teacher -- HANDOFF's own line is that the
    // first keep stays forgiving and the Coldroot Stair is where the same
    // mistake costs the hoard -- so L1 takes the forgiving side of the cliff
    // and L2/L3 do the discriminating.
    campRampByLevel: [0.16, 0.26, 0.48],
    campRampFrom: 4,
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
    splitter: { name: 'Hogshead',       hp: 130,  spd: 33, bounty: 14,  steals: 3,  flyer: false,
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
    { // Arena A — "The Twin Throats": two cave mouths, ONE shared climb.
      // The first map in the game with more than one road. The two throats run
      // up the outer walls and MERGE at (210,410), so the top third is ground
      // both raiding columns must cross: 7 of its 10 pads reach both roads and
      // 3 reach only one. That makes the merge the premium real estate and the
      // outer mouths the thing you neglect at your peril -- a chokepoint map.
      // Pads and torches were placed by tools/author_arena.py against the
      // engine's own _placeCheck rules, not by eye; the level-1 comments record
      // what placing them by eye cost (two pads shipped under the shop shelf).
      name: 'The Twin Throats',
      keep: { x: 175, y: 200 },
      mound: { x: 180, y: 248, rx: 118, ry: 46 },
      paths: [
        [[46, 752], [74, 682], [44, 614], [102, 560], [150, 520], [176, 470], [196, 442],
         [210, 410], [150, 382], [104, 326], [124, 266], [176, 232]],
        [[376, 752], [348, 682], [378, 614], [320, 560], [272, 520], [246, 470], [226, 442],
         [210, 410], [150, 382], [104, 326], [124, 266], [176, 232]],
      ],
      pads: [
        { x: 152, y: 434 }, { x: 212, y: 482 }, { x: 152, y: 302 }, { x: 260, y: 428 },
        { x: 296, y: 494 }, { x: 314, y: 602 }, { x: 200, y: 368 }, { x: 92, y: 254 },
        { x: 80, y: 356 }, { x: 122, y: 500 },
      ],
      torches: [[266, 596], [266, 380], [290, 710], [170, 308], [86, 494], [344, 500]],
      heroStart: { x: 212, y: 716 },
      pathW: 34,
    },
    { // Arena B — "The Sunder": two cave mouths and NO shared ground.
      // The opposite problem to the Twin Throats, deliberately. The roads only
      // meet at the hoard itself, so 9 of its 10 pads cover exactly one road
      // and only one covers both: there is no chokepoint to solve the map with
      // and you have to fund two fronts at once. Wick's own reach is the only
      // thing that can be in both places, which is the point.
      name: 'The Sunder',
      keep: { x: 175, y: 200 },
      mound: { x: 180, y: 248, rx: 118, ry: 46 },
      paths: [
        [[40, 748], [46, 660], [92, 600], [70, 528], [110, 462], [92, 392], [124, 320], [128, 262], [176, 232]],
        [[384, 748], [372, 656], [326, 596], [352, 524], [310, 460], [330, 390], [286, 318], [248, 262], [176, 232]],
      ],
      pads: [
        { x: 164, y: 296 }, { x: 92, y: 308 }, { x: 68, y: 464 }, { x: 350, y: 440 },
        { x: 302, y: 518 }, { x: 374, y: 566 }, { x: 110, y: 536 }, { x: 44, y: 578 },
        { x: 134, y: 374 }, { x: 284, y: 374 },
      ],
      torches: [[254, 488], [320, 722], [26, 476], [368, 326], [146, 524], [38, 356]],
      heroStart: { x: 212, y: 716 },
      pathW: 34,
    },
    { // Arena C — "The Split Cavern": ONE cave, TWO hoards, a road each.
      //
      // THE DUEL FORMAT. VANUS: "the same map but it's not the same map that
      // I'm on with two different rows and we're both on the same map
      // together". The earlier duel gave each side its own COPY of a board and
      // showed the opponent in an inset -- the Bloons Battles shape -- and it
      // was not what he was describing. This is: one cavern, split down the
      // middle, your keep on the left and the rival's on the right, one road
      // each, both of you on screen at the same time. No inset, because the
      // other dragon is simply THERE.
      //
      // FAIRNESS IS GEOMETRIC, not a number: the two roads are mirror images
      // measured to the same arc length (615 each), the ten pads are exact
      // twins at 420 - x, and the duel wave builder sends the SAME party down
      // both roads rather than splitting one between them. Proven, not
      // asserted: running one rival's own plan down BOTH sides ends 35-35 with
      // identical machine counts and identical gold to the coin.
      name: 'The Split Cavern',
      duelShared: true,                 // one cavern, two sides
      keep: { x: 104, y: 205 },         // lane 0 = YOURS; the single-keep code reads this
      mound: { x: 104, y: 250, rx: 80, ry: 38 },
      keeps: [{ x: 104, y: 205 }, { x: 316, y: 205 }],
      mounds: [{ x: 104, y: 250, rx: 80, ry: 38 }, { x: 316, y: 250, rx: 80, ry: 38 }],
      paths: [
        [[54, 748], [92, 676], [46, 602], [92, 528], [150, 470], [96, 396], [70, 316], [104, 250], [104, 232]],
        [[366, 748], [328, 676], [374, 602], [328, 528], [270, 470], [324, 396], [350, 316], [316, 250], [316, 232]],
      ],
      // EVERY PAD IS ITS TWIN AT 420 - x. Two of them were not: (86,462) faced
      // (328,462) where the mirror is 334, and (32,666) faced (376,666) where
      // the mirror is 388. Small, but the whole fairness argument for this map
      // is GEOMETRIC -- "neither side gets better ground" is a claim you can
      // only make about an arena that is actually symmetric, and a claim that
      // is only nearly true is the kind that gets quoted later as if it were.
      pads: [
        { x: 110, y: 306 }, { x: 44, y: 276 }, { x: 86, y: 462 }, { x: 98, y: 576 }, { x: 32, y: 666 },
        { x: 310, y: 306 }, { x: 376, y: 276 }, { x: 334, y: 462 }, { x: 322, y: 576 }, { x: 388, y: 666 },
      ],
      torches: [[186, 700], [234, 700], [176, 420], [244, 420], [150, 560], [270, 560]],
      heroStart: { x: 150, y: 690 },
      pathW: 34,
    },
  ];
  // HOW MANY OF THOSE ARE CAMPAIGN LEVELS. MAPS.length used to answer both
  // "what ground can be played" and "how many campaign levels are there", and
  // those stopped being the same number the moment duel-only arenas existed.
  // Save.data.stars is [0,0,0], the campaign menu has three rows, and the
  // trials screen lays its chips out at x = W-168 + i*46, which runs off a
  // 420-wide world at four. Everything that means CAMPAIGN reads this.
  var CAMPAIGN_MAPS = 3;
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
  // LANES. A map is a LIST of roads, not one road. Every raider carries the
  // lane it entered on (`e.ln`) and still addresses it by scalar distance, so
  // the arc-length march, the replay exactness and the order-independence all
  // survive untouched -- a second road is a second table, not a second rule.
  //
  // `paths: [...]` is the multi-lane form; a map with the old `path: [...]`
  // becomes a one-lane map by construction, which is why levels 1-3 did not
  // have to be rewritten to add this.
  function buildLanes(map) {
    var ctrls = map.paths || [map.path], out = [];
    for (var c = 0; c < ctrls.length; c++) out.push(buildPathFrom(ctrls[c]));
    return out;
  }
  var PATHS = [];                       // PATHS[mapIdx] = [lane, lane, ...]
  for (var _m = 0; _m < MAPS.length; _m++) PATHS.push(buildLanes(MAPS[_m]));
  var LANES = PATHS[0];
  // PATH stays as lane 0. It is the honest answer for everything that is about
  // the map rather than about one raider -- the legacy export, the dev hook --
  // and it means a missed call site degrades to "reads the first road", not to
  // a crash on undefined.
  var PATH = LANES[0];
  function laneOf(ln) { return LANES[ln | 0] || LANES[0]; }
  function laneLen(ln) { return laneOf(ln).len; }
  // A SHARED-CAVERN duel map has one keep and one mound PER LANE: lane 0 is
  // yours, lane 1 is the rival's. Every other map has one of each, and these
  // return it for any lane, so nothing else has to know the difference.
  function keepOf(ln) { return (MAP.keeps && MAP.keeps[ln | 0]) || MAP.keep; }
  function moundOf(ln) { return (MAP.mounds && MAP.mounds[ln | 0]) || MAP.mound; }
  function sharedCavern() { return !!MAP.duelShared; }
  /// Which side of a shared cavern a point belongs to: the keep it is nearest.
  /// Not a hardcoded x < 210 -- a midline is an assumption about one arena's
  /// shape, and the nearest keep is the actual rule ("whose ground is this").
  function sideAt(x, y) {
    if (!MAP.keeps || MAP.keeps.length < 2) return 0;
    var best = 0, bd = Infinity;
    for (var i = 0; i < MAP.keeps.length; i++) {
      var dx = x - MAP.keeps[i].x, dy = y - MAP.keeps[i].y, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  // Level switch — called ONLY from reset() (deterministic; never mid-run)
  function setLevel(i) {
    i = Math.max(0, Math.min(MAPS.length - 1, i | 0));
    MAP = MAPS[i];
    LANES = PATHS[i];
    PATH = LANES[0];
    return i;
  }
  function buildPath() { return buildPathFrom((MAPS[0].paths || [MAPS[0].path])[0]); }   // legacy export shape
  // ln defaults to lane 0, so every caller that is genuinely about the map and
  // not about a raider keeps working unchanged.
  function pathPointAt(d, ln) {
    var P = laneOf(ln);
    if (d <= 0) { var a0 = P.pts[0]; return { x: a0[0], y: a0[1] }; }
    if (d >= P.len) { var aN = P.pts[P.pts.length - 1]; return { x: aN[0], y: aN[1] }; }
    var lo = 0, hi = P.cum.length - 1;
    while (lo + 1 < hi) { var mid = (lo + hi) >> 1; if (P.cum[mid] <= d) lo = mid; else hi = mid; }
    var t = (d - P.cum[lo]) / (P.cum[hi] - P.cum[lo] || 1);
    var a = P.pts[lo], b = P.pts[hi];
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
      // FIVE FIRING MACHINES SHARED THREE SOUNDS — the crossbow, the gargoyle
      // roost and Wick's fireball were literally the same 80ms sample, and the
      // Gemsinger made no sound at all. A board of mixed machines sounded like
      // one machine. These are number literals, not art: each firing type now
      // has its own voice, routed through FIRE_SFX.
      bow:    [0.95, , 150, 0.01, 0.03, 0.11, 3, 2.4, -9, , , , , 1.1, , 0.08],
      stone:  [0.9, , 70, 0.02, 0.05, 0.20, 4, 1.6, -4, , , , , 0.5, , 0.15, 0.05],
      flame:  [0.85, , 220, 0.01, 0.06, 0.22, 4, 1.3, -6, , , , , 1.3],
      // 0.6 measured as rms 0.078: the QUIETEST sound in the whole table, and
      // it belongs to the 50g machine most boards are built out of.
      chime:  [0.9, , 1320, 0.02, 0.06, 0.35, 1, 1.9, , , 660, 0.04, , , , , , 0.4],
      // ...and the BACK half of the lifecycle was silent. A bolt landing made no
      // sound at all; only the lob had an impact. A crit was indistinguishable
      // from a graze, and a shield deflect from a clean hit.
      thud:   [0.85, , 110, 0.01, 0.04, 0.14, 4, 1.5, -8, , , , , 0.9, , 0.15],
      crunch: [1.0, , 90, 0.01, 0.06, 0.26, 4, 1.2, -10, , , , , 1.2, , 0.2],
      // A DEFLECT AND A SABOTAGE MEASURED 0.995 IDENTICAL -- the highest
      // collision in the game -- and they mean opposite things: 'your bolt
      // bounced, switch tools' versus 'a Pry-Hand just killed a machine'.
      // 340Hz light metal was also the wrong object: a Shellback's pavise is
      // body-length WOOD with an iron rim. 110Hz hollow boom, rim ring 12ms
      // behind it. Clears bow~clang and thud~clang for free.
      clang:  [1.25, 0.05, 110, 0.002, 0.05, 0.30, 0, 0.7, -14, , 700, 0.012, , 0.25, , , 0.02, 0.28, 0.05],
      lob:    [0.7, , 160, 0.02, 0.08, 0.25, 4, 1.2, 6, , , , , 0.6],
      bite:   [0.9, , 130, 0.01, 0.05, 0.18, 3, 1.5, -6, , , , , 0.4],
      coin:   [0.7, , 1046, , 0.04, 0.16, 1, 1.9, , , 540, 0.05],
      steal:  [1.0, , 320, 0.02, 0.12, 0.40, 2, 1.3, -4, , -80, 0.10, , 0.2, , , 0.10],
      recover:[0.9, , 660, 0.01, 0.10, 0.30, 1, 1.7, , , 330, 0.06],
      leak:   [1.0, , 110, 0.03, 0.20, 0.60, 2, 1.2, -2, , , , , 0.3, , 0.2, 0.15],
      // WICK IS DOWN -- nine seconds with no breath, no manning, no jam
      // clearing. It shared `leak` with a single coin escaping the cave, so a
      // catastrophe and routine chip damage were one sound.
      herodown: [1.05, 0.05, 300, 0.004, 0.16, 0.50, 2, 1.6, -16, , -90, 0.10, , 0.08, , 0.08, 0.08, 0.45, 0.05, , 900],
      // THE HOARD IS NEARLY GONE. Two-tone square an octave apart, repeating:
      // nothing else in the table is a square wave, so it cuts through a full
      // wave instead of joining it.
      alarm:  [0.95, 0.05, 262, 0.01, 0.10, 0.34, 5, 1.0, , , 131, 0.09, 0.16, , , , , 0.6],
      // A WAVE HELD CLEAN. Was `upg`, the SHOP jingle -- so the game's
      // proudest beat sounded like a menu confirmation. A rising fifth.
      clear:  [0.85, 0.05, 523, 0.008, 0.09, 0.34, 0, 1.3, , , 784, 0.06, 0.09, , , , , 0.5],
      // THE LOB LANDING. 52Hz lowpassed at 420 -- a soot-and-embers fwoomph,
      // nowhere near the 4.7kHz band that holds every other impact. The
      // Brazier is the splash machine and its blast was a bolt graze.
      fwoomph: [0.62, 0.05, 52, 0.005, 0.16, 0.30, 4, 0.6, -2.5, , , , , 0.9, , 0.10, 0.02, 0.85, 0.04, , 420],
      // Wick's fireball ARRIVING. It had a launch sound and landed in silence.
      fireimp: [1.0, 0.05, 80, 0.003, 0.09, 0.22, 4, 1.4, -9, , , , , 0.55, , 0.14, 0.03, 0.7, 0.03, , 900],
      wave:   [0.9, , 196, 0.05, 0.30, 0.40, 2, 1.5, 2, , , , 0.12, , , , 0.10],
      breath: [1.1, , 90, 0.02, 0.25, 0.45, 4, 1.3, 3, , , , , 0.8, , 0.3, 0.15],
      win:    [0.9, , 523, 0.04, 0.30, 0.50, 1, 1.7, , , 392, 0.10, 0.15, , , , 0.20],
      lose:   [1.0, , 220, 0.05, 0.25, 0.80, 1, 1.5, -3, , -60, 0.15, , 0.15, , 0.2, 0.20],
      crackle:[0.25, 0.3, 700, , 0.01, 0.08, 4, 2, -20, , , , , 1.5],

      // ===== THE KILL =====================================================
      // Every death of every one of the ten raider types used to play ONE
      // sound: `coin`, 200ms, volume 0.70 -- the QUIETEST combat sound in the
      // table, while every gun that produced it ran 0.85-1.00. The moment the
      // whole game exists to make was its quietest, shortest, most repeated
      // noise, and a Scrapling popping was audibly identical to The Hoard King
      // falling after twenty waves.
      //
      // The Bloons property the owner asked for is not gore -- it is:
      //   1. a fast PITCHED transient (<20ms attack) with a resonant body,
      //      never a noise wash;
      //   2. a fundamental that tracks the target's SIZE -- small dies high and
      //      quick, big dies low and long;
      //   3. POLYPHONY: five kills at once must be five audible kills.
      // These five are measured by tools/sfxlab.js, which renders the table and
      // reports a pairwise distinctness matrix. Their spectral centroids run
      // 1974 / 848 / 256 Hz across the size ladder and none of them collides
      // with any pre-existing sound. Re-run that tool after ANY edit here --
      // dialling a sound by ear into a 25-sound table is how the game ended up
      // with eleven of them stacked inside one 1.4kHz window.
      popSmall: [0.95, 0.05, 1350, 0.003, 0.02, 0.075, 1, 1.7, -26, , , , , 0.008],
      popMid:   [1.0,  0.05, 560,  0.003, 0.03, 0.115, 1, 1.2, -6, , , , , 0.01, , , , 0.6, 0.02],
      // armour dies METALLIC, not meaty. A struck plate: a triangle that drops
      // 380Hz in 20ms, which is the two-tone "ka-clunk" of hitting something
      // hard. Narrow-band on purpose -- the first attempt used tan+modulation
      // and measured as a WIDE spectrum that collided with eight other sounds
      // despite a centroid nowhere near them.
      popArmor: [1.0,  0.05, 1500, 0.002, 0.04, 0.22, 1, 1.1, -8, , -380, 0.02, , 0.005, , , , 0.40, 0.03],
      // a keg comes apart: a bright knock with a splintery rattle (repeatTime)
      popWood:  [1.15, 0.05, 760,  0.002, 0.02, 0.17,  2, 1.2, -30, , , , 0.042, 0.02, , , , 0.55, 0.02, 0.45],
      // the payoff of a twenty-wave level. Long, low, and it falls.
      // It SWELLED rather than landed: 294ms to peak, and quieter than the
      // coin chime it replaced. Now it falls like a building -- 4ms transient
      // at 120Hz, a -34Hz drop at 50ms, a 640ms body. Residual, accepted and
      // recorded: bite ~ popBoss measures 0.945, but one is a 240ms machine
      // attack and the other a 643ms boss death; they never share a beat.
      popBoss:  [0.95, 0.05, 120, 0.003, 0.20, 0.40, 1, 1.05, -1.9, , -34, 0.05, , 0.02, , , , 0.80, 0.04],
      // THE WHIRLYJACK'S SWEEP -- a chopped, repeating blade whirr. repeatTime
      // 0.022 is what makes it read as BLADES rather than a tone: the envelope
      // retriggers ~45x a second. Dialled against the whole table with
      // tools/sfxlab.js: 0 collisions, and the table total stays at the
      // committed baseline of 23.
      whirl:    [0.8, 0.05, 460, 0.002, 0.06, 0.13, 3, 1.3, -4, , , , 0.022, 0.25, , , , 0.6, 0.02],
      // GEARJAW'S REND. The fork's whole identity -- 4 dps of armour-proof
      // grind -- had NO renderer and NO sound of its own: bleedT touched five
      // sim sites and zero draw calls, and both mimic forks played the same
      // `bite`. You paid 120g for a differentiator you could not see or hear.
      // Mechanical, never organic: this is sheared metal and popped rivets, in
      // a game whose content law is comic and kid-safe.
      grind:    [0.8, 0.05, 90, 0.003, 0.09, 0.20, 3, 1.4, -6, , , , 0.012, 0.3, , , , 0.7, 0.03],
      // armour SHAVING a hit. A Bulwark eats 5 flat off every bolt and the
      // game never said so, so a player watching their crossbows do nothing
      // had no way to learn to switch. A short metal scrape says it.
      // Placed at ~7.1kHz deliberately: that region was EMPTY, and the crowded
      // 3.4-5.1kHz band already holds eleven sounds including every impact.
      shave:    [0.7,  0.05, 2600, 0.001, 0.012, 0.07, 3, 3.2, -70, , , , , 0.03],
    };
    // KILL VOICE BY RAIDER. A pure function of e.type -- sim state that is
    // already deterministic -- so this consumes NOTHING from the seeded stream.
    var KILL_SFX = {
      looter:   'popSmall',  // Scrapling  30hp
      scout:    'popSmall',  // Filcher    22hp
      bat:      'popMid',    // Gloomwing  45hp, airy
      blinker:  'popMid',    // Blinker    60hp
      warlock:  'popMid',    // Greed Hexer 80hp
      sapper:   'popWood',   // Pry-Hand   70hp, all crowbar and planks
      // Hogshead 130hp. He was 'Cracked Keg' when this was chosen and the
      // reason written down was 'it IS a barrel' -- which was never true of
      // the sprite (a rotund ARMOURED knight, prompted as 'he looks like he
      // would break into smaller pieces'). popWood still stands, on the real
      // reason: this is the one raider that COMES APART, and a splintery
      // knock says that. popArmor is the Bulwark/Shellback voice and a third
      // sharer would blunt it.
      splitter: 'popWood',
      shield:   'popArmor',  // Shellback  90hp, pavise
      brute:    'popArmor',  // Bulwark    220hp, armor 5
      boss:     'popBoss',   // The Hoard King 3000hp
    };
    // ...and within a voice, bigger raiders die LOWER. Playback rate only, so
    // one buffer serves the whole family and the table stays readable.
    function killRate(hp) {
      // 22hp -> 1.12, 220hp -> 0.90, 3000hp -> 0.78. Deterministic in hp.
      return clamp(1.30 - 0.115 * Math.log(Math.max(8, hp)), 0.72, 1.18);
    }
    // 'shoot' and 'hit' both had ZERO call sites -- the table had never been
    // reconciled against the code that plays it. Deleted with their limiters.
    var RATE_MS = { bite: 90, lob: 90 };
    // 8 was not enough to hear a splash. A Soot Brazier can kill five raiders
    // in one 16ms step and wave 17 spawns thirty looters at 0.35s; with eight
    // slots and oldest-wins eviction, the kills were the voices being thrown
    // away while five machines' FIRING sounds held their slots.
    var MAX_VOICES = 16;
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
    // PRIORITY, not just recency. The old rule was "the pool is full, stop the
    // OLDEST" -- which meant a wave of thirty looters threw away the kill you
    // just earned to make room for the next crossbow twang, and hard-stopped a
    // mid-envelope buffer (an audible click). Now a voice will only ever be
    // evicted by one of EQUAL OR HIGHER priority, the quietest-and-oldest of
    // the losers goes first, and it is released over 40ms instead of cut.
    //   2 = a kill, the beat the whole game is for
    //   1 = an impact / a stinger
    //   0 = firing, UI, ambience
    function voice(buf, bus, rate, gain, pri) {
      pri = pri || 0;
      if (live.length >= MAX_VOICES) {
        var worst = -1;
        for (var i = 0; i < live.length; i++) {
          if (live[i].pri > pri) continue;                 // never rob a bigger moment
          if (worst < 0 || live[i].pri < live[worst].pri) worst = i;
        }
        if (worst < 0) return;                             // everything live matters more
        var dead = live[worst];
        live.splice(worst, 1);
        try {
          dead.g.gain.setTargetAtTime(0, ac.currentTime, 0.012);
          dead.src.stop(ac.currentTime + 0.04);
        } catch (e) {}
      }
      var src = ac.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      var g = ac.createGain();
      g.gain.value = gain === undefined ? 1 : gain;
      src.connect(g); g.connect(bus);
      var rec = { src: src, g: g, pri: pri };
      src.onended = function () { var k = live.indexOf(rec); if (k >= 0) live.splice(k, 1); };
      src.start();
      live.push(rec);
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
      chordValid: true, rival: null,
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

    // THE RIVAL'S WORKSHOP — a duel, for zero extra bytes.
    //
    // A duel is two builders in two caverns working the SAME seven machines, so
    // the rival's workshop is not new music: it is `stem_works` heard through
    // the rock. Same buffer, started three bars out of phase so it reads as
    // another room rather than a doubling of your own layer, and lowpassed hard
    // because that is what a wall does to a workshop.
    //
    // Its level is the scoreboard. `rivalHoard` steps once per wave off the
    // baked curve, so the deficit between the two hoards is known every wave —
    // and when they pull ahead you hear them getting louder through the wall
    // before you look at the number.
    function startRival() {
      var buf = Music.buf['stem_works'];
      if (!ac || !buf || !Music.bedSrc || Music.rival) return;
      var t = nextBarAfter(ac.currentTime + 0.08);
      var src = ac.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      var lp = ac.createBiquadFilter();
      lp.type = 'lowpass'; lp.frequency.value = 470; lp.Q.value = 0.7;
      var gn = ac.createGain();
      gn.gain.value = 0;
      src.connect(lp); lp.connect(gn); gn.connect(musicBus);
      // Whole bars only, or the offset unlocks it from the shared bar grid.
      src.start(t, (3 * BAR_SEC) % buf.duration);
      Music.rival = { src: src, gain: gn, want: 0 };
    }

    function stopStems() {
      if (Music.rival) {
        try { Music.rival.src.stop(); } catch (e) {}
        Music.rival = null;
      }
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
        // The rival, if this is a duel. Deficit is how far AHEAD they are as a
        // fraction of a full hoard, so a dead-level duel still leaves them
        // faintly audible — they are always in there working — and falling a
        // hoard behind makes their machines the loudest thing in the cave.
        if (p.duel) startRival();
        if (Music.rival) {
          var d = Math.max(0, Math.min(1, p.deficit || 0));
          var rTo = (p.duel && p.playing) ? 0.08 + 0.34 * d : 0;
          if (Math.abs(Music.rival.want - rTo) >= 0.004) {
            Music.rival.want = rTo;
            ramp(Music.rival.gain.gain, rTo, rTo > 0 ? 1.6 : 0.6);
          }
        }
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
      // opts (all optional): { rate, gain, pri, nolimit }
      //   rate    playback-rate scalar. MUST be derived from deterministic sim
      //           state (hp, type) at the call site -- never from Math.random()
      //           there, which would put a draw on the fixed-step path and trip
      //           tools/validate.py. The cosmetic jitter is applied HERE, on the
      //           far side of the call, exactly where it has always been.
      //   pri     see voice(): 2 = kill, 1 = impact, 0 = firing/UI.
      // otherCave: set while the RIVAL's board is being stepped. A duel steps
      // two full sims per frame and both of them call Sfx.play -- unmuted, the
      // opponent's crossbows, kills and leaks all play in the player's ears,
      // doubling every sound and making a cave the player cannot see the
      // loudest thing in the game. A flag rather than a per-Game Sfx because
      // the rival step is synchronous: it is set, it is stepped, it is cleared.
      otherCave: false,
      play: function (name, key, opts) {
        if (!ac || muted || Sfx.otherCave) return;    // consumes NOTHING seeded
        opts = opts || {};
        var now = Date.now();
        // KEYED ON THE EMITTER, NOT THE NAME. This was one timestamp per sound
        // NAME, so five machines firing together played ONE voice and the other
        // four were dropped — and at 2x speed the game got QUIETER, because the
        // same wall-clock window swallowed twice as many shots. A machine still
        // cannot machine-gun itself; five machines are now five voices.
        var gk = key === undefined ? name : name + '#' + key;
        if (!opts.nolimit && RATE_MS[name] && lastPlay[gk] && now - lastPlay[gk] < RATE_MS[name]) return;
        // ONLY the rate-limited names need a timestamp. This ran unguarded, so
        // every keyed play of a sound with no RATE_MS entry -- thud#id,
        // crunch#id, clang#id, shave#id, and now popX#id for every kill --
        // wrote one permanent map entry per raider that ever existed, never
        // pruned, across every level of a session.
        if (RATE_MS[name]) lastPlay[gk] = now;
        var buf = buffer(name);
        if (!buf) return;
        // per-play pitch jitter — ZzFX's own flavour, NEVER the gameplay seed.
        // Widened from ±3% (inaudible) to ±7%, and multiplied by the caller's
        // deterministic rate so a heavy raider dies lower than a light one.
        voice(buf, sfxBus, (opts.rate || 1) * (1 + (Math.random() - 0.5) * 0.14),
              opts.gain, opts.pri);
      },
      /// A raider died. `type` picks the voice, `hp` (its MAX hp, not what is
      /// left) picks the pitch, `id` keys the rate-limit so simultaneous kills
      /// are simultaneous SOUNDS. Both inputs are deterministic sim state.
      kill: function (type, hp, id) {
        api.play(KILL_SFX[type] || 'popSmall', id,
                 { rate: killRate(hp), pri: 2, nolimit: true });
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
  // ...but starting at wave 7 of the seeded ramp. See _waveGroups: a duel that
  // began at wave 1 spent nine waves with both hoards untouched and the margin
  // chip reading +0, which is not a duel, it is a countdown.
  // The opening purse has to track the opening wave: a duel that starts at
  // wave 11 with a wave-3 purse is an empty floor against veterans. Measured
  // at the calibration point — the bot's board plus gold in hand at the end of
  // wave 6 was ~850 across the arenas — and made linear in the offset from
  // there, which is how a siege's income actually accrues.
  // THE PURSE HAS TO KNOW HOW MANY ROADS IT IS BUYING. 100 + 125*at was
  // measured against a ONE-ROAD board ("the bot's board plus gold in hand at
  // the end of wave 6 was ~850"), and on a two-road arena that same purse funds
  // one front and leaks the other. The sweep showed it plainly and backwards:
  // at=2 played WORSE than at=4 on both new arenas, because the binding
  // constraint at a low offset is not the wave ramp, it is the money -- fewer
  // waves also means a smaller purse, and below ~600g you cannot cover two
  // roads at all. Scaling per EXTRA road puts the two-road arenas back on the
  // one-road curve instead of hiding the problem inside a hand-picked offset.
  var DUEL_LANE_PURSE = 0.60;             // per road beyond the first
  function duelStartGold(at, mapIdx) {
    var mp = MAPS[mapIdx | 0] || MAPS[0];
    // A SHARED CAVERN IS A ONE-ROAD DEFENCE. The multiplier exists because on a
    // two-road arena one purse has to fund two fronts -- but in a duel the
    // second road is the RIVAL'S, you never defend it, and the duel wave now
    // sends a full party down each. That is exactly the one-road board
    // `100 + 125*at` was measured against, so the x1.6 was pure surplus, paid
    // to both sides (measured: 760 where the calibration says 475).
    if (mp.duelShared) return Math.round(100 + 125 * (at | 0));
    var lanes = (PATHS[mapIdx | 0] || PATHS[0]).length;
    return Math.round((100 + 125 * (at | 0)) * (1 + DUEL_LANE_PURSE * (lanes - 1)));
  }
  // Arenas rotate daily so a duel is not a fixed puzzle, but hold still WITHIN
  // a day so a loss can be avenged on the same ground.
  // An arena is a SEED PLUS ITS MAP, stated, not derived. Deriving the map as
  // (seed % MAPS.length) was tried first and the six seeds landed 5-0-1 across
  // the three maps — a distribution nobody chose and nobody would have noticed,
  // and one that would silently re-scramble the day a fourth map is authored.
  // Two arenas per map, written down.
  // `at` is the wave of the seeded ramp this arena OPENS on, and it is per
  // arena because the bake showed arena difficulty is dominated by the MAP,
  // not by the seed: the three maps were authored around hand-tuned campaign
  // waves, so under one shared ramp they are not remotely equivalent. At a
  // flat opening of wave 7, map 0 (the short beginner keep) sacked every
  // rival by wave 2-5 while map 2 (the long switchback, where machines get far
  // more shots per raider) left the mid rivals on a full 60 for twelve waves.
  // Calibrating the opening per arena is what makes them the same contest.
  // MAP 0 IS NOT A DUEL ARENA. Measured twice, at two different openings: the
  // Long Sleep is the short beginner keep, and under the shared seeded ramp it
  // cannot hold past about wave 8 — every rival on every map-0 arena finished
  // on 0, which makes the duel trivially won by surviving at all. Not every
  // map makes a versus map; that is true of every game with a versus mode, and
  // it is cheaper to say so than to re-tune a road authored for a hand-built
  // campaign. The Undergallery and the Coldroot Stair take three arenas each.
  // Because a map is now stated rather than derived, a seed is free to appear
  // on whichever road suits it.
  // Interleaved m1/m2 ON PURPOSE: tonight's arena is (day + rivalIdx) %% 6,
  // so four consecutive indices are what the picker shows at once. Grouped
  // by map, that put three of the four rivals on the same road every night.
  // This list is now free to be reordered: nothing is indexed against it any
  // more, because nothing about a rival is recorded ahead of time.
  // THE ARENAS ARE NOW THEIR OWN GROUND. Every one of these used to be map 1 or
  // map 2 -- the two boards the campaign already walks you through -- so a duel
  // was a level you had played, with a scoreboard. VANUS: "why is our dual game
  // just the same as any other game and every map is all the same". Maps 3 and
  // 4 are duel-only and are the first two-road maps in the game: the Twin
  // Throats merges its roads into one climb (7 of 10 pads reach both, so the
  // merge is the map) and the Sunder never merges at all (9 of 10 pads reach
  // exactly one road, so you fund two fronts or lose one).
  var DUEL_ARENAS = [
    // at 3-4, not the 5-10 the one-road arenas used. Swept: on two roads at>=5
    // wipes every rival but cinder, which is the DEAD-arena pattern (see the
    // note on the old arena 11). The purse multiplier above carries the rest.
    { seed: 0xd00dfeed, map: 5, at: 3 },
    { seed: 0x7a11ba5e, map: 5, at: 3 },
    { seed: 0x1ceb00da, map: 5, at: 4 },
    { seed: 0xa11ecafe, map: 5, at: 5 },
    { seed: 0x5eed1a3f, map: 5, at: 4 },
    { seed: 0x0dd1e5ec, map: 5, at: 3 },
  ];
  // THE LADDER IS THE PURSE, NOT THE POLICY. The first cut ranked rivals by
  // the bot's build policy and the bake disproved it outright: 'balanced'
  // BEAT 'depth' on the long switchback arenas, so the mid rival outscored
  // both rivals ranked above it and every rank label was a lie. The policies
  // are strategies with map-dependent strengths, not skill tiers.
  // So policy stays as CHARACTER — how a rival plays, visible in their board —
  // and `purse` is the difficulty: how much of the arena's opening gold they
  // salvaged, applied to her opening gold AND to what her kills pay her. A
  // weaker hoardling brought less and earns less. That is monotonic by
  // construction, it is honest (she really plays with exactly that money, in
  // this sim, in front of you), and it is stated on her card rather than
  // hidden in a fudge factor. The PLAYER always gets the full purse.
  // Ranks and pips are MEASURED, not asserted. Two rounds of handicap tuning
  // failed to make the roster monotonic, and the bake explained why: on the
  // long switchback (map 2) breadth beats depth decisively, because coverage
  // is what that road rewards and the depth policy caps its footprint around
  // six machines — so the "higher" tier lost to the lower one on two arenas no
  // matter how the purses were set. Rather than keep fudging numbers until a
  // false ladder appeared, the roster now says what is true: Tallow is the
  // floor, Cinder is the ceiling, and Flint and Ember are the SAME tier with
  // opposite strengths — Flint owns the open switchbacks, Ember owns the
  // chokepoints. That is a better matchup than a straight line anyway.
  var RIVALS = [
    { id: 'tallow', tint: '#e0c070', name: 'Tallow', rank: 'APPRENTICE', pips: 1, policy: 'rival_tallow', wick: false, purse: 0.85,
      blurb: 'Builds wide and cheap. Never upgrades a thing.' },
    { id: 'flint', tint: '#7fb0e0', name: 'Flint', rank: 'BROAD HAND', pips: 2, policy: 'rival_flint', wick: false, purse: 0.75,
      blurb: 'Spreads his brass thin and wide. Loves a long road.' },
    { id: 'ember', tint: '#ff8a3c', name: 'Ember', rank: 'DEEP HAND', pips: 2, policy: 'rival_ember', wick: false, purse: 0.95,
      blurb: 'Few machines, all of them monsters. Wants a chokepoint.' },
    { id: 'cinder', tint: '#b06adf', name: 'Cinder', rank: 'DRAKE', pips: 3, policy: 'rival_cinder', wick: true, purse: 1.15,
      blurb: 'Works the cavern floor herself. Good luck.' },
  ];
  var RIVAL_ORDER = ['tallow', 'flint', 'ember', 'cinder'];
  // A rival's arena for today. Pure function of the day and the rival, so both
  // sides of a duel are the same fight and tomorrow is computable today (which
  // is how the curves get baked ahead of time).
  function duelSeedIdx(rivalIdx) { return (dayNumber() + rivalIdx) % DUEL_ARENAS.length; }
  // The arena's MAP is a function of the arena, never of the day. Deriving it
  // from the day instead would mean a baked curve and the run it is scored
  // against could sit on different ground — the one failure this whole mode
  // has to make impossible.
  function duelMapAt(seedIdx) { return Math.min(MAPS.length - 1, DUEL_ARENAS[seedIdx].map | 0); }
  function duelMapFor(rivalIdx) { return duelMapAt(duelSeedIdx(rivalIdx)); }   // tonight's, for the picker
  /** Can this rival actually play her half of the cavern?
   *
   *  THIS USED TO ASK A DIFFERENT QUESTION. The duel was once a race against
   *  RIVAL_CURVES -- a baked table of "hoard after wave W", recorded by the bot
   *  ahead of time -- so the readiness test was "is there a recording of her?"
   *  She is simulated live now, in the same cavern, off the same waves, so the
   *  recording was answering a question about a game that no longer exists.
   *  The honest modern test is whether she has a PLAN to play with; without one
   *  _rivalTick would silently fall back to Tallow's and the card would lie. */
  function rivalReady(rivalIdx) {
    var rv = RIVALS[rivalIdx | 0];
    return !!(rv && RIVAL_PLANS[rv.id]);
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
    warlock: ['GREED HEXER', 'Heals the pack. Set a machine to HEXER to hunt him.'],
    blinker: ['BLINKER', 'Teleports up the road. A chilled rogue cannot blink.'],
    boss:    ['THE HOARD KING', 'War drums drive his court. At half health he calls more.'],
    sapper:  ['PRY-HAND', 'Jams your machines silent. Kill him BEFORE he reaches them.'],
    splitter:['HOGSHEAD', 'Breaks into two Scraplings. Bring splash, not a sniper.'],
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
      hero_breathe: 'art/hero_breathe.png',
      hero_back: 'art/hero_back.png',
      // MANNING POSE -- he HOVERS beside the machine and works it, wings out.
      // Standing the rest plate next to a machine read as loitering (VANUS:
      // "manning it doesnt look like anything just standing next to it").
      // Registered onto hero_whelp by tools/register_frames.py: foot drift
      // 0.0px, shoulder drift 0.1px, tone gain 0.91, so the swap does not
      // move him. The two BREATH poses generated alongside it were REJECTED
      // by that same tool at gain 0.42/0.46 -- and excluding their baked
      // flame barely moved the number (the fire is 1.7% of pixels), so the
      // whole dragon was repainted ~40% brighter. They are in
      // art-src/wick_poses/ and did not ship.
      hero_man:  'art/hero_man.png',
      // WING FRAMES for the manning flap. Generated by EDITING hero_man
      // itself, so body, wrench, lean and lighting are identical between
      // them and only the wings move -- then registered onto it (foot drift
      // 0.0px). Three frames cycled is a flap; scaling one painted sprite
      // non-uniformly is a squash, which is what shipped first and what
      // VANUS rejected: "he looks like he's being squashed".
      hero_man_dn: 'art/hero_man_dn.png',
      hero_man_up: 'art/hero_man_up.png',
      hero_title: 'art/hero_title.png',
      t_mimic:   'art/tower_mimic.png',
      t_ballista:'art/tower_ballista.png',
      t_brazier: 'art/tower_brazier.png',
      t_crystal: 'art/tower_crystal.png',
      t_perch:   'art/tower_perch.png',
      t_bellows: 'art/tower_bellows.png',
      t_press:   'art/tower_press.png',
      t_rotor:   'art/tower_rotor.png',
      // the combined manned plates are GONE (see MAN_SCALE) -- Wick
    // is drawn as himself on each machine's own mount point.
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
  var EMPTY_TAPS = [];
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
      // one ribbon per lane, laid end to end into the same buffers; the strip
      // is built per-segment below, so a break between lanes costs one stray
      // quad, which the degenerate guard drops.
      for (var rl2 = 0; rl2 < LANES.length; rl2++) {
        for (var d = 0; d <= LANES[rl2].len; d += 10) {
          var a = pathPointAt(d, rl2), b = pathPointAt(Math.min(LANES[rl2].len, d + 10), rl2);
          var dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1;
          var nx = -dy / L * half, ny = dx / L * half;
          up.push([a.x + nx, a.y + ny]); dn.push([a.x - nx, a.y - ny]);
        }
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
      if (fx.k === 'boom' || fx.k === 'death' || fx.k === 'recover' || fx.k === 'blink' ||
          fx.k === 'steal' || fx.k === 'fireburst' || fx.k === 'grind') {
        // DEATH WAS CRIMSON HERE (0xc0392b) while the 2D renderer scatters GOLD
        // COINS for the same event. Two renderers disagreeing about what a kill
        // looks like is bad enough; a red burst over a human raider also reads
        // as blood, and the content law is comic, kid-safe, comedic deaths, no
        // gore. Gold, like its 2D twin.
        var col = fx.k === 'recover' || fx.k === 'steal' || fx.k === 'death' ? 0xf0b429 :
                  fx.k === 'blink' ? 0xb39dff :
                  fx.k === 'grind' ? 0xe8eef5 :          // sheared steel, not sparks
                  0xff9a3c;
        this.fx.push({ kind: 'burst', x: fx.x, y: fx.y, t: 0, col: col,
                       n: fx.k === 'boom' ? 10 : fx.k === 'grind' ? 5 : 7, group: null });
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
        var ahead = pathPointAt(en.fleeing ? Math.max(0, en.d - 8) : Math.min(laneLen(en.ln), en.d + 8), en.ln);
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
          var a2 = pathPointAt(tp2.d, tp2.ln), TP = this.W(a2.x, a2.y);
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
      // MOUTH-ORIGIN FIRE, 3D half: same beat clock as the 2D jaw, so both
      // renderers fire from one moment. READ THE CONSTANT — this divided by a
      // hardcoded 0.42 while BREATH_BEAT is 0.60, so for the first 30% of every
      // beat sin() was past pi and `open` came back NEGATIVE: the 3D jaw hinged
      // the WRONG WAY, then snapped through zero. The comment claiming the two
      // renderers shared a moment is exactly what stopped anyone checking.
      var bt = game._breathT || 0;
      if (this.hero.userData.jaw) {
        var open = bt > 0 ? Math.sin(Math.min(1, bt / BREATH_BEAT) * Math.PI) : 0;
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
  // isRival: this instance is the OPPONENT'S CAVE, simulated live beside yours.
  //
  // Everything that makes a Game a Game is already per-instance -- ctx, view,
  // towers, enemies, hoard -- so a second board costs a constructor call and
  // not a refactor. What is NOT per-instance is the handful of globals a Game
  // reaches OUT to, and each one is a way the rival could corrupt the player:
  //   * Input.setConverter  -- the last Game to construct owns the taps, so a
  //                            rival would silently steal every one of them
  //   * requestAnimationFrame -- the rival must run on the PLAYER'S clock, in
  //                            lockstep, or the two caves drift apart
  //   * Save                -- _gameOver writes stars; the rival must never
  //   * Sfx                 -- one cave's worth of sound, not two
  // MAP/LANES are shared ON PURPOSE: a duel is the same raiding party hitting
  // both caves, so both sides MUST be on the same ground.
  function Game(canvas, isRival) {
    this.isRival = !!isRival;
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
    if (!this.isRival) Input.setConverter(function (cx, cy) {
      var w = self.toWorld(cx, cy);
      // view coords ride along for the screen-anchored HUD hit tests
      w.vx = cx / self.view.scale;
      w.vy = cy / self.view.scale;
      return w;
    });
    this._frame = this._frame.bind(this);
    if (!this.isRival) requestAnimationFrame(this._frame);
  }

  Game.prototype.reset = function (seed, mode, level, trialKey, rivalIdx) {
    this.mode = mode || this.mode;
    // DUEL: the arena is DERIVED, never passed. Both dragons fight in ONE
    // cavern, so the arena is the one thing that cannot be allowed to differ
    // from what the picker showed -- letting a caller supply a seed would put
    // the fight on ground the card never named. One source of truth, here.
    this.rivalIdx = (this.mode === 'duel') ? clamp(rivalIdx | 0, 0, RIVALS.length - 1) : -1;
    this.rival = this.rivalIdx >= 0 ? RIVALS[this.rivalIdx] : null;
    this.duelSeedIdx = -1;
    if (this.rivalIdx >= 0) {
      // An explicit seed is honoured ONLY if it is one of DUEL_ARENAS -- that
      // is what lets a harness walk every (rival, arena) pair through the
      // ordinary code path instead of needing a private one. Any other value
      // (normal play passes 0) takes tonight's derived arena.
      var si = -1, sw = seed >>> 0;
      for (var ai = 0; ai < DUEL_ARENAS.length; ai++) if ((DUEL_ARENAS[ai].seed >>> 0) === sw) { si = ai; break; }
      this.duelSeedIdx = si >= 0 ? si : duelSeedIdx(this.rivalIdx);
      seed = DUEL_ARENAS[this.duelSeedIdx].seed;
    }
    this.seed = (seed >>> 0) || dailySeed();
    // level select: campaign takes the chosen map; the Daily rotates its map
    // as a PURE function of the seed, so every player fights the same layout
    if (this.mode === 'daily') this.levelIdx = setLevel(this.seed % CAMPAIGN_MAPS);
    else if (this.mode === 'duel') this.levelIdx = setLevel(duelMapAt(this.duelSeedIdx));
    else {
      // CLAMP TO THE CAMPAIGN RANGE. Leaving a duel calls reset(1, 'campaign')
      // with no level, which fell through to `this.levelIdx || 0` -- and after a
      // duel that is 5, a duel-only arena with no row in WAVE_TABLES. Both
      // totalWaves() and draw() threw on it the moment the title screen came up.
      // The last campaign level is remembered rather than clamped down to 2, so
      // quitting a duel does not silently move you three levels along.
      var lv = (level !== undefined) ? level : (this._campaignLevel || 0);
      this.levelIdx = setLevel(Math.min(lv | 0, CAMPAIGN_MAPS - 1));
      this._campaignLevel = this.levelIdx;
    }
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
    this._breathT = 0; this._spitT = 0; this._heroFace = 1; this._resultT = 0;
    this.nextId = 1;
    var hs = MAP.heroStart || { x: 210, y: 470 };
    this.hero = { x: hs.x, y: hs.y, tx: hs.x, ty: hs.y, range: 76, dmg: 9, rate: 1.25, cd: 0,
                  breathCd: 6, spd: 85, selected: false, castBreath: false,
                  manTid: -1, manned: false,     // manTid: stable tower id (survives splices)
                  face: -1,                      // +1 right / -1 left; see _heroFacing
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
    // ONE CAVERN, TWO SIDES. The duel used to build a SECOND Game and show it
    // in an inset (the Bloons Battles shape). VANUS described something else --
    // "we're both on the same map together" -- and this is that: a single sim,
    // a two-keep map, lane 0 yours and lane 1 hers, both dragons on screen.
    // The second-board machinery is gone rather than left dormant: two ways to
    // run a duel is one more than can be kept honest.
    this.rivalSide = this.mode === 'duel' && !!this.rival && sharedCavern();
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
    // A duel opens at wave 7 of the ramp, so it must open with the purse a
    // siege would have BUILT by then — otherwise it is an empty floor against
    // veterans, which is not hard, it is impossible. Measured, not guessed:
    // the bot's board at the end of wave 6 across the six arenas is 4-5
    // machines with mixed tiers plus ~130 in hand, ~850 of total income.
    // This is a MODE RULE, not forge power — the rival curves were baked
    // through this same line, so both caves open with the same money.
    if (this.mode === 'duel') this.gold = duelStartGold(DUEL_ARENAS[this.duelSeedIdx].at, duelMapAt(this.duelSeedIdx));
    // HER PURSE IS SET HERE, NOT ABOVE. It mirrors the player's opening gold,
    // and the duel purse is assigned on the line above -- reading it any
    // earlier hands her CFG.startGold (120 against 760) and she can afford one
    // machine all game, which reads as a broken opponent rather than a poor one.
    // HER PURSE IS THE LADDER. RIVALS[].purse -- 0.75 to 1.15 -- is what her
    // rank and her pips on the duel card MEAN: how much of the arena's opening
    // gold this hoardling salvaged. It used to be applied by the bot that BAKED
    // her curve, so when the duel became a live simulation the dial silently
    // stopped existing: every rival played off the player's exact purse, and
    // APPRENTICE and DRAKE differed only in their build plan. A difficulty
    // printed on a card and read by nothing is the same lie as a baked curve.
    this.rivalPurse = (this.rival && this.rival.purse) || 1;
    this.rivalGold = this.rivalSide ? Math.round(this.gold * this.rivalPurse) : 0;
    this.rivalManTid = -1;                  // set by _rivalTick; -1 never matches a tid
    // EVERY PIECE OF HER PER-RUN STATE, cleared here. _aiT survived a reset, so
    // a duel RETRY inherited the previous run's phase in her 0.5s beat grid and
    // her first build landed at a different moment -- a replay that is not a
    // replay. _spotKey is a one-slot cache keyed on (level, rank, side) and
    // would hand a new arena the previous one's shortlist.
    this._aiT = 0;
    this.rivalWick = null;
    this.rivalPrev = this.rivalHoard;
    this.rivalDrop = 0;
    this._spotKey = null; this._spotCache = null;
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
    // THE RIVAL'S CAVE IS NOT A VIEWPORT. This sizes the canvas from
    // window.innerWidth, so the opponent's board got a full window-sized canvas
    // and drew the world 1:1 into one corner of it -- the inset then showed the
    // cave squeezed into its top-left with dead space around it. It renders the
    // WORLD and nothing else, so its canvas is exactly the world and its view
    // is the identity: no letterbox, no safe area, no bands to fill.
    if (this.isRival) {
      this.canvas.width = WORLD_W; this.canvas.height = WORLD_H;
      this.view = { cw: WORLD_W, ch: WORLD_H, dpr: 1, scale: 1,
                    w: WORLD_W, h: WORLD_H, ox: 0, oy: 0, safeT: 0, safeB: 0 };
      return;
    }
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
    // A DUEL IS THE BACK HALF OF A SIEGE. Measured: baked flat at wave 12 with
    // three of six arenas ending 60-60 because the ramp had not bitten, and
    // stretching to 18 just bought nine more waves of nothing before the same
    // cliff. Offsetting the generator starts the fight already under pressure —
    // the Guild sent its veterans to both caves — so twelve waves are twelve
    // waves of actual contest instead of a countdown to one.
    var gw = (this.mode === 'duel') ? w + (DUEL_ARENAS[this.duelSeedIdx].at | 0) : w;
    var groups = this.waveGroups(w);
    var hpMul = seeded ? dailyHpMul(gw) : campHpMul(w, this.levelIdx);
    var q = [];
    for (var g = 0; g < groups.length; g++) {
      var gr = groups[g];
      for (var i = 0; i < gr.count; i++) {
        q.push({ t: gr.delay + i * gr.gap, type: gr.type, hpMul: hpMul * (gr.hpMul || 1) });
      }
    }
    q.sort(function (a, b) { return a.t - b.t || (a.type < b.type ? -1 : 1); });
    // WHICH ROAD.
    //
    // A DUEL SENDS THE SAME PARTY DOWN BOTH ROADS. It does NOT split one party
    // between them, which is what this did, and splitting cannot be made fair:
    // `k % 2` over a time-sorted queue hands index 0 to lane 0 every time, so
    // measured over the twelve duel waves the player's road got 128 raiders to
    // the rival's 121, 5.8% more total HP, the first spawn of EVERY wave, and --
    // because a boss is a group of ONE -- every boss in the mode. A mirror match
    // (identical plan, identical machines, both sides) ended 35 to 60, and that
    // 25-point gap was this line.
    //
    // Duplicating makes fairness structural instead of arithmetic: there is no
    // odd count to round, no single boss to place, and no argument to get wrong
    // later. It also restores the intended difficulty -- half a wave per side
    // made a duel road easier than a campaign one.
    if (this.rivalSide) {
      var both = [];
      for (var d2 = 0; d2 < q.length; d2++) {
        for (var ln2 = 0; ln2 < LANES.length; ln2++) {
          var c = { t: q[d2].t, type: q[d2].type, hpMul: q[d2].hpMul, ln: ln2 };
          both.push(c);
        }
      }
      return both;
    }
    // A multi-road CAMPAIGN map is one player defending every road, so there
    // splitting the party is right: it is one wave arriving by two routes.
    for (var k = 0; k < q.length; k++) q[k].ln = LANES.length > 1 ? k % LANES.length : 0;
    return q;
  };
  /// WHICH RAIDERS WAVE w BRINGS. One function, because the sim and the wave
  /// PREVIEW have to agree and they did not: the preview branched on 'daily'
  /// alone, so in a duel it read WAVE_TABLES[levelIdx] with levelIdx 5 against a
  /// three-entry table and threw `undefined[wave]` on EVERY frame of EVERY
  /// intermission. That is the whole draw call, so the duel screen died between
  /// waves -- shipped, and live on the site and the phone. The sim never saw it
  /// because the sim had the branch right; only the renderer was wrong.
  Game.prototype.waveGroups = function (w) {
    if (this.mode === 'daily') return dailyWaveComp(w, this.seed);
    if (this.mode === 'duel') {
      return dailyWaveComp(w + (DUEL_ARENAS[this.duelSeedIdx].at | 0), this.seed);
    }
    return WAVE_TABLES[this.levelIdx][w];
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
      // ONE SIM, ONE COUNTDOWN: calling the wave starts it for BOTH caves, so
      // the tempo reward has to reach both purses. It credited only yours, and
      // in a mode scored on the margin that is up to 77 gold across a duel that
      // the rival can never earn -- a structural, one-sided income stream. Hers
      // rides her purse like every other coin she takes in.
      if (this.rivalSide) this.rivalGold += Math.round(bonus * (this.rivalPurse || 1));
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
    this._waveStartHoard = this.hoard;   // cosmetic: lets the clear grade itself
    this._waveStartRivalHoard = this.rivalHoard;
    this.waveT = 0;
    this.countdown = 0;
    if (!this.isRival && !Save.data.tut && this.mode === 'campaign' && this.towers.length) {
      Save.data.tut = 1; Save.write();       // taught: build, then call the wave
    }
    // daily: the server-timed run token starts at the FIRST wave call
    if (this.mode === 'daily' && this.wave === 0) Lb.beginRun();
    Sfx.play('wave');
  };

  // ---- FIXED-TIMESTEP SIM. Deterministic. No ctx. No Math.random. --------
  /// ===== THE DIVIDE =======================================================
  /// In a shared cavern the two of you stand in ONE room, so almost every
  /// "for each raider" and "for each machine" loop in the sim can reach across
  /// the middle. Machine TARGETING was scoped when the duel was built
  /// (_pickTarget takes a lane), and that made it look solved. It was not:
  /// eleven other effects still crossed, and every one of them was a way the
  /// duel could be a lie.
  ///
  ///   Wick's toll paid HER carriers' coins into YOUR hoard. Measured: parking
  ///     him on her road with NO machines anywhere took the player 60 -> 99 --
  ///     past the hoard's own maximum -- and sacked her to 0. That is the whole
  ///     duel won by standing still on the other side of the room.
  ///   his breath, his fire and his contact damage fought her wave for her
  ///     (and every kill funded her, because a bounty pays the road it died on)
  ///   the overclock and the Bellows aura buffed whichever machine was nearest,
  ///     hers included
  ///   the rotor and the crystal tick radially, with no target to scope
  ///   a splash blast spilled across the divide
  ///   the Hoard King's war drum hurried allies on the other road
  ///   a sapper jammed the nearest machine, which near the middle is hers
  ///   Mother's Breath cleared BOTH roads
  ///   a Coin Press paid every press on the board into YOUR purse, and a Tithe
  ///     Press on either side fattened both sides' bounties
  ///   the Magnet Jaws fork shook coins into YOUR hoard whoever owned the jaw
  ///
  /// ONE predicate, used at every one of them, so the rule is greppable and a
  /// twelfth site cannot be added without meeting it. Outside a duel it is
  /// always true -- the campaign path is unchanged by construction, including
  /// the genuinely two-road maps 3 and 4, where one player owns both roads.
  Game.prototype._sameSide = function (a, b) {
    return !this.rivalSide || ((a | 0) === (b | 0));
  };
  /// Which machine the dragon on side `own` is crewing, or -1. Yours arrives
  /// on foot (hero.manned only goes true once he is AT the crank); hers is a
  /// render, so she is simply there.
  Game.prototype._mannedTid = function (own) {
    if (this.rivalSide && (own | 0) === 1) {
      return this.rivalManTid === undefined ? -1 : this.rivalManTid;
    }
    return this.hero.manned ? this.hero.manTid : -1;
  };
  /// distance^2 from a point to the nearest sample of the road `side` defends
  /// (or of ANY road on a map that is not split). Lifted out of _rivalSpots:
  /// her dragon needs the same measure to find the machine worth crewing.
  Game.prototype._roadD2 = function (x, y, side) {
    var best = 1e9;
    for (var li = 0; li < LANES.length; li++) {
      if (this.rivalSide && li !== (side | 0)) continue;
      for (var d = 0; d <= LANES[li].len; d += 12) {
        var q = pathPointAt(d, li), dx = x - q.x, dy = y - q.y;
        var v = dx * dx + dy * dy;
        if (v < best) best = v;
      }
    }
    return best;
  };
  /// Index of the nearest machine owned by `own` within Wick's reach, or -1.
  /// Split out of update() because BOTH dragons run it now.
  Game.prototype._nearestMachineTo = function (hx, hy, own) {
    var best = -1, bd = 62 * 62;
    for (var i = 0; i < this.towers.length; i++) {
      var t = this.towers[i];
      if (!this._sameSide(t.own, own)) continue;
      var dx = t.x - hx, dy = t.y - hy, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  };

  Game.prototype.update = function (STEP) {
    this.worldT += STEP;
    if (this.infoCard && (this.infoCard.t -= STEP) <= 0) this.infoCard = null;
    if (this.resultLockT > 0) this.resultLockT -= STEP;
    // THE RIVAL NEVER DRAINS THE PLAYER'S TAPS. Input is a module-level queue,
    // so an unguarded rival step swallows every tap before the player's own
    // sim sees it -- the game would simply stop responding during a duel.
    var taps = this.isRival ? EMPTY_TAPS : Input.drain();
    for (var ti = 0; ti < taps.length; ti++) {
      var preState = this.state;
      this._handleTap(taps[ti]);
      if (this.state !== preState) break;   // no same-frame chaining through screens
    }
    if (this.state !== 'playing') return;

    // hit-stop: an event-driven, DETERMINISTIC beat of frozen sim (same for
    // every replay of the same run -- it lives in the sim, not the renderer)
    if (this.hitstopT > 0) { this.hitstopT -= STEP; return; }

    // THE RIVAL PLAYS HER HALF OF THIS CAVERN. One sim, not two: she builds and
    // upgrades on her side out of her own purse while the same waves march down
    // both roads.
    // BELOW THE HIT-STOP GATE, not above it. A hit-stop is frozen SIM -- your
    // raiders, your machines and your dragon all stand still -- and her AI clock
    // was ticking straight through it, so every big hit on your road quietly
    // bought her a slice of build time.
    if (this.rivalSide) this._rivalTick(STEP);

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
        if (!this.isRival && !Save.data.seen[sp.type] && ENEMY_CARDS[sp.type]) {
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
          flashT: 0, ln: sp.ln | 0,
          px: laneOf(sp.ln).pts[0][0], py: laneOf(sp.ln).pts[0][1],
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
      // 'you are one wave from losing the hoard' used the same sound as 'a wave
      // is starting', which happens twenty times a level.
      Sfx.play('alarm', undefined, { pri: 2 });
    }
    if (this.castMother && this.motherReady) {
      this.castMother = false;
      this.motherReady = false;
      this.breathUsed = true;
      // YOUR ROAD ONLY. It wakes on YOUR hoard falling to 15, so in a duel it
      // used to be a free clearance of the rival's wave at the moment you were
      // losing -- and every kill it made on her road paid HER purse.
      for (var mb = 0; mb < this.enemies.length; mb++) {
        if (!this._sameSide(this.enemies[mb].ln, 0)) continue;
        this.enemies[mb].hp -= 60;
      }
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
        if (!this._sameSide(ally.ln, bossE.ln)) continue;   // his court, not hers
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
        // Summons scale like the spawner's units do. This gated on 'daily'
        // alone and read the UN-OFFSET wave, so in a duel the King's six
        // reinforcements arrived at base looter HP (30) while every other
        // raider in the same wave carried the ramp (x2.00 on the boss wave) --
        // and the duel now puts a King on BOTH roads, so it was twelve
        // under-scaled looters on the wave meant to be the fight's peak.
        // buildWave's own rule, verbatim: duel is seeded, and offset.
        var sWave = (this.mode === 'duel')
          ? this.wave + (DUEL_ARENAS[this.duelSeedIdx].at | 0) : this.wave;
        var sMul = (this.mode === 'daily' || this.mode === 'duel') ? dailyHpMul(sWave) : 1;
        for (var sm = 0; sm < bossB.summonAtHalf; sm++) {
          var lb = ENEMY_TYPES.looter;
          var sd = Math.max(0, bossE.d - sm * 14);
          var sp2 = pathPointAt(sd, bossE.ln);
          this.enemies.push({
            id: this.nextId++, type: 'looter', d: sd,
            hp: Math.round(lb.hp * sMul), maxHp: Math.round(lb.hp * sMul),
            spd: lb.spd, slowT: 0, slowF: 1, burnT: 0, burnDps: 0, bleedT: 0, bleedDps: 0,
            scaldT: 0, brittleT: 0, brittleMul: 1, deepT: 0, groundedT: 0, shaken: 0, sapT: 0,
            blinkT: 0, healT: 1, grabT: 0, auraF: 1,
            stolen: 0, fleeing: false, flyer: false, summoned: false, shieldBroken: false,
            flashT: 0, ln: bossE.ln | 0, px: sp2.x, py: sp2.y,
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
        // the King's OWN voice, shorter and higher -- so his enrage and his
        // death are audibly the same creature. Costs no new buffer.
        Sfx.play('popBoss', undefined, { rate: 1.5, pri: 1 });
      }
    }

    // -- tar patches expire on the world clock --
    for (var tx2 = this.tar.length - 1; tx2 >= 0; tx2--) {
      if (this.tar[tx2].until <= this.worldT) this.tar.splice(tx2, 1);
    }

    // -- enemies --
    // keepD is PER RAIDER now -- two roads are not the same length, so a
    // single hoisted PATH.len would let a raider on the short lane sack the
    // keep late and one on the long lane arrive before its road ended.
    for (var i = this.enemies.length - 1; i >= 0; i--) {
      var e = this.enemies[i];
      var base2 = ENEMY_TYPES[e.type];
      var keepD = laneLen(e.ln);
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
        if ((tpc.ln | 0) !== (e.ln | 0)) continue;   // d is per-ROAD; 300 on one is not 300 on the other
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
            if (!this._sameSide(o.ln, e.ln)) continue;   // he mends his own column
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
            if (!this._sameSide(e.ln, stw.own)) continue;   // it jams the road it walks
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
          var from = pathPointAt(e.d, e.ln);
          e.d = Math.min(keepD - 1, e.d + base2.blink);
          var to = pathPointAt(e.d, e.ln);
          this.fxQueue.push({ k: 'blink', x1: from.x, y1: from.y, x2: to.x, y2: to.y });
        }
      }
      // grab pause at the hoard
      if (e.grabT > 0) {
        e.grabT -= STEP;
        var gp2 = pathPointAt(e.d, e.ln); e.px = gp2.x; e.py = gp2.y;
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
          // YOUR LEAK, not the cavern's. stolenLost drives the STAR GRADE
          // (<=5 = 3 stars) and the "lost N" line on the result screen, so
          // counting coins that left HER hoard graded you on her defence.
          if (this._sameSide(e.ln, 0)) this.stolenLost += e.stolen;
          // THE LEAK LEDGER — who actually took the hoard, and when.
          // A player could previously only tell that "stuff got through": the
          // result screen reported a total and nothing else, so a loss carried
          // no information about what to do differently. Sim-side (not
          // cosmetic) because it is graded state and must be replay-identical.
          //
          // YOUR ROAD ONLY, for the same reason stolenLost is. The result
          // screen's WHO GOT THROUGH table has no rival gate, so a boss theft
          // on HER side printed as "BOSS -25 at wave 7" against your name.
          if (this._sameSide(e.ln, 0)) {
            var lk = this.leaks[e.type] || (this.leaks[e.type] = { coins: 0, runs: 0, firstWave: this.wave + 1 });
            lk.coins += e.stolen; lk.runs++;
          }
          this.enemies.splice(i, 1);
          // n is an ADDITIVE cosmetic payload on an event that already exists
          // to feed the render lane: reads e.stolen, writes nothing
          var em = laneOf(e.ln).pts[0];
          this.fxQueue.push({ k: 'escape', x: em[0], y: em[1], n: e.stolen, ln: e.ln | 0 });
          // her cave leaking must not sound your leak alarm
          if (this._sameSide(e.ln, 0)) Sfx.play('leak');
          continue;
        }
      } else {
        e.d += v;
        if (e.d >= keepD) {                                // reached the hoard: steal + turn
          // IT ROBS THE HOARD ON ITS OWN ROAD. In a shared cavern lane 1 ends
          // at the RIVAL's keep, so a raider that got through her defence must
          // take her gold and not yours -- the whole duel is which of you keeps
          // more, and a single shared counter cannot express that.
          var mine = !(this.rivalSide && (e.ln | 0) === 1);
          var pot = mine ? this.hoard : this.rivalHoard;
          var take = Math.min(base2.steals, pot);
          if (mine) this.hoard -= take; else this.rivalHoard -= take;
          e.stolen = take;
          e.fleeing = true;
          e.grabT = CFG.grabTime;
          e.d = keepD - 1;
          var kp = pathPointAt(keepD, e.ln);
          this.fxQueue.push({ k: 'steal', x: kp.x, y: kp.y, n: take, ln: e.ln | 0 });
          Sfx.play('steal');
          if (mine && this.hoard <= 0) { this._gameOver(false); return; }
          if (!mine && this.rivalHoard <= 0) { this._gameOver(true); return; }
        }
      }
      // cache the position ONCE per step — targeting, splash, heal, aura and
      // the renderer all read px/py instead of re-deriving pathPointAt each
      var pp = pathPointAt(e.d, e.ln); e.px = pp.x; e.py = pp.y;
    }

    // -- Overclock: the inventor at his machine. The nearest tower within
    // reach of Wick runs 25% faster — positioning is the input (deterministic).
    // ...ON HIS OWN SIDE. It took the nearest machine of EITHER owner, so
    // walking Wick to the middle sped up whichever of her machines sat closest.
    // And it ran for the player only: her dragon was a painting, which made
    // Cinder's card ("Works the cavern floor herself") a blurb over a hoardling
    // who did nothing at all. Both dragons work their own floor now.
    for (var oc0 = 0; oc0 < this.towers.length; oc0++) this.towers[oc0]._oc = false;
    var ocIdx = this._nearestMachineTo(this.hero.x, this.hero.y, 0);
    var ocIdxR = (this.rivalSide && this.rivalWick)
      ? this._nearestMachineTo(this.rivalWick.x, this.rivalWick.y, 1) : -1;
    // BELLOWS AURA — recomputed each step so selling a post takes its buff
    // with it. O(towers^2) but towers are a handful, not a crowd.
    for (var ai = 0; ai < this.towers.length; ai++) {
      var at = this.towers[ai];
      at._auraRate = 0; at._auraDmg = 0;
      if (TOWER_TYPES[at.type].support) continue;
      for (var aj = 0; aj < this.towers.length; aj++) {
        var src = this.towers[aj];
        if (src.type !== 'bellows') continue;
        if (!this._sameSide(src.own, at.own)) continue;   // her post buffs her brass
        var sr = lvlRow(src);
        var adx2 = at.x - src.x, ady2 = at.y - src.y;
        if (adx2 * adx2 + ady2 * ady2 > sr.range * sr.range) continue;
        // Read the hero directly: the _manned flags are stamped BELOW this loop,
        // so src._manned would be a frame stale and the buff would lag the art.
        if (src.jamT > 0) continue;            // a jammed post buffs nothing
        var sMan = this._mannedTid(src.own) === src.tid;
        var sBoost = sMan ? (TOWER_TYPES.bellows.mannedAura || 1) : 1;
        at._auraRate = Math.max(at._auraRate, (sr.auraRate || 0) * sBoost);  // strongest post wins,
        at._auraDmg = Math.max(at._auraDmg, (sr.auraDmg || 0) * sBoost);     // posts do NOT stack
      }
    }

    // MANNED beats mere proximity: Wick at the crank IS the buff, and it is
    // visible (he is sitting on the machine) instead of an invisible aura.
    for (var mi = 0; mi < this.towers.length; mi++) {
      var mtw2 = this.towers[mi];
      mtw2._manned = this._mannedTid(mtw2.own) === mtw2.tid;
      if (mtw2._manned) {
        mtw2._oc = false;
        if (ocIdx === mi) ocIdx = -1;
        if (ocIdxR === mi) ocIdxR = -1;
      }
    }
    if (ocIdxR !== -1) this.towers[ocIdxR]._oc = true;
    if (ocIdx !== -1) {
      this.towers[ocIdx]._oc = true;
      // ONLY YOURS IS ANNOUNCED. Her side floats nothing -- the same rule her
      // builds already follow: a label over her cave spends your attention.
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
        // HER MACHINE, HER DRAGON. This read this.hero for every machine on the
        // board, so your Wick standing near the divide was clearing HER jams --
        // the one raider that punishes a built board, countered for her, by you.
        var jw = (this.rivalSide && (tw.own | 0) === 1) ? this.rivalWick : this.hero;
        var pry = 1;
        if (jw) {
          var jdx = jw.x - tw.x, jdy = jw.y - tw.y;
          var jd2 = jdx * jdx + jdy * jdy;
          pry = (this._mannedTid(tw.own) === tw.tid) ? 5 : jd2 < 52 * 52 ? 2.5 : 1;
        }
        tw.jamT -= STEP * pry;
        if (tw.jamT <= 0 && pry > 1 && this._sameSide(tw.own, 0)) {
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
      // AIM EVERY STEP, NOT ONLY WHEN IT FIRES. _aimX/_aimY -- the only thing
      // the renderer turns the barrel by -- were written down in the FIRE path,
      // below the cooldown gate. So a crossbow updated its aim once every
      // 1/rate seconds (0.83s at level 1) and spent the gap pointing at where
      // its target USED to be. Raiders move 42-76 units/s, so the barrel was
      // routinely aimed at empty road a whole body-length behind the raider it
      // was shooting -- which is precisely "the crossbows still dont point
      // towards the enemy". Tracking is a RENDER fact and belongs on every
      // frame; firing stays on the cooldown.
      if (tt.aims) {
        var aimT = this._pickTarget(tw, lvlRow(tw).range * (this.mods.rangeMul || 1),
                                    tt.hitsAir, tt.airBonus, tw.targeting | 0,
                                    this.rivalSide ? (tw.ln | 0) : -1);
        if (aimT) { tw._aimX = aimT.px; tw._aimY = aimT.py; }
      }
      if (tw.cd > 0) continue;
      var pad = tw;
      // crystal: pulse-slow everything in range, no target needed.
      // BACKWARDS: _damage can kill+splice, and a forward loop would skip
      // the enemy shifted into the vacated slot.
      if (tw.type === 'rotor') {
        // THE WHIRLYJACK. Deliberately the crystal's shape: a targetless radial
        // tick with no _pickTarget, no projectile and no muzzle, and therefore
        // -- like the crystal -- no eFly test, which is the entire point. It is
        // the only machine in the game that does AREA damage to flyers.
        var rHitAny = 0;
        var rR = lv.range * (this.mods.rangeMul || 1);
        var rDmg = lv.dmg * (this.mods.dmgMul || 1) * (tw._manned ? 1.3 : 1)
                          * (1 + (tw._auraDmg || 0));
        // every 4th sweep on the Threshing fork shoves the ring back down the
        // road. A pure counter on the machine, no roll.
        var rThresh = lv.special === 'thresh' &&
                      (((tw.sweeps = (tw.sweeps | 0) + 1) % lv.threshEvery) === 0);
        for (var ro = this.enemies.length - 1; ro >= 0; ro--) {
          var re2 = this.enemies[ro];
          if (re2.hp <= 0) continue;
          if (!this._sameSide(re2.ln, tw.own)) continue;   // radial: no target to scope it
          var rdx = re2.px - pad.x, rdy = re2.py - pad.y;
          if (rdx * rdx + rdy * rdy > rR * rR) continue;
          // airMul keys on e.flyer, NOT eFly(e): eFly is false while a
          // Netcaster's net holds a flyer down, so keying on it would make the
          // game's two anti-air answers cancel instead of stack.
          var rMul = (lv.special === 'updraft' && re2.flyer) ? lv.airMul : 1;
          this._damage(re2, rDmg * rMul, { kind: 'blade', tower: tw });
          // NEVER push a fleeing raider: e.d is the path's arc-length address,
          // so subtracting from a carrier on the way OUT would shove them
          // toward the cave mouth -- the machine would help them escape.
          if (rThresh && re2.hp > 0 && !re2.fleeing) {
            re2.d = Math.max(0, re2.d - lv.threshPush);
          }
          rHitAny++;
        }
        if (rHitAny) {
          tw.shotT = 0;
          this.fxQueue.push({ k: 'pulse', x: pad.x, y: pad.y, r: rR, n: rHitAny, c: '#e8eef5' });
          Sfx.play('whirl', tw.tid, { gain: Math.min(1, 0.55 + rHitAny * 0.12), pri: 1 });
        }
        tw.cd = rHitAny ? 1 / (lv.rate || 1) : 0.1;
        continue;
      }
      if (tw.type === 'crystal') {
        var hitAny = 0;
        for (var c = this.enemies.length - 1; c >= 0; c--) {
          var ce = this.enemies[c];
          if (ce.hp <= 0) continue;
          if (!this._sameSide(ce.ln, tw.own)) continue;   // radial: no target to scope it
          var cR = lv.range * (this.mods.rangeMul || 1);
          var cdx = ce.px - pad.x, cdy = ce.py - pad.y;
          if (cdx * cdx + cdy * cdy <= cR * cR) {
            ce.slowF = Math.min(ce.slowF, ce.type === 'boss' ? 0.75 : 1 - lv.slow);
            // max, not assign: a weaker crystal must never TRUNCATE a deep
            // chill (deepT <= slowT must hold — blink immunity reads slowT)
            ce.slowT = Math.max(ce.slowT, lv.slowDur);
            if (lv.special === 'deepchill') ce.deepT = lv.slowDur;
            if (lv.special === 'resonance') { ce.brittleT = lv.slowDur; ce.brittleMul = lv.brittleMul; }
            // _auraDmg WAS MISSING HERE and present at every other machine's
            // damage line. The Bellows' RATE aura does reach the crystal (it is
            // applied to the cooldown above this branch), so the bug was
            // asymmetric and therefore invisible: a 360g support fork whose
            // entire pitch is "+28% damage to neighbours" did nothing at all
            // for the cheapest and most-built tower on the board.
            // Balance note: nothing is baked any more, so a change here retunes
            // the rival the moment it lands -- she plays this sim, not a table.
            if (lv.dmg) this._damage(ce, lv.dmg * (this.mods.dmgMul || 1) * (tw._manned ? 1.3 : 1)
                                         * (1 + (tw._auraDmg || 0)), { kind: 'magic', tower: tw });
            hitAny++;
          }
        }
        if (hitAny) tw.shotT = 0;
        // A WHOLE MACHINE WITH NO SOUND AT ANY BEAT. The Gemsinger is the
        // cheapest tower in the game and fires ~1/s, so it is very likely the
        // most-built thing on the board — and it made no noise at all. The
        // chime brightens with the number of raiders the pulse actually
        // caught, so a wide catch RINGS and a single tick does not.
        //
        // ...which was true of the PARTICLE and false of the SOUND from the day
        // that sentence was written: hitAny reached `n:` and nothing else, so
        // every pulse chimed identically. It is a deterministic count of sim
        // state, so riding gain and pitch on it consumes nothing seeded.
        if (hitAny) {
          this.fxQueue.push({ k: 'pulse', x: pad.x, y: pad.y, r: lv.range, n: hitAny });
          Sfx.play('chime', tw.tid, { gain: Math.min(1, 0.6 + hitAny * 0.14),
                                      rate: 1 + Math.min(4, hitAny) * 0.05, pri: 1 });
        }
        tw.cd = hitAny ? 1 / lv.rate : 0.1;   // idle rescan at 6 Hz, not 60
        continue;
      }
      var mDmg = (this.mods.dmgMul || 1) * (tw._manned ? 1.3 : 1) * (1 + (tw._auraDmg || 0)), mRng = this.mods.rangeMul || 1;
      var target = this._pickTarget(pad, lv.range * mRng, tt.hitsAir, tt.airBonus, tw.targeting | 0,
                                    this.rivalSide ? (tw.ln | 0) : -1);
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
      var mz0 = this._muzzleOf(tw, tp.x, tp.y);
      if (tw.type === 'mimic') {                            // instant bite
        tw.shotT = 0;
        this._damage(target, lv.dmg * mDmg, { kind: 'melee', tower: tw });
        if (lv.special === 'rend') { target.bleedT = lv.rendDur; target.bleedDps = lv.rendDps; }
        // Magnet Jaws: shake a stolen coin home (cap 2/raider). Losing weight
        // makes the thief RUN FASTER — you save the coin, not the bounty.
        if (lv.special === 'coinback' && target.hp > 0 && target.stolen > 0 && target.shaken < lv.coinCap) {
          target.stolen--; target.shaken++;
          // back to the pile it was taken from, which is not always yours
          if (this.rivalSide && (tw.own | 0) === 1) this.rivalHoard++; else this.hoard++;
          this.fxQueue.push({ k: 'recover', x: tp.x, y: tp.y, n: 1, ln: target.ln | 0 });
        }
        this.fxQueue.push({ k: 'bite', x: tp.x, y: tp.y });
        // Gearjaw grinds; Magnet Jaws snaps. Both forks used to make the one
        // sound, so the choice you commit a machine to for the rest of the run
        // was inaudible. The fx is queued here and SPENT in _cosmetic() -- a
        // particle spawned beside this line would be a cosmetic draw on the
        // fixed-step path.
        if (lv.special === 'rend') {
          this.fxQueue.push({ k: 'grind', x: tp.x, y: tp.y });
          Sfx.play('grind', tw.tid, { pri: 1 });
        } else {
          Sfx.play('bite', tw.tid);
        }
      } else if (tw.type === 'brazier') {                   // lobbed splash
        tw.shotT = 0;
        this.fxQueue.push({ k: 'muzzle', x: mz0.x, y: mz0.y, tx: tp.x, ty: tp.y });
        this.projectiles.push({
          kind: 'lob', x: mz0.x, y: mz0.y, sx: mz0.x, sy: mz0.y, tx: tp.x, ty: tp.y,
          t: 0, dur: 0.55, dmg: lv.dmg * mDmg, splash: lv.splash, burn: lv.burn || 0, tower: t,
          own: tw.own | 0,          // the blast is scoped by WHO FIRED IT, not by
                                    // towers[pr.tower] -- that index goes stale on a sell
          scald: lv.special === 'scald' ? lv.scaldDur : 0,
          // Tar Boiler: the patch lands at the TARGET's path distance at fire
          // time — 1D arc-length address, deterministic, no inverse projection.
          // Keyed by PAD, not array index: a sell splices the towers array.
          tar: lv.special === 'tarpatch' ? { d: target.d, ln: target.ln | 0, w: lv.tarWidth, dps: lv.tarDps, dur: lv.tarDur, max: lv.maxPatches, tid: tw.tid } : null,
        });
        Sfx.play('lob', tw.tid);
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
          kind: 'bolt', x: mz0.x, y: mz0.y, target: target.id, spd: 340,
          dmg: dmg, crit: crit, hops: lv.pierce || 0,
          shieldbreak: lv.special === 'shieldbreak',
          net: lv.special === 'downdraft' ? lv.groundDur : 0, tower: t,
        });
        // the STRING SNAP: a real crossbow releases, it doesn't just emit
        // AT THE MUZZLE. This fired at (pad.x, pad.y-26) — the machine's middle —
        // so after shots moved to the bow the release flashed ~25px away from
        // where the bolt actually left. My own residue, caught by the audit.
        this.fxQueue.push({ k: 'snap', x: mz0.x, y: mz0.y, tx: tp.x, ty: tp.y });
        Sfx.play(tw.type === 'perch' ? 'stone' : 'bow', tw.tid);
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
            this.tar.push({ d: pr.tar.d, ln: pr.tar.ln | 0, w: pr.tar.w, dps: pr.tar.dps, until: this.worldT + pr.tar.dur, tid: pr.tar.tid });
          }
          // BACKWARDS: _damage can kill+splice mid-loop
          var caught = 0;
          for (var b = this.enemies.length - 1; b >= 0; b--) {
            var be = this.enemies[b];
            if (eFly(be) || be.hp <= 0) continue;
            if (!this._sameSide(be.ln, pr.own)) continue;   // the blast stops at the divide
            var bdx = be.px - pr.tx, bdy = be.py - pr.ty;
            if (bdx * bdx + bdy * bdy <= pr.splash * pr.splash) {
              this._damage(be, pr.dmg, { kind: 'splash', tower: this.towers[pr.tower] });
              if (pr.burn) { be.burnT = 3; be.burnDps = Math.max(be.burnDps, pr.burn); }
              if (pr.scald) be.scaldT = pr.scald;  // Whistlepot: heal-block rides the burn (duration is DATA)
              caught++;
            }
          }
          // A BLAST THAT CATCHES FIVE MUST SOUND BIGGER THAN ONE THAT CATCHES
          // ONE. This played `hit` -- a bolt graze, measured 0.98 identical to
          // `thud` -- once, unkeyed, regardless of the catch. The Soot Brazier
          // is the splash machine, the one that teaches the Bloons lesson the
          // Hogshead was built for, and its blast was the least audible
          // thing on the board. `caught` is a deterministic count of sim state;
          // the gain rides on the far side of Sfx.play, cosmetic lane.
          Sfx.play('fwoomph', pr.tower, { gain: Math.min(1, 0.55 + caught * 0.15), pri: 1 });
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
          Sfx.play('fireimp', pr.target, { pri: 1 });   // it landed in silence
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
          // THE BACK HALF OF THE LIFECYCLE WAS SILENT. A bolt crossing the cave
          // and connecting made no sound whatsoever, so the shot had a beginning
          // and no end. A crit now lands differently from a graze, which is the
          // whole point of a countable crit nobody could hear.
          // ONE impact, one sound. This used to fire TWICE in the same frame:
          // `crunch`/`thud` here, then `upg`/`hit` six lines below -- so every
          // graze burned two of the (then eight) voice slots to make one
          // mushier sound, and a crit played the TOWER-UPGRADE JINGLE, which
          // taught the player that the game's most skill-adjacent event is a
          // menu confirmation. The second call is gone; this one carries it.
          Sfx.play(pr.crit ? 'crunch' : 'thud', pr.target, { pri: 1 });
          // Carry the bolt's HEADING into the impact so the sparks spray off the
          // hit instead of puffing symmetrically — the direction was always right
          // there in the projectile and the effect threw it away.
          this.fxQueue.push({ k: 'hit', x: gp.x, y: gp.y, c: pr.crit ? '#ff9a3c' : '#ffd75e',
                              dx: pr.dx || 0, dy: pr.dy || 0, big: pr.crit ? 1 : 0 });
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
    if (Math.abs(hdx) > 0.5) h.face = hdx > 0 ? 1 : -1;      // walking sets his look
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
      if (!this._sameSide(hz_e.ln, 0)) continue;   // her carriers are not his to shake
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
        // Nine seconds with no breath, no manning, no jam-clearing -- and it
        // shared its sound with a single coin leaving the cave. pri 2 on
        // purpose: losing Wick outranks any crossbow twang in the pool.
        Sfx.play('herodown', undefined, { pri: 2 });
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
      if (!this._sameSide(en2.ln, 0)) continue;   // he defends one road: his
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
      // TURN TO WHAT HE IS SHOOTING. Standing still leaves (tx - x) at zero, so
      // without this he keeps whatever way he last walked and breathes fire
      // backwards over his own shoulder.
      if (Math.abs(h.tx - h.x) <= 0.5 && !h.manned) {
        h.face = (pick.px - h.x) >= 0 ? 1 : -1;
      }
      // He spits FIRE, and it looks like fire: a travelling fireball that
      // bursts on the target (the old tell was a 1px tracer nobody could see).
      // FROM HIS MOUTH. This was (h.x, h.y - 14): no forward offset at all and
      // 14 units above his FEET, on a dragon 58 units tall whose mouth sits at
      // 0.685 of that -- so the fireball left his chest, 21 units low and 18
      // short, while the plate above it opened its jaws. VANUS: "the fireball
      // from Wick seems to come from the middle of him not from his mouth, even
      // though his mouth is opening."
      //
      // _muzzle() is the same anchor the BREATH was moved onto when it had this
      // exact bug; the fireball simply never got the fix. It also follows him up
      // onto a machine, which the hardcoded offset could not -- crewing lifts him
      // ~27 units and the fire went on leaving from the floor.
      var fmz = this._muzzle(false);
      this.projectiles.push({ kind: 'fire', x: fmz.x, y: fmz.y, target: pick.id,
                              spd: 300, dmg: h.dmg, hero: true });
      this.fxQueue.push({ k: 'muzzle', x: fmz.x, y: fmz.y, tx: pick.px, ty: pick.py, hero: true });
      Sfx.play('flame');
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
      // EVERY PRESS ON THE BOARD PAID YOU, hers included. Each press pays the
      // purse of whoever built it, and hers is silent for the same reason her
      // builds are: a float over her cave spends your attention.
      var minted = 0, rMinted = 0;
      for (var pz = 0; pz < this.towers.length; pz++) {
        var pt2 = this.towers[pz];
        if (pt2.type !== 'press') continue;
        var pr2 = lvlRow(pt2);
        if (!pr2.waveGold || pt2.jamT > 0) continue;   // a jammed press mints nothing
        var pMan = this._mannedTid(pt2.own) === pt2.tid;
        var pay = Math.round(pr2.waveGold * (pMan ? (TOWER_TYPES.press.mannedGold || 1) : 1));
        if (this.rivalSide && (pt2.own | 0) === 1) { rMinted += pay; continue; }
        minted += pay;
        this.fxQueue.push({ k: 'float', x: pt2.x, y: pt2.y - 40, txt: '+' + pay + 'g', c: '#ffd75e' });
      }
      if (rMinted) this.rivalGold += Math.round(rMinted * (this.rivalPurse || 1));
      if (minted) { this.gold += minted; Sfx.play('coin'); }
      // WAVE CLEAR IS THE HEARTBEAT OF THIS MODE — 20 times a level — and it
      // used to be one green word and silence. It now lands, and it CARRIES
      // INFORMATION: a wave where nothing reached the hoard is the thing the
      // whole game is about, and the player was never told they had done it.
      // Deliberately restrained (no hitstop, no big shake): a beat you feel 20
      // times a level must never become something you brace for.
      var clean = this._waveStartHoard !== undefined && this.hoard >= this._waveStartHoard;
      this.fxQueue.push({ k: 'float', x: WORLD_W / 2, y: 300,
                          txt: clean ? 'WAVE ' + this.wave + ' — NOT A COIN!' : 'Wave ' + this.wave + ' held!',
                          c: clean ? '#ffd75e' : '#9ef58f' });
      this.fxQueue.push({ k: 'pulse', x: WORLD_W / 2, y: 330, r: clean ? 118 : 84, n: 1 });
      if (clean) this.shake = Math.min(1, this.shake + 0.12);
      // a clean wave played `upg`, the SHOP jingle: the proudest beat in the
      // game sounded like a menu confirmation.
      Sfx.play(clean ? 'clear' : 'wave');
      // ---- THE RIVAL'S WAVE ------------------------------------------------
      // Their cave took the same wave at the same time. Step their hoard off
      // the baked curve and SAY what it cost them — a number that only moves
      // in the corner of the HUD is a scoreboard; a number that announces
      // itself the moment yours moves is an opponent.
      if (this.mode === 'duel' && this.rival) {
        // LIVE. Every duel arena is the shared cavern, so rivalSide is always
        // true here and this is simply her hoard -- the branch that read a
        // baked curve was unreachable before it was deleted.
        //
        // MEASURE THE DROP AGAINST THE WAVE'S START. When her hoard came off a
        // table, `prev` was the previous ROW and the subtraction meant something.
        // Reading it off the live value one line before overwriting it with the
        // same number makes the drop identically zero, so the duel announced
        // "held clean" after every wave of every duel, including the ones that
        // sacked her. Her own _waveStartRivalHoard is the honest `prev`.
        var rh = Math.round(this.rivalHoard);
        if (rh !== null) {
          this.rivalPrev = (this._waveStartRivalHoard === undefined)
            ? this.rivalHoard : this._waveStartRivalHoard;
          this.rivalHoard = rh;
          this.rivalDrop = Math.max(0, Math.round(this.rivalPrev) - rh);
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

  // HEXER exists because NOTHING could target the healer. The Greed Hexer
  // restores 10hp inside 63 units and its only counter in the whole roster was
  // one 350g fork (Whistlepot's scald); STRONG is keyed on hp, so it reliably
  // picks the Bulwark standing NEXT to the Hexer instead of the Hexer.
  var AIM_MODES = ['FIRST', 'STRONG', 'LAST', 'HEXER'];
  Game.prototype._pickTarget = function (pad, range, hitsAir, airBonus, mode, padLane) {
    padLane = (padLane === undefined) ? -1 : padLane;
    // Fleeing thieves ALWAYS lead (they carry OUR gold), closest-to-escaping
    // first. The player-set mode picks the focus among marchers:
    //   FIRST = furthest along · STRONG = most HP · LAST = newest arrivals.
    // Deterministic tie-break on id.
    var best = null, bestKey = -Infinity;
    for (var i = 0; i < this.enemies.length; i++) {
      var e = this.enemies[i];
      if (e.hp <= 0) continue;
      if (eFly(e) && !hitsAir) continue;    // a netted flyer is fair game for anyone
      // IN A SHARED CAVERN A MACHINE DEFENDS ITS OWN ROAD. The two roads run
      // close enough at the top that a machine near the divide can otherwise
      // reach across and shoot the rival's raiders -- helping the opponent, or
      // being blamed for not helping. Ownership decides who it fires at.
      if (padLane >= 0 && (e.ln | 0) !== padLane) continue;
      var dx = e.px - pad.x, dy = e.py - pad.y;
      if (dx * dx + dy * dy > range * range) continue;
      // LANE-CORRECT METRICS. These order raiders that may be on DIFFERENT
      // roads, and the roads are not the same length, so a shared PATH.len is
      // no longer a constant and stops cancelling. Rewritten in the forms that
      // do not reference any road length at all where possible:
      //   fleeing / LAST  -- "smallest d" is what both mean; -e.d says it
      //                      directly and is identical in order to the old
      //                      PATH.len - e.d on a one-road map (a constant).
      //   FIRST           -- means CLOSEST TO THE KEEP, which across lanes is
      //                      least distance REMAINING, not greatest d.
      var metric;
      if (e.fleeing) metric = -e.d;
      else if (mode === 1) metric = e.hp * 0.001;           // STRONG
      else if (mode === 2) metric = -e.d;                   // LAST
      else metric = e.d - laneLen(e.ln);                    // FIRST
      // HEALERS FIRST. Weighted 7e5, ABOVE the flyer bonus of 5e5 -- at 2e5 it
      // would sit below it and a Gloomwing would still outrank the Hexer on
      // every air-capable machine, which is most of them. Still below the
      // fleeing-thief lead at 1e6: someone carrying our gold outranks everyone.
      var hexPref = (mode === 3 && ENEMY_TYPES[e.type].heals) ? 7e5 : 0;
      var key = (e.fleeing ? 1e6 : 0) + hexPref
              + (eFly(e) && airBonus ? 5e5 : 0) + metric - e.id * 1e-7;
      if (key > bestKey) { bestKey = key; best = e; }
    }
    return best;
  };
  Game.prototype._nextBehind = function (tgt) {
    // SAME ROAD ONLY. "Behind" is a position along a path, and two raiders on
    // different roads have no ordering -- without this the pierce would jump
    // the cavern to a raider it never passed through.
    var best = null;
    for (var i = 0; i < this.enemies.length; i++) {
      var e = this.enemies[i];
      if (e === tgt || e.hp <= 0 || eFly(e)) continue;
      if ((e.ln | 0) !== (tgt.ln | 0)) continue;
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
      if (opts.shieldbreak) {
        e.shieldBroken = true;
        var sbp = pathPointAt(e.d, e.ln);
        this.fxQueue.push({ k: 'float', x: sbp.x, y: sbp.y - 16, txt: 'shield broken!', c: '#c9d2dd' });
        // Permanent, run-changing, and it made no sound at all. The keg's own
        // voice dropped low: staves letting go. After this every bolt into this
        // Shellback lands soft instead of clanging -- that IS the mechanic.
        Sfx.play('popWood', e.id, { rate: 0.78, pri: 2 });
      }
      // A DEFLECT SOUNDED EXACTLY LIKE A CLEAN HIT, so the one raider that
      // punishes bolt spam gave the player no audible reason to switch.
      else { dmg *= 0.5; Sfx.play('clang', e.id); }
    }
    // Tuning Fork: a brittle (chill-rung) raider takes +25% from EVERY tower
    if (e.brittleT > 0) dmg *= e.brittleMul;
    // Bulwark armor shaves flat damage off every direct hit (min 1);
    // magic (Gemsinger pulse) and breath ignore armor
    if (base.armor && opts.kind !== 'breath' && opts.kind !== 'magic') {
      var raw = dmg;
      dmg = Math.max(1, dmg - base.armor);
      // ARMOUR ATE PART OF THAT HIT, AND THE GAME NEVER SAID SO. A Bulwark
      // shaves a flat 5 off every direct hit, which is most of a level-1
      // crossbow bolt (12) -- so a player watching their bolts do nothing had
      // no signal telling them to bring flame or magic instead, the two kinds
      // that skip this branch. A short metal scrape is that signal. Keyed on
      // the raider so a rank of Bulwarks scrapes once each, not once total.
      if (raw - dmg >= 2) Sfx.play('shave', e.id, { gain: 0.75, pri: 1 });
    }
    e.hp -= dmg;
    // DO NOT STACK, AND KEEP IT SHORT. This reset to 0.1 on EVERY damage
    // instance, and the renderer drew it at alpha min(1, flashT*9) = 0.9 white
    // with a 9% size pop. A raider inside eight machines takes several hits a
    // second, so it never stopped flashing -- VANUS: "the enemies as well,
    // which is flashing and looks broken". A hit should punctuate, not strobe:
    // max() rather than assign so rapid hits cannot re-arm a flash already
    // running, and it is shorter and much softer below.
    e.flashT = Math.max(e.flashT, 0.07);
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
    // WHOSE ROAD THIS DIED ON decides which presses take a cut. Without it a
    // Tithe Press on either side fattened both sides' bounties.
    var kSide = this.rivalSide ? (e.ln | 0) : 0;
    for (var kp = 0; kp < this.towers.length; kp++) {     // Tithe Press takes its cut
      var kt = this.towers[kp];
      if (!this._sameSide(kt.own, kSide)) continue;
      if (kt.level >= 2 && kt.type === 'press') {
        var kr = lvlRow(kt);
        if (kr.killGold) {
          var kMan = this._mannedTid(kt.own) === kt.tid;
          bounty += Math.round(kr.killGold * (kMan ? (TOWER_TYPES.press.mannedGold || 1) : 1));
        }
      }
    }
    // THE BOUNTY GOES TO WHOEVER'S ROAD IT DIED ON. She has to fund her own
    // cave out of her own kills or the duel is not symmetric -- a scripted
    // purse would make her economy a difficulty dial rather than a game.
    // ...and it scales her EARNINGS too, not just her opening purse. Handicapping
    // the first purse alone was measured to do nothing: bounty income washes the
    // difference out by wave three. "Earns less per wave" is a faithful model of
    // a weaker board rather than a fudge -- her bounties come from her kills.
    if (this.rivalSide && (e.ln | 0) === 1) {
      this.rivalGold += Math.round(bounty * (this.rivalPurse || 1));
    } else this.gold += bounty;
    // YOUR kill count, not the cavern's. It is printed on the result screen as
    // something you did.
    if (this._sameSide(e.ln, 0)) this.kills++;
    var p = { x: e.px, y: e.py };
    if (e.stolen > 0) {                                     // recover the treasure!
      // back to the pile it came out of
      if (this.rivalSide && (e.ln | 0) === 1) this.rivalHoard += e.stolen;
      else this.hoard += e.stolen;
      this.fxQueue.push({ k: 'recover', x: p.x, y: p.y, n: e.stolen, ln: e.ln | 0 });
      Sfx.play('recover');
    }
    // SPLITTER — breaks into two smaller raiders where it fell. Queued as a
    // spawn so the halves enter through the same path the sim already owns.
    if (base.splitInto && !e.summoned) {
      var sb = ENEMY_TYPES[base.splitInto];
      for (var sp2 = 0; sp2 < base.splitCount; sp2++) {
        this.enemies.push({
          id: this.nextId++, type: base.splitInto, ln: e.ln | 0,
          d: Math.max(0, Math.min(laneLen(e.ln) - 1, e.d + (sp2 ? 9 : -9))),
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
    this.fxQueue.push({ k: 'death', x: p.x, y: p.y, g: bounty, boss: e.type === 'boss', ln: e.ln | 0 });
    // THE KILL. This was `Sfx.play('coin')` -- one 200ms chime, unkeyed, for all
    // ten raider types and for the boss, sharing its rate-limit bucket with the
    // Coin Press payout. Three separate faults in one line:
    //   1. no variety      -- a Scrapling and The Hoard King sounded identical;
    //   2. no polyphony    -- unkeyed + RATE_MS.coin=70 meant a Brazier splash
    //                         that killed five raiders in one step played ONE
    //                         sound and dropped four, so the BIGGER the kill the
    //                         LESS you heard. Keyed on e.id, five kills are five;
    //   3. no priority     -- it lost its voice slot to crossbow twangs.
    // Selection and rate are pure functions of e.type / maxHp -- deterministic
    // sim state -- so nothing here touches the seeded stream.
    Sfx.kill(e.type, e.maxHp || ENEMY_TYPES[e.type].hp, e.id);
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
    // THE RIVAL'S CAVE ENDING IS NOT THE PLAYER'S RUN ENDING. This writes
    // stars, duel records, daily bests and the leaderboard queue; a live
    // opponent reaching wave 12 must set its own state and nothing else.
    if (this.isRival) { this.state = won ? 'won' : 'lost'; return; }
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
    // THE 2-STAR BAND WAS UNREACHABLE. The King steals 25 in a single grab
    // (ENEMY_TYPES.boss.steals) and every other raider steals 1-5, so a
    // ceiling of 20 could not separate 'the King got through once' from 'you
    // were robbed all game' -- across ~110 measured runs not one landed in
    // the 6-20 band, and grades were only ever 0, 1 or 3. The ceiling has to
    // clear the single largest theft event or the middle grade is decoration.
    // Moving the THRESHOLD rather than boss.steals is deliberate: ENEMY_TYPES
    // is shared with the Daily (a boss every 10th wave), so cutting the steal
    // would make the shared fight easier and invalidate the leaderboard.
    //   3* = the King never reached the hoard and nothing else got out
    //   2* = you held the cave and the King robbed you once
    //   1* = you were leaking before the finale
    var stars = this.stolenLost <= 5 ? 3 : this.stolenLost <= 28 ? 2 : 1;
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
      // AN OPEN MENU OWNS THE SCREEN. This only scanned a 32-unit disc around a
      // tower, but _menuBtnPos lays its buttons on an arc of radius 56 -- so a
      // machine built near the shop, START WAVE or the breath button had menu
      // buttons UNDER those rects, and the HUD claimed the tap first. Measured:
      // 4 authored pads and 7-11% of the free-build floor own machines that
      // cannot be upgraded, manned, re-aimed or sold. While a menu is open,
      // every HUD band defers.
      var twUnder = !!(this.menu && this.menu.towerIdx !== undefined);
      if (!twUnder && this.shopPick < 0) {        // a machine in hand still places
        for (var tu = 0; tu < this.towers.length; tu++) {
          var tud = this.towers[tu], ux = w.x - tud.x, uy = w.y - tud.y;
          if (!this._sameSide(tud.own, 0)) continue;   // hers opens no menu to defer for
          if (ux * ux + uy * uy < 32 * 32) { twUnder = true; break; }
        }
      }
      if (!armedOverGround && !twUnder) {
        if (!this.waveActive && this.wave < this.totalWaves() &&
            vx >= G.cx - 92 && vx <= G.cx + 92 && vy >= G.startY && vy <= G.startY + 52) {
          this.startWave(); return;
        }
        // THE RETURN USED TO BE UNCONDITIONAL while the button is only DRAWN
        // when !breathOff -- so under the Smothered Fire trial ("Wick's flame is
        // out. The machines answer alone.") a 62x62-unit patch of buildable
        // cavern floor swallowed every tap for the whole run, with nothing on
        // screen to explain it. Gate the hit test on the same predicate that
        // decides whether the button exists, and the tap falls through to the
        // world path exactly as it does everywhere else.
        if (!this.mods.breathOff &&
            vx >= G.breathX && vx <= G.breathX + 62 && vy >= G.breathY && vy <= G.breathY + 62) {
          // ...and a tap while it is COOLING used to vanish silently too. Same
          // idiom as the 'no raiders in reach' refusal: answer, do not swallow.
          if (this.hero.breathCd > 0) {
            this.fxQueue.push({ k: 'float', x: this.hero.x, y: this.hero.y - 40,
                                txt: Math.ceil(this.hero.breathCd) + 's until the flame', c: '#8a7f72' });
          } else this.hero.castBreath = true;
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
      // ...and the shop row needs the same deferral START/BREATH already have:
      // with a machine armed over buildable ground, the card band was still
      // claiming the tap and re-arming a different card instead of building.
      if (!armedOverGround && vy >= G.shopY && vy <= G.shopY + G.shopH) {
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
      var nRows = Math.min(CAMPAIGN_MAPS, TG.rows.length);
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
          // A rival with no PLAN cannot be fought: there would be nobody on the
          // other side. Refuse the tap rather than starting a duel against a
          // cave that never builds and can only be won.
          if (!rivalReady(rq)) return;
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
          for (var tlv = 0; tlv < CAMPAIGN_MAPS; tlv++) {
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
        // A SPLICE CAN RE-POINT towerIdx AT HER MACHINE. The menu holds an
        // array index, and _buyAt/sell mutate the array under it, so the owner
        // is re-checked here as well as at the tap that opened it.
        if (tw && !this._sameSide(tw.own, 0)) { this.menu = null; return; }
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
              // % AIM_MODES.length, not a literal: adding HEXER as a fourth mode
              // with a hardcoded 3 here would have left it unreachable from the
              // only control that selects it.
              tw.targeting = ((tw.targeting | 0) + 1) % AIM_MODES.length;
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
    // YOURS ONLY. This loop had no owner test, so tapping one of HER machines
    // opened the full manage menu on it -- and the last button in that menu is
    // SELL. Measured: one tap sold Cinder's ballista and paid the player 91
    // gold. Five more taps and the DRAKE has an empty cave and you are 400 gold
    // up, which is the entire mode decided before wave 2.
    for (var t = 0; t < this.towers.length; t++) {
      var pd = this.towers[t];
      if (!this._sameSide(pd.own, 0)) continue;
      var tdx = w.x - pd.x, tdy = w.y - pd.y;
      if (tdx * tdx + tdy * tdy < 32 * 32) { this.menu = { towerIdx: t }; return; }
    }
    // (empty pads are no longer tap-to-build — the shop owns building now, and
    // a pad is simply cheaper ground. That frees the whole floor for walking.)

    // PLACING a machine from the shop: this tap is the placement.
    if (this.shopPick >= 0) {
      var stid = this._shelf()[this.shopPick];
      if (!stid) { this.shopPick = -1; return; }
      var chk = this._placeCheck(w.x, w.y, 0);
      if (!chk.ok) {
        this.fxQueue.push({ k: 'float', x: w.x, y: w.y - 18, txt: chk.why, c: '#ff9a9a' });
        return;                                   // stay armed: let them try again
      }
      if (!this._buyAt(stid, w.x, w.y, chk)) {
        this.fxQueue.push({ k: 'float', x: w.x, y: w.y - 18, txt: 'not enough gold', c: '#ff9a9a' });
        return;
      }
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
    tx = clamp(tx, 20, WORLD_W - 20); ty = clamp(ty, 120, WORLD_H - 30);
    // HIS HALF OF THE CAVERN. Everything he does is scoped to his own road now
    // (see THE DIVIDE), so walking him across would leave a dragon standing
    // uselessly in someone else's cave with nothing to say why. Bisect toward
    // the divide instead of refusing the tap: it reads as a wall, and it is
    // general -- nearest-keep, never a hardcoded midline.
    if (this.rivalSide && sideAt(tx, ty) !== 0 && sideAt(hh.x, hh.y) === 0) {
      var ax = hh.x, ay = hh.y;
      for (var bi = 0; bi < 18; bi++) {
        var mx = (ax + tx) * 0.5, my = (ay + ty) * 0.5;
        if (sideAt(mx, my) === 0) { ax = mx; ay = my; } else { tx = mx; ty = my; }
      }
      tx = ax; ty = ay;
    }
    hh.tx = tx; hh.ty = ty;
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

  /// THE PURCHASE, and the only one. Pulled out of the tap handler when the
  /// duel grew a live opponent: an AI with its own copy of the cost line is an
  /// AI that quietly stops paying the crowd multiplier or the pad discount the
  /// day either changes, and the scoreboard becomes a lie that looks fine.
  /// Both the player's tap and the rival's AI buy through here.
  // ===== THE RIVAL AI — a live opponent, not a recording ==================
  //
  // The duel used to be a race against RIVAL_CURVES: a baked table of hoard
  // per wave, drawn as a number in the top bar. It was honest (a recording of
  // this bot on this arena IS that bot on that arena) but it meant there was no
  // second cave and no second dragon -- VANUS: "I don't see another dragon
  // that's fighting against me". A number cannot be watched.
  //
  // So the opponent is now a SECOND Game, stepped in lockstep beside the
  // player's on the same map, same seed, same waves, driven by this. It costs
  // shipping an AI, which the bake deliberately avoided; that trade is the
  // price of a visible opponent, and it is also the thing an online duel will
  // need anyway to fill in for a dropped player.
  //
  // DETERMINISTIC BY CONSTRUCTION: every choice below is a function of the
  // board (tower count, wave, pad order) and never of Math.random, so the same
  // rival on the same arena plays the same duel every time -- which is what
  // keeps a duel fair when two players fight "the same" opponent.
  var RIVAL_PLANS = {
    // mix cycles; depth = how far it upgrades; cap = how many machines it will
    // own; rank = which ground it likes; every = build on every Nth wave;
    // wick = she works the floor herself (crews a machine).
    //
    // `call: 'early'|'late'` USED TO BE HERE AND NOTHING READ IT. There is one
    // countdown in a shared cavern and the PLAYER owns it -- she has no path
    // into startWave at all -- so the field could only ever describe a rival
    // who does not exist. Removed rather than left to be quoted later.
    tallow: { mix: ['ballista'], depth: 0, cap: 5, rank: 'keep', every: 2 },
    flint:  { mix: ['ballista', 'crystal', 'ballista'], depth: 1, cap: 7, rank: 'road', every: 1 },
    ember:  { mix: ['ballista', 'perch'], depth: 2, cap: 4, rank: 'road', every: 1 },
    cinder: { mix: ['ballista', 'perch', 'rotor', 'brazier', 'ballista'], depth: 2, cap: 9,
              rank: 'road', every: 1, wick: true },
  };

  /// Pads ranked for a plan, cached per (map, rank) — a sort per frame for a
  /// board that never moves is pure waste.
  /// Where the rival may build, best first.
  ///
  /// THIS RETURNED MAP.pads ONLY, AND THAT WAS THE BIGGEST HOLE IN THE DUEL.
  /// The player builds by FREE PLACEMENT -- pads are a 20% discount, not a
  /// requirement -- so on the Split Cavern the player can legally place 35
  /// machines on their half while the rival, walking a 5-pad list, could never
  /// place a sixth. Measured: flint (cap 7) and cinder (cap 9) both stalled at
  /// FIVE, sitting on 440 and 116 unspent gold, which collapsed the four-rival
  /// ladder into "roughly the same opponent with different paint".
  ///
  /// So she gets the same ground the player gets: her pads first (they are
  /// cheaper, and a builder takes the discount), then open floor ranked by how
  /// close it is to the road it defends.
  ///
  /// Deterministic: a fixed grid walk and a stable sort, no RNG. Cached per
  /// (level, rank, side) because the board does not move -- the scan is ~500
  /// points against ~100 road samples and must not run per frame.
  Game.prototype._rivalSpots = function (rank, side) {
    side = side | 0;
    // rivalSide belongs in the key: BOTH the pad filter and _roadD2 branch on
    // it, so a list built outside a duel is a different list.
    var key = this.levelIdx + ':' + rank + ':' + side + ':' + (this.rivalSide ? 1 : 0);
    if (this._spotKey === key) return this._spotCache;

    var self = this;
    function roadD2(x, y) { return self._roadD2(x, y, side); }
    var kp = keepOf(side);
    function score(x, y) {
      return rank === 'keep'
        ? (x - kp.x) * (x - kp.x) + (y - kp.y) * (y - kp.y)
        : roadD2(x, y);
    }

    var out = [];
    for (var i = 0; i < MAP.pads.length; i++) {                 // pads first: they are discounted
      var pd = MAP.pads[i];
      if (this.rivalSide && sideAt(pd.x, pd.y) !== side) continue;
      out.push({ x: pd.x, y: pd.y, s: score(pd.x, pd.y), pad: 1 });
    }
    // OPEN FLOOR, ON A GRID ANCHORED AT THE MIDDLE OF THE WORLD.
    //
    // It used to walk x from 30 in steps of 14, which put the right half's
    // samples two units out of phase with the left's -- 30 + 14k lands on 212,
    // and 212's mirror (208) is not a sample. So on an arena whose entire
    // fairness argument is "the two halves are mirror images", the two players
    // were offered DIFFERENT ground to build on. Anchoring the walk at
    // WORLD_W / 2 makes the candidate set its own mirror by construction.
    //
    // The bounds mirror _placeCheck's free-build box; _placeCheck still runs at
    // purchase time, so this only has to be a good SHORTLIST.
    // Offset by HALF A STEP so the walk straddles the divide instead of landing
    // on it. sideAt breaks an exact tie toward side 0, so a sample at x = 210 is
    // a column the left half owns and the right half has no twin for -- measured
    // as 118 candidates against 116, which is the asymmetry this whole walk
    // exists to remove.
    var XS = [], HALF = WORLD_W / 2;
    for (var xh = HALF + 7; xh <= WORLD_W - 30; xh += 14) {
      XS.push(xh); XS.push(WORLD_W - xh);
    }
    XS.sort(function (a, b) { return a - b; });
    var lim = MAP.pathW * 0.5 + 16, lim2 = lim * lim;
    for (var y2 = 200; y2 <= WORLD_H - 40; y2 += 14) {
      for (var xi = 0; xi < XS.length; xi++) {
        var x2 = XS[xi];
        if (this.rivalSide && sideAt(x2, y2) !== side) continue;
        var kdx = x2 - kp.x, kdy = y2 - kp.y;
        if (kdx * kdx + kdy * kdy < 96 * 96) continue;          // too close to the hoard
        var rd = roadD2(x2, y2);
        if (rd < lim2) continue;                                // on the road
        if (rd > 62 * 62) continue;                             // too far to shoot anything
        out.push({ x: x2, y: y2, s: score(x2, y2), pad: 0 });
      }
    }
    // Pads before open floor at equal value, then nearest-first. THE TIEBREAK
    // IS MIRROR-INVARIANT: it was the insertion index, so two equally-good
    // spots resolved to "the smaller x", which on the left half means further
    // from the divide and on the right half means nearer it -- the one thing a
    // tiebreak on a symmetric arena must not do. Distance from the divide, then
    // y, is a total order within a side (a side fixes the sign of x - HALF) and
    // reads the same from either end of the room.
    out.forEach(function (o) { o.mx = Math.abs(o.x - HALF); });
    out.sort(function (a, b) {
      return (b.pad - a.pad) || (a.s - b.s) || (b.mx - a.mx) || (a.y - b.y);
    });
    this._spotKey = key; this._spotCache = out;
    return out;
  };

  /// One AI beat. She plays HER HALF of this cavern -- same sim, same waves,
  /// her own purse, her own pads, her own road. Deterministic: every choice is
  /// a function of the board and never of Math.random, so the same rival on the
  /// same arena plays the same duel twice, which is what makes a duel fair.
  /// HER DRAGON, IN HER COLOUR. VANUS: "the AI that it's against a different
  /// colors". Recoloured from Wick's own plate rather than bought as new art:
  /// it is the same character class in a different scale colour, it costs no
  /// download, and it extends to any number of rivals -- and to multiplayer
  /// skins later -- by adding a hex string to the roster.
  ///
  /// source-atop over the sprite keeps the painting's shading and swaps only
  /// the hue; a flat fill would give a silhouette, which reads as a shadow
  /// rather than a rival. Cached per colour: this is a canvas op, not a filter.
  Game.prototype._rivalPlate = function (img, tint) {
    // KEYED ON THE SOURCE TOO. Dimensions do not identify an image -- the three
    // manning frames are all 951x746 -- so a tint cache keyed on size alone
    // hands the flap her body plate for every frame of the cycle.
    var key = tint + '@' + (img.src || '?') + '@' + (img.width | 0) + 'x' + (img.height | 0);
    var cache = this._tintCache || (this._tintCache = {});
    if (cache[key]) return cache[key];
    var cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    var cx2 = cv.getContext('2d');
    cx2.drawImage(img, 0, 0);
    cx2.globalCompositeOperation = 'source-atop';
    cx2.globalAlpha = 0.55;
    cx2.fillStyle = tint;
    cx2.fillRect(0, 0, cv.width, cv.height);
    cx2.globalAlpha = 1;
    cache[key] = cv;
    return cv;
  };

  /// Draw the rival hoardling on her side. She is a RENDER, not a sim entity:
  /// she has no hp, cannot be targeted and does not fight, because inventing a
  /// second hero would double every hero rule for a character the player never
  /// controls. What she has to do is BE THERE, visibly, on her own ground.
  Game.prototype._drawRivalWick = function (ctx) {
    if (!this.rivalSide || !this.rival) return;
    var img = ART.images.hero;
    if (!img) return;
    var w = this.rivalWick || { x: keepOf(1).x, y: keepOf(1).y + 150 };
    var a = this._wickAnchor(w.x, w.y, this.rivalManTid === undefined ? -1 : this.rivalManTid);
    var plate = this._rivalPlate(img, this.rival.tint || '#b06adf');
    var hh = HERO_H * a.s, hw = hh * (img.width / img.height);
    // A CREWED DRAGON DOES NOT BOB: she is braced against a crank. The idle bob
    // is for a dragon standing on her own floor.
    var bob = a.tw ? 0 : Math.sin(this.worldT * 2.1) * 1.2;
    // FACING. Standing, she looks INTO the cavern -- at you -- which on the
    // right-hand side is the mirror of the sprite's native left.
    //
    // CREWING IS NOT MIRRORED, and that is the trap here. The mount table is
    // relative to the MACHINE ART, and her machines are drawn in the same
    // orientation as his -- so her seat is on the same side of her crank as his
    // is of his (measured: both sit at mount.dx * gain = +17.92 on a level-1
    // ballista). Mirroring the facing for her therefore turns her AWAY from the
    // machine she is supposed to be working. Same seat, same rule as his.
    var flip = -1;
    if (a.tw) {
      var mdx = (TOWER_TYPES[a.tw.type].mount || { dx: 0 }).dx;
      flip = mdx >= 0 ? 1 : -1;          // dx>0 -> she is right of it -> face LEFT (native)
    }
    ctx.save();
    ctx.translate(a.x, a.y - a.lift + bob);
    ctx.scale(flip, 1);
    if (!a.tw) {                          // a contact shadow needs floor to fall on
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = '#000';
      ctx.beginPath(); ctx.ellipse(0, 2, hw * 0.22, hw * 0.09, 0, 0, 6.283); ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.drawImage(plate, -hw / 2, -hh, hw, hh);
    ctx.restore();
  };

  Game.prototype._rivalTick = function (STEP) {
    var plan = RIVAL_PLANS[this.rival && this.rival.id] || RIVAL_PLANS.tallow;
    this._aiT = (this._aiT || 0) + STEP;
    if (this._aiT < 0.5) return;
    this._aiT = 0;

    var mine = [];
    for (var t = 0; t < this.towers.length; t++) if ((this.towers[t].own | 0) === 1) mine.push(this.towers[t]);

    // 1. BUILD, cycling the mix, on HER pads only
    if (mine.length < plan.cap && (this.wave % (plan.every || 1)) === 0) {
      var spots = this._rivalSpots(plan.rank, 1);      // already her side only
      var want = plan.mix[mine.length % plan.mix.length];
      for (var i = 0; i < spots.length; i++) {
        // (no "is this pad taken" test: _nearestPad already skips occupied pads,
        // and _placeCheck rejects ground too close to a machine either way)
        if (this._buyAt(want, spots[i].x, spots[i].y, null, 1)) break;
      }
    }

    // 2. UPGRADE toward her depth, shallowest first, out of her own purse
    if (plan.depth > 0) {
      var low = null;
      for (var m = 0; m < mine.length; m++) {
        var tw = mine[m];
        if (tw.level >= plan.depth) continue;
        if (!low || tw.level < low.level) low = tw;
      }
      if (low) {
        var lvl = TOWER_TYPES[low.type].levels[low.level];
        if (lvl && this.rivalGold >= lvl.upgradeCost) { this.rivalGold -= lvl.upgradeCost; low.level++; }
      }
    }

    // 3. HER DRAGON WORKS HER FLOOR -- or guards her hoard, and that difference
    //    is her card rather than decoration.
    //
    //    She still has no hero ENTITY: no hp, cannot be targeted, cannot be
    //    fought. Inventing a second hero would double every hero rule for a
    //    character the player never controls. What she gets is the two things a
    //    dragon's POSITION buys, because both are pure functions of where she
    //    stands and cost the sim nothing -- the overclock on her nearest
    //    machine (update() runs it for both dragons now), and, if her card says
    //    she works the floor, the crew bonus on the one she is standing on.
    //
    //    `plan.wick` was a DEAD FLAG. Cinder's card reads "Works the cavern
    //    floor herself. Good luck." and it sat over a hoardling who did
    //    nothing at all -- the same class of lie as a baked curve.
    var post = null;
    if (plan.wick) {                       // the machine with the most road on it
      var bs = 1e9;
      for (var w2 = 0; w2 < mine.length; w2++) {
        var mw = mine[w2], ms = this._roadD2(mw.x, mw.y, 1);
        if (ms < bs || (ms === bs && post && mw.tid < post.tid)) { bs = ms; post = mw; }
      }
    }
    if (post) {
      this.rivalWick = { x: post.x, y: post.y - 6, tid: post.tid };
      this.rivalManTid = post.tid;
    } else {
      var rk = keepOf(1);                  // she waits on her hoard
      this.rivalWick = { x: rk.x, y: rk.y + 150, tid: -1 };
      this.rivalManTid = -1;
    }
  };

  Game.prototype._buyAt = function (type, x, y, chk, own) {
    own = own | 0;
    if (!TOWER_TYPES[type]) return null;
    // each side pays out of its own purse, and the crowd multiplier counts only
    // that side's machines -- otherwise the rival building makes YOUR next
    // machine dearer, which is not a duel, it is a tax
    var mineCount = 0;
    for (var mc = 0; mc < this.towers.length; mc++) if ((this.towers[mc].own | 0) === own) mineCount++;
    var purse = own === 1 ? this.rivalGold : this.gold;
    // CHEAPEST-POSSIBLE FIRST. _placeCheck walks every sample of every road, and
    // the rival AI calls this once per candidate down a ~129-entry shortlist
    // every half second -- so a rival who cannot afford anything was paying for
    // the entire geometric scan to be told so, 129 times a tick. The pad
    // discount is the best price available, so failing THAT fails all of them.
    if (purse < Math.round(TOWER_TYPES[type].cost * PAD_DISCOUNT * crowdMul(mineCount))) return null;
    chk = chk || this._placeCheck(x, y, own);
    if (!chk.ok) return null;
    var cost = Math.round(TOWER_TYPES[type].cost * (chk.discount ? PAD_DISCOUNT : 1) * crowdMul(mineCount));
    if (purse < cost) return null;
    var bx = x, by = y;
    if (chk.pad >= 0) { bx = MAP.pads[chk.pad].x; by = MAP.pads[chk.pad].y; }   // snap to the pad
    if (own === 1) this.rivalGold -= cost; else this.gold -= cost;
    var tw = { tid: this.nextId++, type: type, level: 0, fork: 0, own: own,
               ln: this.rivalSide ? sideAt(bx, by) : 0,
               x: bx, y: by, padIdx: chk.pad, cd: 0, targeting: 0, shotT: 9 };
    this.towers.push(tw);
    this.fxQueue.push({ k: 'place', x: bx, y: by });
    // HER BUILDS ARE NOT ANNOUNCED TO YOU. The pad-discount float and the place
    // chime are feedback for a tap the player made; the rival builds every few
    // seconds all game, and shouting "PAD BONUS -20%" across her half of the
    // cavern is her spending YOUR attention. The dust puff stays -- that is her
    // board telling you something happened, which is the point of a duel.
    if (own !== 1) {
      if (chk.discount) this.fxQueue.push({ k: 'float', x: bx, y: by - 40, txt: 'PAD BONUS -20%', c: '#9ef58f' });
      Sfx.play('place');
    }
    return tw;
  };

  Game.prototype._placeCheck = function (x, y, own) {
    own = own | 0;
    // YOUR HALF OF THE CAVERN. In a shared-cavern duel the two of you stand in
    // one room, so without this you could build across the divide and defend
    // (or refuse to defend) the rival's road. Nearest keep decides.
    if (this.rivalSide && sideAt(x, y) !== own) {
      return { ok: false, why: own === 1 ? 'not her ground' : "that is the rival's half" };
    }
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
    // THIS SIDE'S hoard. It read MAP.keep, which on the Split Cavern is keeps[0]
    // -- so the player had a 96u dead zone around their own pile and the rival
    // had none, and hers was measured against a keep on the far side of the room.
    var kOwn = keepOf(this.rivalSide ? own : 0);
    var kdx = x - kOwn.x, kdy = y - kOwn.y;
    if (kdx * kdx + kdy * kdy < 96 * 96) return { ok: false, why: 'too close to the hoard' };
    // the road: a machine must not stand in the raiders' way
    var lim = MAP.pathW * 0.5 + 16;
    for (var ln = 0; ln < LANES.length; ln++) {
      for (var d = 0; d <= LANES[ln].len; d += 7) {
        var pt = pathPointAt(d, ln), rdx = x - pt.x, rdy = y - pt.y;
        if (rdx * rdx + rdy * rdy < lim * lim) return { ok: false, why: 'on the road' };
      }
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
      // GEARJAW REND -- sheared metal and popped rivets. Cosmetic lane: this is
      // spent from the queue in _cosmetic(), Math.random only, never the seeded
      // stream. Mechanical, not organic: the content law is comic and kid-safe,
      // so this is a machine chewing armour, not a wound.
      if (fx.k === 'grind') {
        for (var gi = 0; gi < 9; gi++) {
          var ga = -Math.PI * 0.5 + (Math.random() - 0.5) * 2.2;
          var gsp = 55 + Math.random() * 95;
          this.particles.push({ kind: 'dot', x: fx.x, y: fx.y,
            vx: Math.cos(ga) * gsp, vy: Math.sin(ga) * gsp - 15,
            r: 0.7 + Math.random() * 1.5,
            life: 0.13 + Math.random() * 0.2, T: 0.33,
            // orange sparks with a couple of bright steel chips among them
            c: gi < 2 ? '#e8eef5' : (gi < 6 ? '#ffb14e' : '#ff7b2e') });
        }
        continue;
      }
      if (fx.k === 'hit' || fx.k === 'bite') {
        // FIVE DIRECTIONLESS DOTS was the whole impact effect, on the beat this
        // game repeats more than any other. An arrow that buries itself in a
        // raider should throw spray FORWARD off the hit and a couple of chips
        // back along the shaft — the heading was always available on the
        // projectile and the effect simply discarded it.
        var hn = Math.sqrt((fx.dx || 0) * (fx.dx || 0) + (fx.dy || 0) * (fx.dy || 0));
        if (hn > 0.001) {
          var hang = Math.atan2(fx.dy, fx.dx);
          var hcount = fx.big ? 11 : 7;
          for (var hi = 0; hi < hcount; hi++) {
            // most of it sprays on THROUGH the target, a few chips kick back
            var back = hi >= hcount - 2;
            var ha = hang + (back ? Math.PI : 0) + (Math.random() - 0.5) * (back ? 1.6 : 1.1);
            var hsp = (back ? 40 : 95 + (fx.big ? 70 : 0)) * (0.55 + Math.random() * 0.9);
            this.particles.push({ kind: 'dot', x: fx.x, y: fx.y,
              vx: Math.cos(ha) * hsp, vy: Math.sin(ha) * hsp - 22,
              r: 0.9 + Math.random() * (fx.big ? 2.4 : 1.5),
              life: 0.16 + Math.random() * 0.16, T: 0.34,
              c: hi < 2 ? '#fff4d0' : (fx.c || '#ffb14e') });
          }
          if (fx.big) this.particles.push({ kind: 'ring', x: fx.x, y: fx.y, r: 3, R: 26,
                                            life: 0.20, T: 0.20, c: '#ffcf6a' });
        } else this._burst(fx.x, fx.y, fx.c || '#ffb14e', 5, 60);
      }
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
        // '+N' in the gold colour is a claim about YOUR purse
        if (this._sameSide(fx.ln, 0)) {
          this.floats.push({ x: fx.x, y: fx.y, txt: '+' + fx.g, c: '#ffd75e', t: 1 });
        }
        // (100,40) is YOUR gold counter. A kill on her road pays HER purse, so
        // throwing its coins at your counter -- and floating '+N' in your gold
        // colour -- claimed income you never got.
        if (this._sameSide(fx.ln, 0)) {
          this.fxQueue.push({ k: 'coinfly', x: fx.x, y: fx.y, tx: 100, ty: 40, n: fx.boss ? 6 : 2 });
        }
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
        var sm = moundOf(fx.ln | 0);
        for (var sp2 = 0; sp2 < sc; sp2++) {
          this.particles.push({
            kind: 'coin',
            // OFF THE PILE IT CAME FROM. This read MAP.mound, which on the
            // Split Cavern is YOURS -- so a raider robbing HER hoard scooped the
            // coins visibly off your own mound. The direction is the whole story
            // of this beat, and it was telling the wrong one.
            x: sm.x + (Math.random() - 0.5) * sm.rx * 1.4,
            y: sm.y + (Math.random() - 0.5) * 14,
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
        // home to the pile it belongs to, not always yours
        var rm = moundOf(fx.ln | 0);
        this.fxQueue.push({ k: 'coinfly', x: fx.x, y: fx.y, tx: rm.x, ty: rm.y, n: Math.min(5, fx.n) });
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
        var mz = this._muzzle(true);   // the breath plate is what draws this frame
        // VANUS: "the fire that he makes he doesnt look like hes spitting it".
        // Three separate reasons, all fixed here:
        //  1. THE BEAT WAS 0.42s -- a blink. The open jaw, the head recoil and
        //     the drawn jet all ride _breathT, so the whole performance was over
        //     before you could look at it.
        //  2. THE DAMAGE IS RADIAL (everything inside hero.range = 76) and the
        //     only visual was a thin forward cone, so the AREA never read. The
        //     Gemsinger already ships a ring particle for exactly this job.
        //  3. The jet was 14 small dots. It is a gout now: 26, bigger, hotter,
        //     living longer, and thrown along his facing.
        this._burst(mz.x, mz.y, '#ff9a3c', 34, 150);
        this.particles.push({ kind: 'ring', x: mz.x, y: mz.y, r: 12,
                              R: this.hero.range, life: 0.45, T: 0.45, c: '#ffb14e' });
        for (var bj = 0; bj < 26; bj++) {
          var ja = mz.f * (0.10 + Math.random() * 0.70) - 0.40;
          var js = 110 + Math.random() * 170;
          this.particles.push({ kind: 'dot', x: mz.x, y: mz.y,
                                vx: Math.cos(ja) * js * mz.f, vy: Math.sin(ja) * js - 34,
                                r: 2.4 + Math.random() * 4.2, life: 0.34 + Math.random() * 0.30,
                                T: 0.66, c: bj % 3 ? '#ffd75e' : '#fff3cf' });
        }
        this._breathT = BREATH_BEAT;          // drives the open jaw + head recoil
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
      // c is a PAYLOAD now: this hardcoded the Gemsinger's chill-teal, so the
      // Whirlyjack's blade sweep drew as a chill pulse -- two machines that do
      // opposite things (slow vs cut) speaking in one colour.
      else if (fx.k === 'pulse') this.particles.push({ kind: 'ring', x: fx.x, y: fx.y, r: 10, R: fx.r, life: 0.35, T: 0.35, c: fx.c || '#a8e6ff' });
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
        if (fx.hero) this._spitT = SPIT_BEAT;   // ...and his jaws actually open for it
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
      else if (fx.k === 'float') {
        // STACKED LABELS. Manning a machine that is also overclocked fires two
        // floats at the same point on the same frame, and they drew straight
        // on top of each other -- "MANNING!" and "OVERCLOCKED!" as one
        // unreadable smear. Lift a new float clear of any live one it would
        // land on. Cosmetic lane, cheap: there are rarely more than a few.
        var fy = fx.y;
        for (var fq = 0; fq < this.floats.length; fq++) {
          var of2 = this.floats[fq];
          if (Math.abs(of2.x - fx.x) < 70 && Math.abs(of2.y - fy) < 15) { fy = of2.y - 16; fq = -1; }
        }
        this.floats.push({ x: fx.x, y: fy, txt: fx.txt, c: fx.c, t: 1.6 });
      }
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
    if (this._spitT > 0) this._spitT = Math.max(0, this._spitT - dtRaw);
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
      // A duel is scored against a rival hoard that steps once per wave, so
      // "how badly am I losing" is a number the music can read directly.
      duel: this.mode === 'duel',
      deficit: this.mode === 'duel'
        ? (this.rivalHoard - this.hoard) / CFG.startHoard : 0,
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
  // 57.2 -> 57.994 and MUZZLE_FWD 0.321 -> 0.285 when hero_whelp was REPACKED
  // (693x720 -> 783x730) to share a canvas with hero_breathe. Both numbers are
  // fractions OF THE CANVAS, so growing it to admit a frame changes what they
  // mean; the height bump holds his drawn body at exactly its old size and the
  // muzzle was carried through the pack transform, not re-guessed.
  var HERO_H = 57.994;
  var MUZZLE_UP = 0.685, MUZZLE_FWD = 0.285;
  // The BREATH plate is a different pose -- head thrust forward and down, jaws
  // open -- so his mouth is not where the closed-muzzle plate's is. Measured off
  // art/hero_breathe.png at the front of the gullet fire. Using the idle numbers
  // here is how fire ends up leaving his forehead.
  var MUZZLE_B_UP = 0.616, MUZZLE_B_FWD = 0.263;
  // PLATE ASPECTS AS CONSTANTS, not reads of ART.images. _muzzle() is about to
  // place a PROJECTILE, and a projectile's start position is sim state -- it
  // decides how far the fireball flies and therefore when the damage lands. A
  // sim number must never depend on whether an image finished decoding, and the
  // old expression fell back to 0.77 when it had not, which is a fork between
  // two players on the same seed. hero_whelp and hero_breathe deliberately share
  // one canvas (see the repack note above), so they share one number; the manned
  // plates are a different canvas and the drawer already sizes off theirs.
  // tools/validate.py asserts both against the shipped PNGs.
  var HERO_ASPECT = 783 / 730;          // hero_whelp.png, hero_breathe.png
  var HERO_MAN_ASPECT = 951 / 746;      // hero_man.png, hero_man_up/_dn.png
  /// WHERE WICK IS DRAWN, and how big -- the single source both the drawer and
  /// _muzzle() read. They used to disagree: the drawer lifted him 26px onto a
  /// machine and _muzzle() went on reporting his mouth at ground level, so a
  /// breath cast from a manned machine left from under his feet. Now that the
  /// lift is per-machine and there is a scale as well, that drift would only
  /// have got worse. Same idiom as _titleGeom(): one geometry, two readers.
  /// SHARED BY BOTH DRAGONS. The rival crews a machine now, and drawing her at
  /// full height on top of one is exactly the defect the combined manned plates
  /// were deleted for -- VANUS: "when the dragon mans stuff it looks weird".
  /// One anchor, one scale, one mount table, both sides.
  Game.prototype._wickAnchor = function (x, y, manTid) {
    var tw = (manTid >= 0) ? this._towerByTid(manTid) : null;
    if (!tw) return { x: x, y: y, s: 1, lift: 0, tw: null };
    var mnt = TOWER_TYPES[tw.type].mount || { dx: 0, up: 32 };
    var g = 1 + tw.level * 0.12;
    return { x: tw.x + mnt.dx * g, y: tw.y, s: MAN_SCALE, lift: mnt.up * g, tw: tw };
  };
  Game.prototype._heroAnchor = function () {
    var h = this.hero;
    return this._wickAnchor(h.x, h.y, h.manned ? h.manTid : -1);
  };

  // onBreath: the particle burst fires on the SAME frame the breath plate swaps
  // in, so it must use that plate's mouth. It is an argument and not a read of
  // _breathT because _cosmetic() spends the fx queue BEFORE _breathT is set --
  // reading the flag here would put the first burst on the closed-mouth muzzle
  // every single time, which is the drift this function was written to end.
  /// WHICH WAY WICK IS LOOKING: +1 right, -1 left. His plate is painted facing
  /// LEFT, so the drawer mirrors by the negation of this.
  ///
  /// ONE number, read by the drawer AND by _muzzle(), because they derived it
  /// separately and disagreed in the two states that matter. Both read
  /// (tx - x), which is ZERO for a dragon standing still -- and zero again the
  /// moment he mounts a machine, because manning sets tx to the machine he is
  /// already sitting on. So a stationary Wick always resolved to LEFT and spat
  /// his fireball out of the BACK of his head at anything on his right, and a
  /// crewing Wick was drawn by the mount rule while his mouth stayed on the
  /// other side of him. It is sim state (h.face), not a render cache, so it can
  /// place a projectile without lagging a frame behind the plate.
  Game.prototype._heroFacing = function () {
    var h = this.hero;
    var tw = h.manned ? this._towerByTid(h.manTid) : null;
    if (tw) {
      var mdx = (TOWER_TYPES[tw.type].mount || { dx: 0 }).dx;
      return mdx >= 0 ? -1 : 1;        // sitting right of the crank -> look left at it
    }
    return (h.face | 0) || -1;
  };

  Game.prototype._muzzle = function (onBreath) {
    var h = this.hero;
    var a = this._heroAnchor();
    var hh = HERO_H * a.s;
    // ...and the aspect follows the plate he is actually drawn on. Crewing a
    // machine swaps him to the manned canvas, which is wider (1.275 vs 1.073),
    // so reading the idle plate's aspect put his mouth ~17% short of his snout
    // for the whole time he is at a crank.
    var mw2 = hh * (a.tw ? HERO_MAN_ASPECT : HERO_ASPECT);
    // Facing comes from the sim (see _heroFacing), never from the drawer's
    // stored value: _cosmetic() spends the fx queue BEFORE draw() runs, so
    // reading the render cache would lag a frame and a breath cast on the frame
    // he turns would leave his mouth.
    var f = this._heroFacing();
    var mf = onBreath ? MUZZLE_B_FWD : MUZZLE_FWD;
    var mu = onBreath ? MUZZLE_B_UP : MUZZLE_UP;
    return { x: a.x + f * (mw2 * mf), y: a.y + 5 - a.lift - hh * mu, f: f };
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
    // EVERY hoard in the cavern. A shared-cavern duel has two: yours and hers.
    for (var kq = 0; kq < (MAP.keeps ? MAP.keeps.length : 1); kq++) this._drawMoundAndKeep(ctx, kq);
    this._drawPath(ctx);
    this._drawMouthAlarm(ctx);    // escape pressure, UNDER the entities
    this._drawTar(ctx);           // slag sits ON the road, under everyone
    for (var kr2 = 0; kr2 < (MAP.keeps ? MAP.keeps.length : 1); kr2++) this._drawKeep(ctx, kr2);
    this._drawPads(ctx);
    this._drawEntities(ctx);
    this._drawParticles(ctx);
    // NO WORLD TEXT ON THE OPPONENT'S BOARD. Floats and build hints are drawn
    // at world scale, and the inset is 96px wide, so "PAD BONUS -20%" and
    // "OVERCLOCKED!" came out as an illegible smear covering her whole cave.
    // Her numbers are on the duel strip; her board only has to show the fight.
    if (!this.isRival) this._drawWorldHints(ctx);
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
    // screen-anchored HUD (drawn over everything except the dev overlay).
    // The rival's cave renders WORLD ONLY: its inset is 92px wide, where a
    // second gold counter and a second wave chip are illegible noise, and its
    // hoard is already on the player's own duel strip.
    if (!this.isRival) this._drawHudView(ctx);

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
    // EVERY ROAD, not the first one. This cache is the only thing that paints
    // the road, so a lane missing from this loop is a lane raiders walk across
    // bare stone. Beds are laid for all lanes FIRST so a later road's shadow
    // cannot darken an earlier road's crown where the two cross.
    var LN = LANES;
    // the bed is drawn opaque into its own layer and composited ONCE, so where
    // two roads overlap the shadow does not stack into a dark scar
    var bd = document.createElement('canvas');
    bd.width = WORLD_W * res; bd.height = WORLD_H * res;
    var bc = bd.getContext('2d');
    bc.scale(res, res); bc.lineCap = 'round'; bc.lineJoin = 'round';
    for (var b0 = 0; b0 < LN.length; b0++) {
      strokePath(bc, LN[b0].pts, MAP.pathW + 8, 'rgb(18,10,6)');
    }
    pc.globalAlpha = 0.55;
    pc.drawImage(bd, 0, 0, WORLD_W, WORLD_H);
    pc.globalAlpha = 1;
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
      // UNION THE MASK, THEN CUT ONCE. Stroking each lane with
      // destination-in in turn does not add roads together, it INTERSECTS them:
      // lane 0's cut erases everything outside lane 0, then lane 1's erases
      // everything outside lane 1, and all that survives is the stretch they
      // share. On the Twin Throats that shipped as a merged climb in cobble
      // with both of its branches in bare shadow. The lanes are drawn into one
      // mask first, and the cut happens a single time.
      var mk = document.createElement('canvas');
      mk.width = WORLD_W * res; mk.height = WORLD_H * res;
      var mc = mk.getContext('2d');
      mc.scale(res, res); mc.lineCap = 'round'; mc.lineJoin = 'round';
      for (var m0 = 0; m0 < LN.length; m0++) strokePath(mc, LN[m0].pts, MAP.pathW, 'rgba(0,0,0,1)');
      rc.globalCompositeOperation = 'destination-in';
      rc.drawImage(mk, 0, 0, WORLD_W, WORLD_H);
      rc.globalCompositeOperation = 'source-over';
      rc.lineCap = 'round'; rc.lineJoin = 'round';
      for (var m1 = 0; m1 < LN.length; m1++) strokePath(rc, LN[m1].pts, MAP.pathW - 4, 'rgba(216,190,149,0.07)');   // lit crown
      rc.save();
      rc.globalCompositeOperation = 'source-atop';
      for (var m2 = 0; m2 < LN.length; m2++) strokePath(rc, LN[m2].pts, MAP.pathW - 20, 'rgba(20,12,8,0.16)');      // boot-worn centre
      rc.restore();
      pc.drawImage(rl, 0, 0, WORLD_W, WORLD_H);
    } else {
      // procedural fallback: warm worn-stone strokes
      for (var f0 = 0; f0 < LN.length; f0++) strokePath(pc, LN[f0].pts, MAP.pathW, '#7b6a55');
      for (var f1 = 0; f1 < LN.length; f1++) strokePath(pc, LN[f1].pts, MAP.pathW - 8, '#8b7a68');
      for (var f2 = 0; f2 < LN.length; f2++) strokePath(pc, LN[f2].pts, MAP.pathW - 20, 'rgba(216,190,149,0.18)');
      pc.save();
      pc.setLineDash([5, 13]);
      for (var f3 = 0; f3 < LN.length; f3++) strokePath(pc, LN[f3].pts, MAP.pathW - 24, 'rgba(30,18,10,0.28)');
      pc.restore();
    }
    // a cave mouth per ENTRANCE — every road has to come from somewhere
    for (var e1 = 0; e1 < LN.length; e1++) {
      var e0 = LN[e1].pts[0];
      pc.fillStyle = '#0d0805';
      pc.beginPath(); pc.ellipse(e0[0] + 8, e0[1], 34, 26, 0.4, 0, 6.283); pc.fill();
    }
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

  /// side: which hoard this is. A shared-cavern duel has two, and the warmth
  /// halo has to dim with the hoard it actually belongs to -- drawing both from
  /// this.hoard would show the rival's pile cooling as YOURS was robbed.
  Game.prototype._drawMoundAndKeep = function (ctx, side) {
    side = side | 0;
    var m = moundOf(side), k = keepOf(side);
    // Mother's warmth — a halo BEHIND the keep (never tint the castle itself).
    // It dims as the hoard thins: the life bar is a sleeping mother you can
    // watch getting colder (the studio's ambient-story graft).
    var warmth = 0.3 + 0.7 * ((side === 1 ? this.rivalHoard : this.hoard) / CFG.startHoard);
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

  Game.prototype._drawKeep = function (ctx, side) {
    side = side | 0;
    var k = keepOf(side);
    // ONLY YOUR KEEP. The glow says "tap me", and the tap test (_onTapWorld)
    // reads MAP.keep -- so on the Split Cavern the rival's hoard was pulsing an
    // invitation to a control that does not exist on her side.
    if (this.motherReady && this._sameSide(side, 0)) {
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
    // WHERE YOU MAY BUILD, shown only while a machine is actually in hand.
    // placeHint was scaffolded and never populated or drawn — but this is a
    // touch game with no hover, so a cursor ghost cannot work. What the player
    // actually needed was the INVISIBLE RULE made visible: a no-build corridor
    // hugs the whole road and nothing ever said so, so a tap near the road just
    // silently did nothing and read as an unresponsive game.
    if (this.shopPick >= 0 && this.state === 'playing') {
      ctx.save();
      var lim = MAP.pathW * 0.5 + 16;
      ctx.strokeStyle = 'rgba(255,90,80,0.16)';
      ctx.lineWidth = lim * 2; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      for (var cl = 0; cl < LANES.length; cl++) {
        ctx.beginPath();
        for (var rd = 0; rd <= LANES[cl].len; rd += 14) {
          var rp = pathPointAt(rd, cl);
          if (rd === 0) ctx.moveTo(rp.x, rp.y); else ctx.lineTo(rp.x, rp.y);
        }
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(255,90,80,0.14)';
      // one ring per hoard: _placeCheck keeps a 96u dead zone around EACH of
      // them now, and a rule you cannot see is a rule that reads as a bug
      for (var kz = 0; kz < (MAP.keeps ? MAP.keeps.length : 1); kz++) {
        var kk = keepOf(kz);
        ctx.beginPath(); ctx.arc(kk.x, kk.y, 96, 0, 6.283); ctx.fill();
      }
      for (var ez = 0; ez < this.towers.length; ez++) {
        ctx.beginPath(); ctx.arc(this.towers[ez].x, this.towers[ez].y, 46, 0, 6.283); ctx.fill();
      }
      ctx.restore();
    }
    for (var i = 0; i < MAP.pads.length; i++) {
      if (this._padTower(i) !== -1) continue;
      var p = MAP.pads[i];
      // her discount ground is not an offer to you: _placeCheck refuses it
      if (this.rivalSide && sideAt(p.x, p.y) !== 0) continue;
      // A pad is a DISCOUNT, not a target — tap-to-build on a pad was removed
      // when the shop took over building. Eight rings pulsing like buttons when
      // nothing is in hand is the most button-like thing on the map promising
      // something that does not happen, so they only wake up while armed.
      var armed = this.shopPick >= 0;
      var afford = armed && this.gold >= 115;   // was `>= 60`: no machine costs 60
      var pulse = afford ? 0.6 + 0.4 * Math.sin(this.worldT * 3 + i) : (armed ? 0.35 : 0.16);
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
    if (this.rivalSide && this.rival) {
      rec = slot(); n++;
      var rw = this.rivalWick || { x: keepOf(1).x, y: keepOf(1).y + 150 };
      // same rule as his: crewing sorts just AFTER her machine so she sits ON
      // it rather than behind it
      var rmt = (this.rivalManTid >= 0) ? this._towerByTid(this.rivalManTid) : null;
      rec.y = rmt ? rmt.y + 1 : rw.y;
      rec.kind = 'rivalwick'; rec.ref = null;
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
      if (d.kind === 'rivalwick') this._drawRivalWick(ctx);
      else if (d.kind === 'tower') this._drawTower(ctx, d.ref);
      else if (d.kind === 'enemy') this._drawEnemy(ctx, d.ref, { x: d.px, y: d.py });
      else if (d.kind === 'husk') {
        // Replay the raider's own sprite, white-hot and fading. Driving it
        // through flashT means the corpse inherits the SAME white re-draw and
        // squash pop a non-lethal hit gets — the kill stops being the one
        // impact the renderer never showed.
        // ...but BOTH terms were monotone-decreasing, so a kill rendered as a
        // non-lethal graze whose sprite happens to fade out.
        //
        // THE FIRST FIX FOR THAT WAS WRONG AND VANUS CAUGHT IT: "when enemies
        // die they get bigger first and enlarge or something. It's a little bit
        // weird". It was. The husk overshot to 1.34x and held it for THREE FULL
        // FRAMES at full opacity -- 50ms of a visibly inflating raider. I had
        // reasoned that a Bloons pop is "instantly BIGGER and brighter", and
        // that is not what a pop is. The balloon does not grow; it is REPLACED,
        // and what reads as the pop is the substitution plus the burst. Scaling
        // a corpse up just animates the corpse.
        //
        // So: never above 1.0. Two frames white-hot at full size -- the flash IS
        // the substitution -- then shrink and fade away fast. The particles and
        // the kill sound carry the punch; the husk only has to stop looking
        // like a raider that is still there.
        //
        // Keyed on elapsed time, NOT on hr: _cosmetic ticks the husk before
        // draw() in the same frame, so the first rendered frame is already
        // hr ~ 0.86 at 60Hz -- an `hr > 0.78` gate would give one frame at
        // 60Hz and ZERO at 30Hz.
        var hv = d.ref, hr = Math.max(0, hv.t / hv.T);
        var el = hv.T - hv.t;
        var pop = 1 - 0.42 * (el / hv.T);
        hv.e.flashT = el < 0.034 ? 0.55 : 0.12 * hr;
        ctx.save();
        ctx.globalAlpha = el < 0.034 ? 1 : Math.pow(hr, 1.1);
        ctx.translate(d.px, d.py); ctx.scale(pop, pop); ctx.translate(-d.px, -d.py);
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
    // PER MOUTH. With two roads a thief escapes by the one it came in on, so
    // the alarm has to flare there and not at road zero's mouth every time.
    var escLn = [];
    for (var q = 0; q < this.enemies.length; q++) {
      var c = this.enemies[q];
      if (c.fleeing && c.stolen > 0) {
        var cl = c.ln | 0, ce = 1 - Math.min(1, c.d / 220);
        esc = Math.max(esc, ce);
        escLn[cl] = Math.max(escLn[cl] || 0, ce);
      }
    }
    if (esc <= 0.02) return;                       // its mere presence is the alarm
    for (var al = 0; al < LANES.length; al++) {
      var ae = escLn[al] || 0;
      if (ae <= 0.02) continue;
      var m0 = LANES[al].pts[0];
      var pul = 0.65 + 0.35 * Math.sin(this.worldT * (4 + 8 * ae));   // rate rises as it closes
      ctx.fillStyle = 'rgba(255,60,50,' + (0.08 + 0.20 * ae) + ')';
      ctx.beginPath(); ctx.ellipse(m0[0], m0[1], 34 + 40 * ae, 26 + 30 * ae, 0.4, 0, 6.283); ctx.fill();
      ctx.strokeStyle = 'rgba(255,123,123,' + (0.20 + 0.65 * ae * pul) + ')';
      ctx.lineWidth = 1.5 + 5 * ae;
      ctx.beginPath(); ctx.ellipse(m0[0], m0[1], 34 + 14 * ae, 26 + 11 * ae, 0.4, 0, 6.283); ctx.stroke();
    }
  };
  Game.prototype._drawTar = function (ctx) {
    for (var i = 0; i < this.tar.length; i++) {
      var tp = this.tar[i];
      var fade = Math.min(1, (tp.until - this.worldT) / 0.6);   // last 0.6s cools off
      var a = pathPointAt(tp.d, tp.ln);
      var gl = 0.55 + 0.25 * Math.sin(this.worldT * 5 + tp.d);  // ember shimmer
      ctx.fillStyle = 'rgba(24,14,8,' + (0.75 * fade) + ')';
      ctx.beginPath(); ctx.ellipse(a.x, a.y, tp.w * 0.62, tp.w * 0.30, 0, 0, 6.283); ctx.fill();
      ctx.fillStyle = 'rgba(255,120,40,' + (0.30 * gl * fade) + ')';
      ctx.beginPath(); ctx.ellipse(a.x, a.y, tp.w * 0.45, tp.w * 0.20, 0, 0, 6.283); ctx.fill();
      ctx.fillStyle = 'rgba(255,190,90,' + (0.35 * gl * fade) + ')';
      for (var s = 0; s < 3; s++) {
        var sa = pathPointAt(tp.d + (s - 1) * tp.w * 0.3, tp.ln);
        ctx.beginPath(); ctx.arc(sa.x + Math.sin(this.worldT * 3 + s * 2.1 + tp.d) * 4, sa.y - 1, 1.6, 0, 6.283); ctx.fill();
      }
    }
  };
  /// Split a machine plate into a fixed BASE and a rotating TURRET, once.
  /// Built from the shipped art at runtime — no new files, no pipeline run, and
  /// the manned plates (which have Wick painted in) split at the same line.
  /// The seam is feathered so the join never shows as a cut edge.
  /// Where a machine's shot actually LEAVES it, in world space.
  /// Bolts used to spawn at (pad.x, pad.y - 30) — the middle of the machine —
  /// so a crossbow's arrow appeared out of the barrel it was mounted on rather
  /// than off the bow, and nothing marked the moment of firing at all.
  /// SIM LANE: derived from the target, never from the renderer's _faceSign,
  /// which is draw-time state the sim must not read. No RNG, so no fork.
  Game.prototype._muzzleOf = function (tw, tx, ty) {
    var m = TOWER_TYPES[tw.type].muzzle;
    if (!m) return { x: tw.x, y: tw.y - 26 };
    var f = (tx - tw.x) >= 0 ? 1 : -1;          // which side the machine faces
    // THE PLATE GROWS WITH LEVEL AND THE OFFSET DID NOT. The drawer scales by
    // (1 + level*0.12), so a fixed world constant slid further down inside the
    // chassis on every upgrade — an L3 Roost, the most expensive ranged machine
    // in the game, fired out of the middle of its own pillar again, which is the
    // exact defect the muzzle work set out to fix.
    var ms = 1 + tw.level * 0.12;               // tw.level is sim state, no RNG
    return { x: tw.x + f * m.fwd * ms, y: tw.y - m.up * ms };
  };

  /// A WARM SILHOUETTE, CACHED PER SPRITE, blitted slightly larger behind a
  /// raider so it never sinks into the floor.
  ///
  /// Measured, which is why this exists rather than eight new sprites: the
  /// cavern floor sits at luminance 42, and the LOWER THIRD of eight of the ten
  /// raiders sits within 19 points of it -- the Greed Hexer at 46, the Filcher
  /// at 47, the Shellback 49, the Hoard King 60. Only the Gloomwing (93) and
  /// the Blinker (142) separate on their own. That is not a boss problem, it is
  /// the whole cast, and VANUS saw it first on the King: "the bottom half of it
  /// is getting darker and glitching out... I think for all of them".
  ///
  /// It is the style doing it, not a mistake: the art bible asks for shadow
  /// sides in cool blue-violet, and a blue-violet leg on a blue-violet floor is
  /// invisible by construction. A rim is the standard answer and it costs one
  /// cached blit per TYPE, built once, in the same idiom as _turretFor.
  Game.prototype._rimFor = function (spriteId) {
    this._rimCache = this._rimCache || {};
    if (this._rimCache[spriteId] !== undefined) return this._rimCache[spriteId];
    var img = ART.images[spriteId];
    if (!img || !img.width) return (this._rimCache[spriteId] = null);
    var cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    var x = cv.getContext('2d');
    x.drawImage(img, 0, 0);
    // keep the ALPHA, throw away the colour: source-in paints every opaque
    // pixel one warm tone, so the rim reads the same on a dark leg and a gold
    // breastplate instead of inheriting whatever it was standing in front of.
    x.globalCompositeOperation = 'source-in';
    x.fillStyle = 'rgba(255,196,124,1)';
    x.fillRect(0, 0, cv.width, cv.height);
    return (this._rimCache[spriteId] = cv);
  };

  Game.prototype._turretFor = function (spriteId, tt) {
    if (!tt || !tt.turret) return null;
    this._turretCache = this._turretCache || {};
    if (this._turretCache[spriteId] !== undefined) return this._turretCache[spriteId];
    var img = ART.images[spriteId];
    if (!img || !img.width) return (this._turretCache[spriteId] = null);
    var w = img.width, h = img.height;
    var cut = Math.round(h * tt.turret.cut), F = Math.max(2, Math.round(h * 0.012));
    function half(keepTop) {
      var cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      var x = cv.getContext('2d');
      x.drawImage(img, 0, 0);
      x.globalCompositeOperation = 'destination-out';
      var g = x.createLinearGradient(0, cut - F, 0, cut + F);
      g.addColorStop(0, keepTop ? 'rgba(0,0,0,0)' : 'rgba(0,0,0,1)');
      g.addColorStop(1, keepTop ? 'rgba(0,0,0,1)' : 'rgba(0,0,0,0)');
      x.fillStyle = g; x.fillRect(0, cut - F, w, 2 * F);
      x.fillStyle = '#000';
      if (keepTop) x.fillRect(0, cut + F, w, h - cut - F);
      else x.fillRect(0, 0, w, cut - F);
      x.globalCompositeOperation = 'source-over';
      return cv;
    }
    return (this._turretCache[spriteId] = {
      top: half(true), base: half(false), pvx: tt.turret.pvx, pvy: tt.turret.pvy });
  };

  Game.prototype._drawTower = function (ctx, tw) {
    var p = tw;
    var lvl = tw.level;
    // NO MANNED-PLATE SWAP. See MAN_SCALE: the machine is always itself, and
    // _drawHero puts Wick on top of it at his own constant size.
    var spriteId = 't_' + tw.type;
    // THE BELLOWS' FOOTPRINT IS ITS PRODUCT, so it is always drawn. _auraRate
    // and _auraDmg had ZERO draw-lane readers: a buffed machine was pixel-
    // identical to an unbuffed one, and the only ring the post ever showed was
    // the generic yellow one, only while its menu was open, in the same colour
    // an attack tower uses for its KILL range. Going out when the post is
    // jammed is also the only visible tell that machine has.
    if (tw.type === 'bellows' && !(tw.jamT > 0)) {
      // A SOFT GLOW, NOT A RING. This was a dashed 1.5px circle at the aura's
      // full radius, and at 96-132 units that is a hard geometric line drawn
      // across half the board and straight through whatever raiders happen to
      // be standing on it. VANUS read it, twice, as the game being broken:
      // "circles there like in the screenshot so it looks like somethings wrong".
      // A UI ring says "selection"; warm air on the floor says "aura". Same
      // information, and it cannot be mistaken for a boundary.
      var bR = lvlRow(tw).range;
      var bg = ctx.createRadialGradient(p.x, p.y + 4, bR * 0.25, p.x, p.y + 4, bR);
      bg.addColorStop(0, 'rgba(255,190,120,0.085)');
      bg.addColorStop(0.72, 'rgba(255,178,100,0.045)');
      bg.addColorStop(1, 'rgba(255,170,90,0)');
      ctx.fillStyle = bg;
      ctx.beginPath(); ctx.ellipse(p.x, p.y + 4, bR, bR * 0.62, 0, 0, 6.283); ctx.fill();
    }
    // range ring while its menu is open
    if (this.menu && this.menu.towerIdx !== undefined && this.towers[this.menu.towerIdx] === tw) {
      var rr3 = lvlRow(tw).range;
      // A Coin Press has range 0 on all four rows, so this drew arc(x, y, 0)
      // twice a frame -- a fill and a stroke of nothing -- and the player got a
      // menu that showed them an invisible ring for their 140g.
      if (rr3 > 0) {
        ctx.fillStyle = 'rgba(255,215,94,0.10)';
        ctx.beginPath(); ctx.arc(p.x, p.y, rr3, 0, 6.283); ctx.fill();
        ctx.strokeStyle = 'rgba(255,215,94,0.45)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(p.x, p.y, rr3, 0, 6.283); ctx.stroke();
      }
    }
    groundShadow(ctx, p.x, p.y + 2, 54 * (1 + lvl * 0.06), 0, 1.05);   // machines sit on the floor too
    // JAMMED. A Pry-Hand silencing a machine changed NOTHING on screen -- and
    // jamming a Bellows Post silently took _auraRate to 0 on every machine it
    // was buffing, with zero pixels moving anywhere on the board. The shrinking
    // arc is the breath button's own cooldown idiom, so it is already-taught
    // vocabulary, and it makes the player-agency half legible too: standing on
    // the machine clears it 5x faster and the arc visibly accelerates.
    if (tw.jamT > 0) {
      var jf = Math.max(0, Math.min(1, tw.jamT / (ENEMY_TYPES.sapper.sapStun || 2.6)));
      ctx.strokeStyle = 'rgba(255,120,110,0.85)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(p.x, p.y + 4, 22, -1.5708, -1.5708 + 6.283 * jf); ctx.stroke();
    }
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
      // the idle breath STOPS while jammed: a machine that has been silenced
      // should read as stopped, not as working quietly.
      var tsq = 1 - 0.10 * kick
              + Math.sin(this.worldT * 1.6 + tw.padIdx) * 0.008 * (tw.jamT > 0 ? 0 : 1);
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
        // face: +1 = plate painted facing RIGHT, -1 (default) = facing LEFT.
        // For nat = -1 this is identical to the old expression, so the perch
        // and mimic are byte-identical; only the crossbow flips.
        var nat = (tt2.face || -1);
        fSign = (fdx >= 0 ? -1 : 1) * -nat;
        // SCREEN-Y IS DEPTH HERE, NOT HEIGHT. The first version used
        // atan2(dy, |dx|) as if a raider further down the screen were BELOW the
        // machine, which swung the bow through huge angles for a target that is
        // really only closer to the camera. In a three-quarter view that axis is
        // foreshortened, so the turn is proportional to the depth component and
        // stays small: level for a target across from it, a gentle tilt for one
        // up-road or down-road. Rendered all 8 compass directions to pick 0.30.
        var fn = Math.max(1, Math.sqrt(fdx * fdx + fdy * fdy));
        // IT BARELY TURNED. want maxed at 0.30 rad = 17 degrees, and because it
        // read ONLY the depth component it was exactly ZERO for a raider level
        // with the machine -- which is most of them on an S-curve road. So the
        // crossbow mirrored left/right and otherwise sat still, and VANUS read
        // it as not tracking what it shoots.
        //
        // The horizontal component now contributes too, scaled well down
        // because screen-y is DEPTH in a three-quarter view and screen-x is not:
        // a target across from the machine should angle the barrel a little,
        // not swing it like a top-down turret. Only a machine with a separated
        // turret rotates at all (the base stays planted), so the plate cannot
        // tip over.
        // BACK DOWN TO A SEAM-SAFE ANGLE. I raised this to 0.42/0.16 with a
        // 0.52 clamp to make the tracking visible, and it visibly BROKE the
        // machine: `turret.cut` splits the plate into a top and a base, and
        // rotating the top 24-30 degrees swings it off the socket it is drawn
        // to sit in, so the bow assembly detached from its drum. VANUS: "the
        // crossbows still arent right either... its broken". The original 0.30
        // was not timidity -- it is the angle at which a painted three-quarter
        // plate can be rotated without the cut showing, and its comment says
        // all eight compass directions were rendered to pick it.
        //
        // The real defect was never the angle. It was that `_aimX` only updated
        // when the machine FIRED, so the barrel pointed at where the raider had
        // been up to a full cooldown earlier. That is fixed above and it is what
        // makes the machine read as tracking; this only has to not break.
        //
        // MEASURED 2026-08-21, AND THE PARAGRAPH ABOVE IS WRONG ABOUT 0.30 BEING
        // SEAM-SAFE. Compositing the real split at a range of angles and counting
        // (a) top pixels that swing outside the plate's own outline and (b) plate
        // pixels left uncovered:
        //      6deg   560 over,    875 uncovered   clean
        //     12deg  1167 over,  3811 uncovered   visible
        //     19deg  1744 over,  7501 uncovered   BROKEN   <-- the shipped clamp
        // `want` reaches ~0.30 rad (17deg) for any raider below the machine, i.e.
        // most of them, so the plate is tearing at its own cut during normal play.
        //
        // AND ROTATION CANNOT SOLVE THE AIM ANYWAY. The plate's bow is painted
        // 41.8deg above horizontal (principal axis of the top half's opaque
        // pixels), so +/-18.9deg reaches 23deg..61deg and NEVER points level or
        // below -- while a raider on the road sits at roughly 0..-30deg. VANUS,
        // from the phone: "the crossbow isnt properly pointed at its enemy".
        // That is a 25-70deg error no clamp can close.
        //
        // The answer is the one this repo already wrote down for the wings:
        // THE ANSWER IS A FRAME, not a deformation. Directional plates, picked
        // by angle, the way hero_man_up/_dn work. Left as-is pending that,
        // because lowering the clamp trades a tear for a bow that never moves
        // and raising it is what VANUS already rejected as broken.
        //
        // ATTEMPT 1 FAILED, $0.63, DO NOT REPEAT IT. masked_repair.py over a box
        // of (10,4)-(544,540) -- everything above the drum -- with a prose prompt
        // asking for the weapon lowered. All three candidates verified "outside-
        // mask pixels changed: 0", so the tool did its job; the MODEL re-composed
        // rather than re-posed. Every candidate came back massively zoomed in,
        // and the kobold gunner was mangled in one and gone from two. The mask
        // was 75% of the plate, which is a regeneration wearing a mask -- the
        // exact failure targeted-art-repair's own gotcha table names.
        //
        // The architecture that should work, and costs one generation:
        //   1. inpaint ONE "bare machine" plate -- drum, deck, gunner, empty
        //      mount, weapon REMOVED. A removal is a well-posed inpaint task;
        //      a re-pose of a large rigid object is not.
        //   2. cut the weapon out of THIS plate with an authored mask, so it is
        //      the real painted weapon with zero model drift.
        //   3. engine draws bare plate, then the weapon cutout rotated about its
        //      trunnion to any angle. Continuous aim, perfect registration, and
        //      no seam because nothing is split horizontally any more.
        var want = 0.30 * (fdy / fn) + 0.07 * Math.abs(fdx / fn) * (fdy >= 0 ? 1 : -1);
        // Only a machine with a SEPARATED turret may turn at all — its base
        // stays planted. The Mimic is a chest: it mirrors, nothing rotates.
        fRot = tt2.turret ? Math.max(-0.33, Math.min(0.33, want)) : 0;
        // ease in RENDER time; cosmetic only, so wall-clock is correct here
        var prev = tw._faceRot === undefined ? fRot : tw._faceRot;
        var prevS = tw._faceSign === undefined ? fSign : tw._faceSign;
        tw._faceRot = prev + (fRot - prev) * 0.18;
        tw._faceSign = fSign;                        // the mirror snaps; the angle eases
        fRot = tw._faceRot;
      }
      var split = this._turretFor(spriteId, tt2);
      ctx.save();
      ctx.translate(p.x, p.y + 8);
      ctx.scale((2 - tsq) * fSign, tsq);
      if (split) {
        // THE BASE NEVER MOVES. This is the whole fix: the previous version
        // rotated the entire plate, so a barrel-based machine visibly leaned
        // and read as broken. Now the barrel stays planted on the floor and
        // only the weapon on top of it swings, which is what the art depicts.
        ctx.drawImage(split.base, -tw0 / 2, -th0, tw0, th0);
        var pvX = -tw0 / 2 + tw0 * split.pvx, pvY = -th0 + th0 * split.pvy;
        ctx.translate(pvX, pvY);
        ctx.rotate(fRot * fSign);
        ctx.translate(-pvX, -pvY);
        ctx.drawImage(split.top, -tw0 / 2, -th0, tw0, th0);
      } else {
        ctx.drawImage(timg, -tw0 / 2, -th0, tw0, th0);
      }
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
      this._drawForkBadge(ctx, tw, p, p.y - h - 14);   // rank + fork, both branches
    }
  };
  /// RANK on the left, FORK on the right, on the machine's top strip.
  ///
  /// The level pips lived ONLY in the no-art fallback branch of _drawTower, and
  /// every one of the seven sprites loads -- so on 100% of shipped machines the
  /// player's own upgrade was invisible. A level-1 and a level-3 crossbow were
  /// distinguishable only by 12% of sprite width, on a board where machines also
  /// sit at different depths and therefore different scales. This function was
  /// already called from BOTH branches, so the rank belongs here.
  ///
  /// Bars, not dots, and COUNT carries the read -- the rule written four lines
  /// down, which the hue-only fork dot broke. Top strip rather than under the
  /// base: _placeCheck allows 30 units between machines and a neighbour that
  /// close draws its sprite up over anything at p.y+12.
  Game.prototype._drawForkBadge = function (ctx, tw, p, topY) {
    var rank = (tw.level | 0) + 1;
    var rh = rank * 4 + 8;
    ctx.fillStyle = 'rgba(16,10,7,0.72)';
    rr(ctx, p.x - 30, topY - 4 - rank * 4, 14, rh, 3); ctx.fill();
    ctx.fillStyle = '#ffd75e';
    for (var rb = 0; rb < rank; rb++) {
      ctx.fillRect(p.x - 27, topY - rb * 4, 6, 2.4);
    }
    if (tw.level < 2) return;              // badge: which mod this machine keeps
    // TWO COLOURS BECAME TWO SHAPES. This was a 6px dot whose ONLY difference
    // between the two permanent L3 identities was hue -- gold vs pale blue --
    // in a cavern lit gold, three lines above the file's own rule that "Count
    // and LENGTH and SHAPE carry the read, never hue". A disc and a bar survive
    // greyscale, dark adaptation and the torchlight; the hue stays as
    // reinforcement rather than as the carrier.
    var bc = tw.fork ? '#a8e6ff' : '#ffd75e';
    ctx.fillStyle = 'rgba(28,20,14,0.9)';
    ctx.beginPath(); ctx.arc(p.x + 20, topY, 7.5, 0, 6.283); ctx.fill();
    ctx.strokeStyle = bc; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(p.x + 20, topY, 7.5, 0, 6.283); ctx.stroke();
    ctx.fillStyle = bc;
    if (tw.fork) { rr(ctx, p.x + 14.5, topY - 1.4, 11, 2.8, 1.4); ctx.fill(); }
    else { ctx.beginPath(); ctx.arc(p.x + 20, topY, 3.2, 0, 6.283); ctx.fill(); }
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
    var near = e.fleeing ? 0 : Math.max(0, 1 - (laneLen(e.ln) - e.d) / 70);
    // depth: units grow toward the camera, matching the painted floor
    var dsc = depthScale(p.y);
    var baseW = (e.type === 'boss' ? 62 : e.type === 'brute' ? 46 : 36) * dsc;
    // A REAL contact shadow, sized off the body and thrown along the key light
    // (measured upper-left across the sprite set). The old one was 20u wide
    // under a 36u body and centred ABOVE the feet, so it read as an ankle
    // smudge. BEAT 1a is preserved: `near` still widens and darkens it as he
    // closes on the hoard.
    // STRENGTH 0.62..0.90, not 1.00..1.45. groundShadow's own contact term is
    // alpha 0.42 BEFORE this multiplier, so at 1.45 it painted a 0.61-alpha
    // black ellipse under every raider, and a road full of raiders became a
    // road full of dark holes. VANUS: "whats with these shadows under the
    // enemies? too much?". `near` still darkens as they close on the hoard; it
    // just starts from a shadow rather than from a hole.
    groundShadow(ctx, p.x, p.y, baseW * (1 + 0.22 * near), eFly(e) ? 26 : 0, 0.62 + 0.28 * near);
    var sid = 'e_' + e.type;
    var img = ART.images[sid];
    if (img) {
      // ALIVE pass — procedural sprite animation, all render-lane:
      // facing flip along travel, walk-waddle rotation, volume-preserving
      // squash & stretch, step-hop, dig-frenzy while grabbing, boss stomp.
      var t = this.worldT, ph = e.id * 1.7;
      var boss = e.type === 'boss';
      var moving = e.grabT <= 0;
      var ahead = pathPointAt(e.fleeing ? Math.max(0, e.d - 8) : Math.min(laneLen(e.ln), e.d + 8), e.ln);
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
      if (e.flashT > 0) squash *= 1 + e.flashT * 0.35;                // impact pop, halved
      if (e.fleeing) hop *= 1 - 0.30 * Math.min(1, e.stolen / 8);     // laden: barely leaves the ground
      // BEAT 1b — the rear-back wind-up over the last 26 units before the hoard
      var lean = 0;
      if (!e.fleeing && e.grabT <= 0) {
        var toKeep = laneLen(e.ln) - e.d;
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
      // SEPARATION RIM, behind the sprite and very slightly larger, so a raider
      // never disappears into the floor it is standing on. See _rimFor for the
      // measurement that justifies it: eight of ten raiders have a lower third
      // within 19 luminance points of the cavern floor. 3.5% larger is a hair
      // over one screen pixel at true draw size -- enough to catch the eye as an
      // edge, far too little to read as a halo.
      var rimc = this._rimFor(sid);
      if (rimc) {
        var rk = 1.035;
        ctx.globalAlpha = 0.5;
        ctx.drawImage(rimc, -w0 * rk / 2, -hh2 * rk, w0 * rk, hh2 * rk);
        ctx.globalAlpha = 1;
      }
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
        ctx.globalAlpha = Math.min(0.45, e.flashT * 5);   // a tint, not a strobe
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
    // ABOVE THE HEAD, not across the waist. p.y - 20 is mid-body on a 36-unit
    // raider, so a damaged raider wore a bright green line through their legs --
    // VANUS: "theres a white or yellow line there too that shows up under the
    // enemies it looks broken". Derived from the drawn sprite height now, so it
    // clears the head of a Scrapling and of the Hoard King alike.
    if (e.hp < e.maxHp) {
      var bw = e.type === 'boss' ? 36 : 20;
      var bimg = ART.images['e_' + e.type];
      var bh = baseW * (bimg ? bimg.height / bimg.width : 1.1);
      var by2 = p.y - bh - 5 + fy;
      ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(p.x - bw / 2, by2, bw, 3);
      ctx.fillStyle = e.fleeing ? '#ff7b7b' : '#9ef58f';
      ctx.fillRect(p.x - bw / 2, by2, bw * Math.max(0, e.hp / e.maxHp), 3);
    }
    // burn flicker
    if (e.burnT > 0) {
      ctx.fillStyle = 'rgba(255,138,60,0.6)';
      ctx.beginPath(); ctx.arc(p.x + Math.sin(this.worldT * 20 + e.id) * 3, p.y - 16 + fy, 3, 0, 6.283); ctx.fill();
    }
    // CHILLED. This was a FILLED 24x26 blue ellipse centred 9 units above the
    // raider's feet -- i.e. a solid blue blob sitting on their legs and lower
    // torso, on every slowed raider at once. With a Gemsinger on the board that
    // is most of the wave, and VANUS read it exactly as it looks: "blue bubbles
    // that you see on the bottom half of the enemies".
    //
    // A status must never be a shape drawn IN FRONT of the thing it describes.
    // Frost goes on the GROUND they are standing in: a rime ring at the feet
    // and a few ice flecks, so the raider stays fully readable and the effect
    // still says cold at a glance.
    if (e.slowT > 0) {
      var chT = Math.min(1, e.slowT * 2);
      ctx.save();
      // faint and small: a dozen chilled raiders means a dozen of these on one
      // stretch of road, so anything bolder becomes the same visual noise the
      // blue bubbles were.
      ctx.strokeStyle = 'rgba(168,230,255,' + (0.30 * chT).toFixed(3) + ')';
      ctx.lineWidth = 1.1;
      ctx.beginPath(); ctx.ellipse(p.x, p.y + 1, 10.5, 4.2, 0, 0, 6.283); ctx.stroke();
      ctx.fillStyle = 'rgba(214,244,255,' + (0.5 * chT).toFixed(3) + ')';
      for (var ic = 0; ic < 3; ic++) {
        var ia = (e.id * 1.7 + ic * 2.1);            // stable per raider, no RNG
        ctx.beginPath();
        ctx.ellipse(p.x + Math.cos(ia) * 12, p.y + 1 + Math.sin(ia) * 4.4,
                    1.5, 1.1, ia, 0, 6.283);
        ctx.fill();
      }
      ctx.restore();
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

    // MANNED: he rides the machine's own mount point at ONE scale (MAN_SCALE),
    // drawn as himself. There is no combined plate any more -- see MAN_SCALE for
    // why seven of them had to go.
    var mtw = h.manned ? this._towerByTid(h.manTid) : null;
    var anc = this._heroAnchor();
    var mnt = mtw ? true : null;
    var manX = anc.x, manY = anc.y, manS = anc.s;
    if (h.selected) {
      ctx.strokeStyle = 'rgba(158,245,143,0.8)'; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
      ctx.beginPath(); ctx.arc(h.x, h.y, 26, 0, 6.283); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(158,245,143,0.08)';
      ctx.beginPath(); ctx.arc(h.x, h.y, h.range, 0, 6.283); ctx.fill();
    }
    // MANNED: he is perched ON the machine, so lift him and drop the ground
    // shadow (he is not standing on the floor any more).
    var lift = anc.lift;
    // The shadow is the ONLY thing that says how high he is. It has to move
    // with him or the hover reads as the sprite jittering in place.
    if (!h.manned) {
      // planted feet cast a STEADY shadow; only a walking step or a hover
      // moves it. A shadow that pulses under a motionless dragon is the same
      // floating tell in another channel.
      var shF = hMoving2 ? 1 - 0.10 * Math.abs(Math.sin(this.worldT * 9.2)) : 1;
      groundShadow(ctx, h.x, h.y, 44 * depthScale(h.y) * shF, 0, 1 / shF);
    }
    var hdx2 = h.tx - h.x, hdy2 = h.ty - h.y;
    var hMoving2 = Math.abs(hdx2) + Math.abs(hdy2) > 3;
    var goingAway = hMoving2 && hdy2 < -Math.abs(hdx2) * 0.7;   // mostly up-screen
    // He is always drawn now -- a manned frame with no dragon in it was only
    // ever possible because the plate could be missing.
    // THE FLAP. Four slots on the wingbeat -- down, mid, up, mid -- so the
    // cycle is symmetric and never snaps between the extremes. Falls back to
    // the mid plate if a wing frame has not decoded yet, so a slow load shows a
    // still dragon rather than a missing one.
    var himg;
    if (h.manned && ART.images.hero_man) {
      var wph = (this.worldT * 7.4) % 6.283;
      var wdn = ART.images.hero_man_dn, wup = ART.images.hero_man_up;
      himg = wph < 1.571 ? (wdn || ART.images.hero_man)
           : wph < 3.142 ? ART.images.hero_man
           : wph < 4.712 ? (wup || ART.images.hero_man)
           : ART.images.hero_man;
    } else if ((this._breathT > 0 || this._spitT > 0) && ART.images.hero_breathe) {
      // THE OPEN JAW IS A FRAME, NOT PAINT. The idle plate has a closed muzzle,
      // and the dark ellipse this used to stamp on it to fake an open mouth
      // reads -- magnified -- as a black bar punched through his cheek. VANUS:
      // "the fire that he makes he doesnt look like hes spitting it". This is
      // the generated breath pose with its baked plume cut off (tools/
      // cut_plume.py), registered and packed onto the idle plate's own canvas,
      // so swapping to it cannot move or resize him.
      himg = ART.images.hero_breathe;
    } else {
      himg = (goingAway && ART.images.hero_back) ? ART.images.hero_back : ART.images.hero;
    }
    if (himg) {
      // hover bob + sway; face the direction he's headed
      var ht = this.worldT;
      // FACE THE MACHINE WHILE MANNING IT. hflip is derived from where he is
      // WALKING to -- and manning sets tx/ty to the machine he is already on, so
      // (tx - x) is ~0 and he always defaulted to facing LEFT no matter which
      // side of the machine his mount puts him on. VANUS: "sometimes he's faced
      // the wrong way". On a mount the sign of mount.dx is the answer: sitting
      // to the RIGHT of the machine he must look left at it, and vice versa.
      // ONE SOURCE (see _heroFacing): the sim owns which way he looks, and the
      // plate is painted facing left, so the mirror is its negation.
      var hflip = -this._heroFacing();
      var hmoving = Math.abs(h.tx - h.x) + Math.abs(h.ty - h.y) > 3;
      // HE STANDS. He is drawn standing in his own art -- the title plate, the
      // app icon, hero_whelp itself -- and he bobbed anyway, at every moment,
      // which VANUS read as "even one still he is wobbling and looks like he's
      // floating a little bit". My first answer was to commit to flight
      // everywhere; his correction is the right one: "he could walk too cause
      // he's standing in the original photo of him".
      //
      // So THREE distinct states, and only one of them leaves the ground:
      //   IDLE     planted. ZERO vertical motion -- the thing that read as
      //            floating was a bob with nothing to justify it. Breathing
      //            only, on the squash term below.
      //   WALKING  a STEP bob: he rises on each footfall, so the vertical runs
      //            at twice the stride and its lowest point is the plant. Small
      //            amplitude on purpose; a big one is a hop, not a walk.
      //   MANNING  airborne, wings out, because that is what hero_man depicts
      //            and what VANUS asked for -- "if you man it you are flying
      //            next to it using wrench or controls".
      // The flap only exists in the air. The wings are a static painting, so it
      // is faked the way a two-frame cycle does it: the span widens on the
      // downstroke and he RISES on it, i.e. the vertical is 90 degrees out of
      // phase with the span. In phase it reads as a pulsing balloon.
      var flapF = mnt ? 7.4 : 9.2;      // matches the wing-frame cycle above
      var flap  = mnt ? Math.sin(ht * flapF) : 0;          // wingbeat: AIR ONLY
      var flapA = mnt ? 0.055 : 0;                         // wing SPAN, x
      var rise  = mnt ? Math.cos(ht * flapF)               // hover, out of phase
                      : (hmoving ? -Math.abs(Math.sin(ht * flapF)) : 0);
      var bobA2 = mnt ? 2.2 : (hmoving ? 1.5 : 0);         // idle is EXACTLY 0
      // NO IDLE DEFORMATION AT ALL. A standing Wick was still being squashed
      // and stretched by this breathing term -- (2-hsq) on X against hsq on Y --
      // which is what VANUS is seeing: "wicks movement even when still looks
      // like he's bouncing... that doesn't make it life like just cause you
      // make him bounce. I said to give him other movements... not just making
      // things stretch". Stretching a painting is not animation. A standing
      // character should be STILL until it has real frames to be alive with.
      var hsq = hmoving ? 1 + Math.sin(ht * 9) * 0.05
              : mnt     ? 1 + Math.sin(ht * 7.4) * 0.018
              : 1;
      var hh0 = HERO_H * manS, hw0 = hh0 * (himg.width / himg.height);
      // the sprite is drawn facing LEFT natively, so world-facing is -hflip.
      // _muzzle() reads this to put the breath where his mouth is.
      this._heroFace = -hflip;
      // BREATH RECOIL — a short kick back and up, easing out. b runs 1 -> 0.
      var b = Math.max(0, (this._breathT || 0) / BREATH_BEAT);
      var kick = b * b;
      ctx.save();
      // manX/manY are the machine's mount when manned, his own feet otherwise.
      var hoverT = -rise * bobA2;                // 0 when idle: feet planted
      ctx.translate(manX - (this._heroFace) * kick * 4,
                    manY + 5 - lift - kick * 3 + hoverT);
      // banks with the WINGBEAT while flying and leans into the WALK while
      // moving; standing still it does neither. An idle rotation at its own
      // unrelated frequency is most of what read as drifting.
      ctx.rotate(flap * 0.028 + (hmoving && !mnt ? -hflip * 0.055 : 0)
                 + this._heroFace * kick * 0.22);
      // NO NON-UNIFORM FLAP SCALE. Widening X while narrowing Y is how you fake
      // a wingbeat on a SHAPE; on a painted character it is just squashing, and
      // it was compounding with the (2-hsq)/hsq breathing pair on two unrelated
      // rhythms. VANUS: "he looks like he's being squashed and around doesn't
      // look like he's actually flying. It just looks weird." A real flap needs
      // real wing frames, which is what ART.images.hero_man_up/_dn are for --
      // the body is identical between them and only the wings move.
      ctx.scale(hflip * (2 - hsq) * (1 + kick * 0.10), hsq * (1 + kick * 0.06));
      ctx.drawImage(himg, -hw0 / 2, -hh0, hw0, hh0);
      // THE MOUTH OPENS. The painted plate has a closed muzzle and there is no
      // open-mouthed variant, so the jaw is drawn: a dark throat wedge at the
      // snout with a hot core, scaled by the same eased kick. It sits inside
      // the sprite's own transform, so the mirror puts it on whichever side he
      // is facing and it can never drift off his face.
      if (b > 0.01) {
        var onBreathPlate = himg === ART.images.hero_breathe;
        var mx = -hw0 * (onBreathPlate ? MUZZLE_B_FWD : MUZZLE_FWD);
        var my = -hh0 * (onBreathPlate ? MUZZLE_B_UP : MUZZLE_UP);
        var open = Math.sin(Math.min(1, b * 1.35) * Math.PI) * 0.9 + 0.1;
        ctx.save();
        ctx.translate(mx, my);
        ctx.scale(1, open);
        // NO DARK CAVITY. The painted plate has a CLOSED muzzle, so a near-black
        // ellipse stamped on it does not read as an open mouth -- magnified, it
        // is a black bar punched through his cheek. On a closed snout the only
        // honest tell is HEAT: the lips glow, the fire leaves, the head kicks.
        // (The real open jaw is the sprite swap below, not paint.)
        ctx.fillStyle = 'rgba(255,150,60,0.55)';
        ctx.beginPath(); ctx.ellipse(-0.6, 0.4, 4.2, 3.8, 0, 0, 6.283); ctx.fill();
        ctx.fillStyle = 'rgba(255,236,180,0.75)';
        ctx.beginPath(); ctx.ellipse(-1.2, 0.6, 2.2, 2.0, 0, 0, 6.283); ctx.fill();
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
        // TONGUES, NOT A CONE, AND NOT ALL ADDITIVE. Two smooth quadratic
        // cones stacked read as a gradient blob -- VANUS: "the breath flame
        // could look better". The first rebuild made five tongues but drew them
        // ALL under 'lighter', and five overlapping additive shapes sum to a
        // flat white lozenge: the silhouettes that were the whole point got
        // erased by their own brightness. So the four body tongues are drawn
        // NORMALLY -- overlapping opaque leaves at spread angles, which is what
        // gives fire its ragged moving edge -- and only the small core is
        // additive. Cosmetic lane: the flicker rides worldT (render time).
        var JT = [
          { a: -0.54, l: 0.60, w: 0.40, f: 23, c0: '255,166,52', c1: '172,40,10' , al: 0.70 },
          { a:  0.51, l: 0.56, w: 0.38, f: 19, c0: '255,156,44', c1: '164,36,9'  , al: 0.70 },
          { a: -0.21, l: 0.93, w: 0.70, f: 27, c0: '255,194,90', c1: '196,56,14' , al: 0.82 },
          { a:  0.23, l: 1.00, w: 0.74, f: 31, c0: '255,186,78', c1: '190,52,12' , al: 0.80 },
        ];
        var CORE = { a: 0.02, l: 0.36, w: 0.26, f: 37, c0: '255,248,228', c1: '255,186,100', al: 0.46 };
        function tongue(T2, jp) {
          // each tongue flickers on its OWN clock, so the tips never line up
          var fk = 0.80 + 0.20 * Math.sin(ht * T2.f + jp * 1.7);
          var tl = jl * T2.l * fk, tw2 = jw * T2.w * fk;
          var ca = Math.cos(T2.a), sa = Math.sin(T2.a);
          var tx = mx - tl * ca, ty = my + tl * sa;     // the muzzle axis runs -x
          var jg = ctx.createLinearGradient(mx, my, tx, ty);
          jg.addColorStop(0.00, 'rgba(' + T2.c0 + ',' + (T2.al * jb).toFixed(3) + ')');
          jg.addColorStop(0.55, 'rgba(' + T2.c1 + ',' + (T2.al * 0.62 * jb).toFixed(3) + ')');
          jg.addColorStop(1.00, 'rgba(' + T2.c1 + ',0)');
          ctx.fillStyle = jg;
          // a leaf: pinched at the lips, belled out, pinched again at the tip
          ctx.beginPath();
          ctx.moveTo(mx, my - 3.0 * open);
          ctx.quadraticCurveTo(mx - tl * 0.45 * ca - tw2 * sa,
                               my + tl * 0.45 * sa - tw2 * ca, tx, ty);
          ctx.quadraticCurveTo(mx - tl * 0.45 * ca + tw2 * sa,
                               my + tl * 0.45 * sa + tw2 * ca, mx, my + 3.0 * open);
          ctx.closePath(); ctx.fill();
        }
        for (var jp = 0; jp < JT.length; jp++) tongue(JT[jp], jp);   // silhouette
        ctx.globalCompositeOperation = 'lighter';
        tongue(CORE, 4);                                            // the heat
        // Muzzle bloom — the light the jet throws back onto his own snout.
        // BIASED FORWARD. Centred on the muzzle at r=16 it reached 21 world
        // units BEHIND his head (measured off the canvas: recoil suppressed,
        // fire alone still lit pixels a third of a body-length back), which
        // read as a pale bar across his brow rather than as flame. Offsetting
        // the centre down the jet keeps the backscatter to a few units.
        // Pushed FURTHER down the jet and dimmed. At mx-7/r12/0.55 the bloom
        // and the hot core between them painted straight over the open jaw, so
        // the one thing the beat exists to show -- VANUS: "he doesnt look like
        // hes spitting it" -- was buried under its own glow.
        var mbx = mx - 13;
        var mb = ctx.createRadialGradient(mbx, my, 0, mbx, my, 11);
        mb.addColorStop(0, 'rgba(255,210,130,' + (0.38 * jb).toFixed(3) + ')');
        mb.addColorStop(1, 'rgba(255,160,60,0)');
        ctx.fillStyle = mb;
        ctx.beginPath(); ctx.arc(mbx, my, 11, 0, 6.283); ctx.fill();
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.restore();
    }
    else {
      // procedural fallback ONLY when he genuinely has no sprite.
      //
      // THIS READ `!inPlate`, AND `inPlate` IS DECLARED NOWHERE. It guarded the
      // combined tower_*_manned plates -- which had Wick baked into them, so the
      // fallback had to be suppressed on a manned machine -- and those plates
      // were deleted when he became a sprite on a mount (see MAN_SCALE). The
      // guard outlived its subject as a bare ReferenceError: harmless only
      // while the hero sprite loads, and ART.load bails after 12s with a warn
      // rather than a failure, so one slow or 404'd asset turned every draw()
      // into a throw that aborted ~38% of the frame -- the whole HUD, the shop,
      // and every overlay.
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
    // CHARGED. This was a pulsing orange RING around him plus a pale-gold
    // ELLIPSE over his head, and VANUS asked what both of them were: "i dont
    // get what the circle on the dragon is or the coin or whatever above him".
    // Fair on both counts. They were one message -- "the breath is ready" --
    // said twice in shapes that name nothing: the ring is a second circle
    // around a dragon who already gets a dashed circle when SELECTED, and the
    // "flame" was a bare ellipse, which is a coin. The breath BUTTON already
    // carries this state with the word BREATH on it, so the ring goes and the
    // ellipse becomes the game's own flameGlyph -- the same drawn flame that
    // button uses, so the mark over his head and the control that spends it
    // are visibly the same thing.
    // ...and then VANUS asked what the flame over his head was too: "whats with
    // the basic looking flame over wicks head? i dont get that". Fair again, and
    // the answer is that it should not be there at all. The breath BUTTON
    // already carries this state, with the word BREATH on it, a charged ring
    // and a cooldown wedge. A second unlabelled marker floating over the dragon
    // is a third way of saying something already said twice. One control, one
    // indicator.
    // HEALTH — shown only when hurt, so a healthy Wick keeps a clean silhouette
    if (h.hp < h.maxHp) {
      var hpf = Math.max(0, h.hp / h.maxHp);
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(h.x - 16, h.y - 50, 32, 4);
      ctx.fillStyle = hpf > 0.5 ? '#9ef58f' : hpf > 0.25 ? '#ffd75e' : '#ff5b5b';
      ctx.fillRect(h.x - 16, h.y - 50, 32 * hpf, 4);
    }
    // THE BREATH METER IS GONE. Wick wore TWO bars stacked over his head and
    // the lower one duplicated the breath button, which already draws a
    // shrinking cooldown wedge AND prints the seconds remaining. VANUS: "wick
    // has 2 bars over his character in game 1 for health 1 for breath but dont
    // need the breath one". Third time today the same answer: the control that
    // spends a resource is where that resource is read.
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
      var pul2 = 0.65 + 0.35 * Math.sin(this.worldT * (4 + 8 * esc));
      ctx.strokeStyle = 'rgba(255,123,123,' + (0.2 + 0.6 * esc * pul2) + ')';
      ctx.lineWidth = 2 + 5 * esc;
      for (var ml = 0; ml < LANES.length; ml++) {
        var m1 = pathPointAt(0, ml), mp3 = R3D.remap(m1.x, m1.y);
        ctx.beginPath(); ctx.ellipse(mp3.x, mp3.y, 40 + 26 * esc, 18 + 12 * esc, 0, 0, 6.283); ctx.stroke();
      }
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
    // The floats still DECAY on the rival's board (skipping that loop would
    // leak them forever); they are simply not DRAWN there -- at 96px wide a
    // world-scale "PAD BONUS -20%" covers her whole cave.
    for (var f = 0; !this.isRival && f < this.floats.length; f++) {
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
  /// Chip width + stride for an n-machine shelf, clamped to the shipped 52/56
  /// so nothing moves until there are more than seven. Solves
  ///   shopX + (n-1)*step + w <= WORLD_W - 12,  shopX = 12,  step = w + 4
  /// for the largest integer w.
  function shopChip(n) {
    n = Math.max(1, n | 0);
    var avail = WORLD_W - 24;                       // 12 in from each world edge
    var w = Math.floor((avail - (n - 1) * 4) / n);
    if (w > 52) w = 52;
    return { w: w, step: w + 4 };
  }

  Game.prototype._hudGeom = function () {
    var v = this.view;
    // computed ONCE: _hudGeom runs from both draw() and the tap path, and
    // _shelf() walks TOWER_ORDER. Guarded because _hudGeom can be reached
    // before mode/mods exist during construction.
    var nChips = 7;
    try { if (this._shelf && this.mode) nChips = this._shelf().length; } catch (e) {}
    var chip = shopChip(nChips);
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
      // THE SHELF SIZES ITSELF TO WHAT IS ON IT. These were fixed at 52/56,
      // which fits exactly seven chips (right edge 400 against a world edge of
      // 420) and NOT eight: an 8th chip ran to 456, i.e. 36 units past the
      // world, clipped off-screen rather than merely tight. The roster was one
      // machine away from a shelf that silently ate its last entry, and nothing
      // would have failed -- it would just not have been there.
      // Derived, so adding a machine can never break it again: fit n chips into
      // (WORLD_W - 24) with a 4-unit gap, capped at the old 52/56 so the
      // seven-chip shelf is byte-identical to what shipped.
      shopW: chip.w, shopStep: chip.step, shopH: 56,
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
    }
    // THE SHOP AND THE HUD BUTTONS ARE NOT PART OF THE BREATH.
    // They used to sit INSIDE the block above, which is gated on
    // `!this.mods.breathOff`. So Smothered Fire — the trial whose pitch is
    // literally "Wick's flame is out. The machines answer alone." — deleted the
    // entire machine shelf, the build hint, the first-run tutorial ring AND the
    // mute/pause/speed row from the screen, while _onTap kept every one of
    // their hit tests live (it has no breathOff guard). The trial that is about
    // building machines was the one trial where you had to buy them by tapping
    // unlabelled black space, and where you could not mute or pause.
    if (this.state === 'playing') {
      // THE SHOP — pick a machine, then tap the cavern floor to place it
      var shelf = this._shelf();
      for (var sc2 = 0; sc2 < shelf.length; sc2++) {
        var sid2 = shelf[sc2], stt = TOWER_TYPES[sid2];
        var sxx = G.shopX + sc2 * G.shopStep, syy = G.shopY;
        var picked = this.shopPick === sc2;
        // YOUR machines, not the board's. crowdMul is a tax on how much brass
        // YOU own -- _buyAt has always charged it that way -- but the shop card
        // read this.towers.length, which in a duel includes HERS. Two price
        // sources, one shown: with her 7 machines up and yours at 0 the chip
        // quoted a 70% markup on a cost that was never charged.
        var ownN = 0;
        for (var oc3 = 0; oc3 < this.towers.length; oc3++) {
          if (this._sameSide(this.towers[oc3].own, 0)) ownN++;
        }
        var chipCost = Math.round(stt.cost * crowdMul(ownN));
        // AFFORDABILITY MUST MATCH THE NUMBER ON THE CARD. This tested against
        // the PAD-discounted price while printing and charging the full one, so
        // a card lit up as buyable, you placed it off a pad, and the build
        // silently refused. A discount is a pleasant surprise, never a promise
        // the shelf makes and the floor breaks.
        var can = this.gold >= chipCost;
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
        // SEVEN AUTHORED MACHINE NAMES WERE RENDERED NOWHERE IN THE GAME. The
        // shelf was seven silhouettes and seven prices, so 'which one is the
        // crossbow' was a question the game refused to answer. 52px of card
        // cannot hold 'Kobold Crossbow', hence the short: field.
        ctx.font = 'bold 7px system-ui, sans-serif';
        inkText(ctx, stt.short || '', sxx + G.shopW / 2, syy + G.shopH - 19,
                can ? '#e8dcc8' : '#7d7266', 3, 1);
        ctx.font = 'bold 11px system-ui, sans-serif';
        inkText(ctx, chipCost + 'g', sxx + G.shopW / 2, syy + G.shopH - 8,
                can ? '#ffd75e' : '#8a7f72', 3, 1);
        ctx.textAlign = 'left';
      }
      if (this.shopPick >= 0) {
        // WHAT YOU ARE ABOUT TO BUY. The shelf chip is a silhouette, a 7px
        // short name and a price -- so five of the seven machines were bought
        // blind, and the two SUPPORTS (Bellows Post, Coin Press) look exactly
        // like the five guns, never fire, and had nothing anywhere telling the
        // player that is on purpose rather than broken. The game already ships
        // a NAME + a sentence + a counter-hint for all ten RAIDERS
        // (ENEMY_CARDS) -- it explained the enemy and refused to explain the
        // player's own tools.
        //
        // This line is the right home for it: it already fires exactly when the
        // player is deciding, it is already full-width, and it was spending
        // itself on the same generic instruction seven times over. The build
        // instruction moves to the second line, where it is still on screen.
        // ONE line, at shopY-9. The band above is not free: START WAVE occupies
        // shopY-67..shopY-15 (G.startY, +52 tall) and the wave-preview pill sits
        // at startY-32, so a second line would have been drawn straight through
        // a primary control. Measured every string at bold 11px: the widest
        // joined line is 345px against 396px of safe width, so name AND blurb
        // fit on the single line that is actually available.
        var armT = TOWER_TYPES[this._shelf()[this.shopPick]];
        ctx.textAlign = 'left';
        if (armT && armT.blurb) {
          ctx.font = 'bold 11px system-ui, sans-serif';
          var nmW = ctx.measureText(armT.name).width;
          var sepW = ctx.measureText('  ').width;
          var blW = ctx.measureText(armT.blurb).width;
          var ax0 = G.cx - (nmW + sepW + blW) / 2;
          // Its own plate. Measured: START WAVE's box bottom is shopY-15 and an
          // 11px cap-height reaches ~8px over the baseline, so a baseline at
          // shopY-9 put the ascenders 2px INSIDE the button. Baseline shopY-5
          // clears it, and the plate keeps the line readable against whatever
          // stretch of painted cavern floor happens to sit behind it.
          ctx.fillStyle = 'rgba(16,10,7,0.82)';
          rr(ctx, ax0 - 8, G.shopY - 17, nmW + sepW + blW + 16, 16, 7); ctx.fill();
          inkText(ctx, armT.name, ax0, G.shopY - 5, '#ffd75e', 4, 1);
          // a support machine speaks in the raiders' cold blue, so "NOT A
          // WEAPON" does not read as just more gold shop copy
          inkText(ctx, armT.blurb, ax0 + nmW + sepW, G.shopY - 5,
                  armT.support ? '#a8e6ff' : '#ffe9c4', 4, 1);
        } else {
          ctx.textAlign = 'center';
          ctx.font = 'bold 12px system-ui, sans-serif';
          inkText(ctx, 'tap the cavern floor to build  ·  pads cost 20% less',
                  G.cx, G.shopY - 8, '#ffe9c4', 4, 1);
        }
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
        // ...AND THEN THE WAVE-PREVIEW PANEL BURIED IT ANYWAY. That comment
        // above is right about START WAVE and missed the panel 18 units higher:
        // the preview draws at py-18 h36 where py = startY-32, i.e.
        // [startY-50, startY-14], AFTER this block -- so it covered 24 of this
        // plate's 28 units including the whole glyph body. Frame one of a new
        // player's first game read 'Pick a mac[####]ap the floor'. The one
        // onboarding sentence in the game, painted over by a panel.
        //
        // startY-84 is where the SECOND hint already sits (py-52 == startY-84),
        // and the two are mutually exclusive (!towers.length vs towers.length),
        // so they now share one y: one law instead of two that can drift apart.
        // Preview panel top is startY-50, so this clears it by 6 units.
        rr(ctx, G.cx - 118, G.startY - 84, 236, 28, 9); ctx.fill();
        ctx.font = 'bold 13px system-ui, sans-serif';
        inkText(ctx, 'Pick a machine, then tap the floor', G.cx, G.startY - 65, '#9ef58f', 4, 1);
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
      // SAME SOURCE AS THE SIM. See waveGroups(): this line used to branch on
      // 'daily' only and threw on every duel intermission.
      var groups = this.waveGroups(this.wave) || [];
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
      // FEATHER ITS TOP EDGE. The lip is a horizontal SLICE of the mound, so it
      // has a dead-straight top — and it lands at y 258 while Wick's feet are at
      // 264, which drew a ruler-straight line across his legs. VANUS: "wicks
      // foot is cut off on the bottom if you look". It was never a crop; it was
      // this seam. Fading the top ~35% of the slice to nothing lets his feet
      // sink INTO the coins instead of being sliced off by them. Cached: the
      // feathered lip is built once, not per frame.
      var lip = this._titleLip;
      if (!lip) {
        lip = document.createElement('canvas');
        lip.width = mound.width; lip.height = Math.round(mound.height * 0.22);
        var lx = lip.getContext('2d');
        lx.drawImage(mound, 0, mound.height * 0.78, mound.width, lip.height,
                     0, 0, lip.width, lip.height);
        lx.globalCompositeOperation = 'destination-out';
        var lg = lx.createLinearGradient(0, 0, 0, lip.height * 0.38);
        lg.addColorStop(0, 'rgba(0,0,0,1)');
        lg.addColorStop(1, 'rgba(0,0,0,0)');
        lx.fillStyle = lg;
        lx.fillRect(0, 0, lip.width, lip.height * 0.38);
        this._titleLip = lip;
      }
      ctx.drawImage(lip, lX, 300 - lH * 0.22, lW, lH * 0.22);
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
    for (var ri = 0; ri < CAMPAIGN_MAPS; ri++) {
      if (Save.unlocked(ri) && (Save.data.stars[ri] | 0) < 3) { next = ri; break; }
    }
    // bounded by rows, not maps — same landmine as the tap side (see there)
    for (var li = 0; li < Math.min(CAMPAIGN_MAPS, G.rows.length); li++) {
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
    inkText(ctx, MAPS[dailySeed() % CAMPAIGN_MAPS].name, dcx, 648, '#c9b8ff', 4, 1);
    var dl2 = todayBest ? 'your best wave ' + todayBest
      : (Save.data.dailyBestWave > 0 ? 'all-time wave ' + Save.data.dailyBestWave : 'endless — no finish line');
    inkText(ctx, dl2, dcx, 662, 'rgba(201,184,255,0.75)', 4, 1);

    // ---- the DUEL plate ---------------------------------------------------
    forgePlate(ctx, DU, 'cold');
    ctx.font = 'bold 16px system-ui, sans-serif';
    inkText(ctx, 'DUEL', ducx, DU.y + 33, '#ffd9c4', 5, 2);
    // Crossed-wrench mark: this is the one mode with somebody on the other
    // side. Parked against the plate's left edge — at ducx-30 it printed
    // straight through the D of DUEL.
    ctx.strokeStyle = 'rgba(255,190,150,0.8)'; ctx.lineWidth = 1.8;
    var mkx = DU.x + 15, mky = DU.y + 27;
    ctx.beginPath();
    ctx.moveTo(mkx - 5, mky - 5); ctx.lineTo(mkx + 5, mky + 5);
    ctx.moveTo(mkx + 5, mky - 5); ctx.lineTo(mkx - 5, mky + 5);
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
        inkText(ctx, live ? 'TRIALS ' + tDone + '/' + (TRIAL_ORDER.length * CAMPAIGN_MAPS) : 'TRIALS', pcx, pcy + 17,
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
    // IT SAID "two caves". That is the shape VANUS rejected twice -- a second
    // board in an inset -- and the mode has been ONE cavern with two sides
    // since. Copy that describes the old format is the same lie as a dial that
    // no longer does anything.
    ctx.fillText('One cavern, split down the middle. The same raiders', WORLD_W / 2, 172);
    ctx.fillText('down both roads. Keep more gold than they do.', WORLD_W / 2, 188);
    ctx.fillStyle = 'rgba(232,203,180,0.6)'; ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(DUEL_WAVES + ' waves · no forge craft · all seven machines', WORLD_W / 2, 208);

    for (var i = 0; i < RIVAL_ORDER.length; i++) {
      var rv = RIVALS[i], ry = DG.top + i * DG.pitch;
      var rec = Save.data.duels[rv.id];
      var ready = rivalReady(i);
      uiPanel(ctx, DG.x, ry, DG.w, DG.h, 11);
      ctx.textAlign = 'left';
      // name + rank
      ctx.fillStyle = ready ? '#ffe4cf' : '#7a6a5c';
      ctx.font = 'bold 17px system-ui, sans-serif';
      ctx.fillText(rv.name, DG.x + 14, ry + 24);
      ctx.fillStyle = ready ? 'rgba(255,190,150,0.75)' : 'rgba(140,124,110,0.7)';
      ctx.font = 'bold 9px system-ui, sans-serif';
      var rankX = DG.x + 14 + ctx.measureText(rv.name).width + 46;
      ctx.fillText(rv.rank, rankX, ry + 23);
      // Difficulty pips, MEASURED (see RIVALS): three flames is the ceiling and
      // the two mid rivals genuinely share a rung, so two of them show two.
      var pipX = rankX + ctx.measureText(rv.rank).width + 10;
      for (var pp = 0; pp < 3; pp++) {
        var lit = pp < (rv.pips | 0);
        ctx.fillStyle = lit ? (ready ? 'rgba(255,150,60,0.95)' : 'rgba(120,104,90,0.8)')
                            : 'rgba(255,255,255,0.13)';
        ctx.beginPath(); ctx.arc(pipX + pp * 9, ry + 19, 3, 0, 6.283); ctx.fill();
      }
      ctx.fillStyle = ready ? 'rgba(232,203,180,0.8)' : 'rgba(122,106,92,0.8)';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(rv.blurb, DG.x + 14, ry + 42);
      // tonight's ground — the arena rotates daily, so name it
      ctx.fillStyle = 'rgba(201,184,255,0.7)'; ctx.font = '10px system-ui, sans-serif';
      ctx.fillText(ready ? 'tonight: ' + MAPS[duelMapFor(i)].name : 'no plan yet',
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
      for (var lv2 = 0; lv2 < CAMPAIGN_MAPS; lv2++) {
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
      // A TIE IS NOT A WIN, even though it is scored as one. Ties go to the
      // player (`hoard >= rivalHoard`), so "DUEL WON!" over a dead-level
      // scoreline is true by the rule and reads as a lie by the number -- the
      // margin line right underneath says +0. Name it for what it is.
      var tie = (r.margin | 0) === 0 && r.won;
      ctx.fillText(r.won ? (r.knockout && (r.rivalHoard | 0) <= 0 ? 'SACKED THEM!'
                            : tie ? 'DEAD LEVEL — YOU KEEP IT' : 'DUEL WON!')
                         : 'DUEL LOST', WORLD_W / 2, 314);
      if (tie) ctx.font = 'bold 25px Georgia, serif';
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
