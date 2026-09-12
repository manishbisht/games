import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import {
  COURTS,
  ENTRIES,
  PALETTES,
  piecePosition,
  PLAYER_IDS,
  SAFE_SPACES,
  trackPosition,
} from '@games/shared/hearth/board'
import type { PlayerId } from '@games/shared/hearth/types'

export function material(color: string, metalness = 0, roughness = 0.55) {
  return new THREE.MeshStandardMaterial({ color, metalness, roughness })
}
export function roundedBox(w: number, h: number, d: number, color: string, radius = 0.05) {
  const mesh = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, radius), material(color))
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}
export function canvasMap(size: number, draw: (ctx: CanvasRenderingContext2D) => void) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  draw(canvas.getContext('2d')!)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 8
  return texture
}
function printPlane(map: THREE.Texture, width: number, depth: number, x: number, y: number, z: number) {
  const plane = new THREE.Mesh(
    new THREE.PlaneGeometry(width, depth),
    new THREE.MeshStandardMaterial({ map, transparent: true, roughness: 0.82, depthWrite: false }),
  )
  plane.rotation.x = -Math.PI / 2
  plane.position.set(x, y, z)
  return plane
}
function ring(radius: number, tube: number, color: string) {
  const mesh = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 8, 64), material(color, 0.55, 0.32))
  mesh.rotation.x = -Math.PI / 2
  return mesh
}
function star(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number) {
  ctx.beginPath()
  for (let i = 0; i < 10; i++) {
    const angle = (i * Math.PI) / 5 - Math.PI / 2,
      r = i % 2 ? radius * 0.46 : radius
    const px = x + Math.cos(angle) * r,
      py = y + Math.sin(angle) * r
    if (!i) ctx.moveTo(px, py)
    else ctx.lineTo(px, py)
  }
  ctx.closePath()
  ctx.fill()
}

