import * as THREE from 'three'
import type { Card, Color, GameEvent, GameState } from '@games/shared/prism/types'
import { COLOR_HEX } from '@games/shared/prism/types'
import { createStage } from '../../../motion/stage'
import type { QualityTier } from '../../../motion/stage'
import { createCameraRig } from '../../../motion/camera'
import { createParticles, qualityDensity } from '../../../motion/particles'
import { createQueue, createTweens } from '../../../motion/tween'
import type { Beat } from '../../../motion/tween'
import { clamp01, damp, hash01, hashString, inOutCubic, lerp, outCubic, smooth } from '../../../motion/ease'
import { reducedMotion } from '../../../motion/preference'
import type { SoundKind } from '../game/audio'
import { CARD_W, copyPose, createCards, FLIP, pose } from './cards'
import type { CardObject, Pose } from './cards'
import { createTable, DECK, FELT_Y, PILE } from './table'

export interface TableState {
  game: GameState
  viewer: number
  menu: boolean
  /**
   * Nobody is holding the near seat: its cards belong on the felt like everyone
   * else's rather than in a hand area this viewer does not have.
   */
  watching?: boolean
  /**
   * When `game` began at the room, on this page's `performance.now()` clock.
   * A state that began a while before it arrived — a join, a reload, a
   * reconnect — is shown part-way through its beat, or already landed.
   */
  since?: number
  /** Land on `game` at once, telling nothing of how it got there: a replay's scrub, step or jump. */
  instant?: boolean
  /**
   * A replay's clock. The table runs `speed` times as fast, and a story told
   * into `game` is fitted into `within` ms of the page's time — quickened
   * further when it would run over, and landed at once if it is still going
   * when the next one begins.
   */
  tempo?: { speed: number; within: number }
}

/** Where a card of the viewer's DOM hand sits on screen: its centre in client pixels. */
export interface HandSlot {
  x: number
  y: number
  width: number
  /** The card's own tilt in the fan, in degrees clockwise. */
  angle: number
}

/** Moments the page around the table plays along with, at the instant the table shows them. */
export type Cue =
  /** `pan` is where on the table it happened, -1 (left) to 1 (right). */
  | { kind: 'sound'; sound: SoundKind; pan: number }
  | { kind: 'skip'; player: number }
  | { kind: 'penalty'; player: number; count: number; landed: number }
  | { kind: 'reverse'; direction: 1 | -1 }
  | { kind: 'wild'; color: Color }
  | { kind: 'call'; player: number }

/**
 * What the table is showing, which lags the room on purpose: a hand's count
 * drops when its card leaves and rises when a drawn one lands, the pile turns
 * over when the card arrives, and `game` — whose turn it is, what the prompts
 * say — only moves on once everything before it has been seen.
 */
export interface TableView {
  game: GameState
  sequence: number
  counts: number[]
  deck: number
  top: Card | null
  color: Color
  direction: 1 | -1
  /** The viewer's own cards still in the air: dealt or drawn, not yet in the hand. */
  arriving: string[]
  dealing: boolean
  busy: boolean
}

export interface TableHost {
  view(view: TableView): void
  /** Where a card of the viewer's hand is — or was, just before it was played. */
  slot(cardId: string): HandSlot | null
  cue(cue: Cue): void
  /** The table has drawn its first frame. */
  ready?(): void
}

/** Something on the felt the page can point at: a seat's fan, the pile, or the middle of the table. */
export type TableSpot = number | 'pile' | 'centre'

export interface TableApi {
  update: (state: TableState) => void
  /**
   * Where `spot` is on screen, in client pixels — for the page to float things
   * from a seat or point at the pile. `null` before the table has a size.
   */
  locate: (spot: TableSpot) => { x: number; y: number } | null
  zoom: (amount: number) => void
  dispose: () => void
}

const MAX_FAN = 11,
  MAX_PILE = 5,
  MAX_DECK = 12
const deckLayers = (cards: number) => Math.min(MAX_DECK, Math.ceil(cards / 6))
/**
 * A snapshot whose state began longer ago than this was not watched live: the
 * page reconnected or fell behind, and the beat is picked up part-way. A live
 * one arrives within a round trip, even a slow one, and is told from the start.
 */
const LATE_MS = 1000
const FRAME_MS = 1000 / 60
const FOUR = ['#e46051', '#e9b849', '#53a886', '#548cce']
const X = new THREE.Vector3(1, 0, 0),
  Y = new THREE.Vector3(0, 1, 0),
  Z = new THREE.Vector3(0, 0, 1)
/** Turns a card lying flat to face a camera that looks along its own -z. */
const FACE = new THREE.Quaternion().setFromAxisAngle(X, Math.PI / 2)
/** How far in front of the camera a card in the DOM hand is placed: in front of everything on the table. */
const HAND_DEPTH = 7

function fromGame(game: GameState): TableView {
  return {
    game,
    sequence: game.sequence,
    counts: game.players.map((p) => p.hand.length),
    deck: game.drawPile.length,
    top: game.discardPile.at(-1) ?? null,
    color: game.activeColor,
    direction: game.direction,
    arriving: [],
    dealing: false,
    busy: false,
  }
}

/** The table's view of a snapshot it has fully shown. */
export const tableView = fromGame

/**
 * About how long the table takes to tell `events` at 1×, from the beats below:
 * an upper bound, since reduced motion and short throws take less. A replay
 * reads it to fit a story into the time its state is on screen.
 */
function storyMs(events: GameEvent[]) {
  return events.reduce((ms, event) => {
    if (event.kind === 'play') return ms + 700
    if (event.kind === 'draw') return ms + (Math.min(event.count ?? 1, 12) - 1) * 115 + 640
    if (event.kind === 'shuffle') return ms + 1650
    if (event.kind === 'effect') return ms + 640
    if (event.kind === 'call') return ms + 420
    if (event.kind === 'win') return ms + 1520
    return ms
  }, 0)
}
/** The same for a whole deal: the sweep, the riffle, every card round the table, the starter. */
const dealMs = (game: GameState) =>
  2500 + game.players.reduce((sum, player) => sum + player.hand.length, 0) * 55

