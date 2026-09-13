import { SELF } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@games/shared/protocol'
import { ROOM_CODE_ALPHABET } from '@games/shared/protocol/codes'
import { connect, createRoom } from './helpers'

const post = (body: unknown) =>
  SELF.fetch('https://api.test/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

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

  it('only books games that have an adapter registered', async () => {
    // A name is not a game: `wildrise` is in the catalog and plays locally, but
    // the protocol has never heard of it and the registry has no adapter for it.
    // (Every id `GameId` does name now has one, so that case cannot be staged.)
    for (const game of ['wildrise', 'nope', 42, undefined]) {
      const res = await post({ game, visibility: 'private', name: 'Ann', guestId: crypto.randomUUID() })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'unknown game' })
    }
  })

  it('does not mistake Object.prototype members for registered games', async () => {
    // The registry is a plain object, so an unguarded lookup would answer
    // `toString` with a function and carry it all the way to a 500.
    for (const game of ['toString', '__proto__', 'constructor', 'hasOwnProperty', 'valueOf']) {
      const res = await post({
        game,
        seats: 2,
        visibility: 'private',
        name: 'Ann',
        guestId: crypto.randomUUID(),
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'unknown game' })
    }
  })

  it('ignores an unknown game filter on the lobby rather than answering for one', async () => {
    for (const game of ['toString', '__proto__']) {
      const res = await SELF.fetch(`https://api.test/api/lobby?game=${encodeURIComponent(game)}`)
      expect(res.status).toBe(200)
      expect(await res.json()).toHaveProperty('rooms')
    }
  })

  it('holds the host to the seat counts the adapter supports', async () => {
    for (const seats of [1, 3, 2.5, 'two']) {
      const res = await post({
        game: 'chess',
        visibility: 'private',
        name: 'Ann',
        guestId: crypto.randomUUID(),
        seats,
      })
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: 'unsupported seat count' })
    }
    expect(
      (
        await post({
          game: 'chess',
          visibility: 'private',
          name: 'Ann',
          guestId: crypto.randomUUID(),
          seats: 2,
        })
      ).status,
    ).toBe(201)
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
    expect(open.you.isHost).toBe(true)
    // Seats are the adapter's, announced to the client rather than assumed by it.
    expect(open.snapshot.protocol).toBe(PROTOCOL_VERSION)
    expect(open.snapshot.seatIds).toEqual(['w', 'b'])

    host.send({ type: 'sit', seat: 'w' })
    const seated = await host.waitRoom((m) => m.you.seat === 'w')
    expect(seated.snapshot.seats.w?.player.name).toBe('Ann')
    expect(seated.snapshot.seats.w?.connected).toBe(true)
    // Snapshots are broadcast to everyone, so they must never carry a player id.
    expect(seated.snapshot.seats.w?.player).not.toHaveProperty('id')
    expect(JSON.stringify(seated.snapshot)).not.toContain(guestId)
  })

  it('lets a seated player switch seats before the game starts', async () => {
    const { code, guestId } = await createRoom()
    const host = await connect(code)
    host.join('Ann', guestId)
    host.send({ type: 'sit', seat: 'w' })
    await host.waitRoom((m) => m.you.seat === 'w')

    host.send({ type: 'sit', seat: 'b' })
    const switched = await host.waitRoom((m) => m.you.seat === 'b')
    expect(switched.you.seat).toBe('b')
    expect(switched.snapshot.seats.b?.player.name).toBe('Ann')
    expect(switched.snapshot.seats.w).toBeUndefined()
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
    const seated = await guest.waitRoom((m) => m.you.seat === 'b')
    expect(seated.you.isHost).toBe(false)
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
    expect(playing.snapshot.gameState?.options.human).toBe('w')
    expect(playing.snapshot.gameState?.options.difficulty).toBe('medium')
    expect(playing.snapshot.gameState?.options.clock).toBe(0)
  })

  it('rejects sit and start once the game has already started', async () => {
    const { code, guestId } = await createRoom()
    const host = await connect(code)
    host.join('Ann', guestId)
    host.send({ type: 'sit', seat: 'w' })

    const guest = await connect(code)
    guest.join('Ben')
    guest.send({ type: 'sit', seat: 'b' })
    await host.waitRoom((m) => Boolean(m.snapshot.seats.b))
    host.send({ type: 'start' })
    await host.waitRoom((m) => m.snapshot.status === 'playing')

    const alreadyStartedCount = () =>
      host.messages.filter((m) => m.type === 'error' && m.code === 'ALREADY_STARTED').length

    host.send({ type: 'sit', seat: 'w' })
    await vi.waitFor(() => expect(alreadyStartedCount()).toBe(1))

    host.send({ type: 'start' })
    await vi.waitFor(() => expect(alreadyStartedCount()).toBe(2))
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
    client.send({ type: 'join', protocol: PROTOCOL_VERSION, name: '   ', guestId: crypto.randomUUID() })
    await client.expectError('BAD_MESSAGE')
    client.send({ type: 'join', protocol: 99, name: 'Ann', guestId: crypto.randomUUID() })
    await client.expectError('PROTOCOL_MISMATCH')
  })
})
