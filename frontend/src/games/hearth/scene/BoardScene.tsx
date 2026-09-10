import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { GameState } from '../game/types'
import { createScene } from './createScene'
import type { SceneApi } from './createScene'

export type BoardControls = Pick<SceneApi, 'focus' | 'reset' | 'zoom' | 'top'>
const BoardScene = forwardRef<
  BoardControls,
  { state: GameState; running: boolean; onSelect: (id: string) => void }
>(function BoardScene({ state, running, onSelect }, ref) {
  const container = useRef<HTMLDivElement>(null),
    scene = useRef<SceneApi | null>(null)
  const initial = useRef(state),
    select = useRef(onSelect)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    select.current = onSelect
  }, [onSelect])
  useImperativeHandle(
    ref,
    () => ({
      focus: (id) => scene.current?.focus(id),
      reset: () => scene.current?.reset(),
      zoom: (d) => scene.current?.zoom(d),
      top: () => scene.current?.top(),
    }),
    [],
  )
  useEffect(() => {
    if (!container.current) return
    try {
      scene.current = createScene(container.current, initial.current, (id) => select.current(id))
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
    scene.current?.update(state)
  }, [state])
  useEffect(() => {
    scene.current?.setRunning(running)
  }, [running])
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
