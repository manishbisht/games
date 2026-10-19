import * as THREE from 'three'
import { absoluteSpace, HOME, PALETTES, piecePosition, TRACK_LENGTH } from '@games/shared/hearth/board'
import type { LegalMove, Piece, PlayerId } from '@games/shared/hearth/types'
import { damp } from '../../../motion/ease'
import { onTap } from '../../../motion/stage'
import type { Stage } from '../../../motion/stage'
import { makeGhost } from './models'
import type { TileSet } from './models'
import { restY } from './pieces'
import type { Pieces } from './pieces'

interface LitTile {
  set: 0 | 1
  index: number
  level: number
  goal: number
  order: number
}

/** Every board key the piece passes through on `move`, in order. */
function pathKeys(piece: Piece, move: LegalMove) {
  const steps = move.from < 0 ? [0] : Array.from({ length: move.to - move.from }, (_, i) => move.from + i + 1)
  return steps.flatMap((progress) =>
    progress >= HOME
      ? []
      : progress < TRACK_LENGTH
        ? [`track-${absoluteSpace({ ...piece, progress })}`]
        : [`${piece.playerId}-${progress}`],
  )
}

/**
 * Choosing a piece. While this browser has a move to make, the playable
 * pieces answer the pointer — hover lifts one, a press squashes it, a tap
 * plays it — and whichever is in focus shows where it would go: a ghost on
 * the destination, a ring under it and the path there lit tile by tile.
 */
