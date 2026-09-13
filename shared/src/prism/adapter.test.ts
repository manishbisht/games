import { describe, expect, it } from 'vitest'
import type { Ctx } from '../online/adapter'
import { prismAdapter } from './adapter'
import { createDeck } from './engine'
import type { PrismOnlineAction } from './online'
import type { Card, GameState } from './types'

const SEATS = ['p0', 'p1', 'p2']
const players = [
  { id: 'p0', name: 'Ann' },
  { id: 'p1', name: 'Ben' },
  { id: 'p2', name: 'Cai' },
]

/** A pinned stream, so the deal, the shuffles and the stand-in are all repeatable. */
function seeded(seed = 7) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
}
const ctx = (random = seeded(), now = 1_700_000_000_000): Ctx => ({ random, now })

const deck = () => createDeck()
const card = (color: Card['color'], value: Card['value']) =>
  deck().find((c) => c.color === color && c.value === value)!

const start = (seats = players) => prismAdapter.create(seats, {}, ctx()) as GameState

/** A table with the hands each test wants, and the rest of the deck behind it. */
function position(hands: Card[][], over: Partial<GameState> = {}): GameState {
  const base = start(players.slice(0, hands.length))
  // Face up and in nobody's hand, so "what the viewer may see" stays a clean set.
  const top = card('red', 1)
  const used = new Set([...hands.flat(), top].map((c) => c.id))
  return {
    ...base,
    players: base.players.map((player, index) => ({ ...player, hand: hands[index] })),
    drawPile: deck().filter((c) => !used.has(c.id)),
    discardPile: [top],
    activeColor: 'red',
    currentPlayer: 0,
    events: [],
    sequence: 0,
    ...over,
  }
}

/** `apply` succeeds or explains itself; tests that expect a move to land want the state. */
function act(state: GameState, seat: string, action: PrismOnlineAction, seats = SEATS) {
  const result = prismAdapter.apply(state, seat, seats, action, ctx())
  if ('error' in result) throw new Error(`unexpected ${result.error}: ${result.message}`)
  return result.state
}

/**
 * Every real deck id anywhere in a serialized value. Deliberately a scan of the
 * whole JSON rather than a walk of the fields we remembered to redact: a leak
 * that hides in a field this test does not know about is exactly the leak worth
 * catching.
 */
const dealtIds = (value: unknown) => new Set(JSON.stringify(value).match(/prism-\d+/g) ?? [])
const ids = (cards: Card[]) => cards.map((c) => c.id)

