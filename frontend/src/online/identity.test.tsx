import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'

// A room seat keeps the identity it joined with, so the header inside a room
// reports who you are and offers no way to change it. In the lobby the same
// header hands over to Clerk's own control instead.

vi.mock('@clerk/react', () => ({
  ClerkProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => ({ isLoaded: true, isSignedIn: false, getToken: vi.fn() }),
  useUser: () => ({ isLoaded: true, user: null }),
  SignInButton: ({ children }: { children: ReactNode }) => children,
  UserButton: () => null,
}))

/** `HeaderAuth` reads the publishable key at module load, so re-import it. */
async function header(readOnly: boolean) {
  const { GuestIdentity, HeaderAuth } = await import('./identity')
  return renderToStaticMarkup(
    <GuestIdentity>
      <HeaderAuth readOnly={readOnly} />
    </GuestIdentity>,
  )
}

describe('HeaderAuth with sign-in configured', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv('VITE_CLERK_PUBLISHABLE_KEY', 'pk_test_key')
    vi.stubGlobal('localStorage', { getItem: () => 'Robin', setItem: () => undefined })
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  it('names the player, and offers no account switch, inside a room', async () => {
    const html = await header(true)
    expect(html).toContain('Robin')
    expect(html).toContain('Playing as Robin')
  })

  it('hands over to the account control in the lobby', async () => {
    const html = await header(false)
    expect(html).not.toContain('Playing as Robin')
  })
})
