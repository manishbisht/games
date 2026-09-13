import { DEFAULT_RULES, LADDERS, PALETTES, PLAYER_IDS, SNAKES } from './board'
import type { Action, GameConfig, GameEvent, GameState } from './types'

export function rollDie(random: () => number = Math.random) {
  return Math.floor(random() * 6) + 1
}

export function createGame(config: GameConfig = {}): GameState {
  const count = Math.max(2, Math.min(4, Math.trunc(config.playerCount || 2)))
  const rules = { ...DEFAULT_RULES, ...config.rules }
  rules.snakeCount = Math.max(0, Math.min(SNAKES.length, Math.trunc(rules.snakeCount)))
  rules.ladderCount = Math.max(0, Math.min(LADDERS.length, Math.trunc(rules.ladderCount)))
  const currentPlayer = Math.max(0, Math.min(count - 1, Math.trunc(config.firstPlayer || 0)))
  const players = PLAYER_IDS.slice(0, count).map((id, i) => ({
    id,
    name: config.names?.[i]?.trim().slice(0, 18) || PALETTES[id].name,
    control: config.controls?.[i] || ('human' as const),
    position: rules.startingPosition,
    turns: 0,
    climbs: 0,
    slides: 0,
  }))
  return {
    players,
    rules,
    currentPlayer,
    turn: 1,
    dice: null,
    phase: 'ready',
    motion: null,
    winner: null,
    board: {
      spaces: Array.from({ length: 100 }, (_, i) => i + 1),
      snakes: SNAKES.slice(0, rules.snakeCount).map((r) => ({ ...r })),
      ladders: LADDERS.slice(0, rules.ladderCount).map((r) => ({ ...r })),
    },
    eventSequence: 1,
    events: [
      {
        id: 1,
        kind: 'start',
        message: `The adventure begins. ${players[currentPlayer].name} goes first.`,
        playerId: players[currentPlayer].id,
        turn: 1,
      },
    ],
  }
}

function log(state: GameState, kind: GameEvent['kind'], message: string): GameState {
  const id = state.eventSequence + 1
  return {
    ...state,
    eventSequence: id,
    events: [
      { id, kind, message, playerId: state.players[state.currentPlayer].id, turn: state.turn },
      ...state.events,
    ].slice(0, 50),
  }
}

function landed(state: GameState): GameState {
  const player = state.players[state.currentPlayer]
  if (player.position === 100)
    return log(
      { ...state, phase: 'won', winner: player.id, motion: null },
      'win',
      `${player.name} reached 100. What an adventure!`,
    )
  return { ...state, phase: 'settling', motion: null }
}

export function gameReducer(state: GameState, action: Action): GameState {
  if (state.phase === 'won') return state
  const player = state.players[state.currentPlayer]
  switch (action.type) {
    case 'ROLL': {
      if (state.phase !== 'ready' || !Number.isInteger(action.value) || action.value < 1 || action.value > 6)
        return state
      return {
        ...state,
        phase: 'rolling',
        dice: action.value,
        players: state.players.map((p, i) => (i === state.currentPlayer ? { ...p, turns: p.turns + 1 } : p)),
      }
    }
    case 'DICE_SETTLED': {
      if (state.phase !== 'rolling' || state.dice === null) return state
      const next = log(state, 'roll', `${player.name} rolled ${state.dice}.`)
      if (player.position + state.dice > 100 && state.rules.exactFinish)
        return log(
          { ...next, phase: 'settling' },
          'wait',
          `${player.name} needs a ${100 - player.position} to reach 100.`,
        )
      const to = Math.min(100, player.position + state.dice)
      const route = [...state.board.snakes, ...state.board.ladders].find((r) => r.from === to)
      if (
        !state.rules.allowSharedSquares &&
        state.players.some((p, i) => i !== state.currentPlayer && p.position === (route?.to ?? to))
      )
        return log({ ...next, phase: 'settling' }, 'wait', `${player.name} waits. That space is occupied.`)
      return {
        ...next,
        phase: 'moving',
        motion: {
          kind: 'walk',
          from: player.position,
          to,
          path: Array.from({ length: to - player.position }, (_, i) => player.position + i + 1),
        },
      }
    }
    case 'MOVE_DONE': {
      if (state.phase !== 'moving' || !state.motion) return state
      const position = state.motion.to
      const next = {
        ...state,
        players: state.players.map((p, i) => (i === state.currentPlayer ? { ...p, position } : p)),
      }
      const ladder = state.board.ladders.find((r) => r.from === position)
      const snake = state.board.snakes.find((r) => r.from === position)
      const route = ladder || snake
      if (route) {
        const kind = ladder ? 'ladder' : 'snake'
        return log(
          { ...next, phase: 'transporting', motion: { kind, from: route.from, to: route.to, path: [] } },
          kind,
          `${player.name} ${ladder ? 'found a ladder' : 'met a snake'}! ${route.from} → ${route.to}`,
        )
      }
      return landed(log(next, 'move', `${player.name} moved to ${position}.`))
    }
    case 'TRANSPORT_DONE': {
      if (state.phase !== 'transporting' || !state.motion) return state
      const motion = state.motion
      return landed(
        log(
          {
            ...state,
            players: state.players.map((p, i) =>
              i !== state.currentPlayer
                ? p
                : {
                    ...p,
                    position: motion.to,
                    climbs: p.climbs + Number(motion.kind === 'ladder'),
                    slides: p.slides + Number(motion.kind === 'snake'),
                  },
            ),
          },
          motion.kind === 'ladder' ? 'ladder' : 'snake',
          `${player.name} ${motion.kind === 'ladder' ? 'climbed' : 'slid'} ${motion.from} → ${motion.to}.`,
        ),
      )
    }
    case 'NEXT_TURN': {
      if (state.phase !== 'settling') return state
      const extra = state.rules.extraTurnOnSix && state.dice === 6
      const next: GameState = {
        ...state,
        phase: 'ready',
        motion: null,
        turn: state.turn + 1,
        currentPlayer: extra ? state.currentPlayer : (state.currentPlayer + 1) % state.players.length,
      }
      return extra ? log(next, 'start', `${player.name} rolled a six. One more turn!`) : next
    }
  }
}
