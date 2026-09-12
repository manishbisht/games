import { lazy } from 'react'
import type { ComponentType, LazyExoticComponent } from 'react'
import type { GameId, RoomSnapshot, SeatId, YouInfo } from '@games/shared/protocol'
import { games } from '../games/catalog'
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

/** The part of a game's room config that isn't already in the catalog. */
interface OnlineGameConfig {
  /**
   * Fewest players this game will start with. Mirrors the adapter's `minSeats`,
   * which lives on the server — the room page needs it to know whether a table
   * that nobody else turned up to can be started anyway.
   */
  minSeats: number
  /** What the button that takes this seat should say. */
  seatLabel(seat: SeatId, index: number): string
  /** Lazy so a room page never drags a game's 3D scene in before it is needed. */
  RoomView: LazyExoticComponent<ComponentType<RoomViewProps>>
}

export interface OnlineGame extends OnlineGameConfig {
  /** Where the game lives, e.g. `/chess`. Rooms are `${basePath}/room/:code`. */
  basePath: string
  name: string
}

const CONFIGS: Partial<Record<GameId, OnlineGameConfig>> = {
  chess: {
    minSeats: 2,
    seatLabel: (seat) => (seat === 'w' ? 'Play as White' : 'Play as Black'),
    RoomView: lazy(() => import('../games/chess/online/ChessRoomView')),
  },
  hearth: {
    minSeats: 2,
    // Colours are handed out at the start, once the room knows who turned up, so
    // a seat taken beforehand cannot promise one.
    seatLabel: (_seat, index) => `Take seat ${index + 1}`,
    RoomView: lazy(() => import('../games/hearth/online/HearthRoomView')),
  },
}

/** The room config for a catalog id, or undefined when that game has no online mode. */
export function onlineGame(id: string): OnlineGame | undefined {
  const config = Object.prototype.hasOwnProperty.call(CONFIGS, id) ? CONFIGS[id as GameId] : undefined
  // Where the game lives and what it is called are the catalog's to say; App.tsx
  // builds the room route off the same entry, so they cannot drift apart.
  const entry = config && games.find((game) => game.id === id && game.online)
  return entry && config ? { ...config, basePath: entry.path, name: entry.name } : undefined
}
