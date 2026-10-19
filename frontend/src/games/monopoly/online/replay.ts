import type { GameState } from '@games/shared/estate/types'
import type { ReplayFrame } from '@games/shared/protocol'
import { replayHoldMs } from '../../../online/replayTiming'

/**
 * Roughly how long the board takes to tell the story into a state that a
 * person, not the room's clock, moved the table on to: the coins crossing
 * the board, a deed changing hands, a token sent to jail.
 */
export const PRESENT_MS = 1100
/** The winner's spotlight and confetti, which the last state of a game plays. */
export const CELEBRATION_MS = 1700
/** The share of a state's time on screen its story may take, so it lands before the next state does. */
export const FIT = 0.85

/**
 * How long the board's story into `states[index]` runs at the room's own pace.
 *
 * A roll and a card's walk are the two beats the room holds on its own clock
 * (`ESTATE_PACING`): it waited exactly as long as the dice and the walk take
 * before moving on, so the gap it left to the next state is that story's
 * length. Anything else was moved on by a player, whose thinking time says
 * nothing about how long the board needs.
 */
export function storyMs(states: readonly ReplayFrame<GameState>[], index: number): number {
  const here = states[index],
    next = states[index + 1]
  if (!here || index === 0) return 0
  const { phase, stepsRemaining, status } = here.state
  if (next && (phase === 'rolling' || (phase === 'moving' && stepsRemaining > 0))) return next.at - here.at
  return status === 'finished' ? CELEBRATION_MS : PRESENT_MS
}

/**
 * The rate the board plays the story into `states[index]` at: the player
 * bar's `speed`, or faster when that story would otherwise run past the time
 * the state stays on screen (`replayHoldMs`, which caps a long roll's beat).
 */
export function replayPace(states: readonly ReplayFrame<GameState>[], index: number, speed: number): number {
  const hold = replayHoldMs(states, index, speed)
  return Math.max(speed, storyMs(states, index) / (hold * FIT))
}
