import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import type { Color, PieceSymbol, Preferences, Square } from '../game/types'

export const squarePosition = (square: Square) =>
  new THREE.Vector3(square.charCodeAt(0) - 100.5, 0.43, 4.5 - Number(square[1]))
const material = (color: string, roughness = 0.35, metalness = 0) =>
  new THREE.MeshStandardMaterial({ color, roughness, metalness })

function mesh(geometry: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) {
  const item = new THREE.Mesh(geometry, mat)
  item.position.set(x, y, z)
  item.castShadow = true
  item.receiveShadow = true
  return item
}

function lathe(points: number[][], mat: THREE.Material) {
  return mesh(
    new THREE.LatheGeometry(
      points.map(([x, y]) => new THREE.Vector2(x, y)),
      48,
    ),
    mat,
  )
}

/** Original turned-piece profiles. No downloaded or branded meshes. */
export function makePiece(
  type: PieceSymbol,
  color: Color,
  theme: Preferences['theme'] = 'walnut',
): THREE.Group {
  const group = new THREE.Group()
  const body = material(
    color === 'w' ? '#dccfb5' : theme === 'marble' ? '#35414a' : '#34352c',
    color === 'w' ? 0.31 : 0.32,
  )
  const trim = material(color === 'w' ? '#b69a65' : '#ad9566', 0.27, 0.7)
  const inset = material(color === 'w' ? '#b9ad91' : '#20251e', 0.6)
  const large = type === 'k' || type === 'q'
  const base = large ? 0.34 : type === 'p' ? 0.265 : 0.305
  group.add(
    lathe(
      [
        [0, 0],
        [base * 0.9, 0],
        [base, 0.035],
        [base, 0.075],
        [base * 0.94, 0.105],
        [base * 0.9, 0.13],
        [base * 0.89, 0.17],
        [base * 0.98, 0.185],
        [base * 0.98, 0.21],
        [base * 0.84, 0.245],
        [base * 0.7, 0.27],
        [base * 0.61, 0.3],
        [base * 0.53, 0.34],
      ],
      body,
    ),
  )
  group.add(mesh(new THREE.TorusGeometry(base * 0.94, 0.012, 8, 48), trim, 0, 0.115))
  group.children.at(-1)!.rotation.x = Math.PI / 2
  if (type === 'p') {
    group.add(
      lathe(
        [
          [0.14, 0.3],
          [0.13, 0.38],
          [0.105, 0.52],
          [0.115, 0.57],
          [0.165, 0.59],
          [0.165, 0.63],
          [0.105, 0.66],
        ],
        body,
      ),
    )
    group.add(mesh(new THREE.SphereGeometry(0.18, 28, 20), body, 0, 0.8))
  } else if (type === 'r') {
    group.add(
      lathe(
        [
          [0.17, 0.3],
          [0.15, 0.42],
          [0.15, 0.72],
          [0.21, 0.78],
          [0.255, 0.8],
          [0.255, 0.9],
          [0.19, 0.92],
        ],
        body,
      ),
    )
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3
      const battlement = mesh(
        new THREE.BoxGeometry(0.14, 0.18, 0.15),
        body,
        Math.sin(a) * 0.195,
        0.97,
        Math.cos(a) * 0.195,
      )
      battlement.rotation.y = a
      group.add(battlement)
    }
    group.add(mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.014, 32), inset, 0, 0.918))
  } else if (type === 'n') {
    group.add(
      lathe(
        [
          [0.17, 0.3],
          [0.2, 0.35],
          [0.21, 0.39],
          [0.18, 0.44],
        ],
        body,
      ),
    )
    const outline = new THREE.Shape()
    outline.moveTo(-0.22, 0.39)
    outline.bezierCurveTo(-0.31, 0.65, -0.19, 1.02, 0.03, 1.17)
    outline.lineTo(0.08, 1.32)
    outline.lineTo(0.17, 1.21)
    outline.lineTo(0.29, 1.12)
    outline.lineTo(0.37, 0.91)
    outline.lineTo(0.27, 0.84)
    outline.lineTo(0.12, 0.89)
    outline.lineTo(0.08, 0.75)
    outline.bezierCurveTo(0.28, 0.61, 0.25, 0.44, 0.2, 0.39)
    outline.closePath()
    const head = mesh(
      new THREE.ExtrudeGeometry(outline, {
        depth: 0.18,
        bevelEnabled: true,
        bevelSegments: 3,
        steps: 1,
        bevelSize: 0.04,
        bevelThickness: 0.04,
      }),
      body,
      0,
      0,
      -0.09,
    )
    group.add(head)
    for (const side of [-1, 1])
      group.add(mesh(new THREE.SphereGeometry(0.024, 12, 8), inset, 0.17, 1.08, side * 0.14))
    for (let i = 0; i < 5; i++) {
      const mane = mesh(new THREE.BoxGeometry(0.035, 0.14, 0.23), body, -0.15 + i * 0.025, 0.68 + i * 0.09)
      mane.rotation.z = -0.32
      group.add(mane)
    }
    group.rotation.y = color === 'w' ? -0.35 : Math.PI - 0.35
  } else {
    const stem = type === 'k' ? 0.99 : type === 'q' ? 0.94 : 0.8
    group.add(
      lathe(
        [
          [0.17, 0.3],
          [0.14, 0.41],
          [0.11, 0.64],
          [0.12, stem - 0.12],
          [0.2, stem - 0.06],
          [0.23, stem - 0.04],
          [0.23, stem],
          [0.17, stem + 0.035],
        ],
        body,
      ),
    )
    if (type === 'b') {
      // A split mitre gives the bishop a recognisable diagonal notch.
      const cap = lathe(
        [
          [0, 0.86],
          [0.12, 0.9],
          [0.19, 1.02],
          [0.17, 1.14],
          [0.07, 1.26],
          [0, 1.3],
        ],
        body,
      )
      group.add(cap)
      const slash = mesh(new THREE.BoxGeometry(0.022, 0.21, 0.34), inset, 0.045, 1.15)
      slash.rotation.z = -0.45
      group.add(slash)
      group.add(mesh(new THREE.SphereGeometry(0.055, 16, 12), body, 0, 1.32))
    } else if (type === 'q') {
      group.add(
        lathe(
          [
            [0.14, 0.96],
            [0.16, 1.05],
            [0.23, 1.17],
            [0.24, 1.22],
            [0.12, 1.19],
            [0, 1.18],
          ],
          body,
        ),
      )
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4
        group.add(
          mesh(new THREE.SphereGeometry(0.055, 16, 12), body, Math.sin(a) * 0.235, 1.25, Math.cos(a) * 0.235),
        )
      }
      group.add(mesh(new THREE.SphereGeometry(0.083, 20, 16), trim, 0, 1.32))
    } else {
      group.add(
        lathe(
          [
            [0.14, 1.0],
            [0.16, 1.1],
            [0.2, 1.16],
            [0.19, 1.21],
            [0.09, 1.25],
          ],
          body,
        ),
      )
      group.add(mesh(new RoundedBoxGeometry(0.075, 0.32, 0.075, 2, 0.012), body, 0, 1.43))
      group.add(mesh(new RoundedBoxGeometry(0.26, 0.07, 0.075, 2, 0.01), body, 0, 1.46))
    }
  }
  return group
}

