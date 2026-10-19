import { describe, expect, it } from 'vitest'
import { expectedScore, kFactor, nextRating, PROVISIONAL_GAMES, START_RATING } from '../src/elo'
import { outcomeOf } from '../src/outcome'
import { turnAlerts, turnMessage } from '../src/ledger'
import { playerHandle, validHandle } from '../src/handles'
import { durationBucket } from '../src/analytics'

describe('Elo', () => {
  it('expects an even score between equals and a lopsided one across 400 points', () => {
    expect(expectedScore(1200, 1200)).toBe(0.5)
    expect(expectedScore(1600, 1200)).toBeCloseTo(10 / 11, 6)
    expect(expectedScore(1200, 1600) + expectedScore(1600, 1200)).toBeCloseTo(1, 10)
  })

  it('moves a provisional player twice as fast as a settled one', () => {
    expect(kFactor(0)).toBe(40)
    expect(kFactor(PROVISIONAL_GAMES - 1)).toBe(40)
    expect(kFactor(PROVISIONAL_GAMES)).toBe(20)
    expect(nextRating(START_RATING, START_RATING, 1, 0)).toBe(1220)
    expect(nextRating(START_RATING, START_RATING, 0, 0)).toBe(1180)
    expect(nextRating(START_RATING, START_RATING, 1, 30)).toBe(1210)
    expect(nextRating(1500, 1500, 0.5, 30)).toBe(1500)
  })

  it('rewards an upset more than an expected win', () => {
    const upset = nextRating(1200, 1600, 1, 30) - 1200
    const expected = nextRating(1600, 1200, 1, 30) - 1600
    expect(upset).toBe(18)
    expect(expected).toBe(2)
  })
})

describe('outcomeOf', () => {
  it('reads chess winners, and every kind of chess draw', () => {
    expect(outcomeOf('chess', { status: 'checkmate', winner: 'b' }, ['w', 'b'])).toEqual({
      w: { result: 'loss' },
      b: { result: 'win' },
    })
    for (const status of ['stalemate', 'repetition', 'agreement'])
      expect(outcomeOf('chess', { status, winner: null }, ['w', 'b'])).toEqual({
        w: { result: 'draw' },
        b: { result: 'draw' },
      })
  })

  it('maps a player id to the seat that played it', () => {
    const state = { winner: 'green', players: [{ id: 'red' }, { id: 'blue' }, { id: 'green' }] }
    const out = outcomeOf(
      'wildrise',
      { ...state, players: state.players.map((p, i) => ({ ...p, position: i * 10 })) },
      ['p0', 'p1', 'p2'],
    )
    expect(out.p2).toEqual({ result: 'win', place: 1 })
    expect(out.p1).toEqual({ result: 'loss', place: 2 })
    expect(out.p0).toEqual({ result: 'loss', place: 3 })
  })

  it('ranks the rest of a table behind the winner, ties sharing a place', () => {
    const hearth = {
      winner: 'red',
      players: [{ id: 'red' }, { id: 'blue' }, { id: 'green' }, { id: 'yellow' }],
      pieces: [
        { playerId: 'blue', progress: 20 },
        { playerId: 'blue', progress: 10 },
        { playerId: 'green', progress: 30 },
        { playerId: 'yellow', progress: 5 },
      ],
    }
    expect(outcomeOf('hearth', hearth, ['p0', 'p1', 'p2', 'p3'])).toEqual({
      p0: { result: 'win', place: 1 },
      p1: { result: 'loss', place: 2 },
      p2: { result: 'loss', place: 2 },
      p3: { result: 'loss', place: 4 },
    })
    const prism = {
      status: 'won',
      winner: 1,
      players: [
        { id: 0, hand: [1, 2, 3] },
        { id: 1, hand: [] },
        { id: 2, hand: [1] },
      ],
    }
    expect(outcomeOf('prism', prism, ['p0', 'p1', 'p2'])).toEqual({
      p0: { result: 'loss', place: 3 },
      p1: { result: 'win', place: 1 },
      p2: { result: 'loss', place: 2 },
    })
    const estate = {
      winner: 0,
      players: [
        { id: 0, cash: 900 },
        { id: 1, cash: 0, bankrupt: true },
        { id: 2, cash: 40 },
      ],
    }
    expect(outcomeOf('estate', estate, ['p0', 'p1', 'p2']).p1).toEqual({ result: 'loss', place: 3 })
  })

  it('calls a Prism deck run dry a draw', () => {
    expect(outcomeOf('prism', { status: 'draw', winner: null, players: [{}, {}] }, ['p0', 'p1'])).toEqual({
      p0: { result: 'draw' },
      p1: { result: 'draw' },
    })
  })

  it('settles a game the room ended against somebody', () => {
    expect(outcomeOf('hearth', { winner: null, players: [] }, ['p0', 'p1'], ['p1'])).toEqual({
      p0: { result: 'win' },
      p1: { result: 'loss' },
    })
    expect(outcomeOf('prism', { status: 'playing', winner: null }, ['p0', 'p1', 'p2'], ['p0'])).toEqual({
      p0: { result: 'loss' },
      p1: { result: 'draw' },
      p2: { result: 'draw' },
    })
  })

  it('never throws on a state it cannot read', () => {
    expect(outcomeOf('estate', null, ['p0', 'p1'])).toEqual({
      p0: { result: 'draw' },
      p1: { result: 'draw' },
    })
  })
})

describe('turn alerts', () => {
  const people = new Set(['p0', 'p1', 'p2'])
  const person = (seat: string) => people.has(seat)
  it('alerts only a turn that has just arrived for an absent person', () => {
    const away = new Set(['p1'])
    const connected = (seat: string) => !away.has(seat)
    expect(turnAlerts(['p0'], ['p1'], person, connected)).toEqual(['p1'])
    // Still their turn at the next save: not news.
    expect(turnAlerts(['p1'], ['p1'], person, connected)).toEqual([])
    // Their turn, but they are here.
    expect(turnAlerts(['p1'], ['p0'], person, connected)).toEqual([])
    // A bot's turn alerts nobody.
    expect(turnAlerts(['p0'], ['p3'], person, () => false)).toEqual([])
  })

  it('words the notification for the game and the people waiting', () => {
    expect(turnMessage('chess', 'ABC234', ['Ben'])).toEqual({
      title: 'Your turn in Gambit',
      body: 'Ben is waiting for you.',
      path: '/chess/room/ABC234',
      tag: 'turn-ABC234',
    })
    expect(turnMessage('hearth', 'ABC234', ['Ann', 'Ben', 'Cleo']).body).toBe(
      'Ann, Ben and Cleo are waiting for you.',
    )
  })
})

describe('handles', () => {
  it('derives a stable, URL-safe handle that does not contain the id', async () => {
    const id = 'guest:01234567-89ab-4cde-8f01-23456789abcd'
    const handle = await playerHandle(id)
    expect(validHandle(handle)).toBe(true)
    expect(await playerHandle(id)).toBe(handle)
    expect(await playerHandle('guest:11234567-89ab-4cde-8f01-23456789abcd')).not.toBe(handle)
    expect(id).not.toContain(handle)
    expect(validHandle('../../etc')).toBe(false)
  })
})

describe('analytics', () => {
  it('buckets a game length coarsely', () => {
    expect(durationBucket(30_000)).toBe(1)
    expect(durationBucket(4 * 60_000)).toBe(5)
    expect(durationBucket(61 * 60_000)).toBe(120)
    expect(durationBucket(10 * 3_600_000)).toBe(240)
  })
})
