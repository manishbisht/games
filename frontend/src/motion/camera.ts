import * as THREE from 'three'
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { clamp01, dampFactor, hash01, inOutCubic, lerp } from './ease'
import type { Ease } from './ease'

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

/**
 * A move around the target rather than through the scene: azimuth and polar
 * are interpolated as angles (the short way round), so a half-turn flip arcs
 * over the board instead of cutting across it. `swoop` lifts the polar angle
 * towards top-down mid-move, for a flip that rises as it turns.
 */
export interface Orbit {
  azimuth?: number
  polar?: number
  radius?: number
  target?: THREE.Vector3
  zoom?: number
  swoop?: number
  ms?: number
  delay?: number
  ease?: Ease
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
    clock = 0,
    orbit: {
      goal: Orbit
      elapsed: number
      from: THREE.Spherical | null
      fromTarget: THREE.Vector3
      fromZoom: number
      toAzimuth: number
    } | null = null
  const offset = new THREE.Vector3(),
    delta = new THREE.Vector3(),
    goal = new THREE.Vector3(),
    applied = new THREE.Vector3(),
    spherical = new THREE.Spherical()

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
    /** Swing round the target to a new angle; see `Orbit`. */
    orbit(goal: Orbit) {
      shot = null
      userUntil = 0
      orbit = {
        goal: { ...goal, target: goal.target?.clone() },
        elapsed: -(goal.delay ?? 0),
        from: null,
        fromTarget: new THREE.Vector3(),
        fromZoom: camera.zoom,
        toAzimuth: 0,
      }
    },
    /** The camera's current angle around its target, in `Orbit` terms. */
    get angle() {
      spherical.setFromVector3(offset.subVectors(camera.position, controls.target))
      return { azimuth: spherical.theta, polar: spherical.phi, radius: spherical.radius }
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
    /** True while a shot, orbit or shake is still playing. */
    get busy() {
      return Boolean(shot || orbit || shakeLeft > 0)
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
      if (orbit && user) orbit = null
      if (orbit && dt > 0) {
        orbit.elapsed += dt * 1000
        if (orbit.elapsed >= 0) {
          const { goal } = orbit
          if (!orbit.from) {
            orbit.from = new THREE.Spherical().setFromVector3(
              offset.subVectors(camera.position, controls.target),
            )
            orbit.fromTarget.copy(controls.target)
            orbit.fromZoom = camera.zoom
            let to = goal.azimuth ?? orbit.from.theta
            while (to - orbit.from.theta > Math.PI) to -= Math.PI * 2
            while (to - orbit.from.theta < -Math.PI) to += Math.PI * 2
            orbit.toAzimuth = to
          }
          const raw = clamp01(orbit.elapsed / (goal.ms ?? 950)),
            e = (goal.ease ?? inOutCubic)(raw),
            from = orbit.from
          controls.target.lerpVectors(orbit.fromTarget, goal.target ?? orbit.fromTarget, e)
          spherical.set(
            lerp(from.radius, goal.radius ?? from.radius, e),
            Math.max(
              0.001,
              lerp(from.phi, goal.polar ?? from.phi, e) - (goal.swoop ?? 0) * Math.sin(Math.PI * raw),
            ),
            lerp(from.theta, orbit.toAzimuth, e),
          )
          camera.position.setFromSpherical(spherical).add(controls.target)
          if (goal.zoom !== undefined) {
            camera.zoom = lerp(orbit.fromZoom, goal.zoom, e)
            camera.updateProjectionMatrix()
          }
          if (raw >= 1) orbit = null
        }
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
