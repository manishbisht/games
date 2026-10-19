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
 * The address a request counts against, or null when it should not count: from
 * loopback, or with no address at all — which only a request that never came
 * through Cloudflare's edge can have, and that is a test calling the Worker
 * directly. Production traffic always carries `CF-Connecting-IP`.
 */
export function clientKey(request: Request): string | null {
  const ip = request.headers.get('CF-Connecting-IP')
  if (!ip || LOOPBACK.test(ip)) return null
  return ip
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
