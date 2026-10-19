import { getAdapter, resolveGame } from '@games/shared/online'
import { generateRoomCode, normalizeRoomCode } from '@games/shared/protocol/codes'
import type { Env } from './env'
import { requestCredentials, resolveIdentity, resolvePlayerId, verifyClerkToken } from './auth'
import { playerHandle, validHandle } from './handles'
import { validSubscription } from './push'
import { track } from './analytics'
import { secureRandom } from './room'
import { allowedOrigin, corsHeaders, isLocalWorker } from './cors'
import { presenceKey, resolvePresenceGame, validPresenceId } from './presence'
import { overLimit, RETRY_AFTER_S, sourceTag } from './limits'
import { logReport, MAX_REPORT_BYTES, parseReport, readCapped } from './clientErrors'

export { RoomDO } from './room'
export { LobbyDO } from './lobby'
export { PresenceDO } from './presence'
export { PlayerDO } from './player'

function json(data: unknown, status: number, origin: string | null): Response {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (origin) for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v as string)
  return new Response(JSON.stringify(data), { status, headers })
}

/** Refused for asking too often, with how long to leave it before asking again. */
function tooMany(origin: string | null): Response {
  const response = json({ error: 'too many requests' }, 429, origin)
  response.headers.set('Retry-After', String(RETRY_AFTER_S))
  return response
}

/**
 * A request body as a JSON object, or null. `null`, `[]` and `"x"` all parse,
 * and reading a field off the first would throw and answer 500 rather than 400.
 */
async function readObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json()
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** A player's own reads: never cached anywhere between them and the browser. */
function personal(response: Response): Response {
  response.headers.set('Cache-Control', 'no-store')
  return response
}

/**
 * The player a request speaks for, from its headers (see `requestCredentials`),
 * and the handle their record lives under. Null when the credentials are
 * missing or do not verify.
 */
