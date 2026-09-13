import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { PALETTES, spaceCoordinates } from '@games/shared/wildrise/board'
import { phaseDuration } from '@games/shared/wildrise/timing'
import type { GameState, PlayerId } from '@games/shared/wildrise/types'
import {
  box,
  dieQuaternion,
  ladderPoint,
  makeBoard,
  makeDie,
  makeLadder,
  makePlant,
  makeSnake,
  makeToken,
  material,
} from './models'

export interface SceneApi {
  update: (state: GameState) => void
  setRunning: (running: boolean) => void
  reset: () => void
  top: () => void
  rotate: (direction: number) => void
  zoom: (direction: number) => void
  dispose: () => void
}
export function createScene(
  container: HTMLElement,
  initial: GameState,
  onRoll: () => void,
  onFailure: () => void,
): SceneApi {
  let state = initial,
    running = true,
    elapsed = 0,
    lastTime = performance.now(),
    frame = 0,
    disposed = false
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  const scene = new THREE.Scene()
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.7))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.9
  renderer.domElement.setAttribute('role', 'img')
  renderer.domElement.setAttribute(
    'aria-label',
    'Wildrise 3D board with 100 numbered spaces. Drag to rotate, pinch or scroll to zoom. Use Roll dice or press Space to play.',
  )
  container.appendChild(renderer.domElement)
  const environment = new RoomEnvironment(),
    pmrem = new THREE.PMREMGenerator(renderer)
  const envTarget = pmrem.fromScene(environment, 0.04)
  scene.environment = envTarget.texture
  scene.environmentIntensity = 0.32
  environment.dispose()
  pmrem.dispose()
  const camera = new THREE.OrthographicCamera(-9, 9, 8, -8, 0.1, 100)
  const home = new THREE.Vector3(3.4, 19, 13.5)
  camera.position.copy(home)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.target.set(0.2, 0, 0.4)
  controls.enableDamping = true
  controls.dampingFactor = 0.1
  controls.enablePan = false
  controls.minPolarAngle = 0.02
  controls.maxPolarAngle = Math.PI / 2.6
  controls.minZoom = 0.65
  controls.maxZoom = 2.4
  controls.rotateSpeed = 0.5
  controls.zoomSpeed = 0.65
  const cameraGoal = home.clone()
  let cameraTween = false,
    zoomGoal = 1
  controls.addEventListener('start', () => {
    cameraTween = false
  })
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
  for (let i = -4; i <= 4; i++) {
    const seam = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.001, 80), material('#cfc3ad'))
    seam.position.set(i * 6.5, -0.548, 0)
    scene.add(seam)
  }
  scene.add(makeBoard(initial))
  const snakes = initial.board.snakes.map(makeSnake),
    ladders = initial.board.ladders.map(makeLadder)
  snakes.forEach((s) => scene.add(s.group))
  ladders.forEach((l) => scene.add(l.group))
  scene.add(makePlant(-7.25, -5.6, 1.4))
  scene.add(makePlant(7.0, -6.0, 0.9))
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
  const die = makeDie(),
    dieRest = new THREE.Vector3(6.55, 0.09, 3.7)
  die.position.copy(dieRest)
  die.quaternion.copy(dieQuaternion(1))
  scene.add(die)
  const tokens = new Map<PlayerId, THREE.Group>()
  for (const player of initial.players) {
    const token = makeToken(player.id)
    tokens.set(player.id, token)
    scene.add(token)
  }
  const haloMaterial = new THREE.MeshBasicMaterial({
    color: '#fff1b8',
    transparent: true,
    opacity: 0.8,
    side: THREE.DoubleSide,
    depthWrite: false,
  })
  const halo = new THREE.Mesh(new THREE.RingGeometry(0.29, 0.34, 48), haloMaterial)
  halo.rotation.x = -Math.PI / 2
  scene.add(halo)
  const targetRing = new THREE.Mesh(new THREE.RingGeometry(0.31, 0.36, 48), haloMaterial.clone())
  targetRing.rotation.x = -Math.PI / 2
  scene.add(targetRing)
  const particles = new THREE.Group()
  scene.add(particles)
  for (let i = 0; i < 100; i++) {
    const p = new THREE.Mesh(
      new THREE.PlaneGeometry(0.08, 0.15),
      new THREE.MeshBasicMaterial({
        color: ['#e3b95b', '#789b77', '#d58369', '#6999b7'][i % 4],
        side: THREE.DoubleSide,
      }),
    )
    particles.add(p)
  }
  particles.visible = false

  function tokenPosition(space: number, index: number, stack = true) {
    if (space === 0) return new THREE.Vector3(-2.1 + index * 0.8, -0.54, 6.2)
    const { x, z } = spaceCoordinates(space)
    const occupants = state.players.filter((p, i) => p.position === space || i === index)
    const offset =
      occupants.length > 1 && stack
        ? state.players.slice(0, index).filter((p) => p.position === space).length
        : -1
    return new THREE.Vector3(
      x + (offset < 0 ? 0 : offset % 2 === 0 ? -0.2 : 0.2),
      0.238,
      z + (offset < 0 ? 0 : offset < 2 ? 0.19 : -0.19),
    )
  }
  const ease = (t: number) => t * t * (3 - 2 * t)
  function render(now: number) {
    if (disposed) return
    const delta = Math.max(0, now - lastTime)
    lastTime = now
    if (running) elapsed += delta
    const t = reduced.matches ? 0 : now / 1000
    const duration = phaseDuration(state, reduced.matches)
    const progress = Math.min(1, elapsed / Math.max(1, duration))
    state.players.forEach((player, index) => {
      const token = tokens.get(player.id)!
      token.position.copy(tokenPosition(player.position, index))
      token.rotation.set(0, 0.2, 0)
      token.scale.setScalar(1)
      const active = index === state.currentPlayer
      if (active && state.phase === 'moving' && state.motion) {
        // One beat covers every square, so which two the token is between — and
        // how far along — is the renderer's to work out from the clock.
        const motion = state.motion
        const walked = progress * motion.path.length
        const step = Math.min(motion.path.length - 1, Math.floor(walked))
        const within = Math.min(1, walked - step)
        const last = step === motion.path.length - 1
        const from = step === 0 ? motion.from : motion.path[step - 1]
        token.position
          .copy(tokenPosition(from, index, step === 0))
          .lerp(tokenPosition(motion.path[step], index, last), ease(within))
        token.position.y += reduced.matches ? 0 : Math.sin(within * Math.PI) * 0.27
        const bounce =
          !reduced.matches && last && within > 0.8 ? Math.sin((within - 0.8) * Math.PI * 5) * 0.09 : 0
        token.scale.set(1 + bounce / 2, 1 - bounce, 1 + bounce / 2)
      } else if (active && state.phase === 'transporting' && state.motion) {
        const motion = state.motion
        const ride = ease(Math.max(0, Math.min(1, (progress - 0.16) / 0.78)))
        const route = { from: motion.from, to: motion.to, color: '' }
        const point =
          motion.kind === 'snake'
            ? snakes.find((s) => s.route.from === motion.from)!.curve.getPointAt(ride)
            : ladderPoint(route, ride)
        // Ease onto and off the physical prop without teleporting at either end.
        const lift = Math.sin(Math.PI * Math.min(1, progress / 0.12)) * 0.15
        const endBlend = Math.max(0, (progress - 0.94) / 0.06)
        point.y += 0.08
        if (progress < 0.16) point.lerp(tokenPosition(motion.from, index), 1 - ease(progress / 0.16))
        if (endBlend > 0) point.lerp(tokenPosition(motion.to, index), endBlend)
        token.position.copy(point)
        token.position.y += reduced.matches
          ? 0
          : lift +
            (motion.kind === 'ladder' ? Math.abs(Math.sin(ride * 28)) * 0.075 * Math.sin(ride * Math.PI) : 0)
        if (!reduced.matches) token.rotation.z = Math.sin(ride * 20) * 0.08 * Math.sin(ride * Math.PI)
      } else if (state.winner === player.id && !reduced.matches) {
        token.position.y += Math.abs(Math.sin(elapsed / 230)) * 0.5
        token.rotation.y = elapsed / 650
      } else if (active && running && !reduced.matches) {
        token.rotation.z = Math.sin(t * 2) * 0.025
      }
      if (active) {
        halo.position.copy(token.position)
        halo.position.y = Math.max(0.24, token.position.y - 0.01)
        haloMaterial.color.set(PALETTES[player.id].color)
      }
    })
    halo.visible = state.phase !== 'won'
    const motion = state.motion
    targetRing.visible = state.phase === 'transporting'
    if (motion && targetRing.visible) {
      const p = spaceCoordinates(motion.to)
      targetRing.position.set(p.x, 0.24, p.z)
      targetRing.scale.setScalar(reduced.matches ? 1 : 1 + Math.sin(t * 5) * 0.1)
    }
    snakes.forEach(({ head, skin, route }) => {
      const active = state.phase === 'transporting' && motion?.from === route.from && motion.kind === 'snake'
      skin.emissiveIntensity = active ? 0.24 : 0
      head.position.y =
        0.4 +
        (!reduced.matches && running
          ? Math.sin(t * (active ? 9 : 1.4) + route.from) * (active ? 0.045 : 0.011)
          : 0)
    })
    ladders.forEach(({ group, route }) => {
      group.position.y =
        !reduced.matches &&
        running &&
        state.phase === 'transporting' &&
        motion?.kind === 'ladder' &&
        motion.from === route.from
          ? Math.sin(t * 18) * 0.012
          : 0
    })
    if (state.phase === 'rolling') {
      die.position.copy(dieRest)
      if (!reduced.matches && progress < 0.78) {
        const p = progress / 0.78
        die.position.y += Math.abs(Math.sin(p * Math.PI * 2.5)) * 1.8 * (1 - p * 0.65)
        die.position.x += Math.sin(p * Math.PI * 2) * 0.25 * (1 - p)
        die.rotation.set(p * 17, p * 13, p * 9)
      } else {
        die.position.y += reduced.matches
          ? 0
          : Math.abs(Math.sin(((progress - 0.78) / 0.22) * Math.PI * 2)) * 0.16 * (1 - progress)
        die.quaternion.slerp(dieQuaternion(state.dice || 1), reduced.matches ? 1 : 0.24)
      }
    } else {
      die.position.copy(dieRest)
      die.quaternion.copy(dieQuaternion(state.dice || 1))
    }
    particles.visible = !!state.winner && !reduced.matches && elapsed < 10000
    if (particles.visible)
      particles.children.forEach((p, i) => {
        const time = elapsed / 1000,
          cycle = (time * 0.6 + i * 0.093) % 5
        p.position.set(
          Math.sin(i * 23.7) * 6 + Math.sin(time + i) * 0.3,
          7 - cycle * 1.4,
          Math.cos(i * 17.1) * 5,
        )
        p.rotation.set(time * 2 + i, i, time + i * 3)
      })
    if (cameraTween) {
      camera.position.lerp(cameraGoal, reduced.matches ? 1 : 0.1)
      camera.zoom += (zoomGoal - camera.zoom) * (reduced.matches ? 1 : 0.1)
      camera.updateProjectionMatrix()
      if (camera.position.distanceTo(cameraGoal) < 0.01 && Math.abs(camera.zoom - zoomGoal) < 0.001)
        cameraTween = false
    }
    controls.update()
    renderer.render(scene, camera)
    frame = requestAnimationFrame(render)
  }
  const resize = () => {
    const w = container.clientWidth,
      h = container.clientHeight
    if (!w || !h) return
    renderer.setSize(w, h)
    const aspect = w / h,
      halfH = Math.max(6.65, 7.35 / aspect)
    camera.left = -halfH * aspect
    camera.right = halfH * aspect
    camera.top = halfH
    camera.bottom = -halfH
    camera.updateProjectionMatrix()
  }
  const observer = new ResizeObserver(resize)
  observer.observe(container)
  resize()
  const pointer = new THREE.Vector2(),
    ray = new THREE.Raycaster()
  let downX = 0,
    downY = 0
  const onDown = (e: PointerEvent) => {
    downX = e.clientX
    downY = e.clientY
  }
  const onUp = (e: PointerEvent) => {
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 7 || !running) return
    const rect = renderer.domElement.getBoundingClientRect()
    pointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      (-(e.clientY - rect.top) / rect.height) * 2 + 1,
    )
    ray.setFromCamera(pointer, camera)
    if (ray.intersectObject(die, true).length) onRoll()
  }
  const contextLost = (e: Event) => {
    e.preventDefault()
    onFailure()
  }
  renderer.domElement.addEventListener('pointerdown', onDown)
  renderer.domElement.addEventListener('pointerup', onUp)
  renderer.domElement.addEventListener('webglcontextlost', contextLost)
  frame = requestAnimationFrame(render)
  const reset = () => {
    cameraGoal.copy(home)
    controls.target.set(0.2, 0, 0.4)
    zoomGoal = 1
    cameraTween = true
  }
  return {
    update(next) {
      // Every beat of a turn is its own phase, and every turn its own number, so
      // these two together catch each fresh animation — and nothing else, which
      // leaves a state that arrives mid-beat (a player coming or going online)
      // to carry on where the clock already was.
      if (next.phase !== state.phase || next.turn !== state.turn) elapsed = 0
      if (next.winner && !state.winner) reset()
      state = next
    },
    setRunning(value) {
      if (running !== value) lastTime = performance.now()
      running = value
    },
    reset,
    top() {
      cameraGoal.set(0.2, 23, 0.42)
      zoomGoal = 1
      cameraTween = true
    },
    rotate(direction) {
      cameraGoal.copy(camera.position).applyAxisAngle(new THREE.Vector3(0, 1, 0), (direction * Math.PI) / 8)
      zoomGoal = camera.zoom
      cameraTween = true
    },
    zoom(direction) {
      cameraGoal.copy(camera.position)
      zoomGoal = THREE.MathUtils.clamp(camera.zoom + direction * 0.18, 0.65, 2.4)
      cameraTween = true
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      controls.dispose()
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointerup', onUp)
      renderer.domElement.removeEventListener('webglcontextlost', contextLost)
      const geometries = new Set<THREE.BufferGeometry>(),
        materials = new Set<THREE.Material>(),
        textures = new Set<THREE.Texture>()
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          geometries.add(object.geometry)
          for (const m of Array.isArray(object.material) ? object.material : [object.material]) {
            materials.add(m)
            for (const value of Object.values(m)) if (value instanceof THREE.Texture) textures.add(value)
          }
        }
      })
      geometries.forEach((g) => g.dispose())
      materials.forEach((m) => m.dispose())
      textures.forEach((t) => t.dispose())
      envTarget.dispose()
      renderer.dispose()
      renderer.forceContextLoss()
      renderer.domElement.remove()
    },
  }
}
