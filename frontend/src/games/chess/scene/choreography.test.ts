import { describe, expect, it } from 'vitest'
import { createGame, playMove } from '@games/shared/chess'
import type { GameState, Square } from '@games/shared/chess/types'
import {
  fallDirection,
  graveSlot,
  moveDuration,
  planMove,
  returnDelay,
  squareAt,
  squareXZ,
  story,
} from './choreography'

const play = (game: GameState, ...moves: [string, string, ('q' | 'r' | 'b' | 'n')?][]) =>
  moves.reduce((g, [from, to, promotion]) => playMove(g, from, to, promotion, 0), game)

describe('board geometry', () => {
  it('maps every square to its centre and back', () => {
    for (const file of 'abcdefgh')
      for (let rank = 1; rank <= 8; rank++) {
        const square = `${file}${rank}` as Square,
          { x, z } = squareXZ(square)
        expect(squareAt(x, z)).toBe(square)
        expect(squareAt(x + 0.45, z - 0.45)).toBe(square)
      }
    expect(squareAt(4.2, 0)).toBeNull()
  })

  it('gives a long move more time than a step, but not proportionally more', () => {
    expect(moveDuration(1)).toBe(330)
    expect(moveDuration(7)).toBeGreaterThan(moveDuration(1))
    expect(moveDuration(7)).toBeLessThan(moveDuration(1) * 2)
  })
})

describe('planMove', () => {
  it('finds the castling rook', () => {
    const game = play(
      createGame(),
      ['e2', 'e4'],
      ['e7', 'e5'],
      ['g1', 'f3'],
      ['b8', 'c6'],
      ['f1', 'c4'],
      ['g8', 'f6'],
      ['e1', 'g1'],
    )
    expect(planMove(game.history.at(-1)!).rook).toEqual({ from: 'h1', to: 'f1' })
  })

  it('puts the en passant victim beside the destination', () => {
    const game = play(createGame(), ['e2', 'e4'], ['a7', 'a6'], ['e4', 'e5'], ['d7', 'd5'], ['e5', 'd6'])
    const plan = planMove(game.history.at(-1)!)
    expect(plan.to).toBe('d6')
    expect(plan.victim).toBe('d5')
  })

  it('reads a promotion with capture, and mate', () => {
    const promoted = play(
      createGame(),
      ['h2', 'h4'],
      ['g7', 'g5'],
      ['h4', 'g5'],
      ['h7', 'h5'],
      ['g5', 'g6'],
      ['h5', 'h4'],
      ['g6', 'g7'],
      ['h4', 'h3'],
      ['g7', 'h8', 'n'],
    )
    const plan = planMove(promoted.history.at(-1)!)
    expect(plan).toMatchObject({ victim: 'h8', promotion: 'n', piece: 'p' })
    const mated = play(createGame(), ['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4'])
    expect(planMove(mated.history.at(-1)!)).toMatchObject({ check: true, mate: true })
  })
})

describe('story', () => {
  const start = createGame(),
    one = play(start, ['e2', 'e4']),
    three = play(one, ['e7', 'e5'], ['g1', 'f3'])
  it('tells new moves in order', () => {
    const told = story(one, three)
    expect(told.kind).toBe('moves')
    if (told.kind === 'moves') expect(told.records.map((r) => r.san)).toEqual(['e5', 'Nf3'])
  })
  it('calls a shorter or different history a fresh game', () => {
    expect(story(three, createGame()).kind).toBe('reset')
    expect(story(one, play(start, ['d2', 'd4'])).kind).toBe('reset')
  })
  it('has nothing to tell for a snapshot that adds no move', () => {
    expect(story(one, { ...one, status: 'resigned' }).kind).toBe('none')
  })
})

describe('fallDirection', () => {
  it('falls away from the blow when there is room', () => {
    expect(fallDirection('d4', { x: 1, z: 0 }, new Set())).toEqual({ x: 1, z: 0 })
  })
  it('turns aside rather than lie down through a neighbour', () => {
    const fall = fallDirection('d4', { x: 1, z: 0 }, new Set(['e4']))
    expect(fall.x).toBeGreaterThan(0.5)
    expect(Math.abs(fall.z)).toBeGreaterThan(0.5)
  })
})

describe('the trays and the rematch', () => {
  it('lays each colour down its own side without overlap', () => {
    const black = Array.from({ length: 15 }, (_, i) => graveSlot('b', i)),
      white = Array.from({ length: 15 }, (_, i) => graveSlot('w', i))
    expect(black.every((s) => s.x > 4.6)).toBe(true)
    expect(white.every((s) => s.x < -4.6)).toBe(true)
    for (const slots of [black, white]) {
      expect(new Set(slots.map((s) => s.z.toFixed(2))).size).toBe(15)
      expect(slots.every((s) => Math.abs(s.z) < 4.15)).toBe(true)
    }
  })
  it('sends the back ranks home before the pawns', () => {
    expect(returnDelay('w', 'h1')).toBeLessThan(returnDelay('w', 'a2'))
    expect(returnDelay('b', 'h8')).toBeLessThan(returnDelay('b', 'a7'))
  })
})
