let context: AudioContext | null = null
export function unlockAudio() {
  try {
    context ??= new AudioContext()
    void context.resume()
  } catch {
    /* Audio is optional. */
  }
}

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
  | 'tumble'
  | 'nope'
  | 'turn'
  | 'win'

interface Voice {
  notes: number[]
  gap: number
  type: OscillatorType
  gain: number
  length: number
  /** Where each note's pitch falls to, as a share of where it started. */
  fall: number
}

const VOICES: Record<Cue, Voice> = {
  shake: { notes: [190, 230], gap: 0.05, type: 'triangle', gain: 0.02, length: 0.07, fall: 0.8 },
  die: { notes: [150], gap: 0, type: 'triangle', gain: 0.06, length: 0.11, fall: 0.6 },
  step: { notes: [420], gap: 0, type: 'sine', gain: 0.024, length: 0.12, fall: 0.75 },
  land: { notes: [170, 128], gap: 0.05, type: 'triangle', gain: 0.05, length: 0.16, fall: 0.7 },
  ladder: { notes: [330, 440, 554, 660], gap: 0.09, type: 'sine', gain: 0.04, length: 0.18, fall: 0.85 },
  rung: { notes: [520], gap: 0, type: 'sine', gain: 0.014, length: 0.07, fall: 0.9 },
  snake: { notes: [420, 340, 250, 160], gap: 0.13, type: 'sine', gain: 0.045, length: 0.2, fall: 0.7 },
  bite: { notes: [880, 260], gap: 0.035, type: 'square', gain: 0.018, length: 0.06, fall: 0.5 },
  tumble: { notes: [300, 380, 240], gap: 0.06, type: 'triangle', gain: 0.035, length: 0.12, fall: 0.8 },
  nope: { notes: [300, 225], gap: 0.13, type: 'triangle', gain: 0.04, length: 0.16, fall: 0.92 },
  turn: { notes: [660, 880], gap: 0.07, type: 'sine', gain: 0.016, length: 0.16, fall: 1 },
  win: { notes: [392, 494, 587, 784, 988], gap: 0.12, type: 'sine', gain: 0.055, length: 0.24, fall: 0.85 },
}

/**
 * `n` colours a cue: which hop of a walk (each a little higher, so a long walk
 * climbs), which rung of a ladder, or how hard the die struck the felt (0..1).
 */
export function sound(kind: Cue, n = 0) {
  if (!context || context.state !== 'running') return
  const voice = VOICES[kind]
  const pitch =
    kind === 'step' ? 1 + Math.min(n, 12) * 0.045 : kind === 'rung' ? 1 + Math.min(n, 16) * 0.06 : 1
  const level = kind === 'die' ? 0.25 + Math.min(1, n) * 0.75 : 1
  voice.notes.forEach((frequency, i) => {
    const oscillator = context!.createOscillator(),
      gain = context!.createGain()
    const t = context!.currentTime + i * voice.gap,
      f = frequency * pitch
    oscillator.type = voice.type
    oscillator.frequency.setValueAtTime(f, t)
    oscillator.frequency.exponentialRampToValueAtTime(f * voice.fall, t + voice.length * 0.7)
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(voice.gain * level, t + 0.008)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + voice.length)
    oscillator.connect(gain)
    gain.connect(context!.destination)
    oscillator.start(t)
    oscillator.stop(t + voice.length + 0.02)
    oscillator.onended = () => {
      oscillator.disconnect()
      gain.disconnect()
    }
  })
}
