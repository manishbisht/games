import { Chess, DEFAULT_POSITION } from 'chess.js'
import type { Move } from 'chess.js'
import type { Color, GameOptions, GameState, MoveRecord, Piece, PromotionPiece, Square } from './types'

export const DEFAULT_OPTIONS: GameOptions = { mode: 'local', human: 'w', difficulty: 'medium', clock: 0 }

/** Replaying the recorded line preserves repetition counts; a FEN alone cannot. */
export function position(game: Pick<GameState, 'initialFen' | 'history'>): Chess {
  const chess = new Chess(game.initialFen)
  for (const move of game.history) chess.move({ from: move.from, to: move.to, promotion: move.promotion })
  return chess
}

function snapshot(game: GameState, chess: Chess): GameState {
  const turn = chess.turn()
  const check = chess.isCheck() ? chess.findPiece({ type: 'k', color: turn })[0] : null
  let status: GameState['status'] = 'playing'
  if (chess.isCheckmate()) status = 'checkmate'
  else if (chess.isStalemate()) status = 'stalemate'
  else if (chess.isInsufficientMaterial()) status = 'insufficient'
  else if (chess.isThreefoldRepetition()) status = 'repetition'
  else if (chess.isDrawByFiftyMoves()) status = 'fifty-move'
  return {
    ...game,
    fen: chess.fen(),
    turn,
    check,
    status,
    winner: status === 'checkmate' ? opposite(turn) : null,
    threats: check ? chess.attackers(check, opposite(turn)) : [],
    castling: { w: chess.getCastlingRights('w'), b: chess.getCastlingRights('b') },
    enPassant: chess.fen({ forceEnpassantSquare: true }).split(' ')[3],
  }
}

export function opposite(color: Color): Color {
  return color === 'w' ? 'b' : 'w'
}

export function createGame(
  options: Partial<GameOptions> = {},
  fen = DEFAULT_POSITION,
  now = Date.now(),
): GameState {
  const chess = new Chess(fen)
  const config = { ...DEFAULT_OPTIONS, ...options }
  return snapshot(
    {
      version: 1,
      initialFen: fen,
      fen,
      options: config,
      pieces: chess
        .board()
        .flat()
        .filter((p) => p !== null)
        .map((p) => ({ ...p, id: `${p.color}-${p.square}` })),
      turn: chess.turn(),
      history: [],
      captured: { w: [], b: [] },
      castling: { w: { k: false, q: false }, b: { k: false, q: false } },
      enPassant: '-',
      promotion: null,
      check: null,
      threats: [],
      status: 'playing',
      winner: null,
      clocks: { w: config.clock * 60000, b: config.clock * 60000 },
      clockAt: now,
    },
    chess,
  )
}

export function legalMoves(game: GameState, square?: Square): Move[] {
  if (game.status !== 'playing' || game.promotion) return []
  return position(game).moves({ verbose: true, ...(square ? { square } : {}) })
}

function canPossiblyMate(game: GameState, color: Color): boolean {
  const pieces = game.pieces.filter((p) => p.color === color && p.type !== 'k')
  if (!pieces.length) return false
  const opposition = game.pieces.filter((p) => p.color !== color && p.type !== 'k')
  if (pieces.length === 1 && ['b', 'n'].includes(pieces[0].type) && !opposition.length) return false
  // Only bishops on the same color complex can never create a mating position.
  const nonKings = [...pieces, ...opposition]
  if (nonKings.every((p) => p.type === 'b')) {
    const colors = new Set(nonKings.map((p) => (p.square.charCodeAt(0) + Number(p.square[1])) % 2))
    if (colors.size === 1) return false
  }
  return true
}

export function tickClock(game: GameState, now = Date.now()): GameState {
  if (!game.options.clock || game.status !== 'playing') return game
  const elapsed = Math.max(0, now - game.clockAt)
  if (!elapsed) return game
  const clocks = { ...game.clocks, [game.turn]: Math.max(0, game.clocks[game.turn] - elapsed) }
  if (clocks[game.turn] === 0)
    return {
      ...game,
      clocks,
      clockAt: now,
      promotion: null,
      status: 'timeout',
      winner: canPossiblyMate(game, opposite(game.turn)) ? opposite(game.turn) : null,
    }
  return { ...game, clocks, clockAt: now }
}

function movedPieces(pieces: Piece[], move: Move): Piece[] {
  const captureSquare = move.isEnPassant() ? `${move.to[0]}${move.from[1]}` : move.to
  return pieces
    .filter((p) => !(p.square === captureSquare && p.color !== move.color))
    .map((p) => {
      if (p.square === move.from) return { ...p, square: move.to, type: move.promotion || p.type }
      if (move.isKingsideCastle() && p.square === `h${move.from[1]}`)
        return { ...p, square: `f${move.from[1]}` as Square }
      if (move.isQueensideCastle() && p.square === `a${move.from[1]}`)
        return { ...p, square: `d${move.from[1]}` as Square }
      return p
    })
}

