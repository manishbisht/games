import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import {
  absoluteSpace,
  COURTS,
  HOME,
  PALETTES,
  piecePosition,
  spaceKey,
  TRACK_LENGTH,
} from '@games/shared/hearth/board'
import { hopDurations, settleDuration } from '@games/shared/hearth'
import type { GameState, LegalMove, Motion, Piece, PlayerId } from '@games/shared/hearth/types'
import { createCameraRig } from '../../../motion/camera'
import { createDieThrow } from '../../../motion/dice'
import {
  arc,
  damp,
  dampFactor,
  inOutCubic,
  inQuad,
  lerp,
  outCubic,
  outQuad,
  smooth,
  spring,
  stepSpring,
} from '../../../motion/ease'
import type { Spring } from '../../../motion/ease'
import { createParticles } from '../../../motion/particles'
import { onMotionChange, reducedMotion } from '../../../motion/preference'
import { createStage, onTap } from '../../../motion/stage'
import { createQueue, createTweens } from '../../../motion/tween'
import type { Beat } from '../../../motion/tween'
import { dieQuaternion, makeBoard, makeDie, makeGhost, makePiece, pieceLooks, roundedBox } from './models'

/**
 * Something the board just did that deserves a sound. The board raises these
 * from its own animation clock, so a sound plays when a piece actually lands —
 * once — however the room's snapshots happen to arrive.
 */
export type Cue =
  | { kind: 'roll' }
  | { kind: 'dice'; strength: number }
  | { kind: 'step'; index: number }
  | { kind: 'land' }
  | { kind: 'capture' }
  | { kind: 'home' }
  | { kind: 'win' }

export interface SceneHooks {
  select: (pieceId: string) => void
  /** The table as the board is showing it right now — the HUD follows this, not the room. */
  present: (state: GameState) => void
  cue: (cue: Cue) => void
}

export interface SceneApi {
  /** A state from the room. `seat` is the colour this browser plays; `live` is false for the setup preview. */
  update: (state: GameState, seat: PlayerId | null, live: boolean) => void
  /** The player asked to roll: rattle the die now, before the room answers. */
  roll: () => void
  focus: (pieceId: string | null) => void
  reset: () => void
  zoom: (direction: number) => void
  top: () => void
  dispose: () => void
}

/** One piece on the board and everything its pose is made of. */
interface Token {
  piece: Piece
  /** The progress the board is showing, which trails the room's while a walk plays. */
  progress: number
  /** An animation owns the pose; the resting layout leaves it alone. */
  flying: boolean
  group: THREE.Group
  body: THREE.Group
  halo: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>
  haloLevel: number
  pos: THREE.Vector3
  slot: THREE.Vector3
  slotScale: number
  size: number
  /** Squash and stretch along the piece's own axis; volume is kept. */
  sy: number
  nod: number
  rot: THREE.Quaternion
  lift: Spring
  press: Spring
}

const IDENTITY = new THREE.Quaternion(),
  UP = new THREE.Vector3(0, 1, 0),
  HOME_VIEW = new THREE.Vector3(10, 18, 17),
  TOP_VIEW = new THREE.Vector3(0, 25, 0.01),
  ORIGIN = new THREE.Vector3(),
  DIE_REST = new THREE.Vector3(5.85, 0.2335, 6.42),
  KEY_LIGHT = new THREE.Color('#fff2d9'),
  DUST = ['#efe6d0', '#e2d6b8', '#f7f1e2'],
  GOLD = ['#f1d98a', '#d6b46d', '#fff3c4']

const restY = (progress: number) => (progress < 0 ? 0.375 : progress === HOME ? 0.445 : 0.325)
const motionKey = (state: GameState, motion: Motion) =>
  `${state.turn}:${motion.pieceId}:${motion.from}:${motion.to}`

