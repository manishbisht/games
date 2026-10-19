import ThemeControl from '../../theme/ThemeControl'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { PlayersOnlineBadge } from '../../online/playersOnline'
import { HeaderAuth } from '../../online/identity'
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
import { createGame, progressFor } from '@games/shared/hearth'
import { CLAIM_WIN_AFTER_MS } from '@games/shared/protocol'
import { feelCue, playCue, soundCheck } from './game/audio'
import type { GameConfig, GameState, Player } from '@games/shared/hearth/types'
import BoardScene from './scene/BoardScene'
import type { BoardControls } from './scene/BoardScene'
import type { Cue } from './scene/createScene'
import { useCountUp, useHeld } from '../../motion/hooks'
import { useMotionPreference } from '../../motion/preference'
import type { MotionPreference } from '../../motion/preference'
import { useBotRoom } from '../../online/useBotRoom'
import SetupPanel from './components/SetupPanel'
import RulesDialog from './components/RulesDialog'
import Modal from './components/Modal'
import Die from './components/Die'
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

const clock = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
}

/**
 * The table's clock, counted from when the room dealt it, so it neither
 * restarts on a reconnect nor carries over into a rematch — and ticking in its
 * own component, so a second passing re-renders four characters, not the table.
 */
function GameClock({ startedAt, endedAt }: { startedAt?: number; endedAt?: number }) {
  const [opened] = useState(() => Date.now()),
    [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (endedAt) return
    const ticker = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(ticker)
  }, [endedAt])
  return <span className="hh-time">{clock((endedAt ?? now) - (startedAt ?? opened))}</span>
}

/**
 * Who is at the table, with one marker that slides from the last player's card
 * to the next one's instead of blinking between them.
 */
function PlayerList({
  children,
  current,
  color,
}: {
  children: React.ReactNode
  current: number
  color: string
}) {
  const list = useRef<HTMLDivElement>(null),
    [marker, setMarker] = useState<{ top: number; height: number } | null>(null)
  useLayoutEffect(() => {
    const card = list.current?.children[current + 1] as HTMLElement | undefined
    if (card) setMarker({ top: card.offsetTop, height: card.offsetHeight })
  }, [current])
  return (
    <div className="hh-player-list" ref={list}>
      <span
        className="hh-turn-marker"
        aria-hidden="true"
        style={
          {
            '--marker-color': color,
            translate: marker ? `0 ${marker.top + marker.height / 2 - 11}px` : undefined,
            opacity: marker ? 1 : 0,
          } as React.CSSProperties
        }
      />
      {children}
    </div>
  )
}

/** The result, after the board has had its moment: the trophy pops and the numbers count up. */
function Victory({
  state,
  winner,
  online,
  onClose,
}: {
  state: GameState
  winner: Player
  online?: OnlineHearthSession
  onClose: () => void
}) {
  const turns = useCountUp(state.turn),
    captures = useCountUp(winner.stats.captures)
  return (
    <Modal title={`${winner.name} wins!`} onClose={onClose} className="hh-victory">
      <div className="hh-victory-icon" style={{ color: winner.color }}>
        <Trophy size={43} />
        <span>✦</span>
        <span>✦</span>
      </div>
      <div className="hh-eyebrow">EVERY JOURNEY HAS A HAPPY ENDING</div>
      <h2>{winner.name} wins!</h2>
      <p>
        {state.rules.piecesPerPlayer === 1 ? 'One piece.' : `All ${state.rules.piecesPerPlayer} pieces.`} One
        happy home.
      </p>
      <div className="hh-victory-stats">
        <div>
          <strong>{turns}</strong>
          <span>TURNS</span>
        </div>
        <div>
          <strong>{captures}</strong>
          <span>CAPTURES</span>
        </div>
        <div>
          <strong>{state.startedAt && state.endedAt ? clock(state.endedAt - state.startedAt) : '—'}</strong>
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
      ) : null}
    </Modal>
  )
}

const MOTION_LABELS: Record<MotionPreference, string> = {
  system: 'Follows your device setting.',
  full: 'Every hop, bounce and flourish.',
  reduced: 'Short, gentle moves. No confetti.',
}

