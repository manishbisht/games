/**
 * Per-address rate limits, on Cloudflare's rate limiting binding. The numbers
 * themselves live in wrangler.jsonc (`ratelimits`); what is here is which key a
 * request counts against, and who does not count at all.
 *
 * The binding counts per Cloudflare location rather than globally, and it is
 * eventually consistent — it is a brake on a script hammering one endpoint, not
 * an exact quota, which is all these endpoints need.
 */

/**
 * How long a refused caller is told to wait. The binding does not say when its
 * window rolls over, so this is the longest any of ours can be: every limit in
 * wrangler.jsonc is per sixty seconds.
 */
export const RETRY_AFTER_S = 60

/**
 * Loopback is a developer, a test run or CI's Playwright — never a stranger.
 * Several of those share 127.0.0.1 at once (every agent and browser on one
 * machine), so counting them would trip a limit meant for one person.
 */
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/

/**
 * The first four hextets of an IPv6 address — its /64 — or null when `ip` is
 * not one. An IPv4-mapped address (`::ffff:1.2.3.4`) answers its IPv4 form, so
 * the same host is one key however the edge spells it.
 */
function ipv6Prefix(ip: string): string | null {
  if (!ip.includes(':')) return null
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)
  if (mapped) return mapped[1]
  // A trailing dotted quad fills the last two hextets, which a /64 never reaches.
  const halves = ip.toLowerCase().replace(/%.*$/, '').split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const width = (part: string[]) => part.reduce((sum, hextet) => sum + (hextet.includes('.') ? 2 : 1), 0)
  const missing = 8 - width(head) - width(tail)
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null
  const full = [...head, ...Array<string>(missing).fill('0'), ...tail]
  const prefix = full.slice(0, 4)
  if (prefix.some((hextet) => !/^[0-9a-f]{1,4}$/.test(hextet))) return null
  return `${prefix.map((hextet) => hextet.replace(/^0+(?=.)/, '')).join(':')}::/64`
}

/**
 * The key a request counts against, or null when it should not count: from
 * loopback, or with no address at all — which only a request that never came
 * through Cloudflare's edge can have, and that is a test calling the Worker
 * directly. Production traffic always carries `CF-Connecting-IP`.
 *
 * IPv4 counts per address. IPv6 counts per /64: that is what one subscriber is
 * handed, and an address per request out of 2^64 would make every limit here
 * meaningless.
 */
export function clientKey(request: Request): string | null {
  const ip = request.headers.get('CF-Connecting-IP')?.trim()
  if (!ip || LOOPBACK.test(ip)) return null
  return ipv6Prefix(ip) ?? ip
}

/**
 * Whether `request` is over `limiter`'s limit. An absent binding — a config
 * without `ratelimits` — limits nothing rather than failing every request.
 */
export async function overLimit(limiter: RateLimit | undefined, request: Request): Promise<boolean> {
  const key = clientKey(request)
  if (!limiter || key === null) return false
  const { success } = await limiter.limit({ key })
  return !success
}

/**
 * A short, one-way tag for where a request came from: enough for a global
 * object to cap what one address may add to a shared list (public rooms,
 * players online) without that object ever holding the address itself. Null
 * where `clientKey` is — loopback and tests are never capped.
 */
export async function sourceTag(request: Request): Promise<string | null> {
  const key = clientKey(request)
  if (key === null) return null
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`games-source:${key}`))
  return [...new Uint8Array(digest).slice(0, 8)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}
