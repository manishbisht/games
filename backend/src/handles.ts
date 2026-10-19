/**
 * A player's public name for links: `/#/player/<handle>`. Derived from their
 * private id (`guest:<uuid>` or `clerk:<sub>`) by a one-way hash, so a profile
 * link can be shared freely without handing anyone the id — which, for a guest,
 * is the credential they play as.
 *
 * Unkeyed on purpose. A guest id is a random UUID (122 bits), so there is
 * nothing to guess backwards from its handle, and a Clerk `sub` is not a secret
 * to begin with. With no key there is nothing to configure or rotate, and a
 * handle never changes underneath a link someone has already shared.
 *
 * The handle is also the name of the player's Durable Object, so a profile is
 * looked up by the very thing in the URL and the id never needs an index.
 */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
export const HANDLE_LENGTH = 16
const HANDLE = new RegExp(`^[${ALPHABET}]{${HANDLE_LENGTH}}$`)

export async function playerHandle(playerId: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`games-player:${playerId}`)),
  )
  // Base32 of the first 80 bits: sixteen characters, case-free, URL-safe.
  let bits = 0,
    value = 0,
    out = ''
  for (const byte of digest) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5 && out.length < HANDLE_LENGTH) {
      out += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
    if (out.length === HANDLE_LENGTH) break
  }
  return out
}

export const validHandle = (raw: unknown): raw is string => typeof raw === 'string' && HANDLE.test(raw)

/** Bots sit at tables but are nobody: no record, no handle, no profile. */
export const isPerson = (playerId: string) => playerId.startsWith('guest:') || playerId.startsWith('clerk:')
