import { noise, sounds, tone } from '../../../motion/audio'

/**
 * The table's sounds, built on the site's one audio engine: card stock
 * snapping and sliding on felt, a riffle you can count, air moving for a wild.
 * Each is a few quiet voices with a little variation, so a deal of twenty-eight
 * cards sounds dealt rather than looped.
 */
export type SoundKind =
  | 'lift'
  | 'flick'
  | 'land'
  | 'play'
  | 'action'
  | 'gather'
  | 'riffle'
  | 'wild'
  | 'reverse'
  | 'skip'
  | 'penalty'
  | 'call'
  | 'win'

/** ±`spread` around 1, so no two cards sound quite alike. */
const vary = (spread = 0.08) => 1 + (Math.random() * 2 - 1) * spread

/** A card brushing across the felt: soft, dark, over in a breath. */
function brush(volume: number, pan: number, duration = 0.14, at = 0) {
  noise({
    duration,
    volume: 0.022 * volume,
    freq: 1500 * vary(),
    to: 420,
    filter: 'lowpass',
    q: 0.5,
    attack: duration * 0.35,
    pan,
    at,
  })
}

/** Card stock snapping onto card stock, with the felt's dull thump under it. */
function snap(strength: number, pan: number) {
  const pitch = vary(0.06)
  noise({ duration: 0.045, volume: 0.06 * strength, freq: 2100 * pitch, q: 0.9, pan, room: 0.1 })
  tone({
    freq: 150 * pitch,
    to: 68,
    type: 'triangle',
    duration: 0.1,
    volume: 0.05 * strength,
    cutoff: 900,
    pan,
    room: 0.12,
  })
}

const VOICES: Record<SoundKind, (pan: number) => void> = {
  /** A card leaves a hand or a fan. */
  lift: (pan) => brush(0.9, pan),
  /** A card snapped off the top of the deck: the deal and every draw. */
  flick(pan) {
    noise({ duration: 0.026, volume: 0.028, freq: 3300 * vary(0.12), q: 1.6, pan })
    brush(0.5, pan, 0.1, 0.02)
  },
  /** A card settling into a fan, face down. */
  land(pan) {
    noise({ duration: 0.055, volume: 0.022, freq: 850 * vary(), filter: 'lowpass', pan })
    tone({ freq: 170 * vary(), to: 95, type: 'triangle', duration: 0.05, volume: 0.012, cutoff: 600, pan })
  },
  play: (pan) => snap(1, pan),
  /** An action card lands heavier, with a bright edge to it. */
  action(pan) {
    snap(1.25, pan)
    sounds.tick(1.5 * vary(0.04), 0.9, pan)
  },
  /** The pile swept back into the deck. */
  gather(pan) {
    sounds.whoosh(0.32, 0.6, pan)
    brush(1.1, pan, 0.3, 0.05)
  },
  /**
   * The riffle, timed to the deck's own: the halves split with a brush, the
   * cards fall back together as a run of ticks that quickens and crosses from
   * one side to the other, and the squared deck taps down.
   */
  riffle() {
    brush(1, -0.15, 0.2)
    const ticks = 26
    for (let i = 0; i < ticks; i++) {
      const t = i / (ticks - 1)
      noise({
        duration: 0.012,
        volume: 0.016 * (0.7 + Math.random() * 0.6),
        freq: 3800 * vary(0.15),
        q: 2,
        at: 0.27 + 0.36 * (1 - (1 - t) ** 1.4),
        pan: -0.35 + t * 0.7,
      })
    }
    noise({ duration: 0.07, volume: 0.035, freq: 600, filter: 'lowpass', at: 0.7 })
    tone({ freq: 130, to: 75, type: 'triangle', duration: 0.08, volume: 0.03, cutoff: 700, at: 0.7 })
  },
  /** A wild's shockwave: air rushing out over the table, a swell under it and a glint on top. */
  wild(pan) {
    noise({ duration: 0.8, volume: 0.05, freq: 260, to: 3200, q: 0.7, attack: 0.22, pan, room: 0.35 })
    tone({ freq: 110, to: 220, type: 'sine', duration: 0.7, volume: 0.035, attack: 0.12, room: 0.3 })
    sounds.chime([1047, 1319, 1568], 0.06, 0.55)
  },
  /** The direction ring turning over: a whirr that rises and comes back down. */
  reverse(pan) {
    sounds.whoosh(0.45, 0.6, pan)
    tone({ freq: 400, to: 720, type: 'triangle', duration: 0.2, volume: 0.025, cutoff: 2200, pan, room: 0.2 })
    tone({
      freq: 720,
      to: 380,
      type: 'triangle',
      duration: 0.24,
      volume: 0.022,
      cutoff: 2200,
      at: 0.18,
      pan,
      room: 0.2,
    })
  },
  /** A seat is paused: a rubber stamp coming down. */
  skip(pan) {
    sounds.thud(0.5, 1.5, pan)
    sounds.knock(0.7, 1.25, pan)
  },
  /** A penalty: two falling notes, the table's "oh dear". */
  penalty(pan) {
    tone({ freq: 330, type: 'triangle', duration: 0.18, volume: 0.035, cutoff: 1800, pan, room: 0.25 })
    tone({
      freq: 247,
      type: 'triangle',
      duration: 0.26,
      volume: 0.035,
      cutoff: 1500,
      at: 0.13,
      pan,
      room: 0.3,
    })
  },
  call() {
    sounds.chime([784, 1175], 0.08, 1.1)
    sounds.sparkle(0.6)
  },
  win() {
    sounds.fanfare(1)
    sounds.sparkle(0.8)
  },
}

/** `pan` is -1 (the left of the table) to 1 (the right). */
export function sound(kind: SoundKind, pan = 0) {
  VOICES[kind](pan)
}
