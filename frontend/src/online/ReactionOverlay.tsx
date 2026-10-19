import { useState } from 'react'
import type { CSSProperties } from 'react'
import { REACTIONS } from '@games/shared/protocol'
import type { RoomSnapshot } from '@games/shared/protocol'
import type { ReactionEntry } from './roomState'
import './reactions.css'

/** How long one reaction stays on screen. Matches the float in reactions.css. */
const REACTION_FLOAT_MS = 2600

/** A stable spread for one reaction, from its id, so a re-render never moves it. */
function jitter(id: string) {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return ((hash >>> 0) % 1000) / 1000
}

/**
 * The room page's default telling of reactions: each one floats up from the
 * bottom of the screen with the name of whoever sent it, on a spring, and is
 * gone in a few seconds. Each seat rises in its own lane, left to right in
 * seat order, so two people reacting at once read as two people; spectators
 * rise from the middle. A game that anchors reactions to its own seats can
 * pass `hidden` and draw them itself from the same entries.
 *
 * Announced politely for screen readers, as "Ann: Wow".
 */
export default function ReactionOverlay({
  reactions,
  snapshot,
  hidden = false,
}: {
  reactions: ReactionEntry[]
  snapshot: RoomSnapshot | null
  hidden?: boolean
}) {
  // Only what arrived while this overlay was up (or just before): one that
  // remounts — the lobby turning into the table — must not replay old ones.
  // Each runs its float once and is left faded out until it falls off the list.
  const [since] = useState(() => performance.now() - REACTION_FLOAT_MS)
  const live = reactions.filter((entry) => entry.receivedAt > since)

  if (hidden) return null
  const seats = snapshot?.seatIds ?? []
  const nameOf = (entry: ReactionEntry) =>
    (entry.seat && snapshot?.seats[entry.seat]?.player.name) || 'Someone watching'
  return (
    <div className="reaction-overlay" aria-live="polite">
      {live.map((entry) => {
        const meta = REACTIONS.find((reaction) => reaction.id === entry.reaction)
        if (!meta) return null
        const index = entry.seat ? seats.indexOf(entry.seat) : -1
        // Lanes across the middle of the screen: -1 (left) to 1 (right).
        const lane = index < 0 || seats.length < 2 ? 0 : (index / (seats.length - 1)) * 2 - 1
        const style = {
          '--lane': lane,
          '--jitter': jitter(entry.id) - 0.5,
        } as CSSProperties
        return (
          <div key={entry.id} className="reaction-float" style={style}>
            <span className="reaction-float-emoji" aria-hidden="true">
              {meta.emoji}
            </span>
            <span className="reaction-float-name">
              <span className="reaction-sr">{`${nameOf(entry)}: ${meta.label}`}</span>
              <span aria-hidden="true">{nameOf(entry)}</span>
            </span>
          </div>
        )
      })}
    </div>
  )
}
