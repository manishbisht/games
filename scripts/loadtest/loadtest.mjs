#!/usr/bin/env node
/**
 * Load test for the room server: many bot tables at once, each with a scripted
 * host and a few spectators, then a reconnect storm.
 *
 * Usage (Node 22+, no install — it uses Node's own WebSocket and fetch, plus the
 * repo's `chess.js` to find legal moves for a chess host):
 *
 *   cd backend && WRANGLER_SEND_METRICS=false npx wrangler dev --port 8797 --inspector-port 9239 \
 *     --persist-to /tmp/lt-state --show-interactive-dev-session=false
 *   node scripts/loadtest/loadtest.mjs --rooms 20 --sockets 4 --game all --duration 30
 *
 * Point it at your own `wrangler dev`, not the one you develop against: hundreds
 * of rooms of state and observability rows land in its persist directory, and a
 * separate `--persist-to` keeps them out of yours. Run it on code nobody is
 * editing (a `git archive` copy works): wrangler hot-reloads on every save under
 * backend/ or shared/, and a reload drops every socket mid-run. It refuses any
 * target that is not loopback unless `--i-know` is given, because a non-loopback
 * target counts against the rate limits (src/limits.ts exempts loopback only)
 * and a production one would be a denial of service with extra steps.
 *
 * Method, results and what they mean: docs/load-test-2026-10.md.
 *
 * Flags:
 *   --target URL                 default http://127.0.0.1:8797
 *   --rooms N                    rooms to create (default 20)
 *   --sockets M                  sockets per room: one host plus M-1 spectators (default 4)
 *   --game all|chess|hearth|estate|prism|wildrise   all spreads rooms round-robin (default all)
 *   --duration S                 steady-state seconds after everyone has joined (default 30)
 *   --settle S                   seconds of play after the reconnect storm (default 10)
 *   --create-concurrency N       room creations in flight at once (default 25)
 *   --connect-concurrency N      initial socket opens in flight at once (default 100);
 *                                the storm itself always reopens everything at once
 *   --timeout S                  per-socket wait for a first snapshot (default 15)
 *   --think MS                   the host's mean pause before each decision, uniform over
 *                                0.5–1.5× (default 1500). 0 plays instantly, which turns a
 *                                chess table into a bot-search loop that eats a core by itself
 *   --skip-storm                 no reconnect storm
 *   --workerd-pid PID[,PID]      processes to sample; found from the target port by default
 *   --out FILE                   write the JSON summary here (otherwise it is printed)
 *   --i-know                     allow a non-loopback target
 *
 * What it measures, phase by phase (create → connect → steady → storm → settle):
 * room-create latency; socket open and open→first-snapshot latency; snapshot
 * latency (receipt minus the snapshot's own `timing.now` — same machine, same
 * clock; workerd freezes `Date.now()` for the length of a handler, so this is
 * "handler start to client receipt" and includes the handler's own work);
 * per-socket inter-arrival; the host's action round trip (send → the snapshot
 * whose state moved); errors by code; unexpected closes; message rate
 * and size. From wrangler's local observability store it reads span wall
 * durations for the run's window (the store has no CPU time — see the doc), and
 * it samples the workerd process's CPU and RSS with `ps` once a second.
 */
import { execFile } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { performance } from 'node:perf_hooks'
import { parseArgs, promisify } from 'node:util'

const run = promisify(execFile)

const { values: args } = parseArgs({
  options: {
    target: { type: 'string', default: 'http://127.0.0.1:8797' },
    rooms: { type: 'string', default: '20' },
    sockets: { type: 'string', default: '4' },
    game: { type: 'string', default: 'all' },
    duration: { type: 'string', default: '30' },
    settle: { type: 'string', default: '10' },
    'create-concurrency': { type: 'string', default: '25' },
    'connect-concurrency': { type: 'string', default: '100' },
    timeout: { type: 'string', default: '15' },
    think: { type: 'string', default: '1500' },
    'skip-storm': { type: 'boolean', default: false },
    'workerd-pid': { type: 'string' },
    out: { type: 'string' },
    'i-know': { type: 'boolean', default: false },
  },
})

