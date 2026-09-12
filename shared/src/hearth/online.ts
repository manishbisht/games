/**
 * The only two decisions a seat makes over the wire. Everything else a turn is
 * made of — the die landing, a piece walking its steps, the turn passing on —
 * is a timed beat the server paces for the whole table (see `./adapter`).
 */
export type HearthOnlineAction =
  | { kind: 'roll' }
  /** A `Piece['id']`, validated against the state's `legalMoves` by the adapter. */
  | { kind: 'move'; pieceId: string }
