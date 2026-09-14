import { DurableObject } from 'cloudflare:workers'
import { getAdapter } from '@games/shared/online'
import type { Ctx, GameAdapter } from '@games/shared/online/adapter'
import { CLAIM_WIN_AFTER_MS, CLOSE_CODES, PROTOCOL_VERSION } from '@games/shared/protocol'
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
} from '@games/shared/protocol'
import { cleanName, resolveIdentity } from './auth'
import type { Env } from './env'

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
  options: unknown
  seats: Partial<Record<SeatId, StoredSeat>>
  gameState: unknown
}

interface Attachment {
  player: PlayerInfo
}

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
    await this.ctx.storage.put('room', record)
    await this.armAlarm(record)
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
    if (this.adapter(record).isFinished(state)) record.status = 'finished'
    const pending = this.pendingPhase(record)
    record.autoAt = pending ? Date.now() + pending.afterMs : undefined
    // A game that has come to rest on an abandoned seat — or a bot's turn — still
    // has to move on.
    if (!pending) this.stampAuto(record)
  }

  /** Fire-and-forget: lobby staleness is tolerable, gameplay latency is not. */
  private pushLobby(record: RoomRecord): void {
    if (record.visibility !== 'public') return
    const lobby = this.env.LOBBY.getByName('global')
    if (record.status === 'open') {
      const seatsTaken = record.seatIds.filter((seat) => record.seats[seat]).length
      this.ctx.waitUntil(
        lobby.upsert({
          code: record.code,
          game: record.game,
          hostName: record.hostName,
          seatsTaken,
          seatsTotal: record.seatsTotal,
          createdAt: record.createdAt,
          // Placeholder: no bot seats exist yet. Task 11 counts them for real.
          bots: 0,
        }),
      )
    } else {
      this.ctx.waitUntil(lobby.remove(record.code))
    }
  }

  async create(input: {
    code: string
    game: GameId
    visibility: RoomVisibility
    host: PlayerInfo
    seats: number
    options: unknown
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
    await this.save(record)
    this.pushLobby(record)
    return true
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket')
      return new Response('expected websocket', { status: 426 })
    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1])
    if (!(await this.load())) {
      this.fail(pair[1], 'ROOM_NOT_FOUND', 'This room does not exist or has expired.')
      pair[1].close(CLOSE_CODES.notFound, 'ROOM_NOT_FOUND')
    }
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  private fail(ws: WebSocket, code: ErrorCode, message: string): void {
    const error: ServerMessage = { type: 'error', code, message }
    ws.send(JSON.stringify(error))
  }

  private connectedIds(): Set<string> {
    const ids = new Set<string>()
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null
      if (attachment) ids.add(attachment.player.id)
    }
    return ids
  }

  private seatOf(record: RoomRecord, playerId: string): SeatId | null {
    for (const seat of record.seatIds) if (record.seats[seat]?.player.id === playerId) return seat
    return null
  }

  /** Seat players are stripped down to public fields; only `gameState` is per-viewer. */
  private snapshot(record: RoomRecord, viewerSeat: SeatId | null): RoomSnapshot {
    const connected = this.connectedIds()
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
      gameState: record.gameState === null ? null : this.adapter(record).view(record.gameState, viewerSeat),
    }
  }

  private broadcast(record: RoomRecord): void {
    // One snapshot per distinct viewpoint: redaction is pure, so every seat
    // needs it built once and all the spectators share a single `null` view.
    const views = new Map<SeatId | null, RoomSnapshot>()
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null
      if (!attachment) continue
      const seat = this.seatOf(record, attachment.player.id)
      let snapshot = views.get(seat)
      if (!snapshot) views.set(seat, (snapshot = this.snapshot(record, seat)))
      const message: ServerMessage = {
        type: 'room',
        snapshot,
        you: {
          id: attachment.player.id,
          seat,
          isHost: attachment.player.id === record.hostId,
        },
      }
      ws.send(JSON.stringify(message))
    }
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
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
    // No TTL refresh here: `save()` re-arms the alarm on every mutation, and a
    // room whose only traffic is non-mutating messages has nothing worth keeping.
    if (message.type === 'join') return this.handleJoin(ws, record, message)
    const attachment = ws.deserializeAttachment() as Attachment | null
    if (!attachment) return this.fail(ws, 'NOT_JOINED', 'Send a join message first.')
    switch (message.type) {
      case 'sit':
        return this.handleSit(ws, record, attachment.player, message.seat)
      case 'leaveSeat':
        return this.handleLeaveSeat(ws, record, attachment.player)
      case 'start':
        return this.handleStart(ws, record, attachment.player)
      case 'action':
        return this.handleAction(ws, record, attachment.player, message.action)
      case 'rematch':
        return this.handleRematch(ws, record, attachment.player)
      case 'claim':
        return this.handleClaim(ws, record, attachment.player)
      case 'addBot':
        return this.handleAddBot(ws, record, attachment.player, message.seat, message.skill)
      case 'removeBot':
        return this.handleRemoveBot(ws, record, attachment.player, message.seat)
      default:
        return this.fail(ws, 'BAD_MESSAGE', 'Unknown message type.')
    }
  }

  private async handleJoin(
    ws: WebSocket,
    record: RoomRecord,
    message: Extract<ClientMessage, { type: 'join' }>,
  ): Promise<void> {
    if (message.protocol !== PROTOCOL_VERSION)
      return this.fail(ws, 'PROTOCOL_MISMATCH', 'Please refresh to get the latest version.')
    if (!cleanName(message.name)) return this.fail(ws, 'BAD_MESSAGE', 'A display name is required.')
    const player = await resolveIdentity(message, this.env)
    if (!player) return this.fail(ws, 'BAD_TOKEN', 'Could not verify your identity.')
    const seat = this.seatOf(record, player.id)
    const taken = record.seatIds.filter((s) => record.seats[s]).length
    if (!seat && taken >= record.seatIds.length) {
      this.fail(ws, 'ROOM_FULL', 'This room is full.')
      ws.close(CLOSE_CODES.full, 'ROOM_FULL')
      return
    }
    ws.serializeAttachment({ player } satisfies Attachment)
    if (seat) {
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
    this.broadcast(record)
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
    this.pushLobby(record)
    this.broadcast(record)
  }

  private async handleLeaveSeat(ws: WebSocket, record: RoomRecord, player: PlayerInfo): Promise<void> {
    if (record.status !== 'open')
      return this.fail(ws, 'ALREADY_STARTED', 'Seats are locked once the game starts — resign instead.')
    const seat = this.seatOf(record, player.id)
    if (!seat) return this.fail(ws, 'NOT_SEATED', 'You are not seated.')
    delete record.seats[seat]
    await this.save(record)
    this.pushLobby(record)
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
    if (player.id !== record.hostId)
      return this.fail(ws, 'NOT_HOST', 'Only the room creator can add a bot.')
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
    this.pushLobby(record)
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
    this.pushLobby(record)
    this.broadcast(record)
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
    this.setGameState(
      record,
      adapter.create(
        played.map((id) => ({ id, name: record.seats[id]!.player.name })),
        record.options,
        this.gameCtx(),
      ),
    )
    await this.save(record)
    this.pushLobby(record)
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
    if (forfeited) record.status = 'finished'
    // A claim aimed at a seat with nothing outstanding — mid-beat, or already
    // being played by the room — grants the abandonment and no more. Putting the
    // unchanged state back through `setGameState` would restamp the deadline of
    // the beat everyone is currently watching, pushing it out on every click.
    if (forfeited || state !== record.gameState) this.setGameState(record, state)
    else this.stampAuto(record)
    await this.save(record)
    this.broadcast(record)
  }

  /** A socket went away: stamp any seat that just lost its last connection, then tell everyone. */
  private async handleDeparture(): Promise<void> {
    const record = await this.load()
    if (!record) return
    const connected = this.connectedIds()
    let changed = false
    for (const seat of record.seatIds) {
      const stored = record.seats[seat]
      // A bot has no socket to lose, so absence means nothing for it.
      if (stored && !stored.bot && !connected.has(stored.player.id) && !stored.disconnectedAt) {
        stored.disconnectedAt = Date.now()
        changed = true
      }
    }
    if (changed) await this.save(record)
    this.broadcast(record)
  }

  async webSocketClose(): Promise<void> {
    await this.handleDeparture()
  }

  async webSocketError(): Promise<void> {
    await this.handleDeparture()
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
    if (settled === null) record.status = 'finished'
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
    this.cached = null
    await this.ctx.storage.deleteAll()
    await this.ctx.storage.deleteAlarm()
  }
}
