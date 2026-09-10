import { BOARD, CARDS, DEFAULT_PLAYERS, PLAYER_STYLES, groupSpaces, money } from './board'
import type { Debt, GameAction, GameState, PlayerConfig, Trade } from './types'

export function createGame(
  config: PlayerConfig[] = DEFAULT_PLAYERS,
  mode: GameState['mode'] = 'classic',
  seed = 104729,
): GameState {
  const safePlayers = config.length >= 2 && config.length <= 4 ? config : DEFAULT_PLAYERS
  return {
    version: 1,
    status: 'setup',
    players: safePlayers.map((p, id) => ({
      ...p,
      ...PLAYER_STYLES[id],
      id,
      name: p.name.trim().slice(0, 18) || `Player ${id + 1}`,
      cash: mode === 'quick' ? 1000 : 1500,
      position: 0,
      jailed: false,
      jailTurns: 0,
      bankrupt: false,
    })),
    current: 0,
    turn: 1,
    phase: 'ready',
    dice: [3, 5],
    rollId: 0,
    stepsRemaining: 0,
    doubles: 0,
    extraRoll: false,
    properties: {},
    events: [],
    eventId: 0,
    seed: seed >>> 0 || 1,
    mode,
    card: null,
    debt: null,
    trade: null,
    winner: null,
  }
}
function log(
  s: GameState,
  text: string,
  type: GameState['events'][number]['type'] = 'info',
  player = s.current,
) {
  s.events.unshift({ id: ++s.eventId, text, type, player })
  s.events = s.events.slice(0, 70)
}
function random(s: GameState) {
  s.seed = (Math.imul(s.seed, 1664525) + 1013904223) >>> 0
  return s.seed / 4294967296
}
export const ownedSpaces = (s: GameState, player: number) =>
  BOARD.filter((b) => s.properties[b.id]?.owner === player)
export const hasGroup = (s: GameState, id: number, player: number) =>
  groupSpaces(id).length > 0 && groupSpaces(id).every((b) => s.properties[b.id]?.owner === player)
export const rentMultiplier = (s: GameState) =>
  s.mode === 'quick' ? 1 + Math.floor(Math.max(0, s.turn - 10) / 5) : 1
