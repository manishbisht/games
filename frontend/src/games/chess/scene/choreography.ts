import type { Color, GameState, MoveRecord, PieceSymbol, Square } from '@games/shared/chess/types'

/**
 * The parts of a move's presentation that are plain arithmetic: where things
 * stand, how long a move takes, what a snapshot added since the last one, and
 * which way a falling piece has room to fall. Kept free of Three.js so it can
 * be tested on its own.
 */

/** Board coordinates of a square's centre, in the same units as the scene. */
export const squareXZ = (square: Square) => ({
  x: square.charCodeAt(0) - 100.5,
  z: 4.5 - Number(square[1]),
})

/** The square under a point on the board plane, or null off the playing surface. */
export function squareAt(x: number, z: number): Square | null {
  const file = Math.round(x + 3.5),
    rank = Math.round(4.5 - z)
  if (file < 0 || file > 7 || rank < 1 || rank > 8 || Math.abs(x) > 4 || Math.abs(z) > 4) return null
  return `${String.fromCharCode(97 + file)}${rank}` as Square
}

export function squareDistance(a: Square, b: Square) {
  const p = squareXZ(a),
    q = squareXZ(b)
  return Math.hypot(p.x - q.x, p.z - q.z)
}

/**
 * A move's length in milliseconds. A long slide earns more time than a step,
 * but by the square root, so a queen crossing the board is not a slog.
 */
export const moveDuration = (squares: number) => 260 + 70 * Math.sqrt(Math.max(0, squares))

/** How high a sliding piece lifts on its way: a nudge for a step, a lift for a crossing. */
export const liftHeight = (squares: number) => Math.min(0.62, 0.16 + 0.065 * squares)

export interface MovePlan {
  from: Square
  to: Square
  color: Color
  piece: PieceSymbol
  /** Where the captured piece stands, which en passant puts beside `to`. */
  victim: Square | null
  rook: { from: Square; to: Square } | null
  promotion: PieceSymbol | null
  check: boolean
  mate: boolean
}

export function planMove(record: MoveRecord): MovePlan {
  const rank = record.from[1],
    flags = record.flags
  return {
    from: record.from,
    to: record.to,
    color: record.color,
    piece: record.piece,
    victim: record.captured
      ? flags.includes('e')
        ? (`${record.to[0]}${record.from[1]}` as Square)
        : record.to
      : null,
    rook: flags.includes('k')
      ? { from: `h${rank}` as Square, to: `f${rank}` as Square }
      : flags.includes('q')
        ? { from: `a${rank}` as Square, to: `d${rank}` as Square }
        : null,
    promotion: record.promotion ?? null,
    check: /[+#]$/.test(record.san),
    mate: record.san.endsWith('#'),
  }
}

export type Story = { kind: 'moves'; records: MoveRecord[] } | { kind: 'reset' } | { kind: 'none' }

/**
 * What changed between the position on the board and a fresh snapshot: some
 * moves played on from it, or a different game altogether (a rematch, or a
 * history that no longer agrees with what was shown).
 */
export function story(shown: GameState, next: GameState): Story {
  if (shown === next) return { kind: 'none' }
  if (next.initialFen !== shown.initialFen || next.history.length < shown.history.length)
    return { kind: 'reset' }
  const last = shown.history.length - 1
  if (last >= 0 && next.history[last].after !== shown.history[last].after) return { kind: 'reset' }
  if (next.history.length === shown.history.length) return { kind: 'none' }
  return { kind: 'moves', records: next.history.slice(shown.history.length) }
}

const DIRECTIONS = [
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
  [0, -1],
  [1, -1],
].map(([x, z]) => {
  const length = Math.hypot(x, z)
  return { x: x / length, z: z / length, file: x, rank: -z }
})

/**
 * Which way a piece on `square` should fall, as a unit vector on the board.
 * It prefers `preferred` (away from whatever knocked it) but takes the nearest
 * direction whose neighbouring square is empty, so a falling piece does not
 * lie down through its neighbour. Off the board counts as room.
 */
export function fallDirection(square: Square, preferred: { x: number; z: number }, occupied: Set<string>) {
  const length = Math.hypot(preferred.x, preferred.z) || 1,
    px = preferred.x / length,
    pz = preferred.z / length,
    file = square.charCodeAt(0) - 97,
    rank = Number(square[1])
  let best = DIRECTIONS[0],
    bestScore = -Infinity
  for (const direction of DIRECTIONS) {
    const f = file + direction.file,
      r = rank + direction.rank,
      neighbour = f >= 0 && f < 8 && r >= 1 && r <= 8 ? `${String.fromCharCode(97 + f)}${r}` : null
    const score = direction.x * px + direction.z * pz - (neighbour && occupied.has(neighbour) ? 3 : 0)
    if (score > bestScore) {
      bestScore = score
      best = direction
    }
  }
  return { x: best.x, z: best.z }
}

/**
 * Victims of each colour lie in a tray down one side of the board, the first
 * at the end nearest their own back rank, so most fall a short way sideways.
 */
export const GRAVE_SCALE = 0.62
export function graveSlot(victim: Color, index: number) {
  const step = 0.52,
    side = victim === 'b' ? 1 : -1
  return { x: side * 4.98, z: -side * (3.66 - index * step), side }
}

/**
 * When a returning piece leaves for its square in a rematch: back ranks first,
 * then the pawns, each rank sweeping across the files.
 */
export function returnDelay(color: Color, square: Square) {
  const rank = Number(square[1]),
    row = color === 'w' ? rank - 1 : 8 - rank,
    file = square.charCodeAt(0) - 97
  return row * 170 + file * 18
}
