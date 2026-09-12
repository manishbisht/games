export const COLORS = ['red', 'blue', 'green', 'yellow'] as const
export type Color = (typeof COLORS)[number]
export type Effect = 'skip' | 'reverse' | 'draw2' | 'wild' | 'draw4'
export type Difficulty = 'easy' | 'medium' | 'hard'
export interface Card {
  id: string
  type: 'number' | 'action' | 'wild'
  color: Color | 'wild'
  value: number | Effect
  isWild: boolean
  visual: { symbol: string; label: string }
}
export interface Rules {
  handSize: number
  stacking: boolean
  playDrawnCard: boolean
  restrictDrawFour: boolean
  drawUntilPlayable: boolean
  callPenalty: number
  // Reserved rules are explicitly disabled until their full mechanics exist.
  jumpIn: false
  sevenZero: false
  initialDiscard: 'number'
  scoring: boolean
}
export interface Player {
  id: number
  name: string
  kind: 'human' | 'ai'
  hand: Card[]
  called: boolean
  totalScore: number
}
export interface GameEvent {
  id: number
  kind: 'info' | 'play' | 'draw' | 'shuffle' | 'effect' | 'call' | 'win'
  text: string
  player?: number
  card?: Card
  count?: number
}
export interface GameState {
  players: Player[]
  drawPile: Card[]
  discardPile: Card[]
  currentPlayer: number
  direction: 1 | -1
  activeColor: Color
  pendingPenalty: { count: number; type: 'draw2' | 'draw4' } | null
  drawnCardId: string | null
  callWindow: number | null
  preCalled: number | null
  status: 'playing' | 'won' | 'draw'
  winner: number | null
  round: number
  roundScore: number
  turn: number
  stalledTurns: number
  sequence: number
  events: GameEvent[]
  rules: Rules
}
export type Command =
  | { type: 'play'; player: number; cardId: string; color?: Color }
  | { type: 'draw'; player: number }
  | { type: 'pass'; player: number }
  | { type: 'call'; player: number }
  | { type: 'catch'; player: number; target: number }
export const COLOR_HEX = {
  red: '#e46051',
  blue: '#548cce',
  green: '#53a886',
  yellow: '#e9b849',
  wild: '#292f39',
}
export const EFFECT_NAMES: Record<Effect, string> = {
  skip: 'Pause',
  reverse: 'Turn',
  draw2: 'Take Two',
  wild: 'Color Shift',
  draw4: 'Take Four',
}
export const CLASSIC_RULES: Rules = {
  handSize: 7,
  stacking: false,
  playDrawnCard: true,
  restrictDrawFour: true,
  drawUntilPlayable: false,
  callPenalty: 2,
  jumpIn: false,
  sevenZero: false,
  initialDiscard: 'number',
  scoring: true,
}
