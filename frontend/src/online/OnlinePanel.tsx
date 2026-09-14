import { useCallback, useEffect, useState } from 'react'
import { ArrowRight, Globe2, KeyRound, LockKeyhole, Plus, RefreshCw, Users } from 'lucide-react'
import { useNavigate } from 'react-router'
import type { GameId, PublicRoomSummary, RoomVisibility } from '@games/shared/protocol'
import { normalizeRoomCode } from '@games/shared/protocol/codes'
import { createRoom, fetchLobby } from './api'
import { useIdentity } from './identity'
import './online.css'

export interface OnlinePanelProps {
  game: GameId
  /** Where this game lives, e.g. `/chess`; rooms hang off `${basePath}/room/:code`. */
  basePath: string
  /** Table sizes the host may pick between. Games with one fixed size omit it. */
  seatChoices?: number[]
  appearance?: 'chess'
  /**
   * Someone above already asked for a name — `PlayOptions` does, because its
   * other tab needs one too. Two fields labelled "Your name" on one screen is
   * one too many.
   */
  nameAsked?: boolean
}

/**
 * Who is at a public table. A seat a bot is in is taken, but a table of bots is
 * not a table of people — saying "3/4 seated" would send someone to a room
 * expecting two opponents and one free chair.
 */
function seated(room: PublicRoomSummary): string {
  const people = room.seatsTaken - room.bots
  const count = `${people}/${room.seatsTotal} seated`
  return room.bots ? `${count} · ${room.bots} bot${room.bots === 1 ? '' : 's'}` : count
}

