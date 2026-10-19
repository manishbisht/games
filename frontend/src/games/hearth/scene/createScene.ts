import * as THREE from 'three'
import { COURTS } from '@games/shared/hearth/board'
import type { GameState, PlayerId } from '@games/shared/hearth/types'
import { onMotionChange, reducedMotion } from '../../../motion/preference'
import { createStage } from '../../../motion/stage'
import { createTweens } from '../../../motion/tween'
import { createChoreography } from './choreography'
import { createDie } from './die'
import { createDirector } from './director'
import { createEffects } from './effects'
import { createPicking } from './picking'
import { createPieces } from './pieces'
import { createStory } from './story'
import { createTable } from './table'
import type { SceneApi, SceneContext, SceneHooks } from './types'

export type { Cue, SceneApi, SceneHooks } from './types'

/** One frame at 60 Hz, the slice a skipped-over stretch of animation is replayed in. */
const FRAME_MS = 1000 / 60

/**
 * The 3D table, put together from its parts: the room and its lights
 * (`table`), the camera (`director`), the pieces and their poses (`pieces`),
 * how they move (`choreography`), the die (`die`), dust and sparks
 * (`effects`), choosing a piece (`picking`), and the account of the game that
 * turns the room's states into beats (`story`). This file only wires them to
 * one stage, one tween clock and one frame.
 */
export function createScene(
  container: HTMLElement,
  initial: GameState,
  hooks: SceneHooks,
  seat: PlayerId | null = null,
  live = false,
  /** How far into `initial`'s beat the room already was: a walk under way resumes there. */
  elapsed = 0,
): SceneApi {
  const stage = createStage(container, {
    label:
      '3D Hearth & Home board. Drag to rotate and scroll to zoom. Legal pieces can also be selected using the turn panel.',
    exposure: 0.97,
    environmentIntensity: 0.32,
  })
  const tweens = createTweens(),
    onScreen = new THREE.Vector2(),
    spot = new THREE.Vector3()
  const ctx: SceneContext = {
    stage,
    scene: stage.scene,
    tweens,
    rate: 1,
    quiet: false,
    cue: (cue) => {
      if (!ctx.quiet) hooks.cue(cue)
    },
    at: (delay, effect) => tweens.add({ delay, duration: 1, update: () => {}, start: effect }),
    pan(point) {
      const { width } = stage.size
      if (!width) return 0
      return THREE.MathUtils.clamp((stage.toScreen(point, onScreen).x / width) * 2 - 1, -1, 1) * 0.6
    },
    skip(ms) {
      const quiet = ctx.quiet,
        speed = tweens.speed
      ctx.quiet = true
      tweens.speed = 1
      for (let left = ms; left > 0; left -= FRAME_MS) tweens.step(Math.min(FRAME_MS, left))
      tweens.speed = speed
      ctx.quiet = quiet
    },
  }

  const director = createDirector(stage),
    table = createTable(stage),
    effects = createEffects(ctx),
    die = createDie(ctx, initial.lastDice || 1),
    pieces = createPieces(stage.scene, initial.pieces)
  const moves = createChoreography(ctx, pieces, effects, director, () => {
    story.tell()
    stage.invalidate()
  })
  const picking = createPicking(stage, pieces, table.tiles, (id) => {
    hooks.select(id)
    moves.nod(id)
  })
  const story = createStory(
    ctx,
    { pieces, die, moves, picking, table, director, effects },
    hooks.present,
    initial,
    seat,
    live,
  )

  const offMotion = onMotionChange(() => stage.invalidate())
  /** Frame callbacks run before the frame is drawn, so the second one is the first after a frame is up. */
  let frames = 0
  stage.onFrame((dt, now) => {
    if (frames < 2 && ++frames === 2) hooks.rendered?.()
    const reduced = reducedMotion(),
      // Idle motion — bobbing, pulsing, the winners' wave — is the first thing a struggling device gives up.
      ambient = !reduced && stage.quality > 0,
      winner = story.shown.winner,
      // The beats run at the board's pace; the pieces' springs, the camera and the idle bobbing keep their own.
      paced = dt * ctx.rate
    let moving = story.step(paced)
    moving = die.step(paced) || moving
    moving = effects.step(paced) || moving
    moving = director.step(dt) || moving
    moving = pieces.step(dt, now, { legal: picking.legal, winner, reduced, ambient }) || moving
    moving = picking.step(dt, now, reduced, ambient) || moving
    moving = table.step(dt, now, winner, reduced) || moving
    return moving || story.busy
  })
  stage.onDispose(() => {
    offMotion()
    picking.dispose()
    director.dispose()
    table.dispose()
    effects.dispose()
    die.dispose()
  })

  story.start(elapsed)
  stage.start()

  return {
    update: story.update,
    land: story.land,
    pace(rate) {
      ctx.rate = rate
    },
    roll: story.roll,
    focus: picking.focus,
    anchor(colour) {
      const [x, z] = colour ? COURTS[colour] : [0, 0]
      // A little above the board, so whatever rises from here starts over the pieces, not under them.
      const point = stage.toScreen(spot.set(x, 0.6, z), onScreen)
      return { x: point.x, y: point.y }
    },
    reset: director.reset,
    zoom: director.zoom,
    top: director.top,
    dispose() {
      story.dispose()
      stage.dispose()
    },
  }
}
