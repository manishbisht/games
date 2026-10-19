import { describe, expect, it, vi } from 'vitest'
import { createGame } from '@games/shared/hearth'
import { PROTOCOL_VERSION } from '@games/shared/protocol'
import type { RoomSnapshot, SeatInfo, YouInfo } from '@games/shared/protocol'
import type { RoomApi } from '../../../online/useRoom'
import { hearthSession } from './session'

const api = (): RoomApi => ({
  sit: vi.fn(),
  leaveSeat: vi.fn(),
  start: vi.fn(),
  action: vi.fn(),
  rematch: vi.fn(),
  claim: vi.fn(),
  addBot: vi.fn(),
  removeBot: vi.fn(),
  dismissError: vi.fn(),
  react: vi.fn(),
})

const seat = (name: string, over: Partial<SeatInfo> = {}): SeatInfo => ({
  player: { name, isGuest: true },
  connected: true,
  wantsRematch: false,
  ...over,
})

/** A three-seat table mid-game, with whatever the test wants true of its seats. */
function table(
  seats: Partial<Record<string, SeatInfo>>,
  you: Partial<YouInfo> = {},
  timing?: RoomSnapshot['timing'],
) {
  const snapshot: RoomSnapshot = {
    protocol: PROTOCOL_VERSION,
    code: 'ABC234',
    game: 'hearth',
    visibility: 'private',
    status: 'playing',
    seatIds: ['p0', 'p1', 'p2'],
    seats,
    gameState: createGame({ playerCount: 3, names: ['Ann', 'Ben', 'Cai'] }),
    ...(timing ? { timing } : {}),
  }
  const info: YouInfo = { id: 'ann', seat: 'p0', isHost: true, ...you }
  return hearthSession({
    snapshot,
    receivedAt: 20_000,
    recent: [{ seq: 1, snapshot, receivedAt: 20_000 }],
    you: info,
    api: api(),
    leave: () => {},
  })
}

const seated = {
  p0: seat('Ann'),
  p1: seat('Ben'),
  p2: seat('Cai'),
}

