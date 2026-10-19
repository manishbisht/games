import type { GameState, Motion, PlayerId } from '@games/shared/hearth/types'
import { reducedMotion } from '../../../motion/preference'
import { createQueue } from '../../../motion/tween'
import type { Beat } from '../../../motion/tween'
import type { Choreography } from './choreography'
import { THROW_MS } from './die'
import type { Die } from './die'
import type { Director } from './director'
import type { Effects } from './effects'
import type { Picking } from './picking'
import type { Pieces } from './pieces'
import type { TableSet } from './table'
import type { SceneContext } from './types'

/**
 * How far behind the room a beat may start and still play in full. The room
 * holds every walk a little longer than it takes, so ordinary lag is absorbed;
 * a board further behind than this (it joined mid-walk, or its connection
 * stalled) starts the beat where the room already is instead.
 */
const LATE_SLACK_MS = 250
/** How long a rattle may wait on the room before the die is put back down. */
const UNANSWERED_MS = 3000

const motionKey = (state: GameState, motion: Motion) =>
  `${state.turn}:${motion.pieceId}:${motion.from}:${motion.to}`

/** `state` as it was a moment before its die landed: still rolling, the number not yet told. */
const beforeLanding = (state: GameState): GameState => ({
  ...state,
  phase: 'rolling',
  dice: null,
  legalMoves: [],
  events: state.events.filter(
    (event) => event.turn !== state.turn || (event.kind !== 'roll' && event.kind !== 'skip'),
  ),
})

const freshGame = (prev: GameState, next: GameState) =>
  prev.startedAt !== next.startedAt ||
  next.turn < prev.turn ||
  next.eventSequence < prev.eventSequence ||
  next.pieces.length !== prev.pieces.length

interface Parts {
  pieces: Pieces
  die: Die
  moves: Choreography
  picking: Picking
  table: TableSet
  director: Director
  effects: Effects
}

/**
 * The board's account of the game: every state from the room becomes beats
 * played in order — the die rattles, lands on its number, the piece walks,
 * and only then does the HUD catch up. `shown` is the state the board has
 * reached, which trails the room's while a beat plays.
 */
