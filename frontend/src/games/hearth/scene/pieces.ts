import * as THREE from 'three'
import { HOME, PALETTES, piecePosition, spaceKey } from '@games/shared/hearth/board'
import type { GameState, Piece, PlayerId } from '@games/shared/hearth/types'
import { arc, damp, dampFactor, lerp, spring, stepSpring } from '../../../motion/ease'
import type { Spring } from '../../../motion/ease'
import { makePiece, pieceLooks } from './models'

/** One piece on the board and everything its pose is made of. */
export interface Token {
  piece: Piece
  /** The progress the board is showing, which trails the room's while a walk plays. */
  progress: number
  /** An animation owns the pose; the resting layout leaves it alone. */
  flying: boolean
  group: THREE.Group
  body: THREE.Group
  halo: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>
  haloLevel: number
  pos: THREE.Vector3
  slot: THREE.Vector3
  slotScale: number
  size: number
  /** Squash and stretch along the piece's own axis; volume is kept. */
  sy: number
  nod: number
  rot: THREE.Quaternion
  lift: Spring
  press: Spring
}

export interface Seat {
  pos: THREE.Vector3
  scale: number
}

/** What the frame needs to know to pose the pieces. */
export interface PoseState {
  /** Pieces this browser may move right now; they bob and wear a halo. */
  legal: Set<string>
  winner: PlayerId | null
  reduced: boolean
  /** Idle motion — bobbing, pulsing, the winners' wave. Off when the stage is struggling. */
  ambient: boolean
}

export const IDENTITY = new THREE.Quaternion(),
  UP = new THREE.Vector3(0, 1, 0)

export const restY = (progress: number) => (progress < 0 ? 0.375 : progress === HOME ? 0.445 : 0.325)

/** The centre of the space `piece` would occupy at `progress`. */
export const centre = (piece: Piece, progress: number) => {
  const [x, z] = piecePosition({ ...piece, progress })
  return new THREE.Vector3(x, restY(progress), z)
}

/**
 * Every piece on the board, where each one rests, and how it is posed each
 * frame. Animations take a piece over by marking it `flying`; the rest glide
 * to their seats on springs, squash back to shape and, when they can be
 * played, bob under a halo.
 */
