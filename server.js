'use strict';
/*
 * Territory Paddle server.
 * - Runs the same rules code as the browser (shared/sim.js) as the single source of truth.
 * - One room per match, joined with a 4-letter code.
 * - Simulation steps at 60 Hz, snapshots go out at 20 Hz.
 * - Clients only send where their paddle should be. The server clamps the speed.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const Sim = require('./shared/sim.js').TPSim;

const { CFG, COLS, ROWS, N } = Sim;
if (process.env.ROUND_TIME) CFG.roundTime = Number(process.env.ROUND_TIME);   // for testing only
const PORT = Number(process.env.PORT) || 3000;
const GRACE_MS = Number(process.env.GRACE_MS) || 10000;     // time a dropped player has to rejoin before they forfeit
const EMPTY_ROOM_MS = 30000;                                // delete a room nobody has joined for this long
const STEP = 1 / 60;
const SNAP_EVERY = 0.05;                                    // 20 snapshots per second
const MAX_MSGS_PER_SEC = 120;
const SEEN_SLACK = 10;                                      // how far a reported paddle may sit from the server's copy
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/* ---------- static files (only these routes are served) ---------- */
const FILES = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/index.html': ['public/index.html', 'text/html; charset=utf-8'],
  '/sim.js': ['shared/sim.js', 'text/javascript; charset=utf-8']
};
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  const f = FILES[url];
  if (!f) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
  fs.readFile(path.join(__dirname, f[0]), (err, buf) => {
    if (err) { res.writeHead(500); res.end('Server error'); return; }
    res.writeHead(200, { 'Content-Type': f[1], 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2048 });

/* ---------- helpers ---------- */
const rooms = new Map();
let waiting = null;                  // public room with one player looking for a random opponent
const r2 = (v) => Math.round(v * 100) / 100;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }
function newCode() {
  for (let tries = 0; tries < 200; tries++) {
    let c = '';
    for (let i = 0; i < 4; i++) c += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!rooms.has(c)) return c;
  }
  return null;
}
function pack(test) {
  const bytes = Buffer.alloc(Math.ceil(N / 8));
  for (let i = 0; i < N; i++) if (test(i)) bytes[i >> 3] |= 1 << (i & 7);
  return bytes.toString('base64');
}
function snapshot(s, events) {
  const rem = (until) => Math.max(0, r2(until - s.t));
  return {
    t: 'snap', st: r2(s.t), ph: s.phase, cd: r2(s.cd), se: r2(s.suddenEnd),
    own: pack((i) => s.owner[i] === 1),
    fort: pack((i) => s.fortUntil[i] > s.t),
    pad: [r2(s.pad[0].y), r2(s.pad[1].y)],
    balls: s.balls.map((b) => { const v = b.show || b; return [b.id, r2(v.x), r2(v.y), r2(v.vx), r2(v.vy), b.team, b.big ? 1 : 0]; }),
    tiles: s.tiles.map((t) => [t.type, t.x, t.y, rem(t.born + t.life)]),
    waves: s.waves.map((w) => [w.team, r2(w.row), r2(w.front)]),
    shots: s.shots.map((q) => [q.team, r2(q.x), r2(q.y), q.dir]),
    portals: s.portals ? [s.portals.a.x, s.portals.a.y, s.portals.b.x, s.portals.b.y, rem(s.portals.until)] : null,
    ghost: [rem(s.ghostUntil[0]), rem(s.ghostUntil[1])],
    turret: [rem(s.turretUntil[0]), rem(s.turretUntil[1])],
    share: [r2(s.share[0]), r2(s.share[1])],
    ev: events
  };
}