const TARGET = new URL(args.target)
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
if (!LOOPBACK.has(TARGET.hostname) && !args['i-know']) {
  console.error(`Refusing ${TARGET.origin}: not loopback. Pass --i-know if you really mean it.`)
  process.exit(2)
}
const ORIGIN = TARGET.origin
const ROOMS = Number(args.rooms)
const SOCKETS = Math.max(1, Number(args.sockets))
const TIMEOUT_MS = Number(args.timeout) * 1000
const THINK_MS = Number(args.think)
/** Read off the shared source rather than copied, so a protocol bump cannot turn every join into PROTOCOL_MISMATCH. */
const PROTOCOL_VERSION = Number(
  readFileSync(new URL('../../shared/src/protocol/types.ts', import.meta.url), 'utf8').match(
    /PROTOCOL_VERSION = (\d+)/,
  )?.[1] ?? 3,
)

/**
 * One table per game, every seat but the host's a bot, dealt the moment the
 * host arrives (`autoStart`). Bots take the fullest table each game allows, so
 * the room's alarm — which plays them — is as busy as it gets.
 */
const TABLES = {
  chess: { seats: 2, bots: ['easy'] },
  hearth: { seats: 4, bots: ['medium', 'medium', 'medium'] },
  estate: { seats: 4, bots: ['standard', 'standard', 'standard'] },
  prism: { seats: 4, bots: ['medium', 'medium', 'medium'] },
  wildrise: { seats: 4, bots: ['fast', 'fast', 'fast'] },
}
const GAMES = args.game === 'all' ? Object.keys(TABLES) : [args.game]
if (!GAMES.every((g) => g in TABLES)) {
  console.error(`Unknown game ${args.game}`)
  process.exit(2)
}
const { Chess } = GAMES.includes('chess') ? await import('chess.js') : {}

const pick = (list) => list[Math.floor(Math.random() * list.length)]

/**
 * How the scripted host plays: the first legal-looking decision for the seat
 * the game is waiting on, read off the snapshot exactly as a browser would.
 * `fallback` counts refusals of this same state, so a guess the server turns
 * down (an unaffordable purchase, an unplayable card) steps to a safer one.
 */
const POLICIES = {
  chess(g, seat) {
    if (g.status !== 'playing' || g.turn !== seat) return null
    const move = pick(new Chess(g.fen).moves({ verbose: true }))
    return (
      move && {
        kind: 'move',
        from: move.from,
        to: move.to,
        ...(move.promotion ? { promotion: move.promotion } : {}),
      }
    )
  },
  hearth(g, seat, seats) {
    if (seats[g.currentPlayer] !== seat) return null
    if (g.phase === 'roll') return { kind: 'roll' }
    return g.phase === 'choose' && g.legalMoves.length
      ? { kind: 'move', pieceId: pick(g.legalMoves).pieceId }
      : null
  },
  wildrise: (g, seat, seats) =>
    seats[g.currentPlayer] === seat && g.phase === 'ready' ? { kind: 'roll' } : null,
  prism(g, seat, seats, fallback) {
    const me = seats.indexOf(seat)
    if (g.status !== 'playing' || g.currentPlayer !== me) return null
    const hand = g.players[me].hand
    const top = g.discardPile.at(-1)
    const restricted = g.rules.restrictDrawFour && hand.some((c) => !c.isWild && c.color === g.activeColor)
    const fits = (c) =>
      !(c.value === 'draw4' && restricted) &&
      (g.pendingPenalty
        ? g.rules.stacking && c.value === g.pendingPenalty.type
        : c.isWild || c.color === g.activeColor || c.value === top?.value)
    const playable = hand.filter((c) => (!g.drawnCardId || c.id === g.drawnCardId) && fits(c))
    if (playable.length && !fallback) {
      const card = pick(playable)
      return { kind: 'play', cardId: card.id, ...(card.isWild ? { color: 'red' } : {}) }
    }
    return g.drawnCardId ? { kind: 'pass' } : { kind: 'draw' }
  },
  estate(g, seat, seats, fallback) {
    const me = seats.indexOf(seat)
    if (g.status !== 'playing') return null
    if (g.trade) return g.trade.to === me ? { type: 'REJECT_TRADE' } : null
    if (g.current !== me) return null
    const options = {
      ready: ['ROLL', 'PAY_JAIL'],
      purchase: ['BUY', 'PASS'],
      card: ['ACK_CARD'],
      debt: ['LIQUIDATE', 'BANKRUPT'],
      end: ['END_TURN'],
    }[g.phase]
    return options ? { type: options[Math.min(fallback, options.length - 1)] } : null
  },
}

