import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { GameState as PrismState } from '@games/shared/prism/types'
import { MAX_ROOM_SOCKETS } from '../src/room'
import { connect, createRoom } from './helpers'
import type { Client } from './helpers'

/** A chess game under way: Ann white, Ben black, both seats taken. */
async function fullChessTable() {
  const { code, guestId } = await createRoom()
  const ann = await connect(code)
  ann.join('Ann', guestId)
  ann.send({ type: 'sit', seat: 'w' })
  const ben = await connect(code)
  const benId = ben.join('Ben')
  ben.send({ type: 'sit', seat: 'b' })
  await ann.waitRoom((m) => Boolean(m.snapshot.seats.b))
  ann.send({ type: 'start' })
  await ann.waitRoom((m) => m.snapshot.status === 'playing')
  return { code, ann, ben, benId }
}

async function watch(code: string, name = 'Eve', guestId?: string) {
  const client = await connect(code)
  client.join(name, guestId)
  await client.waitRoom((m) => m.you.seat === null)
  return client
}

describe('spectators', () => {
  it('watch a game under way at a full table, and are counted', async () => {
    const { code, ann } = await fullChessTable()
    const eveId = crypto.randomUUID()
    const eve = await watch(code, 'Eve', eveId)
    const seen = await eve.waitRoom((m) => m.snapshot.status === 'playing')
    expect(seen.you).toMatchObject({ seat: null, isHost: false })
    expect(seen.snapshot.gameState).not.toBeNull()
    expect(seen.snapshot.spectators).toBe(1)
    // The players are told someone is watching.
    await ann.waitRoom((m) => m.snapshot.spectators === 1)

    // Two tabs are still one person watching.
    const mark = ann.mark()
    const second = await watch(code, 'Eve', eveId)
    expect((await ann.waitRoom(() => true, mark)).snapshot.spectators).toBe(1)

    // And when they go, the count goes with them.
    const before = ann.mark()
    eve.ws.close()
    second.ws.close()
    await ann.waitRoom((m) => m.snapshot.spectators === 0, before)
  })

  it('cannot move, claim or ask for a rematch', async () => {
    const { code } = await fullChessTable()
    const eve = await watch(code)
    eve.send({ type: 'action', action: { from: 'e2', to: 'e4' } })
    await eve.expectError('NOT_SEATED')
    const errors = () => eve.messages.filter((m) => m.type === 'error').length
    eve.send({ type: 'claim' })
    eve.send({ type: 'rematch' })
    eve.send({ type: 'sit', seat: 'w' })
    await expect.poll(errors).toBe(4)
    expect(eve.messages.filter((m) => m.type === 'error').map((m) => (m as { code: string }).code)).toEqual([
      'NOT_SEATED',
      'NOT_SEATED',
      'NOT_SEATED',
      'ALREADY_STARTED',
    ])
  })

  it('see the hidden-information view nobody is sitting behind', async () => {
    const guestId = crypto.randomUUID()
    const res = await SELF.fetch('https://api.test/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ game: 'prism', visibility: 'private', name: 'Ann', guestId, seats: 2 }),
    })
    const { code } = await res.json<{ code: string }>()
    const ann = await connect(code)
    ann.join('Ann', guestId)
    ann.send({ type: 'sit', seat: 'p0' })
    const ben = await connect(code)
    ben.join('Ben')
    ben.send({ type: 'sit', seat: 'p1' })
    await ann.waitRoom((m) => Boolean(m.snapshot.seats.p1))
    ann.send({ type: 'start' })
    await ann.waitRoom((m) => m.snapshot.status === 'playing')

    // Arriving after the deal, at a table with no seat left.
    const eve = await watch(code)
    const view = (await eve.waitRoom((m) => m.snapshot.gameState !== null)).snapshot
      .gameState as unknown as PrismState
    // The only real cards a spectator may see are the ones face up on the felt.
    const real = new Set(JSON.stringify(view).match(/prism-\d+/g) ?? [])
    const faceUp = new Set(view.discardPile.map((card) => card.id))
    expect([...real].every((id) => faceUp.has(id))).toBe(true)
    expect(view.players.every((player) => player.hand.every((card) => card.id.startsWith('hidden-')))).toBe(
      true,
    )
    expect(view.drawnCardId).toBeNull()
  })

  it('fill a room only so far, and never keep a seat-holder out', async () => {
    const { code, ben, benId } = await fullChessTable()
    // Ann and Ben are two of the room's sockets; watchers take it to the cap.
    const watchers: Client[] = []
    for (let index = 2; index < MAX_ROOM_SOCKETS; index++) watchers.push(await watch(code, `W${index}`))

    const late = await connect(code)
    late.join('Zed')
    await late.expectError('ROOM_FULL')
    await expect.poll(() => late.closes[0]?.code).toBe(4403)

    // Ben's seat is his whatever the crowd: a second tab of his is let in at the cap.
    const again = await connect(code)
    again.join('Ben', benId)
    const back = await again.waitRoom((m) => m.you.seat === 'b')
    expect(back.snapshot.spectators).toBe(MAX_ROOM_SOCKETS - 2)
    void ben

    // Ben's two tabs hold the room over the cap; two watchers leaving brings it
    // back under, and makes room for the next.
    const mark = again.mark()
    watchers[0].ws.close()
    watchers[1].ws.close()
    await again.waitRoom((m) => m.snapshot.spectators === MAX_ROOM_SOCKETS - 4, mark)
    await watch(code, 'Yan')
  })
})
