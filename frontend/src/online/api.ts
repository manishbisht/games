import type { GameId, PublicRoomSummary, RoomVisibility } from '@games/shared/protocol'

// `||`, not `??`: CI passes unset repo variables through as empty strings.
export const API_URL: string = import.meta.env.VITE_API_URL || 'http://127.0.0.1:8787'

export interface IdentityCredentials {
  guestId?: string
  clerkToken?: string
  avatar?: string
}

/** What a table is made of, beyond who is asking for it. */
export interface RoomSetup {
  seats?: number
  /**
   * One skill id per bot seat, which the server validates against the game's
   * own adapter. Bots take the seats furthest from the host, so a table of
   * `seats` with `seats - 1` bots is a game for one person.
   */
  bots?: string[]
  /** Seat the host and deal the moment they arrive. Only meaningful with a full set of bots. */
  autoStart?: boolean
  /** The game's own table settings; each adapter narrows these for itself. */
  options?: unknown
}

export async function createRoom(
  game: GameId,
  visibility: RoomVisibility,
  name: string,
  credentials: IdentityCredentials,
  setup: RoomSetup = {},
): Promise<string> {
  const { seats, bots, autoStart, options } = setup
  const res = await fetch(`${API_URL}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      game,
      visibility,
      name,
      ...credentials,
      ...(seats ? { seats } : {}),
      ...(bots?.length ? { bots } : {}),
      ...(autoStart ? { autoStart: true } : {}),
      ...(options === undefined ? {} : { options }),
    }),
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

export interface PresenceCounts {
  total: number
  byGame: Record<string, number>
}

export async function presenceBeat(
  clientId: string,
  tabId: string,
  game?: string,
): Promise<PresenceCounts> {
  const res = await fetch(`${API_URL}/api/presence`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId, tabId, ...(game ? { game } : {}) }),
  })
  if (!res.ok) throw new Error('Could not report presence.')
  return (await res.json()) as PresenceCounts
}
