import { DurableObject } from 'cloudflare:workers'
import type { GameId, PublicRoomSummary } from '@games/shared/protocol'
import type { Env } from './env'

const STALE_MS = 6 * 60 * 60 * 1000
const PURGE_INTERVAL_MS = 60 * 60 * 1000

interface Row extends Record<string, SqlStorageValue> {
  code: string
  game: string
  host_name: string
  seats_taken: number
  seats_total: number
  created_at: number
  bots: number
}

const toSummary = (row: Row): PublicRoomSummary => ({
  code: row.code,
  game: row.game as GameId,
  hostName: row.host_name,
  seatsTaken: row.seats_taken,
  seatsTotal: row.seats_total,
  createdAt: row.created_at,
  bots: row.bots,
})

/**
 * Build the table, then bring an older one forward. `CREATE TABLE IF NOT EXISTS`
 * is the trap here rather than the fix: a lobby that already exists keeps the
 * shape it was created with and never notices a column added to the statement
 * above, so a deployed object would report `bots: 0` forever. Idempotent,
 * because the constructor runs on every wake.
 */
export function migrate(sql: SqlStorage): void {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      code TEXT PRIMARY KEY,
      game TEXT NOT NULL,
      host_name TEXT NOT NULL,
      seats_taken INTEGER NOT NULL,
      seats_total INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      bots INTEGER NOT NULL DEFAULT 0
    )
  `)
  const columns = sql.exec("SELECT name FROM pragma_table_info('rooms')").toArray()
  // A constant default is what makes ADD COLUMN legal on a non-empty table.
  if (!columns.some((column) => column.name === 'bots'))
    sql.exec('ALTER TABLE rooms ADD COLUMN bots INTEGER NOT NULL DEFAULT 0')
}

export class LobbyDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    // Inside blockConcurrencyWhile, so no request can see a half-migrated table.
    ctx.blockConcurrencyWhile(async () => migrate(this.ctx.storage.sql))
  }

  async upsert(summary: PublicRoomSummary): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO rooms (code, game, host_name, seats_taken, seats_total, created_at, updated_at, bots)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET
         host_name = excluded.host_name,
         seats_taken = excluded.seats_taken,
         updated_at = excluded.updated_at,
         bots = excluded.bots`,
      summary.code,
      summary.game,
      summary.hostName,
      summary.seatsTaken,
      summary.seatsTotal,
      summary.createdAt,
      Date.now(),
      summary.bots,
    )
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + PURGE_INTERVAL_MS)
  }

  async remove(code: string): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM rooms WHERE code = ?', code)
  }

  async list(game?: GameId): Promise<PublicRoomSummary[]> {
    const cutoff = Date.now() - STALE_MS
    // Only joinable rooms: a room with every seat taken is still `open` (the
    // host hasn't pressed start) but nobody else can get in.
    const rows = game
      ? this.ctx.storage.sql.exec<Row>(
          'SELECT code, game, host_name, seats_taken, seats_total, created_at, bots FROM rooms WHERE game = ? AND updated_at > ? AND seats_taken < seats_total ORDER BY created_at DESC LIMIT 50',
          game,
          cutoff,
        )
      : this.ctx.storage.sql.exec<Row>(
          'SELECT code, game, host_name, seats_taken, seats_total, created_at, bots FROM rooms WHERE updated_at > ? AND seats_taken < seats_total ORDER BY created_at DESC LIMIT 50',
          cutoff,
        )
    return rows.toArray().map(toSummary)
  }

  async alarm(): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM rooms WHERE updated_at <= ?', Date.now() - STALE_MS)
    const remaining = this.ctx.storage.sql
      .exec<Record<string, SqlStorageValue> & { n: number }>('SELECT COUNT(*) AS n FROM rooms')
      .one().n
    if (remaining > 0) await this.ctx.storage.setAlarm(Date.now() + PURGE_INTERVAL_MS)
  }
}
