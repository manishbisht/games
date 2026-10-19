import { verifyToken } from '@clerk/backend'
import type { PlayerInfo } from '@games/shared/protocol'
import type { Env } from './env'

export interface Credentials {
  name?: unknown
  guestId?: unknown
  clerkToken?: unknown
  avatar?: unknown
}

type Verifier = (token: string, options: { secretKey: string }) => Promise<{ sub: string }>

const GUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CLERK_AVATAR_HOST = 'https://img.clerk.com/'

export function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.replace(/\s+/g, ' ').trim().slice(0, 24).trim()
  return name.length ? name : null
}

/**
 * Who a set of credentials belongs to, without anything cosmetic: the verified
 * Clerk `sub`, or the guest UUID. This is the trusted identity — the key a
 * room seats people by and a player's record is kept under.
 */
export async function resolvePlayerId(
  cred: Credentials,
  env: Env,
  verify: Verifier = verifyToken as unknown as Verifier,
): Promise<{ id: string; isGuest: boolean } | null> {
  if (typeof cred.clerkToken === 'string' && cred.clerkToken) {
    if (!env.CLERK_SECRET_KEY) return null
    try {
      const payload = await verify(cred.clerkToken, { secretKey: env.CLERK_SECRET_KEY })
      return payload.sub ? { id: `clerk:${payload.sub}`, isGuest: false } : null
    } catch {
      return null
    }
  }
  if (typeof cred.guestId === 'string' && GUEST_ID.test(cred.guestId))
    return { id: `guest:${cred.guestId.toLowerCase()}`, isGuest: true }
  return null
}

/**
 * The display name is cosmetic and always taken from the client. Avatars are
 * only accepted from Clerk's image host so clients cannot inject arbitrary URLs.
 */
export async function resolveIdentity(
  cred: Credentials,
  env: Env,
  verify: Verifier = verifyToken as unknown as Verifier,
): Promise<PlayerInfo | null> {
  const name = cleanName(cred.name)
  if (!name) return null
  const who = await resolvePlayerId(cred, env, verify)
  if (!who) return null
  if (who.isGuest) return { id: who.id, name, isGuest: true }
  const avatar = cleanAvatar(cred.avatar)
  return { id: who.id, name, ...(avatar ? { avatar } : {}), isGuest: false }
}

export const cleanAvatar = (value: unknown): string | undefined =>
  typeof value === 'string' && value.startsWith(CLERK_AVATAR_HOST) ? value : undefined

/**
 * Credentials for a plain HTTP request. Never the query string — a guest id is
 * a bearer credential and URLs end up in logs — so a signed-in player sends
 * `Authorization: Bearer <Clerk session token>` and a guest `X-Guest-Id`, the
 * same two things a room socket's join carries.
 */
export function requestCredentials(request: Request): Credentials {
  const bearer = request.headers.get('Authorization')?.match(/^Bearer\s+(\S+)$/i)?.[1]
  if (bearer) return { clerkToken: bearer }
  const guestId = request.headers.get('X-Guest-Id')
  return guestId ? { guestId } : {}
}