/* ---------- rooms ---------- */
class Room {
  constructor(code, pub) {
    this.code = code;
    this.pub = !!pub;                // created by "find an opponent" rather than shared by code
    this.players = [null, null];     // { ws, token, connected, goneAt, rematch }
    this.sim = null;
    this.timer = null;
    this.state = 'lobby';            // lobby | playing | ended
    this.acc = 0; this.snapAcc = 0; this.last = 0; this.evq = [];
    this.forfeit = -1;               // team that dropped out, or -1
    this.createdAt = Date.now();
  }
  count() { return this.players.filter(Boolean).length; }
  connectedCount() { return this.players.filter((p) => p && p.connected).length; }
  broadcast(obj) { const msg = JSON.stringify(obj); for (const p of this.players) if (p && p.connected && p.ws.readyState === 1) p.ws.send(msg); }
  start() {
    this.stopTimer();
    this.sim = Sim.createSim(crypto.randomInt(0, 2 ** 32), [null, null]);
    this.sim.lagComp = [0, 1].map((k) => (t) => this.seenPaddle(k, t));
    this.state = 'playing';
    this.acc = 0; this.snapAcc = 0; this.evq = []; this.last = Date.now(); this.forfeit = -1;
    for (const p of this.players) if (p) { p.rematch = false; p.seen = []; }
    this.broadcast({ t: 'restart' });
    this.timer = setInterval(() => this.tick(), 16);
  }
  // Where player k's paddle was on their own screen when it showed sim time t.
  // ready is false until a report for that moment has arrived.
  seenPaddle(k, t) {
    const p = this.players[k];
    if (!p || !p.connected || !p.seen || !p.seen.length) return null;
    const h = p.seen, last = h[h.length - 1];
    if (last[0] < t) {
      // not reported yet: move the last known paddle toward where the player is aiming
      const pad = this.sim.pad[k], reach = CFG.paddleSpeed * (t - last[0]);
      const y = last[1] + clamp(pad.target - last[1], -reach, reach);
      return { ready: false, y: clamp(y, CFG.paddleH / 2, ROWS - CFG.paddleH / 2) };
    }
    let i = 0;
    while (h[i][0] < t) i++;
    if (i === 0) return { ready: true, y: h[0][1] };
    const a = h[i - 1], b = h[i], f = (t - a[0]) / (b[0] - a[0] || 1);
    return { ready: true, y: a[1] + (b[1] - a[1]) * f };
  }
  stopTimer() { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
  checkForfeit(now) {                // a player gone longer than the grace period loses the match
    if (this.sim.over) return;
    for (let k = 0; k < 2; k++) {
      const p = this.players[k];
      if (p && !p.connected && now - p.goneAt > GRACE_MS) {
        const s = this.sim;
        s.over = true; s.phase = 'over'; s.winner = 1 - k;
        this.forfeit = k;
        return;
      }
    }
  }
  endMsg() {
    const s = this.sim;
    return { t: 'end', winner: s.winner, share: s.share.map(r2), tm: r2(s.t), stats: s.stats, forfeit: this.forfeit };
  }
  tick() {
    const s = this.sim, now = Date.now();
    let dt = (now - this.last) / 1000; this.last = now;
    if (dt > 0.25) dt = 0.25;
    this.acc += dt;
    this.checkForfeit(now);
    while (this.acc >= STEP && !s.over) {
      Sim.step(s, STEP);
      this.acc -= STEP;
      const ev = s.events; s.events = [];
      for (const e of ev) if (this.evq.length < 60) this.evq.push(e);
    }
    this.snapAcc += dt;
    if (this.snapAcc >= SNAP_EVERY || s.over) {
      this.snapAcc = this.snapAcc >= 2 * SNAP_EVERY ? 0 : this.snapAcc - SNAP_EVERY;   // keep the remainder so the average stays at 20 Hz
      this.broadcast(snapshot(s, this.evq));
      this.evq = [];
    }
    if (s.over) {
      this.stopTimer();
      this.state = 'ended';
      this.broadcast(this.endMsg());
    }
  }
  destroy() { this.stopTimer(); rooms.delete(this.code); if (waiting === this) waiting = null; }
}

/* clean up rooms nobody is in */
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.connectedCount() === 0) {
      const gone = room.players.reduce((m, p) => (p ? Math.max(m, p.goneAt || room.createdAt) : m), room.createdAt);
      if (now - gone > EMPTY_ROOM_MS) room.destroy();
    }
  }
}, 5000);

/* ---------- connections ---------- */
function leaveRoom(ws, voluntary) {
  const m = ws.meta;
  const room = m.room;
  if (!room) return;
  const team = m.team, p = room.players[team];
  m.room = null; m.team = -1;
  if (!p || p.ws !== ws) return;
  p.connected = false; p.goneAt = Date.now();
  const other = room.players[1 - team];
  if (room.state === 'lobby') {                      // nobody to play yet, so the room ends
    if (!other) { room.destroy(); return; }
    room.players[team] = null;
    return;
  }
  if (voluntary) {                                   // left on purpose: no grace period
    p.goneAt = 0;
  }
  if (other) send(other.ws, { t: 'opp', status: room.state === 'ended' ? 'left' : 'away' });
}

