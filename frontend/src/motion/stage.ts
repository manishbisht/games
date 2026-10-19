import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

/**
 * The renderer, loop and lifecycle every game's scene was writing out by hand:
 * pixel ratio that follows the window between monitors, a ResizeObserver, a
 * soft room environment, a loop that only draws when something changed, WebGL
 * context loss, and a full disposal on the way out.
 *
 * The scene stays the game's own — cameras, lights and models differ too much
 * to share — so this hands back `renderer` and `scene` and asks for a camera.
 */
export interface StageOptions {
  /** Read to screen readers as the canvas's label; omit to hide the canvas from them. */
  label?: string
  maxPixelRatio?: number
  exposure?: number
  environmentIntensity?: number
  shadows?: boolean
  powerPreference?: WebGLPowerPreference
}

/**
 * Called once per animation frame with seconds since the last one (0 while
 * paused, capped so a long frame cannot fling things) and the scene clock in
 * milliseconds. Return true while anything is still moving; the stage keeps
 * drawing until every frame callback has said false.
 */
export type FrameCallback = (dt: number, now: number) => boolean

export function createStage(container: HTMLElement, options: StageOptions = {}) {
  const maxRatio = options.maxPixelRatio ?? 1.75
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    powerPreference: options.powerPreference ?? 'high-performance',
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxRatio))
  renderer.shadowMap.enabled = options.shadows ?? true
  renderer.shadowMap.type = THREE.PCFShadowMap
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = options.exposure ?? 0.95
  if (options.label) {
    renderer.domElement.setAttribute('role', 'img')
    renderer.domElement.setAttribute('aria-label', options.label)
  } else renderer.domElement.setAttribute('aria-hidden', 'true')
  container.appendChild(renderer.domElement)

  const scene = new THREE.Scene()
  const pmrem = new THREE.PMREMGenerator(renderer)
  const room = new RoomEnvironment()
  const environment = pmrem.fromScene(room, 0.03)
  scene.environment = environment.texture
  scene.environmentIntensity = options.environmentIntensity ?? 0.3
  room.dispose()
  pmrem.dispose()

  let camera: THREE.Camera | null = null,
    disposed = false,
    lost = false,
    running = true,
    dirty = true,
    frame = 0,
    last = performance.now(),
    clock = 0
  const frames = new Set<FrameCallback>(),
    resizers = new Set<(width: number, height: number) => void>(),
    cleanups: (() => void)[] = []

  // `resolution` media queries fire when the window crosses to a screen of a
  // different density, or the page is zoomed; re-arm for the new ratio each time.
  let ratioQuery: MediaQueryList | null = null
  const onRatio = () => {
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxRatio))
    resize()
    watchRatio()
  }
  function watchRatio() {
    ratioQuery?.removeEventListener('change', onRatio)
    ratioQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    ratioQuery.addEventListener('change', onRatio)
  }
  watchRatio()

  let width = 0,
    height = 0
  function resize() {
    const w = container.clientWidth,
      h = container.clientHeight
    if (!w || !h) return
    width = w
    height = h
    renderer.setSize(w, h)
    for (const callback of resizers) callback(w, h)
    dirty = true
  }
  const observer = new ResizeObserver(resize)
  observer.observe(container)

  const onLost = (event: Event) => {
    // Without preventDefault the browser never offers the context back.
    event.preventDefault()
    lost = true
  }
  const onRestored = () => {
    lost = false
    dirty = true
  }
  renderer.domElement.addEventListener('webglcontextlost', onLost)
  renderer.domElement.addEventListener('webglcontextrestored', onRestored)

  function tick(wall: number) {
    if (disposed) return
    frame = requestAnimationFrame(tick)
    const delta = Math.max(0, wall - last)
    last = wall
    if (document.hidden || lost) return
    const dt = running ? Math.min(delta / 1000, 1 / 20) : 0
    if (running) clock += Math.min(delta, 50)
    let moving = false
    for (const callback of frames) if (callback(dt, clock)) moving = true
    if ((moving || dirty) && camera) {
      dirty = false
      renderer.render(scene, camera)
    }
  }

  const stage = {
    renderer,
    scene,
    get canvas() {
      return renderer.domElement
    },
    get size() {
      return { width, height }
    },
    /** The scene clock in ms; it stops while the stage is paused. */
    get now() {
      return clock
    },
    get running() {
      return running
    },
    setCamera(next: THREE.Camera) {
      camera = next
      dirty = true
    },
    /** Called now (if laid out) and on every resize. */
    onResize(callback: (width: number, height: number) => void) {
      resizers.add(callback)
      if (width && height) callback(width, height)
      else resize()
      return () => void resizers.delete(callback)
    },
    onFrame(callback: FrameCallback) {
      frames.add(callback)
      return () => void frames.delete(callback)
    },
    /** Draw on the next frame even if nothing reports motion (a material changed, a mesh was added). */
    invalidate() {
      dirty = true
    },
    /** Pausing freezes the clock and every dt, so tweens and queues hold where they are. */
    setRunning(next: boolean) {
      running = next
      dirty = true
    },
    /** Ray-casts a pointer event against `objects` with the current camera. */
    pick(event: { clientX: number; clientY: number }, objects: THREE.Object3D[], recursive = true) {
      if (!camera) return []
      const rect = renderer.domElement.getBoundingClientRect()
      pointer.set(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      )
      raycaster.setFromCamera(pointer, camera)
      return raycaster.intersectObjects(objects, recursive)
    },
    /** Projects a world point to CSS pixels relative to the canvas. */
    toScreen(point: THREE.Vector3, out = new THREE.Vector2()) {
      if (!camera) return out.set(0, 0)
      projected.copy(point).project(camera)
      return out.set(((projected.x + 1) / 2) * width, ((1 - projected.y) / 2) * height)
    },
    /** Runs on dispose, before the scene is torn down. */
    onDispose(cleanup: () => void) {
      cleanups.push(cleanup)
    },
    start() {
      resize()
      last = performance.now()
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(tick)
    },
    dispose() {
      if (disposed) return
      disposed = true
      cancelAnimationFrame(frame)
      for (const cleanup of cleanups.splice(0)) cleanup()
      observer.disconnect()
      ratioQuery?.removeEventListener('change', onRatio)
      renderer.domElement.removeEventListener('webglcontextlost', onLost)
      renderer.domElement.removeEventListener('webglcontextrestored', onRestored)
      disposeTree(scene)
      environment.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    },
  }
  const pointer = new THREE.Vector2(),
    raycaster = new THREE.Raycaster(),
    projected = new THREE.Vector3()
  return stage
}
export type Stage = ReturnType<typeof createStage>

