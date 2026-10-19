import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { GameState, PlayerId } from '@games/shared/hearth/types'
import { usePresentBeats } from '../../../online/session'
import type { RoomBeat } from '../../../online/session'
import { createScene } from './createScene'
import type { Cue, SceneApi } from './createScene'

export interface BoardControls extends Pick<SceneApi, 'focus' | 'reset' | 'zoom' | 'top' | 'roll'> {
  /**
   * Where a colour's court (or, for `null`, the home in the middle) is on the
   * page, in viewport pixels — and whether it is on screen at all, so a caller
   * can point somewhere else when the board is scrolled away. `null` without a
   * board to ask.
   */
  anchor: (colour: PlayerId | null) => { x: number; y: number; inView: boolean } | null
}

/** The setup preview has no room, and so no beats. */
const NO_BEATS: RoomBeat<GameState>[] = []

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
  beats?: RoomBeat<GameState>[]
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
      anchor(colour) {
        const board = scene.current,
          box = container.current?.getBoundingClientRect()
        if (!board || !box) return null
        const { x, y } = board.anchor(colour),
          point = { x: box.left + x, y: box.top + y }
        return {
          ...point,
          inView:
            x >= 0 &&
            x <= box.width &&
            y >= 0 &&
            y <= box.height &&
            point.y >= 0 &&
            point.y <= window.innerHeight,
        }
      },
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
  // The room's beats, each once and in order — the board lands the newest when it is joining rather than
  // following along, its `elapsed` saying how far into that beat the room already is.
  usePresentBeats(beats ?? NO_BEATS, (beat) => {
    const board = scene.current
    // Without a board there is nothing to wait for: the HUD takes the room's state as it comes.
    if (!board) hooks.current.onPresent(beat.state)
    else board.update(beat.state, seat, live, performance.now() - beat.since)
  })
  // The setup preview simply shows whatever table the panel describes.
  useEffect(() => {
    if (beats) return
    const board = scene.current
    if (board) board.update(state, seat, live, 0)
    else if (failed) hooks.current.onPresent(state)
  }, [beats, state, seat, live, failed])
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
