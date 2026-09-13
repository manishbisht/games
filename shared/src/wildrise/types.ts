export type PlayerId = 'red' | 'blue' | 'green' | 'yellow'
export type Control = 'human' | 'casual' | 'fast' | 'fun'
export interface Player {
  id: PlayerId
  name: string
  control: Control
  position: number
  turns: number
  climbs: number
  slides: number
}
export interface Route {
  from: number
  to: number
  color: string
}
export interface Rules {
  exactFinish: boolean
  extraTurnOnSix: boolean
  allowSharedSquares: boolean
  startingPosition: 0 | 1
  snakeCount: number
  ladderCount: number
}
export interface GameConfig {
  playerCount?: number
  names?: string[]
  controls?: Control[]
  firstPlayer?: number
  rules?: Partial<Rules>
}
/**
 * A move in flight. One beat covers the whole thing, so `path` is the route and
 * how far along it the token has got is the renderer's to work out from its own
 * clock — nothing here is an animation cursor, which is what lets a server
 * broadcast this state without also broadcasting a frame number.
 */
export interface Motion {
  kind: 'walk' | 'snake' | 'ladder'
  from: number
  to: number
  path: number[]
}
export interface GameEvent {
  id: number
  kind: 'start' | 'roll' | 'move' | 'snake' | 'ladder' | 'wait' | 'win'
  message: string
  playerId: PlayerId
  turn: number
}
export interface GameState {
  players: Player[]
  rules: Rules
  board: { spaces: number[]; snakes: Route[]; ladders: Route[] }
  currentPlayer: number
  turn: number
  dice: number | null
  phase: 'ready' | 'rolling' | 'moving' | 'transporting' | 'settling' | 'won'
  motion: Motion | null
  winner: PlayerId | null
  events: GameEvent[]
  eventSequence: number
}
export type Action =
  | { type: 'ROLL'; value: number }
  | { type: 'DICE_SETTLED' }
  | { type: 'MOVE_DONE' }
  | { type: 'TRANSPORT_DONE' }
  | { type: 'NEXT_TURN' }
