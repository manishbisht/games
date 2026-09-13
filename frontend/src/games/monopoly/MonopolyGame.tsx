import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowDownUp,
  ArrowRight,
  AudioLines,
  BadgeCheck,
  Building2,
  ChevronRight,
  CircleHelp,
  Clock3,
  Dice5,
  Expand,
  Flag,
  Home,
  Landmark,
  Maximize,
  Minus,
  MousePointer2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trophy,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import { Link } from 'react-router'
import { estateGame } from '../catalog'
import { BOARD, money } from '@games/shared/estate/board'
import {
  botAcceptsTrade,
  botAction,
  createGame,
  debtCapacity,
  gameReducer,
  netWorth,
  ownedSpaces,
} from '@games/shared/estate'
import { CLAIM_WIN_AFTER_MS } from '@games/shared/protocol'
import { loadGame, saveGame } from './game/storage'
import { playSound, unlockAudio } from './game/audio'
import type { GameState, PlayerConfig } from '@games/shared/estate/types'
import OnlinePanel from '../../online/OnlinePanel'
import { cardKeyOf, claimTarget, onlineDispatch, tradeKeyOf } from './online/session'
import type { OnlineEstateSession } from './online/session'
import BoardScene from './scene/BoardScene'
import type { BoardControls } from './scene/BoardScene'
import TokenIcon from './components/TokenIcon'
import Dialog from './components/Dialog'
import SetupDialog from './components/SetupDialog'
import { PortfolioDialog, PropertyDetail, PropertySummary, TradeButton } from './components/PropertyDialogs'
import TradeDialog from './components/TradeDialog'
import './MonopolyGame.css'

type Modal = 'setup' | 'rules' | 'settings' | 'portfolio' | 'trade' | null
const pipPositions = [[], [4], [0, 8], [0, 4, 8], [0, 2, 6, 8], [0, 2, 4, 6, 8], [0, 2, 3, 5, 6, 8]]
function MiniDie({ value }: { value: number }) {
  return (
    <span className="mini-die" aria-label={`Die: ${value}`}>
      {Array.from({ length: 9 }, (_, i) => (
        <i className={pipPositions[value].includes(i) ? 'pip' : ''} key={i} />
      ))}
    </span>
  )
}
const rules = [
  {
    icon: Dice5,
    title: 'Roll & roam',
    text: 'Roll two dice, move around the board, and follow the space you land on. Doubles earn another roll; three consecutive doubles send you to jail.',
  },
  {
    icon: Building2,
    title: 'Make yourself at home',
    text: 'Buy unowned properties or pass to leave them available. Collect rent when opponents visit. Passing GO pays $200. Stations and utilities earn more when owned together.',
  },
  {
    icon: Home,
    title: 'Think bigger',
    text: 'Complete a color group to double base rent. Build evenly across the group, up to four houses and then a hotel. Open your portfolio to build, sell, or mortgage.',
  },
  {
    icon: ArrowDownUp,
    title: 'Find the right deal',
    text: 'Offer cash and properties to another player. Both players confirm before anything changes hands. Sell all buildings in a group before trading its properties.',
  },
  {
    icon: Landmark,
    title: 'Keep your options open',
    text: 'Jail costs $50 to leave, or try rolling doubles for up to three turns. Sell buildings for half price and mortgage properties to cover debts. Unmortgaging costs 55% of the original price.',
  },
  {
    icon: Trophy,
    title: 'Own the moment',
    text: 'If you cannot pay after selling and mortgaging, you go bankrupt. Remaining assets pass to your creditor. The last financially active player wins.',
  },
]

/**
 * The table as it looks to a seat that is only watching this turn.
 * `PropertyDetail` offers its Buy, Pass, Build, Sell and Mortgage controls to
 * whoever holds `state.current` — locally the person at the keyboard, online
 * somebody else — and gates every one of them on that player not being a
 * computer. That flag is the only thing a call site can say to a dialog which
 * takes no viewer, and it says exactly the right thing: these controls are not
 * this browser's to offer. What is left is the read-only half — the deed, the
 * rent table, who owns it — which is what an onlooker should get.
 */
const watched = (state: GameState): GameState => ({
  ...state,
  players: state.players.map((p, index) => (index === state.current ? { ...p, isBot: true } : p)),
})

