import type { Ctx, GameAdapter, OnlineSeat } from '../online/adapter'
import { botName } from '../online/bots'
import type { ErrorCode } from '../protocol/types'
import { BOARD } from './board'
import { botAcceptsTrade, botAction, createGame, gameReducer } from './engine'
import type { EstateOnlineAction, EstateOptions } from './online'
import type { GameState, Trade } from './types'

/**
 * The local page's pacing, read off `MonopolyGame.tsx`: a spinning die is held
 * for `DICE_SETTLE_MS`, a token takes `STEP_MS` per square and `LANDING_MS` to
 * settle on the one it stops at. Online the server holds those beats for the
 * whole table, so a turn takes as long as it always did — but it resolves in a
 * single mutation on a single deadline rather than an alarm per square.
 */
const DICE_SETTLE_MS = 1200
const STEP_MS = 215
const LANDING_MS = 330
/** A beat of slack after the board's animation so the last step lands, not cuts. */
const MOTION_GRACE_MS = 300

/** How long a walk of `steps` squares is given before the room moves the game on. */
const walkMs = (steps: number) => steps * STEP_MS + LANDING_MS + MOTION_GRACE_MS

/**
 * How far this roll will actually carry the token. Only pacing depends on it —
 * the engine decides what really happens — so the two cases that cancel a move
 * outright are worth knowing about and the rest is the dice's total.
 */
function rollSteps(state: GameState): number {
  const player = state.players[state.current]
  const doubles = state.dice[0] === state.dice[1]
  // Jail: doubles walk out, a third failed attempt pays out, anything else stays.
  if (player.jailed) return doubles || player.jailTurns + 1 >= 3 ? state.dice[0] + state.dice[1] : 0
  // A third double in a row goes straight to jail instead of anywhere pleasant.
  if (doubles && state.doubles + 1 >= 3) return 0
  return state.dice[0] + state.dice[1]
}

/**
 * Every presentation step a roll owes the table, applied at once: the die is
 * read out, the token walks its squares, and the space it stopped on happens.
 * It ends on whatever the engine wants a person for — a purchase, a card, a
 * debt, or simply the end of the turn.
 */
function fastForward(state: GameState): GameState {
  let next = state.phase === 'rolling' ? gameReducer(state, { type: 'DICE_SETTLED' }) : state
  // The longest walk in the game is a card sending you all the way round.
  for (let step = 0; step <= BOARD.length; step++) {
    if (next.phase !== 'moving' || next.stepsRemaining <= 0) break
    next = gameReducer(next, { type: 'MOVE_STEP' })
  }
  return next.phase === 'moving' && next.stepsRemaining === 0 ? gameReducer(next, { type: 'RESOLVE' }) : next
}

/** A number that names a space on the board, and nothing else. */
const onBoard = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) < BOARD.length

/**
 * An offer, structurally. Whether it is an offer anyone would make — who owns
 * what, who can afford what, which groups are built on — is `validTrade`'s
 * business in the engine, which sees the state this one is checked against.
 */
function parseTrade(raw: unknown): Trade | null {
  if (!raw || typeof raw !== 'object') return null
  const trade = raw as Record<string, unknown>
  const seat = (value: unknown) => Number.isInteger(value) && (value as number) >= 0 && (value as number) < 4
  const cash = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0
  const deeds = (value: unknown): number[] | null =>
    Array.isArray(value) && value.length <= BOARD.length && value.every(onBoard) ? value : null
  const giveProperties = deeds(trade.giveProperties)
  const getProperties = deeds(trade.getProperties)
  if (!seat(trade.from) || !seat(trade.to) || !cash(trade.giveCash) || !cash(trade.getCash)) return null
  if (!giveProperties || !getProperties) return null
  // Rebuilt field by field: whatever else rode along on the wire stays there.
  return {
    from: trade.from as number,
    to: trade.to as number,
    giveCash: trade.giveCash as number,
    getCash: trade.getCash as number,
    giveProperties,
    getProperties,
  }
}

/**
 * Why the engine handed the state straight back. It refuses silently, so the
 * closest honest answer is read off the action — by this point the seat is
 * known to be allowed to try, which leaves the state of the game as the reason.
 */
function illegal(action: EstateOnlineAction): string {
  switch (action.type) {
    case 'ROLL':
      return 'The dice are not waiting on you right now.'
    case 'BUY':
      return 'That is not yours to buy right now.'
    case 'PASS':
      return 'There is nothing to pass on right now.'
    case 'END_TURN':
      return 'Your turn is not over yet.'
    case 'ACK_CARD':
      return 'There is no card waiting to be read.'
    case 'PAY_JAIL':
      return 'There is no release to pay for right now.'
    case 'LIQUIDATE':
    case 'BANKRUPT':
      return 'Nothing is owed right now.'
    case 'PROPOSE_TRADE':
      return 'That offer does not stand up.'
    case 'ACCEPT_TRADE':
      return 'That offer no longer stands up.'
    case 'REJECT_TRADE':
      return 'There is no offer to decline.'
    default:
      return 'That property cannot be managed right now.'
  }
}

