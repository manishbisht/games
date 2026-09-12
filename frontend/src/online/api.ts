import type { GameId, PublicRoomSummary, RoomVisibility } from '@games/shared/protocol'

// `||`, not `??`: CI passes unset repo variables through as empty strings.
export const API_URL: string = import.meta.env.VITE_API_URL || 'http://127.0.0.1:8787'

export interface IdentityCredentials {
  guestId?: string
  clerkToken?: string
  avatar?: string
}

export async function createRoom(
  game: GameId,
  visibility: RoomVisibility,
  name: string,
  credentials: IdentityCredentials,
): Promise<string> {
  const res = await fetch(`${API_URL}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ game, visibility, name, ...credentials }),
  })
  if (!res.ok) throw new Error('Could not create a room right now.')
  const { code } = (await res.json()) as { code: string }
  return code
}

export async function fetchLobby(game: GameId): Promise<PublicRoomSummary[]> {
  const res = await fetch(`${API_URL}/api/lobby?game=${game}`)
  if (!res.ok) throw new Error('Could not load open rooms.')
  return ((await res.json()) as { rooms: PublicRoomSummary[] }).rooms
}

export function roomSocketUrl(code: string): string {
  return `${API_URL.replace(/^http/, 'ws')}/api/rooms/${code}`
}
