import { describe, expect, it } from 'vitest'
import {
  b64uDecode,
  b64uEncode,
  encryptPayload,
  sendPush,
  vapidAuthorization,
  validSubscription,
} from '../src/push'

/** RFC 8291 §5 and Appendix A, verbatim (whitespace removed). */
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6Tlz' +
    'AC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

describe('RFC 8291 message encryption', () => {
  it('reproduces the RFC example byte for byte', async () => {
    const body = await encryptPayload(
      new TextEncoder().encode(RFC.plaintext),
      { p256dh: RFC.uaPublic, auth: RFC.auth },
      {
        salt: b64uDecode(RFC.salt),
        sender: { publicKey: b64uDecode(RFC.asPublic), privateKey: b64uDecode(RFC.asPrivate) },
      },
    )
    expect(b64uEncode(body)).toBe(RFC.body)
    // The 86-octet header: salt, record size 4096, key length 65, sender key.
    expect(body.length).toBe(86 + RFC.plaintext.length + 1 + 16)
  })

  it('uses a fresh salt and sender key every time', async () => {
    const sub = { p256dh: RFC.uaPublic, auth: RFC.auth }
    const plain = new TextEncoder().encode('hello')
    const [a, b] = await Promise.all([encryptPayload(plain, sub), encryptPayload(plain, sub)])
    expect(b64uEncode(a.slice(0, 16))).not.toBe(b64uEncode(b.slice(0, 16)))
    expect(b64uEncode(a.slice(21, 86))).not.toBe(b64uEncode(b.slice(21, 86)))
  })

  it('round-trips through the receiving side of the RFC (decrypting with ua_private)', async () => {
    // Decrypt as a browser would, from the RFC's user agent key, to show a
    // random-salt message is just as readable as the fixed example.
    const body = await encryptPayload(new TextEncoder().encode('Your turn'), {
      p256dh: RFC.uaPublic,
      auth: RFC.auth,
    })
    const salt = body.slice(0, 16),
      asPublic = body.slice(21, 86),
      ciphertext = body.slice(86)
    const ua = b64uDecode(RFC.uaPublic)
    const uaKey = await crypto.subtle.importKey(
      'jwk',
      {
        kty: 'EC',
        crv: 'P-256',
        x: b64uEncode(ua.slice(1, 33)),
        y: b64uEncode(ua.slice(33)),
        d: RFC.uaPrivate,
      },
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    )
    const asKey = await crypto.subtle.importKey(
      'raw',
      asPublic,
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      [],
    )
    const secret = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: 'ECDH', public: asKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
        uaKey,
        256,
      ),
    )
    const hmac = async (key: Uint8Array, data: Uint8Array) =>
      new Uint8Array(
        await crypto.subtle.sign(
          'HMAC',
          await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
          data,
        ),
      )
    const cat = (...parts: Uint8Array[]) => new Uint8Array(parts.flatMap((part) => [...part]))
    const text = (s: string) => new TextEncoder().encode(s)
    const one = new Uint8Array([1])
    const ikm = await hmac(
      await hmac(b64uDecode(RFC.auth), secret),
      cat(text('WebPush: info\0'), ua, asPublic, one),
    )
    const prk = await hmac(salt, ikm)
    const cek = (await hmac(prk, cat(text('Content-Encoding: aes128gcm\0'), one))).slice(0, 16)
    const nonce = (await hmac(prk, cat(text('Content-Encoding: nonce\0'), one))).slice(0, 12)
    const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt'])
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext))
    expect(plain.at(-1)).toBe(2)
    expect(new TextDecoder().decode(plain.slice(0, -1))).toBe('Your turn')
  })
})

