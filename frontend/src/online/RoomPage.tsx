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
import { Check, Copy, Link2 } from 'lucide-react'
import ChessShell from '../games/chess/ChessShell'
import { chessGame } from '../games/catalog'
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
  if (!identity.isReady)
    return (
      <RoomFrame config={config}>
        <p className="ch-room-loading" role="status">
          Joining room {code}…
        </p>
      </RoomFrame>
    )
  if (!identity.name) return <NamePrompt config={config} />
  return <Room code={code} config={config} />
}

function RoomFrame({ config, children }: { config?: OnlineGame; children: ReactNode }) {
  return config?.basePath === chessGame.path ? <ChessShell>{children}</ChessShell> : <>{children}</>
}

function Notice({ title, children, config }: { title: string; children?: ReactNode; config?: OnlineGame }) {
  return (
    <RoomFrame config={config}>
      <main className="ch-room-notice">
        {config?.basePath === chessGame.path && (
          <span className="ch-room-emblem" aria-hidden="true">
            ♞
          </span>
        )}
        <h1>{title}</h1>
        {children}
      </main>
    </RoomFrame>
  )
}

const Fatal = ({ config, title }: { config: OnlineGame; title: string }) => (
  <Notice title={title} config={config}>
    <Link to={config.basePath}>Back to {config.name}</Link>
  </Notice>
)

function NamePrompt({ config }: { config: OnlineGame }) {
  const identity = useIdentity()
  return (
    <Notice title="Pick a name to join the table." config={config}>
      <p>Your seat is just a name away. No account needed.</p>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          const data = new FormData(event.currentTarget)
          identity.setName(String(data.get('name') ?? ''))
        }}
      >
        <input
          name="name"
          maxLength={24}
          required
          pattern=".*\S.*"
          autoComplete="nickname"
          placeholder="Your name"
          aria-label="Your name"
        />
        <button type="submit">Join room</button>
      </form>
      <Link to={config.basePath}>Back to {config.name}</Link>
    </Notice>
  )
}

function Room({ code, config }: { code: string; config: OnlineGame }) {
  const navigate = useNavigate()
  const { room, api } = useRoom(code)
  const { snapshot, you } = room
  const leave = () => navigate(config.basePath)
  const isChess = config.basePath === chessGame.path

  // Presence toasts: announce the other seats' disconnects/reconnects.
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
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
  if (!snapshot)
    return (
      <RoomFrame config={config}>
        <p className="ch-room-loading" role="status">
          Joining room {code}…
        </p>
      </RoomFrame>
    )

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
        {config.basePath === chessGame.path && (
          <span className={`ch-room-piece ch-room-piece-${seat}`} aria-hidden="true">
            {seat === 'w' ? '♔' : '♚'}
          </span>
        )}
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
    <RoomFrame config={config}>
      <main className="ch-room">
        {isChess && <p className="ch-eyebrow">A GOOD GAME IS ONE INVITE AWAY</p>}
        <h1>Room {snapshot.code}</h1>
        {isChess && <p className="ch-room-intro">Share a link. Choose a side. Meet at the board.</p>}
        <div className="ch-room-invite">
          <label htmlFor="room-invite">
            <Link2 size={15} /> Invite a friend
          </label>
          <div>
            <input
              id="room-invite"
              readOnly
              value={window.location.href}
              onFocus={(event) => event.target.select()}
            />
            <button
              className="ch-room-copy"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(window.location.href)
                  setCopied(true)
                  setCopyError(false)
                } catch {
                  setCopyError(true)
                }
              }}
            >
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? 'Copied!' : 'Copy link'}
            </button>
          </div>
          {copyError && <p role="status">Select and copy the invite link above to share it.</p>}
        </div>
        {isChess && <p className="ch-room-seat-label">CHOOSE YOUR SIDE</p>}
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
        <Link className="ch-room-leave" to={config.basePath}>
          Leave room
        </Link>
        {toastStack}
      </main>
    </RoomFrame>
  )
}
