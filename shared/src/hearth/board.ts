import type { Piece, PlayerId } from './types'

export const TRACK_LENGTH = 52
export const HOME = 57
export const PLAYER_IDS: PlayerId[] = ['red', 'blue', 'green', 'yellow']
export const PALETTES = {
  red: { color: '#d65d51', dark: '#9b3b32', light: '#f2d7cd', name: 'Red', court: 'Ember court' },
  blue: { color: '#578ab7', dark: '#315a85', light: '#d1e2ec', name: 'Blue', court: 'Tide court' },
  green: { color: '#548d73', dark: '#31694f', light: '#d1e1d2', name: 'Green', court: 'Clover court' },
  yellow: { color: '#d7ac50', dark: '#aa782d', light: '#f0e3bc', name: 'Yellow', court: 'Sol court' },
}
export const ENTRIES: Record<PlayerId, number> = { red: 7, blue: 20, green: 33, yellow: 46 }
export const SAFE_SPACES = new Set([0, 7, 13, 20, 26, 33, 39, 46])
export const COURTS: Record<PlayerId, [number, number]> = {
  red: [-2.75, 2.75],
  blue: [2.75, 2.75],
  green: [2.75, -2.75],
  yellow: [-2.75, -2.75],
}
export function absoluteSpace(piece: Piece): number | null {
  return piece.progress >= 0 && piece.progress < TRACK_LENGTH
    ? (ENTRIES[piece.playerId] + piece.progress) % TRACK_LENGTH
    : null
}
export function trackPosition(index: number): [number, number] {
  const step = index % 13,
    edge = 5.33,
    gap = 0.82
  switch (Math.floor(index / 13)) {
    case 0:
      return [-edge + step * gap, edge]
    case 1:
      return [edge, edge - step * gap]
    case 2:
      return [edge - step * gap, -edge]
    default:
      return [-edge, -edge + step * gap]
  }
}
export function piecePosition(piece: Piece): [number, number] {
  if (piece.progress < 0) {
    const [x, z] = COURTS[piece.playerId]
    return [x + (piece.index % 2 ? 0.63 : -0.63), z + (piece.index < 2 ? -0.48 : 0.72)]
  }
  if (piece.progress < TRACK_LENGTH) return trackPosition(absoluteSpace(piece)!)
  if (piece.progress === HOME) {
    const [x, z] = COURTS[piece.playerId]
    return [
      Math.sign(x) * 0.26 + (piece.index % 2 ? 0.12 : -0.12),
      Math.sign(z) * 0.26 + (piece.index < 2 ? -0.12 : 0.12),
    ]
  }
  const distance = 4.2 - (piece.progress - TRACK_LENGTH) * 0.82
  switch (piece.playerId) {
    case 'red':
      return [0, distance]
    case 'blue':
      return [distance, 0]
    case 'green':
      return [0, -distance]
    case 'yellow':
      return [-distance, 0]
  }
}
export function spaceKey(piece: Piece) {
  const absolute = absoluteSpace(piece)
  if (absolute !== null) return `track-${absolute}`
  return `${piece.playerId}-${piece.progress}-${piece.progress < 0 || piece.progress === HOME ? piece.index : ''}`
}