export function rentFor(s: GameState, id: number, dice = s.dice[0] + s.dice[1]): number {
  const prop = s.properties[id],
    space = BOARD[id]
  if (!prop || prop.mortgaged || !space) return 0
  let rent = 0
  if (space.kind === 'railroad')
    rent = 25 * 2 ** (ownedSpaces(s, prop.owner).filter((b) => b.kind === 'railroad').length - 1)
  if (space.kind === 'utility')
    rent = dice * (ownedSpaces(s, prop.owner).filter((b) => b.kind === 'utility').length === 2 ? 10 : 4)
  if (space.kind === 'property')
    rent = (space.rents?.[prop.level] || 0) * (prop.level === 0 && hasGroup(s, id, prop.owner) ? 2 : 1)
  return rent * rentMultiplier(s)
}
export function netWorth(s: GameState, player: number) {
  return (
    s.players[player].cash +
    ownedSpaces(s, player).reduce(
      (sum, b) =>
        sum +
        (s.properties[b.id].mortgaged ? (b.price || 0) / 2 : b.price || 0) +
        s.properties[b.id].level * (b.buildCost || 0),
      0,
    )
  )
}
export function canBuild(s: GameState, id: number) {
  const prop = s.properties[id],
    space = BOARD[id]
  return Boolean(
    prop &&
    space?.kind === 'property' &&
    prop.owner === s.current &&
    prop.level < 5 &&
    hasGroup(s, id, s.current) &&
    !s.debt &&
    s.players[s.current].cash >= (space.buildCost || 0) &&
    groupSpaces(id).every(
      (b) => !s.properties[b.id]?.mortgaged && (s.properties[b.id]?.level || 0) >= prop.level,
    ),
  )
}
export function canMortgage(s: GameState, id: number) {
  const prop = s.properties[id]
  return Boolean(
    prop &&
    prop.owner === s.current &&
    !prop.mortgaged &&
    groupSpaces(id).every((b) => (s.properties[b.id]?.level || 0) === 0),
  )
}
export function canSellBuilding(s: GameState, id: number) {
  const prop = s.properties[id]
  return Boolean(
    prop &&
    prop.owner === s.current &&
    prop.level > 0 &&
    groupSpaces(id).every((b) => (s.properties[b.id]?.level || 0) <= prop.level),
  )
}
function jail(s: GameState) {
  const p = s.players[s.current]
  p.position = 10
  p.jailed = true
  p.jailTurns = 0
  s.extraRoll = false
  s.doubles = 0
  s.stepsRemaining = 0
  s.phase = 'end'
  log(s, `${p.name} went to jail. Pay $50 or roll doubles to leave.`, 'alert')
}
function pay(s: GameState, amount: number, creditor: number | null, reason: string) {
  const p = s.players[s.current]
  if (p.cash < amount) {
    s.debt = { amount, creditor, reason }
    s.phase = 'debt'
    log(
      s,
      `${p.name} needs ${money(amount - p.cash)} more for ${reason}. Sell buildings or mortgage property.`,
      'alert',
    )
    return
  }
  p.cash -= amount
  if (creditor !== null) s.players[creditor].cash += amount
  log(
    s,
    `${p.name} paid ${money(amount)} ${creditor !== null ? `to ${s.players[creditor].name}` : 'to the bank'} · ${reason}.`,
    'money',
  )
}
function settleDebt(s: GameState) {
  if (s.debt && s.players[s.current].cash >= s.debt.amount) {
    const d = s.debt
    s.debt = null
    s.phase = 'end'
    pay(s, d.amount, d.creditor, d.reason)
    if (d.reason === 'mandatory jail release') {
      s.players[s.current].jailed = false
      s.players[s.current].jailTurns = 0
      s.stepsRemaining = s.dice[0] + s.dice[1]
      s.phase = 'moving'
    }
  }
}
function land(s: GameState) {
  const p = s.players[s.current],
    b = BOARD[p.position]
  s.phase = 'end'
  log(s, `${p.name} landed on ${b.name}.`)
  if (b.price) {
    const prop = s.properties[b.id]
    if (!prop) {
      s.phase = 'purchase'
      log(s, `${b.name} is available for ${money(b.price)}.`)
    } else if (prop.owner !== p.id && !prop.mortgaged) {
      pay(s, rentFor(s, b.id), prop.owner, `${b.name} rent`)
    } else
      log(
        s,
        prop.owner === p.id
          ? `Welcome home. ${p.name} owns ${b.name}.`
          : `${b.name} is mortgaged. No rent is due.`,
      )
  } else if (b.kind === 'chance' || b.kind === 'chest') {
    const cards = CARDS.filter((c) => c.deck === b.kind)
    s.card = cards[Math.floor(random(s) * cards.length)]
    s.phase = 'card'
    log(s, `${p.name} drew a ${b.kind === 'chance' ? 'Chance' : 'Community Chest'} card.`)
  } else if (b.kind === 'tax') pay(s, b.amount || 0, null, b.name)
  else if (b.kind === 'go-to-jail') jail(s)
  else if (b.kind === 'parking') log(s, 'Free parking. Take a breath. Your money stays with you.')
  else if (b.kind === 'jail') log(s, `${p.name} is just visiting. No restrictions apply.`)
}
function mortgage(s: GameState, id: number) {
  s.properties[id].mortgaged = true
  const amount = (BOARD[id].price || 0) / 2
  s.players[s.current].cash += amount
  log(s, `${s.players[s.current].name} mortgaged ${BOARD[id].name} for ${money(amount)}.`, 'money')
}
function liquidate(s: GameState) {
  if (!s.debt) return
  const p = s.players[s.current]
  const owned = ownedSpaces(s, p.id)
  while (p.cash < s.debt.amount) {
    const b = owned.find((b) => canSellBuilding(s, b.id))
    if (!b) break
    s.properties[b.id].level--
    p.cash += (b.buildCost || 0) / 2
    log(s, `${p.name} sold a building on ${b.name} for ${money((b.buildCost || 0) / 2)}.`, 'money')
  }
  for (const b of owned) if (p.cash < s.debt.amount && canMortgage(s, b.id)) mortgage(s, b.id)
  settleDebt(s)
}
function bankrupt(s: GameState) {
  if (!s.debt) return
  liquidate(s)
  if (!s.debt) return
  const p = s.players[s.current],
    creditor = s.debt.creditor
  if (creditor !== null) s.players[creditor].cash += p.cash
  for (const b of ownedSpaces(s, p.id)) {
    if (creditor !== null) s.properties[b.id] = { ...s.properties[b.id], owner: creditor }
    else delete s.properties[b.id]
  }
  p.cash = 0
  p.bankrupt = true
  p.jailed = false
  s.debt = null
  s.extraRoll = false
  s.phase = 'end'
  log(
    s,
    `${p.name} declared bankruptcy.${creditor !== null ? ` Remaining assets go to ${s.players[creditor].name}.` : ' Properties return to the bank.'}`,
    'alert',
  )
  const active = s.players.filter((p) => !p.bankrupt)
  if (active.length === 1) {
    s.status = 'finished'
    s.winner = active[0].id
    log(s, `${active[0].name} owns the moment. We have a winner!`, 'purchase', active[0].id)
  }
}
export function validTrade(s: GameState, t: Trade) {
  if (t.from === t.to || t.from !== s.current || !s.players[t.from] || !s.players[t.to] || s.debt)
    return false
  if (s.players[t.from].bankrupt || s.players[t.to].bankrupt) return false
  if (![t.giveCash, t.getCash].every((c) => Number.isSafeInteger(c) && c >= 0)) return false
  if (s.players[t.from].cash < t.giveCash || s.players[t.to].cash < t.getCash) return false
  const validProperties = (ids: number[], owner: number) =>
    new Set(ids).size === ids.length &&
    ids.every(
      (id) =>
        BOARD[id] &&
        s.properties[id]?.owner === owner &&
        groupSpaces(id).every((b) => (s.properties[b.id]?.level || 0) === 0),
    )
  return (
    t.giveCash + t.getCash + t.giveProperties.length + t.getProperties.length > 0 &&
    validProperties(t.giveProperties, t.from) &&
    validProperties(t.getProperties, t.to)
  )
}
export function gameReducer(state: GameState, action: GameAction): GameState {
  if (action.type === 'START') {
    const s = createGame(action.players, action.mode, action.seed ?? Date.now())
    s.status = 'playing'
    log(s, `Welcome to Estate. Everyone starts with ${money(s.players[0].cash)}.`)
    log(s, `${s.players[0].name} goes first. Make your first move.`)
    return s
  }
  if (state.status !== 'playing') return state
  if (state.trade && !['ACCEPT_TRADE', 'REJECT_TRADE'].includes(action.type)) return state
  const s: GameState = structuredClone(state)
  const p = s.players[s.current]
  const canManage = ['ready', 'end', 'debt'].includes(s.phase) && !p.bankrupt
  switch (action.type) {
    case 'ROLL':
      if (s.phase !== 'ready' || p.bankrupt) return state
      s.dice = [Math.floor(random(s) * 6) + 1, Math.floor(random(s) * 6) + 1]
      s.rollId++
      s.phase = 'rolling'
      s.extraRoll = false
      break
    case 'DICE_SETTLED': {
      if (s.phase !== 'rolling') return state
      const doubles = s.dice[0] === s.dice[1],
        total = s.dice[0] + s.dice[1]
      log(s, `${p.name} rolled ${total}${doubles ? ' — doubles!' : '.'}`, 'roll')
      if (p.jailed) {
        p.jailTurns++
        if (doubles) {
          p.jailed = false
          p.jailTurns = 0
          log(s, `${p.name} rolled doubles and left jail.`)
        } else if (p.jailTurns >= 3) {
          s.phase = 'end'
          pay(s, 50, null, 'mandatory jail release')
          if (s.debt) break
          p.jailed = false
          p.jailTurns = 0
        } else {
          s.phase = 'end'
          log(s, `${p.name} stays in jail. ${3 - p.jailTurns} attempt(s) remaining.`)
          break
        }
      } else {
        s.doubles = doubles ? s.doubles + 1 : 0
        if (s.doubles >= 3) {
          jail(s)
          break
        }
        s.extraRoll = doubles
      }
      s.stepsRemaining = total
      s.phase = 'moving'
      break
    }
    case 'MOVE_STEP':
      if (s.phase !== 'moving' || s.stepsRemaining <= 0) return state
      p.position = (p.position + 1) % BOARD.length
      s.stepsRemaining--
      if (p.position === 0) {
        p.cash += 200
        log(s, `${p.name} passed GO. +$200!`, 'money')
      }
      break
    case 'RESOLVE':
      if (s.phase !== 'moving' || s.stepsRemaining > 0) return state
      land(s)
      break
    case 'BUY': {
      if (s.phase !== 'purchase') return state
      const b = BOARD[p.position]
      if (!b.price || s.properties[b.id] || p.cash < b.price) return state
      p.cash -= b.price
      s.properties[b.id] = { owner: p.id, level: 0, mortgaged: false }
      s.phase = 'end'
      log(s, `${p.name} bought ${b.name} for ${money(b.price)}.`, 'purchase')
      break
    }
    case 'PASS':
      if (s.phase !== 'purchase') return state
      s.phase = 'end'
      log(s, `${p.name} passed on ${BOARD[p.position].name}. It stays available.`)
      break
    case 'END_TURN': {
      if (s.phase !== 'end') return state
      if (s.extraRoll && !p.bankrupt) {
        s.phase = 'ready'
        s.extraRoll = false
        log(s, `${p.name} gets another roll for doubles.`)
        break
      }
      let next = s.current
      do {
        next = (next + 1) % s.players.length
        if (next === 0) s.turn++
      } while (s.players[next].bankrupt)
      s.current = next
      s.phase = 'ready'
      s.doubles = 0
      log(s, `It's ${s.players[next].name}'s turn.${s.players[next].jailed ? ' Currently in jail.' : ''}`)
      break
    }
    case 'ACK_CARD': {
      if (s.phase !== 'card' || !s.card) return state
      const card = s.card
      s.card = null
      s.phase = 'end'
      log(s, `${card.title}. ${card.text}`)
      if (card.effect === 'jail') jail(s)
      if (card.effect === 'money') {
        if ((card.amount || 0) >= 0) {
          p.cash += card.amount || 0
          log(s, `${p.name} received ${money(card.amount || 0)} from the bank.`, 'money')
        } else pay(s, -(card.amount || 0), null, card.title)
      }
      if (card.effect === 'move' && card.destination !== undefined) {
        s.stepsRemaining = (card.destination - p.position + 40) % 40 || 40
        s.phase = 'moving'
      }
      break
    }
    case 'PAY_JAIL':
      if (s.phase !== 'ready' || !p.jailed || p.cash < 50) return state
      pay(s, 50, null, 'jail release')
      p.jailed = false
      p.jailTurns = 0
      break
    case 'BUILD':
      if (!canManage || !canBuild(s, action.property)) return state
      p.cash -= BOARD[action.property].buildCost || 0
      s.properties[action.property].level++
      log(
        s,
        `${p.name} built ${s.properties[action.property].level === 5 ? 'a hotel' : 'a house'} on ${BOARD[action.property].name}.`,
        'purchase',
      )
      break
    case 'SELL_BUILDING':
      if (!canManage || !canSellBuilding(s, action.property)) return state
      s.properties[action.property].level--
      p.cash += (BOARD[action.property].buildCost || 0) / 2
      log(
        s,
        `${p.name} sold a building on ${BOARD[action.property].name} for ${money((BOARD[action.property].buildCost || 0) / 2)}.`,
        'money',
      )
      settleDebt(s)
      break
    case 'MORTGAGE':
      if (!canManage || !canMortgage(s, action.property)) return state
      mortgage(s, action.property)
      settleDebt(s)
      break
    case 'UNMORTGAGE': {
      const prop = s.properties[action.property],
        cost = Math.ceil((BOARD[action.property]?.price || 0) * 0.55)
      if (!canManage || s.debt || !prop || prop.owner !== p.id || !prop.mortgaged || p.cash < cost)
        return state
      prop.mortgaged = false
      p.cash -= cost
      log(s, `${p.name} unmortgaged ${BOARD[action.property].name} for ${money(cost)}.`, 'money')
      break
    }
    case 'LIQUIDATE':
      if (!s.debt) return state
      liquidate(s)
      break
    case 'BANKRUPT':
      if (!s.debt) return state
      bankrupt(s)
      break
    case 'PROPOSE_TRADE':
      if (!['ready', 'end'].includes(s.phase) || !validTrade(s, action.trade)) return state
      s.trade = action.trade
      log(s, `${p.name} proposed a trade to ${s.players[action.trade.to].name}.`)
      break
    case 'ACCEPT_TRADE': {
      const t = s.trade
      if (!t || !validTrade(s, t)) return state
      s.players[t.from].cash += t.getCash - t.giveCash
      s.players[t.to].cash += t.giveCash - t.getCash
      t.giveProperties.forEach((id) => {
        s.properties[id].owner = t.to
      })
      t.getProperties.forEach((id) => {
        s.properties[id].owner = t.from
      })
      s.trade = null
      log(
        s,
        `${s.players[t.to].name} accepted ${s.players[t.from].name}'s trade. Assets exchanged.`,
        'purchase',
      )
      break
    }
    case 'REJECT_TRADE':
      if (!s.trade) return state
      log(s, 'Trade declined. No assets were exchanged.')
      s.trade = null
      break
    default:
      return state
  }
  return s
}

