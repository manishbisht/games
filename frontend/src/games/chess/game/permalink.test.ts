import { describe, expect, it } from 'vitest'
import { createGame, playMove, resign } from '@games/shared/chess'
import type { GameState } from '@games/shared/chess/types'
import { permalinkPath, readPermalink } from './permalink'

const play = (...moves: [string, string, ('q' | 'n')?][]) =>
  moves.reduce<GameState>(
    (game, [from, to, promotion]) => playMove(game, from, to, promotion, 0),
    createGame({ mode: 'online', clock: 0 }, undefined, 0),
  )
const read = (path: string) => readPermalink(new URLSearchParams(path.split('?')[1]))

describe('permanent links', () => {
  it('carry a mate in the moves alone, and play it back state by state', () => {
    const mate = play(['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4'])
    const path = permalinkPath(mate, { w: 'Ann', b: 'Jules' })
    expect(path).toBe('/chess?moves=f2f3e7e5g2g4d8h4&w=Ann&b=Jules')
    const replay = read(path)!
    expect(replay.states).toHaveLength(5)
    expect(replay.states.at(-1)!.state.status).toBe('checkmate')
    expect(replay.states.at(-1)!.state.winner).toBe('b')
    expect(replay.players.map((p) => p.name)).toEqual(['Ann', 'Jules'])
    // The pieces keep the ids the room's own states give them, so the board moves the same actors.
    expect(replay.states.at(-1)!.state.pieces).toEqual(mate.pieces)
  })

  it('say how a game ended when the moves do not', () => {
    const resigned = resign(play(['e2', 'e4']), 0, 'b')
    const path = permalinkPath(resigned)
    expect(path).toBe('/chess?moves=e2e4&end=resigned.w')
    const final = read(path)!.states.at(-1)!.state
    expect([final.status, final.winner]).toEqual(['resigned', 'w'])
    expect(read(path)!.players.map((p) => p.name)).toEqual(['White', 'Black'])
  })

  it('keep promotions', () => {
    const game = play(
      ['h2', 'h4'],
      ['g7', 'g5'],
      ['h4', 'g5'],
      ['g8', 'f6'],
      ['g5', 'g6'],
      ['f6', 'e4'],
      ['g6', 'g7'],
      ['e4', 'c5'],
      ['g7', 'h8', 'n'],
    )
    const path = permalinkPath(game)
    expect(path).toContain('g7h8n')
    expect(read(path)!.states.at(-1)!.state.fen).toBe(game.fen)
  })

  it('refuse anything that is not legal chess', () => {
    expect(read('/chess?moves=')).toBeNull()
    expect(read('/chess?moves=e2e5')).toBeNull()
    expect(read('/chess?moves=e2e4zz')).toBeNull()
    expect(read('/chess?moves=e2e4e2e4')).toBeNull()
    expect(read(`/chess?moves=${'g1f3f3g1'.repeat(300)}`)).toBeNull()
  })
})
