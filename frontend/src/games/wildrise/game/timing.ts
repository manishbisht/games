import type { GameState } from './types'

/** Shared animation durations; presentation never changes roll probabilities. */
export function phaseDuration(state: GameState, reduced: boolean) {
  const control = state.players[state.currentPlayer].control
  if (reduced) return { ready: 160, rolling: 180, moving: 60, transporting: 240, settling: 100, won: 0 }[state.phase]
  const speed = control === 'fast' ? 0.55 : 1
  return { ready: control === 'fun' ? 1100 : 700, rolling: 1100, moving: 190, transporting: 1650, settling: 650, won: 0 }[state.phase] * speed
}
