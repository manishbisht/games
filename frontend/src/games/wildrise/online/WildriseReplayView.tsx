import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import { PALETTES } from '@games/shared/wildrise/board'
import { phaseDuration } from '@games/shared/wildrise/timing'
import type { GameState } from '@games/shared/wildrise/types'
import type { ReplayViewProps } from '../../../online/games'
import { replayHoldMs } from '../../../online/replayTiming'
import { createScene } from '../scene/createScene'
import type { SceneApi } from '../scene/createScene'
import type { Squares } from '../scene/story'
import './WildriseReplay.css'

const stateAt = (states: ReplayViewProps['states'], index: number) =>
  states[index]?.state as GameState | undefined

/** How much of a state's time on screen its beat may take, so it has landed before the next one. */
const FIT = 0.9

/**
 * A finished Wildrise game, played back on the real board. Playing on to the
 * next state is the table's own beat — the throw, the hops, the climb or the
 * slide — sped up to fit the time the page holds that state for; any other
 * move of the playhead puts the board straight on the state.
 */
export default function WildriseReplayView({ states, index, playing, speed, onReady }: ReplayViewProps) {
  const container = useRef<HTMLDivElement>(null),
    scene = useRef<SceneApi | null>(null),
    shown = useRef(index),
    ready = useRef(onReady)
  const [squares, setSquares] = useState<Squares | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    ready.current = onReady
  }, [onReady])

  useEffect(() => {
    let frame = 0
    try {
      scene.current = createScene(container.current!, stateAt(states, shown.current)!, {
        onRoll: () => {},
        // A replay is watched, not heard: the page has no mute to offer.
        onCue: () => {},
        onPositions: setSquares,
      })
      // The stage draws on the next frame; the one after it has been shown.
      frame = requestAnimationFrame(() => (frame = requestAnimationFrame(() => ready.current?.())))
    } catch (error) {
      console.error('Wildrise could not initialize the 3D board.', error)
      // Played on regardless: the positions under the board still follow it.
      frame = requestAnimationFrame(() => {
        setFailed(true)
        ready.current?.()
      })
    }
    return () => {
      cancelAnimationFrame(frame)
      scene.current?.dispose()
      scene.current = null
    }
    // The states are fixed for the life of the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const board = scene.current,
      next = stateAt(states, index)
    const from = shown.current
    shown.current = index
    if (!board || !next || index === from) return
    if (!playing || index !== from + 1) return board.land(next)
    // The beat into this state runs at the replay's speed — faster still when
    // the room moved on sooner than the beat lasts (a fast bot's turn).
    const hold = replayHoldMs(states, index, speed)
    board.setRate(Math.max(speed, phaseDuration(next, false) / (hold * FIT)))
    board.update(next)
  }, [states, index, playing, speed])

  const state = stateAt(states, index)
  if (!state) return null
  const current = state.players[state.currentPlayer]
  const winner = state.players.find((player) => player.id === state.winner)
  return (
    <div className="wr-replay">
      <div className="wr-replay-canvas" ref={container} data-testid="wildrise-replay-board" />
      {failed && (
        <p className="wr-replay-fallback">
          The 3D view needs WebGL; the positions below still follow the game.
        </p>
      )}
      <ol className="wr-replay-players" aria-label="Positions">
        {state.players.map((player) => {
          const square = squares?.[player.id] ?? player.position
          return (
            <li
              key={player.id}
              data-active={player.id === current.id || undefined}
              data-testid={`wildrise-replay-${player.id}`}
              style={{ '--player-color': PALETTES[player.id].color } as CSSProperties}
            >
              <i aria-hidden="true" />
              <span>{player.name}</span>
              <strong>{square === 0 ? 'camp' : square}</strong>
            </li>
          )
        })}
      </ol>
      <p className="wr-replay-caption">
        {winner
          ? `${winner.name} reaches 100 and wins.`
          : (state.events[0]?.message ?? `${current.name} to roll.`)}
      </p>
    </div>
  )
}
