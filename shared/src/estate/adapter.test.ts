import { describe, expect, it } from 'vitest'
import type { Ctx } from '../online/adapter'
import { estateAdapter } from './adapter'
import { gameReducer } from './engine'
import type { EstateOnlineAction } from './online'
import type { GameState, Trade } from './types'

const SEATS = ['p0', 'p1', 'p2']
const players = [
  { id: 'p0', name: 'Ann' },
  { id: 'p1', name: 'Ben' },
  { id: 'p2', name: 'Cai' },
]

/** A pinned stream, so the seed the table is built on is the same every run. */
function seeded(seed = 7) {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
}
const ctx = (random = seeded(), now = 1_700_000_000_000): Ctx => ({ random, now })

const start = (seats = players, options: unknown = {}, source = seeded()) =>
  estateAdapter.create(seats, options, ctx(source)) as GameState

/** A table arranged the way one test needs it. The engine is never faked. */
const position = (over: Partial<GameState> = {}, seats = players): GameState => ({
  ...start(seats),
  ...over,
})

const trade = (over: Partial<Trade> = {}): Trade => ({
  from: 0,
  to: 1,
  giveCash: 100,
  getCash: 0,
  giveProperties: [],
  getProperties: [],
  ...over,
})

/** `apply` succeeds or explains itself; tests that expect a move to land want the state. */
function act(state: GameState, seat: string, action: EstateOnlineAction, seats = SEATS) {
  const result = estateAdapter.apply(state, seat, seats, action, ctx())
  if ('error' in result) throw new Error(`unexpected ${result.error}: ${result.message}`)
  return result.state
}

/** …and tests that expect a refusal want the code. */
function refusal(state: GameState, seat: string, action: EstateOnlineAction, seats = SEATS) {
  const result = estateAdapter.apply(state, seat, seats, action, ctx())
  if (!('error' in result)) throw new Error(`expected a refusal, ${action.type} was allowed`)
  return result.error
}

/** The first three rolls a table produces — a fingerprint of the seed behind it. */
function opening(state: GameState): number[][] {
  const dice: number[][] = []
  let next = state
  for (let roll = 0; roll < 3; roll++) {
    next = settle(act(next, SEATS[next.current], { type: 'ROLL' }))
    dice.push(next.dice)
    // Put the table back in a state that can roll again, whatever it landed on.
    next = { ...next, phase: 'ready', debt: null, card: null }
  }
  return dice
}

/** Wind the game forward through whatever the server owes it. */
function settle(state: GameState): GameState {
  let next = state
  for (let beat = 0; beat < 4; beat++) {
    const pending = estateAdapter.pending(next)
    if (!pending) return next
    next = pending.resolve(next, ctx())
  }
  throw new Error('the table never came to rest')
}

describe('the estate adapter', () => {
  it('seats the players who turned up and starts them playing', () => {
    const state = start()
    expect(estateAdapter.seatIds(3)).toEqual(SEATS)
    expect(state.status).toBe('playing')
    expect(state.players.map((p) => p.name)).toEqual(['Ann', 'Ben', 'Cai'])
    // Online every seat is a person's; nothing at this table plays itself.
    expect(state.players.every((p) => !p.isBot)).toBe(true)
    expect(state.current).toBe(0)
    expect(state.phase).toBe('ready')
    expect(state.players.map((p) => p.cash)).toEqual([1500, 1500, 1500])
  })

  it('plays the quick economy when the room asks for it, and classic otherwise', () => {
    expect(estateAdapter.validateOptions({ mode: 'quick' })).toEqual({ mode: 'quick' })
    expect(estateAdapter.validateOptions({ mode: 'nonsense' })).toEqual({ mode: 'classic' })
    expect(estateAdapter.validateOptions(undefined)).toEqual({ mode: 'classic' })
    expect(estateAdapter.validateOptions('quick')).toEqual({ mode: 'classic' })
    expect(start(players, { mode: 'quick' }).players[0].cash).toBe(1000)
    expect(start(players, { mode: 'quick' }).mode).toBe('quick')
  })

  it('seeds the table from the server, and never the same way twice', () => {
    const source = seeded(99)
    const first = start(players, {}, source)
    const second = estateAdapter.rematch(first, players, {}, ctx(source)).state
    expect(first.seed).not.toBe(second.seed)
    expect(second.players.map((p) => p.name)).toEqual(['Ann', 'Ben', 'Cai'])
    expect(second.turn).toBe(1)
    expect(second.status).toBe('playing')
    // A rematch is a new city, not the same one replayed: the seed is the whole
    // future of the game, so a different one has to mean different dice.
    expect(opening(second)).not.toEqual(opening(first))
  })

  it('deals the same table twice from the same stream', () => {
    expect(start(players, {}, seeded(4)).seed).toBe(start(players, {}, seeded(4)).seed)
  })
})