// ---------------------------------------------------------------- measurement

/** Everything is bucketed by the phase it happened in, so the storm cannot blur the steady state. */
let phase = 'create'
const phases = {}
const startPhase = (name) => {
  if (phases[phase]) phases[phase].end = Date.now()
  phase = name
  phases[name] = { start: Date.now() }
}
phases.create = { start: Date.now() }

const buckets = {}
/** The current phase's counters, made on first use. */
function bucket(name = phase) {
  return (buckets[name] ??= {
    open: [],
    first: [],
    snapshotLatency: [],
    interArrival: [],
    actionRtt: [],
    messages: 0,
    bytes: 0,
    actions: 0,
    errors: {},
    closes: {},
    closeAt: [],
    failures: {},
    gamesFinished: 0,
    byGame: {},
  })
}
const count = (map, key) => (map[key] = (map[key] ?? 0) + 1)

function stats(values) {
  if (!values.length) return { n: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
  const round = (v) => Math.round(v * 10) / 10
  return {
    n: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    p99: round(at(0.99)),
    max: round(sorted.at(-1)),
    mean: round(sorted.reduce((s, v) => s + v, 0) / sorted.length),
  }
}

/** A small worker pool: `fn` over `items`, at most `limit` in flight. */
async function pool(items, limit, fn) {
  let next = 0
  const worker = async () => {
    while (next < items.length) await fn(items[next++])
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

// ------------------------------------------------------------- process sampler

/**
 * Every workerd the target's wrangler runs. `wrangler dev` starts two: the one
 * listening on the port is only the entry proxy, and the Worker and its
 * Durable Objects run in a sibling — sampling the listener alone reads ~0%.
 * So: the listener's parent, then all of that parent's workerd children.
 */
async function findWorkerdPids() {
  if (args['workerd-pid']) return args['workerd-pid'].split(',').map(Number)
  try {
    const ps = async (...a) => (await run('ps', a)).stdout.trim()
    const listener = (await run('lsof', ['-nP', `-iTCP:${TARGET.port || 80}`, '-sTCP:LISTEN', '-t'])).stdout
      .trim()
      .split('\n')[0]
    const parent = await ps('-o', 'ppid=', '-p', listener)
    // `comm` is a full path here, spaces and all, so it is everything after the second column.
    const table = (await ps('-A', '-o', 'pid=,ppid=,comm='))
      .split('\n')
      .map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    return table
      .filter((row) => row && row[2] === parent && row[3].endsWith('workerd'))
      .map((row) => Number(row[1]))
  } catch {
    return []
  }
}

/** `ps -o time=` is cumulative CPU as [[h:]m]m:ss.ss; diffs of it give exact CPU, unlike `%cpu`'s decaying average. */
const cpuSeconds = (time) => time.split(':').reduce((sum, part) => sum * 60 + Number(part), 0)

/** One sample a second: CPU% over the last second (100 = one core) and RSS, summed and for the busiest process. */
const samples = []
let sampler
async function startSampler(pids) {
  if (!pids.length) return
  let last = null
  const tick = async () => {
    try {
      const { stdout } = await run('ps', ['-o', 'pid=,time=,rss=', '-p', pids.join(',')])
      const now = performance.now()
      const rows = stdout
        .trim()
        .split('\n')
        .map((l) => l.trim().split(/\s+/))
      const cpu = Object.fromEntries(rows.map(([pid, time]) => [pid, cpuSeconds(time)]))
      const rssMb = rows.reduce((sum, [, , rss]) => sum + rss / 1024, 0)
      if (last) {
        const per = Object.keys(cpu).map(
          (pid) => ((cpu[pid] - (last.cpu[pid] ?? cpu[pid])) / ((now - last.now) / 1000)) * 100,
        )
        samples.push({ phase, cpuPct: per.reduce((a, b) => a + b, 0), busiestPct: Math.max(...per), rssMb })
      }
      last = { cpu, now }
    } catch {}
  }
  await tick()
  sampler = setInterval(tick, 1000)
}

// --------------------------------------------------------------------- clients

const clients = []
const rooms = []

/**
 * One socket's life. The client keeps its guest id across reconnects, so the
 * host's second socket reclaims its seat exactly as a browser's would.
 */
function connect(client) {
  const b = bucket()
  const started = performance.now()
  const ws = new WebSocket(`${ORIGIN.replace(/^http/, 'ws')}/api/rooms/${client.room.code}`)
  client.ws = ws
  client.leaving = false
  client.gotRoom = false
  client.lastRoomAt = null
  // An action sent on the old socket died with it; its round trip is not this socket's.
  client.inFlight = null
  return new Promise((resolve) => {
    let settled = false
    const done = (failure) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (failure) count(b.failures, failure)
      resolve(!failure)
    }
    const timer = setTimeout(() => {
      done('timeout')
      client.leaving = true
      ws.close()
    }, TIMEOUT_MS)
    ws.onopen = () => {
      b.open.push(performance.now() - started)
      ws.send(
        JSON.stringify({
          type: 'join',
          protocol: PROTOCOL_VERSION,
          name: client.name,
          guestId: client.guestId,
        }),
      )
    }
    ws.onmessage = (event) => {
      receive(client, event.data)
      if (!settled && client.gotRoom) {
        b.first.push(performance.now() - started)
        done(null)
      }
    }
    ws.onerror = () => {}
    ws.onclose = (event) => {
      // A superseded socket's close speaks for itself only — it can land well
      // after its successor joined (see the close handshake note in the doc).
      if (client.ws !== ws) return done(`close ${event.code}`)
      client.closed?.()
      if (!client.leaving) {
        count(bucket().closes, event.code)
        // When, into the phase, so a mass drop can be lined up against the server's own log.
        bucket().closeAt.push(Date.now() - phases[phase].start)
      }
      done(`close ${event.code}`)
    }
  })
}

function receive(client, data) {
  const receivedAt = Date.now()
  if (data === 'pong') return
  const b = bucket()
  b.messages++
  b.bytes += data.length
  const message = JSON.parse(data)
  if (message.type === 'error') {
    count(b.errors, message.code)
    if (client.role === 'host' && client.inFlight) refused(client)
    return
  }
  const { snapshot } = message
  client.gotRoom = true
  const game = (b.byGame[snapshot.game] ??= { snapshotLatency: [], bytes: 0, messages: 0 })
  game.messages++
  game.bytes += data.length
  if (snapshot.timing) {
    b.snapshotLatency.push(receivedAt - snapshot.timing.now)
    game.snapshotLatency.push(receivedAt - snapshot.timing.now)
  }
  if (client.lastRoomAt !== null) b.interArrival.push(receivedAt - client.lastRoomAt)
  client.lastRoomAt = receivedAt
  if (client.role === 'host') play(client, message)
}

/** The host's turn, if it is one. One action in flight at a time, keyed by the state it answered. */
function play(client, message) {
  client.last = message
  const { snapshot, you } = message
  if (!you.seat) return
  // Which state this is. `timing.since` alone is not enough: two mutations
  // inside one millisecond share it, and the reply to an action would then look
  // like the state it answered — so the state itself is part of the key.
  const since = `${snapshot.status}|${snapshot.timing?.since}|${JSON.stringify(snapshot.gameState)}`
  if (client.inFlight) {
    // Still thinking: the timer re-reads the newest snapshot when it fires.
    if (client.inFlight.at === null) return
    const stale = since === client.inFlight.since && performance.now() - client.inFlight.at < 5000
    if (stale) return
    bucket().actionRtt.push(performance.now() - client.inFlight.at)
    client.inFlight = null
  }
  if (since !== client.since) {
    client.since = since
    client.fallback = 0
  }
  if (snapshot.status === 'finished') {
    // Bots do not vote, so the host's rematch deals the next game at once —
    // the table never goes quiet for the length of the test.
    if (client.rematchFor === since) return
    client.rematchFor = since
    bucket().gamesFinished++
    return send(client, { type: 'rematch' })
  }
  if (snapshot.status !== 'playing' || !snapshot.gameState || client.fallback > 3) return
  const action = POLICIES[snapshot.game](snapshot.gameState, you.seat, snapshot.seatIds, client.fallback)
  if (!action) return
  const inFlight = (client.inFlight = { at: null, since })
  const fire = () => {
    if (client.inFlight !== inFlight) return
    // The table moved while we thought (a reconnect, a clock): decide again on what is there now.
    if (client.since !== since) {
      client.inFlight = null
      return client.last && play(client, client.last)
    }
    inFlight.at = performance.now()
    bucket().actions++
    send(client, { type: 'action', action })
  }
  if (THINK_MS) setTimeout(fire, THINK_MS * (0.5 + Math.random()))
  else fire()
}

function refused(client) {
  client.inFlight = null
  client.fallback++
  if (client.last) play(client, client.last)
}

function send(client, message) {
  if (client.ws?.readyState === WebSocket.OPEN) client.ws.send(JSON.stringify(message))
}

// ------------------------------------------------------------------------ run

const runStart = Date.now()
const pids = await findWorkerdPids()
await startSampler(pids)
const clientCpu = process.cpuUsage()

console.error(
  `→ ${ORIGIN}: ${ROOMS} rooms × ${SOCKETS} sockets (${GAMES.join(', ')}), workerd ${pids.join(',') || '?'}`,
)

const createLatency = []
const createFailures = {}
await pool(
  Array.from({ length: ROOMS }, (_, i) => i),
  Number(args['create-concurrency']),
  async (i) => {
    const game = GAMES[i % GAMES.length]
    const hostId = crypto.randomUUID()
    const started = performance.now()
    try {
      const response = await fetch(`${ORIGIN}/api/rooms`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ game, ...TABLES[game], autoStart: true, name: `Host ${i}`, guestId: hostId }),
      })
      if (!response.ok) return count(createFailures, response.status)
      const { code } = await response.json()
      createLatency.push(performance.now() - started)
      const room = { code, game }
      rooms.push(room)
      for (let s = 0; s < SOCKETS; s++)
        clients.push({
          room,
          role: s === 0 ? 'host' : 'spectator',
          guestId: s === 0 ? hostId : crypto.randomUUID(),
          name: s === 0 ? `Host ${i}` : `Watcher ${i}.${s}`,
        })
    } catch (error) {
      count(createFailures, error.cause?.code ?? error.message)
    }
  },
)

