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