describe('what estate puts on the wire', () => {
  /** A scan of the whole serialized view, not a walk of the fields we remembered. */
  const searchable = (value: unknown) => JSON.stringify(value)

  it('strips the seed for every seat, and for nobody in particular', () => {
    const state = position({ seed: 123456789 })
    for (const seat of [...SEATS, null]) {
      const view = estateAdapter.view(state, seat)
      expect(view.seed).toBe(0)
      expect(searchable(view)).not.toContain('123456789')
    }
  })

  it('leaves the rest of the table exactly as it is', () => {
    const state = settle(act(position(), 'p0', { type: 'ROLL' }))
    const view = estateAdapter.view(state, 'p1')
    expect(searchable(view)).toBe(searchable({ ...state, seed: 0 }))
    // And the room's own copy is untouched by having been looked at.
    expect(state.seed).not.toBe(0)
  })

  it('keeps the seed out of a view after every kind of turn', () => {
    // Played out by the engine's own bot so the table reaches states this test
    // would not have thought to build: cards, rents, jail, debts, purchases.
    let state = position({ seed: 987654321 })
    let seen = 0
    for (let decision = 0; decision < 60 && state.status === 'playing'; decision++) {
      const blocked = SEATS[state.trade ? state.trade.to : state.current]
      state = settle(estateAdapter.resolveAbsent(state, blocked, SEATS, ctx())!)
      seen++
      for (const viewer of [...SEATS, null]) {
        const view = estateAdapter.view(state, viewer)
        expect(view.seed).toBe(0)
        // The generator moves with every roll and every card, so the number this
        // looks for is whatever it happens to be right now.
        expect(searchable(view)).not.toContain(String(state.seed))
      }
    }
    expect(seen).toBeGreaterThan(20)
    expect(state.turn).toBeGreaterThan(1)
  })
})

describe('the estate wire whitelist', () => {
  it('refuses the actions the room paces for itself', () => {
    for (const type of ['DICE_SETTLED', 'MOVE_STEP', 'RESOLVE', 'START'])
      expect(estateAdapter.validateAction({ type })).toBeNull()
  })

  it('takes the decisions a person makes', () => {
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
    ])
      expect(estateAdapter.validateAction({ type })).toEqual({ type })
    expect(estateAdapter.validateAction({ type: 'BUILD', property: 1 })).toEqual({
      type: 'BUILD',
      property: 1,
    })
  })

  it('refuses anything that is not an action at all', () => {
    for (const raw of [null, undefined, 'ROLL', 42, [], {}, { type: 7 }, { type: 'NONSENSE' }])
      expect(estateAdapter.validateAction(raw)).toBeNull()
  })

  it('insists a managed property is a space on the board', () => {
    for (const property of [-1, 40, 1.5, '1', undefined, null])
      expect(estateAdapter.validateAction({ type: 'MORTGAGE', property })).toBeNull()
    expect(estateAdapter.validateAction({ type: 'MORTGAGE', property: 39 })).toEqual({
      type: 'MORTGAGE',
      property: 39,
    })
  })

  it('rebuilds an offer field by field, and drops what rode along with it', () => {
    const parsed = estateAdapter.validateAction({
      type: 'PROPOSE_TRADE',
      trade: { ...trade(), mischief: true, from: 1, to: 2 },
    })
    expect(parsed).toEqual({
      type: 'PROPOSE_TRADE',
      trade: { from: 1, to: 2, giveCash: 100, getCash: 0, giveProperties: [], getProperties: [] },
    })
    expect(Object.keys((parsed as { trade: Trade }).trade)).not.toContain('mischief')
  })

  it('refuses an offer that is not shaped like one', () => {
    const bad: unknown[] = [
      undefined,
      'a deal',
      { ...trade(), from: -1 },
      { ...trade(), to: 4 },
      { ...trade(), giveCash: -5 },
      { ...trade(), getCash: 1.5 },
      { ...trade(), giveProperties: 'all of them' },
      { ...trade(), getProperties: [40] },
      { ...trade(), giveProperties: [1, 'two'] },
    ]
    for (const candidate of bad)
      expect(estateAdapter.validateAction({ type: 'PROPOSE_TRADE', trade: candidate })).toBeNull()
  })
})

