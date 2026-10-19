import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { GameState, PlayerId } from '@games/shared/hearth/types'
import { createScene } from './createScene'
import type { Cue, SceneApi } from './createScene'
import type { RoomBeat } from './types'

export type BoardControls = Pick<SceneApi, 'focus' | 'reset' | 'zoom' | 'top' | 'roll'>

interface Props {
  state: GameState
  /** The colour this browser plays; the board only offers its pieces, on its turn. */
  seat: PlayerId | null
  /** False for the preview behind the setup panel. */
  live: boolean
  /**
   * The room's recent states, ending with `state`, each stamped with when its
   * beat began. Absent for the setup preview, whose state simply begins now.
   */
  beats?: RoomBeat[]
  onSelect: (id: string) => void
  /** The table as the board is showing it, which trails `state` while a move plays out. */
  onPresent: (state: GameState) => void
  onCue: (cue: Cue) => void
}

const BoardScene = forwardRef<BoardControls, Props>(function BoardScene(
  { state, seat, live, beats, onSelect, onPresent, onCue },
  ref,
) {
  const container = useRef<HTMLDivElement>(null),
    scene = useRef<SceneApi | null>(null)
  const initial = useRef({ state, seat, live, since: beats?.at(-1)?.since }),
    hooks = useRef({ onSelect, onPresent, onCue }),
    /** The newest snapshot the board has been handed; it starts on whatever was newest when it mounted. */
    seen = useRef(beats?.at(-1)?.seq ?? 0)
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
    const { state, seat, live, since } = initial.current
    // Counted from when the state's beat began, so however long the board took to mount, it starts where the room is.
    const elapsed = since === undefined ? 0 : performance.now() - since
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
    const board = scene.current
    if (!board) {
      // Without a board there is nothing to wait for: the HUD takes the room's state as it comes.
      if (failed) hooks.current.onPresent(state)
      return
    }
    const now = performance.now(),
      fresh = beats?.filter((beat) => beat.seq > seen.current) ?? []
    // A burst of snapshots renders once, but each state is still a beat of its own: hand them over in
    // order. If more arrived than are kept, the gap cannot be told, and the board lands the newest as
    // a late arrival would.
    if (fresh.length && fresh[0].seq === seen.current + 1)
      for (const beat of fresh.slice(0, -1)) board.update(beat.state, seat, live, now - beat.since)
    seen.current = beats?.at(-1)?.seq ?? seen.current
    const newest = beats?.at(-1)
    board.update(state, seat, live, newest ? now - newest.since : 0)
  }, [state, beats, seat, live, failed])
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
