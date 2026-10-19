import { Chess } from 'chess.js'
import { describe, expect, it } from 'vitest'
import { clockStarted, playMove } from '@games/shared/chess'
import { chooseMove } from '@games/shared/chess/ai'
import type { GameState, PromotionPiece } from '@games/shared/chess/types'
import { getAdapter } from '@games/shared/online'
import type { GameAdapter } from '@games/shared/online/adapter'

/**
 * The chess adapter replays only the moves since the last capture or one-step
 * pawn move, where the engine replays the whole game. These games are played
 * both ways, move for move, and must come out identical: every field of every
 * state, every bot's choice, every repetition and fifty-move draw.
 */
const chess = getAdapter('chess') as unknown as GameAdapter<GameState, unknown>
const SEATS = ['w', 'b']
const NOW = 1_700_000_000_000

/** A small seeded generator, so a failure replays exactly. */
function seeded(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32
  }
}

/** What the adapter did before: the engine, on the whole line. */
const wholeLineMove = (state: GameState, from: string, to: string, promotion?: PromotionPiece) =>
  playMove(clockStarted(state) ? state : { ...state, clockAt: NOW }, from, to, promotion, NOW)

function play(
  seed: number,
  plies: number,
  pick: (moves: ReturnType<Chess['moves']>, random: () => number) => number,
) {
  const random = seeded(seed)
  let state = chess.create(
    SEATS.map((id) => ({ id, name: id })),
    {},
    { random, now: NOW },
  ) as GameState
  for (let ply = 0; ply < plies && state.status === 'playing'; ply++) {
    const moves = new Chess(state.fen).moves({ verbose: true })
    const move = moves[pick(moves, random)]
    const promotion = move.promotion as PromotionPiece | undefined
    const applied = chess.apply(
      state,
      state.turn,
      SEATS,
      { kind: 'move', from: move.from, to: move.to, promotion },
      {
        random,
        now: NOW,
      },
    )
    expect('state' in applied).toBe(true)
    const next = (applied as { state: GameState }).state
    expect(next).toEqual(wholeLineMove(state, move.from, move.to, promotion))

    if (ply % 25 === 12) {
      // A bot at this point chooses, and moves, exactly as it did on the whole line.
      const decided = chess.bots!.decide(state, state.turn, SEATS, 'easy', { random: seeded(ply), now: NOW })
      const choice = chooseMove(state, 'easy', seeded(ply))!
      const reference = wholeLineMove(state, choice.from, choice.to, choice.promotion as PromotionPiece)
      expect(decided).toEqual({ ...reference, bots: [state.turn] })
    }
    state = next
  }
  return state
}

describe('the chess adapter’s shortened replay', () => {
  it('plays random games exactly as the whole-line replay does', () => {
    const endings = new Set<string>()
    for (let game = 0; game < 4; game++) {
      const end = play(game + 1, 160, (moves, random) => Math.floor(random() * moves.length))
      endings.add(end.status)
      expect(end.history.length).toBeGreaterThan(0)
    }
    expect(endings.size).toBeGreaterThan(0)
  }, 120_000)

  it('plays shuffling games — repetitions and the fifty-move rule — exactly as before', () => {
    // Prefer quiet piece moves, so positions repeat and the fifty-move count runs.
    const quiet = (moves: ReturnType<Chess['moves']>, random: () => number) => {
      const shuffles = moves
        .map((move, index) => ({ move, index }))
        .filter(({ move }) => move.piece !== 'p' && !move.captured)
      const pool = shuffles.length ? shuffles : moves.map((move, index) => ({ move, index }))
      return pool[Math.floor(random() * pool.length)].index
    }
    const endings = new Set<string>()
    for (let game = 0; game < 3; game++) endings.add(play(100 + game, 140, quiet).status)
    expect([...endings].some((status) => status === 'repetition' || status === 'fifty-move')).toBe(true)
  }, 120_000)

  it('calls a threefold repetition after a one-step pawn move on the same ply', () => {
    let state = chess.create(
      SEATS.map((id) => ({ id, name: id })),
      {},
      { random: Math.random, now: NOW },
    ) as GameState
    const line = ['e2e3', 'e7e6', 'g1f3', 'g8f6', 'f3g1', 'f6g8', 'g1f3', 'g8f6', 'f3g1', 'f6g8']
    for (const [index, uci] of line.entries()) {
      const result = chess.apply(
        state,
        state.turn,
        SEATS,
        { kind: 'move', from: uci.slice(0, 2), to: uci.slice(2) },
        {
          random: Math.random,
          now: NOW,
        },
      ) as { state: GameState }
      state = result.state
      expect(state.status).toBe(index === line.length - 1 ? 'repetition' : 'playing')
    }
    expect(state.history).toHaveLength(line.length)
    expect(state.initialFen).toBe(new Chess().fen())
  })
})