describe('an estate turn', () => {
  it('holds the roll, then walks the whole way on one deadline', () => {
    const rolled = act(position(), 'p0', { type: 'ROLL' })
    // The dice are cast but nothing has happened yet: the table is watching.
    expect(rolled.phase).toBe('rolling')
    expect(rolled.rollId).toBe(1)
    expect(rolled.players[0].position).toBe(0)

    const pending = estateAdapter.pending(rolled)!
    expect(pending).not.toBeNull()
    // Dice settle, then a square at a time, then a beat to land on it.
    const total = rolled.dice[0] + rolled.dice[1]
    expect(pending.afterMs).toBe(1200 + total * 215 + 330 + 300)

    const landed = pending.resolve(rolled, ctx())
    expect(landed.players[0].position).toBe(total)
    expect(landed.stepsRemaining).toBe(0)
    // It comes to rest on something a person has to decide.
    expect(['purchase', 'card', 'end', 'debt']).toContain(landed.phase)
    expect(estateAdapter.pending(landed)).toBeNull()
  })

  it('pays for passing GO on the way round, without stopping there', () => {
    const state = position({ players: position().players.map((p) => ({ ...p, position: 38 })) })
    const landed = settle(act(state, 'p0', { type: 'ROLL' }))
    expect(landed.players[0].position).toBeLessThan(38)
    expect(landed.players[0].cash).toBeGreaterThanOrEqual(1500)
    expect(landed.events.some((event) => event.text.includes('passed GO'))).toBe(true)
  })

  it('walks a card that moves you, once its reader has closed it', () => {
    const state = position({
      phase: 'card',
      current: 0,
      card: {
        title: 'Take a trip',
        text: 'Advance to Union Station.',
        deck: 'chance',
        effect: 'move',
        destination: 5,
      },
    })
    const acked = act(state, 'p0', { type: 'ACK_CARD' })
    expect(acked.phase).toBe('moving')
    const pending = estateAdapter.pending(acked)!
    expect(pending.afterMs).toBe(5 * 215 + 330 + 300)
    const landed = pending.resolve(acked, ctx())
    expect(landed.players[0].position).toBe(5)
    expect(landed.phase).toBe('purchase')
  })

  it('gives a roll that cannot move anyone no walking time at all', () => {
    const jailed = position({
      phase: 'ready',
      players: position().players.map((p, i) => (i === 0 ? { ...p, jailed: true, position: 10 } : p)),
    })
    const rolled = act(jailed, 'p0', { type: 'ROLL' })
    const steps = rolled.dice[0] === rolled.dice[1] ? rolled.dice[0] + rolled.dice[1] : 0
    expect(estateAdapter.pending(rolled)!.afterMs).toBe(1200 + steps * 215 + 330 + 300)
  })

  it('waits on nobody once the game is over', () => {
    const over = position({ status: 'finished', winner: 0 })
    expect(estateAdapter.isFinished(over)).toBe(true)
    expect(estateAdapter.pending(over)).toBeNull()
    expect(estateAdapter.waitingOn(over, SEATS)).toEqual([])
    expect(refusal(over, 'p0', { type: 'ROLL' })).toBe('NOT_PLAYING')
  })

  it('refuses a turn action from every seat but the one on turn', () => {
    const state = position()
    expect(refusal(state, 'p1', { type: 'ROLL' })).toBe('NOT_YOUR_TURN')
    expect(refusal(state, 'p2', { type: 'END_TURN' })).toBe('NOT_YOUR_TURN')
    expect(refusal(state, 'p3', { type: 'ROLL' })).toBe('NOT_ALLOWED')
    expect(estateAdapter.waitingOn(state, SEATS)).toEqual(['p0'])
  })

  it('refuses a turn action the game is not ready for', () => {
    expect(refusal(position({ phase: 'end' }), 'p0', { type: 'ROLL' })).toBe('ILLEGAL_MOVE')
    expect(refusal(position(), 'p0', { type: 'END_TURN' })).toBe('ILLEGAL_MOVE')
    expect(refusal(position(), 'p0', { type: 'BUY' })).toBe('ILLEGAL_MOVE')
    expect(refusal(position(), 'p0', { type: 'BUILD', property: 1 })).toBe('ILLEGAL_MOVE')
  })

  it('lets the player in debt settle it, and nobody else', () => {
    const indebted = position({
      current: 1,
      phase: 'debt',
      debt: { amount: 4000, creditor: 0, reason: 'Golden Row rent' },
    })
    // A debt belongs to the player on turn, which is who the table is waiting on.
    expect(estateAdapter.waitingOn(indebted, SEATS)).toEqual(['p1'])
    expect(refusal(indebted, 'p0', { type: 'BANKRUPT' })).toBe('NOT_YOUR_TURN')
    const settled = act(indebted, 'p1', { type: 'BANKRUPT' })
    expect(settled.players[1].bankrupt).toBe(true)
    expect(settled.status).toBe('playing')
  })

  it('ends the game when the last debt cannot be paid', () => {
    const two = players.slice(0, 2)
    const indebted = position(
      { current: 1, phase: 'debt', debt: { amount: 4000, creditor: 0, reason: 'Golden Row rent' } },
      two,
    )
    const over = act(indebted, 'p1', { type: 'BANKRUPT' }, ['p0', 'p1'])
    expect(over.status).toBe('finished')
    expect(over.winner).toBe(0)
    expect(estateAdapter.isFinished(over)).toBe(true)
    expect(estateAdapter.waitingOn(over, ['p0', 'p1'])).toEqual([])
  })
})

