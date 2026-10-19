/**
 * Errors from players' browsers. The page sends each one with
 * `navigator.sendBeacon` as a `text/plain` body (a type that needs no CORS
 * preflight, which a beacon cannot make), already deduplicated, capped and
 * stripped of anything personal; this checks its shape and writes it to the
 * Worker's log as one structured line, which Workers Logs indexes field by
 * field — `event = client_error` finds them all.
 */

export const CLIENT_ERROR_KINDS = ['error', 'rejection', 'boundary', 'webgl'] as const
export type ClientErrorKind = (typeof CLIENT_ERROR_KINDS)[number]

/** The whole body, before parsing. A real report is a few hundred bytes; a stack is the long part. */
export const MAX_REPORT_BYTES = 8 * 1024
const LIMITS = { message: 500, stack: 4000, route: 200, release: 64 }

export interface ClientErrorReport {
  kind: ClientErrorKind
  message: string
  stack?: string
  route?: string
  release?: string
}

/**
 * A request's body as text, or null once it passes `max` bytes — counted as
 * the bytes arrive, so a body sent without a `Content-Length` (chunked) is cut
 * off at the cap instead of buffered whole first.
 */
export async function readCapped(request: Request, max: number): Promise<string | null> {
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

const optional = (value: unknown, max: number) =>
  value === undefined || (typeof value === 'string' && value.length <= max)

/** A report as the page shapes one, or null for anything else. */
export function parseReport(text: string): ClientErrorReport | null {
  if (text.length > MAX_REPORT_BYTES) return null
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const { kind, message, stack, route, release } = body as Record<string, unknown>
  if (!CLIENT_ERROR_KINDS.includes(kind as ClientErrorKind)) return null
  if (typeof message !== 'string' || !message.trim() || message.length > LIMITS.message) return null
  if (!optional(stack, LIMITS.stack) || !optional(route, LIMITS.route) || !optional(release, LIMITS.release))
    return null
  return {
    kind: kind as ClientErrorKind,
    message,
    ...(stack ? { stack: stack as string } : {}),
    ...(route ? { route: route as string } : {}),
    ...(release ? { release: release as string } : {}),
  }
}

/**
 * One line per report. No address and no identity: the browser is described by
 * its user agent and the country the edge saw it from, which is enough to
 * reproduce a bug and not enough to find a person.
 */
export function logReport(report: ClientErrorReport, request: Request): void {
  const cf = (request as Request & { cf?: { country?: string } }).cf
  console.error({
    event: 'client_error',
    ...report,
    userAgent: request.headers.get('user-agent')?.slice(0, 300) ?? null,
    country: cf?.country ?? null,
  })
}