describe('prism adapter shape', () => {
  it('seats two to four, and does not insist on a full table', () => {
    expect(prismAdapter.id).toBe('prism')
    expect([prismAdapter.minSeats, prismAdapter.maxSeats]).toEqual([2, 4])
    expect(prismAdapter.requireFull).toBe(false)
    expect(prismAdapter.seatIds(4)).toEqual(['p0', 'p1', 'p2', 'p3'])
    expect(prismAdapter.validateOptions({ handSize: 40, jumpIn: true })).toEqual({})
  })

  it('deals a classic table from the server’s own shuffle', () => {
    const state = start()
    expect(state.players.map((p) => p.name)).toEqual(['Ann', 'Ben', 'Cai'])
    expect(state.players.every((p) => p.kind === 'human' && p.hand.length === 7)).toBe(true)
    expect(state.discardPile).toHaveLength(1)
    expect(state.discardPile[0].type).toBe('number')
    // Every one of the 108 cards is accounted for, and none was dealt twice.
    const all = [...state.players.flatMap((p) => p.hand), ...state.drawPile, ...state.discardPile]
    expect(new Set(ids(all)).size).toBe(108)
    expect(prismAdapter.isFinished(state)).toBe(false)
    // Nothing here is presentation: every state waits on a person.
    expect(prismAdapter.pending(state)).toBeNull()
    expect(prismAdapter.waitingOn(state, SEATS)).toEqual(['p0'])
  })

  it('deals a different table to the next room, and the same one to the same seed', () => {
    const once = prismAdapter.create(players, {}, ctx(seeded(1))) as GameState
    const again = prismAdapter.create(players, {}, ctx(seeded(1))) as GameState
    const other = prismAdapter.create(players, {}, ctx(seeded(2))) as GameState
    expect(ids(once.drawPile)).toEqual(ids(again.drawPile))
    expect(ids(once.drawPile)).not.toEqual(ids(other.drawPile))
  })

  it('reads the five wire actions and rejects everything else', () => {
    expect(prismAdapter.validateAction({ kind: 'draw' })).toEqual({ kind: 'draw' })
    expect(prismAdapter.validateAction({ kind: 'pass' })).toEqual({ kind: 'pass' })
    expect(prismAdapter.validateAction({ kind: 'call' })).toEqual({ kind: 'call' })
    expect(prismAdapter.validateAction({ kind: 'catch', target: 2 })).toEqual({ kind: 'catch', target: 2 })
    expect(prismAdapter.validateAction({ kind: 'play', cardId: 'prism-3' })).toEqual({
      kind: 'play',
      cardId: 'prism-3',
    })
    expect(prismAdapter.validateAction({ kind: 'play', cardId: 'prism-3', color: 'blue' })).toEqual({
      kind: 'play',
      cardId: 'prism-3',
      color: 'blue',
    })
    // A player index is never taken off the wire — the seat the message arrived
    // on decides who acted, so nothing here can name someone else.
    expect(prismAdapter.validateAction({ kind: 'play', cardId: 'prism-3', player: 2 })).toEqual({
      kind: 'play',
      cardId: 'prism-3',
    })
    for (const raw of [
      null,
      'draw',
      {},
      { kind: 'nope' },
      { kind: 'play' },
      { kind: 'play', cardId: 7 },
      { kind: 'play', cardId: 'prism-3', color: 'purple' },
      { kind: 'catch' },
      { kind: 'catch', target: '1' },
      { kind: 'catch', target: 1.5 },
    ])
      expect(prismAdapter.validateAction(raw)).toBeNull()
  })
})

