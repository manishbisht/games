import { env } from 'cloudflare:test'
import { signJwt } from '@clerk/backend/jwt'
import { describe, expect, it } from 'vitest'
import {
  ClerkKeys,
  cleanName,
  JWKS_RETRY_MS,
  JWKS_TTL_MS,
  resolveIdentity,
  verifyClerkToken,
} from '../src/auth'
import type { Env } from '../src/env'
import { joinedMessage } from '../src/ledger'

const GUEST = '01234567-89ab-4cde-8f01-23456789abcd'
const testEnv = env as unknown as Env

describe('cleanName', () => {
  it('trims, collapses whitespace, caps at 24 chars', () => {
    expect(cleanName('  Ada   Lovelace  ')).toBe('Ada Lovelace')
    expect(cleanName('x'.repeat(40))).toBe('x'.repeat(24))
  })
  it('rejects empty and non-strings', () => {
    expect(cleanName('   ')).toBeNull()
    expect(cleanName(42)).toBeNull()
    expect(cleanName(undefined)).toBeNull()
  })
  it('strips what draws as nothing or turns the text around', () => {
    // Right-to-left override: "Ann\u202Egnp.exe" would read as "Annexe.png".
    expect(cleanName('Ann\u202Egnp.exe')).toBe('Anngnp.exe')
    expect(cleanName('\u2066Ben\u2069')).toBe('Ben')
    expect(cleanName('Z\u200Bo\u200Be')).toBe('Zoe')
    expect(cleanName('Cy\u0000\u0007\u007F')).toBe('Cy')
    expect(cleanName('Soft\u00ADhyphen')).toBe('Softhyphen')
    // Names that are nothing but invisible characters are no names at all.
    for (const blank of ['\u200B\u200B', '\u3164', '\u2800\u2800', '\u202E', '\u200D', '\uFEFF'])
      expect(cleanName(blank)).toBeNull()
  })
  it('keeps the joiners and selectors real names and emoji are made of', () => {
    expect(cleanName('👩\u200D💻 Dev')).toBe('👩\u200D💻 Dev')
    expect(cleanName('❤\uFE0F')).toBe('❤\uFE0F')
    expect(cleanName('می\u200Cخواهم')).toBe('می\u200Cخواهم')
    // …but not a joiner that joins nothing.
    expect(cleanName('\u200DAnn\u200D')).toBe('Ann')
  })
  it('composes to NFC, and keeps accents to a sane height', () => {
    expect(cleanName('Zoe\u0301')).toBe('Zoé')
    expect(cleanName('Zoe\u0301')!.length).toBe(3)
    expect(cleanName('Z' + '\u0336'.repeat(40))).toBe('Z' + '\u0336'.repeat(3))
  })
  it('caps by characters as a reader counts them, never splitting one', () => {
    expect([...cleanName('😀'.repeat(30))!]).toHaveLength(24)
    // A family is one character of several code points: it fits whole or not at all.
    const family = '👨\u200D👩\u200D👧'
    const name = cleanName('x'.repeat(22) + family)!
    expect(name).toBe('x'.repeat(22))
    expect(cleanName('x'.repeat(19) + family)).toBe('x'.repeat(19) + family)
  })
  it('cleans a joiner\u2019s name before it reaches a lock screen', () => {
    expect(joinedMessage('chess', 'ABC234', '\u202Eevil').title).toBe('evil joined your table')
    expect(joinedMessage('chess', 'ABC234', '\u200B').title).toBe('Someone joined your table')
    expect(joinedMessage('chess', 'ABC234', 'y'.repeat(80)).title).toBe(`${'y'.repeat(24)} joined your table`)
  })
})

describe('resolveIdentity', () => {
  it('accepts a guest with a UUID and namespaces the id', async () => {
    const player = await resolveIdentity({ name: 'Ann', guestId: GUEST.toUpperCase() }, testEnv)
    expect(player).toEqual({ id: `guest:${GUEST}`, name: 'Ann', isGuest: true })
  })
  it('rejects malformed guest ids and missing names', async () => {
    expect(await resolveIdentity({ name: 'Ann', guestId: 'nope' }, testEnv)).toBeNull()
    expect(await resolveIdentity({ name: '  ', guestId: GUEST }, testEnv)).toBeNull()
  })
  it('verifies Clerk tokens and keeps only Clerk-hosted avatars', async () => {
    const verify = async () => ({ sub: 'user_123' })
    const withEnv = { ...testEnv, CLERK_SECRET_KEY: 'sk_test' } as unknown as Env
    expect(
      await resolveIdentity(
        { name: 'Ann', clerkToken: 'jwt', avatar: 'https://img.clerk.com/abc' },
        withEnv,
        verify,
      ),
    ).toEqual({ id: 'clerk:user_123', name: 'Ann', avatar: 'https://img.clerk.com/abc', isGuest: false })
    expect(
      await resolveIdentity(
        { name: 'Ann', clerkToken: 'jwt', avatar: 'https://evil.example/x' },
        withEnv,
        verify,
      ),
    ).toEqual({ id: 'clerk:user_123', name: 'Ann', isGuest: false })
  })
  it('rejects Clerk tokens when verification fails or no secret is configured', async () => {
    const boom = async () => {
      throw new Error('bad token')
    }
    const withEnv = { ...testEnv, CLERK_SECRET_KEY: 'sk_test' } as unknown as Env
    expect(await resolveIdentity({ name: 'Ann', clerkToken: 'jwt' }, withEnv, boom)).toBeNull()
    expect(
      await resolveIdentity({ name: 'Ann', clerkToken: 'jwt' }, {
        ...testEnv,
        CLERK_SECRET_KEY: undefined,
      } as unknown as Env),
    ).toBeNull()
  })
})

