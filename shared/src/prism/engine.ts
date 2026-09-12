import { CLASSIC_RULES, COLORS, EFFECT_NAMES } from './types'
import type { Card, Color, Command, Effect, GameEvent, GameState, Player, Rules } from './types'

export function createDeck(): Card[] {
  const cards: Card[] = []
  const add = (color: Card['color'], value: Card['value']) => {
    const isWild = color === 'wild'
    const symbol =
      typeof value === 'number'
        ? String(value)
        : { skip: '⊘', reverse: '⇄', draw2: '+2', wild: '✦', draw4: '+4' }[value]
    cards.push({
      id: `prism-${cards.length}`,
      color,
      value,
      isWild,
      type: isWild ? 'wild' : typeof value === 'number' ? 'number' : 'action',
      visual: { symbol, label: typeof value === 'number' ? String(value) : EFFECT_NAMES[value] },
    })
  }
  for (const color of COLORS) {
    add(color, 0)
    for (let value = 1; value <= 9; value++) {
      add(color, value)
      add(color, value)
    }
    for (const effect of ['skip', 'reverse', 'draw2'] as Effect[]) {
      add(color, effect)
      add(color, effect)
    }
  }
  for (let i = 0; i < 4; i++) {
    add('wild', 'wild')
    add('wild', 'draw4')
  }
  return cards
}
export function shuffle<T>(items: T[], random = Math.random): T[] {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}
export function cardName(card: Card) {
  return `${card.isWild ? '' : `${card.color[0].toUpperCase()}${card.color.slice(1)} `}${card.visual.label}`
}
export function cardPoints(card: Card) {
  return card.isWild ? 50 : typeof card.value === 'number' ? card.value : 20
}
export function nextPlayer(state: GameState, steps = 1) {
  return (state.currentPlayer + steps * state.direction + state.players.length * steps) % state.players.length
}
function log(state: GameState, kind: GameEvent['kind'], text: string, data: Partial<GameEvent> = {}) {
  state.events = [...state.events, { ...data, id: ++state.sequence, kind, text }].slice(-60)
}
export function createGame(
  seats: Pick<Player, 'name' | 'kind'>[],
  options: Partial<Rules> = {},
  random = Math.random,
  round = 1,
  totals: number[] = [],
): GameState {
  if (seats.length < 2 || seats.length > 4) throw new Error('Choose 2–4 players.')
  const rules = { ...CLASSIC_RULES, ...options }
  if (rules.jumpIn || rules.sevenZero) throw new Error('Jump-in and 7–0 are not supported in this ruleset.')
  if (!Number.isInteger(rules.handSize) || rules.handSize < 1 || rules.handSize > 20)
    throw new Error('Invalid starting hand size.')
  if (!Number.isInteger(rules.callPenalty) || rules.callPenalty < 0 || rules.callPenalty > 20)
    throw new Error('Invalid call penalty.')
  let drawPile = shuffle(createDeck(), random)
  const players: Player[] = seats.map((p, id) => ({
    ...p,
    name: p.name.trim().slice(0, 20) || `Player ${id + 1}`,
    id,
    hand: [],
    called: false,
    totalScore: totals[id] ?? 0,
  }))
  for (let i = 0; i < rules.handSize; i++) for (const player of players) player.hand.push(drawPile.pop()!)
  // Our opening rule is number-only. Specials remain in the complete shuffled deck.
  const index = drawPile.findIndex((c) => c.type === 'number')
  const [first] = drawPile.splice(index, 1)
  drawPile = shuffle(drawPile, random)
  const state: GameState = {
    players,
    drawPile,
    discardPile: [first],
    activeColor: first.color as Color,
    currentPlayer: 0,
    direction: 1,
    pendingPenalty: null,
    drawnCardId: null,
    callWindow: null,
    preCalled: null,
    status: 'playing',
    winner: null,
    round,
    roundScore: 0,
    turn: 1,
    stalledTurns: 0,
    sequence: 0,
    events: [],
    rules,
  }
  log(state, 'info', `Round ${round}. Seven cards. Endless possibilities.`)
  return state
}
function matches(state: GameState, card: Card, player: number): boolean {
  if (
    card.value === 'draw4' &&
    state.rules.restrictDrawFour &&
    state.players[player].hand.some((c) => !c.isWild && c.color === state.activeColor)
  )
    return false
  if (state.pendingPenalty) return state.rules.stacking && card.value === state.pendingPenalty.type
  return card.isWild || card.color === state.activeColor || card.value === state.discardPile.at(-1)!.value
}
export function playableCards(state: GameState, player = state.currentPlayer): Card[] {
  if (state.status !== 'playing' || player !== state.currentPlayer) return []
  return state.players[player].hand.filter(
    (c) => (!state.drawnCardId || c.id === state.drawnCardId) && matches(state, c, player),
  )
}
export function handView(state: GameState, player: number) {
  const legal = new Set(playableCards(state, player).map((c) => c.id))
  return state.players[player].hand.map((c) => ({ ...c, playable: legal.has(c.id) }))
}
function copy(state: GameState): GameState {
  return {
    ...state,
    players: state.players.map((p) => ({ ...p, hand: [...p.hand] })),
    drawPile: [...state.drawPile],
    discardPile: [...state.discardPile],
    rules: { ...state.rules },
    pendingPenalty: state.pendingPenalty && { ...state.pendingPenalty },
    events: [...state.events],
  }
}
function take(state: GameState, player: number, count: number, random: () => number): Card[] {
  const taken: Card[] = []
  for (let i = 0; i < count; i++) {
    if (!state.drawPile.length && state.discardPile.length > 1) {
      const top = state.discardPile.pop()!
      state.drawPile = shuffle(state.discardPile, random)
      state.discardPile = [top]
      log(state, 'shuffle', 'A fresh shuffle. The top card stays.')
    }
    const card = state.drawPile.pop()
    if (!card) break
    state.players[player].hand.push(card)
    taken.push(card)
  }
  if (taken.length) {
    state.players[player].called = false
    if (state.callWindow === player) state.callWindow = null
    log(
      state,
      'draw',
      `${state.players[player].name} drew ${taken.length} ${taken.length === 1 ? 'card' : 'cards'}.`,
      { player, count: taken.length },
    )
  }
  return taken
}
function advance(state: GameState, steps = 1) {
  state.currentPlayer = nextPlayer(state, steps)
  state.drawnCardId = null
  state.preCalled = null
  state.turn++
}
function closeCallWindow(state: GameState) {
  state.callWindow = null
}
function finish(state: GameState, winner: number) {
  state.status = 'won'
  state.winner = winner
  state.callWindow = null
  state.roundScore = state.rules.scoring
    ? state.players
        .filter((p) => p.id !== winner)
        .flatMap((p) => p.hand)
        .reduce((sum, c) => sum + cardPoints(c), 0)
    : 0
  state.players[winner].totalScore += state.roundScore
  log(state, 'win', `${state.players[winner].name} wins! +${state.roundScore} points.`, { player: winner })
}
export function act(state: GameState, command: Command, random = Math.random): GameState {
  if (state.status !== 'playing' || !state.players[command.player]) return state
  const player = state.players[command.player]
  if (command.type === 'call') {
    const pre = command.player === state.currentPlayer && player.hand.length === 2
    const now = state.callWindow === command.player && player.hand.length === 1
    if ((!pre && !now) || player.called || state.preCalled === command.player) return state
    const s = copy(state)
    if (pre) s.preCalled = command.player
    else {
      s.players[command.player].called = true
      s.callWindow = null
    }
    log(s, 'call', `${player.name} called Prism!`, { player: player.id })
    return s
  }
  if (command.type === 'catch') {
    if (
      command.target === command.player ||
      state.callWindow !== command.target ||
      !state.players[command.target] ||
      state.players[command.target].called
    )
      return state
    const s = copy(state)
    log(s, 'effect', `${player.name} caught ${s.players[command.target].name}! Take ${s.rules.callPenalty}.`)
    take(s, command.target, s.rules.callPenalty, random)
    s.callWindow = null
    return s
  }
  if (command.player !== state.currentPlayer) return state
  if (command.type === 'pass') {
    if (!state.drawnCardId) return state
    const s = copy(state)
    closeCallWindow(s)
    log(s, 'info', `${player.name} kept the card.`)
    advance(s)
    return s
  }
  if (command.type === 'draw') {
    if (state.drawnCardId) return state
    const s = copy(state)
    closeCallWindow(s)
    s.preCalled = null
    if (s.pendingPenalty) {
      take(s, player.id, s.pendingPenalty.count, random)
      s.pendingPenalty = null
      advance(s)
      return s
    }
    let drawn: Card | undefined
    let total = 0
    do {
      drawn = take(s, player.id, 1, random)[0]
      if (drawn) total++
    } while (drawn && s.rules.drawUntilPlayable && !matches(s, drawn, player.id))
    s.stalledTurns = total ? 0 : s.stalledTurns + 1
    if (drawn && s.rules.playDrawnCard && matches(s, drawn, player.id)) s.drawnCardId = drawn.id
    else {
      if (!total) log(s, 'info', `${player.name} passes. No cards available to draw.`)
      advance(s)
    }
    if (
      s.stalledTurns >= s.players.length &&
      s.players.every((p) => !p.hand.some((c) => matches(s, c, p.id)))
    ) {
      s.status = 'draw'
      log(s, 'info', 'The table is blocked. This round is a draw.')
    }
    return s
  }
  const card = playableCards(state).find((c) => c.id === command.cardId)
  if (!card || (card.isWild && (!command.color || !COLORS.includes(command.color)))) return state
  const s = copy(state)
  closeCallWindow(s)
  s.stalledTurns = 0
  s.players[player.id].hand = s.players[player.id].hand.filter((c) => c.id !== card.id)
  s.discardPile.push(card)
  s.activeColor = card.isWild ? command.color! : (card.color as Color)
  s.drawnCardId = null
  log(s, 'play', `${player.name} played ${cardName(card)}.`, { player: player.id, card })
  if (card.isWild) log(s, 'effect', `${player.name} chose ${s.activeColor}.`, { player: player.id })
  let steps = 1
  if (card.value === 'reverse') {
    s.direction = s.direction === 1 ? -1 : 1
    steps = s.players.length === 2 ? 2 : 1
    log(s, 'effect', `Direction reversed.${steps === 2 ? ` ${player.name} plays again.` : ''}`)
  } else if (card.value === 'skip') {
    log(s, 'effect', `${s.players[nextPlayer(s)].name} was paused.`, { player: nextPlayer(s) })
    steps = 2
  } else if (card.value === 'draw2' || card.value === 'draw4') {
    const count = (s.pendingPenalty?.count ?? 0) + (card.value === 'draw2' ? 2 : 4)
    const recipient = nextPlayer(s)
    log(
      s,
      'effect',
      `${card.value === 'draw4' ? 'Take Four' : 'Take Two'} — ${s.players[recipient].name} draws ${count}.`,
      { player: recipient },
    )
    // Final-card penalties settle immediately so scoring includes the actual resulting hands.
    if (s.rules.stacking && s.players[player.id].hand.length) s.pendingPenalty = { count, type: card.value }
    else {
      take(s, recipient, count, random)
      s.pendingPenalty = null
      steps = 2
    }
  }
  const remaining = s.players[player.id].hand.length
  if (remaining === 1) {
    s.players[player.id].called = s.preCalled === player.id
    s.callWindow = s.players[player.id].called ? null : player.id
    log(s, 'info', `${player.name} has 1 card left!`, { player: player.id })
  }
  if (remaining === 0) finish(s, player.id)
  else advance(s, steps)
  return s
}
