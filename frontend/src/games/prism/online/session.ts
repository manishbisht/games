import type { PrismOnlineAction } from '@games/shared/prism/online'
import type { Command, GameState } from '@games/shared/prism/types'
import type { RoomSnapshot, YouInfo } from '@games/shared/protocol'
import type { RoomApi } from '../../../online/useRoom'

export interface PrismSeatPlayer {
  name: string
  connected: boolean
  /** Server timestamp of when they dropped; absent while they are here. */
  awaySince?: number
  /** The room is already playing this seat — there is nothing left to claim. */
  abandoned?: boolean
}

/**
 * One online table, in the terms the cards already think in. The room speaks
 * seats (`p0`…`p3`); the engine speaks player indices, and after the room
 * compacts its seats at the start the two line up index for index.
 */
export interface OnlinePrismSession {
  /** Already redacted for this browser: every hand in it but one is placeholders. */
  state: GameState
  /** The player index this browser holds, or `null` for someone watching. */
  viewer: number | null
  /** Indexed by player, so `players[state.currentPlayer]` is whoever is on turn. */
  players: (PrismSeatPlayer | undefined)[]
  rematch: { mine: boolean; theirs: boolean }
  send: {
    /** The engine's own command; who played it is the socket's to say, not ours. */
    command: (command: Command) => void
    rematch: () => void
    claim: () => void
  }
  leave: () => void
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

/**
 * The player a claim can be made against right now, or `null`. Three things have
 * to hold at once: the table is genuinely stuck on someone who has gone, this
 * browser holds a seat of its own to claim with — a watcher has no standing, and
 * the server would only answer NOT_SEATED — and no claim has been granted yet,
 * because after one the room plays that seat and there is nothing to ask.
 */
export function claimTarget(session: OnlinePrismSession): PrismSeatPlayer | null {
  const { state, viewer, players } = session
  if (viewer === null || state.status !== 'playing' || state.currentPlayer === viewer) return null
  const blocker = players[state.currentPlayer]
  return blocker && !blocker.connected && !blocker.abandoned ? blocker : null
}

export function prismSession(
  snapshot: RoomSnapshot,
  you: YouInfo,
  api: RoomApi,
  leave: () => void,
): OnlinePrismSession {
  // Safe by construction: this only runs for a prism room with a live game.
  const state = snapshot.gameState as GameState
  const players: (PrismSeatPlayer | undefined)[] = state.players.map(() => undefined)
  for (const [index, seat] of snapshot.seatIds.entries()) {
    const info = snapshot.seats[seat]
    if (info && index < players.length)
      players[index] = {
        name: info.player.name,
        connected: info.connected,
        awaySince: info.awaySince,
        abandoned: info.abandoned,
      }
  }

  const mine = you.seat ? snapshot.seatIds.indexOf(you.seat) : -1
  const others = snapshot.seatIds.filter((seat) => seat !== you.seat && snapshot.seats[seat])
  return {
    state,
    viewer: mine >= 0 ? mine : null,
    players,
    rematch: {
      mine: you.seat ? (snapshot.seats[you.seat]?.wantsRematch ?? false) : false,
      // Two to four at the table, so "them" is everyone else — and the next round
      // only deals once the whole table has asked for it.
      theirs: others.length > 0 && others.every((seat) => snapshot.seats[seat]!.wantsRematch),
    },
    send: {
      command: (command) => api.action(wireAction(command)),
      rematch: api.rematch,
      claim: api.claim,
    },
    leave,
  }
}
