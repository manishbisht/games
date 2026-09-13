import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
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
  parent: THREE.Group,
  color: string,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy = sx,
  sz = sx,
) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), material(color, 0.28))
  mesh.position.set(x, y, z)
  mesh.scale.set(sx, sy, sz)
  mesh.castShadow = true
  parent.add(mesh)
  return mesh
}
function rod(a: THREE.Vector3, b: THREE.Vector3, radius: number, color: string) {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(radius, radius, a.distanceTo(b), 12),
    material(color, 0.35, 0.25),
  )
  mesh.position.copy(a).add(b).multiplyScalar(0.5)
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize())
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
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
  for (const n of state.board.spaces) {
    const { x, z } = spaceCoordinates(n)
    const row = Math.floor((n - 1) / 10),
      column = (n - 1) % 10
    const snake = state.board.snakes.some((r) => r.from === n)
    const ladder = state.board.ladders.some((r) => r.from === n)
    const color =
      n === 100 ? '#e8c775' : snake ? '#edcec0' : ladder ? '#c9ddbf' : tileColors[(row + column) % 4]
    const tile = box(0.976, 0.075, 0.976, color, 0.035)
    tile.position.set(x, 0.187, z)
    group.add(tile)
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
  for (const x of [-5.4, 5.4])
    for (const z of [-5.4, 5.4]) {
      const stud = new THREE.Mesh(
        new THREE.CylinderGeometry(0.048, 0.048, 0.024, 16),
        material('#d5b46f', 0.25, 0.8),
      )
      stud.position.set(x, 0.15, z)
      group.add(stud)
    }
  const name = canvasTexture(1024, (ctx) => {
    ctx.fillStyle = '#ead5aa'
    ctx.textAlign = 'center'
    ctx.font = '500 64px Georgia'
    ctx.fillText('W I L D R I S E', 512, 530)
  })
  const plaque = print(name, 2.9, 2.9, 0.145)
  plaque.position.z = 5.32
  group.add(plaque)
  return group
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
  const geometry = new THREE.TubeGeometry(curve, 100, 0.125, 12, false)
  const position = geometry.attributes.position
  for (let i = 0; i <= 100; i++) {
    const center = curve.getPointAt(i / 100),
      taper = 1 - 0.84 * Math.pow(i / 100, 3)
    for (let j = 0; j <= 12; j++) {
      const index = i * 13 + j
      const v = new THREE.Vector3()
        .fromBufferAttribute(position, index)
        .sub(center)
        .multiplyScalar(taper)
        .add(center)
      position.setXYZ(index, v.x, v.y, v.z)
    }
  }
  geometry.computeVertexNormals()
  const body = new THREE.Mesh(geometry, skin)
  body.castShadow = true
  body.receiveShadow = true
  group.add(body)
  const head = new THREE.Group()
  head.position.copy(curve.getPoint(0))
  group.add(head)
  const face = ball(head, route.color, 0, 0.035, 0, 0.21, 0.145, 0.245)
  face.material = skin
  ball(head, '#f7e7b9', 0, -0.035, 0.1, 0.158, 0.068, 0.15)
  for (const x of [-0.125, 0.125]) {
    ball(head, '#fff7db', x, 0.125, 0.085, 0.071)
    ball(head, '#263c35', x, 0.166, 0.119, 0.029)
    ball(head, '#ffffff', x - 0.008, 0.179, 0.134, 0.008)
  }
  const tangent = curve.getTangent(0)
  head.rotation.y = Math.atan2(-tangent.x, -tangent.z)
  for (let i = 2; i < 24; i++) {
    const p = curve.getPointAt(i / 25)
    ball(group, '#f2deab', p.x, p.y + 0.104 * (1 - i / 35), p.z, 0.044 * (1 - i / 32), 0.014, 0.047)
  }
  return { group, head, skin, curve, route }
}
export function ladderPoint(route: Route, t: number) {
  const a = spaceCoordinates(route.from),
    b = spaceCoordinates(route.to)
  return new THREE.Vector3(a.x + (b.x - a.x) * t, 0.39 + 0.16 * t, a.z + (b.z - a.z) * t)
}
export function makeLadder(route: Route) {
  const group = new THREE.Group(),
    a = ladderPoint(route, 0),
    b = ladderPoint(route, 1)
  const side = new THREE.Vector3(b.z - a.z, 0, -(b.x - a.x)).normalize().multiplyScalar(0.19)
  for (const sign of [-1, 1])
    group.add(
      rod(a.clone().addScaledVector(side, sign), b.clone().addScaledVector(side, sign), 0.052, '#bd975d'),
    )
  const count = Math.ceil(a.distanceTo(b) / 0.31)
  for (let i = 0; i <= count; i++) {
    const point = a.clone().lerp(b, i / count)
    group.add(
      rod(point.clone().sub(side), point.clone().add(side), 0.041, i % 3 === 0 ? '#ddbc7c' : '#cda466'),
    )
  }
  return { group, route }
}

