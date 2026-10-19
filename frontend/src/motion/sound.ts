import { useSyncExternalStore } from 'react'

/**
 * Whether a game's sound is on, remembered per game. Kept in a module of its
 * own (like haptics) so a header can show the toggle without loading the audio
 * engine, and in storage rather than component state, so muting a game on its
 * setup screen still holds once the table opens — which is a different page,
 * and a fresh mount.
 */
const key = (game: string) => `games-sound-${game}`
const listeners = new Set<() => void>()

function read(game: string, fallback: boolean) {
  try {
    const saved = localStorage.getItem(key(game))
    return saved === null ? fallback : saved === 'on'
  } catch {
    return fallback
  }
}

/** Stored for next time; a page without storage keeps it for this visit only. */
const session = new Map<string, boolean>()

export function soundOn(game: string, fallback = true) {
  return session.get(game) ?? read(game, fallback)
}

export function setSoundOn(game: string, on: boolean) {
  session.set(game, on)
  try {
    localStorage.setItem(key(game), on ? 'on' : 'off')
  } catch {
    // Remembered in `session` instead.
  }
  for (const listener of [...listeners]) listener()
}

if (typeof window !== 'undefined')
  window.addEventListener('storage', (event) => {
    if (!event.key?.startsWith('games-sound-') && event.key !== null) return
    session.clear()
    for (const listener of [...listeners]) listener()
  })

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** `[on, setOn]` for one game's sound; `fallback` is the first-visit default. */
export function useSound(game: string, fallback = true) {
  const on = useSyncExternalStore(
    subscribe,
    () => soundOn(game, fallback),
    () => fallback,
  )
  return [on, (next: boolean) => setSoundOn(game, next)] as const
}
