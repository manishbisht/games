import type { CSSProperties } from 'react'
import type { GameEntry } from './games/catalog'

/** The board half of the skeleton: also what a room shows while its table's code arrives. */
export function BoardSkeleton({ label }: { label: string }) {
  return (
    <div className="board-skeleton">
      <div className="board-skeleton-board" aria-hidden="true">
        {Array.from({ length: 25 }, (_, i) => (
          // The wave runs corner to corner: a square's delay is its diagonal.
          <i key={i} style={{ '--i': (i % 5) + Math.floor(i / 5) } as CSSProperties} />
        ))}
      </div>
      <p>{label}</p>
    </div>
  )
}

/**
 * What a deep link shows while its game's chunk loads: the game's name where
 * its header will be, and a board on its way. It is also what a route
 * transition morphs into when the chunk is slower than the transition.
 */
export default function RouteSkeleton({ game, room }: { game?: GameEntry; room: boolean }) {
  return (
    <div className="route-skeleton" role="status">
      <header className="route-skeleton-header">
        {game && (
          <>
            <img src={`${import.meta.env.BASE_URL}${game.icon}`} alt="" width="32" height="32" />
            {game.name}
          </>
        )}
        <span />
        <span />
      </header>
      <BoardSkeleton label={room ? 'Pulling up a chair…' : 'Setting the table…'} />
      <span className="sr-only">Loading game…</span>
    </div>
  )
}
