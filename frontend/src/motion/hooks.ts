import { useEffect, useRef, useState } from 'react'
import { outCubic } from './ease'
import { reducedMotion } from './preference'

/**
 * A number that counts to its new value instead of jumping — money, a score, a
 * square on the board. Under reduced motion it jumps. `ms` scales down for
 * small changes so a +1 doesn't crawl.
 */
export function useCountUp(value: number, ms = 650) {
  const [shown, setShown] = useState(value)
  const current = useRef(value)
  useEffect(() => {
    const from = current.current
    if (from === value) return
    const distance = Math.abs(value - from),
      duration = reducedMotion() ? 0 : Math.min(ms, 220 + Math.sqrt(distance) * 40),
      start = performance.now()
    let frame = 0
    const tick = (now: number) => {
      const t = duration ? Math.min(1, (now - start) / duration) : 1
      current.current = Math.round(from + (value - from) * outCubic(t))
      setShown(current.current)
      if (t < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [value, ms])
  return shown
}

/**
 * `when`, but only after it has held true for `ms` — so a win dialog waits for
 * the 3D celebration it would otherwise cover. Falls back immediately.
 */
export function useHeld(when: boolean, ms: number) {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    if (!when) return
    const timer = setTimeout(() => setHeld(true), reducedMotion() ? 0 : ms)
    return () => {
      clearTimeout(timer)
      setHeld(false)
    }
  }, [when, ms])
  return when && held
}