startPhase('connect')
// Hosts first, so every table is dealt before its spectators arrive.
const ordered = [...clients.filter((c) => c.role === 'host'), ...clients.filter((c) => c.role !== 'host')]
await pool(ordered, Number(args['connect-concurrency']), connect)

startPhase('steady')
// The page's heartbeat: answered at the edge by the auto-response pair, never waking the room.
const heartbeat = setInterval(
  () => clients.forEach((c) => c.ws?.readyState === WebSocket.OPEN && c.ws.send('ping')),
  20000,
)
await new Promise((r) => setTimeout(r, Number(args.duration) * 1000))

/** Tables whose host has heard nothing for ten seconds: a stuck alarm or a lost socket. */
const quietHosts = (since) =>
  clients.filter((c) => c.role === 'host' && (c.lastRoomAt === null || Date.now() - c.lastRoomAt > since))
    .length
const quietAfterSteady = quietHosts(10000)

let storm = null
if (!args['skip-storm']) {
  startPhase('storm')
  const closeMs = []
  const closeStart = performance.now()
  await Promise.all(
    clients.map(
      (c) =>
        new Promise((resolve) => {
          if (!c.ws || c.ws.readyState === WebSocket.CLOSED) return resolve()
          c.leaving = true
          c.closed = () => {
            c.closed = null
            closeMs.push(performance.now() - closeStart)
            resolve()
          }
          c.ws.close()
          // The room does not answer a close frame (room.ts webSocketClose), so
          // without a cap this would wait out the client's own close timeout.
          setTimeout(resolve, 2000)
        }),
    ),
  )
  const stormStart = performance.now()
  const ok = await Promise.all(clients.map(connect))
  storm = {
    closeHandshakeMs: { ...stats(closeMs), unanswered: clients.length - closeMs.length },
    reconnected: ok.filter(Boolean).length,
    of: clients.length,
    wallMs: performance.now() - stormStart,
  }
  startPhase('settle')
  await new Promise((r) => setTimeout(r, Number(args.settle) * 1000))
}
const quietAtEnd = quietHosts(10000)