export function createPicking(
  stage: Stage,
  pieces: Pieces,
  tiles: TileSet,
  /** A legal piece was tapped. */
  choose: (id: string) => void,
) {
  const { scene, canvas } = stage
  const legal = new Set<string>()
  let moves: LegalMove[] = [],
    focused: string | null = null,
    hovered: string | null = null,
    pathAt = 0

  const destination = new THREE.Group()
  const destinationRing = new THREE.Mesh(
    new THREE.RingGeometry(0.27, 0.34, 48),
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  )
  destinationRing.rotation.x = -Math.PI / 2
  const destinationCenter = new THREE.Mesh(
    new THREE.CircleGeometry(0.26, 48),
    new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.22, depthWrite: false }),
  )
  destinationCenter.rotation.x = -Math.PI / 2
  destination.add(destinationRing, destinationCenter)
  destination.visible = false
  scene.add(destination)
  const ghosts = new Map<PlayerId, THREE.Group>()
  function ghostOf(id: PlayerId) {
    let ghost = ghosts.get(id)
    if (!ghost) {
      ghost = makeGhost(id)
      ghost.visible = false
      scene.add(ghost)
      ghosts.set(id, ghost)
    }
    return ghost
  }
  const lit = new Map<string, LitTile>(),
    pathColor = new THREE.Color(),
    scratch = new THREE.Color()

  /** The destination ring, the ghost and the lit path for whichever legal piece is in focus. */
  function preview() {
    const move = moves.find((m) => m.pieceId === focused)
    for (const ghost of ghosts.values()) ghost.visible = false
    destination.visible = Boolean(move)
    const keys: string[] = []
    if (move) {
      const piece = pieces.tokens.get(move.pieceId)!.piece,
        palette = PALETTES[piece.playerId],
        [x, z] = piecePosition({ ...piece, progress: move.to })
      destination.position.set(x, move.to === HOME ? 0.45 : 0.335, z)
      destinationRing.material.color.set(palette.color)
      destinationCenter.material.color.set(palette.color)
      const ghost = ghostOf(piece.playerId)
      ghost.position.set(x, restY(move.to), z)
      ghost.scale.setScalar(move.to === HOME ? 0.42 : 1)
      ghost.visible = true
      pathColor.set(palette.color)
      keys.push(...pathKeys(piece, move))
    }
    for (const [key, tile] of lit) if (!keys.includes(key)) tile.goal = 0
    keys.forEach((key, order) => {
      const slot = tiles.slots.get(key)
      if (!slot) return
      const tile = lit.get(key)
      if (tile) {
        tile.goal = 1
        tile.order = order
      } else lit.set(key, { set: slot[0], index: slot[1], level: 0, goal: 1, order })
    })
    pathAt = stage.now
    stage.invalidate()
  }
  function setFocus(id: string | null) {
    if (id !== null && !legal.has(id)) return
    if (focused === id) return
    focused = id
    preview()
  }
  function setHover(id: string | null) {
    hovered = id
    pieces.hover(id)
    stage.invalidate()
  }

  const pick = (event: { clientX: number; clientY: number }) =>
    stage.pick(event, pieces.groups)[0]?.object.userData.pieceId as string | undefined
  const onMove = (event: PointerEvent) => {
    if (event.buttons) return
    const id = pick(event),
      ok = id !== undefined && legal.has(id)
    canvas.style.cursor = ok ? 'pointer' : 'grab'
    if ((ok ? id : null) !== hovered) setHover(ok ? id : null)
    if (ok) setFocus(id)
  }
  const onLeave = () => {
    setHover(null)
    pieces.press(null)
  }
  const onDown = (event: PointerEvent) => {
    const id = pick(event)
    if (id && legal.has(id)) {
      pieces.press(id)
      stage.invalidate()
    }
  }
  const onUp = () => {
    pieces.press(null)
    stage.invalidate()
  }
  const offTap = onTap(canvas, (event) => {
    const id = pick(event)
    if (id && legal.has(id)) choose(id)
  })
  canvas.addEventListener('pointermove', onMove)
  canvas.addEventListener('pointerleave', onLeave)
  canvas.addEventListener('pointerdown', onDown)
  canvas.addEventListener('pointerup', onUp)
  canvas.addEventListener('pointercancel', onUp)

  return {
    /** The pieces this browser may move right now. */
    legal,
    /**
     * The moves on offer — empty when it is not this browser's to make. Focus
     * stays on the piece it was on if that is still playable, else the first.
     */
    offer(next: LegalMove[]) {
      moves = next
      legal.clear()
      for (const move of next) legal.add(move.pieceId)
      if (!legal.has(focused ?? '')) focused = next[0]?.pieceId ?? null
      setHover(legal.has(hovered ?? '') ? hovered : null)
      preview()
    },
    focus: setFocus,
    step(dt: number, now: number, reduced: boolean, ambient: boolean) {
      let moving = false
      if (destination.visible) {
        destination.scale.setScalar(ambient ? 1 + Math.sin(now * 0.006) * 0.06 : 1)
        if (ambient) moving = true
      }
      // The path to the focused piece's destination lights tile by tile.
      if (lit.size) {
        for (const [keyName, tile] of lit) {
          const ready = now - pathAt >= (reduced ? 0 : tile.order * 45)
          if (ready || tile.goal === 0) tile.level = damp(tile.level, tile.goal, 14, dt)
          const pulse = ambient ? 0.85 + 0.15 * Math.sin(now * 0.005 - tile.order * 0.55) : 1
          const mesh = tiles.meshes[tile.set]
          mesh.setColorAt(
            tile.index,
            scratch.copy(tiles.base[tile.set][tile.index]).lerp(pathColor, 0.6 * tile.level * pulse),
          )
          mesh.instanceColor!.needsUpdate = true
          if (tile.goal === 0 && tile.level < 0.003) {
            mesh.setColorAt(tile.index, tiles.base[tile.set][tile.index])
            lit.delete(keyName)
          } else if (ambient || Math.abs(tile.level - tile.goal) > 0.003) moving = true
        }
      }
      return moving
    },
    dispose() {
      offTap()
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('pointerleave', onLeave)
      canvas.removeEventListener('pointerdown', onDown)
      canvas.removeEventListener('pointerup', onUp)
      canvas.removeEventListener('pointercancel', onUp)
    },
  }
}
export type Picking = ReturnType<typeof createPicking>
