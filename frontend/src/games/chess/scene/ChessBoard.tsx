import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import type { Square } from '../game/types'
import { COLOR_NAMES, GLYPHS, PIECE_NAMES } from '../game/types'
import { createScene } from './createScene'
import type { SceneApi, SceneState } from './createScene'

export type BoardControls = Pick<SceneApi, 'zoom' | 'reset' | 'top'>
const ChessBoard = forwardRef<
  BoardControls,
  { state: SceneState; black: boolean; onSelect: (square: Square) => void }
>(function ChessBoard({ state, black, onSelect }, ref) {
  const container = useRef<HTMLDivElement>(null),
    api = useRef<SceneApi | null>(null),
    initial = useRef(state),
    select = useRef(onSelect)
  const [failed, setFailed] = useState(false),
    [focused, setFocused] = useState<Square | null>(null),
    [keyboard, setKeyboard] = useState(false)
  useEffect(() => {
    select.current = onSelect
  }, [onSelect])
  useImperativeHandle(
    ref,
    () => ({
      zoom: (n) => api.current?.zoom(n),
      reset: () => api.current?.reset(),
      top: () => api.current?.top(),
    }),
    [],
  )
  useEffect(() => {
    if (!container.current) return
    try {
      api.current = createScene(container.current, initial.current, (s) => select.current(s))
    } catch (error) {
      console.error('Chess WebGL initialization failed', error)
      setFailed(true)
    }
    return () => {
      api.current?.dispose()
      api.current = null
    }
  }, [])
  useEffect(() => {
    api.current?.update({ ...state, focused: keyboard ? focused : null })
  }, [state, focused, keyboard])
  useEffect(() => {
    api.current?.flip(black)
  }, [black])
  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    const current = focused || 'e2'
    let file = current.charCodeAt(0) - 97,
      rank = Number(current[1])
    const sign = black ? -1 : 1
    if (event.key === 'ArrowLeft') file -= sign
    else if (event.key === 'ArrowRight') file += sign
    else if (event.key === 'ArrowUp') rank += sign
    else if (event.key === 'ArrowDown') rank -= sign
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (state.enabled) onSelect(current)
      return
    } else if (event.key === 'Escape') {
      event.preventDefault()
      if (state.selected) onSelect(state.selected)
      return
    } else return
    event.preventDefault()
    setKeyboard(true)
    setFocused(
      `${String.fromCharCode(97 + Math.max(0, Math.min(7, file)))}${Math.max(1, Math.min(8, rank))}` as Square,
    )
  }
  const piece = state.game.pieces.find((p) => p.square === focused)
  const focusLabel = focused
    ? `${focused}, ${piece ? `${COLOR_NAMES[piece.color]} ${PIECE_NAMES[piece.type]}` : 'empty'}${state.legal.some((m) => m.to === focused) ? ', legal destination' : ''}`
    : ''
  return (
    <div
      className="ch-board-interaction"
      role="group"
      aria-label="3D chessboard"
      tabIndex={0}
      onKeyDown={keyDown}
      onFocus={() => {
        setKeyboard(true)
        setFocused((f) => f || 'e2')
      }}
      onBlur={() => setKeyboard(false)}
    >
      <div className="ch-canvas" ref={container} />
      <p className="sr-only" aria-live="polite">
        {keyboard ? focusLabel : ''}
      </p>
      {keyboard && (
        <div className="ch-keyboard-tip">
          {focusLabel} <span>↑ ↓ ← → to explore · Enter to select</span>
        </div>
      )}
      {failed && (
        <div className="ch-fallback">
          <p>3D is unavailable. You can still play on this board.</p>
          <div className="ch-fallback-grid">
            {Array.from({ length: 64 }, (_, i) => {
              const index = black ? 63 - i : i,
                square = `${String.fromCharCode(97 + (index % 8))}${8 - Math.floor(index / 8)}` as Square
              const p = state.game.pieces.find((p) => p.square === square),
                legal = state.legal.some((m) => m.to === square)
              return (
                <button
                  key={square}
                  className={`${(index + Math.floor(index / 8)) % 2 ? 'dark' : ''} ${state.selected === square ? 'selected' : ''}`}
                  onClick={() => state.enabled && onSelect(square)}
                  aria-label={`${square}${p ? ` ${COLOR_NAMES[p.color]} ${PIECE_NAMES[p.type]}` : ''}${legal ? ' legal move' : ''}`}
                >
                  {p ? GLYPHS[p.color][p.type] : legal ? '•' : ''}
                  <small>{square}</small>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
})
export default ChessBoard
