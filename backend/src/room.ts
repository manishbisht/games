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

interface StoredSeat {
  player: PlayerInfo
  wantsRematch: boolean
  /** When this seat-holder's last socket dropped; cleared on reconnect. */
  disconnectedAt?: number
  /** Set once the room has played on without this seat; cleared when they come back. */
  abandoned?: boolean
}

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
    if (this.cached === undefined) this.cached = (await this.ctx.storage.get<RoomRecord>('room')) ?? null
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
   * re-arms for the other.
   */
  private async armAlarm(record: RoomRecord): Promise<void> {
    const pending = this.pendingPhase(record)
    const autoAt = pending ? Date.now() + pending.afterMs : Infinity
    await this.ctx.storage.setAlarm(Math.min(autoAt, record.expiresAt))
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
    return { random: Math.random, now: Date.now() }
  }

  private pendingPhase(record: RoomRecord): { afterMs: number; resolve(s: unknown, c: Ctx): unknown } | null {
    if (record.gameState === null) return null
    return this.adapter(record).pending(record.gameState)
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
      const isConnected = connected.has(id)
      seats[seat] = {
        player,
        connected: isConnected,
        wantsRematch: stored.wantsRematch,
        ...(isConnected || !stored.disconnectedAt ? {} : { awaySince: stored.disconnectedAt }),
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
    record.gameState = adapter.create(
      played.map((id) => ({ id, name: record.seats[id]!.player.name })),
      record.options,
      this.gameCtx(),
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
    record.gameState = result.state
    if (adapter.isFinished(result.state)) record.status = 'finished'
    await this.save(record)
    this.broadcast(record)
  }

  private async handleRematch(ws: WebSocket, record: RoomRecord, player: PlayerInfo): Promise<void> {
    const seat = this.seatOf(record, player.id)
    if (!seat) return this.fail(ws, 'NOT_SEATED', 'Take a seat to play.')
    if (record.status !== 'finished') return this.fail(ws, 'NOT_FINISHED', 'The game is still going.')
    record.seats[seat] = { ...record.seats[seat]!, wantsRematch: true }
    const seated = record.seatIds.filter((s) => record.seats[s])
    if (seated.every((s) => record.seats[s]!.wantsRematch)) {
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
      record.gameState = state
      record.status = 'playing'
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
    const others = record.seatIds.filter((id) => id !== seat && record.seats[id])
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
    for (const id of targets) {
      const settled = adapter.resolveAbsent(state, id, record.seatIds, ctx)
      // `null`: this game has no stand-in for an absent seat, so the claim ends
      // the game where it stands.
      if (settled === null) {
        record.status = 'finished'
        break
      }
      state = settled
      if (adapter.isFinished(state)) break
    }
    record.gameState = state
    if (adapter.isFinished(state)) record.status = 'finished'
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
      if (stored && !connected.has(stored.player.id) && !stored.disconnectedAt) {
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
    // Which master woke us: a game still mid-phase before its deadline is an
    // auto-advance, and everything else is the room's time running out.
    const record = await this.load()
    const pending = record && this.pendingPhase(record)
    if (record && pending && Date.now() < record.expiresAt) return this.autoAdvance(record)
    await this.expire(record)
  }

  /**
   * Timed presentation phases (a die that has landed but hasn't been read out, a
   * card still in flight) resolve on the server's clock so every viewer sees the
   * same beat at the same time.
   */
  private async autoAdvance(record: RoomRecord): Promise<void> {
    const adapter = this.adapter(record)
    const ctx = this.gameCtx()
    for (let step = 0; step < MAX_AUTO_ADVANCES; step++) {
      const pending = this.pendingPhase(record)
      // A phase that wants a delay of its own earns a fresh alarm; only the
      // zero-delay chains collapse into this single fire.
      if (!pending || (step > 0 && pending.afterMs > 0)) break
      record.gameState = pending.resolve(record.gameState, ctx)
    }
    if (record.gameState !== null && adapter.isFinished(record.gameState)) record.status = 'finished'
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
