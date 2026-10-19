/** Each seat's token and its colour, by player index — the same at the table and in a replay. */
export const TOKENS = ['✦', '◈', '✳', '◉']
export const TOKEN_COLORS = ['#d9bc7c', '#d69583', '#91b3c4', '#b0bb89']

export type SeatSide = 'top' | 'left' | 'right' | 'bottom'

/**
 * Which edge of the table `player` sits at, seen from `viewer`'s chair: the
 * same place the scene lays their fan, so a badge sits beside its cards.
 */
export function seatSide(player: number, viewer: number, count: number): SeatSide {
  const offset = (player - viewer + count) % count
  if (offset === 0) return 'bottom'
  if (count === 2 || (count === 4 && offset === 2)) return 'top'
  return offset === 1 ? 'left' : 'right'
}
