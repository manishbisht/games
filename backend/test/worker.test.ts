import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

describe('worker routing', () => {
  it('serves health', async () => {
    const res = await SELF.fetch('https://api.test/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('answers CORS preflight for an allowed origin', async () => {
    const res = await SELF.fetch('https://api.test/api/rooms', {
      method: 'OPTIONS',
      headers: { Origin: 'https://games.manishbisht.me' },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://games.manishbisht.me')
  })

  it('rejects preflight from unknown origins', async () => {
    const res = await SELF.fetch('https://api.test/api/rooms', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example' },
    })
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('admits a localhost page only when the Worker itself is a local dev server', async () => {
    const preflight = (base: string, origin: string) =>
      SELF.fetch(`${base}/api/rooms`, { method: 'OPTIONS', headers: { Origin: origin } })
    // The deployed API: the site's own page and nothing else.
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:4173'])
      expect(
        (await preflight('https://api.test', origin)).headers.get('Access-Control-Allow-Origin'),
      ).toBeNull()
    // `wrangler dev`, tests, CI: any port on loopback, as Vite picks one.
    for (const base of ['http://127.0.0.1:8787', 'http://localhost:8787'])
      for (const origin of ['http://localhost:5173', 'http://127.0.0.1:4173'])
        expect((await preflight(base, origin)).headers.get('Access-Control-Allow-Origin')).toBe(origin)
    expect(
      (await preflight('http://127.0.0.1:8787', 'https://evil.example')).headers.get(
        'Access-Control-Allow-Origin',
      ),
    ).toBeNull()
  })

  it('answers 400, not 500, to bodies that are JSON but not an object', async () => {
    for (const path of ['/api/rooms', '/api/presence'])
      for (const body of ['null', '[]', '"room"']) {
        const res = await SELF.fetch(`https://api.test${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
        })
        expect(res.status).toBe(400)
      }
  })

  it('404s unknown routes', async () => {
    const res = await SELF.fetch('https://api.test/nope')
    expect(res.status).toBe(404)
  })
})
