import * as THREE from 'three'
import type { Property } from '@games/shared/estate/types'
import { arc, outBack, outBounce, outCubic, inQuad, lerp } from '../../../motion/ease'
import type { Tweens } from '../../../motion/tween'
import type { Particles } from '../../../motion/particles'
import type { LotKit } from './models'

/**
 * Every deed on the board, kept as a diff rather than rebuilt: a purchase drops
 * its marker in, a house falls onto the lot and kicks up dust, four houses make
 * way for a hotel, a mortgage greys the marker out, a trade sweeps it into its
 * new owner's colour — and each of those plays backwards when it is undone.
 *
 * `sync` returns how long the change takes to read, so the presentation queue
 * can hold the next beat for it.
 */
const MORTGAGED = new THREE.Color('#858781')
const MARKER_Y = 0.105
const HOUSE_Z = -0.52
const HOUSE_Y = 0.11

interface Piece {
  object: THREE.Group
  hotel: boolean
}
interface Lot {
  group: THREE.Group
  marker: THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>
  pieces: Piece[]
  owner: number
  level: number
  mortgaged: boolean
}

export interface LotsOptions {
  kit: LotKit
  tiles: Map<number, THREE.Group>
  tweens: Tweens
  particles: Particles
  /** A burst of a ring in the owner's colour where a deed changes hands. */
  ring: (at: THREE.Vector3, color: THREE.ColorRepresentation) => void
  onBuild?: () => void
}

const houseX = (index: number, count: number) => (index - (count - 1) / 2) * 0.22

