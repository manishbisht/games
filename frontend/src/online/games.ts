import { lazy } from 'react'
import type { ComponentType, LazyExoticComponent } from 'react'
import type { GameId, RoomSnapshot, SeatId, YouInfo } from '@games/shared/protocol'
import type { RoomApi } from './useRoom'

/**
 * What a game gets once the room is live: the authoritative snapshot, who this
 * browser is, the wire, and the way out. Turning those into a playable table is
 * the game's job.
 */
export interface RoomViewProps {
  snapshot: RoomSnapshot
  you: YouInfo
  api: RoomApi
  leave: () => void
}

export interface OnlineGame {
  /** Where the game lives, e.g. `/chess`. Rooms are `${basePath}/room/:code`. */
  basePath: string
  name: string
  /** What the button that takes this seat should say. */
  seatLabel(seat: SeatId, index: number): string
  /** Lazy so a room page never drags a game's 3D scene in before it is needed. */
  RoomView: LazyExoticComponent<ComponentType<RoomViewProps>>
}

const GAMES: Partial<Record<GameId, OnlineGame>> = {
  chess: {
    basePath: '/chess',
    name: 'Gambit',
    seatLabel: (seat) => (seat === 'w' ? 'Play as White' : 'Play as Black'),
    RoomView: lazy(() => import('../games/chess/online/ChessRoomView')),
  },
}

/** The room config for a catalog id, or undefined when that game has no online mode. */
export function onlineGame(id: string): OnlineGame | undefined {
  return (GAMES as Record<string, OnlineGame | undefined>)[id]
}
