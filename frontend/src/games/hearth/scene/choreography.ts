import * as THREE from 'three'
import { HOME, PALETTES } from '@games/shared/hearth/board'
import { hopDurations, settleDuration } from '@games/shared/hearth'
import type { Motion, Piece } from '@games/shared/hearth/types'
import { arc, inOutCubic, inQuad, lerp, outCubic, outQuad, smooth } from '../../../motion/ease'
import { reducedMotion } from '../../../motion/preference'
import type { Director } from './director'
import { DUST, GOLD } from './effects'
import type { Effects } from './effects'
import { centre, IDENTITY, UP } from './pieces'
import type { Pieces, Seat, Token } from './pieces'
import type { SceneContext } from './types'

interface HopShape {
  first: boolean
  height: number
  tilt: THREE.Vector3
  scaleFrom: number
  scaleTo: number
}

/** The tilt axis for travel from `a` to `b`: rotating about it tips the top toward `b`. */
const tiltAxis = (a: THREE.Vector3, b: THREE.Vector3, out = new THREE.Vector3()) => {
  out.set(b.z - a.z, 0, -(b.x - a.x))
  return out.lengthSq() > 1e-8 ? out.normalize() : out.set(1, 0, 0)
}

/**
 * One hop from `a` to `b` at progress `raw`: a crouch on the ground that
 * springs into a stretched take-off, a lean into the direction of travel and
 * a parabola whose height grows with the distance covered.
 */
function hop(
  token: Token,
  a: THREE.Vector3,
  b: THREE.Vector3,
  raw: number,
  { first, height, tilt, scaleFrom, scaleTo }: HopShape,
) {
  const contact = first ? 0.3 : 0.15,
    settleFrom = first ? 1 : 1.06,
    low = first ? 0.76 : 0.82
  let angle: number
  if (raw < contact) {
    const u = raw / contact
    token.pos.copy(a)
    token.sy =
      u < 0.62 ? lerp(settleFrom, low, outQuad(u / 0.62)) : lerp(low, 1.14, inQuad((u - 0.62) / 0.38))
    angle = -0.07 * Math.sin(u * Math.PI)
  } else {
    const u = (raw - contact) / (1 - contact)
    token.pos.lerpVectors(a, b, lerp(u, smooth(u), 0.4))
    token.pos.y = lerp(a.y, b.y, u) + arc(u, height)
    token.sy = u < 0.5 ? lerp(1.14, 0.98, outQuad(u * 2)) : lerp(0.98, 1.06, inQuad((u - 0.5) * 2))
    angle = 0.2 * Math.sin(u * Math.PI)
  }
  token.rot.setFromAxisAngle(tilt, angle)
  token.size = lerp(scaleFrom, scaleTo, smooth(raw))
}

/**
 * How pieces move: a walk hopped square by square on the same per-hop
 * timings the room paces the turn by, a capture that knocks the victims home,
 * a welcome into the centre, and the plainer slides reduced motion and
 * missed snapshots get. Each returns how long the next beat should wait.
 */
