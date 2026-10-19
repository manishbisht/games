import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { beatElapsed } from '@games/shared/protocol'
import type { BeatTiming } from '@games/shared/protocol'
import { PALETTES, PLAYER_IDS, spaceCoordinates } from '@games/shared/wildrise/board'
import type { GameState, PlayerId } from '@games/shared/wildrise/types'
import { createCameraRig } from '../../../motion/camera'
import { createDieThrow } from '../../../motion/dice'
import {
  arc,
  clamp01,
  damp,
  dampFactor,
  inOutSine,
  lerp,
  outCubic,
  outQuad,
  smooth,
  spring,
  squash,
  stepSpring,
} from '../../../motion/ease'
import { createParticles, qualityDensity } from '../../../motion/particles'
import { onMotionChange, reducedMotion } from '../../../motion/preference'
import { allowPageScroll, createStage, onTap } from '../../../motion/stage'
import type { QualityTier } from '../../../motion/stage'
import { createQueue, createTweens } from '../../../motion/tween'
import type { Cue } from '../game/audio'
import { createAmbient } from './ambient'
import {
  box,
  bulge,
  dieQuaternion,
  ladderPoint,
  makeBoard,
  makeDie,
  makeLadder,
  makePlant,
  makeSnake,
  makeToken,
  material,
  slither,
} from './models'
import type { Ladder, Snake } from './models'
import { plan } from './story'
import type { Beat, Squares } from './story'

export interface SceneHandlers {
  onRoll: () => void
  /** `pan` is where on screen it happened, -1 left to 1 right. */
  onCue: (cue: Cue, n?: number, pan?: number) => void
  /** Where each token stands on screen, every time one lands somewhere new. */
  onPositions: (squares: Squares) => void
}
export interface SceneApi {
  /**
   * `timing` is the room's word on how far into `state` it already is, as of
   * `receivedAt` (`performance.now()` when the state reached this browser).
   */
  update: (state: GameState, timing?: BeatTiming, receivedAt?: number) => void
  setRunning: (running: boolean) => void
  /** Whether a tap on the die would roll it: it lifts and glows under the pointer. */
  setCanRoll: (can: boolean) => void
  /** This browser asked for a roll; rattle the die until the server's number arrives. */
  rolling: () => void
  reset: () => void
  top: () => void
  rotate: (direction: number) => void
  zoom: (direction: number) => void
  dispose: () => void
}

/** Board coordinates of every square, worked out once (index 0 unused). */
const SQUARE_X = new Float32Array(101),
  SQUARE_Z = new Float32Array(101)
for (let n = 1; n <= 100; n++) {
  const { x, z } = spaceCoordinates(n)
  SQUARE_X[n] = x
  SQUARE_Z[n] = z
}
const BOARD_Y = 0.238,
  CAMP_Y = -0.54
/** Up to four tokens share a square, fanned out so each stays readable. */
const RING = [
  [],
  [[0, 0]],
  [
    [-0.2, 0.12],
    [0.2, -0.12],
  ],
  [
    [-0.21, 0.15],
    [0.21, 0.15],
    [0, -0.2],
  ],
  [
    [-0.2, 0.19],
    [0.2, 0.19],
    [-0.2, -0.19],
    [0.2, -0.19],
  ],
]
/** The way a token faces when it is simply standing: towards the default camera. */
const REST_YAW = 0.2
const COLORS = Object.fromEntries(
  PLAYER_IDS.map((id) => [id, new THREE.Color(PALETTES[id].color)]),
) as Record<PlayerId, THREE.Color>

interface Token {
  id: PlayerId
  camp: number
  group: THREE.Group
  /** A beat is posing it this frame; otherwise it eases to its place on its own. */
  driven: boolean
  yaw: number
  yawGoal: number
  /** Added on top of `yaw` by a beat: a head-shake, a spin. */
  spin: number
  /** The floor under it, which the turn halo sits on. */
  ground: number
  /** Landing wobble: squash on `y`, spring back. */
  wobble: ReturnType<typeof spring>
  presence: ReturnType<typeof spring>
}

/**
 * How a beat is played: `live` at the table's pace; `catch-up` quickly, for a
 * story whose timing the room didn't give; `past` landed at once, because the
 * room is already beyond it.
 */
type Pace = 'live' | 'catch-up' | 'past'

