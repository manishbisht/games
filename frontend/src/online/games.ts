import type { ComponentType, LazyExoticComponent } from 'react'
import type { GameId, ReplayFrame, ReplayPlayer, RoomSnapshot, SeatId, YouInfo } from '@games/shared/protocol'
import { games } from '../games/catalog'
import { lazyWithPreload } from '../lazyPreload'
import type { RoomApi } from './useRoom'
import type { ReactionEntry, SnapshotEntry } from './roomState'

/**
 * What a game gets once the room is live: the authoritative snapshot, who this
 * browser is, the wire, and the way out. Turning those into a playable table is
 * the game's job.
 */
export interface RoomViewProps {
  snapshot: RoomSnapshot
  /** When `snapshot` arrived (`performance.now()`), for syncing to its `timing`. */
  receivedAt: number
  /**
   * Recent snapshots in arrival order, newest last (`snapshot` itself). A burst
   * of messages renders once; a board that presents every state reads the
   * entries whose `seq` it has not seen yet.
   */
  recent: SnapshotEntry[]
  /**
   * Recent reactions, oldest first (see `ReactionEntry`). The room page already
   * floats each one up from the bottom of the screen; a table that would rather
   * show them beside the seat they came from can, and `<ReactionBar>` is the
   * control for sending them. Always passed by the room page; optional in the
   * type only so hand-built test props written before it still compile.
   */
  reactions?: ReactionEntry[]
  you: YouInfo
  api: RoomApi
  leave: () => void
}

/**
 * One thing a bot can be. The id is the server's — it validates against its own
 * adapter and the browser never sees the list — so this is the label for it,
 * and nothing more. Wildrise's three are pace rather than strength, which is
 * why the labels are written per game rather than generated from the id.
 */
export interface BotSkill {
  id: string
  label: string
}

/**
 * What a game's replay gets: a finished game's every state, as a spectator saw
 * it, and where the player bar's playhead is. The page owns the clock — play,
 * pause, step, scrub, speed — and the view only ever shows `states[index]`.
 *
 * Animate into a new index only when it is the next one (`index === previous
 * + 1`) while `playing`, and finish within `replayHoldMs(states, index, speed)`
 * (./replayTiming), the time that state stays on screen. Any other change — a
 * step back, a scrub, a jump to either end, a step while paused — lands on the
 * state at once (or with a short settle), because there is nothing between
 * the two states to show. Honour `reducedMotion()` as the live table does.
 */
export interface ReplayViewProps<S = unknown> {
  /** Every state the game passed through, oldest first. Fixed for the life of the view. */
  states: ReplayFrame<S>[]
  /** The state to show. */
  index: number
  /**
   * Playback is running. Still true as it arrives on the final state, so the
   * last move animates like any other; it turns false once that state's hold
   * has run out (or the moment the player pauses, steps or scrubs).
   */
  playing: boolean
  /** Playback rate, one of `REPLAY_SPEEDS`; scale the view's own animations by it. */
  speed: number
  /** Who sat where, in seat order, as the game was dealt. */
  players: ReplayPlayer[]
  /**
   * Call once the scene can show a frame (a 3D board has its first render).
   * Playback starts then, or after a short grace if it is never called.
   */
  onReady?: () => void
}

/** The part of a game's room config that isn't already in the catalog. */
interface OnlineGameConfig {
  /**
   * Fewest players this game will start with. Mirrors the adapter's `minSeats`,
   * which lives on the server — the room page needs it to know whether a table
   * that nobody else turned up to can be started anyway.
   */
  minSeats: number
  /**
   * The game draws reactions at its own seats during play, so the room page's
   * generic overlay stays out of the way once the game is on.
   */
  anchorsReactions?: boolean
  /** What the button that takes this seat should say. */
  seatLabel(seat: SeatId, index: number): string
  /**
   * Skills this game's bots accept, easiest first. The ids mirror the adapter's
   * `bots.skills` on the server, which is the only thing that validates them;
   * a games.test.ts case holds the two lists together. Absent when a game has
   * no bots yet.
   */
  botSkills?: BotSkill[]
  /**
   * Lazy so a room page never drags a game's 3D scene in before it is needed —
   * but the room warms it with `preloadRoomView` as soon as it opens, because
   * the moment it is needed is a socket message, not a click.
   */
  RoomView: LazyExoticComponent<ComponentType<RoomViewProps>>
  preloadRoomView: () => Promise<boolean>
  /**
   * How this game plays back a finished game (see `ReplayViewProps`), lazy like
   * `RoomView`. Until a game has one, its replay page says so and keeps the
   * timeline working.
   */
  ReplayView?: LazyExoticComponent<ComponentType<ReplayViewProps>>
  preloadReplayView?: () => Promise<boolean>
  /**
   * Whose turn a state is, as anything comparable — the scrubber marks each
   * index where it changes. Without it every state gets a mark.
   */
  replayTurn?: (state: unknown) => unknown
  /**
   * The game's own result screen links to its replay (with `replayUrl`), so the
   * room page leaves out its generic "Watch the replay" link.
   */
  linksReplay?: boolean
}

export interface OnlineGame extends OnlineGameConfig {
  /** Where the game lives, e.g. `/chess`. Rooms are `${basePath}/room/:code`. */
  basePath: string
  name: string
}

function roomView(load: () => Promise<{ default: ComponentType<RoomViewProps> }>) {
  const { Component, preload } = lazyWithPreload(load)
  return { RoomView: Component, preloadRoomView: preload }
}