export function createStory(
  ctx: SceneContext,
  { pieces, die, moves, picking, table, director, effects }: Parts,
  /** The table as the board shows it, for the HUD. */
  report: (state: GameState) => void,
  initial: GameState,
  seat: PlayerId | null,
  live: boolean,
) {
  const { stage, tweens } = ctx
  /** Counted per state, so its backlog is the states handed over that it has not finished presenting. */
  const queue = createQueue({ catchUpAfter: Infinity, countBy: 'push' })
  let target = initial,
    shown = initial,
    shakenTurn = -1,
    thrownTurn = -1,
    walked = '',
    /** When this browser started a rattle the room has not answered yet. */
    localShakeAt = -1,
    celebrated = false,
    /** Wall time the stage's clock skipped over in long frames (`takeDrift`), which the room did not. */
    drifted = 0
  /** Where each piece will be once the queued beats have played. */
  const planned = new Map<string, number>()

  const mine = () =>
    live && shown.phase === 'choose' && seat !== null && shown.players[shown.currentPlayer]?.id === seat
  const tell = () => report({ ...shown, pieces: pieces.shown(shown) })
  /** The room's clock, as near as the board can keep it: scene time plus whatever long frames skipped. */
  const roomNow = () => stage.now + drifted
  /** How far behind the room's clock a beat that began at `beatAt` (`roomNow` time) is starting. */
  const lateBy = (beatAt: number) => {
    const late = roomNow() - beatAt
    return late > LATE_SLACK_MS ? late : 0
  }

  function present(state: GameState) {
    shown = state
    picking.offer(mine() ? state.legalMoves : [])
    const player = state.players[state.currentPlayer]?.id ?? null
    if (live && state.phase !== 'won' && player && player !== table.turnOf) {
      table.handOver(player)
      director.handOver(player)
    }
    if (state.winner && !celebrated) celebrate(state.winner)
    if (!state.winner) celebrated = false
    tell()
    stage.invalidate()
  }

  function celebrate(winner: PlayerId) {
    celebrated = true
    ctx.cue({ kind: 'win' })
    if (ctx.quiet || reducedMotion()) return
    effects.celebrate(winner)
    director.celebrate()
  }

  const walkBeat = (state: GameState, motion: Motion, beatAt: number): Beat => ({
    label: 'walk',
    run: () => {
      present(state)
      return moves.walk(motion, lateBy(beatAt))
    },
  })

  /**
   * Put the board straight on `state`: a new game, a first snapshot, a backlog
   * not worth replaying. A walk or a toss still under way on the room's clock
   * is picked up where the room is, `elapsed` ms in.
   */
  function snap(state: GameState, elapsed: number) {
    queue.clear()
    tweens.cancelAll()
    const motion = state.phase === 'moving' ? state.motion : null
    // Mid-walk, the board starts from where the walk began.
    const before = new Map<string, number>(
      motion
        ? [[motion.pieceId, motion.from], ...motion.capturedPieces.map((p) => [p.id, p.progress] as const)]
        : [],
    )
    for (const token of pieces.tokens.values()) {
      const id = token.piece.id
      token.progress = before.get(id) ?? state.pieces.find((p) => p.id === id)?.progress ?? token.progress
      token.flying = false
      planned.set(id, token.progress)
    }
    pieces.layout()
    pieces.seat()
    const beatAt = roomNow() - elapsed,
      value = state.dice || state.lastDice || 1,
      tossing =
        state.dice !== null && (state.phase === 'choose' || state.phase === 'pass') && elapsed < THROW_MS
    die.settle(value, state.phase === 'rolling')
    localShakeAt = -1
    thrownTurn = state.dice !== null ? state.turn : -1
    shakenTurn = state.phase === 'rolling' ? state.turn : -1
    walked = motion ? motionKey(state, motion) : ''
    celebrated = Boolean(state.winner)
    table.handOver(null)
    if (tossing) {
      // The number is in, but the die is still in the air: the HUD hears it when it lands.
      present(beforeLanding(state))
      queue.push(
        { label: 'throw', run: () => die.throw(value, lateBy(beatAt)) },
        { label: 'present', run: () => present(state) },
      )
    } else present(state)
    if (motion) {
      planned.set(motion.pieceId, motion.to)
      for (const id of motion.captures) planned.set(id, -1)
      queue.push(walkBeat(state, motion, beatAt))
    }
  }

  /**
   * Turn a fresh state from the room into beats, played after whatever is
   * still running. The room's pacing leaves room for every beat, so a backlog
   * only builds when snapshots arrive late — and then everything plays faster
   * until it has caught up.
   */
  function plan(next: GameState, elapsed: number) {
    const prev = target
    target = next
    if (freshGame(prev, next)) return snap(next, elapsed)
    if (queue.backlog > 4) {
      // Far behind (a hidden tab, a stalled connection): land it all at once, silently.
      ctx.quiet = true
      queue.flush()
      tweens.finishAll()
      ctx.quiet = false
    }
    const beatAt = roomNow() - elapsed
    const beats: Beat[] = []
    if (next.phase === 'rolling' && shakenTurn !== next.turn) {
      shakenTurn = next.turn
      beats.push({
        label: 'shake',
        run: () => {
          localShakeAt = -1
          die.shake()
        },
      })
    }
    if (next.dice !== null && thrownTurn !== next.turn) {
      thrownTurn = next.turn
      const value = next.dice
      beats.push({
        label: 'throw',
        run: () => {
          localShakeAt = -1
          return die.throw(value, lateBy(beatAt))
        },
      })
    }
    const motion = next.phase === 'moving' ? next.motion : null
    if (motion && motionKey(next, motion) !== walked) {
      walked = motionKey(next, motion)
      planned.set(motion.pieceId, motion.to)
      for (const id of motion.captures) planned.set(id, -1)
      beats.push(walkBeat(next, motion, beatAt))
    }
    const drift = next.pieces.filter((piece) => planned.get(piece.id) !== piece.progress)
    if (drift.length) {
      for (const piece of drift) planned.set(piece.id, piece.progress)
      beats.push({ label: 'glide', run: () => moves.glide(drift) })
    }
    beats.push({
      label: 'present',
      run: () => present(next),
    })
    queue.push(...beats)
    stage.invalidate()
  }

  return {
    get shown() {
      return shown
    },
    /** The state the room is at, which the board may still be catching up to. */
    get target() {
      return target
    },
    get busy() {
      return queue.busy || tweens.active
    },
    /** A piece came to rest mid-beat: the HUD's pips fill as it arrives. */
    tell,
    start(elapsed: number) {
      snap(initial, elapsed)
    },
    update(next: GameState, nextSeat: PlayerId | null, nextLive: boolean, elapsed = 0) {
      const seatChanged = nextSeat !== seat || nextLive !== live
      seat = nextSeat
      live = nextLive
      if (next !== target) plan(next, elapsed)
      if (seatChanged) present(shown)
    },
    /** This browser's roll: rattle now, before the room has heard of it. */
    roll() {
      if (!live || queue.busy || target.phase !== 'roll' || die.busy) return
      shakenTurn = target.turn
      localShakeAt = stage.now
      die.shake()
      stage.invalidate()
    },
    step(dt: number) {
      const ms = dt * 1000,
        backlog = queue.backlog,
        speed = backlog > 3 ? 3 : backlog > 1 ? 1.6 : 1,
        drift = stage.takeDrift()
      tweens.speed = speed
      if (drift > 0) {
        // A long frame (a shader compiling, a stalled thread) cost wall time the scene clock never
        // counted, but the room's clock did: a beat under way skips ahead, quietly, to land with everyone.
        drifted += drift
        if (queue.busy) {
          ctx.skip(drift)
          die.fastForward(drift)
          queue.step(drift)
        }
      }
      // Tweens first, so a beat's last landing has run before the queue starts the next one.
      let moving = tweens.step(ms)
      moving = queue.step(ms * speed) || moving
      if (localShakeAt >= 0 && stage.now - localShakeAt > UNANSWERED_MS && target.phase === 'roll') {
        // The room never took the roll: put the die back down on what it showed.
        localShakeAt = -1
        shakenTurn = -1
        die.putDown(target.lastDice || 1)
        moving = true
      }
      return moving
    },
    dispose() {
      queue.clear()
      tweens.cancelAll()
    },
  }
}
export type Story = ReturnType<typeof createStory>
