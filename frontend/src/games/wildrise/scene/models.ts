import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import { PALETTES, spaceCoordinates } from '@games/shared/wildrise/board'
import type { GameState, PlayerId, Route } from '@games/shared/wildrise/types'

export const material = (color: string, roughness = 0.48, metalness = 0) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness })
export function box(w: number, h: number, d: number, color: string, radius = 0.08) {
  const mesh = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, radius), material(color))
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}
function ball(
  parent: THREE.Object3D,
  color: string | THREE.Material,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy = sx,
  sz = sx,
) {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(1, 20, 14),
    typeof color === 'string' ? material(color, 0.28) : color,
  )
  mesh.position.set(x, y, z)
  mesh.scale.set(sx, sy, sz)
  mesh.castShadow = true
  parent.add(mesh)
  return mesh
}
/**
 * The shadow pass draws every caster with one shared depth material, and each
 * time it is handed a different kind of mesh than the last — instanced after
 * plain, with instance colours after without — the renderer looks its program
 * up again, several times a frame. Each kind of instanced caster has its own.
 */
const depth = { tinted: new THREE.MeshDepthMaterial(), plain: new THREE.MeshDepthMaterial() }
const UP = new THREE.Vector3(0, 1, 0),
  placer = new THREE.Object3D(),
  tint = new THREE.Color()

/**
 * Many small parts baked into one mesh, each part's colour written into its
 * vertices: one draw call — and one shadow draw — where there were dozens.
 * The table is several hundred little pieces (eyes, rungs, pips, leaves), and
 * drawing each on its own was most of what a frame cost on a slow phone, and
 * most of the garbage each frame left behind.
 */
export class Parts {
  private list: THREE.BufferGeometry[] = []
  /** `place` poses the part as if it were an object of its own. */
  add(geometry: THREE.BufferGeometry, color: string, place?: (part: THREE.Object3D) => void) {
    placer.position.set(0, 0, 0)
    placer.rotation.set(0, 0, 0)
    placer.scale.set(1, 1, 1)
    place?.(placer)
    placer.updateMatrix()
    geometry.applyMatrix4(placer.matrix)
    tint.set(color)
    const count = geometry.attributes.position.count,
      colors = new Float32Array(count * 3)
    for (let i = 0; i < count; i++) {
      colors[i * 3] = tint.r
      colors[i * 3 + 1] = tint.g
      colors[i * 3 + 2] = tint.b
    }
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    this.list.push(geometry)
    return this
  }
  ball(color: string, x: number, y: number, z: number, sx: number, sy = sx, sz = sx, rx = 0, rz = 0) {
    return this.add(new THREE.SphereGeometry(1, 20, 14), color, (part) => {
      part.position.set(x, y, z)
      part.scale.set(sx, sy, sz)
      part.rotation.set(rx, 0, rz)
    })
  }
  rod(a: THREE.Vector3, b: THREE.Vector3, radius: number, color: string) {
    return this.add(new THREE.CylinderGeometry(radius, radius, a.distanceTo(b), 12), color, (part) => {
      part.position.copy(a).add(b).multiplyScalar(0.5)
      part.quaternion.setFromUnitVectors(UP, b.clone().sub(a).normalize())
    })
  }
  mesh(roughness: number, metalness = 0, shadow = true) {
    const geometry = mergeGeometries(this.list)
    for (const part of this.list) part.dispose()
    this.list = []
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness, metalness }),
    )
    mesh.castShadow = shadow
    return mesh
  }
}
export function canvasTexture(size: number, draw: (ctx: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  draw(ctx)
  const map = new THREE.CanvasTexture(canvas)
  map.colorSpace = THREE.SRGBColorSpace
  map.anisotropy = 8
  return map
}
function print(map: THREE.Texture, w: number, h: number, y: number) {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(w, h),
    new THREE.MeshStandardMaterial({ map, transparent: true, roughness: 0.83, depthWrite: false }),
  )
  mesh.rotation.x = -Math.PI / 2
  mesh.position.y = y
  mesh.receiveShadow = true
  return mesh
}

