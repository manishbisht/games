import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { GameState, PlayerId } from '@games/shared/hearth/types'
import { createScene } from './createScene'
import type { Cue, SceneApi } from './createScene'

export type BoardControls = Pick<SceneApi, 'focus' | 'reset' | 'zoom' | 'top' | 'roll'>

interface Props {
  state: GameState
  /** The colour this browser plays; the board only offers its pieces, on its turn. */
  seat: PlayerId | null
  /** False for the preview behind the setup panel. */
  live: boolean
  /** How far into `state`'s beat the room already was when it sent it, in ms. */
  elapsed?: number
  onSelect: (id: string) => void
  /** The table as the board is showing it, which trails `state` while a move plays out. */
  onPresent: (state: GameState) => void
  onCue: (cue: Cue) => void
}

const BoardScene = forwardRef<BoardControls, Props>(function BoardScene(
  { state, seat, live, elapsed = 0, onSelect, onPresent, onCue },
  ref,
) {
  const container = useRef<HTMLDivElement>(null),
    scene = useRef<SceneApi | null>(null)
  const initial = useRef({ state, seat, live, elapsed }),
    hooks = useRef({ onSelect, onPresent, onCue })
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    hooks.current = { onSelect, onPresent, onCue }
  }, [onSelect, onPresent, onCue])
  useImperativeHandle(
    ref,
    () => ({
      focus: (id) => scene.current?.focus(id),
      reset: () => scene.current?.reset(),
      zoom: (d) => scene.current?.zoom(d),
      top: () => scene.current?.top(),
      roll: () => scene.current?.roll(),
    }),
    [],
  )
  useEffect(() => {
    if (!container.current) return
    const { state, seat, live, elapsed } = initial.current
    try {
      scene.current = createScene(
        container.current,
        state,
        {
          select: (id) => hooks.current.onSelect(id),
          present: (shown) => hooks.current.onPresent(shown),
          cue: (cue) => hooks.current.onCue(cue),
        },
        seat,
        live,
        elapsed,
      )
    } catch (error) {
      console.error('Hearth & Home could not initialize WebGL.', error)
      setFailed(true)
    }
    return () => {
      scene.current?.dispose()
      scene.current = null
    }
  }, [])
  useEffect(() => {
    if (scene.current) scene.current.update(state, seat, live, elapsed)
    // Without a board there is nothing to wait for: the HUD takes the room's state as it comes.
    else if (failed) hooks.current.onPresent(state)
  }, [state, seat, live, elapsed, failed])
  return (
    <div className="hh-canvas" ref={container}>
      {failed && (
        <div className="hh-webgl">
          <h3>The 3D board needs WebGL.</h3>
          <p>
            Enable browser hardware acceleration and refresh. You can still use the piece buttons to play.
          </p>
        </div>
      )}
    </div>
  )
})
export default BoardScene
