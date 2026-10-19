import * as THREE from 'three'
import { boardPosition } from './models'

/**
 * Where a token stands, square by square. Most squares give each seat its own
 * quarter of the tile; the jail corner is split in two — a cell in its inner
 * quarter for anyone serving time, and the outer edges for anyone just visiting
 * — so a walk past it has to go round the bars rather than through them.
 */
export const JAIL = 10
export const BOARD_SIZE = 40
/** The height a token's base sits at on a tile. */
export const SURFACE = 0.24
export const CELL = { x: -4.79, z: 4.79, size: 0.8 }

const offsets: [number, number][] = [
  [-0.22, 0.2],
  [0.22, 0.2],
  [-0.22, -0.2],
  [0.22, -0.2],
]
/** The jail corner's outer L, nearest the walk first. */
const visiting: [number, number][] = [
  [-5.52, 4.48],
  [-4.48, 5.52],
  [-5.52, 5.52],
  [-5.02, 5.56],
]
const jailed: [number, number][] = [
  [-0.15, 0.15],
  [0.15, -0.15],
  [-0.15, -0.15],
  [0.15, 0.15],
]

/** A token's resting place. `passing` is for the jail corner mid-walk: the outside corner, clear of the cell. */
export function spotFor(
  player: number,
  position: number,
  inJail = false,
  passing = false,
  out = new THREE.Vector3(),
) {
  if (position === JAIL && inJail)
    return out.set(CELL.x + jailed[player % 4][0], SURFACE, CELL.z + jailed[player % 4][1])
  if (position === JAIL) {
    const [x, z] = passing ? [-5.5 + (player % 2) * 0.06, 5.5 - (player % 2) * 0.06] : visiting[player % 4]
    return out.set(x, SURFACE, z)
  }
  const [x, z] = boardPosition(position),
    [ox, oz] = offsets[player % 4]
  return out.set(x + ox, SURFACE, z + oz)
}

/** The tile centre, for camera framing and effects. */
export function tileCentre(position: number, out = new THREE.Vector3()) {
  const [x, z] = boardPosition(position)
  return out.set(x, SURFACE, z)
}

/** Squares forward from `from` to `to`; a full lap is 40, never 0. */
export const stepsBetween = (from: number, to: number) => (to - from + BOARD_SIZE) % BOARD_SIZE

/** The shortest signed turn from one yaw to another. */
export function turnBetween(from: number, to: number) {
  let delta = (to - from) % (Math.PI * 2)
  if (delta > Math.PI) delta -= Math.PI * 2
  if (delta < -Math.PI) delta += Math.PI * 2
  return delta
}
