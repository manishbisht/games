import { env, runInDurableObject, SELF } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import { registerAdapter } from '@games/shared/online'
import type { GameAdapter } from '@games/shared/online/adapter'
import { CLAIM_WIN_AFTER_MS } from '@games/shared/protocol'
import type { GameId } from '@games/shared/protocol'
import type { Env } from '../src/env'
import type { RoomRecord } from '../src/room'
import { connect } from './helpers'

const testEnv = env as unknown as Env
/** Mirrors `BOT_THINK_MS` in src/room.ts. */
const BOT_THINK_MS = 900
/** Mirrors `STAND_IN_DELAY_MS` in src/room.ts. */
const STAND_IN_DELAY_MS = 1200

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

  it("arms the bot's own think pause, not the stand-in delay, when stampAuto lands on a bot naturally", async () => {
    const { code, host } = await councilGame()
    // p0 votes: `handleAction` runs `setGameState`, which re-stamps `autoAt` on
    // its own — p1 is the only seat left waiting, and it is a bot, so `stampAuto`
    // must land on the bot's own pause rather than the stand-in delay. Nothing
    // here touches `autoAt` directly, unlike every other test in this file.
    host.send({ type: 'action', action: 'vote' })
    await host.waitRoom((m) => (m.snapshot.gameState as unknown as CouncilState).votes.includes('p0'))
    const record = await readRecord(code)
    const delay = record!.autoAt! - Date.now()
    // Comfortably inside the bot's own pause, never past it — collapsing
    // `BOT_THINK_MS` into `STAND_IN_DELAY_MS` (900 -> 1200) would blow this bound.
    expect(delay).toBeGreaterThan(0)
    expect(delay).toBeLessThanOrEqual(BOT_THINK_MS)
    expect(delay).toBeLessThan(STAND_IN_DELAY_MS)
  })

  it('surfaces a bot seat in the broadcast snapshot as connected, with its skill, and no awaySince', async () => {
    const { code, host } = await botGame()
    // botGame() patches p1 into a bot after the last broadcast, so nothing has
    // shown it yet. Force a fresh one the same way the first test forces the
    // bot's turn, and read the snapshot it sends rather than raw storage.
    await patchRecord(code, (record) => {
      const state = record.gameState as { currentPlayer: number; phase: string }
      state.currentPlayer = 1
      state.phase = 'ready'
    })
    await fire(code)
    const after = await host.waitRoom((m) => Boolean(m.snapshot.seats.p1?.bot))
    expect(after.snapshot.seats.p1?.connected).toBe(true)
    expect(after.snapshot.seats.p1?.awaySince).toBeUndefined()
    expect(after.snapshot.seats.p1?.bot).toEqual({ skill: 'casual' })
  })
})

