import { describe, expect, it } from 'vitest'
import { PROTOCOL_VERSION } from '@games/shared/protocol'
import type { RoomSnapshot } from '@games/shared/protocol'
import { claimTarget, rematchState, roomBeats, seatPlayers, unseenBeats } from './session'
import type { RoomBeat } from './session'

const snap = (gameState: unknown, extra: Partial<RoomSnapshot> = {}): RoomSnapshot => ({
  protocol: PROTOCOL_VERSION,
  code: 'KX3F9M',
  game: 'hearth',
  visibility: 'private',
  status: 'playing',
  seatIds: ['p0', 'p1', 'p2'],
  seats: {
    p0: { player: { name: 'Ann', isGuest: true }, connected: true, wantsRematch: true },
    p1: { player: { name: 'Ben', isGuest: true }, connected: false, wantsRematch: true, awaySince: 5 },
    p2: {
      player: { name: 'Bot', isGuest: true },
      connected: true,
      wantsRematch: false,
      bot: { skill: 'easy' },
    },
  },
  gameState,
  ...extra,
})
const you = { id: 'guest:a', seat: 'p0', isHost: true }

describe('roomBeats', () => {
  it('keeps only the run since the last gap in the game, timed from arrival', () => {
    const a = { n: 1 },
      b = { n: 2 },
      c = { n: 3 }
    const recent = [
      { seq: 1, snapshot: snap(a), receivedAt: 100 },
      { seq: 2, snapshot: snap(null), receivedAt: 200 },
      { seq: 3, snapshot: snap(b, { timing: { now: 1000, since: 900 } }), receivedAt: 300 },
      { seq: 4, snapshot: snap(c), receivedAt: 400 },
    ]
    const beats = roomBeats<{ n: number }>({ snapshot: recent[3].snapshot, receivedAt: 400, recent })
    expect(beats.map((beat) => beat.state.n)).toEqual([2, 3])
    // 100ms of the beat had passed at the server when it was sent.
    expect(beats[0].since).toBe(200)
  })
})

describe('seats, rematch and claims', () => {
  it('maps seats to the game’s keys and leaves bots out of a rematch', () => {
    const snapshot = snap({})
    const players = seatPlayers(snapshot, (_seat, i) => (['red', 'blue', 'green'] as const)[i])
    expect(players.blue).toMatchObject({ name: 'Ben', connected: false, awaySince: 5 })
    expect(rematchState(snapshot, you)).toEqual({ mine: true, theirs: true })
    expect(claimTarget(players, 'blue', 'red', false)?.name).toBe('Ben')
    expect(claimTarget(players, 'blue', null, false)).toBeNull()
    expect(claimTarget(players, 'green', 'red', false)).toBeNull()
  })
})

describe('unseenBeats', () => {
  const beats = (...seqs: number[]): RoomBeat<number>[] => seqs.map((seq) => ({ seq, state: seq, since: 0 }))
  it('shows only the newest on a first look, and catches up', () => {
    expect(unseenBeats(beats(3, 4, 5), null)).toEqual({ beats: beats(5), catchUp: true })
  })
  it('plays every unseen beat in order when following along', () => {
    expect(unseenBeats(beats(3, 4, 5), 3)).toEqual({ beats: beats(4, 5), catchUp: false })
  })
  it('jumps to the newest after a gap wider than it holds', () => {
    expect(unseenBeats(beats(8, 9), 3)).toEqual({ beats: beats(9), catchUp: true })
  })
  it('does nothing when nothing is new', () => {
    expect(unseenBeats(beats(3, 4), 4).beats).toEqual([])
  })
})
