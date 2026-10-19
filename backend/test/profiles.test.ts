import { env, SELF } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import type { MyProfile, PublicProfile } from '@games/shared/protocol'
import type { Env } from '../src/env'
import { playerHandle } from '../src/handles'
import { connect, createRoom, WAIT, type Client } from './helpers'

const testEnv = env as unknown as Env

const me = (guestId: string | null, headers: Record<string, string> = {}) =>
  SELF.fetch('https://api.test/api/me', {
    headers: { ...(guestId ? { 'X-Guest-Id': guestId } : {}), ...headers },
  })

async function profileOf(guestId: string): Promise<MyProfile> {
  const res = await me(guestId)
  expect(res.status).toBe(200)
  return res.json<MyProfile>()
}

const handleOf = (guestId: string) => playerHandle(`guest:${guestId}`)

/** Wait for a player's record to say what `check` wants (records are written after the move lands). */
const until = (guestId: string, check: (profile: MyProfile) => void) =>
  vi.waitFor(async () => {
    const profile = await profileOf(guestId)
    check(profile)
    return profile
  }, WAIT)

async function play(client: Client, from: string, to: string) {
  const before = client.messages.filter((m) => m.type === 'room').length
  client.send({ type: 'action', action: { kind: 'move', from, to } })
  return client.waitRoom(() => true, before)
}

/** Two people sat at a chessboard, game on. */
async function chessTable() {
  const { code, guestId: annId } = await createRoom('private', 'Ann')
  const ann = await connect(code)
  ann.join('Ann', annId)
  ann.send({ type: 'sit', seat: 'w' })
  const ben = await connect(code)
  const benId = ben.join('Ben')
  ben.send({ type: 'sit', seat: 'b' })
  await ann.waitRoom((m) => Boolean(m.snapshot.seats.b))
  return { code, ann, ben, annId, benId }
}

/** Fool's mate: Black wins on move two. */
async function foolsMate(ann: Client, ben: Client) {
  await play(ann, 'f2', 'f3')
  await play(ben, 'e7', 'e5')
  await play(ann, 'g2', 'g4')
  await play(ben, 'd8', 'h4')
  await ann.waitRoom((m) => m.snapshot.status === 'finished')
}

describe('GET /api/me', () => {
  it('needs credentials the way the room socket does', async () => {
    expect((await me(null)).status).toBe(401)
    expect((await me('not-a-uuid')).status).toBe(401)
    // A Clerk token with no Clerk configured verifies as nobody, not as a guest.
    expect((await me(null, { Authorization: 'Bearer some.jwt.here' })).status).toBe(401)
    const fresh = await me(crypto.randomUUID())
    expect(fresh.status).toBe(200)
    expect(fresh.headers.get('Cache-Control')).toBe('no-store')
    const profile = await fresh.json<MyProfile>()
    expect(profile).toMatchObject({ stats: {}, recent: [], active: [], ratings: {} })
  })

  it('lists the tables a player is sitting at, and their turn, until the game ends', async () => {
    const { code, ann, ben, annId, benId } = await chessTable()
    const annBefore = await until(annId, (p) => expect(p.active).toHaveLength(1))
    expect(annBefore.active[0]).toMatchObject({ code, game: 'chess', status: 'open', opponents: ['Ben'] })
    ann.send({ type: 'start' })
    await until(annId, (p) => expect(p.active[0]).toMatchObject({ status: 'playing', yourTurn: true }))
    await until(benId, (p) => expect(p.active[0]).toMatchObject({ status: 'playing', yourTurn: false }))
    await play(ann, 'e2', 'e4')
    await until(benId, (p) => expect(p.active[0].yourTurn).toBe(true))
    await until(annId, (p) => expect(p.active[0].yourTurn).toBe(false))
    ann.send({ type: 'action', action: { kind: 'resign' } })
    await ben.waitRoom((m) => m.snapshot.status === 'finished')
    await until(annId, (p) => expect(p.active).toEqual([]))
    await until(benId, (p) => expect(p.active).toEqual([]))
  })

  it('drops a table the player got up from', async () => {
    const { code, guestId } = await createRoom('private', 'Cy', undefined, 'hearth', 3)
    const cy = await connect(code)
    cy.join('Cy', guestId)
    cy.send({ type: 'sit', seat: 'p0' })
    await until(guestId, (p) => expect(p.active.map((t) => t.code)).toEqual([code]))
    cy.send({ type: 'leaveSeat' })
    await until(guestId, (p) => expect(p.active).toEqual([]))
  })
})

