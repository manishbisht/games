import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '@games/shared/protocol'
import type { RoomSnapshot } from '@games/shared/protocol'
import { initialRoomState, isFatal, presenceEvents, roomReducer } from './roomState'

const snapshot: RoomSnapshot = {
  protocol: PROTOCOL_VERSION,
  code: 'KX3F9M',
  game: 'chess',
  visibility: 'private',
  status: 'open',
  seatIds: ['w', 'b'],
  seats: {},
  gameState: null,
}
const you = { id: 'guest:abc', seat: null, isHost: true }

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
    const roomed = roomReducer(initialRoomState, {
      type: 'message',
      message: { type: 'room', snapshot, you },
    })
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

describe('presenceEvents', () => {
  const seated = (connected: boolean, name = 'Ben'): RoomSnapshot => ({
    ...snapshot,
    seats: { b: { player: { name, isGuest: true }, connected, wantsRematch: false } },
  })

  it('emits disconnect and reconnect transitions', () => {
    expect(presenceEvents(seated(true), seated(false))).toEqual([
      { seat: 'b', name: 'Ben', connected: false },
    ])
    expect(presenceEvents(seated(false), seated(true))).toEqual([{ seat: 'b', name: 'Ben', connected: true }])
  })

  it('is quiet without a transition, a previous snapshot, or a still-seated player', () => {
    expect(presenceEvents(null, seated(true))).toEqual([])
    expect(presenceEvents(seated(true), seated(true))).toEqual([])
    expect(presenceEvents(seated(true), { ...snapshot, seats: {} })).toEqual([])
  })

  it('ignores a seat that changed occupants', () => {
    expect(presenceEvents(seated(true, 'Ben'), seated(false, 'Eve'))).toEqual([])
  })

  it('walks whatever seats the room says it has', () => {
    const table = (connected: boolean): RoomSnapshot => ({
      ...snapshot,
      seatIds: ['p0', 'p1', 'p2'],
      seats: {
        p0: { player: { name: 'Ann', isGuest: true }, connected: true, wantsRematch: false },
        p2: { player: { name: 'Cat', isGuest: true }, connected, wantsRematch: false },
      },
    })
    expect(presenceEvents(table(true), table(false))).toEqual([{ seat: 'p2', name: 'Cat', connected: false }])
  })
})
