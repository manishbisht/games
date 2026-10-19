import { useEffect, useRef, useState } from 'react'
import { Check, Link2 } from 'lucide-react'
import type { Color, GameState } from '@games/shared/chess/types'
import { COLOR_NAMES, GLYPHS } from '@games/shared/chess/types'
import type { ReplayFrame } from '@games/shared/protocol'
import type { ReplayViewProps } from '../../../online/games'
import { replayHoldMs } from '../../../online/replayTiming'
import { useSound } from '../../../motion/sound'
import { playChessSound } from '../game/audio'
import { permalinkUrl } from '../game/permalink'
import { storedPreferences } from '../game/preferences'
import { createScene } from '../scene/createScene'
import type { SceneApi, SceneState } from '../scene/createScene'
import './ChessReplay.css'

const COPIED_MS = 2000,
  /** A move is played within this share of the time its state stays on screen, so it is seen to land. */
  FIT = 0.85

const ENDINGS: Record<string, string> = {
  checkmate: 'Checkmate',
  stalemate: 'Stalemate',
  repetition: 'Draw by repetition',
  'fifty-move': 'Draw by the fifty-move rule',
  insufficient: 'Draw, not enough to mate',
  resigned: 'Resignation',
  timeout: 'Out of time',
  agreement: 'Draw by agreement',
}

/** "12. Nf3" for White's twelfth move, "12… Nc6" for Black's. */
function moveLabel(game: GameState): string | null {
  const last = game.history.at(-1)
  if (!last) return null
  return `${Math.ceil(game.history.length / 2)}${last.color === 'w' ? '.' : '…'} ${last.san}`
}

/**
 * A finished game, played again on the real board. The page owns the clock;
 * this turns its playhead into the table's own presentation: the next state,
 * while playing, is told as the live board tells a move — the slide or the
 * knight's hop, the capture knocked over and carried to its tray, check, the
 * king going down — sped up to fit the time that state is on screen; anything
 * else (a scrub, a step, a jump) sets the position down at once.
 */
export default function ChessReplayView({
  states,
  index,
  playing,
  speed,
  players,
  onReady,
}: ReplayViewProps) {
  const frames = states as ReplayFrame<GameState>[]
  const container = useRef<HTMLDivElement>(null),
    api = useRef<SceneApi | null>(null),
    shown = useRef(index),
    playedInto = useRef(playing),
    initial = useRef({ game: frames[index].state, onReady })
  const [failed, setFailed] = useState(false),
    [presenting, setPresenting] = useState(false),
    [copied, setCopied] = useState(false),
    [soundOn] = useSound('chess', true)
  const live = useRef({ playing, soundOn })
  useEffect(() => {
    live.current = { playing, soundOn }
  }, [playing, soundOn])

  useEffect(() => {
    if (!container.current) return
    const start = initial.current
    const scene: SceneState = {
      game: start.game,
      selected: null,
      legal: [],
      focused: null,
      enabled: false,
      preferences: storedPreferences(),
    }
    try {
      api.current = createScene(
        container.current,
        scene,
        { black: false },
        {
          select: () => {},
          // Heard only while it plays: a scrub sets the board down silently.
          impact: (kind, detail) => {
            if (live.current.playing && live.current.soundOn) playChessSound(kind, detail)
          },
          presenting: setPresenting,
          ready: () => start.onReady?.(),
        },
      )
    } catch (error) {
      console.error('Chess WebGL initialization failed', error)
      // Whether WebGL works is only learned by trying, which takes the container this effect is given.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFailed(true)
      start.onReady?.()
    }
    return () => {
      api.current?.dispose()
      api.current = null
    }
  }, [])

  useEffect(() => {
    const scene = api.current,
      previous = shown.current,
      // The page stops playing in the same render that reaches the last state; that move is still played.
      wasPlaying = playedInto.current
    playedInto.current = playing
    if (!scene || previous === index) return
    shown.current = index
    const game = frames[index].state
    if ((playing || wasPlaying) && index === previous + 1)
      scene.play(game, { rate: speed, withinMs: replayHoldMs(states, index, speed) * FIT })
    else scene.land(game)
  }, [frames, states, index, playing, speed])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), COPIED_MS)
    return () => clearTimeout(timer)
  }, [copied])

  const game = frames[index].state,
    final = frames.at(-1)!.state
  const name = (color: Color) => players.find((p) => p.seat === color)?.name ?? COLOR_NAMES[color]
  const last = game.history.at(-1)
  // The result waits for the board to play it out, as it does at the table.
  const over = game.status !== 'playing' && !presenting
  const result = over
    ? `${ENDINGS[game.status] ?? 'Game over'} · ${game.winner ? `${name(game.winner)} wins` : 'drawn'}`
    : null
  const names = { w: name('w'), b: name('b') }

  return (
    <div className="ch-replay" data-moves={game.history.length} data-presenting={presenting || undefined}>
      <div
        className="ch-replay-board"
        role="img"
        aria-label={`Chessboard after ${moveLabel(game) ?? 'the start'}`}
      >
        <div className="ch-canvas" ref={container} />
        {failed && <StaticBoard game={game} />}
      </div>
      <div className="ch-replay-caption" aria-live="polite">
        <span className="ch-replay-move">
          {last ? (
            <>
              <span aria-hidden="true">{GLYPHS[last.color][last.piece]}</span> {moveLabel(game)}
              <small>{name(last.color)}</small>
            </>
          ) : (
            'The opening position'
          )}
        </span>
        {result && <strong className="ch-replay-result">{result}</strong>}
      </div>
      <button
        type="button"
        className="ch-replay-permalink"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(permalinkUrl(final, names))
            setCopied(true)
          } catch {
            setCopied(false)
          }
        }}
      >
        {copied ? <Check size={14} aria-hidden="true" /> : <Link2 size={14} aria-hidden="true" />}
        {copied ? 'Copied!' : 'Copy permanent link'}
      </button>
    </div>
  )
}

/** Without WebGL, the position as a plain grid of glyphs: nothing to play, just where everything stands. */
function StaticBoard({ game }: { game: GameState }) {
  return (
    <div className="ch-fallback">
      <p>3D is unavailable. Here is the position.</p>
      <div className="ch-fallback-grid" aria-hidden="true">
        {Array.from({ length: 64 }, (_, i) => {
          const square = `${String.fromCharCode(97 + (i % 8))}${8 - Math.floor(i / 8)}`,
            piece = game.pieces.find((p) => p.square === square)
          return (
            <span key={square} className={(i + Math.floor(i / 8)) % 2 ? 'dark' : ''}>
              {piece ? GLYPHS[piece.color][piece.type] : ''}
            </span>
          )
        })}
      </div>
    </div>
  )
}
