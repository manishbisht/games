import { describe, expect, it } from 'vitest'
import { connect, createRoom, type Client } from './helpers'

const historyLength = (client: Client) => {
  const rooms = client.messages.filter((m) => m.type === 'room')
  return rooms.at(-1)?.snapshot.gameState?.history.length ?? 0
}

async function play(client: Client, from: string, to: string, promotion?: string) {
  const before = historyLength(client)
  client.send({ type: 'action', action: { kind: 'move', from, to, promotion } })
  return client.waitRoom((m) => (m.snapshot.gameState?.history.length ?? 0) > before)
}

async function startGame() {
  const { code, guestId } = await createRoom()
  const host = await connect(code)
  host.join('Ann', guestId)
  host.send({ type: 'sit', seat: 'w' })
  const guest = await connect(code)
  guest.join('Ben')
  guest.send({ type: 'sit', seat: 'b' })
  await host.waitRoom((m) => Boolean(m.snapshot.seats.b))
  host.send({ type: 'start' })
  await host.waitRoom((m) => m.snapshot.status === 'playing')
  await guest.waitRoom((m) => m.snapshot.status === 'playing')
  return { host, guest, code }
}

describe('chess actions', () => {
  it('validates and broadcasts legal moves; rejects out-of-turn and illegal moves', async () => {
    const { host, guest } = await startGame()
    const after = await play(host, 'e2', 'e4')
    expect(after.snapshot.gameState?.history.at(-1)?.san).toBe('e4')
    await guest.waitRoom((m) => (m.snapshot.gameState?.history.length ?? 0) === 1)

    host.send({ type: 'action', action: { kind: 'move', from: 'd2', to: 'd4' } })
    await host.expectError('NOT_YOUR_TURN')
    guest.send({ type: 'action', action: { kind: 'move', from: 'e7', to: 'e4' } })
    await guest.expectError('ILLEGAL_MOVE')
  })

  it('requires a promotion piece and then promotes', async () => {
    const { host, guest } = await startGame()
    await play(host, 'e2', 'e4')
    await play(guest, 'd7', 'd5')
    await play(host, 'e4', 'd5')
    await play(guest, 'c7', 'c6')
    await play(host, 'd5', 'c6')
    await play(guest, 'g8', 'f6')
    await play(host, 'c6', 'b7')
    await play(guest, 'f6', 'd5')
    host.send({ type: 'action', action: { kind: 'move', from: 'b7', to: 'a8' } })
    await host.expectError('PROMOTION_REQUIRED')
    const after = await play(host, 'b7', 'a8', 'q')
    expect(after.snapshot.gameState?.history.at(-1)?.san).toBe('bxa8=Q')
  })

  it('finishes on checkmate and refuses further moves', async () => {
    const { host, guest } = await startGame()
    await play(host, 'f2', 'f3')
    await play(guest, 'e7', 'e5')
    await play(host, 'g2', 'g4')
    const mate = await play(guest, 'd8', 'h4')
    expect(mate.snapshot.status).toBe('finished')
    expect(mate.snapshot.gameState?.status).toBe('checkmate')
    expect(mate.snapshot.gameState?.winner).toBe('b')
    host.send({ type: 'action', action: { kind: 'move', from: 'a2', to: 'a3' } })
    await host.expectError('NOT_PLAYING')
  })

  it('handles resignation from either seat', async () => {
    const { host, guest } = await startGame()
    guest.send({ type: 'action', action: { kind: 'resign' } })
    const done = await host.waitRoom((m) => m.snapshot.status === 'finished')
    expect(done.snapshot.gameState?.status).toBe('resigned')
    expect(done.snapshot.gameState?.winner).toBe('w')
  })

  it('rejects actions from visitors without a seat and before the game starts', async () => {
    const { code, guestId } = await createRoom()
    const host = await connect(code)
    host.join('Ann', guestId)
    host.send({ type: 'action', action: { kind: 'resign' } })
    await host.expectError('NOT_SEATED')
    host.send({ type: 'sit', seat: 'w' })
    await host.waitRoom((m) => m.you.seat === 'w')
    host.send({ type: 'action', action: { kind: 'resign' } })
    await host.expectError('NOT_PLAYING')
  })

  it('starts a rematch with swapped colors once both players agree', async () => {
    const { host, guest } = await startGame()
    guest.send({ type: 'action', action: { kind: 'resign' } })
    await host.waitRoom((m) => m.snapshot.status === 'finished')

    host.send({ type: 'rematch' })
    const voted = await guest.waitRoom((m) => m.snapshot.seats.w?.wantsRematch === true)
    expect(voted.snapshot.status).toBe('finished')

    guest.send({ type: 'rematch' })
    // `status === 'playing'` alone would match the stale broadcast from the
    // original `startGame()` (already sitting in `host.messages`), and
    // `vi.waitFor` checks synchronously on its first call — so it must
    // resolve with a fresh signal that was never true before the swap.
    const fresh = await host.waitRoom((m) => m.snapshot.status === 'playing' && m.you.seat === 'b')
    expect(fresh.snapshot.gameState?.history).toEqual([])
    expect(fresh.you.seat).toBe('b')
    expect(fresh.snapshot.seats.w?.player.name).toBe('Ben')
    expect(fresh.snapshot.seats.b?.player.name).toBe('Ann')
  })

  it('rejects rematch while the game is still going', async () => {
    const { host } = await startGame()
    host.send({ type: 'rematch' })
    await host.expectError('NOT_FINISHED')
  })
})
