import { Chess } from 'chess.js'
import { describe, expect, it } from 'vitest'
import { chooseMove, NODE_BUDGET, search } from './ai'
import { createGame, position } from './engine'

/** A game at `fen`, in the shape the search takes. */
const at = (fen: string) => createGame({}, fen)

describe('computer opponent', () => {
  it.each(['easy', 'medium', 'hard'] as const)('returns a legal %s move', (difficulty) => {
    const game = createGame()
    const move = chooseMove(game, difficulty)
    expect(move).not.toBeNull()
    expect(() => position(game).move(move!)).not.toThrow()
  })

  it('finds a mate in one', () => {
    const game = at('7k/5Q2/6K1/8/8/8/8/8 w - - 0 1')
    const chess = position(game)
    chess.move(chooseMove(game, 'medium')!)
    expect(chess.isCheckmate()).toBe(true)
  })

  it('takes an undefended queen', () => {
    expect(chooseMove(at('6k1/8/8/4q3/8/8/4R3/6K1 w - - 0 1'), 'medium')!.to).toBe('e5')
  })

  it('does not move in terminal positions', () => {
    expect(chooseMove(at('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1'), 'hard')).toBeNull()
  })
})

describe('the node budget', () => {
  it('spends no more than its level allows', () => {
    // The bound is the contract, not an implementation detail: it is what makes
    // the search affordable to run inside a Durable Object, where the clock the
    // old deadline read is frozen for the whole of a synchronous call.
    for (const difficulty of ['easy', 'medium', 'hard'] as const) {
      const { nodes } = search(createGame(), difficulty, () => 0.5)
      expect(nodes).toBeLessThanOrEqual(NODE_BUDGET[difficulty])
    }
  })

  it('gives a harder level more to spend than an easier one', () => {
    expect(NODE_BUDGET.easy).toBeLessThan(NODE_BUDGET.medium)
    expect(NODE_BUDGET.medium).toBeLessThan(NODE_BUDGET.hard)
  })

  it('plays the same move every time from the same position and seed', () => {
    // Determinism is what the node bound buys that a wall clock could not: two
    // runs of the same search no longer depend on how busy the machine was.
    const game = at('r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 4 4')
    const first = search(game, 'medium', () => 0.5)
    const second = search(game, 'medium', () => 0.5)
    expect(second.move).toEqual(first.move)
    expect(second.nodes).toBe(first.nodes)
  })

  it('takes its randomness from the caller, so easy is reproducible too', () => {
    const game = at('r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5Q2/PPPP1PPP/RNB1K1NR w KQkq - 4 4')
    expect(chooseMove(game, 'easy', () => 0.1)).toEqual(chooseMove(game, 'easy', () => 0.1))
  })

  it('sees the repetition its history recorded, which a bare position cannot', () => {
    // Shuffling the knights back and forth reaches the same position three
    // times. The search is handed the line, not a FEN, so it knows.
    const chess = new Chess()
    const line = ['g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8'].map((uci) => {
      const played = chess.move({ from: uci.slice(0, 2), to: uci.slice(2) })
      return { from: played.from, to: played.to, san: played.san, color: played.color }
    })
    expect(chess.isThreefoldRepetition()).toBe(true)
    const replayed = position({
      initialFen: new Chess().fen(),
      history: line as never,
    })
    expect(replayed.isThreefoldRepetition()).toBe(true)
  })
})
