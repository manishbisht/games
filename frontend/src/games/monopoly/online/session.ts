import type { EstateOnlineAction } from '@games/shared/estate/online'
import type { GameAction, GameState } from '@games/shared/estate/types'
import type { ReactionId, SeatId } from '@games/shared/protocol'
import type { RoomViewProps } from '../../../online/games'
import type { ReactionEntry } from '../../../online/roomState'
import {
  claimTarget as sharedClaimTarget,
  rematchState,
  roomBeats,
  seatPlayers,
} from '../../../online/session'
import type { RoomBeat, SeatPlayer } from '../../../online/session'

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
  players: Partial<Record<number, SeatPlayer>>
  rematch: { mine: boolean; theirs: boolean }
  /**
   * Every recent state the room sent, oldest first, ending with `state`, each
   * timed from when the room entered it. A burst of messages renders once; the
   * board plays each state it has not seen yet, so a roll and the walk after it
   * are both told — and a page that joins mid-roll joins it where the room is.
   */
  beats: RoomBeat<GameState>[]
  send: {
    action: (action: EstateOnlineAction) => void
    rematch: () => void
    claim: () => void
    /** A quick reaction to the table; absent on a room double written before there were any. */
    react?: (reaction: ReactionId) => void
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
 * The player a claim can be made against right now, or `null` (see the shared
 * `claimTarget`). The table is stuck on whoever an offer is waiting on, if one
 * stands, and on the player on turn otherwise.
 */
export function claimTarget({ state, mySeat, players }: OnlineEstateSession): SeatPlayer | null {
  const blocked = state.trade ? state.trade.to : state.current
  // The shared rule keys seats by name; ours are indexes, which name them just as well.
  return sharedClaimTarget<string>(
    players,
    String(blocked),
    mySeat === null ? null : String(mySeat),
    state.status !== 'playing',
  )
}

/** A reaction in the table's terms: who sent it by player index, or `null` for someone watching. */
export interface TableReaction {
  id: string
  player: number | null
  reaction: ReactionId
  /** `performance.now()` when it arrived. */
  receivedAt: number
}

export const tableReactions = (
  seatIds: readonly SeatId[],
  reactions: readonly ReactionEntry[],
): TableReaction[] =>
  reactions.map(({ id, seat, reaction, receivedAt }) => {
    const index = seat === null ? -1 : seatIds.indexOf(seat)
    return { id, player: index >= 0 ? index : null, reaction, receivedAt }
  })

export function estateSession({
  snapshot,
  receivedAt,
  recent,
  you,
  api,
  leave,
}: RoomViewProps): OnlineEstateSession {
  const mine = you.seat === null ? -1 : snapshot.seatIds.indexOf(you.seat)
  return {
    // Safe by construction: this only runs for an estate room with a live game.
    state: snapshot.gameState as GameState,
    mySeat: mine >= 0 ? mine : null,
    players: seatPlayers(snapshot, (_seat, index) => String(index)),
    rematch: rematchState(snapshot, you),
    beats: roomBeats<GameState>({ snapshot, receivedAt, recent }),
    send: {
      action: (action) => api.action(action),
      rematch: api.rematch,
      claim: api.claim,
      react: api.react,
    },
    leave,
  }
}