const refuse = (error: ErrorCode, message: string) => ({ error, message })

/** The economy the host picked, narrowed to what `createGame` supports. */
const modeOf = (options: unknown): EstateOptions['mode'] =>
  (options as EstateOptions | null)?.mode === 'quick' ? 'quick' : 'classic'

/**
 * A fresh table for the seats that turned up, seeded on the server. The seed is
 * the entire future of the game — every die, every card — so it is derived from
 * `ctx.random` and never from anything a client sent.
 */
const table = (seats: OnlineSeat[], options: unknown, ctx: Ctx): GameState =>
  gameReducer(createGame(), {
    type: 'START',
    players: seats.map((seat) => ({ name: seat.name, isBot: false })),
    mode: modeOf(options),
    seed: Math.floor(ctx.random() * 0x100000000) >>> 0,
  })

/**
 * `botAction` only advises on a seat it believes belongs to a computer, and an
 * online table is all people. This asks it the same question about a seat that
 * has gone quiet; the answer is applied to the real state, which never changes.
 */
const asBot = (state: GameState, player: number): GameState => ({
  ...state,
  players: state.players.map((p, index) => (index === player ? { ...p, isBot: true } : p)),
})

/**
 * The room compacts its seats onto `seatIds(headcount)` before the first move,
 * so from `create` onwards seat `p<i>` is simply `state.players[i]`.
 */
