import type { Ctx, GameAdapter, OnlineSeat } from '../online/adapter'
import type { ErrorCode, SeatId } from '../protocol/types'
import { chooseMove } from './ai'
import { act, createGame } from './engine'
import type { PrismOnlineAction } from './online'
import { COLORS } from './types'
import type { Card, Color, Command, GameState, Player } from './types'

/** How well a seat is played while its owner is away — the middle of the AI's three. */
const STAND_IN_SKILL = 'medium'

/**
 * The face every hidden card wears. It is shape-valid so anything that walks a
 * hand keeps working, and identical for every hidden card so its face carries
 * nothing: what a redacted card tells you is that it exists, and no more.
 */
const HIDDEN_FACE = {
  type: 'number',
  color: 'red',
  value: 0,
  isWild: false,
  visual: { symbol: '✦', label: 'Hidden' },
} as const satisfies Omit<Card, 'id'>

/**
 * Deck ids are handed out in build order (`prism-0`, `prism-1`, …), so an id is
 * itself a card's identity — a redacted card must never carry its own. These
 * synthetic ids say only where the card sits, which is public anyway.
 */
const hidden = (id: string): Card => ({ id, ...HIDDEN_FACE })

/**
 * The room compacts its seats onto `seatIds(headcount)` before the first move,
 * so from `create` onwards seat `p<i>` is simply `state.players[i]`. `view` is
 * handed a seat without the seat list, which is why the index is read off the id.
 */
function seatIndex(seat: SeatId | null): number {
  const match = seat === null ? null : /^p(\d+)$/.exec(seat)
  return match ? Number(match[1]) : -1
}

const table = (seats: OnlineSeat[], ctx: Ctx, round = 1, totals: number[] = []) =>
  createGame(
    seats.map((seat) => ({ name: seat.name, kind: 'human' as const })),
    {},
    ctx.random,
    round,
    totals,
  )

/** The engine's own command, with the seat the message arrived on filled in. */
function command(action: PrismOnlineAction, player: number): Command {
  if (action.kind === 'play')
    return { type: 'play', player, cardId: action.cardId, ...(action.color ? { color: action.color } : {}) }
  if (action.kind === 'catch') return { type: 'catch', player, target: action.target }
  return { type: action.kind, player }
}

/**
 * Why the engine handed the state straight back. It refuses silently and for one
 * reason at a time, so the closest honest answer is read off the action itself:
 * `call` and `catch` are open to every seat, and the rest are the turn-holder's.
 */
function refusal(action: PrismOnlineAction, state: GameState, player: number): [ErrorCode, string] {
  if (action.kind === 'call') return ['NOT_ALLOWED', 'There is nothing to call just now.']
  if (action.kind === 'catch') return ['NOT_ALLOWED', 'There is nobody to catch just now.']
  if (state.currentPlayer !== player) return ['NOT_YOUR_TURN', 'It is not your turn.']
  if (action.kind === 'draw') return ['ILLEGAL_MOVE', 'Play the card you drew, or keep it and pass.']
  if (action.kind === 'pass') return ['ILLEGAL_MOVE', 'There is no drawn card to keep.']
  return ['ILLEGAL_MOVE', 'That card does not go there.']
}

