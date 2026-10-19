/**
 * One audio engine for the whole site, in place of an AudioContext per game.
 * Everything is synthesised — no files, no requests — but through a shared
 * chain that makes simple voices sound like objects in a room: a soft
 * compressor so stacked hits never clip, and a small generated reverb that
 * each voice can send a little of.
 *
 * Games keep their own sound vocabulary and their own mute toggle; they build
 * it from `tone`, `noise` and the presets here, and call `haptic` alongside
 * the sounds that are felt (a die landing, a capture, a bite).
 */
interface Engine {
  context: AudioContext
  input: GainNode
  reverb: GainNode
}

let engine: Engine | null = null
let failed = false

function build(): Engine | null {
  if (engine || failed) return engine
  try {
    const context = new AudioContext()
    const compressor = context.createDynamicsCompressor()
    compressor.threshold.value = -16
    compressor.ratio.value = 4
    compressor.connect(context.destination)
    const input = context.createGain()
    input.gain.value = 0.9
    input.connect(compressor)
    // A short, warm room: decaying noise, darker as it fades.
    const seconds = 1.1,
      impulse = context.createBuffer(2, Math.floor(context.sampleRate * seconds), context.sampleRate)
    for (let channel = 0; channel < 2; channel++) {
      const data = impulse.getChannelData(channel)
      let smooth = 0
      for (let i = 0; i < data.length; i++) {
        const t = i / data.length
        smooth += (Math.random() * 2 - 1 - smooth) * (0.6 - t * 0.5)
        data[i] = smooth * (1 - t) ** 3
      }
    }
    const convolver = context.createConvolver()
    convolver.buffer = impulse
    const reverb = context.createGain()
    reverb.gain.value = 0.55
    reverb.connect(convolver)
    convolver.connect(input)
    engine = { context, input, reverb }
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) void context.suspend().catch(() => {})
      else if (unlocked) void context.resume().catch(() => {})
    })
  } catch {
    failed = true
  }
  return engine
}

let unlocked = false
/**
 * Browsers only start audio inside a user gesture. The first tap or key press
 * anywhere on the site wakes the engine, so a game's first sound is never lost.
 */
function unlock() {
  unlocked = true
  const e = build()
  if (e?.context.state === 'suspended' && !document.hidden) void e.context.resume().catch(() => {})
}
if (typeof window !== 'undefined')
  for (const type of ['pointerdown', 'keydown'] as const)
    window.addEventListener(type, unlock, { capture: true, passive: true })

/** The live engine, or null before the first gesture (or where audio is unavailable). */
function ready() {
  const e = engine
  return e && e.context.state === 'running' ? e : null
}

export interface ToneVoice {
  /** Hz at the start, and optionally where it glides to. */
  freq: number
  to?: number
  type?: OscillatorType
  /** Seconds. */
  duration: number
  volume: number
  /** Seconds from now. */
  at?: number
  attack?: number
  /** -1 left … 1 right. */
  pan?: number
  /** Share sent to the room reverb, 0…1. */
  room?: number
  /** A low-pass that closes as the note decays; makes plucks and knocks woody. */
  cutoff?: number
}

export function tone(voice: ToneVoice) {
  const e = ready()
  if (!e) return
  const { context } = e,
    start = context.currentTime + (voice.at ?? 0),
    end = start + voice.duration
  const oscillator = context.createOscillator(),
    gain = context.createGain()
  oscillator.type = voice.type ?? 'sine'
  oscillator.frequency.setValueAtTime(voice.freq, start)
  if (voice.to) oscillator.frequency.exponentialRampToValueAtTime(voice.to, end)
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(voice.volume, start + (voice.attack ?? 0.004))
  gain.gain.exponentialRampToValueAtTime(0.0001, end)
  let node: AudioNode = oscillator
  if (voice.cutoff) {
    const filter = context.createBiquadFilter()
    filter.type = 'lowpass'
    filter.frequency.setValueAtTime(voice.cutoff, start)
    filter.frequency.exponentialRampToValueAtTime(Math.max(80, voice.cutoff * 0.25), end)
    node.connect(filter)
    node = filter
  }
  node.connect(gain)
  route(e, gain, voice.pan, voice.room)
  oscillator.start(start)
  oscillator.stop(end + 0.02)
  oscillator.onended = () => gain.disconnect()
}

export interface NoiseVoice {
  duration: number
  volume: number
  at?: number
  /** Filter centre in Hz, and optionally where it sweeps to. */
  freq?: number
  to?: number
  filter?: BiquadFilterType
  q?: number
  pan?: number
  room?: number
  attack?: number
}

