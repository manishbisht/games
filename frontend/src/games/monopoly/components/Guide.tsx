import { useEffect, useId, useLayoutEffect, useRef } from 'react'
import { ArrowRight, X } from 'lucide-react'
import { reducedMotion } from '../../../motion/preference'
import type { GuideStep } from './useGuide'
import './Guide.css'

/**
 * The coach mark: a soft ring round the real thing the step is about, and a
 * small card beside it with one sentence, Next and Skip. It is not modal —
 * nothing under it is blocked, the room keeps its own time, and acting on the
 * table is the quickest way through it. Escape closes it; focus moves to it
 * when it opens and goes back where it was when it closes.
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
    ring = useRef<HTMLDivElement>(null),
    titleId = useId()
  const current = steps[step]
  const target = useRef(current.target)
  useEffect(() => {
    target.current = current.target
  })

  // Focus comes to the card when the guide opens, and goes back when it closes.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    card.current?.focus({ preventScroll: true })
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true })
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('dialog:modal')) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // A new step brings its target into view, if it is off the page.
  useEffect(() => {
    const box = target.current()
    if (box && (box.top < 0 || box.top + box.height > innerHeight))
      window.scrollBy({
        top: box.top + box.height / 2 - innerHeight / 2,
        behavior: reducedMotion() ? 'auto' : 'smooth',
      })
  }, [step])

  // Follows its target every frame — a token walks, the page scrolls — writing
  // straight to the two elements rather than re-rendering anything. Placed
  // before the first paint, so it never flashes in the corner.
  useLayoutEffect(() => {
    let frame = 0
    const follow = () => {
      frame = requestAnimationFrame(follow)
      const box = target.current(),
        mark = ring.current,
        sheet = card.current
      if (!mark || !sheet) return
      const gutter = 12,
        gap = 14,
        width = sheet.offsetWidth,
        height = sheet.offsetHeight
      if (!box) {
        mark.hidden = true
        sheet.style.left = `${(innerWidth - width) / 2}px`
        sheet.style.top = `${innerHeight - height - 24}px`
        return
      }
      const pad = 6
      mark.hidden = false
      mark.style.left = `${box.left - pad}px`
      mark.style.top = `${box.top - pad}px`
      mark.style.width = `${box.width + pad * 2}px`
      mark.style.height = `${box.height + pad * 2}px`
      // Below the target when it fits, above it when that fits better, and
      // never off the edge of the screen.
      const below = box.top + box.height + pad + gap,
        above = box.top - pad - gap - height
      const top =
        below + height <= innerHeight - gutter || above < gutter
          ? Math.min(below, innerHeight - height - gutter)
          : above
      const left = box.left + box.width / 2 - width / 2
      sheet.style.left = `${Math.max(gutter, Math.min(left, innerWidth - width - gutter))}px`
      sheet.style.top = `${Math.max(gutter, top)}px`
    }
    follow()
    return () => cancelAnimationFrame(frame)
  }, [])

  const last = step === steps.length - 1
  return (
    <>
      <div className="guide-ring" ref={ring} aria-hidden="true" hidden />
      <div
        className="guide-card"
        ref={card}
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        {/* Keyed by step, so each one makes its own entrance. */}
        <div className="guide-card-inner motion-enter" key={step}>
          <div className="guide-head">
            <span className="guide-count">
              {step + 1} of {steps.length}
            </span>
            <button className="guide-close" aria-label="Close the guide" onClick={onClose}>
              <X size={15} />
            </button>
          </div>
          <h2 id={titleId}>{current.title}</h2>
          <p>{current.text}</p>
          <div className="guide-actions">
            <span className="guide-dots" aria-hidden="true">
              {steps.map((_, i) => (
                <i key={i} className={i === step ? 'on' : ''} />
              ))}
            </span>
            {!last && (
              <button className="guide-skip" onClick={onClose}>
                Skip
              </button>
            )}
            <button className="guide-next" onClick={onNext}>
              {last ? 'Done' : 'Next'} <ArrowRight size={14} />
            </button>
          </div>
        </div>
      </div>
      <p className="sr-only" aria-live="polite">
        {`Step ${step + 1} of ${steps.length}. ${current.title}. ${current.text}`}
      </p>
    </>
  )
}
