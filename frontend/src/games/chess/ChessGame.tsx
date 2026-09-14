import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import { PlayersOnlineBadge } from '../../online/playersOnline'
import {
  ArrowLeft,
  ArrowUpRight,
  Plus,
  RotateCcw,
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  Clock3,
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
import Modal from './components/Modal'
import PromotionGallery from './components/PromotionGallery'
import {
  legalMoves,
  opposite,
  promote,
} from '@games/shared/chess'
import { playChessSound } from './game/audio'
import { COLOR_NAMES, GLYPHS, PIECE_NAMES } from '@games/shared/chess/types'
import { CLAIM_WIN_AFTER_MS } from '@games/shared/protocol'
import type {
  Color,
  GameState,
  Preferences,
  Square,
} from '@games/shared/chess/types'
import type { OnlineChessSession } from './online/session'
import './ChessGame.css'

// Preferences only. The game itself lives in its room, which is what makes a
// chess table resumable from its link rather than from this browser.
const PREFS = 'gambit-preferences-v1'
type Dialog = 'settings' | 'help' | 'resign' | null
function storedPreferences(): Preferences {
  const defaults: Preferences = {
    sound: true,
    reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    highContrast: false,
    theme: 'walnut',
  }
  try {
    const data = JSON.parse(localStorage.getItem(PREFS) || '{}')
    return {
      sound: typeof data.sound === 'boolean' ? data.sound : defaults.sound,
      reducedMotion: defaults.reducedMotion || data.reducedMotion === true,
      highContrast: data.highContrast === true,
      theme: data.theme === 'marble' ? 'marble' : 'walnut',
    }
  } catch {
    return defaults
  }
}
const clockText = (time: number) =>
  `${Math.floor(Math.ceil(time / 1000) / 60)
    .toString()
    .padStart(2, '0')}:${(Math.ceil(time / 1000) % 60).toString().padStart(2, '0')}`
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
  label,
  away,
  you,
}: {
  color: Color
  game: GameState
  active: boolean
  label?: string
  away?: boolean
  you?: boolean
}) {
  const computer = game.options.mode === 'ai' && game.options.human !== color
  const captures = game.captured[color]
  return (
    <div className={`ch-player ${active ? 'ch-player-active' : ''}`}>
      <div className={`ch-player-avatar ch-avatar-${color}`} aria-hidden="true">
        {GLYPHS[color].k}
      </div>
      <div className="ch-player-details">
        <div>
          <strong>{label ?? COLOR_NAMES[color]}</strong>
          {computer && <span className="ch-small-tag">COMPUTER</span>}
          {((!computer && game.options.mode === 'ai') || you) && <span className="ch-small-tag">YOU</span>}
          {away && <span className="ch-small-tag ch-tag-away">AWAY</span>}
        </div>
        <span>
          {game.status !== 'playing'
            ? 'Game finished'
            : active
                ? computer
                  ? 'Considering the position…'
                  : 'Your move'
                : 'Watching the board'}
        </span>
      </div>
      {captures.length > 0 && (
        <div
          className="ch-captured"
          aria-label={`${COLOR_NAMES[color]} captured: ${captures.map((p) => PIECE_NAMES[p]).join(', ')}`}
        >
          {captures.map((p, i) => (
            <span key={i} aria-hidden="true">
              {GLYPHS[opposite(color)][p]}
            </span>
          ))}
        </div>
      )}
      <div
        className={`ch-clock ${game.options.clock && game.clocks[color] < 60000 ? 'ch-clock-low' : ''}`}
        aria-label={`${COLOR_NAMES[color]} clock${game.options.clock ? `: ${clockText(game.clocks[color])}` : ': no time limit'}`}
      >
        {active && game.status === 'playing' && <i />}
        {game.options.clock ? clockText(game.clocks[color]) : <span className="ch-untimed">— : —</span>}
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
  const game = online.state
  const [preferences, setPreferences] = useState(storedPreferences)
  const [dialog, setDialog] = useState<Dialog>(null),
    [selected, setSelected] = useState<Square | null>(null)
  const [onlinePromotion, setOnlinePromotion] = useState<{
    from: Square
    to: Square
    color: Color
  } | null>(null)
  const promotion = onlinePromotion
  const [black, setBlack] = useState(() => online.myColor === 'b')
  const [moving, setMoving] = useState(false),
    [resultDismissed, setResultDismissed] = useState(false),
    [notice, setNotice] = useState('')
  const board = useRef<BoardControls>(null),
    motionTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    historyEnd = useRef<HTMLDivElement>(null)
  // Online, the seat orients the board; each fresh game starts clean and shows its own result.
  const [seat, setSeat] = useState(online.myColor),
    [seatStatus, setSeatStatus] = useState(game.status)
  if (seat !== online.myColor) {
    setSeat(online.myColor)
    setBlack(online.myColor === 'b')
  }
  if (seatStatus !== game.status) {
    setSeatStatus(game.status)
    setOnlinePromotion(null)
    setSelected(null)
    setNotice('')
    if (game.status === 'playing') setResultDismissed(false)
  }
  const enabled =
    game.status === 'playing' &&
    !moving &&
    !promotion &&
    !dialog &&
    online.myColor !== null &&
    game.turn === online.myColor
  const moves = useMemo(() => (selected ? legalMoves(game, selected) : []), [game, selected])
  const destinations = useMemo(
    () => Array.from(new Map(moves.map((m) => [m.to, { to: m.to, capture: !!m.captured }])).values()),
    [moves],
  )
  const sceneState = useMemo(
    () => ({ game, selected, legal: destinations, focused: null, enabled, preferences }),
    [game, selected, destinations, enabled, preferences],
  )
  const isOver = game.status !== 'playing'

  useEffect(() => {
    try {
      localStorage.setItem(PREFS, JSON.stringify(preferences))
    } catch {
      /* Preferences remain available for this visit. */
    }
  }, [preferences])
  useEffect(
    () => () => {
      if (motionTimer.current) clearTimeout(motionTimer.current)
    },
    [],
  )
  useEffect(() => {
    historyEnd.current?.scrollIntoView({
      block: 'nearest',
      behavior: preferences.reducedMotion ? 'instant' : 'smooth',
    })
  }, [game.history.length, preferences.reducedMotion])

  /** React to a snapshot that moved the game on: sound, and the board's own animation. */
  const commit = useCallback(
    (next: GameState, previous: GameState) => {
      if (next === previous) return
      setSelected(null)
      setNotice('')
      setResultDismissed(false)
      if (next.history.length > previous.history.length) {
        if (preferences.sound)
          playChessSound(
            next.status !== 'playing'
              ? 'end'
              : next.check
                ? 'check'
                : next.history.at(-1)?.captured
                  ? 'capture'
                  : 'move',
          )
        if (motionTimer.current) clearTimeout(motionTimer.current)
        setMoving(true)
        motionTimer.current = setTimeout(() => setMoving(false), preferences.reducedMotion ? 30 : 560)
      }
    },
    [preferences.sound, preferences.reducedMotion],
  )

  function selectSquare(square: Square) {
    if (!enabled) return
    if (square === selected) {
      setSelected(null)
      return
    }
    if (selected && moves.some((m) => m.to === square)) {
      // The board waits for the authoritative snapshot instead of moving optimistically.
      if (moves.some((m) => m.to === square && m.promotion))
        setOnlinePromotion({ from: selected, to: square, color: game.turn })
      else online.send.move(selected, square)
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
  /** The seat resigns, which is the only seat this browser may resign. */
  const resigningColor = online.myColor ?? game.turn
  // The result meta credits whoever is across the board, falling back to the
  // plain word if we never saw their name.
  const onlineOpponent =
    (online.myColor ? online.players[opposite(online.myColor)]?.name : undefined) || 'opponent'
  const onlineAway =
    online.myColor && game.status === 'playing' ? online.players[opposite(online.myColor)] : undefined
  const turnStatus = isOver
      ? game.winner
        ? `${COLOR_NAMES[game.winner]} wins.`
        : 'Game drawn.'
      : game.check
        ? `${COLOR_NAMES[game.turn]} is in check.`
        : `${COLOR_NAMES[game.turn]}’s turn.`
  const statusDetail = isOver
    ? 'A good game is always worth another.'
    : moving
          ? 'Making a move…'
          : selected
            ? `${PIECE_NAMES[game.pieces.find((p) => p.square === selected)!.type]} on ${selected} · ${destinations.length} legal ${destinations.length === 1 ? 'move' : 'moves'}`
            : 'Select a piece to see its legal moves.'
  const pairs = Array.from({ length: Math.ceil(game.history.length / 2) }, (_, i) =>
    game.history.slice(i * 2, i * 2 + 2),
  )
  const far: Color = black ? 'w' : 'b',
    near: Color = black ? 'b' : 'w'
  const seatProps = (color: Color) => ({
    label: online?.players[color]?.name,
    away: online?.players[color]?.connected === false,
    you: online?.myColor === color,
  })

  return (
    <div
      className={`ch-app ${preferences.highContrast ? 'ch-contrast' : ''} ${preferences.reducedMotion ? 'ch-reduced' : ''}`}
    >
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
            <PlayerCard
              color={far}
              game={game}
              active={game.turn === far}
              {...seatProps(far)}
            />
            <div className="ch-table">
              <div className="ch-table-caption">
                <span>
                  <i /> {isOver ? 'A GAME WELL PLAYED' : 'AT THE TABLE'}
                </span>
                <span>{preferences.theme === 'walnut' ? 'WALNUT & IVORY' : 'THE MARBLE EDITION'}</span>
              </div>
              <ChessBoard ref={board} state={sceneState} black={black} onSelect={selectSquare} />
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
            <PlayerCard
              color={near}
              game={game}
              active={game.turn === near}
              {...seatProps(near)}
            />
            <div className="ch-board-footnote">
              <span>
                <RotateCw size={12} /> Drag to orbit <i /> Scroll or pinch to zoom
              </span>
              <span>Tab to board · Arrow keys & Enter</span>
            </div>
          </section>

          <aside className="ch-sidebar">
            <section className="ch-panel ch-session">
              <div className="ch-session-label">
                <p className="ch-eyebrow">
                  {online
                    ? 'ONLINE MATCH'
                    : game.options.mode === 'ai'
                      ? 'YOU & THE COMPUTER'
                      : 'LOCAL MULTIPLAYER'}
                </p>
                <span className={`ch-live-dot ${isOver ? 'ended' : ''}`} />
              </div>
              <h2 className={game.check && !isOver ? 'ch-check-text' : ''}>{turnStatus}</h2>
              <p className="ch-panel-copy" aria-live="polite">
                {statusDetail}
              </p>
              <div className="ch-session-tags">
                <span>
                  {game.options.clock ? (
                    <>
                      <Clock3 size={12} /> Rapid · 10 min
                    </>
                  ) : (
                    <>
                      <Leaf size={12} /> No time limit
                    </>
                  )}
                </span>
                <span>{game.options.mode === 'ai' ? `${game.options.difficulty} AI` : 'Two players'}</span>
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
                          <span key={side}>{pair[side]?.san || '—'}</span>
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
                <button disabled={isOver} onClick={() => setDialog('resign')}>
                  <Flag size={15} />
                  Resign
                </button>
              </div>
              <button className="ch-primary" onClick={online.leave}>
                <ArrowLeft size={17} /> Leave room
              </button>
              {notice && (
                <p className="ch-notice" role="status">
                  {notice}
                </p>
              )}
              {isOver && resultDismissed && (
                <button className="ch-show-result" onClick={() => setResultDismissed(false)}>
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

      {dialog === 'settings' && (
        <Modal title="Settings" onClose={() => setDialog(null)}>
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
                <small>
                  {theme === 'walnut' ? 'Warm. Familiar. Timeless.' : 'Quiet. Crisp. Considered.'}
                </small>
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
            description="Instant moves and camera changes."
            checked={preferences.reducedMotion}
            onChange={() => setPreferences((p) => ({ ...p, reducedMotion: !p.reducedMotion }))}
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
      )}

      {dialog === 'help' && (
        <Modal title="How to play" onClose={() => setDialog(null)}>
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
              <strong>Castling:</strong> Select the king, then move it two squares toward a rook. Neither
              piece may have moved, the path must be empty, and the king cannot be in, pass through, or land
              in check.
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
              <strong>Draws:</strong> Stalemate and insufficient material end the game. In this casual
              version, threefold repetition and the fifty-move rule are adjudicated automatically.
            </p>
          </details>
          <details>
            <summary>Board controls & accessibility</summary>
            <p>
              Click or tap your piece, then a marked destination. Dots are quiet moves; rings mark captures.
              The last move remains shaded. A checked king has a red ring and its attackers are outlined.
            </p>
            <p>
              Drag to orbit, scroll or pinch to zoom, and use Flip board for the opposite perspective. With
              the board focused, use arrow keys to explore, Enter or Space to select or move, and Escape to
              deselect. The starting keyboard square is e2.
            </p>
            <p>
              Clocks keep running while you choose a promotion, open a dialog, switch tabs, or close the page.
              Reopen your room link to reconnect to the same game.
            </p>
          </details>
          <button className="ch-primary" onClick={() => setDialog(null)}>
            Back to the board <ArrowRight size={16} />
          </button>
        </Modal>
      )}

      {dialog === 'resign' && (
        <Modal title="Confirm resignation" onClose={() => setDialog(null)}>
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
      )}

      {promotion && !isOver && (
        <Modal title="Promote pawn" locked onClose={() => {}}>
          <p className="ch-eyebrow">A WELL-EARNED PROMOTION</p>
          <h2>A new possibility.</h2>
          <p className="ch-dialog-copy">
            Your pawn has reached the final rank.
            <br />
            Choose the piece it will become.
          </p>
          <PromotionGallery
            color={promotion.color}
            theme={preferences.theme}
            onChoose={(p) => {
              if (online) {
                // The local engine never runs an online game, even if this modal's gating loosens.
                if (onlinePromotion) {
                  online.send.move(onlinePromotion.from, onlinePromotion.to, p)
                  setOnlinePromotion(null)
                }
                return
              }
              commit(promote(game, p), game)
            }}
          />
          {!!game.options.clock && <p className="ch-setup-note">Your clock is still running.</p>}
        </Modal>
      )}
      {onlineAway && !onlineAway.connected && (
        <AbandonmentNotice
          name={onlineAway.name}
          awaySince={onlineAway.awaySince}
          onClaim={() => online?.send.claimWin()}
        />
      )}
      {isOver && !resultDismissed && !moving && !dialog && (
        <Modal title="Game result" onClose={() => setResultDismissed(true)}>
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
            {game.winner
              ? 'A game well played. There’s always another possibility.'
              : drawReasons[game.status]}
          </p>
          <div className="ch-result-meta">
            <span>{game.history.length} moves</span>
            <i />
            <span>
              {online
                ? onlineOpponent
                : game.options.mode === 'local'
                  ? 'A friendly match'
                  : `${game.options.difficulty} opponent`}
            </span>
          </div>
          {online ? (
            <>
              <button className="ch-primary" onClick={online.send.rematch} disabled={online.rematch.mine}>
                {online.rematch.mine
                  ? 'Waiting for opponent…'
                  : online.rematch.theirs
                    ? 'Accept rematch'
                    : 'Rematch'}
                <RotateCcw size={16} />
              </button>
              <button className="ch-result-menu" onClick={online.leave}>
                Leave room
              </button>
            </>
          ) : null}
        </Modal>
      )}
    </div>
  )
}