describe('a bot is not an absent human', () => {
  it('never marks a bot seat as away when someone else leaves', async () => {
    const { code, host } = await botGame()
    host.ws.close()
    // Wait for the departure to actually land rather than racing it on a timer.
    await vi.waitFor(async () => {
      const record = await readRecord(code)
      expect(record!.seats.p0?.disconnectedAt).toBeDefined()
    })
    const record = await readRecord(code)
    expect(record!.seats.p1?.disconnectedAt).toBeUndefined()
  })

  it('leaves a table of one person and one bot with nobody to claim against', async () => {
    const { host } = await botGame()
    host.send({ type: 'claim' })
    await host.expectError('CLAIM_REJECTED')
    // The message is the discriminating part. With the guard the bot is not an
    // opponent at all, so the claim has no target; without it the bot IS a
    // target and the refusal would be "still here" instead. Both refuse, so a
    // bare CLAIM_REJECTED assertion would pass either way.
    const error = host.messages.findLast((m) => m.type === 'error')
    expect(error).toMatchObject({ message: 'There is no opponent to claim against.' })
  })

  it('grants a claim against an absent person while a bot sits at the same table', async () => {
    // The defect this pins: `targets` falls back to `others` when the game is
    // waiting on the claimant, so an unguarded bot lands in the target list,
    // trips `!stored.disconnectedAt` — a bot never has one — and rejects the
    // whole claim. The absent player would then hold the table forever.
    const guestId = crypto.randomUUID()
    const res = await SELF.fetch('https://api.test/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ game: 'wildrise', visibility: 'private', name: 'Ann', guestId, seats: 3 }),
    })
    const { code } = await res.json<{ code: string }>()
    const host = await connect(code)
    host.join('Ann', guestId)
    host.send({ type: 'sit', seat: 'p0' })
    const away = await connect(code)
    away.join('Ben')
    away.send({ type: 'sit', seat: 'p1' })
    const third = await connect(code)
    third.join('Cara')
    third.send({ type: 'sit', seat: 'p2' })
    await host.waitRoom((m) => Boolean(m.snapshot.seats.p2))
    host.send({ type: 'start' })
    await host.waitRoom((m) => m.snapshot.status === 'playing')

    away.ws.close()
    await vi.waitFor(async () => {
      const record = await readRecord(code)
      expect(record!.seats.p1?.disconnectedAt).toBeDefined()
    })
    await patchRecord(code, (record) => {
      // Long enough ago to be claimable, and the turn is the claimant's own —
      // which is what makes `waitingOn` name nobody else and forces the
      // fallback to `others`.
      record.seats.p1!.disconnectedAt = Date.now() - CLAIM_WIN_AFTER_MS - 60_000
      record.seats.p2 = {
        player: { id: 'bot:p2', name: 'Cleo', isGuest: true },
        wantsRematch: false,
        bot: { skill: 'casual' },
      }
      const state = record.gameState as { currentPlayer: number; phase: string }
      state.currentPlayer = 0
      state.phase = 'ready'
    })

    host.send({ type: 'claim' })
    await vi.waitFor(async () => {
      const record = await readRecord(code)
      expect(record!.seats.p1?.abandoned).toBe(true)
    })
    const record = await readRecord(code)
    // The bot was never a target, so it is untouched by the claim.
    expect(record!.seats.p2?.abandoned).toBeUndefined()
  })

  it('does not wait on a bot to agree to a rematch', async () => {
    const { code, host } = await botGame()
    await patchRecord(code, (record) => {
      record.status = 'finished'
      ;(record.gameState as { phase: string }).phase = 'won'
    })
    host.send({ type: 'rematch' })
    // The only voting seat is the human, so agreeing alone starts the next
    // game. Poll storage rather than `waitRoom`: the host's message history
    // already contains an earlier 'playing' snapshot from the original
    // `start`, so `findLast` on `status === 'playing'` would match that stale
    // message immediately and never actually observe this rematch land.
    await vi.waitFor(async () => {
      const record = await readRecord(code)
      expect(record!.status).toBe('playing')
    })
    const record = await readRecord(code)
    expect(record!.seats.p1?.bot).toEqual({ skill: 'casual' })
  })

  it('refuses to seat a person on a bot seat', async () => {
    // A four-seat room, so there is somewhere for a latecomer to connect at all.
    const guestId = crypto.randomUUID()
    const res = await SELF.fetch('https://api.test/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ game: 'wildrise', visibility: 'private', name: 'Ann', guestId, seats: 4 }),
    })
    const { code } = await res.json<{ code: string }>()
    const host = await connect(code)
    host.join('Ann', guestId)
    host.send({ type: 'sit', seat: 'p0' })
    await host.waitRoom((m) => m.you.seat === 'p0')
    await patchRecord(code, (record) => {
      record.seats.p1 = {
        player: { id: 'bot:p1', name: 'Jules', isGuest: true },
        wantsRematch: false,
        bot: { skill: 'casual' },
      }
    })
    const late = await connect(code)
    late.join('Cara')
    late.send({ type: 'sit', seat: 'p1' })
    await late.expectError('SEAT_TAKEN')
  })
})

