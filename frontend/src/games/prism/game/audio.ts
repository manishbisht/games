let context: AudioContext | null = null
export function sound(kind: 'play' | 'draw' | 'effect' | 'call' | 'win' | 'shuffle' | 'info') {
  try {
    context ??= new AudioContext()
    if (context.state === 'suspended') void context.resume()
    const notes =
      kind === 'win'
        ? [392, 494, 587, 784]
        : kind === 'call'
          ? [587, 784]
          : kind === 'effect'
            ? [330, 440]
            : kind === 'draw'
              ? [240]
              : [340]
    notes.forEach((frequency, index) => {
      const source = context!.createOscillator(),
        gain = context!.createGain(),
        t = context!.currentTime + index * 0.09
      source.type = 'sine'
      source.frequency.setValueAtTime(frequency, t)
      source.frequency.exponentialRampToValueAtTime(frequency * 0.65, t + 0.1)
      gain.gain.setValueAtTime(0, t)
      gain.gain.linearRampToValueAtTime(0.055, t + 0.009)
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.2)
      source.connect(gain)
      gain.connect(context!.destination)
      source.start(t)
      source.stop(t + 0.21)
    })
  } catch {
    /* Audio is optional; browser autoplay policy must not interrupt a turn. */
  }
}
