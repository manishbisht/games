import type { Color, GameState, PromotionPiece, Square } from '@games/shared/chess/types'
import type { ReactionId } from '@games/shared/protocol'
import type { ReactionEntry } from '../../../online/roomState'
import type { RoomBeat, SeatPlayer } from '../../../online/session'
import type { HeldTiming } from '../components/clock'

export interface OnlineChessSession {
  state: GameState
  /** The room's code, for the link to its replay once the game is over. */
  code?: string
  /** When the snapshot's state began and was sent, by the server's clock; what the clocks count from. */
  timing?: HeldTiming
  /**
   * The room's recent states, oldest first, ending with `state` (`roomBeats`).
   * A burst of snapshots renders once; the board reads the ones it has not
   * presented so a rematch and the move straight after it are both told, not
   * just where they ended up.
   */
  recent?: RoomBeat<GameState>[]
  myColor: Color | null
  players: Partial<Record<Color, SeatPlayer>>
  rematch: { mine: boolean; theirs: boolean }
  /** Recent reactions, oldest first; each floats up from the card of the seat that sent it. */
  reactions?: ReactionEntry[]
  send: {
    move: (from: Square, to: Square, promotion?: PromotionPiece) => void
    resign: () => void
    rematch: () => void
    claimWin: () => void
    react?: (reaction: ReactionId) => void
  }
  leave: () => void
}
