import type { GameId, SeatId } from './types'

/**
 * A finished game, as anyone could have watched it: every state the room
 * entered, each as the view nobody is sitting behind (so a hand that was never
 * shown is never shown here either), stamped with the server's clock.
 *
 * Kept by the room itself, so it lives exactly as long as the room does —
 * 24 hours after the last move — and only for the room's latest finished game.
 */
export interface Replay<S = unknown> {
  game: GameId
  /** The table as it was dealt, in seat order. */
  players: ReplayPlayer[]
  /** Oldest first. A very long game keeps its latest `REPLAY_LIMITS.states`. */
  states: ReplayFrame<S>[]
  /** Always true today: a game still being played is not on offer. */
  finished: boolean
  /** Seats the room ended the game against (a granted claim), when the game itself named no winner. */
  forfeited?: SeatId[]
  /** The game ran past the cap, and its opening states were let go. */
  truncated?: boolean
  /** Server clock: when the room — and this replay with it — will be forgotten. */
  expiresAt: number
}

export interface ReplayFrame<S = unknown> {
  /** Server clock when the room entered this state. */
  at: number
  state: S
}

export interface ReplayPlayer {
  seat: SeatId
  name: string
  /** Nobody was behind this seat: the room played it. */
  bot?: { skill: string }
}

/** How much one room keeps: its current game and the one before, each capped. */
export const REPLAY_LIMITS = { games: 2, states: 3000 } as const
