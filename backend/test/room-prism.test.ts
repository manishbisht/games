import { env, runInDurableObject, SELF } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import { playableCards } from '@games/shared/prism'
import { CLAIM_WIN_AFTER_MS } from '@games/shared/protocol'
import type { ServerMessage } from '@games/shared/protocol'
import type { Card, GameState } from '@games/shared/prism/types'
import type { Env } from '../src/env'
import type { RoomRecord } from '../src/room'
import { connect, WAIT } from './helpers'
import type { Client } from './helpers'

const testEnv = env as unknown as Env
type RoomMessage = Extract<ServerMessage, { type: 'room' }>

const table = (message: RoomMessage) => message.snapshot.gameState as GameState
/** Observe the table: only ever through a broadcast, never off live room state. */
const seeTable = (client: Client, predicate: (state: GameState) => boolean) =>
  client.waitRoom((m) => predicate(table(m as unknown as RoomMessage)))
const latest = (client: Client) =>
  (client.messages as unknown as ServerMessage[]).filter(
    (m): m is RoomMessage => m.type === 'room' && m.snapshot.gameState !== null,
  )

/**
 * Watch only what arrives from `from` onwards. `waitRoom` searches the whole log,
 * which is the wrong question after `patchRecord`: that writes storage without
 * broadcasting, so the newest snapshot a client holds can still describe a room
 * the server has already moved past.
 */
const seeNext = (client: Client, from: number, predicate: (m: RoomMessage) => boolean) =>
  vi.waitFor(() => {
    const log = client.messages.slice(from) as unknown as ServerMessage[]
    const room = log.filter((m): m is RoomMessage => m.type === 'room').findLast(predicate)
    expect(room).toBeDefined()
    return room!
  }, WAIT)

const readRecord = (code: string) =>
  runInDurableObject(testEnv.ROOM.getByName(code), async (_instance, state) =>
    state.storage.get<RoomRecord>('room'),
  )

/** Rewrite part of the stored record, keeping the instance's cache coherent. */
async function patchRecord(code: string, patch: (record: RoomRecord) => void) {
  await runInDurableObject(testEnv.ROOM.getByName(code), async (instance, state) => {
    const record = (await state.storage.get<RoomRecord>('room'))!
    patch(record)
    await state.storage.put('room', record)
    // Keep the in-memory cache coherent with storage (same-object contract).
    ;(instance as unknown as { cached: RoomRecord }).cached = record
  })
}

async function prismRoom(seats: number) {
  const guestId = crypto.randomUUID()
  const res = await SELF.fetch('https://api.test/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ game: 'prism', visibility: 'private', name: 'Ann', guestId, seats }),
  })
  expect(res.status).toBe(201)
  const { code } = await res.json<{ code: string }>()
  return { code, guestId }
}

/**
 * A dealt table: one seat per name, taken in order, host first. `watchers` join
 * without sitting, which is how a room gets a spectator — the seats have to still
 * be open when they arrive.
 */
async function startedTable(names: string[], seats = names.length, watchers = 0) {
  const { code, guestId } = await prismRoom(seats)
  const clients: Client[] = []
  const ids: string[] = []
  for (const [index, name] of names.entries()) {
    const client = await connect(code)
    ids.push(client.join(name, index === 0 ? guestId : undefined))
    client.send({ type: 'sit', seat: `p${index}` })
    await client.waitRoom((m) => m.you.seat === `p${index}`)
    clients.push(client)
  }
  const watching: Client[] = []
  for (let index = 0; index < watchers; index++) {
    const client = await connect(code)
    client.join(`Watcher ${index + 1}`)
    await client.waitRoom((m) => m.you.seat === null)
    watching.push(client)
  }
  clients[0].send({ type: 'start' })
  for (const client of [...clients, ...watching])
    await client.waitRoom((m) => m.snapshot.status === 'playing')
  return { code, clients, watching, ids }
}

/** Every real deck id anywhere in a serialized value — fields we forgot included. */
const dealtIds = (value: unknown) => new Set(JSON.stringify(value).match(/prism-\d+/g) ?? [])
const handOf = (client: Client, seat: number) => table(latest(client).at(-1)!).players[seat].hand