export function botAction(s: GameState): GameAction | null {
  const p = s.players[s.current]
  if (!p.isBot || s.status !== 'playing' || s.trade) return null
  if (s.phase === 'ready') return { type: 'ROLL' }
  if (s.phase === 'purchase') return { type: p.cash >= (BOARD[p.position].price || 0) + 100 ? 'BUY' : 'PASS' }
  if (s.phase === 'card') return { type: 'ACK_CARD' }
  if (s.phase === 'debt') return { type: 'BANKRUPT' }
  if (s.phase === 'end') {
    const build = ownedSpaces(s, p.id).find((b) => canBuild(s, b.id) && p.cash >= (b.buildCost || 0) + 250)
    if (build) return { type: 'BUILD', property: build.id }
    const unmortgage = ownedSpaces(s, p.id).find(
      (b) => s.properties[b.id].mortgaged && p.cash > (b.price || 0) * 0.55 + 300,
    )
    if (unmortgage) return { type: 'UNMORTGAGE', property: unmortgage.id }
    return { type: 'END_TURN' }
  }
  return null
}
export function botAcceptsTrade(s: GameState, t: Trade) {
  const value = (ids: number[]) =>
    ids.reduce((sum, id) => sum + (BOARD[id].price || 0) * (s.properties[id].mortgaged ? 0.5 : 1.15), 0)
  return validTrade(s, t) && t.giveCash + value(t.giveProperties) >= t.getCash + value(t.getProperties)
}
export function debtCapacity(s: GameState, debt: Debt = s.debt!) {
  if (!debt) return 0
  return (
    s.players[s.current].cash +
    ownedSpaces(s, s.current).reduce(
      (sum, b) =>
        sum +
        (s.properties[b.id].mortgaged ? 0 : (b.price || 0) / 2) +
        (s.properties[b.id].level * (b.buildCost || 0)) / 2,
      0,
    )
  )
}
