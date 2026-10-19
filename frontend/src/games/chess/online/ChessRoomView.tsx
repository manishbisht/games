import { useMemo } from 'react'
import type { ChessAction, Color, GameState } from '@games/shared/chess/types'
import type { RoomViewProps } from '../../../online/games'
import { rematchState, roomBeats, seatPlayers } from '../../../online/session'
import ChessGame from '../ChessGame'
import { hold } from '../components/clock'
import type { OnlineChessSession } from './session'

/** Chess's half of a room: the room's snapshot becomes the board's session. */
export default function ChessRoomView({
  snapshot,
  receivedAt,
  recent,
  reactions,
  you,
  api,
  leave,
}: RoomViewProps) {
  const session = useMemo<OnlineChessSession>(() => {
    // Safe by construction: this view only mounts for a chess room, and the
    // server sent us the seat we are sitting in.
    const send = (action: ChessAction) => api.action(action)
    return {
      state: snapshot.gameState as GameState,
      timing: hold(snapshot.timing, receivedAt),
      recent: roomBeats<GameState>({ snapshot, receivedAt, recent }),
      myColor: you.seat as Color | null,
      players: seatPlayers<Color>(snapshot, (seat) => (seat === 'w' || seat === 'b' ? seat : null)),
      rematch: rematchState(snapshot, you),
      reactions,
      send: {
        move: (from, to, promotion) => send({ kind: 'move', from, to, promotion }),
        resign: () => send({ kind: 'resign' }),
        rematch: api.rematch,
        claimWin: api.claim,
        react: api.react,
      },
      leave,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, receivedAt, recent, reactions, you, api])

  return <ChessGame online={session} />
}
