import { useEffect, useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { reducedMotion } from '../../../motion/preference'
import { BANK, COIN_STAGGER, coinCount, transfers } from '../game/transfers'

/**
 * Coins that cross the sidebar when money changes hands: from the payer's card
 * to the payee's for rent and trades, and between a card and the board — the
 * bank — for everything else. The board throws its own coins for the same
 * transfers at the same moment (see `scene/coins`). Pure decoration on top of
 * the counted balances, so it simply does not run under reduced motion.
 */
export function useCoinFlights(cash: number[], root: RefObject<HTMLElement | null>) {
  const last = useRef(cash)
  useEffect(() => {
    const before = last.current
    last.current = cash
    const host = root.current
    if (!host || reducedMotion()) return
    const pocket = (player: number) =>
      player === BANK
        ? host.querySelector<HTMLElement>('.board-viewport')?.getBoundingClientRect()
        : host.querySelector<HTMLElement>(`[data-player="${player}"] .player-money`)?.getBoundingClientRect()
    for (const { from, to, amount } of transfers(before, cash)) fly(pocket(from), pocket(to), amount)
  }, [cash, root])
}

function centre(rect: DOMRect, inset = 0) {
  return { x: rect.left + rect.width / 2 + inset, y: rect.top + rect.height / 2 }
}

function fly(from: DOMRect | undefined, to: DOMRect | undefined, amount: number) {
  if (!from || !to) return
  const a = centre(from),
    b = centre(to),
    count = coinCount(amount)
  for (let n = 0; n < count; n++) {
    const coin = document.createElement('span')
    coin.className = 'estate-flying-coin'
    coin.style.left = `${a.x - 7}px`
    coin.style.top = `${a.y - 7}px`
    document.body.appendChild(coin)
    const dx = b.x - a.x + (n - count / 2) * 3,
      dy = b.y - a.y,
      lift = -Math.min(90, 30 + Math.abs(dx) * 0.15 + Math.abs(dy) * 0.12)
    const flight = coin.animate(
      [
        { transform: 'translate(0, 0) scale(0.4)', opacity: 0 },
        { transform: `translate(${dx * 0.12}px, ${lift * 0.5}px) scale(1)`, opacity: 1, offset: 0.18 },
        {
          transform: `translate(${dx * 0.55}px, ${dy * 0.5 + lift}px) scale(1.05)`,
          opacity: 1,
          offset: 0.55,
        },
        { transform: `translate(${dx}px, ${dy}px) scale(0.55)`, opacity: 0.2 },
      ],
      { duration: 760, delay: n * COIN_STAGGER, easing: 'cubic-bezier(0.45, 0, 0.3, 1)', fill: 'both' },
    )
    flight.onfinish = flight.oncancel = () => coin.remove()
  }
}

/**
 * Slides a list's rows to their new places when rows are added above them,
 * instead of letting them jump (FLIP). Rows opt in with `data-flip`.
 */
export function useFlip(container: RefObject<HTMLElement | null>, version: unknown) {
  const last = useRef(new Map<string, number>())
  useLayoutEffect(() => {
    const element = container.current
    if (!element) return
    const next = new Map<string, number>(),
      calm = reducedMotion()
    for (const child of Array.from(element.children) as HTMLElement[]) {
      const key = child.dataset.flip
      if (!key) continue
      const top = child.offsetTop,
        before = last.current.get(key)
      next.set(key, top)
      if (!calm && before !== undefined && before !== top)
        child.animate([{ translate: `0 ${before - top}px` }, { translate: '0 0' }], {
          duration: 360,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
        })
    }
    last.current = next
  }, [container, version])
}
