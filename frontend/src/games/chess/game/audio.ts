let context: AudioContext | null = null
export function playChessSound(kind: 'move' | 'capture' | 'check' | 'end') {
  try {
    context ??= new AudioContext()
    if (context.state === 'suspended') void context.resume()
    const now = context.currentTime
    const tones =
      kind === 'end'
        ? [440, 554, 659]
        : kind === 'check'
          ? [440, 520]
          : kind === 'capture'
            ? [150, 110]
            : [200]
    tones.forEach((frequency, i) => {
      const oscillator = context!.createOscillator(),
        gain = context!.createGain(),
        time = now + i * 0.09
      oscillator.type = kind === 'move' || kind === 'capture' ? 'sine' : 'triangle'
      oscillator.frequency.setValueAtTime(frequency, time)
      oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.55, time + 0.12)
      gain.gain.setValueAtTime(0, time)
      gain.gain.linearRampToValueAtTime(0.08, time + 0.005)
      gain.gain.exponentialRampToValueAtTime(0.001, time + 0.2)
      oscillator.connect(gain)
      gain.connect(context!.destination)
      oscillator.start(time)
      oscillator.stop(time + 0.21)
    })
  } catch {
    /* Sound is optional when the browser blocks audio. */
  }
}
