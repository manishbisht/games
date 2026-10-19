import { useLayoutEffect, useRef, useState } from 'react'
import { Smile } from 'lucide-react'
import { REACTIONS } from '@games/shared/protocol'
import type { ReactionId } from '@games/shared/protocol'
import ReactionBar from '../../../online/ReactionBar'
import { sounds } from '../../../motion/audio'
import type { TableReaction } from '../online/session'

/** How long one bubble is up. Matches `pr-reaction-rise` in PrismGame.css. */
const FLOAT_MS = 2400

/** Where a player's reactions rise from, in client pixels; `null` is someone watching. */
export type ReactionAnchor = (player: number | null) => { x: number; y: number } | null

/**
 * The table's reaction bar. Where the toolbar has room it is simply there; on a
 * narrow screen it folds behind one button and opens above it, closing again
 * once a reaction is sent or on Escape.
 */
export function ReactionControl({
  onReact,
  watching,
}: {
  onReact?: (reaction: ReactionId) => void
  watching: boolean
}) {
  const [open, setOpen] = useState(false),
    toggle = useRef<HTMLButtonElement>(null)
  return (
    <div
      className={`pr-react ${open ? 'pr-react-open' : ''}`}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return
        setOpen(false)
        toggle.current?.focus()
      }}
    >
      <button
        ref={toggle}
        className="pr-icon pr-react-toggle"
        aria-label="Reactions"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Smile size={18} />
      </button>
      <ReactionBar
        className="pr-react-bar"
        watching={watching}
        onReact={
          onReact &&
          ((reaction) => {
            onReact(reaction)
            setOpen(false)
          })
        }
      />
    </div>
  )
}

/**
 * Reactions as they arrive, each a bubble that springs up from the seat it came
 * from and fades as it drifts higher. Only those that arrived while the table
 * was up: one mounted later must not replay what has already been and gone.
 * Each is left faded out until it falls off the room's short list.
 */
export function SeatReactions({
  reactions,
  anchor,
  nameOf,
  muted,
}: {
  reactions: TableReaction[]
  anchor: ReactionAnchor
  nameOf: (player: number | null) => string
  muted: boolean
}) {
  const [since] = useState(() => performance.now() - FLOAT_MS)
  return (
    <div className="pr-reactions" aria-live="polite">
      {reactions
        .filter((entry) => entry.receivedAt > since)
        .map((entry) => (
          <Bubble key={entry.id} entry={entry} anchor={anchor} name={nameOf(entry.player)} muted={muted} />
        ))}
    </div>
  )
}

function Bubble({
  entry,
  anchor,
  name,
  muted,
}: {
  entry: TableReaction
  anchor: ReactionAnchor
  name: string
  muted: boolean
}) {
  const element = useRef<HTMLDivElement>(null),
    latest = useRef({ anchor, muted })
  useLayoutEffect(() => {
    latest.current = { anchor, muted }
  })
  // Placed once, where the seat is when it arrives, so a re-render never moves
  // it mid-flight — and heard once, with a soft pop panned toward that seat.
  useLayoutEffect(() => {
    const bubble = element.current
    if (!bubble?.parentElement) return
    const layer = bubble.parentElement.getBoundingClientRect(),
      at = latest.current.anchor(entry.player)
    if (at) {
      const x = Math.min(Math.max(at.x - layer.left, 34), layer.width - 34)
      bubble.style.left = `${x}px`
      bubble.style.top = `${Math.max(at.y - layer.top, 64)}px`
    }
    const pan = at ? Math.max(-1, Math.min(1, (at.x / window.innerWidth) * 2 - 1)) * 0.6 : 0
    if (!latest.current.muted) sounds.pop(1.25, 0.55, pan)
  }, [entry.player])
  const meta = REACTIONS.find((reaction) => reaction.id === entry.reaction)
  if (!meta) return null
  return (
    <div
      ref={element}
      className={`pr-reaction ${entry.player === null ? 'pr-reaction-watching' : ''}`}
      data-player={entry.player ?? 'watching'}
    >
      <span className="pr-reaction-emoji" aria-hidden="true">
        {meta.emoji}
      </span>
      <span className="pr-reaction-name">
        <span className="sr-only">{`${name}: ${meta.label}`}</span>
        <span aria-hidden="true">{name}</span>
      </span>
    </div>
  )
}
