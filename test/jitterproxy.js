// Sits between browsers and the game server and delays every message by LAG ms plus a random
// 0..JITTER ms, keeping order like TCP does, to imitate a shaky mobile connection.
// Usage: UPSTREAM=localhost:3000 PORT=3300 LAG=60 JITTER=60 node test/jitterproxy.js
const http = require('http');
const WebSocket = require('ws');
const UP = process.env.UPSTREAM || 'localhost:3000';
const LAG = Number(process.env.LAG || 60), JITTER = Number(process.env.JITTER || 60);

function delayed(sendFn) {
  let last = 0;
  return (data) => {
    const at = Math.max(last, Date.now() + LAG + Math.random() * JITTER);
    last = at;
    setTimeout(() => sendFn(data), at - Date.now());
  };
}
const server = http.createServer((req, res) => {
  http.get({ host: UP.split(':')[0], port: UP.split(':')[1], path: req.url }, (up) => {
    res.writeHead(up.statusCode, up.headers); up.pipe(res);
  }).on('error', () => { res.writeHead(502); res.end(); });
});
const wss = new WebSocket.Server({ server, path: '/ws' });
wss.on('connection', (client) => {
  const up = new WebSocket('ws://' + UP + '/ws');
  const queue = [];
  const toUp = delayed((d) => { if (up.readyState === 1) up.send(d); else queue.push(d); });
  const toClient = delayed((d) => { if (client.readyState === 1) client.send(d); });
  up.on('open', () => { while (queue.length) up.send(queue.shift()); });
  up.on('message', (d) => toClient(d.toString()));
  client.on('message', (d) => toUp(d.toString()));
  up.on('close', () => client.close()); client.on('close', () => up.close());
  up.on('error', () => {}); client.on('error', () => {});
});
server.listen(Number(process.env.PORT || 3300));