export function makeBoard() {
  const board = new THREE.Group()
  const wood = canvasMap(1024, (ctx) => {
    ctx.fillStyle = '#3b2b24'
    ctx.fillRect(0, 0, 1024, 1024)
    for (let i = 0; i < 680; i++) {
      ctx.strokeStyle = `rgba(${i % 3 === 0 ? '12,7,4' : '143,105,72'},${0.07 + Math.sin(i * 7.3) ** 2 * 0.09})`
      ctx.lineWidth = 0.7 + Math.sin(i * 3.4) ** 2 * 2
      ctx.beginPath()
      for (let x = 0; x <= 1024; x += 16) {
        const y = i * 1.53 + Math.sin(x * 0.006 + i * 0.075) * 5 + Math.sin(x * 0.016 + i * 0.017) * 2
        if (!x) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
  })
  const table = roundedBox(13.6, 0.52, 13.6, '#ffffff', 0.2)
  table.material = new THREE.MeshStandardMaterial({ map: wood, roughness: 0.48, metalness: 0.04 })
  table.position.y = -0.42
  board.add(table)
  const brassRim = roundedBox(12.65, 0.15, 12.65, '#b49a67', 0.16)
  brassRim.position.y = -0.11
  board.add(brassRim)
  const base = roundedBox(12.56, 0.28, 12.56, '#e9ddc4', 0.14)
  base.position.y = 0.03
  board.add(base)
  const surface = roundedBox(12.32, 0.06, 12.32, '#f4ecd9', 0.13)
  surface.position.y = 0.18
  board.add(surface)

  const artwork = canvasMap(2048, (ctx) => {
    ctx.strokeStyle = '#baa780'
    ctx.lineWidth = 2
    ctx.strokeRect(31, 31, 1986, 1986)
    ctx.strokeStyle = '#d0c3a2'
    ctx.lineWidth = 1
    ctx.strokeRect(40, 40, 1968, 1968)
    for (const [x, y] of [
      [73, 73],
      [1975, 73],
      [73, 1975],
      [1975, 1975],
    ]) {
      ctx.fillStyle = '#b79b60'
      star(ctx, x, y, 15)
    }
    ctx.textAlign = 'center'
    ctx.fillStyle = '#9c8d6e'
    ctx.font = '500 16px Georgia'
    ctx.fillText('H E A R T H   &   H O M E', 1024, 2002)
    ctx.save()
    ctx.translate(1024, 46)
    ctx.rotate(Math.PI)
    ctx.fillText('A   L I T T L E   L U C K .   A   L O N G   W A Y   H O M E .', 0, 0)
    ctx.restore()
  })
  board.add(printPlane(artwork, 12.32, 12.32, 0, 0.214, 0))

  const tiles: THREE.Mesh[] = []
  for (let i = 0; i < 52; i++) {
    const [x, z] = trackPosition(i)
    const owner = PLAYER_IDS.find((id) => ENTRIES[id] === i)
    const safe = SAFE_SPACES.has(i)
    const tile = roundedBox(
      0.735,
      0.105,
      0.735,
      owner ? PALETTES[owner].color : safe ? '#ddd0aa' : '#fcf7e9',
      0.05,
    )
    tile.position.set(x, 0.267, z)
    board.add(tile)
    tiles.push(tile)
    const tileArt = canvasMap(128, (ctx) => {
      ctx.fillStyle = owner ? '#fff4dc' : '#ae9562'
      if (safe) star(ctx, 64, 64, 27)
      else {
        ctx.globalAlpha = 0.6
        ctx.beginPath()
        ctx.arc(64, 64, 3.5, 0, Math.PI * 2)
        ctx.fill()
      }
    })
    board.add(printPlane(tileArt, 0.67, 0.67, x, 0.324, z))
  }

  PLAYER_IDS.forEach((id, playerIndex) => {
    const [x, z] = COURTS[id],
      palette = PALETTES[id]
    const border = roundedBox(3.63, 0.06, 3.63, palette.color, 0.22)
    border.position.set(x, 0.247, z)
    board.add(border)
    const court = roundedBox(3.48, 0.085, 3.48, palette.light, 0.18)
    court.position.set(x, 0.288, z)
    board.add(court)
    const courtArt = canvasMap(512, (ctx) => {
      ctx.strokeStyle = palette.color + '40'
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.roundRect(15, 15, 482, 482, 30)
      ctx.stroke()
      ctx.fillStyle = palette.dark
      ctx.textAlign = 'center'
      ctx.font = '500 19px Georgia'
      ctx.fillText(palette.court.toUpperCase(), 256, 54)
      ctx.fillStyle = palette.color
      ctx.font = '13px Arial'
      ctx.fillText('T H E   N E S T', 256, 480)
      // The foliage is original line art, generated directly on the board.
      for (const side of [-1, 1]) {
        ctx.save()
        ctx.translate(256 + side * 208, 270)
        ctx.scale(side, 1)
        ctx.strokeStyle = palette.color + '60'
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(0, 90)
        ctx.quadraticCurveTo(18, 0, 0, -90)
        ctx.stroke()
        for (let y = -60; y <= 60; y += 30) {
          ctx.beginPath()
          ctx.ellipse(7, y, 5, 13, -0.6, 0, Math.PI * 2)
          ctx.stroke()
        }
        ctx.restore()
      }
    })
    board.add(printPlane(courtArt, 3.44, 3.44, x, 0.334, z))
    for (let index = 0; index < 4; index++) {
      const [px, pz] = piecePosition({ id: `${id}-${index}`, playerId: id, index, progress: -1 })
      const socket = new THREE.Mesh(
        new THREE.CylinderGeometry(0.39, 0.41, 0.035, 48),
        material(palette.color, 0.05, 0.7),
      )
      socket.position.set(px, 0.35, pz)
      socket.receiveShadow = true
      board.add(socket)
      const inner = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.33, 0.039, 48), material(palette.light))
      inner.position.set(px, 0.356, pz)
      inner.receiveShadow = true
      board.add(inner)
      const rim = ring(0.37, 0.011, palette.dark)
      rim.position.set(px, 0.373, pz)
      board.add(rim)
    }
    for (let step = 52; step < 57; step++) {
      const [px, pz] = piecePosition({ id: '', playerId: id, index: 0, progress: step })
      const tile = roundedBox(0.63, 0.11, 0.63, palette.light, 0.055)
      tile.position.set(px, 0.267, pz)
      board.add(tile)
      const pathArt = canvasMap(128, (ctx) => {
        ctx.strokeStyle = palette.color
        ctx.lineWidth = 7
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.translate(64, 64)
        ctx.rotate((-playerIndex * Math.PI) / 2)
        ctx.beginPath()
        ctx.moveTo(-15, 8)
        ctx.lineTo(0, -7)
        ctx.lineTo(15, 8)
        ctx.stroke()
      })
      board.add(printPlane(pathArt, 0.53, 0.53, px, 0.328, pz))
    }
  })
  const centerBase = new THREE.Mesh(
    new THREE.CylinderGeometry(0.76, 0.81, 0.16, 64),
    material('#bea26e', 0.6, 0.3),
  )
  centerBase.position.y = 0.28
  centerBase.castShadow = true
  board.add(centerBase)
  const center = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.73, 0.11, 64), material('#f3e7ca'))
  center.position.y = 0.38
  center.receiveShadow = true
  board.add(center)
  const centerArt = canvasMap(256, (ctx) => {
    ctx.fillStyle = '#a0864e'
    star(ctx, 128, 105, 34)
    ctx.font = '600 20px Georgia'
    ctx.textAlign = 'center'
    ctx.fillText('HOME', 128, 170)
    ctx.strokeStyle = '#b7a272'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(128, 128, 112, 0, Math.PI * 2)
    ctx.stroke()
  })
  board.add(printPlane(centerArt, 1.35, 1.35, 0, 0.44, 0))

  // Brass corner studs and small rubber feet give the table a tangible edge.
  for (const x of [-6.5, 6.5])
    for (const z of [-6.5, 6.5]) {
      const stud = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 8), material('#ba9f6c', 0.7, 0.3))
      stud.position.set(x, -0.151, z)
      stud.scale.y = 0.3
      board.add(stud)
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.31, 0.14, 24), material('#282720'))
      foot.position.set(x * 0.87, -0.73, z * 0.87)
      board.add(foot)
    }
  return { board, tiles }
}

