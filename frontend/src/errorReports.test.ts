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
      { names: ['Margaret'], code: 'ABC234' },
    )
    expect(text).toBe('Seat for <name> (<id>, <email>) in <room> at https://games.manishbisht.me/ failed')
  })

  it('scrubs a full name whole, and its parts on their own', () => {
    expect(
      scrubText('No seat for Margaret Hale; Margaret left; hale.m joined', {
        names: ['Margaret', 'Hale', 'Margaret Hale', 'hale.m'],
      }),
    ).toBe('No seat for <name>; <name> left; <name> joined')
  })

  it('leaves a short name alone rather than every word that contains it', () => {
    expect(scrubText('Cannot read properties of undefined', { names: ['Al'] })).toBe(
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

  it("scrubs a signed-in player's account names as well as a guest's", async () => {
    store.set('games-guest-name', 'Robin')
    const { reportError, setReportNames } = await import('./errorReports')
    setReportNames(['Margaret Hale', 'Margaret', null, 'mhale'])
    reportError('boundary', new Error('Seat label "Margaret Hale (mhale)" for Robin is stale'))
    setReportNames([])
    reportError('boundary', new Error('Margaret Hale again'))
    expect(beacons.map((b) => (b.body as { message: string }).message)).toEqual([
      'Error: Seat label "<name> (<name>)" for <name> is stale',
      'Error: Margaret Hale again',
    ])
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
