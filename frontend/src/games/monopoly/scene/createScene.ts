import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { BOARD } from '@games/shared/estate/board'
import type { GameState } from '@games/shared/estate/types'
import {
  boardPosition,
  box,
  canvasTexture,
  dieRotation,
  makeDie,
  makeHouse,
  makeToken,
  material,
  tileTexture,
} from './models'

export interface SceneApi {
  update: (state: GameState) => void
  select: (id: number | null) => void
  reset: () => void
  zoom: (direction: number) => void
  topView: () => void
  dispose: () => void
}
export function createScene(
  container: HTMLElement,
  initial: GameState,
  onSelect: (id: number) => void,
): SceneApi {
  let state = initial,
    disposed = false
  const scene = new THREE.Scene()
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: 'high-performance',
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1
  container.appendChild(renderer.domElement)
  renderer.domElement.setAttribute(
    'aria-label',
    'Interactive 3D Estate board. Drag to rotate, scroll to zoom. Select a space for its details.',
  )
  const camera = new THREE.OrthographicCamera(-10, 10, 7, -7, 0.1, 100)
  const home = new THREE.Vector3(12, 18, 20)
  camera.position.copy(home)
  camera.lookAt(0, 0, 0)
  const controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.enablePan = false
  controls.minPolarAngle = 0.08
  controls.maxPolarAngle = Math.PI / 2.6
  controls.minZoom = 0.7
  controls.maxZoom = 2
  controls.rotateSpeed = 0.5
  controls.zoomSpeed = 0.65
  controls.target.set(0, 0.05, 0)
  scene.add(new THREE.HemisphereLight('#e1ebff', '#8c7f65', 1.5))
  const key = new THREE.DirectionalLight('#fff1d9', 1.8)
  key.position.set(-6, 14, 8)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  Object.assign(key.shadow.camera, { left: -10, right: 10, top: 10, bottom: -10, near: 0.5, far: 35 })
  key.shadow.bias = -0.0005
  key.shadow.normalBias = 0.02
  key.shadow.radius = 4
  scene.add(key)
  const fill = new THREE.DirectionalLight('#9ab9ef', 0.65)
  fill.position.set(8, 7, -10)
  scene.add(fill)

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

  // Original card decks, lightly offset to reveal their paper edges.
  for (let deck = 0; deck < 2; deck++) {
    const stack = new THREE.Group()
    stack.position.set(deck ? 2.65 : -2.6, 0.2, deck ? -1.9 : 0.3)
    stack.rotation.y = deck ? -0.2 : 0.18
    for (let i = 0; i < 4; i++) {
      const card = box(1.15, 0.025, 1.7, '#eee9d9', 0.03)
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
    const top = new THREE.Mesh(
      new THREE.PlaneGeometry(1.15, 1.7),
      new THREE.MeshStandardMaterial({ map, roughness: 0.7 }),
    )
    top.rotation.x = -Math.PI / 2
    top.position.set(0.036, 0.098, -0.036)
    stack.add(top)
    scene.add(stack)
  }

  // A miniature architectural skyline is a quiet sculptural detail in the center.
  const city = new THREE.Group()
  city.position.set(-0.35, 0.2, -2.5)
  city.rotation.y = -0.15
  const cityBase = box(2.8, 0.08, 1.25, '#b2bda5', 0.09)
  city.add(cityBase)
  const buildings = [
    { x: -0.94, z: 0.1, h: 0.54, w: 0.45 },
    { x: -0.42, z: -0.18, h: 0.97, w: 0.45 },
    { x: 0.16, z: 0.12, h: 1.48, w: 0.52 },
    { x: 0.76, z: -0.15, h: 0.82, w: 0.51 },
    { x: 1.11, z: 0.26, h: 0.35, w: 0.3 },
  ]
  buildings.forEach((b, i) => {
    const block = box(b.w, b.h, 0.43, ['#d6d6bb', '#eddfbe', '#f0e6cd', '#c0cab3', '#ded5b5'][i], 0.035)
    block.position.set(b.x, b.h / 2 + 0.06, b.z)
    city.add(block)
    const roof = box(b.w + 0.035, 0.06, 0.465, '#a0ac98', 0.015)
    roof.position.set(b.x, b.h + 0.08, b.z)
    city.add(roof)
    for (let y = 0.21; y < b.h; y += 0.22)
      for (let x = -0.12; x <= 0.12; x += 0.24) {
        const window = new THREE.Mesh(new THREE.PlaneGeometry(0.08, 0.1), material('#798b7c'))
        window.position.set(b.x + x, y + 0.08, b.z + 0.219)
        city.add(window)
      }
    if (i === 2) {
      const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.035, 0.4, 8), material('#879982', 0.4))
      spire.position.set(b.x, b.h + 0.28, b.z)
      city.add(spire)
    }
  })
  for (const x of [-1.24, 1.38]) {
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.035, 0.24, 8), material('#9a8764'))
    trunk.position.set(x, 0.15, 0.45)
    city.add(trunk)
    const leaves = new THREE.Mesh(new THREE.IcosahedronGeometry(0.17, 1), material('#7e9e7a'))
    leaves.position.set(x, 0.36, 0.45)
    leaves.castShadow = true
    city.add(leaves)
  }
  scene.add(city)

  const tiles: THREE.Object3D[] = [],
    tileGroups = new Map<number, THREE.Group>()
  BOARD.forEach((space) => {
    const corner = space.id % 10 === 0,
      width = corner ? 1.5 : 0.922
    const group = new THREE.Group(),
      [x, z] = boardPosition(space.id)
    group.position.set(x, 0.17, z)
    group.rotation.y = (-Math.floor(space.id / 10) * Math.PI) / 2
    const slab = box(width, 0.11, 1.5, '#eee9d9', 0.022)
    group.add(slab)
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
  const normalOutline = tileOutline(1.025, 1.6)
  const cornerOutline = tileOutline(1.6, 1.6)
  const focus = new THREE.Mesh(
    normalOutline,
    new THREE.MeshBasicMaterial({
      color: '#ffb74f',
      toneMapped: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  )
  focus.rotation.x = -Math.PI / 2
  focus.visible = false
  focus.renderOrder = 3
  scene.add(focus)
  let selectedSpace: number | null = null,
    hoveredSpace: number | null = null
  function refreshFocus() {
    const id = selectedSpace ?? hoveredSpace
    focus.visible = id !== null
    if (id === null) return
    const [x, z] = boardPosition(id)
    focus.position.set(x, 0.255, z)
    focus.geometry = id % 10 === 0 ? cornerOutline : normalOutline
    focus.rotation.set(-Math.PI / 2, 0, (Math.floor(id / 10) * Math.PI) / 2)
    ;(focus.material as THREE.MeshBasicMaterial).color.set(selectedSpace !== null ? '#ffd58b' : '#f3a737')
  }
  const tooltip = document.createElement('div')
  tooltip.className = 'board-tooltip'
  tooltip.setAttribute('role', 'tooltip')
  tooltip.hidden = true
  const tooltipTitle = document.createElement('strong'),
    tooltipDetail = document.createElement('span')
  tooltip.append(tooltipTitle, tooltipDetail)
  container.appendChild(tooltip)
  const ownership = new THREE.Group()
  scene.add(ownership)
  let propertySignature = ''
  const tokenGroups: THREE.Group[] = [],
    tokenPositions: number[] = [],
    tokenMotions: { start: THREE.Vector3; end: THREE.Vector3; at: number; active: boolean }[] = []
  function offsetFor(id: number) {
    return [(id % 2 ? 1 : -1) * 0.22, (id < 2 ? 1 : -1) * 0.2]
  }
  function tokenTarget(id: number, position: number) {
    const [x, z] = boardPosition(position),
      [ox, oz] = offsetFor(id)
    return new THREE.Vector3(x + ox, 0.24, z + oz)
  }
  function setupTokens() {
    tokenGroups.forEach((g) => {
      scene.remove(g)
      disposeObject(g)
    })
    tokenGroups.length = 0
    tokenPositions.length = 0
    tokenMotions.length = 0
    state.players.forEach((p) => {
      const g = makeToken(p.token, p.color)
      g.position.copy(tokenTarget(p.id, p.position))
      g.rotation.y = -0.3
      scene.add(g)
      tokenGroups.push(g)
      tokenPositions.push(p.position)
      tokenMotions.push({ start: g.position.clone(), end: g.position.clone(), at: 0, active: false })
    })
  }
  setupTokens()
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.36, 0.018, 8, 48),
    new THREE.MeshBasicMaterial({ color: state.players[0].color, transparent: true, opacity: 0.85 }),
  )
  ring.rotation.x = -Math.PI / 2
  scene.add(ring)
  const dice = [makeDie(), makeDie()]
  dice.forEach((d, i) => {
    d.position.set(i ? 0.65 : -0.55, 0.5, 2.52 + i * 0.28)
    d.quaternion.copy(dieRotation(state.dice[i], i ? 0.4 : -0.2))
    scene.add(d)
  })
  let rollStarted = -1,
    lastRollId = initial.rollId
  const diceFrom = [new THREE.Quaternion(), new THREE.Quaternion()]
  let cameraTarget: THREE.Vector3 | null = null,
    targetZoom = 1

  function update(next: GameState) {
    if (disposed) return
    const changedPlayers =
      state.players.length !== next.players.length ||
      state.players.some((p, i) => p.token !== next.players[i]?.token)
    state = next
    if (changedPlayers) setupTokens()
    state.players.forEach((p) => {
      tokenGroups[p.id].visible = !p.bankrupt
      if (tokenPositions[p.id] !== p.position) {
        tokenMotions[p.id] = {
          start: tokenGroups[p.id].position.clone(),
          end: tokenTarget(p.id, p.position),
          at: performance.now(),
          active: true,
        }
        tokenPositions[p.id] = p.position
      }
    })
    ;(ring.material as THREE.MeshBasicMaterial).color.set(state.players[state.winner ?? state.current].color)
    if (state.rollId < lastRollId) {
      lastRollId = state.rollId
      rollStarted = -1
      dice.forEach((d, i) => {
        d.position.set(i ? 0.65 : -0.55, 0.5, 2.52 + i * 0.28)
        d.quaternion.copy(dieRotation(state.dice[i], i ? 0.4 : -0.2))
      })
    }
    if (state.rollId !== lastRollId && state.phase === 'rolling') {
      rollStarted = performance.now()
      lastRollId = state.rollId
      dice.forEach((d, i) => diceFrom[i].copy(d.quaternion))
    }
    const signature = JSON.stringify(state.properties)
    if (signature !== propertySignature) {
      propertySignature = signature
      while (ownership.children.length) {
        const child = ownership.children[0]
        ownership.remove(child)
        disposeObject(child)
      }
      Object.entries(state.properties).forEach(([idString, property]) => {
        const id = Number(idString),
          parent = tileGroups.get(id)!,
          group = new THREE.Group()
        group.position.copy(parent.position)
        group.rotation.copy(parent.rotation)
        const marker = box(
          0.64,
          0.045,
          0.13,
          property.mortgaged ? '#858781' : state.players[property.owner].color,
          0.025,
        )
        marker.position.set(0, 0.105, 0.61)
        group.add(marker)
        if (property.level === 5) {
          const hotel = makeHouse(true)
          hotel.position.set(0, 0.12, -0.5)
          group.add(hotel)
        } else
          for (let h = 0; h < property.level; h++) {
            const house = makeHouse()
            house.scale.setScalar(0.77)
            house.position.set((h - (property.level - 1) / 2) * 0.22, 0.11, -0.52)
            group.add(house)
          }
        ownership.add(group)
      })
    }
  }
  update(initial)
  const resize = () => {
    const w = container.clientWidth,
      h = container.clientHeight
    if (!w || !h) return
    renderer.setSize(w, h)
    const aspect = w / h,
      half = Math.max(6.5, 8.7 / aspect)
    camera.left = -half * aspect
    camera.right = half * aspect
    camera.top = half
    camera.bottom = -half
    camera.updateProjectionMatrix()
  }
  const observer = new ResizeObserver(resize)
  observer.observe(container)
  resize()
  const raycaster = new THREE.Raycaster(),
    pointer = new THREE.Vector2()
  let down = [0, 0]
  const onDown = (e: PointerEvent) => {
    down = [e.clientX, e.clientY]
    cameraTarget = null
    tooltip.hidden = true
  }
  const spaceAtPointer = (e: PointerEvent) => {
    const rect = renderer.domElement.getBoundingClientRect()
    pointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      (-(e.clientY - rect.top) / rect.height) * 2 + 1,
    )
    raycaster.setFromCamera(pointer, camera)
    const hits = raycaster.intersectObjects(tiles)
    return hits[0] ? (hits[0].object.userData.spaceId as number) : null
  }
  const onUp = (e: PointerEvent) => {
    if (Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return
    const id = spaceAtPointer(e)
    if (id !== null) {
      selectedSpace = id
      refreshFocus()
      tooltip.hidden = true
      onSelect(id)
    }
  }
  const onMove = (e: PointerEvent) => {
    hoveredSpace = e.buttons ? null : spaceAtPointer(e)
    refreshFocus()
    renderer.domElement.style.cursor = e.buttons ? 'grabbing' : hoveredSpace !== null ? 'pointer' : 'grab'
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
    const rect = renderer.domElement.getBoundingClientRect()
    tooltip.style.left = `${Math.max(12, Math.min(e.clientX - rect.left + 15, rect.width - 220))}px`
    tooltip.style.top = `${Math.max(12, Math.min(e.clientY - rect.top - 70, rect.height - 80))}px`
  }
  const onLeave = () => {
    hoveredSpace = null
    tooltip.hidden = true
    refreshFocus()
  }
  renderer.domElement.addEventListener('pointerdown', onDown)
  renderer.domElement.addEventListener('pointerup', onUp)
  renderer.domElement.addEventListener('pointermove', onMove)
  renderer.domElement.addEventListener('pointerleave', onLeave)
  const wheel = () => {
    targetZoom = camera.zoom
  }
  renderer.domElement.addEventListener('wheel', wheel, { passive: true })
  renderer.setAnimationLoop(() => {
    const now = performance.now()
    if (cameraTarget) {
      camera.position.lerp(cameraTarget, 0.055)
      camera.zoom += (targetZoom - camera.zoom) * 0.07
      camera.updateProjectionMatrix()
      if (camera.position.distanceTo(cameraTarget) < 0.02 && Math.abs(camera.zoom - targetZoom) < 0.002)
        cameraTarget = null
    }
    tokenMotions.forEach((m, i) => {
      if (!m.active) return
      const t = Math.min((now - m.at) / 190, 1),
        ease = t * t * (3 - 2 * t)
      tokenGroups[i].position.lerpVectors(m.start, m.end, ease)
      tokenGroups[i].position.y += Math.sin(t * Math.PI) * 0.25
      if (t === 1) m.active = false
    })
    const currentToken = tokenGroups[state.winner ?? state.current]
    ring.position.set(currentToken.position.x, 0.258, currentToken.position.z)
    ring.scale.setScalar(1 + Math.sin(now * 0.0025) * 0.065)
    if (rollStarted >= 0) {
      const t = Math.min((now - rollStarted) / 1120, 1)
      dice.forEach((d, i) => {
        const end = dieRotation(state.dice[i], i ? 0.4 : -0.2)
        if (t < 0.74) {
          d.rotation.set(t * 18 + i, t * 13, t * 15 + i)
          d.position.set(
            (i ? 0.65 : -0.55) + Math.sin(t * 9 + i) * (1 - t) * 0.9,
            0.5 + Math.abs(Math.sin(t * Math.PI * 3)) * (1 - t) * 2,
            2.52 + i * 0.28 + Math.sin(t * 6) * (1 - t),
          )
          diceFrom[i].copy(d.quaternion)
        } else {
          d.quaternion.slerpQuaternions(diceFrom[i], end, (t - 0.74) / 0.26)
          d.position.lerp(new THREE.Vector3(i ? 0.65 : -0.55, 0.5, 2.52 + i * 0.28), 0.25)
        }
        if (t === 1) {
          d.quaternion.copy(end)
          d.position.set(i ? 0.65 : -0.55, 0.5, 2.52 + i * 0.28)
        }
      })
      if (t === 1) rollStarted = -1
    }
    controls.update()
    renderer.render(scene, camera)
  })
  return {
    update,
    select(id) {
      selectedSpace = id
      refreshFocus()
      tooltip.hidden = true
    },
    reset() {
      cameraTarget = home.clone()
      targetZoom = 1
    },
    zoom(direction) {
      targetZoom = THREE.MathUtils.clamp(camera.zoom + direction * 0.18, 0.7, 2)
      camera.zoom = targetZoom
      camera.updateProjectionMatrix()
    },
    topView() {
      cameraTarget = new THREE.Vector3(0, 28, 0.01)
      targetZoom = 1
    },
    dispose() {
      disposed = true
      renderer.setAnimationLoop(null)
      observer.disconnect()
      controls.dispose()
      renderer.domElement.removeEventListener('pointerdown', onDown)
      renderer.domElement.removeEventListener('pointerup', onUp)
      renderer.domElement.removeEventListener('pointermove', onMove)
      renderer.domElement.removeEventListener('pointerleave', onLeave)
      renderer.domElement.removeEventListener('wheel', wheel)
      disposeObject(scene)
      normalOutline.dispose()
      cornerOutline.dispose()
      renderer.dispose()
      renderer.domElement.remove()
      tooltip.remove()
    },
  }
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
function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose()
      const materials = Array.isArray(child.material) ? child.material : [child.material]
      materials.forEach((m) => {
        if ('map' in m && m.map instanceof THREE.Texture) m.map.dispose()
        m.dispose()
      })
    }
  })
}
