import { env, runInDurableObject, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { registerAdapter } from '@games/shared/online'
import type { GameAdapter } from '@games/shared/online/adapter'
import type { GameId } from '@games/shared/protocol'
import type { Env } from '../src/env'
import type { RoomRecord } from '../src/room'
import { connect } from './helpers'

const testEnv = env as unknown as Env

const patchRecord = (code: string, patch: (record: RoomRecord) => void) =>
  runInDurableObject(testEnv.ROOM.getByName(code), async (instance, state) => {
    const record = (await state.storage.get<RoomRecord>('room'))!
    patch(record)
    await state.storage.put('room', record)
    ;(instance as unknown as { cached: RoomRecord }).cached = record
  })

const readRecord = (code: string) =>
  runInDurableObject(testEnv.ROOM.getByName(code), async (_instance, state) =>
    state.storage.get<RoomRecord>('room'),
  )

/** Backdate `autoAt` and fire, mirroring `fire()` in alarm.test.ts. */
const fire = (code: string) =>
  runInDurableObject(testEnv.ROOM.getByName(code), async (instance, state) => {
    if ((await state.storage.getAlarm()) === null) return false
    const record = await state.storage.get<RoomRecord>('room')
    if (record?.autoAt !== undefined && record.autoAt > Date.now()) {
      record.autoAt = Date.now()
      await state.storage.put('room', record)
      ;(instance as unknown as { cached: RoomRecord }).cached = record
    }
    await state.storage.deleteAlarm()
    await instance.alarm()
    return true
  })

/** A started two-seat Wildrise game whose p1 has been turned into a bot seat. */
async function botGame() {
  const guestId = crypto.randomUUID()
  const res = await SELF.fetch('https://api.test/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ game: 'wildrise', visibility: 'private', name: 'Ann', guestId, seats: 2 }),
  })
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
  await patchRecord(code, (record) => {
    record.seats.p1 = {
      player: { id: 'bot:p1', name: 'Jules', isGuest: true },
      wantsRematch: false,
      bot: { skill: 'casual' },
    }
  })
  return { code, host }
}

/**
 * A game blocked on every seat at once. No shipping adapter does this today —
 * each answers `waitingOn` with exactly one seat — which is precisely why the
 * stub exists: `autoSeat` scans the whole waiting list for a bot, and without
 * this nothing would hold that behaviour in place. No shipping game answers to
 * this id, so registering it here cannot reach a real room.
 */
const COUNCIL_GAME = 'council-test' as GameId

interface CouncilState {
  seats: string[]
  votes: string[]
}

const councilAdapter: GameAdapter<CouncilState, 'vote'> = {
  id: COUNCIL_GAME,
  minSeats: 2,
  maxSeats: 2,
  requireFull: true,
  seatIds: (count) => Array.from({ length: count }, (_, i) => `p${i}`),
  validateOptions: () => ({}),
  validateAction: (raw) => (raw === 'vote' ? 'vote' : null),
  create: (seats) => ({ seats: seats.map((seat) => seat.id), votes: [] }),
  apply: (state, seat) => ({ state: { ...state, votes: [...state.votes, seat] } }),
  pending: () => null,
  view: (state) => state,
  isFinished: (state) => state.votes.length >= 2,
  /** Every seat that has not voted, so two seats are waiting at the start. */
  waitingOn: (state) => state.seats.filter((seat) => !state.votes.includes(seat)),
  resolveAbsent: (state) => state,
  bots: {
    skills: ['only'],
    name: () => 'Jules',
    decide: (state, seat) =>
      state.votes.includes(seat) ? state : { ...state, votes: [...state.votes, seat] },
  },
  rematch: (prev) => ({ state: { ...prev, votes: [] } }),
}

registerAdapter(councilAdapter)

/** A started council game whose p1 has been turned into a bot seat. */
async function councilGame() {
  const guestId = crypto.randomUUID()
  const res = await SELF.fetch('https://api.test/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ game: COUNCIL_GAME, visibility: 'private', name: 'Ann', guestId, seats: 2 }),
  })
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
  await patchRecord(code, (record) => {
    record.seats.p1 = {
      player: { id: 'bot:p1', name: 'Jules', isGuest: true },
      wantsRematch: false,
      bot: { skill: 'only' },
    }
  })
  return { code, host }
}

describe('seats the room plays', () => {
  it("takes a bot seat's turn when the alarm comes round", async () => {
    const { code } = await botGame()
    // Hand the turn to the bot, then let the room notice it is waiting on one.
    await patchRecord(code, (record) => {
      const state = record.gameState as { currentPlayer: number; phase: string }
      state.currentPlayer = 1
      state.phase = 'ready'
      record.autoAt = Date.now()
    })
    await fire(code)
    const after = await readRecord(code)
    expect((after!.gameState as { phase: string }).phase).not.toBe('ready')
  })

  it('plays a waiting bot without waiting for the person it is also blocked on', async () => {
    const { code } = await councilGame()
    await fire(code)
    // p0 is a present human who has not voted and p1 is a bot; `waitingOn` names
    // both. The bot must move anyway — waiting for the person would deadlock the
    // table. No shipping adapter blocks on two seats today, so this stub is the
    // only thing holding that property; it is here so the rule cannot rot.
    const record = await readRecord(code)
    expect((record!.gameState as CouncilState).votes).toEqual(['p1'])
  })
})
