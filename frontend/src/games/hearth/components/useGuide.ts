import { useState } from 'react'
import type { GuideStep } from './Guide'

const KEY = 'games-guide-hearth'

function remembered() {
  try {
    return localStorage.getItem(KEY) === 'done'
  } catch {
    return false
  }
}
function remember() {
  try {
    localStorage.setItem(KEY, 'done')
  } catch {
    // Private mode: the guide simply comes back next time.
  }
}

/**
 * The first-game guide's place in the game: whether it is up, which step it
 * is on, and the ways forward — Next, the player doing the thing for real,
 * Skip or Escape. Finishing or skipping is remembered for good; `restart`
 * shows it again without forgetting that.
 */
export function useGuide(steps: GuideStep[]) {
  const [done, setDone] = useState(remembered),
    [step, setStep] = useState(0)
  const close = () => {
    remember()
    setDone(true)
  }
  const next = () => (step + 1 >= steps.length ? close() : setStep(step + 1))
  return {
    done,
    step,
    next,
    close,
    restart() {
      setStep(0)
      setDone(false)
    },
    /** The player just did `action`: if that is what the current step asks for, it is done. */
    did(action: string) {
      if (!done && steps[step]?.action === action) next()
    },
  }
}
