const ID_KEY = 'games-guest-id'
const NAME_KEY = 'games-guest-name'
const PRESENCE_KEY = 'games-presence-id'

export function guestId(): string {
  let id = localStorage.getItem(ID_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(ID_KEY, id)
  }
  return id
}

let memoryPresenceId: string | undefined

/**
 * Who the "N online" count sees: one browser, counted once across its tabs.
 * Its own random id, never the guest id — that is the credential a guest plays
 * as, and presence keeps what it is sent in storage of its own.
 */
export function presenceId(): string {
  try {
    let id = localStorage.getItem(PRESENCE_KEY)
    if (!id) {
      id = crypto.randomUUID()
      localStorage.setItem(PRESENCE_KEY, id)
    }
    return id
  } catch {
    return (memoryPresenceId ??= crypto.randomUUID())
  }
}

export function guestName(): string {
  return localStorage.getItem(NAME_KEY) ?? ''
}

export function saveGuestName(name: string): void {
  localStorage.setItem(NAME_KEY, name.trim().slice(0, 24).trim())
}
