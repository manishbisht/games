import { env, runInDurableObject, SELF } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import { CLAIM_WIN_AFTER_MS } from '@games/shared/protocol'
import type { ServerMessage } from '@games/shared/protocol'
import type { GameState, Trade } from '@games/shared/estate/types'
import type { Env } from '../src/env'
import type { RoomRecord } from '../src/room'
import { connect } from './helpers'
import type { Client } from './helpers'

const testEnv = env as unknown as Env
type RoomMessage = Extract<ServerMessage, { type: 'room' }>
type ErrorMessage = Extract<ServerMessage, { type: 'error' }>

/** A number no game would arrive at on its own, so finding it anywhere is a leak. */
const SEED_SENTINEL = 424242424

const table = (message: RoomMessage) => message.snapshot.gameState as GameState
/** Observe the table: only ever through a broadcast, never off live room state. */
const seeTable = (client: Client, predicate: (state: GameState) => boolean) =>
  client.waitRoom((m) => predicate(table(m as unknown as RoomMessage)))
const dealt = (client: Client) =>
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
  })

/**
 * The next refusal after `from`, and what it was. Deliberately the *first* one
 * rather than any one: several of these tests refuse the same seat twice, and a
 * search of the whole log would let the earlier answer stand in for the later.
 */
const seeError = (client: Client, from: number, code: string) =>
  vi.waitFor(() => {
    const log = client.messages.slice(from) as unknown as ServerMessage[]
    const error = log.find((m): m is ErrorMessage => m.type === 'error')
    expect(error?.code).toBe(code)
    return error!
  })

/**
 * Firing happens immediately rather than waiting out the real deadline, so
 * this backdates `autoAt` first: `alarm()` refuses to resolve a phase before
 * `autoAt` is due (a guard against a DO alarm retry or race, see
 * `AUTO_AT_TOLERANCE_MS` in src/room.ts), and a legitimately-fired alarm's
 * deadline has always already passed. Inlined as one `runInDurableObject`
 * round trip (mirroring `runDurableObjectAlarm`'s own get/delete/call
 * sequence) rather than a separate patch-then-fire — real workerd alarms can
 * also land for these rooms in the background, so the shorter this takes,
 * the less that race gets to decide the outcome instead of the test.
 */
const fire = (code: string) =>
  runInDurableObject(testEnv.ROOM.getByName(code), async (instance, state) => {
    if ((await state.storage.getAlarm()) === null) return false
    const record = await state.storage.get<RoomRecord>('room')
    if (record?.autoAt !== undefined && record.autoAt > Date.now()) {
      record.autoAt = Date.now()
      await state.storage.put('room', record)
      // Keep the in-memory cache coherent with storage (same-object contract).
      ;(instance as unknown as { cached: RoomRecord }).cached = record
    }
    await state.storage.deleteAlarm()
    await instance.alarm()
    return true
  })

/** Milliseconds until the room's next alarm, whichever deadline currently owns it. */
const alarmIn = (code: string) =>
  runInDurableObject(
    testEnv.ROOM.getByName(code),
    async (_instance, state) => (await state.storage.getAlarm())! - Date.now(),
  )

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

/** Rearrange the game itself — a shortcut to positions that would take an hour to play to. */
const patchGame = (code: string, patch: (state: GameState) => Partial<GameState>) =>
  patchRecord(code, (record) => {
    const state = record.gameState as GameState
    record.gameState = { ...state, ...patch(state) }
  })

async function estateRoom(seats: number, options?: unknown) {
  const guestId = crypto.randomUUID()
  const res = await SELF.fetch('https://api.test/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      game: 'estate',
      visibility: 'private',
      name: 'Ann',
      guestId,
      seats,
      ...(options ? { options } : {}),
    }),
  })
  expect(res.status).toBe(201)
  const { code } = await res.json<{ code: string }>()
  return { code, guestId }
}

