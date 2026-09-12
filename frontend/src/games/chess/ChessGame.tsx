import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router'
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Bot,
  Check,
  ChevronRight,
  Clock3,
  Flag,
  Handshake,
  Leaf,
  Maximize,
  Minus,
  Plus,
  RotateCcw,
  RotateCw,
  Settings2,
  ShieldCheck,
  Sparkles,
  SwitchCamera,
  Trophy,
  Undo2,
  Users,
  Volume2,
  VolumeX,
} from 'lucide-react'
import ChessBoard from './scene/ChessBoard'
import type { BoardControls } from './scene/ChessBoard'
import Modal from './components/Modal'
import PromotionGallery from './components/PromotionGallery'
import {
  agreeDraw,
  createGame,
  DEFAULT_OPTIONS,
  legalMoves,
  opposite,
  playMove,
  promote,
  resign,
  restoreGame,
  tickClock,
  undoMove,
} from './game/engine'
import { playChessSound } from './game/audio'
import { COLOR_NAMES, GLYPHS, PIECE_NAMES } from './game/types'
import type { Color, GameOptions, GameState, Preferences, PromotionPiece, Square } from './game/types'
import './ChessGame.css'

const STORAGE = 'gambit-game-v1',
  PREFS = 'gambit-preferences-v1'
