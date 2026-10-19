import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type { ComponentType, CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import { Link, Navigate, useParams } from 'react-router'
import { normalizeRoomCode } from '@games/shared/protocol/codes'
import type { Replay, ReplayFrame, ReplayPlayer as ReplaySeat } from '@games/shared/protocol'
import { Check, Clapperboard, Clock, Copy, Pause, Play, StepBack, StepForward } from 'lucide-react'
import { BoardSkeleton } from '../RouteSkeleton'
import { useReducedMotion } from '../motion/preference'
import { fetchReplay, ReplayUnavailable } from './api'
import { onlineGame, replayUrl } from './games'
import type { OnlineGame, ReplayViewProps } from './games'
import { RoomFrame } from './RoomPage'
import { expiryLeft, formatClock, REPLAY_SPEEDS, replayHoldMs, turnMarks } from './replayTiming'
import './replay.css'

const COPIED_MS = 2000,
  /** How long playback waits for a view that never says it is ready before starting anyway. */
  READY_GRACE_MS = 2500

type Load =
  | { status: 'loading' }
  /** `at`: when it arrived, by this page's clock — what its time left is counted from. */
  | { status: 'ready'; replay: Replay; at: number }
  | { status: 'failed'; reason: ReplayUnavailable['reason'] }

/**
 * A room's last finished game, played back. The page owns the clock — play,
 * pause, step, scrub, speed, the keys for each — and hands the game's own
 * `ReplayView` the state to show; a game without one yet gets a card saying
 * so, with the timeline still working under it.
 */
export default function ReplayPage({ game }: { game: string }) {
  const { code: raw } = useParams()
  const config = onlineGame(game)
  const code = normalizeRoomCode(raw ?? '')
  const [load, setLoad] = useState<Load>({ status: 'loading' })

  useEffect(() => {
    void config?.preloadReplayView?.()
  }, [config])

  useEffect(() => {
    if (!code) return
    const controller = new AbortController()
    fetchReplay(code, controller.signal).then(
      (replay) => setLoad({ status: 'ready', replay, at: Date.now() }),
      (error: unknown) => {
        if (controller.signal.aborted) return
        setLoad({ status: 'failed', reason: error instanceof ReplayUnavailable ? error.reason : 'failed' })
      },
    )
    return () => controller.abort()
  }, [code])

  if (!config)
    return (
      <Missing title="That link looks wrong.">
        <Link to="/">All games</Link>
      </Missing>
    )
  if (!code) return <Missing title="That link looks wrong." config={config} />
  // A room's code under another game's path: send it to the game it was.
  if (load.status === 'ready' && load.replay.game !== game)
    return <Navigate to={replayUrl(load.replay.game, code)} replace />
  if (load.status === 'failed')
    return load.reason === 'missing' ? (
      <Missing title="This replay isn’t here." config={config}>
        <p>
          A replay is ready once a game finishes, and it lives with its room — 24 hours after the last move,
          both are gone.
        </p>
      </Missing>
    ) : (
      <Missing
        title={load.reason === 'busy' ? 'Too many replays at once.' : 'The replay didn’t load.'}
        config={config}
      >
        <p>
          {load.reason === 'busy' ? 'Give it a minute and try again.' : 'Check your connection and retry.'}
        </p>
        <button type="button" onClick={() => location.reload()}>
          Try again
        </button>
      </Missing>
    )
  if (load.status === 'loading')
    return (
      <RoomFrame config={config} inRoom={false}>
        <div className="replay-loading">
          <BoardSkeleton label="Setting up the replay…" />
        </div>
      </RoomFrame>
    )
  const { replay } = load,
    left = expiryLeft(replay.expiresAt, load.at)
  return (
    <RoomFrame config={config} inRoom={false}>
      <ReplayPlayer
        states={replay.states}
        players={replay.players}
        forfeited={replay.forfeited}
        View={config.ReplayView}
        game={config}
        eyebrow={`Replay · Room ${code}`}
        footnote={
          <>
            <Clock size={13} aria-hidden="true" />
            <span>
              Replays live with their room and are gone 24 hours after its last move
              {left ? ` — this one has ${left} left.` : '.'}
              {replay.truncated ? ' This game ran long, so its opening moments were let go.' : ''}
            </span>
          </>
        }
      />
    </RoomFrame>
  )
}

function Missing({ title, config, children }: { title: string; config?: OnlineGame; children?: ReactNode }) {
  return (
    <RoomFrame config={config} inRoom={false}>
      <main className="ch-room-notice replay-notice">
        <h1>{title}</h1>
        {children}
        {config && <Link to={config.basePath}>Back to {config.name}</Link>}
      </main>
    </RoomFrame>
  )
}

/** "Ann vs Jules", or a list for a bigger table. */
const tableName = (players: ReplaySeat[]) =>
  players.length === 2
    ? `${players[0].name} vs ${players[1].name}`
    : new Intl.ListFormat('en', { type: 'conjunction' }).format(players.map((player) => player.name))

export interface ReplayPlayerProps {
  /** Every state the game passed through, oldest first. */
  states: ReplayFrame[]
  players: ReplaySeat[]
  /** Seats that forfeited, marked in the player list. */
  forfeited?: readonly string[]
  /** The game's replay view; without one, a card says it is coming and the timeline still works. */
  View?: ComponentType<ReplayViewProps>
  /** The game's name, where its page lives, and how to mark its turns on the scrubber. */
  game: Pick<OnlineGame, 'name' | 'basePath' | 'replayTurn'>
  /** Over the title: where this replay comes from ("Replay · Room ABC234"). */
  eyebrow: string
  /** The line under the bar — how long the replay lasts, or that it never expires — with its icon. */
  footnote?: ReactNode
}

/**
 * A finished game, played back: the header, the game's view, the player bar
 * and the keys. It owns the clock — play, pause, step, scrub, speed — and
 * hands the view the state to show. A room's replay page wraps it in the room
 * frame; anything else with a game's states (a permanent link, say) can too.
 *
 * Playback arrives on the final state still playing, so a view animates the
 * last move like any other, and stops once that state's hold has run out.
 */
export function ReplayPlayer({
  states,
  players,
  forfeited,
  View,
  game,
  eyebrow,
  footnote,
}: ReplayPlayerProps) {
  const last = states.length - 1
  const reduced = useReducedMotion()
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<number>(1)
  const [ready, setReady] = useState(!View)
  const [copied, setCopied] = useState(false)
  const started = useRef(false)

  // Under reduced motion nothing moves until it is asked to.
  useEffect(() => {
    if (started.current || reduced) return
    const begin = () => {
      if (started.current) return
      started.current = true
      if (last > 0) setPlaying(true)
    }
    if (ready) {
      begin()
      return
    }
    const timer = setTimeout(begin, READY_GRACE_MS)
    return () => clearTimeout(timer)
  }, [ready, reduced, last])

  // Each state holds for its time, then the next; the last one holds too,
  // and only then does playback stop.
  useEffect(() => {
    if (!playing) return
    const timer = setTimeout(
      () => (index >= last ? setPlaying(false) : setIndex(index + 1)),
      replayHoldMs(states, index, speed),
    )
    return () => clearTimeout(timer)
  }, [playing, index, speed, states, last])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])

  const go = (next: number) => {
    started.current = true
    setPlaying(false)
    setIndex(Math.max(0, Math.min(last, next)))
  }
  const toggle = () => {
    started.current = true
    if (playing) return setPlaying(false)
    if (last === 0) return
    if (index >= last) setIndex(0)
    setPlaying(true)
  }

  // Space, arrows, Home and End work from anywhere on the page — except where
  // the focused control already means something by them.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      const target = event.target as HTMLElement | null
      if (target?.closest('input, select, textarea, [contenteditable="true"]')) return
      if (event.key === ' ' && target?.closest('button, a')) return
      const keys: Record<string, () => void> = {
        ' ': toggle,
        ArrowLeft: () => go(index - 1),
        ArrowRight: () => go(index + 1),
        Home: () => go(0),
        End: () => go(last),
      }
      const run = keys[event.key]
      if (!run) return
      event.preventDefault()
      run()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const marks = useMemo(() => turnMarks(states, game.replayTurn), [states, game.replayTurn])
  const start = states[0]?.at ?? 0
  const elapsed = (states[index]?.at ?? start) - start,
    total = (states[last]?.at ?? start) - start

  return (
    <main className="replay" data-playing={playing || undefined}>
      <header className="replay-head">
        <div>
          <p className="replay-eyebrow">{eyebrow}</p>
          <h1>{tableName(players)}</h1>
          <ul className="replay-players" aria-label="Players">
            {players.map((player) => (
              <li key={player.seat}>
                {player.name}
                {player.bot && <span> · bot</span>}
                {forfeited?.includes(player.seat) && <span> · forfeited</span>}
              </li>
            ))}
          </ul>
        </div>
        <button
          type="button"
          className="replay-copy"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(location.href)
              setCopied(true)
            } catch {
              setCopied(false)
            }
          }}
        >
          {copied ? <Check size={15} aria-hidden="true" /> : <Copy size={15} aria-hidden="true" />}
          {copied ? 'Copied!' : 'Copy link'}
        </button>
      </header>

      <section className="replay-stage" aria-label="Replay">
        {View ? (
          <Suspense fallback={<BoardSkeleton label="Setting up the board…" />}>
            <View
              states={states}
              index={index}
              playing={playing}
              speed={speed}
              players={players}
              onReady={() => setReady(true)}
            />
          </Suspense>
        ) : (
          <div className="replay-soon">
            <Clapperboard size={28} aria-hidden="true" />
            <h2>Replay for {game.name} is coming soon.</h2>
            <p>
              The timeline below already works: it steps through all {states.length} moments of this game.
            </p>
            <p className="replay-soon-frame" aria-live="polite">
              Moment {index + 1} of {states.length}
              {index === last ? ' · the final position' : ''}
            </p>
          </div>
        )}
      </section>

      <div className="replay-bar" role="group" aria-label="Replay controls">
        <div className="replay-buttons">
          <button type="button" onClick={() => go(index - 1)} disabled={index === 0} aria-label="Step back">
            <StepBack size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="replay-play"
            onClick={toggle}
            aria-label={playing ? 'Pause' : index >= last && last > 0 ? 'Play again' : 'Play'}
            disabled={last === 0}
          >
            {playing ? <Pause size={20} aria-hidden="true" /> : <Play size={20} aria-hidden="true" />}
          </button>
          <button
            type="button"
            onClick={() => go(index + 1)}
            disabled={index === last}
            aria-label="Step forward"
          >
            <StepForward size={18} aria-hidden="true" />
          </button>
        </div>
        <Scrubber
          index={index}
          last={last}
          marks={marks}
          label={`Moment ${index + 1} of ${states.length}, ${formatClock(elapsed)} in`}
          onScrub={go}
        />
        <p className="replay-clock" aria-hidden="true">
          <span>
            {index + 1}/{states.length}
          </span>
          <span>
            {formatClock(elapsed)} / {formatClock(total)}
          </span>
        </p>
        <div className="replay-speeds" role="group" aria-label="Playback speed">
          {REPLAY_SPEEDS.map((rate) => (
            <button key={rate} type="button" aria-pressed={speed === rate} onClick={() => setSpeed(rate)}>
              {rate}×
            </button>
          ))}
        </div>
      </div>

      {footnote && <p className="replay-expiry">{footnote}</p>}
      <p className="replay-keys" aria-hidden="true">
        <kbd>Space</kbd> play/pause · <kbd>←</kbd>
        <kbd>→</kbd> step · <kbd>Home</kbd>
        <kbd>End</kbd> jump
      </p>
      <Link className="replay-back" to={game.basePath}>
        Back to {game.name}
      </Link>
    </main>
  )
}

