import { describe, expect, it } from 'vitest'
import { createGame, gameReducer, getLegalMoves } from './engine'
import type { GameState } from './types'

function roll(state: GameState, value: number) {
  return gameReducer(gameReducer(state, { type: 'ROLL_START' }), { type: 'ROLL_RESULT', value })
}
function move(state: GameState, pieceId: string) {
  return gameReducer(gameReducer(state, { type: 'MOVE', pieceId }), { type: 'ANIMATION_DONE' })
}
const newGame = () => createGame({ playerCount: 4 })

describe('Hearth & Home rules', () => {
  it('requires six to leave the nest and skips an impossible roll', () => {
    const rolled = roll(newGame(), 3)
    expect(rolled.legalMoves).toEqual([])
    expect(rolled.phase).toBe('pass')
    expect(rolled.events[0].message).toContain('6')
    const next = gameReducer(rolled, { type: 'NEXT_TURN' })
    expect(next.currentPlayer).toBe(1)
    expect(next.phase).toBe('roll')
  })
  it('offers every nest piece on six, enters at progress zero and keeps the turn', () => {
    const rolled = roll(newGame(), 6)
    expect(rolled.legalMoves.map((m) => m.pieceId)).toEqual(['red-0', 'red-1', 'red-2', 'red-3'])
    const next = move(rolled, 'red-0')
    expect(next.pieces[0].progress).toBe(0)
    expect(next.currentPlayer).toBe(0)
    expect(next.phase).toBe('roll')
  })
  it('offers nest entry and moving an existing piece on the same six', () => {
    const state = newGame()
    state.pieces[0].progress = 11
    expect(roll(state, 6).legalMoves.map((m) => m.to)).toEqual([17, 0, 0, 0])
  })
  it('moves space by space and preserves the original state', () => {
    const state = newGame()
    state.pieces[0].progress = 3
    const moving = gameReducer(roll(state, 4), { type: 'MOVE', pieceId: 'red-0' })
    expect(moving.motion?.steps).toEqual([4, 5, 6, 7])
    expect(moving.phase).toBe('moving')
    expect(moving.pieces[0].progress).toBe(7)
    expect(state.pieces[0].progress).toBe(3)
    expect(gameReducer(moving, { type: 'ANIMATION_DONE' }).currentPlayer).toBe(1)
  })
  it('captures every opposing piece on an unprotected shared destination', () => {
    const state = newGame()
    state.pieces[0].progress = 12 // red absolute 19
    state.pieces[4].progress = 2 // blue absolute 22
    state.pieces[5].progress = 2
    const next = move(roll(state, 3), 'red-0')
    expect(next.pieces[0].progress).toBe(15)
    expect(next.pieces[4].progress).toBe(-1)
    expect(next.pieces[5].progress).toBe(-1)
    expect(next.players[0].stats.captures).toBe(2)
    expect(next.events.some((e) => e.kind === 'capture')).toBe(true)
  })
  it('protects opposing pieces on safe spaces and allows shared occupancy', () => {
    const state = newGame()
    state.pieces[0].progress = 11
    state.pieces[4].progress = 0 // absolute 20, blue entry
    const next = move(roll(state, 2), 'red-0')
    expect(next.pieces[0].progress).toBe(13)
    expect(next.pieces[4].progress).toBe(0)
    expect(next.players[0].stats.captures).toBe(0)
  })
  it('enters only its private lane after the full track, without capturing from another lane', () => {
    const state = newGame()
    state.pieces[0].progress = 50
    state.pieces[4].progress = 52
    const next = move(roll(state, 3), 'red-0')
    expect(next.pieces[0].progress).toBe(53)
    expect(next.pieces[4].progress).toBe(52)
  })
  it('rejects overshooting home and explains an exact roll is needed', () => {
    const state = newGame()
    state.pieces[0].progress = 55
    const rolled = roll(state, 3)
    expect(rolled.legalMoves).toEqual([])
    expect(rolled.events[0].message).toContain('exact')
  })
  it('finishes on an exact roll and wins only when all pieces are home', () => {
    const state = newGame()
    state.pieces
      .filter((p) => p.playerId === 'red')
      .forEach((p) => {
        p.progress = 57
      })
    state.pieces[0].progress = 55
    const next = move(roll(state, 2), 'red-0')
    expect(next.pieces[0].progress).toBe(57)
    expect(next.winner).toBe('red')
    expect(next.phase).toBe('won')
    expect(next.events[0].kind).toBe('win')
    expect(getLegalMoves(next, 6)).toEqual([])
  })
  it('cannot select an opponent, double-roll, inject a result, or move during animation', () => {
    const state = newGame()
    expect(gameReducer(state, { type: 'ROLL_RESULT', value: 6 })).toBe(state)
    const rolled = roll(state, 6)
    expect(gameReducer(rolled, { type: 'MOVE', pieceId: 'blue-0' })).toBe(rolled)
    expect(gameReducer(rolled, { type: 'ROLL_START' })).toBe(rolled)
    const moving = gameReducer(rolled, { type: 'MOVE', pieceId: 'red-0' })
    expect(gameReducer(moving, { type: 'MOVE', pieceId: 'red-1' })).toBe(moving)
  })
  it('rejects invalid dice values without altering the roll', () => {
    const state = gameReducer(newGame(), { type: 'ROLL_START' })
    for (const value of [0, 7, 1.5, NaN]) {
      expect(gameReducer(state, { type: 'ROLL_RESULT', value })).toBe(state)
    }
  })
  it('supports quick games and turning off the extra turn', () => {
    const state = createGame({ playerCount: 2, mode: 'quick', rules: { extraTurnOnSix: false } })
    expect(state.pieces).toHaveLength(4)
    const next = move(roll(state, 6), 'red-0')
    expect(next.currentPlayer).toBe(1)
  })
  it('supports disabling exact home, safe spaces and capture independently', () => {
    const state = createGame({ rules: { exactHome: false, safeSpaces: false } })
    state.pieces[0].progress = 56
    expect(move(roll(state, 4), 'red-0').pieces[0].progress).toBe(57)
    state.pieces[0].progress = 11
    state.pieces[4].progress = 0
    expect(move(roll(state, 2), 'red-0').pieces[4].progress).toBe(-1)
    state.rules.captures = false
    expect(move(roll(state, 2), 'red-0').pieces[4].progress).toBe(0)
  })
  it('completes a full deterministic game without deadlock or invalid positions', () => {
    let state = createGame({ playerCount: 3, mode: 'quick' })
    let seed = 137
    let actions = 0
    while (state.phase !== 'won' && actions++ < 10000) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      state = roll(state, 1 + Math.floor((seed / 4294967296) * 6))
      if (state.phase === 'pass') state = gameReducer(state, { type: 'NEXT_TURN' })
      else state = move(state, [...state.legalMoves].sort((a, b) => b.to - a.to)[0].pieceId)
      expect(state.pieces.every((p) => p.progress >= -1 && p.progress <= 57)).toBe(true)
    }
    expect(state.phase).toBe('won')
    expect(state.pieces.filter((p) => p.playerId === state.winner).every((p) => p.progress === 57)).toBe(true)
  })
})