let noiseBuffer: AudioBuffer | null = null
export function noise(voice: NoiseVoice) {
  const e = ready()
  if (!e) return
  const { context } = e,
    start = context.currentTime + (voice.at ?? 0),
    end = start + voice.duration
  if (!noiseBuffer) {
    noiseBuffer = context.createBuffer(1, context.sampleRate, context.sampleRate)
    const data = noiseBuffer.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
  }
  const source = context.createBufferSource(),
    filter = context.createBiquadFilter(),
    gain = context.createGain()
  source.buffer = noiseBuffer
  source.loop = true
  filter.type = voice.filter ?? 'bandpass'
  filter.frequency.setValueAtTime(voice.freq ?? 1200, start)
  if (voice.to) filter.frequency.exponentialRampToValueAtTime(voice.to, end)
  filter.Q.value = voice.q ?? 1
  gain.gain.setValueAtTime(0.0001, start)
  gain.gain.exponentialRampToValueAtTime(voice.volume, start + (voice.attack ?? 0.003))
  gain.gain.exponentialRampToValueAtTime(0.0001, end)
  source.connect(filter)
  filter.connect(gain)
  route(e, gain, voice.pan, voice.room)
  source.start(start, Math.random() * 0.5)
  source.stop(end + 0.02)
  source.onended = () => gain.disconnect()
}

function route(e: Engine, node: AudioNode, pan = 0, room = 0) {
  let out = node
  if (pan) {
    const panner = e.context.createStereoPanner()
    panner.pan.value = Math.max(-1, Math.min(1, pan))
    node.connect(panner)
    out = panner
  }
  out.connect(e.input)
  if (room > 0) {
    const send = e.context.createGain()
    send.gain.value = room
    out.connect(send)
    send.connect(e.reverb)
  }
}

/**
 * The building blocks most game sounds are made of. `strength` is 0…1 (a die's
 * third bounce is ~0.15); `pitch` multiplies the base frequency.
 */
export const sounds = {
  /** Wood on wood: a die on a tray, a piece set down. */
  knock(strength = 1, pitch = 1, pan = 0) {
    tone({
      freq: 210 * pitch,
      to: 90 * pitch,
      type: 'triangle',
      duration: 0.09,
      volume: 0.07 * strength,
      cutoff: 1800,
      pan,
      room: 0.15,
    })
    noise({ duration: 0.035, volume: 0.05 * strength, freq: 2400 * pitch, q: 1.4, pan })
  },
  /** Something heavier landing: a capture, a jail door, a hotel. */
  thud(strength = 1, pitch = 1, pan = 0) {
    tone({
      freq: 120 * pitch,
      to: 45 * pitch,
      type: 'sine',
      duration: 0.22,
      volume: 0.12 * strength,
      pan,
      room: 0.2,
    })
    noise({ duration: 0.08, volume: 0.05 * strength, freq: 500 * pitch, to: 160, filter: 'lowpass', pan })
  },
  /** A small, bright tick: a step, a rung, a card edge. */
  tick(pitch = 1, volume = 1, pan = 0) {
    tone({
      freq: 880 * pitch,
      to: 520 * pitch,
      type: 'sine',
      duration: 0.05,
      volume: 0.03 * volume,
      pan,
      room: 0.08,
    })
  },
  /** A soft pop for things appearing: a marker, a house, a halo. */
  pop(pitch = 1, volume = 1, pan = 0) {
    tone({
      freq: 380 * pitch,
      to: 760 * pitch,
      type: 'sine',
      duration: 0.09,
      volume: 0.05 * volume,
      attack: 0.006,
      pan,
      room: 0.12,
    })
  },
  /** Air moving: a card flying, a snake sliding, a camera swing. */
  whoosh(duration = 0.3, volume = 1, pan = 0) {
    noise({
      duration,
      volume: 0.035 * volume,
      freq: 400,
      to: 2400,
      q: 0.8,
      attack: duration * 0.4,
      pan,
      room: 0.1,
    })
  },
  /** A short run of bell-like notes; `notes` in Hz, `gap` in seconds. */
  chime(notes: number[], gap = 0.09, volume = 1) {
    notes.forEach((freq, i) => {
      tone({ freq, type: 'sine', duration: 0.7, volume: 0.035 * volume, at: i * gap, room: 0.45 })
      tone({ freq: freq * 2, type: 'sine', duration: 0.35, volume: 0.01 * volume, at: i * gap, room: 0.45 })
    })
  },
  /** Glittering high notes, for a piece reaching home or a bonus. */
  sparkle(volume = 1) {
    for (let i = 0; i < 6; i++)
      tone({
        freq: 1400 + Math.random() * 1600,
        type: 'sine',
        duration: 0.18,
        volume: 0.012 * volume,
        at: i * 0.045 + Math.random() * 0.02,
        pan: Math.random() * 1.2 - 0.6,
        room: 0.5,
      })
  },
  /** A win: a rising arpeggio over a warm chord. */
  fanfare(volume = 1) {
    sounds.chime([392, 494, 587, 784, 988], 0.11, volume)
    for (const freq of [196, 247, 294])
      tone({
        freq,
        type: 'triangle',
        duration: 1.6,
        volume: 0.02 * volume,
        at: 0.5,
        attack: 0.08,
        cutoff: 1400,
        room: 0.5,
      })
  },
}

// Haptics live in their own module so a page can show the switch without
// pulling in the audio engine; games get both from here.
export { canVibrate, haptic, setHaptics, useHaptics } from './haptics'