const TILE_Y = 0.187

/**
 * The board. Its hundred tiles are drawn as one instanced mesh — 99 of them,
 * with the finish its own mesh so it can glow — and `press` sinks any of them
 * a little under a landing token.
 */
export function makeBoard(state: GameState) {
  const group = new THREE.Group()
  const foundation = box(11.35, 0.44, 11.35, '#7c533b', 0.16)
  foundation.position.y = -0.22
  group.add(foundation)
  const trim = box(11.13, 0.075, 11.13, '#c19761', 0.13)
  trim.position.y = 0.015
  group.add(trim)
  const frame = box(10.94, 0.15, 10.94, '#9a6b45', 0.12)
  frame.position.y = 0.06
  group.add(frame)
  const inset = box(10.24, 0.07, 10.24, '#654733', 0.045)
  inset.position.y = 0.13
  group.add(inset)
  const tileColors = ['#c8d6a7', '#ead7ae', '#bcd8c4', '#e7cca5']
  const squares = new THREE.InstancedMesh(
    new RoundedBoxGeometry(0.976, 0.075, 0.976, 3, 0.035),
    material('#ffffff'),
    99,
  )
  squares.castShadow = squares.receiveShadow = true
  squares.customDepthMaterial = depth.tinted
  const finish = box(0.976, 0.075, 0.976, '#e8c775', 0.035) as THREE.Mesh<
    THREE.BufferGeometry,
    THREE.MeshStandardMaterial
  >
  const placed = new THREE.Matrix4(),
    color = new THREE.Color(),
    at = new THREE.Vector3(),
    pressed = new Float32Array(101)
  for (let n = 1; n <= 99; n++) {
    const { x, z } = spaceCoordinates(n)
    const row = Math.floor((n - 1) / 10),
      column = (n - 1) % 10
    const snake = state.board.snakes.some((r) => r.from === n)
    const ladder = state.board.ladders.some((r) => r.from === n)
    squares.setMatrixAt(n - 1, placed.makeTranslation(x, TILE_Y, z))
    squares.setColorAt(
      n - 1,
      color.set(snake ? '#edcec0' : ladder ? '#c9ddbf' : tileColors[(row + column) % 4]),
    )
  }
  squares.computeBoundingSphere()
  const top = spaceCoordinates(100)
  finish.position.set(top.x, TILE_Y, top.z)
  group.add(squares, finish)
  /** Sinks each square by `depth[square]`, touching only the ones that changed. */
  function press(depth: Float32Array) {
    let changed = false
    for (let n = 1; n <= 99; n++) {
      if (depth[n] === pressed[n]) continue
      pressed[n] = depth[n]
      const { x, z } = spaceCoordinates(n)
      squares.setMatrixAt(n - 1, placed.makeTranslation(at.set(x, TILE_Y - depth[n], z)))
      changed = true
    }
    if (changed) squares.instanceMatrix.needsUpdate = true
    finish.position.y = TILE_Y - depth[100]
  }
  const artwork = canvasTexture(2048, (ctx) => {
    const cell = 204.8
    for (const n of state.board.spaces) {
      const { x, z } = spaceCoordinates(n),
        left = (x + 4.5) * cell,
        top = (z + 4.5) * cell
      ctx.fillStyle = '#34432d'
      ctx.font = '600 51px sans-serif'
      ctx.textAlign = 'left'
      ctx.fillText(String(n), left + 17, top + 54)
      if (n === 100 || n === 1) {
        ctx.font = '700 24px sans-serif'
        ctx.textAlign = 'center'
        ctx.fillStyle = '#715934'
        ctx.fillText(n === 100 ? 'FINISH' : 'START', left + cell / 2, top + 176)
        if (n === 100) {
          ctx.font = '60px serif'
          ctx.fillText('✦', left + cell / 2, top + 124)
        }
      } else if (
        ![...state.board.snakes, ...state.board.ladders].some((r) => r.from === n || r.to === n) &&
        n % 7 === 0
      ) {
        // Original, deliberately quiet botanical line art in the unused corner.
        ctx.save()
        ctx.translate(left + 162, top + 167)
        ctx.strokeStyle = '#78936555'
        ctx.lineWidth = 3
        ctx.beginPath()
        ctx.moveTo(0, 12)
        ctx.quadraticCurveTo(-12, -10, 3, -36)
        ctx.stroke()
        for (let i = 0; i < 3; i++) {
          ctx.beginPath()
          ctx.ellipse(i % 2 ? -12 : 4, -i * 12, 12, 4, i % 2 ? 0.65 : -0.65, 0, Math.PI * 2)
          ctx.stroke()
        }
        ctx.restore()
      }
      const route =
        state.board.ladders.find((r) => r.from === n) || state.board.snakes.find((r) => r.from === n)
      if (route) {
        ctx.textAlign = 'right'
        ctx.font = '600 23px sans-serif'
        ctx.fillStyle = '#516344'
        ctx.fillText(`${route.to > n ? '↗' : '↘'} ${route.to}`, left + 184, top + 183)
      }
    }
  })
  group.add(print(artwork, 10, 10, 0.229))
  const grain = canvasTexture(1024, (ctx) => {
    ctx.strokeStyle = '#2b180b18'
    ctx.lineWidth = 1.5
    for (let i = 0; i < 200; i++) {
      const z = i * 5.2
      ctx.beginPath()
      ctx.moveTo(0, z)
      for (let x = 0; x <= 1024; x += 32) ctx.lineTo(x, z + Math.sin(x * 0.011 + i) * 3)
      ctx.stroke()
    }
  })
  group.add(print(grain, 11, 11, 0.14))
  const studs = new Parts()
  for (const x of [-5.4, 5.4])
    for (const z of [-5.4, 5.4])
      studs.add(new THREE.CylinderGeometry(0.048, 0.048, 0.024, 16), '#d5b46f', (part) =>
        part.position.set(x, 0.15, z),
      )
  group.add(studs.mesh(0.25, 0.8, false))
  const name = canvasTexture(1024, (ctx) => {
    ctx.fillStyle = '#ead5aa'
    ctx.textAlign = 'center'
    ctx.font = '500 64px Georgia'
    ctx.fillText('W I L D R I S E', 512, 530)
  })
  const plaque = print(name, 2.9, 2.9, 0.145)
  plaque.position.z = 5.32
  group.add(plaque)
  return { group, finish, press, dispose: () => squares.dispose() }
}