export default function HearthGame({ online }: { online?: OnlineHearthSession }) {
  const [config, setConfig] = useState(DEFAULT_CONFIG)
  // The board behind the setup panel. It is never played: choosing a table
  // creates a room, and the room deals the real one.
  const preview = useMemo(() => createGame(config), [config])
  // The room is the only source of a live table — there is no local game left
  // to be the other half of this.
  const dealt = online ? online.state : preview
  const started = Boolean(online)
  // What the board is showing. It trails the room while a die lands or a piece
  // walks, so the sidebar says what happened as it happens on the table.
  const [shown, setShown] = useState<GameState | null>(null)
  const state =
    shown && shown.startedAt === dealt.startedAt && shown.pieces.length === dealt.pieces.length
      ? shown
      : dealt
  const [dialog, setDialog] = useState<'rules' | 'settings' | null>(null)
  const [muted, setMuted] = useState(true),
    [winDismissed, setWinDismissed] = useState(false),
    [gameMenu, setGameMenu] = useState(false)
  const [motion, setMotion] = useMotionPreference()
  const board = useRef<BoardControls>(null)
  const sound = useRef(!muted)
  useEffect(() => {
    sound.current = !muted
  }, [muted])
  const player = state.players[state.currentPlayer]
  /** Whose inputs this browser is allowed to make: only ever its own seat. */
  const myTurn = Boolean(online) && online!.mySeat === player.id
  // Online every fresh game shows its own result — a rematch arrives as a new
  // state rather than through the local restart that would have cleared this.
  const [wasWon, setWasWon] = useState(state.phase === 'won')
  if (online && wasWon !== (state.phase === 'won')) {
    setWasWon(state.phase === 'won')
    if (state.phase !== 'won') setWinDismissed(false)
  }
  // The result waits for the confetti it would otherwise cover.
  const showVictory = useHeld(Boolean(state.winner) && !winDismissed && !dialog, 1500)
  const active = started && !dialog
  const roll = useCallback(() => {
    if (active && state.phase === 'roll' && myTurn) {
      // The die starts rattling now; the room's answer decides where it lands.
      board.current?.roll()
      online?.send.roll()
    }
  }, [active, state.phase, myTurn, online])
  const select = useCallback(
    (pieceId: string) => {
      if (!active || !myTurn) return
      online?.send.move(pieceId)
    },
    [active, myTurn, online],
  )
  /**
   * Sounds follow the board's own animation, so each plays once, when it
   * happens. The few that are felt follow the site's haptics setting rather
   * than this table's sound switch.
   */
  const onCue = useCallback((cue: Cue) => {
    feelCue(cue)
    if (sound.current) playCue(cue)
  }, [])

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
  const room = useBotRoom('hearth', hearthGame.path)
  function start(next: GameConfig) {
    setConfig(next)
    const count = Math.max(2, Math.min(4, next.playerCount ?? 4))
    void room.start({
      seats: count,
      // Seat 0 is yours; the controls the panel collected describe the rest.
      bots: Array.from({ length: count - 1 }, (_, i) => next.controls?.[i + 1] ?? 'medium'),
      options: { mode: next.mode ?? 'classic', rules: next.rules },
    })
  }
  function onPreview(next: GameConfig) {
    setConfig(next)
  }
  function toggleSound() {
    if (muted) soundCheck()
    setMuted(!muted)
  }
  const status = !started
    ? 'A seat for everyone. A little friendly competition.'
    : state.phase === 'roll'
      ? `Roll a little luck, ${player.name}.`
      : state.phase === 'rolling'
        ? 'A little luck is in the air…'
        : state.phase === 'choose'
          ? !myTurn
            ? `${player.name} rolled ${state.dice === 6 ? 'a six' : state.dice} and is choosing a piece.`
            : state.dice === 6
              ? 'A six! Leave the nest or keep your journey going.'
              : `Choose a glowing piece to move ${state.dice} spaces.`
          : state.phase === 'moving'
            ? state.events[0].message
            : state.phase === 'pass'
              ? state.events[0].message
              : `Every piece, right where it belongs. ${player.name} wins!`
  const actionLabel =
    state.phase === 'rolling'
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
          <ThemeControl />
          <HeaderAuth readOnly={Boolean(online)} />
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
              key={`${dealt.players.length}-${dealt.rules.piecesPerPlayer}`}
              state={dealt}
              seat={online?.mySeat ?? null}
              live={started}
              elapsed={online?.elapsed}
              onSelect={select}
              onPresent={setShown}
              onCue={onCue}
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
            <div className="hh-board-status" role="status" aria-live="polite">
              <span
                className="hh-status-icon"
                key={`${state.currentPlayer}-${state.phase}`}
                style={{ color: started ? player.color : undefined }}
              >
                {state.phase === 'won' ? <Trophy size={17} /> : <Sparkles size={17} />}
              </span>
              {status}
            </div>
          </section>

          <aside className="hh-sidebar" aria-label="Game controls">
            {!started ? (
              <>
                <SetupPanel
                  initialConfig={config}
                  onStart={start}
                  onPreview={onPreview}
                  disabled={room.disabled}
                />
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
                    <GameClock key={state.startedAt} startedAt={state.startedAt} endedAt={state.endedAt} />
                  </div>
                  <h2 key={`${player.id}-${state.phase === 'won'}`} className="hh-turn-title">
                    {state.phase === 'won' ? `${player.name} wins!` : `${player.name}’s turn`}
                  </h2>
                  <p className="hh-turn-subtitle">
                    {state.phase === 'choose'
                      ? myTurn
                        ? `You rolled ${state.dice}. Make your move.`
                        : `${player.name} rolled ${state.dice}.`
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
                  <Die
                    value={state.dice || state.lastDice || 1}
                    rolling={state.phase === 'rolling'}
                    throws={state.players.reduce((sum, p) => sum + p.stats.rolls, 0)}
                  />
                  <button
                    className={`hh-primary hh-roll-button ${state.phase === 'roll' && myTurn ? 'ready' : ''}`}
                    aria-label={actionLabel}
                    disabled={state.phase !== 'roll' || !myTurn}
                    onClick={roll}
                  >
                    <Dices size={20} />
                    {actionLabel}
                    {state.phase === 'roll' && myTurn && <kbd>SPACE</kbd>}
                  </button>
                  {state.phase === 'choose' ? (
                    <div className="hh-piece-choices">
                      <p>{myTurn ? 'Pick a piece on the board or below.' : `${player.name} is choosing…`}</p>
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
                                disabled={!legal || !myTurn}
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
                      ) : myTurn ? (
                        <>
                          Roll a <strong>6</strong> to leave your nest.
                        </>
                      ) : (
                        `${player.name} is about to roll.`
                      )}
                    </p>
                  )}
                </section>
                <section className="hh-players-section">
                  <div className="hh-section-title">
                    <h3>Around the table</h3>
                    <span>{state.players.length} PLAYERS</span>
                  </div>
                  <PlayerList current={state.currentPlayer} color={player.color}>
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
                              {(p.control !== 'human' || seat?.bot) && (
                                <span className="hh-ai-badge">AI</span>
                              )}
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
                  </PlayerList>
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
            <label>
              <span>
                <strong>Motion</strong>
                <small>{MOTION_LABELS[motion]}</small>
              </span>
              <select
                className="hh-motion-select"
                value={motion}
                onChange={(e) => setMotion(e.target.value as MotionPreference)}
              >
                <option value="system">System</option>
                <option value="full">Full</option>
                <option value="reduced">Reduced</option>
              </select>
            </label>
            <div>
              <span>
                <strong>{online ? 'Online table' : 'You and the bots'}</strong>
                <small>
                  {online
                    ? 'Every seat has its own device.'
                    : 'You play while the bots take their own turns.'}
                </small>
              </span>
              <Users size={18} />
            </div>
          </div>
          <button className="hh-primary" data-close>
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
      {showVictory && state.winner && (
        <Victory state={state} winner={player} online={online} onClose={() => setWinDismissed(true)} />
      )}
    </div>
  )
}
