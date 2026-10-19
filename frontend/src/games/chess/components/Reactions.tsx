import { useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { SmilePlus } from 'lucide-react'
import type { ReactionId } from '@games/shared/protocol'
import ReactionBar from '../../../online/ReactionBar'
import type { ReactionEntry } from '../../../online/roomState'
import { reactionMeta } from '../game/reactions'

/** A stable spread for one reaction, from its id, so a re-render never moves it. */
function jitter(id: string) {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return ((hash >>> 0) % 1000) / 1000 - 0.5
}

/**
 * Reactions rising from one spot — a seat's avatar, or the stands for anyone
 * watching. Drawn only: the table announces them once, in its own live region.
 */
export function ReactionBubbles({ entries, label }: { entries: ReactionEntry[]; label?: string }) {
  return entries.map((entry) => {
    const meta = reactionMeta(entry.reaction)
    if (!meta) return null
    return (
      <span
        key={entry.id}
        className="ch-reaction"
        style={{ '--jitter': jitter(entry.id) } as CSSProperties}
        aria-hidden="true"
      >
        <span className="ch-reaction-emoji">{meta.emoji}</span>
        {label && <span className="ch-reaction-label">{label}</span>}
      </span>
    )
  })
}

/**
 * The reaction row on the table's control strip. Where the strip has room it
 * sits there in full; on a narrower table it folds behind one button and opens
 * above the strip, so it never crowds the view controls.
 */
export function TableReactions({
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
      className={`ch-react ${open ? 'ch-react-open' : ''}`}
      onKeyDown={(event) => {
        if (event.key !== 'Escape' || !open) return
        event.preventDefault()
        setOpen(false)
        toggle.current?.focus()
      }}
    >
      <ReactionBar className="ch-react-bar" onReact={onReact} watching={watching} />
      <button
        ref={toggle}
        className="ch-react-toggle"
        aria-label="Reactions"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <SmilePlus size={16} />
      </button>
    </div>
  )
}
