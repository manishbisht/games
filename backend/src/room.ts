import { DurableObject } from 'cloudflare:workers'
import { getAdapter } from '@games/shared/online'
import type { Ctx, GameAdapter } from '@games/shared/online/adapter'
import {
  CLAIM_WIN_AFTER_MS,
  CLOSE_CODES,
  isReaction,
  PROTOCOL_VERSION,
  REACTION_LIMITS,
} from '@games/shared/protocol'
import type {
  ClientMessage,
  ErrorCode,
  GameId,
  PlayerInfo,
  RoomSnapshot,
  RoomStatus,
  RoomVisibility,
  SeatId,
  SeatInfo,
  ServerMessage,
  YouInfo,
} from '@games/shared/protocol'
import type { ActiveTable } from '@games/shared/protocol'
import { cleanName, resolveIdentity, verifyClerkToken } from './auth'
import { isLocalWorker } from './cors'
import type { Env } from './env'
import { durationBucket, track } from './analytics'
import { isPerson, playerHandle } from './handles'
import { freshLedger, joinedMessage, turnAlerts, turnMessage } from './ledger'
import type { Ledger } from './ledger'
import { outcomeOf } from './outcome'
import { CREDIBLE_GAMES, RATED_PER_OPPONENT_DAILY } from './player'
import type { ChessStanding, NotifyKind, PlayerSelf } from './player'
import { PROVISIONAL_GAMES } from './elo'
import type { PushMessage } from './push'
import { ReplayLog } from './replay'

const ROOM_TTL_MS = 24 * 60 * 60 * 1000
/** Safety valve so one alarm cannot spin forever on an adapter that never settles. */
const MAX_AUTO_ADVANCES = 20
/**
 * How long the room pauses before taking an abandoned seat's turn for it. Long
 * enough to read as a player thinking, short enough that the table keeps moving.
 */
const STAND_IN_DELAY_MS = 1200
/** How long the room pauses before a bot's decision lands, when its game has no opinion. */
const BOT_THINK_MS = 900
/**
 * How many sockets one room serves, seat-holders and spectators together. A
 * seat-holder is always let back in; past this, someone who could only watch is
 * told the room is full. Every snapshot is built and sent once per socket, so
 * this is what bounds a single move's cost.
 */
export const MAX_ROOM_SOCKETS = 24

/**
 * Sockets that have not joined yet, per room. A browser joins within a moment
 * of opening its socket (it is waiting on its Clerk token at most), but a whole
 * room reconnecting at once — a deploy, a network blip — opens every socket
 * before any of their joins land, so this is a full room and then some. Past
 * it, the room is being held open by something that is not a browser, and the
 * oldest silent socket is let go to make room for the newest.
 */
export const MAX_PENDING_SOCKETS = 32
/** How long a socket may stay open without joining. */
export const JOIN_DEADLINE_MS = 15_000
/** Joins one socket may try. A browser sends exactly one. */
const MAX_JOINS_PER_SOCKET = 3

/**
 * Frames per socket: a bucket of `burst` that refills one every `refillMs`.
 * Real play is a click or two a second, and a reconnect flushes at most
 * sixteen queued frames after its join (`useRoom`'s outbox), so this is
 * generous; a socket that runs it dry is told once, and one that sends another
 * whole burst into the empty bucket is closed.
 */
export const MESSAGE_LIMITS = { burst: 30, refillMs: 100 } as const
/** The longest frame a room reads. A join with a Clerk token is the biggest real one, at a couple of KB. */
export const MAX_FRAME_CHARS = 8 * 1024
/** WebSocket "policy violation": the close a socket earns by flooding the room. */
const CLOSE_POLICY = 1008
/** WebSocket "try again later": an unjoined socket timed out or let go; the browser reconnects. */
const CLOSE_RETRY = 1013

/**
 * How long a change that only moves people — someone arriving, someone
 * leaving — waits to be told to the room, so a crowd reconnecting at once is
 * told in one snapshot rather than one each: k sockets coming back cost the
 * room about 2k sends instead of k². Imperceptible as a dot turning green.
 */
export const PRESENCE_COALESCE_MS = 40
/** At most one lobby update per this long, carrying the table as it stands when it goes. */
const LOBBY_THROTTLE_MS = 250

/** Close codes a server may send back; anything else (1005, 1006, 1015…) is answered as a plain 1000. */
const sendableClose = (code: number) =>
  (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999)
    ? code
    : 1000

/**
 * How often a room that is still playing the same bots repeats itself to the
 * site counter. Matches a browser tab's heartbeat, so a live table keeps its
 * row fresh the same way a live visitor does.
 */
const BOT_PRESENCE_REFRESH_MS = 30_000
/**
 * How early an alarm fire may land and still count as "on time". `armAlarm`
 * always schedules at or after `autoAt`, so normal flow never comes anywhere
 * near this window — it exists for a DO alarm retry or a race with a
 * concurrent `save()`'s re-arm, either of which can call `alarm()` back a
 * hair before the deadline it named.
 */
const AUTO_AT_TOLERANCE_MS = 50

/**
 * Cryptographically-sourced uniform draw in [0, 1), matching `Math.random`'s
 * contract so it drops straight into `Ctx.random`. Game seeds and shuffles
 * are decided here, server-side and once, so they use workerd's Web Crypto
 * RNG rather than `Math.random`, which carries no such guarantee.
 */
export function secureRandom(): number {
  const bytes = new Uint32Array(1)
  crypto.getRandomValues(bytes)
  return bytes[0] / 2 ** 32
}

interface StoredSeat {
  player: PlayerInfo
  wantsRematch: boolean
  /** When this seat-holder's last socket dropped; cleared on reconnect. */
  disconnectedAt?: number
  /** Set once the room has played on without this seat; cleared when they come back. */
  abandoned?: boolean
  /** Set when nobody is behind this seat: the room plays it, turn after turn. */
  bot?: { skill: string }
}

/** Consecutive stand-in turns that settled nothing before the room stops retrying. */
const MAX_STAND_IN_STALLS = 5

export interface RoomRecord {
  code: string
  game: GameId
  visibility: RoomVisibility
  status: RoomStatus
  hostId: string
  hostName: string
  createdAt: number
  /** When the room forgets itself. Also the alarm's deadline of last resort. */
  expiresAt: number
  /**
   * When the game's current timed phase is due, stamped once as the phase is
   * entered. Absent whenever the game is not sitting in one.
   */
  autoAt?: number
  /** When the current game state was entered; sent as `timing.since`. */
  stateAt?: number
  /**
   * Stand-in turns in a row that left the game exactly where it was. Only a
   * misbehaving adapter produces any; the count is what stops the room retrying
   * forever. Reset the moment a stand-in actually moves the game.
   */
  standInStalls?: number
  /** The seats in play. Minted at creation, compacted onto the real headcount at start. */
  seatIds: SeatId[]
  /** The seat count the room was created for; `seatIds` may be shorter once compacted. */
  seatsTotal: number
  /**
   * Seat the host and deal as soon as they arrive. Only ever meaningful when
   * bots fill every other seat — a solo table against bots has nobody to wait
   * in a lobby for.
   */
  autoStart?: boolean
  options: unknown
  seats: Partial<Record<SeatId, StoredSeat>>
  gameState: unknown
  /**
   * Seats the room ended the current game against — a granted claim, or an
   * absence nobody could stand in for — when the game itself named no winner.
   * Cleared when the next game starts.
   */
  forfeited?: SeatId[]
  /** What the room has already told players' records, analytics and push (see ledger.ts). */
  ledger?: Ledger
  /**
   * Where the room was made from, as a one-way tag (see `sourceTag`), so the
   * lobby can cap how many public rooms one address lists. Never the address.
   */
  source?: string
}

/**
 * What a socket carries through hibernation. A socket with no `player` has not
 * joined yet; one accepted before `at` was recorded has neither, and is
 * treated as joined-or-not by `player` alone.
 */
interface Attachment {
  /** When the room accepted the socket: it has `JOIN_DEADLINE_MS` from here to join. */
  at?: number
  /** Reached through a dev server (`isLocalWorker`), which also admits localhost pages' tokens. */
  local?: boolean
  /** Joins tried on this socket. */
  joins?: number
  player?: PlayerInfo
  /** Joined saying it understands `reaction` frames (see `ClientFeature`). */
  reactions?: boolean
}

