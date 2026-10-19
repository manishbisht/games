import { useEffect, useState } from 'react'
import type { MyProfile } from '@games/shared/protocol'
import { fetchMe } from './api'
import { useIdentity } from './identity'

/**
 * This player's own record (GET /api/me), for the home page's "Your tables"
 * and the profile page. Fetched once the identity has settled — before then
 * the id we would ask as is not the one we play as — and again whenever the
 * tab comes back into view, since a table's turn moves on while nobody looks.
 *
 * `profile` stays null until the first answer; a failed refresh keeps the last
 * good one rather than blanking the page.
 */
export function useMe(): { profile: MyProfile | null; failed: boolean } {
  const identity = useIdentity()
  const { isReady, isSignedIn, credentials } = identity
  const [profile, setProfile] = useState<MyProfile | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!isReady) return
    let controller: AbortController | null = null
    const load = async () => {
      controller?.abort()
      const mine = (controller = new AbortController())
      try {
        const next = await fetchMe(await credentials(), mine.signal)
        if (mine.signal.aborted) return
        setProfile(next)
        setFailed(false)
      } catch {
        if (!mine.signal.aborted) setFailed(true)
      }
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load()
    }
    void load()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      controller?.abort()
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [isReady, isSignedIn, credentials])

  return { profile, failed }
}
