import { PLAYER_IDS } from '@games/shared/hearth/board'
import type { HearthOnlineAction } from '@games/shared/hearth/online'
import type { GameState, PlayerId } from '@games/shared/hearth/types'
import type { ReactionId, SeatId } from '@games/shared/protocol'
import type { RoomViewProps } from '../../../online/games'
import { claimTarget, rematchState, roomBeats, seatPlayers } from '../../../online/session'
import type { RoomBeat, SeatPlayer } from '../../../online/session'

/** A reaction, said by a colour at the table — or `null`, by someone watching. */
export interface SeatReaction {
  id: string
  colour: PlayerId | null
  reaction: ReactionId
  name: string
  /** `performance.now()` when it arrived. */
  receivedAt: number
}

/**
 * One online table, in the terms the board already thinks in. The room speaks
 * seats (`p0`…`p3`); the game speaks colours, and after the room compacts its
 * seats at the start the two line up index for index.
 */
export interface OnlineHearthSession {
  state: GameState
  /**
   * Every state the room has sent lately, oldest first, ending with `state`.
   * A burst of snapshots renders once, but the board still plays each one —
   * and each knows when its beat began, so a board that arrives mid-walk
   * takes the walk up where the room is.
   */
  beats: RoomBeat<GameState>[]
  /** The colour this browser plays, or `null` for someone watching. */
  mySeat: PlayerId | null
  players: Partial<Record<PlayerId, SeatPlayer>>
  rematch: { mine: boolean; theirs: boolean }
  /** The away player the table is stuck on, while there is still a claim to make against them. */
  claimable: SeatPlayer | null
  /** Recent reactions, oldest first, each placed at the colour it came from. */
  reactions: SeatReaction[]
  send: {
    roll: () => void
    move: (pieceId: string) => void
    rematch: () => void
    claim: () => void
    react?: (reaction: ReactionId) => void
  }
  leave: () => void
}

export function hearthSession({
  snapshot,
  receivedAt,
  recent,
  reactions = [],
  you,
  api,
  leave,
}: RoomViewProps): OnlineHearthSession {
  // Safe by construction: this only runs for a hearth room with a live game.
  const state = snapshot.gameState as GameState
  const colourOf = (seat: SeatId | null): PlayerId | null =>
    (seat && PLAYER_IDS[snapshot.seatIds.indexOf(seat)]) || null
  const players = seatPlayers(snapshot, (_seat, index) => PLAYER_IDS[index]),
    mySeat = colourOf(you.seat)
  const send = (action: HearthOnlineAction) => api.action(action)
  return {
    state,
    beats: roomBeats<GameState>({ snapshot, receivedAt, recent }),
    mySeat,
    players,
    rematch: rematchState(snapshot, you),
    claimable: claimTarget(players, state.players[state.currentPlayer].id, mySeat, state.phase === 'won'),
    reactions: reactions.map(({ id, seat, reaction, receivedAt }) => {
      const colour = colourOf(seat)
      return {
        id,
        colour,
        reaction,
        receivedAt,
        name: (colour && players[colour]?.name) || 'Someone watching',
      }
    }),
    send: {
      roll: () => send({ kind: 'roll' }),
      move: (pieceId) => send({ kind: 'move', pieceId }),
      rematch: api.rematch,
      claim: api.claim,
      react: api.react,
    },
    leave,
  }
}
