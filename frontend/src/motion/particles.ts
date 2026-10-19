import * as THREE from 'three'
import { hash01 } from './ease'
import type { QualityTier } from './stage'

/**
 * How much of a burst a quality tier can afford: every game thinned its
 * effects by roughly these shares, so they live here. Set `particles.density`
 * from `stage.onQuality` and every burst scales with it.
 */
export const qualityDensity = (tier: QualityTier) => [0.35, 0.65, 1][tier]

/**
 * One pooled InstancedMesh for every burst a game fires — confetti for a win,
 * sparks for a capture, dust where a piece lands. A thousand particles cost one
 * draw call, nothing is allocated per burst, and every particle shrinks out
 * rather than vanishing.
 */
export type BurstKind = 'confetti' | 'spark' | 'dust'

export interface Burst {
  origin: THREE.Vector3
  count?: number
  colors?: THREE.ColorRepresentation[]
  kind?: BurstKind
  /** Initial speed in world units per second. */
  speed?: number
  /** Overall size multiplier. */
  size?: number
  /** Seconds each particle lives (randomised ±30%). */
  life?: number
  /** 0 = straight up, 1 = a full hemisphere. */
  spread?: number
  /** Height this burst lands on; defaults to the pool's floor. */
  floor?: number
}

const KIND = {
  confetti: {
    gravity: 5.5,
    drag: 1.6,
    spin: 9,
    scale: [0.18, 0.11, 0.02],
    speed: 6,
    life: 2.6,
    spread: 0.55,
  },
  spark: { gravity: 7, drag: 2.2, spin: 6, scale: [0.09, 0.09, 0.09], speed: 5, life: 0.9, spread: 0.9 },
  dust: { gravity: -0.6, drag: 4.5, spin: 2, scale: [0.13, 0.13, 0.13], speed: 1.8, life: 0.7, spread: 1 },
} as const

export function createParticles(scene: THREE.Scene, { max = 600, floor = -Infinity } = {}) {
  const geometry = new THREE.BoxGeometry(1, 1, 1)
  const material = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.1 })
  const mesh = new THREE.InstancedMesh(geometry, material, max)
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.frustumCulled = false
  mesh.count = 0
  mesh.castShadow = false
  scene.add(mesh)

  const position = new Float32Array(max * 3),
    velocity = new Float32Array(max * 3),
    rotation = new Float32Array(max * 3),
    angular = new Float32Array(max * 3),
    scale = new Float32Array(max * 3),
    life = new Float32Array(max),
    total = new Float32Array(max),
    kind = new Uint8Array(max),
    floors = new Float32Array(max)
  const kinds: BurstKind[] = ['confetti', 'spark', 'dust']
  const color = new THREE.Color(),
    matrix = new THREE.Matrix4(),
    quat = new THREE.Quaternion(),
    euler = new THREE.Euler(),
    pos = new THREE.Vector3(),
    size = new THREE.Vector3()
  let live = 0,
    seed = 1

  let density = 1
  return {
    get active() {
      return live > 0
    },
    /** Multiplies every burst's count (see `qualityDensity`). */
    get density() {
      return density
    },
    set density(value: number) {
      density = Math.max(0, Math.min(1, value))
    },
    burst(burst: Burst) {
      const k = burst.kind ?? 'confetti',
        spec = KIND[k],
        count = Math.min(Math.round((burst.count ?? 40) * density), max - live),
        speed = burst.speed ?? spec.speed,
        spread = burst.spread ?? spec.spread,
        sizeScale = burst.size ?? 1,
        colors = burst.colors ?? ['#f6c453', '#e9706a', '#6fb8e8', '#7cc98b', '#b48ae6']
      for (let n = 0; n < count; n++) {
        const i = live++,
          r = (j: number) => hash01(seed * 7919 + n * 31 + j)
        const azimuth = r(1) * Math.PI * 2,
          polar = r(2) * spread * (Math.PI / 2),
          v = speed * (0.55 + r(3) * 0.6)
        position.set([burst.origin.x, burst.origin.y, burst.origin.z], i * 3)
        velocity.set(
          [
            Math.sin(polar) * Math.cos(azimuth) * v,
            Math.cos(polar) * v,
            Math.sin(polar) * Math.sin(azimuth) * v,
          ],
          i * 3,
        )
        rotation.set([r(4) * 6.28, r(5) * 6.28, r(6) * 6.28], i * 3)
        angular.set(
          [(r(7) - 0.5) * spec.spin * 2, (r(8) - 0.5) * spec.spin * 2, (r(9) - 0.5) * spec.spin * 2],
          i * 3,
        )
        scale.set(
          spec.scale.map((s) => s * sizeScale * (0.75 + r(10) * 0.5)),
          i * 3,
        )
        total[i] = life[i] = (burst.life ?? spec.life) * (0.7 + r(11) * 0.6)
        kind[i] = kinds.indexOf(k)
        floors[i] = burst.floor ?? floor
        mesh.setColorAt(i, color.set(colors[Math.floor(r(12) * colors.length)]))
      }
      seed++
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    },
    step(dt: number) {
      if (!live) return false
      for (let i = 0; i < live; i++) {
        life[i] -= dt
        if (life[i] <= 0) {
          // Swap the last live particle into this slot.
          const last = --live
          if (i !== last) {
            for (const array of [position, velocity, rotation, angular, scale])
              array.copyWithin(i * 3, last * 3, last * 3 + 3)
            life[i] = life[last]
            total[i] = total[last]
            kind[i] = kind[last]
            floors[i] = floors[last]
            mesh.getColorAt(last, color)
            mesh.setColorAt(i, color)
          }
          i--
          continue
        }
        const spec = KIND[kinds[kind[i]]],
          o = i * 3
        const drag = Math.exp(-spec.drag * dt)
        velocity[o] *= drag
        velocity[o + 2] *= drag
        velocity[o + 1] = velocity[o + 1] * drag - spec.gravity * dt
        position[o] += velocity[o] * dt
        position[o + 1] += velocity[o + 1] * dt
        position[o + 2] += velocity[o + 2] * dt
        if (position[o + 1] < floors[i]) {
          position[o + 1] = floors[i]
          velocity[o + 1] *= -0.3
          velocity[o] *= 0.6
          velocity[o + 2] *= 0.6
        }
        // Confetti flutters: its spin slows its fall a little.
        if (kind[i] === 0) velocity[o + 1] += Math.abs(Math.sin(rotation[o])) * 2.2 * dt
        rotation[o] += angular[o] * dt
        rotation[o + 1] += angular[o + 1] * dt
        rotation[o + 2] += angular[o + 2] * dt
        const remaining = life[i] / total[i],
          fade = remaining < 0.3 ? remaining / 0.3 : 1,
          grow = kind[i] === 2 ? 0.6 + (1 - remaining) * 0.9 : 1
        pos.set(position[o], position[o + 1], position[o + 2])
        quat.setFromEuler(euler.set(rotation[o], rotation[o + 1], rotation[o + 2]))
        size.set(scale[o], scale[o + 1], scale[o + 2]).multiplyScalar(fade * grow)
        mesh.setMatrixAt(i, matrix.compose(pos, quat, size))
      }
      mesh.count = live
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      return live > 0
    },
    clear() {
      live = 0
      mesh.count = 0
    },
    dispose() {
      scene.remove(mesh)
      mesh.dispose()
      geometry.dispose()
      material.dispose()
    },
  }
}
export type Particles = ReturnType<typeof createParticles>
