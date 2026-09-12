import type { Env } from './env'
import { allowedOrigin, corsHeaders } from './cors'

export { RoomDO } from './room'
export { LobbyDO } from './lobby'

function json(data: unknown, status: number, origin: string | null): Response {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (origin) for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v as string)
  return new Response(JSON.stringify(data), { status, headers })
}

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url)
    const origin = allowedOrigin(request.headers.get('Origin'))

    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: origin ? corsHeaders(origin) : {} })
    if (url.pathname === '/health') return json({ ok: true }, 200, origin)

    return json({ error: 'not found' }, 404, origin)
  },
} satisfies ExportedHandler<Env>