export const prismAdapter: GameAdapter<GameState, PrismOnlineAction> = {
  id: 'prism',
  minSeats: 2,
  maxSeats: 4,
  /** Two to four can play, so a table starts with whoever actually turned up. */
  requireFull: false,
  seatIds: (count) => Array.from({ length: count }, (_, index) => `p${index}`),
  /** Classic rules, every table: nothing about the deal is the caller's to choose. */
  validateOptions: () => ({}),

  validateAction(raw) {
    if (!raw || typeof raw !== 'object') return null
    const action = raw as { kind?: unknown; cardId?: unknown; color?: unknown; target?: unknown }
    if (action.kind === 'draw' || action.kind === 'pass' || action.kind === 'call')
      return { kind: action.kind }
    if (action.kind === 'play') {
      if (typeof action.cardId !== 'string') return null
      // A colour only means something on a wild, and the engine says which; an
      // extra one here is harmless, a malformed one is not.
      if (action.color !== undefined && !COLORS.includes(action.color as Color)) return null
      return {
        kind: 'play',
        cardId: action.cardId,
        ...(action.color ? { color: action.color as Color } : {}),
      }
    }
    if (action.kind === 'catch')
      return Number.isInteger(action.target) ? { kind: 'catch', target: action.target as number } : null
    return null
  },

  /** The shuffle happens here, on the server: no browser ever sees the deck built. */
  create: (seats, _options, ctx) => table(seats, ctx),

  /**
   * The engine is the authority on legality — it already refuses every illegal
   * command by handing the state back untouched — so this injects the seat's
   * player index and reads the refusal, rather than second-guessing the rules.
   */
  apply(state, seat, seats, action, ctx) {
    if (state.status !== 'playing') return { error: 'NOT_PLAYING', message: 'The round is already over.' }
    const player = seats.indexOf(seat)
    if (player < 0 || !state.players[player])
      return { error: 'NOT_ALLOWED', message: 'That seat is not at this table.' }
    const next = act(state, command(action, player), ctx.random)
    if (next !== state) return { state: next }
    const [error, message] = refusal(action, state, player)
    return { error, message }
  },

  /** Nothing at this table is presentation: every state waits on a person. */
  pending: () => null,

  /**
   * The one adapter with something to hide. Every card a seat may not see leaves
   * as a placeholder that keeps its slot and loses its identity, so counts, the
   * pile's depth and the whole public table survive the redaction intact.
   *
   * Zones, one by one: hands other than the viewer's, the draw pile (hidden from
   * everyone, always), the drawn-but-unplayed card of another seat, and the
   * played card an event carries — public while it sits on the discard, but the
   * same card again once a reshuffle folds the discard back into the pile.
   * Everything else — discard, active colour, penalties, the call window, scores,
   * hand counts, event text — is what the table can see across the felt.
   */
  view(state, seat) {
    const viewer = seatIndex(seat)
    const secret = new Set<string>()
    const players: Player[] = state.players.map((player, index) =>
      index === viewer
        ? player
        : {
            ...player,
            hand: player.hand.map((card, slot) => {
              secret.add(card.id)
              return hidden(`hidden-${index}-${slot}`)
            }),
          },
    )
    const drawPile = state.drawPile.map((card, index) => {
      secret.add(card.id)
      return hidden(`hidden-pile-${index}`)
    })
    return {
      ...state,
      players,
      drawPile,
      events: state.events.map((event) =>
        event.card && secret.has(event.card.id)
          ? { ...event, card: hidden(`hidden-event-${event.id}`) }
          : event,
      ),
      // Only the seat that drew it may know which card it was — for everyone
      // else the fact that a card was drawn is already in the event log.
      drawnCardId: state.currentPlayer === viewer ? state.drawnCardId : null,
    }
  },

  isFinished: (state) => state.status !== 'playing',

  /**
   * The seat the round cannot go on without. A call or a catch may come from any
   * seat, but nothing waits on one: the window closes by itself when the next
   * action lands, so the table is only ever blocked on the player on turn.
   */
  waitingOn: (state, seats) => (state.status === 'playing' ? [seats[state.currentPlayer]] : []),

  /**
   * There is no forfeiting a hand of cards — a player who leaves gets played
   * for, one decision at a time, until they come back. The room calls this again
   * on each of their turns, so a single decision is all it settles.
   */
  resolveAbsent(state, seat, seats, ctx) {
    // Any other seat has nothing outstanding; being away is not itself a move.
    if (state.status !== 'playing' || seats[state.currentPlayer] !== seat) return state
    return act(state, chooseMove(state, STAND_IN_SKILL, ctx.random), ctx.random)
  },

  /**
   * Prism is played in rounds, not games: a rematch deals the next one and the
   * running totals come with it. Same seats, same order — the deal rotates by
   * itself, so there is no advantage in a seat worth swapping.
   */
  rematch: (prev, seats, _options, ctx) => ({
    state: table(
      seats,
      ctx,
      prev.round + 1,
      prev.players.map((player) => player.totalScore),
    ),
  }),
}
