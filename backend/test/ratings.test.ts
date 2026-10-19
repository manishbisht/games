import { env, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { MyProfile } from '@games/shared/protocol'
import { PROVISIONAL_GAMES } from '../src/elo'
import type { Env } from '../src/env'
import { playerHandle } from '../src/handles'
import { CREDIBLE_GAMES, RATED_PER_OPPONENT_DAILY } from '../src/player'
import { createRoom } from './helpers'

const testEnv = env as unknown as Env

interface Person {
  id: string
  name: string
  isGuest: boolean
}

const guest = (name: string): Person => ({ id: `guest:${crypto.randomUUID()}`, name, isGuest: true })
const member = (name: string): Person => ({ id: `clerk:user_${crypto.randomUUID()}`, name, isGuest: false })

const stub = async (person: Person) => testEnv.PLAYER.getByName(await playerHandle(person.id))
const profile = async (person: Person) =>
  (await (await stub(person)).profile(await playerHandle(person.id), true)) as MyProfile

/**
 * Hand a room a finished chess game between `white` and `black` — Black
 * mates — the way its save would, without playing one: the rules for what is
 * rated live in `recordFinish`, and this is the door into it.
 */
let round = 0
async function finish(code: string, white: Person, black: Person) {
  await runInDurableObject(testEnv.ROOM.getByName(code), async (instance) => {
    await (instance as unknown as { recordFinish(finished: unknown): Promise<void> }).recordFinish({
      game: 'chess',
      code,
      round: ++round,
      seatIds: ['w', 'b'],
      seats: {
        w: { player: white, wantsRematch: false },
        b: { player: black, wantsRematch: false },
      },
      gameState: { status: 'checkmate', winner: 'b', history: [{}, {}, {}, {}] },
      forfeited: [],
      at: Date.now(),
    })
  })
}

/** A player with a settled rating (past the provisional games), and `played` games on their record. */
async function settled(person: Person, played = PROVISIONAL_GAMES) {
  const player = await stub(person)
  await player.record({
    self: { name: person.name, isGuest: person.isGuest },
    game: 'prism',
    code: 'SEEDED',
    round: 1,
    result: 'win',
    seats: 2,
    opponents: [],
    at: Date.now() - 86_400_000,
  })
  await runInDurableObject(player, (instance) => {
    const sql = (instance as unknown as { sql: SqlStorage }).sql
    sql.exec(`UPDATE stats SET played = ?`, played)
    sql.exec(
      `UPDATE meta SET v = json_set(v, '$.chess', json(?)) WHERE k = 'meta'`,
      JSON.stringify({ rating: 1500, games: PROVISIONAL_GAMES, peak: 1500 }),
    )
  })
}

const ratingOf = async (person: Person) => (await profile(person)).ratings.chess?.rating

describe('who a chess game is rated for', () => {
  it('rates two newcomers’ first game, as before', async () => {
    const { code } = await createRoom()
    const [ann, ben] = [guest('Ann'), guest('Ben')]
    await finish(code, ann, ben)
    expect(await ratingOf(ann)).toBe(1180)
    expect(await ratingOf(ben)).toBe(1220)
  })

  it('moves nothing for a settled player beating a throwaway guest, but counts it for the guest', async () => {
    const { code } = await createRoom()
    const farmer = guest('Farmer')
    await settled(farmer)
    const throwaway = guest('Fresh')
    await finish(code, throwaway, farmer)
    expect(await ratingOf(farmer)).toBe(1500)
    expect((await profile(farmer)).recent[0].rating).toBeUndefined()
    // The newcomer is still provisional, so the game counts for them.
    expect(await ratingOf(throwaway)).toBeLessThan(1200)
  })

  it('rates a settled player against a guest with a record, or anyone signed in', async () => {
    const { code } = await createRoom()
    const pro = guest('Pro')
    await settled(pro)
    const regular = guest('Regular')
    await settled(regular, CREDIBLE_GAMES)
    await finish(code, regular, pro)
    expect(await ratingOf(pro)).toBeGreaterThan(1500)

    const other = guest('Other')
    await settled(other)
    await finish(code, member('Signed in'), other)
    expect(await ratingOf(other)).toBeGreaterThan(1500)
  })

  it('rates only a few games a day against the same opponent', async () => {
    const { code } = await createRoom()
    const [ann, ben] = [guest('Ann'), guest('Ben')]
    for (let game = 0; game < RATED_PER_OPPONENT_DAILY + 2; game++) await finish(code, ann, ben)
    const record = await profile(ben)
    expect(record.recent).toHaveLength(RATED_PER_OPPONENT_DAILY + 2)
    expect(record.recent.filter((game) => game.rating)).toHaveLength(RATED_PER_OPPONENT_DAILY)
    expect(record.ratings.chess?.games).toBe(RATED_PER_OPPONENT_DAILY)
    // Somebody else is a fresh count.
    const cy = guest('Cy')
    await finish(code, cy, ben)
    expect((await profile(ben)).ratings.chess?.games).toBe(RATED_PER_OPPONENT_DAILY + 1)
  })
})
