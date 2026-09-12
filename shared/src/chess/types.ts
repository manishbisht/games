import type { Color, PieceSymbol, Square } from 'chess.js'
export type { Color, PieceSymbol, Square }
export type PromotionPiece = 'q' | 'r' | 'b' | 'n'
export type Difficulty = 'easy' | 'medium' | 'hard'
export type GameStatus =
  | 'playing'
  | 'checkmate'
  | 'stalemate'
  | 'repetition'
  | 'fifty-move'
  | 'insufficient'
  | 'resigned'
  | 'timeout'
  | 'agreement'
export interface GameOptions {
  mode: 'local' | 'ai' | 'online'
  human: Color
  difficulty: Difficulty
  clock: 0 | 10
}
export interface Piece {
  id: string
  square: Square
  type: PieceSymbol
  color: Color
}
export interface MoveRecord {
  from: Square
  to: Square
  color: Color
  piece: PieceSymbol
  san: string
  flags: string
  captured?: PieceSymbol
  promotion?: PieceSymbol
  before: string
  after: string
  clocksBefore: Record<Color, number>
}
export interface GameState {
  version: 1
  initialFen: string
  fen: string
  options: GameOptions
  pieces: Piece[]
  turn: Color
  history: MoveRecord[]
  captured: Record<Color, PieceSymbol[]>
  castling: Record<Color, { k: boolean; q: boolean }>
  enPassant: string
  promotion: { from: Square; to: Square; color: Color } | null
  check: Square | null
  threats: Square[]
  status: GameStatus
  winner: Color | null
  clocks: Record<Color, number>
  clockAt: number
}
export interface Preferences {
  sound: boolean
  reducedMotion: boolean
  highContrast: boolean
  theme: 'walnut' | 'marble'
}
export const COLOR_NAMES: Record<Color, string> = { w: 'White', b: 'Black' }
export const PIECE_NAMES: Record<PieceSymbol, string> = {
  p: 'Pawn',
  r: 'Rook',
  n: 'Knight',
  b: 'Bishop',
  q: 'Queen',
  k: 'King',
}
export const GLYPHS: Record<Color, Record<PieceSymbol, string>> = {
  w: { k: '♔', q: '♕', r: '♖', b: '♗', n: '♘', p: '♙' },
  b: { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' },
}