function woodTexture(dark = false) {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 512
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = dark ? '#624735' : '#d9c6a1'
  ctx.fillRect(0, 0, 512, 512)
  let seed = 37
  const rand = () => {
    seed = (seed * 16807) % 2147483647
    return seed / 2147483647
  }
  for (let i = 0; i < 600; i++) {
    ctx.strokeStyle = `rgba(${dark ? '30,15,4' : '95,67,33'},${rand() * 0.085})`
    ctx.lineWidth = 0.3 + rand() * 1.1
    const y = rand() * 512
    ctx.beginPath()
    ctx.moveTo(0, y)
    ctx.bezierCurveTo(150, y + rand() * 8, 330, y - rand() * 8, 512, y + rand() * 6)
    ctx.stroke()
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping
  texture.anisotropy = 8
  return texture
}

function label(text: string, x: number, z: number, rotation = 0) {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ddcbae'
  ctx.font = '500 82px Georgia'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, 64, 65)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const obj = mesh(
    new THREE.PlaneGeometry(0.46, 0.46),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }),
    x,
    0.344,
    z,
  )
  obj.rotation.set(-Math.PI / 2, 0, rotation)
  obj.castShadow = false
  return obj
}

export function makeBoard(theme: Preferences['theme']) {
  const board = new THREE.Group(),
    squares: THREE.Mesh[] = []
  const frame = material('#c8bba1', 0.36)
  frame.map = woodTexture(true)
  if (theme === 'marble') {
    frame.color.set('#54605b')
    frame.map = null
  }
  board.add(mesh(new RoundedBoxGeometry(9.2, 0.44, 9.2, 3, 0.1), frame, 0, 0.1))
  board.add(
    mesh(new RoundedBoxGeometry(9.12, 0.045, 9.12, 2, 0.03), material('#ae9367', 0.3, 0.65), 0, -0.09),
  )
  board.add(mesh(new RoundedBoxGeometry(9.05, 0.14, 9.05, 2, 0.045), material('#362d24', 0.42), 0, -0.18))
  board.add(mesh(new THREE.BoxGeometry(8.12, 0.055, 8.12), material('#ab9066', 0.32, 0.35), 0, 0.335))
  const light = material(theme === 'marble' ? '#e8e6df' : '#e9ddc3', 0.46)
  const dark = material(theme === 'marble' ? '#687779' : '#707c61', 0.44)
  if (theme === 'walnut') {
    const grain = woodTexture()
    light.map = grain
    dark.bumpMap = grain
    dark.bumpScale = 0.015
    light.color.set('#fff4e2')
    dark.color.set('#707d61')
  }
  const squareGeo = new RoundedBoxGeometry(0.996, 0.085, 0.996, 2, 0.012)
  for (let row = 0; row < 8; row++)
    for (let col = 0; col < 8; col++) {
      const sq = mesh(squareGeo, (row + col) % 2 === 0 ? light : dark, col - 3.5, 0.383, row - 3.5)
      sq.userData.square = `${String.fromCharCode(97 + col)}${8 - row}`
      board.add(sq)
      squares.push(sq)
    }
  for (let i = 0; i < 8; i++) {
    board.add(
      label(String.fromCharCode(97 + i), i - 3.5, 4.29),
      label(String.fromCharCode(97 + i), i - 3.5, -4.29, Math.PI),
    )
    board.add(label(String(8 - i), -4.29, i - 3.5), label(String(8 - i), 4.29, i - 3.5, Math.PI))
  }
  for (const x of [-4.3, 4.3])
    for (const z of [-4.3, 4.3])
      board.add(mesh(new THREE.SphereGeometry(0.032, 12, 8), material('#c8ad7a', 0.2, 0.7), x, 0.332, z))
  return { board, squares }
}

export function disposeObject(object: THREE.Object3D) {
  const geometries = new Set<THREE.BufferGeometry>(),
    materials = new Set<THREE.Material>(),
    textures = new Set<THREE.Texture>()
  object.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      geometries.add(o.geometry)
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        materials.add(m)
        for (const value of Object.values(m)) if (value instanceof THREE.Texture) textures.add(value)
      }
    }
  })
  geometries.forEach((g) => g.dispose())
  materials.forEach((m) => m.dispose())
  textures.forEach((t) => t.dispose())
}
