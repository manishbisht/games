import { describe, expect, it } from 'vitest'
import { NODE_BUDGET, search } from '@games/shared/chess/ai'
import { createGame } from '@games/shared/chess'
import type { Difficulty } from '@games/shared/chess/types'

/**
 * What a chess bot's move actually costs inside workerd — the only place in
 * this repo that runs it — because the answer decides which levels are
 * affordable to offer. A bot move is billed CPU on every turn of every game,
 * so a level that takes over a second is a minute of Durable Object time per
 * forty-move game.
 *
 * Timed across an I/O turn, because the clock does not advance during a
 * synchronous run: that is the same freeze that made the search's old
 * wall-clock deadline unusable here, and is why the budget counts nodes.
 */

/** Hand the isolate back so its clock catches up with the work just done. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/** A middlegame with plenty of legal moves, so the search has work to do. */
const POSITION = 'r1bq1rk1/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQ1RK1 w - - 6 6'

async function timeMoves(difficulty: Difficulty, runs: number): Promise<number[]> {
  const game = createGame({}, POSITION)
  const samples: number[] = []
  for (let i = 0; i < runs; i++) {
    // Yield first, so the clock this reads has actually moved on.
    await tick()
    const start = Date.now()
    const { move } = search(game, difficulty, () => 0.5)
    await tick()
    samples.push(Date.now() - start)
    expect(move).not.toBeNull()
  }
  return samples.sort((a, b) => a - b)
}

const at = (sorted: number[], quantile: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * quantile))]

describe('what a chess bot move costs the server', () => {
  it('stays inside the budget it is offered at', async () => {
    // The shipping rule, written down and set from what was measured rather
    // than guessed: an offered level's median move must be at or under 500ms
    // and its p95 at or under 700ms. On this machine easy comes in at ~28ms
    // and medium at ~430ms, which is roughly seventeen seconds of Durable
    // Object CPU across a forty-move game — real, and affordable.
    //
    // `hard` measured ~1.14s a move, or three quarters of a minute a game, so
    // it is deliberately not offered. The numbers here are what would have to
    // change for that to be revisited.
    for (const difficulty of ['easy', 'medium'] as const) {
      const samples = await timeMoves(difficulty, 9)
      const median = at(samples, 0.5)
      const p95 = at(samples, 0.95)
      console.log(`chess bot ${difficulty}: median ${median}ms p95 ${p95}ms of ${samples.join('/')}`)
      expect(median).toBeLessThanOrEqual(500)
      expect(p95).toBeLessThanOrEqual(700)
    }
  })

  it('prices the level that is not offered, so the decision can be revisited', async () => {
    // `hard` is measured but deliberately absent from `chessAdapter.bots.skills`
    // — it came in at roughly 1.14s a move. Logged rather than asserted, so a
    // slow machine cannot fail the build over a level nobody can select.
    const samples = await timeMoves('hard', 5)
    console.log(`chess bot hard (not offered): median ${at(samples, 0.5)}ms of ${samples.join('/')}`)
    expect(samples.length).toBe(5)
  })

  it('never searches past its budget, whatever the position', async () => {
    for (const difficulty of ['easy', 'medium', 'hard'] as const) {
      const { nodes } = search(createGame({}, POSITION), difficulty, () => 0.5)
      expect(nodes).toBeLessThanOrEqual(NODE_BUDGET[difficulty])
    }
  })
})
