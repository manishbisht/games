import { env, runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import { REPLAY_LIMITS } from '@games/shared/protocol'
import type { GameId, Replay } from '@games/shared/protocol'
import type { GameState as ChessState } from '@games/shared/chess/types'
import type { GameState as PrismState } from '@games/shared/prism/types'
import type { Env } from '../src/env'
import type { RoomRecord } from '../src/room'
import { ReplayLog } from '../src/replay'
import { connect, WAIT } from './helpers'

const testEnv = env as unknown as Env

/** A solo table against one bot, dealt the moment its host arrives. */
async function botTable(game: GameId, skill: string, name = 'Ann') {
  const guestId = crypto.randomUUID()
  const res = await SELF.fetch('https://api.test/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      game,
      visibility: 'private',
      name,
      guestId,
      seats: 2,
      bots: [skill],
      autoStart: true,
    }),
  })
  expect(res.status).toBe(201)
  const { code } = await res.json<{ code: string }>()
  const host = await connect(code)
  host.join(name, guestId)
  await host.waitRoom((m) => m.snapshot.status === 'playing')
  return { code, host }
}

const fetchReplay = (code: string, query = '') =>
  SELF.fetch(`https://api.test/api/rooms/${code}/replay${query}`)

async function replayOf<S = unknown>(code: string): Promise<Replay<S>> {
  const res = await fetchReplay(code)
  expect(res.status).toBe(200)
  expect(res.headers.get('content-type')).toBe('application/json')
  expect(res.headers.get('cache-control')).toBe('no-store')
  return res.json<Replay<S>>()
}

/** What the room's own tables hold, read straight out of its SQLite database. */
const stored = (code: string) =>
  runInDurableObject(testEnv.ROOM.getByName(code), async (_instance, state) => {
    const tables = state.storage.sql
      .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'replay_%'")
      .toArray()
      .map((row) => row.name)
    if (!tables.includes('replay_games')) return null
    return {
      games: state.storage.sql
        .exec<{ id: number; finished: number }>('SELECT id, finished FROM replay_games ORDER BY id')
        .toArray(),
      states: state.storage.sql
        .exec<{ game: number; state: string }>('SELECT game, state FROM replay_states ORDER BY game, seq')
        .toArray(),
      record: await state.storage.get<RoomRecord>('room'),
    }
  })

/** The host resigns the chess game in front of them, and the room calls it. */
async function resign(host: Awaited<ReturnType<typeof botTable>>['host']) {
  const from = host.mark()
  host.send({ type: 'action', action: { kind: 'resign' } })
  await host.waitRoom((m) => m.snapshot.status === 'finished', from)
}

