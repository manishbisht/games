import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import type { BoardSpace, Player } from '@games/shared/estate/types'

export function material(color: string, metalness = 0, roughness = 0.65) {
  return new THREE.MeshStandardMaterial({ color, metalness, roughness })
}
/** A rounded slab. Pass `surface` to share a material instead of minting one per box. */
export function box(
  w: number,
  h: number,
  d: number,
  color: string,
  radius = 0.04,
  surface: THREE.Material = material(color),
) {
  const mesh = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 2, radius), surface)
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}
export function boardPosition(id: number): [number, number] {
  if (id === 0) return [5.05, 5.05]
  if (id === 10) return [-5.05, 5.05]
  if (id === 20) return [-5.05, -5.05]
  if (id === 30) return [5.05, -5.05]
  const side = Math.floor(id / 10),
    step = id % 10
  if (side === 0) return [4.75 - step * 0.95, 5.05]
  if (side === 1) return [-5.05, 4.75 - step * 0.95]
  if (side === 2) return [-4.75 + step * 0.95, -5.05]
  return [5.05, -4.75 + step * 0.95]
}
function texture(canvas: HTMLCanvasElement) {
  const map = new THREE.CanvasTexture(canvas)
  map.colorSpace = THREE.SRGBColorSpace
  map.anisotropy = 8
  return map
}
export function canvasTexture(width: number, height: number, draw: (ctx: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  draw(ctx)
  return texture(canvas)
}
export function wrap(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  line: number,
) {
  const words = text.split(' '),
    lines: string[] = []
  let current = ''
  words.forEach((word) => {
    const next = current ? `${current} ${word}` : word
    if (ctx.measureText(next).width > maxWidth && current) {
      lines.push(current)
      current = word
    } else current = next
  })
  lines.push(current)
  lines.forEach((l, i) => ctx.fillText(l, x, y + i * line))
}
export function tileTexture(space: BoardSpace) {
  const corner = space.id % 10 === 0
  return canvasTexture(corner ? 384 : 256, 384, (ctx) => {
    const w = corner ? 384 : 256
    ctx.fillStyle = '#e2d8bd'
    ctx.fillRect(0, 0, w, 384)
    ctx.textAlign = 'center'
    ctx.fillStyle = '#344246'
    if (space.kind === 'property') {
      ctx.fillStyle = space.color!
      ctx.fillRect(0, 0, w, 78)
      ctx.fillStyle = '#f9f6ea'
      ctx.globalAlpha = 0.15
      ctx.fillRect(0, 73, w, 4)
      ctx.globalAlpha = 1
      ctx.fillStyle = '#263a32'
      ctx.font = '600 31px Arial'
      wrap(ctx, space.name.toUpperCase(), w / 2, 132, w - 18, 37)
      ctx.font = '500 31px Arial'
      ctx.fillStyle = '#536159'
      ctx.fillText(`$${space.price}`, w / 2, 305)
      ctx.strokeStyle = '#34424625'
      ctx.beginPath()
      ctx.moveTo(85, 239)
      ctx.lineTo(171, 239)
      ctx.stroke()
    } else {
      let icon = '',
        color = '#536864'
      if (space.kind === 'chance') {
        icon = '?'
        color = '#a85c22'
      }
      if (space.kind === 'chest') {
        icon = '▱'
        color = '#39768a'
      }
      if (space.kind === 'utility') {
        icon = space.id === 12 ? 'ϟ' : '◈'
        color = space.id === 12 ? '#9c7417' : '#2d7499'
      }
      if (space.kind === 'tax') {
        icon = '◇'
        color = '#78577e'
      }
      if (space.kind === 'railroad') icon = '▤'
      if (space.kind === 'go') {
        icon = 'GO'
        color = '#b34835'
      }
      if (space.kind === 'jail') {
        icon = '▥'
        color = '#9b602e'
      }
      if (space.kind === 'parking') {
        icon = 'P'
        color = '#456941'
      }
      if (space.kind === 'go-to-jail') {
        icon = '↗'
        color = '#3b607f'
      }
      ctx.fillStyle = color
      ctx.font = `${corner ? '800' : '600'} ${corner ? 116 : 116}px Arial`
      ctx.fillText(icon, w / 2, corner ? 185 : 164)
      ctx.fillStyle = '#485651'
      ctx.font = `600 ${corner ? 26 : 25}px Arial`
      wrap(
        ctx,
        space.kind === 'go' ? 'COLLECT $200' : space.name.toUpperCase(),
        w / 2,
        corner ? 252 : 236,
        w - 25,
        32,
      )
      if (space.kind === 'go') {
        ctx.font = '500 62px Arial'
        ctx.fillStyle = '#ce775e'
        ctx.fillText('←', w / 2, 329)
      } else if (space.price || space.amount) {
        ctx.font = '500 25px Arial'
        ctx.fillStyle = '#68746e'
        ctx.fillText(`$${space.price || space.amount}`, w / 2, 338)
      }
    }
  })
}
/**
 * A player's piece: an outer group the scene moves and turns, and an inner
 * `body` it squashes, tilts and topples, so a hop's squash never fights the
 * walk's yaw. `facing` is the model's own forward, which the car has along x.
 */
export function makeToken(token: Player['token'], color: string) {
  const group = new THREE.Group(),
    body = new THREE.Group(),
    metal = material(color, 0.38, 0.29),
    dark = material('#3a424b', 0.2, 0.3)
  group.add(body)
  const add = (geo: THREE.BufferGeometry, y: number, mat = metal) => {
    const m = new THREE.Mesh(geo, mat)
    m.position.y = y
    m.castShadow = true
    m.receiveShadow = true
    body.add(m)
    return m
  }
  add(new THREE.CylinderGeometry(0.23, 0.28, 0.085, 32), 0.045)
  add(new THREE.TorusGeometry(0.232, 0.022, 8, 32), 0.09).rotation.x = Math.PI / 2
  if (token === 'rocket') {
    add(new THREE.CapsuleGeometry(0.13, 0.32, 6, 16), 0.42)
    add(new THREE.ConeGeometry(0.13, 0.21, 24), 0.77)
    for (let i = 0; i < 3; i++) {
      const fin = add(new THREE.ConeGeometry(0.11, 0.3, 3), 0.23)
      fin.position.x = Math.cos(i * 2.094) * 0.16
      fin.position.z = Math.sin(i * 2.094) * 0.16
      fin.rotation.y = -i * 2.094
    }
    const window = add(new THREE.SphereGeometry(0.069, 16, 12), 0.49, dark)
    window.position.z = 0.115
    window.scale.z = 0.25
  } else if (token === 'gem') {
    add(new THREE.CylinderGeometry(0.09, 0.14, 0.18, 16), 0.17)
    const gem = add(new THREE.OctahedronGeometry(0.3), 0.49)
    gem.scale.y = 1.2
    gem.rotation.y = Math.PI / 4
  } else if (token === 'car') {
    const chassis = box(0.55, 0.17, 0.27, color, 0.05, metal)
    chassis.position.y = 0.24
    body.add(chassis)
    const cab = box(0.29, 0.16, 0.25, color, 0.05, metal)
    cab.position.set(-0.035, 0.36, 0)
    body.add(cab)
    for (const x of [-0.18, 0.18])
      for (const z of [-0.15, 0.15]) {
        const wheel = add(new THREE.CylinderGeometry(0.085, 0.085, 0.045, 16), 0.19, dark)
        wheel.rotation.x = Math.PI / 2
        wheel.position.x = x
        wheel.position.z = z
      }
  } else {
    add(new THREE.CylinderGeometry(0.2, 0.16, 0.24, 32), 0.3)
    add(new THREE.TorusGeometry(0.185, 0.028, 8, 32), 0.21).rotation.x = Math.PI / 2
    for (let i = 0; i < 5; i++) {
      const x = Math.cos((i * Math.PI * 2) / 5) * 0.165,
        z = Math.sin((i * Math.PI * 2) / 5) * 0.165
      const spike = add(new THREE.ConeGeometry(0.08, 0.22, 4), 0.49)
      spike.position.x = x
      spike.position.z = z
      const bead = add(new THREE.SphereGeometry(0.045, 12, 8), 0.61)
      bead.position.x = x
      bead.position.z = z
    }
  }
  return { group, body, materials: [metal, dark], facing: token === 'car' ? Math.PI / 2 : 0 }
}
export type TokenModel = ReturnType<typeof makeToken>
const pipLayout: [number, number][][] = [
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
/** A die: one body and one instanced mesh for all 21 of its pips. */
export function makeDie() {
  const group = new THREE.Group()
  const body = box(0.64, 0.64, 0.64, '#fff9ec', 0.095, material('#fff9ec', 0.05, 0.26))
  group.add(body)
  const faceData = [
    { value: 1, pos: [0, 0.322, 0], rot: [-Math.PI / 2, 0, 0] },
    { value: 6, pos: [0, -0.322, 0], rot: [Math.PI / 2, 0, 0] },
    { value: 2, pos: [0, 0, 0.322], rot: [0, 0, 0] },
    { value: 5, pos: [0, 0, -0.322], rot: [0, Math.PI, 0] },
    { value: 3, pos: [0.322, 0, 0], rot: [0, Math.PI / 2, 0] },
    { value: 4, pos: [-0.322, 0, 0], rot: [0, -Math.PI / 2, 0] },
  ]
  const pips = new THREE.InstancedMesh(
    new THREE.CircleGeometry(0.052, 16),
    new THREE.MeshBasicMaterial({ color: '#27333b' }),
    21,
  )
  const holder = new THREE.Object3D()
  let n = 0
  faceData.forEach((face) => {
    holder.position.set(...(face.pos as [number, number, number]))
    holder.rotation.set(...(face.rot as [number, number, number]))
    holder.updateMatrix()
    pipLayout[face.value].forEach(([x, y]) => {
      const pip = new THREE.Matrix4().makeTranslation(x * 0.16, y * 0.16, 0.001)
      pips.setMatrixAt(n++, pip.premultiply(holder.matrix))
    })
  })
  group.add(pips)
  return group
}
export function dieRotation(value: number, twist = 0) {
  const eulers = [
    [0, 0, 0],
    [0, 0, 0],
    [-Math.PI / 2, 0, 0],
    [0, 0, Math.PI / 2],
    [0, 0, -Math.PI / 2],
    [Math.PI / 2, 0, 0],
    [Math.PI, 0, 0],
  ]
  const [x, y, z] = eulers[value]
  return new THREE.Quaternion()
    .setFromEuler(new THREE.Euler(x, y, z))
    .premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), twist))
}
/**
 * The pieces a deed grows: one geometry and one material per kind, shared by
 * every house and hotel on the board, so building never allocates more than an
 * Object3D. `dispose` frees them once the scene is done.
 */