/** A table under way: one seat per name, taken in order, host first. */
async function startedTable(names: string[], seats = names.length, options?: unknown) {
  const { code, guestId } = await estateRoom(seats, options)
  const clients: Client[] = []
  const ids: string[] = []
  for (const [index, name] of names.entries()) {
    const client = await connect(code)
    ids.push(client.join(name, index === 0 ? guestId : undefined))
    client.send({ type: 'sit', seat: `p${index}` })
    await client.waitRoom((m) => m.you.seat === `p${index}`)
    clients.push(client)
  }
  clients[0].send({ type: 'start' })
  for (const client of clients) await client.waitRoom((m) => m.snapshot.status === 'playing')
  return { code, clients, ids }
}

/**
 * Wind the room forward on its own clock until the table gets where it is going.
 * Only a *game* deadline may be fired: when nothing is pending the alarm slot
 * belongs to the room's 24h expiry, and firing that deletes the room.
 */
async function playOn(code: string, until: (state: GameState) => boolean, limit = 24) {
  for (let step = 0; step < limit; step++) {
    const record = (await readRecord(code))!
    const state = record.gameState as GameState
    if (until(state)) return state
    expect(record.autoAt, 'the room has no game deadline left to fire').toBeDefined()
    expect(await fire(code)).toBe(true)
  }
  throw new Error('the table never got where it was going')
}

const offer = (over: Partial<Trade> = {}): Trade => ({
  from: 0,
  to: 1,
  giveCash: 100,
  getCash: 0,
  giveProperties: [],
  getProperties: [],
  ...over,
})

