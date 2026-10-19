import { createGame, opposite, playMove, resign } from '@games/shared/chess'
import type { Color, GameState, GameStatus, PromotionPiece } from '@games/shared/chess/types'
import type { ReplayFrame, ReplayPlayer } from '@games/shared/protocol'

/**
 * A finished game as a link that never expires. A room keeps its replay for
 * 24 hours; the moves themselves are tiny, so the link carries them and the
 * browser plays them through the engine again — nothing is stored anywhere.
 *
 * `/chess?moves=e2e4e7e5g1f3&end=resigned.w&w=Ann&b=Jules`: the moves as
 * from-to squares run together (a fifth letter for a promotion), how the game
 * ended when the moves alone don't say (a resignation, the flag, a draw by
 * agreement — a mate or a stalemate is the moves' own business), and who sat
 * where. Always from the standard position, as every room's game starts.
 */
export const PERMALINK_PARAM = 'moves'

/** A link no longer than a browser or a chat app will carry happily. */
const MAX_PLIES = 1000,
  MAX_NAME = 32
/** The gap between two moves when the link is played back, as if the room had paced it. */
const PLY_MS = 1100
const MOVE = /[a-h][1-8][a-h][1-8][qrbn]?/g
const ENDINGS = ['resigned', 'timeout', 'agreement'] as const satisfies GameStatus[]
type Ending = (typeof ENDINGS)[number]

/** The router path (with its query) that replays `game` forever. */
export function permalinkPath(game: GameState, names: Partial<Record<Color, string>> = {}): string {
  const params = new URLSearchParams()
  params.set(PERMALINK_PARAM, game.history.map((m) => `${m.from}${m.to}${m.promotion ?? ''}`).join(''))
  if ((ENDINGS as readonly string[]).includes(game.status))
    params.set('end', game.winner ? `${game.status}.${game.winner}` : game.status)
  for (const color of ['w', 'b'] as const) {
    const name = names[color]?.trim().slice(0, MAX_NAME)
    if (name) params.set(color, name)
  }
  return `/chess?${params}`
}

/** The same, as a full address to copy: this page's origin and base, with the path as its hash. */
export function permalinkUrl(game: GameState, names?: Partial<Record<Color, string>>): string {
  return new URL(`#${permalinkPath(game, names)}`, location.href).href
}

export interface PermalinkReplay {
  states: ReplayFrame<GameState>[]
  players: ReplayPlayer[]
}

/**
 * The replay a link describes, or null when it doesn't describe a game: an
 * unreadable move list, a move the position doesn't allow, or nothing at all.
 * Every state is rebuilt by the engine, so a hand-edited link can only ever
 * show legal chess.
 */
export function readPermalink(search: URLSearchParams): PermalinkReplay | null {
  const raw = search.get(PERMALINK_PARAM)?.toLowerCase() ?? ''
  const moves = raw.match(MOVE) ?? []
  if (moves.join('') !== raw || moves.length > MAX_PLIES) return null
  let game = createGame({ mode: 'online', clock: 0 }, undefined, 0)
  const states = [game]
  for (const move of moves) {
    const next = playMove(game, move.slice(0, 2), move.slice(2, 4), move[4] as PromotionPiece | undefined, 0)
    if (next.history.length !== game.history.length + 1) return null
    states.push((game = next))
  }
  const [status, winner] = (search.get('end') ?? '').split('.') as [string, string | undefined]
  if (game.status === 'playing' && (ENDINGS as readonly string[]).includes(status)) {
    const ending = status as Ending,
      won = winner === 'w' || winner === 'b' ? (winner as Color) : null
    // A resignation always has a winner; the flag may fall on a side that could never have lost.
    if (ending === 'resigned' && won) states.push(resign(game, 0, opposite(won)))
    else if (ending !== 'resigned') states.push({ ...game, status: ending, winner: won, promotion: null })
  }
  if (states.length < 2) return null
  const name = (color: Color) =>
    search.get(color)?.trim().slice(0, MAX_NAME) || (color === 'w' ? 'White' : 'Black')
  return {
    states: states.map((state, index) => ({ at: index * PLY_MS, state })),
    players: [
      { seat: 'w', name: name('w') },
      { seat: 'b', name: name('b') },
    ],
  }
}
