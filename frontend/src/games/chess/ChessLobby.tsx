import { useState } from 'react'
import { ArrowRight, Globe2, Link2, Users } from 'lucide-react'
import { createGame } from '@games/shared/chess'
import PlayOptions from '../../online/PlayOptions'
import { useBotRoom } from '../../online/useBotRoom'
import { chessGame } from '../catalog'
import ChessShell from './ChessShell'
import ChessBoard from './scene/ChessBoard'
import type { SceneState } from './scene/createScene'

/** Labels for what the server will accept; the ids are `chessAdapter.bots.skills`. */
const SKILLS = [
  { id: 'easy', label: 'Easy · a friendly game' },
  { id: 'medium', label: 'Medium · a real opponent' },
]

export default function ChessLobby() {
  const room = useBotRoom('chess', chessGame.path)
  const [skill, setSkill] = useState(SKILLS[0].id)
  const [preview] = useState<SceneState>(() => ({
    game: createGame(),
    selected: null,
    legal: [],
    focused: null,
    enabled: false,
    preferences: {
      theme: 'walnut',
      sound: false,
      highContrast: false,
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    },
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
              <ChessBoard state={preview} black={false} onSelect={() => {}} />
            </div>
          </div>
          <div className="ch-lobby-board-note">
            <span aria-hidden="true">♙</span> Same board. Wherever you are.
          </div>
        </div>
        <div className="ch-lobby-entry">
          <PlayOptions game="chess" basePath={chessGame.path} appearance="chess">
            <div className="ch-lobby-bot">
              <p className="ch-eyebrow">A QUIET OPPONENT</p>
              <h2>Play the machine.</h2>
              <p className="ch-lobby-bot-copy">
                It plays White’s reply the moment you move. No clock, no waiting for anyone.
              </p>
              <label className="ch-lobby-skill">
                Strength
                <select
                  aria-label="Strength"
                  value={skill}
                  onChange={(event) => setSkill(event.target.value)}
                >
                  {SKILLS.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <button className="ch-primary" onClick={() => void room.start({ seats: 2, bots: [skill] })}>
                Let’s play <ArrowRight size={17} />
              </button>
              <p className="ch-lobby-bot-copy">You play White.</p>
            </div>
          </PlayOptions>
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
