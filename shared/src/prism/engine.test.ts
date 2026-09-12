import { describe, expect, it } from 'vitest'
import { createDeck, createGame, act, playableCards, cardPoints } from './engine'
import { chooseMove } from './ai'
import type { Card, GameState } from './types'

const deck = () => createDeck()
const card = (color: string, value: string | number) =>
  deck().find((c) => c.color === color && c.value === value)!
function position(hands: Card[][], top = card('red', 5)): GameState {
  const state = createGame(hands.map((_, i) => ({ name: `Player ${i + 1}`, kind: 'human' })))
  const ids = new Set([...hands.flat(), top].map((c) => c.id))
  return {
    ...state,
    players: state.players.map((p, i) => ({ ...p, hand: hands[i] })),
    drawPile: deck().filter((c) => !ids.has(c.id)),
    discardPile: [top],
    activeColor: top.color === 'wild' ? 'red' : top.color,
    currentPlayer: 0,
    events: [],
    sequence: 0,
  }
}
const play = (s: GameState, c: Card, color?: 'red' | 'blue' | 'green' | 'yellow') =>
  act(s, { type: 'play', player: s.currentPlayer, cardId: c.id, color })
function seeded(seed: number) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
}

describe('Prism engine', () => {
  it('builds 108 unique cards and conserves them during 2–4 player setup', () => {
    expect(deck()).toHaveLength(108)
    expect(new Set(deck().map((c) => c.id)).size).toBe(108)
    for (const n of [2, 3, 4]) {
      const s = createGame(
        Array.from({ length: n }, (_, i) => ({ name: `${i}`, kind: 'human' })),
        {},
        seeded(n),
      )
      expect(s.players.every((p) => p.hand.length === 7)).toBe(true)
      expect(s.discardPile[0].type).toBe('number')
      expect(s.drawPile.length + s.players.flatMap((p) => p.hand).length + 1).toBe(108)
    }
  })
  it('matches color, number and action, and rejects out-of-turn or illegal input immutably', () => {
    const s = position([[card('red', 2), card('blue', 5), card('green', 9)], [card('yellow', 8)]])
    expect(playableCards(s).map((c) => c.value)).toEqual([2, 5])
    expect(play(s, card('green', 9))).toBe(s)
    expect(act(s, { type: 'draw', player: 1 })).toBe(s)
    const next = play(s, card('red', 2))
    expect(next.currentPlayer).toBe(1)
    expect(s.players[0].hand).toHaveLength(3)
    const action = position([[card('blue', 'skip')], [card('yellow', 2)]], card('red', 'skip'))
    expect(playableCards(action)).toHaveLength(1)
  })
  it('skips and reverses in both two-player and multiplayer games', () => {
    for (const effect of ['skip', 'reverse']) {
      const s = position([[card('red', effect), card('green', 0)], [card('yellow', 8)]])
      expect(play(s, card('red', effect)).currentPlayer).toBe(0)
    }
    const s = position([[card('red', 'reverse'), card('green', 0)], [card('yellow', 8)], [card('blue', 1)]])
    const next = play(s, card('red', 'reverse'))
    expect(next.direction).toBe(-1)
    expect(next.currentPlayer).toBe(2)
  })
  it('applies draw-two and draw-four penalties and skips the recipient', () => {
    for (const [c, count] of [
      [card('red', 'draw2'), 2],
      [card('wild', 'draw4'), 4],
    ] as const) {
      const s = position([[c, card('green', 0)], [card('yellow', 8)], [card('blue', 1)]])
      const next = play(s, c, c.isWild ? 'blue' : undefined)
      expect(next.players[1].hand).toHaveLength(1 + count)
      expect(next.currentPlayer).toBe(2)
      expect(next.activeColor).toBe(c.isWild ? 'blue' : 'red')
    }
  })
  it('requires a color for wilds and restricts Draw Four using active-color cards only', () => {
    const wild = card('wild', 'wild'),
      four = card('wild', 'draw4')
    const s = position([[wild, four, card('red', 3)], [card('blue', 2)]])
    expect(play(s, wild)).toBe(s)
    expect(playableCards(s).some((c) => c.value === 'draw4')).toBe(false)
    expect(play(s, wild, 'yellow').activeColor).toBe('yellow')
    const legal = position([[four, card('blue', 5)], [card('yellow', 8)]])
    expect(playableCards(legal).some((c) => c.value === 'draw4')).toBe(true)
  })
  it('permits only the drawn card after drawing and allows the player to keep it', () => {
    const s = position([[card('red', 2)], [card('yellow', 8)]])
    s.drawPile = [card('blue', 5)]
    const drawn = act(s, { type: 'draw', player: 0 })
    expect(drawn.currentPlayer).toBe(0)
    expect(playableCards(drawn).map((c) => c.id)).toEqual([card('blue', 5).id])
    expect(act(drawn, { type: 'draw', player: 0 })).toBe(drawn)
    expect(act(drawn, { type: 'pass', player: 0 }).currentPlayer).toBe(1)
    expect(play(drawn, card('blue', 5)).currentPlayer).toBe(1)
  })
  it('recycles discards while preserving the top card and unique IDs', () => {
    const s = position([[card('blue', 1)], [card('green', 2)]])
    s.drawPile = []
    s.discardPile = [card('yellow', 9), card('green', 8), card('red', 5)]
    const next = act(s, { type: 'draw', player: 0 }, seeded(1))
    expect(next.discardPile.map((c) => c.id)).toEqual([card('red', 5).id])
    expect(next.drawPile).toHaveLength(1)
    expect(next.players[0].hand).toHaveLength(2)
    expect(next.events.some((e) => e.kind === 'shuffle')).toBe(true)
  })
  it('lets a player call before playing a drawn card that brought their hand to two', () => {
    let s = position([[card('blue', 1)], [card('yellow', 8)]])
    s.drawPile = [card('red', 3)]
    s = act(s, { type: 'draw', player: 0 })
    expect(s.drawnCardId).toBe(card('red', 3).id)
    s = act(s, { type: 'call', player: 0 })
    s = play(s, card('red', 3))
    expect(s.players[0].called).toBe(true)
    expect(s.callWindow).toBe(null)
  })
  it('opens a deterministic call window, catches once and closes on the next accepted move', () => {
    let s = position([
      [card('red', 2), card('blue', 1)],
      [card('yellow', 8), card('red', 6)],
    ])
    s = play(s, card('red', 2))
    expect(s.callWindow).toBe(0)
    const caught = act(s, { type: 'catch', player: 1, target: 0 })
    expect(caught.players[0].hand).toHaveLength(3)
    expect(act(caught, { type: 'catch', player: 1, target: 0 })).toBe(caught)
    const called = act(s, { type: 'call', player: 0 })
    expect(called.players[0].called).toBe(true)
    expect(act(called, { type: 'catch', player: 1, target: 0 })).toBe(called)
    const continued = play(s, card('red', 6))
    expect(act(continued, { type: 'catch', player: 1, target: 0 })).toBe(continued)
  })
  it('supports pre-calling with two cards and does not win until the final card is played', () => {
    let s = position([[card('red', 2), card('blue', 1)], [card('yellow', 8)]])
    s = act(s, { type: 'call', player: 0 })
    s = play(s, card('red', 2))
    expect(s.players[0].called).toBe(true)
    expect(s.status).toBe('playing')
    expect(s.winner).toBe(null)
  })
  it('resolves a final penalty before scoring and freezes the finished round', () => {
    const s = position([[card('red', 'draw2')], [card('yellow', 8)]])
    const next = play(s, card('red', 'draw2'))
    expect(next.status).toBe('won')
    expect(next.winner).toBe(0)
    expect(next.players[1].hand).toHaveLength(3)
    expect(next.roundScore).toBe(next.players[1].hand.reduce((a, c) => a + cardPoints(c), 0))
    expect(act(next, { type: 'draw', player: 1 })).toBe(next)
  })
  it('optionally stacks matching penalties and accepts the accumulated draw', () => {
    let s = position([
      [card('red', 'draw2'), card('green', 0)],
      [card('blue', 'draw2'), card('blue', 1)],
      [card('yellow', 3)],
    ])
    s.rules.stacking = true
    s = play(s, card('red', 'draw2'))
    expect(s.pendingPenalty).toEqual({ count: 2, type: 'draw2' })
    expect(playableCards(s).map((c) => c.value)).toEqual(['draw2'])
    s = play(s, card('blue', 'draw2'))
    expect(s.pendingPenalty?.count).toBe(4)
    s = act(s, { type: 'draw', player: 2 })
    expect(s.players[2].hand).toHaveLength(5)
    expect(s.pendingPenalty).toBe(null)
    expect(s.currentPlayer).toBe(0)
  })
  it('configures draw-until-playable and immediate-play behavior centrally', () => {
    const s = position([[card('blue', 1)], [card('green', 2)]])
    s.rules.drawUntilPlayable = true
    s.drawPile = [card('red', 9), card('green', 8), card('yellow', 7)]
    const next = act(s, { type: 'draw', player: 0 })
    expect(next.players[0].hand).toHaveLength(4)
    expect(playableCards(next)[0].value).toBe(9)
    s.rules.playDrawnCard = false
    expect(act(s, { type: 'draw', player: 0 }).currentPlayer).toBe(1)
  })
  it('passes safely when every recyclable card is in a hand and declares a blocked draw', () => {
    let s = position([[card('blue', 1)], [card('green', 2)]])
    s.drawPile = []
    s = act(s, { type: 'draw', player: 0 })
    s = act(s, { type: 'draw', player: 1 })
    expect(s.status).toBe('draw')
    expect(s.winner).toBe(null)
  })
  it('finishes seeded AI rounds without illegal moves, hidden-card knowledge or card loss', () => {
    for (let seed = 1; seed <= 36; seed++) {
      const rng = seeded(seed)
      let s = createGame(
        Array.from({ length: 2 + (seed % 3) }, (_, i) => ({ name: `${i}`, kind: 'ai' })),
        { stacking: seed % 2 === 0 },
        rng,
      )
      let turns = 0
      while (s.status === 'playing' && turns++ < 3000) {
        const move = chooseMove(s, ['easy', 'medium', 'hard'][seed % 3] as 'easy' | 'medium' | 'hard', rng)
        const next = act(s, move, rng)
        expect(next).not.toBe(s)
        s = next
        if (s.callWindow !== null) s = act(s, { type: 'call', player: s.callWindow }, rng)
        const cards = [...s.drawPile, ...s.discardPile, ...s.players.flatMap((p) => p.hand)]
        expect(cards).toHaveLength(108)
        expect(new Set(cards.map((c) => c.id)).size).toBe(108)
      }
      expect(s.status).toBe('won')
      expect(s.players[s.winner!].hand).toHaveLength(0)
    }
  })
})
