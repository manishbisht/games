import { clamp01, linear } from './ease'
import type { Ease } from './ease'

/**
 * Tweens and a presentation queue, both driven by the scene's own clock rather
 * than their own rAF, so pausing the scene pauses them and a test can step them
 * by hand. Times are milliseconds throughout.
 */
export interface TweenSpec {
  duration: number
  delay?: number
  ease?: Ease
  /** Called every step with the eased progress and the raw 0..1 progress. */
  update: (t: number, raw: number) => void
  /** Called once, on the first step after the delay has run out. */
  start?: () => void
  done?: () => void
}

export interface Tween {
  /** Stop where it is; `done` does not run. */
  cancel(): void
  /** Jump to the end; `update(1)` and `done` run now. */
  finish(): void
  readonly active: boolean
}

interface Running {
  spec: TweenSpec
  elapsed: number
  started: boolean
  live: boolean
}

export function createTweens() {
  let list: Running[] = []
  const api = {
    /** Multiplies every tween's clock; the queue raises it to catch up a backlog. */
    speed: 1,
    add(spec: TweenSpec): Tween {
      const run: Running = { spec, elapsed: -(spec.delay ?? 0), started: false, live: true }
      list.push(run)
      return {
        cancel() {
          run.live = false
        },
        finish() {
          if (!run.live) return
          complete(run)
        },
        get active() {
          return run.live
        },
      }
    },
    /** Advances every tween; returns whether any is still running. */
    step(dtMs: number) {
      const dt = dtMs * api.speed
      // Tweens added from inside a callback join the next step, not this one.
      const current = list
      for (const run of current) {
        if (!run.live) continue
        run.elapsed += dt
        if (run.elapsed < 0) continue
        const { spec } = run
        if (!run.started) {
          run.started = true
          spec.start?.()
        }
        if (run.elapsed >= spec.duration) complete(run)
        else {
          const raw = clamp01(run.elapsed / spec.duration)
          spec.update((spec.ease ?? linear)(raw), raw)
        }
      }
      list = list.filter((r) => r.live)
      return list.length > 0
    },
    /** Lands every tween on its final frame, running `done` callbacks. */
    finishAll() {
      // `done` may add tweens; keep finishing until nothing new appears.
      for (let guard = 0; guard < 32 && list.some((r) => r.live); guard++) {
        const current = list
        list = []
        for (const run of current) if (run.live) complete(run)
      }
      list = list.filter((r) => r.live)
    },
    cancelAll() {
      for (const run of list) run.live = false
      list = []
    },
    get active() {
      return list.some((r) => r.live)
    },
  }
  function complete(run: Running) {
    run.live = false
    if (!run.started) {
      run.started = true
      run.spec.start?.()
    }
    run.spec.update(1, 1)
    run.spec.done?.()
  }
  return api
}
export type Tweens = ReturnType<typeof createTweens>

/**
 * One step of a presentation: something that starts now and wants the next
 * beat held back for `run()`'s return value in milliseconds.
 */
export interface Beat {
  run: () => number | void
  label?: string
}

/**
 * Plays beats one after another. A game's scene turns each new state into
 * beats ("walk these squares", "knock that piece home", "count the money")
 * so they play in order even when the server sends three states at once.
 *
 * When a backlog builds up — a reconnect, a burst of bot moves, a tab that was
 * hidden — `speed` rises so the board catches up instead of falling further
 * behind; hand it to the tweens (`tweens.speed = queue.speed`).
 */
export function createQueue({ catchUpAfter = 2, catchUpSpeed = 2.5 } = {}) {
  const beats: Beat[] = []
  const idle = new Set<() => void>()
  let hold = 0,
    running = false
  const api = {
    get speed() {
      return beats.length > catchUpAfter ? catchUpSpeed : 1
    },
    get busy() {
      return running || beats.length > 0
    },
    get length() {
      return beats.length
    },
    push(...next: Beat[]) {
      beats.push(...next)
      if (!running) advance()
    },
    /** Advances the current hold; returns whether the queue still has work. */
    step(dtMs: number) {
      if (!running) return false
      hold -= dtMs * api.speed
      if (hold <= 0) advance()
      return api.busy
    },
    /**
     * Runs every waiting beat immediately. Pair it with `tweens.finishAll()`
     * so the board lands in the final state: for reduced motion, and when a
     * fresh snapshot makes the queued story irrelevant.
     */
    flush() {
      for (let guard = 0; guard < 256 && beats.length; guard++) beats.shift()!.run()
      hold = 0
      settle()
    },
    clear() {
      beats.length = 0
      hold = 0
      settle()
    },
    /** Fires every time the queue runs dry. Returns an unsubscribe. */
    onIdle(callback: () => void) {
      idle.add(callback)
      return () => void idle.delete(callback)
    },
  }
  function advance() {
    while (beats.length) {
      running = true
      const wait = beats.shift()!.run() || 0
      if (wait > 0) {
        hold = wait
        return
      }
    }
    settle()
  }
  function settle() {
    const was = running
    running = false
    if (was || !beats.length) for (const callback of [...idle]) callback()
  }
  return api
}
export type Queue = ReturnType<typeof createQueue>
