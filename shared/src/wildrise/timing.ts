import type { GameState } from './types'

/** Shared animation durations; presentation never changes roll probabilities. */
export function phaseDuration(state: GameState, reduced: boolean) {
  const control = state.players[state.currentPlayer].control
  // One beat covers the whole walk, so `moving` is priced by the squares it crosses.
  const steps = Math.max(1, state.motion?.path.length ?? 1)
  if (reduced)
    return { ready: 160, rolling: 180, moving: 60 * steps, transporting: 240, settling: 100, won: 0 }[
      state.phase
    ]
  const speed = control === 'fast' ? 0.55 : 1
  return (
    {
      ready: control === 'fun' ? 1100 : 700,
      rolling: 1100,
      moving: 190 * steps,
      transporting: 1650,
      settling: 650,
      won: 0,
    }[state.phase] * speed
  )
}
