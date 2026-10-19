import type { GameId } from '@games/shared/protocol'
import type { Env } from './env'

/**
 * Anonymous product analytics on Workers Analytics Engine (`ANALYTICS` in
 * wrangler.jsonc, dataset `games_events`). Server-side only, and nothing in a
 * data point can identify anybody: no player ids, handles, names, room codes or
 * addresses — just what happened, in which game, and a number or two.
 *
 * Every point has the same layout, so one query shape reads them all:
 *
 *   index1   event name (also the sampling key)
 *   blob1    event name
 *   blob2    game id ('' when the event has none)
 *   blob3    detail, per event (below)
 *   double1  a count, per event (below)
 *   double2  a second number, per event (below)
 *
 * | event          | blob3                              | double1        | double2          |
 * | -------------- | ---------------------------------- | -------------- | ---------------- |
 * | room_created   | 'public' / 'private'               | seats          | bots             |
 * | game_started   | 'fresh' / 'rematch'                | seats          | bots             |
 * | game_finished  | 'finished' / 'abandoned'           | duration bucket (minutes: 1, 5, 15, 30, 60, 120, 240+) | seats |
 * | player_left    | 'mid-game'                         | 1              |                  |
 * | player_back    | 'mid-game'                         | 1              |                  |
 * | reaction       | reaction id ('gg', 'wow', …)       | 1              | 1 if spectator   |
 * | push_sent      | 'turn' / 'joined' + ':' + outcome  | 1              |                  |
 *
 * Example — games finished per game per day over the last week (Analytics
 * Engine SQL API, or a Grafana panel on it):
 *
 *   SELECT toStartOfDay(timestamp) AS day, blob2 AS game, SUM(_sample_interval) AS games
 *   FROM games_events
 *   WHERE blob1 = 'game_finished' AND blob3 = 'finished' AND timestamp > NOW() - INTERVAL '7' DAY
 *   GROUP BY day, game ORDER BY day, game
 *
 * `SUM(_sample_interval)` rather than `COUNT()`, so the numbers stay right if
 * Analytics Engine ever samples a busy event.
 */
export type AnalyticsEvent =
  'room_created' | 'game_started' | 'game_finished' | 'player_left' | 'player_back' | 'reaction' | 'push_sent'

export function track(
  env: Pick<Env, 'ANALYTICS'>,
  event: AnalyticsEvent,
  {
    game,
    detail = '',
    count = 1,
    value = 0,
  }: { game?: GameId; detail?: string; count?: number; value?: number },
): void {
  // Absent in tests and in any config without the binding: analytics is never
  // a reason for a move to fail.
  try {
    env.ANALYTICS?.writeDataPoint({
      indexes: [event],
      blobs: [event, game ?? '', detail],
      doubles: [count, value],
    })
  } catch {
    // Writes are fire-and-forget by design; a rejected one is not the room's problem.
  }
}

/** Minutes, rounded up onto a few coarse steps — a length of game, not a timestamp. */
export function durationBucket(ms: number): number {
  const minutes = ms / 60_000
  for (const step of [1, 5, 15, 30, 60, 120]) if (minutes <= step) return step
  return 240
}
