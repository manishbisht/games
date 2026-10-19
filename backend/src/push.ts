/**
 * Web Push from a Worker with nothing but WebCrypto:
 *
 * - RFC 8291 message encryption: an ephemeral ECDH P-256 key against the
 *   browser's subscription key, HKDF-SHA-256 mixed with its auth secret, then
 *   one AES-128-GCM record in the RFC 8188 `aes128gcm` content coding.
 * - RFC 8292 VAPID: an ES256 JWT naming the push service as its audience,
 *   signed with the application server key the browser subscribed against.
 *
 * Keys travel as base64url, the form browsers and every push library use: the
 * public key is the 65-byte uncompressed point (`VAPID_PUBLIC_KEY`, a plain
 * var), the private key its 32-byte scalar (`VAPID_PRIVATE_KEY`, a secret).
 */

export interface PushSubscriptionKeys {
  endpoint: string
  /** The browser's ECDH public key, base64url, 65 bytes uncompressed. */
  p256dh: string
  /** The browser's auth secret, base64url, 16 bytes. */
  auth: string
}

export interface VapidKeys {
  publicKey: string
  privateKey: string
  /** A `mailto:` or `https:` contact the push service can reach the sender at. */
  subject: string
}

export function b64uEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function b64uDecode(text: string): Uint8Array {
  const base64 = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4))
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

const utf8 = (text: string) => new TextEncoder().encode(text)

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  return new Uint8Array(await crypto.subtle.sign('HMAC', imported, data))
}

/**
 * HKDF (RFC 5869) for outputs of at most one SHA-256 block, which is all Web
 * Push ever asks for: extract with `salt`, expand `info` into `length` bytes.
 */
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) {
  const prk = await hmac(salt, ikm)
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, length)
}

/** A P-256 key pair as WebCrypto JWK pieces, from the raw public point and (optionally) private scalar. */
function p256Jwk(publicKey: Uint8Array, privateKey?: Uint8Array): JsonWebKey {
  if (publicKey.length !== 65 || publicKey[0] !== 4) throw new Error('expected an uncompressed P-256 point')
  return {
    kty: 'EC',
    crv: 'P-256',
    x: b64uEncode(publicKey.slice(1, 33)),
    y: b64uEncode(publicKey.slice(33, 65)),
    ...(privateKey ? { d: b64uEncode(privateKey) } : {}),
    ext: true,
  }
}

/** The fixed record size this sender declares; the whole payload is one record well under it. */
const RECORD_SIZE = 4096

/**
 * Encrypt `plaintext` for one subscription (RFC 8291 §3–4). `salt` and the
 * sender's ECDH key pair are fresh for every message; tests pass the RFC's own
 * to reproduce its example byte for byte.
 */
export async function encryptPayload(
  plaintext: Uint8Array,
  subscription: Pick<PushSubscriptionKeys, 'p256dh' | 'auth'>,
  fixed: { salt?: Uint8Array; sender?: { publicKey: Uint8Array; privateKey: Uint8Array } } = {},
): Promise<Uint8Array> {
  const uaPublic = b64uDecode(subscription.p256dh),
    authSecret = b64uDecode(subscription.auth)
  const salt = fixed.salt ?? crypto.getRandomValues(new Uint8Array(16))
  let asPublic: Uint8Array, asPrivate: CryptoKey
  if (fixed.sender) {
    asPublic = fixed.sender.publicKey
    asPrivate = await crypto.subtle.importKey(
      'jwk',
      p256Jwk(fixed.sender.publicKey, fixed.sender.privateKey),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    )
  } else {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ])) as CryptoKeyPair
    asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer)
    asPrivate = pair.privateKey
  }
  const uaKey = await crypto.subtle.importKey(
    'raw',
    uaPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  )
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      // workers-types spells the field `$public`; the runtime reads `public`, as everywhere else.
      { name: 'ECDH', public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      asPrivate,
      256,
    ),
  )
  // §3.3: the auth secret and both public keys are mixed into the input keying material.
  const ikm = await hkdf(authSecret, ecdhSecret, concat(utf8('WebPush: info\0'), uaPublic, asPublic), 32)
  // RFC 8188 §2.2–2.3: content key and nonce, from the per-message salt.
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16)
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12)
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  // One record, so it is also the last: the delimiter is 0x02, and no padding.
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(plaintext, new Uint8Array([2]))),
  )
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length)
  header.set(salt, 0)
  new DataView(header.buffer).setUint32(16, RECORD_SIZE)
  header[20] = asPublic.length
  header.set(asPublic, 21)
  return concat(header, ciphertext)
}

