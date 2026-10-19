import { env, runInDurableObject, SELF } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { phasePause } from '@games/shared/hearth'
import { CLAIM_WIN_AFTER_MS } from '@games/shared/protocol'
import type { ServerMessage } from '@games/shared/protocol'
import type { GameState } from '@games/shared/hearth/types'
import type { Env } from '../src/env'
import type { RoomRecord } from '../src/room'
import { connect, fire, WAIT } from './helpers'
import type { Client } from './helpers'

const testEnv = env as unknown as Env
type RoomMessage = Extract<ServerMessage, { type: 'room' }>

const board = (message: RoomMessage) => message.snapshot.gameState as GameState
/**
 * Observe the table: only ever through a broadcast, never off live room state —
 * and, for anything the table passes through more than once, only from `from`
 * on. Every turn goes `roll` → `rolling` → `pass`, so a search of the whole log
 * finds the last turn's `rolling` before the server has started this one.
 */
const seeTable = (client: Client, predicate: (state: GameState) => boolean, from = 0) =>
  client.waitRoom((m) => predicate(board(m as unknown as RoomMessage)), from)
const seePhase = (client: Client, phase: GameState['phase'], from = 0) =>
  seeTable(client, (state) => state.phase === phase, from)
/** `fire`'s guard: only run the beat while the room is still sitting in one of these phases. */
const inPhase =
  (...phases: GameState['phase'][]) =>
  (record: RoomRecord) =>
    phases.includes((record.gameState as GameState).phase)

/**
 * Watch only what arrives from `from` onwards. `waitRoom` searches the whole log,
 * which is the wrong question after `patchRecord`: that writes storage without
 * broadcasting, so the newest snapshot a client holds can still describe a room
 * the server has already moved past.
 */
const seeNext = (client: Client, from: number, predicate: (m: RoomMessage) => boolean) =>
  vi.waitFor(() => {
    // `Client` types its log as chess, which every other game narrows for itself.
    const log = client.messages.slice(from) as unknown as ServerMessage[]
    const room = log.filter((m): m is RoomMessage => m.type === 'room').findLast(predicate)
    expect(room).toBeDefined()
    return room!
  }, WAIT)

const alarmIn = (code: string) =>
  runInDurableObject(
    testEnv.ROOM.getByName(code),
    async (_instance, state) => (await state.storage.getAlarm())! - Date.now(),
  )
const readRecord = (code: string) =>
  runInDurableObject(testEnv.ROOM.getByName(code), async (_instance, state) =>
    state.storage.get<RoomRecord>('room'),
  )

/**
 * Rewrite part of the stored record, keeping the instance's cache coherent —
 * and its alarm, the way `armAlarm` would. A patch that ends the game mid-beat
 * otherwise left that beat's alarm armed, and when it came due with nothing
 * pending the room took it for its expiry and deleted itself under the test.
 */
async function patchRecord(code: string, patch: (record: RoomRecord) => void) {
  await runInDurableObject(testEnv.ROOM.getByName(code), async (instance, state) => {
    const record = (await state.storage.get<RoomRecord>('room'))!
    patch(record)
    await state.storage.put('room', record)
    await state.storage.setAlarm(Math.min(record.autoAt ?? Infinity, record.expiresAt))
    // Keep the in-memory cache coherent with storage (same-object contract).
    ;(instance as unknown as { cached: RoomRecord }).cached = record
  })
}

// The server rolls off `secureRandom` (crypto.getRandomValues), and it may
// roll on an alarm workerd delivers rather than one a test fires — so the
// number is pinned for the whole window instead of just around the fire.
// Room codes come from `crypto.randomUUID`, a separate API this mock never
// touches, so they stay distinct.
const realGetRandomValues = crypto.getRandomValues.bind(crypto)
let pinned: number | null = null
/** Pin what the server's next die comes up with; `null` hands it back to chance. */
const useDie = (value: number | null) => {
  pinned = value
}
beforeEach(() => {
  pinned = null
  vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
    if (pinned === null) return realGetRandomValues(array)
    // `secureRandom` turns one crypto uint32 into a [0, 1) fraction; land it on
    // the same midpoint the old `Math.random` mock used, so a pinned value of
    // `n` still rolls the die face `n`.
    const fraction = (pinned - 0.5) / 6
    if (array instanceof Uint32Array) array[0] = Math.floor(fraction * 2 ** 32)
    return array
  })
})
afterEach(() => {
  vi.restoreAllMocks()
})

