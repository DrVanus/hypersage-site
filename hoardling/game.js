/* Hoardkeep — single-file canvas tower-defense engine.
 * Defend the sleeping Elder Dragon's gold hoard from waves of "hero" raiders.
 * Raiders that reach the hoard STEAL treasure and flee; kill them to recover it.
 * The hoard is the life bar. READ HANDOFF.md:
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
      // A separate top-down painted weapon turns in the projected ground
      // plane over a fixed operator and drum. _crossbowPose shares its visible
      // rail and muzzle with shot presentation; _muzzleOf retains simulation
      // launch geometry so this art change cannot rebalance hit timing.
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
  // with real floor perspective, and the torches each map declares lit
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
  // nearest declared fixture. The same floor anchors position the visible braziers.
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
    // the same answer: both sides get all EIGHT. The rival's curve was baked
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
    // rewards splash, which is the lesson VANUS liked: one kill can
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
      torches: [[38, 643], [388, 478], [44, 332], [254, 633], [309, 354], [46, 552]],
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
      torches: [[32, 690], [396, 565], [135, 504], [338, 223], [398, 440]],
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
      torches: [[46, 730], [396, 680], [46, 530], [396, 410], [32, 300]],
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
      torches: [[249, 618], [266, 380], [290, 710], [34, 311], [78, 494], [344, 500]],
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
      torches: [[254, 488], [320, 722], [22, 476], [368, 326], [154, 524], [38, 356]],
      heroStart: { x: 212, y: 716 },
      pathW: 34,
    },
    { // Arena C — "The Split Cavern": ONE cave, TWO hoards, a road each.
      //
      // THE DUEL FORMAT. VANUS: "the same map but it's not the same map that
      // I'm on with two different rows and we're both on the same map
      // together". The earlier duel gave each side its own COPY of a board and
      // showed the opponent in an inset -- and it
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
      torches: [[176, 710], [244, 710], [176, 406], [244, 406]],
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
      // tools/torch_clearance.js measures torches against the PAINTED road bed
      roadSurfaceSamples: roadSurfaceSamples, lanes: function () { return LANES; },
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
      // The property the owner asked for is not gore -- it is:
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
        // the usual -16, so that no crossfade between two tracks is
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
    var XFADE = 1.4;                     // the crossfade law
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
      fetch(assetURL('audio/music_map.json')).then(function (r) { return r.json(); })
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
      fetch(assetURL('audio/' + name + '.m4a'))
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
  // campaign. (HISTORIC: "the Undergallery and the Coldroot Stair take three
  // arenas each" was true of the one-road arenas this paragraph was written
  // for. All six arenas are map 5 now -- see the orphan note below.)
  // Because a map is now stated rather than derived, a seed is free to appear
  // on whichever road suits it.
  // Interleaved m1/m2 ON PURPOSE: tonight's arena is (day + rivalIdx) % 6,
  // so four consecutive indices are what the picker shows at once. Grouped
  // by map, that put three of the four rivals on the same road every night.
  // This list is now free to be reordered: nothing is indexed against it any
  // more, because nothing about a rival is recorded ahead of time.
  // THE ARENAS ARE NOW THEIR OWN GROUND. Every one of these used to be map 1 or
  // map 2 -- the two boards the campaign already walks you through -- so a duel
  // was a level you had played, with a scoreboard. VANUS: "why is our dual game
  // just the same as any other game and every map is all the same".
  //
  // *** MAPS 3 AND 4 ARE ORPHANED. READ THIS BEFORE BELIEVING ANYTHING ABOUT
  // THEM. *** The Twin Throats and the Sunder were built as the duel's two-road
  // arenas and this comment described them as such for two days after they
  // stopped being used. Every DUEL_ARENAS entry below is `map: 5` -- The Split
  // Cavern, ONE cavern down the middle with a keep and a road each and both
  // dragons on screen, which is the shape VANUS actually asked for and the
  // second one built (the two-road maps read to him as the two PLAYERS' lanes,
  // which is why the split road confused him). So maps 3 and 4 are reachable
  // from NOTHING: the campaign clamps to 0..CAMPAIGN_MAPS-1, the daily is
  // seed % CAMPAIGN_MAPS, and the duel is map 5 six times over. That is 20 pads
  // and 12 torches of hand-placed level art drawn by no code path.
  // They are KEPT, not deleted, because wiring one back costs a wave table and
  // a campaign row and the art is already done. Nothing in the game may claim
  // they are in it until that happens.
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
    { id: 'tallow', tint: '#e0c070', coat: 'bone', finish: 'brass',   keep: 'stone',  hoard: 'copper', name: 'Tallow', rank: 'APPRENTICE', pips: 1, policy: 'rival_tallow', wick: false, purse: 0.85,
      blurb: 'Builds wide and cheap. Never upgrades a thing.' },
    { id: 'flint',  tint: '#7fb0e0', coat: 'cobalt', finish: 'iron', keep: 'slate',  hoard: 'silver', name: 'Flint', rank: 'BROAD HAND', pips: 2, policy: 'rival_flint', wick: false, purse: 0.75,
      blurb: 'Spreads his brass thin and wide. Loves a long road.' },
    { id: 'ember',  tint: '#ff8a3c', coat: 'bronze', finish: 'gilt', keep: 'sand',   hoard: 'coin', name: 'Ember', rank: 'DEEP HAND', pips: 2, policy: 'rival_ember', wick: false, purse: 0.95,
      blurb: 'Few machines, all of them monsters. Wants a chokepoint.' },
    { id: 'cinder', tint: '#b06adf', coat: 'amethyst', finish: 'bone', keep: 'basalt', hoard: 'gem', name: 'Cinder', rank: 'DRAKE', pips: 3, policy: 'rival_cinder', wick: true, purse: 1.15,
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

  // ===== COSMETICS — "YOUR CAVERN" =======================================
  /// Five equip slots: COAT (Wick), COIN, HOARD, KEEP, ROAD. Bought with
  /// HOARD MARKS, the one meta currency, earned from campaign/trial/duel/daily
  /// milestones (MARK_AWARDS) and never dripped per-second — this game has an
  /// Endless mode and a drip would be a faucet inside a day.
  ///
  /// THE LAW THAT MAKES THIS SAFE. Hoardling has a seeded Daily, a duel and a
  /// leaderboard, so an owned item is the classic way to fork a shared seed:
  ///
  ///   NO seeded draw may sit on any path whose reachability, branch or
  ///   ITERATION COUNT depends on what the player owns or has equipped.
  ///
  /// Every cosmetic here is lane 3 — read only by draw()/_cosmetic(), never by
  /// update(). Nothing in this block changes a stat, a cost, a range or a
  /// count. If a skin ever needs to move, it moves in the render lane off
  /// Math.random, exactly like every other particle in this file.
  ///
  /// PROPS ARE PALETTES UNTIL THE ART LANDS. coin/hoard/keep/road each carry
  /// their colours, so the shop shows real differences today and a sprite drops
  /// into the same seam later (`art` field, null = draw it procedurally).

  /// COATS — recoloured from Wick's own plate, NEVER generated.
  /// /v1/images/edits has no identity conditioning: a prompt for "green Wick"
  /// returns a different dragon. Hoardling has a written identity law
  /// (vivid red, white-sclera amber iris, faceted hex plates, cream ribbed
  /// belly, brass goggles) and six rounds of icon work behind it.
  ///
  /// MEASURED on art/hero_whelp.png, which is what makes this exact:
  ///   scales           hue 0.009 - 0.034   (pure red)
  ///   belly + brass    hue 0.078 - 0.105   (orange-brown)
  /// The two materials separate by hue alone, so no painted mask is needed --
  /// but this used to claim "a clean EMPTY gap between them", and that is
  /// false: 27.3% of the dragon (66,808 opaque chromatic px) lies strictly
  /// between 0.034 and 0.078. What the kernel actually relies on is that the
  /// two SELECTORS are disjoint by construction -- COAT_SCALE is gone by 0.048,
  /// COAT_WARM does not begin until 0.047 -- so those in-between pixels are
  /// taken by the warm shoulder and CREAMED rather than hue-shifted. That is
  /// why the scale/belly boundary reads as a soft material transition and not
  /// as a seam.
  ///
  /// THE BELLY NEVER TAKES THE HUE. Letting it follow even 45% of the way gave
  /// a Cobalt dragon a MAGENTA chest stripe (and following 0% gave a RED one on
  /// far hues, which is how this started). It is DRAINED TOWARD CREAM in
  /// proportion to how far the scales travelled — which is what the icon law
  /// said the belly was in the first place. Brass reads as brass on all eight.
  var COAT_SCALE = { c: 0.021, full: 0.025, gone: 0.048, s0: 0.25, s1: 0.50 };
  var COAT_WARM  = { c: 0.092, full: 0.020, gone: 0.045, s0: 0.30, s1: 0.55 };
  var COAT_CREAM = 0.62;      // max belly desaturation at maximum hue travel

  var COATS = [
    { id: 'ember',     name: 'Ember',        hue: null,  sat: 1.00, val: 1.00, price: 0,
      how: 'Wick as he is.' },
    { id: 'verdigris', name: 'Verdigris',    hue: 0.365, sat: 0.86, val: 1.02, price: 120,
      how: 'Copper left too long in a wet cave.' },
    { id: 'bronze',    name: 'Old Bronze',   hue: 0.095, sat: 0.95, val: 1.06, price: 120,
      how: 'Foundry-warm, straight off the pour.' },
    { id: 'cobalt',    name: 'Cobalt',       hue: 0.590, sat: 0.92, val: 1.00, price: 200,
      how: 'Deep-seam blue. Cold to the touch.' },
    { id: 'viridian',  name: 'Sea Serpent',  hue: 0.470, sat: 0.90, val: 0.98, price: 200,
      how: 'Something in the family swam.' },
    { id: 'amethyst',  name: 'Amethyst',     hue: 0.775, sat: 0.88, val: 1.00, price: 260,
      how: 'Gem-struck. The rarest seam in the mountain.' },
    { id: 'obsidian',  name: 'Obsidian',     hue: 0.980, sat: 0.22, val: 0.60, price: 260,
      how: 'Glass and ash. Nothing reflects off him.' },
    { id: 'bone',      name: 'Bone Wyrm',    hue: 0.105, sat: 0.20, val: 1.30, price: 320,
      how: 'Pale as the things further down.' },
  ];

  /// MATERIAL BANDS for the KEEP. Same idea as COAT_SCALE/COAT_WARM and the
  /// same reason it works: a painted object's materials sit on disjoint hue
  /// bands, so each can be moved on its own instead of washing the whole plate.
  ///
  /// MEASURED on art/keep.png (opaque px, alpha > 200):
  ///   hue 0.06-0.11  n=90,334  sat 0.56  val 0.61   cream MASONRY, the bulk
  ///   hue 0.56-0.67  n=64,629  sat 0.72  val 0.44   royal-blue ROOFS
  ///   hue 0.11-0.17  n=2,362   sat 0.60  val 0.95   amber WINDOW GLOW
  /// (These were once quoted as 2737 / 1750 / 52 -- SAMPLE counts from a
  /// subsampled scan printed as populations, 33x to 45x low. The proportions
  /// were right, which is why the design held; the absolutes were not.)
  /// Three materials, three disjoint bands. art/keep_slate.png is NOT a usable
  /// base -- its stone AND its roofs both sit at 0.56-0.61, one family.
  ///
  /// BANDS ARE PRIORITISED, NOT CEILINGED. The window glow sits close enough to
  /// the masonry band's shoulder to be caught by it, and driving masonry to
  /// val x0.42 dragged the hot window cores down: the basalt keeps came back
  /// with YELLOW-GREEN windows, in a game whose fantasy is a forge burning
  /// inside the rock.
  ///
  /// The first fix was a hard value ceiling on masonry (vmax 0.80) and it was
  /// WORSE, in a way that only showed up when the candidates were judged in
  /// context. MEASURED: that ceiling excluded 23.0% of the WARM pixels at mean
  /// value 0.90 -- 13.6% of the whole opaque plate, and the entire LIT SIDE of
  /// it. (This read "23.8% of the castle", promoting a share of the warm pixels
  /// into a share of the building.) So
  /// the shadow side went black while the lit side stayed cream, and the
  /// terminator between them became a hard ragged step straight through the
  /// gold dragon crest and the archway. A judge lens caught it; the eye did
  /// not, because on a small tile it reads as contrast rather than as a seam.
  ///
  /// Priority is the right tool and needs no threshold at all: the bands are
  /// listed most-specific-first, each claims what is left of the pixel
  /// (eff = w * remaining), and the general masonry band takes the remainder.
  /// A glow pixel is claimed by GLOW, so masonry never sees it; a lit stone
  /// pixel is claimed in full; everything between blends smoothly, which is
  /// exactly what a terminator needs.
  // widened now that GLOW claims first -- masonry may safely cover all the warm stone
  // Above this value the per-band shadow lift is inert -- see `lift` below.
  var LIFT_KNEE   = 0.22;

  /// MATERIAL BANDS for the MACHINES. Same kernel as the keep, different shape
  /// of subject: a keep is three materials on three bands, a machine is
  /// essentially ONE.
  ///
  /// MEASURED, pooled over all 10 machine plates (opaque, sat > 0.18,
  /// n = 1,918,926):
  ///   hue 0.00-0.15   87.8%   brass, wood, iron -- one warm family
  ///   hue 0.50-0.70    8.4%   the teal RIM LIGHT the style header requires
  /// So the finish moves one wide warm band, and the rim is PROTECTED by
  /// claiming it first with identity multipliers -- the same priority trick the
  /// keep's GLOW band uses. Recolouring a lighting effect as if it were
  /// material is how the keep's rim light got eaten the first time.
  var MAT_BRASS = { c: 0.075, full: 0.075, gone: 0.110, s0: 0.10, vmax: 1.01, vmin: 0.00 };
  var MAT_RIM   = { c: 0.575, full: 0.075, gone: 0.110, s0: 0.15, vmax: 1.01, vmin: 0.00 };
  var MAT_MASONRY = { c: 0.085, full: 0.050, gone: 0.070, s0: 0.06, vmax: 1.01, vmin: 0.00 };
  /// ROOF EXCLUDES THE TEAL RIM LIGHT, and that is not a tuning preference.
  /// MEASURED: the shipped keep has a teal band at hue 0.50-0.56 (n=5,244,
  /// sat 0.83) which is the RIM LIGHT the style header requires -- "a thin
  /// saturated teal rim light traces the right edge" -- and the roofs proper
  /// sit at 0.56-0.67. A roof band wide enough to reach 0.545 does two bad
  /// things at once:
  ///   1. it recolours a LIGHTING EFFECT as if it were roof material, and
  ///   2. hue 0.545 is EXACTLY ANTIPODAL to the terracotta roof target 0.045,
  ///      where "the short way round" is undefined -- so two pixels a hair
  ///      apart, or two implementations of the same maths, rotate in OPPOSITE
  ///      directions and the rim light comes out as colour speckle. Measured
  ///      against the Python preview: 299 pixels differing by up to 185, and
  ///      the worst ones were channel ROTATIONS of each other, the signature.
  /// Narrowing the band to 0.065 leaves the rim light alone and puts the
  /// instability out of reach.
  var MAT_ROOF    = { c: 0.615, full: 0.055, gone: 0.065, s0: 0.15, vmax: 1.01, vmin: 0.00 };
  // GLOW IS THE BRIGHT THING, so it is gated from BELOW -- vmin, not vmax.
  // MEASURED: the first glow band fell off to hue 0.08, which is MASONRY'S OWN
  // CENTRE (0.085), so with priority ordering it claimed 22.0% of the stone.
  // On a basalt that left its masonry hue alone, that dragged a fifth of the
  // castle to the glow's own hue and an adversarial judge measured the result
  // exactly: "the flame is 1.0 degrees of hue from the wall immediately around
  // it" and "saturated orange has bled off the light sources onto the masonry".
  // A fire that is the same colour as the rock it is inside is not a fire.
  // Narrowed to 0.098-0.182 and floored at v 0.78: zero weight at masonry's
  // centre, and 90% of real glow pixels still claimed.
  var MAT_GLOW    = { c: 0.140, full: 0.030, gone: 0.042, s0: 0.20, vmax: 1.01, vmin: 0.78 };

  /// COINS — HUD AND MENU CHROME ONLY: the top-left counter, the title pill,
  /// the Cavern's wallet and cards, and the result screen's marks chip. The
  /// FACE is a castle and the ALLOY under it is the grade: the stamp says whose
  /// mint, the metal says how good. Two axes off one drawing.
  ///
  /// IT DOES NOT SKIN THE `+N` POPS OR A THIEF'S LOOT, and this comment used to
  /// say it did. Both are deliberate rather than missed: the pops are TEXT in
  /// the gold colour, and the carried coins are baked into _bakeLedger's shared
  /// atlas, which is drawn for BOTH caves -- feeding the player's coin in would
  /// paint a purchased skin onto the rival's thieves, breaking the separation
  /// the duel pip is hardcoded cool to preserve.
  var COINS = [
    { id: 'gate',   name: 'Copper Gatehouse', art: 'coin_gate', price: 0,
      face: '#e0a468', edge: '#8a5a1d', ink: '#7a4418', stamp: 'gate',
      how: 'The coin Wick has always counted in.' },
    { id: 'keepc',  name: 'Silver Keep',      art: 'coin_keep', price: 140,
      face: '#d8dee6', edge: '#7d8894', ink: '#5c6672', stamp: 'keep',
      how: 'Struck for the Long Sleep. Still legal tender.' },
    { id: 'citadel',name: 'Gold Citadel',     art: 'coin_citadel', price: 220,
      face: '#ffd75e', edge: '#8a5a1d', ink: '#8a5a1d', stamp: 'citadel',
      how: 'Three towers over a curtain wall, in high relief.' },
    { id: 'bastion',name: 'Blackiron Bastion',art: 'coin_bastion', price: 300,
      face: '#5a5f68', edge: '#2b2e34', ink: '#c9cfd8', stamp: 'bastion',
      how: 'Iron does not shine. That is the point.' },
    { id: 'spire',  name: 'Electrum Spire',   art: 'coin_spire', price: 380,
      face: '#f2e9a8', edge: '#a08b3c', ink: '#7d6a24', stamp: 'spire',
      how: 'Gold and silver, poured together, arguing.' },
  ];

  /// HOARDS — the pile the keep sits on. This is the LIFE BAR, so it is the
  /// most-looked-at object on the board and the slot worth owning.
  var HOARDS = [
    { id: 'coin',  name: 'Coin Bank',    art: null, price: 0,   tint: null,
      how: 'Loose coin, heaped and slipping.' },
    { id: 'silver',name: 'Silver Tithe', art: 'hoard_silver', price: 160, tint: '#cfd6de', sat: 0.30, val: 1.12,
      how: 'A colder pile. Reads clean across the cavern.' },
    { id: 'gem',   name: 'Gem Seam',     art: 'hoard_gem', price: 240, tint: '#7fd4e8', sat: 0.85, val: 1.05,
      how: 'Cut stones packed in among the coin.' },
    { id: 'copper',name: 'Copper Run',   art: 'hoard_copper', price: 160, tint: '#e08a4a', sat: 0.90, val: 0.96,
      how: 'What a small workshop actually earns.' },
    { id: 'plate', name: 'Plate & Cup',  art: 'hoard_plate', price: 300, tint: '#ffe9a8', sat: 0.72, val: 1.18,
      how: 'Goblets, salvers, a crown nobody claims.' },
  ];

  /// KEEPS — one sprite, one call site (_drawKeep). Tinted until art lands.
  var KEEPS = [
    { id: 'stone',  name: 'Grey Stone',   art: null, price: 0,   tint: null,
      how: 'The keep above the workshop.' },
    { id: 'slate',  name: 'Slate Roofs',  art: 'keep_slate', price: 150, tint: '#8fa4c0', sat: 0.55, val: 1.02,
      how: 'Slate walls, slate roofs. Cut cold and set square.' },
    { id: 'sand',   name: 'Sandstone',    art: null, price: 150,
      art: 'keep_sand',
      // S1, unanimous first place on all four judge lenses (material honesty,
      // set coherence, legibility at true size, adversarial). ORDER IS
      // PRIORITY: the GLOW entry multiplies by 1.0 and exists only to CLAIM
      // the window pixels so the masonry band below it never sees them.
      bands: [{ band: MAT_GLOW,    hue: null,  sat: 1.00, val: 1.00 },
              { band: MAT_ROOF,    hue: 0.045, sat: 0.95, val: 1.05 },
              { band: MAT_MASONRY, hue: 0.100, sat: 1.25, val: 1.12 }], tint: '#e6c489', sat: 0.62, val: 1.10,
      how: 'Warm rock from the shallow galleries.' },
    { id: 'basalt', name: 'Basalt',       art: null, price: 230,
      art: 'keep_basalt',
      // B3 "ember black" + a 0.06 shadow lift. Two judge lenses that specialise
      // in material read and in adversarial scrutiny both ranked B3 first, and
      // it was the ONLY candidate no lens raised a blocker against: B1's glow
      // measured YELLOWER than the stock castle it replaces (39.8 deg against
      // 32.2) and landed in the gold heap's own hue band, so its "fire" read as
      // more trim on the pile; B2's flame sat 1 degree from the wall around it.
      // The third lens ranked B3 last on one measured count -- its doorway fell
      // to L* 11.6, below the cavern floor at 19.6 -- and the shadow lift is the
      // answer to exactly that: door 21.6 (better than stock's 20.7) with the
      // near-black stone share still 32.1% against B2's 27.4%.
      bands: [{ band: MAT_GLOW,    hue: 0.075, sat: 1.35, val: 1.20 },
              { band: MAT_ROOF,    hue: null,  sat: 0.15, val: 0.42, lift: 0.06 },
              { band: MAT_MASONRY, hue: 0.030, sat: 0.25, val: 0.38, lift: 0.06 }], tint: '#5a5560', sat: 0.35, val: 0.74,
      how: 'Cut from the seam the fire came up through.' },
  ];

  /// ROADS — the one tile composited into _pathCache. Equipping one MUST
  /// invalidate that cache (see the road id in the cache key), or the change
  /// does not appear until the next level load.
  var ROADS = [
    { id: 'cobble', name: 'Old Cobble',   art: null, price: 0,   tint: null,
      how: 'The road they have always come down.' },
    { id: 'flag',   name: 'Flagstone',    art: 'road_flag', price: 140, tint: '#b9b3a4', sat: 0.40, val: 1.08,
      how: 'Laid flat. Easier on a laden thief.' },
    { id: 'bone',   name: 'Bone Road',    art: 'road_bone', price: 220, tint: '#e8e0cc', sat: 0.22, val: 1.22,
      how: 'Paved with what the last lot left behind.' },
    { id: 'ash',    name: 'Ashfall',      art: 'road_ash', price: 220, tint: '#4e4a52', sat: 0.25, val: 0.72,
      how: 'Scorched black. Wick has been practising.' },
  ];

  /// FINISHES — the machines. This is the surface a player looks at most: five
  /// to ten contraptions are on the board for a whole run, and every one of them
  /// was the same brass until now. Recoloured, never generated: they are
  /// painted assets with a house palette, and the same argument that bans
  /// generating Wick bans regenerating them.
  ///
  /// ORDER IS PRIORITY, as everywhere else: RIM first so the teal edge light is
  /// claimed before the warm band can reach it.
  var FINISHES = [
    { id: 'brass',  name: 'Workshop Brass', price: 0,   bands: null,
      how: 'What Wick builds with.' },
    { id: 'iron',   name: 'Blackiron',      price: 180,
      bands: [{ band: MAT_RIM, hue: null, sat: 1.00, val: 1.00 },
              { band: MAT_BRASS, hue: null, sat: 0.16, val: 0.60, lift: 0.05 }],
      how: 'Stripped, blacked and re-riveted.' },
    { id: 'verd',   name: 'Verdigris',      price: 220,
      bands: [{ band: MAT_RIM, hue: null, sat: 1.00, val: 1.00 },
              { band: MAT_BRASS, hue: 0.420, sat: 0.72, val: 0.98 }],
      how: 'Left out in a wet cave and forgiven.' },
    { id: 'gilt',   name: 'Gilt Works',     price: 300,
      bands: [{ band: MAT_RIM, hue: null, sat: 1.00, val: 1.00 },
              { band: MAT_BRASS, hue: 0.120, sat: 1.18, val: 1.16 }],
      how: 'He spent the hoard on the machines.' },
    { id: 'bone',   name: 'Bonework',       price: 260,
      bands: [{ band: MAT_RIM, hue: null, sat: 1.00, val: 1.00 },
              { band: MAT_BRASS, hue: 0.095, sat: 0.20, val: 1.22 }],
      how: 'Ivory and gut. Quieter than brass.' },
  ];

  /// THE SLOT TABLE — the one place that knows the six slots exist. Order is
  /// the Cavern screen's row order.
  /// `base` is the STOCK art id for the slot. The stock item of every prop slot
  /// has art:null and tint:null -- it IS the shipped sprite -- so without this
  /// the Cavern drew it as a plain gold ball beside four real tiles, which
  /// reads as a missing asset rather than as "the one you already had".
  var SLOTS = [
    { id: 'coat',  name: 'DRAGON', items: COATS,  base: null },
    { id: 'coin',  name: 'COIN',   items: COINS,  base: null },
    { id: 'hoard', name: 'HOARD',  items: HOARDS, base: 'mound' },
    { id: 'keep',  name: 'KEEP',   items: KEEPS,  base: 'keep' },
    { id: 'road',  name: 'ROAD',   items: ROADS,  base: 'road' },
    { id: 'finish',name: 'WORKS',  items: FINISHES, base: 't_ballista' },
  ];
  var SLOT_BY_ID = {};
  for (var _si = 0; _si < SLOTS.length; _si++) SLOT_BY_ID[SLOTS[_si].id] = SLOTS[_si];

  /// item(slot, id) -> the item, or the slot's default (index 0, always free).
  /// NEVER returns null: every draw path calls this and a missing skin must
  /// render the stock game, not throw.
  function cosItem(slot, id) {
    var s = SLOT_BY_ID[slot];
    if (!s) return null;
    for (var i = 0; i < s.items.length; i++) if (s.items[i].id === id) return s.items[i];
    return s.items[0];
  }

  /// MARKS — what each milestone pays, ONCE. Every payout below is keyed on a
  /// save flag that was already being written for another reason, so a replay
  /// of an old best cannot re-bill it.
  var MARK_AWARDS = {
    starFirst: 40,     // per star, per level, first time that star is reached
    trialBadge: 60,    // per (level, trial), first clear
    rivalFirst: 90,    // per rival, first win
    dailyWave: 4,      // per WAVE gained on today's best -- see below, this is
                       // NOT per improvement, and the difference is a farm
  };

  var Save = (function () {
    var KEY2 = 'hoardling.save.v2', KEY1 = 'hoardling.save.v1';
    var DAILY_LEDGER = 16;         // ~two weeks of seeds; enough to defeat clock games
    // duels: { <rivalId>: { w: 1, m: <best margin> } } — an OBJECT, not a bare
    // number, because the best margin can legitimately be 0 (a duel won on the
    // tiebreak) and a falsy value would read as "never beaten". Same trap the
    // bountyMul null-check exists for.
    // marks: the HOARD MARKS wallet. owned: { <slot>: { <itemId>: 1 } }.
    // equip: { <slot>: <itemId> }. All three are additive on the SAME v2 key --
    // an existing save just reads the defaults, so there is no migration and no
    // v3 loader to keep in step with this one.
    var data = { stars: [0, 0, 0], dailyBestWave: 0, tut: 0, daily: { day: 0, best: 0 }, forge: {}, seen: {}, trials: {}, duels: {},
    // dailyPaid: the daily payout LEDGER, newest last, capped at DAILY_LEDGER.
    // An ARRAY rather than a map so the eviction order is the data itself --
    // daily seeds are (day+1)*2654435761>>>0 and therefore NOT monotonic, so
    // "evict the smallest key" would drop the wrong one after a wrap.
                 marks: 0, owned: {}, equip: {}, dailyPaid: [] };
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
        if (typeof p.marks === 'number' && isFinite(p.marks)) data.marks = Math.max(0, Math.min(999999, p.marks | 0));
        if (Array.isArray(p.dailyPaid)) {
          for (var dp = 0; dp < p.dailyPaid.length && data.dailyPaid.length < DAILY_LEDGER; dp++) {
            var row = p.dailyPaid[dp];
            if (!row || typeof row !== 'object') continue;
            if (typeof row.s !== 'string' || !/^\d{1,10}$/.test(row.s)) continue;
            if (typeof row.w !== 'number' || !isFinite(row.w) || row.w < 0) continue;
            data.dailyPaid.push({ s: row.s, w: Math.min(9999, row.w | 0) });
          }
        }
        // WHITELIST-ITERATE OUR OWN TABLES, never for-in over the parsed blob:
        // COATS['constructor'] is truthy through Object.prototype and a hostile
        // (or merely corrupt) save must not be able to mint an item id that no
        // draw path knows how to render. Same discipline as forge/trials/duels.
        if (p.owned && typeof p.owned === 'object') {
          for (var os = 0; os < SLOTS.length; os++) {
            var sl = SLOTS[os], row = p.owned[sl.id];
            if (!row || typeof row !== 'object') continue;
            for (var oi = 0; oi < sl.items.length; oi++) {
              if (row[sl.items[oi].id]) {
                (data.owned[sl.id] = data.owned[sl.id] || {})[sl.items[oi].id] = 1;
              }
            }
          }
        }
        if (p.equip && typeof p.equip === 'object') {
          for (var es = 0; es < SLOTS.length; es++) {
            var esl = SLOTS[es], want = p.equip[esl.id];
            if (typeof want !== 'string') continue;
            for (var ei = 0; ei < esl.items.length; ei++) {
              // EQUIPPED IMPLIES OWNED -- a CONSISTENCY guard, not an anti-
              // cheat. It stops a save whose equip and owned maps disagree from
              // rendering an item the shop still shows as locked. It cannot stop
              // hand-editing: anyone editing `equip` can edit `owned` in the
              // same breath, and `marks` is read straight out of the blob. This
              // is a single-player client-side game and its save is the
              // player's; the comment here used to claim otherwise.
              if (esl.items[ei].id === want &&
                  (esl.items[ei].price === 0 || (data.owned[esl.id] && data.owned[esl.id][want]))) {
                data.equip[esl.id] = want;
              }
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
    function addMarks(n) {
      n = n | 0;
      if (n <= 0) return 0;
      data.marks = Math.max(0, Math.min(999999, (data.marks | 0) + n));
      return n;
    }
    function dailyPaidFor(sKey) {
      for (var i = 0; i < data.dailyPaid.length; i++) if (data.dailyPaid[i].s === sKey) return data.dailyPaid[i].w | 0;
      return 0;
    }
    function setDailyPaid(sKey, wave) {
      for (var i = 0; i < data.dailyPaid.length; i++) {
        if (data.dailyPaid[i].s === sKey) { data.dailyPaid[i].w = wave | 0; return; }
      }
      data.dailyPaid.push({ s: sKey, w: wave | 0 });
      while (data.dailyPaid.length > DAILY_LEDGER) data.dailyPaid.shift();
    }
    /// owns(): a price-0 item is owned by everyone, always.
    ///
    /// IT MUST RESOLVE THE ID ITSELF. cosItem() deliberately falls back to
    /// items[0] so no draw path can ever throw on a missing skin -- and items[0]
    /// of every slot is free, so routing owns() through it answered TRUE for any
    /// id at all, including ones that do not exist. grant() then reported a
    /// successful grant it could not persist, because the loader whitelists
    /// unknown ids straight back out.
    function owns(slot, id) {
      var s2 = SLOT_BY_ID[slot];
      if (!s2) return false;
      for (var i = 0; i < s2.items.length; i++) {
        if (s2.items[i].id !== id) continue;
        if (!s2.items[i].price) return true;
        return !!(data.owned[slot] && data.owned[slot][id]);
      }
      return false;                       // no such item in this slot
    }
    function equipped(slot) {
      var s2 = SLOT_BY_ID[slot];
      if (!s2) return null;
      var id = data.equip[slot];
      return (id && owns(slot, id)) ? cosItem(slot, id) : s2.items[0];
    }
    /// buy() is the ONE grant seam. When a store console finally exists, an IAP
    /// grant calls grant() directly and never touches the wallet -- which is why
    /// they are two functions and not one.
    function buy(slot, id) {
      var it = cosItem(slot, id);
      if (!it || owns(slot, id)) return false;
      if ((data.marks | 0) < it.price) return false;
      data.marks -= it.price;
      grant(slot, id);
      return true;
    }
    function grant(slot, id) {
      var it = cosItem(slot, id);
      if (!it) return false;
      (data.owned[slot] = data.owned[slot] || {})[id] = 1;
      write();
      return true;
    }
    function equip(slot, id) {
      if (!owns(slot, id)) return false;
      data.equip[slot] = id; write(); return true;
    }
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
             starsTotal: starsTotal, forgeSpent: forgeSpent, forgeMods: forgeMods,
             addMarks: addMarks, owns: owns, equipped: equipped,
             buy: buy, grant: grant, equip: equip,
             dailyPaidFor: dailyPaidFor, setDailyPaid: setDailyPaid };
  })();

  // ===== Campaign wave checkpoints ======================================
  // One local checkpoint at the opening of the latest campaign wave. It is
  // deliberately separate from the meta save: restarting a wave never rolls
  // back earned stars, cosmetics or marks. Daily/duel scores cannot resume.
  // Bump this schema when changing the meaning of a serialized combat field.
  var CampaignCheckpoint = (function () {
    var KEY = 'hoardling.campaign.v1', VERSION = 1, loaded = false, cached = null;
    var own = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };
    function bad() { throw new Error('invalid campaign checkpoint'); }
    function object(o) { if (!o || Array.isArray(o) || typeof o !== 'object') bad(); return o; }
    function number(n, min, max, integer) {
      if (typeof n !== 'number' || !isFinite(n) || n < min || n > max || (integer && Math.floor(n) !== n)) bad();
      return n;
    }
    function bool(v) { if (typeof v !== 'boolean') bad(); return v; }
    function list(v, max) { if (!Array.isArray(v) || v.length > max) bad(); return v; }
    function fields(o, required, optional, flags) {
      object(o);
      var out = {};
      required.split(' ').filter(Boolean).forEach(function (k) {
        if (!own(o, k)) bad();
        out[k] = number(o[k], -1e7, 1e7);
      });
      (optional || '').split(' ').filter(Boolean).forEach(function (k) {
        if (own(o, k)) out[k] = number(o[k], -1e7, 1e7);
      });
      (flags || '').split(' ').filter(Boolean).forEach(function (k) {
        if (own(o, k)) out[k] = bool(o[k]);
      });
      return out;
    }
    function tar(o, payload) {
      var out = fields(o, payload ? 'd ln w dps dur max tid' : 'd ln w dps until tid');
      number(out.d, 0, 10000); number(out.ln, 0, 1, true);
      number(out.w, 1, 500); number(out.dps, 0, 10000); number(out.tid, 1, 1e7, true);
      if (payload) { number(out.dur, 0.01, 120); number(out.max, 1, 128, true); }
      return out;
    }
    function validate(raw) {
      object(raw);
      if (raw.version !== VERSION || raw.mode !== 'campaign') bad();
      var level = number(raw.level, 0, CAMPAIGN_MAPS - 1, true);
      var wave = number(raw.wave, 0, WAVE_TABLES[level].length - 1, true);
      if (raw.trial !== null && (typeof raw.trial !== 'string' || !own(TRIALS, raw.trial))) bad();
      var out = { version: VERSION, mode: 'campaign', level: level, wave: wave,
        seed: number(raw.seed, 1, 4294967295, true), trial: raw.trial,
        rng: number(raw.rng, -2147483648, 2147483647, true) };
      out.run = fields(raw.run, 'worldT gold hoard nextId stolenLost kills tollRecovered hitstopT', '', 'breathUsed motherReady castMother');
      number(out.run.worldT, 0, 1e7); number(out.run.gold, 0, 1e7);
      number(out.run.hoard, 1, CFG.startHoard, true); number(out.run.nextId, 1, 1e7, true);
      number(out.run.stolenLost, 0, CFG.startHoard, true); number(out.run.kills, 0, 1e7, true);
      // Fixed-step countdowns can end a fraction below zero. Preserve that
      // remainder; rejecting it would stop saves after the first big impact.
      number(out.run.tollRecovered, 0, 1e7, true); number(out.run.hitstopT, -1, 1);
      ['breathUsed', 'motherReady', 'castMother'].forEach(function (k) { bool(out.run[k]); });
      out.hero = fields(raw.hero, 'x y tx ty range dmg rate cd breathCd spd manTid face hp maxHp downT safeT tollCd', '', 'selected castBreath manned');
      ['selected', 'castBreath', 'manned'].forEach(function (k) { bool(out.hero[k]); });
      ['x', 'tx'].forEach(function (k) { number(out.hero[k], 0, WORLD_W); });
      ['y', 'ty'].forEach(function (k) { number(out.hero[k], 0, WORLD_H); });
      number(out.hero.hp, 0, 1000); number(out.hero.maxHp, 1, 1000);
      number(out.hero.range, 1, 1000); number(out.hero.rate, 0.01, 100);
      number(out.hero.spd, 1, 1000); number(out.hero.downT, -1, 60);
      number(out.hero.manTid, -1, out.run.nextId - 1, true);
      var tids = {};
      out.towers = list(raw.towers, 128).map(function (t) {
        var r = fields(t, 'tid level fork x y padIdx cd targeting shotT',
          'own ln jamT lockId ramp shots sweeps _aimX _aimY _auraDmg _auraRate _faceRot _faceSign', '_manned _oc');
        if (typeof t.type !== 'string' || !own(TOWER_TYPES, t.type)) bad();
        r.type = t.type;
        number(r.tid, 1, out.run.nextId - 1, true);
        if (tids[r.tid]) bad(); tids[r.tid] = 1;
        number(r.level, 0, 2, true); number(r.fork, 0, 1, true);
        number(r.x, 0, WORLD_W); number(r.y, 0, WORLD_H);
        number(r.padIdx, -1, MAPS[level].pads.length - 1, true);
        number(r.targeting, 0, AIM_MODES.length - 1, true);
        if (r.own !== undefined && r.own !== 0) bad();
        if (r.ln !== undefined && r.ln !== 0) bad();
        return r;
      });
      // Selling and starting can be two taps in the same update, before the
      // hero pass notices the sold machine. Resolve that stale assignment in
      // the saved copy exactly as the next hero pass does.
      if (out.hero.manTid >= 0 && !tids[out.hero.manTid]) {
        out.hero.manTid = -1; out.hero.manned = false;
      }
      out.tar = list(raw.tar, 384).map(function (p) { return tar(p, false); });
      out.projectiles = list(raw.projectiles, 256).map(function (p) {
        var r = fields(p, 'x y dmg', 'target spd sx sy tx ty t dur splash burn tower own scald net hops dx dy', 'hero crit shieldbreak');
        if (p.kind !== 'lob' && p.kind !== 'bolt' && p.kind !== 'fire') bad();
        r.kind = p.kind;
        if (r.kind === 'lob') {
          ['sx','sy','tx','ty','t','splash','burn','tower','own','scald'].forEach(function (k) { number(r[k], -1e7, 1e7); });
          number(r.dur, 0.01, 10); number(r.t, 0, r.dur);
          r.tar = p.tar === null ? null : tar(p.tar, true);
        } else { number(r.target, 1, out.run.nextId - 1, true); number(r.spd, 1, 2000); }
        return r;
      });
      out.mods = fields(raw.mods, 'dmgMul rangeMul startGold breathCd sellRefund', 'startGoldSet bountyMul fleeMul', 'breathOff');
      number(out.mods.dmgMul, 0.1, 5); number(out.mods.rangeMul, 0.1, 5);
      number(out.mods.startGold, 0, 10000); number(out.mods.breathCd, 0.1, 120); number(out.mods.sellRefund, 0, 1);
      if (out.mods.startGoldSet !== undefined) number(out.mods.startGoldSet, 0, 10000);
      if (out.mods.bountyMul !== undefined) number(out.mods.bountyMul, 0, 10);
      if (out.mods.fleeMul !== undefined) number(out.mods.fleeMul, 0.1, 10);
      if (own(raw.mods, 'bannedTower')) {
        if (typeof raw.mods.bannedTower !== 'string' || !own(TOWER_TYPES, raw.mods.bannedTower)) bad();
        out.mods.bannedTower = raw.mods.bannedTower;
      }
      object(raw.leaks); out.leaks = {};
      Object.keys(raw.leaks).forEach(function (k) {
        if (!own(ENEMY_TYPES, k)) bad();
        var row = fields(raw.leaks[k], 'coins runs firstWave');
        number(row.coins, 0, CFG.startHoard, true); number(row.runs, 0, 1e7, true);
        number(row.firstWave, 1, WAVE_TABLES[level].length, true);
        out.leaks[k] = row;
      });
      return out;
    }
    function clear() {
      cached = null; loaded = true;
      try { localStorage.removeItem(KEY); } catch (_) {}
    }
    function read() {
      if (loaded) return cached;
      loaded = true;
      try {
        var text = localStorage.getItem(KEY);
        if (text) {
          if (text.length > 180000) bad();
          cached = validate(JSON.parse(text));
        }
      } catch (_) { clear(); }
      return cached;
    }
    function capture(g) {
      if (g.mode !== 'campaign' || g.isRival || g.state !== 'playing' || !g.waveActive || g.enemies.length || g.waveT !== 0) return false;
      try {
        var snapshot = validate({ version: VERSION, mode: 'campaign',
          level: g.levelIdx, wave: g.wave, seed: g.seed, trial: g.trial, rng: _stream | 0,
          run: g, hero: g.hero, towers: g.towers, tar: g.tar,
          projectiles: g.projectiles, mods: g.mods, leaks: g.leaks });
        var encoded = JSON.stringify(snapshot);
        if (encoded.length > 180000) bad();
        localStorage.setItem(KEY, encoded);
        cached = snapshot; loaded = true;
        return true;
      } catch (_) { return false; }
    }
    function summary() {
      var r = read();
      return r ? { level: r.level, name: MAPS[r.level].name, wave: r.wave + 1,
        totalWaves: WAVE_TABLES[r.level].length, trial: r.trial ? TRIALS[r.trial].name : null } : null;
    }
    function restore(g) {
      var stored = read();
      if (!stored) return false;
      // Revalidate a detached copy so the resumed sim can never mutate the
      // saved opening while playing. Read-side restore grants no gold/marks.
      var r;
      try { r = validate(JSON.parse(JSON.stringify(stored))); } catch (_) { clear(); return false; }
      g.reset(r.seed, 'campaign', r.level, r.trial);
      Object.keys(r.run).forEach(function (k) { g[k] = r.run[k]; });
      g.hero = r.hero; g.towers = r.towers; g.tar = r.tar; g.projectiles = r.projectiles;
      g.mods = r.mods; g.leaks = r.leaks; g.wave = r.wave; _stream = r.rng;
      g.spawnQueue = g.buildWave(g.wave);
      g.waveActive = true; g.waveT = 0; g.countdown = 0;
      g._waveStartHoard = g.hoard;
      g._bossWave = g.spawnQueue.some(function (s) { return s.type === 'boss'; });
      g._mCue = g._bossWave ? { name: 'boss' } : null;
      g.state = 'playing'; g._acc = 0; g._last = 0;
      Input.drain();
      return true;
    }
    return { capture: capture, summary: summary, restore: restore, clear: clear };
  })();

  // ===== Daily leaderboard (fail-soft, lane 3) ============================
  // Hoardling is board 'hoardling_daily' in a multi-board Supabase
  // schema (registry + authenticated-only RPCs +
  // server-timed single-use tokens + monotonic best). Identity: Supabase
  // NATIVE ANONYMOUS sign-in (probed live 2026-08-13: mints a session
  // directly, no relay/captcha). Config via optional lb-config.js
  // (window.HOARDLING_LB = {url, key, board}); absent config = board off =
  // every path silently no-ops. NOTHING here touches the seeded stream.
  var Lb = (function () {
    var cfg = (typeof window !== 'undefined' && window.HOARDLING_LB) || null;
    /// NOTHING LEAVES THE DEVICE BEFORE A YES (2026-09-13). The opt-OUT switch
    /// that used to live here sat on the result screen, so starting a first
    /// Daily minted an anonymous Supabase user and the run's score was posted
    /// to a public, unretractable board before the player had ever seen the
    /// switch. A switch you meet after the fact is not consent. Now the Daily
    /// plate ASKS (see _drawLbAsk) and on() is true only on an explicit 'yes'.
    ///
    /// consent() is 'yes' | 'no' | null, and null ("never asked") is its own
    /// state: it opens the question, it never reads as either answer. It fails
    /// CLOSED -- a storage read that throws is null, and null is not 'yes'.
    /// Migration: the old hoardling.lbOut === '1' was a tap on "tap to stop",
    /// which IS an answer. '0' was only ever written by "tap to join the
    /// ladder" under a switch that had never explained the board, and an
    /// absent key is every player the old default posted for without asking:
    /// both are asked.
    /// configured() is "is a board wired up at all"; on() is "may we talk to it".
    function configured() { return !!(cfg && cfg.url && cfg.key && cfg.board); }
    function consent() {
      try {
        var c = localStorage.getItem('hoardling.lbConsent');
        if (c === 'yes' || c === 'no') return c;
        if (localStorage.getItem('hoardling.lbOut') === '1') {
          localStorage.setItem('hoardling.lbConsent', 'no');
          localStorage.removeItem('hoardling.lbOut');
          return 'no';
        }
      } catch (e) {}
      return null;
    }
    // Each answer cancels work started under the previous answer, including a
    // quick NO -> YES while an old request is still arriving.
    var consentEpoch = 0;
    function setConsent(yes) {
      consentEpoch++;
      try {
        localStorage.setItem('hoardling.lbConsent', yes ? 'yes' : 'no');
        localStorage.removeItem('hoardling.lbOut');
        // A NO DISCARDS WHAT HAS NOT BEEN SENT. Queued scores were recorded
        // under the old default, and holding them to post on some later yes
        // would send a run the player was never asked about.
        if (!yes) localStorage.removeItem('hoardling.lbq');
      } catch (e) {}
      if (!yes) token = null;
    }
    function on() { return configured() && consent() === 'yes'; }
    function current(epoch) { return on() && epoch === consentEpoch; }
    var sess = null;
    try { sess = JSON.parse(localStorage.getItem('hoardling.sb') || 'null'); } catch (e) {}
    function saveSess() { try { localStorage.setItem('hoardling.sb', JSON.stringify(sess)); } catch (e) {} }
    function tagFor(id) {
      var h = 0;
      for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
      return 'WICK-' + ('0000' + ((h >>> 0) % 65536).toString(16).toUpperCase()).slice(-4);
    }
    // Older saves named the player from a rotating refresh token. Freeze that
    // existing name once; new accounts are named from their stable user id.
    if (sess && sess.refresh_token && !/^WICK-[0-9A-F]{4}$/.test(sess.display_tag || '')) {
      sess.display_tag = tagFor(sess.user_id || sess.refresh_token);
      saveSess();
    }
    function acceptSession(d, refresh) {
      var previous = refresh ? sess : null;
      var uid = d.user && d.user.id || previous && previous.user_id || null;
      sess = { access_token: d.access_token, refresh_token: d.refresh_token,
        expires_at: Date.now() / 1000 + (d.expires_in || 3600), user_id: uid,
        display_tag: previous && previous.display_tag || tagFor(uid || d.refresh_token || 'wick') };
      saveSess();
    }
    function hdrs() {
      return { 'apikey': cfg.key, 'Authorization': 'Bearer ' + (sess && sess.access_token || cfg.key), 'Content-Type': 'application/json' };
    }
    // Share one auth operation: concurrent board/queue/run requests must not
    // create separate anonymous users or race the same refresh token.
    var sessionWaiters = null;
    function ensureSession(cb) {
      if (!on()) { cb(false); return; }
      var epoch = consentEpoch;
      var now = Date.now() / 1000;
      if (sess && sess.access_token && sess.expires_at - 60 > now) { cb(true); return; }
      if (sessionWaiters) { sessionWaiters.push({ epoch: epoch, cb: cb }); return; }
      sessionWaiters = [{ epoch: epoch, cb: cb }];
      function finishSession(ok) {
        var waiting = sessionWaiters; sessionWaiters = null;
        for (var wi = 0; wi < waiting.length; wi++) waiting[wi].cb(ok && current(waiting[wi].epoch));
      }
      var doSignup = function () {
        if (!current(epoch)) { finishSession(false); return; }
        fetch(cfg.url + '/auth/v1/signup', { method: 'POST', headers: { 'apikey': cfg.key, 'Content-Type': 'application/json' }, body: '{}' })
          .then(function (r) { return r.json(); })
          .then(function (d) {
            if (d && d.access_token) {
              acceptSession(d, false);
              finishSession(true);
            } else finishSession(false);
          })
          .catch(function () { finishSession(false); });
      };
      if (sess && sess.refresh_token) {
        fetch(cfg.url + '/auth/v1/token?grant_type=refresh_token', {
          method: 'POST', headers: { 'apikey': cfg.key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: sess.refresh_token }),
        }).then(function (r) { return r.json(); })
          .then(function (d) {
            if (d && d.access_token) {
              // Keep a rotated token locally even if posting was just stopped,
              // but never authorize another request under the old answer.
              acceptSession(d, true);
              finishSession(true);
            } else doSignup();   // refresh rejected: mint a fresh anonymous user
          })
          .catch(function () { finishSession(false); });   // network: not a reason to re-mint
      } else doSignup();
    }
    // Before the first session there is no name to show.
    function hasId() { return !!(sess && sess.refresh_token); }
    function tag() { return sess && sess.display_tag || 'WICK-????'; }
    // strict-pattern render guard: any name
    // that isn't exactly our tag shape paints as WICK-???? — no sanitizer gaps
    function safeName(s) { return /^WICK-[0-9A-F]{4}$/.test(s) ? s : 'WICK-????'; }
    var token = null, runEpoch = 0, receipt = null;
    function beginRun() {
      token = null; receipt = null;
      var run = ++runEpoch, epoch = consentEpoch;
      if (!on()) return;
      ensureSession(function (ok) {
        if (!ok || !current(epoch) || run !== runEpoch) return;
        fetch(cfg.url + '/rest/v1/rpc/waddleton_start_run', {
          method: 'POST', headers: hdrs(), body: JSON.stringify({ p_board: cfg.board }),
        }).then(function (r) { return r.json(); })
          .then(function (t) {
            if (current(epoch) && run === runEpoch && typeof t === 'string' && t) token = t;
          })
          .catch(function () {});
      });
    }
    var VERDICTS = { 'bad-body': 1, 'bad-token': 1, 'too-fast': 1, 'over-rate': 1 };
    function validQ(value) {
      if (!Array.isArray(value)) return [];
      var seen = Object.create(null), out = [];
      for (var i = value.length - 1; i >= 0 && out.length < 10; i--) {
        var e = value[i];
        if (!e || typeof e !== 'object' || typeof e.token !== 'string' ||
            !/^[A-Za-z0-9_-]{1,128}$/.test(e.token) || seen[e.token] ||
            typeof e.wave !== 'number' || !isFinite(e.wave) || e.wave < 1 || e.wave > 80 || Math.floor(e.wave) !== e.wave) continue;
        seen[e.token] = true;
        out.unshift({ token: e.token, wave: e.wave, kills: e.kills | 0, seed: e.seed >>> 0,
          ts: typeof e.ts === 'number' && isFinite(e.ts) ? e.ts : 0,
          tries: Math.max(0, Math.min(7, e.tries | 0)) });
      }
      return out;
    }
    function readQ() { try { return validQ(JSON.parse(localStorage.getItem('hoardling.lbq') || '[]')); } catch (e) { return []; } }
    function writeQ(v) { try { localStorage.setItem('hoardling.lbq', JSON.stringify(validQ(v))); } catch (e) {} }
    // Settle a token against the CURRENT queue. A slow older response must
    // never overwrite a completed run appended while it was in flight.
    function settle(e, drop) {
      var live = readQ();
      for (var i = live.length - 1; i >= 0; i--) if (live[i].token === e.token) {
        if (drop) live.splice(i, 1); else live[i] = e;
      }
      writeQ(live);
    }
    var flushing = false, flushWaiters = [];
    function status() { return { pending: readQ().length, sending: flushing, outcome: receipt && receipt.state || 'none' }; }
    function flush(done) {
      if (!on()) { if (done) done(); return; }
      if (flushing) { if (done) flushWaiters.push(done); return; }
      if (!readQ().length) { if (done) done(); return; }
      var epoch = consentEpoch, attempted = Object.create(null);
      flushing = true; flushWaiters = done ? [done] : [];
      function finishFlush() {
        flushing = false;
        var waiting = flushWaiters; flushWaiters = [];
        for (var wi = 0; wi < waiting.length; wi++) waiting[wi]();
      }
      function failed(e) {
        if (!current(epoch)) { finishFlush(); return; }
        e.tries = (e.tries || 0) + 1;
        var drop = e.tries > 6 || Date.now() - (e.ts || 0) > 36e5;
        settle(e, drop);
        if (receipt && receipt.token === e.token) receipt.state = drop ? 'not-recorded' : 'queued';
        finishFlush();
      }
      ensureSession(function (ok) {
        if (!ok || !current(epoch)) { finishFlush(); return; }
        (function step() {
          if (!current(epoch)) { finishFlush(); return; }
          var live = readQ(), e = null;
          for (var i = 0; i < live.length; i++) if (!attempted[live[i].token]) { e = live[i]; break; }
          if (!e) { finishFlush(); return; }
          attempted[e.token] = true;
          fetch(cfg.url + '/rest/v1/rpc/waddleton_submit_run', {
            method: 'POST', headers: hdrs(),
            body: JSON.stringify({ p_token: e.token, p_board: cfg.board, p_name: tag(), p_value: e.wave }),
          }).then(function (r) { if (!r.ok) throw new Error('http'); return r.json(); })
            .then(function (v) {
              if (!current(epoch)) { finishFlush(); return; }
              if (v && (v.ok || VERDICTS[v.error])) {
                settle(e, true);
                if (receipt && receipt.token === e.token) receipt.state = v.ok ? 'posted' : 'not-recorded';
                step();
              } else failed(e);
            }).catch(function () { failed(e); });
        })();
      });
    }
    // The boolean records initial enqueue only. status() is the live receipt;
    // a result must not claim a score is queued after rejection or delivery.
    function finishRun(wave, kills, seed, done) {
      runEpoch++;
      if (!on() || !token || wave < 1) {
        if (!receipt) receipt = { state: 'not-recorded' };
        if (done) done(); return false;
      }
      var list = readQ(), dup = false;
      for (var i = 0; i < list.length; i++) if (list[i].token === token) dup = true;
      if (!dup) { list.push({ token: token, wave: wave, kills: kills, seed: seed, ts: Date.now() }); writeQ(list); }
      receipt = { token: token, state: 'queued' }; token = null;
      var recorded = readQ().some(function (e) { return e.token === receipt.token; });
      if (!recorded) receipt.state = 'not-recorded';
      flush(done);
      return recorded;
    }
    function top(n, cb) {
      if (!on()) { cb(null); return; }
      var epoch = consentEpoch;
      ensureSession(function (ok) {
        if (!ok || !current(epoch)) { cb(null); return; }
        fetch(cfg.url + '/rest/v1/waddleton_scores?board=eq.' + cfg.board +
              '&select=display_name,value,updated_at&order=value.desc,updated_at.asc&limit=' + n,
              { headers: hdrs() })
          .then(function (r) { return r.json(); })
          .then(function (rows) { cb(current(epoch) && Array.isArray(rows) ? rows : null); })
          .catch(function () { cb(null); });
      });
    }
    if (typeof window !== 'undefined') window.addEventListener('online', function () { flush(); });
    return { on: on, configured: configured, consent: consent, setConsent: setConsent,
             beginRun: beginRun, finishRun: finishRun, top: top, tag: tag, hasId: hasId,
             safeName: safeName, flush: flush, status: status };
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
  var ART = {
    manifest: {
      keep:      'art/keep.png',
      mound:     'art/gold_mound.png',
      hero:      'art/hero_whelp.png',
      hero_breathe: 'art/hero_breathe.png',
      hero_back: 'art/hero_back.png',
      // The crew rig articulates this registered painting. Old wing-frame
      // assets remain on disk for art history but are no longer fetched.
      hero_man:  'art/hero_man.png',
      hero_title: 'art/hero_title.png',
      t_mimic:   'art/tower_mimic.png',
      t_ballista:'art/tower_ballista.png',
      // Keyed masters are decoded to cached alpha layers before finishes.
      t_ballista_base_v2:'art/tower_ballista_base_v2.png',
      t_ballista_turntable_v2:'art/tower_ballista_turntable_v2.png',
      t_brazier: 'art/tower_brazier.png',
      t_crystal: 'art/tower_crystal.png',
      t_perch:   'art/tower_perch.png',
      t_bellows: 'art/tower_bellows.png',
      t_bellows_base_v2: 'art/tower_bellows_base_v2.png',
      t_bellows_fan_v2: 'art/tower_bellows_fan_v2.png',
      t_press:   'art/tower_press.png',
      t_rotor:   'art/tower_rotor.png',
      // the combined manned plates are GONE (see MAN_SCALE) -- Wick
    // is drawn as himself on each machine's own mount point.
      e_looter:  'art/enemy_looter.png',
      e_looter_body_v2: 'art/enemy_looter_body_v2.png',
      e_looter_leg_v2: 'art/enemy_looter_leg_v2.png',
      e_scout:   'art/enemy_scout.png',
      e_brute:   'art/enemy_brute.png',
      e_shield:  'art/enemy_shield.png',
      e_bat:     'art/enemy_bat.png',
      e_warlock: 'art/enemy_warlock.png',
      e_blinker: 'art/enemy_blinker.png',
      e_boss:    'art/enemy_boss.png',
      e_sapper:  'art/enemy_sapper.png',
      e_splitter:'art/enemy_splitter.png',
      // THE MINTED COINS. Bought 2026-08-22 ($0.84, jobs/hoardling_coins.json)
      // -- the castle is the STAMP and the alloy is the GRADE. Installed at
      // 256px square: the biggest use is the 88px Cavern preview and the
      // smallest is a 20px HUD pip, so 700px of coin was 12x more than any
      // draw. Squared on their own alpha bbox first -- drawCoin draws into a
      // square box, and a 680x700 plate renders the coin 3% elliptical, which
      // is the one silhouette an eye checks for free.
      // THE HOARD PILES. Bought 2026-08-22 ($1.00, jobs/hoardling_hoards.json).
      // All four are padded into gold_mound's own 700x485 box, content centred
      // and bottom-anchored: the engine sizes the pile by WIDTH, so plates of
      // different aspect would each render a different height against the keep.
      // THE KEEPS. All three non-stock keeps have bought art now, each padded
      // into art/keep.png's own 519x700 box so every base lands where the stock
      // keep's does.
      //
      // SANDSTONE AND BASALT ARE CHOSEN FOR SILHOUETTE, NOT COLOUR. They shipped
      // first as multi-band recolours of the stock keep, which VANUS called
      // correctly: "some of the castles too repetitive". He was right and it is
      // measurable -- a recolour has IoU 1.000 against the plate it recolours,
      // so three of the four keeps were literally the same building. Measured
      // over all 16 sweep candidates, these two give a set whose most-similar
      // pair is 0.823, which is exactly the distance between Grey Stone and
      // Slate -- the two distinct forms the game already shipped. No pair in the
      // set is closer than a pair the game already had.
      //
      // THEIR `bands` ARE KEPT AND ARE NOT DEAD: _itemPlate falls back to
      // _propPlate whenever an item's art has not decoded yet, so the recolour
      // is now the LOADING FALLBACK. A keep whose sprite is still in flight
      // renders as the right colour rather than as the wrong castle.
      //
      // Why the first three generation runs failed, and why it matters: THE MODEL BAKES A LIT
      // GROUND DISC under a keep even though the style header forbids it, and
      // the negative strong enough to remove it ("no ground, no floor, no pool
      // of light") pushes the model off the white background entirely -- both
      // came back on a full opaque painted BACKDROP, which the matte keeps as a
      // 99%-opaque rectangle. Two failures in opposite directions, $1.25. Slate
      // landed clean on the same prompt, so this is a coin-flip, not a recipe.
      keep_slate:   'art/keep_slate.png',
      keep_sand:    'art/keep_sand.png',
      keep_basalt:  'art/keep_basalt.png',
      // THE ROADS. road_flag was already on disk in the art pipeline's _out/
      // from the ORIGINAL road job and had never been installed -- a free skin
      // that only needed wiring. bone + ash bought 2026-08-22 ($0.33).
      // TILES ARE NOT SPRITES: no bbox crop, no defringe, no hole punch. The
      // whole frame is the art, and cropping a tile to its content is exactly
      // what breaks a seam.
      road_flag:    'art/road_flag.png',
      road_bone:    'art/road_bone.png',
      road_ash:     'art/road_ash.png',
      hoard_silver: 'art/hoard_silver.png',
      hoard_gem:    'art/hoard_gem.png',
      hoard_copper: 'art/hoard_copper.png',
      hoard_plate:  'art/hoard_plate.png',
      coin_gate:    'art/coin_gate.png',
      coin_keep:    'art/coin_keep.png',
      coin_citadel: 'art/coin_citadel.png',
      coin_bastion: 'art/coin_bastion.png',
      coin_spire:   'art/coin_spire.png',
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
      // DOM controls own their gesture; never also move Wick or place a machine.
      if (e.target && e.target.closest && e.target.closest('[data-game-ui]')) return;
      if (convert) taps.push(convert(e.clientX, e.clientY));
    });
    return {
      setConverter: function (fn) { convert = fn; },
      inject: function (wx, wy, vx, vy) { taps.push({ x: wx, y: wy, vx: vx, vy: vy }); },
      intent: function (name, x, y) { taps.push({ intent: name, x: x, y: y }); },
      drain: function () { var t = taps; taps = []; return t; },
    };
  })();

  // ===== R3D — the low-poly 3D renderer (?r3d=1) ==========================
  // The sim never knew it was 2D: update() emits state, a renderer draws it.
  // This module is a SECOND renderer — three.js, low-poly primitives in the
  // style VANUS chose — under the existing 2D canvas, which goes
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
    this.shopPick = -1;                     // absolute index into _shelf(), else -1
    this.shopPage = 0;                      // presentation only; never part of combat saves
    this.shopOpen = false;                  // catalog visibility is presentation only
    this.placeHint = null;                  // {x,y,ok,why} — the last previewed spot
    this.stolenLost = 0;
    // The rival's side of the duel. rivalHoard steps ONCE PER WAVE off the
    // baked curve — it is display + scoring state only and is never read by
    // anything that can change the player's sim, so a duel is bit-identical to
    // the same seed played solo.
    this.rivalHoard = CFG.startHoard;
    // ONE CAVERN, TWO SIDES. The duel used to build a SECOND Game and show it
    // in an inset. VANUS described something else --
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
    this._introQueue = [];
    this.speed = 1;                         // every run starts at 1x
    this.result = null;
  };

  Game.prototype.campaignCheckpoint = function () { return CampaignCheckpoint.summary(); };
  Game.prototype.resumeCampaignCheckpoint = function () { return CampaignCheckpoint.restore(this); };

  Game.prototype.setPaused = function (v) {
    if (this.state === 'playing' && v) this.state = 'paused';
    else if (this.state === 'paused' && !v) this.state = 'playing';
    else return;
    // A resume begins from the next real frame, with no accumulated time or
    // queued battle tap carried across a background/foreground transition.
    this._acc = 0;
    this._last = 0;
    Input.drain();
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
    // WKWebView may expose zero CSS env() values even when UIKit knows the
    // display cutout. Native layout/finish callbacks publish measured points
    // and resize again; browser env() remains the baseline on every platform.
    var nativeArea=window.__hoardlingSafeArea;
    function nativeInset(value,limit){return typeof value==='number'&&isFinite(value)&&value>=0&&value<=limit?value:0;}
    if(nativeArea){st=Math.max(st,nativeInset(nativeArea.top,ch*.4));sb=Math.max(sb,nativeInset(nativeArea.bottom,ch*.4));}
    document.documentElement.style.setProperty('--hoardling-safe-top',st+'px');
    document.documentElement.style.setProperty('--hoardling-safe-bottom',sb+'px');
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

  // The ordinary campaign opens with a planning phase. Shared-score modes
  // and challenge trials retain their authored opening countdowns.
  Game.prototype._waitingForCampaignStart = function () {
    return !this.isRival && this.mode === 'campaign' && !this.trial && this.wave === 0 && !this.waveActive;
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
    // Persist the wave opening after its one-time early-call bonus. Restoring
    // this state bypasses startWave, so reopening cannot mint that bonus again.
    CampaignCheckpoint.capture(this);
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

  // New raiders wait their turn while another panel owns the screen. A type
  // counts as taught only after its full readable interval or an explicit tap.
  Game.prototype._enemyIntroVisible = function () {
    return !!this.infoCard && this.state === 'playing' && !this.isRival &&
      !this.menu && this.shopPick < 0 && !this.shopOpen && !PlayerGuide.isOpen();
  };
  Game.prototype._queueEnemyIntro = function (type) {
    if (this.isRival || Save.data.seen[type] || !ENEMY_CARDS[type]) return;
    if (this.infoCard && this.infoCard.type === type || this._introQueue.indexOf(type) >= 0) return;
    if (!this.infoCard) this.infoCard = { type: type, t: 6 };
    else this._introQueue.push(type);
  };
  Game.prototype._finishEnemyIntro = function () {
    if (this.infoCard && !Save.data.seen[this.infoCard.type]) {
      Save.data.seen[this.infoCard.type] = 1; Save.write();
    }
    this.infoCard = this._introQueue.length ? { type: this._introQueue.shift(), t: 6 } : null;
  };

  Game.prototype.update = function (STEP) {
    if (this.resultLockT > 0) this.resultLockT -= STEP;
    if (this._lbAskT > 0) this._lbAskT -= STEP;   // UI only: the ask's double-tap guard
    // THE RIVAL NEVER DRAINS THE PLAYER'S TAPS. Input is a module-level queue,
    // so an unguarded rival step swallows every tap before the player's own
    // sim sees it -- the game would simply stop responding during a duel.
    var taps = this.isRival ? EMPTY_TAPS : Input.drain();
    for (var ti = 0; ti < taps.length; ti++) {
      var preState = this.state;
      this._handleTap(taps[ti]);
      if (this.state !== preState) break;   // no same-frame chaining through screens
    }
    if (this.state !== 'playing') {
      // The title uses this clock for its idle illustration. A paused battle
      // must keep it still: Tar Boiler patches expire against worldT, so ten
      // seconds in the pause screen used to erase them on the very next tick.
      if (this.state !== 'paused') this.worldT += STEP;
      return;
    }

    // Menu, placement and pause time never spend a hidden introduction. The
    // interval remains six reading seconds when the player chooses 2x combat.
    if (this._enemyIntroVisible() && (this.infoCard.t -= STEP / this.speed) <= 0) this._finishEnemyIntro();

    // hit-stop: an event-driven, DETERMINISTIC beat of frozen sim (same for
    // every replay of the same run -- it lives in the sim, not the renderer)
    if (this.hitstopT > 0) { this.hitstopT -= STEP; return; }
    this.worldT += STEP;

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
      if (!this._waitingForCampaignStart()) {
        this.countdown -= STEP;
        if (this.countdown <= 0) this.startWave();
      }
    }

    // -- spawner --
    if (this.waveActive) {
      this.waveT += STEP;
      while (this.spawnQueue.length && this.spawnQueue[0].t <= this.waveT) {
        var sp = this.spawnQueue.shift();
        var base = ENEMY_TYPES[sp.type];
        this._queueEnemyIntro(sp.type);
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
        if (aimT) { tw._aimX = aimT.px; tw._aimY = aimT.py; this._rememberAim(tw,aimT); }
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
        var rHitAny = 0, rContacts = [];
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
          rContacts.push(this._enemyImpactPoint(re2));
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
          var rSource = this._machineAttackSource(tw);
          this.fxQueue.push({ k: 'pulse', x: pad.x, y: pad.y, r: rR, n: rHitAny, c: '#e8eef5',
            attack: 'blade', sx: rSource.x, sy: rSource.y, contacts: rContacts, scale: 1 + tw.level * .12 });
          Sfx.play('whirl', tw.tid, { gain: Math.min(1, 0.55 + rHitAny * 0.12), pri: 1 });
        }
        tw.cd = rHitAny ? 1 / (lv.rate || 1) : 0.1;
        continue;
      }
      if (tw.type === 'crystal') {
        var hitAny = 0, chillContacts = [];
        for (var c = this.enemies.length - 1; c >= 0; c--) {
          var ce = this.enemies[c];
          if (ce.hp <= 0) continue;
          if (!this._sameSide(ce.ln, tw.own)) continue;   // radial: no target to scope it
          var cR = lv.range * (this.mods.rangeMul || 1);
          var cdx = ce.px - pad.x, cdy = ce.py - pad.y;
          if (cdx * cdx + cdy * cdy <= cR * cR) {
            chillContacts.push(this._enemyImpactPoint(ce));
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
          var chillSource = this._machineAttackSource(tw);
          this.fxQueue.push({ k: 'pulse', x: pad.x, y: pad.y, r: lv.range, n: hitAny,
            attack: 'chill', sx: chillSource.x, sy: chillSource.y, contacts: chillContacts, scale: 1 + tw.level * .12 });
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
      tw._aimX = target.px; tw._aimY = target.py; this._rememberAim(tw,target);
      tw.cd = 1 / lv.rate;
      var tp = { x: target.px, y: target.py };
      var mz0 = this._muzzleOf(tw, tp.x, tp.y);
      if (tw.type === 'mimic') {                            // instant bite
        tw.shotT = 0;
        var bitePoint = this._enemyImpactPoint(target), biteSource = this._machineAttackSource(tw, tp.x);
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
        this.fxQueue.push({ k: 'bite', x: tp.x, y: tp.y, attack: 'bite',
          sx: biteSource.x, sy: biteSource.y, contacts: [bitePoint], scale: 1 + tw.level * .12 });
        // Gearjaw grinds; Magnet Jaws snaps. Both forks used to make the one
        // sound, so the choice you commit a machine to for the rest of the run
        // was inaudible. The fx is queued here and SPENT in _cosmetic() -- a
        // particle spawned beside this line would be a cosmetic draw on the
        // fixed-step path.
        if (lv.special === 'rend') {
          this.fxQueue.push({ k: 'grind', x: tp.x, y: tp.y, bodyX: bitePoint.x, bodyY: bitePoint.y });
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
        var firedBolt = {
          kind: 'bolt', x: mz0.x, y: mz0.y, target: target.id, spd: 340,
          dmg: dmg, crit: crit, hops: lv.pierce || 0,
          shieldbreak: lv.special === 'shieldbreak',
          net: lv.special === 'downdraft' ? lv.groundDur : 0, tower: t,
        };
        this.projectiles.push(firedBolt);
        var shotMouth = this._registerShotVisual(firedBolt,tw,target,mz0);
        // the STRING SNAP: a real crossbow releases, it doesn't just emit
        // AT THE MUZZLE. This fired at (pad.x, pad.y-26) — the machine's middle —
        // so after shots moved to the bow the release flashed ~25px away from
        // where the bolt actually left. My own residue, caught by the audit.
        this.fxQueue.push({ k: 'snap', x: shotMouth.x, y: shotMouth.y, tx: this._enemyImpactPoint(target).x, ty: this._enemyImpactPoint(target).y, stone:tw.type==='perch' });
        Sfx.play(tw.type === 'perch' ? 'stone' : 'bow', tw.tid);
      }
    }

    // -- projectiles --
    for (var p = this.projectiles.length - 1; p >= 0; p--) {
      var pr = this.projectiles[p];
      var visualFlight=SHOT_VISUALS.get(pr);
      if(visualFlight){var fvx=pr.x-visualFlight.lastX,fvy=pr.y-visualFlight.lastY;visualFlight.travel+=Math.sqrt(fvx*fvx+fvy*fvy);visualFlight.lastX=pr.x;visualFlight.lastY=pr.y;}
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
          // is the splash machine, the one that teaches the lesson the
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
          var fireBody=this._enemyImpactPoint(ft);
          this._damage(ft, pr.dmg, { kind: 'hero' });
          this.fxQueue.push({ k: 'fireburst', x: fireBody.x, y: fireBody.y });
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
          var impactBody=this._enemyImpactPoint(tgt);
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
          this.fxQueue.push({ k: 'hit', x: impactBody.x, y: impactBody.y, c: pr.crit ? '#ff9a3c' : '#ffd75e',
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
            if (nxt) { pr.target = nxt.id; pr.hops--; pr.dmg = Math.round(pr.dmg * 0.6) || 1;
              var hopVisual=SHOT_VISUALS.get(pr);if(hopVisual){hopVisual.source=impactBody;hopVisual.travel=0;hopVisual.lastX=pr.x;hopVisual.lastY=pr.y;}
              continue; }
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
        this.fxQueue.push({ k: 'float', x: mp2.x, y: mp2.y - 54, txt: 'Wick on duty', c: '#ffcf6a' });
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
      h.castBreath = false; // a rejected command cannot fire after recovery
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
        h.castBreath = false; // contact can down Wick on the queued cast's step
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
      var fireShot={kind:'fire',x:fmz.x,y:fmz.y,target:pick.id,spd:300,dmg:h.dmg,hero:true};
      this.projectiles.push(fireShot);
      SHOT_VISUALS.set(fireShot,{type:'fire',source:fmz,travel:0,lastX:fmz.x,lastY:fmz.y});
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
    if (this.mode === 'campaign') CampaignCheckpoint.clear();
    this.state = won ? 'won' : 'lost';
    this._bossWave = false;
    // Victory: the bed ducks and comes back — the cave is still his.
    // Defeat: the bed STOPS. They carried it out, and the room has nothing to
    // say about it. The asymmetry is the point.
    this._mCue = won ? { name: 'win' } : { name: 'lose', stop: true };
    this.menu = null; this.infoCard = null; this._introQueue = []; // panels must not outlive the run
    // AND THE FLOATS. reset() clears them on the way IN, nothing cleared them on
    // the way OUT, and the result scrim is only rgba(12,7,5,0.75) -- so the last
    // wave's "-1 treasure!" printed through the story, and the build-hint variant
    // printed "TAP THE KEEP!" over a run that had already ended: a live
    // affordance on a dead screen. MEASURED at 10 of 10 natural losses.
    this.floats.length = 0;
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
    // ---- HOARD MARKS ------------------------------------------------------
    // Every award below is PAID ON IMPROVEMENT ONLY, and each one is keyed on
    // the same save flag the line under it is about to set. Replaying a level
    // you have already 3-starred pays nothing, so there is no farm: the sinks
    // are finite and so is the faucet. Bookkeeping only — no draws, no rng,
    // nothing the sim can see.
    var marksEarned = 0;
    if (this.mode === 'duel' && won && this.rival) {
      var prevD = Save.data.duels[this.rival.id];
      var mgn = Math.max(0, this.hoard - this.rivalHoard);
      if (!prevD || !prevD.w) marksEarned += MARK_AWARDS.rivalFirst;
      // record OBJECT, never a bare number — a duel won on the tiebreak has a
      // margin of 0, and a falsy record would erase the badge that earned it
      if (!prevD || !prevD.w || mgn > (prevD.m | 0)) Save.data.duels[this.rival.id] = { w: 1, m: mgn };
    }
    if (this.mode === 'campaign' && won && stars > Save.data.stars[this.levelIdx]) {
      // per NEW star, so a 1-star scrape later upgraded to 3 pays the other two
      marksEarned += MARK_AWARDS.starFirst * (stars - (Save.data.stars[this.levelIdx] | 0));
      Save.data.stars[this.levelIdx] = stars;
    }
    if (this.mode === 'campaign' && won && this.trial) {           // trial badge
      if (!Save.data.trials[this.levelIdx]) Save.data.trials[this.levelIdx] = {};
      if (!Save.data.trials[this.levelIdx][this.trial]) marksEarned += MARK_AWARDS.trialBadge;
      Save.data.trials[this.levelIdx][this.trial] = 1;
    }
    if (this.mode === 'daily') {
      var today2 = dayNumber();
      if (Save.data.daily.day !== today2) Save.data.daily = { day: today2, best: 0 };

      // PAID PER WAVE GAINED, NOT PER IMPROVEMENT. A flat fee per improvement
      // is a farm, and an easy one: die on purpose at wave 1, then wave 2, then
      // wave 3, and every one of those runs is an "improvement" that pays full
      // price. Fifteen deliberate near-misses paid fifteen times for a wave-15
      // day. Per wave gained, the payouts TELESCOPE -- any sequence from 0 to N
      // sums to rate x N however it was reached.
      //
      // KEYED ON THE RUN'S OWN SEED, NOT ON THE DAY, and that is the whole
      // point. The first version reset `best` to 0 whenever `daily.day` changed,
      // and `dayNumber()` is the DEVICE CLOCK -- so a run STARTED before
      // midnight and FINISHED after it was paid in full a second time for the
      // same seed, and the pause button is enough to force it. Rolling the clock
      // back and forth farmed the same way, indefinitely.
      //
      // The ledger is per-seed and MONOTONIC: a given daily can never pay for a
      // wave it has already paid for, whatever the clock says. `daily.best`
      // survives only as the "today's best" the title screen prints.
      var sKey = String(this.seed >>> 0);
      var paidTo = Save.dailyPaidFor(sKey);
      if (this.wave > paidTo) {
        marksEarned += MARK_AWARDS.dailyWave * (this.wave - paidTo);
        Save.setDailyPaid(sKey, this.wave);
      }
      // A siege can finish after midnight. Its marks belong to its own seed;
      // its score must not become the new day's "today's best" on the title.
      if (this.seed === dailySeed() && this.wave > Save.data.daily.best) Save.data.daily.best = this.wave;
      if (this.wave > Save.data.dailyBestWave) Save.data.dailyBestWave = this.wave;
    }
    if (marksEarned > 0) Save.addMarks(marksEarned);
    this.result.marks = marksEarned;
    Save.write();
    // daily board: submit this run, then pull today's top — UI-only state
    this._lbJoined = false; this._lbAsk = null;
    if (this.mode === 'daily' && Lb.on()) {
      var self = this;
      this.lbRows = 'loading';
      this.lbQueued = Lb.finishRun(this.wave, this.kills, this.seed, function () {
        Lb.top(10, function (rows) { self.lbRows = rows || 'error'; });
      });
    } else { this.lbRows = null; this.lbQueued = false; }
    Sfx.play(won ? 'win' : 'lose');
  };

  // Read-only ability status: the same live, same-side radius test as casting.
  // Countdown strings change by seconds, not by animation frames.
  Game.prototype._breathStatus = function () {
    var h=this.hero, n=0, seconds=0, kind, line;
    if(h.downT>0){kind='recovering';seconds=Math.ceil(h.downT);line='Recovering '+seconds+'s';}
    else if(h.breathCd>0){kind='cooling';seconds=Math.ceil(h.breathCd);line='Ready in '+seconds+'s';}
    else{
      for(var i=0;i<this.enemies.length;i++){var e=this.enemies[i],dx=e.px-h.x,dy=e.py-h.y;
        if(e.hp>0&&this._sameSide(e.ln,0)&&dx*dx+dy*dy<=h.range*h.range)n++;}
      kind=n?'ready':'empty';line=n?n+' in reach':'Move closer';
    }
    var ready=kind==='ready'||kind==='empty';
    return {kind:kind,line:line,count:n,seconds:seconds,ready:ready,canCast:kind==='ready',
      fraction:ready?1:kind==='recovering'?clamp(1-h.downT/CFG.heroDownTime,0,1):clamp(1-h.breathCd/(this.mods.breathCd||14),0,1),
      label:'Use Wick’s breath. '+(kind==='ready'?'Ready. '+n+' nearby '+(n===1?'enemy.':'enemies.'):kind==='empty'?'Ready, but no enemies nearby. Move Wick closer.':kind==='recovering'?'Wick recovers in '+seconds+' seconds.':'Ready in '+seconds+' seconds.')+' Burns nearby enemies through armor.'};
  };
  Game.prototype._requestBreath = function () {
    if (this.mods.breathOff) return;
    var h = this.hero;
    if (h.downT > 0 || h.breathCd > 0) {
      h.castBreath = false;
      this.fxQueue.push({k:'float',x:h.x,y:h.y-40,
        txt:h.downT > 0 ? 'Wick recovers in '+Math.ceil(h.downT)+'s' : Math.ceil(h.breathCd)+'s until the flame',
        c:'#e7c7a8'});
    } else h.castBreath = true;
  };

  Game.prototype._selectMachine = function (index) {
    if(index<0||index>=this._shelf().length)return;
    this.shopPick=this.shopPick===index?-1:index;
    var Gd=this._hudGeom();for(var di=0;di<Gd.dock.length;di++)if(Gd.dock[di].index===index){this.shopPage=Math.floor(di/Gd.shopPerPage);break;}
    this.shopOpen=false;this.placeHint=null;
    Sfx.play('place');
  };

  // ---- tap handling (runs inside update — deterministic order) ----------
  // Priority: letterbox reject -> screens -> OPEN MENU -> hero -> towers/pads
  // -> HUD buttons -> start-wave. Interactive elements always beat big rects.
  Game.prototype._handleTap = function (tap) {
    if (!this.isRival && PlayerGuide.isOpen()) return;
    // Keyboard/assistive activation names its visible control. Physical
    // pointers keep their coordinates and use the same tray/world boundaries.
    if(tap.intent){
      if(this.state==='playing'&&!this.menu){
        if(tap.intent==='build')this._selectMachine(tap.x|0);
        else if(tap.intent==='shop'){var Gs=this._hudGeom();this.shopPage=(Gs.shopPage+1)%Gs.shopPages;}
        else if(this.shopPick<0){
          if(tap.intent==='wave')this.startWave();
          else if(tap.intent==='breath')this._requestBreath();
          else if(tap.intent==='move')this._moveWickTo(tap);
        }
      }
      return;
    }
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

    // The entire management panel is modal, including letterbox bands. Its
    // linear overlay coordinates must win before HUD and 3D ground picking.
    if (this.state === 'playing' && this.menu) {
      this._handleMachineMenuTap(wl); return;
    }
    // an open enemy card swallows its tap (dismiss) — x-bounded to the panel,
    // so a world tap beside the card still reaches pads under the band
    if (this._enemyIntroVisible()) {
      var Gc = this._hudGeom();
      var cw2 = Math.min(this.view.w - 24, 372);
      if (vy > Gc.infoY && vy < Gc.infoY + 58 &&
          vx > this.view.w / 2 - cw2 / 2 && vx < this.view.w / 2 + cw2 / 2) { this._finishEnemyIntro(); return; }
    }
    // SCREEN-ANCHORED HUD first — it lives in the bands on tall phones
    if (this.state === 'playing') {
      var G = this._hudGeom();
      if (vy >= G.btnY && vy <= G.btnY + G.buttonH) {
        if (vx >= G.spd && vx <= G.spd + G.buttonW) { this.speed = this.speed === 1 ? 2 : 1; return; }
        if (vx >= G.pause && vx <= G.pause + G.buttonW) { this.setPaused(true); return; }
        if (G.mute!==null && vx >= G.mute && vx <= G.mute + G.buttonW) { Sfx.toggle(); return; }
      }
      function inside(r){return r&&vx>=r.x&&vx<=r.x+r.w&&vy>=r.y&&vy<=r.y+r.h;}
      // The opaque tray owns its actual screen area. A machine's invisible
      // base-disc/slop cannot steal a button; painted bodies above it remain
      // normal world targets. While building the tray is absent altogether.
      // Corner actions step aside while a machine is in hand, so the pads under
      // them stay buildable; the machine bar itself is always live.
      // A MACHINE UNDER A CARD IS STILL YOURS. On 320-375 px phones the corner
      // cards sit over 75-95% of a machine built on the lowest pads (measured);
      // a tap on its painted body selects it, and the card fades while it is
      // there so the machine can be seen.
      var underCard=this.shopPick<0?this._towerHitAt(wl):-1;
      if(underCard<0&&this.shopPick<0&&!this.mods.breathOff&&inside(G.breathRect)){this._requestBreath();return;}
      if(underCard<0&&this.shopPick<0&&inside(G.startRect)){if(!this.waveActive&&this.wave<this.totalWaves())this.startWave();return;}
      if(inside(G.commandRow)){
        if(inside(G.pager)){this.shopPage=(G.shopPage+1)%G.shopPages;Sfx.play('place');return;}
        for(var sc=0;sc<G.chips.length;sc++){var chipHit=G.chips[sc];if(!inside(chipHit))continue;
          if(chipHit.locked){this.fxQueue.push({k:'float',x:chipHit.x+chipHit.w/2-v.ox,y:chipHit.y-10/v.scale-v.oy,txt:'Earn '+chipHit.stars+'\u2605 to unlock '+TOWER_TYPES[chipHit.id].short,c:'#e7c7a8'});Sfx.play('sell');}
          else this._selectMachine(chipHit.index);
          return;}
        return;
      }
      if(this.shopPick>=0&&inside(G.buildCancel)){this.shopPick=-1;this.shopOpen=false;this.placeHint=null;return;}
      if(this.shopPick>=0&&inside(G.buildInfo))return;
      // Scout information is an intentional catalog overlay, not a hidden
      // floor target. Close Machines to see and command this ground again.
      if(this.shopOpen&&vx>=G.barX&&vx<=G.barX+G.barW&&vy>=G.infoY&&vy<=G.infoY+88)return;
    }

    // THE LEADERBOARD QUESTION IS MODAL (§3g), over the title and over a Daily
    // result alike: nothing under the scrim may take a tap while it is open. A
    // button answers; the card's own body is inert, so a thumb resting on the
    // copy answers nothing; anywhere else backs out WITHOUT an answer, because
    // a dismissal is not a no.
    if (this._lbAsk && (this.state === 'menu' || this.state === 'won' || this.state === 'lost')) {
      if (this._lbAskT > 0) return;          // the tap that opened it cannot also answer it
      var AK = lbAskGeom(this.view, this._lbAsk);
      var askYes = hit(w, AK.yes), askNo = hit(w, AK.no);
      if (askYes || askNo) {
        var askFrom = this._lbAsk;
        this._lbAsk = null;
        Lb.setConsent(askYes);
        Sfx.play('upg');
        if (askFrom === 'daily') { this.reset(dailySeed(), 'daily'); this.state = 'playing'; return; }
        // From a result screen: this run had no token and cannot be posted, so
        // a yes shows the ladder and says the NEXT Daily is the first to post.
        if (askYes) {
          var sj = this;
          this._lbJoined = true; this.lbQueued = false; this.lbRows = 'loading';
          Lb.top(10, function (rows) { sj.lbRows = rows || 'error'; });
        }
        return;
      }
      var cd = AK.card;
      if (w.x >= cd.x && w.x <= cd.x + cd.w && w.y >= cd.y && w.y <= cd.y + cd.h) return;
      this._lbAsk = null;
      return;
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
          var checkpoint = this.campaignCheckpoint();
          if (checkpoint) { PlayerGuide.open('checkpoint', lv); return; }
          PlayerGuide.startCampaign(lv);
          return;
        }
      }
      if (hit(w, TG.daily)) {
        // ASK BEFORE THE FIRST DAILY, NOT AFTER IT (§3g). The question comes
        // before reset(), so the seeded run does not exist yet while it is open.
        if (Lb.configured() && !Lb.consent()) { this._lbAsk = 'daily'; this._lbAskT = 0.35; return; }
        this.reset(dailySeed(), 'daily'); this.state = 'playing'; return;
      }
      if (hit(w, TG.duel)) { this.state = 'duel'; return; }
      if (hit(w, TG.pills[0])) { this.state = 'forge'; return; }
      if (hit(w, TG.pills[1])) { if (Save.starsTotal() > 0) this.state = 'trials'; return; }
      if (hit(w, TG.pills[2])) { this.state = 'cavern'; return; }
      if (hit(w, TG.pills[3])) { Sfx.toggle(); return; }
      for (var lgt = 0; lgt < TG.legal.length; lgt++) {
        if (hit(w, TG.legal[lgt])) { openLegal(TG.legal[lgt].key); return; }
      }
      return;
    }
    if (this.state === 'duel') {
      var DGt = duelGeom(this.view);
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
      if (hit(w, DGt.back)) { this.state = 'menu'; return; }
      return;
    }
    if (this.state === 'trials') {
      var TGt = trialGeom(this.view);
      for (var tr = 0; tr < TRIAL_ORDER.length; tr++) {
        var try2 = TGt.top + tr * TGt.pitch;
        if (w.y > try2 && w.y < try2 + TGt.h) {
          for (var tlv = 0; tlv < CAMPAIGN_MAPS; tlv++) {
            // the chip's OWN inflated rect, offset onto this row
            var cq = TGt.chips[tlv];
            if (w.x >= cq.hx && w.x <= cq.hx + cq.hw &&
                w.y >= try2 + cq.hy && w.y <= try2 + cq.hy + cq.hh) {
              if (!(Save.data.stars[tlv] > 0)) return;       // trial needs the level won first
              this.reset(1, 'campaign', tlv, TRIAL_ORDER[tr]);
              this.state = 'playing'; return;
            }
          }
        }
      }
      if (hit(w, TGt.back)) {
        this.state = 'menu'; return;
      }
      return;
    }
    if (this.state === 'cavern') {
      var CG = cavernRoomGeom(this.view), ci;
      for (ci = 0; ci < SLOTS.length; ci++) {
        if (hit(w, CG.tabs[ci])) { this.cavSlot = ci; this.cavInspect = null; Sfx.play('place'); return; }
      }
      var cslot = SLOTS[this.cavSlot | 0] || SLOTS[0];
      if (hit(w, CG.action)) {
        var selected = this._cavernSelection(), owned = Save.owns(cslot.id, selected.id);
        if (Save.equipped(cslot.id).id === selected.id) return;
        if (!owned && !Save.buy(cslot.id, selected.id)) return;
        Save.equip(cslot.id, selected.id); Sfx.play(owned ? 'coin' : 'upg');
        if (cslot.id === 'finish') this._warmFinish();
        return;
      }
      for (ci = 0; ci < cslot.items.length && ci < CG.cards.length; ci++) {
        if (!hit(w, CG.cards[ci])) continue;
        this.cavInspect = cslot.items[ci].id; Sfx.play('place'); return;
      }
      if (hit(w, CG.back)) { this.state = 'menu'; return; }
      return;
    }
    if (this.state === 'forge') {
      var FGt = forgeGeom(this.view);
      // BUTTONS BEFORE ROWS. The rows used to be tested first, so a sixth
      // FORGE_NODES entry -- whose band would reach 682 against RESPEC/BACK at
      // 640..680 -- would have eaten the back button with nothing to say so.
      if (hit(w, FGt.respec)) {
        Save.data.forge = {}; Save.write(); Sfx.play('sell'); return;
      }
      if (hit(w, FGt.back)) { this.state = 'menu'; return; }
      for (var fn = 0; fn < FGt.rows.length; fn++) {
        var fb = FGt.rows[fn].band;
        if (w.y > fb.hy && w.y < fb.hy + fb.hh && w.x > fb.hx && w.x < fb.hx + fb.hw) {
          var node = FORGE_NODES[fn];
          var cur = Save.data.forge[node.id] | 0;
          if (cur < node.ranks && Save.starsTotal() - Save.forgeSpent() > 0) {
            Save.data.forge[node.id] = cur + 1; Save.write(); Sfx.play('upg');
          }
          return;
        }
      }
      return;
    }
    if (this.state === 'won' || this.state === 'lost') {
      if (this.resultLockT > 0) return;      // a mid-battle tap can't skip the screen
      // THE OPT-OUT IS TESTED FIRST, because every other pixel on this screen
      // dismisses it. Its rect is written by the drawer, so it exists only on
      // the frames the control is actually on screen.
      var retry = this._lbRetryRect;
      if (retry && w.x >= retry.x && w.x <= retry.x + retry.w && w.y >= retry.y && w.y <= retry.y + retry.h) { this._retryLeaderboard(); return; }
      var lo = this._lbOptRect;
      // STOPPING IS ONE TAP; JOINING IS THE QUESTION. Withdrawing needs no
      // disclosure, but "join" is a yes to an anonymous identity and a public,
      // unretractable row, so it opens the same card the Daily plate does.
      if (lo && w.x > lo.x && w.x < lo.x + lo.w && w.y > lo.y && w.y < lo.y + lo.h) {
        if (Lb.on()) {
          Lb.setConsent(false);
          this.lbRows = null; this._lbJoined = false;
          Sfx.play('upg');
        } else { this._lbAsk = 'result'; this._lbAskT = 0.35; }
        return;
      }
      // Leaving a duel drops OUT of duel mode: a reset that stayed in 'duel'
      // would carry this.rival back to the title, and every later reset would
      // re-derive an arena for a fight nobody asked for.
      this.reset(this.mode === 'daily' ? dailySeed() : 1,
                 this.mode === 'duel' ? 'campaign' : this.mode);
      this.state = 'menu';
      return;
    }
    if (this.state === 'paused') return; // explicit Resume in the DOM pause menu

    // world interactions only within the sim world (bands are HUD territory)
    if (w.x < 0 || w.x > WORLD_W || w.y < 0 || w.y > WORLD_H) return;

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
    var hitTower = this.shopPick < 0 ? this._towerHitAt(wl) : -1;
    if (hitTower >= 0) { this.shopOpen=false; this.menu = { towerIdx: hitTower }; return; }
    // (empty pads are no longer tap-to-build — the shop owns building now, and
    // a pad is simply cheaper ground. That frees the whole floor for walking.)

    // PLACING a machine from the shop: this tap is the placement.
    if (this.shopPick >= 0) {
      var stid = this._shelf()[this.shopPick];
      if (!stid) { this.shopPick = -1; return; }
      var chk = this._placeCheck(w.x, w.y, 0);
      if (!chk.ok) {
        this.placeHint = {x:w.x,y:w.y,ok:false,why:chk.why,at:this.worldT};
        this.fxQueue.push({ k: 'float', x: w.x, y: w.y - 18, txt: chk.why, c: '#ff9a9a' });
        return;                                   // stay armed: let them try again
      }
      if (!this._buyAt(stid, w.x, w.y, chk)) {
        this.placeHint = {x:w.x,y:w.y,ok:false,why:'not enough gold',at:this.worldT};
        this.fxQueue.push({ k: 'float', x: w.x, y: w.y - 18, txt: 'not enough gold', c: '#ff9a9a' });
        return;
      }
      this.shopPick = -1; this.shopOpen=false; this.placeHint = null;
      return;
    }

    this._moveWickTo(w);
  };
  Game.prototype._moveWickTo = function (w) {
    var hh = this.hero;
    if (hh.downT > 0) {
      this.fxQueue.push({k:'float',x:hh.x,y:hh.y-40,txt:'Wick recovers in '+Math.ceil(hh.downT)+'s',c:'#ffc1a4'});
      return;
    }
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
  // Selection follows the painted body as well as its forgiving ground
  // target. These masks depend only on decoded art, never render cadence or
  // cached aim transforms. Transparent corners remain ordinary floor.
  var MACHINE_HIT_MASKS = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  function machineHitMask(img) {
    var mask = MACHINE_HIT_MASKS && MACHINE_HIT_MASKS.get(img);
    if (mask) return mask;
    var c = document.createElement('canvas'); c.width = 96; c.height = Math.max(1, Math.round(96 * img.height / img.width));
    var ctx = c.getContext('2d', {willReadFrequently:true}); ctx.drawImage(img,0,0,c.width,c.height);
    mask = {w:c.width,h:c.height,alpha:ctx.getImageData(0,0,c.width,c.height).data};
    if (MACHINE_HIT_MASKS) MACHINE_HIT_MASKS.set(img,mask);
    return mask;
  }
  Game.prototype._towerHitAt = function (point) {
    var picked = -1, front = -Infinity, pad = 4 / this.view.scale;
    for (var i = 0; i < this.towers.length; i++) {
      var tw = this.towers[i]; if (!this._sameSide(tw.own,0) || tw.y < front) continue;
      var p = this._uiAnchor(tw), dx = point.x-p.x, dy = point.y-p.y;
      var hit = dx*dx+dy*dy < 32*32, img = ART.images['t_'+tw.type];
      var layeredCrossbow=tw.type==='ballista'&&ART.images.t_ballista_turntable_v2;
      var layeredRoost=tw.type==='perch'&&img;
      var layeredBellows=tw.type==='bellows'&&ART.images.t_bellows_base_v2&&ART.images.t_bellows_fan_v2;
      if(!hit&&layeredCrossbow)hit=this._crossbowHit({x:tw.x+dx,y:tw.y+dy},tw,pad);
      if(!hit&&layeredRoost)hit=this._roostHit({x:tw.x+dx,y:tw.y+dy},tw,pad);
      if(!hit&&layeredBellows)hit=this._bellowsHit({x:tw.x+dx,y:tw.y+dy},tw,pad);
      if (!hit && !layeredCrossbow && !layeredRoost && !layeredBellows && img && img.width) {
        var w = 54*(1+tw.level*.12), h = w*img.height/img.width, bodyDy = dy - 8;
        if (Math.abs(dx) <= w/2+pad && bodyDy >= -h-pad && bodyDy <= pad) {
          var mask = machineHitMask(img), sx = (dx/w+.5)*mask.w, sy = (bodyDy/h+1)*mask.h;
          var rx = Math.ceil(pad/w*mask.w), ry = Math.ceil(pad/h*mask.h);
          // A few extra pixels admit a finger beside a wire or narrow column.
          for (var y=Math.max(0,Math.floor(sy)-ry); y<=Math.min(mask.h-1,Math.ceil(sy)+ry)&&!hit; y++)
            for (var x=Math.max(0,Math.floor(sx)-rx); x<=Math.min(mask.w-1,Math.ceil(sx)+rx); x++)
              if (mask.alpha[(y*mask.w+x)*4+3] > 32) {hit=true;break;}
        }
      }
      if (hit) {picked=i;front=tw.y;}
    }
    return picked;
  };
  Game.prototype._towerByTid = function (tid) {
    for (var i = 0; i < this.towers.length; i++) if (this.towers[i].tid === tid) return this.towers[i];
    return null;
  };
  // FREE PLACEMENT (VANUS asked for it): a machine may go
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
  /// THE COLOURWAY KERNEL. This replaced a flat 55%-alpha source-atop wash,
  /// which was cheap and looked it: filling over a painting flattens its
  /// shading toward one colour, so a "rival" read as a coloured silhouette and
  /// the goggles, lenses and belly went with it. This ROTATES HUE and scales
  /// S/V per pixel instead, so every shadow, highlight and edge in the painting
  /// survives -- and the two materials that ARE Wick's identity are protected
  /// by construction rather than by luck. See COAT_SCALE / COAT_WARM for the
  /// measured hue bands and why the belly is creamed and never tinted.
  ///
  /// Cost: one pass over ~571k pixels per plate, done ONCE per (plate, coat)
  /// and cached. The stock coat has hue null and returns the image itself, so
  /// a player who never opens the Cavern pays exactly nothing.
  ///
  /// KEYED ON THE SOURCE TOO. Dimensions do not identify an image -- the three
  /// manning frames are all 951x746 -- so a cache keyed on size alone hands the
  /// flap the body plate for every frame of the cycle.
  function coatBand(h, b, s) {
    var d = Math.abs(((h - b.c + 0.5) % 1 + 1) % 1 - 0.5);
    var w = d <= b.full ? 1 : (d >= b.gone ? 0 : 1 - (d - b.full) / (b.gone - b.full));
    if (w <= 0) return 0;
    var ws = (s - b.s0) / (b.s1 - b.s0);
    return w * (ws < 0 ? 0 : ws > 1 ? 1 : ws);
  }
  Game.prototype._coatPlate = function (img, coat) {
    if (!img || !coat || coat.hue === null || coat.hue === undefined) return img;
    var key = coat.id + '@' + (img.src || '?') + '@' + (img.width | 0) + 'x' + (img.height | 0);
    var cache = this._tintCache || (this._tintCache = {});
    if (cache[key]) return cache[key];
    var cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    var cx2 = cv.getContext('2d');
    cx2.drawImage(img, 0, 0);
    var dat;
    // A cross-origin plate taints the canvas and getImageData throws. Falling
    // back to the UNCOATED image is the right failure: the wrong colour dragon
    // is a cosmetic miss, an exception here kills the frame.
    try { dat = cx2.getImageData(0, 0, cv.width, cv.height); }
    catch (e) { cache[key] = img; return img; }
    var d = dat.data, n = d.length;
    // how far this coat travels from red, 0..1 -- drives the belly's creaming
    var far = Math.abs(((coat.hue - COAT_SCALE.c + 0.5) % 1 + 1) % 1 - 0.5) / 0.30;
    if (far > 1) far = 1;
    for (var i = 0; i < n; i += 4) {
      if (d[i + 3] < 8) continue;
      var r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
      var mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      var mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      var v = mx, c = mx - mn;
      if (c === 0) continue;                      // greys carry no hue to move
      var sa = c / mx, h;
      if (mx === r)      h = ((g - b) / c) % 6;
      else if (mx === g) h = (b - r) / c + 2;
      else               h = (r - g) / c + 4;
      h /= 6; if (h < 0) h += 1;
      var ws = coatBand(h, COAT_SCALE, sa), ww = coatBand(h, COAT_WARM, sa);
      if (ws <= 0 && ww <= 0) continue;
      // scales take the hue in full; belly and brass NEVER take it
      var dh = ((coat.hue - h + 0.5) % 1 + 1) % 1 - 0.5;
      var nh = ((h + dh * ws) % 1 + 1) % 1;
      var ns = sa * (1 + (coat.sat - 1) * ws + (COAT_CREAM - 1) * ww * far);
      var nv = v  * (1 + (coat.val - 1) * ws + 0.10 * ww * far);
      if (ns < 0) ns = 0; else if (ns > 1) ns = 1;
      if (nv < 0) nv = 0; else if (nv > 1) nv = 1;
      var hh = nh * 6, ii = Math.floor(hh), f = hh - ii;
      var pp = nv * (1 - ns), qq = nv * (1 - ns * f), tt = nv * (1 - ns * (1 - f));
      var nr, ng, nb;
      switch (ii % 6) {
        case 0: nr = nv; ng = tt; nb = pp; break;
        case 1: nr = qq; ng = nv; nb = pp; break;
        case 2: nr = pp; ng = nv; nb = tt; break;
        case 3: nr = pp; ng = qq; nb = nv; break;
        case 4: nr = tt; ng = pp; nb = nv; break;
        default: nr = nv; ng = pp; nb = qq;
      }
      d[i] = (nr * 255 + 0.5) | 0; d[i + 1] = (ng * 255 + 0.5) | 0; d[i + 2] = (nb * 255 + 0.5) | 0;
    }
    cx2.putImageData(dat, 0, 0);
    cache[key] = cv;
    return cv;
  };

  /// The PLAYER's coat, applied to any hero plate. One call at each hero draw
  /// site; the stock coat is a pass-through.
  Game.prototype._myPlate = function (img) {
    return this._coatPlate(img, Save.equipped('coat'));
  };

  /// PROP RECOLOUR -- the coin, hoard, keep and road slots, until each of them
  /// has bought art. This is NOT the coat kernel: a prop has no protected
  /// material, so the whole sprite moves.
  ///
  /// It ROTATES the whole image by (target hue - the image's own mean hue)
  /// rather than forcing every pixel onto one hue. Forcing was tried first and
  /// flattens a gold pile into a single cyan blob -- the coins stop reading as
  /// separate objects. Rotating keeps the spread the painting already has, so
  /// a Silver Tithe still has warm lowlights and cool highlights, and the
  /// silhouette survives.
  function hexHue(hex) {
    var v = parseInt(hex.slice(1), 16);
    var r = ((v >> 16) & 255) / 255, g = ((v >> 8) & 255) / 255, b = (v & 255) / 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn;
    if (c === 0) return 0;
    var h = mx === r ? ((g - b) / c) % 6 : mx === g ? (b - r) / c + 2 : (r - g) / c + 4;
    h /= 6; return h < 0 ? h + 1 : h;
  }
  /// MULTI-BAND recolour: move each material on its own. This is what the
  /// single-tint path below cannot do -- rotating a whole castle by one angle
  /// turns cream walls and blue roofs into two tints of one colour, which reads
  /// as a filter rather than as a different building.
  ///
  /// Rotate hue and scale S/V; NEVER fill. A fill flattens the painting's
  /// shading toward one colour, which is exactly what the old 55% source-atop
  /// wash did to the duel rivals and why it was replaced.
  function bandWeight(h, s, v, b) {
    if (v > b.vmax || v < (b.vmin || 0)) return 0;
    var d = Math.abs(((h - b.c + 0.5) % 1 + 1) % 1 - 0.5);
    var w = d <= b.full ? 1 : (d >= b.gone ? 0 : 1 - (d - b.full) / (b.gone - b.full));
    if (w <= 0) return 0;
    var ws = (s - b.s0) / 0.15;
    return w * (ws < 0 ? 0 : ws > 1 ? 1 : ws);
  }
  Game.prototype._bandPlate = function (img, item) {
    // `_srcKey` lets a DERIVED canvas identify itself: a downscaled plate has no
    // .src, and without this every one of them would collide on '?'.
    var key = 'b:' + item.id + '@' + (img._srcKey || img.src || '?') + '@' + (img.width | 0) + 'x' + (img.height | 0);
    var cache = this._tintCache || (this._tintCache = {});
    if (cache[key]) return cache[key];
    var cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    var cx2 = cv.getContext('2d');
    cx2.drawImage(img, 0, 0);
    var dat;
    try { dat = cx2.getImageData(0, 0, cv.width, cv.height); }
    catch (e) { cache[key] = img; return img; }      // tainted canvas: ship it uncoated
    var d = dat.data, n = d.length, bands = item.bands;
    for (var i = 0; i < n; i += 4) {
      if (d[i + 3] < 8) continue;
      var r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
      var mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      var mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      var v = mx, c = mx - mn;
      if (c === 0) continue;                          // greys carry no hue to move
      var sa = c / mx, h;
      if (mx === r)      h = ((g - b) / c) % 6;
      else if (mx === g) h = (b - r) / c + 2;
      else               h = (r - g) / c + 4;
      h /= 6; if (h < 0) h += 1;
      var nh = h, ns = sa, nv = v, moved = 0, remain = 1;
      for (var k = 0; k < bands.length; k++) {
        var bd = bands[k], w = bandWeight(h, sa, v, bd.band) * remain;
        if (w <= 0) continue;
        remain -= w;
        moved = 1;
        if (bd.hue !== null && bd.hue !== undefined) {
          // Shortest way round the hue circle, with a DETERMINISTIC tie-break
          // at the antipode: fold into [0,1) then take the negative side only
          // when clearly past the halfway point. Ties go positive, in both this
          // kernel and tools/keep_bands.py, so a target that lands opposite a
          // material cannot make the two disagree. (Keeping a band away from
          // its own antipode is still the real defence -- see MAT_ROOF.)
          var dh = bd.hue - h; dh -= Math.floor(dh);
          if (dh > 0.5 + 1e-9) dh -= 1;
          nh = ((nh + dh * w) % 1 + 1) % 1;
        }
        ns *= 1 + (bd.sat - 1) * w;
        var nvT = nv * (1 + (bd.val - 1) * w);
        if (bd.lift) {
          // A SHADOW-ONLY BLACK-POINT LIFT. Scaling value alone crushes every
          // shadow toward zero: at val x0.38 the keep's archway fell to L* 11.6,
          // BELOW the cavern floor it stands on (19.6), so the entrance -- the
          // building's one gameplay landmark -- became a void and the darks lost
          // the micro-contrast that separates stonework. Raising the multiplier
          // does not fix it (door only 14.6 while the stone washed from L 49.9
          // to 59.0), because a multiplier moves a dark pixel proportionally,
          // i.e. barely. A FLAT lift traded the defect for a worse one -- door
          // 22.2 but near-black stone fell 37.4% -> 21.5%, so it stopped being
          // basalt to save a door. Rolling the lift off by LIFT_KNEE reaches the
          // crushed darks and leaves the midtones: door 21.6, near-black 32.1%.
          // `kn`, NOT `k`: k is the BAND LOOP COUNTER and `var` is function-
          // scoped, so declaring `var k` here overwrote the index with a
          // fraction and the next iteration read bands[1.4] -> undefined. It
          // only fired on items that actually use `lift`, which is why the
          // sandstone keep worked and the basalt keep threw. No table-drift
          // gate could see this: the two kernels' tables agreed perfectly and
          // only the CODE diverged -- the Python preview names its loop
          // variable `entry`, so the same line is harmless there.
          var kn = (LIFT_KNEE - nvT) / LIFT_KNEE;
          kn = kn < 0 ? 0 : (kn > 1 ? 1 : kn);
          nvT = nvT + bd.lift * w * kn * (1 - nvT);
        }
        nv = nvT;
      }
      if (!moved) continue;
      if (ns < 0) ns = 0; else if (ns > 1) ns = 1;
      if (nv < 0) nv = 0; else if (nv > 1) nv = 1;
      var hh = nh * 6, ii = Math.floor(hh), f = hh - ii;
      var pp = nv * (1 - ns), qq = nv * (1 - ns * f), tt = nv * (1 - ns * (1 - f));
      var nr, ng, nb;
      switch (ii % 6) {
        case 0: nr = nv; ng = tt; nb = pp; break;
        case 1: nr = qq; ng = nv; nb = pp; break;
        case 2: nr = pp; ng = nv; nb = tt; break;
        case 3: nr = pp; ng = qq; nb = nv; break;
        case 4: nr = tt; ng = pp; nb = nv; break;
        default: nr = nv; ng = pp; nb = qq;
      }
      d[i] = (nr * 255 + 0.5) | 0; d[i + 1] = (ng * 255 + 0.5) | 0; d[i + 2] = (nb * 255 + 0.5) | 0;
    }
    cx2.putImageData(dat, 0, 0);
    cache[key] = cv;
    return cv;
  };

  Game.prototype._propPlate = function (img, item) {
    if (!img || !item) return img;
    if (item.bands && item.bands.length) return this._bandPlate(img, item);
    if (!item.tint) return img;
    var key = 'p:' + item.id + '@' + (img.src || '?') + '@' + (img.width | 0) + 'x' + (img.height | 0);
    var cache = this._tintCache || (this._tintCache = {});
    if (cache[key]) return cache[key];
    var cv = document.createElement('canvas');
    cv.width = img.width; cv.height = img.height;
    var cx2 = cv.getContext('2d');
    cx2.drawImage(img, 0, 0);
    var dat;
    try { dat = cx2.getImageData(0, 0, cv.width, cv.height); }
    catch (e) { cache[key] = img; return img; }
    var d = dat.data, n = d.length, i;
    // mean hue as a UNIT VECTOR sum -- hue is circular, so averaging the raw
    // numbers puts the mean of 0.98 and 0.02 at 0.5, i.e. cyan for two reds
    var sx = 0, sy = 0;
    for (i = 0; i < n; i += 4) {
      if (d[i + 3] < 8) continue;
      var r0 = d[i] / 255, g0 = d[i + 1] / 255, b0 = d[i + 2] / 255;
      var m0 = Math.max(r0, g0, b0), n0 = Math.min(r0, g0, b0), c0 = m0 - n0;
      if (c0 === 0) continue;
      var h0 = m0 === r0 ? ((g0 - b0) / c0) % 6 : m0 === g0 ? (b0 - r0) / c0 + 2 : (r0 - g0) / c0 + 4;
      h0 = h0 / 6; if (h0 < 0) h0 += 1;
      var wt = c0 / m0;
      sx += Math.cos(h0 * 6.283185) * wt; sy += Math.sin(h0 * 6.283185) * wt;
    }
    var mean = Math.atan2(sy, sx) / 6.283185; if (mean < 0) mean += 1;
    var rot = hexHue(item.tint) - mean;
    var satM = item.sat === undefined ? 1 : item.sat;
    var valM = item.val === undefined ? 1 : item.val;
    for (i = 0; i < n; i += 4) {
      if (d[i + 3] < 8) continue;
      var r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
      var mx = Math.max(r, g, b), mn = Math.min(r, g, b), c = mx - mn;
      if (c === 0) continue;
      var h = mx === r ? ((g - b) / c) % 6 : mx === g ? (b - r) / c + 2 : (r - g) / c + 4;
      h /= 6; if (h < 0) h += 1;
      var nh = ((h + rot) % 1 + 1) % 1;
      var ns = Math.min(1, (c / mx) * satM), nv = Math.min(1, mx * valM);
      var hh = nh * 6, ii = Math.floor(hh), f = hh - ii;
      var pp = nv * (1 - ns), qq = nv * (1 - ns * f), tt = nv * (1 - ns * (1 - f));
      var nr, ng, nb;
      switch (ii % 6) {
        case 0: nr = nv; ng = tt; nb = pp; break;
        case 1: nr = qq; ng = nv; nb = pp; break;
        case 2: nr = pp; ng = nv; nb = tt; break;
        case 3: nr = pp; ng = qq; nb = nv; break;
        case 4: nr = tt; ng = pp; nb = nv; break;
        default: nr = nv; ng = pp; nb = qq;
      }
      d[i] = (nr * 255 + 0.5) | 0; d[i + 1] = (ng * 255 + 0.5) | 0; d[i + 2] = (nb * 255 + 0.5) | 0;
    }
    cx2.putImageData(dat, 0, 0);
    cache[key] = cv;
    return cv;
  };

  /// THE RIVAL WEARS HER OWN CAVERN. _drawMoundAndKeep and _drawKeep already
  /// take a `side` and use it for geometry and for the warmth halo, but they
  /// pulled the SKIN from Save.equipped -- the player's -- so in a duel the
  /// rival's keep and hoard wore YOUR cosmetics and the two halves of the
  /// cavern were identical but for the dragon. That is the whole premise of
  /// the shop: the duel is the display case, and a display case that shows
  /// your own coat twice is not one.
  ///
  /// Her loadout is also the LADDER MADE VISIBLE. Tallow the apprentice keeps a
  /// copper heap under a plain grey keep; Cinder the drake sits on a gem seam
  /// under black basalt. You can see how far up the ladder you are standing.
  Game.prototype._sideItem = function (side, slot) {
    if (this.rivalSide && (side | 0) === 1 && this.rival && this.rival[slot]) {
      return cosItem(slot, this.rival[slot]);
    }
    return Save.equipped(slot);
  };
  Game.prototype._sidePlate = function (side, slot, artId) {
    return this._itemPlate(this._sideItem(side, slot), artId);
  };

  /// The plate for ONE NAMED ITEM. _slotPlate answers "what is equipped", which
  /// is the wrong question for a preview: the Cavern happens to preview the
  /// equipped item today, so calling _slotPlate there was right by coincidence
  /// and would have silently shown the wrong sprite the moment anything wanted
  /// to preview an item the player does not wear.
  Game.prototype._itemPlate = function (it, artId) {
    if (it && it.art && ART.images[it.art]) return ART.images[it.art];
    return this._propPlate(ART.images[artId], it);
  };

  /// THE MACHINE FINISH, applied to any machine plate. Every machine draw site
  /// must go through this or the board will show two finishes at once -- there
  /// are FOUR plate sources, and they were checked one by one:
  ///   1. `timg`            the plain board plate
  ///   2. `rigB` / `rigW`   the ballista's two-plate aim rig, which reads
  ///                        ART.images[rig.base/weapon] DIRECTLY and never sees
  ///                        spriteId at all
  ///   3. `_turretFor`      the split turret, DERIVED from the plate -- its
  ///                        cache must be keyed on the finish, because it keeps
  ///                        the plate's colour
  ///   4. the shop shelf chip, so what you buy matches what you get
  ///
  /// `_rimFor` is not on that list, and the reason given here used to be the
  /// wrong one. It was called "a machine plate consumer that happens to discard
  /// colour" -- but it has exactly ONE call site, `_drawEnemy` at the separation
  /// rim, with `sid = 'e_' + e.type`. It never touches a machine plate at all.
  /// (It is also alpha-only, which is why keying it would be pointless even if
  /// it did.) An earlier HANDOFF note claimed it needed keying; both that note
  /// and its correction were reasoning about a path machines never take.
  /// `side` is the machine's OWNER. Without it a duel painted the RIVAL's brass
  /// in the player's finish -- the exact bug _sideItem was written to fix for
  /// the keep and the hoard, reintroduced here because a machine plate had
  /// never needed an owner before. `_sideItem` falls back to the player's save
  /// whenever this is not a duel, so every non-duel call is unchanged.
  /// A MACHINE IS NEVER DRAWN LARGE, so it is never recoloured large. MEASURED:
  /// the ten machine plates total 4.04 MEGAPIXELS, and the first frame the shop
  /// shelf paints after a finish change misses the cache on all of them at once
  /// -- a full per-pixel RGB->HSV->RGB round-trip over every one, in one frame,
  /// at the start of every run. It is a visible hitch and a reviewer reproduced
  /// it twice.
  ///
  /// The plates are 418-723px wide and the largest thing ever drawn from one is
  /// ~180 device px (a level-2 machine at 54*(1+2*0.12) world units, on a 375pt
  /// phone at 3x) or the Cavern's 92-unit preview. Capping the long side at 384
  /// leaves better than 2x headroom on every use, cuts the recolour to ~1.2 MP
  /// total, and cuts what _tintCache retains by the same factor -- which is the
  /// other half of the same finding.
  var FINISH_MAX = 384;
  Game.prototype._finishSrc = function (img) {
    var long = Math.max(img.width, img.height);
    if (long <= FINISH_MAX) return img;
    var cache = this._smallCache || (this._smallCache = {});
    var k = (img.src || '?') + '@' + img.width + 'x' + img.height;
    if (cache[k]) return cache[k];
    var sc = FINISH_MAX / long;
    var cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(img.width * sc));
    cv.height = Math.max(1, Math.round(img.height * sc));
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    cv._srcKey = k;                       // it has no .src of its own — see _bandPlate
    cache[k] = cv;
    return cv;
  };
  /// WARM THE FINISH WHERE A BLIP IS FREE. Even capped, recolouring the ten
  /// machine plates costs ~51ms (MEASURED on device; it was 155ms before the
  /// cap). Paid on the first frame of a run that is nine dropped frames as the
  /// shop shelf paints; paid on the frame the player taps a shop card, it lands
  /// in a static menu where nothing is moving and nobody can see it.
  ///
  /// Called from the Cavern's equip, and deliberately NOT from anywhere the sim
  /// can reach -- it is a draw-lane cache fill, and it reads Save.equipped.
  var FINISH_PLATES = ['t_crystal', 't_ballista', 't_mimic', 't_perch', 't_rotor',
                       't_brazier', 't_bellows', 't_press',
                       't_ballista_base', 't_ballista_weapon'];
  Game.prototype._warmFinish = function () {
    for (var i = 0; i < FINISH_PLATES.length; i++) {
      var im = ART.images[FINISH_PLATES[i]];
      if (im) this._finishPlate(im, 0);
    }
  };

  Game.prototype._finishPlate = function (img, side) {
    if (!img) return img;
    var it = this._sideItem(side | 0, 'finish');
    if (!it || !it.bands) return img;
    return this._bandPlate(this._finishSrc(img), it);
  };

  /// The equipped plate for a prop slot. `art` on the item is the seam a bought
  /// sprite drops into: set it and the recolour is bypassed entirely.
  Game.prototype._slotPlate = function (slot, artId) {
    return this._itemPlate(Save.equipped(slot), artId);
  };

  /// A rival's coat. RIVALS[].coat names a COATS entry -- the four rivals used
  /// to carry raw hex `tint` strings for the old wash, and those are now the
  /// same four characters in real colourways.
  Game.prototype._rivalPlate = function (img, coatId) {
    return this._coatPlate(img, cosItem('coat', coatId));
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
    if (a.tw && this._drawCrewWick(ctx, a, 1)) return;
    // COAT, not the old hex `tint`. Her SPRITE is a real colourway now; `tint`
    // is her UI ACCENT -- her name and her difficulty pips on the duel select,
    // and her name on the in-game duel strip. That sentence used to be here
    // claiming the same thing while NOTHING read RIVALS[].tint at all, which is
    // the repo's own definition of a bug: a comment is a claim.
    var plate = this._rivalPlate(img, this.rival.coat || 'amethyst');
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
      if (chk.discount) this.fxQueue.push({ k: 'float', x: bx, y: by - 40, txt: 'Pad discount −20%', c: '#9ef58f' });
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
  // Machine management uses one model for canvas, pointer hit regions, keyboard
  // proxies and the bot. Sizes are CSS pixels so a small phone gets full controls.
  Game.prototype._machineMenuTower = function () {
    var m = this.menu;
    if (!m) return null;
    var tw = this.towers[m.forkFor !== undefined ? m.forkFor : m.towerIdx];
    return tw && this._sameSide(tw.own, 0) ? tw : null;
  };
  Game.prototype._machineMenuSignature = function () {
    var tw = this._machineMenuTower(), m = this.menu || {};
    return [m.towerIdx, m.forkFor, m.forkChoice, !!m.confirmSell, !!m.aimMenu, tw && tw.tid,
      tw && tw.level, tw && tw.fork, tw && tw.targeting, !!(tw && tw.jamT > 0),
      this.gold, this.hero.manTid, this.hero.manned, this.hero.downT > 0].join(':');
  };
  Game.prototype._machineMenuGeom = function (tw) {
    var v = this.view, u = 1 / v.scale, m = this.menu || {}, H = this._hudGeom();
    var aimed = !TOWER_TYPES[tw.type].support && tw.type !== 'crystal' && tw.type !== 'rotor';
    var fork = m.forkFor !== undefined, compact = v.cw <= 340;
    var height = fork ? 234 : m.aimMenu ? 204 : m.confirmSell ? 190 : 250;
    var w = Math.min(v.w - 24 * u, 296 * u), h = height * u, anchor = this._uiAnchor(tw);
    // Keep the actual machine in view. The dock yields its space while these
    // local controls are open; the battle and its top status bar remain visible.
    var img = ART.images['t_' + tw.type], sw = 54 * (1 + tw.level * 0.12);
    var sh = img && img.width ? sw * img.height / img.width : sw * 1.4;
    var bounds = { x: anchor.x - sw * 0.66, y: anchor.y - sh - 6,
      w: sw * 1.32, h: sh + 14 };
    if (this.hero.manned && this.hero.manTid === tw.tid) {
      var crew = this._heroAnchor(), cy = anchor.y + 5 - crew.lift - HERO_H * crew.s;
      var cx = anchor.x + crew.x - tw.x, cw = HERO_H * crew.s * HERO_MAN_ASPECT;
      var right = Math.max(bounds.x + bounds.w, cx + cw / 2);
      bounds.x = Math.min(bounds.x, cx - cw / 2); bounds.w = right - bounds.x;
      var bottom = bounds.y + bounds.h; bounds.y = Math.min(bounds.y, cy); bounds.h = bottom - bounds.y;
    }
    var gap = 10 * u, left = -v.ox + 12 * u, right = -v.ox + v.w - 12 * u - w;
    var top = -v.oy + H.topY + H.barH + 8 * u;
    var bottom = -v.oy + v.h - (v.safeB || 0) - 12 * u - h;
    var candidates = [
      { x: anchor.x - w / 2, y: bounds.y - gap - h, placement: 'above' },
      { x: anchor.x - w / 2, y: bounds.y + bounds.h + gap, placement: 'below' },
      { x: bounds.x - gap - w, y: bounds.y + bounds.h / 2 - h / 2, placement: 'left' },
      { x: bounds.x + bounds.w + gap, y: bounds.y + bounds.h / 2 - h / 2, placement: 'right' }
    ];
    var best, score = Infinity;
    candidates.forEach(function (c, i) {
      var x = clamp(c.x, left, right), y = clamp(c.y, top, Math.max(top, bottom));
      var overlapW = Math.max(0, Math.min(x + w, bounds.x + bounds.w + gap) - Math.max(x, bounds.x - gap));
      var overlapH = Math.max(0, Math.min(y + h, bounds.y + bounds.h + gap) - Math.max(y, bounds.y - gap));
      var value = overlapW * overlapH * 1000 + Math.abs(x - c.x) + Math.abs(y - c.y) * 2 + i * 3 * u;
      if (value < score) { score = value; best = { x: x, y: y, placement: c.placement }; }
    });
    var x = best.x, y = best.y, width = w / u, inner = width - 20;
    var panels = [{ x: x, y: y, w: w, h: h }], split = 0, lowerY = 0;
    // A phone cannot fit a tall, full-width card beside a central machine.
    // Split only BETWEEN complete sections, leaving the machine in the gap.
    // No control shrinks, scrolls away, or becomes detached from its hit area.
    var overlap = Math.max(0, Math.min(x + w, bounds.x + bounds.w) - Math.max(x, bounds.x)) *
      Math.max(0, Math.min(y + h, bounds.y + bounds.h) - Math.max(y, bounds.y));
    if (overlap > 0) {
      var above = bounds.y - gap - top, below = bottom + h - bounds.y - bounds.h - gap;
      var cuts = fork ? [52, 132, 166] : m.aimMenu ? [52, 108] : m.confirmSell ? [52, 120] : [52, 122, 180];
      for (var ci = 0; ci < cuts.length; ci++) {
        var cut = cuts[ci], upperH = cut * u, lowerH = h - upperH;
        if (upperH <= above && lowerH <= below) {
          split = cut; y = bounds.y - gap - upperH; lowerY = bounds.y + bounds.h + gap;
          x = clamp(anchor.x - w / 2, left, right);
          panels = [{ x: x, y: y, w: w, h: upperH }, { x: x, y: lowerY, w: w, h: lowerH }];
          best.placement = 'split'; break;
        }
      }
    }
    function at(py) { return split && py >= split ? lowerY + (py - split) * u : y + py * u; }
    // Tether joins the two closest edges. It remains short when the panel is
    // clamped near a screen edge instead of pretending to be a bottom drawer.
    var tx = clamp(anchor.x, x + 16 * u, x + w - 16 * u);
    var source = { x: anchor.x, y: bounds.y }, target = { x: tx, y: y + h };
    if (best.placement === 'below') { source.y = bounds.y + bounds.h; target.y = y; }
    else if (best.placement === 'left' || best.placement === 'right') {
      var onLeft = best.placement === 'left';
      source = { x: onLeft ? bounds.x : bounds.x + bounds.w, y: bounds.y + bounds.h / 2 };
      target = { x: onLeft ? x + w : x, y: clamp(source.y, y + 16 * u, y + h - 16 * u) };
    }
    if (split) { source = { x: bounds.x, y: bounds.y + bounds.h / 2 }; target = { x: x, y: y + panels[0].h }; }
    function rect(px, py, pw, ph) { return { x: x + px * u, y: at(py), w: pw * u, h: ph * u }; }
    return { x: x, y: y, w: w, h: split ? lowerY + panels[1].h - y : h, u: u, aimed: aimed, fork: fork, compact: compact,
      panels: panels, split: split, at: at, footerY: at(height - 7),
      anchor: { x: anchor.x, y: anchor.y }, machineBounds: bounds, placement: best.placement,
      tether: { source: source, target: target },
      close: rect(width - 54, 6, 44, 44), pause: rect(width - 100, 6, 44, 44),
      stats: rect(10, 46, inner, 16),
      upgrade: rect(10, m.confirmSell ? 56 : 54, inner, m.confirmSell ? 60 : 64),
      crew: rect(10, 128, inner, 48),
      aim: rect(10, 184, inner - 88, 44),
      sell: rect(width - 90, 184, 80, 44),
      keep: rect(10, 122, inner, 44),
      cards: [rect(10, 54, (inner - 6) / 2, 74), rect(13 + inner / 2, 54, (inner - 6) / 2, 74)],
      buy: rect(10, 168, inner, 44),
      aimCards: [0, 1, 2, 3].map(function (i) { return rect(10 + (i % 2) * (inner + 6) / 2, 54 + Math.floor(i / 2) * 56, (inner - 6) / 2, 50); }) };
  };
  // Portraits use the battle renderer with an isolated, still machine. Four
  // tiers share one crop, so their real size and equipment remain comparable.
  // This bounded UI cache never updates a live tower or consumes gameplay RNG.
  Game.prototype._machinePortrait = function (type, level, fork, finish) {
    if (!ART.images['t_' + type]) return null;
    finish = finish || this._sideItem(0, 'finish');
    var key = type + ':' + (finish ? finish.id : 'stock');
    var cache = this._machinePortraits || (this._machinePortraits = new Map());
    var group = cache.get(key);
    if (!group) {
      var scene = Object.create(this), frames = [], x0 = 240, y0 = 352, x1 = 0, y1 = 0;
      scene._previewMachine = true; scene.waveActive = false; scene.worldT = 0;
      scene.menu = null; scene.towers = []; scene.rivalSide = false;
      scene.hero = { manned: false, manTid: -1, downT: 0 };
      var owner = this;
      scene._sideItem = function (side, slot) { return slot === 'finish' ? finish : owner._sideItem(side, slot); };
      [0, 1, 2, 2].forEach(function (rank, index) {
        var c = document.createElement('canvas'); c.width = 240; c.height = 352;
        var cc = c.getContext('2d'); cc.translate(120, 288); cc.scale(2.1, 2.1);
        var tower = { type: type, x: 0, y: 0, tid: -1000, own: 0, level: rank,
          fork: index === 3 ? 1 : 0, targeting: 0, shotT: 9, jamT: 0,
          _aimX: 80, _aimY: 20, _manned: false, _oc: false };
        scene._drawTower(cc, tower);
        var data = cc.getImageData(0, 0, c.width, c.height).data;
        for (var y = 0; y < c.height; y++) for (var x = 0; x < c.width; x++) {
          if (data[(y * c.width + x) * 4 + 3] < 12) continue;
          x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
        }
        frames.push(c);
      });
      group = { frames: frames, x: Math.max(0, x0 - 3), y: Math.max(0, y0 - 3),
        w: Math.min(240, x1 + 4) - Math.max(0, x0 - 3), h: Math.min(352, y1 + 4) - Math.max(0, y0 - 3) };
      if (cache.size >= 8) cache.delete(cache.keys().next().value);
      cache.set(key, group);
    }
    return { image: group.frames[level === 2 ? 2 + (fork === 1 ? 1 : 0) : level | 0],
      x: group.x, y: group.y, w: group.w, h: group.h };
  };
  Game.prototype._drawMachinePortrait = function (ctx, type, level, fork, rect, finish) {
    var p = this._machinePortrait(type, level, fork, finish); if (!p || p.w <= 0 || p.h <= 0) return;
    var scale = Math.min(rect.w / p.w, rect.h / p.h), w = p.w * scale, h = p.h * scale;
    ctx.drawImage(p.image, p.x, p.y, p.w, p.h, rect.x + (rect.w - w) / 2, rect.y + rect.h - h, w, h);
  };
  // Ability emblems describe the upgrade's effect; the adjacent portrait shows
  // its actual in-game chassis. Distinct silhouettes survive small screens.
  function machineAbilityGlyph(ctx, type, fork, x, y, radius) {
    ctx.save(); ctx.translate(x, y); ctx.scale(radius / 12, radius / 12);
    ctx.fillStyle = '#252423'; ctx.strokeStyle = fork ? '#a8d6dd' : '#eac583'; ctx.lineWidth = 1.35;
    ctx.beginPath(); ctx.arc(0, 0, 11.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath();
    if (type === 'mimic' && fork) {
      ctx.moveTo(-5,-5);ctx.lineTo(-5,1);ctx.bezierCurveTo(-5,8,5,8,5,1);ctx.lineTo(5,-5);ctx.moveTo(-7,-2);ctx.lineTo(-3,-2);ctx.moveTo(3,-2);ctx.lineTo(7,-2);
    } else if (type === 'mimic' || type === 'rotor' && fork) {
      for(var i=0;i<16;i++){var a=i*Math.PI/8,r=i%2?4.8:7;ctx.lineTo(Math.cos(a)*r,Math.sin(a)*r);}ctx.closePath();ctx.moveTo(2.5,0);ctx.arc(0,0,2.5,0,6.283);
    } else if (type === 'ballista' && fork) {
      ctx.arc(0,0,5,0,6.283);ctx.moveTo(-8,0);ctx.lineTo(-3,0);ctx.moveTo(3,0);ctx.lineTo(8,0);ctx.moveTo(0,-8);ctx.lineTo(0,-3);ctx.moveTo(0,3);ctx.lineTo(0,8);
    } else if (type === 'ballista') {
      ctx.moveTo(-6,5);ctx.lineTo(6,-5);ctx.lineTo(0,-5);ctx.moveTo(6,-5);ctx.lineTo(6,1);ctx.moveTo(-6,-1);ctx.lineTo(0,-6);ctx.moveTo(0,6);ctx.lineTo(6,1);
    } else if (type === 'brazier' && fork) {
      ctx.moveTo(0,-7);ctx.bezierCurveTo(-2,-2,-6,0,-5,4);ctx.bezierCurveTo(-4,8,5,8,5,3);ctx.bezierCurveTo(5,0,1,-4,0,-7);ctx.closePath();ctx.moveTo(-7,8);ctx.lineTo(7,8);
    } else if (type === 'brazier') {
      [-4,0,4].forEach(function(v){ctx.moveTo(v,5);ctx.bezierCurveTo(v-4,0,v+4,-2,v,-7);});
    } else if (type === 'crystal' && fork) {
      ctx.moveTo(-4,-7);ctx.lineTo(-4,0);ctx.quadraticCurveTo(0,7,4,0);ctx.lineTo(4,-7);ctx.moveTo(0,3);ctx.lineTo(0,8);
    } else if (type === 'crystal') {
      for(var j=0;j<6;j++){var a2=j*Math.PI/3;ctx.moveTo(0,0);ctx.lineTo(Math.cos(a2)*7,Math.sin(a2)*7);ctx.moveTo(Math.cos(a2-.35)*5,Math.sin(a2-.35)*5);ctx.lineTo(Math.cos(a2)*3,Math.sin(a2)*3);ctx.lineTo(Math.cos(a2+.35)*5,Math.sin(a2+.35)*5);}
    } else if (type === 'perch' && fork) {
      ctx.rect(-6,-6,12,12);[-2,2].forEach(function(v){ctx.moveTo(v,-6);ctx.lineTo(v,6);ctx.moveTo(-6,v);ctx.lineTo(6,v);});
    } else if (type === 'perch') {
      ctx.moveTo(-6,-5);ctx.lineTo(6,-5);ctx.lineTo(5,3);ctx.lineTo(0,7);ctx.lineTo(-5,3);ctx.closePath();ctx.moveTo(3,-8);ctx.lineTo(-1,0);ctx.lineTo(2,0);ctx.lineTo(-3,8);
    } else if (type === 'bellows' && fork) {
      ctx.moveTo(-5,6);ctx.lineTo(4,-3);ctx.moveTo(1,-6);ctx.lineTo(7,0);ctx.lineTo(4,3);ctx.lineTo(-2,-3);ctx.closePath();
    } else if (type === 'bellows') {
      [-4,0,4].forEach(function(v){ctx.moveTo(-7,v);ctx.lineTo(3,v);ctx.quadraticCurveTo(8,v,5,v-3);});
    } else if (type === 'rotor') {
      [-4,4].forEach(function(v){ctx.moveTo(v,7);ctx.lineTo(v,-6);ctx.moveTo(v-3,-2);ctx.lineTo(v,-6);ctx.lineTo(v+3,-2);});
    } else if (type === 'press' && fork) {
      ctx.ellipse(-2,3,5,2.5,0,0,6.283);ctx.moveTo(-7,3);ctx.lineTo(-7,6);ctx.quadraticCurveTo(-2,10,3,6);ctx.lineTo(3,3);ctx.moveTo(5,-7);ctx.lineTo(5,-1);ctx.moveTo(2,-4);ctx.lineTo(8,-4);
    } else {
      ctx.moveTo(-7,-4);ctx.lineTo(-5,5);ctx.lineTo(5,5);ctx.lineTo(7,-4);ctx.lineTo(3,-1);ctx.lineTo(0,-7);ctx.lineTo(-3,-1);ctx.closePath();ctx.moveTo(-5,8);ctx.lineTo(5,8);
    }
    ctx.stroke();ctx.restore();
  }
  var MACHINE_PERK_LABELS = {
    mimic: ['Bleeds enemies for 4 damage/sec', 'Recovers up to 2 stolen coins'],
    ballista: ['Every fifth shot deals double damage', 'Damage builds on the same target'],
    brazier: ['Burns enemies and blocks healing', 'Leaves burning tar on the road'],
    crystal: ['Stronger slow; stops drum boosts', 'Enemies take 25% more damage'],
    perch: ['Pierces shields and six enemies', 'Grounds flyers; doubles air damage'],
    bellows: ['Nearby machines fire 32% faster', 'Nearby machines deal 28% more'],
    rotor: ['Deals 75% more damage to flyers', 'Every fourth sweep pushes back'],
    press: ['Earns 78 gold after every wave', '62 gold per wave; 2 per kill']
  };
  function machineNumber(n) { return String(Math.round(n * 100) / 100); }
  function machineStats(tw, row) {
    if (tw.type === 'press') return [
      { label: 'Gold / wave', value: row.waveGold + 'g' },
      { label: 'Gold / kill', value: (row.killGold || 0) + 'g' }];
    if (tw.type === 'bellows') return [
      { label: row.auraDmg ? 'Damage aura' : 'Fire-rate aura', value: '+' + Math.round((row.auraDmg || row.auraRate || 0) * 100) + '%' },
      { label: 'Reach', value: String(row.range) }];
    return [{ label: 'Damage / hit', value: String(row.dmg) },
      { label: 'Attacks / sec', value: machineNumber(row.rate) },
      { label: 'Reach', value: String(row.range) }];
  }
  function machineUpgradeLines(tw) {
    var tt = TOWER_TYPES[tw.type], a = tt.levels[0], b = tt.levels[1];
    if (tw.type === 'press') return [a.waveGold + ' → ' + b.waveGold + ' gold per wave', 'Income arrives when each wave ends'];
    if (tw.type === 'bellows') return ['Fire-rate aura +' + Math.round(a.auraRate * 100) + '% → +' + Math.round(b.auraRate * 100) + '%', 'Reach ' + a.range + ' → ' + b.range + ' · affects nearby machines'];
    var extra = b.slow ? 'Slow ' + Math.round(a.slow * 100) + '% → ' + Math.round(b.slow * 100) + '%'
      : b.pierce ? 'Ground pierce ' + a.pierce + ' → ' + b.pierce
      : b.burn ? 'Adds ' + b.burn + '/sec burn' : 'Reach ' + a.range + ' → ' + b.range;
    return ['Damage ' + a.dmg + ' → ' + b.dmg + ' · ' + machineNumber(a.rate) + ' → ' + machineNumber(b.rate) + ' attacks/sec', extra + (b.slow || b.pierce || b.burn ? ' · reach ' + a.range + ' → ' + b.range : '')];
  }
  function machineForkLines(tw, row) {
    var from = TOWER_TYPES[tw.type].levels[1];
    if (tw.type === 'press') return ['Gold / wave ' + from.waveGold + ' → ' + row.waveGold,
      row.killGold ? 'Also earns ' + row.killGold + ' gold per kill' : 'Income arrives after every wave'];
    if (tw.type === 'bellows') return ['+' + Math.round(from.auraRate * 100) + '% fire rate → +' + Math.round((row.auraDmg || row.auraRate) * 100) + '% ' + (row.auraDmg ? 'damage' : 'fire rate'), 'Reach ' + from.range + ' → ' + row.range];
    return ['Damage ' + from.dmg + ' → ' + row.dmg + ' · ' + machineNumber(from.rate) + ' → ' + machineNumber(row.rate) + ' attacks/sec',
      'Reach ' + from.range + ' → ' + row.range + (row.slow ? ' · slow ' + Math.round(from.slow * 100) + '% → ' + Math.round(row.slow * 100) + '%' : row.pierce ? ' · pierce ' + from.pierce + ' → ' + row.pierce : '')];
  }
  Game.prototype._machineMenuActions = function () {
    var tw = this._machineMenuTower();
    if (!tw) return [];
    var m = this.menu, G = this._machineMenuGeom(tw), tt = TOWER_TYPES[tw.type], row = lvlRow(tw);
    var self = this, actions = [], cost = tw.level < 2 ? row.upgradeCost : 0;
    function add(id, rect, title, detail, price, disabled) {
      actions.push({ id: id, rect: rect, title: title, detail: detail || [], price: price || '',
        label: [title, price].concat(detail || []).filter(Boolean).join('. '), disabled: !!disabled });
    }
    add('close', G.close, G.fork || m.confirmSell || m.aimMenu ? 'Back to machine' : 'Close machine panel');
    if (G.fork) {
      var choice = m.forkChoice === 1 ? 1 : 0, fk = tt.forks[choice];
      tt.forks.forEach(function (option, i) {
        add('preview' + i, G.cards[i], option.name, ['Preview this specialization. ' + option.pitch]);
      });
      add('fork' + choice, G.buy, 'Build ' + fk.name, [fk.pitch].concat(machineForkLines(tw, fk)),
        cost + 'g' + (self.gold < cost ? ' · need ' + (cost - self.gold) + 'g' : ''), self.gold < cost);
      add('pause', G.pause, 'Pause battle');
      return actions;
    }
    if (m.aimMenu) {
      AIM_MODES.forEach(function (name, i) {
        add('aim' + i, G.aimCards[i], name, [['Closest to hoard', 'Most health', 'Newest arrival', 'Healers first'][i] + ' · carriers take priority']);
      });
      add('pause', G.pause, 'Pause battle');
      return actions;
    }
    if (m.confirmSell) {
      var refund = this._sellValue(tw);
      add('confirmSell', G.upgrade, 'Sell this machine', ['You receive ' + refund + ' gold. Its upgrades are lost.', 'Gold ' + this.gold + ' → ' + (this.gold + refund)], '+' + refund + 'g');
      add('keep', G.keep, 'Keep machine', ['Return to its controls']);
    } else {
      if (tw.level < 2) add('upgrade', G.upgrade, tw.level === 0 ? 'Upgrade to Level 2' : 'Upgrade to MAX',
        tw.level === 0 ? machineUpgradeLines(tw) : tw.level === 1 ? ['Compare two permanent paths', this.gold < cost ? 'Need ' + (cost - this.gold) + 'g more to buy one' : 'Choose what this machine does best'] : [row.pitch, 'Fully upgraded · this path is permanent'],
        tw.level < 2 ? cost + 'g' : 'MAX', tw.level === 2 || tw.level === 0 && this.gold < cost);
      if (G.aimed) add('aim', G.aim, 'Aim: ' + AIM_MODES[tw.targeting | 0],
        [['Closest to hoard', 'Most health', 'Newest arrival', 'Healers first'][tw.targeting | 0] + ' · carriers take priority']);
      var assigned = this.hero.manTid === tw.tid;
      add('crew', G.crew, this.hero.downT > 0 ? 'Wick is recovering' : assigned ? this.hero.manned ? 'Release Wick' : 'Cancel crew order' : 'Send Wick here',
        [this.hero.downT > 0 ? 'Crew available when Wick recovers' : assigned ? this.hero.manned ? 'Wick returns to the floor' : 'Bonus starts when Wick arrives'
          : tw.type === 'bellows' ? '+60% aura strength' : tw.type === 'press' ? '+50% gold income' : '+70% fire rate · +30% damage'], '', this.hero.downT > 0);
      add('sell', G.sell, 'Sell…', [this._sellValue(tw) + 'g refund']);
    }
    add('pause', G.pause, 'Pause battle');
    return actions;
  };
  Game.prototype._machineMenuBack = function () {
    if (this.menu && (this.menu.forkFor !== undefined || this.menu.confirmSell || this.menu.aimMenu))
      this.menu = { towerIdx: this.menu.forkFor !== undefined ? this.menu.forkFor : this.menu.towerIdx };
    else this.menu = null;
  };
  Game.prototype._handleMachineMenuTap = function (tap) {
    var tw = this._machineMenuTower();
    if (!tw) { this.menu = null; return; }
    var G = this._machineMenuGeom(tw), actions = this._machineMenuActions(), hit = null;
    for (var i = 0; i < actions.length; i++) {
      var r = actions[i].rect;
      if (tap.x >= r.x && tap.x <= r.x + r.w && tap.y >= r.y && tap.y <= r.y + r.h) { hit = actions[i]; break; }
    }
    if (!hit) {
        if (!G.panels.some(function (r) { return tap.x >= r.x && tap.x <= r.x + r.w && tap.y >= r.y && tap.y <= r.y + r.h; })) {
        // A visible neighbouring machine takes one tap to select. Empty floor
        // only dismisses; this same tap must not also move Wick or place a build.
        this.menu = null;
        var next = this._towerHitAt(tap);
        if (next >= 0) this.menu = { towerIdx: next };
      }
      return;
    }
    if (hit.disabled) return;
    var id = hit.id, index = this.menu.forkFor !== undefined ? this.menu.forkFor : this.menu.towerIdx;
    if (id === 'close' || id === 'back' || id === 'keep') { this._machineMenuBack(); return; }
    if (id === 'pause') { this.setPaused(true); return; }
    if (id === 'sell') { this.menu.confirmSell = true; return; }
    if (id === 'confirmSell') {
      this.gold += this._sellValue(tw); this.towers.splice(index, 1);
      if (this.hero.manTid === tw.tid) {
        this.hero.manTid = -1; this.hero.manned = false;
        this.hero.tx = this.hero.x; this.hero.ty = this.hero.y;
      }
      Sfx.play('sell'); this.menu = null; return;
    }
    if (/^preview[01]$/.test(id)) { this.menu.forkChoice = Number(id.slice(-1)); Sfx.play('place'); return; }
    if (id === 'aim') { this.menu.aimMenu = true; Sfx.play('place'); return; }
    if (/^aim[0-3]$/.test(id)) { tw.targeting = Number(id.slice(-1)); this.menu = { towerIdx: index }; Sfx.play('place'); return; }
    if (id === 'crew') {
      if (this.hero.manTid === tw.tid) {
        this.hero.manTid = -1; this.hero.manned = false;
        this.hero.tx = this.hero.x; this.hero.ty = this.hero.y;
      }
      else { this.hero.manTid = tw.tid; this.hero.manned = false; }
      Sfx.play('place'); this.menu = null; return;
    }
    if (id === 'upgrade' && tw.level === 1) { this.menu = { forkFor: index }; Sfx.play('place'); return; }
    var row = lvlRow(tw);
    if ((id === 'upgrade' && tw.level === 0 || /^fork[01]$/.test(id) && tw.level === 1) && this.gold >= row.upgradeCost) {
      this.gold -= row.upgradeCost; tw.level++;
      if (tw.level === 2) {
        tw.fork = Number(id.slice(-1));
        this.fxQueue.push({ k: 'float', x: tw.x, y: tw.y - 52, txt: lvlRow(tw).name + '!', c: tw.fork ? '#a8e6ff' : '#ffd75e' });
      }
      this.fxQueue.push({ k: 'place', x: tw.x, y: tw.y }); Sfx.play('upg');
      this.menu = { towerIdx: index }; // show the paid result, ready for the next decision
    }
  };
  Game.prototype._forkCards = function (tw) { return this._machineMenuGeom(tw).cards; };
  Game.prototype._menuBtnPos = function (pad, i, n) {
    // Compatibility for deterministic gameplay tools that select a menu action.
    var ids = n === 3 ? ['upgrade', 'crew', 'sell'] : ['upgrade', 'aim', 'crew', 'sell'];
    var id = ids[i];
    if (id === 'sell' && this.menu && this.menu.confirmSell) id = 'confirmSell';
    var action = this._machineMenuActions().filter(function (a) { return a.id === id; })[0];
    var r = action ? action.rect : { x: pad.x, y: pad.y, w: 0, h: 0 };
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  };

  // Painted mechanism anchors, in world units. Constants use the original
  // 700px-high plates, so loading a finish cannot change an attack event.
  Game.prototype._machineAttackSource = function (tw, tx) {
    var s = 1 + tw.level * .12;
    if (tw.type === 'mimic') return { x: tw.x + (tx >= tw.x ? 1 : -1) * 4 * s, y: tw.y + 8 - 54 * 700 / 503 * .60 * s };
    if (tw.type === 'rotor') return { x: tw.x - 54 * .045 * s, y: tw.y + 8 - 54 * 700 / 588 * .765 * s };
    return { x: tw.x, y: tw.y + 8 - 54 * 700 / 649 * .76 * s };
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
      // The contact is captured in the real hit step, including killing blows.
      // These three instantaneous attacks need no delayed or fake projectile.
      if (fx.attack === 'bite' || fx.attack === 'blade' || fx.attack === 'chill') {
        var mt = fx.attack === 'bite' ? .18 : .24;
        this.particles.push({ kind: 'machineAttack', attack: fx.attack,
          x: fx.sx, y: fx.sy, contacts: fx.contacts, s: fx.scale || 1,
          life: mt, T: mt });
        continue;
      }
      // GEARJAW REND -- sheared metal and popped rivets. Cosmetic lane: this is
      // spent from the queue in _cosmetic(), Math.random only, never the seeded
      // stream. Mechanical, not organic: the content law is comic and kid-safe,
      // so this is a machine chewing armour, not a wound.
      if (fx.k === 'grind') {
        for (var gi = 0; gi < 9; gi++) {
          var ga = -Math.PI * 0.5 + (Math.random() - 0.5) * 2.2;
          var gsp = 55 + Math.random() * 95;
          this.particles.push({ kind: 'dot', x: fx.bodyX === undefined ? fx.x : fx.bodyX, y: fx.bodyY === undefined ? fx.y : fx.bodyY,
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
        var sang = fx.stone ? Math.atan2(-.10,fx.tx>=fx.x?1:-1) : Math.atan2(fx.ty-fx.y,fx.tx-fx.x);
        this.particles.push({ kind: 'tracer', x1: fx.x, y1: fx.y,
          x2: fx.x + Math.cos(sang) * 16, y2: fx.y + Math.sin(sang) * 16,
          life: 0.06, T: 0.06, c: fx.stone?'rgba(184,204,218,.55)':'rgba(255,240,200,0.9)' });
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
        this.floats.push({ x: fx.x, y: fy, txt: fx.txt, c: fx.c, t: 1.6, notice: true });
      }
    }
    this.fxQueue.length = 0;

    for (var i = this.particles.length - 1; i >= 0; i--) {
      var pa = this.particles[i];
      if (pa.kind === 'machineAttack' && this.state === 'paused') continue;
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
      if (this.state !== 'paused') { fl.t -= dtRaw; if (!RM) fl.y -= 26 * dtRaw; }
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
    // Pin the registered attack pose while paused, just like the walk/crew
    // clock. rAF still calls cosmetics behind the pause dialog.
    if (this.state !== 'paused') {
      if (this._breathT > 0) this._breathT = Math.max(0, this._breathT - dtRaw);
      if (this._spitT > 0) this._spitT = Math.max(0, this._spitT - dtRaw);
    }
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
  // The band of screen angles a raider on the road actually occupies, measured
  // over a live wave across six machines: 33..88 degrees "below" the machine.
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
    if (!this.isRival) PlayerGuide.sync(this);
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
    // THE ROAD RUNS UNDER THE HOARD, NOT OVER IT (2026-09-14). The path cache
    // was drawn after the mound, so its faded end lay across the coin pile and
    // the gold ghosted through the cobbles at the keep door.
    this._drawPath(ctx);
    for (var kq = 0; kq < (MAP.keeps ? MAP.keeps.length : 1); kq++) this._drawMoundAndKeep(ctx, kq);
    this._drawSceneTorches(ctx); // visible fixtures over the paving, beneath actors
    this._drawMouthAlarm(ctx);    // escape pressure, UNDER the entities
    this._drawTar(ctx);           // slag sits ON the road, under everyone
    for (var kr2 = 0; kr2 < (MAP.keeps ? MAP.keeps.length : 1); kr2++) this._drawKeep(ctx, kr2);
    this._drawPads(ctx);
    if (!this.isRival) this._drawWorldHints(ctx);
    this._drawEntities(ctx);
    this._drawParticles(ctx);
    }
    if (this.state === 'menu') this._drawTitle(ctx);
    if (this.state === 'forge') this._drawForge(ctx);
    if (this.state === 'trials') this._drawTrials(ctx);
    if (this.state === 'cavern') this._drawCavernRoom(ctx);
    if (this.state === 'duel') this._drawDuelSelect(ctx);
    if (this.state === 'won' || this.state === 'lost') this._drawResult(ctx);
    if (this._lbAsk && (this.state === 'menu' || this.state === 'won' || this.state === 'lost')) this._drawLbAsk(ctx);
    ctx.restore();

    // Soft seams where the brighter sim world meets the DIMMED BAND SCENERY --
    // and only then. A full-screen state paints its own backdrop across the
    // whole viewport (see the `menuish` branch above, and _drawCavernRoom /
    // _drawForge / _drawDuelSelect / _drawTrials, which all fill
    // -v.ox-60 .. v.w+120), so there is no band to feather INTO: the bottom
    // gradient just laid a 24-unit ramp to 50% black across world y 770..794
    // and then STOPPED DEAD, leaving a hard edge at 794 on every screen with a
    // letterbox band. It was invisible while nothing was drawn below 770.
    // MEASURED once the title's utility bar reached down there: a +6 luminance
    // step straight across the bar, 41% of the way down it, at world y 794 on
    // every viewport height tested -- and it moved with the WORLD, not with the
    // device pixels, which is what ruled out a capture artifact.
    // _drawResult is the exception and correctly still gets the feather: it
    // fills only WORLD_W+80 x WORLD_H+80, so it really does sit on the bands.
    if (v.oy > 2 && !this._ownsViewport()) {
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
    if (!this.isRival && (this.state === 'playing' || this.state === 'paused')) {
      ctx.save();ctx.translate(v.ox,v.oy);this._drawFeedback(ctx);ctx.restore();
    }
    // Attached management controls remain stable during screen shake.
    if (!this.isRival && this.menu && this.state === 'playing') {
      ctx.save(); ctx.translate(v.ox, v.oy); this._drawMenus(ctx); ctx.restore();
    }

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
  // Worn paving follows the simulation's exact centreline. Historic stone
  // paths have a shallow bed and broken material edges, not a uniform black
  // curb. Tiny edge wear is exaggerated to survive a 393px phone; neither the
  // contours nor their cosmetic positional hashes enter movement/build rules.
  function roadSurfaceSamples(ln) {
    var out=[],len=LANES[ln].len,steps=Math.ceil(len/5);
    function wear(d,salt){var p=d/13,k=Math.floor(p),t=p-k;t=t*t*(3-2*t);return(noise01(k*37+ln*101,salt)*(1-t)+noise01((k+1)*37+ln*101,salt)*t-.5)*3.2;}
    for(var i=0;i<=steps;i++){
      var d=len*i/steps,p=pathPointAt(d,ln),a=pathPointAt(Math.max(0,d-3),ln),b=pathPointAt(Math.min(len,d+3),ln),dx=b.x-a.x,dy=b.y-a.y,mag=Math.sqrt(dx*dx+dy*dy)||1;
      out.push({x:p.x,y:p.y,nx:-dy/mag,ny:dx/mag,l:wear(d,641),r:wear(d,977),d:d});
    }return out;
  }
  function fillRoadSurface(c,samples,width,style) {
    c.fillStyle=style;c.beginPath();
    for(var side=0;side<2;side++)for(var n=0;n<samples.length;n++){
      var i=side?samples.length-1-n:n,p=samples[i],off=(width*.5+(side?p.r:p.l))*(side?-1:1),x=p.x+p.nx*off,y=p.y+p.ny*off;
      if(!side&&!n)c.moveTo(x,y);else c.lineTo(x,y);
    }c.closePath();c.fill();
  }

  Game.prototype._buildSceneCache = function () {
    // THE ROAD SKIN IS PART OF THE KEY. The path is baked into _bgCache once
    // and reused; without the equipped road id here, changing it in the Cavern
    // would silently do nothing until the next level load -- the exact shape of
    // "my edit landed and the game behaves as before".
    // THE KEY TRACKS THE EQUIPPED SKIN'S ART, not just the stock tile's.
    // ART.load bails after 12s and images that land later are still written into
    // ART.images, so on a slow connection the first _buildSceneCache can run
    // while road_bone (511 KB) is still in flight. _itemPlate then falls through
    // to the hue-rotated STOCK cobble and bakes it -- and with only the stock
    // tile's presence in the key, nothing ever invalidates it, so the player
    // spends the whole session on a tinted placeholder of the road they bought.
    var _rd = Save.equipped('road') || { id: '?' };
    var key = (ART.images.bg ? 'art' : 'proc') + (ART.images.road ? '+road' : '') + ':' + this.levelIdx
              + ':' + _rd.id + (_rd.art && ART.images[_rd.art] ? '+skin' : '');
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
    var LN = LANES,roadSamples=LN.map(function(_,i){return roadSurfaceSamples(i);});
    // the bed is drawn opaque into its own layer and composited ONCE, so where
    // two roads overlap the shadow does not stack into a dark scar
    var bd = document.createElement('canvas');
    bd.width = WORLD_W * res; bd.height = WORLD_H * res;
    var bc = bd.getContext('2d');
    bc.scale(res, res); bc.lineCap = 'round'; bc.lineJoin = 'round';
    // Three shallow, irregular margins replace the opaque outlined ribbon.
    // Each union is composited once, so crossing lanes do not stack shadows.
    for(var bed=0;bed<3;bed++){
      bc.clearRect(0,0,WORLD_W,WORLD_H);
      for(var b0=0;b0<LN.length;b0++)fillRoadSurface(bc,roadSamples[b0],MAP.pathW+9-bed*3,'#17131a');
      pc.globalAlpha=[.10,.13,.17][bed];pc.drawImage(bd,0,1.2,WORLD_W,WORLD_H);
    }
    pc.globalAlpha=1;
    if (ART.images.road) {
      // PAINTED road: tile the cobble texture, then mask it to the path
      // ribbon with a destination-in stroke; edge wear on top.
      var rl = document.createElement('canvas');
      rl.width = WORLD_W * res; rl.height = WORLD_H * res;
      var rc = rl.getContext('2d');
      rc.scale(res, res);
      var roadImg = this._slotPlate('road', 'road');
      // The tile is a ground material, not a billboard. Compress its depth
      // axis and let foreground stones grow with the world's shallow view.
      for(var ty=0,row=0;ty<WORLD_H;row++){
        var tile=148*depthScale(ty),tileH=tile*.70;
        for(var tx=-(row%2)*tile*.5;tx<WORLD_W;tx+=tile)rc.drawImage(roadImg,tx,ty,tile,tileH+.15);
        ty+=tileH;
      }
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
      for(var edge=0;edge<3;edge++){
        bc.clearRect(0,0,WORLD_W,WORLD_H);
        for(var m0=0;m0<LN.length;m0++)fillRoadSurface(bc,roadSamples[m0],MAP.pathW+2-edge*2,'#000');
        mc.globalAlpha=[.16,.40,1][edge];mc.drawImage(bd,0,0,WORLD_W,WORLD_H);
      }mc.globalAlpha=1;
      // Let the outside cobbles end at their painted mortar joints. Merely
      // feathering a smooth ribbon still slices every border stone in half.
      // Keep the centre wholly opaque; only the four-unit margin uses this
      // material mask. Quantiles adapt it to dark Ashfall and pale Bone Road.
      var swatch=document.createElement('canvas');swatch.width=32;swatch.height=32;
      var sx=swatch.getContext('2d');sx.drawImage(roadImg,0,0,32,32);
      var sd=sx.getImageData(0,0,32,32).data,values=[];
      for(var si=0;si<sd.length;si+=4)values.push(sd[si]*.2126+sd[si+1]*.7152+sd[si+2]*.0722);
      values.sort(function(a,b){return a-b;});
      var low=values[Math.floor(values.length*.25)],high=values[Math.floor(values.length*.56)],spread=Math.max(8,high-low);
      bc.clearRect(0,0,WORLD_W,WORLD_H);
      for(var ci=0;ci<LN.length;ci++)fillRoadSurface(bc,roadSamples[ci],MAP.pathW-8,'#000');
      var surface=rc.getImageData(0,0,rl.width,rl.height).data,mask=mc.getImageData(0,0,mk.width,mk.height),core=bc.getImageData(0,0,bd.width,bd.height).data;
      for(var mi=0;mi<mask.data.length;mi+=4){
        if(!mask.data[mi+3]||core[mi+3]===255)continue;
        var inside=core[mi+3]/255,lum=surface[mi]*.2126+surface[mi+1]*.7152+surface[mi+2]*.0722;
        mask.data[mi+3]*=inside+(1-inside)*clamp((lum-low)/spread,0,1);
      }mc.putImageData(mask,0,0);
      rc.globalCompositeOperation = 'destination-in';
      rc.drawImage(mk, 0, 0, WORLD_W, WORLD_H);
      rc.globalCompositeOperation = 'source-over';
      rc.lineCap = 'round'; rc.lineJoin = 'round';
      rc.save();rc.globalCompositeOperation='source-atop';
      var tone=rc.createLinearGradient(0,180,WORLD_W,WORLD_H);
      tone.addColorStop(0,'rgba(211,169,109,.08)');tone.addColorStop(.55,'rgba(64,59,76,.12)');tone.addColorStop(1,'rgba(36,56,84,.24)');
      rc.fillStyle=tone;rc.fillRect(0,0,WORLD_W,WORLD_H);
      // Foot traffic polishes a broad crown; it does not paint a dark stripe.
      for(var m2=0;m2<LN.length;m2++)strokePath(rc,LN[m2].pts,MAP.pathW-15,'rgba(205,189,165,.07)');
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
    // Let each road recede into the painted cave instead of stamping a flat
    // black disc over it. This soft entrance shadow is baked once per scene;
    // its heading comes from that road, including left-hand and Duel entries.
    for (var e1 = 0; e1 < LN.length; e1++) {
      var e0 = LN[e1].pts[0], eNext = LN[e1].pts[1];
      var angle = Math.atan2(eNext[1] - e0[1], eNext[0] - e0[0]);
      pc.save();pc.translate(e0[0], e0[1]);pc.rotate(angle);pc.scale(1,0.68);
      var entryShade=pc.createRadialGradient(-9,0,4,-9,0,48);
      entryShade.addColorStop(0,'rgba(8,8,14,0.94)');
      entryShade.addColorStop(0.42,'rgba(10,10,18,0.82)');
      entryShade.addColorStop(1,'rgba(10,10,18,0)');
      pc.fillStyle=entryShade;pc.fillRect(-57,-48,96,96);pc.restore();
    }
  };

  Game.prototype._drawCavern = function (ctx) {
    this._buildSceneCache();
    ctx.drawImage(this._bgCache, 0, 0, WORLD_W, WORLD_H);
  };

  // Decorative fire belongs to a visible, grounded fixture. Previously these
  // were painted BEFORE the opaque road: several stands vanished under the
  // paving while their broad floor-centered halos kept pulsing on either side.
  // Authored floor anchors now clear roads/pads; flames and their light share
  // one pose above the road, with a steady radius and restrained intensity.
  Game.prototype._drawSceneTorches = function (ctx) {
    var time=RM?0:this.worldT;
    for (var t=0;t<MAP.torches.length;t++) {
      var tc=MAP.torches[t],x=tc[0],base=tc[1],w=21*depthScale(base);
      var h=w*(700/268),flameY=base-h*.79;
      var heat=.86+.08*Math.sin(time*2.7+t*1.9)+.06*Math.sin(time*5.3+t);
      ctx.save();
      groundShadow(ctx,x,base,w,0,.38);
      // A shallow warm reflection stays at the foot of the stand.
      ctx.save();ctx.translate(x,base-1);ctx.scale(1,.36);
      var pool=ctx.createRadialGradient(0,0,1,0,0,30);
      pool.addColorStop(0,'rgba(229,136,56,'+(.12*heat)+')');pool.addColorStop(1,'rgba(229,136,56,0)');
      ctx.fillStyle=pool;ctx.beginPath();ctx.arc(0,0,30,0,6.283);ctx.fill();ctx.restore();
      // Light is centered on the actual painted flame, not on the road floor.
      var light=ctx.createRadialGradient(x,flameY,1,x,flameY,39);
      light.addColorStop(0,'rgba(255,180,76,'+(.22*heat)+')');
      light.addColorStop(.36,'rgba(249,138,48,'+(.08*heat)+')');
      light.addColorStop(1,'rgba(255,130,40,0)');
      ctx.fillStyle=light;ctx.beginPath();ctx.arc(x,flameY,39,0,6.283);ctx.fill();
      if(!drawSpriteBottom(ctx,'torch',x,base,w)) {
        ctx.fillStyle='#584234';ctx.fillRect(x-2,flameY+7,4,base-flameY-7);
        ctx.fillStyle='#ffbd55';ctx.beginPath();ctx.ellipse(x,flameY,3,6,0,0,6.283);ctx.fill();
      }
      ctx.restore();
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
    if (drawSpriteBottom(ctx, this._sidePlate(side, 'hoard', 'mound'), m.x, m.y + m.ry + 6, m.rx * 2 + 30)) { /* sprite */ }
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
    // IT BREATHES, IT DOES NOT STROBE (2026-09-14). sin(worldT*7) swelled a
    // 150-174 unit glow over the whole coin pile about once a second, from the
    // moment the hoard ran low until the player tapped -- read on a phone as
    // "the road on the gold coins is flashing". Same invitation, a slow breath.
    if (this.motherReady && this._sameSide(side, 0)) {
      var mp2 = RM ? 0.5 : 0.5 + 0.5 * Math.sin(this.worldT * 2.4);
      var mg2 = ctx.createRadialGradient(k.x, k.y - 30, 8, k.x, k.y - 30, 128 + mp2 * 10);
      mg2.addColorStop(0, 'rgba(255,190,90,' + (0.30 + mp2 * 0.08) + ')');
      mg2.addColorStop(1, 'rgba(255,140,40,0)');
      ctx.fillStyle = mg2;
      ctx.beginPath(); ctx.arc(k.x, k.y - 30, 158 + mp2 * 10, 0, 6.283); ctx.fill();
    }
    var plate=this._sidePlate(side,'keep','keep'),keepW=158;
    if(!this.isRival&&plate){
      var H=this._hudGeom(),below=H.infoY-this.view.oy+1/this.view.scale;
      var naturalH=158*plate.height/plate.width;
      keepW*=Math.min(1,Math.max(0.25,(k.y+40-below)/naturalH));
    }
    if (drawSpriteBottom(ctx,plate,k.x,k.y+40,keepW)) { /* proportional art; unchanged gameplay base */ }
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
    var pickedId = this.shopPick >= 0 ? this._shelf()[this.shopPick] : null;
    var pickedType = pickedId && TOWER_TYPES[pickedId], ownCount = 0;
    for (var oc = 0; oc < this.towers.length; oc++) if (this._sameSide(this.towers[oc].own, 0)) ownCount++;
    var padPrice = pickedType ? Math.round(pickedType.cost * PAD_DISCOUNT * crowdMul(ownCount)) : 0;
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
      var legal = armed && this._placeCheck(p.x, p.y, 0).ok;
      var afford = legal && pickedType && this.gold >= padPrice;
      var pulse = afford ? (RM ? 0.85 : 0.72 + 0.18 * Math.sin(this.worldT * 3 + i)) : (armed ? 0.35 : 0.16);
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
      if (armed && legal && pickedType) {
        ctx.strokeStyle = afford ? 'rgba(184,224,164,0.85)' : 'rgba(214,145,116,0.7)'; ctx.lineWidth = 1.8;
        ctx.beginPath(); ctx.ellipse(p.x,p.y,24,15,0,0,Math.PI*2); ctx.stroke();
        ctx.fillStyle = 'rgba(20,17,13,0.92)'; rr(ctx,p.x-20,p.y+17,40,17,6);ctx.fill();
        ctx.textAlign='center';ctx.font='bold 11px system-ui, sans-serif';ctx.fillStyle=afford?'#d3f0b8':'#efb9a5';
        ctx.fillText(padPrice+'g',p.x,p.y+29);ctx.textAlign='left';
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
      rec.y = en.py + (eFly(en) ? 28 : 0); rec.kind = 'enemy'; rec.ref = en; rec.px = en.px; rec.py = en.py;
    }
    for (i = 0; i < this.husks.length; i++) {
      var hs = this.husks[i];
      rec = slot(); n++;
      rec.y = hs.y + (eFly(hs.e) ? 28 : 0); rec.kind = 'husk'; rec.ref = hs;
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
      else if (d.kind === 'enemy') this._drawEnemy(ctx, d.ref, { x: d.px, y: d.py }, d);
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
        // reasoned that a pop is "instantly BIGGER and brighter", and
        // that is not what a pop is. The popped thing does not grow; it is REPLACED,
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
      var pp=this._projectilePresentation(pr);
      if (pr.kind === 'lob') {
        ctx.fillStyle = '#ff8a3c';
        ctx.beginPath(); ctx.arc(pp.x, pp.y, 5, 0, 6.283); ctx.fill();
        ctx.fillStyle = 'rgba(255,180,90,0.5)';
        ctx.beginPath(); ctx.arc(pp.x, pp.y, 8, 0, 6.283); ctx.fill();
      } else if (pr.kind === 'fire') {   // Wick's fireball: a comet with a tail
        var fdx2 = pp.dx, fdy2 = pp.dy;
        var flick = 0.75 + 0.25 * Math.sin(this.worldT * 40 + pr.target);
        for (var tl = 3; tl >= 1; tl--) {
          ctx.fillStyle = 'rgba(255,110,40,' + (0.13 * tl * flick) + ')';
          ctx.beginPath(); ctx.arc(pp.x - fdx2 * tl * 6, pp.y - fdy2 * tl * 6, 3 + tl * 1.7, 0, 6.283); ctx.fill();
        }
        ctx.fillStyle = 'rgba(255,140,50,0.85)';
        ctx.beginPath(); ctx.arc(pp.x, pp.y, 6.2 * flick, 0, 6.283); ctx.fill();
        ctx.fillStyle = '#fff0b0';
        ctx.beginPath(); ctx.arc(pp.x, pp.y, 3.1 * flick, 0, 6.283); ctx.fill();
      } else if(pp.type==='perch') {
        ctx.save();ctx.translate(pp.x,pp.y);ctx.rotate(Math.atan2(pp.dy,pp.dx));
        ctx.strokeStyle=pr.net?'rgba(142,215,237,.6)':'rgba(201,216,226,.42)';ctx.lineWidth=2.4;
        ctx.beginPath();ctx.moveTo(-13,0);ctx.lineTo(-3,0);ctx.stroke();
        ctx.fillStyle='#536375';ctx.beginPath();ctx.moveTo(6,0);ctx.lineTo(1,-4);ctx.lineTo(-4,-2);ctx.lineTo(-5,2);ctx.lineTo(1,4);ctx.closePath();ctx.fill();
        ctx.fillStyle='#c4d0d6';ctx.beginPath();ctx.moveTo(6,0);ctx.lineTo(1,-4);ctx.lineTo(-1,0);ctx.closePath();ctx.fill();
        if(pr.net){ctx.strokeStyle='#9bdce7';ctx.lineWidth=1;ctx.beginPath();ctx.ellipse(0,0,7,5,0,0,6.283);ctx.stroke();}
        if(pr.shieldbreak){ctx.strokeStyle='#e2d7b3';ctx.lineWidth=1.2;ctx.beginPath();ctx.moveTo(-2,-3);ctx.lineTo(2,3);ctx.moveTo(1,-3);ctx.lineTo(5,1);ctx.stroke();}
        ctx.restore();
      } else {
        // A REAL ARROW, not a light streak: shaft, iron head, fletching, all
        // rotated to its heading. This is a crossbow bolt — it should look
        // like one in flight.
        var tdx = pp.dx, tdy = pp.dy;
        var ang = Math.atan2(tdy, tdx);
        var isPierce = pr.hops > 0;
        ctx.save();
        ctx.translate(pp.x, pp.y);
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
    // Readability pass: the living raiders' health and stolen gold stay above
    // foreground bodies and bolts. Husks keep their fading art without badges.
    for (i = 0; i < n; i++) {
      var indicator = draws[i];
      if (indicator.kind === 'enemy' && indicator.ref.hp > 0)
        this._drawEnemyIndicators(ctx, indicator.ref, indicator);
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
  // Body contact is presentation only. Keep these source-aspect measurements
  // independent of decoded art and animation cadence; combat still uses feet.
  var ENEMY_BODY_ASPECT = {looter:700/477,scout:665/700,brute:700/545,shield:700/297,
    bat:700/643,warlock:700/497,blinker:700/541,boss:700/551,sapper:700/512,splitter:700/439};
  Game.prototype._enemyImpactPoint = function(e){
    var w=(e.type==='boss'?62:e.type==='brute'?46:36)*depthScale(e.py);
    return {x:e.px,y:e.py+6-(eFly(e)?26:0)-w*(ENEMY_BODY_ASPECT[e.type]||1.4)*.52};
  };
  Game.prototype._towerAimPoint = function(tw){
    var x=tw._aimX===undefined?tw.x+75:tw._aimX,y=tw._aimY===undefined?tw.y-70:tw._aimY;
    var remembered=TOWER_AIM_POINTS.get(tw);if(remembered&&remembered.x===tw._aimX&&remembered.y===tw._aimY)return remembered.point;
    for(var i=0;i<this.enemies.length;i++){
      var e=this.enemies[i];if(Math.abs(e.px-x)<.01&&Math.abs(e.py-y)<.01)return this._enemyImpactPoint(e);
    }
    return {x:x,y:y};
  };
  // The art service returns RGB sprites on a keyed background. Remove that
  // key once, before finishes, then cache the real alpha silhouette. The key
  // cannot occur in the warm wood/metal artwork. No per-frame pixel reads.
  var CROSSBOW_KEY_CACHE = new WeakMap();
  function crossbowKeyPlate(img){
    if(!img||!img.width)return null;
    var old=CROSSBOW_KEY_CACHE.get(img);if(old)return old;
    var c=document.createElement('canvas'),scale=Math.min(1,640/img.width);
    c.width=Math.round(img.width*scale);c.height=Math.round(img.height*scale);
    var ctx=c.getContext('2d',{willReadFrequently:true});ctx.drawImage(img,0,0,c.width,c.height);
    var data=ctx.getImageData(0,0,c.width,c.height),a=data.data,minX=c.width,minY=c.height,maxX=0,maxY=0;
    for(var p=0;p<a.length;p+=4){
      var r=a[p],g=a[p+1],b=a[p+2],key=Math.min(r,b)-g;
      if(r>140&&b>120&&key>65){a[p+3]=0;}
      if(a[p+3]>32){var at=p/4,x=at%c.width,y=Math.floor(at/c.width);minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
    }
    ctx.putImageData(data,0,0);var trim=document.createElement('canvas');
    trim.width=maxX-minX+1;trim.height=maxY-minY+1;trim.getContext('2d').drawImage(c,minX,minY,trim.width,trim.height,0,0,trim.width,trim.height);
    CROSSBOW_KEY_CACHE.set(img,trim);return trim;
  }
  function crossbowPlateHit(img,x,y,w,h,left,top,pad){
    if(x<left-pad||x>left+w+pad||y<top-pad||y>top+h+pad)return false;
    var mask=machineHitMask(img),sx=(x-left)/w*mask.w,sy=(y-top)/h*mask.h,rx=Math.ceil(pad/w*mask.w),ry=Math.ceil(pad/h*mask.h);
    for(var yy=Math.max(0,Math.floor(sy)-ry);yy<=Math.min(mask.h-1,Math.ceil(sy)+ry);yy++)
      for(var xx=Math.max(0,Math.floor(sx)-rx);xx<=Math.min(mask.w-1,Math.ceil(sx)+rx);xx++)if(mask.alpha[(yy*mask.w+xx)*4+3]>32)return true;
    return false;
  }
  Game.prototype._crossbowHit=function(point,tw,pad){
    var base=crossbowKeyPlate(ART.images.t_ballista_base_v2),weapon=crossbowKeyPlate(ART.images.t_ballista_turntable_v2);
    if(!base||!weapon)return false;
    var p=this._crossbowPose(tw),w=54*p.s,h=w*base.height/base.width;
    if(crossbowPlateHit(base,point.x-tw.x,point.y-tw.y-8,w,h,-w/2,-h,pad))return true;
    var dx=point.x-p.x,dy=(point.y-p.y)/.57,c=Math.cos(p.yaw),s=Math.sin(p.yaw),ww=60*p.s,hh=ww*weapon.height/weapon.width;
    return crossbowPlateHit(weapon,c*dx+s*dy+p.kick,-s*dx+c*dy,ww,hh,-.46*ww,-.5*hh,pad/.57);
  };

  Game.prototype._crossbowPose = function(tw,target,shot){
    var s=1+tw.level*.12,cx=tw.x-4.4*s,cy=tw.y-24.5*s;
    target=target||this._towerAimPoint(tw);
    var dx=target.x-cx,dy=target.y-cy;
    // Rotate in the ground plane, then foreshorten vertically. The painted
    // rail is horizontal in this source: its projected axis points exactly at
    // the body contact in every quadrant, including directly above/below.
    var yaw=Math.atan2(dy/.57,dx),ux=Math.cos(yaw),uy=Math.sin(yaw)*.57;
    var t=shot===undefined?tw.shotT:shot;
    var kick=!RM&&!(tw.jamT>0)&&t>=0&&t<.16?1.25*(1-t/.16)*s:0;
    var muzzle=31.8*s-kick;
    return {x:cx,y:cy,yaw:yaw,s:s,kick:kick,muzzle:{x:cx+ux*muzzle,y:cy+uy*muzzle},target:target,
      dx:ux/Math.sqrt(ux*ux+uy*uy),dy:uy/Math.sqrt(ux*ux+uy*uy)};
  };
  Game.prototype._drawCrossbow = function(ctx,tw){
    var base=crossbowKeyPlate(ART.images.t_ballista_base_v2),weapon=crossbowKeyPlate(ART.images.t_ballista_turntable_v2);
    if(!base||!weapon)return false;
    base=this._finishPlate(base,tw.own);weapon=this._finishPlate(weapon,tw.own);
    var pose=this._crossbowPose(tw),s=pose.s,w=54*s,h=w*base.height/base.width;
    ctx.drawImage(base,tw.x-w/2,tw.y+8-h,w,h);
    // The short bearing connects the rotating assembly to the fixed deck.
    ctx.fillStyle='#57412a';ctx.fillRect(pose.x-3*s,pose.y,6*s,5*s);
    ctx.fillStyle='#b28a46';ctx.beginPath();ctx.ellipse(pose.x,pose.y+1*s,4*s,2*s,0,0,6.283);ctx.fill();
    ctx.save();ctx.translate(pose.x,pose.y);ctx.scale(1,.57);ctx.rotate(pose.yaw);ctx.translate(-pose.kick,0);
    // A top-down weapon gives continuous yaw without turning the support legs,
    // operator or drum upside down. A shallow edge supplies the missing height.
    var ww=60*s,hh=ww*weapon.height/weapon.width,px=.46*ww,py=.50*hh;
    ctx.save();ctx.globalAlpha*=.4;ctx.drawImage(weapon,-px,-py+2*s,ww,hh);ctx.restore();
    ctx.drawImage(weapon,-px,-py,ww,hh);ctx.restore();
    return true;
  };

  // Bellows is now assembled from a stationary painted base and a real fan.
  // The source registration is measured in the trimmed base; the fan plane
  // rotates around its spindle, never around the workers or the whole beam.
  Game.prototype._bellowsPose=function(tw,work){
    var base=crossbowKeyPlate(ART.images.t_bellows_base_v2);
    if(!base)return null;
    var s=1+tw.level*.12,w=54*s,h=w*base.height/base.width;
    var body={x:tw.x-w/2,y:tw.y+8-h,w:w,h:h};
    work=work||this._machineOperatingPose(tw);
    var phase=!RM&&work.working?this.worldT*(tw._manned?9.2:7.6):0;
    return {body:body,s:s,working:work.working,phase:phase,
      fan:{x:body.x+w*.4568,y:body.y+h*.0284,w:14.6*s,angle:phase+.785398,plane:.57},
      outlets:[{x:body.x+w*.275,y:body.y+h*.714},
        {x:body.x+w*.357,y:body.y+h*.699},{x:body.x+w*.436,y:body.y+h*.726}]};
  };
  Game.prototype._bellowsHit=function(point,tw,pad){
    var base=crossbowKeyPlate(ART.images.t_bellows_base_v2),fan=crossbowKeyPlate(ART.images.t_bellows_fan_v2);
    var p=this._bellowsPose(tw);if(!p||!fan)return false;
    var b=p.body;
    if(crossbowPlateHit(base,point.x,point.y,b.w,b.h,b.x,b.y,pad))return true;
    var f=p.fan,dx=point.x-f.x,dy=(point.y-f.y)/f.plane,c=Math.cos(f.angle),s=Math.sin(f.angle),h=f.w*fan.height/fan.width;
    return crossbowPlateHit(fan,c*dx+s*dy,-s*dx+c*dy,f.w,h,-f.w/2,-h/2,pad/f.plane);
  };
  Game.prototype._drawBellows=function(ctx,tw,work){
    var base=crossbowKeyPlate(ART.images.t_bellows_base_v2),fan=crossbowKeyPlate(ART.images.t_bellows_fan_v2);
    var p=this._bellowsPose(tw,work);if(!p||!fan)return false;
    base=this._finishPlate(base,tw.own);fan=this._finishPlate(fan,tw.own);
    var b=p.body,f=p.fan,fh=f.w*fan.height/fan.width;
    ctx.drawImage(base,b.x,b.y,b.w,b.h);
    ctx.save();ctx.translate(f.x,f.y);ctx.scale(1,f.plane);ctx.rotate(f.angle);
    ctx.drawImage(fan,-f.w/2,-fh/2,f.w,fh);ctx.restore();
    // Small warm wisps leave the three actual mouths. A support post with
    // no recipient, an idle workshop or a jammed pump has no painted airflow.
    if(p.working){
      ctx.save();ctx.lineCap='round';
      for(var j=0;j<p.outlets.length;j++){
        var q=p.outlets[j],t=RM?.42:(this.worldT*1.45+j*.29)%1;
        var fade=RM?.40:Math.sin(t*Math.PI)*.55,reach=(4+11*t)*p.s;
        ctx.strokeStyle='rgba(255,213,139,'+fade+')';ctx.lineWidth=(1.4-.5*t)*p.s;
        ctx.beginPath();ctx.moveTo(q.x-1.1*p.s,q.y+.4*p.s);
        ctx.bezierCurveTo(q.x-reach*.4,q.y+2*p.s,q.x-reach*.85,q.y+4*p.s,q.x-reach,q.y+1.8*p.s);ctx.stroke();
      }
      ctx.restore();
    }
    return true;
  };

  var SHOT_VISUALS=new WeakMap(), TOWER_AIM_POINTS=new WeakMap();
  Game.prototype._roostPose=function(tw,target){
    target=target||this._towerAimPoint(tw);
    var s=1+tw.level*.12,w=54*s,h=w*700/418,sign=target.x>=tw.x?-1:1;
    // A small head inclination keeps the sculpted wings seated on the column.
    // Its stone projectile leaves the actual snout before curving to the foe.
    var rot=clamp(Math.atan2(target.y-(tw.y-h*.79+8),Math.abs(target.x-tw.x)||.001)*.10,-.12,.12),a=rot*sign;
    var px=0,py=-h*.54,mx=-w*.28,my=-h*.70-py;
    return {sign:sign,rotation:rot,muzzle:{x:tw.x+sign*(Math.cos(a)*mx-Math.sin(a)*my),y:tw.y+8+py+Math.sin(a)*mx+Math.cos(a)*my},
      dx:-sign,dy:-.10,target:target};
  };
  Game.prototype._roostHit=function(point,tw,pad){
    var layers=this._turretFor('t_perch',TOWER_TYPES.perch,tw.own);if(!layers)return false;
    var pose=this._roostPose(tw),w=54*(1+tw.level*.12),h=w*700/418;
    var dx=(point.x-tw.x)*pose.sign,dy=point.y-tw.y-8;
    if(crossbowPlateHit(layers.base,dx,dy,w,h,-w/2,-h,pad))return true;
    var a=pose.rotation*pose.sign,c=Math.cos(a),s=Math.sin(a),py=-h*.54;
    return crossbowPlateHit(layers.top,c*dx+s*(dy-py),-s*dx+c*(dy-py)+py,w,h,-w/2,-h,pad);
  };
  Game.prototype._rememberAim=function(tw,e){
    TOWER_AIM_POINTS.set(tw,{x:tw._aimX,y:tw._aimY,point:this._enemyImpactPoint(e)});
  };
  Game.prototype._registerShotVisual=function(pr,tw,target,origin){
    var point=this._enemyImpactPoint(target),pose=tw.type==='ballista'?this._crossbowPose(tw,point,0):this._roostPose(tw,point);
    SHOT_VISUALS.set(pr,{type:tw.type,source:pose.muzzle,aim:point,dx:pose.dx,dy:pose.dy,
      x:origin.x,y:origin.y,travel:0,lastX:origin.x,lastY:origin.y});
    return pose.muzzle;
  };
  Game.prototype._projectilePresentation=function(pr){
    var v=SHOT_VISUALS.get(pr),target=null;
    for(var i=0;i<this.enemies.length;i++)if(this.enemies[i].id===pr.target){target=this.enemies[i];break;}
    if(!v||!target)return {x:pr.x,y:pr.y,dx:pr.dx===undefined?1:pr.dx,dy:pr.dy===undefined?0:pr.dy,type:pr.kind};
    var end=this._enemyImpactPoint(target),lx=pr.x-v.lastX,ly=pr.y-v.lastY;
    var travel=v.travel+Math.sqrt(lx*lx+ly*ly),rx=target.px-pr.x,ry=target.py-pr.y;
    var remaining=Math.max(0,Math.sqrt(rx*rx+ry*ry)-10),t=travel/(travel+remaining||1);
    var x=v.source.x+(end.x-v.source.x)*t,y=v.source.y+(end.y-v.source.y)*t;
    var dx=end.x-v.source.x,dy=end.y-v.source.y;
    if(v.type==='perch'){
      // A short, coherent magical arc starts along the gargoyle's snout. The
      // hit still occurs on the original simulation step, including pierce.
      var bx=v.source.x+v.dx*20,by=v.source.y-9,one=1-t;
      x=one*one*v.source.x+2*one*t*bx+t*t*end.x;y=one*one*v.source.y+2*one*t*by+t*t*end.y;
      dx=2*one*(bx-v.source.x)+2*t*(end.x-bx);dy=2*one*(by-v.source.y)+2*t*(end.y-by);
    }
    var n=Math.sqrt(dx*dx+dy*dy)||1;
    return {x:x,y:y,dx:dx/n,dy:dy/n,type:v.type,progress:t};
  };

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

  /// KEYED ON THE FINISH. This cache holds halves CUT FROM THE PLATE, colour and
  /// all, so a machine skinned after the first draw would keep serving brass
  /// halves for the life of the page -- the same defect the _bgCache key had
  /// with the road skin.
  Game.prototype._turretFor = function (spriteId, tt, side) {
    if (!tt || !tt.turret) return null;
    this._turretCache = this._turretCache || {};
    var fin = this._sideItem(side | 0, 'finish');
    var key = spriteId + '@' + ((fin && fin.id) || 'brass');
    if (this._turretCache[key] !== undefined) return this._turretCache[key];
    var img = this._finishPlate(ART.images[spriteId], side);
    if (!img || !img.width) return (this._turretCache[key] = null);
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
    return (this._turretCache[key] = {
      top: half(true), base: half(false), pvx: tt.turret.pvx, pvy: tt.turret.pvy });
  };

  // A machine moves only while doing real work. Idle cooldown rescans are not
  // shots; support operation requires an active wave (and Bellows recipients).
  Game.prototype._machineOperatingPose = function (tw) {
    var jam = tw.jamT > 0, since = tw.shotT === undefined ? 9 : tw.shotT;
    var shot = !jam && since >= 0 && since < .56 ? Math.pow(1 - since / .56, 2) : 0;
    var working = false;
    if (!jam && this.waveActive && tw.type === 'press') working = true;
    if (!jam && this.waveActive && tw.type === 'bellows') {
      var range = lvlRow(tw).range;
      for (var i = 0; i < this.towers.length; i++) {
        var other = this.towers[i], dx = other.x - tw.x, dy = other.y - tw.y;
        if (!TOWER_TYPES[other.type].support && this._sameSide(other.own, tw.own) && dx * dx + dy * dy <= range * range) { working = true; break; }
      }
    }
    var motion = !RM && !jam;
    var turn = motion && tw.type === 'rotor' && since >= 0 && since < .68
      ? 6.2831853 * (1 - Math.pow(1 - since / .68, 3)) : 0;
    return { jam: jam, shot: shot, flash: RM ? 0 : shot, kick: motion ? shot : 0, turn: turn, working: working,
      pump: motion && working ? Math.sin(this.worldT * 5.5) : 0,
      press: motion && working ? (.5 - .5 * Math.cos(this.worldT * 4)) : 0 };
  };

  // Small moving mechanisms cut from the existing finish plate. The foundation
  // is never scaled or rotated. These source-image caches are render-only and
  // live outside Game, tower and checkpoint state.
  var MACHINE_WORK_PARTS = {
    mimic: { points:[[0,0],[1,0],[1,.45],[.88,.48],[.70,.41],[.23,.34],[0,.39]], pivot:[.53,.40] },
    rotor: { points:[[.43,.18],[.61,0],[.71,0],[.85,.075],[.79,.15],[.54,.23],[.72,.27],[1,.32],[1,.38],[.88,.48],[.79,.48],[.46,.29],[.30,.49],[.19,.51],[.07,.44],[.055,.39],[.33,.23],[.075,.22],[0,.185],[0,.14],[.13,.02],[.20,.04]], pivot:[.455,.235] },
    bellows: { points:[[0,0],[1,0],[1,.46],[.69,.43],[.43,.37],[.02,.35]], pivot:[.45,.33] },
    brazier: { points:[[.30,0],[.73,0],[.73,.24],[.63,.35],[.45,.38],[.35,.30]], pivot:[.51,.34] },
    crystal: { points:[[.36,.07],[.50,.08],[.63,.19],[.64,.31],[.42,.31],[.36,.19]], pivot:[.50,.27], overlay:true }
  };
  var MACHINE_WORK_CACHE = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  function machineWorkParts(img, type) {
    var spec = MACHINE_WORK_PARTS[type]; if (!spec) return null;
    var found = MACHINE_WORK_CACHE && MACHINE_WORK_CACHE.get(img); if (found) return found;
    var h = Math.min(384, img.height), w = Math.max(1, Math.round(h * img.width / img.height));
    function layer() { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
    function path(c) { c.beginPath(); for (var i=0;i<spec.points.length;i++){var p=spec.points[i];if(i)c.lineTo(p[0]*w,p[1]*h);else c.moveTo(p[0]*w,p[1]*h);}c.closePath(); }
    var body=layer(), base=body.getContext('2d');base.drawImage(img,0,0,w,h);
    var part=layer(), cut=part.getContext('2d');cut.save();path(cut);cut.clip();cut.drawImage(img,0,0,w,h);cut.restore();
    if(type==='rotor'){
      // A blade mask can also catch tiny disconnected scraps of the guard.
      // Retain its connected four-blade/axle silhouette, not those scraps.
      var pixels=cut.getImageData(0,0,w,h), labels=new Int32Array(w*h), queue=new Int32Array(w*h);
      var label=0, best=0, largest=0;
      for(var at=0;at<labels.length;at++){
        if(labels[at]||pixels.data[at*4+3]<8)continue;
        label++;var head=0,tail=1;queue[0]=at;labels[at]=label;
        while(head<tail){
          var here=queue[head++], x=here%w;
          for(var side=0;side<4;side++){
            var next=side===0?here-w:side===1?here+w:side===2?here-1:here+1;
            if(next<0||next>=labels.length||(side===2&&x===0)||(side===3&&x===w-1)||labels[next]||pixels.data[next*4+3]<8)continue;
            labels[next]=label;queue[tail++]=next;
          }
        }
        if(tail>largest){largest=tail;best=label;}
      }
      for(var clear=0;clear<labels.length;clear++)if(labels[clear]!==best)pixels.data[clear*4+3]=0;
      cut.putImageData(pixels,0,0);
    }
    if(!spec.overlay){base.save();
      if(type==='rotor'){base.translate(spec.pivot[0]*w,spec.pivot[1]*h);base.scale(1.10,1.10);base.translate(-spec.pivot[0]*w,-spec.pivot[1]*h);}
      path(base);base.clip();base.clearRect(-w,-h,w*3,h*3);base.restore();}
    found={body:body,part:part,spec:spec};if(MACHINE_WORK_CACHE)MACHINE_WORK_CACHE.set(img,found);return found;
  }
  // The screw press is driven at its handwheel: turning the screw lowers the
  // upper die (Royal Mint Museum, "Collection in Context"). The painted frame,
  // coin trays and lower die stay fixed. This small partial turn deliberately
  // favours a readable working stroke over a full spin of perspective artwork;
  // it uses the existing active-wave preparation cycle, never a coin payout.
  var PRESS_WORK_CACHE = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  function machinePressParts(img) {
    var found=PRESS_WORK_CACHE&&PRESS_WORK_CACHE.get(img);if(found)return found;
    var h=Math.min(384,img.height),w=Math.max(1,Math.round(h*img.width/img.height));
    function layer(){var c=document.createElement('canvas');c.width=w;c.height=h;return c;}
    var body=layer(),wheel=layer(),ram=layer(),b=body.getContext('2d');b.drawImage(img,0,0,w,h);
    // Follow the handwheel's lower lobes but leave the threaded stem on the
    // stationary axis. The shared pivot is the original brass hub, not the
    // bounding-box centre of the six asymmetrical painted lobes.
    var wheelPath=[[.28,0],[.81,0],[.81,.18],[.74,.225],[.64,.225],[.60,.21],[.59,.19],[.505,.19],[.49,.21],[.43,.225],[.32,.225],[.28,.17]];
    function cut(dst,points){
      var x=dst.getContext('2d');x.save();x.beginPath();for(var i=0;i<points.length;i++){var p=points[i];if(i)x.lineTo(p[0]*w,p[1]*h);else x.moveTo(p[0]*w,p[1]*h);}x.closePath();x.clip();x.drawImage(img,0,0,w,h);x.restore();
      b.save();b.beginPath();for(var j=0;j<points.length;j++){var q=points[j];if(j)b.lineTo(q[0]*w,q[1]*h);else b.moveTo(q[0]*w,q[1]*h);}b.closePath();b.clip();b.clearRect(0,0,w,h);b.restore();
    }
    cut(wheel,wheelPath);cut(ram,[[.442,.423],[.66,.411],[.669,.46],[.64,.491],[.57,.508],[.49,.502],[.443,.480]]);
    found={body:body,wheel:wheel,ram:ram};if(PRESS_WORK_CACHE)PRESS_WORK_CACHE.set(img,found);return found;
  }
  function paintPressWork(ctx,img,w,h,pose) {
    var parts=machinePressParts(img),stroke=pose.press;
    // A linked wheel turn and downward die stroke followed by an equal return.
    // Keep the full painted screw on its fixed axis to hide the tiny travel
    // under the original collar; no synthetic chassis or replacement art.
    ctx.fillStyle='#382a20';ctx.beginPath();ctx.ellipse(w*.025,-h*.535,w*.095,h*.048,0,0,6.283);ctx.fill();
    // The descending die reveals its central screw below the crossbar. Reuse
    // the painted thread in that newly exposed slot, behind frame and die.
    ctx.drawImage(img,img.width*.50,img.height*.20,img.width*.11,img.height*.075,
      0,-h*.605,w*.11,h*.075+stroke*2.3);
    ctx.drawImage(parts.body,-w/2,-h,w,h);
    ctx.drawImage(parts.ram,-w/2,-h+stroke*2.3,w,h);
    var px=w*.043,py=-h*.914;
    ctx.save();ctx.translate(px,py);ctx.scale(1,.50);ctx.rotate(stroke*.46);ctx.scale(1,2);
    ctx.drawImage(parts.wheel,-w/2-px,-h-py,w,h);ctx.restore();
  }
  function paintMachineWork(ctx,img,w,h,type,pose) {
    if(type==='press'){paintPressWork(ctx,img,w,h,pose);return;}
    var layers=machineWorkParts(img,type);
    if(!layers){ctx.drawImage(img,-w/2,-h,w,h);return;}
    var px=(layers.spec.pivot[0]-.5)*w, py=(layers.spec.pivot[1]-1)*h;
    if(type==='rotor'){
      // The guard is behind the blades in the painting. Restore the small
      // sections they used to hide, so rotating blades cannot carry stray arc
      // fragments with them or leave gaps in a stationary guard.
      ctx.save();ctx.beginPath();ctx.ellipse(-w*.045,-h*.735,w*.365,h*.19,0,0,6.283);
      ctx.strokeStyle='#80521e';ctx.lineWidth=w*.021;ctx.stroke();
      ctx.strokeStyle='#dbaa4b';ctx.lineWidth=w*.011;ctx.stroke();ctx.restore();
    }
    ctx.drawImage(layers.body,-w/2,-h,w,h);
    ctx.save();ctx.translate(px,py);
    if(type==='mimic')ctx.scale(1,1-.34*pose.kick);
    else if(type==='rotor'){
      // Rotate in the rotor's foreshortened plane, about the painted axle.
      ctx.scale(1,.53);ctx.rotate(pose.turn);ctx.scale(1,1/.53);
    }else if(type==='bellows')ctx.rotate(pose.pump*.045);
    else if(type==='brazier')ctx.scale(1+pose.kick*.045,1+pose.kick*.24);
    if(type==='crystal'){
      ctx.globalCompositeOperation='lighter';ctx.globalAlpha*=pose.flash*.55;
    }
    ctx.drawImage(layers.part,-w/2-px,-h-py,w,h);
    ctx.restore();
  }

  Game.prototype._drawTower = function (ctx, tw) {
    var p = tw;
    var lvl = tw.level;
    var work = this._machineOperatingPose(tw);
    // NO MANNED-PLATE SWAP. See MAN_SCALE: the machine is always itself, and
    // _drawHero puts Wick on top of it at his own constant size.
    var spriteId = 't_' + tw.type;
    // THE BELLOWS' FOOTPRINT IS ITS PRODUCT, so it is always drawn. _auraRate
    // and _auraDmg had ZERO draw-lane readers: a buffed machine was pixel-
    // identical to an unbuffed one, and the only ring the post ever showed was
    // the generic yellow one, only while its menu was open, in the same colour
    // an attack tower uses for its KILL range. Going out when the post is
    // jammed is also the only visible tell that machine has.
    if (tw.type === 'bellows' && !(tw.jamT > 0) && !this._previewMachine) {
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
    if (tw._oc && !tw._manned && !(tw.jamT > 0)) {   // proximity; a crew is Wick himself
      var ocp2 = RM ? .6 : 0.6 + 0.4 * Math.sin(this.worldT * 8);
      ctx.strokeStyle = 'rgba(212,168,64,' + (ocp2 * 0.55) + ')';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.ellipse(p.x, p.y + 4, 26 + ocp2 * 3, 12 + ocp2 * 2, 0, 0, 6.283); ctx.stroke();
    }
    this._drawCrewMount(ctx, tw);
    var timg = this._finishPlate(ART.images[spriteId], tw.own);
    var tt2 = TOWER_TYPES[tw.type];
    if (timg) {
      // Foundations stay planted. Local mechanisms carry the work below;
      // an idle or jammed contraption cannot inherit a whole-body recoil.
      var tlv = lvlRow(tw);
      var tw0 = 54 * (1 + lvl * 0.12);
      var th0 = tw0 * (timg.height / timg.width);
      var paintedCrossbow = tw.type === 'ballista' && ART.images.t_ballista_turntable_v2;
      var paintedBellows = tw.type === 'bellows' && ART.images.t_bellows_base_v2 && ART.images.t_bellows_fan_v2;
      var fSign=1,fRot=0;
      if(tw.type==='perch') {var roost=this._roostPose(tw);fSign=roost.sign;fRot=roost.rotation;}
      else if(!paintedCrossbow&&tt2.aims&&tw._aimX!==undefined){fSign=tw._aimX>=tw.x?-1:1;}
      var split = paintedCrossbow ? null : this._turretFor(spriteId, tt2, tw.own);
      ctx.save();
      ctx.translate(p.x, p.y + 8);
      ctx.scale(fSign, 1);
      if (paintedCrossbow) {
        ctx.restore();ctx.save();this._drawCrossbow(ctx,tw);
      } else if (paintedBellows) {
        ctx.restore();ctx.save();this._drawBellows(ctx,tw,work);
      } else if (split) {
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
        if(work.flash>0){
          ctx.save();ctx.globalCompositeOperation='lighter';ctx.globalAlpha*=work.flash*.18;
          ctx.drawImage(split.top,-tw0/2,-th0,tw0,th0);ctx.restore();
        }
      } else {
        paintMachineWork(ctx,timg,tw0,th0,tw.type,work);
      }
      ctx.restore();
      if(work.jam){
        ctx.save();var jx=p.x-14,jy=p.y-th0-10;
        ctx.fillStyle='#38201e';ctx.strokeStyle='#ef8c75';ctx.lineWidth=1;
        rr(ctx,jx,jy,28,13,3);ctx.fill();ctx.stroke();
        ctx.fillStyle='#ffe1bc';ctx.font='bold 8px system-ui';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('JAM',p.x,jy+6.5);ctx.restore();
      }
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
        var fl = RM ? .7 : 0.7 + 0.3 * Math.sin(this.worldT * 6 + p.x);
        ctx.fillStyle = '#ff8a3c'; ctx.beginPath(); ctx.ellipse(p.x, p.y - h * 0.72, 9, 12 * fl, 0, 0, 6.283); ctx.fill();
        ctx.fillStyle = '#ffcf6a'; ctx.beginPath(); ctx.ellipse(p.x, p.y - h * 0.70, 5, 7 * fl, 0, 0, 6.283); ctx.fill();
      } else if (tw.type === 'crystal') {
        ctx.fillStyle = '#5c5470'; rr(ctx, p.x - 10, p.y - 14, 20, 14, 4); ctx.fill();
        var glow = RM ? .6 : 0.6 + 0.4 * Math.sin(this.worldT * 2.5 + p.y);
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
  // Compact rank marks on the chassis edge. The old 14×12 dark rectangle
  // carried one tiny dash at rank one and looked like an empty status box.
  // Count still identifies rank; disc versus bar still identifies the L3 path.
  // These are permanent machine facts, never a pretend firing/income timer.
  Game.prototype._drawForkBadge = function (ctx, tw, p, topY) {
    var rank = (tw.level | 0) + 1, x = p.x - (tw.level === 2 ? 12 : rank * 2), y = p.y - 3;
    ctx.save();ctx.lineWidth = 1.5;ctx.strokeStyle = '#251b13';
    for (var rb = 0; rb < rank; rb++) {
      ctx.fillStyle = '#e5ba63';
      ctx.beginPath();ctx.rect(x + rb * 4, y, 2.5, 5);ctx.stroke();ctx.fill();
    }
    if (tw.level === 2) {
      var fx = x + 17, fy = y + 2.5, bc = tw.fork ? '#a8e6ff' : '#ffd75e';
      ctx.fillStyle = '#382b20';ctx.strokeStyle = bc;ctx.lineWidth = 1;
      ctx.beginPath();ctx.arc(fx,fy,4,0,6.283);ctx.fill();ctx.stroke();
      ctx.fillStyle = bc;
      if (tw.fork) ctx.fillRect(fx-2.4,fy-.85,4.8,1.7);
      else { ctx.beginPath();ctx.arc(fx,fy,1.8,0,6.283);ctx.fill(); }
    }
    ctx.restore();
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

  // Only _drawEntities supplies live-body metrics; a fading husk never enters
  // this pass. Save the canvas state so indicators cannot tint the next layer.
  Game.prototype._drawEnemyIndicators = function (ctx, e, rec) {
    var fy = rec.fy, baseW = rec.baseW, hh2 = rec.spriteH;
    ctx.save();
    // THE LOOT LEDGER — how much of OUR gold this one is holding, anchored to
    // the sprite's REAL drawn height (a fixed offset buries it in tall sprites
    // and floats it off short ones). Inflates + reddens as the mouth nears, so
    // the biggest badge on screen is always the most urgent target.
    if (e.stolen > 0) {
      var L = this._ledger || (this._ledger = this._bakeLedger());
      var ci2 = e.stolen >= 6 ? 5 : e.stolen - 1;
      var kk = e.fleeing ? Math.max(0, 1 - e.d / 220) : 0;
      ctx.save();
      ctx.translate(rec.px, rec.py + 6 + fy - Math.min(hh2 || 30, 78) - 8);
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
    // ABOVE THE HEAD, not across the waist. rec.py - 20 is mid-body on a 36-unit
    // raider, so a damaged raider wore a bright green line through their legs --
    // VANUS: "theres a white or yellow line there too that shows up under the
    // enemies it looks broken". Derived from the drawn sprite height now, so it
    // clears the head of a Scrapling and of the Hoard King alike.
    if (e.hp < e.maxHp) {
      var bw = e.type === 'boss' ? 36 : 20;
      var bimg = ART.images['e_' + e.type];
      var bh = baseW * (bimg ? bimg.height / bimg.width : 1.1);
      var by2 = rec.py - bh - 5 + fy;
      ctx.fillStyle = 'rgba(10,12,15,0.72)'; ctx.fillRect(rec.px - bw / 2 - 1, by2 - 1, bw + 2, 5);
      ctx.fillStyle = e.fleeing ? '#ff7b7b' : '#9ef58f';
      ctx.fillRect(rec.px - bw / 2, by2, bw * Math.max(0, e.hp / e.maxHp), 3);
    }
    ctx.restore();
  };

  // Distance unfolds at the actual theft turn (keepD - 1), so a raider keeps
  // the same leading foot while it turns and slows under stolen gold. The
  // head/torso stay rigid: only authored legs, cloth and wings articulate.
  var ENEMY_GAITS = {
    looter:{stride:29}, scout:{stride:35}, brute:{stride:37}, shield:{stride:27},
    bat:{stride:34}, warlock:{stride:31}, blinker:{stride:34}, boss:{stride:43},
    sapper:{stride:28}, splitter:{stride:30}
  };
  Game.prototype._enemyPose = function (e, time) {
    var profile=ENEMY_GAITS[e.type] || ENEMY_GAITS.looter;
    var active=!RM && e.hp>0;
    var travel=e.fleeing ? 2*(laneLen(e.ln)-1)-e.d : e.d;
    var cycle=active ? travel/profile.stride*6.2831853+e.id*2.399963 : 0;
    var step=Math.sin(cycle), walking=active && e.spd!==0;
    return {cycle:cycle,travel:travel,stride:profile.stride,active:active,moving:walking && e.grabT<=0,
      // A stopped/stealing actor holds its distance pose; no wall-clock shuffle.
      articulated:walking,foot:walking?Math.cos(cycle):0,
      leftLift:walking?Math.max(0,step):0,rightLift:walking?Math.max(0,-step):0,
      roll:0,hop:0,lean:0,squash:1,
      wing:active && eFly(e)?Math.sin(time*18+e.id*1.7):0,
      staff:walking?Math.sin(cycle)*.022:0,hem:walking?Math.sin(cycle-.8):0,
      type:e.type,d:e.d,ln:e.ln,fleeing:!!e.fleeing,
      facing:e.type==='looter'||e.type==='scout'?this._enemyFacing(e):1};
  };

  // Look back along the travelled road when its current tangent is vertical.
  // This is the last nonvertical heading, computed from geometry rather than
  // a render latch: 30/60fps, a first frame after resume and a turn agree.
  Game.prototype._enemyFacing = function(e) {
    var lane=laneOf(e.ln), pts=lane.pts, cum=lane.cum, n=pts.length-1;
    var lo=0,hi=n;while(lo+1<hi){var mid=(lo+hi)>>1;if(cum[mid]<=e.d)lo=mid;else hi=mid;}
    var index=Math.min(n-1,lo), direction=e.fleeing?-1:1, dx=0;
    for(var j=index;j>=0 && j<n;j-=direction){dx=pts[j+1][0]-pts[j][0];if(Math.abs(dx)>.08)break;}
    if(Math.abs(dx)<=.08){for(var k=index;k>=0 && k<n;k+=direction){dx=pts[k+1][0]-pts[k][0];if(Math.abs(dx)>.08)break;}}
    var heading=Math.abs(dx)>.08?(dx<0?-1:1)*direction:-1;
    return heading*(ENEMY_FACING[e.type] || -1);
  };

  // Authored normalized hip/knee/ankle coordinates, inspected against the
  // actual alpha-visible painting. No leg is invented under a shield/robe.
  // width/feather enclose the limb, not an arbitrary half of the sprite.
  var ENEMY_LIMBS = {
    looter:{stride:.040,lift:.023,legs:[[[.34,.60],[.26,.75],[.19,.93],.105,.105],[[.55,.63],[.61,.72],[.67,.80],.080,.090]]},
    scout:{stride:.030,lift:.027,legs:[[[.48,.52],[.38,.65],[.43,.73],.075,.085],[[.57,.54],[.66,.75],[.68,.91],.060,.080]]},
    brute:{stride:.029,lift:.017,legs:[[[.42,.71],[.36,.79],[.30,.865],.070,.070],[[.62,.72],[.65,.84],[.67,.945],.075,.065]]},
    shield:{stride:.022,lift:.006,legs:[[[.22,.928],[.21,.944],[.20,.951],.085,.060],[[.76,.934],[.76,.958],[.75,.983],.095,.070]]},
    warlock:{stride:0,lift:0,hem:{x:.58,y:.73,bottom:.947,width:.28,amount:.029}},
    blinker:{stride:0,lift:0,hem:{x:.45,y:.61,bottom:.995,width:.30,amount:.055}},
    boss:{stride:.019,lift:.010,legs:[[[.30,.813],[.28,.85],[.265,.885],.038,.047],[[.63,.835],[.65,.878],[.66,.934],.044,.042]]},
    sapper:{stride:.036,lift:.021,legs:[[[.43,.772],[.40,.835],[.30,.943],.075,.070],[[.66,.799],[.69,.851],[.67,.912],.070,.065]]},
    splitter:{stride:.030,lift:.016,legs:[[[.34,.818],[.25,.901],[.20,.970],.082,.065],[[.66,.817],[.74,.899],[.80,.972],.078,.065]]}
  };
  function enemySmooth(a,b,v){var q=clamp((v-a)/(b-a),0,1);return q*q*(3-2*q);}
  // A continuous, local inverse field. The upper body and each hip have zero
  // weight; all four components are zero outside the authored anatomy. A soft
  // field avoids cut edges and separated joints, including on enlarged art.
  function enemyLimbField(type,x,y) {
    var spec=ENEMY_LIMBS[type], out=[0,0,0,0,0];if(!spec)return out;
    var legs=spec.legs || [];
    for(var i=0;i<legs.length;i++){
      var l=legs[i],hip=l[0],knee=l[1],ankle=l[2];if(y<=hip[1])continue;
      var a=clamp((y-hip[1])/(ankle[1]-hip[1]),0,1);
      var center=y<knee[1]?(hip[0]+(knee[0]-hip[0])*clamp((y-hip[1])/(knee[1]-hip[1]),0,1)):
        (knee[0]+(ankle[0]-knee[0])*clamp((y-knee[1])/(ankle[1]-knee[1]),0,1));
      var lateral=1-enemySmooth(l[3],l[3]+l[4]*1.45,Math.abs(x-center));
      // Fade beyond this painted boot so a short bent leg cannot drag the
      // unrelated lower boot or transparent plate margin along with it.
      var weight=lateral*enemySmooth(0,1,a)*(1-enemySmooth(ankle[1]+.04,ankle[1]+.10,y));
      out[i*2]=(i?-1:1)*spec.stride*weight;out[i*2+1]=spec.lift*weight;
    }
    if(spec.hem){var h=spec.hem;out[4]=(1-enemySmooth(h.width,h.width+.12,Math.abs(x-h.x)))*
      enemySmooth(h.y,h.y+.09,y)*(1-enemySmooth(h.bottom-.05,h.bottom,y))*h.amount;}
    return out;
  }
  // Only the lower patch is cached; the full-resolution head/torso is drawn
  // directly from the painting. 32 shared poses/type, not a per-actor atlas.
  // Each pose is baked at most once using continuous bilinear sampling. The
  // source, influence fields and cached frames live outside simulation state.
  var ENEMY_LIMB_CACHE=typeof WeakMap!=='undefined'?new WeakMap():null;
  var ENEMY_LIMB_STEPS=32;
  function enemyLimbBank(img,type){
    var spec=ENEMY_LIMBS[type];if(!spec)return null;
    var cached=ENEMY_LIMB_CACHE && ENEMY_LIMB_CACHE.get(img);if(cached===false)return null;if(cached)return cached;
    var h=type==='boss'?192:160,w=Math.max(1,Math.round(h*img.width/img.height));
    var first=spec.hem?spec.hem.y:Math.min.apply(null,spec.legs.map(function(l){return l[0][1];}));
    var cut=Math.max(0,Math.floor(first*h)-2),rows=h-cut+3;
    var c=document.createElement('canvas');c.width=w;c.height=h;
    var cx=c.getContext('2d',{willReadFrequently:true});cx.drawImage(img,0,0,w,h);
    var source=cx.getImageData(0,0,w,h).data,fields=new Float32Array(w*rows*5);
    for(var y=0;y<rows;y++)for(var x=0;x<w;x++){
      var field=enemyLimbField(type,x/w,(cut+y)/h),at=(y*w+x)*5;
      for(var k=0;k<5;k++)fields[at+k]=field[k];
    }
    cached={w:w,h:h,cut:cut,rows:rows,source:source,fields:fields,frames:[],baked:0,bytes:source.byteLength+fields.byteLength};
    if(ENEMY_LIMB_CACHE)ENEMY_LIMB_CACHE.set(img,cached);return cached;
  }
  function enemyLimbFrame(img,pose){
    var bank=enemyLimbBank(img,pose.type);if(!bank)return null;
    var phase=((pose.cycle/6.2831853)%1+1)%1,key=Math.round(phase*ENEMY_LIMB_STEPS)%ENEMY_LIMB_STEPS;
    if(bank.frames[key])return {bank:bank,image:bank.frames[key]};
    var angle=key/ENEMY_LIMB_STEPS*6.2831853,step=Math.sin(angle),swing=Math.cos(angle),
      liftL=Math.max(0,step),liftR=Math.max(0,-step),hem=Math.sin(angle-.8);
    var c=document.createElement('canvas');c.width=bank.w;c.height=bank.rows;
    var ctx=c.getContext('2d'),dst=ctx.createImageData(c.width,c.height),out=dst.data,src=bank.source;
    var w=bank.w,h=bank.h,fields=bank.fields;
    for(var y=0;y<bank.rows;y++)for(var x=0;x<w;x++){
      var at=(y*w+x)*5,dx=((fields[at]+fields[at+2])*swing+fields[at+4]*hem)*w,
        dy=-(fields[at+1]*liftL+fields[at+3]*liftR)*h;
      var sx=x-dx,sy=bank.cut+y-dy,index=(y*w+x)*4;
      if(sx<0 || sx>=w-1 || sy<0 || sy>=h-1)continue;
      var ix=Math.floor(sx),iy=Math.floor(sy),fx=sx-ix,fy=sy-iy,
        a=(iy*w+ix)*4,b=a+4,c0=a+w*4,d=c0+4,
        wa=(1-fx)*(1-fy)*src[a+3],wb=fx*(1-fy)*src[b+3],
        wc=(1-fx)*fy*src[c0+3],wd=fx*fy*src[d+3],alpha=wa+wb+wc+wd;
      if(alpha>0){out[index]=(src[a]*wa+src[b]*wb+src[c0]*wc+src[d]*wd)/alpha;
        out[index+1]=(src[a+1]*wa+src[b+1]*wb+src[c0+1]*wc+src[d+1]*wd)/alpha;
        out[index+2]=(src[a+2]*wa+src[b+2]*wb+src[c0+2]*wc+src[d+2]*wd)/alpha;out[index+3]=alpha;}
    }
    ctx.putImageData(dst,0,0);bank.frames[key]=c;bank.baked++;bank.bytes+=c.width*c.height*4;
    return {bank:bank,image:c};
  }
  var ENEMY_MOTION_PREWARM_MS=0;
  function enemyMotionPrewarm(){
    var started=Date.now();
    Object.keys(ENEMY_GAITS).forEach(function(type){
      var img=ART.images['e_'+type];if(!img)return;
      var source=img;
      try{
        if(type==='looter'&&looterPuppet()){
          ['body','arm','upper','lower','boot'].forEach(function(part){enemyFrameRim(LOOTER_PUPPET[part]);});return;
        }
        if(type==='scout'&&scoutPuppet()){['body','upper','lower','boot'].forEach(function(part){enemyFrameRim(SCOUT_PUPPET[part]);});return;}
        var rig=enemyRig(img,type);source=rig?rig.body:img;
        enemyFrameRim(source);
        if(rig)rig.parts.forEach(function(part){enemyFrameRim(part.image);});
        for(var i=0;i<ENEMY_LIMB_STEPS;i++){
          var frame=enemyLimbFrame(source,{type:type,cycle:i/ENEMY_LIMB_STEPS*6.2831853});
          if(frame)enemyFrameRim(frame.image);
        }
      }catch(error){
        // A missing/undecodable plate must retain the ordinary sprite/fallback,
        // never strand the loading overlay or repeatedly retry a failed bank.
        if(ENEMY_LIMB_CACHE)ENEMY_LIMB_CACHE.set(source,false);
        if(_dev && typeof console!=='undefined')console.warn('Enemy articulation unavailable: '+type,error);
      }
    });
    ENEMY_MOTION_PREWARM_MS=Date.now()-started;
  }
  // Pure render diagnostics for anatomy/continuity/cost gates; no state hooks.
  Game.prototype._enemyLimbField=function(type,x,y){return enemyLimbField(type,x,y);};
  Game.prototype._enemyMotionCache=function(type){var img=ART.images['e_'+type];if(!img)return null;
    if(type==='looter'&&looterPuppet()){
      var puppet=LOOTER_PUPPET,bytes=0;['body','arm','leg','upper','lower','boot'].forEach(function(part){var p=puppet[part];bytes+=p.width*p.height*4;if(part!=='leg'){var r=enemyFrameRim(p);bytes+=r.width*r.height*4;}});
      return {kind:'puppet',frames:0,bytes:bytes,prewarmMs:ENEMY_MOTION_PREWARM_MS};
    }
    if(type==='scout'&&scoutPuppet()){var sb=0;['body','leg','upper','lower','boot'].forEach(function(part){var p=SCOUT_PUPPET[part];sb+=p.width*p.height*4;if(part!=='leg'){var r=enemyFrameRim(p);sb+=r.width*r.height*4;}});return {kind:'puppet',frames:0,bytes:sb,prewarmMs:ENEMY_MOTION_PREWARM_MS};}
    var rig=enemyRig(img,type),bank=enemyLimbBank(rig?rig.body:img,type);
    return bank?{frames:bank.baked,limit:ENEMY_LIMB_STEPS,bytes:bank.bytes+bank.frames.reduce(function(n,c){return n+c.width*c.height*4;},0),width:bank.w,height:bank.rows,prewarmMs:ENEMY_MOTION_PREWARM_MS}:null;};

  // Runtime cutouts retain the original painted pixels. Cache by source image
  // (including its rim), outside Game/enemy/checkpoint state. Joint overlap
  // stays under the torso; only the wing tips/staff move independently.
  var ENEMY_RIG_CACHE = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  var ENEMY_RIGS = {
    bat: [
      { points: [[0,0],[.27,0],[.35,.34],[.31,.47],[.20,.51],[0,.44]], pivot: [.28,.44], side: -1 },
      { points: [[.70,.16],[1,.12],[1,.67],[.65,.71],[.59,.52]], pivot: [.64,.56], side: 1 }
    ],
    warlock: [
      { points: [[0,0],[.21,0],[.22,.35],[.16,.45],[.18,.59],[.13,.91],[0,.91]], pivot: [.15,.53], side: 0 }
    ]
  };
  function enemyRig(img, type) {
    var spec = ENEMY_RIGS[type]; if (!spec) return null;
    var cached = ENEMY_RIG_CACHE && ENEMY_RIG_CACHE.get(img);
    if (cached) return cached;
    var h = Math.min(256, img.height), w = Math.max(1, Math.round(h * img.width / img.height));
    function plate() { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
    function path(ctx, points) { ctx.beginPath(); points.forEach(function(p,i){if(i)ctx.lineTo(p[0]*w,p[1]*h);else ctx.moveTo(p[0]*w,p[1]*h);});ctx.closePath(); }
    var body = plate(), bc = body.getContext('2d'); bc.drawImage(img,0,0,w,h);
    var parts = spec.map(function(s){
      var c=plate(), cx=c.getContext('2d');cx.save();path(cx,s.points);cx.clip();cx.drawImage(img,0,0,w,h);cx.restore();
      bc.save();path(bc,s.points);bc.clip();bc.globalCompositeOperation='destination-out';bc.fillRect(0,0,w,h);bc.restore();
      // Keep a small original shoulder/wrist patch on top of the moving part.
      bc.save();bc.beginPath();bc.ellipse(s.pivot[0]*w,s.pivot[1]*h,w*.055,h*.045,0,0,6.283);bc.clip();bc.drawImage(img,0,0,w,h);bc.restore();
      return { image:c, pivot:s.pivot, side:s.side };
    });
    cached={body:body,parts:parts};if(ENEMY_RIG_CACHE)ENEMY_RIG_CACHE.set(img,cached);return cached;
  }
  var ENEMY_FRAME_RIMS = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  function enemyFrameRim(img) {
    var cached = ENEMY_FRAME_RIMS && ENEMY_FRAME_RIMS.get(img);
    if (cached) return cached;
    var c=document.createElement('canvas');c.height=Math.min(256,img.height);c.width=Math.max(1,Math.round(c.height*img.width/img.height));
    var ctx=c.getContext('2d');ctx.drawImage(img,0,0,c.width,c.height);
    ctx.globalCompositeOperation='source-in';ctx.fillStyle='#ffc47c';ctx.fillRect(0,0,c.width,c.height);
    if(ENEMY_FRAME_RIMS)ENEMY_FRAME_RIMS.set(img,c);return c;
  }
  // Separate painted bones let the common raider actually exchange support
  // feet. His previous running illustration could only shear a raised boot.
  var LOOTER_PUPPET = null;
  var LOOTER_JOINTS={hip:{x:.66,y:.054},knee:{x:.56,y:.392},ankle:{x:.675,y:.711}};
  function looterPuppet(){
    if(LOOTER_PUPPET)return LOOTER_PUPPET;
    var body=crossbowKeyPlate(ART.images.e_looter_body_v2),leg=crossbowKeyPlate(ART.images.e_looter_leg_v2);
    if(!body||!leg)return null;
    // Bound the working texture before cutting; oversized stitch detail must
    // not shimmer when a nine-unit boot is reduced to phone pixels.
    if(leg.height>320){var small=document.createElement('canvas');small.height=320;small.width=Math.round(320*leg.width/leg.height);small.getContext('2d').drawImage(leg,0,0,small.width,small.height);leg=small;}
    function cut(top,bottom,topJoint,bottomJoint){
      var c=document.createElement('canvas');c.width=leg.width;c.height=leg.height;
      var x=c.getContext('2d');x.save();x.beginPath();x.rect(0,top*c.height,c.width,(bottom-top)*c.height);
      // Rounded painted overlaps hide a rotating joint without copying any
      // of the boot onto the shin or leaving a rectangular trouser edge.
      [topJoint,bottomJoint].forEach(function(j){if(!j)return;var ankle=j===LOOTER_JOINTS.ankle,rx=ankle?.26:.34,ry=ankle?.018:.038;x.moveTo((j.x+rx)*c.width,j.y*c.height);x.ellipse(j.x*c.width,j.y*c.height,c.width*rx,c.height*ry,0,0,6.2831853);});
      x.clip();x.drawImage(leg,0,0);x.restore();return c;
    }
    var knee=LOOTER_JOINTS.knee,ankle=LOOTER_JOINTS.ankle;
    var arm=document.createElement('canvas'),torso=document.createElement('canvas');
    arm.width=torso.width=body.width;arm.height=torso.height=body.height;
    var armPoints=[[0,.629],[.105,.624],[.148,.66],[.145,.70],[.192,.752],[.194,.862],[0,.862]];
    function armMask(x){x.beginPath();armPoints.forEach(function(p,i){if(i)x.lineTo(p[0]*body.width,p[1]*body.height);else x.moveTo(p[0]*body.width,p[1]*body.height);});x.closePath();}
    var ax=arm.getContext('2d');ax.save();armMask(ax);ax.clip();ax.drawImage(body,0,0);ax.restore();
    var tx=torso.getContext('2d');tx.drawImage(body,0,0);tx.globalCompositeOperation='destination-out';armMask(tx);tx.fill();tx.globalCompositeOperation='source-over';
    // The cuff overlaps its pinned elbow; the face, chest, sack and shoulder
    // remain the original rigid painting while the free forearm counter-swings.
    tx.save();tx.beginPath();tx.ellipse(body.width*.073,body.height*.641,body.width*.040,body.height*.022,0,0,6.2831853);tx.clip();tx.drawImage(body,0,0);tx.restore();
    LOOTER_PUPPET={body:torso,arm:arm,leg:leg,upper:cut(0,knee.y,null,knee),lower:cut(knee.y,ankle.y,knee,ankle),boot:cut(ankle.y,1,ankle,null)};
    return LOOTER_PUPPET;
  }
  function looterLegPose(w,h,pose,far){
    var rig=looterPuppet(),legH=h*.44*(far?.98:1),legW=legH*rig.leg.width/rig.leg.height;
    var bodyH=w*rig.body.height/rig.body.width,hip={x:w*(far?.105:-.055),y:-h+bodyH*.87+(far?.7:0)};
    var phase=((pose.cycle/6.2831853+(far?.5:0))%1+1)%1,span=pose.stride/4;
    var x=0,lift=0,bootAngle=0,stance=true;
    if(pose.articulated){
      if(phase<.5)x=-span+4*span*phase;
      else{
        var u=phase*2-1,u2=u*u,u3=u2*u;
        // Matched endpoint velocity continues the toe-off/landing motion.
        x=(2*u3-3*u2+1)*span+(u3-2*u2+u)*2*span+(-2*u3+3*u2)*-span+(u3-u2)*2*span;
        lift=Math.sin(u*Math.PI)*h*.070;bootAngle=Math.sin(u*6.2831853)*.18;stance=false;
      }
    }
    var groundX=x,groundY=0;
    if(pose.articulated&&Number.isFinite(pose.d)){
      // The planted target lies on the real road. During stance, d - x stays
      // constant, so a corner cannot make the foot skate sideways. Depth is
      // foreshortened in the painted three-quarter view; no render latch.
      var road=pathPointAt(pose.d,pose.ln),contact=pathPointAt(pose.d+(pose.fleeing?-1:1)*-x,pose.ln);
      groundX=(contact.x-road.x)*pose.facing;groundY=(contact.y-road.y)*.4;
    }
    var ground=far?-.65:0,ankle={x:hip.x+groundX,y:ground+groundY-lift-(1-LOOTER_JOINTS.ankle.y)*legH};
    var a=LOOTER_JOINTS.hip,b=LOOTER_JOINTS.knee,c=LOOTER_JOINTS.ankle;
    var l1=Math.hypot((b.x-a.x)*legW,(b.y-a.y)*legH),l2=Math.hypot((c.x-b.x)*legW,(c.y-b.y)*legH);
    var dx=ankle.x-hip.x,dy=ankle.y-hip.y,raw=Math.hypot(dx,dy),d=Math.min(l1+l2-.01,Math.max(Math.abs(l1-l2)+.01,raw));
    if(raw!==d){ankle.x=hip.x+dx*d/(raw||1);ankle.y=hip.y+dy*d/(raw||1);dx=ankle.x-hip.x;dy=ankle.y-hip.y;}
    var along=(l1*l1-l2*l2+d*d)/(2*d),bend=Math.sqrt(Math.max(0,l1*l1-along*along));
    var knee={x:hip.x+dx/d*along-dy/d*bend,y:hip.y+dy/d*along+dx/d*bend};
    return {hip:hip,knee:knee,ankle:ankle,w:legW,h:legH,stance:stance,lift:lift,phase:phase,bootAngle:bootAngle,reachError:Math.abs(raw-d)};
  }
  Game.prototype._looterLegPose=function(e,far){
    var img=ART.images.e_looter;if(!img||!looterPuppet())return null;
    var w=36*depthScale(e.py);return looterLegPose(w,w*img.height/img.width,this._enemyPose(e,this.worldT),far);
  };
  function paintLooterPuppet(ctx,w,h,pose,isRim){
    var rig=looterPuppet();if(!rig)return false;
    function plate(p){return isRim?enemyFrameRim(p):p;}
    function bone(image,leg,start,end,sourceStart,sourceEnd){
      var angle=Math.atan2(end.y-start.y,end.x-start.x)-Math.atan2((sourceEnd.y-sourceStart.y)*leg.h,(sourceEnd.x-sourceStart.x)*leg.w);
      ctx.save();ctx.translate(start.x,start.y);ctx.rotate(angle);
      ctx.drawImage(plate(image),-sourceStart.x*leg.w,-sourceStart.y*leg.h,leg.w,leg.h);ctx.restore();
    }
    for(var i=0;i<2;i++){
      var far=i===0,leg=looterLegPose(w,h,pose,far);
      ctx.save();if(far)ctx.globalAlpha*=.94;
      bone(rig.lower,leg,leg.knee,leg.ankle,LOOTER_JOINTS.knee,LOOTER_JOINTS.ankle);
      bone(rig.upper,leg,leg.hip,leg.knee,LOOTER_JOINTS.hip,LOOTER_JOINTS.knee);
      ctx.save();ctx.translate(leg.ankle.x,leg.ankle.y);ctx.rotate(leg.bootAngle);
      ctx.drawImage(plate(rig.boot),-LOOTER_JOINTS.ankle.x*leg.w,-LOOTER_JOINTS.ankle.y*leg.h,leg.w,leg.h);ctx.restore();ctx.restore();
    }
    var bodyH=w*rig.body.height/rig.body.width,elbowX=(.073-.5)*w,elbowY=-h+bodyH*.641;
    ctx.save();ctx.translate(elbowX,elbowY);ctx.rotate(pose.articulated?-Math.cos(pose.cycle)*.18:0);
    ctx.drawImage(plate(rig.arm),-w/2-elbowX,-h-elbowY,w,bodyH);ctx.restore();
    ctx.drawImage(plate(rig.body),-w/2,-h,w,bodyH);
    return true;
  }
  // Filcher's extended painted leg supplies both complete limbs. The original
  // tucked leg cannot reach the floor; merely warping it leaves a skating pose.
  // Cutouts and rims are shared outside simulation/checkpoint state.
  var SCOUT_PUPPET=null;
  var SCOUT_JOINTS={hip:{x:.563,y:.536},knee:{x:.674,y:.756},ankle:{x:.704,y:.907}};
  function scoutPuppet(){
    if(SCOUT_PUPPET)return SCOUT_PUPPET;
    var img=ART.images.e_scout;if(!img)return null;
    var h=Math.min(384,img.height),w=Math.round(h*img.width/img.height);
    function plate(){var c=document.createElement('canvas');c.width=w;c.height=h;return c;}
    function path(x,points){x.beginPath();points.forEach(function(p,i){x[i?'lineTo':'moveTo'](p[0]*w,p[1]*h);});x.closePath();}
    var legPoints=[[.49,.50],[.59,.50],[.64,.56],[.68,.64],[.735,.72],[.77,.80],[.76,.88],[.75,.95],[.72,1],[.65,1],[.63,.96],[.63,.91],[.65,.86],[.61,.81],[.56,.76],[.52,.69],[.49,.61]];
    var leg=plate(),lx=leg.getContext('2d');lx.save();path(lx,legPoints);lx.clip();lx.drawImage(img,0,0,w,h);lx.restore();
    var body=plate(),bx=body.getContext('2d');bx.drawImage(img,0,0,w,h);
    bx.globalCompositeOperation='destination-out';path(bx,[[.39,.52],[.48,.48],[.59,.50],[.65,.60],[.77,.70],[.80,1],[.24,1],[.25,.67],[.33,.56]]);bx.fill();bx.globalCompositeOperation='source-over';
    // A narrow original belt/hip bridge covers both rotating thigh roots.
    bx.save();bx.beginPath();bx.ellipse(w*.524,h*.521,w*.088,h*.030,0,0,6.2831853);bx.clip();bx.drawImage(img,0,0,w,h);bx.restore();
    function cut(top,bottom,a,b){var c=plate(),x=c.getContext('2d');x.save();x.beginPath();x.rect(0,top*h,w,(bottom-top)*h);
      [a,b].forEach(function(j){if(!j)return;x.moveTo((j.x+.08)*w,j.y*h);x.ellipse(j.x*w,j.y*h,w*.08,h*.022,0,0,6.2831853);});x.clip();x.drawImage(leg,0,0);x.restore();return c;}
    SCOUT_PUPPET={body:body,leg:leg,upper:cut(0,SCOUT_JOINTS.knee.y,null,SCOUT_JOINTS.knee),lower:cut(SCOUT_JOINTS.knee.y,SCOUT_JOINTS.ankle.y,SCOUT_JOINTS.knee,SCOUT_JOINTS.ankle),boot:cut(SCOUT_JOINTS.ankle.y,1,SCOUT_JOINTS.ankle,null)};
    return SCOUT_PUPPET;
  }
  function scoutLegPose(w,h,pose,far){
    var legW=w*1.20,legH=h*1.20,hip={x:w*(far?-.035:.063),y:-h+h*.536+(far?-.3:0)};
    var phase=((pose.cycle/6.2831853+(far?.5:0))%1+1)%1,span=pose.stride/4;
    var x=0,lift=0,bootAngle=0,stance=true;
    if(pose.articulated){
      if(phase<.5)x=-span+4*span*phase;
      else{var u=phase*2-1,u2=u*u,u3=u2*u;x=(2*u3-3*u2+1)*span+(u3-2*u2+u)*2*span+(-2*u3+3*u2)*-span+(u3-u2)*2*span;
        lift=Math.sin(u*Math.PI)*h*.15;bootAngle=Math.sin(u*6.2831853)*.32;stance=false;}
    }
    var groundX=x,groundY=0;
    if(pose.articulated&&Number.isFinite(pose.d)){
      var road=pathPointAt(pose.d,pose.ln),contact=pathPointAt(pose.d+(pose.fleeing?-1:1)*-x,pose.ln);
      groundX=(contact.x-road.x)*pose.facing;groundY=(contact.y-road.y)*.4;
    }
    var ankle={x:hip.x+groundX,y:(far?-.65:0)+groundY-lift-(1-SCOUT_JOINTS.ankle.y)*legH};
    var a=SCOUT_JOINTS.hip,b=SCOUT_JOINTS.knee,c=SCOUT_JOINTS.ankle;
    var l1=Math.hypot((b.x-a.x)*legW,(b.y-a.y)*legH),l2=Math.hypot((c.x-b.x)*legW,(c.y-b.y)*legH);
    var dx=ankle.x-hip.x,dy=ankle.y-hip.y,raw=Math.hypot(dx,dy),d=Math.min(l1+l2-.01,Math.max(Math.abs(l1-l2)+.01,raw));
    if(raw!==d){ankle.x=hip.x+dx*d/(raw||1);ankle.y=hip.y+dy*d/(raw||1);dx=ankle.x-hip.x;dy=ankle.y-hip.y;}
    var along=(l1*l1-l2*l2+d*d)/(2*d),bend=Math.sqrt(Math.max(0,l1*l1-along*along));
    var knee={x:hip.x+dx/d*along-dy/d*bend,y:hip.y+dy/d*along+dx/d*bend};
    return{hip:hip,knee:knee,ankle:ankle,w:legW,h:legH,stance:stance,lift:lift,phase:phase,bootAngle:bootAngle,reachError:Math.abs(raw-d)};
  }
  Game.prototype._scoutLegPose=function(e,far){var img=ART.images.e_scout;if(!img||!scoutPuppet())return null;var w=36*depthScale(e.py);return scoutLegPose(w,w*img.height/img.width,this._enemyPose(e,this.worldT),far);};
  function paintScoutPuppet(ctx,w,h,pose,isRim){
    var rig=scoutPuppet();if(!rig)return false;
    function plate(p){return isRim?enemyFrameRim(p):p;}
    function bone(image,leg,start,end,a,b){var angle=Math.atan2(end.y-start.y,end.x-start.x)-Math.atan2((b.y-a.y)*leg.h,(b.x-a.x)*leg.w);
      ctx.save();ctx.translate(start.x,start.y);ctx.rotate(angle);ctx.drawImage(plate(image),-a.x*leg.w,-a.y*leg.h,leg.w,leg.h);ctx.restore();}
    for(var i=0;i<2;i++){var far=i===0,leg=scoutLegPose(w,h,pose,far);ctx.save();if(far)ctx.globalAlpha*=.88;
      bone(rig.lower,leg,leg.knee,leg.ankle,SCOUT_JOINTS.knee,SCOUT_JOINTS.ankle);bone(rig.upper,leg,leg.hip,leg.knee,SCOUT_JOINTS.hip,SCOUT_JOINTS.knee);
      ctx.save();ctx.translate(leg.ankle.x,leg.ankle.y);ctx.rotate(leg.bootAngle);ctx.drawImage(plate(rig.boot),-SCOUT_JOINTS.ankle.x*leg.w,-SCOUT_JOINTS.ankle.y*leg.h,leg.w,leg.h);ctx.restore();ctx.restore();}
    ctx.drawImage(plate(rig.body),-w/2,-h,w,h);return true;
  }

  function paintEnemyArt(ctx,img,w,h,pose,isRim) {
    if(pose.type==='looter'&&paintLooterPuppet(ctx,w,h,pose,isRim))return;
    if(pose.type==='scout'&&paintScoutPuppet(ctx,w,h,pose,isRim))return;
    var rig=enemyRig(img,pose.type);
    if(rig){
      for(var i=0;i<rig.parts.length;i++){
        var part=rig.parts[i],px=(part.pivot[0]-.5)*w,py=(part.pivot[1]-1)*h;
        ctx.save();ctx.translate(px,py);
        if(pose.type==='bat'){
          ctx.rotate(part.side*pose.wing*.24);
          ctx.scale(1,1-.18*(pose.wing+1)*.5);
        }else ctx.rotate(pose.staff);
        ctx.drawImage(isRim?enemyFrameRim(part.image):part.image,-w/2-px,-h-py,w,h);ctx.restore();
      }
      img=rig.body;
    }
    var limb=pose.articulated?enemyLimbFrame(img,pose):null;
    if(limb){
      var bank=limb.bank,cut=bank.cut/bank.h,overlap=1/bank.h;
      ctx.drawImage(isRim?enemyFrameRim(limb.image):limb.image,-w/2,-h+cut*h,w,h*bank.rows/bank.h);
      // The two-row zero-weight band is identical to the original painting.
      // One source-pixel overlap seals fractional phone scaling without a seam.
      var upper=isRim?enemyFrameRim(img):img;
      ctx.drawImage(upper,0,0,upper.width,upper.height*(cut+overlap),-w/2,-h,w,h*(cut+overlap));
      return;
    }
    ctx.drawImage(isRim?enemyFrameRim(img):img,-w/2,-h,w,h);
  }

  Game.prototype._drawEnemy = function (ctx, e, p, indicator) {
    var base = ENEMY_TYPES[e.type];
    var pose = this._enemyPose(e, this.worldT);
    var bob = pose.active ? Math.sin(this.worldT * 9 + e.id * 1.3) * 2 : 0;
    // a netted flyer sits on the road (groundedT), wings clipped
    var fy = eFly(e) ? -26 + (pose.active ? Math.sin(this.worldT * 4 + e.id) * 1.5 : 0) : 0;
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
      // The painting's torso and head stay registered over its contact shadow.
      // Direction is a mirror; footsteps are local articulation, never a whole
      // body tilt/stretch. A theft holds its last distance pose until travel.
      var flip = this._enemyFacing(e);
      var face = flip, hop = 0, waddle = 0, lean = 0, squash = 1;
      // Preserve the short truthful impact pulse, not a looping walk pulse.
      if (e.flashT > 0 && pose.active) squash += e.flashT * .06;
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
      var bodyAlpha = ctx.globalAlpha;
      var rk = 1.035;
      ctx.globalAlpha = bodyAlpha * 0.5;
      paintEnemyArt(ctx, img, w0 * rk, hh2 * rk, pose, true);
      ctx.globalAlpha = bodyAlpha;
      paintEnemyArt(ctx, img, w0, hh2, pose);
      // TORCHLIGHT: the six lights each map declares used to illuminate
      // nothing — they were painted before the entities. Now a body that
      // walks past a torch actually catches its warmth.
      var tw2 = torchWarm(p.x, p.y);
      if (tw2 > 0.02) {
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = bodyAlpha * 0.30 * tw2;
        paintEnemyArt(ctx, img, w0, hh2, pose);
        ctx.globalAlpha = bodyAlpha;
        ctx.globalCompositeOperation = 'source-over';
      }
      if (e.flashT > 0) {                       // white-flash: re-draw lighter
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = bodyAlpha * Math.min(0.45, e.flashT * 5);   // a tint, not a strobe
        paintEnemyArt(ctx, img, w0, hh2, pose);
        ctx.globalAlpha = bodyAlpha;
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
        var wf = pose.active ? Math.sin(this.worldT * 18 + e.id) * 0.6 : 0;
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
    if (indicator) {
      indicator.fy = fy; indicator.baseW = baseW; indicator.spriteH = hh2 || 30;
    }
    // burn flicker
    if (e.burnT > 0) {
      ctx.fillStyle = 'rgba(255,138,60,0.6)';
      ctx.beginPath(); ctx.arc(p.x + (pose.active ? Math.sin(this.worldT * 20 + e.id) * 3 : 0), p.y - 16 + fy, 3, 0, 6.283); ctx.fill();
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

  // Wing motion is independent of machine output. The spread crew painting
  // needs a sustained beat even between shots; ground poses stay restrained.
  // Free wing edges are cut at authored roots; the painted shoulder overlap
  // stays on the rigid torso. Feet, eyes and the shared muzzle remain fixed.
  var WICK_PRESENCE = {
    front:{w:783,h:730,parts:[
      {name:'wing',side:1,pivot:[455,352],poly:[[443,319],[474,252],[474,175],[570,170],[688,253],[727,403],[727,472],[572,483],[496,447],[473,400],[449,377]]},
    ]},
    back:{w:565,h:688,parts:[
      {name:'wing',side:-1,pivot:[243,344],poly:[[256,322],[222,319],[199,310],[181,291],[169,259],[157,240],[131,238],[97,257],[54,293],[20,337],[-10,394],[-10,463],[13,444],[23,428],[38,418],[57,420],[75,436],[96,475],[115,447],[133,428],[146,420],[167,420],[189,438],[207,432],[219,414],[238,405],[252,405],[263,382]]},
      {name:'wing',side:1,pivot:[335,344],poly:[[321,321],[357,319],[386,309],[404,283],[415,251],[429,237],[450,240],[480,258],[517,287],[546,319],[575,358],[576,429],[550,423],[532,420],[508,435],[487,459],[477,485],[459,455],[447,438],[427,423],[404,418],[386,418],[367,431],[344,431],[331,410],[319,388]]}
    ]},
    crew:{w:951,h:746,parts:[
      {name:'wing',side:-1,pivot:[309,328],poly:[[0,120],[36,86],[85,80],[145,80],[196,82],[235,89],[260,98],[269,146],[273,211],[275,257],[294,292],[308,318],[325,345],[312,350],[288,333],[272,313],[249,302],[225,299],[212,311],[207,277],[192,251],[173,243],[149,247],[139,256],[125,222],[110,198],[91,177],[71,159],[47,147],[20,140],[0,140]]},
      {name:'wing',side:1,pivot:[596,343],poly:[[573,319],[608,306],[629,273],[636,236],[638,177],[642,131],[665,107],[693,112],[702,122],[746,101],[797,90],[859,95],[921,116],[968,144],[968,174],[925,164],[902,166],[878,179],[854,201],[852,237],[856,269],[875,318],[831,329],[812,294],[791,291],[769,296],[749,315],[735,346],[731,380],[709,365],[684,354],[661,356],[639,366],[618,385],[597,389]]},
    ]},
    breath:{w:783,h:730,parts:[
      {name:'wing',side:1,pivot:[466,335],poly:[[449,305],[477,271],[480,223],[481,174],[488,146],[511,137],[550,143],[600,164],[652,200],[699,242],[731,289],[744,340],[703,321],[679,310],[658,311],[645,327],[650,389],[622,370],[598,358],[570,354],[550,363],[532,394],[510,366],[486,359],[467,350],[445,344]]}
    ]}
  };
  Game.prototype._wickPresencePose = function(mode,work) {
    if(RM)return{wing:0};
    var quiet=Math.sin(this.worldT*1.9)*.013,wing=quiet;
    if(mode==='crew'){
      // A quicker downstroke and softer recovery repeat for the whole crew
      // assignment. Neither a shot timeout nor an idle support post can stop
      // the wings. Fixed-step world time naturally honors pause and speed.
      var phase=this.worldT*2.2*Math.PI*2;
      wing=.22*Math.sin(phase)+.035*Math.sin(phase*2);
      return{wing:wing};
    }
    if(mode==='walk')wing+=Math.sin(this.worldT*5.4)*.070;
    else if(mode==='attack'){
      var attack=Math.max(clamp((this._breathT||0)/BREATH_BEAT,0,1),clamp((this._spitT||0)/SPIT_BEAT,0,1));
      wing+=Math.sin(attack*Math.PI)*.075;
    }else if(mode!=='idle' && mode!=='ready')wing+=(work||0)*.28;
    return{wing:wing};
  };
  Game.prototype._wickPresenceParts = function(img,kind) {
    var spec=WICK_PRESENCE[kind];if(!spec)return null;
    if(!this._wickPresenceCache)this._wickPresenceCache=new WeakMap();
    var found=this._wickPresenceCache.get(img);if(found)return found;
    var w=img.width,h=img.height;
    function layer(){var c=document.createElement('canvas');c.width=w;c.height=h;return c;}
    function path(c,poly){c.beginPath();poly.forEach(function(p,i){var x=p[0]/spec.w*w,y=p[1]/spec.h*h;if(i)c.lineTo(x,y);else c.moveTo(x,y);});c.closePath();}
    var body=layer(),bc=body.getContext('2d');bc.drawImage(img,0,0);
    var parts=spec.parts.map(function(s){
      // Include the outer ink edge as well as the membrane. Cutting on the
      // traced edge left a stationary hairline beside each flexing wing.
      var mask=layer(),mc=mask.getContext('2d');path(mc,s.poly);mc.fill();
      mc.lineJoin='round';mc.lineWidth=12/spec.w*w;mc.stroke();
      var c=layer(),cx=c.getContext('2d');cx.drawImage(img,0,0);
      cx.globalCompositeOperation='destination-in';cx.drawImage(mask,0,0);cx.globalCompositeOperation='source-over';
      bc.save();bc.globalCompositeOperation='destination-out';bc.drawImage(mask,0,0);bc.restore();
      // The root skin remains rigid and covers the small rotating overlap.
      bc.save();bc.beginPath();bc.ellipse(s.pivot[0]/spec.w*w,s.pivot[1]/spec.h*h,20/spec.w*w,25/spec.h*h,0,0,6.283);bc.clip();bc.drawImage(img,0,0);bc.restore();
      return{image:c,pivot:s.pivot,side:s.side,name:s.name};
    });
    // From behind the two membranes meet across the shoulder band. Keep the
    // neck/spine on the torso so flexing those roots cannot open a chest seam.
    if(kind==='back'){
      bc.save();bc.beginPath();bc.rect(224/spec.w*w,265/spec.h*h,126/spec.w*w,185/spec.h*h);
      bc.rect(150/spec.w*w,0,278/spec.w*w,265/spec.h*h);bc.clip();bc.drawImage(img,0,0);bc.restore();
    }
    found={body:body,parts:parts,w:spec.w,h:spec.h};this._wickPresenceCache.set(img,found);return found;
  };
  Game.prototype._drawWickPresence = function(ctx,presence,hh,hw,pose) {
    if(!presence)return;
    for(var i=0;i<presence.parts.length;i++){
      var p=presence.parts[i],x=(p.pivot[0]/presence.w-.5)*hw,y=(p.pivot[1]/presence.h-1)*hh;
      ctx.save();ctx.translate(x,y);ctx.rotate(p.side*(pose[p.name]||0));ctx.translate(-x,-y);
      ctx.drawImage(p.image,-hw/2,-hh,hw,hh);ctx.restore();
    }
  };

  // ===== Wick's crew rig — painted limbs, fixed body, real work ==========
  // All joints are registered to hero_man.png. The old up/down images changed
  // the body and wrench as well as the wings; cycling them morphed Wick. These
  // cached cut-outs articulate one painting without stretching his silhouette.
  var CREW_JOINTS = {
    wrench: [[114,195],[170,190],[199,233],[192,277],[196,320],[236,331],[271,350],[300,350],[345,317],[359,365],[341,404],[316,431],[270,445],[235,445],[244,492],[278,527],[284,568],[260,594],[232,594],[217,570],[202,583],[173,552],[175,519],[191,497],[175,452],[148,436],[137,413],[146,393],[132,378],[128,354],[148,332],[129,288],[109,276],[89,260],[85,232],[96,205]],
    hand: [[487,358],[547,362],[586,390],[609,437],[602,465],[568,476],[532,486],[499,494],[465,484],[445,452],[452,419],[477,403],[480,384]],
  };
  Game.prototype._crewPartsFor = function (img) {
    if (!img || !img.width) return null;
    if (!this._crewParts) this._crewParts = new WeakMap();
    var cached = this._crewParts.get(img); if (cached) return cached;
    var scale = Math.min(1, 512 / img.width), w = Math.round(img.width * scale), h = Math.round(img.height * scale);
    function layer() { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
    function mask(c, points) {
      c.beginPath();
      for (var i = 0; i < points.length; i++) {
        var x = points[i][0] / 951 * w, y = points[i][1] / 746 * h;
        if (i) c.lineTo(x, y); else c.moveTo(x, y);
      }
      c.closePath();
    }
    var body = layer(), b = body.getContext('2d'); b.drawImage(img, 0, 0, w, h);
    var out = { body: body };
    Object.keys(CREW_JOINTS).forEach(function (part) {
      var cv = layer(), c = cv.getContext('2d'); c.save(); mask(c, CREW_JOINTS[part]); c.clip(); c.drawImage(img, 0, 0, w, h); c.restore();
      b.save(); b.globalCompositeOperation = 'destination-out'; mask(b, CREW_JOINTS[part]); b.fill(); b.restore(); out[part] = cv;
    });
    out.presence=this._wickPresenceParts(body,'crew');if(out.presence)out.body=out.presence.body;
    this._crewParts.set(img, out); return out;
  };
  Game.prototype._crewPose = function (tw) {
    if (!tw || this._mannedTid(tw.own) !== tw.tid || (!(tw.own | 0) && this.hero.downT > 0)) return null;
    var time = RM ? 0 : this.worldT, mode = 'ready', work = 0, pulse = 0;
    if (tw.jamT > 0) {
      // Crewing REALLY clears jams five times faster. This is a repair stroke,
      // never a firing/recoil beat on a silenced machine.
      mode = 'repair'; work = RM ? 0 : Math.sin(time * 7) * 0.18;
    } else if (tw.type === 'bellows') {
      var range = lvlRow(tw).range;
      var feeds = this.towers.some(function (other) {
        var dx = other.x - tw.x, dy = other.y - tw.y;
        return !TOWER_TYPES[other.type].support && this._sameSide(other.own, tw.own) && dx * dx + dy * dy <= range * range;
      }, this);
      if (this.waveActive && feeds) { mode = 'pump'; work = RM ? 0 : Math.sin(time * 5.5) * 0.22; }
    } else if (tw.type === 'press') {
      if (this.waveActive) { mode = 'press'; work = RM ? 0 : Math.sin(time * 4) * 0.24; }
    } else {
      var since = tw.shotT === undefined ? 9 : tw.shotT;
      if (since >= 0 && since < 0.52) {
        mode = 'shot'; pulse = 1 - since / 0.52;
        work = RM ? 0 : Math.sin(since / 0.52 * Math.PI) * 0.32;
      }
    }
    return { mode: mode, work: work, pulse: pulse, moving: !RM && mode !== 'ready',
      wrench: work, hand: -work * 0.65, time: time };
  };
  // Crew hardware is registered to the same painted contacts as the limbs.
  // It never moves Wick or his mouth: only the grip follows the hand's joint.
  Game.prototype._crewHardware = function(anchor,pose) {
    var hh=HERO_H*anchor.s,hw=hh*HERO_MAN_ASPECT;
    function point(x,y){return{x:(x/951-.5)*hw,y:(y/746-1)*hh};}
    var near=point(555,730),far=point(330,663),socket=point(223,548);
    var shoulder=point(550,380),rest=point(499,485),angle=pose.hand || 0;
    var dx=rest.x-shoulder.x,dy=rest.y-shoulder.y,co=Math.cos(angle),si=Math.sin(angle);
    return{near:near,far:far,socket:socket,shoulder:shoulder,
      grip:{x:shoulder.x+dx*co-dy*si,y:shoulder.y+dx*si+dy*co},
      lever:{x:rest.x,y:rest.y+8},
      board:anchor.tw && (anchor.tw.type==='perch' || anchor.tw.type==='rotor')};
  };
  // A narrow oak tread in a brass shoe replaces the two isolated boot ticks on
  // the tall side mounts. Its sloped top passes through both painted feet.
  // The filled front edge supplies depth; the tiny grain/rivets match the
  // existing workshop's wood-and-metal finish without adding a broad panel.
  Game.prototype._drawCrewFootboard = function(ctx,hardware) {
    var f=hardware.far,n=hardware.near;
    var p=[{x:f.x-5,y:f.y-1.1},{x:n.x+4,y:n.y-1.1},{x:n.x+4.6,y:n.y+2},{x:f.x-4.4,y:f.y+2}];
    function face(points,fill){ctx.fillStyle=fill;ctx.beginPath();points.forEach(function(v,i){if(i)ctx.lineTo(v.x,v.y);else ctx.moveTo(v.x,v.y);});ctx.closePath();ctx.fill();ctx.stroke();}
    ctx.save();ctx.lineJoin='round';ctx.lineWidth=.8;ctx.strokeStyle='#30251b';
    face([p[3],p[2],{x:p[2].x,y:p[2].y+2.1},{x:p[3].x,y:p[3].y+2.1}],'#55402a');
    var wood=ctx.createLinearGradient(p[0].x,p[0].y,p[2].x,p[2].y);wood.addColorStop(0,'#a57d48');wood.addColorStop(.55,'#80603a');wood.addColorStop(1,'#b18a51');
    face(p,wood);ctx.strokeStyle='#d2af6e';ctx.lineWidth=.65;ctx.beginPath();ctx.moveTo(p[3].x,p[3].y);ctx.lineTo(p[2].x,p[2].y);ctx.stroke();
    ctx.strokeStyle='#59412a';ctx.lineWidth=.5;
    for(var i=0;i<2;i++){var t=.35+i*.3;ctx.beginPath();ctx.moveTo(p[0].x+2,p[0].y+(p[3].y-p[0].y)*t);ctx.lineTo(p[1].x-2,p[1].y+(p[2].y-p[1].y)*t);ctx.stroke();}
    // End shoes tie the tread into the bracket rather than floating as wood.
    for(var j=0;j<2;j++){
      var a=j?p[1]:p[0],b=j?p[2]:p[3],inset=j?-1.7:1.7;
      ctx.strokeStyle='#b69a64';ctx.lineWidth=1.4;ctx.beginPath();ctx.moveTo(a.x+inset,a.y+.15);ctx.lineTo(b.x+inset,b.y+1.4);ctx.stroke();
      ctx.fillStyle='#322820';ctx.beginPath();ctx.arc(b.x+inset,b.y+.6,.65,0,6.283);ctx.fill();
      ctx.fillStyle='#e1c184';ctx.beginPath();ctx.arc(b.x+inset-.15,b.y+.35,.28,0,6.283);ctx.fill();
    }
    ctx.restore();
  };
  Game.prototype._drawCrewMount = function (ctx, tw) {
    var pose=this._crewPose(tw);if(!pose)return;
    var a=this._wickAnchor(tw.x,tw.y,tw.tid),hardware=this._crewHardware(a,pose);
    var flip=(TOWER_TYPES[tw.type].mount || {dx:0}).dx>=0?1:-1;
    var oy=a.y+5-a.lift,mx=(tw.x-a.x)*flip,my=tw.y-oy-Math.min(22,a.lift*.5);
    ctx.save();ctx.translate(a.x,oy);ctx.scale(flip,1);ctx.lineCap='round';ctx.lineJoin='round';
    function stay(x,y,board){
      // A short turned-down outer shoe and a dark brass stay carry the tread.
      // The inner fixing is drawn first so the real chassis occludes it.
      ctx.beginPath();ctx.moveTo(mx,my);if(board)ctx.lineTo(x,y+5);ctx.lineTo(x,y);
      ctx.strokeStyle='#2b2119';ctx.lineWidth=board?3:2.1;ctx.stroke();
      ctx.strokeStyle='#88704a';ctx.lineWidth=board?1.7:.9;ctx.stroke();
      ctx.strokeStyle='#b99b63';ctx.lineWidth=.45;ctx.stroke();
    }
    stay(hardware.near.x,hardware.near.y+1,hardware.board);
    stay(hardware.far.x,hardware.far.y+1,hardware.board);
    stay(hardware.socket.x,hardware.socket.y,false);
    stay(hardware.lever.x,hardware.lever.y+2,false);
    ctx.restore();
  };
  Game.prototype._drawCrewWick = function (ctx, anchor, side) {
    var tw = anchor.tw, pose = this._crewPose(tw);
    if (!tw || !pose || !ART.images.hero_man) return false;
    var img = side ? this._rivalPlate(ART.images.hero_man, this.rival.coat || 'amethyst') : this._myPlate(ART.images.hero_man);
    var parts = this._crewPartsFor(img); if (!parts) return false;
    var hh = HERO_H * anchor.s, hw = hh * HERO_MAN_ASPECT;
    var flip = (TOWER_TYPES[tw.type].mount || { dx: 0 }).dx >= 0 ? 1 : -1;
    var originY = anchor.y + 5 - anchor.lift;
    var hardware = this._crewHardware(anchor,pose);
    ctx.save(); ctx.translate(anchor.x, originY); ctx.scale(flip, 1);
    // Native painted coordinates, in world units, with the feet at the origin.
    function px(x) { return (x / 951 - 0.5) * hw; }
    function py(y) { return (y / 746 - 1) * hh; }
    var socketX = px(223), socketY = py(548);
    // A real attachment, not a second ring: the small brass bracket joins the
    // wrench socket and two boot ledges to this machine's chassis.
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    function strut(x1, y1, x2, y2) {
      ctx.strokeStyle = '#281f1c'; ctx.lineWidth = 2.1;
      ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
      ctx.strokeStyle = '#8d806a'; ctx.lineWidth = 0.9;
      ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
    }
    if(hardware.board)this._drawCrewFootboard(ctx,hardware);
    else{
      strut(px(555)-4,py(730),px(555)+4,py(730));
      strut(px(330)-3,py(663),px(330)+3,py(663));
    }
    strut(socketX, socketY+4, socketX, socketY);
    ctx.fillStyle = '#987e50'; ctx.strokeStyle = '#3b281d'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(socketX,socketY,3,0,6.283); ctx.fill(); ctx.stroke();
    ctx.strokeStyle = '#f0c987'; ctx.lineWidth = 1;
    ctx.beginPath();ctx.moveTo(socketX-1,socketY-1);ctx.lineTo(socketX+1,socketY+1);ctx.stroke();
    function limb(plate, jointX, jointY, angle) {
      var jx=px(jointX), jy=py(jointY);
      ctx.save();ctx.translate(jx,jy);ctx.rotate(angle);ctx.translate(-jx,-jy);
      ctx.drawImage(plate,-hw/2,-hh,hw,hh);ctx.restore();
    }
    // Far tool arm sits behind the torso at its shoulder. Its socket stays
    // fixed while the wrench turns; the free hand works the close control.
    this._drawWickPresence(ctx,parts.presence,hh,hw,this._wickPresencePose('crew',pose.work));
    limb(parts.wrench,223,548,pose.wrench);
    ctx.drawImage(parts.body,-hw/2,-hh,hw,hh);
    // The lever meets the painted lower fingers, transformed through the same
    // shoulder rotation as the hand. Its pivot is fixed to the chassis; the
    // former handY+7 decoration left a visible gap below the grip.
    var lever=hardware.lever,grip=hardware.grip;
    ctx.fillStyle='#725934';ctx.strokeStyle='#31241b';ctx.lineWidth=.85;
    ctx.beginPath();ctx.moveTo(lever.x-3,lever.y+1);ctx.lineTo(lever.x+2.5,lever.y-.5);ctx.lineTo(lever.x+3,lever.y+2.5);ctx.lineTo(lever.x-2.5,lever.y+3.5);ctx.closePath();ctx.fill();ctx.stroke();
    strut(lever.x,lever.y+1,grip.x,grip.y+.4);
    ctx.fillStyle='#c2a16a';ctx.beginPath();ctx.arc(lever.x,lever.y+1,1.15,0,6.283);ctx.fill();
    ctx.strokeStyle='#d7b775';ctx.lineWidth=1.8;ctx.beginPath();ctx.moveTo(grip.x-2,grip.y+.1);ctx.lineTo(grip.x+2,grip.y+.1);ctx.stroke();
    limb(parts.hand,550,380,pose.hand);
    // Work lamps are attached to the socket. They name actual output/repair
    // without covering Wick, and reduce-motion retains the steady state.
    var lamp = pose.mode === 'repair' ? '#ec8667' : pose.mode === 'ready' ? '#756148' : '#d9b579';
    ctx.fillStyle=lamp;ctx.beginPath();ctx.arc(socketX,socketY,1.15,0,6.283);ctx.fill();
    ctx.restore();
    return true;
  };

  // ===== Wick on foot — planted painting, articulated steps ===============
  // Exposed boots, tool arm and wing membranes have local joints. The chest
  // and head stay registered: rotating/scaling their plate shifts the mouth
  // away from _muzzle() and makes a standing dragon look airborne.
  var FOOT_JOINTS = {
    front: { w: 783, h: 730, parts: [
      { name: 'far', joint: [277,601], seam: 622, poly: [[198,591],[269,575],[318,603],[321,653],[301,675],[247,689],[209,686],[169,673],[171,650],[196,628]] },
      { name: 'near', joint: [402,621], seam: 650, poly: [[347,613],[402,598],[453,610],[465,670],[459,704],[433,725],[405,729],[372,724],[334,710],[333,686],[348,653]] },
      { name: 'tool', joint: [211,441], poly: [[60,303],[97,290],[127,293],[154,316],[167,344],[157,378],[171,412],[196,416],[224,399],[231,469],[208,483],[184,490],[183,513],[202,562],[197,585],[180,592],[164,579],[154,551],[137,548],[115,517],[100,510],[88,494],[86,471],[95,451],[89,427],[76,410],[56,384],[49,354]] },
    ] },
    back: { w: 565, h: 688, parts: [
      // The far foot is behind his painted tail. Moving that whole silhouette
      // to invent another leg would split it; one visible boot takes the step.
      { name: 'near', joint: [368,608], seam: 638, poly: [[331,611],[356,582],[394,584],[414,625],[447,641],[461,662],[443,676],[406,681],[331,680],[327,654]] },
    ] },
    breath: { w: 783, h: 730, parts: [
      { name: 'tool', joint: [195,449], poly: [[19,389],[51,369],[91,370],[116,397],[124,425],[154,439],[185,422],[214,431],[215,476],[181,508],[157,518],[175,557],[189,600],[175,623],[153,630],[122,603],[104,583],[82,565],[72,549],[46,544],[27,516],[17,484],[9,442],[8,410]] },
    ] },
  };
  Game.prototype._footPose = function () {
    var h = this.hero;
    if (h.manned || h.downT > 0) return null;
    var dx = h.tx - h.x, dy = h.ty - h.y, distance = Math.sqrt(dx * dx + dy * dy);
    var moving = distance > 3;
    var attack = Math.max(Math.min(1, (this._breathT || 0) / BREATH_BEAT),
                          Math.min(1, (this._spitT || 0) / SPIT_BEAT));
    var stride = moving && !RM ? Math.min(1, distance / 12) : 0;
    var phase = RM ? 0 : this.worldT * 10.8, step = Math.sin(phase);
    return { mode: attack > 0 ? 'attack' : moving ? 'walk' : 'idle', moving: moving,
      back: moving && dy < -Math.abs(dx) * 0.7,
      // One boot swings while the other bears weight; their lifts never
      // coincide. No body bob, bank, scale or simulated position is involved.
      far: step * 0.24 * stride, near: -step * 0.24 * stride,
      farLift: Math.max(0, Math.cos(phase)) * 0.85 * stride,
      nearLift: Math.max(0, -Math.cos(phase)) * 0.85 * stride,
      tool: RM ? 0 : attack > 0 ? Math.sin(attack * Math.PI) * -0.12 : -step * 0.075 * stride };
  };
  Game.prototype._footPartsFor = function (img, kind) {
    var rig = FOOT_JOINTS[kind];
    if (!rig || !img || !img.width) return null;
    if (!this._footParts) this._footParts = new WeakMap();
    var cached = this._footParts.get(img); if (cached) return cached;
    var scale = Math.min(1, 512 / img.width), w = Math.round(img.width * scale), h = Math.round(img.height * scale);
    function layer() { var cv = document.createElement('canvas'); cv.width = w; cv.height = h; return cv; }
    function mask(c, points) {
      c.beginPath();
      for (var i = 0; i < points.length; i++) {
        var x = points[i][0] / rig.w * w, y = points[i][1] / rig.h * h;
        if (i) c.lineTo(x,y); else c.moveTo(x,y);
      }
      c.closePath();
    }
    var body = layer(), b = body.getContext('2d'); b.drawImage(img,0,0,w,h);
    var out = { body: body, rig: rig };
    rig.parts.forEach(function (part) {
      var cv = layer(), c = cv.getContext('2d'); c.save(); mask(c,part.poly); c.clip(); c.drawImage(img,0,0,w,h); c.restore(); out[part.name] = cv;
      b.save(); b.globalCompositeOperation = 'destination-out';
      // Leave the upper calf painted over each moving boot. This overlap is
      // the joint, so a lifted toe never opens a transparent ankle seam.
      if (part.seam) { b.beginPath(); b.rect(0,part.seam / rig.h * h,w,h); b.clip(); }
      mask(b,part.poly); b.fill(); b.restore();
    });
    out.presence=this._wickPresenceParts(body,kind);if(out.presence)out.body=out.presence.body;
    this._footParts.set(img,out); return out;
  };
  Game.prototype._drawFootWick = function (ctx, img, kind, hh, hw, pose) {
    if (!pose || RM) return false;
    var parts = this._footPartsFor(img,kind); if (!parts) return false;
    var rig = parts.rig;
    this._drawWickPresence(ctx,parts.presence,hh,hw,this._wickPresencePose(pose.mode,0));
    for (var i = 0; i < rig.parts.length; i++) {
      var part = rig.parts[i], jx = (part.joint[0] / rig.w - 0.5) * hw, jy = (part.joint[1] / rig.h - 1) * hh;
      ctx.save(); ctx.translate(jx,jy - (pose[part.name + 'Lift'] || 0));
      ctx.rotate(pose[part.name] || 0); ctx.translate(-jx,-jy);
      ctx.drawImage(parts[part.name],-hw/2,-hh,hw,hh); ctx.restore();
    }
    ctx.drawImage(parts.body,-hw/2,-hh,hw,hh);
    return true;
  };

  Game.prototype._drawHero = function (ctx) {
    var h = this.hero;
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
    // A steady ground shadow keeps the stationary body planted; only the
    // exposed boots lift a little during a step.
    if (!h.manned) {
      groundShadow(ctx, h.x, h.y, 44 * depthScale(h.y), 0, 1);
    }
    var hdx2 = h.tx - h.x, hdy2 = h.ty - h.y;
    var hMoving2 = Math.abs(hdx2) + Math.abs(hdy2) > 3;
    var goingAway = hMoving2 && hdy2 < -Math.abs(hdx2) * 0.7;   // mostly up-screen
    // Crewing uses one registered painting and articulated limbs. A missing
    // manning image falls back to his normal plate, never an invisible dragon.
    var himg;
    if (h.manned && ART.images.hero_man) {
      himg = ART.images.hero_man;
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
    // THE PLAYER'S COAT. One intercept below the whole plate-selection chain,
    // so the idle, back, breath and all three manning frames are coated by the
    // same call and can never drift to different colours mid-animation.
    // POSE IS DECIDED ABOVE; THE COAT IS APPLIED HERE. _myPlate returns a
    // recoloured <canvas> for any non-stock coat, and 80 lines below there is an
    // OBJECT-IDENTITY test -- `himg === ART.images.hero_breathe` -- that picks
    // the open-muzzle anchor for the fire. Coating first made that test false on
    // every coated frame, so a player in any colour but stock Ember breathed
    // from the CLOSED-muzzle point: the jaw glow and all five fire tongues
    // anchored at MUZZLE_FWD/MUZZLE_UP while the sprite drawn was the open jaw.
    // Take the identity while himg still IS an ART image.
    var breathPose = himg === ART.images.hero_breathe;
    var footKind = breathPose ? 'breath' : himg === ART.images.hero_back ? 'back' : 'front';
    himg = this._myPlate(himg);
    var crewDrawn = mtw && this._drawCrewWick(ctx, anc, 0);
    if (himg) {
      // The painted body and open jaw share one rigid ground registration.
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
      var footPose = this._footPose();
      var hh0 = HERO_H * manS, hw0 = hh0 * (himg.width / himg.height);
      // the sprite is drawn facing LEFT natively, so world-facing is -hflip.
      // _muzzle() reads this to put the breath where his mouth is.
      this._heroFace = -hflip;
      // The attack painting already braces and opens its jaw. Recoil belongs
      // in the tool arm, not a transform that floats both boots and the muzzle.
      var b = Math.max(0, (this._breathT || 0) / BREATH_BEAT);
      ctx.save();
      ctx.translate(manX, manY + 5 - lift);
      ctx.scale(hflip, 1);
      if (!crewDrawn && (mnt || !this._drawFootWick(ctx,himg,footKind,hh0,hw0,footPose))) {
        ctx.drawImage(himg, -hw0 / 2, -hh0, hw0, hh0);
      }
      // THE MOUTH OPENS. The painted plate has a closed muzzle and there is no
      // open-mouthed variant, so the jaw is drawn: a dark throat wedge at the
      // snout with a hot core, scaled by the same eased kick. It sits inside
      // the sprite's own transform, so the mirror puts it on whichever side he
      // is facing and it can never drift off his face.
      if (b > 0.01) {
        var onBreathPlate = breathPose;   // taken before the coat swap -- see above
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
    else if (!crewDrawn) {
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
      var bob = 0; // missing art must still leave a planted dragon
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
      var healthX = anc.x, healthY = mtw ? anc.y + 5 - anc.lift - HERO_H * anc.s - 6 : h.y - 50;
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(healthX - 16, healthY, 32, 4);
      ctx.fillStyle = hpf > 0.5 ? '#9ef58f' : hpf > 0.25 ? '#ffd75e' : '#ff5b5b';
      ctx.fillRect(healthX - 16, healthY, 32 * hpf, 4);
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

  // Local release and body contact share one short visual beat. No broad
  // target webs: only the single-target Mimic has a connecting snap.
  Game.prototype._drawMachineAttack = function (ctx, pa) {
    var t = RM ? 0 : 1 - Math.max(0, pa.life / pa.T);
    var alpha = RM ? .65 : Math.min(1, pa.life / .07), s = pa.s;
    var points = pa.contacts || [];
    ctx.save(); ctx.globalAlpha *= alpha; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    if (pa.attack === 'bite' && points.length) {
      var dx = points[0].x - pa.x, dy = points[0].y - pa.y;
      var reach = Math.sqrt(dx * dx + dy * dy);
      var retract = t < .34 ? 1 : Math.max(0, (1 - t) / .66);
      var end = reach * retract, gap = 1 - .65 * Math.min(1, t / .30);
      ctx.translate(pa.x, pa.y); ctx.rotate(Math.atan2(dy, dx));
      // A narrow spring linkage, extended on the hit and withdrawn into the maw.
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(end, 0);
      ctx.strokeStyle = '#473421'; ctx.lineWidth = 3; ctx.stroke();
      ctx.strokeStyle = '#c8a060'; ctx.lineWidth = 1.25; ctx.stroke();
      ctx.strokeStyle = '#f0d5a0'; ctx.lineWidth = 1;
      ctx.beginPath();
      for (var link = 1; link < 4; link++) {
        var lx = end * link / 4; ctx.moveTo(lx - 1, -1.2); ctx.lineTo(lx + 1, 1.2);
      }
      ctx.stroke();
      // Closing steel jaw marks meet on the victim's body in the first frame.
      ctx.translate(end, 0); ctx.strokeStyle = '#e6d2a7'; ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-5, -6 * gap); ctx.lineTo(2, -3 * gap); ctx.lineTo(5, -gap);
      ctx.moveTo(-5, 6 * gap); ctx.lineTo(2, 3 * gap); ctx.lineTo(5, gap); ctx.stroke();
    } else if (pa.attack === 'blade') {
      // Short arcs live in the rotor plane, not at its foundation.
      var sweep = t * 1.6;
      ctx.strokeStyle = '#dce9e7'; ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.ellipse(pa.x, pa.y, (23 + t * 3) * s, (9 + t) * s, 0, sweep + .1, sweep + 1.3);
      ctx.ellipse(pa.x, pa.y, (23 + t * 3) * s, (9 + t) * s, 0, sweep + 3.24, sweep + 4.44);
      ctx.stroke();
      ctx.strokeStyle = '#e9efde'; ctx.lineWidth = 1.5; ctx.beginPath();
      for (var i = 0; i < points.length; i++) {
        var cp = points[i], an = Math.atan2(cp.y - pa.y, cp.x - pa.x) + .55;
        var ca = Math.cos(an), sa = Math.sin(an), r = 6 + t * 2;
        ctx.moveTo(cp.x - ca * r - sa * 2, cp.y - sa * r + ca * 2);
        ctx.quadraticCurveTo(cp.x, cp.y, cp.x + ca * r + sa * 2, cp.y + sa * r - ca * 2);
        ctx.moveTo(cp.x - ca * 3 + sa * 3, cp.y - sa * 3 - ca * 3);
        ctx.lineTo(cp.x + ca * 4 + sa * 3, cp.y + sa * 4 - ca * 3);
      }
      ctx.stroke();
    } else if (pa.attack === 'chill') {
      // A clear core resonance and compact frost contacts identify every victim.
      var cr = (6 + t * 3) * s;
      ctx.strokeStyle = '#bef6f3'; ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y - cr); ctx.lineTo(pa.x + cr * .65, pa.y);
      ctx.lineTo(pa.x, pa.y + cr); ctx.lineTo(pa.x - cr * .65, pa.y); ctx.closePath(); ctx.stroke();
      ctx.strokeStyle = '#abdfeb'; ctx.lineWidth = 1.25; ctx.beginPath();
      for (var c = 0; c < points.length; c++) {
        var fp = points[c], fr = 5 + t;
        for (var spoke = 0; spoke < 3; spoke++) {
          var a = spoke * 1.0472 + .35, cx = Math.cos(a) * fr, cy = Math.sin(a) * fr;
          ctx.moveTo(fp.x - cx, fp.y - cy); ctx.lineTo(fp.x + cx, fp.y + cy);
        }
      }
      ctx.stroke();
    }
    ctx.restore();
  };

  Game.prototype._drawParticles = function (ctx) {
    for (var i = 0; i < this.particles.length; i++) {
      var pa = this.particles[i];
      var a = Math.max(0, pa.life / pa.T);
      if (pa.kind === 'machineAttack') {
        ctx.globalAlpha = 1;
        this._drawMachineAttack(ctx, pa);
      } else if (pa.kind === 'dot') {
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
    ctx.globalAlpha = 1;
  };

  // ===== Wave intelligence — read-only views of the real encounter ========
  // Forecasts read waveGroups, the SAME input buildWave uses. In a duel each
  // side receives that party, so the forecast is per side, never doubled.
  // Neither helper writes gameplay state, consumes a random draw, or caches a
  // board-dependent answer that could survive a build/sell/restore.
  Game.prototype._waveIntel = function (w) {
    w = w === undefined ? this.wave : Math.max(0, w | 0);
    var groups = w < this.totalWaves() ? (this.waveGroups(w) || []) : [];
    var counts = {}, order = [], total = 0;
    for (var i = 0; i < groups.length; i++) {
      var gr = groups[i];
      if (!Object.prototype.hasOwnProperty.call(ENEMY_TYPES, gr.type)) continue;
      if (!counts[gr.type]) { counts[gr.type] = 0; order.push(gr.type); }
      counts[gr.type] += gr.count; total += gr.count;
    }
    function trait(id) {
      var e = ENEMY_TYPES[id];
      if (e.summonAtHalf) return { label: 'BOSS', rank: 1000, color: '#ffb799' };
      if (e.flyer) return { label: 'AIR', rank: 900, color: '#b9ddff' };
      if (e.heals) return { label: 'HEAL', rank: 800, color: '#c3ecb2' };
      if (e.sapR) return { label: 'JAM', rank: 700, color: '#ffc78e' };
      if (e.blink) return { label: 'BLINK', rank: 600, color: '#d6c0ff' };
      if (e.armor) return { label: 'ARMOR', rank: 500, color: '#cad4df' };
      if (e.pavise) return { label: 'SHIELD', rank: 450, color: '#cad4df' };
      if (e.splitInto) return { label: 'SPLIT', rank: 400, color: '#dbc2a5' };
      if (e.spd > ENEMY_TYPES.looter.spd * 1.5) return { label: 'FAST', rank: 200, color: '#ffd486' };
      return { label: 'GROUND', rank: 100, color: '#e9dac2' };
    }
    var roster = order.map(function (id, at) {
      var t = trait(id);
      return { type: id, name: ENEMY_TYPES[id].name, count: counts[id],
        role: t.label, priority: t.rank, color: t.color, order: at };
    }).sort(function (a, b) { return b.priority - a.priority || a.order - b.order; });
    var board = { weapons: 0, air: 0, airDamage: 0, chill: 0, splash: 0, aimed: 0 };
    for (var t = 0; t < this.towers.length; t++) {
      var tw = this.towers[t];
      if (!this._sameSide(tw.own, 0)) continue;
      var tt = TOWER_TYPES[tw.type];
      if (!tt || tt.support) continue;
      board.weapons++;
      if (tt.hitsAir) { board.air++; if (lvlRow(tw).dmg > 0) board.airDamage++; }
      if (tw.type === 'crystal') board.chill++;
      if (tw.type === 'brazier' || tw.type === 'rotor') board.splash++;
      if (tw.type !== 'crystal' && tw.type !== 'rotor') board.aimed++;
    }
    var shelf = this._shelf();
    function available(ids) {
      for (var j = 0; j < ids.length; j++) if (shelf.indexOf(ids[j]) >= 0) return ids[j];
      return null;
    }
    var advice = { key: 'ground', color: '#e9dac2', text: 'Scraplings have no armor. Crossbows are a cheap answer.', recommend: null };
    var choice;
    if (counts.boss) {
      advice = { key: 'boss', color: '#ffb799', text: 'The King steals ' + ENEMY_TYPES.boss.steals + ' coins. Slow him inside your strongest fire.', recommend: board.chill ? null : available(['crystal']) };
    } else if (counts.bat && !board.airDamage) {
      choice = available(['ballista', 'perch', 'rotor', 'crystal']);
      advice = { key: 'air-gap', color: '#b9ddff',
        text: choice ? 'Add a ' + TOWER_TYPES[choice].short.charAt(0) + TOWER_TYPES[choice].short.slice(1).toLowerCase() + ' for flyers. ' + (board.air ? 'Chill needs damage beside it.' : 'Ground-only machines miss.') : 'Flying raiders need an air-capable weapon.', recommend: choice };
    } else if (counts.warlock) {
      choice = available(['ballista', 'perch', 'mimic', 'brazier']);
      advice = { key: 'healer', color: '#c3ecb2', text: board.aimed ? 'Set a weapon to HEXER aim. Stop the healer before it mends the pack.' : 'Greed Hexers heal the pack. Add a weapon with HEXER aim.', recommend: board.aimed ? null : choice };
    } else if (counts.sapper) {
      advice = { key: 'jammer', color: '#ffc78e', text: 'Pry-Hands jam machines. Move Wick beside a jam to repair it faster.', recommend: null };
    } else if (counts.blinker) {
      advice = { key: 'blink', color: '#d6c0ff', text: board.chill ? 'Keep firepower beside your Gemsinger. Chilled Blinkers cannot teleport.' : 'A Gemsinger stops Blinkers teleporting while they are chilled.', recommend: board.chill ? null : available(['crystal']) };
    } else if (counts.brute) {
      advice = { key: 'armor', color: '#cad4df', text: 'Bulwarks block ' + ENEMY_TYPES.brute.armor + ' per hit. Upgrade damage; Gemsinger magic ignores armor.', recommend: board.chill ? null : available(['crystal']) };
    } else if (counts.shield) {
      choice = available(['brazier', 'crystal']);
      advice = { key: 'shield', color: '#cad4df', text: 'Shellback shields halve bolts. ' + (this.mods.breathOff ? 'Magic and splash get through.' : "Magic, splash and Wick's breath get through."), recommend: choice };
    } else if (counts.splitter) {
      advice = { key: 'split', color: '#dbc2a5', text: board.splash ? 'Hogsheads split on defeat. Keep their smaller raiders inside your area damage.' : 'Hogsheads split on defeat. Bring area damage to catch the smaller raiders.', recommend: board.splash ? null : available(['brazier', 'rotor']) };
    } else if (counts.bat) {
      advice = { key: 'air', color: '#b9ddff', text: 'Keep your air weapons covering the road. Ground-only machines miss flyers.', recommend: null };
    } else if (counts.scout) {
      advice = { key: 'fast', color: '#ffd486', text: 'Filchers are fast and take ' + ENEMY_TYPES.scout.steals + ' coins. Cover their return trip as well as the entrance.', recommend: null };
    } else if (!board.weapons) {
      choice = available(['ballista', 'mimic', 'crystal']);
      advice = { key: 'first-build', color: '#ffd486', text: 'Build a defender first. Stone pads cost ' + Math.round((1 - PAD_DISCOUNT) * 100) + '% less.', recommend: choice };
    }
    // A trial can ban Crossbows: even the uncomplicated-wave explanation must
    // not recommend a machine that is absent from that run's shelf.
    if (advice.key === 'ground' && shelf.indexOf('ballista') < 0) advice.text = 'Scraplings have no armor. Keep your damage covering both trips.';
    return { wave: w + 1, total: total, perSide: !!this.rivalSide, roster: roster,
      counts: counts, board: board, advice: advice,
      announcement: 'Wave ' + (w + 1) + ': ' + total + ' raiders' + (this.rivalSide ? ' per side' : '') + '. ' +
        roster.map(function (e) { return e.count + ' ' + e.name; }).join(', ') + '. ' + advice.text };
  };

  Game.prototype._battleIntel = function () {
    var onRoad = 0, incoming = 0, carriers = 0, coins = 0, inBreath = 0, jammed = 0;
    var h = this.hero;
    for (var i = 0; i < this.enemies.length; i++) {
      var e = this.enemies[i];
      if (e.hp <= 0 || !this._sameSide(e.ln, 0)) continue;
      onRoad++;
      if (e.fleeing && e.stolen > 0) { carriers++; coins += e.stolen; }
      var dx = e.px - h.x, dy = e.py - h.y;
      if (dx * dx + dy * dy <= h.range * h.range) inBreath++;
    }
    for (var s = 0; s < this.spawnQueue.length; s++) if (this._sameSide(this.spawnQueue[s].ln, 0)) incoming++;
    for (var t = 0; t < this.towers.length; t++) if (this._sameSide(this.towers[t].own, 0) && this.towers[t].jamT > 0) jammed++;
    var breathReady = h.downT <= 0 && h.breathCd <= 0 && !this.mods.breathOff;
    var label = onRoad + ' on the road' + (incoming ? '  ·  ' + incoming + ' incoming' : '  ·  last group');
    var detail = '', color = '#e9dac2', key = 'progress';
    if (coins > 0) {
      key = 'recover'; color = '#ffd486';
      label = coins + (coins === 1 ? ' COIN' : ' COINS') + ' CAN STILL BE SAVED';
      detail = 'Move Wick beside a fleeing carrier to shake coins loose.';
    } else if (jammed > 0) {
      key = 'jammed'; color = '#ffc78e';
      label = jammed + (jammed === 1 ? ' MACHINE JAMMED' : ' MACHINES JAMMED');
      detail = 'Move Wick beside a jam to repair it faster.';
    } else if (breathReady && inBreath >= 3) {
      key = 'breath'; color = '#ffcf98';
      label = inBreath + ' RAIDERS IN BREATH RANGE';
      detail = "Wick's breath is ready.";
    }
    return { active: this.waveActive, onRoad: onRoad, incoming: incoming,
      remaining: onRoad + incoming, carriers: carriers, coinsAtRisk: coins,
      jammed: jammed, inBreath: inBreath, breathReady: breathReady,
      key: key, label: label, detail: detail, color: color };
  };

  // An 88-unit scout card, drawn in the caller's coordinate system. Text is
  // clipped only at the supplied rectangle. Large late-Daily rosters become
  // three named roles + an exact remainder, rather than running off the phone.
  Game.prototype._drawWaveIntel = function (ctx, rect) {
    var intel = this._waveIntel(), x = rect.x, y = rect.y, w = rect.w, h = rect.h || 88;
    if (!intel.total) return null;
    ctx.save();
    uiPanel(ctx, x, y, w, h, 12);
    ctx.beginPath(); rr(ctx, x + 2, y + 2, w - 4, h - 4, 10); ctx.clip();
    ctx.fillStyle = intel.advice.color;
    ctx.fillRect(x + 1, y + 14, 3, h - 28);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left'; ctx.font = 'bold 12px system-ui, sans-serif'; ctx.fillStyle = '#d7c4a1';
    ctx.fillText('SCOUT REPORT · WAVE ' + intel.wave, x + 13, y + 18);
    ctx.textAlign = 'right'; ctx.font = 'bold 13px system-ui, sans-serif'; ctx.fillStyle = '#fff0cf';
    ctx.fillText(intel.total + (intel.perSide ? ' / SIDE' : ' RAIDERS'), x + w - 12, y + 18);
    var maxCells = Math.max(1, Math.min(4, Math.floor((w - 24) / 80)));
    var cells = intel.roster.slice(0, maxCells);
    if (intel.roster.length > maxCells) {
      cells = intel.roster.slice(0, maxCells - 1);
      var other = intel.roster.slice(maxCells - 1);
      cells.push({ type: null, count: other.reduce(function (n, e) { return n + e.count; }, 0),
        role: 'MORE', color: '#d7c4a1' });
    }
    var cw = (w - 24) / cells.length;
    ctx.textAlign = 'left';
    for (var c = 0; c < cells.length; c++) {
      var cell = cells[c], cx = x + 12 + c * cw;
      var img = cell.type && ART.images['e_' + cell.type];
      if (img) {
        var ih = Math.min(25, 22 * img.height / img.width), iw = ih * img.width / img.height;
        ctx.drawImage(img, cx + 1, y + 24, iw, ih);
      }
      ctx.fillStyle = cell.color; ctx.font = 'bold 12px system-ui, sans-serif';
      var cellText = cell.count + ' ' + cell.role;
      var cellMax = cw - (img ? 27 : 2);
      var namedText = cell.name ? cell.count + ' × ' + cell.name : '';
      if (cells.length <= 2 && namedText && ctx.measureText(namedText).width <= cellMax) cellText = namedText;
      if (ctx.measureText(cellText).width > cellMax) {
        var shortRole = { GROUND: 'GND', SHIELD: 'SHLD', ARMOR: 'ARM', BLINK: 'BLNK', SPLIT: 'SPLT' };
        cellText = cell.count + ' ' + (shortRole[cell.role] || cell.role);
      }
      ctx.fillText(cellText, cx + (img ? 26 : 1), y + 42);
    }
    // At most two readable advice lines. No font shrinking to force a long
    // paragraph into a phone-sized band; the authored cues fit this budget.
    ctx.font = '13px system-ui, sans-serif'; ctx.fillStyle = '#f1e6d2';
    var words = intel.advice.text.split(' '), lines = [], line = '';
    for (var wi = 0; wi < words.length; wi++) {
      var next = line ? line + ' ' + words[wi] : words[wi];
      if (line && ctx.measureText(next).width > w - 26) { lines.push(line); line = words[wi]; }
      else line = next;
    }
    if (line) lines.push(line);
    if (lines.length > 2) {
      lines[1] = lines.slice(1).join(' ');
      while (lines[1].length && ctx.measureText(lines[1] + '…').width > w - 26) lines[1] = lines[1].slice(0, -1);
      lines[1] += '…'; lines.length = 2;
    }
    for (var li = 0; li < lines.length; li++) ctx.fillText(lines[li], x + 13, y + 64 + li * 16);
    ctx.restore();
    return { intel: intel, cells: cells, lines: lines, rect: { x: x, y: y, w: w, h: h } };
  };

  // world-anchored hints only (the pad ring); everything else lives in the
  // view-anchored HUD so it hugs the REAL screen edges on every device
  // The displayed order is derived from the same destination the next fixed
  // step uses. Inspecting another machine never changes this order.
  Game.prototype._heroOrder = function () {
    var h=this.hero;
    if (this.isRival || (this.state!=='playing'&&this.state!=='paused') || h.downT>0 || h.manned) return null;
    var tw=h.manTid>=0?this._towerByTid(h.manTid):null;
    var x=tw?tw.x:h.tx, y=tw?tw.y-6:h.ty, dx=x-h.x, dy=y-h.y;
    if (!tw && dx*dx+dy*dy<=9) return null;
    return {kind:tw?'crew':'move',x:x,y:y,fromX:h.x,fromY:h.y,tid:tw?tw.tid:-1,
      label:tw?'Wick → '+TOWER_TYPES[tw.type].short:'',tower:tw};
  };
  Game.prototype._drawWorldHints = function (ctx) {
    var order=this._heroOrder(),u=1/this.view.scale;
    ctx.save();
    if(order){
      var a=this._uiAnchor({x:order.fromX,y:order.fromY}),b=this._uiAnchor(order);
      var dx=b.x-a.x,dy=b.y-a.y,d=Math.sqrt(dx*dx+dy*dy);
      if(d>18*u){
        ctx.strokeStyle='rgba(231,201,145,.34)';ctx.lineWidth=1.2*u;ctx.setLineDash([3*u,7*u]);
        ctx.beginPath();ctx.moveTo(a.x+dx/d*10*u,a.y+dy/d*10*u);ctx.lineTo(b.x,b.y);ctx.stroke();ctx.setLineDash([]);
      }
      // Corner marks, not another range ring. They disappear on arrival.
      ctx.strokeStyle='#eed19a';ctx.lineWidth=1.6*u;ctx.lineJoin='round';
      for(var i=0;i<4;i++){
        var sx=i%2?1:-1,sy=i<2?-1:1;
        ctx.beginPath();ctx.moveTo(b.x+sx*4*u,b.y+sy*6*u);ctx.lineTo(b.x+sx*9*u,b.y+sy*6*u);ctx.lineTo(b.x+sx*9*u,b.y+sy*2*u);ctx.stroke();
      }
      ctx.fillStyle='#eed19a';ctx.beginPath();ctx.arc(b.x,b.y,1.6*u,0,6.283);ctx.fill();
    }
    var hint=this.placeHint;
    if(this.shopPick>=0&&hint&&!hint.ok&&this.worldT-hint.at<.8){
      var p=this._uiAnchor(hint);ctx.strokeStyle='#efab94';ctx.lineWidth=2*u;
      ctx.beginPath();ctx.moveTo(p.x-5*u,p.y-5*u);ctx.lineTo(p.x+5*u,p.y+5*u);ctx.moveTo(p.x+5*u,p.y-5*u);ctx.lineTo(p.x-5*u,p.y+5*u);ctx.stroke();
    }
    ctx.restore();
  };
  Game.prototype._feedbackObstacles = function () {
    var v=this.view,H=this._hudGeom(),out=[];
    function add(x,y,w,h){out.push({x:x-v.ox,y:y-v.oy,w:w,h:h});}
    add(H.barX,H.topY,H.barW,H.barH);
    if(this.rival)add(H.barX,H.topY+H.barH+4,H.barW,26);
    if(this.trial)add(H.barX,H.topY+H.barH,H.barW,18);
    if(this.menu){var tw=this._machineMenuTower();if(tw)out=out.concat(this._machineMenuGeom(tw).panels);return out;}
    if(H.commandRow)add(H.commandRow.x,H.commandRow.y,H.commandRow.w,H.commandRow.h);
    // The corner action cards own their screen area whenever they are shown.
    if(this.shopPick<0){if(!this.mods.breathOff)add(H.breathRect.x,H.breathRect.y,H.breathRect.w,H.breathRect.h);add(H.startRect.x,H.startRect.y,H.startRect.w,H.startRect.h);}
    if(this.shopPick>=0)add(H.buildInfo.x,H.buildInfo.y,H.buildInfo.w,H.buildInfo.h);
    else if(this.shopOpen)add(H.barX,H.infoY,H.barW,88);
    else if(this._enemyIntroVisible())add(v.w/2-Math.min(v.w-24,372)/2,H.infoY,Math.min(v.w-24,372),58);
    return out;
  };
  Game.prototype._feedbackLayout = function (ctx) {
    if(this.isRival||(this.state!=='playing'&&this.state!=='paused'))return [];
    var v=this.view,u=1/v.scale,font=(v.cw<=340?11:12)*u,rows=[],groups=[],obstacles=this._feedbackObstacles();
    var left=-v.ox+10*u,right=-v.ox+v.w-10*u,top=-v.oy+(v.safeT||0)+8*u,bottom=-v.oy+v.h-(v.safeB||0)-10*u;
    ctx.save();ctx.font='650 '+font+'px system-ui, sans-serif';
    var order=this._heroOrder();
    if(order&&order.kind==='crew'){
      var tw=order.tower,img=ART.images['t_'+tw.type],w=54*(1+tw.level*.12),h=img?w*img.height/img.width:80;
      groups.push({x:tw.x,y:tw.y-h-16*u,txt:order.label,c:'#eac583',t:1,notice:true,count:1});
    }
    // Co-located repetitions share one label. This affects display only; the
    // original events and exact money transfers stay untouched.
    for(var i=this.floats.length-1;i>=0;i--){
      var fl=this.floats[i];if(fl.t<=0)continue;
      var same=null;
      for(var j=0;j<groups.length;j++)if(groups[j].txt===fl.txt&&Math.abs(groups[j].x-fl.x)<64&&Math.abs(groups[j].y-fl.y)<64){same=groups[j];break;}
      if(same){same.count++;same.t=Math.max(same.t,fl.t);continue;}
      groups.push({x:fl.x,y:fl.y,txt:fl.txt,c:fl.c,t:fl.t,notice:!!fl.notice,count:1});
    }
    groups.sort(function(a,b){return Number(b.notice)-Number(a.notice);});
    function overlaps(a,b){return a.x<b.x+b.w+3*u&&a.x+a.w+3*u>b.x&&a.y<b.y+b.h+3*u&&a.y+a.h+3*u>b.y;}
    for(var g=0;g<groups.length&&rows.length<8;g++){
      var item=groups[g],point=this._uiAnchor(item),text=item.txt+(item.count>1?' ×'+item.count:'');
      text=fitText(ctx,text,Math.min(292*u,right-left)-18*u);
      var w=Math.min(right-left,ctx.measureText(text).width+18*u),h=22*u;
      var x=clamp(point.x-w/2,left,right-w),y=clamp(point.y-h+5*u,top,bottom-h),found=null;
      for(var k=0;k<24&&!found;k++){
        var shift=k===0?0:Math.ceil(k/2)*(h+4*u)*(k%2?-1:1);
        var r={x:x,y:y+shift,w:w,h:h};if(r.y<top||r.y+r.h>bottom)continue;
        if(obstacles.some(function(o){return overlaps(r,o);})||rows.some(function(o){return overlaps(r,o);}))continue;
        found=r;
      }
      if(found){found.text=text;found.color=item.c;found.alpha=Math.min(1,item.t);found.notice=item.notice;found.font=font;rows.push(found);}
    }
    ctx.restore();return rows;
  };
  Game.prototype._drawFeedback = function (ctx) {
    var rows=this._feedbackLayout(ctx),u=1/this.view.scale;ctx.save();
    rows.forEach(function(r){
      ctx.globalAlpha=r.alpha;ctx.font='650 '+r.font+'px system-ui, sans-serif';ctx.textAlign='center';ctx.textBaseline='alphabetic';
      if(r.notice){
        ctx.fillStyle='rgba(29,25,24,.94)';rr(ctx,r.x,r.y,r.w,r.h,6*u);ctx.fill();
        ctx.strokeStyle='#806644';ctx.lineWidth=u;rr(ctx,r.x,r.y,r.w,r.h,6*u);ctx.stroke();
        ctx.fillStyle=r.color;ctx.fillRect(r.x+4*u,r.y+7*u,2*u,8*u);ctx.fillStyle='#f6e6ce';
      }else{ctx.strokeStyle='rgba(20,16,17,.95)';ctx.lineWidth=3*u;ctx.lineJoin='round';ctx.strokeText(r.text,r.x+r.w/2,r.y+15.5*u);ctx.fillStyle=r.color;}
      ctx.fillText(r.text,r.x+r.w/2,r.y+15.5*u);
    });ctx.restore();
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
  // Four readable cards per page. All input and assistive controls consume
  // these exact rectangles; paging never changes the absolute shelf index.
  function shopChip(n) {
    n = Math.max(1, Math.min(4, n | 0));
    var w = (WORLD_W - 24 - (n - 1) * 7) / n;
    return { w: w, step: w + 7 };
  }

  /// EVERY MACHINE, ALWAYS ON SCREEN (2026-09-14). VANUS: "i only see 3 and you
  /// have to click build machines first". Unlocked machines come first, then
  /// the locked ones by the stars they need, so the bar also shows what is
  /// coming. Trial bans leave the bar entirely: a ban is not a lock.
  Game.prototype._machineDock = function () {
    var shelf = this._shelf(), open = [], locked = [];
    for (var i = 0; i < TOWER_ORDER.length; i++) {
      var id = TOWER_ORDER[i];
      if (this.mods && this.mods.bannedTower === id) continue;
      var si = shelf.indexOf(id);
      if (si >= 0) open.push({ id: id, index: si, locked: false, stars: 0 });
      else locked.push({ id: id, index: -1, locked: true, stars: MACHINE_UNLOCK[id] || 0 });
    }
    locked.sort(function (x, y) { return x.stars - y.stars; });
    return open.concat(locked);
  };

  /// Does one of YOUR machines stand under this HUD card (view-space rect)?
  /// Draw lane only: reads positions, touches no stream.
  Game.prototype._cardOverMachine = function (r) {
    if (!r) return false;
    var v = this.view;
    for (var i = 0; i < this.towers.length; i++) {
      var tw = this.towers[i]; if (!this._sameSide(tw.own, 0)) continue;
      var x0 = tw.x - 27 + v.ox, x1 = tw.x + 27 + v.ox, y0 = tw.y - 62 + v.oy, y1 = tw.y + 10 + v.oy;
      if (x1 > r.x && x0 < r.x + r.w && y1 > r.y && y0 < r.y + r.h) return true;
    }
    return false;
  };

  /// THE MACHINE BAR replaces the Build drawer: one row at the bottom, chips at
  /// least 48 CSS px wide, the last slot a › pager when they cannot all fit.
  /// Breath and the wave button float above the bar's corners -- measured, the
  /// corners cover the fewest authored pads of four placements -- and neither
  /// takes a tap while a machine is in hand, so every pad stays buildable.
  Game.prototype._hudGeom = function () {
    var v=this.view,u=1/v.scale,cx=v.w/2,dock=this.mode?this._machineDock():[];
    var topY=Math.max(8,v.safeT+4);
    var shopX=cx-WORLD_W/2+12,actionW=WORLD_W-24;
    var buttonSize=Math.max(44,44*u),barX=Math.max(8,v.ox+8),barW=Math.min(v.w-16,WORLD_W-16);
    var pauseX=barX+barW-8-buttonSize,spdX=pauseX-buttonSize-5;
    var resourceX=barX+10*u,resourceW=(spdX-resourceX-8*u)/2;
    var actionH=54*u,actionY=v.h-Math.max(8*u,v.safeB+6*u)-actionH,gap=5*u,minW=48*u;
    var slots=Math.max(2,Math.floor((actionW+gap)/(minW+gap))),paged=dock.length>slots;
    var perPage=paged?slots-1:Math.max(1,dock.length),pages=Math.max(1,Math.ceil(dock.length/perPage));
    var page=clamp(this.shopPage|0,0,pages-1),cells=paged?slots:Math.max(1,dock.length);
    var chipW=Math.min(92*u,(actionW-(cells-1)*gap)/cells),rowX=cx-(cells*chipW+(cells-1)*gap)/2;
    var chips=dock.slice(page*perPage,page*perPage+perPage).map(function(c,i){
      return{id:c.id,index:c.index,locked:c.locked,stars:c.stars,x:rowX+i*(chipW+gap),y:actionY,w:chipW,h:actionH};});
    var pager=paged?{x:rowX+(cells-1)*(chipW+gap),y:actionY,w:chipW,h:actionH}:null;
    var floatY=actionY-8*u-actionH,abilityW=clamp(v.cw*.28,96,114)*u,startW=132*u;
    var breathRect={x:shopX,y:floatY,w:abilityW,h:actionH};
    var startRect={x:shopX+actionW-startW,y:floatY,w:startW,h:actionH};
    return {
      topY:topY,cx:cx,barH:buttonSize+12,
      infoY:topY+buttonSize+12+(this.rival?34:this.trial?20:8),barX:barX,barW:barW,
      btnY:topY+6,buttonW:buttonSize,buttonH:buttonSize,
      buildCancel:{x:barX+barW-8-buttonSize,y:topY+buttonSize+24,w:buttonSize,h:buttonSize},
      buildInfo:{x:barX,y:topY+buttonSize+20,w:barW,h:88*u},
      mute:null,pause:pauseX,spd:spdX,
      treasureRect:{x:resourceX,y:topY,w:resourceW,h:buttonSize+12},
      goldRect:{x:resourceX+resourceW,y:topY,w:resourceW,h:buttonSize+12},
      dock:dock,chips:chips,pager:pager,shopPage:page,shopPages:pages,shopPerPage:perPage,
      commandRow:{x:0,y:actionY-6*u,w:v.w,h:v.h-actionY+6*u},
      breathRect:breathRect,startRect:startRect,
      breathX:breathRect.x,breathY:breathRect.y,startY:startRect.y
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
  /// A BOTTOM-ROW BUTTON, INFLATED TO THE TAP FLOOR. Four of them -- the
  /// forge's RESPEC and BACK, the trials BACK, the duel BACK -- were 40 world
  /// units drawn and hit-tested from LITERALS duplicated thousands of lines
  /// apart, with no inflation at all. MEASURED: 40 units x scale is 34.2pt on
  /// an iPhone SE 3 (scale 0.8551), 37.4pt on a 15 Pro and 41.0pt on a 15 Pro
  /// Max -- under Apple's 44pt minimum on EVERY iPhone sold. _titleGeom and
  /// cavernRoomGeom had carried the rule for months; these three rooms never
  /// got it, because nothing derived their geometry from one place and so
  /// nothing could apply a rule to it.
  ///
  /// WIDTH IS A FLOOR TOO, and it is the one that bites: a 40-unit-wide chip is
  /// 34.2pt across on an SE however tall it is.
  /// THE WORLD Y OF THE LOWEST PIXEL A ROOM MAY USE. draw() translates by
  /// v.oy, so the visible band in world coords runs from -v.oy to v.h - v.oy;
  /// on a 19.5:9 phone that is ~65 units below WORLD_H that the 420x780 design
  /// box never knew about. _titleGeom and _hudGeom both anchor to it. The other
  /// four rooms pinned their bottom control to a literal instead, and MEASURED
  /// at 393x852 they left 115-166 world units -- 12.7% to 18.3% of the screen --
  /// of dead black under it. Same rule as _hudGeom's bottom stack so no two
  /// screens guess differently at the home indicator.
  ///
  /// It takes the VIEW rather than the scale because a room needs both numbers
  /// and passing scale alone is what made the other four unable to ask.
  function roomBottom(v) {
    if (!v || !v.h) return WORLD_H - 10;
    return v.h - (v.oy || 0) - Math.max(10, (v.safeB || 0) + 6);
  }

  /// WHERE A BOTTOM BUTTON'S TOP GOES, so that its INFLATED rect — not its
  /// painted box — is what lands on the margin. Anchoring the visual box at
  /// roomBottom - h puts the 44pt inflation 11 units past it and one unit off
  /// the bottom of the screen, which the room harness catches and which is the
  /// whole reason the inflation and the anchor have to be computed together.
  function roomBackY(v, h) {
    var s = (v && v.scale) || 1;
    var minH = Math.max(62, 44 / s);
    return roomBottom(v) - h - Math.max(0, (minH - h) / 2);
  }

  /// A LIST CENTRED IN WHAT IS LEFT. Bottom-anchoring a back button without
  /// this just MOVES the hole: a duel's four cards cap at 88 units of pitch for
  /// a good reason (at 104 each card held its content in the top 44 and left 30
  /// of air inside itself), so on a tall phone the extra height cannot all go
  /// into the rows. Growing them a little and centring the remainder reads as
  /// deliberate; leaving it all at the bottom is what VANUS called broken.
  function centredList(topMin, botMax, n, pitchCap, gap) {
    var avail = Math.max(0, botMax - topMin);
    var pitch = Math.min(pitchCap, Math.floor((avail + gap) / n));
    var block = n * pitch - gap;
    return { top: topMin + Math.max(0, (avail - block) / 2), pitch: pitch, h: pitch - gap };
  }

  function uiBtn(scale, x, y, w, h) {
    var s = scale || 1;
    var minH = Math.max(62, 44 / s), minW = 44 / s;
    var padY = Math.max(0, (minH - h) / 2), padX = Math.max(0, (minW - w) / 2);
    return { x: x, y: y, w: w, h: h,
             hx: x - padX, hy: y - padY,
             hw: Math.max(w, minW), hh: Math.max(h, minH) };
  }

  function duelGeom(v) {
    var scale = v && v.scale, n = RIVAL_ORDER.length;
    // 88, not 104. At 104 the row held its content in the top 44px and left a
    // 30px dead band above the footer line, which reads as three separate
    // cards' worth of air inside one card. 78px of body is still comfortably
    // over the 44pt tap floor. 96 is the tall-phone ceiling: the extra 8 goes
    // into the card, the rest into the air around the block.
    var top = 232, gap = 10;
    var backY = roomBackY(v, 40);
    var L = centredList(top, backY - 30, n, 96, gap);
    return { top: L.top, pitch: L.pitch, h: L.h, backY: backY,
             back: uiBtn(scale, WORLD_W / 2 - 70, backY, 140, 40),
             x: 30, w: WORLD_W - 60 };
  }

  /// THE FORGE HAD NO GEOMETRY FUNCTION. Its row y was the literal
  /// `250 + i * 74` hand-duplicated in the drawer and the tap handler 4,611
  /// lines apart -- the exact duplication _titleGeom, trialGeom and duelGeom
  /// were written to abolish -- and its two buttons were a bare
  /// `w.y > 640 && w.y < 680`. A sixth FORGE_NODES entry would have put its row
  /// at 620..682 straight through RESPEC/BACK at 640..680, with the rows tested
  /// FIRST, so the sixth node would have silently eaten the back button.
  function forgeGeom(v) {
    var scale = v && v.scale, rows = [], gap = 12;
    var btnY = roomBackY(v, 40);
    // 92 is the ceiling, not 74: a forge row carries a name, a description and
    // a rank pip strip, so the extra height is spent on the row rather than on
    // the air around it -- unlike a duel card, which had nothing to do with it.
    var L = centredList(250, btnY - 30, FORGE_NODES.length, 92, gap);
    for (var i = 0; i < FORGE_NODES.length; i++) {
      var ry = L.top + i * L.pitch;
      // the FORGE-star button is the target, and the row is its generous band
      rows.push({ y: ry, h: L.h,
                  btn: uiBtn(scale, WORLD_W - 118, ry + (L.h - 38) / 2, 88, 38),
                  band: { hx: WORLD_W - 118, hy: ry, hw: 88, hh: L.h } });
    }
    return { rows: rows, top: L.top, pitch: L.pitch, h: L.h, btnY: btnY,
             respec: uiBtn(scale, WORLD_W / 2 - 150, btnY, 140, 40),
             back:   uiBtn(scale, WORLD_W / 2 + 10,  btnY, 140, 40) };
  }

  function trialGeom(v) {
    var scale = v && v.scale, n = TRIAL_ORDER.length;
    var top = 214, gap = 8;
    var backY = roomBackY(v, 40);
    // last row's BOTTOM is top + n*pitch - gap, and it must clear BACK
    var L = centredList(top, backY - 30, n, 108, gap);
    var pitch = L.pitch, h = L.h;
    top = L.top;
    // The level chips run the FULL height of the row and are the tap targets,
    // so a compact row shrinks the text, never the thing you have to hit. At
    // the old (h - 46) they collapsed to 14 units on a six-trial list — about
    // 14 CSS px, a third of the 44pt minimum.
    // THE CHIPS WERE 40 WIDE ON A PITCH OF 46, which is 34.2pt across on an
    // SE 3 -- and no amount of hit inflation fixes it, because inflating to the
    // full 46 pitch only reaches 39.3pt. The strip had to WIDEN. 44 wide on a
    // pitch of 56 gives the hit rect the whole pitch (46.2pt) and still leaves
    // 12 units of visible gutter; the row's text loses 14 units, which fitText
    // already handles. The last chip's right edge lands exactly on the panel's.
    var CW = 44, CP = 56, CX = WORLD_W - 26 - CW - (CAMPAIGN_MAPS - 1) * CP;
    var chipH = Math.max(30, h - 16);
    var chips = [];
    for (var ci = 0; ci < CAMPAIGN_MAPS; ci++) {
      var cbx = CX + ci * CP;
      var cb = uiBtn(scale, cbx, 8, CW, chipH);
      // THE HIT RECT IS THE PITCH, not the chip. Inflating the 44-wide chip to
      // the 44/scale floor and THEN insetting 1 a side for the abutting
      // neighbour lands at 42 units -- 42.0pt at scale 1, which is under the
      // floor the inflation existed to clear. Claim the whole pitch first, then
      // inset: hit() is inclusive on both bounds, so two touching rects give
      // the shared column to whichever branch is tested first.
      cb.hx = cbx - (CP - CW) / 2 + 1;
      cb.hw = CP - 2;
      chips.push(cb);
    }
    return { top: top, pitch: pitch, h: h, chipY: 8, chipH: chipH,
             chips: chips, textW: CX - 42 - 10,
             back: uiBtn(scale, WORLD_W / 2 - 70, backY, 140, 40),
             backY: backY };
  }

  /// THE TITLE LAYOUT. One layout, not four: variants 0-2 were built to be
  /// compared and are in git (see "The home screen: one lit row, plain labels,
  /// and one chrome bar"). Keeping three dead ladders alive while the live one
  /// learned to stretch would have tripled the surface for no reader.
  ///
  /// It lives here rather than in the drawer because the TAP HANDLER reads this
  /// same function -- one geometry, two readers -- so a layout change physically
  /// cannot move a control away from its own hit box.
  ///
  /// THE SCREEN IS NOT THE DESIGN BOX. Everything below the art is anchored to
  /// the REAL bottom of the viewport, not to WORLD_H. draw() translates by
  /// v.oy, so the visible band in world coords runs from -v.oy to v.h - v.oy;
  /// on a 19.5:9 phone that is 65 units of extra room above the box and 65
  /// below it. Laid out in the fixed 420x780 box the utility row ended at 712
  /// and left a MEASURED 133.3 world units -- 14.6% of an iPhone 15 Pro's
  /// screen -- of dead black under it, which is what VANUS saw as "it doesnt
  /// stretch to the bottom of the screen either it looks broken". The in-game
  /// HUD already anchored its shop bar this way (`shopY: v.h - bm - 56`); the
  /// title never did, and nothing measured the gap because every capture was
  /// shot at 420x780 -- a rig that only renders the design box cannot see a
  /// design-box bug.
  Game.prototype._nextLevel = function () {
    var checkpoint = this.campaignCheckpoint();
    if (checkpoint && Save.unlocked(checkpoint.level)) return checkpoint.level;
    // A newly opened keep comes before improving a completed keep's stars.
    for (var first = 0; first < CAMPAIGN_MAPS; first++) {
      if (Save.unlocked(first) && !(Save.data.stars[first] | 0)) return first;
    }
    for (var i = 0; i < CAMPAIGN_MAPS; i++) {
      if (Save.unlocked(i) && (Save.data.stars[i] | 0) < 3) return i;
    }
    return -1;
  };

  /// THE LEGAL PAGES, REACHABLE FOR AS LONG AS THE GAME RUNS. Their only links
  /// were in the boot overlay, which is on screen while the art loads and then
  /// removed -- so after the first second nothing in the game led to the privacy
  /// policy or the terms at all. They live in the title's two top corners now:
  /// the header reserves 44 CSS pixels below the top safe area for links
  /// and How to play, with matching semantic controls for keyboard access.
  ///
  /// Browsers use the existing published pages. The iOS game keeps relative
  /// paths: App.swift catches them and opens the published page in a Safari
  /// view over the game, so the local game remains available underneath.
  var TITLE_LEGAL = [
    { key: 'privacy', label: 'PRIVACY', href: 'privacy.html' },
    { key: 'terms',   label: 'TERMS',   href: 'terms.html' },
  ];
  function legalHref(key) {
    // The local web build has no policy files. Native relative paths retain
    // the shell's Safari-sheet interception; browsers use the published copy.
    return window.location.protocol==='hoardling:'?key+'.html':'https://hypersage.ai/hoardling/'+key+'.html';
  }
  function openLegal(key) {
    for (var i = 0; i < TITLE_LEGAL.length; i++) {
      if (TITLE_LEGAL[i].key !== key) continue;
      var href = legalHref(TITLE_LEGAL[i].key);
      try {
        // An installed home-screen copy has no address bar and no back button,
        // so a same-window load would strand it the way the app used to be
        // stranded. There, the page opens in its own window instead.
        var standalone = (window.navigator && window.navigator.standalone) ||
          (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
        if (standalone && window.open(href, '_blank')) return;
        window.location.href = href;
      } catch (e) {}
      return;
    }
  }

  Game.prototype._titleGeom = function () {
    var v=this.view,s=v.scale||1,u=1/s,bot=roomBottom(v),nx=this._nextLevel();
    // Physical button sizes are reserved first. The illustration uses the
    // remaining space; short phones never borrow room from adjacent targets.
    var extra=Math.max(0,Math.min(64,((v.ch||WORLD_H*s)-650)*.3))*u;
    var x=42,w=WORLD_W-84,gap=8*u+extra*.04;
    var big=Math.max(74,62*u)+extra*.20,small=Math.max(60,48*u)+extra*.12;
    var modeH=Math.max(76,64*u)+extra*.24,barH=Math.max(66,60*u)+extra*.16;
    var modeGap=24*u+extra*.04,barGap=14*u+extra*.04;
    var block=(nx>=0?big:small)+small*2+gap*2+modeGap+modeH+barGap+barH;
    var top=bot-block,rows=[],y=top;
    function box(x,y,w,h){return{x:x,y:y,w:w,h:h,hx:x,hy:y,hw:w,hh:h};}
    for(var i=0;i<CAMPAIGN_MAPS;i++){
      var row=box(x,y,w,i===nx?big:small);row.hx=x-20;row.hw=w+20;row.big=i===nx;rows.push(row);y+=row.h+gap;
    }
    var modeY=y-gap+modeGap,half=(w-10*u)/2;
    var bar=box(12,modeY+modeH+barGap,WORLD_W-24,barH),pills=[];
    var inner=bar.w-14;
    for(var j=0;j<4;j++){var cell=box(bar.x+7+j*inner/4,bar.y,inner/4,barH);cell.hx=j===0?bar.x:cell.x;cell.hw=(j===3?bar.x+bar.w:cell.x+cell.w)-cell.hx;pills.push(cell);}
    // Links and help share one real 44px header below the top safe area.
    var headerY=-(v.oy||0)+(v.safeT||0),legal=[];
    for(var k=0;k<TITLE_LEGAL.length;k++){
      var lx=k===0?16:WORLD_W-16-66*u;
      var r=box(lx,headerY,66*u,44*u);r.key=TITLE_LEGAL[k].key;r.label=TITLE_LEGAL[k].label;legal.push(r);
    }
    var artTop=headerY+46*u,artBottom=top-36*u;
    var artScale=Math.min(1.02,Math.max(.3,(artBottom-artTop)/300));
    artTop+=Math.max(0,artBottom-artTop-300*artScale)*.5;
    return{rows:rows,ruleY:top-13*u,tonightY:modeY-11*u,
      daily:box(x,modeY,half,modeH),duel:box(x+half+10*u,modeY,half,modeH),
      legal:legal,help:box(210-62*u,headerY,124*u,44*u),pills:pills,bar:bar,
      artTop:artTop,artScale:artScale,bot:bot,screenTop:-(v.oy||0)};
  };

  function hit(w, r) {
    return w.x >= r.hx && w.x <= r.hx + r.hw && w.y >= r.hy && w.y <= r.hy + r.hh;
  }

  /// The states that paint their OWN backdrop across the whole viewport, so
  /// there is no letterbox band underneath them. ONE source, two readers: the
  /// HUD skips itself on these, and draw() skips the band-seam feathering on
  /// them. They had drifted apart -- the HUD knew, the feather did not, and the
  /// feather went on drawing a hard-edged 24-unit dark ramp across the bottom
  /// of every one of these screens.
  Game.prototype._ownsViewport = function () {
    return this.state === 'menu' || this.state === 'forge' || this.state === 'trials' ||
           this.state === 'duel' || this.state === 'cavern';
  };

  // A quiet, legible workbench. Machine art stays the existing painted asset;
  // cards get the room to show it instead of shrinking with every unlock.
  // Quiet brass and slate furniture shared by the battle rail. Sizes are CSS
  // pixels through u; the matching semantic targets come from _hudGeom.
  function battlePanel(ctx,x,y,w,h,r,fill,stroke,u) {
    ctx.fillStyle=fill;rr(ctx,x,y,w,h,r);ctx.fill();
    if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=u;ctx.stroke();}
  }
  function battleText(ctx,value,x,y,size,color,align,u,maxWidth,minSize) {
    var text=String(value),font=size;
    do{ctx.font='bold '+font*u+'px '+(size>=17?'Georgia, serif':'system-ui, sans-serif');if(!maxWidth||ctx.measureText(text).width<=maxWidth)break;font-=.5;}while(font>=(minSize||10.5));
    ctx.fillStyle=color;ctx.textAlign=align||'left';ctx.fillText(text,x,y);
  }
  function battleRail(ctx,x,y,w,h,u) {
    var grad=ctx.createLinearGradient(0,y,0,y+h);grad.addColorStop(0,'#302b26');grad.addColorStop(1,'#17171b');
    battlePanel(ctx,x,y,w,h,7*u,grad,'#887047',u);
    ctx.strokeStyle='rgba(244,218,159,.18)';ctx.beginPath();ctx.moveTo(x+12*u,y+3*u);ctx.lineTo(x+w-12*u,y+3*u);ctx.stroke();
    [x+5*u,x+w-5*u].forEach(function(edge){ctx.fillStyle='#9a7d48';ctx.beginPath();ctx.arc(edge,y+h/2,1.2*u,0,(Math.PI*2));ctx.fill();});
  }
  Game.prototype._battleWaveLabel=function(){var total=this.totalWaves();return 'WAVE '+Math.min(this.wave+1,total)+(total===Infinity?'':' / '+total);};
  Game.prototype._drawBattleResources=function(ctx,G){
    var u=1/this.view.scale,x=G.treasureRect.x,y=G.topY;
    battleRail(ctx,G.barX,y,G.barW,G.barH,u);
    battleText(ctx,'TREASURE',x,y+14*u,9.5,'#c4b594','left',u);
    var keep=this._sidePlate(0,'keep','keep');if(keep){var ih=27*u,iw=ih*keep.width/keep.height;ctx.drawImage(keep,x,y+20*u,iw,ih);}
    battleText(ctx,this.hoard,x+24*u,y+40*u,20,this.hoard<=15?'#f6a785':'#f4e3b8','left',u);
    battleText(ctx,'/'+CFG.startHoard,x+51*u,y+40*u,10,'#aa9d84','left',u);
    x=G.goldRect.x;battleText(ctx,'BUILD GOLD',x,y+14*u,9.5,'#c4b594','left',u);
    drawCoin(ctx,x+7*u,y+33*u,6.5*u,Save.equipped('coin'));
    battleText(ctx,this.gold,x+20*u,y+40*u,20,'#f7d984','left',u,G.goldRect.w-22*u,12);
    if(this.state==='playing'){
      ctx.strokeStyle='rgba(189,163,115,.25)';ctx.beginPath();ctx.moveTo(G.spd-4*u,y+11*u);ctx.lineTo(G.spd-4*u,y+G.barH-10*u);ctx.stroke();
      battleText(ctx,this.speed+'×',G.spd+G.buttonW/2,G.btnY+G.buttonH/2+5*u,15,'#d4c5a7','center',u);
      var px=G.pause+G.buttonW/2,py=G.btnY+G.buttonH/2;ctx.fillStyle='#e5d4ac';ctx.fillRect(px-6*u,py-7*u,4*u,14*u);ctx.fillRect(px+2*u,py-7*u,4*u,14*u);
    }
    ctx.textAlign='left';
  };
  // THE ONE ABILITY SHOULD LOOK LIKE ONE (2026-09-14). VANUS: the rebuilt rail
  // Breath "doesn't look better" than the old orange button. Same rect, same
  // words and positions (test-breath owns those); what changed is presence: a
  // lit plate when a cast would land, a bigger flame, a thick cooldown ring.
  // The halo breathes slowly and holds still under reduced motion.
  Game.prototype._drawBreathControl=function(ctx,r){
    var a=this._breathStatus(),u=1/this.view.scale,cx=r.x+25*u,cy=r.y+20*u,rad=16.5*u,hot=a.canCast,t=RM?0:this.worldT;
    battlePanel(ctx,r.x,r.y+2*u,r.w,r.h-2*u,9*u,hot?'#4b2616':'#26221f',hot?'#e38a3f':'#5e5547',u);
    if(hot){var sw=RM?.5:.5+.5*Math.sin(t*2.2),halo=ctx.createRadialGradient(cx,cy,rad*.55,cx,cy,rad*1.7);
      halo.addColorStop(0,'rgba(255,150,60,'+(.26+.10*sw)+')');halo.addColorStop(1,'rgba(255,120,40,0)');
      ctx.fillStyle=halo;ctx.beginPath();ctx.arc(cx,cy,rad*1.7,0,Math.PI*2);ctx.fill();}
    var core=ctx.createRadialGradient(cx,cy-rad*.35,rad*.1,cx,cy,rad);
    core.addColorStop(0,hot?'#ffb257':a.ready?'#6b4a2b':'#3b3431');core.addColorStop(1,hot?'#b0421c':a.ready?'#2d231c':'#1c1a1b');
    ctx.fillStyle=core;ctx.beginPath();ctx.arc(cx,cy,rad,0,Math.PI*2);ctx.fill();
    ctx.lineWidth=3*u;ctx.strokeStyle='rgba(0,0,0,.5)';ctx.beginPath();ctx.arc(cx,cy,rad+1.5*u,0,Math.PI*2);ctx.stroke();
    ctx.strokeStyle=hot?'#ffd27a':a.ready?'#d9a55a':'#e0873f';ctx.beginPath();ctx.arc(cx,cy,rad+1.5*u,-Math.PI/2,-Math.PI/2+(Math.PI*2)*a.fraction);ctx.stroke();
    flameGlyph(ctx,cx,cy-u,.92*u,t,hot||a.ready);
    battleText(ctx,'BREATH',cx,r.y+51*u,12,hot?'#ffe3b0':'#d3c3a3','center',u);
    var x=r.x+51*u,w=r.w-53*u;
    if(a.kind==='cooling'||a.kind==='recovering'){
      battleText(ctx,a.seconds+'s',x,r.y+27*u,18,'#e4d6b7','left',u,w,14);
      battleText(ctx,a.kind==='recovering'?'recover':'to ready',x,r.y+41*u,11,'#c1b49c','left',u,w,11);
    }else{
      battleText(ctx,a.canCast?a.count+' in':'Move',x,r.y+24*u,12,a.canCast?'#ffd788':'#c5b79c','left',u,w,10.5);
      battleText(ctx,a.canCast?'reach':'closer',x,r.y+40*u,11,'#b7aa91','left',u,w,10.5);
    }
    ctx.textAlign='left';
  };
  Game.prototype._drawBattleWaveStatus=function(ctx,r){
    var u=1/this.view.scale,live=this._battleIntel(),line=live.onRoad+(live.onRoad===1?' raider':' raiders'),detail=live.incoming?live.incoming+' incoming':'Last group';
    if(live.key==='recover'){line=live.coinsAtRisk+' stolen';detail='Move Wick close';}
    else if(live.key==='jammed'){line=live.jammed+' jammed';detail='Wick repairs';}
    battleText(ctx,this._battleWaveLabel(),r.x+r.w/2,r.y+10*u,9,'#b1a18a','center',u,r.w-8*u,9);
    battleText(ctx,line,r.x+r.w/2,r.y+30*u,13,live.color,'center',u,r.w-8*u,11);
    battleText(ctx,detail,r.x+r.w/2,r.y+47*u,10.5,'#baad94','center',u,r.w-8*u,10.5);
    ctx.textAlign='left';
  };

  Game.prototype._drawBuildDock = function (ctx, G) {
    var self = this, ownN = this.towers.filter(function(t){return self._sameSide(t.own,0);}).length;
    var u=1/this.view.scale,tray=G.commandRow;
    var shade=ctx.createLinearGradient(0,tray.y,0,tray.y+tray.h);shade.addColorStop(0,'#25221f');shade.addColorStop(1,'#111215');
    ctx.fillStyle=shade;ctx.fillRect(tray.x,tray.y,tray.w,tray.h);ctx.strokeStyle='#78613c';ctx.lineWidth=u;ctx.beginPath();ctx.moveTo(0,tray.y);ctx.lineTo(this.view.w,tray.y);ctx.stroke();
    G.chips.forEach(function (c) {
      var type=TOWER_TYPES[c.id],cost=Math.round(type.cost*crowdMul(ownN));
      var picked=!c.locked&&self.shopPick===c.index,can=!c.locked&&self.gold>=cost;
      var fill=ctx.createLinearGradient(0,c.y,0,c.y+c.h);
      fill.addColorStop(0,picked?'#69502b':c.locked?'#1f1c1a':'#302923');fill.addColorStop(1,picked?'#312319':c.locked?'#141211':'#191513');
      ctx.fillStyle=fill;rr(ctx,c.x,c.y,c.w,c.h,8*u);ctx.fill();
      ctx.strokeStyle=picked?'#ffda7c':c.locked?'#3d352c':can?'#9d8050':'#54483b';ctx.lineWidth=picked?2.5*u:u;
      rr(ctx,c.x+u,c.y+u,c.w-2*u,c.h-2*u,7*u);ctx.stroke();
      ctx.globalAlpha=c.locked?.3:can||picked?1:.55;
      self._drawMachinePortrait(ctx,c.id,0,0,{x:c.x+3*u,y:c.y+3*u,w:c.w-6*u,h:c.h-21*u});
      ctx.globalAlpha=1;
      var ty=c.y+c.h-7*u;
      if(c.locked){
        var lx=c.x+c.w/2-15*u,ly=ty-9*u;
        ctx.strokeStyle='#bfae92';ctx.lineWidth=1.6*u;ctx.beginPath();ctx.arc(lx+4*u,ly+1.5*u,3*u,Math.PI,0);ctx.stroke();
        ctx.fillStyle='#bfae92';ctx.fillRect(lx,ly+1.5*u,8*u,7*u);
        battleText(ctx,'\u2605'+c.stars,c.x+c.w/2+6*u,ty,11,'#d9c7a6','center',u,c.w-18*u,10);
      } else battleText(ctx,cost+'g',c.x+c.w/2,ty,12,can?'#ffda7c':'#c2ad93','center',u,c.w-6*u,10.5);
      if(picked){ctx.fillStyle='#ffda7c';ctx.beginPath();ctx.arc(c.x+c.w-7*u,c.y+7*u,3*u,0,Math.PI*2);ctx.fill();}
    });
    if(G.pager){
      var pg=G.pager;battlePanel(ctx,pg.x,pg.y,pg.w,pg.h,8*u,'#403628','#a28a59',u);
      battleText(ctx,'\u203a',pg.x+pg.w/2,pg.y+28*u,24,'#ffda7c','center',u);
      battleText(ctx,(G.shopPage+1)+'/'+G.shopPages,pg.x+pg.w/2,pg.y+46*u,10.5,'#d9c7a6','center',u);
    }
    ctx.textAlign='left';
    if (this.shopPick >= 0) {
      var id=this._shelf()[this.shopPick], type=TOWER_TYPES[id]; if(!type)return;
      var price=Math.round(type.cost*crowdMul(ownN)), pad=Math.round(type.cost*PAD_DISCOUNT*crowdMul(ownN));
      var info=G.buildInfo,x=info.x,y=info.y,w=info.w;
      battleRail(ctx,x,y,w,info.h,u);
      battleText(ctx,'PLACE · '+this._battleWaveLabel(),x+12*u,y+14*u,9.5,'#d7ba85','left',u);
      battleText(ctx,type.name,x+12*u,y+35*u,16,'#fff0d4','left',u,G.buildCancel.x-x-22*u,13);
      ctx.fillStyle=type.support?'#b5deea':'#dbcbb5';ctx.font=11*u+'px system-ui, sans-serif';ctx.fillText(type.blurb,x+12*u,y+59*u);
      battleText(ctx,this.gold>=pad?'Floor '+price+'g · Stone pad '+pad+'g':'Need '+(pad-this.gold)+'g more for a stone pad',x+12*u,y+77*u,11,this.gold>=pad?'#ffda7c':'#e6ac9a','left',u,w-24*u,11);
      var cr=G.buildCancel,cX=cr.x+cr.w/2,cY=cr.y+cr.h/2;uiPanel(ctx,cr.x,cr.y,cr.w,cr.h,9);
      ctx.strokeStyle='#f0d8b6';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(cX-6,cY-6);ctx.lineTo(cX+6,cY+6);ctx.moveTo(cX+6,cY-6);ctx.lineTo(cX-6,cY+6);ctx.stroke();
    }
  };

  Game.prototype._drawHudView = function (ctx) {
    var v = this.view, G = this._hudGeom();
    // The resource bar belongs to a RUN. It used to draw unconditionally, so
    // the title screen wore an opaque "60 / GOLD 120 / WAVE 1/20" slab for a
    // game that had not started — inert, but it read as leftover UI and it is
    // the first thing on the screen.
    if (this._ownsViewport()) return;
    this._drawBattleResources(ctx,G);
    var lx=G.barX+14;
    if (this.trial) {   // which trial this run is — always visible, never loud
      ctx.fillStyle = 'rgba(168,230,255,0.85)'; ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.fillText('TRIAL: ' + TRIALS[this.trial].name.toUpperCase(), lx + 27, G.topY + G.barH + 12);
    }
    // ---- THE DUEL STRIP ---------------------------------------------------
    // A second, dimmer hoard under your own. It sits in the band the TRIAL line
    // uses — the two can never collide, because a duel takes no trial.
    // The number that matters is the MARGIN, so the margin is the loud element
    // and the rival's raw hoard is the quiet one: "am I ahead" is the question
    // being asked every three seconds, and it should not need arithmetic.
    if (this.rival && (this.state === 'playing' || this.state === 'paused')) {
      var dsY = G.topY + G.barH + 4;
      uiPanel(ctx, G.barX, dsY, G.barW, 26, 9);
      var pulse = Math.max(0, 1 - (this.worldT - this.rivalStepT) / 1.2);
      var dlx = G.barX + 14;
      // rival's coin pip — deliberately cool and dim against your warm gold,
      // so a glance never mistakes their pile for yours
      // A COIN, but never YOUR coin: the rival's pip is deliberately cool and
      // dim against your warm gold so a glance never mistakes her pile for
      // yours, and that separation must survive whatever you equip.
      drawCoin(ctx, dlx + 7, dsY + 13, 7,
               { face: '#8fa2b4', edge: '#3f4c5a', ink: '#2c3742', stamp: 'bastion' });
      ctx.fillStyle = '#cfe0f0'; ctx.font = 'bold 15px Georgia, serif';
      ctx.textAlign = 'left';
      ctx.fillText(String(Math.max(0, this.rivalHoard)), dlx + 20, dsY + 19);
      ctx.fillStyle = this.rival.tint || 'rgba(190,210,230,0.78)';
      ctx.font = 'bold 10px system-ui, sans-serif';
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
    if(this.state==='playing'&&!this.menu)this._drawBuildDock(ctx,G);
    // Smothered Fire takes the flame away, so the button goes with it — an
    // unusable control that still sits there reads as a bug, not a rule.
    if (this.state === 'playing' && !this.menu && this.shopPick < 0 && !this.shopOpen && !this.mods.breathOff) {
      ctx.globalAlpha=this._cardOverMachine(G.breathRect)?.45:1;
      this._drawBreathControl(ctx,G.breathRect);
      ctx.globalAlpha=1;
    }
    // Speed and Pause stay on the shared resource rail in every battle mode.
    // Sound is available in Pause and on M, including Smothered Fire.
    // first-encounter enemy card: sprite + the counter line
    if (this._enemyIntroVisible()) {
      var card = ENEMY_CARDS[this.infoCard.type];
      var fade = Math.min(1, this.infoCard.t / 0.4);
      ctx.globalAlpha = fade;
      var cw2 = Math.min(v.w - 24, 372);
      var cx2 = v.w / 2 - cw2 / 2, cy2 = G.infoY;
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
    var startFade=this.state==='playing'&&this._cardOverMachine(G.startRect)?.45:1;
    if (this.state === 'playing' && !this.menu && this.shopPick < 0 && !this.shopOpen && !this.waveActive && this.wave < this.totalWaves()) {
      ctx.globalAlpha=startFade;
      var r=G.startRect,u=1/v.scale,cx=r.x+r.w/2;
      var red=ctx.createLinearGradient(0,r.y,0,r.y+r.h);red.addColorStop(0,'#874437');red.addColorStop(1,'#4e2826');
      battlePanel(ctx,r.x,r.y+2*u,r.w,r.h-2*u,7*u,red,'#bd9253',u);
      battleText(ctx,this._battleWaveLabel(),cx,r.y+11*u,9,'#dbc3a2','center',u,r.w-8*u,9);
      battleText(ctx,this.wave===0?'START WAVE':'NEXT WAVE',cx,r.y+30*u,12,'#ffedc7','center',u,r.w-12*u,11.5);
      var detail=this.wave===0?this._waveIntel().total+' raiders':Math.ceil(this.countdown)+'s · +'+Math.ceil(this.countdown)+'g';
      battleText(ctx,detail,cx,r.y+47*u,10.5,'#dbc3a2','center',u,r.w-8*u,10.5);
      ctx.textAlign='left';ctx.globalAlpha=1;
    }
    // During a wave the corner card reports the fight instead of calling one.
    if (this.state === 'playing' && !this.menu && this.shopPick < 0 && this.waveActive) {
      var sr=G.startRect,su=1/v.scale;ctx.globalAlpha=startFade;
      battlePanel(ctx,sr.x,sr.y+2*su,sr.w,sr.h-2*su,7*su,'#26221f','#5e5547',su);
      this._drawBattleWaveStatus(ctx,sr);ctx.globalAlpha=1;
    }
  };

  Game.prototype._drawWickPortrait = function (ctx, r, dim) {
    var img = this._myPlate(ART.images.hero_title || ART.images.hero);
    ctx.save();
    ctx.beginPath(); ctx.arc(r.x+r.w/2,r.y+r.h/2,r.w/2,0,Math.PI*2); ctx.clip();
    ctx.fillStyle='#492a20'; ctx.fillRect(r.x,r.y,r.w,r.h);
    if (dim) ctx.globalAlpha*=.48;
    if(img)ctx.drawImage(img,img.width*.145,0,img.width*.58,img.height*.516,r.x,r.y,r.w,r.h);
    ctx.restore();
  };
  Game.prototype._drawMenus = function (ctx) {
    var tw = this._machineMenuTower(); if (!tw) return;
    var m=this.menu,G=this._machineMenuGeom(tw),u=G.u,tt=TOWER_TYPES[tw.type],row=lvlRow(tw);
    var actions=this._machineMenuActions(),cream='#fff0d5',gold='#eac583',muted='#c9bda9',ember='#dd986b',steel='#a8c9cf',red='#efa18f';
    function font(size,bold){ctx.font=(bold?'650 ':'')+(size*u)+'px system-ui, sans-serif';}
    function label(s,x,y,size,color,bold,max){font(size,bold);ctx.fillStyle=color;ctx.textAlign='left';ctx.fillText(max?fitText(ctx,s,max):s,x,y);}
    function panel(r,fill,stroke,radius){ctx.fillStyle=fill;rr(ctx,r.x,r.y,r.w,r.h,(radius||7)*u);ctx.fill();if(stroke){ctx.strokeStyle=stroke;ctx.lineWidth=u;rr(ctx,r.x,r.y,r.w,r.h,(radius||7)*u);ctx.stroke();}}
    function gradient(r,a,b){var g=ctx.createLinearGradient(r.x,r.y,r.x,r.y+r.h);g.addColorStop(0,a);g.addColorStop(1,b);return g;}
    function summary(){
      if(tw.type==='press')return row.waveGold+'g / wave · '+(row.killGold||0)+'g / kill';
      if(tw.type==='bellows')return '+'+Math.round((row.auraDmg||row.auraRate)*100)+'% '+(row.auraDmg?'damage':'fire rate')+' · '+row.range+' reach';
      return row.dmg+' damage · '+machineNumber(row.rate)+'/sec · '+row.range+' reach';
    }
    function check(x,y,color){ctx.strokeStyle=color;ctx.lineWidth=1.8*u;ctx.beginPath();ctx.moveTo(x-4*u,y);ctx.lineTo(x-u,y+3*u);ctx.lineTo(x+5*u,y-4*u);ctx.stroke();}
    var sub=G.fork||m.confirmSell||m.aimMenu;
    ctx.save();ctx.lineCap='round';
    var stem=G.tether;
    ctx.strokeStyle='#241e1b';ctx.lineWidth=4*u;ctx.beginPath();ctx.moveTo(stem.source.x,stem.source.y);ctx.lineTo(stem.target.x,stem.target.y);ctx.stroke();
    ctx.strokeStyle=gold;ctx.lineWidth=1.5*u;ctx.stroke();
    G.panels.forEach(function(r){
      ctx.shadowColor='rgba(0,0,0,.65)';ctx.shadowBlur=12*u;ctx.shadowOffsetY=3*u;
      panel(r,gradient(r,'#302b27','#1e1d20'),'#a58353',10);
      ctx.shadowBlur=0;ctx.shadowOffsetY=0;
    });
    ctx.fillStyle=gold;ctx.fillRect(G.x+12*u,G.y,65*u,2*u);
    label(G.fork?'Final upgrade':m.confirmSell?'Sell machine?':m.aimMenu?'Target priority':tt.name,G.x+12*u,G.y+21*u,13,cream,true,G.w-114*u);
    if(sub){
      label(G.fork?'Level 2 → 3 · choose one path':m.aimMenu?tt.short+' · change aim':tt.short+' · upgrades will be lost',G.x+12*u,G.y+40*u,10,muted,false,G.w-114*u);
    }else{
      // Exactly three level markers. Future prices are shown only on the
      // purchase action, so the last-step price cannot imply total cost to MAX.
      var positions=[12,44,76],widths=[25,25,48];
      for(var i=0;i<3;i++){
        var r={x:G.x+positions[i]*u,y:G.y+29*u,w:widths[i]*u,h:18*u},built=i<=tw.level;
        panel(r,i===tw.level?'#6a502d':'#242222',built?'#c7a162':'#6d6254',4);
        font(10,true);ctx.fillStyle=built?cream:muted;ctx.textAlign='center';ctx.fillText(i===2?'3 MAX':String(i+1),r.x+r.w/2,r.y+13*u);
        if(i<2){ctx.strokeStyle='#96846a';ctx.lineWidth=u;ctx.beginPath();ctx.moveTo(r.x+r.w+2*u,r.y+9*u);ctx.lineTo(r.x+r.w+5*u,r.y+9*u);ctx.stroke();}
      }
      label(tw.level===2?'Done':(2-tw.level)+' left',G.x+132*u,G.y+42*u,10.5,tw.level===2?gold:muted,false);
    }
    if(G.fork){
      var selected=m.forkChoice===1?1:0,fk=tt.forks[selected],lines=machineForkLines(tw,fk);
      label(MACHINE_PERK_LABELS[tw.type][selected],G.x+12*u,G.at(139),10.5,cream,true,G.w-24*u);
      label(lines[0],G.x+12*u,G.at(151),10.5,muted,false,G.w-24*u);
      label(lines[1],G.x+12*u,G.at(163),10.5,muted,false,G.w-24*u);
    }else if(m.aimMenu){
      label('Stolen-coin carriers always take priority.',G.x+12*u,G.at(179),10,muted,false,G.w-24*u);
    }else if(!m.confirmSell&&tw.level===2){
      // A finished upgrade is a status plaque, never a disabled purchase tile.
      var r=G.upgrade;ctx.fillStyle='#d0ae73';ctx.fillRect(r.x,r.y+7*u,2*u,r.h-14*u);
      this._drawMachinePortrait(ctx,tw.type,2,tw.fork||0,{x:r.x+5*u,y:r.y+4*u,w:42*u,h:48*u});
      label(row.name,r.x+53*u,r.y+17*u,12.5,cream,true,r.w-106*u);
      check(r.x+r.w-43*u,r.y+13*u,gold);label('MAX',r.x+r.w-33*u,r.y+17*u,11,gold,true);
      label(MACHINE_PERK_LABELS[tw.type][tw.fork||0],r.x+53*u,r.y+33*u,10,muted,false,r.w-59*u);
      label('Base · '+summary(),r.x+53*u,r.y+48*u,10,muted,false,r.w-59*u);
      label('Fully upgraded · permanent path',r.x+53*u,r.y+61*u,10,gold,false,r.w-59*u);
    }
    if(!sub&&!G.aimed){
      label('No target setting',G.aim.x+2*u,G.aim.y+17*u,11.5,muted,true,G.aim.w-4*u);
      label(tt.support?'Supports your workshop':'Targets automatically',G.aim.x+2*u,G.aim.y+33*u,10,muted,false,G.aim.w-4*u);
    }
    var wave=this._battleWaveLabel().replace('WAVE ','Wave ').replace(' / ','/');
    label(wave+' · '+(tw.jamT>0?'Jammed · machine stopped':this.waveActive?'Battle continues':'Ready for next wave'),G.x+12*u,G.footerY,10,tw.jamT>0?red:muted,false,G.w-24*u);
    actions.forEach(function(a){
      var r=a.rect,tx=r.x+10*u,max=r.w-20*u,isBuy=/^fork[01]$/.test(a.id),preview=/^preview[01]$/.test(a.id),aimChoice=/^aim[0-3]$/.test(a.id);
      var chosen=preview?Number(a.id.slice(-1))===(m.forkChoice===1?1:0):aimChoice&&Number(a.id.slice(-1))===(tw.targeting|0);
      if(a.id==='close'||a.id==='pause'){
        panel(r,'#262322','#72614a',7);
        if(a.id==='pause'){
          ctx.fillStyle=cream;ctx.fillRect(r.x+16*u,r.y+9*u,4*u,12*u);ctx.fillRect(r.x+24*u,r.y+9*u,4*u,12*u);
        }else{
          ctx.strokeStyle=cream;ctx.lineWidth=2*u;ctx.beginPath();
          if(sub){ctx.moveTo(r.x+25*u,r.y+8*u);ctx.lineTo(r.x+18*u,r.y+15*u);ctx.lineTo(r.x+25*u,r.y+22*u);}
          else{ctx.moveTo(r.x+16*u,r.y+9*u);ctx.lineTo(r.x+28*u,r.y+21*u);ctx.moveTo(r.x+28*u,r.y+9*u);ctx.lineTo(r.x+16*u,r.y+21*u);}ctx.stroke();
        }
        font(10,false);ctx.textAlign='center';ctx.fillStyle=muted;ctx.fillText(a.id==='pause'?'Pause':sub?'Back':'Close',r.x+r.w/2,r.y+36*u);return;
      }
      if(a.id==='upgrade'){
        panel(r,gradient(r,a.disabled?'#39332a':'#e2bd78',a.disabled?'#2b2825':'#b98944'),a.disabled?'#8e7c5e':'#f3d89b');
        var ink=a.disabled?cream:'#302213',secondary=a.disabled?muted:'#47331c';
        if(tw.level===0)this._drawMachinePortrait(ctx,tw.type,1,0,{x:r.x+5*u,y:r.y+5*u,w:42*u,h:46*u});
        else{
          ctx.strokeStyle=ink;ctx.lineWidth=2*u;ctx.beginPath();ctx.moveTo(r.x+26*u,r.y+40*u);ctx.lineTo(r.x+26*u,r.y+26*u);ctx.lineTo(r.x+15*u,r.y+17*u);ctx.moveTo(r.x+26*u,r.y+26*u);ctx.lineTo(r.x+37*u,r.y+17*u);ctx.stroke();
          [15,37].forEach(function(x){ctx.beginPath();ctx.moveTo(r.x+(x-4)*u,r.y+17*u);ctx.lineTo(r.x+x*u,r.y+13*u);ctx.lineTo(r.x+(x+4)*u,r.y+17*u);ctx.stroke();});
        }
        tx=r.x+53*u;max=r.w-63*u;
        label(a.title,tx,r.y+17*u,12.5,ink,true,max-43*u);
        font(13,true);ctx.fillStyle=ink;ctx.textAlign='right';ctx.fillText(a.price,r.x+r.w-9*u,r.y+17*u);
        var detail=tw.level===0?a.detail.map(function(s){return s.replace(' attacks/sec','/sec').replace(' · affects nearby machines','');}):['Choose 1 of 2 permanent paths','Base · '+summary()];
        label(detail[0],tx,r.y+33*u,10,secondary,false,max);
        label(detail[1],tx,r.y+47*u,10,secondary,false,max);
        if(this.gold<row.upgradeCost)label('Need '+(row.upgradeCost-this.gold)+'g more'+(tw.level===1?' · compare now':''),tx,r.y+60*u,10,ink,true,max);
      }else if(a.id==='crew'){
        var assigned=this.hero.manTid===tw.tid,aboard=assigned&&this.hero.manned;
        panel(r,gradient(r,a.disabled?'#302d2a':aboard?'#42392a':'#493025','#2b2421'),a.disabled?'#73665a':aboard?'#b8ae78':'#ae7953');
        this._drawWickPortrait(ctx,{x:r.x+6*u,y:r.y+5*u,w:38*u,h:38*u},a.disabled);
        label(a.disabled?'Wick recovering':aboard?'Release Wick':assigned?'Cancel Wick’s order':'Send Wick here',r.x+52*u,r.y+19*u,12.5,a.disabled?muted:cream,true,r.w-76*u);
        var benefit=a.disabled?'Available when Wick recovers':aboard?tw.jamT>0?'Jammed · Wick clearing jam':'Wick aboard · bonus active':assigned?'Wick is on his way':tw.jamT>0?'Send Wick to clear the jam':tt.support?tw.type==='press'?'+50% gold income':'+60% aura strength':'+70% fire rate · +30% damage';
        label(benefit,r.x+52*u,r.y+36*u,10,a.disabled?muted:ember,false,r.w-61*u);
        if(!a.disabled){if(aboard)check(r.x+r.w-17*u,r.y+17*u,gold);else{ctx.strokeStyle=ember;ctx.lineWidth=1.6*u;ctx.beginPath();ctx.moveTo(r.x+r.w-21*u,r.y+17*u);ctx.lineTo(r.x+r.w-13*u,r.y+17*u);if(!assigned){ctx.moveTo(r.x+r.w-17*u,r.y+13*u);ctx.lineTo(r.x+r.w-17*u,r.y+21*u);}ctx.stroke();}}
      }else if(a.id==='aim'){
        panel(r,'#252e31','#647e83');ctx.strokeStyle=steel;ctx.lineWidth=1.3*u;
        var cx=r.x+19*u,cy=r.y+22*u;ctx.beginPath();ctx.arc(cx,cy,6*u,0,6.283);ctx.moveTo(cx-10*u,cy);ctx.lineTo(cx+10*u,cy);ctx.moveTo(cx,cy-10*u);ctx.lineTo(cx,cy+10*u);ctx.stroke();
        label('Aim: '+AIM_MODES[tw.targeting|0],r.x+36*u,r.y+18*u,12,cream,true,r.w-43*u);
        label('Change priority ›',r.x+36*u,r.y+34*u,10,steel,false,r.w-43*u);
      }else if(a.id==='sell'){
        panel(r,'#302422','#8e5d50');label('Sell',tx,r.y+18*u,12.5,red,true,max);label(this._sellValue(tw)+'g refund',tx,r.y+34*u,10,muted,false,max);
      }else if(preview){
        panel(r,chosen?'#51412d':'#282625',chosen?gold:'#716354');
        var option=Number(a.id.slice(-1));this._drawMachinePortrait(ctx,tw.type,2,option,{x:r.x+8*u,y:r.y+3*u,w:r.w-16*u,h:48*u});
        machineAbilityGlyph(ctx,tw.type,option,r.x+r.w-15*u,r.y+16*u,9*u);
        font(12,true);ctx.fillStyle=cream;ctx.textAlign='center';ctx.fillText(fitText(ctx,a.title,max),r.x+r.w/2,r.y+65*u);
        if(chosen){ctx.fillStyle=gold;ctx.fillRect(r.x+10*u,r.y+r.h-3*u,r.w-20*u,2*u);}
      }else if(aimChoice){
        panel(r,chosen?'#3b5155':'#252e31',chosen?steel:'#60767a');
        var ai=Number(a.id.slice(-1));label(a.title,tx,r.y+19*u,12,cream,true,max-15*u);
        label(['Closest to hoard','Most health','Newest arrival','Healers first'][ai],tx,r.y+36*u,10,muted,false,max);
        if(chosen)check(r.x+r.w-14*u,r.y+15*u,steel);
      }else if(isBuy){
        panel(r,gradient(r,a.disabled?'#39332a':'#e2bd78',a.disabled?'#2b2825':'#b98944'),a.disabled?'#8e7c5e':'#f3d89b');
        var ink=a.disabled?cream:'#302213';label(a.title,tx,r.y+18*u,12.5,ink,true,max-48*u);
        label(a.disabled?'Need '+(row.upgradeCost-this.gold)+'g more':'Permanent choice · Level 3 / MAX',tx,r.y+34*u,10,a.disabled?muted:'#47331c',false,max-42*u);
        font(14,true);ctx.fillStyle=ink;ctx.textAlign='right';ctx.fillText(row.upgradeCost+'g',r.x+r.w-10*u,r.y+26*u);
      }else if(a.id==='confirmSell'){
        panel(r,'#4a2927','#c78975');label('Sell for '+this._sellValue(tw)+'g',tx,r.y+19*u,12.5,cream,true,max);
        label('Machine and upgrades are removed.',tx,r.y+36*u,10.5,muted,false,max);
        label('Gold '+this.gold+' → '+(this.gold+this._sellValue(tw)),tx,r.y+51*u,10.5,red,false,max);
      }else{
        panel(r,'#302e29','#96866d');font(12.5,true);ctx.fillStyle=cream;ctx.textAlign='center';ctx.fillText(a.title,r.x+r.w/2,r.y+28*u);
      }
    },this);
    ctx.restore();
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
    var v = this.view, G=this._titleGeom(), u=1/(this.view.scale||1);
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
    // THE VIGNETTE HAS TO KNOW HOW BIG THE SCREEN IS. Its outer stop is 86%
    // black, and at a fixed radius of 470 everything past y=830 is AT that stop
    // -- which is exactly where the utility bar now sits on a 19.5:9 phone, so
    // the bar and its icons came out visibly dimmer than they were designed.
    // Derived from the farthest visible corner instead: on the design box the
    // corner is at hypot(210, 420) = 470 and the numbers below are the ones
    // that shipped, unchanged, so this reaches further ONLY where there is
    // further to reach.
    var vBot = (v.h || WORLD_H) - (v.oy || 0);
    var vR = Math.sqrt(Math.pow(WORLD_W / 2, 2) +
                       Math.pow(Math.max(360 - (-(v.oy || 0)), vBot - 360), 2));
    var vg = ctx.createRadialGradient(210, 360, vR * 0.3191, 210, 360, vR);
    vg.addColorStop(0.00, 'rgba(6,3,2,0)');
    vg.addColorStop(0.62, 'rgba(6,3,2,0.30)');
    vg.addColorStop(1.00, 'rgba(4,2,1,0.86)');
    ctx.fillStyle = vg; ctx.fillRect(X, Y, W, H);

    embers(ctx, t, 0, 18, 1.0, 1.0);           // back layer, behind the sign

    ctx.save();ctx.translate(210,G.artTop);ctx.scale(G.artScale,G.artScale);ctx.translate(-210,-26);
    // ---- 2. the hanging nameplate ---------------------------------------
    ctx.textAlign = 'center';
    ctx.font = 'bold 54px Georgia, serif';
    var fs = Math.min(54, 54 * 300 / ctx.measureText('HOARDLING').width);
    ctx.font = 'bold ' + fs.toFixed(1) + 'px Georgia, serif';
    var plateW = Math.max(300, ctx.measureText('HOARDLING').width + 44);
    var px = 210 - plateW / 2, py = 26, ph = 78, ch = 16;
    // THE CHAINS MUST REACH THE TOP OF THE SCREEN, not the top of the design
    // box. Three links from y 2 to y 20 hang the plate from the box's ceiling —
    // and on a 19.5:9 phone the box's ceiling is 65 world units BELOW the top of
    // the screen, so the sign hung from two short chains floating in mid-air
    // with painted cave above them. Walk UP from the plate instead, past the
    // screen edge, and the count follows the phone.
    var chTop = -(v.oy || 0) - 12;
    for (var cxi = 0; cxi < 2; cxi++) {
      var chx = cxi ? 285 : 135;
      var cg = ctx.createLinearGradient(0, chTop, 0, py);
      cg.addColorStop(0, '#8f7038'); cg.addColorStop(1, '#d4a840');
      ctx.strokeStyle = cg; ctx.lineWidth = 2;
      for (var lky = py - 6; lky > chTop; lky -= 9) {
        ctx.beginPath(); ctx.ellipse(chx, lky, 3.5, 4.5, 0, 0, 6.283); ctx.stroke();
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
    ctx.font = 'bold '+Math.max(10,10.5*u)+'px system-ui, sans-serif';
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
    var mound = this._slotPlate('hoard', 'mound');
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
    var wick = this._myPlate(ART.images.hero_title || ART.images.hero);
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
      // KEYED ON THE PLATE OBJECT. This was cached under NO key at all, so the
      // title screen kept the front lip of whichever hoard skin happened to
      // paint first -- equip Gem Seam from the Cavern, come back, and the pile
      // was gems with a Coin Bank lip. Object identity is the right key rather
      // than the item id, because it also catches the loading-fallback ->
      // decoded-art swap that an id would miss; _propPlate and _bandPlate both
      // memoize, so the reference is stable per item and this cannot thrash.
      var lip = (this._titleLipSrc === mound) ? this._titleLip : null;
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
        this._titleLip = lip; this._titleLipSrc = mound;
      }
      ctx.drawImage(lip, lX, 300 - lH * 0.22, lW, lH * 0.22);
    }
    embers(ctx, t, 18, 22, 1.4, 0.70);         // near-field parallax layer

    ctx.font = 'italic 16px Georgia, serif';
    inkText(ctx, 'Too young for dragonfire. Built his own.', 210, 326, '#ffb469', 5, 2);

    ctx.restore();

    // ---- 5. sections ------------------------------------------------------
    // NO HAIRLINE RULES. Two lines with a word in the gap is ornament doing a
    // job contrast does better, on a screen already carrying a gold wordmark,
    // an ember ladder and a cold pair.
    function sectionLabel(y, label, col) {
      ctx.textAlign = 'center';
      ctx.font = 'bold '+Math.max(10,10.5*u)+'px system-ui, sans-serif';
      ctx.fillStyle = col;
      ctx.fillText(label, 210, y + 4);
    }
    sectionLabel(G.ruleY, 'CAMPAIGN', 'rgba(212,168,64,0.55)');

    // Resume a saved workshop, then favor unplayed keeps before star replays.
    var next = this._nextLevel();
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
      // ONLY THE NEXT ROW IS EMBER in variants 1 and 2. Three identical lit
      // plates make the player read all three to find the one to press; one lit
      // plate among quiet ones is the same information with no reading.
      // ONLY THE NEXT ROW IS EMBER. Three identical lit plates made the player
      // read all three to find the one to press; one lit plate among quiet ones
      // is the same information with no reading.
      var tone = !open ? 'lock' : (li === next) ? 'ember' : 'util';
      forgePlate(ctx, r, tone);
      numeralSeal(ctx, r.x + 2, r.y + r.h / 2, li + 1, open);
      ctx.textAlign = 'left';
      ctx.font = 'bold 17px system-ui, sans-serif';
      if (open) {
        var big = !!r.big;
        if (big) {
          // the CONTINUE row says what pressing it does, above the map's name
          // OFF THE ROW'S CENTRE, not off its top. These were 22 and 44,
          // written when the CONTINUE row was 60 tall; it stretches with the
          // screen now, so a constant offset stops being centred the moment the
          // phone is not the design box. The pair reads as one block whose
          // optical centre is r.h/2: cap-top 22-7=15 and baseline 44 straddle
          // 30 at h 60, which is what these two numbers preserve.
          var bc = r.y + r.h / 2;
          ctx.font = 'bold '+Math.max(10,10.5*u)+'px system-ui, sans-serif';
          var checkpoint = this.campaignCheckpoint();
          inkText(ctx, checkpoint && checkpoint.level === li ? 'RESUME · WAVE ' + checkpoint.wave : (Save.data.stars[li] | 0) > 0 ? 'PLAY AGAIN' : li===0?'BEGIN HERE':'CONTINUE CAMPAIGN',
                  r.x + 30, bc - 8, 'rgba(255,226,170,0.9)', 3, 1);
          ctx.font = 'bold '+Math.max(18,14*u)+'px system-ui, sans-serif';
          inkText(ctx, MAPS[li].name, r.x + 30, bc + 14, '#fff6e6', 4, 1.5);
        } else {
          ctx.font = 'bold '+Math.max(15,13*u)+'px system-ui, sans-serif';
          inkText(ctx, MAPS[li].name, r.x + 30, r.y + r.h / 2 - 2*u,
                  'rgba(240,228,208,0.88)', 4, 1.5);
          ctx.font = Math.max(11,10.5*u)+'px system-ui, sans-serif';
          inkText(ctx, (Save.data.stars[li]|0)>=3 ? 'Keep mastered · replay' : 'Replay for more stars',
                  r.x + 30, r.y + r.h / 2 + 13*u, '#b5a68e', 3, 1);
        }
        // THE RIVETS BIT A SECOND TIME. forgePlate strikes four at x+11 and
        // x+w-11 (r 2.4); the third star sat at x+w-18 with r 10, so its right
        // shoulder ran under BOTH right-hand rivets and they read as two loose
        // dots stuck to the star -- which is what VANUS saw. Same defect as the
        // pill labels, on a different plate. The cluster ends at x+w-28 now, so
        // the star's edge clears the rivet by 4.6 at the big radius.
        for (var si = 0; si < 3; si++) {
          starCoin(ctx, r.x + r.w - 72 + si * 22, r.y + r.h / 2, big ? 10 : 9,
                   si < (Save.data.stars[li] | 0));
        }
      } else {
        // BASELINES OFF THE ROW, NOT OFF 0. These were 27 and 42, written when
        // every row was 52 tall; a compact variant-1/3 row is 40, so the second
        // line printed 2 units BELOW its own plate and onto whatever came next.
        // The current save has no locked row, which is the only reason nobody
        // saw it -- stars [3,0,0] puts a locked row on the screen at once.
        var lc = r.y + r.h / 2;
        ctx.fillStyle = '#b5a68e';
        ctx.font = 'bold '+Math.max(15,13*u)+'px system-ui, sans-serif';
        ctx.fillText(MAPS[li].name, r.x + 30, lc - 2*u);
        ctx.font = Math.max(11,10.5*u)+'px system-ui, sans-serif';
        ctx.fillStyle = '#a4937a';
        // say WHAT unlocks it — a bare padlock is a dead end
        ctx.fillText('win keep ' + li + ' to unlock', r.x + 30, lc + 13*u);
        lockGlyph(ctx, r.x + r.w - 32, r.y + r.h / 2, 1.25, '#6b5b4c');
      }
      ctx.textAlign = 'center';
    }

    sectionLabel(G.tonightY, 'CHALLENGES', 'rgba(157,138,214,0.62)');
    var D = G.daily, DU = G.duel;
    var dcx = D.x + D.w / 2, ducx = DU.x + DU.w / 2;
    // THE THREE LINES ARE CENTRED AS A BLOCK, not hung off the plate's top. At
    // 33/48/60 in a 66-tall plate the block ran 21.5..62.5 -- 21.5 units of air
    // above it and 3.5 below, which is what VANUS saw as "empty space above".
    // Solved off the plate's own height so it stays centred as the plate
    // stretches: the 16/11/10 stack spans capHeight 11.5 above the top baseline
    // to descender 2.5 below the last, and the two are 30 apart, so the top
    // baseline sits at h/2 - 10.5. At h 66 that is 22.5, and MEASURED margins
    // come out 9 and 12 against the 21.5/3.5 they replace.
    var TT = D.y + D.h / 2 - 11*u, TN = TT + 17*u, TS = TT + 32*u;
    forgePlate(ctx, D, 'cold');
    ctx.font = 'bold '+Math.max(16,13*u)+'px system-ui, sans-serif';
    inkText(ctx, 'DAILY SIEGE', dcx, TT, '#f0eaff', 5, 2);
    // NO WORLD-BEST FETCH HERE. It read the top row into `self._lbTop`, and the
    // only thing that ever DREW _lbTop was deleted at 28d1e56 -- so every fresh
    // visitor's first sight of the title fired Lb.top -> ensureSession ->
    // POST /auth/v1/signup, minting a Supabase account to render nothing. It
    // burned the signup quota to 429. Restore the row before restoring the call.
    // CAPTIONS INSIDE THE PLATE when there is room for them. Floating under it
    // they read as loose text belonging to the page rather than to the button,
    // and they were the only unhoused type on the screen.
    ctx.font = Math.max(11,10.5*u)+'px system-ui, sans-serif';
    var todayBest = (Save.data.daily.day === dayNumber()) ? Save.data.daily.best : 0;
    var dl2 = todayBest ? 'your best wave ' + todayBest
      : (Save.data.dailyBestWave > 0 ? 'all-time wave ' + Save.data.dailyBestWave : 'endless survival');
    // NO 648/662 FALLBACK. Those were absolute world y values for a caption
    // floating under a short plate, and the plate is never short now -- but an
    // absolute y under a plate that MOVES is a caption stranded mid-screen, so
    // the branch goes rather than waiting to be right once.
    inkText(ctx, 'A fresh challenge', dcx, TN, '#c9b8ff', 4, 1);
    ctx.font = Math.max(10,10.5*u)+'px system-ui, sans-serif';
    inkText(ctx, dl2, dcx, TS, 'rgba(201,184,255,0.75)', 4, 1);
    ctx.font = Math.max(11,10.5*u)+'px system-ui, sans-serif';

    // ---- the DUEL plate ---------------------------------------------------
    forgePlate(ctx, DU, 'cold');
    ctx.font = 'bold '+Math.max(16,13*u)+'px system-ui, sans-serif';
    // NO CROSSED MARK. It hung off the plate's left edge while its title stayed
    // centred, so the DUEL plate read as lopsided beside a DAILY SIEGE plate
    // that carries no mark at all -- one ornament buying an asymmetry across a
    // matched pair. "same waves, two caves" already says what the mark said.
    var UT = DU.y + DU.h / 2 - 11*u, UN = UT + 17*u, US = UT + 32*u;
    inkText(ctx, 'DUEL', ducx, UT, '#ffd9c4', 5, 2);
    var beaten = 0;
    for (var rvi = 0; rvi < RIVAL_ORDER.length; rvi++) {
      var rvr = Save.data.duels[RIVAL_ORDER[rvi]];
      if (rvr && rvr.w) beaten++;
    }
    ctx.font = Math.max(11,10.5*u)+'px system-ui, sans-serif';
    // NOT "two caves". The duel is ONE cavern split down the middle, a keep and
    // a road each, both dragons on screen -- and "two caves" is the inset
    // shape VANUS rejected twice on the way to this one ("I don't see another
    // dragon that's fighting against me"). The button was still selling it.
    inkText(ctx, 'Against AI rivals', ducx, UN, '#ffc9a8', 4, 1);
    ctx.font = Math.max(10,10.5*u)+'px system-ui, sans-serif';
    inkText(ctx, beaten ? 'beaten ' + beaten + '/' + RIVAL_ORDER.length : 'four rivals waiting',
            ducx, US, 'rgba(255,201,168,0.75)', 4, 1);

    // ---- 6. utility row ---------------------------------------------------
    var fAvail = Save.starsTotal() - Save.forgeSpent();
    var anyWon = Save.starsTotal() > 0;
    var tDone = 0;
    for (var tb = 0; tb < 3; tb++) { var tRow = Save.data.trials[tb] || {}; for (var tk in tRow) tDone++; }
    // VARIANT 3: ONE plate under all four cells, hairline-divided. Four separate
    // chips were the screen's third UI family (after the ember ladder and the
    // cold Tonight pair) and the busiest of the three -- sixteen rivets, four
    // bevels and four shadows carrying eight words. One bar is one family, and
    // it buys the labels 65-91 units of clear track against the chips' 60,
    // which is what pays for the 11px type.
    if (G.bar) {
      forgePlate(ctx, G.bar, 'util');
      for (var dv = 1; dv < 4; dv++) {
        // the boundary a cell OWNS, so a divider can never drift off a cell edge
        var dx = G.pills[dv].x;
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(0,0,0,0.34)';
        ctx.beginPath(); ctx.moveTo(dx, G.bar.y + 11); ctx.lineTo(dx, G.bar.y + G.bar.h - 11); ctx.stroke();
        ctx.strokeStyle = 'rgba(255,214,140,0.10)';
        ctx.beginPath(); ctx.moveTo(dx + 1, G.bar.y + 11); ctx.lineTo(dx + 1, G.bar.y + G.bar.h - 11); ctx.stroke();
      }
    }
    var PF = Math.max(11,10.5*u);
    for (var pi = 0; pi < 4; pi++) {
      var pl = G.pills[pi];
      var live = pi === 1 ? anyWon : true;
      if (!G.bar) forgePlate(ctx, pl, 'util');
      var pcx = pl.x + pl.w / 2, pcy = pl.y + pl.h / 2;
      // TWO SHORT CENTRED LINES. The name never carries its number any more:
      // joined, they overflowed the 64px the rivets leave. Centred, the longest
      // name ("SOUND ON", ~48px at bold 10) and the longest number ("9000",
      // ~26px) both sit well clear of the corner rivets by construction.
      // At PF 11 the cap-height grows 1.5 units and the TRIALS glyph (drawn
      // ICO-7..ICO+7) landed exactly on the T. The bar has the room, so the
      // three lines spread rather than the icon shrinking.
      // THE STACK SPREADS WITH THE BAR. At the 56 it was authored for these are
      // 13/7/21; the bar stretches to ~71 on a 19.5:9 phone and a fixed stack
      // then floats in the middle of it with 12 units of air top and bottom.
      // Capped, because past ~1.25 the icon and the value stop reading as one
      // cell and start reading as two rows.
      var pk = Math.min(1.25, pl.h / 56);
      var nameY = pcy + 7 * pk, numY = pcy + 21 * pk, ICO = pcy - 13 * pk;
      ctx.font = 'bold ' + PF + 'px system-ui, sans-serif';
      if (pi === 0) {
        starCoin(ctx, pcx, ICO, Math.max(8,7*u), true);
        inkText(ctx, 'FORGE', pcx, nameY,
                '#ffe9c4', 3, 1);
        ctx.font=Math.max(10,10.5*u)+'px system-ui, sans-serif';
        inkText(ctx, fAvail>0?fAvail+' stars':'Upgrades', pcx, numY, fAvail>0?'#ffd75e':'#beac8d', 3, 1);
      } else if (pi === 1) {
        ctx.strokeStyle = live ? 'rgba(217,242,255,0.9)' : 'rgba(138,127,114,0.7)';
        ctx.lineWidth = 2;
        rr(ctx, pcx - 8, ICO - 7, 16, 14, 3); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(pcx - 4, ICO - 3); ctx.lineTo(pcx + 4, ICO - 3);
        ctx.moveTo(pcx - 4, ICO + 2); ctx.lineTo(pcx + 4, ICO + 2); ctx.stroke();
        // 6 trials x 3 levels = 18 badges. '/9' dated from when there were
        // three trials and quietly told the player they were twice as done
        // as they were — and it can never be reached, so it reads as broken.
        ctx.font = 'bold ' + PF + 'px system-ui, sans-serif';
        inkText(ctx, 'TRIALS', pcx, nameY, live ? '#d9f2ff' : '#8a7f72', 3, 1);
        if (live) inkText(ctx, tDone + '/' + (TRIAL_ORDER.length * CAMPAIGN_MAPS),
                          pcx, numY, 'rgba(217,242,255,0.75)', 3, 1);
        else {ctx.font=10.5*u+'px system-ui, sans-serif';inkText(ctx,'Win a keep',pcx,numY,'#a89980',3,1);}
      } else if (pi === 2) {
        // the wallet is the label: a shop with nothing in the purse should say
        // so on the door rather than after the tap
        var mk = Save.data.marks | 0;
        drawCoin(ctx, pcx, ICO, G.bar ? 11 : 9, Save.equipped('coin'));
        ctx.font = 'bold ' + PF + 'px system-ui, sans-serif';
        inkText(ctx, 'CAVERN', pcx, nameY,
                '#ffe9c4', 3, 1);
        var wallet=mk>=1000000?(Math.floor(mk/100000)/10)+'m':mk>=10000?Math.floor(mk/1000)+'k':String(mk);
        ctx.font=10.5*u+'px system-ui, sans-serif';inkText(ctx,mk>0?wallet+' marks':'Styles',pcx,numY,mk>0?'#ffd75e':'#beac8d',3,1);
      } else {
        drawSpeaker(ctx, pcx - 4, ICO, Sfx.isMuted());
        ctx.font = 'bold ' + PF + 'px system-ui, sans-serif';
        inkText(ctx, 'SOUND', pcx, nameY, '#ffe9c4', 3, 1);
        inkText(ctx, Sfx.isMuted() ? 'OFF' : 'ON', pcx, numY,
                Sfx.isMuted() ? 'rgba(255,233,196,0.55)' : '#9ef58f', 3, 1);
      }
    }

    // ---- 7. the legal links ------------------------------------------------
    // The boot overlay's Privacy / Terms pair, kept: same cream, small caps on
    // the section-label face, a hairline underline so they read as links rather
    // than as a caption belonging to the art.
    ctx.font = 'bold '+10.5*u+'px system-ui, sans-serif';
    for (var lgd = 0; lgd < G.legal.length; lgd++) {
      var LG = G.legal[lgd], lgx = LG.x + LG.w / 2, lgb = LG.y + LG.h / 2 + 4;
      ctx.textAlign = 'center';
      inkText(ctx, LG.label, lgx, lgb, 'rgba(255,233,196,0.78)', 4, 1);
      var lgw = ctx.measureText(LG.label).width;
      ctx.fillStyle = 'rgba(255,233,196,0.34)';
      ctx.fillRect(lgx - lgw / 2, lgb + 3, lgw, 1);
    }
    ctx.textAlign = 'left';
  };


  // ===== THE CAVERN — the cosmetics shop =================================
  /// ONE GEOMETRY, TWO READERS -- the same law _titleGeom/trialGeom/duelGeom
  /// follow. Everything the tap handler tests is computed here and nowhere
  /// else, so a card cannot be drawn somewhere its hit box is not.
  ///
  /// Rows are sized off view.scale so every card clears the 44pt floor BY
  /// CONSTRUCTION rather than by a number somebody measured once on one phone.
  function cavernRoomGeom(v) {
    var s = (v && v.scale) || 1, minH = Math.max(62, 44 / s);
    var tabs = [], i;
    // RE-DERIVED FOR SIX, NOT EXTENDED. The 5-tab pitch was `12 + i * 80` with
    // w 74; a sixth on that pitch ends at x=486 in a 420-wide world and would
    // simply not be on screen -- silently, which is how the shop shelf lost its
    // 8th chip and how the 4th title pill would have gone. Six tabs, 12px
    // margins, 6px gutters: (420 - 24 - 5*6) / 6 = 61.
    var TW = Math.floor((WORLD_W - 24 - (SLOTS.length - 1) * 6) / SLOTS.length);
    var TP = TW + 6;
    for (i = 0; i < SLOTS.length; i++) {
      var tx = 12 + i * TP;
      tabs.push({ x: tx, y: 142, w: TW, h: 38,
                  hx: tx - 3, hy: 142 - (minH - 38) / 2, hw: TP, hh: minH });
    }
    // THE GRID WAS A HARDCODED 8, and DRAGON already holds exactly 8 coats:
    // one more and the ninth would be silently INVISIBLE and UNBUYABLE, since
    // the drawer caps at G.cards.length and so does the tap. Same class as the
    // tab-pitch trap the comment above describes, one entry away from firing.
    // Derived from the room instead, so a tall phone shows a fifth row (ten
    // cards) rather than leaving 115 world units of dead black under BACK --
    // and check_cavern_capacity fails the build if the SMALLEST screen can no
    // longer hold the fullest slot.
    var backY = roomBackY(v, 40);
    var CARD_TOP = 324, CARD_PITCH = 88, CARD_H = 78;
    var maxItems = 0;
    for (i = 0; i < SLOTS.length; i++) {
      var lst = SLOTS[i].items;
      if (lst && lst.length > maxItems) maxItems = lst.length;
    }
    var band = backY - 30 - CARD_TOP;
    var fitRows = Math.max(1, Math.floor((band + (CARD_PITCH - CARD_H)) / CARD_PITCH));
    var rowsN = Math.min(fitRows, Math.ceil(maxItems / 2));
    // THE SLACK SPLITS. A slot that needs fewer rows than the screen can hold
    // (every slot but DRAGON) would otherwise leave all of it in one lump above
    // BACK, which is the same "looks broken" the bottom anchor was for.
    var gridTop = CARD_TOP + Math.max(0, (band - (rowsN * CARD_PITCH - (CARD_PITCH - CARD_H))) / 2);
    var cards = [];
    for (i = 0; i < rowsN * 2; i++) {
      var cx = 12 + (i % 2) * 200, cy = gridTop + Math.floor(i / 2) * CARD_PITCH;
      cards.push({ x: cx, y: cy, w: 190, h: CARD_H,
                   hx: cx - 4, hy: cy - Math.max(0, (minH - CARD_H) / 2), hw: 198,
                   hh: Math.max(CARD_H, minH) });
    }
    return {
      tabs: tabs, cards: cards,
      preview: { x: 12, y: 188, w: 396, h: 128 },
      action: { x: 174, y: 248, w: 220, h: Math.max(58, 44 / v.scale),
        hx: 174, hy: 248, hw: 220, hh: Math.max(58, 44 / v.scale) },
      // the wallet chip, and the shelf a store would live on (see topUp)
      wallet: { x: 12, y: 104, w: 200, h: 30 },
      // THE STORE CHIP HAS NO HIT RECT UNTIL THERE IS A STORE, because there
      // is no tap site for it either -- a rect nothing tests is fiction, and
      // this one MEASURES as an overlap: inflated it is y 88..150 against the
      // slot tabs' 130..192, so tabs 4 and 5 share 48x20 and 67x20 world units
      // with it. The tabs are tested first, so flipping STORE_ON would hand
      // the ROAD and WORKS tabs the top 32% of the chip.
      // SO THE CLAIM ABOVE IS FALSE BY 20 UNITS: reserving the space now is
      // NOT the same as not needing a re-layout later. Turning the flag on
      // needs the wallet row moved to y 84, and tools/tap_rooms.js fails the
      // moment the flag moves so nobody has to remember this.
      topUp:  STORE_ON
        ? { x: 300, y: 104, w: 108, h: 30,
            hx: 296, hy: 104 - (minH - 30) / 2, hw: 116, hh: minH }
        : { x: 300, y: 104, w: 108, h: 30 },
      back:   { x: WORLD_W / 2 - 70, y: backY, w: 140, h: 40,
                hx: WORLD_W / 2 - 78, hy: backY - Math.max(0, (minH - 40) / 2),
                hw: 156, hh: Math.max(40, minH) },
    };
  }

  /// THE STORE SHELF IS RESERVED, NOT BUILT. Marks are earned-only today.
  /// Flipping this to true draws a "MORE MARKS" chip that opens a purchase
  /// sheet -- and that sheet needs a store console to exist first (there is no
  /// App Store record for this bundle while the Apple migration is open, and no
  /// Play Billing plugin yet). The layout reserves the space now
  /// so turning it on is not a re-layout later.
  var STORE_ON = false;

  function hoardMarkGlyph(ctx,x,y,r) {
    ctx.save();ctx.translate(x,y);ctx.fillStyle='#315351';ctx.strokeStyle='#c6ae79';ctx.lineWidth=1.5;
    ctx.beginPath();for(var i=0;i<8;i++){var a=(i+.5)*Math.PI/4;ctx.lineTo(Math.cos(a)*r,Math.sin(a)*r);}ctx.closePath();ctx.fill();ctx.stroke();
    ctx.fillStyle='#bad9c5';ctx.beginPath();ctx.moveTo(0,-r*.6);ctx.lineTo(r*.38,0);ctx.lineTo(0,r*.6);ctx.lineTo(-r*.38,0);ctx.closePath();ctx.fill();ctx.restore();
  }
  Game.prototype._cavernSelection = function () {
    var slot = SLOTS[this.cavSlot | 0] || SLOTS[0], selected = this.cavInspect;
    return slot.items.find(function (it) { return it.id === selected; }) || Save.equipped(slot.id) || slot.items[0];
  };
  Game.prototype._cavernAction = function () {
    var slot = SLOTS[this.cavSlot | 0] || SLOTS[0], it = this._cavernSelection();
    var worn = Save.equipped(slot.id).id === it.id, owned = Save.owns(slot.id, it.id);
    var short = Math.max(0, it.price - (Save.data.marks | 0));
    return { title: worn ? 'Equipped' : owned ? 'Equip look' : short ? 'Need ' + short + ' more ' + (short === 1 ? 'mark' : 'marks') : 'Unlock · ' + it.price + ' marks',
      label: worn ? it.name + ' equipped' : owned ? 'Equip ' + it.name : 'Unlock and equip ' + it.name + ' for ' + it.price + ' earned marks' + (short ? '. Need ' + short + ' more ' + (short === 1 ? 'mark' : 'marks') : ''),
      disabled: worn || !owned && short > 0 };
  };
  Game.prototype._drawCavernRoom = function (ctx) {
    var G = cavernRoomGeom(this.view), i;
    var slot = SLOTS[this.cavSlot | 0] || SLOTS[0];
    ctx.fillStyle = 'rgba(12,7,5,0.88)';
    ctx.fillRect(-this.view.ox - 60, -this.view.oy - 60, this.view.w + 120, this.view.h + 120);
    ctx.textAlign = 'center';
    ctx.font = 'bold 26px Georgia, serif';
    inkText(ctx, 'YOUR CAVERN', WORLD_W / 2, 72, '#ffe9c4', 6, 2);
    // UNDER the title, not over it: at y 62 this ran through the serif
    // ascenders and both lines became unreadable.
    ctx.font = '11px system-ui, sans-serif';
    inkText(ctx, 'Preview a look. Equip it when you are ready.', WORLD_W / 2, 90,
            'rgba(255,201,168,0.6)', 4, 1);

    // ---- wallet -----------------------------------------------------------
    ctx.textAlign = 'left';
    hoardMarkGlyph(ctx, G.wallet.x + 15, G.wallet.y + 15, 12);
    ctx.font = 'bold 20px Georgia, serif';
    inkText(ctx, String(Save.data.marks | 0), G.wallet.x + 34, G.wallet.y + 22, '#ffe9c4', 4, 1);
    ctx.font = 'bold 10px system-ui, sans-serif';
    inkText(ctx, 'HOARD MARKS', G.wallet.x + 34 + ctx.measureText(String(Save.data.marks | 0)).width + 34,
            G.wallet.y + 21, 'rgba(185,162,127,0.9)', 3, 1);
    if (STORE_ON) {
      forgePlate(ctx, G.topUp, 'util');
      ctx.textAlign = 'center'; ctx.font = 'bold 11px system-ui, sans-serif';
      inkText(ctx, 'MORE MARKS', G.topUp.x + G.topUp.w / 2, G.topUp.y + 19, '#ffe9c4', 3, 1);
    }

    // ---- slot tabs --------------------------------------------------------
    ctx.textAlign = 'center';
    for (i = 0; i < SLOTS.length; i++) {
      var tb = G.tabs[i], on = i === (this.cavSlot | 0);
      ctx.fillStyle = on ? 'rgba(120,78,34,0.85)' : 'rgba(38,26,20,0.85)';
      rr(ctx, tb.x, tb.y, tb.w, tb.h, 8); ctx.fill();
      ctx.strokeStyle = on ? 'rgba(255,215,110,0.9)' : 'rgba(120,100,78,0.5)';
      ctx.lineWidth = on ? 2 : 1;
      rr(ctx, tb.x, tb.y, tb.w, tb.h, 8); ctx.stroke();
      ctx.font = 'bold 10px system-ui, sans-serif';
      inkText(ctx, SLOTS[i].name, tb.x + tb.w / 2, tb.y + 17,
              on ? '#ffe9c4' : 'rgba(200,180,150,0.75)', 3, 1);
      // OWNED / TOTAL, so the tab says whether there is anything to look at
      var own = 0;
      for (var oi = 0; oi < SLOTS[i].items.length; oi++) {
        if (Save.owns(SLOTS[i].id, SLOTS[i].items[oi].id)) own++;
      }
      ctx.font = 'bold 9px system-ui, sans-serif';
      inkText(ctx, own + '/' + SLOTS[i].items.length, tb.x + tb.w / 2, tb.y + 30,
              on ? 'rgba(255,233,196,0.8)' : 'rgba(185,162,127,0.6)', 3, 1);
    }

    // Inspecting a card is free and never changes the equipped loadout.
    var P = G.preview, eq = Save.equipped(slot.id), selected = this._cavernSelection(), action = this._cavernAction();
    uiPanel(ctx, P.x, P.y, P.w, P.h, 12);
    this._drawCosPreview(ctx, slot.id, selected, {x:P.x+2,y:P.y+6,w:150,h:116});
    ctx.textAlign = 'left'; ctx.font = 'bold 17px Georgia, serif';
    inkText(ctx, fitText(ctx, selected.name, 218), G.action.x, P.y + 27, '#ffe9c4', 4, 1);
    ctx.font = '12px system-ui, sans-serif';
    inkText(ctx, slot.id === 'coat' ? 'Wick’s scale colour' : selected.how ? fitText(ctx, selected.how, 216) : 'A new look for your cavern',
      G.action.x, P.y + 46, '#c3b29b', 3, 1);
    ctx.fillStyle = action.disabled ? '#302b26' : '#634829';
    rr(ctx,G.action.x,G.action.y,G.action.w,G.action.h,9);ctx.fill();
    ctx.strokeStyle = action.disabled ? '#77644b' : '#d5ad65';ctx.lineWidth=1.4;
    rr(ctx,G.action.x,G.action.y,G.action.w,G.action.h,9);ctx.stroke();
    ctx.textAlign='center';ctx.font='bold 15px system-ui, sans-serif';
    inkText(ctx,action.title,G.action.x+G.action.w/2,G.action.y+G.action.h/2+5,action.disabled?'#c5b7a3':'#ffedc8',3,1);

    // ---- the shelf --------------------------------------------------------
    for (i = 0; i < slot.items.length && i < G.cards.length; i++) {
      var it = slot.items[i], cd = G.cards[i];
      var owned = Save.owns(slot.id, it.id), worn = eq && eq.id === it.id;
      var afford = (Save.data.marks | 0) >= it.price;
      var inspecting = selected.id === it.id;
      ctx.fillStyle = inspecting ? 'rgba(83,65,39,0.95)' : 'rgba(30,25,21,0.95)';
      rr(ctx, cd.x, cd.y, cd.w, cd.h, 10); ctx.fill();
      ctx.strokeStyle = inspecting ? 'rgba(255,215,110,0.95)'
                      : owned ? 'rgba(150,126,96,0.7)' : 'rgba(90,76,60,0.5)';
      ctx.lineWidth = inspecting ? 2 : 1;
      rr(ctx, cd.x, cd.y, cd.w, cd.h, 10); ctx.stroke();
      // swatch
      this._drawCosSwatch(ctx, slot.id, it, cd.x + 34, cd.y + cd.h / 2, 24);
      ctx.textAlign = 'left';
      ctx.font = 'bold 14px Georgia, serif';
      inkText(ctx, fitText(ctx, it.name, cd.w-72), cd.x + 64, cd.y + 28,
              owned ? '#ffe9c4' : 'rgba(230,214,190,0.85)', 3, 1);
      ctx.font = 'bold 10px system-ui, sans-serif';
      if (worn) {
        inkText(ctx, 'EQUIPPED', cd.x + 64, cd.y + 48, '#ffd75e', 3, 1);
      } else if (owned) {
        inkText(ctx, inspecting ? 'PREVIEWING' : 'OWNED · PREVIEW', cd.x + 64, cd.y + 48, 'rgba(217,242,255,0.9)', 3, 1);
      } else {
        inkText(ctx, it.price + ' MARKS', cd.x + 64, cd.y + 48,
                afford ? '#ffe9c4' : 'rgba(200,120,100,0.9)', 3, 1);
        if (!afford) {
          ctx.font = 'bold 9px system-ui, sans-serif';
          inkText(ctx, 'need ' + (it.price - (Save.data.marks | 0)) + ' more', cd.x + 64, cd.y + 63,
                  'rgba(200,120,100,0.75)', 3, 1);
        }
      }
      ctx.textAlign = 'center';
    }

    ctx.textAlign='center';ctx.font='11px system-ui, sans-serif';
    inkText(ctx,'Earn marks from stars, trials, rivals and Daily Siege.',WORLD_W/2,G.back.y-18,'#b8aa95',3,1);

    // ---- back -------------------------------------------------------------
    forgePlate(ctx, G.back, 'util');
    ctx.font = 'bold 13px system-ui, sans-serif';
    inkText(ctx, 'BACK', G.back.x + G.back.w / 2, G.back.y + 26, '#ffe9c4', 3, 1);
    ctx.textAlign = 'left';
  };

  /// Big preview for the selected slot. Every branch falls back to the swatch
  /// if its art has not loaded -- the Cavern must open on a cold cache.
  Game.prototype._drawCosPreview = function (ctx, slot, it, P) {
    var cx = P.x + P.w / 2, cy = P.y + 8;
    ctx.save();
    ctx.beginPath(); rr(ctx, P.x + 2, P.y + 2, P.w - 4, P.h - 4, 10); ctx.clip();
    if (slot === 'coat') {
      var hi = this._coatPlate(ART.images.hero_title || ART.images.hero, it);
      if (hi) {
        var hh = 96, hw = hh * (hi.width / hi.height);
        ctx.drawImage(hi, cx - hw / 2, cy, hw, hh);
      }
    } else if (slot === 'finish') {
      this._drawMachinePortrait(ctx, 'ballista', 1, 0, {x:P.x+8,y:P.y+4,w:P.w-16,h:P.h-12}, it);
    } else if (slot === 'coin') {
      drawCoin(ctx, cx, cy + 46, 40, it);
    } else if (slot === 'road') {
      var ri = this._itemPlate(it, SLOT_BY_ID.road.base);
      if (ri) {
        for (var tx = P.x + 6; tx < P.x + P.w - 6; tx += 46) {
          ctx.drawImage(ri, tx, cy + 12, 46, 46);
        }
      }
    } else {
      var ii = this._itemPlate(it, (SLOT_BY_ID[slot] || {}).base);
      if (ii) {
        var ph = 92, pw = ph * (ii.width / ii.height);
        if (pw > P.w - 24) { pw = P.w - 24; ph = pw * (ii.height / ii.width); }
        ctx.drawImage(ii, cx - pw / 2, cy + (92 - ph), pw, ph);
      }
    }
    ctx.restore();
  };

  /// Card swatch. Small, and it must read at 24px: a coat is its scale colour,
  /// a prop is its tint, and the stock entry of every slot is drawn in the
  /// game's own gold so "the one you already had" is never a grey blank.
  Game.prototype._drawCosSwatch = function (ctx, slot, it, cx, cy, r) {
    if (slot === 'coin') { drawCoin(ctx, cx, cy, r, it); return; }
    if (slot === 'coat') {
      var wick = this._coatPlate(ART.images.hero || ART.images.hero_title, it);
      if (wick) { var h = r*2.6, w = h*wick.width/wick.height;ctx.drawImage(wick,cx-w/2,cy-h/2,w,h);return; }
    }
    if (slot === 'finish') { this._drawMachinePortrait(ctx,'ballista',1,0,{x:cx-r*1.2,y:cy-r*1.2,w:r*2.4,h:r*2.4},it);return; }
    // THE SWATCH SHOWS THE THING ITSELF wherever it can -- a coloured ball
    // beside a card called "Gem Seam" is a worse answer than the pile, and the
    // stock entry has no art of its own because it IS the slot's base sprite.
    var sb = SLOT_BY_ID[slot];
    var si = (sb && sb.base) ? this._itemPlate(it, sb.base) : null;
    if (!si && it.art && ART.images[it.art]) si = ART.images[it.art];
    if (si) {
      var sw = r * 2.3, sh = sw * (si.height / si.width);
      if (sh > r * 2.1) { sh = r * 2.1; sw = sh * (si.width / si.height); }
      ctx.drawImage(si, cx - sw / 2, cy - sh / 2, sw, sh);
      return;
    }
    var col;
    if (slot === 'coat') {
      col = it.hue === null || it.hue === undefined ? '#e0431a'
            : hsvHex(it.hue, Math.min(1, 0.92 * it.sat), Math.min(1, 0.72 * it.val));
    } else {
      col = it.tint || '#ffd75e';
    }
    var g = ctx.createRadialGradient(cx - r * 0.4, cy - r * 0.4, r * 0.1, cx, cy, r * 1.1);
    g.addColorStop(0, '#ffffff'); g.addColorStop(0.3, col); g.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 6.283); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, 6.283); ctx.stroke();
  };

  function hsvHex(h, s, v) {
    var i = Math.floor(h * 6), f = h * 6 - i;
    var p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
    var r, g, b;
    switch (i % 6) {
      case 0: r = v; g = t; b = p; break;
      case 1: r = q; g = v; b = p; break;
      case 2: r = p; g = v; b = t; break;
      case 3: r = p; g = q; b = v; break;
      case 4: r = t; g = p; b = v; break;
      default: r = v; g = p; b = q;
    }
    function h2(x) { var n = Math.round(x * 255).toString(16); return n.length < 2 ? '0' + n : n; }
    return '#' + h2(r) + h2(g) + h2(b);
  }

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
    var FG = forgeGeom(v);
    for (var i = 0; i < FG.rows.length; i++) {
      var node = FORGE_NODES[i], ry = FG.rows[i].y;
      var cur = Save.data.forge[node.id] | 0;
      uiPanel(ctx, 26, ry, WORLD_W - 52, FG.rows[i].h, 11);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#fff2d8'; ctx.font = 'bold 15px system-ui, sans-serif';
      // OFF THE ROW'S CENTRE, not its top. These were 24/43/54, written for a
      // 62-tall row; the row grows to 92 on a tall phone now, and constants
      // would leave the three lines hugging the top of it. At h 62 the derived
      // values are 24, 43 and 54 exactly, so nothing moves on the design box.
      var rc = ry + FG.rows[i].h / 2;
      ctx.fillText(node.name, 42, rc - 7);
      ctx.fillStyle = '#b9a27f'; ctx.font = '12px system-ui, sans-serif';
      ctx.fillText(node.desc, 42, rc + 12);
      for (var rp2 = 0; rp2 < node.ranks; rp2++) {
        ctx.fillStyle = rp2 < cur ? '#ffd75e' : 'rgba(255,215,94,0.2)';
        ctx.beginPath(); ctx.arc(42 + rp2 * 16, rc + 23, 4, 0, 6.283); ctx.fill();
      }
      var can = cur < node.ranks && avail > 0;
      var fbtn = FG.rows[i].btn;
      ctx.fillStyle = can ? 'rgba(214,69,69,0.9)' : 'rgba(70,52,44,0.7)';
      rr(ctx, fbtn.x, fbtn.y, fbtn.w, fbtn.h, 10); ctx.fill();
      ctx.fillStyle = can ? '#fff' : '#8a7f72';
      ctx.font = 'bold 14px system-ui, sans-serif'; ctx.textAlign = 'center';
      ctx.fillText(cur >= node.ranks ? 'MAX' : 'FORGE ★',
                   fbtn.x + fbtn.w / 2, fbtn.y + fbtn.h / 2 + 5);
      ctx.textAlign = 'left';
    }
    ctx.textAlign = 'center';
    var FR = FG.respec, FB = FG.back;
    ctx.fillStyle = 'rgba(80,60,140,0.9)';
    rr(ctx, FR.x, FR.y, FR.w, FR.h, 10); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 14px system-ui, sans-serif';
    ctx.fillText('RESPEC (free)', FR.x + FR.w / 2, FR.y + FR.h / 2 + 5);
    ctx.fillStyle = 'rgba(214,69,69,0.9)';
    rr(ctx, FB.x, FB.y, FB.w, FB.h, 10); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText('BACK', FB.x + FB.w / 2, FB.y + FB.h / 2 + 5);
    ctx.textAlign = 'left';
  };

  Game.prototype._drawDuelSelect = function (ctx) {
    var v = this.view, DG = duelGeom(v);
    ctx.fillStyle = 'rgba(12,7,5,0.85)';
    ctx.fillRect(-v.ox - 60, -v.oy - 60, v.w + 120, v.h + 120);
    ctx.textAlign = 'center';
    // A SCRIM UNDER THE HEADER. The 0.85 page wash is not enough on its own:
    // this screen sits over the title room, so the three lines of copy land on
    // the painted keep and its gold, which is the busiest, brightest patch on
    // the screen. A soft vertical fade behind just the header block keeps the
    // art visible and the words readable, without flattening the whole page.
    var hg = ctx.createLinearGradient(0, 96, 0, 224);
    hg.addColorStop(0, 'rgba(10,6,4,0)');
    hg.addColorStop(0.35, 'rgba(10,6,4,0.72)');
    hg.addColorStop(0.75, 'rgba(10,6,4,0.72)');
    hg.addColorStop(1, 'rgba(10,6,4,0)');
    ctx.fillStyle = hg; ctx.fillRect(0, 96, WORLD_W, 128);
    ctx.fillStyle = '#ffc9a8'; ctx.font = 'bold 28px Georgia, serif';
    ctx.fillText('DUEL · AI RIVALS', WORLD_W / 2, 142);
    ctx.fillStyle = '#e8cbb4'; ctx.font = '13px system-ui, sans-serif';
    // IT SAID "two caves". That is the shape VANUS rejected twice -- a second
    // board in an inset -- and the mode has been ONE cavern with two sides
    // since. Copy that describes the old format is the same lie as a dial that
    // no longer does anything.
    ctx.fillText('Face a computer rival in one shared cavern.', WORLD_W / 2, 172);
    ctx.fillText('Same raiders. Defend your side and keep more gold.', WORLD_W / 2, 188);
    ctx.fillStyle = 'rgba(232,203,180,0.6)'; ctx.font = '11px system-ui, sans-serif';
    // EIGHT. TOWER_ORDER gained `press` and neither this line nor
    // towerUnlocked's comment followed it, so the screen undersold the shelf it
    // actually hands you by one machine.
    ctx.fillText('The Split Cavern · ' + DUEL_WAVES + ' waves · no forge craft · all eight machines',
                 WORLD_W / 2, 208);

    for (var i = 0; i < RIVAL_ORDER.length; i++) {
      var rv = RIVALS[i], ry = DG.top + i * DG.pitch;
      var rec = Save.data.duels[rv.id];
      var ready = rivalReady(i);
      uiPanel(ctx, DG.x, ry, DG.w, DG.h, 11);
      ctx.textAlign = 'left';
      // name + rank
      // HER COLOUR, so four rivals read as four characters rather than four
      // rows of the same text. Locked rows stay grey -- the accent is a reward
      // for the row being live, not decoration on a row you cannot tap.
      ctx.fillStyle = ready ? (rv.tint || '#ffe4cf') : '#7a6a5c';
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
        ctx.fillStyle = lit ? (ready ? (rv.tint || 'rgba(255,150,60,0.95)') : 'rgba(120,104,90,0.8)')
                            : 'rgba(255,255,255,0.13)';
        ctx.beginPath(); ctx.arc(pipX + pp * 9, ry + 19, 3, 0, 6.283); ctx.fill();
      }
      // THE BLURB OWNS ITS WHOLE LINE. 'best margin +N' used to be right-aligned
      // on the SAME baseline, and that was not a near miss -- MEASURED at the
      // shipped fonts, the longest rival blurb ("Few machines, all of them
      // monsters. Wants a chokepoint.") is ~314px and the margin text ~78px, in
      // a track only 346px wide. A guaranteed ~46px collision on every beaten
      // rival with a long blurb, which is exactly what VANUS photographed.
      // The margin moved down to share the bottom baseline with 'tonight:',
      // where the row was empty anyway -- so the two can never meet again
      // whatever anybody writes in a blurb.
      ctx.fillStyle = ready ? 'rgba(232,203,180,0.8)' : 'rgba(122,106,92,0.8)';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(rv.blurb, DG.x + 14, ry + 46);
      // NO "tonight: <map>". The arena does NOT rotate -- every DUEL_ARENAS
      // entry is map 5, The Split Cavern, ON PURPOSE (the duel is one shared
      // cavern), so the line named the same ground on all four rows forever
      // while its own comment promised a daily rotation. What actually differs
      // per rival is the generator offset, and the header names the ground once.
      ctx.fillStyle = 'rgba(201,184,255,0.7)'; ctx.font = '10px system-ui, sans-serif';
      if (!ready) ctx.fillText('no plan yet', DG.x + 14, ry + DG.h - 10);
      // the badge: beaten, and by how much
      ctx.textAlign = 'right';
      if (rec && rec.w) {
        ctx.fillStyle = '#9ef58f'; ctx.font = 'bold 12px system-ui, sans-serif';
        ctx.fillText('BEATEN', DG.x + DG.w - 14, ry + 24);
        ctx.fillStyle = 'rgba(158,245,143,0.7)'; ctx.font = '10px system-ui, sans-serif';
        ctx.fillText('best margin +' + (rec.m | 0), DG.x + DG.w - 14, ry + DG.h - 10);
      } else if (ready) {
        ctx.fillStyle = 'rgba(255,201,168,0.85)'; ctx.font = 'bold 12px system-ui, sans-serif';
        ctx.fillText('FIGHT', DG.x + DG.w - 14, ry + 24);
      }
      ctx.textAlign = 'center';
    }
    // BACK WEARS THE PLATE EVERY OTHER ROOM'S BACK WEARS. It was bare text
    // here, which reads as a label rather than a control -- and this is the one
    // screen where the text sits over painted cavern floor instead of a panel.
    forgePlate(ctx, DG.back, 'util');
    ctx.textAlign = 'center';
    ctx.fillStyle = '#e8cbb4'; ctx.font = 'bold 15px system-ui, sans-serif';
    inkText(ctx, 'BACK', DG.back.x + DG.back.w / 2, DG.back.y + 26, '#e8cbb4', 3, 1);
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
      var TG = trialGeom(this.view);
      var key = TRIAL_ORDER[i], tr = TRIALS[key], ry = TG.top + i * TG.pitch;
      uiPanel(ctx, 26, ry, WORLD_W - 52, TG.h, 11);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#d9f2ff'; ctx.font = 'bold 15px system-ui, sans-serif';
      var textW = TG.textW;                   // stop before the L1 chip
      ctx.fillText(fitText(ctx, tr.name, textW), 42, ry + 24);
      ctx.fillStyle = '#b9a27f'; ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(fitText(ctx, tr.pitch, textW), 42, ry + 42);
      for (var lv2 = 0; lv2 < CAMPAIGN_MAPS; lv2++) {
        var chp = TG.chips[lv2], chx = chp.x;
        var wonLv = Save.data.stars[lv2] > 0;
        var badge = wonLv && Save.data.trials[lv2] && Save.data.trials[lv2][key];
        ctx.fillStyle = badge ? 'rgba(255,215,94,0.9)' : wonLv ? 'rgba(214,69,69,0.85)' : 'rgba(70,52,44,0.6)';
        rr(ctx, chx, ry + TG.chipY, chp.w, TG.chipH, 8); ctx.fill();
        ctx.fillStyle = badge ? '#3a2c14' : wonLv ? '#fff' : '#8a7f72';
        ctx.font = 'bold 12px system-ui, sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(badge ? '\u2605' : 'L' + (lv2 + 1),
                     chx + chp.w / 2, ry + TG.chipY + TG.chipH * 0.66);
        ctx.textAlign = 'left';
      }
    }
    ctx.textAlign = 'center';
    var TB = trialGeom(this.view).back;
    ctx.fillStyle = 'rgba(214,69,69,0.9)';
    rr(ctx, TB.x, TB.y, TB.w, TB.h, 10); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 14px system-ui, sans-serif';
    ctx.fillText('BACK', TB.x + TB.w / 2, TB.y + TB.h / 2 + 5);
    ctx.textAlign = 'left';
  };

  /// The lowest baseline anything on the result screen may use. 'tap for menu'
  /// sits 18 under it; Wick is bottom-anchored 62 above it. Named once so the
  /// ladder, the hero and the footer cannot each guess.
  /// THE LEADERBOARD QUESTION (HANDOFF §3g). One geometry source for the
  /// drawer, the tap handler and tools/tap_rooms.js. Centred on what is
  /// VISIBLE (v.h below -oy), not on the design box, so a tall phone does not
  /// hang it high. The two answers are the SAME SIZE, same plate, stacked full
  /// width: a consent question whose no is smaller or dimmer than its yes is
  /// steering, not asking, and stacking keeps both labels whole on the
  /// narrowest screen. No randomness anywhere in here -- it sits in front of a
  /// seeded Daily (check_lb_consent asserts it).
  var LB_ASK_LINES = [
    'Yes signs this device in anonymously and lists',
    'your best wave under a random WICK-XXXX name.',
    'No name, email or device details are sent.',
    'A posted score can’t be deleted from the board.',
  ];
  function lbAskGeom(v, from) {
    var s = v.scale || 1;
    var bh = Math.max(56, 44 / s), gap = 10;
    var X = 24, W = WORLD_W - 48;
    var H = 176 + 2 * bh + gap + 34;
    var visTop = -(v.oy || 0), visH = v.h || WORLD_H;
    var Y = Math.round(visTop + Math.max(0, (visH - H) / 2));
    var by = Y + 176, bx = X + 16, bw = W - 32;
    return {
      from: from,
      card: { x: X, y: Y, w: W, h: H },
      yes: { x: bx, y: by, w: bw, h: bh, hx: bx, hy: by, hw: bw, hh: bh },
      no:  { x: bx, y: by + bh + gap, w: bw, h: bh, hx: bx, hy: by + bh + gap, hw: bw, hh: bh },
      foot: by + 2 * bh + gap + 20,
    };
  }

  Game.prototype._drawLbAsk = function (ctx) {
    var v = this.view, A = lbAskGeom(v, this._lbAsk), c = A.card;
    var CX = c.x + c.w / 2, tw = c.w - 28, fromDaily = this._lbAsk === 'daily';
    ctx.fillStyle = 'rgba(10,6,4,0.72)';                 // scrim: nothing under it takes a tap
    ctx.fillRect(-v.ox - 60, -v.oy - 60, v.w + 120, v.h + 120);
    ctx.fillStyle = 'rgba(38,26,18,0.97)';
    rr(ctx, c.x, c.y, c.w, c.h, 14); ctx.fill();
    ctx.strokeStyle = 'rgba(201,184,255,0.7)'; ctx.lineWidth = 2;
    rr(ctx, c.x, c.y, c.w, c.h, 14); ctx.stroke();
    ctx.textAlign = 'center';
    ctx.font = 'bold 17px Georgia, serif';
    inkText(ctx, 'DAILY SIEGE LADDER', CX, c.y + 32, '#ffd75e', 4, 1);
    ctx.font = '14px system-ui, sans-serif'; ctx.fillStyle = '#ffe9c4';
    ctx.fillText(fitText(ctx, 'Post your Daily Siege waves to', tw), CX, c.y + 60);
    ctx.fillText(fitText(ctx, 'the public all-time ladder?', tw), CX, c.y + 78);
    ctx.font = '11px system-ui, sans-serif'; ctx.fillStyle = '#c9b8a8';
    for (var li = 0; li < LB_ASK_LINES.length; li++) {
      ctx.fillText(fitText(ctx, LB_ASK_LINES[li], tw), CX, c.y + 106 + li * 16);
    }
    var answers = [
      [A.yes, 'POST MY WAVES', fromDaily ? 'starting with this run' : 'from your next Daily Siege'],
      [A.no, 'DON’T POST', 'scores stay on this device'],
    ];
    for (var ai = 0; ai < answers.length; ai++) {
      var ar = answers[ai][0], mid = ar.y + ar.h / 2;
      forgePlate(ctx, ar, 'cold');
      ctx.font = 'bold 15px system-ui, sans-serif';
      inkText(ctx, answers[ai][1], CX, mid - 2, '#f0eaff', 4, 1);
      ctx.font = '10px system-ui, sans-serif';
      inkText(ctx, answers[ai][2], CX, mid + 14, 'rgba(201,184,255,0.85)', 3, 1);
    }
    ctx.font = '10px system-ui, sans-serif'; ctx.fillStyle = 'rgba(201,184,168,0.8)';
    ctx.fillText(fitText(ctx, fromDaily ? 'change this on any Daily results screen · tap outside to go back'
                                        : 'tap outside to go back', tw), CX, A.foot);
    ctx.textAlign = 'left';
  };

  var RESULT_FOOT = 706;

  Game.prototype._retryLeaderboard = function () {
    if (this.mode !== 'daily' || (this.state !== 'won' && this.state !== 'lost') || !Lb.on()) return false;
    var state = Lb.status(); if (!state.pending || state.sending) return false;
    var self = this, result = this.result;
    this.lbRows = 'loading';
    Lb.flush(function () {
      if (self.result !== result || self.mode !== 'daily' || (self.state !== 'won' && self.state !== 'lost')) return;
      Lb.top(10, function (rows) { if (self.result === result) self.lbRows = rows || 'error'; });
    });
    return true;
  };
  Game.prototype._leaderboardStatusText = function () {
    var s = Lb.status();
    if (s.pending) return s.sending ? 'Sending score…' : 'Score waiting to send';
    if (this._lbJoined) return 'Your next Daily Siege can post';
    if (s.outcome === 'posted') return 'Score posted · your best stays on the ladder';
    return 'This run was not recorded online';
  };

  Game.prototype._drawResult = function (ctx) {
    var r = this.result || {};
    // Daily posting controls need room after the fullest toll/leak story.
    var resultRise = this.mode === 'daily' && Lb.on() ? 60 : 0;
    ctx.fillStyle = 'rgba(12,7,5,0.75)';
    ctx.fillRect(-40, -40, WORLD_W + 80, WORLD_H + 80);
    // A COLUMN SCRIM UNDER THE COPY. 0.75 over the board is enough on a
    // campaign map; a DUEL ends over two full caverns -- two keeps, two hoards
    // and up to fourteen machines -- and every line of this screen was being
    // read against that. The column is soft-edged top and bottom so it reads as
    // depth rather than as a panel, and it leaves the board visible either
    // side, which is the thing worth looking at after a duel.
    var rs = ctx.createLinearGradient(0, 270, 0, 700);
    rs.addColorStop(0, 'rgba(10,6,4,0)');
    rs.addColorStop(0.10, 'rgba(10,6,4,0.62)');
    rs.addColorStop(0.86, 'rgba(10,6,4,0.62)');
    rs.addColorStop(1, 'rgba(10,6,4,0)');
    ctx.fillStyle = rs; ctx.fillRect(18, 270, WORLD_W - 36, 430);
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
      ctx.fillText(r.won ? 'HOARD HELD!' : 'HOARD LOST', WORLD_W / 2, 320 - resultRise);
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
        starCoin(ctx, WORLD_W / 2 - 46 + s * 46, 360 - resultRise, 19 * pop, earned);
      }
    }
    // ---- EVERYTHING BELOW FLOWS FROM ONE CURSOR ---------------------------
    // Every y under here used to be a literal, and they collided the moment two
    // optional blocks were on at once. MEASURED on a real lost daily (15,165
    // fixed steps, wave 3, 2 leaks): 'WHO GOT THROUGH' was drawn at 496 while
    // 'waves survived' was drawn at 498 -- two units apart, both painted -- and
    // with the toll firing as well, 'Wick shook loose' landed on 498 too, three
    // strings in the same two units. `leakTop` DID shift by 26 for the toll; its
    // own header did not follow it, because the header was a literal.
    // A cursor cannot do that: a block that is not drawn advances nothing.
    var CX = WORLD_W / 2;
    var RY = r.rival ? 352 : (r.trial ? 357 : 332);       // under the headline
    if (r.won && !r.rival) RY = 379;                      // under the medallions
    RY -= resultRise;

    // ---- HOARD MARKS EARNED ----------------------------------------------
    // _gameOver() writes result.marks and NOTHING READ IT: a player earned the
    // currency the whole shop runs on and was never told. It lands in the gap
    // between the star medallions (360) and the stats block (420), which is
    // free in every layout this screen has -- a duel has no stars and its
    // margin line stops at 340, a trial's line stops at 345.
    // IT WAITS FOR THE STARS. A landing medallion pops to ~1.55x its resting
    // radius, so a star that clears the chip at rest (centre 360, r19 -> 379)
    // punches straight through it mid-animation. The third star lands at
    // 0.22 + 2*0.26 = 0.74s and settles shortly after, so the chip fades in at
    // 1.05s -- which is also the better beat: stars, then the reward.
    var mkFade = RM ? 1 : Math.max(0, Math.min(1, ((this._resultT || 0) - 1.05) / 0.28));
    if ((r.marks | 0) > 0 && mkFade > 0) {
      ctx.save(); ctx.globalAlpha = mkFade;
      // IT RIDES THE CURSOR NOW. It used to be wedged into the one 24-unit gap
      // that happened to be free in every layout (381..405, between the star
      // medallions ending at 379 and 'treasure kept' at 420) precisely BECAUSE
      // every y below it was a literal and it could not move anything. It can
      // move things now, so it simply sits where it falls.
      var mkTxt = '+' + (r.marks | 0) + '  HOARD MARKS';
      ctx.font = 'bold 13px system-ui, sans-serif';
      var mkW = ctx.measureText(mkTxt).width + 40;
      var mkX = WORLD_W / 2 - mkW / 2;
      ctx.fillStyle = 'rgba(96,66,28,0.55)';
      rr(ctx, mkX, RY + 2, mkW, 24, 8); ctx.fill();
      ctx.strokeStyle = 'rgba(255,215,110,0.75)'; ctx.lineWidth = 1.5;
      rr(ctx, mkX, RY + 2, mkW, 24, 8); ctx.stroke();
      drawCoin(ctx, mkX + 15, RY + 14, 8, Save.equipped('coin'));
      ctx.textAlign = 'left';
      inkText(ctx, mkTxt, mkX + 28, RY + 18, '#ffe9c4', 3, 1);
      ctx.textAlign = 'center';
      ctx.restore();
    }
    if ((r.marks | 0) > 0) RY += 26;
    ctx.fillStyle = '#ffe9c4'; ctx.font = '17px system-ui, sans-serif';
    var LINE = 26;
    RY += 15;
    ctx.fillText('treasure kept: ' + (r.hoard | 0) + ' / ' + CFG.startHoard, CX, RY); RY += LINE;
    ctx.fillText('coins carried off: ' + (r.lost | 0), CX, RY); RY += LINE;
    ctx.fillText('raiders slain: ' + (r.kills | 0), CX, RY); RY += LINE;
    // THE DAILY'S OWN LINE BELONGS IN THE STATS BLOCK. It was drawn at a
    // literal 498 four blocks further down, which is how it came to be printed
    // on top of the leak header.
    if (this.mode === 'daily') {
      ctx.fillText('waves survived: ' + (r.wave | 0), CX, RY); RY += LINE;
    }
    if (r.toll > 0) {
      ctx.fillStyle = '#9ef58f';
      ctx.fillText('Wick shook loose: ' + (r.toll | 0), CX, RY); RY += LINE;
      ctx.fillStyle = '#ffe9c4';
    }
    // WHO TOOK IT. "coins carried off: 25" told the player they had failed and
    // nothing about why. The top three thieves, with the wave they first got
    // through, turn a loss into a next attempt: the answer to a Gloomwing is a
    // different machine from the answer to a Bulwark, and the player could not
    // previously tell which one had beaten them.
    // The block is only drawn when something LEAKED, so a clean run keeps the
    // tight layout and the story beat stays where it was.
    if (r.leaks && r.leaks.length) {
      RY += 6;
      ctx.font = 'bold 11px system-ui, sans-serif';
      ctx.fillStyle = '#c9b8a8';
      ctx.fillText('WHO GOT THROUGH', CX, RY);
      RY += 16;
      for (var lz = 0; lz < Math.min(3, r.leaks.length); lz++) {
        var lr = r.leaks[lz], ly = RY + lz * 18;
        var card = ENEMY_CARDS[lr.type];
        var lname = card ? card[0] : lr.type.toUpperCase();
        var li2 = ART.images['e_' + lr.type];
        if (li2) {
          var lih = 17, liw = lih * (li2.width / li2.height);
          ctx.drawImage(li2, CX - 104 - liw, ly - 13, liw, lih);
        }
        // THE NAME RAN INTO ITS OWN COIN COUNT. Left-aligned at CX-98 against a
        // count right-aligned at CX+28 gives the name 126 units -- and
        // 'THE HOARD KING' MEASURES 114.0 at bold 13, so it ended at CX+16
        // while '-25' started near CX+6. It printed as 'THE HOARD KING-25', on
        // a boss row, in ordinary play. The count and the wave move right into
        // the space the row already had (the wave text ends at CX+130 against a
        // column edge near CX+180), and fitText is the backstop for a longer
        // name than any card carries today.
        ctx.textAlign = 'left';
        ctx.fillStyle = ENEMY_COLORS[lr.type] || '#ffe9c4';
        ctx.font = 'bold 13px system-ui, sans-serif';
        ctx.fillText(fitText(ctx, lname, 126), CX - 98, ly);
        ctx.textAlign = 'right';
        ctx.fillStyle = '#ff7b7b';
        ctx.fillText('-' + lr.coins, CX + 58, ly);
        ctx.fillStyle = 'rgba(201,184,168,0.85)';
        ctx.font = '11px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('from wave ' + lr.wave, CX + 68, ly);
        ctx.textAlign = 'center';
      }
      // EVERY UNIT HERE IS A LADDER ROW. This block and the ladder are the two
      // longest optional things on the screen and they are both on exactly the
      // mode that has a ladder, so the leak block is drawn as tight as it reads.
      RY += Math.min(3, r.leaks.length) * 18 + 10;
    }
    // the story beat this whole game is for
    var storyY = RY + 12;
    ctx.font = 'italic 15px Georgia, serif'; ctx.fillStyle = '#ff9a3c';
    if (r.won) {
      ctx.fillText('Auremma stirs, half-dreaming:', CX, storyY);
      ctx.fillText('“You kept the warm in, little one.”', CX, storyY + 21);
    } else {
      ctx.fillText('The cavern grows colder.', CX, storyY);
      ctx.fillText('Wick will not let it happen twice.', CX, storyY + 21);
    }
    // daily: the global best-runs ladder (names render through safeName ONLY)
    // THE CONTROL THE PRIVACY PAGE ALREADY PROMISED. It is drawn whenever a
    // board is CONFIGURED, not whenever we are posting -- opted out, it is the
    // only way back in, and a toggle that disappears when you use it is not a
    // toggle. Its rect is on the geometry so the tap handler reads the same one.
    // It says what is TRUE OF THIS RUN: a yes given on this screen cannot post
    // the run it is looking at (no start_run token), and before the first
    // session there is no WICK name to print. Stop is one tap; join opens the
    // question (§3g).
    this._lbOptRect = null; this._lbRetryRect = null;
    if (this.mode === 'daily' && Lb.configured()) {
      var optTxt = !Lb.on() ? 'not posting — tap to join the ladder'
        : this._lbJoined ? 'posting from your next Daily Siege — tap to stop'
        : Lb.hasId() ? 'posting as ' + Lb.tag() + ' — tap to stop'
        : 'posting is on — tap to stop';
      ctx.font = '11px system-ui, sans-serif';
      var optW = ctx.measureText(optTxt).width + 28;
      var optY = RESULT_FOOT - 6;
      var optH = Math.max(26, 44 / this.view.scale);
      this._lbOptRect = { x: CX - optW / 2, y: optY - 4 - optH / 2, w: optW, h: optH };
      ctx.fillStyle = 'rgba(255,233,196,0.40)';
      ctx.fillText(optTxt, CX, optY);
    }
    if (this.mode === 'daily' && Lb.on()) {
      // THE LADDER FOLLOWS THE STORY, and takes only the rows that fit above
      // 'tap for menu'. It was pinned at 584/606+n*17, so a daily that earned
      // marks, fired the toll AND leaked three raiders pushed the story down
      // into it -- the two longest blocks on the screen are both optional and
      // both on exactly the mode this ladder belongs to. Eight rows still fit
      // on a clean run; a loaded run gives up the tail of the ladder rather
      // than printing it through the story, and the count is honest either way.
      var LBY = storyY + 45, LBR = LBY + 41, posting = Lb.status();
      if (posting.pending) {
        var retryH = Math.max(44, 44 / this.view.scale);
        var retry = this._lbRetryRect = { x: CX - 92, y: RESULT_FOOT - 45 - retryH, w: 184, h: retryH };
        ctx.fillStyle = posting.sending ? '#473830' : '#745028';
        rr(ctx, retry.x, retry.y, retry.w, retry.h, 9); ctx.fill();
        ctx.strokeStyle = '#be965b'; ctx.lineWidth = 1; ctx.stroke();
        ctx.fillStyle = '#fff0d3'; ctx.font = 'bold 13px system-ui, sans-serif';
        ctx.fillText(posting.sending ? 'SENDING…' : 'RETRY SCORE', CX, retry.y + retry.h / 2 + 4);
      }
      var ladderBottom = this._lbRetryRect ? this._lbRetryRect.y - 12 : RESULT_FOOT - 42;
      var hasLadderRoom = LBR <= ladderBottom;
      if (hasLadderRoom) {
        ctx.fillStyle = '#ffd75e'; ctx.font = 'bold 14px system-ui, sans-serif';
        ctx.fillText('— ALL-TIME BEST SIEGES —', CX, LBY);
      }
      ctx.fillStyle = posting.outcome === 'posted' ? '#9ef58f' : '#c9b8ff';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(this._leaderboardStatusText(), CX, hasLadderRoom ? LBY + 21 : Math.min(storyY + 43, ladderBottom - 4));
      if (!hasLadderRoom) {
        // Keep the story and a usable retry; do not squeeze tiny rank rows in.
      } else if (this.lbRows === 'loading') {
        ctx.fillStyle = '#c9b8ff'; ctx.font = '13px system-ui, sans-serif';
        ctx.fillText('fetching the ladder…', CX, LBR);
      } else if (this.lbRows === 'error' || !this.lbRows) {
        ctx.fillStyle = '#8a7f72'; ctx.font = '13px system-ui, sans-serif';
        ctx.fillText('Ladder unavailable right now', CX, LBR);
      } else if (!this.lbRows.length) {
        ctx.fillStyle = '#c9b8ff'; ctx.font = '13px system-ui, sans-serif';
        ctx.fillText('no siegers yet — yours could be first', CX, LBR);
      } else {
        ctx.font = '13px ui-monospace, Menlo, monospace';
        var mine = Lb.hasId() ? Lb.tag() : null;
        var nFit = Math.max(0, Math.floor((ladderBottom - LBR) / 17) + 1);
        var nShow = Math.min(8, this.lbRows.length, nFit);
        for (var bi = 0; bi < nShow; bi++) {
          var row = this.lbRows[bi];
          var nm = Lb.safeName(String(row.display_name || ''));
          ctx.fillStyle = nm === mine ? '#9ef58f' : '#ffe9c4';
          ctx.textAlign = 'left';
          ctx.fillText((bi + 1) + '.  ' + nm, CX - 105, LBR + bi * 17);
          ctx.textAlign = 'right';
          ctx.fillText('wave ' + (row.value | 0), CX + 105, LBR + bi * 17);
        }
        ctx.textAlign = 'center';
      }
    } else {
      // THE COAT BELONGS HERE TOO. _drawHero's intercept covers the board; this
      // is a separate draw site, so the win screen congratulated the player
      // while showing a stock red dragon they had just paid to recolour.
      var rimg = this._myPlate(ART.images.hero);
      if (rimg) {
        // HEIGHT-first, like _drawHero: the plate's aspect is not a constant of
        // the universe (it changed the day the clipped tail was restored), so
        // sizing off WIDTH silently rescaled him on this screen.
        // HE SITS BELOW THE STORY, WHATEVER LENGTH IT RAN TO. At a fixed
        // 109.3 tall bottom-anchored at 668 his head starts at 558.7 -- and a
        // duel with two leak rows puts the story's two lines at 566 and 587,
        // straight through him. The story is the beat this whole screen is for,
        // so it wins: Wick takes what is left between it and 'tap for menu',
        // and if that is less than 54 he does not draw at all, because a
        // squashed thumbnail of the hero is worse than no hero.
        var wickTop = Math.max(storyY + 31, 540);
        var rh = Math.min(109.3, RESULT_FOOT - 62 - wickTop);
        if (rh >= 54) {
          var rw = rh * (rimg.width / rimg.height);
          // HE FLIES, HE DOES NOT FLOAT (2026-09-14). VANUS: "at the end screen
          // wick is floating not flapping wings". A still plate bobbing on a
          // sine read as a cut-out drifting. The crew pose's wing rig beats here
          // and the lift rides its downstroke; reduced motion keeps him still.
          var flap = RM ? 0 : Math.sin(this.worldT * 2.2 * Math.PI * 2);
          var rb = RM ? 0 : -Math.max(0, flap) * 3;
          ctx.save(); ctx.translate(WORLD_W / 2, 668 + rb);
          if (!this._drawFootWick(ctx, rimg, 'front', rh, rw, { mode: 'crew', far: 0, near: 0, farLift: 0, nearLift: 0, tool: 0 }))
            ctx.drawImage(rimg, -rw / 2, -rh, rw, rh);
          ctx.restore();
        }
      }
    }
    ctx.font = 'bold 15px system-ui, sans-serif'; ctx.fillStyle = '#c9b8ff';
    ctx.fillText('tap for menu', CX, RESULT_FOOT + 42);
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
    while (this._acc >= STEP && n < cap) { this._acc -= STEP; this.update(STEP); n++; }
    if (this._acc >= STEP) this._acc = 0;   // hard drop after a stall; never spiral
    this._cosmetic(dtRaw);
    this.draw(this._acc / STEP);
  };

  // ---- tiny draw helpers ----
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  // Bottom-anchored aspect-correct sprite blit: sprites stand ON baseY.
  // Returns false when the image is missing so callers fall back LOUDLY.
  /// `id` may be an ART id OR an already-resolved image -- the skin slots pass
  /// a recoloured canvas, which has no id to look up.
  function drawSpriteBottom(ctx, id, cx, baseY, drawW) {
    var img = (typeof id === 'string') ? ART.images[id] : id;
    if (!img) return false;
    var h = drawW * (img.height / img.width);
    ctx.drawImage(img, cx - drawW / 2, baseY - h, drawW, h);
    return true;
  }
  /// THE MINTED COIN. The top-left counter used to be `ctx.arc` filled flat
  /// gold with a brown stroke -- a poker chip, and the one object on the HUD
  /// the player looks at every three seconds. A coin has a RIM (a raised ring,
  /// so it reads as struck metal rather than a printed circle), a LIGHT SIDE
  /// (the gradient runs top-left, matching every other light source in the
  /// cavern) and a FACE. The face is a castle, and the alloy under it is the
  /// grade -- see COINS.
  ///
  /// ALL FIVE COINS HAVE ART, so this procedural path is the FALLBACK, not the
  /// default -- `coin.art` short-circuits it above. It still runs in two real
  /// cases: the duel rival's pip, a synthetic literal with no `art` key so it
  /// stays deliberately cool against your warm gold, and any frame before the
  /// sprite has decoded. (This used to say the art did not exist yet; it
  /// shipped in the same change that wrote the sentence.)
  function stampCastle(ctx, kind, r, ink, face) {
    // unit space: x,y in -1..1, scaled by r. Everything is drawn as ONE filled
    // path in `ink`, then the openings (gate, windows) are punched back in
    // `face` on top -- a castle with no openings is a lump, and at this size
    // the openings are most of what says "castle".
    //
    // TOWERS MUST NOT TOUCH. The first version put the gatehouse towers at
    // +-0.62 with half-width 0.24 against a centre block of half-width 0.42:
    // the spans overlapped, the winding rule merged all three into one mass,
    // and the coin read as a notched blob. Gaps are load-bearing here.
    function block(x, w, top, mer) {
      var y1 = 0.86, n = mer | 0;
      ctx.moveTo(x - w, y1);
      ctx.lineTo(x - w, top);
      if (n > 0) {
        var step = (2 * w) / (n * 2 - 1);
        for (var i = 0; i < n * 2 - 1; i++) {
          ctx.lineTo(x - w + step * (i + 1), (i % 2 === 0) ? top - 0.24 : top);
        }
      } else { ctx.lineTo(x + w, top); }
      ctx.lineTo(x + w, y1);
      ctx.closePath();
    }
    function roof(x, w, top) {
      ctx.moveTo(x - w, top); ctx.lineTo(x, top - 0.46); ctx.lineTo(x + w, top);
      ctx.closePath();
    }
    function arch(x, w, h) {          // a doorway: a round top on a stem
      ctx.moveTo(x - w, 0.86);
      ctx.lineTo(x - w, h + w);
      ctx.arc(x, h + w, w, Math.PI, 0);
      ctx.lineTo(x + w, 0.86);
      ctx.closePath();
    }
    ctx.save(); ctx.scale(r, r);
    ctx.fillStyle = ink;
    ctx.beginPath();
    if (kind === 'gate') {
      block(-0.68, 0.20, -0.22, 2); block(0.68, 0.20, -0.22, 2); block(0, 0.34, 0.10, 3);
    } else if (kind === 'keep') {
      block(0, 0.42, -0.50, 3); block(-0.76, 0.16, -0.06, 2); block(0.76, 0.16, -0.06, 2);
    } else if (kind === 'citadel') {
      block(-0.80, 0.15, -0.20, 2); block(-0.32, 0.15, -0.56, 2);
      block(0.32, 0.15, -0.56, 2);  block(0.80, 0.15, -0.20, 2);
      block(0, 0.94, 0.30, 0);
    } else if (kind === 'bastion') {
      // a low angular fort: sloped curtain, two corner bastions, a squat keep.
      // Iron does not decorate, so there are no merlons -- but there IS a
      // stepped silhouette, because the first attempt was a smooth triangle
      // and read as a mountain.
      ctx.moveTo(-0.96, 0.86); ctx.lineTo(-0.80, 0.24); ctx.lineTo(-0.44, 0.24);
      ctx.lineTo(-0.44, 0.86); ctx.closePath();
      ctx.moveTo(0.96, 0.86); ctx.lineTo(0.80, 0.24); ctx.lineTo(0.44, 0.24);
      ctx.lineTo(0.44, 0.86); ctx.closePath();
      block(0, 0.40, -0.26, 0);
      ctx.moveTo(-0.52, 0.86); ctx.lineTo(-0.52, 0.44); ctx.lineTo(0.52, 0.44);
      ctx.lineTo(0.52, 0.86); ctx.closePath();
    } else {
      block(0, 0.22, -0.34, 0); roof(0, 0.30, -0.34);
      block(-0.68, 0.14, 0.06, 0); roof(-0.68, 0.20, 0.06);
      block(0.68, 0.14, 0.06, 0);  roof(0.68, 0.20, 0.06);
    }
    ctx.fill();
    // openings, punched back in the coin's own face colour
    ctx.fillStyle = face;
    ctx.beginPath();
    if (kind === 'gate')          { arch(0, 0.15, 0.34); }
    else if (kind === 'keep')     { arch(0, 0.13, 0.42); }
    else if (kind === 'citadel')  { arch(0, 0.14, 0.52); }
    else if (kind === 'bastion')  { arch(0, 0.13, 0.56); }
    else                          { arch(0, 0.10, 0.56); }
    ctx.fill();
    ctx.restore();
  }

  /// coin may be a COINS entry or null (falls back to the stock gatehouse).
  function drawCoin(ctx, cx, cy, r, coin) {
    coin = coin || COINS[0];
    if (coin.art && ART.images[coin.art]) {
      var im = ART.images[coin.art];
      ctx.drawImage(im, cx - r, cy - r, r * 2, r * 2);
      return;
    }
    ctx.save();
    ctx.translate(cx, cy);
    // body: light from the top-left, same as the cavern
    var g = ctx.createRadialGradient(-r * 0.38, -r * 0.42, r * 0.10, 0, 0, r * 1.12);
    g.addColorStop(0, '#ffffff');
    g.addColorStop(0.28, coin.face);
    g.addColorStop(1, coin.edge);
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(0, 0, r, 0, 6.283); ctx.fill();
    // rim: struck metal has a raised ring, and it is what stops this reading
    // as a printed dot at 10px
    ctx.strokeStyle = coin.edge; ctx.lineWidth = Math.max(1, r * 0.16);
    ctx.beginPath(); ctx.arc(0, 0, r * 0.90, 0, 6.283); ctx.stroke();
    // the face, in relief: a dark stamp with a 1px light offset above it
    // relief: a light ghost one pixel high, then the real stamp over it.
    //
    // MULTIPLY THE CALLER'S ALPHA, NEVER ASSIGN IT. These were absolute writes
    // (0.5, then 1), and the result screen calls this INSIDE a fade -- so the
    // coin's rim and stamp punched through at full opacity while the chip
    // around them was still fading in, and the ghost rendered at 0.5 whatever
    // the fade said. The outer save/restore already brackets this whole
    // function, so scaling from a0 is all that is needed.
    var a0 = ctx.globalAlpha;
    ctx.globalAlpha = a0 * 0.5;
    ctx.save(); ctx.translate(0, -r * 0.10);
    stampCastle(ctx, coin.stamp, r * 0.60, '#ffffff', 'rgba(255,255,255,0)');
    ctx.restore();
    ctx.globalAlpha = a0;
    ctx.save(); ctx.translate(0, r * 0.02);
    stampCastle(ctx, coin.stamp, r * 0.60, coin.ink, coin.face);
    ctx.restore();
    ctx.restore();
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


  // Semantic controls sit over the canvas geometry. They call the same input
  // path as touch. The field guide is presentation only and never advances a run.
  var PlayerGuide = (function () {
    var g, root, modal, body, title, close, nav, launch, hits, marker;
    var pointerProxy = null, pointerProxyId = null;
    var keyboardPoint = null;
    var scout, scoutSignature = '';
    var page = '', tab = 'basics', previousFocus = null, signature = '', campaignLevel = null, briefingReturn = false;
    var api = { seen: false, isOpen: function () { return !!page; } };
    function el(tag, cls, text) {
      var n = document.createElement(tag);
      if (cls) n.className = cls;
      if (text !== undefined) n.textContent = text;
      return n;
    }
    function button(text, action, cls) {
      var b = el('button', cls || 'guide-button', text); b.type = 'button';
      b.addEventListener('click', function (event) { Sfx.unlock(); action(event); }); return b;
    }
    function tap(x, y) { var v = g.view; Input.inject(x, y, x + v.ox, y + v.oy); }
    function hide() {
      page = ''; briefingReturn = false; modal.hidden = true; root.classList.remove('has-dialog'); signature = '';
      if (previousFocus && previousFocus.isConnected) previousFocus.focus({preventScroll:true});
      else g.canvas.focus({preventScroll:true});
    }
    function resume() { hide(); g.setPaused(false); }
    function dismiss() {
      if (page === 'briefing') { api.seen = true; Save.data.tut = 1; Save.write(); resume(); }
      else if (page === 'guide' && briefingReturn) { briefingReturn = false; api.open('briefing'); }
      else if (g.state === 'paused' && page !== 'pause') api.open('pause');
      else if (page === 'pause') resume();
      else hide();
    }
    function paragraph(text, cls) { body.appendChild(el('p', cls || 'guide-copy', text)); }
    function lesson(number, heading, text) {
      var card = el('div','guide-lesson'); card.appendChild(el('span','guide-number',number));
      var copy = el('div'); copy.appendChild(el('h3','',heading)); copy.appendChild(el('p','',text));
      card.appendChild(copy); body.appendChild(card);
    }
    function basics() {
      var hero = el('div','guide-hero');
      var im = el('img'); im.src = ART.images.hero_title ? ART.images.hero_title.src : assetURL(ART.manifest.hero_title); im.alt = 'Wick, the dragon inventor';
      hero.appendChild(im); var caption = el('div');
      caption.appendChild(el('p','guide-kicker',"WICK’S WORKSHOP"));
      caption.appendChild(el('h3','', 'Small dragon. Clever defenses.'));
      caption.appendChild(el('p','', 'The Guild wants your treasure. Make them work for it.'));
      hero.appendChild(caption); body.appendChild(hero);
      lesson('01','Protect your treasure', 'TREASURE is the 60 coins in your keep: lose them and the defense ends. BUILD GOLD pays for machines and upgrades. Spending build gold never empties your treasure.');
      lesson('02','Build, then call the wave', 'Pick a machine from the bar at the bottom, then tap clear ground beside the road. Round pads give a 20% discount. Dimmed machines show the stars that unlock them; › shows more.');
      lesson('03','Put Wick to work', 'Tap the floor to move Wick. Tap a built machine, then Send Wick here, to put him to work. His BREATH button burns nearby enemies through armor.');
      lesson('04','Catch the thieves coming back', 'Raiders steal coins, then run for the exit. Move Wick beside a fleeing carrier to shake coins loose, or defeat it to recover the rest. Escaped coins are lost and lower your star rating.');
      paragraph('A good first build: a Crossbow on a round pad, then a Gemsinger to slow the raiders. Read the next wave before you call it.', 'guide-tip');
    }
    // THE GUIDE SHOWS THE MACHINE THE BATTLEFIELD DRAWS (2026-09-14). The
    // crossbow and bellows are painted from layered v2 parts at runtime, and the
    // guide still loaded their single legacy plates -- VANUS saw two different
    // crossbows ("whys the crossbow wrong again"). The same portrait renderer as
    // the machine bar and panel paints every row; a failure keeps the plate.
    var guideImages = {};
    function machineGuideImage(id) {
      if (guideImages[id]) return guideImages[id];
      try {
        var c = document.createElement('canvas'); c.width = 144; c.height = 144;
        g._drawMachinePortrait(c.getContext('2d'), id, 0, 0, { x: 0, y: 0, w: 144, h: 144 });
        return (guideImages[id] = c.toDataURL('image/png'));
      } catch (e) {
        return ART.images['t_' + id] ? ART.images['t_' + id].src : assetURL(ART.manifest['t_' + id]);
      }
    }
    function machines() {
      paragraph('Every machine has a job. Upgrade one twice to choose its final specialization. Prices below are base prices; round pads give a 20% discount.');
      TOWER_ORDER.forEach(function (id) {
        var t = TOWER_TYPES[id], card = el('details','guide-machine');
        var sum = el('summary'), im = el('img'); im.src = machineGuideImage(id); im.alt = '';
        sum.appendChild(im); var words = el('div'); words.appendChild(el('h3','', t.name));
        words.appendChild(el('p','',t.blurb)); sum.appendChild(words);
        var unlock = MACHINE_UNLOCK[id] || 0;
        sum.appendChild(el('span','guide-price',t.cost + 'g')); card.appendChild(sum);
        var content = el('div','guide-machine-detail');
        content.appendChild(el('p','guide-kicker',t.support ? 'SUPPORT MACHINE' : t.hitsAir ? 'GROUND + AIR' : 'GROUND ONLY'));
        content.appendChild(el('p','', unlock ? 'Campaign: unlocks at ' + unlock + ' stars. Always available in Daily Siege and Duel.' : 'Available from your first keep.'));
        t.forks.forEach(function (f) { var line = el('p'); line.appendChild(el('strong','',f.name + '. ')); line.appendChild(document.createTextNode(f.pitch)); content.appendChild(line); });
        card.appendChild(content); body.appendChild(card);
      });
    }
    function controls() {
      lesson('⌘','Choose your machine', 'Every machine sits in the bar at the bottom; › shows the next page. Select one, then tap clear floor or a stone pad; tap the selected machine or × to cancel.');
      lesson('↗','Tap to move', 'Tap clear floor to send Wick there. He attacks automatically. Tapping a machine opens its attached popup. Upgrade, choose a target priority, crew it with Wick, or sell it. Tap another machine to switch; tap the floor to close. Support machines have no aim setting.');
      lesson('Ⅱ','Plan at your pace', 'Pause holds the battle and includes the sound switch. Leaving the app pauses too; returning waits for you. Between later waves, call early for bonus gold or use the countdown to prepare.');
      var dl = el('dl','guide-keys');
      [['Space','Call the next wave'],['B','Use Wick’s breath'],['1–8','Select a machine from the bar'],['Arrows / WASD','Move Wick, or aim a machine placement'],['Enter','Build at the keyboard marker'],['Esc / P','Pause or resume; Esc closes Machines or cancels placement'],['H','Open this guide'],['M','Toggle sound'],['Tab / Enter','Focus and activate menu controls']].forEach(function (r) {dl.appendChild(el('dt','',r[0])); dl.appendChild(el('dd','',r[1]));});
      body.appendChild(dl);
      paragraph('Duel is a race against a computer rival in one shared cavern. Daily Siege is endless and uses the same starting rules for everyone. Campaign stars unlock machines and Forge upgrades.', 'guide-tip');
    }
    function render() {
      body.replaceChildren(); nav.replaceChildren();
      modal.dataset.page = page;
      close.hidden = page === 'briefing';
      close.textContent = briefingReturn ? 'Back to setup' : page === 'pause' ? 'Resume' : g.state === 'paused' ? 'Back to pause' : 'Close guide';
      title.textContent = page === 'pause' ? 'Paused' : page === 'briefing' ? 'Your first defense' : 'Wick’s field guide';
      if (page === 'checkpoint') {
        var saved=g.campaignCheckpoint(); title.textContent='Your workshop is waiting.';
        close.textContent='Back to title';
        if(saved){
          var chosen = campaignLevel === null ? saved.level : campaignLevel, changing = chosen !== saved.level;
          if (changing) title.textContent='Keep your saved workshop?';
          paragraph(saved.name + (saved.trial ? ' · '+saved.trial : ''), 'guide-kicker');
          paragraph('Resume from the start of wave '+saved.wave+' of '+saved.totalWaves+'. Your machines and building budget are saved with it.');
          body.appendChild(button('Resume wave '+saved.wave,function(){hide();g.resumeCampaignCheckpoint();},'guide-button guide-primary'));
          body.appendChild(button(changing ? 'Start '+MAPS[chosen].name : 'Start keep from wave 1',function(){api.startCampaign(chosen);},'guide-button'));
          paragraph((changing ? 'Starting '+MAPS[chosen].name+' opens a fresh setup. ' : saved.trial ? 'Starting over opens the standard keep without a trial. ' : 'Starting over opens a fresh setup. ')+'Your saved workshop is replaced only when you call the first wave. Daily Siege and Duel are single-session runs.', 'guide-tip');
        } else paragraph('No saved campaign is available. Choose a keep to begin.');
      } else if (page === 'pause') {
        var stats = el('div','guide-stats');
        [['Treasure',g.hoard],['Build gold',g.gold],['Wave',Math.min(g.wave+1,g.totalWaves())]].forEach(function (s) {var c=el('div');c.appendChild(el('span','',s[0]));c.appendChild(el('strong','',String(s[1])));stats.appendChild(c);});
        body.appendChild(stats);
        body.appendChild(button('Resume defense',resume,'guide-button guide-primary'));
        // A PAUSE MENU OFFERS THE RUN, NOT JUST THE EXIT (2026-09-14). VANUS:
        // "why only ability to quit to title?" Settings share one row; Restart
        // asks first and names what survives, exactly like Return to title.
        var settings=el('div','guide-pair');
        var sound=button(Sfx.isMuted()?'Sound: off':'Sound: on',function(){Sfx.toggle();sound.textContent=Sfx.isMuted()?'Sound: off':'Sound: on';sound.setAttribute('aria-pressed',String(!Sfx.isMuted()));});
        sound.setAttribute('aria-pressed',String(!Sfx.isMuted()));sound.setAttribute('data-pause-sound','');settings.appendChild(sound);
        var speed=button('Speed: '+g.speed+'×',function(){g.speed=g.speed===1?2:1;speed.textContent='Speed: '+g.speed+'×';speed.setAttribute('aria-pressed',String(g.speed===2));});
        speed.setAttribute('aria-pressed',String(g.speed===2));speed.setAttribute('data-pause-speed','');settings.appendChild(speed);
        body.appendChild(settings);
        body.appendChild(button(g.mode==='daily'?'Restart Daily Siege':g.mode==='duel'?'Restart duel':'Restart keep',function(){
          body.replaceChildren(); title.textContent = 'Restart this run?';
          paragraph(g.mode==='daily'?'Today’s Daily Siege starts over on the same map with the same waves. Your best wave so far is kept.'
            :g.mode==='duel'?'The duel against '+(g.rival?g.rival.name:'your rival')+' starts over from its opening.'
            :'Your machines, build gold and treasure return to the keep’s opening. '+(g.campaignCheckpoint()?'Your saved wave checkpoint is replaced when you call the first wave. ':'')+'Earned stars, unlocks and cosmetics stay with you.');
          body.appendChild(button('Keep playing',resume,'guide-button guide-primary'));
          body.appendChild(button('Restart from wave 1',function(){hide();restartRun();}));
        }));
        body.appendChild(button('Field guide & machines',function(){api.open('guide');}));
        body.appendChild(button('Return to title',function(){
          body.replaceChildren(); title.textContent = 'Leave this defense?';
          paragraph(g.mode==='campaign'&&g.campaignCheckpoint()?'Your latest campaign wave checkpoint stays available. Changes after that checkpoint will be lost.':'This run will end. Earned stars, unlocks, and cosmetics stay with you.');
          body.appendChild(button('Keep playing',resume,'guide-button guide-primary'));
          body.appendChild(button('Return to title',function(){hide();g.reset(1,'campaign');g.state='menu';}));
        },'guide-button guide-quiet'));
      } else if (page === 'briefing') {
        lesson('01','Protect your treasure', 'Keep your 60 treasure safe. Build gold pays for machines.');
        lesson('02','Place a machine', 'Pick a machine from the bar and build beside the road. Round pads save 20%.');
        lesson('03','Start when ready', 'Build at your pace. Call the first wave when you’re ready.');
        body.appendChild(button('Let’s build',dismiss,'guide-button guide-primary'));
        body.appendChild(button('How to play',function(){briefingReturn=true;tab='basics';api.open('guide');},'guide-button guide-quiet'));
      } else {
        [['basics','The basics'],['machines','Machines'],['controls','Controls']].forEach(function (a) {
          var b=button(a[1],function(){tab=a[0];render();nav.querySelector('[aria-pressed="true"]').focus();},'guide-tab');
          b.setAttribute('aria-pressed',String(tab===a[0])); nav.appendChild(b);
        });
        if (tab==='machines') machines(); else if (tab==='controls') controls(); else basics();
      }
      body.scrollTop=0;
    }
    // Restart the run in hand with the same identity: the same keep and trial,
    // today's Daily seed, the same duel rival. A campaign checkpoint is only
    // replaced when the first wave is called (capture lives in startWave).
    function restartRun() {
      if (g.mode === 'daily') g.reset(dailySeed(), 'daily');
      else if (g.mode === 'duel') g.reset(0, 'duel', 0, null, g.rivalIdx);
      else g.reset(1, 'campaign', g.levelIdx, g.trial);
      g.state = 'playing';
    }
    api.startCampaign = function (level) {
      if (!g || level !== (level | 0) || level < 0 || level >= CAMPAIGN_MAPS || !Save.unlocked(level)) return false;
      hide(); g.reset(1, 'campaign', level); g.state = 'playing';
      if (!Save.data.tut && !api.seen) api.open('briefing');
      return true;
    };
    api.open = function (which, level) {
      if (!g || !modal) return;
      if (!page) previousFocus = document.activeElement;
      campaignLevel = which === 'checkpoint' && typeof level === 'number' && level === (level | 0) && level >= 0 && level < CAMPAIGN_MAPS && Save.unlocked(level) ? level : null;
      g.setPaused(true); Input.drain(); page = which || 'guide';
      modal.hidden = false; root.classList.add('has-dialog');
      hits.replaceChildren(); signature = ''; render();
      (page === 'briefing' ? body.querySelector('.guide-primary') : close).focus({preventScroll:true});
    };
    function proxy(label,r,world,action,disabled) {
      var v=g.view, b=button('', function(event){
        if(event && event.detail > 0){
          // A canvas pointerdown can build a machine before its compatibility
          // click arrives. The browser may retarget that click to a freshly
          // inserted HUD button. Only the proxy where the gesture STARTED
          // owns it; otherwise the same finger would queue a second world tap.
          var ownsGesture=pointerProxy===b;
          pointerProxy=null; pointerProxyId=null;
          if(!ownsGesture)return;
          var bounds=g.canvas.getBoundingClientRect();
          var point=g.toWorld(event.clientX-bounds.left,event.clientY-bounds.top);
          tap(point.x,point.y);
        }else action();
      },'guide-hit');
      b.setAttribute('aria-label',label); b.disabled=!!disabled;
      var x=r.hx===undefined?r.x:r.hx, y=r.hy===undefined?r.y:r.hy;
      var w=r.hw===undefined?r.w:r.hw, h=r.hh===undefined?r.h:r.hh;
      b.style.cssText='left:'+((x+(world?v.ox:0))*v.scale)+'px;top:'+((y+(world?v.oy:0))*v.scale)+'px;width:'+(w*v.scale)+'px;height:'+(h*v.scale)+'px';
      hits.appendChild(b);
    }
    // One announcement per encounter transition, independent of the visual
    // control cache. Building, drawing or resuming a paused wave stays quiet.
    function syncScout() {
      if (!scout) return;
      if (g.state !== 'playing') {
        if (g.state !== 'paused') {
          scoutSignature = '';
          if (scout.textContent) scout.textContent = '';
        }
        return;
      }
      if (page) return;
      var key = [g.mode, g.seed, g.levelIdx, g.trial || '', g.wave, g.waveActive].join('|');
      if (key === scoutSignature) return;
      scoutSignature = key;
      var intel = g._waveIntel();
      scout.textContent = g.waveActive
        ? 'Wave ' + intel.wave + ' underway. ' + intel.total + ' raiders' + (intel.perSide ? ' per side.' : '.')
        : (g.wave > 0 ? 'Wave ' + g.wave + ' cleared. ' : '') + intel.announcement;
    }
    api.sync = function (game) {
      if (!g || g !== game) return;
      syncScout();
      if (g.state==='paused' && !page) { api.open('pause'); return; }
      marker.hidden=!!page||!!g.menu||g.state!=='playing'||g.shopPick<0||!keyboardPoint;
      if (!marker.hidden) {
        var spot=g._placeCheck(keyboardPoint.x,keyboardPoint.y,0);
        marker.classList.toggle('blocked',!spot.ok);
        marker.style.left=((keyboardPoint.x+g.view.ox)*g.view.scale)+'px';
        marker.style.top=((keyboardPoint.y+g.view.oy)*g.view.scale)+'px';
        marker.textContent=spot.ok?'Enter to build':spot.why;
      }
      if (g.shopPick<0) keyboardPoint=null;
      launch.hidden=g.state!=='menu'||!!page||!!g._lbAsk;
      if(page==='pause'){
        var sound=body.querySelector('[data-pause-sound]');
        if(sound){var label=Sfx.isMuted()?'Sound: off':'Sound: on',pressed=String(!Sfx.isMuted());if(sound.textContent!==label)sound.textContent=label;if(sound.getAttribute('aria-pressed')!==pressed)sound.setAttribute('aria-pressed',pressed);}
      }
      if (page) return;
      var breathButton=hits.querySelector('[data-breath-action]');
      if(breathButton){var ability=g._breathStatus();if(breathButton.getAttribute('aria-label')!==ability.label)breathButton.setAttribute('aria-label',ability.label);
        if(breathButton.getAttribute('aria-disabled')!==String(!ability.canCast))breathButton.setAttribute('aria-disabled',String(!ability.canCast));}
      var key=[g.state,g.view.cw,g.view.ch,g.view.safeT,g.view.safeB,g.shopPick,g.shopPage,g.shopOpen,!!g.mods.breathOff,g._shelf().join(','),g.waveActive,g.wave,g.menu?g._machineMenuSignature():'',!!g._lbAsk,Sfx.isMuted(),g.cavSlot,g.cavInspect,g.state==='cavern'?g._cavernAction().label:'',Save.forgeSpent(),Save.data.marks,Save.data.stars.join(',')].join('|');
      if (g.state==='won'||g.state==='lost') { var ls=Lb.status(); key += '|'+ls.pending+'|'+ls.sending+'|'+ls.outcome+'|'+!!g._lbRetryRect+'|'+!!g._lbOptRect; }
      if (signature===key) return; signature=key;
      var focusedLabel=hits.contains(document.activeElement)?document.activeElement.getAttribute('aria-label'):null;
      var focusedMachine=hits.contains(document.activeElement)?document.activeElement.getAttribute('data-machine-action'):null;
      hits.replaceChildren();
      if (!launch.hidden) {var help=g._titleGeom().help;launch.style.top=((help.y+g.view.oy)*g.view.scale)+'px';}
      hits.removeAttribute('role'); hits.removeAttribute('aria-modal'); hits.removeAttribute('aria-describedby'); hits.setAttribute('aria-label','Game controls');
      if (g._lbAsk) {
        var A=lbAskGeom(g.view,g._lbAsk);
        hits.setAttribute('role','dialog'); hits.setAttribute('aria-modal','true');
        hits.setAttribute('aria-label','Daily Siege ladder. Post your waves to the public all-time ladder? '+LB_ASK_LINES.join(' '));
        [[A.yes,'Post my waves to the public ladder'],[A.no,'Don’t post. Play offline']].forEach(function(a){proxy(a[1],a[0],true,function(){tap(a[0].x+a[0].w/2,a[0].y+a[0].h/2);});});
        hits.lastChild.focus({preventScroll:true});return;
      }
      if (g.state==='playing' && g.menu) {
        var machine=g._machineMenuTower();
        hits.setAttribute('role','dialog'); hits.setAttribute('aria-modal','true');
        hits.setAttribute('aria-label',machine ? 'Manage '+TOWER_TYPES[machine.type].name+'. Base stats; battle continues.' : 'Machine controls');
        g._machineMenuActions().forEach(function(a){
          proxy(a.label,a.rect,true,function(){tap(a.rect.x+a.rect.w/2,a.rect.y+a.rect.h/2);},a.disabled);
          hits.lastChild.setAttribute('data-machine-action',a.id);
          if (/^preview[01]$/.test(a.id)) hits.lastChild.setAttribute('aria-pressed', String(Number(a.id.slice(-1)) === (g.menu.forkChoice === 1 ? 1 : 0)));
          if (/^aim[0-3]$/.test(a.id)) hits.lastChild.setAttribute('aria-pressed', String(Number(a.id.slice(-1)) === (machine.targeting | 0)));
        });
        if(machine){
          var progress=el('p','guide-scout','Level '+(machine.level+1)+' of 3. '+(machine.level===2?lvlRow(machine).name+'. Fully upgraded. MAX. This path is permanent.':(2-machine.level)+' upgrade'+(machine.level===0?'s':'')+' left to MAX.'));
          if(machine.jamT>0)progress.textContent+=' Jammed. Machine stopped.'+(g.hero.manTid===machine.tid&&g.hero.manned?' Wick is clearing the jam.':' Send Wick here to clear the jam faster.');
          progress.id='machine-upgrade-status';hits.appendChild(progress);hits.setAttribute('aria-describedby',progress.id);
        }
        var same=focusedMachine&&Array.prototype.find.call(hits.children,function(b){return b.getAttribute('data-machine-action')===focusedMachine&&!b.disabled;});
        var first=hits.querySelector('button[data-machine-action="upgrade"]:not([disabled]),button[data-machine-action="preview0"],button[data-machine-action="aim0"],button[data-machine-action="keep"],button[data-machine-action="crew"]:not([disabled])');
        var next=same||first||hits.firstChild;
        if(next)next.focus({preventScroll:true});
        return;
      }
      if (g.state==='menu') {
        var T=g._titleGeom(),cp=g.campaignCheckpoint(),recommended=g._nextLevel();
        T.rows.forEach(function(r,i){
          var unlocked=Save.unlocked(i),name=cp&&cp.level===i?'Resume '+cp.name+' from wave '+cp.wave:MAPS[i].name;
          proxy(name,r,true,function(){tap(r.x+r.w/2,r.y+r.h/2);},!unlocked);
          var info=!unlocked?'Locked. Win '+MAPS[i-1].name+' to unlock.':cp&&cp.level===i?'Saved workshop. Continue from wave '+cp.wave+'.':(Save.data.stars[i]|0)>0?'Replay this keep. '+Save.data.stars[i]+' of 3 stars earned.':'Start keep '+(i+1)+'. 20 waves.';
          hits.lastChild.setAttribute('aria-description',info);
          if(i===recommended)hits.lastChild.setAttribute('aria-current','step');
        });
        [[T.daily,'Daily Siege','Endless survival. A new shared challenge each day.'],[T.duel,'Duel against a computer rival','Choose one of four AI dragon rivals.']].forEach(function(a){proxy(a[1],a[0],true,function(){tap(a[0].x+a[0].w/2,a[0].y+a[0].h/2);});hits.lastChild.setAttribute('aria-description',a[2]);});
        ['Forge upgrades','Challenge trials','Cavern cosmetics','Toggle sound'].forEach(function(name,i){
          var r=T.pills[i];proxy(name,r,true,function(){tap(r.x+r.w/2,r.y+r.h/2);},i===1&&!Save.starsTotal());
          hits.lastChild.setAttribute('aria-description',i===0?(Save.starsTotal()-Save.forgeSpent())+' stars available for upgrades.':i===1?Save.starsTotal()?'Special campaign challenges.':'Win a keep to unlock trials.':i===2?'Customize Wick, machines and your cavern. '+(Save.data.marks|0)+' Hoard Marks.':Sfx.isMuted()?'Sound is off. Turn sound on.':'Sound is on. Turn sound off.');
          if(i===3)hits.lastChild.setAttribute('aria-pressed',String(!Sfx.isMuted()));
        });
        T.legal.forEach(function(r){
          var link=el('a','guide-hit');link.href=legalHref(r.key);link.setAttribute('aria-label',r.key==='privacy'?'Privacy policy':'Terms of use');
          link.style.cssText='left:'+((r.x+g.view.ox)*g.view.scale)+'px;top:'+((r.y+g.view.oy)*g.view.scale)+'px;width:'+(r.w*g.view.scale)+'px;height:'+(r.h*g.view.scale)+'px';
          link.addEventListener('click',function(event){event.preventDefault();openLegal(r.key);});hits.appendChild(link);
        });
      } else if (g.state==='playing') {
        var H=g._hudGeom();
        [['Pause',H.pause],['Toggle game speed',H.spd]].forEach(function(a){proxy(a[0],{x:a[1],y:H.btnY,w:H.buttonW,h:H.buttonH},false,function(){tap(a[1]+H.buttonW/2-g.view.ox,H.btnY+H.buttonH/2-g.view.oy);});});
        if(!g.menu){
          if(!g.waveActive&&g.shopPick<0){var report=el('p','guide-scout',g._waveIntel().announcement);report.setAttribute('role','note');report.setAttribute('aria-label','Scout report');hits.appendChild(report);}
          H.chips.forEach(function(r){var t=TOWER_TYPES[r.id];
            proxy(r.locked?'Locked: '+t.name+'. Earn '+r.stars+' stars to unlock.':'Build '+t.name,r,false,function(){tap(r.x+r.w/2-g.view.ox,r.y+r.h/2-g.view.oy);});
            if(!r.locked)hits.lastChild.setAttribute('aria-pressed',String(g.shopPick===r.index));});
          if(H.pager){var more=H.pager;proxy('More machines. Page '+(H.shopPage+1)+' of '+H.shopPages,more,false,function(){g.shopPage=(H.shopPage+1)%H.shopPages;signature='';});}
          if(g.shopPick>=0)proxy('Cancel placement',H.buildCancel,false,function(){g.shopPick=-1;g.placeHint=null;signature='';});
        }
        if (!g.menu && g.shopPick<0 && !g.shopOpen) {
          if (!g.waveActive) proxy('Call next wave',H.startRect,false,function(){Input.intent('wave');});
          if (!g.mods.breathOff){var ability=g._breathStatus();proxy(ability.label,H.breathRect,false,function(){Input.intent('breath');});
            hits.lastChild.setAttribute('data-breath-action','cast');hits.lastChild.setAttribute('aria-disabled',String(!ability.canCast));}
        }
      } else if (g.state==='won'||g.state==='lost') {
        if (g.mode==='daily' && Lb.on()) {
          var statusNote=el('p','guide-scout',g._leaderboardStatusText());
          statusNote.setAttribute('role','status'); hits.appendChild(statusNote);
          var retry=Lb.status().pending?g._lbRetryRect:null;
          if(retry)proxy('Retry queued score',retry,true,function(){g._retryLeaderboard();},Lb.status().sending);
        }
        var opt=g._lbOptRect;
        if(opt)proxy(Lb.on()?'Stop posting scores':'Join the public all-time ladder',opt,true,function(){tap(opt.x+opt.w/2,opt.y+opt.h/2);});
        proxy('Return to title',{x:70,y:RESULT_FOOT+22,w:280,h:Math.max(44,44/g.view.scale)},true,function(){tap(210,RESULT_FOOT+42);});
      } else if (g._ownsViewport()) {
        var G=g.state==='forge'?forgeGeom(g.view):g.state==='trials'?trialGeom(g.view):g.state==='cavern'?cavernRoomGeom(g.view):duelGeom(g.view);
        if(g.state==='duel') RIVALS.forEach(function(r,i){var row={x:G.x,y:G.top+i*G.pitch,w:G.w,h:G.h};proxy('Challenge '+r.name,row,true,function(){tap(row.x+row.w/2,row.y+row.h/2);},!rivalReady(i));});
        if(g.state==='forge'){
          G.rows.forEach(function(r,i){var n=FORGE_NODES[i];proxy('Upgrade '+n.name,r.band,true,function(){tap(r.band.hx+r.band.hw/2,r.band.hy+r.band.hh/2);},Save.forgeSpent()>=Save.starsTotal()||(Save.data.forge[n.id]||0)>=n.ranks);});
          proxy('Reset Forge upgrades',G.respec,true,function(){tap(G.respec.x+G.respec.w/2,G.respec.y+G.respec.h/2);});
        }
        if(g.state==='trials') TRIAL_ORDER.forEach(function(k,i){G.chips.forEach(function(c,lv){var row={hx:c.hx,hy:G.top+i*G.pitch+c.hy,hw:c.hw,hh:c.hh};proxy(TRIALS[k].name+' in '+MAPS[lv].name,row,true,function(){tap(row.hx+row.hw/2,row.hy+row.hh/2);},!(Save.data.stars[lv]>0));});});
        if(g.state==='cavern'){
          G.tabs.forEach(function(r,i){proxy(SLOTS[i].name+' cosmetics',r,true,function(){tap(r.x+r.w/2,r.y+r.h/2);});});
          var slot=SLOTS[g.cavSlot|0]||SLOTS[0];
          slot.items.forEach(function(it,i){var r=G.cards[i];if(!r)return;proxy('Preview '+it.name,r,true,function(){tap(r.x+r.w/2,r.y+r.h/2);});});
          var ca=g._cavernAction(),cr=G.action;proxy(ca.label,cr,true,function(){tap(cr.x+cr.w/2,cr.y+cr.h/2);},ca.disabled);
        }
        proxy('Back to title',G.back,true,function(){tap(G.back.x+G.back.w/2,G.back.y+G.back.h/2);});
      }
      if(focusedLabel){var match=Array.prototype.find.call(hits.children,function(n){return n.getAttribute('aria-label')===focusedLabel;});
        if(match)match.focus({preventScroll:true});else g.canvas.focus({preventScroll:true});}
    };
    api.init = function (game) {
      g=game; root=document.getElementById('player-ui'); if(!root)return;
      hits=root.querySelector('.guide-hits'); launch=root.querySelector('.guide-launch');
      marker=root.querySelector('.guide-placement');
      scout=root.querySelector('.guide-scout');
      modal=root.querySelector('.guide-modal'); body=root.querySelector('.guide-body');
      title=root.querySelector('#guide-title'); close=root.querySelector('.guide-close'); nav=root.querySelector('.guide-tabs');
      launch.addEventListener('click',function(){api.open('guide');}); close.addEventListener('click',dismiss);
      window.addEventListener('pointerdown',function(event){
        pointerProxy=event.target&&event.target.closest?event.target.closest('.guide-hit'):null;
        pointerProxyId=event.pointerId;
        root.classList.remove('keyboard-controls');
      },true);
      window.addEventListener('pointercancel',function(event){
        if(event.pointerId===pointerProxyId){pointerProxy=null;pointerProxyId=null;}
      },true);
      window.addEventListener('keydown',function(e){
        if(e.altKey||e.ctrlKey||e.metaKey)return;
        root.classList.add('keyboard-controls');
        var k=e.key.toLowerCase();
        if(page) {
          if(k==='m'&&page==='pause'&&!e.repeat){e.preventDefault();Sfx.unlock();Sfx.toggle();return;}
          if(k==='escape'||(k==='p'&&page==='pause')){e.preventDefault();dismiss();}
          if(k==='tab') {
            var focus=Array.prototype.filter.call(modal.querySelectorAll('button,summary'),function(n){return !n.disabled&&n.getClientRects().length;});
            var first=focus[0],last=focus[focus.length-1];
            if(!modal.contains(document.activeElement)){e.preventDefault();(e.shiftKey?last:first).focus();}
            else if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
            else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
          }
          return;
        }
        if(k==='enter'&&keyboardPoint&&g.state==='playing'&&!g.menu&&g.shopPick>=0){
          e.preventDefault();tap(keyboardPoint.x,keyboardPoint.y);return;
        }
        if(e.target.tagName==='BUTTON'&&(k===' '||k==='enter'))return;
        if(e.repeat)return;
        if(g._lbAsk){
          if(k==='escape'){e.preventDefault();g._lbAsk=null;signature='';g.canvas.focus();}
          else if(k==='tab'){
            var f=hits.firstChild,l=hits.lastChild;
            if(!hits.contains(document.activeElement)){e.preventDefault();(e.shiftKey?l:f).focus();}
            else if(e.shiftKey&&document.activeElement===f){e.preventDefault();l.focus();}
            else if(!e.shiftKey&&document.activeElement===l){e.preventDefault();f.focus();}
          }
          return;
        }
        if(g.state==='playing'&&g.menu){
          if(k==='escape'){e.preventDefault();g._machineMenuBack();signature='';if(!g.menu)g.canvas.focus({preventScroll:true});}
          else if(k==='p'){e.preventDefault();g.setPaused(true);}
          else if(k==='h'){e.preventDefault();api.open('guide');}
          else if(k==='tab'){
            var controls=hits.querySelectorAll('button:not([disabled])'), firstControl=controls[0],lastControl=controls[controls.length-1];
            if(firstControl){
              if(!hits.contains(document.activeElement)){e.preventDefault();(e.shiftKey?lastControl:firstControl).focus();}
              else if(e.shiftKey&&document.activeElement===firstControl){e.preventDefault();lastControl.focus();}
              else if(!e.shiftKey&&document.activeElement===lastControl){e.preventDefault();firstControl.focus();}
            }
          }
          return;
        }
        if(k==='h'){e.preventDefault();api.open('guide');return;}
        if(k==='m'){e.preventDefault();Sfx.unlock();Sfx.toggle();return;}
        if(k==='escape'||k==='p'){
          e.preventDefault();
          if(g.state==='playing'){if(k==='escape'&&(g.menu||g.shopPick>=0||g.shopOpen)){g.menu=null;g.shopPick=-1;g.shopOpen=false;}else g.setPaused(true);}
          else if(g._ownsViewport()&&g.state!=='menu')g.state='menu';
          return;
        }
        if(g.state!=='playing')return;
        var H=g._hudGeom(), x,y;
        if((k===' '||k==='b')&&!g.menu){g.shopPick=-1;g.shopOpen=false;e.preventDefault();Sfx.unlock();Input.intent(k===' '?'wave':'breath');return;}
        else if(/^[1-8]$/.test(k)&&!g.menu){var i=Number(k)-1;if(i>=g._shelf().length)return;e.preventDefault();Input.intent('build',i,0);return;}
        else {
          var move={arrowleft:[-48,0],a:[-48,0],arrowright:[48,0],d:[48,0],arrowup:[0,-48],w:[0,-48],arrowdown:[0,48],s:[0,48]}[k];
          if(!move||g.menu)return;
          if(g.shopPick>=0){
            if(!keyboardPoint){
              var near=MAP.pads.filter(function(p){return g._placeCheck(p.x,p.y,0).ok;});
              near.sort(function(a,b){return Math.hypot(a.x-g.hero.x,a.y-g.hero.y)-Math.hypot(b.x-g.hero.x,b.y-g.hero.y);});
              keyboardPoint=near.length?{x:near[0].x,y:near[0].y}:{x:g.hero.x,y:g.hero.y};
            }else{
              keyboardPoint.x=clamp(keyboardPoint.x+move[0]/3,20,WORLD_W-20);
              keyboardPoint.y=clamp(keyboardPoint.y+move[1]/3,120,WORLD_H-30);
            }
            e.preventDefault();g.canvas.focus({preventScroll:true});signature='';return;
          }
          e.preventDefault();Sfx.unlock();Input.intent('move',g.hero.x+move[0],g.hero.y+move[1]);return;
        }
        e.preventDefault(); Sfx.unlock();tap(x-g.view.ox,y-g.view.oy);
      });
      api.sync(g);
    };
    return api;
  })();

  // ===== boot + DEV-GATED debug surface (§3c) =============================
  var _dev = /[?&]dev=1/.test(location.search);   // DEV-HARNESS-COMPILE-TIME: strip
  var canvas = document.getElementById('game-canvas');
  var game = null;

  // Production exposes lifecycle pause only. Declared before boot so a shell
  // that calls pause() during the splash cannot throw.
  window.__game = { pause: function (v) {
    if (!game) return false;
    game.setPaused(v);
    return game.state === 'paused';
  } };

  // Pause when the game leaves the screen, not when keyboard focus moves to
  // a visible browser-host control or child frame: those also emit window
  // blur and were repeatedly opening "Take a breather" during normal play.
  // Native interruptions use __game.pause(true). Returning never auto-resumes.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && game) game.setPaused(true);
  });
  window.addEventListener('blur', function () {
    if (document.hidden && game) game.setPaused(true);
  });
  window.addEventListener('pagehide', function () {
    if (game) game.setPaused(true);
  });

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
      enemyMotionPrewarm();
      game = new Game(canvas);
      window.addEventListener('resize', function () { game.resize(); });
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
      PlayerGuide.init(game);
      bootDev();
    });

  

})();
