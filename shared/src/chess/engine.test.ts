import { describe, expect, it } from 'vitest'
import { createGame, legalMoves, playMove, promote, undoMove, tickClock, resign, restoreGame } from './engine'

describe('chess session rules', () => {
  it('starts with 32 pieces and 20 legal moves, rejects illegal and out-of-turn moves', () => {
    const game = createGame()
    expect(game.pieces).toHaveLength(32)
    expect(legalMoves(game)).toHaveLength(20)
    expect(playMove(game, 'e2', 'e5')).toBe(game)
    expect(playMove(game, 'e7', 'e5')).toBe(game)
    const next = playMove(game, 'e2', 'e4')
    expect(next.turn).toBe('b')
    expect(next.history[0].san).toBe('e4')
    expect(game.history).toHaveLength(0)
  })

  it('rejects a move exposing the king and shows the checking attacker', () => {
    const pinned = createGame({}, '4r1k1/8/8/8/8/8/4R3/4K3 w - - 0 1')
    expect(legalMoves(pinned, 'e2').some((m) => m.to === 'd2')).toBe(false)
    const checked = createGame({}, '4r1k1/8/8/8/8/8/8/4K3 w - - 0 1')
    expect(checked.check).toBe('e1')
    expect(checked.threats).toContain('e8')
  })

  it('moves both pieces when castling and restores rights on undo', () => {
    const game = createGame({}, 'r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1')
    expect(legalMoves(game, 'e1').map((m) => m.to)).toEqual(expect.arrayContaining(['c1', 'g1']))
    const next = playMove(game, 'e1', 'g1')
    expect(next.pieces.find((p) => p.square === 'f1')?.type).toBe('r')
    expect(next.pieces.find((p) => p.square === 'g1')?.type).toBe('k')
    expect(next.castling.w.k).toBe(false)
    expect(undoMove(next).fen).toBe(game.fen)
    expect(undoMove(next).castling.w.k).toBe(true)
  })

  it('forbids castling through check, out of check, or after a rook moved', () => {
    for (const fen of ['4kr2/8/8/8/8/8/8/4K2R w K - 0 1', '4r1k1/8/8/8/8/8/8/4K2R w K - 0 1']) {
      expect(legalMoves(createGame({}, fen), 'e1').some((m) => m.to === 'g1')).toBe(false)
    }
    let game = createGame({}, '4k3/8/8/8/8/8/8/4K2R w K - 0 1')
    for (const [a, b] of [
      ['h1', 'h2'],
      ['e8', 'd8'],
      ['h2', 'h1'],
      ['d8', 'e8'],
    ])
      game = playMove(game, a, b)
    expect(legalMoves(game, 'e1').some((m) => m.to === 'g1')).toBe(false)
  })

  it('captures en passant, removes the correct pawn and restores it on undo', () => {
    const start = createGame({}, '4k3/3p4/8/4P3/8/8/8/4K3 b - - 0 1')
    const available = playMove(start, 'd7', 'd5')
    expect(available.enPassant).toBe('d6')
    const taken = playMove(available, 'e5', 'd6')
    expect(taken.pieces.some((p) => p.square === 'd5')).toBe(false)
    expect(taken.captured.w).toEqual(['p'])
    expect(undoMove(taken).fen).toBe(available.fen)
    const declined = playMove(playMove(available, 'e1', 'f1'), 'e8', 'f8')
    expect(legalMoves(declined, 'e5').some((m) => m.to === 'd6')).toBe(false)
    const pinned = createGame({}, 'k3r3/8/8/3pP3/8/8/8/4K3 w - d6 0 1')
    expect(legalMoves(pinned, 'e5').some((m) => m.to === 'd6')).toBe(false)
  })

  it.each(['q', 'r', 'b', 'n'] as const)('waits for promotion and promotes to %s', (piece) => {
    const game = createGame({}, '7k/P7/8/8/8/8/8/7K w - - 0 1')
    const pending = playMove(game, 'a7', 'a8')
    expect(pending.promotion).toEqual({ from: 'a7', to: 'a8', color: 'w' })
    expect(pending.turn).toBe('w')
    expect(pending.history).toHaveLength(0)
    const next = promote(pending, piece)
    expect(next.pieces.find((p) => p.square === 'a8')?.type).toBe(piece)
    expect(next.history).toHaveLength(1)
  })

  it('finishes Fool’s mate, blocks more moves, and undo reopens the game', () => {
    let game = createGame()
    for (const [a, b] of [
      ['f2', 'f3'],
      ['e7', 'e5'],
      ['g2', 'g4'],
      ['d8', 'h4'],
    ])
      game = playMove(game, a, b)
    expect(game.status).toBe('checkmate')
    expect(game.winner).toBe('b')
    expect(game.check).toBe('e1')
    expect(legalMoves(game)).toHaveLength(0)
    expect(playMove(game, 'e1', 'f2')).toBe(game)
    expect(undoMove(game).status).toBe('playing')
  })

  it('detects stalemate, insufficient material and the fifty-move draw', () => {
    expect(createGame({}, '7k/5Q2/6K1/8/8/8/8/8 b - - 0 1').status).toBe('stalemate')
    expect(createGame({}, '7k/8/6K1/8/8/8/8/8 w - - 0 1').status).toBe('insufficient')
    expect(createGame({}, '7k/8/6K1/8/8/8/8/R7 w - - 100 51').status).toBe('fifty-move')
  })

  it('keeps repetition history across state updates, reload and undo', () => {
    let game = createGame()
    const cycle = [
      ['g1', 'f3'],
      ['g8', 'f6'],
      ['f3', 'g1'],
      ['f6', 'g8'],
    ]
    for (const [a, b] of [...cycle, ...cycle]) game = playMove(game, a, b)
    expect(game.status).toBe('repetition')
    expect(restoreGame(JSON.stringify(game))?.status).toBe('repetition')
    const previous = undoMove(game)
    expect(previous.status).toBe('playing')
    expect(playMove(previous, 'f6', 'g8').status).toBe('repetition')
  })

  it('uses elapsed time, switches only on completed moves, and restores both clocks', () => {
    const game = createGame({ clock: 10 }, undefined, 1000)
    const elapsed = tickClock(game, 6000)
    expect(elapsed.clocks.w).toBe(595000)
    expect(elapsed.clocks.b).toBe(600000)
    const next = playMove(elapsed, 'e2', 'e4', undefined, 7000)
    expect(next.clocks.w).toBe(594000)
    expect(tickClock(next, 10000).clocks.b).toBe(597000)
    const undone = undoMove(next, 12000)
    expect(undone.clocks).toEqual({ w: 594000, b: 600000 })
    expect(undone.turn).toBe('w')
    expect(tickClock(game, 601001).status).toBe('timeout')
    expect(tickClock(game, 601001).winner).toBe('b')
    expect(playMove(game, 'e2', 'e4', undefined, 601001).history).toHaveLength(0)
  })

  it('requires a completed promotion before changing clocks and respects timeout', () => {
    const start = createGame({ clock: 10 }, '7k/P7/8/8/8/8/8/7K w - - 0 1', 1000)
    const pending = playMove(start, 'a7', 'a8', undefined, 2000)
    expect(tickClock(pending, 5000).clocks.w).toBe(596000)
    expect(promote(pending, 'q', 601001).status).toBe('timeout')
  })

  it('finishes resignation and validates stored data', () => {
    expect(resign(createGame()).winner).toBe('b')
    expect(restoreGame('{invalid')).toBeNull()
    expect(restoreGame(JSON.stringify({ fen: 'garbage' }))).toBeNull()
    const game = playMove(createGame(), 'e2', 'e4')
    expect(restoreGame(JSON.stringify(game))?.fen).toBe(game.fen)
  })

  it('allows a human to resign on the AI turn without overwriting a prior clock result', () => {
    const game = createGame({ mode: 'ai', human: 'b', clock: 10 }, undefined, 1000)
    expect(resign(game, 2000, 'b').winner).toBe('w')
    const timed = resign(game, 601001, 'b')
    expect(timed.status).toBe('timeout')
    expect(timed.winner).toBe('b')
  })
})
