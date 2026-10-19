import { clockLeft, clockStarted } from '@games/shared/chess'
import type { Color, GameState } from '@games/shared/chess/types'
import type { BeatTiming } from '@games/shared/protocol'

/**
 * A snapshot's timing, with when this browser received it on its own
 * monotonic clock. The server's clock is never read from `Date.now()`: it is
 * the snapshot's `now`, carried forward by how long this tab has held it, so a
 * phone whose wall clock is a minute out still shows the clock the server keeps.
 */
export interface HeldTiming extends BeatTiming {
  at: number
}

/**
 * Holds a snapshot's timing from `receivedAt`, when the socket delivered it —
 * not from whenever React got round to rendering it, which a busy tab can
 * leave a frame or more behind.
 */
export function hold(timing: BeatTiming | undefined, receivedAt: number): HeldTiming | undefined {
  return timing && { ...timing, at: receivedAt }
}

/** The server's clock now, as best this tab can tell; null without a snapshot to tell from. */
export const serverNow = (timing: HeldTiming | undefined) =>
  timing ? timing.now + (performance.now() - timing.at) : null

/** Time `color` has left, by the server's clock. Stopped clocks read their stored time. */
export function remaining(game: GameState, color: Color, timing: HeldTiming | undefined) {
  const now = serverNow(timing)
  return clockLeft(game, color, clockStarted(game) && now !== null ? now : game.clockAt)
}

/**
 * A clock face: minutes and seconds, and tenths in the last ten seconds when
 * they matter. Seconds round up while the clock is running — 0:00 is the flag,
 * not the last second of play.
 */
export function clockFace(ms: number) {
  const tenths = Math.ceil(ms / 100)
  if (ms > 0 && tenths < 100) return `0:0${Math.floor(tenths / 10)}.${tenths % 10}`
  const seconds = Math.ceil(Math.max(0, ms) / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** "3 + 2", the way a time control is said at a club. */
export const controlName = (minutes: number, increment = 0) => `${minutes} + ${increment}`
