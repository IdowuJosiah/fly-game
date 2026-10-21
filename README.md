# Territory Paddle (multiplayer)

Two players, one ball each. Each ball roams its own territory, flips enemy cells it hits, and bounces back toward its owner's paddle. Own 85% of the board, or more at 2:00, to win.

The rules live in one file, `shared/sim.js`. The server runs it as the single source of truth and the browser runs the same file for bot matches, so the two can never drift apart.

## Run it

```bash
npm install
npm start            # http://localhost:3000
```

Open two browser tabs. In the first tab choose **Play a friend online** then **Create a room**. Type the 4-letter code into the second tab and join. Open the page on a phone with your computer's local network address to test touch controls.

Settings:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | 3000 | Port to listen on (hosting platforms set this for you) |
| `GRACE_MS` | 10000 | How long a dropped player has to rejoin before they forfeit and the match ends |
| `ROUND_TIME` | 120 | Round length in seconds, handy for quick tests |

## Files

```
server.js          HTTP + WebSocket server, rooms, 60 Hz simulation, 20 Hz snapshots
shared/sim.js      Game rules (pure functions, no network or browser code) and every tunable constant
public/index.html  Client: drawing, input, bot matches, online play
test/nettest.js    Scripted two-player test of the server
```

## How the networking works

- The server steps the simulation at 60 Hz and sends a snapshot to both players 20 times a second (about 580 bytes each, roughly 12 KB/s per player).
- Clients send only where their paddle should be (`{t:"input", y}`), up to about 30 times a second. The server clamps the paddle speed, ignores invalid values, and drops connections that send more than 120 messages a second.
- Your own paddle is drawn from local input so it never feels delayed. Balls and the other paddle are drawn about 100 ms behind the latest snapshot and interpolated, which hides network jitter.
- A player who disconnects has 10 seconds to rejoin (the page retries automatically and keeps a session token), which covers a brief network drop. After that the match ends and the player who stayed wins. Choosing **Back to menu** mid-match ends it straight away.
- The round length is sent to clients when they join, so changing it on the server is enough.

### Messages

| From | Message | Meaning |
| --- | --- | --- |
| client | `create` / `join {code}` / `rejoin {code, token}` | Enter a room |
| client | `input {y}` | Paddle target in board cells (0 to 40) |
| client | `rematch` / `leave` | Ask for another match, or leave |
| server | `room {code, team, token, players, cfg}` | You are in a room, as team 0 (indigo, left) or 1 (pink, right) |
| server | `snap {...}` | Full state: board bits, balls, paddles, power-ups, timer, events |
| server | `end {winner, share, tm, stats, forfeit}` | Match over. `forfeit` is the team that dropped out, or -1 |
| server | `opp {status}` | Opponent `away`, `back`, `rematch`, or `left` |
| server | `restart` / `error {msg}` | New match starting, or something went wrong |

## Deploying

### Render (free, no card needed)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/IdowuJosiah/fly-game)

Click the button, sign in with GitHub, and approve the blueprint in `render.yaml`. You get a `https://territory-paddle-xxxx.onrender.com` address. On the free plan the service goes to sleep after about 15 minutes with no visitors and takes around a minute to wake up, which also clears any open rooms. The paid Starter plan keeps it awake all the time.

### Fly.io (always on, needs a card)

```bash
fly launch --copy-config --no-deploy   # choose a unique app name if asked
fly deploy
```

`fly.toml` keeps one machine running at all times (`auto_stop_machines = "off"`), so rooms never get cut off by sleep.

### Notes

The server needs a host that keeps one Node process running, because the simulation loop runs inside it. Serverless functions (including Vercel functions) will not work for it. Fly.io, Railway and Render all fit: point them at this folder, use `npm start`, and they provide HTTPS, which the client automatically upgrades to `wss://`.

Rooms live in the memory of one process, so run a single instance for now. Pick the region closest to most of your players.

## Known limits and next steps

- No accounts, matchmaking queue, or match history yet. Supabase would suit accounts and history, kept out of the real-time loop.
- Snapshots send the whole board every time. Sending only changed cells would cut bandwidth if it ever matters.
- Rooms are lost if the server restarts.
- Eclipse Ghost is weak under the one-ball rule and needs a new effect (see the spec).
