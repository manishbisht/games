import { PLAYER_IDS } from '@games/shared/wildrise/board'
import type { WildriseOnlineAction } from '@games/shared/wildrise/online'
import type { GameState, PlayerId } from '@games/shared/wildrise/types'
import type { ReactionId, RoomSnapshot, SeatId, YouInfo } from '@games/shared/protocol'
import { claimTarget as stuckOn, rematchState, roomBeats, seatPlayers } from '../../../online/session'
import type { RoomBeat, SeatPlayer } from '../../../online/session'
import type { ReactionEntry, SnapshotEntry } from '../../../online/roomState'
import type { RoomApi } from '../../../online/useRoom'

/** One reaction, said from a colour at the table — or from someone watching (`null`). */
export interface TableReaction {
  id: string
  reaction: ReactionId
  from: PlayerId | null
  /** `performance.now()` when it reached this browser. */
  receivedAt: number
}

/**
 * One online table, in the terms the board already thinks in. The room speaks
 * seats (`p0`…`p3`); the game speaks colours, and after the room compacts its
 * seats at the start the two line up index for index.
 */
export interface OnlineWildriseSession {
  state: GameState
  /**
   * The room's recent states, oldest first and `state` last, each with when its
   * beat began on this page's clock: a burst of snapshots renders once, so the
   * board plays every beat of it, and a browser that joins mid-walk picks the
   * walk up in step.
   */
  beats: RoomBeat<GameState>[]
  /** The colour this browser plays, or `null` for someone watching. */
  mySeat: PlayerId | null
  players: Partial<Record<PlayerId, SeatPlayer>>
  rematch: { mine: boolean; theirs: boolean }
  /** Recent reactions, oldest first. */
  reactions: TableReaction[]
  send: {
    roll: () => void
    rematch: () => void
    claim: () => void
    react?: (reaction: ReactionId) => void
  }
  leave: () => void
}

/** The player a claim can be made against right now, or `null` (see the room's `claimTarget`). */
export function claimTarget({ state, players, mySeat }: OnlineWildriseSession): SeatPlayer | null {
  return stuckOn(players, state.players[state.currentPlayer].id, mySeat, state.phase === 'won')
}

export function wildriseSession(
  snapshot: RoomSnapshot,
  you: YouInfo,
  api: RoomApi,
  leave: () => void,
  {
    receivedAt = 0,
    recent = [],
    reactions = [],
  }: { receivedAt?: number; recent?: SnapshotEntry[]; reactions?: ReactionEntry[] } = {},
): OnlineWildriseSession {
  // Safe by construction: this only runs for a wildrise room with a live game.
  const state = snapshot.gameState as GameState
  const colourOf = (seat: SeatId | null): PlayerId | null =>
    (seat && PLAYER_IDS[snapshot.seatIds.indexOf(seat)]) || null
  const send = (action: WildriseOnlineAction) => api.action(action)
  return {
    state,
    beats: roomBeats<GameState>({ snapshot, receivedAt, recent }),
    mySeat: colourOf(you.seat),
    players: seatPlayers(snapshot, (_, index) => PLAYER_IDS[index]),
    rematch: rematchState(snapshot, you),
    reactions: reactions.map(({ id, reaction, seat, receivedAt }) => ({
      id,
      reaction,
      from: colourOf(seat),
      receivedAt,
    })),
    send: {
      roll: () => send({ kind: 'roll' }),
      rematch: api.rematch,
      claim: api.claim,
      react: api.react,
    },
    leave,
  }
}
