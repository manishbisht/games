import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ClerkProvider, SignInButton, UserButton, useAuth, useUser } from '@clerk/react'
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
  avatar?: string
  credentials: () => Promise<IdentityCredentials>
}

// `|| undefined` so an empty string from CI counts as "not configured".
const CLERK_KEY: string | undefined = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY || undefined
const IdentityContext = createContext<Identity | null>(null)

// eslint-disable-next-line react-refresh/only-export-components -- hook lives alongside AuthProvider/HeaderAuth by design
export function useIdentity(): Identity {
  const identity = useContext(IdentityContext)
  if (!identity) throw new Error('useIdentity must be used inside AuthProvider')
  return identity
}

function useGuestIdentity(): Identity {
  const [name, setNameState] = useState(guestName)
  const setName = useCallback((value: string) => {
    saveGuestName(value)
    setNameState(guestName())
  }, [])
  const credentials = useCallback(async () => ({ guestId: guestId() }), [])
  return useMemo(
    () => ({ name, setName, isSignedIn: false, credentials }),
    [name, setName, credentials],
  )
}

function GuestIdentity({ children }: { children: ReactNode }) {
  const identity = useGuestIdentity()
  return <IdentityContext.Provider value={identity}>{children}</IdentityContext.Provider>
}

function ClerkIdentity({ children }: { children: ReactNode }) {
  const guest = useGuestIdentity()
  const { isLoaded, isSignedIn, getToken } = useAuth()
  const { user } = useUser()
  const identity = useMemo<Identity>(() => {
    if (!isLoaded || !isSignedIn || !user) return guest
    return {
      name: user.fullName || user.username || 'Player',
      setName: () => undefined,
      isSignedIn: true,
      avatar: user.imageUrl,
      credentials: async () => {
        const token = await getToken()
        return token ? { clerkToken: token, avatar: user.imageUrl } : { guestId: guestId() }
      },
    }
  }, [guest, isLoaded, isSignedIn, user, getToken])
  return <IdentityContext.Provider value={identity}>{children}</IdentityContext.Provider>
}

/** Clerk is optional: with no publishable key the whole tree runs guest-only. */
export function AuthProvider({ children }: { children: ReactNode }) {
  if (!CLERK_KEY) return <GuestIdentity>{children}</GuestIdentity>
  return (
    <ClerkProvider publishableKey={CLERK_KEY}>
      <ClerkIdentity>{children}</ClerkIdentity>
    </ClerkProvider>
  )
}

export function HeaderAuth() {
  if (!CLERK_KEY) return null
  return <ClerkHeaderAuth />
}

function ClerkHeaderAuth() {
  const { isLoaded, isSignedIn } = useAuth()
  if (!isLoaded) return null
  if (isSignedIn) return <UserButton />
  return (
    <SignInButton mode="modal">
      <button className="collection-signin">Sign in</button>
    </SignInButton>
  )
}
