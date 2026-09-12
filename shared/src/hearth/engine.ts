import { absoluteSpace, HOME, PALETTES, PLAYER_IDS, SAFE_SPACES, TRACK_LENGTH } from './board'
import type { Action, EventKind, GameConfig, GameState, LegalMove, Piece, PlayerId } from './types'

export function createGame(config: GameConfig = {}): GameState {
  const count = Math.max(2, Math.min(4, Math.trunc(config.playerCount || 4)))
  const rules = {
    extraTurnOnSix: true,
    safeSpaces: true,
    captures: true,
    exactHome: true,
    ...config.rules,
    piecesPerPlayer: Math.max(
      1,
      Math.min(4, Math.trunc(config.rules?.piecesPerPlayer || (config.mode === 'quick' ? 2 : 4))),
    ),
  }
  const players = PLAYER_IDS.slice(0, count).map((id, index) => ({
    id,
    name: config.names?.[index]?.trim().slice(0, 20) || PALETTES[id].name,
    color: PALETTES[id].color,
    control: config.controls?.[index] || ('human' as const),
    stats: { rolls: 0, moves: 0, captures: 0, sixes: 0 },
  }))
  return {
    players,
    rules,
    mode: config.mode || 'classic',
    pieces: players.flatMap((player) =>
      Array.from({ length: rules.piecesPerPlayer }, (_, index) => ({
        id: `${player.id}-${index}`,
        playerId: player.id,
        index,
        progress: -1,
      })),
    ),
    currentPlayer: 0,
    turn: 1,
    dice: null,
    lastDice: null,
    phase: 'roll',
    legalMoves: [],
    motion: null,
    winner: null,
    eventSequence: 1,
    events: [
      { id: 1, playerId: 'red', message: 'A new journey begins. Red rolls first.', kind: 'start', turn: 1 },
    ],
  }
}

function capturedAt(state: GameState, piece: Piece, progress: number): string[] {
  if (!state.rules.captures || progress >= TRACK_LENGTH) return []
  const destination = absoluteSpace({ ...piece, progress })!
  if (state.rules.safeSpaces && SAFE_SPACES.has(destination)) return []
  return state.pieces
    .filter((other) => other.playerId !== piece.playerId && absoluteSpace(other) === destination)
    .map((p) => p.id)
}

export function getLegalMoves(state: GameState, dice: number): LegalMove[] {
  if (state.winner || !Number.isInteger(dice) || dice < 1 || dice > 6) return []
  const player = state.players[state.currentPlayer]
  return state.pieces
    .filter((p) => p.playerId === player.id)
    .flatMap((piece) => {
      if (piece.progress === HOME || (piece.progress < 0 && dice !== 6)) return []
      let to = piece.progress < 0 ? 0 : piece.progress + dice
      if (to > HOME) {
        if (state.rules.exactHome) return []
        to = HOME
      }
      return [{ pieceId: piece.id, from: piece.progress, to, captures: capturedAt(state, piece, to) }]
    })
}

function event(
  state: GameState,
  kind: EventKind,
  message: string,
  playerId = state.players[state.currentPlayer].id,
): GameState {
  const id = state.eventSequence + 1
  return {
    ...state,
    eventSequence: id,
    events: [{ id, kind, message, playerId, turn: state.turn }, ...state.events].slice(0, 40),
  }
}

function advanceTurn(state: GameState): GameState {
  const extra = state.dice === 6 && state.rules.extraTurnOnSix
  return {
    ...state,
    currentPlayer: extra ? state.currentPlayer : (state.currentPlayer + 1) % state.players.length,
    turn: state.turn + 1,
    dice: null,
    phase: 'roll',
    legalMoves: [],
    motion: null,
  }
}

