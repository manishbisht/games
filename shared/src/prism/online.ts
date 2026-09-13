import type { Color } from './types'

/**
 * The engine's commands with the `player` taken off: who is acting is the seat
 * the message arrived on, which the server fills in (see `./adapter`). A browser
 * that names a player index is simply not believed.
 *
 * `call` and `catch` are deliberately not turn-bound — the call window belongs
 * to whoever spots it first, which is the one genuine race at this table.
 */
export type PrismOnlineAction =
  | { kind: 'play'; cardId: string; color?: Color }
  | { kind: 'draw' }
  | { kind: 'pass' }
  | { kind: 'call' }
  /** The player index being caught out for not calling, as the engine numbers them. */
  | { kind: 'catch'; target: number }
