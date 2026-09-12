import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { guestId, guestName, saveGuestName } from './guest'

describe('guest identity', () => {
  let records: Map<string, string>
  beforeEach(() => {
    records = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => records.get(k) ?? null,
      setItem: (k: string, v: string) => records.set(k, v),
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('creates a UUID once and keeps it stable', () => {
    const id = guestId()
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(guestId()).toBe(id)
  })

  it('stores and trims the display name', () => {
    expect(guestName()).toBe('')
    saveGuestName('  Ada Lovelace  ')
    expect(guestName()).toBe('Ada Lovelace')
    saveGuestName('x'.repeat(40))
    expect(guestName()).toHaveLength(24)
  })
})