export function gameReducer(state: GameState, action: Action): GameState {
  if (action.type === 'NEW_GAME') return createGame(action.config)
  if (state.phase === 'won') return state
  const player = state.players[state.currentPlayer]
  switch (action.type) {
    case 'ROLL_START':
      return state.phase === 'roll' ? { ...state, phase: 'rolling', dice: null } : state
    case 'ROLL_RESULT': {
      if (
        state.phase !== 'rolling' ||
        !Number.isInteger(action.value) ||
        action.value < 1 ||
        action.value > 6
      )
        return state
      const dice = action.value,
        legalMoves = getLegalMoves(state, dice)
      let next: GameState = {
        ...state,
        dice,
        lastDice: dice,
        legalMoves,
        phase: legalMoves.length ? 'choose' : 'pass',
        players: state.players.map((p) =>
          p.id !== player.id
            ? p
            : {
                ...p,
                stats: { ...p.stats, rolls: p.stats.rolls + 1, sixes: p.stats.sixes + (dice === 6 ? 1 : 0) },
              },
        ),
      }
      next = event(
        next,
        'roll',
        `${player.name} rolled a ${dice}.${dice === 6 && state.rules.extraTurnOnSix ? ' Bonus roll!' : ''}`,
      )
      if (!legalMoves.length) {
        const hasActive = state.pieces.some(
          (p) => p.playerId === player.id && p.progress >= 0 && p.progress < HOME,
        )
        next = event(
          next,
          'skip',
          `${player.name} cannot move. ${hasActive ? 'An exact roll is needed for home.' : 'Roll a 6 to leave the nest.'}`,
        )
      }
      return next
    }
    case 'MOVE': {
      if (state.phase !== 'choose') return state
      const move = state.legalMoves.find((m) => m.pieceId === action.pieceId)
      if (!move) return state
      const capturedPieces = state.pieces.filter((p) => move.captures.includes(p.id))
      let next: GameState = {
        ...state,
        phase: 'moving',
        legalMoves: [],
        motion: {
          ...move,
          capturedPieces,
          steps:
            move.from < 0 ? [0] : Array.from({ length: move.to - move.from }, (_, i) => move.from + i + 1),
        },
        pieces: state.pieces.map((p) =>
          p.id === move.pieceId
            ? { ...p, progress: move.to }
            : move.captures.includes(p.id)
              ? { ...p, progress: -1 }
              : p,
        ),
        players: state.players.map((p) =>
          p.id !== player.id
            ? p
            : {
                ...p,
                stats: {
                  ...p.stats,
                  moves: p.stats.moves + 1,
                  captures: p.stats.captures + move.captures.length,
                },
              },
        ),
      }
      if (move.from < 0) next = event(next, 'enter', `${player.name} leaves the nest. The journey is on!`)
      else if (move.to === HOME) next = event(next, 'home', `${player.name} brought a piece home!`)
      else next = event(next, 'move', `${player.name} moved ${move.to - move.from} spaces.`)
      if (capturedPieces.length) {
        const names = [
          ...new Set(
            capturedPieces.map((p) => state.players.find((player) => player.id === p.playerId)!.name),
          ),
        ]
        next = event(next, 'capture', `${player.name} captured ${names.join(' & ')}! Back to the nest.`)
      }
      return next
    }
    case 'ANIMATION_DONE': {
      if (state.phase !== 'moving') return state
      if (state.pieces.filter((p) => p.playerId === player.id).every((p) => p.progress === HOME)) {
        return event(
          { ...state, phase: 'won', winner: player.id, motion: null },
          'win',
          `${player.name} wins! Every piece found its way home.`,
        )
      }
      return advanceTurn(state)
    }
    case 'NEXT_TURN':
      return state.phase === 'pass' ? advanceTurn(state) : state
    default:
      return state
  }
}

export function progressFor(state: GameState, playerId: PlayerId) {
  const pieces = state.pieces.filter((p) => p.playerId === playerId)
  return {
    home: pieces.filter((p) => p.progress === HOME).length,
    nest: pieces.filter((p) => p.progress < 0).length,
    board: pieces.filter((p) => p.progress >= 0 && p.progress < HOME).length,
    distance: pieces.reduce((sum, p) => sum + Math.max(0, p.progress), 0),
  }
}

export function motionDuration(state: GameState, reducedMotion: boolean) {
  if (reducedMotion) return 180
  return (
    (state.motion?.steps.length || 1) * 165 +
    (state.motion?.captures.length ? 550 : state.motion?.to === HOME ? 650 : 220)
  )
}
