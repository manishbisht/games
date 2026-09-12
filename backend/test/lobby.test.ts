import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { SELF } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import type { PublicRoomSummary } from '@games/shared/protocol'
import type { Env } from '../src/env'
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
