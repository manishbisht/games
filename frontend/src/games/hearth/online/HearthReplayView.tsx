import { useEffect, useRef, useState } from 'react'
import { PALETTES } from '@games/shared/hearth/board'
import type { GameState } from '@games/shared/hearth/types'
import type { ReplayViewProps } from '../../../online/games'
import { useSound } from '../../../motion/sound'
import { playCue } from '../game/audio'
import { createScene } from '../scene/createScene'
import type { SceneApi } from '../scene/createScene'
import './HearthReplayView.css'

const stateAt = (states: ReplayViewProps['states'], index: number) => states[index].state as GameState

/**
 * A finished game of Hearth & Home, played back on the real board. The next
 * state, while playing, goes through the same story the live table tells — the
 * rattle, the toss, every hop, the knock home — at the replay's speed, so it
 * fits the time the page holds it; any other move of the playhead lands at
 * once. Nothing on it can be picked: it is a table being watched.
 */
export default function HearthReplayView({ states, index, playing, speed, onReady }: ReplayViewProps) {
  const container = useRef<HTMLDivElement>(null),
    scene = useRef<SceneApi | null>(null),
    /** The index the board is on (or playing into). */
    boardIndex = useRef(index),
    /** Whether the page was playing as of the last render that changed it — see the index effect. */
    wasPlaying = useRef(playing)
  // The table's own sound switch, off unless the player turned it on while playing.
  const [soundOn] = useSound('hearth', false)
  const latest = useRef({ soundOn, onReady, index, speed })
  const [shown, setShown] = useState(() => stateAt(states, index))
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    latest.current = { soundOn, onReady, index, speed }
  })

  useEffect(() => {
    if (!container.current) return
    const { index, speed } = latest.current,
      first = stateAt(states, index)
    try {
      const board = createScene(
        container.current,
        first,
        {
          select: () => {},
          present: setShown,
          cue: (cue) => {
            if (latest.current.soundOn) playCue(cue)
          },
          rendered: () => latest.current.onReady?.(),
        },
        // Watching, as a spectator does: every swing to the court that is up, no piece to pick.
        null,
        true,
      )
      board.land(first)
      board.pace(speed)
      scene.current = board
      boardIndex.current = index
    } catch (error) {
      console.error('Hearth & Home could not initialize WebGL.', error)
      // Only trying to make the WebGL context can tell; there is nothing to derive this from in render.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFailed(true)
      latest.current.onReady?.()
    }
    return () => {
      scene.current?.dispose()
      scene.current = null
    }
  }, [states])

  useEffect(() => {
    scene.current?.pace(speed)
  }, [speed])

  useEffect(() => {
    const board = scene.current,
      previous = boardIndex.current
    boardIndex.current = index
    if (!board || previous === index) return
    const state = stateAt(states, index)
    // The page stops playing in the same render that reaches the last state, so
    // "was playing" is what tells the final move — and its celebration — to play out.
    if (index === previous + 1 && (playing || wasPlaying.current)) board.update(state, null, true, 0)
    else board.land(state)
  }, [index, playing, states])

  // After the index effect, so that one still sees the value from before this render.
  useEffect(() => {
    wasPlaying.current = playing
  }, [playing])

  // Without a board nothing presents, so the caption simply follows the playhead.
  const table = failed ? stateAt(states, index) : shown
  const player = table.players[table.currentPlayer],
    winner = table.winner && table.players.find((p) => p.id === table.winner),
    latestEvent = table.events[0],
    speaker = winner ?? (latestEvent && table.players.find((p) => p.id === latestEvent.playerId)) ?? player
  return (
    <div className="hh-replay">
      <div className="hh-replay-canvas" ref={container}>
        {failed && (
          <div className="hh-replay-webgl">
            <h3>The 3D board needs WebGL.</h3>
            <p>Enable browser hardware acceleration and refresh to watch this game.</p>
          </div>
        )}
      </div>
      <p className="hh-replay-caption">
        <span
          className="hh-replay-dot"
          style={{ background: speaker ? PALETTES[speaker.id].color : undefined }}
          aria-hidden="true"
        />
        <span>
          {winner ? `${winner.name} wins!` : (latestEvent?.message ?? `${player?.name ?? 'Red'} to roll.`)}
        </span>
        <small>Turn {table.turn}</small>
      </p>
    </div>
  )
}
