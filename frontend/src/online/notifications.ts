import { deletePushSubscription, fetchPushKey, savePushSubscription } from './api'
import type { IdentityCredentials } from './api'
import { readyServiceWorker, serviceWorkerSupported } from './serviceWorker'

/**
 * Turn notifications in this browser. Opt-in only: permission is asked for in
 * the click that turns them on, never on load, and turning them off forgets
 * the subscription on both ends.
 *
 * - `unsupported`: this browser cannot do Web Push at all.
 * - `install`: an iPhone or iPad, which only offers push to a site added to the
 *   Home Screen — the page says how, rather than offering a switch that fails.
 * - `blocked`: the visitor (or their browser) said no; only site settings undo it.
 * - `unavailable`: the server has no push key configured, so nothing would ever arrive.
 */
export type PushStatus = 'unsupported' | 'install' | 'blocked' | 'unavailable' | 'off' | 'on'

const isAppleMobile = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

const standalone = () =>
  matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true

function support(): 'ok' | 'unsupported' | 'install' {
  const capable = serviceWorkerSupported() && 'PushManager' in window && 'Notification' in window
  if (capable) return 'ok'
  return isAppleMobile() && !standalone() ? 'install' : 'unsupported'
}

async function subscription(): Promise<PushSubscription | null> {
  if (!serviceWorkerSupported()) return null
  const registration = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL)
  return (await registration?.pushManager.getSubscription()) ?? null
}

let serverKey: Promise<string | null> | null = null
/** Asked once a page load; a failed ask is asked again next time. */
function pushKey(): Promise<string | null> {
  serverKey ??= fetchPushKey().catch(() => {
    serverKey = null
    return null
  })
  return serverKey
}

export async function pushStatus(): Promise<PushStatus> {
  const supported = support()
  if (supported !== 'ok') return supported
  if (Notification.permission === 'denied') return 'blocked'
  if (!(await pushKey())) return 'unavailable'
  return Notification.permission === 'granted' && (await subscription()) ? 'on' : 'off'
}

/** The server's key as the bytes `pushManager.subscribe` wants. */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

const sameBytes = (a: Uint8Array, b: Uint8Array) =>
  a.length === b.length && a.every((byte, i) => byte === b[i])

/**
 * Ask, subscribe, and tell the server — in that order, from a click. Answers
 * the status it ended in, so the switch can say what happened.
 */
export async function enablePush(credentials: IdentityCredentials): Promise<PushStatus> {
  const supported = support()
  if (supported !== 'ok') return supported
  const key = await pushKey()
  if (!key) return 'unavailable'
  const permission = await Notification.requestPermission()
  if (permission === 'denied') return 'blocked'
  if (permission !== 'granted') return 'off'
  const registration = await readyServiceWorker()
  if (!registration) return 'unsupported'
  let sub = await registration.pushManager.getSubscription()
  // A subscription made against an older key would never verify: start over.
  const current = sub?.options.applicationServerKey
  if (sub && current && !sameBytes(new Uint8Array(current), keyBytes(key))) {
    await sub.unsubscribe()
    sub = null
  }
  sub ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes(key),
  })
  await savePushSubscription(credentials, sub.toJSON())
  return 'on'
}

export async function disablePush(credentials: IdentityCredentials): Promise<PushStatus> {
  const sub = await subscription()
  if (sub) {
    // Forget it on the server first: a browser that unsubscribes but whose
    // server still holds the endpoint just costs a failed send later.
    await deletePushSubscription(credentials, sub.endpoint).catch(() => undefined)
    await sub.unsubscribe()
  }
  return 'off'
}
