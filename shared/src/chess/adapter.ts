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

/**
 * The same game carried by a shorter line, for the engine to replay: the line
 * restarts from the position after the last capture or one-step pawn move, and
 * keeps only the moves since.
 *
 * The engine rebuilds the board by replaying every move from `initialFen` — on
 * each move and each bot decision — so a long game cost a room more per move
 * the longer it went. Nothing before an irreversible move can ever be on the
 * board again, so dropping it changes no repetition count, and the FEN carries
 * the castling rights, fifty-move clock and move number: the shorter replay
 * reaches the same position with the same counts, and plays out move for move
 * the same. (Not after a two-step pawn move: its FEN may leave out an en
 * passant square chess.js still counts in a position's identity.) Bounded by
 * the fifty-move rule, so a move costs the same at ply 200 as at ply 20.
 */
function recentLine(state: GameState): GameState {
  for (let cut = state.history.length; cut > 0; cut--) {
    const { after, flags } = state.history[cut - 1]
    const fields = typeof after === 'string' ? after.split(' ') : []
    if (fields.length !== 6) return state
    if (fields[4] === '0' && !flags.includes('b'))
      return { ...state, initialFen: after, history: state.history.slice(cut) }
  }
  return state
}

/** `next`, played from `recentLine(state)`, put back onto the whole line. */
function wholeLine(state: GameState, line: GameState, next: GameState): GameState {
  if (line === state) return next
  return {
    ...next,
    initialFen: state.initialFen,
    history: [...state.history, ...next.history.slice(line.history.length)],
  }
}

/** A move by the clock's rules: free until both sides have moved, flagged if it came too late. */
function timedMove(
  state: GameState,
  from: string,
  to: string,
  promotion: PromotionPiece | undefined,
  now: number,
) {
  const line = recentLine(started(state) ? state : { ...state, clockAt: now })
  return wholeLine(state, line, playMove(line, from, to, promotion, now))
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
      const move = chooseMove(recentLine(state), skill as Difficulty, ctx.random)
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
