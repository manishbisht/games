import type * as THREE from 'three'
import type { GameState, PlayerId } from '@games/shared/hearth/types'
import type { Stage } from '../../../motion/stage'
import type { Tween, Tweens } from '../../../motion/tween'

/**
 * Something the board just did that deserves a sound. The board raises these
 * from its own animation clock, so a sound plays when a piece actually lands —
 * once — however the room's snapshots happen to arrive. `pan` is where it
 * happened across the screen, -1 left … 1 right.
 */
export type Cue =
  | { kind: 'roll' }
  | { kind: 'dice'; strength: number; pan?: number }
  | { kind: 'step'; index: number; pan?: number }
  | { kind: 'land'; pan?: number }
  | { kind: 'capture'; pan?: number }
  | { kind: 'home'; pan?: number }
  | { kind: 'win' }

/**
 * One state as the room sent it. `seq` counts the snapshots this page has
 * received; `since` is when the state's beat began at the room, on this
 * page's `performance.now()` clock — counted back from when the snapshot
 * arrived, so however late it renders, the beat is `performance.now() - since` in.
 */
export interface RoomBeat {
  seq: number
  state: GameState
  since: number
}

export interface SceneHooks {
  select: (pieceId: string) => void
  /** The table as the board is showing it right now — the HUD follows this, not the room. */
  present: (state: GameState) => void
  cue: (cue: Cue) => void
}

export interface SceneApi {
  /**
   * A state from the room. `seat` is the colour this browser plays; `live` is
   * false for the setup preview. `elapsed` is how far into this state's beat
   * the room is now (see `RoomBeat`), so a board that joins mid-walk picks the
   * walk up where the room is.
   */
  update: (state: GameState, seat: PlayerId | null, live: boolean, elapsed?: number) => void
  /** The player asked to roll: rattle the die now, before the room answers. */
  roll: () => void
  focus: (pieceId: string | null) => void
  reset: () => void
  zoom: (direction: number) => void
  top: () => void
  dispose: () => void
}

/**
 * What every part of the board shares: the stage it draws on, the one tween
 * clock every animation runs on, and the cue line out to the HUD's sounds.
 */
export interface SceneContext {
  stage: Stage
  scene: THREE.Scene
  tweens: Tweens
  /**
   * Set while the board lands something it is skipping over — a backlog, or
   * the part of a walk that had already played before this browser arrived.
   * Nothing raised then makes a sound or a burst.
   */
  quiet: boolean
  cue: (cue: Cue) => void
  /** Runs `effect` once, `delay` ms into the scene clock — in step with the tweens around it. */
  at: (delay: number, effect: () => void) => Tween
  /** Where `point` sits across the canvas, as a stereo pan. */
  pan: (point: THREE.Vector3) => number
  /**
   * Runs every tween `ms` ahead at once, quietly, as if that time had already
   * passed — so a beat that began before the board saw it resumes mid-way.
   */
  skip: (ms: number) => void
}
