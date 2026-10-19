let context: AudioContext | null = null
export function unlockAudio() {
  try {
    context ??= new AudioContext()
    void context.resume()
  } catch {
    /* Audio is an optional enhancement. */
  }
}

/**
 * Every sound the table makes, as a few short oscillator notes. `tap` is a
 * piece meeting the board — a die's bounce or a token's step — and takes a
 * strength so a die's third bounce is quieter than its first.
 */
export type Sound = 'roll' | 'purchase' | 'money' | 'tap' | 'build' | 'card' | 'jail' | 'win'
const VOICES: Record<Sound, { notes: number[]; wave: OscillatorType; gap: number; length: number }> = {
  roll: { notes: [170, 130, 200, 150], wave: 'triangle', gap: 0.065, length: 0.14 },
  purchase: { notes: [523, 659, 784], wave: 'sine', gap: 0.065, length: 0.14 },
  money: { notes: [659, 880], wave: 'sine', gap: 0.065, length: 0.14 },
  tap: { notes: [210], wave: 'triangle', gap: 0, length: 0.07 },
  build: { notes: [330, 262], wave: 'triangle', gap: 0.05, length: 0.1 },
  card: { notes: [880, 1175], wave: 'sine', gap: 0.08, length: 0.12 },
  jail: { notes: [196, 147, 110], wave: 'square', gap: 0.09, length: 0.16 },
  win: { notes: [523, 659, 784, 1047], wave: 'sine', gap: 0.11, length: 0.3 },
}

export function playSound(type: Sound, strength = 1) {
  if (!context || context.state !== 'running') return
  const voice = VOICES[type],
    peak = (type === 'jail' ? 0.018 : 0.045) * Math.max(0.15, Math.min(1, strength))
  voice.notes.forEach((hz, i) => {
    const oscillator = context!.createOscillator(),
      gain = context!.createGain(),
      at = context!.currentTime + i * voice.gap
    oscillator.type = voice.wave
    oscillator.frequency.setValueAtTime(hz, at)
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(peak, at + 0.008)
    gain.gain.exponentialRampToValueAtTime(0.001, at + voice.length)
    oscillator.connect(gain)
    gain.connect(context!.destination)
    oscillator.start(at)
    oscillator.stop(at + voice.length + 0.02)
    oscillator.onended = () => {
      oscillator.disconnect()
      gain.disconnect()
    }
  })
}
