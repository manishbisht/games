import type { EstateOnlineAction } from '@games/shared/estate/online'
import type { GameAction, GameState } from '@games/shared/estate/types'
import type { RoomSnapshot, SeatId, YouInfo } from '@games/shared/protocol'
import type { RoomApi } from '../../../online/useRoom'

export interface EstateSeatPlayer {
  name: string
  connected: boolean
  /** Server timestamp of when they dropped; absent while they are here. */
  awaySince?: number
  /** The room is already playing this seat — there is nothing left to claim. */
  abandoned?: boolean
}

/**
 * One online table, in the terms the board already thinks in. The room speaks
 * seats (`p0`…`p3`); the game speaks player indexes, and after the room compacts
 * its seats at the start the two line up index for index.
 */
export interface OnlineEstateSession {
  state: GameState
  /** The player this browser plays, by index, or `null` for someone watching. */
  mySeat: number | null
  /** Keyed by player index, so it lines up with `state.players`. */
  players: Partial<Record<number, EstateSeatPlayer>>
  rematch: { mine: boolean; theirs: boolean }
  send: {
    action: (action: EstateOnlineAction) => void
    rematch: () => void
    claim: () => void
  }
  leave: () => void
}

/**
 * The whitelist, browser side: the engine's actions that are a person's to make.
 * `START` builds a table, and `DICE_SETTLED`, `MOVE_STEP` and `RESOLVE` are the
 * beats of a turn — locally the page schedules those itself, online the room
 * holds them for everyone. The adapter enforces the same list on arrival; this
 * is what keeps the dialogs from having to know there is a room at all.
 */
export function wireAction(action: GameAction): EstateOnlineAction | null {
  switch (action.type) {
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
      return { type: action.type }
    case 'BUILD':
    case 'SELL_BUILDING':
    case 'MORTGAGE':
    case 'UNMORTGAGE':
      return { type: action.type, property: action.property }
    case 'PROPOSE_TRADE':
      return { type: 'PROPOSE_TRADE', trade: action.trade }
    default:
      return null
  }
}

/**
 * Whether this browser may make this decision right now — the adapter's own
 * rule, mirrored. An offer is answered off-turn by the seats it concerns, and
 * everything else belongs to the player on turn. The dialogs are shared with
 * the local game and draw their buttons from `state.current` rather than from
 * whoever is watching, so this is what stops a stray click on a board space
 * becoming a refusal the room has to explain.
 */
export function allowed(session: OnlineEstateSession, action: EstateOnlineAction): boolean {
  const { state, mySeat } = session
  if (mySeat === null || state.status !== 'playing') return false
  const trade = state.trade
  if (action.type === 'ACCEPT_TRADE') return trade?.to === mySeat
  if (action.type === 'REJECT_TRADE') return trade?.to === mySeat || trade?.from === mySeat
  // The engine freezes the game while an offer stands.
  if (trade) return false
  return state.current === mySeat
}

/** The page's `dispatch`, pointed at the room instead of at a local reducer. */
export function onlineDispatch(session: OnlineEstateSession): (action: GameAction) => void {
  return (action) => {
    const wire = wireAction(action)
    if (wire && allowed(session, wire)) session.send.action(wire)
  }
}

/**
 * What a dialog that has to open and close itself watches instead of the state
 * object. A snapshot is parsed fresh out of every broadcast, so `state.trade`
 * and `state.card` are new objects several times a turn and their identity says
 * nothing about whether the thing they describe has changed.
 *
 * An offer is named by its two seats: one may stand at a time, and it is the
 * same offer for as long as they do. A card has no id at all, but nothing else
 * is logged while one is on the table, so the event it was drawn on names it —
 * which is what lets a viewer who did not draw it put it down and have it stay
 * down until the next one.
 */
export const tradeKeyOf = (state: GameState): string =>
  state.trade ? `${state.trade.from}-${state.trade.to}` : ''

export const cardKeyOf = (state: GameState): string =>
  state.phase === 'card' && state.card ? `${state.eventId}-${state.card.title}` : ''

/**
 * The player a claim can be made against right now, or `null`. Three things have
 * to hold at once: the table is genuinely stuck on someone who has gone — the
 * player on turn, or the one an offer is waiting on — this browser holds a seat
 * of its own to claim with (a spectator has no standing, and the server would
 * only answer NOT_SEATED), and no claim has been granted yet, because after one
 * the room plays that seat and there is nothing left to ask for.
 */
export function claimTarget(session: OnlineEstateSession): EstateSeatPlayer | null {
  const { state, mySeat, players } = session
  if (mySeat === null || state.status !== 'playing') return null
  const blocked = state.trade ? state.trade.to : state.current
  if (blocked === mySeat) return null
  const blocker = players[blocked]
  return blocker && !blocker.connected && !blocker.abandoned ? blocker : null
}

export function estateSession(
  snapshot: RoomSnapshot,
  you: YouInfo,
  api: RoomApi,
  leave: () => void,
): OnlineEstateSession {
  // Safe by construction: this only runs for an estate room with a live game.
  const state = snapshot.gameState as GameState
  const indexOf = (seat: SeatId) => snapshot.seatIds.indexOf(seat)

  const players: Partial<Record<number, EstateSeatPlayer>> = {}
  for (const seat of snapshot.seatIds) {
    const info = snapshot.seats[seat]
    const index = indexOf(seat)
    if (info && index >= 0)
      players[index] = {
        name: info.player.name,
        connected: info.connected,
        awaySince: info.awaySince,
        abandoned: info.abandoned,
      }
  }

  const mine = you.seat === null ? -1 : indexOf(you.seat)
  const others = snapshot.seatIds.filter((seat) => seat !== you.seat && snapshot.seats[seat])
  return {
    state,
    mySeat: mine >= 0 ? mine : null,
    players,
    rematch: {
      mine: you.seat ? (snapshot.seats[you.seat]?.wantsRematch ?? false) : false,
      // Two to four at the table, so "them" is everyone else — and a rematch
      // only starts once the whole table has asked for it.
      theirs: others.length > 0 && others.every((seat) => snapshot.seats[seat]!.wantsRematch),
    },
    send: {
      action: (action) => api.action(action),
      rematch: api.rematch,
      claim: api.claim,
    },
    leave,
  }
}