describe('an estate room', () => {
  it('holds the dice on its own clock, then walks the whole way at once', async () => {
    const { code, clients } = await startedTable(['Ann', 'Ben'])
    const [ann, ben] = clients
    const opening = await seeTable(ann, (s) => s.status === 'playing')
    expect(table(opening).players.map((p) => p.name)).toEqual(['Ann', 'Ben'])
    expect(table(opening).players[0].position).toBe(0)

    const mark = ann.messages.length
    // Two logs, two marks: a message index means nothing in another socket's log.
    const bensMark = ben.messages.length
    ann.send({ type: 'action', action: { type: 'ROLL' } })
    // The dice are cast and everybody is told so — and nothing else has happened.
    const rolling = await seeNext(ann, mark, (m) => table(m).phase === 'rolling')
    const total = table(rolling).dice[0] + table(rolling).dice[1]
    expect(table(rolling).rollId).toBe(1)
    expect(table(rolling).players[0].position).toBe(0)
    // Ben is watching the same beat, from the same snapshot.
    expect(table(await seeTable(ben, (s) => s.phase === 'rolling')).dice).toEqual(table(rolling).dice)
    // The phase's seconds own the alarm, not the room's day.
    expect(await alarmIn(code)).toBeLessThanOrEqual(1200 + total * 215 + 330 + 300)

    expect(await fire(code)).toBe(true)
    // One fire, one mutation: the die is read out, the token walks its squares,
    // and the space it stopped on happens.
    const landed = await seeNext(ben, bensMark, (m) => table(m).phase !== 'rolling')
    expect(table(landed).players[0].position).toBe(total)
    expect(table(landed).stepsRemaining).toBe(0)
    expect(['purchase', 'card', 'end', 'debt']).toContain(table(landed).phase)
    // Nothing left to resolve, so the expiry takes the alarm slot back.
    expect(await alarmIn(code)).toBeGreaterThan(23 * 60 * 60 * 1000)
  })

  it('never puts the seed on the wire, whatever else it sends', async () => {
    const { code, clients } = await startedTable(['Ann', 'Ben'])
    const [ann, ben] = clients
    // A deed to manage and a seed worth recognising. Mortgaging spends no
    // randomness, so the seed the room holds is still the sentinel afterwards.
    await patchGame(code, () => ({
      seed: SEED_SENTINEL,
      properties: { 1: { owner: 0, level: 0, mortgaged: false } },
    }))

    const mark = ann.messages.length
    ann.send({ type: 'action', action: { type: 'MORTGAGE', property: 1 } })
    const mortgaged = await seeNext(ann, mark, (m) => table(m).properties[1]?.mortgaged === true)
    expect(table(mortgaged).players[0].cash).toBe(1530)

    // The room still has the generator; nobody at the table was sent it.
    expect(((await readRecord(code))!.gameState as GameState).seed).toBe(SEED_SENTINEL)
    for (const client of [ann, ben]) {
      const snapshots = dealt(client)
      expect(snapshots.length).toBeGreaterThan(1)
      expect(snapshots.every((m) => table(m).seed === 0)).toBe(true)
      // A scan of the whole frame, not a walk of the fields this test knows about.
      expect(JSON.stringify(snapshots)).not.toContain(String(SEED_SENTINEL))
    }
  })

  it('refuses an action nobody may send, and one that is not an action', async () => {
    const { code, clients } = await startedTable(['Ann', 'Ben'])
    const [ann, ben] = clients
    // The room paces these itself; a browser that sends one is not playing.
    for (const type of ['DICE_SETTLED', 'MOVE_STEP', 'RESOLVE', 'START']) {
      const mark = ann.messages.length
      ann.send({ type: 'action', action: { type } })
      await seeError(ann, mark, 'BAD_MESSAGE')
    }
    const mark = ben.messages.length
    ben.send({ type: 'action', action: { type: 'ROLL' } })
    await seeError(ben, mark, 'NOT_YOUR_TURN')
    // Nothing has moved: the table is exactly where it started.
    expect(((await readRecord(code))!.gameState as GameState).rollId).toBe(0)
  })

  it('carries an offer across the table and lets one seat answer it', async () => {
    const { clients } = await startedTable(['Ann', 'Ben', 'Cai'])
    const [ann, ben, cai] = clients

    ann.send({ type: 'action', action: { type: 'PROPOSE_TRADE', trade: offer() } })
    const pending = await seeTable(ben, (s) => s.trade !== null)
    expect(table(pending).trade).toEqual(offer())
    // Everyone can see the offer; the table is waiting on the seat it was made to.
    expect(table(await seeTable(cai, (s) => s.trade !== null)).trade).toEqual(offer())

    // A bystander may neither take it nor tear it up.
    let mark = cai.messages.length
    cai.send({ type: 'action', action: { type: 'ACCEPT_TRADE' } })
    await seeError(cai, mark, 'NOT_ALLOWED')
    mark = cai.messages.length
    cai.send({ type: 'action', action: { type: 'REJECT_TRADE' } })
    await seeError(cai, mark, 'NOT_ALLOWED')

    // Nor may the seat that made it accept on the other's behalf…
    mark = ann.messages.length
    ann.send({ type: 'action', action: { type: 'ACCEPT_TRADE' } })
    await seeError(ann, mark, 'NOT_ALLOWED')
    // …or carry on with her turn while it stands.
    mark = ann.messages.length
    ann.send({ type: 'action', action: { type: 'ROLL' } })
    await seeError(ann, mark, 'NOT_ALLOWED')

    mark = ann.messages.length
    ben.send({ type: 'action', action: { type: 'ACCEPT_TRADE' } })
    const settled = await seeNext(ann, mark, (m) => table(m).trade === null)
    expect(table(settled).players.map((p) => p.cash)).toEqual([1400, 1600, 1500])
    expect(table(settled).current).toBe(0)
  })

  it('lets either party end an offer, and the turn carry on afterwards', async () => {
    const { clients } = await startedTable(['Ann', 'Ben', 'Cai'])
    const [ann, ben] = clients

    // The seat it was made to declines it.
    ann.send({ type: 'action', action: { type: 'PROPOSE_TRADE', trade: offer() } })
    await seeTable(ben, (s) => s.trade !== null)
    let mark = ann.messages.length
    ben.send({ type: 'action', action: { type: 'REJECT_TRADE' } })
    const declined = await seeNext(ann, mark, (m) => table(m).trade === null)
    expect(table(declined).players.map((p) => p.cash)).toEqual([1500, 1500, 1500])

    // And the seat that made it thinks better of the next one.
    mark = ben.messages.length
    ann.send({ type: 'action', action: { type: 'PROPOSE_TRADE', trade: offer({ to: 2 }) } })
    await seeNext(ben, mark, (m) => table(m).trade !== null)
    mark = ben.messages.length
    ann.send({ type: 'action', action: { type: 'REJECT_TRADE' } })
    const withdrawn = await seeNext(ben, mark, (m) => table(m).trade === null)
    expect(table(withdrawn).players.map((p) => p.cash)).toEqual([1500, 1500, 1500])

    // With nothing on the table Ann's turn goes on as it always would.
    mark = ann.messages.length
    ann.send({ type: 'action', action: { type: 'ROLL' } })
    expect(table(await seeNext(ann, mark, (m) => table(m).phase === 'rolling')).rollId).toBe(1)
  })

  it('ends the game when the last debt cannot be paid', async () => {
    const { code, clients } = await startedTable(['Ann', 'Ben'])
    const [ann, ben] = clients
    // Ben owes far more than the table is worth, on his own turn.
    await patchGame(code, () => ({
      current: 1,
      phase: 'debt',
      debt: { amount: 4000, creditor: 0, reason: 'Golden Row rent' },
    }))

    // A debt is the debtor's to settle. Ann cannot declare it for him.
    let mark = ann.messages.length
    ann.send({ type: 'action', action: { type: 'BANKRUPT' } })
    await seeError(ann, mark, 'NOT_YOUR_TURN')

    mark = ann.messages.length
    ben.send({ type: 'action', action: { type: 'LIQUIDATE' } })
    // Nothing to sell and nothing to mortgage: the debt stands, and so does he.
    await seeNext(ann, mark, (m) => table(m).events.length > 0)
    mark = ann.messages.length
    ben.send({ type: 'action', action: { type: 'BANKRUPT' } })

    const over = await seeNext(ann, mark, (m) => m.snapshot.status === 'finished')
    expect(table(over).status).toBe('finished')
    expect(table(over).winner).toBe(0)
    expect(table(over).players[1].bankrupt).toBe(true)
    expect(table(over).seed).toBe(0)
    // A finished game has no beats left to wait out.
    expect(await alarmIn(code)).toBeGreaterThan(23 * 60 * 60 * 1000)
  })

  it('deals a fresh city when the table asks for a rematch', async () => {
    const { code, clients } = await startedTable(['Ann', 'Ben'])
    const [ann, ben] = clients
    await patchRecord(code, (record) => {
      const state = record.gameState as GameState
      record.gameState = {
        ...state,
        status: 'finished',
        winner: 0,
        players: state.players.map((p, i) => (i === 1 ? { ...p, bankrupt: true } : p)),
      }
      record.status = 'finished'
      record.autoAt = undefined
    })

    ann.send({ type: 'rematch' })
    const waiting = await ann.waitRoom((m) => m.snapshot.seats.p0?.wantsRematch === true)
    // One seat is not the table: the game stands until everyone has asked.
    expect(waiting.snapshot.status).toBe('finished')

    const mark = ann.messages.length
    ben.send({ type: 'rematch' })
    const fresh = await seeNext(ann, mark, (m) => m.snapshot.status === 'playing')
    expect(table(fresh).players.map((p) => p.name)).toEqual(['Ann', 'Ben'])
    expect(table(fresh).players.every((p) => !p.bankrupt)).toBe(true)
    expect(table(fresh).players.map((p) => p.cash)).toEqual([1500, 1500])
    expect(table(fresh).turn).toBe(1)
    expect(table(fresh).rollId).toBe(0)
    // A new city comes with a new generator, and it stays on the server.
    expect(table(fresh).seed).toBe(0)
    expect(((await readRecord(code))!.gameState as GameState).seed).not.toBe(0)
  })

  it('plays an abandoned seat’s turn rather than awarding the game', async () => {
    const { code, clients, ids } = await startedTable(['Ann', 'Ben'])
    const [ann, ben] = clients
    // Hand the table to Ben, so it is his turn that goes unanswered.
    await patchGame(code, () => ({ current: 1 }))

    ben.ws.close()
    await ann.waitRoom((m) => m.snapshot.seats.p1?.connected === false)
    await patchRecord(code, (record) => {
      record.seats.p1!.disconnectedAt = Date.now() - CLAIM_WIN_AFTER_MS - 1000
    })

    const mark = ann.messages.length
    ann.send({ type: 'claim' })
    // There is no winning a property empire by default: the claim hands Ben's
    // seat to the room, which begins by rolling the dice he left sitting there.
    const claimed = await seeNext(ann, mark, (m) => m.snapshot.seats.p1?.abandoned === true)
    expect(claimed.snapshot.status).toBe('playing')
    expect(table(claimed).phase).toBe('rolling')
    expect(table(claimed).rollId).toBe(1)

    // And it keeps playing his turn, beat by beat, until the table is Ann's.
    const handedOver = await playOn(code, (state) => state.current === 0 || state.status !== 'playing')
    expect(handedOver.status).toBe('playing')
    expect(handedOver.players.every((p) => !p.bankrupt)).toBe(true)
    expect(handedOver.players[1].position).toBeGreaterThan(0)
    // Ann's own turn waits for her rather than being played through.
    expect((await readRecord(code))!.autoAt).toBeUndefined()

    // Ben comes back to the same seat with the same id, and the room stops.
    const back = await connect(code)
    back.join('Ben', ids[1])
    await back.waitRoom((m) => m.you.seat === 'p1')
    expect((await readRecord(code))!.seats.p1?.abandoned).toBeUndefined()
  })

  it('answers an offer made to a seat the room is playing', async () => {
    const { code, clients } = await startedTable(['Ann', 'Ben'])
    const [ann, ben] = clients
    ben.ws.close()
    await ann.waitRoom((m) => m.snapshot.seats.p1?.connected === false)
    await patchRecord(code, (record) => {
      record.seats.p1!.disconnectedAt = Date.now() - CLAIM_WIN_AFTER_MS - 1000
      record.seats.p1!.abandoned = true
    })

    // A gift, which a stand-in has no reason to turn down.
    const mark = ann.messages.length
    ann.send({ type: 'action', action: { type: 'PROPOSE_TRADE', trade: offer({ giveCash: 500 }) } })
    await seeNext(ann, mark, (m) => table(m).trade !== null)
    // The room is waiting on a seat nobody is sitting in, so it answers for it.
    const answered = await playOn(code, (state) => state.trade === null)
    expect(answered.players.map((p) => p.cash)).toEqual([1000, 2000])
    expect(answered.current).toBe(0)
  })

  it('plays a room made for four with the three who turned up', async () => {
    const { clients } = await startedTable(['Ann', 'Ben', 'Cai'], 4)
    const opening = await seeTable(clients[0], (s) => s.status === 'playing')
    expect(opening.snapshot.seatIds).toEqual(['p0', 'p1', 'p2'])
    expect(table(opening).players.map((p) => p.name)).toEqual(['Ann', 'Ben', 'Cai'])
    expect(table(opening).current).toBe(0)
  })

  it('plays the quick economy when the room was made for it', async () => {
    const { clients } = await startedTable(['Ann', 'Ben'], 2, { mode: 'quick' })
    const opening = await seeTable(clients[1], (s) => s.status === 'playing')
    expect(table(opening).mode).toBe('quick')
    expect(table(opening).players.map((p) => p.cash)).toEqual([1000, 1000])
  })
})
