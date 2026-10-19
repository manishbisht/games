import { useEffect, useRef } from 'react'
import { ArrowRight, X } from 'lucide-react'
import { reducedMotion } from '../../../motion/preference'

/** A box on the page, in viewport pixels. */
export interface Spot {
  left: number
  top: number
  width: number
  height: number
}

export interface GuideStep {
  id: string
  text: string
  /**
   * What the step points at right now: the element to bring into view, and
   * optionally a smaller spot inside it (a court on the board). `null` when it
   * is not on the page, and the card then waits at the foot of the screen.
   */
  target: () => { element: Element; spot?: Spot } | null
  /** Done when the player does this for real (see `useGuide().did`), as well as on Next. */
  action?: string
}

const GAP = 12,
  PAD = 6

/**
 * One coach mark: a soft spotlight on the real thing and a card beside it
 * with a sentence and Next/Skip. Nothing here takes the table away from the
 * player — the spotlight lets every click through, the card is not modal, and
 * the room plays on underneath — so it can sit through a live turn.
 *
 * The spotlight follows its target every frame (the camera swings, the page
 * scrolls, a panel reflows) by writing positions straight to the DOM.
 */
export default function Guide({
  steps,
  step,
  onNext,
  onClose,
}: {
  steps: GuideStep[]
  step: number
  onNext: () => void
  onClose: () => void
}) {
  const card = useRef<HTMLDivElement>(null),
    ring = useRef<HTMLDivElement>(null)
  const current = steps[step],
    last = step === steps.length - 1
  const latest = useRef(current)
  useEffect(() => {
    latest.current = current
  })

  // Focus moves to the card while it is up, and back to wherever it was after. The card itself takes it
  // (not a button), so Space still rolls the die from here.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null,
      panel = card.current
    panel?.focus({ preventScroll: true })
    return () => {
      if (panel?.contains(document.activeElement) || document.activeElement === document.body)
        before?.focus?.({ preventScroll: true })
    }
  }, [])

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])

  // Each step brings what it points at into view, once — after that the page is the player's to scroll.
  useEffect(() => {
    const element = latest.current.target()?.element
    const box = element?.getBoundingClientRect()
    if (box && (box.top < 0 || box.bottom > window.innerHeight))
      element!.scrollIntoView({
        // Something small comes to the middle, leaving room round it for the card; the board only as far as it must.
        block: box.height < window.innerHeight * 0.5 ? 'center' : 'nearest',
        behavior: reducedMotion() ? 'auto' : 'smooth',
      })
  }, [step])

  useEffect(() => {
    let frame = 0
    const follow = () => {
      frame = requestAnimationFrame(follow)
      const panel = card.current,
        light = ring.current
      if (!panel || !light) return
      const found = latest.current.target()
      const spot = found?.spot ?? found?.element.getBoundingClientRect()
      const width = panel.offsetWidth,
        height = panel.offsetHeight,
        viewW = window.innerWidth,
        viewH = window.innerHeight
      let x = (viewW - width) / 2,
        y = viewH - height - 16
      if (spot && spot.width > 0) {
        light.style.opacity = '1'
        light.style.translate = `${spot.left - PAD}px ${spot.top - PAD}px`
        light.style.width = `${spot.width + PAD * 2}px`
        light.style.height = `${spot.height + PAD * 2}px`
        x = Math.min(Math.max(16, spot.left + spot.width / 2 - width / 2), viewW - width - 16)
        const below = spot.top + spot.height + PAD + GAP,
          above = spot.top - PAD - GAP - height
        // Below if it fits, above if that fits, otherwise wherever overlaps the least.
        y =
          below + height <= viewH - 8
            ? below
            : above >= 8
              ? above
              : Math.min(Math.max(8, below), viewH - height - 8)
      } else light.style.opacity = '0'
      panel.style.translate = `${Math.round(x)}px ${Math.round(y)}px`
    }
    follow()
    return () => cancelAnimationFrame(frame)
  }, [])

  return (
    <div className="hh-guide">
      <div className="hh-guide-ring" ref={ring} aria-hidden="true" />
      <div
        className="hh-guide-card"
        ref={card}
        role="dialog"
        aria-modal="false"
        aria-label="Game guide"
        tabIndex={-1}
      >
        <div className="hh-guide-head">
          <span className="hh-eyebrow">
            FIRST GAME · {step + 1} OF {steps.length}
          </span>
          <button className="hh-guide-close" aria-label="Close the guide" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        <p className="hh-guide-text" aria-live="polite">
          {/* Keyed, so each step's sentence plays its entrance; the live region itself stays put. */}
          <span key={current.id}>{current.text}</span>
        </p>
        <div className="hh-guide-actions">
          <span className="hh-guide-dots" aria-hidden="true">
            {steps.map((s, i) => (
              <i key={s.id} className={i === step ? 'on' : ''} />
            ))}
          </span>
          {!last && (
            <button className="hh-guide-skip" onClick={onClose}>
              Skip
            </button>
          )}
          <button className="hh-guide-next" onClick={onNext}>
            {last ? 'Let’s play' : 'Next'}
            {!last && <ArrowRight size={14} />}
          </button>
        </div>
      </div>
    </div>
  )
}