describe('prism adapter redaction', () => {
  const hands = [
    [card('red', 5), card('blue', 7), card('wild', 'draw4')],
    [card('green', 2), card('yellow', 9)],
    [card('blue', 'skip')],
  ]
  /** Ben has drawn and not yet played it, so a private card is in the open state. */
  const table = position(hands, { drawnCardId: hands[1][1].id, currentPlayer: 1, callWindow: 2 })

  it('leaves the viewer their own hand, exactly as dealt', () => {
    const mine = prismAdapter.view(table, 'p0') as GameState
    expect(mine.players[0].hand).toEqual(hands[0])
  })

  it('replaces every other hand with placeholders that keep only the count', () => {
    const mine = prismAdapter.view(table, 'p0') as GameState
    expect(mine.players.map((p) => p.hand.length)).toEqual([3, 2, 1])
    expect(ids(mine.players[1].hand)).toEqual(['hidden-1-0', 'hidden-1-1'])
    expect(ids(mine.players[2].hand)).toEqual(['hidden-2-0'])
    // One face for every hidden card, so the face itself says nothing.
    const faces = [...mine.players[1].hand, ...mine.players[2].hand].map(({ id, ...face }) => face)
    expect(new Set(faces.map((f) => JSON.stringify(f))).size).toBe(1)
  })

  it('hides the draw pile from everyone, and keeps its depth', () => {
    for (const seat of [...SEATS, null]) {
      const seen = prismAdapter.view(table, seat) as GameState
      expect(seen.drawPile).toHaveLength(table.drawPile.length)
      expect(ids(seen.drawPile).slice(0, 3)).toEqual(['hidden-pile-0', 'hidden-pile-1', 'hidden-pile-2'])
    }
  })

  it('tells only the seat that drew it which card it drew', () => {
    expect((prismAdapter.view(table, 'p1') as GameState).drawnCardId).toBe(hands[1][1].id)
    expect((prismAdapter.view(table, 'p0') as GameState).drawnCardId).toBeNull()
    expect((prismAdapter.view(table, 'p2') as GameState).drawnCardId).toBeNull()
    expect((prismAdapter.view(table, null) as GameState).drawnCardId).toBeNull()
  })

  it('leaves the public table public', () => {
    const mine = prismAdapter.view(table, 'p0') as GameState
    expect(mine.discardPile).toEqual(table.discardPile)
    expect(mine.activeColor).toBe(table.activeColor)
    expect(mine.currentPlayer).toBe(table.currentPlayer)
    expect(mine.direction).toBe(table.direction)
    expect(mine.pendingPenalty).toEqual(table.pendingPenalty)
    expect(mine.callWindow).toBe(2)
    expect(mine.preCalled).toBe(table.preCalled)
    expect(mine.status).toBe(table.status)
    expect(mine.winner).toBe(table.winner)
    expect(mine.round).toBe(table.round)
    expect(mine.roundScore).toBe(table.roundScore)
    expect(mine.turn).toBe(table.turn)
    expect(mine.rules).toEqual(table.rules)
    expect(mine.players.map((p) => [p.id, p.name, p.kind, p.called, p.totalScore])).toEqual(
      table.players.map((p) => [p.id, p.name, p.kind, p.called, p.totalScore]),
    )
  })

  it('lets no dealt id out of a zone the viewer may not see', () => {
    const hiddenFrom = (index: number) =>
      new Set(
        [...table.drawPile, ...table.players.flatMap((p, i) => (i === index ? [] : p.hand))].map((c) => c.id),
      )
    for (const [index, seat] of SEATS.entries()) {
      const seen = dealtIds(prismAdapter.view(table, seat))
      for (const id of hiddenFrom(index)) expect(seen.has(id)).toBe(false)
      // And what is left is exactly this seat's own hand plus the open discard.
      expect([...seen].sort()).toEqual([...ids(table.players[index].hand), ...ids(table.discardPile)].sort())
    }
  })

  it('shows a spectator the table and nobody’s cards', () => {
    const watching = prismAdapter.view(table, null) as GameState
    expect(watching.players.map((p) => p.hand.length)).toEqual([3, 2, 1])
    expect(watching.players.flatMap((p) => ids(p.hand))).toEqual([
      'hidden-0-0',
      'hidden-0-1',
      'hidden-0-2',
      'hidden-1-0',
      'hidden-1-1',
      'hidden-2-0',
    ])
    expect(watching.discardPile).toEqual(table.discardPile)
    // The one thing a spectator may read is what is face up on the table.
    expect([...dealtIds(watching)]).toEqual(ids(table.discardPile))
  })

  it('redacts a seat it has never heard of, rather than trusting the id', () => {
    const stranger = prismAdapter.view(table, 'p9') as GameState
    expect([...dealtIds(stranger)]).toEqual(ids(table.discardPile))
    expect(prismAdapter.view(table, 'nonsense') as GameState).toEqual(
      prismAdapter.view(table, null) as GameState,
    )
  })

  it('takes back an event’s card once a reshuffle folds it into the pile', () => {
    const played = card('green', 3)
    // The log remembers the play; the shuffle has since put that card back in
    // the pile, where naming it would give its position away.
    const reshuffled = position(hands, {
      drawPile: [...table.drawPile, played],
      events: [{ id: 1, kind: 'play', text: 'Ben played Green 3.', player: 1, card: played }],
    })
    const seen = prismAdapter.view(reshuffled, 'p0') as GameState
    expect(seen.events[0].card?.id).toBe('hidden-event-1')
    expect(seen.events[0].text).toBe('Ben played Green 3.')
    expect(dealtIds(seen).has(played.id)).toBe(false)
    // A card still face up on the discard is nobody's secret, so it stays named.
    const open = position(hands, {
      events: [{ id: 1, kind: 'play', text: 'Ann played Red 1.', player: 0, card: card('red', 1) }],
    })
    expect((prismAdapter.view(open, 'p1') as GameState).events[0].card).toEqual(card('red', 1))
  })

  it('redacts a copy and leaves the room’s own state alone', () => {
    const before = JSON.stringify(table)
    prismAdapter.view(table, 'p0')
    prismAdapter.view(table, null)
    expect(JSON.stringify(table)).toBe(before)
  })
})