/**
 * A range input over the states, with the turn marks drawn under its track.
 * Arrow keys on it step one state, as they do anywhere else on the page.
 */
function Scrubber({
  index,
  last,
  marks,
  label,
  onScrub,
}: {
  index: number
  last: number
  marks: number[]
  label: string
  onScrub: (index: number) => void
}) {
  // Past a few hundred, marks closer than a pixel or so are one smudge; thin them.
  const every = Math.max(1, Math.ceil(marks.length / 240))
  const path = marks
    .filter((_, n) => n % every === 0)
    .map((mark) => {
      const x = last ? (mark / last) * 1000 : 0
      return `M${x.toFixed(1)} 0V10`
    })
    .join('')
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    // The page's Home/End and arrows already do the right thing; the input's
    // own handling would race them by a frame.
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault()
      const step = event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 1
      onScrub(event.key === 'Home' ? 0 : event.key === 'End' ? last : index + step)
    }
  }
  return (
    <div className="replay-scrubber" style={{ '--progress': last ? index / last : 1 } as CSSProperties}>
      <svg viewBox="0 0 1000 10" preserveAspectRatio="none" aria-hidden="true">
        <path d={path} />
      </svg>
      <input
        type="range"
        min={0}
        max={Math.max(last, 0)}
        step={1}
        value={index}
        aria-label="Replay position"
        aria-valuetext={label}
        onChange={(event) => onScrub(Number(event.target.value))}
        onKeyDown={onKeyDown}
      />
    </div>
  )
}
