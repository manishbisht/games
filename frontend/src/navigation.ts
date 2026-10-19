import { flushSync } from 'react-dom'
import { matchPath, UNSAFE_createHashHistory } from 'react-router'
import { games } from './games/catalog'
import type { GameEntry } from './games/catalog'
import { lazyWithPreload } from './lazyPreload'
import { reducedMotion } from './motion/preference'

/** The shared room page, warmed alongside a game's own chunk on the way to a room. */
export const roomPage = lazyWithPreload(() => import('./online/RoomPage'))
/** A room's finished game, played back. */
export const replayPage = lazyWithPreload(() => import('./online/ReplayPage'))

/** Which screen a path shows: the collection, a game, one of its rooms, or a room's replay. */
export function screenOf(pathname: string): { game?: GameEntry; room: boolean; replay?: boolean } {
  for (const game of games) {
    if (matchPath(game.path, pathname)) return { game, room: false }
    if (matchPath(`${game.path}/room/:code`, pathname)) return { game, room: true }
    if (matchPath(`${game.path}/replay/:code`, pathname)) return { game, room: false, replay: true }
  }
  return { room: false }
}
const screenKey = (pathname: string) => {
  const { game, room, replay } = screenOf(pathname)
  return game ? `${game.id}${room ? '/room' : replay ? '/replay' : ''}` : '/'
}

let homeScroll = 0
/** Where the collection was scrolled to when the player left it, so coming back lands there. */
export const homeScrollPosition = () => homeScroll

/**
 * How long a navigation may hold the old page on screen while the next game's
 * chunk arrives. Usually it is already here (cards warm it on hover and focus);
 * past this the skeleton takes over, rather than the click feeling ignored.
 */
const CHUNK_GRACE_MS = 400
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const cardFor = (id: string) => document.querySelector<HTMLElement>(`.collection-card-${id}`)
/** Morph only from or into a card the player can actually see. */
function visible(element: HTMLElement | null) {
  if (!element) return null
  const box = element.getBoundingClientRect()
  return box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth ? element : null
}

let updating = false,
  active: ViewTransition | null = null

/**
 * Whether a view transition would be worth starting now. Not without browser
 * support or under reduced motion (motion.css would land it instantly anyway,
 * after paying for the snapshots), not in a background tab, and not from
 * inside another transition's update — a redirect that a navigation renders
 * simply joins that navigation.
 */
export const canTransition = () =>
  Boolean(document.startViewTransition) &&
  !updating &&
  !reducedMotion() &&
  document.visibilityState === 'visible'

/**
 * Commit a React update as a view transition, tagged `<html data-vt=kind>`
 * for the CSS in index.css to choreograph. `prepare` may hold the old frame a
 * moment first (to let a chunk arrive); `apply` is committed with `flushSync`
 * so the new frame is photographed with it in place; `after` runs between that
 * commit and the photograph. Without a transition, `apply` simply runs.
 */
export function viewTransition(
  kind: string,
  apply: () => void,
  { prepare, after }: { prepare?: () => Promise<unknown>; after?: () => void } = {},
): ViewTransition | null {
  if (!canTransition()) {
    apply()
    return null
  }
  const root = document.documentElement
  root.dataset.vt = kind
  const vt = document.startViewTransition(async () => {
    await prepare?.()
    updating = true
    try {
      flushSync(apply)
    } finally {
      updating = false
    }
    after?.()
  })
  active = vt
  // A transition interrupted by the next one rejects these; the DOM update
  // itself still happens, so there is nothing to report.
  vt.ready.catch(() => {})
  vt.updateCallbackDone.catch(() => {})
  vt.finished
    .catch(() => {})
    .finally(() => {
      if (active === vt) delete root.dataset.vt
    })
  return vt
}

/**
 * Moves between screens as a view transition: opening a game grows its card
 * on the collection into the game's page, and leaving folds the page back into
 * that card; any other change of screen cross-fades. Back and forward animate
 * too, because this wraps the history itself rather than the links — the
 * games' own "All games" links get it without knowing it exists.
 *
 * Redirects (REPLACE) and changes within one screen apply directly.
 */
function transition(from: string, to: string, action: string, apply: () => void) {
  const fromKey = screenKey(from),
    toKey = screenKey(to)
  if (fromKey === '/') homeScroll = scrollY
  if (action === 'REPLACE' || fromKey === toKey || !canTransition()) {
    apply()
    return
  }
  const target = screenOf(to),
    source = screenOf(from),
    opening =
      fromKey === '/' && target.game && !target.room && !target.replay
        ? visible(cardFor(target.game.id))
        : null,
    closing = fromKey !== '/' && toKey === '/'
  let card = opening
  if (card) card.style.viewTransitionName = 'game-stage'
  const vt = viewTransition(opening ? 'open' : closing ? 'close' : 'swap', apply, {
    prepare: async () => {
      if (!target.game) return
      const loads = target.replay
        ? [replayPage.preload()]
        : [target.game.preload(), ...(target.room ? [roomPage.preload()] : [])]
      await Promise.race([Promise.all(loads), wait(CHUNK_GRACE_MS)])
    },
    after: () => {
      if (!closing || !source.game) return
      card = visible(cardFor(source.game.id))
      if (card) card.style.viewTransitionName = 'game-stage'
    },
  })
  const clear = () => {
    if (card) card.style.viewTransitionName = ''
  }
  vt?.finished.then(clear, clear)
}

/**
 * The hash history the app routes with, its listener wrapped in `transition`.
 * Paired with `useTransitions={false}` on the router, so the state update the
 * listener makes is synchronous and `flushSync` can commit it inside the
 * transition's update callback.
 *
 * Built on two exports React Router marks as not public — `UNSAFE_createHashHistory`
 * here and `unstable_HistoryRouter` in main.tsx — which is why frontend/package.json
 * pins it to one exact version. Before moving that pin, check: both exports still
 * exist; `history.listen` is still the one door the router hears navigations
 * through, with `{ action, location }` updates (wrap it and log); the router still
 * takes `useTransitions={false}` and applies the update synchronously; and
 * `npx playwright test tests/routing.spec.ts` passes — it walks home → game →
 * home and back/forward with view transitions on.
 */
export function createAppHistory() {
  const history = UNSAFE_createHashHistory({ v5Compat: true })
  const listen = history.listen.bind(history)
  let current = history.location.pathname
  history.listen = (listener) =>
    listen((update) => {
      const from = current
      current = update.location.pathname
      transition(from, current, update.action, () => listener(update))
    })
  return history
}
