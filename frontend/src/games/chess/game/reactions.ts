import { useEffect, useRef, useState } from 'react'
import { REACTIONS } from '@games/shared/protocol'
import type { ReactionId } from '@games/shared/protocol'
import type { ReactionEntry } from '../../../online/roomState'

/** How long one reaction stays on screen; matches `ch-reaction-rise` in ChessGame.css. */
const FLOAT_MS = 2600

/**
 * The reactions to draw: those that arrived while the table was up (or just
 * before), so a table that remounts never replays old ones. Each runs its float
 * once and stays faded out until it falls off the room's short list.
 * `arrive` hears each one once, as it lands — not on a remount.
 */
export function useLiveReactions(reactions: ReactionEntry[], arrive: (entry: ReactionEntry) => void) {
  const [mounted] = useState(() => performance.now())
  const heard = useRef<number | null>(null),
    latest = useRef(arrive)
  useEffect(() => {
    latest.current = arrive
  })
  useEffect(() => {
    const from = heard.current ?? mounted,
      fresh = reactions.filter((entry) => entry.receivedAt > from)
    if (!fresh.length) return
    heard.current = Math.max(...fresh.map((entry) => entry.receivedAt))
    for (const entry of fresh) latest.current(entry)
  }, [reactions, mounted])
  return reactions.filter((entry) => entry.receivedAt > mounted - FLOAT_MS)
}

export const reactionMeta = (id: ReactionId) => REACTIONS.find((reaction) => reaction.id === id)