export function createScene(
  container: HTMLElement,
  initial: GameState,
  handlers: SceneHandlers,
  timing?: BeatTiming,
  receivedAt?: number,
): SceneApi {
  const stage = createStage(container, {
    label:
      'Wildrise 3D board with 100 numbered spaces. Drag to rotate, pinch or scroll to zoom. Use Roll dice or press Space to play.',
    maxPixelRatio: 1.7,
    exposure: 0.9,
    environmentIntensity: 0.32,
  })
  const { scene, renderer } = stage
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  /** The camera or the canvas changed: where the die sits on screen needs saying again. */
  let markDie = true,
    tier: QualityTier = stage.quality,
    silent = false

  // ── Camera ──────────────────────────────────────────────────────────────
  const camera = new THREE.OrthographicCamera(-9, 9, 8, -8, 0.1, 100)
  const home = new THREE.Vector3(3.4, 19, 13.5),
    homeTarget = new THREE.Vector3(0.2, 0, 0.4)
  camera.position.copy(home)
  stage.setCamera(camera)
  const controls = new OrbitControls(camera, stage.canvas)
  controls.target.copy(homeTarget)
  controls.enableDamping = true
  controls.dampingFactor = 0.1
  controls.enablePan = false
  controls.minPolarAngle = 0.02
  controls.maxPolarAngle = Math.PI / 2.6
  controls.minZoom = 0.65
  controls.maxZoom = 2.4
  controls.rotateSpeed = 0.5
  controls.zoomSpeed = 0.65
  allowPageScroll(stage.canvas)
  const rig = createCameraRig(camera, controls)
  stage.onResize((w, h) => {
    markDie = true
    const aspect = w / h,
      halfH = Math.max(6.65, 7.35 / aspect)
    camera.left = -halfH * aspect
    camera.right = halfH * aspect
    camera.top = halfH
    camera.bottom = -halfH
    camera.updateProjectionMatrix()
  })

  // ── Table ───────────────────────────────────────────────────────────────
  scene.add(new THREE.HemisphereLight('#fffae8', '#908a72', 1.25))
  const key = new THREE.DirectionalLight('#fff4db', 2)
  key.position.set(-6, 15, 8)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  key.shadow.normalBias = 0.025
  key.shadow.bias = -0.0002
  Object.assign(key.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10, near: 0.5, far: 40 })
  key.shadow.radius = 3
  scene.add(key)
  const fill = new THREE.DirectionalLight('#d8e4ef', 0.65)
  fill.position.set(9, 10, -6)
  scene.add(fill)
  const table = box(80, 0.4, 80, '#e7decc', 0.05)
  table.position.y = -0.75
  scene.add(table)
  const seamGeometry = new THREE.BoxGeometry(0.012, 0.001, 80),
    seamMaterial = material('#cfc3ad')
  for (let i = -4; i <= 4; i++) {
    const seam = new THREE.Mesh(seamGeometry, seamMaterial)
    seam.position.set(i * 6.5, -0.548, 0)
    scene.add(seam)
  }
  const board = makeBoard(initial)
  scene.add(board.group)
  const finish = board.tiles[99].material
  finish.emissive.set('#f2c25a')
  const snakes = new Map<number, Snake>(),
    ladders = new Map<number, Ladder>()
  for (const route of initial.board.snakes) {
    const snake = makeSnake(route)
    snakes.set(route.from, snake)
    scene.add(snake.group)
  }
  for (const route of initial.board.ladders) {
    const ladder = makeLadder(route)
    ladders.set(route.from, ladder)
    scene.add(ladder.group)
  }
  const plants = [makePlant(-7.25, -5.6, 1.4), makePlant(7.0, -6.0, 0.9)]
  for (const plant of plants) scene.add(plant.group)
  const coaster = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.73, 0.07, 40), material('#bc956b'))
  coaster.position.set(-7.3, -0.51, 3.7)
  scene.add(coaster)
  const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.48, 0.39, 0.7, 40), material('#eee8d9', 0.25))
  cup.position.set(-7.3, -0.13, 3.7)
  cup.castShadow = true
  scene.add(cup)
  const tea = new THREE.Mesh(new THREE.CircleGeometry(0.425, 40), material('#806347', 0.15))
  tea.rotation.x = -Math.PI / 2
  tea.position.set(-7.3, 0.227, 3.7)
  scene.add(tea)
  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.072, 12, 32), material('#eee8d9', 0.25))
  handle.position.set(-7.8, -0.06, 3.7)
  scene.add(handle)
  const tray = box(1.65, 0.12, 1.65, '#8a6549', 0.16)
  tray.position.set(6.55, -0.43, 3.7)
  scene.add(tray)
  const felt = box(1.42, 0.03, 1.42, '#687b5f', 0.12)
  felt.position.set(6.55, -0.355, 3.7)
  scene.add(felt)
  const ambient = createAmbient(scene, { plants, cup: tea.position })

  // ── Die ─────────────────────────────────────────────────────────────────
  const die = makeDie(),
    dieRest = new THREE.Vector3(6.55, 0.09, 3.7),
    dieBody = die.children[0] as THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>
  dieBody.material.emissive.set('#f6d27c')
  die.position.copy(dieRest)
  die.quaternion.copy(dieQuaternion(initial.dice || 1))
  scene.add(die)
  let dieValue = initial.dice || 1,
    shakingUntil = 0,
    canRoll = false,
    hovered = false,
    dieLift = 0,
    dieGlow = 0
  const dieThrow = createDieThrow(die, {
    rest: dieRest,
    face: dieQuaternion,
    size: 0.86,
    // Tossed in from the player's side of the tray. The toss rises from
    // wherever the die was let go, so it can start high for a real arc; it is
    // the first bounce, ~28% of the way back, that has to land on the felt —
    // the tray is barely wider than the die.
    release: new THREE.Vector3(-0.4, 2.5, 0.95),
    onContact: (strength) => {
      cue('die', strength, die.position)
      if (strength > 0.5) puff(die.position.x, -0.33, die.position.z, 7, 0.7)
    },
  })

  // ── Tokens, halo, particles ─────────────────────────────────────────────
  const tokens = new Map<PlayerId, Token>()
  PLAYER_IDS.forEach((id, camp) => {
    const group = makeToken(id)
    group.rotation.order = 'YXZ'
    group.visible = false
    group.scale.setScalar(0)
    scene.add(group)
    tokens.set(id, {
      id,
      camp,
      group,
      driven: false,
      yaw: REST_YAW,
      yawGoal: REST_YAW,
      spin: 0,
      ground: CAMP_Y,
      wobble: spring(1),
      presence: spring(0),
    })
  })
  const haloMaterial = new THREE.MeshBasicMaterial({
    color: COLORS.red.clone(),
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
    depthWrite: false,
  })
  const halo = new THREE.Mesh(new THREE.RingGeometry(0.29, 0.34, 48), haloMaterial)
  halo.rotation.x = -Math.PI / 2
  halo.visible = false
  scene.add(halo)
  const targetMaterial = haloMaterial.clone()
  targetMaterial.color.set('#fff1b8')
  targetMaterial.opacity = 0
  const targetRing = new THREE.Mesh(new THREE.RingGeometry(0.31, 0.36, 48), targetMaterial)
  targetRing.rotation.x = -Math.PI / 2
  targetRing.visible = false
  scene.add(targetRing)
  // Confetti settles on the board; dust rises off whatever it was kicked up from.
  const particles = createParticles(scene, { max: 520 })
  const DUST = ['#efe4cb', '#dccba6', '#f6efe0']
  const origin = new THREE.Vector3()
  function puff(x: number, y: number, z: number, count: number, size = 1) {
    if (reduced || silent) return
    particles.burst({
      origin: origin.set(x, y, z),
      kind: 'dust',
      count,
      colors: DUST,
      speed: 1.5,
      size: size * 0.85,
      life: 0.55,
      spread: 1,
    })
  }

  // ── Presentation state ──────────────────────────────────────────────────
  let state = initial,
    previous: GameState | null = null,
    story: Squares = {},
    reduced = reducedMotion(),
    boost = 1,
    active: PlayerId = initial.players[initial.currentPlayer].id,
    winner: PlayerId | null = null,
    lastAmbient = -1e9,
    disposed = false
  /** Where each token stands on screen right now; beats move it square by square. */
  const shown: Squares = {}
  const tweens = createTweens(),
    queue = createQueue({ catchUpAfter: 2, catchUpSpeed: 2.5 })
  const press = new Float32Array(101)
  const heard = new THREE.Vector2()
  /** A sound is placed where it happened on screen, a little: never hard left or right. */
  const cue = (kind: Cue, n?: number, at?: THREE.Vector3) => {
    if (silent) return
    const width = stage.size.width
    const pan =
      at && width ? THREE.MathUtils.clamp((stage.toScreen(at, heard).x / width) * 2 - 1, -1, 1) * 0.6 : 0
    handlers.onCue(kind, n, pan)
  }
  const emit = () => handlers.onPositions({ ...shown })

  /** A token's resting place on `square`, fanned out among whoever else stands there. */
  function slot(id: PlayerId, square: number, out: THREE.Vector3) {
    const token = tokens.get(id)!
    if (!square) return out.set(-2.1 + token.camp * 0.8, CAMP_Y, 6.2)
    let count = 0,
      index = 0
    for (const p of state.players) {
      if ((p.id === id ? square : shown[p.id]) !== square) continue
      if (p.id === id) index = count
      count++
    }
    const [dx, dz] = RING[Math.max(1, count)][index] ?? [0, 0]
    return out.set(SQUARE_X[square] + dx, BOARD_Y - press[square], SQUARE_Z[square] + dz)
  }
  const yawTo = (from: THREE.Vector3, to: THREE.Vector3, fallback: number) => {
    const dx = to.x - from.x,
      dz = to.z - from.z
    return dx * dx + dz * dz < 1e-4 ? fallback : Math.atan2(dx, dz)
  }
  /** The shortest way round from one heading to another. */
  const turnToward = (from: number, to: number) => from + Math.atan2(Math.sin(to - from), Math.cos(to - from))

  function land(token: Token, square: number, strength: number) {
    shown[token.id] = square
    emit()
    if (square) pressTile(square, strength)
    if (!reduced) token.wobble.velocity -= 3.2 * strength
  }
  function pressTile(square: number, strength: number) {
    if (reduced) return
    tweens.add({
      duration: 360,
      update: (_, t) => {
        press[square] =
          t < 0.18
            ? (t / 0.18) * 0.03 * strength
            : 0.03 * strength * Math.cos(((t - 0.18) / 0.82) * Math.PI * 1.5) * (1 - t)
      },
      done: () => void (press[square] = 0),
    })
  }

  /**
   * One hop between two points, at progress `u`: a crouch, a stretch on take-off,
   * a parabolic flight and a squash on landing. A `leap` rises before it travels,
   * which is what carries a token off the table and over the board's frame.
   */
  function hop(
    token: Token,
    from: THREE.Vector3,
    to: THREE.Vector3,
    u: number,
    height: number,
    leap = false,
  ) {
    const air = clamp01((u - 0.12) / 0.7),
      along = leap ? smooth(air) : air,
      rise = leap ? outQuad(air) : air
    const g = token.group
    g.position.lerpVectors(from, to, along)
    g.position.y = lerp(from.y, to.y, rise) + (reduced ? 0 : arc(air, height))
    token.ground = lerp(from.y, to.y, along)
    const [xz, y] = reduced ? [1, 1] : squash(u, leap ? 1.2 : 0.9)
    g.scale.set(xz, y, xz)
  }

  // ── Camera direction ────────────────────────────────────────────────────
  let followFrom: { target: THREE.Vector3; zoom: number } | null = null,
    touched = false
  controls.addEventListener('start', () => {
    touched = true
  })
  // A move is framed between the board's centre and the token, so the board
  // stays in view; a win is framed on the winner alone.
  const focus = new THREE.Vector3(),
    focusOn: { token: Token | null; share: number } = { token: null, share: 0.55 }
  const followPoint = () => {
    const token = focusOn.token
    if (!token) return null
    return focus.copy(homeTarget).lerp(token.group.position, focusOn.share).setY(0)
  }
  function follow(token: Token, zoom: number, share = 0.55) {
    if (reduced) return
    if (!followFrom) {
      followFrom = { target: controls.target.clone(), zoom: camera.zoom }
      touched = false
    }
    focusOn.token = token
    focusOn.share = share
    rig.follow(followPoint, { rate: 2.6, zoom: Math.max(followFrom.zoom, zoom) })
  }
  const back = new THREE.Vector3()
  function release() {
    if (!followFrom) return
    rig.follow(null)
    focusOn.token = null
    if (!touched) {
      back.subVectors(followFrom.target, controls.target).add(camera.position)
      rig.to({ target: followFrom.target, position: back, zoom: followFrom.zoom }, 2.4)
    }
    followFrom = null
  }

  // ── Beats ───────────────────────────────────────────────────────────────
  /**
   * Brings every token to the square the state says it starts this beat on.
   * When the room is already beyond it (`past`), nobody re-hops a walk the
   * table has seen: the token about to move is put straight on its square, so
   * its beat starts from the right place, and the rest glide there.
   */
  function arrive(beat: Extract<Beat, { kind: 'arrive' }>, past: boolean) {
    for (const id of beat.gone) {
      const token = tokens.get(id)!
      token.presence.target = 0
      delete shown[id]
    }
    // Everyone new takes their square first, so the fan-out on a shared one is final.
    for (const { id, from, to } of beat.moves) if (from === undefined || past) shown[id] = to
    const mover = state.players[state.currentPlayer].id
    beat.moves.forEach(({ id, from, to }, order) => {
      const token = tokens.get(id)!
      token.presence.target = 1
      if (past && from !== undefined) {
        if (id === mover && !token.driven) {
          slot(id, to, token.group.position)
          token.ground = token.group.position.y
        }
        return
      }
      if (from === undefined) {
        // A new token appears in its place with a pop rather than sliding in from nowhere.
        slot(id, to, token.group.position)
        token.ground = token.group.position.y
        if (reduced) token.presence.value = 1
        return
      }
      const start = token.group.position.clone(),
        end = new THREE.Vector3(),
        leap = from === 0 || to === 0
      token.driven = true
      tweens.add({
        duration: beat.ms * 0.8,
        delay: order * beat.ms * 0.05,
        start: () => {
          slot(id, to, end)
          token.yawGoal = yawTo(start, end, token.yawGoal)
        },
        update: (_, u) => hop(token, start, end, u, leap ? 0.95 : 0.6, leap),
        done: () => {
          token.driven = false
          token.yawGoal = REST_YAW
          land(token, to, 0.6)
        },
      })
    })
    emit()
  }

  function roll(value: number, ms: number) {
    dieValue = value
    shakingUntil = 0
    if (reduced) dieThrow.settle(value)
    else dieThrow.throw(value, Math.min(950, ms * 0.86))
  }

  /** The hop weights of a walk: leaving camp takes longer, being a real leap. */
  function walk(beat: Extract<Beat, { kind: 'walk' }>) {
    const token = tokens.get(beat.id)!,
      { path } = beat
    const weights = path.map((_, i) => (i === 0 && beat.from === 0 ? 1.8 : 1)),
      total = weights.reduce((a, b) => a + b, 0)
    const bounds = weights.map((_, i) => weights.slice(0, i + 1).reduce((a, b) => a + b, 0) / total)
    const from = new THREE.Vector3(),
      to = new THREE.Vector3()
    let hopIndex = -1
    token.driven = true
    follow(token, 1.14)
    const begin = (i: number) => {
      from.copy(token.group.position)
      slot(token.id, path[i], to)
      token.yawGoal = yawTo(from, to, token.yawGoal)
      hopIndex = i
    }
    tweens.add({
      duration: beat.ms,
      update: (_, raw) => {
        let i = 0
        while (i < path.length - 1 && raw > bounds[i]) i++
        // A long frame (or a catch-up) can cross several squares at once:
        // every square in between still gets landed on, so the count is right.
        while (hopIndex < i) {
          if (hopIndex >= 0) {
            hop(token, from, to, 1, 0)
            land(token, path[hopIndex], 0.35)
            cue('step', hopIndex, token.group.position)
          }
          begin(hopIndex + 1)
        }
        const start = i === 0 ? 0 : bounds[i - 1],
          u = clamp01((raw - start) / (bounds[i] - start))
        const leap = beat.from === 0 && i === 0
        hop(token, from, to, u, leap ? 0.95 : i === path.length - 1 ? 0.34 : 0.28, leap)
      },
      done: () => {
        const last = path[path.length - 1]
        token.driven = false
        land(token, last, 1)
        cue('step', path.length - 1, to)
        cue('land', 0, to)
        puff(to.x, BOARD_Y + 0.02, to.z, 9)
        const snake = snakes.get(last)
        if (snake) alert(snake)
        else if (!ladders.has(last)) token.yawGoal = REST_YAW
      },
    })
  }

  // Each snake's head pose, eased by beats and written once a frame.
  const heads = new Map<Snake, { rear: number; lunge: number; pitch: number; jaw: number; tongue: number }>()
  for (const snake of snakes.values()) heads.set(snake, { rear: 0, lunge: 0, pitch: 0, jaw: 0, tongue: 0 })
  let riding: Snake | null = null
  /** A token has landed on its head: it rears back, mouth open — the bite is coming. */
  function alert(snake: Snake) {
    if (reduced) return
    const head = heads.get(snake)!,
      from = { ...head }
    tweens.add({
      duration: 260,
      ease: outCubic,
      update: (t) => {
        head.rear = lerp(from.rear, 0.55, t)
        head.pitch = lerp(from.pitch, -0.35, t)
        head.jaw = lerp(from.jaw, 0.45, t)
        head.tongue = Math.sin(t * Math.PI)
      },
    })
  }

  function ride(beat: Extract<Beat, { kind: 'ride' }>) {
    const token = tokens.get(beat.id)!
    token.driven = true
    const start = token.group.position.clone(),
      end = slot(token.id, beat.to, new THREE.Vector3())
    targetRing.position.set(SQUARE_X[beat.to], BOARD_Y + 0.006, SQUARE_Z[beat.to])
    targetRing.visible = true
    if (beat.type === 'ladder') climb(token, ladders.get(beat.from)!, start, end, beat)
    else slide(token, snakes.get(beat.from)!, start, end, beat)
  }

  type Ride = Extract<Beat, { kind: 'ride' }>
  function climb(token: Token, ladder: Ladder, start: THREE.Vector3, end: THREE.Vector3, beat: Ride) {
    const { rungs, route } = ladder,
      a = new THREE.Vector3(),
      b = new THREE.Vector3(),
      top = ladderPoint(route, 1, new THREE.Vector3())
    top.y += 0.045
    let rung = -1
    follow(token, 1.32)
    cue('ladder', 0, start)
    token.yawGoal = turnToward(token.yaw, ladder.yaw)
    tweens.add({
      duration: beat.ms,
      update: (_, t) => {
        const g = token.group
        targetMaterial.opacity = 0.85 * clamp01(t / 0.1) * clamp01((1 - t) / 0.08)
        g.rotation.z = 0
        if (t < 0.12) {
          ladderPoint(route, 0, a).y += 0.045
          hop(token, start, a, t / 0.12, 0.2)
          return
        }
        if (t < 0.86) {
          // Rung by rung, leaning into each step, alternating sides.
          const s = ((t - 0.12) / 0.74) * rungs,
            k = Math.min(rungs - 1, Math.floor(s)),
            u = s - k
          ladderPoint(route, k / rungs, a).y += 0.045
          ladderPoint(route, (k + 1) / rungs, b).y += 0.045
          g.position.lerpVectors(a, b, reduced ? u : smooth(u))
          token.ground = g.position.y
          if (reduced) return
          g.position.y += arc(u, 0.075)
          g.rotation.z = (k % 2 ? 1 : -1) * 0.16 * Math.sin(u * Math.PI)
          const [xz, y] = squash(u, 0.6)
          g.scale.set(xz, y, xz)
          ladder.group.position.y = -0.012 * Math.max(0, 1 - u * 3)
          if (k !== rung) {
            rung = k
            cue('rung', k, g.position)
          }
          return
        }
        ladder.group.position.y = 0
        hop(token, top, end, (t - 0.86) / 0.14, 0.32)
        token.yawGoal = turnToward(token.yaw, REST_YAW)
      },
      done: () => {
        token.driven = false
        token.group.rotation.z = 0
        ladder.group.position.y = 0
        targetRing.visible = false
        land(token, beat.to, 1.2)
        if (!reduced) token.wobble.velocity -= 1.5
        puff(end.x, BOARD_Y + 0.02, end.z, 10)
        cue('land', 0, end)
      },
    })
  }

  function slide(token: Token, snake: Snake, start: THREE.Vector3, end: THREE.Vector3, beat: Ride) {
    const head = heads.get(snake)!,
      from = { ...head },
      motion = snake.motion,
      curve = snake.curve
    const point = new THREE.Vector3(),
      tangent = new THREE.Vector3(),
      tail = curve.getPointAt(1, new THREE.Vector3())
    let bitten = false,
      slid = false,
      flicked = false
    riding = snake
    follow(token, 1.26)
    cue('snake', 0, start)
    snake.skin.emissiveIntensity = snake.body.emissiveIntensity = 0.18
    const onBody = (r: number, out: THREE.Vector3) => {
      curve.getPointAt(r, out)
      curve.getTangentAt(r, tangent)
      const length = Math.hypot(tangent.x, tangent.z) || 1,
        lateral = slither(r, motion)
      out.x += (-tangent.z / length) * lateral
      out.z += (tangent.x / length) * lateral
      out.y += 0.125 * (1 - 0.84 * r ** 3) + bulge(r, motion) - 0.02
      return out
    }
    tweens.add({
      duration: beat.ms,
      update: (_, t) => {
        const g = token.group
        motion.time = (t * beat.ms) / 1000
        targetMaterial.opacity = 0.85 * clamp01(t / 0.1) * clamp01((1 - t) / 0.08)
        g.rotation.x = 0
        if (t < 0.2) {
          // The strike: rear back with the mouth open, then lunge and snap shut.
          if (t < 0.09) {
            const e = outCubic(t / 0.09)
            head.rear = lerp(from.rear, 0.7, e)
            head.pitch = lerp(from.pitch, -0.5, e)
            head.jaw = lerp(from.jaw, 1, e)
            head.lunge = 0
          } else {
            const e = clamp01((t - 0.09) / 0.07)
            head.rear = lerp(0.7, 0, e * e)
            head.lunge = Math.sin(e * Math.PI) * 0.18
            head.pitch = lerp(-0.5, 0.2, e)
            head.jaw = e < 0.75 ? 1 : 1 - (e - 0.75) / 0.25
          }
          head.tongue = 0
          // The token flinches as it comes, then is scooped onto the body.
          if (t < 0.16) {
            const u = t / 0.16
            g.position.copy(start)
            g.position.y += reduced ? 0 : arc(u, 0.16)
            const stretch = 1 + Math.sin(u * Math.PI) * 0.14
            g.scale.set(1 / Math.sqrt(stretch), stretch, 1 / Math.sqrt(stretch))
          } else {
            if (!bitten) {
              bitten = true
              cue('bite', 0, start)
              if (!reduced && !silent) rig.shake(0.1, 240)
              follow(token, 1.4)
            }
            hop(token, start, onBody(0, point), (t - 0.16) / 0.04, 0.12)
          }
          token.ground = g.position.y
          return
        }
        if (t < 0.88) {
          if (!slid) {
            slid = true
            cue('slide', ((0.88 - t) * beat.ms) / Math.max(0.01, tweens.speed * boost), g.position)
          }
          const r = inOutSine((t - 0.2) / 0.68)
          motion.wave = reduced ? 0 : 0.055 * Math.sin(Math.min(1, (t - 0.2) / 0.1) * (Math.PI / 2))
          motion.bulge = reduced ? 0 : 0.06
          motion.bulgeAt = r
          const back = clamp01((t - 0.2) / 0.15)
          head.rear = 0
          head.lunge = lerp(head.lunge, 0, back)
          head.pitch = lerp(0.2, 0, back)
          head.jaw = 0
          onBody(r, g.position)
          token.ground = g.position.y
          token.yawGoal = Math.atan2(tangent.x, tangent.z)
          if (!reduced) {
            // Belly-first down the coils: pitched with the slope, rocking on the turns.
            g.rotation.x = 0.35
            g.rotation.z = Math.sin(r * 26) * 0.12
          }
          g.scale.set(1.08, 0.86, 1.08)
          if (t > 0.3) follow(token, 1.26)
          return
        }
        // The tail flicks and the token tumbles off it onto its new square.
        const u = (t - 0.88) / 0.12
        if (!flicked) {
          flicked = true
          cue('tumble', 0, g.position)
        }
        motion.wave *= 0.9
        motion.bulge = 0
        motion.flick = reduced ? 0 : Math.sin(Math.min(1, u * 1.6) * Math.PI) * 0.28
        point.copy(tail)
        point.y += 0.1
        hop(token, point, end, u, 0.55)
        g.rotation.z = 0
        if (!reduced) g.rotation.x = -Math.PI * 2 * outCubic(u)
        token.yawGoal = turnToward(token.yaw, REST_YAW)
      },
      done: () => {
        Object.assign(motion, { wave: 0, bulge: 0, bulgeAt: -1, flick: 0 })
        snake.apply()
        riding = null
        Object.assign(head, { rear: 0, lunge: 0, pitch: 0, jaw: 0, tongue: 0 })
        snake.skin.emissiveIntensity = snake.body.emissiveIntensity = 0
        token.driven = false
        token.group.rotation.set(0, token.group.rotation.y, 0)
        targetRing.visible = false
        land(token, beat.to, 1.3)
        puff(end.x, BOARD_Y + 0.02, end.z, 14, 1.2)
        if (!reduced && !silent) rig.shake(0.06, 180)
        cue('land', 0, end)
      },
    })
  }

  /** Rolled past 100 under the exact-finish rule: a little hop, and a shake of the head. */
  function nope(beat: Extract<Beat, { kind: 'nope' }>) {
    const token = tokens.get(beat.id)!,
      base = token.group.position.clone()
    cue('nope', 0, base)
    if (reduced) return
    token.driven = true
    token.yawGoal = REST_YAW
    tweens.add({
      duration: Math.min(620, beat.ms),
      update: (_, t) => {
        const g = token.group
        g.position.copy(base)
        if (t < 0.3) hop(token, base, base, t / 0.3, 0.14)
        else {
          g.scale.set(1, 1, 1)
          const u = (t - 0.3) / 0.7
          token.spin = Math.sin(u * Math.PI * 5) * 0.5 * (1 - u)
        }
      },
      done: () => {
        token.spin = 0
        token.driven = false
      },
    })
  }

  function turn(id: PlayerId, live: boolean) {
    const changed = id !== active
    active = id
    if (!changed || !live || reduced) return
    const token = tokens.get(id)!
    cue('turn', 0, token.group.position)
    if (token.driven) return
    // A small "my go" hop, so the eye knows where to look.
    const base = new THREE.Vector3()
    token.driven = true
    tweens.add({
      duration: 300,
      delay: 120,
      start: () => void base.copy(token.group.position),
      update: (_, u) => hop(token, base, base, u, 0.16),
      done: () => void (token.driven = false),
    })
  }

  const orbitAxis = new THREE.Vector3(0, 1, 0),
    orbitOffset = new THREE.Vector3()
  function win(id: PlayerId, live: boolean) {
    winner = id
    const token = tokens.get(id)!
    for (const other of tokens.values())
      if (other !== token) {
        const p = other.group.position,
          w = token.group.position
        other.yawGoal = turnToward(other.yaw, Math.atan2(w.x - p.x, w.z - p.z))
      }
    token.yawGoal = turnToward(token.yaw, REST_YAW)
    if (!live) return
    cue('win')
    if (reduced) return
    const top = slot(id, 100, new THREE.Vector3())
    const burst = (count: number, speed: number) =>
      particles.burst({
        origin: origin.set(top.x, top.y + 0.7, top.z),
        kind: 'confetti',
        floor: BOARD_Y + 0.02,
        count,
        speed,
        spread: 0.6,
        life: 2.8,
        colors: ['#e3b95b', '#789b77', '#d58369', '#6999b7', '#f4e6c4'],
      })
    burst(150, 6.5)
    tweens.add({ duration: 1, delay: 380, update: () => {}, done: () => burst(110, 5) })
    puff(top.x, BOARD_Y + 0.02, top.z, 16, 1.3)
    // Three victory hops, each with a pirouette, then a bow to the table.
    const base = top.clone()
    token.driven = true
    tweens.add({
      duration: 1900,
      delay: 120,
      update: (_, t) => {
        const s = Math.min(2.999, t * 3),
          k = Math.floor(s),
          u = s - k
        hop(token, base, base, u, [0.5, 0.38, 0.26][k])
        token.spin = (k + outCubic(clamp01((u - 0.12) / 0.7))) * Math.PI * 2
      },
      done: () => {
        token.spin = 0
        token.driven = false
        token.wobble.velocity -= 2
      },
    })
    // Swing round to the winner, slowly, and leave the camera there.
    follow(token, 1.6, 1)
    let swung = 0
    tweens.add({
      duration: 3600,
      ease: inOutSine,
      update: (t) => {
        if (rig.userControlled) return
        const angle = t * 0.75 - swung
        swung = t * 0.75
        orbitOffset.subVectors(camera.position, controls.target).applyAxisAngle(orbitAxis, angle)
        camera.position.copy(controls.target).add(orbitOffset)
        camera.lookAt(controls.target)
      },
      done: () => {
        rig.follow(null)
        focusOn.token = null
        followFrom = null
      },
    })
  }

  function run(beat: Beat, pace: Pace): number {
    const live = pace === 'live',
      past = pace === 'past'
    boost = pace === 'catch-up' && !reduced ? 3 : 1
    idleSince = Infinity
    container.dataset.beat = beat.kind
    switch (beat.kind) {
      case 'turn':
        turn(beat.id, live)
        break
      case 'arrive':
        arrive(beat, past)
        break
      case 'roll':
        if (past) {
          dieValue = beat.value
          dieThrow.settle(beat.value)
        } else roll(beat.value, beat.ms)
        break
      case 'walk':
        walk(beat)
        break
      case 'ride':
        ride(beat)
        break
      case 'nope':
        nope(beat)
        break
      case 'win':
        win(beat.id, live)
        break
    }
    return past ? 0 : beat.ms
  }
  // The camera waits a moment before handing the board back: the next beat of
  // the same turn (a ladder after the walk) usually arrives within it.
  let idleSince = Infinity
  /**
   * A beat picked up mid-way keeps time with the room, so it must not lose any
   * to the board's first frames — slow ones (shaders compiling, textures
   * uploading) that the stage clamps. Until that beat and what queued behind it
   * have played, the wall time the stage skipped is played straight through.
   */
  let pickedUp = false
  queue.onIdle(() => {
    pickedUp = false
    boost = 1
    idleSince = stage.now
    container.dataset.beat = 'idle'
  })

  /**
   * Lands everything queued on its final frame, quietly: a hidden tab, a long
   * backlog, reduced motion switched on, a table the room has moved past.
   */
  function flush() {
    silent = true
    queue.flush()
    tweens.finishAll()
    silent = false
    particles.clear()
    dieThrow.settle(dieValue)
    shakingUntil = 0
    stage.invalidate()
  }

  /**
   * Plays `ms` of the beat just started in one go, without its sounds, dust or
   * camera shake — the part of it the rest of the table has already watched.
   */
  function skip(ms: number) {
    if (ms <= 0) return
    silent = true
    tweens.speed = queue.speed
    tweens.step(ms)
    dieThrow.step(ms / 1000)
    queue.step(ms)
    silent = false
  }

  function update(next: GameState, timing?: BeatTiming, receivedAt?: number) {
    const story_ = plan(previous, story, next, reduced)
    previous = next
    state = next
    story = story_.squares
    if (!story_.beats.length) return
    if (next.phase !== 'won') winner = null
    const { live, playing } = story_
    // Joining or reconnecting mid-turn, the room says how far into its beat it
    // already is: what came before lands at once, and this beat starts at that
    // point, so the token arrives when it does for everyone else at the table.
    // Without the room's word, a story that didn't follow on plays quickly.
    const synced = !live && timing !== undefined && !reduced
    if (synced || queue.length > 3) flush()
    queue.push(
      ...story_.beats.map((beat) => ({
        run: () => run(beat, live ? 'live' : !synced ? 'catch-up' : beat === playing ? 'live' : 'past'),
        label: beat.kind,
      })),
    )
    if (synced && playing) {
      // Counted from the socket, not from now: the render, the page crossing
      // over and the board being built all took some of the room's beat too.
      pickedUp = true
      skip(beatElapsed(timing) + (receivedAt === undefined ? 0 : performance.now() - receivedAt))
    }
    if (document.hidden) flush()
    stage.invalidate()
  }

  // ── Interaction ─────────────────────────────────────────────────────────
  const offTap = onTap(stage.canvas, (event) => {
    if (canRoll && stage.pick(event, [die]).length) handlers.onRoll()
  })
  const onMove = (event: PointerEvent) => {
    const over = canRoll && event.pointerType !== 'touch' && stage.pick(event, [die]).length > 0
    if (over === hovered) return
    hovered = over
    stage.canvas.style.cursor = over ? 'pointer' : ''
    stage.invalidate()
  }
  const onLeave = () => {
    hovered = false
    stage.canvas.style.cursor = ''
  }
  stage.canvas.addEventListener('pointermove', onMove)
  stage.canvas.addEventListener('pointerleave', onLeave)
  // The idle table is the first thing to go on a device the stage finds slow:
  // thinner at the lower tier, and gone — with the idle tick that draws it — at
  // the lowest, so a waiting board costs nothing at all.
  const showAmbient = () => {
    ambient.visible = !reduced && tier > 0
    ambient.density(tier)
  }
  const offMotion = onMotionChange(() => {
    reduced = reducedMotion()
    if (reduced) flush()
    showAmbient()
    stage.invalidate()
  })
  const offQuality = stage.onQuality((next) => {
    tier = next
    particles.density = qualityDensity(tier)
    showAmbient()
    stage.invalidate()
  })
  particles.density = qualityDensity(tier)
  showAmbient()
  const offChange = () => controls.removeEventListener('change', invalidate)
  const invalidate = () => {
    markDie = true
    stage.invalidate()
  }
  controls.addEventListener('change', invalidate)

  /**
   * Where the die rests on screen, in CSS pixels from the canvas's corner,
   * written on the container as `data-die-x`/`data-die-y` while the camera is
   * still (and taken off while it moves) — so a browser test can tap the real
   * die wherever the layout and the camera have put it.
   */
  const dieOnScreen = new THREE.Vector2()
  function sayWhereTheDieIs(cameraMoving: boolean) {
    const data = container.dataset
    if (cameraMoving || !stage.size.width) {
      if (data.dieX !== undefined) {
        delete data.dieX
        delete data.dieY
      }
      markDie = true
      return
    }
    if (!markDie) return
    markDie = false
    stage.toScreen(dieRest, dieOnScreen)
    data.dieX = String(Math.round(dieOnScreen.x))
    data.dieY = String(Math.round(dieOnScreen.y))
  }

  // ── The frame ───────────────────────────────────────────────────────────
  const place = new THREE.Vector3()
  function poseTokens(dt: number) {
    let moving = false
    const k = dampFactor(10, dt)
    for (const token of tokens.values()) {
      const g = token.group,
        presence = token.presence
      if (presence.value !== presence.target || presence.velocity) {
        stepSpring(presence, 220, dt, 2 * Math.sqrt(220) * 0.55)
        moving = true
      }
      g.visible = presence.value > 0.01
      if (!g.visible) continue
      const shownAt = shown[token.id]
      if (!token.driven) {
        if (shownAt !== undefined) slot(token.id, shownAt, place)
        else place.copy(g.position)
        if (g.position.distanceToSquared(place) > 1e-7) {
          g.position.lerp(place, k)
          moving = true
        } else g.position.copy(place)
        token.ground = g.position.y
        g.rotation.x = damp(g.rotation.x, 0, 12, dt)
        g.rotation.z = damp(g.rotation.z, 0, 12, dt)
        if (Math.abs(g.rotation.x) + Math.abs(g.rotation.z) > 1e-4) moving = true
        const w = token.wobble
        if (w.value !== 1 || w.velocity) {
          stepSpring(w, 320, dt, 2 * Math.sqrt(320) * 0.32)
          moving = true
        }
        const y = Math.max(0.6, w.value)
        g.scale.set(1 / Math.sqrt(y), y, 1 / Math.sqrt(y))
      }
      if (Math.abs(token.yaw - token.yawGoal) > 1e-4) {
        token.yaw = damp(token.yaw, token.yawGoal, token.driven ? 18 : 7, dt)
        moving = true
      } else token.yaw = token.yawGoal
      g.rotation.y = token.yaw + token.spin
      if (presence.value !== 1) g.scale.multiplyScalar(Math.max(0, presence.value))
      if (token.driven) moving = true
    }
    return moving
  }

  const haloAt = new THREE.Vector3()
  let haloShown = 0
  function poseHalo(dt: number, now: number) {
    const token = tokens.get(active)!
    const visible = !winner && token.group.visible
    const goal = visible ? 1 : 0
    let moving = false
    if (Math.abs(haloShown - goal) > 1e-3) {
      haloShown = damp(haloShown, goal, 8, dt)
      moving = true
    } else haloShown = goal
    halo.visible = haloShown > 0.01
    if (!halo.visible) return moving
    haloAt.set(token.group.position.x, token.ground + 0.012, token.group.position.z)
    if (halo.position.distanceToSquared(haloAt) > 1e-7) {
      // Glued under a token that is hopping; gliding when the turn passes on.
      halo.position.lerp(haloAt, dampFactor(token.driven ? 60 : 12, dt))
      moving = true
    }
    // Eased, then snapped: a lerp only ever gets within a rounding error of
    // the colour, and an exact comparison would keep the board drawing forever.
    const color = COLORS[active],
      shade = haloMaterial.color
    if (Math.abs(shade.r - color.r) + Math.abs(shade.g - color.g) + Math.abs(shade.b - color.b) > 2e-3) {
      shade.lerp(color, dampFactor(8, dt))
      moving = true
    } else shade.copy(color)
    haloMaterial.opacity = 0.85 * haloShown
    halo.scale.setScalar((reduced ? 1 : 1 + Math.sin(now / 320) * 0.05) * (0.6 + 0.4 * haloShown))
    return moving
  }

  /** The die's "roll me" breathing, drawn on the idle tick rather than every frame. */
  let diePulse = 0
  function poseDie(dt: number, now: number) {
    if (shakingUntil && now > shakingUntil) {
      shakingUntil = 0
      dieThrow.settle(dieValue)
    }
    let moving = dieThrow.step(dt * boost * queue.speed)
    const glowGoal = canRoll ? (hovered ? 0.4 : 0.1) : 0
    if (Math.abs(dieGlow - glowGoal) > 1e-3) {
      dieGlow = damp(dieGlow, glowGoal, 10, dt)
      moving = true
    } else dieGlow = glowGoal
    dieBody.material.emissiveIntensity = dieGlow + diePulse
    if (!dieThrow.busy) {
      const liftGoal = canRoll && hovered && !reduced ? 0.14 : 0
      if (Math.abs(dieLift - liftGoal) > 1e-4) {
        dieLift = damp(dieLift, liftGoal, 12, dt)
        moving = true
      }
      die.position.y = dieRest.y + dieLift
    } else dieLift = 0
    return moving
  }

  function poseSnakes(now: number) {
    const t = now / 1000
    for (const snake of snakes.values()) {
      const head = heads.get(snake)!,
        h = snake.head
      // Idle: a slow breath, and every few seconds a taste of the air.
      let bob = 0,
        tongue = head.tongue
      if (!reduced) {
        bob = Math.sin(t * 1.4 + snake.route.from) * 0.011
        const phase = (t + snake.route.from * 0.37) % 5.2
        if (phase < 0.45 && snake !== riding) tongue = Math.max(tongue, Math.sin((phase / 0.45) * Math.PI))
      }
      h.position.copy(snake.rest).addScaledVector(snake.forward, head.lunge - head.rear * 0.45)
      h.position.y += head.rear * 0.3 + bob
      h.rotation.x = head.pitch
      snake.upper.rotation.x = -head.jaw * 0.6
      snake.lower.rotation.x = head.jaw * 0.38
      snake.tongue.visible = tongue > 0.02
      snake.tongue.scale.z = Math.max(0.01, tongue)
    }
    if (riding) riding.apply()
  }

  stage.onFrame((dt, now) => {
    if (disposed) return false
    const drift = stage.takeDrift()
    if (pickedUp && drift > 0) skip(drift)
    const ms = dt * 1000 * boost
    queue.step(ms)
    tweens.speed = queue.speed
    let moving = tweens.step(ms)
    if (poseTokens(dt)) moving = true
    if (poseHalo(dt, now)) moving = true
    if (poseDie(dt, now)) moving = true
    if (particles.step(dt)) moving = true
    // The idle table ticks at ~20Hz, slower on a slow device, not at all on the slowest.
    const idle = !reduced && tier > 0 && now - lastAmbient >= (tier === 2 ? 50 : 80)
    if (moving || idle) {
      lastAmbient = now
      poseSnakes(now)
      for (let s = 1; s <= 100; s++) board.tiles[s - 1].position.y = 0.187 - press[s]
      const near = state.players.some((p) => (shown[p.id] ?? 0) >= 94) && !winner
      finish.emissiveIntensity = near ? (reduced ? 0.3 : 0.28 + Math.sin(now / 260) * 0.2) : 0
      diePulse = canRoll && !hovered && !reduced && tier > 0 ? Math.sin(now / 380) * 0.06 : 0
      if (!reduced && tier > 0) {
        ambient.step(now)
        const token = tokens.get(active)!
        if (!token.driven && !winner && token.wobble.value === 1 && !token.wobble.velocity) {
          const breath = 1 + Math.sin(now / 420) * 0.018
          token.group.scale.set(1 / Math.sqrt(breath), breath, 1 / Math.sqrt(breath))
        }
      }
      if (idle) moving = true
    }
    if (followFrom && !winner && now - idleSince > 650) release()
    const turning = controls.update(),
      swinging = rig.step(dt)
    if (turning || swinging) moving = true
    sayWhereTheDieIs(turning || swinging)
    return moving
  })
  stage.start()
  update(initial, timing, receivedAt)

  return {
    update,
    setRunning: (running) => stage.setRunning(running),
    setCanRoll(next) {
      canRoll = next
      if (!next && hovered) onLeave()
      stage.invalidate()
    },
    rolling() {
      if (reduced || dieThrow.busy) return
      dieThrow.shake()
      cue('shake', 0, die.position)
      shakingUntil = stage.now + 4000
      stage.invalidate()
    },
    reset() {
      rig.to({ position: home, target: homeTarget, zoom: 1 }, reduced ? 30 : 5)
    },
    top() {
      rig.to({ position: new THREE.Vector3(0.2, 23, 0.42), target: homeTarget, zoom: 1 }, reduced ? 30 : 5)
    },
    rotate(direction) {
      const position = camera.position
        .clone()
        .sub(controls.target)
        .applyAxisAngle(orbitAxis, (direction * Math.PI) / 8)
        .add(controls.target)
      rig.to({ position }, reduced ? 30 : 5)
    },
    zoom(direction) {
      rig.to({ zoom: THREE.MathUtils.clamp(camera.zoom + direction * 0.18, 0.65, 2.4) }, reduced ? 30 : 6)
    },
    dispose() {
      disposed = true
      tweens.cancelAll()
      queue.clear()
      offTap()
      offMotion()
      offQuality()
      offChange()
      stage.canvas.removeEventListener('pointermove', onMove)
      stage.canvas.removeEventListener('pointerleave', onLeave)
      rig.dispose()
      controls.dispose()
      particles.dispose()
      ambient.dispose()
      stage.dispose()
    },
  }
}
