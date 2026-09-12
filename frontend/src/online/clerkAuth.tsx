import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { ClerkProvider, SignInButton, UserButton, useAuth, useUser } from '@clerk/react'
import { guestId } from './guest'
import { IdentityContext, useGuestIdentity } from './identity'
import type { Identity } from './identity'

// Everything that touches @clerk/react lives here so the SDK lands in its own
// lazily-loaded chunk: visitors with no publishable key never download it.

function ClerkIdentity({ children }: { children: ReactNode }) {
  const guest = useGuestIdentity()
  const { isLoaded, isSignedIn, getToken } = useAuth()
  const { user } = useUser()
  const identity = useMemo<Identity>(() => {
    // Until Clerk has loaded we cannot tell a signed-in user from a guest, so
    // report "not ready" rather than handing out a guest id we'd have to
    // replace a moment later.
    if (!isLoaded) return { ...guest, isReady: false }
    if (!isSignedIn || !user) return guest
    return {
      name: user.fullName || user.username || 'Player',
      setName: () => undefined,
      isSignedIn: true,
      isReady: true,
      avatar: user.imageUrl,
      credentials: async () => {
        const token = await getToken()
        return token ? { clerkToken: token, avatar: user.imageUrl } : { guestId: guestId() }
      },
    }
  }, [guest, isLoaded, isSignedIn, user, getToken])
  return <IdentityContext.Provider value={identity}>{children}</IdentityContext.Provider>
}

export default function ClerkAuthProvider({
  publishableKey,
  children,
}: {
  publishableKey: string
  children: ReactNode
}) {
  return (
    <ClerkProvider publishableKey={publishableKey}>
      <ClerkIdentity>{children}</ClerkIdentity>
    </ClerkProvider>
  )
}

export function ClerkHeaderAuth() {
  const { isLoaded, isSignedIn } = useAuth()
  if (!isLoaded) return null
  if (isSignedIn) return <UserButton />
  return (
    <SignInButton mode="modal">
      <button className="collection-signin">Sign in</button>
    </SignInButton>
  )
}
