import { describe, expect, it } from 'vitest'
import { arc, damp, outBack, smooth, spring, squash, stepSpring } from './ease'
import { createQueue, createTweens } from './tween'

describe('easing', () => {
  it('lands every curve on its ends', () => {
    for (const ease of [smooth, outBack()]) {
      expect(ease(0)).toBeCloseTo(0)
      expect(ease(1)).toBeCloseTo(1)
    }
    expect(arc(0, 2)).toBe(0)
    expect(arc(0.5, 2)).toBe(2)
    expect(arc(1, 2)).toBe(0)
  })

  it('damps the same distance in the same time at any frame rate', () => {
    let at60 = 0,
      at120 = 0
    for (let i = 0; i < 60; i++) at60 = damp(at60, 1, 6, 1 / 60)
    for (let i = 0; i < 120; i++) at120 = damp(at120, 1, 6, 1 / 120)
    expect(at60).toBeCloseTo(at120, 6)
  })

  it('keeps squash and stretch volume-preserving and neutral at rest', () => {
    for (const t of [0, 0.05, 0.4, 0.9, 1]) {
      const [xz, y] = squash(t)
      expect(xz * xz * y).toBeCloseTo(1)
    }
    expect(squash(0)[1]).toBeCloseTo(1)
    expect(squash(1)[1]).toBeCloseTo(1)
  })

  it('settles a spring on its target without overshooting', () => {
    const s = spring(0)
    s.target = 1
    let max = 0
    for (let i = 0; i < 240 && stepSpring(s, 200, 1 / 60); i++) max = Math.max(max, s.value)
    expect(s.value).toBe(1)
    expect(max).toBeLessThanOrEqual(1.0001)
  })
})

describe('tweens', () => {
  it('waits out the delay, then runs start, update and done in order', () => {
    const tweens = createTweens(),
      log: string[] = []
    tweens.add({
      duration: 100,
      delay: 50,
      start: () => log.push('start'),
      update: (t) => log.push(t.toFixed(1)),
      done: () => log.push('done'),
    })
    tweens.step(40)
    expect(log).toEqual([])
    tweens.step(60)
    expect(log).toEqual(['start', '0.5'])
    expect(tweens.step(100)).toBe(false)
    expect(log).toEqual(['start', '0.5', '1.0', 'done'])
  })

  it('finishes everything, including tweens added by a done callback', () => {
    const tweens = createTweens(),
      seen: number[] = []
    tweens.add({
      duration: 500,
      update: () => {},
      done: () => void tweens.add({ duration: 500, update: (t) => seen.push(t) }),
    })
    tweens.finishAll()
    expect(seen).toEqual([1])
    expect(tweens.active).toBe(false)
  })

  it('runs faster when its speed is raised', () => {
    const tweens = createTweens()
    let last = 0
    tweens.speed = 2
    tweens.add({ duration: 100, update: (t) => (last = t) })
    tweens.step(25)
    expect(last).toBeCloseTo(0.5)
  })

  it('cancels without running done', () => {
    const tweens = createTweens()
    let done = false
    const t = tweens.add({ duration: 100, update: () => {}, done: () => (done = true) })
    t.cancel()
    tweens.step(200)
    expect(done).toBe(false)
  })
})

describe('presentation queue', () => {
  it('plays beats one after another, holding each for its duration', () => {
    const queue = createQueue(),
      log: string[] = []
    queue.push({ run: () => (log.push('a'), 100) }, { run: () => (log.push('b'), 100) })
    expect(log).toEqual(['a'])
    queue.step(99)
    expect(log).toEqual(['a'])
    queue.step(1)
    expect(log).toEqual(['a', 'b'])
    expect(queue.step(100)).toBe(false)
  })

  it('runs zero-length beats back to back and reports idle once', () => {
    const queue = createQueue()
    let idle = 0
    queue.onIdle(() => idle++)
    queue.push({ run: () => {} }, { run: () => 0 })
    expect(queue.busy).toBe(false)
    expect(idle).toBe(1)
  })

  it('speeds up when a backlog builds and flushes the rest at once', () => {
    const queue = createQueue({ catchUpAfter: 2, catchUpSpeed: 3 }),
      log: number[] = []
    for (let i = 0; i < 5; i++) queue.push({ run: () => (log.push(i), 300) })
    expect(queue.speed).toBe(3)
    queue.flush()
    expect(log).toEqual([0, 1, 2, 3, 4])
    expect(queue.busy).toBe(false)
  })
})

describe('camera rig orbit', () => {
  it('swings round the target the short way and lands on the angle asked for', async () => {
    const THREE = await import('three')
    const { createCameraRig } = await import('./camera')
    const camera = new THREE.PerspectiveCamera()
    camera.position.set(0, 5, 10)
    const controls = Object.assign(new THREE.EventDispatcher(), { target: new THREE.Vector3() })
    const rig = createCameraRig(camera, controls as never)
    rig.orbit({ azimuth: -Math.PI + 0.1, ms: 500 })
    let minDistance = Infinity
    for (let i = 0; i < 40; i++) {
      rig.step(1 / 60)
      minDistance = Math.min(minDistance, camera.position.distanceTo(controls.target))
    }
    expect(rig.angle.azimuth).toBeCloseTo(-Math.PI + 0.1, 3)
    // An orbit keeps its distance; a straight line through the target would not.
    expect(minDistance).toBeCloseTo(Math.hypot(5, 10), 3)
    expect(rig.busy).toBe(false)
  })
})