/** One finished game, captured as it ended, for the players' records. */
interface FinishedGame {
  game: GameId
  code: string
  round: number
  seatIds: SeatId[]
  seats: Partial<Record<SeatId, StoredSeat>>
  gameState: unknown
  forfeited: SeatId[]
  at: number
}

const selfOf = (player: PlayerInfo): PlayerSelf => ({
  name: player.name,
  ...(player.avatar ? { avatar: player.avatar } : {}),
  isGuest: player.isGuest,
})

export class RoomDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Heartbeat: the edge answers client pings itself, without waking (or
    // billing) a hibernated object — and the pong traffic makes dead TCP
    // connections surface as closes in seconds instead of minutes.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'))
  }

  // `load()` returns this same mutable object on every call (after the first
  // fill from storage), not a fresh snapshot. That matters because
  // `handleJoin`'s `await resolveIdentity(...)` is the only genuine yield
  // point in this file's message handling — the Clerk path does real network
  // I/O, so other messages (and other sockets' handlers) can run interleaved
  // while it's pending. Every handler mutates and reads this one shared
  // `cached` record, so a mutation made during that await (e.g. another
  // `sit`) is still visible to the handler that resumes after it. If a future
  // change makes `load()` return a copy (e.g. `structuredClone`) instead of
  // this shared reference, handlers resuming after an await would read a
  // stale snapshot and could clobber concurrent updates on `save()` — a
  // lost-update bug. Keep `load()` returning the same object identity unless
  // that concurrency story is reworked deliberately.
  private cached: RoomRecord | null | undefined
  /**
   * The last bot count this room told PresenceDO, and when. Purely an instance
   * hint: losing it to eviction costs one redundant push, never correctness.
   */
  private lastBotPush = { at: 0, bots: -1 }
  /**
   * Sockets whose close (or error) the room is handling. workerd still lists a
   * socket in `getWebSockets()` while its own `webSocketClose` runs, so without
   * this a player who left was counted as present by the very handler meant to
   * notice they had gone — their seat never went "away", a spectator was never
   * uncounted — until some later socket's departure happened to look again.
   * Weak, so a socket that is gone for good costs nothing to remember.
   */
  private departed = new WeakSet<WebSocket>()
  /**
   * Each person's reaction allowance (see `REACTION_LIMITS`), by player id, so
   * a second tab or a reconnect does not hand them a fresh one. In memory only:
   * an evicted room forgets it, which hands everyone a full bucket — harmless.
   * Emptied when the last person leaves.
   */
  private reactionBuckets = new Map<string, { tokens: number; at: number }>()
  private reactionSeq = 0
  /** Each socket's frame allowance (see `MESSAGE_LIMITS`); `warned` once it has been told it ran dry. */
  private messageBuckets = new WeakMap<WebSocket, { tokens: number; at: number; warned: boolean }>()
  /** Closes sockets that never joined (see `JOIN_DEADLINE_MS`). */
  private sweepTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * Presence changes are counted, and each socket remembers the count it was
   * last sent a snapshot at; a coalesced presence broadcast only goes to the
   * sockets behind it (see `PRESENCE_COALESCE_MS`).
   */
  private presenceVersion = 0
  private presenceSent = new WeakMap<WebSocket, number>()
  private presenceTimer: ReturnType<typeof setTimeout> | null = null
  /** The lobby's last word on this room (a summary, or `null` for "not listed"), as JSON. */
  private lobbyShown: string | undefined
  private lobbyTimer: ReturnType<typeof setTimeout> | null = null
  /** Every state each game passes through, as a spectator saw it (see replay.ts). */
  private replay = new ReplayLog(this.ctx.storage.sql)

  /** The sockets still in the room: everything workerd lists, less the ones leaving it. */
  private sockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => !this.departed.has(ws))
  }

  private attachment(ws: WebSocket): Attachment {
    return (ws.deserializeAttachment() as Attachment | null) ?? {}
  }

  /** Who joined on this socket, or null while it has not. */
  private member(ws: WebSocket): PlayerInfo | null {
    return this.attachment(ws).player ?? null
  }

  /** Close a socket from this side; it stops counting as here at once. */
  private drop(ws: WebSocket, code: number, reason: string): void {
    this.departed.add(ws)
    try {
      ws.close(code, reason)
    } catch {
      // Already closing.
    }
  }

  private async load(): Promise<RoomRecord | null> {
    if (this.cached === undefined) {
      const stored = (await this.ctx.storage.get<RoomRecord>('room')) ?? null
      // A room created by the chess-only backend this branch supersedes has
      // no `seatIds` (or `expiresAt`) in storage — every handler below reads
      // `record.seatIds` unconditionally, so treating that record as present
      // would crash deep inside a handler (e.g. `seatOf`'s `.filter`) instead
      // of failing clean. It cannot be played either way, so the answer is
      // the same as no room at all: forget it and say so.
      if (stored && !Array.isArray(stored.seatIds)) {
        await this.ctx.storage.deleteAll()
        await this.ctx.storage.deleteAlarm()
        this.replay.forget()
        this.cached = null
      } else {
        this.cached = stored
      }
    }
    return this.cached
  }

  private async save(record: RoomRecord): Promise<void> {
    this.cached = record
    record.expiresAt = Date.now() + ROOM_TTL_MS
    // Settled before the write, so what has been told is stored with what it
    // was told about; sent after it, so nothing is told about a save that failed.
    const effects = this.account(record)
    await this.ctx.storage.put('room', record)
    await this.armAlarm(record)
    this.pushBotPresence(record)
    for (const effect of effects) this.ctx.waitUntil(effect().catch(() => undefined))
  }

  /** A person's record, by their private id. */
  private async playerStub(playerId: string) {
    return this.env.PLAYER.getByName(await playerHandle(playerId))
  }

  /**
   * What this save means to the world outside the room, worked out against the
   * ledger of what it has already been told: a game starting or finishing, each
   * person's view of the table, and a turn arriving for somebody who is not
   * here. Returns the calls to make; the caller makes them once the save lands.
   *
   * Hung off `save()` for the same reason the bot count is: it is the one door
   * every change goes through, so nothing — a rematch, a stand-in's move, a
   * forfeit — can change the table without the ledger seeing it.
   */
  private account(record: RoomRecord): (() => Promise<unknown>)[] {
    const effects: (() => Promise<unknown>)[] = []
    const ledger = (record.ledger ??= freshLedger(record.status))
    const now = Date.now()
    const bots = record.seatIds.filter((seat) => record.seats[seat]?.bot).length

    if (record.status === 'playing' && ledger.status !== 'playing') {
      ledger.round++
      ledger.startedAt = now
      record.forfeited = undefined
      track(this.env, 'game_started', {
        game: record.game,
        detail: ledger.round > 1 ? 'rematch' : 'fresh',
        count: record.seatIds.length,
        value: bots,
      })
    }
    if (record.status === 'finished' && ledger.status === 'playing') {
      const finished: FinishedGame = {
        game: record.game,
        code: record.code,
        round: ledger.round,
        seatIds: [...record.seatIds],
        seats: structuredClone(record.seats),
        gameState: record.gameState,
        forfeited: record.forfeited ?? [],
        at: now,
      }
      effects.push(() => this.recordFinish(finished))
      track(this.env, 'game_finished', {
        game: record.game,
        detail: 'finished',
        count: durationBucket(now - (ledger.startedAt ?? now)),
        value: record.seatIds.length,
      })
    }
    ledger.status = record.status

    const live = record.status === 'open' || record.status === 'playing'
    const waiting =
      record.status === 'playing' && record.gameState !== null
        ? this.adapter(record).waitingOn(record.gameState, record.seatIds)
        : []
    const person = (seat: SeatId) => {
      const stored = record.seats[seat]
      return Boolean(stored && !stored.bot && isPerson(stored.player.id))
    }

    // Each person's view of the table, sent only when it has changed.
    const tables: Record<string, string> = {}
    if (live)
      for (const seat of record.seatIds) {
        if (!person(seat)) continue
        const { player } = record.seats[seat]!
        const table: ActiveTable = {
          code: record.code,
          game: record.game,
          status: record.status as ActiveTable['status'],
          seats: record.status === 'open' ? record.seatsTotal : record.seatIds.length,
          opponents: record.seatIds
            .filter((other) => other !== seat && record.seats[other])
            .map((other) => record.seats[other]!.player.name),
          yourTurn: waiting.includes(seat),
          updatedAt: now,
        }
        const signature = JSON.stringify([
          table.status,
          table.seats,
          table.opponents,
          table.yourTurn,
          player.name,
        ])
        tables[player.id] = signature
        if (ledger.tables[player.id] === signature) continue
        const version = ++ledger.version,
          self = selfOf(player)
        effects.push(async () => (await this.playerStub(player.id)).setTable(table, version, self))
      }
    for (const id of Object.keys(ledger.tables))
      if (!(id in tables)) {
        const version = ++ledger.version
        effects.push(async () => (await this.playerStub(id)).dropTable(record.code, version))
      }
    ledger.tables = tables

    // A turn that has come round to somebody who is not here.
    if (record.status === 'playing') {
      const connected = this.connectedIds()
      for (const seat of turnAlerts(ledger.waiting, waiting, person, (s) =>
        connected.has(record.seats[s]!.player.id),
      )) {
        const others = record.seatIds
          .filter((other) => other !== seat && record.seats[other])
          .map((other) => record.seats[other]!.player.name)
        effects.push(() =>
          this.notify(record.seats[seat]!.player.id, 'turn', turnMessage(record.game, record.code, others)),
        )
      }
    }
    ledger.waiting = waiting
    return effects
  }

  private async notify(playerId: string, kind: NotifyKind, message: PushMessage): Promise<unknown> {
    // No keys, no notifications: skip the hop to the player's record entirely.
    if (!this.env.VAPID_PUBLIC_KEY || !this.env.VAPID_PRIVATE_KEY) return
    const code = this.cached?.code ?? ''
    return (await this.playerStub(playerId)).notify(kind, code, message)
  }

  /**
   * Hand a finished game to every person who played it. Chess between two
   * people is rated, once both have moved — a game abandoned before it began is
   * recorded but leaves both numbers alone; each record moves its own rating
   * against the other's as it stood going in.
   *
   * A guest identity costs nothing, so a rating could be farmed by beating a
   * fresh one in a private window over and over. Each side's rating only moves
   * against an opponent worth rating against — signed in, or a guest with
   * `CREDIBLE_GAMES` finished games behind them — unless that side is still
   * provisional itself, which is what lets two newcomers' first games count;
   * and only `RATED_PER_OPPONENT_DAILY` times a day against the same person.
   * Anything past that is recorded, unrated.
   */
  private async recordFinish(finished: FinishedGame): Promise<void> {
    const outcome = outcomeOf(finished.game, finished.gameState, finished.seatIds, finished.forfeited)
    const people = finished.seatIds.filter((seat) => {
      const stored = finished.seats[seat]
      return stored && !stored.bot && isPerson(stored.player.id)
    })
    if (!people.length) return
    const handles = new Map<SeatId, string>()
    for (const seat of people) handles.set(seat, await playerHandle(finished.seats[seat]!.player.id))
    const history = (finished.gameState as { history?: unknown[] } | null)?.history
    const ratable =
      finished.game === 'chess' &&
      people.length === 2 &&
      finished.seatIds.length === 2 &&
      Array.isArray(history) &&
      history.length >= 2
    const opponentOf = (seat: SeatId) => people.find((other) => other !== seat)
    const standings = new Map<SeatId, ChessStanding>()
    if (ratable)
      for (const seat of people)
        standings.set(
          seat,
          await this.env.PLAYER.getByName(handles.get(seat)!).chessRating(
            handles.get(opponentOf(seat)!),
            finished.at,
          ),
        )
    const ratedFor = (seat: SeatId): boolean => {
      const other = opponentOf(seat)
      if (!ratable || !other) return false
      const mine = standings.get(seat)!,
        theirs = standings.get(other)!
      const credible =
        !finished.seats[other]!.player.isGuest ||
        theirs.played >= CREDIBLE_GAMES ||
        mine.games < PROVISIONAL_GAMES
      return credible && mine.againstToday < RATED_PER_OPPONENT_DAILY
    }
    await Promise.all(
      people.map((seat) => {
        const opponent = opponentOf(seat)
        return this.env.PLAYER.getByName(handles.get(seat)!).record({
          self: selfOf(finished.seats[seat]!.player),
          game: finished.game,
          code: finished.code,
          round: finished.round,
          result: outcome[seat].result,
          ...(outcome[seat].place ? { place: outcome[seat].place } : {}),
          seats: finished.seatIds.length,
          opponents: finished.seatIds
            .filter((other) => other !== seat && finished.seats[other])
            .map((other) => {
              const stored = finished.seats[other]!
              const handle = handles.get(other)
              return stored.bot
                ? { name: stored.player.name, bot: true }
                : { name: stored.player.name, ...(handle ? { handle } : {}) }
            }),
          at: finished.at,
          ...(opponent && ratedFor(seat)
            ? { rated: { opponent: standings.get(opponent)!.rating, against: handles.get(opponent) } }
            : {}),
        })
      }),
    )
  }

  /**
   * How many players this table is currently the one playing. Only while the
   * game is actually on: bots the host parked in an open room are seats set
   * aside, not players, and a finished game is nobody playing anything.
   */
  private liveBots(record: RoomRecord): number {
    if (record.status !== 'playing') return 0
    return record.seatIds.filter((seat) => record.seats[seat]?.bot).length
  }

  /**
   * Tell the site's counter how many players this room is playing itself, so a
   * bot at a table counts as somebody online — which it is.
   *
   * Hung off `save()` because that is the one door every mutation goes
   * through, including each bot's own turn. Fire-and-forget for the same
   * reason as `pushLobby`: a count being a beat stale is tolerable, a move
   * waiting on another Durable Object is not. The throttle keeps a busy room
   * to roughly a visitor's heartbeat rate while still reacting at once to a
   * count that actually changed; a room with no bots never pushes at all.
   */
  private pushBotPresence(record: RoomRecord): void {
    const bots = this.liveBots(record)
    const now = Date.now()
    const changed = bots !== this.lastBotPush.bots
    if (!changed && (bots === 0 || now - this.lastBotPush.at < BOT_PRESENCE_REFRESH_MS)) return
    this.lastBotPush = { at: now, bots }
    this.ctx.waitUntil(this.env.PRESENCE.getByName('global').reportBots(record.code, record.game, bots))
  }

  /**
   * One alarm serves two masters: the room's 24h expiry and the adapter's timed
   * presentation phases. Whichever comes first takes the slot, and `alarm()`
   * re-arms for the other. Both deadlines are read off the record rather than
   * recomputed, so an unrelated save — a disconnect stamping `awaySince`, say —
   * cannot quietly push a phase's deadline further out.
   */
  private async armAlarm(record: RoomRecord): Promise<void> {
    await this.ctx.storage.setAlarm(Math.min(record.autoAt ?? Infinity, record.expiresAt))
  }

  /**
   * Rooms only exist for registered games and they expire in a day, so a missing
   * adapter means a deploy dropped a game out from under a live room.
   */
  private adapter(record: RoomRecord): GameAdapter {
    const adapter = getAdapter(record.game)
    if (!adapter) throw new Error(`no adapter registered for game "${record.game}"`)
    return adapter
  }

  /** The game's outside world: injected so adapters stay pure and replayable. */
  private gameCtx(): Ctx {
    return { random: secureRandom, now: Date.now() }
  }

  /** A finished game has no phases left to wait out, whatever shape its last state is in. */
  private pendingPhase(record: RoomRecord): { afterMs: number; resolve(s: unknown, c: Ctx): unknown } | null {
    if (record.status !== 'playing' || record.gameState === null) return null
    return this.adapter(record).pending(record.gameState)
  }

  /**
   * The seat the room plays for, and how. A bot is always driven — the table is
   * never waiting on it in any meaningful sense. An abandoned seat keeps the
   * stricter rule: one away player among present ones is just a player the
   * others are still waiting for, so the room only stands in once every seat the
   * game is blocked on has gone.
   */
  private autoSeat(record: RoomRecord): { seat: SeatId; bot: boolean; skill: string } | null {
    if (record.status !== 'playing' || record.gameState === null) return null
    const waiting = this.adapter(record).waitingOn(record.gameState, record.seatIds)
    if (!waiting.length) return null
    // Bots first, and not only for multi-seat waits: when the single waiting seat
    // is a bot, the abandoned rule below cannot move it — a bot is never
    // `abandoned`, so `every` is false and the table would sit here forever.
    // Scanning the whole list rather than `waiting[0]` also covers an adapter that
    // blocks on several seats at once, should one ever exist.
    const bot = waiting.find((seat) => record.seats[seat]?.bot)
    if (bot) return { seat: bot, bot: true, skill: record.seats[bot]!.bot!.skill }
    if (!waiting.every((seat) => record.seats[seat]?.abandoned)) return null
    return { seat: waiting[0], bot: false, skill: '' }
  }

  /**
   * Arm (or disarm) whichever pause applies next — a bot's think delay or an
   * abandoned seat's stand-in deadline, picked by `autoSeat`. Unlike a phase
   * deadline this tracks presence, which changes outside `setGameState` — a
   * reclaim, a claim, a seat turning into a bot — so it is reconsidered whenever
   * that does. It never takes the slot from a live phase, and never restamps a
   * beat that is already counting down: either would let an unrelated save move
   * a deadline someone — or something — is waiting on. Callers that know the
   * deadline is spent clear `autoAt` before calling.
   */
  private stampAuto(record: RoomRecord): void {
    if (this.pendingPhase(record)) return
    const next = this.autoSeat(record)
    if (!next) {
      record.autoAt = undefined
      record.standInStalls = undefined
      return
    }
    const bots = this.adapter(record).bots
    const delay = next.bot ? (bots?.thinkMs?.(next.skill) ?? BOT_THINK_MS) : STAND_IN_DELAY_MS
    record.autoAt ??= Date.now() + delay
  }

  /**
   * The one door the game state changes through: it settles the room's status
   * and stamps the timed phase's deadline, once, as that phase is entered.
   * Status is decided first so a game that just ended cannot leave a deadline
   * behind for an alarm to chase. The state has moved, so any deadline it had is
   * spent — it is cleared here rather than left for `stampAuto` to preserve.
   */
  private setGameState(record: RoomRecord, state: unknown): void {
    record.gameState = state
    record.stateAt = Date.now()
    if (this.adapter(record).isFinished(state)) record.status = 'finished'
    // Logged as the view nobody is sitting behind, so a replay can never show
    // what the table could not see.
    this.replay.record(this.adapter(record).view(state, null), record.stateAt)
    if (record.status === 'finished') this.replay.finish(record.forfeited)
    const pending = this.pendingPhase(record)
    record.autoAt = pending ? Date.now() + pending.afterMs : undefined
    // A game that has come to rest on an abandoned seat — or a bot's turn — still
    // has to move on.
    if (!pending) this.stampAuto(record)
  }

  /** A new game is about to be dealt at this table: start its replay, seated as it is now. */
  private beginReplay(record: RoomRecord): void {
    this.replay.begin(
      record.game,
      record.seatIds.flatMap((seat) => {
        const stored = record.seats[seat]
        return stored
          ? [{ seat, name: stored.player.name, ...(stored.bot ? { bot: { skill: stored.bot.skill } } : {}) }]
          : []
      }),
    )
  }

  /**
   * The room's latest finished game, serialised (see `Replay`), or null when
   * there is no room or it has not finished a game yet. A game in progress is
   * never offered: a replay is something to watch afterwards, not a second
   * way to watch live.
   */
  async replayJson(): Promise<string | null> {
    const record = await this.load()
    return record ? this.replay.read(record.expiresAt) : null
  }

  /**
   * Bring the lobby round to this room, at most once per `LOBBY_THROTTLE_MS`
   * however many seats change in between. Fire-and-forget: lobby staleness is
   * tolerable, gameplay latency is not.
   */
  private syncLobby(record: RoomRecord): void {
    if (record.visibility !== 'public' || this.lobbyTimer) return
    this.lobbyTimer = setTimeout(() => {
      this.lobbyTimer = null
      this.pushLobby()
    }, LOBBY_THROTTLE_MS)
  }

  /**
   * A public room is listed while it is open, and only while somebody is
   * actually there: its host, or a person in a seat, connected. A room made and
   * never entered is not a table anyone can sit down with, and listing it from
   * the moment it was made let a script fill the lobby with names for hours.
   * The lobby itself hides a room with no free seat.
   */
  private pushLobby(): void {
    const record = this.cached
    if (!record || record.visibility !== 'public') return
    const connected = this.connectedIds()
    const attended =
      connected.has(record.hostId) ||
      record.seatIds.some((seat) => {
        const stored = record.seats[seat]
        return stored && !stored.bot && connected.has(stored.player.id)
      })
    const summary =
      record.status === 'open' && attended
        ? {
            code: record.code,
            game: record.game,
            hostName: record.hostName,
            seatsTaken: record.seatIds.filter((seat) => record.seats[seat]).length,
            seatsTotal: record.seatsTotal,
            createdAt: record.createdAt,
            // A seat a bot is in is taken, but a table of bots is not a table of
            // people — the lobby says both numbers rather than implying the wrong one.
            bots: record.seatIds.filter((seat) => record.seats[seat]?.bot).length,
          }
        : null
    const shown = JSON.stringify(summary)
    if (shown === this.lobbyShown) return
    this.lobbyShown = shown
    const lobby = this.env.LOBBY.getByName('global')
    this.ctx.waitUntil(
      (summary ? lobby.upsert(summary, record.source ?? null) : lobby.remove(record.code)).catch(() => {
        // Told nothing after all: try again on the next change.
        this.lobbyShown = undefined
      }),
    )
  }

  async create(input: {
    code: string
    game: GameId
    visibility: RoomVisibility
    host: PlayerInfo
    seats: number
    options: unknown
    bots: string[]
    autoStart: boolean
    source?: string | null
  }): Promise<boolean> {
    // `false` means "that code is taken"; an unregistered game is a caller bug,
    // and the router has already refused those.
    if (await this.load()) return false
    const adapter = getAdapter(input.game)
    if (!adapter) throw new Error(`no adapter registered for game "${input.game}"`)
    const record: RoomRecord = {
      code: input.code,
      game: input.game,
      visibility: input.visibility,
      status: 'open',
      hostId: input.host.id,
      hostName: input.host.name,
      createdAt: Date.now(),
      expiresAt: Date.now() + ROOM_TTL_MS,
      seatIds: adapter.seatIds(input.seats),
      seatsTotal: input.seats,
      options: input.options,
      seats: {},
      gameState: null,
    }
    // Bots take the seats furthest from the host, so the seats people are meant
    // to take are the ones the room offers first.
    const botSeats = record.seatIds.slice(record.seatIds.length - input.bots.length)
    botSeats.forEach((seat, index) => {
      record.seats[seat] = {
        player: { id: `bot:${seat}`, name: this.botNameFor(record, seat, adapter.bots!), isGuest: true },
        wantsRematch: false,
        bot: { skill: input.bots[index] },
      }
    })
    if (input.autoStart) record.autoStart = true
    if (input.source) record.source = input.source
    // Not listed yet, public or not: see `pushLobby`.
    await this.save(record)
    return true
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket')
      return new Response('expected websocket', { status: 426 })
    const record = await this.load()
    const now = Date.now()
    if (record) {
      this.sweepPending(now)
      // Too many sockets sitting here without joining: the oldest go, so
      // whatever is holding them open cannot keep a real player's out.
      const pending = this.sockets()
        .filter((ws) => !this.member(ws))
        .sort((a, b) => (this.attachment(a).at ?? 0) - (this.attachment(b).at ?? 0))
      for (const ws of pending.slice(0, Math.max(0, pending.length - MAX_PENDING_SOCKETS + 1)))
        this.drop(ws, CLOSE_RETRY, 'JOIN_TIMEOUT')
    }
    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1])
    pair[1].serializeAttachment({
      at: now,
      ...(isLocalWorker(request.url) ? { local: true } : {}),
    } satisfies Attachment)
    if (!record) {
      this.fail(pair[1], 'ROOM_NOT_FOUND', 'This room does not exist or has expired.')
      pair[1].close(CLOSE_CODES.notFound, 'ROOM_NOT_FOUND')
    } else this.armSweep(now)
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  /** Close every socket that has sat here past `JOIN_DEADLINE_MS` without joining. */
  private sweepPending(now: number): void {
    for (const ws of this.sockets()) {
      const { at, player } = this.attachment(ws)
      if (!player && at !== undefined && now - at >= JOIN_DEADLINE_MS)
        this.drop(ws, CLOSE_RETRY, 'JOIN_TIMEOUT')
    }
  }

  /**
   * Wake up when the oldest unjoined socket's deadline passes. A timer rather
   * than the alarm, whose one slot belongs to the game and the room's expiry;
   * a room with a timer pending does not hibernate, which costs at most the
   * deadline itself, and a room evicted with one pending sweeps on its next
   * socket instead.
   */
  private armSweep(now: number): void {
    if (this.sweepTimer) return
    const deadlines = this.sockets().flatMap((ws) => {
      const { at, player } = this.attachment(ws)
      return !player && at !== undefined ? [at + JOIN_DEADLINE_MS] : []
    })
    if (!deadlines.length) return
    this.sweepTimer = setTimeout(
      () => {
        this.sweepTimer = null
        const at = Date.now()
        this.sweepPending(at)
        this.armSweep(at)
      },
      Math.max(0, Math.min(...deadlines) - now) + 50,
    )
  }

  private fail(ws: WebSocket, code: ErrorCode, message: string): void {
    const error: ServerMessage = { type: 'error', code, message }
    ws.send(JSON.stringify(error))
  }

  private connectedIds(): Set<string> {
    const ids = new Set<string>()
    for (const ws of this.sockets()) {
      const player = this.member(ws)
      if (player) ids.add(player.id)
    }
    return ids
  }

  /** Sockets that have joined, other than `except` — the one asking to. */
  private joinedSockets(except: WebSocket): number {
    let count = 0
    for (const ws of this.sockets()) if (ws !== except && this.member(ws)) count++
    return count
  }

  private seatOf(record: RoomRecord, playerId: string): SeatId | null {
    for (const seat of record.seatIds) if (record.seats[seat]?.player.id === playerId) return seat
    return null
  }

  /** Seat players are stripped down to public fields; only `gameState` is per-viewer. */
  private snapshot(
    record: RoomRecord,
    viewerSeat: SeatId | null,
    connected: Set<string> = this.connectedIds(),
  ): RoomSnapshot {
    // Everyone here who holds no seat: people, not tabs, so one watcher with two
    // windows open is one.
    const seated = new Set(record.seatIds.map((seat) => record.seats[seat]?.player.id))
    const spectators = [...connected].filter((id) => !seated.has(id)).length
    const seats: Partial<Record<SeatId, SeatInfo>> = {}
    for (const seat of record.seatIds) {
      const stored = record.seats[seat]
      if (!stored) continue
      const { id, ...player } = stored.player
      const isConnected = stored.bot ? true : connected.has(id)
      seats[seat] = {
        player,
        connected: isConnected,
        wantsRematch: stored.wantsRematch,
        ...(isConnected || !stored.disconnectedAt ? {} : { awaySince: stored.disconnectedAt }),
        ...(stored.abandoned ? { abandoned: true } : {}),
        ...(stored.bot ? { bot: stored.bot } : {}),
      }
    }
    return {
      protocol: PROTOCOL_VERSION,
      code: record.code,
      game: record.game,
      visibility: record.visibility,
      status: record.status,
      seatIds: record.seatIds,
      seats,
      spectators,
      gameState: record.gameState === null ? null : this.adapter(record).view(record.gameState, viewerSeat),
      ...(record.gameState === null || record.stateAt === undefined
        ? {}
        : {
            timing: {
              now: Date.now(),
              since: record.stateAt,
              ...(record.autoAt ? { due: record.autoAt } : {}),
            },
          }),
    }
  }

  /**
   * Send the room as it stands. Everyone, by default — which also settles any
   * presence broadcast still waiting, since this one carries the same news. With
   * `only`, just those sockets; with `stale`, just the sockets a presence change
   * has happened behind (see `presenceSoon`).
   */
  private broadcast(
    record: RoomRecord,
    { only, stale = false }: { only?: WebSocket[]; stale?: boolean } = {},
  ): void {
    if (!only && !stale && this.presenceTimer) {
      clearTimeout(this.presenceTimer)
      this.presenceTimer = null
    }
    const connected = this.connectedIds()
    // One snapshot per distinct viewpoint, serialised once: redaction is pure,
    // so every seat needs it built once and all the spectators share a single
    // `null` view. Only `you` differs per socket, and it is spliced in.
    const views = new Map<SeatId | null, string>()
    for (const ws of only ?? this.sockets()) {
      const player = this.member(ws)
      if (!player) continue
      if (stale && (this.presenceSent.get(ws) ?? -1) >= this.presenceVersion) continue
      const seat = this.seatOf(record, player.id)
      let json = views.get(seat)
      if (json === undefined) views.set(seat, (json = JSON.stringify(this.snapshot(record, seat, connected))))
      const you: YouInfo = { id: player.id, seat, isHost: player.id === record.hostId }
      ws.send(`{"type":"room","snapshot":${json},"you":${JSON.stringify(you)}}`)
      this.presenceSent.set(ws, this.presenceVersion)
    }
  }

  /**
   * Somebody arrived or left, and nothing else changed: tell the room once
   * `PRESENCE_COALESCE_MS` have passed, in one broadcast for however many
   * came and went meanwhile — and only to the sockets that have not already
   * been sent a snapshot since. Anything that broadcasts in between carries
   * the news itself and cancels this.
   */
  private presenceSoon(): void {
    this.presenceVersion++
    if (this.presenceTimer) return
    this.presenceTimer = setTimeout(() => {
      this.presenceTimer = null
      const record = this.cached
      if (record) this.broadcast(record, { stale: true })
    }, PRESENCE_COALESCE_MS)
  }

  /**
   * Whether `ws` may send another frame (see `MESSAGE_LIMITS`). A frame over
   * the allowance is dropped; the first is answered with `RATE_LIMITED`, and
   * a socket that keeps going until it owes a whole burst is closed.
   */
  private allow(ws: WebSocket): boolean {
    const now = Date.now()
    const bucket = this.messageBuckets.get(ws) ?? { tokens: MESSAGE_LIMITS.burst, at: now, warned: false }
    bucket.tokens = Math.min(
      MESSAGE_LIMITS.burst,
      bucket.tokens + (now - bucket.at) / MESSAGE_LIMITS.refillMs,
    )
    bucket.at = now
    this.messageBuckets.set(ws, bucket)
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1
      bucket.warned = false
      return true
    }
    bucket.tokens -= 1
    if (bucket.tokens <= -MESSAGE_LIMITS.burst) {
      this.drop(ws, CLOSE_POLICY, 'RATE_LIMITED')
      this.ctx.waitUntil(this.handleDeparture(ws))
    } else if (!bucket.warned) {
      bucket.warned = true
      this.fail(ws, 'RATE_LIMITED', 'Too many messages at once — slow down a little.')
    }
    return false
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (this.departed.has(ws) || !this.allow(ws)) return
    // Measured before parsing, so a megabyte of JSON costs the room nothing but this.
    if ((typeof raw === 'string' ? raw.length : raw.byteLength) > MAX_FRAME_CHARS)
      return this.fail(ws, 'BAD_MESSAGE', 'That message is too large.')
    const record = await this.load()
    if (!record) {
      this.fail(ws, 'ROOM_NOT_FOUND', 'This room does not exist or has expired.')
      ws.close(CLOSE_CODES.notFound, 'ROOM_NOT_FOUND')
      return
    }
    let message: ClientMessage
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))
    } catch {
      return this.fail(ws, 'BAD_MESSAGE', 'Messages must be JSON.')
    }
    // `null`, `3` and `[]` are all valid JSON, and reading `.type` off the
    // first would throw inside the Durable Object instead of answering.
    if (typeof message !== 'object' || message === null || Array.isArray(message))
      return this.fail(ws, 'BAD_MESSAGE', 'Messages must be JSON objects.')
    // No TTL refresh here: `save()` re-arms the alarm on every mutation, and a
    // room whose only traffic is non-mutating messages has nothing worth keeping.
    if (message.type === 'join') return this.handleJoin(ws, record, message)
    const player = this.member(ws)
    if (!player) return this.fail(ws, 'NOT_JOINED', 'Send a join message first.')
    switch (message.type) {
      case 'sit':
        return this.handleSit(ws, record, player, message.seat)
      case 'leaveSeat':
        return this.handleLeaveSeat(ws, record, player)
      case 'start':
        return this.handleStart(ws, record, player)
      case 'action':
        return this.handleAction(ws, record, player, message.action)
      case 'rematch':
        return this.handleRematch(ws, record, player)
      case 'claim':
        return this.handleClaim(ws, record, player)
      case 'addBot':
        return this.handleAddBot(ws, record, player, message.seat, message.skill)
      case 'removeBot':
        return this.handleRemoveBot(ws, record, player, message.seat)
      case 'react':
        return this.handleReact(ws, record, player, message.reaction)
      default:
        return this.fail(ws, 'BAD_MESSAGE', 'Unknown message type.')
    }
  }

  private async handleJoin(
    ws: WebSocket,
    record: RoomRecord,
    message: Extract<ClientMessage, { type: 'join' }>,
  ): Promise<void> {
    // One join per socket, as a browser sends: a socket is one person. A few
    // tries are allowed for the ones that fail; past that, verifying tokens
    // for it is work the room will not keep doing.
    const attachment = this.attachment(ws)
    if (attachment.player) return this.fail(ws, 'BAD_MESSAGE', 'Already joined.')
    const joins = (attachment.joins ?? 0) + 1
    if (joins > MAX_JOINS_PER_SOCKET) return this.drop(ws, CLOSE_POLICY, 'TOO_MANY_JOINS')
    ws.serializeAttachment({ ...attachment, joins } satisfies Attachment)
    if (message.protocol !== PROTOCOL_VERSION)
      return this.fail(ws, 'PROTOCOL_MISMATCH', 'Please refresh to get the latest version.')
    if (!cleanName(message.name)) return this.fail(ws, 'BAD_MESSAGE', 'A display name is required.')
    const player = await resolveIdentity(message, this.env, verifyClerkToken, attachment.local === true)
    if (!player) return this.fail(ws, 'BAD_TOKEN', 'Could not verify your identity.')
    // The socket may have gone, or joined on a second frame, while the token was checked.
    if (this.departed.has(ws) || this.member(ws)) return
    const seat = this.seatOf(record, player.id)
    // Somebody without a seat watches — at a full table, a game under way, a
    // finished one — and is sent the view nobody is sitting behind. Only a room
    // with no space left even to watch from turns them away.
    if (!seat && this.joinedSockets(ws) >= MAX_ROOM_SOCKETS) {
      this.fail(ws, 'ROOM_FULL', 'This room is full.')
      ws.close(CLOSE_CODES.full, 'ROOM_FULL')
      return
    }
    const reactions = Array.isArray(message.features) && message.features.includes('reactions')
    ws.serializeAttachment({
      ...this.attachment(ws),
      player,
      ...(reactions ? { reactions: true } : {}),
    } satisfies Attachment)
    if (seat) {
      if (record.status === 'playing' && record.seats[seat]!.disconnectedAt)
        track(this.env, 'player_back', { game: record.game, detail: 'mid-game' })
      record.seats[seat] = {
        ...record.seats[seat]!,
        player,
        disconnectedAt: undefined,
        abandoned: undefined,
      }
      // They are back, so the room stops playing their turns for them.
      this.stampAuto(record)
      await this.save(record)
    }
    // A solo table against bots: the host is the only person expected, so there
    // is nothing to wait in a lobby for. The status test sits after
    // `resolveIdentity`'s await and `startGame` flips it synchronously, so two
    // tabs arriving together cannot both start the game. `serializeAttachment`
    // has already run, so the broadcast reaches this socket too.
    const free = record.seatIds.filter((id) => !record.seats[id])
    if (record.autoStart && record.status === 'open' && player.id === record.hostId && free.length === 1) {
      record.seats[free[0]] = { player, wantsRematch: false }
      return this.startGame(record)
    }
    // The newcomer hears at once; everyone else hears they arrived with
    // whoever else arrives in the same few milliseconds.
    this.presenceSoon()
    this.broadcast(record, { only: [ws] })
    this.syncLobby(record)
  }

  private async handleSit(
    ws: WebSocket,
    record: RoomRecord,
    player: PlayerInfo,
    seat: SeatId,
  ): Promise<void> {
    if (!record.seatIds.includes(seat)) return this.fail(ws, 'BAD_MESSAGE', 'Unknown seat.')
    if (record.status !== 'open') return this.fail(ws, 'ALREADY_STARTED', 'The game has already started.')
    const occupant = record.seats[seat]
    if (occupant && occupant.player.id !== player.id)
      return this.fail(ws, 'SEAT_TAKEN', 'That seat is taken.')
    const previous = this.seatOf(record, player.id)
    if (previous && previous !== seat) delete record.seats[previous]
    record.seats[seat] = { player, wantsRematch: false }
    await this.save(record)
    this.syncLobby(record)
    this.broadcast(record)
    // Somebody sat down at a table its host has stepped away from.
    if (
      !previous &&
      player.id !== record.hostId &&
      isPerson(record.hostId) &&
      !this.connectedIds().has(record.hostId)
    )
      this.ctx.waitUntil(
        this.notify(record.hostId, 'joined', joinedMessage(record.game, record.code, player.name)).catch(
          () => undefined,
        ),
      )
  }

  private async handleLeaveSeat(ws: WebSocket, record: RoomRecord, player: PlayerInfo): Promise<void> {
    if (record.status !== 'open')
      return this.fail(ws, 'ALREADY_STARTED', 'Seats are locked once the game starts — resign instead.')
    const seat = this.seatOf(record, player.id)
    if (!seat) return this.fail(ws, 'NOT_SEATED', 'You are not seated.')
    delete record.seats[seat]
    await this.save(record)
    this.syncLobby(record)
    this.broadcast(record)
  }

  /**
   * A name no other bot at this table answers to. The obvious index — how many
   * bots are already seated — collides as soon as one is removed and another
   * added: two bots are seated as Jules and Cleo, Jules leaves, and the next
   * bot is index 1 again. Scanning for a free name costs nothing at these seat
   * counts and cannot hand out the same name twice.
   */
  private botNameFor(record: RoomRecord, seat: SeatId, bots: NonNullable<GameAdapter['bots']>): string {
    const taken = new Set(
      record.seatIds.filter((id) => record.seats[id]?.bot).map((id) => record.seats[id]!.player.name),
    )
    for (let index = 0; index < record.seatIds.length; index++) {
      const name = bots.name(seat, index)
      if (!taken.has(name)) return name
    }
    // Every name this game offers is already at the table, which only happens
    // if it has fewer names than seats. Falling back beats refusing the bot.
    return bots.name(seat, taken.size)
  }

  /**
   * Fill an empty seat with a player the room itself takes the turns for. Host
   * only and open only, for the same reason `start` is: a table's shape is the
   * host's to set, and it stops changing once the game does.
   */
  private async handleAddBot(
    ws: WebSocket,
    record: RoomRecord,
    player: PlayerInfo,
    seat: SeatId,
    skill: string | undefined,
  ): Promise<void> {
    if (player.id !== record.hostId) return this.fail(ws, 'NOT_HOST', 'Only the room creator can add a bot.')
    if (record.status !== 'open') return this.fail(ws, 'ALREADY_STARTED', 'The game has already started.')
    if (!record.seatIds.includes(seat)) return this.fail(ws, 'BAD_MESSAGE', 'Unknown seat.')
    if (record.seats[seat]) return this.fail(ws, 'SEAT_TAKEN', 'That seat is taken.')
    const bots = this.adapter(record).bots
    if (!bots) return this.fail(ws, 'NOT_ALLOWED', 'This game has no bots.')
    const chosen = skill ?? bots.skills[0]
    if (!bots.skills.includes(chosen)) return this.fail(ws, 'BAD_MESSAGE', 'Unknown bot skill.')
    record.seats[seat] = {
      // `bot:` is a namespace `resolveIdentity` can never mint, so this id can
      // never arrive from a client claiming to be one.
      player: { id: `bot:${seat}`, name: this.botNameFor(record, seat, bots), isGuest: true },
      wantsRematch: false,
      bot: { skill: chosen },
    }
    await this.save(record)
    this.syncLobby(record)
    this.broadcast(record)
  }

  /** Give a bot's seat back, so a person who turned up late can have it. */
  private async handleRemoveBot(
    ws: WebSocket,
    record: RoomRecord,
    player: PlayerInfo,
    seat: SeatId,
  ): Promise<void> {
    if (player.id !== record.hostId)
      return this.fail(ws, 'NOT_HOST', 'Only the room creator can remove a bot.')
    if (record.status !== 'open') return this.fail(ws, 'ALREADY_STARTED', 'The game has already started.')
    if (!record.seats[seat]?.bot) return this.fail(ws, 'NOT_ALLOWED', 'That seat is not a bot.')
    delete record.seats[seat]
    await this.save(record)
    this.syncLobby(record)
    this.broadcast(record)
  }

  /**
   * A quick reaction, passed straight round the room and forgotten: it is not
   * saved, not in any snapshot, and costs the room nothing but the sends.
   * Anyone in the room may react — spectators on a smaller allowance — and a
   * reaction over the allowance is dropped without a word, since the bar that
   * sent it keeps to the same allowance and only a script would overrun it.
   */
  private handleReact(ws: WebSocket, record: RoomRecord, player: PlayerInfo, reaction: unknown): void {
    if (!isReaction(reaction)) return this.fail(ws, 'BAD_MESSAGE', 'Unknown reaction.')
    const seat = this.seatOf(record, player.id)
    const limit = seat ? REACTION_LIMITS.seated : REACTION_LIMITS.watching
    const now = Date.now()
    const bucket = this.reactionBuckets.get(player.id) ?? { tokens: limit.burst, at: now }
    bucket.tokens = Math.min(limit.burst, bucket.tokens + (now - bucket.at) / limit.refillMs)
    bucket.at = now
    this.reactionBuckets.set(player.id, bucket)
    if (bucket.tokens < 1) return
    bucket.tokens -= 1
    const frame = JSON.stringify({
      type: 'reaction',
      seat,
      reaction,
      id: `${now.toString(36)}-${(++this.reactionSeq).toString(36)}`,
      at: now,
    } satisfies ServerMessage)
    for (const socket of this.sockets()) if (this.attachment(socket).reactions) socket.send(frame)
    track(this.env, 'reaction', { game: record.game, detail: reaction, value: seat ? 0 : 1 })
  }

  private async handleStart(ws: WebSocket, record: RoomRecord, player: PlayerInfo): Promise<void> {
    if (record.status !== 'open') return this.fail(ws, 'ALREADY_STARTED', 'The game has already started.')
    if (player.id !== record.hostId)
      return this.fail(ws, 'NOT_HOST', 'Only the room creator can start the game.')
    const adapter = this.adapter(record)
    const occupied = record.seatIds.filter((seat) => record.seats[seat])
    if (adapter.requireFull && occupied.length < record.seatIds.length)
      return this.fail(ws, 'NOT_READY', 'Every seat must be taken first.')
    if (occupied.length < adapter.minSeats)
      return this.fail(ws, 'NOT_READY', `At least ${adapter.minSeats} players must be seated.`)
    return this.startGame(record)
  }

  /**
   * Deal the game and tell the room. Split out of `handleStart` because a solo
   * table against bots starts itself the moment its host arrives, and two start
   * paths that settled seats differently would be two different games.
   */
  private async startGame(record: RoomRecord): Promise<void> {
    const adapter = this.adapter(record)
    const occupied = record.seatIds.filter((seat) => record.seats[seat])
    // A room made for four that starts with three plays as a three-player game,
    // so the empty seats are dropped and the rest slide onto the ids the
    // adapter would have handed out for that headcount.
    const played = adapter.seatIds(occupied.length)
    const seats: Partial<Record<SeatId, StoredSeat>> = {}
    occupied.forEach((seat, index) => {
      seats[played[index]] = record.seats[seat]!
    })
    record.seats = seats
    record.seatIds = played
    record.status = 'playing'
    this.beginReplay(record)
    this.setGameState(
      record,
      adapter.create(
        played.map((id) => ({ id, name: record.seats[id]!.player.name })),
        record.options,
        this.gameCtx(),
      ),
    )
    await this.save(record)
    this.syncLobby(record)
    this.broadcast(record)
  }

  private async handleAction(
    ws: WebSocket,
    record: RoomRecord,
    player: PlayerInfo,
    raw: unknown,
  ): Promise<void> {
    const seat = this.seatOf(record, player.id)
    if (!seat) return this.fail(ws, 'NOT_SEATED', 'Take a seat to play.')
    if (record.status !== 'playing' || record.gameState === null)
      return this.fail(ws, 'NOT_PLAYING', 'The game is not in progress.')
    const adapter = this.adapter(record)
    const action = adapter.validateAction(raw)
    if (action === null) return this.fail(ws, 'BAD_MESSAGE', 'Malformed action.')
    // Whether this seat is allowed to do this now is the game's business.
    const result = adapter.apply(record.gameState, seat, record.seatIds, action, this.gameCtx())
    if ('error' in result) return this.fail(ws, result.error, result.message)
    this.setGameState(record, result.state)
    await this.save(record)
    this.broadcast(record)
  }

  private async handleRematch(ws: WebSocket, record: RoomRecord, player: PlayerInfo): Promise<void> {
    const seat = this.seatOf(record, player.id)
    if (!seat) return this.fail(ws, 'NOT_SEATED', 'Take a seat to play.')
    if (record.status !== 'finished' || record.gameState === null)
      return this.fail(ws, 'NOT_FINISHED', 'The game is still going.')
    record.seats[seat] = { ...record.seats[seat]!, wantsRematch: true }
    const seated = record.seatIds.filter((s) => record.seats[s])
    // A seat the room plays cannot ask for anything, so waiting on it would
    // strand the table forever — true of an abandoned seat and of a bot alike.
    // Consensus is the players still here; the abandoned seat rides into the
    // next game, still abandoned, still played for — and still theirs to
    // reclaim, which is what clears the flag.
    const voting = seated.filter((s) => !record.seats[s]!.abandoned && !record.seats[s]!.bot)
    if (voting.length && voting.every((s) => record.seats[s]!.wantsRematch)) {
      const adapter = this.adapter(record)
      const { state, seatRemap } = adapter.rematch(
        record.gameState,
        seated.map((id) => ({ id, name: record.seats[id]!.player.name })),
        record.options,
        this.gameCtx(),
      )
      if (seatRemap) {
        const seats: Partial<Record<SeatId, StoredSeat>> = {}
        for (const from of record.seatIds) {
          const stored = record.seats[from]
          if (stored) seats[seatRemap[from] ?? from] = stored
        }
        record.seats = seats
      }
      for (const s of record.seatIds) if (record.seats[s]) record.seats[s]!.wantsRematch = false
      record.status = 'playing'
      this.beginReplay(record)
      this.setGameState(record, state)
    }
    await this.save(record)
    this.broadcast(record)
  }

  private async handleClaim(ws: WebSocket, record: RoomRecord, player: PlayerInfo): Promise<void> {
    const seat = this.seatOf(record, player.id)
    if (!seat) return this.fail(ws, 'NOT_SEATED', 'Take a seat to play.')
    if (record.status !== 'playing' || record.gameState === null)
      return this.fail(ws, 'NOT_PLAYING', 'The game is not in progress.')
    const adapter = this.adapter(record)
    // Who the claim is aimed at: the seats the game is blocked on, or — when
    // the game is waiting on the claimant themselves, as chess is between their
    // own moves — everyone else still at the table.
    // A bot is never away, so there is nothing to claim against it.
    const others = record.seatIds.filter((id) => id !== seat && record.seats[id] && !record.seats[id]!.bot)
    const waiting = adapter.waitingOn(record.gameState, record.seatIds).filter((id) => others.includes(id))
    const targets = waiting.length ? waiting : others
    if (!targets.length) return this.fail(ws, 'CLAIM_REJECTED', 'There is no opponent to claim against.')

    const connected = this.connectedIds()
    const now = Date.now()
    let shortestAway = Infinity
    for (const id of targets) {
      const stored = record.seats[id]!
      if (connected.has(stored.player.id) || !stored.disconnectedAt)
        return this.fail(ws, 'CLAIM_REJECTED', 'Your opponent is still here.')
      shortestAway = Math.min(shortestAway, now - stored.disconnectedAt)
    }
    if (shortestAway < CLAIM_WIN_AFTER_MS) {
      const wait = Math.ceil((CLAIM_WIN_AFTER_MS - shortestAway) / 1000)
      return this.fail(ws, 'CLAIM_REJECTED', `Hold on — you can claim the win in ${wait}s.`)
    }

    const ctx = this.gameCtx()
    let state = record.gameState
    let forfeited = false
    for (const id of targets) {
      const settled = adapter.resolveAbsent(state, id, record.seatIds, ctx)
      // `null`: this game has no stand-in for an absent seat, so the claim ends
      // the game where it stands.
      if (settled === null) {
        forfeited = true
        break
      }
      state = settled
      // The claim is granted once and stands: a seat the room has now played
      // through keeps being played through, turn after turn, until it comes back.
      record.seats[id]!.abandoned = true
      if (adapter.isFinished(state)) break
    }
    // Settle the status before the state, so a game forfeited mid-phase does not
    // leave an auto-advance deadline behind on a record nobody will play again.
    if (forfeited) {
      record.status = 'finished'
      record.forfeited = targets
    }
    // A claim aimed at a seat with nothing outstanding — mid-beat, or already
    // being played by the room — grants the abandonment and no more. Putting the
    // unchanged state back through `setGameState` would restamp the deadline of
    // the beat everyone is currently watching, pushing it out on every click.
    if (forfeited || state !== record.gameState) this.setGameState(record, state)
    else this.stampAuto(record)
    await this.save(record)
    this.broadcast(record)
  }

  /**
   * A socket went away: stamp any seat that just lost its last connection, then
   * tell everyone — with whoever else leaves in the same few milliseconds (see
   * `presenceSoon`). A socket that never joined was nobody anyone could see.
   */
  private async handleDeparture(ws: WebSocket): Promise<void> {
    const record = await this.load()
    if (!record || !this.member(ws)) return
    const connected = this.connectedIds()
    let changed = false
    for (const seat of record.seatIds) {
      const stored = record.seats[seat]
      // A bot has no socket to lose, so absence means nothing for it.
      if (stored && !stored.bot && !connected.has(stored.player.id) && !stored.disconnectedAt) {
        stored.disconnectedAt = Date.now()
        changed = true
        if (record.status === 'playing')
          track(this.env, 'player_left', { game: record.game, detail: 'mid-game' })
      }
    }
    if (changed) await this.save(record)
    if (!connected.size) this.reactionBuckets.clear()
    this.presenceSoon()
    this.syncLobby(record)
  }

  /**
   * The browser closed its socket. The close is answered — the runtime does
   * not do it for us, and a browser whose close goes unanswered sits in
   * CLOSING for ten seconds or so before it gives up, reconnects, and only
   * then gets its table back.
   */
  async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    this.departed.add(ws)
    try {
      ws.close(sendableClose(code), 'bye')
    } catch {
      // Already answered.
    }
    await this.handleDeparture(ws)
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.departed.add(ws)
    await this.handleDeparture(ws)
  }

  async alarm(): Promise<void> {
    // Which master woke us: before the room's own deadline it is the game —
    // a phase to resolve, or a turn to take for a seat nobody came back to —
    // and after it, the room's time has simply run out.
    const record = await this.load()
    if (record && Date.now() < record.expiresAt) {
      // Normal flow never lands here early — see `AUTO_AT_TOLERANCE_MS`. An
      // early fire re-arms for the same deadline instead of resolving on the
      // spot, so a retry or race costs a wasted alarm rather than a beat
      // everyone was shown ahead of time.
      const due = record.autoAt === undefined || Date.now() >= record.autoAt - AUTO_AT_TOLERANCE_MS
      if (!due) return this.armAlarm(record)
      if (this.pendingPhase(record)) return this.autoAdvance(record)
      if (this.autoSeat(record)) return this.playAuto(record)
    }
    await this.expire(record)
  }

  /**
   * Timed presentation phases (a die that has landed but hasn't been read out, a
   * card still in flight) resolve on the server's clock so every viewer sees the
   * same beat at the same time.
   */
  private async autoAdvance(record: RoomRecord): Promise<void> {
    const ctx = this.gameCtx()
    for (let step = 0; step < MAX_AUTO_ADVANCES; step++) {
      const pending = this.pendingPhase(record)
      // A phase that wants a delay of its own earns a fresh alarm; only the
      // zero-delay chains collapse into this single fire.
      if (!pending || (step > 0 && pending.afterMs > 0)) break
      this.setGameState(record, pending.resolve(record.gameState, ctx))
    }
    await this.save(record)
    this.broadcast(record)
  }

  /**
   * A seat the room plays still has to take its turns, or the table sits there
   * forever. One decision per fire: `setGameState` stamps whatever comes next and
   * the alarm comes back around for it.
   */
  private async playAuto(record: RoomRecord): Promise<void> {
    const adapter = this.adapter(record)
    const next = this.autoSeat(record)!
    const before = record.gameState
    const settled = next.bot
      ? adapter.bots!.decide(before, next.seat, record.seatIds, next.skill, this.gameCtx())
      : adapter.resolveAbsent(before, next.seat, record.seatIds, this.gameCtx())
    // `null`: nobody stands in at this game, so it ends where the absence left it.
    // Only `resolveAbsent` may say so — a bot's game is never ended by its bot.
    if (settled === null) {
      record.status = 'finished'
      record.forfeited = [next.seat]
    }
    this.setGameState(record, settled ?? before)
    // A stand-in that settles nothing leaves the room facing the same state, so
    // the deadline `setGameState` just stamped would wake it on it again. Keep
    // retrying — the block may clear — but only a few times, then let the expiry
    // have the slot back rather than spin on it for a day. Nothing is stranded
    // either way: the next action or reclaim re-arms it.
    if (settled !== before) record.standInStalls = undefined
    else if ((record.standInStalls = (record.standInStalls ?? 0) + 1) >= MAX_STAND_IN_STALLS)
      record.autoAt = undefined
    await this.save(record)
    this.broadcast(record)
  }

  private async expire(record: RoomRecord | null): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) ws.close(CLOSE_CODES.expired, 'ROOM_EXPIRED')
    if (record?.visibility === 'public') await this.env.LOBBY.getByName('global').remove(record.code)
    // Unlike the lobby above, this is not public-only: a private solo table
    // against bots is exactly the kind of room that was counting. The TTL
    // would forget it anyway, so this is promptness, not correctness.
    if (record) await this.env.PRESENCE.getByName('global').reportBots(record.code, record.game, 0)
    if (record?.status === 'playing')
      track(this.env, 'game_finished', {
        game: record.game,
        detail: 'abandoned',
        count: durationBucket(Date.now() - (record.ledger?.startedAt ?? Date.now())),
        value: record.seatIds.length,
      })
    // Nobody is at this table any more, whatever it was in the middle of.
    if (record?.ledger)
      await Promise.all(
        Object.keys(record.ledger.tables).map(async (id) =>
          (await this.playerStub(id)).forgetTable(record.code).catch(() => undefined),
        ),
      )
    this.cached = null
    await this.ctx.storage.deleteAll()
    await this.ctx.storage.deleteAlarm()
    this.replay.forget()
  }
}
