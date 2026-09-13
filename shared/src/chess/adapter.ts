import type { GameAdapter } from '../online/adapter'
import type { SeatId } from '../protocol/types'
import { createGame, playMove, resign } from './engine'
import type { ChessAction, Color, GameState, PromotionPiece } from './types'

const SEATS: SeatId[] = ['w', 'b']
const PROMOTIONS: PromotionPiece[] = ['q', 'r', 'b', 'n']

/**
 * `GameOptions` has no online-shaped variant, so an online game borrows the
 * local one: white is nominally "the human", the difficulty is inert (no AI
 * ever runs on a server game) and there is no clock. Left as-is deliberately —
 * reshaping `GameOptions` would churn every local and AI code path too.
 */
const ONLINE_OPTIONS = { mode: 'online', human: 'w', difficulty: 'medium', clock: 0 } as const

/** Seats are `'w' | 'b'`, which the room only ever sources from `seatIds()`. */
const color = (seat: SeatId): Color => seat as Color

export const chessAdapter: GameAdapter<GameState, ChessAction> = {
  id: 'chess',
  minSeats: 2,
  maxSeats: 2,
  requireFull: true,
  seatIds: () => [...SEATS],
  validateOptions: () => ({}),

  validateAction(raw) {
    if (!raw || typeof raw !== 'object') return null
    const action = raw as { kind?: unknown; from?: unknown; to?: unknown; promotion?: unknown }
    if (action.kind === 'resign') return { kind: 'resign' }
    if (action.kind !== 'move') return null
    if (typeof action.from !== 'string' || typeof action.to !== 'string') return null
    if (action.promotion !== undefined && !PROMOTIONS.includes(action.promotion as PromotionPiece))
      return null
    return {
      kind: 'move',
      from: action.from,
      to: action.to,
      ...(action.promotion ? { promotion: action.promotion as PromotionPiece } : {}),
    }
  },

  create: (_seats, _options, ctx) => createGame(ONLINE_OPTIONS, undefined, ctx.now),

  apply(state, seat, _seats, action, ctx) {
    if (action.kind === 'resign') return { state: resign(state, ctx.now, color(seat)) }
    if (state.turn !== color(seat)) return { error: 'NOT_YOUR_TURN', message: 'It is not your turn.' }
    const next = playMove(state, action.from, action.to, action.promotion, ctx.now)
    // `playMove` refuses by handing back a game with no new move on it. A
    // pending promotion is the one refusal the player can fix themselves.
    if (next.history.length === state.history.length)
      return next.promotion
        ? { error: 'PROMOTION_REQUIRED', message: 'Choose a piece to promote to.' }
        : { error: 'ILLEGAL_MOVE', message: 'That move is not legal.' }
    return { state: next }
  },

  /** Chess has no timed presentation phases: every state waits on a person. */
  pending: () => null,
  /** Both players see the whole board. */
  view: (state) => state,
  isFinished: (state) => state.status !== 'playing',
  waitingOn: (state) => (state.status === 'playing' ? [state.turn] : []),

  /**
   * Nobody stands in for an absent player at a chessboard, so the claim is
   * settled the way the player would have: their seat resigns.
   */
  resolveAbsent: (state, seat, _seats, ctx) => resign(state, ctx.now, color(seat)),

  /** Chess bots land in a later round; see the online-bots design. */
  bots: null,

  rematch: (_prev, _seats, _options, ctx) => ({
    state: createGame(ONLINE_OPTIONS, undefined, ctx.now),
    seatRemap: { w: 'b', b: 'w' },
  }),
}
