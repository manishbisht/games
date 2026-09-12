import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import { registerAdapter } from '@games/shared/online'
import type { GameAdapter } from '@games/shared/online/adapter'
import type { ServerMessage } from '@games/shared/protocol'
import type { Env } from '../src/env'
import type { RoomRecord } from '../src/room'
import { connect } from './helpers'

const testEnv = env as unknown as Env

/**
 * Pass-the-parcel: a two-to-four seat game whose only rule is that handing the
 * parcel on takes a moment. Chess never sits in a timed phase, so this stands in
 * to exercise the room's auto-advance alarm.
 */
interface ParcelState {
  seats: string[]
  holder: number
  passes: number
  /** True while the parcel is in the air — the phase the room resolves on a timer. */
  flying: boolean
  afterMs: number
}

const parcelAdapter: GameAdapter<ParcelState, 'pass'> = {
  id: 'hearth',
  minSeats: 2,
  maxSeats: 4,
  requireFull: false,
  seatIds: (count) => Array.from({ length: count }, (_, i) => `p${i}`),
  validateOptions: (raw) => {
    const afterMs = (raw as { afterMs?: unknown } | null)?.afterMs
    return { afterMs: typeof afterMs === 'number' ? afterMs : 50 }
  },
  validateAction: (raw) => (raw === 'pass' ? 'pass' : null),
  create: (seats, options) => ({
    seats: seats.map((seat) => seat.id),
    holder: 0,
    passes: 0,
    flying: false,
    afterMs: (options as { afterMs: number }).afterMs,
  }),
  apply: (state, seat) =>
    state.seats[state.holder] === seat
      ? { state: { ...state, flying: true } }
      : { error: 'NOT_YOUR_TURN', message: 'You do not have the parcel.' },
  pending: (state) =>
    state.flying
      ? {
          afterMs: state.afterMs,
          resolve: (s) => ({
            ...s,
            flying: false,
            holder: (s.holder + 1) % s.seats.length,
            passes: s.passes + 1,
          }),
        }
      : null,
  view: (state) => state,
  isFinished: (state) => state.passes >= 3,
  waitingOn: (state) => (state.flying ? [] : [state.seats[state.holder]]),
  resolveAbsent: () => null,
  rematch: (prev) => ({ state: { ...prev, holder: 0, passes: 0, flying: false } }),
}

registerAdapter(parcelAdapter)

const parcel = (message: Extract<ServerMessage, { type: 'room' }>) =>
  message.snapshot.gameState as ParcelState

/** A started two-seat parcel game with the parcel already in the air. */
async function parcelGame(afterMs: number) {
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
      options: { afterMs },
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
  await host.waitRoom((m) => parcel(m).flying)
  return { code, host, guest }
}

/** Milliseconds until the room's next alarm, whichever deadline currently owns it. */
const alarmIn = (code: string) =>
  runInDurableObject(
    testEnv.ROOM.getByName(code),
    async (_instance, state) => (await state.storage.getAlarm())! - Date.now(),
  )

describe('the room alarm', () => {
  it('resolves a timed phase on its own, then hands the alarm back to the expiry', async () => {
    const { code, host } = await parcelGame(60_000)
    // The phase's minute, not the room's day, owns the alarm slot right now.
    expect(await alarmIn(code)).toBeLessThanOrEqual(60_000)

    expect(await runDurableObjectAlarm(testEnv.ROOM.getByName(code))).toBe(true)
    const advanced = await host.waitRoom((m) => parcel(m).passes === 1)
    expect(parcel(advanced).flying).toBe(false)
    expect(parcel(advanced).holder).toBe(1)
    expect(advanced.snapshot.status).toBe('playing')

    // Nothing left to resolve, so the expiry takes the slot back.
    expect(await alarmIn(code)).toBeGreaterThan(23 * 60 * 60 * 1000)
  })

  it('expires the room even with a phase still pending', async () => {
    const { code, host } = await parcelGame(60_000)
    const stub = testEnv.ROOM.getByName(code)
    // Backdate the deadline: the parcel is still a minute from landing, so
    // expiry is the only thing this alarm can be about.
    await runInDurableObject(stub, async (instance, state) => {
      const record = (await state.storage.get<RoomRecord>('room'))!
      record.expiresAt = Date.now() - 1000
      await state.storage.put('room', record)
      // Keep the in-memory cache coherent with storage (same-object contract).
      ;(instance as unknown as { cached: RoomRecord }).cached = record
    })

    expect(await runDurableObjectAlarm(stub)).toBe(true)
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