export function createScene(
  container: HTMLElement,
  initial: GameState,
  hooks: SceneHooks,
  seat: PlayerId | null = null,
  live = false,
): SceneApi {
  const stage = createStage(container, {
    label:
      '3D Hearth & Home board. Drag to rotate and scroll to zoom. Legal pieces can also be selected using the turn panel.',
    exposure: 0.97,
    environmentIntensity: 0.32,
  })
  const { scene, renderer, canvas } = stage
  const camera = new THREE.OrthographicCamera(-10, 10, 8, -8, 0.1, 100)
  camera.position.copy(HOME_VIEW)
  camera.lookAt(ORIGIN)
  stage.setCamera(camera)
  stage.onResize((width, height) => {
    const aspect = width / height,
      vertical = Math.max(14.7, 19.1 / aspect)
    camera.left = (-vertical * aspect) / 2
    camera.right = (vertical * aspect) / 2
    camera.top = vertical / 2
    camera.bottom = -vertical / 2
    camera.updateProjectionMatrix()
  })
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.09
  controls.enablePan = false
  controls.minPolarAngle = 0.03
  controls.maxPolarAngle = Math.PI / 2.7
  controls.minZoom = 0.75
  controls.maxZoom = 1.8
  controls.rotateSpeed = 0.45
  controls.zoomSpeed = 0.65
  // OrbitControls claims every touch on the canvas. On a touch screen the board
  // is most of the page, so vertical swipes are handed back to the page to
  // scroll it; sideways drags and pinches still turn and zoom the table.
  if (window.matchMedia('(pointer: coarse)').matches) canvas.style.touchAction = 'pan-y'
  const rig = createCameraRig(camera, controls)
  // Once the viewer has framed the table themselves, turn changes stop
  // swinging the camera until they ask for the default view back.
  let framedByViewer = false
  const onViewer = () => {
    framedByViewer = true
  }
  controls.addEventListener('start', onViewer)
  controls.addEventListener('change', stage.invalidate)

  scene.add(new THREE.HemisphereLight('#eef4ff', '#80795f', 1.5))
  const key = new THREE.DirectionalLight(KEY_LIGHT, 2.1)
  key.position.set(-7, 16, 7)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  Object.assign(key.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 0.5, far: 45 })
  key.shadow.normalBias = 0.027
  key.shadow.bias = -0.0003
  key.shadow.radius = 4
  scene.add(key)
  const keyTint = KEY_LIGHT.clone()
  const fill = new THREE.DirectionalLight('#d3e1f9', 0.8)
  fill.position.set(7, 9, -10)
  scene.add(fill)
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.ShadowMaterial({ color: '#36372b', opacity: 0.21 }),
  )
  shadow.rotation.x = -Math.PI / 2
  shadow.position.y = -0.82
  shadow.receiveShadow = true
  scene.add(shadow)
  const { board, tiles, borders } = makeBoard()
  scene.add(board)
  const courtBorders = Object.entries(borders) as [PlayerId, THREE.MeshStandardMaterial][]
  for (const [id, border] of courtBorders) border.emissive.set(PALETTES[id].color)

  // The die rests in a felt tray on the table's corner, its underside on the felt.
  const tray = roundedBox(1.15, 0.045, 0.74, '#6a5540', 0.12)
  tray.position.set(DIE_REST.x, -0.1375, DIE_REST.z)
  tray.castShadow = false
  scene.add(tray)
  const die = makeDie()
  die.scale.setScalar(0.82)
  die.position.copy(DIE_REST)
  die.quaternion.copy(dieQuaternion(initial.lastDice || 1))
  scene.add(die)
  const particles = createParticles(scene, { max: 700, floor: 0.3 }),
    trayDust = createParticles(scene, { max: 48, floor: DIE_REST.y - 0.35 })
  let quiet = false
  const cue = (next: Cue) => {
    if (!quiet) hooks.cue(next)
  }
  const dieThrow = createDieThrow(die, {
    rest: DIE_REST,
    face: dieQuaternion,
    size: 0.7,
    // Tossed along the table's front edge, so no bounce comes down inside the board.
    release: new THREE.Vector3(-1.2, 1.8, 0),
    onContact: (strength) => {
      cue({ kind: 'dice', strength })
      if (!quiet)
        trayDust.burst({
          origin: new THREE.Vector3(die.position.x, DIE_REST.y - 0.33, die.position.z),
          kind: 'dust',
          count: Math.round(3 + strength * 7),
          colors: DUST,
          speed: 0.6 + strength * 1.4,
          size: 0.6 + strength * 0.4,
        })
    },
  })

  const looks = pieceLooks()
  const tokens = new Map<string, Token>()
  const haloGeometry = new THREE.RingGeometry(0.32, 0.39, 48)
  for (const piece of initial.pieces) {
    const group = new THREE.Group(),
      body = makePiece(piece.playerId, piece.index, looks[piece.playerId])
    group.add(body)
    group.traverse((child) => {
      child.userData.pieceId = piece.id
    })
    scene.add(group)
    const halo = new THREE.Mesh(
      haloGeometry,
      new THREE.MeshBasicMaterial({
        color: PALETTES[piece.playerId].color,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    )
    halo.rotation.x = -Math.PI / 2
    halo.visible = false
    scene.add(halo)
    tokens.set(piece.id, {
      piece,
      progress: piece.progress,
      flying: false,
      group,
      body,
      halo,
      haloLevel: 0,
      pos: group.position,
      slot: new THREE.Vector3(),
      slotScale: 1,
      size: 1,
      sy: 1,
      nod: 1,
      rot: new THREE.Quaternion(),
      lift: spring(),
      press: spring(),
    })
  }
  const pieceGroups = [...tokens.values()].map((t) => t.group)

  const destination = new THREE.Group()
  const destinationRing = new THREE.Mesh(
    new THREE.RingGeometry(0.27, 0.34, 48),
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  )
  destinationRing.rotation.x = -Math.PI / 2
  const destinationCenter = new THREE.Mesh(
    new THREE.CircleGeometry(0.26, 48),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.22, depthWrite: false }),
  )
  destinationCenter.rotation.x = -Math.PI / 2
  destination.add(destinationRing, destinationCenter)
  destination.visible = false
  scene.add(destination)
  const ghosts = new Map<PlayerId, THREE.Group>()
  function ghostOf(id: PlayerId) {
    let ghost = ghosts.get(id)
    if (!ghost) {
      ghost = makeGhost(id)
      ghost.visible = false
      scene.add(ghost)
      ghosts.set(id, ghost)
    }
    return ghost
  }

  // A small pool of flat rings: a capture's shockwave, a piece's welcome home.
  const ringGeometry = new THREE.RingGeometry(0.42, 0.5, 64)
  const rings = Array.from({ length: 4 }, () => {
    const mesh = new THREE.Mesh(
      ringGeometry,
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide }),
    )
    mesh.rotation.x = -Math.PI / 2
    mesh.visible = false
    scene.add(mesh)
    return mesh
  })
  let ringTurn = 0

  const tweens = createTweens(),
    queue = createQueue({ catchUpAfter: Infinity })
  /** States handed to the queue that it has not finished presenting. */
  let backlog = 0

  let target = initial,
    shown = initial,
    focused: string | null = null,
    hovered: string | null = null,
    shakenTurn = -1,
    thrownTurn = -1,
    walked = '',
    localShakeAt = -1,
    turnOf: PlayerId | null = null,
    turnAt = -1e9,
    celebrated = false,
    pathAt = 0,
    hoverDirty = false
  const planned = new Map<string, number>()
  const legal = new Set<string>()

  // ── Layout ────────────────────────────────────────────────────────────────
  /**
   * Where every resting piece sits, with pieces that share a space arranged in
   * a little grid and scaled to fit. `override` asks "what if": a progress for
   * a piece, or `null` to leave it out (it is in the air).
   */
  function arrange(override?: Map<string, number | null>) {
    const spaces = new Map<string, { token: Token; progress: number }[]>()
    for (const token of tokens.values()) {
      const progress = override?.has(token.piece.id)
        ? override.get(token.piece.id)
        : token.flying
          ? null
          : token.progress
      if (progress === null || progress === undefined) continue
      const key = spaceKey({ ...token.piece, progress })
      const list = spaces.get(key)
      if (list) list.push({ token, progress })
      else spaces.set(key, [{ token, progress }])
    }
    const out = new Map<string, { pos: THREE.Vector3; scale: number }>()
    for (const list of spaces.values()) {
      const n = list.length,
        columns = Math.ceil(Math.sqrt(n)),
        rows = Math.ceil(n / columns),
        spacing = n > 4 ? 0.62 / columns : 0.31
      list.forEach(({ token, progress }, index) => {
        const [x, z] = piecePosition({ ...token.piece, progress })
        const dx = n > 1 ? ((index % columns) - (columns - 1) / 2) * spacing : 0,
          dz = n > 1 ? (Math.floor(index / columns) - (rows - 1) / 2) * spacing : 0
        let scale = progress === HOME ? 0.42 : 1
        if (n > 1) scale *= n <= 4 ? 0.56 : 1.25 / columns
        out.set(token.piece.id, { pos: new THREE.Vector3(x + dx, restY(progress), z + dz), scale })
      })
    }
    return out
  }
  /** Re-seats every resting piece; they glide to their new places on springs. */
  function layout() {
    for (const [id, { pos, scale }] of arrange()) {
      const token = tokens.get(id)!
      token.slot.copy(pos)
      token.slotScale = scale
    }
    stage.invalidate()
  }
  const centre = (piece: Piece, progress: number) => {
    const [x, z] = piecePosition({ ...piece, progress })
    return new THREE.Vector3(x, restY(progress), z)
  }
  const shownPieces = (state: GameState) =>
    state.pieces.map((piece) => {
      const progress = tokens.get(piece.id)?.progress ?? piece.progress
      return progress === piece.progress ? piece : { ...piece, progress }
    })
  /** Tell the HUD what the board shows now — a pip fills as the piece arrives. */
  const report = () => hooks.present({ ...shown, pieces: shownPieces(shown) })

  // ── Presentation ──────────────────────────────────────────────────────────
  const mine = () =>
    live && shown.phase === 'choose' && seat !== null && shown.players[shown.currentPlayer]?.id === seat

  function present(state: GameState) {
    shown = state
    legal.clear()
    if (mine()) for (const move of state.legalMoves) legal.add(move.pieceId)
    if (!legal.has(focused ?? '')) focused = mine() ? (state.legalMoves[0]?.pieceId ?? null) : null
    if (!legal.has(hovered ?? '')) hovered = null
    hoverDirty = true
    preview()
    const player = state.players[state.currentPlayer]?.id ?? null
    if (live && state.phase !== 'won' && player && player !== turnOf) {
      handOver(player)
      turnOf = player
    }
    if (state.winner && !celebrated) celebrate(state.winner)
    if (!state.winner) celebrated = false
    report()
    stage.invalidate()
  }

  function freshGame(prev: GameState, next: GameState) {
    return (
      prev.startedAt !== next.startedAt ||
      next.turn < prev.turn ||
      next.eventSequence < prev.eventSequence ||
      next.pieces.length !== prev.pieces.length
    )
  }

  /** Put the board straight on `state`: a new game, a first snapshot, a backlog not worth replaying. */
  function snap(state: GameState) {
    queue.clear()
    tweens.cancelAll()
    backlog = 0
    for (const token of tokens.values()) {
      token.progress = state.pieces.find((p) => p.id === token.piece.id)?.progress ?? token.progress
      token.flying = false
      planned.set(token.piece.id, token.progress)
    }
    layout()
    for (const token of tokens.values()) {
      token.pos.copy(token.slot)
      token.size = token.slotScale
      token.sy = token.nod = 1
      token.rot.identity()
    }
    dieThrow.settle(state.dice || state.lastDice || 1)
    thrownTurn = state.dice !== null ? state.turn : -1
    shakenTurn = state.phase === 'rolling' ? state.turn : -1
    if (state.phase === 'rolling' && !reducedMotion()) dieThrow.shake()
    walked = state.phase === 'moving' && state.motion ? motionKey(state, state.motion) : ''
    celebrated = Boolean(state.winner)
    turnOf = null
    present(state)
  }

  /**
   * Turn a fresh state from the room into beats, played in order after
   * whatever is still running: the die rattles, lands on its number, the piece
   * walks, and only then does the HUD catch up. The room's pacing leaves room
   * for every beat, so a backlog only builds when snapshots arrive late — and
   * then everything plays faster until it has caught up.
   */
  function plan(next: GameState) {
    const prev = target
    target = next
    if (freshGame(prev, next)) return snap(next)
    if (backlog > 4) {
      // Far behind (a hidden tab, a stalled connection): land it all at once, silently.
      quiet = true
      queue.flush()
      tweens.finishAll()
      quiet = false
    }
    backlog++
    const beats: Beat[] = []
    if (next.phase === 'rolling' && shakenTurn !== next.turn) {
      shakenTurn = next.turn
      beats.push({ label: 'shake', run: shakeDie })
    }
    if (next.dice !== null && thrownTurn !== next.turn) {
      thrownTurn = next.turn
      const value = next.dice
      beats.push({ label: 'throw', run: () => throwDie(value) })
    }
    const motion = next.phase === 'moving' ? next.motion : null
    if (motion && motionKey(next, motion) !== walked) {
      walked = motionKey(next, motion)
      planned.set(motion.pieceId, motion.to)
      for (const id of motion.captures) planned.set(id, -1)
      beats.push({
        label: 'walk',
        run: () => {
          present(next)
          return walk(motion)
        },
      })
    }
    const drift = next.pieces.filter((piece) => planned.get(piece.id) !== piece.progress)
    if (drift.length) {
      for (const piece of drift) planned.set(piece.id, piece.progress)
      beats.push({ label: 'glide', run: () => glide(drift) })
    }
    beats.push({
      label: 'present',
      run: () => {
        backlog = Math.max(0, backlog - 1)
        present(next)
      },
    })
    queue.push(...beats)
    stage.invalidate()
  }

  // ── The die ───────────────────────────────────────────────────────────────
  function shakeDie() {
    localShakeAt = -1
    if (dieThrow.busy) return
    cue({ kind: 'roll' })
    if (!reducedMotion()) dieThrow.shake()
  }
  function throwDie(value: number) {
    localShakeAt = -1
    if (reducedMotion()) {
      // A quick turn onto the face rather than a toss — still visibly a roll.
      const from = die.quaternion.clone()
      dieThrow.settle(value)
      const face = die.quaternion.clone()
      tweens.add({
        duration: 180,
        ease: outCubic,
        update: (t) => void die.quaternion.slerpQuaternions(from, face, t),
      })
      cue({ kind: 'dice', strength: 0.5 })
      return 180
    }
    dieThrow.throw(value, 600)
    return 600
  }

  // ── Walking ───────────────────────────────────────────────────────────────
  /** The tilt axis for travel from `a` to `b`: rotating about it tips the top toward `b`. */
  const tiltAxis = (a: THREE.Vector3, b: THREE.Vector3, out = new THREE.Vector3()) => {
    out.set(b.z - a.z, 0, -(b.x - a.x))
    return out.lengthSq() > 1e-8 ? out.normalize() : out.set(1, 0, 0)
  }

  /**
   * One hop from `a` to `b` at progress `raw`: a crouch on the ground that
   * springs into a stretched take-off, a lean into the direction of travel and
   * a parabola whose height grows with the distance covered.
   */
  function hop(
    token: Token,
    a: THREE.Vector3,
    b: THREE.Vector3,
    raw: number,
    { first, height, tilt, scaleFrom, scaleTo }: HopShape,
  ) {
    const contact = first ? 0.3 : 0.15,
      settleFrom = first ? 1 : 1.06,
      low = first ? 0.76 : 0.82
    let angle: number
    if (raw < contact) {
      const u = raw / contact
      token.pos.copy(a)
      token.sy =
        u < 0.62 ? lerp(settleFrom, low, outQuad(u / 0.62)) : lerp(low, 1.14, inQuad((u - 0.62) / 0.38))
      angle = -0.07 * Math.sin(u * Math.PI)
    } else {
      const u = (raw - contact) / (1 - contact)
      token.pos.lerpVectors(a, b, lerp(u, smooth(u), 0.4))
      token.pos.y = lerp(a.y, b.y, u) + arc(u, height)
      token.sy = u < 0.5 ? lerp(1.14, 0.98, outQuad(u * 2)) : lerp(0.98, 1.06, inQuad((u - 0.5) * 2))
      angle = 0.2 * Math.sin(u * Math.PI)
    }
    token.rot.setFromAxisAngle(tilt, angle)
    token.size = lerp(scaleFrom, scaleTo, smooth(raw))
  }

  function puff(at: THREE.Vector3, count: number, colors: string[] = DUST, size = 0.7) {
    if (quiet || reducedMotion()) return
    particles.burst({ origin: at, kind: 'dust', count, colors, speed: 1.4, size, spread: 1 })
  }

  function ring(at: THREE.Vector3, color: string, ms: number, from: number, to: number, rise = 0, delay = 0) {
    let mesh = rings[0]
    tweens.add({
      delay,
      duration: ms,
      start: () => {
        mesh = rings[ringTurn++ % rings.length]
        mesh.material.color.set(color)
        mesh.visible = true
      },
      update: (t) => {
        const e = outCubic(t)
        mesh.position.set(at.x, at.y + 0.012 + rise * e, at.z)
        mesh.scale.setScalar(lerp(from, to, e))
        mesh.material.opacity = 0.85 * (1 - t) ** 1.6
      },
      done: () => void (mesh.visible = false),
    })
  }
  /** Runs `effect` once, `delay` ms into the scene clock — in step with the tweens around it. */
  const at = (delay: number, effect: () => void) =>
    tweens.add({ delay, duration: 1, update: () => {}, start: effect })

  /** The piece comes to rest after its walk: a landing squash that rings out, then the layout takes it. */
  function landing(token: Token, delay: number, ms: number, depth: number) {
    const from = new THREE.Quaternion()
    tweens.add({
      delay,
      duration: ms,
      start: () => void from.copy(token.rot),
      update: (_, u) => {
        token.sy = 1 - depth * Math.exp(-5 * u) * Math.cos(u * Math.PI * 2.5)
        token.rot.slerpQuaternions(from, IDENTITY, outCubic(u))
      },
      done: () => {
        token.sy = 1
        settle(token)
      },
    })
  }
  function settle(token: Token) {
    token.flying = false
    layout()
    report()
  }

  function walk(motion: Motion) {
    const mover = tokens.get(motion.pieceId)
    if (!mover) return 0
    const victims = motion.captures.flatMap((id) => tokens.get(id) ?? [])
    for (const token of [mover, ...victims]) token.flying = true
    mover.lift.target = 0
    // Where everyone ends up: the mover on its space, anyone it hit in a nest.
    const after = arrange(
      new Map<string, number | null>([
        [mover.piece.id, motion.to],
        ...victims.map((v) => [v.piece.id, -1] as const),
      ]),
    )
    // The pieces it leaves behind regroup as it takes off.
    layout()
    if (reducedMotion()) return slide(mover, victims, motion, after)

    const hops = hopDurations(motion),
      last = hops.length - 1,
      end = after.get(mover.piece.id)!
    const points = motion.steps.map((progress, i) =>
      i === last ? end.pos.clone() : centre(mover.piece, progress),
    )
    const start = mover.pos.clone(),
      scaleFrom = mover.size
    let clock = 0,
      a = start
    hops.forEach((ms, i) => {
      const from = a,
        to = points[i],
        distance = Math.hypot(to.x - from.x, to.z - from.z)
      const shape: HopShape = {
        first: i === 0,
        height:
          Math.min(1.25, Math.max(0.42, 0.3 + distance * 0.24)) +
          (i === last && motion.to === HOME ? 0.3 : 0),
        tilt: tiltAxis(from, to),
        scaleFrom: i === 0 ? scaleFrom : 1,
        scaleTo: i === last ? end.scale : 1,
      }
      tweens.add({
        delay: clock,
        duration: ms,
        update: (_, raw) => hop(mover, from, to, raw, shape),
        done: () => {
          mover.pos.copy(to)
          if (i < last) {
            cue({ kind: 'step', index: i })
            puff(to, 4, DUST, 0.55)
          }
        },
      })
      clock += ms
      a = to
    })
    const settleMs = settleDuration(motion),
      lastFrom = last > 0 ? points[last - 1] : start,
      landed = clock
    // The last hop has landed: what happens next depends on what it landed on.
    at(landed, () => void (mover.progress = motion.to))
    if (victims.length) impact(mover, victims, lastFrom, end.pos, after, landed)
    else if (motion.to === HOME) welcome(mover, end.pos, landed)
    else {
      at(landed, () => {
        cue({ kind: 'land' })
        puff(end.pos, 9)
      })
      landing(mover, landed, settleMs, 0.24)
    }
    // A frame of slack so every landing has run before the next beat starts.
    return landed + settleMs + 20
  }

  /**
   * A capture: the mover slams down and the board holds its breath for a
   * beat, then whoever was there is knocked away along the line of the hit,
   * tumbles, bounces once and arcs home to its own nest.
   */
  function impact(
    mover: Token,
    victims: Token[],
    from: THREE.Vector3,
    to: THREE.Vector3,
    after: Map<string, { pos: THREE.Vector3; scale: number }>,
    delay: number,
  ) {
    const HIT_STOP = 70
    ring(to, '#fff3d6', 460, 0.5, 2.6, 0, delay)
    at(delay, () => {
      cue({ kind: 'capture' })
      for (const victim of victims) victim.sy = 0.84
      if (quiet) return
      particles.burst({
        origin: to.clone().setY(to.y + 0.25),
        kind: 'spark',
        count: 22,
        colors: [...GOLD, ...victims.map((v) => PALETTES[v.piece.playerId].color)],
        speed: 3.4,
        spread: 0.85,
        life: 0.75,
      })
      rig.shake(0.1, 260)
      if (!rig.userControlled) {
        // A quick punch in on the hit, easing back out once it has landed.
        const zoom = camera.zoom
        rig.to({ zoom: Math.min(controls.maxZoom, zoom * 1.08) }, 16)
        at(260, () => rig.to({ zoom }, 3.5))
      }
    })
    // The mover: a heavy squash held through the hit-stop, then a springy recovery.
    tweens.add({
      delay,
      duration: 400,
      update: (_, u) => {
        const ms = u * 400,
          v = (ms - HIT_STOP) / 330
        mover.sy = ms < HIT_STOP ? 0.64 : 1 - 0.36 * Math.exp(-6 * v) * Math.cos(v * Math.PI * 2.6)
        mover.rot.slerp(IDENTITY, 0.3)
      },
      done: () => {
        mover.sy = 1
        settle(mover)
      },
    })
    const direction = new THREE.Vector3(to.x - from.x, 0, to.z - from.z)
    if (direction.lengthSq() < 1e-6) direction.set(1, 0, 0)
    direction.normalize()
    victims.forEach((victim, n) => {
      const d = direction.clone().applyAxisAngle(UP, (n - (victims.length - 1) / 2) * 0.55)
      const p0 = victim.pos.clone(),
        p1 = p0.clone().addScaledVector(d, 0.85),
        p2 = p1.clone().addScaledVector(d, 0.2),
        nest = after.get(victim.piece.id)!.pos
      const tumble = tiltAxis(p0, p1),
        flight = Math.hypot(nest.x - p2.x, nest.z - p2.z),
        height = 1.1 + flight * 0.08,
        spin = new THREE.Quaternion(),
        size = victim.size
      tweens.add({
        delay: delay + HIT_STOP + n * 40,
        duration: 890 - n * 40,
        update: (_, raw) => {
          const ms = raw * 890
          if (ms < 240) {
            // Knocked off its feet along the line of the hit, flipping once.
            const u = ms / 240
            victim.pos.lerpVectors(p0, p1, outQuad(u))
            victim.pos.y = p0.y + arc(u, 0.75)
            victim.rot.setFromAxisAngle(tumble, outCubic(u) * Math.PI * 2)
            victim.sy = 1.04
            victim.size = lerp(size, 1, u)
          } else if (ms < 360) {
            // One small bounce where it fell.
            const u = (ms - 240) / 120
            victim.pos.lerpVectors(p1, p2, u)
            victim.pos.y = p1.y + arc(u, 0.18)
            victim.rot.setFromAxisAngle(tumble, -0.25 * Math.sin(u * Math.PI))
            victim.sy = u < 0.35 ? 1 - 0.24 * Math.sin((u / 0.35) * Math.PI) : 1
          } else if (ms < 810) {
            // Then the long way home, turning once in the air.
            const u = (ms - 360) / 450,
              e = inOutCubic(u)
            victim.pos.lerpVectors(p2, nest, e)
            victim.pos.y = lerp(p2.y, nest.y, e) + arc(e, height)
            victim.rot.copy(spin.setFromAxisAngle(UP, outCubic(u) * Math.PI * 2))
            victim.sy = 1 + 0.08 * Math.sin(u * Math.PI)
          } else {
            const u = (ms - 810) / 80
            victim.pos.copy(nest)
            victim.rot.identity()
            victim.sy = 1 - 0.22 * Math.sin(u * Math.PI)
          }
        },
        done: () => {
          victim.sy = 1
          victim.rot.identity()
          victim.progress = -1
          puff(nest, 7, [PALETTES[victim.piece.playerId].light, ...DUST], 0.6)
          settle(victim)
        },
      })
    })
  }

  /** Home at last: a soft landing in the centre, gold sparkles and a ring rising off it. */
  function welcome(mover: Token, to: THREE.Vector3, delay: number) {
    ring(to, '#f1d98a', 700, 0.6, 1.9, 1.1, delay)
    at(delay, () => {
      cue({ kind: 'home' })
      if (!quiet)
        particles.burst({
          origin: to.clone().setY(to.y + 0.2),
          kind: 'spark',
          count: 26,
          colors: GOLD,
          speed: 3,
          spread: 0.55,
          life: 0.9,
        })
    })
    landing(mover, delay, 320, 0.2)
  }

  /** Reduced motion: a short straight slide to where everything ends up — no hops, no arcs. */
  function slide(
    mover: Token,
    victims: Token[],
    motion: Motion,
    after: Map<string, { pos: THREE.Vector3; scale: number }>,
  ) {
    const moving = [mover, ...victims].map((token) => ({
      token,
      from: token.pos.clone(),
      size: token.size,
      to: after.get(token.piece.id)!,
    }))
    tweens.add({
      duration: 200,
      ease: outCubic,
      update: (t) => {
        for (const { token, from, size, to } of moving) {
          token.pos.lerpVectors(from, to.pos, t)
          token.size = lerp(size, to.scale, t)
        }
      },
      done: () => {
        mover.progress = motion.to
        for (const victim of victims) victim.progress = -1
        for (const { token } of moving) token.flying = false
        cue({ kind: motion.captures.length ? 'capture' : motion.to === HOME ? 'home' : 'land' })
        layout()
        report()
      },
    })
    return 220
  }

  /** Pieces that moved without a walk we saw (a missed snapshot): each hops straight to its place. */
  function glide(pieces: Piece[]) {
    const movers = pieces.flatMap((piece) => {
      const token = tokens.get(piece.id)
      if (!token) return []
      token.flying = true
      token.progress = piece.progress
      return [token]
    })
    const after = arrange(new Map(movers.map((t) => [t.piece.id, t.progress])))
    layout()
    const reduced = reducedMotion(),
      ms = reduced ? 200 : 420
    const paths = movers.map((token) => ({
      token,
      from: token.pos.clone(),
      size: token.size,
      to: after.get(token.piece.id)!,
    }))
    tweens.add({
      duration: ms,
      update: (_, raw) => {
        const e = reduced ? outCubic(raw) : inOutCubic(raw)
        for (const { token, from, size, to } of paths) {
          token.pos.lerpVectors(from, to.pos, e)
          if (!reduced) token.pos.y += arc(raw, 0.7)
          token.size = lerp(size, to.scale, e)
        }
      },
      done: () => {
        for (const { token } of paths) token.flying = false
        layout()
        report()
      },
    })
    return ms
  }

  // ── Turns and the win ─────────────────────────────────────────────────────
  /** The table turns its attention to `player`: their court's border glows, the light warms to them. */
  function handOver(player: PlayerId) {
    turnAt = stage.now
    keyTint.copy(KEY_LIGHT).lerp(new THREE.Color(PALETTES[player].color), 0.14)
    if (framedByViewer || rig.userControlled || reducedMotion() || shown.winner) return
    const [cx, cz] = COURTS[player]
    const base = Math.atan2(HOME_VIEW.x, HOME_VIEW.z),
      toward = Math.atan2(cx, cz)
    let turn = toward - base
    turn = Math.atan2(Math.sin(turn), Math.cos(turn))
    const azimuth = base + Math.max(-0.24, Math.min(0.24, turn)),
      radius = Math.hypot(HOME_VIEW.x, HOME_VIEW.z)
    const focus = new THREE.Vector3(cx * 0.12, 0, cz * 0.12)
    rig.to(
      {
        position: new THREE.Vector3(Math.sin(azimuth) * radius, HOME_VIEW.y, Math.cos(azimuth) * radius).add(
          focus,
        ),
        target: focus,
      },
      1.8,
    )
  }

  function celebrate(winner: PlayerId) {
    celebrated = true
    cue({ kind: 'win' })
    if (quiet || reducedMotion()) return
    const colors = [...Object.values(PALETTES).map((p) => p.color), ...GOLD]
    ;[
      [-4.4, 4.4],
      [4.4, 4.4],
      [4.4, -4.4],
      [-4.4, -4.4],
    ].forEach(([x, z], i) =>
      at(i * 140, () =>
        particles.burst({
          origin: new THREE.Vector3(x, 0.5, z),
          kind: 'confetti',
          count: 80,
          colors,
          speed: 7,
          spread: 0.38,
        }),
      ),
    )
    at(650, () => {
      particles.burst({
        origin: new THREE.Vector3(0, 0.6, 0),
        kind: 'spark',
        count: 40,
        colors: [PALETTES[winner].color, ...GOLD],
        speed: 4.5,
        spread: 0.7,
        life: 1.2,
      })
      ring(new THREE.Vector3(0, 0.45, 0), '#f1d98a', 900, 0.8, 3.2, 1.4)
    })
    if (!rig.userControlled)
      rig.to({ position: HOME_VIEW, target: new THREE.Vector3(0, 0.4, 0), zoom: 1.32 }, 1.6)
  }

  // ── Choosing a piece ──────────────────────────────────────────────────────
  interface LitTile {
    set: 0 | 1
    index: number
    level: number
    goal: number
    order: number
  }
  const lit = new Map<string, LitTile>(),
    pathColor = new THREE.Color(),
    scratch = new THREE.Color()

  function pathKeys(piece: Piece, move: LegalMove) {
    const steps =
      move.from < 0 ? [0] : Array.from({ length: move.to - move.from }, (_, i) => move.from + i + 1)
    return steps.flatMap((progress) =>
      progress >= HOME
        ? []
        : progress < TRACK_LENGTH
          ? [`track-${absoluteSpace({ ...piece, progress })}`]
          : [`${piece.playerId}-${progress}`],
    )
  }

  /** The destination ring, the ghost and the lit path for whichever legal piece is in focus. */
  function preview() {
    const move = mine() ? shown.legalMoves.find((m) => m.pieceId === focused) : undefined
    for (const ghost of ghosts.values()) ghost.visible = false
    destination.visible = Boolean(move)
    const keys: string[] = []
    if (move) {
      const piece = tokens.get(move.pieceId)!.piece,
        palette = PALETTES[piece.playerId],
        [x, z] = piecePosition({ ...piece, progress: move.to })
      destination.position.set(x, move.to === HOME ? 0.45 : 0.335, z)
      destinationRing.material.color.set(palette.color)
      destinationCenter.material.color.set(palette.color)
      const ghost = ghostOf(piece.playerId)
      ghost.position.set(x, restY(move.to), z)
      ghost.scale.setScalar(move.to === HOME ? 0.42 : 1)
      ghost.visible = true
      pathColor.set(palette.color)
      keys.push(...pathKeys(piece, move))
    }
    for (const [key, tile] of lit) if (!keys.includes(key)) tile.goal = 0
    keys.forEach((key, order) => {
      const slot = tiles.slots.get(key)
      if (!slot) return
      const tile = lit.get(key)
      if (tile) {
        tile.goal = 1
        tile.order = order
      } else lit.set(key, { set: slot[0], index: slot[1], level: 0, goal: 1, order })
    })
    pathAt = stage.now
    stage.invalidate()
  }
  function setFocus(id: string | null) {
    if (id !== null && !legal.has(id)) return
    if (focused === id) return
    focused = id
    preview()
  }

  function pickPiece(event: { clientX: number; clientY: number }) {
    return stage.pick(event, pieceGroups)[0]?.object.userData.pieceId as string | undefined
  }
  const onMove = (event: PointerEvent) => {
    if (event.buttons) return
    const id = pickPiece(event),
      ok = id !== undefined && legal.has(id)
    canvas.style.cursor = ok ? 'pointer' : 'grab'
    if ((ok ? id : null) !== hovered) {
      hovered = ok ? id : null
      hoverDirty = true
      stage.invalidate()
    }
    if (ok) setFocus(id)
  }
  const onLeave = () => {
    hovered = null
    hoverDirty = true
    for (const token of tokens.values()) token.press.target = 0
    stage.invalidate()
  }
  const onDown = (event: PointerEvent) => {
    const id = pickPiece(event)
    if (id && legal.has(id)) {
      tokens.get(id)!.press.target = 1
      stage.invalidate()
    }
  }
  const onUp = () => {
    for (const token of tokens.values()) token.press.target = 0
    stage.invalidate()
  }
  const offTap = onTap(canvas, (event) => {
    const id = pickPiece(event)
    if (id && legal.has(id)) commit(id)
  })
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerleave', onLeave)
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('pointercancel', onUp)

  /** The chosen piece bobs once in acknowledgement while the room confirms the move. */
  function commit(id: string) {
    const token = tokens.get(id)!
    hooks.select(id)
    if (reducedMotion()) return
    tweens.add({
      duration: 240,
      update: (_, u) => {
        token.nod = 1 - 0.18 * Math.exp(-3 * u) * Math.sin(u * Math.PI * 2)
      },
      done: () => void (token.nod = 1),
    })
  }

  // ── The frame ─────────────────────────────────────────────────────────────
  const offMotion = onMotionChange(() => stage.invalidate())
  const bodyYaw = new THREE.Quaternion()
  stage.onFrame((dt, now) => {
    const ms = dt * 1000,
      reduced = reducedMotion()
    const speed = backlog > 3 ? 3 : backlog > 1 ? 1.6 : 1
    tweens.speed = speed
    // Tweens first, so a beat's last landing has run before the queue starts the next one.
    let moving = tweens.step(ms)
    moving = queue.step(ms * speed) || moving

    if (localShakeAt >= 0 && now - localShakeAt > 3000 && target.phase === 'roll') {
      // The room never took the roll: put the die back down on what it showed.
      localShakeAt = -1
      shakenTurn = -1
      dieThrow.throw(target.lastDice || 1, 450)
    }
    moving = dieThrow.step(dt) || moving
    moving = particles.step(dt) || moving
    moving = trayDust.step(dt) || moving
    moving = controls.update() || moving
    moving = rig.step(dt) || moving

    const choosing = mine(),
      winner = shown.winner,
      k = dampFactor(16, dt)
    if (hoverDirty) {
      hoverDirty = false
      for (const token of tokens.values()) token.lift.target = token.piece.id === hovered ? 0.14 : 0
    }
    for (const token of tokens.values()) {
      if (!token.flying) {
        token.pos.lerp(token.slot, k)
        token.size = lerp(token.size, token.slotScale, k)
        token.sy = damp(token.sy, 1, 18, dt)
        token.rot.slerp(IDENTITY, k)
        if (
          token.pos.distanceToSquared(token.slot) > 1e-7 ||
          Math.abs(token.size - token.slotScale) > 1e-4 ||
          Math.abs(token.sy - 1) > 1e-4
        )
          moving = true
        else {
          token.pos.copy(token.slot)
          token.size = token.slotScale
          token.sy = 1
        }
      }
      if (stepSpring(token.lift, 180, dt)) moving = true
      if (stepSpring(token.press, 400, dt)) moving = true
      const isLegal = choosing && legal.has(token.piece.id)
      let bob = 0
      token.body.quaternion.copy(token.rot)
      if (isLegal && !reduced) bob = Math.sin(now * 0.004 + token.piece.index) * 0.035 + 0.04
      let hopY = 0,
        hopSquash = 1
      if (winner === token.piece.playerId && !token.flying && !reduced) {
        // Winners hop in turn, a little Mexican wave around the centre.
        const cycle = (now + token.piece.index * 220) % 1500
        if (cycle < 560) {
          const u = cycle / 560
          hopY = arc(u, 0.55)
          hopSquash = u < 0.12 || u > 0.88 ? 0.86 : 1.06
        }
        token.body.quaternion.premultiply(bodyYaw.setFromAxisAngle(UP, now * 0.0012 + token.piece.index))
        moving = true
      }
      token.group.position.copy(token.pos)
      token.group.scale.setScalar(token.size)
      token.body.position.y = token.lift.value + bob + hopY - token.press.value * 0.03
      const sy = token.sy * token.nod * hopSquash * (1 - 0.1 * token.press.value),
        sx = 1 / Math.sqrt(sy)
      token.body.scale.set(sx, sy, sx)

      token.haloLevel = damp(token.haloLevel, isLegal ? 1 : 0, 12, dt)
      if (Math.abs(token.haloLevel - (isLegal ? 1 : 0)) > 0.002) moving = true
      const halo = token.halo
      halo.visible = token.haloLevel > 0.01
      if (halo.visible) {
        const pulse = reduced ? 1 : 1 + Math.sin(now * 0.004) * 0.07
        halo.material.opacity = 0.75 * token.haloLevel
        halo.position.set(token.pos.x, token.slot.y + 0.007, token.pos.z)
        halo.scale.setScalar(token.size * pulse * (1.25 - 0.25 * token.haloLevel))
      }
      if (isLegal) moving = true
    }

    if (destination.visible) {
      destination.scale.setScalar(reduced ? 1 : 1 + Math.sin(now * 0.006) * 0.06)
      moving = true
    }

    // The path to the focused piece's destination lights tile by tile.
    if (lit.size) {
      for (const [keyName, tile] of lit) {
        const ready = now - pathAt >= (reduced ? 0 : tile.order * 45)
        if (ready || tile.goal === 0) tile.level = damp(tile.level, tile.goal, 14, dt)
        const pulse = reduced ? 1 : 0.85 + 0.15 * Math.sin(now * 0.005 - tile.order * 0.55)
        const mesh = tiles.meshes[tile.set]
        mesh.setColorAt(
          tile.index,
          scratch.copy(tiles.base[tile.set][tile.index]).lerp(pathColor, 0.6 * tile.level * pulse),
        )
        mesh.instanceColor!.needsUpdate = true
        if (tile.goal === 0 && tile.level < 0.003) {
          mesh.setColorAt(tile.index, tiles.base[tile.set][tile.index])
          lit.delete(keyName)
        }
      }
      moving = true
    }

    // The court whose turn it is glows: a double pulse on arrival, then a steady ember.
    const since = now - turnAt
    for (const [id, border] of courtBorders) {
      const current = id === turnOf && !winner
      const pulse =
        current && !reduced && since < 1100 ? 0.4 * Math.abs(Math.sin((since / 1100) * Math.PI * 2)) : 0
      const goal = (current ? 0.12 : 0) + pulse
      const next = since < 1100 && current ? goal : damp(border.emissiveIntensity, goal, 6, dt)
      if (Math.abs(next - border.emissiveIntensity) > 1e-4) moving = true
      border.emissiveIntensity = next
    }
    if (!key.color.equals(keyTint)) {
      key.color.lerp(keyTint, dampFactor(4, dt))
      if (Math.abs(key.color.r - keyTint.r) + Math.abs(key.color.b - keyTint.b) < 1e-3)
        key.color.copy(keyTint)
      moving = true
    }
    return moving || queue.busy || tweens.active
  })
  stage.onDispose(() => {
    offMotion()
    offTap()
    canvas.removeEventListener('pointermove', onMove)
    canvas.removeEventListener('pointerleave', onLeave)
    canvas.removeEventListener('pointerdown', onDown)
    canvas.removeEventListener('pointerup', onUp)
    canvas.removeEventListener('pointercancel', onUp)
    controls.removeEventListener('start', onViewer)
    controls.removeEventListener('change', stage.invalidate)
    rig.dispose()
    controls.dispose()
    particles.dispose()
    trayDust.dispose()
  })

  snap(initial)
  stage.start()

  return {
    update(next, nextSeat, nextLive) {
      const seatChanged = nextSeat !== seat || nextLive !== live
      seat = nextSeat
      live = nextLive
      if (next === target) {
        if (seatChanged) present(shown)
        return
      }
      plan(next)
      if (seatChanged) present(shown)
    },
    roll() {
      if (!live || queue.busy || target.phase !== 'roll' || dieThrow.busy) return
      shakenTurn = target.turn
      localShakeAt = stage.now
      cue({ kind: 'roll' })
      if (!reducedMotion()) dieThrow.shake()
      stage.invalidate()
    },
    focus(id) {
      setFocus(id)
    },
    reset() {
      framedByViewer = false
      rig.to({ position: HOME_VIEW, target: ORIGIN, zoom: 1 }, reducedMotion() ? 30 : 5)
      stage.invalidate()
    },
    zoom(direction) {
      rig.to(
        { zoom: THREE.MathUtils.clamp(camera.zoom + direction * 0.15, 0.75, 1.8) },
        reducedMotion() ? 30 : 6,
      )
      stage.invalidate()
    },
    top() {
      framedByViewer = true
      rig.to({ position: TOP_VIEW, target: ORIGIN, zoom: 1 }, reducedMotion() ? 30 : 4)
      stage.invalidate()
    },
    dispose() {
      queue.clear()
      tweens.cancelAll()
      stage.dispose()
    },
  }
}

interface HopShape {
  first: boolean
  height: number
  tilt: THREE.Vector3
  scaleFrom: number
  scaleTo: number
}
