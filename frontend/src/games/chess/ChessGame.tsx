import ThemeControl from '../../theme/ThemeControl'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { PlayersOnlineBadge } from '../../online/playersOnline'
import { HeaderAuth } from '../../online/identity'
import {
  ArrowLeft,
  ArrowUpRight,
  Plus,
  RotateCcw,
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  Flag,
  Handshake,
  Leaf,
  Maximize,
  Minus,
  RotateCw,
  Settings2,
  SwitchCamera,
  Trophy,
  Volume2,
  VolumeX,
} from 'lucide-react'
import ChessBoard from './scene/ChessBoard'
import type { BoardControls } from './scene/ChessBoard'
import type { Impact } from './scene/createScene'
import Modal from './components/Modal'
import PromotionGallery from './components/PromotionGallery'
import { legalMoves, opposite } from '@games/shared/chess'
import { playChessSound } from './game/audio'
import { COLOR_NAMES, GLYPHS, PIECE_NAMES } from '@games/shared/chess/types'
import { CLAIM_WIN_AFTER_MS } from '@games/shared/protocol'
import type { Color, GameState, Preferences, Square } from '@games/shared/chess/types'
import { useHeld } from '../../motion/hooks'
import { setMotionPreference, useReducedMotion } from '../../motion/preference'
import type { OnlineChessSession } from './online/session'
import './ChessGame.css'

// Preferences only. The game itself lives in its room, which is what makes a
// chess table resumable from its link rather than from this browser. Motion is
// the site's one preference (`motion/preference`), not a chess setting.
const PREFS = 'gambit-preferences-v1'
type Dialog = 'settings' | 'help' | 'resign' | null
function storedPreferences(): Preferences {
  const defaults: Preferences = { sound: true, highContrast: false, theme: 'walnut' }
  try {
    const data = JSON.parse(localStorage.getItem(PREFS) || '{}')
    return {
      sound: typeof data.sound === 'boolean' ? data.sound : defaults.sound,
      highContrast: data.highContrast === true,
      theme: data.theme === 'marble' ? 'marble' : 'walnut',
    }
  } catch {
    return defaults
  }
}
const endings: Record<string, string> = {
  checkmate: 'Checkmate.',
  stalemate: 'Stalemate.',
  repetition: 'A familiar position.',
  'fifty-move': 'Fifty moves. A draw.',
  insufficient: 'A balanced ending.',
  resigned: 'A gracious finish.',
  timeout: 'Time’s up.',
  agreement: 'A draw, together.',
}
const drawReasons: Record<string, string> = {
  stalemate: 'No legal moves, and the king is safe.',
  repetition: 'The same position has appeared three times.',
  'fifty-move': 'Fifty moves by each player without a pawn move or capture.',
  insufficient: 'There isn’t enough material for checkmate.',
  agreement: 'Both players agreed to a draw.',
  timeout: 'The opponent cannot possibly deliver checkmate.',
}

function PlayerCard({
  color,
  game,
  active,
  shownCaptures,
  label,
  away,
  you,
  bot,
}: {
  color: Color
  game: GameState
  active: boolean
  /** How many of this seat's captures have reached the tray on the board so far. */
  shownCaptures: number
  label?: string
  away?: boolean
  you?: boolean
  bot?: boolean
}) {
  const captures = game.captured[color],
    shown = captures.slice(0, shownCaptures)
  return (
    <div className={`ch-player ${active ? 'ch-player-active' : ''}`}>
      <div className={`ch-player-avatar ch-avatar-${color}`} aria-hidden="true">
        {GLYPHS[color].k}
      </div>
      <div className="ch-player-details">
        <div>
          <strong>{label ?? COLOR_NAMES[color]}</strong>
          {bot && <span className="ch-small-tag">BOT</span>}
          {you && <span className="ch-small-tag">YOU</span>}
          {away && <span className="ch-small-tag ch-tag-away">AWAY</span>}
        </div>
        <span key={`${active}${game.status}`}>
          {game.status !== 'playing'
            ? 'Game finished'
            : active
              ? you
                ? 'Your move'
                : bot
                  ? 'Considering the position…'
                  : 'Thinking…'
              : 'Watching the board'}
        </span>
      </div>
      {shown.length > 0 && (
        <div
          className="ch-captured"
          aria-label={`${COLOR_NAMES[color]} captured: ${captures.map((p) => PIECE_NAMES[p]).join(', ')}`}
        >
          {shown.map((p, i) => (
            <span key={i} aria-hidden="true">
              {GLYPHS[opposite(color)][p]}
            </span>
          ))}
        </div>
      )}
      <div className="ch-clock" aria-label={`${COLOR_NAMES[color]} clock: no time limit`}>
        {active && game.status === 'playing' && <i />}
        <span className="ch-untimed">— : —</span>
      </div>
    </div>
  )
}

