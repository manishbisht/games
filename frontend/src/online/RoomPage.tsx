import ThemeControl from '../theme/ThemeControl'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { normalizeRoomCode } from '@games/shared/protocol/codes'
import type { RoomSnapshot, SeatId } from '@games/shared/protocol'
import type { ReactNode } from 'react'
import { HeaderAuth, useIdentity } from './identity'
import { useRoom } from './useRoom'
import { onlineGame } from './games'
import type { BotSkill, OnlineGame } from './games'
import { presenceEvents } from './roomState'
import { ArrowLeft, Bot, Check, Copy, Link2, UserMinus } from 'lucide-react'
import ChessShell from '../games/chess/ChessShell'
import { chessGame, games } from '../games/catalog'
import './online.css'

const TOAST_MS = 4000

/** A skill's label, or the raw id if the server offers one we have no word for. */
const skillLabel = (skills: BotSkill[], id: string) => skills.find((skill) => skill.id === id)?.label ?? id

/** Say who is actually at the table, rather than how many seats are full. */
function startLabel(people: number, bots: number, full: boolean): string {
  const who = `${people} player${people === 1 ? '' : 's'}`
  const withBots = bots ? `${who} and ${bots} bot${bots === 1 ? '' : 's'}` : who
  return full ? `Start the game · ${withBots}` : `Start with ${withBots}`
}

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

function RoomFrame({
  config,
  children,
  inRoom = true,
}: {
  config?: OnlineGame
  children: ReactNode
  inRoom?: boolean
}) {
  if (config?.basePath === chessGame.path) return <ChessShell inRoom={inRoom}>{children}</ChessShell>
  const game = games.find((entry) => entry.path === config?.basePath)
  return (
    <div className={`room-shell room-shell-${game?.id ?? 'estate'}`}>
      <header className="room-header">
        <Link to={config?.basePath ?? '/'} className="room-brand">
          {game && <img src={`${import.meta.env.BASE_URL}${game.icon}`} alt="" width="32" height="32" />}
          {config?.name ?? 'Games'}
        </Link>
        <nav aria-label="Game navigation">
          <Link to="/">
            <ArrowLeft size={15} /> All games
          </Link>
          <ThemeControl />
          <HeaderAuth readOnly={inRoom} />
        </nav>
      </header>
      {children}
    </div>
  )
}

function Notice({ title, children, config }: { title: string; children?: ReactNode; config?: OnlineGame }) {
  return (
    <RoomFrame config={config} inRoom={false}>
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
  // The skill each empty seat's picker is showing. Seats nobody has chosen for
  // fall back to the first the game offers, which is what the server would pick.
  const [chosen, setChosen] = useState<Partial<Record<SeatId, string>>>({})
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

  const isHost = Boolean(you?.isHost)
  const skills = config.botSkills ?? []

  const seatSlot = (seat: SeatId, index: number) => {
    const occupant = snapshot.seats[seat]
    const mine = you?.seat === seat
    const bot = occupant?.bot
    const label = config.seatLabel(seat, index)
    // A bot is at the table for every purpose, so the seat button is simply
    // taken. It is the host's to give back, which the control below does.
    return (
      <div key={seat} className="ch-room-seat-slot">
        <button
          className={`ch-room-seat ${mine ? 'ch-room-seat-mine' : ''}`}
          disabled={Boolean(occupant) && !mine}
          onClick={() => (mine ? api.leaveSeat() : api.sit(seat))}
        >
          {config.basePath === chessGame.path && (
            <span className={`ch-room-piece ch-room-piece-${seat}`} aria-hidden="true">
              {seat === 'w' ? '♔' : '♚'}
            </span>
          )}
          <strong>{mine ? 'Leave seat' : label}</strong>
          <span>
            {occupant
              ? `${occupant.player.name}${bot ? ` · ${skillLabel(skills, bot.skill)}` : occupant.connected ? '' : ' (away)'}`
              : 'Open seat'}
          </span>
        </button>
        {isHost && bot && (
          <button
            className="ch-room-bot-remove"
            onClick={() => api.removeBot(seat)}
            aria-label={`Remove ${occupant!.player.name}`}
          >
            <UserMinus size={14} /> Remove
          </button>
        )}
        {isHost && !occupant && skills.length > 0 && (
          <div className="ch-room-bot-add">
            {skills.length > 1 && (
              <select
                aria-label={`Bot skill for ${label}`}
                value={chosen[seat] ?? skills[0].id}
                onChange={(event) => setChosen((all) => ({ ...all, [seat]: event.target.value }))}
              >
                {skills.map((skill) => (
                  <option key={skill.id} value={skill.id}>
                    {skill.label}
                  </option>
                ))}
              </select>
            )}
            <button onClick={() => api.addBot(seat, chosen[seat] ?? skills[0].id)}>
              <Bot size={14} /> Add bot
            </button>
          </div>
        )}
      </div>
    )
  }

  // A game that does not insist on a full table plays with whoever turned up, so
  // "ready" is its own minimum rather than every seat being taken.
  const taken = snapshot.seatIds.filter((seat) => snapshot.seats[seat]).length
  // Bots fill seats for every purpose, fullness included, so `ready` counts
  // them — but the button says both numbers, because "start with 3 players"
  // when two of them are bots is not true.
  const bots = snapshot.seatIds.filter((seat) => snapshot.seats[seat]?.bot).length
  const people = taken - bots
  const ready = taken >= config.minSeats
  return (
    <RoomFrame config={config}>
      <main className="ch-room">
        <p className="ch-eyebrow">A GOOD GAME IS ONE INVITE AWAY</p>
        <h1>Room {snapshot.code}</h1>
        <p className="ch-room-intro">
          {isChess
            ? 'Share a link. Choose a side. Meet at the board.'
            : 'Invite friends, choose a seat, or add bots to get started.'}
        </p>
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
        <div className="ch-room-seats">{snapshot.seatIds.map(seatSlot)}</div>
        {isHost ? (
          <button className="ch-room-start" disabled={!ready} onClick={api.start}>
            {!ready ? 'Waiting for players…' : startLabel(people, bots, taken === snapshot.seatIds.length)}
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
