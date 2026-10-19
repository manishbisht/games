import { useEffect, useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { reducedMotion } from '../../../motion/preference'
import type { HandSlot } from '../scene/createScene'

const FLIP_MS = 420

/** Where a hand card is on screen, including the tilt it wears in the fan. */
function measure(element: HTMLElement): HandSlot {
  const box = element.getBoundingClientRect()
  return {
    x: box.left + box.width / 2,
    y: box.top + box.height / 2,
    width: element.offsetWidth,
    angle: element.matches('.pr-selected, :hover')
      ? 0
      : parseFloat(element.style.getPropertyValue('--angle')) || 0,
  }
}

/**
 * The DOM hand's half of the table's motion.
 *
 * - When the hand reflows (a card leaves, one is drawn, it is sorted) every card
 *   slides from where it was drawn to its new place — FLIP, interrupted cleanly
 *   by measuring the slide already under way.
 * - The card under a pointer tilts toward it and catches the light, on devices
 *   that hover.
 * - The table can ask where any card is, or where it was the moment it was
 *   played, so a card leaves the hand from exactly where it sat.
 *
 * `epoch` changes when card ids stop meaning the same card (a new round deals
 * the same deck again), which forgets every remembered place.
 */
export function useHandMotion(hand: RefObject<HTMLElement | null>, epoch: unknown) {
  const places = useRef(new Map<string, HandSlot>()),
    layouts = useRef(new Map<string, [number, number]>()),
    launched = useRef(new Map<string, HandSlot>()),
    slides = useRef(new WeakMap<Element, { animation: Animation; dx: number; dy: number }>()),
    seen = useRef(epoch)

  useLayoutEffect(() => {
    const root = hand.current
    if (seen.current !== epoch) {
      seen.current = epoch
      places.current.clear()
      layouts.current.clear()
      launched.current.clear()
    }
    if (!root) return
    const elements = [...root.querySelectorAll<HTMLElement>('[data-card]')]
    // Where each card is drawn right now, mid-slide included…
    const drift = elements.map((element) => {
      const slide = slides.current.get(element)
      if (!slide || slide.animation.playState !== 'running') return [0, 0]
      const progress = slide.animation.effect?.getComputedTiming().progress ?? 1
      slide.animation.cancel()
      return [slide.dx * (1 - progress), slide.dy * (1 - progress)]
    })
    // …and where layout has put it now. Layout offsets, not boxes: a hover's
    // own nudge or a tilt is not a reflow and must not start a slide.
    const reduced = reducedMotion()
    elements.forEach((element, i) => {
      const id = element.dataset.card!,
        now: [number, number] = [element.offsetLeft, element.offsetTop],
        before = layouts.current.get(id)
      layouts.current.set(id, now)
      places.current.set(id, measure(element))
      if (!before || reduced) return
      const dx = before[0] + drift[i][0] - now[0],
        dy = before[1] + drift[i][1] - now[1]
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return
      const animation = element.animate([{ translate: `${dx}px ${dy}px` }, { translate: '0px 0px' }], {
        duration: FLIP_MS,
        easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        composite: 'add',
      })
      slides.current.set(element, { animation, dx, dy })
    })
  })

  // Pointer tilt: one listener for the whole hand, one write per frame.
  useEffect(() => {
    const root = hand.current
    if (!root || !matchMedia('(hover: hover)').matches) return
    let frame = 0,
      current: HTMLElement | null = null,
      x = 0,
      y = 0
    const write = () => {
      frame = 0
      if (!current) return
      current.style.setProperty('--tx', x.toFixed(3))
      current.style.setProperty('--ty', y.toFixed(3))
    }
    const reset = (element: HTMLElement | null) => {
      element?.style.removeProperty('--tx')
      element?.style.removeProperty('--ty')
    }
    const move = (event: PointerEvent) => {
      const card = (event.target as Element).closest<HTMLElement>('[data-card]')
      if (card !== current) {
        reset(current)
        current = card
      }
      if (!card || reducedMotion()) return
      const box = card.getBoundingClientRect()
      x = Math.max(-1, Math.min(1, ((event.clientX - box.left) / box.width) * 2 - 1))
      y = Math.max(-1, Math.min(1, ((event.clientY - box.top) / box.height) * 2 - 1))
      frame ||= requestAnimationFrame(write)
    }
    const leave = () => {
      reset(current)
      current = null
    }
    root.addEventListener('pointermove', move)
    root.addEventListener('pointerleave', leave)
    return () => {
      cancelAnimationFrame(frame)
      root.removeEventListener('pointermove', move)
      root.removeEventListener('pointerleave', leave)
    }
  }, [hand])

  /** Remembers where a card is the instant it is played, before React takes it away. */
  function launch(id: string) {
    const element = hand.current?.querySelector<HTMLElement>(`[data-card="${CSS.escape(id)}"]`)
    if (element) launched.current.set(id, measure(element))
  }
  function slot(id: string): HandSlot | null {
    const played = launched.current.get(id)
    if (played) return played
    const element = hand.current?.querySelector<HTMLElement>(`[data-card="${CSS.escape(id)}"]`)
    return element ? measure(element) : (places.current.get(id) ?? null)
  }
  return { launch, slot }
}