/**
 * One whole turn for the seat on turn: play what the table allows, or draw and
 * then decide what to do with the card. Legality is read off this client's own
 * view, which is the only hand in it that is real.
 */
async function playTurn(client: Client, seat: number): Promise<GameState> {
  const state = table(await seeTable(client, (s) => s.currentPlayer === seat))
  const play = (card: Card) =>
    client.send({
      type: 'action',
      action: { kind: 'play', cardId: card.id, ...(card.isWild ? { color: 'red' } : {}) },
    })
  const legal = playableCards(state, seat)
  if (legal.length) {
    play(legal[0])
    return table(await seeTable(client, (s) => s.discardPile.at(-1)!.id === legal[0].id))
  }
  client.send({ type: 'action', action: { kind: 'draw' } })
  const drawn = table(await seeTable(client, (s) => s.currentPlayer !== seat || s.drawnCardId !== null))
  if (drawn.currentPlayer !== seat) return drawn
  // The drawn card is playable, so the seat still owes the table a decision.
  client.send({ type: 'action', action: { kind: 'pass' } })
  return table(await seeTable(client, (s) => s.currentPlayer !== seat))
}

/**
 * Play this seat's turns until the table is somebody else's. A reverse or a skip
 * at a two-seat table comes straight back around, so how many turns that takes
 * is the cards' business.
 */
async function handOver(client: Client, seat: number): Promise<GameState> {
  let state = table(await seeTable(client, (s) => s.currentPlayer === seat))
  for (let attempt = 0; attempt < 12; attempt++) {
    if (state.currentPlayer !== seat || state.status !== 'playing') return state
    state = await playTurn(client, seat)
  }
  throw new Error(`the turn never left seat ${seat}`)
}