export function createChoreography(
  ctx: SceneContext,
  pieces: Pieces,
  effects: Effects,
  director: Director,
  /** A piece has come to rest: re-seat everyone and tell the HUD. */
  settled: () => void,
) {
  const { tweens, at } = ctx
  const { tokens, arrange } = pieces

  function settle(token: Token) {
    token.flying = false
    pieces.layout()
    settled()
  }

  /** The piece comes to rest after its walk: a landing squash that rings out, then the layout takes it. */
  function landing(token: Token, delay: number, ms: number, depth: number) {
    const from = new THREE.Quaternion()
    tweens.add({
      delay,
      duration: ms,
      start: () => void from.copy(token.rot),
      update: (_, u) => {
        token.sy = 1 - depth * Math.exp(-5 * u) * Math.cos(u * Math.PI * 2.5)
        token.rot.slerpQuaternions(from, IDENTITY, outCubic(u))
      },
      done: () => {
        token.sy = 1
        settle(token)
      },
    })
  }

  /**
   * A capture: the mover slams down and the board holds its breath for a
   * beat, then whoever was there is knocked away along the line of the hit,
   * tumbles, bounces once and arcs home to its own nest.
   */
  function impact(
    mover: Token,
    victims: Token[],
    from: THREE.Vector3,
    to: THREE.Vector3,
    after: Map<string, Seat>,
    delay: number,
  ) {
    const HIT_STOP = 70
    effects.ring(to, '#fff3d6', 460, 0.5, 2.6, 0, delay)
    at(delay, () => {
      ctx.cue({ kind: 'capture', pan: ctx.pan(to) })
      for (const victim of victims) victim.sy = 0.84
      if (ctx.quiet) return
      effects.burst({
        origin: to.clone().setY(to.y + 0.25),
        kind: 'spark',
        count: 22,
        colors: [...GOLD, ...victims.map((v) => PALETTES[v.piece.playerId].color)],
        speed: 3.4,
        spread: 0.85,
        life: 0.75,
      })
      director.punch(at)
    })
    // The mover: a heavy squash held through the hit-stop, then a springy recovery.
    tweens.add({
      delay,
      duration: 400,
      update: (_, u) => {
        const ms = u * 400,
          v = (ms - HIT_STOP) / 330
        mover.sy = ms < HIT_STOP ? 0.64 : 1 - 0.36 * Math.exp(-6 * v) * Math.cos(v * Math.PI * 2.6)
        mover.rot.slerp(IDENTITY, 0.3)
      },
      done: () => {
        mover.sy = 1
        settle(mover)
      },
    })
    const direction = new THREE.Vector3(to.x - from.x, 0, to.z - from.z)
    if (direction.lengthSq() < 1e-6) direction.set(1, 0, 0)
    direction.normalize()
    victims.forEach((victim, n) => {
      const d = direction.clone().applyAxisAngle(UP, (n - (victims.length - 1) / 2) * 0.55)
      const p0 = victim.pos.clone(),
        p1 = p0.clone().addScaledVector(d, 0.85),
        p2 = p1.clone().addScaledVector(d, 0.2),
        nest = after.get(victim.piece.id)!.pos
      const tumble = tiltAxis(p0, p1),
        flight = Math.hypot(nest.x - p2.x, nest.z - p2.z),
        height = 1.1 + flight * 0.08,
        spin = new THREE.Quaternion(),
        size = victim.size
      tweens.add({
        delay: delay + HIT_STOP + n * 40,
        duration: 890 - n * 40,
        update: (_, raw) => {
          const ms = raw * 890
          if (ms < 240) {
            // Knocked off its feet along the line of the hit, flipping once.
            const u = ms / 240
            victim.pos.lerpVectors(p0, p1, outQuad(u))
            victim.pos.y = p0.y + arc(u, 0.75)
            victim.rot.setFromAxisAngle(tumble, outCubic(u) * Math.PI * 2)
            victim.sy = 1.04
            victim.size = lerp(size, 1, u)
          } else if (ms < 360) {
            // One small bounce where it fell.
            const u = (ms - 240) / 120
            victim.pos.lerpVectors(p1, p2, u)
            victim.pos.y = p1.y + arc(u, 0.18)
            victim.rot.setFromAxisAngle(tumble, -0.25 * Math.sin(u * Math.PI))
            victim.sy = u < 0.35 ? 1 - 0.24 * Math.sin((u / 0.35) * Math.PI) : 1
          } else if (ms < 810) {
            // Then the long way home, turning once in the air.
            const u = (ms - 360) / 450,
              e = inOutCubic(u)
            victim.pos.lerpVectors(p2, nest, e)
            victim.pos.y = lerp(p2.y, nest.y, e) + arc(e, height)
            victim.rot.copy(spin.setFromAxisAngle(UP, outCubic(u) * Math.PI * 2))
            victim.sy = 1 + 0.08 * Math.sin(u * Math.PI)
          } else {
            const u = (ms - 810) / 80
            victim.pos.copy(nest)
            victim.rot.identity()
            victim.sy = 1 - 0.22 * Math.sin(u * Math.PI)
          }
        },
        done: () => {
          victim.sy = 1
          victim.rot.identity()
          victim.progress = -1
          effects.puff(nest, 7, [PALETTES[victim.piece.playerId].light, ...DUST], 0.6)
          settle(victim)
        },
      })
    })
  }

  /** Home at last: a soft landing in the centre, gold sparkles and a ring rising off it. */
  function welcome(mover: Token, to: THREE.Vector3, delay: number) {
    effects.ring(to, '#f1d98a', 700, 0.6, 1.9, 1.1, delay)
    at(delay, () => {
      ctx.cue({ kind: 'home', pan: ctx.pan(to) })
      effects.burst({
        origin: to.clone().setY(to.y + 0.2),
        kind: 'spark',
        count: 26,
        colors: GOLD,
        speed: 3,
        spread: 0.55,
        life: 0.9,
      })
    })
    landing(mover, delay, 320, 0.2)
  }

  /** Reduced motion: a short straight slide to where everything ends up — no hops, no arcs. */
  function slide(mover: Token, victims: Token[], motion: Motion, after: Map<string, Seat>) {
    const moving = [mover, ...victims].map((token) => ({
      token,
      from: token.pos.clone(),
      size: token.size,
      to: after.get(token.piece.id)!,
    }))
    tweens.add({
      duration: 200,
      ease: outCubic,
      update: (t) => {
        for (const { token, from, size, to } of moving) {
          token.pos.lerpVectors(from, to.pos, t)
          token.size = lerp(size, to.scale, t)
        }
      },
      done: () => {
        mover.progress = motion.to
        for (const victim of victims) victim.progress = -1
        for (const { token } of moving) token.flying = false
        ctx.cue({ kind: motion.captures.length ? 'capture' : motion.to === HOME ? 'home' : 'land' })
        pieces.layout()
        settled()
      },
    })
    return 220
  }

  return {
    /**
     * Walk `motion` out hop by hop. `skip` is how much of it had already
     * played on the room's clock before this board saw it: the walk starts
     * that far in, silently, and lands on time — or simply lands.
     */
    walk(motion: Motion, skip = 0) {
      const mover = tokens.get(motion.pieceId)
      if (!mover) return 0
      const victims = motion.captures.flatMap((id) => tokens.get(id) ?? [])
      for (const token of [mover, ...victims]) token.flying = true
      mover.lift.target = 0
      // Where everyone ends up: the mover on its space, anyone it hit in a nest.
      const after = arrange(
        new Map<string, number | null>([
          [mover.piece.id, motion.to],
          ...victims.map((v) => [v.piece.id, -1] as const),
        ]),
      )
      // The pieces it leaves behind regroup as it takes off.
      pieces.layout()
      if (reducedMotion()) return slide(mover, victims, motion, after)

      const hops = hopDurations(motion),
        last = hops.length - 1,
        end = after.get(mover.piece.id)!
      const points = motion.steps.map((progress, i) =>
        i === last ? end.pos.clone() : centre(mover.piece, progress),
      )
      const start = mover.pos.clone(),
        scaleFrom = mover.size
      let clock = 0,
        a = start
      hops.forEach((ms, i) => {
        const from = a,
          to = points[i],
          distance = Math.hypot(to.x - from.x, to.z - from.z)
        const shape: HopShape = {
          first: i === 0,
          height:
            Math.min(1.25, Math.max(0.42, 0.3 + distance * 0.24)) +
            (i === last && motion.to === HOME ? 0.3 : 0),
          tilt: tiltAxis(from, to),
          scaleFrom: i === 0 ? scaleFrom : 1,
          scaleTo: i === last ? end.scale : 1,
        }
        tweens.add({
          delay: clock,
          duration: ms,
          update: (_, raw) => hop(mover, from, to, raw, shape),
          done: () => {
            mover.pos.copy(to)
            if (i < last) {
              ctx.cue({ kind: 'step', index: i, pan: ctx.pan(to) })
              effects.puff(to, 4, DUST, 0.55)
            }
          },
        })
        clock += ms
        a = to
      })
      const settleMs = settleDuration(motion),
        lastFrom = last > 0 ? points[last - 1] : start,
        landed = clock
      // The last hop has landed: what happens next depends on what it landed on.
      at(landed, () => void (mover.progress = motion.to))
      if (victims.length) impact(mover, victims, lastFrom, end.pos, after, landed)
      else if (motion.to === HOME) welcome(mover, end.pos, landed)
      else {
        at(landed, () => {
          ctx.cue({ kind: 'land', pan: ctx.pan(end.pos) })
          effects.puff(end.pos, 9)
        })
        landing(mover, landed, settleMs, 0.24)
      }
      // A frame of slack so every landing has run before the next beat starts.
      const total = landed + settleMs + 20
      if (skip > 0) ctx.skip(Math.min(skip, total))
      return Math.max(0, total - skip)
    },

    /** Pieces that moved without a walk we saw (a missed snapshot): each hops straight to its place. */
    glide(moved: Piece[]) {
      const movers = moved.flatMap((piece) => {
        const token = tokens.get(piece.id)
        if (!token) return []
        token.flying = true
        token.progress = piece.progress
        return [token]
      })
      const after = arrange(new Map(movers.map((t) => [t.piece.id, t.progress])))
      pieces.layout()
      const reduced = reducedMotion(),
        ms = reduced ? 200 : 420
      const paths = movers.map((token) => ({
        token,
        from: token.pos.clone(),
        size: token.size,
        to: after.get(token.piece.id)!,
      }))
      tweens.add({
        duration: ms,
        update: (_, raw) => {
          const e = reduced ? outCubic(raw) : inOutCubic(raw)
          for (const { token, from, size, to } of paths) {
            token.pos.lerpVectors(from, to.pos, e)
            if (!reduced) token.pos.y += arc(raw, 0.7)
            token.size = lerp(size, to.scale, e)
          }
        },
        done: () => {
          for (const { token } of paths) token.flying = false
          pieces.layout()
          settled()
        },
      })
      return ms
    },

    /** The chosen piece bobs once in acknowledgement while the room confirms the move. */
    nod(id: string) {
      const token = tokens.get(id)
      if (!token || reducedMotion()) return
      tweens.add({
        duration: 240,
        update: (_, u) => {
          token.nod = 1 - 0.18 * Math.exp(-3 * u) * Math.sin(u * Math.PI * 2)
        },
        done: () => void (token.nod = 1),
      })
    },
  }
}
export type Choreography = ReturnType<typeof createChoreography>
