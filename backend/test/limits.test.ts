import { SELF } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clientKey } from '../src/limits'

/**
 * A fresh documentation-range address per test, so no test inherits another's
 * count: the limiters live as long as the test runtime does.
 */
let next = 1
const stranger = () => `198.51.100.${next++}`

const createFrom = (ip: string | null) =>
  SELF.fetch('https://api.test/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(ip ? { 'CF-Connecting-IP': ip } : {}) },
    body: JSON.stringify({ game: 'chess', name: 'Ann', guestId: crypto.randomUUID() }),
  })

const report = (body: unknown, ip: string | null = null, init: RequestInit = {}) =>
  SELF.fetch('https://api.test/api/errors', {
    method: 'POST',
    // What `navigator.sendBeacon` sends for a string: no preflight needed.
    headers: { 'content-type': 'text/plain;charset=UTF-8', ...(ip ? { 'CF-Connecting-IP': ip } : {}) },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    ...init,
  })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('rate limits', () => {
  /**
   * How many requests `send` gets through before its first 429. The binding
   * counts in fixed windows, so a run that straddles a window's edge can get
   * up to twice the limit through; anything in between is the limit working.
   */
  async function admittedBefore429(send: () => Promise<Response>, limit: number): Promise<number> {
    for (let sent = 0; sent <= 2 * limit; sent++) {
      const res = await send()
      if (res.status === 429) return sent
    }
    return Infinity
  }

  it('turns away an address making rooms too fast, and says when to come back', async () => {
    const ip = stranger()
    for (let room = 0; room < 20; room++) expect((await createFrom(ip)).status).toBe(201)
    const refused = await createFrom(ip)
    expect(refused.status).toBe(429)
    expect(refused.headers.get('Retry-After')).toBe('60')
    expect(await refused.json()).toEqual({ error: 'too many requests' })
    // Someone else is not held to that address's count.
    expect((await createFrom(stranger())).status).toBe(201)
  })

  it('never counts loopback, or a request that did not come through the edge', async () => {
    for (let room = 0; room < 22; room++) expect((await createFrom('127.0.0.1')).status).toBe(201)
    for (let room = 0; room < 22; room++) expect((await createFrom('::1')).status).toBe(201)
    for (let room = 0; room < 22; room++) expect((await createFrom(null)).status).toBe(201)
  })

  it('lets a reconnecting table open plenty of sockets, but not without end', async () => {
    const ip = stranger()
    const open = () =>
      SELF.fetch('https://api.test/api/rooms/ABCDEF', { headers: { 'CF-Connecting-IP': ip } })
    // Not upgrades: the room answers 426, which still costs the address a turn.
    const admitted = await admittedBefore429(open, 120)
    expect(admitted).toBeGreaterThanOrEqual(120)
    expect(admitted).toBeLessThanOrEqual(240)
  })

  it('counts a whole IPv6 /64 as one address, however the host rotates within it', async () => {
    const prefix = `2001:db8:${(next++).toString(16)}:7`
    let n = 0
    const admitted = await admittedBefore429(() => createFrom(`${prefix}:${(n++).toString(16)}::${n}`), 20)
    expect(admitted).toBeGreaterThanOrEqual(20)
    expect(admitted).toBeLessThanOrEqual(40)
    // The neighbouring /64 is somebody else.
    expect((await createFrom(`2001:db8:${(next++).toString(16)}:8::1`)).status).toBe(201)
  })

  it('limits presence beats per address', async () => {
    const ip = stranger()
    const beat = () =>
      SELF.fetch('https://api.test/api/presence', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'CF-Connecting-IP': ip },
        body: JSON.stringify({ clientId: 'client-limit-1', tabId: 'tab-limit-11' }),
      })
    const admitted = await admittedBefore429(beat, 40)
    expect(admitted).toBeGreaterThanOrEqual(40)
    expect(admitted).toBeLessThanOrEqual(80)
  })

  it('limits lobby reads per address', async () => {
    const ip = stranger()
    const read = () =>
      SELF.fetch('https://api.test/api/lobby?game=chess', { headers: { 'CF-Connecting-IP': ip } })
    const admitted = await admittedBefore429(read, 60)
    expect(admitted).toBeGreaterThanOrEqual(60)
    expect(admitted).toBeLessThanOrEqual(120)
  })

  it('keys on the address the edge saw', () => {
    const at = (ip?: string) =>
      clientKey(new Request('https://api.test/', { headers: ip ? { 'CF-Connecting-IP': ip } : {} }))
    expect(at('203.0.113.4')).toBe('203.0.113.4')
    // IPv6 by its /64: one subscriber's whole allocation is one key.
    expect(at('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(at('2001:db8:0:0:ffff:1:2:3')).toBe('2001:db8:0:0::/64')
    expect(at('2001:0DB8:00aa:0001:1::9')).toBe('2001:db8:aa:1::/64')
    expect(at('2001:db8:aa:2::9')).not.toBe(at('2001:db8:aa:1::9'))
    expect(at('::ffff:203.0.113.4')).toBe('203.0.113.4')
    for (const loopback of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1'])
      expect(at(loopback)).toBeNull()
    expect(at()).toBeNull()
  })
})

describe('client error reports', () => {
  const valid = {
    kind: 'error',
    message: 'TypeError: cannot read properties of undefined',
    stack: 'TypeError: …\n    at Board (assets/board-abc123.js:1:2)',
    route: '/chess/room/:code',
    release: 'abc1234',
  }

  it('logs one structured line per report', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await report(valid, null, {
      headers: { 'content-type': 'text/plain', 'user-agent': 'Probe/1.0' },
    })
    expect(res.status).toBe(204)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toMatchObject({ event: 'client_error', ...valid, userAgent: 'Probe/1.0' })
  })

  it('takes the four kinds the page sends, with only a message required', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const kind of ['error', 'rejection', 'boundary', 'webgl'])
      expect((await report({ kind, message: 'x' })).status).toBe(204)
  })

  it('refuses anything that is not a report, without logging it', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    for (const body of [
      'not json',
      'null',
      '[]',
      { ...valid, kind: 'other' },
      { ...valid, message: '' },
      { ...valid, message: 7 },
      { ...valid, message: 'x'.repeat(501) },
      { ...valid, stack: 'x'.repeat(4001) },
      { ...valid, route: 3 },
    ])
      expect((await report(body)).status).toBe(400)
    expect(log).not.toHaveBeenCalled()
  })

  it('refuses an oversized body before reading it', async () => {
    const res = await report({ ...valid, stack: 'x'.repeat(9000) })
    expect(res.status).toBe(413)
  })

  it('cuts off a body that declares no length once it passes the cap', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const chunk = new TextEncoder().encode('x'.repeat(1024))
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        // Far more than the cap, if the server kept reading.
        if (sent++ < 64) controller.enqueue(chunk)
        else controller.close()
      },
    })
    const res = await SELF.fetch('https://api.test/api/errors', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body,
      // @ts-expect-error -- workerd needs this for a streamed request body, and the DOM types lack it.
      duplex: 'half',
    })
    expect(res.status).toBe(413)
    expect(sent).toBeLessThan(64)
    expect(log).not.toHaveBeenCalled()
  })

  it('limits how many one address may send', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const ip = stranger()
    for (let sent = 0; sent < 30; sent++) expect((await report(valid, ip)).status).toBe(204)
    expect((await report(valid, ip)).status).toBe(429)
  })
})
