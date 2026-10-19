import * as THREE from 'three'
import { arc, clamp01, hash01, lerp, outCubic } from './ease'

/**
 * How a die is thrown, shared by every game that rolls one. The model stays
 * the game's own; this only moves it.
 *
 * The server decides the number, and it can take a round trip to say so, so a
 * roll has two halves: `shake()` the moment the player asks (a rattle in the
 * hand that can last as long as it needs to), then `throw(value)` when the
 * number is known — a ballistic toss that tumbles, bounces two or three times
 * with squash on each contact, and comes to rest exactly on the face the server
 * chose. Nothing is simulated, so it can never land on the wrong face.
 */
export interface DieThrowOptions {
  /** Where the die rests between rolls. */
  rest: THREE.Vector3
  /** The orientation that shows `value` on top. */
  face: (value: number) => THREE.Quaternion
  /** Edge length in world units; bounce heights and travel scale from it. */
  size: number
  /** Where a throw is released from, relative to `rest`. Defaults to back and up. */
  release?: THREE.Vector3
  /** Each contact with the table, strongest first (1, ~0.4, ~0.15) — for sound and dust. */
  onContact?: (strength: number) => void
  seed?: number
}

type Mode = 'rest' | 'shake' | 'throw'

export function createDieThrow(die: THREE.Object3D, options: DieThrowOptions) {
  const { rest, face, size } = options
  const release = options.release ?? new THREE.Vector3(-size * 1.6, size * 2.4, size * 2.2)
  const baseScale = die.scale.clone()
  let mode: Mode = 'rest',
    elapsed = 0,
    duration = 900,
    seed = options.seed ?? 1,
    contacts = 0
  const start = new THREE.Vector3(),
    startQuat = new THREE.Quaternion(),
    final = new THREE.Quaternion(),
    axis = new THREE.Vector3(),
    spin = new THREE.Quaternion(),
    shakeEuler = new THREE.Euler(),
    shakeFrom = new THREE.Vector3(),
    releasedFrom = new THREE.Vector3(),
    handPoint = new THREE.Vector3()
  let turns = 2

  // Contact times as fractions of the throw, and the share of the height
  // and the remaining distance each hop gets.
  const BOUNCES = [
    { at: 0.5, height: 1, travel: 0.72 },
    { at: 0.78, height: 0.32, travel: 0.22 },
    { at: 0.92, height: 0.1, travel: 0.06 },
  ]

  function pose(t: number) {
    // Position: hop from contact to contact.
    let from = 0,
      travelled = 0,
      hop = BOUNCES[0]
    for (const bounce of BOUNCES) {
      hop = bounce
      if (t <= bounce.at) break
      from = bounce.at
      travelled += bounce.travel
    }
    const local = t >= BOUNCES[BOUNCES.length - 1].at ? 1 : clamp01((t - from) / (hop.at - from))
    const along = t >= BOUNCES[BOUNCES.length - 1].at ? 1 : travelled + hop.travel * local
    die.position.lerpVectors(start, rest, along)
    if (from === 0 && t <= BOUNCES[0].at)
      // Released high: a small lift, then gravity takes it down to the first contact.
      die.position.y = lerp(start.y, rest.y, local * local) + arc(local, size * 0.5)
    else if (t < BOUNCES[BOUNCES.length - 1].at) die.position.y = rest.y + arc(local, size * 1.1 * hop.height)
    else die.position.y = rest.y
    // Carried from wherever it was let go (the hand, mid-lift, or at rest) into
    // the toss, so a quick click still throws from a real height and nothing pops.
    if (t < 0.16) {
      handPoint.copy(die.position)
      die.position.lerpVectors(releasedFrom, handPoint, outCubic(t / 0.16))
    }

    // Squash at each contact, recovering over ~6% of the throw.
    let squash = 0
    for (const bounce of BOUNCES) {
      const since = t - bounce.at
      if (since >= 0 && since < 0.06)
        squash = Math.max(squash, Math.sin((since / 0.06) * Math.PI) * 0.16 * bounce.height)
    }
    die.scale.set(
      baseScale.x * (1 + squash * 0.5),
      baseScale.y * (1 - squash),
      baseScale.z * (1 + squash * 0.5),
    )

    // Orientation: unwind a decaying spin onto the final face.
    const remaining = (1 - outCubic(clamp01(t / 0.94))) * turns * Math.PI * 2
    spin.setFromAxisAngle(axis, remaining)
    spin.multiply(final)
    // Blend out of whatever pose it was released in, so the throw never pops.
    if (t < 0.12) die.quaternion.slerpQuaternions(startQuat, spin, outCubic(t / 0.12))
    else die.quaternion.copy(spin)
  }

  return {
    get busy() {
      return mode !== 'rest'
    },
    /** Rattle in place until `throw` is called. */
    shake() {
      if (mode === 'throw') return
      mode = 'shake'
      elapsed = 0
      startQuat.copy(die.quaternion)
      shakeFrom.copy(die.position)
    },
    /**
     * Toss onto `value`. `ms` should fit inside the server's roll beat.
     * Calling `shake()` first (to cover the round trip) is optional: the toss
     * always rises to the release point from wherever the die is.
     */
    throw(value: number, ms = 900) {
      seed++
      duration = ms
      elapsed = 0
      contacts = 0
      // From the hand if it was shaking, otherwise from the release point.
      releasedFrom.copy(die.position)
      start.copy(rest).add(release)
      startQuat.copy(die.quaternion)
      mode = 'throw'
      final.copy(face(value))
      axis.set(hash01(seed * 3) - 0.5, hash01(seed * 7) * 0.4 + 0.3, hash01(seed * 11) - 0.5).normalize()
      turns = 2 + Math.floor(hash01(seed * 13) * 2)
    },
    /** Put it straight on `value` (reduced motion, or joining mid-game). */
    settle(value: number) {
      mode = 'rest'
      die.position.copy(rest)
      die.scale.copy(baseScale)
      die.quaternion.copy(face(value))
    },
    step(dt: number) {
      if (mode === 'rest' || dt === 0) return mode !== 'rest'
      elapsed += dt * 1000
      if (mode === 'shake') {
        // Lifted into the hand at the release point, then rattled there.
        const s = elapsed / 1000,
          lift = outCubic(clamp01(elapsed / 220))
        handPoint.copy(rest).add(release)
        die.position.lerpVectors(shakeFrom, handPoint, lift)
        die.position.x += Math.sin(s * 31) * size * 0.08 * lift
        die.position.y += Math.abs(Math.sin(s * 17)) * size * 0.2 * lift
        die.position.z += Math.cos(s * 27) * size * 0.08 * lift
        shakeEuler.set(s * 9, s * 13, s * 7)
        spin.setFromEuler(shakeEuler)
        die.quaternion.copy(startQuat).slerp(spin, lift)
        return true
      }
      const t = clamp01(elapsed / duration)
      pose(t)
      while (contacts < BOUNCES.length && t >= BOUNCES[contacts].at) {
        options.onContact?.(BOUNCES[contacts].height)
        contacts++
      }
      if (t >= 1) {
        mode = 'rest'
        die.scale.copy(baseScale)
        die.position.copy(rest)
        die.quaternion.copy(final)
      }
      return true
    },
  }
}
export type DieThrow = ReturnType<typeof createDieThrow>
