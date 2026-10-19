import { decodeJwt, verifyJwt } from '@clerk/backend/jwt'
import type { PlayerInfo } from '@games/shared/protocol'
import type { Env } from './env'
import { allowedOrigin } from './cors'

export interface Credentials {
  name?: unknown
  guestId?: unknown
  clerkToken?: unknown
  avatar?: unknown
}

/**
 * Checks a Clerk session token and answers its claims, or throws. `local` says
 * the Worker is a dev server (see `isLocalWorker`), which also admits tokens
 * minted for a localhost page.
 */
export type Verifier = (token: string, env: Env, local: boolean) => Promise<{ sub: string }>

const GUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CLERK_AVATAR_HOST = 'https://img.clerk.com/'

/** The longest display name, in code points (never splitting a character someone sees as one). */
export const MAX_NAME_POINTS = 24

/**
 * Characters a name may not carry: controls, formatting characters (bidi
 * overrides and isolates, zero-width spaces, soft hyphens, tag characters) and
 * the other default-ignorables, which draw as nothing — plus the braille blank,
 * which draws as a space without being one. Kept: the two joiners that emoji
 * sequences and Persian or Indic names are built with, and the variation
 * selectors that choose an emoji's presentation.
 */
const INVISIBLE = /(?![‌‍︀-️])[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}⠀]/gu
const JOINERS = /[‌‍]/
const graphemes =
  typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null

/** Whole characters as a reader sees them, up to `MAX_NAME_POINTS` code points between them. */
function capLength(name: string): string {
  const parts = graphemes ? Array.from(graphemes.segment(name), (part) => part.segment) : [...name]
  let out = '',
    points = 0
  for (const part of parts) {
    const size = [...part].length
    if (points + size > MAX_NAME_POINTS) break
    out += part
    points += size
  }
  return out
}

/**
 * A display name as every other person at the table will see it, or null when
 * nothing printable is left. Names are free text from strangers that reach the
 * lobby, other players' screens, profiles and lock-screen notifications, so
 * this is the one gate all of them pass: NFC, one space between words, nothing
 * invisible or direction-changing, no tower of stacked accents, and at most
 * `MAX_NAME_POINTS` code points without cutting a character in half.
 */
export function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = capLength(
    value
      .normalize('NFC')
      .replace(/\s+/g, ' ')
      .replace(INVISIBLE, '')
      // Three marks covers every script's real clusters; a hundred is Zalgo.
      .replace(/(\p{M}{3})\p{M}+/gu, '$1')
      // A joiner only means something between two characters.
      .replace(/[‌‍]{2,}/g, (run) => run[0])
      .replace(/(^|\s)[‌‍]+|[‌‍]+(?=\s|$)/g, '$1')
      .trim(),
  )
    .replace(/[‌‍]+$/, '')
    .trim()
  return /[\p{L}\p{N}\p{S}\p{P}]/u.test(name.replace(JOINERS, '')) ? name : null
}

/** How long a fetched Clerk key set is trusted before it is fetched again. */
export const JWKS_TTL_MS = 60 * 60 * 1000
/**
 * How often a token signed with a key the set has never heard of may make the
 * Worker fetch the set again. Clerk rotates keys rarely; a forged token can
 * name any key id it likes, and without this every one of them was a call to
 * Clerk's API made with the secret key.
 */
export const JWKS_RETRY_MS = 5 * 60 * 1000

/**
 * Clerk's signing keys, fetched once and kept: per isolate, by key id. A token
 * whose key is in the set verifies with no network at all; one whose key is
 * not may refresh the set at most once per `JWKS_RETRY_MS`, and concurrent
 * misses share that one fetch.
 */
export class ClerkKeys {
  private keys = new Map<string, JsonWebKey>()
  private fetchedAt = -Infinity
  private triedAt = -Infinity
  private inflight: Promise<void> | null = null

  constructor(
    private fetcher: typeof fetch = (input, init) => fetch(input, init),
    private clock: () => number = Date.now,
  ) {}