export default function OnlinePanel({
  game,
  basePath,
  seatChoices,
  appearance,
  nameAsked,
}: OnlinePanelProps) {
  const navigate = useNavigate()
  const identity = useIdentity()
  const chess = appearance === 'chess'
  const [name, setName] = useState(identity.name)
  const [visibility, setVisibility] = useState<RoomVisibility>('private')
  const [seats, setSeats] = useState(seatChoices?.[0])
  const [joinCode, setJoinCode] = useState('')
  const [rooms, setRooms] = useState<PublicRoomSummary[]>([])
  const [lobbyStatus, setLobbyStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [refreshCount, setRefreshCount] = useState(0)

  useEffect(() => {
    let active = true
    fetchLobby(game)
      .then((next) => {
        if (!active) return
        setRooms(next)
        setLobbyStatus('ready')
      })
      .catch(() => {
        if (active) setLobbyStatus('error')
      })
    return () => {
      active = false
    }
  }, [game, refreshCount])

  const refresh = useCallback(() => {
    setLobbyStatus('loading')
    setRefreshCount((count) => count + 1)
  }, [])

  const playerName = identity.isSignedIn || nameAsked ? identity.name.trim() : name.trim()
  // Wait for identity to settle so room ownership uses the final identity.
  const blocked = !playerName || busy || !identity.isReady
  const rememberName = () => {
    if (!identity.isSignedIn && !nameAsked) identity.setName(name)
  }

  const create = async () => {
    if (blocked) return
    setBusy(true)
    setError('')
    try {
      rememberName()
      const code = await createRoom(game, visibility, playerName, await identity.credentials(), {
        seats,
      })
      navigate(`${basePath}/room/${code}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  const join = (code: string) => {
    if (blocked) return
    const normalized = normalizeRoomCode(code)
    if (!normalized) {
      setError('Room codes are six letters and numbers.')
      return
    }
    setError('')
    rememberName()
    navigate(`${basePath}/room/${normalized}`)
  }

  return (
    <section className={`ch-online ${chess ? 'ch-online-chess' : ''}`} aria-label="Play online">
      {chess ? (
        <div className="ch-online-heading">
          <span className="ch-online-heading-icon">
            <Globe2 size={21} strokeWidth={1.6} />
          </span>
          <div>
            <h2>Play online</h2>
            <p>A friend. A room. Your next great game.</p>
          </div>
        </div>
      ) : (
        <h3>Play online</h3>
      )}
      {!identity.isSignedIn && !nameAsked ? (
        <label className="ch-online-name">
          Your name
          <input
            value={name}
            maxLength={24}
            autoComplete="nickname"
            onChange={(event) => {
              setName(event.target.value)
              setError('')
            }}
            placeholder="What should we call you?"
          />
        </label>
      ) : (
        chess && (
          <p className="ch-online-identity">
            Playing as <strong>{identity.name}</strong>
          </p>
        )
      )}
      {seatChoices && (
        <div className="ch-online-seats" role="group" aria-label="Table size">
          <span>Table size</span>
          {seatChoices.map((count) => (
            <button
              key={count}
              className={seats === count ? 'selected' : ''}
              aria-pressed={seats === count}
              onClick={() => setSeats(count)}
            >
              {count}
            </button>
          ))}
        </div>
      )}
      <form
        className="ch-online-create"
        onSubmit={(event) => {
          event.preventDefault()
          void create()
        }}
      >
        {chess && (
          <div className="ch-online-section-title">
            <Plus size={16} />
            <h3>Create a room</h3>
          </div>
        )}
        {chess && <p>Set the table. Invite someone to play.</p>}
        <div className="ch-online-row">
          <label className="ch-online-visibility">
            <input
              type="checkbox"
              checked={visibility === 'public'}
              onChange={(event) => setVisibility(event.target.checked ? 'public' : 'private')}
            />
            <span>List in the public lobby</span>
          </label>
          <button type="submit" disabled={blocked}>
            {busy ? 'Creating room…' : 'Create room'} {chess && <ArrowRight size={17} />}
          </button>
        </div>
        {chess && (
          <small className="ch-online-privacy">
            {visibility === 'private' ? (
              <>
                <LockKeyhole size={12} /> Private room · Only people with your code can join
              </>
            ) : (
              <>
                <Globe2 size={12} /> Public room · Anyone in the lobby can join
              </>
            )}
          </small>
        )}
      </form>
      <form
        className="ch-online-join"
        onSubmit={(event) => {
          event.preventDefault()
          join(joinCode)
        }}
      >
        {chess && (
          <div className="ch-online-section-title">
            <KeyRound size={16} />
            <h3>Have a room code?</h3>
          </div>
        )}
        <div className="ch-online-row">
          <input
            value={joinCode}
            maxLength={6}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setJoinCode(event.target.value.toUpperCase())
              setError('')
            }}
            placeholder={chess ? 'ABC123' : 'Room code'}
            aria-label="Room code"
          />
          <button type="submit" disabled={blocked || !joinCode.trim()}>
            {chess ? 'Join room' : 'Join'} {chess && <ArrowRight size={15} />}
          </button>
        </div>
      </form>
      {error && (
        <p className="ch-online-error" role="alert">
          {error}
        </p>
      )}
      <div className="ch-online-lobby">
        <div className="ch-online-lobby-head">
          {chess ? (
            <h3>Open rooms {lobbyStatus === 'ready' && <span>{rooms.length}</span>}</h3>
          ) : (
            <span>Open rooms</span>
          )}
          <button
            type="button"
            onClick={refresh}
            disabled={lobbyStatus === 'loading'}
            aria-label="Refresh rooms"
          >
            {chess && <RefreshCw size={13} />} Refresh
          </button>
        </div>
        {lobbyStatus === 'loading' ? (
          <p role="status">Looking for open rooms…</p>
        ) : lobbyStatus === 'error' ? (
          <p role="status">The game server is unreachable right now.</p>
        ) : rooms.length === 0 ? (
          <div className="ch-online-empty">
            {chess && <Users size={20} strokeWidth={1.5} />}
            <p>
              No open rooms just yet.
              {chess ? <span>Create one and make the first move.</span> : ' Create one!'}
            </p>
          </div>
        ) : (
          <ul>
            {rooms.map((room) => (
              <li key={room.code}>
                {chess ? (
                  <span>
                    <strong>{room.hostName}</strong>
                    <small>{seated(room)}</small>
                  </span>
                ) : (
                  <span>
                    {room.hostName} · {seated(room)}
                  </span>
                )}
                <button
                  type="button"
                  disabled={blocked}
                  onClick={() => join(room.code)}
                  aria-label={`Join ${room.code}`}
                >
                  {chess ? (
                    <>
                      Join <ArrowRight size={14} />
                    </>
                  ) : (
                    `Join ${room.code}`
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
