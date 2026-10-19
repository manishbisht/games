import type { RoomDO } from './room'
import type { LobbyDO } from './lobby'
import type { PresenceDO } from './presence'
import type { PlayerDO } from './player'

export interface Env {
  ROOM: DurableObjectNamespace<RoomDO>
  LOBBY: DurableObjectNamespace<LobbyDO>
  PRESENCE: DurableObjectNamespace<PresenceDO>
  /** One per player, named by their public handle (see handles.ts). */
  PLAYER: DurableObjectNamespace<PlayerDO>
  CLERK_SECRET_KEY?: string
  /**
   * Per-address rate limits (`ratelimits` in wrangler.jsonc). Optional because
   * a Worker run without them — a config that drops one — should limit
   * nothing rather than fail every request; see `overLimit`.
   */
  ROOMS_LIMITER?: RateLimit
  SOCKETS_LIMITER?: RateLimit
  ERRORS_LIMITER?: RateLimit
  PROFILES_LIMITER?: RateLimit
  REPLAYS_LIMITER?: RateLimit
  /** Anonymous product events (see analytics.ts). Optional: tests and bare configs run without it. */
  ANALYTICS?: AnalyticsEngineDataset
  /**
   * Web Push (see push.ts). The public key is a plain var browsers fetch from
   * GET /api/push/key; the private key is a secret (`wrangler secret put
   * VAPID_PRIVATE_KEY`, or backend/.dev.vars locally). Without both, nothing
   * is ever sent and the opt-in says notifications are unavailable.
   */
  VAPID_PUBLIC_KEY?: string
  VAPID_PRIVATE_KEY?: string
  /** Who push services can contact about this sender: a `mailto:` or `https:` URL. */
  VAPID_SUBJECT?: string
}
