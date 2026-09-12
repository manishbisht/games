const ALLOWED = ['https://games.manishbisht.me']

export function allowedOrigin(origin: string | null): string | null {
  if (!origin) return null
  if (ALLOWED.includes(origin)) return origin
  try {
    const url = new URL(origin)
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return origin
  } catch {
    return null
  }
  return null
}

export function corsHeaders(origin: string): HeadersInit {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    Vary: 'Origin',
  }
}
