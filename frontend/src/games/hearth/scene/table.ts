import * as THREE from 'three'
import { PALETTES } from '@games/shared/hearth/board'
import type { PlayerId } from '@games/shared/hearth/types'
import { damp, dampFactor } from '../../../motion/ease'
import type { Stage } from '../../../motion/stage'
import { makeBoard } from './models'

const KEY_LIGHT = new THREE.Color('#fff2d9')

/**
 * The room the game is played in: the lights, the shadow the board casts on
 * the floor, and the board itself — with the two ways the room answers a turn
 * changing hands, a court border that glows and a key light that warms
 * slightly towards whoever is up.
 */
export function createTable(stage: Stage) {
  const { scene } = stage
  scene.add(new THREE.HemisphereLight('#eef4ff', '#80795f', 1.5))
  const key = new THREE.DirectionalLight(KEY_LIGHT, 2.1)
  key.position.set(-7, 16, 7)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  Object.assign(key.shadow.camera, { left: -12, right: 12, top: 12, bottom: -12, near: 0.5, far: 45 })
  key.shadow.normalBias = 0.027
  key.shadow.bias = -0.0003
  key.shadow.radius = 4
  scene.add(key)
  const keyTint = KEY_LIGHT.clone()
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
  const { board, tiles, borders } = makeBoard()
  scene.add(board)
  const courtBorders = Object.entries(borders) as [PlayerId, THREE.MeshStandardMaterial][]
  for (const [id, border] of courtBorders) border.emissive.set(PALETTES[id].color)

  // A slower device gets a smaller shadow map before the stage gives up on shadows altogether.
  function quality(tier: number) {
    if (tier >= 2 || key.shadow.mapSize.x <= 1024) return
    key.shadow.mapSize.set(1024, 1024)
    key.shadow.map?.dispose()
    key.shadow.map = null
  }
  quality(stage.quality)
  const offQuality = stage.onQuality(quality)

  let turnOf: PlayerId | null = null,
    turnAt = -1e9
  return {
    tiles,
    /** The table turns its attention to `player`: their border pulses, the light warms to them. */
    handOver(player: PlayerId | null) {
      turnOf = player
      if (!player) return
      turnAt = stage.now
      keyTint.copy(KEY_LIGHT).lerp(new THREE.Color(PALETTES[player].color), 0.14)
    },
    get turnOf() {
      return turnOf
    },
    step(dt: number, now: number, winner: PlayerId | null, reduced: boolean) {
      let moving = false
      // The court whose turn it is glows: a double pulse on arrival, then a steady ember.
      const since = now - turnAt
      for (const [id, border] of courtBorders) {
        const current = id === turnOf && !winner
        const pulse =
          current && !reduced && since < 1100 ? 0.4 * Math.abs(Math.sin((since / 1100) * Math.PI * 2)) : 0
        const goal = (current ? 0.12 : 0) + pulse
        const next = since < 1100 && current ? goal : damp(border.emissiveIntensity, goal, 6, dt)
        if (Math.abs(next - border.emissiveIntensity) > 1e-4) moving = true
        border.emissiveIntensity = next
      }
      if (!key.color.equals(keyTint)) {
        key.color.lerp(keyTint, dampFactor(4, dt))
        if (Math.abs(key.color.r - keyTint.r) + Math.abs(key.color.b - keyTint.b) < 1e-3)
          key.color.copy(keyTint)
        moving = true
      }
      return moving
    },
    dispose: offQuality,
  }
}
export type TableSet = ReturnType<typeof createTable>
