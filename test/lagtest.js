// Two "perfect" players behind a laggy connection. Each keeps the paddle it sees on screen
// under its own ball, the way a good human would, so every miss the server records is one
// the player would see as an unfair miss.
const WebSocket = require('ws');
const URL = process.env.URL || 'ws://localhost:3100/ws';
const LAG = Number(process.env.LAG || 50);            // one-way delay in ms
const SECS = Number(process.env.SECS || 40);
const RENDER_DELAY = 100, SPEED = 30, PADH = 6, ROWS = 40, COLS = 24, PADW = 0.8, HALF = 3.5;
const REACT = Number(process.env.REACT || 2.5);   // cells from the wall where the player starts moving
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function player(name) {
  const p = { name, snaps: [], pad: ROWS / 2, team: -1, saves: 0, misses: 0, room: null, last: {}, still: {}, stops: 0, jumps: 0 };
  p.ws = new WebSocket(URL);
  p.open = new Promise((r) => p.ws.on('open', r));
  p.ws.on('message', (d) => setTimeout(() => {
    const m = JSON.parse(d);
    if (m.t === 'room') { p.room = m; p.team = m.team; }
    if (m.t === 'restart') p.snaps = [];
    if (m.t !== 'snap') return;
    p.snaps.push({ rt: Date.now(), d: m }); if (p.snaps.length > 10) p.snaps.shift();
    if (m.ph === 'play' || m.ph === 'sudden') for (const q of m.balls) {
      const o = p.last[q[0]];
      if (o) {
        const d = Math.hypot(q[1] - o[1], q[2] - o[2]);
        p.still[q[0]] = d < 0.01 ? (p.still[q[0]] || 0) + 1 : 0;
        if (p.still[q[0]] === 3) p.stops++;
        if (d > 1.5) p.jumps++;
      }
      p.last[q[0]] = q;
    }
    for (const e of m.ev) if (e.team === p.team && (e.type === 'save' || e.type === 'miss')) { p.events.push(e.type); if (e.type === 'miss') p.missEv.push(e); }
  }, LAG));
  p.send = (o) => setTimeout(() => { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(o)); }, LAG);
  p.judged = {}; p.screen = []; p.events = []; p.missEv = []; p.hist = [];
  p.tick = (dt) => {
    if (!p.snaps.length) return;
    const rt = Date.now() - RENDER_DELAY;
    let a = p.snaps[0], b = null;
    for (const s of p.snaps) { if (s.rt <= rt) a = s; else { b = s; break; } }
    const f = b ? Math.max(0, Math.min(1, (rt - a.rt) / (b.rt - a.rt))) : 0;
    const vt = a.d.st + (b ? f * (b.d.st - a.d.st) : 0);
    const mine = a.d.balls.filter((q) => q[5] === p.team).map((q) => {
      const o = b && b.d.balls.find((x) => x[0] === q[0]);
      const k = o ? f : 0, src = o || q;
      return { id: q[0], x: q[1] + (src[1] - q[1]) * k, y: q[2] + (src[2] - q[2]) * k, vx: q[3], nvx: o ? o[3] : null, gone: !!b && !o, r: q[6] ? 0.9 : 0.4 };
    });
    let target = p.pad;
    for (const q of mine) {
      const toward = p.team === 0 ? q.vx < 0 : q.vx > 0;
      const dist = p.team === 0 ? q.x - q.r : COLS - (q.x + q.r);
      if (!toward) { p.judged[q.id] = false; continue; }
      if (dist < REACT) target = q.y;                    // react late, like a person does
      // on screen the ball reaches the paddle during the step where it turns around or disappears
      const turns = q.gone || (q.nvx !== null && (p.team === 0 ? q.nvx > 0 : q.nvx < 0));
      if (turns && dist < 2.5 && !p.judged[q.id]) { p.judged[q.id] = true; p.screen.push(Math.abs(q.y - p.pad) <= HALF); (p.gap || (p.gap = [])).push(Math.abs(q.y - p.pad)); }
    }
    p.pad += Math.max(-SPEED * dt, Math.min(SPEED * dt, target - p.pad));
    p.pad = Math.max(PADH / 2, Math.min(ROWS - PADH / 2, p.pad));
    p.hist.push([vt, p.pad]);
    p.send({ t: 'input', y: target, py: p.pad, vt });
  };
  return p;
}

(async () => {
  const a = player('A'), b = player('B'); await a.open; await b.open;
  a.send({ t: 'create' }); await sleep(300 + LAG * 2);
  b.send({ t: 'join', code: a.room.code });
  const iv = setInterval(() => { a.tick(1 / 30); b.tick(1 / 30); }, 33);
  await sleep(SECS * 1000);
  clearInterval(iv);
  // A miss is unfair when the paddle this player saw was over the ball at the moment the ball reached it.
  let unfair = 0, misses = 0, saves = 0;
  for (const p of [a, b]) {
    saves += p.events.filter((e) => e === 'save').length;
    for (const e of p.missEv) {
      misses++;
      const at = e.at, h = p.hist;
      let best = null;
      for (const q of h) if (best === null || Math.abs(q[0] - at) < Math.abs(best[0] - at)) best = q;
      if (best && Math.abs(best[0] - at) < 0.05 && Math.abs(best[1] - e.y) <= HALF - 0.05) {
        unfair++;
        if (process.env.DEBUG) console.log('  unfair miss: ball', Math.abs(best[1] - e.y).toFixed(2), 'from paddle centre');
      }
    }
  }
  // both players watch both balls, so halve the counts
  console.log(`one-way lag ${LAG} ms: ${saves} saves, ${misses} misses, ${unfair} of them unfair; ball stopped ${(a.stops + b.stops) / 2} times, jumped ${(a.jumps + b.jumps) / 2} times`);
  process.exit(0);
})();
