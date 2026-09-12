export const PROTOCOL_VERSION = 2

export type GameId = 'chess' | 'hearth' | 'estate' | 'prism'
/**
 * Every game the protocol has a name for. A game only becomes playable online
 * once its adapter is registered (see `../online/registry`) — this list is the
 * vocabulary, the registry is the guest list.
 */
export const GAME_IDS: readonly GameId[] = ['chess', 'hearth', 'estate', 'prism']
export type RoomVisibility = 'private' | 'public'
export type RoomStatus = 'open' | 'playing' | 'finished'
/** `'w' | 'b'` for chess; `'p0'..'p3'` elsewhere. The adapter mints them. */
export type SeatId = string

/**
 * What everyone in the room may see about a player. Deliberately id-free: a
 * guest's id doubles as their bearer credential, and snapshots are broadcast
 * to every socket.
 */
export interface PublicPlayerInfo {
  name: string
  avatar?: string
  isGuest: boolean
}

/** Server-side only — `id` never leaves the Durable Object inside a snapshot. */
export interface PlayerInfo extends PublicPlayerInfo {
  id: string
}

export interface SeatInfo {
  player: PublicPlayerInfo
  connected: boolean
  wantsRematch: boolean
  /** Server timestamp of when this seat-holder's last socket dropped; absent while connected. */
  awaySince?: number
}

/** How long a seat must be abandoned mid-game before the opponent may claim the win. */
export const CLAIM_WIN_AFTER_MS = 2 * 60 * 1000

export interface RoomSnapshot<S = unknown> {
  protocol: typeof PROTOCOL_VERSION
  code: string
  game: GameId
  visibility: RoomVisibility
  status: RoomStatus
  /** Ordered; fixed at creation, compacted onto the played seat count at start. */
  seatIds: SeatId[]
  seats: Partial<Record<SeatId, SeatInfo>>
  /** Redacted for the socket it is addressed to — one viewer's view of the game. */
  gameState: S | null
}

/** Addressed to one socket, so it may carry that socket's own id. */
export interface YouInfo {
  id: string
  seat: SeatId | null
  isHost: boolean
}

export interface JoinCredentials {
  name: string
  guestId?: string
  clerkToken?: string
  avatar?: string
}

export type ClientMessage =
  | ({ type: 'join'; protocol: number } & JoinCredentials)
  | { type: 'sit'; seat: SeatId }
  | { type: 'leaveSeat' }
  | { type: 'start' }
  | { type: 'action'; action: unknown }
  | { type: 'rematch' }
  | { type: 'claim' }

export type ErrorCode =
  | 'BAD_MESSAGE'
  | 'BAD_TOKEN'
  | 'PROTOCOL_MISMATCH'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'NOT_JOINED'
  | 'NOT_SEATED'
  | 'SEAT_TAKEN'
  | 'NOT_HOST'
  | 'NOT_READY'
  | 'NOT_ALLOWED'
  | 'ALREADY_STARTED'
  | 'NOT_PLAYING'
  | 'NOT_YOUR_TURN'
  | 'ILLEGAL_MOVE'
  | 'PROMOTION_REQUIRED'
  | 'NOT_FINISHED'
  | 'CLAIM_REJECTED'

export type ServerMessage<S = unknown> =
  | { type: 'room'; snapshot: RoomSnapshot<S>; you: YouInfo }
  | { type: 'error'; code: ErrorCode; message: string }

/** WebSocket close codes the server uses for terminal conditions. */
export const CLOSE_CODES = { notFound: 4404, full: 4403, expired: 4408 } as const

export interface PublicRoomSummary {
  code: string
  game: GameId
  hostName: string
  seatsTaken: number
  seatsTotal: number
  createdAt: number
}