export function snakeCurve(route: Route) {
  const a = spaceCoordinates(route.from),
    b = spaceCoordinates(route.to)
  const dx = b.x - a.x,
    dz = b.z - a.z,
    length = Math.hypot(dx, dz)
  const points = Array.from({ length: 25 }, (_, i) => {
    const t = i / 24,
      wave = Math.sin(t * Math.PI * 4) * Math.sin(t * Math.PI) * 0.32
    return new THREE.Vector3(
      a.x + dx * t - (dz / length) * wave,
      0.4 + Math.sin(t * Math.PI) * 0.05,
      a.z + dz * t + (dx / length) * wave,
    )
  })
  return new THREE.CatmullRomCurve3(points)
}
/** Where along the body (0 head, 1 tail) each belly stripe sits. */
const STRIPES = Array.from({ length: 22 }, (_, i) => (i + 2) / 25)

/**
 * The body's motion, shared by its vertex shader and the stripes riding on it
 * so the two can never part: a slither that travels head to tail, a swallowed
 * bulge at `bulgeAt`, and the tail's flick at the end of a slide.
 */
export interface SnakeMotion {
  time: number
  wave: number
  bulgeAt: number
  bulge: number
  flick: number
}
export const slither = (along: number, m: SnakeMotion) =>
  Math.sin(along * 18 - m.time * 9) * m.wave * (0.25 + 0.75 * along)
export const bulge = (along: number, m: SnakeMotion) => {
  const d = (along - m.bulgeAt) / 0.07
  return Math.exp(-d * d) * m.bulge
}
export const flick = (along: number, m: SnakeMotion) => {
  const tail = THREE.MathUtils.smoothstep(along, 0.8, 1)
  return tail * tail * m.flick
}

