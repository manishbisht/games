import type { PrismOnlineAction } from '@games/shared/prism/online'
import type { Command, GameState } from '@games/shared/prism/types'
import type { ReactionId, RoomSnapshot, YouInfo } from '@games/shared/protocol'
import type { ReactionEntry } from '../../../online/roomState'
import { beganAt, claimTarget, rematchState, seatPlayer, seatPlayers } from '../../../online/session'
import type { SeatPlayer } from '../../../online/session'
import type { RoomApi } from '../../../online/useRoom'

/**
 * One online table, in the terms the cards already think in. The room speaks
 * seats (`p0`…`p3`); the engine speaks player indices, and after the room
 * compacts its seats at the start the two line up index for index.
 */
export interface OnlinePrismSession {
  /** The room's code: where its finished round plays back (`replayUrl`). */
  code: string
  /** Already redacted for this browser: every hand in it but one is placeholders. */
  state: GameState
  /** The player index this browser holds, or `null` for someone watching. */
  viewer: number | null
  /** Indexed by player, so `players[state.currentPlayer]` is whoever is on turn. */
  players: (SeatPlayer | undefined)[]
  /** The away player the table is stuck on, when this seat may claim against them. */
  blocker: SeatPlayer | null
  rematch: { mine: boolean; theirs: boolean }
  /**
   * When this state began at the room, on this browser's `performance.now()`
   * clock (see `beganAt`). A browser that arrives mid-beat starts it part-way in.
   */
  since?: number
  send: {
    /** The engine's own command; who played it is the socket's to say, not ours. */
    command: (command: Command) => void
    rematch: () => void
    claim: () => void
    react?: (reaction: ReactionId) => void
  }
  leave: () => void
}

/** A reaction, told by the player index it came from — `null` for someone watching. */
export interface TableReaction {
  id: string
  player: number | null
  reaction: ReactionId
  receivedAt: number
}

/**
 * The command as it goes on the wire. `player` is deliberately dropped: the
 * server fills in the seat the message arrived on, so no browser can act as
 * anyone but itself.
 */
export function wireAction(command: Command): PrismOnlineAction {
  if (command.type === 'play')
    return { kind: 'play', cardId: command.cardId, ...(command.color ? { color: command.color } : {}) }
  if (command.type === 'catch') return { kind: 'catch', target: command.target }
  return { kind: command.type }
}

/** The room's reactions, each told by the player index its seat holds at this table. */
export const tableReactions = (snapshot: RoomSnapshot, entries: ReactionEntry[]): TableReaction[] =>
  entries.map(({ id, seat, reaction, receivedAt }) => {
    const index = seat ? snapshot.seatIds.indexOf(seat) : -1
    return { id, player: index >= 0 ? index : null, reaction, receivedAt }
  })

export function prismSession(
  snapshot: RoomSnapshot,
  receivedAt: number,
  you: YouInfo,
  api: RoomApi,
  leave: () => void,
): OnlinePrismSession {
  // Safe by construction: this only runs for a prism room with a live game.
  const state = snapshot.gameState as GameState
  const players = state.players.map((_, index) => {
    const info = snapshot.seats[snapshot.seatIds[index]]
    return info && seatPlayer(info)
  })
  const mine = you.seat ? snapshot.seatIds.indexOf(you.seat) : -1
  return {
    code: snapshot.code,
    state,
    viewer: mine >= 0 ? mine : null,
    players,
    // Counted in seats, which line up with the engine's players one for one.
    blocker: claimTarget(
      seatPlayers(snapshot, (seat) => seat),
      snapshot.seatIds[state.currentPlayer] ?? null,
      you.seat,
      state.status !== 'playing',
    ),
    // Two to four at the table, so "theirs" is everyone else — and the next
    // round only deals once the whole table has asked for it.
    rematch: rematchState(snapshot, you),
    ...(snapshot.timing ? { since: beganAt(snapshot, receivedAt) } : {}),
    send: {
      command: (command) => api.action(wireAction(command)),
      rematch: api.rematch,
      claim: api.claim,
      react: api.react,
    },
    leave,
  }
}
