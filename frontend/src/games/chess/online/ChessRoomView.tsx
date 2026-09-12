import { useMemo } from 'react'
import type { ChessAction, Color, GameState } from '@games/shared/chess/types'
import type { SeatInfo } from '@games/shared/protocol'
import type { RoomViewProps } from '../../../online/games'
import ChessGame from '../ChessGame'
import type { OnlineChessSession } from './session'

const other = (seat: Color): Color => (seat === 'w' ? 'b' : 'w')
const player = (seat?: SeatInfo) =>
  seat ? { name: seat.player.name, connected: seat.connected, awaySince: seat.awaySince } : undefined

/** Chess's half of a room: the room's snapshot becomes the board's session. */
export default function ChessRoomView({ snapshot, you, api, leave }: RoomViewProps) {
  const session = useMemo<OnlineChessSession>(() => {
    // Safe by construction: this view only mounts for a chess room, and the
    // server sent us the seat we are sitting in.
    const state = snapshot.gameState as GameState
    const mySeat = you.seat as Color | null
    const send = (action: ChessAction) => api.action(action)
    return {
      state,
      myColor: mySeat,
      players: { w: player(snapshot.seats.w), b: player(snapshot.seats.b) },
      rematch: {
        mine: mySeat ? (snapshot.seats[mySeat]?.wantsRematch ?? false) : false,
        theirs: mySeat ? (snapshot.seats[other(mySeat)]?.wantsRematch ?? false) : false,
      },
      send: {
        move: (from, to, promotion) => send({ kind: 'move', from, to, promotion }),
        resign: () => send({ kind: 'resign' }),
        rematch: api.rematch,
        claimWin: api.claim,
      },
      leave,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, you, api])

  return <ChessGame online={session} />
}