/**
 * The `Authorization` header for one push service (RFC 8292 §2–3): an ES256
 * JWT whose audience is the endpoint's origin, valid for twelve hours (the
 * spec's ceiling is twenty-four), and the public key it verifies against.
 */
export async function vapidAuthorization(endpoint: string, keys: VapidKeys, now = Date.now()) {
  const header = b64uEncode(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
  const claims = b64uEncode(
    utf8(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        exp: Math.floor(now / 1000) + 12 * 60 * 60,
        sub: keys.subject,
      }),
    ),
  )
  const signingKey = await crypto.subtle.importKey(
    'jwk',
    p256Jwk(b64uDecode(keys.publicKey), b64uDecode(keys.privateKey)),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )
  // WebCrypto's ECDSA signature is already the raw r‖s that JWS wants.
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, utf8(`${header}.${claims}`)),
  )
  return `vapid t=${header}.${claims}.${b64uEncode(signature)}, k=${keys.publicKey}`
}

/**
 * Push services this server will deliver to. A subscription names its own
 * endpoint, so without a list the Worker would POST wherever a client asked.
 * These are the services the major browsers use.
 */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /^[a-z0-9-]+\.push\.apple\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
]

/**
 * Whether this server will POST to `endpoint`: https, on its default port, at
 * one of the push services above. Checked when a subscription is stored and
 * again as each push leaves, so a row stored under an older, looser rule is
 * never sent to.
 */
export function deliverable(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== 'string' || endpoint.length > 1024) return false
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  return (
    url.protocol === 'https:' &&
    url.port === '' &&
    !url.username &&
    !url.password &&
    PUSH_HOSTS.some((host) => host.test(url.hostname))
  )
}

/** A browser's subscription narrowed to something this server will store and send to, or null. */
export function validSubscription(raw: unknown): PushSubscriptionKeys | null {
  if (!raw || typeof raw !== 'object') return null
  const { endpoint, keys } = raw as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }
  if (!deliverable(endpoint)) return null
  const p256dh = keys?.p256dh,
    auth = keys?.auth
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return null
  try {
    const point = b64uDecode(p256dh)
    if (point.length !== 65 || point[0] !== 4 || b64uDecode(auth).length !== 16) return null
  } catch {
    return null
  }
  return { endpoint, p256dh, auth }
}

export interface PushMessage {
  title: string
  body: string
  /** In-app route the notification opens, e.g. `/chess/room/ABC234`; the service worker adds its own origin and base. */
  path: string
  /** Replaces an earlier notification with the same tag instead of stacking. */
  tag: string
}

/**
 * Deliver one message to one subscription. Answers the push service's status:
 * 201 delivered, 404/410 the subscription is gone for good (the caller forgets
 * it), anything else worth no more than a shrug — a notification is a nicety.
 * 0 when the endpoint is not one this server sends to.
 */
export async function sendPush(
  subscription: PushSubscriptionKeys,
  message: PushMessage,
  keys: VapidKeys,
  fetcher: typeof fetch = fetch,
): Promise<number> {
  if (!deliverable(subscription.endpoint)) return 0
  const body = await encryptPayload(utf8(JSON.stringify(message)), subscription)
  const response = await fetcher(subscription.endpoint, {
    method: 'POST',
    // A push service answers; it never sends us on. A redirect would carry this
    // POST somewhere the allowlist never approved, so it counts as a failure.
    redirect: 'manual',
    headers: {
      Authorization: await vapidAuthorization(subscription.endpoint, keys),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      // A turn that has waited an hour is a turn somebody else has taken.
      TTL: '3600',
      Urgency: 'high',
      Topic: message.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32),
    },
    body,
  })
  // Drain it either way, so the connection goes back to the pool.
  await response.body?.cancel()
  return response.status
}
