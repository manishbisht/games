import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { Link } from 'react-router'
import { Infinity as Forever, Pause, Play, StepBack, StepForward } from 'lucide-react'
import { useReducedMotion } from '../../../motion/preference'
import { formatClock, REPLAY_SPEEDS, replayHoldMs, turnMarks } from '../../../online/replayTiming'
import ChessShell from '../ChessShell'
import { readPermalink } from '../game/permalink'
import ChessReplayView from './ChessReplayView'
import '../../../online/replay.css'
import './ChessReplay.css'

/** How long playback waits for a board that never says it is ready before starting anyway. */
const READY_GRACE_MS = 2500

/**
 * A game played back from its permanent link (`./game/permalink`): the moves
 * ride in the address, so this needs no room and never expires. Same board,
 * same player bar and keys as a room's replay page — kept to what a link with
 * no room behind it can offer.
 */
export default function ChessPermalinkReplay({ search }: { search: URLSearchParams }) {
  const replay = useMemo(() => readPermalink(search), [search])
  if (!replay)
    return (
      <ChessShell>
        <main className="ch-permalink-notice">
          <h1>That link looks wrong.</h1>
          <p>It doesn’t describe a game of chess that could have been played.</p>
          <Link to="/chess">Back to Gambit</Link>
        </main>
      </ChessShell>
    )
  return <Player key={search.toString()} replay={replay} />
}

function Player({ replay }: { replay: NonNullable<ReturnType<typeof readPermalink>> }) {
  const { states, players } = replay
  const last = states.length - 1
  const reduced = useReducedMotion()
  const [index, setIndex] = useState(0),
    [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState<number>(1),
    [ready, setReady] = useState(false),
    [started, setStarted] = useState(false)

  // Starts by itself once the board is up — never under reduced motion, where nothing moves until asked.
  useEffect(() => {
    if (started || reduced) return
    const begin = () => {
      setStarted(true)
      setPlaying(true)
    }
    if (ready) return begin()
    const timer = setTimeout(begin, READY_GRACE_MS)
    return () => clearTimeout(timer)
  }, [ready, reduced, started])

  useEffect(() => {
    if (!playing) return
    const timer = setTimeout(
      () => {
        const next = Math.min(last, index + 1)
        setIndex(next)
        if (next >= last) setPlaying(false)
      },
      replayHoldMs(states, index, speed),
    )
    return () => clearTimeout(timer)
  }, [playing, index, speed, states, last])

  const go = (next: number) => {
    setStarted(true)
    setPlaying(false)
    setIndex(Math.max(0, Math.min(last, next)))
  }
  const toggle = () => {
    setStarted(true)
    if (playing) return setPlaying(false)
    if (index >= last) setIndex(0)
    setPlaying(true)
  }

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

  const marks = useMemo(() => turnMarks(states, (state) => (state as { turn: string }).turn), [states])
  const elapsed = states[index].at - states[0].at,
    total = states[last].at - states[0].at
  // Past a few hundred, marks closer than a pixel or so are one smudge; thin them.
  const every = Math.max(1, Math.ceil(marks.length / 240))
  const path = marks
    .filter((_, n) => n % every === 0)
    .map((mark) => `M${((mark / last) * 1000).toFixed(1)} 0V10`)
    .join('')
  const onScrubKey = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
    event.preventDefault()
    const step = event.key === 'ArrowLeft' || event.key === 'ArrowDown' ? -1 : 1
    go(event.key === 'Home' ? 0 : event.key === 'End' ? last : index + step)
  }

  return (
    <ChessShell>
      <main className="replay" data-playing={playing || undefined}>
        <header className="replay-head">
          <div>
            <p className="replay-eyebrow">Replay · Permanent link</p>
            <h1>
              {players[0].name} vs {players[1].name}
            </h1>
          </div>
        </header>

        <section className="replay-stage" aria-label="Replay">
          <ChessReplayView
            states={states}
            index={index}
            playing={playing}
            speed={speed}
            players={players}
            onReady={() => setReady(true)}
          />
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
              aria-label={playing ? 'Pause' : index >= last ? 'Play again' : 'Play'}
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
          <div className="replay-scrubber" style={{ '--progress': index / last } as CSSProperties}>
            <svg viewBox="0 0 1000 10" preserveAspectRatio="none" aria-hidden="true">
              <path d={path} />
            </svg>
            <input
              type="range"
              min={0}
              max={last}
              step={1}
              value={index}
              aria-label="Replay position"
              aria-valuetext={`Moment ${index + 1} of ${states.length}, ${formatClock(elapsed)} in`}
              onChange={(event) => go(Number(event.target.value))}
              onKeyDown={onScrubKey}
            />
          </div>
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

        <p className="replay-expiry">
          <Forever size={13} aria-hidden="true" />
          <span>This link carries the moves themselves, so it never expires.</span>
        </p>
        <p className="replay-keys" aria-hidden="true">
          <kbd>Space</kbd> play/pause · <kbd>←</kbd>
          <kbd>→</kbd> step · <kbd>Home</kbd>
          <kbd>End</kbd> jump
        </p>
        <Link className="replay-back" to="/chess">
          Back to Gambit
        </Link>
      </main>
    </ChessShell>
  )
}
