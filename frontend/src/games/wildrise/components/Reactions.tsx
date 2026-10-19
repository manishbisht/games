import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { REACTIONS } from '@games/shared/protocol'
import { PALETTES } from '@games/shared/wildrise/board'
import type { PlayerId } from '@games/shared/wildrise/types'
import type { TableReaction } from '../online/session'

/** How long one reaction stays on screen; matches `wr-reaction-rise`. */
const FLOAT_MS = 2600

export type Locate = (from: PlayerId | null) => { x: number; y: number }

/**
 * One reaction, rising from whoever said it. It follows its anchor for as long
 * as it is up — a token mid-hop, a camera swinging round — by writing the spot
 * straight onto the element each frame rather than re-rendering.
 */
function Bubble({ reaction, name, locate }: { reaction: TableReaction; name: string; locate: Locate }) {
  const ref = useRef<HTMLDivElement>(null)
  const meta = REACTIONS.find((r) => r.id === reaction.reaction)
  useLayoutEffect(() => {
    let frame = 0
    const until = performance.now() + FLOAT_MS
    const follow = () => {
      const el = ref.current
      if (!el) return
      const { x, y } = locate(reaction.from)
      el.style.translate = `${Math.round(x)}px ${Math.round(y)}px`
      if (performance.now() < until) frame = requestAnimationFrame(follow)
    }
    follow()
    return () => cancelAnimationFrame(frame)
  }, [reaction, locate])
  if (!meta) return null
  // A stable sway per reaction, so two at once from one seat don't stack exactly.
  const sway = ((reaction.id.charCodeAt(reaction.id.length - 1) % 7) - 3) / 3
  return (
    <div
      ref={ref}
      className="wr-reaction"
      data-from={reaction.from ?? 'watching'}
      style={
        {
          '--sway': sway,
          '--player-color': reaction.from ? PALETTES[reaction.from].color : '#59614f',
        } as CSSProperties
      }
    >
      <div className="wr-reaction-body">
        <span className="wr-reaction-emoji" aria-hidden="true">
          {meta.emoji}
        </span>
        <span className="wr-reaction-name">
          <span className="sr-only">{`${name}: ${meta.label}`}</span>
          <span aria-hidden="true">{name}</span>
        </span>
      </div>
    </div>
  )
}

/**
 * Reactions at the table: each rises from the token of the player who sent it
 * — wherever the camera has put it — or from their card when the token is out
 * of view, and a spectator's from a neutral spot over the board. Announced
 * politely, as "Ann: Wow"; a soft pop as each arrives.
 */
export default function Reactions({
  reactions,
  nameOf,
  locate,
  onArrive,
}: {
  reactions: TableReaction[]
  nameOf: (from: PlayerId | null) => string
  locate: Locate
  onArrive: (reaction: TableReaction) => void
}) {
  // Only what arrived while the table was up (or just before): remounting must
  // not replay old ones. Each runs its float once and stays faded out until it
  // falls off the room's short list.
  const [since] = useState(() => performance.now() - FLOAT_MS)
  const live = reactions.filter((r) => r.receivedAt > since)
  const heard = useRef(new Set<string>())
  const arrive = useRef(onArrive)
  useEffect(() => {
    arrive.current = onArrive
  })
  useEffect(() => {
    for (const reaction of live)
      if (!heard.current.has(reaction.id)) {
        heard.current.add(reaction.id)
        arrive.current(reaction)
      }
  }, [live])
  return (
    <div className="wr-reactions" aria-live="polite">
      {live.map((reaction) => (
        <Bubble key={reaction.id} reaction={reaction} name={nameOf(reaction.from)} locate={locate} />
      ))}
    </div>
  )
}
