import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'
import { createHash } from 'node:crypto'
import { defineConfig } from 'vite'
import type { Plugin } from 'vite'

/**
 * Clerk's Frontend API host, which a publishable key carries base64-encoded
 * (`pk_live_<base64 of "clerk.example.com$">`). clerk-js is served from there
 * and talks to it, so it is the one Clerk host that differs per instance.
 */
function clerkHost(key: string | undefined): string | null {
  const encoded = key?.match(/^pk_(?:test|live)_(.+)$/)?.[1]
  if (!encoded) return null
  const host = Buffer.from(encoded, 'base64').toString('utf8').replace(/\$$/, '')
  return /^[a-z0-9.-]+$/i.test(host) ? host : null
}

/**
 * A Content-Security-Policy for the built site, as a <meta> because GitHub
 * Pages cannot send headers. Built rather than written out: the game server's
 * origin and Clerk's host are build-time settings, and the one inline script
 * (index.html's flash-free theme) is allowed by its hash, taken from the HTML
 * as built so an edit to it cannot silently fall outside the policy. Not in
 * dev, whose HMR client and React preamble are inline and on another socket.
 *
 * - blob: and data: images: Prism paints its card faces into blobs; Hearth's
 *   paper grain is an inline SVG.
 * - Clerk (only when a key is set): its host for clerk-js and its API,
 *   img.clerk.com for avatars, and Cloudflare's challenge for bot protection
 *   on sign-up, which is a script and a frame. Clerk injects its own <style>
 *   elements, hence 'unsafe-inline' for styles only.
 * - frame-ancestors cannot be set from a <meta>; that one needs a header.
 */
function contentSecurityPolicy(): Plugin {
  let env: Record<string, string> = {}
  return {
    name: 'content-security-policy',
    apply: 'build',
    configResolved(config) {
      env = config.env
    },
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const api = new URL(env.VITE_API_URL || 'http://127.0.0.1:8787')
        const socket = `${api.protocol === 'https:' ? 'wss:' : 'ws:'}//${api.host}`
        const clerk = clerkHost(env.VITE_CLERK_PUBLISHABLE_KEY)
        const challenge = 'https://challenges.cloudflare.com'
        const inline = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(
          ([, body]) => `'sha256-${createHash('sha256').update(body).digest('base64')}'`,
        )
        const policy = {
          'default-src': ["'self'"],
          'script-src': ["'self'", ...inline, ...(clerk ? [`https://${clerk}`, challenge] : [])],
          'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          'font-src': ["'self'", 'https://fonts.gstatic.com'],
          'img-src': ["'self'", 'data:', 'blob:', ...(clerk ? ['https://img.clerk.com'] : [])],
          'connect-src': ["'self'", api.origin, socket, ...(clerk ? [`https://${clerk}`] : [])],
          'worker-src': ["'self'", 'blob:'],
          'frame-src': clerk ? [challenge] : ["'none'"],
          'manifest-src': ["'self'"],
          'object-src': ["'none'"],
          'base-uri': ["'self'"],
          'form-action': ["'self'"],
        }
        const content = Object.entries(policy)
          .map(([directive, sources]) => `${directive} ${sources.join(' ')}`)
          .join('; ')
        // Right after the charset (which has to stay in the first 1024 bytes) and
        // ahead of everything else: a meta policy only governs what follows it.
        return html.replace(
          /<meta charset="UTF-8" \/>/,
          (charset) => `${charset}\n    <meta http-equiv="Content-Security-Policy" content="${content}" />`,
        )
      },
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] }), contentSecurityPolicy()],
  build: {
    // That chunk is ~600 kB on its own, by design; the warning would only ever be about it.
    chunkSizeWarningLimit: 700,
    rolldownOptions: {
      output: {
        codeSplitting: {
          // Three.js is most of what four of the games download, and it changes
          // far less often than they do. In a chunk of its own its hash
          // survives a deploy that only touched a game, so returning players
          // keep it cached instead of fetching it again inside that game's chunk.
          groups: [{ name: 'three', test: /[\\/]node_modules[\\/]three[\\/]/ }],
        },
      },
    },
  },
})