describe('replays', () => {
  it('offers nothing while the first game is still being played', async () => {
    const { code } = await botTable('chess', 'easy')
    const res = await fetchReplay(code)
    expect(res.status).toBe(404)
    // …but it is being written all the same.
    const db = await stored(code)
    expect(db!.games).toEqual([{ id: 1, finished: 0 }])
    expect(db!.states.length).toBeGreaterThanOrEqual(1)
  })

  it('records every state of a finished game, stamped and in order, in the wire shape', async () => {
    const { code, host } = await botTable('chess', 'easy')
    await resign(host)
    const replay = await replayOf<ChessState>(code)
    expect(replay.game).toBe('chess')
    expect(replay.finished).toBe(true)
    expect(replay.players).toEqual([
      { seat: 'w', name: 'Ann' },
      { seat: 'b', name: expect.any(String), bot: { skill: 'easy' } },
    ])
    expect(replay.states.length).toBeGreaterThanOrEqual(2)
    expect(replay.states[0].state.status).toBe('playing')
    expect(replay.states.at(-1)!.state.status).not.toBe('playing')
    for (const [index, frame] of replay.states.entries()) {
      expect(typeof frame.at).toBe('number')
      if (index) expect(frame.at).toBeGreaterThanOrEqual(replay.states[index - 1].at)
    }
    expect(replay.truncated).toBeUndefined()
    expect(replay.expiresAt).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000)
    // The last frame is the table as it finished, exactly as a spectator was sent it.
    const last = host.messages.findLast((m) => m.type === 'room')
    expect(last?.type === 'room' && last.snapshot.gameState).toEqual(replay.states.at(-1)!.state)
  })

  it('never logs a card nobody at the table could see', async () => {
    const { code } = await botTable('prism', 'easy')
    const db = (await stored(code))!
    const live = db.record!.gameState as PrismState
    // Somebody holds real cards right now, which is what makes the check mean something.
    expect(live.players.some((player) => player.hand.some((card) => !card.id.startsWith('hidden')))).toBe(
      true,
    )
    expect(db.states.length).toBeGreaterThanOrEqual(1)
    const secrets = new Set([
      ...live.players.flatMap((player) => player.hand.map((card) => card.id)),
      ...live.drawPile.map((card) => card.id),
    ])
    for (const row of db.states) {
      const state = JSON.parse(row.state) as PrismState
      for (const player of state.players) for (const card of player.hand) expect(card.id).toMatch(/^hidden-/)
      for (const card of state.drawPile) expect(card.id).toMatch(/^hidden-/)
      expect(state.drawnCardId).toBeNull()
      for (const id of secrets) expect(row.state).not.toContain(`"${id}"`)
    }
  })

  it('keeps the finished game on offer through a rematch, then rolls over, keeping two', async () => {
    const { code, host } = await botTable('chess', 'easy')
    await resign(host)
    const first = await replayOf<ChessState>(code)

    // The rematch swaps colours; the bot opens as White.
    let from = host.mark()
    host.send({ type: 'rematch' })
    await host.waitRoom((m) => m.snapshot.status === 'playing' && m.you.seat === 'b', from)
    // Mid-game, the last finished game is still the one on offer — never the live one.
    expect(await replayOf<ChessState>(code)).toEqual({ ...first, expiresAt: expect.any(Number) })

    await host.waitRoom((m) => (m.snapshot.gameState?.history.length ?? 0) >= 1)
    await resign(host)
    const second = await replayOf<ChessState>(code)
    expect(second.players.map((player) => player.seat)).toEqual(['w', 'b'])
    expect(second.players[1].name).toBe('Ann')
    expect(second.states[0].at).toBeGreaterThan(first.states.at(-1)!.at)

    from = host.mark()
    host.send({ type: 'rematch' })
    await host.waitRoom((m) => m.snapshot.status === 'playing', from)
    const db = (await stored(code))!
    // The game just dealt and the one before it; the first is gone, states and all.
    expect(db.games).toEqual([
      { id: 2, finished: 1 },
      { id: 3, finished: 0 },
    ])
    expect(new Set(db.states.map((row) => row.game))).toEqual(new Set([2, 3]))
  })

  it('says not found for a room that never was, and for one that has expired', async () => {
    expect((await fetchReplay('ZZZZZZ')).status).toBe(404)
    expect((await fetchReplay('not-a-code')).status).toBe(404)

    const { code, host } = await botTable('chess', 'easy')
    await resign(host)
    expect((await fetchReplay(code, '?game=current')).status).toBe(400)
    expect((await fetchReplay(code, '?game=last')).status).toBe(200)

    expect(await runDurableObjectAlarm(testEnv.ROOM.getByName(code))).toBe(true)
    await vi.waitFor(() => expect(host.closes[0]?.code).toBe(4408), WAIT)
    expect((await fetchReplay(code)).status).toBe(404)
    // The log went with the room.
    expect(await stored(code)).toBeNull()
  })
})

describe('the replay log', () => {
  /** A log over a database nothing else is using. */
  const scratch = <T>(run: (log: ReplayLog, sql: SqlStorage) => T, maxStates?: number) =>
    runInDurableObject(testEnv.ROOM.getByName(`LOG${crypto.randomUUID().slice(0, 8)}`), (_instance, state) =>
      run(new ReplayLog(state.storage.sql, maxStates), state.storage.sql),
    )

  it('caps a game at its newest states, saying it let the opening go', async () => {
    const replay = await scratch((log) => {
      log.begin('chess', [{ seat: 'w', name: 'Ann' }])
      for (let n = 0; n < 12; n++) log.record({ n }, 1000 + n)
      log.finish(undefined)
      return JSON.parse(log.read(5)!) as Replay<{ n: number }>
    }, 5)
    expect(replay.states.map((frame) => frame.state.n)).toEqual([7, 8, 9, 10, 11])
    expect(replay.states.map((frame) => frame.at)).toEqual([1007, 1008, 1009, 1010, 1011])
    expect(replay.truncated).toBe(true)
    expect(replay.expiresAt).toBe(5)
  })

  it('writes nothing for a state that looks exactly as the last one did', async () => {
    const rows = await scratch((log, sql) => {
      log.begin('prism', [])
      log.record({ a: 1 }, 1)
      log.record({ a: 1 }, 2)
      log.record({ a: 2 }, 3)
      return sql.exec('SELECT at FROM replay_states').toArray()
    })
    expect(rows.map((row) => row.at)).toEqual([1, 3])
  })

  it('picks up where it left off after the instance is evicted', async () => {
    const replay = await scratch((log, sql) => {
      log.begin('chess', [])
      log.record({ n: 0 }, 1)
      const again = new ReplayLog(sql)
      again.record({ n: 0 }, 2)
      again.record({ n: 1 }, 3)
      again.finish(['b'])
      return JSON.parse(again.read(9)!) as Replay
    })
    expect(replay.states).toEqual([
      { at: 1, state: { n: 0 } },
      { at: 3, state: { n: 1 } },
    ])
    expect(replay.forfeited).toEqual(['b'])
  })

  it('caps at the documented limits by default', () => {
    expect(REPLAY_LIMITS).toEqual({ games: 2, states: 3000 })
  })
})