describe('an estate trade', () => {
  const offered = () => act(position(), 'p0', { type: 'PROPOSE_TRADE', trade: trade() })

  it('is made by the seat it says it is from, on that seat’s own turn', () => {
    expect(offered().trade).toEqual(trade())
    // Ben cannot put Ann's name on an offer…
    expect(refusal(position(), 'p1', { type: 'PROPOSE_TRADE', trade: trade() })).toBe('NOT_ALLOWED')
    // …nor make one of his own while it is Ann's turn.
    expect(refusal(position(), 'p1', { type: 'PROPOSE_TRADE', trade: trade({ from: 1, to: 0 }) })).toBe(
      'NOT_YOUR_TURN',
    )
  })

  it('is answered by the seat it was made to, off-turn', () => {
    const pending = offered()
    // The whole table is waiting on Ben, whose turn it is not.
    expect(estateAdapter.waitingOn(pending, SEATS)).toEqual(['p1'])
    const accepted = act(pending, 'p1', { type: 'ACCEPT_TRADE' })
    expect(accepted.trade).toBeNull()
    expect(accepted.players[0].cash).toBe(1400)
    expect(accepted.players[1].cash).toBe(1600)
    expect(accepted.current).toBe(0)
  })

  it('cannot be accepted by the seat that made it, nor by a bystander', () => {
    const pending = offered()
    expect(refusal(pending, 'p0', { type: 'ACCEPT_TRADE' })).toBe('NOT_ALLOWED')
    expect(refusal(pending, 'p2', { type: 'ACCEPT_TRADE' })).toBe('NOT_ALLOWED')
    // The engine does not check who is accepting, so this is the only thing
    // between a pending offer and a third party helping themselves to it.
    expect(gameReducer(pending, { type: 'ACCEPT_TRADE' }).trade).toBeNull()
  })

  it('is declined by either party, and by nobody else', () => {
    expect(act(offered(), 'p1', { type: 'REJECT_TRADE' }).trade).toBeNull()
    // The player who made it can think better of it.
    expect(act(offered(), 'p0', { type: 'REJECT_TRADE' }).trade).toBeNull()
    expect(refusal(offered(), 'p2', { type: 'REJECT_TRADE' })).toBe('NOT_ALLOWED')
  })

  it('freezes the rest of the game until it is answered', () => {
    const pending = offered()
    expect(refusal(pending, 'p0', { type: 'ROLL' })).toBe('NOT_ALLOWED')
    expect(refusal(pending, 'p0', { type: 'PROPOSE_TRADE', trade: trade({ to: 2 }) })).toBe('NOT_ALLOWED')
    expect(estateAdapter.pending(pending)).toBeNull()
  })

  it('refuses an answer when there is nothing to answer', () => {
    expect(refusal(position(), 'p1', { type: 'ACCEPT_TRADE' })).toBe('NOT_ALLOWED')
    expect(refusal(position(), 'p1', { type: 'REJECT_TRADE' })).toBe('NOT_ALLOWED')
  })

  it('refuses an offer the engine will not stand behind', () => {
    // Ann does not have $9,000, whatever the wire says.
    expect(refusal(position(), 'p0', { type: 'PROPOSE_TRADE', trade: trade({ giveCash: 9000 }) })).toBe(
      'ILLEGAL_MOVE',
    )
    // Nor a deed she does not own.
    expect(refusal(position(), 'p0', { type: 'PROPOSE_TRADE', trade: trade({ giveProperties: [1] }) })).toBe(
      'ILLEGAL_MOVE',
    )
  })
})