export function createLots({ kit, tiles, tweens, particles, ring, onBuild }: LotsOptions) {
  const lots = new Map<number, Lot>()
  const scratch = new THREE.Vector3(),
    toColor = new THREE.Color()

  function worldOf(object: THREE.Object3D, out: THREE.Vector3) {
    object.updateWorldMatrix(true, false)
    return object.getWorldPosition(out)
  }

  function place(piece: Piece, index: number, count: number) {
    piece.object.position.set(piece.hotel ? 0 : houseX(index, count), piece.hotel ? 0.12 : HOUSE_Y, HOUSE_Z)
    piece.object.scale.setScalar(piece.hotel ? 1 : 0.77)
  }

  function makePiece(hotel: boolean): Piece {
    return { object: hotel ? kit.hotel() : kit.house(), hotel }
  }

  /** Lift a piece off its lot and let it go: the reverse of building it. */
  function liftAway(lot: Lot, piece: Piece, delay: number, gentle: boolean) {
    const from = piece.object.position.y,
      scale = piece.object.scale.x
    return tweens.add({
      delay,
      duration: gentle ? 160 : 380,
      ease: inQuad,
      update: (t) => {
        piece.object.position.y = from + (gentle ? 0 : t * 0.7)
        piece.object.scale.setScalar(scale * (1 - t))
      },
      done: () => lot.group.remove(piece.object),
    })
  }

  /** Drop a piece onto its lot with a bounce and a puff of dust. */
  function dropIn(piece: Piece, delay: number, gentle: boolean) {
    const restY = piece.object.position.y,
      scale = piece.object.scale.x
    piece.object.visible = false
    tweens.add({
      delay,
      duration: gentle ? 160 : 520,
      start: () => {
        piece.object.visible = true
      },
      update: (_t, raw) => {
        if (gentle) {
          piece.object.scale.setScalar(scale * outCubic(raw))
          return
        }
        piece.object.position.y = restY + (1 - outBounce(raw)) * 1.1
        piece.object.scale.setScalar(scale * Math.min(1, 0.6 + raw * 1.6))
      },
      done: () => {
        piece.object.position.y = restY
        piece.object.scale.setScalar(scale)
        if (gentle) return
        particles.burst({
          origin: worldOf(piece.object, scratch),
          kind: 'dust',
          count: piece.hotel ? 14 : 8,
          colors: ['#e9e2cf', '#d8cdb2'],
          size: 0.7,
        })
      },
    })
    // The first contact of the bounce is the one that sounds.
    if (!gentle && onBuild) tweens.add({ delay: delay + 190, duration: 1, update: () => {}, done: onBuild })
  }

  function create(id: number, property: Property, color: string): Lot {
    const group = new THREE.Group()
    tiles.get(id)!.add(group)
    const marker = kit.marker(color)
    marker.position.set(0, MARKER_Y, 0.61)
    group.add(marker)
    const lot: Lot = { group, marker, pieces: [], owner: property.owner, level: 0, mortgaged: false }
    lots.set(id, lot)
    return lot
  }

  /** Grow or shrink the houses on a lot to `level`, returning when it settles. */
  function build(lot: Lot, level: number, animate: boolean, gentle: boolean) {
    const wantHotel = level === 5,
      count = wantHotel ? 1 : level
    const sameKind = lot.pieces.every((p) => p.hotel === wantHotel)
    let end: number
    if (!animate) {
      for (const piece of lot.pieces) lot.group.remove(piece.object)
      lot.pieces = Array.from({ length: count }, () => makePiece(wantHotel))
      lot.pieces.forEach((piece, i) => {
        place(piece, i, count)
        lot.group.add(piece.object)
      })
      lot.level = level
      return 0
    }
    if (sameKind) {
      // Keep what stands, slide it to its new place, and add or lift the rest.
      const keep = lot.pieces.slice(0, count),
        extra = lot.pieces.slice(count)
      extra.forEach((piece, i) => liftAway(lot, piece, i * 70, gentle))
      keep.forEach((piece, i) => {
        const fromX = piece.object.position.x,
          toX = piece.hotel ? 0 : houseX(i, count)
        if (Math.abs(fromX - toX) > 1e-4)
          tweens.add({
            duration: gentle ? 160 : 300,
            ease: outCubic,
            update: (t) => {
              piece.object.position.x = lerp(fromX, toX, t)
            },
          })
      })
      const added: Piece[] = []
      for (let i = keep.length; i < count; i++) {
        const piece = makePiece(wantHotel)
        place(piece, i, count)
        lot.group.add(piece.object)
        dropIn(piece, (i - keep.length) * 110 + (extra.length ? 0 : 120), gentle)
        added.push(piece)
      }
      lot.pieces = [...keep, ...added]
      end = gentle
        ? 200
        : Math.max(extra.length ? 380 : 0, added.length ? 640 + (added.length - 1) * 110 : 300)
    } else {
      // Houses gather into the middle of the lot and a hotel lands on them, or
      // the hotel lifts away and the houses come back.
      const old = lot.pieces
      old.forEach((piece, i) => {
        const fromX = piece.object.position.x
        tweens.add({
          delay: i * 40,
          duration: gentle ? 160 : 300,
          ease: inQuad,
          update: (t) => {
            piece.object.position.x = lerp(fromX, 0, t)
            piece.object.scale.setScalar((piece.hotel ? 1 : 0.77) * (1 - t))
            if (!gentle && piece.hotel) piece.object.position.y = 0.12 + t * 0.6
          },
          done: () => lot.group.remove(piece.object),
        })
      })
      lot.pieces = Array.from({ length: count }, () => makePiece(wantHotel))
      lot.pieces.forEach((piece, i) => {
        place(piece, i, count)
        lot.group.add(piece.object)
        dropIn(piece, (gentle ? 120 : 260) + i * 90, gentle)
      })
      end = gentle ? 300 : 260 + (count - 1) * 90 + 620
    }
    lot.level = level
    return end
  }

  function recolour(lot: Lot, to: THREE.Color, ms: number, hop: boolean) {
    const from = lot.marker.material.color.clone(),
      target = to.clone()
    tweens.add({
      duration: ms,
      ease: outCubic,
      update: (t, raw) => {
        lot.marker.material.color.copy(from).lerp(target, t)
        if (hop) lot.marker.position.y = MARKER_Y + arc(raw, 0.22)
      },
    })
  }

  return {
    /**
     * Bring the board's deeds to `properties`. `colors` are the players'.
     * With `animate` false everything snaps; `gentle` is reduced motion —
     * quick fades and scales in place of drops and flights.
     */
    sync(properties: Record<number, Property>, colors: string[], animate: boolean, gentle: boolean) {
      let hold = 0
      for (const [id, lot] of lots) {
        if (properties[id]) continue
        // Back to the bank: the deed lifts off the board and everything on it goes too.
        lots.delete(id)
        if (!animate) {
          lot.group.removeFromParent()
          lot.marker.material.dispose()
          continue
        }
        lot.pieces.forEach((piece, i) => liftAway(lot, piece, i * 50, gentle))
        const scale = lot.marker.scale.clone()
        tweens.add({
          duration: gentle ? 180 : 620,
          ease: inQuad,
          update: (t) => {
            lot.marker.position.y = MARKER_Y + (gentle ? 0 : t * 1.4)
            lot.marker.rotation.x = gentle ? 0 : t * 2.4
            lot.marker.scale.copy(scale).multiplyScalar(1 - t)
          },
          done: () => {
            lot.group.removeFromParent()
            lot.marker.material.dispose()
          },
        })
        hold = Math.max(hold, gentle ? 200 : 620)
      }
      for (const [key, property] of Object.entries(properties)) {
        const id = Number(key)
        const owned = toColor.set(property.mortgaged ? MORTGAGED : (colors[property.owner] ?? '#999999'))
        let lot = lots.get(id)
        if (!lot) {
          lot = create(id, property, colors[property.owner] ?? '#999999')
          lot.marker.material.color.copy(owned)
          lot.marker.scale.y = property.mortgaged ? 0.55 : 1
          lot.mortgaged = property.mortgaged
          if (animate) {
            // Bought: the marker lands on the lot with a little overshoot, and a
            // ring of the owner's colour spreads from it.
            const marker = lot.marker
            tweens.add({
              duration: gentle ? 180 : 560,
              update: (_t, raw) => {
                const drop = gentle ? 1 : outBack(2.2)(raw)
                marker.position.y = MARKER_Y + (1 - Math.min(drop, 1)) * 1.3
                marker.scale.set(
                  gentle ? outCubic(raw) : lerp(0.5, 1, drop),
                  gentle ? outCubic(raw) : lerp(1.6, 1, Math.min(drop, 1)),
                  gentle ? outCubic(raw) : lerp(0.5, 1, drop),
                )
              },
              done: () => {
                marker.position.y = MARKER_Y
                marker.scale.set(1, 1, 1)
                if (gentle) return
                const at = worldOf(marker, scratch)
                ring(at, colors[property.owner])
                particles.burst({
                  origin: at,
                  kind: 'spark',
                  count: 18,
                  colors: [colors[property.owner], '#fff3d6'],
                  speed: 2.6,
                  size: 0.6,
                })
              },
            })
            hold = Math.max(hold, gentle ? 200 : 700)
          }
          hold = Math.max(hold, build(lot, property.level, animate, gentle))
          lot.owner = property.owner
          continue
        }
        if (lot.owner !== property.owner || lot.mortgaged !== property.mortgaged) {
          const traded = lot.owner !== property.owner
          lot.owner = property.owner
          lot.mortgaged = property.mortgaged
          if (animate) {
            recolour(lot, owned, gentle ? 160 : 480, traded && !gentle)
            const marker = lot.marker,
              sink = property.mortgaged ? 0.55 : 1,
              from = marker.scale.y
            tweens.add({
              duration: gentle ? 160 : 420,
              ease: outCubic,
              update: (t) => {
                marker.scale.y = lerp(from, sink, t)
              },
            })
            if (traded && !gentle) ring(worldOf(marker, scratch), colors[property.owner])
            hold = Math.max(hold, gentle ? 180 : 520)
          } else {
            lot.marker.material.color.copy(owned)
            lot.marker.scale.y = property.mortgaged ? 0.55 : 1
          }
        }
        if (lot.level !== property.level) hold = Math.max(hold, build(lot, property.level, animate, gentle))
      }
      return hold
    },
    clear() {
      for (const lot of lots.values()) {
        lot.group.removeFromParent()
        lot.marker.material.dispose()
      }
      lots.clear()
    },
  }
}
export type Lots = ReturnType<typeof createLots>
