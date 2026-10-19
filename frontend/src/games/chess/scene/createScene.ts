import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { createGame, playMove } from '@games/shared/chess'
import type {
  Color,
  GameState,
  MoveRecord,
  Preferences,
  PromotionPiece,
  Square,
} from '@games/shared/chess/types'
import { createCameraRig } from '../../../motion/camera'
import type { Orbit } from '../../../motion/camera'
import { dampFactor, lerp, outCubic } from '../../../motion/ease'
import { createParticles, qualityDensity } from '../../../motion/particles'
import { onMotionChange, reducedMotion } from '../../../motion/preference'
import { createStage, disposeTree } from '../../../motion/stage'
import { createQueue, createTweens } from '../../../motion/tween'
import { unseenBeats } from '../../../online/session'
import type { RoomBeat } from '../../../online/session'
import { serverNow } from '../components/clock'
import type { HeldTiming } from '../components/clock'
import type { ChessSound, SoundDetail } from '../game/audio'
import { BOARD_Y, createCast } from './actors'
import type { Actor } from './actors'
import {
  fallDirection,
  planMove,
  returnDelay,
  squareAt,
  squareDistance,
  squareXZ,
  story,
} from './choreography'
import type { MovePlan } from './choreography'
import { createHighlights } from './highlights'
import type { HighlightSpec } from './highlights'
import { makeBoard } from './models'

export type ScenePreferences = Pick<Preferences, 'theme' | 'highContrast'>
export interface SceneState {
  game: GameState
  selected: Square | null
  legal: { to: Square; capture: boolean }[]
  focused: Square | null
  enabled: boolean
  preferences: ScenePreferences
  /** A move this seat has sent, or is choosing a promotion for, that the server has not played yet. */
  pending?: { from: Square; to: Square } | null
  /** The seat at this browser; the winner's confetti falls for them (and for spectators). */
  seat?: Color | null
  /** The room's recent states, newest last (`game`); see `OnlineChessSession.recent`. */
  recent?: RoomBeat<GameState>[]
}
export type Impact = Exclude<ChessSound, 'lift' | 'tick' | 'flag' | 'reaction'>
export interface SceneEvents {
  select: (square: Square) => void
  /** A sound-worthy moment, timed to the board rather than to the snapshot. */
  impact?: (kind: Impact, detail: SoundDetail) => void
  /** True while the board is still playing out moves the game has already made. */
  presenting?: (busy: boolean) => void
  /** How many victims of each colour have reached the trays. */
  graves?: (counts: Record<Color, number>) => void
  /** The board's first frame is on screen. */
  ready?: () => void
}
export interface SceneOptions {
  black: boolean
  /** The lobby's preview: a slow orbit while it is on screen, and nothing to play. */
  showcase?: boolean
  /**
   * The opening snapshot's timing, held from when it arrived: how long ago, by
   * the server's clock, the game reached the state the board opens on. A board
   * that opens moments after a move — a join or a reload mid-move — plays that
   * move from where it has got to rather than setting it down already finished.
   */
  timing?: HeldTiming
}
export interface SceneApi {
  update: (state: SceneState) => void
  flip: (black: boolean) => void
  zoom: (amount: number) => void
  reset: () => void
  top: () => void
  /**
   * A replay's jump — a scrub, a step back, a step while paused: the board is
   * set to `game` at once, with nothing between it and what was shown.
   */
  land: (game: GameState) => void
  /**
   * A replay playing on into its next state: whatever is still moving lands,
   * then the story from the board to `game` plays, sped up by `rate` (the
   * player bar's speed) and further if it would not otherwise fit `withinMs`.
   */
  play: (game: GameState, pace: { rate: number; withinMs: number }) => void
  dispose: () => void
}

const other = (color: Color): Color => (color === 'w' ? 'b' : 'w')
const home = (square: Square) => {
  const { x, z } = squareXZ(square)
  return new THREE.Vector3(x, BOARD_Y, z)
}
/** The pause between one move landing and the next one lifting. */
const GAP = 150
const VIEW = { polar: 0.88, azimuth: (black: boolean) => (black ? Math.PI + 0.24 : 0.24) }
const TARGET = new THREE.Vector3(0, 0.2, 0)
const RADIUS = 22
const DRAG_LIFT = 0.5
/** A move younger than this when the board opens is still playing; see `SceneOptions.timing`. */
const LIVE_MOVE_MS = 1200

/** The position one move back: what the board looked like before the last move began. */
function beforeLast(game: GameState): GameState {
  let previous = createGame({ ...game.options, clock: 0 }, game.initialFen, 0)
  for (const move of game.history.slice(0, -1))
    previous = playMove(previous, move.from, move.to, move.promotion as PromotionPiece | undefined, 0)
  return previous
}

/**
 * The chess table. The room's snapshot is the truth; this turns each new one
 * into a presentation — moves play one after another, captures wait for
 * contact, check and mate land after the piece does — while selection, legal
 * marks and dragging answer the viewer immediately.
 */
