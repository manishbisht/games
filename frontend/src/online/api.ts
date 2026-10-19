import type {
  GameId,
  MyProfile,
  PublicProfile,
  PublicRoomSummary,
  RoomVisibility,
} from '@games/shared/protocol'

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
  // The server limits how fast one address may make rooms; say so, rather
  // than suggesting the service is down.
  if (res.status === 429) throw new Error('That’s a lot of rooms at once. Try again in a minute.')
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

export async function presenceBeat(clientId: string, tabId: string, game?: string): Promise<PresenceCounts> {
  const res = await fetch(`${API_URL}/api/presence`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId, tabId, ...(game ? { game } : {}) }),
  })
  if (!res.ok) throw new Error('Could not report presence.')
  return (await res.json()) as PresenceCounts
}

/**
 * Who a plain request speaks for, as headers rather than a query string — a
 * guest id is the credential a guest plays as, and URLs end up in logs. The
 * same two things a room socket's join carries.
 */
function authHeaders(credentials: IdentityCredentials): Record<string, string> {
  if (credentials.clerkToken) return { Authorization: `Bearer ${credentials.clerkToken}` }
  return credentials.guestId ? { 'X-Guest-Id': credentials.guestId } : {}
}

/** This player's own record: stats, rating, history with room codes, and the tables they are at. */
export async function fetchMe(credentials: IdentityCredentials, signal?: AbortSignal): Promise<MyProfile> {
  const res = await fetch(`${API_URL}/api/me`, { headers: authHeaders(credentials), signal })
  if (!res.ok) throw new Error('Could not load your games.')
  return (await res.json()) as MyProfile
}

/** Anyone's public profile by handle, or null when nobody has played under it. */
export async function fetchPlayer(handle: string, signal?: AbortSignal): Promise<PublicProfile | null> {
  const res = await fetch(`${API_URL}/api/players/${encodeURIComponent(handle)}`, { signal })
  if (res.status === 404) return null
  if (!res.ok) throw new Error('Could not load this player.')
  return (await res.json()) as PublicProfile
}

/** The server's Web Push key, or null when it has none configured (and so will never send). */
export async function fetchPushKey(): Promise<string | null> {
  const res = await fetch(`${API_URL}/api/push/key`)
  if (!res.ok) return null
  return ((await res.json()) as { key: string | null }).key
}

export async function savePushSubscription(
  credentials: IdentityCredentials,
  subscription: PushSubscriptionJSON,
): Promise<void> {
  const res = await fetch(`${API_URL}/api/push/subscription`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(credentials) },
    body: JSON.stringify({ subscription }),
  })
  if (!res.ok) throw new Error('Could not turn on notifications.')
}

export async function deletePushSubscription(
  credentials: IdentityCredentials,
  endpoint: string,
): Promise<void> {
  const res = await fetch(`${API_URL}/api/push/subscription`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', ...authHeaders(credentials) },
    body: JSON.stringify({ endpoint }),
  })
  if (!res.ok) throw new Error('Could not turn off notifications.')
}
