import type { GameState } from '../chess/types'

export const PROTOCOL_VERSION = 1

export type GameId = 'chess'
export type RoomVisibility = 'private' | 'public'
export type RoomStatus = 'open' | 'playing' | 'finished'
export type ChessSeat = 'w' | 'b'

export interface PlayerInfo {
  id: string
  name: string
  avatar?: string
  isGuest: boolean
}

export interface SeatInfo {
  player: PlayerInfo
  connected: boolean
  wantsRematch: boolean
}

export interface RoomSnapshot {
  protocol: typeof PROTOCOL_VERSION
  code: string
  game: GameId
  visibility: RoomVisibility
  status: RoomStatus
  hostId: string
  seats: Partial<Record<ChessSeat, SeatInfo>>
  gameState: GameState | null
}

export interface YouInfo {
  id: string
  seat: ChessSeat | null
}

export type ChessAction =
  | { kind: 'move'; from: string; to: string; promotion?: 'q' | 'r' | 'b' | 'n' }
  | { kind: 'resign' }

export interface JoinCredentials {
  name: string
  guestId?: string
  clerkToken?: string
  avatar?: string
}

export type ClientMessage =
  | ({ type: 'join'; protocol: number } & JoinCredentials)
  | { type: 'sit'; seat: ChessSeat }
  | { type: 'start' }
  | { type: 'action'; action: ChessAction }
  | { type: 'rematch' }

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
  | 'ALREADY_STARTED'
  | 'NOT_PLAYING'
  | 'NOT_YOUR_TURN'
  | 'ILLEGAL_MOVE'
  | 'PROMOTION_REQUIRED'
  | 'NOT_FINISHED'

export type ServerMessage =
  | { type: 'room'; snapshot: RoomSnapshot; you: YouInfo }
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
