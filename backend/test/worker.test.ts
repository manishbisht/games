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
