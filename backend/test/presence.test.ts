import { SELF, env, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import { CLAIM_WIN_AFTER_MS } from '@games/shared/protocol'
import type { Env } from '../src/env'
import type { RoomDO, RoomRecord } from '../src/room'
import { connect, createRoom } from './helpers'

const testEnv = env as unknown as Env

async function seatedPair() {
  const { code, guestId } = await createRoom()
  const host = await connect(code)
  host.join('Ann', guestId)
  host.send({ type: 'sit', seat: 'w' })
  const guest = await connect(code)
  const benId = guest.join('Ben')
  guest.send({ type: 'sit', seat: 'b' })
  await host.waitRoom((m) => Boolean(m.snapshot.seats.b))
  return { code, host, guest, guestId, benId }
}

async function startedGame() {
  const pair = await seatedPair()
  pair.host.send({ type: 'start' })
  await pair.host.waitRoom((m) => m.snapshot.status === 'playing')
  await pair.guest.waitRoom((m) => m.snapshot.status === 'playing')
  return pair
}

/** Rewind a seat's disconnect timestamp so a claim window has already elapsed. */
async function backdateDisconnect(code: string, seat: 'w' | 'b', ms: number) {
  const stub = testEnv.ROOM.getByName(code)
  await runInDurableObject(stub, async (instance: RoomDO, state) => {
    const record = (await state.storage.get<RoomRecord>('room'))!
    record.seats[seat]!.disconnectedAt = Date.now() - ms
    await state.storage.put('room', record)
    // Keep the in-memory cache coherent with storage (same-object contract).
    ;(instance as unknown as { cached: RoomRecord }).cached = record
  })
}

describe('heartbeat', () => {
  it('answers ping with pong without treating it as a protocol message', async () => {
    const { code } = await createRoom()
    const res = await SELF.fetch(`https://api.test/api/rooms/${code}`, {
      headers: { Upgrade: 'websocket' },
    })
    const ws = res.webSocket!
    ws.accept()
    const frames: string[] = []
    ws.addEventListener('message', (event) => {
      frames.push(event.data as string)
    })
    ws.send('ping')
    await vi.waitFor(() => {
      expect(frames).toContain('pong')
    })
    expect(frames.some((frame) => frame.includes('BAD_MESSAGE'))).toBe(false)
  })
})

describe('leaving a seat', () => {
  it('frees the seat pre-game so someone else can take it', async () => {
    const { host, guest } = await seatedPair()
    guest.send({ type: 'leaveSeat' })
    const freed = await host.waitRoom((m) => !m.snapshot.seats.b)
    expect(freed.snapshot.seats.w?.player.name).toBe('Ann')
    await guest.waitRoom((m) => m.you.seat === null)

    const third = await connect(freed.snapshot.code)
    third.join('Eve')
    third.send({ type: 'sit', seat: 'b' })
    const taken = await third.waitRoom((m) => m.you.seat === 'b')
    expect(taken.snapshot.seats.b?.player.name).toBe('Eve')
  })

  it('rejects leaving once the game has started, and when not seated', async () => {
    const { host } = await startedGame()
    host.send({ type: 'leaveSeat' })
    await host.expectError('ALREADY_STARTED')

    // NOT_SEATED needs a joined-but-unseated player, which requires a free seat.
    const { code } = await createRoom()
    const lurker = await connect(code)
    lurker.join('Eve')
    await lurker.waitRoom(() => true)
    lurker.send({ type: 'leaveSeat' })
    await lurker.expectError('NOT_SEATED')
  })
})

describe('away tracking', () => {
  it('stamps awaySince when a seat-holder drops and clears it on reconnect', async () => {
    const { host, guest, benId, code } = await seatedPair()
    guest.ws.close()
    const away = await host.waitRoom((m) => m.snapshot.seats.b?.connected === false)
    expect(away.snapshot.seats.b?.awaySince).toBeTypeOf('number')

    const back = await connect(code)
    back.join('Ben', benId)
    const returned = await host.waitRoom((m) => m.snapshot.seats.b?.connected === true)
    expect(returned.snapshot.seats.b?.awaySince).toBeUndefined()
  })
})

describe('claiming the win', () => {
  it('rejects a claim while the opponent is connected or freshly away', async () => {
    const { host, guest } = await startedGame()
    host.send({ type: 'claimWin' })
    await host.expectError('CLAIM_REJECTED')

    guest.ws.close()
    await host.waitRoom((m) => m.snapshot.seats.b?.connected === false)
    host.send({ type: 'claimWin' })
    await vi.waitFor(() => {
      const rejections = host.messages.filter((m) => m.type === 'error' && m.code === 'CLAIM_REJECTED')
      expect(rejections.length).toBe(2)
    })
  })

  it('rejects claims outside a live game and from unseated visitors', async () => {
    const { host } = await seatedPair()
    host.send({ type: 'claimWin' })
    await host.expectError('NOT_PLAYING')

    // NOT_SEATED needs a joined-but-unseated player, which requires a free seat.
    const { code } = await createRoom()
    const lurker = await connect(code)
    lurker.join('Eve')
    await lurker.waitRoom(() => true)
    lurker.send({ type: 'claimWin' })
    await lurker.expectError('NOT_SEATED')
  })

  it('awards the game once the opponent has been gone past the threshold', async () => {
    const { host, guest, code } = await startedGame()
    guest.ws.close()
    await host.waitRoom((m) => m.snapshot.seats.b?.connected === false)
    await backdateDisconnect(code, 'b', CLAIM_WIN_AFTER_MS + 1000)

    host.send({ type: 'claimWin' })
    const won = await host.waitRoom((m) => m.snapshot.status === 'finished')
    expect(won.snapshot.gameState?.status).toBe('resigned')
    expect(won.snapshot.gameState?.winner).toBe('w')
  })
})
