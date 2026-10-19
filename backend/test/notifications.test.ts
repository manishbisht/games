import { env, runInDurableObject, SELF } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import type { Env } from '../src/env'
import { playerHandle } from '../src/handles'
import { NOTIFY_EVERY_MS } from '../src/player'
import type { PlayerDO } from '../src/player'
import { b64uDecode } from '../src/push'
import { connect, createRoom, WAIT, type Client } from './helpers'

const testEnv = env as unknown as Env

/** The RFC 8291 example browser key: any valid P-256 point and 16-byte secret will do. */
const KEYS = {
  p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
}

interface Sent {
  url: string
  headers: Headers
  bytes: number
}

/**
 * Subscribe a guest through the API, and point their record's pushes at a fake
 * push service that answers `status` and remembers what it was sent.
 */
async function subscribe(guestId: string, status = 201) {
  const endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`
  const res = await SELF.fetch('https://api.test/api/push/subscription', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Guest-Id': guestId },
    body: JSON.stringify({ subscription: { endpoint, keys: KEYS } }),
  })
  expect(res.status).toBe(204)
  const sent: Sent[] = []
  const stub = testEnv.PLAYER.getByName(await playerHandle(`guest:${guestId}`))
  await runInDurableObject(stub, (instance: PlayerDO) => {
    instance.fetcher = async (input, init) => {
      sent.push({
        url: String(input),
        headers: new Headers(init?.headers),
        bytes: (init?.body as Uint8Array).length,
      })
      return new Response(null, { status })
    }
  })
  return { endpoint, sent, stub }
}

async function play(client: Client, from: string, to: string) {
  const before = client.messages.length
  client.send({ type: 'action', action: { kind: 'move', from, to } })
  return client.waitRoom(() => true, before)
}

describe('push subscriptions', () => {
  it('need credentials and a real push service', async () => {
    const post = (headers: Record<string, string>, subscription: unknown) =>
      SELF.fetch('https://api.test/api/push/subscription', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ subscription }),
      })
    const good = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: KEYS }
    expect((await post({}, good)).status).toBe(401)
    expect(
      (await post({ 'X-Guest-Id': crypto.randomUUID() }, { ...good, endpoint: 'https://evil.example/' }))
        .status,
    ).toBe(400)
    const guestId = crypto.randomUUID()
    expect((await post({ 'X-Guest-Id': guestId }, good)).status).toBe(204)
    const me = await (
      await SELF.fetch('https://api.test/api/me', { headers: { 'X-Guest-Id': guestId } })
    ).json<{
      pushSubscriptions: number
    }>()
    expect(me.pushSubscriptions).toBe(1)
    const removed = await SELF.fetch('https://api.test/api/push/subscription', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json', 'X-Guest-Id': guestId },
      body: JSON.stringify({ endpoint: good.endpoint }),
    })
    expect(removed.status).toBe(204)
  })

  it('serves the public key browsers subscribe with', async () => {
    const { key } = await (await SELF.fetch('https://api.test/api/push/key')).json<{ key: string }>()
    expect(b64uDecode(key)).toHaveLength(65)
  })
})

describe('turn notifications', () => {
  it('tells a player whose turn arrives while they are away, once', async () => {
    const { code, guestId: annId } = await createRoom('private', 'Ann')
    const ann = await connect(code)
    ann.join('Ann', annId)
    ann.send({ type: 'sit', seat: 'w' })
    const ben = await connect(code)
    const benId = ben.join('Ben')
    ben.send({ type: 'sit', seat: 'b' })
    await ann.waitRoom((m) => Boolean(m.snapshot.seats.b))
    const benPush = await subscribe(benId)
    const annPush = await subscribe(annId)
    ann.send({ type: 'start' })
    await ann.waitRoom((m) => m.snapshot.status === 'playing')
    // It is Ann's turn and she is here: nothing.
    await play(ann, 'e2', 'e4')
    await ben.waitRoom((m) => m.snapshot.gameState?.history.length === 1)
    await play(ben, 'e7', 'e5')
    // Ben steps away; Ann moves, and the turn comes round to an empty chair.
    ben.ws.close()
    await ann.waitRoom((m) => m.snapshot.seats.b?.connected === false)
    await play(ann, 'g1', 'f3')
    await vi.waitFor(() => expect(benPush.sent).toHaveLength(1), WAIT)
    expect(benPush.sent[0].url).toBe(benPush.endpoint)
    expect(benPush.sent[0].headers.get('Content-Encoding')).toBe('aes128gcm')
    expect(benPush.sent[0].headers.get('Topic')).toBe(`turn-${code}`)
    expect(annPush.sent).toHaveLength(0)
    // Throttled per room: asking again inside the window sends nothing.
    const again = await benPush.stub.notify('turn', code, {
      title: 't',
      body: 'b',
      path: `/chess/room/${code}`,
      tag: `turn-${code}`,
    })
    expect(again).toBe(0)
    expect(
      await benPush.stub.notify(
        'turn',
        code,
        { title: 't', body: 'b', path: '/', tag: 'x' },
        Date.now() + NOTIFY_EVERY_MS + 1,
      ),
    ).toBe(1)
  })

  it('tells an absent host somebody sat down, and forgets a subscription the service says is gone', async () => {
    const { code, guestId: hostId } = await createRoom('private', 'Hal', undefined, 'hearth', 2)
    const host = await connect(code)
    host.join('Hal', hostId)
    await host.waitRoom(() => true)
    const push = await subscribe(hostId, 410)
    host.ws.close()
    const guest = await connect(code)
    guest.join('Gus')
    guest.send({ type: 'sit', seat: 'p1' })
    await vi.waitFor(() => expect(push.sent).toHaveLength(1), WAIT)
    expect(push.sent[0].headers.get('Topic')).toBe(`joined-${code}`)
    await vi.waitFor(async () => {
      const me = await (
        await SELF.fetch('https://api.test/api/me', { headers: { 'X-Guest-Id': hostId } })
      ).json<{
        pushSubscriptions: number
      }>()
      expect(me.pushSubscriptions).toBe(0)
    }, WAIT)
  })
})
