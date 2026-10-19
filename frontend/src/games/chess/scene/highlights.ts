import * as THREE from 'three'
import type { Square } from '@games/shared/chess/types'
import { dampFactor, outBack, smooth } from '../../../motion/ease'
import { reducedMotion } from '../../../motion/preference'
import { squareXZ } from './choreography'

/**
 * Every mark painted on the board — last move, selection, legal dots, capture
 * rings, check — drawn from a pool that shares one geometry per shape. Marks
 * are keyed: a key that stays keeps its mesh (and glides if its square moves),
 * a new key fades or pops in, and a key that goes fades out before its mesh is
 * returned to the pool. Nothing is built or thrown away per update.
 */
export type HighlightKind = 'tile' | 'ring' | 'dot' | 'rim' | 'capture' | 'mark' | 'check' | 'outline'

export interface HighlightSpec {
  key: string
  kind: HighlightKind
  square: Square
  color: THREE.ColorRepresentation
  opacity: number
  /** Milliseconds to wait before appearing, for staggers. */
  delay?: number
  enter?: 'pop' | 'fade'
  /** Slide between squares instead of jumping (the keyboard cursor). */
  glide?: boolean
  /** Breathe at about 1.2 Hz for a few beats, then hold. */
  pulse?: boolean
  /** Grow a little, for the destination under the pointer. */
  hover?: boolean
}

const HEIGHT: Record<HighlightKind, number> = {
  tile: 0.433,
  ring: 0.441,
  dot: 0.441,
  rim: 0.442,
  capture: 0.441,
  mark: 0.443,
  check: 0.444,
  outline: 0.446,
}

function ring(inner: number, outer: number, segments = 48) {
  return new THREE.RingGeometry(inner, outer, segments).rotateX(-Math.PI / 2)
}

interface Entry {
  key: string
  kind: HighlightKind
  spec: HighlightSpec
  object: THREE.Mesh | THREE.LineLoop
  material: THREE.MeshBasicMaterial | THREE.LineBasicMaterial
  /** Presence, 0..1. */
  t: number
  wait: number
  leaving: boolean
  target: THREE.Vector3
  hover: number
  pulseFrom: number
}