export function createLotKit() {
  const houseBody = new RoundedBoxGeometry(0.23, 0.2, 0.26, 2, 0.02),
    hotelBody = new RoundedBoxGeometry(0.4, 0.28, 0.26, 2, 0.02),
    houseRoof = new THREE.CylinderGeometry(0.21, 0.21, 0.27, 3),
    hotelRoof = new THREE.CylinderGeometry(0.21, 0.21, 0.44, 3),
    marker = new RoundedBoxGeometry(0.64, 0.045, 0.13, 2, 0.025),
    green = material('#5b937d'),
    greenRoof = material('#356554'),
    red = material('#c26d57'),
    redRoof = material('#884635')
  function build(hotel: boolean) {
    const group = new THREE.Group(),
      h = hotel ? 0.28 : 0.2
    const body = new THREE.Mesh(hotel ? hotelBody : houseBody, hotel ? red : green)
    body.position.y = h / 2
    body.castShadow = true
    body.receiveShadow = true
    group.add(body)
    const roof = new THREE.Mesh(hotel ? hotelRoof : houseRoof, hotel ? redRoof : greenRoof)
    roof.rotation.z = Math.PI / 2
    roof.rotation.y = Math.PI / 2
    roof.position.y = h
    roof.castShadow = true
    group.add(roof)
    return group
  }
  return {
    house: () => build(false),
    hotel: () => build(true),
    marker: (color: string) => {
      const mesh = new THREE.Mesh(marker, material(color))
      mesh.castShadow = true
      mesh.receiveShadow = true
      return mesh
    },
    dispose() {
      for (const resource of [
        houseBody,
        hotelBody,
        houseRoof,
        hotelRoof,
        marker,
        green,
        greenRoof,
        red,
        redRoof,
      ])
        resource.dispose()
    },
  }
}
export type LotKit = ReturnType<typeof createLotKit>