export function createScene(
  container: HTMLElement,
  initial: SceneState,
  options: SceneOptions,
  events: SceneEvents,
): SceneApi {
  const stage = createStage(container, { maxPixelRatio: 2, exposure: 1, environmentIntensity: 0.4 })
  const { scene } = stage,
    canvas = stage.canvas
  const camera = new THREE.OrthographicCamera(-7, 7, 7, -7, 0.1, 100)
  stage.setCamera(camera)
  const controls = new OrbitControls(camera, canvas)
  controls.enableDamping = true
  controls.dampingFactor = 0.09
  controls.enablePan = false
  controls.minPolarAngle = 0.03
  controls.maxPolarAngle = 1.05
  controls.minZoom = 0.75
  controls.maxZoom = 1.65
  controls.rotateSpeed = 0.5
  controls.zoomSpeed = 0.6
  controls.target.copy(TARGET)
  let black = options.black
  // Seated as Black, the board starts from Black's side rather than sweeping round to it.
  placeCamera(VIEW.azimuth(black), VIEW.polar)
  controls.update()
  const rig = createCameraRig(camera, controls)
  const tweens = createTweens(),
    queue = createQueue({ catchUpAfter: 2, catchUpSpeed: 2.6 }),
    particles = createParticles(scene, { max: 520, floor: BOARD_Y })

  scene.add(new THREE.HemisphereLight('#fff8e9', '#969280', 1.4))
  const key = new THREE.DirectionalLight('#fff0d9', 2.25)
  key.position.set(-5, 12, 7)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  Object.assign(key.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8, near: 0.1, far: 40 })
  key.shadow.bias = -0.0003
  key.shadow.normalBias = 0.02
  key.shadow.radius = 4
  scene.add(key)
  const fill = new THREE.DirectionalLight('#edf2ed', 0.8)
  fill.position.set(8, 7, -6)
  scene.add(fill)
  const table = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.ShadowMaterial({ color: '#333629', opacity: 0.19 }),
  )
  table.rotation.x = -Math.PI / 2
  table.position.y = -0.27
  table.receiveShadow = true
  scene.add(table)

  let state = initial,
    theme = initial.preferences.theme,
    board = makeBoard(theme).board
  scene.add(board)
  // The graveyard: a shallow tray down each side, where captured pieces come to rest.
  const trayWood = new THREE.MeshStandardMaterial({ roughness: 0.5 }),
    trayFelt = new THREE.MeshStandardMaterial({ roughness: 0.9 })
  for (const side of [-1, 1]) {
    const tray = new THREE.Mesh(new RoundedBoxGeometry(1.24, 0.06, 8.3, 2, 0.025), trayWood)
    tray.position.set(side * 5.55, -0.245, 0)
    tray.receiveShadow = tray.castShadow = true
    const felt = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.012, 8.1), trayFelt)
    felt.position.set(side * 5.55, -0.212, 0)
    felt.receiveShadow = true
    scene.add(tray, felt)
  }
  function paintTrays() {
    trayWood.color.set(theme === 'marble' ? '#56605c' : '#5e4838')
    trayFelt.color.set(theme === 'marble' ? '#59625e' : '#5f6651')
  }
  paintTrays()

  let muted = false
  const heard = new THREE.Vector3(),
    onScreen = new THREE.Vector2()
  /** A sound, panned to where on screen it happened. */
  const impact = (kind: Impact, at?: { x: number; z: number }, strength = 1) => {
    if (muted) return
    let pan = 0
    if (at && stage.size.width) {
      stage.toScreen(heard.set(at.x, BOARD_Y, at.z), onScreen)
      pan = THREE.MathUtils.clamp((onScreen.x / stage.size.width) * 2 - 1, -1, 1) * 0.6
    }
    events.impact?.(kind, { pan, strength })
  }
  const cast = createCast(scene, tweens, particles, { theme: () => theme, muted: () => muted })
  const highlights = createHighlights(scene)
  /** What stands where on the board as presented — behind the game until the queue catches up. */
  const squares = new Map<Square, Actor>()
  let queued = initial.game,
    shown: { last: { from: Square; to: Square } | null; check: Square | null; threats: Square[] } = {
      last: null,
      check: null,
      threats: [],
    }

  const squareOf = (actor: Actor) => {
    for (const [square, a] of squares) if (a === actor) return square
    return null
  }
  const kingOf = (color: Color) => {
    for (const [square, a] of squares) if (a.type === 'k' && a.color === color) return { square, actor: a }
    return null
  }
  function emitGraves() {
    if (!muted) events.graves?.({ w: settled('w'), b: settled('b') })
  }
  /** A victim has come to rest in its tray. */
  const arrived = (actor: Actor) => () => {
    emitGraves()
    impact('tray', actor.pos)
  }
  /** Victims that have actually arrived, not ones still on their way. */
  const settled = (color: Color) => cast.graves[color].filter((a) => !a.graveTween).length
  const later = (ms: number, run: () => void) =>
    tweens.add({ duration: 1, delay: ms, update() {}, done: run })

  /** Sets the table to a position with no story: on mount, and when a snapshot can't be told as moves. */
  function build(game: GameState) {
    for (const actor of [...cast.actors.values()]) cast.remove(actor)
    squares.clear()
    for (const piece of game.pieces)
      squares.set(piece.square, cast.create(piece.id, piece.type, piece.color, home(piece.square)))
    for (const captor of ['w', 'b'] as const)
      game.captured[captor].forEach((type, i) => {
        const victim = other(captor)
        cast.bury(cast.create(`tray:${victim}:${i}`, type, victim, home('a1')), { instant: true })
      })
    const last = game.history.at(-1)
    shown = { last: last ? { from: last.from, to: last.to } : null, check: game.check, threats: game.threats }
    if (game.status !== 'playing') {
      muted = true
      finale(game, false)
      tweens.finishAll()
      particles.clear()
      muted = false
    }
    emitGraves()
  }

  /** One move, start to finish. Returns how long the next beat should wait. */
  function playRecord(record: MoveRecord, final: GameState | null): number {
    const plan = planMove(record),
      mover = squares.get(plan.from)
    if (!mover) return 0
    const victim = plan.victim ? squares.get(plan.victim) : undefined,
      rook = plan.rook ? squares.get(plan.rook.from) : undefined
    squares.delete(plan.from)
    if (plan.victim) squares.delete(plan.victim)
    squares.set(plan.to, mover)
    if (rook && plan.rook) {
      squares.delete(plan.rook.from)
      squares.set(plan.rook.to, rook)
    }
    shown.check = null
    shown.threats = []
    paint()
    const knight = plan.piece === 'n'
    let knocked = false
    function knock() {
      if (!victim || knocked) return
      knocked = true
      let dx = victim.pos.x - mover!.pos.x,
        dz = victim.pos.z - mover!.pos.z
      if (Math.hypot(dx, dz) < 0.05) ({ x: dx, z: dz } = mover!.leanDir)
      const occupied = new Set<string>(squares.keys())
      occupied.delete(plan.to)
      impact('capture', victim.pos)
      cast.topple(victim, fallDirection(plan.victim!, { x: dx, z: dz }, occupied), {
        knock: 0.24,
        onImpact: () => impact('fall', victim.pos, 0.7),
        done: () => cast.bury(victim, { delay: 60, onArrive: arrived(victim) }),
      })
    }
    const duration = cast.travel(mover, home(plan.to), {
      hop: knight,
      face: knight,
      onProgress: victim
        ? (raw) => {
            const near = Math.hypot(mover.pos.x - victim.pos.x, mover.pos.z - victim.pos.z) < 0.64
            if ((knight ? raw > 0.78 : near) || raw > 0.9) knock()
          }
        : undefined,
      onLand: () => landed(plan, mover, !!victim, final),
    })
    let hold = duration
    if (rook && plan.rook)
      // The king steps first; the rook is lifted clean over it.
      hold = Math.max(
        hold,
        cast.travel(rook, home(plan.rook.to), {
          hop: true,
          height: 1.95,
          duration: 640,
          delay: duration * 0.4,
          onLand: () => impact('move', rook.pos),
        }),
      )
    if (plan.promotion) hold += reducedMotion() ? 260 : 620
    if (plan.mate) hold += reducedMotion() ? 200 : 700
    return hold + GAP
  }

  function landed(plan: MovePlan, mover: Actor, captured: boolean, final: GameState | null) {
    shown.last = { from: plan.from, to: plan.to }
    if (!plan.check && !plan.promotion && !captured) impact('move', mover.pos)
    const afterwards = () => {
      if (plan.check) {
        const king = kingOf(other(plan.color))
        shown.check = king?.square ?? null
        shown.threats = final?.threats ?? []
        impact(plan.mate ? 'end' : 'check', king?.actor.pos)
        if (king && !plan.mate) cast.shudder(king.actor)
        if (plan.mate && final) finale(final, true)
      }
      paint()
    }
    if (plan.promotion) {
      impact('promote', mover.pos)
      cast.promote(mover, plan.promotion, () => {
        if (plan.promotion === 'n')
          cast.travel(mover, mover.pos.clone(), { hop: true, height: 0.75, duration: 480 })
        afterwards()
      })
    } else afterwards()
    paint()
  }

  /** The end of a decided game: the losing king falls, and the winner gets their moment. */
  function finale(game: GameState, animate: boolean) {
    const loser = game.status === 'checkmate' ? game.turn : game.winner ? other(game.winner) : null
    if (!loser) return 0
    const king = kingOf(loser)
    if (!king) return 0
    const mate = game.status === 'checkmate',
      at = squareXZ(king.square),
      from = mate
        ? squareXZ(game.threats[0] ?? game.history.at(-1)?.to ?? king.square)
        : squareXZ(kingOf(other(loser))?.square ?? king.square)
    let away = { x: at.x - from.x, z: at.z - from.z }
    if (Math.hypot(away.x, away.z) < 0.01) away = { x: 0, z: loser === 'w' ? 1 : -1 }
    const occupied = new Set<string>(squares.keys())
    occupied.delete(king.square)
    if (mate) cast.shudder(king.actor, 420)
    const celebrate = animate && (state.seat == null || state.seat === game.winner)
    cast.topple(king.actor, fallDirection(king.square, away, occupied), {
      knock: mate ? 0.12 : 0,
      duration: mate ? 640 : 950,
      delay: mate ? 380 : 150,
      onImpact: () => {
        if (!animate) return
        impact('fall', king.actor.pos)
        if (!mate) impact('end')
        if (!reducedMotion()) {
          if (stage.quality > 0) rig.shake(mate ? 0.07 : 0.03, 300)
          particles.burst({
            origin: new THREE.Vector3(at.x + away.x * 0.4, BOARD_Y + 0.05, at.z + away.z * 0.4),
            kind: 'dust',
            count: 14,
            speed: 1.6,
            colors: ['#efe6d2', '#d9cdb1'],
          })
        }
        if (celebrate && !reducedMotion()) confetti(mate ? 1 : 0.6)
      },
    })
    if (animate && mate && !rig.userControlled) {
      framed = true
      orbit({
        target: new THREE.Vector3(at.x * 0.45, 0.3, at.z * 0.45),
        zoom: 1.22,
        azimuth: rig.angle.azimuth + 0.3,
        polar: 0.8,
        ms: 1900,
        delay: 250,
      })
    }
    return mate ? 700 : 450
  }

  function confetti(amount: number) {
    const colors = ['#f6c453', '#fff4dc', '#7f935e', '#c9a86a', '#e9706a']
    for (const [i, x] of [-3.4, 3.4, 0].entries())
      later(i * 220, () =>
        particles.burst({
          origin: new THREE.Vector3(x, BOARD_Y + 0.3, i === 2 ? 0 : x * -0.3),
          kind: 'confetti',
          count: Math.round((i === 2 ? 70 : 100) * amount),
          speed: i === 2 ? 7.5 : 8.5,
          spread: 0.35,
          colors,
        }),
      )
  }

  /** A fresh game in the same room: every piece goes home, back ranks first. */
  function rematch(game: GameState) {
    shown = { last: null, check: null, threats: [] }
    const spare = new Set(cast.actors.values()),
      claims = game.pieces.map((piece) => {
        const actor = cast.actors.get(piece.id)
        if (actor && spare.has(actor)) {
          spare.delete(actor)
          return { piece, actor }
        }
        return { piece, actor: null as Actor | null }
      })
    // Tray pieces set out on mount have no id; pair them with whoever they could be.
    for (const claim of claims) {
      if (claim.actor) continue
      const candidates = [...spare].filter((a) => a.color === claim.piece.color),
        match = candidates.find((a) => a.type === claim.piece.type) ?? candidates[0]
      if (!match) continue
      spare.delete(match)
      cast.actors.delete(match.id)
      match.id = claim.piece.id
      cast.actors.set(match.id, match)
      claim.actor = match
    }
    cast.graves.w.length = 0
    cast.graves.b.length = 0
    emitGraves()
    squares.clear()
    let hold = 0
    for (const { piece, actor } of claims) {
      const delay = returnDelay(piece.color, piece.square),
        to = home(piece.square)
      if (actor) {
        actor.graveTween?.finish()
        actor.state = 'board'
        actor.shake = 0
        if (actor.type !== piece.type) later(delay + 160, () => cast.swapModel(actor, piece.type))
        const distance = Math.hypot(actor.pos.x - to.x, actor.pos.z - to.z)
        hold = Math.max(
          hold,
          distance < 0.01 && !actor.orient
            ? 0
            : cast.travel(actor, to, {
                hop: true,
                stand: true,
                height: 0.5 + 0.09 * distance,
                duration: 430 + 70 * Math.sqrt(distance),
                delay,
                quiet: true,
                // Thirty-two pieces going home: a soft clatter, not thirty-two moves.
                onLand: () => impact('move', to, 0.22),
              }),
        )
        squares.set(piece.square, actor)
      } else {
        const created = cast.create(piece.id, piece.type, piece.color, to)
        hold = Math.max(hold, cast.dropIn(created, delay + 120))
        squares.set(piece.square, created)
      }
    }
    for (const actor of spare) cast.vanish(actor)
    if (!rig.userControlled)
      orbit({ azimuth: VIEW.azimuth(black), polar: VIEW.polar, zoom: 1, target: TARGET, ms: 1200 })
    paint()
    return hold + GAP
  }

  /** After the queue runs dry, make sure the board agrees with the game; it nearly always does. */
  function reconcile() {
    const game = queued,
      seen = new Set<Actor>()
    for (const piece of game.pieces) {
      let actor = cast.actors.get(piece.id)
      if (!actor) {
        actor = cast.create(piece.id, piece.type, piece.color, home(piece.square))
        cast.dropIn(actor)
      } else if (actor.state !== 'board' || squares.get(piece.square) !== actor) {
        cast.graves[actor.color] = cast.graves[actor.color].filter((a) => a !== actor)
        actor.state = 'board'
        if (!actor.flights) cast.travel(actor, home(piece.square), { stand: true, quiet: true })
      }
      if (actor.type !== piece.type) cast.swapModel(actor, piece.type)
      seen.add(actor)
    }
    for (const actor of cast.actors.values())
      if (actor.state === 'board' && !seen.has(actor) && !actor.flights)
        cast.bury(actor, { onArrive: arrived(actor) })
    squares.clear()
    for (const piece of game.pieces) squares.set(piece.square, cast.actors.get(piece.id)!)
    const last = game.history.at(-1)
    if (game.status === 'playing' || game.status === 'checkmate')
      shown = {
        last: last ? { from: last.from, to: last.to } : null,
        check: game.check,
        threats: game.threats,
      }
    paint()
  }

  /** Turns a fresh snapshot into beats. A long backlog (a reconnect) is mostly skipped to its end. */
  function tell(next: GameState) {
    const previous = queued,
      told = { ...story(previous, next), ms: 0 }
    if (told.kind === 'reset') {
      queued = next
      queue.push({ label: 'rematch', run: () => (told.ms += rematch(next)) })
    } else if (told.kind === 'moves') {
      const { records } = told,
        skip = records.length > 4 ? records.length - 2 : 0
      if (skip) {
        // Land whatever is still playing, then the older moves silently; only the last two are shown.
        muted = true
        queue.flush()
        tweens.finishAll()
        for (const record of records.slice(0, skip)) playRecord(record, null)
        tweens.finishAll()
        particles.clear()
        muted = false
        emitGraves()
      }
      queued = next
      records.slice(skip).forEach((record, i, list) =>
        queue.push({
          label: record.san,
          run: () => (told.ms += playRecord(record, i === list.length - 1 ? next : null)),
        }),
      )
    }
    queued = next
    const mated = told.kind === 'moves' && told.records.at(-1)?.san.endsWith('#')
    if (next.status !== 'playing' && (previous.status === 'playing' || told.kind === 'reset') && !mated)
      queue.push({
        label: 'finale',
        run: () => {
          const hold = finale(next, true)
          if (!hold) impact('end')
          return (told.ms += hold + GAP)
        },
      })
    presenting()
    return told
  }

  /** The newest of the room's states this board has told; see `unseen`. */
  let presented = initial.recent?.at(-1)?.seq ?? 0,
    /** The move the board opened on is still playing; see the frame loop. */
    syncing = false
  /**
   * The states a new render brings, oldest first. A burst of snapshots renders
   * once; moves would chain anyway, but a rematch and the move straight after
   * it would otherwise be told as one fresh game already under way. A gap
   * bigger than `recent` holds is told by its newest state, as a reconnect is.
   */
  function unseen({ game, recent = [] }: SceneState) {
    const { beats } = unseenBeats(recent, presented)
    presented = recent.at(-1)?.seq ?? presented
    return beats.at(-1)?.state === game ? beats.map((beat) => beat.state) : [game]
  }

  let wasBusy = false
  function presenting() {
    const busy = queue.busy
    if (busy === wasBusy) return
    wasBusy = busy
    events.presenting?.(busy)
  }
  const stopIdle = queue.onIdle(() => {
    syncing = false
    reconcile()
    presenting()
  })

  // ——— highlights ———
  let hoveredSquare: Square | null = null,
    hoveredActor: Actor | null = null
  function paint() {
    const contrast = state.preferences.highContrast,
      specs: HighlightSpec[] = []
    if (shown.last) {
      const { from, to } = shown.last
      specs.push(
        { key: `last-from:${from}`, kind: 'tile', square: from, color: '#bfc084', opacity: 0.34 },
        { key: `last-to:${to}`, kind: 'tile', square: to, color: '#bfc084', opacity: 0.48 },
        {
          key: `last-mark:${to}`,
          kind: 'mark',
          square: to,
          color: '#e5d5a1',
          opacity: 0.94,
          enter: 'pop',
          delay: 60,
        },
      )
    }
    const selected = state.selected
    if (selected) {
      specs.push(
        { key: `sel-tile:${selected}`, kind: 'tile', square: selected, color: '#f3df9d', opacity: 0.42 },
        {
          key: `sel-ring:${selected}`,
          kind: 'ring',
          square: selected,
          color: '#fff0ba',
          opacity: 0.94,
          enter: 'pop',
        },
      )
      for (const move of state.legal) {
        const delay = Math.min(260, 30 + squareDistance(selected, move.to) * 34),
          hover = hoveredSquare === move.to,
          id = `${selected}>${move.to}`
        if (move.capture)
          specs.push(
            {
              key: `cap:${id}`,
              kind: 'capture',
              square: move.to,
              color: contrast ? '#941c18' : '#a6533e',
              opacity: 0.94,
              enter: 'pop',
              delay,
              hover,
            },
            { key: `cap-line:${id}`, kind: 'outline', square: move.to, color: '#e1b390', opacity: 1, delay },
          )
        else
          specs.push(
            {
              key: `dot:${id}`,
              kind: 'dot',
              square: move.to,
              color: contrast ? '#152d22' : '#375240',
              opacity: 0.94,
              enter: 'pop',
              delay,
              hover,
            },
            {
              key: `rim:${id}`,
              kind: 'rim',
              square: move.to,
              color: '#f8f1d9',
              opacity: 0.94,
              enter: 'pop',
              delay,
              hover,
            },
          )
      }
    }
    if (shown.check) {
      specs.push(
        {
          key: `check-tile:${shown.check}`,
          kind: 'tile',
          square: shown.check,
          color: '#b74832',
          opacity: 0.42,
        },
        {
          key: `check:${shown.check}`,
          kind: 'check',
          square: shown.check,
          color: '#f2b095',
          opacity: 0.94,
          enter: 'pop',
          pulse: true,
        },
      )
      for (const threat of shown.threats)
        specs.push({ key: `threat:${threat}`, kind: 'outline', square: threat, color: '#d98d69', opacity: 1 })
    }
    if (state.focused)
      specs.push({
        key: 'focus',
        kind: 'outline',
        square: state.focused,
        color: contrast ? '#000000' : '#ffffff',
        opacity: 1,
        glide: true,
      })
    highlights.set(specs)
    stage.invalidate()
  }

  // ——— the camera ———
  /** A mate has swung the camera in on the fallen king; a replay jumping away swings it back. */
  let framed = false
  function placeCamera(azimuth: number, polar: number) {
    camera.position.set(
      Math.sin(azimuth) * Math.sin(polar) * RADIUS,
      Math.cos(polar) * RADIUS,
      Math.cos(azimuth) * Math.sin(polar) * RADIUS,
    )
    camera.position.add(controls.target)
    camera.lookAt(controls.target)
  }
  const offset = new THREE.Vector3()
  /** Where the zoom is heading, so a flip mid-zoom keeps the zoom the viewer asked for. */
  let zoomGoal = 1
  /** The rig's orbit, at the site's motion preference: short and level when reduced. */
  function orbit(goal: Orbit) {
    const reduced = reducedMotion()
    if (goal.zoom !== undefined) zoomGoal = goal.zoom
    rig.orbit({ ...goal, ms: reduced ? 240 : (goal.ms ?? 950), swoop: reduced ? 0 : goal.swoop })
  }
  controls.addEventListener('change', () => stage.invalidate())
  stage.onResize((width, height) => {
    const aspect = width / height,
      // Narrow screens pull back a little so the trays stay in frame.
      span = Math.max(4.6, 6.6 / aspect)
    camera.left = -span * aspect
    camera.right = span * aspect
    camera.top = span
    camera.bottom = -span
    camera.updateProjectionMatrix()
  })

  // ——— pointer: taps, drags and hover ———
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -BOARD_Y),
    point = new THREE.Vector3()
  function boardPoint(event: { clientX: number; clientY: number }, height = BOARD_Y) {
    plane.constant = -height
    return stage.ray(event)?.intersectPlane(plane, point) ?? null
  }
  /** A piece first — but never one mid-flight, whose square is its destination — then the square under the pointer. */
  function pick(event: { clientX: number; clientY: number }) {
    const models: THREE.Object3D[] = []
    for (const actor of cast.actors.values())
      if (actor.state === 'board' && !actor.flights && actor !== drag?.actor && !actor.orient)
        models.push(actor.model)
    // The turned meshes themselves, so a click beside a queen's neck reaches the pawn behind it.
    let object: THREE.Object3D | null = stage.pick(event, models)[0]?.object ?? null
    while (object && !object.userData.actor) object = object.parent
    if (object) {
      const actor = object.userData.actor as Actor
      return { actor, square: squareOf(actor) }
    }
    const at = boardPoint(event)
    return { actor: null, square: at ? squareAt(at.x, at.z) : null }
  }
  const movable = (actor: Actor | null): actor is Actor =>
    !!actor && state.enabled && actor.color === state.game.turn && actor.color === state.seat
  const actorAt = (square: Square | null) => {
    const id = square ? state.game.pieces.find((p) => p.square === square)?.id : undefined
    return id ? (cast.actors.get(id) ?? null) : null
  }

  let pointers = 0,
    press: {
      x: number
      y: number
      time: number
      actor: Actor | null
      square: Square | null
      id: number
    } | null = null,
    drag: {
      actor: Actor
      from: Square
      pointer: number
      target: THREE.Vector3
      velocity: THREE.Vector3
      last: THREE.Vector3
    } | null = null,
    held: { actor: Actor; from: Square; to: Square } | null = null,
    hoverEvent: PointerEvent | null = null
  const down = (event: PointerEvent) => {
    // A new primary pointer means every earlier one has gone, whether or not we saw it leave.
    if (event.isPrimary) pointers = 0
    pointers++
    if (pointers > 1) {
      cancelDrag()
      press = null
      return
    }
    if (event.button !== 0) return
    const hit = pick(event),
      actor = movable(hit.actor) ? hit.actor : null
    press = {
      x: event.clientX,
      y: event.clientY,
      time: performance.now(),
      actor,
      square: hit.square,
      id: event.pointerId,
    }
    // Grabbing your own piece is a drag; anywhere else, the board orbits.
    if (actor) {
      controls.enabled = false
      canvas.setPointerCapture?.(event.pointerId)
    }
  }
  const move = (event: PointerEvent) => {
    hoverEvent = event
    if (press?.actor && !drag && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 6)
      startDrag(event)
    if (drag) dragTo(event)
  }
  const up = (event: PointerEvent) => {
    pointers = Math.max(0, pointers - 1)
    if (drag) endDrag()
    else if (
      press &&
      state.enabled &&
      Math.hypot(event.clientX - press.x, event.clientY - press.y) <= 7 &&
      performance.now() - press.time < 800
    ) {
      const square = pick(event).square
      if (square) events.select(square)
    }
    press = null
    controls.enabled = true
  }
  const cancel = () => {
    pointers = 0
    cancelDrag()
    press = null
    controls.enabled = true
  }
  const leave = () => {
    hoverEvent = null
    setHover(null, null)
  }
  function startDrag(event: PointerEvent) {
    const actor = press!.actor!,
      from = squareOf(actor)
    if (!from) return
    if (state.selected !== from) events.select(from)
    held = null
    drag = {
      actor,
      from,
      pointer: event.pointerId,
      target: actor.pos.clone(),
      velocity: new THREE.Vector3(),
      last: actor.pos.clone(),
    }
    actor.hover.target = DRAG_LIFT
    canvas.setPointerCapture?.(event.pointerId)
    canvas.style.cursor = 'grabbing'
  }
  function dragTo(event: PointerEvent) {
    const at = boardPoint(event, BOARD_Y + DRAG_LIFT)
    if (!at || !drag) return
    let x = THREE.MathUtils.clamp(at.x, -4.3, 4.3),
      z = THREE.MathUtils.clamp(at.z, -4.3, 4.3)
    // A legal square close by pulls the piece onto its centre.
    let best: { x: number; z: number; d: number } | null = null
    for (const move of state.legal) {
      const c = squareXZ(move.to),
        d = Math.hypot(c.x - x, c.z - z)
      if (d < 0.5 && (!best || d < best.d)) best = { ...c, d }
    }
    if (best) {
      const pull = 0.65 * (1 - best.d / 0.5)
      x = lerp(x, best.x, pull)
      z = lerp(z, best.z, pull)
    }
    drag.target.set(x, BOARD_Y, z)
    hoveredSquare = squareAt(x, z)
    paint()
  }
  function endDrag() {
    if (!drag) return
    const { actor, from, pointer } = drag,
      to = squareAt(actor.pos.x, actor.pos.z)
    drag = null
    if (canvas.hasPointerCapture?.(pointer)) canvas.releasePointerCapture(pointer)
    actor.tiltX.target = actor.tiltZ.target = 0
    if (to && to !== from && state.legal.some((m) => m.to === to)) {
      // Held over its new square until the server plays it (or the promotion is chosen).
      held = { actor, from, to }
      glide(actor, home(to), 140)
      actor.hover.target = 0.3
      events.select(to)
      later(400, () => {
        if (held?.actor === actor && !state.pending) {
          held = null
          returnHome(actor, from)
        }
      })
    } else returnHome(actor, from)
    hoveredSquare = null
    paint()
  }
  function cancelDrag() {
    if (!drag) return
    const { actor, from } = drag
    drag = null
    actor.tiltX.target = actor.tiltZ.target = 0
    returnHome(actor, from)
  }
  function glide(actor: Actor, to: THREE.Vector3, ms: number) {
    const start = actor.pos.clone()
    tweens.add({ duration: ms, ease: outCubic, update: (e) => void actor.pos.lerpVectors(start, to, e) })
  }
  function returnHome(actor: Actor, square: Square) {
    actor.hover.target = state.selected === square ? 0.16 : 0
    if (actor.pos.distanceTo(home(square)) > 0.01)
      cast.travel(actor, home(square), { quiet: true, height: 0.12, duration: 260 })
  }
  function setHover(actor: Actor | null, square: Square | null) {
    if (actor === hoveredActor && square === hoveredSquare) return
    hoveredActor = actor
    hoveredSquare = square
    lifts()
    paint()
  }
  function hoverStep() {
    if (!hoverEvent || drag) return
    const event = hoverEvent
    hoverEvent = null
    const hit = pick(event),
      own = movable(hit.actor) ? hit.actor : null,
      legal = hit.square && state.legal.some((m) => m.to === hit.square) ? hit.square : null
    setHover(own, legal)
    canvas.style.cursor = own || (legal && state.enabled) ? 'pointer' : 'grab'
  }

  /** Hover, selection and optimistic lifts, all as spring targets. */
  function lifts() {
    const selected = actorAt(state.selected),
      pending = state.pending ? actorAt(state.pending.from) : null,
      reduced = reducedMotion()
    for (const actor of cast.actors.values()) {
      if (drag?.actor === actor) continue
      let lift = 0
      if (actor === pending || held?.actor === actor) lift = 0.3
      else if (actor === selected) lift = reduced ? 0.08 : 0.16
      else if (actor === hoveredActor && state.enabled) lift = reduced ? 0 : 0.07
      actor.hover.target = lift
      actor.bob = actor === selected && !reduced && !pending ? 1 : 0
    }
  }

  // ——— the frame ———
  /** A replay's playback rate; see `play`. Everything the queue and tweens time runs at it. */
  let pace = 1,
    shown1 = false
  let showcaseVisible = true,
    showcaseClock = 0
  const visibility = options.showcase
    ? new IntersectionObserver(([entry]) => {
        showcaseVisible = entry.isIntersecting
      })
    : null
  visibility?.observe(container)
  const removeFrame = stage.onFrame((dt, now) => {
    // Opened mid-move, the board keeps time with the room: what the stage's capped frames skipped
    // (shaders compiling as it starts) is made up, so the move lands when it does for everyone else.
    const ms = (dt * 1000 + (syncing ? stage.takeDrift() : 0)) * pace
    if (!shown1) {
      shown1 = true
      // Drawn straight after the frame callbacks; the next frame is the first one seen.
      requestAnimationFrame(() => events.ready?.())
    }
    tweens.speed = queue.speed
    let moving = queue.step(ms)
    if (tweens.step(ms)) moving = true
    presenting()
    hoverStep()
    if (drag) {
      const { actor } = drag
      drag.last.copy(actor.pos)
      actor.pos.lerp(drag.target, reducedMotion() ? 1 : dampFactor(28, dt))
      if (dt > 0) drag.velocity.subVectors(actor.pos, drag.last).divideScalar(dt)
      if (!reducedMotion()) {
        // The piece swings from where it is held: its top trails the way it moves.
        actor.tiltZ.target = THREE.MathUtils.clamp(drag.velocity.x * 0.045, -0.38, 0.38)
        actor.tiltX.target = THREE.MathUtils.clamp(-drag.velocity.z * 0.045, -0.38, 0.38)
      }
      moving = true
    }
    if (cast.step(dt, now)) moving = true
    if (highlights.step(dt)) moving = true
    if (particles.step(dt)) moving = true
    if (controls.update()) moving = true
    if (rig.step(dt)) moving = true
    if (options.showcase && showcaseVisible && !reducedMotion() && !rig.busy) {
      // The lobby's board turns slowly while it is on screen, drawn at half rate.
      offset
        .subVectors(camera.position, controls.target)
        .applyAxisAngle(new THREE.Vector3(0, 1, 0), dt * 0.08)
      camera.position.copy(controls.target).add(offset)
      camera.lookAt(controls.target)
      showcaseClock += ms
      if (showcaseClock >= 33) {
        showcaseClock = 0
        moving = true
      }
    }
    return moving
  })

  container.addEventListener('pointerdown', down, { capture: true })
  canvas.addEventListener('pointermove', move)
  canvas.addEventListener('pointerup', up)
  canvas.addEventListener('pointercancel', cancel)
  canvas.addEventListener('pointerleave', leave)
  const stopMotion = onMotionChange(() => {
    if (reducedMotion()) {
      tweens.finishAll()
      particles.clear()
    }
    lifts()
    stage.invalidate()
  })

  // A slow device draws a smaller shadow map; at the lowest tier the stage drops shadows itself.
  // A visit that was already slow on an earlier board starts here rather than finding out again.
  function fitQuality(tier: number) {
    if (tier > 1 || key.shadow.mapSize.x <= 1024) return
    key.shadow.mapSize.set(1024, 1024)
    key.shadow.map?.dispose()
    key.shadow.map = null
  }
  fitQuality(stage.quality)
  const stopQuality = stage.onQuality(fitQuality)
  // A slow device keeps every moment, with less paper and dust in the air.
  particles.density = qualityDensity(stage.quality)
  const stopDensity = stage.onQuality((tier) => void (particles.density = qualityDensity(tier)))

  // Read now, as the board is about to start, by the server's clock carried on from the snapshot's arrival.
  const since = options.timing && serverNow(options.timing)! - options.timing.since
  const live =
    !options.showcase && since !== undefined && since < LIVE_MOVE_MS && initial.game.history.length > 0
  build(live ? beforeLast(initial.game) : initial.game)
  if (live) {
    // Opened mid-move: the move starts over from where the server's clock says it has got to.
    queued = beforeLast(initial.game)
    syncing = true
    tell(initial.game)
    queue.step(since)
    tweens.step(since)
  }
  lifts()
  paint()
  stage.start()

  return {
    update(next) {
      const previous = state
      state = next
      if (theme !== next.preferences.theme) {
        theme = next.preferences.theme
        scene.remove(board)
        disposeTree(board)
        board = makeBoard(theme).board
        scene.add(board)
        paintTrays()
        // Each piece keeps its pose and whatever it was doing; only its turned wood changes.
        cast.retheme()
      }
      if (next.game !== previous.game) for (const game of unseen(next)) tell(game)
      if (held && (!next.pending || next.pending.from !== held.from)) {
        const { actor, from } = held
        held = null
        if (next.game === previous.game || next.game.history.length === previous.game.history.length)
          returnHome(actor, from)
      }
      if (next.selected !== previous.selected || next.enabled !== previous.enabled) {
        hoveredSquare = null
        if (!next.enabled) hoveredActor = null
      }
      lifts()
      paint()
    },
    flip(next) {
      if (next === black) return
      black = next
      orbit({
        azimuth: VIEW.azimuth(black),
        polar: VIEW.polar,
        target: TARGET,
        zoom: rig.busy ? zoomGoal : camera.zoom,
        swoop: 0.32,
        ms: 1150,
      })
    },
    zoom(amount) {
      const from = rig.busy ? zoomGoal : camera.zoom
      orbit({ zoom: THREE.MathUtils.clamp(from + amount * 0.15, 0.75, 1.65), ms: 320 })
    },
    reset() {
      orbit({ azimuth: VIEW.azimuth(black), polar: VIEW.polar, zoom: 1, target: TARGET, ms: 800 })
    },
    top() {
      orbit({ azimuth: black ? Math.PI : 0, polar: 0.04, ms: 800 })
    },
    land(game) {
      pace = 1
      // Queued first, so the queue running dry reconciles against where the board is going.
      queued = game
      state = { ...state, game }
      muted = true
      queue.clear()
      tweens.cancelAll()
      particles.clear()
      build(game)
      muted = false
      if (framed && !rig.userControlled)
        orbit({ azimuth: VIEW.azimuth(black), polar: VIEW.polar, zoom: 1, target: TARGET, ms: 600 })
      framed = false
      lifts()
      paint()
    },
    play(game, { rate, withinMs }) {
      if (queue.busy) {
        // A beat still running when the next state comes is cut short, not queued behind.
        muted = true
        queue.flush()
        tweens.finishAll()
        muted = false
      }
      state = { ...state, game }
      pace = 1
      const told = tell(game)
      // The first beat has started (the queue was idle); any after it are guessed at its length.
      const natural = told.ms * (1 + queue.length)
      pace = Math.max(rate, natural / Math.max(1, withinMs))
      lifts()
      paint()
    },
    dispose() {
      removeFrame()
      stopQuality()
      stopDensity()
      stopMotion()
      visibility?.disconnect()
      container.removeEventListener('pointerdown', down, { capture: true })
      canvas.removeEventListener('pointermove', move)
      canvas.removeEventListener('pointerup', up)
      canvas.removeEventListener('pointercancel', cancel)
      canvas.removeEventListener('pointerleave', leave)
      stopIdle()
      queue.clear()
      tweens.cancelAll()
      rig.dispose()
      controls.dispose()
      highlights.dispose()
      particles.dispose()
      cast.dispose()
      stage.dispose()
    },
  }
}
