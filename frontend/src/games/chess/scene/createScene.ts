import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import type { GameState, Preferences, Square } from '../game/types'
import { disposeObject, makeBoard, makePiece, squarePosition } from './models'

export interface SceneState {
  game: GameState
  selected: Square | null
  legal: { to: Square; capture: boolean }[]
  focused: Square | null
  enabled: boolean
  preferences: Preferences
}
export interface SceneApi {
  update: (state: SceneState) => void
  flip: (black: boolean) => void
  zoom: (amount: number) => void
  reset: () => void
  top: () => void
  dispose: () => void
}
interface Actor {
  group: THREE.Group
  type: string
  from: THREE.Vector3
  to: THREE.Vector3
  start: number
  removing: boolean
  knight: boolean
}

export function createScene(
  container: HTMLElement,
  initial: SceneState,
  onSelect: (square: Square) => void,
): SceneApi {
  const scene = new THREE.Scene()
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1
  renderer.domElement.setAttribute('aria-hidden', 'true')
  container.appendChild(renderer.domElement)
  const environment = new RoomEnvironment(),
    pmrem = new THREE.PMREMGenerator(renderer)
  const env = pmrem.fromScene(environment, 0.04)
  scene.environment = env.texture
  scene.environmentIntensity = 0.4
  environment.dispose()
  pmrem.dispose()

  const camera = new THREE.OrthographicCamera(-7, 7, 7, -7, 0.1, 100)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.09
  controls.enablePan = false
  controls.minPolarAngle = 0.03
  controls.maxPolarAngle = 1.05
  controls.minZoom = 0.75
  controls.maxZoom = 1.65
  controls.rotateSpeed = 0.5
  controls.zoomSpeed = 0.6
  controls.target.set(0, 0.2, 0)
  let black = false,
    angle = 0.24,
    targetAngle = 0.24,
    polar = 0.88,
    targetPolar = 0.88,
    targetZoom = 1,
    cameraMoving = false
  function placeCamera() {
    camera.position.set(
      Math.sin(angle) * Math.sin(polar) * 22,
      Math.cos(polar) * 22,
      Math.cos(angle) * Math.sin(polar) * 22,
    )
    camera.lookAt(controls.target)
  }
  placeCamera()
  controls.update()
  function manualCamera() {
    cameraMoving = false
  }
  controls.addEventListener('start', manualCamera)
  function tweenCamera(nextAngle: number, nextPolar: number, nextZoom = 1) {
    const offset = camera.position.clone().sub(controls.target)
    angle = Math.atan2(offset.x, offset.z)
    polar = Math.acos(offset.y / offset.length())
    targetAngle = nextAngle
    while (targetAngle - angle > Math.PI) targetAngle -= Math.PI * 2
    while (targetAngle - angle < -Math.PI) targetAngle += Math.PI * 2
    targetPolar = nextPolar
    targetZoom = nextZoom
    cameraMoving = true
  }

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
    boardData = makeBoard(theme)
  scene.add(boardData.board)
  const actors = new Map<string, Actor>(),
    highlights = new THREE.Group()
  scene.add(highlights)
  let disposed = false,
    frame = 0,
    previousFen = '',
    previousHistory = 0
  const reduce = () => state.preferences.reducedMotion

  function tile(square: Square, color: string, opacity: number) {
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(0.96, 0.96),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
    )
    plane.rotation.x = -Math.PI / 2
    plane.position.copy(squarePosition(square))
    plane.position.y = 0.433
    highlights.add(plane)
  }
  function ring(square: Square, color: string, radius: number, thickness: number) {
    const circle = new THREE.Mesh(
      new THREE.RingGeometry(radius - thickness, radius, 48),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.94,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    )
    circle.rotation.x = -Math.PI / 2
    circle.position.copy(squarePosition(square))
    circle.position.y = 0.441
    highlights.add(circle)
  }
  function outline(square: Square, color: string) {
    const p = squarePosition(square)
    const points = [
      [-0.46, -0.46],
      [0.46, -0.46],
      [0.46, 0.46],
      [-0.46, 0.46],
      [-0.46, -0.46],
    ].map(([x, z]) => new THREE.Vector3(x + p.x, 0.446, z + p.z))
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(points),
      new THREE.LineBasicMaterial({ color }),
    )
    highlights.add(line)
  }
  function paintHighlights() {
    highlights.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.Line) {
        o.geometry.dispose()
        ;(o.material as THREE.Material).dispose()
      }
    })
    highlights.clear()
    const last = state.game.history.at(-1)
    if (last) {
      tile(last.from, '#bfc084', 0.34)
      tile(last.to, '#bfc084', 0.48)
      ring(last.to, '#e5d5a1', 0.09, 0.024)
    }
    if (state.selected) {
      tile(state.selected, '#f3df9d', 0.42)
      ring(state.selected, '#fff0ba', 0.415, 0.035)
    }
    for (const move of state.legal) {
      if (move.capture) {
        ring(move.to, state.preferences.highContrast ? '#941c18' : '#a6533e', 0.455, 0.055)
        outline(move.to, '#e1b390')
      } else {
        ring(move.to, state.preferences.highContrast ? '#152d22' : '#375240', 0.12, 0.085)
        ring(move.to, '#f8f1d9', 0.14, 0.02)
      }
    }
    if (state.game.check) {
      tile(state.game.check, '#b74832', 0.42)
      ring(state.game.check, '#f2b095', 0.45, 0.047)
    }
    for (const threat of state.game.threats) outline(threat, '#d98d69')
    if (state.focused) outline(state.focused, state.preferences.highContrast ? '#000000' : '#ffffff')
  }

  function syncActors() {
    const now = performance.now(),
      newIds = new Set(state.game.pieces.map((p) => p.id))
    for (const [id, actor] of actors)
      if (!newIds.has(id) && !actor.removing) {
        actor.removing = true
        actor.start = now
        actor.from.copy(actor.group.position)
      }
    for (const piece of state.game.pieces) {
      let actor = actors.get(piece.id)
      const target = squarePosition(piece.square)
      if (actor && actor.type !== piece.type) {
        const old = actor.group
        const next = makePiece(piece.type, piece.color, theme)
        next.position.copy(old.position)
        scene.remove(old)
        disposeObject(old)
        scene.add(next)
        actor.group = next
        actor.type = piece.type
      }
      if (!actor) {
        const group = makePiece(piece.type, piece.color, theme)
        group.position.copy(target)
        scene.add(group)
        actor = {
          group,
          type: piece.type,
          from: target.clone(),
          to: target.clone(),
          start: now,
          removing: false,
          knight: piece.type === 'n',
        }
        actors.set(piece.id, actor)
      } else if (actor.to.distanceTo(target) > 0.001 || actor.removing) {
        actor.from.copy(actor.group.position)
        actor.to.copy(target)
        actor.start = now
        actor.removing = false
        actor.group.scale.setScalar(1)
      }
      actor.group.userData.square = piece.square
      actor.group.traverse((o) => {
        o.userData.square = piece.square
      })
    }
  }
  syncActors()
  paintHighlights()
  previousFen = state.game.fen
  previousHistory = state.game.history.length
  function resize() {
    const { width, height } = container.getBoundingClientRect()
    if (!width || !height) return
    renderer.setSize(width, height)
    const aspect = width / height,
      span = Math.max(4.6, 5.95 / aspect)
    camera.left = -span * aspect
    camera.right = span * aspect
    camera.top = span
    camera.bottom = -span
    camera.updateProjectionMatrix()
  }
  const observer = new ResizeObserver(resize)
  observer.observe(container)
  resize()
  const raycaster = new THREE.Raycaster(),
    pointer = new THREE.Vector2()
  let downX = 0,
    downY = 0,
    downTime = 0,
    dragged = false,
    activePointers = 0
  function pick(event: PointerEvent): Square | undefined {
    const rect = renderer.domElement.getBoundingClientRect()
    pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      (-(event.clientY - rect.top) / rect.height) * 2 + 1,
    )
    raycaster.setFromCamera(pointer, camera)
    const pieces = [...actors.values()].filter((a) => !a.removing).map((a) => a.group)
    return raycaster.intersectObjects([...pieces, ...boardData.squares], true)[0]?.object.userData.square
  }
  const down = (event: PointerEvent) => {
    activePointers++
    downX = event.clientX
    downY = event.clientY
    downTime = performance.now()
    dragged = activePointers > 1
  }
  const move = (event: PointerEvent) => {
    if (Math.hypot(event.clientX - downX, event.clientY - downY) > 7) dragged = true
    renderer.domElement.style.cursor = state.enabled && pick(event) ? 'pointer' : 'grab'
  }
  const up = (event: PointerEvent) => {
    activePointers = Math.max(0, activePointers - 1)
    if (!state.enabled || dragged || event.button !== 0 || performance.now() - downTime > 800) return
    const square = pick(event)
    if (square) onSelect(square)
  }
  const cancel = () => {
    activePointers = 0
    dragged = true
  }
  renderer.domElement.addEventListener('pointerdown', down)
  renderer.domElement.addEventListener('pointermove', move)
  renderer.domElement.addEventListener('pointerup', up)
  renderer.domElement.addEventListener('pointercancel', cancel)
  function render(now: number) {
    if (disposed) return
    frame = requestAnimationFrame(render)
    if (cameraMoving) {
      const speed = reduce() ? 1 : 0.085
      angle = THREE.MathUtils.lerp(angle, targetAngle, speed)
      polar = THREE.MathUtils.lerp(polar, targetPolar, speed)
      camera.zoom = THREE.MathUtils.lerp(camera.zoom, targetZoom, speed)
      placeCamera()
      camera.updateProjectionMatrix()
      if (
        Math.abs(angle - targetAngle) < 0.0005 &&
        Math.abs(polar - targetPolar) < 0.0005 &&
        Math.abs(camera.zoom - targetZoom) < 0.0005
      )
        cameraMoving = false
    }
    controls.update()
    for (const [id, a] of actors) {
      const t = reduce() ? 1 : Math.min((now - a.start) / 520, 1)
      if (a.removing) {
        const scale = 1 - Math.max(0, (t - 0.35) / 0.65)
        a.group.scale.setScalar(Math.max(0.001, scale))
        a.group.position.y = a.from.y + (1 - scale) * 0.15
        if (t === 1) {
          scene.remove(a.group)
          disposeObject(a.group)
          actors.delete(id)
        }
      } else {
        const ease = t * t * (3 - 2 * t)
        a.group.position.lerpVectors(a.from, a.to, ease)
        if (a.from.distanceTo(a.to) > 0.01)
          a.group.position.y += Math.sin(t * Math.PI) * (a.knight ? 0.8 : 0.28)
      }
    }
    renderer.render(scene, camera)
  }
  frame = requestAnimationFrame(render)
  return {
    update(next) {
      const priorStatus = state.game.status
      state = next
      if (theme !== next.preferences.theme) {
        theme = next.preferences.theme
        scene.remove(boardData.board)
        disposeObject(boardData.board)
        boardData = makeBoard(theme)
        scene.add(boardData.board)
        for (const a of actors.values()) {
          scene.remove(a.group)
          disposeObject(a.group)
        }
        actors.clear()
        syncActors()
      }
      if (previousFen !== next.game.fen || previousHistory !== next.game.history.length) {
        syncActors()
        previousFen = next.game.fen
        previousHistory = next.game.history.length
      }
      paintHighlights()
      if (next.game.status === 'checkmate' && priorStatus !== 'checkmate')
        tweenCamera(black ? Math.PI + 0.24 : 0.24, 0.82, 0.94)
    },
    flip(next) {
      black = next
      tweenCamera(black ? Math.PI + 0.24 : 0.24, 0.88)
    },
    zoom(amount) {
      tweenCamera(
        Math.atan2(camera.position.x, camera.position.z),
        Math.acos(camera.position.y / camera.position.length()),
        THREE.MathUtils.clamp(camera.zoom + amount * 0.15, 0.75, 1.65),
      )
    },
    reset() {
      tweenCamera(black ? Math.PI + 0.24 : 0.24, 0.88)
    },
    top() {
      tweenCamera(black ? Math.PI : 0, 0.04)
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      controls.dispose()
      renderer.domElement.removeEventListener('pointerdown', down)
      renderer.domElement.removeEventListener('pointermove', move)
      renderer.domElement.removeEventListener('pointerup', up)
      renderer.domElement.removeEventListener('pointercancel', cancel)
      highlights.traverse((o) => {
        if (o instanceof THREE.Line) {
          o.geometry.dispose()
          ;(o.material as THREE.Material).dispose()
        }
      })
      disposeObject(scene)
      env.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    },
  }
}
