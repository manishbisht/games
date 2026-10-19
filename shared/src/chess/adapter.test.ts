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
    // Chess is perfect information, and an untimed game never waits on a timer.
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

describe('chess adapter clocks', () => {
  const T0 = ctx.now
  const at = (now: number): Ctx => ({ ...ctx, now })
  const timed = (timeControl = '3+2') =>
    chessAdapter.create(players, chessAdapter.validateOptions({ timeControl }), ctx)
  const play = (state: GameState, seat: string, from: string, to: string, now: number) => {
    const result = chessAdapter.apply(state, seat, SEATS, { kind: 'move', from, to }, at(now))
    if ('error' in result) throw new Error(`unexpected ${result.error}`)
    return result.state
  }
  /** Both first moves, which the clocks wait for. */
  const opened = (control?: string) =>
    play(play(timed(control), 'w', 'e2', 'e4', T0 + 40_000), 'b', 'e7', 'e5', T0 + 90_000)

  it('accepts only the time controls it offers, and plays untimed otherwise', () => {
    expect(chessAdapter.validateOptions({ timeControl: '5+0' })).toEqual({ timeControl: '5+0' })
    for (const raw of [
      undefined,
      null,
      'x',
      {},
      { timeControl: 'none' },
      { timeControl: '7+0' },
      { timeControl: 5 },
    ])
      expect(chessAdapter.validateOptions(raw)).toEqual({})
    const state = timed('15+10')
    expect(state.options).toMatchObject({ clock: 15, increment: 10 })
    expect(state.clocks).toEqual({ w: 900_000, b: 900_000 })
    expect(start().options.clock).toBe(0)
  })

  it('starts neither clock until both sides have moved', () => {
    const state = timed()
    expect(chessAdapter.pending(state)).toBeNull()
    const first = play(state, 'w', 'e2', 'e4', T0 + 40_000)
    expect(chessAdapter.pending(first)).toBeNull()
    const second = play(first, 'b', 'e7', 'e5', T0 + 90_000)
    // Nobody was charged for the opening moves; each banked its increment.
    expect(second.clocks).toEqual({ w: 182_000, b: 182_000 })
    expect(second.clockAt).toBe(T0 + 90_000)
    expect(chessAdapter.pending(second)?.afterMs).toBe(182_000)
  })

  it('charges the time spent and adds the increment on every move', () => {
    const next = play(opened(), 'w', 'g1', 'f3', T0 + 100_000)
    expect(next.clocks).toEqual({ w: 182_000 - 10_000 + 2_000, b: 182_000 })
    expect(chessAdapter.pending(next)?.afterMs).toBe(182_000)
    const flat = play(opened('5+0'), 'w', 'g1', 'f3', T0 + 100_000)
    expect(flat.clocks.w).toBe(290_000)
  })

  it('flags the side to move when its time runs out', () => {
    const state = opened(),
      pending = chessAdapter.pending(state)!
    const flagged = pending.resolve(state, at(state.clockAt + pending.afterMs))
    expect(flagged.status).toBe('timeout')
    expect(flagged.winner).toBe('b')
    expect(flagged.clocks.w).toBe(0)
    expect(chessAdapter.isFinished(flagged)).toBe(true)
    expect(chessAdapter.pending(flagged)).toBeNull()
  })

  it('re-arms rather than flags when the timer fires early', () => {
    const state = opened(),
      early = chessAdapter.pending(state)!.resolve(state, at(state.clockAt + 100_000))
    expect(early.status).toBe('playing')
    expect(early.clocks.w).toBe(82_000)
    expect(chessAdapter.pending(early)?.afterMs).toBe(82_000)
  })

  it('treats a move that arrives after the flag as the flag', () => {
    const state = opened()
    const late = play(state, 'w', 'g1', 'f3', state.clockAt + 182_001)
    expect(late.status).toBe('timeout')
    expect(late.history).toHaveLength(2)
  })

  it('calls a flag with no mating material left a draw', () => {
    const bare = { ...opened(), pieces: opened().pieces.filter((p) => p.type === 'k' || p.color === 'w') }
    const flagged = chessAdapter.pending(bare)!.resolve(bare, at(bare.clockAt + 182_000))
    expect(flagged.status).toBe('timeout')
    expect(flagged.winner).toBeNull()
  })

  it('never holds a bot’s turn on the flag timer, but still charges its thinking', () => {
    const bots = chessAdapter.bots!
    // White is a person and moves first; the bot learns its colour on its reply.
    const first = play(timed(), 'w', 'e2', 'e4', T0 + 1_000)
    expect(chessAdapter.pending(first)).toBeNull()
    const reply = bots.decide(first, 'b', SEATS, 'easy', at(T0 + 1_200))
    expect(reply.bots).toEqual(['b'])
    expect(reply.history).toHaveLength(2)
    expect(chessAdapter.pending(reply)?.afterMs).toBe(reply.clocks.w)
    const mine = play(reply, 'w', 'g1', 'f3', T0 + 11_200)
    expect(mine.turn).toBe('b')
    expect(chessAdapter.pending(mine)).toBeNull()
    const answer = bots.decide(mine, 'b', SEATS, 'easy', at(T0 + 11_500))
    expect(answer.clocks.b).toBe(mine.clocks.b - 300 + 2_000)
    expect(answer.bots).toEqual(['b'])
  })

  it('keeps the time control across a rematch', () => {
    const options = chessAdapter.validateOptions({ timeControl: '10+0' })
    const { state } = chessAdapter.rematch(opened('10+0'), players, options, ctx)
    expect(state.clocks).toEqual({ w: 600_000, b: 600_000 })
    expect(state.history).toEqual([])
    expect(state.bots).toBeUndefined()
  })
})
