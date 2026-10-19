import * as THREE from 'three'
import { createDieThrow } from '../../../motion/dice'
import { outCubic } from '../../../motion/ease'
import { createParticles } from '../../../motion/particles'
import { reducedMotion } from '../../../motion/preference'
import { DUST } from './effects'
import { dieQuaternion, makeDie, roundedBox } from './models'
import type { SceneContext } from './types'

const DIE_REST = new THREE.Vector3(5.85, 0.2335, 6.42)
/** The toss, inside the beat the room holds once the number is known. */
export const THROW_MS = 600

/**
 * The die and the felt tray it rests in on the table's corner. A roll is a
 * rattle in the hand while the room decides, then a toss that lands on the
 * room's number — with a puff of felt dust and a knock at every bounce.
 */
export function createDie(ctx: SceneContext, face: number) {
  const { scene, tweens } = ctx
  const tray = roundedBox(1.15, 0.045, 0.74, '#6a5540', 0.12)
  tray.position.set(DIE_REST.x, -0.1375, DIE_REST.z)
  tray.castShadow = false
  scene.add(tray)
  const die = makeDie()
  die.scale.setScalar(0.82)
  die.position.copy(DIE_REST)
  die.quaternion.copy(dieQuaternion(face))
  scene.add(die)
  const dust = createParticles(scene, { max: 48, floor: DIE_REST.y - 0.35 })
  const toss = createDieThrow(die, {
    rest: DIE_REST,
    face: dieQuaternion,
    size: 0.7,
    // Tossed along the table's front edge, so no bounce comes down inside the board.
    release: new THREE.Vector3(-1.2, 1.8, 0),
    onContact: (strength) => {
      ctx.cue({ kind: 'dice', strength, pan: ctx.pan(die.position) })
      if (ctx.quiet || ctx.stage.quality === 0) return
      dust.burst({
        origin: new THREE.Vector3(die.position.x, DIE_REST.y - 0.33, die.position.z),
        kind: 'dust',
        count: Math.round(3 + strength * 7),
        colors: DUST,
        speed: 0.6 + strength * 1.4,
        size: 0.6 + strength * 0.4,
      })
    },
  })
  /** Runs the toss `ms` ahead at once, quietly — time that passed at the room before the board saw it. */
  function fastForward(ms: number) {
    const quiet = ctx.quiet
    ctx.quiet = true
    toss.step(ms / 1000)
    ctx.quiet = quiet
  }
  return {
    get busy() {
      return toss.busy
    },
    /** The rattle in the hand, for a roll the room has started. */
    shake() {
      if (toss.busy) return
      ctx.cue({ kind: 'roll' })
      if (!reducedMotion()) toss.shake()
    },
    /** The room never took this browser's roll: put the die back down on what it showed. */
    putDown(value: number) {
      toss.throw(value, 450)
    },
    /**
     * Land on `value`; returns how long to hold the next beat back. `skip`
     * is how much of the toss had already happened before the board saw it.
     */
    throw(value: number, skip = 0) {
      if (reducedMotion()) {
        // A quick turn onto the face rather than a toss — still visibly a roll.
        const from = die.quaternion.clone()
        toss.settle(value)
        const face = die.quaternion.clone()
        tweens.add({
          duration: 180,
          ease: outCubic,
          update: (t) => void die.quaternion.slerpQuaternions(from, face, t),
        })
        ctx.cue({ kind: 'dice', strength: 0.5 })
        return 180
      }
      toss.throw(value, THROW_MS)
      if (skip > 0) fastForward(Math.min(skip, THROW_MS))
      return Math.max(0, THROW_MS - skip)
    },
    fastForward,
    /** Straight onto `value`, rattling again if the room is still rolling. */
    settle(value: number, rolling: boolean) {
      toss.settle(value)
      if (rolling && !reducedMotion()) toss.shake()
    },
    step(dt: number) {
      const moving = toss.step(dt)
      return dust.step(dt) || moving
    },
    dispose() {
      dust.dispose()
    },
  }
}
export type Die = ReturnType<typeof createDie>
