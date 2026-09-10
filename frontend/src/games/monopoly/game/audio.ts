let context: AudioContext | null = null
export function unlockAudio() {
  try {
    context ??= new AudioContext()
    void context.resume()
  } catch {
    /* Audio is an optional enhancement. */
  }
}
export function playSound(type: 'roll' | 'purchase' | 'money') {
  if (!context || context.state !== 'running') return
  const notes = type === 'roll' ? [170, 130, 200, 150] : type === 'purchase' ? [523, 659, 784] : [659, 880]
  notes.forEach((hz, i) => {
    const oscillator = context!.createOscillator(),
      gain = context!.createGain(),
      at = context!.currentTime + i * 0.065
    oscillator.type = type === 'roll' ? 'triangle' : 'sine'
    oscillator.frequency.setValueAtTime(hz, at)
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(0.045, at + 0.008)
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.14)
    oscillator.connect(gain)
    gain.connect(context!.destination)
    oscillator.start(at)
    oscillator.stop(at + 0.16)
    oscillator.onended = () => {
      oscillator.disconnect()
      gain.disconnect()
    }
  })
}
