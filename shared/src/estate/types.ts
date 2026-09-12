export type SpaceKind =
  'go' | 'property' | 'railroad' | 'utility' | 'chance' | 'chest' | 'tax' | 'jail' | 'parking' | 'go-to-jail'
export interface BoardSpace {
  id: number
  name: string
  kind: SpaceKind
  color?: string
  group?: string
  price?: number
  rents?: number[]
  buildCost?: number
  amount?: number
}
export interface Player {
  id: number
  name: string
  color: string
  token: 'rocket' | 'gem' | 'car' | 'crown'
  cash: number
  position: number
  jailed: boolean
  jailTurns: number
  bankrupt: boolean
  isBot: boolean
}
export interface Property {
  owner: number
  level: number
  mortgaged: boolean
}
export type Phase = 'ready' | 'rolling' | 'moving' | 'purchase' | 'card' | 'debt' | 'end'
export interface Card {
  title: string
  text: string
  deck: 'chance' | 'chest'
  effect: 'money' | 'move' | 'jail'
  amount?: number
  destination?: number
}
export interface GameEvent {
  id: number
  text: string
  type: 'info' | 'money' | 'purchase' | 'alert' | 'roll'
  player?: number
}
export interface Debt {
  amount: number
  creditor: number | null
  reason: string
}
export interface Trade {
  from: number
  to: number
  giveCash: number
  getCash: number
  giveProperties: number[]
  getProperties: number[]
}
export interface GameState {
  version: 1
  status: 'setup' | 'playing' | 'finished'
  players: Player[]
  current: number
  turn: number
  phase: Phase
  dice: [number, number]
  rollId: number
  stepsRemaining: number
  doubles: number
  extraRoll: boolean
  properties: Record<number, Property>
  events: GameEvent[]
  eventId: number
  seed: number
  mode: 'classic' | 'quick'
  card: Card | null
  debt: Debt | null
  trade: Trade | null
  winner: number | null
}
export interface PlayerConfig {
  name: string
  isBot: boolean
}
export type GameAction =
  | { type: 'START'; players: PlayerConfig[]; mode: 'classic' | 'quick'; seed?: number }
  | {
      type:
        | 'ROLL'
        | 'DICE_SETTLED'
        | 'MOVE_STEP'
        | 'RESOLVE'
        | 'BUY'
        | 'PASS'
        | 'END_TURN'
        | 'ACK_CARD'
        | 'PAY_JAIL'
        | 'LIQUIDATE'
        | 'BANKRUPT'
        | 'ACCEPT_TRADE'
        | 'REJECT_TRADE'
    }
  | { type: 'BUILD' | 'SELL_BUILDING' | 'MORTGAGE' | 'UNMORTGAGE'; property: number }
  | { type: 'PROPOSE_TRADE'; trade: Trade }
