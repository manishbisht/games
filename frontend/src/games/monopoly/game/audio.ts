import { haptic, noise, sounds, tone } from '../../../motion/audio'

/**
 * Every sound the table makes, built on the site's one audio engine so they
 * read as objects on a table rather than beeps: wooden dice on the board, a
 * felt-footed token stepping, brass coins, a paper card, a cell door. `strength`
 * is 0…1 — a die's third bounce is quieter than its first — and `pan` places a
 * sound where it happened on the board, -1 left … 1 right.
 */
export type Sound =
  'roll' | 'purchase' | 'money' | 'coin' | 'tap' | 'step' | 'build' | 'card' | 'go' | 'jail' | 'win'

/** Two inharmonic partials that die fast: brass on brass. */
function clink(at: number, pitch: number, volume: number, pan: number) {
  tone({ freq: 2350 * pitch, type: 'sine', duration: 0.16, volume: 0.022 * volume, at, pan, room: 0.25 })
  tone({ freq: 3710 * pitch, type: 'sine', duration: 0.09, volume: 0.012 * volume, at, pan, room: 0.25 })
  noise({ duration: 0.02, volume: 0.02 * volume, freq: 6500, q: 2, at, pan })
}

const VOICES: Record<Sound, (strength: number, pan: number) => void> = {
  // The dice rattled in a cupped hand, then let go.
  roll: (s, pan) => {
    for (let i = 0; i < 4; i++)
      tone({
        freq: 300 + i * 37,
        to: 140,
        type: 'triangle',
        duration: 0.05,
        volume: 0.028 * s,
        at: i * 0.055,
        cutoff: 2200,
        pan,
      })
    noise({ duration: 0.22, volume: 0.02 * s, freq: 1800, q: 0.7, attack: 0.03, pan })
    sounds.whoosh(0.28, 0.6 * s, pan)
  },
  // A die meeting the board: wood on card-covered wood.
  tap: (s, pan) => sounds.knock(s, 1.15, pan),
  // A token's felt foot on a tile: barely there, a little higher for the last step.
  step: (s, pan) => {
    tone({
      freq: 340 + s * 80,
      to: 160,
      type: 'triangle',
      duration: 0.06,
      volume: 0.03 * s,
      cutoff: 1300,
      pan,
    })
    noise({ duration: 0.03, volume: 0.016 * s, freq: 900, q: 0.8, filter: 'lowpass', pan })
  },
  // A deed stamped and handed over, with a warm little run.
  purchase: (s, pan) => {
    sounds.thud(0.35 * s, 1.5, pan)
    sounds.chime([523, 659, 784], 0.07, 0.8 * s)
  },
  // Money changing hands: a purse of coins settling.
  money: (s, pan) => {
    for (let i = 0; i < 3; i++)
      clink(i * 0.06 + Math.random() * 0.02, 0.92 + Math.random() * 0.16, 0.7 * s, pan)
  },
  // One coin landing on a pile.
  coin: (s, pan) => clink(0, 0.9 + Math.random() * 0.25, s, pan),
  // A house set down on its lot.
  build: (s, pan) => {
    sounds.knock(0.9 * s, 0.75, pan)
    sounds.pop(1.3, 0.8 * s, pan)
  },
  // A card slid off the deck and turned over.
  card: (s, pan) => {
    noise({
      duration: 0.18,
      volume: 0.03 * s,
      freq: 2400,
      to: 5200,
      q: 0.6,
      filter: 'highpass',
      attack: 0.04,
      pan,
    })
    sounds.tick(1.4, 0.8 * s, pan)
  },
  // A lap of GO: a bright run, and the bank's coins.
  go: (s, pan) => {
    sounds.chime([784, 988, 1175], 0.07, 0.8 * s)
    for (let i = 0; i < 2; i++) clink(0.12 + i * 0.07, 1.05, 0.6 * s, pan)
  },
  // The cell door: a heavy landing and a ringing bar.
  jail: (s, pan) => {
    sounds.thud(s, 0.8, pan)
    tone({
      freq: 196,
      type: 'square',
      duration: 0.5,
      volume: 0.012 * s,
      cutoff: 1100,
      at: 0.02,
      pan,
      room: 0.4,
    })
    tone({ freq: 523, type: 'sine', duration: 0.6, volume: 0.014 * s, at: 0.03, pan, room: 0.5 })
    tone({ freq: 737, type: 'sine', duration: 0.4, volume: 0.008 * s, at: 0.03, pan, room: 0.5 })
  },
  win: (s) => sounds.fanfare(s),
}

export function playSound(type: Sound, strength = 1, pan = 0) {
  VOICES[type](Math.max(0.15, Math.min(1, strength)), pan)
}

/**
 * The few moments worth feeling on a phone: the die coming down hard, the cell
 * door, and the win. Independent of the sound switch — the site's haptics
 * setting governs these.
 */
export function feel(type: Sound, strength = 1) {
  if (type === 'tap' && strength >= 0.9) haptic(12)
  else if (type === 'jail') haptic([18, 60, 26])
  else if (type === 'win') haptic([20, 70, 20, 70, 40])
}
