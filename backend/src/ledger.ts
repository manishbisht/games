import { GAME_ROUTES, roomPath } from '@games/shared/protocol'
import type { GameId, RoomStatus, SeatId } from '@games/shared/protocol'
import type { PushMessage } from './push'

/**
 * What a room remembers about what it has already told the world outside it —
 * players' records, the analytics stream, push services — so each thing is
 * said once, as it happens, however many saves pass in between. Kept on the
 * room's record because a room can be evicted between any two saves.
 */
export interface Ledger {
  /** The room's status as of the last save. A change is a game starting or ending. */
  status: RoomStatus
  /** Games started in this room's life; with the code, what makes a record unique. */
  round: number
  /** When the current game started, for its length. */
  startedAt?: number
  /** Per person at the table, the last version of their table their record was told. */
  tables: Record<string, string>
  /** Counts up with every table update sent, so a player's record can drop a late one. */
  version: number
  /** The seats the game was waiting on at the last save. */
  waiting: SeatId[]
}

export const freshLedger = (status: RoomStatus): Ledger => ({
  status,
  // A room older than its ledger that is already under way is in its first game.
  round: status === 'open' ? 0 : 1,
  tables: {},
  version: 0,
  waiting: [],
})

/**
 * Whose turn has just come round while nobody is there to take it: the seats
 * the game has started waiting on since the last save, held by a person with no
 * socket in the room. A seat that stays waiting is not news, and a player who
 * walks away mid-turn already knows it is theirs — only a turn that arrives
 * while they are gone is worth a notification.
 */
export function turnAlerts(
  before: SeatId[],
  now: SeatId[],
  person: (seat: SeatId) => boolean,
  connected: (seat: SeatId) => boolean,
): SeatId[] {
  return now.filter((seat) => !before.includes(seat) && person(seat) && !connected(seat))
}

const list = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`

export function turnMessage(game: GameId, code: string, others: string[]): PushMessage {
  return {
    title: `Your turn in ${GAME_ROUTES[game].name}`,
    body: others.length
      ? `${list(others)} ${others.length === 1 ? 'is' : 'are'} waiting for you.`
      : 'The table is waiting for you.',
    path: roomPath(game, code),
    tag: `turn-${code}`,
  }
}

export function joinedMessage(game: GameId, code: string, name: string): PushMessage {
  return {
    title: `${name} joined your table`,
    body: `${GAME_ROUTES[game].name} · room ${code}`,
    path: roomPath(game, code),
    tag: `joined-${code}`,
  }
}
