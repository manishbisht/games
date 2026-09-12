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
 * The verified Clerk `sub` (or the guest UUID) is the trusted identity; the
 * display name is cosmetic and always taken from the client. Avatars are only
 * accepted from Clerk's image host so clients cannot inject arbitrary URLs.
 */
export async function resolveIdentity(
  cred: Credentials,
  env: Env,
  verify: Verifier = verifyToken as unknown as Verifier,
): Promise<PlayerInfo | null> {
  const name = cleanName(cred.name)
  if (!name) return null
  if (typeof cred.clerkToken === 'string' && cred.clerkToken) {
    if (!env.CLERK_SECRET_KEY) return null
    try {
      const payload = await verify(cred.clerkToken, { secretKey: env.CLERK_SECRET_KEY })
      if (!payload.sub) return null
      const avatar =
        typeof cred.avatar === 'string' && cred.avatar.startsWith(CLERK_AVATAR_HOST) ? cred.avatar : undefined
      return { id: `clerk:${payload.sub}`, name, ...(avatar ? { avatar } : {}), isGuest: false }
    } catch {
      return null
    }
  }
  if (typeof cred.guestId === 'string' && GUEST_ID.test(cred.guestId))
    return { id: `guest:${cred.guestId.toLowerCase()}`, name, isGuest: true }
  return null
}