/** A Clerk-shaped RSA key pair: the public half as a JWKS entry, the private half to sign with. */
async function signingKey(kid: string) {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey
  const privateJwk = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey
  const spki = new Uint8Array((await crypto.subtle.exportKey('spki', pair.publicKey)) as ArrayBuffer)
  const pem = `-----BEGIN PUBLIC KEY-----\n${btoa(String.fromCharCode(...spki))}\n-----END PUBLIC KEY-----`
  const sign = (claims: Record<string, unknown>, headerKid = kid) =>
    signJwt(
      {
        sub: 'user_abc',
        exp: Math.floor(Date.now() / 1000) + 60,
        nbf: Math.floor(Date.now() / 1000) - 5,
        ...claims,
      },
      privateJwk,
      { algorithm: 'RS256', header: { typ: 'JWT', kid: headerKid } },
    )
  return { jwk: { ...publicJwk, kid, alg: 'RS256', use: 'sig' }, pem, sign }
}

/** A stand-in for Clerk's JWKS endpoint that counts how often it is asked. */
function fakeClerk(keys: JsonWebKey[]) {
  const calls: string[] = []
  let clock = 1_000_000
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(`${String(input)} ${new Headers(init?.headers).get('Authorization')}`)
    return Response.json({ keys })
  }) as typeof fetch
  return { calls, keys: new ClerkKeys(fetcher, () => clock), tick: (ms: number) => (clock += ms) }
}

const clerkEnv = { ...testEnv, CLERK_SECRET_KEY: 'sk_test_x', CLERK_JWT_KEY: undefined } as unknown as Env

describe('Clerk tokens', () => {
  it('verifies against a key set fetched once, not once per token', async () => {
    const key = await signingKey('ins_1')
    const clerk = fakeClerk([key.jwk])
    for (let i = 0; i < 5; i++)
      expect(await verifyClerkToken(await key.sign({}), clerkEnv, false, clerk.keys)).toMatchObject({
        sub: 'user_abc',
      })
    expect(clerk.calls).toEqual(['https://api.clerk.com/v1/jwks Bearer sk_test_x'])
  })

  it('lets forged key ids refresh the set at most once a window', async () => {
    const key = await signingKey('ins_1')
    const clerk = fakeClerk([key.jwk])
    await verifyClerkToken(await key.sign({}), clerkEnv, false, clerk.keys)
    // A stream of tokens naming keys nobody has: refused, and Clerk is asked again only once.
    const forged = await Promise.allSettled(
      Array.from({ length: 50 }, async (_, i) =>
        verifyClerkToken(await key.sign({}, `forged_${i}`), clerkEnv, false, clerk.keys),
      ),
    )
    expect(forged.every((result) => result.status === 'rejected')).toBe(true)
    expect(clerk.calls).toHaveLength(1)
    clerk.tick(JWKS_RETRY_MS)
    await expect(
      verifyClerkToken(await key.sign({}, 'forged_x'), clerkEnv, false, clerk.keys),
    ).rejects.toThrow()
    expect(clerk.calls).toHaveLength(2)
    // A real token still verifies throughout, from the set already held.
    await verifyClerkToken(await key.sign({}), clerkEnv, false, clerk.keys)
    expect(clerk.calls).toHaveLength(2)
    // And the set is fetched afresh once it is an hour old.
    clerk.tick(JWKS_TTL_MS)
    await verifyClerkToken(await key.sign({}), clerkEnv, false, clerk.keys)
    expect(clerk.calls).toHaveLength(3)
  })

  it('refuses a token minted for another site, and a bad signature', async () => {
    const key = await signingKey('ins_1')
    const other = await signingKey('ins_1')
    const clerk = fakeClerk([key.jwk])
    const verify = (token: string, local = false) => verifyClerkToken(token, clerkEnv, local, clerk.keys)
    expect(await verify(await key.sign({ azp: 'https://games.manishbisht.me' }))).toMatchObject({
      sub: 'user_abc',
    })
    await expect(verify(await key.sign({ azp: 'https://evil.example' }))).rejects.toThrow()
    // A localhost page's token counts only against a dev server.
    await expect(verify(await key.sign({ azp: 'http://localhost:5173' }))).rejects.toThrow()
    expect(await verify(await key.sign({ azp: 'http://localhost:5173' }), true)).toMatchObject({
      sub: 'user_abc',
    })
    await expect(verify(await other.sign({}))).rejects.toThrow()
    await expect(verify(await key.sign({ exp: Math.floor(Date.now() / 1000) - 600 }))).rejects.toThrow()
  })

  it('needs no network at all with the instance’s public key configured', async () => {
    const key = await signingKey('ins_1')
    const clerk = fakeClerk([])
    const withKey = { ...clerkEnv, CLERK_JWT_KEY: key.pem } as unknown as Env
    expect(await verifyClerkToken(await key.sign({}), withKey, false, clerk.keys)).toMatchObject({
      sub: 'user_abc',
    })
    expect(clerk.calls).toEqual([])
    const player = await resolveIdentity({ name: 'Ann', clerkToken: await key.sign({}) }, withKey)
    expect(player).toEqual({ id: 'clerk:user_abc', name: 'Ann', isGuest: false })
  })
})
