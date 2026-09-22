import { useState } from 'react'
import { Globe2, Link2, Users } from 'lucide-react'
import { createGame } from '@games/shared/chess'
import OnlinePanel from '../../online/OnlinePanel'
import { chessGame } from '../catalog'
import ChessShell from './ChessShell'
import ChessBoard from './scene/ChessBoard'
import type { SceneState } from './scene/createScene'

export default function ChessLobby() {
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
          <OnlinePanel game="chess" basePath={chessGame.path} appearance="chess" />
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
