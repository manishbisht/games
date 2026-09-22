import ThemeControl from '../../theme/ThemeControl'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { ArrowLeft, ArrowRight, BookOpen } from 'lucide-react'
import { Link } from 'react-router'
import { PlayersOnlineBadge } from '../../online/playersOnline'
import { HeaderAuth } from '../../online/identity'
import Modal from './components/Modal'
import './ChessGame.css'
import './ChessLobby.css'

/** Shared surroundings for chess's lobby, invitations, and waiting room. */
export default function ChessShell({ children, inRoom = false }: { children: ReactNode; inRoom?: boolean }) {
  const [help, setHelp] = useState(false)
  return (
    <div className="ch-app ch-online-shell">
      <header className="ch-header">
        <Link to="/chess" className="ch-brand" aria-label="Gambit, chess lobby">
          <span className="ch-brand-mark" aria-hidden="true">
            ♞
          </span>
          <span>
            gambit<span className="ch-brand-dot">.</span>
          </span>
          <span className="ch-brand-divider" />
          <small>THE GAME OF POSSIBILITIES</small>
        </Link>
        <nav aria-label="Game navigation">
          <PlayersOnlineBadge game="chess" className="ch-online-badge" />
          <Link to="/" className="ch-all-games">
            <ArrowLeft size={15} /> All games
          </Link>
          <span className="ch-header-line" />
          <button aria-label="How to play" onClick={() => setHelp(true)}>
            <BookOpen size={16} />
            <span>How to play</span>
          </button>
          <ThemeControl />
          <HeaderAuth readOnly={inRoom} />
        </nav>
      </header>
      {children}
      <footer className="ch-lobby-footer">
        <span>A timeless game. A little more human.</span>
        <span>
          Two players. Endless possibilities. <span aria-hidden="true">✦</span>
        </span>
      </footer>
      {help && (
        <Modal title="How to play" onClose={() => setHelp(false)}>
          <p className="ch-eyebrow">A GOOD GAME STARTS WITH TWO</p>
          <h2>Meet at the board.</h2>
          <p className="ch-dialog-copy">
            Create a room and share the invite link, or enter a friend’s room code. Choose White or Black,
            then the host starts the game when both players are seated.
          </p>
          <p className="ch-dialog-copy">
            White moves first. Select a piece, then a highlighted square to move. Win by putting your
            opponent’s king in check with no legal escape.
          </p>
          <p className="ch-dialog-copy">
            Drag to turn the board, or use the arrow keys and Enter when the board is focused. You can adjust
            the board, sound, and motion in Settings during your game.
          </p>
          <button className="ch-primary" onClick={() => setHelp(false)}>
            Got it <ArrowRight size={16} />
          </button>
        </Modal>
      )}
    </div>
  )
}