export function createPieces(scene: THREE.Scene, pieces: Piece[]) {
  const looks = pieceLooks()
  const tokens = new Map<string, Token>()
  const haloGeometry = new THREE.RingGeometry(0.32, 0.39, 48)
  for (const piece of pieces) {
    const group = new THREE.Group(),
      body = makePiece(piece.playerId, piece.index, looks[piece.playerId])
    group.add(body)
    group.traverse((child) => {
      child.userData.pieceId = piece.id
    })
    scene.add(group)
    const halo = new THREE.Mesh(
      haloGeometry,
      new THREE.MeshBasicMaterial({
        color: PALETTES[piece.playerId].color,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    )
    halo.rotation.x = -Math.PI / 2
    halo.visible = false
    scene.add(halo)
    tokens.set(piece.id, {
      piece,
      progress: piece.progress,
      flying: false,
      group,
      body,
      halo,
      haloLevel: 0,
      pos: group.position,
      slot: new THREE.Vector3(),
      slotScale: 1,
      size: 1,
      sy: 1,
      nod: 1,
      rot: new THREE.Quaternion(),
      lift: spring(),
      press: spring(),
    })
  }
  const groups = [...tokens.values()].map((t) => t.group)

  /**
   * Where every resting piece sits, with pieces that share a space arranged in
   * a little grid and scaled to fit. `override` asks "what if": a progress for
   * a piece, or `null` to leave it out (it is in the air).
   */
  function arrange(override?: Map<string, number | null>) {
    const spaces = new Map<string, { token: Token; progress: number }[]>()
    for (const token of tokens.values()) {
      const progress = override?.has(token.piece.id)
        ? override.get(token.piece.id)
        : token.flying
          ? null
          : token.progress
      if (progress === null || progress === undefined) continue
      const key = spaceKey({ ...token.piece, progress })
      const list = spaces.get(key)
      if (list) list.push({ token, progress })
      else spaces.set(key, [{ token, progress }])
    }
    const out = new Map<string, Seat>()
    for (const list of spaces.values()) {
      const n = list.length,
        columns = Math.ceil(Math.sqrt(n)),
        rows = Math.ceil(n / columns),
        spacing = n > 4 ? 0.62 / columns : 0.31
      list.forEach(({ token, progress }, index) => {
        const [x, z] = piecePosition({ ...token.piece, progress })
        const dx = n > 1 ? ((index % columns) - (columns - 1) / 2) * spacing : 0,
          dz = n > 1 ? (Math.floor(index / columns) - (rows - 1) / 2) * spacing : 0
        let scale = progress === HOME ? 0.42 : 1
        if (n > 1) scale *= n <= 4 ? 0.56 : 1.25 / columns
        out.set(token.piece.id, { pos: new THREE.Vector3(x + dx, restY(progress), z + dz), scale })
      })
    }
    return out
  }

  const bodyYaw = new THREE.Quaternion()

  return {
    tokens,
    /** Every piece's root, for picking. */
    groups,
    arrange,
    /** Re-seats every resting piece; they glide to their new places on springs. */
    layout() {
      for (const [id, { pos, scale }] of arrange()) {
        const token = tokens.get(id)!
        token.slot.copy(pos)
        token.slotScale = scale
      }
    },
    /** Every piece straight onto its seat, unsquashed: a fresh table. */
    seat() {
      for (const token of tokens.values()) {
        token.pos.copy(token.slot)
        token.size = token.slotScale
        token.sy = token.nod = 1
        token.rot.identity()
      }
    },
    /** `state`'s pieces at the progress the board is showing, which trails the room while a walk plays. */
    shown(state: GameState) {
      return state.pieces.map((piece) => {
        const progress = tokens.get(piece.id)?.progress ?? piece.progress
        return progress === piece.progress ? piece : { ...piece, progress }
      })
    },
    /** The piece under the pointer rises a little. */
    hover(id: string | null) {
      for (const token of tokens.values()) token.lift.target = token.piece.id === id ? 0.14 : 0
    },
    press(id: string | null) {
      for (const token of tokens.values()) token.press.target = token.piece.id === id ? 1 : 0
    },
    step(dt: number, now: number, { legal, winner, reduced, ambient }: PoseState) {
      let moving = false
      const k = dampFactor(16, dt)
      for (const token of tokens.values()) {
        if (!token.flying) {
          token.pos.lerp(token.slot, k)
          token.size = lerp(token.size, token.slotScale, k)
          token.sy = damp(token.sy, 1, 18, dt)
          token.rot.slerp(IDENTITY, k)
          if (
            token.pos.distanceToSquared(token.slot) > 1e-7 ||
            Math.abs(token.size - token.slotScale) > 1e-4 ||
            Math.abs(token.sy - 1) > 1e-4
          )
            moving = true
          else {
            token.pos.copy(token.slot)
            token.size = token.slotScale
            token.sy = 1
          }
        }
        if (stepSpring(token.lift, 180, dt)) moving = true
        if (stepSpring(token.press, 400, dt)) moving = true
        const isLegal = legal.has(token.piece.id)
        let bob = 0
        token.body.quaternion.copy(token.rot)
        if (isLegal && ambient) bob = Math.sin(now * 0.004 + token.piece.index) * 0.035 + 0.04
        else if (isLegal && !reduced) bob = 0.04
        let hopY = 0,
          hopSquash = 1
        if (winner === token.piece.playerId && !token.flying && ambient) {
          // Winners hop in turn, a little Mexican wave around the centre.
          const cycle = (now + token.piece.index * 220) % 1500
          if (cycle < 560) {
            const u = cycle / 560
            hopY = arc(u, 0.55)
            hopSquash = u < 0.12 || u > 0.88 ? 0.86 : 1.06
          }
          token.body.quaternion.premultiply(bodyYaw.setFromAxisAngle(UP, now * 0.0012 + token.piece.index))
          moving = true
        }
        token.group.position.copy(token.pos)
        token.group.scale.setScalar(token.size)
        token.body.position.y = token.lift.value + bob + hopY - token.press.value * 0.03
        const sy = token.sy * token.nod * hopSquash * (1 - 0.1 * token.press.value),
          sx = 1 / Math.sqrt(sy)
        token.body.scale.set(sx, sy, sx)

        token.haloLevel = damp(token.haloLevel, isLegal ? 1 : 0, 12, dt)
        if (Math.abs(token.haloLevel - (isLegal ? 1 : 0)) > 0.002) moving = true
        const halo = token.halo
        halo.visible = token.haloLevel > 0.01
        if (halo.visible) {
          const pulse = ambient ? 1 + Math.sin(now * 0.004) * 0.07 : 1
          halo.material.opacity = 0.75 * token.haloLevel
          halo.position.set(token.pos.x, token.slot.y + 0.007, token.pos.z)
          halo.scale.setScalar(token.size * pulse * (1.25 - 0.25 * token.haloLevel))
        }
        if (isLegal && ambient) moving = true
      }
      return moving
    },
  }
}
export type Pieces = ReturnType<typeof createPieces>
