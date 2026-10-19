import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import { createScene } from './createScene'
import type { TableApi, TableHost, TableState } from './createScene'
import { cardImage } from './artwork'

/**
 * The 3D table. Created and fed in layout effects, so the view it reports back
 * (cards still in the air hidden from the hand, counts that wait for their
 * card) is in place before the browser paints the snapshot that caused it.
 */
export default forwardRef<Pick<TableApi, 'zoom' | 'locate'>, { state: TableState; host: TableHost }>(
  function TableScene({ state, host }, ref) {
    const element = useRef<HTMLDivElement>(null),
      api = useRef<TableApi | null>(null),
      initial = useRef(state),
      latestHost = useRef(host)
    const [fallback, setFallback] = useState(false)
    useImperativeHandle(
      ref,
      () => ({ zoom: (n) => api.current?.zoom(n), locate: (spot) => api.current?.locate(spot) ?? null }),
      [],
    )
    useLayoutEffect(() => {
      latestHost.current = host
    })
    useLayoutEffect(() => {
      // The scene outlives renders; it always speaks to the newest host.
      const relay: TableHost = {
        view: (view) => latestHost.current.view(view),
        slot: (id) => latestHost.current.slot(id),
        cue: (cue) => latestHost.current.cue(cue),
        ready: () => latestHost.current.ready?.(),
      }
      try {
        api.current = createScene(element.current!, initial.current, relay)
      } catch {
        setFallback(true)
        // The flat fallback is as ready as it will ever be.
        relay.ready!()
      }
      return () => {
        api.current?.dispose()
        api.current = null
      }
    }, [])
    useLayoutEffect(() => {
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
  },
)
