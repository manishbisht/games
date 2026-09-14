import { getAdapter, resolveGame } from '@games/shared/online'
import { generateRoomCode, normalizeRoomCode } from '@games/shared/protocol/codes'
import type { Env } from './env'
import { resolveIdentity } from './auth'
import { secureRandom } from './room'
import { allowedOrigin, corsHeaders } from './cors'
import { resolvePresenceGame, validPresenceId } from './presence'

export { RoomDO } from './room'
export { LobbyDO } from './lobby'
export { PresenceDO } from './presence'

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
      // A game is bookable exactly when its adapter is registered — having a
      // name in `GameId` is not enough.
      const game = resolveGame(body.game)
      const adapter = game ? getAdapter(game) : null
      if (!game || !adapter) return json({ error: 'unknown game' }, 400, origin)
      const seats = body.seats === undefined ? adapter.minSeats : body.seats
      if (
        typeof seats !== 'number' ||
        !Number.isInteger(seats) ||
        seats < adapter.minSeats ||
        seats > adapter.maxSeats
      )
        return json({ error: 'unsupported seat count' }, 400, origin)
      // One skill id per bot seat. A room must keep a seat for a person, which
      // is also what stops a table of bots playing itself in a Durable Object.
      const rawBots = body.bots === undefined ? [] : body.bots
      if (!Array.isArray(rawBots) || rawBots.length > seats - 1)
        return json({ error: 'unsupported bots' }, 400, origin)
      const skills = adapter.bots?.skills
      if (rawBots.length > 0 && !skills) return json({ error: 'unsupported bots' }, 400, origin)
      if (rawBots.some((skill) => typeof skill !== 'string' || !skills!.includes(skill)))
        return json({ error: 'unsupported bots' }, 400, origin)
      const bots = rawBots as string[]
      // Only meaningful alongside a bot per remaining seat; `handleJoin` simply
      // ignores it when the room still has room for other people.
      const autoStart = body.autoStart === true
      const options = adapter.validateOptions(body.options)
      const visibility = body.visibility === 'public' ? 'public' : 'private'
      const host = await resolveIdentity(body, env)
      if (!host) return json({ error: 'invalid identity' }, 400, origin)
      for (let attempt = 0; attempt < 5; attempt++) {
        // A private room's code is its invite secret, so it comes from the same
        // CSPRNG the dice do rather than `generateRoomCode`'s Math.random default.
        const code = generateRoomCode(secureRandom)
        const created = await env.ROOM.getByName(code).create({
          code,
          game,
          visibility,
          host,
          seats,
          options,
          bots,
          autoStart,
        })
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

    if (url.pathname === '/api/presence' && request.method === 'POST') {
      let body: Record<string, unknown>
      try {
        body = await request.json()
      } catch {
        return json({ error: 'invalid JSON' }, 400, origin)
      }
      const clientId = validPresenceId(body.clientId)
      const tabId = validPresenceId(body.tabId)
      const game = resolvePresenceGame(body.game)
      if (!clientId || !tabId || game === null)
        return json({ error: 'invalid presence beat' }, 400, origin)
      const counts = await env.PRESENCE.getByName('global').beat(clientId, tabId, game)
      return json(counts, 200, origin)
    }

    if (url.pathname === '/api/lobby' && request.method === 'GET') {
      const game = resolveGame(url.searchParams.get('game')) ?? undefined
      const rooms = await env.LOBBY.getByName('global').list(game)
      return json({ rooms }, 200, origin)
    }

    return json({ error: 'not found' }, 404, origin)
  },
} satisfies ExportedHandler<Env>
