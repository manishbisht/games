import type { Color, GameState, PromotionPiece, Square } from '@games/shared/chess/types'
import type { HeldTiming } from '../components/clock'

export interface OnlineChessSession {
  state: GameState
  /** When the snapshot's state began and was sent, by the server's clock; what the clocks count from. */
  timing?: HeldTiming
  /**
   * The room's recent states in arrival order, newest last (`state` itself),
   * numbered by `seq`. A burst of snapshots renders once; the board reads the
   * ones it has not presented so a rematch and the move straight after it are
   * both told, not just where they ended up.
   */
  recent?: { seq: number; state: GameState }[]
  myColor: Color | null
  players: Partial<
    Record<
      Color,
      {
        name: string
        connected: boolean
        awaySince?: number
        /** The skill of the bot the room plays this seat with; absent for a person. */
        bot?: string
      }
    >
  >
  rematch: { mine: boolean; theirs: boolean }
  send: {
    move: (from: Square, to: Square, promotion?: PromotionPiece) => void
    resign: () => void
    rematch: () => void
    claimWin: () => void
  }
  leave: () => void
}
