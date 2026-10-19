import { useEffect, useLayoutEffect, useRef } from 'react'
import { ArrowRight, X } from 'lucide-react'
import { rememberGuide } from '../game/guide'

/** A box on screen, in viewport pixels. */
export interface Spot {
  left: number
  top: number
  width: number
  height: number
}

export interface GuideStep {
  title: string
  text: string
  /** What the step points at; the table says where that is, frame by frame. */
  target: string
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max))

/**
 * A first game's coach marks: a ring round the real thing on screen and a
 * small card beside it. Nothing here is modal — the room keeps playing and
 * every control stays live under the ring — so the guide can never cost a
 * player their turn. Escape or Skip closes it for good; so does the last step.
 */
export default function Guide({
  steps,
  step,
  locate,
  floor = () => innerHeight,
  onStep,
  onClose,
}: {
  steps: GuideStep[]
  step: number
  locate: (target: string) => Spot | null
  /** The lowest the card may sit: above a bar fixed to the foot of the screen, say. */
  floor?: () => number
  onStep: (step: number) => void
  onClose: () => void
}) {
  const card = useRef<HTMLDivElement>(null),
    ring = useRef<HTMLDivElement>(null)
  const current = steps[step]
  const last = step === steps.length - 1
  const close = useRef(() => {}),
    target = useRef({ locate, at: current.target, floor })
  useEffect(() => {
    close.current = () => {
      rememberGuide()
      onClose()
    }
    target.current = { locate, at: current.target, floor }
  })

  // Focus comes to the card (not a button, so Space still rolls) and goes back
  // to wherever it was when the guide closes.
  useEffect(() => {
    const before = document.activeElement
    card.current?.focus({ preventScroll: true })
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus({ preventScroll: true })
    }
  }, [])

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      // A dialog over the table takes its own Escape.
      if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return
      event.preventDefault()
      close.current()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [])

  // Bring each step's target into view once, then follow it every frame.
  useEffect(() => {
    const { locate, at } = target.current,
      spot = locate(at)
    if (spot && (spot.top < 0 || spot.top + spot.height > innerHeight))
      scrollBy({ top: spot.top + spot.height / 2 - innerHeight / 2, behavior: 'smooth' })
  }, [step])
  useLayoutEffect(() => {
    let frame = 0
    const place = () => {
      const c = card.current!,
        r = ring.current!
      const { locate, at } = target.current,
        spot = locate(at)
      const vw = document.documentElement.clientWidth,
        floor = target.current.floor() - 12,
        cw = c.offsetWidth,
        ch = c.offsetHeight
      let x = (vw - cw) / 2,
        y = floor - ch
      if (spot) {
        const pad = 6
        r.hidden = false
        r.style.translate = `${Math.round(spot.left - pad)}px ${Math.round(spot.top - pad)}px`
        r.style.width = `${Math.round(spot.width + pad * 2)}px`
        r.style.height = `${Math.round(spot.height + pad * 2)}px`
        x = spot.left + spot.width / 2 - cw / 2
        // Beside the target on the roomier side; failing that, against the
        // far edge of the screen, so the card never sits on what it points at
        // more than it has to.
        const below = spot.top + spot.height + 18,
          above = spot.top - ch - 18,
          downward = spot.top + spot.height / 2 < floor / 2
        y =
          below + ch <= floor && (downward || above < 12)
            ? below
            : above >= 12
              ? above
              : downward
                ? floor - ch
                : 12
      } else r.hidden = true
      c.style.translate = `${Math.round(clamp(x, 12, vw - cw - 12))}px ${Math.round(clamp(y, 12, floor - ch))}px`
      c.dataset.placed = ''
      frame = requestAnimationFrame(place)
    }
    place()
    return () => cancelAnimationFrame(frame)
  }, [])

  return (
    <div className="wr-guide">
      <div ref={ring} className="wr-guide-ring" aria-hidden="true" hidden />
      <div
        ref={card}
        className="wr-guide-card"
        role="dialog"
        aria-modal="false"
        aria-labelledby="wr-guide-title"
        tabIndex={-1}
      >
        <button className="wr-guide-skip" onClick={() => close.current()} aria-label="Close the guide">
          <X size={15} />
        </button>
        <div aria-live="polite">
          <p className="wr-eyebrow">
            FIRST GAME · {step + 1} OF {steps.length}
          </p>
          {/* Keyed on the step, so each one plays its entrance. */}
          <div key={step} className="wr-guide-step">
            <h2 id="wr-guide-title">{current.title}</h2>
            <p>{current.text}</p>
          </div>
        </div>
        <div className="wr-guide-actions">
          <span className="wr-guide-dots" aria-hidden="true">
            {steps.map((s, i) => (
              <i key={s.target} className={i === step ? 'on' : ''} />
            ))}
          </span>
          {!last && (
            <button className="wr-guide-later" onClick={() => close.current()}>
              Skip
            </button>
          )}
          <button className="wr-guide-next" onClick={() => (last ? close.current() : onStep(step + 1))}>
            {last ? 'Let’s play' : 'Next'} <ArrowRight size={15} />
          </button>
        </div>
      </div>
    </div>
  )
}
