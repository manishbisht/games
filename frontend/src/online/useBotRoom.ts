import { useCallback, useState } from 'react'
import { useNavigate } from 'react-router'
import type { GameId } from '@games/shared/protocol'
import { createRoom } from './api'
import type { RoomSetup } from './api'
import { useIdentity } from './identity'

/**
 * Starting a game against bots. There is no local game any more: the setup
 * panel describes a table, the server deals it, and the browser plays none of
 * it — so "play vs bot" and "play with friends" are one program with the same
 * room at the end of both.
 *
 * The room is private and starts itself, so the player lands on a board rather
 * than flickering through a waiting room they are the only one in.
 */
export function useBotRoom(game: GameId, basePath: string) {
  const navigate = useNavigate()
  const identity = useIdentity()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const start = useCallback(
    async (setup: Omit<RoomSetup, 'autoStart'>) => {
      // Wait for identity to settle, or the room would be owned by a guest id
      // that is about to be replaced.
      if (busy || !identity.isReady) return
      setBusy(true)
      setError('')
      try {
        const name = identity.name.trim() || 'You'
        if (!identity.isSignedIn) identity.setName(name)
        const code = await createRoom(game, 'private', name, await identity.credentials(), {
          ...setup,
          autoStart: true,
        })
        navigate(`${basePath}/room/${code}`)
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : 'Something went wrong.')
      } finally {
        setBusy(false)
      }
    },
    [busy, identity, game, basePath, navigate],
  )

  return { start, busy, error }
}
