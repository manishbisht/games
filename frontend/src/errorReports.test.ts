import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { scrubRoute, scrubText } from './errorReports'

describe('what an error report may say', () => {
  it('keeps the route and drops the room', () => {
    expect(scrubRoute('#/chess/room/ABC234')).toBe('/chess/room/:code')
    expect(scrubRoute('#/estate/room/XY7Z9Q?from=lobby')).toBe('/estate/room/:code')
    expect(scrubRoute('#/hearth')).toBe('/hearth')
    expect(scrubRoute('')).toBe('/')
  })

  it('scrubs ids, addresses, the player and the room out of the text', () => {
    const text = scrubText(
      'Seat for Margaret (4f1c2b9e-3a1d-4c5e-9f00-1234567890ab, maggie@example.com) in ABC234 at https://games.manishbisht.me/#/chess/room/ABC234 failed',
      { name: 'Margaret', code: 'ABC234' },
    )
    expect(text).toBe('Seat for <name> (<id>, <email>) in <room> at https://games.manishbisht.me/ failed')
  })

  it('leaves a short name alone rather than every word that contains it', () => {
    expect(scrubText('Cannot read properties of undefined', { name: 'Al' })).toBe(
      'Cannot read properties of undefined',
    )
  })
})

describe('sending reports', () => {
  let beacons: { url: string; body: unknown }[]
  let store: Map<string, string>

  beforeEach(() => {
    vi.resetModules()
    beacons = []
    store = new Map()
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    }
    vi.stubGlobal('sessionStorage', storage)
    vi.stubGlobal('localStorage', storage)
    vi.stubGlobal('location', { hash: '#/chess/room/ABC234' })
    vi.stubGlobal('navigator', {
      sendBeacon: (url: string, body: string) => {
        beacons.push({ url, body: JSON.parse(body) })
        return true
      },
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('sends each distinct error once, as a beacon, without the room', async () => {
    const { reportError } = await import('./errorReports')
    const error = new TypeError('board is undefined')
    reportError('error', error)
    reportError('error', error)
    reportError('rejection', 'socket closed')
    expect(beacons).toHaveLength(2)
    expect(beacons[0].url).toMatch(/\/api\/errors$/)
    expect(beacons[0].body).toMatchObject({
      kind: 'error',
      message: 'TypeError: board is undefined',
      route: '/chess/room/:code',
    })
    expect(beacons[1].body).toMatchObject({ kind: 'rejection', message: 'socket closed' })
  })

  it('says no more than ten things a session, across reloads', async () => {
    const first = await import('./errorReports')
    for (let n = 0; n < 6; n++) first.reportError('error', new Error(`one ${n}`))
    // A reload: the module starts again, the tab session does not.
    vi.resetModules()
    const second = await import('./errorReports')
    for (let n = 0; n < 6; n++) second.reportError('error', new Error(`two ${n}`))
    expect(beacons).toHaveLength(10)
  })
})
