import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { Link } from 'react-router'
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowRightLeft,
  Bot,
  Check,
  ChevronRight,
  CircleHelp,
  EyeOff,
  Flag,
  Hand,
  Layers,
  LogOut,
  Megaphone,
  Minus,
  Plus,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trophy,
  Volume2,
  VolumeX,
  WifiOff,
  X,
} from 'lucide-react'
import { act, cardName, cardPoints, createGame, handView, playableCards } from '@games/shared/prism'
import { chooseMove } from '@games/shared/prism/ai'
import { COLOR_HEX, COLORS } from '@games/shared/prism/types'
import type { Card, Command, GameState } from '@games/shared/prism/types'
import { CLAIM_WIN_AFTER_MS } from '@games/shared/protocol'
import { sound } from './game/audio'
import TableScene from './scene/TableScene'
import type { TableApi } from './scene/createScene'
import Setup from './components/Setup'
import type { SetupOptions } from './components/Setup'
import CardFace from './components/CardFace'
import Dialog from './components/Dialog'
import Rules from './components/Rules'
import OnlinePanel from '../../online/OnlinePanel'
import { prismGame } from '../catalog'
import { claimTarget } from './online/session'
import type { OnlinePrismSession } from './online/session'
import './PrismGame.css'

const AI_NAMES = ['You', 'Jules', 'Cleo', 'Milo']
const TOKENS = ['✦', '◈', '✳', '◉']
const TOKEN_COLORS = ['#d9bc7c', '#d69583', '#91b3c4', '#b0bb89']
const DEFAULT_OPTIONS: SetupOptions = {
  mode: 'ai',
  count: 4,
  difficulty: 'medium',
  names: ['Player 1', 'Player 2', 'Player 3', 'Player 4'],
}
type Session = { game: GameState; menu: boolean; viewer: number }
function seats(options: SetupOptions) {
  return Array.from({ length: options.count }, (_, i) => ({
    name: options.mode === 'ai' ? AI_NAMES[i] : options.names[i],
    kind: options.mode === 'ai' && i ? ('ai' as const) : ('human' as const),
  }))
}

