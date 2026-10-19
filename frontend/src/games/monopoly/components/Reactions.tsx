import { useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { REACTIONS } from '@games/shared/protocol'
import type { TableReaction } from '../online/session'
import './Reactions.css'

/** How long one reaction stays up. Matches `estate-reaction-rise` in Reactions.css. */
const FLOAT_MS = 2400

/** A point on screen, in viewport pixels. */
export interface ScreenPoint {
  x: number
  y: number
}

/** A stable sway for one reaction, from its id, so a re-render never moves it. */
function jitter(id: string) {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return ((hash >>> 0) % 1000) / 1000 - 0.5
}

/**
 * Reactions at the table, each rising from whoever sent it: `anchor` says where
 * that is right now — their token on the board, their card at the table, or a
 * neutral spot for someone watching — and the bubble is pinned there the moment
 * it arrives, then springs up and fades. Only what arrived while the table was
 * up (or just before) is told; the rest of the room's short list stays history.
 *
 * Announced politely for screen readers, as "Ann: Wow".
 */
export default function TableReactions({
  reactions,
  nameOf,
  colorOf,
  anchor,
  onArrive,
}: {
  reactions: readonly TableReaction[]
  nameOf: (player: number | null) => string
  colorOf: (player: number | null) => string | undefined
  anchor: (player: number | null) => ScreenPoint
  /** A fresh one has landed at `at` — for its sound. */
  onArrive: (at: ScreenPoint) => void
}) {
  const [since] = useState(() => performance.now() - FLOAT_MS)
  const live = reactions.filter((entry) => entry.receivedAt > since)
  return (
    <div className="table-reactions" aria-live="polite">
      {live.map((entry) => {
        const meta = REACTIONS.find((reaction) => reaction.id === entry.reaction)
        return (
          meta && (
            <Bubble
              key={entry.id}
              entry={entry}
              emoji={meta.emoji}
              label={`${nameOf(entry.player)}: ${meta.label}`}
              name={nameOf(entry.player)}
              color={colorOf(entry.player)}
              anchor={anchor}
              onArrive={onArrive}
            />
          )
        )
      })}
    </div>
  )
}

function Bubble({
  entry,
  emoji,
  label,
  name,
  color,
  anchor,
  onArrive,
}: {
  entry: TableReaction
  emoji: string
  label: string
  name: string
  color?: string
  anchor: (player: number | null) => ScreenPoint
  onArrive: (at: ScreenPoint) => void
}) {
  const ref = useRef<HTMLDivElement>(null),
    placed = useRef(false)
  // Pinned once, where the sender was when it arrived: a bubble that chased a
  // walking token would read as the token's, not the player's.
  useLayoutEffect(() => {
    const bubble = ref.current
    if (!bubble || placed.current) return
    placed.current = true
    const at = anchor(entry.player)
    bubble.style.left = `${at.x}px`
    bubble.style.top = `${at.y}px`
    bubble.style.bottom = 'auto'
    if (performance.now() - entry.receivedAt < 1000) onArrive(at)
  }, [anchor, entry, onArrive])
  const style = { '--jitter': jitter(entry.id), '--player-color': color } as CSSProperties
  return (
    <div ref={ref} className={`table-reaction${entry.player === null ? ' watching' : ''}`} style={style}>
      <span className="table-reaction-emoji" aria-hidden="true">
        {emoji}
      </span>
      <span className="table-reaction-name" aria-hidden="true">
        <i />
        {name}
      </span>
      <span className="sr-only">{label}</span>
    </div>
  )
}
