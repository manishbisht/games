import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { GameState } from '../game/types'
import { createScene } from './createScene'
import type { SceneApi } from './createScene'

export type BoardControls = Pick<SceneApi, 'reset' | 'top' | 'rotate' | 'zoom'>
export default forwardRef<BoardControls, { state: GameState; running: boolean; onRoll: () => void }>(function BoardScene({ state, running, onRoll }, ref) {
  const container = useRef<HTMLDivElement>(null), scene = useRef<SceneApi | null>(null)
  const initial = useRef(state), roll = useRef(onRoll)
  const [failed, setFailed] = useState(false)
  useEffect(() => { roll.current = onRoll }, [onRoll])
  useImperativeHandle(ref, () => ({ reset: () => scene.current?.reset(), top: () => scene.current?.top(), rotate: d => scene.current?.rotate(d), zoom: d => scene.current?.zoom(d) }), [])
  useEffect(() => {
    try { scene.current = createScene(container.current!, initial.current, () => roll.current(), () => setFailed(true)) }
    catch (error) { console.error('Wildrise could not initialize the 3D board.', error); setFailed(true) }
    return () => { scene.current?.dispose(); scene.current = null }
  }, [])
  useEffect(() => { scene.current?.update(state) }, [state])
  useEffect(() => { scene.current?.setRunning(running) }, [running])
  return <div className="wr-canvas" ref={container}>
    {failed && <div className="wr-fallback"><strong>The 3D view needs WebGL.</strong><p>Enable hardware acceleration and refresh to see the tabletop. The turn controls and positions still let you play.</p></div>}
  </div>
})
