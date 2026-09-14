import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import { registerAdapter } from '@games/shared/online'
import type { GameAdapter } from '@games/shared/online/adapter'
import { CLAIM_WIN_AFTER_MS } from '@games/shared/protocol'
import type { GameId, ServerMessage } from '@games/shared/protocol'
import type { Env } from '../src/env'
import type { RoomRecord } from '../src/room'
import { connect } from './helpers'

const testEnv = env as unknown as Env
/** Mirrors `MAX_AUTO_ADVANCES` in src/room.ts — the phases one alarm may resolve. */
const MAX_AUTO_ADVANCES = 20
/** Mirrors `STAND_IN_DELAY_MS` in src/room.ts. */
const STAND_IN_DELAY_MS = 1200

/**
 * Pass-the-parcel: a two-to-four seat game whose only rule is that handing the
 * parcel on takes a moment. Chess never sits in a timed phase, so this stands in
 * to exercise the room's auto-advance alarm. One throw sends the parcel through
 * `hops` pairs of hands: the first takes `afterMs`, the rest are instant, which
 * is how the room's zero-delay chaining gets exercised.
 */
interface ParcelState {
  seats: string[]
  holder: number
  passes: number
  /** Hands the parcel has left to travel through; zero means it has landed. */
  left: number
  afterMs: number
  hops: number
}

const flying = (state: ParcelState) => state.left > 0

const parcelAdapter: GameAdapter<ParcelState, 'pass'> = {
  id: 'hearth',
  minSeats: 2,
  maxSeats: 4,
  requireFull: false,
  seatIds: (count) => Array.from({ length: count }, (_, i) => `p${i}`),
  validateOptions: (raw) => {
    const { afterMs, hops } = (raw ?? {}) as { afterMs?: unknown; hops?: unknown }
    return {
      afterMs: typeof afterMs === 'number' ? afterMs : 50,
      hops: typeof hops === 'number' ? hops : 1,
    }
  },
  validateAction: (raw) => (raw === 'pass' ? 'pass' : null),
  create: (seats, options) => ({
    seats: seats.map((seat) => seat.id),
    holder: 0,
    passes: 0,
    left: 0,
    ...(options as { afterMs: number; hops: number }),
  }),
  apply: (state, seat) =>
    state.seats[state.holder] === seat
      ? { state: { ...state, left: state.hops } }
      : { error: 'NOT_YOUR_TURN', message: 'You do not have the parcel.' },
  pending: (state) =>
    flying(state)
      ? {
          // Only the first hand waits; the parcel then flies on without pausing.
          afterMs: state.left === state.hops ? state.afterMs : 0,
          resolve: (s) => ({
            ...s,
            left: s.left - 1,
            holder: (s.holder + 1) % s.seats.length,
            passes: s.passes + 1,
          }),
        }
      : null,
  view: (state) => state,
  /** The parcel game has no end of its own; chess covers the finishing path. */
  isFinished: () => false,
  waitingOn: (state) => (flying(state) ? [] : [state.seats[state.holder]]),
  resolveAbsent: () => null,
  bots: null,
  rematch: (prev) => ({ state: { ...prev, holder: 0, passes: 0, left: 0 } }),
}

registerAdapter(parcelAdapter)

/**
 * A name no shipping game answers to. The registry keys off whatever id an
 * adapter carries and `resolveGame` trusts the registry, so a test-only id is
 * bookable here and nowhere else — which keeps this deliberately broken stub off
 * the ids that now have real adapters behind them.
 */
const STALL_GAME = 'stall-test' as GameId

/**
 * A game that says it is blocked on a seat and then refuses to settle it — the
 * shape a buggy adapter takes. The room cannot make such a game move; what it
 * must not do is wake itself on the same state until the room expires a day later.
 */
const stubbornAdapter: GameAdapter<{ seats: string[] }, 'noop'> = {
  id: STALL_GAME,
  minSeats: 2,
  maxSeats: 2,
  requireFull: true,
  seatIds: (count) => Array.from({ length: count }, (_, i) => `p${i}`),
  validateOptions: () => ({}),
  validateAction: (raw) => (raw === 'noop' ? 'noop' : null),
  create: (seats) => ({ seats: seats.map((seat) => seat.id) }),
  /** Any action lands, and changes nothing but the record's timestamps. */
  apply: (state) => ({ state }),
  pending: () => null,
  view: (state) => state,
  isFinished: () => false,
  waitingOn: (state) => [state.seats[0]],
  /** Hands back exactly what it was given, forever. */
  resolveAbsent: (state) => state,
  bots: null,
  rematch: (prev) => ({ state: prev }),
}

