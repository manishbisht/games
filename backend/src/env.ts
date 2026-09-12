import type { RoomDO } from './room'
import type { LobbyDO } from './lobby'

export interface Env {
  ROOM: DurableObjectNamespace<RoomDO>
  LOBBY: DurableObjectNamespace<LobbyDO>
  CLERK_SECRET_KEY?: string
}
