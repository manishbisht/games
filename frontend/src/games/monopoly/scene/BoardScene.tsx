import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { createScene } from './createScene'
import type { SceneApi, SceneCue } from './createScene'
import type { GameState } from '@games/shared/estate/types'
import { usePresentBeats } from '../../../online/session'
import type { RoomBeat } from '../../../online/session'
import './BoardScene.css'

export type BoardControls = Pick<SceneApi, 'reset' | 'zoom' | 'topView' | 'shake' | 'tokenAt'>
export type { SceneCue }

const NO_BEATS: RoomBeat<GameState>[] = []

/** No board to walk on: each state is shown as it comes — a lap of GO is still worth announcing. */
function tell(next: GameState, passed: { current: number }, cue: (cue: SceneCue) => void) {
  for (const event of [...next.events].reverse())
    if (event.id > passed.current && event.text.includes('passed GO') && event.player !== undefined)
      cue({ type: 'go', player: event.player })
  passed.current = next.eventId
  cue({ type: 'present', state: next })
}

/**
 * The 3D board. It is handed the server's state and tells the page, through
 * `onCue`, when each state has been played out and may be shown. Without WebGL
 * there is nothing to play, so every state is shown the moment it arrives.
 */
const BoardScene = forwardRef<
  BoardControls,
  {
    state: GameState
    /** Online: every recent state, oldest first, ending with `state` — each is played in turn. */
    beats?: RoomBeat<GameState>[]
    selected: number | null
    onSelect: (id: number) => void
    onCue: (cue: SceneCue) => void
  }
>(function BoardScene({ state, beats, selected, onSelect, onCue }, ref) {
  const container = useRef<HTMLDivElement>(null),
    scene = useRef<SceneApi | null>(null)
  const initial = useRef(state),
    initialSince = useRef(beats?.at(-1)?.since),
    selectRef = useRef(onSelect),
    cueRef = useRef(onCue)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    selectRef.current = onSelect
    cueRef.current = onCue
  }, [onSelect, onCue])
  useImperativeHandle(
    ref,
    () => ({
      reset: () => scene.current?.reset(),
      zoom: (d) => scene.current?.zoom(d),
      topView: () => scene.current?.topView(),
      shake: () => scene.current?.shake(),
      tokenAt: (player) => scene.current?.tokenAt(player) ?? null,
    }),
    [],
  )
  useEffect(() => {
    if (!container.current) return
    try {
      scene.current = createScene(container.current, initial.current, {
        onSelect: (id) => selectRef.current(id),
        onCue: (cue) => cueRef.current(cue),
        since: initialSince.current,
      })
    } catch (error) {
      console.error('Unable to initialize the 3D board', error)
      setFailed(true)
    }
    return () => {
      scene.current?.dispose()
      scene.current = null
    }
  }, [])
  const passed = useRef(state.eventId)
  // Online: every state the board has not played yet, in order, each timed from
  // when the room entered it. The first look is the state the board was built
  // on, which it has already played.
  usePresentBeats(beats ?? NO_BEATS, (beat, catchUp) => {
    const board = scene.current
    if (!board) tell(beat.state, passed, cueRef.current)
    else if (!(catchUp && beat.state === initial.current)) board.update(beat.state, beat.since)
  })
  // The setup preview is not a room's: it is played as it is handed over.
  useEffect(() => {
    if (beats) return
    if (scene.current) scene.current.update(state)
    else tell(state, passed, cueRef.current)
  }, [state, beats, failed])
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