export function playMove(
  game: GameState,
  from: string,
  to: string,
  promotion?: PromotionPiece,
  now = Date.now(),
): GameState {
  if (game.status !== 'playing' || game.promotion) return game
  const chess = position(game)
  const candidates = chess.moves({ verbose: true }).filter((m) => m.from === from && m.to === to)
  if (!candidates.length || (promotion && !candidates.some((m) => m.promotion === promotion))) return game
  const timed = tickClock(game, now)
  if (timed.status !== 'playing') return timed
  if (candidates.some((m) => m.promotion) && !promotion) {
    return { ...timed, promotion: { from: from as Square, to: to as Square, color: timed.turn } }
  }
  const move = chess.move({ from, to, promotion })
  const record: MoveRecord = {
    from: move.from,
    to: move.to,
    color: move.color,
    piece: move.piece,
    san: move.san,
    flags: move.flags,
    captured: move.captured,
    promotion: move.promotion,
    before: move.before,
    after: move.after,
    clocksBefore: { ...timed.clocks },
  }
  return snapshot(
    {
      ...timed,
      promotion: null,
      clockAt: now,
      pieces: movedPieces(game.pieces, move),
      history: [...game.history, record],
      captured: move.captured
        ? { ...game.captured, [move.color]: [...game.captured[move.color], move.captured] }
        : game.captured,
    },
    chess,
  )
}

export function promote(game: GameState, piece: PromotionPiece, now = Date.now()): GameState {
  if (!game.promotion || game.status !== 'playing') return game
  return playMove({ ...game, promotion: null }, game.promotion.from, game.promotion.to, piece, now)
}

export function undoMove(game: GameState, now = Date.now()): GameState {
  if (game.promotion) return { ...game, promotion: null }
  const last = game.history.at(-1)
  if (!last) return game
  let previous = createGame({ ...game.options, clock: 0 }, game.initialFen, now)
  for (const move of game.history.slice(0, -1))
    previous = playMove(previous, move.from, move.to, move.promotion as PromotionPiece | undefined, now)
  return {
    ...previous,
    options: game.options,
    history: game.history.slice(0, -1),
    clocks: { ...last.clocksBefore },
    clockAt: now,
  }
}

export function resign(game: GameState, now = Date.now(), color = game.turn): GameState {
  const timed = tickClock(game, now)
  return timed.status === 'playing'
    ? { ...timed, status: 'resigned', winner: opposite(color), promotion: null }
    : timed
}

export function agreeDraw(game: GameState, now = Date.now()): GameState {
  const timed = tickClock(game, now)
  return timed.status === 'playing' && game.options.mode === 'local'
    ? { ...timed, status: 'agreement', winner: null, promotion: null }
    : timed
}

/** Stored state is untrusted: replay every move, then accept only validated metadata. */
export function restoreGame(raw: string | null): GameState | null {
  if (!raw) return null
  try {
    const data = JSON.parse(raw)
    if (data.version !== 1 || !Array.isArray(data.history) || data.history.length > 2000) return null
    const o = data.options
    if (
      !o ||
      !['local', 'ai'].includes(o.mode) ||
      !['w', 'b'].includes(o.human) ||
      !['easy', 'medium', 'hard'].includes(o.difficulty) ||
      ![0, 10].includes(o.clock)
    )
      return null
    const validClocks = (value: Record<string, unknown>) =>
      value &&
      ['w', 'b'].every(
        (c) =>
          typeof value[c] === 'number' &&
          Number.isFinite(value[c]) &&
          Number(value[c]) >= 0 &&
          Number(value[c]) <= 600000,
      )
    if (!validClocks(data.clocks) || !Number.isFinite(data.clockAt) || data.clockAt < 0) return null
    let game = createGame({ ...o, clock: 0 }, data.initialFen)
    for (const m of data.history) {
      if (!validClocks(m.clocksBefore)) return null
      const next = playMove(game, m.from, m.to, m.promotion)
      if (next.history.length !== game.history.length + 1) return null
      next.history[next.history.length - 1].clocksBefore = { ...m.clocksBefore }
      game = next
    }
    if (game.fen !== data.fen) return null
    game = { ...game, options: o, clocks: { ...data.clocks }, clockAt: data.clockAt }
    if (game.status === 'playing' && ['resigned', 'timeout', 'agreement'].includes(data.status)) {
      if (data.status === 'resigned')
        game = { ...game, status: 'resigned', winner: opposite(o.mode === 'ai' ? o.human : game.turn) }
      if (data.status === 'agreement' && o.mode === 'local')
        game = { ...game, status: 'agreement', winner: null }
      if (data.status === 'timeout' && game.clocks[game.turn] === 0)
        game = {
          ...game,
          status: 'timeout',
          winner: canPossiblyMate(game, opposite(game.turn)) ? opposite(game.turn) : null,
        }
    }
    if (data.promotion && game.status === 'playing') {
      const pending = playMove(
        { ...game, options: { ...o, clock: 0 } },
        data.promotion.from,
        data.promotion.to,
      )
      if (pending.promotion) game = { ...game, promotion: pending.promotion }
    }
    return tickClock(game)
  } catch {
    return null
  }
}
