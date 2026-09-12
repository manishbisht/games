import type { Ctx, GameAdapter, OnlineSeat } from '../online/adapter'
import type { SeatId } from '../protocol/types'
import { chooseAIMove } from './ai'
import { createGame, gameReducer, motionDuration, phasePause } from './engine'
import type { HearthOnlineAction } from './online'
import type { GameState } from './types'

/** A beat of slack after the board's animation so the last step lands, not cuts. */
const MOTION_GRACE_MS = 300
/** How well a seat is played while its owner is away — the middle of the AI's three. */
const STAND_IN_SKILL = 'medium'

/**
 * `random()` is `[0, 1)`, so the clamp is only insurance against an injected
 * source that isn't: `ROLL_RESULT` ignores a value outside 1–6, which would
 * leave the game stuck in `rolling` with an alarm to match.
 */
const rollDie = (ctx: Ctx) => Math.min(6, Math.max(1, Math.floor(ctx.random() * 6) + 1))

/**
 * The room compacts its seats onto `seatIds(headcount)` before the first move,
 * so from `create` onwards seat `p<i>` is simply `state.players[i]`.
 */
const seatedPlayer = (state: GameState, seats: SeatId[]) => seats[state.currentPlayer]

const table = (seats: OnlineSeat[]) =>
  createGame({ playerCount: seats.length, names: seats.map((seat) => seat.name) })

export const hearthAdapter: GameAdapter<GameState, HearthOnlineAction> = {
  id: 'hearth',
  minSeats: 2,
  maxSeats: 4,
  /** Two to four can play, so a table starts with whoever actually turned up. */
  requireFull: false,
  seatIds: (count) => Array.from({ length: count }, (_, index) => `p${index}`),
  validateOptions: () => ({}),

  validateAction(raw) {
    if (!raw || typeof raw !== 'object') return null
    const action = raw as { kind?: unknown; pieceId?: unknown }
    if (action.kind === 'roll') return { kind: 'roll' }
    if (action.kind !== 'move' || typeof action.pieceId !== 'string') return null
    return { kind: 'move', pieceId: action.pieceId }
  },

  create: (seats) => table(seats),

  apply(state, seat, seats, action) {
    if (state.phase === 'won') return { error: 'NOT_PLAYING', message: 'The game is already won.' }
    if (seatedPlayer(state, seats) !== seat)
      return { error: 'NOT_YOUR_TURN', message: 'It is not your turn.' }
    if (action.kind === 'roll') {
      if (state.phase !== 'roll')
        return { error: 'NOT_ALLOWED', message: 'The dice are not waiting on you right now.' }
      return { state: gameReducer(state, { type: 'ROLL_START' }) }
    }
    if (state.phase !== 'choose')
      return { error: 'NOT_ALLOWED', message: 'There is no piece to move right now.' }
    // Every move the engine will accept is already listed, so this is the whole
    // legality check — `MOVE` would otherwise refuse by handing the state back.
    if (!state.legalMoves.some((move) => move.pieceId === action.pieceId))
      return { error: 'ILLEGAL_MOVE', message: 'That piece cannot make that move.' }
    return { state: gameReducer(state, { type: 'MOVE', pieceId: action.pieceId }) }
  },

  /**
   * The pacing core. Three of the six phases are pure presentation, and online
   * the server rather than each browser holds them — so the die lands on one
   * number for everyone, at one moment, at the speed the local table plays.
   */
  pending(state) {
    if (state.phase === 'rolling')
      return {
        afterMs: phasePause('rolling', false),
        resolve: (current, ctx) => gameReducer(current, { type: 'ROLL_RESULT', value: rollDie(ctx) }),
      }
    if (state.phase === 'moving')
      return {
        afterMs: motionDuration(state, false) + MOTION_GRACE_MS,
        resolve: (current) => gameReducer(current, { type: 'ANIMATION_DONE' }),
      }
    if (state.phase === 'pass')
      return {
        afterMs: phasePause('pass', false),
        resolve: (current) => gameReducer(current, { type: 'NEXT_TURN' }),
      }
    // `roll` and `choose` wait on a person; `won` waits on nobody.
    return null
  },

  /** Ludo is perfect information: every seat sees the same table. */
  view: (state) => state,
  isFinished: (state) => state.phase === 'won',

  waitingOn(state, seats) {
    const seat = state.phase === 'won' ? undefined : seatedPlayer(state, seats)
    return seat ? [seat] : []
  },

  /**
   * There is no resigning from a race — a player who leaves simply gets played
   * for, one decision at a time, until they come back. The room calls this again
   * on each of their turns, so a single pending decision is all it settles.
   */
  resolveAbsent(state, seat, seats, ctx) {
    // Any other seat has nothing outstanding; being away is not itself a move.
    if (state.phase === 'won' || seatedPlayer(state, seats) !== seat) return state
    if (state.phase === 'roll') return gameReducer(state, { type: 'ROLL_START' })
    if (state.phase !== 'choose') return state
    const move = chooseAIMove(state, STAND_IN_SKILL, ctx.random())
    return move ? gameReducer(state, { type: 'MOVE', pieceId: move.pieceId }) : state
  },

  /** Same table, same colours: a Ludo seat carries no advantage worth rotating. */
  rematch: (_prev, seats) => ({ state: table(seats) }),
}
