import { DurableObject } from 'cloudflare:workers'
import type {
  ActiveTable,
  GameId,
  GameRecord,
  GameResult,
  GameStats,
  MyProfile,
  Opponent,
  PublicProfile,
  Rating,
} from '@games/shared/protocol'
import { track } from './analytics'
import { cleanName } from './auth'
import { nextRating, PROVISIONAL_GAMES, START_RATING } from './elo'
import type { Env } from './env'
import { sendPush, type PushMessage, type PushSubscriptionKeys } from './push'

/** How a player looks, as of the last table they sat at. */
export interface PlayerSelf {
  name: string
  avatar?: string
  isGuest: boolean
}

/** One finished game for one seat, as the room hands it over. */
export interface GameEntry {
  self: PlayerSelf
  game: GameId
  code: string
  /** Which game in this room's life it was; with `code`, what makes a record arrive once. */
  round: number
  result: GameResult
  place?: number
  seats: number
  opponents: Opponent[]
  at: number
  /**
   * Rated games only: the opponent's rating going in, and their handle — kept
   * privately, to count rated games against the same person (see `chessRating`).
   */
  rated?: { opponent: number; against?: string }
}

/** What a room weighs before rating a chess game for this player (see `RoomDO.recordFinish`). */
export interface ChessStanding {
  rating: number
  /** Rated chess games so far. */
  games: number
  /** Finished games of any kind so far: what makes a guest more than a throwaway. */
  played: number
  /** Rated games against the opponent being asked about, today (UTC). */
  againstToday: number
}

/** A guest counts as a real opponent for a settled player once they have finished this many games. */
export const CREDIBLE_GAMES = 5
/** Rated games against one opponent per UTC day; any more are recorded, unrated. */
export const RATED_PER_OPPONENT_DAILY = 3

const DAY_MS = 86_400_000
const dayOf = (at: number) => Math.floor(at / DAY_MS)

export type NotifyKind = 'turn' | 'joined'

/** How long a room waits before telling the same player the same kind of thing again. */
export const NOTIFY_EVERY_MS = 5 * 60 * 1000
/** History kept per player. The counts are kept separately, so trimming this loses no stats. */
const HISTORY_KEPT = 200
/** What a profile shows of that history. */
const RECENT_SHOWN = 20
/** One player, a handful of browsers. A list that keeps growing is a bug somewhere else. */
const MAX_SUBSCRIPTIONS = 8

const SCORE: Record<GameResult, number> = { win: 1, draw: 0.5, loss: 0 }

interface Meta {
  self?: PlayerSelf
  since?: number
  chess?: { rating: number; games: number; peak: number }
}

/**
 * One player's record, keyed by their public handle (see handles.ts): finished
 * games and the counts drawn from them, a chess rating, the tables they are
 * sitting at right now, and the browsers they want to be told about their turn
 * in. Rooms write to it; GET /api/me and /api/players/:handle read it.
 *
 * SQLite-backed, so the history is a table to query rather than one value that
 * grows with every game.
 */
