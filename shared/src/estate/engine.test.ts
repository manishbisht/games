import { describe, expect, it } from 'vitest'
import { BOARD, CARDS } from './board'
import { botAction, canBuild, canMortgage, createGame, gameReducer, rentFor, validTrade } from './engine'
import type { GameAction, GameState, Trade } from './types'

const players = [
  { name: 'Alex', isBot: false },
  { name: 'Sam', isBot: false },
]
function start(seed = 42) {
  return gameReducer(createGame(), { type: 'START', players, mode: 'classic', seed })
}
function landAt(s: GameState, id: number) {
  s = structuredClone(s)
  s.players[s.current].position = id
  s.phase = 'moving'
  s.stepsRemaining = 0
  return gameReducer(s, { type: 'RESOLVE' })
}
function own(s: GameState, id: number, owner = 0, level = 0) {
  s.properties[id] = { owner, level, mortgaged: false }
}
function advance(s: GameState) {
  let action: GameAction | null
  if (s.phase === 'rolling') action = { type: 'DICE_SETTLED' }
  else if (s.phase === 'moving') action = { type: s.stepsRemaining ? 'MOVE_STEP' : 'RESOLVE' }
  else action = botAction(s)
  if (!action) throw new Error(`No action for ${s.phase}`)
  return gameReducer(s, action)
}
describe('board and deterministic turns', () => {
  it('has a complete original 40-space board with correct indices', () => {
    expect(BOARD.map((b) => b.id)).toEqual(Array.from({ length: 40 }, (_, i) => i))
    expect(BOARD.filter((b) => b.price)).toHaveLength(28)
    expect(BOARD.filter((b) => b.kind === 'property')).toHaveLength(22)
  })
  it('starts 2–4 players at GO with the correct cash', () => {
    const s = start()
    expect(s.players).toHaveLength(2)
    expect(s.status).toBe('playing')
    expect(s.players.every((p) => p.position === 0 && p.cash === 1500)).toBe(true)
    expect(createGame(players, 'quick').players[0].cash).toBe(1000)
  })
  it('replays identical dice from the same seed without mutating input', () => {
    const s = start(),
      before = structuredClone(s)
    expect(gameReducer(s, { type: 'ROLL' })).toEqual(gameReducer(start(), { type: 'ROLL' }))
    expect(s).toEqual(before)
    const rolled = gameReducer(s, { type: 'ROLL' })
    expect(rolled.phase).toBe('rolling')
    expect(rolled.dice.every((d) => d >= 1 && d <= 6 && Number.isInteger(d))).toBe(true)
  })
  it('prevents double rolls, early movement, and early resolution', () => {
    let s = start()
    expect(gameReducer(s, { type: 'MOVE_STEP' })).toBe(s)
    s = gameReducer(s, { type: 'ROLL' })
    expect(gameReducer(s, { type: 'ROLL' })).toBe(s)
    s = gameReducer(s, { type: 'DICE_SETTLED' })
    expect(gameReducer(s, { type: 'RESOLVE' })).toBe(s)
  })
  it('moves one space at a time and awards $200 exactly once across GO', () => {
    let s = start()
    s.players[0].position = 38
    s.phase = 'moving'
    s.stepsRemaining = 3
    for (let i = 0; i < 3; i++) s = gameReducer(s, { type: 'MOVE_STEP' })
    expect(s.players[0].position).toBe(1)
    expect(s.players[0].cash).toBe(1700)
    expect(gameReducer(s, { type: 'MOVE_STEP' })).toBe(s)
  })
  it('gives another roll for doubles and sends three doubles to jail', () => {
    let s = start()
    s.phase = 'rolling'
    s.dice = [3, 3]
    s = gameReducer(s, { type: 'DICE_SETTLED' })
    expect(s.extraRoll).toBe(true)
    s.phase = 'end'
    s = gameReducer(s, { type: 'END_TURN' })
    expect(s.current).toBe(0)
    expect(s.phase).toBe('ready')
    s.doubles = 2
    s.phase = 'rolling'
    s = gameReducer(s, { type: 'DICE_SETTLED' })
    expect(s.players[0].jailed).toBe(true)
    expect(s.players[0].position).toBe(10)
    expect(s.extraRoll).toBe(false)
  })
  it('increments rounds and skips eliminated players', () => {
    let s = gameReducer(createGame(), {
      type: 'START',
      players: [...players, { name: 'Third', isBot: true }],
      mode: 'classic',
      seed: 1,
    })
    s.players[1].bankrupt = true
    s.phase = 'end'
    s = gameReducer(s, { type: 'END_TURN' })
    expect(s.current).toBe(2)
    s.phase = 'end'
    s = gameReducer(s, { type: 'END_TURN' })
    expect(s.current).toBe(0)
    expect(s.turn).toBe(2)
  })
})
describe('property, development and money', () => {
  it('buys only on the landing decision and rejects unaffordable purchases', () => {
    let s = landAt(start(), 39)
    expect(s.phase).toBe('purchase')
    s.players[0].cash = 399
    expect(gameReducer(s, { type: 'BUY' })).toBe(s)
    s.players[0].cash = 400
    s = gameReducer(s, { type: 'BUY' })
    expect(s.players[0].cash).toBe(0)
    expect(s.properties[39].owner).toBe(0)
    expect(s.phase).toBe('end')
    expect(gameReducer(s, { type: 'BUY' })).toBe(s)
  })
  it('passes a property without moving money or ownership', () => {
    const s = gameReducer(landAt(start(), 3), { type: 'PASS' })
    expect(s.properties[3]).toBeUndefined()
    expect(s.players[0].cash).toBe(1500)
    expect(s.phase).toBe('end')
  })
  it('transfers rent exactly and shows the reason', () => {
    let s = start()
    own(s, 39, 1)
    s = landAt(s, 39)
    expect(s.players.map((p) => p.cash)).toEqual([1450, 1550])
    expect(s.events[0].text).toContain('Crown Promenade rent')
  })
  it('calculates group, railroad, utility and mortgage rents', () => {
    const s = start()
    own(s, 1)
    own(s, 3)
    expect(rentFor(s, 1)).toBe(4)
    for (const id of [5, 15, 25, 35]) own(s, id)
    expect(rentFor(s, 5)).toBe(200)
    own(s, 12)
    expect(rentFor(s, 12, 7)).toBe(28)
    own(s, 28)
    expect(rentFor(s, 12, 7)).toBe(70)
    s.properties[12].mortgaged = true
    expect(rentFor(s, 12, 7)).toBe(0)
  })
  it('requires a full group, enough cash, and even building', () => {
    let s = start()
    own(s, 1)
    expect(canBuild(s, 1)).toBe(false)
    own(s, 3)
    s = gameReducer(s, { type: 'BUILD', property: 1 })
    expect(s.properties[1].level).toBe(1)
    expect(s.players[0].cash).toBe(1450)
    expect(canBuild(s, 1)).toBe(false)
    expect(canBuild(s, 3)).toBe(true)
    expect(canMortgage(s, 3)).toBe(false)
    s.properties[3].mortgaged = true
    expect(canBuild(s, 3)).toBe(false)
  })
  it('upgrades four houses to a hotel and sells buildings evenly', () => {
    let s = start()
    own(s, 1, 0, 4)
    own(s, 3, 0, 4)
    s = gameReducer(s, { type: 'BUILD', property: 1 })
    expect(s.properties[1].level).toBe(5)
    expect(rentFor(s, 1)).toBe(250)
    expect(gameReducer(s, { type: 'SELL_BUILDING', property: 3 })).toBe(s)
    s = gameReducer(s, { type: 'SELL_BUILDING', property: 1 })
    expect(s.properties[1].level).toBe(4)
    expect(s.players[0].cash).toBe(1475)
  })
  it('mortgages for half price and charges 55% to unmortgage', () => {
    let s = start()
    own(s, 3)
    s = gameReducer(s, { type: 'MORTGAGE', property: 3 })
    expect(s.players[0].cash).toBe(1530)
    expect(rentFor(s, 3)).toBe(0)
    s = gameReducer(s, { type: 'UNMORTGAGE', property: 3 })
    expect(s.players[0].cash).toBe(1497)
    expect(s.properties[3].mortgaged).toBe(false)
  })
  it('blocks property management for other players and during a roll', () => {
    const s = start()
    own(s, 1, 1)
    expect(gameReducer(s, { type: 'MORTGAGE', property: 1 })).toBe(s)
    own(s, 3)
    s.phase = 'rolling'
    expect(gameReducer(s, { type: 'MORTGAGE', property: 3 })).toBe(s)
  })
  it('charges tax and raises quick-game rent every five rounds from round 15', () => {
    expect(landAt(start(), 4).players[0].cash).toBe(1300)
    const s = start()
    own(s, 39, 1)
    s.mode = 'quick'
    s.turn = 15
    expect(rentFor(s, 39)).toBe(100)
    s.turn = 20
    expect(rentFor(s, 39)).toBe(150)
    s.turn = 25
    expect(rentFor(s, 39)).toBe(200)
  })
})
describe('jail and cards', () => {
  it('goes directly to jail without a GO bonus', () => {
    const s = landAt(start(), 30)
    expect(s.players[0].cash).toBe(1500)
    expect(s.players[0].position).toBe(10)
    expect(s.players[0].jailed).toBe(true)
    expect(landAt(start(), 10).players[0].jailed).toBe(false)
  })
  it('allows paid release, and release by doubles without an extra roll', () => {
    let s = start()
    s.players[0].jailed = true
    s.players[0].position = 10
    const paid = gameReducer(s, { type: 'PAY_JAIL' })
    expect(paid.players[0].cash).toBe(1450)
    expect(paid.players[0].jailed).toBe(false)
    s.phase = 'rolling'
    s.dice = [2, 2]
    s = gameReducer(s, { type: 'DICE_SETTLED' })
    expect(s.players[0].jailed).toBe(false)
    expect(s.extraRoll).toBe(false)
    expect(s.stepsRemaining).toBe(4)
  })
  it('stays in jail for failed rolls and requires payment after the third attempt', () => {
    let s = start()
    s.players[0].jailed = true
    s.phase = 'rolling'
    s.dice = [2, 3]
    s = gameReducer(s, { type: 'DICE_SETTLED' })
    expect(s.phase).toBe('end')
    expect(s.players[0].jailTurns).toBe(1)
    s.players[0].jailTurns = 2
    s.players[0].cash = 10
    s.phase = 'rolling'
    own(s, 3)
    s = gameReducer(s, { type: 'DICE_SETTLED' })
    expect(s.phase).toBe('debt')
    own(s, 1)
    s = gameReducer(s, { type: 'LIQUIDATE' })
    expect(s.debt).toBeNull()
    expect(s.phase).toBe('moving')
    expect(s.stepsRemaining).toBe(5)
    expect(s.players[0].jailed).toBe(false)
  })
  it('draws reproducible cards and applies payments only on acknowledgement', () => {
    let s = landAt(start(), 7)
    expect(s.phase).toBe('card')
    expect(s.card).toEqual(landAt(start(), 7).card)
    s.card = CARDS.find((c) => c.amount === 150)!
    s = gameReducer(s, { type: 'ACK_CARD' })
    expect(s.players[0].cash).toBe(1650)
    expect(s.card).toBeNull()
    expect(gameReducer(s, { type: 'ACK_CARD' })).toBe(s)
  })
  it('advances to GO for exactly $200 and resolves the destination', () => {
    let s = landAt(start(), 36)
    s.card = CARDS.find((c) => c.destination === 0)!
    s = gameReducer(s, { type: 'ACK_CARD' })
    expect(s.stepsRemaining).toBe(4)
    while (s.stepsRemaining) s = gameReducer(s, { type: 'MOVE_STEP' })
    s = gameReducer(s, { type: 'RESOLVE' })
    expect(s.players[0].cash).toBe(1700)
    expect(s.phase).toBe('end')
  })
})
describe('debt, bankruptcy, and trades', () => {
  it('preserves a doubles bonus when assets cover a debt', () => {
    let s = start()
    own(s, 39)
    s.players[0].cash = 0
    s.extraRoll = true
    s = landAt(s, 4)
    s = gameReducer(s, { type: 'LIQUIDATE' })
    expect(s.debt).toBeNull()
    s = gameReducer(s, { type: 'END_TURN' })
    expect(s.current).toBe(0)
    expect(s.phase).toBe('ready')
  })
  it('raises cash before paying a debt and does not prematurely eliminate a player', () => {
    let s = start()
    own(s, 39)
    s.players[0].cash = 10
    s = landAt(s, 4)
    expect(s.phase).toBe('debt')
    expect(s.players[0].cash).toBe(10)
    s = gameReducer(s, { type: 'BANKRUPT' })
    expect(s.players[0].bankrupt).toBe(false)
    expect(s.players[0].cash).toBe(10)
    expect(s.properties[39].mortgaged).toBe(true)
    expect(s.debt).toBeNull()
  })
  it('transfers remaining assets to a creditor and declares the last player winner', () => {
    let s = start()
    own(s, 1)
    own(s, 39, 1, 5)
    s.players[0].cash = 5
    s = landAt(s, 39)
    s = gameReducer(s, { type: 'BANKRUPT' })
    expect(s.players[0].bankrupt).toBe(true)
    expect(s.players[0].cash).toBe(0)
    expect(s.properties[1].owner).toBe(1)
    expect(s.players[1].cash).toBe(1535)
    expect(s.status).toBe('finished')
    expect(s.winner).toBe(1)
  })
  it('returns properties to the bank on tax bankruptcy', () => {
    let s = start()
    own(s, 1)
    s.players[0].cash = 0
    s = landAt(s, 4)
    s = gameReducer(s, { type: 'BANKRUPT' })
    expect(s.properties[1]).toBeUndefined()
  })
  it('requires a proposal and recipient confirmation to trade atomically', () => {
    let s = start()
    own(s, 1)
    own(s, 3, 1)
    const trade: Trade = {
      from: 0,
      to: 1,
      giveCash: 100,
      getCash: 0,
      giveProperties: [1],
      getProperties: [3],
    }
    s = gameReducer(s, { type: 'PROPOSE_TRADE', trade })
    expect(s.properties[1].owner).toBe(0)
    expect(s.players[0].cash).toBe(1500)
    expect(gameReducer(s, { type: 'ROLL' })).toBe(s)
    s = gameReducer(s, { type: 'ACCEPT_TRADE' })
    expect(s.properties[1].owner).toBe(1)
    expect(s.properties[3].owner).toBe(0)
    expect(s.players.map((p) => p.cash)).toEqual([1400, 1600])
    expect(s.trade).toBeNull()
  })
  it('rejects invalid, duplicate, unaffordable, and developed-property trades', () => {
    const s = start()
    own(s, 1)
    own(s, 3)
    const trade: Trade = { from: 0, to: 1, giveCash: 0, getCash: 0, giveProperties: [1], getProperties: [] }
    expect(validTrade(s, { ...trade, giveCash: -1 })).toBe(false)
    expect(validTrade(s, { ...trade, getCash: 1501 })).toBe(false)
    expect(validTrade(s, { ...trade, giveProperties: [1, 1] })).toBe(false)
    expect(validTrade(s, { ...trade, getProperties: [39] })).toBe(false)
    s.properties[3].level = 1
    expect(validTrade(s, trade)).toBe(false)
  })
  it('declines a trade without changing money or ownership', () => {
    const s = start()
    own(s, 1)
    const offered = gameReducer(s, {
      type: 'PROPOSE_TRADE',
      trade: { from: 0, to: 1, giveCash: 0, getCash: 100, giveProperties: [1], getProperties: [] },
    })
    const declined = gameReducer(offered, { type: 'REJECT_TRADE' })
    expect(declined.players).toEqual(s.players)
    expect(declined.properties).toEqual(s.properties)
  })
})
describe('complete games', () => {
  it.each([2, 3, 4])(
    'plays a full seeded %i-player game to a winner with valid financial state',
    (count) => {
      let s = gameReducer(createGame(), {
        type: 'START',
        players: Array.from({ length: count }, (_, i) => ({ name: `Bot ${i}`, isBot: true })),
        mode: 'quick',
        seed: 42,
      })
      for (let i = 0; i < 150000 && s.status !== 'finished'; i++) {
        const previous = s
        s = advance(s)
        expect(s).not.toBe(previous)
        expect(
          s.players.every(
            (p) => Number.isFinite(p.cash) && p.cash >= 0 && p.position >= 0 && p.position < 40,
          ),
        ).toBe(true)
        expect(
          Object.values(s.properties).every(
            (p) => !s.players[p.owner].bankrupt && p.level >= 0 && p.level <= 5,
          ),
        ).toBe(true)
      }
      expect(s.status).toBe('finished')
      expect(s.players.filter((p) => !p.bankrupt)).toHaveLength(1)
      expect(s.winner).not.toBeNull()
    },
    30000,
  )
})
