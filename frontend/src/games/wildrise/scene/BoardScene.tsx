import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { BeatTiming } from '@games/shared/protocol'
import type { GameState } from '@games/shared/wildrise/types'
import type { Cue } from '../game/audio'
import { createScene } from './createScene'
import type { SceneApi } from './createScene'
import type { Squares } from './story'

export type BoardControls = Pick<SceneApi, 'reset' | 'top' | 'rotate' | 'zoom' | 'rolling'>

interface Props {
  state: GameState
  /** The room's word on how far into `state` it already is. */
  timing?: BeatTiming
  running: boolean
  canRoll: boolean
  onRoll: () => void
  onCue: (cue: Cue, n?: number, pan?: number) => void
  onPositions: (squares: Squares) => void
  /** The 3D view could not start; the table's text has to carry the game alone. */
  onFailure: () => void
}

/**
 * The board is built once and kept for as long as the table is on screen: a
 * new state, a different player count in the setup preview, a rematch — all of
 * it is played onto the same scene rather than tearing WebGL down and up.
 */
export default forwardRef<BoardControls, Props>(function BoardScene(
  { state, timing, running, canRoll, onRoll, onCue, onPositions, onFailure },
  ref,
) {
  const container = useRef<HTMLDivElement>(null),
    scene = useRef<SceneApi | null>(null)
  const initial = useRef({ state, timing }),
    handlers = useRef({ onRoll, onCue, onPositions, onFailure })
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    handlers.current = { onRoll, onCue, onPositions, onFailure }
  }, [onRoll, onCue, onPositions, onFailure])
  useImperativeHandle(
    ref,
    () => ({
      reset: () => scene.current?.reset(),
      top: () => scene.current?.top(),
      rotate: (d) => scene.current?.rotate(d),
      zoom: (d) => scene.current?.zoom(d),
      rolling: () => scene.current?.rolling(),
    }),
    [],
  )
  useEffect(() => {
    try {
      scene.current = createScene(
        container.current!,
        initial.current.state,
        {
          onRoll: () => handlers.current.onRoll(),
          onCue: (cue, n, pan) => handlers.current.onCue(cue, n, pan),
          onPositions: (squares) => handlers.current.onPositions(squares),
        },
        initial.current.timing,
      )
    } catch (error) {
      console.error('Wildrise could not initialize the 3D board.', error)
      handlers.current.onFailure()
      setFailed(true)
    }
    return () => {
      scene.current?.dispose()
      scene.current = null
    }
  }, [])
  // A snapshot that changes nothing on the table (someone came or went) is a
  // no-op for the scene, so following `timing` as well costs nothing.
  useEffect(() => {
    scene.current?.update(state, timing)
  }, [state, timing])
  useEffect(() => {
    scene.current?.setRunning(running)
  }, [running])
  useEffect(() => {
    scene.current?.setCanRoll(canRoll)
  }, [canRoll])
  return (
    <div className="wr-canvas" ref={container}>
      {failed && (
        <div className="wr-fallback">
          <strong>The 3D view needs WebGL.</strong>
          <p>
            Enable hardware acceleration and refresh to see the tabletop. The turn controls and positions
            still let you play.
          </p>
        </div>
      )}
    </div>
  )
})
