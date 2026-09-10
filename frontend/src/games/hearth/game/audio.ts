export type Sound = 'roll' | 'land' | 'step' | 'capture' | 'home' | 'win'

// Quiet, original synthesized sounds. No media requests or audio dependency.
export function createAudio() {
  let context: AudioContext | null = null
  const active = new Set<OscillatorNode>()
  function unlock() {
    try {
      if (!context && typeof window.AudioContext !== 'undefined') context = new AudioContext()
      if (context?.state === 'suspended') void context.resume().catch(() => {})
    } catch {
      /* Audio is optional, including on restrictive mobile browsers. */
    }
  }
  function tone(
    frequency: number,
    when: number,
    duration: number,
    volume: number,
    type: OscillatorType = 'sine',
    endFrequency?: number,
  ) {
    if (!context || context.state !== 'running') return
    const oscillator = context.createOscillator(),
      gain = context.createGain(),
      start = context.currentTime + when
    oscillator.type = type
    oscillator.frequency.setValueAtTime(frequency, start)
    if (endFrequency) oscillator.frequency.exponentialRampToValueAtTime(endFrequency, start + duration)
    gain.gain.setValueAtTime(0.001, start)
    gain.gain.linearRampToValueAtTime(volume, start + 0.005)
    gain.gain.exponentialRampToValueAtTime(0.001, start + duration)
    oscillator.connect(gain)
    gain.connect(context.destination)
    active.add(oscillator)
    oscillator.onended = () => {
      oscillator.disconnect()
      gain.disconnect()
      active.delete(oscillator)
    }
    oscillator.start(start)
    oscillator.stop(start + duration + 0.01)
  }
  function play(sound: Sound) {
    if (!context || context.state !== 'running') return
    if (sound === 'roll')
      for (let i = 0; i < 6; i++) tone(190 + i * 23, i * 0.085, 0.045, 0.022, 'triangle', 70)
    if (sound === 'land') tone(160, 0, 0.1, 0.06, 'triangle', 55)
    if (sound === 'step') tone(510, 0, 0.05, 0.024, 'sine', 270)
    if (sound === 'capture') {
      tone(360, 0, 0.16, 0.05, 'triangle', 100)
      tone(190, 0.1, 0.19, 0.028, 'sine', 90)
    }
    if (sound === 'home' || sound === 'win') {
      const notes = sound === 'win' ? [392, 494, 587, 784, 988, 1175] : [523, 659, 784]
      notes.forEach((note, i) => tone(note, i * 0.12, 0.45, 0.026, 'sine'))
    }
  }
  function stop() {
    for (const oscillator of active) {
      try {
        oscillator.stop()
      } catch {
        /* Already ended. */
      }
    }
    active.clear()
  }
  function dispose() {
    stop()
    if (context) void context.close().catch(() => {})
    context = null
  }
  return { unlock, play, stop, dispose }
}