describe('a prism room', () => {
  it('deals a table nobody can see all of', async () => {
    // A four-seat room so the watcher has a door to come in through: joining a
    // room with every seat taken is refused before it ever gets a view.
    const { clients, watching } = await startedTable(['Ann', 'Ben', 'Cai'], 4, 1)
    const [ann, ben] = clients
    const annSees = await seeTable(ann, (s) => s.status === 'playing')
    const benSees = await seeTable(ben, (s) => s.status === 'playing')

    // Same table, two different tables: the room builds one snapshot per seat.
    expect(JSON.stringify(table(annSees))).not.toBe(JSON.stringify(table(benSees)))
    expect(table(annSees).players.map((p) => p.name)).toEqual(['Ann', 'Ben', 'Cai'])
    expect(table(annSees).players.map((p) => p.hand.length)).toEqual([7, 7, 7])
    expect(table(annSees).drawPile).toHaveLength(108 - 21 - 1)

    // Ann's own cards are hers to see; everyone else's are placeholders.
    expect(table(annSees).players[0].hand.every((c) => /^prism-\d+$/.test(c.id))).toBe(true)
    expect(table(annSees).players[1].hand.map((c) => c.id)).toEqual(
      Array.from({ length: 7 }, (_, i) => `hidden-1-${i}`),
    )
    expect(table(annSees).drawPile.every((c) => c.id.startsWith('hidden-pile-'))).toBe(true)

    // And not one of Ben's real cards is anywhere in what Ann was sent.
    const annSnapshot = dealtIds(annSees.snapshot)
    for (const card of table(benSees).players[1].hand) expect(annSnapshot.has(card.id)).toBe(false)
    // What Ann may read is exactly her own hand and the card that is face up.
    expect([...annSnapshot].sort()).toEqual(
      [...table(annSees).players[0].hand, ...table(annSees).discardPile].map((c) => c.id).sort(),
    )

    // The watcher took no seat, so the whole deal is hidden from them.
    const watcherSees = await seeTable(watching[0], (s) => s.status === 'playing')
    expect(watcherSees.you.seat).toBeNull()
    expect(table(watcherSees).players.map((p) => p.hand.length)).toEqual([7, 7, 7])
    expect(
      table(watcherSees)
        .players.flatMap((p) => p.hand)
        .every((c) => c.id.startsWith('hidden-')),
    ).toBe(true)
    expect([...dealtIds(watcherSees.snapshot)]).toEqual(table(watcherSees).discardPile.map((c) => c.id))
  })

  it('plays a card at one seat and shows it to the whole table', async () => {
    const { clients } = await startedTable(['Ann', 'Ben'])
    const [ann, ben] = clients
    const opening = table(await seeTable(ann, (s) => s.currentPlayer === 0))
    expect(opening.players.map((p) => p.hand.length)).toEqual([7, 7])

    const played = await playTurn(ann, 0)
    // Whatever Ann did, the table moved and Ben was told the same story.
    const bensView = table(await seeTable(ben, (s) => s.turn > opening.turn))
    expect(bensView.discardPile.at(-1)).toEqual(played.discardPile.at(-1))
    expect(bensView.activeColor).toBe(played.activeColor)
    expect(bensView.players.map((p) => p.hand.length)).toEqual(played.players.map((p) => p.hand.length))
    // Ben still holds his own cards, and only his own.
    expect(bensView.players[1].hand.every((c) => /^prism-\d+$/.test(c.id))).toBe(true)
    expect(bensView.players[0].hand.every((c) => c.id.startsWith('hidden-0-'))).toBe(true)
  })

  it('refuses a play from a seat that is not on turn, and a malformed action', async () => {
    const { clients } = await startedTable(['Ann', 'Ben'])
    const [ann, ben] = clients
    const mine = handOf(ben, 1)
    ben.send({ type: 'action', action: { kind: 'play', cardId: mine[0].id } })
    await ben.expectError('NOT_YOUR_TURN')
    ann.send({ type: 'action', action: { kind: 'nonsense' } })
    await ann.expectError('BAD_MESSAGE')
    // A card Ann cannot see is a card Ann cannot name, let alone play.
    ann.send({ type: 'action', action: { kind: 'play', cardId: 'hidden-1-0' } })
    await ann.expectError('ILLEGAL_MOVE')
  })

  it('lets a seat that is not on turn call, and another catch the one who did not', async () => {
    const { code, clients } = await startedTable(['Ann', 'Ben', 'Cai'])
    const [ann, ben, cai] = clients

    // Put Cai on his last card with the window open on him: Ann is on turn, so
    // both the call and the catch come from seats that are not.
    await patchRecord(code, (record) => {
      const state = record.gameState as GameState
      record.gameState = {
        ...state,
        currentPlayer: 0,
        callWindow: 2,
        players: state.players.map((p, i) => (i === 2 ? { ...p, hand: p.hand.slice(0, 1) } : p)),
      }
    })

    const before = ben.messages.length
    ben.send({ type: 'action', action: { kind: 'catch', target: 2 } })
    const caught = await seeNext(ben, before, (m) => table(m).callWindow === null)
    // Two cards for forgetting, and the turn never moved: catching is not a turn.
    expect(table(caught).players[2].hand).toHaveLength(3)
    expect(table(caught).currentPlayer).toBe(0)

    // Calling in time is the way out of it — from the seat it belongs to.
    await patchRecord(code, (record) => {
      const state = record.gameState as GameState
      record.gameState = {
        ...state,
        callWindow: 2,
        players: state.players.map((p, i) => (i === 2 ? { ...p, hand: p.hand.slice(0, 1) } : p)),
      }
    })
    const mark = cai.messages.length
    cai.send({ type: 'action', action: { kind: 'call' } })
    const called = await seeNext(cai, mark, (m) => table(m).players[2].called)
    expect(table(called).callWindow).toBeNull()
    expect(table(called).players[2].hand).toHaveLength(1)

    // Nobody is left to catch, and the room says so rather than silently passing.
    ann.send({ type: 'action', action: { kind: 'catch', target: 2 } })
    await ann.expectError('NOT_ALLOWED')
  })

  it('plays an abandoned seat’s turn rather than awarding the round', async () => {
    const { code, clients, ids } = await startedTable(['Ann', 'Ben'])
    const [ann, ben] = clients
    const opening = await handOver(ann, 0)
    expect(opening.currentPlayer).toBe(1)

    // The turn is Ben's, and Ben walks away from it.
    ben.ws.close()
    await ann.waitRoom((m) => m.snapshot.seats.p1?.connected === false)
    await patchRecord(code, (record) => {
      record.seats.p1!.disconnectedAt = Date.now() - CLAIM_WIN_AFTER_MS - 1000
    })

    const before = ann.messages.length
    ann.send({ type: 'claim' })
    // A hand of cards has no win-by-default: the claim hands Ben's seat to the
    // room, which begins by taking the turn he was sitting on.
    const played = await seeNext(ann, before, (m) => table(m).turn > opening.turn)
    expect(played.snapshot.status).toBe('playing')
    expect(played.snapshot.seats.p1?.abandoned).toBe(true)
    expect(table(played).status).toBe('playing')
    // Still nothing of Ben's hand on the wire, even while the room is playing it.
    expect(table(played).players[1].hand.every((c) => c.id.startsWith('hidden-1-'))).toBe(true)

    // Ben comes back to the same seat with the same id, and the room stops.
    const back = await connect(code)
    back.join('Ben', ids[1])
    await back.waitRoom((m) => m.you.seat === 'p1')
    expect((await readRecord(code))!.seats.p1?.abandoned).toBeUndefined()
    expect(handOf(back, 1).every((c) => /^prism-\d+$/.test(c.id))).toBe(true)
  })

  it('deals the next round of the same match when the table asks for one', async () => {
    const { code, clients } = await startedTable(['Ann', 'Ben', 'Cai'])
    const [ann, ben, cai] = clients

    // Jump to the end rather than playing a whole round out card by card.
    await patchRecord(code, (record) => {
      const state = record.gameState as GameState
      record.gameState = {
        ...state,
        status: 'won',
        winner: 1,
        roundScore: 34,
        players: state.players.map((p, i) => ({ ...p, totalScore: [0, 34, 0][i] })),
      }
      record.status = 'finished'
      record.autoAt = undefined
    })

    ann.send({ type: 'rematch' })
    const waiting = await ann.waitRoom((m) => m.snapshot.seats.p0?.wantsRematch === true)
    // One seat is not the table: the round stands until everyone has asked.
    expect(waiting.snapshot.status).toBe('finished')

    const before = ann.messages.length
    ben.send({ type: 'rematch' })
    cai.send({ type: 'rematch' })
    const fresh = await seeNext(ann, before, (m) => m.snapshot.status === 'playing')
    // A rematch is the next round of the same match, so the scores come with it.
    expect(table(fresh).round).toBe(2)
    expect(table(fresh).players.map((p) => p.totalScore)).toEqual([0, 34, 0])
    expect(table(fresh).players.map((p) => p.name)).toEqual(['Ann', 'Ben', 'Cai'])
    expect(table(fresh).players.map((p) => p.hand.length)).toEqual([7, 7, 7])
    expect(table(fresh).roundScore).toBe(0)
    expect(fresh.snapshot.seats.p0?.wantsRematch).toBe(false)
    // The new deal is hidden all over again — a fresh shuffle, freshly redacted.
    expect(table(fresh).players[0].hand.every((c) => /^prism-\d+$/.test(c.id))).toBe(true)
    expect(table(fresh).players[1].hand.every((c) => c.id.startsWith('hidden-1-'))).toBe(true)
  })

  it('plays a room made for four with the three who turned up', async () => {
    const { clients } = await startedTable(['Ann', 'Ben', 'Cai'], 4)
    const opening = await seeTable(clients[0], (s) => s.status === 'playing')
    expect(opening.snapshot.seatIds).toEqual(['p0', 'p1', 'p2'])
    expect(table(opening).players.map((p) => p.name)).toEqual(['Ann', 'Ben', 'Cai'])
    expect(table(opening).currentPlayer).toBe(0)
  })
})