async function requestPlayer(request: Request, env: Env) {
  const who = await resolvePlayerId(
    requestCredentials(request),
    env,
    verifyClerkToken,
    isLocalWorker(request.url),
  )
  return who ? { ...who, handle: await playerHandle(who.id) } : null
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const local = isLocalWorker(url)
    const origin = allowedOrigin(request.headers.get('Origin'), local)

    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: origin ? corsHeaders(origin) : {} })
    if (url.pathname === '/health') return json({ ok: true }, 200, origin)

    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      if (await overLimit(env.ROOMS_LIMITER, request)) return tooMany(origin)
      const body = await readObject(request)
      if (!body) return json({ error: 'invalid JSON' }, 400, origin)
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
      const host = await resolveIdentity(body, env, verifyClerkToken, local)
      if (!host) return json({ error: 'invalid identity' }, 400, origin)
      const source = await sourceTag(request)
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
          source,
        })
        if (created) {
          track(env, 'room_created', { game, detail: visibility, count: seats, value: bots.length })
          return json({ code }, 201, origin)
        }
      }
      return json({ error: 'could not allocate a room code' }, 500, origin)
    }

    const roomMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]+)$/)
    if (roomMatch && request.method === 'GET') {
      const code = normalizeRoomCode(roomMatch[1])
      if (!code) return json({ error: 'invalid room code' }, 404, origin)
      // Counted before the room is woken: a reconnect loop gone wrong should
      // cost this Worker a header check, not a Durable Object a socket.
      if (await overLimit(env.SOCKETS_LIMITER, request)) return tooMany(origin)
      // A browser always says which page opened a socket. There are no cookies
      // to ride along, so this is not about credentials: it stops another site
      // opening sockets from its visitors' browsers, on their addresses' limits.
      // Scripts send no Origin, and are held to the limit above instead.
      const opener = request.headers.get('Origin')
      if (opener && !origin) return json({ error: 'origin not allowed' }, 403, null)
      return env.ROOM.getByName(code).fetch(request)
    }

    const replayMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]+)\/replay$/)
    if (replayMatch && request.method === 'GET') {
      const code = normalizeRoomCode(replayMatch[1])
      if (!code) return json({ error: 'not found' }, 404, origin)
      // `last` is the only game a room offers today; anything else is a link
      // from a future this server does not know about.
      const which = url.searchParams.get('game') ?? 'last'
      if (which !== 'last') return json({ error: 'unknown game selector' }, 400, origin)
      if (await overLimit(env.REPLAYS_LIMITER, request)) return tooMany(origin)
      const replay = await env.ROOM.getByName(code).replayJson()
      if (replay === null) return personal(json({ error: 'not found' }, 404, origin))
      const headers = new Headers({ 'content-type': 'application/json' })
      if (origin) for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v as string)
      // A rematch that finishes replaces what `last` means, so nothing in
      // between may hold on to the old one.
      headers.set('Cache-Control', 'no-store')
      return new Response(replay, { status: 200, headers })
    }

    if (url.pathname === '/api/presence' && request.method === 'POST') {
      if (await overLimit(env.PRESENCE_LIMITER, request)) return tooMany(origin)
      const body = await readObject(request)
      if (!body) return json({ error: 'invalid JSON' }, 400, origin)
      const clientId = validPresenceId(body.clientId)
      const tabId = validPresenceId(body.tabId)
      const game = resolvePresenceGame(body.game)
      if (!clientId || !tabId || game === null) return json({ error: 'invalid presence beat' }, 400, origin)
      const counts = await env.PRESENCE.getByName('global').beat(
        await presenceKey(clientId),
        await presenceKey(tabId),
        game,
        await sourceTag(request),
      )
      return json(counts, 200, origin)
    }

    if (url.pathname === '/api/errors' && request.method === 'POST') {
      // Checked against the declared length first, so an oversized body is
      // refused without being read.
      if (Number(request.headers.get('content-length') ?? 0) > MAX_REPORT_BYTES)
        return json({ error: 'report too large' }, 413, origin)
      if (await overLimit(env.ERRORS_LIMITER, request)) return tooMany(origin)
      // And counted as it arrives, for a body that declared no length at all.
      const text = await readCapped(request, MAX_REPORT_BYTES)
      if (text === null) return json({ error: 'report too large' }, 413, origin)
      const report = parseReport(text)
      if (!report) return json({ error: 'invalid report' }, 400, origin)
      logReport(report, request)
      return new Response(null, { status: 204, headers: origin ? corsHeaders(origin) : {} })
    }

    if (url.pathname === '/api/me' && request.method === 'GET') {
      if (await overLimit(env.PROFILES_LIMITER, request)) return tooMany(origin)
      const me = await requestPlayer(request, env)
      if (!me) return personal(json({ error: 'unauthorized' }, 401, origin))
      const profile = await env.PLAYER.getByName(me.handle).profile(me.handle, true)
      return personal(json(profile, 200, origin))
    }

    const playerMatch = url.pathname.match(/^\/api\/players\/([^/]+)$/)
    if (playerMatch && request.method === 'GET') {
      if (await overLimit(env.PROFILES_LIMITER, request)) return tooMany(origin)
      const handle = playerMatch[1]
      if (!validHandle(handle)) return json({ error: 'not found' }, 404, origin)
      const profile = await env.PLAYER.getByName(handle).profile(handle, false)
      if (!profile) return json({ error: 'not found' }, 404, origin)
      const response = json(profile, 200, origin)
      // Public and slow to change: a minute at the edge is plenty fresh.
      response.headers.set('Cache-Control', 'public, max-age=60')
      return response
    }

    if (url.pathname === '/api/push/key' && request.method === 'GET') {
      // Both halves, or the browser would subscribe to a sender that can never send.
      const key = env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY ? env.VAPID_PUBLIC_KEY : null
      return json({ key }, 200, origin)
    }

    if (
      url.pathname === '/api/push/subscription' &&
      (request.method === 'POST' || request.method === 'DELETE')
    ) {
      if (await overLimit(env.PROFILES_LIMITER, request)) return tooMany(origin)
      const me = await requestPlayer(request, env)
      if (!me) return json({ error: 'unauthorized' }, 401, origin)
      const body = await readObject(request)
      const player = env.PLAYER.getByName(me.handle)
      if (request.method === 'DELETE') {
        if (typeof body?.endpoint !== 'string') return json({ error: 'invalid subscription' }, 400, origin)
        await player.unsubscribe(body.endpoint)
        return new Response(null, { status: 204, headers: origin ? corsHeaders(origin) : {} })
      }
      const subscription = validSubscription(body?.subscription)
      if (!subscription) return json({ error: 'invalid subscription' }, 400, origin)
      await player.subscribe(subscription)
      return new Response(null, { status: 204, headers: origin ? corsHeaders(origin) : {} })
    }

    if (url.pathname === '/api/lobby' && request.method === 'GET') {
      if (await overLimit(env.LOBBY_LIMITER, request)) return tooMany(origin)
      const game = resolveGame(url.searchParams.get('game')) ?? undefined
      const rooms = await env.LOBBY.getByName('global').list(game)
      return json({ rooms }, 200, origin)
    }

    return json({ error: 'not found' }, 404, origin)
  },
} satisfies ExportedHandler<Env>