registerAdapter(stubbornAdapter)

const parcel = (message: Extract<ServerMessage, { type: 'room' }>) =>
  message.snapshot.gameState as ParcelState

/** A started two-seat parcel game with the parcel already in the air. */
async function parcelGame(afterMs: number, hops = 1) {
  const guestId = crypto.randomUUID()
  const res = await SELF.fetch('https://api.test/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      game: 'hearth',
      visibility: 'private',
      name: 'Ann',
      guestId,
      seats: 2,
      options: { afterMs, hops },
    }),
  })
  expect(res.status).toBe(201)
  const { code } = await res.json<{ code: string }>()

  const host = await connect(code)
  host.join('Ann', guestId)
  host.send({ type: 'sit', seat: 'p0' })
  const guest = await connect(code)
  guest.join('Ben')
  guest.send({ type: 'sit', seat: 'p1' })
  await host.waitRoom((m) => Boolean(m.snapshot.seats.p1))
  host.send({ type: 'start' })
  await host.waitRoom((m) => m.snapshot.status === 'playing')

  host.send({ type: 'action', action: 'pass' })
  await host.waitRoom((m) => flying(parcel(m)))
  return { code, host, guest }
}

/**
 * Fire the room's alarm the way these tests need to: right now, rather than
 * waiting out a real deadline. `alarm()` refuses to resolve a phase or
 * stand-in before `autoAt` is due — a guard against a DO alarm retry or race,
 * see `AUTO_AT_TOLERANCE_MS` in src/room.ts — so this backdates `autoAt`
 * first to model the one thing a legitimately-fired alarm always has: its
 * deadline has already passed. Inlined as one `runInDurableObject` round trip
 * (mirroring `runDurableObjectAlarm`'s own get/delete/call sequence) rather
 * than a separate patch-then-fire, since real workerd alarms can also land
 * for these rooms in the background — the shorter this takes, the less that
 * race gets to decide the outcome instead of the test.
 * `fireEarly` below calls the alarm directly, skipping the backdate, to
 * exercise the guard itself.
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

/** Fire the alarm without backdating `autoAt` — a deadline that has not arrived yet. */
const fireEarly = (code: string) => runDurableObjectAlarm(testEnv.ROOM.getByName(code))

/** Milliseconds until the room's next alarm, whichever deadline currently owns it. */
const alarmIn = (code: string) =>
  runInDurableObject(
    testEnv.ROOM.getByName(code),
    async (_instance, state) => (await state.storage.getAlarm())! - Date.now(),
  )

/** The alarm's absolute deadline, for checking it has not quietly moved. */
const alarmAt = (code: string) =>
  runInDurableObject(testEnv.ROOM.getByName(code), async (_instance, state) => state.storage.getAlarm())

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

