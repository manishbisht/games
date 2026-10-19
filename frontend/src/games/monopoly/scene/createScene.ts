import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { BOARD } from '@games/shared/estate/board'
import { gameReducer } from '@games/shared/estate'
import type { Card, GameState } from '@games/shared/estate/types'
import { ESTATE_PACING } from '@games/shared/estate/online'
import { createStage, onTap } from '../../../motion/stage'
import { createCameraRig } from '../../../motion/camera'
import { createDieThrow } from '../../../motion/dice'
import type { DieThrow } from '../../../motion/dice'
import { createParticles, qualityDensity } from '../../../motion/particles'
import { createQueue, createTweens } from '../../../motion/tween'
import type { Beat, Tween } from '../../../motion/tween'
import {
  arc,
  clamp01,
  damp,
  inOutCubic,
  inOutSine,
  inQuad,
  lerp,
  outBack,
  outBounce,
  outCubic,
  smooth,
  squash,
} from '../../../motion/ease'
import { onMotionChange, reducedMotion } from '../../../motion/preference'
import type { Sound } from '../game/audio'
import { BANK, COIN_STAGGER, coinCount, transfers } from '../game/transfers'
import { cardKeyOf } from '../online/session'
import { createCoins } from './coins'
import { createLots } from './lots'
import {
  boardPosition,
  box,
  canvasTexture,
  createLotKit,
  dieRotation,
  makeDie,
  makeJailCell,
  makeToken,
  material,
  tileTexture,
  wrap,
} from './models'
import type { TokenModel } from './models'
import { CELL, JAIL, SURFACE, spotFor, stepsBetween, tileCentre, turnBetween } from './path'

/**
 * What the board tells the page as it plays a turn out. The server's state
 * arrives all at once; the board turns it into a story — dice, a walk, a deed —
 * and only `present`s each state once its story has been seen, so the money,
 * the buy prompt and the card wait for the token to land.
 */
export type SceneCue =
  | { type: 'present'; state: GameState }
  | { type: 'go'; player: number }
  | { type: 'dice'; rollId: number }
  | { type: 'sound'; sound: Sound; strength?: number; pan?: number }

/**
 * How far into its current beat the room already was: `elapsed` ms when the
 * snapshot was received, at `at` on this page's `performance.now()` clock.
 */
export interface BeatSync {
  elapsed: number
  at: number
}

export interface SceneApi {
  update: (state: GameState, sync?: BeatSync) => void
  select: (id: number | null) => void
  /** Rattle the dice in the hand while the roll is on its way to the server. */
  shake: () => void
  reset: () => void
  zoom: (direction: number) => void
  topView: () => void
  dispose: () => void
}

/** A square a step. The server allows 215ms; a little under leaves the landing time to breathe. */
const STEP_MS = 200
/** The settle after the last step: squash, dust, the tile giving a little. */
const LAND_MS = 280
/**
 * The dice are given 1200ms by the server. The toss rises from wherever the
 * dice were let go — in the hand if the roller shook them, on the table if not —
 * so the whole beat can be the throw.
 */
const THROW_MS = 960
const DICE_MS = THROW_MS + 70 + 150
/** A beat the page only learns of this late is joined where it already is, not played from the top. */
const JOIN_AFTER_MS = 150
const ORIGIN = new THREE.Vector3(0, 0.05, 0)
const HOME = new THREE.Vector3(12, 18, 20)
const TILE_Y = 0.17

interface Plan {
  position: number
  jailed: boolean
}

