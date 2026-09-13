import type { PlayerId, Route, Rules } from './types'

export const PLAYER_IDS: PlayerId[] = ['red', 'blue', 'green', 'yellow']
export const PALETTES = {
  red: { name: 'Red', animal: 'Fox', color: '#d86b4e', pale: '#f7e4db', symbol: 'fox' },
  blue: { name: 'Blue', animal: 'Owl', color: '#4f88ac', pale: '#e1edf2', symbol: 'owl' },
  green: { name: 'Green', animal: 'Rabbit', color: '#66916c', pale: '#e5eddd', symbol: 'rabbit' },
  yellow: { name: 'Yellow', animal: 'Bear', color: '#be903c', pale: '#f6edcf', symbol: 'bear' },
}
export const DEFAULT_RULES: Rules = {
  exactFinish: true,
  extraTurnOnSix: false,
  allowSharedSquares: true,
  startingPosition: 0,
  snakeCount: 6,
  ladderCount: 6,
}
export const SNAKES: Route[] = [
  { from: 98, to: 78, color: '#547e9f' },
  { from: 95, to: 75, color: '#9c769f' },
  { from: 88, to: 48, color: '#518e81' },
  { from: 62, to: 18, color: '#cd715d' },
  { from: 54, to: 34, color: '#a29245' },
  { from: 47, to: 26, color: '#757bae' },
]
export const LADDERS: Route[] = [
  { from: 4, to: 25, color: '#b78b49' },
  { from: 13, to: 46, color: '#b78b49' },
  { from: 27, to: 56, color: '#b78b49' },
  { from: 33, to: 49, color: '#b78b49' },
  { from: 42, to: 63, color: '#b78b49' },
  { from: 51, to: 91, color: '#b78b49' },
]
export function spaceCoordinates(space: number) {
  const row = Math.floor((space - 1) / 10)
  const column = (space - 1) % 10
  return { x: (row % 2 === 0 ? column : 9 - column) - 4.5, z: 4.5 - row }
}