describe('the room alarm', () => {
  it('resolves a timed phase on its own, then hands the alarm back to the expiry', async () => {
    const { code, host } = await parcelGame(60_000)
    // The phase's minute, not the room's day, owns the alarm slot right now.
    expect(await alarmIn(code)).toBeLessThanOrEqual(60_000)

    expect(await fire(code)).toBe(true)
    const advanced = await host.waitRoom((m) => parcel(m).passes === 1)
    expect(flying(parcel(advanced))).toBe(false)
    expect(parcel(advanced).holder).toBe(1)
    expect(advanced.snapshot.status).toBe('playing')

    // Nothing left to resolve, so the expiry takes the slot back.
    expect(await alarmIn(code)).toBeGreaterThan(23 * 60 * 60 * 1000)
  })

  it('refuses to resolve a phase before its deadline, and re-arms instead of dropping it', async () => {
    // A DO alarm retry or a race with a concurrent save's re-arm can call
    // `alarm()` back before the deadline it named — `fireEarly` reproduces
    // that directly, skipping `fire()`'s backdate.
    const { code, host } = await parcelGame(60_000)
    const before = (await readRecord(code))!
    expect(before.autoAt).toBeGreaterThan(Date.now())
    const scheduledAt = await alarmAt(code)

    expect(await fireEarly(code)).toBe(true)

    // The parcel never left the hand it was in: an early fire is not a free
    // resolve, whatever the adapter would have done with it.
    const after = (await readRecord(code))!
    expect(after.gameState).toEqual(before.gameState)
    expect(after.autoAt).toBe(before.autoAt)
    // And the deadline was not dropped when the runtime consumed the fired
    // alarm: `alarm()` put a fresh one back for the exact same time.
    expect(await alarmAt(code)).toBe(scheduledAt)

    // The same deadline still lands the parcel once it is actually due.
    expect(await fire(code)).toBe(true)
    const landed = await host.waitRoom((m) => parcel(m).passes === 1)
    expect(flying(parcel(landed))).toBe(false)
  })

  it('keeps a phase deadline fixed when an unrelated save happens', async () => {
    const { code, host, guest } = await parcelGame(60_000)
    const before = await alarmAt(code)

    // A disconnect writes the record (stamping awaySince) without touching the
    // game — the parcel must still land when it was always going to.
    guest.ws.close()
    await host.waitRoom((m) => m.snapshot.seats.p1?.connected === false)
    expect(await alarmAt(code)).toBe(before)
  })

  it('collapses a chain of instant phases into one fire', async () => {
    const { code, host } = await parcelGame(60_000, 4)
    expect(await fire(code)).toBe(true)
    // One alarm: the first hand's minute, then three instant hands behind it.
    const landed = await host.waitRoom((m) => !flying(parcel(m)))
    expect(parcel(landed).passes).toBe(4)
    expect(await alarmIn(code)).toBeGreaterThan(23 * 60 * 60 * 1000)
  })

  it('caps how many phases a single fire may resolve', async () => {
    const { code, host } = await parcelGame(60_000, 21)
    expect(await fire(code)).toBe(true)
    // Without the cap the whole chain would collapse into this one fire and the
    // room would only ever broadcast the landed parcel. A snapshot that stops
    // dead on the twentieth hop is the cap, and it is asserted from the message
    // log rather than live state: the room re-arms immediately for the rest of
    // the chain, so anything read afterwards is a race.
    const capped = await host.waitRoom((m) => parcel(m).passes === MAX_AUTO_ADVANCES)
    expect(parcel(capped).left).toBe(1)
    expect(capped.snapshot.status).toBe('playing')
  })

  it('stops chasing a phase deadline once the game is over', async () => {
    // The parcel game has no stand-in for an absent player, so a claim forfeits
    // it mid-flight: finished, but with state the adapter still calls pending.
    const { code, host, guest } = await parcelGame(60_000)
    guest.ws.close()
    await host.waitRoom((m) => m.snapshot.seats.p1?.connected === false)
    await patchRecord(code, (record) => {
      record.seats.p1!.disconnectedAt = Date.now() - CLAIM_WIN_AFTER_MS - 1000
    })

    host.send({ type: 'claim' })
    const over = await host.waitRoom((m) => m.snapshot.status === 'finished')
    expect(flying(parcel(over))).toBe(true)
    // The expiry owns the alarm again: a finished game has nothing to advance.
    expect(await alarmIn(code)).toBeGreaterThan(23 * 60 * 60 * 1000)

    expect(await fire(code)).toBe(true)
    await vi.waitFor(() => expect(host.closes[0]?.code).toBe(4408))
  })

  it('expires the room even with a phase still pending', async () => {
    const { code, host } = await parcelGame(60_000)
    // Backdate the deadline: the parcel is still a minute from landing, so
    // expiry is the only thing this alarm can be about.
    await patchRecord(code, (record) => {
      record.expiresAt = Date.now() - 1000
    })

    expect(await fire(code)).toBe(true)
    await vi.waitFor(() => expect(host.closes[0]?.code).toBe(4408))
    const back = await connect(code)
    await back.expectError('ROOM_NOT_FOUND')
  })

  it('seats fewer players than the room was made for when the game allows it', async () => {
    const guestId = crypto.randomUUID()
    const res = await SELF.fetch('https://api.test/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ game: 'hearth', visibility: 'private', name: 'Ann', guestId, seats: 4 }),
    })
    const { code } = await res.json<{ code: string }>()
    const host = await connect(code)
    host.join('Ann', guestId)
    const open = await host.waitRoom(() => true)
    expect(open.snapshot.seatIds).toEqual(['p0', 'p1', 'p2', 'p3'])

    host.send({ type: 'sit', seat: 'p1' })
    const guest = await connect(code)
    guest.join('Ben')
    guest.send({ type: 'sit', seat: 'p3' })
    await host.waitRoom((m) => Boolean(m.snapshot.seats.p3))
    host.send({ type: 'start' })

    // Two of four turned up: the game is played on two seats, and the players
    // slide down onto them in their original order.
    const playing = await host.waitRoom((m) => m.snapshot.status === 'playing')
    expect(playing.snapshot.seatIds).toEqual(['p0', 'p1'])
    expect(playing.snapshot.seats.p0?.player.name).toBe('Ann')
    expect(playing.snapshot.seats.p1?.player.name).toBe('Ben')
    expect(playing.you.seat).toBe('p0')
  })
})

