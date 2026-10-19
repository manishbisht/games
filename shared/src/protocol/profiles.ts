import type { GameId } from './types'

/**
 * What the server needs to say about a game outside the game itself — a push
 * notification's wording and the link it opens. Mirrors the frontend catalog's
 * `name` and `path`; frontend/src/online/games.test.ts holds the two together.
 */
export const GAME_ROUTES: Record<GameId, { name: string; path: string }> = {
  chess: { name: 'Gambit', path: '/chess' },
  hearth: { name: 'Hearth & Home', path: '/hearth-and-home' },
  estate: { name: 'Estate', path: '/estate' },
  prism: { name: 'Prism', path: '/prism' },
  wildrise: { name: 'Wildrise', path: '/wildrise' },
}

/** The in-app route of a room, as the hash router spells it. */
export const roomPath = (game: GameId, code: string) => `${GAME_ROUTES[game].path}/room/${code}`

export type GameResult = 'win' | 'loss' | 'draw'

/**
 * Someone else who was at the table. `handle` links to their public profile; it
 * is only on the player's own record (`/api/me`), and only for people — a bot
 * has no profile to link to, and a public profile links to nobody else's.
 */
export interface Opponent {
  name: string
  handle?: string
  bot?: boolean
}

/** One finished game, as anyone may see it on a public profile: no room code. */
export interface PublicGameRecord {
  game: GameId
  result: GameResult
  /** 1-based finishing place, for tables of more than two. Ties share a place. */
  place?: number
  /** How many seats the game was played with. */
  seats: number
  opponents: Opponent[]
  /** Server clock when the game finished; on a public profile, the start of that day (UTC). */
  at: number
  /** Present only for a rated game: the rating before and after it. */
  rating?: { before: number; after: number }
}

/** The owner's own copy carries the room, so their history can link back to it. */
export interface GameRecord extends PublicGameRecord {
  code: string
}

export interface GameStats {
  played: number
  wins: number
  losses: number
  draws: number
}

/**
 * An Elo rating. Provisional while it rests on too few games to mean much — it
 * still moves (faster, in fact), but the page says to take it lightly.
 */
export interface Rating {
  rating: number
  games: number
  provisional: boolean
  peak: number
}

/** A room this player holds a seat in that is not over yet. */
export interface ActiveTable {
  code: string
  game: GameId
  status: 'open' | 'playing'
  seats: number
  opponents: string[]
  /** The game is waiting on this player right now. */
  yourTurn: boolean
  updatedAt: number
}

/** GET /api/players/:handle. Never carries an id, a room code or anything a guest signs in with. */
export interface PublicProfile {
  handle: string
  name: string
  avatar?: string
  isGuest: boolean
  /** When this player finished their first game here; on a public profile, the start of that day (UTC). */
  since: number
  stats: Partial<Record<GameId, GameStats>>
  ratings: { chess?: Rating }
  recent: PublicGameRecord[]
}

/** GET /api/me: the public profile, plus what only its owner may see. */
export interface MyProfile extends Omit<PublicProfile, 'recent'> {
  recent: GameRecord[]
  active: ActiveTable[]
  /** How many browsers this player has asked to be notified in. */
  pushSubscriptions: number
}
