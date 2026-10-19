import { useSyncExternalStore } from 'react'

/* Haptics: a felt tap on phones, for impacts that matter. */
const HAPTICS_KEY = 'games-haptics'
const hapticListeners = new Set<() => void>()
function readHaptics() {
  try {
    return localStorage.getItem(HAPTICS_KEY) !== 'off'
  } catch {
    return true
  }
}
let hapticsOn = typeof window === 'undefined' ? false : readHaptics()

/** Whether this device can buzz at all (phones and tablets with vibration). */
export const canVibrate = () =>
  typeof navigator !== 'undefined' &&
  typeof navigator.vibrate === 'function' &&
  window.matchMedia('(pointer: coarse)').matches

/**
 * A short buzz, in milliseconds or a pattern. Silently nothing on desktops,
 * on iOS (no vibration API), before the first gesture, or when switched off.
 */
export function haptic(pattern: number | number[] = 12) {
  // Browsers ignore vibration before the first gesture anyway; don't ask.
  const active = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation
  if (!hapticsOn || active?.hasBeenActive === false || !canVibrate()) return
  try {
    navigator.vibrate(pattern)
  } catch {
    // Some browsers throw rather than ignore when the page is not active.
  }
}

export function setHaptics(on: boolean) {
  hapticsOn = on
  try {
    localStorage.setItem(HAPTICS_KEY, on ? 'on' : 'off')
  } catch {
    // Applies for this visit.
  }
  for (const listener of [...hapticListeners]) listener()
}

const subscribeHaptics = (listener: () => void) => {
  hapticListeners.add(listener)
  return () => void hapticListeners.delete(listener)
}
export function useHaptics() {
  const on = useSyncExternalStore(
    subscribeHaptics,
    () => hapticsOn,
    () => false,
  )
  return [on, setHaptics] as const
}
