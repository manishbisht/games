import { REPLAY_LIMITS } from '@games/shared/protocol'
import type { GameId, ReplayPlayer, SeatId } from '@games/shared/protocol'

/** The game a log is being written for, as this instance last saw it. */
interface Current {
  id: number
  /** The last state's sequence number; the next is one more. */
  seq: number
  /** The last state written, as stored, so a save that changed nothing writes nothing. */
  last: string | null
}

/**
 * A room's game log, in the room's own SQLite database: one row per state it
 * entered, already redacted to the spectator's view by the caller, so nothing
 * stored here was ever secret.
 *
 * It keeps the game being played and the one before it — a rematch starts a
 * new log and the oldest goes — and caps each at `maxStates`, letting the
 * opening go first: every row is a whole state, so a log missing its start
 * still plays from wherever it begins.
 *
 * Every write is synchronous and lands in the same output-gated batch as the
 * room's own `storage.put` that follows it, so a state is logged exactly when
 * it is saved. `deleteAll()` takes the tables with the rest of the room; call
 * `forget()` after it so this instance stops believing they exist.
 */
export class ReplayLog {
  private ready = false
  private current: Current | null | undefined

  constructor(
    private sql: SqlStorage,
    private maxStates: number = REPLAY_LIMITS.states,
    private maxGames: number = REPLAY_LIMITS.games,
  ) {}

  private schema(): void {
    if (this.ready) return
    this.sql.exec(`CREATE TABLE IF NOT EXISTS replay_games (
      id INTEGER PRIMARY KEY,
      game TEXT NOT NULL,
      players TEXT NOT NULL,
      finished INTEGER NOT NULL DEFAULT 0,
      forfeited TEXT,
      dropped INTEGER NOT NULL DEFAULT 0
    )`)
    this.sql.exec(`CREATE TABLE IF NOT EXISTS replay_states (
      game INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      at INTEGER NOT NULL,
      state TEXT NOT NULL,
      PRIMARY KEY (game, seq)
    ) WITHOUT ROWID`)
    this.ready = true
  }

  /** The game being logged, read back from the tables once per instance. */
  private game(): Current | null {
    if (this.current !== undefined) return this.current
    this.schema()
    const game = this.sql
      .exec<{ id: number }>('SELECT id FROM replay_games ORDER BY id DESC LIMIT 1')
      .toArray()[0]
    if (!game) return (this.current = null)
    const last = this.sql
      .exec<{ seq: number; state: string }>(
        'SELECT seq, state FROM replay_states WHERE game = ? ORDER BY seq DESC LIMIT 1',
        game.id,
      )
      .toArray()[0]
    return (this.current = { id: game.id, seq: last?.seq ?? -1, last: last?.state ?? null })
  }

  /** A game has been dealt: start its log, and let go of any older than the last one. */
  begin(game: GameId, players: ReplayPlayer[]): void {
    const id = (this.game()?.id ?? 0) + 1
    this.sql.exec(
      'INSERT INTO replay_games (id, game, players) VALUES (?, ?, ?)',
      id,
      game,
      JSON.stringify(players),
    )
    const oldest = id - this.maxGames
    this.sql.exec('DELETE FROM replay_states WHERE game <= ?', oldest)
    this.sql.exec('DELETE FROM replay_games WHERE id <= ?', oldest)
    this.current = { id, seq: -1, last: null }
  }

  /** The game entered `view` at `at`. Nothing is written when it looks exactly as it did. */
  record(view: unknown, at: number): void {
    const current = this.game()
    if (!current) return
    const state = JSON.stringify(view)
    if (state === current.last) return
    const seq = ++current.seq
    current.last = state
    this.sql.exec(
      'INSERT INTO replay_states (game, seq, at, state) VALUES (?, ?, ?, ?)',
      current.id,
      seq,
      at,
      state,
    )
    if (seq < this.maxStates) return
    this.sql.exec('DELETE FROM replay_states WHERE game = ? AND seq <= ?', current.id, seq - this.maxStates)
    this.sql.exec('UPDATE replay_games SET dropped = ? WHERE id = ?', seq - this.maxStates + 1, current.id)
  }

  /** The game is over; from now on its log is on offer. */
  finish(forfeited: SeatId[] | undefined): void {
    const current = this.game()
    if (!current) return
    this.sql.exec(
      'UPDATE replay_games SET finished = 1, forfeited = ? WHERE id = ?',
      forfeited?.length ? JSON.stringify(forfeited) : null,
      current.id,
    )
  }

  /**
   * The latest finished game as the `Replay` wire shape, already serialised —
   * the states are stored as JSON, so they are spliced in rather than parsed
   * and stringified again. Null when no game in this room has finished.
   */
  read(expiresAt: number): string | null {
    this.schema()
    const game = this.sql
      .exec<{ id: number; game: string; players: string; forfeited: string | null; dropped: number }>(
        'SELECT id, game, players, forfeited, dropped FROM replay_games WHERE finished = 1 ORDER BY id DESC LIMIT 1',
      )
      .toArray()[0]
    if (!game) return null
    const states: string[] = []
    for (const row of this.sql.exec<{ at: number; state: string }>(
      'SELECT at, state FROM replay_states WHERE game = ? ORDER BY seq',
      game.id,
    ))
      states.push(`{"at":${row.at},"state":${row.state}}`)
    return (
      `{"game":${JSON.stringify(game.game)},"players":${game.players},"states":[${states.join(',')}],` +
      `"finished":true${game.forfeited ? `,"forfeited":${game.forfeited}` : ''}` +
      `${game.dropped ? ',"truncated":true' : ''},"expiresAt":${expiresAt}}`
    )
  }

  /** The room's storage has been wiped: nothing here exists any more. */
  forget(): void {
    this.ready = false
    this.current = undefined
  }
}
