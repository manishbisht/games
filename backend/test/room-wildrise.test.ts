import { SELF, env, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import type { GameState } from '@games/shared/wildrise/types'
import type { Env } from '../src/env'
import type { RoomRecord } from '../src/room'
import { connect } from './helpers'

const testEnv = env as unknown as Env

const readRecord = (code: string) =>
  runInDurableObject(testEnv.ROOM.getByName(code), async (_instance, state) =>
    state.storage.get<RoomRecord>('room'),
  )

const patchRecord = (code: string, patch: (record: RoomRecord) => void) =>
  runInDurableObject(testEnv.ROOM.getByName(code), async (instance, state) => {
    const record = (await state.storage.get<RoomRecord>('room'))!
    patch(record)
    await state.storage.put('room', record)
    ;(instance as unknown as { cached: RoomRecord }).cached = record
  })

/** Bring the pending beat forward and run it, rather than waiting out real pacing. */
const fire = (code: string) =>
  runInDurableObject(testEnv.ROOM.getByName(code), async (instance, state) => {
    const record = await state.storage.get<RoomRecord>('room')
    if (record?.autoAt !== undefined && record.autoAt > Date.now()) {
      record.autoAt = Date.now()
      await state.storage.put('room', record)
      ;(instance as unknown as { cached: RoomRecord }).cached = record
    }
    await state.storage.deleteAlarm()
    await instance.alarm()
  })

const phaseOf = async (code: string) => ((await readRecord(code))!.gameState as GameState).phase

/** A started table, `seats` made and `players` of them sat down. */
async function table(seats = 2, players = seats) {
  const guestId = crypto.randomUUID()
  const res = await SELF.fetch('https://api.test/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ game: 'wildrise', visibility: 'private', name: 'Ann', guestId, seats }),
  })
  expect(res.status).toBe(201)
  const { code } = await res.json<{ code: string }>()
  const host = await connect(code)
  host.join('Ann', guestId)
  host.send({ type: 'sit', seat: 'p0' })
  const others = []
  for (let index = 1; index < players; index++) {
    const client = await connect(code)
    client.join(`Guest ${index}`)
    client.send({ type: 'sit', seat: `p${index}` })
    others.push(client)
  }
  await host.waitRoom((m) => Boolean(m.snapshot.seats[`p${players - 1}`]))
  host.send({ type: 'start' })
  await host.waitRoom((m) => m.snapshot.status === 'playing')
  return { code, host, others }
}

describe('a wildrise room', () => {
  it('throws the die itself, so one number lands for the whole table', async () => {
    const { code, host, others } = await table()
    const state = (await readRecord(code))!.gameState as GameState
    const onTurn = state.currentPlayer === 0 ? host : others[0]
    onTurn.send({ type: 'action', action: { kind: 'roll' } })
    await vi.waitFor(async () => expect(await phaseOf(code)).toBe('rolling'))
    // Nothing the client sent decided the value; the room did.
    await fire(code)
    const rolled = (await readRecord(code))!.gameState as GameState
    expect(rolled.dice).toBeGreaterThanOrEqual(1)
    expect(rolled.dice).toBeLessThanOrEqual(6)
    // Both seats are looking at the same number.
    const seen = await host.waitRoom((m) => (m.snapshot.gameState as GameState)?.dice === rolled.dice)
    expect((seen.snapshot.gameState as GameState).dice).toBe(rolled.dice)
  })

  it('refuses a roll from the seat whose turn it is not', async () => {
    const { code, host, others } = await table()
    const state = (await readRecord(code))!.gameState as GameState
    const offTurn = state.currentPlayer === 0 ? others[0] : host
    offTurn.send({ type: 'action', action: { kind: 'roll' } })
    await offTurn.expectError('NOT_YOUR_TURN')
  })

  it('refuses anything that is not the one move this game has', async () => {
    // Rolling is the whole vocabulary here, so the adapter's job is to turn
    // everything else away before it reaches the board.
    const { code, host, others } = await table()
    const state = (await readRecord(code))!.gameState as GameState
    const onTurn = state.currentPlayer === 0 ? host : others[0]
    for (const action of [{ kind: 'move' }, 'roll', null, 42, {}]) {
      onTurn.send({ type: 'action', action })
    }
    await onTurn.expectError('BAD_MESSAGE')
    // The board never moved: a refused action is not a turn.
    expect(await phaseOf(code)).toBe('ready')
  })

  it('ignores a die a client tried to bring with it', async () => {
    const { code, host, others } = await table()
    const state = (await readRecord(code))!.gameState as GameState
    const onTurn = state.currentPlayer === 0 ? host : others[0]
    // The extra field is dropped by validateAction rather than refused, so the
    // roll stands — but it is the room's die, not the one that was sent.
    onTurn.send({ type: 'action', action: { kind: 'roll', value: 6, dice: 6 } })
    await vi.waitFor(async () => expect(await phaseOf(code)).toBe('rolling'))
    await fire(code)
    const rolled = (await readRecord(code))!.gameState as GameState
    expect(rolled.dice).toBeGreaterThanOrEqual(1)
    expect(rolled.dice).toBeLessThanOrEqual(6)
  })

  it('walks the whole turn through its own beats and hands over', async () => {
    const { code, host, others } = await table()
    const before = (await readRecord(code))!.gameState as GameState
    const onTurn = before.currentPlayer === 0 ? host : others[0]
    onTurn.send({ type: 'action', action: { kind: 'roll' } })
    await vi.waitFor(async () => expect(await phaseOf(code)).toBe('rolling'))
    // Each beat arms the next, so the room settles back on `ready` by itself.
    for (let beat = 0; beat < 6 && (await phaseOf(code)) !== 'ready'; beat++) await fire(code)
    expect(await phaseOf(code)).toBe('ready')
    const after = (await readRecord(code))!.gameState as GameState
    expect(after.currentPlayer).not.toBe(before.currentPlayer)
  })

  it('seats a table made for four with only the two who turned up', async () => {
    const { code } = await table(4, 2)
    const record = await readRecord(code)
    expect(record!.seatIds).toEqual(['p0', 'p1'])
    expect((record!.gameState as GameState).players).toHaveLength(2)
  })

  it('plays on for a seat that walked out, since there is no resigning a race', async () => {
    const { code, host, others } = await table()
    const away = others[0]
    away.ws.close()
    await vi.waitFor(async () => {
      const record = await readRecord(code)
      expect(record!.seats.p1?.disconnectedAt).toBeDefined()
    })
    // Hand the absent seat the turn and let the room stand in for it.
    await patchRecord(code, (record) => {
      const state = record.gameState as GameState
      state.currentPlayer = 1
      state.phase = 'ready'
      record.seats.p1!.abandoned = true
      record.autoAt = Date.now()
    })
    await fire(code)
    expect(await phaseOf(code)).not.toBe('ready')
    void host
  })

  it('deals a fresh board on a rematch both seats ask for', async () => {
    const { code, host, others } = await table()
    await patchRecord(code, (record) => {
      record.status = 'finished'
      ;(record.gameState as GameState).phase = 'won'
    })
    host.send({ type: 'rematch' })
    others[0].send({ type: 'rematch' })
    await vi.waitFor(async () => {
      const record = await readRecord(code)
      expect(record!.status).toBe('playing')
      expect((record!.gameState as GameState).phase).toBe('ready')
    })
  })
})
