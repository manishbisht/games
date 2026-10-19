import { env, runInDurableObject, SELF } from 'cloudflare:test'
import { expect, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@games/shared/protocol'
import type { GameId, ServerMessage } from '@games/shared/protocol'
import type { GameState } from '@games/shared/chess/types'
import type { Env } from '../src/env'
import type { RoomRecord } from '../src/room'

/**
 * Long enough for a beat the room paces itself. Vitest's default is 1s, and
 * Hearth's `pass` pause alone is 1.7s — so under a full suite, where fifteen
 * runner Workers share one event loop, the default turned real waits into
 * failures that passed the moment the file ran on its own.
 */
export const WAIT = { timeout: 10_000, interval: 25 }

/** Tests read chess snapshots directly; other games narrow `gameState` themselves. */
type RoomMessage = Extract<ServerMessage<GameState>, { type: 'room' }>

export async function createRoom(
  visibility: 'private' | 'public' = 'private',
  name = 'Host',
  guestId = crypto.randomUUID(),
  game: GameId = 'chess',
  seats?: number,
) {
  const res = await SELF.fetch('https://api.test/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ game, visibility, name, guestId, ...(seats ? { seats } : {}) }),
  })
  expect(res.status).toBe(201)
  const { code } = await res.json<{ code: string }>()
  return { code, guestId }
}

export interface Client {
  ws: WebSocket
  messages: ServerMessage<GameState>[]
  closes: { code: number }[]
  send: (message: unknown) => void
  join: (name: string, guestId?: string) => string
  /** Where the log stands now: hand it to `waitRoom` to ask only about what arrives after. */
  mark: () => number
  /**
   * The newest snapshot matching `predicate`, from `from` onwards (the whole log
   * by default). Searching the whole log is only right for a state the room
   * reaches once: a phase it passes through every turn is already in the log
   * from the last one, and finding that answers before the server has moved.
   */
  waitRoom: (predicate: (room: RoomMessage) => boolean, from?: number) => Promise<RoomMessage>
  expectError: (code: string) => Promise<void>
}

export async function connect(code: string): Promise<Client> {
  const res = await SELF.fetch(`https://api.test/api/rooms/${code}`, {
    headers: { Upgrade: 'websocket' },
  })
  expect(res.status).toBe(101)
  const ws = res.webSocket!
  ws.accept()
  const messages: ServerMessage<GameState>[] = []
  const closes: { code: number }[] = []
  ws.addEventListener('message', (event) => {
    messages.push(JSON.parse(event.data as string))
  })
  ws.addEventListener('close', (event) => {
    closes.push({ code: event.code })
  })
  const client: Client = {
    ws,
    messages,
    closes,
    send: (message) => ws.send(JSON.stringify(message)),
    join: (name, guestId = crypto.randomUUID()) => {
      client.send({ type: 'join', protocol: PROTOCOL_VERSION, name, guestId })
      return guestId
    },
    mark: () => messages.length,
    waitRoom: (predicate, from = 0) =>
      vi.waitFor(() => {
        const room = messages
          .slice(from)
          .filter((m): m is RoomMessage => m.type === 'room')
          .findLast(predicate)
        expect(room).toBeDefined()
        return room!
      }, WAIT),
    expectError: (code) =>
      vi.waitFor(() => {
        expect(messages.some((m) => m.type === 'error' && m.code === code)).toBe(true)
      }, WAIT),
  }
  return client
}

/**
 * Run the game beat the room is holding now, rather than waiting out its real
 * pacing. Only ever a *game* deadline, and only while `ready` says the room is
 * still where the test left it — otherwise it answers `false` and does nothing.
 *
 * Both guards are there because workerd also delivers these alarms itself, in
 * the background, whenever a beat's real seconds run out — and under a full
 * suite a beat can run out between a test looking at the room and firing it.
 * Unguarded, that fire either resolved the *next* beat the test never meant to
 * skip, or — once the game had come to rest and the alarm slot belonged to the
 * room's 24h expiry again — expired the room outright, closing every socket
 * mid-test. Either way the state the test then waits for is the same, so which
 * of the two alarms moved the table no longer decides the outcome.
 *
 * Firing early means backdating `autoAt` first: `alarm()` refuses to resolve a
 * phase before it is due (see `AUTO_AT_TOLERANCE_MS` in src/room.ts). One
 * `runInDurableObject` round trip, mirroring `runDurableObjectAlarm`'s own
 * get/delete/call sequence.
 */
export const fire = (code: string, ready: (record: RoomRecord) => boolean = () => true) =>
  runInDurableObject((env as unknown as Env).ROOM.getByName(code), async (instance, state) => {
    const record = await state.storage.get<RoomRecord>('room')
    if (!record || record.autoAt === undefined || !ready(record)) return false
    if (record.autoAt > Date.now()) record.autoAt = Date.now()
    await state.storage.put('room', record)
    // Keep the in-memory cache coherent with storage (same-object contract).
    ;(instance as unknown as { cached: RoomRecord }).cached = record
    await state.storage.deleteAlarm()
    await instance.alarm()
    return true
  })
