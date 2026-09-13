import { useMemo } from 'react'
import type { RoomViewProps } from '../../../online/games'
import WildriseGame from '../WildriseGame'
import { wildriseSession } from './session'

/** Wildrise's half of a room: the room's snapshot becomes the table's session. */
export default function WildriseRoomView({ snapshot, you, api, leave }: RoomViewProps) {
  const session = useMemo(
    () => wildriseSession(snapshot, you, api, leave),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot, you, api],
  )
  return <WildriseGame online={session} />
}
