import { CLOSE_CODES } from '@games/shared/protocol'
import type {
  ErrorCode,
  ReactionId,
  RoomSnapshot,
  SeatId,
  ServerMessage,
  YouInfo,
} from '@games/shared/protocol'

export type RoomPhase = 'connecting' | 'connected' | 'reconnecting' | 'notfound' | 'full' | 'expired'

/** One snapshot as it arrived: `seq` counts up for the life of the room page, `receivedAt` is `performance.now()`. */
export interface SnapshotEntry {
  seq: number
  snapshot: RoomSnapshot
  receivedAt: number
}

/**
 * How many recent snapshots the client keeps. React commits a burst of socket
 * messages as one render, so a game reading only `snapshot` would never see
 * the states in between; `recent` keeps them, in order, for a board that wants
 * to present each one.
 */
export const RECENT_SNAPSHOTS = 24

/**
 * A reaction as it arrived. Reactions are ephemeral — never in a snapshot — so
 * this short list is all a page ever has of them: a table that wants to draw
 * one beside its seat reads the entries whose `id` it has not drawn yet.
 * `seat` is null for a spectator; `at` is the server's clock, `receivedAt` is
 * `performance.now()` at arrival.
 */
export interface ReactionEntry {
  id: string
  seat: SeatId | null
  reaction: ReactionId
  at: number
  receivedAt: number
}

/** How many recent reactions the client keeps. More than fit on screen at once. */
export const RECENT_REACTIONS = 12

export interface RoomClientState {
  phase: RoomPhase
  snapshot: RoomSnapshot | null
  /** When `snapshot` arrived, by `performance.now()` — not when it rendered. */
  receivedAt: number | null
  /** The last few snapshots in arrival order; the newest is `snapshot`. */
  recent: SnapshotEntry[]
  you: YouInfo | null
  /** The last few reactions, oldest first. */
  reactions: ReactionEntry[]
  error: { code: ErrorCode; message: string } | null
}

export type RoomClientEvent =
  | { type: 'open' }
  | { type: 'message'; message: ServerMessage; receivedAt?: number }
  | { type: 'close'; code: number }
  | { type: 'dismiss-error' }

export const initialRoomState: RoomClientState = {
  phase: 'connecting',
  snapshot: null,
  receivedAt: null,
  recent: [],
  you: null,
  reactions: [],
  error: null,
}

export function roomReducer(state: RoomClientState, event: RoomClientEvent): RoomClientState {
  switch (event.type) {
    case 'open':
      return { ...state, phase: 'connected' }
    case 'message':
      if (event.message.type === 'room') {
        const receivedAt = event.receivedAt ?? performance.now(),
          seq = (state.recent.at(-1)?.seq ?? 0) + 1
        return {
          ...state,
          phase: 'connected',
          snapshot: event.message.snapshot,
          receivedAt,
          recent: [...state.recent, { seq, snapshot: event.message.snapshot, receivedAt }].slice(
            -RECENT_SNAPSHOTS,
          ),
          you: event.message.you,
          error: null,
        }
      }
      if (event.message.type === 'reaction') {
        const { id, seat, reaction, at } = event.message
        if (state.reactions.some((entry) => entry.id === id)) return state
        const entry = { id, seat, reaction, at, receivedAt: event.receivedAt ?? performance.now() }
        return { ...state, reactions: [...state.reactions, entry].slice(-RECENT_REACTIONS) }
      }
      // Anything else a newer server might send is not this build's to act on —
      // and above all not an error to show.
      if (event.message.type !== 'error') return state
      if (event.message.code === 'ROOM_NOT_FOUND') return { ...state, phase: 'notfound' }
      if (event.message.code === 'ROOM_FULL') return { ...state, phase: 'full' }
      return { ...state, error: { code: event.message.code, message: event.message.message } }
    case 'close':
      if (event.code === CLOSE_CODES.notFound) return { ...state, phase: 'notfound' }
      if (event.code === CLOSE_CODES.full) return { ...state, phase: 'full' }
      if (event.code === CLOSE_CODES.expired) return { ...state, phase: 'expired' }
      return { ...state, phase: 'reconnecting' }
    case 'dismiss-error':
      return { ...state, error: null }
  }
}

export const isFatal = (phase: RoomPhase): boolean =>
  phase === 'notfound' || phase === 'full' || phase === 'expired'

export interface PresenceEvent {
  seat: SeatId
  name: string
  connected: boolean
}

/**
 * Seat-presence transitions between two snapshots, for disconnect/reconnect
 * toasts. Snapshots carry no player ids (they're bearer credentials), so a
 * same-name check is what guards against a seat changing occupants — e.g. the
 * rematch color swap — being misread as a presence change.
 */
export function presenceEvents(prev: RoomSnapshot | null, next: RoomSnapshot | null): PresenceEvent[] {
  if (!prev || !next) return []
  const events: PresenceEvent[] = []
  for (const seat of next.seatIds) {
    const before = prev.seats[seat]
    const after = next.seats[seat]
    if (!before || !after) continue
    if (before.player.name !== after.player.name) continue
    if (before.connected !== after.connected)
      events.push({ seat, name: after.player.name, connected: after.connected })
  }
  return events
}
