import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { ArrowRight, Check } from 'lucide-react'
import { reducedMotion } from '../../../motion/preference'
import type { GuideStep } from '../game/guide'

type Box = Pick<DOMRect, 'top' | 'left' | 'bottom' | 'right' | 'width' | 'height'>
interface Layout {
  /** What the step points at. */
  spot: Box | null
  /** What the card should leave uncovered where it can (the board). */
  keep: Box | null
  card: number
  view: { width: number; height: number }
}
const MARGIN = 16,
  GAP = 12,
  RING = 6

const box = (element: Element | null): Box | null => {
  if (!element) return null
  const { top, left, bottom, right, width, height } = element.getBoundingClientRect()
  return { top, left, bottom, right, width, height }
}
const overlaps = (a: Box, b: Box) =>
  a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom

/**
 * Where the card goes: below what it points at, above, or beside it — the
 * first of those that fits on screen and leaves `keep` clear, else the first
 * that fits, else over the bottom of the screen.
 */
function place({ spot, keep, card: height, view }: Layout) {
  const width = Math.min(340, view.width - MARGIN * 2),
    clamp = (value: number, max: number) => Math.max(MARGIN, Math.min(value, max - MARGIN))
  const bottom = { left: (view.width - width) / 2, top: view.height - height - MARGIN, width }
  if (!spot) return bottom
  const left = clamp(spot.left + spot.width / 2 - width / 2, view.width - width),
    middle = clamp(spot.top + spot.height / 2 - height / 2, view.height - height),
    reach = RING + GAP
  const fits = [
    { left, top: spot.bottom + reach },
    { left, top: spot.top - reach - height },
    { left: spot.right + reach, top: middle },
    { left: spot.left - reach - width, top: middle },
  ].filter(
    (at) =>
      at.top >= MARGIN &&
      at.left >= MARGIN &&
      at.top + height <= view.height - MARGIN &&
      at.left + width <= view.width - MARGIN,
  )
  const clear = fits.find(
    (at) =>
      !keep || !overlaps({ ...at, width, height, right: at.left + width, bottom: at.top + height }, keep),
  )
  return { ...(clear ?? fits[0] ?? bottom), width }
}

const sameBox = (a: Box | null, b: Box | null) =>
  a === b ||
  (!!a && !!b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height)

/**
 * A short, non-modal walk through the table: a ring around the real thing on
 * screen and a card beside it. Nothing underneath is blocked — the room keeps
 * its own time, so the player can act through the whole guide, and a step
 * about an action moves on when they take it. Escape (or Skip) puts it away.
 */
export default function Guide({
  steps,
  step,
  keep,
  onNext,
  onClose,
}: {
  steps: GuideStep[]
  step: number
  /** A selector for what the card should leave uncovered where it can. */
  keep?: string
  onNext: () => void
  onClose: () => void
}) {
  const current = steps[Math.min(step, steps.length - 1)],
    last = step >= steps.length - 1
  const card = useRef<HTMLDivElement>(null),
    titleId = useId()
  const [layout, setLayout] = useState<Layout | null>(null)
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })

  // Follow what the step points at as the page scrolls, resizes, or the board settles.
  useLayoutEffect(() => {
    const target = () => document.querySelector(current.target)
    let frame = 0
    const measure = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        setLayout((was) => {
          const spot = box(target()),
            // Pointing at the thing to keep clear, there is nothing else to keep clear.
            clear = keep && keep !== current.target ? box(document.querySelector(keep)) : null,
            height = card.current?.getBoundingClientRect().height ?? 0,
            view = { width: window.innerWidth, height: window.innerHeight }
          return was &&
            sameBox(was.spot, spot) &&
            sameBox(was.keep, clear) &&
            was.card === height &&
            was.view.width === view.width &&
            was.view.height === view.height
            ? was
            : { spot, keep: clear, card: height, view }
        })
      })
    }
    const element = target()
    if (element) {
      const { top, bottom } = element.getBoundingClientRect()
      if (top < 0 || bottom > window.innerHeight)
        element.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'instant' : 'smooth' })
    }
    measure()
    const observer = new ResizeObserver(measure)
    if (element) observer.observe(element)
    if (card.current) observer.observe(card.current)
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [current.target, keep])

  // Focus comes to the guide when it opens and goes back where it was when it closes.
  useEffect(() => {
    const before = document.activeElement
    const focus = () => card.current?.focus({ preventScroll: true })
    focus()
    // Opened from How to play, that dialog is still playing its exit; when it
    // closes the browser hands focus back to whatever opened it — so take it again.
    const closing = document.querySelector('dialog[open]')
    const refocus = () => requestAnimationFrame(focus)
    closing?.addEventListener('close', refocus, { once: true })
    return () => {
      closing?.removeEventListener('close', refocus)
      if (before instanceof HTMLElement && before.isConnected) before.focus({ preventScroll: true })
    }
  }, [])
  // Escape puts it away from anywhere — unless something else used that Escape
  // (the board deselecting, a dialog closing).
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open]')) return
      close.current()
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [])

  const at = layout && place(layout)
  return (
    <div className="ch-guide">
      {layout?.spot && (
        <div
          className="ch-guide-spot"
          aria-hidden="true"
          style={{
            top: layout.spot.top - RING,
            left: layout.spot.left - RING,
            width: layout.spot.width + RING * 2,
            height: layout.spot.height + RING * 2,
          }}
        />
      )}
      <div
        ref={card}
        className="ch-guide-card motion-enter"
        role="dialog"
        aria-modal="false"
        aria-labelledby={titleId}
        tabIndex={-1}
        // Measured before it is placed: unseen, but still there to take focus.
        style={at ? { top: at.top, left: at.left, width: at.width } : { opacity: 0, pointerEvents: 'none' }}
      >
        <p className="ch-eyebrow">
          YOUR FIRST GAME · {step + 1} OF {steps.length}
        </p>
        <div aria-live="polite">
          <div key={current.id} className="ch-guide-step">
            <h2 id={titleId}>{current.title}</h2>
            <p>{current.text}</p>
          </div>
        </div>
        <div className="ch-guide-footer">
          <span className="ch-guide-dots" aria-hidden="true">
            {steps.map((s, i) => (
              <i key={s.id} className={i === step ? 'on' : ''} />
            ))}
          </span>
          {!last && (
            <button className="ch-guide-skip" onClick={onClose}>
              Skip
            </button>
          )}
          <button className="ch-guide-next" onClick={last ? onClose : onNext}>
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
