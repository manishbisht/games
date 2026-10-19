import * as THREE from 'three'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { dampFactor, hash01 } from './ease'

/**
 * A camera director that shares the camera with OrbitControls instead of
 * fighting it. It eases to framed shots, follows a moving piece while keeping
 * the viewer's chosen angle, and shakes on impact — and it backs off for a few
 * seconds whenever the viewer grabs the camera themselves.
 *
 * Call `step(dt)` every frame *after* `controls.update()`.
 */
export interface Shot {
  position?: THREE.Vector3
  target?: THREE.Vector3
  zoom?: number
}

export function createCameraRig(
  camera: THREE.OrthographicCamera | THREE.PerspectiveCamera,
  controls: OrbitControls,
  { yieldMs = 4000 } = {},
) {
  let shot: Shot | null = null,
    shotRate = 5,
    follow: (() => THREE.Vector3 | null) | null = null,
    followRate = 3.5,
    followZoom: number | null = null,
    shakeLeft = 0,
    shakeTotal = 0,
    shakeStrength = 0,
    shakeSeed = 0,
    userUntil = 0,
    clock = 0
  const offset = new THREE.Vector3(),
    delta = new THREE.Vector3(),
    goal = new THREE.Vector3(),
    applied = new THREE.Vector3()

  const onStart = () => {
    userUntil = clock + yieldMs
    shot = null
  }
  controls.addEventListener('start', onStart)

  function setZoom(target: number, k: number) {
    if (Math.abs(camera.zoom - target) < 1e-4) return false
    camera.zoom += (target - camera.zoom) * k
    camera.updateProjectionMatrix()
    return true
  }

  return {
    /** Ease to a framed shot. Any field left out stays where it is. */
    to(next: Shot, rate = 5) {
      shot = {
        position: next.position?.clone(),
        target: next.target?.clone(),
        zoom: next.zoom,
      }
      shotRate = rate
      userUntil = 0
    },
    /**
     * Keep `point()` centred while it moves (return null to pause). The camera
     * translates with the target, so the viewer's orbit angle is kept.
     */
    follow(
      point: (() => THREE.Vector3 | null) | null,
      { rate = 3.5, zoom }: { rate?: number; zoom?: number } = {},
    ) {
      follow = point
      followRate = rate
      followZoom = zoom ?? null
    },
    shake(strength = 0.12, ms = 260) {
      shakeStrength = Math.max(shakeStrength * (shakeLeft / (shakeTotal || 1)), strength)
      shakeLeft = shakeTotal = ms
      shakeSeed++
    },
    /** True while the viewer has recently dragged or zoomed. */
    get userControlled() {
      return clock < userUntil
    },
    step(dt: number) {
      clock += dt * 1000
      camera.position.sub(applied)
      applied.set(0, 0, 0)
      let moving = false
      const user = clock < userUntil
      if (shot && !user) {
        const k = dampFactor(shotRate, dt)
        let done = true
        if (shot.position) {
          camera.position.lerp(shot.position, k)
          if (camera.position.distanceToSquared(shot.position) > 1e-5) done = false
        }
        if (shot.target) {
          controls.target.lerp(shot.target, k)
          if (controls.target.distanceToSquared(shot.target) > 1e-5) done = false
        }
        if (shot.zoom !== undefined && setZoom(shot.zoom, k)) done = false
        if (done) shot = null
        moving = true
      }
      const point = follow && !user ? follow() : null
      if (point) {
        goal.copy(point)
        delta.subVectors(goal, controls.target).multiplyScalar(dampFactor(followRate, dt))
        controls.target.add(delta)
        camera.position.add(delta)
        if (followZoom !== null) setZoom(followZoom, dampFactor(followRate, dt))
        moving = moving || delta.lengthSq() > 1e-7
      }
      if (shakeLeft > 0 && dt > 0) {
        shakeLeft = Math.max(0, shakeLeft - dt * 1000)
        const fall = (shakeLeft / shakeTotal) ** 2 * shakeStrength,
          phase = clock * 0.045
        offset
          .set(
            (hash01(shakeSeed * 31 + Math.floor(phase)) - 0.5) * 2,
            (hash01(shakeSeed * 57 + Math.floor(phase)) - 0.5) * 1.2,
            (hash01(shakeSeed * 89 + Math.floor(phase)) - 0.5) * 2,
          )
          .multiplyScalar(fall)
        applied.copy(offset)
        camera.position.add(applied)
        moving = true
      }
      if (moving) camera.lookAt(controls.target)
      return moving
    },
    dispose() {
      controls.removeEventListener('start', onStart)
    },
  }
}
export type CameraRig = ReturnType<typeof createCameraRig>