async function hearthRoom(seats: number) {
  const guestId = crypto.randomUUID()
  const res = await SELF.fetch('https://api.test/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ game: 'hearth', visibility: 'private', name: 'Ann', guestId, seats }),
  })
  expect(res.status).toBe(201)
  const { code } = await res.json<{ code: string }>()
  return { code, guestId }
}

/** A started table: one seat per name, taken in order, host first. */
async function startedTable(names: string[]) {
  const { code, guestId } = await hearthRoom(names.length)
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
 * One whole turn for the seat on turn, rolling `die`. Anything but a six with
 * every piece still in the nest cannot be played, which is how a turn is handed
 * on without a move.
 */
async function playTurn(code: string, client: Client, die: number) {
  useDie(die)
  const from = client.mark()
  client.send({ type: 'action', action: { kind: 'roll' } })
  await seePhase(client, 'rolling', from)
  await fire(code, inPhase('rolling'))
  const settled = await seeTable(client, (state) => state.phase === 'choose' || state.phase === 'pass', from)
  if (board(settled).phase === 'choose') {
    const moved = client.mark()
    client.send({ type: 'action', action: { kind: 'move', pieceId: board(settled).legalMoves[0].pieceId } })
    await seePhase(client, 'moving', moved)
  }
  await fire(code, inPhase('moving', 'pass'))
  return seePhase(client, 'roll', from)
}

describe('a hearth room', () => {
  it('compacts three seats onto the table and names the players who turned up', async () => {
    const { clients } = await startedTable(['Ann', 'Ben', 'Cai'])
    const opening = await seePhase(clients[0], 'roll')
    expect(opening.snapshot.seatIds).toEqual(['p0', 'p1', 'p2'])
    expect(board(opening).players.map((p) => p.name)).toEqual(['Ann', 'Ben', 'Cai'])
    expect(board(opening).players.map((p) => p.id)).toEqual(['red', 'blue', 'green'])
    expect(board(opening).currentPlayer).toBe(0)
  })

  it('paces a rolled six through the alarm: die, then choice, then move', async () => {
    const { code, clients } = await startedTable(['Ann', 'Ben', 'Cai'])
    const [ann, ben] = clients
    useDie(6)

    const from = ann.mark()
    ann.send({ type: 'action', action: { kind: 'roll' } })
    // The die is in the air. Nobody has a number — not even the seat that threw it.
    const rolling = await seePhase(ann, 'rolling', from)
    expect(board(rolling).dice).toBeNull()
    // The beat, not the room's day, owns the alarm slot.
    expect(await alarmIn(code)).toBeLessThanOrEqual(phasePause('rolling', false))

    await fire(code, inPhase('rolling'))
    const landed = await seePhase(ann, 'choose')
    expect(board(landed).dice).toBe(6)
    // One die, one number, one moment: the whole table is shown the same roll.
    const bensView = await seePhase(ben, 'choose')
    expect(board(bensView).dice).toBe(6)

    const move = board(landed).legalMoves[0]
    ann.send({ type: 'action', action: { kind: 'move', pieceId: move.pieceId } })
    const moving = await seePhase(ann, 'moving')
    expect(board(moving).motion?.pieceId).toBe(move.pieceId)

    await fire(code, inPhase('moving'))
    // From the throw on: the table opened on a `roll` of its own.
    const next = await seePhase(ann, 'roll', from)
    expect(board(next).pieces.find((p) => p.id === move.pieceId)?.progress).toBe(0)
    // A six earns another roll, so the turn stays where it was.
    expect(board(next).currentPlayer).toBe(0)
  })

  it('holds an unplayable roll, then hands the turn on by itself', async () => {
    const { code, clients } = await startedTable(['Ann', 'Ben', 'Cai'])
    const [ann] = clients
    useDie(3)

    const from = ann.mark()
    ann.send({ type: 'action', action: { kind: 'roll' } })
    await seePhase(ann, 'rolling', from)
    await fire(code, inPhase('rolling'))
    // Every piece is still in the nest and only a six lets one out.
    const held = await seePhase(ann, 'pass', from)
    expect(board(held).legalMoves).toEqual([])
    expect(await alarmIn(code)).toBeLessThanOrEqual(phasePause('pass', false))

    await fire(code, inPhase('pass'))
    const passed = await seePhase(ann, 'roll', from)
    expect(board(passed).currentPlayer).toBe(1)
  })

  it('refuses an action from a seat that is not on turn, and a malformed one', async () => {
    const { clients } = await startedTable(['Ann', 'Ben'])
    const [, ben] = clients
    ben.send({ type: 'action', action: { kind: 'roll' } })
    await ben.expectError('NOT_YOUR_TURN')
    ben.send({ type: 'action', action: { kind: 'nonsense' } })
    await ben.expectError('BAD_MESSAGE')
  })

  it('plays an abandoned seat’s turns, and stops the moment its player is back', async () => {
    const { code, clients, ids } = await startedTable(['Ann', 'Ben', 'Cai'])
    const [ann, ben] = clients
    await playTurn(code, ann, 3)
    // The turn is Ben's, and Ben walks away from it.
    ben.ws.close()
    await ann.waitRoom((m) => m.snapshot.seats.p1?.connected === false)
    await patchRecord(code, (record) => {
      record.seats.p1!.disconnectedAt = Date.now() - CLAIM_WIN_AFTER_MS - 1000
    })

    useDie(2)
    const from = ann.mark()
    ann.send({ type: 'claim' })
    // A race has no win-by-default: the claim hands Ben's seat to the room, which
    // begins by taking the roll he was sitting on.
    await seePhase(ann, 'rolling', from)
    const claimed = (await readRecord(code))!
    expect(claimed.status).toBe('playing')
    expect(claimed.seats.p1?.abandoned).toBe(true)

    await fire(code, inPhase('rolling'))
    await seePhase(ann, 'pass', from)
    await fire(code, inPhase('pass'))
    // Ben's turn was taken for him, and the table has moved on to Cai.
    const movedOn = await seeTable(ann, (state) => state.currentPlayer === 2, from)
    expect(board(movedOn).players[1].stats.rolls).toBe(1)
    expect(board(movedOn).phase).toBe('roll')
    // Cai is here, so nothing is waiting on a timer any more.
    expect(await alarmIn(code)).toBeGreaterThan(23 * 60 * 60 * 1000)

    // Ben comes back to the same seat with the same id.
    const back = await connect(code)
    back.join('Ben', ids[1])
    await back.waitRoom((m) => m.you.seat === 'p1')
    expect((await readRecord(code))!.seats.p1?.abandoned).toBeUndefined()
    // The table hears he is back a beat later (arrivals are told together), and
    // that snapshot must land before the marks below, not inside them.
    await clients[2].waitRoom((m) => m.snapshot.seats.p1?.connected === true)

    // Round the table: Cai, then Ann, and the turn is Ben's again.
    const round = back.mark()
    await playTurn(code, clients[2], 3)
    await playTurn(code, ann, 3)
    const bensTurn = await seeTable(back, (state) => state.currentPlayer === 1, round)
    expect(board(bensTurn).phase).toBe('roll')
    // His turn waits for him now, rather than being played through.
    expect(await alarmIn(code)).toBeGreaterThan(23 * 60 * 60 * 1000)
    expect(board(bensTurn).players[1].stats.rolls).toBe(1)
  })

  it('plays on at a two-seat table rather than awarding it', async () => {
    const { code, clients } = await startedTable(['Ann', 'Ben'])
    const [ann, ben] = clients
    await playTurn(code, ann, 3)
    ben.ws.close()
    await ann.waitRoom((m) => m.snapshot.seats.p1?.connected === false)
    await patchRecord(code, (record) => {
      record.seats.p1!.disconnectedAt = Date.now() - CLAIM_WIN_AFTER_MS - 1000
    })

    useDie(2)
    const from = ann.mark()
    ann.send({ type: 'claim' })
    await seePhase(ann, 'rolling', from)
    await fire(code, inPhase('rolling'))
    await seePhase(ann, 'pass', from)
    await fire(code, inPhase('pass'))
    // Ludo's engine has no forfeit state, so the game comes back to Ann and goes on.
    const back = await seeTable(ann, (state) => state.currentPlayer === 0, from)
    expect(board(back).phase).toBe('roll')
    expect(board(back).winner).toBeNull()
    expect((await readRecord(code))!.status).toBe('playing')
  })

  it('tells the table which seat it is playing for', async () => {
    const { code, clients } = await startedTable(['Ann', 'Ben', 'Cai'])
    const [ann, ben] = clients
    await playTurn(code, ann, 3)
    ben.ws.close()
    await ann.waitRoom((m) => m.snapshot.seats.p1?.connected === false)
    // Away is not the same as claimed: nothing says so until the claim lands.
    const away = await ann.waitRoom((m) => m.snapshot.seats.p1?.awaySince !== undefined)
    expect(away.snapshot.seats.p1?.abandoned).toBeUndefined()

    await patchRecord(code, (record) => {
      record.seats.p1!.disconnectedAt = Date.now() - CLAIM_WIN_AFTER_MS - 1000
    })
    useDie(2)
    ann.send({ type: 'claim' })
    // The snapshot carries the flag, which is how the table stops asking to claim
    // a seat the room is already playing.
    const claimed = await ann.waitRoom((m) => m.snapshot.seats.p1?.abandoned === true)
    expect(claimed.snapshot.seats.p0?.abandoned).toBeUndefined()
  })

  it('does not let a repeated claim push the beat it is watching out', async () => {
    const { code, clients } = await startedTable(['Ann', 'Ben', 'Cai'])
    const [ann, ben] = clients
    await playTurn(code, ann, 3)
    ben.ws.close()
    await ann.waitRoom((m) => m.snapshot.seats.p1?.connected === false)
    await patchRecord(code, (record) => {
      record.seats.p1!.disconnectedAt = Date.now() - CLAIM_WIN_AFTER_MS - 1000
    })

    useDie(2)
    const from = ann.mark()
    ann.send({ type: 'claim' })
    // Ben's seat is now mid-roll, on a beat the whole table is watching.
    await seePhase(ann, 'rolling', from)
    // Hold the beat a minute out, so workerd's own alarm cannot land it while
    // this test is still asking whether the claims below moved it.
    const due = Date.now() + 60_000
    await patchRecord(code, (record) => {
      record.autoAt = due
    })

    // Claiming again settles nothing — Ben's seat has no decision outstanding —
    // so it must leave that beat exactly where it was. Before the guard each of
    // these pushed the die another 1.1s into the future.
    const again = ann.mark()
    ann.send({ type: 'claim' })
    ann.send({ type: 'claim' })
    // Each claim is answered with a broadcast; two answers, both claims settled.
    await vi.waitFor(
      () => expect(ann.messages.slice(again).filter((m) => m.type === 'room')).toHaveLength(2),
      WAIT,
    )
    const after = (await readRecord(code))!
    expect(after.seats.p1?.abandoned).toBe(true)
    expect(after.autoAt).toBe(due)

    // And the beat still lands on the number it was always going to land on.
    await fire(code, inPhase('rolling'))
    const rolled = await seeTable(ann, (state) => state.dice === 2, from)
    expect(board(rolled).phase).toBe('pass')
  })

  it('rematches on the consent of the players who are still here', async () => {
    const { code, clients, ids } = await startedTable(['Ann', 'Ben', 'Cai'])
    const [ann, ben, cai] = clients
    await playTurn(code, ann, 3)
    ben.ws.close()
    await ann.waitRoom((m) => m.snapshot.seats.p1?.connected === false)
    await patchRecord(code, (record) => {
      record.seats.p1!.disconnectedAt = Date.now() - CLAIM_WIN_AFTER_MS - 1000
    })
    useDie(2)
    ann.send({ type: 'claim' })
    await ann.waitRoom((m) => m.snapshot.seats.p1?.abandoned === true)

    // Jump to the end rather than playing four pieces home three times over.
    await patchRecord(code, (record) => {
      record.gameState = { ...(record.gameState as GameState), phase: 'won', winner: 'red' }
      record.status = 'finished'
      record.autoAt = undefined
    })

    ann.send({ type: 'rematch' })
    const waiting = await ann.waitRoom((m) => m.snapshot.seats.p0?.wantsRematch === true)
    // Ann alone is not the table: Cai is still here and has not said yes.
    expect(waiting.snapshot.status).toBe('finished')

    const before = ann.messages.length
    cai.send({ type: 'rematch' })
    // Ben never asks for anything — the room plays his seat — so waiting on him
    // would have left this table finished forever.
    const fresh = await seeNext(ann, before, (m) => m.snapshot.status === 'playing')
    expect(board(fresh).turn).toBe(1)
    expect(board(fresh).pieces.every((p) => p.progress === -1)).toBe(true)
    expect(board(fresh).players.map((p) => p.name)).toEqual(['Ann', 'Ben', 'Cai'])
    // Ben rides into the new game still abandoned, and still played for.
    expect(fresh.snapshot.seats.p1?.abandoned).toBe(true)
    expect(fresh.snapshot.seats.p0?.wantsRematch).toBe(false)

    // Coming back is still what ends it.
    const back = await connect(code)
    back.join('Ben', ids[1])
    await back.waitRoom((m) => m.you.seat === 'p1')
    expect((await readRecord(code))!.seats.p1?.abandoned).toBeUndefined()
    // The table hears he is back a beat later (arrivals are told together), and
    // that snapshot must land before the marks below, not inside them.
    await clients[2].waitRoom((m) => m.snapshot.seats.p1?.connected === true)
  })
})
