import * as THREE from 'three'
import type { Color, PieceSymbol, Preferences } from '@games/shared/chess/types'
import {
  arc,
  clamp01,
  inOutCubic,
  inCubic,
  lerp,
  outBack,
  outBounce,
  outCubic,
  smooth,
  spring,
  squash,
  stepSpring,
} from '../../../motion/ease'
import type { Spring } from '../../../motion/ease'
import type { Particles } from '../../../motion/particles'
import { reducedMotion } from '../../../motion/preference'
import { disposeTree } from '../../../motion/stage'
import type { Tween, Tweens } from '../../../motion/tween'
import { GRAVE_SCALE, graveSlot, liftHeight, moveDuration } from './choreography'
import { makePiece } from './models'

/** The top of the squares, where every standing piece's base rests. */
export const BOARD_Y = 0.43
/** The felt of the graveyard trays. */
const TRAY_Y = -0.205
const BASE: Record<PieceSymbol, number> = { k: 0.34, q: 0.34, r: 0.305, b: 0.305, n: 0.305, p: 0.265 }
/** A turned piece rests on its base rim and its crown, so it lies a touch past flat. */
const LIE = Math.PI / 2 + 0.07
const UP = new THREE.Vector3(0, 1, 0)

/**
 * One piece on the table and everything about how it is standing right now.
 * Animations write into these fields; `apply` turns them into the transform
 * once per frame, so a lean, a hover lift and a landing squash can overlap
 * without fighting over `position` or `quaternion`.
 */
export interface Actor {
  id: string
  color: Color
  type: PieceSymbol
  root: THREE.Group
  model: THREE.Group
  restYaw: number
  /** Base centre. */
  pos: THREE.Vector3
  /** Height above `pos` from the move in progress. */
  lift: number
  /** Selection, hover and drag lift — interruptible, so a spring. */
  hover: Spring
  /** Lean along `leanDir`, in radians; positive tips the top forward. */
  lean: Spring
  leanDir: THREE.Vector3
  /** Swing while dragged, about the board's x and z axes. */
  tiltX: Spring
  tiltZ: Spring
  /** Vertical scale; the sides follow so volume is kept. */
  squash: number
  scale: number
  /** Extra turn about the piece's own axis (a knight facing its jump). */
  yaw: number
  /** A full orientation that overrides the lean: fallen, or lying in the tray. */
  orient: THREE.Quaternion | null
  /** 0..1 strength of a check shudder. */
  shake: number
  /** 0..1 strength of the selected piece's breathing bob. */
  bob: number
  state: 'board' | 'grave' | 'gone'
  /** Animations currently carrying it across the board; it can't be picked mid-flight. */
  flights: number
  graveTween: Tween | null
}

export interface TravelOptions {
  /** A real parabolic jump, for knights and the castling rook. */
  hop?: boolean
  /** Turn to face the way it jumps (knights). */
  face?: boolean
  height?: number
  duration?: number
  delay?: number
  /** Return upright from lying down (fallen, or in the tray) on the way. */
  stand?: boolean
  /** No dust or landing sound. */
  quiet?: boolean
  onProgress?: (raw: number) => void
  onLand?: () => void
}

