import * as THREE from 'three'
import { PALETTES } from '@games/shared/hearth/board'
import type { PlayerId } from '@games/shared/hearth/types'
import { lerp, outCubic } from '../../../motion/ease'
import { createParticles, qualityDensity } from '../../../motion/particles'
import type { Burst } from '../../../motion/particles'
import { reducedMotion } from '../../../motion/preference'
import type { SceneContext } from './types'

export const DUST = ['#efe6d0', '#e2d6b8', '#f7f1e2'],
  GOLD = ['#f1d98a', '#d6b46d', '#fff3c4']

/**
 * Everything the board throws into the air that is not a piece: dust where a
 * piece lands, sparks on a hit, confetti for a win, and flat rings that ripple
 * out across the board. All of it is skipped while the board is quiet or
 * motion is reduced, and thinned out when the stage drops its quality.
 */
export function createEffects(ctx: SceneContext) {
  const { stage, scene, tweens } = ctx
  const particles = createParticles(scene, { max: 700, floor: 0.3 })
  particles.density = qualityDensity(stage.quality)
  const offQuality = stage.onQuality((tier) => {
    particles.density = qualityDensity(tier)
  })

  function burst(spec: Burst) {
    if (ctx.quiet || reducedMotion()) return
    particles.burst(spec)
  }

  // A small pool of flat rings: a capture's shockwave, a piece's welcome home.
  const ringGeometry = new THREE.RingGeometry(0.42, 0.5, 64)
  const rings = Array.from({ length: 4 }, () => {
    const mesh = new THREE.Mesh(
      ringGeometry,
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide }),
    )
    mesh.rotation.x = -Math.PI / 2
    mesh.visible = false
    scene.add(mesh)
    return mesh
  })
  let ringTurn = 0

  /** A ring that spreads from `from` to `to` times its size over `ms`, rising by `rise`. */
  function ring(at: THREE.Vector3, color: string, ms: number, from: number, to: number, rise = 0, delay = 0) {
    let mesh = rings[0]
    tweens.add({
      delay,
      duration: ms,
      start: () => {
        mesh = rings[ringTurn++ % rings.length]
        mesh.material.color.set(color)
        mesh.visible = true
      },
      update: (t) => {
        const e = outCubic(t)
        mesh.position.set(at.x, at.y + 0.012 + rise * e, at.z)
        mesh.scale.setScalar(lerp(from, to, e))
        mesh.material.opacity = 0.85 * (1 - t) ** 1.6
      },
      done: () => void (mesh.visible = false),
    })
  }

  return {
    burst,
    puff(at: THREE.Vector3, count: number, colors: string[] = DUST, size = 0.7) {
      burst({ origin: at, kind: 'dust', count, colors, speed: 1.4, size, spread: 1 })
    },
    ring,
    /** Confetti from all four corners, then a burst of the winner's colour from the centre. */
    celebrate(winner: PlayerId) {
      const colors = [...Object.values(PALETTES).map((p) => p.color), ...GOLD]
      ;[
        [-4.4, 4.4],
        [4.4, 4.4],
        [4.4, -4.4],
        [-4.4, -4.4],
      ].forEach(([x, z], i) =>
        ctx.at(i * 140, () =>
          burst({
            origin: new THREE.Vector3(x, 0.5, z),
            kind: 'confetti',
            count: 80,
            colors,
            speed: 7,
            spread: 0.38,
          }),
        ),
      )
      ctx.at(650, () => {
        burst({
          origin: new THREE.Vector3(0, 0.6, 0),
          kind: 'spark',
          count: 40,
          colors: [PALETTES[winner].color, ...GOLD],
          speed: 4.5,
          spread: 0.7,
          life: 1.2,
        })
        ring(new THREE.Vector3(0, 0.45, 0), '#f1d98a', 900, 0.8, 3.2, 1.4)
      })
    },
    step: (dt: number) => particles.step(dt),
    dispose() {
      offQuality()
      particles.dispose()
    },
  }
}
export type Effects = ReturnType<typeof createEffects>