export class PlayerDO extends DurableObject<Env> {
  private sql: SqlStorage
  /** How pushes leave. A seam for tests, which must not reach a real push service. */
  fetcher: typeof fetch = (input, init) => fetch(input, init)

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.sql = ctx.storage.sql
  }

  /**
   * Whether this player has ever been written. The schema is only created by a
   * write, so a read — a profile lookup of a handle nobody owns — leaves no
   * storage behind for a stranger to have conjured up.
   */
  private exists(): boolean {
    return (
      this.sql.exec(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'`).toArray().length > 0
    )
  }

  private schema(): void {
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS games (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        code TEXT NOT NULL, round INTEGER NOT NULL, game TEXT NOT NULL, result TEXT NOT NULL,
        place INTEGER, seats INTEGER NOT NULL, opponents TEXT NOT NULL, at INTEGER NOT NULL,
        rating_before INTEGER, rating_after INTEGER,
        UNIQUE (code, round)
      );
      CREATE TABLE IF NOT EXISTS stats (
        game TEXT PRIMARY KEY, played INTEGER NOT NULL, wins INTEGER NOT NULL,
        losses INTEGER NOT NULL, draws INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tables (
        code TEXT PRIMARY KEY, game TEXT NOT NULL, status TEXT NOT NULL, seats INTEGER NOT NULL,
        opponents TEXT NOT NULL, your_turn INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        version INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS subscriptions (
        endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS notified (k TEXT PRIMARY KEY, at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rated_against (
        opponent TEXT NOT NULL, day INTEGER NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (opponent, day)
      );
    `)
  }

  private meta(): Meta {
    const row = this.sql.exec<{ v: string }>(`SELECT v FROM meta WHERE k = 'meta'`).toArray()[0]
    return row ? (JSON.parse(row.v) as Meta) : {}
  }

  private saveMeta(meta: Meta): void {
    this.sql.exec(
      `INSERT INTO meta (k, v) VALUES ('meta', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v`,
      JSON.stringify(meta),
    )
  }

  /**
   * The chess rating a room should rate this player's next game from, and what
   * it needs to decide whether to rate it at all: how much history this player
   * has, and how many rated games they have already had today against
   * `opponent` (a handle).
   */
  async chessRating(opponent?: string, now = Date.now()): Promise<ChessStanding> {
    if (!this.exists()) return { rating: START_RATING, games: 0, played: 0, againstToday: 0 }
    this.schema()
    const chess = this.meta().chess
    const played = this.sql.exec<{ n: number | null }>(`SELECT SUM(played) AS n FROM stats`).one().n ?? 0
    const againstToday = opponent
      ? (this.sql
          .exec<{ n: number }>(
            `SELECT n FROM rated_against WHERE opponent = ? AND day = ?`,
            opponent,
            dayOf(now),
          )
          .toArray()[0]?.n ?? 0)
      : 0
    return { rating: chess?.rating ?? START_RATING, games: chess?.games ?? 0, played, againstToday }
  }

  /**
   * A finished game. Idempotent per room and round: a room that hands the same
   * game over twice (a retried alarm, say) is told so and counts nothing twice.
   */
  async record(entry: GameEntry): Promise<boolean> {
    this.schema()
    const meta = this.meta()
    let before: number | null = null,
      after: number | null = null
    if (entry.rated) {
      const chess = meta.chess ?? { rating: START_RATING, games: 0, peak: START_RATING }
      before = chess.rating
      after = nextRating(chess.rating, entry.rated.opponent, SCORE[entry.result], chess.games)
    }
    const seen = this.sql
      .exec(`SELECT 1 FROM games WHERE code = ? AND round = ?`, entry.code, entry.round)
      .toArray().length
    if (seen) return false
    this.sql.exec(
      `INSERT INTO games
        (code, round, game, result, place, seats, opponents, at, rating_before, rating_after)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      entry.code,
      entry.round,
      entry.game,
      entry.result,
      entry.place ?? null,
      entry.seats,
      JSON.stringify(entry.opponents),
      entry.at,
      before,
      after,
    )
    this.sql.exec(
      `INSERT INTO stats (game, played, wins, losses, draws) VALUES (?, 1, ?, ?, ?)
        ON CONFLICT (game) DO UPDATE SET played = played + 1, wins = wins + excluded.wins,
        losses = losses + excluded.losses, draws = draws + excluded.draws`,
      entry.game,
      entry.result === 'win' ? 1 : 0,
      entry.result === 'loss' ? 1 : 0,
      entry.result === 'draw' ? 1 : 0,
    )
    this.sql.exec(
      `DELETE FROM games WHERE id NOT IN (SELECT id FROM games ORDER BY at DESC, id DESC LIMIT ?)`,
      HISTORY_KEPT,
    )
    if (after !== null) {
      const games = (meta.chess?.games ?? 0) + 1
      meta.chess = { rating: after, games, peak: Math.max(meta.chess?.peak ?? START_RATING, after) }
    }
    if (entry.rated?.against) {
      const day = dayOf(entry.at)
      this.sql.exec(
        `INSERT INTO rated_against (opponent, day, n) VALUES (?, ?, 1)
          ON CONFLICT (opponent, day) DO UPDATE SET n = n + 1`,
        entry.rated.against,
        day,
      )
      this.sql.exec(`DELETE FROM rated_against WHERE day < ?`, day - 1)
    }
    meta.self = entry.self
    meta.since ??= entry.at
    this.saveMeta(meta)
    return true
  }

  /**
   * A table this player is at, as it stands now. `version` counts up per room,
   * and an update older than the one already here is dropped: a room's updates
   * travel as separate calls and need not arrive in the order they were sent.
   */
  async setTable(table: ActiveTable, version: number, self: PlayerSelf): Promise<void> {
    this.schema()
    this.sql.exec(
      `INSERT INTO tables (code, game, status, seats, opponents, your_turn, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (code) DO UPDATE SET game = excluded.game, status = excluded.status,
        seats = excluded.seats, opponents = excluded.opponents, your_turn = excluded.your_turn,
        updated_at = excluded.updated_at, version = excluded.version
        WHERE excluded.version > tables.version`,
      table.code,
      table.game,
      table.status,
      table.seats,
      JSON.stringify(table.opponents),
      table.yourTurn ? 1 : 0,
      table.updatedAt,
      version,
    )
    const meta = this.meta()
    if (JSON.stringify(meta.self) !== JSON.stringify(self)) this.saveMeta({ ...meta, self })
  }

  /**
   * They are no longer at this table: it finished, expired, or they got up.
   * Kept as a tombstone at this version, so an older "still sitting" that
   * arrives late cannot bring it back; the room's expiry is what clears it.
   */
  async dropTable(code: string, version: number): Promise<void> {
    this.schema()
    this.sql.exec(
      `INSERT INTO tables (code, game, status, seats, opponents, your_turn, updated_at, version)
        VALUES (?, '', 'gone', 0, '[]', 0, ?, ?)
        ON CONFLICT (code) DO UPDATE SET status = 'gone', your_turn = 0, updated_at = excluded.updated_at,
        version = excluded.version WHERE excluded.version > tables.version`,
      code,
      Date.now(),
      version,
    )
    // Rooms live a day; a tombstone older than two has nothing left to guard against.
    this.sql.exec(`DELETE FROM tables WHERE status = 'gone' AND updated_at < ?`, Date.now() - 2 * 86_400_000)
    this.sql.exec(`DELETE FROM notified WHERE k LIKE ?`, `%:${code}`)
  }

  /** The room is gone for good, so nothing about it is worth keeping. */
  async forgetTable(code: string): Promise<void> {
    if (!this.exists()) return
    this.sql.exec(`DELETE FROM tables WHERE code = ?`, code)
    this.sql.exec(`DELETE FROM notified WHERE k LIKE ?`, `%:${code}`)
  }

  /**
   * What GET /api/me (`owner`) or /api/players/:handle shows. Null for a
   * handle nobody has played under — and asking never writes, so looking up
   * random handles leaves nothing behind.
   */
  async profile(handle: string, owner: boolean): Promise<PublicProfile | MyProfile | null> {
    if (!this.exists())
      return owner
        ? {
            handle,
            name: '',
            isGuest: true,
            since: 0,
            stats: {},
            ratings: {},
            recent: [],
            active: [],
            pushSubscriptions: 0,
          }
        : null
    const meta = this.meta()
    if (!meta.self && !owner) return null
    const stats: Partial<Record<GameId, GameStats>> = {}
    for (const row of this.sql.exec<{
      game: string
      played: number
      wins: number
      losses: number
      draws: number
    }>(`SELECT * FROM stats`))
      stats[row.game as GameId] = { played: row.played, wins: row.wins, losses: row.losses, draws: row.draws }
    const chess: Rating | undefined = meta.chess && {
      rating: meta.chess.rating,
      games: meta.chess.games,
      provisional: meta.chess.games < PROVISIONAL_GAMES,
      peak: meta.chess.peak,
    }
    const recent: GameRecord[] = this.sql
      .exec<{
        code: string
        game: string
        result: string
        place: number | null
        seats: number
        opponents: string
        at: number
        rating_before: number | null
        rating_after: number | null
      }>(`SELECT * FROM games ORDER BY at DESC, id DESC LIMIT ?`, RECENT_SHOWN)
      .toArray()
      .map((row) => ({
        code: row.code,
        game: row.game as GameId,
        result: row.result as GameResult,
        ...(row.place === null ? {} : { place: row.place }),
        seats: row.seats,
        // Cleaned again on the way out: a name stored before names were cleaned
        // the way they are now must not reach a page in its old shape.
        opponents: (JSON.parse(row.opponents) as Opponent[]).map((opponent) => ({
          ...opponent,
          name: cleanName(opponent.name) ?? 'Player',
        })),
        at: row.at,
        ...(row.rating_before === null || row.rating_after === null
          ? {}
          : { rating: { before: row.rating_before, after: row.rating_after } }),
      }))
    const base = {
      handle,
      name: cleanName(meta.self?.name) ?? '',
      ...(meta.self?.avatar ? { avatar: meta.self.avatar } : {}),
      isGuest: meta.self?.isGuest ?? true,
      since: meta.since ?? 0,
      stats,
      ratings: chess ? { chess } : {},
    }
    // Field by field, so nothing private can ride along on a public profile. A
    // public page says which day a game was played, not the minute, and names
    // its opponents without linking them: an opponent's handle would let anyone
    // who finds this page walk on to every profile it touches, and from those
    // to theirs. The owner's own page keeps the links to people they played.
    if (!owner)
      return {
        ...base,
        since: base.since && dayOf(base.since) * DAY_MS,
        recent: recent.map(({ code: _code, at, opponents, ...rest }) => ({
          ...rest,
          opponents: opponents.map(({ handle: _handle, ...opponent }) => opponent),
          at: dayOf(at) * DAY_MS,
        })),
      }
    const active: ActiveTable[] = this.sql
      .exec<{
        code: string
        game: string
        status: string
        seats: number
        opponents: string
        your_turn: number
        updated_at: number
      }>(`SELECT * FROM tables WHERE status != 'gone' ORDER BY your_turn DESC, updated_at DESC`)
      .toArray()
      .map((row) => ({
        code: row.code,
        game: row.game as GameId,
        status: row.status as ActiveTable['status'],
        seats: row.seats,
        opponents: JSON.parse(row.opponents) as string[],
        yourTurn: row.your_turn === 1,
        updatedAt: row.updated_at,
      }))
    const pushSubscriptions = this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM subscriptions`).one().n
    return { ...base, recent, active, pushSubscriptions }
  }

  async subscribe(subscription: PushSubscriptionKeys): Promise<void> {
    this.schema()
    this.sql.exec(
      `INSERT INTO subscriptions (endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?)
        ON CONFLICT (endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth`,
      subscription.endpoint,
      subscription.p256dh,
      subscription.auth,
      Date.now(),
    )
    this.sql.exec(
      `DELETE FROM subscriptions WHERE endpoint NOT IN
        (SELECT endpoint FROM subscriptions ORDER BY created_at DESC LIMIT ?)`,
      MAX_SUBSCRIPTIONS,
    )
  }

  async unsubscribe(endpoint: string): Promise<void> {
    if (!this.exists()) return
    this.sql.exec(`DELETE FROM subscriptions WHERE endpoint = ?`, endpoint)
  }

  /**
   * Tell this player's browsers something about a room — at most once every
   * `NOTIFY_EVERY_MS` per kind and room, however often the room asks. Answers
   * how many browsers it went to (0 when throttled or nobody subscribed).
   */
  async notify(kind: NotifyKind, code: string, message: PushMessage, now = Date.now()): Promise<number> {
    if (!this.exists()) return 0
    const keys =
      this.env.VAPID_PUBLIC_KEY && this.env.VAPID_PRIVATE_KEY
        ? {
            publicKey: this.env.VAPID_PUBLIC_KEY,
            privateKey: this.env.VAPID_PRIVATE_KEY,
            subject: this.env.VAPID_SUBJECT || 'https://games.manishbisht.me',
          }
        : null
    const subscriptions = this.sql
      .exec<{ endpoint: string; p256dh: string; auth: string }>(
        `SELECT endpoint, p256dh, auth FROM subscriptions`,
      )
      .toArray()
    if (!keys || !subscriptions.length) return 0
    const key = `${kind}:${code}`
    const last = this.sql.exec<{ at: number }>(`SELECT at FROM notified WHERE k = ?`, key).toArray()[0]
    if (last && now - last.at < NOTIFY_EVERY_MS) return 0
    this.sql.exec(
      `INSERT INTO notified (k, at) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET at = excluded.at`,
      key,
      now,
    )
    let delivered = 0
    await Promise.all(
      subscriptions.map(async (subscription) => {
        let status = 0
        try {
          status = await sendPush(subscription, message, keys, this.fetcher)
        } catch {
          status = 0
        }
        // Gone for good: the browser unsubscribed or the user revoked permission.
        if (status === 404 || status === 410) await this.unsubscribe(subscription.endpoint)
        if (status >= 200 && status < 300) delivered++
        track(this.env, 'push_sent', {
          detail: `${kind}:${status >= 200 && status < 300 ? 'delivered' : status === 404 || status === 410 ? 'gone' : 'failed'}`,
        })
      }),
    )
    return delivered
  }
}
