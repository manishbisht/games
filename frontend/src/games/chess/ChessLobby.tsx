import { useState } from 'react'
import { Globe2, Link2, Timer, Users } from 'lucide-react'
import { createGame } from '@games/shared/chess'
import { TIME_CONTROLS } from '@games/shared/chess/types'
import type { TimeControlId } from '@games/shared/chess/types'
import OnlinePanel from '../../online/OnlinePanel'
import { chessGame } from '../catalog'
import ChessShell from './ChessShell'
import ChessBoard from './scene/ChessBoard'
import type { SceneState } from './scene/createScene'
import { controlName } from './components/clock'

/**
 * The clock a new room is made with. Chosen here, before the room exists,
 * because the server deals the clocks with the game — and it travels with the
 * create call as the room's options, which the server checks for itself.
 */
function ClockChoice({ value, onChange }: { value: TimeControlId; onChange: (id: TimeControlId) => void }) {
  return (
    <div className="ch-clock-choice" role="group" aria-label="Clock for a new room">
      <span className="ch-clock-choice-title">
        <Timer size={14} /> Clock for a new room
      </span>
      <div>
        {TIME_CONTROLS.map((control) => (
          <button
            key={control.id}
            type="button"
            aria-pressed={value === control.id}
            className={value === control.id ? 'selected' : ''}
            onClick={() => onChange(control.id)}
          >
            <strong>{control.minutes ? controlName(control.minutes, control.increment) : 'None'}</strong>
            <small>{control.minutes ? control.label : 'Take your time'}</small>
          </button>
        ))}
      </div>
    </div>
  )
}

export default function ChessLobby() {
  const [timeControl, setTimeControl] = useState<TimeControlId>('none')
  // Spread, not written as a prop: OnlinePanel does not declare `options` yet. Once it does — and
  // hands them to `createRoom` — the choice reaches the server with no change here.
  const roomOptions = { options: { timeControl } }
  const [preview] = useState<SceneState>(() => ({
    game: createGame(),
    selected: null,
    legal: [],
    focused: null,
    enabled: false,
    preferences: { theme: 'walnut', highContrast: false },
  }))

  return (
    <ChessShell>
      <main className="ch-lobby">
        <div className="ch-lobby-intro">
          <p className="ch-eyebrow">
            <span /> A CLASSIC, SHARED
          </p>
          <h1>
            A good game.
            <br />A little <em>connection.</em>
          </h1>
          <p>
            Your next move starts with someone.
            <br />
            Invite a friend or find an open table.
          </p>
        </div>
        <div className="ch-lobby-art">
          <div className="ch-lobby-board-caption">
            <span>
              <i /> YOUR BOARD AWAITS
            </span>
            <span>WALNUT & IVORY</span>
          </div>
          <div
            className="ch-lobby-board"
            role="img"
            aria-label="A walnut and ivory chessboard, ready for two players"
          >
            <div inert aria-hidden="true">
              <ChessBoard state={preview} black={false} onSelect={() => {}} showcase />
            </div>
          </div>
          <div className="ch-lobby-board-note">
            <span aria-hidden="true">♙</span> Same board. Wherever you are.
          </div>
        </div>
        <div className="ch-lobby-entry">
          <ClockChoice value={timeControl} onChange={setTimeControl} />
          <OnlinePanel game="chess" basePath={chessGame.path} appearance="chess" {...roomOptions} />
          <p className="ch-lobby-guest-note">
            <Users size={14} /> Just a name. No account needed.
          </p>
        </div>
        <div className="ch-lobby-details">
          <span>
            <Globe2 size={15} /> Play together, from anywhere
          </span>
          <span>
            <Link2 size={15} /> One link to invite a friend
          </span>
        </div>
      </main>
    </ChessShell>
  )
}
