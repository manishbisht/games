import { env, runInDurableObject, SELF } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION, REACTION_LIMITS } from '@games/shared/protocol'
import type { ServerMessage } from '@games/shared/protocol'
import type { Env } from '../src/env'
import { JOIN_DEADLINE_MS, MAX_FRAME_CHARS, MAX_PENDING_SOCKETS, MESSAGE_LIMITS } from '../src/room'
import { connect, createRoom, WAIT, type Client } from './helpers'

const testEnv = env as unknown as Env

const rooms = (client: Client) => client.messages.filter((m) => m.type === 'room')
const errors = (client: Client, code: string) =>
  client.messages.filter((m) => m.type === 'error' && m.code === code)

/** A host in a chess room, joined and sitting. */
async function hosted() {
  const { code, guestId } = await createRoom('private', 'Ann')
  const host = await connect(code)
  host.join('Ann', guestId)
  host.send({ type: 'sit', seat: 'w' })
  await host.waitRoom((m) => m.you.seat === 'w')
  return { code, guestId, host }
}

describe('joining', () => {
  it('takes one join per socket, and closes one that keeps trying', async () => {
    const { code, host } = await hosted()
    host.join('Ann again')
    await host.expectError('BAD_MESSAGE')
    expect(errors(host, 'BAD_MESSAGE').at(-1)).toMatchObject({ message: 'Already joined.' })

    const pest = await connect(code)
    for (let attempt = 0; attempt < 3; attempt++)
      pest.send({ type: 'join', protocol: 99, name: 'Pest', guestId: crypto.randomUUID() })
    await vi.waitFor(() => expect(errors(pest, 'PROTOCOL_MISMATCH')).toHaveLength(3), WAIT)
    pest.join('Pest')
    await vi.waitFor(() => expect(pest.closes).toEqual([{ code: 1008 }]), WAIT)
    expect(rooms(pest)).toHaveLength(0)
  })

  it('lets go of sockets that never join, oldest first, and on a deadline', async () => {
    const { code, host } = await hosted()
    const silent: Client[] = []
    for (let i = 0; i < MAX_PENDING_SOCKETS; i++) silent.push(await connect(code))
    // One more than the room holds unjoined: the oldest makes way.
    const newest = await connect(code)
    await vi.waitFor(() => expect(silent[0].closes).toEqual([{ code: 1013 }]), WAIT)
    expect(silent.slice(1).every((client) => client.closes.length === 0)).toBe(true)
    // A real player still gets in, and the host never noticed any of it.
    newest.join('Ben')
    await newest.waitRoom(() => true)

    // The rest run out of time. Their clocks are wound forward rather than waited out.
    await runInDurableObject(testEnv.ROOM.getByName(code), (instance, state) => {
      for (const ws of state.getWebSockets()) {
        const attachment = ws.deserializeAttachment() as { at?: number; player?: unknown }
        if (!attachment.player)
          ws.serializeAttachment({ ...attachment, at: Date.now() - JOIN_DEADLINE_MS - 1 })
      }
      ;(instance as unknown as { sweepPending(now: number): void }).sweepPending(Date.now())
    })
    for (const client of silent.slice(1)) await vi.waitFor(() => expect(client.closes).toHaveLength(1), WAIT)
    expect(host.closes).toEqual([])
    expect(newest.closes).toEqual([])
  })
})

describe('message allowance', () => {
  it('refuses a frame too large to be a real one, before reading it', async () => {
    const { host } = await hosted()
    host.ws.send(JSON.stringify({ type: 'sit', seat: 'w', padding: 'x'.repeat(MAX_FRAME_CHARS) }))
    await vi.waitFor(
      () =>
        expect(
          errors(host, 'BAD_MESSAGE').some((m) => m.type === 'error' && /too large/.test(m.message)),
        ).toBe(true),
      WAIT,
    )
    expect(host.closes).toEqual([])
  })

  it('plays a real burst through, says so once when it runs dry, and closes a flood', async () => {
    const { code, host } = await hosted()
    const watcher = await connect(code)
    watcher.join('Wes')
    await watcher.waitRoom(() => true)
    // A burst a person could produce — a reconnect flushing its queue — goes through whole.
    const before = errors(host, 'NOT_ALLOWED').length + errors(host, 'BAD_MESSAGE').length
    for (let i = 0; i < 20; i++) host.send({ type: 'removeBot', seat: 'b' })
    await vi.waitFor(() => expect(errors(host, 'NOT_ALLOWED').length - before).toBe(20), WAIT)
    expect(errors(host, 'RATE_LIMITED')).toHaveLength(0)

    // A script does not stop there.
    for (let i = 0; i < MESSAGE_LIMITS.burst * 3; i++) watcher.send({ type: 'sit', seat: 'nope' })
    await vi.waitFor(() => expect(watcher.closes).toEqual([{ code: 1008 }]), WAIT)
    expect(errors(watcher, 'RATE_LIMITED')).toHaveLength(1)
    // The flood cost the room nothing it showed anyone else.
    expect(host.closes).toEqual([])
    await host.waitRoom((m) => m.snapshot.spectators === 0)
  })
})

