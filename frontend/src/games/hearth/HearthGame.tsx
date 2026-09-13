import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { PlayersOnlineBadge } from '../../online/playersOnline'
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  CircleHelp,
  Dices,
  Flag,
  House,
  Maximize2,
  Minus,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Settings2,
  Sparkles,
  Swords,
  Trophy,
  Users,
  Volume2,
  VolumeX,
} from 'lucide-react'
import { Link } from 'react-router'
import { estateGame, hearthGame } from '../catalog'
import { HOME, PALETTES } from '@games/shared/hearth/board'
import { createGame, gameReducer, motionDuration, phasePause, progressFor } from '@games/shared/hearth'
import { chooseAIMove } from '@games/shared/hearth/ai'
import { CLAIM_WIN_AFTER_MS } from '@games/shared/protocol'
import { createAudio } from './game/audio'
import type { GameConfig, GameState } from '@games/shared/hearth/types'
import BoardScene from './scene/BoardScene'
import type { BoardControls } from './scene/BoardScene'
import SetupPanel from './components/SetupPanel'
import RulesDialog from './components/RulesDialog'
import Modal from './components/Modal'
import Die from './components/Die'
import OnlinePanel from '../../online/OnlinePanel'
import { claimTarget } from './online/session'
import type { OnlineHearthSession } from './online/session'
import './HearthGame.css'

const DEFAULT_CONFIG: GameConfig = {
  playerCount: 4,
  mode: 'classic',
  controls: ['human', 'medium', 'easy', 'medium'],
}
function BrandMark() {
  return (
    <svg width="38" height="38" viewBox="0 0 40 40" fill="none" aria-hidden="true">
      <path d="M4 7a3 3 0 0 1 3-3h11v14H4V7Z" fill="#ce6655" />
      <path d="M22 4h11a3 3 0 0 1 3 3v11H22V4Z" fill="#d6b36b" />
      <path d="M4 22h14v14H7a3 3 0 0 1-3-3V22Z" fill="#668c75" />
      <path d="M22 22h14v11a3 3 0 0 1-3 3H22V22Z" fill="#7795af" />
      <path d="m20 11 9 9-9 9-9-9 9-9Z" fill="#f9f6ee" />
      <path d="m20 16 4 4-4 4-4-4 4-4Z" fill="#998361" />
    </svg>
  )
}

/**
 * The countdown before an away player's seat can be claimed, and the claim
 * itself. The server stamps `awaySince` and re-validates the claim, so drift
 * here only shifts what the banner says, never what the room allows.
 */
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
  const remaining = Math.max(0, CLAIM_WIN_AFTER_MS - (now - (awaySince ?? now)))
  const seconds = Math.ceil(remaining / 1000)
  return (
    <div className="hh-abandon" role="status">
      {remaining > 0 ? (
        <span>
          {name} stepped away — the table can play on without them in {Math.floor(seconds / 60)}:
          {String(seconds % 60).padStart(2, '0')}.
        </span>
      ) : (
        <>
          <span>{name} seems to be gone.</span>
          <button onClick={onClaim}>Play on without them</button>
        </>
      )}
    </div>
  )
}

