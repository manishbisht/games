import type { ReplayFrame } from '@games/shared/protocol'

/** The rates the player bar offers. */
export const REPLAY_SPEEDS = [0.5, 1, 2, 4] as const

/**
 * The shortest and longest a state stays on screen at 1×. The room's own
 * pacing sets the real gap between two states, which is what a game's
 * animations were built to fit — but a player thinking for half a minute is
 * not worth watching again, and a burst of states a few milliseconds apart
 * would flash past unseen.
 */
export const REPLAY_HOLD = { min: 180, max: 2400 } as const

/**
 * How long playback stays on `index` before moving to the next state: the gap
 * the room actually left between them, clamped to `REPLAY_HOLD`, at `speed`.
 * A game's replay view finishes its animation into `index` within this.
 */
export function replayHoldMs(states: readonly ReplayFrame[], index: number, speed: number): number {
  const here = states[index],
    next = states[index + 1]
  const gap = here && next ? next.at - here.at : REPLAY_HOLD.max
  return Math.min(REPLAY_HOLD.max, Math.max(REPLAY_HOLD.min, gap)) / speed
}

/** `m:ss`, or `h:mm:ss` past the hour. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000)),
    hours = Math.floor(total / 3600),
    minutes = Math.floor((total % 3600) / 60),
    seconds = String(total % 60).padStart(2, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

/**
 * Where the scrubber puts its marks: every index whose turn differs from the
 * one before it, by the game's own `turnOf` — or every index, without one.
 * The first state always starts a turn.
 */
export function turnMarks(states: readonly ReplayFrame[], turnOf?: (state: unknown) => unknown): number[] {
  if (!turnOf) return states.map((_, index) => index)
  const marks: number[] = []
  let previous: unknown = Symbol('none')
  states.forEach((frame, index) => {
    const turn = turnOf(frame.state)
    if (index === 0 || !Object.is(turn, previous)) marks.push(index)
    previous = turn
  })
  return marks
}

/** How long a replay has left before its room forgets it, in words, or null once it is due. */
export function expiryLeft(expiresAt: number, now: number): string | null {
  const left = expiresAt - now
  if (left <= 0) return null
  const hours = Math.floor(left / 3_600_000)
  if (hours >= 1) return `about ${hours} hour${hours === 1 ? '' : 's'}`
  const minutes = Math.max(1, Math.floor(left / 60_000))
  return `${minutes} minute${minutes === 1 ? '' : 's'}`
}
