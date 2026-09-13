import { PLAYER_IDS } from '@games/shared/wildrise/board'
import type { WildriseOnlineAction } from '@games/shared/wildrise/online'
import type { GameState, PlayerId } from '@games/shared/wildrise/types'
import type { RoomSnapshot, SeatId, YouInfo } from '@games/shared/protocol'
import type { RoomApi } from '../../../online/useRoom'

export interface WildriseSeatPlayer {
  name: string
  connected: boolean
  /** Server timestamp of when they dropped; absent while they are here. */
  awaySince?: number
  /** The room is already rolling for this seat — there is nothing left to claim. */
  abandoned?: boolean
}

/**
 * One online table, in the terms the board already thinks in. The room speaks
 * seats (`p0`…`p3`); the game speaks colours, and after the room compacts its
 * seats at the start the two line up index for index.
 */
export interface OnlineWildriseSession {
  state: GameState
  /** The colour this browser plays, or `null` for someone watching. */
  mySeat: PlayerId | null
  players: Partial<Record<PlayerId, WildriseSeatPlayer>>
  rematch: { mine: boolean; theirs: boolean }
  send: {
    roll: () => void
    rematch: () => void
    claim: () => void
  }
  leave: () => void
}

/**
 * The player a claim can be made against right now, or `null`. Three things have
 * to hold at once: the table is genuinely stuck on someone who has gone, this
 * browser holds a seat of its own to claim with — a spectator has no standing,
 * and the server would only answer NOT_SEATED — and no claim has been granted
 * yet, because after one the room rolls for that seat and there is nothing to ask.
 */
export function claimTarget(session: OnlineWildriseSession): WildriseSeatPlayer | null {
  const { state, mySeat, players } = session
  if (mySeat === null || state.phase === 'won') return null
  const onTurn = state.players[state.currentPlayer].id
  if (onTurn === mySeat) return null
  const blocker = players[onTurn]
  return blocker && !blocker.connected && !blocker.abandoned ? blocker : null
}

export function wildriseSession(
  snapshot: RoomSnapshot,
  you: YouInfo,
  api: RoomApi,
  leave: () => void,
): OnlineWildriseSession {
  // Safe by construction: this only runs for a wildrise room with a live game.
  const state = snapshot.gameState as GameState
  const colourOf = (seat: SeatId): PlayerId | undefined => PLAYER_IDS[snapshot.seatIds.indexOf(seat)]

  const players: Partial<Record<PlayerId, WildriseSeatPlayer>> = {}
  for (const seat of snapshot.seatIds) {
    const info = snapshot.seats[seat]
    const colour = colourOf(seat)
    if (info && colour)
      players[colour] = {
        name: info.player.name,
        connected: info.connected,
        awaySince: info.awaySince,
        abandoned: info.abandoned,
      }
  }

  const send = (action: WildriseOnlineAction) => api.action(action)
  const others = snapshot.seatIds.filter((seat) => seat !== you.seat && snapshot.seats[seat])
  return {
    state,
    mySeat: (you.seat && colourOf(you.seat)) || null,
    players,
    rematch: {
      mine: you.seat ? (snapshot.seats[you.seat]?.wantsRematch ?? false) : false,
      // Up to four at the table, so "them" is everyone else — and a rematch only
      // starts once the whole table has asked for it.
      theirs: others.length > 0 && others.every((seat) => snapshot.seats[seat]!.wantsRematch),
    },
    send: {
      roll: () => send({ kind: 'roll' }),
      rematch: api.rematch,
      claim: api.claim,
    },
    leave,
  }
}
