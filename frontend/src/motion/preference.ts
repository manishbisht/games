import { useSyncExternalStore } from 'react'

/**
 * The one answer to "should this move?" for the whole site. `system` follows
 * the OS setting live; `full` and `reduced` are the visitor's override, saved
 * like the appearance setting. Reduced never means frozen: a game shortens and
 * softens its motion (fades, short slides) rather than teleporting, so what
 * happened is still readable.
 *
 * CSS reads it from `<html data-motion="full|reduced">`, which this module
 * keeps current, rather than from the media query, so the override applies to
 * stylesheets too.
 */
export type MotionPreference = 'system' | 'full' | 'reduced'
const STORAGE_KEY = 'games-motion'
const listeners = new Set<() => void>()
const media =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null

function read(): MotionPreference {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved === 'full' || saved === 'reduced' ? saved : 'system'
  } catch {
    return 'system'
  }
}

let preference: MotionPreference = typeof window === 'undefined' ? 'system' : read()

function reflect() {
  if (typeof document !== 'undefined')
    document.documentElement.dataset.motion = reducedMotion() ? 'reduced' : 'full'
}
function emit() {
  reflect()
  for (const listener of [...listeners]) listener()
}

media?.addEventListener('change', emit)
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) return
    preference = read()
    emit()
  })
  reflect()
}

export function motionPreference() {
  return preference
}

export function setMotionPreference(next: MotionPreference) {
  preference = next
  try {
    localStorage.setItem(STORAGE_KEY, next)
  } catch {
    // Still applies for this visit.
  }
  emit()
}

/** Read it fresh every time it matters; it can change mid-game. */
export function reducedMotion() {
  return preference === 'system' ? Boolean(media?.matches) : preference === 'reduced'
}

/** Subscribe from a scene (outside React). Returns an unsubscribe. */
export function onMotionChange(listener: () => void) {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

const subscribe = (listener: () => void) => onMotionChange(listener)

export function useReducedMotion() {
  return useSyncExternalStore(subscribe, reducedMotion, () => false)
}

export function useMotionPreference() {
  const value = useSyncExternalStore(subscribe, motionPreference, () => 'system' as const)
  return [value, setMotionPreference] as const
}
