import { useMemo } from 'react'
import type { RoomViewProps } from '../../../online/games'
import HearthGame from '../HearthGame'
import { hearthSession } from './session'

/** Hearth's half of a room: the room's snapshot becomes the table's session. */
export default function HearthRoomView({ snapshot, receivedAt, recent, you, api, leave }: RoomViewProps) {
  const session = useMemo(
    () => hearthSession({ snapshot, receivedAt, recent, you, api, leave }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot, receivedAt, recent, you, api],
  )
  return <HearthGame online={session} />
}
