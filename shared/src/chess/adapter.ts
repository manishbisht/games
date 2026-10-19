import { botName } from '../online/bots'
import type { GameAdapter } from '../online/adapter'
import type { SeatId } from '../protocol/types'
import { chooseMove } from './ai'
import { clockStarted, createGame, playMove, resign, tickClock } from './engine'
import { TIME_CONTROLS } from './types'
import type { ChessAction, Color, Difficulty, GameState, PromotionPiece, TimeControlId } from './types'

const SEATS: SeatId[] = ['w', 'b']
const PROMOTIONS: PromotionPiece[] = ['q', 'r', 'b', 'n']

/**
 * `GameOptions` has no online-shaped variant, so an online game borrows the
 * local one: white is nominally "the human" and the difficulty is inert (no AI
 * ever runs on a server game). Left as-is deliberately — reshaping
 * `GameOptions` would churn every local and AI code path too. The clock is the
 * room's: whatever time control it was created with.
 */
const ONLINE_OPTIONS = { mode: 'online', human: 'w', difficulty: 'medium', clock: 0 } as const

/** Seats are `'w' | 'b'`, which the room only ever sources from `seatIds()`. */
const color = (seat: SeatId): Color => seat as Color

/** Room options as `validateOptions` left them: a known time control, or nothing (untimed). */
interface ChessOptions {
  timeControl?: TimeControlId
}

function fresh(options: unknown, now: number): GameState {
  const control = TIME_CONTROLS.find((c) => c.id === (options as ChessOptions | null)?.timeControl)
  return createGame(
    { ...ONLINE_OPTIONS, clock: control?.minutes ?? 0, increment: control?.increment ?? 0 },
    undefined,
    now,
  )
}

/**
 * Both clocks wait for each side's first move (`clockStarted`) — and, the
 * reason it matters here, so a bot's colour is known before a clock ever runs
 * (see `pending`).
 */
const started = clockStarted

/** A move by the clock's rules: free until both sides have moved, flagged if it came too late. */
function timedMove(
  state: GameState,
  from: string,
  to: string,
  promotion: PromotionPiece | undefined,
  now: number,
) {
  return playMove(started(state) ? state : { ...state, clockAt: now }, from, to, promotion, now)
}

export const chessAdapter: GameAdapter<GameState, ChessAction> = {
  id: 'chess',
  minSeats: 2,
  maxSeats: 2,
  requireFull: true,
  seatIds: () => [...SEATS],
  validateOptions(raw): ChessOptions {
    const id = (raw as ChessOptions | null)?.timeControl
    return id !== 'none' && TIME_CONTROLS.some((c) => c.id === id) ? { timeControl: id } : {}
  },

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

  create: (_seats, options, ctx) => fresh(options, ctx.now),

  apply(state, seat, _seats, action, ctx) {
    if (action.kind === 'resign')
      return { state: resign(started(state) ? state : { ...state, clockAt: ctx.now }, ctx.now, color(seat)) }
    if (state.turn !== color(seat)) return { error: 'NOT_YOUR_TURN', message: 'It is not your turn.' }
    const next = timedMove(state, action.from, action.to, action.promotion, ctx.now)
    // A move that arrives after its clock ran out is the flag falling, a beat
    // before the room's own timer would have said so.
    if (next.status === 'timeout') return { state: next }
    // `playMove` refuses by handing back a game with no new move on it. A
    // pending promotion is the one refusal the player can fix themselves.
    if (next.history.length === state.history.length)
      return next.promotion
        ? { error: 'PROMOTION_REQUIRED', message: 'Choose a piece to promote to.' }
        : { error: 'ILLEGAL_MOVE', message: 'That move is not legal.' }
    return { state: next }
  },

  /**
   * Chess has no presentation phases; the one thing it times is the clock. While
   * a person's clock runs, the room holds a deadline at the moment it would run
   * out, and the flag falls there unless a move stops it first.
   *
   * Never on a bot's turn. A pending deadline takes the room's one timer, which
   * is also the timer that plays a bot — so a bot's turn held here would never
   * be played, and the bot would lose on time without having moved. A bot is
   * learned from its first move (`decide` notes its colour) and both clocks
   * wait for both first moves, so by the time a clock runs the bot is known.
   * Its clock still runs: it is charged for its real thinking time on the move.
   */
  pending(state) {
    if (!state.options.clock || state.status !== 'playing' || !started(state)) return null
    if (state.bots?.includes(state.turn)) return null
    return { afterMs: state.clocks[state.turn], resolve: (s, ctx) => tickClock(s, ctx.now) }
  },
  /** Both players see the whole board. */
  view: (state) => state,
  isFinished: (state) => state.status !== 'playing',
  waitingOn: (state) => (state.status === 'playing' ? [state.turn] : []),

  /**
   * Nobody stands in for an absent player at a chessboard, so the claim is
   * settled the way the player would have: their seat resigns.
   */
  resolveAbsent: (state, seat, _seats, ctx) => resign(state, ctx.now, color(seat)),

  /**
   * A seat the room plays. Unlike `resolveAbsent` above this one plays on: a
   * person who walked out of a chess game is done with it, but a bot has no
   * reason to resign a position it is winning.
   *
   * `thinkMs` is zero because the search is itself the pause — it is the one
   * game here where a bot's turn costs real time rather than being held back
   * to look like it did.
   */
  bots: {
    skills: ['easy', 'medium'],
    name: (_seat, index) => botName(index),
    thinkMs: () => 0,
    decide(state, seat, _seats, skill, ctx) {
      if (state.status !== 'playing' || state.turn !== color(seat)) return state
      const move = chooseMove(state, skill as Difficulty, ctx.random)
      if (!move) return state
      // Through the engine, not `apply`: this is the room moving a piece, not a
      // seat asking whether it may.
      const played = timedMove(
        state,
        move.from,
        move.to,
        move.promotion as PromotionPiece | undefined,
        ctx.now,
      )
      const bots = state.bots ?? []
      return bots.includes(state.turn) ? played : { ...played, bots: [...bots, state.turn] }
    },
  },

  rematch: (_prev, _seats, options, ctx) => ({
    state: fresh(options, ctx.now),
    seatRemap: { w: 'b', b: 'w' },
  }),
}