export const estateAdapter: GameAdapter<GameState, EstateOnlineAction> = {
  id: 'estate',
  minSeats: 2,
  maxSeats: 4,
  /** Two to four can play, so a table starts with whoever actually turned up. */
  requireFull: false,
  seatIds: (count) => Array.from({ length: count }, (_, index) => `p${index}`),
  /** The economy is the only thing about a table the host gets to choose. */
  validateOptions: (raw) => ({ mode: modeOf(raw) }) satisfies EstateOptions,

  /**
   * The whitelist, spelled out. Every case here is a decision a person makes;
   * the engine's other actions are lifecycle or pacing and have no business
   * arriving from a browser (see `./online`).
   */
  validateAction(raw) {
    if (!raw || typeof raw !== 'object') return null
    const action = raw as { type?: unknown; property?: unknown; trade?: unknown }
    const type = action.type
    if (typeof type !== 'string') return null
    switch (type) {
      case 'ROLL':
      case 'BUY':
      case 'PASS':
      case 'END_TURN':
      case 'ACK_CARD':
      case 'PAY_JAIL':
      case 'LIQUIDATE':
      case 'BANKRUPT':
      case 'ACCEPT_TRADE':
      case 'REJECT_TRADE':
        return { type }
      case 'BUILD':
      case 'SELL_BUILDING':
      case 'MORTGAGE':
      case 'UNMORTGAGE':
        return onBoard(action.property) ? { type, property: action.property } : null
      case 'PROPOSE_TRADE': {
        const trade = parseTrade(action.trade)
        return trade ? { type, trade } : null
      }
      default:
        return null
    }
  },

  create: (seats, options, ctx) => table(seats, options, ctx),

  /**
   * Who may do what. Estate is the only game here with a decision that belongs
   * to a seat other than the one on turn: an offer is answered by the player it
   * was made to, off-turn, and the engine does not check that — `ACCEPT_TRADE`
   * carries no actor at all. This is the only thing standing between a pending
   * trade and any seat that fancies accepting it on the recipient's behalf.
   */
  apply(state, seat, seats, action) {
    if (state.status !== 'playing') return refuse('NOT_PLAYING', 'The game is already over.')
    const player = seats.indexOf(seat)
    if (player < 0 || !state.players[player]) return refuse('NOT_ALLOWED', 'That seat is not at this table.')
    const trade = state.trade

    if (action.type === 'ACCEPT_TRADE' || action.type === 'REJECT_TRADE') {
      if (!trade) return refuse('NOT_ALLOWED', 'There is no offer on the table.')
      if (action.type === 'ACCEPT_TRADE' && trade.to !== player)
        return refuse('NOT_ALLOWED', 'This offer is not yours to accept.')
      // Either party may end an offer: the one it was made to declines it, and
      // the one who made it thinks better of it.
      if (action.type === 'REJECT_TRADE' && trade.to !== player && trade.from !== player)
        return refuse('NOT_ALLOWED', 'This offer is not yours to answer.')
    } else if (trade) {
      // The engine freezes the game while an offer stands, and refuses silently.
      return refuse('NOT_ALLOWED', 'There is an offer on the table to answer first.')
    } else if (action.type === 'PROPOSE_TRADE') {
      if (action.trade.from !== player) return refuse('NOT_ALLOWED', 'An offer has to come from you.')
      if (state.current !== player) return refuse('NOT_YOUR_TURN', 'Deals are struck on your own turn.')
    } else if (state.current !== player) {
      // Everything else — the roll, the purchase, the card, the debt, the
      // building — belongs to the player whose turn it is. `canManage` in the
      // engine reads `state.current` too, so this is the same rule it applies.
      return refuse('NOT_YOUR_TURN', 'It is not your turn.')
    }

    const next = gameReducer(state, action)
    // The engine refuses by handing the same state back, which is the whole
    // legality check — it knows the rules and this does not.
    return next === state ? refuse('ILLEGAL_MOVE', illegal(action)) : { state: next }
  },

  /**
   * The pacing core. Two of the engine's seven phases are pure presentation,
   * and online the server rather than each browser holds them — so the dice land
   * on one number for everyone, at one moment, at the speed the local table
   * plays. Both resolve in a single mutation: the walk is collapsed rather than
   * stepped, because the board tweens off the position it is handed and a token
   * that moves twelve squares at once still glides twelve squares.
   */
  pending(state) {
    if (state.status !== 'playing') return null
    if (state.phase === 'rolling')
      return {
        afterMs: DICE_SETTLE_MS + walkMs(rollSteps(state)),
        resolve: (current) => fastForward(current),
      }
    // Reached from a card that moves you, once its reader has closed it.
    if (state.phase === 'moving')
      return { afterMs: walkMs(state.stepsRemaining), resolve: (current) => fastForward(current) }
    // `ready`, `purchase`, `card`, `debt` and `end` all wait on a person.
    return null
  },

  /**
   * Estate's one secret, and it is the whole game: `seed` is the generator every
   * die and every card comes out of, so a copy of it is a copy of every turn
   * still to come. Everything else at this table — the board, the money, the
   * deeds, the offer on the table — is face up, which makes the redaction this
   * single field, zeroed for every viewer including the player on turn.
   */
  view: (state) => ({ ...state, seed: 0 }),

  isFinished: (state) => state.status === 'finished',

  /**
   * The seat the game cannot go on without. Usually the player on turn — but an
   * offer on the table stops everything until the player it was made to answers,
   * and that is a seat with no turn in sight. A debt is the debtor's to settle
   * and the debtor is always the player on turn, so it needs no case of its own.
   */
  waitingOn(state, seats) {
    if (state.status !== 'playing') return []
    const seat = seats[state.trade ? state.trade.to : state.current]
    return seat ? [seat] : []
  },

  /**
   * There is no forfeiting a property empire — a player who leaves gets played
   * for, one decision at a time, until they come back. The room calls this again
   * on each of their turns, so a single decision is all it settles. Bankruptcy
   * is the only way out of a game of Estate, and it still has to be earned.
   */
  resolveAbsent: (state, seat, seats, ctx) =>
    estateAdapter.bots!.decide(state, seat, seats, 'standard', ctx),

  /**
   * A seat the room plays. `skill` is inert: Estate's bot has one way of
   * playing, so the id exists only so every game answers the same question
   * the same way.
   */
  bots: {
    skills: ['standard'],
    name: (_seat, index) => botName(index),
    decide(state, seat, seats) {
      if (state.status !== 'playing') return state
      const player = seats.indexOf(seat)
      if (player < 0 || !state.players[player]) return state
      // A trade waits on its recipient, who may not be whose turn it is.
      if (state.trade)
        return state.trade.to === player
          ? gameReducer(state, {
              type: botAcceptsTrade(state, state.trade) ? 'ACCEPT_TRADE' : 'REJECT_TRADE',
            })
          : state
      // Consulted off-turn, a bot is a no-op, not a missed move — it only acts when the turn is actually its own.
      if (state.current !== player) return state
      const action = botAction(asBot(state, player))
      return action ? gameReducer(state, action) : state
    },
  },

  /**
   * Same table, same order, a new city. The seed is fresh — a rematch that
   * replayed the first game's dice would be a strange kind of rematch — and it
   * comes from the server's random, exactly as the first one did.
   */
  rematch: (_prev, seats, options, ctx) => ({ state: table(seats, options, ctx) }),
}