/**
 * The cell in the jail corner: a low iron cage in the square's inner quarter,
 * leaving the outer edges for anyone just visiting. One instanced mesh holds
 * every bar.
 */
export function makeJailCell(size: number) {
  const group = new THREE.Group(),
    iron = material('#3b434b', 0.55, 0.38),
    height = 0.56,
    perSide = 5
  const bars = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.016, 0.016, height, 6), iron, perSide * 4)
  bars.castShadow = true
  const m = new THREE.Matrix4()
  let n = 0
  for (let side = 0; side < 4; side++)
    for (let i = 0; i < perSide; i++) {
      const along = -size / 2 + (size / perSide) * (i + 0.5),
        edge = size / 2
      const [x, z] =
        side === 0
          ? [along, edge]
          : side === 1
            ? [edge, -along]
            : side === 2
              ? [-along, -edge]
              : [-edge, along]
      bars.setMatrixAt(n++, m.makeTranslation(x, height / 2, z))
    }
  group.add(bars)
  const rail = new RoundedBoxGeometry(size + 0.05, 0.04, 0.05, 1, 0.012)
  for (let side = 0; side < 4; side++) {
    const top = new THREE.Mesh(rail, iron)
    top.position.y = height
    top.rotation.y = (side * Math.PI) / 2
    top.translateZ(size / 2)
    top.castShadow = true
    group.add(top)
  }
  return group
}