export default function HearthGame({ online }: { online?: OnlineHearthSession }) {
  const [config, setConfig] = useState(DEFAULT_CONFIG)
  const [localState, dispatch] = useReducer(gameReducer, DEFAULT_CONFIG, createGame)
  // Online the room is the only source of truth: the reducer above never runs,
  // and the table is already under way by the time this component mounts.
  const state = online ? online.state : localState
  const [localStarted, setStarted] = useState(false),
    [session, setSession] = useState(0)
  const started = online ? true : localStarted
  const [dialog, setDialog] = useState<'rules' | 'new' | 'settings' | null>(null)
  const [muted, setMuted] = useState(true),
    [paused, setPaused] = useState(false),
    [winDismissed, setWinDismissed] = useState(false)
  const [elapsed, setElapsed] = useState(0),
    [gameMenu, setGameMenu] = useState(false)
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [audio] = useState(createAudio)
  const board = useRef<BoardControls>(null)
  const turnSchedule = useRef<{ state: GameState; reduced: boolean; remaining: number } | null>(null)
  const soundedState = useRef<GameState | null>(null)
  const player = state.players[state.currentPlayer]
  const human = player.control === 'human'
  /** Whose inputs this browser is allowed to make: its own seat online, the shared one locally. */
  const myTurn = online ? online.mySeat === player.id : human
  // Online every fresh game shows its own result — a rematch arrives as a new
  // state rather than through the local restart that would have cleared this.
  const [wasWon, setWasWon] = useState(state.phase === 'won')
  if (online && wasWon !== (state.phase === 'won')) {
    setWasWon(state.phase === 'won')
    if (state.phase !== 'won') setWinDismissed(false)
  }
  const active = started && !dialog && !paused
  const roll = useCallback(() => {
    if (active && state.phase === 'roll' && myTurn) {
      if (!muted) audio.unlock()
      if (online) online.send.roll()
      else dispatch({ type: 'ROLL_START' })
    }
  }, [active, state.phase, myTurn, muted, audio, online])
  const select = useCallback(
    (pieceId: string) => {
      if (!active || !myTurn) return
      if (online) online.send.move(pieceId)
      else dispatch({ type: 'MOVE', pieceId })
    },
    [active, myTurn, online],
  )

  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)')
    const listener = () => setReduced(media.matches)
    media.addEventListener('change', listener)
    return () => media.removeEventListener('change', listener)
  }, [])
  useEffect(() => {
    // Online every one of these beats is the server's to keep, so that the whole
    // table sees the same die at the same moment.
    if (online) return
    let callback: (() => void) | undefined,
      delay = 0
    if (state.phase === 'rolling') {
      callback = () => dispatch({ type: 'ROLL_RESULT', value: Math.floor(Math.random() * 6) + 1 })
      delay = phasePause('rolling', reduced)
    } else if (state.phase === 'moving') {
      callback = () => dispatch({ type: 'ANIMATION_DONE' })
      delay = motionDuration(state, reduced)
    } else if (state.phase === 'pass') {
      callback = () => dispatch({ type: 'NEXT_TURN' })
      delay = phasePause('pass', reduced)
    } else if (state.phase === 'roll' && !human) {
      callback = () => dispatch({ type: 'ROLL_START' })
      delay = phasePause('aiRoll', reduced)
    } else if (state.phase === 'choose' && (!human || state.legalMoves.length === 1)) {
      callback = () => {
        const move = human ? state.legalMoves[0] : chooseAIMove(state, player.control, Math.random())
        if (move) dispatch({ type: 'MOVE', pieceId: move.pieceId })
      }
      delay = phasePause('aiChoose', reduced)
    }
    if (!callback) {
      turnSchedule.current = null
      return
    }
    if (turnSchedule.current?.state !== state || turnSchedule.current.reduced !== reduced)
      turnSchedule.current = { state, reduced, remaining: delay }
    if (!active) return
    const schedule = turnSchedule.current,
      startedAt = performance.now()
    const timer = window.setTimeout(callback, schedule.remaining)
    return () => {
      window.clearTimeout(timer)
      schedule.remaining = Math.max(0, schedule.remaining - (performance.now() - startedAt))
    }
  }, [online, active, state, reduced, human, player.control])
  useEffect(() => () => audio.dispose(), [audio])
  useEffect(() => {
    if (muted || !active) return
    const timers: number[] = []
    const fresh = soundedState.current !== state
    soundedState.current = state
    if (fresh && state.phase === 'rolling') audio.play('roll')
    if (fresh && (state.phase === 'choose' || state.phase === 'pass')) audio.play('land')
    if (state.phase === 'moving' && state.motion) {
      const travel = reduced ? 60 : state.motion.steps.length * 165
      const offset =
        motionDuration(state, reduced) - (turnSchedule.current?.remaining ?? motionDuration(state, reduced))
      state.motion.steps.forEach((_, i) => {
        const at = reduced ? 0 : i * 165
        if ((!reduced || i === 0) && at >= offset)
          timers.push(window.setTimeout(() => audio.play('step'), at - offset))
      })
      if (travel >= offset)
        timers.push(
          window.setTimeout(
            () =>
              audio.play(
                state.motion!.captures.length ? 'capture' : state.motion!.to === HOME ? 'home' : 'land',
              ),
            travel - offset,
          ),
        )
    }
    if (fresh && state.phase === 'won') audio.play('win')
    return () => {
      timers.forEach(window.clearTimeout)
      audio.stop()
    }
  }, [state, muted, active, reduced, audio])
  useEffect(() => {
    if (!started || state.winner || paused) return
    const timer = window.setInterval(() => setElapsed((e) => e + 1), 1000)
    return () => window.clearInterval(timer)
  }, [started, state.winner, paused])
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (
        e.code === 'Space' &&
        !(e.target instanceof HTMLElement && e.target.closest('button,input,select,textarea,a'))
      ) {
        e.preventDefault()
        roll()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [roll])
  function start(next: GameConfig) {
    if (!muted) audio.unlock()
    setConfig(next)
    dispatch({ type: 'NEW_GAME', config: next })
    setSession((s) => s + 1)
    setStarted(true)
    setDialog(null)
    setPaused(false)
    setElapsed(0)
    setWinDismissed(false)
  }
  function preview(next: GameConfig) {
    setConfig(next)
    dispatch({ type: 'NEW_GAME', config: next })
  }
  function toggleSound() {
    if (muted) {
      audio.unlock()
      audio.play('step')
    } else audio.stop()
    setMuted(!muted)
  }
  const time = `${Math.floor(elapsed / 60)
    .toString()
    .padStart(2, '0')}:${(elapsed % 60).toString().padStart(2, '0')}`
  const status = !started
    ? 'A seat for everyone. A little friendly competition.'
    : paused
      ? 'Take your time. Your table is waiting.'
      : state.phase === 'roll'
        ? `Roll a little luck, ${player.name}.`
        : state.phase === 'rolling'
          ? 'A little luck is in the air…'
          : state.phase === 'choose'
            ? state.dice === 6
              ? 'A six! Leave the nest or keep your journey going.'
              : `Choose a glowing piece to move ${state.dice} spaces.`
            : state.phase === 'moving'
              ? state.events[0].message
              : state.phase === 'pass'
                ? state.events[0].message
                : `Every piece, right where it belongs. ${player.name} wins!`
  const actionLabel = paused
    ? 'Game paused'
    : state.phase === 'rolling'
      ? 'Rolling…'
      : state.phase === 'choose'
        ? 'Choose a piece'
        : state.phase === 'moving'
          ? 'On the way…'
          : state.phase === 'pass'
            ? 'Next player…'
            : state.phase === 'won'
              ? 'Home, sweet home'
              : myTurn
                ? 'Roll dice'
                : online
                  ? 'Waiting…'
                  : 'Thinking…'
  // The player the table is stuck on, while there is still something to ask for.
  const awayBlocking = online ? claimTarget(online) : null
  const EventIcon = {
    start: Flag,
    roll: Dices,
    enter: ArrowUpRight,
    move: ArrowRight,
    capture: Swords,
    home: House,
    skip: ArrowRight,
    win: Trophy,
  }
  return (
    <div className="hh-app">
      <header className="hh-header">
        <Link to={hearthGame.path} className="hh-brand" aria-label="Hearth and Home">
          <BrandMark />
          <span>
            hearth <em>&</em> home<small>GOOD TIMES, ALL AROUND.</small>
          </span>
        </Link>
        <nav className="hh-nav">
          <button className="active" onClick={() => board.current?.reset()}>
            The table
          </button>
          <button onClick={() => setDialog('rules')}>
            <BookOpen size={15} />
            How to play
          </button>
        </nav>
        <div className="hh-header-actions">
          <PlayersOnlineBadge game="hearth" className="hh-online-badge" />
          <span className="hh-local-badge">
            <span />
            {online ? 'Playing together, apart' : 'Made for good company'}
          </span>
          <button
            className="hh-icon-button"
            aria-label={muted ? 'Turn sound on' : 'Mute sound'}
            title={muted ? 'Turn sound on' : 'Mute sound'}
            onClick={toggleSound}
          >
            {muted ? <VolumeX size={19} /> : <Volume2 size={19} />}
          </button>
          <button className="hh-icon-button" aria-label="Game settings" onClick={() => setDialog('settings')}>
            <Settings2 size={19} />
          </button>
        </div>
      </header>

      <main className="hh-main">
        <Link to="/" className="game-collection-link">
          <ArrowLeft size={14} /> All games
        </Link>
        <div className="hh-page-heading">
          <div>
            <div className="hh-eyebrow">A LITTLE LUCK. A LONG WAY HOME.</div>
            <h1>
              Good times start here<span>.</span>
            </h1>
          </div>
          <div className="hh-table-meta">
            <span className="hh-online-dot" /> {online ? 'AN ONLINE TABLE' : 'YOUR PRIVATE TABLE'}{' '}
            <span className="hh-divider" /> <Users size={15} />
            {state.players.length} seats
          </div>
        </div>
        <div className="hh-game-layout">
          <section className="hh-board-section" aria-label="Game table">
            <div className="hh-board-top">
              <span className="hh-mode-badge">
                <span className="hh-tiny-star">✦</span>
                {state.mode === 'quick'
                  ? 'The quick game'
                  : state.mode === 'custom'
                    ? 'Your own rules'
                    : 'The classic game'}
                <span className="hh-mode-dot" />
                {state.rules.piecesPerPlayer} {state.rules.piecesPerPlayer === 1 ? 'piece' : 'pieces'} each
              </span>
              <span className="hh-turn-count">
                {started ? `TURN ${String(state.turn).padStart(2, '0')}` : 'MAKE YOURSELF AT HOME'}
              </span>
            </div>
            <BoardScene
              ref={board}
              running={!started || active}
              key={`${session}-${state.players.length}-${state.rules.piecesPerPlayer}`}
              state={state}
              onSelect={select}
            />
            <div className="hh-board-signature">
              <span>h & h</span>
              <small>THE ORIGINAL TABLE COLLECTION</small>
            </div>
            <div className="hh-camera-toolbar">
              <button aria-label="Zoom in" title="Zoom in" onClick={() => board.current?.zoom(1)}>
                <Plus size={17} />
              </button>
              <button aria-label="Zoom out" title="Zoom out" onClick={() => board.current?.zoom(-1)}>
                <Minus size={17} />
              </button>
              <span />
              <button aria-label="Top view" title="Top view" onClick={() => board.current?.top()}>
                <Maximize2 size={16} />
              </button>
              <button aria-label="Reset camera" title="Reset camera" onClick={() => board.current?.reset()}>
                <RotateCcw size={16} />
              </button>
            </div>
            <span className="hh-camera-hint">
              Drag to orbit <span>·</span> Scroll to zoom
            </span>
            {paused && (
              <div className="hh-pause-overlay">
                <Pause size={32} />
                <h2>A little breather.</h2>
                <button className="hh-primary" onClick={() => setPaused(false)}>
                  <Play size={16} />
                  Back to the table
                </button>
              </div>
            )}
            <div className="hh-board-status" role="status" aria-live="polite">
              <span className="hh-status-icon" style={{ color: started ? player.color : undefined }}>
                {state.phase === 'won' ? <Trophy size={17} /> : <Sparkles size={17} />}
              </span>
              {status}
            </div>
          </section>

          <aside className="hh-sidebar" aria-label="Game controls">
            {!started ? (
              <>
                <SetupPanel initialConfig={config} onStart={start} onPreview={preview} />
                {!online && <OnlinePanel game="hearth" basePath={hearthGame.path} seatChoices={[2, 3, 4]} />}
              </>
            ) : (
              <>
                <section
                  className="hh-turn-panel"
                  style={{ '--player-color': player.color } as React.CSSProperties}
                >
                  <div className="hh-turn-heading">
                    <div className="hh-eyebrow">
                      <span className="hh-live-dot" />
                      {state.phase === 'won'
                        ? 'A JOURNEY WELL PLAYED'
                        : myTurn
                          ? 'YOU’RE UP'
                          : online
                            ? 'THEIR TURN'
                            : 'COMPUTER’S TURN'}
                    </div>
                    <span className="hh-time">{time}</span>
                  </div>
                  <h2>{state.phase === 'won' ? `${player.name} wins!` : `${player.name}’s turn`}</h2>
                  <p className="hh-turn-subtitle">
                    {state.phase === 'choose'
                      ? `You rolled ${state.dice}. Make your move.`
                      : state.phase === 'pass'
                        ? 'No moves this time. Luck comes around.'
                        : state.phase === 'moving'
                          ? 'One step closer to home.'
                          : state.phase === 'won'
                            ? 'The whole family made it home.'
                            : state.lastDice === 6 && state.rules.extraTurnOnSix
                              ? 'A six means another chance. Roll again!'
                              : 'A new roll. A little possibility.'}
                  </p>
                  <Die value={state.dice || state.lastDice || 1} rolling={state.phase === 'rolling'} />
                  <button
                    className={`hh-primary hh-roll-button ${state.phase === 'roll' ? 'ready' : ''}`}
                    aria-label={actionLabel}
                    disabled={state.phase !== 'roll' || !myTurn || paused}
                    onClick={roll}
                  >
                    <Dices size={20} />
                    {actionLabel}
                    {state.phase === 'roll' && myTurn && <kbd>SPACE</kbd>}
                  </button>
                  {state.phase === 'choose' ? (
                    <div className="hh-piece-choices">
                      <p>
                        {/* Locally a lone move plays itself; online the seat still chooses it. */}
                        {state.legalMoves.length === 1 && !online
                          ? 'One possible move. On its way…'
                          : 'Pick a piece on the board or below.'}
                      </p>
                      <div>
                        {state.pieces
                          .filter((p) => p.playerId === player.id)
                          .map((p) => {
                            const legal = state.legalMoves.find((m) => m.pieceId === p.id)
                            return (
                              <button
                                key={p.id}
                                aria-label={`Move piece ${p.index + 1}`}
                                aria-describedby={`piece-description-${p.id}`}
                                disabled={!legal || !myTurn || paused}
                                onMouseEnter={() => board.current?.focus(p.id)}
                                onFocus={() => board.current?.focus(p.id)}
                                onClick={() => select(p.id)}
                                title={
                                  legal
                                    ? legal.to === HOME
                                      ? 'Reach home'
                                      : legal.captures.length
                                        ? 'Capture an opponent'
                                        : legal.from < 0
                                          ? 'Leave the nest'
                                          : `Move ${state.dice} spaces`
                                    : p.progress === HOME
                                      ? 'Already home'
                                      : p.progress < 0
                                        ? 'A 6 is needed to leave the nest'
                                        : 'An exact roll is needed to finish'
                                }
                              >
                                <span className="hh-piece-mini">
                                  <i />
                                </span>
                                <span>{p.index + 1}</span>
                                <span id={`piece-description-${p.id}`} className="sr-only">
                                  {p.progress < 0
                                    ? 'In the nest.'
                                    : p.progress === HOME
                                      ? 'Already home.'
                                      : p.progress >= 52
                                        ? `Home lane, ${HOME - p.progress} spaces to finish.`
                                        : `Track space ${p.progress + 1} of 52.`}
                                  {legal
                                    ? legal.to === HOME
                                      ? ' Reach home.'
                                      : legal.from < 0
                                        ? ' Enter the track.'
                                        : ` Move ${state.dice} spaces.${legal.captures.length ? ` Capture ${legal.captures.length} opposing pieces.` : ''}`
                                    : p.progress < 0
                                      ? ' Roll a six to enter.'
                                      : p.progress < HOME
                                        ? ' Needs an exact roll to finish.'
                                        : ''}
                                </span>
                                {legal?.to === HOME && <House size={11} />}
                              </button>
                            )
                          })}
                      </div>
                    </div>
                  ) : (
                    <p className="hh-roll-hint">
                      {state.phase === 'rolling' ? (
                        'Let the good times roll.'
                      ) : state.phase === 'moving' ? (
                        'Good things are on the move.'
                      ) : state.phase === 'pass' ? (
                        'The next turn will begin automatically.'
                      ) : state.phase === 'won' ? (
                        'All roads led home.'
                      ) : (
                        <>
                          Roll a <strong>6</strong> to leave your nest.
                        </>
                      )}
                    </p>
                  )}
                </section>
                <section className="hh-players-section">
                  <div className="hh-section-title">
                    <h3>Around the table</h3>
                    <span>{state.players.length} PLAYERS</span>
                  </div>
                  <div className="hh-player-list">
                    {state.players.map((p) => {
                      const progress = progressFor(state, p.id)
                      const seat = online?.players[p.id]
                      return (
                        <div
                          key={p.id}
                          data-testid={`player-${p.id}`}
                          className={`hh-player-card ${p.id === player.id ? 'current' : ''}`}
                          style={
                            {
                              '--player-color': p.color,
                              '--player-light': PALETTES[p.id].light,
                            } as React.CSSProperties
                          }
                        >
                          <span className="hh-player-avatar">
                            <span className="hh-piece-mini">
                              <i />
                            </span>
                          </span>
                          <div className="hh-player-info">
                            <strong>
                              {p.name}
                              {p.control !== 'human' && <span className="hh-ai-badge">AI</span>}
                              {online?.mySeat === p.id && <span className="hh-ai-badge">YOU</span>}
                              {seat?.connected === false && (
                                <span className="hh-ai-badge hh-away-badge">AWAY</span>
                              )}
                              {/* Away and claimed: the room is taking their turns for them. */}
                              {seat?.abandoned && <span className="hh-ai-badge">AI</span>}
                              {p.id === player.id && <span className="hh-current-dot" />}
                            </strong>
                            <small>
                              {progress.board} on board <span>·</span> {progress.nest} in nest
                            </small>
                          </div>
                          <div className="hh-player-progress">
                            <span>
                              <b>{progress.home}</b>
                              <small> / {state.rules.piecesPerPlayer}</small>
                              <House size={12} />
                            </span>
                            <div>
                              {Array.from({ length: state.rules.piecesPerPlayer }, (_, i) => (
                                <i key={i} className={i < progress.home ? 'filled' : ''} />
                              ))}
                            </div>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </section>
                <section className="hh-events">
                  <div className="hh-section-title">
                    <h3>The little moments</h3>
                    <span className="hh-live-label">LIVE</span>
                  </div>
                  <div className="hh-event-feed">
                    {state.events.slice(0, 4).map((event) => {
                      const Icon = EventIcon[event.kind]
                      return (
                        <div className="hh-event" key={event.id}>
                          <span style={{ color: PALETTES[event.playerId].color }}>
                            <Icon size={14} />
                          </span>
                          <p>{event.message}</p>
                          <small>{String(event.turn).padStart(2, '0')}</small>
                        </div>
                      )
                    })}
                  </div>
                </section>
              </>
            )}
          </aside>
        </div>
        <div className="hh-below-table">
          <div className="hh-legend">
            <span>
              <span className="hh-legend-star">★</span>{' '}
              {state.rules.safeSpaces ? 'A safe place' : 'Stars unprotected'}
            </span>
            <span>
              <i className="hh-legend-path" /> Your way home
            </span>
            <button onClick={() => setDialog('rules')}>
              <CircleHelp size={14} /> A little help
            </button>
          </div>
          {online ? (
            // The table belongs to the room: there is nothing here one player
            // could pause or restart on everyone else's behalf.
            <div className="hh-game-actions">
              <button onClick={online.leave}>
                <ArrowLeft size={14} />
                Leave room
              </button>
            </div>
          ) : started ? (
            <div className="hh-game-actions">
              <button onClick={() => setPaused(!paused)}>
                {paused ? <Play size={14} /> : <Pause size={14} />} {paused ? 'Resume' : 'Pause'}
              </button>
              <span />
              <button onClick={() => setDialog('new')}>
                <RotateCcw size={14} />
                New game
              </button>
            </div>
          ) : (
            <p>No downloads. Just good company.</p>
          )}
        </div>
      </main>
      <footer className="hh-footer">
        <span>Less scrolling. More rolling.</span>
        <span>
          DESIGNED TO BRING US TOGETHER <span className="hh-footer-star">✦</span>
        </span>
        <div className="hh-game-picker">
          <button onClick={() => setGameMenu(!gameMenu)}>
            The game collection <ChevronDown size={13} />
          </button>
          {gameMenu && (
            <div>
              <Link to={estateGame.path}>
                Estate <ArrowUpRight size={14} />
              </Link>
              <button onClick={() => setGameMenu(false)}>
                Hearth & Home <Check size={14} />
              </button>
            </div>
          )}
        </div>
      </footer>

      {dialog === 'rules' && <RulesDialog rules={state.rules} onClose={() => setDialog(null)} />}
      {dialog === 'new' && (
        <Modal title="Start a new game" onClose={() => setDialog(null)}>
          <SetupPanel initialConfig={config} onStart={start} />
        </Modal>
      )}
      {dialog === 'settings' && (
        <Modal title="Make yourself comfortable" onClose={() => setDialog(null)}>
          <div className="hh-eyebrow">YOUR TABLE</div>
          <h2>
            Make yourself
            <br />
            comfortable.
          </h2>
          <div className="hh-settings-list">
            <label>
              <span>
                <strong>Game sounds</strong>
                <small>A little click, a little clatter.</small>
              </span>
              <input type="checkbox" checked={!muted} onChange={toggleSound} />
            </label>
            <div>
              <span>
                <strong>Motion</strong>
                <small>
                  {reduced
                    ? 'Reduced motion follows your device setting.'
                    : 'Full animations. Follows your device setting.'}
                </small>
              </span>
              <Sparkles size={18} />
            </div>
            <div>
              <span>
                <strong>{online ? 'Online table' : 'Local multiplayer'}</strong>
                <small>{online ? 'Every seat has its own device.' : 'Players share this device.'}</small>
              </span>
              <Users size={18} />
            </div>
          </div>
          <button className="hh-primary" onClick={() => setDialog(null)}>
            Back to the table <ArrowRight size={17} />
          </button>
        </Modal>
      )}
      {awayBlocking && (
        <AbandonmentNotice
          name={awayBlocking.name}
          awaySince={awayBlocking.awaySince}
          onClaim={() => online?.send.claim()}
        />
      )}
      {state.winner && !winDismissed && !dialog && (
        <Modal title={`${player.name} wins!`} onClose={() => setWinDismissed(true)} className="hh-victory">
          <div className="hh-victory-icon" style={{ color: player.color }}>
            <Trophy size={43} />
            <span>✦</span>
            <span>✦</span>
          </div>
          <div className="hh-eyebrow">EVERY JOURNEY HAS A HAPPY ENDING</div>
          <h2>{player.name} wins!</h2>
          <p>
            {state.rules.piecesPerPlayer === 1 ? 'One piece.' : `All ${state.rules.piecesPerPlayer} pieces.`}{' '}
            One happy home.
          </p>
          <div className="hh-victory-stats">
            <div>
              <strong>{state.turn}</strong>
              <span>TURNS</span>
            </div>
            <div>
              <strong>{player.stats.captures}</strong>
              <span>CAPTURES</span>
            </div>
            <div>
              <strong>{time}</strong>
              <span>WELL SPENT</span>
            </div>
          </div>
          <div className="hh-final-players">
            {state.players.map((p) => (
              <div key={p.id}>
                <span style={{ color: p.color }}>●</span>
                <strong>{p.name}</strong>
                <span>
                  {progressFor(state, p.id).home}/{state.rules.piecesPerPlayer} home
                </span>
                <span>{p.stats.rolls} rolls</span>
                <span>{p.stats.captures} captures</span>
              </div>
            ))}
          </div>
          {online ? (
            <>
              <button className="hh-primary" onClick={online.send.rematch} disabled={online.rematch.mine}>
                {online.rematch.mine
                  ? 'Waiting for the table…'
                  : online.rematch.theirs
                    ? 'Accept rematch'
                    : 'Rematch'}
                <RotateCcw size={16} />
              </button>
              <button className="hh-text-button" onClick={online.leave}>
                Leave room
              </button>
            </>
          ) : (
            <>
              <button className="hh-primary" onClick={() => start(config)}>
                Play again <ArrowRight size={17} />
              </button>
              <button
                className="hh-text-button"
                onClick={() => {
                  setWinDismissed(true)
                  setDialog('new')
                }}
              >
                Change the company
              </button>
            </>
          )}
        </Modal>
      )}
    </div>
  )
}