describe('prism adapter authorization', () => {
  const hands = [
    [card('red', 5), card('blue', 7)],
    [card('green', 2), card('yellow', 9)],
    [card('blue', 'skip')],
  ]

  it('plays the card the seat on turn asks for, as that seat', () => {
    const table = position(hands)
    const next = act(table, 'p0', { kind: 'play', cardId: hands[0][0].id })
    expect(next.players[0].hand).toHaveLength(1)
    expect(next.discardPile.at(-1)!.id).toBe(hands[0][0].id)
    expect(next.currentPlayer).toBe(1)
  })

  it('refuses a play from a seat that is not on turn', () => {
    expect(
      prismAdapter.apply(position(hands), 'p1', SEATS, { kind: 'play', cardId: hands[1][0].id }, ctx()),
    ).toEqual({ error: 'NOT_YOUR_TURN', message: 'It is not your turn.' })
  })

  it('cannot be told which player is acting — the seat decides', () => {
    const table = position(hands)
    // Ben's socket asking to play Ann's card, in Ann's turn, under her index.
    const spoofed = prismAdapter.validateAction({
      kind: 'play',
      cardId: hands[0][0].id,
      player: 0,
    })!
    expect(prismAdapter.apply(table, 'p1', SEATS, spoofed, ctx())).toMatchObject({
      error: 'NOT_YOUR_TURN',
    })
  })

  it('refuses a card that does not go there, and a card nobody holds', () => {
    const table = position(hands)
    expect(
      prismAdapter.apply(table, 'p0', SEATS, { kind: 'play', cardId: hands[0][1].id }, ctx()),
    ).toMatchObject({ error: 'ILLEGAL_MOVE' })
    expect(
      prismAdapter.apply(table, 'p0', SEATS, { kind: 'play', cardId: hands[2][0].id }, ctx()),
    ).toMatchObject({ error: 'ILLEGAL_MOVE' })
  })

  it('refuses a second draw, and a pass with nothing drawn', () => {
    expect(prismAdapter.apply(position(hands), 'p0', SEATS, { kind: 'pass' }, ctx())).toMatchObject({
      error: 'ILLEGAL_MOVE',
    })
    const held = position(hands, { drawnCardId: hands[0][0].id })
    expect(prismAdapter.apply(held, 'p0', SEATS, { kind: 'draw' }, ctx())).toMatchObject({
      error: 'ILLEGAL_MOVE',
    })
    // Keeping the drawn card is the way on from there.
    expect(act(held, 'p0', { kind: 'pass' }).currentPlayer).toBe(1)
  })

  it('lets a seat that is not on turn catch the player who forgot to call', () => {
    // Ben is down to his last card and the window is open on him; Ann is on turn.
    const table = position([hands[0], [card('green', 2)], hands[2]], { callWindow: 1 })
    const caught = act(table, 'p2', { kind: 'catch', target: 1 })
    expect(caught.players[1].hand).toHaveLength(1 + caught.rules.callPenalty)
    expect(caught.callWindow).toBeNull()
    // The turn is untouched: catching is not taking one.
    expect(caught.currentPlayer).toBe(0)
  })

  it('refuses a catch and a call there is no window for', () => {
    const table = position(hands)
    expect(prismAdapter.apply(table, 'p2', SEATS, { kind: 'catch', target: 1 }, ctx())).toEqual({
      error: 'NOT_ALLOWED',
      message: 'There is nobody to catch just now.',
    })
    // Cai has one card but the window is not open, and it is not his turn either.
    expect(prismAdapter.apply(table, 'p2', SEATS, { kind: 'call' }, ctx())).toEqual({
      error: 'NOT_ALLOWED',
      message: 'There is nothing to call just now.',
    })
    expect(prismAdapter.apply(table, 'p2', SEATS, { kind: 'catch', target: 9 }, ctx())).toMatchObject({
      error: 'NOT_ALLOWED',
    })
  })

  it('lets the seat on turn call before laying down its second-last card', () => {
    const called = act(position(hands), 'p0', { kind: 'call' })
    expect(called.preCalled).toBe(0)
    const down = act(called, 'p0', { kind: 'play', cardId: hands[0][0].id })
    // Called in time, so no window opens for anyone to catch.
    expect(down.players[0].called).toBe(true)
    expect(down.callWindow).toBeNull()
  })

  it('refuses everything once the round is over', () => {
    const over = position(hands, { status: 'won', winner: 0 })
    expect(prismAdapter.apply(over, 'p0', SEATS, { kind: 'draw' }, ctx())).toEqual({
      error: 'NOT_PLAYING',
      message: 'The round is already over.',
    })
    expect(prismAdapter.isFinished(over)).toBe(true)
    expect(prismAdapter.waitingOn(over, SEATS)).toEqual([])
    expect(prismAdapter.isFinished(position(hands, { status: 'draw' }))).toBe(true)
  })

  it('refuses a seat that is not at this table', () => {
    expect(prismAdapter.apply(position(hands), 'p7', SEATS, { kind: 'draw' }, ctx())).toMatchObject({
      error: 'NOT_ALLOWED',
    })
  })
})

