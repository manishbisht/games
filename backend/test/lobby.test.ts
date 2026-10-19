import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { SELF } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import type { PublicRoomSummary } from '@games/shared/protocol'
import type { Env } from '../src/env'
import { migrate } from '../src/lobby'
import { MAX_LISTED_PER_SOURCE } from '../src/lobby'
import { connect, createRoom, WAIT } from './helpers'

const testEnv = env as unknown as Env

async function lobbyRooms(): Promise<PublicRoomSummary[]> {
  const res = await SELF.fetch('https://api.test/api/lobby?game=chess')
  expect(res.status).toBe(200)
  return (await res.json<{ rooms: PublicRoomSummary[] }>()).rooms
}

const listed = async (code: string) => (await lobbyRooms()).some((room) => room.code === code)

/** A public room with its host in it (a room is only listed once somebody is). */
async function hostedRoom(name = 'Ann') {
  const { code, guestId } = await createRoom('public', name)
  const host = await connect(code)
  host.join(name, guestId)
  await host.waitRoom(() => true)
  await vi.waitFor(async () => expect(await listed(code)).toBe(true), WAIT)
  return { code, guestId, host }
}

describe('public lobby', () => {
  it('lists public rooms with live seat counts and hides them once started', async () => {
    const { code, host } = await hostedRoom('Ann')
    expect((await lobbyRooms()).find((r) => r.code === code)).toMatchObject({
      hostName: 'Ann',
      seatsTaken: 0,
      seatsTotal: 2,
    })

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
    const { code, host } = await hostedRoom('Ann')
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
    const { code } = await hostedRoom()
    await runDurableObjectAlarm(testEnv.ROOM.getByName(code))
    await vi.waitFor(async () => {
      expect((await lobbyRooms()).map((r) => r.code)).not.toContain(code)
    })
  })

  it('purges stale entries on its own alarm', async () => {
    await hostedRoom()
    const lobby = testEnv.LOBBY.getByName('global')
    await runInDurableObject(lobby, async (_instance, state) => {
      state.storage.sql.exec('UPDATE rooms SET updated_at = ?', Date.now() - 7 * 60 * 60 * 1000)
    })
    const ran = await runDurableObjectAlarm(lobby)
    expect(ran).toBe(true)
    expect(await lobbyRooms()).toEqual([])
  })

  it('lists nothing for a room nobody has entered, and forgets one everybody has left', async () => {
    const { code, guestId } = await createRoom('public', 'Ghost')
    // Made and never entered: not a table anyone can sit down with.
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(await listed(code)).toBe(false)

    const host = await connect(code)
    host.join('Ghost', guestId)
    await vi.waitFor(async () => expect(await listed(code)).toBe(true), WAIT)
    host.ws.close()
    await vi.waitFor(async () => expect(await listed(code)).toBe(false), WAIT)
  })

  it('stays listed while a seated player is there, though the host has gone', async () => {
    const { code, host } = await hostedRoom('Ann')
    const guest = await connect(code)
    guest.join('Ben')
    guest.send({ type: 'sit', seat: 'b' })
    await host.waitRoom((m) => Boolean(m.snapshot.seats.b))
    host.ws.close()
    await guest.waitRoom((m) => m.snapshot.spectators === 0 && m.you.seat === 'b')
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect((await lobbyRooms()).find((r) => r.code === code)).toMatchObject({ seatsTaken: 1 })
  })

  it('lists only a few rooms from one address at a time', async () => {
    const lobby = testEnv.LOBBY.getByName('global')
    const summary = (code: string): PublicRoomSummary => ({
      code,
      game: 'hearth',
      hostName: 'Spam',
      seatsTaken: 1,
      seatsTotal: 4,
      createdAt: Date.now(),
      bots: 0,
    })
    const codes = ['SRCAA2', 'SRCAA3', 'SRCAA4', 'SRCAA5', 'SRCAA6']
    const results = []
    for (const code of codes) results.push(await lobby.upsert(summary(code), 'tag-of-one-address'))
    expect(results).toEqual(codes.map((_, index) => index < MAX_LISTED_PER_SOURCE))
    // A room already listed keeps updating, and somewhere else is not held to that count.
    expect(await lobby.upsert({ ...summary(codes[0]), seatsTaken: 2 }, 'tag-of-one-address')).toBe(true)
    expect(await lobby.upsert(summary('SRCAA7'), 'tag-of-another')).toBe(true)
    const listedCodes = (await lobby.list('hearth')).map((room) => room.code)
    expect(listedCodes).toEqual(expect.arrayContaining([...codes.slice(0, MAX_LISTED_PER_SOURCE), 'SRCAA7']))
    for (const code of codes.slice(MAX_LISTED_PER_SOURCE)) expect(listedCodes).not.toContain(code)
    for (const code of [...codes, 'SRCAA7']) await lobby.remove(code)
  })
})

describe('bots at a public table', () => {
  async function wildriseRooms(): Promise<PublicRoomSummary[]> {
    const res = await SELF.fetch('https://api.test/api/lobby?game=wildrise')
    expect(res.status).toBe(200)
    return (await res.json<{ rooms: PublicRoomSummary[] }>()).rooms
  }

  it("says how many of a public room's seats are bots", async () => {
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
        bots: ['casual'],
      }),
    })
    const { code } = await res.json<{ code: string }>()
    const host = await connect(code)
    host.join('Ann', guestId)
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