startPhase('done')
clearInterval(heartbeat)
clearInterval(sampler)
for (const c of clients) {
  c.leaving = true
  c.ws?.close()
}
const runEnd = Date.now()
const client = process.cpuUsage(clientCpu)

// --------------------------------------------------------------- observability

/**
 * Wall durations of the Worker's own spans, from wrangler's local explorer.
 * The store keeps everything across runs, so it is filtered to this run's
 * window; it records no CPU time, only wall, which on a single local process
 * includes waiting behind every other room's work.
 */
async function observability() {
  await new Promise((r) => setTimeout(r, 1500))
  const query = async (sql) => {
    const response = await fetch(`${ORIGIN}/cdn-cgi/local/explorer/api/local/observability/query`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sql }),
    })
    const body = await response.json()
    if (!body.success) throw new Error(JSON.stringify(body.errors))
    return body.result.rows
  }
  try {
    // The explorer returns at most 10,000 rows, and a few hundred rooms make
    // far more spans than that, so the percentiles are taken in SQLite: each
    // span is bucketed into its phase by start time and ranked within it.
    const phaseOf = `CASE ${Object.entries(phases)
      .map(([name, p]) => `WHEN start_ms >= ${p.start} AND start_ms < ${p.end ?? runEnd + 1} THEN '${name}'`)
      .join(' ')} ELSE 'other' END`
    const at = (q) => `MAX(CASE WHEN rn = MIN(n, CAST(${q} * n AS INTEGER) + 1) THEN d END)`
    const rows = await query(
      `WITH s AS (
         SELECT ${phaseOf} AS phase, name, duration_ms AS d FROM spans
         WHERE start_ms BETWEEN ${runStart} AND ${runEnd} AND duration_ms IS NOT NULL
       ), r AS (
         SELECT phase, name, d, ROW_NUMBER() OVER (PARTITION BY phase, name ORDER BY d) AS rn,
                COUNT(*) OVER (PARTITION BY phase, name) AS n
         FROM s
       )
       SELECT phase, name, n, ${at(0.5)}, ${at(0.95)}, ${at(0.99)}, MAX(d), ROUND(AVG(d), 1), SUM(d)
       FROM r GROUP BY phase, name`,
    )
    const spans = {}
    for (const [phase, name, n, p50, p95, p99, max, mean, total] of rows)
      (spans[phase] ??= {})[name] = { n, p50, p95, p99, max, mean, totalMs: total }
    const outcomes = Object.fromEntries(
      (
        await query(
          `SELECT name || ':' || outcome, COUNT(*) FROM spans
           WHERE start_ms BETWEEN ${runStart} AND ${runEnd} AND outcome != 'ok' GROUP BY 1`,
        )
      ).map(([k, v]) => [k, v]),
    )
    const logs = await query(
      `SELECT level, message FROM logs WHERE ts_ms BETWEEN ${runStart} AND ${runEnd} AND level IN ('error','warn')`,
    )
    const logLevels = {}
    for (const [level] of logs) count(logLevels, level)
    return { spans, outcomes, logLevels, logSamples: logs.slice(0, 5).map((r) => r[1]) }
  } catch (error) {
    return { error: String(error) }
  }
}
const obs = await observability()

