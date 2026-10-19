# Room server load test — October 2026

What happens to the room server when hundreds of bot tables run at once, each with a host playing and a few people watching, and then every socket drops and comes back at the same moment.

**Headline:** on one local `wrangler dev`, the five-game mix holds up comfortably to **~100 rooms (400 sockets)**. It reaches its limit at **~200 rooms**, where the runtime process sits at ~85% of a core. At **300 rooms (1,200 sockets)** the process is saturated, and a host's move takes 0.6–3.6 s to come back. No sockets failed and no errors were raised at any scale. The reconnect storm brought back every socket at every scale: 1,200 of 1,200 at 300 rooms, all within 4.5 s.

**Chess sets the cost.** Chess rooms are a fifth of the mix but use most of the CPU, because every move replays the whole game through chess.js. Two server issues turned up along the way:

- The room never answers a client's close frame, so a client-side close takes about 10 s to settle.
- Joins and departures each broadcast the full snapshot to every socket, so a room's reconnect storm costs O(sockets²) messages.

**Update 2026-10-20:** both bugs and the chess replay are fixed; see [After the fixes](#after-the-fixes-2026-10-20) at the end.

## How to run it

```sh
export PATH="$HOME/.nvm/versions/node/v22.23.2/bin:$PATH"        # wrangler and the script need Node 22
# A frozen copy of the code, so other people's saves don't hot-reload the server mid-run:
mkdir -p /tmp/lt && git archive HEAD backend shared package.json | tar -x -C /tmp/lt
ln -s "$PWD/node_modules" /tmp/lt/node_modules
mkdir -p /tmp/lt/backend/node_modules/@games && ln -s ../../../shared /tmp/lt/backend/node_modules/@games/shared
(cd /tmp/lt/backend && WRANGLER_SEND_METRICS=false "$OLDPWD/node_modules/.bin/wrangler" dev \
  --port 8797 --inspector-port 9239 --persist-to /tmp/lt-state --show-interactive-dev-session=false --log-level warn) &

node scripts/loadtest/loadtest.mjs --rooms 100 --sockets 4 --duration 30 --settle 10 --out /tmp/lt-100.json
```

The usage header in `scripts/loadtest/loadtest.mjs` lists every flag. A few rules:

- **Use your own port and `--persist-to`.** If you share the default `.wrangler/state`, the test's rooms and SQLite files land in the dev server you work against.
- **Restart wrangler between scales.** The observability store and the rooms pile up.
- **Never point the script at production.** It refuses non-loopback targets unless you pass `--i-know`. A real deployment would also rate-limit it: 20 room creations a minute per address (`backend/wrangler.jsonc`), and only loopback is exempt (`backend/src/limits.ts`).

## Setup

- **Machine:** Apple M3 Pro (12 cores), 18 GB RAM, macOS 26.7.1, Node 22.23.2, wrangler 4.131.1 (bundled workerd), all on one machine.
- **Code under test:** commit `9e73634`, exported with `git archive`. Other agents were editing `backend/src` during the test, and wrangler hot-reloads on every save. A reload drops every socket with code 1006, which happened in the first attempt.
- **Two workerd processes per server.** `wrangler dev` runs two of them: an entry proxy that listens on the port, and a sibling that runs the Worker and every Durable Object. The script samples both; in the tables, "busiest" is the runtime process.

**This is not a model of production.** Locally, all rooms share one process and one JS thread. In production each room is its own Durable Object and they are spread across Cloudflare's machines. So:

- **The saturation point here is not a production capacity.** It is the point where one core runs out.
- **The per-room and per-event costs do carry over:** CPU per move, bytes per snapshot, messages per storm and writes per beat.

### Method

Each run has five phases.

1. **Create.** `POST /api/rooms` for N rooms, spread round-robin over the five games, 25 requests in flight at a time. Every seat but the host's is a bot (`autoStart: true`):

   | Game     | Table             |
   | -------- | ----------------- |
   | chess    | 1 `easy` bot      |
   | hearth   | 3 `medium` bots   |
   | estate   | 3 `standard` bots |
   | prism    | 3 `medium` bots   |
   | wildrise | 3 `fast` bots     |

2. **Connect.** Each room gets M = 4 sockets: the host, whose join deals the game, then 3 spectators, each with their own guest id. 100 joins are in flight at a time.
3. **Steady (30 s).**
   - **The host plays like a browser would.** It reads the snapshot and makes a legal-looking move after a pause drawn uniformly from 0.75–2.25 s (`--think 1500`).
   - **How it picks moves:** a random legal move in chess (via the repo's chess.js); roll, then a random piece in hearth; a matching card or draw-then-pass in prism; roll / buy / end the turn in estate; roll in wildrise. When a game finishes, the host asks for a rematch, so every table keeps playing.
   - **Every socket sends `ping` every 20 s**, as `useRoom` does.
4. **Storm.** Every socket closes at once. The script waits up to 2 s for the closes to settle, then reopens all of them at the same moment with no jitter. That is worse than real clients, whose backoff starts at 1 s ± 25%.
5. **Settle (10 s).** Play continues, to show the tables recovered.

### Metrics

- **Join latency.** From socket open to the first `room` message.
- **Snapshot latency.** Receipt time minus the snapshot's `timing.now`; both clocks are on the same machine. workerd freezes `Date.now()` during a handler, so this measures from the start of the handler (or its last I/O) to the client. It does not include time a message spent waiting before its handler started.
- **Host action RTT.** From the host sending an action to the first snapshot whose state differs. This one does include queueing.
- **Span wall times.** From wrangler's local observability API (`POST /cdn-cgi/local/explorer/api/local/observability/query`, tables `spans` and `logs`), filtered to the run's time window. The span `attributes` are empty and the API exposes no CPU time, so these are **wall durations only**. Under contention they include time spent waiting behind other rooms. The API also returns at most 10,000 rows, so the script computes percentiles in SQLite with `ROW_NUMBER()`.
- **Process CPU.** From `ps -o time=` deltas once a second (100% = one core), plus RSS.

## Results — scale (5-game mix, 4 sockets per room, 1.5 s host think)

|                                                      | 20 rooms        | 100 rooms             | 200 rooms             | 300 rooms                       |
| ---------------------------------------------------- | --------------- | --------------------- | --------------------- | ------------------------------- |
| Sockets                                              | 80              | 400                   | 800                   | 1,200                           |
| Room create p50 / p95 ms                             | 75 / 78         | 77 / 139              | 72 / 98               | 76 / 117                        |
| Join (open→first snapshot) p50 / p95 / p99 ms        | 179 / 197 / 199 | 177 / 256 / 261       | 212 / 387 / 456       | 291 / 555 / 588                 |
| Snapshot latency (steady) p50 / p95 / p99 ms         | 1 / 3 / 5       | 1 / 5 / 29            | 5 / 51 / 127          | 8 / 69 / 118                    |
| **Host action RTT (steady)** p50 / p95 / p99 ms      | 3 / 8 / 15      | 4 / 38 / 70           | 38 / 327 / 435        | **643 / 2,887 / 3,565**         |
| Messages/s received (steady), mean size              | 81, 6.5 KB      | 407, 6.5 KB           | 774, 6.4 KB           | 964, 6.1 KB                     |
| Errors / unexpected closes / failed joins            | 0 / 0 / 0       | 0 / 0 / 0             | 0 / 0 / 0             | 0 / 0 / 0                       |
| Alarms/s (whole server)                              | 15              | 78                    | 149                   | 192 (should be ~225: saturated) |
| `alarm` span wall p50 / p95 / p99 ms                 | 2 / 32 / 50     | 2 / 41 / 82           | 21 / 139 / 231        | 45 / 204 / 424                  |
| `hibernatableWebSocket` span wall p50 / p95 / p99 ms | 2 / 6 / 7       | 2 / 11 / 31           | 6 / 55 / 92           | 12 / 87 / 128                   |
| `durable_object_storage_put` wall p95 ms             | 1               | 1                     | 1                     | 1                               |
| workerd CPU % (both, steady) p50 / p95               | 12 / 23         | 44 / 58               | 85 / 96               | 96 / 102                        |
| Busiest process CPU % p50                            | 12              | 43                    | 83                    | 94                              |
| workerd RSS max: steady / storm                      | 311 / 157 MB    | 380 / 559 MB          | 1,231 / 1,020 MB      | 895 / 1,483 MB                  |
| **Storm: reconnected**                               | 80 / 80         | 400 / 400             | 800 / 800             | 1,200 / 1,200                   |
| Storm: time to first snapshot p50 / p95 / max ms     | 150 / 173 / 177 | 1,315 / 1,486 / 1,495 | 1,454 / 1,797 / 1,828 | 2,963 / 3,710 / 4,433           |
| Storm: wall time until everyone was back             | 0.18 s          | 1.5 s                 | 1.8 s                 | 4.5 s                           |
| Storm: closes the server answered                    | 0 / 80          | 0 / 400               | 0 / 800               | 0 / 1,200                       |
| Host action RTT after storm (settle) p50 / p95 ms    | 4 / 14          | 15 / 156              | 19 / 114              | 404 / 866                       |
| Hosts silent > 10 s (after steady / at end)          | 0 / 0           | 0 / 0                 | 0 / 0                 | 0 / 0                           |
| Load generator CPU (whole run)                       | 1.5 s           | 5.1 s                 | 9.0 s                 | 11.3 s                          |

How to read the 300-room column:

- **Snapshot latency stays low while action RTT reaches seconds.** The backlog builds before the handler starts, in the runtime's event queue, and snapshot latency is measured from the handler's start.
- **The process is CPU-bound.** The runtime's single thread is at ~94%, and alarms fire late: the server handled ~192 a second against the ~225 the tables asked for.
- **The load generator was never the bottleneck.** It used under 0.4 s of CPU per second at 300 rooms.

### Wide rooms: 20 rooms × 24 sockets (the `MAX_ROOM_SOCKETS` cap)

| Metric        | Result                                                                                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Steady state  | Snapshot latency 2 / 6 / 7 ms (p50 / p95 / p99); host RTT 4 / 8 ms (p50 / p95)                                                                                      |
| Storm         | All 480 sockets back within 1.2–2.9 s                                                                                                                               |
| Storm traffic | ~5,900 messages, about **296 per room**. That is the k(k+1)/2 = 300 you expect when each of 24 joins broadcasts to everyone already in the room (see bottleneck 4). |

### Per game (20 rooms × 2 sockets, host plays instantly, 25 s)

This is a worst case: an instant host turns every table into a loop of bot turns as fast as the bots' pauses allow.

| Game           | workerd CPU % (mean) | Events/s (alarm + socket msg) | ≈ CPU per event | Alarms/s per room | Storage puts/s per room | Mean snapshot |
| -------------- | -------------------- | ----------------------------- | --------------- | ----------------- | ----------------------- | ------------- |
| chess (`easy`) | **91**               | 78                            | **~12 ms**      | 1.95              | 3.9                     | 8.8 KB        |
| hearth         | 6                    | 21                            | ~2.7 ms         | 0.94              | 1.05                    | 3.4 KB        |
| estate         | 3                    | 14                            | ~2.2 ms         | 0.53              | 0.71                    | 2.8 KB        |
| prism          | 6                    | 23                            | ~2.6 ms         | 0.84              | 1.14                    | **17.2 KB**   |
| wildrise       | 6                    | 34                            | ~1.7 ms         | 1.60              | 1.71                    | 3.2 KB        |

The per-event CPU for the light games includes the process's idle baseline of ~1–2%, so read those as upper bounds. A single chess room with an instant host uses **~95% of a core by itself**: 1,584 bot moves in 40 s, with an uncontended `alarm` wall time of 17 ms at p50.

Chess engine cost against game length, measured in Node 22 on the same V8, bot against bot, using the shared adapter (a scratch esbuild bundle, not committed):

| Plies played | `easy` decide | `medium` decide | `position()` replay | State size  |
| ------------ | ------------- | --------------- | ------------------- | ----------- |
| 1            | 12.6 ms       | **264 ms**      | 0.06 ms             | 2.4 KB      |
| 21           | 25.3 ms       | **375 ms**      | 0.87 ms             | 6.9 KB      |
| 51           | 6.0 ms        | 39 ms           | 1.7 ms              | 13.4 KB     |
| 101          | 11.9 ms       | 19 ms           | 4.9 ms              | 23.1 KB     |
| 201          | 21.8 ms       | 40 ms           | **9.2 ms**          | **42.0 KB** |

For comparison, building and serializing all five prism views (4 seats plus spectators) of a 21 KB state takes 0.24 ms.

## Bottlenecks

Line numbers below are as of `9e73634`. `room.ts` is under heavy edit, so search by function name.

1. **Chess replays the whole game on every move.** `position()` (`shared/src/chess/engine.ts:8`) builds a `Chess` from the initial FEN and replays `history`.
   - **Where it runs:** on every human move (`playMove`, `engine.ts:151`) and every bot decision (`ai.ts:78`). Per-move cost is O(plies), so a game costs O(plies²). The replay alone is 9 ms at ply 200, before any search.
   - **The bot search is heavy too.** It runs chess.js move generation at every node (`NODE_BUDGET`, `ai.ts:55`). `medium` spends 260–375 ms of CPU in the opening, in one alarm that blocks the room.
   - **The state grows ~200 B per ply** (`MoveRecord` keeps `before`/`after` FENs). It is rewritten whole on every save and sent whole to every socket.
2. **Every mutation and every presentation beat saves the whole record.** `save()` (`backend/src/room.ts:184`) does `storage.put('room', record)` plus `setAlarm`.
   - **The beats add up.** Wildrise runs about 4 alarms per turn (rolling → moving → transporting → settling), so a bot table writes ~1.7 records a second.
   - **Each write is cheap locally** (p95 1 ms), but in production every alarm is a billed invocation and every put rewrites the full state (17–42 KB for prism and long chess games).
3. **Broadcasts serialize per socket.** `broadcast()` (`room.ts:470`) builds one snapshot per viewpoint, but it calls `JSON.stringify` on the whole message once per socket (`room.ts:489`), because `you` is inside it.
   - **`snapshot()` repeats work too.** It calls `connectedIds()`, which deserializes every socket's attachment, once per viewpoint (`room.ts:428`, `405`), and `broadcast` deserializes them all again (`room.ts:475`).
   - **This is second-order today** (≈0.24 ms per prism beat at 4 sockets), but it scales as sockets × snapshot size: 24 × 17 KB is ~400 KB of stringify per beat.
4. **Joins and departures fan out quadratically.**
   - **Every join broadcasts the full snapshot to every socket** (`handleJoin`, `room.ts:578`), and so does every departure (`handleDeparture`, `room.ts:857`).
   - **When k sockets reconnect together**, the room sends ~k²/2 snapshots for the joins and the same again for the departures. A 24-socket prism room is ~576 messages, about 10 MB, per storm. The wide-room run measured ~296 messages per room for the joins alone.
5. **The global singleton objects are the first single-object limit in production.** Every live bot room calls `PRESENCE.getByName('global').reportBots` whenever its bot count changes, and again every 30 s (`room.ts:213`, `BOT_PRESENCE_REFRESH_MS`).
   - **Each call scans the whole table.** `reportBots` runs `DELETE FROM room_bots WHERE updated_at <= ?` (`backend/src/presence.ts:81`, again at `:132`), and there is no index on `updated_at`.
   - **That grows quadratically.** N live bot rooms means N/30 calls a second into one object, each scanning N rows. Public rooms do the same to `LOBBY` 'global'. This test made only private rooms, so the lobby was not exercised.
6. **Locally: one process, one thread.** The knee at ~200 rooms is this harness, not the design. It also means one chess `medium` search stalls every room on the machine, which is worth knowing when a local dev server feels sluggish.

## Bugs and oddities found

- **The room never answers a client's close frame.** `RoomDO.webSocketClose` (`room.ts:860`) records the departure but never calls `ws.close()`.
  - **The runtime didn't answer for it either.** `web_socket_auto_reply_to_close` is on by default from 2026-04-07 and the compatibility date is 2026-08-01, but with this workerd it sent no reply. 0 of 2,480 storm closes were answered at any scale. A client's `close()` settles only after ~10–12 s, as code 1006.
  - **Adding `ws.close(code)` inside `webSocketClose` fixes it.** I tested this in a scratch copy, not the repo: both host and spectator closes then completed in 2–5 ms with code 1000.
  - **Why it matters:** `useRoom` closes a socket that misses two pongs (`frontend/src/online/useRoom.ts:126`) and only schedules the reconnect in `onclose`. A slow but live connection therefore waits an extra ~10 s before it reconnects. The server also keeps half-closed sockets around in the meantime, which may contribute to the RSS jump during the storm (300 rooms: 0.9 → 1.5 GB).
  - **Check production before relying on this.** I only verified it locally. The fix is harmless either way if wrapped in `try`.
- **Two different states can carry the same `timing.since`.** `stateAt = Date.now()` (`room.ts:308`). Locally, a host's reply can land in the same millisecond as the alarm that produced the state it answers. Nothing in the frontend uses `since` as an identity (checked), so this is a note: if anything ever needs a state version, add a counter instead.
- **One unexplained mass drop.** In one of three runs of the 20 × 24 configuration, all 480 sockets dropped with 1006 early in steady state. It happened at the same moment as another `wrangler dev` session on this machine (the 8787 server) reloading, and two exact reruns did not reproduce it. I'm treating it as an artifact of the local environment: several wrangler sessions share a dev registry and serve the same `games-api` name. I'm not attributing it to `room.ts`.
- **Local alarm warnings.** Under load, workerd logs `NOSENTRY SQLite alarm overdue, running despite AlarmManager mismatch`. The alarms still fire and no table stalled: no host was silent for more than 10 s at any scale. This is local runtime noise.

## Recommendations

1. **Make chess moves O(1) in game length** (`shared/src/chess/engine.ts:8`, `:151`; `ai.ts:78`).
   - Options: memoize `position()` by state identity, and extend the cached `Chess` by one move in `playMove`; or carry repetition keys in the state and build from `fen`.
   - Either way, the replay stops being the floor under every move.
2. **Bound the bot search by time as well as nodes** (`ai.ts:55`).
   - A `medium` opening move costs 260–375 ms of CPU. A wall-clock cap of, say, 50 ms per decision, or a small opening book, removes the worst alarms.
   - Also consider dropping the `before`/`after` FENs from `MoveRecord` on the wire, or sending only the history delta. They double the state size.
3. **Serialize once per view, not once per socket** (`room.ts:479–489`).
   - Stringify the snapshot once, then splice in `you`, e.g. `'{"type":"room","you":' + JSON.stringify(you) + ',"snapshot":' + json + '}'`.
   - Compute `connectedIds()` once per broadcast and pass it into `snapshot()` (`room.ts:428`).
4. **Stop quadratic fan-out on join and leave** (`room.ts:578`, `:857`).
   - Send the full snapshot only to the socket that joined.
   - Coalesce the presence-only broadcast to everyone else, whether it's a join or a departure: debounce it by ~50–100 ms per object, or send a small `presence` message.
   - This turns a k-socket reconnect from ~k² snapshots into ~2k.
5. **Answer the close frame:** in `webSocketClose` (`room.ts:860`), add `try { ws.close(code === 1005 ? 1000 : code) } catch {}`.
6. **Take the per-call scan off the global presence object** (`presence.ts:81`, `:132`).
   - Add an index on `room_bots(updated_at)`, or prune on the object's alarm instead of on every call.
   - Before bot tables number in the thousands, shard the counter (e.g. by game or by room-code prefix) or batch reports.
7. **Write less per beat** (`room.ts:184`).
   - Phase beats that only advance presentation could skip the alarm re-arm when the deadline is unchanged.
   - Storing seats and `gameState` under separate keys would let a beat rewrite only the part that changed.
   - This only matters for cost, not latency: the puts are fast.
8. **Testing practice.**
   - Run this test on frozen code with its own `--persist-to` and port.
   - Production-like numbers need a staging deploy and a way past the per-IP limits (`limits.ts`). Do not aim this script at production.
   - The useful numbers from a local run are the per-room ones: CPU per event, bytes per snapshot and messages per storm.

## After the fixes (2026-10-20)

What changed, from the list above:

- **Closes are answered.** `RoomDO.webSocketClose` replies with the client's code (1000 for the reserved ones), in a `try`.
- **No more k² fan-out.** A join sends the full snapshot to the socket that joined at once; everyone else hears about arrivals and departures in one coalesced broadcast 40 ms later (`PRESENCE_COALESCE_MS`), sent only to sockets that have not had a snapshot since. Any real broadcast in between carries the news and cancels it. No protocol change.
- **Serialised once per view** (recommendation 3): `broadcast` stringifies each viewpoint's snapshot once and splices in `you`, and computes `connectedIds()` once.
- **Chess no longer replays the whole game** (recommendation 1, the replay half). The adapter hands the engine a line that starts at the position after the last capture or one-step pawn move, so a move costs the same at ply 200 as at ply 20. Every state, bot choice and draw is identical to the whole-line replay (`backend/test/chess-line.test.ts` plays games both ways). The bot search itself is unchanged.
- **Presence scans** (recommendation 6): pruning runs at most every 15 s on new indexes, and counts are reused for 2 s unless a beat changed who is here.

### Results

Same harness and machine, the two builds side by side as frozen copies (`git archive HEAD` for before, the working tree for after), each on its own port, `--persist-to` and worker name.

**The machine was shared.** Other agents were running Playwright and Chrome at the same time. The load average moved between 4 and 22, and for part of the session the disk was full. At 300 rooms that noise outweighs the difference between the builds. Whenever the load average was above about 10, **both** builds lost the storm: the unchanged build brought back 741, then 0, then 0 of 1,200 sockets, and logged up to 1,072 "dropped connection to the UserWorker" warnings; the new build did the same. So the 300-room rows below are from the quiet windows only (load average 5–7, disk not full). The per-room counts (messages per storm, closes answered, CPU per chess event) don't depend on the noise. Rerun the 300-room pair on an idle machine before quoting them.

|                                                                          | Before                    | After                |
| ------------------------------------------------------------------------ | ------------------------- | -------------------- |
| **100 rooms × 4:** host action RTT, steady, p50 / p95 ms                 | 3.3 / 31                  | 3.3 / 35             |
| 100 rooms: workerd CPU %, steady, p50 / p95                              | 48 / 65                   | 48 / 67              |
| 100 rooms: messages during the storm                                     | 1,042                     | 675                  |
| 100 rooms: storm, wall time until everyone was back                      | 0.81 s                    | 0.64 s               |
| 100 rooms: closes the server answered (p50)                              | 0 / 400                   | 400 / 400 (194 ms)   |
| **300 rooms × 4** (quiet windows): host action RTT, steady, p50 / p95 ms | 518 / 805 and 789 / 1,105 | 462 / 883            |
| 300 rooms: storm, wall time until everyone was back                      | 2.5 s and 3.1 s           | 2.2 s                |
| 300 rooms: closes the server answered                                    | 72 / 1,200 and 0 / 1,200  | 1,200 / 1,200        |
| **Wide rooms, 20 × 24:** messages while connecting                       | 5,937                     | 972                  |
| Wide rooms: messages during the storm (per room)                         | 5,958 (~298)              | 1,099 (~55)          |
| Wide rooms: closes answered (p50)                                        | 0 / 480                   | 480 / 480 (187 ms)   |
| **Chess, 20 × 2, instant host, 25 s:** events handled at ~100% of a core | 2,319 (≈10.8 ms each)     | 2,740 (≈9.1 ms each) |
| Chess: host action RTT p50 / p95 ms                                      | 226 / 345                 | 190 / 312            |

A human chess move through the adapter, measured in Node 22 on positions reached by random play:

| Plies played | Whole-line replay (before) | Shortened line (after) |
| ------------ | -------------------------- | ---------------------- |
| 20           | 1.41 ms                    | 0.35 ms                |
| 100          | 6.15 ms                    | 1.60 ms                |
| 200          | 11.46 ms                   | 0.32 ms                |

How to read these:

- **The 300-room knee is still a one-thread knee.** It hasn't moved much, because the cost there is the bot searches and alarms of 300 tables on one core.
- **The per-room costs are what carry to production,** and those dropped:
  - A 24-socket room's storm costs about 55 messages instead of about 300.
  - Closes now settle in milliseconds, so a browser reconnects at once instead of after about 10 s. At 300 rooms the answers take about a second, because the process is saturated.
  - A long chess game no longer gets dearer per move.
- **The chess-only gain is modest (~18%).** Games against an instant host are short, and the `easy` search (200 nodes of move generation) dominates each event. The replay saving grows with game length, as the second table shows.
- **Still open:** a time bound on the bot search (recommendation 2) and writing less per beat (recommendation 7).
