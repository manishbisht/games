import { env, runInDurableObject, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { legalMoves } from '@games/shared/chess'
import type { Env } from '../src/env'
import type { RoomRecord } from '../src/room'
import { connect, type Client } from './helpers'

const testEnv = env as unknown as Env

async function createTimedRoom(timeControl: string, extra: Record<string, unknown> = {}) {
  const guestId = crypto.randomUUID()
  const res = await SELF.fetch('https://api.test/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      game: 'chess',
      visibility: 'private',
      name: 'Ann',
      guestId,
      options: { timeControl },
      ...extra,
    }),
  })
  expect(res.status).toBe(201)
  const { code } = await res.json<{ code: string }>()
  return { code, guestId }
}

const latest = (client: Client) =>
  client.messages.filter((m) => m.type === 'room').at(-1)!.snapshot as Extract<
    Client['messages'][number],
    { type: 'room' }
  >['snapshot']

async function play(client: Client, from: string, to: string) {
  const before = latest(client).gameState?.history.length ?? 0
  client.send({ type: 'action', action: { kind: 'move', from, to } })
  return client.waitRoom((m) => (m.snapshot.gameState?.history.length ?? 0) > before)
}

async function startTimed(timeControl = '3+2') {
  const { code, guestId } = await createTimedRoom(timeControl)
  const host = await connect(code)
  host.join('Ann', guestId)
  host.send({ type: 'sit', seat: 'w' })
  const guest = await connect(code)
  guest.join('Ben')
  guest.send({ type: 'sit', seat: 'b' })
  await host.waitRoom((m) => Boolean(m.snapshot.seats.b))
  host.send({ type: 'start' })
  await host.waitRoom((m) => m.snapshot.status === 'playing')
  await guest.waitRoom((m) => m.snapshot.status === 'playing')
  return { code, host, guest }
}

const readRecord = (code: string) =>
  runInDurableObject(testEnv.ROOM.getByName(code), async (_instance, state) =>
    state.storage.get<RoomRecord>('room'),
  )

/**
 * Wind the clock of the side to move down to `leftMs` and fire the room's
 * timer: the same as waiting that long, without a test that takes minutes.
 * The timer is made due now whatever is left, so a clock with time on it
 * stands in for a deadline that went off early.
 */
const runDown = (code: string, leftMs = 0) =>
  runInDurableObject(testEnv.ROOM.getByName(code), async (instance, state) => {
    const record = (await state.storage.get<RoomRecord>('room'))!
    const game = record.gameState as { clocks: Record<string, number>; clockAt: number; turn: string }
    game.clockAt = Date.now() - (game.clocks[game.turn] - leftMs)
    record.autoAt = Date.now()
    await state.storage.put('room', record)
    ;(instance as unknown as { cached: RoomRecord }).cached = record
    await state.storage.deleteAlarm()
    await instance.alarm()
  })

describe('chess clocks in a room', () => {
  it('deals a timed game, and leaves an untimed one untimed', async () => {
    const { host } = await startTimed('5+0')
    const state = latest(host).gameState!
    expect(state.options).toMatchObject({ clock: 5, increment: 0 })
    expect(state.clocks).toEqual({ w: 300_000, b: 300_000 })
    // Neither clock runs until both sides have moved, so nothing is due yet.
    expect(latest(host).timing?.due).toBeUndefined()

    const { code } = await createTimedRoom('99+99')
    const record = await readRecord(code)
    expect(record?.options).toEqual({})
  })

  it('holds the flag at the moment the clock would run out, and adds increments', async () => {
    const { host, guest } = await startTimed('3+2')
    await play(host, 'e2', 'e4')
    const opened = await play(guest, 'e7', 'e5')
    const both = opened.snapshot.gameState!
    expect(both.clocks).toEqual({ w: 182_000, b: 182_000 })
    // The room's own deadline is White's whole clock from the moment Black moved.
    const due = opened.snapshot.timing!.due!
    expect(Math.abs(due - (both.clockAt + both.clocks.w))).toBeLessThan(25)

    const moved = (await play(host, 'g1', 'f3')).snapshot.gameState!
    const spent = moved.clockAt - both.clockAt
    expect(moved.clocks.w).toBe(182_000 - spent + 2_000)
    expect(moved.clocks.b).toBe(182_000)
  })

  it('flags the side whose time runs out, and the game ends on time', async () => {
    const { code, host, guest } = await startTimed('3+2')
    await play(host, 'e2', 'e4')
    await play(guest, 'e7', 'e5')
    await runDown(code)
    const done = await host.waitRoom((m) => m.snapshot.status === 'finished')
    expect(done.snapshot.gameState?.status).toBe('timeout')
    expect(done.snapshot.gameState?.winner).toBe('b')
    expect(done.snapshot.gameState?.clocks.w).toBe(0)
    await guest.waitRoom((m) => m.snapshot.gameState?.status === 'timeout')
    host.send({ type: 'action', action: { kind: 'move', from: 'g1', to: 'f3' } })
    await host.expectError('NOT_PLAYING')
  })

  it('re-arms for the time that is left when its timer wakes early', async () => {
    const { code, host, guest } = await startTimed('3+2')
    await play(host, 'e2', 'e4')
    await play(guest, 'e7', 'e5')
    const mark = host.mark()
    await runDown(code, 60_000)
    const still = await host.waitRoom((m) => m.snapshot.status === 'playing', mark)
    const left = still.snapshot.gameState!.clocks.w
    expect(left).toBeGreaterThan(59_000)
    expect(left).toBeLessThanOrEqual(60_000)
    expect(Math.abs(still.snapshot.timing!.due! - (still.snapshot.gameState!.clockAt + left))).toBeLessThan(
      25,
    )
  })

  it('plays a bot’s turns on a timed board instead of letting it lose on time', async () => {
    const { code, guestId } = await createTimedRoom('3+2', { bots: ['easy'], autoStart: true })
    const host = await connect(code)
    host.join('Ann', guestId)
    await host.waitRoom((m) => m.snapshot.status === 'playing')
    for (let turn = 0; turn < 3; turn++) {
      const state = latest(host).gameState!,
        before = state.history.length
      // Whatever is legal: the bot's replies are its own, so the position is not known ahead.
      const { from, to } = legalMoves(state).find((m) => !m.promotion)!
      host.send({ type: 'action', action: { kind: 'move', from, to } })
      // The bot answers on its own; the table comes back to White.
      const back = await host.waitRoom((m) => (m.snapshot.gameState?.history.length ?? 0) === before + 2)
      expect(back.snapshot.gameState?.status).toBe('playing')
      expect(back.snapshot.gameState?.turn).toBe('w')
      expect(back.snapshot.gameState?.bots).toEqual(['b'])
    }
    const state = latest(host).gameState!
    // Charged for its thinking, paid its increments: the bot's clock has grown.
    expect(state.clocks.b).toBeGreaterThan(180_000)
    expect(latest(host).timing?.due).toBeDefined()
  })
})