/**
 * Spread into a config to give the game a replay:
 * `...replayView(() => import('../games/chess/online/ChessReplayView'))`.
 */
export function replayView(load: () => Promise<{ default: ComponentType<ReplayViewProps> }>) {
  const { Component, preload } = lazyWithPreload(load)
  return { ReplayView: Component, preloadReplayView: preload }
}

const CONFIGS: Partial<Record<GameId, OnlineGameConfig>> = {
  chess: {
    anchorsReactions: true,
    minSeats: 2,
    seatLabel: (seat) => (seat === 'w' ? 'Play as White' : 'Play as Black'),
    // No `hard`: measured inside workerd it costs about 1.14s of CPU a move,
    // three quarters of a minute across a game. See backend/test/chess-budget.
    botSkills: [
      { id: 'easy', label: 'Easy' },
      { id: 'medium', label: 'Medium' },
    ],
    ...roomView(() => import('../games/chess/online/ChessRoomView')),
    ...replayView(() => import('../games/chess/online/ChessReplayView')),
    replayTurn: (state) => (state as { turn: string }).turn,
    // The result dialog offers the replay, and a permanent link to the moves.
    linksReplay: true,
  },
  estate: {
    anchorsReactions: true,
    minSeats: 2,
    // Tokens and colours are handed out at the start, once the room knows who
    // turned up, so a seat taken beforehand cannot promise one.
    seatLabel: (_seat, index) => `Take seat ${index + 1}`,
    // One strength: Estate's bot has no difficulty to pick, so the picker is
    // left out entirely rather than offering a choice of one.
    botSkills: [{ id: 'standard', label: 'Bot' }],
    ...roomView(() => import('../games/monopoly/online/EstateRoomView')),
    ...replayView(() => import('../games/monopoly/online/EstateReplayView')),
    // A mark wherever the dice pass to someone else.
    replayTurn: (state) => (state as { current: number }).current,
    linksReplay: true,
  },
  hearth: {
    anchorsReactions: true,
    minSeats: 2,
    // Colours are handed out at the start, once the room knows who turned up, so
    // a seat taken beforehand cannot promise one.
    seatLabel: (_seat, index) => `Take seat ${index + 1}`,
    botSkills: [
      { id: 'easy', label: 'Easy' },
      { id: 'medium', label: 'Medium' },
      { id: 'hard', label: 'Hard' },
    ],
    ...roomView(() => import('../games/hearth/online/HearthRoomView')),
    ...replayView(() => import('../games/hearth/online/HearthReplayView')),
    // A six's extra roll is the same player's turn going on, so it is not a new mark.
    replayTurn: (state) => (state as { currentPlayer?: number } | null)?.currentPlayer,
    linksReplay: true,
  },
  prism: {
    anchorsReactions: true,
    minSeats: 2,
    // Seats are numbered, not dealt: which hand a seat gets is the shuffle's to
    // decide, once the room knows who turned up.
    seatLabel: (_seat, index) => `Take seat ${index + 1}`,
    botSkills: [
      { id: 'easy', label: 'Easy' },
      { id: 'medium', label: 'Medium' },
      { id: 'hard', label: 'Hard' },
    ],
    ...roomView(() => import('../games/prism/online/PrismRoomView')),
    ...replayView(() => import('../games/prism/online/PrismReplayView')),
    // A mark each time play passes to another seat; a skip or a reverse between two marks nothing.
    replayTurn: (state) => (state as { currentPlayer?: number } | null)?.currentPlayer,
    // The round's result offers the replay.
    linksReplay: true,
  },
  wildrise: {
    anchorsReactions: true,
    minSeats: 2,
    // Colours are handed out at the start, once the room knows who turned up, so
    // a seat taken beforehand cannot promise one.
    seatLabel: (_seat, index) => `Take seat ${index + 1}`,
    // Pace, not strength — there is nothing to be good at on this board.
    botSkills: [
      { id: 'casual', label: 'Casual · take it easy' },
      { id: 'fast', label: 'Fast · keep it moving' },
      { id: 'fun', label: 'Fun · a little expressive' },
    ],
    ...roomView(() => import('../games/wildrise/online/WildriseRoomView')),
    ...replayView(() => import('../games/wildrise/online/WildriseReplayView')),
    // A mark each time the die passes on.
    replayTurn: (state) => (state as { currentPlayer?: number } | null)?.currentPlayer,
    // The win dialog offers the replay.
    linksReplay: true,
  },
}

/** The room config for a catalog id, or undefined when that game has no online mode. */
export function onlineGame(id: string): OnlineGame | undefined {
  const config = Object.prototype.hasOwnProperty.call(CONFIGS, id) ? CONFIGS[id as GameId] : undefined
  // Where the game lives and what it is called are the catalog's to say; App.tsx
  // builds the room route off the same entry, so they cannot drift apart.
  const entry = config && games.find((game) => game.id === id && game.online)
  return entry && config ? { ...config, basePath: entry.path, name: entry.name } : undefined
}

/**
 * Where a room's last finished game plays back, as a router path (`<Link
 * to={replayUrl('chess', code)}>`, `navigate(…)`). Available once the game has
 * finished, for as long as the room lives: 24 hours after its last move.
 */
export function replayUrl(game: GameId, code: string): string {
  return `${onlineGame(game)?.basePath ?? `/${game}`}/replay/${code}`
}
