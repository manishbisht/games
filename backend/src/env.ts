import type { RoomDO } from './room'
import type { LobbyDO } from './lobby'
import type { PresenceDO } from './presence'

export interface Env {
  ROOM: DurableObjectNamespace<RoomDO>
  LOBBY: DurableObjectNamespace<LobbyDO>
  PRESENCE: DurableObjectNamespace<PresenceDO>
  CLERK_SECRET_KEY?: string
}
