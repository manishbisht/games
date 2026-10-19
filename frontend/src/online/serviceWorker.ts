/**
 * The site's service worker (public/sw.js): an app shell that reloads fast and
 * survives a flaky connection, and the thing a turn notification arrives
 * through. Scoped to the site's base path, so a deploy under a GitHub Pages
 * project path works the same as one at a domain's root.
 *
 * Registered on load in production builds. A dev server only gets one once a
 * player turns notifications on (which needs it) — or with
 * `localStorage['games-sw'] = 'on'` — so day-to-day development never runs
 * behind a cache.
 */
const BASE = import.meta.env.BASE_URL

export const serviceWorkerSupported = () => typeof navigator !== 'undefined' && 'serviceWorker' in navigator

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!serviceWorkerSupported()) return null
  try {
    return await navigator.serviceWorker.register(`${BASE}sw.js`, { scope: BASE })
  } catch {
    // Private windows and locked-down browsers refuse; the site works without it.
    return null
  }
}

/** The worker this page is under once it is running, for subscribing to push. */
export async function readyServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!(await registerServiceWorker())) return null
  return navigator.serviceWorker.ready
}

export function installServiceWorker(): void {
  let wanted = import.meta.env.PROD
  try {
    wanted ||= localStorage.getItem('games-sw') === 'on'
  } catch {
    // Storage blocked: production still registers, dev simply does not.
  }
  if (!wanted || !serviceWorkerSupported()) return
  // After load, so registering never competes with the first paint for the network.
  if (document.readyState === 'complete') void registerServiceWorker()
  else window.addEventListener('load', () => void registerServiceWorker(), { once: true })
}