function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean
  onChange: () => void
  label: string
  description: string
}) {
  return (
    <button className="ch-toggle-row" role="switch" aria-checked={checked} onClick={onChange}>
      <span>
        <strong>{label}</strong>
        <small>{description}</small>
      </span>
      <span className={`ch-switch ${checked ? 'on' : ''}`} aria-hidden="true">
        <i />
      </span>
    </button>
  )
}

function AbandonmentNotice({
  name,
  awaySince,
  onClaim,
}: {
  name: string
  awaySince?: number
  onClaim: () => void
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const ticker = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(ticker)
  }, [])
  // The server stamps awaySince; it re-validates any claim, so drift here only shifts the countdown.
  const remaining = Math.max(0, CLAIM_WIN_AFTER_MS - (now - (awaySince ?? now)))
  const seconds = Math.ceil(remaining / 1000)
  return (
    <div className="ch-abandon" role="status">
      {remaining > 0 ? (
        <span>
          {name} disconnected — you can claim the win in {Math.floor(seconds / 60)}:
          {String(seconds % 60).padStart(2, '0')}.
        </span>
      ) : (
        <>
          <span>{name} seems to be gone.</span>
          <button onClick={onClaim}>Claim win</button>
        </>
      )}
    </div>
  )
}

/**
 * A chess table. Always a room's: Gambit is reached through its lobby, which
 * makes one either against a bot or against whoever has the link, so there is
 * no second source of a game here and nothing to restore from this disk.
 */
