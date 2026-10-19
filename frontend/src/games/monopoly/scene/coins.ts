import * as THREE from 'three'
import { arc, clamp01, hash01, inOutSine, lerp, outCubic } from '../../../motion/ease'

/**
 * Rent made solid: a handful of brass coins tossed from the payer's token to
 * the payee's (or between a token and the bank at the board's centre), each
 * flipping end over end on its own arc and landing with a clink. They fly with
 * the sidebar's coins and the counted balances, so the board and the HUD tell
 * the same story at the same moment.
 *
 * One InstancedMesh holds every coin: a payment allocates nothing, and the
 * whole pool is a single draw call.
 */
export interface CoinsOptions {
  max?: number
  /** Each coin's landing, strongest first in a payment — for the clink. */
  onLand?: (strength: number, at: THREE.Vector3) => void
}

/** A coin's flight in ms; the sidebar's coins take 760, and these land just ahead of them. */
export const COIN_FLIGHT_MS = 700
/** After landing, a coin settles and shrinks away. */
const SETTLE_MS = 180

export function createCoins(scene: THREE.Scene, { max = 64, onLand }: CoinsOptions = {}) {
  const geometry = new THREE.CylinderGeometry(0.15, 0.15, 0.032, 24)
  const material = new THREE.MeshStandardMaterial({
    color: '#f0c25a',
    metalness: 0.7,
    roughness: 0.34,
    emissive: '#6b4708',
    emissiveIntensity: 0.35,
  })
  const mesh = new THREE.InstancedMesh(geometry, material, max)
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
  mesh.frustumCulled = false
  mesh.castShadow = true
  mesh.count = 0
  scene.add(mesh)

  const from = new Float32Array(max * 3),
    to = new Float32Array(max * 3),
    clock = new Float32Array(max),
    height = new Float32Array(max),
    flips = new Float32Array(max),
    yaw = new Float32Array(max),
    strength = new Float32Array(max),
    landed = new Uint8Array(max)
  const matrix = new THREE.Matrix4(),
    quat = new THREE.Quaternion(),
    euler = new THREE.Euler(),
    pos = new THREE.Vector3(),
    size = new THREE.Vector3()
  let live = 0,
    seed = 1

  function remove(i: number) {
    const last = --live
    if (i === last) return
    from.copyWithin(i * 3, last * 3, last * 3 + 3)
    to.copyWithin(i * 3, last * 3, last * 3 + 3)
    clock[i] = clock[last]
    height[i] = height[last]
    flips[i] = flips[last]
    yaw[i] = yaw[last]
    strength[i] = strength[last]
    landed[i] = landed[last]
  }

  return {
    get active() {
      return live > 0
    },
    /**
     * `count` coins from `a` to `b`, one every `stagger` ms. Coins that do not
     * fit in the pool are simply not thrown — the payment still shows.
     */
    fly(a: THREE.Vector3, b: THREE.Vector3, count: number, stagger = 65) {
      const distance = Math.hypot(b.x - a.x, b.z - a.z)
      for (let n = 0; n < count && live < max; n++) {
        const i = live++,
          r = (j: number) => hash01(seed * 7919 + n * 31 + j)
        from.set([a.x + (r(1) - 0.5) * 0.12, a.y, a.z + (r(2) - 0.5) * 0.12], i * 3)
        // A little scatter where they land, so a payment reads as a handful, not one coin.
        to.set([b.x + (r(3) - 0.5) * 0.3, b.y + n * 0.004, b.z + (r(4) - 0.5) * 0.3], i * 3)
        clock[i] = -n * stagger
        height[i] = Math.min(3.2, 0.9 + distance * 0.28) * (0.85 + r(5) * 0.3)
        flips[i] = (2 + Math.floor(r(6) * 3)) * Math.PI * 2
        yaw[i] = r(7) * Math.PI * 2
        strength[i] = n === 0 ? 0.9 : 0.35 + r(8) * 0.25
        landed[i] = 0
      }
      seed++
    },
    /** Advances every coin by `ms`; returns whether any is still in the air or settling. */
    step(ms: number) {
      if (!live) return false
      for (let i = 0; i < live; i++) {
        clock[i] += ms
        const time = clock[i]
        if (time >= COIN_FLIGHT_MS + SETTLE_MS) {
          remove(i)
          i--
          continue
        }
        const o = i * 3
        // Still waiting its turn in the handful: drawn at zero size.
        let s = 0
        if (time >= 0 && time < COIN_FLIGHT_MS) {
          const t = time / COIN_FLIGHT_MS,
            along = inOutSine(t)
          pos.set(
            lerp(from[o], to[o], along),
            lerp(from[o + 1], to[o + 1], t) + arc(t, height[i]),
            lerp(from[o + 2], to[o + 2], along),
          )
          // Flipping end over end, slowing as it comes down flat on a whole turn.
          euler.set(outCubic(t) * flips[i], yaw[i] + t * 1.5, 0)
          s = outCubic(clamp01(t / 0.12))
        } else if (time >= COIN_FLIGHT_MS) {
          if (!landed[i]) {
            landed[i] = 1
            pos.set(to[o], to[o + 1], to[o + 2])
            onLand?.(strength[i], pos)
          }
          const t = (time - COIN_FLIGHT_MS) / SETTLE_MS
          // A small rebound off the pile, then gone.
          pos.set(to[o], to[o + 1] + arc(clamp01(t * 1.6), 0.05), to[o + 2])
          euler.set(flips[i], yaw[i] + 1.5, 0)
          s = 1 - t * t
        }
        quat.setFromEuler(euler)
        mesh.setMatrixAt(i, matrix.compose(pos, quat, size.setScalar(Math.max(0.0001, s))))
      }
      mesh.count = live
      mesh.instanceMatrix.needsUpdate = true
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
export type Coins = ReturnType<typeof createCoins>
