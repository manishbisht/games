const ID_KEY = 'games-guest-id'
const NAME_KEY = 'games-guest-name'

export function guestId(): string {
  let id = localStorage.getItem(ID_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(ID_KEY, id)
  }
  return id
}

export function guestName(): string {
  return localStorage.getItem(NAME_KEY) ?? ''
}

export function saveGuestName(name: string): void {
  localStorage.setItem(NAME_KEY, name.trim().slice(0, 24).trim())
}
