import { useEffect, useState } from 'react'
import { Flag } from 'lucide-react'
import { clockStarted } from '@games/shared/chess'
import { COLOR_NAMES, LOW_TIME_MS } from '@games/shared/chess/types'
import type { Color, GameState } from '@games/shared/chess/types'
import { clockFace, remaining } from './clock'
import type { HeldTiming } from './clock'

/**
 * One side's clock. It counts by the server's clock carried forward from the
 * last snapshot, so a browser that joins or reconnects mid-turn shows the time
 * actually left rather than restarting the count. The server decides the flag;
 * a face that reaches 0:00 first simply waits there for it.
 *
 * Under twenty seconds it reads as low and breathes; in the last ten, the
 * player whose clock it is hears each second go.
 */
export default function ChessClock({
  color,
  game,
  timing,
  mine,
  onTick,
}: {
  color: Color
  game: GameState
  timing: HeldTiming | undefined
  /** This browser's own clock: the one whose last seconds are heard. */
  mine: boolean
  onTick?: () => void
}) {
  const running = game.status === 'playing' && game.turn === color && clockStarted(game)
  const [left, setLeft] = useState(() => remaining(game, color, timing))
  // A new snapshot is a new reading; between them, the face runs on its own.
  const [reading, setReading] = useState({ game, timing })
  if (reading.game !== game || reading.timing !== timing) {
    setReading({ game, timing })
    setLeft(remaining(game, color, timing))
  }

  useEffect(() => {
    if (!running) return
    let frame = 0,
      second = Math.ceil(remaining(game, color, timing) / 1000)
    const step = () => {
      const now = remaining(game, color, timing)
      // Only a change the face can show is worth a render: a tenth in the last ten seconds, a second before.
      setLeft((shown) => (clockFace(shown) === clockFace(now) ? shown : now))
      const next = Math.ceil(now / 1000)
      if (next < second && next < 10 && next >= 1 && mine) onTick?.()
      second = next
      if (now > 0) frame = requestAnimationFrame(step)
    }
    frame = requestAnimationFrame(step)
    return () => cancelAnimationFrame(frame)
  }, [running, game, color, timing, mine, onTick])

  if (!game.options.clock)
    return (
      <div className="ch-clock" aria-label={`${COLOR_NAMES[color]} clock: no time limit`}>
        {running && <i />}
        <span className="ch-untimed">— : —</span>
      </div>
    )
  const flagged = game.status === 'timeout' && game.turn === color,
    low = !flagged && left < LOW_TIME_MS && game.status === 'playing'
  const face = flagged ? '0:00' : clockFace(left)
  return (
    <div
      className={`ch-clock ch-timed ${running ? 'ch-clock-running' : ''} ${low ? 'ch-clock-low' : ''} ${flagged ? 'ch-clock-flag' : ''}`}
      role="timer"
      aria-label={`${COLOR_NAMES[color]} clock: ${flagged ? 'out of time' : clockFace(Math.ceil(left / 1000) * 1000)}`}
    >
      {flagged ? <Flag size={14} aria-hidden="true" /> : running && <i />}
      <span aria-hidden="true">{face}</span>
    </div>
  )
}
