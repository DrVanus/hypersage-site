(function () {
  'use strict';

  var CFG = {
    stepHz: 120,
    gravity: 1500,
    damping: 0.90,
    solverIters: 4,
    sleepMove2: 0.0025,
    sleepSteps: 20,
    slop: 0.5,
    correction: 0.6,
    fillTarget: 0.70,
    restockBelow: 0.68,
    pourMax: 200,
    ordersPerShift: 10,
    swings: 55,
    epilogueCoin: 5,
    bagCap: 7,
    timedDur: 45,
    junkRatio: 0.26,
    freeLode: 0.06,
    freeShale: 0,
    rareChance: 0.07,
    greatGem: 0.12,
  };
  var VIEW_H = 720;
  var VIEW_MIN_W = 420;
  var JAR = { l: 38, r: 382, top: 196, bot: 642 };
  var ORDER_Y = 44, ORDER_H = 96, ORDER_W = 70;
  var BAG_Y = 148, BAG_SLOT = 28, BAG_GAP = 4;
  function bagSlotX(i) { return 100 + i * (BAG_SLOT + BAG_GAP); }
  var BAG_HIT_TOP = BAG_Y - 6, BAG_HIT_BOT = BAG_Y + BAG_SLOT + 12;
  var PAY = { easy: 30, med: 60, big: 150, timed: 90 };
  var SLOT_CLS = ['easy', 'med', 'med', 'big', 'timed'];
  var SLOT_N = { easy: 2, med: 3, big: 4, timed: 3 };

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

  function dayNumber() { return Math.floor(Date.now() / 86400000); }
  function seedForDay(d) { return ((d + 1) * 2654435761) >>> 0 || 1; }
  function dailySeed() { return seedForDay(dayNumber()); }

  var GEMS = [
    { k: 'ruby',     col: '#d94560', hi: '#ff9db1', r: 17 },
    { k: 'emerald',  col: '#2fae62', hi: '#9fe8bf', r: 19 },
    { k: 'sapphire', col: '#3f6fd8', hi: '#a5bef5', r: 21 },
    { k: 'amber',    col: '#e8a53c', hi: '#ffdf9a', r: 15 },
    { k: 'prism',    col: '#b56fe0', hi: '#f2d7ff', r: 22, rare: true },
  ];
  var HEART = { k: 'heartstone', col: '#c9a0f0', hi: '#ffffff', r: 56 };
  var GREAT_R = 29;
  var GREAT_YIELD = 3;
  var CRUST_RATE  = { rock_s: 0.06, rock_m: 0.13, rock_l: 0.20 };
  var CRUST_YIELD = { rock_s: 1,    rock_m: 2,    rock_l: 3    };
  var HEART_GIFT = 12;
  var HEART_SELL = 600;
  var CHOICE_SECS = 6.0;

  function hoardDragonSize(total) {
    return 74 + Math.sqrt(Math.max(0, total || 0)) * 3.2;
  }
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
    var great = t.k === 'rock_l' &&
                noise2(p, 13, (seed ^ 0x0B0DD) >>> 0) < CFG.greatGem;
    if (great) {
      var gu = noise2(p, 15, (seed ^ 0x0B0DF) >>> 0);
      t = TYPE[gu < 0.45 ? 'sapphire' : gu < 0.75 ? 'emerald'
             : gu < 0.95 ? 'ruby' : 'amber'];
    }
    var geode = !great && t.k.indexOf('rock') === 0 &&
                noise2(p, 8, (seed ^ 0x0B0D8) >>> 0) < CRUST_RATE[t.k];
    var lane = Math.floor(noise2(p, 5, (seed ^ 0x0B0D5) >>> 0) * 8);
    var sx = JAR.l + 30 + lane * ((JAR.r - JAR.l - 60) / 7)
           + (noise2(p, 6, (seed ^ 0x0B0D6) >>> 0) - 0.5) * 18;
    var sy = JAR.top - 40 - Math.floor(i / 8) * 64 - (i % 8) * 7;
    var inner = null;
    if (geode) {
      inner = [
        ORDER_POOL[Math.floor(noise2(p, 9, (seed ^ 0x0B0D9) >>> 0) * ORDER_POOL.length)],
      ];
      if (CRUST_YIELD[t.k] > 1) inner.push(
        ORDER_POOL[Math.floor(noise2(p, 10, (seed ^ 0x0B0DA) >>> 0) * ORDER_POOL.length)]);
      if (CRUST_YIELD[t.k] > 2) inner.push(
        ORDER_POOL[Math.floor(noise2(p, 17, (seed ^ 0x0B0E1) >>> 0) * ORDER_POOL.length)]);
    }
    var isRock = !great && t.k.indexOf('rock') === 0;
    var lodeF = isRock && !geode && lode > 0 &&
                noise2(p, 11, (seed ^ 0x0B0DB) >>> 0) < lode;
    var shaleF = isRock && !geode && !lodeF && shale > 0 &&
                 noise2(p, 12, (seed ^ 0x0B0DC) >>> 0) < shale;
    return { key: t.k, r: great ? GREAT_R : t.r, x: sx, y: sy, geode: inner,
             lode: lodeF, shale: shaleF, great: great };
  }
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

  var CAREER_REROLL = { 5: 0, 6: 9, 7: 1, 8: 7, 9: 5, 10: 8, 11: 1, 12: 1,
                        14: 3, 15: 8, 16: 3, 17: 7, 18: 1, 19: 8, 20: 4, 21: 6, 22: 2,
                        23: 5, 24: 3, 25: 0, 26: 6, 27: 1, 28: 5, 29: 8,
                        30: 6, 31: 6, 32: 7, 34: 4, 35: 5, 36: 2, 37: 8,
                        38: 4, 39: 0, 40: 6 };
  var CAREER_MAX = 40;
  function careerCfg(n) {
    var tier = Math.floor((n - 1) / 5);
    var inBand = (n - 1) % 5;
    var orders = Math.min(12, 8 + Math.round(tier * 4 / 7));
    var rr = CAREER_REROLL[n] || 0;
    var perOrder = 7.00 - tier * 0.32;

    var intro = n === 16 ? 'lode' : n === 24 ? 'shale' : null;
    if (intro) {
      var prev = careerCfg(n - 1);
      return {
        level: n,
        seed: (squirrel3(n, (0xCAFE01 + Math.imul(rr, 0x9E3779B9)) | 0) >>> 0) || 1,
        restockBelow: 0.66,
        orders: prev.orders,
        swings: prev.swings,
        junk: prev.junk,
        rare: prev.rare,
        timed: prev.timed,
        heart: false,
        lode: intro === 'lode' ? 0.30 : 0,
        shale: intro === 'shale' ? 0.26 : 0,
        intro: intro,
      };
    }

    return {
      level: n,
      seed: (squirrel3(n, (0xCAFE01 + Math.imul(rr, 0x9E3779B9)) | 0) >>> 0) || 1,
      restockBelow: 0.66,
      orders: orders,
      swings: Math.max(46, Math.round(orders * perOrder
              + (inBand === 3 ? -2 : 0) + (inBand === 4 ? 6 : 0))),
      junk: Math.min(0.44, 0.26 + tier * 0.016 + (inBand === 3 ? 0.04 : 0)),
      rare: n >= 5 ? CFG.rareChance : 0,
      timed: n >= 3,
      heart: n % 5 === 0,
      lode: n >= 16 ? 0.14 : 0,
      shale: n >= 24 ? 0.12 : 0,
    };
  }

  var _prismOk = {};
  function careerPrismOk(cfg) {
    if (!cfg) return false;
    var k = cfg.seed >>> 0;
    if (_prismOk[k] !== undefined) return _prismOk[k];
    var j = new Jar(cfg.seed, cfg.junk, cfg.rare, cfg.heart), n = 0;
    for (var i = 0; i < j.bodies.length; i++) if (j.bodies[i].key === 'prism') n++;
    return (_prismOk[k] = n >= 3);
  }

  var JAR_AREA = (JAR.r - JAR.l) * (JAR.bot - JAR.top);

  function Jar(seed, junk, rare, heart, lode, shale) {
    this.seed = seed >>> 0;
    this.junk = junk === undefined ? CFG.junkRatio : junk;
    this.rare = rare === undefined ? CFG.rareChance : rare;
    this.lode = lode || 0;
    this.shale = shale || 0;
    this.bodies = [];
    this.nextId = 1;
    this.batches = 0;
    if (heart) {
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

  Jar.prototype.pour = function (targetFill) {
    var b = this.batches++;
    for (var i = 0; i < CFG.pourMax; i++) {
      if (this.fill() >= targetFill) break;
      var s = jarBodySpec(i, b, this.seed, this.junk, this.rare,
                          this.lode, this.shale);
      this.bodies.push({
        id: this.nextId++, key: s.key, r: s.r, geode: s.geode || null,
        lode: !!s.lode, shale: !!s.shale, great: !!s.great,
        pb: b, pi: i,
        x: s.x, y: s.y, px: s.x, py: s.y, vx: 0, vy: 0,
        rest: 0, asleep: false,
      });
    }
  };

  Jar.prototype.step = function (STEP) {
    var bs = this.bodies, n = bs.length, i, j, b;
    for (i = 0; i < n; i++) {
      b = bs[i];
      b.px = b.x; b.py = b.y;
      if (b.asleep) continue;
      b.vy += CFG.gravity * STEP;
      b.x += b.vx * STEP; b.y += b.vy * STEP;
    }
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
      b.vx = (b.x - b.px) / STEP * CFG.damping;
      b.vy = (b.y - b.py) / STEP * CFG.damping;
      var mdx = b.x - b.px, mdy = b.y - b.py;
      var tol = b.rest >= 10 ? 0.01 : CFG.sleepMove2;
      if (mdx * mdx + mdy * mdy < tol) {
        if (++b.rest >= CFG.sleepSteps) { b.asleep = true; b.vx = 0; b.vy = 0; }
      } else {
        b.rest = 0;
      }
    }

    this.steps = (this.steps || 0) + 1;
    if (this.steps % 30 === 0) this._auditSupport();
  };

  Jar.prototype._auditSupport = function () {
    var bs = this.bodies;
    for (var i = 0; i < bs.length; i++) {
      var b = bs[i];
      if (!b.asleep) continue;
      if (b.y + b.r >= JAR.bot - 1.5) continue;
      var held = false;
      for (var j = 0; j < bs.length && !held; j++) {
        var o = bs[j];
        if (o === b) continue;
        var dx = o.x - b.x, dy = o.y - b.y;
        if (dy <= 0) continue;
        var d2 = dx * dx + dy * dy;
        var rs = b.r + o.r + 1.5;
        if (d2 > rs * rs) continue;
        if (dy * dy > 0.0625 * d2) held = true;
      }
      if (!held) this._wake(b);
    }
  };

  Jar.prototype._solvePair = function (a, b) {
    if (a.asleep && b.asleep) return;
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

  Jar.prototype.blockersOf = function (b, limit) {
    var out = [], bs = this.bodies, i, o, dx;
    for (i = 0; i < bs.length; i++) {
      o = bs[i];
      if (o === b || o.y >= b.y) continue;
      dx = o.x - b.x; if (dx < 0) dx = -dx;
      if (dx < (o.r + b.r) * COVER_X) out.push(o);
    }
    if (!limit || out.length <= limit) return out;
    out.sort(function (p, q) { return q.y - p.y; });
    return out.slice(0, limit);
  };


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
        if (ring > 0 && o.y >= c.y) continue;
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

  var DEEPER_PICK_COST = 250, DEEPER_PICK_SWINGS = 8;

  var WALL_SKINS = [
    { id: 'clay',     name: 'Burrow Clay',  price: 0,    tint: null,
      note: 'plain worked earth' },
    { id: 'amber',    name: 'Amber Seam',   price: 700,  tint: '#c98a2e', amt: 0.55,
      note: 'warm ochre, lantern-lit' },
    { id: 'frost',    name: 'Frost Vein',   price: 1400, tint: '#6fa8c9', amt: 0.55,
      note: 'cold blue, gems pop' },
    { id: 'malach',   name: 'Malachite',    price: 2500, tint: '#3f9e6b', amt: 0.55,
      note: 'green copper, deep quiet' },
    { id: 'rose',     name: 'Rose Quartz',  price: 6300, tint: '#c96f8a', amt: 0.50,
      note: 'pink shot with white' },
    { id: 'basalt',   name: 'Deep Basalt',  price: 11100, tint: '#5a4a7a', amt: 0.60, dark: 0.22,
      note: 'darkest seam, all aglow' },
  ];

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      squirrel3: squirrel3, noise01: noise01, noise2: noise2,
      jarBodySpec: jarBodySpec, orderSpec: orderSpec, Jar: Jar, CFG: CFG,
      careerCfg: careerCfg, CAREER_MAX: CAREER_MAX,
      careerPrismOk: careerPrismOk,
      CAREER_REROLL: CAREER_REROLL,
      bestDelivery: bestDelivery,
      SLOT_CLS: SLOT_CLS, PAY: PAY, TYPE: TYPE,
      DAILY_CHARACTERS: DAILY_CHARACTERS, dailyCharacter: dailyCharacter,
      seedStream: seedStream, streamFloat: streamFloat, rngInt: rngInt,
      dayNumber: dayNumber, dailySeed: dailySeed,
      WALL_SKINS: WALL_SKINS,
      DEEPER_PICK_COST: DEEPER_PICK_COST, DEEPER_PICK_SWINGS: DEEPER_PICK_SWINGS,
      JAR: JAR, HEART_SELL: HEART_SELL, HEART_GIFT: HEART_GIFT,
      COVER_X: COVER_X,
    };
  }

var EXCAVATIONS = [
  {
    "id": "amber-pocket-v2",
    "title": "The Amber Pocket",
    "brief": "Split the great amber for a quick commission, or find loose amber and keep it whole for Flint.",
    "budget": 12,
    "recipe": {
      "amber": 2
    },
    "authoring": {
      "generator": "Jar snapshot",
      "seed": 20261029,
      "junk": 0.28,
      "rare": 0,
      "heart": false,
      "lode": 0,
      "shale": 0,
      "resettleSnapshot": true
    },
    "bodies": [
      {
        "id": 1,
        "key": "emerald",
        "x": 331.7985255297301,
        "y": 623,
        "r": 19
      },
      {
        "id": 2,
        "key": "emerald",
        "x": 226.83288477044982,
        "y": 623,
        "r": 19
      },
      {
        "id": 3,
        "key": "ruby",
        "x": 261.79166054068935,
        "y": 625,
        "r": 17
      },
      {
        "id": 4,
        "key": "sapphire",
        "x": 59,
        "y": 621,
        "r": 21
      },
      {
        "id": 5,
        "key": "ruby",
        "x": 295.2185020245258,
        "y": 625,
        "r": 17
      },
      {
        "id": 6,
        "key": "emerald",
        "x": 135.38171282609528,
        "y": 623,
        "r": 19
      },
      {
        "id": 7,
        "key": "amber",
        "x": 271.7357341663889,
        "y": 596.0409320326556,
        "r": 15
      },
      {
        "id": 8,
        "key": "ruby",
        "x": 55,
        "y": 584.0449925900768,
        "r": 17
      },
      {
        "id": 9,
        "key": "ruby",
        "x": 191.54325074998954,
        "y": 625,
        "r": 17
      },
      {
        "id": 10,
        "key": "rock_s",
        "x": 366,
        "y": 626,
        "r": 16
      },
      {
        "id": 11,
        "key": "rock_l",
        "x": 353,
        "y": 581.5079233162313,
        "r": 29
      },
      {
        "id": 12,
        "key": "emerald",
        "x": 98.04055639248406,
        "y": 623,
        "r": 19
      },
      {
        "id": 13,
        "key": "amber",
        "x": 312.19508127940105,
        "y": 599.5152820767462,
        "r": 15
      },
      {
        "id": 14,
        "key": "emerald",
        "x": 294.19299802924354,
        "y": 572.716516779779,
        "r": 19
      },
      {
        "id": 15,
        "key": "rock_m",
        "x": 319.42070666863,
        "y": 541.1862027709354,
        "r": 22
      },
      {
        "id": 16,
        "key": "ruby",
        "x": 211.1977503405098,
        "y": 591.8610191985216,
        "r": 17
      },
      {
        "id": 17,
        "key": "sapphire",
        "x": 250.80262619894629,
        "y": 560.224850257371,
        "r": 21
      },
      {
        "id": 18,
        "key": "sapphire",
        "x": 361,
        "y": 532.8921762796053,
        "r": 21
      },
      {
        "id": 19,
        "key": "amber",
        "x": 295.8537754056637,
        "y": 512.5326139469131,
        "r": 15
      },
      {
        "id": 20,
        "key": "rock_l",
        "x": 166.1524009071012,
        "y": 587.4447672146434,
        "r": 29
      },
      {
        "id": 21,
        "key": "sapphire",
        "x": 327.94666897727825,
        "y": 499.67667686618586,
        "r": 21
      },
      {
        "id": 22,
        "key": "amber",
        "x": 226.38513856187578,
        "y": 534.5744825840834,
        "r": 15
      },
      {
        "id": 23,
        "key": "emerald",
        "x": 116.41382743161977,
        "y": 590.9330752101557,
        "r": 19
      },
      {
        "id": 24,
        "key": "amber",
        "x": 53,
        "y": 553.1092516725975,
        "r": 15
      },
      {
        "id": 25,
        "key": "amber",
        "x": 242.472303738569,
        "y": 594.4737650409041,
        "r": 15
      },
      {
        "id": 26,
        "key": "rock_l",
        "x": 183.28404458687567,
        "y": 532.583221923752,
        "r": 29
      },
      {
        "id": 27,
        "key": "ruby",
        "x": 280.99067259756504,
        "y": 485.9350311313148,
        "r": 17
      },
      {
        "id": 28,
        "key": "amber",
        "x": 215.58987468047826,
        "y": 561.4155888373965,
        "r": 15
      },
      {
        "id": 29,
        "key": "ruby",
        "x": 281.29491082841884,
        "y": 540.0298526543593,
        "r": 17
      },
      {
        "id": 30,
        "key": "sapphire",
        "x": 80.36677847404431,
        "y": 531.0656839537827,
        "r": 21
      },
      {
        "id": 31,
        "key": "amber",
        "x": 85.75660010711417,
        "y": 577.4835375967252,
        "r": 15
      },
      {
        "id": 32,
        "key": "ruby",
        "x": 365,
        "y": 495.89393193172947,
        "r": 17
      },
      {
        "id": 33,
        "key": "rock_m",
        "x": 215.40466229472497,
        "y": 494.1849826477331,
        "r": 22
      },
      {
        "id": 34,
        "key": "amber",
        "x": 107.00979783241414,
        "y": 506.89129894193206,
        "r": 15
      },
      {
        "id": 35,
        "key": "rock_m",
        "x": 254.82500695239736,
        "y": 512.3169409301821,
        "r": 22
      },
      {
        "id": 36,
        "key": "amber",
        "x": 335.2332502866156,
        "y": 455.35613350802305,
        "r": 15
      },
      {
        "id": 37,
        "key": "emerald",
        "x": 248.65011293648914,
        "y": 472.56875853237335,
        "r": 19
      },
      {
        "id": 38,
        "key": "rock_l",
        "x": 127.61357871063963,
        "y": 545.2222307572063,
        "r": 29
      },
      {
        "id": 39,
        "key": "amber",
        "x": 179.65711439486307,
        "y": 487.6676788541069,
        "r": 15
      },
      {
        "id": 40,
        "key": "sapphire",
        "x": 196.3611918213627,
        "y": 456.69709412769146,
        "r": 21
      },
      {
        "id": 41,
        "key": "rock_s",
        "x": 308.52729353537524,
        "y": 469.12431086403717,
        "r": 16
      },
      {
        "id": 42,
        "key": "rock_m",
        "x": 284.17202169975496,
        "y": 411.19418725534393,
        "r": 22
      },
      {
        "id": 43,
        "key": "ruby",
        "x": 365,
        "y": 462.63921918337456,
        "r": 17
      },
      {
        "id": 44,
        "key": "sapphire",
        "x": 146.40092560956185,
        "y": 499.8402522916303,
        "r": 21
      },
      {
        "id": 45,
        "key": "emerald",
        "x": 278.8150095261224,
        "y": 450.85354408291175,
        "r": 19
      },
      {
        "id": 46,
        "key": "rock_s",
        "x": 310.62923464283625,
        "y": 437.8576912402414,
        "r": 16
      },
      {
        "id": 47,
        "key": "rock_m",
        "x": 357.1675387235698,
        "y": 425.0622222748205,
        "r": 22
      },
      {
        "id": 48,
        "key": "ruby",
        "x": 322.5450858605248,
        "y": 408.22927920289663,
        "r": 17
      },
      {
        "id": 49,
        "key": "emerald",
        "x": 157.43345815459375,
        "y": 462.1543877513932,
        "r": 19
      },
      {
        "id": 50,
        "key": "emerald",
        "x": 305.6461965051794,
        "y": 377.01017573362515,
        "r": 19
      },
      {
        "id": 51,
        "key": "rock_l",
        "x": 353,
        "y": 374.74416283283443,
        "r": 29
      },
      {
        "id": 52,
        "key": "amber",
        "x": 53,
        "y": 509.0470775076131,
        "r": 15
      },
      {
        "id": 53,
        "key": "rock_s",
        "x": 79.33053468497812,
        "y": 494.8936372550823,
        "r": 16
      },
      {
        "id": 54,
        "key": "ruby",
        "x": 79.62849877435296,
        "y": 462.9538540232551,
        "r": 17
      },
      {
        "id": 55,
        "key": "sapphire",
        "x": 115.43396754981458,
        "y": 472.3478578739475,
        "r": 21
      },
      {
        "id": 56,
        "key": "sapphire",
        "x": 169.86634531737604,
        "y": 424.74694623043445,
        "r": 21
      },
      {
        "id": 57,
        "key": "amber",
        "x": 247.5009744958687,
        "y": 439.1282759489434,
        "r": 15
      },
      {
        "id": 58,
        "key": "amber",
        "x": 53,
        "y": 479.6434672067976,
        "r": 15
      },
      {
        "id": 59,
        "key": "amber",
        "x": 280.304681803544,
        "y": 355.4727826257281,
        "r": 15
      },
      {
        "id": 60,
        "key": "sapphire",
        "x": 217.04983057100011,
        "y": 420.9367332495157,
        "r": 21
      },
      {
        "id": 61,
        "key": "ruby",
        "x": 167.455969238431,
        "y": 364.3496415692845,
        "r": 17
      },
      {
        "id": 62,
        "key": "sapphire",
        "x": 59,
        "y": 431.94643198518145,
        "r": 21
      },
      {
        "id": 63,
        "key": "rock_s",
        "x": 132.16035000499977,
        "y": 439.1839664848075,
        "r": 16
      },
      {
        "id": 64,
        "key": "emerald",
        "x": 98.29261477708097,
        "y": 432.81341716731293,
        "r": 19
      },
      {
        "id": 65,
        "key": "ruby",
        "x": 319.1991251026139,
        "y": 344.3007123040255,
        "r": 17
      },
      {
        "id": 66,
        "key": "emerald",
        "x": 123.83290831875954,
        "y": 405.55870968786894,
        "r": 19
      },
      {
        "id": 67,
        "key": "rock_s",
        "x": 366,
        "y": 332.3966176573935,
        "r": 16
      },
      {
        "id": 68,
        "key": "rock_l",
        "x": 80.10301591014206,
        "y": 387.35864477854864,
        "r": 29
      },
      {
        "id": 69,
        "key": "emerald",
        "x": 190.9345111712484,
        "y": 391.3015142083571,
        "r": 19
      },
      {
        "id": 70,
        "key": "ruby",
        "x": 55,
        "y": 349.4987097850655,
        "r": 17
      },
      {
        "id": 71,
        "key": "amber",
        "x": 124.29720296233546,
        "y": 350.6171821829353,
        "r": 29,
        "great": true
      },
      {
        "id": 72,
        "key": "rock_m",
        "x": 168.36116447969425,
        "y": 326.0373880288809,
        "r": 22
      },
      {
        "id": 73,
        "key": "rock_l",
        "x": 244.65225812985912,
        "y": 379.98467475578104,
        "r": 29
      },
      {
        "id": 74,
        "key": "amber",
        "x": 154.75040419724078,
        "y": 392.8483583568827,
        "r": 15
      },
      {
        "id": 75,
        "key": "rock_m",
        "x": 203.33264613758746,
        "y": 351.2961072283192,
        "r": 22
      },
      {
        "id": 76,
        "key": "ruby",
        "x": 83.12653580368723,
        "y": 331.35161199006427,
        "r": 17
      },
      {
        "id": 77,
        "key": "rock_l",
        "x": 228.46867546352908,
        "y": 307.61649606828894,
        "r": 29
      },
      {
        "id": 78,
        "key": "ruby",
        "x": 260.04773986124104,
        "y": 274.88711750299615,
        "r": 17
      },
      {
        "id": 79,
        "key": "rock_s",
        "x": 54,
        "y": 317.08544515954577,
        "r": 16
      },
      {
        "id": 80,
        "key": "rock_l",
        "x": 285.7366050759903,
        "y": 312.4397737923763,
        "r": 29
      },
      {
        "id": 81,
        "key": "rock_m",
        "x": 336.15200522189787,
        "y": 309.77595084473955,
        "r": 22
      },
      {
        "id": 82,
        "key": "emerald",
        "x": 184.77620930666865,
        "y": 289.0162894727183,
        "r": 19
      },
      {
        "id": 83,
        "key": "rock_l",
        "x": 129.9509872582258,
        "y": 293.3494476495459,
        "r": 29
      },
      {
        "id": 84,
        "key": "emerald",
        "x": 306.2450275164109,
        "y": 269.605525975889,
        "r": 19
      },
      {
        "id": 85,
        "key": "amber",
        "x": 367,
        "y": 290.350323357246,
        "r": 15
      },
      {
        "id": 86,
        "key": "sapphire",
        "x": 80.48170060799535,
        "y": 292.0064090436229,
        "r": 21
      },
      {
        "id": 87,
        "key": "ruby",
        "x": 341.66154211891825,
        "y": 271.65028146744544,
        "r": 17
      }
    ],
    "specimens": [
      71
    ]
  },
  {
    "id": "twin-veins-v2",
    "title": "Twin Veins",
    "brief": "Two great gems, two colors. Split for the commission or find loose gems to preserve either specimen.",
    "budget": 12,
    "recipe": {
      "ruby": 2,
      "emerald": 2
    },
    "authoring": {
      "generator": "Jar snapshot",
      "seed": 20261030,
      "junk": 0.28,
      "rare": 0,
      "heart": false,
      "lode": 0,
      "shale": 0,
      "resettleSnapshot": false
    },
    "bodies": [
      {
        "id": 1,
        "key": "ruby",
        "x": 200.7923890842622,
        "y": 625,
        "r": 17
      },
      {
        "id": 2,
        "key": "sapphire",
        "x": 62.036416076908424,
        "y": 621,
        "r": 21
      },
      {
        "id": 3,
        "key": "ruby",
        "x": 166.1064879097949,
        "y": 625,
        "r": 17
      },
      {
        "id": 4,
        "key": "amber",
        "x": 134.75734532721773,
        "y": 627,
        "r": 15
      },
      {
        "id": 5,
        "key": "ruby",
        "x": 280.10187791710496,
        "y": 625,
        "r": 17
      },
      {
        "id": 6,
        "key": "ruby",
        "x": 187.90322392968406,
        "y": 594.4167343396688,
        "r": 17
      },
      {
        "id": 7,
        "key": "rock_m",
        "x": 323.637949256114,
        "y": 620,
        "r": 22
      },
      {
        "id": 8,
        "key": "emerald",
        "x": 101.46392209052189,
        "y": 623,
        "r": 19
      },
      {
        "id": 9,
        "key": "ruby",
        "x": 365,
        "y": 625,
        "r": 17
      },
      {
        "id": 10,
        "key": "ruby",
        "x": 55,
        "y": 584.2782479403583,
        "r": 17
      },
      {
        "id": 11,
        "key": "rock_m",
        "x": 241.91375799690417,
        "y": 620,
        "r": 22
      },
      {
        "id": 12,
        "key": "ruby",
        "x": 365,
        "y": 591.5529526350135,
        "r": 17
      },
      {
        "id": 13,
        "key": "ruby",
        "x": 182.43540947178576,
        "y": 561.4772515267326,
        "r": 17
      },
      {
        "id": 14,
        "key": "ruby",
        "x": 125.32228052287873,
        "y": 597.5866905765449,
        "r": 17
      },
      {
        "id": 15,
        "key": "ruby",
        "x": 87.97140402357411,
        "y": 590.1760706810417,
        "r": 17
      },
      {
        "id": 16,
        "key": "amber",
        "x": 150.55468591672002,
        "y": 567.0391060046227,
        "r": 15
      },
      {
        "id": 17,
        "key": "sapphire",
        "x": 59,
        "y": 547.0084319678983,
        "r": 21
      },
      {
        "id": 18,
        "key": "ruby",
        "x": 291.56200619603703,
        "y": 593.7693216655159,
        "r": 17
      },
      {
        "id": 19,
        "key": "rock_m",
        "x": 114.96285101400306,
        "y": 561.1637987054327,
        "r": 22
      },
      {
        "id": 20,
        "key": "rock_m",
        "x": 325.90727662050614,
        "y": 576.9309445186068,
        "r": 22
      },
      {
        "id": 21,
        "key": "amber",
        "x": 156.57818577111743,
        "y": 595.330097325108,
        "r": 15
      },
      {
        "id": 22,
        "key": "rock_s",
        "x": 219.97814643807342,
        "y": 589.7165321692221,
        "r": 16
      },
      {
        "id": 23,
        "key": "amber",
        "x": 91.54572139856009,
        "y": 533.4870777781139,
        "r": 15
      },
      {
        "id": 24,
        "key": "sapphire",
        "x": 218.93124198448027,
        "y": 553.2784021728132,
        "r": 21
      },
      {
        "id": 25,
        "key": "rock_s",
        "x": 366,
        "y": 517.9679350376728,
        "r": 16
      },
      {
        "id": 26,
        "key": "sapphire",
        "x": 361,
        "y": 554.0084033258577,
        "r": 21
      },
      {
        "id": 27,
        "key": "ruby",
        "x": 259.19362951101385,
        "y": 586.1427625451296,
        "r": 17
      },
      {
        "id": 28,
        "key": "rock_s",
        "x": 336.63274512601686,
        "y": 527.6962904432839,
        "r": 16
      },
      {
        "id": 29,
        "key": "rock_m",
        "x": 301.7466538677545,
        "y": 541.1217319212055,
        "r": 22
      },
      {
        "id": 30,
        "key": "ruby",
        "x": 159.2235205116453,
        "y": 537.3010011700626,
        "r": 17
      },
      {
        "id": 31,
        "key": "emerald",
        "x": 273.6772149562525,
        "y": 512.3720878474044,
        "r": 19
      },
      {
        "id": 32,
        "key": "rock_m",
        "x": 125.62484118584024,
        "y": 519.0370976192106,
        "r": 22
      },
      {
        "id": 33,
        "key": "sapphire",
        "x": 260.1003897299309,
        "y": 549.1460584182723,
        "r": 21
      },
      {
        "id": 34,
        "key": "rock_l",
        "x": 67,
        "y": 498.00371245515873,
        "r": 29
      },
      {
        "id": 35,
        "key": "emerald",
        "x": 313.52723846310965,
        "y": 502.42897229768124,
        "r": 19
      },
      {
        "id": 36,
        "key": "rock_s",
        "x": 170.19633542471973,
        "y": 507.0385491147607,
        "r": 16
      },
      {
        "id": 37,
        "key": "rock_s",
        "x": 190.78409431214268,
        "y": 530.1448964657942,
        "r": 16
      },
      {
        "id": 38,
        "key": "emerald",
        "x": 151.41697294178192,
        "y": 478.5128901482135,
        "r": 19
      },
      {
        "id": 39,
        "key": "emerald",
        "x": 286.2465375647776,
        "y": 477.3144391622824,
        "r": 19
      },
      {
        "id": 40,
        "key": "rock_l",
        "x": 352.9005197677707,
        "y": 475.46913141585975,
        "r": 29
      },
      {
        "id": 41,
        "key": "sapphire",
        "x": 59,
        "y": 449.3008125246185,
        "r": 21
      },
      {
        "id": 42,
        "key": "sapphire",
        "x": 112.46135553735746,
        "y": 479.0087258600126,
        "r": 21
      },
      {
        "id": 43,
        "key": "emerald",
        "x": 236.6387674653274,
        "y": 517.5977123925635,
        "r": 19
      },
      {
        "id": 44,
        "key": "rock_s",
        "x": 205.82530773566043,
        "y": 502.53126765805655,
        "r": 16
      },
      {
        "id": 45,
        "key": "amber",
        "x": 184.68414173600988,
        "y": 480.5479509241191,
        "r": 15
      },
      {
        "id": 46,
        "key": "rock_s",
        "x": 252.84891860831067,
        "y": 485.37854682302753,
        "r": 16
      },
      {
        "id": 47,
        "key": "ruby",
        "x": 95.98340242590614,
        "y": 445.5060757115627,
        "r": 17
      },
      {
        "id": 48,
        "key": "rock_s",
        "x": 54,
        "y": 413.3129400714871,
        "r": 16
      },
      {
        "id": 49,
        "key": "amber",
        "x": 313.2907322522876,
        "y": 457.5007621059215,
        "r": 15
      },
      {
        "id": 50,
        "key": "ruby",
        "x": 133.5179895170858,
        "y": 448.0802481026373,
        "r": 17
      },
      {
        "id": 51,
        "key": "rock_l",
        "x": 272.5092341901179,
        "y": 432.2172623001476,
        "r": 29
      },
      {
        "id": 52,
        "key": "rock_l",
        "x": 220.05658895140397,
        "y": 455.61789204849225,
        "r": 29
      },
      {
        "id": 53,
        "key": "amber",
        "x": 233.33279520419336,
        "y": 413.5385886128781,
        "r": 15
      },
      {
        "id": 54,
        "key": "rock_m",
        "x": 196.9746636245294,
        "y": 410.8225922420983,
        "r": 22
      },
      {
        "id": 55,
        "key": "rock_s",
        "x": 334.0744347017366,
        "y": 435.2228978141559,
        "r": 16
      },
      {
        "id": 56,
        "key": "sapphire",
        "x": 73.7587259381515,
        "y": 382.98870978330564,
        "r": 21
      },
      {
        "id": 57,
        "key": "rock_l",
        "x": 117.75309971924062,
        "y": 405.5394286824123,
        "r": 29
      },
      {
        "id": 58,
        "key": "sapphire",
        "x": 171.68107834233814,
        "y": 444.8659903926108,
        "r": 21
      },
      {
        "id": 59,
        "key": "rock_m",
        "x": 163.20088434047395,
        "y": 383.5417541013128,
        "r": 22
      },
      {
        "id": 60,
        "key": "rock_l",
        "x": 315.9719975399954,
        "y": 394.6039321467336,
        "r": 29
      },
      {
        "id": 61,
        "key": "sapphire",
        "x": 208.9150552992522,
        "y": 370.0913178872908,
        "r": 21
      },
      {
        "id": 62,
        "key": "emerald",
        "x": 362.99814973139416,
        "y": 401.11337049083244,
        "r": 19
      },
      {
        "id": 63,
        "key": "amber",
        "x": 367,
        "y": 434.26269792874,
        "r": 15
      },
      {
        "id": 64,
        "key": "rock_l",
        "x": 109.3757810798494,
        "y": 348.68079716641716,
        "r": 29
      },
      {
        "id": 65,
        "key": "sapphire",
        "x": 59,
        "y": 344.26970361973616,
        "r": 21
      },
      {
        "id": 66,
        "key": "ruby",
        "x": 365,
        "y": 365.76902783168697,
        "r": 17
      },
      {
        "id": 67,
        "key": "sapphire",
        "x": 187.83763114711869,
        "y": 334.396511439352,
        "r": 21
      },
      {
        "id": 68,
        "key": "ruby",
        "x": 55,
        "y": 273.63662548375913,
        "r": 17
      },
      {
        "id": 69,
        "key": "rock_s",
        "x": 153.7484989419432,
        "y": 347.3192720341103,
        "r": 16
      },
      {
        "id": 70,
        "key": "ruby",
        "x": 55,
        "y": 307.0644391659027,
        "r": 17
      },
      {
        "id": 71,
        "key": "rock_s",
        "x": 156.38341081681205,
        "y": 315.93615873607,
        "r": 16
      },
      {
        "id": 72,
        "key": "ruby",
        "x": 88.4632927498664,
        "y": 308.3276952578844,
        "r": 17
      },
      {
        "id": 73,
        "key": "rock_l",
        "x": 257.95846231547193,
        "y": 376.67132392955216,
        "r": 29
      },
      {
        "id": 74,
        "key": "emerald",
        "x": 184.04051256203098,
        "y": 295.0821765350426,
        "r": 19
      },
      {
        "id": 75,
        "key": "ruby",
        "x": 334.23350674210656,
        "y": 352.90284880097744,
        "r": 17
      },
      {
        "id": 76,
        "key": "emerald",
        "x": 124.18210170296591,
        "y": 303.5982600378803,
        "r": 19
      },
      {
        "id": 77,
        "key": "rock_s",
        "x": 366,
        "y": 333.2874539952645,
        "r": 16
      },
      {
        "id": 78,
        "key": "rock_s",
        "x": 279.679915634049,
        "y": 314.7241262552517,
        "r": 16
      },
      {
        "id": 79,
        "key": "sapphire",
        "x": 297.27257098269297,
        "y": 346.67551651236926,
        "r": 21
      },
      {
        "id": 80,
        "key": "rock_s",
        "x": 88.54557135501015,
        "y": 275.85263202798063,
        "r": 16
      },
      {
        "id": 81,
        "key": "amber",
        "x": 333.84377794776617,
        "y": 321.47783137204215,
        "r": 15
      },
      {
        "id": 82,
        "key": "rock_m",
        "x": 150.31617938774593,
        "y": 272.6621813995235,
        "r": 22
      },
      {
        "id": 83,
        "key": "amber",
        "x": 53,
        "y": 242.2029871315214,
        "r": 15
      },
      {
        "id": 84,
        "key": "emerald",
        "x": 236.1018047067593,
        "y": 323.4917653638911,
        "r": 29,
        "great": true
      },
      {
        "id": 85,
        "key": "sapphire",
        "x": 310.3013354615936,
        "y": 294.9120171137076,
        "r": 21
      },
      {
        "id": 86,
        "key": "ruby",
        "x": 358.3500247656715,
        "y": 301.746342036271,
        "r": 17
      },
      {
        "id": 87,
        "key": "ruby",
        "x": 263.8497926608872,
        "y": 273.13125971175987,
        "r": 29,
        "great": true
      },
      {
        "id": 88,
        "key": "ruby",
        "x": 365,
        "y": 268.937428449963,
        "r": 17
      }
    ],
    "specimens": [
      84,
      87
    ]
  },
  {
    "id": "seven-slots-v2",
    "title": "Seven Slots",
    "brief": "A seven-gem commission fills the satchel. Leave room for a split, or find loose gems to keep the specimens.",
    "budget": 23,
    "recipe": {
      "sapphire": 3,
      "amber": 3,
      "emerald": 1
    },
    "authoring": {
      "generator": "Jar snapshot",
      "seed": 20261105,
      "junk": 0.28,
      "rare": 0,
      "heart": false,
      "lode": 0,
      "shale": 0,
      "resettleSnapshot": false
    },
    "bodies": [
      {
        "id": 1,
        "key": "sapphire",
        "x": 186.72445405145766,
        "y": 621,
        "r": 21
      },
      {
        "id": 2,
        "key": "emerald",
        "x": 66.21393182035754,
        "y": 623,
        "r": 19
      },
      {
        "id": 3,
        "key": "amber",
        "x": 100.76910107433467,
        "y": 627,
        "r": 15
      },
      {
        "id": 4,
        "key": "rock_s",
        "x": 90.3539226786884,
        "y": 598.335622410243,
        "r": 16
      },
      {
        "id": 5,
        "key": "rock_l",
        "x": 132.05687813997017,
        "y": 583.1033375614492,
        "r": 29
      },
      {
        "id": 6,
        "key": "emerald",
        "x": 325.51769153659427,
        "y": 623,
        "r": 19
      },
      {
        "id": 7,
        "key": "emerald",
        "x": 363,
        "y": 623,
        "r": 19
      },
      {
        "id": 8,
        "key": "ruby",
        "x": 149.7208494075616,
        "y": 625,
        "r": 17
      },
      {
        "id": 9,
        "key": "amber",
        "x": 53,
        "y": 592.3565023874615,
        "r": 15
      },
      {
        "id": 10,
        "key": "emerald",
        "x": 179.1880737114788,
        "y": 582.3229374047959,
        "r": 19
      },
      {
        "id": 11,
        "key": "sapphire",
        "x": 332.4268653642623,
        "y": 584.2275691560205,
        "r": 21
      },
      {
        "id": 12,
        "key": "amber",
        "x": 279.15422765331783,
        "y": 627,
        "r": 15
      },
      {
        "id": 13,
        "key": "emerald",
        "x": 244.7791847432535,
        "y": 623,
        "r": 19
      },
      {
        "id": 14,
        "key": "emerald",
        "x": 170.5308429673284,
        "y": 545.8147006627871,
        "r": 19
      },
      {
        "id": 15,
        "key": "rock_m",
        "x": 218.23463500925212,
        "y": 592.5278086620283,
        "r": 22
      },
      {
        "id": 16,
        "key": "rock_m",
        "x": 291.8107018102339,
        "y": 593.2085146819785,
        "r": 22
      },
      {
        "id": 17,
        "key": "ruby",
        "x": 92.40742332014926,
        "y": 560.9817999170571,
        "r": 17
      },
      {
        "id": 18,
        "key": "emerald",
        "x": 57,
        "y": 559.135795580009,
        "r": 19
      },
      {
        "id": 19,
        "key": "rock_s",
        "x": 254.85358952992323,
        "y": 588.7463118209363,
        "r": 16
      },
      {
        "id": 20,
        "key": "rock_s",
        "x": 76.73658460597676,
        "y": 531.1715380889012,
        "r": 16
      },
      {
        "id": 21,
        "key": "rock_s",
        "x": 106.96394448809815,
        "y": 525.6023510003434,
        "r": 16
      },
      {
        "id": 22,
        "key": "ruby",
        "x": 203.8359435085919,
        "y": 556.8124344785989,
        "r": 17
      },
      {
        "id": 23,
        "key": "amber",
        "x": 367,
        "y": 590.0700288748935,
        "r": 15
      },
      {
        "id": 24,
        "key": "amber",
        "x": 53,
        "y": 512.6078285816478,
        "r": 15
      },
      {
        "id": 25,
        "key": "ruby",
        "x": 306.41483915784454,
        "y": 557.6508328084699,
        "r": 17
      },
      {
        "id": 26,
        "key": "ruby",
        "x": 224.05287721842228,
        "y": 526.5409835617036,
        "r": 17
      },
      {
        "id": 27,
        "key": "ruby",
        "x": 274.0419100061561,
        "y": 559.1185692017702,
        "r": 17
      },
      {
        "id": 28,
        "key": "amber",
        "x": 367,
        "y": 560.7079570084267,
        "r": 15
      },
      {
        "id": 29,
        "key": "sapphire",
        "x": 87.85510362822907,
        "y": 495.17405045515477,
        "r": 21
      },
      {
        "id": 30,
        "key": "ruby",
        "x": 136.34733877768744,
        "y": 538.2548875638878,
        "r": 17
      },
      {
        "id": 31,
        "key": "rock_l",
        "x": 274.71762547877904,
        "y": 513.6263236502988,
        "r": 29
      },
      {
        "id": 32,
        "key": "emerald",
        "x": 239.01481312123664,
        "y": 558.171252577137,
        "r": 19
      },
      {
        "id": 33,
        "key": "sapphire",
        "x": 160.67824043625822,
        "y": 507.8183538475591,
        "r": 21
      },
      {
        "id": 34,
        "key": "amber",
        "x": 336.25689257505957,
        "y": 549.3425504504628,
        "r": 15
      },
      {
        "id": 35,
        "key": "sapphire",
        "x": 196.8818562958937,
        "y": 486.7994836019947,
        "r": 21
      },
      {
        "id": 36,
        "key": "amber",
        "x": 315.80236258127604,
        "y": 528.3957463354842,
        "r": 15
      },
      {
        "id": 37,
        "key": "amber",
        "x": 193.03763929764958,
        "y": 521.946102780471,
        "r": 15
      },
      {
        "id": 38,
        "key": "rock_m",
        "x": 250.65566112596872,
        "y": 466.20405505273123,
        "r": 22
      },
      {
        "id": 39,
        "key": "sapphire",
        "x": 361,
        "y": 524.7414219337375,
        "r": 21
      },
      {
        "id": 40,
        "key": "rock_s",
        "x": 54,
        "y": 482.1949416209296,
        "r": 16
      },
      {
        "id": 41,
        "key": "ruby",
        "x": 125.00730351559555,
        "y": 496.8277553799998,
        "r": 17
      },
      {
        "id": 42,
        "key": "rock_l",
        "x": 329.09929792446684,
        "y": 487.0779152644866,
        "r": 29
      },
      {
        "id": 43,
        "key": "rock_s",
        "x": 287.67004080096785,
        "y": 471.1275517945283,
        "r": 16
      },
      {
        "id": 44,
        "key": "ruby",
        "x": 79.08832816266643,
        "y": 458.9919358169806,
        "r": 17
      },
      {
        "id": 45,
        "key": "amber",
        "x": 230.81950171944365,
        "y": 496.4395877447824,
        "r": 15
      },
      {
        "id": 46,
        "key": "rock_l",
        "x": 156.31831925924365,
        "y": 458.55792119962564,
        "r": 29
      },
      {
        "id": 47,
        "key": "ruby",
        "x": 214.35778737036557,
        "y": 453.6732522654282,
        "r": 17
      },
      {
        "id": 48,
        "key": "ruby",
        "x": 111.54987250616534,
        "y": 466.18588912606833,
        "r": 17
      },
      {
        "id": 49,
        "key": "rock_m",
        "x": 309.32462892692485,
        "y": 440.6945514726349,
        "r": 22
      },
      {
        "id": 50,
        "key": "ruby",
        "x": 125.36843312319793,
        "y": 425.60862062998496,
        "r": 17
      },
      {
        "id": 51,
        "key": "rock_m",
        "x": 239.22323589507337,
        "y": 424.2880362828124,
        "r": 22
      },
      {
        "id": 52,
        "key": "emerald",
        "x": 57,
        "y": 431.6236392444951,
        "r": 19
      },
      {
        "id": 53,
        "key": "ruby",
        "x": 91.96827869093089,
        "y": 428.0319180469334,
        "r": 17
      },
      {
        "id": 54,
        "key": "amber",
        "x": 190.98347795247125,
        "y": 432.65527031773365,
        "r": 15
      },
      {
        "id": 55,
        "key": "rock_s",
        "x": 206.43400637197885,
        "y": 406.4656408606314,
        "r": 16
      },
      {
        "id": 56,
        "key": "amber",
        "x": 273.08461443934533,
        "y": 438.2411899039463,
        "r": 15
      },
      {
        "id": 57,
        "key": "ruby",
        "x": 365,
        "y": 459.61659045297,
        "r": 17
      },
      {
        "id": 58,
        "key": "rock_s",
        "x": 366,
        "y": 427.279896692081,
        "r": 16
      },
      {
        "id": 59,
        "key": "amber",
        "x": 108.11314500903404,
        "y": 399.3382888171659,
        "r": 15
      },
      {
        "id": 60,
        "key": "ruby",
        "x": 273.5852471054569,
        "y": 407.0504785159351,
        "r": 17
      },
      {
        "id": 61,
        "key": "rock_m",
        "x": 335.37658071074486,
        "y": 406.06994199979283,
        "r": 22
      },
      {
        "id": 62,
        "key": "emerald",
        "x": 219.9001176747316,
        "y": 374.80434207543493,
        "r": 19
      },
      {
        "id": 63,
        "key": "amber",
        "x": 137.3960000834475,
        "y": 396.620388813573,
        "r": 15
      },
      {
        "id": 64,
        "key": "ruby",
        "x": 301.19529562835913,
        "y": 388.6602023976194,
        "r": 17
      },
      {
        "id": 65,
        "key": "ruby",
        "x": 163.73112996316908,
        "y": 413.80221735141106,
        "r": 17
      },
      {
        "id": 66,
        "key": "amber",
        "x": 147.84145340444672,
        "y": 369.09697826943,
        "r": 15
      },
      {
        "id": 67,
        "key": "emerald",
        "x": 363,
        "y": 376.4930924025822,
        "r": 19
      },
      {
        "id": 68,
        "key": "sapphire",
        "x": 181.29115172981415,
        "y": 380.43364854378257,
        "r": 21
      },
      {
        "id": 69,
        "key": "ruby",
        "x": 365,
        "y": 318.32598283084656,
        "r": 17
      },
      {
        "id": 70,
        "key": "sapphire",
        "x": 197.78531353500463,
        "y": 342.3331613947958,
        "r": 21
      },
      {
        "id": 71,
        "key": "rock_l",
        "x": 67,
        "y": 385.1995962513502,
        "r": 29
      },
      {
        "id": 72,
        "key": "rock_s",
        "x": 54,
        "y": 342.6674097658763,
        "r": 16
      },
      {
        "id": 73,
        "key": "amber",
        "x": 349.6608419319488,
        "y": 345.80654618375655,
        "r": 15
      },
      {
        "id": 74,
        "key": "ruby",
        "x": 327.7987979349386,
        "y": 368.4264167737705,
        "r": 17
      },
      {
        "id": 75,
        "key": "rock_m",
        "x": 112.06447989511223,
        "y": 362.8163872614348,
        "r": 22
      },
      {
        "id": 76,
        "key": "rock_s",
        "x": 253.55827456574926,
        "y": 381.8403841487942,
        "r": 16
      },
      {
        "id": 77,
        "key": "sapphire",
        "x": 67,
        "y": 280.8292699442824,
        "r": 29,
        "great": true
      },
      {
        "id": 78,
        "key": "ruby",
        "x": 141.66649773987132,
        "y": 338.27889062423964,
        "r": 17
      },
      {
        "id": 79,
        "key": "sapphire",
        "x": 280.5545997499878,
        "y": 357.4011153283801,
        "r": 21
      },
      {
        "id": 80,
        "key": "emerald",
        "x": 313.6116447639705,
        "y": 335.972240536469,
        "r": 19
      },
      {
        "id": 81,
        "key": "emerald",
        "x": 332.6112295040133,
        "y": 303.79702064096614,
        "r": 19
      },
      {
        "id": 82,
        "key": "sapphire",
        "x": 265.99737237333443,
        "y": 318.53181074725717,
        "r": 21
      },
      {
        "id": 83,
        "key": "ruby",
        "x": 244.05297572063117,
        "y": 348.89214720751437,
        "r": 17
      },
      {
        "id": 84,
        "key": "ruby",
        "x": 168.74365326220115,
        "y": 318.64690597503545,
        "r": 17
      },
      {
        "id": 85,
        "key": "ruby",
        "x": 199.2521199151599,
        "y": 304.8554921285955,
        "r": 17
      },
      {
        "id": 86,
        "key": "emerald",
        "x": 363,
        "y": 281.8943345045848,
        "r": 19
      },
      {
        "id": 87,
        "key": "rock_s",
        "x": 227.43485820475553,
        "y": 320.98400083829733,
        "r": 16
      },
      {
        "id": 88,
        "key": "rock_m",
        "x": 87.84961432315757,
        "y": 326.78824051256953,
        "r": 22
      },
      {
        "id": 89,
        "key": "rock_l",
        "x": 176.42476002288583,
        "y": 265.4986854252764,
        "r": 29
      },
      {
        "id": 90,
        "key": "rock_l",
        "x": 127.16252187894732,
        "y": 295.15218253968914,
        "r": 29
      },
      {
        "id": 91,
        "key": "amber",
        "x": 299.1143971839622,
        "y": 305.7843200356661,
        "r": 15
      },
      {
        "id": 92,
        "key": "emerald",
        "x": 309.77833404438417,
        "y": 274.0290687729577,
        "r": 19
      },
      {
        "id": 93,
        "key": "ruby",
        "x": 240.34980670327252,
        "y": 291.16243086210534,
        "r": 17
      },
      {
        "id": 94,
        "key": "amber",
        "x": 266.6837777936267,
        "y": 254.0615503952971,
        "r": 29,
        "great": true
      }
    ],
    "specimens": [
      77,
      94
    ]
  },
  {
    "id": "hard-way-round-v2",
    "title": "The Hard Way Round",
    "brief": "A dense stone guards the great sapphire. Take the shortcut or find loose sapphires and keep it whole.",
    "budget": 14,
    "recipe": {
      "sapphire": 3,
      "emerald": 1
    },
    "authoring": {
      "generator": "Jar snapshot",
      "seed": 20261101,
      "junk": 0.28,
      "rare": 0,
      "heart": false,
      "lode": 0,
      "shale": 0,
      "resettleSnapshot": false
    },
    "bodies": [
      {
        "id": 1,
        "key": "rock_m",
        "x": 108.33849609711908,
        "y": 620,
        "r": 22
      },
      {
        "id": 2,
        "key": "sapphire",
        "x": 357.31012411123527,
        "y": 621,
        "r": 21
      },
      {
        "id": 3,
        "key": "ruby",
        "x": 257.4824090363473,
        "y": 625,
        "r": 17
      },
      {
        "id": 4,
        "key": "amber",
        "x": 53,
        "y": 627,
        "r": 15
      },
      {
        "id": 5,
        "key": "sapphire",
        "x": 202.71676108213245,
        "y": 621,
        "r": 21
      },
      {
        "id": 6,
        "key": "emerald",
        "x": 317.93637281655316,
        "y": 623,
        "r": 19
      },
      {
        "id": 7,
        "key": "amber",
        "x": 74.4815240801848,
        "y": 606.8849348586116,
        "r": 15
      },
      {
        "id": 8,
        "key": "sapphire",
        "x": 260.31180963726445,
        "y": 580.7241418465038,
        "r": 21
      },
      {
        "id": 9,
        "key": "emerald",
        "x": 57,
        "y": 578.4208381406659,
        "r": 19
      },
      {
        "id": 10,
        "key": "ruby",
        "x": 285.92154416101215,
        "y": 607.8270580224099,
        "r": 17
      },
      {
        "id": 11,
        "key": "amber",
        "x": 233.98751307068997,
        "y": 604.3463820017128,
        "r": 15
      },
      {
        "id": 12,
        "key": "rock_l",
        "x": 103.53262386888655,
        "y": 569.734092592348,
        "r": 29
      },
      {
        "id": 13,
        "key": "sapphire",
        "x": 361,
        "y": 579.6662229471498,
        "r": 21
      },
      {
        "id": 14,
        "key": "sapphire",
        "x": 208.3200993051622,
        "y": 579.8895278216331,
        "r": 21
      },
      {
        "id": 15,
        "key": "sapphire",
        "x": 319.78490330281755,
        "y": 583.9131195180105,
        "r": 21
      },
      {
        "id": 16,
        "key": "sapphire",
        "x": 361,
        "y": 538.2143376564371,
        "r": 21
      },
      {
        "id": 17,
        "key": "ruby",
        "x": 55,
        "y": 542.9800196031636,
        "r": 17
      },
      {
        "id": 18,
        "key": "rock_s",
        "x": 145.21013708657875,
        "y": 626,
        "r": 16
      },
      {
        "id": 19,
        "key": "amber",
        "x": 129.99394425872268,
        "y": 535.2405021263069,
        "r": 15
      },
      {
        "id": 20,
        "key": "sapphire",
        "x": 202.68483565283728,
        "y": 538.9653647591666,
        "r": 21
      },
      {
        "id": 21,
        "key": "rock_l",
        "x": 309.06643601183697,
        "y": 535.7539165061158,
        "r": 29
      },
      {
        "id": 22,
        "key": "sapphire",
        "x": 361,
        "y": 496.7243695085398,
        "r": 21
      },
      {
        "id": 23,
        "key": "sapphire",
        "x": 94.11399197554735,
        "y": 521.1958372955669,
        "r": 21
      },
      {
        "id": 24,
        "key": "rock_s",
        "x": 216.29337666901824,
        "y": 505.128199019904,
        "r": 16
      },
      {
        "id": 25,
        "key": "amber",
        "x": 169.83622912849455,
        "y": 608.230648549642,
        "r": 15
      },
      {
        "id": 26,
        "key": "emerald",
        "x": 322.1131071588826,
        "y": 490.4177122492657,
        "r": 19
      },
      {
        "id": 27,
        "key": "rock_l",
        "x": 251.6963290604461,
        "y": 532.129871683186,
        "r": 29
      },
      {
        "id": 28,
        "key": "emerald",
        "x": 363,
        "y": 457.528811578447,
        "r": 19
      },
      {
        "id": 29,
        "key": "rock_l",
        "x": 160.922693471661,
        "y": 565.6943411780978,
        "r": 29
      },
      {
        "id": 30,
        "key": "emerald",
        "x": 131.11511186096746,
        "y": 501.9112121399299,
        "r": 19
      },
      {
        "id": 31,
        "key": "rock_m",
        "x": 118.50987298474526,
        "y": 463.46719480711823,
        "r": 22
      },
      {
        "id": 32,
        "key": "sapphire",
        "x": 167.7187539352269,
        "y": 516.6950188400658,
        "r": 21
      },
      {
        "id": 33,
        "key": "amber",
        "x": 287.1511009120631,
        "y": 409.9087005351363,
        "r": 15
      },
      {
        "id": 34,
        "key": "rock_s",
        "x": 197.84141275228794,
        "y": 479.71483789562774,
        "r": 16
      },
      {
        "id": 35,
        "key": "ruby",
        "x": 285.61331224690827,
        "y": 497.15737206283495,
        "r": 17
      },
      {
        "id": 36,
        "key": "emerald",
        "x": 57,
        "y": 507.86523729106534,
        "r": 19
      },
      {
        "id": 37,
        "key": "amber",
        "x": 89.8633307616173,
        "y": 485.9983176638408,
        "r": 15
      },
      {
        "id": 38,
        "key": "amber",
        "x": 277.8361658932132,
        "y": 466.6927842056145,
        "r": 15
      },
      {
        "id": 39,
        "key": "rock_l",
        "x": 314.53676373358536,
        "y": 443.5815128382784,
        "r": 29
      },
      {
        "id": 40,
        "key": "sapphire",
        "x": 59,
        "y": 468.5965176883132,
        "r": 21
      },
      {
        "id": 41,
        "key": "amber",
        "x": 256.5238394961518,
        "y": 403.2723543364613,
        "r": 15
      },
      {
        "id": 42,
        "key": "ruby",
        "x": 253.78013622358446,
        "y": 486.8883958970566,
        "r": 17
      },
      {
        "id": 43,
        "key": "rock_m",
        "x": 160.75059212507094,
        "y": 474.33932737990574,
        "r": 22
      },
      {
        "id": 44,
        "key": "emerald",
        "x": 265.95031309943187,
        "y": 435.41729172384953,
        "r": 19
      },
      {
        "id": 45,
        "key": "ruby",
        "x": 86.21833534652897,
        "y": 442.7796413987276,
        "r": 17
      },
      {
        "id": 46,
        "key": "emerald",
        "x": 235.32977599760218,
        "y": 456.8380870049739,
        "r": 19
      },
      {
        "id": 47,
        "key": "ruby",
        "x": 55,
        "y": 431.48503677301153,
        "r": 17
      },
      {
        "id": 48,
        "key": "ruby",
        "x": 159.84888576956075,
        "y": 401.5878778338363,
        "r": 17
      },
      {
        "id": 49,
        "key": "sapphire",
        "x": 84.40136691447799,
        "y": 405.75425938156445,
        "r": 21
      },
      {
        "id": 50,
        "key": "rock_m",
        "x": 357.6990848055082,
        "y": 417.45744816004344,
        "r": 22
      },
      {
        "id": 51,
        "key": "amber",
        "x": 234.80749589254626,
        "y": 423.240724800564,
        "r": 15
      },
      {
        "id": 52,
        "key": "emerald",
        "x": 145.67413964223834,
        "y": 433.8743324760793,
        "r": 19
      },
      {
        "id": 53,
        "key": "rock_s",
        "x": 330.7635590450505,
        "y": 367.36414673731525,
        "r": 16
      },
      {
        "id": 54,
        "key": "amber",
        "x": 229.30555024914077,
        "y": 394.2252456923537,
        "r": 15
      },
      {
        "id": 55,
        "key": "amber",
        "x": 113.09659743856419,
        "y": 426.76599460189175,
        "r": 15
      },
      {
        "id": 56,
        "key": "sapphire",
        "x": 123.5905770851373,
        "y": 392.6288638351281,
        "r": 21
      },
      {
        "id": 57,
        "key": "amber",
        "x": 367,
        "y": 382.198638289057,
        "r": 15
      },
      {
        "id": 58,
        "key": "rock_m",
        "x": 60,
        "y": 371.16942515177294,
        "r": 22
      },
      {
        "id": 59,
        "key": "rock_m",
        "x": 194.30855167634033,
        "y": 384.7453209211442,
        "r": 22
      },
      {
        "id": 60,
        "key": "sapphire",
        "x": 361,
        "y": 347.17187934159955,
        "r": 21
      },
      {
        "id": 61,
        "key": "rock_l",
        "x": 104.31029439060879,
        "y": 347.10596371011866,
        "r": 29
      },
      {
        "id": 62,
        "key": "ruby",
        "x": 323.8690583857733,
        "y": 399.0874324659098,
        "r": 17
      },
      {
        "id": 63,
        "key": "rock_l",
        "x": 193.06430531217725,
        "y": 435.39773702173346,
        "r": 29
      },
      {
        "id": 64,
        "key": "emerald",
        "x": 174.4495501469388,
        "y": 349.54865896556566,
        "r": 19
      },
      {
        "id": 65,
        "key": "sapphire",
        "x": 264.3390100454872,
        "y": 333.10509446950067,
        "r": 29,
        "great": true
      },
      {
        "id": 66,
        "key": "amber",
        "x": 250.97356271380013,
        "y": 374.4961004496912,
        "r": 15
      },
      {
        "id": 67,
        "key": "rock_m",
        "x": 293.8655218836402,
        "y": 374.05763866622897,
        "r": 22
      },
      {
        "id": 68,
        "key": "sapphire",
        "x": 335.6333177895901,
        "y": 295.69841413017707,
        "r": 21
      },
      {
        "id": 69,
        "key": "amber",
        "x": 144.29381208768655,
        "y": 363.9697332694623,
        "r": 15
      },
      {
        "id": 70,
        "key": "amber",
        "x": 224.1300127748525,
        "y": 264.94071886490116,
        "r": 15
      },
      {
        "id": 71,
        "key": "rock_s",
        "x": 54,
        "y": 334.19035398838264,
        "r": 16
      },
      {
        "id": 72,
        "key": "emerald",
        "x": 146.2459228433351,
        "y": 324.87835326451795,
        "r": 19
      },
      {
        "id": 73,
        "key": "ruby",
        "x": 312.5735350767593,
        "y": 340.4171014203808,
        "r": 17
      },
      {
        "id": 74,
        "key": "amber",
        "x": 367,
        "y": 312.1858487159326,
        "r": 15
      },
      {
        "id": 75,
        "key": "sapphire",
        "x": 202.95492305330038,
        "y": 322.37648010785824,
        "r": 21
      },
      {
        "id": 76,
        "key": "rock_s",
        "x": 302.03505556092404,
        "y": 309.77899701394165,
        "r": 16
      },
      {
        "id": 77,
        "key": "emerald",
        "x": 117.02651849344824,
        "y": 301.4108726738541,
        "r": 19
      },
      {
        "id": 78,
        "key": "amber",
        "x": 172.54557571998842,
        "y": 304.1755822849151,
        "r": 15
      },
      {
        "id": 79,
        "key": "sapphire",
        "x": 76.9897431723431,
        "y": 305.8612780891528,
        "r": 21
      },
      {
        "id": 80,
        "key": "ruby",
        "x": 199.90835416652132,
        "y": 285.039707853928,
        "r": 17
      },
      {
        "id": 81,
        "key": "emerald",
        "x": 222.9515937646968,
        "y": 356.38520564645904,
        "r": 19
      },
      {
        "id": 82,
        "key": "sapphire",
        "x": 361,
        "y": 262.8809532156509,
        "r": 21
      },
      {
        "id": 83,
        "key": "amber",
        "x": 181.28850868606116,
        "y": 259.651292727339,
        "r": 15
      },
      {
        "id": 84,
        "key": "amber",
        "x": 53,
        "y": 279.7207522174715,
        "r": 15
      },
      {
        "id": 85,
        "key": "emerald",
        "x": 233.29455739856536,
        "y": 297.1635532148414,
        "r": 19
      },
      {
        "id": 86,
        "key": "rock_m",
        "x": 148.86415095962454,
        "y": 276.4004838906393,
        "r": 22
      },
      {
        "id": 87,
        "key": "ruby",
        "x": 95.45828454235445,
        "y": 273.23244470203656,
        "r": 17
      },
      {
        "id": 88,
        "key": "rock_l",
        "x": 275.00153997053224,
        "y": 274.43771877926304,
        "r": 29,
        "lode": true
      }
    ],
    "specimens": [
      65
    ]
  },
  {
    "id": "flints-fork-v2",
    "title": "Flint's Fork",
    "brief": "Three specimen colors in different pockets. Finish the commission quickly or spend more swings collecting for Flint.",
    "budget": 18,
    "recipe": {
      "ruby": 2,
      "amber": 2,
      "sapphire": 1
    },
    "authoring": {
      "generator": "Jar snapshot",
      "seed": 20261102,
      "junk": 0.28,
      "rare": 0,
      "heart": false,
      "lode": 0,
      "shale": 0,
      "resettleSnapshot": false
    },
    "bodies": [
      {
        "id": 1,
        "key": "sapphire",
        "x": 148.24550019833242,
        "y": 621,
        "r": 21
      },
      {
        "id": 2,
        "key": "emerald",
        "x": 219.8172675335207,
        "y": 623,
        "r": 19
      },
      {
        "id": 3,
        "key": "amber",
        "x": 185.63246535405187,
        "y": 627,
        "r": 15
      },
      {
        "id": 4,
        "key": "ruby",
        "x": 335.59221288634416,
        "y": 625,
        "r": 17
      },
      {
        "id": 5,
        "key": "rock_s",
        "x": 262.29231489075215,
        "y": 626,
        "r": 16
      },
      {
        "id": 6,
        "key": "ruby",
        "x": 61.40889319411552,
        "y": 625,
        "r": 17
      },
      {
        "id": 7,
        "key": "sapphire",
        "x": 298.37851961704524,
        "y": 621,
        "r": 21
      },
      {
        "id": 8,
        "key": "amber",
        "x": 367,
        "y": 627,
        "r": 15
      },
      {
        "id": 9,
        "key": "emerald",
        "x": 245.62172719028985,
        "y": 595.8167076833018,
        "r": 19
      },
      {
        "id": 10,
        "key": "rock_s",
        "x": 365.1288712630533,
        "y": 596.5601844272288,
        "r": 16
      },
      {
        "id": 11,
        "key": "rock_m",
        "x": 288.14837853637255,
        "y": 579.8499493641013,
        "r": 22
      },
      {
        "id": 12,
        "key": "ruby",
        "x": 110.12908570459335,
        "y": 593.6859514269709,
        "r": 17
      },
      {
        "id": 13,
        "key": "amber",
        "x": 255.35523863407383,
        "y": 563.7674464999682,
        "r": 15
      },
      {
        "id": 14,
        "key": "ruby",
        "x": 365,
        "y": 564.1909716130277,
        "r": 17
      },
      {
        "id": 15,
        "key": "ruby",
        "x": 55,
        "y": 592.1221696536469,
        "r": 17
      },
      {
        "id": 16,
        "key": "rock_l",
        "x": 181.90018104843722,
        "y": 583.8445755634003,
        "r": 29
      },
      {
        "id": 17,
        "key": "ruby",
        "x": 224.4482921820685,
        "y": 567.9190626346134,
        "r": 17
      },
      {
        "id": 18,
        "key": "emerald",
        "x": 152.53287111763328,
        "y": 546.6844603142669,
        "r": 19
      },
      {
        "id": 19,
        "key": "rock_s",
        "x": 137.89534543817197,
        "y": 577.7915029601351,
        "r": 16
      },
      {
        "id": 20,
        "key": "amber",
        "x": 323.3900966021245,
        "y": 596.5105328923956,
        "r": 15
      },
      {
        "id": 21,
        "key": "ruby",
        "x": 83.26642305697595,
        "y": 574.2064995075083,
        "r": 17
      },
      {
        "id": 22,
        "key": "emerald",
        "x": 280.0861414243468,
        "y": 540.1893260813348,
        "r": 19
      },
      {
        "id": 23,
        "key": "emerald",
        "x": 363,
        "y": 529.0942965533836,
        "r": 19
      },
      {
        "id": 24,
        "key": "amber",
        "x": 54.95766867516801,
        "y": 560.6249348231702,
        "r": 15
      },
      {
        "id": 25,
        "key": "rock_s",
        "x": 109.32387291046729,
        "y": 626,
        "r": 16
      },
      {
        "id": 26,
        "key": "ruby",
        "x": 55,
        "y": 529.2231390478069,
        "r": 17
      },
      {
        "id": 27,
        "key": "rock_m",
        "x": 112.12114157604998,
        "y": 548.742184386637,
        "r": 22
      },
      {
        "id": 28,
        "key": "rock_s",
        "x": 244.52649471030887,
        "y": 535.3860595535522,
        "r": 16
      },
      {
        "id": 29,
        "key": "rock_m",
        "x": 326.8371762712135,
        "y": 560.3926211403211,
        "r": 22
      },
      {
        "id": 30,
        "key": "rock_l",
        "x": 200.51400825743337,
        "y": 529.462664864559,
        "r": 29
      },
      {
        "id": 31,
        "key": "emerald",
        "x": 326.73478817311803,
        "y": 520.0140884677269,
        "r": 19
      },
      {
        "id": 32,
        "key": "ruby",
        "x": 126.99956955638898,
        "y": 485.23859932150754,
        "r": 17
      },
      {
        "id": 33,
        "key": "rock_l",
        "x": 82.920660454006,
        "y": 493.4538674213505,
        "r": 29
      },
      {
        "id": 34,
        "key": "emerald",
        "x": 112.12531809875809,
        "y": 453.0435906276407,
        "r": 19
      },
      {
        "id": 35,
        "key": "emerald",
        "x": 363,
        "y": 491.7560490883564,
        "r": 19
      },
      {
        "id": 36,
        "key": "sapphire",
        "x": 156.72604781004813,
        "y": 507.639531492023,
        "r": 21
      },
      {
        "id": 37,
        "key": "sapphire",
        "x": 334.4856416434736,
        "y": 464.80452697300717,
        "r": 21
      },
      {
        "id": 38,
        "key": "rock_m",
        "x": 189.0911914966838,
        "y": 480.5745158431095,
        "r": 22
      },
      {
        "id": 39,
        "key": "emerald",
        "x": 153.3980017883538,
        "y": 461.82033662841764,
        "r": 19
      },
      {
        "id": 40,
        "key": "emerald",
        "x": 263.5609555457171,
        "y": 506.6691313772244,
        "r": 19
      },
      {
        "id": 41,
        "key": "ruby",
        "x": 253.80558082817538,
        "y": 431.3485283962941,
        "r": 17
      },
      {
        "id": 42,
        "key": "rock_s",
        "x": 230.55170624429766,
        "y": 496.6619937832452,
        "r": 16
      },
      {
        "id": 43,
        "key": "sapphire",
        "x": 140.3583183493826,
        "y": 424.8926231326771,
        "r": 21
      },
      {
        "id": 44,
        "key": "emerald",
        "x": 363,
        "y": 437.79631194065547,
        "r": 19
      },
      {
        "id": 45,
        "key": "rock_l",
        "x": 67,
        "y": 438.26240737671156,
        "r": 29
      },
      {
        "id": 46,
        "key": "sapphire",
        "x": 264.0370332507601,
        "y": 467.4122667377704,
        "r": 21
      },
      {
        "id": 47,
        "key": "sapphire",
        "x": 224.05177660903206,
        "y": 456.9945199730498,
        "r": 21
      },
      {
        "id": 48,
        "key": "rock_m",
        "x": 298.2145515089366,
        "y": 443.0164083419739,
        "r": 22
      },
      {
        "id": 49,
        "key": "amber",
        "x": 331.1942712972739,
        "y": 428.51383645095274,
        "r": 15
      },
      {
        "id": 50,
        "key": "rock_m",
        "x": 300.08216135577953,
        "y": 489.6528203628116,
        "r": 22
      },
      {
        "id": 51,
        "key": "sapphire",
        "x": 184.9230687618821,
        "y": 438.3210378353626,
        "r": 21
      },
      {
        "id": 52,
        "key": "sapphire",
        "x": 219.58649352268492,
        "y": 416.02327992625374,
        "r": 21
      },
      {
        "id": 53,
        "key": "emerald",
        "x": 57,
        "y": 391.9746311896129,
        "r": 19
      },
      {
        "id": 54,
        "key": "emerald",
        "x": 171.75724372492022,
        "y": 401.1092322946047,
        "r": 19
      },
      {
        "id": 55,
        "key": "rock_l",
        "x": 301.10593451313935,
        "y": 392.7179644983317,
        "r": 29
      },
      {
        "id": 56,
        "key": "rock_s",
        "x": 335.0924014289603,
        "y": 364.87585594405584,
        "r": 16
      },
      {
        "id": 57,
        "key": "rock_m",
        "x": 351.8922427876163,
        "y": 398.91606311225894,
        "r": 22
      },
      {
        "id": 58,
        "key": "sapphire",
        "x": 135.99182826747713,
        "y": 383.7724461442837,
        "r": 21
      },
      {
        "id": 59,
        "key": "rock_s",
        "x": 366,
        "y": 364.2732678928188,
        "r": 16
      },
      {
        "id": 60,
        "key": "rock_s",
        "x": 105.17863610835224,
        "y": 415.5356601848275,
        "r": 16
      },
      {
        "id": 61,
        "key": "rock_m",
        "x": 250.995158158884,
        "y": 387.8047133980273,
        "r": 22
      },
      {
        "id": 62,
        "key": "amber",
        "x": 53,
        "y": 358.80517703838495,
        "r": 15
      },
      {
        "id": 63,
        "key": "sapphire",
        "x": 94.7291332038439,
        "y": 380.6059104506533,
        "r": 21
      },
      {
        "id": 64,
        "key": "ruby",
        "x": 273.05884894219,
        "y": 356.3876870022589,
        "r": 17
      },
      {
        "id": 65,
        "key": "emerald",
        "x": 212.13031254651935,
        "y": 377.52911792330946,
        "r": 19
      },
      {
        "id": 66,
        "key": "rock_l",
        "x": 172.90143223723314,
        "y": 351.03098719007835,
        "r": 29
      },
      {
        "id": 67,
        "key": "amber",
        "x": 249.04775747675274,
        "y": 313.54473114138415,
        "r": 15
      },
      {
        "id": 68,
        "key": "ruby",
        "x": 138.06375966792618,
        "y": 305.366307079453,
        "r": 29,
        "great": true
      },
      {
        "id": 69,
        "key": "emerald",
        "x": 306.7879442677198,
        "y": 345.50384870214384,
        "r": 19
      },
      {
        "id": 70,
        "key": "amber",
        "x": 349.93703569155826,
        "y": 322.9540644056495,
        "r": 29,
        "great": true
      },
      {
        "id": 71,
        "key": "sapphire",
        "x": 236.9337257686266,
        "y": 346.8644533333785,
        "r": 21
      },
      {
        "id": 72,
        "key": "sapphire",
        "x": 86.99586125144344,
        "y": 331.7233994553675,
        "r": 29,
        "great": true
      },
      {
        "id": 73,
        "key": "amber",
        "x": 307.85464269175395,
        "y": 312.0632835888264,
        "r": 15
      },
      {
        "id": 74,
        "key": "amber",
        "x": 208.46488396783096,
        "y": 325.96983869522666,
        "r": 15
      },
      {
        "id": 75,
        "key": "sapphire",
        "x": 59,
        "y": 260.75418807236724,
        "r": 21
      },
      {
        "id": 76,
        "key": "sapphire",
        "x": 361,
        "y": 274.76945749349295,
        "r": 21
      },
      {
        "id": 77,
        "key": "ruby",
        "x": 183.509313629027,
        "y": 306.81487024433244,
        "r": 17
      },
      {
        "id": 78,
        "key": "ruby",
        "x": 278.733463816848,
        "y": 323.44799782790636,
        "r": 17
      },
      {
        "id": 79,
        "key": "ruby",
        "x": 222.0005927396865,
        "y": 297.563383736803,
        "r": 17
      },
      {
        "id": 80,
        "key": "sapphire",
        "x": 319.7087979453976,
        "y": 278.7042857207719,
        "r": 21
      },
      {
        "id": 81,
        "key": "sapphire",
        "x": 94.12426406285374,
        "y": 282.7620065313797,
        "r": 21
      },
      {
        "id": 82,
        "key": "rock_l",
        "x": 150.94854878010943,
        "y": 249.3549722343726,
        "r": 29
      },
      {
        "id": 83,
        "key": "sapphire",
        "x": 195.35309913279025,
        "y": 271.2408939199626,
        "r": 21
      },
      {
        "id": 84,
        "key": "emerald",
        "x": 363,
        "y": 235.40419662506446,
        "r": 19
      },
      {
        "id": 85,
        "key": "rock_l",
        "x": 270.3103985511165,
        "y": 275.6059395495091,
        "r": 29
      }
    ],
    "specimens": [
      68,
      70,
      72
    ]
  }
];

function makeExcavationJar(site) {
  var jar = Object.create(Jar.prototype);
  jar.seed=0; jar.junk=0; jar.rare=0; jar.lode=0; jar.shale=0; jar.batches=0; jar.nextId=1;
  jar.bodies=site.bodies.map(function(s){
    jar.nextId=Math.max(jar.nextId,s.id+1);
    return Object.assign({},s,{px:s.x,py:s.y,vx:0,vy:0,rest:CFG.sleepSteps,asleep:true,geode:null,lode:!!s.lode,shale:false,great:!!s.great,hits:0});
  });
  jar.fastForward(2400);
  return jar;
}

  if (typeof window === 'undefined' || !window.document) return;

  var Motion = (function () {
    var api = { reduced: false };
    if (typeof window.matchMedia !== 'function') return api;
    var query = window.matchMedia('(prefers-reduced-motion: reduce)');
    function sync() { api.reduced = !!query.matches; }
    sync();
    if (query.addEventListener) query.addEventListener('change', sync);
    else if (query.addListener) query.addListener(sync);
    return api;
  })();

  var SPR_FILES = {
    gem_ruby: 'art/gem_ruby.png', gem_emerald: 'art/gem_emerald.png',
    gem_sapphire: 'art/gem_sapphire.png', gem_amber: 'art/gem_amber.png',
    gem_prism: 'art/gem_prism.png',
    rock_s: 'art/rock_s.png', rock_m: 'art/rock_m.png', rock_l: 'art/rock_l.png',
    gem_ruby_b: 'art/gem_ruby_b.png', gem_ruby_c: 'art/gem_ruby_c.png',
    gem_emerald_b: 'art/gem_emerald_b.png', gem_emerald_c: 'art/gem_emerald_c.png',
    gem_sapphire_b: 'art/gem_sapphire_b.png', gem_sapphire_c: 'art/gem_sapphire_c.png',
    gem_amber_b: 'art/gem_amber_b.png', gem_amber_c: 'art/gem_amber_c.png',
    rock_crusted: 'art/rock_crusted.png',
    rock_lode: 'art/rock_lode.png',
    rock_shale: 'art/rock_shale.png',
    dragon: 'art/dragon.png',
    ui_coin: 'art/ui_coin.png',
    gem_heartstone: 'art/gem_heartstone.png',
    prop_pickaxe: 'art/prop_pickaxe.png',
    mole_keeper: 'art/mole_keeper.png',
    backdrop_burrow: 'art/backdrop_burrow.jpg',
    bg_dig_wall: 'art/bg_dig_wall.jpg',
  };
  var SPR = {};

  var BUILD   = window.__BUILD__   || '';
  var ART_EXT = window.__ART_EXT__ || '';
  function assetURL(p) {
    if (ART_EXT) p = p.replace(/\.(png|jpg)$/, '.' + ART_EXT);
    return BUILD ? p + '?v=' + BUILD : p;
  }

  (function loadSprites() {
    var keys = Object.keys(SPR_FILES);
    var total = keys.length, done = 0;
    var lamp = document.getElementById('lamplight');
    var glow = lamp && lamp.querySelector('.lamp-glow');
    function tick() {
      done++;
      if (glow) glow.style.width = Math.round(done / total * 100) + '%';
      if (done < total || !lamp) return;
      lamp.classList.add('out');
      setTimeout(function () {
        if (lamp.parentNode) lamp.parentNode.removeChild(lamp);
      }, 450);
    }
    keys.forEach(function (k) {
      var im = new Image();
      im.onload = function () { SPR[k] = im; tick(); };
      im.onerror = function () {
        console.warn('[gemburrow] sprite missing: ' + SPR_FILES[k]);
        tick();
      };
      im.src = assetURL(SPR_FILES[k]);
    });
  })();
  var BODY_SPR = {
    ruby: 'gem_ruby', emerald: 'gem_emerald', sapphire: 'gem_sapphire',
    amber: 'gem_amber', prism: 'gem_prism',
    rock_s: 'rock_s', rock_m: 'rock_m', rock_l: 'rock_l',
  };
  var GEM_CUTS = {
    ruby: ['gem_ruby', 'gem_ruby_b', 'gem_ruby_c'],
    emerald: ['gem_emerald', 'gem_emerald_b', 'gem_emerald_c'],
    sapphire: ['gem_sapphire', 'gem_sapphire_b', 'gem_sapphire_c'],
    amber: ['gem_amber', 'gem_amber_b', 'gem_amber_c'],
  };

  function bodySpr(b) {
    if (b.geode) {
      if (SPR.rock_crusted) return 'rock_crusted';
      return BODY_SPR[b.key];
    }
    if (b.lode && SPR.rock_lode) return 'rock_lode';
    if (b.shale && SPR.rock_shale) return 'rock_shale';
    var cuts = GEM_CUTS[b.key];
    if (!cuts) return BODY_SPR[b.key];
    var pick = cuts[Math.floor(noise01(b.id, 0x0C07A1) * cuts.length) % cuts.length];
    return SPR[pick] ? pick : BODY_SPR[b.key];
  }

  var SPR_FIT = {
    gem_ruby: 2.624,
    gem_emerald: 2.441,
    gem_sapphire: 2.585,
    gem_amber: 2.805,
    gem_prism: 2.866,
    rock_s: 2.979,
    rock_m: 2.946,
    rock_l: 2.375,
    gem_heartstone: 2.419,
    gem_ruby_b: 2.488,
    gem_ruby_c: 2.523,
    gem_emerald_b: 2.441,
    gem_emerald_c: 2.244,
    gem_sapphire_b: 2.476,
    gem_sapphire_c: 2.354,
    gem_amber_b: 2.323,
    gem_amber_c: 2.293,
    rock_crusted: 2.313,
    rock_lode: 2.283,
    rock_shale: 2.408,
  };
  function sprFit(key) { return SPR_FIT[key] || 2.12; }

  function skinById(id) {
    for (var i = 0; i < WALL_SKINS.length; i++) if (WALL_SKINS[i].id === id) return WALL_SKINS[i];
    return WALL_SKINS[0];
  }
  function equippedWallId() {
    var id = (Meta.data.equipped && Meta.data.equipped.wall) || 'clay';
    if (id !== 'clay' && !(Meta.data.owned && Meta.data.owned[id])) return 'clay';
    return id;
  }
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
  function dragonUnlocked(sk) {
    if (sk.rank < 0) return true;
    var r = hoardRank(Meta.data.hoardTotal);
    return !!r && r.idx >= sk.rank;
  }
  function equippedDragonId() {
    var id = (Meta.data.equipped && Meta.data.equipped.dragon) || 'lilac';
    var sk = dragonSkinById(id);
    return dragonUnlocked(sk) ? sk.id : 'lilac';
  }
  var _dragonCache = {};
  function dragonImage() {
    var base = SPR.dragon;
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
      x.globalCompositeOperation = 'destination-in';
      x.globalAlpha = 1;
      x.drawImage(base, 0, 0);
      x.globalCompositeOperation = 'source-over';
      _dragonCache[id] = c;
      return c;
    } catch (e) { return base; }
  }
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
    return pickUnlocked(sk) ? sk.id : 'iron';
  }
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
  var BODY_INK = 1.03;
  function inkR(b) { return b.r * BODY_INK; }

  var Meta = (function () {
    function mergeExcavations(a, b) {
      var sites = {};
      function record(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
      function stableId(id) {
        return typeof id === 'string' && /^[a-z][a-z0-9_-]{0,63}$/.test(id) &&
          id !== 'constructor' && id !== 'prototype';
      }
      [a, b].forEach(function (state) {
        if (!record(state) || state.version !== 1 || !record(state.sites)) return;
        Object.keys(state.sites).sort().forEach(function (id) {
          var next = state.sites[id];
          if (!stableId(id) || !record(next)) return;
          var old = sites[id] || { cleared: false, bestSwings: 0, specimens: [] };
          var cleared = next.cleared === true;
          var used = cleared && typeof next.bestSwings === 'number' &&
            isFinite(next.bestSwings) && next.bestSwings > 0 &&
            Math.floor(next.bestSwings) === next.bestSwings ? next.bestSwings : 0;
          var ids = old.specimens.slice();
          if (cleared && Array.isArray(next.specimens)) {
            next.specimens.forEach(function (specimen) {
              if (stableId(specimen) && ids.indexOf(specimen) < 0) ids.push(specimen);
            });
          }
          sites[id] = {
            cleared: old.cleared || cleared,
            bestSwings: used && old.bestSwings ? Math.min(used, old.bestSwings) : (used || old.bestSwings),
            specimens: ids.sort()
          };
        });
      });
      var ordered = {};
      Object.keys(sites).sort().forEach(function (id) { ordered[id] = sites[id]; });
      return { version: 1, sites: ordered };
    }
    var K = 'gb_meta_v1';
    var data = { hoardTotal: 0, excavations: { version: 1, sites: {} }, tutorialDone: false, bestDaily: {}, bestFree: 0,
                 clientId: '', playerName: '', pendingScore: null,
                 coins: 0, owned: {}, equipped: {},
                 stats: { shifts: 0, gems: 0, crusts: 0, hearts: 0,
                          bestCombo: 0, days: 0, streak: 0, bestStreak: 0,
                          lastDay: 0, earned: 0 },
                 contracts: {},
                 taught: {},
                 hints: 1,
                 musicVolume: 0.7, sfxVolume: 1, haptics: 1,
                 marks: 0,
                 full: 0, iapSeen: {}, iapAccess: {} };
    function mergeAccess(a, b) {
      var merged = {};
      [a, b].forEach(function (states) {
        if (!states || typeof states !== 'object') return;
        Object.keys(states).forEach(function (key) {
          var next = states[key], old = merged[key];
          if (key.indexOf('ios:') !== 0 || !next || typeof next.revoked !== 'boolean' ||
              typeof next.signedDate !== 'number' || !isFinite(next.signedDate) || next.signedDate < 0) return;
          if (!old || next.signedDate > old.signedDate ||
              (next.signedDate === old.signedDate && next.revoked)) {
            merged[key] = { signedDate: next.signedDate, revoked: next.revoked };
          }
        });
      });
      return merged;
    }
    function accessFull(states, legacyFull) {
      var keys = Object.keys(states);
      if (!keys.length) return legacyFull ? 1 : 0;
      return keys.some(function (key) { return !states[key].revoked; }) ? 1 : 0;
    }
    var hadLocal = false;
    var hapticsChoice = null;
    var provisional = false;
    try { provisional = localStorage.getItem(K + '.prov') === '1'; } catch (e) {}
    try {
      var s = localStorage.getItem(K);
      if (s) { data = Object.assign(data, JSON.parse(s)); hadLocal = true; }
    } catch (e) {}
    data.excavations = mergeExcavations(data.excavations);
    data.iapAccess = mergeAccess(data.iapAccess);
    data.full = accessFull(data.iapAccess, data.full);
    var Prefs = (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Preferences) || null;
    var nativeOK = false;
    var nativeWrite = Promise.resolve(true);
    function save(localOnly) {
      var s2 = JSON.stringify(data), localOK = false;
      try { localStorage.setItem(K, s2); localOK = true; } catch (e) {}
      try {
        if (Prefs && !nativeOK) localStorage.setItem(K + '.prov', '1');
        else localStorage.removeItem(K + '.prov');
      } catch (e) {}
      if (Prefs && !localOnly && nativeOK) {
        nativeWrite = nativeWrite.then(function () {
          return Prefs.set({ key: K, value: s2 });
        }).then(function () { return true; }, function () { return false; });
        return nativeWrite;
      }
      return Promise.resolve(!Prefs && localOK);
    }
    function flush() {
      return new Promise(function (resolve) {
        var complete = false;
        var timer = setTimeout(function () { finish(false); }, 3000);
        function finish(ok) {
          if (complete) return;
          complete = true; clearTimeout(timer); resolve(ok);
        }
        save().then(finish);
      });
    }
    function mergeBests(a, b) {
      var out = {};
      [a, b].forEach(function (map) {
        Object.keys(map || {}).forEach(function (key) {
          var value = map[key];
          if (/^\d+$/.test(key) && typeof value === 'number' && isFinite(value) && value >= 0) {
            out[key] = Math.max(out[key] || 0, value);
          }
        });
      });
      return out;
    }

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
    var settled = false, waiting = [], audioRestoreListeners = [];
    function settle(localOnly) {
      if (settled) return;
      settled = true;
      mint();
      save(localOnly);
      for (var i = 0; i < waiting.length; i++) waiting[i]();
      waiting.length = 0;
    }
    if (Prefs && (!hadLocal || provisional)) {
      var t = setTimeout(function () { settle(true); }, 250);
      Prefs.get({ key: K }).then(function (r) {
        if (r && r.value) {
          try {
            var nat = JSON.parse(r.value);
            var bestFree = Math.max(Number(data.bestFree) || 0, Number(nat.bestFree) || 0);
            var excavationRecords = mergeExcavations(data.excavations, nat.excavations);
            var bestDaily = mergeBests(data.bestDaily, nat.bestDaily);
            var careerStars = mergeBests(data.careerStars, nat.careerStars);
            var full = !!data.full || !!nat.full;
            var access = mergeAccess(nat.iapAccess, data.iapAccess);
            var receipts = Object.assign({}, nat.iapSeen || {}, data.iapSeen || {});
            for (var receipt in (nat.iapSeen || {})) {
              if (nat.iapSeen[receipt] === 'fulfilled') receipts[receipt] = 'fulfilled';
            }
            if (!provisional || progress(nat) >= progress(data)) Object.assign(data, nat);
            if (hapticsChoice !== null) data.haptics = hapticsChoice;
            data.excavations = excavationRecords;
            data.bestFree = bestFree;
            data.bestDaily = bestDaily;
            data.careerStars = careerStars;
            data.iapAccess = access;
            data.full = accessFull(access, full);
            data.iapSeen = receipts;
            nativeOK = true;
          } catch (e) {
            try { Prefs.set({ key: K + '.bad', value: r.value }).catch(function () {}); } catch (e2) {}
          }
        } else {
          nativeOK = true;
        }
      }).catch(function () {
      }).then(function () {
        clearTimeout(t);
        if (settled) { mint(); save(); }
        else settle();
        audioRestoreListeners.forEach(function (cb) { cb(); });
      });
    } else {
      nativeOK = true;
      settle();
    }
    return { data: data, save: save, flush: flush, mergeAccess: mergeAccess, accessFull: accessFull,
             setHaptics: function (enabled) { hapticsChoice = enabled ? 1 : 0; data.haptics = hapticsChoice; save(); },
             ready: function (cb) { if (settled) cb(); else waiting.push(cb); },
             onAudioRestore: function (cb) { audioRestoreListeners.push(cb); if (settled) cb(); } };
  })();

  var FULL_PRODUCT = 'gemburrow.full.unlock';
  var FREE_CAREER_LEVELS = 10;

  var Ent = (function () {
    function receiptKey(platform, txId) {
      var h = 2166136261 >>> 0, str = platform + ':' + txId;
      for (var i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
      }
      return h.toString(16);
    }
    function owned() { return !!Meta.data.full; }
    function fulfill(platform, txId, productId, state) {
      if (productId !== FULL_PRODUCT) return { granted: false, reason: 'unknown product' };
      var key = receiptKey(platform, txId);
      var versioned = state && typeof state.originalTransactionId === 'string' && state.originalTransactionId &&
                      typeof state.signedDate === 'number' && isFinite(state.signedDate) && state.signedDate >= 0 &&
                      typeof state.revoked === 'boolean' && platform === 'ios';
      var access = Meta.mergeAccess(Meta.data.iapAccess);
      if (!versioned && ((state && ('revoked' in state || 'signedDate' in state || 'originalTransactionId' in state)) ||
                         Object.keys(access).length)) return { granted: false, reason: 'missing verified state' };
      var was = owned();
      if (versioned) {
        var incoming = {};
        incoming[platform + ':' + state.originalTransactionId] = { signedDate: state.signedDate, revoked: state.revoked };
        access = Meta.mergeAccess(access, incoming);
        Meta.data.iapAccess = access;
        Meta.data.full = Meta.accessFull(access, Meta.data.full);
        if (state.revoked || access[platform + ':' + state.originalTransactionId].revoked) {
          Meta.save();
          return { granted: !was && owned(), revoked: was && !owned(), key: key };
        }
      }
      if (!Meta.data.iapSeen) Meta.data.iapSeen = {};
      if (Meta.data.iapSeen[key] === 'fulfilled' && owned()) {
        Meta.save();
        return { granted: !was && owned(), reason: 'already fulfilled', key: key };
      }
      Meta.data.iapSeen[key] = 'fulfilling';
      Meta.save();
      if (!versioned) Meta.data.full = 1;
      Meta.data.iapSeen[key] = 'fulfilled';
      Meta.save();
      return { granted: !was, key: key };
    }
    return { owned: owned, fulfill: fulfill, receiptKey: receiptKey, PRODUCT: FULL_PRODUCT };
  })();

  function careerCap() {
    if (!Store.available()) return CAREER_MAX;
    return Ent.owned() ? CAREER_MAX : FREE_CAREER_LEVELS;
  }

  var PRIVACY_URL = 'https://hypersage.ai/gemburrow/privacy.html';
  function openOutward(url) {
    var C = window.Capacitor;
    if (C && typeof C.isNativePlatform === 'function' && C.isNativePlatform()) {
      window.location.href = url;
      return;
    }
    var w = null;
    try { w = window.open(url, '_blank'); } catch (e) { w = null; }
    if (w) { try { w.opener = null; } catch (e2) {} return; }
    window.location.href = url;
  }

  var Store = (function () {
    function plugin() {
      var C = window.Capacitor;
      return (C && C.Plugins && C.Plugins.GemburrowStore) || null;
    }
    var api = {
      available: function () { return !!plugin(); },
      price: null,
      busy: false,
      note: null,
    };
    var finalizing = {}, observedPlugin = null, observer = null;
    function finalizeAfterSave(p, row, key) {
      key += ':' + (row.stateToken || 'legacy');
      if (finalizing[key]) return finalizing[key];
      var work = Meta.flush().then(function (saved) {
        if (!saved || !p || !p.finalize) return false;
        return Promise.resolve(p.finalize({ transactionId: row.transactionId, stateToken: row.stateToken })).then(function () { return true; });
      }).catch(function () { return false; }).then(function (finished) {
        delete finalizing[key];
        return finished;
      });
      finalizing[key] = work;
      return work;
    }
    function handle(rows, done) {
      var was = Ent.owned(), work = [];
      rows = rows || [];
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (!r || r.productId !== FULL_PRODUCT || !r.transactionId) continue;
        var res = Ent.fulfill(r.platform || 'ios', r.transactionId, r.productId, r);
        if (!res.key) continue;
        work.push(finalizeAfterSave(plugin(), r, res.key));
      }
      return Promise.all(work).then(function (finished) {
        var saved = finished.every(function (ok) { return ok; });
        if (done) done(!was && Ent.owned(), saved, was && !Ent.owned());
        return saved;
      });
    }
    api.observe = function () {
      var p = plugin();
      if (!p || !p.addListener || observedPlugin === p) return;
      if (observer && observer.remove) { try { Promise.resolve(observer.remove()).catch(function () {}); } catch (e) {} }
      observer = null; observedPlugin = p;
      try {
        Promise.resolve(p.addListener('transactionsUpdated', function (event) {
          if (plugin() !== p) return;
          Meta.ready(function () {
            handle(event && event.transactions, function (granted, saved, revoked) {
              if (granted) api.note = saved ? 'Purchase approved. Full Burrow unlocked.'
                                          : 'Unlocked. Saving will retry when you return.';
              else if (revoked) api.note = saved ? 'Purchase refunded or revoked. Your progress is saved.'
                                               : 'Purchase status changed. Saving will retry when you return.';
            });
          });
        })).then(function (listener) { observer = listener; }, function () {
          if (observedPlugin === p) observedPlugin = null;
        });
      } catch (e) { observedPlugin = null; }
    };
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
    api.recover = function () {
      api.observe();
      var p = plugin(); if (!p || !p.recover) return;
      try { p.recover().then(function (r) { handle(r && r.transactions); }).catch(function () {}); } catch (e) {}
    };
    api.buy = function (done) {
      var p = plugin();
      if (!p || !p.purchase) { api.note = 'The store is not available here.'; if (done) done(false); return; }
      api.busy = true; api.note = null;
      try {
        p.purchase({ id: FULL_PRODUCT }).then(function (r) {
          if (r && r.cancelled) { api.busy = false; if (done) done(false); return; }
          if (r && r.pending) {
            api.busy = false;
            api.note = 'Waiting for purchase approval.';
            if (done) done(false);
            return;
          }
          return handle(r && r.transactions, function (g, saved) {
            api.busy = false;
            api.note = !saved ? (Ent.owned() ? 'Unlocked. Saving will retry when you return.'
                                           : 'Purchase status changed. Saving will retry when you return.')
                     : Ent.owned() ? null : 'Nothing to unlock.';
            if (done) done(g || Ent.owned());
          });
        }).catch(function (e) {
          api.busy = false; api.note = 'The purchase did not go through.';
          if (done) done(false);
        });
      } catch (e) { api.busy = false; api.note = 'The purchase did not go through.'; if (done) done(false); }
    };
    api.restore = function (done) {
      var p = plugin();
      if (!p || !p.restore) { api.note = 'The store is not available here.'; if (done) done(false); return; }
      api.busy = true; api.note = null;
      try {
        p.restore().then(function (r) {
          return handle(r && r.transactions, function (granted, saved, revoked) {
            api.busy = false;
            api.note = !saved ? (Ent.owned() ? 'Unlocked. Saving will retry when you return.'
                                           : 'Purchase status changed. Saving will retry when you return.')
                     : revoked ? 'Purchase refunded or revoked. Your progress is saved.'
                     : r && r.syncSucceeded === false
                       ? (Ent.owned() ? 'Already unlocked. Store sync unavailable.' : 'Could not sync purchases. Please try again.')
                     : Ent.owned() ? 'Purchase restored.' : 'No purchase found on this Apple ID.';
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
    function submit(payload, done) {
      if (!window.fetch) { if (done) done(false); return; }
      fetch(RPC, {
        method: 'POST',
        headers: H,
        body: JSON.stringify({
          p_day: payload.day, p_seed: payload.seed, p_player: payload.player,
          p_coins: payload.coins, p_pops: payload.pops, p_client_id: payload.client_id,
        }),
      }).then(function (r) {
        if (!r.ok) return false;
        return r.json().then(function (j) { return !!(j && j.ok); });
      }).then(function (ok) {
        if (done) done(ok);
      }).catch(function () { if (done) done(false); });
    }
    function personal(day, board, done) {
      if (!window.fetch || !Meta.data.clientId) { done(null); return; }
      var clientId = Meta.data.clientId;
      fetch('https://lrnupqottbfjfzsgtciq.supabase.co/rest/v1/rpc/gemburrow_personal_rank', {
        method: 'POST', headers: H,
        body: JSON.stringify({ p_day: day, p_client_id: clientId, p_board: board }),
      }).then(function (r) {
        if (!r.ok) return null;
        return r.json();
      }).then(function (r) {
        if (Meta.data.clientId !== clientId || !r || r.ok !== true || r.day !== day || r.board !== board ||
            typeof r.hasScore !== 'boolean' || !Number.isInteger(r.participantCount) || r.participantCount < 0 ||
            (r.hasScore && (!Number.isInteger(r.rank) || r.rank < 1 || r.rank > r.participantCount ||
                           typeof r.score !== 'number' || !isFinite(r.score) || r.score < 0))) { done(null); return; }
        done(r);
      }).catch(function () { done(null); });
    }
    function top(day, limit, done) {
      if (!window.fetch) return done(null);
      fetch(URL + '?day=eq.' + day + '&select=player,coins&order=coins.desc,player.asc&limit=' + limit, { headers: H })
        .then(function (r) { return r.json(); })
        .then(function (rows) { done(Array.isArray(rows) ? rows : null); })
        .catch(function () { done(null); });
    }
    function league(limit, done) {
      if (!window.fetch) return done('error', null);
      fetch(LEAGUE + '?select=player,total,days&order=total.desc,player.asc&limit=' + limit,
            { headers: H })
        .then(function (r) {
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
    var retrying = false, retryLast = null, retryAt = -Infinity;
    function retryPending() {
      if (retrying) return;
      var payload = Meta.data.pendingScore;
      if (!payload) return;
      if (payload.day !== dayNumber()) { Meta.data.pendingScore = null; Meta.save(); return; }
      if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
      if (payload === retryLast && nowMs() - retryAt < 15000) return;
      retrying = true; retryLast = payload; retryAt = nowMs();
      var complete = false;
      var timeout = setTimeout(function () { finish(false); }, 12000);
      function finish(ok) {
        if (complete) return;
        complete = true; clearTimeout(timeout); retrying = false;
        if (ok && Meta.data.pendingScore === payload) { Meta.data.pendingScore = null; Meta.save(); }
        if (ok && Meta.data.pendingScore && Meta.data.pendingScore !== payload) retryPending();
      }
      submit(payload, finish);
    }
    return { submit: submit, top: top, league: league, personal: personal, retryPending: retryPending };
  })();

  var Hap = (function () {
    var last = -Infinity, webActive = false;
    function nativeShell() {
      var C = window.Capacitor;
      if (!C) return false;
      try {
        if (typeof C.isNativePlatform === 'function') return C.isNativePlatform();
        return typeof C.getPlatform === 'function' && /^(ios|android)$/.test(C.getPlatform());
      } catch (e) { return false; }
    }
    function nativePlugin() {
      var C = window.Capacitor;
      return C && C.Plugins && C.Plugins.Haptics;
    }
    function webAvailable() {
      return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
    }
    function available() {
      var P = nativePlugin();
      return nativeShell() ? !!(P && typeof P.impact === 'function') : webAvailable();
    }
    function enabled() { return Meta.data.haptics !== 0 && Meta.data.haptics !== false; }
    function stop() {
      if (!webActive) return;
      webActive = false;
      try { if (webAvailable()) navigator.vibrate(0); } catch (e) {}
    }
    function fire(style) {
      if (!enabled() || document.hidden) return;
      var native = nativeShell(), P = nativePlugin();
      if (native ? !(P && typeof P.impact === 'function') : !webAvailable()) return;
      if (!native && navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
      var now = performance.now();
      if (now - last < 30) return;
      last = now;
      if (native) {
        try { Promise.resolve(P.impact({ style: style })).catch(function () {}); } catch (e) {}
        return;
      }
      try {
        webActive = navigator.vibrate(style === 'LIGHT' ? 12 : style === 'MEDIUM' ? 20 : 30) !== false;
      } catch (e) { webActive = false; }
    }
    document.addEventListener('visibilitychange', function () { if (document.hidden) stop(); });
    return {
      available: available, enabled: enabled, stop: stop,
      light: function () { fire('LIGHT'); },
      medium: function () { fire('MEDIUM'); },
      heavy: function () { fire('HEAVY'); },
    };
  })();

  var ReviewAsk = (function () {
    var BELL_REST_MS = 1600;
    var bellTimer = 0;
    function sheetPlugin() {
      var C = window.Capacitor;
      if (!C || typeof C.getPlatform !== 'function' || C.getPlatform() !== 'ios') return null;
      return (C.Plugins && C.Plugins.WonShiftReviewAsk) || null;
    }
    function pluginCall(plugin, verb) {
      try { Promise.resolve(plugin[verb]()).catch(function () {}); } catch (e) {}
    }
    function restingOnWin(g) {
      if (g.state !== 'results' || g.showSettings) return false;
      if (!(g.ordersDone >= g.goalOrders)) return false;
      if (typeof document !== 'undefined' && document.hidden) return false;
      if (g.career && !g.careerFinale() && g.career.level + 1 > careerCap()) return false;
      return true;
    }
    return {
      shiftWon: function (g) {
        var plugin = sheetPlugin();
        if (!plugin) return;
        pluginCall(plugin, 'noteWonShift');
        clearTimeout(bellTimer);
        bellTimer = setTimeout(function () {
          bellTimer = 0;
          if (restingOnWin(g)) pluginCall(plugin, 'askAfterWin');
        }, BELL_REST_MS);
      },
    };
  })();

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
    { n: 3, label: 'Flint wakes up!' },
    { n: 7, label: 'The hoard sparkles!' },
    { n: 12, label: 'Bigger bag on free digs!' },
    { n: 20, label: 'Golden Flint!' },
  ];

  var CONTRACTS = [
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
  var HOARD_STEP = 15;
  function hoardRank(total) {
    if (total < 20) return null;
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

  var Snd = (function () {
    var ac = null, master = null, musicBus = null, sfxBus = null;
    var live = [];
    var MAXV = 8;
    var MAXQ = 64;
    var lastAt = {};
    function volume(value, fallback) {
      return typeof value === 'number' && isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback;
    }
    var api = {
      musicVolume: volume(Meta.data.musicVolume, 0.7),
      sfxVolume: volume(Meta.data.sfxVolume, 1),
      musicMuted: Meta.data.musicMuted !== undefined
                  ? !!Meta.data.musicMuted : localStorage.getItem('gb_music_mute') === '1',
      sfxMuted: Meta.data.sfxMuted !== undefined
                ? !!Meta.data.sfxMuted : localStorage.getItem('gb_sfx_mute') === '1',
    };

    function ensure() {
      if (document.hidden) return null;
      if (!ac) {
        try {
          ac = new (window.AudioContext || window.webkitAudioContext)();
          master = ac.createGain(); master.connect(ac.destination);
          musicBus = ac.createGain(); musicBus.connect(master);
          sfxBus = ac.createGain(); sfxBus.connect(master);
          musicBus.gain.value = api.musicMuted ? 0 : api.musicVolume * 0.7;
          sfxBus.gain.value = api.sfxMuted ? 0 : api.sfxVolume;
        } catch (e) { ac = null; }
      }
      if (ac && ac.state !== 'running') {
        try {
          var resumed = ac.resume();
          if (resumed && resumed.then) resumed.then(function () {
            if (document.hidden) { pauseMusic(); ac.suspend().catch(function () {}); }
            else reconcileMusic();
          }).catch(function () {});
        } catch (e) {}
      }
      return ac;
    }

    function n2f(m) { return 440 * Math.pow(2, (m - 69) / 12); }

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
        else v = x < 0.5 ? 4 * x - 1 : 3 - 4 * x;
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
      var at = when || ac.currentTime;
      var now = ac.currentTime, sounding = 0, victim = -1;
      for (var vi = 0; vi < live.length; vi++) {
        if (live[vi].at <= now) { sounding++; if (victim < 0) victim = vi; }
      }
      if (sounding >= MAXV && victim >= 0) {
        try { live[victim].src.stop(); } catch (e) {}
        live.splice(victim, 1);
      } else if (live.length >= MAXQ) {
        return;
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

    var FALLBACK_CHORD = [43, 47, 50];
    var Music = {
      map: null, buffers: {}, cacheOrder: [], loading: false, retryAt: 0,
      voices: [], active: null, sting: null, desired: 'music_shop',
      lastScene: 'shop', digIndex: 0, offsets: {}, failed: 0,
    };
    function musicAllowed() {
      return ac && !document.hidden && !api.musicMuted && api.musicVolume > 0;
    }
    function hold(gain, at) {
      if (gain.cancelAndHoldAtTime) gain.cancelAndHoldAtTime(at);
      else { var v = gain.value; gain.cancelScheduledValues(at); gain.setValueAtTime(v, at); }
    }
    function fadeBed(gain, target, at) {
      hold(gain, at);
      var start = gain.value, curve = new Float32Array(48);
      for (var i = 0; i < curve.length; i++) {
        var phase = i / (curve.length - 1) * Math.PI / 2;
        curve[i] = target ? start + (target - start) * Math.sin(phase) : start * Math.cos(phase);
      }
      curve[curve.length - 1] = target;
      gain.setValueCurveAtTime(curve, at, 1.4);
    }
    function retire(rec) {
      if (!rec) return;
      if (rec.timer) clearTimeout(rec.timer);
      rec.src.onended = null;
      try { rec.src.stop(); } catch (e) {}
      try { rec.src.disconnect(); rec.gain.disconnect(); } catch (e) {}
      var i = Music.voices.indexOf(rec);
      if (i >= 0) Music.voices.splice(i, 1);
      if (Music.active === rec) Music.active = null;
    }
    function stopSting() {
      if (!Music.sting) return;
      var sting = Music.sting; Music.sting = null;
      sting.onended = null;
      try { sting.stop(); sting.disconnect(); } catch (e) {}
      if (Music.active && ac) {
        hold(Music.active.gain.gain, ac.currentTime);
        Music.active.gain.gain.linearRampToValueAtTime(1, ac.currentTime + 0.25);
      }
    }
    function pauseMusic() {
      if (Music.active && ac) {
        var r = Music.active;
        Music.offsets[r.name] = (r.offset + ac.currentTime - r.startedAt) % r.src.buffer.duration;
      }
      stopSting();
      Music.voices.slice().forEach(retire);
    }
    function trimCache() {
      var keep = [Music.desired];
      Music.voices.forEach(function (v) { if (keep.indexOf(v.name) < 0) keep.push(v.name); });
      var beds = Music.cacheOrder.filter(function (n) { return n !== 'music_perfect'; });
      beds.slice().forEach(function (n) {
        if (beds.length > 2 && keep.indexOf(n) < 0) {
          delete Music.buffers[n];
          Music.cacheOrder.splice(Music.cacheOrder.indexOf(n), 1);
          beds.splice(beds.indexOf(n), 1);
        }
      });
    }
    function trackInfo(name) { return Music.map && Music.map.tracks[name]; }
    function musicRequest(url, kind) {
      return new Promise(function (resolve, reject) {
        var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var timer = setTimeout(function () {
          if (controller) controller.abort();
          reject(new Error('Music load timeout'));
        }, 12000);
        fetch(assetURL(url), controller ? { signal: controller.signal } : undefined).then(function (r) {
          if (!r.ok) throw new Error('Music HTTP ' + r.status);
          return r[kind]();
        }).then(function (data) { clearTimeout(timer); resolve(data); },
          function (error) { clearTimeout(timer); reject(error); });
      });
    }
    function musicDecode(ab) {
      return new Promise(function (resolve, reject) {
        var timer = setTimeout(function () { reject(new Error('Music decode timeout')); }, 12000);
        ac.decodeAudioData(ab, function (buf) { clearTimeout(timer); resolve(buf); },
          function (error) { clearTimeout(timer); reject(error); });
      });
    }
    function musicLoad() {
      if (!musicAllowed() || Music.loading || !window.fetch || Date.now() < Music.retryAt) return;
      var name = !Music.buffers[Music.desired] ? Music.desired
               : !Music.buffers.music_perfect ? 'music_perfect' : null;
      if (Music.map && !name) return;
      Music.loading = true;
      var request = Music.map ? Promise.resolve(Music.map)
        : musicRequest('audio/music_map.json', 'json');
      request.then(function (map) {
        if (map.schemaVersion !== 2 || !map.tracks || !(map.sampleRate > 0)) throw new Error('Music map format');
        Music.map = map;
        if (!musicAllowed()) return;
        name = !Music.buffers[Music.desired] ? Music.desired : 'music_perfect';
        if (Music.buffers[name]) return;
        var info = trackInfo(name);
        if (!info || info.file !== name + '.m4a' || !(info.samples > 0)) throw new Error('Music track metadata');
        if (name !== 'music_perfect') {
          Music.voices.slice().forEach(function (v) { if (v !== Music.active) retire(v); });
          Music.cacheOrder.slice().forEach(function (n) {
            if (n !== 'music_perfect' && n !== name && (!Music.active || n !== Music.active.name)) {
              delete Music.buffers[n]; Music.cacheOrder.splice(Music.cacheOrder.indexOf(n), 1);
            }
          });
        }
        return musicRequest('audio/' + info.file, 'arrayBuffer').then(musicDecode).then(function (buf) {
          var want = Math.round(info.samples * ac.sampleRate / map.sampleRate);
          if (buf.length + 2 < want) throw new Error('Music track truncated');
          var out = buf;
          if (buf.length !== want) {
            out = ac.createBuffer(buf.numberOfChannels, want, ac.sampleRate);
            for (var c = 0; c < buf.numberOfChannels; c++) out.getChannelData(c).set(buf.getChannelData(c).subarray(0, want));
          }
          Music.buffers[name] = out;
          Music.cacheOrder.push(name);
          trimCache();
        });
      }).then(function () {
        Music.loading = false; Music.failed = 0; Music.retryAt = 0;
        reconcileMusic();
      }).catch(function () {
        Music.loading = false; Music.failed++;
        Music.retryAt = Date.now() + Math.min(8000, 1000 * Music.failed);
      });
    }
    function reconcileMusic() {
      if (!musicAllowed()) return;
      if (ac.state !== 'running') return;
      var name = Music.desired, buf = Music.buffers[name];
      if (!buf) { musicLoad(); return; }
      if (Music.active && Music.active.name === name) { musicLoad(); return; }
      stopSting();
      Music.voices.slice().forEach(function (r) { if (r !== Music.active) retire(r); });
      var t = ac.currentTime, old = Music.active;
      if (old) {
        Music.offsets[old.name] = (old.offset + t - old.startedAt) % old.src.buffer.duration;
        fadeBed(old.gain.gain, 0, t);
        old.timer = setTimeout(function () { retire(old); trimCache(); }, 1500);
      }
      var src = ac.createBufferSource(), gn = ac.createGain();
      src.buffer = buf; src.loop = true; src.loopEnd = buf.duration;
      gn.gain.setValueAtTime(0, t); fadeBed(gn.gain, 1, t);
      src.connect(gn); gn.connect(musicBus);
      var rec = { src: src, gain: gn, name: name, startedAt: t, offset: (Music.offsets[name] || 0) % buf.duration };
      Music.active = rec; Music.voices.push(rec);
      src.onended = function () { retire(rec); };
      src.start(t, rec.offset);
      trimCache(); musicLoad();
    }
    api.scene = function (scene, newShift) {
      scene = scene === 'dig' ? 'dig' : 'shop';
      if (newShift || scene !== Music.lastScene) stopSting();
      if (scene === 'dig' && (newShift || Music.lastScene !== 'dig')) {
        Music.desired = Music.digIndex++ % 2 ? 'music_dig_alt' : 'music_dig';
        Music.offsets[Music.desired] = 0;
      } else if (scene === 'shop') Music.desired = 'music_shop';
      Music.lastScene = scene;
      reconcileMusic();
    };
    api.beginShift = function () { api.scene('dig', true); };
    api.perfect = function () {
      if (!musicAllowed() || ac.state !== 'running' || !Music.active || Music.lastScene !== 'dig') return;
      var buf = Music.buffers.music_perfect;
      if (!buf || Music.sting) return;
      var t = ac.currentTime, gv = Music.active.gain.gain;
      hold(gv, t); gv.linearRampToValueAtTime(0.08, t + 0.3);
      gv.setValueAtTime(0.08, t + Math.max(0.3, buf.duration - 1.2));
      gv.linearRampToValueAtTime(1, t + buf.duration);
      var src = ac.createBufferSource(); src.buffer = buf; src.connect(musicBus);
      Music.sting = src;
      src.onended = function () { if (Music.sting === src) Music.sting = null; src.disconnect(); };
      src.start(t);
    };

    api.clack = function (force, r) {
      if (!ensure() || api.sfxMuted) return;
      var f = Math.max(0, Math.min(1, (force - 45) / 220));
      var size = Math.max(0, Math.min(1, (r - 14) / 16));
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
      reconcileMusic(); musicLoad();
    };
    api.chord = function () {
      return musicAllowed() && Music.active ? null : FALLBACK_CHORD;
    };
    function updateMusicGain() {
      if (musicBus && ac) {
        hold(musicBus.gain, ac.currentTime);
        musicBus.gain.linearRampToValueAtTime(api.musicMuted ? 0 : api.musicVolume * 0.7, ac.currentTime + 0.06);
      }
      if (api.musicMuted || api.musicVolume === 0) pauseMusic();
      else if (ensure()) { reconcileMusic(); musicLoad(); }
    }
    api.setMusicMuted = function (m) {
      api.musicMuted = !!m; Meta.data.musicMuted = !!m; Meta.save(); updateMusicGain();
    };
    api.setMusicVolume = function (v) {
      api.musicVolume = volume(v, api.musicVolume);
      Meta.data.musicVolume = api.musicVolume; Meta.save(); updateMusicGain();
    };
    api.setSfxMuted = function (m) {
      api.sfxMuted = !!m; Meta.data.sfxMuted = !!m; Meta.save();
      if (!m) ensure();
      if (sfxBus) sfxBus.gain.value = m ? 0 : api.sfxVolume;
      if (m) live.slice().forEach(function (r) { try { r.src.stop(); } catch (e) {} });
    };
    api.setSfxVolume = function (v) {
      api.sfxVolume = volume(v, api.sfxVolume);
      Meta.data.sfxVolume = api.sfxVolume; Meta.save();
      if (sfxBus) sfxBus.gain.value = api.sfxMuted ? 0 : api.sfxVolume;
    };
    function glassPulse(step, at, strength) {
      voice(gen({ f: 800 + step * 130, shape: 'sine', noise: 0.94,
        a: 0.002, s: 0.008, r: 0.035 + step * 0.004, vol: strength || 0.10 }), sfxBus, at);
    }

    api.pop = function () {
      sfx('pop', { f: 420, shape: 'tri', a: 0.004, s: 0.03, r: 0.11, slide: -1.2, vol: 0.30, jit: 0.03, noise: 0.06 }, 30);
    };
    api.thunk = function () {
      sfx('thunk', { f: 95, shape: 'sq', a: 0.004, s: 0.02, r: 0.09, slide: -0.8, vol: 0.22, noise: 0.18 }, 60);
    };
    api.scrap = function () {
      sfx('scrap', { f: 260, shape: 'tri', a: 0.004, s: 0.01, r: 0.07, vol: 0.10, jit: 0.04 }, 40);
    };
    api.fill = function (combo) {
      if (!ensure() || api.sfxMuted) return;
      var chord = api.chord();
      var step = Math.max(0, (combo || 1) - 1);
      if (!chord) { glassPulse(Math.min(step, 6), ac.currentTime, 0.12); return; }
      var oct = Math.min(2, Math.floor(step / 3));
      var m = chord[step % 3] + 24 + oct * 12;
      voice(gen({ f: n2f(m), shape: 'tri', a: 0.004, s: 0.04, r: 0.16, vol: 0.24, jit: 0.006 }));
      if (step >= 6) {
        voice(gen({ f: n2f(m + 12), shape: 'sine', a: 0.006, s: 0.03, r: 0.22, vol: 0.10 }));
      }
    };
    api.fanfare = function (pay) {
      if (!ensure() || api.sfxMuted) return;
      var chord = api.chord();
      var tier = pay >= 150 ? 3 : pay >= 90 ? 2 : 1;
      var t = ac.currentTime;
      if (!chord) {
        for (var pulse = 0; pulse < tier + 2; pulse++) glassPulse(pulse, t + pulse * 0.09, 0.09);
        return;
      }
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
    api.tick = function () {
      sfx('tick', { f: 1180, shape: 'sine', a: 0.002, s: 0.008, r: 0.045, vol: 0.07, jit: 0.045 }, 40);
    };
    api.slam = function () {
      sfx('slam', { f: 140, shape: 'tri', a: 0.004, s: 0.03, r: 0.16, slide: -0.6, vol: 0.20, noise: 0.10 }, 120);
    };
    api.hoard = function () {
      if (!ensure() || api.sfxMuted) return;
      var t = ac.currentTime;
      if (!api.chord()) { glassPulse(0, t, 0.09); glassPulse(2, t + 0.12, 0.07); return; }
      voice(gen({ f: n2f(76), shape: 'sine', a: 0.02, s: 0.06, r: 0.30, vol: 0.16 }), sfxBus, t);
      voice(gen({ f: n2f(80), shape: 'sine', a: 0.02, s: 0.08, r: 0.40, vol: 0.14 }), sfxBus, t + 0.12);
    };
    api.expire = function () {
      if (!ensure() || api.sfxMuted) return;
      var t = ac.currentTime;
      if (!api.chord()) { voice(gen({ f: 180, shape: 'tri', noise: 0.85, a: 0.004, s: 0.015, r: 0.10, slide: -2, vol: 0.07 }), sfxBus, t); return; }
      voice(gen({ f: n2f(64), shape: 'tri', a: 0.01, s: 0.04, r: 0.18, vol: 0.12 }), sfxBus, t);
      voice(gen({ f: n2f(60), shape: 'tri', a: 0.01, s: 0.05, r: 0.26, slide: -0.5, vol: 0.12 }), sfxBus, t + 0.14);
    };
    api.orderLost = function () {
      if (!ensure() || api.sfxMuted) return;
      var t = ac.currentTime;
      if (!api.chord()) { voice(gen({ f: 160, shape: 'tri', noise: 0.96, a: 0.008, s: 0.04, r: 0.24, slide: -3, vol: 0.09 }), sfxBus, t);
        voice(gen({ f: 90, shape: 'sine', noise: 0.75, a: 0.004, s: 0.015, r: 0.12, vol: 0.06 }), sfxBus, t + 0.16); return; }
      voice(gen({ f: 220, shape: 'tri', a: 0.004, s: 0.03, r: 0.10, vol: 0.10, noise: 0.35 }), sfxBus, t);
      voice(gen({ f: n2f(59), shape: 'sine', a: 0.01, s: 0.07, r: 0.34, slide: -0.9, vol: 0.15 }), sfxBus, t + 0.05);
      voice(gen({ f: n2f(52), shape: 'sine', a: 0.02, s: 0.10, r: 0.42, vol: 0.12 }), sfxBus, t + 0.20);
    };
    api.pour = function () {
      if (!ensure() || api.sfxMuted) return;
      var t = ac.currentTime;
      voice(gen({ f: 70, shape: 'tri', a: 0.03, s: 0.25, r: 0.4, vol: 0.16, noise: 0.55 }), sfxBus, t);
      for (var i = 0; i < 5; i++) {
        voice(gen({ f: 300 + Math.random() * 260, shape: 'tri', a: 0.003, s: 0.01, r: 0.06, vol: 0.07, noise: 0.2 }), sfxBus, t + 0.08 + Math.random() * 0.4);
      }
    };

    Meta.onAudioRestore(function () {
      api.musicMuted = Meta.data.musicMuted !== undefined ? !!Meta.data.musicMuted : api.musicMuted;
      api.sfxMuted = Meta.data.sfxMuted !== undefined ? !!Meta.data.sfxMuted : api.sfxMuted;
      api.musicVolume = volume(Meta.data.musicVolume, 0.7);
      api.sfxVolume = volume(Meta.data.sfxVolume, 1);
      if (ac) {
        hold(musicBus.gain, ac.currentTime);
        musicBus.gain.value = api.musicMuted ? 0 : api.musicVolume * 0.7;
        sfxBus.gain.value = api.sfxMuted ? 0 : api.sfxVolume;
        if (!musicAllowed()) pauseMusic(); else reconcileMusic();
      }
    });

    document.addEventListener('visibilitychange', function () {
      if (!ac) return;
      if (document.hidden) {
        pauseMusic();
        live.slice().forEach(function (r) { try { r.src.stop(); } catch (e) {} });
        try { var paused = ac.suspend(); if (paused && paused.catch) paused.catch(function () {}); } catch (e) {}
      } else { ensure(); reconcileMusic(); musicLoad(); }
    });

    return api;
  })();

  function Game(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.view = { cw: 1, ch: 1, dpr: 1, scale: 1, w: VIEW_MIN_W, h: VIEW_H, ox: 0, oy: 0 };
    this._last = null; this._acc = 0;
    this._taps = [];
    this.fliers = []; this.sparks = []; this.rings = []; this.picks = [];
    this.bursts = [];
    this.displayCoins = 0;
    this.hitStop = 0;
    this.state = 'menu';
    this.resize();
    this.watchInsets();
    this._frame = this._frame.bind(this);
    requestAnimationFrame(this._frame);
  }

  Game.prototype.start = function (seed, mode, level, archiveDay) {
    if (mode === true) mode = 'daily';
    this.mode = mode || 'free';
    this.isDaily = this.mode === 'daily';
    this.archiveDay = (this.isDaily && archiveDay && archiveDay !== dayNumber())
                    ? archiveDay : null;
    var reached = Math.min(careerCap(), Meta.data.careerLevel || 1);
    var want = level ? Math.max(1, Math.min(reached, level | 0)) : reached;
    var cc = this.mode === 'career' ? careerCfg(want) : null;
    this.career = cc;
    this.day = this.archiveDay || dayNumber();
    this.seed = cc ? cc.seed
              : this.archiveDay ? seedForDay(this.archiveDay)
              : ((seed >>> 0) || dailySeed());
    this.goalOrders = cc ? cc.orders : CFG.ordersPerShift;
    this.shiftSwings = cc ? cc.swings : CFG.swings;
    this.dayChar = this.isDaily ? dailyCharacter(this.day) : null;
    this.slotCls = this.dayChar ? this.dayChar.cls.slice() : SLOT_CLS.slice();
    if (cc && !cc.timed) this.slotCls[4] = 'med';
    this.bagCap = (this.mode === 'free' && Meta.data.hoardTotal >= 12) ? CFG.bagCap + 1 : CFG.bagCap;
    this.shiftCrusts = 0; this.shiftHearts = 0; this.shiftCombo = 0;
    this.contractsWon = null;
    this.careerResult = null;
    this.banked = 0;
    seedStream(this.seed);
    var wildHeart = noise01(1, (this.seed ^ 0x4EA48) >>> 0) < 0.35;
    this.jar = cc ? new Jar(this.seed, cc.junk, cc.rare, cc.heart, cc.lode, cc.shale)
                  : new Jar(this.seed, undefined, undefined, wildHeart,
                            CFG.freeLode, CFG.freeShale);
    this.jar.fastForward(2400);
    this.worldT = 0;
    this.coins = 0; this.displayCoins = 0;
    this.pops = 0; this.ordersDone = 0; this.hoard = 0;
    this.swings = this.shiftSwings;
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
    this.toast = Meta.data.tutorialDone ? {
      text: (this.career ? 'LEVEL ' + this.career.level + ' · ' : '')
            + this.goalOrders + ' orders before the pick wears out',
      until: 4.0,
    } : null;
    if (cc && cc.intro && Meta.data.tutorialDone) {
      this.toast = cc.intro === 'lode'
        ? { text: 'NEW LODESTONE: dense striped stone. It takes two swings to break through.', until: 4.6 }
        : { text: 'NEW SHALE: the cracked slab brings more rock down when you break it.', until: 4.6 };
      if (!Meta.data.taught) Meta.data.taught = {};
      Meta.data.taught[cc.intro] = 1;
      Meta.save();
    }
    this.refill = [0, 0, 0, 0, 0];
    this.orders = [];
    for (var s = 0; s < 5; s++) this.orders.push(this._makeOrder(s));
    this.combo = 0;
    this.bag = [];
    this.bagFlash = 0;
    this.tossFlash = 0; this.tossSlot = -1;
    this.focusOrder = null;
    this.tutStep = Meta.data.tutorialDone ? 3 : 0;
    this.tutClearAt = 0;
    this._taps.length = 0;
    this._lastTap = null;
    this._last = null; this._acc = 0; this.hitStop = 0;
    this.rings.length = 0; this.picks.length = 0;
    this.shakeT = 0;
    this.showSettings = false;
    this.choice = null; this.dragonPulse = 0;
    this.blame = null;
    this.fliers.length = 0; this.sparks.length = 0; this.bursts.length = 0;
    this.state = 'playing';
    Snd.beginShift();
  };

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
    var prior = this.state;
    if (this.state === 'playing' && v) this.state = 'paused';
    else if (this.state === 'paused' && !v && !this.showSettings) this.state = 'playing';
    if (this.state !== prior) {
      this._taps.length = 0; this._lastTap = null; this._last = null;
    }
  };

  Game.prototype.resize = function () {
    var cw = Math.max(320, window.innerWidth || 0);
    var ch = Math.max(240, window.innerHeight || 0);
    var dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    this.canvas.width = Math.round(cw * dpr);
    this.canvas.height = Math.round(ch * dpr);
    var scale = Math.min(ch / VIEW_H, cw / VIEW_MIN_W);
    var probe = document.getElementById('safe-probe');
    var inset = probe ? probe.getBoundingClientRect().top : 0;
    if (inset < 44 && ch / cw >= 2.0) inset = Math.max(inset, 54);
    var pb = document.getElementById('safe-probe-bottom');
    var insetBot = pb ? Math.max(0, ch - pb.getBoundingClientRect().bottom) : 0;
    if (insetBot < 20 && ch / cw >= 2.0) insetBot = Math.max(insetBot, 34);
    document.documentElement.style.setProperty('--guide-top', Math.max(12, inset) + 'px');
    document.documentElement.style.setProperty('--guide-bottom', Math.max(12, insetBot) + 'px');
    var uiTop = Math.max(0, inset) / scale;
    this.view = {
      cw: cw, ch: ch, dpr: dpr, scale: scale,
      w: cw / scale, h: ch / scale,
      ox: (cw / scale - VIEW_MIN_W) / 2,
      oy: 0,
      uiTop: uiTop,
      floorY: ch / scale - uiTop - insetBot / scale,
    };
  };

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

  Game.prototype.tapAt = function (wx, wy, bodyId) {
    var now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : 0;
    if (this._lastTap && now - this._lastTap.t < 80 &&
        this._lastTap.x === wx && this._lastTap.y === wy) return;
    this._lastTap = { x: wx, y: wy, t: now };
    this._taps.push({ x: wx, y: wy, bodyId: bodyId });
  };

  Game.prototype.update = function (STEP) {
    if (this.mode === 'excavation') { this._updateExcavation(STEP); return; }
    this.worldT += STEP;
    this.jar.step(STEP);
    for (var bi = 0; bi < this.jar.bodies.length; bi++) {
      var bb = this.jar.bodies[bi];
      if (bb.lastVy > 260 && bb.vy < 60) bb.squash = Math.min(1, bb.lastVy / 900);
      bb.lastVy = bb.vy;
    }

    if (this.epilogue > 0) this._taps.length = 0;

    while (this._taps.length) {
      var t = this._taps.shift();
      if (this.state !== 'playing' || this.epilogue > 0) { this._taps.length = 0; break; }
      if (this.choice) {
        if (t.bodyId !== undefined) continue;
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
        if (inRect(t, CR.gutter)) continue;
      }
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
      if (t.y >= ORDER_Y && t.y <= ORDER_Y + ORDER_H) {
        var cs2 = Math.floor((t.x - 14) / (ORDER_W + 8));
        if (cs2 >= 0 && cs2 < 5 && t.x - (14 + cs2 * (ORDER_W + 8)) <= ORDER_W) {
          this.focusOrder = this.focusOrder === this.orders[cs2] ? null : this.orders[cs2];
          continue;
        }
      }
      var b = t.bodyId === undefined ? this.jar.bodyAt(t.x, t.y) : null;
      if (t.bodyId !== undefined) {
        for (var named = 0; named < this.jar.bodies.length; named++) {
          if (this.jar.bodies[named].id === t.bodyId) { b = this.jar.bodies[named]; break; }
        }
      }
      if (!b) continue;
      if (b.key === 'heartstone') {
        if (!this.jar.exposed(b)) {
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
          if (this.career) {
            var pendingChoice = this.choice;
            this.choice = { key: 'heartstone', slot: -1 };
            this._resolveChoice('hoard');
            this.choice = pendingChoice;
          }
          else {
            if (this.choice) this._resolveChoice('hoard');
            this.choice = { key: 'heartstone', slot: -1, until: this.worldT + CHOICE_SECS, x: b.x, y: b.y };
          }
          if (this.swings <= 0 && this.state === 'playing') this._endShift();
        }
        continue;
      }
      if (b.lode && this.jar.exposed(b) && (b.hits || 0) < 1) {
        b.hits = 1;
        b.wiggle = 1.2;
        this.swings--;
        Hap.medium();
        Snd.thunk();
        this._rockChips(b.x, b.y);
        this.picks.push({ x: b.x, y: b.y, t: 0, heavy: true, cracked: this.swings <= 5 });
        this.toast = this._teach('lode',
          'LODESTONE: dense stone. It takes two swings to break through.',
          'The lodestone cracks. One more swing.');
        if (this.swings <= 0 && this.state === 'playing') this._endShift();
        continue;
      }
      if (this.jar.extract(b)) {
        this.pops++;
        this.swings--;
        if (this.swings === 5) Snd.expire();
        Snd.pop();
        Hap.light();
        this.rings.push({ x: b.x, y: b.y, r: b.r, t: 0 });
        var isRock = b.key.indexOf('rock') === 0;
        this.picks.push({ x: b.x, y: b.y, t: 0, heavy: isRock, cracked: this.swings <= 5 });
        if (isRock) this._rockChips(b.x, b.y);
        this._route(b);
        if (this.swings <= 0 && this.state === 'playing') this._endShift();
      } else {
        b.wiggle = 1;
        Snd.thunk();
        var seen = (Meta.data.taught && Meta.data.taught.blocked) || 0;
        if (seen < 6) {
          if (!Meta.data.taught) Meta.data.taught = {};
          Meta.data.taught.blocked = seen + 1;
          Meta.save();
        }
        var loud = seen < 6;
        var blk = this.jar.blockersOf(b, 3);
        this.blame = { until: this.worldT + (loud ? 1.9 : 0.75), loud: loud,
                       ids: {}, tid: b.id, x: b.x, y: b.y, r: b.r };
        for (var qi = 0; qi < blk.length; qi++) this.blame.ids[blk[qi].id] = 1;

      }
    }

    if (this.epilogue > 0) {
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
      return;
    }
    if (this.choice && this.worldT > this.choice.until) this._resolveChoice('order');
    if (this.tutStep === 2 && this.worldT > this.tutClearAt) {
      this.tutStep = 3;
      Meta.data.tutorialDone = true;
      Meta.save();
    }

    for (var s = 0; s < 5; s++) {
      var o = this.orders[s];
      if (this.worldT > o.expiresAt) {
        if (this.focusOrder === o) this.focusOrder = null;
        this.orders[s] = this._makeOrder(s);
        this.orders[s].dropT = 0.001;
        this.combo = 0;
        this.toast = { text: 'RUSH EXPIRED: new card, ladder reset',
                       until: this.worldT + 2.2 };
        Snd.orderLost();
      }
    }

    var rsb = this.career ? this.career.restockBelow : CFG.restockBelow;
    if (this.jar.fill() < rsb && this.ordersDone < this.goalOrders) {
      this.jar.pour(CFG.fillTarget);
      Snd.pour();
    }
  };

  Game.prototype._route = function (b) {
    var key = b.key;
    if (key.indexOf('rock') === 0) {
      if (b.geode) {
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
        var rolledBack = b.geode.length - got;
        this.toast = {
          text: 'CRACKED IT! ' + (rolledBack === 0
              ? got + (got === 1 ? ' gem' : ' gems') + ' straight to the bag!'
              : got === 0
              ? 'Bag full, ' + (rolledBack === 1 ? 'it' : rolledBack === 2 ? 'both' : 'all ' + rolledBack) + ' rolled back in.'
              : got + ' bagged, ' + rolledBack + ' rolled back in.'),
          until: this.worldT + 2,
        };
        this._burst(b.x, b.y, 12, 260, 240, 2, 2.5, 0.7, '#ffe9a8');
        if (this.tutStep === 0 && got) this.tutStep = 1;
        if (got) { Snd.fill(this.combo); this._checkDeliveries(); }
        return;
      }
      if (b.shale) {
        this.coins += 1;
        this._fly(b, 'scrap');
        var room = this.jar.fill() < CFG.fillTarget - 0.04;
        if (room) {
          var bt = 100000 + (b.pb || 0) * CFG.pourMax + (b.pi || 0);
          for (var si = 0; si < 3; si++) {
            var sp = jarBodySpec(si, bt, this.jar.seed, 1, 0, 0, 0);
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
            'SHALE: the cracked slab brings more rock down. Clearing it is not free.',
            'The shale gives way. More rock!');
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
    if (TYPE[key].rare) {
      if (this.choice) { this._gainHoard(b); return; }
      var wanted = false;
      for (var s = 0; s < 5; s++) if ((this.orders[s].need[key] || 0) > 0) wanted = true;
      if (wanted && this.bag.length < this.bagCap) {
        var bslot = null;
        for (var s2 = 0; s2 < 5; s2++) if ((this.orders[s2].need[key] || 0) > 0) { bslot = s2; break; }
        this.choice = { key: key, slot: bslot, until: this.worldT + CHOICE_SECS, x: b.x, y: b.y };
        Snd.hoard();
        return;
      }
      var priorToast = this.toast;
      this._gainHoard(b);
      if (!(Meta.data.taught && Meta.data.taught.prism)) {
        if (!Meta.data.taught) Meta.data.taught = {};
        Meta.data.taught.prism = 1;
        Meta.save();
        if (this.toast === priorToast) {
          this.toast = { text: 'PRISM: no card wants it, so Flint keeps it. The hoard is your collection.',
                         until: this.worldT + 3.6 };
        }
      }
      return;
    }
    if (this.bag.length >= this.bagCap) {
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
    if (b.great) {
      var greatOverflow = 0;
      for (var gq = 1; gq < GREAT_YIELD; gq++) {
        if (this.bag.length < this.bagCap) {
          this.bag.push(key);
          this._bumpCombo();
          this._fly(b, 'bag', this.bag.length - 1);
        } else {
          greatOverflow++;
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
      this.toast = { text: greatOverflow > 0
        ? 'A GREAT ' + key.toUpperCase() + '! ' + (GREAT_YIELD - greatOverflow) + ' bagged, ' + greatOverflow + ' rolled back in.'
        : 'A GREAT ' + key.toUpperCase() + '! Three gems from one swing.',
        until: this.worldT + 2 };
      this._burst(b.x, b.y, 14, 250, 235, 2, 2.6, 0.7, TYPE[key].hi);
    }
    Snd.fill(this.combo);
    this._checkDeliveries();
  };

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

  Game.prototype._teach = function (verb, long, short) {
    var first = !(Meta.data.taught && Meta.data.taught[verb]);
    if (first) {
      if (!Meta.data.taught) Meta.data.taught = {};
      Meta.data.taught[verb] = 1;
      Meta.save();
    }
    return { text: first ? long : short, until: this.worldT + (first ? 3.4 : 2) };
  };

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

  Game.prototype._focusedOrder = function () {
    var o = this.focusOrder;
    return o && !this.epilogue && this.orders[o.slot] === o ? o : null;
  };

  Game.prototype._orderPlan = function () {
    var o = this._focusedOrder();
    if (!o) return null;
    var have = 0, total = 0;
    for (var key in o.need) {
      total += o.need[key];
      have += Math.min(this._bagCount(key), o.need[key]);
    }
    return { slot: o.slot, have: have, total: total, missing: total - have };
  };

  Game.prototype._bagCount = function (key) {
    var n = 0;
    for (var i = 0; i < this.bag.length; i++) if (this.bag[i] === key) n++;
    return n;
  };

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
        again = this.ordersDone < this.goalOrders;
      }
    }
  };

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
    this.dragonPulse = 1;
    Hap.light();
    this._burst(0, 0, 8, 220, 190, 1.4, 2.4, 0.7, '#e8c9ff', 'ledge');
    var hit = null;
    for (var m = 0; m < MILESTONES.length; m++) {
      if (Meta.data.hoardTotal === MILESTONES[m].n) hit = MILESTONES[m].label;
    }
    if (!hit) {
      var rk = hoardRank(Meta.data.hoardTotal);
      if (rk && rk.at === Meta.data.hoardTotal) {
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
      this._burst(0, 0, 26, 300, 280, 2, 3, 0.9, '#e8c9ff', 'ledge');
    }
  };

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
      if (this.career) dest = 'hoard';
      if (dest === 'hoard') {
        this.hoard += HEART_GIFT;
        Meta.data.hoardTotal += HEART_GIFT;
        Meta.save();
        this._fly({ x: hFrom.x, y: hFrom.y, r: 34, key: 'prism' }, 'hoard');
        this.dragonPulse = 1;
        Hap.heavy();
        Snd.hoard();
        this.toast = { text: 'Flint is OVERJOYED! +' + HEART_GIFT + ' hoard',
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
    if (this.focusOrder === o) this.focusOrder = null;
    this.coins += o.pay;
    this.ordersDone++;
    var gsum = 0;
    for (var gk in o.need) gsum += o.need[gk];
    bump('gems', gsum);
    o.flash = 1;
    if (this.tutStep === 1) { this.tutStep = 2; this.tutClearAt = this.worldT + 4; }
    if (o.pay >= 150) this.shakeT = 0.4;
    this.hitStop = o.pay >= 150 ? 0.13 : 0.07;
    Hap.medium();
    Snd.fanfare(o.pay);
    this._celebrate(o);
    if (this.ordersDone >= this.goalOrders) {
      if (this.swingsAtGoal < 0) this.swingsAtGoal = this.swings;
      if (this.swings > 0 && this.epilogue === 0) {
        this.epilogue = this.swings;
        this.toast = { text: 'PERFECT SHIFT! Leftover swings pay out!', until: this.worldT + 3 };
        Snd.perfect();
        return;
      }
      if (this.epilogue > 0) return;
      this._endShift();
      return;
    }
    this.orders[o.slot] = this._makeOrder(o.slot);
  };

  Game.prototype._checkContracts = function () {
    var done = contractsDone(), L = stats(), won = [];
    var ctx = {
      L: L, M: Meta.data,
      s: {
        coins: this.coins,
        done: this.ordersDone,
        goal: this.goalOrders,
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
      this.contractsWon = won;
    }
  };

  Game.prototype._endShift = function () {
    if (this.state !== 'playing' || this._ending) return;
    this._ending = true;
    if (this.choice) this._resolveChoice(this._choicePays() ? 'order' : 'hoard');
    this._taps.length = 0;
    this.state = 'results';

    var st = stats();
    st.shifts = (st.shifts || 0) + 1;

    var d = dayNumber();
    if (d > (st.lastDay || 0)) {
      st.days = (st.days || 0) + 1;
      st.streak = (d === st.lastDay + 1 || !st.lastDay) ? (st.streak || 0) + 1 : 1;
      if (st.streak > (st.bestStreak || 0)) st.bestStreak = st.streak;
      st.lastDay = d;
    }
    this._uiLockUntil = nowMs() + UI_LOCK_MS;
    if (this.ordersDone >= this.goalOrders) ReviewAsk.shiftWon(this);
    if (this.career) {
      var won = this.ordersDone >= this.goalOrders;
      this.careerResult = { won: won, stars: 0 };
      if (won) {
        var left = this.swingsAtGoal - (this.pickBonus || 0);
        this.careerResult.stars = left >= 11 ? 3 : left >= 5 ? 2 : 1;
        this.careerResult.assisted = (this.pickBonus || 0) > 0;
        var lv = this.career.level;
        if (!Meta.data.careerStars) Meta.data.careerStars = {};
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
        if (lv === (Meta.data.careerLevel || 1)) {
          Meta.data.careerLevel = Math.min(CAREER_MAX + 1, lv + 1);
        }
      }
      if (!this.isDaily) this._checkContracts();
      Meta.save();
      return;
    }
    {
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
        var day = this.day;
        if (this.coins > (Meta.data.bestDaily[day] || 0)) Meta.data.bestDaily[day] = this.coins;
        if (this.archiveDay) { Meta.save(); return; }
        var payload = {
          day: day, seed: this.seed, player: Meta.data.playerName,
          coins: this.coins, pops: this.pops, client_id: Meta.data.clientId,
        };
        var q = Meta.data.pendingScore;
        if (!q || q.day !== day || payload.coins > q.coins) Meta.data.pendingScore = payload;
        Meta.save();
        var send = Meta.data.pendingScore;
        var self = this;
        this.board = null;
        var boardRequest = this._resultBoardRequest = {};
        Lb.submit(send, function (ok) {
          if (ok && Meta.data.pendingScore === send) { Meta.data.pendingScore = null; Meta.save(); }
          Lb.top(day, 10, function (rows) {
            if (self._resultBoardRequest === boardRequest && self.state === 'results' && self.isDaily && !self.archiveDay && self.day === day) self.board = rows;
          });
        });
      } else if (this.coins > Meta.data.bestFree) {
        Meta.data.bestFree = this.coins;
        Meta.save();
      }
      if (!this.isDaily) { this._checkContracts(); Meta.save(); }
    }
  };

  Game.prototype._burst = function (x, y, n, sx, sy, r0, r1, life, col, spot) {
    this.bursts.push({ x: x, y: y, n: n, sx: sx, sy: sy,
                       r0: r0, r1: r1, life: life, col: col, spot: spot });
  };

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
      if (lost < this._clackMin) continue;
      if (t - rec.t < 0.25) continue;
      rec.t = t;
      (hits || (hits = [])).push({ f: lost, r: b.r });
    }
    if (!hits) return;
    hits.sort(function (p, q) { return q.f - p.f; });

    var log = this._clackLog || (this._clackLog = []);
    var t0 = t - 0.12;
    while (log.length && log[0] < t0) log.shift();
    var room = 3 - log.length;
    if (room <= 0) return;
    var n = Math.min(hits.length, room, 2);
    for (var h = 0; h < n; h++) { Snd.clack(hits[h].f, hits[h].r); log.push(t); }
    if (bs.length * 3 < Object.keys(spd).length) this._spd = {};
  };

  Game.prototype._ringTargets = function () {
    if (this.tutStep !== 0 || this.state !== 'playing' || !this.jar) { this._ringSet = null; return; }
    var bs = this.jar.bodies, to = this.orders && this.orders[0];
    var want = [], any = [];
    for (var i = 0; i < bs.length; i++) {
      var b = bs[i];
      if (b.key.indexOf('rock') === 0 || b.key === 'heartstone') continue;
      if (!(this._expo && this._expo[b.id])) continue;
      any.push(b);
      if (to && (to.need[b.key] || 0) > this._bagCount(b.key)) want.push(b);
    }
    var pool = want.length ? want : any;
    pool.sort(function (p, q) { return p.y - q.y || p.id - q.id; });
    var set = {};
    for (var k = 0; k < pool.length && k < 2; k++) set[pool[k].id] = 1;
    this._ringSet = set;
  };

  Game.prototype._cosmetic = function (dtRaw) {
    var i, f;
    if (Motion.reduced) {
      this.bursts.length = 0; this.sparks.length = 0;
      this.fliers.length = 0; this.picks.length = 0;
    }
    while (this.bursts.length) {
      var bq = this.bursts.shift();
      var bx = bq.x, by = bq.y;
      if (bq.spot === 'ledge') {
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
    var gap = this.coins - this.displayCoins;
    if (gap > 0) {
      if (!this._rolling) this._rolling = gap;
      var before = Math.floor(this.displayCoins);
      this.displayCoins = Motion.reduced ? this.coins
        : Math.min(this.coins, this.displayCoins + Math.max(1, gap * 4) * dtRaw * 4);
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
    else if (kind === 'hoard') { tx = 52; ty = VIEW_H - 40; }
    else if (kind === 'toss') { tx = -40; ty = BAG_Y + 6; }
    else { tx = VIEW_MIN_W - 60; ty = 16; }
    this.fliers.push({
      toFloor: kind === 'hoard',
      x: b.x, y: b.y, tx: tx, ty: ty, t: 0,
      dur: kind === 'order' ? 0.32 : kind === 'bag' ? 0.26 : kind === 'toss' ? 0.5 : 0.42,
      r: b.r, col: t.col, hi: t.hi, key: b.key,
    });
  };

  Game.prototype._flyBagToCard = function (bagIdx, key, slot) {
    var t = TYPE[key];
    this.fliers.push({
      x: bagSlotX(Math.max(0, bagIdx)) + BAG_SLOT / 2, y: BAG_Y + BAG_SLOT / 2,
      tx: 14 + slot * (ORDER_W + 8) + ORDER_W / 2, ty: ORDER_Y + ORDER_H / 2,
      t: 0, dur: 0.22, r: 12, col: t.col, hi: t.hi, key: key,
    });
  };

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


  var FIELD_CLASSIC = { x: 70, y: 654, w: 280, h: 54 };
  var FIELD_HOME = { x: 140, y: 18, w: 104, h: 50 };
  function fieldRow(i) { return { x: 26, y: 246 + i * 78, w: 368, h: 68 }; }
  function excavationRecord(site) {
    return Meta.data.excavations.sites[site.id] || { cleared: false, bestSwings: 0, specimens: [] };
  }
  function specimenId(b) { return 'gem-' + b.id; }
  function fieldCount(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }
  function excavationCanCollect(g) { return g.swings >= 2 && g.jar.bodies.some(function (b) { return b.great; }); }
  function excavationCollectionBlock(g) {
    return g.jar.bodies.some(function (b) { return b.great; })
      ? 'Lifting intact needs 2 swings.' : 'No intact specimens remain at this site.';
  }
  function excavationRecipe(site) {
    return Object.keys(site.recipe).map(function (k) { return site.recipe[k] + ' ' + k; }).join(' + ');
  }
  Game.prototype.startExcavation = function (index) {
    var site = EXCAVATIONS[index];
    if (!site) return;
    this.mode = 'excavation'; this.isDaily = false; this.archiveDay = null; this.career = null;
    this.excavation = { index: index, site: site, specimens: [], delivered: false, prompt: false, cut: null, result: null };
    this.seed = 0; this.jar = makeExcavationJar(site);
    this.worldT = 0; this.swings = site.budget; this.shiftSwings = site.budget;
    this.coins = 0; this.displayCoins = 0; this.pops = 0; this.hoard = 0;
    this.ordersDone = 0; this.goalOrders = 1; this.bag = []; this.bagCap = 7;
    this.orders = [0, 1, 2, 3, 4].map(function (i) {
      return { slot: i, need: {}, total: {}, pay: 0, expiresAt: Infinity, flash: 0 };
    });
    this.choice = null; this.focusOrder = null; this.tutStep = 3; this.epilogue = 0;
    this.bagFlash = 0; this.tossFlash = 0; this.combo = 0; this.dragonPulse = 0;
    this.shakeT = 0; this.hitStop = 0; this._ending = false; this.blame = null;
    this._spd = {}; this._clackLog = []; this.toast = null;
    this.rings.length = 0; this.picks.length = 0; this.fliers.length = 0;
    this.sparks.length = 0; this.bursts.length = 0; this._taps.length = 0;
    this._lastTap = null; this._last = null; this._acc = 0;
    this.showSettings = false; this.state = 'playing'; Snd.beginShift();
  };
  Game.prototype._excavationFinish = function () {
    var e = this.excavation;
    if (this.mode !== 'excavation' || !e || this.state !== 'playing' || e.result) return;
    var used = e.site.budget - this.swings;
    var cleared = !!e.delivered && used > 0 && used <= e.site.budget && Math.floor(used) === used;
    e.result = { cleared: cleared, used: used, specimens: e.specimens.slice() };
    if (cleared) {
      var old = excavationRecord(e.site), ids = old.specimens.slice();
      e.specimens.forEach(function (id) { if (ids.indexOf(id) < 0) ids.push(id); });
      Meta.data.excavations.sites[e.site.id] = {
        cleared: true, bestSwings: old.bestSwings ? Math.min(old.bestSwings, used) : used,
        specimens: ids.sort()
      };
      Meta.save();
      Snd.fill(1);
    } else Snd.thunk();
    e.cut = null; e.prompt = false; this._taps.length = 0; this.state = 'results';
  };
  Game.prototype._excavationDeliver = function () {
    var e = this.excavation;
    if (e.delivered) return;
    var need = e.site.recipe, bag = this.bag;
    if (!Object.keys(need).every(function (k) { return bag.filter(function (v) { return v === k; }).length >= need[k]; })) return;
    Object.keys(need).forEach(function (k) {
      for (var n = 0; n < need[k]; n++) bag.splice(bag.indexOf(k), 1);
    });
    e.delivered = true; e.prompt = true; this.ordersDone = 1; Snd.fill(1);
  };
  Game.prototype._excavationCut = function (action) {
    var e = this.excavation, b = e.cut;
    if (!b) return;
    if (action === 'cancel') { e.cut = null; return; }
    var cost = action === 'lift' ? 2 : 1;
    if (this.swings < cost || (action === 'split' && this.bag.length + 3 > this.bagCap)) return;
    if (!this.jar.extract(b)) { e.cut = null; return; }
    this.swings -= cost; this.pops++; e.cut = null;
    if (action === 'lift') { e.specimens.push(specimenId(b)); Snd.hoard(); }
    else { this.bag.push(b.key, b.key, b.key); Snd.pop(); }
    this._excavationDeliver();
    if (e.delivered && !excavationCanCollect(this)) e.prompt = true;
    this._excavationCheckMaterial();
    if (this.swings <= 0) this._excavationFinish();
  };
  Game.prototype._excavationCheckMaterial = function () {
    var e = this.excavation;
    if (e.delivered) return;
    var available = {}, need = e.site.recipe;
    this.bag.forEach(function (k) { available[k] = (available[k] || 0) + 1; });
    this.jar.bodies.forEach(function (b) { available[b.key] = (available[b.key] || 0) + (b.great ? 3 : 1); });
    var missing = Object.keys(need).filter(function (k) { return (available[k] || 0) < need[k]; });
    if (missing.length) {
      e.failure = 'Not enough ' + missing.join(' or ') + ' remains.';
      this._excavationFinish();
    }
  };
  Game.prototype._updateExcavation = function (STEP) {
    var e = this.excavation;
    this.worldT += STEP;
    if (!e.cut && !e.prompt) this.jar.step(STEP);
    while (this._taps.length && this.state === 'playing') {
      var t = this._taps.shift();
      if (e.cut || e.prompt) continue;
      if (t.y >= BAG_HIT_TOP && t.y <= BAG_HIT_BOT) {
        var slot = Math.floor((t.x - bagSlotX(0)) / (BAG_SLOT + BAG_GAP));
        if (slot >= 0 && slot < this.bag.length) { this.bag.splice(slot, 1); Snd.scrap(); this._excavationCheckMaterial(); }
        continue;
      }
      var b = t.bodyId === undefined ? this.jar.bodyAt(t.x, t.y) :
        this.jar.bodies.filter(function (body) { return body.id === t.bodyId; })[0];
      if (!b) continue;
      if (!this.jar.exposed(b)) {
        this.toast = { text: 'Clear the pieces above this one first.', until: this.worldT + 3 };
        b.wiggle = 1; Snd.thunk(); continue;
      }
      if (b.great) { e.cut = b; this._taps.length = 0; continue; }
      var rock = b.key.indexOf('rock') === 0;
      if (!rock && this.bag.length >= this.bagCap) {
        this.toast = { text: 'Satchel full. Tap a bag gem to discard it.', until: this.worldT + 3 };
        Snd.thunk(); continue;
      }
      if (b.lode && !b.hits) {
        b.hits = 1; this.swings--; Snd.thunk();
        this.toast = { text: 'Dense stone cracked. One more swing.', until: this.worldT + 3 };
      } else if (this.jar.extract(b)) {
        this.swings--; this.pops++;
        if (!rock) this.bag.push(b.key);
        Snd.pop();
        this._excavationDeliver();
      }
      this._excavationCheckMaterial();
      if (this.swings <= 0) this._excavationFinish();
    }
  };
  Game.prototype._excavationControls = function () {
    var e = this.excavation, out = [];
    function add(id, label, x, y, w, h, disabled) {
      out.push({ id: id, label: label, rect: { x: x, y: y, w: w, h: h }, disabled: !!disabled });
    }
    if (this.state === 'fieldnotes') {
      EXCAVATIONS.forEach(function (site, i) {
        var r = fieldRow(i), rec = excavationRecord(site);
        add('site:' + i, site.title + '. ' + site.brief + '. ' + site.budget + ' swings. ' +
          (rec.cleared ? 'Completed in ' + rec.bestSwings + ' swings. ' : 'Not yet completed. ') +
          rec.specimens.length + ' of ' + site.specimens.length + ' specimens preserved.', r.x, r.y, r.w, r.h);
      });
      add('classic', 'Back to Burrow: Career, Daily, Free Dig and Shop', FIELD_CLASSIC.x, FIELD_CLASSIC.y, FIELD_CLASSIC.w, FIELD_CLASSIC.h);
    } else if (this.state === 'results') {
      add('excavation:retry', 'Replay this excavation', 60, 488, 300, 58);
      add('excavation:journal', 'Return to field journal', 60, 558, 300, 58);
    } else if (e.cut) {
      add('cut:lift', 'Lift intact. Costs 2 swings. Preserve this specimen for Flint.', 54, 370, 312, 58, this.swings < 2);
      add('cut:split', 'Split. Costs 1 swing. Put 3 ' + e.cut.key + ' gems in the satchel. Specimen is lost for this attempt.', 54, 440, 312, 58, this.bag.length + 3 > 7);
      add('cut:cancel', 'Leave this gem for now', 54, 510, 312, 52);
    } else if (e.prompt) {
      add('excavation:finish', 'Finish now and record ' + (e.site.budget - this.swings) + ' swings used', 54, 378, 312, 58);
      add('excavation:continue', excavationCanCollect(this) ? 'Keep digging for intact specimens. Uses remaining swings.' : excavationCollectionBlock(this), 54, 448, 312, 58, !excavationCanCollect(this));
    } else {
      if (e.delivered) add('excavation:finish', 'Finish excavation and save specimens', 214, 654, 180, 54);
      this.bag.forEach(function (key, i) {
        add('bag:' + i, 'Discard ' + key + ' from satchel slot ' + (i + 1), bagSlotX(i), BAG_HIT_TOP, BAG_SLOT + BAG_GAP, BAG_HIT_BOT - BAG_HIT_TOP);
      });
      this.jar.bodies.forEach(function (b) {
        if (!this.jar.exposed(b)) return;
        var sz = Math.max(50, b.r * 2);
        add('gem:' + b.id, b.great ? 'Great ' + b.key + '. Choose split or preserve.' : b.lode ? 'Dense stone. ' + (b.hits ? '1 swing left.' : '2 swings to clear.') : 'Dig ' + b.key,
          b.x - sz / 2, b.y - sz / 2, sz, sz);
      }, this);
    }
    add('settings', 'Settings', MENU.gear.x, MENU.gear.y, MENU.gear.w, MENU.gear.h);
    return out;
  };
  Game.prototype._excavationTap = function (w) {
    if (this.state === 'paused') { this.setPaused(false); return; }
    var controls = this._excavationControls();
    for (var i = 0; i < controls.length; i++) {
      var d = controls[i];
      if (d.id.indexOf('gem:') === 0 || d.id.indexOf('bag:') === 0 || !inRect(w, d.rect)) continue;
      if (d.disabled) return;
      uiTick();
      if (d.id === 'settings') this.openSettings();
      else if (d.id === 'classic') { this.state = 'menu'; Snd.scene('shop'); }
      else if (d.id.indexOf('site:') === 0) this.startExcavation(Number(d.id.split(':')[1]));
      else if (d.id.indexOf('cut:') === 0) this._excavationCut(d.id.split(':')[1]);
      else if (d.id === 'excavation:finish') this._excavationFinish();
      else if (d.id === 'excavation:continue') this.excavation.prompt = false;
      else if (d.id === 'excavation:retry') this.startExcavation(this.excavation.index);
      else if (d.id === 'excavation:journal') { this.state = 'fieldnotes'; Snd.scene('shop'); }
      return;
    }
    if (this.state === 'playing') this.tapAt(w.x, w.y, w.bodyId);
  };
  function fieldText(ctx, text, x, y, size, color, family) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = color || '#f2e5cf'; ctx.font = (family || fT)(size);
    ctx.fillText(text, x, y);
  }
  function fieldPanel(ctx, x, y, w, h) {
    ctx.fillStyle = 'rgba(25,20,16,0.94)'; rr(ctx, x, y, w, h, 18); ctx.fill();
    ctx.strokeStyle = '#a98550'; ctx.lineWidth = 1.5; ctx.stroke();
  }
  Game.prototype._drawFieldnotes = function () {
    var c = this.ctx;
    fieldPanel(c, 14, 14, 392, 698);
    fieldText(c, 'GEMBURROW', 210, 30, 22, '#e7bd74', fD);
    fieldText(c, "Flint's field journal", 210, 82, 28, '#fff1d5', fD);
    fieldText(c, 'Five finite digs. Find your own route.', 210, 122, 14);
    var icon = SPR.dragon;
    if (icon) c.drawImage(icon, 22, 144, 84, 84);
    c.textAlign = 'left'; c.fillStyle = '#e7bd74'; c.font = fT(15, 'bold');
    c.fillText('SPLIT IT OR SAVE IT?', 110, 158);
    c.fillStyle = '#e8dcc8'; c.font = fT(13);
    c.fillText('Fill a commission with loose gems.', 110, 183);
    c.fillText('Keep great gems intact for the journal.', 110, 204);
    EXCAVATIONS.forEach(function (site, i) {
      var r = fieldRow(i), rec = excavationRecord(site);
      c.fillStyle = rec.cleared ? '#353b2b' : '#493b2b'; rr(c, r.x, r.y, r.w, r.h, 12); c.fill();
      c.strokeStyle = rec.cleared ? '#acba80' : '#ad8857'; c.lineWidth = 1; c.stroke();
      c.textAlign = 'left'; c.textBaseline = 'top'; c.fillStyle = '#ffe6af'; c.font = fD(18);
      var title = (i + 1) + '. ' + site.title, titleSize = 18;
      var titleWidth = r.w - 45 - site.specimens.length * 26;
      while (titleSize > 13 && c.measureText(title).width > titleWidth) { titleSize--; c.font = fD(titleSize); }
      c.fillText(title, r.x + 14, r.y + 10);
      c.fillStyle = '#e3d5c1'; c.font = fT(12);
      c.fillText(rec.cleared ? 'Best: ' + rec.bestSwings + ' swings · ' + rec.specimens.length + '/' + site.specimens.length + ' specimens' :
        site.budget + ' swings · ' + ['Speed or a specimen?', 'Choose a gem to preserve', 'Mind the seven-slot satchel', 'Dense stone or a detour?', 'A commission between treasures'][i], r.x + 14, r.y + 39);
      site.specimens.forEach(function (id, j) {
        var specimen = site.bodies.filter(function (b) { return b.id === id; })[0];
        var art = specimen && SPR[bodySpr(specimen)], px = r.x + r.w - 30 - j * 26;
        var kept = rec.specimens.indexOf('gem-' + id) >= 0;
        c.globalAlpha = kept ? 1 : 0.28;
        if (art) c.drawImage(art, px - 12, r.y + 8, 24, 24);
        c.globalAlpha = 1;
        if (kept) { c.strokeStyle = '#c5e69a'; c.lineWidth = 1; c.beginPath(); c.arc(px, r.y + 20, 14, 0, 6.283); c.stroke(); }
      });
    });
    choicePlate(c, FIELD_CLASSIC, 'BACK TO BURROW', 'Career · Daily · Free Dig · Shop', 'wood', false);
    this._drawGearAt(MENU.gear);
  };
  Game.prototype._drawExcavation = function (alpha) {
    var c = this.ctx, e = this.excavation, site = e.site, v = this.view;
    c.save();
    function text(t, x, y, size, color, family, align) {
      c.textAlign = align || 'center'; c.textBaseline = 'top';
      c.fillStyle = color || '#4c4234'; c.font = (family || fT)(size);
      c.fillText(t, x, y);
    }
    function paper(x, y, w, h, label) {
      c.fillStyle = 'rgba(0,0,0,0.28)'; rr(c, x + 2, y + 3, w, h, 9); c.fill();
      c.fillStyle = '#fbf3e2'; rr(c, x, y, w, h, 9); c.fill();
      c.fillStyle = 'rgba(201,168,106,0.22)'; rr(c, x, y, w, 18, 9); c.fill();
      c.strokeStyle = '#c0ac8a'; c.lineWidth = 1.5; rr(c, x, y, w, h, 9); c.stroke();
      if (label) text(label, x + w / 2, y + 5, 10, '#6b5d49');
    }
    text(site.title, 16, 0, 15, '#fff1d5', fD, 'left');
    text('SITE ' + (e.index + 1) + ' / ' + EXCAVATIONS.length, 335, 5, 9, '#d6ba8b', fT, 'right');
    text('\u26cf', 16, 19, 13, '#e8dcc8', fT, 'left');
    c.fillStyle = 'rgba(20,12,6,0.6)'; rr(c, 34, 22, 102, 8, 4); c.fill();
    c.fillStyle = this.swings > 2 ? '#ffd75e' : '#e8a53c';
    rr(c, 34, 22, Math.max(4, 102 * this.swings / site.budget), 8, 4); c.fill();
    text(this.swings + ' / ' + site.budget + ' swings', 145, 18, 11, '#e8dcc8', fT, 'left');
    c.strokeStyle = '#6b4a2f'; c.lineWidth = 3; c.beginPath();
    c.moveTo(-8, 36); c.quadraticCurveTo(210, 44, 428, 36); c.stroke();
    c.strokeStyle = 'rgba(255,235,200,0.25)'; c.lineWidth = 1; c.beginPath();
    c.moveTo(-8, 35); c.quadraticCurveTo(210, 43, 428, 35); c.stroke();
    [[16,172],[194,152]].forEach(function (r) {
      var pin = r[0] + r[1] / 2;
      c.fillStyle = '#a97c4f'; rr(c, pin - 5, 31, 10, 18, 3); c.fill();
      c.strokeStyle = 'rgba(60,35,18,0.5)'; c.beginPath(); c.moveTo(pin,33); c.lineTo(pin,44); c.stroke();
    });
    paper(16, 45, 172, 95, 'COMMISSION');
    var keys = Object.keys(site.recipe);
    if (keys.length === 1) {
      var key = keys[0], need = site.recipe[key],
          have = e.delivered ? need : Math.min(need, this._bagCount(key)), art = SPR[BODY_SPR[key]];
      if (art) c.drawImage(art, 40, 70, 38, 38);
      text(e.delivered ? 'FILLED' : have + ' / ' + need, 125, 75, e.delivered ? 20 : 26, e.delivered ? '#3f8f4f' : '#5b4930', fD);
      text(need + ' loose ' + key, 102, 119, 11, '#7b684d');
    } else {
      keys.forEach(function (key, i) {
        var need = site.recipe[key], have = e.delivered ? need : Math.min(need, this._bagCount(key));
        var art = SPR[BODY_SPR[key]], y = 67 + i * 22;
        if (art) c.drawImage(art, 30, y - 1, 21, 21);
        if (Meta.data.marks === 1) gemMark(c, key, 40.5, y + 9.5, 5);
        text(key, 60, y + 3, 11, '#6b5d49', fT, 'left');
        text(e.delivered ? '✓' : have + '/' + need, 174, y + 2, 14, have >= need ? '#3f8f4f' : '#5b4930', fT, 'right');
      }, this);
    }
    paper(194, 45, 152, 95, 'KEEP FOR FLINT');
    var intactLeft = this.jar.bodies.some(function (b) { return b.great; });
    var targets = site.specimens.map(function (id) {
      return site.bodies.filter(function (b) { return b.id === id; })[0];
    }).filter(Boolean);
    if (targets.length === 1) {
      var specimenArt = SPR[bodySpr(targets[0])];
      if (specimenArt) { c.globalAlpha = e.specimens.length ? 1 : intactLeft ? 0.60 : 0.20; c.drawImage(specimenArt, 211, 70, 38, 38); c.globalAlpha = 1; }
      text(e.specimens.length + ' / ' + targets.length, 287, 77, 23, '#755842', fD);
      text(e.specimens.length ? 'Safe with Flint' : intactLeft ? 'Lift intact · 2 swings' : 'Split this attempt', 270, 119, 10, '#7b684d');
    } else {
      targets.forEach(function (body, i) {
        var kept = e.specimens.indexOf(specimenId(body)) >= 0;
        var left = this.jar.bodies.some(function (b) { return b.id === body.id; });
        var art = SPR[bodySpr(body)], x = 270 + (i - (targets.length - 1) / 2) * 38;
        c.globalAlpha = kept ? 1 : left ? 0.60 : 0.20;
        if (art) c.drawImage(art, x - 17, 72, 34, 34);
        c.globalAlpha = 1;
        if (!kept && !left) {
          c.strokeStyle = '#9d7260'; c.lineWidth = 1.5;
          c.beginPath(); c.moveTo(x - 10, 99); c.lineTo(x + 10, 79); c.stroke();
        }
      }, this);
      text(e.specimens.length + ' / ' + targets.length + ' intact', 270, 118, 12, '#755842', fD);
    }
    this._drawGearAt(MENU.gear);
    var bx = bagSlotX(0) - 10, bw = 7 * (BAG_SLOT + BAG_GAP) - BAG_GAP + 20;
    c.fillStyle = 'rgba(0,0,0,0.30)'; rr(c, bx+2, BAG_Y-1, bw, BAG_SLOT+8,10); c.fill();
    c.fillStyle = '#5c4128'; rr(c,bx,BAG_Y-4,bw,BAG_SLOT+8,10); c.fill();
    c.strokeStyle = 'rgba(255,235,200,0.35)'; c.lineWidth = 1; c.setLineDash([4,4]);
    rr(c,bx+3,BAG_Y-1,bw-6,BAG_SLOT+2,8); c.stroke(); c.setLineDash([]);
    for (var k = 0; k < 7; k++) {
      var x = bagSlotX(k), spr = SPR[BODY_SPR[this.bag[k]]];
      c.fillStyle = 'rgba(30,22,16,0.72)'; rr(c,x,BAG_Y,BAG_SLOT,BAG_SLOT,7); c.fill();
      c.strokeStyle = k < this.bag.length ? '#c9a86a' : 'rgba(201,168,106,0.35)';
      c.lineWidth = 1.5; c.stroke();
      if (spr) {
        c.drawImage(spr,x+2,BAG_Y+2,BAG_SLOT-4,BAG_SLOT-4);
        if (Meta.data.marks === 1) gemMark(c,this.bag[k],x+14,BAG_Y+14,6);
      }
    }
    text('BAG', 72, BAG_Y+9, 10, '#d6ba8b');
    text('Seven spaces · tap a held gem to discard', 210, 180, 10, '#e2cfae');
    c.fillStyle = 'rgba(190,225,255,0.08)';
    rr(c,JAR.l-10,JAR.top-16,JAR.r-JAR.l+20,JAR.bot-JAR.top+26,18); c.fill();
    this._expo = {};
    this.jar.bodies.forEach(function (b) { this._expo[b.id] = this.jar.exposed(b); },this);
    this.jar.bodies.forEach(function (b) { this._drawBody(b,alpha); },this);
    this.jar.bodies.forEach(function (b) {
      if (!b.great) return;
      c.fillStyle = '#fbf3e2'; rr(c,b.x-22,b.y+b.r-14,44,15,4); c.fill();
      text('GREAT',b.x,b.y+b.r-12,9,'#79542a');
    });
    c.strokeStyle = 'rgba(230,245,255,0.35)'; c.lineWidth=3;
    rr(c,JAR.l-10,JAR.top-16,JAR.r-JAR.l+20,JAR.bot-JAR.top+26,18); c.stroke();
    c.strokeStyle='rgba(255,255,255,0.07)';c.lineWidth=7;c.beginPath();
    c.moveTo(JAR.l+10,JAR.top+16);c.lineTo(JAR.l+10,JAR.top+150);c.stroke();
    var ledge = this._layoutCounter(), base = ledge.y + ledge.h - 10;
    var shade = c.createLinearGradient(0,ledge.y,0,ledge.y+ledge.h);
    shade.addColorStop(0,'rgba(96,64,38,0.96)');shade.addColorStop(0.10,'rgba(74,48,29,0.96)');shade.addColorStop(1,'rgba(34,22,14,0.98)');
    c.fillStyle=shade;c.fillRect(ledge.l,ledge.y,ledge.r-ledge.l,ledge.h);
    c.fillStyle='rgba(214,168,104,0.55)';c.fillRect(ledge.l,ledge.y,ledge.r-ledge.l,3);
    c.fillStyle='rgba(0,0,0,0.30)';c.fillRect(ledge.l,ledge.y+3,ledge.r-ledge.l,4);
    var ds=Math.min(86,ledge.h-14), dragon=dragonImage();
    if(dragon)c.drawImage(dragon,ledge.l+12,base-ds,ds,ds);
    text('FLINT\u2019S SPECIMENS',e.delivered?110:120,base-54,10,'#d6ba8b',fT,'left');
    c.textAlign='left'; c.textBaseline='top'; c.fillStyle=e.specimens.length?'#b9dda0':'#f6e4bf';
    fitT(c,e.delivered ? e.specimens.length + ' / ' + targets.length + ' kept' : e.specimens.length ? fieldCount(e.specimens.length,'specimen') + ' kept' : intactLeft ? 'Still in the jar' : 'Split this time',
      e.delivered?110:120,base-35,e.delivered?95:260,e.delivered?14:17,'bold');
    var note=this.toast&&this.toast.until>this.worldT?this.toast.text:'A quick commission, or one more gem for Flint?';
    if(e.delivered) {
      choicePlate(c,{x:214,y:654,w:180,h:54},'FINISH DIG','Record this route','career',false);
    } else if (ledge.h >= 92) {
      c.textAlign='center';c.textBaseline='top';c.fillStyle='#f3dfb8';fitT(c,note,210,ledge.y+12,380,11);
    }
    if(e.cut||e.prompt||this.state==='results'||this.state==='paused') {
      c.fillStyle='rgba(12,9,6,0.55)';c.fillRect(-v.ox,-v.uiTop,v.w,v.h+v.uiTop);
      paper(30,230,360,398,'');
      if(this.state==='paused') {
        text('Dig paused',210,310,26,'#5b4930',fD);text('Tap to resume',210,356,16);
      } else if(this.state==='results') {
        text(e.delivered?'Commission complete':'Try another route',210,258,24,'#5b4930',fD);
        text(e.delivered?fieldCount(e.result.used,'swing')+' used · '+this.swings+' saved':(e.failure||'No swings left.'),210,304,14);
        text(e.delivered?fieldCount(e.specimens.length,'specimen')+' kept for Flint':'The journal keeps completed digs.',210,337,14);
        var resultLeft=210-(80+e.specimens.length*46)/2;
        if(dragon)c.drawImage(dragon,resultLeft,369,80,80);
        e.specimens.forEach(function(id,j){
          var b=site.bodies.filter(function(body){return specimenId(body)===id;})[0],im=b&&SPR[bodySpr(b)];
          if(im)c.drawImage(im,resultLeft+80+j*46,404,40,40);
        });
        choicePlate(c,{x:60,y:488,w:300,h:58},'REPLAY THIS SITE','Try a different route','career',false);
        choicePlate(c,{x:60,y:558,w:300,h:58},'FIELD JOURNAL','Choose another excavation','wood',false);
      } else if(e.cut) {
        text('A great '+e.cut.key,210,248,25,'#5b4930',fD);
        var gem=SPR[bodySpr(e.cut)];if(gem)c.drawImage(gem,175,281,70,70);
        choicePlate(c,{x:54,y:370,w:312,h:58},'LIFT INTACT · 2 SWINGS','Keep for Flint; no loose gems','free',this.swings<2);
        choicePlate(c,{x:54,y:440,w:312,h:58},'SPLIT · 1 SWING',this.bag.length+3>7?'Needs 3 empty satchel spaces':'3 loose '+e.cut.key+' gems; specimen is lost','career',this.bag.length+3>7);
        choicePlate(c,{x:54,y:510,w:312,h:52},'LEAVE IT FOR NOW','Choose another route','wood',false);
        text('Your choice. No timer.',210,590,12,'#7b684d');
      } else {
        text('The commission is filled',210,262,23,'#5b4930',fD);
        text(excavationCanCollect(this)?fieldCount(this.swings,'swing')+' remain. What will you keep?':excavationCollectionBlock(this),210,309,13);
        choicePlate(c,{x:54,y:378,w:312,h:58},'FINISH NOW','Record a route of '+(site.budget-this.swings)+' swings','career',false);
        choicePlate(c,{x:54,y:448,w:312,h:58},'KEEP DIGGING',excavationCanCollect(this)?'Spend spare swings to preserve specimens':excavationCollectionBlock(this),'free',!excavationCanCollect(this));
        if(dragon)c.drawImage(dragon,177,533,66,66);
      }
    }
    c.restore();
  };

  Game.prototype.draw = function (alpha) {
    var ctx = this.ctx, v = this.view;
    ctx.setTransform(v.dpr * v.scale, 0, 0, v.dpr * v.scale, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    var bg = (this.state === 'menu' ? SPR.backdrop_burrow
                                    : (wallImage() || SPR.backdrop_burrow));
    if (bg) {
      var s = Math.max(v.w / bg.width, v.h / bg.height);
      var bw = bg.width * s, bh = bg.height * s;
      ctx.drawImage(bg, (v.w - bw) / 2, (v.h - bh) / 2, bw, bh);
      ctx.fillStyle = this.state === 'menu' ? 'rgba(20,14,10,0.30)'
                                            : 'rgba(16,10,6,0.18)';
      ctx.fillRect(0, 0, v.w, v.h);
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
    if (!Motion.reduced && this.shakeT > 0) {
      var amp = 5 * (this.shakeT / 0.4);
      ctx.translate((Math.random() - 0.5) * amp, (Math.random() - 0.5) * amp);
    }

    if (this.state === 'fieldnotes') { this._drawFieldnotes(); this._drawSettings(); ctx.restore(); return; }
    if (this.mode === 'excavation' && (this.state === 'playing' || this.state === 'paused' || this.state === 'results')) {
      this._drawExcavation(alpha); this._drawSettings(); ctx.restore(); return;
    }
    if (this.state === 'menu') { this._drawMenu(); this._drawSettings(); ctx.restore(); return; }
    if (this.state === 'shop') { this._drawShop(); this._drawSettings(); ctx.restore(); return; }
    if (this.state === 'records') { this._drawRecords(); this._drawSettings(); ctx.restore(); return; }
    if (this.state === 'levels') { this._drawLevels(); this._drawSettings(); ctx.restore(); return; }
    if (this.state === 'paywall') { this._drawPaywall(); this._drawSettings(); ctx.restore(); return; }

    this._lampT = Motion.reduced ? 0.5 : (this._lampT || 0.5) + (Math.random() - 0.5) * 0.08;
    this._lampT = Math.max(0.3, Math.min(0.7, this._lampT));
    var lg = ctx.createRadialGradient(VIEW_MIN_W / 2, 120, 10, VIEW_MIN_W / 2, 120, 260);
    lg.addColorStop(0, 'rgba(255,190,90,' + (0.10 + this._lampT * 0.08).toFixed(3) + ')');
    lg.addColorStop(1, 'rgba(255,190,90,0)');
    ctx.fillStyle = lg;
    ctx.fillRect(-v.ox, -v.uiTop, v.w, 420);

    ctx.fillStyle = 'rgba(190,225,255,0.08)';
    rr(ctx, JAR.l - 10, JAR.top - 16, JAR.r - JAR.l + 20, JAR.bot - JAR.top + 26, 18);
    ctx.fill();

    this._expo = {};
    for (var ei = 0; ei < this.jar.bodies.length; ei++) {
      var eb = this.jar.bodies[ei];
      this._expo[eb.id] = this.jar.exposed(eb);
    }
    this._ringTargets();
    for (var i = 0; i < this.jar.bodies.length; i++) {
      this._drawBody(this.jar.bodies[i], alpha);
    }

    ctx.strokeStyle = 'rgba(230,245,255,0.35)';
    ctx.lineWidth = 3;
    rr(ctx, JAR.l - 10, JAR.top - 16, JAR.r - JAR.l + 20, JAR.bot - JAR.top + 26, 18);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(JAR.l + 10, JAR.top + 16);
    ctx.lineTo(JAR.l + 10, JAR.top + 150);
    ctx.stroke();

    this._drawCounter();

    this._drawOrders();
    this._drawBag();
    if (this.choice) this._drawChoice();

    for (i = 0; i < this.fliers.length; i++) this._drawFlier(this.fliers[i]);
    for (i = 0; !Motion.reduced && i < this.sparks.length; i++) {
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
      ctx.beginPath(); ctx.arc(rg.x, rg.y, (rg.r || 14) + (Motion.reduced ? 0 : rg.t * 26), 0, 6.283); ctx.stroke();
    }
    ctx.globalAlpha = 1;

    this._hud();
    if (this.state === 'results') this._drawResults();
    if (this.state === 'paused' && !this.showSettings) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(-v.ox, -v.uiTop, v.w, v.h + v.uiTop);
      ctx.textAlign = 'center'; ctx.textBaseline = 'top';
      ctx.fillStyle = '#fff'; ctx.font = fD(34);
      ctx.fillText('PAUSED', VIEW_MIN_W / 2, v.h / 2 - 40);
      ctx.fillStyle = 'rgba(232,220,200,0.7)'; ctx.font = fT(15);
      ctx.fillText('tap to resume', VIEW_MIN_W / 2, v.h / 2 + 4);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    }
    this._drawSettings();
    ctx.restore();
  };

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
    var w = 0.45;
    rr = Math.round(rr / n + (255 - rr / n) * w);
    gg = Math.round(gg / n + (255 - gg / n) * w);
    bb = Math.round(bb / n + (255 - bb / n) * w);
    return rr + ',' + gg + ',' + bb;
  }

  Game.prototype._shaleDust = function (x, y, b) {
    var ctx = this.ctx;
    for (var i = 0; i < 3; i++) {
      var ph = ((Motion.reduced ? 0 : this.worldT * 0.9) + b.id * 0.37 + i * 0.33) % 1;
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

  Game.prototype._crustGlint = function (x, y, b) {
    var ctx = this.ctx;
    var tw = Motion.reduced ? 0.5 : 0.5 + 0.5 * Math.sin(this.worldT * 2.4 + b.id * 1.7);
    var inner = crustHue(b);
    var gy = y - b.r * 0.06;
    var gr = b.r * (0.30 + 0.10 * tw);
    var g = ctx.createRadialGradient(x, gy, 0, x, gy, gr);
    g.addColorStop(0, 'rgba(255,252,232,' + (0.45 + 0.35 * tw).toFixed(2) + ')');
    g.addColorStop(0.55, 'rgba(' + inner + ',' + (0.30 + 0.22 * tw).toFixed(2) + ')');
    g.addColorStop(1, 'rgba(' + inner + ',0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, gy, gr, 0, 6.283); ctx.fill();
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
    var _hints = Meta.data.hints !== 0;
    var x = b.px + (b.x - b.px) * alpha;
    var y = b.py + (b.y - b.py) * alpha;
    if (!Motion.reduced && b.wiggle) x += Math.sin(this.worldT * 42) * b.wiggle * 3;
    if (this.tutStep === 0 && this.state === 'playing' &&
        this._ringSet && this._ringSet[b.id]) {
      this.ctx.strokeStyle = 'rgba(255,215,94,0.8)';
      this.ctx.lineWidth = 3;
      this.ctx.beginPath(); this.ctx.arc(x, y, inkR(b) + 4, 0, 6.283); this.ctx.stroke();
    }
    if (_hints && this.state === 'playing') {
      var so = this._focusedOrder();
      if (so && (so.need[b.key] || 0) > this._bagCount(b.key)) {
        var reach = this._expo && this._expo[b.id];
        this.ctx.strokeStyle = reach ? 'rgba(255,215,94,0.85)' : 'rgba(178,142,224,0.34)';
        this.ctx.lineWidth = reach ? 3 : 2;
        this.ctx.setLineDash(reach ? [] : [3, 5]);
        this.ctx.beginPath(); this.ctx.arc(x, y, inkR(b) + 4, 0, 6.283); this.ctx.stroke();
        this.ctx.setLineDash([]);
      }
    }
    if (b.key === 'heartstone') {
      var hs = SPR.gem_heartstone || SPR.gem_prism;
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
      if (this._expo && !this._expo[b.id]) {
        this.ctx.fillStyle = 'rgba(16,10,6,0.34)';
        this.ctx.beginPath(); this.ctx.arc(x, y, inkR(b), 0, 6.283); this.ctx.fill();
      }
      return;
    }
    var sk = bodySpr(b);
    var spr = SPR[sk];
    var sq = Motion.reduced ? 0 : (b.squash || 0);
    if (spr) {
      var d = b.r * sprFit(sk);
      if (sq > 0) {
        ctx.save();
        ctx.translate(x, y + b.r * sq * 0.3);
        ctx.scale(1 + sq * 0.22, 1 - sq * 0.26);
        ctx.drawImage(spr, -d / 2, -d / 2, d, d);
        ctx.restore();
      } else {
        ctx.drawImage(spr, x - d / 2, y - d / 2, d, d);
      }
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
      if (this._expo && !this._expo[b.id]) {
        ctx.fillStyle = 'rgba(16,10,6,0.34)';
        ctx.beginPath(); ctx.arc(x, y, inkR(b), 0, 6.283); ctx.fill();
      }
      if (Meta.data.marks === 1) gemMark(ctx, b.key, x, y, Math.max(3.5, b.r * 0.30));
      if (b.geode) this._crustGlint(x, y, b);
      if (b.shale) this._shaleDust(x, y, b);
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

  Game.prototype._drawPick = function (pk) {
    if (Motion.reduced) return;
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
    if (pk.t > 0.38 && pk.t < 0.62) {
      var im = (0.62 - pk.t) * 4;
      var reach = (pk.heavy ? 15 : 10) * (1.25 - im * 0.5);
      ctx.save();
      ctx.translate(pk.x, pk.y - 4);
      ctx.strokeStyle = 'rgba(255,244,214,' + Math.min(0.85, im).toFixed(2) + ')';
      ctx.lineWidth = pk.heavy ? 2.2 : 1.6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      for (var sk2 = 0; sk2 < 4; sk2++) {
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
    if (Motion.reduced) return;
    var ctx = this.ctx;
    var e = f.t * f.t * (3 - 2 * f.t);
    var x = f.x + (f.tx - f.x) * e;
    var y = f.y + (f.ty - f.y) * e - Math.sin(f.t * 3.1416) * 60;
    var r = f.r * (1 - 0.45 * f.t);
    var spr = SPR[BODY_SPR[f.key]];
    if (spr) {
      var d = r * sprFit(BODY_SPR[f.key]);
      ctx.drawImage(spr, x - d / 2, y - d / 2, d, d);
      return;
    }
    ctx.fillStyle = f.col;
    ctx.beginPath(); ctx.arc(x, y, r, 0, 6.283); ctx.fill();
    ctx.fillStyle = f.hi;
    ctx.beginPath(); ctx.arc(x - r * 0.25, y - r * 0.3, r * 0.35, 0, 6.283); ctx.fill();
  };

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
      var planned = this._focusedOrder() === o;
      var x = 14 + s * (ORDER_W + 8);
      var sway = Motion.reduced ? 0 : Math.sin(this.worldT * 1.15 + s * 1.7) * 0.022
               + (o.flash > 0 ? Math.sin(this.worldT * 14) * 0.05 * o.flash : 0);
      var dropY = !Motion.reduced && o.dropT ? -(o.dropT * o.dropT) * 150 : 0;
      ctx.save();
      ctx.translate(x + ORDER_W / 2, ORDER_Y - 6 + dropY);
      ctx.rotate(sway);
      ctx.translate(-(x + ORDER_W / 2), -(ORDER_Y - 6));
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
      ctx.strokeStyle = planned ? '#79542a' : o.cls === 'timed' ? '#d98a3c' : '#c0ac8a';
      ctx.lineWidth = planned ? 3 : o.cls === 'timed' ? 2 : 1.5;
      rr(ctx, x, ORDER_Y, ORDER_W, ORDER_H, 9); ctx.stroke();
      ctx.fillStyle = o.cls === 'timed' ? '#b0552a' : '#6b5d49';
      ctx.font = fT(10, 'bold');
      ctx.textBaseline = 'top';
      if (o.cls === 'timed') {
        ctx.textAlign = 'left';
        ctx.fillText('RUSH', x + 8, ORDER_Y + 6);
      } else {
        ctx.textAlign = 'center';
        ctx.fillText(planned ? 'PLAN' : 'ORDER', x + ORDER_W / 2, ORDER_Y + 6);
      }
      ctx.textAlign = 'center';
      var keys = Object.keys(o.total);
      var rowH = keys.length > 3 ? 14 : 19;
      var icon = keys.length > 3 ? 13 : 17;
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var gy = ORDER_Y + 22 + i * rowH;
        var spr = SPR[BODY_SPR[key]];
        if (spr) ctx.drawImage(spr, x + 8, gy - 2, icon, icon);
        else {
          ctx.fillStyle = TYPE[key].col;
          ctx.beginPath(); ctx.arc(x + 8 + icon / 2, gy - 2 + icon / 2, icon / 2, 0, 6.283); ctx.fill();
        }
        if (Meta.data.marks === 1) gemMark(ctx, key, x + 8 + icon / 2, gy - 2 + icon / 2, icon * 0.30);
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
      if (planned) {
        ctx.fillStyle = '#79542a'; ctx.beginPath();
        ctx.moveTo(x + ORDER_W / 2 - 5, ORDER_Y + ORDER_H - 4);
        ctx.lineTo(x + ORDER_W / 2, ORDER_Y + ORDER_H + 3);
        ctx.lineTo(x + ORDER_W / 2 + 5, ORDER_Y + ORDER_H - 4);
        ctx.closePath(); ctx.fill();
      }
      if (o.cls === 'timed' && o.expiresAt < Infinity) {
        var remain = Math.max(0, o.expiresAt - this.worldT);
        var frac = Math.max(0, Math.min(1, remain / CFG.timedDur));
        var urgent = remain <= 12;
        var kcol = remain <= 6 ? '#e2402c' : urgent ? '#e8843c' : '#d9a44c';
        var kx = x + ORDER_W - 14, ky = ORDER_Y + 10;
        if (urgent) {
          var beat = Motion.reduced ? 0.5 : 0.5 + 0.5 * Math.sin(this.worldT * (remain <= 6 ? 11 : 7));
          ctx.strokeStyle = kcol;
          ctx.globalAlpha = 0.35 + beat * 0.5;
          ctx.lineWidth = 2.5;
          rr(ctx, x - 2, ORDER_Y - 2, ORDER_W + 4, ORDER_H + 4, 10); ctx.stroke();
          ctx.globalAlpha = 1;
        }
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
      if (this.tossFlash > 0 && this.tossSlot === i) {
        var tf = this.tossFlash, grow = Motion.reduced ? 0 : (1 - tf) * 7;
        ctx.strokeStyle = 'rgba(226,75,74,' + (0.75 * tf).toFixed(2) + ')';
        ctx.lineWidth = 2;
        rr(ctx, x - grow, BAG_Y - grow, BAG_SLOT + grow * 2, BAG_SLOT + grow * 2, 7 + grow);
        ctx.stroke();
      }
      if (i < this.bag.length) {
        var spr = SPR[BODY_SPR[this.bag[i]]];
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
    var plan = this._orderPlan(), full = this.bag.length >= this.bagCap;
    if (plan) {
      ctx.fillStyle = full ? '#f0a090' : '#ffe9a8'; ctx.textAlign = 'center';
      fitT(ctx, 'PLAN ' + (plan.slot + 1) + ': ' + plan.have + '/' + plan.total + ' in bag'
        + (full ? ' · bag full, tap a gem to toss' : ' · ' + plan.missing + ' still needed'),
        VIEW_MIN_W / 2, BAG_Y + BAG_SLOT + 4, 370, 10, 'bold');
    } else if (full) {
      ctx.fillStyle = '#f0a090'; ctx.textAlign = 'center';
      ctx.fillText('BAG FULL: tap a gem to toss it', VIEW_MIN_W / 2, BAG_Y + BAG_SLOT + 4);
    } else {
      ctx.fillStyle = 'rgba(232,220,200,0.5)'; ctx.textAlign = 'left';
      ctx.fillText('BAG', bagSlotX(0) - 32, BAG_Y + 9);
    }
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  };

  Game.prototype._hud = function () {
    var ctx = this.ctx;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'right';
    ctx.fillStyle = '#ffd75e'; ctx.font = fD(20);
    ctx.fillText(String(Math.round(this.displayCoins)), VIEW_MIN_W - 40, 4);
    drawCoin(ctx, VIEW_MIN_W - 25, 15, 10);
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
    var bandY = this._counter ? this._counter.y + 42 : VIEW_H - 130;
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
    if (coachOn) {
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(20,14,10,0.82)';
      rr(ctx, VIEW_MIN_W / 2 - 168, bandY - 34, 336, 28, 8); ctx.fill();
      ctx.fillStyle = '#ffe9a8'; ctx.font = fT(12, 'bold');
      ctx.textBaseline = 'middle';
      var msg = this.tutStep === 0 ? 'Dig from the top. Crack sparkly rocks for gems.'
              : this.tutStep === 1 ? 'Tap an order to plan. Fill its full set to earn coins.'
              : 'Need space? Tap a bagged gem to toss it away.';
      ctx.fillText(msg, VIEW_MIN_W / 2, bandY - 20);
      ctx.textBaseline = 'top';
    }
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
    ctx.fillStyle = this.swings <= 5 ? '#f0a090' : 'rgba(232,220,200,0.85)';
    ctx.font = fT(12, 'bold');
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(Math.max(0, this.swings)), 143, 22.5);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
  };

  Game.prototype._layoutCounter = function () {
    var v = this.view;
    var y = JAR.bot + 10;
    var h = Math.max(0, (v.floorY || VIEW_H) - y);
    this._counter = { y: y, h: h, compact: h < 84, l: -v.ox, r: v.w - v.ox };
    return this._counter;
  };

  Game.prototype._drawCounter = function () {
    var ctx = this.ctx, c = this._layoutCounter();
    if (c.h <= 8) return;
    var w = c.r - c.l;

    var g = ctx.createLinearGradient(0, c.y, 0, c.y + c.h);
    g.addColorStop(0, 'rgba(96,64,38,0.96)');
    g.addColorStop(0.10, 'rgba(74,48,29,0.96)');
    g.addColorStop(1, 'rgba(34,22,14,0.98)');
    ctx.fillStyle = g;
    ctx.fillRect(c.l, c.y, w, c.h);
    ctx.fillStyle = 'rgba(214,168,104,0.55)';
    ctx.fillRect(c.l, c.y, w, 3);
    ctx.fillStyle = 'rgba(0,0,0,0.30)';
    ctx.fillRect(c.l, c.y + 3, w, 4);
    ctx.strokeStyle = 'rgba(20,12,6,0.35)'; ctx.lineWidth = 1;
    for (var pk = 1; pk < 4; pk++) {
      var px = c.l + (w / 4) * pk;
      ctx.beginPath(); ctx.moveTo(px, c.y + 7); ctx.lineTo(px, c.y + c.h); ctx.stroke();
    }

    this._drawHoardLedge(c);
    this._drawPace(c);
    if (this.state !== 'results') this._drawGear(c);
  };

  Game.prototype._drawHoardLedge = function (c) {
    var ctx = this.ctx;
    var total = Meta.data.hoardTotal;
    var ds = (c.compact ? 54 : 74) + Math.sqrt(total) * (c.compact ? 1.6 : 3.2);
    if (!Motion.reduced && this.dragonPulse) ds *= 1 + this.dragonPulse * 0.12;
    ds = Math.min(ds, c.h - 6);
    var base = c.y + c.h - (c.compact ? 4 : 10);
    var dx = c.l + 10;
    if (total >= 20) {
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
    var n = Math.min(total, 24);
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
    this._dragonRect = { x: dx, y: base - ds, w: ds, h: ds };
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

  Game.prototype._minSwingsLeft = function () {
    return Math.ceil(this._gemsOwed() / 2);
  };

  Game.prototype._drawPace = function (c) {
    var ctx = this.ctx;
    var left = Math.max(0, this.goalOrders - this.ordersDone);
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
    fitD(ctx, left === 0 ? 'ALL FILLED'
               : dead ? "can't fill " + left + ' more'
               : this.swings + ' swings · ' + left + (left === 1 ? ' order' : ' orders'),
               cx, cy + 2, c.compact ? 210 : 220, c.compact ? 15 : 19);
    if (!c.compact || dead) {
      ctx.fillStyle = 'rgba(232,220,200,0.5)';
      ctx.font = fT(11);
      ctx.fillText(left === 0 ? 'cash out the leftovers'
                 : dead ? this.swings + ' swings left · dig rock for coins'
                 : ok ? 'comfortably ahead' : tight ? 'on the line' : 'behind: pick your gems',
                 cx, cy + (c.compact ? 13 : 20));
    }
  };

  Game.prototype._drawGear = function (c) {
    this._drawGearAt(this.gearRect());
  };

  Game.prototype._drawGearAt = function (b, menuChrome) {
    var ctx = this.ctx;
    var ta = ctx.textAlign, tb = ctx.textBaseline;
    if (menuChrome) menuChromePlate(ctx, b);
    else {
    ctx.fillStyle = 'rgba(20,12,6,0.45)';
    rr(ctx, b.x, b.y, b.w, b.h, 10); ctx.fill();
    ctx.strokeStyle = 'rgba(201,168,106,0.35)'; ctx.lineWidth = 1;
    rr(ctx, b.x, b.y, b.w, b.h, 10); ctx.stroke();
    }
    var cx = b.x + b.w / 2, cy = b.y + b.h / 2, R = Math.min(b.w, b.h) * (menuChrome ? 0.21 : 0.28);
    ctx.fillStyle = menuChrome ? '#e4c78d' : 'rgba(232,220,200,0.82)';
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
    ctx.moveTo(cx + R * 0.44, cy);
    ctx.arc(cx, cy, R * 0.44, 0, Math.PI * 2, true);
    ctx.fill('evenodd');
    ctx.textAlign = ta; ctx.textBaseline = tb;
  };

  var SET_ROW_H = 52, SET_GAP = 8, SET_HEAD = 56, SET_PAD = 18, SET_FOOT = 40, SET_W = 300;
  Game.prototype.settingsRects = function () {
    var inShift = this.state === 'paused' || this.state === 'playing';
    var canRestore = Store.available() && !Ent.owned();
    var ids = inShift ? ['music', 'sound', 'hints', 'marks', 'help', 'resume', 'quit']
                      : ['music', 'sound', 'hints', 'marks', 'help']
                          .concat(canRestore ? ['restore'] : [])
                          .concat(['privacy', 'done']);
    if (Hap.available()) ids.splice(2, 0, 'haptics');
    var gap = ids.length > 8 ? 4 : SET_GAP;
    var ph = SET_HEAD + SET_PAD + ids.length * SET_ROW_H + 96 + (ids.length - 1) * gap + SET_FOOT;
    var px = VIEW_MIN_W / 2 - SET_W / 2;
    var py = Math.round(VIEW_H / 2 - ph / 2);
    var out = {
      panel: { x: px, y: py, w: SET_W, h: ph },
      close: { x: px + SET_W - 56, y: py + 6, w: 50, h: 50 },
      rows: [],
    };
    var rowY = py + SET_HEAD + SET_PAD;
    for (var i = 0; i < ids.length; i++) {
      var audio = ids[i] === 'music' || ids[i] === 'sound';
      out.rows.push({
        id: ids[i], x: px + 20, y: rowY,
        w: SET_W - 40, h: audio ? 100 : SET_ROW_H,
      });
      rowY += (audio ? 100 : SET_ROW_H) + gap;
    }
    return out;
  };

  function audioSettingRects(r) {
    return {
      toggle: { x: r.x, y: r.y, w: r.w, h: 50 },
      less: { x: r.x, y: r.y + 50, w: 50, h: 50 },
      more: { x: r.x + r.w - 50, y: r.y + 50, w: 50, h: 50 },
    };
  }

  Game.prototype.openSettings = function () {
    this.showSettings = true;
    this._quitArmed = 0;
    if (this.state === 'playing') this.setPaused(true);
  };
  Game.prototype.closeSettings = function () {
    this.showSettings = false;
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

    ctx.fillStyle = 'rgba(232,220,200,0.65)'; ctx.font = fD(20);
    ctx.fillText('✕', R.close.x + R.close.w / 2, R.close.y + 14);

    for (var i = 0; i < R.rows.length; i++) {
      var r = R.rows[i];
      if (r.id === 'music' || r.id === 'sound' || r.id === 'haptics' || r.id === 'hints' || r.id === 'marks') {
        var on = r.id === 'music' ? !Snd.musicMuted
               : r.id === 'sound' ? !Snd.sfxMuted
               : r.id === 'haptics' ? Hap.enabled()
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
                   : r.id === 'haptics' ? 'Haptics'
                   : r.id === 'hints' ? 'Hints in the jar'
                   : 'Gem symbols', r.x + 16, r.y + 17);
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
        if (r.id === 'music' || r.id === 'sound') {
          var ar = audioSettingRects(r), level = r.id === 'music' ? Snd.musicVolume : Snd.sfxVolume;
          ctx.strokeStyle = 'rgba(201,168,106,0.20)';
          ctx.beginPath(); ctx.moveTo(r.x + 12, r.y + 50); ctx.lineTo(r.x + r.w - 12, r.y + 50); ctx.stroke();
          ctx.font = fD(25); ctx.fillStyle = level > 0 ? '#ffe9a8' : 'rgba(232,220,200,0.35)';
          ctx.fillText('−', ar.less.x + 25, ar.less.y + 12);
          ctx.fillStyle = level < 1 ? '#ffe9a8' : 'rgba(232,220,200,0.35)';
          ctx.fillText('+', ar.more.x + 25, ar.more.y + 12);
          ctx.fillStyle = '#e8dcc8'; ctx.font = fT(13, 'bold');
          ctx.fillText((r.id === 'music' ? 'Music' : 'Sound') + ' volume ' + Math.round(level * 100) + '%', r.x + r.w / 2, r.y + 68);
        }
      } else {
        var armed = r.id === 'quit' && this._quitArmed > nowMs();
        var label = r.id === 'resume' ? 'RESUME'
                  : r.id === 'quit' ? (armed ? 'TAP AGAIN TO QUIT' : 'QUIT SHIFT')
                  : r.id === 'restore' ? (Store.busy ? 'RESTORING\u2026' : 'RESTORE PURCHASE')
                  : r.id === 'privacy' ? 'PRIVACY POLICY'
                  : r.id === 'help' ? 'HOW TO PLAY'
                  : 'DONE';
        this._menuBtn(label, r.y, { w: r.w, h: r.h,
                                    quiet: (r.id === 'quit' && !armed) || r.id === 'restore' || r.id === 'privacy',
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
        Snd.pop();
        Store.restore(function (got) { if (got) { Snd.fanfare(150); Hap.medium(); } });
        return;
      }
      if (r.id === 'privacy') { Snd.pop(); openOutward(PRIVACY_URL); return; }
      if (r.id === 'help') {
        Snd.pop();
        openHelpGuide();
        return;
      }
      if (r.id === 'music' || r.id === 'sound') {
        var ar = audioSettingRects(r), isMusic = r.id === 'music';
        var delta = inRect(w, ar.less) ? -1 : inRect(w, ar.more) ? 1 : 0;
        if (delta) {
          var level = isMusic ? Snd.musicVolume : Snd.sfxVolume;
          var next = Math.max(0, Math.min(10, Math.round(level * 10) + delta)) / 10;
          if (isMusic) Snd.setMusicVolume(next); else Snd.setSfxVolume(next);
        } else if (inRect(w, ar.toggle)) {
          if (isMusic) Snd.setMusicMuted(!Snd.musicMuted); else Snd.setSfxMuted(!Snd.sfxMuted);
        }
        Snd.pop();
      }
      else if (r.id === 'haptics') {
        Meta.setHaptics(!Hap.enabled());
        Snd.pop();
        if (Hap.enabled()) Hap.light(); else Hap.stop();
      }
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
          this.state = this.mode === 'excavation' ? 'fieldnotes' : 'menu';
          Snd.scene('shop');
        } else {
          this._quitArmed = nowMs() + 2600;
          Snd.thunk();
        }
      }
      return;
    }
    if (!inRect(w, R.panel)) { this.closeSettings(); }
  };

  Game.prototype.gearRect = function () {
    var c = this._counter || this._layoutCounter();
    var s = 50;
    return { x: c.r - s - 10, y: c.y + Math.max(6, (c.h - s) / 2), w: s, h: s };
  };

  Game.prototype.choiceRects = function () {
    var cy = JAR.top + 48, h = 50, w = 150;
    return {
      cx: VIEW_MIN_W / 2, cy: cy,
      use:   { x: 8,   y: cy - h / 2, w: w, h: h },
      hoard: { x: 262, y: cy - h / 2, w: w, h: h },
      gutter: { x: 158, y: cy - h / 2, w: 104, h: h },
    };
  };

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

  Game.prototype._drawChoice = function () {
    var ctx = this.ctx, c = this.choice, R = this.choiceRects();
    var cx = R.cx, cy = R.cy;
    var pulse = Motion.reduced ? 1 : 1 + Math.sin(this.worldT * 6) * 0.06;
    var frac = Math.max(0, (c.until - this.worldT) / CHOICE_SECS);
    if (c.slot >= 0) {
      var ox = 14 + c.slot * (ORDER_W + 8);
      ctx.strokeStyle = 'rgba(255,215,94,0.9)'; ctx.lineWidth = 3;
      rr(ctx, ox - 2, ORDER_Y - 2, ORDER_W + 4, ORDER_H + 4, 10); ctx.stroke();
    }
    var dr = this._dragonRect;
    var lgx = dr ? dr.x + dr.w / 2 : 50, lgy = dr ? dr.y + dr.h / 2 : VIEW_H - 70;
    var lgr = dr ? Math.max(46, dr.w * 0.54) : 46;
    ctx.strokeStyle = 'rgba(232,201,255,0.8)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(lgx, lgy, lgr + (Motion.reduced ? 0 : Math.sin(this.worldT * 5) * 4), 0, 6.283); ctx.stroke();
    var heart = c.key === 'heartstone';
    var coinsCount = !this.career ||
                     !(Meta.data.careerStars && Meta.data.careerStars[this.career.level] > 0);
    choicePlate(ctx, R.use,
                heart ? 'SELL' : 'USE IT',
                heart ? (coinsCount ? HEART_SELL + ' coins' : 'no coins on a replay')
                      : 'into your satchel',
                'wood', heart && !coinsCount);
    choicePlate(ctx, R.hoard,
                heart ? 'GIFT' : 'HOARD',
                heart ? '+' + HEART_GIFT + ' hoard' : 'Flint keeps it',
                'hoard', false);
    var spr = (c.key === 'heartstone' && SPR.gem_heartstone) || SPR.gem_prism;
    var d = (c.key === 'heartstone' ? 84 : 52) * pulse;
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.lineWidth = 4;
    ctx.arc(cx, cy, 46, -1.5708, -1.5708 + 6.28318 * frac);
    ctx.stroke();
    if (spr) ctx.drawImage(spr, cx - d / 2, cy - d / 2, d, d);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  };

  var MENU = {
    gear:   { x: VIEW_MIN_W - 64, y: 18, w: 50, h: 50 },
    shop:   { x: VIEW_MIN_W - 164, y: 18, w: 92, h: 50 },
    strip:  { x: VIEW_MIN_W / 2 - 132, y: 382, w: 264, h: 50 },
    career: { x: VIEW_MIN_W / 2 - 132, y: 502, w: 264, h: 60 },
    daily:  { x: VIEW_MIN_W / 2 - 132, y: 572, w: 264, h: 60 },
    free:   { x: VIEW_MIN_W / 2 - 132, y: 642, w: 264, h: 60 },
  };
  var MENU_BOTTOM = 702;
  var MENU_CHROME = { gear: 1, shop: 1 };
  var SHOP_GEAR = { x: VIEW_MIN_W - 64, y: 18, w: 50, h: 50 };

  var LV_COLS = 5, LV_CELL = 52, LV_GAPX = 9, LV_GAPY = 6, LV_TOP = 164;
  var LV_X0 = VIEW_MIN_W / 2 - (LV_COLS * LV_CELL + (LV_COLS - 1) * LV_GAPX) / 2;
  var LEVELS_BACK_Y = 656;
  function levelRect(i) {
    var c = i % LV_COLS, r = (i / LV_COLS) | 0;
    return { x: LV_X0 + c * (LV_CELL + LV_GAPX), y: LV_TOP + r * (LV_CELL + LV_GAPY),
             w: LV_CELL, h: LV_CELL };
  }
  function inRect(w, b) {
    return w.x >= b.x && w.x <= b.x + b.w && w.y >= b.y && w.y <= b.y + b.h;
  }

  var UI_LOCK_MS = 320;
  function uiTick() { Snd.pop(); Hap.light(); }
  function nowMs() {
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now() : Date.now();
  }

  function safeName(s) {
    return /^MOLE-[0-9A-F]{4}$/.test(String(s)) ? String(s) : 'MOLE-????';
  }

  Game.prototype._menuShift = function () {
    var slack = (this.view.floorY || VIEW_H) - MENU_BOTTOM;
    return Math.max(0, Math.min(72, Math.round(slack / 2)));
  };
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


  function menuChromePlate(ctx, b) {
    ctx.save();
    var grad = ctx.createLinearGradient(0, b.y, 0, b.y + b.h);
    grad.addColorStop(0, '#4d3523'); grad.addColorStop(1, '#261910');
    ctx.shadowColor = 'rgba(0,0,0,0.28)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 2;
    ctx.fillStyle = grad; rr(ctx,b.x,b.y,b.w,b.h,12); ctx.fill();
    ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    ctx.strokeStyle = 'rgba(221,181,111,0.64)'; ctx.lineWidth = 1.25;
    rr(ctx,b.x+.5,b.y+.5,b.w-1,b.h-1,11.5); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,233,168,0.10)';
    rr(ctx,b.x+3,b.y+3,b.w-6,b.h-6,9); ctx.stroke();
    ctx.restore();
  }
  function menuShopIcon(ctx, x, y, size) {
    ctx.save();ctx.translate(x,y);ctx.scale(size/24,size/24);
    ctx.strokeStyle='#ffe9a8';ctx.lineWidth=1.8;ctx.lineJoin='round';ctx.lineCap='round';
    ctx.fillStyle='rgba(255,215,94,0.09)';
    ctx.beginPath();ctx.moveTo(-8,-4);ctx.lineTo(8,-4);ctx.lineTo(9,9);
    ctx.quadraticCurveTo(0,11,-9,9);ctx.closePath();ctx.fill();ctx.stroke();
    ctx.beginPath();ctx.moveTo(-4,-3);ctx.lineTo(-4,-7);
    ctx.bezierCurveTo(-4,-13,4,-13,4,-7);ctx.lineTo(4,-3);ctx.stroke();
    ctx.restore();
  }
  function menuJournalIcon(ctx, x, y, size) {
    ctx.save();ctx.translate(x,y);ctx.scale(size/24,size/24);
    ctx.strokeStyle='#ffe9a8';ctx.lineWidth=1.7;ctx.lineJoin='round';ctx.lineCap='round';
    ctx.fillStyle='rgba(255,215,94,0.09)';
    rr(ctx,-8,-10,16,20,2);ctx.fill();ctx.stroke();
    ctx.beginPath();ctx.moveTo(-4,-10);ctx.lineTo(-4,10);ctx.stroke();
    ctx.beginPath();ctx.moveTo(2,-4);ctx.lineTo(5,0);ctx.lineTo(2,4);ctx.lineTo(-1,0);ctx.closePath();ctx.stroke();
    ctx.restore();
  }
  function menuCenteredLabel(ctx, text, x, y, font) {
    ctx.font=font;ctx.textAlign='center';ctx.textBaseline='alphabetic';
    var m=ctx.measureText(text);
    var up=Number.isFinite(m.actualBoundingBoxAscent)?m.actualBoundingBoxAscent:10;
    var down=Number.isFinite(m.actualBoundingBoxDescent)?m.actualBoundingBoxDescent:0;
    ctx.fillText(text,x,y+(up-down)/2);
  }

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
    var vig = ctx.createRadialGradient(cx, 300, VIEW_MIN_W * 0.30, cx, 320, VIEW_H * 0.78);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(8,5,3,0.62)');
    ctx.fillStyle = vig;
    ctx.fillRect(-v.ox, -v.uiTop, v.w, v.h + v.uiTop);

    ctx.textAlign = 'center'; ctx.textBaseline = 'top';

    ctx.save();
    var wallet={x:16,y:18,w:112,h:50}, coins=Meta.data.coins||0;
    menuChromePlate(ctx,wallet);menuChromePlate(ctx,FIELD_HOME);
    menuChromePlate(ctx,MENU.shop);
    drawCoin(ctx,35,44,11);
    ctx.fillStyle='rgba(232,220,200,0.72)';
    menuCenteredLabel(ctx,'COINS',82,31,fT(9,'bold'));
    ctx.fillStyle='#ffd75e';ctx.textBaseline='alphabetic';ctx.font=fN(20);
    fitText(ctx,coins.toLocaleString()+'c',82,55,76,fN,20);
    menuJournalIcon(ctx,192,34,18);
    ctx.fillStyle='#ffe9a8';
    menuCenteredLabel(ctx,'EXCAVATIONS',192,55,fT(10.5,'bold'));
    menuShopIcon(ctx,302,34,19);
    menuCenteredLabel(ctx,'SHOP',302,55,fT(11.5,'bold'));
    this._drawGearAt(MENU.gear, true);
    ctx.restore();
    ctx.textAlign='center';ctx.textBaseline='top';

    var dy = this._menuShift();
    ctx.save();
    ctx.translate(0, dy);

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
    ctx.strokeStyle = 'rgba(201,168,106,0.45)'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx - 96, 156); ctx.lineTo(cx - 12, 156);
    ctx.moveTo(cx + 12, 156); ctx.lineTo(cx + 96, 156);
    ctx.stroke();
    if (SPR.gem_prism) ctx.drawImage(SPR.gem_prism, cx - 9, 147, 18, 18);

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

    var lvl = Meta.data.careerLevel || 1;
    var done = lvl > CAREER_MAX;
    var band0 = Math.floor((Math.min(lvl, CAREER_MAX) - 1) / 5) * 5 + 1;
    var sbx = MENU.strip;
    ctx.fillStyle = 'rgba(20,12,6,0.34)';
    rr(ctx, sbx.x, sbx.y, sbx.w, sbx.h, 14); ctx.fill();
    ctx.strokeStyle = 'rgba(201,168,106,0.3)'; ctx.lineWidth = 1;
    rr(ctx, sbx.x, sbx.y, sbx.w, sbx.h, 14); ctx.stroke();
    var railLeft=sbx.x+30, railRight=sbx.x+sbx.w-50;
    var railY=sbx.y+sbx.h/2;
    ctx.strokeStyle='rgba(201,168,106,0.4)';ctx.lineWidth=2;
    ctx.beginPath();ctx.moveTo(railLeft,railY);ctx.lineTo(railRight,railY);ctx.stroke();
    for (var bi2=0;bi2<5;bi2++) {
      var ln=band0+bi2, nx=railLeft+bi2*(railRight-railLeft)/4;
      var isCur=ln===lvl, done2=ln<lvl;
      ctx.fillStyle=done2?'#c9a86a':isCur?'#ffd75e':'#4f3c2b';
      ctx.beginPath();ctx.arc(nx,railY,isCur?13:11,0,Math.PI*2);ctx.fill();
      ctx.fillStyle=done2||isCur?'#3a2a18':'#d3c0a2';
      menuCenteredLabel(ctx,String(ln),nx,railY,fT(11,'bold'));
      var st2=Math.max(0,Math.min(3,(Meta.data.careerStars||{})[ln]||0));
      for(var si2=0;si2<st2;si2++)
        drawStar(ctx,nx+(si2-(st2-1)/2)*7,railY+18,2.5,'#ffd75e');
    }
    var arrowX=sbx.x+sbx.w-18;
    ctx.strokeStyle='#d3b780';ctx.lineWidth=1.7;ctx.lineCap='round';ctx.lineJoin='round';
    ctx.beginPath();ctx.moveTo(arrowX-2.5,railY-4);
    ctx.lineTo(arrowX+2.5,railY);ctx.lineTo(arrowX-2.5,railY+4);ctx.stroke();
    ctx.textAlign='center';ctx.textBaseline='top';

    var day = dayNumber();
    var best = Meta.data.bestDaily[day] || 0;
    var rcard = this.recordsRects().card;
    ctx.fillStyle = 'rgba(30,20,12,0.72)';
    rr(ctx, rcard.x, rcard.y, rcard.w, rcard.h, 12); ctx.fill();
    ctx.strokeStyle = 'rgba(201,168,106,0.5)'; ctx.lineWidth = 1.5;
    rr(ctx, rcard.x, rcard.y, rcard.w, rcard.h, 12); ctx.stroke();
    ctx.fillStyle = '#ffd75e'; ctx.font = fT(13, 'bold');
    fitT(ctx, best > 0 ? ("today's best: " + best.toLocaleString() + 'c') : "today's daily dig awaits",
         cx - 44, 448, 130, 13, 'bold');
    ctx.fillStyle = '#e8c9ff'; ctx.font = fT(12);
    var hrk = hoardRank(Meta.data.hoardTotal);
    fitT(ctx, hrk
      ? hrk.name + ' · ' + Meta.data.hoardTotal + '/' + hrk.next
      : 'hoard: ' + Meta.data.hoardTotal + ' gems', cx - 44, 466, 130, 12);
    var mdrag = dragonImage();
    if (mdrag) ctx.drawImage(mdrag, cx + 32, 447, 32, 32);
    ctx.fillStyle = 'rgba(232,201,255,0.7)'; ctx.font = fT(12, 'bold');
    ctx.fillText('SCORES', cx + 100, 452, 48);
    ctx.fillStyle = 'rgba(255,215,94,0.8)'; ctx.font = fT(14, 'bold');
    ctx.fillText('\u203A', cx + 100, 464);

    var totalStars = 0;
    if (Meta.data.careerStars) {
      for (var sk in Meta.data.careerStars) totalStars += Meta.data.careerStars[sk];
    }
    var firstRun = !Meta.data.tutorialDone;
    this._menuBtn(done ? 'CAREER · COMPLETE' : 'CAREER · LEVEL ' + lvl, MENU.career.y, {
      w: MENU.career.w, h: MENU.career.h, tone: 'career', icon: 'gem_ruby',
      sub: firstRun ? 'START HERE · the mole shows you the ropes'
         : done ? 'every level cleared · replay the finale'
                : 'the mole’s job ladder · ★ ' + totalStars + '/' + (CAREER_MAX * 3),
    });
    var todayChar = dailyCharacter(dayNumber());
    this._menuBtn('DAILY DIG', MENU.daily.y, {
      w: MENU.daily.w, h: MENU.daily.h, tone: 'daily', icon: 'gem_sapphire',
      disabled: firstRun,
      sub: firstRun ? 'finish the Career lesson to unlock'
                    : todayChar.name + ' · one jar, everyone',
    });
    this._menuBtn('FREE DIG', MENU.free.y, {
      w: MENU.free.w, h: MENU.free.h, tone: 'free', icon: 'gem_emerald',
      quiet: firstRun,
      sub: 'a fresh jar · banks coins every shift',
    });
    ctx.restore();
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  };

  function padHitUp(r, h) {
    h = h || 50;
    return { x: r.x, y: r.y - (h - r.h), w: r.w, h: h };
  }
  var _skinPrev = {};
  var _pickPrev = {};
  function skinPreview(sk) {
    var base = SPR.dragon;
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
  function shopCatalog(tab) {
    return tab === 'dragon' ? DRAGON_SKINS : tab === 'pick' ? PICK_SKINS : WALL_SKINS;
  }
  function shopItemState(tab, item) {
    tab = tab === 'dragon' || tab === 'pick' ? tab : 'walls';
    var list = shopCatalog(tab);
    item = list.filter(function (sk) { return item && sk.id === item.id; })[0] || list[0];
    var have = tab === 'walls' ? (Meta.data.coins || 0) : tab === 'dragon' ? (Meta.data.hoardTotal || 0) : starTotal();
    var need = tab === 'walls' ? item.price : tab === 'dragon' ? (item.rank < 0 ? 0 : 20 + item.rank * HOARD_STEP) : item.stars;
    var owned = tab === 'walls' ? item.price === 0 || !!(Meta.data.owned && Meta.data.owned[item.id])
      : tab === 'dragon' ? dragonUnlocked(item) : pickUnlocked(item);
    var eq = tab === 'walls' ? equippedWallId() : tab === 'dragon' ? equippedDragonId() : equippedPickId();
    var equipped = item.id === eq, afford = have >= need;
    var label = equipped ? 'Equipped' : owned ? 'Equip'
      : tab === 'walls' ? (afford ? 'Buy for ' + need.toLocaleString() + ' coins' : 'Need ' + (need - have).toLocaleString() + ' more coins')
      : 'Unlock at ' + need + (tab === 'dragon' ? ' hoard' : ' stars');
    return { item: item, id: item.id, name: item.name, owned: owned, equipped: equipped,
      unlocked: owned, afford: afford, have: have, need: need, actionLabel: label,
      canAct: !equipped && (owned || tab === 'walls' && afford) };
  }
  Game.prototype.shopSelection = function () {
    var tab = this.shopTab === 'dragon' || this.shopTab === 'pick' ? this.shopTab : 'walls';
    var list = shopCatalog(tab), selected = this._shopSelections && this._shopSelections[tab];
    return list.filter(function (sk) { return sk.id === selected; })[0]
      || list.filter(function (sk) { return shopItemState(tab, sk).equipped; })[0] || list[0];
  };
  Game.prototype.selectShopItem = function (id) {
    var tab = this.shopTab === 'dragon' || this.shopTab === 'pick' ? this.shopTab : 'walls';
    var item = shopCatalog(tab).filter(function (sk) { return sk.id === id; })[0];
    if (!item) return false;
    this._shopSelections = this._shopSelections || {};
    this._shopSelections[tab] = item.id;
    return true;
  };
  Game.prototype.activateShopItem = function () {
    if (this._shopActionBusy) return false;
    var tab = this.shopTab === 'dragon' || this.shopTab === 'pick' ? this.shopTab : 'walls';
    var st = shopItemState(tab, this.shopSelection());
    if (!st.canAct) return false;
    this._shopActionBusy = true;
    try {
      if (tab === 'walls' && !st.owned) {
        Meta.data.coins -= st.need;
        Meta.data.owned = Meta.data.owned || {};
        Meta.data.owned[st.id] = 1;
        Snd.fanfare(150);
      } else uiTick();
      Meta.data.equipped = Meta.data.equipped || {};
      Meta.data.equipped[tab === 'walls' ? 'wall' : tab] = st.id;
      Meta.save();
      if (tab === 'dragon') this.dragonPulse = 1;
      this._uiLockUntil = nowMs() + UI_LOCK_MS;
      return true;
    } finally { this._shopActionBusy = false; }
  };
  Game.prototype.shopLayout = function () {
    var tab = this.shopTab === 'dragon' || this.shopTab === 'pick' ? this.shopTab : 'walls';
    var columns = tab === 'dragon' ? 4 : 3, width = tab === 'dragon' ? 85 : 116;
    var tabs = {};
    ['walls', 'dragon', 'pick'].forEach(function (id, i) { tabs[id] = { x: 28 + 124 * i, y: 196, w: 116, h: 58 }; });
    return {
      tabs: tabs, preview: { x: 28, y: 266, w: 364, h: 176 },
      action: { x: 188, y: 368, w: 184, h: 58 },
      cards: shopCatalog(tab).map(function (item, i) {
        return { id: 'shop-item:' + tab + ':' + item.id, item: item,
          rect: { x: 28 + (width + 8) * (i % columns), y: 454 + 86 * Math.floor(i / columns), w: width, h: 78 } };
      }),
      back: { x: 100, y: this._shopBackY(650), w: 220, h: 56 }
    };
  };

  var RECORDS_BACK_Y = 640;
  var REC_TAB_Y = 78, REC_TAB_H = 34, REC_TAB_W = 76, REC_TAB_GAP = 4, REC_TAB_W4 = 96;
  Game.prototype.recordsRects = function () {
    var league = !!this._recLeague;
    var n = league ? 5 : 4;
    var cx = VIEW_MIN_W / 2, W = league ? REC_TAB_W : REC_TAB_W4, G = REC_TAB_GAP;
    var x0 = cx - (W * n + G * (n - 1)) / 2;
    var slot = function (i) { return { x: x0 + (W + G) * i, y: REC_TAB_Y, w: W, h: REC_TAB_H }; };
    var i = 0;
    return {
      backY: RECORDS_BACK_Y,
      card: { x: cx - 132, y: 438, w: 264, h: 50 },
      tabStats:  slot(i++),
      tabBoard:  slot(i++),
      tabLeague: league ? slot(i++) : null,
      tabPast:   slot(i++),
      tabJobs:   slot(i++),
    };
  };

  Game.prototype.leagueOffered = function () { return this._leagueOpen === true; };

  var REC_SETTLE_MS = UI_LOCK_MS;
  Game.prototype._openRecords = function () {
    this.state = 'records';
    this._recOpenedAt = nowMs();
    this._recLeague = this.leagueOffered();
    this.recTab = this.recTab || 'stats';
    if (this.recTab === 'league' && !this._recLeague) this.recTab = 'stats';
    this._loadBoard(false);
    this._loadLeague(false);
  };

  Game.prototype._loadLeague = function (force) {
    var day = dayNumber(), b = this._league;
    if (!force && b && b.day === day && b.clientId === Meta.data.clientId) {
      if (b.state === 'loading' && !fetchStalled(b)) return;
      if (b.state === 'ok' && nowMs() - b.at < 120000) return;
    }
    var mine = this._league = { day: day, clientId: Meta.data.clientId, at: nowMs(), state: 'loading', rows: null, rankState: 'loading', standing: null };
    var self = this;
    Lb.league(12, function (state, rows) {
      if (self._league !== mine || dayNumber() !== day) return;
      mine.state = state;
      mine.rows = rows;
      mine.at = nowMs();
      if (state === 'ok') self._leagueOpen = true;
      else if (state === 'closed') self._leagueOpen = false;
      if (self.state === 'records' && nowMs() - (self._recOpenedAt || 0) < REC_SETTLE_MS) {
        self._recLeague = self.leagueOffered();
        if (!self._recLeague && self.recTab === 'league') self.recTab = 'stats';
      }
    });
    Lb.personal(day, 'league', function (rank) {
      if (self._league !== mine || dayNumber() !== day || Meta.data.clientId !== mine.clientId) return;
      mine.standing = rank; mine.rankState = rank ? 'ok' : 'error';
    });
  };

  var FETCH_PATIENCE = 12000;
  function fetchStalled(b) {
    return !!b && b.state === 'loading' && nowMs() - b.at > FETCH_PATIENCE;
  }

  Game.prototype._loadBoard = function (force) {
    var day = dayNumber(), b = this._board;
    if (!force && b && b.day === day && b.clientId === Meta.data.clientId && b.state !== 'error' && !fetchStalled(b) && nowMs() - b.at < 60000) return;
    var mine = this._board = { day: day, clientId: Meta.data.clientId, at: nowMs(), state: 'loading', rows: null, rankState: 'loading', standing: null };
    var self = this;
    Lb.top(day, 10, function (rows) {
      if (self._board !== mine || dayNumber() !== day) return;
      mine.state = rows ? 'ok' : 'error'; mine.rows = rows || null; mine.at = nowMs();
    });
    Lb.personal(day, 'daily', function (rank) {
      if (self._board !== mine || dayNumber() !== day || Meta.data.clientId !== mine.clientId) return;
      mine.standing = rank; mine.rankState = rank ? 'ok' : 'error';
    });
  };
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
    ctx.fillText(this.recTab === 'board' ? 'DAILY LEADERBOARD' : this.recTab === 'league' ? '14-DAY LEAGUE' : 'RECORDS', cx, 34, 370);

    var R = this.recordsRects();
    var tab = this.recTab || 'stats';
    if (tab === 'league' && !R.tabLeague) tab = 'stats';
    [[R.tabStats, 'YOU', tab === 'stats'],
     [R.tabBoard, 'DAILY', tab === 'board'],
     [R.tabLeague, 'LEAGUE', tab === 'league'],
     [R.tabPast, 'ARCHIVE', tab === 'past'],
     [R.tabJobs, 'JOBS', tab === 'jobs']]
      .filter(function (t) { return !!t[0]; })
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

    var hrk = hoardRank(Meta.data.hoardTotal);
    ctx.fillStyle = '#e8c9ff'; ctx.font = fD(17);
    ctx.fillText(hrk ? hrk.name : 'Keeper of ' + Meta.data.hoardTotal, cx, 126);
    ctx.fillStyle = 'rgba(232,201,255,0.75)'; ctx.font = fT(12);
    ctx.fillText(hrk ? Meta.data.hoardTotal + ' hoarded · next rank at ' + hrk.next
                     : Meta.data.hoardTotal + ' gems hoarded', cx, 148);

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
      ['Best daily', bestEver ? bestEver + 'c' : 'none yet'],
      ['Best free dig', Meta.data.bestFree ? Meta.data.bestFree + 'c' : 'none yet'],
      ['Day streak', (st.streak || 0) + (st.bestStreak > (st.streak || 0)
                      ? '  (best ' + st.bestStreak + ')' : '')],
      ['Shifts worked', st.shifts || 0],
      ['Days dug', st.days || dayCount],
      ['Gems delivered', st.gems || 0],
      ['Crusted rocks cracked', st.crusts || 0],
      ['Heartstones found', st.hearts || 0],
      ['Longest chain', st.bestCombo || 0],
      ['Coins earned', (stats().earned || Meta.data.coins || 0) + 'c'],
      ['In the purse', (Meta.data.coins || 0) + 'c'],
    ];
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

  var JOBS_PER_PAGE = 13;
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

  Game.prototype.jobsPageRect = function () {
    var page = this.jobsPage || 0;
    var rows = Math.min(JOBS_PER_PAGE, Math.max(0, CONTRACTS.length - page * JOBS_PER_PAGE));
    return { x: VIEW_MIN_W / 2 - 100, y: 154 + rows * 33 - 6, w: 200, h: 50 };
  };

  Game.prototype.archiveAction = function () {
    return Ent.owned() ? 'replay' : Store.available() ? 'unlock' : 'history';
  };

  Game.prototype._drawPastTab = function () {
    var ctx = this.ctx, cx = VIEW_MIN_W / 2;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(232,201,255,0.75)'; ctx.font = fT(11);
    var action = this.archiveAction();
    if (action === 'history') {
      ctx.fillText('Archive replay: The Full Burrow for iPhone', cx, 118, 300);
    } else {
      ctx.fillText(action === 'unlock' ? 'unlock The Full Burrow to replay these jars'
                                      : 'past daily jars · no coins, no board', cx, 118, 300);
    }

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
        ctx.fillText(r.best + 'c', cx + 140, y + (action === 'unlock' ? 8 : 15), 70);
        if (action === 'unlock') {
          ctx.font = fT(9, 'bold'); ctx.fillText('Unlock', cx + 140, y + 26, 70);
        }
      } else {
        ctx.fillStyle = 'rgba(201,168,106,0.75)'; ctx.font = fT(11, 'bold');
        ctx.fillText(action === 'replay' ? 'dig it' : action === 'unlock' ? 'Unlock' : 'no score', cx + 140, y + 16, 70);
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

  Game.prototype.pastPageRect = function () {
    var page = this.pastPage || 0;
    var n = Math.min(PAST_PER_PAGE, Math.max(0, ARCHIVE_DAYS - page * PAST_PER_PAGE));
    return { x: VIEW_MIN_W / 2 - 100, y: PAST_ROW_Y + n * PAST_ROW_H, w: 200, h: 50 };
  };

  Game.prototype._standingText = function (which) {
    var b = which === 'league' ? this._league : this._board;
    var r = b && b.day === dayNumber() && b.clientId === Meta.data.clientId && b.standing;
    if (r && r.hasScore) return 'your rank: ' + r.rank + ' of ' + r.participantCount + ' · ' + r.score + 'c';
    if (which === 'league') return r ? 'no posted daily score in this fortnight yet' : 'your league rank is unavailable';
    var best = Meta.data.bestDaily[dayNumber()] || 0;
    var queued = Meta.data.pendingScore && Meta.data.pendingScore.day === dayNumber();
    if (best > 0) return 'your best today: ' + best + 'c' + (queued ? ' · waiting to post' : r ? ' · not posted yet' : ' · rank unavailable');
    return r ? 'no posted score today · try the daily dig' : 'you have not dug today';
  };

  Game.prototype._drawStanding = function (which, y) {
    this.ctx.textAlign = 'center'; this.ctx.fillStyle = 'rgba(232,201,255,0.8)'; this.ctx.font = fT(12);
    this.ctx.fillText(this._standingText(which), VIEW_MIN_W / 2, y, 300);
  };

  Game.prototype._drawLeagueTab = function () {
    if (!this._league || this._league.day !== dayNumber() || this._league.clientId !== Meta.data.clientId) this._loadLeague(false);
    var ctx = this.ctx, cx = VIEW_MIN_W / 2, b = this._league;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';

    if (!b || (b.state === 'loading' && !fetchStalled(b))) {
      ctx.fillStyle = 'rgba(232,220,200,0.6)'; ctx.font = fT(13);
      ctx.fillText('counting the fortnight…', cx, 300);
      this._drawStanding('league', 348);
      return;
    }
    if (fetchStalled(b)) {
      ctx.fillStyle = 'rgba(232,220,200,0.6)'; ctx.font = fT(13);
      ctx.fillText('the league is out of reach right now', cx, 292);
      ctx.fillStyle = 'rgba(232,220,200,0.4)'; ctx.font = fT(11);
      ctx.fillText('tap the tab again to retry', cx, 314);
      this._drawStanding('league', 348);
      return;
    }
    if (b.state === 'error' || b.state === 'closed') {
      ctx.fillStyle = 'rgba(232,220,200,0.6)'; ctx.font = fT(13);
      ctx.fillText('the league is out of reach right now', cx, 292);
      ctx.fillStyle = 'rgba(232,220,200,0.4)'; ctx.font = fT(11);
      ctx.fillText('tap the tab again to retry', cx, 314);
      this._drawStanding('league', 348);
      return;
    }
    var rows = b.rows || [];
    if (!rows.length) {
      ctx.fillStyle = 'rgba(232,220,200,0.6)'; ctx.font = fT(13);
      ctx.fillText('no digs in the last fortnight', cx, 292);
      ctx.fillStyle = '#ffd75e'; ctx.font = fT(13, 'bold');
      ctx.fillText('a daily dig starts your run', cx, 316);
      this._drawStanding('league', 348);
      return;
    }

    ctx.fillStyle = 'rgba(232,201,255,0.75)'; ctx.font = fT(11);
    ctx.fillText('TOP 12 · daily bests of the last 14 days', cx, 118, 300);

    var rank = 0, previousScore = null;
    var y = 140, H = 32;
    for (var i = 0; i < rows.length && i < 12; i++) {
      if (rows[i].total !== previousScore) rank = i + 1;
      previousScore = rows[i].total;
      ctx.fillStyle = i % 2 ? 'rgba(20,12,6,0.30)' : 'rgba(20,12,6,0.48)';
      rr(ctx, cx - 150, y, 300, H - 4, 8); ctx.fill();

      ctx.textAlign = 'left';
      ctx.fillStyle = rank <= 3 ? '#ffd75e' : 'rgba(240,226,200,0.55)';
      ctx.font = fT(12, 'bold');
      ctx.fillText(String(rank), cx - 140, y + 8, 22);
      ctx.fillStyle = 'rgba(240,226,200,0.9)';
      ctx.font = fT(12);
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
    this._drawStanding('league', y + 8);
  };
  Game.prototype._drawBoardTab = function () {
    if (!this._board || this._board.day !== dayNumber() || this._board.clientId !== Meta.data.clientId) this._loadBoard(false);
    var ctx = this.ctx, cx = VIEW_MIN_W / 2;
    var b = this._board;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';

    if (!b || (b.state === 'loading' && !fetchStalled(b))) {
      ctx.fillStyle = 'rgba(232,220,200,0.6)'; ctx.font = fT(13);
      ctx.fillText('reading the board…', cx, 300);
      this._drawStanding('board', 348);
      return;
    }
    if (b.state === 'error' || fetchStalled(b)) {
      ctx.fillStyle = 'rgba(232,220,200,0.6)'; ctx.font = fT(13);
      ctx.fillText('the board is out of reach right now', cx, 292);
      ctx.fillStyle = 'rgba(232,220,200,0.4)'; ctx.font = fT(11);
      ctx.fillText('tap the tab again to retry', cx, 314);
      this._drawStanding('board', 348);
      return;
    }
    var rows = b.rows || [];
    if (!rows.length) {
      ctx.fillStyle = 'rgba(232,220,200,0.6)'; ctx.font = fT(13);
      ctx.fillText('nobody has dug today yet', cx, 292);
      ctx.fillStyle = '#ffd75e'; ctx.font = fT(13, 'bold');
      ctx.fillText('be first: the daily jar is the same for everyone', cx, 316);
      this._drawStanding('board', 348);
      return;
    }

    ctx.fillStyle = 'rgba(232,201,255,0.75)'; ctx.font = fT(11);
    ctx.fillText('TOP 10 · equal scores share a rank', cx, 118, 300);
    var rank = 0, previousScore = null;
    var y = 140, H = 34;
    for (var i = 0; i < rows.length && i < 10; i++) {
      if (rows[i].coins !== previousScore) rank = i + 1;
      previousScore = rows[i].coins;
      ctx.fillStyle = i % 2 ? 'rgba(20,12,6,0.30)' : 'rgba(20,12,6,0.48)';
      rr(ctx, cx - 150, y, 300, H - 4, 8); ctx.fill();

      ctx.textAlign = 'left';
      ctx.fillStyle = rank <= 3 ? '#ffd75e' : 'rgba(240,226,200,0.55)';
      ctx.font = fT(13, 'bold');
      ctx.fillText(String(rank), cx - 140, y + 8, 24);
      ctx.fillStyle = 'rgba(240,226,200,0.9)';
      ctx.font = fT(13);
      ctx.fillText(safeName(rows[i].player), cx - 112, y + 8, 150);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#ffd75e'; ctx.font = fT(14, 'bold');
      ctx.fillText((rows[i].coins | 0) + 'c', cx + 140, y + 7, 80);
      y += H;
    }
    ctx.textAlign = 'center';

    this._drawStanding('board', y + 10);
  };
  function shopArt(ctx, tab, item, b) {
    var img=tab==='walls'?gradedWall(item.id)
           :tab==='dragon'?skinPreview(item)
           :tintCutout(SPR.prop_pickaxe,item,_pickPrev,item.id);
    if(!img)return;
    ctx.save();
    if(tab==='walls'){
      rr(ctx,b.x,b.y,b.w,b.h,8);ctx.clip();
      var scale=Math.max(b.w/img.width,b.h/img.height);
      ctx.drawImage(img,b.x+(b.w-img.width*scale)/2,b.y+(b.h-img.height*scale)/2,img.width*scale,img.height*scale);
    }else{
      var crop=tab==='dragon'?[47/320,24/320,238/320,271/320]:[37/256,17/256,184/256,222/256];
      var sx=crop[0]*img.width,sy=crop[1]*img.height,sw=crop[2]*img.width,sh=crop[3]*img.height;
      var fit=Math.min(b.w/sw,b.h/sh),dw=sw*fit,dh=sh*fit;
      ctx.drawImage(img,sx,sy,sw,sh,b.x+(b.w-dw)/2,b.y+(b.h-dh)/2,dw,dh);
    }
    ctx.restore();
  }
  function shopLabel(ctx,text,x,y,font,color){
    ctx.save();ctx.fillStyle=color||'#ffe9a8';menuCenteredLabel(ctx,text,x,y,font);ctx.restore();
  }
  function shopLock(ctx,x,y){
    ctx.save();ctx.strokeStyle='#c7b28f';ctx.lineWidth=1.3;ctx.lineCap='round';
    rr(ctx,x-4,y-1,8,7,1.4);ctx.stroke();
    ctx.beginPath();ctx.moveTo(x-2.5,y-1);ctx.lineTo(x-2.5,y-3);
    ctx.bezierCurveTo(x-2.5,y-7,x+2.5,y-7,x+2.5,y-3);ctx.lineTo(x+2.5,y-1);ctx.stroke();
    ctx.restore();
  }
  function shopCheck(ctx,x,y){
    ctx.save();ctx.strokeStyle='#ffd75e';ctx.lineWidth=1.7;ctx.lineCap='round';ctx.lineJoin='round';
    ctx.beginPath();ctx.moveTo(x-4,y);ctx.lineTo(x-1,y+3);ctx.lineTo(x+5,y-4);ctx.stroke();ctx.restore();
  }
  function shopPlate(ctx,b,selected){
    ctx.save();
    var fill=ctx.createLinearGradient(0,b.y,0,b.y+b.h);
    fill.addColorStop(0,selected?'#58422b':'#35271b');
    fill.addColorStop(1,selected?'#332417':'#21180f');
    ctx.fillStyle=fill;rr(ctx,b.x,b.y,b.w,b.h,12);ctx.fill();
    ctx.strokeStyle=selected?'#eac675':'rgba(197,158,98,0.46)';ctx.lineWidth=selected?2:1.2;
    rr(ctx,b.x+.5,b.y+.5,b.w-1,b.h-1,11.5);ctx.stroke();
    ctx.restore();
  }
  Game.prototype._drawShop = function () {
    var ctx=this.ctx,v=this.view,cx=VIEW_MIN_W/2;
    var tab=this.shopTab||'walls',layout=this.shopLayout(),item=this.shopSelection();
    var info=shopItemState(tab,item),catalog=shopCatalog(tab);
    ctx.save();ctx.textAlign='center';ctx.textBaseline='top';
    ctx.fillStyle='#21170f';ctx.fillRect(-v.ox,-v.uiTop,v.w,v.h+v.uiTop);
    var bg=SPR.backdrop_burrow;
    if(bg){
      var cover=Math.max(v.w/bg.width,v.h/bg.height);
      ctx.globalAlpha=.17;
      ctx.drawImage(bg,-v.ox+(v.w-bg.width*cover)/2,-v.uiTop,bg.width*cover,bg.height*cover);
      ctx.globalAlpha=1;
    }
    ctx.fillStyle='#ffe9a8';ctx.font=fD(28);
    ctx.fillText("THE MOLE'S SHOP",cx,83,VIEW_MIN_W-48);
    ctx.fillStyle='#c8b89b';ctx.font=fT(12);
    ctx.fillText('Choose a look. Your dig stays the same.',cx,122,VIEW_MIN_W-48);
    this._drawGearAt(SHOP_GEAR,true);

    var balance={x:cx-106,y:146,w:212,h:38};
    ctx.fillStyle='rgba(14,9,5,0.64)';rr(ctx,balance.x,balance.y,balance.w,balance.h,10);ctx.fill();
    ctx.strokeStyle='rgba(206,166,96,.44)';ctx.lineWidth=1;ctx.stroke();
    var balanceLabel=tab==='walls'?'SAVED COINS':tab==='dragon'?'DRAGON HOARD':'CAREER STARS';
    var balanceValue=tab==='walls'?(Meta.data.coins||0).toLocaleString()
                 :tab==='dragon'?(Meta.data.hoardTotal||0).toLocaleString()+' gems'
                 :starTotal()+' / '+(CAREER_MAX*3);
    ctx.font=fT(9,'bold');var balanceLabelW=ctx.measureText(balanceLabel).width;
    ctx.font=fN(17);var balanceTextW=Math.min(148,Math.max(balanceLabelW,ctx.measureText(balanceValue).width));
    var balanceLeft=cx-(32+balanceTextW)/2;
    var balanceIconX=balanceLeft+12,balanceTextX=balanceLeft+32+balanceTextW/2;
    if(tab==='walls')drawCoin(ctx,balanceIconX,165,11);
    else if(tab==='dragon')shopArt(ctx,'dragon',DRAGON_SKINS[0],{x:balanceIconX-13,y:152,w:26,h:26});
    else drawStar(ctx,balanceIconX,165,11,'#e5c36f');
    ctx.textAlign='center';ctx.fillStyle='#c8b89b';ctx.font=fT(9,'bold');
    ctx.fillText(balanceLabel,balanceTextX,151);
    ctx.fillStyle=tab==='dragon'?'#e2c7ec':'#f4d57e';
    fitText(ctx,balanceValue,balanceTextX,163,148,fN,17);
    ['walls','dragon','pick'].forEach(function(kind){
      var b=layout.tabs[kind];shopPlate(ctx,b,kind===tab);
      var first=shopCatalog(kind)[0];
      shopArt(ctx,kind,first,{x:b.x+b.w/2-15,y:b.y+6,w:30,h:27});
      shopLabel(ctx,kind==='walls'?'WALLS':kind==='dragon'?'DRAGON':'PICKAXES',
                b.x+b.w/2,b.y+45,fT(11.5,'bold'),kind===tab?'#ffe9a8':'#d5c4a6');
    });

    var p=layout.preview;
    shopPlate(ctx,p,true);
    var halo=ctx.createRadialGradient(105,349,8,105,349,82);
    halo.addColorStop(0,tab==='dragon'?'rgba(182,130,213,.22)':'rgba(235,185,86,.19)');
    halo.addColorStop(1,'rgba(235,185,86,0)');
    ctx.fillStyle=halo;ctx.fillRect(p.x+4,p.y+4,150,p.h-8);
    shopArt(ctx,tab,item,{x:43,y:282,w:124,h:140});
    if(tab==='walls'){
      ctx.strokeStyle='rgba(239,204,139,.58)';ctx.lineWidth=1.3;rr(ctx,43,282,124,140,8);ctx.stroke();
    }
    ctx.textAlign='left';ctx.textBaseline='top';
    ctx.fillStyle='#fff0cc';fitD(ctx,item.name,188,279,184,21);
    ctx.fillStyle='#d3c2a3';
    fitT(ctx,tab==='walls'?(item.note||'A new backdrop for your jar')
           :tab==='dragon'?'A new color for Flint'
           :'A new finish for your pick',188,310,184,11.5);
    var requirement=info.equipped?'Currently equipped':info.owned?'Unlocked · ready to equip'
      :tab==='walls'?item.price.toLocaleString()+' saved coins'
      :tab==='dragon'?'Keep '+info.need+' gems to unlock'
      :'Earn '+info.need+' career stars';
    ctx.fillStyle=info.equipped?'#f2d27d':'#d3c2a3';
    fitT(ctx,requirement,188,332,184,11.5,'bold');
    if(!info.owned&&info.need>0){
      var ratio=Math.max(0,Math.min(1,info.have/info.need));
      ctx.fillStyle='#1a110a';rr(ctx,188,354,184,4,2);ctx.fill();
      if(ratio>0){ctx.fillStyle=tab==='dragon'?'#c7a4d9':'#deb96b';rr(ctx,188,354,184*ratio,4,2);ctx.fill();}
    }
    var action=layout.action;
    shopPlate(ctx,action,info.canAct);
    if(info.canAct){
      ctx.fillStyle='rgba(242,202,112,.10)';rr(ctx,action.x+3,action.y+3,action.w-6,action.h-6,9);ctx.fill();
    }
    var actionText=info.equipped?'EQUIPPED':info.owned?'EQUIP'
      :tab==='walls'&&info.afford?'BUY · '+info.need.toLocaleString()+' COINS'
      :tab==='walls'?'NEED '+Math.max(0,info.need-info.have).toLocaleString()+' MORE'
      :'NOT YET UNLOCKED';
    shopLabel(ctx,actionText,action.x+action.w/2,action.y+action.h/2,fT(12,'bold'),
              info.canAct?'#ffe9a8':info.equipped?'#e4c681':'#bda888');

    layout.cards.forEach(function(entry){
      var b=entry.rect,st=shopItemState(tab,entry.item),selected=entry.item.id===item.id;
      shopPlate(ctx,b,selected);
      shopArt(ctx,tab,entry.item,{x:b.x+b.w/2-23,y:b.y+7,w:46,h:37});
      if(st.equipped)shopCheck(ctx,b.x+b.w-12,b.y+13);
      else if(!st.owned&&!st.afford)shopLock(ctx,b.x+b.w-12,b.y+12);
      shopLabel(ctx,entry.item.name,b.x+b.w/2,b.y+58,fT(tab==='dragon'?11:11.5,'bold'),
                selected?'#ffedc2':'#e0cfae');
    });
    ctx.textAlign='center';ctx.textBaseline='top';ctx.fillStyle='#bda98a';ctx.font=fT(10.5);
    ctx.fillText('Tap a style to preview it.',cx,632);
    this._menuBtn('BACK',layout.back.y,{w:layout.back.w,h:layout.back.h});
    ctx.restore();
  };

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

    var reached = Math.min(careerCap(), Meta.data.careerLevel || 1);
    var wall = careerCap();
    for (var i = 0; i < CAREER_MAX; i++) {
      var b = levelRect(i), lv = i + 1;
      var got = stars[lv] || 0;
      var paywalled = lv > wall;
      var open = lv <= reached, cur = lv === reached && got === 0;
      var band = lv % 5 === 0;
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
    if (wall < CAREER_MAX) {
      ctx.fillStyle = 'rgba(232,201,255,0.85)'; ctx.font = fT(12, 'bold');
      ctx.fillText('Levels 1-' + wall + ' are free. Tap a locked level to see the rest.',
                   cx, LEVELS_BACK_Y - 18, VIEW_MIN_W - 40);
    }
    this._menuBtn('BACK', LEVELS_BACK_Y);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  };

  Game.prototype._menuBtn = function (label, y, opt) {
    var ctx = this.ctx;
    opt = opt || {};
    var bw = opt.w || 220, bh = opt.h || 56;
    var dim = !!opt.disabled;
    var t = BTN_TONE[opt.tone] || BTN_TONE.wood;
    var x = VIEW_MIN_W / 2 - bw / 2;

    ctx.fillStyle = 'rgba(0,0,0,' + (dim ? 0.18 : 0.38) + ')';
    rr(ctx, x + 2, y + 5, bw, bh, 14); ctx.fill();

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

    var tx = VIEW_MIN_W / 2, avail = bw - 24;
    var spr = opt.icon && SPR[opt.icon];
    if (spr && !dim) {
      var cx = x + 25, cy = y + bh / 2, rad = 14;
      ctx.fillStyle = 'rgba(0,0,0,0.30)';
      ctx.beginPath(); ctx.arc(cx, cy, rad, 0, 6.283); ctx.fill();
      ctx.strokeStyle = 'rgba(255,240,200,0.22)'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(cx, cy, rad, 0, 6.283); ctx.stroke();
      ctx.drawImage(spr, cx - 12.5, cy - 12.5, 25, 25);
      tx += 14; avail -= 34;
    }

    ctx.fillStyle = dim ? 'rgba(200,186,166,0.42)' : opt.quiet ? '#e8dcc8' : t.ink;
    if (opt.sub) {
      fitD(ctx, label, tx, y + 9, avail, 21);
      ctx.fillStyle = dim ? 'rgba(200,186,166,0.34)' : 'rgba(240,228,206,0.72)';
      fitT(ctx, opt.sub, tx, y + 37, avail, 12);
    } else {
      fitD(ctx, label, tx, y + (bh - 21) / 2, avail, opt.quiet ? 18 : 21);
    }
  };

  function resultsRects(g) {
    var careerWin = !!(g.career && g.careerResult && g.careerResult.won);
    return careerWin ? { again: 470, menu: 546, pick: -1 }
                     : { again: 560, menu: 636, pick: 490 };
  }

  var PAY_RECTS = {
    buy:     { x: VIEW_MIN_W / 2 - 122, y: 500, w: 244, h: 60 },
    restore: { x: VIEW_MIN_W / 2 - 122, y: 572, w: 244, h: 44 },
    back:    { x: VIEW_MIN_W / 2 - 122, y: 630, w: 244, h: 52 },
  };
  Game.prototype.paywallRects = function () { return PAY_RECTS; };

  Game.prototype.openPaywall = function () {
    this.state = 'paywall';
    Store.note = null;
    Store.load();
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

    var yy = 178;
    var give = ['Career levels ' + (FREE_CAREER_LEVELS + 1) + '-' + CAREER_MAX + ': the rest of the ladder',
                'The last ' + ARCHIVE_DAYS + ' daily jars, still playable'];
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
                'No ads, no energy meter, same as before'];
    for (var k = 0; k < keep.length; k++) {
      ctx.fillStyle = 'rgba(232,201,255,0.75)';
      ctx.fillText('\u2713', cx - 128, yy);
      ctx.fillStyle = 'rgba(232,220,200,0.72)';
      fitT(ctx, keep[k], cx - 108, yy, 236, 12);
      yy += 22;
    }
    ctx.textAlign = 'center';

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
      ctx.fillText('This build has no store. The full ladder ships with the app.',
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
    ctx.fillStyle = 'rgba(20,14,10,0.90)';
    ctx.fillRect(-v.ox, -v.uiTop, v.w, v.h + v.uiTop);
    var plateH = resultsRects(this).menu + 56 + 14 - 150;
    ctx.fillStyle = 'rgba(43,32,24,0.72)';
    rr(ctx, VIEW_MIN_W / 2 - 168, 150, 336, plateH, 20); ctx.fill();
    ctx.strokeStyle = 'rgba(201,168,106,0.30)'; ctx.lineWidth = 1.5;
    rr(ctx, VIEW_MIN_W / 2 - 168, 150, 336, plateH, 20); ctx.stroke();
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
      ctx.fillStyle = '#fff'; ctx.font = fD(22);
      ctx.fillText(cr.won ? (cr.stars === 3 ? 'A FLAWLESS SHIFT' : 'THE ORDERS ARE FILLED')
                          : this.ordersDone + '/' + this.goalOrders + ' orders filled',
                   VIEW_MIN_W / 2, 300);
      ctx.fillStyle = 'rgba(232,220,200,0.75)'; ctx.font = fT(14);
      ctx.fillText(cr.won ? 'swings left at the bell: ' + Math.max(0, this.swingsAtGoal)
                          : 'plan the dig: every swing counts', VIEW_MIN_W / 2, 334);
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
        ctx.fillText('END OF THE SHAFT, for now.', VIEW_MIN_W / 2, 392);
        ctx.fillStyle = 'rgba(232,220,200,0.7)'; ctx.font = fT(13);
        ctx.fillText('The daily dig is where the diggers are.', VIEW_MIN_W / 2, 414);
      }
      if (!cr.won) {
        var canAfford = (Meta.data.coins || 0) >= DEEPER_PICK_COST;
        ctx.fillStyle = canAfford ? '#ffd75e' : 'rgba(200,186,166,0.45)';
        ctx.font = fT(14, 'bold');
        ctx.fillText(canAfford ? 'RETRY WITH A DEEPER PICK  ·  ' + DEEPER_PICK_COST + 'c'
                               : 'a deeper pick costs ' + DEEPER_PICK_COST + 'c  ·  you have '
                                 + (Meta.data.coins || 0) + 'c',
                     VIEW_MIN_W / 2, 450);
        ctx.fillStyle = 'rgba(232,220,200,0.6)';
        fitT(ctx, '+' + DEEPER_PICK_SWINGS + ' swings next attempt · the bought swings do not count toward stars',
             VIEW_MIN_W / 2, 470, 300, 12);
        this._menuBtn(canAfford ? 'DEEPER PICK · ' + DEEPER_PICK_COST + 'c' : 'DEEPER PICK',
                      490, { disabled: !canAfford });
      }
      var RB = resultsRects(this);
      var atWall = !!(cr.won && this.career && this.career.level + 1 > careerCap());
      this._menuBtn(last ? 'DAILY DIG'
                  : atWall ? 'UNLOCK TO CONTINUE'
                  : cr.won ? 'NEXT LEVEL' : 'RETRY', RB.again);
      this._menuBtn('MENU', RB.menu);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      return;
    }
    var won = this.ordersDone >= this.goalOrders;
    ctx.fillStyle = won ? '#ffd75e' : '#f0a090';
    ctx.font = fD(34);
    ctx.fillText(won ? 'SHIFT COMPLETE' : 'THE PICK GAVE OUT', VIEW_MIN_W / 2, 180);
    ctx.fillStyle = '#fff'; ctx.font = fD(26);
    ctx.fillText(this.coins + ' coins', VIEW_MIN_W / 2, 250);
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
      ctx.fillStyle = 'rgba(232,201,255,0.65)'; ctx.font = fT(12);
      ctx.fillText('archive dig · not scored on the board', VIEW_MIN_W / 2, 362, 320);
    }
    if (this.isDaily && !arch && this.board && this.board.length) {
      ctx.fillStyle = '#c9a86a'; ctx.font = fT(13, 'bold');
      ctx.fillText("TODAY'S DIGGERS", VIEW_MIN_W / 2, 362);
      var resultRank = 0, previousResultScore = null;
      for (var bi = 0; bi < this.board.length && bi < 8; bi++) {
        var row = this.board[bi];
        if (row.coins !== previousResultScore) resultRank = bi + 1;
        previousResultScore = row.coins;
        ctx.fillStyle = '#e8dcc8';
        ctx.font = fT(13);
        ctx.textAlign = 'left';
        ctx.fillText(resultRank + '.  ' + safeName(row.player), VIEW_MIN_W / 2 - 110, 386 + bi * 19);
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

  Game.prototype._frame = function (ts) {
    requestAnimationFrame(this._frame);
    if (this._last === null) this._last = ts;
    var dtRaw = Math.max(0, Math.min(0.1, (ts - this._last) / 1000));
    this._last = Math.max(this._last, ts);
    if (!this._ft) this._ft = [];
    this._ft.push(dtRaw * 1000);
    if (this._ft.length > 240) this._ft.shift();
    var STEP = 1 / CFG.stepHz;
    if (this.state === 'playing') {
      this._acc += dtRaw;
      var n = 0, EPS = 1e-9;
      while (this.state === 'playing') {
        if (this.hitStop > 0) {
          var held = Math.min(this.hitStop, this._acc);
          this.hitStop -= held; this._acc -= held;
          if (this.hitStop > EPS) break;
          this.hitStop = 0;
        }
        if (this._acc + EPS < STEP || n >= 12) break;
        this._acc = Math.max(0, this._acc - STEP);
        this.update(STEP); this._clacks(); n++;
      }
      if (this.state !== 'playing') this._acc = 0;
    }
    this._cosmetic(dtRaw);
    this.draw(this.state === 'playing' ? Math.min(1, this._acc / STEP) : 0);
    this._syncAccess();
  };

  var F_DISP = 'Georgia, "Iowan Old Style", "Times New Roman", serif';
  var F_TEXT = '"Avenir Next", "Segoe UI", Roboto, system-ui, sans-serif';
  function fD(px, w) { return (w || 'bold') + ' ' + px + 'px ' + F_DISP; }
  function fT(px, w) { return (w ? w + ' ' : '') + px + 'px ' + F_TEXT; }

  function fN(px, w) { return (w || 'bold') + ' ' + px + 'px ' + F_TEXT; }

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

  var BTN_TONE = {
    career: { top: '#5e332c', bot: '#3a1f1a', rim: 'rgba(226,150,112,0.62)', ink: '#f7dccd' },
    daily:  { top: '#2e405e', bot: '#1b2739', rim: 'rgba(190,178,150,0.58)', ink: '#dde5f2' },
    free:   { top: '#375138', bot: '#213221', rim: 'rgba(196,190,130,0.58)', ink: '#dfeadb' },
    wood:   { top: '#5a4632', bot: '#3f3123', rim: 'rgba(255,215,94,0.85)',  ink: '#ffe9a8' },
    hoard:  { top: '#4b3760', bot: '#2f2242', rim: 'rgba(232,201,255,0.80)', ink: '#eddcff' },
  };

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

  Game.prototype.accessControls = function () {
    var g = this, out = [];
    function add(id, label, rect, disabled, checked, role) {
      out.push({ id: id, label: label, rect: rect, disabled: !!disabled, checked: checked, role: role });
    }
    function btn(id, label, y, disabled) { add(id, label, { x: 100, y: y, w: 220, h: 56 }, disabled); }
    if (g.showSettings) {
      var labels = { music: 'Music', sound: 'Sound effects', haptics: 'Haptics', hints: 'Hints in the jar', marks: 'Gem symbols',
        help: 'How to Play', resume: 'Resume', done: 'Done', quit: g._quitArmed > nowMs() ? 'Confirm quit shift' : 'Quit shift',
        restore: 'Restore purchases', privacy: 'Privacy policy' };
      var values = { music: !Snd.musicMuted, sound: !Snd.sfxMuted, haptics: Hap.enabled(), hints: Meta.data.hints !== 0, marks: Meta.data.marks === 1 };
      g.settingsRects().rows.forEach(function (r) {
        if (r.id === 'music' || r.id === 'sound') {
          var ar = audioSettingRects(r), level = r.id === 'music' ? Snd.musicVolume : Snd.sfxVolume;
          var suffix = ' ' + r.id + ' volume, ' + Math.round(level * 100) + ' percent';
          add('setting:' + r.id, labels[r.id], ar.toggle, false, values[r.id], 'switch');
          add('setting:' + r.id + ':less', 'Decrease' + suffix, ar.less, level <= 0);
          add('setting:' + r.id + ':more', 'Increase' + suffix, ar.more, level >= 1);
        } else add('setting:' + r.id, labels[r.id], r, r.id === 'restore' && Store.busy, values[r.id], r.id in values ? 'switch' : null);
      });
      add('settings-close', 'Close Settings', g.settingsRects().close);
      return out;
    }
    if (g.state === 'fieldnotes' || (g.mode === 'excavation' && g.state !== 'menu' && g.state !== 'shop' && g.state !== 'levels' && g.state !== 'records' && g.state !== 'paywall' && g.state !== 'paused')) return g._excavationControls();
    if (g.state === 'paused') { btn('resume', 'Resume', 340); return out; }
    if (g.state === 'menu') {
      add('career', 'Career level ' + Math.min(careerCap(), Meta.data.careerLevel || 1), g.menuRect('career'));
      add('daily', 'Daily Dig', g.menuRect('daily'), !Meta.data.tutorialDone);
      add('free', 'Free Dig', g.menuRect('free'));
      add('journal', 'Excavations field journal', FIELD_HOME);
      add('levels', 'Career level map', g.menuRect('strip'));
      add('shop', 'Shop', g.menuRect('shop'));
      var rc = g.recordsRects().card;
      add('records', 'Scores, records and leaderboards', { x: rc.x, y: rc.y + g._menuShift(), w: rc.w, h: rc.h });
      add('settings', 'Settings', g.menuRect('gear'));
      return out;
    }
    if (g.state === 'playing') {
      if (g.choice) {
        var cr = g.choiceRects(), heart = g.choice.key === 'heartstone';
        add('choice:use', heart ? 'Sell Heartstone for ' + HEART_SELL + ' coins' : 'Use prism for an order', cr.use);
        add('choice:hoard', heart ? 'Give Heartstone to the dragon for ' + HEART_GIFT + ' hoard' : 'Give prism to the dragon', cr.hoard);
      } else if (!g.epilogue) {
        g.orders.forEach(function (o, i) {
          var needs = Object.keys(o.need).filter(function (k) { return o.need[k] > 0; }).map(function (k) {
            return k + ' ' + Math.min(g._bagCount(k), o.need[k]) + ' of ' + o.need[k];
          }).join(', ');
          var selected = g._focusedOrder() === o;
          add('order:' + i, 'Order ' + (i + 1) + '. ' + needs + '. Pays ' + o.pay + ' coins. '
            + (selected ? 'Planned. Stop planning this order.' : 'Plan this order and show its missing gems.'),
            { x: 14 + i * (ORDER_W + 8), y: ORDER_Y, w: ORDER_W, h: ORDER_H }, false, selected);
        });
        g.bag.forEach(function (k, i) {
          add('bag:' + i, 'Discard ' + k + ' from bag slot ' + (i + 1) + ' permanently, no coins',
            { x: bagSlotX(i), y: BAG_Y, w: BAG_SLOT, h: BAG_SLOT });
        });
        g.jar.bodies.filter(function (b) { return g.jar.exposed(b); }).sort(function (a, b) { return a.x - b.x; }).forEach(function (b, i) {
          var name = b.key === 'heartstone' ? 'Heartstone, ' + (3 - (b.pry || 0)) + ' pries remaining' :
            b.lode ? 'lodestone' : b.shale ? 'shale' : b.geode ? 'crusted rock' : (b.great ? 'great ' : '') + b.key;
          var planned = g._focusedOrder();
          var needed = planned && (planned.need[b.key] || 0) > g._bagCount(b.key);
          add('gem:' + b.id, 'Dig ' + name + ', ' + (i + 1) + ' from the left'
            + (needed ? '. Needed for planned order.' : ''),
            { x: b.x - b.r, y: b.y - b.r, w: b.r * 2, h: b.r * 2 });
        });
      }
      add('settings', 'Settings', g.gearRect());
      return out;
    }
    if (g.state === 'levels') {
      var cap = careerCap(), reached = Math.min(cap, Meta.data.careerLevel || 1);
      for (var i = 0; i < CAREER_MAX; i++) {
        add('level:' + (i + 1), 'Level ' + (i + 1) + (i + 1 > cap ? '. Unlock full burrow' : i + 1 > reached ? '. Not reached yet' : ''),
          levelRect(i), i + 1 <= cap && i + 1 > reached);
      }
      btn('back', 'Back', LEVELS_BACK_Y);
    } else if (g.state === 'results') {
      var rr = resultsRects(g), won = g.careerResult && g.careerResult.won;
      if (rr.pick > 0 && g.career && !won) btn('deeper-pick', 'Deeper pick. ' + DEEPER_PICK_COST + ' coins for ' + DEEPER_PICK_SWINGS + ' extra swings', rr.pick, (Meta.data.coins || 0) < DEEPER_PICK_COST);
      btn('again', g.careerFinale() ? 'Daily Dig' : g.career ? won ? g.career.level + 1 > careerCap() ? 'Unlock to continue' : 'Next level' : 'Retry' : 'Again', rr.again);
      btn('back', 'Menu', rr.menu);
    } else if (g.state === 'paywall') {
      var pr = g.paywallRects();
      add('buy', 'Unlock full burrow' + (Store.price ? ', ' + Store.price : ''), pr.buy, Ent.owned() || Store.busy || !Store.price || !Store.available());
      add('restore', 'Restore purchases', pr.restore, Store.busy || !Store.available());
      add('back', 'Back', pr.back);
    } else if (g.state === 'shop') {
      var layout = g.shopLayout(), tab = g.shopTab || 'walls', selected = g.shopSelection();
      ['walls', 'dragon', 'pick'].forEach(function (t) {
        add('tab:' + t, { walls: 'Jar walls', dragon: 'Dragon colors', pick: 'Pickaxes' }[t], layout.tabs[t], false, t === tab);
      });
      layout.cards.forEach(function (card) {
        var st = shopItemState(tab, card.item);
        var detail = st.equipped ? '. Equipped' : st.owned ? '. Owned' : tab === 'walls' ? '. Costs ' + st.need + ' coins'
          : '. Unlocks at ' + st.need + (tab === 'dragon' ? ' hoard' : ' career stars');
        add(card.id, st.name + detail + '. Preview', card.rect, false, card.item.id === selected.id);
      });
      var action = shopItemState(tab, selected);
      add('shop-action', action.name + '. ' + action.actionLabel, layout.action, !action.canAct);
      add('back', 'Back', layout.back);
    } else if (g.state === 'records') {
      var r = g.recordsRects(), tabNames = { stats: 'Stats', board: 'Daily leaderboard', league: 'League', past: 'Past daily digs', jobs: 'Contracts' };
      var activeTab = g.recTab || 'stats';
      if (activeTab === 'league' && !r.tabLeague) activeTab = 'stats';
      Object.keys(tabNames).forEach(function (t) {
        var rect = r['tab' + t.charAt(0).toUpperCase() + t.slice(1)];
        if (rect) add('tab:' + t, tabNames[t], rect, false, activeTab === t);
      });
      if (g.recTab === 'jobs' || g.recTab === 'past') {
        var pager = g.recTab === 'jobs' ? g.jobsPageRect() : g.pastPageRect();
        add('page:previous', 'Previous page', { x: pager.x, y: pager.y, w: pager.w / 2, h: pager.h });
        add('page:next', 'Next page', { x: pager.x + pager.w / 2, y: pager.y, w: pager.w / 2, h: pager.h });
      }
      if (g.recTab === 'past' && g.archiveAction() !== 'history') g.archiveRows().slice((g.pastPage || 0) * PAST_PER_PAGE, ((g.pastPage || 0) + 1) * PAST_PER_PAGE).forEach(function (a, i) {
        add('archive:' + a.day, 'Daily Dig from ' + a.ago + (a.ago === 1 ? ' day' : ' days') + ' ago. Best ' + a.best + (Ent.owned() ? '' : '. Unlock full burrow'),
          { x: 60, y: PAST_ROW_Y + i * PAST_ROW_H, w: 300, h: PAST_ROW_H });
      });
      btn('back', 'Back', r.backY);
    }
    add('settings', 'Settings', SHOP_GEAR);
    return out;
  };

  Game.prototype.accessSummary = function () {
    var g = this, text = '';
    if (g.showSettings) text = 'Settings. ' + (g.state === 'paused' ? 'Your shift is paused.' : '');
    else if (g.state === 'fieldnotes') text = 'GemBurrow. Five free authored excavations. Fill a commission and preserve intact specimens for Flint.';
    else if (g.mode === 'excavation' && (g.state === 'playing' || g.state === 'paused' || g.state === 'results')) {
      var e = g.excavation;
      text = e.site.title + '. ' + g.swings + ' swings left. Commission: ' + excavationRecipe(e.site) + '. ' + (e.delivered ? 'Filled.' : 'Not yet filled.') + ' Satchel ' + g.bag.join(', ') + '. ' + e.specimens.length + ' specimens intact.';
      if (e.cut) text += ' Choose lift intact for two swings or split into three loose gems for one swing.';
      if (e.prompt) text += excavationCanCollect(g) ? ' Finish now or keep digging for specimens.' : ' Finish now. ' + excavationCollectionBlock(g);
      if (g.state === 'paused') text = 'Paused. ' + text;
      if (g.state === 'results') text = (e.delivered ? 'Commission complete. ' : 'Pick spent. ') + text;
      if (g.toast && g.toast.until > g.worldT) text += ' ' + g.toast.text;
    }
    else if (g.state === 'playing' || g.state === 'paused' || g.state === 'results') {
      text = (g.state === 'results' ? 'Shift finished. ' : g.state === 'paused' ? 'Paused. ' : '') +
        g.swings + ' swings left. ' + g.ordersDone + ' of ' + g.goalOrders + ' orders filled. ' + g.coins + ' coins. Bag ' + g.bag.length + ' of ' + g.bagCap + '.';
      if (g.choice) text = (g.choice.key === 'heartstone' ? 'Heartstone: sell or give to dragon.' : 'Prism: use for an order or give to dragon.') + ' ' + CHOICE_SECS + ' seconds to choose.';
      else if (g.toast && g.toast.until > g.worldT) text += ' ' + g.toast.text;
      var plan = g._orderPlan();
      if (plan && g.state === 'playing' && !g.choice) text += ' Planning order ' + (plan.slot + 1) + ': '
        + plan.have + ' of ' + plan.total + ' gems in bag, ' + plan.missing + ' still needed.';
    } else text = (g.state === 'menu' ? 'Gemburrow. Dig gems, fill orders, feed the dragon.' : g.state + '.') +
      ' ' + (Meta.data.coins || 0) + ' coins saved. ' + (Meta.data.hoardTotal || 0) + ' hoard.';
    if (Store.note && (g.showSettings || g.state === 'paywall')) text += ' ' + Store.note;
    return text;
  };

  Game.prototype.accessDetails = function () {
    var g = this, lines = [], m = Meta.data;
    if (g.showSettings || g.state === 'paused') return lines;
    if (g.state === 'fieldnotes') return ['All five sites are free. Finite piles never refill. Complete the commission to record preserved specimens. Replay for a shorter route or a missing specimen.'];
    if (g.mode === 'excavation' && (g.state === 'playing' || g.state === 'results')) return [g.excavation.site.brief, 'Remove the pieces above a gem before lifting it. Great gems can be split for three loose gems, or lifted intact for two swings. Dense striped rocks take two swings. The satchel holds seven gems. Discarding a gem is permanent for this attempt. A completed commission lets you finish immediately or keep digging. Journal records do not award coins or change Daily challenges.'];
    if (g.state === 'results') {
      var cr = g.careerResult;
      lines.push((g.career ? 'Career level ' + g.career.level + '. ' : g.archiveDay ? 'Archive dig. ' : g.isDaily ? 'Daily Dig. ' : 'Free Dig. ') +
        (g.ordersDone >= g.goalOrders ? 'Orders complete.' : 'The pick gave out.') + ' ' + g.ordersDone + ' of ' + g.goalOrders + ' orders filled.');
      if (g.career && cr) lines.push(cr.stars + ' of 3 stars. ' + (cr.banked || 0) + ' coins banked. Career pays on the first clear only.');
      else lines.push((g.banked || 0) + ' coins banked. ' + (g.archiveDay ? 'Archive coins are not banked or submitted to the leaderboard.' : g.isDaily ? 'Only your first finished Daily shift today pays coins.' : 'Free digs bank every shift.'));
      lines.push(g.hoard + ' added to the hoard. Purse: ' + (m.coins || 0) + ' coins.');
      (g.contractsWon || []).forEach(function (c) { lines.push('Contract completed: ' + c.name + '. ' + c.h + ' hoard.'); });
    } else if (g.state === 'records') {
      var tab = g.recTab || 'stats';
      if (tab === 'league' && !g.recordsRects().tabLeague) tab = 'stats';
      if (tab === 'stats') {
        var st = m.stats || {}, stars = m.careerStars || {}, total = 0, best = 0;
        Object.keys(stars).forEach(function (k) { total += stars[k] || 0; });
        Object.keys(m.bestDaily || {}).forEach(function (k) { best = Math.max(best, m.bestDaily[k]); });
        lines.push('Career: ' + Math.min(CAREER_MAX, m.careerLevel || 1) + ' of ' + CAREER_MAX + '. Stars: ' + total + ' of ' + CAREER_MAX * 3 + '.');
        lines.push('Best daily: ' + best + ' coins. Best free dig: ' + (m.bestFree || 0) + ' coins.');
        lines.push('Day streak: ' + (st.streak || 0) + '. Best streak: ' + (st.bestStreak || 0) + '. Shifts worked: ' + (st.shifts || 0) + '. Days dug: ' + (st.days || Object.keys(m.bestDaily || {}).length) + '.');
        lines.push('Gems delivered: ' + (st.gems || 0) + '. Crusted rocks cracked: ' + (st.crusts || 0) + '. Heartstones found: ' + (st.hearts || 0) + '. Longest chain: ' + (st.bestCombo || 0) + '. Coins earned: ' + (st.earned || m.coins || 0) + '.');
      } else if (tab === 'jobs') {
        var done = contractsDone(), page = g.jobsPage || 0;
        lines.push('Contracts. Page ' + (page + 1) + ' of ' + Math.ceil(CONTRACTS.length / JOBS_PER_PAGE) + '. Earned in Free and Career. No expiry.');
        CONTRACTS.slice(page * JOBS_PER_PAGE, (page + 1) * JOBS_PER_PAGE).forEach(function (c) { lines.push(c.name + ': ' + c.desc + '. ' + c.h + ' hoard. ' + (done[c.id] ? 'Completed.' : 'Not completed.')); });
      } else if (tab === 'past') {
        var action = g.archiveAction();
        lines.push('Past Daily digs. Page ' + ((g.pastPage || 0) + 1) + ' of ' + Math.ceil(ARCHIVE_DAYS / PAST_PER_PAGE) + '. ' +
          (action === 'history' ? 'Archive replay is included in The Full Burrow for iPhone. Your personal score history is shown here.' :
           action === 'unlock' ? 'Unlock The Full Burrow to replay these jars.' : 'Revisit the same jars. Coins are not banked and scores stay off today’s board.'));
        g.archiveRows().slice((g.pastPage || 0) * PAST_PER_PAGE, ((g.pastPage || 0) + 1) * PAST_PER_PAGE).forEach(function (a) {
          lines.push(a.ago + (a.ago === 1 ? ' day ago: ' : ' days ago: ') + a.ch.name + '. Personal best: ' + a.best + ' coins.');
        });
      }
      else {
        var board = tab === 'league' ? g._league : g._board, limit = tab === 'league' ? 12 : 10;
        lines.push(tab === 'league' ? 'League. Daily digs over the last 14 days, added together.' : 'Today’s daily leaderboard.');
        if (!board || board.state === 'loading' && !fetchStalled(board)) lines.push('Loading.');
        else if (board.state === 'closed' || board.state === 'error' || fetchStalled(board)) lines.push('The board is out of reach. Activate the same tab to retry.');
        else if (!(board.rows || []).length) lines.push('No digs yet.');
        else {
          var place = 0, previous = null;
          lines.push('Top ' + limit + '. Equal scores share a rank.');
          board.rows.slice(0, limit).forEach(function (r, i) {
            var score = tab === 'league' ? r.total : r.coins;
            if (score !== previous) place = i + 1;
            previous = score;
            lines.push(place + '. ' + safeName(r.player) + '. ' + (score | 0) + ' coins' + (tab === 'league' ? ' over ' + (r.days | 0) + ' days' : '') + '.');
          });
        }
        lines.push(g._standingText(tab === 'league' ? 'league' : 'board') + '. Your display name: ' + safeName(m.playerName) + '.');
      }
    } else if (g.state === 'paywall') lines.push('Full Burrow is a one-time purchase. Unlock the full 40-level career and past Daily jars. Today’s Daily and Free Dig remain available without purchase.');
    else if (g.state === 'levels') lines.push('Choose a reached level to replay it. Stars can improve; coins bank on the first clear only.');
    else if (g.state === 'shop') lines.push('Select an item to preview it. Only the Buy or Equip button changes your appearance. Walls cost saved coins. Dragon colors unlock with your hoard. Pickaxes unlock with career stars. Hoard and stars are not spent. These appearances do not change your dig.');
    else if (g.state === 'menu' && !m.tutorialDone) lines.push('Daily Dig unlocks when you finish the introductory Career lesson.');
    return lines;
  };

  Game.prototype._syncAccess = function (force) {
    var stamp = nowMs();
    var cutScene = this.mode === 'excavation' && this.state === 'playing' && this.excavation
      ? (this.excavation.cut ? 'cut:' + this.excavation.cut.id : this.excavation.prompt ? 'finish' : '') : '';
    if (cutScene !== this._excavationInputScene && (cutScene || this._excavationInputScene)) {
      this._uiLockUntil = stamp + UI_LOCK_MS;
    }
    this._excavationInputScene = cutScene;
    var host = document.getElementById('game-controls');
    if (!host) return;
    if (!force && stamp - (this._accessAt || 0) < 100) return;
    this._accessAt = stamp;
    if (helpIsOpen()) { host.setAttribute('aria-hidden', 'true'); return; }
    host.removeAttribute('aria-hidden');
    var g = this, controls = g.accessControls(), nodes = g._accessNodes || (g._accessNodes = {}), seen = {}, v = g.view;
    var focused = document.activeElement, prior = focused && focused.getAttribute('data-control-id');
    var priorRect = prior && nodes[prior] && nodes[prior]._worldRect;
    var excavationChoice = g.mode === 'excavation' && g.excavation
      ? (g.excavation.cut ? 'cut' : g.excavation.prompt ? 'finish' : '') : '';
    var scene = g.state + ':' + !!g.showSettings + ':' + !!g.choice + ':' + excavationChoice;
    controls.forEach(function (d) {
      seen[d.id] = true;
      var el = nodes[d.id];
      if (!el) {
        el = document.createElement('button'); el.type = 'button'; el.className = 'game-control';
        el.id = 'game-control-' + d.id;
        el.setAttribute('data-control-id', d.id);
        el.addEventListener('click', function (e) {
          e.preventDefault(); e.stopPropagation();
          if (helpIsOpen()) return;
          var fresh = g.accessControls().filter(function (c) { return c.id === d.id; })[0];
          if (!fresh || fresh.disabled) return;
          g._accessKeyboard = true;
          var r = fresh.rect;
          _activateWorld({ x: r.x + r.w / 2, y: r.y + r.h / 2, bodyId: fresh.id.indexOf('gem:') === 0 ? Number(fresh.id.slice(4)) : undefined });
          g._syncAccess(true);
        });
        el.addEventListener('focus', function () { g._accessKeyboard = true; });
        nodes[d.id] = el; host.appendChild(el);
      }
      function attr(k, val) { if (el.getAttribute(k) !== val) el.setAttribute(k, val); }
      attr('aria-label', d.label); attr('role', d.role || 'button');
      el.disabled = d.disabled;
      var checkAttr = d.role === 'switch' ? 'aria-checked' : 'aria-pressed';
      if (typeof d.checked === 'boolean') attr(checkAttr, String(d.checked));
      else { el.removeAttribute('aria-checked'); el.removeAttribute('aria-pressed'); }
      el._worldRect = d.rect;
      var r = d.rect, css = 'left:' + ((r.x + v.ox) * v.scale) + 'px;top:' + ((r.y + v.oy + v.uiTop) * v.scale) +
        'px;width:' + r.w * v.scale + 'px;height:' + r.h * v.scale + 'px;';
      if (el.style.cssText !== css) el.style.cssText = css;
    });
    Object.keys(nodes).forEach(function (id) { if (!seen[id]) { nodes[id].remove(); delete nodes[id]; } });
    if (g.state === 'shop' && !g.showSettings) {
      var next = host.firstChild;
      controls.forEach(function (d) {
        var el = nodes[d.id];
        if (el !== next) host.insertBefore(el, next);
        else next = next.nextSibling;
      });
    }
    if (g._accessKeyboard && ((prior && !seen[prior]) || (g._accessScene && g._accessScene !== scene))) {
      var target = controls.filter(function (d) { return !d.disabled && d.id !== 'deeper-pick' && d.id !== 'buy' && d.id !== 'shop-action' && (g.showSettings || g.choice || g.state !== 'playing' || d.id.indexOf('gem:') === 0); });
      if (!g.showSettings && g.state === 'playing' && excavationChoice) {
        target = controls.filter(function (d) { return d.id === (excavationChoice === 'cut' ? 'cut:cancel' : 'excavation:continue'); });
      }
      if (priorRect && prior && prior.indexOf('gem:') === 0 && g._accessScene === scene) target.sort(function (a, b) {
        function distance(r) { return Math.pow(r.x + r.w / 2 - priorRect.x - priorRect.w / 2, 2) + Math.pow(r.y + r.h / 2 - priorRect.y - priorRect.h / 2, 2); }
        return distance(a.rect) - distance(b.rect);
      });
      if (target.length) nodes[target[0].id].focus({ preventScroll: true });
    }
    g._accessScene = scene;
    var status = document.getElementById('game-status'), summary = g.accessSummary();
    if (status && status.textContent !== summary) status.textContent = summary;
    var details = document.getElementById('game-details'), lines = g.accessDetails(), detailsKey = JSON.stringify(lines);
    if (details && g._accessDetailsKey !== detailsKey) {
      g._accessDetailsKey = detailsKey;
      while (details.firstChild) details.removeChild(details.firstChild);
      lines.forEach(function (line) { var p = document.createElement('p'); p.textContent = line; details.appendChild(p); });
      details.hidden = !lines.length;
    }
  };

  var canvas = document.getElementById('game-canvas');
  var game = new Game(canvas);
  var helpDialog = document.getElementById('how-to-play');
  function helpIsOpen() { return helpDialog && helpDialog.hasAttribute('open'); }
  var helpInvoker = null;
  var keyboardSeen = false;
  document.addEventListener('keydown', function () { keyboardSeen = true; }, true);
  function inNativeApp() {
    var C = window.Capacitor;
    return !!(C && typeof C.isNativePlatform === 'function' && C.isNativePlatform());
  }
  function keyboardLikely() {
    if (keyboardSeen) return true;
    if (inNativeApp()) return false;
    return !!(window.matchMedia && window.matchMedia('(hover: hover) and (pointer: fine)').matches);
  }
  function fitGuideToInput() {
    var keys = helpDialog.querySelector('[data-guide-keys]');
    if (keys) keys.hidden = !keyboardLikely();
    var tip = helpDialog.querySelector('[data-guide-browser]');
    if (tip) tip.hidden = inNativeApp();
  }
  function openHelpGuide() {
    if (!helpDialog || helpIsOpen()) return;
    helpInvoker = document.activeElement;
    fitGuideToInput();
    if (typeof helpDialog.showModal === 'function') helpDialog.showModal();
    else {
      document.documentElement.classList.add('guide-fallback');
      helpDialog.setAttribute('open', '');
      document.getElementById('game-wrap').setAttribute('aria-hidden', 'true');
      document.getElementById('guide-close').focus();
    }
    helpDialog.querySelector('.guide-body').scrollTop = 0;
  }
  function closeHelpGuide() {
    if (!helpIsOpen()) return;
    if (document.documentElement.classList.contains('guide-fallback')) {
      helpDialog.removeAttribute('open');
      document.documentElement.classList.remove('guide-fallback');
      document.getElementById('game-wrap').removeAttribute('aria-hidden');
    } else helpDialog.close();
    game._uiLockUntil = nowMs() + UI_LOCK_MS;
    game._syncAccess(true);
    if (helpInvoker && helpInvoker.isConnected) helpInvoker.focus({ preventScroll: true });
  }
  if (helpDialog) {
    helpDialog.querySelectorAll('[data-guide-art]').forEach(function (img) {
      img.src = assetURL(SPR_FILES[img.getAttribute('data-guide-art')]);
    });
    var guideValues = { choice: CHOICE_SECS, gift: HEART_GIFT, sell: HEART_SELL };
    helpDialog.querySelectorAll('[data-guide-value]').forEach(function (el) {
      el.textContent = guideValues[el.getAttribute('data-guide-value')];
    });
    document.getElementById('guide-close').addEventListener('click', closeHelpGuide);
    helpDialog.addEventListener('close', function () { game._uiLockUntil = nowMs() + UI_LOCK_MS; });
    document.addEventListener('keydown', function (e) {
      if (!helpIsOpen()) return;
      if (e.key === 'Escape') { e.preventDefault(); closeHelpGuide(); }
      else if (e.key === 'Tab') {
        var stops = [document.getElementById('guide-close'), helpDialog.querySelector('.guide-body')];
        var next = (stops.indexOf(document.activeElement) + (e.shiftKey ? -1 : 1) + stops.length) % stops.length;
        e.preventDefault(); stops[next].focus();
      }
    });
  }
  Meta.ready(function () { Store.load(); Store.recover(); });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) game.setPaused(true);
    else {
      game._last = null;
      Store.recover();
      Meta.ready(function () { Lb.retryPending(); });
    }
  });
  window.addEventListener('online', function () {
    Meta.ready(function () { Lb.retryPending(); });
  });

  Meta.ready(function () { Lb.retryPending(); });
  window.addEventListener('resize', function () { game.resize(); });

  function _activateWorld(w) {
    if (helpIsOpen()) return;
    Snd.unlock();
    if (game._uiLockUntil && nowMs() < game._uiLockUntil) return;
    var state = game.state, settings = game.showSettings;
    _routeTap(w);
    if (game.state !== state || game.showSettings !== settings) game._uiLockUntil = nowMs() + UI_LOCK_MS;
  }
  window.addEventListener('pointerdown', function (e) {
    if (helpIsOpen() || (e.target.closest && e.target.closest('.game-control'))) return;
    game._accessKeyboard = false;
    if (document.activeElement && document.activeElement.classList.contains('game-control')) document.activeElement.blur();
    _activateWorld(game.toWorld(e.clientX, e.clientY));
    game._syncAccess(true);
  });
  function navigateBack() {
    if (helpIsOpen()) { closeHelpGuide(); return true; }
    if (game.showSettings) game.closeSettings();
    else if (game.state === 'playing') game.openSettings();
    else if (game.state === 'paused') game.setPaused(false);
    else if (game.state === 'paywall') game.state = 'levels';
    else if (game.state === 'fieldnotes') { game.state = 'menu'; Snd.scene('shop'); }
    else if (game.mode === 'excavation' && game.state === 'results') { game.state = 'fieldnotes'; Snd.scene('shop'); }
    else if (game.state !== 'menu') { game.state = 'menu'; Snd.scene('shop'); }
    else return false;
    game._uiLockUntil = nowMs() + UI_LOCK_MS;
    game._syncAccess(true);
    return true;
  }
  document.addEventListener('keydown', function (e) {
    if (e.defaultPrevented || helpIsOpen()) return;
    if (e.key === 'Escape') { e.preventDefault(); if (!e.repeat) { game._accessKeyboard = true; navigateBack(); } }
    else if (e.key.indexOf('Arrow') === 0 && document.activeElement && document.activeElement.classList.contains('game-control')) {
      var buttons = Array.prototype.slice.call(document.querySelectorAll('#game-controls button:not(:disabled)'));
      var index = buttons.indexOf(document.activeElement), dir = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
      if (buttons.length) { e.preventDefault(); buttons[(index + dir + buttons.length) % buttons.length].focus({ preventScroll: true }); }
    } else if ((e.key === 'Enter' || e.key === ' ') && e.repeat) e.preventDefault();
  });

  function _routeTap(w) {
    if (game.showSettings) { game._settingsTap(w); return; }
    if (game.state === 'fieldnotes' || (game.mode === 'excavation' && (game.state === 'playing' || game.state === 'paused' || game.state === 'results'))) { game._excavationTap(w); return; }
    if (game.state === 'records') {
      if (inRect(w, SHOP_GEAR)) { uiTick(); game.openSettings(); return; }
      var RR = game.recordsRects();
      if (inRect(w, padHitUp(RR.tabStats))) { uiTick(); game.recTab = 'stats'; return; }
      if (inRect(w, padHitUp(RR.tabPast))) { uiTick(); game.recTab = 'past'; return; }
      if (inRect(w, padHitUp(RR.tabJobs))) { uiTick(); game.recTab = 'jobs'; return; }
      if (game.recTab === 'jobs') {
        var pr = game.jobsPageRect();
        if (inRect(w, pr)) {
          uiTick();
          var pgs = Math.ceil(CONTRACTS.length / JOBS_PER_PAGE);
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
        var apage = game.pastPage || 0;
        var ar = game.archiveRows().slice(apage * PAST_PER_PAGE, apage * PAST_PER_PAGE + PAST_PER_PAGE);
        for (var ai = 0; ai < ar.length; ai++) {
          var ay = PAST_ROW_Y + ai * PAST_ROW_H;
          if (w.y >= ay && w.y < ay + PAST_ROW_H &&
              w.x > VIEW_MIN_W / 2 - 150 && w.x < VIEW_MIN_W / 2 + 150) {
            if (game.archiveAction() === 'history') return;
            uiTick();
            if (!Ent.owned()) { uiTick(); game.openPaywall(); return; }
            game.start(0, 'daily', 0, ar[ai].day);
            return;
          }
        }
      }
      if (RR.tabLeague && inRect(w, padHitUp(RR.tabLeague))) {
        uiTick();
        game._loadLeague(game.recTab === 'league');
        game.recTab = 'league';
        return;
      }
      if (inRect(w, padHitUp(RR.tabBoard))) {
        uiTick();
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
      var shop = game.shopLayout(), categories = ['walls', 'dragon', 'pick'];
      for (var ti = 0; ti < categories.length; ti++) {
        if (inRect(w, shop.tabs[categories[ti]])) { uiTick(); game.shopTab = categories[ti]; return; }
      }
      for (var ci = 0; ci < shop.cards.length; ci++) {
        if (inRect(w, shop.cards[ci].rect)) { if (game.selectShopItem(shop.cards[ci].item.id)) uiTick(); return; }
      }
      if (inRect(w, shop.action)) { game.activateShopItem(); return; }
      if (inRect(w, shop.back)) { uiTick(); game.state = 'menu'; Snd.scene('shop'); return; }
      return;
    }
    if (game.state === 'levels') {
      if (inRect(w, SHOP_GEAR)) { uiTick(); game.openSettings(); return; }
      if (hitBtn(w, LEVELS_BACK_Y)) { uiTick(); game.state = 'menu'; return; }
      var payWall = careerCap();
      var reachedLv = Math.min(payWall, Meta.data.careerLevel || 1);
      for (var li = 0; li < CAREER_MAX; li++) {
        if (!inRect(w, levelRect(li))) continue;
        if (li + 1 > payWall) { uiTick(); game.openPaywall(); return; }
        if (li + 1 > reachedLv) { Snd.thunk(); return; }
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
      if (inRect(w, FIELD_HOME)) { uiTick(); game.state = 'fieldnotes'; return; }
      if (inRect(w, game.menuRect('gear'))) { uiTick(); game.openSettings(); return; }
      if (inRect(w, game.menuRect('strip'))) { uiTick(); game.state = 'levels'; return; }
      if (inRect(w, game.menuRect('shop'))) { uiTick(); game.state = 'shop'; game.shopTab = game.shopTab || 'walls'; Snd.scene('shop'); return; }
      var rc = game.recordsRects().card;
      if (inRect(w, { x: rc.x, y: rc.y + game._menuShift(), w: rc.w, h: rc.h })) {
        uiTick();
        game._openRecords();
        Snd.scene('shop'); return;
      }
      if (inRect(w, game.menuRect('career'))) { uiTick(); game.start(0, 'career'); }
      else if (inRect(w, game.menuRect('daily'))) {
        if (!Meta.data.tutorialDone) { Snd.thunk(); return; }
        uiTick(); game.start(dailySeed(), 'daily');
      }
      else if (inRect(w, game.menuRect('free'))) { uiTick(); game.start((Math.random() * 4294967296) >>> 0, 'free'); }
      return;
    }
    if (game.state === 'results') {
      if (inRect(w, MENU.gear)) { uiTick(); game.openSettings(); return; }
      var RB = resultsRects(game);
      if (RB.pick > 0 && game.career && game.careerResult && !game.careerResult.won && hitBtn(w, RB.pick)) {
        if ((Meta.data.coins || 0) < DEEPER_PICK_COST) { Snd.thunk(); return; }
        Meta.data.coins -= DEEPER_PICK_COST;
        Meta.save();
        Snd.fanfare(150);
        game.pendingPick = DEEPER_PICK_SWINGS;
        game.start(0, 'career', game.career.level);
        return;
      }
      if (hitBtn(w, RB.again)) {
        uiTick();
        if (game.careerFinale()) {
          game.start(dailySeed(), 'daily');
        } else if (game.career) {
          var wonIt = !!(game.careerResult && game.careerResult.won);
          var nextLv = game.career.level + (wonIt ? 1 : 0);
          if (wonIt && nextLv > careerCap()) { game.openPaywall(); return; }
          game.start(0, 'career', nextLv);
        } else if (game.archiveDay) {
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
      game.setPaused(false);
      return;
    }
    if (game.state === 'playing') {
      if (inRect(w, game.gearRect())) { game.openSettings(); return; }
      game.tapAt(w.x, w.y, w.bodyId);
    }
  }
  function hitBtn(w, y) {
    return w.x > VIEW_MIN_W / 2 - 110 && w.x < VIEW_MIN_W / 2 + 110 && w.y > y && w.y < y + 56;
  }

  window.__game = { pause: function (v) { game.setPaused(v); } };
  window.__game.pauseIfPlaying = function () {
    return navigateBack() ? 'paused' : 'exit';
  };


})();
