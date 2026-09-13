import { DurableObject } from 'cloudflare:workers'
import type { Env } from './env'

/** A visitor drops out of the counts after three missed 30s heartbeats. */
export const PRESENCE_TTL_MS = 90_000

// Mirrors the catalog ids in frontend/src/games/catalog.ts. Presence counts the
// people on a game's page, whether or not they ever open a room, so it
// deliberately keys on catalog ids rather than the online-only `GameId` — a
// game can be in the catalog long before it has an adapter to play over.
const PRESENCE_GAMES = new Set(['hearth', 'estate', 'chess', 'prism', 'wildrise'])
const ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/

export interface PresenceCounts {
  total: number
  byGame: Record<string, number>
}

export function validPresenceId(raw: unknown): string | null {
  return typeof raw === 'string' && ID_PATTERN.test(raw) ? raw : null
}

/** '' = no game (home page); null = rejected. */
export function resolvePresenceGame(raw: unknown): string | null {
  if (raw === undefined) return ''
  return typeof raw === 'string' && PRESENCE_GAMES.has(raw) ? raw : null
}

export class PresenceDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS presence (
          client_id TEXT NOT NULL,
          tab_id TEXT NOT NULL,
          game TEXT NOT NULL,
          last_seen INTEGER NOT NULL,
          PRIMARY KEY (client_id, tab_id)
        )
      `)
    })
  }

  async beat(clientId: string, tabId: string, game: string): Promise<PresenceCounts> {
    const now = Date.now()
    const sql = this.ctx.storage.sql
    // Every beat is also the sweep: reads never see anything stale, so no
    // alarm is needed (and none is ever registered on this object).
    sql.exec('DELETE FROM presence WHERE last_seen <= ?', now - PRESENCE_TTL_MS)
    sql.exec(
      `INSERT INTO presence (client_id, tab_id, game, last_seen)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(client_id, tab_id) DO UPDATE SET
         game = excluded.game,
         last_seen = excluded.last_seen`,
      clientId,
      tabId,
      game,
      now,
    )
    const total = sql
      .exec<Record<string, SqlStorageValue> & { n: number }>(
        'SELECT COUNT(DISTINCT client_id) AS n FROM presence',
      )
      .one().n
    const byGame: Record<string, number> = {}
    const rows = sql.exec<Record<string, SqlStorageValue> & { game: string; n: number }>(
      "SELECT game, COUNT(DISTINCT client_id) AS n FROM presence WHERE game != '' GROUP BY game",
    )
    for (const row of rows.toArray()) byGame[row.game] = row.n
    return { total, byGame }
  }
}