export function createScene(
  container: HTMLElement,
  initial: GameState,
  {
    onSelect,
    onCue,
    sync,
  }: { onSelect: (id: number) => void; onCue: (cue: SceneCue) => void; sync?: BeatSync },
): SceneApi {
  let state = initial,
    disposed = false
  const stage = createStage(container, {
    label: 'Interactive 3D Estate board. Drag to rotate, scroll to zoom. Select a space for its details.',
    exposure: 1,
    environmentIntensity: 0.22,
    maxPixelRatio: 2,
  })
  const { scene } = stage
  const camera = new THREE.OrthographicCamera(-10, 10, 7, -7, 0.1, 100)
  camera.position.copy(HOME)
  camera.lookAt(ORIGIN)
  stage.setCamera(camera)
  const controls = new OrbitControls(camera, stage.canvas)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.enablePan = false
  controls.minPolarAngle = 0.08
  controls.maxPolarAngle = Math.PI / 2.6
  controls.minZoom = 0.7
  controls.maxZoom = 2
  controls.rotateSpeed = 0.5
  controls.zoomSpeed = 0.65
  controls.target.copy(ORIGIN)
  const onControlsChange = () => stage.invalidate()
  controls.addEventListener('change', onControlsChange)
  const rig = createCameraRig(camera, controls)
  // Behind by snapshots, not beats: one roll's dice, walk and card is a story, not a backlog.
  const tweens = createTweens(),
    queue = createQueue({ countBy: 'push', catchUpAfter: 3, catchUpSpeed: 2.5 })
  const particles = createParticles(scene, { max: 520, floor: 0.232 })
  // Dust, sparks, confetti — and the coins, which read this too — thin to the
  // quality tier: a slow device keeps the moment, with less in the air.
  particles.density = qualityDensity(stage.quality)
  stage.onQuality((tier) => (particles.density = qualityDensity(tier)))
  const screen = new THREE.Vector2()
  /** Where on the board, left to right, a sound happened. */
  const panOf = (at: THREE.Vector3) =>
    stage.size.width
      ? THREE.MathUtils.clamp((stage.toScreen(at, screen).x / stage.size.width) * 2 - 1, -1, 1) * 0.6
      : 0
  const coins = createCoins(scene, {
    onLand: (strength, at) => cue({ type: 'sound', sound: 'coin', strength, pan: panOf(at) }),
  })

  stage.onResize((w, h) => {
    const aspect = w / h,
      half = Math.max(6.5, 8.7 / aspect)
    camera.left = -half * aspect
    camera.right = half * aspect
    camera.top = half
    camera.bottom = -half
    camera.updateProjectionMatrix()
  })

  const hemisphere = new THREE.HemisphereLight('#e1ebff', '#8c7f65', 1.3)
  scene.add(hemisphere)
  const key = new THREE.DirectionalLight('#fff1d9', 1.8)
  key.position.set(-6, 14, 8)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  Object.assign(key.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10, near: 0.5, far: 35 })
  key.shadow.bias = -0.0005
  key.shadow.normalBias = 0.02
  scene.add(key)
  // Below full quality the shadow map halves too; tier 0 drops shadows altogether (the stage's call).
  const lighterShadows = () => {
    if (stage.quality === 2 || key.shadow.mapSize.x <= 1024) return
    key.shadow.mapSize.set(1024, 1024)
    key.shadow.map?.dispose()
    key.shadow.map = null
    stage.invalidate()
  }
  lighterShadows()
  stage.onQuality(lighterShadows)
  const fill = new THREE.DirectionalLight('#9ab9ef', 0.65)
  fill.position.set(8, 7, -10)
  scene.add(fill)
  // The winner's light: off until there is one.
  const spot = new THREE.SpotLight('#fff0cf', 0, 14, 0.32, 0.65, 1.2)
  spot.position.set(0, 7, 0)
  scene.add(spot, spot.target)

  // A physical slab and a matte tabletop make the board read as an object in space.
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.ShadowMaterial({ color: '#000000', opacity: 0.3 }),
  )
  floor.rotation.x = -Math.PI / 2
  floor.position.y = -0.62
  floor.receiveShadow = true
  scene.add(floor)
  const plinth = box(12.34, 0.38, 12.34, '#60412b', 0.16)
  plinth.position.y = -0.29
  scene.add(plinth)
  const rim = box(12.26, 0.22, 12.26, '#b49762', 0.13)
  rim.position.y = -0.065
  scene.add(rim)
  const board = box(12.07, 0.12, 12.07, '#c5b591', 0.1)
  board.position.y = 0.075
  scene.add(board)
  const center = box(8.43, 0.018, 8.43, '#254b3e', 0.04)
  center.position.y = 0.15
  scene.add(center)

  const centerMap = canvasTexture(1536, 1536, (ctx) => {
    ctx.fillStyle = '#294d40'
    ctx.fillRect(0, 0, 1536, 1536)
    ctx.strokeStyle = '#c4c39a12'
    ctx.lineWidth = 2
    for (let n = 48; n < 1536; n += 64) {
      ctx.beginPath()
      ctx.moveTo(n, 0)
      ctx.lineTo(n, 1536)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(0, n)
      ctx.lineTo(1536, n)
      ctx.stroke()
    }
    ctx.strokeStyle = '#c0b27e99'
    ctx.lineWidth = 3
    ctx.strokeRect(35, 35, 1466, 1466)
    ctx.strokeRect(48, 48, 1440, 1440)
    ctx.textAlign = 'center'
    ctx.fillStyle = '#f0e1b8'
    ctx.font = '500 26px Arial'
    ctx.fillText('A LITTLE LUCK. A LOT OF STRATEGY.', 768, 690)
    ctx.font = '800 175px Arial'
    ctx.fillText('ESTATE', 768, 858)
    ctx.fillStyle = '#cccfb3'
    ctx.font = '500 28px Arial'
    ctx.fillText('T H E   C I T Y   I S   Y O U R S .', 768, 925)
    ctx.fillStyle = '#b7ac7e'
    ctx.fillRect(643, 987, 250, 2)
    ctx.font = '500 19px Arial'
    ctx.fillText('BUILD YOUR OWN FORTUNE', 768, 1043)
    ctx.fillStyle = '#b1b79c'
    ctx.font = '500 20px Arial'
    ctx.fillText('EST. 2026', 768, 1466)
  })
  const centerPrint = new THREE.Mesh(
    new THREE.PlaneGeometry(8.4, 8.4),
    new THREE.MeshStandardMaterial({ map: centerMap, roughness: 0.9 }),
  )
  centerPrint.rotation.x = -Math.PI / 2
  centerPrint.position.y = 0.167
  scene.add(centerPrint)

  // Original card decks, lightly offset to reveal their paper edges. Chance is
  // deck 0, Community Chest deck 1.
  const paper = material('#eee9d9'),
    deckArt: THREE.Texture[] = [],
    deckTop: THREE.Vector3[] = [],
    deckTurn: THREE.Quaternion[] = []
  for (let deck = 0; deck < 2; deck++) {
    const stack = new THREE.Group()
    stack.position.set(deck ? 2.65 : -2.6, 0.2, deck ? -1.9 : 0.3)
    stack.rotation.y = deck ? -0.2 : 0.18
    for (let i = 0; i < 4; i++) {
      const card = box(1.15, 0.025, 1.7, '#eee9d9', 0.03, paper)
      card.position.set(i * 0.012, i * 0.028, -i * 0.012)
      stack.add(card)
    }
    const map = canvasTexture(256, 384, (ctx) => {
      ctx.fillStyle = deck ? '#3b7580' : '#bc783b'
      ctx.fillRect(0, 0, 256, 384)
      ctx.strokeStyle = '#fff9e866'
      ctx.lineWidth = 2
      ctx.strokeRect(15, 15, 226, 354)
      ctx.textAlign = 'center'
      ctx.fillStyle = '#fff7e4'
      ctx.font = '600 112px Georgia'
      ctx.fillText(deck ? '◇' : '?', 128, 218)
      ctx.font = '600 20px Arial'
      ctx.fillText(deck ? 'COMMUNITY' : 'CHANCE', 128, 285)
      if (deck) ctx.fillText('CHEST', 128, 313)
    })
    deckArt.push(map)
    const top = new THREE.Mesh(
      new THREE.PlaneGeometry(1.15, 1.7),
      new THREE.MeshStandardMaterial({ map, roughness: 0.7 }),
    )
    top.rotation.x = -Math.PI / 2
    top.position.set(0.036, 0.098, -0.036)
    stack.add(top)
    scene.add(stack)
    stack.updateMatrixWorld()
    deckTop.push(new THREE.Vector3(0.036, 0.12, -0.036).applyMatrix4(stack.matrixWorld))
    deckTurn.push(stack.quaternion.clone())
  }

  // A miniature architectural skyline is a quiet sculptural detail in the center.
  const city = new THREE.Group()
  city.position.set(-0.35, 0.2, -2.5)
  city.rotation.y = -0.15
  city.add(box(2.8, 0.08, 1.25, '#b2bda5', 0.09))
  const buildings = [
    { x: -0.94, z: 0.1, h: 0.54, w: 0.45 },
    { x: -0.42, z: -0.18, h: 0.97, w: 0.45 },
    { x: 0.16, z: 0.12, h: 1.48, w: 0.52 },
    { x: 0.76, z: -0.15, h: 0.82, w: 0.51 },
    { x: 1.11, z: 0.26, h: 0.35, w: 0.3 },
  ]
  const roofing = material('#a0ac98'),
    greenery = material('#7e9e7a'),
    bark = material('#9a8764'),
    windowSpots: THREE.Vector3[] = []
  buildings.forEach((b, i) => {
    const block = box(b.w, b.h, 0.43, ['#d6d6bb', '#eddfbe', '#f0e6cd', '#c0cab3', '#ded5b5'][i], 0.035)
    block.position.set(b.x, b.h / 2 + 0.06, b.z)
    city.add(block)
    const roof = box(b.w + 0.035, 0.06, 0.465, '#a0ac98', 0.015, roofing)
    roof.position.set(b.x, b.h + 0.08, b.z)
    city.add(roof)
    for (let y = 0.21; y < b.h; y += 0.22)
      for (let x = -0.12; x <= 0.12; x += 0.24)
        windowSpots.push(new THREE.Vector3(b.x + x, y + 0.08, b.z + 0.219))
    if (i === 2) {
      const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.035, 0.4, 8), material('#879982', 0.4))
      spire.position.set(b.x, b.h + 0.28, b.z)
      city.add(spire)
    }
  })
  // Every window in the skyline is one instance of one quad.
  const windows = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(0.08, 0.1),
    material('#798b7c'),
    windowSpots.length,
  )
  const placement = new THREE.Matrix4()
  windowSpots.forEach((at, i) => windows.setMatrixAt(i, placement.makeTranslation(at.x, at.y, at.z)))
  city.add(windows)
  const trunk = new THREE.CylinderGeometry(0.025, 0.035, 0.24, 8),
    crown = new THREE.IcosahedronGeometry(0.17, 1)
  for (const x of [-1.24, 1.38]) {
    const stem = new THREE.Mesh(trunk, bark)
    stem.position.set(x, 0.15, 0.45)
    city.add(stem)
    const leaves = new THREE.Mesh(crown, greenery)
    leaves.position.set(x, 0.36, 0.45)
    leaves.castShadow = true
    city.add(leaves)
  }
  scene.add(city)

  const tiles: THREE.Object3D[] = [],
    tileGroups = new Map<number, THREE.Group>()
  const slab = material('#eee9d9')
  BOARD.forEach((space) => {
    const corner = space.id % 10 === 0,
      width = corner ? 1.5 : 0.922
    const group = new THREE.Group(),
      [x, z] = boardPosition(space.id)
    group.position.set(x, TILE_Y, z)
    group.rotation.y = (-Math.floor(space.id / 10) * Math.PI) / 2
    group.add(box(width, 0.11, 1.5, '#eee9d9', 0.022, slab))
    const top = new THREE.Mesh(
      new THREE.PlaneGeometry(width - 0.026, 1.474),
      new THREE.MeshStandardMaterial({ map: tileTexture(space), roughness: 0.78 }),
    )
    top.rotation.x = -Math.PI / 2
    top.position.y = 0.059
    top.userData.spaceId = space.id
    group.add(top)
    tiles.push(top)
    scene.add(group)
    tileGroups.set(space.id, group)
  })
  // The cell sits on the jail corner's tile, so it gives with it when someone lands.
  const cell = makeJailCell(CELL.size)
  const [jailX, jailZ] = boardPosition(JAIL)
  cell.position.set(CELL.x - jailX, 0.059, CELL.z - jailZ)
  cell.position.applyAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2)
  tileGroups.get(JAIL)!.add(cell)

  /** A tile gives a little under a piece landing on it, and springs back. */
  function dip(id: number, depth: number) {
    const group = tileGroups.get(id)
    if (!group || reducedMotion()) return
    tweens.add({
      duration: 260,
      update: (_t, raw) => {
        group.position.y = TILE_Y - Math.sin(raw * Math.PI) * depth * (1 - raw * 0.4)
      },
      done: () => {
        group.position.y = TILE_Y
      },
    })
  }

  // Rings of colour that spread over the board where something changes hands.
  const ringGeometry = new THREE.TorusGeometry(0.42, 0.028, 8, 48)
  const bursts = Array.from({ length: 4 }, () => {
    const mesh = new THREE.Mesh(
      ringGeometry,
      new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false }),
    )
    mesh.rotation.x = -Math.PI / 2
    mesh.visible = false
    scene.add(mesh)
    return mesh
  })
  let burstNext = 0
  function ringBurst(at: THREE.Vector3, color: THREE.ColorRepresentation, size = 1) {
    const mesh = bursts[burstNext++ % bursts.length]
    mesh.position.set(at.x, Math.max(at.y, 0.25), at.z)
    mesh.material.color.set(color)
    mesh.visible = true
    tweens.add({
      duration: 620,
      ease: outCubic,
      update: (t) => {
        mesh.scale.setScalar((0.3 + t * 1.4) * size)
        mesh.material.opacity = 0.9 * (1 - t)
      },
      done: () => {
        mesh.visible = false
      },
    })
  }

  const kit = createLotKit()
  stage.onDispose(kit.dispose)
  const cue = (next: SceneCue) => {
    if (!disposed) onCue(next)
  }
  const lots = createLots({
    kit,
    tiles: tileGroups,
    tweens,
    particles,
    ring: ringBurst,
    onBuild: () => cue({ type: 'sound', sound: 'build' }),
  })

  // Hover and selection: one outline that fades in where the pointer is.
  const normalOutline = tileOutline(1.025, 1.6),
    cornerOutline = tileOutline(1.6, 1.6)
  stage.onDispose(() => {
    normalOutline.dispose()
    cornerOutline.dispose()
  })
  const focusMaterial = new THREE.MeshBasicMaterial({
    color: '#ffb74f',
    toneMapped: false,
    depthWrite: false,
    transparent: true,
    opacity: 0,
    side: THREE.DoubleSide,
  })
  const focus = new THREE.Mesh(normalOutline, focusMaterial)
  focus.rotation.x = -Math.PI / 2
  focus.visible = false
  focus.renderOrder = 3
  scene.add(focus)
  let selectedSpace: number | null = null,
    hoveredSpace: number | null = null,
    focusAlpha = 0,
    focusTarget = 0
  function refreshFocus() {
    const id = selectedSpace ?? hoveredSpace
    focusTarget = id === null ? 0 : 1
    if (id !== null) {
      const [x, z] = boardPosition(id)
      if (!focus.visible || focusAlpha < 0.05) focusAlpha = 0
      focus.visible = true
      focus.position.set(x, 0.255, z)
      focus.geometry = id % 10 === 0 ? cornerOutline : normalOutline
      focus.rotation.set(-Math.PI / 2, 0, (Math.floor(id / 10) * Math.PI) / 2)
      focusMaterial.color.set(selectedSpace !== null ? '#ffd58b' : '#f3a737')
    }
    stage.invalidate()
  }
  const tooltip = document.createElement('div')
  tooltip.className = 'board-tooltip'
  tooltip.setAttribute('role', 'tooltip')
  tooltip.hidden = true
  const tooltipTitle = document.createElement('strong'),
    tooltipDetail = document.createElement('span')
  tooltip.append(tooltipTitle, tooltipDetail)
  container.appendChild(tooltip)

  // Tokens, each with the plan of where it will be once the queued story has played.
  let tokens: TokenModel[] = [],
    plan: Plan[] = [],
    toppled: boolean[] = []
  function setupTokens() {
    for (const token of tokens) {
      scene.remove(token.group)
      token.group.traverse((child) => (child as THREE.Mesh).geometry?.dispose())
      token.materials.forEach((m) => m.dispose())
    }
    tokens = state.players.map((p) => {
      const token = makeToken(p.token, p.color)
      scene.add(token.group)
      return token
    })
  }
  setupTokens()

  // The turn ring, which shrinks off one token and grows onto the next.
  const ringMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85 })
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.018, 8, 48), ringMaterial)
  ring.rotation.x = -Math.PI / 2
  scene.add(ring)
  let ringPlayer = -1,
    ringScale = 1,
    pulseUntil = 0

  // Two dice, each thrown on its own seed so they never tumble in step.
  const dice = [makeDie(), makeDie()]
  const rests = [new THREE.Vector3(-0.55, 0.5, 2.52), new THREE.Vector3(0.65, 0.5, 2.8)]
  const twists = [-0.2, 0.4]
  const throws: DieThrow[] = dice.map((die, i) => {
    die.position.copy(rests[i])
    scene.add(die)
    return createDieThrow(die, {
      rest: rests[i],
      face: (value) => dieRotation(value, twists[i]),
      size: 0.64,
      // From the left of the default view and above it, so the toss reads across the screen.
      release: i ? new THREE.Vector3(-2.1, 1.5, 1.6) : new THREE.Vector3(-2.5, 1.8, 1.0),
      seed: i ? 7 : 1,
      onContact: (strength) => {
        if (strength > 0.3)
          particles.burst({
            origin: die.position,
            kind: 'dust',
            count: Math.round(7 * strength),
            colors: ['#e7e0cc', '#cfc4a8'],
            size: 0.6,
          })
        if (i === 0) cue({ type: 'sound', sound: 'tap', strength, pan: panOf(die.position) })
      },
    })
  })
  let shaking = false,
    shakeUntil = 0

  // The card a player draws: lifted off its deck, turned to face the table,
  // and handed to the page to read.
  const faceCanvas = document.createElement('canvas')
  faceCanvas.width = 256
  faceCanvas.height = 384
  const faceMap = new THREE.CanvasTexture(faceCanvas)
  faceMap.colorSpace = THREE.SRGBColorSpace
  faceMap.anisotropy = 8
  const backMaterial = new THREE.MeshStandardMaterial({ map: deckArt[0], roughness: 0.7 })
  const drawn = new THREE.Group()
  const cardEdge = new THREE.Mesh(new THREE.BoxGeometry(1.15, 0.018, 1.7), paper)
  const cardBack = new THREE.Mesh(new THREE.PlaneGeometry(1.15, 1.7), backMaterial)
  cardBack.rotation.x = -Math.PI / 2
  cardBack.position.y = 0.0095
  const cardFace = new THREE.Mesh(
    new THREE.PlaneGeometry(1.15, 1.7),
    new THREE.MeshStandardMaterial({ map: faceMap, roughness: 0.75 }),
  )
  cardFace.rotation.x = Math.PI / 2
  cardFace.position.y = -0.0095
  drawn.add(cardEdge, cardBack, cardFace)
  drawn.visible = false
  scene.add(drawn)
  let drawnDeck = 0

  function paintCard(card: Card) {
    const ctx = faceCanvas.getContext('2d')!
    ctx.fillStyle = '#f6f0e1'
    ctx.fillRect(0, 0, 256, 384)
    ctx.fillStyle = card.deck === 'chance' ? '#bc783b' : '#3b7580'
    ctx.fillRect(0, 0, 256, 56)
    ctx.textAlign = 'center'
    ctx.fillStyle = '#fff7e4'
    ctx.font = '600 17px Arial'
    ctx.fillText(card.deck === 'chance' ? 'CHANCE' : 'COMMUNITY CHEST', 128, 35)
    ctx.fillStyle = '#263a32'
    ctx.font = '700 23px Georgia'
    wrap(ctx, card.title, 128, 104, 220, 28)
    ctx.fillStyle = '#4c5a55'
    ctx.font = '400 17px Arial'
    wrap(ctx, card.text, 128, 196, 214, 24)
    faceMap.needsUpdate = true
  }

  /** The orientation that shows the card's face square to the camera, text upright. */
  function facingCamera(out: THREE.Quaternion) {
    const toward = camera.position.clone().sub(controls.target).normalize(),
      up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion),
      y = toward.clone().negate(),
      x = new THREE.Vector3().crossVectors(y, up).normalize(),
      z = new THREE.Vector3().crossVectors(x, y)
    return out.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z))
  }

  const lift = new THREE.Vector3(),
    orbit = new THREE.Vector3(),
    goAt = new THREE.Vector3(),
    followPoint = new THREE.Vector3()
  const followGoal = new THREE.Vector3()
  let followed: TokenModel | null = null,
    overviewZoom = 1,
    release: Tween | null = null

  /**
   * Keep a walk in frame, a little closer than the overview. The camera aims
   * between the token and the square it is heading for, so it leads the walk
   * instead of chasing it, and settles on the landing.
   */
  function follow(token: TokenModel, goal: THREE.Vector3) {
    if (reducedMotion()) return
    release?.cancel()
    release = null
    if (!followed) overviewZoom = camera.zoom
    followed = token
    followGoal.copy(goal)
    rig.follow(
      () =>
        followed
          ? followPoint.set(
              (followed.group.position.x + followGoal.x) / 2,
              0.2,
              (followed.group.position.z + followGoal.z) / 2,
            )
          : null,
      { rate: 3.2, zoom: Math.min(2, overviewZoom * 1.2) },
    )
  }
  /** After `after` ms, ease back out to the whole board, at whatever angle the viewer left it. */
  function unfollow(after = 0) {
    if (!followed) return
    release?.cancel()
    release = tweens.add({
      delay: after,
      duration: 1,
      update: () => {},
      done: () => {
        release = null
        followed = null
        rig.follow(null)
        if (rig.userControlled) return
        const shift = controls.target.clone().sub(ORIGIN)
        rig.to({ target: ORIGIN, position: camera.position.clone().sub(shift), zoom: overviewZoom }, 2.2)
      },
    })
  }

  /**
   * One hop from wherever the token is to `end`: a parabolic arc, squash on
   * take-off and landing, and a turn toward the way it is going.
   */
  function hop(
    token: TokenModel,
    end: THREE.Vector3,
    { delay, duration, height, landing, gentle, onLand }: HopOptions,
  ) {
    const start = new THREE.Vector3(),
      target = end.clone()
    let yawFrom = 0,
      yawTo = 0
    tweens.add({
      delay,
      duration,
      start: () => {
        start.copy(token.group.position)
        yawFrom = token.group.rotation.y
        const dx = target.x - start.x,
          dz = target.z - start.z
        yawTo =
          dx * dx + dz * dz > 1e-4
            ? yawFrom + turnBetween(yawFrom, Math.atan2(dx, dz) - token.facing)
            : yawFrom
      },
      update: (_t, raw) => {
        token.group.position.lerpVectors(start, target, gentle ? smooth(raw) : inOutSine(raw))
        token.group.position.y = lerp(start.y, target.y, raw) + arc(raw, height)
        token.group.rotation.y = lerp(yawFrom, yawTo, outCubic(clamp01(raw / 0.45)))
        if (!gentle) {
          const [xz, y] = squash(raw, landing ? 1.35 : 0.75)
          token.body.scale.set(xz, y, xz)
        }
      },
      done: () => {
        token.body.scale.set(1, 1, 1)
        onLand?.()
      },
    })
  }

  /**
   * Walk `steps` squares forward from `from`, one hop a square, the GO square
   * paying as it is crossed. `place` puts the token on `from` first — a walk
   * joined partway, whose earlier squares the room has already played.
   */
  function walkBeat(player: number, from: number, steps: number, gentle: boolean, place = false): Beat {
    return {
      label: 'walk',
      run: () => {
        const token = tokens[player]
        if (!token) return 0
        if (place) spotFor(player, from, false, false, token.group.position)
        if (steps <= 0) return 0
        const step = gentle ? 70 : STEP_MS
        follow(token, spotFor(player, (from + steps) % 40))
        for (let i = 1; i <= steps; i++) {
          const position = (from + i) % 40,
            previous = (from + i - 1) % 40,
            last = i === steps
          const nearJail = position === JAIL || previous === JAIL
          hop(token, spotFor(player, position, false, !last && position === JAIL), {
            delay: (i - 1) * step,
            duration: step,
            height: gentle ? 0 : nearJail ? 0.85 : last ? 0.46 : 0.3,
            landing: last,
            gentle,
            onLand: () => {
              dip(position, last ? 0.05 : 0.022)
              cue({
                type: 'sound',
                sound: 'step',
                strength: last ? 0.9 : 0.4,
                pan: panOf(token.group.position),
              })
              if (position === 0) passGo(player)
              if (last && !gentle)
                particles.burst({
                  origin: token.group.position,
                  kind: 'dust',
                  count: 9,
                  colors: ['#efe8d6', '#d9cfb6'],
                  size: 0.7,
                })
            },
          })
        }
        const total = steps * step,
          settle = gentle ? 60 : LAND_MS
        // Stay on the landing while it is read, then pull back out.
        unfollow(total + settle + 650)
        return total + settle
      },
    }
  }

  /** The bank: the middle of the board, where taxes go and wages come from. */
  const bankAt = new THREE.Vector3(0, 0.2, 0.6)
  const coinFrom = new THREE.Vector3(),
    coinTo = new THREE.Vector3()
  /** Cash as the page was last shown it, and laps of GO already paid out on the board since. */
  let presentedCash: number[] = [],
    goCredit: number[] = []
  /** A payment's coins, from the top of one token (or the bank) to the foot of another. */
  function throwCoins(from: THREE.Vector3, to: THREE.Vector3, amount: number) {
    coinFrom.set(from.x, from.y + (from === bankAt ? 0 : 0.45), from.z)
    coinTo.set(to.x, to.y + 0.03, to.z)
    coins.fly(coinFrom, coinTo, Math.max(2, Math.round(coinCount(amount) * particles.density)), COIN_STAGGER)
  }
  const anchor = (player: number) => (player === BANK ? bankAt : (tokens[player]?.group.position ?? bankAt))

  function passGo(player: number) {
    cue({ type: 'go', player })
    // The page books the $200 now; the room's own record of it must not pay twice.
    goCredit[player] = (goCredit[player] ?? 0) + 200
    if (reducedMotion()) return
    const token = tokens[player]
    if (token) throwCoins(bankAt, token.group.position, 200)
    const at = tileCentre(0, goAt)
    ringBurst(at, '#f4c96b', 1.6)
    particles.burst({
      origin: at.setY(0.5),
      kind: 'spark',
      count: 26,
      colors: ['#f6d27a', '#a8dab1', '#fff4d8'],
      speed: 3.4,
      size: 0.75,
    })
  }

  /** Lifted off the board, flown over it and dropped behind bars. */
  function jailBeat(player: number, gentle: boolean): Beat {
    return {
      label: 'jail',
      run: () => {
        const token = tokens[player]
        if (!token) return 0
        unfollow()
        const start = token.group.position.clone(),
          end = spotFor(player, JAIL, true),
          high = 0.95
        if (gentle) {
          hop(token, end, { delay: 0, duration: 320, height: 0, landing: false, gentle })
          return 340
        }
        const yaw = token.group.rotation.y
        tweens.add({
          duration: 280,
          ease: outCubic,
          update: (t) => {
            token.group.position.y = start.y + t * high
            token.body.rotation.z = Math.sin(t * Math.PI) * 0.12
          },
        })
        tweens.add({
          delay: 280,
          duration: 920,
          update: (_t, raw) => {
            const t = inOutCubic(raw)
            token.group.position.x = lerp(start.x, end.x, t)
            token.group.position.z = lerp(start.z, end.z, t)
            token.group.position.y = lerp(start.y, end.y, raw) + high + arc(raw, 2.4)
            token.group.rotation.y = yaw + t * Math.PI * 2
          },
        })
        tweens.add({
          delay: 1200,
          duration: 420,
          update: (_t, raw) => {
            token.group.position.set(end.x, end.y + (1 - outBounce(raw)) * high, end.z)
          },
          done: () => {
            token.group.position.copy(end)
            dip(JAIL, 0.06)
            rig.shake(0.07, 240)
            particles.burst({
              origin: end,
              kind: 'dust',
              count: 12,
              colors: ['#d6d0c0', '#a9a493'],
              size: 0.8,
            })
          },
        })
        tweens.add({
          delay: 1290,
          duration: 1,
          update: () => {},
          done: () => cue({ type: 'sound', sound: 'jail' }),
        })
        return 1700
      },
    }
  }

  /** Out of the cell to the visiting side of the corner. */
  function releaseBeat(player: number, gentle: boolean): Beat {
    return {
      label: 'release',
      run: () => {
        const token = tokens[player]
        if (!token) return 0
        hop(token, spotFor(player, JAIL), {
          delay: 0,
          duration: gentle ? 160 : 460,
          height: gentle ? 0 : 0.95,
          landing: true,
          gentle,
        })
        return gentle ? 180 : 520
      },
    }
  }

  function diceBeat(values: [number, number], rollId: number, gentle: boolean, skip = 0): Beat {
    return {
      label: 'dice',
      run: () => {
        if (gentle) {
          shaking = false
          throws.forEach((t, i) => t.settle(values[i]))
          cue({ type: 'dice', rollId })
          return 160
        }
        shaking = false
        // Joined late: what is left of the throw, or — if most of it is gone —
        // the dice already down.
        if (skip > THROW_MS * 0.6) {
          throws.forEach((t, i) => t.settle(values[i]))
          cue({ type: 'dice', rollId })
          return Math.max(0, DICE_MS - skip)
        }
        // Straight from wherever they are — the roller's hand, or the table —
        // up to the release point and down: no gathering first.
        const throwMs = THROW_MS - skip
        cue({ type: 'sound', sound: 'roll', pan: panOf(dice[0].position) })
        throws.forEach((t, i) => t.throw(values[i], throwMs + i * 70))
        tweens.add({
          duration: throwMs + 70,
          update: () => {},
          done: () => cue({ type: 'dice', rollId }),
        })
        return DICE_MS - skip
      },
    }
  }

  function cardBeat(card: Card, gentle: boolean): Beat {
    return {
      label: 'card',
      run: () => {
        if (gentle) return 0
        paintCard(card)
        drawnDeck = card.deck === 'chance' ? 0 : 1
        backMaterial.map = deckArt[drawnDeck]
        backMaterial.needsUpdate = true
        const from = deckTop[drawnDeck].clone(),
          fromTurn = deckTurn[drawnDeck].clone(),
          to = from.clone().lerp(new THREE.Vector3(0, 2.4, 1.2), 0.75),
          toTurn = facingCamera(new THREE.Quaternion())
        drawn.position.copy(from)
        drawn.quaternion.copy(fromTurn)
        drawn.scale.setScalar(1)
        drawn.visible = true
        cue({ type: 'sound', sound: 'card' })
        tweens.add({
          duration: 780,
          update: (_t, raw) => {
            const t = outCubic(raw)
            drawn.position.lerpVectors(from, to, t)
            drawn.position.y += arc(raw, 0.6)
            drawn.quaternion.slerpQuaternions(fromTurn, toTurn, inOutCubic(clamp01((raw - 0.12) / 0.88)))
            drawn.scale.setScalar(lerp(1, 1.55, t))
          },
        })
        return 820
      },
    }
  }

  function returnCard(gentle: boolean) {
    if (!drawn.visible) return
    if (gentle) {
      drawn.visible = false
      return
    }
    const from = drawn.position.clone(),
      fromTurn = drawn.quaternion.clone(),
      to = deckTop[drawnDeck],
      toTurn = deckTurn[drawnDeck],
      scale = drawn.scale.x
    tweens.add({
      duration: 460,
      ease: inOutCubic,
      update: (t, raw) => {
        drawn.position.lerpVectors(from, to, t)
        drawn.position.y += arc(raw, 0.4)
        drawn.quaternion.slerpQuaternions(fromTurn, toTurn, t)
        drawn.scale.setScalar(lerp(scale, 1, t))
      },
      done: () => {
        drawn.visible = false
      },
    })
  }

  function moveRing(player: number, color: string, gentle: boolean) {
    if (ringPlayer < 0 || gentle) {
      ringPlayer = player
      ringMaterial.color.set(color)
      ringScale = 1
      return
    }
    const from = ringMaterial.color.clone(),
      to = new THREE.Color(color)
    tweens.add({
      duration: 150,
      ease: inQuad,
      update: (t) => {
        ringScale = 1 - t
      },
      done: () => {
        ringPlayer = player
      },
    })
    tweens.add({
      delay: 150,
      duration: 460,
      update: (_t, raw) => {
        ringScale = outBack(2.6)(raw)
        ringMaterial.color.copy(from).lerp(to, outCubic(raw))
      },
    })
    pulseUntil = stage.now + 4000
  }

  /** A bankrupt token topples over and fades away. */
  function topple(player: number, gentle: boolean) {
    const token = tokens[player]
    if (!token) return 0
    for (const m of token.materials) {
      m.transparent = true
      m.needsUpdate = true
    }
    const fade = (t: number) => {
      for (const m of token.materials) m.opacity = 1 - t
    }
    if (gentle) {
      tweens.add({ duration: 260, update: fade, done: () => (token.group.visible = false) })
      return 280
    }
    tweens.add({
      duration: 620,
      update: (_t, raw) => {
        token.body.rotation.z = outBounce(raw) * (Math.PI / 2) * 0.92
        token.body.position.y = Math.sin(raw * Math.PI) * 0.12
      },
    })
    tweens.add({
      delay: 260,
      duration: 1,
      update: () => {},
      done: () =>
        particles.burst({
          origin: token.group.position,
          kind: 'dust',
          count: 10,
          colors: ['#c9c1aa'],
          size: 0.8,
        }),
    })
    tweens.add({
      delay: 820,
      duration: 520,
      ease: inQuad,
      update: (t) => {
        fade(t)
        token.group.scale.setScalar(1 - t * 0.6)
      },
      done: () => {
        token.group.visible = false
      },
    })
    return 1100
  }

  let celebrated = false,
    orbitFrom = 0,
    orbitUntil = 0
  /** The winner: a light, a camera that comes round to them, and confetti. */
  function celebrate(winner: number, gentle: boolean, instant = false) {
    const token = tokens[winner]
    if (!token) return 0
    const at = token.group.position
    spot.position.set(at.x, 7, at.z + 0.5)
    spot.target.position.copy(at)
    if (instant) {
      spot.intensity = 60
      key.intensity = 1.2
      return 0
    }
    tweens.add({
      duration: 900,
      ease: outCubic,
      update: (t) => {
        spot.intensity = t * 60
        key.intensity = lerp(1.8, 1.2, t)
      },
    })
    cue({ type: 'sound', sound: 'win' })
    if (gentle) return 400
    followed = null
    rig.follow(null)
    rig.to({})
    const fromTarget = controls.target.clone(),
      fromPosition = camera.position.clone(),
      fromZoom = camera.zoom,
      toTarget = new THREE.Vector3(at.x * 0.6, 0.2, at.z * 0.6)
    tweens.add({
      duration: 1600,
      ease: inOutCubic,
      update: (t) => {
        controls.target.lerpVectors(fromTarget, toTarget, t)
        camera.position.copy(fromPosition).add(lift.subVectors(controls.target, fromTarget))
        camera.zoom = lerp(fromZoom, 1.55, t)
        camera.updateProjectionMatrix()
      },
    })
    orbitFrom = stage.now + 1600
    orbitUntil = orbitFrom + 7000
    for (let n = 0; n < 3; n++)
      tweens.add({
        delay: 300 + n * 420,
        duration: 1,
        update: () => {},
        done: () =>
          particles.burst({
            origin: new THREE.Vector3(at.x, 2.4, at.z),
            kind: 'confetti',
            count: 110,
            colors: [...state.players.map((p) => p.color), '#f6d27a', '#fff4d8'],
            spread: 0.8,
          }),
      })
    // Three proud hops, the last with a full turn.
    for (let n = 0; n < 3; n++) {
      const yaw = token.group.rotation.y
      tweens.add({
        delay: 200 + n * 430,
        duration: 400,
        update: (_t, raw) => {
          token.group.position.y = SURFACE + arc(raw, 0.55)
          const [xz, y] = squash(raw, 1.2)
          token.body.scale.set(xz, y, xz)
          if (n === 2) token.group.rotation.y = yaw + outCubic(raw) * Math.PI * 2
        },
        done: () => {
          token.body.scale.set(1, 1, 1)
          token.group.position.y = SURFACE
        },
      })
    }
    return 600
  }

  const colorsOf = (next: GameState) => next.players.map((p) => p.color)

  /** Show `next` to the page, and play whatever changed with it. */
  function present(next: GameState, gentle: boolean) {
    cue({ type: 'present', state: next })
    // The sidebar's balances change now, so the money crosses the board now too.
    const before = presentedCash.map((value, i) => value + (goCredit[i] ?? 0))
    presentedCash = next.players.map((p) => p.cash)
    goCredit = []
    if (!gentle)
      for (const { from, to, amount } of transfers(before, presentedCash))
        throwCoins(anchor(from), anchor(to), amount)
    let hold = lots.sync(next.properties, colorsOf(next), true, gentle)
    const turn = next.winner ?? next.current
    if (turn !== ringPlayer) moveRing(turn, next.players[turn].color, gentle)
    next.players.forEach((p, i) => {
      if (p.bankrupt && !toppled[i]) {
        toppled[i] = true
        hold = Math.max(hold, topple(i, gentle))
      }
    })
    if (next.phase !== 'card') returnCard(gentle)
    if (next.status === 'finished' && next.winner !== null && !celebrated) {
      celebrated = true
      hold = Math.max(hold, celebrate(next.winner, gentle))
    }
    return hold
  }

  let seen = false,
    lastRoll = 0,
    walked = '',
    cardShown = ''

  /** Land everything on `next` at once: a fresh game, a reconnect, or a backlog too long to tell. */
  function snap(next: GameState) {
    queue.clear()
    tweens.finishAll()
    tweens.cancelAll()
    particles.clear()
    coins.clear()
    presentedCash = next.players.map((p) => p.cash)
    goCredit = []
    followed = null
    rig.follow(null)
    if (tokens.length !== next.players.length) setupTokens()
    plan = next.players.map((p) => ({ position: p.position, jailed: p.jailed }))
    toppled = next.players.map((p) => p.bankrupt)
    next.players.forEach((p, i) => {
      const token = tokens[i]
      spotFor(i, p.position, p.jailed, false, token.group.position)
      token.group.rotation.y = -0.3
      token.group.scale.setScalar(1)
      token.group.visible = !p.bankrupt
      token.body.rotation.set(0, 0, 0)
      token.body.position.set(0, 0, 0)
      token.body.scale.set(1, 1, 1)
      for (const m of token.materials) {
        if (!m.transparent) continue
        m.opacity = 1
        m.transparent = false
        m.needsUpdate = true
      }
    })
    shaking = false
    throws.forEach((t, i) => t.settle(next.dice[i]))
    lots.clear()
    lots.sync(next.properties, colorsOf(next), false, false)
    for (const group of tileGroups.values()) group.position.y = TILE_Y
    ringPlayer = next.winner ?? next.current
    ringMaterial.color.set(next.players[ringPlayer].color)
    ringScale = 1
    drawn.visible = false
    lastRoll = next.rollId
    walked = ''
    cardShown = cardKeyOf(next)
    orbitUntil = 0
    spot.intensity = 0
    key.intensity = 1.8
    // A new game after a win: back out of the winner's close-up.
    if (celebrated && next.status !== 'finished') rig.to({ position: HOME, target: ORIGIN, zoom: 1 }, 3)
    celebrated = next.status === 'finished'
    if (celebrated && next.winner !== null) celebrate(next.winner, true, true)
    cue({ type: 'present', state: next })
    stage.invalidate()
  }

  function update(next: GameState, sync?: BeatSync) {
    if (disposed) return
    /** How far into this state's beat the room already is — a join or a reconnect lands mid-roll. */
    const late = sync ? sync.elapsed + (performance.now() - sync.at) : 0
    const prev = state
    state = next
    const fresh =
      !seen ||
      next.players.length !== prev.players.length ||
      next.players.some((p, i) => p.token !== prev.players[i]?.token) ||
      next.rollId < lastRoll ||
      next.eventId < prev.eventId ||
      (prev.status !== 'playing' && next.status === 'playing') ||
      queue.length > 10
    seen = true
    if (fresh) {
      if (
        next.players.length !== tokens.length ||
        next.players.some((p, i) => p.token !== prev.players[i]?.token)
      )
        setupTokens()
      snap(next)
      // Arrived mid-roll or mid-walk: play what is left of it from where the room is.
      if (late < JOIN_AFTER_MS || (next.phase !== 'rolling' && next.phase !== 'moving')) return
      if (next.phase === 'rolling') lastRoll = next.rollId - 1
    }
    /** Milliseconds of the new beat to skip; a queue still telling an older story starts it from the top. */
    const skip = late >= JOIN_AFTER_MS && !queue.busy ? late : 0
    const gentle = reducedMotion(),
      beats: Beat[] = [],
      walking = next.phase === 'rolling' || next.phase === 'moving'
    let presented = false
    const presentBeat = () => {
      presented = true
      beats.push({ label: 'present', run: () => present(next, gentle) })
    }

    // A new roll: say so at once, throw the dice, then walk what they say while
    // the server holds the beat. The server's own walk arrives as one snapshot
    // after this one, by which time the token is already standing on it.
    if (next.rollId > lastRoll) {
      lastRoll = next.rollId
      if (next.phase === 'rolling') presentBeat()
      beats.push(diceBeat([next.dice[0], next.dice[1]], next.rollId, gentle, skip))
      if (next.phase === 'rolling') {
        const p = next.current,
          settled = gameReducer(next, { type: 'DICE_SETTLED' }),
          mover = settled.players[p]
        if (settled.phase === 'moving' && settled.stepsRemaining > 0) {
          beats.push(joinedWalk(p, settled.stepsRemaining, skip - ESTATE_PACING.DICE_SETTLE_MS, gentle))
          plan[p] = { position: (plan[p].position + settled.stepsRemaining) % 40, jailed: false }
        } else if (mover.jailed && !plan[p].jailed) {
          beats.push(jailBeat(p, gentle))
          plan[p] = { position: JAIL, jailed: true }
        }
      }
    }
    // A card that sends you somewhere: the walk starts as soon as it is read.
    if (next.phase === 'moving' && next.stepsRemaining > 0) {
      const key = `${next.eventId}:${next.current}`
      if (key !== walked) {
        walked = key
        if (!presented) presentBeat()
        const p = next.current
        beats.push(joinedWalk(p, next.stepsRemaining, skip, gentle))
        plan[p] = { position: (plan[p].position + next.stepsRemaining) % 40, jailed: false }
      }
    }
    // Whatever else moved: the space a walk ended on sending someone to jail, a
    // card doing it, paying the way out, or a snapshot this board missed.
    next.players.forEach((player, p) => {
      if (walking && p === next.current) return
      const from = plan[p]
      if (player.bankrupt) return
      if (player.jailed && !from.jailed) beats.push(jailBeat(p, gentle))
      else if (!player.jailed && from.jailed && player.position === from.position)
        beats.push(releaseBeat(p, gentle))
      else if (player.position !== from.position)
        beats.push(walkBeat(p, from.position, stepsBetween(from.position, player.position), gentle))
      plan[p] = { position: player.position, jailed: player.jailed }
    })
    const card = cardKeyOf(next)
    if (card && card !== cardShown) {
      cardShown = card
      if (!presented && next.card) beats.push(cardBeat(next.card, gentle))
    }
    if (!presented) presentBeat()
    queue.push(...beats)
    stage.invalidate()
  }

  /**
   * The walk `steps` squares on from where the plan has `player`, less the
   * squares the room has already walked `into` ms of its walk — at its own
   * pace, `STEP_MS` a square — so a page that joins late starts on the right one.
   */
  function joinedWalk(player: number, steps: number, into: number, gentle: boolean) {
    const done = into > 0 ? Math.min(steps, Math.floor(into / ESTATE_PACING.STEP_MS)) : 0
    return walkBeat(player, (plan[player].position + done) % 40, steps - done, gentle, done > 0)
  }

  // Picking and hovering.
  const spaceAt = (event: { clientX: number; clientY: number }) => {
    const hit = stage.pick(event, tiles, false)[0]
    return hit ? (hit.object.userData.spaceId as number) : null
  }
  const offTap = onTap(stage.canvas, (event) => {
    const id = spaceAt(event)
    if (id === null) return
    selectedSpace = id
    refreshFocus()
    tooltip.hidden = true
    onSelect(id)
  })
  const onDown = () => {
    tooltip.hidden = true
  }
  const onMove = (e: PointerEvent) => {
    const before = hoveredSpace
    hoveredSpace = e.buttons ? null : spaceAt(e)
    if (before !== hoveredSpace) refreshFocus()
    stage.canvas.style.cursor = e.buttons ? 'grabbing' : hoveredSpace !== null ? 'pointer' : 'grab'
    tooltip.hidden = hoveredSpace === null || e.pointerType === 'touch' || selectedSpace !== null
    if (tooltip.hidden || hoveredSpace === null) return
    const space = BOARD[hoveredSpace],
      property = state.properties[hoveredSpace]
    tooltipTitle.textContent = space.name
    tooltipDetail.textContent = property
      ? `${state.players[property.owner].name} owns this${property.mortgaged ? ' · Mortgaged' : ''}`
      : space.price
        ? `$${space.price} · Available`
        : 'Select to explore this space'
    tooltip.style.setProperty('--tooltip-color', space.color || '#d99a51')
    const rect = stage.canvas.getBoundingClientRect()
    tooltip.style.left = `${Math.max(12, Math.min(e.clientX - rect.left + 15, rect.width - 220))}px`
    tooltip.style.top = `${Math.max(12, Math.min(e.clientY - rect.top - 70, rect.height - 80))}px`
  }
  const onLeave = () => {
    hoveredSpace = null
    tooltip.hidden = true
    refreshFocus()
  }
  stage.canvas.addEventListener('pointerdown', onDown)
  stage.canvas.addEventListener('pointermove', onMove)
  stage.canvas.addEventListener('pointerleave', onLeave)

  // A hidden tab stops the clock; coming back to a long backlog lands it rather than replaying it.
  const onVisible = () => {
    if (!document.hidden && queue.length > 2) snap(state)
  }
  document.addEventListener('visibilitychange', onVisible)
  // Turning reduced motion on mid-turn lands whatever is in flight.
  const offMotion = onMotionChange(() => {
    if (!reducedMotion()) return
    queue.flush()
    tweens.finishAll()
    stage.invalidate()
  })

  stage.onFrame((dt, now) => {
    // Long frames the stage capped (shaders compiling just after a join, a
    // stalled thread) left a story that keeps time with the room behind it:
    // play that time forward too, so the token lands when everyone else's does.
    const drift = stage.takeDrift(),
      ms = dt * 1000 + (queue.busy ? drift : 0)
    tweens.speed = queue.speed
    let moving = tweens.step(ms)
    if (queue.step(ms)) moving = true
    if (shaking && now > shakeUntil) {
      // The roll never came back: put the dice down where they were.
      shaking = false
      throws.forEach((t, i) => t.throw(state.dice[i], 520))
    }
    for (const t of throws) if (t.step((ms / 1000) * tweens.speed)) moving = true
    if (particles.step(dt)) moving = true
    if (coins.step(ms)) moving = true
    // The ring stays under its token, and breathes for a few seconds after a turn changes hands.
    const owner = tokens[ringPlayer]
    if (owner) ring.position.set(owner.group.position.x, 0.258, owner.group.position.z)
    const pulse = now < pulseUntil ? Math.sin(now * 0.006) * 0.07 * Math.min(1, (pulseUntil - now) / 600) : 0
    ring.scale.setScalar(Math.max(0.001, ringScale * (1 + pulse)))
    ring.visible = Boolean(owner?.group.visible) && ringScale > 0.01
    if (now < pulseUntil) moving = true
    if (focus.visible) {
      focusAlpha = damp(focusAlpha, focusTarget, 16, dt)
      focusMaterial.opacity = focusAlpha
      if (Math.abs(focusAlpha - focusTarget) > 0.01) moving = true
      else if (focusTarget === 0) focus.visible = false
    }
    if (now > orbitFrom && now < orbitUntil && !rig.userControlled) {
      // The winner's lap of honour: the camera comes slowly round them.
      orbit.subVectors(camera.position, controls.target).applyAxisAngle(THREE.Object3D.DEFAULT_UP, dt * 0.22)
      camera.position.copy(controls.target).add(orbit)
      moving = true
    }
    if (controls.update()) moving = true
    if (rig.step(dt)) moving = true
    return moving
  })
  stage.onDispose(() => {
    disposed = true
    offTap()
    offMotion()
    document.removeEventListener('visibilitychange', onVisible)
    stage.canvas.removeEventListener('pointerdown', onDown)
    stage.canvas.removeEventListener('pointermove', onMove)
    stage.canvas.removeEventListener('pointerleave', onLeave)
    controls.removeEventListener('change', onControlsChange)
    rig.dispose()
    controls.dispose()
    particles.dispose()
    coins.dispose()
    tooltip.remove()
  })
  update(initial, sync)
  stage.start()

  return {
    update,
    select(id) {
      selectedSpace = id
      refreshFocus()
      tooltip.hidden = true
    },
    shake() {
      if (state.phase !== 'ready' || queue.busy || reducedMotion()) return
      shaking = true
      shakeUntil = stage.now + 3000
      throws.forEach((t) => t.shake())
      stage.invalidate()
    },
    reset() {
      rig.to({ position: HOME, target: ORIGIN, zoom: 1 }, 4)
      stage.invalidate()
    },
    zoom(direction) {
      rig.to({ zoom: THREE.MathUtils.clamp(camera.zoom + direction * 0.18, 0.7, 2) }, 8)
      stage.invalidate()
    },
    topView() {
      // Just inside the controls' polar limit, so the shot can actually arrive.
      const top = new THREE.Vector3()
        .setFromSphericalCoords(HOME.length(), controls.minPolarAngle + 0.01, controls.getAzimuthalAngle())
        .add(ORIGIN)
      rig.to({ position: top, target: ORIGIN, zoom: 1 }, 4)
      stage.invalidate()
    },
    dispose() {
      stage.dispose()
    },
  }
}

interface HopOptions {
  delay: number
  duration: number
  height: number
  landing: boolean
  gentle: boolean
  onLand?: () => void
}

function tileOutline(width: number, depth: number) {
  const shape = new THREE.Shape()
  const roundedPath = (path: THREE.Path, w: number, d: number, radius: number) => {
    const x = w / 2,
      y = d / 2
    path.moveTo(-x + radius, -y)
    path.lineTo(x - radius, -y)
    path.quadraticCurveTo(x, -y, x, -y + radius)
    path.lineTo(x, y - radius)
    path.quadraticCurveTo(x, y, x - radius, y)
    path.lineTo(-x + radius, y)
    path.quadraticCurveTo(-x, y, -x, y - radius)
    path.lineTo(-x, -y + radius)
    path.quadraticCurveTo(-x, -y, -x + radius, -y)
  }
  roundedPath(shape, width, depth, 0.06)
  const hole = new THREE.Path()
  roundedPath(hole, width - 0.1, depth - 0.1, 0.025)
  shape.holes.push(hole)
  return new THREE.ShapeGeometry(shape)
}
