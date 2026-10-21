(function (root) {
  'use strict';
  var COLS = 24, ROWS = 40, N = COLS * ROWS, PADW = 0.8;
  var CFG = {
    roundTime: 120, suddenTime: 15, winShare: 0.85, ballsStart: 1, ballMax: 2,
    ballSpeed: 9, rampEvery: 30, rampPct: 0.10, ballR: 0.4, bigR: 0.9, hitRadius: 1.5,
    paddleH: 6, paddleSpeed: 30, paddleTol: 0.5,
    maxAngle: 60 * Math.PI / 180, minAngle: 10 * Math.PI / 180,
    puFirst: 8, puEvery: 12, puJitter: 3, puLife: 15, puMax: 2, leadGap: 0.20,
    catchupShare: 0.35, catchupHold: 5, catchupCooldown: 30, respawnDelay: 2.5, countdown: 3,
    fortifyTime: 10, tidalSpeed: 10, tidalHalf: 3, wormholeTime: 8,
    turretTime: 6, turretEvery: 0.8, shotSpeed: 22, infilTime: 8, ghostTime: 5, tieMargin: 0.01
  };
  var TYPES = ['fortify', 'tidal', 'wormhole', 'turret', 'infiltrator', 'eclipse'];
  var NAMES = {
    fortify: 'Fortify + 10 seconds', tidal: 'Tidal wave', wormhole: 'Wormhole',
    turret: 'Turret', infiltrator: 'Infiltrator', eclipse: 'Eclipse ghost + 5 seconds'
  };
  var LEVELS = {
    easy:   { react: 0.45, err: 2.6, speed: 15 },
    medium: { react: 0.28, err: 1.4, speed: 22 },
    hard:   { react: 0.16, err: 0.7, speed: 27 }
  };

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function rnd(s, a, b) { return a + s.rng() * (b - a); }

  function createSim(seed, bots) {
    var s = {
      rng: mulberry32(seed >>> 0),
      owner: new Uint8Array(N), fortUntil: new Float32Array(N), flipT: new Float32Array(N).fill(-9),
      t: 0, phase: 'countdown', cd: CFG.countdown, suddenEnd: 0, winner: null, over: false,
      balls: [], nextId: 1, tiles: [], waves: [], shots: [], portals: null,
      pad: [{ y: ROWS / 2, target: ROWS / 2 }, { y: ROWS / 2, target: ROWS / 2 }],
      ghostUntil: [0, 0], turretUntil: [0, 0], turretNext: [0, 0],
      lowFor: [0, 0], lastCatchup: [-99, -99], emptyFor: [0, 0],
      nextTile: CFG.puFirst, share: [0.5, 0.5], counts: [N / 2, N / 2], events: [],
      bots: [null, null],
      stats: { saves: [0, 0], misses: [0, 0], flips: [0, 0], tiles: [0, 0], catchups: [0, 0] }
    };
    var b = COLS / 2;
    for (var r = 0; r < ROWS; r++) {
      var d = s.rng();
      b += d < 0.25 ? -1 : (d > 0.75 ? 1 : 0);
      b = clamp(b, COLS / 2 - 2, COLS / 2 + 2);
      for (var c = 0; c < COLS; c++) s.owner[r * COLS + c] = c < b ? 0 : 1;
    }
    for (var k = 0; k < 2; k++) {
      for (var i = 0; i < CFG.ballsStart; i++) {
        spawnBall(s, k, k === 0 ? 8 : 16, ROWS / 2 + rnd(s, -6, 6), false);
      }
      if (bots && bots[k]) s.bots[k] = { level: bots[k], timer: 0, target: ROWS / 2, aimOff: 0, lastId: -1 };
    }
    countShares(s);
    return s;
  }

  function spawnBall(s, team, x, y, big) {
    var ang = rnd(s, 20, 50) * Math.PI / 180 * (s.rng() < 0.5 ? -1 : 1);
    var dir = team === 0 ? 1 : -1, sp = CFG.ballSpeed;
    var b = {
      id: s.nextId++, x: x, y: y, vx: dir * Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
      team: team, r: big ? CFG.bigR : CFG.ballR, big: !!big,
      expires: big ? s.t + CFG.infilTime : Infinity, cd: 0, dead: false
    };
    s.balls.push(b);
    return b;
  }

  function teamCount(s, k) {
    var n = 0;
    for (var i = 0; i < s.balls.length; i++) if (s.balls[i].team === k && !s.balls[i].big && !s.balls[i].dead) n++;
    return n;
  }

  function countShares(s) {
    var n0 = 0;
    for (var i = 0; i < N; i++) if (s.owner[i] === 0) n0++;
    s.counts[0] = n0; s.counts[1] = N - n0;
    s.share[0] = n0 / N; s.share[1] = (N - n0) / N;
  }

  function flip(s, c, r, team) {
    if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return;
    var i = r * COLS + c;
    if (s.owner[i] === team) return;
    if (s.fortUntil[i] > s.t) return;
    s.owner[i] = team;
    s.flipT[i] = s.t;
    s.stats.flips[team]++;
  }

  function deflect(s, b, pad, half, dir) {
    var off = clamp((b.y - pad.y) / half, -1, 1);
    var ang = off * CFG.maxAngle;
    if (Math.abs(ang) < CFG.minAngle) ang = (off < 0 || (off === 0 && s.rng() < 0.5) ? -1 : 1) * CFG.minAngle;
    var sp = Math.hypot(b.vx, b.vy) || CFG.ballSpeed;
    b.vx = dir * Math.cos(ang) * sp;
    b.vy = Math.sin(ang) * sp;
  }

  function isEnemyCell(s, b, px, py) {
    var c = Math.floor(px), r = Math.floor(py);
    if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return false;
    return s.owner[r * COLS + c] !== b.team;
  }

  function hitCell(s, b, px, py) {
    var c0 = Math.floor(px), r0 = Math.floor(py);
    var R = b.big ? Math.max(CFG.hitRadius, 1.5) : CFG.hitRadius, n = Math.ceil(R);
    for (var dr = -n; dr <= n; dr++) for (var dc = -n; dc <= n; dc++) {
      if (Math.hypot(dc, dr) <= R + 1e-9) flip(s, c0 + dc, r0 + dr, b.team);
    }
    s.events.push({ type: 'hit', x: px, y: py, team: b.team });
  }

  function moveBall(s, b, dt) {
    var nx = b.x + b.vx * dt;
    var px = nx + (b.vx >= 0 ? 1 : -1) * b.r;
    if (isEnemyCell(s, b, px, b.y)) { hitCell(s, b, px, b.y); b.vx = -b.vx; nx = b.x; }
    b.x = nx;
    var ny = b.y + b.vy * dt;
    var py = ny + (b.vy >= 0 ? 1 : -1) * b.r;
    if (isEnemyCell(s, b, b.x, py)) { hitCell(s, b, b.x, py); b.vy = -b.vy; ny = b.y; }
    b.y = ny;
  }

  function ownWall(s, b, k) {
    var dir = k === 0 ? 1 : -1;
    var dist = k === 0 ? b.x - b.r : COLS - (b.x + b.r);
    if (dist > PADW) return;
    var pad = s.pad[k], half = CFG.paddleH / 2 + CFG.paddleTol;
    if (Math.abs(b.y - pad.y) <= half) {
      deflect(s, b, pad, half, dir);
      b.x = k === 0 ? PADW + b.r : COLS - PADW - b.r;
      s.stats.saves[k]++;
      s.events.push({ type: 'save', x: b.x, y: b.y, team: k });
      return;
    }
    if (dist <= 0) {
      b.dead = true;
      s.stats.misses[k]++;
      s.events.push({ type: 'miss', x: k === 0 ? 0 : COLS, y: b.y, team: k });
    }
  }

  function spawnTile(s) {
    var type = TYPES[(s.rng() * TYPES.length) | 0];
    var under = -1, d = s.share[0] - s.share[1];
    if (Math.abs(d) > CFG.leadGap) under = d > 0 ? 1 : 0;
    var x = 0, y = 0;
    for (var i = 0; i < 80; i++) {
      var c = 3 + ((s.rng() * (COLS - 6)) | 0), r = 2 + ((s.rng() * (ROWS - 4)) | 0);
      x = c + 0.5; y = r + 0.5;
      if (under < 0 || s.owner[r * COLS + c] === under) break;
    }
    s.tiles.push({ id: s.nextId++, type: type, x: x, y: y, born: s.t, life: CFG.puLife });
    s.events.push({ type: 'tile', x: x, y: y });
  }

  function applyPower(s, type, team) {
    s.stats.tiles[team]++;
    s.events.push({ type: 'banner', text: NAMES[type], team: team });
    var pad = s.pad[team];
    if (type === 'fortify') {
      for (var i = 0; i < N; i++) if (s.owner[i] === team) s.fortUntil[i] = s.t + CFG.fortifyTime;
    } else if (type === 'tidal') {
      s.waves.push({ team: team, row: pad.y, front: 0 });
    } else if (type === 'wormhole') {
      var a, b2, tries = 0;
      do {
        a = { x: 3 + s.rng() * (COLS - 6), y: 3 + s.rng() * (ROWS - 6) };
        b2 = { x: 3 + s.rng() * (COLS - 6), y: 3 + s.rng() * (ROWS - 6) };
        tries++;
      } while (Math.hypot(a.x - b2.x, a.y - b2.y) < 8 && tries < 40);
      s.portals = { a: a, b: b2, until: s.t + CFG.wormholeTime };
    } else if (type === 'turret') {
      s.turretUntil[team] = s.t + CFG.turretTime;
      s.turretNext[team] = s.t;
    } else if (type === 'infiltrator') {
      spawnBall(s, team, team === 0 ? PADW + 1 : COLS - PADW - 1, pad.y, true);
    } else if (type === 'eclipse') {
      s.ghostUntil[team] = s.t + CFG.ghostTime;
    }
  }

  function reflectY(y, vy, tt, r) {
    var h = ROWS - 2 * r;
    var yy = y - r + vy * Math.max(tt, 0);
    var m = ((yy % (2 * h)) + 2 * h) % (2 * h);
    return (m <= h ? m : 2 * h - m) + r;
  }

  function botThink(s, k, dt) {
    var bot = s.bots[k], L = LEVELS[bot.level];
    bot.timer -= dt;
    if (bot.timer <= 0) {
      bot.timer = L.react;
      var plane = k === 0 ? PADW : COLS - PADW, best = null, bt = 1e9;
      for (var i = 0; i < s.balls.length; i++) {
        var b = s.balls[i];
        if (b.team !== k) continue;
        var toward = k === 0 ? b.vx < 0 : b.vx > 0;
        if (!toward) continue;
        var tt = (k === 0 ? b.x - b.r - plane : plane - (b.x + b.r)) / Math.abs(b.vx);
        if (tt < bt) { bt = tt; best = b; }
      }
      if (best) {
        if (best.id !== bot.lastId) {
          bot.lastId = best.id;
          bot.aimOff = (s.rng() * 2 - 1) * (CFG.paddleH / 2) * 0.6;
        }
        var hidden = s.ghostUntil[1 - k] > s.t && best.team !== k;
        var err = hidden ? L.err * 2.5 : L.err;
        bot.target = reflectY(best.y, best.vy, bt, best.r) + (s.rng() * 2 - 1) * err + bot.aimOff;
      } else {
        bot.target = ROWS / 2;
      }
    }
    s.pad[k].target = bot.target;
  }

  function finish(s, w) {
    s.over = true; s.phase = 'over'; s.winner = w;
    s.events.push({ type: 'end' });
  }

  function step(s, dt) {
    if (s.over) return;
    for (var k = 0; k < 2; k++) if (s.bots[k]) botThink(s, k, dt);
    for (k = 0; k < 2; k++) {
      var p = s.pad[k];
      var sp = s.bots[k] ? LEVELS[s.bots[k].level].speed : CFG.paddleSpeed;
      var dy = clamp(p.target - p.y, -sp * dt, sp * dt);
      p.y = clamp(p.y + dy, CFG.paddleH / 2, ROWS - CFG.paddleH / 2);
    }
    if (s.phase === 'countdown') {
      s.cd -= dt;
      if (s.cd <= 0) { s.phase = 'play'; s.t = 0; }
      return;
    }
    s.t += dt;

    if (s.balls.some(function (b) { return b.expires <= s.t; })) {
      s.balls = s.balls.filter(function (b) { return b.expires > s.t; });
    }
    s.tiles = s.tiles.filter(function (tl) { return s.t - tl.born < tl.life; });
    if (s.portals && s.t >= s.portals.until) s.portals = null;

    if (s.t >= s.nextTile) {
      if (s.tiles.length < CFG.puMax) spawnTile(s);
      s.nextTile = s.t + CFG.puEvery + rnd(s, -CFG.puJitter, CFG.puJitter);
    }

    for (k = 0; k < 2; k++) {
      if (s.t < s.turretUntil[k] && s.t >= s.turretNext[k]) {
        s.turretNext[k] += CFG.turretEvery;
        s.shots.push({ team: k, x: k === 0 ? PADW + 0.2 : COLS - PADW - 0.2, y: s.pad[k].y, dir: k === 0 ? 1 : -1 });
      }
    }
    var i, c, r;
    for (i = 0; i < s.shots.length; i++) {
      var sh = s.shots[i];
      sh.x += sh.dir * CFG.shotSpeed * dt;
      c = Math.floor(sh.x); r = Math.floor(sh.y);
      if (c < 0 || c >= COLS) { sh.dead = true; continue; }
      var ci = r * COLS + c;
      if (s.owner[ci] !== sh.team) {
        if (s.fortUntil[ci] <= s.t) {
          for (var dr = -1; dr <= 1; dr++) for (var dc = -1; dc <= 1; dc++) flip(s, c + dc, r + dr, sh.team);
        }
        sh.dead = true;
      }
    }
    if (s.shots.some(function (q) { return q.dead; })) s.shots = s.shots.filter(function (q) { return !q.dead; });

    for (i = 0; i < s.waves.length; i++) {
      var w = s.waves[i], prev = w.front;
      w.front += CFG.tidalSpeed * dt;
      for (c = 0; c < COLS; c++) {
        var dist = w.team === 0 ? c + 0.5 : COLS - (c + 0.5);
        if (dist > prev && dist <= w.front) {
          for (r = 0; r < ROWS; r++) if (Math.abs(r + 0.5 - w.row) <= CFG.tidalHalf) flip(s, c, r, w.team);
        }
      }
    }
    if (s.waves.some(function (q) { return q.front >= COLS + 1; })) s.waves = s.waves.filter(function (q) { return q.front < COLS + 1; });

    var mul = 1 + CFG.rampPct * Math.floor(s.t / CFG.rampEvery);
    for (i = 0; i < s.balls.length; i++) {
      var b = s.balls[i];
      var sp0 = Math.hypot(b.vx, b.vy) || 1, tg = CFG.ballSpeed * mul;
      b.vx *= tg / sp0; b.vy *= tg / sp0;
      if (b.cd > 0) b.cd -= dt;
      moveBall(s, b, dt);
      if (b.y < b.r) { b.y = b.r; b.vy = Math.abs(b.vy); }
      else if (b.y > ROWS - b.r) { b.y = ROWS - b.r; b.vy = -Math.abs(b.vy); }
      var towardOwn = b.team === 0 ? b.vx < 0 : b.vx > 0;
      if (towardOwn) ownWall(s, b, b.team);
      else if (b.team === 0 && b.x + b.r >= COLS) { b.x = COLS - b.r; b.vx = -Math.abs(b.vx); }
      else if (b.team === 1 && b.x - b.r <= 0) { b.x = b.r; b.vx = Math.abs(b.vx); }
      if (b.dead) continue;
      if (s.portals && b.cd <= 0) {
        var pa = s.portals.a, pb = s.portals.b;
        if (Math.hypot(b.x - pa.x, b.y - pa.y) < 0.8) { b.x = pb.x; b.y = pb.y; b.cd = 0.7; s.events.push({ type: 'portal', x: pb.x, y: pb.y }); }
        else if (Math.hypot(b.x - pb.x, b.y - pb.y) < 0.8) { b.x = pa.x; b.y = pa.y; b.cd = 0.7; s.events.push({ type: 'portal', x: pa.x, y: pa.y }); }
      }
    }
    if (s.balls.some(function (q) { return q.dead; })) s.balls = s.balls.filter(function (q) { return !q.dead; });

    for (i = 0; i < s.balls.length; i++) {
      var bb = s.balls[i];
      for (var j = 0; j < s.tiles.length; j++) {
        var tl = s.tiles[j];
        if (Math.abs(bb.x - tl.x) < 0.85 && Math.abs(bb.y - tl.y) < 0.85) {
          s.tiles.splice(j, 1);
          s.events.push({ type: 'pickup', x: tl.x, y: tl.y, team: bb.team });
          applyPower(s, tl.type, bb.team);
          break;
        }
      }
    }

    countShares(s);

    for (k = 0; k < 2; k++) {
      var cnt = teamCount(s, k), px = k === 0 ? PADW + 1 : COLS - PADW - 1;
      if (cnt === 0) {
        s.emptyFor[k] += dt;
        if (s.emptyFor[k] >= CFG.respawnDelay) { spawnBall(s, k, px, s.pad[k].y, false); s.emptyFor[k] = 0; }
      } else s.emptyFor[k] = 0;
      if (s.share[k] < CFG.catchupShare) s.lowFor[k] += dt; else s.lowFor[k] = 0;
      if (s.lowFor[k] >= CFG.catchupHold && s.t >= s.lastCatchup[k] + CFG.catchupCooldown && cnt < CFG.ballMax) {
        spawnBall(s, k, px, s.pad[k].y, false);
        s.lastCatchup[k] = s.t; s.lowFor[k] = 0;
        s.stats.catchups[k]++;
        s.events.push({ type: 'banner', text: 'Bonus ball', team: k });
      }
    }

    if (s.share[0] >= CFG.winShare) finish(s, 0);
    else if (s.share[1] >= CFG.winShare) finish(s, 1);
    else if (s.phase === 'play' && s.t >= CFG.roundTime) {
      if (Math.abs(s.share[0] - s.share[1]) <= CFG.tieMargin) {
        s.phase = 'sudden'; s.suddenEnd = s.t + CFG.suddenTime;
        s.events.push({ type: 'banner', text: 'Sudden death', team: -1 });
      } else finish(s, s.share[0] > s.share[1] ? 0 : 1);
    } else if (s.phase === 'sudden' && s.t >= s.suddenEnd) {
      finish(s, s.counts[0] === s.counts[1] ? -1 : (s.counts[0] > s.counts[1] ? 0 : 1));
    }
  }

  root.TPSim = { createSim: createSim, step: step, COLS: COLS, ROWS: ROWS, N: N, PADW: PADW, CFG: CFG, TYPES: TYPES, NAMES: NAMES, LEVELS: LEVELS };
})(typeof module !== "undefined" && module.exports ? module.exports : (typeof window !== "undefined" ? window : globalThis));
