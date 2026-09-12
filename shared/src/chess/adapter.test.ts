import { describe, expect, it } from 'vitest'
import type { Ctx } from '../online/adapter'
import { chessAdapter } from './adapter'
import { createGame } from './engine'
import type { GameState } from './types'

const ctx: Ctx = { random: () => 0.5, now: 1_700_000_000_000 }
const SEATS = ['w', 'b']
const players = [
  { id: 'w', name: 'Ann' },
  { id: 'b', name: 'Ben' },
]

const start = () => chessAdapter.create(players, {}, ctx)
/** `apply` succeeds or explains itself; tests that expect a move want the state. */
const move = (state: GameState, seat: string, from: string, to: string, promotion?: string) => {
  const result = chessAdapter.apply(state, seat, SEATS, { kind: 'move', from, to, promotion } as never, ctx)
  if ('error' in result) throw new Error(`unexpected ${result.error}`)
  return result.state
}

describe('chess adapter shape', () => {
  it('seats exactly two players, both required', () => {
    expect(chessAdapter.id).toBe('chess')
    expect([chessAdapter.minSeats, chessAdapter.maxSeats]).toEqual([2, 2])
    expect(chessAdapter.requireFull).toBe(true)
    expect(chessAdapter.seatIds(2)).toEqual(['w', 'b'])
  })

  it('creates an online game nobody has moved in yet', () => {
    const state = start()
    expect(state.turn).toBe('w')
    expect(state.history).toEqual([])
    expect(state.options).toMatchObject({ mode: 'online', human: 'w', difficulty: 'medium', clock: 0 })
    expect(chessAdapter.isFinished(state)).toBe(false)
    // Chess is perfect information and never pauses on a timer.
    expect(chessAdapter.view(state, 'b')).toBe(state)
    expect(chessAdapter.pending(state)).toBeNull()
  })
})

describe('chess adapter validateAction', () => {
  it('accepts moves and resignations', () => {
    expect(chessAdapter.validateAction({ kind: 'resign' })).toEqual({ kind: 'resign' })
    expect(chessAdapter.validateAction({ kind: 'move', from: 'e2', to: 'e4' })).toEqual({
      kind: 'move',
      from: 'e2',
      to: 'e4',
    })
    expect(chessAdapter.validateAction({ kind: 'move', from: 'b7', to: 'b8', promotion: 'q' })).toEqual({
      kind: 'move',
      from: 'b7',
      to: 'b8',
      promotion: 'q',
    })
  })

  it('rejects anything it cannot read as an action', () => {
    for (const raw of [
      null,
      'move',
      {},
      { kind: 'nope' },
      { kind: 'move', from: 'e2' },
      { kind: 'move', from: 2, to: 4 },
      { kind: 'move', from: 'b7', to: 'b8', promotion: 'k' },
    ])
      expect(chessAdapter.validateAction(raw)).toBeNull()
  })
})

describe('chess adapter apply', () => {
  it('plays a legal move and hands the turn over', () => {
    const state = start()
    expect(chessAdapter.waitingOn(state, SEATS)).toEqual(['w'])
    const next = move(state, 'w', 'e2', 'e4')
    expect(next.history.at(-1)?.san).toBe('e4')
    expect(next.turn).toBe('b')
    expect(chessAdapter.waitingOn(next, SEATS)).toEqual(['b'])
  })

  it('refuses a move from the seat that is not on turn', () => {
    const state = start()
    expect(chessAdapter.apply(state, 'b', SEATS, { kind: 'move', from: 'e7', to: 'e5' }, ctx)).toEqual({
      error: 'NOT_YOUR_TURN',
      message: 'It is not your turn.',
    })
  })

  it('refuses an illegal move', () => {
    const state = start()
    const result = chessAdapter.apply(state, 'w', SEATS, { kind: 'move', from: 'e2', to: 'e5' }, ctx)
    expect(result).toMatchObject({ error: 'ILLEGAL_MOVE' })
  })

  it('distinguishes a missing promotion piece from an illegal move', () => {
    const promoting = createGame({ mode: 'online' }, '4k3/1P6/8/8/8/8/8/4K3 w - - 0 1', ctx.now)
    const result = chessAdapter.apply(promoting, 'w', SEATS, { kind: 'move', from: 'b7', to: 'b8' }, ctx)
    expect(result).toEqual({ error: 'PROMOTION_REQUIRED', message: 'Choose a piece to promote to.' })
    expect(move(promoting, 'w', 'b7', 'b8', 'q').history.at(-1)?.san).toBe('b8=Q+')
  })

  it('resigns the seat that asked, and counts the game as over', () => {
    const state = start()
    const result = chessAdapter.apply(state, 'b', SEATS, { kind: 'resign' }, ctx)
    expect(result).toHaveProperty('state')
    const resigned = (result as { state: GameState }).state
    expect(resigned.status).toBe('resigned')
    expect(resigned.winner).toBe('w')
    expect(chessAdapter.isFinished(resigned)).toBe(true)
    expect(chessAdapter.waitingOn(resigned, SEATS)).toEqual([])
  })
})

describe('chess adapter absences and rematches', () => {
  it('settles an abandoned seat by resigning it', () => {
    const state = move(start(), 'w', 'e2', 'e4')
    const settled = chessAdapter.resolveAbsent(state, 'b', SEATS, ctx)
    expect(settled?.status).toBe('resigned')
    expect(settled?.winner).toBe('w')
  })

  it('starts a fresh game with the colours swapped', () => {
    const played = move(start(), 'w', 'e2', 'e4')
    const { state, seatRemap } = chessAdapter.rematch(played, players, {}, ctx)
    expect(state.history).toEqual([])
    expect(state.turn).toBe('w')
    expect(seatRemap).toEqual({ w: 'b', b: 'w' })
  })
})