// --------------------------------------------------------------------- report

const seconds = (name) => ((phases[name]?.end ?? runEnd) - (phases[name]?.start ?? runEnd)) / 1000
const summarise = (name) => {
  const b = buckets[name]
  if (!b) return null
  const s = seconds(name)
  return {
    seconds: s,
    open: stats(b.open),
    firstSnapshot: stats(b.first),
    snapshotLatency: stats(b.snapshotLatency),
    interArrival: stats(b.interArrival),
    actionRtt: stats(b.actionRtt),
    messages: b.messages,
    messagesPerSec: Math.round(b.messages / s),
    meanMessageBytes: b.messages ? Math.round(b.bytes / b.messages) : 0,
    actions: b.actions,
    gamesFinished: b.gamesFinished,
    errors: b.errors,
    closes: b.closes,
    closeAtMs: stats(b.closeAt),
    failures: b.failures,
    byGame: Object.fromEntries(
      Object.entries(b.byGame).map(([g, v]) => [
        g,
        { snapshotLatency: stats(v.snapshotLatency), meanBytes: Math.round(v.bytes / v.messages) },
      ]),
    ),
  }
}
const proc = (name) => {
  const of = samples.filter((s) => s.phase === name)
  return of.length
    ? {
        cpuPct: stats(of.map((s) => s.cpuPct)),
        busiestPct: stats(of.map((s) => s.busiestPct)),
        rssMbMax: Math.round(Math.max(...of.map((s) => s.rssMb))),
      }
    : null
}