export function createHighlights(parent: THREE.Object3D) {
  const group = new THREE.Group()
  parent.add(group)
  const outline = new THREE.BufferGeometry().setFromPoints(
    [
      [-0.46, -0.46],
      [0.46, -0.46],
      [0.46, 0.46],
      [-0.46, 0.46],
    ].map(([x, z]) => new THREE.Vector3(x, 0, z)),
  )
  const geometry: Record<Exclude<HighlightKind, 'outline'>, THREE.BufferGeometry> = {
    tile: new THREE.PlaneGeometry(0.96, 0.96).rotateX(-Math.PI / 2),
    ring: ring(0.38, 0.415),
    dot: ring(0.035, 0.12, 32),
    rim: ring(0.12, 0.14, 32),
    capture: ring(0.4, 0.455),
    mark: ring(0.066, 0.09, 32),
    check: ring(0.403, 0.45),
  }
  const pool = new Map<HighlightKind, Entry[]>(),
    live = new Map<string, Entry>()
  let clock = 0

  function acquire(spec: HighlightSpec): Entry {
    const spare = pool.get(spec.kind)?.pop()
    if (spare) {
      spare.object.visible = true
      return spare
    }
    let object: Entry['object'], material: Entry['material']
    if (spec.kind === 'outline') {
      material = new THREE.LineBasicMaterial({ transparent: true, depthWrite: false })
      object = new THREE.LineLoop(outline, material)
    } else {
      material = new THREE.MeshBasicMaterial({
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
      object = new THREE.Mesh(geometry[spec.kind], material)
    }
    object.renderOrder = 2
    group.add(object)
    return {
      key: spec.key,
      kind: spec.kind,
      spec,
      object,
      material,
      t: 0,
      wait: 0,
      leaving: false,
      target: new THREE.Vector3(),
      hover: 0,
      pulseFrom: 0,
    }
  }
  function release(entry: Entry) {
    entry.object.visible = false
    live.delete(entry.key)
    const spares = pool.get(entry.kind) ?? []
    spares.push(entry)
    pool.set(entry.kind, spares)
  }
  function place(entry: Entry, square: Square) {
    const { x, z } = squareXZ(square)
    entry.target.set(x, HEIGHT[entry.kind], z)
  }

  return {
    set(specs: HighlightSpec[]) {
      const wanted = new Set<string>()
      for (const spec of specs) {
        wanted.add(spec.key)
        let entry = live.get(spec.key)
        if (!entry) {
          entry = acquire(spec)
          entry.key = spec.key
          entry.t = 0
          entry.hover = 0
          entry.wait = spec.delay ?? 0
          entry.pulseFrom = clock
          live.set(spec.key, entry)
          place(entry, spec.square)
          entry.object.position.copy(entry.target)
        } else if (spec.square !== entry.spec.square) {
          place(entry, spec.square)
          if (!spec.glide) entry.object.position.copy(entry.target)
        }
        if (spec.pulse && !entry.spec.pulse) entry.pulseFrom = clock
        entry.leaving = false
        entry.spec = spec
        entry.material.color.set(spec.color)
      }
      for (const entry of live.values()) if (!wanted.has(entry.key)) entry.leaving = true
    },
    /** Advances every fade, pop, glide and pulse; true while any is still moving. */
    step(dt: number) {
      clock += dt * 1000
      const reduced = reducedMotion()
      let moving = false
      for (const entry of [...live.values()]) {
        const { spec } = entry
        if (entry.wait > 0 && !entry.leaving) {
          entry.wait -= dt * 1000
          entry.object.visible = false
          moving = true
          continue
        }
        entry.object.visible = true
        if (entry.leaving) {
          entry.t = Math.max(0, entry.t - dt / (reduced ? 0.09 : 0.16))
          if (entry.t === 0) {
            release(entry)
            continue
          }
          moving = true
        } else if (entry.t < 1) {
          entry.t = Math.min(1, entry.t + dt / (reduced ? 0.12 : spec.enter === 'pop' ? 0.3 : 0.24))
          moving = true
        }
        if (spec.glide && entry.object.position.distanceToSquared(entry.target) > 1e-6) {
          entry.object.position.lerp(entry.target, reduced ? 1 : dampFactor(24, dt))
          moving = true
        }
        const hoverTarget = spec.hover && !entry.leaving ? 1 : 0
        if (Math.abs(entry.hover - hoverTarget) > 1e-3) {
          entry.hover += (hoverTarget - entry.hover) * dampFactor(16, dt)
          moving = true
        } else entry.hover = hoverTarget
        let pulse = 0
        const pulsing = spec.pulse && !reduced ? clock - entry.pulseFrom : Infinity
        if (pulsing < 2500) {
          pulse = 0.5 - 0.5 * Math.cos(pulsing * 0.0012 * Math.PI * 2)
          moving = true
        }
        const presence =
          entry.leaving || reduced || spec.enter !== 'pop' ? smooth(entry.t) : outBack(2.2)(entry.t)
        const scale =
          (reduced
            ? 1
            : spec.enter === 'pop' || entry.leaving
              ? 0.35 + 0.65 * presence
              : 0.9 + 0.1 * presence) *
          (1 + 0.28 * entry.hover + 0.07 * pulse)
        entry.object.scale.setScalar(Math.max(0.001, scale))
        entry.material.opacity = spec.opacity * smooth(entry.t) * (1 - 0.35 * pulse)
      }
      return moving
    },
    dispose() {
      parent.remove(group)
      outline.dispose()
      for (const g of Object.values(geometry)) g.dispose()
      for (const entry of [...live.values(), ...[...pool.values()].flat()]) entry.material.dispose()
    },
  }
}
export type Highlights = ReturnType<typeof createHighlights>
