import { describe, expect, it, vi } from 'vitest'
import { createGame, gameReducer } from '@games/shared/estate'
import type { GameState, Trade } from '@games/shared/estate/types'
import { PROTOCOL_VERSION } from '@games/shared/protocol'
import type { RoomSnapshot, SeatInfo, YouInfo } from '@games/shared/protocol'
import type { RoomApi } from '../../../online/useRoom'
import {
  allowed,
  cardKeyOf,
  claimTarget,
  estateSession,
  onlineDispatch,
  tradeKeyOf,
  wireAction,
} from './session'
import type { OnlineEstateSession } from './session'

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
})

const seat = (name: string, over: Partial<SeatInfo> = {}): SeatInfo => ({
  player: { name, isGuest: true },
  connected: true,
  wantsRematch: false,
  ...over,
})

const table = (names: string[]): GameState =>
  gameReducer(createGame(), {
    type: 'START',
    players: names.map((name) => ({ name, isBot: false })),
    mode: 'classic',
    seed: 4242,
  })

/** A three-seat table under way, with whatever the test wants true of its seats. */
function room(
  seats: Partial<Record<string, SeatInfo>>,
  you: Partial<YouInfo> = {},
  state: Partial<GameState> = {},
) {
  const snapshot: RoomSnapshot = {
    protocol: PROTOCOL_VERSION,
    code: 'ABC234',
    game: 'estate',
    visibility: 'private',
    status: 'playing',
    seatIds: ['p0', 'p1', 'p2'],
    seats,
    gameState: { ...table(['Ann', 'Ben', 'Cai']), ...state },
  }
  const info: YouInfo = { id: 'ann', seat: 'p0', isHost: true, ...you }
  return estateSession(snapshot, info, api(), () => {})
}

const seated = { p0: seat('Ann'), p1: seat('Ben'), p2: seat('Cai') }
const offer = (over: Partial<Trade> = {}): Trade => ({
  from: 0,
  to: 1,
  giveCash: 100,
  getCash: 0,
  giveProperties: [],
  getProperties: [],
  ...over,
})

describe('wireAction', () => {
  it('drops every beat the room paces for itself', () => {
    // Locally the page schedules these on timers; online they are the server's.
    expect(wireAction({ type: 'DICE_SETTLED' })).toBeNull()
    expect(wireAction({ type: 'MOVE_STEP' })).toBeNull()
    expect(wireAction({ type: 'RESOLVE' })).toBeNull()
    expect(wireAction({ type: 'START', players: [], mode: 'classic' })).toBeNull()
  })

  it('passes on every decision a person makes', () => {
    for (const type of [
      'ROLL',
      'BUY',
      'PASS',
      'END_TURN',
      'ACK_CARD',
      'PAY_JAIL',
      'LIQUIDATE',
      'BANKRUPT',
      'ACCEPT_TRADE',
      'REJECT_TRADE',
    ] as const)
      expect(wireAction({ type })).toEqual({ type })
    expect(wireAction({ type: 'BUILD', property: 3 })).toEqual({ type: 'BUILD', property: 3 })
    expect(wireAction({ type: 'MORTGAGE', property: 5 })).toEqual({ type: 'MORTGAGE', property: 5 })
    expect(wireAction({ type: 'PROPOSE_TRADE', trade: offer() })).toEqual({
      type: 'PROPOSE_TRADE',
      trade: offer(),
    })
  })
})

