import { useMemo } from 'react'
import type { RoomViewProps } from '../../../online/games'
import PrismGame from '../PrismGame'
import { prismSession } from './session'

/** Prism's half of a room: the room's snapshot becomes this seat's table. */
export default function PrismRoomView({ snapshot, you, api, leave }: RoomViewProps) {
  const session = useMemo(
    () => prismSession(snapshot, you, api, leave),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot, you, api],
  )
  return <PrismGame online={session} />
}