function createRoom(ws, pub) {
  const m = ws.meta;
  if (m.room) leaveRoom(ws, true);
  const code = newCode();
  if (!code) { send(ws, { t: 'error', msg: 'Server busy' }); return null; }
  const room = new Room(code, pub);
  const token = crypto.randomBytes(8).toString('hex');
  room.players[0] = { ws, token, connected: true, goneAt: 0, rematch: false };
  rooms.set(code, room);
  m.room = room; m.team = 0;
  send(ws, { t: 'room', code, team: 0, token, players: 1, pub: room.pub, cfg: { roundTime: CFG.roundTime } });
  return room;
}
function joinRoom(ws, room) {
  const m = ws.meta;
  if (m.room) leaveRoom(ws, true);
  const token = crypto.randomBytes(8).toString('hex');
  room.players[1] = { ws, token, connected: true, goneAt: 0, rematch: false };
  m.room = room; m.team = 1;
  send(ws, { t: 'room', code: room.code, team: 1, token, players: 2, pub: room.pub, cfg: { roundTime: CFG.roundTime } });
  room.broadcast({ t: 'lobby', players: 2 });
  room.start();
}

wss.on('connection', (ws) => {
  ws.meta = { room: null, team: -1, n: 0, windowStart: Date.now() };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    const m = ws.meta, now = Date.now();
    if (now - m.windowStart > 1000) { m.windowStart = now; m.n = 0; }
    if (++m.n > MAX_MSGS_PER_SEC) { ws.close(1008, 'Too many messages'); return; }
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === 'input') {
      const room = m.room;
      if (!room || !room.sim || room.state !== 'playing') return;
      if (typeof msg.y !== 'number' || !isFinite(msg.y)) return;
      room.sim.pad[m.team].target = clamp(msg.y, 0, ROWS);
      // where the paddle was drawn on the player's screen, and the sim time that screen showed
      const p = room.players[m.team], s = room.sim;
      if (typeof msg.py === 'number' && isFinite(msg.py) && typeof msg.vt === 'number' && isFinite(msg.vt) && msg.vt <= s.t + 0.1) {
        const h = p.seen || (p.seen = []);
        if (h.length && msg.vt < h[h.length - 1][0]) return;
        const py = clamp(msg.py, s.pad[m.team].y - SEEN_SLACK, s.pad[m.team].y + SEEN_SLACK);   // stay near the real paddle
        h.push([msg.vt, clamp(py, CFG.paddleH / 2, ROWS - CFG.paddleH / 2)]);
        if (h.length > 90) h.shift();
      }
      return;
    }
    if (msg.t === 'create') { createRoom(ws, false); return; }
    if (msg.t === 'find') {
      const host = waiting && waiting.state === 'lobby' && !waiting.players[1] && waiting.players[0];
      if (host && host.connected && host.ws !== ws) { const room = waiting; waiting = null; joinRoom(ws, room); return; }
      const room = createRoom(ws, true);
      if (room) waiting = room;
      return;
    }
    if (msg.t === 'join') {
      const code = String(msg.code || '').toUpperCase().slice(0, 4);
      const room = rooms.get(code);
      if (!room) { send(ws, { t: 'error', msg: 'Room not found' }); return; }
      if (room.players[1] || room.state !== 'lobby') { send(ws, { t: 'error', msg: 'Room full' }); return; }
      if (waiting === room) waiting = null;
      joinRoom(ws, room);
      return;
    }
    if (msg.t === 'rejoin') {
      const room = rooms.get(String(msg.code || '').toUpperCase().slice(0, 4));
      const team = room ? room.players.findIndex((p) => p && p.token === msg.token) : -1;
      if (!room || team < 0) { send(ws, { t: 'error', msg: 'Match not found', fatal: true }); return; }
      const p = room.players[team];
      if (p.ws !== ws && p.ws.readyState === 1) p.ws.close(1000, 'Replaced');
      p.ws = ws; p.connected = true; p.goneAt = 0;
      m.room = room; m.team = team;
      send(ws, { t: 'room', code: room.code, team, token: p.token, players: room.count(), pub: room.pub, cfg: { roundTime: CFG.roundTime } });
      const other = room.players[1 - team];
      if (other) send(other.ws, { t: 'opp', status: 'back' });
      if (room.state === 'ended') send(ws, room.endMsg());
      return;
    }
    if (msg.t === 'rematch') {
      const room = m.room;
      if (!room || room.state !== 'ended') return;
      room.players[m.team].rematch = true;
      const other = room.players[1 - m.team];
      if (other && other.connected) send(other.ws, { t: 'opp', status: 'rematch' });
      if (room.players.every((p) => p && p.connected && p.rematch)) room.start();
      return;
    }
    if (msg.t === 'leave') { leaveRoom(ws, true); return; }
  });

  ws.on('close', () => leaveRoom(ws, false));
  ws.on('error', () => {});
});

/* drop connections that stopped answering */
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; ws.ping();
  }
}, 20000);

server.listen(PORT, () => console.log('Territory Paddle server on port ' + PORT));
