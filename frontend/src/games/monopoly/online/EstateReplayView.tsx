import { useEffect, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { GameState } from '@games/shared/estate/types'
import type { ReplayFrame } from '@games/shared/protocol'
import type { ReplayViewProps } from '../../../online/games'
import { useSound } from '../../../motion/sound'
import { playSound } from '../game/audio'
import { createScene } from '../scene/createScene'
import type { SceneApi, SceneCue } from '../scene/createScene'
import CountedMoney from '../components/Money'
import TokenIcon from '../components/TokenIcon'
import { replayPace } from './replay'
import '../scene/BoardScene.css'
import '../components/Money.css'
import './EstateReplayView.css'

/** Above this the dice and footsteps run together into a rattle; the board plays on in silence. */
const QUIET_ABOVE = 2

/**
 * A finished game of Estate, played back on the real board. Each state the
 * room entered is handed to the board as the live table would have handed
 * it: the next one, while playing, is told with its own dice, walk and coins —
 * sped up when the replay gives it less time than the room did — and any
 * other jump lands at once. The cash and the latest news wait for the board
 * to present each state, as the table's own sidebar does.
 */
export default function EstateReplayView({ states, index, playing, speed, onReady }: ReplayViewProps) {
  const frames = states as ReplayFrame<GameState>[]
  const container = useRef<HTMLDivElement>(null),
    scene = useRef<SceneApi | null>(null)
  const initial = useRef(frames[index].state),
    at = useRef(index),
    wasPlaying = useRef(playing)
  const [shown, setShown] = useState(frames[index].state)
  const [failed, setFailed] = useState(false)
  const [soundOn] = useSound('estate', true)
  const live = useRef({ soundOn, speed, onReady })
  useEffect(() => {
    live.current = { soundOn, speed, onReady }
  }, [soundOn, speed, onReady])

  useEffect(() => {
    if (!container.current) return
    const onCue = (cue: SceneCue) => {
      if (cue.type === 'present') return setShown(cue.state)
      const { soundOn, speed } = live.current
      if (!soundOn || speed > QUIET_ABOVE) return
      if (cue.type === 'sound') playSound(cue.sound, cue.strength, cue.pan)
      else if (cue.type === 'go') playSound('go')
    }
    let frame = 0
    try {
      scene.current = createScene(container.current, initial.current, {
        watch: true,
        onSelect: () => {},
        onCue,
      })
      // The stage draws on its next frame; the one after it is on screen.
      frame = requestAnimationFrame(() => (frame = requestAnimationFrame(() => live.current.onReady?.())))
    } catch (error) {
      console.error('Unable to initialize the 3D board', error)
      // Said on the next frame, as a board would have been: there is just nothing to draw.
      frame = requestAnimationFrame(() => {
        setFailed(true)
        live.current.onReady?.()
      })
    }
    return () => {
      cancelAnimationFrame(frame)
      scene.current?.dispose()
      scene.current = null
    }
  }, [])

  useEffect(() => {
    const board = scene.current,
      from = at.current,
      // The bar stops itself as it reaches the last state, in the same render
      // that brings it in: that last step was still played into.
      told = playing || wasPlaying.current
    at.current = index
    wasPlaying.current = playing
    if (!board) return
    board.pace(replayPace(frames, index, speed))
    if (from === index) return
    if (told && index === from + 1) board.update(frames[index].state)
    else board.land(frames[index].state)
  }, [frames, index, playing, speed])

  // Without a board there is nothing to wait for: each state is shown as it is reached.
  const state = failed ? frames[index].state : shown
  const latest = state.events[0]
  return (
    <div className="estate-app estate-replay">
      <div ref={container} className="board-canvas">
        {failed && (
          <div className="webgl-message">
            <h3>This replay needs WebGL</h3>
            <p>
              Enable hardware acceleration in your browser, then reload. The players and news still follow
              along.
            </p>
          </div>
        )}
      </div>
      <div className="estate-replay-hud">
        {latest && (
          <p className="estate-replay-news" key={latest.id}>
            {latest.text}
          </p>
        )}
        <ul className="estate-replay-players" aria-label="Players">
          {state.players.map((player) => {
            const winner = state.winner === player.id,
              onTurn = state.status === 'playing' && state.current === player.id
            return (
              <li
                key={player.id}
                className={`${onTurn ? 'on-turn' : ''} ${player.bankrupt ? 'bankrupt' : ''}`}
                style={{ '--player-color': player.color } as CSSProperties}
              >
                <TokenIcon token={player.token} color={player.color} size={30} />
                <span>
                  <b>{player.name}</b>
                  <small>
                    {winner
                      ? 'Winner'
                      : player.bankrupt
                        ? 'Bankrupt'
                        : player.jailed
                          ? 'In jail'
                          : onTurn
                            ? 'On turn'
                            : '\u00a0'}
                  </small>
                </span>
                <CountedMoney value={player.cash} />
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}