/** A round that has only just been dealt: nothing has been played or drawn yet. */
const freshRound = (game: GameState) =>
  game.status === 'playing' &&
  game.discardPile.length === 1 &&
  !game.events.some((e) => e.kind === 'play' || e.kind === 'draw')

export function createScene(container: HTMLElement, initial: TableState, host: TableHost): TableApi {
  const stage = createStage(container, {
    exposure: 0.9,
    environmentIntensity: 0.28,
    powerPreference: 'low-power',
  })
  const { scene, renderer } = stage
  const camera = new THREE.OrthographicCamera(-10, 10, 7, -7, 0.1, 70)
  camera.position.set(0, 13, 15)
  camera.lookAt(0, 0, 0)
  stage.setCamera(camera)
  // The table never orbits: the rig only needs the point it looks at, and the
  // canvas neither answers the pointer nor blocks a phone's scroll.
  const rig = createCameraRig(camera, { target: new THREE.Vector3() })
  stage.onResize((width, height) => {
    const aspect = width / height,
      span = width < 650 ? 6.8 : Math.max(5.8, 9.7 / aspect)
    camera.left = -span * aspect
    camera.right = span * aspect
    camera.top = span
    camera.bottom = -span
    camera.updateProjectionMatrix()
  })

  // A snapshot is told as several beats (a play, its effect, the draws it
  // causes), so the backlog is counted in stories — one push each — not beats:
  // while another story waits behind the one being told, it is told faster.
  const tweens = createTweens(),
    queue = createQueue({ countBy: 'push', catchUpAfter: 1, catchUpSpeed: 2.6 })
  const table = createTable(scene, tweens, initial.game.activeColor)
  const particles = createParticles(scene, { max: 700, floor: FELT_Y + 0.02 })
  const layer = new THREE.Group()
  scene.add(layer)
  const cards = createCards(renderer, layer)
  const stopWarming = cards.warm()

  let state = initial,
    latest = initial.game,
    restless = true,
    clock = 0,
    zoom = 1,
    rosette = false,
    thinker = -1,
    thinkingSince = 0,
    quiet = false,
    tier: QualityTier = stage.quality,
    penalty: { player: number; count: number; landed: number } | null = null,
    /** How fast the table's clock runs against the page's: a replay's speed, and its fit. */
    pace = 1,
    /** How much faster than the replay's speed the story being told has to go to fit. */
    stretch = 1,
    drawn = false
  const view = fromGame(latest)
  const deck: CardObject[] = [],
    pile: { object: CardObject; card: Card }[] = [],
    fans: CardObject[][] = [],
    inFlight: number[] = [],
    lean: number[] = []

  // Scratch values for the per-frame paths; nothing there allocates.
  const ndc = new THREE.Vector3(),
    spot = new THREE.Vector3(),
    screen = new THREE.Vector2(),
    turn = new THREE.Quaternion(),
    twist = new THREE.Quaternion(),
    scratch = pose()

  const inDom = (player: number) => player === state.viewer && !state.menu && !state.watching
  const faceUp = (player: number) => state.menu && player === state.viewer

  function seat(player: number) {
    const count = latest.players.length,
      offset = (player - state.viewer + count) % count
    if (offset === 0) return { x: 0, y: 0.23, z: 4.7, yaw: 0 }
    if (count === 2 || (count === 4 && offset === 2)) return { x: 0, y: 0.22, z: -3, yaw: Math.PI }
    return offset === 1
      ? { x: -6.1, y: 0.22, z: -0.1, yaw: Math.PI / 2 }
      : { x: 6.1, y: 0.22, z: -0.1, yaw: -Math.PI / 2 }
  }

  /**
   * A seat's fan. A player who is thinking leans in: the fan slides toward the
   * pile, tips up a little and breathes, which fades after a few seconds so a
   * long think does not keep the GPU awake.
   */
  function fanHome(player: number, i: number, count: number, out: Pose) {
    const { x, y, z, yaw } = seat(player),
      mid = (count - 1) / 2,
      offset = (i - mid) * 0.31,
      l = lean[player] ?? 0,
      toward = l * 0.42,
      breath =
        player === thinker && tier > 0
          ? Math.sin(clock * 0.0042 + i * 0.55) * 0.035 * l * clamp01(1 - (clock - thinkingSince) / 4000)
          : 0
    out.p.set(
      x + Math.cos(yaw) * offset + Math.sin(yaw) * toward,
      y + i * 0.014 + l * 0.1 + breath,
      z - Math.sin(yaw) * offset - Math.cos(yaw) * toward,
    )
    out.q.setFromAxisAngle(Y, yaw + (i - mid) * -0.045)
    if (l) out.q.multiply(turn.setFromAxisAngle(X, l * 0.16))
    if (!faceUp(player)) out.q.multiply(FLIP)
    out.s = 0.8
    return out
  }
  function deckHome(i: number, out: Pose) {
    out.p.set(DECK.x, 0.16 + i * 0.023, DECK.z)
    out.q.setFromAxisAngle(Y, ((i % 3) - 1) * 0.009).multiply(FLIP)
    out.s = 1
    return out
  }
  /** Each card keeps its own small turn on the pile, from its id, so the pile never re-shuffles itself. */
  function pileHome(card: Card, i: number, out: Pose) {
    const h = hashString(card.id)
    if (rosette) {
      // The winning pile opens like a flower: each card turned a little further round.
      const count = Math.max(pile.length, 1),
        angle = count > 1 ? (i / (count - 1) - 0.5) * Math.PI * 0.85 : 0
      out.p.set(PILE.x + Math.sin(angle) * 0.22, 0.16 + i * 0.03, PILE.z - Math.cos(angle) * 0.12)
      out.q.setFromAxisAngle(Y, -angle)
    } else {
      out.p.set(PILE.x + (hash01(h) - 0.5) * 0.16, 0.16 + i * 0.03, PILE.z + (hash01(h + 1) - 0.5) * 0.12)
      out.q.setFromAxisAngle(Y, (hash01(h + 2) - 0.5) * 0.62)
    }
    out.s = 1
    return out
  }
  function nearPose(out: Pose) {
    out.p.set(0, 1.1, 4.3)
    out.q.identity()
    out.s = 0.9
    return out
  }
  /**
   * The world pose that sits exactly over a card of the DOM hand: in front of
   * the table, facing the camera, at the card's on-screen size and tilt.
   */
  function domPose(slot: HandSlot, out: Pose) {
    const rect = stage.canvas.getBoundingClientRect()
    if (!rect.width || !rect.height) return false
    const depth = ((HAND_DEPTH - camera.near) / (camera.far - camera.near)) * 2 - 1
    ndc.set(((slot.x - rect.left) / rect.width) * 2 - 1, -((slot.y - rect.top) / rect.height) * 2 + 1, depth)
    out.p.copy(ndc).unproject(camera)
    const perPixel = (camera.top - camera.bottom) / camera.zoom / rect.height
    out.s = (slot.width * perPixel) / CARD_W
    out.q
      .copy(camera.quaternion)
      .multiply(FACE)
      .multiply(turn.setFromAxisAngle(Y, (-slot.angle * Math.PI) / 180))
    return true
  }

  function layoutFan(player: number) {
    const fan = fans[player]
    if (!fan) return
    fan.forEach((object, i) => fanHome(player, i, fan.length, object.home))
    restless = true
  }
  function layoutPile() {
    pile.forEach(({ object, card }, i) => pileHome(card, i, object.home))
    restless = true
  }
  function layout() {
    deck.forEach((object, i) => deckHome(i, object.home))
    layoutPile()
    fans.forEach((_, player) => layoutFan(player))
  }

  function syncDeck() {
    const want = deckLayers(view.deck)
    while (deck.length < want) deck.push(cards.acquire(undefined, deckHome(deck.length, scratch)))
    while (deck.length > want) cards.release(deck.pop()!)
  }
  /** The top of the deck, lifted off to travel: the top layer itself when the deck gets thinner. */
  function takeFromDeck() {
    view.deck = Math.max(0, view.deck - 1)
    if (deck.length > deckLayers(view.deck)) return deck.pop()!
    return cards.acquire(undefined, deckHome(deck.length, scratch))
  }
  function syncFan(player: number, count = view.counts[player], game = latest) {
    const fan = (fans[player] ??= [])
    const want = inDom(player) ? 0 : Math.min(count, MAX_FAN),
      hand = game.players[player]?.hand ?? []
    while (fan.length > want) cards.release(fan.pop()!)
    while (fan.length < want) {
      const object = cards.acquire(faceUp(player) ? hand[fan.length] : undefined)
      fan.push(object)
    }
    fan.forEach((object, i) => {
      if (faceUp(player)) cards.face(object, hand[i])
      fanHome(player, i, fan.length, object.home)
    })
    restless = true
  }
  function syncPile(discard: Card[]) {
    const want = discard.slice(-MAX_PILE)
    if (pile.length && pile.at(-1)!.card.id === want.at(-1)?.id) return
    for (const { object } of pile.splice(0)) cards.release(object)
    for (const card of want) pile.push({ object: cards.acquire(card), card })
  }
  function trimPile() {
    while (pile.length > MAX_PILE) cards.release(pile.shift()!.object)
  }
  /** Everything at rest exactly where it belongs, without travelling there. */
  function land() {
    layout()
    for (const object of [...deck, ...pile.map((p) => p.object), ...fans.flat()]) {
      copyPose(object.current, object.home)
      cards.place(object)
    }
  }

  function emit() {
    // A beat being skipped through reports once, where it comes to rest.
    if (quiet) return
    host.view({
      ...view,
      counts: [...view.counts],
      arriving: [...view.arriving],
      busy: queue.busy || view.dealing,
    })
    stage.invalidate()
  }
  queue.onIdle(() => emit())

  /** A moment for the page — unless the table is skipping through a beat nobody watched. */
  function cue(next: Cue) {
    if (!quiet) host.cue(next)
  }
  /** A sound from `x` across the table. */
  function hear(sound: SoundKind, x = 0) {
    cue({ kind: 'sound', sound, pan: THREE.MathUtils.clamp(x / 7, -0.8, 0.8) })
  }
  // A device that was slow on the last board starts this one stepped down,
  // with fewer particles in every burst.
  particles.density = qualityDensity(tier)
  table.thin(tier === 0)
  stage.onQuality((next) => {
    tier = next
    particles.density = qualityDensity(next)
    table.thin(next === 0)
  })

  interface Flight {
    flip?: boolean
    lift?: number
    height?: number
    spin?: number
    ms?: number
    delay?: number
    onLand?: () => void
  }
  /**
   * Sends a card to `to` on a thrown arc: it peaks higher the further it goes,
   * turns over in the air when `flip` says it changes sides, swells a little at
   * the top, and lands exactly on the pose it will rest in — so nothing snaps
   * when the flight hands over to the resting layout. `lift` raises it off a
   * fan first, which is how a player is seen to pick a card.
   */
  function fly(object: CardObject, to: Pose, options: Flight = {}) {
    const reduced = reducedMotion()
    const a = copyPose(pose(), object.current),
      b = copyPose(pose(), to)
    const distance = a.p.distanceTo(b.p)
    const ms = reduced ? 190 : (options.ms ?? THREE.MathUtils.clamp(330 + distance * 30, 350, 600))
    const height = reduced ? 0.12 : (options.height ?? THREE.MathUtils.clamp(0.6 + distance * 0.2, 0.8, 2.6))
    const lift = reduced ? 0 : (options.lift ?? 0),
      lead = lift ? 0.2 : 0
    const start = a.p.clone()
    start.y += lift
    const control = start.clone().lerp(b.p, 0.5)
    control.y += height * 2
    const from = options.flip ? a.q.clone().multiply(FLIP) : a.q
    const spin = reduced ? 0 : (options.spin ?? 0),
      out = object.current,
      shell = object.group.children[0]
    object.flying = true
    // A card up by the camera would throw its shadow far across the page.
    shell.castShadow = Math.max(a.p.y, b.p.y) < 3
    tweens.add({
      duration: ms,
      delay: options.delay,
      update: (_, raw) => {
        if (raw < lead) {
          const k = outCubic(raw / lead)
          out.p.copy(a.p)
          out.p.y += lift * k
          out.q.copy(a.q).multiply(turn.setFromAxisAngle(X, -0.12 * k))
          out.s = a.s * (1 + 0.05 * k)
        } else {
          const u = lead ? (raw - lead) / (1 - lead) : raw,
            e = reduced ? smooth(u) : outCubic(u),
            v = 1 - e
          out.p.set(
            v * v * start.x + 2 * v * e * control.x + e * e * b.p.x,
            v * v * start.y + 2 * v * e * control.y + e * e * b.p.y,
            v * v * start.z + 2 * v * e * control.z + e * e * b.p.z,
          )
          out.q.slerpQuaternions(from, b.q, smooth(clamp01((u - 0.04) / 0.8)))
          if (options.flip)
            out.q.multiply(turn.setFromAxisAngle(Z, Math.PI * (1 - inOutCubic(clamp01((u - 0.1) / 0.62)))))
          if (spin) out.q.premultiply(twist.setFromAxisAngle(Y, Math.sin(Math.PI * u) * spin))
          out.s = lerp(lift ? a.s * 1.05 : a.s, b.s, e) * (1 + (reduced ? 0 : 0.08) * Math.sin(Math.PI * u))
        }
        cards.place(object)
      },
      done: () => {
        copyPose(object.current, b)
        copyPose(object.home, b)
        object.flying = false
        shell.castShadow = true
        cards.place(object)
        restless = true
        options.onLand?.()
      },
    })
    return ms + (options.delay ?? 0)
  }

  /** A short zoom-in and back, the camera's half of an impact. */
  function punch(amount: number) {
    if (rig.userControlled) return
    rig.to({ zoom: zoom + amount }, 26)
    tweens.add({ duration: 110, update: () => {}, done: () => rig.to({ zoom }, 6) })
  }
  const pileTop = () => new THREE.Vector3(PILE.x, 0.25 + pile.length * 0.03, PILE.z)

  /** A card arrives on the pile: the felt ripples in its colour, the pile rattles, the token jumps. */
  function impact(card: Card, object: CardObject) {
    const reduced = reducedMotion(),
      tone = card.isWild ? '#f6e7bf' : COLOR_HEX[card.color],
      action = typeof card.value !== 'number'
    hear(action ? 'action' : 'play', PILE.x)
    // A struggling device keeps its ripples for the cards that do something.
    if (action || tier > 0) table.ripple(PILE, tone, reduced ? { radius: 1.4, ms: 260, opacity: 0.45 } : {})
    if (!card.isWild) table.recolor(card.color as Color, { squash: false, ms: reduced ? 160 : 380 })
    if (reduced) return
    table.squashToken(60)
    object.wobble.velocity += 4
    const under = pile.at(-2)?.object,
      below = pile.at(-3)?.object
    if (under) under.wobble.velocity -= 7
    if (below) below.wobble.velocity += 3.5
    restless = true
    if (action) {
      particles.burst({
        origin: pileTop(),
        kind: 'spark',
        count: card.isWild ? 34 : 18,
        colors: card.isWild ? FOUR : [tone, '#f4dda4'],
        speed: 4.4,
        spread: 0.95,
        size: 0.8,
      })
      rig.shake(card.value === 'draw4' ? 0.1 : 0.05, 260)
    }
    punch(action ? 0.035 : 0.016)
  }

  /**
   * One card to one seat, the way a deal or a draw sends it: lifted off the
   * deck, and either into the DOM hand (turning face up on the way, so the
   * viewer sees what they got) or onto the seat's fan, face down.
   */
  function deliver(player: number, id: string | undefined, { ms }: { ms?: number } = {}) {
    const object = takeFromDeck()
    hear('flick', DECK.x)
    if (inDom(player)) {
      const card = id ? latest.players[player]?.hand.find((c) => c.id === id) : undefined
      cards.face(object, card)
      const to = pose(),
        slot = id ? host.slot(id) : null
      if (!(slot && domPose(slot, to))) nearPose(to)
      emit()
      return fly(object, to, {
        flip: true,
        height: 0.9,
        ms,
        onLand: () => {
          if (id) view.arriving = view.arriving.filter((x) => x !== id)
          view.counts[player] = (view.counts[player] ?? 0) + 1
          penaltyLanded(player)
          hear('land', to.p.x)
          emit()
          // The DOM card takes over on React's next commit; stay until it has.
          tweens.add({ duration: 90, update: () => {}, done: () => cards.release(object) })
        },
      })
    }
    inFlight[player] = (inFlight[player] ?? 0) + 1
    const slots = Math.min(view.counts[player] + inFlight[player], MAX_FAN)
    emit()
    return fly(object, fanHome(player, slots - 1, slots, pose()), {
      ms,
      spin: 0.25,
      onLand: () => {
        inFlight[player]--
        view.counts[player]++
        const fan = (fans[player] ??= [])
        if (fan.length < MAX_FAN) fan.push(object)
        else cards.release(object)
        layoutFan(player)
        if (penaltyLanded(player)) object.wobble.velocity += 3
        hear('land', object.home.p.x)
        emit()
      },
    })
  }

  /** Counts a penalty card home, for the "+4" that ticks up over the victim. */
  function penaltyLanded(player: number) {
    if (penalty?.player !== player) return false
    penalty.landed++
    cue({ kind: 'penalty', ...penalty })
    if (penalty.landed >= penalty.count) penalty = null
    return true
  }

  function play(player: number, card: Card, id: number) {
    const own = inDom(player)
    let object: CardObject
    view.counts[player] = Math.max(0, (view.counts[player] ?? 1) - 1)
    if (own) {
      object = cards.acquire(card)
      const slot = host.slot(card.id)
      if (!(slot && domPose(slot, object.current))) nearPose(object.current)
      copyPose(object.home, object.current)
      cards.place(object)
    } else {
      const fan = (fans[player] ??= [])
      if (fan.length > Math.min(view.counts[player], MAX_FAN)) {
        object = fan.splice(Math.floor(hash01(id) * fan.length), 1)[0]
      } else
        object = cards.acquire(
          undefined,
          fanHome(player, Math.floor(fan.length / 2), fan.length + 1, scratch),
        )
      cards.face(object, card)
      layoutFan(player)
    }
    hear('lift', object.current.p.x)
    const ms = fly(object, pileHome(card, pile.length, pose()), {
      flip: !own,
      lift: own ? 0 : 0.42,
      height: own ? 0.45 : undefined,
      spin: (hash01(id + 7) - 0.5) * 0.9,
      onLand: () => {
        pile.push({ object, card })
        trimPile()
        layoutPile()
        view.top = card
        if (!card.isWild) view.color = card.color as Color
        impact(card, object)
        emit()
      },
    })
    emit()
    return ms + (reducedMotion() ? 30 : 80)
  }

  function draw(player: number, count: number, ids: string[]) {
    const reduced = reducedMotion(),
      total = Math.min(count, 12),
      stagger = reduced ? 45 : 115
    let first = 0
    for (let i = 0; i < total; i++) {
      if (i === 0) first = deliver(player, ids[0])
      else
        tweens.add({ duration: 0, delay: i * stagger, update: () => {}, done: () => deliver(player, ids[i]) })
    }
    return (total - 1) * stagger + first + 40
  }

  /** The pile (all but its top card) folds back into the deck, face down, and the deck is riffled. */
  function reshuffle(deckAfter: number) {
    const reduced = reducedMotion()
    const leaving = pile.splice(0, Math.max(0, pile.length - 1))
    layoutPile()
    hear('gather', PILE.x)
    let ms = 0
    leaving.forEach(({ object }, i) => {
      ms = Math.max(
        ms,
        fly(object, deckHome(deck.length + i, pose()), {
          flip: true,
          height: 1.1,
          delay: i * 70,
          onLand: () => cards.release(object),
        }),
      )
    })
    tweens.add({
      duration: 0,
      delay: ms,
      update: () => {},
      done: () => {
        view.deck = deckAfter
        syncDeck()
        land()
        if (reduced) hear('riffle', DECK.x)
        else riffle()
        emit()
      },
    })
    return ms + (reduced ? 60 : 760)
  }

  /**
   * A riffle: the deck splits into two halves that bow apart, then fall back
   * together top card last, interleaving as they go.
   */
  function riffle(delay = 0) {
    const ms = 720,
      count = deck.length,
      half = Math.ceil(count / 2)
    tweens.add({
      duration: ms,
      delay,
      start: () => {
        hear('riffle', DECK.x)
        deck.forEach((object) => (object.flying = true))
      },
      update: (_, raw) => {
        const apart = outCubic(clamp01(raw / 0.32))
        deck.forEach((object, i) => {
          const left = i < half,
            j = left ? i : i - half,
            back = inOutCubic(clamp01((raw - 0.36 - (count - i) * 0.016) / 0.36)),
            k = apart * (1 - back)
          deckHome(i, object.current)
          object.current.p.x += (left ? -1 : 1) * 0.95 * k
          object.current.p.y = lerp(object.current.p.y, 0.2 + j * 0.03, k)
          object.current.q.multiply(turn.setFromAxisAngle(Z, (left ? 1 : -1) * 0.2 * k))
          cards.place(object)
        })
      },
      done: () =>
        deck.forEach((object, i) => {
          object.flying = false
          deckHome(i, object.current)
          deckHome(i, object.home)
          cards.place(object)
        }),
    })
    return ms + delay
  }

  function effect(event: GameEvent, rest: GameEvent[]) {
    const reduced = reducedMotion(),
      { text, player } = event
    const chosen = event.color ?? (/chose (red|blue|green|yellow)/.exec(text)?.[1] as Color | undefined)
    if (chosen) {
      view.color = chosen
      table.shockwave(chosen, reduced)
      cue({ kind: 'wild', color: chosen })
      hear('wild', PILE.x)
      if (!reduced) {
        particles.burst({
          origin: pileTop(),
          kind: 'spark',
          count: 26,
          colors: [COLOR_HEX[chosen], '#fff3d0'],
        })
        punch(0.03)
      }
      emit()
      return reduced ? 120 : 560
    }
    if (text.startsWith('Direction reversed')) {
      view.direction = view.direction === 1 ? -1 : 1
      table.reverse(view.direction, reduced)
      cue({ kind: 'reverse', direction: view.direction })
      hear('reverse', (DECK.x + PILE.x) / 2)
      emit()
      return reduced ? 120 : 640
    }
    if (text.includes('was paused') && player !== undefined) {
      cue({ kind: 'skip', player })
      hear('skip', seat(player).x)
      rattle(player, 6)
      return reduced ? 150 : 600
    }
    const victim = text.includes('caught') ? rest.find((e) => e.kind === 'draw')?.player : player,
      count = Number(/draws (\d+)|Take (\d+)\./.exec(text)?.slice(1).find(Boolean) ?? 0)
    if (victim !== undefined && count) {
      penalty = { player: victim, count, landed: 0 }
      cue({ kind: 'penalty', ...penalty })
      hear('penalty', seat(victim).x)
      rattle(victim, 4)
      return reduced ? 80 : 280
    }
    return 0
  }
  /** Jolts a seat's fan: the cards jump against each other. */
  function rattle(player: number, strength: number) {
    if (reducedMotion()) return
    fans[player]?.forEach((object, i) => (object.wobble.velocity += (i % 2 ? -1 : 1) * strength))
    restless = true
  }

  function call(player: number) {
    const { x, z } = inDom(player) ? { x: 0, z: 3.4 } : seat(player)
    cue({ kind: 'call', player })
    hear('call', x)
    if (reducedMotion()) return 100
    particles.burst({
      origin: new THREE.Vector3(x, 0.6, z),
      kind: 'spark',
      count: 22,
      colors: ['#f4dda4', '#fff6dc'],
      speed: 3.6,
    })
    return 420
  }

  /**
   * The round's last card: the pile lifts into a spiral and comes down as a
   * rosette, and confetti goes up from the pile and the winner's seat.
   */
  function win(player: number) {
    hear('win')
    if (reducedMotion()) return 300
    const ms = 1400,
      spinning = pile.map(({ object }) => object),
      count = spinning.length,
      starts = spinning.map((object) => copyPose(pose(), object.current))
    rosette = true
    const ends = pile.map(({ card }, i) => pileHome(card, i, pose()))
    tweens.add({
      duration: ms,
      start: () => spinning.forEach((object) => (object.flying = true)),
      update: (_, raw) => {
        spinning.forEach((object, i) => {
          const angle = (i / Math.max(count, 1)) * Math.PI * 2 + outCubic(raw) * Math.PI * 3,
            up = Math.sin(Math.PI * clamp01(raw * 1.1)),
            settle = smooth(clamp01((raw - 0.55) / 0.45)),
            radius = 0.25 + up * 1.1,
            out = object.current
          out.p.set(
            PILE.x + Math.cos(angle) * radius,
            0.2 + up * (1.2 + i * 0.12),
            PILE.z + Math.sin(angle) * radius,
          )
          out.p.lerp(ends[i].p, settle)
          out.q.slerpQuaternions(starts[i].q, ends[i].q, settle)
          if (settle < 1) out.q.multiply(turn.setFromAxisAngle(Y, (1 - settle) * angle))
          out.s = 1 + up * 0.12
          cards.place(object)
        })
      },
      done: () =>
        spinning.forEach((object, i) => {
          object.flying = false
          copyPose(object.current, ends[i])
          copyPose(object.home, ends[i])
          cards.place(object)
        }),
    })
    const { x, z } = inDom(player) ? { x: 0, z: 3.6 } : seat(player)
    tweens.add({
      duration: 0,
      delay: 380,
      update: () => {},
      done: () => {
        particles.burst({
          origin: pileTop().setY(1.2),
          kind: 'confetti',
          count: 150,
          colors: FOUR,
          speed: 7.5,
        })
        particles.burst({
          origin: new THREE.Vector3(x, 0.8, z),
          kind: 'confetti',
          count: 70,
          colors: FOUR,
          speed: 6,
        })
        rig.shake(0.07, 320)
        punch(0.05)
      },
    })
    return ms + 120
  }

  /**
   * The beats for a run of events, in the order they happened. Each beat holds
   * the next back until what it shows has landed.
   */
  function beatsFor(events: GameEvent[], drawn: string[]): Beat[] {
    const beats: Beat[] = []
    events.forEach((event, index) => {
      const { player } = event
      if (event.kind === 'play' && player !== undefined && event.card) {
        const card = event.card
        beats.push({ label: 'play', run: () => play(player, card, event.id) })
      } else if (event.kind === 'draw' && player !== undefined) {
        const count = event.count ?? 1,
          ids = inDom(player) ? drawn.splice(0, count) : []
        beats.push({ label: 'draw', run: () => draw(player, count, ids) })
      } else if (event.kind === 'shuffle') {
        const after =
          latest.drawPile.length +
          events.slice(index + 1).reduce((sum, e) => sum + (e.kind === 'draw' ? (e.count ?? 1) : 0), 0)
        beats.push({ label: 'shuffle', run: () => reshuffle(after) })
      } else if (event.kind === 'effect') {
        const rest = events.slice(index + 1)
        beats.push({ label: 'effect', run: () => effect(event, rest) })
      } else if (event.kind === 'call' && player !== undefined)
        beats.push({ label: 'call', run: () => call(player) })
      else if (event.kind === 'win' && player !== undefined)
        beats.push({ label: 'win', run: () => win(player) })
    })
    return beats
  }

  /**
   * The table becomes `snapshot` exactly, easing anything that drifted. Each
   * snapshot settles to itself — a later one already waiting in the queue has
   * cards still to throw — and the last settles to the newest word from the
   * room, which may have changed since without anything happening at the table.
   */
  function reconcile(snapshot: GameState) {
    const game = queue.length ? snapshot : latest,
      arriving = view.arriving
    Object.assign(view, fromGame(game))
    // Cards still in the air keep their place in the hand empty until they land.
    view.arriving = arriving.filter((id) => latest.players[state.viewer]?.hand.some((c) => c.id === id))
    if (game.status === 'playing') rosette = false
    syncDeck()
    syncPile(game.discardPile)
    game.players.forEach((_, player) => syncFan(player, view.counts[player], game))
    table.recolor(view.color, { squash: false, ms: 200 })
    table.setDirection(view.direction)
    layout()
    emit()
    return 0
  }

  /** Drops whatever the table was in the middle of telling. */
  function reset() {
    queue.clear()
    tweens.finishAll()
    penalty = null
    inFlight.length = 0
  }

  /**
   * Lands a table at once, without travelling there: the newest snapshot (a
   * first look, a change of seat), or the table as it stood before a story
   * that is about to be told part-way in.
   */
  function snap(shown: TableView = fromGame(latest)) {
    reset()
    rosette = shown.game.status === 'won'
    Object.assign(view, shown, { counts: [...shown.counts], arriving: [...shown.arriving] })
    for (const object of deck.splice(0)) cards.release(object)
    for (const { object } of pile.splice(0)) cards.release(object)
    for (const fan of fans) if (fan) for (const object of fan.splice(0)) cards.release(object)
    syncDeck()
    syncPile(shown.game.discardPile)
    shown.game.players.forEach((_, player) => syncFan(player))
    land()
    table.setColor(view.color)
    table.setDirection(view.direction)
    emit()
  }

  /**
   * One snapshot's story onto the queue as a single push, closed by the beat
   * that settles the table to that snapshot.
   */
  function tell(beats: Beat[], game: GameState) {
    queue.push(...beats, { label: 'settle', run: () => reconcile(game) })
  }

  /**
   * Plays the table forward `ms` at once, in frame-sized steps and silently:
   * for a beat that began before this page saw it. Stops early once everything
   * has come to rest, so a beat that ended long ago simply lands.
   */
  function skip(ms: number) {
    quiet = true
    for (let left = ms; left > 0 && (queue.busy || tweens.active); left -= FRAME_MS)
      advance(Math.min(left, FRAME_MS) / 1000, clock)
    quiet = false
    emit()
  }

  /**
   * The table as it stood just before the room's last command, worked back
   * from the state after it, with that command's story still to tell: what a
   * page that arrives part-way through it lays out, so it watches the end of
   * the move instead of finding it made. Null when there is no telling it
   * backwards — nothing flew, the deck was reshuffled, or the state predates
   * `storyFrom`.
   */
  function rewind(game: GameState) {
    const from = game.storyFrom
    if (from === undefined) return null
    const story = game.events.filter((e) => e.id > from)
    if (
      story[0]?.id !== from + 1 ||
      story.some((e) => e.kind === 'shuffle') ||
      !story.some((e) => e.kind === 'play' || e.kind === 'draw')
    )
      return null
    const counts = game.players.map((p) => p.hand.length),
      viewer = state.viewer
    let deck = game.drawPile.length,
      played = 0,
      mine = 0,
      direction = game.direction
    for (const e of story) {
      if (e.player === undefined) continue
      if (e.kind === 'play') {
        counts[e.player]++
        played++
      } else if (e.kind === 'draw') {
        counts[e.player] -= e.count ?? 1
        deck += e.count ?? 1
        if (e.player === viewer) mine += e.count ?? 1
      } else if (e.kind === 'effect' && e.text.startsWith('Direction reversed'))
        direction = direction === 1 ? -1 : 1
    }
    const discardPile = game.discardPile.slice(0, game.discardPile.length - played),
      top = discardPile.at(-1)
    if (!top || counts.some((count) => count < 0)) return null
    const earlier = game.events.filter((e) => e.id <= from),
      opener = story[0],
      actor = opener.kind === 'play' || opener.kind === 'draw' ? opener.player : undefined
    const before: GameState = {
      ...game,
      status: 'playing',
      winner: null,
      currentPlayer: actor ?? game.currentPlayer,
      direction,
      activeColor: top.isWild
        ? (earlier.findLast((e) => e.color)?.color ?? game.activeColor)
        : (top.color as Color),
      discardPile,
      sequence: from,
      events: earlier,
    }
    // Drawn cards join the end of a hand, so the viewer's are its last few.
    const drawn = inDom(viewer) && mine ? game.players[viewer].hand.slice(-mine).map((c) => c.id) : []
    return { view: { ...fromGame(before), counts, deck, arriving: drawn }, story, drawn }
  }

  /**
   * A page arriving `age` ms into the room's last command: the table is laid
   * out as it stood before it, and the command is told from `age` in — part
   * of a card's flight still to go, or nothing left but where it landed.
   */
  function rejoin(game: GameState, age: number) {
    const before = rewind(game)
    if (!before) return snap()
    snap(before.view)
    tell(beatsFor(before.story, [...before.drawn]), game)
    skip(age)
  }

  /**
   * A new round, start to finish: last round's cards are swept back to the
   * deck, the deck is riffled, and seven cards go round the table one at a
   * time before the starting card turns over onto the pile.
   */
  function deal(game: GameState) {
    reset()
    const reduced = reducedMotion(),
      players = game.players.length,
      hands = game.players.map((p) => p.hand.length),
      dealt = hands.reduce((a, b) => a + b, 0),
      mine = inDom(state.viewer) ? game.players[state.viewer].hand.map((c) => c.id) : []
    Object.assign(view, fromGame(game), {
      counts: game.players.map(() => 0),
      deck: game.drawPile.length + dealt + game.discardPile.length,
      top: null,
      arriving: [...mine],
      dealing: true,
    })
    table.setDirection(game.direction)
    emit()
    tell(
      [
        {
          label: 'gather',
          run: () => {
            // Pile cards lie face up and turn over on the way; fan cards already face down.
            const leaving = [
              ...pile.splice(0).map((p) => ({ object: p.object, flip: true })),
              ...fans.flatMap((fan) => fan.splice(0).map((object) => ({ object, flip: false }))),
            ]
            rosette = false
            if (reduced) {
              leaving.forEach(({ object }) => cards.release(object))
              return 0
            }
            if (leaving.length) hear('gather', PILE.x)
            let ms = 0
            leaving.forEach(({ object, flip }, i) => {
              ms = Math.max(
                ms,
                fly(object, deckHome(deck.length, pose()), {
                  flip,
                  ms: 380,
                  height: 0.8,
                  delay: i * 18,
                  onLand: () => cards.release(object),
                }),
              )
            })
            return ms
          },
        },
        {
          label: 'riffle',
          run: () => {
            syncDeck()
            land()
            if (!reduced) return riffle() + 60
            hear('riffle', DECK.x)
            return 0
          },
        },
        {
          label: 'deal',
          run: () => {
            const stagger = reduced ? 22 : players > 2 ? 55 : 75,
              order = Array.from({ length: players }, (_, i) => (state.viewer + 1 + i) % players),
              rounds = Math.max(...hands)
            let k = 0,
              last = 0
            for (let round = 0; round < rounds; round++)
              for (const player of order) {
                if (round >= hands[player]) continue
                const id = inDom(player) ? mine[round] : undefined,
                  delay = k++ * stagger
                if (!delay) last = deliver(player, id, { ms: reduced ? undefined : 420 })
                else
                  tweens.add({
                    duration: 0,
                    delay,
                    update: () => {},
                    done: () => deliver(player, id, { ms: reduced ? undefined : 420 }),
                  })
                last = Math.max(last, delay + (reduced ? 190 : 420))
              }
            return last + 60
          },
        },
        {
          label: 'starter',
          run: () => {
            const card = game.discardPile.at(-1)
            if (!card) return 0
            const object = takeFromDeck()
            cards.face(object, card)
            const ms = fly(object, pileHome(card, pile.length, pose()), {
              flip: true,
              height: 1.2,
              onLand: () => {
                pile.push({ object, card })
                view.top = card
                view.color = game.activeColor
                impact(card, object)
                emit()
              },
            })
            return ms + (reduced ? 40 : 220)
          },
        },
      ],
      game,
    )
  }

  /** How long before now `next.game` began at the room, or 0 when nobody said. */
  const ageOf = (next: TableState) =>
    next.since === undefined ? 0 : Math.max(0, performance.now() - next.since)

  const api: TableApi = {
    update(next) {
      const before = state,
        previous = latest
      const game = next.game,
        tempo = next.tempo
      state = next
      // A change of replay speed applies to the story already under way.
      pace = tempo ? tempo.speed * stretch : 1
      if (
        game === latest &&
        before.viewer === next.viewer &&
        before.watching === next.watching &&
        before.menu === next.menu
      )
        return
      if (
        next.menu ||
        next.instant ||
        before.viewer !== next.viewer ||
        before.watching !== next.watching ||
        before.menu !== next.menu
      ) {
        latest = game
        stretch = 1
        pace = tempo ? tempo.speed : 1
        snap()
        return
      }
      // A replay's next story starts from a table that has finished the last one.
      if (tempo && (queue.busy || tweens.active)) catchUp()
      const age = ageOf(next),
        late = age > LATE_MS
      if (game.round !== previous.round) {
        latest = game
        if (tempo) fit(tempo, dealMs(game))
        deal(game)
        if (late) skip(age)
        return
      }
      if (game.sequence === previous.sequence) {
        latest = game
        if (!queue.busy) {
          // Nothing happened at the table; only the room around it changed.
          view.game = game
          emit()
        }
        return
      }
      const fresh = game.events.filter((e) => e.id > previous.sequence),
        missed = !game.events.length || game.events[0].id > previous.sequence + 1
      const had = new Set(previous.players[state.viewer]?.hand.map((c) => c.id)),
        drawn = inDom(state.viewer)
          ? (game.players[state.viewer]?.hand.map((c) => c.id).filter((id) => !had.has(id)) ?? [])
          : []
      latest = game
      // Not watched live — a reconnect, a tab that slept, events that never
      // arrived: everything before the last command is history, and that one
      // is picked up as far in as the room already is.
      if (late || missed || fresh.length > 40) {
        rejoin(game, age)
        return
      }
      view.arriving.push(...drawn)
      if (tempo) fit(tempo, storyMs(fresh))
      tell(beatsFor(fresh, [...drawn]), game)
      emit()
      // A backlog this long is a page that fell behind: show where things stand.
      if (queue.backlog > 4) catchUp()
    },
    locate(at) {
      const rect = stage.canvas.getBoundingClientRect()
      if (!rect.width || !rect.height) return null
      if (at === 'pile') spot.set(PILE.x, FELT_Y, PILE.z)
      else if (at === 'centre') spot.set(0, FELT_Y, 0)
      else {
        // The middle of the fan, where it rests — a lean toward the pile is a breath, not a move.
        const { x, y, z } = seat(at)
        spot.set(x, y, z)
      }
      stage.toScreen(spot, screen)
      return { x: rect.left + screen.x, y: rect.top + screen.y }
    },
    zoom(amount) {
      zoom = THREE.MathUtils.clamp(zoom + amount, 0.85, 1.25)
      rig.to({ zoom }, reducedMotion() ? 40 : 7)
      stage.invalidate()
    },
    dispose() {
      stopWarming()
      document.removeEventListener('visibilitychange', onVisible)
      queue.clear()
      tweens.cancelAll()
      rig.dispose()
      particles.dispose()
      table.dispose()
      stage.dispose()
      cards.dispose()
    },
  }

  /** Quickens a replay's story that would run past the time its state is on screen. */
  function fit(tempo: NonNullable<TableState['tempo']>, ms: number) {
    stretch = Math.max(1, ms / (tempo.within * tempo.speed * 0.9))
    pace = tempo.speed * stretch
  }

  /** Every waiting story told at once, silently, landing on the newest. */
  function catchUp() {
    quiet = true
    queue.flush()
    tweens.finishAll()
    quiet = false
    emit()
  }
  /** A tab that comes back with a long story to tell skips to the end of it. */
  function onVisible() {
    if (!document.hidden && queue.backlog > 2) catchUp()
  }
  document.addEventListener('visibilitychange', onVisible)

  let lastBreath = 0
  /** One frame of everything the table animates; also how `skip` plays a beat forward. */
  function advance(frame: number, now: number) {
    clock = now
    const dt = frame * pace
    // The queue holds its beats at its own catch-up speed; the tweens follow it.
    const ms = dt * 1000
    tweens.speed = queue.speed
    let moving = tweens.step(ms)
    queue.step(ms)
    // Whoever is on turn leans in toward the pile once the table has caught up.
    const playing = !state.menu && latest.status === 'playing' && !queue.busy && !view.dealing
    const next = playing && !inDom(view.game.currentPlayer) ? view.game.currentPlayer : -1
    if (next !== thinker) {
      thinker = next
      thinkingSince = now
    }
    for (let player = 0; player < latest.players.length; player++) {
      const target = player === thinker ? 1 : 0,
        l = lean[player] ?? 0
      // A device the stage has stepped all the way down leans without breathing.
      const breathing = tier > 0 && player === thinker && now - thinkingSince < 4000
      if (Math.abs(l - target) > 1e-3 || (breathing && now - lastBreath > 32)) {
        lean[player] = Math.abs(l - target) > 1e-3 ? damp(l, target, 6, dt) : target
        if (breathing) lastBreath = now
        layoutFan(player)
      }
    }
    if (restless) {
      let any = false
      for (const object of deck) any = cards.settle(object, dt) || any
      for (const { object } of pile) any = cards.settle(object, dt) || any
      for (const fan of fans) if (fan) for (const object of fan) any = cards.settle(object, dt) || any
      restless = any
      moving = moving || any
    }
    moving = particles.step(dt) || moving
    moving = rig.step(dt) || moving
    return moving || queue.busy
  }
  stage.onFrame((dt, now) => {
    if (!drawn) {
      drawn = true
      // Told once this frame has been rendered, which follows straight on from here.
      queueMicrotask(() => host.ready?.())
    }
    // Long frames the stage capped (shaders compiling just after a join, a
    // stalled thread) left a table that keeps time with the room behind it:
    // play that time forward too, so it lands when everyone else's does.
    const drift = stage.takeDrift()
    if (drift && state.since !== undefined) skip(drift)
    return advance(dt, now)
  })

  // First look. A round only just dealt is dealt again in front of the viewer,
  // from the deck — whole for the page that started it, which arrives within
  // moments, and from as far in as the room already is for one that joins or
  // reloads part-way. A later round is laid out as it stood before the room's
  // last command, which is then told from as far in as the room already is.
  const age = ageOf(initial)
  if (initial.menu || initial.instant) snap()
  else if (freshRound(initial.game)) {
    deal(initial.game)
    if (age > LATE_MS) skip(age)
  } else rejoin(initial.game, age)
  stage.start()
  return api
}
