import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/env'
import { connect, createRoom } from './helpers'

const testEnv = env as unknown as Env

describe('room expiry', () => {
  it('schedules an expiry alarm on creation and activity', async () => {
    const { code } = await createRoom()
    const stub = testEnv.ROOM.getByName(code)
    await runInDurableObject(stub, async (_instance, state) => {
      const alarm = await state.storage.getAlarm()
      expect(alarm).not.toBeNull()
      expect(alarm!).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000)
    })
  })

  it('expires the room: closes sockets with 4408 and forgets everything', async () => {
    const { code, guestId } = await createRoom()
    const client = await connect(code)
    client.join('Ann', guestId)
    await client.waitRoom(() => true)

    const ran = await runDurableObjectAlarm(testEnv.ROOM.getByName(code))
    expect(ran).toBe(true)
    await vi.waitFor(() => expect(client.closes[0]?.code).toBe(4408))

    const back = await connect(code)
    await back.expectError('ROOM_NOT_FOUND')
    await vi.waitFor(() => expect(back.closes[0]?.code).toBe(4404))
  })
})
