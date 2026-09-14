import type { ErrorCode, GameId, SeatId } from '../protocol/types'

export interface OnlineSeat {
  id: SeatId
  name: string
}

/**
 * Everything a game may learn about the outside world. Adapters are otherwise
 * pure functions of their state, so a room can replay, redact and auto-advance
 * them without surprises — and `random`/`now` stay injectable for tests.
 */
export interface Ctx {
  random(): number
  now: number
}

/**
 * Everything a game needs to play a seat nobody is behind. `skills` is an
 * opaque id list the adapter validates, exactly as `validateOptions` is —
 * skill is not one concept across games. Chess, Hearth and Prism grade
 * strength; Estate has one bot; Wildrise's are pace, because a race has no
 * decisions to be good at. Human-readable labels are presentation and live
 * in the frontend beside `seatLabel`.
 */
export interface BotSupport<S = unknown> {
  /** Skill ids this game accepts. The first is the default. */
  skills: readonly string[]
  /** Display name for the bot taking `seat`; `index` is its position among the room's bots. */
  name(seat: SeatId, index: number): string
  /** Play one decision for a bot seat. Returns `state` unchanged when it has none to make. */
  decide(state: S, seat: SeatId, seats: SeatId[], skill: string, ctx: Ctx): S
  /** How long the room pauses before the decision lands, so a bot reads as thinking. */
  thinkMs?(skill: string): number
}

/**
 * The seam between the generic room and one game's rules. The room owns seats,
 * presence and broadcasting; the adapter owns everything about the game itself,
 * including who is allowed to do what.
 */
export interface GameAdapter<S = unknown, A = unknown> {
  id: GameId
  minSeats: number
  maxSeats: number
  /** When true the host cannot start until every seat is taken (chess). */
  requireFull: boolean
  /** The seat ids for a game of `count` players, in turn order. */
  seatIds(count: number): SeatId[]
  /** Room options from the create call, narrowed to whatever this game accepts. */
  validateOptions(raw: unknown): unknown
  /** Parse an off-the-wire action; `null` rejects it as malformed. */
  validateAction(raw: unknown): A | null
  create(seats: OnlineSeat[], options: unknown, ctx: Ctx): S
  /** Apply a seat's decision action. Authorization (turn order etc.) lives here. */
  apply(
    state: S,
    seat: SeatId,
    seats: SeatId[],
    action: A,
    ctx: Ctx,
  ): { state: S } | { error: ErrorCode; message: string }
  /** Presentation auto-advance: non-null while state sits in a timing-only phase. */
  pending(state: S): { afterMs: number; resolve(state: S, ctx: Ctx): S } | null
  /** Per-viewer redaction — hide the hands nobody at this seat may see. */
  view(state: S, seat: SeatId | null): S
  isFinished(state: S): boolean
  /** Seats the game is blocked on, which is who an abandonment claim targets. */
  waitingOn(state: S, seats: SeatId[]): SeatId[]
  /**
   * Settle an absent seat's claim: either play it out (a stand-in move) or hand
   * back `null`, which ends the game where it stands.
   */
  resolveAbsent(state: S, seat: SeatId, seats: SeatId[], ctx: Ctx): S | null
  /** How this game plays a seat nobody is behind; `null` when it has no bots. */
  bots: BotSupport<S> | null
  /** A fresh game for the same table; `seatRemap` rotates who sits where. */
  rematch(
    prev: S,
    seats: OnlineSeat[],
    options: unknown,
    ctx: Ctx,
  ): { state: S; seatRemap?: Record<SeatId, SeatId> }
}
