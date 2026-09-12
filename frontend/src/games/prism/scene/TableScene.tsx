import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { createScene } from './createScene'
import type { TableApi, TableState } from './createScene'
import { cardImage } from './artwork'

export default forwardRef<Pick<TableApi, 'zoom'>, { state: TableState }>(function TableScene({ state }, ref) {
  const element = useRef<HTMLDivElement>(null),
    api = useRef<TableApi | null>(null),
    initial = useRef(state)
  const [fallback, setFallback] = useState(false)
  useImperativeHandle(ref, () => ({ zoom: (n) => api.current?.zoom(n) }), [])
  useEffect(() => {
    try {
      api.current = createScene(element.current!, initial.current)
    } catch {
      setFallback(true)
    }
    return () => {
      api.current?.dispose()
      api.current = null
    }
  }, [])
  useEffect(() => {
    api.current?.update(state)
  }, [state])
  return (
    <div className="pr-table-render" ref={element} aria-label="3D Prism card table" role="img">
      {fallback && (
        <div className="pr-table-fallback">
          <img src={cardImage()} alt="Draw pile" />
          <img src={cardImage(state.game.discardPile.at(-1))} alt="Top discard" />
          <span>3D is unavailable. All game controls are still available.</span>
        </div>
      )}
    </div>
  )
})
