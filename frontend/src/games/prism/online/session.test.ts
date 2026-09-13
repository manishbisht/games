import { describe, expect, it, vi } from 'vitest'
import { createGame } from '@games/shared/prism'
import type { RoomSnapshot, SeatInfo, YouInfo } from '@games/shared/protocol'
import type { RoomApi } from '../../../online/useRoom'
import { claimTarget, prismSession, wireAction } from './session'

const api = (): RoomApi => ({
  sit: vi.fn(),
  leaveSeat: vi.fn(),
  start: vi.fn(),
  action: vi.fn(),
  rematch: vi.fn(),
  claim: vi.fn(),
  dismissError: vi.fn(),
})

const seat = (name: string, over: Partial<SeatInfo> = {}): SeatInfo => ({
  player: { name, isGuest: true },
  connected: true,
  wantsRematch: false,
  ...over,
})

const dealt = (names: string[]) => createGame(names.map((name) => ({ name, kind: 'human' as const })))

/** A three-seat table mid-round, with whatever the test wants true of its seats. */
function room(seats: Partial<Record<string, SeatInfo>>, you: Partial<YouInfo> = {}) {
  const snapshot: RoomSnapshot = {
    protocol: 2,
    code: 'ABC234',
    game: 'prism',
    visibility: 'private',
    status: 'playing',
    seatIds: ['p0', 'p1', 'p2'],
    seats,
    gameState: dealt(['Ann', 'Ben', 'Cai']),
  }
  const info: YouInfo = { id: 'ann', seat: 'p0', isHost: true, ...you }
  return prismSession(snapshot, info, api(), () => {})
}

const seated = { p0: seat('Ann'), p1: seat('Ben'), p2: seat('Cai') }

describe('wireAction', () => {
  it('takes the player off every command — who acted is the socket’s to say', () => {
    expect(wireAction({ type: 'play', player: 2, cardId: 'prism-4' })).toEqual({
      kind: 'play',
      cardId: 'prism-4',
    })
    expect(wireAction({ type: 'play', player: 0, cardId: 'prism-4', color: 'green' })).toEqual({
      kind: 'play',
      cardId: 'prism-4',
      color: 'green',
    })
    expect(wireAction({ type: 'draw', player: 1 })).toEqual({ kind: 'draw' })
    expect(wireAction({ type: 'pass', player: 1 })).toEqual({ kind: 'pass' })
    expect(wireAction({ type: 'call', player: 1 })).toEqual({ kind: 'call' })
    expect(wireAction({ type: 'catch', player: 1, target: 2 })).toEqual({ kind: 'catch', target: 2 })
  })
})

describe('prismSession', () => {
  it('lines the room’s seats up with the engine’s players, in order', () => {
    const session = room(seated)
    expect(session.viewer).toBe(0)
    expect(session.players.map((p) => p?.name)).toEqual(['Ann', 'Ben', 'Cai'])
    expect(session.state.players.map((p) => p.name)).toEqual(['Ann', 'Ben', 'Cai'])
  })

  it('has no seat of its own for somebody watching', () => {
    expect(room(seated, { id: 'eve', seat: null }).viewer).toBeNull()
  })

  it('carries a seat’s presence and abandonment through to the table', () => {
    const session = room({
      ...seated,
      p1: seat('Ben', { connected: false, awaySince: 1_700_000_000_000, abandoned: true }),
    })
    expect(session.players[1]).toEqual({
      name: 'Ben',
      connected: false,
      awaySince: 1_700_000_000_000,
      abandoned: true,
    })
    expect(session.players[0]?.abandoned).toBeUndefined()
  })

  it('counts another round as everyone else having asked', () => {
    expect(room(seated).rematch).toEqual({ mine: false, theirs: false })
    const asked = room({
      p0: seat('Ann', { wantsRematch: true }),
      p1: seat('Ben', { wantsRematch: true }),
      p2: seat('Cai'),
    })
    // Cai has not asked, so the table has not agreed.
    expect(asked.rematch).toEqual({ mine: true, theirs: false })
    const all = room({
      p0: seat('Ann'),
      p1: seat('Ben', { wantsRematch: true }),
      p2: seat('Cai', { wantsRematch: true }),
    })
    expect(all.rematch).toEqual({ mine: false, theirs: true })
  })

  it('sends a command to the room rather than playing it here', () => {
    const snapshot: RoomSnapshot = {
      protocol: 2,
      code: 'ABC234',
      game: 'prism',
      visibility: 'private',
      status: 'playing',
      seatIds: ['p0', 'p1'],
      seats: { p0: seat('Ann'), p1: seat('Ben') },
      gameState: dealt(['Ann', 'Ben']),
    }
    const wire = api()
    const session = prismSession(snapshot, { id: 'ann', seat: 'p0', isHost: true }, wire, () => {})
    session.send.command({ type: 'play', player: 0, cardId: 'prism-12' })
    session.send.command({ type: 'catch', player: 0, target: 1 })
    expect(wire.action).toHaveBeenNthCalledWith(1, { kind: 'play', cardId: 'prism-12' })
    expect(wire.action).toHaveBeenNthCalledWith(2, { kind: 'catch', target: 1 })
  })
})

describe('claimTarget', () => {
  /** Seat one opens the round, so Ann is the one the table can get stuck on. */
  const onTurnAway = { ...seated, p0: seat('Ann', { connected: false, awaySince: 1 }) }

  it('names the away player the table is stuck on', () => {
    expect(claimTarget(room(onTurnAway, { id: 'ben', seat: 'p1' }))?.name).toBe('Ann')
  })

  it('offers nobody to a watcher, who has no seat to claim with', () => {
    expect(claimTarget(room(onTurnAway, { id: 'eve', seat: null }))).toBeNull()
  })

  it('offers nobody once the claim has already been granted', () => {
    const session = room(
      { ...seated, p0: seat('Ann', { connected: false, awaySince: 1, abandoned: true }) },
      { id: 'ben', seat: 'p1' },
    )
    // The room is playing Ann's seat now; asking again would settle nothing.
    expect(claimTarget(session)).toBeNull()
  })

  it('offers nobody while the player on turn is still here, or when it is your own turn', () => {
    expect(claimTarget(room(seated, { id: 'ben', seat: 'p1' }))).toBeNull()
    // Ann is away, but it is Ann's own browser asking — she is not stuck on herself.
    expect(claimTarget(room(onTurnAway))).toBeNull()
  })

  it('offers nobody once the round is over', () => {
    const session = room(onTurnAway, { id: 'ben', seat: 'p1' })
    const won = { ...session, state: { ...session.state, status: 'won' as const, winner: 0 } }
    expect(claimTarget(won)).toBeNull()
  })
})
