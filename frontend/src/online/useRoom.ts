import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { PROTOCOL_VERSION } from '@games/shared/protocol'
import type { ChessSeat, ClientMessage, ServerMessage } from '@games/shared/protocol'
import { roomSocketUrl } from './api'
import { initialRoomState, isFatal, roomReducer } from './roomState'
import type { RoomClientState } from './roomState'
import { useIdentity } from './identity'

export interface RoomApi {
  sit: (seat: ChessSeat) => void
  start: () => void
  move: (from: string, to: string, promotion?: 'q' | 'r' | 'b' | 'n') => void
  resign: () => void
  rematch: () => void
  dismissError: () => void
}

export function useRoom(code: string): { room: RoomClientState; api: RoomApi } {
  const identity = useIdentity()
  const identityRef = useRef(identity)
  useEffect(() => {
    identityRef.current = identity
  })
  const [room, dispatch] = useReducer(roomReducer, initialRoomState)
  const socket = useRef<WebSocket | null>(null)
  const attempts = useRef(0)
  const fatal = isFatal(room.phase)

  useEffect(() => {
    if (fatal) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const open = () => {
      const ws = new WebSocket(roomSocketUrl(code))
      socket.current = ws
      ws.onopen = async () => {
        attempts.current = 0
        dispatch({ type: 'open' })
        const me = identityRef.current
        const credentials = await me.credentials()
        // `credentials()` can hit the network (Clerk), and the socket may have
        // closed or been replaced while we waited.
        if (disposed || ws.readyState !== WebSocket.OPEN) return
        ws.send(
          JSON.stringify({ type: 'join', protocol: PROTOCOL_VERSION, name: me.name, ...credentials }),
        )
      }
      ws.onmessage = (event) => {
        let message: ServerMessage
        try {
          message = JSON.parse(event.data as string)
        } catch {
          return // Not our protocol; nothing sensible to do with an unparseable frame.
        }
        dispatch({ type: 'message', message })
      }
      ws.onclose = (event) => {
        if (disposed) return
        dispatch({ type: 'close', code: event.code })
        timer = setTimeout(open, Math.min(10000, 1000 * 2 ** attempts.current++))
      }
    }
    open()
    return () => {
      disposed = true
      clearTimeout(timer)
      socket.current?.close()
      socket.current = null
    }
  }, [code, fatal])

  const send = useCallback((message: ClientMessage) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message))
  }, [])

  const api = useMemo<RoomApi>(
    () => ({
      sit: (seat) => send({ type: 'sit', seat }),
      start: () => send({ type: 'start' }),
      move: (from, to, promotion) => send({ type: 'action', action: { kind: 'move', from, to, promotion } }),
      resign: () => send({ type: 'action', action: { kind: 'resign' } }),
      rematch: () => send({ type: 'rematch' }),
      dismissError: () => dispatch({ type: 'dismiss-error' }),
    }),
    [send],
  )

  return { room, api }
}
