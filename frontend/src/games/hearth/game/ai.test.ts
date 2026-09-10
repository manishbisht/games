import { describe, expect, it } from 'vitest'
import { chooseAIMove } from './ai'
import { createGame, gameReducer } from './engine'
import type { Control, GameState } from './types'

function roll(state: GameState, value: number) {
  return gameReducer(gameReducer(state, { type: 'ROLL_START' }), { type: 'ROLL_RESULT', value })
}
describe('AI decisions', () => {
  it('never invents a move when none is legal', () => {
    expect(chooseAIMove(roll(createGame(), 2), 'hard', 0.5)).toBeNull()
  })
  it('allows Easy to choose any legal piece without changing the die', () => {
    const state = roll(createGame(), 6)
    expect(chooseAIMove(state, 'easy', 0)?.pieceId).toBe('red-0')
    expect(chooseAIMove(state, 'easy', 0.99)?.pieceId).toBe('red-3')
    expect(state.dice).toBe(6)
  })
  it('allows Medium’s occasional random choice to reach all legal pieces', () => {
    const state = roll(createGame(), 6)
    expect(chooseAIMove(state, 'medium', 0.01)?.pieceId).toBe('red-0')
    expect(chooseAIMove(state, 'medium', 0.16)?.pieceId).toBe('red-3')
  })
  it('prioritizes reaching home over a capture', () => {
    const state = createGame()
    state.pieces[0].progress = 55
    state.pieces[1].progress = 12
    state.pieces[4].progress = 1
    expect(chooseAIMove(roll(state, 2), 'hard', 0.8)?.pieceId).toBe('red-0')
  })
  it('prefers capturing an opponent to an ordinary move', () => {
    const state = createGame()
    state.pieces[0].progress = 12
    state.pieces[1].progress = 20
    state.pieces[4].progress = 2
    expect(chooseAIMove(roll(state, 3), 'medium', 0.8)?.pieceId).toBe('red-0')
  })
  it('chooses a safe landing over an exposed piece in range of an opponent', () => {
    const state = createGame()
    state.pieces[0].progress = 16 // +3 -> absolute26, safe
    state.pieces[1].progress = 30 // +3 -> absolute40, unsafe
    state.pieces[4].progress = 17 // absolute37, can capture 40 with3
    expect(chooseAIMove(roll(state, 3), 'hard', 0.8)?.pieceId).toBe('red-0')
  })
  for (const difficulty of ['easy', 'medium', 'hard'] as Control[]) {
    it(`finishes complete ${difficulty} games with only legal moves`, () => {
      for (let seed = 1; seed <= 4; seed++) {
        let randomState = seed * 91,
          state = createGame({ playerCount: 4, mode: 'quick' })
        const random = () => {
          randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0
          return randomState / 4294967296
        }
        let turns = 0
        while (!state.winner && turns++ < 8000) {
          state = roll(state, 1 + Math.floor(random() * 6))
          if (state.phase === 'pass') state = gameReducer(state, { type: 'NEXT_TURN' })
          else {
            const move = chooseAIMove(state, difficulty, random())!
            expect(state.legalMoves.some((m) => m.pieceId === move.pieceId)).toBe(true)
            state = gameReducer(gameReducer(state, { type: 'MOVE', pieceId: move.pieceId }), {
              type: 'ANIMATION_DONE',
            })
          }
        }
        expect(state.phase).toBe('won')
        expect(state.pieces.filter((p) => p.playerId === state.winner).every((p) => p.progress === 57)).toBe(
          true,
        )
      }
    })
  }
})
