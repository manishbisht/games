import ThemeControl from '../../theme/ThemeControl'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { PlayersOnlineBadge } from '../../online/playersOnline'
import { HeaderAuth } from '../../online/identity'
import { Link } from 'react-router'
import {
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Bot,
  Check,
  CircleHelp,
  Dices,
  Flag,
  Leaf,
  Maximize2,
  RotateCcw,
  RotateCw,
  Sparkles,
  Trophy,
  Users,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { useBotRoom } from '../../online/useBotRoom'
import { wildriseGame } from '../catalog'
import Setup from './components/Setup'
import type { SetupOptions } from './components/Setup'
import Dialog from './components/Dialog'
import TokenPortrait from './components/TokenPortrait'
import { PALETTES, PLAYER_IDS } from '@games/shared/wildrise/board'
import { createGame } from '@games/shared/wildrise'
import { companionNames } from '@games/shared/wildrise/online'
import { CLAIM_WIN_AFTER_MS } from '@games/shared/protocol'
import { sound } from './game/audio'
import type { Cue } from './game/audio'
import type { GameConfig, GameState, Player } from '@games/shared/wildrise/types'
import { useCountUp, useHeld } from '../../motion/hooks'
import BoardScene from './scene/BoardScene'
import type { BoardControls } from './scene/BoardScene'
import type { Squares } from './scene/story'
import { claimTarget } from './online/session'
import type { OnlineWildriseSession } from './online/session'
import './WildriseGame.css'

function toConfig(options: SetupOptions): GameConfig {
  return {
    playerCount: options.count,
    names: ['You', ...companionNames(3)],
    controls: PLAYER_IDS.slice(0, options.count).map((_, i) => (i > 0 ? options.style : 'human')),
    rules: { exactFinish: options.exact },
  }
}

function DieFace({ value }: { value: number | null }) {
  const active =
    value === 1
      ? [4]
      : value === 2
        ? [0, 8]
        : value === 3
          ? [0, 4, 8]
          : value === 4
            ? [0, 2, 6, 8]
            : value === 5
              ? [0, 2, 4, 6, 8]
              : [0, 2, 3, 5, 6, 8]
  return (
    <span className="wr-die-face" aria-hidden="true">
      {Array.from({ length: 9 }, (_, i) => (
        <i key={i} className={value !== null && active.includes(i) ? 'filled' : ''} />
      ))}
    </span>
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
    <div className="wr-abandon" role="status">
      {remaining > 0 ? (
        <span>
          {name} stepped away — the table can carry on without them in {Math.floor(seconds / 60)}:
          {String(seconds % 60).padStart(2, '0')}.
        </span>
      ) : (
        <>
          <span>{name} seems to be gone.</span>
          <button onClick={onClaim}>Carry on without them</button>
        </>
      )}
    </div>
  )
}

/** A number that counts on screen instead of jumping: a square, a stat. */
function Count({ value }: { value: number }) {
  return <>{useCountUp(value)}</>
}

/**
 * One seat around the table. Its square is the one the board is showing, not
 * the one the server last wrote down, so the number climbs hop by hop with the
 * token and only jumps a ladder when the token does.
 */
function PlayerCard({
  player,
  square,
  active,
  winner,
  online,
}: {
  player: Player
  square: number
  active: boolean
  winner: boolean
  online?: OnlineWildriseSession
}) {
  const shown = useCountUp(square, 520)
  return (
    <div
      className={`wr-player ${active ? 'wr-player-active' : ''}`}
      data-testid={`wildrise-player-${player.id}`}
      style={
        {
          '--player-color': PALETTES[player.id].color,
          '--player-pale': PALETTES[player.id].pale,
        } as CSSProperties
      }
    >
      <TokenPortrait id={player.id} />
      <div className="wr-player-info">
        <strong>
          {player.name} {(player.control !== 'human' || online?.players[player.id]?.bot) && <Bot size={12} />}
          {online?.mySeat === player.id && <span className="wr-seat-badge">YOU</span>}
          {online?.players[player.id]?.connected === false && (
            <span className="wr-seat-badge wr-away-badge">AWAY</span>
          )}
          {/* Away and claimed: the room is rolling for them now. */}
          {online?.players[player.id]?.abandoned && <span className="wr-seat-badge">AUTO</span>}
        </strong>
        <span>
          {active
            ? winner
              ? 'The trailblazer'
              : 'Taking a turn'
            : PALETTES[player.id].animal + ' miniature'}
        </span>
      </div>
      <div className="wr-position">
        <strong>{shown === 0 ? '—' : shown}</strong>
        <small>{shown === 0 ? 'at camp' : 'of 100'}</small>
      </div>
      <div className="wr-progress">
        <i style={{ transform: `scaleX(${shown / 100})` }} />
      </div>
    </div>
  )
}

/** What the roll panel's heading says about the beat the table is in. */
function rollHeading(game: GameState, myTurn: boolean) {
  const current = game.players[game.currentPlayer]
  switch (game.phase) {
    case 'won':
      return 'Made it to the top.'
    case 'rolling':
      return 'Here goes…'
    case 'ready':
      return myTurn ? 'Your move, explorer.' : `Over to ${current.name}.`
    case 'moving':
      return `A ${game.dice}. Let’s go.`
    case 'transporting':
      return game.motion?.kind === 'ladder' ? 'Up, up & away.' : 'Enjoy the slide.'
    case 'settling':
      // Settling follows a landing, or a roll that went nowhere: say which.
      return game.events[0]?.kind === 'wait' && game.events[0].turn === game.turn
        ? `A ${game.dice}. Not this time.`
        : `Settled on ${current.position}.`
  }
}

function Table({
  config,
  options,
  onOptions,
  onStart,
  startDisabled = false,
  soundOn,
  setSoundOn,
  online,
}: {
  config: GameConfig
  options: SetupOptions
  onOptions: (o: SetupOptions) => void
  onStart: () => void
  /** True while the identity is still settling: starting would do nothing. */
  startDisabled?: boolean
  soundOn: boolean
  setSoundOn: (on: boolean) => void
  online?: OnlineWildriseSession
}) {
  // The board shown behind the setup panel. It is never played: choosing a
  // table creates a room, and the room deals the real one.
  const preview = useMemo(() => createGame(config), [config])
  // The room is the only source of a live table — there is no local game left
  // to be the other half of this.
  const menu = !online
  const game = online ? online.state : preview
  const [dialog, setDialog] = useState<'rules' | null>(null)
  const [dismissedVictory, setDismissedVictory] = useState(false)
  const [hidden, setHidden] = useState(document.hidden)
  const [shown, setShown] = useState<Squares | null>(null)
  const board = useRef<BoardControls>(null)
  const current = game.players[game.currentPlayer]
  /** Whose inputs this browser may make: only ever its own seat. */
  const myTurn = Boolean(online) && online!.mySeat === current.id
  // The room keeps the table moving whatever this browser is doing, so a
  // dialog only stops this browser asking for a roll — never the board.
  const canRoll = !menu && !dialog && !hidden && game.phase === 'ready' && myTurn
  // The player the table is stuck on, while there is still something to ask for.
  const awayBlocking = online ? claimTarget(online) : null
  // Online every fresh game shows its own result — a rematch arrives as a new
  // state rather than through the local restart that would have cleared this.
  const [wasWon, setWasWon] = useState(game.phase === 'won')
  if (online && wasWon !== (game.phase === 'won')) {
    setWasWon(game.phase === 'won')
    if (game.phase !== 'won') setDismissedVictory(false)
  }
  // The banner keeps its last words while it fades out.
  const [banner, setBanner] = useState(game.motion)
  if (game.phase === 'transporting' && game.motion && banner !== game.motion) setBanner(game.motion)
  useEffect(() => {
    const visibility = () => setHidden(document.hidden)
    document.addEventListener('visibilitychange', visibility)
    return () => document.removeEventListener('visibilitychange', visibility)
  }, [])
  const doRoll = useCallback(() => {
    if (!canRoll) return
    // The die is the server's to throw, so this only ever asks for one — and
    // rattles it in the hand until the number comes back.
    board.current?.rolling()
    online?.send.roll()
  }, [canRoll, online])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        event.code !== 'Space' ||
        event.repeat ||
        (event.target instanceof HTMLElement && event.target.closest('input,select,textarea,button,a,dialog'))
      )
        return
      if (canRoll) {
        event.preventDefault()
        doRoll()
      }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [canRoll, doRoll])
  // Sound is cued by the board as each thing happens on screen, so a snapshot
  // that only says someone came or went plays nothing.
  const onCue = useCallback(
    (cue: Cue, n?: number, pan?: number) => {
      if (!menu && soundOn) sound(cue, n, pan)
    },
    [menu, soundOn],
  )
  const onFailure = useCallback(() => setShown(null), [])
  const squareOf = (player: Player) => shown?.[player.id] ?? player.position
  const phaseText =
    game.phase === 'ready'
      ? myTurn
        ? 'Your next adventure is one roll away.'
        : `Waiting for ${current.name} to roll…`
      : game.phase === 'rolling'
        ? 'A little shake. A little luck.'
        : game.phase === 'moving'
          ? `On the move · heading to ${game.motion?.to}`
          : game.phase === 'transporting'
            ? `${game.motion?.kind === 'ladder' ? 'A shortcut to the treetops!' : 'A little tumble. A new beginning.'}`
            : game.phase === 'won'
              ? 'The summit is yours.'
              : game.events[0].message
  const winner = game.players.find((p) => p.id === game.winner)
  // The win dialog waits for the board's celebration rather than covering it.
  const celebrated = useHeld(Boolean(winner), 1800)
  const showVictory = !!winner && celebrated && !dismissedVictory && !dialog
  const statusText = menu
    ? 'THE TABLE IS SET'
    : game.phase === 'won'
      ? 'ADVENTURE COMPLETE'
      : `TURN ${String(game.turn).padStart(2, '0')}`
  // One voice for screen readers: what just happened, and whose turn it is now.
  const announcement = menu
    ? ''
    : `${game.events[0]?.message ?? ''}${
        game.phase === 'ready' ? (myTurn ? ' Your turn to roll.' : ` ${current.name}’s turn.`) : ''
      }`
  return (
    <div className="wr-app">
      <header className="wr-header">
        <div className="wr-header-left">
          <Link to="/" className="wr-back">
            <ArrowLeft size={15} />
            <span>All games</span>
          </Link>
          <span className="wr-header-divider" />
          <span className="wr-brand" aria-hidden="true">
            <span className="wr-brand-mark">
              <Leaf size={24} strokeWidth={1.5} />
            </span>
            wildrise<span className="wr-brand-dot">.</span>
          </span>
        </div>
        <span className="wr-header-note">A LITTLE LUCK. A LONG WAY UP.</span>
        <nav className="wr-header-actions" aria-label="Game controls">
          <PlayersOnlineBadge game="wildrise" className="wr-online-badge" />
          <button className="wr-help" aria-label="How to play" onClick={() => setDialog('rules')}>
            <CircleHelp size={17} />
            <span>How to play</span>
          </button>
          <button
            className="wr-icon-button"
            aria-label={soundOn ? 'Mute sound' : 'Turn sound on'}
            title={soundOn ? 'Mute sound' : 'Turn sound on'}
            onClick={() => setSoundOn(!soundOn)}
          >
            {soundOn ? <Volume2 size={19} /> : <VolumeX size={19} />}
          </button>
          <ThemeControl />
          <HeaderAuth readOnly={Boolean(online)} />
        </nav>
      </header>
      <main className="wr-main">
        <section className="wr-table" aria-label="Woodland game table">
          <div className="wr-table-heading">
            <div>
              <p className="wr-eyebrow">
                <span className="wr-tiny-line" /> THE WOODLAND COLLECTION
              </p>
              <h1>
                {menu ? (
                  <>
                    Take the <em>scenic route.</em>
                  </>
                ) : winner ? (
                  <>
                    {winner.name} <em>wins!</em>
                  </>
                ) : (
                  <>
                    {current.name}’s <em>turn.</em>
                  </>
                )}
              </h1>
              <p className="wr-table-subtitle">
                {menu ? 'Some ups. Some downs. All part of the adventure.' : phaseText}
              </p>
            </div>
            <div className="wr-table-badge">
              <i />
              {statusText}
            </div>
          </div>
          <div className="wr-stage">
            <BoardScene
              ref={board}
              state={game}
              timing={online?.timing}
              running={!hidden}
              canRoll={canRoll}
              onRoll={doRoll}
              onCue={onCue}
              onPositions={setShown}
              onFailure={onFailure}
            />
            {!menu && (
              <div
                className={`wr-transport wr-transport-${banner?.kind}`}
                data-open={game.phase === 'transporting'}
                aria-hidden="true"
              >
                {banner?.kind === 'ladder' ? <ArrowUpRight size={25} /> : <ArrowDownRight size={25} />}
                <div>
                  <strong>{banner?.kind === 'ladder' ? 'CLIMB!' : 'SLIDE!'}</strong>
                  <span>
                    {banner?.from} → {banner?.to}
                  </span>
                </div>
              </div>
            )}
            <div className="wr-camera" aria-label="Camera controls">
              <button onClick={() => board.current?.zoom(-1)} aria-label="Zoom out" title="Zoom out">
                <ZoomOut size={17} />
              </button>
              <button onClick={() => board.current?.zoom(1)} aria-label="Zoom in" title="Zoom in">
                <ZoomIn size={17} />
              </button>
              <i />
              <button onClick={() => board.current?.rotate(-1)} aria-label="Rotate left" title="Rotate left">
                <RotateCcw size={17} />
              </button>
              <button onClick={() => board.current?.rotate(1)} aria-label="Rotate right" title="Rotate right">
                <RotateCw size={17} />
              </button>
              <i />
              <button onClick={() => board.current?.top()} aria-label="Top view" title="Top view">
                <Maximize2 size={16} />
              </button>
              <button onClick={() => board.current?.reset()} aria-label="Reset camera" title="Reset camera">
                <span className="wr-reset-label">Reset</span>
              </button>
            </div>
            <span className="wr-camera-hint">Drag to explore · Scroll or pinch to zoom</span>
          </div>
          <div className="wr-board-footer">
            <span>
              <ArrowUpRight size={15} className="wr-up" /> Find a ladder. Climb higher.
            </span>
            <span>
              <ArrowDownRight size={15} className="wr-down" /> Meet a snake. Slide back.
            </span>
            <span>
              <Flag size={14} /> First to 100 wins.
            </span>
          </div>
        </section>
        <aside className="wr-sidebar">
          {menu ? (
            <Setup options={options} onChange={onOptions} onStart={onStart} disabled={startDisabled} />
          ) : (
            <>
              <section className="wr-players" aria-labelledby="wr-players-title">
                <div className="wr-section-title">
                  <h2 id="wr-players-title">Around the table</h2>
                  <span>
                    <Users size={13} /> {game.players.length} players
                  </span>
                </div>
                <div className="wr-player-list">
                  {game.players.map((player, index) => (
                    <PlayerCard
                      key={player.id}
                      player={player}
                      square={squareOf(player)}
                      active={index === game.currentPlayer}
                      winner={Boolean(winner)}
                      online={online}
                    />
                  ))}
                </div>
              </section>
              <section className="wr-roll-panel" aria-label="Current turn">
                <div className="wr-roll-top">
                  <div>
                    <p className="wr-eyebrow">
                      {game.phase === 'won' ? 'WHAT A JOURNEY' : 'LET THE GOOD TIMES ROLL'}
                    </p>
                    <h2>{rollHeading(game, myTurn)}</h2>
                  </div>
                  {game.phase === 'rolling' ? (
                    <span className="wr-die-shake">
                      <DieFace value={null} />
                    </span>
                  ) : (
                    // Keyed on the roll, so each new number lands with a settle.
                    <span className="wr-die-land" key={`${game.turn}-${game.dice}`}>
                      <DieFace value={game.dice} />
                    </span>
                  )}
                </div>
                <p className="wr-roll-copy">{phaseText}</p>
                <div className="wr-roll-action">
                  <span className="wr-mobile-turn">
                    <strong>{current.name}</strong>
                    <small>
                      {game.phase === 'won'
                        ? 'The trailblazer'
                        : `Turn ${game.turn} · ${squareOf(current) === 0 ? 'At camp' : 'Space ' + squareOf(current)}`}
                    </small>
                  </span>
                  {winner ? (
                    <button className="wr-primary" onClick={() => setDismissedVictory(false)}>
                      <Trophy size={18} /> View results
                    </button>
                  ) : (
                    <button
                      className="wr-primary wr-roll"
                      onClick={doRoll}
                      disabled={!canRoll}
                      aria-label="Roll dice"
                    >
                      <Dices size={21} />
                      {game.phase === 'rolling'
                        ? 'Rolling…'
                        : game.phase === 'moving'
                          ? 'On the move…'
                          : game.phase === 'transporting'
                            ? game.motion?.kind === 'ladder'
                              ? 'Climbing…'
                              : 'Sliding…'
                            : game.phase === 'settling'
                              ? 'Passing the die…'
                              : myTurn
                                ? 'Roll dice'
                                : 'Waiting…'}
                      {canRoll && <kbd>SPACE</kbd>}
                    </button>
                  )}
                </div>
                <p className="wr-roll-hint">
                  {game.rules.exactFinish ? 'An exact roll brings you home.' : 'Reach or pass 100 to finish.'}
                </p>
              </section>
              <section className="wr-events" aria-labelledby="wr-events-title">
                <div className="wr-section-title">
                  <h2 id="wr-events-title">Along the way</h2>
                  <span>THE STORY SO FAR</span>
                </div>
                <ol>
                  {game.events.slice(0, 5).map((event) => (
                    <li key={event.id}>
                      <span className={`wr-event-icon wr-event-${event.kind}`}>
                        {event.kind === 'ladder' ? (
                          <ArrowUpRight size={14} />
                        ) : event.kind === 'snake' ? (
                          <ArrowDownRight size={14} />
                        ) : event.kind === 'win' ? (
                          <Trophy size={14} />
                        ) : event.kind === 'roll' ? (
                          <Dices size={14} />
                        ) : (
                          <Leaf size={14} />
                        )}
                      </span>
                      <p>
                        {event.message}
                        <small>Turn {event.turn}</small>
                      </p>
                    </li>
                  ))}
                </ol>
              </section>
              {online ? (
                // The table belongs to the room: there is nothing here one
                // player could pause or restart on everyone else's behalf.
                <button className="wr-new-game" onClick={online.leave}>
                  <ArrowLeft size={14} /> Leave room
                </button>
              ) : null}
            </>
          )}
        </aside>
      </main>
      <footer className="wr-footer">
        <span>
          <Leaf size={13} /> A fresh take on snakes & ladders.
        </span>
        <span>
          100 SPACES. ENDLESS POSSIBILITIES. <span aria-hidden="true">✦</span>
        </span>
      </footer>
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
      {awayBlocking && (
        <AbandonmentNotice
          name={awayBlocking.name}
          awaySince={awayBlocking.awaySince}
          onClaim={() => online?.send.claim()}
        />
      )}
      <Dialog open={dialog === 'rules'} title="A few simple rules" onClose={() => setDialog(null)}>
        <div className="wr-dialog-emblem">
          <Leaf size={28} />
        </div>
        <p className="wr-eyebrow">THE SCENIC ROUTE TO 100</p>
        <h2>A few simple rules.</h2>
        <p className="wr-description">A familiar favorite. A fresh little adventure.</p>
        <ol className="wr-rules">
          <li>
            <Dices />
            <div>
              <strong>Take a turn. Roll the die.</strong>
              <p>A randomly chosen player starts. Move forward one space for every pip, then pass the die.</p>
            </div>
          </li>
          <li>
            <ArrowUpRight />
            <div>
              <strong>A little help along the way.</strong>
              <p>Land at the bottom of a ladder to climb to its top. Passing over it doesn’t count.</p>
            </div>
          </li>
          <li>
            <ArrowDownRight />
            <div>
              <strong>Every adventure has its tumbles.</strong>
              <p>
                Land on a snake’s head and slide along its body to the tail. The printed arrow shows your
                destination.
              </p>
            </div>
          </li>
          <li>
            <Flag />
            <div>
              <strong>Be the first to reach 100.</strong>
              <p>
                {game.rules.exactFinish
                  ? 'You need an exact roll to finish. Roll too many and stay put until your next turn.'
                  : 'Reach or pass square 100 to win.'}{' '}
                Sharing spaces is allowed; a six does not grant an extra turn.
              </p>
            </div>
          </li>
        </ol>
        <p className="wr-rule-footnote">
          <Check size={15} /> AI companions use the same fair dice as you.
        </p>
        <button className="wr-primary" onClick={() => setDialog(null)}>
          Got it. Let’s play. <ArrowRight size={17} />
        </button>
      </Dialog>
      {winner && (
        <Dialog
          open={showVictory}
          title={`${winner.name} wins!`}
          onClose={() => setDismissedVictory(true)}
          className="wr-victory"
        >
          <span className="wr-victory-spark">
            <Sparkles size={25} />
          </span>
          <TokenPortrait id={winner.id} size={94} />
          <p className="wr-eyebrow">A TRUE TRAILBLAZER</p>
          <h2>{winner.name} wins!</h2>
          <p className="wr-description">
            A few climbs. A few tumbles.
            <br />
            One wonderful way to the top.
          </p>
          <div className="wr-victory-stats">
            <div>
              <strong>
                <Count value={showVictory ? 100 : 0} />
              </strong>
              <span>FINAL POSITION</span>
            </div>
            <div>
              <strong>
                <Count value={showVictory ? winner.turns : 0} />
              </strong>
              <span>TURNS TAKEN</span>
            </div>
            <div>
              <strong>
                <Count value={showVictory ? winner.climbs : 0} />
              </strong>
              <span>LADDERS CLIMBED</span>
            </div>
          </div>
          {online && (
            <>
              <button className="wr-primary" onClick={online.send.rematch} disabled={online.rematch.mine}>
                <RotateCcw size={17} />
                {online.rematch.mine
                  ? 'Waiting for the table…'
                  : online.rematch.theirs
                    ? 'Accept rematch'
                    : 'Rematch'}
              </button>
              <button className="wr-secondary" onClick={online.leave}>
                Leave room <ArrowRight size={16} />
              </button>
            </>
          )}
        </Dialog>
      )}
    </div>
  )
}

/**
 * Wildrise, either as the page you set a table on or as the table itself. There
 * is no third state: choosing a game makes a room and the room deals it, so the
 * setup panel's board is a preview and nothing else.
 */
export default function WildriseGame({ online }: { online?: OnlineWildriseSession }) {
  const [options, setOptions] = useState<SetupOptions>({
    count: 2,
    style: 'casual',
    exact: true,
  })
  const [soundOn, setSoundOn] = useState(true)
  const config = useMemo(() => toConfig(options), [options])
  const room = useBotRoom('wildrise', wildriseGame.path)
  const start = () =>
    void room.start({
      seats: options.count,
      // Every seat but the host's. The three "skills" are pace, which is the
      // only thing there is to vary on a board with one decision in it.
      bots: Array.from({ length: options.count - 1 }, () => options.style),
      options: { exactFinish: options.exact },
    })
  return (
    <Table
      config={config}
      options={options}
      onOptions={setOptions}
      onStart={start}
      startDisabled={room.disabled}
      soundOn={soundOn}
      setSoundOn={setSoundOn}
      online={online}
    />
  )
}
