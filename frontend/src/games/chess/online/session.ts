import type { Color, GameState, PromotionPiece, Square } from '@games/shared/chess/types'

export interface OnlineChessSession {
  state: GameState
  myColor: Color | null
  players: Partial<Record<Color, { name: string; connected: boolean; awaySince?: number }>>
  rematch: { mine: boolean; theirs: boolean }
  send: {
    move: (from: Square, to: Square, promotion?: PromotionPiece) => void
    resign: () => void
    rematch: () => void
    claimWin: () => void
  }
  leave: () => void
}
