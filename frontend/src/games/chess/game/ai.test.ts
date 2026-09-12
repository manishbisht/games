import { Chess } from 'chess.js'
import { describe, it, expect } from 'vitest'
import { chooseMove } from './ai'

describe('computer opponent', () => {
  it.each(['easy', 'medium', 'hard'] as const)('returns a legal %s move', (difficulty) => {
    const chess = new Chess()
    const move = chooseMove(chess.fen(), difficulty)
    expect(move).not.toBeNull()
    expect(() => chess.move(move!)).not.toThrow()
  })
  it('finds a mate in one', () => {
    const chess = new Chess('7k/5Q2/6K1/8/8/8/8/8 w - - 0 1')
    chess.move(chooseMove(chess.fen(), 'medium')!)
    expect(chess.isCheckmate()).toBe(true)
  })
  it('takes an undefended queen', () => {
    const chess = new Chess('6k1/8/8/4q3/8/8/4R3/6K1 w - - 0 1')
    const move = chooseMove(chess.fen(), 'medium')!
    expect(move.to).toBe('e5')
  })
  it('does not move in terminal positions', () => {
    expect(chooseMove('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1', 'hard')).toBeNull()
  })
})