describe('a room under a crowd', () => {
  it('answers a browser’s close at once, so it can reconnect at once', async () => {
    const { host } = await hosted()
    const started = Date.now()
    host.ws.close(1000, 'leaving')
    await vi.waitFor(() => expect(host.closes).toHaveLength(1), { timeout: 3000, interval: 10 })
    expect(Date.now() - started).toBeLessThan(3000)
  })

  it('tells the room about a crowd arriving in one snapshot, not one per arrival', async () => {
    const { code, host } = await hosted()
    const crowd = await Promise.all(Array.from({ length: 12 }, () => connect(code)))
    const before = rooms(host).length
    for (const [i, client] of crowd.entries()) client.join(`Fan ${i}`)
    // Everyone who arrived hears the room at once.
    for (const client of crowd) await client.waitRoom(() => true)
    await host.waitRoom((m) => m.snapshot.spectators === 12, before)
    // A few coalesced snapshots carried all twelve to the host, not one each.
    // (Usually one; a slow machine spreads the joins over more windows.)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(rooms(host).length - before).toBeLessThanOrEqual(6)

    // And again as they all leave.
    const leaving = rooms(host).length
    for (const client of crowd) client.ws.close()
    await host.waitRoom((m) => m.snapshot.spectators === 0, leaving)
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(rooms(host).length - leaving).toBeLessThanOrEqual(6)
  })

  it('never lets a coalesced snapshot undo a move it did not know about', async () => {
    const { code, host } = await hosted()
    const ben = await connect(code)
    ben.join('Ben')
    ben.send({ type: 'sit', seat: 'b' })
    await host.waitRoom((m) => Boolean(m.snapshot.seats.b))
    host.send({ type: 'start' })
    await host.waitRoom((m) => m.snapshot.status === 'playing')
    // Somebody arrives, and a move lands inside the coalescing window.
    const watcher = await connect(code)
    watcher.join('Wes')
    host.send({ type: 'action', action: { kind: 'move', from: 'e2', to: 'e4' } })
    await host.waitRoom((m) => m.snapshot.gameState?.history.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 200))
    // Whatever arrived after the move carries it.
    expect(rooms(host).at(-1)!.snapshot.gameState?.history).toHaveLength(1)
    expect(rooms(ben).at(-1)!.snapshot.gameState?.history).toHaveLength(1)
  })
})

describe('reactions', () => {
  it('give a person one allowance however many tabs they react from', async () => {
    const { code, guestId, host } = await hosted()
    const join = (client: Client) =>
      client.send({ type: 'join', protocol: PROTOCOL_VERSION, name: 'Ann', guestId, features: ['reactions'] })
    const tabs = [await connect(code), await connect(code)]
    for (const tab of tabs) {
      join(tab)
      await tab.waitRoom(() => true)
    }
    for (let i = 0; i < 4; i++) for (const tab of tabs) tab.send({ type: 'react', reaction: 'nice' })
    // A fence: the refused sit comes back after every reaction above was handled.
    for (const tab of tabs) {
      tab.send({ type: 'sit', seat: 'nope' })
      await tab.expectError('BAD_MESSAGE')
    }
    const heard = (tabs[0].messages as ServerMessage[]).filter((m) => m.type === 'reaction')
    expect(heard.length).toBeGreaterThanOrEqual(REACTION_LIMITS.seated.burst)
    expect(heard.length).toBeLessThanOrEqual(REACTION_LIMITS.seated.burst + 1)
    expect(host.closes).toEqual([])
  })
})

describe('who may open a socket', () => {
  const open = (code: string, origin?: string, base = 'https://api.test') =>
    SELF.fetch(`${base}/api/rooms/${code}`, {
      headers: { Upgrade: 'websocket', ...(origin ? { Origin: origin } : {}) },
    })

  it('the site, and scripts that say no origin; not another site', async () => {
    const { code } = await createRoom()
    expect((await open(code, 'https://games.manishbisht.me')).status).toBe(101)
    expect((await open(code)).status).toBe(101)
    expect((await open(code, 'https://evil.example')).status).toBe(403)
  })

  it('a localhost page only against a local server', async () => {
    const { code } = await createRoom()
    expect((await open(code, 'http://localhost:5173')).status).toBe(403)
    expect((await open(code, 'http://localhost:5173', 'http://127.0.0.1:8787')).status).toBe(101)
    expect((await open(code, 'http://127.0.0.1:4173', 'http://localhost:8787')).status).toBe(101)
  })
})
