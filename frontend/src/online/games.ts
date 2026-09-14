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

/**
 * One thing a bot can be. The id is the server's — it validates against its own
 * adapter and the browser never sees the list — so this is the label for it,
 * and nothing more. Wildrise's three are pace rather than strength, which is
 * why the labels are written per game rather than generated from the id.
 */
export interface BotSkill {
  id: string
  label: string
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
  /**
   * Skills this game's bots accept, easiest first. The ids mirror the adapter's
   * `bots.skills` on the server, which is the only thing that validates them;
   * a games.test.ts case holds the two lists together. Absent when a game has
   * no bots yet.
   */
  botSkills?: BotSkill[]
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
    // Chess gets its bot when its search moves to the server; until then the
    // room would refuse an addBot with NOT_ALLOWED.
    RoomView: lazy(() => import('../games/chess/online/ChessRoomView')),
  },
  estate: {
    minSeats: 2,
    // Tokens and colours are handed out at the start, once the room knows who
    // turned up, so a seat taken beforehand cannot promise one.
    seatLabel: (_seat, index) => `Take seat ${index + 1}`,
    // One strength: Estate's bot has no difficulty to pick, so the picker is
    // left out entirely rather than offering a choice of one.
    botSkills: [{ id: 'standard', label: 'Bot' }],
    RoomView: lazy(() => import('../games/monopoly/online/EstateRoomView')),
  },
  hearth: {
    minSeats: 2,
    // Colours are handed out at the start, once the room knows who turned up, so
    // a seat taken beforehand cannot promise one.
    seatLabel: (_seat, index) => `Take seat ${index + 1}`,
    botSkills: [
      { id: 'easy', label: 'Easy' },
      { id: 'medium', label: 'Medium' },
      { id: 'hard', label: 'Hard' },
    ],
    RoomView: lazy(() => import('../games/hearth/online/HearthRoomView')),
  },
  prism: {
    minSeats: 2,
    // Seats are numbered, not dealt: which hand a seat gets is the shuffle's to
    // decide, once the room knows who turned up.
    seatLabel: (_seat, index) => `Take seat ${index + 1}`,
    botSkills: [
      { id: 'easy', label: 'Easy' },
      { id: 'medium', label: 'Medium' },
      { id: 'hard', label: 'Hard' },
    ],
    RoomView: lazy(() => import('../games/prism/online/PrismRoomView')),
  },
  wildrise: {
    minSeats: 2,
    // Colours are handed out at the start, once the room knows who turned up, so
    // a seat taken beforehand cannot promise one.
    seatLabel: (_seat, index) => `Take seat ${index + 1}`,
    // Pace, not strength — there is nothing to be good at on this board.
    botSkills: [
      { id: 'casual', label: 'Casual · take it easy' },
      { id: 'fast', label: 'Fast · keep it moving' },
      { id: 'fun', label: 'Fun · a little expressive' },
    ],
    RoomView: lazy(() => import('../games/wildrise/online/WildriseRoomView')),
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
