/* eslint-disable react-refresh/only-export-components -- the presence context,
   its hook, and the badge belong to one tiny feature; splitting them into
   separate files would obscure more than fast refresh gains. */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { presenceBeat, type PresenceCounts } from './api'
import { guestId } from './guest'

const BEAT_MS = 30_000

// One id per page load; the previous load's row ages out server-side.
const TAB_ID = crypto.randomUUID()

const PlayersOnlineContext = createContext<PresenceCounts | null>(null)

/**
 * The one presence poller per tab. Each beat reports where this tab is and
 * carries the fresh counts back, so heartbeat and poll are a single request.
 * Paused while the tab is hidden; the server forgets us after 90s.
 */
export function PlayersOnlineProvider({ game, children }: { game?: string; children: ReactNode }) {
  const [counts, setCounts] = useState<PresenceCounts | null>(null)

  useEffect(() => {
    let active = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const beat = async () => {
      try {
        const next = await presenceBeat(guestId(), TAB_ID, game)
        if (active) setCounts(next)
      } catch {
        // Decorative: keep the last honest number and try again next round.
      }
      if (active && !document.hidden) timer = setTimeout(() => void beat(), BEAT_MS)
    }
    const onVisibility = () => {
      clearTimeout(timer)
      if (!document.hidden) void beat()
    }
    void beat()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      active = false
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [game])

  return <PlayersOnlineContext.Provider value={counts}>{children}</PlayersOnlineContext.Provider>
}

export function usePlayersOnline(): PresenceCounts | null {
  return useContext(PlayersOnlineContext)
}

/**
 * "N online" pill. Unstyled on purpose: every surface passes its own class
 * so the badge speaks each game's CSS dialect. Renders nothing until the
 * first honest answer arrives, and nothing for a zero count.
 */
export function PlayersOnlineBadge({ game, className }: { game?: string; className: string }) {
  const counts = usePlayersOnline()
  const count = counts === null ? 0 : game ? (counts.byGame[game] ?? 0) : counts.total
  if (!count) return null
  return (
    <span className={className} aria-label={`${count} ${count === 1 ? 'player' : 'players'} online`}>
      <i aria-hidden="true" /> {count} online
    </span>
  )
}