export function makePiece(id: PlayerId, index: number) {
  const group = new THREE.Group(),
    palette = PALETTES[id]
  const lacquer = new THREE.MeshPhysicalMaterial({
    color: palette.color,
    roughness: 0.25,
    metalness: 0.12,
    clearcoat: 0.85,
    clearcoatRoughness: 0.2,
  })
  const gold = material('#d6b875', 0.67, 0.24)
  const add = (geometry: THREE.BufferGeometry, y: number, mat: THREE.Material = lacquer) => {
    const mesh = new THREE.Mesh(geometry, mat)
    mesh.position.y = y
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)
    return mesh
  }
  add(new THREE.CylinderGeometry(0.235, 0.26, 0.09, 40), 0.045)
  add(new THREE.CylinderGeometry(0.242, 0.242, 0.025, 40), 0.086, gold)
  const points = [
    [0.19, 0.1],
    [0.2, 0.13],
    [0.16, 0.18],
    [0.1, 0.28],
    [0.1, 0.39],
    [0.145, 0.46],
    [0.135, 0.51],
  ].map(([x, y]) => new THREE.Vector2(x, y))
  add(new THREE.LatheGeometry(points, 36), 0)
  add(new THREE.TorusGeometry(0.115, 0.024, 8, 28), 0.435, gold).rotation.x = Math.PI / 2
  if (id === 'red') {
    const head = add(new THREE.SphereGeometry(0.165, 28, 20), 0.61)
    head.scale.y = 1.08
    add(new THREE.SphereGeometry(0.045, 12, 10), 0.81, gold)
  } else if (id === 'blue') {
    const gem = add(new THREE.OctahedronGeometry(0.22, 0), 0.625)
    gem.scale.set(0.78, 1.2, 0.78)
    gem.rotation.y = Math.PI / 4
    add(new THREE.SphereGeometry(0.04, 12, 10), 0.88, gold)
  } else if (id === 'green') {
    add(new THREE.SphereGeometry(0.135, 24, 18), 0.585)
    for (const side of [-1, 1]) {
      const leaf = add(new THREE.SphereGeometry(0.13, 20, 14), 0.76)
      leaf.scale.set(0.56, 1, 0.34)
      leaf.position.x = side * 0.062
      leaf.rotation.z = side * -0.55
    }
    add(new THREE.SphereGeometry(0.034, 12, 10), 0.72, gold)
  } else {
    add(new THREE.CylinderGeometry(0.17, 0.125, 0.17, 32), 0.57)
    for (let i = 0; i < 5; i++) {
      const angle = (i * Math.PI * 2) / 5
      const point = add(new THREE.ConeGeometry(0.062, 0.18, 12), 0.72)
      point.position.x = Math.cos(angle) * 0.135
      point.position.z = Math.sin(angle) * 0.135
      const tip = add(new THREE.SphereGeometry(0.025, 12, 8), 0.818, gold)
      tip.position.x = point.position.x
      tip.position.z = point.position.z
    }
  }
  for (let i = 0; i <= index; i++) {
    const bead = add(new THREE.SphereGeometry(0.025, 10, 8), 0.15, gold)
    const angle = (i - index / 2) * 0.27
    bead.position.set(Math.sin(angle) * 0.2, 0.15, Math.cos(angle) * 0.2)
  }
  return group
}

