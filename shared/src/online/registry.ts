import { chessAdapter } from '../chess/adapter'
import { hearthAdapter } from '../hearth/adapter'
import type { GameId } from '../protocol/types'
import type { GameAdapter } from './adapter'

/**
 * The guest list. A game is playable online exactly when its adapter is here —
 * room creation and the lobby validate against this map, not `GAME_IDS`, so a
 * game that only has a name yet cannot have rooms made for it.
 *
 * Imported by the server only: pulling it into the browser bundle would drag
 * every game's rules along with it.
 */
const adapters: Partial<Record<GameId, GameAdapter>> = {
  chess: chessAdapter,
  hearth: hearthAdapter,
}

/**
 * The one lookup, own-properties only. A plain `in` (or a bare index) would let
 * `"toString"` and `"__proto__"` answer for `Object.prototype`'s members, and
 * every caller here takes its key from an untrusted request.
 */
function lookup(game: string): GameAdapter | undefined {
  return Object.prototype.hasOwnProperty.call(adapters, game) ? adapters[game as GameId] : undefined
}

export function getAdapter(game: GameId): GameAdapter | undefined {
  return lookup(game)
}

/** Narrow an untrusted `game` field (request body, query string) to a playable game. */
export function resolveGame(raw: unknown): GameId | null {
  return typeof raw === 'string' && lookup(raw) ? (raw as GameId) : null
}

/**
 * Test seam: lets backend tests stand up an adapter with behaviours chess never
 * exhibits (timed phases, variable seat counts) and drive the real room with it.
 * Shipping adapters belong in the map above.
 */
export function registerAdapter(adapter: GameAdapter): void {
  adapters[adapter.id] = adapter
}
