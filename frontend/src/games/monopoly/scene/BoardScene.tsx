import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { createScene } from './createScene'
import type { BeatSync, SceneApi, SceneCue } from './createScene'
import type { GameState } from '@games/shared/estate/types'
import { beatElapsed } from '@games/shared/protocol'
import type { EstateArrival } from '../online/session'
import './BoardScene.css'

export type BoardControls = Pick<SceneApi, 'reset' | 'zoom' | 'topView' | 'shake'>
export type { SceneCue }

/**
 * The 3D board. It is handed the server's state and tells the page, through
 * `onCue`, when each state has been played out and may be shown. Without WebGL
 * there is nothing to play, so every state is shown the moment it arrives.
 */
const BoardScene = forwardRef<
  BoardControls,
  {
    state: GameState
    /** Online: how far into the room's current beat `state` already was. */
    sync?: BeatSync
    /** Online: every recent state in arrival order, newest last (`state`) — each is played in turn. */
    recent?: readonly EstateArrival[]
    selected: number | null
    onSelect: (id: number) => void
    onCue: (cue: SceneCue) => void
  }
>(function BoardScene({ state, sync, recent, selected, onSelect, onCue }, ref) {
  const container = useRef<HTMLDivElement>(null),
    scene = useRef<SceneApi | null>(null)
  const initial = useRef(state),
    syncRef = useRef(sync),
    selectRef = useRef(onSelect),
    cueRef = useRef(onCue)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    selectRef.current = onSelect
    cueRef.current = onCue
    syncRef.current = sync
  }, [onSelect, onCue, sync])
  useImperativeHandle(
    ref,
    () => ({
      reset: () => scene.current?.reset(),
      zoom: (d) => scene.current?.zoom(d),
      topView: () => scene.current?.topView(),
      shake: () => scene.current?.shake(),
    }),
    [],
  )
  useEffect(() => {
    if (!container.current) return
    try {
      scene.current = createScene(container.current, initial.current, {
        onSelect: (id) => selectRef.current(id),
        onCue: (cue) => cueRef.current(cue),
        sync: syncRef.current,
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
  const passed = useRef(state.eventId),
    playedSeq = useRef(recent?.at(-1)?.seq ?? 0)
  useEffect(() => {
    const board = scene.current
    if (board && recent) {
      // React renders a burst of snapshots once: play each state the board has
      // not seen, in order, each timed from when it arrived. One older than
      // `recent` keeps is a gap too wide to tell — land the newest instead.
      const unseen = recent.filter((entry) => entry.seq > playedSeq.current)
      if (unseen[0]?.seq === playedSeq.current + 1)
        for (const entry of unseen)
          board.update(entry.state, { elapsed: beatElapsed(entry.timing), at: entry.receivedAt })
      else if (unseen.length) board.update(state, syncRef.current)
      playedSeq.current = recent.at(-1)?.seq ?? playedSeq.current
      return
    }
    if (board) {
      board.update(state, syncRef.current)
      return
    }
    // No board to walk on: a lap of GO is still worth announcing.
    for (const event of [...state.events].reverse())
      if (event.id > passed.current && event.text.includes('passed GO') && event.player !== undefined)
        cueRef.current({ type: 'go', player: event.player })
    passed.current = state.eventId
    cueRef.current({ type: 'present', state })
  }, [state, recent, failed])
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