export const PIPS: [number, number][][] = [
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
  const die = new THREE.Group()
  const body = roundedBox(0.85, 0.85, 0.85, '#fff7e6', 0.11)
  body.material = new THREE.MeshPhysicalMaterial({ color: '#fff7e6', roughness: 0.24, clearcoat: 0.6 })
  die.add(body)
  const faces: { value: number; position: [number, number, number]; rotation: [number, number, number] }[] = [
    { value: 1, position: [0, 0.427, 0], rotation: [-Math.PI / 2, 0, 0] },
    { value: 6, position: [0, -0.427, 0], rotation: [Math.PI / 2, 0, 0] },
    { value: 2, position: [0, 0, 0.427], rotation: [0, 0, 0] },
    { value: 5, position: [0, 0, -0.427], rotation: [0, Math.PI, 0] },
    { value: 3, position: [0.427, 0, 0], rotation: [0, Math.PI / 2, 0] },
    { value: 4, position: [-0.427, 0, 0], rotation: [0, -Math.PI / 2, 0] },
  ]
  for (const face of faces) {
    const holder = new THREE.Group()
    holder.position.set(...face.position)
    holder.rotation.set(...face.rotation)
    PIPS[face.value].forEach(([x, y]) => {
      const pip = new THREE.Mesh(
        new THREE.CircleGeometry(0.065, 20),
        material(face.value === 1 ? '#c4684f' : '#403e36'),
      )
      pip.position.set(x * 0.215, y * 0.215, 0)
      holder.add(pip)
    })
    die.add(holder)
  }
  return die
}
export function dieQuaternion(value: number) {
  const rotations: [number, number, number][] = [
    [0, 0, 0],
    [0, 0, 0],
    [-Math.PI / 2, 0, 0],
    [0, 0, Math.PI / 2],
    [0, 0, -Math.PI / 2],
    [Math.PI / 2, 0, 0],
    [Math.PI, 0, 0],
  ]
  return new THREE.Quaternion()
    .setFromEuler(new THREE.Euler(...rotations[value]))
    .premultiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.22))
}
