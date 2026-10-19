import { useMemo } from 'react'
import type { RoomViewProps } from '../../../online/games'
import MonopolyGame from '../MonopolyGame'
import { estateSession, tableReactions } from './session'

const NO_REACTIONS: NonNullable<RoomViewProps['reactions']> = []

/** Estate's half of a room: the room's snapshot becomes the table's session. */
export default function EstateRoomView({
  snapshot,
  receivedAt,
  recent,
  reactions = NO_REACTIONS,
  you,
  api,
  leave,
}: RoomViewProps) {
  const session = useMemo(
    () => estateSession({ snapshot, receivedAt, recent, you, api, leave }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot, receivedAt, recent, you, api],
  )
  // Kept apart from the session: a reaction is not a change to the table, and
  // should not hand the board a new session to compare.
  const seatIds = snapshot.seatIds
  const atTable = useMemo(() => tableReactions(seatIds, reactions), [seatIds, reactions])
  return <MonopolyGame online={session} reactions={atTable} />
}