  async key(kid: string, secretKey: string): Promise<JsonWebKey | null> {
    const now = this.clock()
    const fresh = now - this.fetchedAt < JWKS_TTL_MS
    if (fresh && this.keys.has(kid)) return this.keys.get(kid)!
    if (!fresh || now - this.triedAt >= JWKS_RETRY_MS) await this.refresh(secretKey)
    return this.keys.get(kid) ?? null
  }

  private refresh(secretKey: string): Promise<void> {
    this.inflight ??= (async () => {
      // Stamped before the call, so a Clerk outage is asked about once a window too.
      this.triedAt = this.clock()
      try {
        const response = await this.fetcher('https://api.clerk.com/v1/jwks', {
          headers: { Authorization: `Bearer ${secretKey}` },
        })
        if (!response.ok) return void (await response.body?.cancel())
        const { keys } = (await response.json()) as { keys?: (JsonWebKey & { kid?: string })[] }
        if (!Array.isArray(keys) || !keys.length) return
        // A key that left the set is gone: Clerk no longer signs with it.
        this.keys = new Map(keys.filter((key) => typeof key.kid === 'string').map((key) => [key.kid!, key]))
        this.fetchedAt = this.clock()
      } catch {
        // Unreachable: keep whatever keys were already here, and try again next window.
      } finally {
        this.inflight = null
      }
    })()
    return this.inflight
  }
}

const clerkKeys = new ClerkKeys()

/**
 * A Clerk session token's claims, verified without a network call per token.
 * With `CLERK_JWT_KEY` (the instance's PEM public key) it never touches the
 * network at all; otherwise the key comes from the cached set above.
 *
 * `azp` names the page origin the token was minted for. Clerk checks the
 * signature and the clock; this also refuses a token minted for any page but
 * the site's own (and localhost against a dev server), so a token from another
 * app on the same Clerk instance does not count here.
 */
export async function verifyClerkToken(
  token: string,
  env: Env,
  local: boolean,
  keys: ClerkKeys = clerkKeys,
): Promise<{ sub: string }> {
  let key: JsonWebKey | string | null = env.CLERK_JWT_KEY || null
  if (!key) {
    const kid = decodeJwt(token).header.kid
    if (!kid || !env.CLERK_SECRET_KEY) throw new Error('no key to verify with')
    key = await keys.key(kid, env.CLERK_SECRET_KEY)
    if (!key) throw new Error('unknown signing key')
  }
  const payload = await verifyJwt(token, { key })
  if (typeof payload.azp === 'string' && !allowedOrigin(payload.azp, local))
    throw new Error('token minted for another site')
  return payload
}

/**
 * Who a set of credentials belongs to, without anything cosmetic: the verified
 * Clerk `sub`, or the guest UUID. This is the trusted identity — the key a
 * room seats people by and a player's record is kept under.
 */
export async function resolvePlayerId(
  cred: Credentials,
  env: Env,
  verify: Verifier = verifyClerkToken,
  local = false,
): Promise<{ id: string; isGuest: boolean } | null> {
  if (typeof cred.clerkToken === 'string' && cred.clerkToken) {
    if (!env.CLERK_SECRET_KEY && !env.CLERK_JWT_KEY) return null
    // A session token is a few hundred bytes; anything far past that is not one.
    if (cred.clerkToken.length > 4096) return null
    try {
      const payload = await verify(cred.clerkToken, env, local)
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
  verify: Verifier = verifyClerkToken,
  local = false,
): Promise<PlayerInfo | null> {
  const name = cleanName(cred.name)
  if (!name) return null
  const who = await resolvePlayerId(cred, env, verify, local)
  if (!who) return null
  if (who.isGuest) return { id: who.id, name, isGuest: true }
  const avatar = cleanAvatar(cred.avatar)
  return { id: who.id, name, ...(avatar ? { avatar } : {}), isGuest: false }
}

export const cleanAvatar = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length <= 2048 && value.startsWith(CLERK_AVATAR_HOST) ? value : undefined

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
