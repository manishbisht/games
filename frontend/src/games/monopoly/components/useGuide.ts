import { useState } from 'react'

/** Where the site remembers that a game's first-game guide has been seen. */
export const guideKey = (game: string) => `games-guide-${game}`

function seen(game: string) {
  try {
    return localStorage.getItem(guideKey(game)) === 'done'
  } catch {
    return true
  }
}

function remember(game: string, done: boolean) {
  try {
    if (done) localStorage.setItem(guideKey(game), 'done')
    else localStorage.removeItem(guideKey(game))
  } catch {
    // Private mode: the guide simply shows again next time.
  }
}

/** A box on screen, in viewport pixels. */
export interface ScreenBox {
  left: number
  top: number
  width: number
  height: number
}

export interface GuideStep {
  title: string
  text: string
  /** What the step points at, right now; `null` when it is off the page. */
  target: () => ScreenBox | null
  /**
   * The real action that finishes this step, when there is one: once `armed`
   * has been true (the action became possible), `done` turning true moves on —
   * so "Roll the dice" completes when the dice are rolled, not when Next is.
   */
  armed?: boolean
  done?: boolean
}

/**
 * A game's first-game guide: whether it is up, which step it is on, and the
 * way to bring it back. It opens once `ready` (a seat at a live table — never
 * for someone watching) unless this browser has finished or skipped it before.
 */
export function useGuide(game: string, ready: boolean, steps: GuideStep[]) {
  const [state, setState] = useState(() => ({ open: false, step: 0, armed: -1, dismissed: seen(game) }))
  if (ready && !state.open && !state.dismissed) setState({ ...state, open: true, step: 0, armed: -1 })
  const current = state.open ? steps[state.step] : undefined
  if (current?.armed && state.armed !== state.step) setState({ ...state, armed: state.step })
  else if (current?.done && state.armed === state.step) {
    if (state.step + 1 < steps.length) setState({ ...state, step: state.step + 1 })
    else {
      remember(game, true)
      setState({ ...state, open: false, dismissed: true })
    }
  }
  const close = () => {
    remember(game, true)
    setState((now) => ({ ...now, open: false, dismissed: true }))
  }
  return {
    open: state.open && ready,
    step: state.step,
    next: () => {
      if (state.step + 1 < steps.length) setState((now) => ({ ...now, step: now.step + 1 }))
      else close()
    },
    close,
    /** From the rules: again from the top — now, if a table is up, or at the next one. */
    restart: () => {
      remember(game, false)
      setState({ open: false, step: 0, armed: -1, dismissed: false })
    },
  }
}
