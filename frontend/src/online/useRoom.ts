import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { PROTOCOL_VERSION } from '@games/shared/protocol'
import type { ClientMessage, SeatId, ServerMessage } from '@games/shared/protocol'
import { roomSocketUrl } from './api'
import { initialRoomState, isFatal, roomReducer } from './roomState'
import type { RoomClientState } from './roomState'
import { useIdentity } from './identity'
import type { IdentityCredentials } from './identity'

export interface RoomApi {
  sit: (seat: SeatId) => void
  leaveSeat: () => void
  start: () => void
  /** The game's own move/decision payload; the server's adapter validates it. */
  action: (payload: unknown) => void
  rematch: () => void
  claim: () => void
  /** Host only: seat a player the room itself takes the turns for. */
  addBot: (seat: SeatId, skill?: string) => void
  /** Host only: give a bot's seat back, so a latecomer can have it. */
  removeBot: (seat: SeatId) => void
  dismissError: () => void
}

/** The server's edge answers these without waking the room (setWebSocketAutoResponse). */
const HEARTBEAT_MS = 20000

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
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let missedPongs = 0
    const open = () => {
      const ws = new WebSocket(roomSocketUrl(code))
      socket.current = ws
      ws.onopen = async () => {
        attempts.current = 0
        dispatch({ type: 'open' })
        missedPongs = 0
        clearInterval(heartbeat)
        heartbeat = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return
          if (missedPongs >= 2) {
            // The connection is silently dead: closing it hands control to the
            // normal reconnect path (and lets the server mark us away).
            ws.close()
            return
          }
          missedPongs++
          ws.send('ping')
        }, HEARTBEAT_MS)
        const me = identityRef.current
        let credentials: IdentityCredentials
        try {
          credentials = await me.credentials()
        } catch (cause) {
          // A signed-in player whose token has gone refuses to be downgraded to
          // a guest, because joining under a second id would cost them their
          // seat. Say so and let the usual reconnect try again.
          if (disposed) return
          dispatch({
            type: 'message',
            message: {
              type: 'error',
              code: 'BAD_TOKEN',
              message: cause instanceof Error ? cause.message : 'We could not confirm who you are.',
            },
          })
          ws.close()
          return
        }
        // `credentials()` can hit the network (Clerk), and the socket may have
        // closed or been replaced while we waited.
        if (disposed || ws.readyState !== WebSocket.OPEN) return
        ws.send(JSON.stringify({ type: 'join', protocol: PROTOCOL_VERSION, name: me.name, ...credentials }))
      }
      ws.onmessage = (event) => {
        if (event.data === 'pong') {
          missedPongs = 0
          return
        }
        let message: ServerMessage
        try {
          message = JSON.parse(event.data as string)
        } catch {
          return // Not our protocol; nothing sensible to do with an unparseable frame.
        }
        dispatch({ type: 'message', message })
      }
      ws.onclose = (event) => {
        clearInterval(heartbeat)
        if (disposed) return
        dispatch({ type: 'close', code: event.code })
        timer = setTimeout(open, Math.min(10000, 1000 * 2 ** attempts.current++))
      }
    }
    open()
    return () => {
      disposed = true
      clearTimeout(timer)
      clearInterval(heartbeat)
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
      leaveSeat: () => send({ type: 'leaveSeat' }),
      start: () => send({ type: 'start' }),
      action: (payload) => send({ type: 'action', action: payload }),
      rematch: () => send({ type: 'rematch' }),
      claim: () => send({ type: 'claim' }),
      // The skill is left off entirely when unset, so the server picks the
      // first one its adapter offers rather than being handed `undefined`.
      addBot: (seat, skill) => send({ type: 'addBot', seat, ...(skill ? { skill } : {}) }),
      removeBot: (seat) => send({ type: 'removeBot', seat }),
      dismissError: () => dispatch({ type: 'dismiss-error' }),
    }),
    [send],
  )

  return { room, api }
}
