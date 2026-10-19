/** Where the site is served from. */
export const SITE_ORIGIN = 'https://games.manishbisht.me'
const ALLOWED = [SITE_ORIGIN]

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Whether this Worker is itself being served from loopback — `wrangler dev`, a
 * test run, CI's Playwright — rather than from Cloudflare's edge, which only
 * ever routes a request here under the Worker's own hostname. Local pages
 * (Vite on any port) are only trusted when the Worker is local too.
 */
export const isLocalWorker = (url: string | URL) => LOOPBACK_HOSTS.has(new URL(url).hostname)

/**
 * The page origin a request may act for, or null. The site itself always; a
 * localhost page only against a local Worker, so the deployed API admits no
 * page but the site's own.
 */
export function allowedOrigin(origin: string | null, local = false): string | null {
  if (!origin) return null
  if (ALLOWED.includes(origin)) return origin
  if (!local) return null
  try {
    const url = new URL(origin)
    if ((url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTS.has(url.hostname))
      return origin
  } catch {
    return null
  }
  return null
}

export function corsHeaders(origin: string): HeadersInit {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, authorization, x-guest-id',
    Vary: 'Origin',
  }
}
