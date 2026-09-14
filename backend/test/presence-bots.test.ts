import { SELF, env, runInDurableObject } from 'cloudflare:test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GAME_IDS } from '@games/shared/protocol'
import type { Env } from '../src/env'
import { resolvePresenceGame } from '../src/presence'
import type { RoomRecord } from '../src/room'

const testEnv = env as unknown as Env

// The PresenceDO singleton keeps its storage across tests, so start each test
// from empty tables to keep the exact-count assertions honest.
beforeEach(async () => {
  const stub = testEnv.PRESENCE.getByName('global')
  await runInDurableObject(stub, async (_instance, state) => {
    state.storage.sql.exec('DELETE FROM presence')
    state.storage.sql.exec('DELETE FROM room_bots')
  })
})

async function counts(body: unknown): Promise<{ total: number; byGame: Record<string, number> }> {
  const res = await SELF.fetch('https://api.test/api/presence', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  expect(res.status).toBe(200)
  return res.json()
}

const report = (code: string, game: string, bots: number) =>
  testEnv.PRESENCE.getByName('global').reportBots(code, game, bots)

/** Age every stored bot row so it falls outside the freshness window. */
async function backdateBots(ms: number): Promise<void> {
  await runInDurableObject(testEnv.PRESENCE.getByName('global'), async (_instance, state) => {
    state.storage.sql.exec('UPDATE room_bots SET updated_at = ?', Date.now() - ms)
  })
}

describe('bots count as players online', () => {
  it('adds a room’s bots to the site total and to its own game', async () => {
    await report('AAAAAA', 'wildrise', 3)
    const result = await counts({ clientId: 'client-aaaaaaaa', tabId: 'tab-11111111' })
    expect(result.total).toBe(4)
    expect(result.byGame.wildrise).toBe(3)
  })

  it('counts a game whose only players are bots, with nobody on its page', async () => {
    // The case a single GROUP BY over the visitor table cannot produce: there
    // is no human row for this game at all.
    await report('AAAAAA', 'prism', 2)
    const result = await counts({ clientId: 'client-aaaaaaaa', tabId: 'tab-11111111' })
    expect(result.byGame.prism).toBe(2)
  })

  it('adds bots to the people already on that game’s page', async () => {
    await report('AAAAAA', 'prism', 2)
    const result = await counts({ clientId: 'client-aaaaaaaa', tabId: 'tab-11111111', game: 'prism' })
    expect(result.byGame.prism).toBe(3)
    expect(result.total).toBe(3)
  })

  it('sums two tables of the same game and keeps other games apart', async () => {
    await report('AAAAAA', 'wildrise', 3)
    await report('BBBBBB', 'wildrise', 1)
    await report('CCCCCC', 'hearth', 2)
    const result = await counts({ clientId: 'client-aaaaaaaa', tabId: 'tab-11111111' })
    expect(result.byGame.wildrise).toBe(4)
    expect(result.byGame.hearth).toBe(2)
    expect(result.total).toBe(7)
  })

  it('replaces a room’s count rather than accumulating it', async () => {
    await report('AAAAAA', 'wildrise', 3)
    await report('AAAAAA', 'wildrise', 1)
    const result = await counts({ clientId: 'client-aaaaaaaa', tabId: 'tab-11111111' })
    expect(result.byGame.wildrise).toBe(1)
  })

  it('forgets a room that stops reporting', async () => {
    await report('AAAAAA', 'wildrise', 3)
    await backdateBots(5 * 60 * 1000)
    const result = await counts({ clientId: 'client-aaaaaaaa', tabId: 'tab-11111111' })
    expect(result.byGame.wildrise).toBeUndefined()
    expect(result.total).toBe(1)
  })

  it('drops the room when it reports no bots', async () => {
    await report('AAAAAA', 'wildrise', 3)
    await report('AAAAAA', 'wildrise', 0)
    const result = await counts({ clientId: 'client-aaaaaaaa', tabId: 'tab-11111111' })
    expect(result.byGame.wildrise).toBeUndefined()
  })

  it('refuses a report it cannot trust', async () => {
    // This is the one place a number reaches a site-wide public counter, so a
    // bug upstream must not be able to print "417 online".
    await report('AAAAAA', 'not-a-game', 3)
    await report('nope', 'wildrise', 3)
    await report('BBBBBB', 'wildrise', 999)
    await report('CCCCCC', 'wildrise', -5)
    const result = await counts({ clientId: 'client-aaaaaaaa', tabId: 'tab-11111111' })
    expect(result.byGame['not-a-game']).toBeUndefined()
    expect(result.total).toBeLessThanOrEqual(1 + 8)
  })

  it('knows every online game by the name presence keys on', async () => {
    // PresenceDO keys on catalog ids and rooms carry GameId. The two coincide
    // today; this fails the moment an online game is added without telling
    // presence about it, rather than quietly under-counting forever.
    for (const id of GAME_IDS) expect(resolvePresenceGame(id)).toBe(id)
  })
})

describe('a room reports the bots it is playing', () => {
  it('raises the count for a real solo table, then drops it when the game ends', async () => {
    const guestId = crypto.randomUUID()
    const res = await SELF.fetch('https://api.test/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        game: 'wildrise',
        visibility: 'private',
        name: 'Ann',
        guestId,
        seats: 4,
        bots: ['casual', 'casual', 'casual'],
        autoStart: true,
      }),
    })
    const { code } = await res.json<{ code: string }>()
    const { connect } = await import('./helpers')
    const host = await connect(code)
    host.join('Ann', guestId)
    await host.waitRoom((m) => m.snapshot.status === 'playing')

    // `ctx.waitUntil` work is not finished when the socket message arrives.
    await vi.waitFor(async () => {
      const result = await counts({ clientId: 'client-aaaaaaaa', tabId: 'tab-11111111' })
      expect(result.byGame.wildrise).toBeGreaterThanOrEqual(3)
    })

    await runInDurableObject(testEnv.ROOM.getByName(code), async (instance, state) => {
      const record = (await state.storage.get<RoomRecord>('room'))!
      record.status = 'finished'
      await state.storage.put('room', record)
      ;(instance as unknown as { cached: RoomRecord }).cached = record
    })
    // A finished table is not playing anyone, so its bots stop counting.
    await testEnv.PRESENCE.getByName('global').reportBots(code, 'wildrise', 0)
    const after = await counts({ clientId: 'client-aaaaaaaa', tabId: 'tab-11111111' })
    expect(after.byGame.wildrise).toBeUndefined()
  })

  it('does not count bots parked in an open room nobody has started', async () => {
    const guestId = crypto.randomUUID()
    const res = await SELF.fetch('https://api.test/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        game: 'hearth',
        visibility: 'private',
        name: 'Ann',
        guestId,
        seats: 4,
        bots: ['medium', 'medium'],
      }),
    })
    expect(res.status).toBe(201)
    const result = await counts({ clientId: 'client-aaaaaaaa', tabId: 'tab-11111111' })
    // Nobody is playing them: they are seats the host set aside, not players.
    expect(result.byGame.hearth).toBeUndefined()
  })
})
