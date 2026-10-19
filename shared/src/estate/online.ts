import type { Trade } from './types'

/**
 * The decisions a seat makes over the wire: the engine's `GameAction` union
 * minus the two kinds of action no client may send.
 *
 * `START` is lifecycle — the room builds the table in `create`, with a seed of
 * its own, and a client that could send it would be choosing the dice. The rest
 * — `DICE_SETTLED`, `MOVE_STEP`, `RESOLVE` — are presentation: locally the page
 * schedules them on `setTimeout`s to pace a turn, and online the server holds
 * that pacing for the whole table (see `./adapter`'s `pending`).
 *
 * Kept as a union of its own rather than an `Exclude<GameAction, …>` so that a
 * new engine action has to be let onto the wire deliberately.
 */
export type EstateOnlineAction =
  | {
      type:
        | 'ROLL'
        | 'BUY'
        | 'PASS'
        | 'END_TURN'
        | 'ACK_CARD'
        | 'PAY_JAIL'
        | 'LIQUIDATE'
        | 'BANKRUPT'
        | 'ACCEPT_TRADE'
        | 'REJECT_TRADE'
    }
  | { type: 'BUILD' | 'SELL_BUILDING' | 'MORTGAGE' | 'UNMORTGAGE'; property: number }
  | { type: 'PROPOSE_TRADE'; trade: Trade }

/** Room options for an estate table. The economy is the host's one choice. */
export interface EstateOptions {
  mode: 'classic' | 'quick'
}

/**
 * How long the room holds each beat of a turn: a thrown die for
 * `DICE_SETTLE_MS`, then `STEP_MS` a square and `LANDING_MS` to settle on the
 * last, with `MOTION_GRACE_MS` of slack so the last step lands rather than cuts.
 * The board reads it too, to place a walk it joins halfway through.
 */
export const ESTATE_PACING = {
  DICE_SETTLE_MS: 1200,
  STEP_MS: 215,
  LANDING_MS: 330,
  MOTION_GRACE_MS: 300,
} as const
