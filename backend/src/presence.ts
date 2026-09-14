import { DurableObject } from 'cloudflare:workers'
import type { Env } from './env'

/** A visitor drops out of the counts after three missed 30s heartbeats. */
export const PRESENCE_TTL_MS = 90_000

/**
 * A room drops out after four missed pushes. Longer than a visitor's window
 * because a room pushes on its own activity rather than on a timer, and a
 * Durable Object can be evicted and re-instantiated between two of them.
 */
export const ROOM_BOTS_TTL_MS = 120_000

/** The most bots one table can contribute, whatever a caller claims. */
const MAX_ROOM_BOTS = 8

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

/**
 * Room codes are six characters of a fixed alphabet. Checked here rather than
 * trusted, for the same reason the count is clamped: this object answers a
 * public counter and its caller is another Durable Object, not a type system.
 */
const ROOM_CODE_PATTERN = /^[A-Z2-9]{6}$/

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
      // A new table, so `IF NOT EXISTS` is the whole story — unlike LobbyDO's
      // `bots` column, where the same idiom silently skips an existing object.
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS room_bots (
          code TEXT PRIMARY KEY,
          game TEXT NOT NULL,
          bots INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)
    })
  }

  /**
   * A room saying how many seats it is currently playing itself. Always the
   * whole number rather than a delta, so a push lost on the way costs one
   * stale window and then heals, instead of drifting for the room's lifetime.
   */
  async reportBots(code: string, game: string, bots: number): Promise<void> {
    const resolved = resolvePresenceGame(game)
    if (!ROOM_CODE_PATTERN.test(code) || !resolved) return
    const sql = this.ctx.storage.sql
    sql.exec('DELETE FROM room_bots WHERE updated_at <= ?', Date.now() - ROOM_BOTS_TTL_MS)
    const count = Math.min(MAX_ROOM_BOTS, Math.max(0, Math.trunc(bots)))
    if (count === 0) {
      sql.exec('DELETE FROM room_bots WHERE code = ?', code)
      return
    }
    sql.exec(
      `INSERT INTO room_bots (code, game, bots, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET
         game = excluded.game,
         bots = excluded.bots,
         updated_at = excluded.updated_at`,
      code,
      resolved,
      count,
      Date.now(),
    )
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
    // Bots the rooms are playing right now. A bot has no `client_id`, so the
    // two sets are disjoint by construction and adding them cannot double
    // count. This is a merge rather than one GROUP BY because a game can have
    // bots playing and nobody at all on its page.
    sql.exec('DELETE FROM room_bots WHERE updated_at <= ?', now - ROOM_BOTS_TTL_MS)
    const botRows = sql.exec<Record<string, SqlStorageValue> & { game: string; n: number }>(
      'SELECT game, SUM(bots) AS n FROM room_bots GROUP BY game',
    )
    let bots = 0
    for (const row of botRows.toArray()) {
      byGame[row.game] = (byGame[row.game] ?? 0) + row.n
      bots += row.n
    }
    return { total: total + bots, byGame }
  }
}
