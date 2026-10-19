import * as THREE from 'three'
import { hash01 } from '../../../motion/ease'
import type { QualityTier } from '../../../motion/stage'
import { canvasTexture } from './models'

/**
 * The table breathing while nobody plays: pollen drifting over the board, a
 * leaf now and then from the potted plants, steam off the tea, the plants
 * themselves swaying. Everything is a pure function of the scene clock, so it
 * costs nothing to skip frames — the stage only draws it at a low idle rate —
 * and it allocates nothing once built.
 */
export function createAmbient(
  scene: THREE.Scene,
  { plants, cup }: { plants: { crown: THREE.Group; group: THREE.Group }[]; cup: THREE.Vector3 },
) {
  const soft = canvasTexture(64, (ctx) => {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
    g.addColorStop(0, 'rgba(255,255,255,1)')
    g.addColorStop(0.45, 'rgba(255,255,255,0.55)')
    g.addColorStop(1, 'rgba(255,255,255,0)')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, 64, 64)
  })

  const MOTES = 26
  const moteGeometry = new THREE.BufferGeometry()
  const motePositions = new Float32Array(MOTES * 3)
  moteGeometry.setAttribute('position', new THREE.BufferAttribute(motePositions, 3))
  const motes = new THREE.Points(
    moteGeometry,
    new THREE.PointsMaterial({
      color: '#fff1c2',
      map: soft,
      size: 7,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    }),
  )
  motes.frustumCulled = false
  scene.add(motes)

  const steamMaterial = new THREE.SpriteMaterial({
    map: soft,
    color: '#ffffff',
    transparent: true,
    opacity: 0,
    depthWrite: false,
  })
  const steam = Array.from({ length: 3 }, () => {
    const sprite = new THREE.Sprite(steamMaterial.clone())
    scene.add(sprite)
    return sprite
  })

  const leafGeometry = new THREE.SphereGeometry(1, 10, 6)
  const leaves = plants.map((plant, i) => {
    const mesh = new THREE.Mesh(
      leafGeometry,
      new THREE.MeshStandardMaterial({ color: i % 2 ? '#8ca06c' : '#b49a4e', roughness: 0.6 }),
    )
    mesh.castShadow = true
    scene.add(mesh)
    return { mesh, origin: plant.group.position, size: plant.group.scale.x }
  })

  let on = true,
    motesShown = MOTES,
    steamShown = steam.length,
    leavesShown = leaves.length
  function apply() {
    motes.visible = on
    moteGeometry.setDrawRange(0, motesShown)
    steam.forEach((sprite, i) => (sprite.visible = on && i < steamShown))
    leaves.forEach((leaf, i) => (leaf.mesh.visible = on && i < leavesShown))
    if (!on) for (const plant of plants) plant.crown.rotation.set(0, 0, 0)
  }

  return {
    set visible(next: boolean) {
      on = next
      apply()
    },
    /** Thinner on a device the stage has stepped down: about half the pollen, less steam, one leaf. */
    density(tier: QualityTier) {
      motesShown = tier === 2 ? MOTES : 12
      steamShown = tier === 2 ? steam.length : 2
      leavesShown = tier === 2 ? leaves.length : 1
      apply()
    },
    /** `now` in ms of scene clock. */
    step(now: number) {
      const t = now / 1000
      for (let i = 0; i < motesShown; i++) {
        const a = hash01(i * 3 + 1),
          b = hash01(i * 3 + 2),
          c = hash01(i * 3 + 3)
        motePositions[i * 3] = (a - 0.5) * 12 + Math.sin(t * (0.11 + b * 0.1) + i) * 0.9
        motePositions[i * 3 + 1] = 0.7 + c * 1.8 + Math.sin(t * (0.35 + a * 0.3) + i * 1.7) * 0.25
        motePositions[i * 3 + 2] = (b - 0.5) * 12 + Math.cos(t * (0.09 + c * 0.1) + i * 0.6) * 0.9
      }
      moteGeometry.attributes.position.needsUpdate = true

      steam.forEach((sprite, i) => {
        const cycle = (t / 3.4 + i / steam.length) % 1
        sprite.position.set(
          cup.x + Math.sin(t * 1.3 + i * 2) * 0.08 * cycle,
          cup.y + 0.1 + cycle * 1.1,
          cup.z + Math.cos(t * 1.1 + i) * 0.06 * cycle,
        )
        sprite.scale.setScalar(0.35 + cycle * 0.55)
        sprite.material.opacity = Math.sin(cycle * Math.PI) * 0.22
      })

      plants.forEach(({ crown }, i) => {
        crown.rotation.z = Math.sin(t * 0.8 + i * 1.9) * 0.035
        crown.rotation.x = Math.sin(t * 0.6 + i) * 0.025
      })

      // Each plant lets a leaf go every ~11s: a swaying fall, a rest on the
      // table, and it shrinks away before the next one.
      leaves.forEach(({ mesh, origin, size }, i) => {
        const period = 11 + i * 3,
          local = (t + i * 5) % period,
          fall = Math.min(1, local / 5.5),
          cycle = Math.floor((t + i * 5) / period)
        const drift = (hash01(cycle * 7 + i) - 0.5) * 1.4
        mesh.position.set(
          origin.x + 0.3 * size + drift * fall + Math.sin(local * 2.2) * 0.22 * (1 - fall * 0.6),
          THREE.MathUtils.lerp(origin.y + 1.25 * size, -0.53, fall),
          origin.z + 0.2 + drift * 0.5 * fall,
        )
        mesh.rotation.set(Math.sin(local * 2.2) * 0.9 * (1 - fall), local * 0.6, 0.4)
        const fade = local < 0.4 ? local / 0.4 : local > period - 1.2 ? (period - local) / 1.2 : 1
        mesh.scale.set(0.09 * fade, 0.012 * fade, 0.05 * fade)
      })
    },
    dispose() {
      soft.dispose()
      leafGeometry.dispose()
      moteGeometry.dispose()
      ;(motes.material as THREE.Material).dispose()
      steamMaterial.dispose()
      for (const sprite of steam) sprite.material.dispose()
      for (const leaf of leaves) (leaf.mesh.material as THREE.Material).dispose()
    },
  }
}
export type Ambient = ReturnType<typeof createAmbient>
