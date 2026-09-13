import { describe, expect, it } from 'vitest'
import { createGame, gameReducer, rollDie } from './engine'
import { spaceCoordinates } from './board'
import { phaseDuration } from './timing'
import type { GameState } from './types'

function finishRoll(state: GameState, value: number) {
  let next = gameReducer(state, { type: 'ROLL', value })
  next = gameReducer(next, { type: 'DICE_SETTLED' })
  for (let i = 0; i < 10 && next.phase !== 'ready' && next.phase !== 'won'; i++) {
    next = gameReducer(next, {
      type:
        next.phase === 'moving'
          ? 'MOVE_DONE'
          : next.phase === 'transporting'
            ? 'TRANSPORT_DONE'
            : 'NEXT_TURN',
    })
  }
  return next
}

describe('Wildrise rules', () => {
  it('numbers 100 unique spaces in alternating rows', () => {
    expect(spaceCoordinates(1)).toEqual({ x: -4.5, z: 4.5 })
    expect(spaceCoordinates(10)).toEqual({ x: 4.5, z: 4.5 })
    expect(spaceCoordinates(11)).toEqual({ x: 4.5, z: 3.5 })
    expect(spaceCoordinates(20)).toEqual({ x: -4.5, z: 3.5 })
    expect(spaceCoordinates(100)).toEqual({ x: -4.5, z: -4.5 })
    expect(new Set(createGame().board.spaces.map((n) => JSON.stringify(spaceCoordinates(n)))).size).toBe(100)
  })
  it('creates 2–4 players and honors starting-player and starting-position settings', () => {
    const game = createGame({ playerCount: 3, firstPlayer: 2, rules: { startingPosition: 1 } })
    expect(game.players).toHaveLength(3)
    expect(game.currentPlayer).toBe(2)
    expect(game.players.every((p) => p.position === 1)).toBe(true)
    expect(game.events[0].message).toContain('Green')
  })
  it('guards repeated rolls and phase-inappropriate actions', () => {
    const game = createGame()
    expect(gameReducer(game, { type: 'MOVE_DONE' })).toBe(game)
    for (const value of [0, 7, NaN, 1.5]) expect(gameReducer(game, { type: 'ROLL', value })).toBe(game)
    const rolling = gameReducer(game, { type: 'ROLL', value: 5 })
    expect(gameReducer(rolling, { type: 'ROLL', value: 6 })).toBe(rolling)
    expect(rolling.players[0].turns).toBe(1)
  })
  it('walks the whole roll in one motion and hands the die on', () => {
    const game = gameReducer(gameReducer(createGame(), { type: 'ROLL', value: 3 }), { type: 'DICE_SETTLED' })
    expect(game.players[0].position).toBe(0)
    expect(game.motion).toEqual({ kind: 'walk', from: 0, to: 3, path: [1, 2, 3] })
    const walked = gameReducer(game, { type: 'MOVE_DONE' })
    expect(walked.players[0].position).toBe(3)
    expect(walked.phase).toBe('settling')
    expect(gameReducer(walked, { type: 'NEXT_TURN' }).currentPlayer).toBe(1)
  })
  it('paces a walk by the number of squares it covers', () => {
    const game = gameReducer(gameReducer(createGame(), { type: 'ROLL', value: 4 }), { type: 'DICE_SETTLED' })
    expect(phaseDuration(game, false)).toBe(190 * 4)
    expect(phaseDuration(game, true)).toBe(60 * 4)
  })
  it('climbs only after landing on a ladder bottom', () => {
    const next = finishRoll(createGame(), 4)
    expect(next.players[0].position).toBe(25)
    expect(next.players[0].climbs).toBe(1)
    expect(next.events.some((e) => e.message.includes('4 → 25'))).toBe(true)
    expect(finishRoll(createGame(), 5).players[0].position).toBe(5)
  })
  it('slides along a snake only after landing on its head', () => {
    const game = createGame()
    game.players[0].position = 46
    const next = finishRoll(game, 1)
    expect(next.players[0].position).toBe(26)
    expect(next.players[0].slides).toBe(1)
  })
  it('explains an overshoot and keeps the token where it was', () => {
    const game = createGame()
    game.players[0].position = 97
    const next = finishRoll(game, 5)
    expect(next.players[0].position).toBe(97)
    expect(next.events.some((e) => e.message.includes('needs a 3 to reach 100'))).toBe(true)
    expect(next.currentPlayer).toBe(1)
  })
  it('wins exactly at 100, records statistics and locks the finished game', () => {
    const game = createGame()
    game.players[0].position = 97
    const next = finishRoll(game, 3)
    expect(next.phase).toBe('won')
    expect(next.winner).toBe('red')
    expect(next.players[0].position).toBe(100)
    expect(next.players[0].turns).toBe(1)
    expect(gameReducer(next, { type: 'ROLL', value: 3 })).toBe(next)
  })
  it('honors non-exact finish, optional bonus sixes and configurable routes', () => {
    const game = createGame({
      rules: { exactFinish: false, extraTurnOnSix: true, snakeCount: 0, ladderCount: 0 },
    })
    expect(game.board.snakes).toHaveLength(0)
    expect(game.board.ladders).toHaveLength(0)
    const six = finishRoll(game, 6)
    expect(six.currentPlayer).toBe(0)
    six.players[0].position = 97
    expect(finishRoll(six, 5).winner).toBe('red')
  })
  it('allows shared spaces by default and can block occupied destinations', () => {
    const game = createGame()
    game.players[1].position = 3
    expect(finishRoll(game, 3).players[0].position).toBe(3)
    game.rules.allowSharedSquares = false
    expect(finishRoll(game, 3).players[0].position).toBe(0)
  })
  it('keeps configuration and previous states immutable and serializable', () => {
    const game = createGame()
    const snapshot = JSON.stringify(game)
    finishRoll(game, 4)
    expect(JSON.stringify(game)).toBe(snapshot)
    expect(JSON.parse(snapshot)).toEqual(game)
  })
  it('uses the same unbiased random source for every player', () => {
    expect(rollDie(() => 0)).toBe(1)
    expect(rollDie(() => 0.99999)).toBe(6)
    expect(Array.from({ length: 6 }, (_, i) => rollDie(() => (i + 0.5) / 6))).toEqual([1, 2, 3, 4, 5, 6])
  })
  it.each([2, 3, 4])(
    'completes a %i-player game with fair seeded rolls and no invalid positions',
    (playerCount) => {
      let seed = 713
      const random = () => {
        seed = (seed * 16807) % 2147483647
        return (seed - 1) / 2147483646
      }
      let game = createGame({ playerCount })
      for (let roll = 0; roll < 2000 && !game.winner; roll++) {
        game = finishRoll(game, rollDie(random))
        expect(game.players.every((p) => p.position >= 0 && p.position <= 100)).toBe(true)
        expect(['ready', 'won']).toContain(game.phase)
      }
      expect(game.winner).not.toBeNull()
      expect(game.players.find((p) => p.id === game.winner)?.position).toBe(100)
    },
  )
})
