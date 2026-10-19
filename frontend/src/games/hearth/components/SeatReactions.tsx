import { useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { PALETTES } from '@games/shared/hearth/board'
import type { PlayerId } from '@games/shared/hearth/types'
import { REACTIONS } from '@games/shared/protocol'
import type { SeatReaction } from '../online/session'

/** How long one reaction stays up. Matches `hh-reaction-rise` in HearthGame.css. */
const FLOAT_MS = 2400

/**
 * Reactions already announced with a sound, so a bubble that mounts twice — React's development double
 * run, a table re-keyed under it — never pops twice.
 */
const heard = new Set<string>()

/** A stable little sway for one reaction, from its id, so two at once from one seat do not overlap. */
function jitter(id: string) {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return ((hash >>> 0) % 1000) / 1000 - 0.5
}

export type Locate = (colour: PlayerId | null) => { x: number; y: number }

function Bubble({
  entry,
  locate,
  onArrive,
}: {
  entry: SeatReaction
  locate: Locate
  onArrive: (entry: SeatReaction, x: number) => void
}) {
  const ref = useRef<HTMLDivElement>(null),
    placed = useRef(false)
  const meta = REACTIONS.find((reaction) => reaction.id === entry.reaction)
  // Placed once, where the seat is at the moment it spoke, before the first paint — the bubble then
  // rises on its own rather than chasing a camera that keeps moving.
  useLayoutEffect(() => {
    if (placed.current) return
    placed.current = true
    const { x, y } = locate(entry.colour)
    ref.current?.style.setProperty('left', `${x}px`)
    ref.current?.style.setProperty('top', `${y}px`)
    ref.current?.setAttribute('data-placed', '')
    if (heard.has(entry.id)) return
    heard.add(entry.id)
    if (heard.size > 64) heard.delete(heard.values().next().value!)
    onArrive(entry, x)
  }, [entry, locate, onArrive])
  if (!meta) return null
  const colour = entry.colour ? PALETTES[entry.colour].color : undefined
  return (
    <div
      ref={ref}
      className={`hh-reaction${entry.colour ? '' : ' hh-reaction-watching'}`}
      style={{ '--seat-color': colour, '--jitter': jitter(entry.id) } as CSSProperties}
    >
      <span className="hh-reaction-emoji" aria-hidden="true">
        {meta.emoji}
      </span>
      <span className="hh-reaction-name">
        <span className="sr-only">{`${entry.name}: ${meta.label}`}</span>
        <span aria-hidden="true">{entry.name}</span>
      </span>
    </div>
  )
}

/**
 * Reactions as the table says them: each one rises from the court of the
 * colour that sent it — or, with the board scrolled away, from that player's
 * card — on a spring, and fades on up. Someone watching has no court, so
 * theirs rises from the home in the middle. `locate` decides where each is
 * from; this only draws them.
 *
 * Announced politely for screen readers, as "Ann: Wow".
 */
export default function SeatReactions({
  reactions,
  locate,
  onArrive,
}: {
  reactions: SeatReaction[]
  locate: Locate
  onArrive: (entry: SeatReaction, x: number) => void
}) {
  // Only what arrived while the table was up (or just before): a table that remounts must not replay
  // old ones. Each runs its rise once and stays faded out until it falls off the room's short list.
  const [since] = useState(() => performance.now() - FLOAT_MS)
  return (
    <div className="hh-reactions" aria-live="polite">
      {reactions
        .filter((entry) => entry.receivedAt > since)
        .map((entry) => (
          <Bubble key={entry.id} entry={entry} locate={locate} onArrive={onArrive} />
        ))}
    </div>
  )
}
