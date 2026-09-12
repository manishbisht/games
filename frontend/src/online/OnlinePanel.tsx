import { useEffect, useState } from 'react'
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
}

export default function OnlinePanel({ game, basePath }: OnlinePanelProps) {
  const navigate = useNavigate()
  const identity = useIdentity()
  const [name, setName] = useState(identity.name)
  const [visibility, setVisibility] = useState<RoomVisibility>('private')
  const [joinCode, setJoinCode] = useState('')
  const [rooms, setRooms] = useState<PublicRoomSummary[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = () =>
    fetchLobby(game)
      .then(setRooms)
      .catch(() => setRooms(null))
  useEffect(() => {
    fetchLobby(game)
      .then(setRooms)
      .catch(() => setRooms(null))
  }, [game])

  const playerName = identity.isSignedIn ? identity.name : name.trim()
  // Until the identity is settled we'd send a guest id that a signed-in user is
  // about to stop being — which is how you end up not owning your own room.
  const blocked = !playerName || busy || !identity.isReady

  const rememberName = () => {
    if (!identity.isSignedIn) identity.setName(name)
  }

  const create = async () => {
    setBusy(true)
    setError('')
    try {
      rememberName()
      const code = await createRoom(game, visibility, playerName, await identity.credentials())
      navigate(`${basePath}/room/${code}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  const join = (code: string) => {
    const normalized = normalizeRoomCode(code)
    if (!normalized) {
      setError('Room codes are six letters and numbers.')
      return
    }
    rememberName()
    navigate(`${basePath}/room/${normalized}`)
  }

  return (
    <section className="ch-online" aria-label="Play online">
      <h3>Play online</h3>
      {!identity.isSignedIn && (
        <label className="ch-online-name">
          Your name
          <input
            value={name}
            maxLength={24}
            onChange={(event) => setName(event.target.value)}
            placeholder="What should we call you?"
          />
        </label>
      )}
      <div className="ch-online-row">
        <label>
          <input
            type="checkbox"
            checked={visibility === 'public'}
            onChange={(event) => setVisibility(event.target.checked ? 'public' : 'private')}
          />{' '}
          List in the public lobby
        </label>
        <button disabled={blocked} onClick={create}>
          Create room
        </button>
      </div>
      <div className="ch-online-row">
        <input
          value={joinCode}
          maxLength={6}
          onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
          placeholder="Room code"
          aria-label="Room code"
        />
        <button disabled={blocked || !joinCode.trim()} onClick={() => join(joinCode)}>
          Join
        </button>
      </div>
      <div className="ch-online-lobby">
        <div className="ch-online-lobby-head">
          <span>Open rooms</span>
          <button onClick={() => void refresh()}>Refresh</button>
        </div>
        {rooms === null ? (
          <p>The game server is unreachable right now.</p>
        ) : rooms.length === 0 ? (
          <p>No open rooms right now — create one!</p>
        ) : (
          <ul>
            {rooms.map((room) => (
              <li key={room.code}>
                <span>
                  {room.hostName} · {room.seatsTaken}/{room.seatsTotal} seated
                </span>
                <button disabled={blocked} onClick={() => join(room.code)}>
                  Join {room.code}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
