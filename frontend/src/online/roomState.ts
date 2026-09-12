import { CLOSE_CODES } from '@games/shared/protocol'
import type { ErrorCode, RoomSnapshot, ServerMessage, YouInfo } from '@games/shared/protocol'

export type RoomPhase = 'connecting' | 'connected' | 'reconnecting' | 'notfound' | 'full' | 'expired'

export interface RoomClientState {
  phase: RoomPhase
  snapshot: RoomSnapshot | null
  you: YouInfo | null
  error: { code: ErrorCode; message: string } | null
}

export type RoomClientEvent =
  | { type: 'open' }
  | { type: 'message'; message: ServerMessage }
  | { type: 'close'; code: number }
  | { type: 'dismiss-error' }

export const initialRoomState: RoomClientState = {
  phase: 'connecting',
  snapshot: null,
  you: null,
  error: null,
}

export function roomReducer(state: RoomClientState, event: RoomClientEvent): RoomClientState {
  switch (event.type) {
    case 'open':
      return { ...state, phase: 'connected' }
    case 'message':
      if (event.message.type === 'room')
        return {
          ...state,
          phase: 'connected',
          snapshot: event.message.snapshot,
          you: event.message.you,
          error: null,
        }
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
