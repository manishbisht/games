import { useEffect, useRef } from 'react'
import type { Dispatch } from 'react'
import { rollDie } from '@games/shared/wildrise'
import { phaseDuration } from '@games/shared/wildrise/timing'
import type { Action, GameState } from '@games/shared/wildrise/types'

/** React owns scheduling; pausing preserves the current phase's remaining time. */
export function useGameClock(
  state: GameState,
  paused: boolean,
  reduced: boolean,
  dispatch: Dispatch<Action>,
) {
  const clock = useRef({ key: '', remaining: 0 })
  useEffect(() => {
    const key = `${state.turn}:${state.phase}:${reduced}`
    if (clock.current.key !== key) clock.current = { key, remaining: phaseDuration(state, reduced) }
    if (
      paused ||
      state.phase === 'won' ||
      (state.phase === 'ready' && state.players[state.currentPlayer].control === 'human')
    )
      return
    const start = performance.now()
    const timer = window.setTimeout(() => {
      const action: Action =
        state.phase === 'ready'
          ? { type: 'ROLL', value: rollDie() }
          : {
              type:
                state.phase === 'rolling'
                  ? 'DICE_SETTLED'
                  : state.phase === 'moving'
                    ? 'MOVE_DONE'
                    : state.phase === 'transporting'
                      ? 'TRANSPORT_DONE'
                      : 'NEXT_TURN',
            }
      dispatch(action)
    }, clock.current.remaining)
    return () => {
      clearTimeout(timer)
      clock.current.remaining = Math.max(0, clock.current.remaining - (performance.now() - start))
    }
  }, [state, paused, reduced, dispatch])
}
