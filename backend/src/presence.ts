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

/**
 * The most browsers one address may add to the count at once. A household or
 * an office is a handful; a script minting a fresh id every beat is not, and it
 * should not be able to print "40,000 online".
 */
export const MAX_CLIENTS_PER_SOURCE = 20

/**
 * How long a count is reused. Every visitor's tab asks for one twice a minute,
 * so this is what keeps the one global object to a point lookup and an update
 * per beat; anything that changes who is here — a new tab, a page change, a
 * table's bots — recounts at once.
 */
const COUNTS_TTL_MS = 2_000
/** Rows past their window are filtered out of every count; deleting them can wait this long. */
const PRUNE_EVERY_MS = 15_000

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

/**
 * What the presence table stores for a browser's id: a one-way hash of it.
 * Browsers have sent their guest id as their presence id — a guest's only
 * credential — and the count only needs something stable and distinct, so
 * the global object never holds the id itself, whatever a browser sends.
 */
export async function presenceKey(clientId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`games-presence:${clientId}`))
  return [...new Uint8Array(digest).slice(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** '' = no game (home page); null = rejected. */
export function resolvePresenceGame(raw: unknown): string | null {
  if (raw === undefined) return ''
  return typeof raw === 'string' && PRESENCE_GAMES.has(raw) ? raw : null
}

export class PresenceDO extends DurableObject<Env> {
  private counts: { at: number; value: PresenceCounts } | null = null
  private prunedAt = 0

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      const sql = this.ctx.storage.sql
      sql.exec(`
        CREATE TABLE IF NOT EXISTS presence (
          client_id TEXT NOT NULL,
          tab_id TEXT NOT NULL,
          game TEXT NOT NULL,
          last_seen INTEGER NOT NULL,
          PRIMARY KEY (client_id, tab_id)
        )
      `)
      // `IF NOT EXISTS` never reshapes a table a deployed object already has
      // (see lobby.ts's `migrate`), so the column is added by hand.
      const columns = sql.exec("SELECT name FROM pragma_table_info('presence')").toArray()
      if (!columns.some((column) => column.name === 'source'))
        sql.exec('ALTER TABLE presence ADD COLUMN source TEXT')
      sql.exec('CREATE INDEX IF NOT EXISTS presence_seen ON presence (last_seen)')
      sql.exec('CREATE INDEX IF NOT EXISTS presence_source ON presence (source, last_seen)')
      sql.exec(`
        CREATE TABLE IF NOT EXISTS room_bots (
          code TEXT PRIMARY KEY,
          game TEXT NOT NULL,
          bots INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)
      sql.exec('CREATE INDEX IF NOT EXISTS room_bots_updated ON room_bots (updated_at)')
    })
  }

  /**
   * Forget rows past their window — at most every `PRUNE_EVERY_MS`, on an
   * index, rather than a full scan on every call. The counts filter by time
   * themselves, so a row waiting here to be deleted is never counted.
   */
  private prune(now: number): void {
    if (now - this.prunedAt < PRUNE_EVERY_MS) return
    this.prunedAt = now
    this.ctx.storage.sql.exec('DELETE FROM presence WHERE last_seen <= ?', now - PRESENCE_TTL_MS)
    this.ctx.storage.sql.exec('DELETE FROM room_bots WHERE updated_at <= ?', now - ROOM_BOTS_TTL_MS)
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
    const now = Date.now()
    this.prune(now)
    const count = Math.min(MAX_ROOM_BOTS, Math.max(0, Math.trunc(bots)))
    const before = sql
      .exec<{ bots: number; updated_at: number }>(
        'SELECT bots, updated_at FROM room_bots WHERE code = ?',
        code,
      )
      .toArray()[0]
    const was = before && before.updated_at > now - ROOM_BOTS_TTL_MS ? before.bots : 0
    if (count !== was) this.counts = null
    if (count === 0) {
      if (before) sql.exec('DELETE FROM room_bots WHERE code = ?', code)
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
      now,
    )
  }

  /**
   * One tab's heartbeat, answered with the counts. `clientId` arrives already
   * hashed (see `presenceKey`); `source` tags the address it came from (see
   * `sourceTag`), so one address can only add `MAX_CLIENTS_PER_SOURCE` browsers
   * to the count. A beat over that cap is still answered — it is just not
   * counted.
   */
  async beat(
    clientId: string,
    tabId: string,
    game: string,
    source: string | null = null,
  ): Promise<PresenceCounts> {
    const now = Date.now()
    const cutoff = now - PRESENCE_TTL_MS
    const sql = this.ctx.storage.sql
    this.prune(now)
    const existing = sql
      .exec<{ game: string; last_seen: number }>(
        'SELECT game, last_seen FROM presence WHERE client_id = ? AND tab_id = ?',
        clientId,
        tabId,
      )
      .toArray()[0]
    const live = existing && existing.last_seen > cutoff
    if (!live && source !== null) {
      const known =
        sql
          .exec('SELECT 1 FROM presence WHERE client_id = ? AND last_seen > ? LIMIT 1', clientId, cutoff)
          .toArray().length > 0
      const fromSource = known
        ? 0
        : sql
            .exec<{ n: number }>(
              'SELECT COUNT(DISTINCT client_id) AS n FROM presence WHERE source = ? AND last_seen > ?',
              source,
              cutoff,
            )
            .one().n
      if (fromSource >= MAX_CLIENTS_PER_SOURCE) return this.read(now)
    }
    sql.exec(
      `INSERT INTO presence (client_id, tab_id, game, last_seen, source)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(client_id, tab_id) DO UPDATE SET
         game = excluded.game,
         last_seen = excluded.last_seen,
         source = excluded.source`,
      clientId,
      tabId,
      game,
      now,
      source,
    )
    if (!live || existing.game !== game) this.counts = null
    return this.read(now)
  }

  /** The counts as of `now`, reused for `COUNTS_TTL_MS` unless something changed who is here. */
  private read(now: number): PresenceCounts {
    if (this.counts && now - this.counts.at < COUNTS_TTL_MS) return this.counts.value
    const sql = this.ctx.storage.sql
    const cutoff = now - PRESENCE_TTL_MS
    const total = sql
      .exec<{ n: number }>('SELECT COUNT(DISTINCT client_id) AS n FROM presence WHERE last_seen > ?', cutoff)
      .one().n
    const byGame: Record<string, number> = {}
    const rows = sql.exec<{ game: string; n: number }>(
      "SELECT game, COUNT(DISTINCT client_id) AS n FROM presence WHERE last_seen > ? AND game != '' GROUP BY game",
      cutoff,
    )
    for (const row of rows) byGame[row.game] = row.n
    // Bots the rooms are playing right now. A bot has no `client_id`, so the
    // two sets are disjoint by construction and adding them cannot double
    // count. This is a merge rather than one GROUP BY because a game can have
    // bots playing and nobody at all on its page.
    const botRows = sql.exec<{ game: string; n: number }>(
      'SELECT game, SUM(bots) AS n FROM room_bots WHERE updated_at > ? GROUP BY game',
      now - ROOM_BOTS_TTL_MS,
    )
    let bots = 0
    for (const row of botRows) {
      byGame[row.game] = (byGame[row.game] ?? 0) + row.n
      bots += row.n
    }
    const value = { total: total + bots, byGame }
    this.counts = { at: now, value }
    return value
  }
}