describe('standing in for an abandoned seat', () => {
  /** Mirrors `MAX_STAND_IN_STALLS` in src/room.ts. */
  const MAX_STAND_IN_STALLS = 5
  const EXPIRY_OWNS_THE_SLOT = 23 * 60 * 60 * 1000

  /** A started stubborn game whose first seat has already been claimed against. */
  async function stubbornGame() {
    const annId = crypto.randomUUID()
    const res = await SELF.fetch('https://api.test/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        game: STALL_GAME,
        visibility: 'private',
        name: 'Ann',
        guestId: annId,
        seats: 2,
      }),
    })
    expect(res.status).toBe(201)
    const { code } = await res.json<{ code: string }>()
    const host = await connect(code)
    host.join('Ann', annId)
    host.send({ type: 'sit', seat: 'p0' })
    const guest = await connect(code)
    const benId = guest.join('Ben')
    guest.send({ type: 'sit', seat: 'p1' })
    await host.waitRoom((m) => Boolean(m.snapshot.seats.p1))
    host.send({ type: 'start' })
    await host.waitRoom((m) => m.snapshot.status === 'playing')

    // This game is blocked on p0 for good, so hand p0's seat to the room directly
    // rather than staging a two-minute absence to get a claim granted.
    await patchRecord(code, (record) => {
      record.seats.p0!.abandoned = true
    })
    return { code, host, guest, annId, benId }
  }

  it('retries a stand-in that settles nothing, then stops rather than spinning', async () => {
    const { code } = await stubbornGame()
    await fire(code)
    // It came back for a second try: a single refusal is not proof of a dead end.
    expect(await alarmIn(code)).toBeLessThanOrEqual(STAND_IN_DELAY_MS)

    for (let attempt = 1; attempt < MAX_STAND_IN_STALLS; attempt++) await fire(code)
    // Enough. The slot goes back to the expiry instead of waking the room on this
    // same state every 1200ms for the next day.
    expect(await alarmIn(code)).toBeGreaterThan(EXPIRY_OWNS_THE_SLOT)
    const record = (await readRecord(code))!
    expect(record.standInStalls).toBeGreaterThanOrEqual(MAX_STAND_IN_STALLS)
    // Giving up on the alarm is not giving up on the room: the table is still live.
    expect(record.status).toBe('playing')
  })

  it('picks the stand-in up again the moment anything else moves', async () => {
    const { code, host, annId } = await stubbornGame()
    for (let attempt = 0; attempt < MAX_STAND_IN_STALLS; attempt++) await fire(code)
    expect(await alarmIn(code)).toBeGreaterThan(EXPIRY_OWNS_THE_SLOT)

    // Every real action goes through `setGameState`, which re-arms the stand-in,
    // so a table that stalled is never a table that cannot be recovered.
    host.send({ type: 'action', action: 'noop' })
    await vi.waitFor(async () => {
      expect(await alarmIn(code)).toBeLessThanOrEqual(STAND_IN_DELAY_MS)
    })

    // And a reclaim ends it outright: p0 is someone's seat again.
    const back = await connect(code)
    back.join('Ann', annId)
    await back.waitRoom((m) => m.you.seat === 'p0')
    const record = (await readRecord(code))!
    expect(record.seats.p0?.abandoned).toBeUndefined()
    expect(record.autoAt).toBeUndefined()
    expect(record.standInStalls).toBeUndefined()
  })

  it('leaves an armed stand-in beat alone when another seat rejoins', async () => {
    const { code, benId } = await stubbornGame()
    // A stand-in already counting down. Held far enough out that only the rejoin
    // below could possibly move it.
    const due = Date.now() + 60_000
    await patchRecord(code, (record) => {
      record.autoAt = due
    })

    // Ben opens a second tab: `handleJoin` runs for a seat with nothing to do with
    // p0's countdown, and the countdown must not move — in either direction.
    const tab = await connect(code)
    tab.join('Ben', benId)
    await tab.waitRoom((m) => m.you.seat === 'p1')
    expect((await readRecord(code))!.autoAt).toBe(due)
  })
})