export function makeSnake(route: Route) {
  const group = new THREE.Group(),
    curve = snakeCurve(route)
  const skin = new THREE.MeshPhysicalMaterial({
    color: route.color,
    roughness: 0.3,
    clearcoat: 0.6,
    emissive: route.color,
    emissiveIntensity: 0,
  })
  const motion: SnakeMotion = { time: 0, wave: 0, bulgeAt: -1, bulge: 0, flick: 0 }
  const uniforms = {
    uTime: { value: 0 },
    uWave: { value: 0 },
    uBulgeAt: { value: -1 },
    uBulge: { value: 0 },
    uFlick: { value: 0 },
  }
  const body = skin.clone()
  body.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float aAlong;
        attribute vec3 aSide;
        uniform float uTime, uWave, uBulgeAt, uBulge, uFlick;`,
      )
      .replace(
        '#include <begin_vertex>',
        `vec3 transformed = vec3(position);
        transformed += aSide * sin(aAlong * 18.0 - uTime * 9.0) * uWave * (0.25 + 0.75 * aAlong);
        float bulgeD = (aAlong - uBulgeAt) / 0.07;
        transformed += objectNormal * exp(-bulgeD * bulgeD) * uBulge;
        float tail = smoothstep(0.8, 1.0, aAlong);
        transformed.y += tail * tail * uFlick;`,
      )
  }
  const geometry = new THREE.TubeGeometry(curve, 100, 0.125, 12, false)
  const position = geometry.attributes.position
  const along = new Float32Array(position.count),
    side = new Float32Array(position.count * 3)
  const center = new THREE.Vector3(),
    v = new THREE.Vector3(),
    tangent = new THREE.Vector3()
  for (let i = 0; i <= 100; i++) {
    curve.getPointAt(i / 100, center)
    curve.getTangentAt(i / 100, tangent)
    const taper = 1 - 0.84 * Math.pow(i / 100, 3),
      length = Math.hypot(tangent.x, tangent.z) || 1
    for (let j = 0; j <= 12; j++) {
      const index = i * 13 + j
      v.fromBufferAttribute(position, index).sub(center).multiplyScalar(taper).add(center)
      position.setXYZ(index, v.x, v.y, v.z)
      along[index] = i / 100
      side.set([-tangent.z / length, 0, tangent.x / length], index * 3)
    }
  }
  geometry.setAttribute('aAlong', new THREE.BufferAttribute(along, 1))
  geometry.setAttribute('aSide', new THREE.BufferAttribute(side, 3))
  geometry.computeVertexNormals()
  const mesh = new THREE.Mesh(geometry, body)
  mesh.castShadow = true
  mesh.receiveShadow = true
  group.add(mesh)

  // The head opens: the crown and the chin are hinged at the back of the skull,
  // with a mouth and fangs inside that only show when it does.
  const head = new THREE.Group()
  head.position.copy(curve.getPoint(0))
  head.rotation.order = 'YXZ'
  group.add(head)
  const upper = new THREE.Group(),
    lower = new THREE.Group()
  upper.position.set(0, 0.02, -0.13)
  lower.position.set(0, -0.02, -0.1)
  head.add(upper, lower)
  ball(upper, skin, 0, 0.015, 0.13, 0.21, 0.145, 0.245)
  const eyes = new Parts()
  for (const x of [-0.125, 0.125]) {
    eyes.ball('#fff7db', x, 0.105, 0.215, 0.071)
    eyes.ball('#263c35', x, 0.146, 0.249, 0.029)
    eyes.ball('#ffffff', x - 0.008, 0.159, 0.264, 0.008)
    eyes.add(new THREE.ConeGeometry(0.018, 0.07, 6), '#fffbea', (part) => {
      part.position.set(x * 0.45, -0.075, 0.31)
      part.rotation.x = Math.PI
    })
  }
  upper.add(eyes.mesh(0.28))
  ball(head, '#7c3238', 0, -0.01, 0.06, 0.16, 0.06, 0.18)
  ball(lower, '#f7e7b9', 0, -0.015, 0.2, 0.158, 0.068, 0.15)
  const tongue = new THREE.Group()
  tongue.position.set(0, 0.01, 0.2)
  const fork = new Parts().add(new THREE.BoxGeometry(0.022, 0.01, 0.17), '#c8454f', (part) =>
    part.position.set(0, 0, 0.085),
  )
  for (const x of [-1, 1])
    fork.add(new THREE.BoxGeometry(0.016, 0.009, 0.06), '#c8454f', (part) => {
      part.position.set(x * 0.014, 0, 0.19)
      part.rotation.y = x * 0.45
    })
  tongue.add(fork.mesh(0.4, 0, false))
  tongue.scale.z = 0.01
  tongue.visible = false
  lower.add(tongue)
  curve.getTangent(0, tangent)
  head.rotation.y = Math.atan2(-tangent.x, -tangent.z)
  const forward = new THREE.Vector3(-tangent.x, 0, -tangent.z).normalize()

  // The belly stripes ride the body as it slithers: one instanced mesh, posed
  // per stripe only while this snake is the one in play.
  const stripes = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, 20, 14),
    material('#f2deab', 0.28),
    STRIPES.length,
  )
  stripes.castShadow = true
  stripes.customDepthMaterial = depth.plain
  group.add(stripes)
  const stripe = new THREE.Object3D()
  const bands = STRIPES.map((t, n) => {
    curve.getPointAt(t, center)
    curve.getTangentAt(t, tangent)
    const length = Math.hypot(tangent.x, tangent.z) || 1,
      i = Math.round(t * 25)
    stripe.position.set(center.x, center.y + 0.104 * (1 - i / 35), center.z)
    stripe.scale.set(0.044 * (1 - i / 32), 0.014, 0.047)
    stripe.updateMatrix()
    stripes.setMatrixAt(n, stripe.matrix)
    return {
      along: t,
      base: stripe.position.clone(),
      scale: stripe.scale.clone(),
      side: new THREE.Vector3(-tangent.z / length, 0, tangent.x / length),
    }
  })
  stripes.computeBoundingSphere()
  return {
    group,
    head,
    upper,
    lower,
    tongue,
    forward,
    rest: head.position.clone(),
    skin,
    body,
    curve,
    route,
    motion,
    /** Pushes `motion` to the shader and the stripes; only the snake in play needs it each frame. */
    apply() {
      uniforms.uTime.value = motion.time
      uniforms.uWave.value = motion.wave
      uniforms.uBulgeAt.value = motion.bulgeAt
      uniforms.uBulge.value = motion.bulge
      uniforms.uFlick.value = motion.flick
      bands.forEach((band, n) => {
        stripe.position.copy(band.base).addScaledVector(band.side, slither(band.along, motion))
        stripe.position.y += bulge(band.along, motion) * 0.9 + flick(band.along, motion)
        stripe.scale.copy(band.scale)
        stripe.updateMatrix()
        stripes.setMatrixAt(n, stripe.matrix)
      })
      stripes.instanceMatrix.needsUpdate = true
    },
    dispose: () => stripes.dispose(),
  }
}
export type Snake = ReturnType<typeof makeSnake>

export function ladderPoint(route: Route, t: number, out = new THREE.Vector3()) {
  const a = spaceCoordinates(route.from),
    b = spaceCoordinates(route.to)
  return out.set(a.x + (b.x - a.x) * t, 0.39 + 0.16 * t, a.z + (b.z - a.z) * t)
}
export function makeLadder(route: Route) {
  const group = new THREE.Group(),
    a = ladderPoint(route, 0),
    b = ladderPoint(route, 1)
  const side = new THREE.Vector3(b.z - a.z, 0, -(b.x - a.x)).normalize().multiplyScalar(0.19)
  const wood = new Parts()
  for (const sign of [-1, 1])
    wood.rod(a.clone().addScaledVector(side, sign), b.clone().addScaledVector(side, sign), 0.052, '#bd975d')
  const rungs = Math.ceil(a.distanceTo(b) / 0.31)
  for (let i = 0; i <= rungs; i++) {
    const point = a.clone().lerp(b, i / rungs)
    wood.rod(point.clone().sub(side), point.clone().add(side), 0.041, i % 3 === 0 ? '#ddbc7c' : '#cda466')
  }
  const mesh = wood.mesh(0.35, 0.25)
  mesh.receiveShadow = true
  group.add(mesh)
  /** Climbers step rung to rung, so a climb is counted in these. */
  return { group, route, rungs, yaw: Math.atan2(b.x - a.x, b.z - a.z) }
}
export type Ladder = ReturnType<typeof makeLadder>

export function makeToken(id: PlayerId) {
  const group = new THREE.Group(),
    color = PALETTES[id].color,
    cream = '#fff0ce'
  // One painted figure on a gilt band: two draw calls a token.
  const body = new Parts().add(new THREE.CylinderGeometry(0.21, 0.25, 0.085, 32), color, (part) =>
    part.position.set(0, 0.045, 0),
  )
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.211, 0.018, 8, 32), material('#e8cb87', 0.24, 0.65))
  band.rotation.x = Math.PI / 2
  band.position.y = 0.087
  band.castShadow = true
  group.add(band)
  body.ball(color, 0, 0.27, 0, 0.16, 0.2, 0.135)
  body.ball(cream, 0, 0.26, 0.11, 0.1, 0.14, 0.04)
  body.ball(color, 0, 0.49, 0.012, 0.2, 0.17, 0.15)
  const cone = (
    radius: number,
    height: number,
    sides: number,
    tone: string,
    x: number,
    y: number,
    z: number,
    rx = 0,
    rz = 0,
  ) =>
    body.add(new THREE.ConeGeometry(radius, height, sides), tone, (part) => {
      part.position.set(x, y, z)
      part.rotation.set(rx, 0, rz)
    })
  if (id === 'red') {
    for (const x of [-0.127, 0.127]) {
      cone(0.1, 0.23, 4, color, x, 0.66, 0, 0, -x)
      body.ball(cream, x, 0.63, 0.047, 0.043, 0.065, 0.025)
    }
    body.ball(cream, 0, 0.44, 0.13, 0.133, 0.079, 0.085)
    body.ball(color, 0.17, 0.22, -0.1, 0.1, 0.22, 0.105, 0, -0.6)
    body.ball(cream, 0.25, 0.37, -0.1, 0.065, 0.1, 0.07)
  } else if (id === 'blue') {
    for (const x of [-0.21, 0.21]) body.ball(color, x, 0.29, 0, 0.075, 0.18, 0.11, 0, x)
    for (const x of [-0.088, 0.088]) body.ball(cream, x, 0.51, 0.14, 0.091, 0.098, 0.045)
    cone(0.04, 0.095, 4, '#e8b557', 0, 0.445, 0.2, Math.PI / 2)
    for (const x of [-0.135, 0.135]) cone(0.085, 0.14, 4, color, x, 0.65, 0)
  } else if (id === 'green') {
    for (const x of [-0.085, 0.085]) {
      body.ball(color, x, 0.75, 0, 0.065, 0.22, 0.052, 0, -x)
      body.ball(cream, x, 0.77, 0.044, 0.025, 0.135, 0.014)
    }
    body.ball(cream, 0, 0.42, 0.15, 0.1, 0.062, 0.05)
    body.ball(cream, 0.15, 0.19, -0.09, 0.074)
  } else {
    for (const x of [-0.16, 0.16]) {
      body.ball(color, x, 0.62, 0, 0.091)
      body.ball(cream, x, 0.63, 0.07, 0.042, 0.042, 0.02)
    }
    body.ball(cream, 0, 0.43, 0.145, 0.107, 0.084, 0.057)
    for (const x of [-0.18, 0.18]) body.ball(color, x, 0.27, 0.02, 0.075, 0.11, 0.072)
  }
  for (const x of [-0.082, 0.082]) {
    body.ball('#293c36', x, 0.51, id === 'blue' ? 0.18 : 0.145, 0.026, 0.033, 0.02)
    body.ball('#fffef6', x - 0.007, 0.523, id === 'blue' ? 0.197 : 0.163, 0.008)
  }
  if (id !== 'blue') body.ball('#4d3f33', 0, 0.455, 0.208, 0.032, 0.023, 0.022)
  group.add(body.mesh(0.28))
  return group
}

const PIPS = [
  [],
  [[0, 0]],
  [
    [-1, -1],
    [1, 1],
  ],
  [
    [-1, -1],
    [0, 0],
    [1, 1],
  ],
  [
    [-1, -1],
    [-1, 1],
    [1, -1],
    [1, 1],
  ],
  [
    [-1, -1],
    [-1, 1],
    [0, 0],
    [1, -1],
    [1, 1],
  ],
  [
    [-1, -1],
    [-1, 0],
    [-1, 1],
    [1, -1],
    [1, 0],
    [1, 1],
  ],
]
export function makeDie() {
  const group = new THREE.Group(),
    body = box(0.86, 0.86, 0.86, '#fff6dd', 0.11)
  body.material = new THREE.MeshPhysicalMaterial({ color: '#fff6dd', roughness: 0.24, clearcoat: 0.65 })
  group.add(body)
  const faces = [
    { n: 1, p: [0, 0.431, 0], r: [-Math.PI / 2, 0, 0] },
    { n: 6, p: [0, -0.431, 0], r: [Math.PI / 2, 0, 0] },
    { n: 2, p: [0, 0, 0.431], r: [0, 0, 0] },
    { n: 5, p: [0, 0, -0.431], r: [0, Math.PI, 0] },
    { n: 3, p: [0.431, 0, 0], r: [0, Math.PI / 2, 0] },
    { n: 4, p: [-0.431, 0, 0], r: [0, -Math.PI / 2, 0] },
  ]
  const pips = new Parts()
  faces.forEach(({ n, p, r }) =>
    PIPS[n].forEach(([x, y]) =>
      pips.add(new THREE.CircleGeometry(0.061, 20), n === 1 ? '#c37350' : '#475448', (part) => {
        part.rotation.set(r[0], r[1], r[2])
        part.position
          .set(x * 0.21, y * 0.21, 0)
          .applyEuler(part.rotation)
          .add({ x: p[0], y: p[1], z: p[2] })
      }),
    ),
  )
  group.add(pips.mesh(0.48, 0, false))
  group.userData.die = true
  return group
}
/** The orientation that shows `n` on top, made once per face rather than per frame. */
const FACES = [
  [0, 0, 0],
  [0, 0, 0],
  [-Math.PI / 2, 0, 0],
  [0, 0, Math.PI / 2],
  [0, 0, -Math.PI / 2],
  [Math.PI / 2, 0, 0],
  [Math.PI, 0, 0],
].map(([x, y, z]) =>
  new THREE.Quaternion()
    .setFromEuler(new THREE.Euler(x, y, z))
    .premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.15)),
)
export const dieQuaternion = (n: number) => FACES[n] ?? FACES[1]

export function makePlant(x: number, z: number, size = 1) {
  const group = new THREE.Group()
  group.position.set(x, -0.55, z)
  group.scale.setScalar(size)
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.37, 0.26, 0.52, 32), material('#b2795e'))
  pot.position.y = 0.26
  pot.castShadow = true
  group.add(pot)
  // The leaves hang from a crown at the soil so they can sway as one.
  const crown = new THREE.Group()
  crown.position.y = 0.5
  group.add(crown)
  const leaves = new Parts()
  for (let i = 0; i < 7; i++) {
    const angle = i * 2.4
    leaves.ball(
      i % 2 ? '#5f7850' : '#79916b',
      Math.cos(angle) * 0.26,
      0.35 + (i % 3) * 0.1,
      Math.sin(angle) * 0.26,
      0.15,
      0.48,
      0.095,
      Math.sin(angle) * 0.7,
      Math.cos(angle) * -0.7,
    )
  }
  crown.add(leaves.mesh(0.28))
  return { group, crown }
}