describe('prism adapter absences and rematches', () => {
  const hands = [
    [card('red', 5), card('blue', 7)],
    [card('green', 2), card('yellow', 9)],
    [card('blue', 'skip')],
  ]

  it('plays one decision for the seat on turn, and never forfeits it', () => {
    const table = position(hands)
    const played = prismAdapter.resolveAbsent(table, 'p0', SEATS, ctx())!
    expect(played).not.toBe(table)
    expect(played.currentPlayer).toBe(1)
    // Only the turn it was sitting on: the next seat is still the next seat's.
    expect(prismAdapter.resolveAbsent(played, 'p0', SEATS, ctx())).toBe(played)
    // Two at the table is still a table — nobody wins a card game by default.
    const pair = position(hands.slice(0, 2))
    expect(prismAdapter.resolveAbsent(pair, 'p0', ['p0', 'p1'], ctx())).not.toBeNull()
  })

  it('draws for a seat that has nothing to play', () => {
    const stuck = position([[card('green', 8), card('yellow', 4)], hands[1], hands[2]])
    const drawn = prismAdapter.resolveAbsent(stuck, 'p0', SEATS, ctx())!
    expect(drawn.players[0].hand.length).toBeGreaterThan(2)
  })

  it('leaves a finished round, and a seat that is not on turn, exactly as they are', () => {
    const table = position(hands)
    expect(prismAdapter.resolveAbsent(table, 'p1', SEATS, ctx())).toBe(table)
    const over = position(hands, { status: 'won', winner: 0 })
    expect(prismAdapter.resolveAbsent(over, 'p0', SEATS, ctx())).toBe(over)
  })

  it('deals the next round of the same match, carrying the totals', () => {
    const finished = position(hands, {
      status: 'won',
      winner: 1,
      round: 3,
      players: position(hands).players.map((p, i) => ({ ...p, totalScore: [12, 40, 7][i] })),
    })
    const { state, seatRemap } = prismAdapter.rematch(finished, players, {}, ctx()) as {
      state: GameState
      seatRemap?: Record<string, string>
    }
    // Same seats in the same order: a Prism seat carries nothing worth rotating.
    expect(seatRemap).toBeUndefined()
    expect(state.players.map((p) => p.name)).toEqual(['Ann', 'Ben', 'Cai'])
    expect(state.players.map((p) => p.totalScore)).toEqual([12, 40, 7])
    expect(state.round).toBe(4)
    expect(state.status).toBe('playing')
    expect(state.currentPlayer).toBe(0)
    expect(state.players.every((p) => p.hand.length === 7)).toBe(true)
    expect(state.roundScore).toBe(0)
  })
})
