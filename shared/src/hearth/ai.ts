import { absoluteSpace, HOME, SAFE_SPACES, TRACK_LENGTH } from './board'
import type { Control, GameState, LegalMove } from './types'

// Randomness is supplied by the caller, keeping strategy reproducible in tests.
export function chooseAIMove(state: GameState, difficulty: Control, random: number): LegalMove | null {
  if (state.phase !== 'choose' || !state.legalMoves.length) return null
  const moves = state.legalMoves,
    noise = Math.max(0, Math.min(0.999999, random))
  if (difficulty === 'easy') return moves[Math.floor(noise * moves.length)]
  if (difficulty === 'medium' && noise < 0.17) return moves[Math.floor((noise / 0.17) * moves.length)]
  const score = (move: LegalMove) => {
    if (move.to === HOME) return 1000
    const piece = state.pieces.find((p) => p.id === move.pieceId)!
    let value = move.to * 0.24 + move.captures.length * 40
    if (move.from < 0) {
      const active = state.pieces.filter(
        (p) => p.playerId === piece.playerId && p.progress >= 0 && p.progress < HOME,
      ).length
      value += active < 2 ? 12 : 5
    }
    if (move.to >= TRACK_LENGTH) value += 28
    if (difficulty === 'hard') {
      const destination = absoluteSpace({ ...piece, progress: move.to })
      const safe = destination === null || (state.rules.safeSpaces && SAFE_SPACES.has(destination))
      if (safe) value += 9
      else if (state.rules.captures) {
        for (const opponent of state.pieces) {
          if (opponent.playerId === piece.playerId || move.captures.includes(opponent.id)) continue
          const position = absoluteSpace(opponent)
          if (position === null) continue
          const distance = (destination! - position + TRACK_LENGTH) % TRACK_LENGTH
          // An opponent who would enter its own home lane cannot capture here.
          if (distance >= 1 && distance <= 6 && opponent.progress + distance < TRACK_LENGTH)
            value -= 18 + move.to * 0.15
        }
      }
    }
    return value
  }
  return [...moves].sort((a, b) => score(b) - score(a))[0]
}
