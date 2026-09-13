import { describe, expect, it, vi } from 'vitest'
import { createGame } from '@games/shared/wildrise'
import type { RoomSnapshot, SeatInfo, YouInfo } from '@games/shared/protocol'
import type { RoomApi } from '../../../online/useRoom'
import { claimTarget, wildriseSession } from './session'

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

/** A three-seat table mid-game, with whatever the test wants true of its seats. */
function table(seats: Partial<Record<string, SeatInfo>>, you: Partial<YouInfo> = {}) {
  const snapshot: RoomSnapshot = {
    protocol: 2,
    code: 'ABC234',
    game: 'wildrise',
    visibility: 'private',
    status: 'playing',
    seatIds: ['p0', 'p1', 'p2'],
    seats,
    gameState: createGame({ playerCount: 3, names: ['Ann', 'Ben', 'Cai'] }),
  }
  const info: YouInfo = { id: 'ann', seat: 'p0', isHost: true, ...you }
  return wildriseSession(snapshot, info, api(), () => {})
}

const seated = { p0: seat('Ann'), p1: seat('Ben'), p2: seat('Cai') }

describe('wildriseSession', () => {
  it('maps seats onto the colours they were dealt, in seat order', () => {
    const session = table(seated)
    expect(session.mySeat).toBe('red')
    expect(session.players.red?.name).toBe('Ann')
    expect(session.players.blue?.name).toBe('Ben')
    expect(session.players.green?.name).toBe('Cai')
    expect(session.players.yellow).toBeUndefined()
  })

  it('gives a spectator no colour of their own', () => {
    expect(table(seated, { id: 'eve', seat: null }).mySeat).toBeNull()
  })

  it('carries a seat’s presence and abandonment through to the table', () => {
    const session = table({
      ...seated,
      p1: seat('Ben', { connected: false, awaySince: 1_700_000_000_000, abandoned: true }),
    })
    expect(session.players.blue).toEqual({
      name: 'Ben',
      connected: false,
      awaySince: 1_700_000_000_000,
      abandoned: true,
    })
    expect(session.players.red?.abandoned).toBeUndefined()
  })

  it('counts a rematch as everyone else having asked', () => {
    expect(table(seated).rematch).toEqual({ mine: false, theirs: false })
    const asked = table({
      p0: seat('Ann', { wantsRematch: true }),
      p1: seat('Ben', { wantsRematch: true }),
      p2: seat('Cai'),
    })
    // Cai has not asked, so the table has not agreed.
    expect(asked.rematch).toEqual({ mine: true, theirs: false })
    const all = table({
      p0: seat('Ann'),
      p1: seat('Ben', { wantsRematch: true }),
      p2: seat('Cai', { wantsRematch: true }),
    })
    expect(all.rematch).toEqual({ mine: false, theirs: true })
  })

  it('sends the one wire action the adapter accepts', () => {
    const snapshot: RoomSnapshot = {
      protocol: 2,
      code: 'ABC234',
      game: 'wildrise',
      visibility: 'private',
      status: 'playing',
      seatIds: ['p0', 'p1'],
      seats: { p0: seat('Ann'), p1: seat('Ben') },
      gameState: createGame({ playerCount: 2 }),
    }
    const wire = api()
    const session = wildriseSession(snapshot, { id: 'ann', seat: 'p0', isHost: true }, wire, () => {})
    session.send.roll()
    expect(wire.action).toHaveBeenCalledTimes(1)
    expect(wire.action).toHaveBeenCalledWith({ kind: 'roll' })
  })
})

describe('claimTarget', () => {
  /** Red opens the game, so Ben in seat p1 is never the one on turn. */
  const onTurnAway = { ...seated, p0: seat('Ann', { connected: false, awaySince: 1 }) }

  it('names the away player the table is stuck on', () => {
    // Ben is at the table watching Ann's turn go unplayed.
    expect(claimTarget(table(onTurnAway, { id: 'ben', seat: 'p1' }))?.name).toBe('Ann')
  })

  it('offers nobody to a spectator, who has no seat to claim with', () => {
    expect(claimTarget(table(onTurnAway, { id: 'eve', seat: null }))).toBeNull()
  })

  it('offers nobody once the claim has already been granted', () => {
    const session = table(
      { ...seated, p0: seat('Ann', { connected: false, awaySince: 1, abandoned: true }) },
      { id: 'ben', seat: 'p1' },
    )
    // The room is rolling for Ann now; asking again would settle nothing.
    expect(claimTarget(session)).toBeNull()
  })

  it('offers nobody while the player on turn is still here, or when it is your own turn', () => {
    expect(claimTarget(table(seated, { id: 'ben', seat: 'p1' }))).toBeNull()
    // Ann is away, but it is Ann's own browser asking — she is not blocked on herself.
    expect(claimTarget(table(onTurnAway))).toBeNull()
  })

  it('offers nobody once the game has been won', () => {
    const session = table(onTurnAway, { id: 'ben', seat: 'p1' })
    const won = { ...session, state: { ...session.state, phase: 'won' as const, winner: 'red' as const } }
    expect(claimTarget(won)).toBeNull()
  })
})
