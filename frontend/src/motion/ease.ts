/**
 * Easing curves and frame-rate-independent smoothing. Every curve maps 0..1 to
 * 0..1 (the back/elastic ones overshoot on the way), so any of them can be
 * handed to a tween or used to shape a hand-written animation.
 */
export type Ease = (t: number) => number

export const clamp01 = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t)
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t

export const linear: Ease = (t) => t
export const smooth: Ease = (t) => t * t * (3 - 2 * t)
export const inQuad: Ease = (t) => t * t
export const outQuad: Ease = (t) => 1 - (1 - t) * (1 - t)
export const inOutQuad: Ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)
export const inCubic: Ease = (t) => t * t * t
export const outCubic: Ease = (t) => 1 - (1 - t) ** 3
export const inOutCubic: Ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)
export const outQuint: Ease = (t) => 1 - (1 - t) ** 5
export const outExpo: Ease = (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t))
export const inOutSine: Ease = (t) => -(Math.cos(Math.PI * t) - 1) / 2

/** Overshoots past 1 by roughly `overshoot / 10` before settling. */
export const outBack =
  (overshoot = 1.70158): Ease =>
  (t) =>
    1 + (overshoot + 1) * (t - 1) ** 3 + overshoot * (t - 1) ** 2

export const outElastic: Ease = (t) =>
  t <= 0 ? 0 : t >= 1 ? 1 : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1

export const outBounce: Ease = (t) => {
  const n = 7.5625,
    d = 2.75
  if (t < 1 / d) return n * t * t
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375
  return n * (t -= 2.625 / d) * t + 0.984375
}

/**
 * The fraction of the remaining distance to cover this frame so that motion
 * takes the same wall-clock time at 30, 60 or 120 Hz. `lambda` is a rate per
 * second: about 4 is lazy, 10 is brisk, 20 is nearly instant. This is what every
 * `value = lerp(value, target, 0.1)` in a render loop should have been.
 */
export const dampFactor = (lambda: number, dt: number) => 1 - Math.exp(-lambda * dt)
export const damp = (current: number, target: number, lambda: number, dt: number) =>
  lerp(current, target, dampFactor(lambda, dt))

/**
 * A parabolic hop: 0 at both ends, `height` at the middle. Unlike `sin(πt)` its
 * slope is constant at take-off and landing, so a hop reads as thrown rather
 * than floated.
 */
export const arc = (t: number, height: number) => 4 * height * t * (1 - t)

/**
 * Squash and stretch for a hop at progress `t`: a crouch before take-off, a
 * stretch in the air and a squash on landing. Returns `[xz, y]` scale factors
 * that preserve volume; multiply them into the object's own scale.
 */
export function squash(t: number, amount = 1): [number, number] {
  let y: number
  if (t < 0.12) y = 1 - Math.sin((t / 0.12) * Math.PI) * 0.16
  else if (t < 0.82) y = 1 + Math.sin(((t - 0.12) / 0.7) * Math.PI) * 0.12
  else y = 1 - Math.sin(((t - 0.82) / 0.18) * Math.PI) * 0.2
  y = 1 + (y - 1) * amount
  return [1 / Math.sqrt(y), y]
}

/**
 * A critically damped spring, advanced in place. Good for anything the user
 * can interrupt (hover lifts, a camera that follows): it never overshoots and
 * picks up from wherever it is, at whatever speed it is going.
 */
export interface Spring {
  value: number
  velocity: number
  target: number
}
export const spring = (value = 0): Spring => ({ value, velocity: 0, target: value })
export function stepSpring(s: Spring, stiffness: number, dt: number, damping = 2 * Math.sqrt(stiffness)) {
  // Sub-stepped so a long frame (a tab regaining focus) cannot blow it up.
  const steps = Math.max(1, Math.ceil(dt / (1 / 120)))
  const h = dt / steps
  for (let i = 0; i < steps; i++) {
    const force = stiffness * (s.target - s.value) - damping * s.velocity
    s.velocity += force * h
    s.value += s.velocity * h
  }
  if (Math.abs(s.target - s.value) < 1e-4 && Math.abs(s.velocity) < 1e-3) {
    s.value = s.target
    s.velocity = 0
    return false
  }
  return true
}

/** A cheap deterministic pseudo-random in [0, 1) from any integer seed. */
export function hash01(seed: number) {
  let x = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b)
  x ^= x >>> 13
  x = Math.imul(x, 0xc2b2ae35)
  x ^= x >>> 16
  return (x >>> 0) / 4294967296
}

/** A stable hash of a string id, for per-object jitter that survives re-renders. */
export function hashString(id: string) {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619)
  return h >>> 0
}
