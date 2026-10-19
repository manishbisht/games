import { useEffect, useRef } from 'react'
import { beatElapsed } from '@games/shared/protocol'
import type { RoomSnapshot, SeatId, SeatInfo, YouInfo } from '@games/shared/protocol'
import type { SnapshotEntry } from './roomState'

/**
 * The parts of a game's online session every game was writing for itself: the
 * run of recent states a board should present, who is in which seat, where a
 * rematch stands, and the hook that hands a board each state it has not shown
 * yet, once, in order.
 */

/** One state the room sent, and when its beat began on this page's clock. */
export interface RoomBeat<S> {
  seq: number
  state: S
  /** `performance.now()` at which the room entered this state. */
  since: number
}

/**
 * When `snapshot`'s state began at the room, on this page's clock: the server
 * says how far in it was when it sent it, counted back from when it arrived —
 * not from when it rendered. An older server sends no timing, and the beat is
 * taken to start on arrival.
 */
export const beganAt = (snapshot: RoomSnapshot, receivedAt: number) =>
  receivedAt - beatElapsed(snapshot.timing)

/**
 * Recent game states, oldest first, ending with the current one. Only the run
 * since the last snapshot without a game counts: anything before a gap in the
 * game belongs to a table that is no longer on screen.
 */
export function roomBeats<S>({
  snapshot,
  receivedAt,
  recent,
}: {
  snapshot: RoomSnapshot
  receivedAt: number
  recent: SnapshotEntry[]
}): RoomBeat<S>[] {
  const run = recent.slice(recent.findLastIndex((entry) => !entry.snapshot.gameState) + 1)
  const beats = run.map((entry) => ({
    seq: entry.seq,
    state: entry.snapshot.gameState as S,
    since: beganAt(entry.snapshot, entry.receivedAt),
  }))
  if (snapshot.gameState && beats.at(-1)?.state !== snapshot.gameState)
    beats.push({
      seq: (beats.at(-1)?.seq ?? 0) + 1,
      state: snapshot.gameState as S,
      since: beganAt(snapshot, receivedAt),
    })
  return beats
}

/** What a game needs to know about whoever is in a seat. */
export interface SeatPlayer {
  name: string
  connected: boolean
  /** Server timestamp of when they dropped; absent while they are here. */
  awaySince?: number
  /** The room is already playing this seat — there is nothing left to claim. */
  abandoned?: boolean
  /** Nobody is behind this seat: the room plays it. */
  bot?: { skill: string }
}

export const seatPlayer = (info: SeatInfo): SeatPlayer => ({
  name: info.player.name,
  connected: info.connected,
  awaySince: info.awaySince,
  abandoned: info.abandoned,
  bot: info.bot,
})

/**
 * Seated players keyed the way the game names them (colours, player ids…).
 * `keyOf` maps the room's seat (and its index in `seatIds`) to that key; a seat
 * it has no key for is left out.
 */
export function seatPlayers<K extends string>(
  snapshot: RoomSnapshot,
  keyOf: (seat: SeatId, index: number) => K | undefined | null,
): Partial<Record<K, SeatPlayer>> {
  const players: Partial<Record<K, SeatPlayer>> = {}
  snapshot.seatIds.forEach((seat, index) => {
    const info = snapshot.seats[seat],
      key = keyOf(seat, index)
    if (info && key) players[key] = seatPlayer(info)
  })
  return players
}

/**
 * Where a rematch stands. Bots are left out: one never asks and the server never
 * waits for one, so counting them would leave the table "waiting" for a game
 * that has already restarted. `theirs` means everyone else at the table.
 */
export function rematchState(snapshot: RoomSnapshot, you: YouInfo) {
  const others = snapshot.seatIds.filter(
    (seat) => seat !== you.seat && snapshot.seats[seat] && !snapshot.seats[seat]!.bot,
  )
  return {
    mine: you.seat ? (snapshot.seats[you.seat]?.wantsRematch ?? false) : false,
    theirs: others.length > 0 && others.every((seat) => snapshot.seats[seat]!.wantsRematch),
  }
}

/**
 * Who a claim can be made against right now, or `null`: the table is stuck on
 * a seat whose player has gone, this browser holds a seat of its own (a
 * spectator has no standing), and no claim has been granted yet.
 */
export function claimTarget<K extends string>(
  players: Partial<Record<K, SeatPlayer>>,
  onTurn: K | null,
  mySeat: K | null,
  finished: boolean,
): SeatPlayer | null {
  if (mySeat === null || onTurn === null || finished || onTurn === mySeat) return null
  const blocker = players[onTurn]
  return blocker && !blocker.connected && !blocker.abandoned ? blocker : null
}

/**
 * Which beats a board should present, given the last one it showed. On its
 * first look, or after a gap wider than `recent` holds, only the newest — it
 * catches up to the room rather than replaying history. Otherwise every unseen
 * beat, in order.
 */
export function unseenBeats<S>(
  beats: RoomBeat<S>[],
  lastSeq: number | null,
): { beats: RoomBeat<S>[]; catchUp: boolean } {
  const newest = beats.at(-1)
  if (!newest) return { beats: [], catchUp: false }
  if (lastSeq === null) return { beats: [newest], catchUp: true }
  const unseen = beats.filter((beat) => beat.seq > lastSeq)
  if (!unseen.length) return { beats: [], catchUp: false }
  if (unseen[0].seq !== lastSeq + 1) return { beats: [newest], catchUp: true }
  return { beats: unseen, catchUp: false }
}

/**
 * Hands `present` every beat the board has not shown yet, once each and in
 * order (see `unseenBeats`). `catchUp` is true when the board is joining
 * rather than following along — land it, or fast-forward by the room's clock.
 */
export function usePresentBeats<S>(
  beats: RoomBeat<S>[],
  present: (beat: RoomBeat<S>, catchUp: boolean) => void,
) {
  const last = useRef<number | null>(null)
  const latest = useRef(present)
  useEffect(() => {
    latest.current = present
  })
  useEffect(() => {
    const next = unseenBeats(beats, last.current)
    for (const beat of next.beats) latest.current(beat, next.catchUp)
    if (next.beats.length) last.current = next.beats.at(-1)!.seq
  }, [beats])
}