describe('RFC 8292 VAPID', () => {
  // The RFC's application server key doubles as a VAPID key pair here.
  const keys = { publicKey: RFC.asPublic, privateKey: RFC.asPrivate, subject: 'mailto:games@example.com' }

  it('signs an ES256 JWT for the push service origin that verifies against the public key', async () => {
    const now = Date.UTC(2026, 9, 19)
    const header = await vapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', keys, now)
    const match = header.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/)
    expect(match).not.toBeNull()
    const [, h, c, sig, k] = match!
    expect(k).toBe(keys.publicKey)
    expect(JSON.parse(new TextDecoder().decode(b64uDecode(h)))).toEqual({ typ: 'JWT', alg: 'ES256' })
    expect(JSON.parse(new TextDecoder().decode(b64uDecode(c)))).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: now / 1000 + 12 * 3600,
      sub: 'mailto:games@example.com',
    })
    const signature = b64uDecode(sig)
    expect(signature.length).toBe(64)
    const verifier = await crypto.subtle.importKey(
      'raw',
      b64uDecode(keys.publicKey),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    )
    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      verifier,
      signature,
      new TextEncoder().encode(`${h}.${c}`),
    )
    expect(ok).toBe(true)
  })

  it('posts an aes128gcm body with VAPID authorization and reports the status', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const status = await sendPush(
      {
        endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/xyz',
        p256dh: RFC.uaPublic,
        auth: RFC.auth,
      },
      {
        title: 'Your turn in Gambit',
        body: 'Ben is waiting for you.',
        path: '/chess/room/ABC234',
        tag: 'turn-ABC234',
      },
      keys,
      async (url, init) => {
        seen.push({ url: String(url), init: init! })
        return new Response(null, { status: 201 })
      },
    )
    expect(status).toBe(201)
    const headers = new Headers(seen[0].init.headers)
    expect(headers.get('Content-Encoding')).toBe('aes128gcm')
    expect(headers.get('TTL')).toBe('3600')
    expect(headers.get('Authorization')).toMatch(/^vapid t=.+, k=/)
    expect((seen[0].init.body as Uint8Array).length).toBeGreaterThan(86)
    // A push service answers; it is never followed anywhere else.
    expect(seen[0].init.redirect).toBe('manual')
  })

  it('treats a redirect as a failure, and never sends to an endpoint off the list', async () => {
    const message = { title: 't', body: 'b', path: '/', tag: 'x' }
    const sub = (endpoint: string) => ({ endpoint, p256dh: RFC.uaPublic, auth: RFC.auth })
    const seen: string[] = []
    const fetcher = (async (url: RequestInfo | URL) => {
      seen.push(String(url))
      return new Response(null, { status: 307, headers: { Location: 'https://elsewhere.example/' } })
    }) as typeof fetch
    expect(await sendPush(sub('https://fcm.googleapis.com/fcm/send/a'), message, keys, fetcher)).toBe(307)
    // Stored under an older, looser rule: refused as it leaves.
    for (const endpoint of ['https://fcm.googleapis.com:8443/fcm/send/a', 'https://evil.example/x'])
      expect(await sendPush(sub(endpoint), message, keys, fetcher)).toBe(0)
    expect(seen).toEqual(['https://fcm.googleapis.com/fcm/send/a'])
  })
})

describe('validSubscription', () => {
  const keys = { p256dh: RFC.uaPublic, auth: RFC.auth }
  it('accepts the major push services', () => {
    for (const endpoint of [
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://updates.push.services.mozilla.com/wpush/v2/abc',
      'https://web.push.apple.com/QGz',
      'https://wns2-par02p.notify.windows.com/w/?token=abc',
    ])
      expect(validSubscription({ endpoint, keys })).toEqual({ endpoint, ...keys })
  })
  it('refuses anywhere else, plain http, and malformed keys', () => {
    expect(validSubscription({ endpoint: 'https://evil.example/hook', keys })).toBeNull()
    expect(validSubscription({ endpoint: 'http://fcm.googleapis.com/fcm/send/abc', keys })).toBeNull()
    expect(validSubscription({ endpoint: 'https://fcm.googleapis.com.evil.example/x', keys })).toBeNull()
    expect(
      validSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys: { ...keys, auth: 'short' } }),
    ).toBeNull()
    expect(
      validSubscription({ endpoint: 'https://fcm.googleapis.com/x', keys: { ...keys, p256dh: RFC.auth } }),
    ).toBeNull()
    expect(validSubscription(null)).toBeNull()
    expect(validSubscription({ endpoint: 42 })).toBeNull()
  })

  it('refuses a push service on any but its default port, or with credentials in the URL', () => {
    for (const endpoint of [
      'https://fcm.googleapis.com:8443/fcm/send/abc',
      'https://fcm.googleapis.com:80/fcm/send/abc',
      'https://user:pass@fcm.googleapis.com/fcm/send/abc',
    ])
      expect(validSubscription({ endpoint, keys })).toBeNull()
    // The default port spelled out is the default port.
    expect(
      validSubscription({ endpoint: 'https://fcm.googleapis.com:443/fcm/send/abc', keys }),
    ).not.toBeNull()
  })
})
