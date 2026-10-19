import type { ReactionId } from './reactions'

export * from './reactions'
export * from './profiles'
export * from './replay'

export const PROTOCOL_VERSION = 3

export type GameId = 'chess' | 'hearth' | 'estate' | 'prism' | 'wildrise'
/**
 * Every game the protocol has a name for. A game only becomes playable online
 * once its adapter is registered (see `../online/registry`) — this list is the
 * vocabulary, the registry is the guest list.
 */
export const GAME_IDS: readonly GameId[] = ['chess', 'hearth', 'estate', 'prism', 'wildrise']
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
  /**
   * A claim against this seat has been granted: the room plays it now, and it
   * no longer counts towards a rematch. Cleared when its player comes back.
   * There is nothing private in it — it is why the table is moving without them.
   */
  abandoned?: boolean
  /**
   * Nobody is behind this seat: the room plays it. Carries its skill because
   * the table should be able to say how hard a bot is trying.
   */
  bot?: { skill: string }
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
  /**
   * How many people are in the room without a seat, watching. A spectator's
   * own snapshot counts them too; `you.seat === null` is how they know it is
   * them. Optional only so a snapshot from an older server still parses.
   */
  spectators?: number
  /** Redacted for the socket it is addressed to — one viewer's view of the game. */
  gameState: S | null
  /**
   * When the game state was entered, by the server's clock, with the server's
   * clock at the moment this snapshot was built — so a browser that joins or
   * reconnects mid-beat knows how far into the beat it already is, without
   * trusting its own clock to agree with the server's. `due` is when the room
   * will move the game on by itself, while it is in a timed phase.
   */
  timing?: BeatTiming
}

export interface BeatTiming {
  /** Server clock when the snapshot was built. */
  now: number
  /** Server clock when the current game state was entered. */
  since: number
  /** Server clock when the room will advance the game itself, if it will. */
  due?: number
}

/** How many milliseconds of the current beat had already passed when the snapshot was built. */
export function beatElapsed(timing: BeatTiming | undefined) {
  return timing ? Math.max(0, timing.now - timing.since) : 0
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

/**
 * What a client says it understands, on its join. Additive server messages are
 * only sent to sockets that asked for them, so a tab still running an older
 * build never receives a frame it would misread — no protocol bump needed.
 */
export type ClientFeature = 'reactions'

export type ClientMessage =
  | ({ type: 'join'; protocol: number; features?: ClientFeature[] } & JoinCredentials)
  | { type: 'sit'; seat: SeatId }
  | { type: 'leaveSeat' }
  | { type: 'start' }
  | { type: 'action'; action: unknown }
  | { type: 'rematch' }
  | { type: 'claim' }
  | { type: 'addBot'; seat: SeatId; skill?: string }
  | { type: 'removeBot'; seat: SeatId }
  /** A quick reaction to the table (see `REACTIONS`); rate-limited per socket. */
  | { type: 'react'; reaction: ReactionId }

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
  /** Too many frames too fast; the room drops them, and closes a socket that keeps it up. */
  | 'RATE_LIMITED'

export type ServerMessage<S = unknown> =
  | { type: 'room'; snapshot: RoomSnapshot<S>; you: YouInfo }
  | { type: 'error'; code: ErrorCode; message: string }
  /**
   * Somebody reacted. Ephemeral: never stored, never part of a snapshot, so a
   * browser that was not connected at the moment simply never sees it. `seat`
   * is null for a spectator. `id` is unique within the room's life, `at` is the
   * server clock. Only sent to sockets that joined with the `reactions` feature.
   */
  | { type: 'reaction'; seat: SeatId | null; reaction: ReactionId; id: string; at: number }

/** WebSocket close codes the server uses for terminal conditions. */
export const CLOSE_CODES = { notFound: 4404, full: 4403, expired: 4408 } as const

export interface PublicRoomSummary {
  code: string
  game: GameId
  hostName: string
  seatsTaken: number
  seatsTotal: number
  createdAt: number
  /** How many of `seatsTaken` are bots, so the lobby can say "2 players · 1 bot". */
  bots: number
}