describe('adding and removing bots', () => {
  /** An open four-seat Wildrise room with only its host seated. */
  async function openRoom(game = 'wildrise', seats = 4, hostSeat = 'p0') {
    const guestId = crypto.randomUUID()
    const res = await SELF.fetch('https://api.test/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ game, visibility: 'private', name: 'Ann', guestId, seats }),
    })
    const { code } = await res.json<{ code: string }>()
    const host = await connect(code)
    host.join('Ann', guestId)
    host.send({ type: 'sit', seat: hostSeat })
    await host.waitRoom((m) => m.you.seat === hostSeat)
    return { code, host }
  }

  it('seats a bot on an empty seat and names it', async () => {
    const { host } = await openRoom()
    host.send({ type: 'addBot', seat: 'p1', skill: 'fast' })
    const seen = await host.waitRoom((m) => Boolean(m.snapshot.seats.p1))
    expect(seen.snapshot.seats.p1?.bot).toEqual({ skill: 'fast' })
    expect(seen.snapshot.seats.p1?.player.name).toBe('Jules')
    // It reads as a player at the table, not as someone who walked out.
    expect(seen.snapshot.seats.p1?.connected).toBe(true)
  })

  it('gives each bot at the table its own name', async () => {
    const { host } = await openRoom()
    host.send({ type: 'addBot', seat: 'p1' })
    await host.waitRoom((m) => Boolean(m.snapshot.seats.p1))
    host.send({ type: 'addBot', seat: 'p2' })
    const seen = await host.waitRoom((m) => Boolean(m.snapshot.seats.p2))
    expect(seen.snapshot.seats.p2?.player.name).not.toBe(seen.snapshot.seats.p1?.player.name)
  })

  it('does not reuse a name after a bot is removed and another added', async () => {
    // Naming by "how many bots are seated" collides here: Jules and Cleo sit
    // down, Jules leaves, and the next bot is index 1 — Cleo again.
    const { host } = await openRoom()
    host.send({ type: 'addBot', seat: 'p1' })
    await host.waitRoom((m) => Boolean(m.snapshot.seats.p1))
    host.send({ type: 'addBot', seat: 'p2' })
    await host.waitRoom((m) => Boolean(m.snapshot.seats.p2))
    host.send({ type: 'removeBot', seat: 'p1' })
    await host.waitRoom((m) => !m.snapshot.seats.p1)
    host.send({ type: 'addBot', seat: 'p3' })
    const seen = await host.waitRoom((m) => Boolean(m.snapshot.seats.p3))
    expect(seen.snapshot.seats.p3?.player.name).not.toBe(seen.snapshot.seats.p2?.player.name)
  })

  it('defaults to the first skill the game offers', async () => {
    const { host } = await openRoom()
    host.send({ type: 'addBot', seat: 'p1' })
    const seen = await host.waitRoom((m) => Boolean(m.snapshot.seats.p1))
    expect(seen.snapshot.seats.p1?.bot).toEqual({ skill: 'casual' })
  })

  it('refuses an unknown skill', async () => {
    const { host } = await openRoom()
    host.send({ type: 'addBot', seat: 'p1', skill: 'grandmaster' })
    await host.expectError('BAD_MESSAGE')
  })

  it('refuses a seat someone is already in, and an unknown seat', async () => {
    const { host } = await openRoom()
    host.send({ type: 'addBot', seat: 'p0' })
    await host.expectError('SEAT_TAKEN')
    host.send({ type: 'addBot', seat: 'p9' })
    await host.expectError('BAD_MESSAGE')
  })

  it('refuses a game that has no bots', async () => {
    // Chess keeps `bots: null` until its search moves to the server.
    const { host } = await openRoom('chess', 2, 'w')
    host.send({ type: 'addBot', seat: 'b' })
    await host.expectError('NOT_ALLOWED')
  })

  it('lets only the host add a bot', async () => {
    const { code } = await openRoom()
    const guest = await connect(code)
    guest.join('Ben')
    guest.send({ type: 'addBot', seat: 'p1' })
    await guest.expectError('NOT_HOST')
  })

  it('refuses once the game has started', async () => {
    const { host } = await openRoom()
    host.send({ type: 'addBot', seat: 'p1' })
    await host.waitRoom((m) => Boolean(m.snapshot.seats.p1))
    host.send({ type: 'start' })
    await host.waitRoom((m) => m.snapshot.status === 'playing')
    host.send({ type: 'addBot', seat: 'p2' })
    await host.expectError('ALREADY_STARTED')
  })

  it('removes a bot and frees its seat', async () => {
    const { host } = await openRoom()
    host.send({ type: 'addBot', seat: 'p1' })
    await host.waitRoom((m) => Boolean(m.snapshot.seats.p1))
    host.send({ type: 'removeBot', seat: 'p1' })
    await host.waitRoom((m) => !m.snapshot.seats.p1)
  })

  it('will not remove a person with removeBot', async () => {
    const { host } = await openRoom()
    host.send({ type: 'removeBot', seat: 'p0' })
    await host.expectError('NOT_ALLOWED')
  })

  it('starts a table the host filled with bots, and plays them', async () => {
    const { code, host } = await openRoom()
    for (const seat of ['p1', 'p2', 'p3']) {
      host.send({ type: 'addBot', seat })
      await host.waitRoom((m) => Boolean(m.snapshot.seats[seat]))
    }
    host.send({ type: 'start' })
    await host.waitRoom((m) => m.snapshot.status === 'playing')
    // Hand the turn to a bot and let the room notice it is waiting on one.
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

  it('turns a latecomer away once bots have filled the table, until one is removed', async () => {
    // The intended behaviour: a bot occupies a seat for every purpose,
    // fullness included, and `removeBot` is the way back.
    const { code, host } = await openRoom()
    for (const seat of ['p1', 'p2', 'p3']) {
      host.send({ type: 'addBot', seat })
      await host.waitRoom((m) => Boolean(m.snapshot.seats[seat]))
    }
    const late = await connect(code)
    late.join('Cara')
    await late.expectError('ROOM_FULL')

    host.send({ type: 'removeBot', seat: 'p3' })
    await host.waitRoom((m) => !m.snapshot.seats.p3)
    const second = await connect(code)
    second.join('Dana')
    second.send({ type: 'sit', seat: 'p3' })
    await second.waitRoom((m) => m.you.seat === 'p3')
  })
})