describe('what this browser may decide', () => {
  const mine = () => room(seated)
  const theirs = () => room(seated, { id: 'ben', seat: 'p1' })

  it('lets the seat on turn play, and nobody else', () => {
    expect(allowed(mine(), { type: 'ROLL' })).toBe(true)
    expect(allowed(mine(), { type: 'BUILD', property: 1 })).toBe(true)
    expect(allowed(theirs(), { type: 'ROLL' })).toBe(false)
    // A shared dialog offers a Buy button off the state, not off the viewer, so
    // an off-turn click has to stop somewhere. It stops here.
    expect(allowed(theirs(), { type: 'BUY' })).toBe(false)
  })

  it('lets the seat an offer was made to answer it, off-turn', () => {
    const pending = { trade: offer() }
    expect(allowed(room(seated, { id: 'ben', seat: 'p1' }, pending), { type: 'ACCEPT_TRADE' })).toBe(true)
    expect(allowed(room(seated, { id: 'ben', seat: 'p1' }, pending), { type: 'REJECT_TRADE' })).toBe(true)
    // The seat that made it may withdraw it but not accept it for them.
    expect(allowed(room(seated, {}, pending), { type: 'REJECT_TRADE' })).toBe(true)
    expect(allowed(room(seated, {}, pending), { type: 'ACCEPT_TRADE' })).toBe(false)
    // A bystander has no part in it either way.
    const cai = { id: 'cai', seat: 'p2' }
    expect(allowed(room(seated, cai, pending), { type: 'ACCEPT_TRADE' })).toBe(false)
    expect(allowed(room(seated, cai, pending), { type: 'REJECT_TRADE' })).toBe(false)
  })

  it('freezes the rest of the game while an offer stands', () => {
    expect(allowed(room(seated, {}, { trade: offer() }), { type: 'ROLL' })).toBe(false)
    expect(allowed(room(seated, {}, { trade: offer() }), { type: 'BUILD', property: 1 })).toBe(false)
  })

  it('lets a watcher do nothing at all', () => {
    const watcher = room(seated, { id: 'dee', seat: null })
    expect(watcher.mySeat).toBeNull()
    expect(allowed(watcher, { type: 'ROLL' })).toBe(false)
    expect(allowed(watcher, { type: 'ACCEPT_TRADE' })).toBe(false)
  })

  it('stops sending anything once the game is over', () => {
    expect(allowed(room(seated, {}, { status: 'finished', winner: 0 }), { type: 'ROLL' })).toBe(false)
  })
})

describe('onlineDispatch', () => {
  const spy = () => {
    const sent: unknown[] = []
    return { sent, send: (action: unknown) => sent.push(action) }
  }
  const wired = (session: OnlineEstateSession, sink: (action: unknown) => void) =>
    onlineDispatch({ ...session, send: { ...session.send, action: sink } })

  it('sends a decision and swallows a beat', () => {
    const { sent, send } = spy()
    const dispatch = wired(room(seated), send)
    dispatch({ type: 'ROLL' })
    dispatch({ type: 'MOVE_STEP' })
    dispatch({ type: 'DICE_SETTLED' })
    expect(sent).toEqual([{ type: 'ROLL' }])
  })

  it('swallows a decision this browser is not entitled to make', () => {
    const { sent, send } = spy()
    wired(room(seated, { id: 'ben', seat: 'p1' }), send)({ type: 'BUY' })
    expect(sent).toEqual([])
  })
})

describe('the keys a self-opening dialog watches', () => {
  const base = table(['Ann', 'Ben', 'Cai'])
  const chance = {
    title: 'Take a trip',
    text: 'Advance to Union Station.',
    deck: 'chance' as const,
    effect: 'move' as const,
    destination: 5,
  }

  it('names an offer by the two seats it is between', () => {
    expect(tradeKeyOf(base)).toBe('')
    expect(tradeKeyOf({ ...base, trade: offer() })).toBe('0-1')
    expect(tradeKeyOf({ ...base, trade: offer({ from: 2, to: 0 }) })).toBe('2-0')
    // A snapshot is parsed fresh out of every broadcast, so the same offer
    // arrives as a different object several times a turn. The key is not.
    expect(tradeKeyOf({ ...base, trade: offer() })).toBe(tradeKeyOf({ ...base, trade: { ...offer() } }))
  })

  it('names a card by the event it was drawn on', () => {
    expect(cardKeyOf(base)).toBe('')
    // A card only counts while it is on the table — the field outlives the phase.
    expect(cardKeyOf({ ...base, card: chance, phase: 'end' })).toBe('')
    const drawn = { ...base, card: chance, phase: 'card' as const, eventId: 12 }
    expect(cardKeyOf(drawn)).toBe('12-Take a trip')
    // Put down by a viewer who did not draw it, a card has to stay down: nothing
    // else is logged while one is on the table, so its key cannot move under it.
    expect(cardKeyOf({ ...drawn, card: { ...chance } })).toBe(cardKeyOf(drawn))
    expect(cardKeyOf({ ...drawn, players: drawn.players.map((p) => ({ ...p })) })).toBe(cardKeyOf(drawn))
    // The next card is a different card, even when it is the same card.
    expect(cardKeyOf({ ...drawn, eventId: 13 })).not.toBe(cardKeyOf(drawn))
    expect(cardKeyOf({ ...drawn, card: { ...chance, title: 'A windfall' } })).not.toBe(cardKeyOf(drawn))
  })
})

