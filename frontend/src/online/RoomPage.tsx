import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { normalizeRoomCode } from '@games/shared/protocol/codes'
import type { RoomSnapshot, SeatId } from '@games/shared/protocol'
import type { ReactNode } from 'react'
import { useIdentity } from './identity'
import { useRoom } from './useRoom'
import { onlineGame } from './games'
import type { OnlineGame } from './games'
import { presenceEvents } from './roomState'
import './online.css'

const TOAST_MS = 4000

export default function RoomPage({ game }: { game: string }) {
  const { code: raw } = useParams()
  const identity = useIdentity()
  const config = onlineGame(game)
  const code = normalizeRoomCode(raw ?? '')
  if (!config)
    return (
      <Notice title="That link looks wrong.">
        <Link to="/">All games</Link>
      </Notice>
    )
  if (!code) return <Fatal config={config} title="That link looks wrong." />
  // `Room` owns the socket, and the join frame carries our identity — so don't
  // mount it (or prompt for a name we may not need) until the identity settles.
  if (!identity.isReady) return <p role="status">Joining room {code}…</p>
  if (!identity.name) return <NamePrompt />
  return <Room code={code} config={config} />
}

function Notice({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <main className="ch-room-notice">
      <h1>{title}</h1>
      {children}
    </main>
  )
}

const Fatal = ({ config, title }: { config: OnlineGame; title: string }) => (
  <Notice title={title}>
    <Link to={config.basePath}>Back to {config.name}</Link>
  </Notice>
)

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

function Room({ code, config }: { code: string; config: OnlineGame }) {
  const navigate = useNavigate()
  const { room, api } = useRoom(code)
  const { snapshot, you } = room
  const leave = () => navigate(config.basePath)

  // Presence toasts: announce the other seats' disconnects/reconnects.
  const [toasts, setToasts] = useState<{ id: number; text: string }[]>([])
  const toastId = useRef(0)
  const prevSnapshot = useRef<RoomSnapshot | null>(null)
  const mySeat = you?.seat ?? null
  useEffect(() => {
    const events = presenceEvents(prevSnapshot.current, snapshot)
    prevSnapshot.current = snapshot
    for (const event of events) {
      if (event.seat === mySeat) continue
      const id = ++toastId.current
      const text = `${event.name} ${event.connected ? 'reconnected' : 'disconnected'}`
      setToasts((current) => [...current, { id, text }])
      setTimeout(() => setToasts((current) => current.filter((t) => t.id !== id)), TOAST_MS)
    }
  }, [snapshot, mySeat])

  const toastStack = (
    <div className="ch-room-toasts">
      {toasts.map((toast) => (
        <div key={toast.id} className="ch-room-toast" role="status">
          {toast.text}
        </div>
      ))}
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
    </div>
  )

  if (room.phase === 'notfound')
    return <Fatal config={config} title="This room doesn't exist (or has expired)." />
  if (room.phase === 'expired') return <Fatal config={config} title="This room has expired." />
  if (room.phase === 'full') return <Fatal config={config} title="This room is full." />
  if (!snapshot) return <p role="status">Joining room {code}…</p>

  // The game is on: hand the table over to the game itself.
  const RoomView = config.RoomView
  if (snapshot.gameState !== null && you)
    return (
      <>
        <RoomView snapshot={snapshot} you={you} api={api} leave={leave} />
        {toastStack}
      </>
    )

  const seatButton = (seat: SeatId, index: number) => {
    const occupant = snapshot.seats[seat]
    const mine = you?.seat === seat
    return (
      <button
        key={seat}
        className={`ch-room-seat ${mine ? 'ch-room-seat-mine' : ''}`}
        disabled={Boolean(occupant) && !mine}
        onClick={() => (mine ? api.leaveSeat() : api.sit(seat))}
      >
        <strong>{mine ? 'Leave seat' : config.seatLabel(seat, index)}</strong>
        <span>
          {occupant ? `${occupant.player.name}${occupant.connected ? '' : ' (away)'}` : 'Open seat'}
        </span>
      </button>
    )
  }

  const isHost = Boolean(you?.isHost)
  // A game that does not insist on a full table plays with whoever turned up, so
  // "ready" is its own minimum rather than every seat being taken.
  const taken = snapshot.seatIds.filter((seat) => snapshot.seats[seat]).length
  const ready = taken >= config.minSeats
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
      <div className="ch-room-seats">{snapshot.seatIds.map(seatButton)}</div>
      {isHost ? (
        <button className="ch-room-start" disabled={!ready} onClick={api.start}>
          {!ready
            ? 'Waiting for players…'
            : taken === snapshot.seatIds.length
              ? 'Start the game'
              : `Start with ${taken} players`}
        </button>
      ) : (
        <p role="status">{ready ? 'Waiting for the host to start…' : 'Waiting for players…'}</p>
      )}
      <Link to={config.basePath}>Leave room</Link>
      {toastStack}
    </main>
  )
}