const summary = {
  target: ORIGIN,
  at: new Date(runStart).toISOString(),
  config: {
    rooms: ROOMS,
    socketsPerRoom: SOCKETS,
    games: GAMES,
    duration: Number(args.duration),
    thinkMs: THINK_MS,
  },
  roomsCreated: rooms.length,
  sockets: clients.length,
  create: { latency: stats(createLatency), failures: createFailures, seconds: seconds('create') },
  phases: Object.fromEntries(['connect', 'steady', 'storm', 'settle'].map((p) => [p, summarise(p)])),
  storm,
  quietHosts: { afterSteady: quietAfterSteady, atEnd: quietAtEnd },
  workerd: {
    pids,
    ...Object.fromEntries(['create', 'connect', 'steady', 'storm', 'settle'].map((p) => [p, proc(p)])),
  },
  client: { cpuSeconds: Math.round((client.user + client.system) / 1e4) / 100 },
  observability: obs,
}

const ms = (s) => (s?.n ? `${s.p50} / ${s.p95} / ${s.p99} / ${s.max}` : '—')
const lines = [
  ['create latency ms (p50/p95/p99/max)', ms(summary.create.latency)],
  ['create failures', JSON.stringify(createFailures)],
]
for (const p of ['connect', 'steady', 'storm', 'settle']) {
  const s = summary.phases[p]
  if (!s) continue
  lines.push([`— ${p} (${s.seconds.toFixed(1)}s)`, ''])
  if (s.firstSnapshot.n)
    lines.push(['  open→first snapshot ms', ms(s.firstSnapshot)], ['  socket open ms', ms(s.open)])
  lines.push(
    ['  snapshot latency ms', ms(s.snapshotLatency)],
    ['  inter-arrival ms', ms(s.interArrival)],
    ['  host action RTT ms', ms(s.actionRtt)],
    ['  messages (per s, mean bytes)', `${s.messages} (${s.messagesPerSec}/s, ${s.meanMessageBytes} B)`],
    [
      '  errors / closes / failures',
      `${JSON.stringify(s.errors)} ${JSON.stringify(s.closes)} ${JSON.stringify(s.failures)}`,
    ],
  )
  const w = summary.workerd[p]
  if (w)
    lines.push([
      '  workerd CPU% p50/p95/max, RSS max',
      `${w.cpuPct.p50} / ${w.cpuPct.p95} / ${w.cpuPct.max}, ${w.rssMbMax} MB`,
    ])
}
if (storm)
  lines.push(
    [
      'storm close handshake ms',
      `${ms(storm.closeHandshakeMs)} (unanswered ${storm.closeHandshakeMs.unanswered})`,
    ],
    ['storm reconnected', `${storm.reconnected}/${storm.of} in ${Math.round(storm.wallMs)} ms`],
  )
lines.push(['load generator CPU s', String(summary.client.cpuSeconds)])
lines.push(['quiet hosts (>10s) after steady / at end', `${quietAfterSteady} / ${quietAtEnd}`])
for (const p of ['create', 'connect', 'steady', 'storm', 'settle'])
  for (const name of ['alarm', 'hibernatableWebSocket', 'POST', 'jsrpc', 'durable_object_storage_put']) {
    const span = obs.spans?.[p]?.[name]
    if (span) lines.push([`span ${p}/${name} wall ms`, `${ms(span)} (n=${span.n})`])
  }
const width = Math.max(...lines.map(([k]) => k.length))
console.log(lines.map(([k, v]) => `${k.padEnd(width)}  ${v}`).join('\n'))

if (args.out) writeFileSync(args.out, JSON.stringify(summary, null, 2))
else console.log(JSON.stringify(summary, null, 2))
process.exit(0)
