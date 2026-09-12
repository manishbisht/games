import { chooseMove } from './ai'
import type { AIMove } from './ai'
import type { Difficulty } from '@games/shared/chess/types'

self.onmessage = (
  event: MessageEvent<{ fen: string; difficulty: Difficulty; initialFen: string; moves: AIMove[] }>,
) => {
  const { fen, difficulty, initialFen, moves } = event.data
  try {
    self.postMessage({ fen, move: chooseMove(fen, difficulty, { initialFen, moves }) })
  } catch {
    self.postMessage({ fen, error: true })
  }
}