/**
 * The countdown before an away player's seat can be played without them, and the
 * claim itself. The server stamps `awaySince` and re-validates the claim, so
 * drift here only shifts what the banner says, never what the room allows.
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
    <div className="pr-abandon" role="status">
      <WifiOff size={15} />
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

export default function PrismGame({ online }: { online?: OnlinePrismSession }) {
  const [options, setOptions] = useState<SetupOptions>(DEFAULT_OPTIONS)
  const [session, setSession] = useState<Session>(() => ({
    game: createGame(seats(DEFAULT_OPTIONS)),
    menu: true,
    viewer: 0,
  }))
  const [dialog, setDialog] = useState<'rules' | 'settings' | 'leave' | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [wildCard, setWildCard] = useState<Card | null>(null)
  const [muted, setMuted] = useState(false)
  const [reducedMotion, setReducedMotion] = useState(
    () => matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  const [fast, setFast] = useState(false)
  const [showFeed, setShowFeed] = useState(false)
  const [sort, setSort] = useState(false)
  const table = useRef<Pick<TableApi, 'zoom'>>(null)
  // Online the room is the only source of truth: the local session above never
  // moves, the table is already dealt, and the hand this browser is shown is the
  // only one in the state that is real.
  const game = online ? online.state : session.game
  const menu = online ? false : session.menu
  /** Someone watching has no hand of their own, so they look over seat one's shoulder. */
  const watching = online ? online.viewer === null : false
  const viewer = online ? (online.viewer ?? 0) : session.viewer
  const active = game.players[game.currentPlayer],
    me = game.players[viewer]
  const handoff =
    !menu && !online && options.mode === 'local' && viewer !== game.currentPlayer && game.status === 'playing'
  const enabled =
    !menu &&
    !handoff &&
    !watching &&
    !dialog &&
    !wildCard &&
    game.status === 'playing' &&
    active.kind === 'human' &&
    game.currentPlayer === viewer
  const moves = playableCards(game)
  const selectedCard = me.hand.find((c) => c.id === selected)
  const canCall =
    !menu &&
    !watching &&
    game.status === 'playing' &&
    ((game.callWindow === viewer && !me.called) ||
      (enabled && me.hand.length === 2 && game.preCalled !== viewer))
  /** A watcher is shown seat one's hand, and it arrives already face-down. */
  const hideHand = handoff || watching
  const awayBlocking = online ? claimTarget(online) : null
  const previousSound = useRef(game.sequence)
  const visibleHand = useMemo(() => {
    const cards = handView(game, viewer)
    return sort
      ? [...cards].sort(
          (a, b) =>
            COLORS.indexOf(a.color as (typeof COLORS)[number]) -
              COLORS.indexOf(b.color as (typeof COLORS)[number]) ||
            String(a.value).localeCompare(String(b.value), undefined, { numeric: true }),
        )
      : cards
  }, [game, viewer, sort])

  const send = useCallback(
    (command: Command) => {
      // Online nothing is applied here: the command goes to the room, and the
      // table moves when the room says it did.
      if (online) online.send.command(command)
      else
        setSession((current) => {
          const next = act(current.game, command)
          return next === current.game ? current : { ...current, game: next }
        })
      if (command.type === 'play' || command.type === 'draw' || command.type === 'pass') setSelected(null)
    },
    [online],
  )

  useEffect(() => {
    if (online || menu || dialog || wildCard || handoff || game.status !== 'playing' || active.kind !== 'ai')
      return
    const timer = window.setTimeout(
      () => {
        setSession((current) => {
          if (current.game !== game || current.menu) return current
          let next = game
          if (next.callWindow !== null && next.callWindow !== next.currentPlayer)
            next = act(next, { type: 'catch', player: next.currentPlayer, target: next.callWindow })
          next = act(next, chooseMove(next, options.difficulty))
          if (next.callWindow !== null && next.players[next.callWindow].kind === 'ai')
            next = act(next, { type: 'call', player: next.callWindow })
          return { ...current, game: next }
        })
      },
      game.callWindow !== null ? 2400 : fast ? 650 : 1400,
    )
    return () => window.clearTimeout(timer)
  }, [game, menu, dialog, wildCard, handoff, active.kind, options.difficulty, fast, online])

  useEffect(() => {
    const recent = game.events.filter((e) => e.id > previousSound.current)
    previousSound.current = game.sequence
    if (menu || muted || !recent.length) return
    const event =
      recent.find((e) => e.kind === 'win') ??
      recent.find((e) => e.kind === 'call') ??
      recent.find((e) => e.kind === 'effect') ??
      recent.at(-1)!
    sound(event.kind)
  }, [game.sequence, game.events, menu, muted])

  useEffect(() => {
    // Online there is nothing to lose by reloading: the room holds the round and
    // the seat comes back with it, so the warning would only be in the way.
    if (menu || online || game.status !== 'playing') return
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => window.removeEventListener('beforeunload', beforeUnload)
  }, [menu, game.status, online])

  function start(again = false) {
    const next = createGame(
      seats(options),
      {},
      Math.random,
      again ? game.round + 1 : 1,
      again ? game.players.map((p) => p.totalScore) : [],
    )
    previousSound.current = 0
    setSession({ game: next, menu: false, viewer: 0 })
    setSelected(null)
    setWildCard(null)
    setDialog(null)
    if (!muted) sound('shuffle')
  }
  function returnToMenu() {
    setSession((current) => ({ ...current, menu: true }))
    setDialog(null)
    setSelected(null)
    setWildCard(null)
  }
  function play(card: Card) {
    if (!enabled || !moves.some((c) => c.id === card.id)) return
    if (card.isWild) setWildCard(card)
    else send({ type: 'play', player: viewer, cardId: card.id })
  }
  const top = game.discardPile.at(-1)!
  const lastEvent = game.events.at(-1)
  /** True when the seat on turn is this browser's to play — never a watcher's. */
  const mine = !watching && active.id === viewer
  /** Only the viewer's own leftovers can be counted: the rest stay face-down. */
  const leftovers = (player: (typeof game.players)[number]) =>
    player.hand.reduce((sum, c) => sum + cardPoints(c), 0)
  const ranks = [...game.players].sort((a, b) =>
    a.id === game.winner
      ? -1
      : b.id === game.winner
        ? 1
        : online
          ? a.hand.length - b.hand.length
          : leftovers(a) - leftovers(b),
  )

  return (
    <div className={`pr-app ${menu ? 'pr-is-menu' : 'pr-is-playing'} ${reducedMotion ? 'pr-reduced' : ''}`}>
      <header className="pr-header">
        <div className="pr-header-left">
          <Link to="/" className="pr-all-games">
            <ArrowLeft size={16} />
            <span>All games</span>
          </Link>
          <span className="pr-header-divider" />
          <div className="pr-brand">
            <span className="pr-brand-mark">
              <i />
              <i />
              <i />
              <i />
            </span>
            prism<span className="pr-brand-dot">.</span>
          </div>
        </div>
        <span className="pr-header-note">GOOD CARDS. BETTER COMPANY.</span>
        <nav className="pr-header-actions" aria-label="Game controls">
          <button
            className="pr-icon"
            aria-label={muted ? 'Turn sound on' : 'Mute sound'}
            onClick={() => setMuted(!muted)}
          >
            {muted ? <VolumeX size={18} /> : <Volume2 size={18} />}
          </button>
          <button className="pr-icon" aria-label="How to play" onClick={() => setDialog('rules')}>
            <CircleHelp size={19} />
          </button>
          <button className="pr-icon" aria-label="Settings" onClick={() => setDialog('settings')}>
            <Settings2 size={18} />
          </button>
          {!menu && (
            <button className="pr-icon" aria-label="Leave game" onClick={() => setDialog('leave')}>
              <LogOut size={18} />
            </button>
          )}
        </nav>
      </header>
      <main className="pr-arena">
        <div className="pr-scene-wrap">
          <TableScene ref={table} state={{ game, viewer, menu, reducedMotion }} />
        </div>
        {menu ? (
          <>
            <Setup
              options={options}
              onChange={setOptions}
              onStart={() => start()}
              onHelp={() => setDialog('rules')}
            />
            <div className="pr-menu-table-label">
              <span className="pr-eyebrow">YOUR TABLE IS READY</span>
              <span>Good times are in the cards.</span>
            </div>
            <div className="pr-menu-badge">
              <ShieldCheck size={16} />
              <span>
                A fair game. Every time.<small>AI plays by the same rules you do.</small>
              </span>
            </div>
            <span className="pr-menu-table-player">
              <span>✦</span> A seat with your name on it
            </span>
          </>
        ) : (
          <>
            <div className="pr-round">
              <span className="pr-live-dot" /> ROUND {String(game.round).padStart(2, '0')}{' '}
              <span className="pr-round-separator">/</span> CLASSIC
            </div>
            <div className="pr-direction">
              <ArrowRightLeft size={15} className={game.direction === -1 ? 'pr-reverse' : ''} />
              <span>{game.direction === 1 ? 'Clockwise' : 'Counterclockwise'}</span>
            </div>
            {game.players
              .filter((p) => p.id !== viewer)
              .map((p) => {
                const offset = (p.id - viewer + game.players.length) % game.players.length
                const position =
                  game.players.length === 2 || (game.players.length === 4 && offset === 2)
                    ? 'top'
                    : offset === 1
                      ? 'left'
                      : 'right'
                return (
                  <div
                    className={`pr-opponent pr-opponent-${position} ${active.id === p.id ? 'pr-current' : ''}`}
                    key={p.id}
                    aria-label={`${p.name}, ${p.hand.length} cards${active.id === p.id ? ', current turn' : ''}`}
                  >
                    <span className="pr-avatar" style={{ '--token': TOKEN_COLORS[p.id] } as CSSProperties}>
                      {TOKENS[p.id]}
                      {active.id === p.id && <i />}
                    </span>
                    <div className="pr-opponent-info">
                      <strong>
                        {p.name} {p.kind === 'ai' && <Bot size={12} />}
                        {online && online.players[p.id]?.connected === false && (
                          <WifiOff size={12} aria-label="away" />
                        )}
                      </strong>
                      <span>
                        {p.hand.length === 1 ? (
                          <b>1 CARD LEFT</b>
                        ) : (
                          <>
                            <Layers size={11} /> {p.hand.length} cards
                          </>
                        )}
                        {p.called && <Check size={12} />}
                      </span>
                    </div>
                    {active.id === p.id && (
                      <span className="pr-thinking">
                        {p.kind === 'ai' ? 'Thinking' : 'Their turn'}
                        <i />
                        <i />
                        <i />
                      </span>
                    )}
                  </div>
                )
              })}
            <div className="pr-center-info">
              <span className="pr-pile-name">
                DRAW PILE <small>{game.drawPile.length} cards</small>
              </span>
              <span className="pr-pile-name">
                IN PLAY <small>{cardName(top)}</small>
              </span>
            </div>
            <div
              className="pr-active-color"
              style={{ '--active-color': COLOR_HEX[game.activeColor] } as CSSProperties}
            >
              <i />
              <span>
                Active color <strong>{game.activeColor}</strong>
              </span>
              {top.isWild && <Sparkles size={13} />}
            </div>
            <div className="pr-turn-announcement" role="status" aria-live="polite">
              <span className={`pr-turn-dot ${enabled ? 'pr-turn-ready' : ''}`} />
              <div>
                <strong>
                  {game.status !== 'playing'
                    ? 'A round well played.'
                    : handoff
                      ? `Pass to ${active.name}`
                      : mine
                        ? 'Your turn. Make it colorful.'
                        : `${active.name}’s turn`}
                </strong>
                <small>
                  {game.status !== 'playing'
                    ? 'Good cards. Better company.'
                    : handoff
                      ? 'Keep your cards close.'
                      : !mine
                        ? 'A good move is worth the wait.'
                        : game.pendingPenalty
                          ? `Take ${game.pendingPenalty.count} or play a matching penalty.`
                          : game.drawnCardId
                            ? 'Play the new card, or keep it and pass.'
                            : moves.length
                              ? `${moves.length} playable ${moves.length === 1 ? 'card' : 'cards'} · tap to select`
                              : 'No matching cards. Draw to keep things moving.'}
                </small>
              </div>
            </div>
            <aside className={`pr-feed ${showFeed ? 'pr-feed-expanded' : ''}`} aria-label="Game events">
              <button onClick={() => setShowFeed(!showFeed)}>
                <span>AT THE TABLE</span>
                {showFeed ? <X size={13} /> : <ChevronRight size={13} />}
              </button>
              <ol>
                {game.events.slice(showFeed ? -8 : -2).map((e) => (
                  <li
                    key={e.id}
                    className={e.kind === 'effect' || e.kind === 'call' ? 'pr-event-special' : ''}
                  >
                    <i />
                    {e.text}
                  </li>
                ))}
              </ol>
            </aside>
            <div className="sr-only" aria-live="polite">
              {lastEvent?.text}
            </div>
            <div className="pr-camera-controls">
              <button className="pr-icon" aria-label="Zoom out" onClick={() => table.current?.zoom(-0.1)}>
                <Minus size={15} />
              </button>
              <span>TABLE VIEW</span>
              <button className="pr-icon" aria-label="Zoom in" onClick={() => table.current?.zoom(0.1)}>
                <Plus size={15} />
              </button>
            </div>
            <section className={`pr-hand-area ${hideHand ? 'pr-hand-hidden' : ''}`} aria-label="Your hand">
              <div className="pr-hand-topline">
                <span>
                  <Hand size={14} /> {me.name === 'You' ? 'YOUR HAND' : `${me.name.toUpperCase()}’S HAND`}{' '}
                  <b>{me.hand.length}</b>
                </span>
                <button onClick={() => setSort(!sort)} aria-pressed={sort}>
                  <ArrowRightLeft size={12} /> {sort ? 'Dealt order' : 'Sort by color'}
                </button>
              </div>
              <div className="pr-hand-scroll">
                <div
                  className={`pr-hand ${me.hand.length > 10 ? 'pr-hand-many' : ''}`}
                  style={{ '--count': visibleHand.length } as CSSProperties}
                >
                  {!hideHand &&
                    visibleHand.map((card, i) => (
                      <button
                        key={card.id}
                        className={`pr-card ${card.playable && enabled ? 'pr-playable' : 'pr-unplayable'} ${card.id === selected ? 'pr-selected' : ''} ${card.id === game.drawnCardId ? 'pr-just-drawn' : ''}`}
                        style={
                          {
                            '--i': i,
                            '--angle': `${(i - (visibleHand.length - 1) / 2) * Math.min(3.2, 21 / visibleHand.length)}deg`,
                            '--lift': `${Math.pow(i - (visibleHand.length - 1) / 2, 2) * Math.min(1.05, 28 / (visibleHand.length * visibleHand.length))}px`,
                          } as CSSProperties
                        }
                        disabled={!enabled || !card.playable}
                        aria-label={`${cardName(card)}${card.id === game.drawnCardId ? ', drawn card' : ''}${card.playable && enabled ? ', playable' : ', not playable'}`}
                        aria-pressed={selected === card.id}
                        onClick={() => {
                          if (selected === card.id) play(card)
                          else setSelected(card.id)
                        }}
                      >
                        <CardFace card={card} />
                        <span className="pr-card-play-hint">
                          {selected === card.id ? 'TAP TO PLAY' : 'PLAYABLE'}
                        </span>
                      </button>
                    ))}
                </div>
              </div>
              <div className="pr-hand-toolbar">
                <div className="pr-you">
                  <span className="pr-avatar" style={{ '--token': TOKEN_COLORS[viewer] } as CSSProperties}>
                    {TOKENS[viewer]}
                  </span>
                  <span>
                    <strong>{me.name}</strong>
                    <small>
                      {me.hand.length === 1
                        ? '1 CARD LEFT'
                        : `${me.hand.length} cards · ${me.totalScore} points`}
                    </small>
                  </span>
                </div>
                <div className="pr-play-controls">
                  {game.drawnCardId && enabled ? (
                    <button className="pr-secondary" onClick={() => send({ type: 'pass', player: viewer })}>
                      <Check size={16} /> Keep & pass
                    </button>
                  ) : (
                    <button
                      className="pr-secondary"
                      disabled={!enabled}
                      onClick={() => send({ type: 'draw', player: viewer })}
                    >
                      <ArrowDownToLine size={16} />{' '}
                      {game.pendingPenalty ? `Draw ${game.pendingPenalty.count}` : 'Draw card'}
                    </button>
                  )}
                  {selectedCard && enabled && (
                    <button className="pr-primary pr-play-button" onClick={() => play(selectedCard)}>
                      Play card <ArrowRight size={16} />
                    </button>
                  )}
                  <button
                    className={`pr-call ${canCall ? 'pr-call-ready' : ''}`}
                    disabled={!canCall}
                    onClick={() => send({ type: 'call', player: viewer })}
                  >
                    <Megaphone size={17} />
                    <span>{me.called || game.preCalled === viewer ? 'Called!' : 'Call Prism!'}</span>
                  </button>
                </div>
                <span className="pr-hand-tip">
                  {selectedCard && enabled ? (
                    cardName(selectedCard)
                  ) : (
                    <>
                      <i /> {enabled ? 'You’re up' : 'Enjoy the table'}
                    </>
                  )}
                </span>
              </div>
            </section>
            {game.callWindow !== null &&
              game.callWindow !== viewer &&
              active.kind === 'human' &&
              !hideHand && (
                <button
                  className="pr-catch"
                  onClick={() => send({ type: 'catch', player: viewer, target: game.callWindow! })}
                >
                  <Flag size={16} /> Catch {game.players[game.callWindow].name} — no call!
                </button>
              )}
            {game.callWindow !== null &&
              !watching &&
              (game.callWindow === viewer || options.mode === 'local') && (
                <div className="pr-call-notice">
                  <Megaphone size={17} />
                  <span>{game.players[game.callWindow].name}: one card left. Call Prism!</span>
                  <button onClick={() => send({ type: 'call', player: game.callWindow! })}>Prism!</button>
                </div>
              )}
            {awayBlocking && (
              <AbandonmentNotice
                name={awayBlocking.name}
                awaySince={awayBlocking.awaySince}
                onClaim={() => online?.send.claim()}
              />
            )}
          </>
        )}
      </main>
      {menu && !online && (
        <section className="pr-online-panel">
          <OnlinePanel game="prism" basePath={prismGame.path} seatChoices={[2, 3, 4]} />
        </section>
      )}
      <footer className="pr-footer">
        <span>A LITTLE PLAY GOES A LONG WAY.</span>
        <span>
          <i />{' '}
          {menu
            ? 'Made for good company'
            : `${online ? 'Online table' : options.mode === 'ai' ? `${options.difficulty} AI` : 'Pass & play'} · ${game.players.length} players`}{' '}
          <span className="pr-footer-star">✦</span>
        </span>
      </footer>

      {dialog === 'rules' && <Rules onClose={() => setDialog(null)} />}
      {dialog === 'settings' && (
        <Dialog title="Table settings" onClose={() => setDialog(null)}>
          <p className="pr-eyebrow">MAKE YOURSELF AT HOME</p>
          <h2>Your kind of table.</h2>
          <p className="pr-dialog-copy">Little adjustments for a better game.</p>
          {[
            {
              label: 'Sound effects',
              detail: 'A little shuffle, a little celebration.',
              value: !muted,
              change: () => setMuted(!muted),
            },
            {
              label: 'Reduced motion',
              detail: 'Quiet transitions and no flying cards.',
              value: reducedMotion,
              change: () => setReducedMotion(!reducedMotion),
            },
            {
              label: 'Faster AI turns',
              detail: 'Keep the cards moving.',
              value: fast,
              change: () => setFast(!fast),
            },
          ].map((setting) => (
            <div className="pr-setting" key={setting.label}>
              <span>
                <strong>{setting.label}</strong>
                <small>{setting.detail}</small>
              </span>
              <button
                role="switch"
                aria-label={setting.label}
                aria-checked={setting.value}
                className="pr-toggle"
                onClick={setting.change}
              >
                <i />
              </button>
            </div>
          ))}
          <p className="pr-fine-print">
            Classic rules · no stacking · draw one · restricted Take Four. Your current round pauses while
            this panel is open.
          </p>
          <button className="pr-primary" onClick={() => setDialog(null)}>
            All set <Check size={16} />
          </button>
        </Dialog>
      )}
      {dialog === 'leave' && (
        <Dialog title="Leave this round" onClose={() => setDialog(null)}>
          <span className="pr-dialog-symbol">
            <LogOut />
          </span>
          <h2>Leave the table?</h2>
          <p className="pr-dialog-copy">
            {online
              ? 'The round plays on without you. Your seat is yours to come back to.'
              : 'This round will end. There’s always room for another game.'}
          </p>
          <div className="pr-dialog-actions">
            <button className="pr-secondary" onClick={() => setDialog(null)}>
              Keep playing
            </button>
            {online ? (
              <button className="pr-primary" onClick={online.leave}>
                Leave room
              </button>
            ) : (
              <button className="pr-primary" onClick={returnToMenu}>
                Return to menu
              </button>
            )}
          </div>
        </Dialog>
      )}
      {wildCard && (
        <Dialog title="Choose a color" onClose={() => setWildCard(null)}>
          <div className="pr-wild-preview">
            <CardFace card={wildCard} />
          </div>
          <p className="pr-eyebrow">CHANGE THE CONVERSATION</p>
          <h2>Choose a color.</h2>
          <p className="pr-dialog-copy">
            {wildCard.value === 'draw4'
              ? 'Take Four. A new color, and four cards for the next player.'
              : 'A fresh color. A whole new possibility.'}
          </p>
          <div className="pr-color-options">
            {COLORS.map((color) => (
              <button
                key={color}
                style={{ '--choice': COLOR_HEX[color] } as CSSProperties}
                aria-label={`Choose ${color}`}
                onClick={() => {
                  send({ type: 'play', player: viewer, cardId: wildCard.id, color })
                  setWildCard(null)
                }}
              >
                <span>{TOKENS[COLORS.indexOf(color)]}</span>
                {color}
              </button>
            ))}
          </div>
          <button className="pr-text-button" onClick={() => setWildCard(null)}>
            Back to my hand
          </button>
        </Dialog>
      )}
      {handoff && !dialog && (
        <Dialog title="Pass the device" onClose={() => {}} locked>
          <span className="pr-dialog-symbol">
            <EyeOff size={26} />
          </span>
          <p className="pr-eyebrow">KEEP A LITTLE MYSTERY</p>
          <h2>{active.name}, you’re up.</h2>
          <p className="pr-dialog-copy">
            Pass the device to {active.name}.<br />
            Everyone else, no peeking.
          </p>
          {game.callWindow === viewer && (
            <button
              className="pr-call pr-call-ready pr-handoff-call"
              onClick={() => send({ type: 'call', player: viewer })}
            >
              <Megaphone size={17} /> {me.name}: Call Prism!
            </button>
          )}
          <button
            className="pr-primary"
            onClick={() => {
              setSession((current) => ({ ...current, viewer: current.game.currentPlayer }))
              setSelected(null)
            }}
          >
            I’m {active.name} — show my hand <ArrowRight size={16} />
          </button>
          <button className="pr-text-button" onClick={() => setDialog('leave')}>
            Leave this round
          </button>
        </Dialog>
      )}
      {!menu && game.status !== 'playing' && (
        <Dialog title="Round result" onClose={() => {}} locked>
          {!reducedMotion && game.status === 'won' && (
            <div className="pr-confetti" aria-hidden="true">
              {Array.from({ length: 30 }, (_, i) => (
                <i
                  key={i}
                  style={{ '--n': i, '--confetti': Object.values(COLOR_HEX)[i % 4] } as CSSProperties}
                />
              ))}
            </div>
          )}
          <span className="pr-win-token">
            {game.winner === null ? <Hand size={35} /> : <Trophy size={35} />}
          </span>
          <p className="pr-eyebrow">THAT’S A BEAUTIFUL HAND</p>
          <h2>
            {game.status === 'draw'
              ? 'A table well matched.'
              : game.players[game.winner!].name === 'You'
                ? 'You win!'
                : `${game.players[game.winner!].name} wins!`}
          </h2>
          <p className="pr-dialog-copy">
            {game.status === 'draw'
              ? 'No cards left to draw and no legal moves. Let’s shuffle again.'
              : `A little luck. A lovely finish. +${game.roundScore} points.`}
          </p>
          <div className="pr-ranking">
            <div className="pr-ranking-label">
              <span>ROUND {game.round}</span>
              <span>{online ? 'CARDS LEFT' : 'CARDS / POINTS LEFT'}</span>
            </div>
            {ranks.map((p, i) => (
              <div key={p.id}>
                <span className="pr-rank">{i + 1}</span>
                <span className="pr-mini-token" style={{ color: TOKEN_COLORS[p.id] }}>
                  {TOKENS[p.id]}
                </span>
                <strong>
                  {p.name}
                  <small>{p.totalScore} total points</small>
                </strong>
                <span>
                  {p.hand.length}
                  {/* Online a hand stays face-down to the end, so only this seat's
                      own leftovers can honestly be counted up. */}
                  {(!online || p.id === viewer) && <small> / {leftovers(p)}</small>}
                </span>
                {p.id === game.winner && <Trophy size={14} />}
              </div>
            ))}
          </div>
          {online ? (
            <>
              <button className="pr-primary" onClick={online.send.rematch} disabled={online.rematch.mine}>
                <RotateCcw size={16} />{' '}
                {online.rematch.mine
                  ? 'Waiting for the table…'
                  : online.rematch.theirs
                    ? 'Accept another round'
                    : 'Another round'}
              </button>
              <button className="pr-text-button" onClick={online.leave}>
                Leave room
              </button>
            </>
          ) : (
            <>
              <button className="pr-primary" onClick={() => start(true)}>
                <RotateCcw size={16} /> Play again
              </button>
              <button className="pr-text-button" onClick={returnToMenu}>
                Return to menu
              </button>
            </>
          )}
        </Dialog>
      )}
    </div>
  )
}