/** Disposes every geometry, material and texture reachable from `root`, once each. */
export function disposeTree(root: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>(),
    materials = new Set<THREE.Material>(),
    textures = new Set<THREE.Texture>()
  root.traverse((object) => {
    const mesh = object as THREE.Mesh
    if (mesh.geometry) geometries.add(mesh.geometry)
    if (!mesh.material) return
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      materials.add(material)
      for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value)
    }
  })
  geometries.forEach((g) => g.dispose())
  materials.forEach((m) => m.dispose())
  textures.forEach((t) => t.dispose())
}

/**
 * Tells a tap from a drag on the canvas, so orbiting the camera never selects
 * whatever the pointer happened to be released over.
 */
export function onTap(element: HTMLElement, handler: (event: PointerEvent) => void, threshold = 6) {
  let x = 0,
    y = 0,
    armed = false
  const down = (event: PointerEvent) => {
    x = event.clientX
    y = event.clientY
    armed = event.button === 0
  }
  const up = (event: PointerEvent) => {
    if (armed && Math.hypot(event.clientX - x, event.clientY - y) <= threshold) handler(event)
    armed = false
  }
  element.addEventListener('pointerdown', down)
  element.addEventListener('pointerup', up)
  return () => {
    element.removeEventListener('pointerdown', down)
    element.removeEventListener('pointerup', up)
  }
}