type Dialog = 'settings' | 'help' | 'resign' | 'draw' | 'restart' | 'menu' | null
function storedGame() {
  try {
    return restoreGame(localStorage.getItem(STORAGE))
  } catch {
    return null
  }
}
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
  menu,
}: {
  color: Color
  game: GameState
  active: boolean
  menu: boolean
}) {
  const computer = game.options.mode === 'ai' && game.options.human !== color
  const captures = game.captured[color]
  return (
    <div className={`ch-player ${active && !menu ? 'ch-player-active' : ''}`}>
      <div className={`ch-player-avatar ch-avatar-${color}`} aria-hidden="true">
        {GLYPHS[color].k}
      </div>
      <div className="ch-player-details">
        <div>
          <strong>{COLOR_NAMES[color]}</strong>
          {computer && <span className="ch-small-tag">COMPUTER</span>}
          {!computer && game.options.mode === 'ai' && <span className="ch-small-tag">YOU</span>}
        </div>
        <span>
          {menu
            ? 'Ready to play'
            : game.status !== 'playing'
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
        {active && !menu && game.status === 'playing' && <i />}
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

export default function ChessGame() {
  const [boot] = useState(storedGame)
  const [game, setGame] = useState<GameState>(() => boot || createGame())
  const [menu, setMenu] = useState(!boot),
    [options, setOptions] = useState<GameOptions>(() => boot?.options || DEFAULT_OPTIONS)
  const [preferences, setPreferences] = useState(storedPreferences)
  const [dialog, setDialog] = useState<Dialog>(null),
    [selected, setSelected] = useState<Square | null>(null)
  const [black, setBlack] = useState(() => boot?.options.mode === 'ai' && boot.options.human === 'b')
  const [moving, setMoving] = useState(false),
    [resultDismissed, setResultDismissed] = useState(false),
    [notice, setNotice] = useState('')
  const board = useRef<BoardControls>(null),
    motionTimer = useRef<ReturnType<typeof setTimeout> | null>(null),
    historyEnd = useRef<HTMLDivElement>(null)
  const aiTurn =
    !menu && game.status === 'playing' && game.options.mode === 'ai' && game.turn !== game.options.human
  const enabled = !menu && game.status === 'playing' && !moving && !aiTurn && !game.promotion && !dialog
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
    if (menu || isOver || !game.options.clock) return
    const interval = setInterval(() => setGame((g) => tickClock(g)), 200)
    const catchUp = () => setGame((g) => tickClock(g))
    document.addEventListener('visibilitychange', catchUp)
    return () => {
      clearInterval(interval)
      document.removeEventListener('visibilitychange', catchUp)
    }
  }, [menu, isOver, game.options.clock])
  useEffect(() => {
    try {
      if (menu) localStorage.removeItem(STORAGE)
      else localStorage.setItem(STORAGE, JSON.stringify(game))
    } catch {
      /* Storage may be unavailable in private mode. */
    }
  }, [game, menu])
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

  const commit = useCallback(
    (next: GameState, previous: GameState) => {
      if (next === previous) return
      setGame(next)
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

  useEffect(() => {
    if (!aiTurn || moving || game.promotion) return
    let stopped = false,
      worker: Worker | undefined,
      watchdog: ReturnType<typeof setTimeout> | undefined
    const current = game
    const fallback = () => {
      if (stopped) return
      stopped = true
      worker?.terminate()
      const legal = legalMoves(current),
        move = legal.find((m) => m.captured) || legal[Math.floor(Math.random() * legal.length)]
      if (move) {
        commit(playMove(current, move.from, move.to, move.promotion as PromotionPiece | undefined), current)
        setNotice('The computer recovered and made a legal move.')
      }
    }
    const timer = setTimeout(() => {
      try {
        worker = new Worker(new URL('./game/ai.worker.ts', import.meta.url), { type: 'module' })
        worker.onmessage = (event) => {
          if (stopped) return
          if (event.data.error || !event.data.move) {
            fallback()
            return
          }
          const move = event.data.move
          const next = playMove(current, move.from, move.to, move.promotion)
          if (next === current) {
            fallback()
            return
          }
          stopped = true
          if (watchdog) clearTimeout(watchdog)
          worker?.terminate()
          commit(next, current)
        }
        worker.onerror = fallback
        worker.postMessage({
          fen: current.fen,
          difficulty: current.options.difficulty,
          initialFen: current.initialFen,
          moves: current.history.map((m) => ({ from: m.from, to: m.to, promotion: m.promotion })),
        })
        watchdog = setTimeout(fallback, 5000)
      } catch {
        fallback()
      }
    }, 350)
    return () => {
      stopped = true
      clearTimeout(timer)
      if (watchdog) clearTimeout(watchdog)
      worker?.terminate()
    }
    // A running search is tied to a position. Clock ticks do not invalidate it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    aiTurn,
    moving,
    game.fen,
    game.status,
    game.options.difficulty,
    game.promotion,
    game.history,
    game.initialFen,
    commit,
  ])

  function selectSquare(square: Square) {
    if (!enabled) return
    if (square === selected) {
      setSelected(null)
      return
    }
    if (selected && moves.some((m) => m.to === square)) {
      commit(playMove(game, selected, square), game)
      return
    }
    const piece = game.pieces.find((p) => p.square === square)
    if (piece?.color === game.turn) {
      setSelected(square)
      setNotice('')
    } else if (selected) setNotice('That square isn’t a legal move. Choose a marked destination.')
  }
  function start() {
    if (motionTimer.current) clearTimeout(motionTimer.current)
    const next = createGame(options)
    setGame(next)
    setMenu(false)
    setSelected(null)
    setMoving(false)
    setResultDismissed(false)
    setDialog(null)
    setNotice('')
    setBlack(options.mode === 'ai' && options.human === 'b')
  }
  function returnToMenu() {
    setOptions(game.options)
    setMenu(true)
    setSelected(null)
    setDialog(null)
    setGame(createGame(game.options))
    setResultDismissed(false)
    setMoving(false)
    if (motionTimer.current) clearTimeout(motionTimer.current)
  }
  function undo() {
    if (moving || game.options.mode !== 'local') return
    setGame(undoMove(game))
    setSelected(null)
    setResultDismissed(false)
    setNotice('Last move taken back.')
  }
  function restart() {
    setGame(createGame(game.options))
    setSelected(null)
    setDialog(null)
    setMoving(false)
    setResultDismissed(false)
    setNotice('')
    if (motionTimer.current) clearTimeout(motionTimer.current)
  }
  const turnStatus = menu
    ? 'The table is yours.'
    : isOver
      ? game.winner
        ? `${COLOR_NAMES[game.winner]} wins.`
        : 'Game drawn.'
      : game.check
        ? `${COLOR_NAMES[game.turn]} is in check.`
        : `${COLOR_NAMES[game.turn]}’s turn.`
  const statusDetail = menu
    ? 'A little focus. Endless possibilities.'
    : isOver
      ? 'A good game is always worth another.'
      : aiTurn
        ? 'The computer is considering its next move.'
        : moving
          ? 'Making a move…'
          : selected
            ? `${PIECE_NAMES[game.pieces.find((p) => p.square === selected)!.type]} on ${selected} · ${destinations.length} legal ${destinations.length === 1 ? 'move' : 'moves'}`
            : 'Select a piece to see its legal moves.'
  const pairs = Array.from({ length: Math.ceil(game.history.length / 2) }, (_, i) =>
    game.history.slice(i * 2, i * 2 + 2),
  )

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
              color={black ? 'w' : 'b'}
              game={
                menu
                  ? { ...game, options, clocks: { w: options.clock * 60000, b: options.clock * 60000 } }
                  : game
              }
              active={game.turn === (black ? 'w' : 'b')}
              menu={menu}
            />
            <div className="ch-table">
              <div className="ch-table-caption">
                <span>
                  <i /> {menu ? 'YOUR BOARD AWAITS' : isOver ? 'A GAME WELL PLAYED' : 'AT THE TABLE'}
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
              color={black ? 'b' : 'w'}
              game={
                menu
                  ? { ...game, options, clocks: { w: options.clock * 60000, b: options.clock * 60000 } }
                  : game
              }
              active={game.turn === (black ? 'b' : 'w')}
              menu={menu}
            />
            <div className="ch-board-footnote">
              <span>
                <RotateCw size={12} /> Drag to orbit <i /> Scroll or pinch to zoom
              </span>
              <span>Tab to board · Arrow keys & Enter</span>
            </div>
          </section>

          <aside className="ch-sidebar">
            {menu ? (
              <section className="ch-panel ch-setup">
                <p className="ch-eyebrow">GOOD GAMES START HERE</p>
                <h2>Pull up a chair.</h2>
                <p className="ch-panel-copy">
                  An old favorite. A fresh perspective.
                  <br />
                  Settle in and make it your game.
                </p>
                <label className="ch-field-label">YOUR OPPONENT</label>
                <div className="ch-mode-switch">
                  <button
                    className={options.mode === 'local' ? 'selected' : ''}
                    aria-pressed={options.mode === 'local'}
                    onClick={() => setOptions((o) => ({ ...o, mode: 'local' }))}
                  >
                    <Users size={18} />
                    <span>Play local</span>
                  </button>
                  <button
                    className={options.mode === 'ai' ? 'selected' : ''}
                    aria-pressed={options.mode === 'ai'}
                    onClick={() => setOptions((o) => ({ ...o, mode: 'ai' }))}
                  >
                    <Bot size={18} />
                    <span>Play vs AI</span>
                  </button>
                </div>
                <div className="ch-mode-description">
                  {options.mode === 'local' ? (
                    <>
                      <Users size={15} />
                      <p>
                        Two players. One board.
                        <br />
                        <span>A little friendly competition.</span>
                      </p>
                    </>
                  ) : (
                    <>
                      <Sparkles size={15} />
                      <p>
                        Your own worthy opponent.
                        <br />
                        <span>A fresh challenge, anytime.</span>
                      </p>
                    </>
                  )}
                </div>
                {options.mode === 'ai' && (
                  <>
                    <label className="ch-field-label">YOUR SIDE</label>
                    <div className="ch-side-choice">
                      {(['w', 'b'] as const).map((c) => (
                        <button
                          key={c}
                          aria-label={COLOR_NAMES[c]}
                          aria-pressed={options.human === c}
                          className={options.human === c ? 'selected' : ''}
                          onClick={() => setOptions((o) => ({ ...o, human: c }))}
                        >
                          <span>{GLYPHS[c].k}</span>
                          {COLOR_NAMES[c]}
                          {options.human === c && <Check size={14} />}
                        </button>
                      ))}
                    </div>
                    <label className="ch-field-label">THE CHALLENGE</label>
                    <div className="ch-difficulties">
                      {(['easy', 'medium', 'hard'] as const).map((d) => (
                        <button
                          key={d}
                          aria-label={d[0].toUpperCase() + d.slice(1)}
                          className={options.difficulty === d ? 'selected' : ''}
                          aria-pressed={options.difficulty === d}
                          onClick={() => setOptions((o) => ({ ...o, difficulty: d }))}
                        >
                          {d}
                        </button>
                      ))}
                    </div>
                  </>
                )}
                <div className="ch-clock-setup">
                  <Clock3 size={18} />
                  <Toggle
                    checked={options.clock === 10}
                    onChange={() => setOptions((o) => ({ ...o, clock: o.clock ? 0 : 10 }))}
                    label="Keep an eye on time"
                    description={options.clock ? '10 minutes per player' : 'No clock. Take your time.'}
                  />
                </div>
                <button className="ch-primary ch-start" onClick={start}>
                  Let’s play <ArrowRight size={18} />
                </button>
                <p className="ch-setup-note">
                  <ShieldCheck size={13} /> Standard rules. Extraordinary possibilities.
                </p>
              </section>
            ) : (
              <section className="ch-panel ch-session">
                <div className="ch-session-label">
                  <p className="ch-eyebrow">
                    {game.options.mode === 'ai' ? 'YOU & THE COMPUTER' : 'LOCAL MULTIPLAYER'}
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
                  <button
                    disabled={!game.history.length || moving || game.options.mode !== 'local'}
                    onClick={undo}
                    title={
                      game.options.mode === 'ai'
                        ? 'Undo is available in local games'
                        : 'Take back the last move'
                    }
                  >
                    <Undo2 size={16} />
                    Undo
                  </button>
                  <button disabled={isOver} onClick={() => setDialog('resign')}>
                    <Flag size={15} />
                    Resign
                  </button>
                  <button
                    disabled={isOver || game.options.mode !== 'local'}
                    onClick={() => setDialog('draw')}
                    title={
                      game.options.mode === 'ai'
                        ? 'Draw agreement is available in local games'
                        : 'Offer a draw'
                    }
                  >
                    <Handshake size={16} />
                    Draw
                  </button>
                </div>
                <button
                  className="ch-primary"
                  onClick={() => (game.history.length && !isOver ? setDialog('menu') : returnToMenu())}
                >
                  <Plus size={17} /> New game <ArrowUpRight size={17} />
                </button>
                <button className="ch-restart" onClick={() => setDialog('restart')}>
                  <RotateCcw size={13} /> Restart this game
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
            )}
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
              version, threefold repetition and the fifty-move rule are adjudicated automatically. Local
              players can also agree to a draw.
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
              Undo is available in local play and restores the position and clocks from before the last move.
            </p>
          </details>
          <button className="ch-primary" onClick={() => setDialog(null)}>
            Back to the board <ArrowRight size={16} />
          </button>
        </Modal>
      )}

      {dialog && ['resign', 'draw', 'restart', 'menu'].includes(dialog) && (
        <Modal
          title={
            dialog === 'resign'
              ? 'Confirm resignation'
              : dialog === 'draw'
                ? 'Offer a draw'
                : dialog === 'restart'
                  ? 'Restart game'
                  : 'New game'
          }
          onClose={() => setDialog(null)}
        >
          <div className="ch-confirm-icon">
            {dialog === 'resign' ? (
              <Flag size={26} />
            ) : dialog === 'draw' ? (
              <Handshake size={26} />
            ) : (
              <RotateCcw size={26} />
            )}
          </div>
          <h2>
            {dialog === 'resign'
              ? 'Ready to call it?'
              : dialog === 'draw'
                ? 'A draw, by agreement?'
                : dialog === 'restart'
                  ? 'A fresh start?'
                  : 'A new possibility?'}
          </h2>
          <p className="ch-dialog-copy">
            {dialog === 'resign'
              ? `${COLOR_NAMES[game.options.mode === 'ai' ? game.options.human : game.turn]} will resign and ${COLOR_NAMES[opposite(game.options.mode === 'ai' ? game.options.human : game.turn)]} will win.`
              : dialog === 'draw'
                ? `${COLOR_NAMES[opposite(game.turn)]}, do you accept the draw? Both players must agree.`
                : dialog === 'restart'
                  ? 'The current position and move history will be cleared. You’ll keep the same game settings.'
                  : 'Leave this game and choose a new opponent. Your current game will be cleared.'}
          </p>
          <div className="ch-dialog-actions">
            <button className="ch-secondary" onClick={() => setDialog(null)}>
              {dialog === 'draw' ? 'Decline' : 'Keep playing'}
            </button>
            <button
              className="ch-primary"
              onClick={() => {
                if (dialog === 'resign') {
                  // In an AI game the human resigns, including while the computer is thinking.
                  const next = resign(
                    game,
                    Date.now(),
                    game.options.mode === 'ai' ? game.options.human : game.turn,
                  )
                  commit(next, game)
                  setDialog(null)
                } else if (dialog === 'draw') {
                  commit(agreeDraw(game), game)
                  setDialog(null)
                } else if (dialog === 'restart') restart()
                else returnToMenu()
              }}
            >
              {dialog === 'resign'
                ? 'Resign game'
                : dialog === 'draw'
                  ? 'Accept draw'
                  : dialog === 'restart'
                    ? 'Restart game'
                    : 'New game'}
            </button>
          </div>
        </Modal>
      )}

      {!menu && game.promotion && !isOver && (
        <Modal title="Promote pawn" locked onClose={() => {}}>
          <p className="ch-eyebrow">A WELL-EARNED PROMOTION</p>
          <h2>A new possibility.</h2>
          <p className="ch-dialog-copy">
            Your pawn has reached the final rank.
            <br />
            Choose the piece it will become.
          </p>
          <PromotionGallery
            color={game.promotion.color}
            theme={preferences.theme}
            onChoose={(p) => commit(promote(game, p), game)}
          />
          {!!game.options.clock && <p className="ch-setup-note">Your clock is still running.</p>}
        </Modal>
      )}
      {!menu && isOver && !resultDismissed && !moving && !dialog && (
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
              {game.options.mode === 'local' ? 'A friendly match' : `${game.options.difficulty} opponent`}
            </span>
          </div>
          <button className="ch-primary" onClick={restart}>
            Play again <ArrowRight size={17} />
          </button>
          <button className="ch-result-menu" onClick={returnToMenu}>
            Return to menu
          </button>
        </Modal>
      )}
    </div>
  )
}
