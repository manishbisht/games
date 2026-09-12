import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import type { PublicRoomSummary, RoomVisibility } from '@games/shared/protocol'
import { normalizeRoomCode } from '@games/shared/protocol/codes'
import { createRoom, fetchLobby } from '../../../online/api'
import { useIdentity } from '../../../online/identity'

export default function OnlinePanel() {
  const navigate = useNavigate()
  const identity = useIdentity()
  const [name, setName] = useState(identity.name)
  const [visibility, setVisibility] = useState<RoomVisibility>('private')
  const [joinCode, setJoinCode] = useState('')
  const [rooms, setRooms] = useState<PublicRoomSummary[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = () =>
    fetchLobby('chess')
      .then(setRooms)
      .catch(() => setRooms(null))
  useEffect(() => {
    fetchLobby('chess')
      .then(setRooms)
      .catch(() => setRooms(null))
  }, [])

  const playerName = identity.isSignedIn ? identity.name : name.trim()

  const rememberName = () => {
    if (!identity.isSignedIn) identity.setName(name)
  }

  const create = async () => {
    setBusy(true)
    setError('')
    try {
      rememberName()
      const code = await createRoom('chess', visibility, playerName, await identity.credentials())
      navigate(`/chess/room/${code}`)
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
    navigate(`/chess/room/${normalized}`)
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
        <button disabled={!playerName || busy} onClick={create}>
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
        <button disabled={!playerName || !joinCode.trim() || busy} onClick={() => join(joinCode)}>
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
                <button disabled={!playerName} onClick={() => join(room.code)}>
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
