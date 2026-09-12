import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { HOME, PALETTES, piecePosition, spaceKey } from '@games/shared/hearth/board'
import type { GameState, Piece } from '@games/shared/hearth/types'
import { dieQuaternion, makeBoard, makeDie, makePiece, material, roundedBox } from './models'

export interface SceneApi {
  update: (state: GameState) => void
  setRunning: (running: boolean) => void
  focus: (pieceId: string | null) => void
  reset: () => void
  zoom: (direction: number) => void
  top: () => void
  dispose: () => void
}

export function createScene(
  container: HTMLElement,
  initial: GameState,
  onSelect: (pieceId: string) => void,
): SceneApi {
  let state = initial,
    disposed = false,
    focused: string | null = null,
    motionStart = 0,
    rollStart = 0,
    effectFired = false,
    running = true,
    sceneTime = performance.now()
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
  const scene = new THREE.Scene()
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.97
  renderer.domElement.setAttribute(
    'aria-label',
    '3D Hearth & Home board. Drag to rotate and scroll to zoom. Legal pieces can also be selected using the turn panel.',
  )
  renderer.domElement.setAttribute('role', 'img')
  container.appendChild(renderer.domElement)
  const environment = new RoomEnvironment()
  const pmrem = new THREE.PMREMGenerator(renderer)
  const envTarget = pmrem.fromScene(environment, 0.03)
  scene.environment = envTarget.texture
  scene.environmentIntensity = 0.32
  environment.dispose()
  pmrem.dispose()
  const camera = new THREE.OrthographicCamera(-10, 10, 8, -8, 0.1, 100)
  const home = new THREE.Vector3(10, 18, 17)
  camera.position.copy(home)
  camera.lookAt(0, 0, 0)
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
  const cameraTarget = home.clone()
  let cameraTween = false,
    zoomTarget = 1
  controls.addEventListener('start', () => {
    cameraTween = false
  })
  scene.add(new THREE.HemisphereLight('#eef4ff', '#80795f', 1.5))
  const key = new THREE.DirectionalLight('#fff2d9', 2.1)
  key.position.set(-7, 16, 7)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  Object.assign(key.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 0.5, far: 45 })
  key.shadow.normalBias = 0.027
  key.shadow.bias = -0.0003
  key.shadow.radius = 4
  scene.add(key)
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
  const { board } = makeBoard()
  scene.add(board)
  const die = makeDie()
  die.position.set(5.75, 0.29, 6.65)
  die.scale.setScalar(0.82)
  scene.add(die)
  const tray = roundedBox(1.3, 0.045, 1.3, '#6a5540', 0.12)
  tray.position.set(5.75, -0.125, 6.25)
  scene.add(tray)
  die.position.z = 6.25
  const dieRest = die.position.clone()

  const pieces = new Map<string, THREE.Group>(),
    halos = new Map<string, THREE.Mesh>()
  const haloMaterial = new THREE.MeshBasicMaterial({
    color: '#fdf5cc',
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
    side: THREE.DoubleSide,
  })
  for (const piece of initial.pieces) {
    const group = makePiece(piece.playerId, piece.index)
    group.userData.pieceId = piece.id
    group.traverse((child) => {
      child.userData.pieceId = piece.id
    })
    scene.add(group)
    pieces.set(piece.id, group)
    const halo = new THREE.Mesh(new THREE.RingGeometry(0.32, 0.39, 48), haloMaterial.clone())
    halo.rotation.x = -Math.PI / 2
    halo.visible = false
    scene.add(halo)
    halos.set(piece.id, halo)
  }
  const destination = new THREE.Group()
  const destinationRing = new THREE.Mesh(
    new THREE.RingGeometry(0.27, 0.34, 48),
    new THREE.MeshBasicMaterial({
      color: PALETTES.red.color,
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  )
  destinationRing.rotation.x = -Math.PI / 2
  destination.add(destinationRing)
  const destinationCenter = new THREE.Mesh(
    new THREE.CircleGeometry(0.26, 48),
    new THREE.MeshBasicMaterial({
      color: PALETTES.red.color,
      transparent: true,
      opacity: 0.22,
      depthWrite: false,
    }),
  )
  destinationCenter.rotation.x = -Math.PI / 2
  destination.add(destinationCenter)
  destination.visible = false
  scene.add(destination)
  const ghost = makePiece('red', 0)
  ghost.visible = false
  ghost.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.material = child.material.clone()
      child.material.transparent = true
      child.material.opacity = 0.3
      child.material.depthWrite = false
      child.castShadow = false
    }
  })
  scene.add(ghost)

  type Particle = { mesh: THREE.Mesh; velocity: THREE.Vector3; life: number }
  const particles: Particle[] = []
  const sparkGeometry = new THREE.BoxGeometry(0.055, 0.08, 0.025)
  const sparkMaterials = ['#d6b46d', '#f1dfaa', '#d96c58', '#629c83', '#6e9abe'].map((c) =>
    material(c, 0.2, 0.4),
  )
  function celebrate(x: number, z: number, big = false) {
    if (reduced.matches) return
    for (let i = 0; i < (big ? 100 : 30); i++) {
      const mesh = new THREE.Mesh(sparkGeometry, sparkMaterials[i % sparkMaterials.length])
      const angle = i * 2.399,
        speed = 0.8 + (i % 7) * 0.16
      mesh.position.set(x, big ? 2.3 : 0.7, z)
      scene.add(mesh)
      particles.push({
        mesh,
        velocity: new THREE.Vector3(Math.cos(angle) * speed, 1.6 + (i % 6) * 0.25, Math.sin(angle) * speed),
        life: big ? 4 : 1.5,
      })
    }
  }
  function restingPosition(piece: Piece) {
    const [x, z] = piecePosition(piece)
    const shared = state.pieces.filter((p) => spaceKey(p) === spaceKey(piece))
    const index = shared.findIndex((p) => p.id === piece.id)
    const columns = Math.ceil(Math.sqrt(shared.length)),
      rows = Math.ceil(shared.length / columns)
    const spacing = shared.length > 4 ? 0.62 / columns : 0.31
    const dx = shared.length > 1 ? ((index % columns) - (columns - 1) / 2) * spacing : 0
    const dz = shared.length > 1 ? (Math.floor(index / columns) - (rows - 1) / 2) * spacing : 0
    return new THREE.Vector3(
      x + dx,
      piece.progress < 0 ? 0.375 : piece.progress === HOME ? 0.445 : 0.325,
      z + dz,
    )
  }
  function highlight() {
    for (const [id, halo] of halos)
      halo.visible = state.phase === 'choose' && state.legalMoves.some((m) => m.pieceId === id)
    const move = state.phase === 'choose' ? state.legalMoves.find((m) => m.pieceId === focused) : undefined
    destination.visible = !!move
    ghost.visible = !!move
    if (move) {
      const piece = state.pieces.find((p) => p.id === move.pieceId)!,
        [x, z] = piecePosition({ ...piece, progress: move.to })
      destination.position.set(x, move.to === HOME ? 0.45 : 0.335, z)
      destinationRing.material.color.set(PALETTES[piece.playerId].color)
      destinationCenter.material.color.set(PALETTES[piece.playerId].color)
      ghost.position.set(x, 0.33, z)
      ghost.traverse((child) => {
        if (child instanceof THREE.Mesh && child.material.color)
          child.material.color.set(PALETTES[piece.playerId].color)
      })
    }
  }
  const resize = () => {
    const { width, height } = container.getBoundingClientRect()
    if (!width || !height) return
    renderer.setSize(width, height)
    const aspect = width / height,
      vertical = Math.max(14.7, 19.1 / aspect)
    camera.left = (-vertical * aspect) / 2
    camera.right = (vertical * aspect) / 2
    camera.top = vertical / 2
    camera.bottom = -vertical / 2
    camera.updateProjectionMatrix()
  }
  const observer = new ResizeObserver(resize)
  observer.observe(container)
  resize()
  const raycaster = new THREE.Raycaster(),
    pointer = new THREE.Vector2()
  const intersect = (event: PointerEvent) => {
    const bounds = renderer.domElement.getBoundingClientRect()
    pointer.set(
      ((event.clientX - bounds.left) / bounds.width) * 2 - 1,
      (-(event.clientY - bounds.top) / bounds.height) * 2 + 1,
    )
    raycaster.setFromCamera(pointer, camera)
    return raycaster.intersectObjects([...pieces.values()], true)[0]?.object.userData.pieceId as
      string | undefined
  }
  let downX = 0,
    downY = 0
  const down = (event: PointerEvent) => {
    downX = event.clientX
    downY = event.clientY
  }
  const up = (event: PointerEvent) => {
    if (Math.hypot(event.clientX - downX, event.clientY - downY) > 7) return
    const id = intersect(event)
    if (id && state.phase === 'choose' && state.legalMoves.some((m) => m.pieceId === id)) onSelect(id)
  }
  const hover = (event: PointerEvent) => {
    if (event.buttons) return
    const id = intersect(event)
    const legal = id && state.phase === 'choose' && state.legalMoves.some((m) => m.pieceId === id)
    renderer.domElement.style.cursor = legal ? 'pointer' : 'grab'
    if (legal && focused !== id) {
      focused = id
      highlight()
    }
  }
  renderer.domElement.addEventListener('pointerdown', down)
  renderer.domElement.addEventListener('pointerup', up)
  renderer.domElement.addEventListener('pointermove', hover)

  let frame = 0,
    lastFrame = performance.now()
  function render(wallTime: number) {
    if (disposed) return
    frame = requestAnimationFrame(render)
    const delta = Math.max(0, wallTime - lastFrame)
    const dt = running ? Math.min(delta / 1000, 0.05) : 0
    if (running) sceneTime += delta
    lastFrame = wallTime
    const now = sceneTime
    if (cameraTween) {
      camera.position.lerp(cameraTarget, reduced.matches ? 1 : 0.09)
      camera.zoom = THREE.MathUtils.lerp(camera.zoom, zoomTarget, reduced.matches ? 1 : 0.12)
      camera.updateProjectionMatrix()
      if (camera.position.distanceTo(cameraTarget) < 0.015 && Math.abs(camera.zoom - zoomTarget) < 0.002)
        cameraTween = false
    }
    controls.update()
    const travelTime = (state.motion?.steps.length || 1) * 165
    const elapsed = now - motionStart
    for (const piece of state.pieces) {
      const group = pieces.get(piece.id)
      if (!group) continue
      group.position.copy(restingPosition(piece))
      group.rotation.set(0, 0, 0)
      let scale = piece.progress === HOME ? 0.42 : 1
      const sharedCount = state.pieces.filter((p) => spaceKey(p) === spaceKey(piece)).length
      if (sharedCount > 1) scale *= sharedCount <= 4 ? 0.56 : 1.25 / Math.ceil(Math.sqrt(sharedCount))
      group.scale.setScalar(scale)
      const moving = state.phase === 'moving' && state.motion
      if (moving && state.motion!.pieceId === piece.id && !reduced.matches) {
        const motion = state.motion!,
          step = Math.min(Math.floor(elapsed / 165), motion.steps.length - 1)
        if (elapsed < travelTime) {
          const t = (elapsed % 165) / 165,
            eased = t * t * (3 - 2 * t)
          const from = step === 0 ? motion.from : motion.steps[step - 1],
            to = motion.steps[step]
          const [fx, fz] = piecePosition({ ...piece, progress: from }),
            [tx, tz] = piecePosition({ ...piece, progress: to })
          group.position.set(
            THREE.MathUtils.lerp(fx, tx, eased),
            0.35 + Math.sin(t * Math.PI) * 0.47,
            THREE.MathUtils.lerp(fz, tz, eased),
          )
          group.rotation.z = Math.sin(t * Math.PI) * 0.08
          group.scale.setScalar(1)
        } else {
          const settle = Math.min((elapsed - travelTime) / 220, 1)
          group.scale.set(
            scale * (1 + Math.sin(settle * Math.PI) * 0.13),
            scale * (1 - Math.sin(settle * Math.PI) * 0.1),
            scale * (1 + Math.sin(settle * Math.PI) * 0.13),
          )
        }
      }
      if (moving && state.motion!.captures.includes(piece.id) && !reduced.matches) {
        const captured = state.motion!.capturedPieces.find((p) => p.id === piece.id)!
        const [x, z] = piecePosition(captured)
        if (elapsed < travelTime) group.position.set(x, 0.325, z)
        else {
          const t = Math.min((elapsed - travelTime) / 500, 1),
            rest = restingPosition(piece)
          group.position.set(
            THREE.MathUtils.lerp(x, rest.x, t),
            0.35 + Math.sin(t * Math.PI) * 2,
            THREE.MathUtils.lerp(z, rest.z, t),
          )
          group.rotation.y = t * Math.PI * 4
          group.scale.setScalar(0.7 + 0.3 * Math.abs(t * 2 - 1))
        }
      }
      const legal = state.phase === 'choose' && state.legalMoves.some((m) => m.pieceId === piece.id)
      if (legal && !reduced.matches) group.position.y += Math.sin(now * 0.004 + piece.index) * 0.035 + 0.04
      if (state.winner === piece.playerId && !reduced.matches) {
        group.position.y += Math.abs(Math.sin(now * 0.004 + piece.index * 1.5)) * 0.5
        group.rotation.y = now * 0.001 + piece.index
      }
      const halo = halos.get(piece.id)!
      halo.position.set(group.position.x, piece.progress < 0 ? 0.38 : 0.332, group.position.z)
      halo.scale.setScalar(reduced.matches ? 1 : 1 + Math.sin(now * 0.004) * 0.07)
      ;(halo.material as THREE.MeshBasicMaterial).color.set(PALETTES[piece.playerId].color)
    }
    if (state.phase === 'moving' && state.motion && elapsed >= travelTime && !effectFired) {
      effectFired = true
      if (state.motion.captures.length || state.motion.to === HOME) {
        const piece = state.pieces.find((p) => p.id === state.motion!.pieceId)!,
          [x, z] = piecePosition(piece)
        celebrate(x, z)
      }
    }
    if (state.phase === 'rolling') {
      const t = (now - rollStart) / 1000
      die.position.set(
        dieRest.x + Math.sin(t * 9) * 0.12,
        dieRest.y + (reduced.matches ? 0 : Math.abs(Math.sin(t * 9)) * 0.85 * Math.max(0, 1 - t / 1.1)),
        dieRest.z + Math.sin(t * 5) * 0.14,
      )
      if (!reduced.matches) die.rotation.set(t * 15, t * 12, t * 8)
    } else {
      die.position.lerp(dieRest, 0.2)
      die.quaternion.slerp(dieQuaternion(state.lastDice || 1), reduced.matches ? 1 : 0.22)
    }
    destination.scale.setScalar(reduced.matches ? 1 : 1 + Math.sin(now * 0.006) * 0.06)
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i]
      p.life -= dt
      p.velocity.y -= dt * 3.5
      p.mesh.position.addScaledVector(p.velocity, dt)
      p.mesh.rotation.x += dt * 3
      p.mesh.rotation.z += dt * 2
      if (p.life <= 0 || p.mesh.position.y < 0.3) {
        scene.remove(p.mesh)
        particles.splice(i, 1)
      }
    }
    renderer.render(scene, camera)
  }
  highlight()
  frame = requestAnimationFrame(render)
  return {
    update(next) {
      if (next.phase === 'moving' && state.phase !== 'moving') {
        motionStart = sceneTime
        effectFired = false
      }
      if (next.phase === 'rolling' && state.phase !== 'rolling') rollStart = sceneTime
      if (next.winner && !state.winner) celebrate(0, 0, true)
      state = next
      if (state.phase !== 'choose') focused = null
      else if (!focused || !state.legalMoves.some((m) => m.pieceId === focused))
        focused = state.legalMoves[0]?.pieceId || null
      highlight()
    },
    setRunning(next) {
      running = next
      lastFrame = performance.now()
    },
    focus(id) {
      focused = id
      highlight()
    },
    reset() {
      cameraTarget.copy(home)
      zoomTarget = 1
      cameraTween = true
    },
    zoom(direction) {
      cameraTarget.copy(camera.position)
      zoomTarget = THREE.MathUtils.clamp(camera.zoom + direction * 0.15, 0.75, 1.8)
      cameraTween = true
    },
    top() {
      cameraTarget.set(0, 25, 0.01)
      zoomTarget = 1
      cameraTween = true
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(frame)
      observer.disconnect()
      controls.dispose()
      renderer.domElement.removeEventListener('pointerdown', down)
      renderer.domElement.removeEventListener('pointerup', up)
      renderer.domElement.removeEventListener('pointermove', hover)
      const geometries = new Set<THREE.BufferGeometry>(),
        materials = new Set<THREE.Material>(),
        textures = new Set<THREE.Texture>()
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          geometries.add(object.geometry)
          const all = Array.isArray(object.material) ? object.material : [object.material]
          for (const mat of all) {
            materials.add(mat)
            for (const value of Object.values(mat)) if (value instanceof THREE.Texture) textures.add(value)
          }
        }
      })
      geometries.add(sparkGeometry)
      sparkMaterials.forEach((m) => materials.add(m))
      materials.add(haloMaterial)
      geometries.forEach((g) => g.dispose())
      materials.forEach((m) => m.dispose())
      textures.forEach((t) => t.dispose())
      envTarget.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    },
  }
}
