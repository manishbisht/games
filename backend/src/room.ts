import { DurableObject } from 'cloudflare:workers'
import { createGame, playMove, resign } from '@games/shared/chess'
import type { GameState } from '@games/shared/chess/types'
import { CLOSE_CODES, PROTOCOL_VERSION } from '@games/shared/protocol'
import type {
  ChessAction,
  ChessSeat,
  ClientMessage,
  ErrorCode,
  GameId,
  PlayerInfo,
  RoomSnapshot,
  RoomStatus,
  RoomVisibility,
  SeatInfo,
  ServerMessage,
} from '@games/shared/protocol'
import { cleanName, resolveIdentity } from './auth'
import type { Env } from './env'

const ROOM_TTL_MS = 24 * 60 * 60 * 1000
const SEATS: readonly ChessSeat[] = ['w', 'b']

interface StoredSeat {
  player: PlayerInfo
  wantsRematch: boolean
}

export interface RoomRecord {
  code: string
  game: GameId
  visibility: RoomVisibility
  status: RoomStatus
  hostId: string
  hostName: string
  createdAt: number
  seats: Partial<Record<ChessSeat, StoredSeat>>
  gameState: GameState | null
}

interface Attachment {
  player: PlayerInfo
}

export class RoomDO extends DurableObject<Env> {
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
    if (this.cached === undefined)
      this.cached = (await this.ctx.storage.get<RoomRecord>('room')) ?? null
    return this.cached
  }

  private async save(record: RoomRecord): Promise<void> {
    this.cached = record
    await this.ctx.storage.put('room', record)
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS)
  }

  async create(input: {
    code: string
    game: GameId
    visibility: RoomVisibility
    host: PlayerInfo
  }): Promise<boolean> {
    if (await this.load()) return false
    await this.save({
      code: input.code,
      game: input.game,
      visibility: input.visibility,
      status: 'open',
      hostId: input.host.id,
      hostName: input.host.name,
      createdAt: Date.now(),
      seats: {},
      gameState: null,
    })
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

  private seatOf(record: RoomRecord, playerId: string): ChessSeat | null {
    for (const seat of SEATS) if (record.seats[seat]?.player.id === playerId) return seat
    return null
  }

  private snapshot(record: RoomRecord): RoomSnapshot {
    const connected = this.connectedIds()
    const seats: Partial<Record<ChessSeat, SeatInfo>> = {}
    for (const seat of SEATS) {
      const stored = record.seats[seat]
      if (stored) seats[seat] = { ...stored, connected: connected.has(stored.player.id) }
    }
    return {
      protocol: PROTOCOL_VERSION,
      code: record.code,
      game: record.game,
      visibility: record.visibility,
      status: record.status,
      hostId: record.hostId,
      seats,
      gameState: record.gameState,
    }
  }

  private roomMessage(record: RoomRecord, playerId: string): ServerMessage {
    return {
      type: 'room',
      snapshot: this.snapshot(record),
      you: { id: playerId, seat: this.seatOf(record, playerId) },
    }
  }

  private broadcast(record: RoomRecord): void {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null
      if (attachment) ws.send(JSON.stringify(this.roomMessage(record, attachment.player.id)))
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
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS)
    if (message.type === 'join') return this.handleJoin(ws, record, message)
    const attachment = ws.deserializeAttachment() as Attachment | null
    if (!attachment) return this.fail(ws, 'NOT_JOINED', 'Send a join message first.')
    switch (message.type) {
      case 'sit':
        return this.handleSit(ws, record, attachment.player, message.seat)
      case 'start':
        return this.handleStart(ws, record, attachment.player)
      case 'action':
        return this.handleAction(ws, record, attachment.player, message.action)
      case 'rematch':
        return this.handleRematch(ws, record, attachment.player)
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
    const taken = SEATS.filter((s) => record.seats[s]).length
    if (!seat && taken >= SEATS.length) {
      this.fail(ws, 'ROOM_FULL', 'This room already has two players.')
      ws.close(CLOSE_CODES.full, 'ROOM_FULL')
      return
    }
    ws.serializeAttachment({ player } satisfies Attachment)
    if (seat) {
      record.seats[seat] = { ...record.seats[seat]!, player }
      await this.save(record)
    }
    this.broadcast(record)
  }

  private async handleSit(
    ws: WebSocket,
    record: RoomRecord,
    player: PlayerInfo,
    seat: ChessSeat,
  ): Promise<void> {
    if (!SEATS.includes(seat)) return this.fail(ws, 'BAD_MESSAGE', 'Unknown seat.')
    if (record.status !== 'open')
      return this.fail(ws, 'ALREADY_STARTED', 'The game has already started.')
    const occupant = record.seats[seat]
    if (occupant && occupant.player.id !== player.id)
      return this.fail(ws, 'SEAT_TAKEN', 'That seat is taken.')
    const previous = this.seatOf(record, player.id)
    if (previous && previous !== seat) delete record.seats[previous]
    record.seats[seat] = { player, wantsRematch: false }
    await this.save(record)
    this.broadcast(record)
  }

  private async handleStart(ws: WebSocket, record: RoomRecord, player: PlayerInfo): Promise<void> {
    if (record.status !== 'open')
      return this.fail(ws, 'ALREADY_STARTED', 'The game has already started.')
    if (player.id !== record.hostId)
      return this.fail(ws, 'NOT_HOST', 'Only the room creator can start the game.')
    if (!record.seats.w || !record.seats.b)
      return this.fail(ws, 'NOT_READY', 'Both seats must be taken first.')
    record.status = 'playing'
    record.gameState = createGame({ mode: 'online', human: 'w', difficulty: 'medium', clock: 0 })
    await this.save(record)
    this.broadcast(record)
  }

  private async handleAction(
    ws: WebSocket,
    record: RoomRecord,
    player: PlayerInfo,
    action: ChessAction,
  ): Promise<void> {
    const seat = this.seatOf(record, player.id)
    if (!seat) return this.fail(ws, 'NOT_SEATED', 'Take a seat to play.')
    if (record.status !== 'playing' || !record.gameState)
      return this.fail(ws, 'NOT_PLAYING', 'The game is not in progress.')
    if (!action || typeof action !== 'object')
      return this.fail(ws, 'BAD_MESSAGE', 'Malformed action.')

    if (action.kind === 'resign') {
      record.gameState = resign(record.gameState, Date.now(), seat)
      record.status = 'finished'
      await this.save(record)
      this.broadcast(record)
      return
    }

    if (action.kind === 'move') {
      if (record.gameState.turn !== seat) return this.fail(ws, 'NOT_YOUR_TURN', 'It is not your turn.')
      const { from, to, promotion } = action
      if (
        typeof from !== 'string' ||
        typeof to !== 'string' ||
        (promotion !== undefined && !['q', 'r', 'b', 'n'].includes(promotion))
      )
        return this.fail(ws, 'BAD_MESSAGE', 'Malformed move.')
      const next = playMove(record.gameState, from, to, promotion)
      if (next.history.length === record.gameState.history.length) {
        if (next.promotion) return this.fail(ws, 'PROMOTION_REQUIRED', 'Choose a piece to promote to.')
        return this.fail(ws, 'ILLEGAL_MOVE', 'That move is not legal.')
      }
      record.gameState = next
      if (next.status !== 'playing') record.status = 'finished'
      await this.save(record)
      this.broadcast(record)
      return
    }

    return this.fail(ws, 'BAD_MESSAGE', 'Unknown action.')
  }

  private async handleRematch(ws: WebSocket, record: RoomRecord, player: PlayerInfo): Promise<void> {
    const seat = this.seatOf(record, player.id)
    if (!seat) return this.fail(ws, 'NOT_SEATED', 'Take a seat to play.')
    if (record.status !== 'finished')
      return this.fail(ws, 'NOT_FINISHED', 'The game is still going.')
    record.seats[seat] = { ...record.seats[seat]!, wantsRematch: true }
    if (record.seats.w?.wantsRematch && record.seats.b?.wantsRematch) {
      const { w, b } = record.seats
      record.seats = {
        w: { player: b.player, wantsRematch: false },
        b: { player: w.player, wantsRematch: false },
      }
      record.gameState = createGame({ mode: 'online', human: 'w', difficulty: 'medium', clock: 0 })
      record.status = 'playing'
    }
    await this.save(record)
    this.broadcast(record)
  }

  async webSocketClose(): Promise<void> {
    const record = await this.load()
    if (record) this.broadcast(record)
  }

  async webSocketError(): Promise<void> {
    const record = await this.load()
    if (record) this.broadcast(record)
  }
}
