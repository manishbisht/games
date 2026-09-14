import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { SELF } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import type { PublicRoomSummary } from '@games/shared/protocol'
import type { Env } from '../src/env'
import { migrate } from '../src/lobby'
import { connect, createRoom } from './helpers'

const testEnv = env as unknown as Env

async function lobbyRooms(): Promise<PublicRoomSummary[]> {
  const res = await SELF.fetch('https://api.test/api/lobby?game=chess')
  expect(res.status).toBe(200)
  return (await res.json<{ rooms: PublicRoomSummary[] }>()).rooms
}

describe('public lobby', () => {
  it('lists public rooms with live seat counts and hides them once started', async () => {
    const { code, guestId } = await createRoom('public', 'Ann')
    await vi.waitFor(async () => {
      const rooms = await lobbyRooms()
      expect(rooms.map((r) => r.code)).toContain(code)
      expect(rooms.find((r) => r.code === code)).toMatchObject({
        hostName: 'Ann',
        seatsTaken: 0,
        seatsTotal: 2,
      })
    })

    const host = await connect(code)
    host.join('Ann', guestId)
    host.send({ type: 'sit', seat: 'w' })
    await host.waitRoom((m) => m.you.seat === 'w')
    await vi.waitFor(async () => {
      expect((await lobbyRooms()).find((r) => r.code === code)?.seatsTaken).toBe(1)
    })

    const guest = await connect(code)
    guest.join('Ben')
    guest.send({ type: 'sit', seat: 'b' })
    await host.waitRoom((m) => Boolean(m.snapshot.seats.b))
    host.send({ type: 'start' })
    await host.waitRoom((m) => m.snapshot.status === 'playing')
    await vi.waitFor(async () => {
      expect((await lobbyRooms()).map((r) => r.code)).not.toContain(code)
    })
  })

  it('hides a full room even before the host starts it', async () => {
    const { code, guestId } = await createRoom('public', 'Ann')
    await vi.waitFor(async () => expect((await lobbyRooms()).map((r) => r.code)).toContain(code))

    const host = await connect(code)
    host.join('Ann', guestId)
    host.send({ type: 'sit', seat: 'w' })
    await host.waitRoom((m) => m.you.seat === 'w')
    const guest = await connect(code)
    guest.join('Ben')
    guest.send({ type: 'sit', seat: 'b' })
    const both = await host.waitRoom((m) => Boolean(m.snapshot.seats.w && m.snapshot.seats.b))
    expect(both.snapshot.status).toBe('open')

    await vi.waitFor(async () => {
      expect((await lobbyRooms()).map((r) => r.code)).not.toContain(code)
    })
  })

  it('never lists private rooms', async () => {
    const { code } = await createRoom('private')
    expect((await lobbyRooms()).map((r) => r.code)).not.toContain(code)
  })

  it('drops a room from the lobby when it expires', async () => {
    const { code } = await createRoom('public')
    await vi.waitFor(async () => expect((await lobbyRooms()).map((r) => r.code)).toContain(code))
    await runDurableObjectAlarm(testEnv.ROOM.getByName(code))
    await vi.waitFor(async () => {
      expect((await lobbyRooms()).map((r) => r.code)).not.toContain(code)
    })
  })

  it('purges stale entries on its own alarm', async () => {
    const { code } = await createRoom('public')
    await vi.waitFor(async () => expect((await lobbyRooms()).map((r) => r.code)).toContain(code))
    const lobby = testEnv.LOBBY.getByName('global')
    await runInDurableObject(lobby, async (_instance, state) => {
      state.storage.sql.exec('UPDATE rooms SET updated_at = ?', Date.now() - 7 * 60 * 60 * 1000)
    })
    const ran = await runDurableObjectAlarm(lobby)
    expect(ran).toBe(true)
    expect(await lobbyRooms()).toEqual([])
  })
})

describe('bots at a public table', () => {
  async function wildriseRooms(): Promise<PublicRoomSummary[]> {
    const res = await SELF.fetch('https://api.test/api/lobby?game=wildrise')
    expect(res.status).toBe(200)
    return (await res.json<{ rooms: PublicRoomSummary[] }>()).rooms
  }

  it("says how many of a public room's seats are bots", async () => {
    const res = await SELF.fetch('https://api.test/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        game: 'wildrise',
        visibility: 'public',
        name: 'Ann',
        guestId: crypto.randomUUID(),
        seats: 4,
        bots: ['casual'],
      }),
    })
    const { code } = await res.json<{ code: string }>()
    await vi.waitFor(async () => {
      const room = (await wildriseRooms()).find((entry) => entry.code === code)
      // A seat a bot is in is taken, but a table of bots is not a table of
      // people — the lobby says both numbers rather than implying the wrong one.
      expect(room?.seatsTaken).toBe(1)
      expect(room?.bots).toBe(1)
    })
  })

  it('keeps counting bots after the host adds one to an open room', async () => {
    const guestId = crypto.randomUUID()
    const res = await SELF.fetch('https://api.test/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        game: 'wildrise',
        visibility: 'public',
        name: 'Ann',
        guestId,
        seats: 4,
      }),
    })
    const { code } = await res.json<{ code: string }>()
    const host = await connect(code)
    host.join('Ann', guestId)
    host.send({ type: 'sit', seat: 'p0' })
    await host.waitRoom((m) => m.you.seat === 'p0')
    host.send({ type: 'addBot', seat: 'p1' })
    await host.waitRoom((m) => Boolean(m.snapshot.seats.p1))
    await vi.waitFor(async () => {
      const room = (await wildriseRooms()).find((entry) => entry.code === code)
      expect(room?.seatsTaken).toBe(2)
      expect(room?.bots).toBe(1)
    })
  })

  it('answers for a lobby whose table predates the bots column', async () => {
    // A deployed LobbyDO built its table with CREATE TABLE IF NOT EXISTS, so it
    // never gains a column from an edited CREATE. Rebuild the old shape here and
    // prove the migration adds it rather than the reads throwing.
    const lobby = testEnv.LOBBY.getByName('global')
    await runInDurableObject(lobby, async (_instance, state) => {
      state.storage.sql.exec('DROP TABLE IF EXISTS rooms')
      state.storage.sql.exec(`
        CREATE TABLE rooms (
          code TEXT PRIMARY KEY,
          game TEXT NOT NULL,
          host_name TEXT NOT NULL,
          seats_taken INTEGER NOT NULL,
          seats_total INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)
      state.storage.sql.exec(
        `INSERT INTO rooms (code, game, host_name, seats_taken, seats_total, created_at, updated_at)
         VALUES ('OLDRM1', 'wildrise', 'Ann', 1, 4, ?, ?)`,
        Date.now(),
        Date.now(),
      )
    })
    await runInDurableObject(lobby, async (instance, state) => {
      migrate(state.storage.sql)
      // Idempotent: the constructor runs it on every wake.
      migrate(state.storage.sql)
      const rooms = await instance.list('wildrise')
      const old = rooms.find((room) => room.code === 'OLDRM1')
      expect(old?.bots).toBe(0)
    })
  })
})
