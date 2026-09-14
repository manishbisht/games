import type { Ctx, GameAdapter, OnlineSeat } from '../online/adapter'
import { botName } from '../online/bots'
import type { SeatId } from '../protocol/types'
import { createGame, gameReducer } from './engine'
import type { WildriseOnlineAction } from './online'
import { phaseDuration } from './timing'
import type { GameState } from './types'

/** A beat of slack after the board's animation so the last step lands, not cuts. */
const MOTION_GRACE_MS = 300

/**
 * `random()` is `[0, 1)`, so the clamp is only insurance against an injected
 * source that isn't: `ROLL` ignores a value outside 1–6, which would leave the
 * table sitting in `ready` with no beat for the alarm to carry.
 */
const rollDie = (ctx: Ctx) => Math.min(6, Math.max(1, Math.floor(ctx.random() * 6) + 1))

/**
 * The room compacts its seats onto `seatIds(headcount)` before the first roll,
 * so from `create` onwards seat `p<i>` is simply `state.players[i]`.
 */
const seatedPlayer = (state: GameState, seats: SeatId[]) => seats[state.currentPlayer]

/**
 * The one thing a table may decide. The board's shape — how many snakes, where
 * they start — is the board's, so it is not on offer; whether the last square
 * has to be landed on exactly is the one rule players actually argue about.
 */
export interface WildriseOptions {
  exactFinish?: boolean
}

const optionsOf = (raw: unknown): WildriseOptions => {
  const exactFinish = (raw as { exactFinish?: unknown })?.exactFinish
  return typeof exactFinish === 'boolean' ? { exactFinish } : {}
}

const table = (seats: OnlineSeat[], options: unknown, ctx: Ctx) => {
  const { exactFinish } = optionsOf(options)
  return createGame({
    playerCount: seats.length,
    names: seats.map((seat) => seat.name),
    firstPlayer: Math.floor(ctx.random() * seats.length),
    // Left out entirely when the table said nothing, so the board's own
    // default stands rather than being overwritten with `undefined`.
    ...(exactFinish === undefined ? {} : { rules: { exactFinish } }),
  })
}

export const wildriseAdapter: GameAdapter<GameState, WildriseOnlineAction> = {
  id: 'wildrise',
  minSeats: 2,
  maxSeats: 4,
  /** Two to four can play, so a table starts with whoever actually turned up. */
  requireFull: false,
  seatIds: (count) => Array.from({ length: count }, (_, index) => `p${index}`),
  /** The board is the board; only the finish rule is the table's to set. */
  validateOptions: (raw) => optionsOf(raw),

  validateAction(raw) {
    if (!raw || typeof raw !== 'object') return null
    return (raw as { kind?: unknown }).kind === 'roll' ? { kind: 'roll' } : null
  },

  create: (seats, options, ctx) => table(seats, options, ctx),

  /** The die is the server's to throw, so one number lands for the whole table. */
  apply(state, seat, seats, _action, ctx) {
    if (state.phase === 'won') return { error: 'NOT_PLAYING', message: 'The game is already won.' }
    if (seatedPlayer(state, seats) !== seat)
      return { error: 'NOT_YOUR_TURN', message: 'It is not your turn.' }
    if (state.phase !== 'ready')
      return { error: 'NOT_ALLOWED', message: 'The die is not waiting on you right now.' }
    return { state: gameReducer(state, { type: 'ROLL', value: rollDie(ctx) }) }
  },

  /**
   * The pacing core. Four of the six phases are pure presentation, and online
   * the server rather than each browser holds them — so the die lands on one
   * number for everyone, at one moment, at the speed the local table plays.
   */
  pending(state) {
    const beat = (type: 'DICE_SETTLED' | 'MOVE_DONE' | 'TRANSPORT_DONE' | 'NEXT_TURN', grace = 0) => ({
      afterMs: phaseDuration(state, false) + grace,
      resolve: (current: GameState) => gameReducer(current, { type }),
    })
    if (state.phase === 'rolling') return beat('DICE_SETTLED')
    if (state.phase === 'moving') return beat('MOVE_DONE', MOTION_GRACE_MS)
    if (state.phase === 'transporting') return beat('TRANSPORT_DONE')
    if (state.phase === 'settling') return beat('NEXT_TURN')
    // `ready` waits on a person; `won` waits on nobody.
    return null
  },

  /** A race up a shared board: every seat sees the same table. */
  view: (state) => state,
  isFinished: (state) => state.phase === 'won',

  waitingOn(state, seats) {
    const seat = state.phase === 'won' ? undefined : seatedPlayer(state, seats)
    return seat ? [seat] : []
  },

  /**
   * There is no resigning from a race, and only one decision in it — so a player
   * who leaves is simply rolled for, one turn at a time, until they come back.
   * Every other phase is already on the room's alarm, so a single roll is all
   * this ever has to settle.
   */
  resolveAbsent: (state, seat, seats, ctx) =>
    wildriseAdapter.bots!.decide(state, seat, seats, 'casual', ctx),

  /**
   * A seat the room plays. There is nothing to be good at on this board, so the
   * three "skills" are how quickly the companion takes its turn and no more.
   */
  bots: {
    skills: ['casual', 'fast', 'fun'],
    name: (_seat, index) => botName(index),
    thinkMs: (skill) => (skill === 'fast' ? 450 : skill === 'fun' ? 1100 : 900),
    decide(state, seat, seats, _skill, ctx) {
      if (state.phase !== 'ready' || seatedPlayer(state, seats) !== seat) return state
      return gameReducer(state, { type: 'ROLL', value: rollDie(ctx) })
    },
  },

  /** Same table, same colours: a seat in a race carries no advantage to rotate. */
  rematch: (_prev, seats, options, ctx) => ({ state: table(seats, options, ctx) }),
}