describe('the estate session', () => {
  it('reads the table in the terms the board thinks in', () => {
    const session = room(seated)
    expect(session.mySeat).toBe(0)
    expect(session.state.players.map((p) => p.name)).toEqual(['Ann', 'Ben', 'Cai'])
    expect(session.players[1]?.name).toBe('Ben')
    expect(session.players[2]?.connected).toBe(true)
    expect(room(seated, { id: 'cai', seat: 'p2' }).mySeat).toBe(2)
    expect(room(seated, { id: 'dee', seat: null }).mySeat).toBeNull()
  })

  it('only calls a rematch agreed once everyone else has asked', () => {
    expect(room(seated).rematch).toEqual({ mine: false, theirs: false })
    const asked = { ...seated, p1: seat('Ben', { wantsRematch: true }) }
    expect(room(asked).rematch).toEqual({ mine: false, theirs: false })
    const all = {
      p0: seat('Ann', { wantsRematch: true }),
      p1: seat('Ben', { wantsRematch: true }),
      p2: seat('Cai', { wantsRematch: true }),
    }
    expect(room(all).rematch).toEqual({ mine: true, theirs: true })
  })

  it('forwards the room’s own messages untouched', () => {
    const wire = api()
    const snapshot: RoomSnapshot = {
      protocol: PROTOCOL_VERSION,
      code: 'ABC234',
      game: 'estate',
      visibility: 'private',
      status: 'playing',
      seatIds: ['p0', 'p1'],
      seats: { p0: seat('Ann'), p1: seat('Ben') },
      gameState: table(['Ann', 'Ben']),
    }
    const leave = vi.fn()
    const session = estateSession(snapshot, { id: 'ann', seat: 'p0', isHost: true }, wire, leave)
    session.send.action({ type: 'ROLL' })
    session.send.rematch()
    session.send.claim()
    session.leave()
    expect(wire.action).toHaveBeenCalledWith({ type: 'ROLL' })
    expect(wire.rematch).toHaveBeenCalled()
    expect(wire.claim).toHaveBeenCalled()
    expect(leave).toHaveBeenCalled()
  })
})

describe('claimTarget', () => {
  const away = (name: string) => seat(name, { connected: false, awaySince: 1_000 })

  it('names the player the table is stuck on', () => {
    // Ann is on turn, so nothing is blocked on Ben being away.
    expect(claimTarget(room({ ...seated, p1: away('Ben') }))).toBeNull()
    // With the turn Ben's, it is.
    const stuck = room({ ...seated, p1: away('Ben') }, {}, { current: 1 })
    expect(claimTarget(stuck)?.name).toBe('Ben')
  })

  it('names the player an offer is waiting on, whosever turn it is', () => {
    const stuck = room({ ...seated, p1: away('Ben') }, {}, { trade: offer() })
    expect(claimTarget(stuck)?.name).toBe('Ben')
    // An offer to someone who is here blocks nobody.
    expect(claimTarget(room(seated, {}, { trade: offer() }))).toBeNull()
  })

  it('has nothing to offer once the claim has been granted', () => {
    const played = { ...seated, p1: seat('Ben', { connected: false, awaySince: 1_000, abandoned: true }) }
    expect(claimTarget(room(played, {}, { current: 1 }))).toBeNull()
  })

  it('gives a watcher no standing, and a finished game nothing to claim', () => {
    const seats = { ...seated, p1: away('Ben') }
    expect(claimTarget(room(seats, { id: 'dee', seat: null }, { current: 1 }))).toBeNull()
    expect(claimTarget(room(seats, {}, { current: 1, status: 'finished', winner: 0 }))).toBeNull()
  })
})