export function makeToken(id: PlayerId) {
  const group = new THREE.Group(),
    color = PALETTES[id].color,
    cream = '#fff0ce'
  const base = new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.25, 0.085, 32), material(color, 0.25))
  base.position.y = 0.045
  base.castShadow = true
  group.add(base)
  const band = new THREE.Mesh(new THREE.TorusGeometry(0.211, 0.018, 8, 32), material('#e8cb87', 0.24, 0.65))
  band.rotation.x = Math.PI / 2
  band.position.y = 0.087
  group.add(band)
  ball(group, color, 0, 0.27, 0, 0.16, 0.2, 0.135)
  ball(group, cream, 0, 0.26, 0.11, 0.1, 0.14, 0.04)
  ball(group, color, 0, 0.49, 0.012, 0.2, 0.17, 0.15)
  if (id === 'red') {
    for (const x of [-0.127, 0.127]) {
      const ear = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.23, 4), material(color, 0.3))
      ear.position.set(x, 0.66, 0)
      ear.rotation.z = -x
      group.add(ear)
      ball(group, cream, x, 0.63, 0.047, 0.043, 0.065, 0.025)
    }
    ball(group, cream, 0, 0.44, 0.13, 0.133, 0.079, 0.085)
    const tail = ball(group, color, 0.17, 0.22, -0.1, 0.1, 0.22, 0.105)
    tail.rotation.z = -0.6
    ball(group, cream, 0.25, 0.37, -0.1, 0.065, 0.1, 0.07)
  } else if (id === 'blue') {
    for (const x of [-0.21, 0.21]) {
      const wing = ball(group, color, x, 0.29, 0, 0.075, 0.18, 0.11)
      wing.rotation.z = x
    }
    for (const x of [-0.088, 0.088]) ball(group, cream, x, 0.51, 0.14, 0.091, 0.098, 0.045)
    const beak = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.095, 4), material('#e8b557'))
    beak.position.set(0, 0.445, 0.2)
    beak.rotation.x = Math.PI / 2
    group.add(beak)
    for (const x of [-0.135, 0.135]) {
      const tuft = new THREE.Mesh(new THREE.ConeGeometry(0.085, 0.14, 4), material(color))
      tuft.position.set(x, 0.65, 0)
      group.add(tuft)
    }
  } else if (id === 'green') {
    for (const x of [-0.085, 0.085]) {
      const ear = ball(group, color, x, 0.75, 0, 0.065, 0.22, 0.052)
      ear.rotation.z = -x
      ball(group, cream, x, 0.77, 0.044, 0.025, 0.135, 0.014)
    }
    ball(group, cream, 0, 0.42, 0.15, 0.1, 0.062, 0.05)
    ball(group, cream, 0.15, 0.19, -0.09, 0.074)
  } else {
    for (const x of [-0.16, 0.16]) {
      ball(group, color, x, 0.62, 0, 0.091)
      ball(group, cream, x, 0.63, 0.07, 0.042, 0.042, 0.02)
    }
    ball(group, cream, 0, 0.43, 0.145, 0.107, 0.084, 0.057)
    for (const x of [-0.18, 0.18]) ball(group, color, x, 0.27, 0.02, 0.075, 0.11, 0.072)
  }
  for (const x of [-0.082, 0.082]) {
    ball(group, '#293c36', x, 0.51, id === 'blue' ? 0.18 : 0.145, 0.026, 0.033, 0.02)
    ball(group, '#fffef6', x - 0.007, 0.523, id === 'blue' ? 0.197 : 0.163, 0.008)
  }
  if (id !== 'blue') ball(group, '#4d3f33', 0, 0.455, 0.208, 0.032, 0.023, 0.022)
  group.traverse((object) => {
    if (object instanceof THREE.Mesh) object.castShadow = true
  })
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
  faces.forEach(({ n, p, r }) => {
    const face = new THREE.Group()
    face.position.set(p[0], p[1], p[2])
    face.rotation.set(r[0], r[1], r[2])
    PIPS[n].forEach(([x, y]) => {
      const pip = new THREE.Mesh(
        new THREE.CircleGeometry(0.061, 20),
        material(n === 1 ? '#c37350' : '#475448'),
      )
      pip.position.set(x * 0.21, y * 0.21, 0)
      face.add(pip)
    })
    group.add(face)
  })
  group.userData.die = true
  return group
}
export function dieQuaternion(n: number) {
  const angles = [
    [0, 0, 0],
    [0, 0, 0],
    [-Math.PI / 2, 0, 0],
    [0, 0, Math.PI / 2],
    [0, 0, -Math.PI / 2],
    [Math.PI / 2, 0, 0],
    [Math.PI, 0, 0],
  ][n]
  return new THREE.Quaternion()
    .setFromEuler(new THREE.Euler(...(angles as [number, number, number])))
    .premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.15))
}

export function makePlant(x: number, z: number, size = 1) {
  const group = new THREE.Group()
  group.position.set(x, -0.55, z)
  group.scale.setScalar(size)
  const pot = new THREE.Mesh(new THREE.CylinderGeometry(0.37, 0.26, 0.52, 32), material('#b2795e'))
  pot.position.y = 0.26
  pot.castShadow = true
  group.add(pot)
  for (let i = 0; i < 7; i++) {
    const angle = i * 2.4,
      leaf = ball(
        group,
        i % 2 ? '#5f7850' : '#79916b',
        Math.cos(angle) * 0.26,
        0.85 + (i % 3) * 0.1,
        Math.sin(angle) * 0.26,
        0.15,
        0.48,
        0.095,
      )
    leaf.rotation.z = Math.cos(angle) * -0.7
    leaf.rotation.x = Math.sin(angle) * 0.7
  }
  return group
}
