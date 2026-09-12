import { SELF } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import { ROOM_CODE_ALPHABET } from '@games/shared/protocol/codes'
import { connect, createRoom } from './helpers'

describe('room creation', () => {
  it('creates a room and returns a six-char code', async () => {
    const { code } = await createRoom()
    expect(code).toHaveLength(6)
    for (const ch of code) expect(ROOM_CODE_ALPHABET).toContain(ch)
  })
  it('rejects creation without a valid identity', async () => {
    const res = await SELF.fetch('https://api.test/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ game: 'chess', visibility: 'private', name: '' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('joining and seats', () => {
  it('closes unknown rooms with 4404', async () => {
    const client = await connect('KX3F9M')
    await client.expectError('ROOM_NOT_FOUND')
    await vi.waitFor(() => expect(client.closes[0]?.code).toBe(4404))
  })

  it('joins, sits, and receives authoritative snapshots', async () => {
    const { code, guestId } = await createRoom()
    const host = await connect(code)
    host.join('Ann', guestId)
    const open = await host.waitRoom((m) => m.snapshot.status === 'open')
    expect(open.you.id).toBe(`guest:${guestId}`)
    expect(open.you.seat).toBeNull()

    host.send({ type: 'sit', seat: 'w' })
    const seated = await host.waitRoom((m) => m.you.seat === 'w')
    expect(seated.snapshot.seats.w?.player.name).toBe('Ann')
    expect(seated.snapshot.seats.w?.connected).toBe(true)
  })

  it('rejects sitting on a taken seat and non-host starts', async () => {
    const { code, guestId } = await createRoom()
    const host = await connect(code)
    host.join('Ann', guestId)
    host.send({ type: 'sit', seat: 'w' })
    await host.waitRoom((m) => m.you.seat === 'w')

    const guest = await connect(code)
    guest.join('Ben')
    guest.send({ type: 'sit', seat: 'w' })
    await guest.expectError('SEAT_TAKEN')
    guest.send({ type: 'sit', seat: 'b' })
    await guest.waitRoom((m) => m.you.seat === 'b')
    guest.send({ type: 'start' })
    await guest.expectError('NOT_HOST')
  })

  it('host starts once both seats are taken; game state is authoritative', async () => {
    const { code, guestId } = await createRoom()
    const host = await connect(code)
    host.join('Ann', guestId)
    host.send({ type: 'sit', seat: 'w' })
    host.send({ type: 'start' })
    await host.expectError('NOT_READY')

    const guest = await connect(code)
    guest.join('Ben')
    guest.send({ type: 'sit', seat: 'b' })
    await host.waitRoom((m) => Boolean(m.snapshot.seats.b))
    host.send({ type: 'start' })
    const playing = await guest.waitRoom((m) => m.snapshot.status === 'playing')
    expect(playing.snapshot.gameState?.turn).toBe('w')
    expect(playing.snapshot.gameState?.options.mode).toBe('online')
  })

  it('turns away a third player and reclaims seats on reconnect', async () => {
    const { code, guestId } = await createRoom()
    const host = await connect(code)
    host.join('Ann', guestId)
    host.send({ type: 'sit', seat: 'w' })
    const guest = await connect(code)
    const benId = guest.join('Ben')
    guest.send({ type: 'sit', seat: 'b' })
    await host.waitRoom((m) => Boolean(m.snapshot.seats.b))

    const third = await connect(code)
    third.join('Eve')
    await third.expectError('ROOM_FULL')
    await vi.waitFor(() => expect(third.closes[0]?.code).toBe(4403))

    guest.ws.close()
    await host.waitRoom((m) => m.snapshot.seats.b?.connected === false)
    const back = await connect(code)
    back.join('Ben', benId)
    const reclaimed = await back.waitRoom((m) => m.you.seat === 'b')
    expect(reclaimed.snapshot.seats.b?.connected).toBe(true)
  })

  it('requires join before anything else and a valid name on join', async () => {
    const { code } = await createRoom()
    const client = await connect(code)
    client.send({ type: 'sit', seat: 'w' })
    await client.expectError('NOT_JOINED')
    client.send({ type: 'join', protocol: 1, name: '   ', guestId: crypto.randomUUID() })
    await client.expectError('BAD_MESSAGE')
    client.send({ type: 'join', protocol: 99, name: 'Ann', guestId: crypto.randomUUID() })
    await client.expectError('PROTOCOL_MISMATCH')
  })
})
