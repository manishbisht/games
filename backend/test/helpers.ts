import { SELF } from 'cloudflare:test'
import { expect, vi } from 'vitest'
import type { ServerMessage } from '@games/shared/protocol'

type RoomMessage = Extract<ServerMessage, { type: 'room' }>

export async function createRoom(visibility: 'private' | 'public' = 'private', name = 'Host', guestId = crypto.randomUUID()) {
  const res = await SELF.fetch('https://api.test/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ game: 'chess', visibility, name, guestId }),
  })
  expect(res.status).toBe(201)
  const { code } = await res.json<{ code: string }>()
  return { code, guestId }
}

export interface Client {
  ws: WebSocket
  messages: ServerMessage[]
  closes: { code: number }[]
  send: (message: unknown) => void
  join: (name: string, guestId?: string) => string
  waitRoom: (predicate: (room: RoomMessage) => boolean) => Promise<RoomMessage>
  expectError: (code: string) => Promise<void>
}

export async function connect(code: string): Promise<Client> {
  const res = await SELF.fetch(`https://api.test/api/rooms/${code}`, {
    headers: { Upgrade: 'websocket' },
  })
  expect(res.status).toBe(101)
  const ws = res.webSocket!
  ws.accept()
  const messages: ServerMessage[] = []
  const closes: { code: number }[] = []
  ws.addEventListener('message', (event) => messages.push(JSON.parse(event.data as string)))
  ws.addEventListener('close', (event) => closes.push({ code: event.code }))
  const client: Client = {
    ws,
    messages,
    closes,
    send: (message) => ws.send(JSON.stringify(message)),
    join: (name, guestId = crypto.randomUUID()) => {
      client.send({ type: 'join', protocol: 1, name, guestId })
      return guestId
    },
    waitRoom: (predicate) =>
      vi.waitFor(() => {
        const room = messages.filter((m): m is RoomMessage => m.type === 'room').findLast(predicate)
        expect(room).toBeDefined()
        return room!
      }),
    expectError: (code) =>
      vi.waitFor(() => {
        expect(messages.some((m) => m.type === 'error' && m.code === code)).toBe(true)
      }),
  }
  return client
}
