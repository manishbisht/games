import { phaseDuration } from '@games/shared/wildrise/timing'
import type { GameState, PlayerId } from '@games/shared/wildrise/types'

/** Where each token stands once everything queued so far has played. */
export type Squares = Partial<Record<PlayerId, number>>

/**
 * One thing the board shows happening, in the order it happened. `ms` is how
 * long the next beat waits for it, priced from the same shared timing the
 * server holds each phase for, so a table played live never builds a backlog.
 */
export type Beat = { ms: number } & (
  | { kind: 'turn'; id: PlayerId }
  | { kind: 'arrive'; moves: { id: PlayerId; from: number | undefined; to: number }[]; gone: PlayerId[] }
  | { kind: 'roll'; value: number }
  | { kind: 'walk'; id: PlayerId; from: number; path: number[] }
  | { kind: 'ride'; id: PlayerId; type: 'snake' | 'ladder'; from: number; to: number }
  | { kind: 'nope'; id: PlayerId; needs: number }
  | { kind: 'win'; id: PlayerId }
)

export interface Plan {
  beats: Beat[]
  squares: Squares
  /**
   * The state is the very next beat after the last one: the board can play it
   * at the table's pace. Anything else — the first state after joining, a
   * reconnect, a tab that slept through a few turns — is caught up quickly
   * rather than replayed at length, since the server is already further on.
   */
  live: boolean
}

const NEXT: Record<GameState['phase'], GameState['phase'][]> = {
  ready: ['rolling'],
  rolling: ['moving', 'settling'],
  moving: ['transporting', 'settling', 'won'],
  transporting: ['settling', 'won'],
  settling: ['ready'],
  won: [],
}
const STEP: Record<GameState['phase'], number> = {
  ready: 0,
  rolling: 1,
  moving: 2,
  transporting: 3,
  settling: 4,
  won: 5,
}

const sameTable = (a: GameState, b: GameState) =>
  a.players.length === b.players.length && a.players.every((p, i) => p.id === b.players[i].id)

function follows(prev: GameState, next: GameState) {
  if (!sameTable(prev, next) || !NEXT[prev.phase].includes(next.phase)) return false
  return next.phase === 'ready' ? next.turn === prev.turn + 1 : next.turn === prev.turn
}

/** The same table at the same moment: a presence change, an echo, a re-render. */
function unchanged(prev: GameState, next: GameState) {
  return (
    sameTable(prev, next) &&
    prev.turn === next.turn &&
    prev.phase === next.phase &&
    prev.eventSequence === next.eventSequence &&
    prev.players.every((p, i) => p.position === next.players[i].position)
  )
}

/**
 * Turns the newest state into the beats that get the board from what it last
 * showed to it. A state carries where a beat *starts* — `position` only moves
 * once a walk or a ride is over — so any token not standing where the state
 * says is first brought there, and then the phase's own beat plays from it.
 */
export function plan(prev: GameState | null, squares: Squares, next: GameState, reduced: boolean): Plan {
  if (prev && unchanged(prev, next)) return { beats: [], squares, live: true }
  const live = prev !== null && follows(prev, next)
  const time = (phase: GameState['phase']) => phaseDuration({ ...next, phase }, reduced)
  const beats: Beat[] = []
  const after: Squares = {}
  const player = next.players[next.currentPlayer]
  beats.push({ kind: 'turn', id: player.id, ms: 0 })

  const moves = next.players
    .filter((p) => squares[p.id] !== p.position)
    .map((p) => ({ id: p.id, from: squares[p.id], to: p.position }))
  const ids = new Set(next.players.map((p) => p.id))
  const gone = (Object.keys(squares) as PlayerId[]).filter((id) => !ids.has(id))
  if (moves.length || gone.length) beats.push({ kind: 'arrive', moves, gone, ms: reduced ? 200 : 520 })
  for (const p of next.players) after[p.id] = p.position

  // Whether this turn's die has already been shown landing.
  const thrown = prev !== null && sameTable(prev, next) && prev.turn === next.turn && STEP[prev.phase] >= 1
  const roll = () => {
    if (!thrown && next.dice && next.phase !== 'ready')
      beats.push({ kind: 'roll', value: next.dice, ms: live ? time('rolling') : reduced ? 120 : 600 })
  }
  const motion = next.motion
  switch (next.phase) {
    case 'rolling':
      if (next.dice) beats.push({ kind: 'roll', value: next.dice, ms: time('rolling') })
      break
    case 'moving':
      roll()
      if (motion) {
        beats.push({ kind: 'walk', id: player.id, from: motion.from, path: motion.path, ms: time('moving') })
        after[player.id] = motion.to
      }
      break
    case 'transporting':
      roll()
      if (motion && motion.kind !== 'walk') {
        beats.push({
          kind: 'ride',
          id: player.id,
          type: motion.kind,
          from: motion.from,
          to: motion.to,
          ms: time('transporting'),
        })
        after[player.id] = motion.to
      }
      break
    case 'settling': {
      roll()
      const event = next.events[0]
      const fresh = !prev || event.id > prev.eventSequence
      if (event.kind === 'wait' && event.turn === next.turn && fresh)
        beats.push({ kind: 'nope', id: player.id, needs: 100 - player.position, ms: time('settling') })
      break
    }
    case 'won':
      if (next.winner) beats.push({ kind: 'win', id: next.winner, ms: 0 })
      break
  }
  return { beats, squares: after, live }
}
