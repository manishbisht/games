import { Chess } from 'chess.js'
import type { Move, PieceSymbol } from 'chess.js'
import { position } from './engine'
import type { Difficulty, GameState } from './types'

export interface AIMove {
  from: string
  to: string
  promotion?: string
}
const VALUES: Record<PieceSymbol, number> = { p: 100, n: 320, b: 335, r: 500, q: 900, k: 20000 }

function evaluate(chess: Chess): number {
  let score = 0
  const board = chess
    .board()
    .flat()
    .filter((p) => p !== null)
  const endgame = board.filter((p) => ['q', 'r'].includes(p.type)).length < 3
  for (const p of board) {
    const file = p.square.charCodeAt(0) - 97,
      rank = Number(p.square[1]) - 1
    const progress = p.color === 'w' ? rank : 7 - rank
    const center = 7 - Math.abs(file - 3.5) - Math.abs(rank - 3.5)
    let positional = 0
    if (p.type === 'p') positional = progress * 8 + center * 4 + (progress >= 5 ? progress * 10 : 0)
    if (p.type === 'n') positional = center * 13 - (progress === 0 ? 20 : 0)
    if (p.type === 'b') positional = center * 7 + (progress > 0 ? 12 : 0)
    if (p.type === 'r') positional = progress === 6 ? 22 : progress * 2
    if (p.type === 'q') positional = center * 3
    if (p.type === 'k')
      positional = endgame ? center * 10 : -(progress * 12) + (file === 6 || file === 2 ? 24 : 0)
    score += (p.color === 'w' ? 1 : -1) * (VALUES[p.type] + positional)
  }
  return score * (chess.turn() === 'w' ? 1 : -1)
}

const priority = (m: Move) =>
  (m.captured ? 10 * VALUES[m.captured] - VALUES[m.piece] : 0) +
  (m.promotion ? VALUES[m.promotion] : 0) +
  (m.san.includes('+') ? 30 : 0) +
  (m.san.includes('#') ? 100000 : 0)

/**
 * How hard the bot thinks, counted in positions rather than milliseconds.
 *
 * The search used to stop at a wall-clock deadline, which cannot work on the
 * server: Workers freeze the clock for the whole of a synchronous run, so
 * `performance.now()` returns the same number on every check and the deadline
 * never arrives. Counting nodes is the same bound expressed in the one quantity
 * the search actually spends, and it makes a given position and seed always
 * produce the same move. The numbers are the old budgets at the measured
 * throughput of roughly 930 nodes a second.
 */
export const NODE_BUDGET: Record<Difficulty, number> = { easy: 200, medium: 600, hard: 1500 }

/** Search is bounded and independent of UI state; only chess.js legal moves are considered. */
export function chooseMove(
  state: Pick<GameState, 'initialFen' | 'history'>,
  difficulty: Difficulty,
  random: () => number = Math.random,
): AIMove | null {
  return search(state, difficulty, random).move
}

/**
 * The same search, with what it cost. Separate from `chooseMove` so the budget
 * can be asserted as a contract rather than trusted, and so the backend can
 * price a move before deciding which levels are affordable to run there.
 */
export function search(
  state: Pick<GameState, 'initialFen' | 'history'>,
  difficulty: Difficulty,
  random: () => number = Math.random,
): { move: AIMove | null; nodes: number } {
  // Replayed rather than built from a FEN, so the search sees the repetition
  // counts a bare position has lost.
  const chess = position(state)
  if (chess.isGameOver()) return { move: null, nodes: 0 }
  const root = chess.moves({ verbose: true }).sort((a, b) => priority(b) - priority(a))
  if (!root.length) return { move: null, nodes: 0 }
  const budget = NODE_BUDGET[difficulty]
  const maxDepth = difficulty === 'hard' ? 4 : difficulty === 'medium' ? 2 : 1
  let nodes = 0,
    stopped = false,
    best = root[0]
  const terminalScore = (moves: Move[], ply: number) =>
    !moves.length ? (chess.isCheck() ? -100000 + ply : 0) : null

  function descend(depth: number, alpha: number, beta: number, ply: number, quiescence = 2): number {
    // Checked on every node, not every sixty-fourth: an integer compare is
    // free where reading a clock was not, and at a budget of 200 the old
    // sampling overshot by up to a third.
    if (nodes >= budget) {
      stopped = true
      return evaluate(chess)
    }
    nodes++
    if (chess.isThreefoldRepetition() || chess.isDrawByFiftyMoves() || chess.isInsufficientMaterial())
      return 0
    let moves = chess.moves({ verbose: true })
    const terminal = terminalScore(moves, ply)
    if (terminal !== null) return terminal
    if (depth <= 0) {
      const standing = evaluate(chess)
      if (!quiescence) return standing
      if (!chess.isCheck()) {
        if (standing >= beta) return beta
        alpha = Math.max(alpha, standing)
        moves = moves.filter((m) => m.captured || m.promotion)
      }
    }
    moves.sort((a, b) => priority(b) - priority(a))
    for (const move of moves) {
      chess.move(move)
      const score = -descend(depth - 1, -beta, -alpha, ply + 1, depth <= 0 ? quiescence - 1 : quiescence)
      chess.undo()
      if (stopped) return alpha
      if (score >= beta) return beta
      alpha = Math.max(alpha, score)
    }
    return alpha
  }

  for (let depth = 1; depth <= maxDepth; depth++) {
    let iterationBest = best,
      bestScore = -Infinity
    const ordered = [best, ...root.filter((m) => m !== best)]
    for (const move of ordered) {
      chess.move(move)
      let score = -descend(depth - 1, -Infinity, Infinity, 1, difficulty === 'easy' ? 0 : 2)
      chess.undo()
      if (stopped) break
      if (difficulty === 'easy' && Math.abs(score) < 90000) score += random() * 180
      if (score > bestScore) {
        bestScore = score
        iterationBest = move
      }
    }
    if (!stopped) best = iterationBest
    if (stopped || bestScore > 90000) break
  }
  return {
    move: { from: best.from, to: best.to, ...(best.promotion ? { promotion: best.promotion } : {}) },
    nodes,
  }
}
