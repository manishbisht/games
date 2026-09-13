import { SELF, env, runInDurableObject } from 'cloudflare:test'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Env } from '../src/env'

const testEnv = env as unknown as Env

// The PresenceDO singleton keeps its storage across tests, so start each
// test from an empty table to keep the exact-count assertions honest.
beforeEach(async () => {
  const stub = testEnv.PRESENCE.getByName('global')
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec('DELETE FROM presence')
  })
})

async function beat(body: unknown): Promise<Response> {
  return SELF.fetch('https://api.test/api/presence', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

async function counts(body: unknown): Promise<{ total: number; byGame: Record<string, number> }> {
  const res = await beat(body)
  expect(res.status).toBe(200)
  return res.json()
}

/** Age every stored beat so it falls outside the freshness window. */
async function backdateAll(ms: number): Promise<void> {
  const stub = testEnv.PRESENCE.getByName('global')
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec('UPDATE presence SET last_seen = ?', Date.now() - ms)
  })
}

describe('presence counts', () => {
  it('counts the very first visitor as one, with no game', async () => {
    const result = await counts({ clientId: 'client-aaaaaaaa', tabId: 'tab-11111111' })
    expect(result).toEqual({ total: 1, byGame: {} })
  })

  it('counts one person once globally while tracking each tab per game', async () => {
    await counts({ clientId: 'client-aaaaaaaa', tabId: 'tab-11111111', game: 'chess' })
    const both = await counts({ clientId: 'client-aaaaaaaa', tabId: 'tab-22222222', game: 'prism' })
    expect(both).toEqual({ total: 1, byGame: { chess: 1, prism: 1 } })
  })

  it('moves a tab off a game as soon as it re-beats without one', async () => {
    await counts({ clientId: 'client-aaaaaaaa', tabId: 'tab-11111111', game: 'chess' })
    const moved = await counts({ clientId: 'client-aaaaaaaa', tabId: 'tab-11111111' })
    expect(moved).toEqual({ total: 1, byGame: {} })
  })

  it('accepts wildrise even though it has no online play', async () => {
    const result = await counts({ clientId: 'client-aaaaaaaa', tabId: 'tab-11111111', game: 'wildrise' })
    expect(result.byGame).toEqual({ wildrise: 1 })
  })

  it('counts distinct people on the same game', async () => {
    await counts({ clientId: 'client-aaaaaaaa', tabId: 'tab-11111111', game: 'chess' })
    const second = await counts({ clientId: 'client-bbbbbbbb', tabId: 'tab-22222222', game: 'chess' })
    expect(second).toEqual({ total: 2, byGame: { chess: 2 } })
  })

  it('drops visitors whose last beat is older than the freshness window', async () => {
    await counts({ clientId: 'client-aaaaaaaa', tabId: 'tab-11111111', game: 'chess' })
    await backdateAll(91_000)
    const after = await counts({ clientId: 'client-bbbbbbbb', tabId: 'tab-22222222' })
    expect(after).toEqual({ total: 1, byGame: {} })
  })

  it('rejects malformed beats', async () => {
    const bad = [
      { tabId: 'tab-11111111' }, // missing clientId
      { clientId: 'short', tabId: 'tab-11111111' }, // too short
      { clientId: 'x'.repeat(65), tabId: 'tab-11111111' }, // too long
      { clientId: 'client-aaaaaaaa', tabId: 'tab-11111111', game: 'foo' }, // unknown game
      { clientId: 'client-aaaaaaaa', tabId: 'tab-11111111', game: '__proto__' }, // hostile key
    ]
    for (const body of bad) {
      const res = await beat(body)
      expect(res.status).toBe(400)
    }
    const notJson = await beat('not json')
    expect(notJson.status).toBe(400)
  })
})
