import { useState } from 'react'
import type { CSSProperties } from 'react'
import { ArrowRight } from 'lucide-react'
import { Link } from 'react-router'
import type { ActiveTable } from '@games/shared/protocol'
import { games } from '../games/catalog'
import { names, timeAgo } from './format'
import './YourTables.css'

function status(table: ActiveTable) {
  if (table.status === 'open') return { label: 'Waiting for players', tone: 'open' }
  if (table.yourTurn) return { label: 'Your turn', tone: 'turn' }
  return { label: 'Their move', tone: 'waiting' }
}

/**
 * The rooms this player still has a seat in, each a way straight back to its
 * table. Turns that are theirs come first (the server sorts them so) and say
 * so loudest. Nothing at all when there are none: an empty "Your tables" is
 * just a heading to scroll past.
 */
export default function YourTables({
  tables,
  heading = 'Your tables',
}: {
  tables: ActiveTable[]
  heading?: string
}) {
  const [now] = useState(() => Date.now())
  if (!tables.length) return null
  return (
    <section className="tables" aria-labelledby="tables-title">
      <div className="tables-heading">
        <h2 id="tables-title">{heading}</h2>
        <span>
          {tables.length} {tables.length === 1 ? 'game' : 'games'} waiting
        </span>
      </div>
      <ul className="tables-list">
        {tables.map((table, index) => {
          const game = games.find((entry) => entry.id === table.game)
          if (!game) return null
          const { label, tone } = status(table)
          const who = table.opponents.length ? `with ${names(table.opponents)}` : 'Just you so far'
          return (
            <li
              key={table.code}
              className={`tables-card tables-card-${tone}`}
              style={{ '--i': index } as CSSProperties}
            >
              <img src={`${import.meta.env.BASE_URL}${game.icon}`} alt="" width="40" height="40" />
              <div className="tables-card-body">
                <p className="tables-card-status">
                  <i aria-hidden="true" /> {label}
                </p>
                <h3>{game.name}</h3>
                <p className="tables-card-who">
                  {who} · <span>{timeAgo(table.updatedAt, now)}</span>
                </p>
              </div>
              <Link
                to={`${game.path}/room/${table.code}`}
                className="tables-card-rejoin"
                aria-label={`Rejoin ${game.name} room ${table.code}: ${label}`}
                onPointerEnter={() => void game.preload()}
                onFocus={() => void game.preload()}
              >
                Rejoin <ArrowRight size={16} />
              </Link>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
