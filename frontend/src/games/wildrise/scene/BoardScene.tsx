import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { BeatTiming } from '@games/shared/protocol'
import type { GameState } from '@games/shared/wildrise/types'
import type { Cue } from '../game/audio'
import type { TableMoment } from '../online/session'
import { createScene } from './createScene'
import type { SceneApi } from './createScene'
import type { Squares } from './story'

export type BoardControls = Pick<SceneApi, 'reset' | 'top' | 'rotate' | 'zoom' | 'rolling'>

interface Props {
  state: GameState
  /** The room's word on how far into `state` it already is. */
  timing?: BeatTiming
  /** When `state` arrived (`performance.now()`), which `timing` counts on from. */
  receivedAt?: number
  /** The room's recent states in arrival order, newest (`state`) last. */
  recent?: TableMoment[]
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
  { state, timing, receivedAt, recent, running, canRoll, onRoll, onCue, onPositions, onFailure },
  ref,
) {
  const container = useRef<HTMLDivElement>(null),
    scene = useRef<SceneApi | null>(null)
  const initial = useRef({ state, timing, receivedAt }),
    handlers = useRef({ onRoll, onCue, onPositions, onFailure })
  const [failed, setFailed] = useState(false)
  /** The newest of `recent` the board has played; it opens on the newest there is. */
  const presented = useRef(recent?.at(-1)?.seq ?? 0)
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
        initial.current.receivedAt,
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
  // no-op for the scene, so following `timing` as well costs nothing. Several
  // snapshots landing in one render are each played, in order — the throw
  // before the walk it started — unless more arrived than `recent` keeps, when
  // the newest is caught up to on its own, as on joining.
  useEffect(() => {
    const board = scene.current
    if (!board) return
    if (!recent?.length) return void board.update(state, timing, receivedAt)
    const seen = presented.current
    presented.current = recent.at(-1)!.seq
    const unseen = recent[0].seq <= seen + 1 ? recent.filter((m) => m.seq > seen) : recent.slice(-1)
    for (const moment of unseen)
      if (moment.state) board.update(moment.state, moment.timing, moment.receivedAt)
  }, [state, timing, receivedAt, recent])
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
