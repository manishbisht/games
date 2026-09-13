import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import type { Card, GameState } from '@games/shared/prism/types'
import { COLOR_HEX } from '@games/shared/prism/types'
import { cardArtwork } from './artwork'

export interface TableState {
  game: GameState
  viewer: number
  menu: boolean
  reducedMotion: boolean
  /**
   * Nobody is holding the near seat: its cards belong on the felt like everyone
   * else's rather than in a hand area this viewer does not have.
   */
  watching?: boolean
}
export interface TableApi {
  update: (state: TableState) => void
  zoom: (amount: number) => void
  dispose: () => void
}
export function createScene(container: HTMLElement, initial: TableState): TableApi {
  const scene = new THREE.Scene()
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' })
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 0.9
  renderer.domElement.setAttribute('aria-hidden', 'true')
  container.appendChild(renderer.domElement)
  const pmrem = new THREE.PMREMGenerator(renderer)
  const room = new RoomEnvironment()
  const environment = pmrem.fromScene(room, 0.04)
  scene.environment = environment.texture
  scene.environmentIntensity = 0.28
  pmrem.dispose()
  room.dispose()
  const camera = new THREE.OrthographicCamera(-10, 10, 7, -7, 0.1, 70)
  camera.position.set(0, 13, 15)
  camera.lookAt(0, 0, 0)
  scene.add(new THREE.HemisphereLight('#fff4df', '#153831', 1.3))
  const key = new THREE.DirectionalLight('#fff0d9', 2)
  key.position.set(-6, 14, 8)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  Object.assign(key.shadow.camera, { left: -12, right: 12, top: 9, bottom: -9, near: 1, far: 40 })
  key.shadow.bias = -0.0004
  key.shadow.normalBias = 0.035
  key.shadow.radius = 5
  scene.add(key)
  const rimLight = new THREE.DirectionalLight('#a8d9ce', 1.2)
  rimLight.position.set(6, 5, -8)
  scene.add(rimLight)
  const materials = new Set<THREE.Material>(),
    geometries = new Set<THREE.BufferGeometry>(),
    textures = new Map<string, THREE.Texture>()
  function mesh(geometry: THREE.BufferGeometry, material: THREE.Material) {
    geometries.add(geometry)
    materials.add(material)
    return new THREE.Mesh(geometry, material)
  }
  const shadowFloor = mesh(
    new THREE.PlaneGeometry(80, 80),
    new THREE.ShadowMaterial({ color: '#000000', opacity: 0.27 }),
  )
  shadowFloor.rotation.x = -Math.PI / 2
  shadowFloor.position.y = -0.7
  shadowFloor.receiveShadow = true
  scene.add(shadowFloor)
  const noise = document.createElement('canvas')
  noise.width = noise.height = 256
  const ctx = noise.getContext('2d')!
  const pixels = ctx.createImageData(256, 256)
  let seed = 913
  for (let i = 0; i < pixels.data.length; i += 4) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    const n = (seed / 4294967296) * 32
    pixels.data[i] = 80 + n
    pixels.data[i + 1] = 100 + n
    pixels.data[i + 2] = 85 + n
    pixels.data[i + 3] = 255
  }
  ctx.putImageData(pixels, 0, 0)
  const felt = new THREE.CanvasTexture(noise)
  felt.wrapS = felt.wrapT = THREE.RepeatWrapping
  felt.repeat.set(15, 10)
  textures.set('felt', felt)
  function oval(
    rx: number,
    rz: number,
    height: number,
    y: number,
    color: string,
    roughness: number,
    map?: THREE.Texture,
  ) {
    const obj = mesh(
      new THREE.CylinderGeometry(1, 1, height, 128),
      new THREE.MeshStandardMaterial({
        color,
        roughness,
        map: map ?? null,
        bumpMap: map ?? null,
        bumpScale: 0.016,
      }),
    )
    obj.scale.set(rx, 1, rz)
    obj.position.y = y
    obj.receiveShadow = true
    obj.castShadow = true
    scene.add(obj)
  }
  oval(9.25, 5.15, 0.35, -0.27, '#111e1b', 0.52)
  oval(9.1, 5.02, 0.16, -0.05, '#344139', 0.65)
  oval(8.79, 4.73, 0.09, 0.065, '#427262', 0.96, felt)
  function ellipse(rx: number, rz: number, color: string, y: number, opacity: number) {
    const points = Array.from(
      { length: 161 },
      (_, i) =>
        new THREE.Vector3(Math.cos((i / 160) * Math.PI * 2) * rx, y, Math.sin((i / 160) * Math.PI * 2) * rz),
    )
    const geometry = new THREE.BufferGeometry().setFromPoints(points)
    geometries.add(geometry)
    const material = new THREE.LineBasicMaterial({ color, transparent: true, opacity })
    materials.add(material)
    const line = new THREE.LineLoop(geometry, material)
    scene.add(line)
  }
  ellipse(8.87, 4.81, '#d8b778', 0.122, 0.72)
  ellipse(8.46, 4.4, '#b7c2a4', 0.117, 0.24)
  ellipse(8.4, 4.34, '#b7c2a4', 0.117, 0.1)
  const inkCanvas = document.createElement('canvas')
  inkCanvas.width = 1024
  inkCanvas.height = 256
  const ink = inkCanvas.getContext('2d')!
  ink.textAlign = 'center'
  ink.fillStyle = '#b8c5a5'
  ink.font = '500 56px Georgia, serif'
  ink.fillText('P  R  I  S  M', 512, 100)
  ink.font = '400 16px Arial, sans-serif'
  ink.fillText('A   L I T T L E   C O L O R .   A   L I T T L E   C H A O S .', 512, 147)
  const inkTexture = new THREE.CanvasTexture(inkCanvas)
  textures.set('ink', inkTexture)
  const logo = mesh(
    new THREE.PlaneGeometry(4.8, 1.2),
    new THREE.MeshBasicMaterial({ map: inkTexture, transparent: true, opacity: 0.28, depthWrite: false }),
  )
  logo.rotation.x = -Math.PI / 2
  logo.position.set(0, 0.12, -1.8)
  scene.add(logo)
  const cards = new THREE.Group()
  scene.add(cards)
  const flyovers = new THREE.Group()
  scene.add(flyovers)
  const bodyGeometry = new RoundedBoxGeometry(1.36, 0.044, 2.04, 3, 0.065)
  geometries.add(bodyGeometry)
  const faceGeometry = new THREE.PlaneGeometry(1.36, 2.04)
  geometries.add(faceGeometry)
  const edgeMaterial = new THREE.MeshStandardMaterial({ color: '#efeadb', roughness: 0.72 })
  materials.add(edgeMaterial)
  const cardMaterials = new Map<string, THREE.MeshStandardMaterial>()
  function makeCard(card?: Card) {
    const key = card ? `${card.color}-${card.value}` : 'back'
    let material = cardMaterials.get(key)
    if (!material) {
      const texture = new THREE.CanvasTexture(cardArtwork(card))
      texture.colorSpace = THREE.SRGBColorSpace
      texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy())
      textures.set(key, texture)
      material = new THREE.MeshStandardMaterial({
        map: texture,
        roughness: 0.5,
        metalness: 0.02,
        transparent: true,
      })
      cardMaterials.set(key, material)
      materials.add(material)
    }
    const group = new THREE.Group()
    const body = new THREE.Mesh(bodyGeometry, edgeMaterial)
    body.castShadow = true
    body.receiveShadow = true
    const face = new THREE.Mesh(faceGeometry, material)
    face.rotation.x = -Math.PI / 2
    face.position.y = 0.024
    face.receiveShadow = true
    group.add(body, face)
    return group
  }
  let state = initial,
    sequence = initial.game.sequence,
    currentRound = initial.game.round,
    frame = 0,
    targetZoom = 1,
    needsRender = true
  const movers: {
    object: THREE.Group
    from: THREE.Vector3
    to: THREE.Vector3
    start: number
    duration: number
    rotation: number
  }[] = []
  const deckPosition = new THREE.Vector3(-1.15, 0.37, 0.45),
    discardPosition = new THREE.Vector3(1.05, 0.2, 0.45)
  function seatPosition(player: number) {
    const seat = (player - state.viewer + state.game.players.length) % state.game.players.length
    if (seat === 0) return new THREE.Vector3(0, 0.23, 4.7)
    if (state.game.players.length === 2 || (state.game.players.length === 4 && seat === 2))
      return new THREE.Vector3(0, 0.22, -3)
    return new THREE.Vector3(seat === 1 ? -6.1 : 6.1, 0.22, -0.1)
  }
  function fly(from: THREE.Vector3, to: THREE.Vector3, delay = 0, card?: Card) {
    if (state.reducedMotion) return
    const object = makeCard(card)
    object.position.copy(from)
    object.scale.setScalar(0.82)
    flyovers.add(object)
    movers.push({
      object,
      from: from.clone(),
      to: to.clone(),
      start: performance.now() + delay,
      duration: 500,
      rotation: 0.14,
    })
  }
  function deal() {
    for (let i = 0; i < 7; i++)
      state.game.players.forEach((p) => fly(deckPosition, seatPosition(p.id), i * 95 + p.id * 35))
  }
  const colorMaterial = new THREE.MeshStandardMaterial({
    color: COLOR_HEX[state.game.activeColor],
    emissive: COLOR_HEX[state.game.activeColor],
    emissiveIntensity: 0.22,
    roughness: 0.4,
    metalness: 0.35,
  })
  materials.add(colorMaterial)
  const colorToken = mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.08, 40), colorMaterial)
  colorToken.position.set(2.6, 0.2, 0.6)
  colorToken.castShadow = true
  scene.add(colorToken)
  function sync() {
    cards.clear()
    for (let i = 0; i < Math.min(12, Math.ceil(state.game.drawPile.length / 6)); i++) {
      const object = makeCard()
      object.position.copy(deckPosition)
      object.position.y = 0.16 + i * 0.023
      object.rotation.y = ((i % 3) - 1) * 0.009
      cards.add(object)
    }
    state.game.discardPile.slice(-4).forEach((card, i, arr) => {
      const object = makeCard(card)
      object.position.copy(discardPosition)
      object.position.y = 0.16 + i * 0.03
      object.rotation.y = i === arr.length - 1 ? -0.11 : i % 2 ? 0.14 : -0.24
      cards.add(object)
    })
    state.game.players.forEach((p) => {
      // The viewer's own hand is dealt into the DOM instead — unless there is no
      // viewer, in which case the near seat is just another player's.
      if (p.id === state.viewer && !state.menu && !state.watching) return
      const center = seatPosition(p.id),
        count = Math.min(p.hand.length, 11)
      const rotation = center.x < -1 ? Math.PI / 2 : center.x > 1 ? -Math.PI / 2 : center.z < 0 ? Math.PI : 0
      for (let i = 0; i < count; i++) {
        const object = makeCard(state.menu && p.id === state.viewer ? p.hand[i] : undefined)
        const offset = (i - (count - 1) / 2) * 0.31
        object.position.copy(center)
        object.position.x += Math.cos(rotation) * offset
        object.position.z -= Math.sin(rotation) * offset
        object.position.y += i * 0.014
        object.rotation.y = rotation + (i - (count - 1) / 2) * -0.045
        object.scale.setScalar(0.8)
        cards.add(object)
      }
    })
    colorMaterial.color.set(COLOR_HEX[state.game.activeColor])
    colorMaterial.emissive.set(COLOR_HEX[state.game.activeColor])
    needsRender = true
  }
  function resize() {
    const { width, height } = container.getBoundingClientRect()
    if (!width || !height) return
    renderer.setSize(width, height)
    const aspect = width / height
    const span = width < 650 ? 6.8 : Math.max(5.8, 9.7 / aspect)
    camera.left = -span * aspect
    camera.right = span * aspect
    camera.top = span
    camera.bottom = -span
    camera.updateProjectionMatrix()
    needsRender = true
  }
  const observer = new ResizeObserver(resize)
  observer.observe(container)
  resize()
  sync()
  function render(now: number) {
    frame = requestAnimationFrame(render)
    if (document.hidden) return
    const cameraMoving = Math.abs(camera.zoom - targetZoom) > 0.001
    if (cameraMoving) {
      camera.zoom = THREE.MathUtils.lerp(camera.zoom, targetZoom, state.reducedMotion ? 1 : 0.12)
      camera.updateProjectionMatrix()
    }
    for (let i = movers.length - 1; i >= 0; i--) {
      const m = movers[i],
        t = THREE.MathUtils.clamp((now - m.start) / m.duration, 0, 1),
        ease = t * t * (3 - 2 * t)
      m.object.visible = now >= m.start
      m.object.position.lerpVectors(m.from, m.to, ease)
      m.object.position.y += Math.sin(Math.PI * t) * 2
      m.object.rotation.y = Math.sin(Math.PI * t) * m.rotation
      m.object.rotation.z = Math.sin(Math.PI * t) * -0.22
      if (t >= 1) {
        flyovers.remove(m.object)
        movers.splice(i, 1)
      }
    }
    if (needsRender || cameraMoving || movers.length) {
      renderer.render(scene, camera)
      needsRender = movers.length > 0
    }
  }
  frame = requestAnimationFrame(render)
  return {
    update(next) {
      const wasMenu = state.menu,
        viewerChanged = state.viewer !== next.viewer
      state = next
      if ((wasMenu && !state.menu) || currentRound !== state.game.round) {
        sequence = state.game.sequence
        currentRound = state.game.round
        deal()
      }
      if (!viewerChanged)
        for (const event of state.game.events.filter((e) => e.id > sequence)) {
          if (event.kind === 'play' && event.player !== undefined)
            fly(seatPosition(event.player), discardPosition, 0, event.card)
          if (event.kind === 'draw' && event.player !== undefined)
            for (let i = 0; i < Math.min(event.count ?? 1, 10); i++)
              fly(deckPosition, seatPosition(event.player), i * 80)
          if (event.kind === 'shuffle') for (let i = 0; i < 5; i++) fly(discardPosition, deckPosition, i * 55)
          if (event.kind === 'win')
            state.game.players.forEach((p) => fly(seatPosition(p.id), discardPosition, p.id * 80))
        }
      sequence = state.game.sequence
      sync()
    },
    zoom(amount) {
      targetZoom = THREE.MathUtils.clamp(targetZoom + amount, 0.85, 1.25)
      needsRender = true
    },
    dispose() {
      cancelAnimationFrame(frame)
      observer.disconnect()
      geometries.forEach((g) => g.dispose())
      materials.forEach((m) => m.dispose())
      textures.forEach((t) => t.dispose())
      environment.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    },
  }
}
