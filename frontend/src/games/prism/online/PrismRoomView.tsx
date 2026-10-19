import { useMemo } from 'react'
import type { RoomViewProps } from '../../../online/games'
import PrismGame from '../PrismGame'
import { prismSession, tableReactions } from './session'

/** Prism's half of a room: the room's snapshot becomes this seat's table. */
export default function PrismRoomView({ snapshot, receivedAt, reactions, you, api, leave }: RoomViewProps) {
  const session = useMemo(
    () => prismSession(snapshot, receivedAt, you, api, leave),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot, receivedAt, you, api],
  )
  // Kept apart from the session: a reaction changes nothing at the table itself.
  const seatReactions = useMemo(() => tableReactions(snapshot, reactions ?? []), [snapshot, reactions])
  return <PrismGame online={session} reactions={seatReactions} />
}
