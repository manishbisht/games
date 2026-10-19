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
  /** Minutes on each side's clock; 0 plays untimed. */
  clock: number
  /** Seconds added to a side's clock after each of its moves (Fischer increment). */
  increment?: number
}
/**
 * The clocks an online room can be made with, as the id the create call sends
 * (`options.timeControl`). A short list on purpose: one untimed, two blitz,
 * two rapid — enough to choose a pace, too few to deliberate over.
 */
export const TIME_CONTROLS = [
  { id: 'none', minutes: 0, increment: 0, label: 'No clock' },
  { id: '3+2', minutes: 3, increment: 2, label: 'Blitz' },
  { id: '5+0', minutes: 5, increment: 0, label: 'Blitz' },
  { id: '10+0', minutes: 10, increment: 0, label: 'Rapid' },
  { id: '15+10', minutes: 15, increment: 10, label: 'Rapid' },
] as const
export type TimeControlId = (typeof TIME_CONTROLS)[number]['id']
/** Under this much time a clock reads as running low. */
export const LOW_TIME_MS = 20000
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
  /** Each side's time left as of `clockAt`; the side to move has been spending since. */
  clocks: Record<Color, number>
  clockAt: number
  /**
   * Online only: the colours the room plays with a bot, learned from the bot's
   * own first move. A bot's turn is never put on the room's flag timer — see
   * `pending` in ./adapter.
   */
  bots?: Color[]
}
/** What one seat may ask the online game to do; see `./adapter`. */
export type ChessAction =
  { kind: 'move'; from: string; to: string; promotion?: PromotionPiece } | { kind: 'resign' }
export interface Preferences {
  sound: boolean
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
