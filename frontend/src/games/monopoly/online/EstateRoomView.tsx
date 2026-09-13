import { useMemo } from 'react'
import type { RoomViewProps } from '../../../online/games'
import MonopolyGame from '../MonopolyGame'
import { estateSession } from './session'

/** Estate's half of a room: the room's snapshot becomes the table's session. */
export default function EstateRoomView({ snapshot, you, api, leave }: RoomViewProps) {
  const session = useMemo(
    () => estateSession(snapshot, you, api, leave),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot, you, api],
  )
  return <MonopolyGame online={session} />
}
