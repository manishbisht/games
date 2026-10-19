import { haptic, noise, sounds, tone } from '../../../motion/audio'

/**
 * Gambit's sounds: a weighted wooden set on a felt-bottomed board. Everything
 * goes through the site's one engine, so a set-down sits in the same small
 * room as every other game's — and stays quiet, because a chess table is.
 */
export type ChessSound =
  /** A piece set down on its square. */
  | 'move'
  /** The captor arriving on its victim: a duller, heavier knock. */
  | 'capture'
  /** The victim (or a beaten king) going over onto the board. */
  | 'fall'
  /** A captured piece coming to rest in the felt of its tray. */
  | 'tray'
  /** A piece lifted off its square. */
  | 'lift'
  | 'check'
  | 'promote'
  | 'end'
  /** One second of the last ten on your own clock. */
  | 'tick'
  /** A clock that has run out. */
  | 'flag'

export interface SoundDetail {
  /** -1 left … 1 right, from where it happened on screen. */
  pan?: number
  /** 0…1; a rematch's pieces going home are each a fraction of a move. */
  strength?: number
}

/** The felt under each piece: a muffled thump under the wood. */
function felt(strength: number, pan: number) {
  noise({ duration: 0.06, volume: 0.05 * strength, freq: 420, to: 140, filter: 'lowpass', pan })
}

export function playChessSound(kind: ChessSound, { pan = 0, strength = 1 }: SoundDetail = {}) {
  // A touch of variety, so ten moves in a row are ten set-downs and not one sample.
  const vary = 0.94 + Math.random() * 0.12
  switch (kind) {
    case 'move':
      sounds.knock(0.55 * strength, 0.82 * vary, pan)
      felt(strength, pan)
      break
    case 'capture':
      sounds.knock(0.6, 0.6 * vary, pan)
      sounds.thud(0.35, 1.5, pan)
      haptic(14)
      break
    case 'fall':
      sounds.thud(0.32 * strength, 1.9 * vary, pan)
      tone({
        freq: 300 * vary,
        to: 150,
        type: 'triangle',
        duration: 0.07,
        volume: 0.03,
        cutoff: 1200,
        pan,
        at: 0.06,
      })
      break
    case 'tray':
      felt(0.7, pan)
      sounds.knock(0.18, 1.1 * vary, pan)
      break
    case 'lift':
      noise({ duration: 0.05, volume: 0.012, freq: 2600, q: 0.9, pan })
      break
    case 'check':
      sounds.knock(0.5, 0.9, pan)
      sounds.chime([659, 784], 0.1, 0.55)
      break
    case 'promote':
      sounds.chime([523, 659, 784, 1046], 0.08, 0.7)
      sounds.sparkle(0.6)
      break
    case 'end':
      sounds.chime([392, 494, 587, 784], 0.12, 0.8)
      haptic([16, 60, 24])
      break
    case 'tick':
      tone({ freq: 1320, to: 1100, type: 'sine', duration: 0.035, volume: 0.012 * strength, room: 0.04 })
      noise({ duration: 0.012, volume: 0.008 * strength, freq: 4200, q: 2 })
      break
    case 'flag':
      sounds.chime([587, 440, 349], 0.16, 0.7)
      sounds.thud(0.3, 1.2)
      haptic([20, 50, 20])
      break
  }
}
