import { describe, expect, it } from 'vitest'
import type { RoomSnapshot } from '@games/shared/protocol'
import { initialRoomState, isFatal, roomReducer } from './roomState'

const snapshot: RoomSnapshot = {
  protocol: 1,
  code: 'KX3F9M',
  game: 'chess',
  visibility: 'private',
  status: 'open',
  hostId: 'guest:abc',
  seats: {},
  gameState: null,
}
const you = { id: 'guest:abc', seat: null }

describe('roomReducer', () => {
  it('stores snapshots and clears stale errors', () => {
    const errored = roomReducer(initialRoomState, {
      type: 'message',
      message: { type: 'error', code: 'ILLEGAL_MOVE', message: 'nope' },
    })
    expect(errored.error?.code).toBe('ILLEGAL_MOVE')
    const roomed = roomReducer(errored, { type: 'message', message: { type: 'room', snapshot, you } })
    expect(roomed.snapshot?.code).toBe('KX3F9M')
    expect(roomed.you).toEqual(you)
    expect(roomed.error).toBeNull()
    expect(roomed.phase).toBe('connected')
  })

  it('maps terminal errors and close codes to fatal phases', () => {
    expect(
      roomReducer(initialRoomState, {
        type: 'message',
        message: { type: 'error', code: 'ROOM_NOT_FOUND', message: 'gone' },
      }).phase,
    ).toBe('notfound')
    expect(roomReducer(initialRoomState, { type: 'close', code: 4403 }).phase).toBe('full')
    expect(roomReducer(initialRoomState, { type: 'close', code: 4408 }).phase).toBe('expired')
  })

  it('treats other closes as reconnecting and keeps the last snapshot', () => {
    const roomed = roomReducer(initialRoomState, { type: 'message', message: { type: 'room', snapshot, you } })
    const dropped = roomReducer(roomed, { type: 'close', code: 1006 })
    expect(dropped.phase).toBe('reconnecting')
    expect(dropped.snapshot?.code).toBe('KX3F9M')
  })

  it('flags fatal phases', () => {
    expect(isFatal('notfound')).toBe(true)
    expect(isFatal('expired')).toBe(true)
    expect(isFatal('full')).toBe(true)
    expect(isFatal('connected')).toBe(false)
    expect(isFatal('reconnecting')).toBe(false)
  })
})
