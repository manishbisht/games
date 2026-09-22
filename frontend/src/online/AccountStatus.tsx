import { UserRound } from 'lucide-react'
import type { Identity } from './identity'
import './auth.css'

/** Room seats keep the identity they joined with; account changes belong in the lobby. */
export default function AccountStatus({
  loading = false,
  name,
  avatar,
  isSignedIn = false,
}: Partial<Pick<Identity, 'name' | 'avatar' | 'isSignedIn'>> & { loading?: boolean }) {
  return (
    <span
      className="account-control account-status"
      role={loading ? 'status' : undefined}
      aria-label={loading ? 'Loading account' : `Playing as ${name || 'guest'}`}
      title={
        loading ? 'Loading account…' : `${name || 'Guest'} · ${isSignedIn ? 'Signed in' : 'Guest player'}`
      }
    >
      {avatar ? (
        <img src={avatar} alt="" width="28" height="28" />
      ) : (
        <UserRound size={17} aria-hidden="true" />
      )}
      <span className="account-status-name">{loading ? 'Loading account…' : name || 'Guest'}</span>
    </span>
  )
}

export function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.23c1.89-1.74 2.99-4.3 2.99-7.36Z"
      />
      <path
        fill="#34A853"
        d="M12 22c2.7 0 4.96-.9 6.61-2.41l-3.23-2.51c-.9.6-2.04.96-3.38.96-2.6 0-4.81-1.76-5.6-4.12H3.06v2.59A10 10 0 0 0 12 22Z"
      />
      <path fill="#FBBC05" d="M6.4 13.92a6 6 0 0 1 0-3.84V7.49H3.06a10 10 0 0 0 0 9.02l3.34-2.59Z" />
      <path
        fill="#EA4335"
        d="M12 5.96c1.47 0 2.79.5 3.82 1.49l2.87-2.87A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.94 5.49l3.34 2.59C7.19 7.72 9.4 5.96 12 5.96Z"
      />
    </svg>
  )
}
