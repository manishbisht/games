import { haptic, noise, sounds, tone } from '../../../motion/audio'

/**
 * Every sound the table makes, each cued by the board at the moment it happens
 * on screen rather than when the server's state arrived: a step per hop, a
 * click per rung, a knock per bounce of the die.
 */
export type Cue =
  | 'shake'
  | 'die'
  | 'step'
  | 'land'
  | 'ladder'
  | 'rung'
  | 'snake'
  | 'bite'
  | 'slide'
  | 'tumble'
  | 'nope'
  | 'turn'
  | 'win'

/** A wooden knock that can be scheduled: a token's base on a tile, a rung under a foot. */
function wood(strength: number, pitch: number, at = 0, pan = 0) {
  tone({
    freq: 240 * pitch,
    to: 110 * pitch,
    type: 'triangle',
    duration: 0.08,
    volume: 0.06 * strength,
    cutoff: 1500 * pitch,
    at,
    pan,
    room: 0.14,
  })
  noise({ duration: 0.025, volume: 0.035 * strength, freq: 2600 * pitch, q: 1.6, at, pan })
}

/** One little bird: a quick upward chirp, sometimes answered. */
function chirp(at: number, base: number, pan: number) {
  for (let i = 0; i < 2; i++)
    tone({
      freq: base * (1 + i * 0.06),
      to: base * 1.45,
      type: 'sine',
      duration: 0.07,
      volume: 0.014,
      at: at + i * 0.085,
      attack: 0.01,
      pan,
      room: 0.4,
    })
}

/**
 * The table's vocabulary, built from the site's audio engine so it sounds like
 * the objects on the table: a hardwood die on felt, a miniature's base on a
 * wooden tile, rungs, a hiss and a snap. `n` colours a cue — which hop of a
 * walk (each a shade higher, so a long walk climbs), which rung, how hard the
 * die struck the felt (0..1), or how long a slide lasts in ms. `pan` is where
 * on screen it happened, -1 left to 1 right.
 */
export function sound(kind: Cue, n = 0, pan = 0) {
  switch (kind) {
    case 'shake':
      // A die rattling in a cupped hand: four quick, uneven clicks.
      for (let i = 0; i < 4; i++)
        noise({
          duration: 0.03,
          volume: 0.025,
          freq: 2800 + i * 400,
          q: 2,
          at: i * 0.06 + (i % 2) * 0.012,
          pan,
        })
      return
    case 'die':
      // Hardwood on felt: the felt swallows the top end, the tray thumps under it.
      sounds.knock(0.35 + Math.min(1, n) * 0.65, 1.15, pan)
      noise({ duration: 0.06, volume: 0.03 * n, freq: 380, to: 140, filter: 'lowpass', pan })
      if (n > 0.5) haptic(14)
      return
    case 'step':
      // A soft footfall: a padded thump with a little tick of the tile under it.
      noise({ duration: 0.07, volume: 0.03, freq: 700, to: 220, filter: 'lowpass', pan })
      wood(0.32, 1.5 + Math.min(n, 12) * 0.05, 0.005, pan)
      return
    case 'land':
      wood(0.9, 0.95, 0, pan)
      sounds.thud(0.3, 1.2, pan)
      return
    case 'ladder':
      // A bright little lift as the climb begins.
      sounds.chime([523, 659, 784], 0.07, 0.55)
      return
    case 'rung': {
      const pitch = 1 + Math.min(n, 16) * 0.05
      tone({
        freq: 820 * pitch,
        to: 560 * pitch,
        type: 'triangle',
        duration: 0.05,
        volume: 0.03,
        cutoff: 3000,
        pan,
        room: 0.1,
      })
      noise({ duration: 0.015, volume: 0.02, freq: 4200, q: 2.5, pan })
      return
    }
    case 'snake':
      // The hiss as it rears: breath through teeth, rising and falling away.
      noise({
        duration: 0.55,
        volume: 0.03,
        freq: 5200,
        to: 7400,
        filter: 'bandpass',
        q: 1.8,
        attack: 0.12,
        pan,
        room: 0.15,
      })
      return
    case 'bite':
      // The snap: a sharp click of the jaw and a soft body-blow under it.
      noise({ duration: 0.02, volume: 0.06, freq: 3600, q: 3, pan })
      tone({ freq: 1500, to: 380, type: 'triangle', duration: 0.05, volume: 0.03, cutoff: 3200, pan })
      sounds.thud(0.4, 1.5, pan)
      haptic([12, 40, 18])
      return
    case 'slide':
      // Scales on wood for as long as the ride lasts.
      sounds.whoosh(Math.max(0.3, n / 1000), 0.9, pan)
      noise({
        duration: Math.max(0.3, n / 1000),
        volume: 0.012,
        freq: 1800,
        to: 900,
        q: 0.7,
        attack: 0.15,
        pan,
      })
      return
    case 'tumble':
      sounds.whoosh(0.16, 0.6, pan)
      wood(0.6, 1.1, 0.12, pan)
      wood(0.35, 1.25, 0.2, pan)
      return
    case 'nope':
      // A two-knock "uh-uh", falling.
      wood(0.55, 0.85, 0, pan)
      wood(0.45, 0.7, 0.14, pan)
      return
    case 'turn':
      sounds.pop(1.25, 0.45)
      return
    case 'win':
      // The summit: a fanfare under a sparkle, and the woods answering.
      sounds.fanfare(0.85)
      sounds.sparkle(0.8)
      for (let i = 0; i < 5; i++)
        chirp(0.55 + i * 0.32 + (i % 2) * 0.07, 2600 + (i % 3) * 420, i % 2 ? 0.5 : -0.4)
      haptic([20, 50, 20, 50, 30])
      return
  }
}
