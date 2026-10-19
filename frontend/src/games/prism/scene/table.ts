import * as THREE from 'three'
import type { Color } from '@games/shared/prism/types'
import { COLOR_HEX } from '@games/shared/prism/types'
import { clamp01, outBack, outCubic, outElastic, outQuint, smooth } from '../../../motion/ease'
import type { Tweens } from '../../../motion/tween'

/** The felt's top surface, where everything that lies on the table sits. */
export const FELT_Y = 0.11
export const DECK = new THREE.Vector3(-1.15, 0, 0.45),
  PILE = new THREE.Vector3(1.05, 0, 0.45),
  TOKEN = new THREE.Vector3(2.6, 0.2, 0.6)

const GOLD = new THREE.Color('#d8b778')

/**
 * The room, the table and the things printed on it — everything that is not a
 * card. Besides building it once, this owns the table's own reactions: the
 * ripple a card sends across the felt when it lands, the shockwave of a wild
 * that recolours the rim and the colour token, and the direction ring that
 * turns over on a reverse.
 */
export function createTable(scene: THREE.Scene, tweens: Tweens, color: Color) {
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

  const shadowFloor = new THREE.Mesh(
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
  function oval(
    rx: number,
    rz: number,
    height: number,
    y: number,
    tone: string,
    roughness: number,
    map?: THREE.Texture,
  ) {
    const object = new THREE.Mesh(
      new THREE.CylinderGeometry(1, 1, height, 128),
      new THREE.MeshStandardMaterial({
        color: tone,
        roughness,
        map: map ?? null,
        bumpMap: map ?? null,
        bumpScale: 0.016,
      }),
    )
    object.scale.set(rx, 1, rz)
    object.position.y = y
    object.receiveShadow = true
    object.castShadow = true
    scene.add(object)
  }
  oval(9.25, 5.15, 0.35, -0.27, '#111e1b', 0.52)
  oval(9.1, 5.02, 0.16, -0.05, '#344139', 0.65)
  oval(8.79, 4.73, 0.09, 0.065, '#427262', 0.96, felt)
  function ellipse(rx: number, rz: number, tone: string, y: number, opacity: number) {
    const points = Array.from(
      { length: 161 },
      (_, i) =>
        new THREE.Vector3(Math.cos((i / 160) * Math.PI * 2) * rx, y, Math.sin((i / 160) * Math.PI * 2) * rz),
    )
    const material = new THREE.LineBasicMaterial({ color: tone, transparent: true, opacity })
    scene.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), material))
    return material
  }
  ellipse(8.87, 4.81, '#d8b778', 0.122, 0.72)
  // The inner rim carries the active colour, so the whole table says it.
  const rim = ellipse(8.46, 4.4, COLOR_HEX[color], 0.117, 0.42)
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
  const logo = new THREE.Mesh(
    new THREE.PlaneGeometry(4.8, 1.2),
    new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(inkCanvas),
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
    }),
  )
  logo.rotation.x = -Math.PI / 2
  logo.position.set(0, 0.12, -1.8)
  scene.add(logo)

  // The direction of play, printed around the two piles. Drawn clockwise; a
  // negative x scale mirrors it for counterclockwise.
  const arrowCanvas = document.createElement('canvas')
  arrowCanvas.width = arrowCanvas.height = 512
  const pen = arrowCanvas.getContext('2d')!
  pen.strokeStyle = pen.fillStyle = '#e6d6a6'
  pen.lineWidth = 7
  pen.lineCap = 'round'
  for (let i = 0; i < 3; i++) {
    const start = (i * Math.PI * 2) / 3 + 0.25,
      end = start + 1.5
    pen.beginPath()
    pen.arc(256, 256, 226, start, end)
    pen.stroke()
    const x = 256 + Math.cos(end) * 226,
      y = 256 + Math.sin(end) * 226
    pen.save()
    pen.translate(x, y)
    pen.rotate(end + Math.PI / 2)
    pen.beginPath()
    pen.moveTo(10, 0)
    pen.lineTo(-14, -15)
    pen.lineTo(-14, 15)
    pen.closePath()
    pen.fill()
    pen.restore()
  }
  const arrowMaterial = new THREE.MeshBasicMaterial({
    map: new THREE.CanvasTexture(arrowCanvas),
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
  })
  const arrows = new THREE.Mesh(new THREE.PlaneGeometry(4.3, 4.3), arrowMaterial)
  arrows.rotation.x = -Math.PI / 2
  arrows.position.set((DECK.x + PILE.x) / 2, 0.116, 0.45)
  scene.add(arrows)

  const tokenMaterial = new THREE.MeshStandardMaterial({
    color: COLOR_HEX[color],
    emissive: COLOR_HEX[color],
    emissiveIntensity: 0.22,
    roughness: 0.4,
    metalness: 0.35,
  })
  const token = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.08, 40), tokenMaterial)
  token.position.copy(TOKEN)
  token.castShadow = true
  scene.add(token)

  // A handful of rings, reused for every ripple and shockwave.
  const ringGeometry = new THREE.RingGeometry(0.86, 1, 96)
  ringGeometry.rotateX(-Math.PI / 2)
  const rings = Array.from({ length: 5 }, () => {
    const ring = new THREE.Mesh(
      ringGeometry,
      new THREE.MeshBasicMaterial({
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    )
    ring.visible = false
    ring.renderOrder = 2
    scene.add(ring)
    return ring
  })
  let nextRing = 0

  const tint = new THREE.Color(COLOR_HEX[color]),
    from = new THREE.Color(),
    target = new THREE.Color()
  let direction: 1 | -1 = 1,
    thin = false

  function ripple(
    at: THREE.Vector3,
    tone: THREE.ColorRepresentation,
    { radius = 2.4, ms = 620, opacity = 0.75, ellipse: stretch = 1, delay = 0 } = {},
  ) {
    const ring = rings[nextRing++ % rings.length],
      material = ring.material as THREE.MeshBasicMaterial
    ring.position.set(at.x, FELT_Y + 0.012, at.z)
    material.color.set(tone)
    tweens.add({
      duration: ms,
      delay,
      start: () => (ring.visible = true),
      update: (_, raw) => {
        const grow = 0.15 + outQuint(raw) * radius
        ring.scale.set(grow * stretch, 1, grow)
        material.opacity = opacity * (1 - smooth(raw))
      },
      done: () => (ring.visible = false),
    })
  }

  /** Recolours the rim and token toward `next`, as a wave reaching them would. */
  function recolor(next: Color, { delay = 0, ms = 420, squash = true } = {}) {
    target.set(COLOR_HEX[next])
    if (target.equals(tint)) return
    tweens.add({
      duration: ms,
      delay,
      start: () => from.copy(tint),
      update: (t) => {
        tint.copy(from).lerp(target, t)
        rim.color.copy(tint)
        tokenMaterial.color.copy(tint)
        tokenMaterial.emissive.copy(tint)
      },
    })
    if (squash) squashToken(delay)
  }

  /** The colour token jumps and lands squashed, then springs back round. */
  function squashToken(delay = 0) {
    tweens.add({
      duration: 620,
      delay,
      update: (_, raw) => {
        const hop = raw < 0.35 ? Math.sin((raw / 0.35) * Math.PI) * 0.28 : 0,
          land = raw < 0.35 ? 0 : outElastic(clamp01((raw - 0.35) / 0.65))
        const y = raw < 0.35 ? 1 + hop * 0.6 : 0.55 + land * 0.45
        token.position.y = TOKEN.y + hop
        token.scale.set(1 / Math.sqrt(y), y, 1 / Math.sqrt(y))
      },
      done: () => {
        token.position.y = TOKEN.y
        token.scale.setScalar(1)
      },
    })
  }

  return {
    rim,
    token,
    ripple,
    recolor,
    squashToken,
    /** On a device the stage has stepped all the way down, each wave is a single ring. */
    thin(next: boolean) {
      thin = next
    },
    /** Sets everything to `next` at once, for a table that is snapping into place. */
    setColor(next: Color) {
      tint.set(COLOR_HEX[next])
      rim.color.copy(tint)
      tokenMaterial.color.copy(tint)
      tokenMaterial.emissive.copy(tint)
    },
    setDirection(next: 1 | -1) {
      direction = next
      arrows.scale.x = next
      arrows.rotation.z = 0
    },
    /**
     * A wild's colour leaves the pile as a wave the size of the table: the
     * token turns as it passes, the rim as it arrives.
     */
    shockwave(next: Color, reduced: boolean) {
      if (reduced) {
        recolor(next, { ms: 200, squash: false })
        return
      }
      ripple(PILE, COLOR_HEX[next], { radius: 3.9, ms: 900, opacity: 0.85, ellipse: 1.75 })
      if (!thin) ripple(PILE, '#fff3d0', { radius: 2.2, ms: 520, opacity: 0.55 })
      recolor(next, { delay: 120, ms: 360 })
      gold(arrowMaterial, 0.5, 900)
    },
    /**
     * The direction ring turns over: it spins half a turn with an overshoot
     * while its mirror flips through zero, so the arrows come round reversed.
     */
    reverse(next: 1 | -1, reduced: boolean) {
      const was = direction
      direction = next
      if (reduced) {
        arrows.scale.x = next
        gold(arrowMaterial, 0.4, 300)
        return
      }
      const spin = outBack(1.6)
      tweens.add({
        duration: 760,
        update: (_, raw) => {
          arrows.rotation.z = spin(raw) * Math.PI * -was
          arrows.scale.x = was * Math.cos(Math.PI * smooth(clamp01((raw - 0.1) / 0.55)))
        },
        done: () => {
          arrows.rotation.z = 0
          arrows.scale.x = next
        },
      })
      gold(arrowMaterial, 0.62, 900)
    },
    dispose() {
      felt.dispose()
    },
  }

  /** Brightens a printed mark for a moment, then lets it sink back into the felt. */
  function gold(material: THREE.MeshBasicMaterial, peak: number, ms: number) {
    const base = 0.16
    tweens.add({
      duration: ms,
      update: (_, raw) => {
        material.opacity =
          base + (peak - base) * (raw < 0.2 ? outCubic(raw / 0.2) : 1 - smooth((raw - 0.2) / 0.8))
        material.color.copy(GOLD).lerp(tint, 0.35).multiplyScalar(1.2)
      },
    })
  }
}
export type Table = ReturnType<typeof createTable>
