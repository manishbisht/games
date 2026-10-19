import { useMemo } from 'react'
import type { RoomViewProps } from '../../../online/games'
import PrismGame from '../PrismGame'
import { prismSession } from './session'

/** Prism's half of a room: the room's snapshot becomes this seat's table. */
export default function PrismRoomView({ snapshot, receivedAt, you, api, leave }: RoomViewProps) {
  const session = useMemo(
    () => prismSession(snapshot, receivedAt, you, api, leave),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot, receivedAt, you, api],
  )
  return <PrismGame online={session} />
}
