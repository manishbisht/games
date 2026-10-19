import { useEffect, useState } from 'react'
import { Bell, BellOff, Share } from 'lucide-react'
import { useIdentity } from './identity'
import { disablePush, enablePush, pushStatus } from './notifications'
import type { PushStatus } from './notifications'
import './notify.css'

const HINTS: Partial<Record<PushStatus, string>> = {
  unsupported: 'This browser can’t show notifications.',
  blocked: 'Notifications are blocked for this site. Allow them in your browser’s site settings.',
  unavailable: 'Notifications aren’t available right now.',
}

/**
 * "Notify me when it's my turn": a switch for this browser. Permission is only
 * ever asked from its click. On an iPhone, where a site has to be on the Home
 * Screen to notify, it explains how instead of offering a switch that fails.
 */
export default function NotifyToggle({ className = '' }: { className?: string }) {
  const identity = useIdentity()
  const [status, setStatus] = useState<PushStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    pushStatus().then(
      (next) => live && setStatus(next),
      () => live && setStatus('unsupported'),
    )
    return () => {
      live = false
    }
  }, [])

  if (status === null) return null
  const on = status === 'on'

  if (status === 'install')
    return (
      <div className={`notify-toggle notify-toggle-hint ${className}`} role="note">
        <Share size={16} aria-hidden="true" />
        <p>
          <strong>Get a nudge when it’s your turn.</strong> On iPhone and iPad, tap Share, then{' '}
          <em>Add to Home Screen</em>, and turn notifications on from there.
        </p>
      </div>
    )

  const toggle = async () => {
    if (busy || !identity.isReady) return
    setBusy(true)
    setError('')
    try {
      const credentials = await identity.credentials()
      setStatus(on ? await disablePush(credentials) : await enablePush(credentials))
    } catch {
      setError(
        on ? 'Couldn’t turn notifications off. Try again.' : 'Couldn’t turn notifications on. Try again.',
      )
    } finally {
      setBusy(false)
    }
  }

  const disabled = status === 'unsupported' || status === 'unavailable' || status === 'blocked'
  return (
    <div className={`notify-toggle ${className}`}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        className="notify-switch"
        disabled={disabled || busy}
        onClick={toggle}
      >
        <span className="notify-switch-icon" aria-hidden="true" key={on ? 'on' : 'off'}>
          {on ? <Bell size={16} /> : <BellOff size={16} />}
        </span>
        <span className="notify-switch-label">
          Notify me when it’s my turn
          <small>{on ? 'On in this browser' : 'Only while you’re away from the table'}</small>
        </span>
        <span className="notify-switch-track" aria-hidden="true">
          <i />
        </span>
      </button>
      {(HINTS[status] || error) && (
        <p className="notify-toggle-note" role="status">
          {error || HINTS[status]}
        </p>
      )}
    </div>
  )
}
