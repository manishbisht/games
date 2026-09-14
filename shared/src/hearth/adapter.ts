import type { Ctx, GameAdapter, OnlineSeat } from '../online/adapter'
import { botName } from '../online/bots'
import type { SeatId } from '../protocol/types'
import { chooseAIMove } from './ai'
import { createGame, gameReducer, motionDuration, phasePause } from './engine'
import type { HearthOnlineAction } from './online'
import type { Control, GameState, Mode, Rules } from './types'

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

/**
 * The table's own settings, narrowed one field at a time. Spreading whatever
 * arrived would let a browser hand `createGame` keys it never meant to offer —
 * `controls`, `names` — so every field a room may choose is listed here and
 * nothing else survives the crossing.
 */
export interface HearthOptions {
  mode: Mode
  rules?: Partial<Rules>
}

const MODES: Mode[] = ['classic', 'quick', 'custom']

const modeOf = (raw: unknown): Mode =>
  MODES.find((mode) => mode === (raw as { mode?: unknown })?.mode) ?? 'classic'

const boolOf = (value: unknown): boolean | undefined => (typeof value === 'boolean' ? value : undefined)

/**
 * `createGame` clamps the piece count itself, but a non-number would reach it
 * as `NaN` and take the whole rule set with it, so it is checked here too.
 */
const piecesOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.min(4, Math.max(1, Math.trunc(value)))
    : undefined

function rulesOf(raw: unknown): Partial<Rules> | undefined {
  const source = (raw as { rules?: unknown })?.rules
  if (!source || typeof source !== 'object') return undefined
  const from = source as Record<string, unknown>
  const rules: Partial<Rules> = {}
  const pieces = piecesOf(from.piecesPerPlayer)
  if (pieces !== undefined) rules.piecesPerPlayer = pieces
  for (const key of ['extraTurnOnSix', 'safeSpaces', 'captures', 'exactHome'] as const) {
    const value = boolOf(from[key])
    if (value !== undefined) rules[key] = value
  }
  return Object.keys(rules).length ? rules : undefined
}

function optionsOf(raw: unknown): HearthOptions {
  const mode = modeOf(raw)
  // Only a custom table carries rules; classic and quick are the rules.
  const rules = mode === 'custom' ? rulesOf(raw) : undefined
  return rules ? { mode, rules } : { mode }
}

const table = (seats: OnlineSeat[], options: unknown) => {
  const { mode, rules } = optionsOf(options)
  return createGame({
    playerCount: seats.length,
    names: seats.map((seat) => seat.name),
    mode,
    rules,
  })
}

export const hearthAdapter: GameAdapter<GameState, HearthOnlineAction> = {
  id: 'hearth',
  minSeats: 2,
  maxSeats: 4,
  /** Two to four can play, so a table starts with whoever actually turned up. */
  requireFull: false,
  seatIds: (count) => Array.from({ length: count }, (_, index) => `p${index}`),
  /** Room options narrowed to the table settings this game actually offers. */
  validateOptions: (raw) => optionsOf(raw),

  validateAction(raw) {
    if (!raw || typeof raw !== 'object') return null
    const action = raw as { kind?: unknown; pieceId?: unknown }
    if (action.kind === 'roll') return { kind: 'roll' }
    if (action.kind !== 'move' || typeof action.pieceId !== 'string') return null
    return { kind: 'move', pieceId: action.pieceId }
  },

  create: (seats, options) => table(seats, options),

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
   * for, one decision at a time, until they come back.
   */
  resolveAbsent: (state, seat, seats, ctx) =>
    hearthAdapter.bots!.decide(state, seat, seats, STAND_IN_SKILL, ctx),

  /**
   * A seat the room plays. Same decisions a person makes — roll, then choose a
   * piece — which is why `resolveAbsent` below is now just this at a fixed skill.
   */
  bots: {
    skills: ['easy', 'medium', 'hard'],
    name: (_seat, index) => botName(index),
    decide(state, seat, seats, skill, ctx) {
      if (state.phase === 'won' || seatedPlayer(state, seats) !== seat) return state
      if (state.phase === 'roll') return gameReducer(state, { type: 'ROLL_START' })
      if (state.phase !== 'choose') return state
      const move = chooseAIMove(state, skill as Control, ctx.random())
      return move ? gameReducer(state, { type: 'MOVE', pieceId: move.pieceId }) : state
    },
  },

  /** Same table, same colours: a Ludo seat carries no advantage worth rotating. */
  rematch: (_prev, seats, options) => ({ state: table(seats, options) }),
}
