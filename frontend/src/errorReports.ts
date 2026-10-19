import { API_URL } from './online/api'

/**
 * Tells the server about errors in players' browsers, which nothing else would:
 * a game that throws on someone's phone is otherwise only ever a blank table
 * they close. First-party and tiny on purpose — one beacon per distinct error,
 * written to the Worker's log (see backend/src/clientErrors.ts).
 *
 * What leaves the browser is the error and where in the site it happened —
 * never who: the player's name and guest id are scrubbed from the text, and a
 * room's code (its invite secret) is taken out of the route.
 */

export type ErrorKind = 'error' | 'rejection' | 'boundary' | 'webgl'

/** Per tab session: enough to see a pattern, not enough to flood a log from one broken tab. */
const MAX_REPORTS = 10
/**
 * The share of sessions that report at all, decided once per session so a
 * sampled-in session tells the whole story. Everyone, while traffic is small.
 */
const SAMPLE_RATE = 1
const LIMITS = { message: 500, stack: 4000, route: 200 }
const STATE_KEY = 'games-error-reports'

interface SessionState {
  sampled: boolean
  sent: number
  seen: string[]
}

let memory: SessionState | null = null

/** The tab session's reporting state; sessionStorage so a reload loop still counts as one session. */
function session(): SessionState {
  if (memory) return memory
  try {
    const saved = JSON.parse(sessionStorage.getItem(STATE_KEY) ?? 'null') as SessionState | null
    if (saved && typeof saved.sent === 'number' && Array.isArray(saved.seen)) return (memory = saved)
  } catch {
    // Unreadable or blocked: start afresh, in memory.
  }
  return (memory = { sampled: Math.random() < SAMPLE_RATE, sent: 0, seen: [] })
}

function remember(state: SessionState) {
  try {
    sessionStorage.setItem(STATE_KEY, JSON.stringify(state))
  } catch {
    // Applies for this page only.
  }
}

/** Where in the site, without which room: `#/chess/room/ABC234?x` reads `/chess/room/:code`. */
export function scrubRoute(hash: string): string {
  const path = hash.replace(/^#/, '').split(/[?#]/)[0] || '/'
  return path.replace(/\/room\/[^/]+/i, '/room/:code').slice(0, LIMITS.route)
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Error text with anything that could name a person or open a room taken out:
 * ids (guest ids are UUIDs), email addresses, the player's chosen name, the
 * code of the room they are in, and the query or fragment of any URL — which
 * is where this site keeps its routes, room codes included.
 */
export function scrubText(text: string, { name, code }: { name?: string; code?: string } = {}): string {
  let out = text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/[^\s@"'<>]+@[^\s@"'<>]+\.[a-z]{2,}/gi, '<email>')
    .replace(/(https?:\/\/[^\s?#"')]+)[?#][^\s"')]*/g, '$1')
  if (code) out = out.replace(new RegExp(escape(code), 'g'), '<room>')
  // Short names ("Al") would scrub ordinary words out of every stack, so only
  // a name long enough to be distinctive is looked for.
  if (name && name.trim().length >= 3) out = out.replace(new RegExp(escape(name.trim()), 'gi'), '<name>')
  return out
}

function context() {
  let name: string | undefined
  try {
    name = localStorage.getItem('games-guest-name') ?? undefined
  } catch {
    name = undefined
  }
  const code = /\/room\/([^/?#]+)/i.exec(location.hash)?.[1]
  return { name, code }
}

/** Report one error, unless this session has already said it, is sampled out, or has said enough. */
export function reportError(kind: ErrorKind, error: unknown): void {
  try {
    const state = session()
    if (!state.sampled || state.sent >= MAX_REPORTS) return
    const raw = error instanceof Error ? error : null
    const scrub = context()
    const message = scrubText(
      raw ? `${raw.name}: ${raw.message}` : typeof error === 'string' ? error : String(error),
      scrub,
    ).slice(0, LIMITS.message)
    const stack = raw?.stack ? scrubText(raw.stack, scrub).slice(0, LIMITS.stack) : undefined
    const key = `${kind}|${message}|${stack ?? ''}`
    if (!message.trim() || state.seen.includes(key)) return
    state.seen.push(key)
    state.sent++
    remember(state)
    const release = import.meta.env.VITE_RELEASE as string | undefined
    const body = JSON.stringify({
      kind,
      message,
      ...(stack ? { stack } : {}),
      route: scrubRoute(location.hash),
      ...(release ? { release: release.slice(0, 64) } : {}),
    })
    // A string body goes as text/plain, which needs no CORS preflight — a
    // beacon cannot make one. The beacon also survives the page unloading,
    // which is exactly when a crashed tab gets closed.
    const url = `${API_URL}/api/errors`
    if (!navigator.sendBeacon?.(url, body))
      void fetch(url, { method: 'POST', body, keepalive: true, mode: 'no-cors' }).catch(() => {})
  } catch {
    // Reporting must never become the error.
  }
}

let installed = false

/**
 * Listen for what nothing else catches: uncaught errors, unhandled rejections,
 * and a WebGL context the GPU took away. `webglcontextlost` does not bubble,
 * so it is caught on the way down, in the capture phase, from every canvas.
 */
export function installErrorReporting(): void {
  // The dev server's errors are on the developer's screen already, and several
  // dev servers share one local backend whose log they would only clutter.
  if (installed || typeof window === 'undefined' || import.meta.env.DEV) return
  installed = true
  window.addEventListener('error', (event) => {
    // A resource that failed to load fires `error` too, with no error object;
    // the chunk boundary and preload handler already deal with those.
    if (event.error === undefined && !event.message) return
    reportError('error', event.error ?? event.message)
  })
  window.addEventListener('unhandledrejection', (event) => reportError('rejection', event.reason))
  window.addEventListener(
    'webglcontextlost',
    () => reportError('webgl', new Error('WebGL context lost')),
    true,
  )
}
