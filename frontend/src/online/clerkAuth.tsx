import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { ClerkProvider, SignInButton, UserButton, useAuth, useUser } from '@clerk/react'
import { IdentityContext, useGuestIdentity } from './identity'
import type { Identity } from './identity'
import AccountStatus, { GoogleMark } from './AccountStatus'

// Everything that touches @clerk/react lives here so the SDK lands in its own
// lazily-loaded chunk: visitors with no publishable key never download it.

/**
 * Clerk has not finished saying who this visitor is. Asked in one place because
 * the header and the room identity have to agree: a header that calls someone
 * signed in before the identity does reopens the guest-id race the readiness
 * flag exists to close.
 */
function useClerkPending(): boolean {
  const { isLoaded, isSignedIn } = useAuth()
  const { user, isLoaded: userLoaded } = useUser()
  return !isLoaded || !userLoaded || (Boolean(isSignedIn) && !user)
}

/** What to call a signed-in player, in one place so every surface agrees. */
const displayName = (user: { fullName: string | null; username: string | null } | null | undefined) =>
  user?.fullName || user?.username || 'Player'

function ClerkIdentity({ children }: { children: ReactNode }) {
  const guest = useGuestIdentity()
  const { isSignedIn, getToken } = useAuth()
  const { user } = useUser()
  // Until Clerk has loaded we cannot tell a signed-in user from a guest, so
  // report "not ready" rather than handing out a guest id we'd have to replace
  // a moment later.
  const pending = useClerkPending()
  const identity = useMemo<Identity>(() => {
    if (pending) return { ...guest, isReady: false }
    if (!isSignedIn || !user) return guest
    return {
      name: displayName(user),
      setName: () => undefined,
      isSignedIn: true,
      isReady: true,
      avatar: user.imageUrl,
      credentials: async () => {
        const token = await getToken()
        // Never fall back to a guest id here. The room keys host and seat
        // ownership off whatever we send, so arriving as a guest and then
        // reconnecting with a token makes this player two different people —
        // and the second one owns nothing.
        if (!token) throw new Error('Your sign-in has expired. Sign in again to keep your seat.')
        return { clerkToken: token, avatar: user.imageUrl }
      },
    }
  }, [guest, pending, isSignedIn, user, getToken])
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
    <ClerkProvider
      publishableKey={publishableKey}
      appearance={{
        options: { socialButtonsVariant: 'blockButton', socialButtonsPlacement: 'top' },
        variables: { colorPrimary: '#52654a', fontFamily: 'DM Sans, sans-serif', borderRadius: '0.75rem' },
      }}
    >
      <ClerkIdentity>{children}</ClerkIdentity>
    </ClerkProvider>
  )
}

export function ClerkHeaderAuth() {
  const { isLoaded, isSignedIn } = useAuth()
  const { user, isLoaded: userLoaded } = useUser()
  // Deliberately narrower than `useClerkPending`: once Clerk says this visitor
  // is signed in, keep the account button mounted even while the profile is
  // still arriving, so focus has somewhere to land when the sign-in modal
  // closes. Only the name waits for `user`. Ids are not involved here.
  if (!isLoaded || !userLoaded) return <AccountStatus loading />
  if (isSignedIn)
    return (
      <div className="account-control account-signed-in">
        {user && (
          <span className="account-status-name" title={displayName(user)}>
            {displayName(user)}
          </span>
        )}
        <UserButton
          appearance={{ elements: { userButtonTrigger: { minWidth: '44px', minHeight: '44px' } } }}
        />
      </div>
    )
  const returnUrl = window.location.href
  return (
    <div className="account-control">
      <SignInButton mode="modal" forceRedirectUrl={returnUrl} signUpForceRedirectUrl={returnUrl}>
        <button type="button" className="account-signin">
          <GoogleMark /> <span>Sign in with Google</span>
        </button>
      </SignInButton>
    </div>
  )
}
