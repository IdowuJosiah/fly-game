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
const GRACE_MS = Number(process.env.GRACE_MS) || 5000;      // the match pauses this long for a dropped player before they forfeit
const STALE_MS = 2000;                                      // no messages for this long counts as dropped (clients send ~30 a second)
const RESUME_MS = 1000;                                     // short hold after a player comes back, so both are ready
const EMPTY_ROOM_MS = 30000;                                // delete a room nobody has joined for this long
const LOBBY_KEEP_MS = 15 * 60 * 1000;                       // a code room waits this long for its creator to come back
const STEP = 1 / 60;
const SNAP_EVERY = 1 / 30;                                  // 30 snapshots per second
const SERVER_T0 = Date.now();                               // snapshots carry ms since this, so clients can pace them evenly
const MAX_MSGS_PER_SEC = 120;
const SEEN_SLACK = 10;                                      // how far a reported paddle may sit from the server's copy
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/* ---------- static files (only these routes are served) ---------- */
const FILES = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/index.html': ['public/index.html', 'text/html; charset=utf-8'],
  '/sim.js': ['shared/sim.js', 'text/javascript; charset=utf-8']
};
/* ---------- stats ---------- */
// Everything here lives in memory, so it resets when the server restarts or redeploys.
const STATS_KEY = process.env.STATS_KEY || '';               // /stats is off until this is set
const HERE_MS = 45000;                                      // a page that pinged within this long counts as on the site
const counts = { startedAt: Date.now(), matches: 0, finished: 0, forfeits: 0, peakOnline: 0, peakOnSite: 0, visitors: 0 };
const here = new Map();                                     // page id -> { at, mode }
function onSite() {
  const now = Date.now(), by = { menu: 0, bot: 0, online: 0 };
  let n = 0;
  for (const [id, h] of here) {
    if (now - h.at > HERE_MS) { here.delete(id); continue; }
    n++; if (by[h.mode] !== undefined) by[h.mode]++;
  }
  return { n, by };
}
function keyOk(given) {
  if (!STATS_KEY) return false;
  const a = Buffer.from(String(given || '')), b = Buffer.from(STATS_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function statsNow() {
  const site = onSite();
  let playing = 0, inMatches = 0, searching = 0, inRooms = 0;
  for (const room of rooms.values()) {
    const n = room.players.filter((p) => p && p.connected).length;
    if (room.state === 'playing') { playing++; inMatches += n; }
    else if (room.state === 'lobby') { if (room.pub) searching += n; else inRooms += n; }
  }
  counts.peakOnSite = Math.max(counts.peakOnSite, site.n);
  return {
    onSite: site.n, onSiteBy: site.by, online: wss.clients.size,
    matchesNow: playing, playersInMatches: inMatches, searching, waitingInRooms: inRooms,
    sinceStart: { since: new Date(counts.startedAt).toISOString(), visitors: counts.visitors, matchesStarted: counts.matches,
      matchesFinished: counts.finished, endedByDisconnect: counts.forfeits, peakOnSite: counts.peakOnSite, peakOnline: counts.peakOnline }
  };
}
function statsPage(st) {
  const row = (label, value) => `<tr><td>${label}</td><td>${value}</td></tr>`;
  const ago = Math.round((Date.now() - counts.startedAt) / 60000);
  const up = ago < 120 ? ago + ' min' : Math.round(ago / 60) + ' h';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><meta http-equiv="refresh" content="5"><title>stats</title><style>
body{margin:0;padding:24px 16px;background:#000;color:#fff;font:14px ui-monospace,Menlo,Consolas,monospace}
h1{font-size:18px;margin:0 0 4px}p{color:#8a8a8a;margin:0 0 20px;font-size:12px}
table{border-collapse:collapse;width:100%;max-width:360px;margin-bottom:24px}td{padding:6px 0;border-bottom:1px solid #222}
td:last-child{text-align:right}.big{font-size:40px;font-weight:700;line-height:1}h2{font-size:12px;color:#8a8a8a;font-weight:400;margin:0 0 6px}
</style></head><body><h1>territory paddle</h1><p>updates every 5 s</p>
<div class="big">${st.onSite}</div><p>on the site now</p>
<h2>right now</h2><table>
${row('on the site', st.onSite)}${row('&nbsp;&nbsp;in the menu', st.onSiteBy.menu)}${row('&nbsp;&nbsp;playing the bot', st.onSiteBy.bot)}${row('&nbsp;&nbsp;online', st.onSiteBy.online)}
${row('matches in progress', st.matchesNow)}${row('players in matches', st.playersInMatches)}${row('searching for an opponent', st.searching)}${row('waiting in a room', st.waitingInRooms)}
</table><h2>since the server started (${up} ago)</h2><table>
${row('visitors', st.sinceStart.visitors)}${row('online matches started', st.sinceStart.matchesStarted)}${row('online matches finished', st.sinceStart.matchesFinished)}
${row('ended by a disconnect', st.sinceStart.endedByDisconnect)}${row('most on the site at once', st.sinceStart.peakOnSite)}${row('most connected at once', st.sinceStart.peakOnline)}
</table></body></html>`;
}

const server = http.createServer((req, res) => {
  const full = new URL(req.url || '/', 'http://x'), url = full.pathname;
  if (url === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
  if (url === '/here' && req.method === 'POST') {          // pages say they are open every 20 s
    const id = full.searchParams.get('id') || '', mode = full.searchParams.get('m') || 'menu';
    if (/^[a-z0-9]{8,32}$/.test(id) && (here.has(id) || here.size < 20000)) {
      if (!here.has(id)) counts.visitors++;
      here.set(id, { at: Date.now(), mode: ['menu', 'bot', 'online'].includes(mode) ? mode : 'menu' });
      counts.peakOnSite = Math.max(counts.peakOnSite, onSite().n);
    }
    req.resume(); res.writeHead(204); res.end(); return;
  }
  if (url === '/stats') {
    if (!keyOk(full.searchParams.get('key'))) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
    const st = statsNow(), json = full.searchParams.get('format') === 'json';
    res.writeHead(200, { 'Content-Type': json ? 'application/json' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(json ? JSON.stringify(st) : statsPage(st));
    return;
  }
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
    t: 'snap', sv: Date.now() - SERVER_T0, st: r2(s.t), ph: s.phase, cd: r2(s.cd), se: r2(s.suddenEnd),
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
// connected and heard from recently (pages send a ping every second while in the room screen,
// and stop when the phone puts them in the background)
function live(p) { return !!p && p.connected && Date.now() - (p.lastSeen || 0) <= STALE_MS; }
class Room {
  constructor(code, pub) {
    this.code = code;
    this.pub = !!pub;                // created by "find an opponent" rather than shared by code
    this.players = [null, null];     // { ws, token, connected, goneAt, lastSeen, stale, rematch }
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
    counts.matches++;
    this.acc = 0; this.snapAcc = 0; this.evq = []; this.last = Date.now(); this.forfeit = -1; this.resumeAt = 0;
    for (const p of this.players) if (p) { p.rematch = false; p.seen = []; p.lastSeen = Date.now(); p.stale = false; }
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
  // A player who disconnected, or has sent nothing for a while, pauses the match. Returns how many
  // ms are left to wait for them (0 if nobody is missing). Gone longer than GRACE_MS loses the match.
  checkAway(now) {
    if (this.sim.over) return 0;
    let left = 0;
    for (let k = 0; k < 2; k++) {
      const p = this.players[k];
      if (!p) continue;
      const since = !p.connected ? p.goneAt : (now - p.lastSeen > STALE_MS ? p.lastSeen + STALE_MS : null);
      const other = this.players[1 - k];
      if (since === null) {
        if (p.stale) { p.stale = false; this.resumeAt = now + RESUME_MS; if (other) send(other.ws, { t: 'opp', status: 'back' }); }
        continue;
      }
      if (p.connected && !p.stale) { p.stale = true; if (other) send(other.ws, { t: 'opp', status: 'away' }); }
      if (now - since > GRACE_MS) {
        const s = this.sim;
        s.over = true; s.phase = 'over'; s.winner = 1 - k;
        this.forfeit = k;
        return 0;
      }
      left = Math.max(left, GRACE_MS - (now - since));
    }
    return left;
  }
  endMsg() {
    const s = this.sim;
    return { t: 'end', winner: s.winner, share: s.share.map(r2), tm: r2(s.t), stats: s.stats, forfeit: this.forfeit };
  }
  tick() {
    const s = this.sim, now = Date.now();
    let dt = (now - this.last) / 1000; this.last = now;
    if (dt > 0.25) dt = 0.25;
    const wait = this.checkAway(now), resuming = now < this.resumeAt;
    if (wait || resuming) this.acc = 0;               // match is paused while someone is missing
    else this.acc += dt;
    while (this.acc >= STEP && !s.over) {
      Sim.step(s, STEP);
      this.acc -= STEP;
      const ev = s.events; s.events = [];
      for (const e of ev) if (this.evq.length < 60) this.evq.push(e);
    }
    this.snapAcc += dt;
    if (this.snapAcc >= SNAP_EVERY || s.over) {
      this.snapAcc = this.snapAcc >= 2 * SNAP_EVERY ? 0 : this.snapAcc - SNAP_EVERY;   // keep the remainder so the average stays at 30 Hz
      const snap = snapshot(s, this.evq);
      if (wait) snap.wt = Math.ceil(wait / 1000);
      else if (resuming) snap.rs = 1;
      this.broadcast(snap);
      this.evq = [];
    }
    if (s.over) {
      this.stopTimer();
      this.state = 'ended';
      counts.finished++; if (this.forfeit >= 0) counts.forfeits++;
      this.broadcast(this.endMsg());
    }
  }
  // start once both players are here; a friend may join while the creator is away sharing the code
  maybeStart() {
    if (this.state === 'lobby' && this.players.every(live)) {
      this.broadcast({ t: 'lobby', players: 2 });
      this.start();
    }
  }
  waitingForHost() { return this.state === 'lobby' && !!this.players[1] && !live(this.players[0]); }
  destroy() { this.stopTimer(); rooms.delete(this.code); if (waiting === this) waiting = null; }
}

/* clean up rooms nobody is in */
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.state === 'lobby' && !room.pub) {         // code rooms wait for their creator to come back
      const host = room.players[0];
      if (host && !host.connected && now - host.goneAt > LOBBY_KEEP_MS) {
        const friend = room.players[1];
        if (friend) send(friend.ws, { t: 'error', msg: 'Room expired', fatal: true });
        room.destroy();
      }
      continue;
    }
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
  if (room.state === 'lobby') {
    if (team === 1) { if (voluntary) room.players[1] = null; return; }
    if (voluntary || room.pub) {                     // cancelled, or a random search: the room ends
      if (other) send(other.ws, { t: 'error', msg: 'Room closed', fatal: true });
      room.destroy();
    }
    return;                                          // creator stepped away, e.g. to send the code: keep the room
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
  room.players[0] = { ws, token, connected: true, goneAt: 0, lastSeen: Date.now(), rematch: false };
  rooms.set(code, room);
  m.room = room; m.team = 0;
  send(ws, { t: 'room', code, team: 0, token, players: 1, pub: room.pub, cfg: { roundTime: CFG.roundTime } });
  return room;
}
function joinRoom(ws, room) {
  const m = ws.meta;
  if (m.room) leaveRoom(ws, true);
  const token = crypto.randomBytes(8).toString('hex');
  room.players[1] = { ws, token, connected: true, goneAt: 0, lastSeen: Date.now(), rematch: false };
  m.room = room; m.team = 1;
  send(ws, { t: 'room', code: room.code, team: 1, token, players: 2, pub: room.pub, wait: room.waitingForHost(), cfg: { roundTime: CFG.roundTime } });
  room.maybeStart();
}

wss.on('connection', (ws) => {
  counts.peakOnline = Math.max(counts.peakOnline, wss.clients.size);
  ws.meta = { room: null, team: -1, n: 0, windowStart: Date.now() };
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    const m = ws.meta, now = Date.now();
    if (now - m.windowStart > 1000) { m.windowStart = now; m.n = 0; }
    if (++m.n > MAX_MSGS_PER_SEC) { ws.close(1008, 'Too many messages'); return; }
    if (m.room) { const me = m.room.players[m.team]; if (me && me.ws === ws) me.lastSeen = now; }
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg || typeof msg.t !== 'string') return;

    if (msg.t === 'ping') { if (m.room && m.room.state === 'lobby') m.room.maybeStart(); return; }
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
      if ((room.players[1] && room.players[1].connected) || room.state !== 'lobby') { send(ws, { t: 'error', msg: 'Room full' }); return; }
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
      p.ws = ws; p.connected = true; p.goneAt = 0; p.lastSeen = Date.now(); p.stale = false;
      if (room.state === 'playing') room.resumeAt = Date.now() + RESUME_MS;
      m.room = room; m.team = team;
      send(ws, { t: 'room', code: room.code, team, token: p.token, players: room.count(), pub: room.pub, wait: room.waitingForHost(), cfg: { roundTime: CFG.roundTime } });
      const other = room.players[1 - team];
      if (other && room.state !== 'lobby') send(other.ws, { t: 'opp', status: 'back' });
      room.maybeStart();
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
