let context: AudioContext | null = null
export function unlockAudio() {
  try { context ??= new AudioContext(); void context.resume() } catch { /* Audio is optional. */ }
}
export function sound(kind: 'roll' | 'land' | 'step' | 'ladder' | 'snake' | 'win') {
  if (!context || context.state !== 'running') return
  const notes = kind === 'win' ? [392, 494, 587, 784, 988] : kind === 'ladder' ? [330, 440, 554, 660] : kind === 'snake' ? [420, 340, 250, 160] : kind === 'roll' ? [170, 200, 150, 190] : kind === 'step' ? [420] : [160]
  notes.forEach((frequency, i) => {
    const oscillator = context!.createOscillator(), gain = context!.createGain()
    const t = context!.currentTime + i * (kind === 'roll' ? 0.07 : 0.12)
    oscillator.type = kind === 'roll' || kind === 'land' ? 'triangle' : 'sine'
    oscillator.frequency.setValueAtTime(frequency, t)
    oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.75, t + 0.12)
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.exponentialRampToValueAtTime(kind === 'step' ? 0.022 : 0.055, t + 0.01)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.19)
    oscillator.connect(gain); gain.connect(context!.destination)
    oscillator.start(t); oscillator.stop(t + 0.2)
    oscillator.onended = () => { oscillator.disconnect(); gain.disconnect() }
  })
}
