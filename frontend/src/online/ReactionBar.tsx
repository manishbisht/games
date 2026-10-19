import { useEffect, useRef, useState } from 'react'
import { REACTION_LIMITS, REACTIONS } from '@games/shared/protocol'
import type { ReactionId } from '@games/shared/protocol'
import './reactions.css'

type Limit = { burst: number; refillMs: number }

/**
 * Take one reaction's worth from the allowance: what is left after it, or null
 * when there was not a whole one to take. The same refilling bucket the room keeps.
 */
function spend(bucket: { current: { tokens: number; at: number } | null }, limit: Limit): number | null {
  const now = performance.now()
  const current = bucket.current ?? { tokens: limit.burst, at: now }
  const tokens = Math.min(limit.burst, current.tokens + (now - current.at) / limit.refillMs)
  if (tokens < 1) return null
  bucket.current = { tokens: tokens - 1, at: now }
  return tokens - 1
}

/**
 * A row of quick reactions, for a game to place wherever its table has room
 * (`<ReactionBar onReact={api.react} watching={you.seat === null} />`). It
 * keeps to the same allowance the room enforces (`REACTION_LIMITS`), so a
 * reaction the server would drop is never sent: past the allowance the row
 * dims for a moment instead of a press silently doing nothing.
 *
 * Unstyled beyond the shared look; `className` lets a game nudge it into place.
 */
export default function ReactionBar({
  onReact,
  watching = false,
  className = '',
}: {
  onReact?: (reaction: ReactionId) => void
  watching?: boolean
  className?: string
}) {
  const limit = watching ? REACTION_LIMITS.watching : REACTION_LIMITS.seated
  const bucket = useRef<{ tokens: number; at: number } | null>(null)
  const [resting, setResting] = useState(false)
  const [sent, setSent] = useState<{ id: ReactionId; n: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  const press = (id: ReactionId) => {
    if (!onReact) return
    const left = spend(bucket, limit)
    if (left === null) return
    onReact(id)
    setSent((last) => ({ id, n: (last?.n ?? 0) + 1 }))
    if (left < 1) {
      setResting(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setResting(false), (1 - left) * limit.refillMs)
    }
  }

  return (
    <div
      className={`reaction-bar${resting ? ' reaction-bar-resting' : ''} ${className}`}
      role="group"
      aria-label="Send a reaction"
    >
      {REACTIONS.map(({ id, emoji, label }) => (
        <button
          key={id}
          type="button"
          className="reaction-bar-button"
          onClick={() => press(id)}
          disabled={!onReact}
          aria-disabled={resting || undefined}
          aria-label={label}
          title={label}
        >
          {/* Keyed by each send, so every press replays the pop. */}
          <span
            key={sent?.id === id ? sent.n : 0}
            className={sent?.id === id ? 'reaction-bar-pop' : undefined}
          >
            {emoji}
          </span>
        </button>
      ))}
    </div>
  )
}
