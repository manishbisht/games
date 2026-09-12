import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { cleanName, resolveIdentity } from '../src/auth'
import type { Env } from '../src/env'

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
      await resolveIdentity({ name: 'Ann', clerkToken: 'jwt', avatar: 'https://evil.example/x' }, withEnv, verify),
    ).toEqual({ id: 'clerk:user_123', name: 'Ann', isGuest: false })
  })
  it('rejects Clerk tokens when verification fails or no secret is configured', async () => {
    const boom = async () => {
      throw new Error('bad token')
    }
    const withEnv = { ...testEnv, CLERK_SECRET_KEY: 'sk_test' } as unknown as Env
    expect(await resolveIdentity({ name: 'Ann', clerkToken: 'jwt' }, withEnv, boom)).toBeNull()
    expect(
      await resolveIdentity({ name: 'Ann', clerkToken: 'jwt' }, { ...testEnv, CLERK_SECRET_KEY: undefined } as unknown as Env),
    ).toBeNull()
  })
})
