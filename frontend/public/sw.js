/*
 * The site's service worker. Two jobs:
 *
 * 1. Fast, sturdy reloads. The page itself (index.html) is network-first, so a
 *    deploy is picked up on the next load, with the last copy as the fallback
 *    when the network is slow or gone. Vite's hashed build files never change
 *    under one name, so they are cache-first. Icons and other static files are
 *    served from cache and refreshed behind the scenes. Nothing cross-origin is
 *    touched — the game server's API and sockets, Clerk, fonts — and nothing
 *    that is not a GET.
 *
 * 2. Turn notifications. A push carries `{ title, body, path, tag }`; the click
 *    focuses a tab already showing the site (taking it to the room) or opens one.
 *
 * Paths are resolved against this worker's own scope, so it works the same at a
 * domain's root and under a GitHub Pages project path.
 */
const VERSION = 'v1'
const SHELL = `games-shell-${VERSION}`
const ASSETS = `games-assets-${VERSION}`
const STATIC = `games-static-${VERSION}`
const KEEP = [SHELL, ASSETS, STATIC]
/** Hashed build files kept at most; a few deploys' worth of chunks. */
const MAX_ASSETS = 160
/** How long a navigation waits on the network before answering from cache. */
const NETWORK_GRACE_MS = 3500

const SCOPE = new URL(self.registration.scope)
const INDEX = new URL('./', SCOPE).href

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.add(new Request(INDEX, { cache: 'reload' })))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => !KEEP.includes(key)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

async function networkFirst(request) {
  const cache = await caches.open(SHELL)
  const network = fetch(request).then((response) => {
    if (response.ok) void cache.put(INDEX, response.clone())
    return response
  })
  // Whichever way the race goes, a late failure here is not worth a console error.
  network.catch(() => undefined)
  const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_GRACE_MS))
  try {
    const answer = await Promise.race([network, timeout])
    if (answer) return answer
  } catch {
    // Offline: fall through to the cached page.
  }
  return (await cache.match(INDEX)) ?? network
}

async function trim(cache) {
  const keys = await cache.keys()
  await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_ASSETS)).map((key) => cache.delete(key)))
}

async function cacheFirst(request) {
  const cache = await caches.open(ASSETS)
  const hit = await cache.match(request)
  if (hit) return hit
  const response = await fetch(request)
  if (response.ok) {
    await cache.put(request, response.clone())
    void trim(cache)
  }
  return response
}

async function staleWhileRevalidate(request, event) {
  const cache = await caches.open(STATIC)
  const hit = await cache.match(request)
  const refresh = fetch(request).then((response) => {
    if (response.ok) void cache.put(request, response.clone())
    return response
  })
  if (hit) {
    event.waitUntil(refresh.catch(() => undefined))
    return hit
  }
  return refresh
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== SCOPE.origin || !url.href.startsWith(SCOPE.href)) return
  if (request.mode === 'navigate') return event.respondWith(networkFirst(request))
  const path = url.pathname.slice(SCOPE.pathname.length)
  // Vite's build output: content-hashed, so a name never changes meaning.
  if (path.startsWith('assets/')) return event.respondWith(cacheFirst(request))
  if (/\.(svg|png|webmanifest|ico|woff2?)$/.test(path))
    return event.respondWith(staleWhileRevalidate(request, event))
  // Anything else — the dev server's modules, this worker itself — straight to the network.
})

self.addEventListener('push', (event) => {
  let message = {}
  try {
    message = event.data ? event.data.json() : {}
  } catch {
    message = { body: event.data ? event.data.text() : '' }
  }
  const title = message.title || 'Games'
  event.waitUntil(
    self.registration.showNotification(title, {
      body: message.body || '',
      tag: message.tag,
      renotify: Boolean(message.tag),
      icon: new URL('icons/icon-192.png', SCOPE).href,
      badge: new URL('icons/icon-192.png', SCOPE).href,
      data: { url: new URL(`#${message.path || '/'}`, INDEX).href },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = (event.notification.data && event.notification.data.url) || INDEX
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      // The room itself if it is already open; otherwise any tab of the site.
      const open =
        windows.find((client) => client.url === target) ??
        windows.find((client) => client.url.startsWith(INDEX))
      if (open) {
        if (open.url !== target && 'navigate' in open) await open.navigate(target).catch(() => undefined)
        return open.focus()
      }
      return self.clients.openWindow(target)
    })(),
  )
})
