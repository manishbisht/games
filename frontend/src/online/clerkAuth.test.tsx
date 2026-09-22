import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import ClerkAuthProvider, { ClerkHeaderAuth } from './clerkAuth'
import { useIdentity } from './identity'
import type { Identity } from './identity'

const auth = vi.hoisted(() => ({ isLoaded: true, isSignedIn: true, getToken: vi.fn() }))
const profile = vi.hoisted(() => ({
  isLoaded: false,
  user: null as null | { fullName: string; username: string; imageUrl: string },
}))
const signIn = vi.hoisted(() => vi.fn(({ children }: { children: ReactNode }) => children))
vi.mock('@clerk/react', () => ({
  ClerkProvider: ({ children }: { children: ReactNode }) => children,
  useAuth: () => auth,
  useUser: () => profile,
  SignInButton: signIn,
  UserButton: () => null,
}))

function readIdentity() {
  let result: Identity | undefined
  function Probe() {
    result = useIdentity()
    return null
  }
  renderToStaticMarkup(
    <ClerkAuthProvider publishableKey="test">
      <Probe />
    </ClerkAuthProvider>,
  )
  return result!
}

describe('Clerk identity readiness', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', { getItem: () => 'Guest' })
    auth.isLoaded = true
    auth.isSignedIn = true
    profile.isLoaded = false
    profile.user = null
    vi.clearAllMocks()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('does not let a signed-in player create a guest-owned room while their profile loads', () => {
    expect(readIdentity().isReady).toBe(false)
  })

  it('uses the account name once the profile is ready', () => {
    profile.isLoaded = true
    profile.user = { fullName: 'Robin', username: '', imageUrl: 'https://example.com/avatar.png' }
    expect(readIdentity()).toMatchObject({ isReady: true, isSignedIn: true, name: 'Robin' })
  })

  it('lets a resolved signed-out visitor play as a guest', () => {
    auth.isSignedIn = false
    profile.isLoaded = true
    expect(readIdentity()).toMatchObject({ isReady: true, isSignedIn: false, name: 'Guest' })
  })

  it('sends the account token, not a guest id, when a signed-in player joins', async () => {
    profile.isLoaded = true
    profile.user = { fullName: 'Robin', username: '', imageUrl: 'https://example.com/avatar.png' }
    auth.getToken.mockResolvedValue('token-abc')
    await expect(readIdentity().credentials()).resolves.toEqual({
      clerkToken: 'token-abc',
      avatar: 'https://example.com/avatar.png',
    })
  })

  // Falling back to a guest id here would cost a signed-in player their seat
  // and their host: the room keys ownership off whatever this returns.
  it('refuses to fall back to a guest id when the account token has gone', async () => {
    profile.isLoaded = true
    profile.user = { fullName: 'Robin', username: '', imageUrl: '' }
    auth.getToken.mockResolvedValue(null)
    await expect(readIdentity().credentials()).rejects.toThrow(/sign-in has expired/i)
  })

  it('keeps the account button in place while the profile is still arriving', () => {
    auth.isSignedIn = true
    profile.isLoaded = true
    profile.user = null
    const html = renderToStaticMarkup(<ClerkHeaderAuth />)
    expect(html).toContain('account-signed-in')
    expect(html).not.toContain('Sign in with Google')
  })

  it('keeps a direct game or invitation URL after sign-in and sign-up', () => {
    auth.isSignedIn = false
    profile.isLoaded = true
    vi.stubGlobal('window', { location: { href: 'https://games.example/#/prism/room/ABC234' } })
    const html = renderToStaticMarkup(<ClerkHeaderAuth />)
    expect(html).toContain('Sign in with Google')
    expect(signIn.mock.calls[0][0]).toMatchObject({
      mode: 'modal',
      forceRedirectUrl: 'https://games.example/#/prism/room/ABC234',
      signUpForceRedirectUrl: 'https://games.example/#/prism/room/ABC234',
    })
  })

  it('replaces the sign-in action with the signed-in player name', () => {
    profile.isLoaded = true
    profile.user = { fullName: 'Robin', username: '', imageUrl: '' }
    const html = renderToStaticMarkup(<ClerkHeaderAuth />)
    expect(html).toContain('Robin')
    expect(html).not.toContain('Sign in with Google')
  })
})
