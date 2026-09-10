export type PlayerId = 'red' | 'blue' | 'green' | 'yellow'
export type Control = 'human' | 'easy' | 'medium' | 'hard'
export type Mode = 'classic' | 'quick' | 'custom'
export interface Rules {
  piecesPerPlayer: number
  extraTurnOnSix: boolean
  safeSpaces: boolean
  captures: boolean
  exactHome: boolean
}
export interface Player {
  id: PlayerId
  name: string
  color: string
  control: Control
  stats: { rolls: number; moves: number; captures: number; sixes: number }
}
export interface Piece {
  id: string
  playerId: PlayerId
  index: number
  progress: number
}
export interface LegalMove {
  pieceId: string
  from: number
  to: number
  captures: string[]
}
export interface Motion extends LegalMove {
  steps: number[]
  capturedPieces: Piece[]
}
export type EventKind = 'start' | 'roll' | 'enter' | 'move' | 'capture' | 'home' | 'skip' | 'win'
export interface GameEvent {
  id: number
  playerId: PlayerId
  message: string
  kind: EventKind
  turn: number
}
export interface GameState {
  players: Player[]
  pieces: Piece[]
  rules: Rules
  mode: Mode
  currentPlayer: number
  turn: number
  dice: number | null
  lastDice: number | null
  phase: 'roll' | 'rolling' | 'choose' | 'moving' | 'pass' | 'won'
  legalMoves: LegalMove[]
  motion: Motion | null
  winner: PlayerId | null
  events: GameEvent[]
  eventSequence: number
}
export interface GameConfig {
  playerCount?: number
  mode?: Mode
  controls?: Control[]
  names?: string[]
  rules?: Partial<Rules>
}
export type Action =
  | { type: 'ROLL_START' }
  | { type: 'ROLL_RESULT'; value: number }
  | { type: 'MOVE'; pieceId: string }
  | { type: 'ANIMATION_DONE' }
  | { type: 'NEXT_TURN' }
  | { type: 'NEW_GAME'; config: GameConfig }