describe('hearthSession', () => {
  it('maps seats onto the colours they were dealt, in seat order', () => {
    const session = table(seated)
    expect(session.mySeat).toBe('red')
    expect(session.players.red?.name).toBe('Ann')
    expect(session.players.blue?.name).toBe('Ben')
    expect(session.players.green?.name).toBe('Cai')
    expect(session.players.yellow).toBeUndefined()
  })

  it('says when the beat began on this page’s clock, counted back from when the snapshot arrived', () => {
    // Rendered well after it arrived: the arrival is what counts.
    const now = vi.spyOn(performance, 'now').mockReturnValue(90_000)
    expect(table(seated, {}, { now: 50_900, since: 50_000, due: 51_400 }).beats.at(-1)!.since).toBe(19_100)
    // An older server sends no timing: the beat is taken to start on arrival.
    expect(table(seated).beats.at(-1)!.since).toBe(20_000)
    now.mockRestore()
  })

  it('hands over every state of a burst in order, from the start of the game that ends it', () => {
    const lobby: RoomSnapshot = {
        protocol: PROTOCOL_VERSION,
        code: 'ABC234',
        game: 'hearth',
        visibility: 'private',
        status: 'open',
        seatIds: ['p0', 'p1'],
        seats: { p0: seat('Ann'), p1: seat('Ben') },
        gameState: null,
      },
      dealt = { ...lobby, status: 'playing' as const, gameState: createGame({ playerCount: 2 }) },
      rolled = { ...dealt, gameState: { ...dealt.gameState, phase: 'rolling' as const } },
      session = hearthSession({
        snapshot: rolled,
        receivedAt: 3_000,
        recent: [
          { seq: 4, snapshot: dealt, receivedAt: 1_000 },
          { seq: 5, snapshot: lobby, receivedAt: 2_000 },
          { seq: 6, snapshot: dealt, receivedAt: 2_990 },
          { seq: 7, snapshot: rolled, receivedAt: 3_000 },
        ],
        you: { id: 'ann', seat: 'p0', isHost: true },
        api: api(),
        leave: () => {},
      })
    expect(session.beats).toEqual([
      { seq: 6, state: dealt.gameState, since: 2_990 },
      { seq: 7, state: rolled.gameState, since: 3_000 },
    ])
    expect(session.beats.at(-1)!.state).toBe(session.state)
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

  it('sends the two wire actions the adapter accepts', () => {
    const snapshot: RoomSnapshot = {
      protocol: PROTOCOL_VERSION,
      code: 'ABC234',
      game: 'hearth',
      visibility: 'private',
      status: 'playing',
      seatIds: ['p0', 'p1'],
      seats: { p0: seat('Ann'), p1: seat('Ben') },
      gameState: createGame({ playerCount: 2 }),
    }
    const wire = api()
    const session = hearthSession({
      snapshot,
      receivedAt: 0,
      recent: [{ seq: 1, snapshot, receivedAt: 0 }],
      you: { id: 'ann', seat: 'p0', isHost: true },
      api: wire,
      leave: () => {},
    })
    session.send.roll()
    session.send.move('red-2')
    expect(wire.action).toHaveBeenNthCalledWith(1, { kind: 'roll' })
    expect(wire.action).toHaveBeenNthCalledWith(2, { kind: 'move', pieceId: 'red-2' })
  })
})

describe('claimable', () => {
  /** Red opens the game, so Ben in seat p1 is never the one on turn. */
  const onTurnAway = { ...seated, p0: seat('Ann', { connected: false, awaySince: 1 }) }

  it('names the away player the table is stuck on, by the colour on turn', () => {
    // Ben is at the table watching Ann's turn go unplayed.
    expect(table(onTurnAway, { id: 'ben', seat: 'p1' }).claimable?.name).toBe('Ann')
    // Ann is away, but it is Ann's own browser asking — she is not blocked on herself.
    expect(table(onTurnAway).claimable).toBeNull()
  })

  it('offers nobody once the game has been won', () => {
    const won = createGame({ playerCount: 3 })
    const session = hearthSession({
      snapshot: {
        protocol: PROTOCOL_VERSION,
        code: 'ABC234',
        game: 'hearth',
        visibility: 'private',
        status: 'finished',
        seatIds: ['p0', 'p1', 'p2'],
        seats: onTurnAway,
        gameState: { ...won, phase: 'won', winner: 'blue' },
      },
      receivedAt: 0,
      recent: [],
      you: { id: 'ben', seat: 'p1', isHost: false },
      api: api(),
      leave: () => {},
    })
    expect(session.claimable).toBeNull()
  })
})

describe('reactions', () => {
  it('places each reaction at the colour its seat was dealt, and a spectator’s at nobody’s', () => {
    const snapshot: RoomSnapshot = {
      protocol: PROTOCOL_VERSION,
      code: 'ABC234',
      game: 'hearth',
      visibility: 'private',
      status: 'playing',
      seatIds: ['p0', 'p1', 'p2'],
      seats: seated,
      gameState: createGame({ playerCount: 3 }),
    }
    const wire = api()
    const session = hearthSession({
      snapshot,
      receivedAt: 0,
      recent: [],
      reactions: [
        { id: 'r1', seat: 'p2', reaction: 'wow', at: 1, receivedAt: 10 },
        { id: 'r2', seat: null, reaction: 'gg', at: 2, receivedAt: 20 },
      ],
      you: { id: 'ann', seat: 'p0', isHost: true },
      api: wire,
      leave: () => {},
    })
    expect(session.reactions).toEqual([
      { id: 'r1', colour: 'green', reaction: 'wow', name: 'Cai', receivedAt: 10 },
      { id: 'r2', colour: null, reaction: 'gg', name: 'Someone watching', receivedAt: 20 },
    ])
    session.send.react?.('haha')
    expect(wire.react).toHaveBeenCalledWith('haha')
  })
})
