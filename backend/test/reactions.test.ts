import { describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION, REACTION_LIMITS } from '@games/shared/protocol'
import type { ServerMessage } from '@games/shared/protocol'
import { connect, createRoom, WAIT, type Client } from './helpers'

type Reaction = Extract<ServerMessage, { type: 'reaction' }>
const reactions = (client: Client) =>
  (client.messages as unknown as ServerMessage[]).filter((m): m is Reaction => m.type === 'reaction')

/** Join the way a current browser does: saying it understands reactions. */
function joinWithReactions(client: Client, name: string, guestId = crypto.randomUUID()) {
  client.send({ type: 'join', protocol: PROTOCOL_VERSION, name, guestId, features: ['reactions'] })
  return guestId
}

async function table() {
  const { code, guestId } = await createRoom('private', 'Ann')
  const ann = await connect(code)
  joinWithReactions(ann, 'Ann', guestId)
  ann.send({ type: 'sit', seat: 'w' })
  const ben = await connect(code)
  joinWithReactions(ben, 'Ben')
  ben.send({ type: 'sit', seat: 'b' })
  await ann.waitRoom((m) => Boolean(m.snapshot.seats.b))
  return { code, ann, ben }
}

describe('reactions', () => {
  it('passes a reaction round the room with the seat it came from, and keeps it out of snapshots', async () => {
    const { ann, ben } = await table()
    const snapshots = ann.messages.filter((m) => m.type === 'room').length
    ann.send({ type: 'react', reaction: 'wow' })
    await vi.waitFor(() => expect(reactions(ben)).toHaveLength(1), WAIT)
    await vi.waitFor(() => expect(reactions(ann)).toHaveLength(1), WAIT)
    const [seen] = reactions(ben)
    expect(seen).toMatchObject({ type: 'reaction', seat: 'w', reaction: 'wow' })
    expect(typeof seen.id).toBe('string')
    expect(Math.abs(seen.at - Date.now())).toBeLessThan(10_000)
    // Nothing about the room changed, so nothing was saved or re-sent.
    expect(ann.messages.filter((m) => m.type === 'room')).toHaveLength(snapshots)
  })

  it('lets a spectator react, as nobody in particular', async () => {
    const { code, ann } = await table()
    const watcher = await connect(code)
    joinWithReactions(watcher, 'Wes')
    await watcher.waitRoom(() => true)
    watcher.send({ type: 'react', reaction: 'haha' })
    await vi.waitFor(
      () => expect(reactions(ann).at(-1)).toMatchObject({ seat: null, reaction: 'haha' }),
      WAIT,
    )
  })

  it('only sends reactions to sockets that asked for them', async () => {
    const { code, ann } = await table()
    const old = await connect(code)
    old.join('Old tab')
    await old.waitRoom(() => true)
    ann.send({ type: 'react', reaction: 'gg' })
    await vi.waitFor(() => expect(reactions(ann)).toHaveLength(1), WAIT)
    // A round trip later, the old tab has still heard nothing.
    old.send({ type: 'sit', seat: 'nope' })
    await old.expectError('BAD_MESSAGE')
    expect(reactions(old)).toHaveLength(0)
  })

  it('refuses reactions outside the set, and drops a burst past the allowance', async () => {
    const { ann, ben } = await table()
    ann.send({ type: 'react', reaction: 'rude-word' })
    await ann.expectError('BAD_MESSAGE')
    for (let i = 0; i < 10; i++) ann.send({ type: 'react', reaction: 'nice' })
    await vi.waitFor(
      () => expect(reactions(ben).length).toBeGreaterThanOrEqual(REACTION_LIMITS.seated.burst),
      WAIT,
    )
    // A refused sit is a fence: the room handles a socket's frames in order, so
    // once its error is back every reaction above has been handled too.
    const errors = () => ann.messages.filter((m) => m.type === 'error').length
    const before = errors()
    ann.send({ type: 'sit', seat: 'nope' })
    await vi.waitFor(() => expect(errors()).toBe(before + 1), WAIT)
    // The burst, and at most one more if a refill landed while the ten arrived.
    expect(reactions(ben).length).toBeLessThanOrEqual(REACTION_LIMITS.seated.burst + 1)
  })

  it('needs a join first', async () => {
    const { code } = await createRoom()
    const stranger = await connect(code)
    stranger.send({ type: 'react', reaction: 'gg' })
    await stranger.expectError('NOT_JOINED')
  })
})
