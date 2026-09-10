import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { createScene } from './createScene'
import type { SceneApi } from './createScene'
import type { GameState } from '../game/types'

export type BoardControls = Pick<SceneApi, 'reset' | 'zoom' | 'topView'>
const BoardScene = forwardRef<
  BoardControls,
  { state: GameState; selected: number | null; onSelect: (id: number) => void }
>(function BoardScene({ state, selected, onSelect }, ref) {
  const container = useRef<HTMLDivElement>(null),
    scene = useRef<SceneApi | null>(null)
  const initial = useRef(state),
    selectRef = useRef(onSelect)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    selectRef.current = onSelect
  }, [onSelect])
  useImperativeHandle(
    ref,
    () => ({
      reset: () => scene.current?.reset(),
      zoom: (d) => scene.current?.zoom(d),
      topView: () => scene.current?.topView(),
    }),
    [],
  )
  useEffect(() => {
    if (!container.current) return
    try {
      scene.current = createScene(container.current, initial.current, (id) => selectRef.current(id))
    } catch (error) {
      console.error('Unable to initialize the 3D board', error)
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
    scene.current?.select(selected)
  }, [selected])
  return (
    <div ref={container} className="board-canvas">
      {failed && (
        <div className="webgl-message">
          <h3>Your board needs WebGL</h3>
          <p>
            Enable hardware acceleration in your browser, then reload. You can still play using the turn
            controls and property list.
          </p>
        </div>
      )}
    </div>
  )
})
export default BoardScene