export function createCast(
  scene: THREE.Scene,
  tweens: Tweens,
  particles: Particles,
  hooks: { theme: () => Preferences['theme']; muted: () => boolean },
) {
  const actors = new Map<string, Actor>(),
    graves: Record<Color, Actor[]> = { w: [], b: [] }
  const axis = new THREE.Vector3(),
    tilt = new THREE.Quaternion(),
    euler = new THREE.Euler(),
    v = new THREE.Vector3(),
    identity = new THREE.Quaternion()

  // The promotion's column of light: additive, so a vertex gradient to black fades it out upwards.
  const beam = new THREE.CylinderGeometry(0.4, 0.46, 2.8, 40, 8, true).translate(0, 1.4, 0),
    shade = beam.getAttribute('position')
  beam.setAttribute(
    'color',
    new THREE.Float32BufferAttribute(
      Array.from({ length: shade.count }, (_, i) => {
        const fade = (1 - shade.getY(i) / 2.8) ** 1.6
        return [fade, fade * 0.94, fade * 0.78]
      }).flat(),
      3,
    ),
  )
  const column = new THREE.Mesh(
    beam,
    new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  )
  column.visible = false
  scene.add(column)

  function create(id: string, type: PieceSymbol, color: Color, at: THREE.Vector3): Actor {
    const root = new THREE.Group(),
      model = makePiece(type, color, hooks.theme())
    root.add(model)
    scene.add(root)
    const actor: Actor = {
      id,
      color,
      type,
      root,
      model,
      restYaw: model.rotation.y,
      pos: at.clone(),
      lift: 0,
      hover: spring(0),
      lean: spring(0),
      leanDir: new THREE.Vector3(1, 0, 0),
      tiltX: spring(0),
      tiltZ: spring(0),
      squash: 1,
      scale: 1,
      yaw: 0,
      orient: null,
      shake: 0,
      bob: 0,
      state: 'board',
      flights: 0,
      graveTween: null,
    }
    model.userData.actor = actor
    actors.set(id, actor)
    apply(actor, 0)
    return actor
  }

  function remove(actor: Actor) {
    actor.state = 'gone'
    actors.delete(actor.id)
    scene.remove(actor.root)
    disposeTree(actor.model)
    for (const list of Object.values(graves)) {
      const index = list.indexOf(actor)
      if (index >= 0) list.splice(index, 1)
    }
  }

  /** Puts a fresh model in the actor; the old one is disposed unless the caller still wants it. */
  function swapModel(actor: Actor, type: PieceSymbol, keepOld = false) {
    const next = makePiece(type, actor.color, hooks.theme()),
      old = actor.model
    if (!keepOld) {
      actor.root.remove(old)
      disposeTree(old)
    }
    actor.root.add(next)
    actor.model = next
    actor.restYaw = next.rotation.y
    actor.type = type
    next.userData.actor = actor
    return old
  }

  function apply(actor: Actor, now: number) {
    const { root } = actor
    if (actor.orient) root.quaternion.copy(actor.orient)
    else {
      axis.set(actor.leanDir.z, 0, -actor.leanDir.x)
      root.quaternion.setFromAxisAngle(axis, actor.lean.value)
      if (actor.tiltX.value || actor.tiltZ.value) {
        tilt.setFromEuler(euler.set(actor.tiltX.value, 0, actor.tiltZ.value))
        root.quaternion.premultiply(tilt)
      }
    }
    const shake = actor.shake,
      bob = actor.bob ? (0.5 - 0.5 * Math.cos(now * 0.0042)) * 0.035 * actor.bob : 0
    root.position.set(
      actor.pos.x + (shake ? Math.sin(now * 0.09) * 0.03 * shake : 0),
      actor.pos.y + actor.lift + actor.hover.value + bob,
      actor.pos.z + (shake ? Math.sin(now * 0.071 + 1) * 0.02 * shake : 0),
    )
    const side = 1 / Math.sqrt(actor.squash)
    root.scale.set(side * actor.scale, actor.squash * actor.scale, side * actor.scale)
    actor.model.rotation.y = actor.restYaw + actor.yaw + (shake ? Math.sin(now * 0.06) * 0.09 * shake : 0)
  }

  /** Springs settle on their own; returns whether any actor is still moving. */
  function step(dt: number, now: number) {
    let moving = false
    for (const actor of actors.values()) {
      for (const [s, stiffness, ratio] of [
        [actor.hover, 190, 0.62],
        [actor.lean, 240, 0.28],
        [actor.tiltX, 130, 0.42],
        [actor.tiltZ, 130, 0.42],
      ] as const)
        if (s.value !== s.target || s.velocity !== 0)
          if (stepSpring(s, stiffness, dt, 2 * Math.sqrt(stiffness) * ratio)) moving = true
      if (actor.bob || actor.shake) moving = true
      apply(actor, now)
    }
    return moving
  }

  function dust(at: THREE.Vector3, count: number, size = 0.7) {
    if (reducedMotion() || hooks.muted()) return
    particles.burst({
      origin: v.set(at.x, BOARD_Y + 0.03, at.z),
      kind: 'dust',
      count,
      size,
      speed: 1.25,
      life: 0.5,
      colors: ['#efe6d2', '#d9cdb1', '#c9bc9c'],
    })
  }

  /** The beat after a piece arrives: a squash, a follow-through wobble and a puff of dust. */
  function land(actor: Actor, hop: boolean, quiet: boolean) {
    if (reducedMotion()) return
    const amount = hop ? 0.2 : 0.12
    tweens.add({
      duration: hop ? 110 : 70,
      update: (_, raw) => {
        actor.squash = 1 - amount * Math.sin(Math.PI * raw)
      },
      done: () => {
        actor.squash = 1
      },
    })
    actor.lean.target = 0
    actor.lean.velocity += hop ? 1.5 : 1.05
    if (actor.yaw) {
      const from = actor.yaw
      tweens.add({
        duration: 300,
        delay: 60,
        ease: outCubic,
        update: (e) => {
          actor.yaw = from * (1 - e)
        },
      })
    }
    if (!quiet) dust(actor.pos, hop ? 10 : 6)
  }

  /**
   * Lift, travel, drop. The time grows with the square root of the distance;
   * a sliding piece rises, leans into its travel and drops with a squash, a
   * hopping one flies a true parabola, crouching first and stretching in the air.
   */
  function travel(actor: Actor, to: THREE.Vector3, options: TravelOptions = {}): number {
    const reduced = reducedMotion(),
      distance = Math.hypot(to.x - actor.pos.x, to.z - actor.pos.z),
      hop = !!options.hop && !reduced,
      duration = reduced
        ? Math.min(options.duration ?? 200, 200)
        : (options.duration ?? moveDuration(distance) + (hop ? 70 : 0)),
      height = options.height ?? (hop ? 0.6 + 0.12 * distance : liftHeight(distance))
    const from = new THREE.Vector3()
    let startLift = 0,
      startScale = 1,
      startOrient: THREE.Quaternion | null = null,
      face = 0
    actor.flights++
    tweens.add({
      duration,
      delay: options.delay,
      start: () => {
        from.copy(actor.pos)
        startLift = actor.lift
        startScale = actor.scale
        startOrient = options.stand && actor.orient ? actor.orient.clone() : null
        const dx = to.x - from.x,
          dz = to.z - from.z
        if (Math.hypot(dx, dz) > 1e-3) actor.leanDir.set(dx, 0, dz).normalize()
        if (options.face && hop) {
          face = Math.atan2(-actor.leanDir.z, actor.leanDir.x) - actor.restYaw - actor.yaw
          face = Math.atan2(Math.sin(face), Math.cos(face))
        }
      },
      update: (_, raw) => {
        let across: number, y: number, lean: number
        if (reduced) {
          across = smooth(raw)
          y = 0.08 * Math.sin(Math.PI * raw)
          lean = 0
        } else if (hop) {
          across = raw
          y = arc(raw, height)
          actor.squash = squash(raw, 0.9)[1]
          lean = -0.3 * (1 - 2 * raw) * (options.face ? 1 : 0.45)
          if (face) actor.yaw = face * outCubic(clamp01(raw / 0.22))
        } else {
          across = inOutCubic(clamp01((raw - 0.1) / 0.78))
          y = height * (1 - (2 * raw - 1) ** 4)
          actor.squash =
            raw < 0.12 ? 1 - 0.07 * Math.sin((raw / 0.12) * Math.PI) : 1 + 0.04 * Math.sin(raw * Math.PI)
          lean = 0.105 * Math.sin(Math.PI * clamp01((raw - 0.08) / 0.84))
        }
        actor.pos.lerpVectors(from, to, across)
        actor.lift = y + startLift * (1 - smooth(clamp01(raw / 0.35)))
        actor.lean.value = actor.lean.target = lean
        actor.lean.velocity = 0
        if (startOrient)
          actor.orient = (actor.orient ?? new THREE.Quaternion()).slerpQuaternions(
            startOrient,
            identity,
            outCubic(clamp01(raw * 1.4)),
          )
        if (startScale !== 1) actor.scale = lerp(startScale, 1, outCubic(raw))
        options.onProgress?.(raw)
      },
      done: () => {
        actor.flights--
        actor.pos.copy(to)
        actor.lift = 0
        actor.squash = 1
        if (startOrient) actor.orient = null
        actor.scale = startScale !== 1 ? 1 : actor.scale
        land(actor, hop, !!options.quiet)
        options.onLand?.()
      },
    })
    return duration + (options.delay ?? 0)
  }

  /**
   * Knocked back, then over: the piece pivots about the edge of its base on
   * the side it falls to, accelerating like something heavy, and bounces once
   * when it hits the board.
   */
  function topple(
    actor: Actor,
    fall: { x: number; z: number },
    options: {
      knock?: number
      duration?: number
      delay?: number
      onImpact?: () => void
      done?: () => void
    } = {},
  ) {
    const reduced = reducedMotion(),
      duration = reduced ? 220 : (options.duration ?? 480),
      knock = reduced ? 0 : (options.knock ?? 0.22),
      direction = new THREE.Vector3(fall.x, 0, fall.z).normalize(),
      pivotAxis = new THREE.Vector3().crossVectors(UP, direction),
      start = new THREE.Vector3(),
      edge = new THREE.Vector3(),
      arm = new THREE.Vector3(),
      q = new THREE.Quaternion()
    let hit = false
    actor.flights++
    tweens.add({
      duration,
      delay: options.delay,
      start: () => {
        start.copy(actor.pos)
        actor.lift = 0
      },
      update: (_, raw) => {
        const pushed = knock * outCubic(clamp01(raw / 0.3)),
          r = BASE[actor.type] * actor.scale
        let fallen: number
        if (reduced) fallen = smooth(raw)
        else if (raw < 0.7) fallen = (raw / 0.7) ** 2
        else fallen = 1 - 0.09 * Math.sin((Math.PI * (raw - 0.7)) / 0.3)
        if (!hit && raw >= (reduced ? 1 : 0.7)) {
          hit = true
          options.onImpact?.()
        }
        q.setFromAxisAngle(pivotAxis, fallen * LIE)
        edge.copy(start).addScaledVector(direction, pushed + r)
        arm.copy(direction).multiplyScalar(-r).applyQuaternion(q)
        actor.pos.copy(edge).add(arm)
        actor.orient = (actor.orient ?? new THREE.Quaternion()).copy(q)
      },
      done: () => {
        actor.flights--
        options.done?.()
      },
    })
    return duration + (options.delay ?? 0)
  }

  /** Where a victim lies in its tray, and how. */
  function gravePose(victim: Color, index: number, type: PieceSymbol) {
    const slot = graveSlot(victim, index),
      position = new THREE.Vector3(slot.x, TRAY_Y + BASE[type] * GRAVE_SCALE, slot.z),
      orient = new THREE.Quaternion()
        .setFromAxisAngle(new THREE.Vector3(0, 0, 1), -slot.side * LIE)
        .multiply(new THREE.Quaternion().setFromAxisAngle(UP, (index * 2.399) % (Math.PI * 2)))
    return { position, orient }
  }

  /** Off the board in an arc to the next place in its colour's tray. */
  function bury(actor: Actor, options: { delay?: number; instant?: boolean; onArrive?: () => void } = {}) {
    const victim = actor.color,
      index = graves[victim].length
    graves[victim].push(actor)
    actor.state = 'grave'
    const pose = gravePose(victim, index, actor.type)
    if (options.instant) {
      actor.pos.copy(pose.position)
      actor.orient = pose.orient
      actor.scale = GRAVE_SCALE
      actor.lift = 0
      apply(actor, 0)
      options.onArrive?.()
      return
    }
    const reduced = reducedMotion(),
      from = new THREE.Vector3(),
      fromOrient = new THREE.Quaternion()
    let fromScale = 1
    actor.flights++
    // High enough to clear the pieces it passes over on its way off the board.
    const distance = Math.hypot(pose.position.x - actor.pos.x, pose.position.z - actor.pos.z),
      height = Math.min(2.3, 1.35 + 0.14 * distance)
    actor.graveTween = tweens.add({
      duration: reduced ? 240 : 480 + 55 * Math.sqrt(distance),
      delay: options.delay,
      ease: reduced ? smooth : inOutCubic,
      start: () => {
        from.copy(actor.pos)
        fromOrient.copy(actor.orient ?? actor.root.quaternion)
        fromScale = actor.scale
      },
      update: (e, raw) => {
        if (reduced) {
          // Reduced: it fades from the board and reappears in the tray, rather than flying.
          const away = raw < 0.5
          actor.pos.copy(away ? from : pose.position)
          actor.orient = (actor.orient ?? new THREE.Quaternion()).copy(away ? fromOrient : pose.orient)
          actor.scale = Math.max(0.001, (away ? fromScale : GRAVE_SCALE) * Math.abs(1 - 2 * raw))
          return
        }
        actor.pos.lerpVectors(from, pose.position, e)
        actor.lift = arc(raw, height)
        actor.orient = (actor.orient ?? new THREE.Quaternion()).slerpQuaternions(fromOrient, pose.orient, e)
        actor.scale = lerp(fromScale, GRAVE_SCALE, e)
      },
      done: () => {
        actor.flights--
        actor.graveTween = null
        actor.lift = 0
        actor.pos.copy(pose.position)
        actor.orient = pose.orient.clone()
        actor.scale = GRAVE_SCALE
        if (!reducedMotion() && !hooks.muted())
          particles.burst({
            origin: v.set(actor.pos.x, TRAY_Y + 0.05, actor.pos.z),
            kind: 'dust',
            count: 5,
            size: 0.5,
            speed: 0.9,
            life: 0.4,
            colors: ['#cfc4a8', '#b9ad8f'],
          })
        options.onArrive?.()
      },
    })
  }

  /** A quick shiver: the checked king, or a mated one before it falls. */
  function shudder(actor: Actor, ms = 380, delay = 0) {
    if (reducedMotion()) return
    tweens.add({
      duration: ms,
      delay,
      update: (_, raw) => {
        actor.shake = (1 - raw) * Math.min(1, raw * 6)
      },
      done: () => {
        actor.shake = 0
      },
    })
  }

  /**
   * Promotion: a column of light rises from the square while the pawn shrinks
   * into it and the new piece grows out, turning once as it appears.
   */
  function promote(actor: Actor, type: PieceSymbol, onGrown?: () => void) {
    const reduced = reducedMotion(),
      oldYaw = actor.restYaw,
      old = swapModel(actor, type, true),
      next = actor.model
    old.rotation.y = oldYaw
    next.scale.setScalar(0.001)
    column.position.set(actor.pos.x, BOARD_Y, actor.pos.z)
    column.visible = true
    const material = column.material as THREE.MeshBasicMaterial
    tweens.add({
      duration: reduced ? 260 : 820,
      update: (_, raw) => {
        column.scale.set(1 - 0.25 * raw, outCubic(clamp01(raw / 0.3)), 1 - 0.25 * raw)
        material.opacity = 0.55 * Math.min(1, raw / 0.12) * (1 - smooth(clamp01((raw - 0.35) / 0.65)))
      },
      done: () => {
        column.visible = false
      },
    })
    tweens.add({
      duration: reduced ? 140 : 230,
      ease: inCubic,
      update: (e) => {
        old.scale.set(1 - e * 0.6, 1 - e, 1 - e * 0.6).multiplyScalar(1 - 0.4 * e)
      },
      done: () => {
        actor.root.remove(old)
        disposeTree(old)
      },
    })
    const spin = reduced ? 0 : -Math.PI * 2
    tweens.add({
      duration: reduced ? 180 : 520,
      delay: reduced ? 80 : 150,
      ease: reduced ? smooth : outBack(2.1),
      update: (e, raw) => {
        next.scale.setScalar(Math.max(0.001, e))
        actor.yaw = spin * (1 - outCubic(raw))
      },
      done: () => {
        actor.yaw = 0
        next.scale.setScalar(1)
        onGrown?.()
      },
    })
    if (!reduced && !hooks.muted())
      particles.burst({
        origin: v.set(actor.pos.x, BOARD_Y + 0.9, actor.pos.z),
        kind: 'spark',
        count: 26,
        speed: 3.4,
        size: 0.8,
        colors: ['#ffe9a8', '#f6c453', '#fff8e0'],
      })
    return reduced ? 260 : 680
  }

  /** A piece arriving from nowhere: it drops in from above and bounces to rest. */
  function dropIn(actor: Actor, delay = 0) {
    const reduced = reducedMotion(),
      height = reduced ? 0 : 4.2
    actor.lift = height
    actor.scale = reduced ? 0.001 : 1
    actor.flights++
    tweens.add({
      duration: reduced ? 200 : 620,
      delay,
      update: (_, raw) => {
        if (reduced) actor.scale = Math.max(0.001, smooth(raw))
        else actor.lift = height * (1 - outBounce(raw))
      },
      done: () => {
        actor.flights--
        actor.lift = 0
        actor.scale = 1
        dust(actor.pos, 8)
      },
    })
    return (reduced ? 200 : 620) + delay
  }

  /** Shrinks away and is gone (a tray piece a rematch has no use for). */
  function vanish(actor: Actor, delay = 0) {
    const from = actor.scale
    actor.flights++
    tweens.add({
      duration: 260,
      delay,
      ease: inCubic,
      update: (e) => {
        actor.scale = Math.max(0.001, from * (1 - e))
      },
      done: () => remove(actor),
    })
  }

  function retheme() {
    for (const actor of actors.values()) {
      const { orient, yaw } = actor
      swapModel(actor, actor.type)
      actor.orient = orient
      actor.yaw = yaw
      apply(actor, 0)
    }
  }

  return {
    actors,
    graves,
    create,
    remove,
    swapModel,
    step,
    travel,
    topple,
    bury,
    shudder,
    promote,
    dropIn,
    vanish,
    retheme,
    gravePose,
    dispose() {
      for (const actor of [...actors.values()]) remove(actor)
      scene.remove(column)
      disposeTree(column)
    },
  }
}
export type Cast = ReturnType<typeof createCast>
export { BASE as PIECE_BASE }