export default function ChessGame({ online }: { online: OnlineChessSession }) {
  const game = online.state,
    seat = online.myColor
  const [preferences, setPreferences] = useState(storedPreferences)
  const reduced = useReducedMotion()
  const [dialog, setDialog] = useState<Dialog>(null),
    [selected, setSelected] = useState<Square | null>(null)
  const [promotion, setPromotion] = useState<{ from: Square; to: Square; color: Color } | null>(null)
  /** A move sent to the room that has not come back in a snapshot yet. */
  const [sent, setSent] = useState<{ from: Square; to: Square } | null>(null)
  const [black, setBlack] = useState(() => seat === 'b')
  /** The board is still playing out moves the game has already made. */
  const [presenting, setPresenting] = useState(false),
    [graves, setGraves] = useState<Record<Color, number> | null>(null),
    [resultDismissed, setResultDismissed] = useState(false),
    [notice, setNotice] = useState('')
  const board = useRef<BoardControls>(null),
    historyEnd = useRef<HTMLDivElement>(null)
  // Online, the seat orients the board; each fresh game starts clean and shows its own result.
  const [shownSeat, setShownSeat] = useState(seat),
    [seenStatus, setSeenStatus] = useState(game.status),
    [seenPlies, setSeenPlies] = useState(game.history.length)
  if (shownSeat !== seat) {
    setShownSeat(seat)
    setBlack(seat === 'b')
  }
  if (seenStatus !== game.status) {
    setSeenStatus(game.status)
    setPromotion(null)
    setSelected(null)
    setSent(null)
    setNotice('')
    if (game.status === 'playing') setResultDismissed(false)
  }
  // A move on the board, by either side, answers whatever was in flight and retires stale advice.
  if (seenPlies !== game.history.length) {
    setSeenPlies(game.history.length)
    setSelected(null)
    setSent(null)
    setNotice('')
  }
  const pending = useMemo(
    () => (promotion ? { from: promotion.from, to: promotion.to } : sent),
    [promotion, sent],
  )
  const enabled = game.status === 'playing' && !pending && !dialog && seat !== null && game.turn === seat
  const moves = useMemo(() => (selected ? legalMoves(game, selected) : []), [game, selected])
  const destinations = useMemo(
    () => Array.from(new Map(moves.map((m) => [m.to, { to: m.to, capture: !!m.captured }])).values()),
    [moves],
  )
  const sceneState = useMemo(
    () => ({
      game,
      selected,
      legal: destinations,
      focused: null,
      enabled,
      preferences: { theme: preferences.theme, highContrast: preferences.highContrast },
      pending,
      seat,
    }),
    [game, selected, destinations, enabled, preferences.theme, preferences.highContrast, pending, seat],
  )
  const isOver = game.status !== 'playing'
  // The result waits for the board: the mating move lands, the king falls, and the moment is seen.
  const resultReady = useHeld(isOver && !presenting, game.status === 'checkmate' ? 1200 : 500)

  useEffect(() => {
    try {
      localStorage.setItem(PREFS, JSON.stringify(preferences))
    } catch {
      /* Preferences remain available for this visit. */
    }
  }, [preferences])
  useEffect(() => {
    // The room re-validates every move; if one never comes back, put the piece down again.
    if (!sent) return
    const timer = setTimeout(() => setSent(null), 5000)
    return () => clearTimeout(timer)
  }, [sent])
  useEffect(() => {
    historyEnd.current?.scrollIntoView({ block: 'nearest', behavior: reduced ? 'instant' : 'smooth' })
  }, [game.history.length, reduced])

  /** Sounds come from the board, so they land with the piece rather than with the snapshot. */
  function onImpact(kind: Impact) {
    if (preferences.sound) playChessSound(kind)
  }

  function selectSquare(square: Square) {
    if (!enabled) return
    if (square === selected) {
      setSelected(null)
      return
    }
    if (selected && moves.some((m) => m.to === square)) {
      // The piece lifts and waits for the authoritative snapshot to play it.
      if (moves.some((m) => m.to === square && m.promotion))
        setPromotion({ from: selected, to: square, color: game.turn })
      else {
        online.send.move(selected, square)
        setSent({ from: selected, to: square })
      }
      setSelected(null)
      setNotice('')
      return
    }
    const piece = game.pieces.find((p) => p.square === square)
    if (piece?.color === game.turn) {
      setSelected(square)
      setNotice('')
    } else if (selected) setNotice('That square isn’t a legal move. Choose a marked destination.')
  }
  /** Only a seated player may resign, and only their own seat. */
  const resigningColor = seat ?? game.turn
  // The result meta credits whoever is across the board, falling back to the
  // plain word if we never saw their name.
  const onlineOpponent = (seat ? online.players[opposite(seat)]?.name : undefined) || 'opponent'
  const onlineAway = seat && game.status === 'playing' ? online.players[opposite(seat)] : undefined
  const botSkill = online.players.w?.bot ?? online.players.b?.bot
  const turnStatus = isOver
    ? game.winner
      ? `${COLOR_NAMES[game.winner]} wins.`
      : 'Game drawn.'
    : game.check
      ? `${COLOR_NAMES[game.turn]} is in check.`
      : `${COLOR_NAMES[game.turn]}’s turn.`
  const statusDetail = isOver
    ? 'A good game is always worth another.'
    : selected
      ? `${PIECE_NAMES[game.pieces.find((p) => p.square === selected)!.type]} on ${selected} · ${destinations.length} legal ${destinations.length === 1 ? 'move' : 'moves'}`
      : pending || presenting
        ? 'Making a move…'
        : 'Select a piece to see its legal moves.'
  const pairs = Array.from({ length: Math.ceil(game.history.length / 2) }, (_, i) =>
    game.history.slice(i * 2, i * 2 + 2),
  )
  const far: Color = black ? 'w' : 'b',
    near: Color = black ? 'b' : 'w'
  const seatProps = (color: Color) => ({
    label: online.players[color]?.name,
    away: online.players[color]?.connected === false,
    you: seat === color,
    bot: Boolean(online.players[color]?.bot),
    // A capture shows by the captor's name once the piece has reached the tray.
    shownCaptures: Math.min(game.captured[color].length, graves ? graves[opposite(color)] : Infinity),
  })

  return (
    <div className={`ch-app ${preferences.highContrast ? 'ch-contrast' : ''}`}>
      <header className="ch-header">
        <Link to="/" className="ch-brand" aria-label="Gambit, all games">
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
          <button onClick={() => setDialog('help')}>
            <BookOpen size={16} />
            <span>How to play</span>
          </button>
          <button onClick={() => setDialog('settings')} aria-label="Settings">
            <Settings2 size={18} />
          </button>
          <ThemeControl />
          <HeaderAuth readOnly />
        </nav>
      </header>

      <main className="ch-main">
        <div className="ch-page-heading">
          <div>
            <p className="ch-eyebrow">
              <span /> A CLASSIC, IN A NEW DIMENSION
            </p>
            <h1>Make your next move.</h1>
            <p>A quiet moment. A worthy opponent. A world of possibility.</p>
          </div>
          <div className="ch-edition">
            <span>01</span>
            <div>
              THE CLASSIC COLLECTION<small>Chess · Reimagined</small>
            </div>
          </div>
        </div>
        <div className="ch-layout">
          <section className="ch-board-column" aria-label="Chess table">
            <PlayerCard color={far} game={game} active={game.turn === far} {...seatProps(far)} />
            <div className="ch-table">
              <div className="ch-table-caption">
                <span>
                  <i /> {isOver ? 'A GAME WELL PLAYED' : 'AT THE TABLE'}
                </span>
                <span>{preferences.theme === 'walnut' ? 'WALNUT & IVORY' : 'THE MARBLE EDITION'}</span>
              </div>
              <ChessBoard
                ref={board}
                state={sceneState}
                black={black}
                onSelect={selectSquare}
                onImpact={onImpact}
                onPresenting={setPresenting}
                onGraves={setGraves}
              />
              <div className="ch-table-controls">
                <div className="ch-view-controls">
                  <button onClick={() => setBlack((v) => !v)} aria-label="Flip board">
                    <SwitchCamera size={16} />
                    <span>Flip board</span>
                  </button>
                  <i />
                  <button onClick={() => board.current?.zoom(-1)} aria-label="Zoom out">
                    <Minus size={16} />
                  </button>
                  <button onClick={() => board.current?.zoom(1)} aria-label="Zoom in">
                    <Plus size={16} />
                  </button>
                  <i />
                  <button onClick={() => board.current?.top()} aria-label="View from above">
                    <Maximize size={15} />
                  </button>
                  <button onClick={() => board.current?.reset()} aria-label="Reset camera">
                    <RotateCw size={15} />
                  </button>
                </div>
                <button
                  className="ch-sound"
                  aria-label={preferences.sound ? 'Mute sound' : 'Enable sound'}
                  onClick={() => setPreferences((p) => ({ ...p, sound: !p.sound }))}
                >
                  {preferences.sound ? <Volume2 size={16} /> : <VolumeX size={16} />}
                </button>
              </div>
            </div>
            <PlayerCard color={near} game={game} active={game.turn === near} {...seatProps(near)} />
            <div className="ch-board-footnote">
              <span>
                <RotateCw size={12} /> Drag a piece to move it <i /> Drag the board to orbit
              </span>
              <span>Tab to board · Arrow keys & Enter</span>
            </div>
          </section>

          <aside className="ch-sidebar">
            <section className="ch-panel ch-session">
              <div className="ch-session-label">
                <p className="ch-eyebrow">ONLINE MATCH</p>
                <span className={`ch-live-dot ${isOver ? 'ended' : ''}`} />
              </div>
              <h2 key={turnStatus} className={game.check && !isOver ? 'ch-check-text' : ''}>
                {turnStatus}
              </h2>
              <p className="ch-panel-copy" aria-live="polite">
                {statusDetail}
              </p>
              <div className="ch-session-tags">
                <span>
                  <Leaf size={12} /> No time limit
                </span>
                <span>{botSkill ? `${botSkill} bot` : 'Two players'}</span>
              </div>
              <div className="ch-history-heading">
                <h3>Move history</h3>
                <span>
                  {game.history.length} {game.history.length === 1 ? 'move' : 'moves'}
                </span>
              </div>
              <div className="ch-history" aria-label="Move history">
                {pairs.length ? (
                  <>
                    <div className="ch-history-columns">
                      <span>#</span>
                      <span>WHITE</span>
                      <span>BLACK</span>
                    </div>
                    {pairs.map((pair, i) => (
                      <div className={`ch-history-row ${i === pairs.length - 1 ? 'latest' : ''}`} key={i}>
                        <span>{i + 1}.</span>
                        {[0, 1].map((side) => (
                          // Keyed by the move, so a reply filling in its half of the row slides in too.
                          <span
                            key={`${side}${pair[side]?.san ?? ''}`}
                            className={pair[side] ? 'ch-san' : ''}
                          >
                            {pair[side]?.san || '—'}
                          </span>
                        ))}
                      </div>
                    ))}
                    <div ref={historyEnd} />
                  </>
                ) : (
                  <div className="ch-empty-history">
                    <span aria-hidden="true">♙</span>
                    <p>
                      Every great game
                      <br />
                      begins with a single move.
                    </p>
                    <small>Your story starts on the board.</small>
                  </div>
                )}
              </div>
              <div className="ch-game-actions">
                <button disabled={isOver || !seat} onClick={() => setDialog('resign')}>
                  <Flag size={15} />
                  Resign
                </button>
              </div>
              <button className="ch-primary" onClick={online.leave}>
                <ArrowLeft size={17} /> Leave room
              </button>
              {notice && (
                <p className="ch-notice motion-enter" role="status">
                  {notice}
                </p>
              )}
              {isOver && resultDismissed && (
                <button className="ch-show-result motion-enter" onClick={() => setResultDismissed(false)}>
                  View game result <ChevronRight size={14} />
                </button>
              )}
            </section>
            <div className="ch-thought">
              <div className="ch-thought-icon">
                <Leaf size={20} strokeWidth={1.4} />
              </div>
              <div>
                <h3>A little space to think.</h3>
                <p>
                  No rush. No distractions.
                  <br />
                  Just you and the next possibility.
                </p>
              </div>
              <span aria-hidden="true">✦</span>
            </div>
            <button className="ch-learn-link" onClick={() => setDialog('help')}>
              <BookOpen size={16} />
              <span>
                New to the board? <strong>Learn the essentials</strong>
              </span>
              <ArrowUpRight size={16} />
            </button>
          </aside>
        </div>
        <div className="sr-only" role="status" aria-live="polite">
          {turnStatus} {game.history.at(-1) ? `Last move: ${game.history.at(-1)!.san}.` : ''}
        </div>
      </main>
      <footer className="ch-footer">
        <span>Less scrolling. More thinking.</span>
        <span>
          <span className="ch-footer-dot" /> A TIMELESS GAME. A LITTLE MORE HUMAN.
        </span>
        <span>
          Made for a good game <span className="ch-footer-star">✦</span>
        </span>
      </footer>

      <Modal title="Settings" open={dialog === 'settings'} onClose={() => setDialog(null)}>
        <p className="ch-eyebrow">MAKE YOURSELF AT HOME</p>
        <h2>Your kind of game.</h2>
        <p className="ch-dialog-copy">Small details. A better place to play.</p>
        <label className="ch-field-label">YOUR CHESS SET</label>
        <div className="ch-theme-options">
          {(['walnut', 'marble'] as const).map((theme) => (
            <button
              key={theme}
              className={preferences.theme === theme ? 'selected' : ''}
              aria-pressed={preferences.theme === theme}
              onClick={() => setPreferences((p) => ({ ...p, theme }))}
            >
              <span className={`ch-theme-swatch ${theme}`} />
              <strong>{theme === 'walnut' ? 'Walnut & ivory' : 'Cool marble'}</strong>
              <small>{theme === 'walnut' ? 'Warm. Familiar. Timeless.' : 'Quiet. Crisp. Considered.'}</small>
              {preferences.theme === theme && <Check size={15} />}
            </button>
          ))}
        </div>
        <Toggle
          label="Sound effects"
          description="A soft note with every move."
          checked={preferences.sound}
          onChange={() => setPreferences((p) => ({ ...p, sound: !p.sound }))}
        />
        <Toggle
          label="Reduced motion"
          description="Shorter, gentler moves and camera changes, here and across the site."
          checked={reduced}
          onChange={() => setMotionPreference(reduced ? 'full' : 'reduced')}
        />
        <Toggle
          label="Higher contrast"
          description="Stronger text and move indicators."
          checked={preferences.highContrast}
          onChange={() => setPreferences((p) => ({ ...p, highContrast: !p.highContrast }))}
        />
        <button className="ch-primary" onClick={() => setDialog(null)}>
          All set <Check size={17} />
        </button>
      </Modal>

      <Modal title="How to play" open={dialog === 'help'} onClose={() => setDialog(null)}>
        <p className="ch-eyebrow">THE ESSENTIALS</p>
        <h2>One board. Infinite stories.</h2>
        <p className="ch-dialog-copy">
          White moves first. Take turns moving one piece. Win by checking the enemy king so it has no legal
          escape.
        </p>
        <div className="ch-rules-pieces">
          {(
            [
              ['k', 'One square in any direction. Keep your king safe.'],
              ['q', 'Any number of squares, in any straight line.'],
              ['r', 'Any number of squares, horizontally or vertically.'],
              ['b', 'Any number of squares, diagonally.'],
              ['n', 'Two squares, then one sideways. Jumps over pieces.'],
              ['p', 'One square forward, or two on its first move. Captures diagonally.'],
            ] as const
          ).map(([p, description]) => (
            <div key={p}>
              <span aria-hidden="true">{GLYPHS.w[p]}</span>
              <p>
                <strong>{PIECE_NAMES[p]}</strong>
                {description}
              </p>
            </div>
          ))}
        </div>
        <details>
          <summary>Special moves & draws</summary>
          <p>
            <strong>Castling:</strong> Select the king, then move it two squares toward a rook. Neither piece
            may have moved, the path must be empty, and the king cannot be in, pass through, or land in check.
          </p>
          <p>
            <strong>En passant:</strong> Immediately after an enemy pawn advances two squares beside your
            pawn, you may capture it as if it moved one.
          </p>
          <p>
            <strong>Promotion:</strong> Reach the last rank with a pawn and choose a queen, rook, bishop, or
            knight.
          </p>
          <p>
            <strong>Draws:</strong> Stalemate and insufficient material end the game. In this casual version,
            threefold repetition and the fifty-move rule are adjudicated automatically.
          </p>
        </details>
        <details>
          <summary>Board controls & accessibility</summary>
          <p>
            Click or tap your piece, then a marked destination. Dots are quiet moves; rings mark captures. The
            last move remains shaded. A checked king has a red ring and its attackers are outlined.
          </p>
          <p>
            Drag to orbit, scroll or pinch to zoom, and use Flip board for the opposite perspective. With the
            board focused, use arrow keys to explore, Enter or Space to select or move, and Escape to
            deselect. The starting keyboard square is e2.
          </p>
          <p>
            Drag a piece to its square, or click it and then a marked destination. Close the page and reopen
            your room link to reconnect to the same game.
          </p>
        </details>
        <button className="ch-primary" onClick={() => setDialog(null)}>
          Back to the board <ArrowRight size={16} />
        </button>
      </Modal>

      <Modal title="Confirm resignation" open={dialog === 'resign'} onClose={() => setDialog(null)}>
        <div className="ch-confirm-icon">
          <Flag size={26} />
        </div>
        <h2>Ready to call it?</h2>
        <p className="ch-dialog-copy">
          {COLOR_NAMES[resigningColor]} will resign and {COLOR_NAMES[opposite(resigningColor)]} will win.
        </p>
        <div className="ch-dialog-actions">
          <button className="ch-secondary" onClick={() => setDialog(null)}>
            Keep playing
          </button>
          <button
            className="ch-primary"
            onClick={() => {
              online.send.resign()
              setDialog(null)
            }}
          >
            Resign game
          </button>
        </div>
      </Modal>

      {/* Not locked: a mis-tap onto the last rank can be taken back, and the pawn returns. */}
      <Modal title="Promote pawn" open={!!promotion && !isOver} onClose={() => setPromotion(null)}>
        <p className="ch-eyebrow">A WELL-EARNED PROMOTION</p>
        <h2>A new possibility.</h2>
        <p className="ch-dialog-copy">
          Your pawn has reached the final rank.
          <br />
          Choose the piece it will become.
        </p>
        {promotion && (
          <PromotionGallery
            color={promotion.color}
            theme={preferences.theme}
            onChoose={(p) => {
              online.send.move(promotion.from, promotion.to, p)
              setSent({ from: promotion.from, to: promotion.to })
              setPromotion(null)
            }}
          />
        )}
      </Modal>
      {onlineAway && !onlineAway.connected && (
        <AbandonmentNotice
          name={onlineAway.name}
          awaySince={onlineAway.awaySince}
          onClaim={() => online.send.claimWin()}
        />
      )}
      <Modal
        title="Game result"
        open={isOver && resultReady && !resultDismissed && !dialog}
        onClose={() => setResultDismissed(true)}
      >
        <div className="ch-result-icon">
          {game.winner ? <Trophy size={31} strokeWidth={1.4} /> : <Handshake size={31} strokeWidth={1.4} />}
        </div>
        <p className="ch-eyebrow">
          {game.status === 'checkmate'
            ? 'CHECKMATE'
            : game.status === 'resigned'
              ? `${COLOR_NAMES[opposite(game.winner!)]} RESIGNED`
              : 'THE FINAL POSITION'}
        </p>
        <h2>{endings[game.status]}</h2>
        <p className="ch-result-winner">
          {game.winner ? `${COLOR_NAMES[game.winner]} wins.` : 'Game drawn.'}
        </p>
        <p className="ch-dialog-copy">
          {game.winner ? 'A game well played. There’s always another possibility.' : drawReasons[game.status]}
        </p>
        <div className="ch-result-meta">
          <span>{game.history.length} moves</span>
          <i />
          <span>{onlineOpponent}</span>
        </div>
        {seat && (
          <button className="ch-primary" onClick={online.send.rematch} disabled={online.rematch.mine}>
            {online.rematch.mine
              ? 'Waiting for opponent…'
              : online.rematch.theirs
                ? 'Accept rematch'
                : 'Rematch'}
            <RotateCcw size={16} />
          </button>
        )}
        <button className="ch-result-menu" onClick={online.leave}>
          Leave room
        </button>
      </Modal>
    </div>
  )
}
