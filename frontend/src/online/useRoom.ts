import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { PROTOCOL_VERSION } from '@games/shared/protocol'
import type { ClientMessage, ReactionId, SeatId, ServerMessage } from '@games/shared/protocol'
import { viewTransition } from '../navigation'
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
  /**
   * A quick reaction to the table (see `REACTIONS`), for everyone in the room —
   * spectators included. Only sent while connected: a reaction kept for a
   * reconnect would land long after the moment it was about.
   *
   * Always present on a live room. Optional in the type only so the hand-built
   * test doubles written before it existed still compile.
   */
  react?: (reaction: ReactionId) => void
  dismissError: () => void
}

/** The server's edge answers these without waking the room (setWebSocketAutoResponse). */
const HEARTBEAT_MS = 20000
/**
 * What a reconnect may carry over: a click made while the socket was down is
 * sent once it is back, unless the moment has plainly passed — a minute-old
 * move would only earn an error about a turn that has moved on.
 */
const OUTBOX_LIMIT = 16
const OUTBOX_MAX_AGE_MS = 15000

/** 1s, 2s, 4s… up to 10s, each ±25% so a room's players don't all knock at once after a blip. */
const backoff = (attempt: number) => Math.min(10000, 1000 * 2 ** attempt) * (0.75 + Math.random() * 0.5)

/**
 * `warm` fetches whatever the table needs before it can be drawn (the game's
 * RoomView chunk); the start of a game waits briefly on it, so the lobby can
 * cross into a board rather than into a loading screen.
 */
export function useRoom(
  code: string,
  warm?: () => Promise<unknown>,
): { room: RoomClientState; api: RoomApi } {
  const identity = useIdentity()
  const identityRef = useRef(identity)
  useEffect(() => {
    identityRef.current = identity
  })
  const [room, dispatch] = useReducer(roomReducer, initialRoomState)
  const socket = useRef<WebSocket | null>(null)
  const attempts = useRef(0)
  const outbox = useRef<{ at: number; frame: string }[]>([])
  const joined = useRef(false)
  const playing = useRef(false)
  const warmRef = useRef(warm)
  useEffect(() => {
    warmRef.current = warm
  })
  const fatal = isFatal(room.phase)

  useEffect(() => {
    if (fatal) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let missedPongs = 0
    /**
     * Server messages, in order — except that the one which starts (or ends)
     * the game is committed as a view transition, whose update runs a frame
     * or more later. Whatever arrives meanwhile is held and committed with it,
     * so a later snapshot can never land before the one it follows.
     */
    let held: { message: ServerMessage; receivedAt: number }[] | null = null
    const deliver = (message: ServerMessage, receivedAt: number) => {
      if (held) return void held.push({ message, receivedAt })
      const nowPlaying = message.type === 'room' ? message.snapshot.gameState !== null : playing.current
      if (nowPlaying === playing.current) return dispatch({ type: 'message', message, receivedAt })
      playing.current = nowPlaying
      held = []
      viewTransition(
        'swap',
        () => {
          dispatch({ type: 'message', message, receivedAt })
          for (const next of held ?? []) dispatch({ type: 'message', ...next })
          held = null
        },
        {
          prepare: () =>
            Promise.race([warmRef.current?.(), new Promise((resolve) => setTimeout(resolve, 400))]),
        },
      )
    }
    const flushOutbox = (ws: WebSocket) => {
      const fresh = outbox.current.filter((entry) => Date.now() - entry.at < OUTBOX_MAX_AGE_MS)
      outbox.current = []
      for (const entry of fresh) ws.send(entry.frame)
    }
    const open = () => {
      timer = undefined
      joined.current = false
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
        ws.send(
          JSON.stringify({
            type: 'join',
            protocol: PROTOCOL_VERSION,
            name: me.name,
            ...credentials,
            features: ['reactions'],
          } satisfies ClientMessage),
        )
        // The room reads frames in order, so these follow the join.
        joined.current = true
        flushOutbox(ws)
      }
      ws.onmessage = (event) => {
        // Stamped on arrival: a game syncing to the room's clock counts from here, not from its render.
        const receivedAt = performance.now()
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
        deliver(message, receivedAt)
      }
      ws.onclose = (event) => {
        clearInterval(heartbeat)
        // A replaced socket's close can arrive after its successor has joined
        // (StrictMode's double mount, a quick reconnect); it speaks for itself only.
        if (disposed || socket.current !== ws) return
        joined.current = false
        dispatch({ type: 'close', code: event.code })
        timer = setTimeout(open, backoff(attempts.current++))
      }
    }
    // Waiting out a backoff is pointless once the network is back or the
    // player has returned to the tab (a phone wakes with a dead socket).
    const retryNow = () => {
      if (timer === undefined || document.visibilityState !== 'visible') return
      clearTimeout(timer)
      open()
    }
    open()
    window.addEventListener('online', retryNow)
    document.addEventListener('visibilitychange', retryNow)
    return () => {
      disposed = true
      clearTimeout(timer)
      clearInterval(heartbeat)
      window.removeEventListener('online', retryNow)
      document.removeEventListener('visibilitychange', retryNow)
      joined.current = false
      socket.current?.close()
      socket.current = null
    }
  }, [code, fatal])

  // Sent now if the room is listening; otherwise kept (briefly) for the
  // reconnect, rather than a click vanishing without a word.
  const send = useCallback((message: ClientMessage) => {
    const frame = JSON.stringify(message),
      ws = socket.current
    if (ws?.readyState === WebSocket.OPEN && joined.current) return ws.send(frame)
    outbox.current = [...outbox.current, { at: Date.now(), frame }].slice(-OUTBOX_LIMIT)
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
      react: (reaction) => {
        const ws = socket.current
        if (ws?.readyState === WebSocket.OPEN && joined.current)
          ws.send(JSON.stringify({ type: 'react', reaction } satisfies ClientMessage))
      },
      dismissError: () => dispatch({ type: 'dismiss-error' }),
    }),
    [send],
  )

  return { room, api }
}
