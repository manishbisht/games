import { useEffect, useLayoutEffect, useRef } from 'react'
import { ArrowRight, Check } from 'lucide-react'
import { reducedMotion } from '../../../motion/preference'

/** What a step points at: a box on screen, in client pixels. */
export interface GuideTarget {
  x: number
  y: number
  width: number
  height: number
  /** The element itself, so it can be scrolled into view; absent for a spot on the felt. */
  element?: Element
}

export interface GuideStep {
  id: string
  title: string
  text: string
  target: () => GuideTarget | null
}

/** Breathing room around whatever the ring circles. */
const PAD = 8

/**
 * A coach mark for someone's first table: a ring round the real thing on
 * screen and a small card beside it saying what it is for. Nothing in it is
 * modal — the room keeps playing and every control stays live — so the ring
 * lets the pointer through, and the card takes focus only to offer Next and
 * Skip. Escape closes it, as does finishing; either way focus goes back to
 * wherever it was.
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
  const ring = useRef<HTMLDivElement>(null),
    card = useRef<HTMLDivElement>(null),
    next = useRef<HTMLButtonElement>(null),
    current = steps[step],
    latest = useRef(current),
    last = step === steps.length - 1
  useLayoutEffect(() => {
    latest.current = current
  })

  // Focus comes in once, and goes back where it was when the guide is done.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    next.current?.focus({ preventScroll: true })
    return () => {
      // Only if focus left with the guide: someone who has moved on to their cards keeps it there.
      const lost = !document.activeElement || document.activeElement === document.body
      if (lost && before?.isConnected) before.focus({ preventScroll: true })
    }
  }, [])

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      // A dialog open over the table has Escape first.
      if (event.key === 'Escape' && !document.querySelector('dialog[open]')) onClose()
    }
    window.addEventListener('keydown', close)
    return () => window.removeEventListener('keydown', close)
  }, [onClose])

  // Placed by hand rather than through state: the targets move (a hand grows, the
  // window turns), so the ring and card follow them every few frames.
  useLayoutEffect(() => {
    let frame = 0,
      ticks = 0
    const place = () => {
      const layer = ring.current?.parentElement
      if (!layer || !ring.current || !card.current) return
      const box = layer.getBoundingClientRect(),
        target = latest.current.target()
      ring.current.hidden = !target
      if (!target) return
      const x = target.x - box.left - PAD,
        y = target.y - box.top - PAD,
        width = target.width + PAD * 2,
        height = target.height + PAD * 2
      Object.assign(ring.current.style, {
        left: `${x}px`,
        top: `${y}px`,
        width: `${width}px`,
        height: `${height}px`,
      })
      // Beside the target, on whichever side has the room.
      const cardWidth = card.current.offsetWidth,
        cardHeight = card.current.offsetHeight,
        below = y + height / 2 < box.height / 2,
        left = Math.min(Math.max(x + width / 2 - cardWidth / 2, 12), box.width - cardWidth - 12),
        top = below ? y + height + 12 : y - cardHeight - 12
      card.current.style.left = `${left}px`
      card.current.style.top = `${Math.min(Math.max(top, 12), box.height - cardHeight - 12)}px`
      card.current.dataset.side = below ? 'below' : 'above'
    }
    const loop = () => {
      if (ticks++ % 6 === 0) place()
      frame = requestAnimationFrame(loop)
    }
    place()
    const element = latest.current.target()?.element
    if (element) {
      const rect = element.getBoundingClientRect()
      if (rect.top < 0 || rect.bottom > window.innerHeight)
        element.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' })
    }
    frame = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(frame)
  }, [current.id])

  return (
    <div className="pr-guide">
      <div ref={ring} className="pr-guide-ring" aria-hidden="true" />
      <div
        ref={card}
        className="pr-guide-card motion-enter"
        role="dialog"
        aria-modal="false"
        aria-labelledby="pr-guide-title"
        aria-describedby="pr-guide-text"
      >
        <div key={current.id} className="pr-guide-step motion-enter" aria-live="polite">
          <span className="pr-eyebrow">
            STEP {step + 1} OF {steps.length}
          </span>
          <strong id="pr-guide-title">{current.title}</strong>
          <p id="pr-guide-text">{current.text}</p>
        </div>
        <div className="pr-guide-actions">
          <span className="pr-guide-dots" aria-hidden="true">
            {steps.map((s, i) => (
              <i key={s.id} className={i === step ? 'pr-guide-dot-on' : ''} />
            ))}
          </span>
          {!last && (
            <button className="pr-text-button" onClick={onClose}>
              Skip
            </button>
          )}
          <button ref={next} className="pr-primary" onClick={last ? onClose : onNext}>
            {last ? (
              <>
                Got it <Check size={15} />
              </>
            ) : (
              <>
                Next <ArrowRight size={15} />
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
