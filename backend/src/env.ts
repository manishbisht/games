import type { RoomDO } from './room'
import type { LobbyDO } from './lobby'
import type { PresenceDO } from './presence'

export interface Env {
  ROOM: DurableObjectNamespace<RoomDO>
  LOBBY: DurableObjectNamespace<LobbyDO>
  PRESENCE: DurableObjectNamespace<PresenceDO>
  CLERK_SECRET_KEY?: string
  /**
   * Per-address rate limits (`ratelimits` in wrangler.jsonc). Optional because
   * a Worker run without them — a config that drops one — should limit
   * nothing rather than fail every request; see `overLimit`.
   */
  ROOMS_LIMITER?: RateLimit
  SOCKETS_LIMITER?: RateLimit
  ERRORS_LIMITER?: RateLimit
}
