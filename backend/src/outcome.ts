import type { GameId, GameResult, SeatId } from '@games/shared/protocol'

/**
 * How a finished game came out for each seat, read off the game's own final
 * state. This lives beside the room rather than in each adapter because only the
 * server's record-keeping asks the question, and the adapters already say
 * everything needed: who won, and how far everyone else got.
 *
 * The states are read structurally (a field at a time, defensively) rather than
 * through each game's types, so a game reshaping its state for its own reasons
 * can at worst cost a placing here, never break the room. The room's tests pin
 * down every game's reading.
 */
export interface SeatOutcome {
  result: GameResult
  /** 1-based, only for tables of more than two. Ties share a place. */
  place?: number
}

type Loose = Record<string, unknown>
const players = (state: Loose): Loose[] => (Array.isArray(state.players) ? (state.players as Loose[]) : [])

/**
 * Every game but chess seats `seatIds[i]` as `players[i]`, and names its winner
 * by that player's own `id` (a number for Estate and Prism, a colour for
 * Hearth and Wildrise). Chess names the winning colour, which is its seat.
 */
function winnerSeat(game: GameId, state: Loose, seatIds: SeatId[]): SeatId | null {
  const winner = state.winner
  if (winner === null || winner === undefined) return null
  if (game === 'chess') return seatIds.includes(winner as SeatId) ? (winner as SeatId) : null
  const index = players(state).findIndex((player) => player.id === winner)
  return index >= 0 && index < seatIds.length ? seatIds[index] : null
}

/** A game that ended with nobody ahead: a chess draw of any kind, or a Prism deck run dry. */
function drawn(game: GameId, state: Loose): boolean {
  if (game === 'chess') return state.status !== 'playing' && state.winner === null
  if (game === 'prism') return state.status === 'draw'
  return false
}

/**
 * How far along each player got, higher is better, for ranking the seats behind
 * the winner. Only asked of games with more than two seats.
 */
function progress(game: GameId, state: Loose): number[] {
  const list = players(state)
  switch (game) {
    case 'hearth': {
      const pieces = Array.isArray(state.pieces) ? (state.pieces as Loose[]) : []
      return list.map((player) =>
        pieces
          .filter((piece) => piece.playerId === player.id)
          .reduce((sum, piece) => sum + (typeof piece.progress === 'number' ? piece.progress : 0), 0),
      )
    }
    case 'wildrise':
      return list.map((player) => (typeof player.position === 'number' ? player.position : 0))
    case 'prism':
      return list.map((player) => -(Array.isArray(player.hand) ? player.hand.length : 0))
    case 'estate':
      return list.map((player) =>
        player.bankrupt ? -Infinity : typeof player.cash === 'number' ? player.cash : 0,
      )
    default:
      return list.map(() => 0)
  }
}

/** Standard competition ranking ("1, 2, 2, 4") of `scores`, higher first. */
function places(scores: number[]): number[] {
  return scores.map((score) => 1 + scores.filter((other) => other > score).length)
}

/**
 * Each seat's result. `forfeited` names seats the room ended the game against
 * (a granted claim, an absence nobody could stand in for), which matters only
 * when the game itself had not decided anything.
 */
export function outcomeOf(
  game: GameId,
  rawState: unknown,
  seatIds: SeatId[],
  forfeited: SeatId[] = [],
): Record<SeatId, SeatOutcome> {
  const state = (rawState && typeof rawState === 'object' ? rawState : {}) as Loose
  const out: Record<SeatId, SeatOutcome> = {}
  const winner = winnerSeat(game, state, seatIds)
  if (winner) {
    if (seatIds.length <= 2) {
      for (const seat of seatIds) out[seat] = { result: seat === winner ? 'win' : 'loss' }
      return out
    }
    // The winner is first however the tie-breaks fall; everyone else is ranked
    // by how far they got, from second place down.
    const others = seatIds.filter((seat) => seat !== winner)
    const scores = progress(game, state)
    const ranked = places(others.map((seat) => scores[seatIds.indexOf(seat)] ?? 0))
    out[winner] = { result: 'win', place: 1 }
    others.forEach((seat, index) => (out[seat] = { result: 'loss', place: ranked[index] + 1 }))
    return out
  }
  if (drawn(game, state) || !forfeited.length) {
    for (const seat of seatIds) out[seat] = { result: 'draw' }
    return out
  }
  // The game was ended against somebody: they lose. One player left standing
  // has won; several have simply not lost.
  const standing = seatIds.filter((seat) => !forfeited.includes(seat))
  for (const seat of seatIds)
    out[seat] = {
      result: forfeited.includes(seat) ? 'loss' : standing.length === 1 ? 'win' : 'draw',
    }
  return out
}