/** Where a seat's player is, in the line the local game uses to say what they are. */
function presence(online: OnlineEstateSession, id: number): string {
  const seat = online.players[id]
  if (!seat) return 'Empty seat'
  if (seat.abandoned) return 'Played by the table'
  return seat.connected ? 'At the table' : 'Away'
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
    <div className="abandon-notice" role="status">
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

function MonopolyGame({ online }: { online?: OnlineEstateSession }) {
  // Online the room is the only source of truth: the reducer below never runs,
  // this device's saved game is neither read nor written, and the table is
  // already under way by the time this component mounts.
  const [localState, localDispatch] = useReducer(gameReducer, online, (session) =>
    session ? createGame() : loadGame(),
  )
  const state = online ? online.state : localState
  // The dialogs take a `dispatch` and know nothing about rooms. Online it is the
  // wire: everything a person may decide goes down it, and the beats the room
  // paces for itself are dropped rather than sent (see `./online/session`).
  const dispatch = useMemo(() => (online ? onlineDispatch(online) : localDispatch), [online, localDispatch])
  const [modal, setModal] = useState<Modal>(() => (state.trade ? 'trade' : null)),
    [selected, setSelected] = useState<number | null>(null)
  const [portfolioPlayer, setPortfolioPlayer] = useState<number | undefined>(),
    [muted, setMuted] = useState(false)
  const [fast, setFast] = useState(false),
    [paused, setPaused] = useState(false),
    [winnerDismissed, setWinnerDismissed] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const board = useRef<BoardControls>(null),
    gameArea = useRef<HTMLDivElement>(null)
  const player = state.players[state.current],
    isSetup = state.status === 'setup',
    isFinished = state.status === 'finished'
  const busy = state.phase === 'rolling' || state.phase === 'moving'
  /** Whose inputs this browser may make: its own seat online, the shared one locally. */
  const humanTurn = !player.isBot && !isSetup && !isFinished && (!online || online.mySeat === state.current)
  const lastEvent = state.events[0],
    pauseGame = paused || modal !== null || selected !== null
  const canTrade =
    humanTurn && ['ready', 'end'].includes(state.phase) && state.players.filter((p) => !p.bankrupt).length > 1
  /** The seat the table is stuck on, if its player has gone and can be claimed. */
  const awayBlocking = online ? claimTarget(online) : null
  /** Looking at an offer of your own: the one review with a button you may not press. */
  const reviewingOwnOffer = Boolean(online && state.trade && online.mySeat === state.trade.from)
  /** An offer you are party to is always reachable again, however you dismissed it. */
  const myOffer = Boolean(
    online && state.trade && (online.mySeat === state.trade.from || online.mySeat === state.trade.to),
  )
  // Online every fresh game shows its own result — a rematch arrives as a new
  // state rather than through the local restart that would have cleared this.
  const [wasFinished, setWasFinished] = useState(isFinished)
  if (online && wasFinished !== isFinished) {
    setWasFinished(isFinished)
    if (!isFinished) setWinnerDismissed(false)
  }
  /**
   * An offer crosses the table, so online it has to open its own review: the
   * seat it was made to has no dialog open and no turn coming. Keyed rather than
   * watched by identity — see `tradeKeyOf` — so an unrelated broadcast cannot
   * shut an offer that is still being composed.
   */
  const tradeKey = online ? tradeKeyOf(state) : ''
  const [tradeShown, setTradeShown] = useState(tradeKey)
  /**
   * The same trick for the card, to the opposite end: a viewer who did not draw
   * it may put it down, and it stays down until the next one turns up.
   */
  const cardKey = cardKeyOf(state)
  const [cardDismissed, setCardDismissed] = useState('')
  if (online && tradeShown !== tradeKey) {
    setTradeShown(tradeKey)
    const parties = tradeKey ? tradeKey.split('-').map(Number) : []
    // Mine to answer: open it. Settled, or somebody else's business: close it.
    if (online.mySeat !== null && parties.includes(online.mySeat)) setModal('trade')
    else setModal((open) => (open === 'trade' ? null : open))
  }
  useEffect(() => {
    // The room holds this device's game; nothing about it belongs on this disk.
    if (online) return
    saveGame(state)
  }, [state, online])
  useEffect(() => {
    // Online every one of these beats is the server's to keep, so that the whole
    // table sees the same dice at the same moment — and the computer opponents
    // this schedules for are a local game's, never a room's.
    if (online) return
    if (pauseGame || state.status !== 'playing' || state.trade) return
    let action = botAction(state),
      delay = fast ? 420 : 1100
    if (state.phase === 'rolling') {
      action = { type: 'DICE_SETTLED' }
      delay = 1200
    } else if (state.phase === 'moving') {
      action = { type: state.stepsRemaining > 0 ? 'MOVE_STEP' : 'RESOLVE' }
      delay = state.stepsRemaining > 0 ? 215 : 330
    } else if (state.phase === 'card') delay = fast ? 1300 : 3300
    if (!action) return
    const timer = window.setTimeout(() => dispatch(action), delay)
    return () => window.clearTimeout(timer)
  }, [state, fast, pauseGame, online, dispatch])
  useEffect(() => {
    // An online offer is answered by the person it was made to, or by the room
    // on their behalf once their seat has been claimed. Never by this browser.
    if (online) return
    if (!state.trade || !state.players[state.trade.to].isBot) return
    const timer = window.setTimeout(() => {
      dispatch({ type: botAcceptsTrade(state, state.trade!) ? 'ACCEPT_TRADE' : 'REJECT_TRADE' })
      setModal(null)
    }, 1800)
    return () => clearTimeout(timer)
  }, [state, online, dispatch])
  useEffect(() => {
    if (!muted && lastEvent && ['purchase', 'money'].includes(lastEvent.type))
      playSound(lastEvent.type as 'purchase' | 'money')
  }, [lastEvent, muted])
  useEffect(() => {
    if (!muted && state.phase === 'rolling') playSound('roll')
  }, [state.phase, muted])
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(null), 3500)
    return () => clearTimeout(timer)
  }, [toast])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        modal ||
        selected !== null ||
        ['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes((e.target as HTMLElement)?.tagName)
      )
        return
      if (e.code === 'Space') {
        e.preventDefault()
        unlockAudio()
        if (isSetup) setModal('setup')
        else if (humanTurn && !paused && state.phase === 'ready') dispatch({ type: 'ROLL' })
        else if (humanTurn && !paused && state.phase === 'end') dispatch({ type: 'END_TURN' })
      }
      if (e.key.toLowerCase() === 'r') board.current?.reset()
      if (e.key.toLowerCase() === 'm') {
        setPortfolioPlayer(state.current)
        setModal('portfolio')
      }
      if (e.key === '?') setModal('rules')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [modal, selected, isSetup, humanTurn, paused, state, dispatch])
  function startGame(players: PlayerConfig[], mode: GameState['mode']) {
    unlockAudio()
    dispatch({ type: 'START', players, mode })
    setModal(null)
    setSelected(null)
    setPaused(false)
    setWinnerDismissed(false)
    board.current?.reset()
  }
  // Locally the player on turn is the person at the keyboard; online it is
  // whoever's turn it happens to be, and your own properties are still yours.
  function openPortfolio(id = online?.mySeat ?? state.current) {
    setPortfolioPlayer(id)
    setModal('portfolio')
  }
  function primaryAction() {
    unlockAudio()
    if (isSetup || isFinished) {
      // Online there is nothing to set up: the next game is the room's to deal,
      // once everyone still at the table has asked for one.
      if (online) online.send.rematch()
      else setModal('setup')
      return
    }
    if (paused) {
      setPaused(false)
      return
    }
    if (!humanTurn) return
    if (state.phase === 'ready') dispatch({ type: 'ROLL' })
    if (state.phase === 'end') {
      dispatch({ type: 'END_TURN' })
      if (state.extraRoll) dispatch({ type: 'ROLL' })
    }
    if (state.phase === 'purchase') dispatch({ type: 'BUY' })
  }
  /**
   * Dismissing the trade dialog. Locally, closing a review *is* declining it —
   * the dialog is the only place that deal lives. Online it is not: the offer
   * lives in the room, and both of the dialog's own buttons already send their
   * own message before calling this, so rejecting here too would put a second
   * message on the wire behind every answer. Online, dismissing is local.
   */
  function closeTrade() {
    if (state.trade && !online) dispatch({ type: 'REJECT_TRADE' })
    setModal(null)
  }
  async function fullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen()
      else if (gameArea.current?.requestFullscreen) await gameArea.current.requestFullscreen()
      else setToast('Fullscreen is not available here. Use + to zoom the board.')
    } catch {
      setToast('Use the camera controls to find your perfect view.')
    }
  }
  const actionText = isSetup
    ? 'Start game'
    : isFinished
      ? 'Play again'
      : paused
        ? 'Resume game'
        : busy
          ? state.phase === 'rolling'
            ? 'Rolling the dice…'
            : 'On the move…'
          : // The other seat's decisions are theirs to make, and to be seen making.
            player.isBot || (online && !humanTurn)
            ? `${player.name} is playing…`
            : state.phase === 'purchase'
              ? `Buy for ${money(BOARD[player.position].price || 0)}`
              : state.phase === 'end'
                ? state.extraRoll
                  ? 'Roll again'
                  : 'End turn'
                : state.phase === 'debt'
                  ? 'Resolve payment'
                  : state.phase === 'card'
                    ? 'Your card awaits'
                    : 'Roll dice'
  const actionDisabled =
    !isSetup &&
    !isFinished &&
    !paused &&
    (busy ||
      player.isBot ||
      Boolean(online && !humanTurn) ||
      ['card', 'debt'].includes(state.phase) ||
      (state.phase === 'purchase' && player.cash < (BOARD[player.position].price || 0)))
  const actionTitle = isSetup
    ? 'Your next great game starts here.'
    : isFinished
      ? `${state.players[state.winner!].name} takes the city.`
      : paused
        ? 'A little intermission.'
        : state.phase === 'purchase'
          ? BOARD[player.position].name
          : state.phase === 'rolling'
            ? 'A little luck goes a long way.'
            : state.phase === 'moving'
              ? `${player.name} is making moves.`
              : state.phase === 'end'
                ? state.extraRoll
                  ? 'Double the dice. Double the fun.'
                  : 'A good move. What’s next?'
                : player.jailed
                  ? `${player.name} is in jail.`
                  : `${player.name === 'You' ? 'Your' : `${player.name}’s`} turn to make a move.`
  const actionDescription = isSetup
    ? 'Gather your people. Build your fortune.'
    : state.phase === 'purchase'
      ? 'An opportunity to call a little more of the city your own.'
      : player.jailed
        ? 'Roll doubles to leave, or pay the $50 release fee.'
        : state.phase === 'end'
          ? state.extraRoll
            ? 'You rolled doubles. Take another turn.'
            : 'Manage your properties or pass the dice.'
          : state.phase === 'moving'
            ? `${state.stepsRemaining} spaces to go. Let’s see where you land.`
            : 'Roll the dice and see where the city takes you.'
  return (
    <div className="app-shell">
      <header className="site-header">
        <Link
          className="wordmark"
          to={estateGame.path}
          onClick={() => board.current?.reset()}
          aria-label="Estate home"
        >
          <span className="brand-mark">
            <i />
            <i />
            <i />
            <i />
          </span>
          estate<span className="wordmark-period">.</span>
        </Link>
        <div className="header-divider" />
        <span className="brand-description">The classic. A new dimension.</span>
        <div className="header-right">
          <span className="local-label">
            <i /> {online ? 'ONLINE TABLE' : 'LOCAL MULTIPLAYER'}
          </span>
          <button className="header-help" onClick={() => setModal('rules')}>
            <CircleHelp size={17} />
            <span>How to play</span>
          </button>
          <span className="header-divider" />
          <button
            className="icon-button"
            aria-label={muted ? 'Turn sound on' : 'Mute sound'}
            onClick={() => {
              unlockAudio()
              setMuted((v) => !v)
            }}
          >
            {muted ? <VolumeX size={19} /> : <Volume2 size={19} />}
          </button>
          <button className="icon-button" aria-label="Game settings" onClick={() => setModal('settings')}>
            <Settings2 size={19} />
          </button>
        </div>
      </header>
      <main className="main-content">
        <Link to="/" className="game-collection-link">
          <ArrowLeft size={14} /> All games
        </Link>
        <div className="game-heading">
          <div>
            <div className="eyebrow">
              <span className="tiny-line" /> A LITTLE LUCK. A LOT OF STRATEGY.
            </div>
            <h1>
              Let the good times roll<span>.</span>
            </h1>
          </div>
          <div className="game-meta">
            <span className="mode-badge">
              <span className="mode-icon">
                <Flag size={14} />
              </span>
              {state.mode === 'classic' ? 'Classic game' : 'Quick game'}
            </span>
            <span className="round-badge">
              <Clock3 size={15} /> Round <strong>{String(state.turn).padStart(2, '0')}</strong>
            </span>
          </div>
        </div>
        <div className="game-layout">
          <section className="game-stage" ref={gameArea} aria-label="Game board and turn controls">
            <div className="board-viewport">
              <div className="board-topline">
                <div className="board-label">
                  <span className="live-dot" />
                  <span>
                    {isSetup
                      ? 'YOUR CITY AWAITS'
                      : isFinished
                        ? 'A CITY WELL PLAYED'
                        : paused
                          ? 'GAME PAUSED'
                          : 'THE CITY IS YOURS'}
                  </span>
                </div>
                <button
                  className="board-expand icon-button"
                  aria-label="Toggle fullscreen board"
                  onClick={() => void fullscreen()}
                >
                  <Expand size={17} />
                </button>
              </div>
              <BoardScene ref={board} state={state} selected={selected} onSelect={setSelected} />
              {state.rollId > 0 && state.phase !== 'rolling' && (
                <div className="dice-result" key={state.rollId}>
                  <MiniDie value={state.dice[0]} />
                  <MiniDie value={state.dice[1]} />
                  <span>
                    <strong>{state.dice[0] + state.dice[1]}</strong>{' '}
                    {state.dice[0] === state.dice[1] ? 'DOUBLES' : 'TOTAL'}
                  </span>
                </div>
              )}
              {lastEvent?.text.includes('+$200') && (
                <div className="go-reward" key={lastEvent.id}>
                  +$200 <span>Looking good. You passed GO.</span>
                </div>
              )}
              <div className="board-bottomline">
                <span className="camera-hint">
                  <MousePointer2 size={13} /> Drag to rotate <span>·</span> Scroll to zoom
                </span>
                <div className="camera-controls">
                  <button aria-label="Zoom out" title="Zoom out" onClick={() => board.current?.zoom(-1)}>
                    <Minus size={16} />
                  </button>
                  <button aria-label="Zoom in" title="Zoom in" onClick={() => board.current?.zoom(1)}>
                    <Plus size={16} />
                  </button>
                  <i />
                  <button
                    aria-label="Top down view"
                    title="Top down view"
                    onClick={() => board.current?.topView()}
                  >
                    <Maximize size={15} />
                  </button>
                  <button
                    aria-label="Reset camera"
                    title="Reset camera (R)"
                    onClick={() => board.current?.reset()}
                  >
                    <RotateCcw size={15} />
                  </button>
                </div>
              </div>
              {paused && (
                <div className="pause-overlay">
                  <button onClick={() => setPaused(false)}>
                    <Play size={24} fill="currentColor" /> Back to the table
                  </button>
                </div>
              )}
            </div>
            {awayBlocking && (
              <AbandonmentNotice
                name={awayBlocking.name}
                awaySince={awayBlocking.awaySince}
                onClaim={() => online?.send.claim()}
              />
            )}
            <div className="action-dock">
              <div className="turn-avatar" style={{ '--player-color': player.color } as React.CSSProperties}>
                <TokenIcon token={player.token} color={player.color} size={45} />
                <span />
              </div>
              <div className="turn-copy">
                <span className="turn-eyebrow">
                  {isSetup
                    ? 'GOOD COMPANY. GREAT COMPETITION.'
                    : isFinished
                      ? 'THE WINNING MOVE'
                      : `${player.name === 'You' ? 'IT’S YOUR TURN' : `${player.name.toUpperCase()}’S TURN`}${player.isBot ? ' · COMPUTER' : ''}`}
                </span>
                <h2>{actionTitle}</h2>
                <p>{actionDescription}</p>
              </div>
              <div className="turn-actions">
                {humanTurn && state.phase === 'purchase' && (
                  <button className="pass-button" onClick={() => dispatch({ type: 'PASS' })}>
                    Pass
                  </button>
                )}
                {humanTurn && player.jailed && state.phase === 'ready' && (
                  <button
                    className="pass-button"
                    disabled={player.cash < 50}
                    onClick={() => dispatch({ type: 'PAY_JAIL' })}
                  >
                    Pay $50
                  </button>
                )}
                <button
                  className={`primary-button roll-button ${busy ? 'is-rolling' : ''}`}
                  disabled={actionDisabled}
                  onClick={primaryAction}
                >
                  {isSetup ? (
                    <Play size={18} />
                  ) : isFinished ? (
                    <RotateCcw size={18} />
                  ) : state.phase === 'purchase' ? (
                    <Plus size={19} />
                  ) : state.phase === 'end' ? (
                    <ArrowRight size={19} />
                  ) : (
                    <Dice5 size={21} />
                  )}
                  {actionText}
                  {/* The shortcut is only worth mentioning to whoever it works for. */}
                  {(isSetup || state.phase === 'ready') && !player.isBot && (!online || humanTurn) && (
                    <kbd>SPACE</kbd>
                  )}
                </button>
              </div>
            </div>
          </section>
          <aside className="sidebar">
            <div className="players-panel">
              <div className="panel-heading">
                <h2>
                  At the table<span>.</span>
                </h2>
                <span>{state.players.filter((p) => !p.bankrupt).length} players</span>
              </div>
              <div className="player-list">
                {state.players.map((p) => {
                  const owned = ownedSpaces(state, p.id),
                    active = p.id === state.current && !isFinished
                  return (
                    <button
                      className={`player-card ${active ? 'active' : ''} ${p.bankrupt ? 'bankrupt' : ''}`}
                      key={p.id}
                      style={{ '--player-color': p.color } as React.CSSProperties}
                      onClick={() => openPortfolio(p.id)}
                      aria-label={`${p.name}, ${money(p.cash)}, ${owned.length} properties. View portfolio.`}
                    >
                      <div className="player-card-main">
                        <div className="player-token">
                          <TokenIcon token={p.token} color={p.color} size={42} />
                        </div>
                        <div className="player-identity">
                          <strong>
                            {p.name}
                            {(online ? online.mySeat === p.id : p.name === 'You') && (
                              <span className="you-label">YOU</span>
                            )}
                          </strong>
                          <span>
                            {p.bankrupt
                              ? 'Out of the game'
                              : p.jailed
                                ? 'In jail'
                                : online
                                  ? presence(online, p.id)
                                  : p.isBot
                                    ? 'Computer'
                                    : 'Local player'}
                          </span>
                        </div>
                        <div className="player-money">
                          <strong>{money(p.cash)}</strong>
                          <span>
                            <Building2 size={11} /> {owned.length}{' '}
                            {owned.length === 1 ? 'property' : 'properties'}
                          </span>
                        </div>
                      </div>
                      {active && (
                        <div className="player-turn-label">
                          <i />
                          {isSetup ? 'READY TO MAKE A MOVE' : busy ? 'MAKING MOVES' : 'CURRENT TURN'}
                          <span>
                            <ChevronRight size={12} />
                          </span>
                        </div>
                      )}
                      {owned.length > 0 && (
                        <div className="ownership-strips">
                          {owned.map((b) => (
                            <i
                              key={b.id}
                              style={{ background: state.properties[b.id].mortgaged ? '#56616b' : b.color }}
                            />
                          ))}
                        </div>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="activity-panel">
              <div className="panel-heading">
                <h2>The latest</h2>
                <span className="activity-live">
                  <i /> LIVE
                </span>
              </div>
              <div className="activity-feed">
                {state.events.length ? (
                  state.events.slice(0, 18).map((event, i) => (
                    <div className={`activity-event ${i === 0 ? 'latest' : ''}`} key={event.id}>
                      <span className={`event-symbol ${event.type}`}>
                        {event.type === 'roll' ? (
                          <Dice5 size={13} />
                        ) : event.type === 'purchase' ? (
                          <Home size={13} />
                        ) : event.type === 'money' ? (
                          <Landmark size={13} />
                        ) : event.type === 'alert' ? (
                          <Flag size={13} />
                        ) : (
                          <span className="event-dot" />
                        )}
                      </span>
                      <p>{event.text}</p>
                      {i === 0 && <span className="now-label">now</span>}
                    </div>
                  ))
                ) : (
                  <>
                    <div className="activity-event latest">
                      <span className="event-symbol purchase">
                        <Sparkles size={14} />
                      </span>
                      <p>Welcome to the neighborhood.</p>
                      <span className="now-label">now</span>
                    </div>
                    <div className="activity-event">
                      <span className="event-symbol">
                        <span className="event-dot" />
                      </span>
                      <p>Your next great rivalry starts here. Set up a game to get rolling.</p>
                    </div>
                    <div className="activity-empty">
                      <span />
                      <span />
                      <span />
                    </div>
                  </>
                )}
              </div>
              <div className="activity-footer">
                <ShieldCheck size={13} />
                <span>
                  {online
                    ? 'The room keeps this game. Close the tab and come back to it.'
                    : isSetup
                      ? 'A fresh start for everyone.'
                      : 'Your game is saved automatically.'}
                </span>
              </div>
            </div>
          </aside>
        </div>
        <div className="table-toolbar">
          <div className="utility-actions">
            {/* "My properties" means mine. PropertySummary counts the deeds of
                `state.current`, which locally is the person at the keyboard. */}
            <PropertySummary
              state={online?.mySeat != null ? { ...state, current: online.mySeat } : state}
              onClick={() => openPortfolio()}
            />
            <span className="toolbar-separator" />
            {/* Online a dismissed review has to be reachable again: the offer is
                still on the table and the game is frozen until it is answered. */}
            <TradeButton disabled={!canTrade && !myOffer} onClick={() => setModal('trade')} />
            <span className="toolbar-separator" />
            <button
              className="utility-action"
              // A table with other people at it does not stop because one of
              // them would like it to — and a pause would only gate their own
              // inputs while the room played on without them.
              disabled={Boolean(online) || isSetup || isFinished || state.trade !== null}
              onClick={() => setPaused((v) => !v)}
            >
              {paused ? <Play size={16} /> : <Pause size={16} />}
              <span>{paused ? 'Resume' : 'Pause game'}</span>
            </button>
          </div>
          <span className="table-tip">
            <span className="tip-star">✧</span> Big dreams. Small houses. Endless possibilities.
          </span>
        </div>
      </main>
      <footer className="site-footer">
        <span>Made for a little friendly competition.</span>
        <span>
          <i /> ALL PLAY. NO REAL MONEY.
        </span>
      </footer>
      <div className="sr-only" role="status" aria-live="polite">
        {lastEvent?.text}
      </div>
      {toast && (
        <div className="toast" role="status">
          <BadgeCheck size={18} />
          {toast}
          <button aria-label="Dismiss notification" onClick={() => setToast(null)}>
            <X size={16} />
          </button>
        </div>
      )}
      {modal === 'setup' && (
        <SetupDialog onClose={() => setModal(null)} onStart={startGame} inProgress={!isSetup}>
          {!online && <OnlinePanel game="estate" basePath={estateGame.path} seatChoices={[2, 3, 4]} />}
        </SetupDialog>
      )}
      {modal === 'portfolio' && (
        <PortfolioDialog
          state={state}
          initialPlayer={portfolioPlayer}
          onClose={() => setModal(null)}
          onSelect={(id) => {
            setModal(null)
            setSelected(id)
          }}
        />
      )}
      {modal === 'trade' &&
        (reviewingOwnOffer ? (
          // TradeDialog shows one Accept/Decline block to whoever opens it, and
          // the seat that *made* an offer cannot accept it — the room refuses,
          // and the seam drops the click before it gets there. The dialog is
          // shared with the local game and takes no viewer, so the only thing a
          // call site can do about a button it must not offer is not render it.
          // Decline stays: for the seat that made the offer, it withdraws it.
          <div className="trade-as-proposer">
            <TradeDialog state={state} dispatch={dispatch} onClose={closeTrade} />
          </div>
        ) : (
          <TradeDialog state={state} dispatch={dispatch} onClose={closeTrade} />
        ))}
      {selected !== null && (
        <PropertyDetail
          id={selected}
          state={online && !humanTurn ? watched(state) : state}
          dispatch={dispatch}
          onClose={() => setSelected(null)}
        />
      )}
      {modal === 'rules' && (
        <Dialog
          title="A little luck. A winning plan."
          eyebrow="WELCOME TO THE NEIGHBORHOOD"
          onClose={() => setModal(null)}
          className="rules-dialog"
        >
          <p className="dialog-description">
            Buy your favorite corners of the city, build a property empire, and be the last player with money
            on the table.
          </p>
          <div className="rules-list">
            {rules.map((r, i) => (
              <div className="rule" key={r.title}>
                <span className="rule-icon">
                  <r.icon size={20} />
                </span>
                <div>
                  <h3>
                    <span>0{i + 1}</span> {r.title}
                  </h3>
                  <p>{r.text}</p>
                </div>
              </div>
            ))}
          </div>
          <div className="keyboard-guide">
            <span>
              <kbd>SPACE</kbd> Roll / end turn
            </span>
            <span>
              <kbd>M</kbd> Properties
            </span>
            <span>
              <kbd>R</kbd> Reset view
            </span>
          </div>
          <p className="dialog-footnote">
            House rules: no auctions or free-parking jackpot. Quick games start with $1,000. Rent becomes 2×
            at round 15, 3× at round 20, and rises by 1× every five rounds.
          </p>
          <button className="primary-button full-width" onClick={() => setModal(null)}>
            Got it. Let’s play. <ArrowRight size={17} />
          </button>
        </Dialog>
      )}
      {modal === 'settings' && (
        <Dialog
          title="Make yourself comfortable."
          eyebrow="YOUR TABLE, YOUR RULES"
          onClose={() => setModal(null)}
        >
          <div className="settings-row">
            <div>
              <h3>
                <AudioLines size={18} /> Game sounds
              </h3>
              <p>A little sound for every big move.</p>
            </div>
            <button
              className={`toggle ${!muted ? 'on' : ''}`}
              role="switch"
              aria-checked={!muted}
              aria-label="Game sounds"
              onClick={() => {
                unlockAudio()
                setMuted((v) => !v)
              }}
            >
              <span />
            </button>
          </div>
          <div className="settings-row">
            <div>
              <h3>
                <Dice5 size={18} /> Faster computer turns
              </h3>
              <p>Keep the dice moving.</p>
            </div>
            <button
              className={`toggle ${fast ? 'on' : ''}`}
              role="switch"
              aria-checked={fast}
              aria-label="Faster computer turns"
              onClick={() => setFast((v) => !v)}
            >
              <span />
            </button>
          </div>
          <div className="settings-note">
            <ShieldCheck size={19} />
            <p>
              {online
                ? 'The room holds this game for everyone at the table. You can close the tab and come back to the same city.'
                : 'Your game saves on this device after each completed move. You can close the tab and pick up where you left off.'}
            </p>
          </div>
          {online ? (
            <button className="secondary-button full-width" onClick={online.leave}>
              <ArrowLeft size={17} /> Leave the room
            </button>
          ) : (
            <button className="secondary-button full-width" onClick={() => setModal('setup')}>
              <RotateCcw size={17} /> Start a new game
            </button>
          )}
        </Dialog>
      )}
      {state.phase === 'card' &&
        state.card &&
        cardDismissed !== cardKey &&
        !modal &&
        selected === null &&
        !paused && (
          <Dialog
            title={state.card.title}
            eyebrow={state.card.deck === 'chance' ? 'A LITTLE CHANCE' : 'FROM YOUR COMMUNITY'}
            // Turning the card over belongs to the player who drew it. For anyone
            // else online this is a card they are being shown, and putting it down
            // has to be something they can do without sending anything.
            onClose={() =>
              online && !humanTurn ? setCardDismissed(cardKey) : dispatch({ type: 'ACK_CARD' })
            }
            className={`event-card ${state.card.deck}`}
          >
            <div className="card-illustration">
              {state.card.deck === 'chance' ? '?' : <Sparkles size={74} strokeWidth={1} />}
            </div>
            <p>{state.card.text}</p>
            <div className="card-for">
              A card for <strong style={{ color: player.color }}>{player.name}</strong>
            </div>
            {/* Everyone sees the card; only the player who drew it turns it over. */}
            <button
              className="primary-button full-width"
              disabled={Boolean(online && !humanTurn)}
              onClick={() => dispatch({ type: 'ACK_CARD' })}
            >
              {online && !humanTurn ? `${player.name} is reading it…` : 'Let’s see what’s next'}{' '}
              <ArrowRight size={18} />
            </button>
          </Dialog>
        )}
      {state.phase === 'debt' && state.debt && humanTurn && !modal && selected === null && (
        <Dialog title="Time to make a plan." eyebrow="A PAYMENT IS DUE" onClose={() => openPortfolio()}>
          <div className="debt-amount">
            {money(state.debt.amount)}
            <span>{state.debt.reason}</span>
          </div>
          <p className="dialog-description">
            You have {money(player.cash)} in cash. Sell buildings or mortgage properties to cover the
            remaining {money(Math.max(0, state.debt.amount - player.cash))}.
          </p>
          <div className="dialog-actions">
            <button className="secondary-button" onClick={() => openPortfolio()}>
              Manage properties
            </button>
            <button className="primary-button" onClick={() => dispatch({ type: 'LIQUIDATE' })}>
              Raise cash <Landmark size={17} />
            </button>
          </div>
          <p className="small-copy muted">
            Raise cash sells buildings evenly, then mortgages properties until the payment is covered. Total
            available: {money(debtCapacity(state))}.
          </p>
          {debtCapacity(state) < state.debt.amount && (
            <button className="danger-button full-width" onClick={() => dispatch({ type: 'BANKRUPT' })}>
              Declare bankruptcy
            </button>
          )}
        </Dialog>
      )}
      {isFinished && !winnerDismissed && modal !== 'setup' && (
        <Dialog
          title="The city is yours."
          eyebrow="A GAME VERY WELL PLAYED"
          onClose={() => setWinnerDismissed(true)}
          className="winner-dialog"
        >
          <div className="winner-confetti">
            <Trophy size={26} />
            <TokenIcon
              token={state.players[state.winner!].token}
              color={state.players[state.winner!].color}
              size={120}
            />
            <Sparkles size={26} />
          </div>
          <h3>{state.players[state.winner!].name} wins!</h3>
          <p>Good moves. Bold decisions. One well-earned victory.</p>
          <div className="winner-stats">
            <div>
              <span>FINAL CASH</span>
              <strong>{money(state.players[state.winner!].cash)}</strong>
            </div>
            <div>
              <span>PROPERTIES</span>
              <strong>{ownedSpaces(state, state.winner!).length}</strong>
            </div>
            <div>
              <span>NET WORTH</span>
              <strong>{money(netWorth(state, state.winner!))}</strong>
            </div>
          </div>
          {online ? (
            <button
              className="primary-button full-width"
              onClick={online.send.rematch}
              disabled={online.rematch.mine}
            >
              {online.rematch.mine
                ? online.rematch.theirs
                  ? 'Dealing a new city…'
                  : 'Waiting for the table…'
                : 'One more round?'}{' '}
              <RotateCcw size={18} />
            </button>
          ) : (
            <button className="primary-button full-width" onClick={() => setModal('setup')}>
              One more round? <RotateCcw size={18} />
            </button>
          )}
          <button className="text-button" onClick={() => setWinnerDismissed(true)}>
            Take a look at the final board
          </button>
          {online && (
            <button className="text-button" onClick={online.leave}>
              Leave the room
            </button>
          )}
        </Dialog>
      )}
    </div>
  )
}
export default MonopolyGame
