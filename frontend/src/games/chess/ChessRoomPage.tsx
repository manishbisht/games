import { useMemo } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { normalizeRoomCode } from '@games/shared/protocol/codes'
import type { ChessSeat, SeatInfo } from '@games/shared/protocol'
import type { ReactNode } from 'react'
import { useIdentity } from '../../online/identity'
import { useRoom } from '../../online/useRoom'
import ChessGame from './ChessGame'
import type { OnlineChessSession } from './online/session'
import './ChessGame.css'

const other = (seat: ChessSeat): ChessSeat => (seat === 'w' ? 'b' : 'w')
const player = (seat?: SeatInfo) => (seat ? { name: seat.player.name, connected: seat.connected } : undefined)

export default function ChessRoomPage() {
  const { code: raw } = useParams()
  const identity = useIdentity()
  const code = normalizeRoomCode(raw ?? '')
  if (!code)
    return (
      <Notice title="That link looks wrong.">
        <Link to="/chess">Back to Gambit</Link>
      </Notice>
    )
  // `Room` owns the socket, and the join frame carries our identity — so don't
  // mount it (or prompt for a name we may not need) until the identity settles.
  if (!identity.isReady) return <p role="status">Joining room {code}…</p>
  if (!identity.name) return <NamePrompt />
  return <Room code={code} />
}

function Notice({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <main className="ch-room-notice">
      <h1>{title}</h1>
      {children}
    </main>
  )
}

function NamePrompt() {
  const identity = useIdentity()
  return (
    <Notice title="Pick a name to join the table.">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          const data = new FormData(event.currentTarget)
          identity.setName(String(data.get('name') ?? ''))
        }}
      >
        <input name="name" maxLength={24} placeholder="Your name" aria-label="Your name" />
        <button type="submit">Join room</button>
      </form>
    </Notice>
  )
}

function Room({ code }: { code: string }) {
  const navigate = useNavigate()
  const { room, api } = useRoom(code)
  const { snapshot, you } = room
  const leave = () => navigate('/chess')

  const session = useMemo<OnlineChessSession | null>(() => {
    if (!snapshot?.gameState || !you) return null
    const mySeat = you.seat
    return {
      state: snapshot.gameState,
      myColor: mySeat,
      players: { w: player(snapshot.seats.w), b: player(snapshot.seats.b) },
      rematch: {
        mine: mySeat ? (snapshot.seats[mySeat]?.wantsRematch ?? false) : false,
        theirs: mySeat ? (snapshot.seats[other(mySeat)]?.wantsRematch ?? false) : false,
      },
      send: { move: api.move, resign: api.resign, rematch: api.rematch },
      leave,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, you, api])

  if (room.phase === 'notfound')
    return (
      <Notice title="This room doesn't exist (or has expired).">
        <Link to="/chess">Back to Gambit</Link>
      </Notice>
    )
  if (room.phase === 'expired')
    return (
      <Notice title="This room has expired.">
        <Link to="/chess">Back to Gambit</Link>
      </Notice>
    )
  if (room.phase === 'full')
    return (
      <Notice title="This room already has two players.">
        <Link to="/chess">Back to Gambit</Link>
      </Notice>
    )
  if (!snapshot) return <p role="status">Joining room {code}…</p>

  if (session)
    return (
      <>
        <ChessGame online={session} />
        {room.error && (
          <button className="ch-room-toast" role="status" onClick={api.dismissError}>
            {room.error.message}
          </button>
        )}
        {room.phase === 'reconnecting' && (
          <div className="ch-room-toast" role="status">
            Reconnecting…
          </div>
        )}
      </>
    )

  const seatButton = (seat: ChessSeat, label: string) => {
    const occupant = snapshot.seats[seat]
    const mine = you?.seat === seat
    return (
      <button
        className={`ch-room-seat ${mine ? 'ch-room-seat-mine' : ''}`}
        disabled={Boolean(occupant) && !mine}
        onClick={() => api.sit(seat)}
      >
        <strong>{label}</strong>
        <span>
          {occupant ? `${occupant.player.name}${occupant.connected ? '' : ' (away)'}` : 'Open seat'}
        </span>
      </button>
    )
  }

  const isHost = Boolean(you?.isHost)
  const ready = Boolean(snapshot.seats.w && snapshot.seats.b)
  return (
    <main className="ch-room">
      <h1>Room {snapshot.code}</h1>
      <p>
        Share this link with a friend:{' '}
        <button
          className="ch-room-copy"
          onClick={() => void navigator.clipboard.writeText(window.location.href)}
        >
          Copy link
        </button>
      </p>
      <div className="ch-room-seats">
        {seatButton('w', 'Play as White')}
        {seatButton('b', 'Play as Black')}
      </div>
      {isHost ? (
        <button className="ch-room-start" disabled={!ready} onClick={api.start}>
          {ready ? 'Start the game' : 'Waiting for both seats…'}
        </button>
      ) : (
        <p role="status">{ready ? 'Waiting for the host to start…' : 'Waiting for players…'}</p>
      )}
      {room.error && (
        <p role="alert" onClick={api.dismissError}>
          {room.error.message}
        </p>
      )}
      <Link to="/chess">Leave room</Link>
    </main>
  )
}
