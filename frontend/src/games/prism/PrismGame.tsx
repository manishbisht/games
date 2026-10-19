import ThemeControl from '../../theme/ThemeControl'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { PlayersOnlineBadge } from '../../online/playersOnline'
import { HeaderAuth } from '../../online/identity'
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
import { cardName, cardPoints, createGame, handView, playableCards } from '@games/shared/prism'
import { COLOR_HEX, COLORS } from '@games/shared/prism/types'
import type { Card, Command } from '@games/shared/prism/types'
import { CLAIM_WIN_AFTER_MS } from '@games/shared/protocol'
import { sound } from './game/audio'
import TableScene from './scene/TableScene'
import { tableView } from './scene/createScene'
import type { Cue, TableApi, TableHost, TableView } from './scene/createScene'
import { warmImages } from './scene/artwork'
import { setMotionPreference, useReducedMotion } from '../../motion/preference'
import { useHeld } from '../../motion/hooks'
import { useBotRoom } from '../../online/useBotRoom'
import { prismGame } from '../catalog'
import Setup from './components/Setup'
import type { SetupOptions } from './components/Setup'
import CardFace from './components/CardFace'
import Dialog, { DialogDismiss } from './components/Dialog'
import { useHandMotion } from './components/useHandMotion'
import Rules from './components/Rules'
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
function seats(options: SetupOptions) {
  return Array.from({ length: options.count }, (_, i) => ({
    name: AI_NAMES[i],
    kind: i ? ('ai' as const) : ('human' as const),
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

type CueKind = Exclude<Cue['kind'], 'sound'>
type Cues = Partial<Record<CueKind, Cue & { key: number }>>
/** The newest cue of `kind`, if it is about `player`. */
function cueFor<K extends CueKind>(cues: Cues, kind: K, player: number) {
  const cue = cues[kind] as (Extract<Cue, { kind: K }> & { key: number }) | undefined
  return cue && 'player' in cue && cue.player === player ? cue : null
}

export default function PrismGame({ online }: { online?: OnlinePrismSession }) {
  const [options, setOptions] = useState<SetupOptions>(DEFAULT_OPTIONS)
  // The table shown behind the setup panel. It is never played: choosing a
  // game creates a room, and the room deals the real one.
  const preview = useMemo(() => createGame(seats(DEFAULT_OPTIONS)), [])
  const [dialog, setDialog] = useState<'rules' | 'settings' | 'leave' | null>(null)
  // Card ids repeat from round to round (the same deck is dealt again), so a
  // selection only counts in the round it was made.
  const [selection, setSelection] = useState<{ round: number; id: string } | null>(null)
  const [wildCard, setWildCard] = useState<Card | null>(null)
  const [muted, setMuted] = useState(false)
  const reducedMotion = useReducedMotion()
  const [showFeed, setShowFeed] = useState(false)
  const [sort, setSort] = useState(false)
  const [view, setView] = useState<TableView | null>(null)
  const [cues, setCues] = useState<Cues>({})
  const table = useRef<Pick<TableApi, 'zoom'>>(null),
    handElement = useRef<HTMLDivElement>(null)
  // The room is the only source of a dealt table, and the hand this browser is
  // shown is the only one in the state that is real.
  const game = online ? online.state : preview
  const menu = !online
  /** Someone watching has no hand of their own, so they look over seat one's shoulder. */
  const watching = online ? online.viewer === null : false
  const viewer = online?.viewer ?? 0
  const motion = useHandMotion(handElement, game.round)
  useEffect(() => warmImages(), [])
  /**
   * What the table is showing. It trails the room by as long as the cards take
   * to land, and everything on the page that reads as "now" — whose turn, the
   * counts, the pile, the result — reads from it, so nothing gets ahead of the
   * felt. Without a 3D table it is simply the room's state.
   */
  const shown = view && view.game.round === game.round ? view : tableView(game)
  const now = shown.game
  const caughtUp = !shown.busy && shown.sequence === game.sequence
  const active = now.players[now.currentPlayer],
    me = game.players[viewer]
  const arriving = new Set(shown.arriving)
  const wild = wildCard && me.hand.some((c) => c.id === wildCard.id) ? wildCard : null
  const enabled =
    !menu &&
    !watching &&
    !dialog &&
    !wild &&
    caughtUp &&
    game.status === 'playing' &&
    game.players[game.currentPlayer].kind === 'human' &&
    game.currentPlayer === viewer
  const moves = playableCards(game)
  const selected =
    selection && selection.round === game.round && me.hand.some((c) => c.id === selection.id)
      ? selection.id
      : null
  const selectedCard = me.hand.find((c) => c.id === selected)
  const canCall =
    !menu &&
    !watching &&
    game.status === 'playing' &&
    ((game.callWindow === viewer && !me.called) ||
      (enabled && me.hand.length === 2 && game.preCalled !== viewer))
  /** A watcher is shown seat one's hand, and it arrives already face-down. */
  const hideHand = watching
  const awayBlocking = online ? claimTarget(online) : null
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
  const held = me.hand.filter((c) => !arriving.has(c.id)).length

  const send = useCallback(
    (command: Command) => {
      // Nothing is applied here: the command goes to the room, and the table
      // moves when the room says it did.
      online?.send.command(command)
      if (command.type === 'play' || command.type === 'draw' || command.type === 'pass') setSelection(null)
    },
    [online],
  )

  /** How the table reaches the page: what it shows, where the hand's cards are, and its moments. */
  const host: TableHost = {
    view: setView,
    slot: motion.slot,
    cue: (cue) => {
      if (cue.kind === 'sound') {
        if (!muted) sound(cue.sound)
        return
      }
      setCues((current) => {
        const previous = current[cue.kind]
        // A penalty counting its cards in is one moment, not one per card.
        const same =
          cue.kind === 'penalty' &&
          previous?.kind === 'penalty' &&
          previous.player === cue.player &&
          cue.landed > 0
        return { ...current, [cue.kind]: { ...cue, key: same ? previous.key : (previous?.key ?? 0) + 1 } }
      })
    },
  }

  const room = useBotRoom('prism', prismGame.path)
  const start = () =>
    void room.start({
      seats: options.count,
      // Every seat but yours, all at the difficulty the panel is showing.
      bots: Array.from({ length: options.count - 1 }, () => options.difficulty),
    })

  function play(card: Card) {
    if (!enabled || !moves.some((c) => c.id === card.id)) return
    // Where it sits now is where the table picks it up from.
    motion.launch(card.id)
    if (card.isWild) setWildCard(card)
    else send({ type: 'play', player: viewer, cardId: card.id })
  }
  const top = shown.top
  const lastEvent = now.events.at(-1)
  /**
   * True when the seat on turn is this browser's to play — never a watcher's.
   * The table may still be showing the last card land, but once this seat has
   * acted it is no longer its turn, whatever is still in the air.
   */
  const mine = !watching && active.id === viewer && game.currentPlayer === viewer
  const holder = active.id === viewer && !mine ? game.players[game.currentPlayer] : active
  // The result waits for the last card to land and the confetti to go up.
  const showResult = useHeld(!menu && now.status !== 'playing', 650)
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
  const headline = shown.dealing
    ? 'Shuffling up.'
    : now.status !== 'playing'
      ? 'A round well played.'
      : mine
        ? 'Your turn. Make it colorful.'
        : `${holder.name}’s turn`
  const skipped = cueFor(cues, 'skip', viewer),
    hit = cueFor(cues, 'penalty', viewer)

  return (
    <div className={`pr-app ${menu ? 'pr-is-menu' : 'pr-is-playing'}`}>
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
          <PlayersOnlineBadge game="prism" className="pr-online-badge" />
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
          <ThemeControl />
          <HeaderAuth readOnly={Boolean(online)} />
        </nav>
      </header>
      <main className="pr-arena" aria-busy={shown.busy || undefined}>
        <div className="pr-scene-wrap">
          <TableScene ref={table} state={{ game, viewer, menu, watching }} host={host} />
        </div>
        {menu ? (
          <>
            <Setup
              options={options}
              onChange={setOptions}
              onStart={() => start()}
              onHelp={() => setDialog('rules')}
              disabled={room.disabled}
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
              <ArrowRightLeft size={15} className={shown.direction === -1 ? 'pr-reverse' : ''} />
              <span key={cues.reverse?.key} className={cues.reverse ? 'motion-pop' : ''}>
                {shown.direction === 1 ? 'Clockwise' : 'Counterclockwise'}
              </span>
            </div>
            {game.players
              // A watcher holds no seat, so nobody at the table is "not an
              // opponent" — the near seat belongs on screen like all the rest.
              .filter((p) => watching || p.id !== viewer)
              .map((p) => {
                const offset = (p.id - viewer + game.players.length) % game.players.length
                const position =
                  offset === 0
                    ? 'bottom'
                    : game.players.length === 2 || (game.players.length === 4 && offset === 2)
                      ? 'top'
                      : offset === 1
                        ? 'left'
                        : 'right'
                const count = shown.counts[p.id] ?? p.hand.length,
                  current = active.id === p.id && !shown.dealing,
                  skip = cueFor(cues, 'skip', p.id),
                  penalty = cueFor(cues, 'penalty', p.id)
                return (
                  <div
                    className={`pr-opponent pr-opponent-${position} ${current ? 'pr-current' : ''} ${penalty ? `pr-hit-${penalty.key % 2}` : ''}`}
                    key={p.id}
                    aria-label={`${p.name}, ${count} cards${current ? ', current turn' : ''}`}
                  >
                    <span className="pr-avatar" style={{ '--token': TOKEN_COLORS[p.id] } as CSSProperties}>
                      {TOKENS[p.id]}
                      {current && <i />}
                      {skip && <b key={skip.key} className="pr-stamp" aria-hidden="true" />}
                    </span>
                    <div className="pr-opponent-info">
                      <strong>
                        {p.name} {(p.kind === 'ai' || online?.players[p.id]?.bot) && <Bot size={12} />}
                        {online && online.players[p.id]?.connected === false && (
                          <WifiOff size={12} aria-label="away" />
                        )}
                      </strong>
                      <span>
                        {count === 1 ? (
                          <b>1 CARD LEFT</b>
                        ) : (
                          <>
                            <Layers size={11} /> {count} cards
                          </>
                        )}
                        {p.called && <Check size={12} />}
                      </span>
                    </div>
                    {penalty && (
                      <span key={penalty.key} className="pr-penalty" aria-hidden="true">
                        <span key={penalty.landed}>+{penalty.count}</span>
                      </span>
                    )}
                    {current && (
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
                DRAW PILE <small>{shown.deck} cards</small>
              </span>
              <span className="pr-pile-name">
                IN PLAY <small>{top ? cardName(top) : '—'}</small>
              </span>
            </div>
            <div
              className="pr-active-color"
              style={{ '--active-color': COLOR_HEX[shown.color] } as CSSProperties}
            >
              <i />
              {cues.wild && <b key={cues.wild.key} className="pr-color-wave" aria-hidden="true" />}
              <span>
                Active color <strong>{shown.color}</strong>
              </span>
              {top?.isWild && <Sparkles size={13} />}
            </div>
            <div className="pr-turn-announcement">
              <span className={`pr-turn-dot ${enabled ? 'pr-turn-ready' : ''}`} />
              <div>
                <strong>{headline}</strong>
                <small>
                  {shown.dealing
                    ? 'Seven cards each, coming round.'
                    : now.status !== 'playing'
                      ? 'Good cards. Better company.'
                      : !mine || !caughtUp
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
            {cues.call && (
              <div key={cues.call.key} className="pr-callout" aria-hidden="true">
                <strong>Prism!</strong>
                <span>{'player' in cues.call && game.players[cues.call.player]?.name} called it</span>
              </div>
            )}
            <aside className={`pr-feed ${showFeed ? 'pr-feed-expanded' : ''}`} aria-label="Game events">
              <button onClick={() => setShowFeed(!showFeed)}>
                <span>AT THE TABLE</span>
                {showFeed ? <X size={13} /> : <ChevronRight size={13} />}
              </button>
              <ol>
                {now.events.slice(showFeed ? -8 : -2).map((e) => (
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
            {/* One voice for the table: what just happened, then whose turn it is. */}
            <div className="sr-only" aria-live="polite">
              {lastEvent?.text} {headline}
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
                  <b>{held}</b>
                </span>
                <button onClick={() => setSort(!sort)} aria-pressed={sort}>
                  <ArrowRightLeft size={12} /> {sort ? 'Dealt order' : 'Sort by color'}
                </button>
              </div>
              <div className="pr-hand-scroll">
                <div
                  ref={handElement}
                  className={`pr-hand ${me.hand.length > 10 ? 'pr-hand-many' : ''}`}
                  style={{ '--count': visibleHand.length } as CSSProperties}
                >
                  {!hideHand &&
                    visibleHand.map((card, i) => {
                      // Still in the air: the slot is kept so the hand has
                      // already made room, and the card appears as it lands.
                      const pending = arriving.has(card.id),
                        playable = card.playable && enabled && !pending
                      return (
                        <button
                          key={card.id}
                          data-card={card.id}
                          className={`pr-card ${playable ? 'pr-playable' : 'pr-unplayable'} ${card.id === selected ? 'pr-selected' : ''} ${card.id === game.drawnCardId ? 'pr-just-drawn' : ''} ${pending ? 'pr-pending' : ''}`}
                          style={
                            {
                              '--i': i,
                              '--angle': `${(i - (visibleHand.length - 1) / 2) * Math.min(3.2, 21 / visibleHand.length)}deg`,
                              '--lift': `${Math.pow(i - (visibleHand.length - 1) / 2, 2) * Math.min(1.05, 28 / (visibleHand.length * visibleHand.length))}px`,
                            } as CSSProperties
                          }
                          // Focusable either way, so the whole hand can be read
                          // from the keyboard; only playable cards act.
                          aria-disabled={!playable}
                          aria-hidden={pending || undefined}
                          tabIndex={pending ? -1 : undefined}
                          aria-label={`${cardName(card)}${card.id === game.drawnCardId ? ', drawn card' : ''}${playable ? ', playable' : ', not playable'}`}
                          aria-pressed={selected === card.id}
                          onClick={() => {
                            if (!playable) return
                            if (selected === card.id) play(card)
                            else setSelection({ round: game.round, id: card.id })
                          }}
                        >
                          <CardFace card={card} />
                          <span className="pr-card-play-hint">
                            {selected === card.id ? 'TAP TO PLAY' : 'PLAYABLE'}
                          </span>
                        </button>
                      )
                    })}
                </div>
              </div>
              <div className="pr-hand-toolbar">
                <div className={`pr-you ${hit ? `pr-hit-${hit.key % 2}` : ''}`}>
                  <span className="pr-avatar" style={{ '--token': TOKEN_COLORS[viewer] } as CSSProperties}>
                    {TOKENS[viewer]}
                    {skipped && <b key={skipped.key} className="pr-stamp" aria-hidden="true" />}
                    {hit && (
                      <span key={hit.key} className="pr-penalty" aria-hidden="true">
                        <span key={hit.landed}>+{hit.count}</span>
                      </span>
                    )}
                  </span>
                  <span>
                    <strong>{me.name}</strong>
                    <small>{held === 1 ? '1 CARD LEFT' : `${held} cards · ${me.totalScore} points`}</small>
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
                  className="pr-catch motion-enter"
                  onClick={() => send({ type: 'catch', player: viewer, target: game.callWindow! })}
                >
                  <Flag size={16} /> Catch {game.players[game.callWindow].name} — no call!
                </button>
              )}
            {game.callWindow !== null && !watching && game.callWindow === viewer && (
              <div className="pr-call-notice motion-enter">
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
      <footer className="pr-footer">
        <span>A LITTLE PLAY GOES A LONG WAY.</span>
        <span>
          <i />{' '}
          {menu
            ? 'Made for good company'
            : `${online ? 'Online table' : `${options.difficulty} bots`} · ${game.players.length} players`}{' '}
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
              detail: 'Cards slide and fade instead of flying. Applies to every game here.',
              value: reducedMotion,
              change: () => setMotionPreference(reducedMotion ? 'full' : 'reduced'),
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
            Classic rules · no stacking · draw one · restricted Take Four. An online table plays on while this
            panel is open.
          </p>
          <DialogDismiss className="pr-primary">
            All set <Check size={16} />
          </DialogDismiss>
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
            <DialogDismiss className="pr-secondary">Keep playing</DialogDismiss>
            {online && (
              <button className="pr-primary" onClick={online.leave}>
                Leave room
              </button>
            )}
          </div>
        </Dialog>
      )}
      {wild && (
        <Dialog title="Choose a color" onClose={() => setWildCard(null)} className="pr-wild-dialog">
          <div className="pr-wild-preview">
            <CardFace card={wild} />
          </div>
          <p className="pr-eyebrow">CHANGE THE CONVERSATION</p>
          <h2>Choose a color.</h2>
          <p className="pr-dialog-copy">
            {wild.value === 'draw4'
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
                  send({ type: 'play', player: viewer, cardId: wild.id, color })
                  setWildCard(null)
                }}
              >
                <span>{TOKENS[COLORS.indexOf(color)]}</span>
                {color}
              </button>
            ))}
          </div>
          <DialogDismiss className="pr-text-button">Back to my hand</DialogDismiss>
        </Dialog>
      )}
      {showResult && (
        <Dialog title="Round result" onClose={() => {}} locked className="pr-result">
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
                  {p.hand.length}{' '}
                  {/* Online a hand stays face-down to the end, so only this seat's
                      own leftovers can honestly be counted up. */}
                  {(!online || p.id === viewer) && <small>/ {leftovers(p)}</small>}
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
          ) : null}
        </Dialog>
      )}
    </div>
  )
}
