import { generateRoomCode, normalizeRoomCode } from '@games/shared/protocol/codes'
import type { Env } from './env'
import { resolveIdentity } from './auth'
import { allowedOrigin, corsHeaders } from './cors'

export { RoomDO } from './room'
export { LobbyDO } from './lobby'

function json(data: unknown, status: number, origin: string | null): Response {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (origin) for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v as string)
  return new Response(JSON.stringify(data), { status, headers })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const origin = allowedOrigin(request.headers.get('Origin'))

    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: origin ? corsHeaders(origin) : {} })
    if (url.pathname === '/health') return json({ ok: true }, 200, origin)

    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      let body: Record<string, unknown>
      try {
        body = await request.json()
      } catch {
        return json({ error: 'invalid JSON' }, 400, origin)
      }
      if (body.game !== 'chess') return json({ error: 'unknown game' }, 400, origin)
      const visibility = body.visibility === 'public' ? 'public' : 'private'
      const host = await resolveIdentity(body, env)
      if (!host) return json({ error: 'invalid identity' }, 400, origin)
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = generateRoomCode()
        const created = await env.ROOM.getByName(code).create({ code, game: 'chess', visibility, host })
        if (created) return json({ code }, 201, origin)
      }
      return json({ error: 'could not allocate a room code' }, 500, origin)
    }

    const roomMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]+)$/)
    if (roomMatch && request.method === 'GET') {
      const code = normalizeRoomCode(roomMatch[1])
      if (!code) return json({ error: 'invalid room code' }, 404, origin)
      return env.ROOM.getByName(code).fetch(request)
    }

    if (url.pathname === '/api/lobby' && request.method === 'GET') {
      const game = url.searchParams.get('game') === 'chess' ? ('chess' as const) : undefined
      const rooms = await env.LOBBY.getByName('global').list(game)
      return json({ rooms }, 200, origin)
    }

    return json({ error: 'not found' }, 404, origin)
  },
} satisfies ExportedHandler<Env>
