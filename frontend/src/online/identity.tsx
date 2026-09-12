/* eslint-disable react-refresh/only-export-components -- the identity context,
   its hooks and its provider components are one unit by design; splitting them
   apart just to satisfy fast refresh would buy nothing. */
import { createContext, lazy, Suspense, useCallback, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { guestId, guestName, saveGuestName } from './guest'

export interface IdentityCredentials {
  guestId?: string
  clerkToken?: string
  avatar?: string
}

export interface Identity {
  name: string
  setName: (name: string) => void
  isSignedIn: boolean
  /**
   * False while an auth provider is still resolving. Nothing may create or join
   * a room before this flips: the id we'd send now (a guest id) is not the id
   * we'd send once Clerk loads, and rooms key host/seat ownership off that id.
   */
  isReady: boolean
  avatar?: string
  credentials: () => Promise<IdentityCredentials>
}

// `|| undefined` so an empty string from CI counts as "not configured".
const CLERK_KEY: string | undefined = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY || undefined
export const IdentityContext = createContext<Identity | null>(null)

// Clerk is optional, so it is loaded on demand: no publishable key means the
// SDK is never fetched, and it stays out of the entry chunk either way.
const ClerkAuthProvider = lazy(() => import('./clerkAuth'))
const ClerkHeaderAuth = lazy(() =>
  import('./clerkAuth').then((module) => ({ default: module.ClerkHeaderAuth })),
)

export function useIdentity(): Identity {
  const identity = useContext(IdentityContext)
  if (!identity) throw new Error('useIdentity must be used inside AuthProvider')
  return identity
}

export function useGuestIdentity(): Identity {
  const [name, setNameState] = useState(guestName)
  const setName = useCallback((value: string) => {
    saveGuestName(value)
    setNameState(guestName())
  }, [])
  const credentials = useCallback(async () => ({ guestId: guestId() }), [])
  return useMemo(
    () => ({ name, setName, isSignedIn: false, isReady: true, credentials }),
    [name, setName, credentials],
  )
}

/**
 * `ready={false}` is for the one case where we know a guest identity is only a
 * placeholder: Clerk is configured but its chunk hasn't arrived yet, so the
 * guest id below is not the id this visitor will end up playing as.
 */
export function GuestIdentity({ children, ready = true }: { children: ReactNode; ready?: boolean }) {
  const guest = useGuestIdentity()
  const identity = useMemo(() => (ready ? guest : { ...guest, isReady: false }), [guest, ready])
  return <IdentityContext.Provider value={identity}>{children}</IdentityContext.Provider>
}

/** Clerk is optional: with no publishable key the whole tree runs guest-only. */
export function AuthProvider({ children }: { children: ReactNode }) {
  if (!CLERK_KEY) return <GuestIdentity>{children}</GuestIdentity>
  return (
    <Suspense fallback={<GuestIdentity ready={false}>{children}</GuestIdentity>}>
      <ClerkAuthProvider publishableKey={CLERK_KEY}>{children}</ClerkAuthProvider>
    </Suspense>
  )
}

export function HeaderAuth() {
  if (!CLERK_KEY) return null
  return (
    <Suspense fallback={null}>
      <ClerkHeaderAuth />
    </Suspense>
  )
}