describe('standing in for an absent estate seat', () => {
  it('takes one decision at a time and never forfeits the game', () => {
    let state = position()
    // Ann has gone; the room plays her turn for her, a decision per call.
    state = estateAdapter.resolveAbsent(state, 'p0', SEATS, ctx())!
    expect(state.phase).toBe('rolling')
    state = settle(state)
    for (let decision = 0; decision < 6 && state.current === 0; decision++)
      state = estateAdapter.resolveAbsent(settle(state), 'p0', SEATS, ctx())!
    // The turn moved on, the game did not end, and nobody was awarded anything.
    expect(state.current).toBe(1)
    expect(state.status).toBe('playing')
    expect(state.players.every((p) => !p.bankrupt)).toBe(true)
  })

  it('leaves a seat with nothing outstanding exactly where it was', () => {
    const state = position()
    expect(estateAdapter.resolveAbsent(state, 'p1', SEATS, ctx())).toBe(state)
    expect(estateAdapter.resolveAbsent(state, 'p9', SEATS, ctx())).toBe(state)
    const over = position({ status: 'finished', winner: 0 })
    expect(estateAdapter.resolveAbsent(over, 'p0', SEATS, ctx())).toBe(over)
  })

  it('answers an offer made to a seat that has gone quiet', () => {
    // A gift: worth taking, so the stand-in takes it.
    const generous = act(position(), 'p0', { type: 'PROPOSE_TRADE', trade: trade({ giveCash: 500 }) })
    const accepted = estateAdapter.resolveAbsent(generous, 'p1', SEATS, ctx())!
    expect(accepted.trade).toBeNull()
    expect(accepted.players[1].cash).toBe(2000)

    // A demand: not worth taking, so it is declined rather than left standing.
    const greedy = act(position(), 'p0', {
      type: 'PROPOSE_TRADE',
      trade: trade({ giveCash: 0, getCash: 500 }),
    })
    const declined = estateAdapter.resolveAbsent(greedy, 'p1', SEATS, ctx())!
    expect(declined.trade).toBeNull()
    expect(declined.players[1].cash).toBe(1500)
    // The seat that made the offer has nothing to settle either way.
    expect(estateAdapter.resolveAbsent(greedy, 'p0', SEATS, ctx())).toBe(greedy)
  })

  it('plays a two-seat table the same as any other', () => {
    const two = ['p0', 'p1']
    let state = position({}, players.slice(0, 2))
    state = settle(estateAdapter.resolveAbsent(state, 'p0', two, ctx())!)
    expect(state.status).toBe('playing')
    expect(state.rollId).toBe(1)
  })
})

describe('bots', () => {
  const botCtx = { random: () => 0.5, now: 0 }
  const seats = ['p0', 'p1']
  const table = () =>
    estateAdapter.create(
      [
        { id: 'p0', name: 'Ann' },
        { id: 'p1', name: 'Cleo' },
      ],
      estateAdapter.validateOptions({}),
      botCtx,
    ) as GameState

  it('rolls for the bot whose turn it is', () => {
    const state = { ...table(), current: 1, phase: 'ready' as const }
    const after = estateAdapter.bots!.decide(state, 'p1', seats, 'standard', botCtx)
    expect(after).not.toBe(state)
  })

  it('answers a trade aimed at a bot even while another seat is thinking', () => {
    // p0 proposes to p1 while it is still p0's turn: the game is waiting on
    // the bot to answer, not on whoever's turn it nominally is.
    const state = { ...table(), current: 0, trade: trade() }
    const after = estateAdapter.bots!.decide(state, 'p1', seats, 'standard', botCtx)
    expect(after).not.toBe(state)
    // The offer is worth taking, so the bot accepts it and the trade clears.
    expect(after.trade).toBeNull()
    expect(after.players[0].cash).toBe(1400)
    expect(after.players[1].cash).toBe(1600)
  })

  it('has a single strength, since its bot has no difficulty to pick', () => {
    expect(estateAdapter.bots!.skills).toEqual(['standard'])
  })
})