describe('finished games', () => {
  it('records both sides, rates them, and keeps the room code private to its owner', async () => {
    const { code, ann, ben, annId, benId } = await chessTable()
    ann.send({ type: 'start' })
    await ann.waitRoom((m) => m.snapshot.status === 'playing')
    await foolsMate(ann, ben)
    const annProfile = await until(annId, (p) => expect(p.recent).toHaveLength(1))
    const benProfile = await until(benId, (p) => expect(p.recent).toHaveLength(1))
    const [annHandle, benHandle] = await Promise.all([handleOf(annId), handleOf(benId)])

    expect(annProfile).toMatchObject({ handle: annHandle, name: 'Ann', isGuest: true })
    expect(annProfile.stats.chess).toEqual({ played: 1, wins: 0, losses: 1, draws: 0 })
    expect(benProfile.stats.chess).toEqual({ played: 1, wins: 1, losses: 0, draws: 0 })
    expect(annProfile.recent[0]).toMatchObject({
      code,
      game: 'chess',
      result: 'loss',
      seats: 2,
      opponents: [{ name: 'Ben', handle: benHandle }],
      rating: { before: 1200, after: 1180 },
    })
    expect(benProfile.ratings.chess).toEqual({ rating: 1220, games: 1, provisional: true, peak: 1220 })
    expect(annProfile.ratings.chess).toMatchObject({ rating: 1180, provisional: true })

    // Public: same numbers, no room code, and no trace of either guest id.
    const res = await SELF.fetch(`https://api.test/api/players/${benHandle}`)
    expect(res.status).toBe(200)
    const text = await res.text()
    for (const secret of [annId, benId, code, 'guest:']) expect(text).not.toContain(secret)
    const ben2 = JSON.parse(text) as PublicProfile
    expect(ben2).toMatchObject({ handle: benHandle, name: 'Ben', ratings: { chess: { rating: 1220 } } })
    expect(ben2.recent[0]).toMatchObject({ result: 'win', opponents: [{ name: 'Ann' }] })
    expect(ben2.recent[0]).not.toHaveProperty('code')
    expect(ben2).not.toHaveProperty('active')
    // Nobody else's profile is a link away from a public page, and it says
    // which day Ben played, not the minute.
    expect(text).not.toContain(annHandle)
    expect(ben2.recent[0].opponents[0]).not.toHaveProperty('handle')
    expect(ben2.recent[0].at % 86_400_000).toBe(0)
    expect(ben2.since % 86_400_000).toBe(0)
    expect(Date.now() - ben2.recent[0].at).toBeLessThan(86_400_000)
  })

  it('leaks no guest id through /api/me either', async () => {
    const { ann, ben, annId, benId } = await chessTable()
    ann.send({ type: 'start' })
    await ann.waitRoom((m) => m.snapshot.status === 'playing')
    await foolsMate(ann, ben)
    await until(annId, (p) => expect(p.recent).toHaveLength(1))
    const text = await (await me(annId)).text()
    // Its own id is the credential it sent; the opponent's must never come back.
    expect(text).not.toContain(benId)
    expect(text).not.toContain('guest:')
  })

  it('records a rematch as a second game, and leaves an aborted one unrated', async () => {
    const { ann, ben, annId } = await chessTable()
    ann.send({ type: 'start' })
    await ann.waitRoom((m) => m.snapshot.status === 'playing')
    // Resigned before a move: recorded, unrated.
    ann.send({ type: 'action', action: { kind: 'resign' } })
    await ann.waitRoom((m) => m.snapshot.status === 'finished')
    const first = await until(annId, (p) => expect(p.recent).toHaveLength(1))
    expect(first.recent[0].rating).toBeUndefined()
    expect(first.ratings.chess).toBeUndefined()
    ann.send({ type: 'rematch' })
    ben.send({ type: 'rematch' })
    const replay = await ann.waitRoom(
      (m) => m.snapshot.status === 'playing' && m.snapshot.gameState?.history.length === 0,
      ann.mark() - 1,
    )
    expect(replay).toBeDefined()
    const seat = replay.you.seat
    // Colours swap on a rematch; whoever is White now resigns at once again.
    ;(seat === 'w' ? ann : ben).send({ type: 'action', action: { kind: 'resign' } })
    await ann.waitRoom((m) => m.snapshot.status === 'finished', ann.mark() - 1)
    const second = await until(annId, (p) => expect(p.recent).toHaveLength(2))
    expect(second.stats.chess?.played).toBe(2)
  })

  it('records a game against a bot without rating it', async () => {
    const deeId = crypto.randomUUID()
    const res = await SELF.fetch('https://api.test/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        game: 'chess',
        visibility: 'private',
        name: 'Dee',
        guestId: deeId,
        bots: ['easy'],
        autoStart: true,
      }),
    })
    const { code } = await res.json<{ code: string }>()
    const dee = await connect(code)
    dee.join('Dee', deeId)
    await dee.waitRoom((m) => m.snapshot.status === 'playing')
    dee.send({ type: 'action', action: { kind: 'resign' } })
    await dee.waitRoom((m) => m.snapshot.status === 'finished')
    const profile = await until(deeId, (p) => expect(p.recent).toHaveLength(1))
    expect(profile.recent[0]).toMatchObject({ result: 'loss', opponents: [{ bot: true }] })
    expect(profile.recent[0].opponents[0]).not.toHaveProperty('handle')
    expect(profile.recent[0].rating).toBeUndefined()
    expect(profile.ratings.chess).toBeUndefined()
  })

  it('answers 404 for a handle nobody has played under, and for nonsense', async () => {
    expect(
      (await SELF.fetch(`https://api.test/api/players/${await handleOf(crypto.randomUUID())}`)).status,
    ).toBe(404)
    expect((await SELF.fetch('https://api.test/api/players/..%2F..%2Fetc')).status).toBe(404)
    expect((await SELF.fetch('https://api.test/api/players/ABC')).status).toBe(404)
  })
})

describe('players record', () => {
  it('counts a game handed over twice only once', async () => {
    const handle = await handleOf(crypto.randomUUID())
    const stub = testEnv.PLAYER.getByName(handle)
    const entry = {
      self: { name: 'Eve', isGuest: true },
      game: 'prism' as const,
      code: 'ABCDEF',
      round: 1,
      result: 'win' as const,
      place: 1,
      seats: 3,
      opponents: [{ name: 'Jules', bot: true }],
      at: Date.now(),
    }
    expect(await stub.record(entry)).toBe(true)
    expect(await stub.record(entry)).toBe(false)
    const profile = (await stub.profile(handle, false)) as PublicProfile
    expect(profile.stats.prism).toEqual({ played: 1, wins: 1, losses: 0, draws: 0 })
  })
})
