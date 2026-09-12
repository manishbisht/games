# Multiplayer Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cloudflare Workers backend with Durable Object rooms so people can play Gambit (chess) together live, with optional Clerk login and a public lobby.

**Architecture:** npm-workspaces monorepo (`frontend/`, `backend/`, `shared/`). Each room is one Durable Object (`RoomDO`) running the real chess engine from `@games/shared`; clients send intents over WebSocket (hibernation API) and the server broadcasts full authoritative room snapshots. A single `LobbyDO` lists public rooms. Clerk JWTs are verified in the Worker when present; guests use a localStorage UUID.

**Tech Stack:** Cloudflare Workers + Durable Objects (SQLite-backed, WebSocket hibernation, alarms), wrangler v4, `@cloudflare/vitest-pool-workers`, `@clerk/backend`, `@clerk/react`, chess.js, React 19 + Vite, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-12-multiplayer-backend-design.md`

## Global Constraints

- Code style matches the existing repo: no semicolons, single quotes, 2-space indent, Prettier (`.prettierrc.json` moves to the repo root in Task 1; run `npx prettier --write` on files you create).
- TypeScript strict everywhere; `verbatimModuleSyntax` (use `import type` for types).
- Node 24, npm workspaces. The lockfile lives at the repo root after Task 1 (`frontend/package-lock.json` is deleted).
- The frontend MUST keep working with no env vars set: no `VITE_CLERK_PUBLISHABLE_KEY` → guest-only mode; no `VITE_API_URL` → default `http://127.0.0.1:8787`.
- Every existing test keeps passing: `npm test -w frontend`, `npm test -w shared` (after Task 2), `npm run lint -w frontend`, `npm run build -w frontend`.
- Backend vitest is pinned `~3.2.0` (peer requirement of `@cloudflare/vitest-pool-workers`); other workspaces stay on vitest 4.
- Chess seats are chess.js colors `'w' | 'b'`. Player ids are namespaced strings: `clerk:<sub>` or `guest:<uuid>`.
- Commit after every task with a conventional-commit message.

## File Map

```
games/
├─ package.json                  # NEW root: workspaces
├─ .prettierrc.json              # MOVED from frontend/
├─ .github/workflows/deploy.yml  # MODIFIED: root npm ci; api deploy job
├─ shared/                       # NEW workspace @games/shared
│  ├─ package.json  ├─ tsconfig.json  ├─ vitest.config.ts
│  └─ src/
│     ├─ chess/engine.ts         # MOVED from frontend/src/games/chess/game/
│     ├─ chess/types.ts          # MOVED (GameOptions.mode gains 'online')
│     ├─ chess/engine.test.ts    # MOVED
│     └─ protocol/{types.ts, codes.ts, codes.test.ts}
├─ backend/                      # NEW workspace
│  ├─ package.json  ├─ wrangler.jsonc  ├─ tsconfig.json  ├─ vitest.config.ts
│  ├─ .dev.vars.example  ├─ .gitignore
│  ├─ src/{index.ts, env.ts, cors.ts, auth.ts, room.ts, lobby.ts}
│  └─ test/{env.d.ts, helpers.ts, worker.test.ts, auth.test.ts,
│           room.test.ts, room-game.test.ts, expiry.test.ts, lobby.test.ts}
└─ frontend/
   ├─ package.json               # MODIFIED: + @games/shared, @clerk/react
   ├─ playwright.config.ts       # MODIFIED: second webServer (wrangler dev)
   ├─ src/main.tsx               # MODIFIED: AuthProvider wrapper
   ├─ src/App.tsx                # MODIFIED: /chess/room/:code route
   ├─ src/pages/HomePage.tsx     # MODIFIED: <HeaderAuth />
   ├─ src/online/                # NEW game-agnostic online layer
   │  ├─ guest.ts  ├─ guest.test.ts  ├─ api.ts
   │  ├─ roomState.ts  ├─ roomState.test.ts  ├─ useRoom.ts  └─ identity.tsx
   ├─ src/games/chess/
   │  ├─ ChessGame.tsx           # MODIFIED: optional `online` prop
   │  ├─ ChessGame.css           # MODIFIED: online panel/room styles
   │  ├─ ChessRoomPage.tsx       # NEW route target
   │  └─ online/{session.ts, OnlinePanel.tsx}
   └─ tests/chess-online.spec.ts # NEW two-context e2e
```

Spec deviations (deliberate, small): presence is carried by the `room` snapshot's per-seat `connected` flags instead of a separate `presence` message type — same information, one less message shape. WebSocket upgrades to unknown rooms are accepted, sent an error, and closed with code 4404 so the client can distinguish "room not found" from a network blip.

---

### Task 1: Monorepo workspaces

**Files:**
- Create: `package.json` (repo root)
- Create: `shared/package.json`, `shared/tsconfig.json`, `shared/vitest.config.ts`
- Move: `frontend/.prettierrc.json` → `.prettierrc.json`
- Modify: `frontend/package.json` (add `@games/shared` dep)
- Modify: `.github/workflows/deploy.yml` (root install)
- Delete: `frontend/package-lock.json`

**Interfaces:**
- Consumes: nothing.
- Produces: workspace `@games/shared` importable from frontend/backend; root `npm ci`/`npm test` works. Later tasks add files under `shared/src/` and export them via the `exports` map here.

- [ ] **Step 1: Root package.json**

```json
{
  "name": "games",
  "private": true,
  "workspaces": ["frontend", "shared"],
  "scripts": {
    "dev": "npm run dev -w frontend",
    "build": "npm run build -w frontend",
    "lint": "npm run lint -w frontend",
    "test": "npm run test -ws --if-present"
  }
}
```

(`backend` joins the workspaces array in Task 4.)

- [ ] **Step 2: shared package**

`shared/package.json`:

```json
{
  "name": "@games/shared",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "exports": {
    "./chess": "./src/chess/engine.ts",
    "./chess/types": "./src/chess/types.ts",
    "./protocol": "./src/protocol/types.ts",
    "./protocol/codes": "./src/protocol/codes.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": { "chess.js": "^1.4.0" },
  "devDependencies": { "typescript": "~6.0.2", "vitest": "^4.1.11" }
}
```

The exports map points at TypeScript source — Vite, wrangler (esbuild), and vitest all compile it; there is no build step for `shared`.

`shared/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2023",
    "lib": ["ES2023"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "moduleDetection": "force",
    "verbatimModuleSyntax": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "skipLibCheck": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

`shared/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({ test: { include: ['src/**/*.test.ts'] } })
```

- [ ] **Step 3: Move prettier config, wire frontend dep**

```bash
git mv frontend/.prettierrc.json .prettierrc.json
```

In `frontend/package.json` add to `"dependencies"`: `"@games/shared": "*"`.

- [ ] **Step 4: Regenerate lockfile at root**

```bash
rm frontend/package-lock.json
npm install
```

Verify `package-lock.json` exists at root and `node_modules/@games/shared` is a symlink to `shared`.

- [ ] **Step 5: Update the Pages workflow for workspaces**

In `.github/workflows/deploy.yml`, `build` job: remove `defaults.run.working-directory: frontend`; set `cache-dependency-path: package-lock.json`; change steps to run from the root:

```yaml
      - name: Install dependencies
        run: npm ci

      - name: Lint
        run: npm run lint -w frontend

      - name: Run unit tests
        run: npm run test -w shared --if-present && npm run test -w frontend

      - name: Build for GitHub Pages
        env:
          PAGES_BASE_PATH: ${{ steps.pages.outputs.base_path }}
        run: npm run build -w frontend -- --base "${PAGES_BASE_PATH}/"
```

(The upload step's `path: frontend/dist` already resolves from the root — keep it.)

- [ ] **Step 6: Verify everything still works**

Run: `npm run lint -w frontend && npm run test -w frontend && npm run build -w frontend`
Expected: all pass, build succeeds.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: restructure into npm workspaces with shared package"
```

---

### Task 2: Move the chess engine into shared

**Files:**
- Move: `frontend/src/games/chess/game/engine.ts` → `shared/src/chess/engine.ts`
- Move: `frontend/src/games/chess/game/types.ts` → `shared/src/chess/types.ts`
- Move: `frontend/src/games/chess/game/engine.test.ts` → `shared/src/chess/engine.test.ts`
- Modify: importers — `frontend/src/games/chess/{ChessGame.tsx, scene/createScene.ts, scene/ChessBoard.tsx, scene/models.ts, components/PromotionGallery.tsx, game/ai.ts, game/ai.worker.ts, game/ai.test.ts}`, `frontend/tests/chess.spec.ts`

**Interfaces:**
- Consumes: Task 1's `@games/shared` exports map.
- Produces: `import { createGame, playMove, legalMoves, resign, opposite, DEFAULT_OPTIONS } from '@games/shared/chess'` and `import type { GameState, GameOptions, Color, Square, PromotionPiece } from '@games/shared/chess/types'` available to frontend AND backend. Engine function signatures are unchanged (`createGame(options?, fen?, now?)`, `playMove(game, from, to, promotion?, now?)`, `resign(game, now?, color?)`).

- [ ] **Step 1: Move the three files**

```bash
mkdir -p shared/src/chess
git mv frontend/src/games/chess/game/engine.ts shared/src/chess/engine.ts
git mv frontend/src/games/chess/game/types.ts shared/src/chess/types.ts
git mv frontend/src/games/chess/game/engine.test.ts shared/src/chess/engine.test.ts
```

`engine.ts` imports `./types` and `engine.test.ts` imports `./engine` relatively — those keep working as-is.

- [ ] **Step 2: Update frontend imports**

In the files listed above, replace import sources only (named imports stay identical):
- `'./game/engine'` → `'@games/shared/chess'` (ChessGame.tsx)
- `'./game/types'` → `'@games/shared/chess/types'` (ChessGame.tsx)
- `'../game/engine'` → `'@games/shared/chess'`, `'../game/types'` → `'@games/shared/chess/types'` (scene/*, components/PromotionGallery.tsx)
- `'./engine'` → `'@games/shared/chess'`, `'./types'` → `'@games/shared/chess/types'` (game/ai.ts, game/ai.worker.ts, game/ai.test.ts)
- In `frontend/tests/chess.spec.ts`: `'../src/games/chess/game/engine'` → `'../../shared/src/chess/engine'` (relative path — Playwright's transformer doesn't reliably follow package `exports` into TS source).

Run `grep -rn "game/engine\|game/types" frontend/src frontend/tests` afterwards — it must only match `monopoly`/`prism`/`hearth` paths (their own `game/` dirs), never chess.

- [ ] **Step 3: Run the moved engine tests**

Run: `npm test -w shared`
Expected: PASS (the engine test suite now runs in the shared workspace).

- [ ] **Step 4: Verify frontend**

Run: `npm run lint -w frontend && npm run test -w frontend && npm run build -w frontend && npx tsc --noEmit -p shared`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: move chess engine and types into @games/shared"
```

---

### Task 3: Protocol types and room codes in shared

**Files:**
- Create: `shared/src/protocol/types.ts`, `shared/src/protocol/codes.ts`
- Test: `shared/src/protocol/codes.test.ts`
- Modify: `shared/src/chess/types.ts` (widen `GameOptions.mode`)

**Interfaces:**
- Consumes: `GameState` from Task 2.
- Produces: every type below, used verbatim by backend (Tasks 5–10) and frontend (Tasks 11–14). `generateRoomCode(random?)`, `normalizeRoomCode(input): string | null`.

- [ ] **Step 1: Widen GameOptions for online play**

In `shared/src/chess/types.ts` change:

```ts
export interface GameOptions {
  mode: 'local' | 'ai' | 'online'
  human: Color
  difficulty: Difficulty
  clock: 0 | 10
}
```

No frontend behavior changes: `restoreGame` already rejects any stored mode other than `local`/`ai`, and online games are never written to localStorage.

- [ ] **Step 2: Write failing codes test**

`shared/src/protocol/codes.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { generateRoomCode, normalizeRoomCode, ROOM_CODE_ALPHABET } from './codes'

describe('room codes', () => {
  it('generates 6 chars from the unambiguous alphabet', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateRoomCode()
      expect(code).toHaveLength(6)
      for (const ch of code) expect(ROOM_CODE_ALPHABET).toContain(ch)
    }
  })
  it('is deterministic given a random source', () => {
    expect(generateRoomCode(() => 0)).toBe('AAAAAA')
  })
  it('normalizes case and whitespace', () => {
    expect(normalizeRoomCode('  kx3f9m ')).toBe('KX3F9M')
  })
  it('rejects wrong length and ambiguous characters', () => {
    expect(normalizeRoomCode('KX3F9')).toBeNull()
    expect(normalizeRoomCode('KX3F90')).toBeNull()
    expect(normalizeRoomCode('KX3FO1')).toBeNull()
    expect(normalizeRoomCode('')).toBeNull()
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm test -w shared`
Expected: FAIL — cannot resolve `./codes`.

- [ ] **Step 4: Implement codes.ts**

```ts
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
export const ROOM_CODE_LENGTH = 6

export function generateRoomCode(random: () => number = Math.random): string {
  let code = ''
  for (let i = 0; i < ROOM_CODE_LENGTH; i++)
    code += ROOM_CODE_ALPHABET[Math.floor(random() * ROOM_CODE_ALPHABET.length)]
  return code
}

/** Uppercases and trims; returns null unless the result is exactly six alphabet characters. */
export function normalizeRoomCode(input: string): string | null {
  const code = input.trim().toUpperCase()
  if (code.length !== ROOM_CODE_LENGTH) return null
  for (const ch of code) if (!ROOM_CODE_ALPHABET.includes(ch)) return null
  return code
}
```

- [ ] **Step 5: Implement protocol types**

`shared/src/protocol/types.ts` (types only — no test file needed):

```ts
import type { GameState } from '../chess/types'

export const PROTOCOL_VERSION = 1

export type GameId = 'chess'
export type RoomVisibility = 'private' | 'public'
export type RoomStatus = 'open' | 'playing' | 'finished'
export type ChessSeat = 'w' | 'b'

export interface PlayerInfo {
  id: string
  name: string
  avatar?: string
  isGuest: boolean
}

export interface SeatInfo {
  player: PlayerInfo
  connected: boolean
  wantsRematch: boolean
}

export interface RoomSnapshot {
  protocol: typeof PROTOCOL_VERSION
  code: string
  game: GameId
  visibility: RoomVisibility
  status: RoomStatus
  hostId: string
  seats: Partial<Record<ChessSeat, SeatInfo>>
  gameState: GameState | null
}

export interface YouInfo {
  id: string
  seat: ChessSeat | null
}

export type ChessAction =
  | { kind: 'move'; from: string; to: string; promotion?: 'q' | 'r' | 'b' | 'n' }
  | { kind: 'resign' }

export interface JoinCredentials {
  name: string
  guestId?: string
  clerkToken?: string
  avatar?: string
}

export type ClientMessage =
  | ({ type: 'join'; protocol: number } & JoinCredentials)
  | { type: 'sit'; seat: ChessSeat }
  | { type: 'start' }
  | { type: 'action'; action: ChessAction }
  | { type: 'rematch' }

export type ErrorCode =
  | 'BAD_MESSAGE'
  | 'BAD_TOKEN'
  | 'PROTOCOL_MISMATCH'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'NOT_JOINED'
  | 'NOT_SEATED'
  | 'SEAT_TAKEN'
  | 'NOT_HOST'
  | 'NOT_READY'
  | 'ALREADY_STARTED'
  | 'NOT_PLAYING'
  | 'NOT_YOUR_TURN'
  | 'ILLEGAL_MOVE'
  | 'PROMOTION_REQUIRED'
  | 'NOT_FINISHED'

export type ServerMessage =
  | { type: 'room'; snapshot: RoomSnapshot; you: YouInfo }
  | { type: 'error'; code: ErrorCode; message: string }

/** WebSocket close codes the server uses for terminal conditions. */
export const CLOSE_CODES = { notFound: 4404, full: 4403, expired: 4408 } as const

export interface PublicRoomSummary {
  code: string
  game: GameId
  hostName: string
  seatsTaken: number
  seatsTotal: number
  createdAt: number
}
```

- [ ] **Step 6: Run tests and typecheck**

Run: `npm test -w shared && npx tsc --noEmit -p shared && npm run test -w frontend`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add multiplayer wire protocol and room codes to shared"
```

---

### Task 4: Backend scaffold (Worker, wrangler, CORS, vitest)

**Files:**
- Create: `backend/package.json`, `backend/wrangler.jsonc`, `backend/tsconfig.json`, `backend/vitest.config.ts`, `backend/.gitignore`, `backend/.dev.vars.example`
- Create: `backend/src/env.ts`, `backend/src/cors.ts`, `backend/src/index.ts`, `backend/src/room.ts` (stub), `backend/src/lobby.ts` (stub)
- Test: `backend/test/env.d.ts`, `backend/test/worker.test.ts`
- Modify: root `package.json` (add `"backend"` to workspaces)

**Interfaces:**
- Consumes: nothing from shared yet.
- Produces: `Env` interface (`ROOM: DurableObjectNamespace<RoomDO>`, `LOBBY: DurableObjectNamespace<LobbyDO>`, `CLERK_SECRET_KEY?: string`); `allowedOrigin(origin: string | null): string | null` and `corsHeaders(origin: string): HeadersInit` from `cors.ts`; Worker routes `GET /health`, `OPTIONS *`. Tasks 5–10 fill in `room.ts`/`lobby.ts`/routes.

- [ ] **Step 1: Package and configs**

`backend/package.json`:

```json
{
  "name": "backend",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "dev": "wrangler dev --port 8787",
    "deploy": "wrangler deploy",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@clerk/backend": "^2.29.0",
    "@games/shared": "*"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.9.13",
    "@cloudflare/workers-types": "^4.20260901.0",
    "typescript": "~6.0.2",
    "vitest": "~3.2.0",
    "wrangler": "^4.42.0"
  }
}
```

(If npm reports newer versions, take the latest — but keep vitest on whatever major/minor `@cloudflare/vitest-pool-workers` declares as its peer.)

`backend/wrangler.jsonc`:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "games-api",
  "main": "src/index.ts",
  "compatibility_date": "2026-09-01",
  "durable_objects": {
    "bindings": [
      { "name": "ROOM", "class_name": "RoomDO" },
      { "name": "LOBBY", "class_name": "LobbyDO" }
    ]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["RoomDO", "LobbyDO"] }],
  "observability": { "enabled": true }
}
```

`backend/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2023",
    "lib": ["ES2023"],
    "module": "esnext",
    "moduleResolution": "bundler",
    "moduleDetection": "force",
    "verbatimModuleSyntax": true,
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"]
  },
  "include": ["src", "test"]
}
```

`backend/vitest.config.ts`:

```ts
import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

export default defineWorkersConfig({
  test: {
    poolOptions: { workers: { wrangler: { configPath: './wrangler.jsonc' } } },
  },
})
```

`backend/.gitignore`:

```
.wrangler/
.dev.vars
```

`backend/.dev.vars.example` (copy to `.dev.vars` locally to test real Clerk tokens):

```
CLERK_SECRET_KEY=
```

`backend/test/env.d.ts`:

```ts
import type { Env } from '../src/env'

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}
```

Root `package.json`: `"workspaces": ["frontend", "backend", "shared"]`, then run `npm install`.

- [ ] **Step 2: Env and stub DOs**

`backend/src/env.ts`:

```ts
import type { RoomDO } from './room'
import type { LobbyDO } from './lobby'

export interface Env {
  ROOM: DurableObjectNamespace<RoomDO>
  LOBBY: DurableObjectNamespace<LobbyDO>
  CLERK_SECRET_KEY?: string
}
```

`backend/src/room.ts` (stub, replaced in Task 6):

```ts
import { DurableObject } from 'cloudflare:workers'
import type { Env } from './env'

export class RoomDO extends DurableObject<Env> {}
```

`backend/src/lobby.ts` (stub, replaced in Task 10):

```ts
import { DurableObject } from 'cloudflare:workers'
import type { Env } from './env'

export class LobbyDO extends DurableObject<Env> {}
```

- [ ] **Step 3: Write failing worker tests**

`backend/test/worker.test.ts`:

```ts
import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

describe('worker routing', () => {
  it('serves health', async () => {
    const res = await SELF.fetch('https://api.test/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('answers CORS preflight for an allowed origin', async () => {
    const res = await SELF.fetch('https://api.test/api/rooms', {
      method: 'OPTIONS',
      headers: { Origin: 'https://games.manishbisht.me' },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://games.manishbisht.me')
  })

  it('rejects preflight from unknown origins', async () => {
    const res = await SELF.fetch('https://api.test/api/rooms', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example' },
    })
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull()
  })

  it('404s unknown routes', async () => {
    const res = await SELF.fetch('https://api.test/nope')
    expect(res.status).toBe(404)
  })
})
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npm test -w backend`
Expected: FAIL (no `src/index.ts` yet).

- [ ] **Step 5: Implement cors.ts and index.ts**

`backend/src/cors.ts`:

```ts
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
```

`backend/src/index.ts`:

```ts
import type { Env } from './env'
import { allowedOrigin, corsHeaders } from './cors'

export { RoomDO } from './room'
export { LobbyDO } from './lobby'

function json(data: unknown, status: number, origin: string | null): Response {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (origin) for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v as string)
  return new Response(JSON.stringify(data), { status, headers })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    const origin = allowedOrigin(request.headers.get('Origin'))

    if (request.method === 'OPTIONS')
      return new Response(null, { status: 204, headers: origin ? corsHeaders(origin) : {} })
    if (url.pathname === '/health') return json({ ok: true }, 200, origin)

    return json({ error: 'not found' }, 404, origin)
  },
} satisfies ExportedHandler<Env>
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -w backend && npm run typecheck -w backend`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: scaffold Cloudflare Workers backend with CORS and vitest"
```

---

### Task 5: Identity resolution (guests + Clerk verify)

**Files:**
- Create: `backend/src/auth.ts`
- Test: `backend/test/auth.test.ts`

**Interfaces:**
- Consumes: `PlayerInfo` from `@games/shared/protocol`; `Env` from Task 4.
- Produces: `cleanName(value: unknown): string | null`; `resolveIdentity(cred: Credentials, env: Env, verify?): Promise<PlayerInfo | null>` where `Credentials = { name?: unknown; guestId?: unknown; clerkToken?: unknown; avatar?: unknown }`. The optional `verify` parameter is dependency injection for tests; production callers omit it.

- [ ] **Step 1: Write failing tests**

`backend/test/auth.test.ts`:

```ts
import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { cleanName, resolveIdentity } from '../src/auth'

const GUEST = '01234567-89ab-4cde-8f01-23456789abcd'

describe('cleanName', () => {
  it('trims, collapses whitespace, caps at 24 chars', () => {
    expect(cleanName('  Ada   Lovelace  ')).toBe('Ada Lovelace')
    expect(cleanName('x'.repeat(40))).toBe('x'.repeat(24))
  })
  it('rejects empty and non-strings', () => {
    expect(cleanName('   ')).toBeNull()
    expect(cleanName(42)).toBeNull()
    expect(cleanName(undefined)).toBeNull()
  })
})

describe('resolveIdentity', () => {
  it('accepts a guest with a UUID and namespaces the id', async () => {
    const player = await resolveIdentity({ name: 'Ann', guestId: GUEST.toUpperCase() }, env)
    expect(player).toEqual({ id: `guest:${GUEST}`, name: 'Ann', isGuest: true })
  })
  it('rejects malformed guest ids and missing names', async () => {
    expect(await resolveIdentity({ name: 'Ann', guestId: 'nope' }, env)).toBeNull()
    expect(await resolveIdentity({ name: '  ', guestId: GUEST }, env)).toBeNull()
  })
  it('verifies Clerk tokens and keeps only Clerk-hosted avatars', async () => {
    const verify = async () => ({ sub: 'user_123' })
    const withEnv = { ...env, CLERK_SECRET_KEY: 'sk_test' }
    expect(
      await resolveIdentity(
        { name: 'Ann', clerkToken: 'jwt', avatar: 'https://img.clerk.com/abc' },
        withEnv,
        verify,
      ),
    ).toEqual({ id: 'clerk:user_123', name: 'Ann', avatar: 'https://img.clerk.com/abc', isGuest: false })
    expect(
      await resolveIdentity({ name: 'Ann', clerkToken: 'jwt', avatar: 'https://evil.example/x' }, withEnv, verify),
    ).toEqual({ id: 'clerk:user_123', name: 'Ann', isGuest: false })
  })
  it('rejects Clerk tokens when verification fails or no secret is configured', async () => {
    const boom = async () => {
      throw new Error('bad token')
    }
    const withEnv = { ...env, CLERK_SECRET_KEY: 'sk_test' }
    expect(await resolveIdentity({ name: 'Ann', clerkToken: 'jwt' }, withEnv, boom)).toBeNull()
    expect(
      await resolveIdentity({ name: 'Ann', clerkToken: 'jwt' }, { ...env, CLERK_SECRET_KEY: undefined }),
    ).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w backend`
Expected: FAIL — `../src/auth` does not exist.

- [ ] **Step 3: Implement auth.ts**

```ts
import { verifyToken } from '@clerk/backend'
import type { PlayerInfo } from '@games/shared/protocol'
import type { Env } from './env'

export interface Credentials {
  name?: unknown
  guestId?: unknown
  clerkToken?: unknown
  avatar?: unknown
}

type Verifier = (token: string, options: { secretKey: string }) => Promise<{ sub: string }>

const GUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CLERK_AVATAR_HOST = 'https://img.clerk.com/'

export function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const name = value.replace(/\s+/g, ' ').trim().slice(0, 24).trim()
  return name.length ? name : null
}

/**
 * The verified Clerk `sub` (or the guest UUID) is the trusted identity; the
 * display name is cosmetic and always taken from the client. Avatars are only
 * accepted from Clerk's image host so clients cannot inject arbitrary URLs.
 */
export async function resolveIdentity(
  cred: Credentials,
  env: Env,
  verify: Verifier = verifyToken as unknown as Verifier,
): Promise<PlayerInfo | null> {
  const name = cleanName(cred.name)
  if (!name) return null
  if (typeof cred.clerkToken === 'string' && cred.clerkToken) {
    if (!env.CLERK_SECRET_KEY) return null
    try {
      const payload = await verify(cred.clerkToken, { secretKey: env.CLERK_SECRET_KEY })
      if (!payload.sub) return null
      const avatar =
        typeof cred.avatar === 'string' && cred.avatar.startsWith(CLERK_AVATAR_HOST)
          ? cred.avatar
          : undefined
      return { id: `clerk:${payload.sub}`, name, ...(avatar ? { avatar } : {}), isGuest: false }
    } catch {
      return null
    }
  }
  if (typeof cred.guestId === 'string' && GUEST_ID.test(cred.guestId))
    return { id: `guest:${cred.guestId.toLowerCase()}`, name, isGuest: true }
  return null
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w backend && npm run typecheck -w backend`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: resolve guest and Clerk identities in the worker"
```

---

### Task 6: RoomDO — create, WebSocket join/sit/start, snapshots, reconnect

**Files:**
- Modify: `backend/src/room.ts` (replace stub), `backend/src/index.ts` (room routes)
- Test: `backend/test/helpers.ts`, `backend/test/room.test.ts`

**Interfaces:**
- Consumes: `resolveIdentity`/`cleanName` (Task 5); protocol types and `generateRoomCode`/`normalizeRoomCode` (Task 3); `createGame` from `@games/shared/chess`.
- Produces: `RoomDO` RPC `create(input: { code: string; game: GameId; visibility: RoomVisibility; host: PlayerInfo }): Promise<boolean>` (false if the code is already used); `fetch()` upgrades WebSockets. Exported `RoomRecord` type. Private helpers Task 7 extends: `load(): Promise<RoomRecord | null>`, `save(record): Promise<void>`, `fail(ws, code, message)`, `seatOf(record, playerId): ChessSeat | null`, `broadcast(record)`. Worker routes `POST /api/rooms` → `{ code }` and `GET /api/rooms/:code` (WS upgrade). Test helper module `connect(code): Promise<Client>` / `createRoom(visibility?, name?, guestId?)`.

- [ ] **Step 1: Test helpers**

`backend/test/helpers.ts`:

```ts
import { SELF } from 'cloudflare:test'
import { expect, vi } from 'vitest'
import type { ServerMessage } from '@games/shared/protocol'

type RoomMessage = Extract<ServerMessage, { type: 'room' }>

export async function createRoom(visibility: 'private' | 'public' = 'private', name = 'Host', guestId = crypto.randomUUID()) {
  const res = await SELF.fetch('https://api.test/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ game: 'chess', visibility, name, guestId }),
  })
  expect(res.status).toBe(201)
  const { code } = await res.json<{ code: string }>()
  return { code, guestId }
}

export interface Client {
  ws: WebSocket
  messages: ServerMessage[]
  closes: { code: number }[]
  send: (message: unknown) => void
  join: (name: string, guestId?: string) => string
  waitRoom: (predicate: (room: RoomMessage) => boolean) => Promise<RoomMessage>
  expectError: (code: string) => Promise<void>
}

export async function connect(code: string): Promise<Client> {
  const res = await SELF.fetch(`https://api.test/api/rooms/${code}`, {
    headers: { Upgrade: 'websocket' },
  })
  expect(res.status).toBe(101)
  const ws = res.webSocket!
  ws.accept()
  const messages: ServerMessage[] = []
  const closes: { code: number }[] = []
  ws.addEventListener('message', (event) => messages.push(JSON.parse(event.data as string)))
  ws.addEventListener('close', (event) => closes.push({ code: event.code }))
  const client: Client = {
    ws,
    messages,
    closes,
    send: (message) => ws.send(JSON.stringify(message)),
    join: (name, guestId = crypto.randomUUID()) => {
      client.send({ type: 'join', protocol: 1, name, guestId })
      return guestId
    },
    waitRoom: (predicate) =>
      vi.waitFor(() => {
        const room = messages.filter((m): m is RoomMessage => m.type === 'room').findLast(predicate)
        expect(room).toBeDefined()
        return room!
      }),
    expectError: (code) =>
      vi.waitFor(() => {
        expect(messages.some((m) => m.type === 'error' && m.code === code)).toBe(true)
      }),
  }
  return client
}
```

- [ ] **Step 2: Write failing room tests**

`backend/test/room.test.ts`:

```ts
import { SELF } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import { ROOM_CODE_ALPHABET } from '@games/shared/protocol/codes'
import { connect, createRoom } from './helpers'

describe('room creation', () => {
  it('creates a room and returns a six-char code', async () => {
    const { code } = await createRoom()
    expect(code).toHaveLength(6)
    for (const ch of code) expect(ROOM_CODE_ALPHABET).toContain(ch)
  })
  it('rejects creation without a valid identity', async () => {
    const res = await SELF.fetch('https://api.test/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ game: 'chess', visibility: 'private', name: '' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('joining and seats', () => {
  it('closes unknown rooms with 4404', async () => {
    const client = await connect('KX3F9M')
    await client.expectError('ROOM_NOT_FOUND')
    await vi.waitFor(() => expect(client.closes[0]?.code).toBe(4404))
  })

  it('joins, sits, and receives authoritative snapshots', async () => {
    const { code, guestId } = await createRoom()
    const host = await connect(code)
    host.join('Ann', guestId)
    const open = await host.waitRoom((m) => m.snapshot.status === 'open')
    expect(open.you.id).toBe(`guest:${guestId}`)
    expect(open.you.seat).toBeNull()

    host.send({ type: 'sit', seat: 'w' })
    const seated = await host.waitRoom((m) => m.you.seat === 'w')
    expect(seated.snapshot.seats.w?.player.name).toBe('Ann')
    expect(seated.snapshot.seats.w?.connected).toBe(true)
  })

  it('rejects sitting on a taken seat and non-host starts', async () => {
    const { code, guestId } = await createRoom()
    const host = await connect(code)
    host.join('Ann', guestId)
    host.send({ type: 'sit', seat: 'w' })
    await host.waitRoom((m) => m.you.seat === 'w')

    const guest = await connect(code)
    guest.join('Ben')
    guest.send({ type: 'sit', seat: 'w' })
    await guest.expectError('SEAT_TAKEN')
    guest.send({ type: 'sit', seat: 'b' })
    await guest.waitRoom((m) => m.you.seat === 'b')
    guest.send({ type: 'start' })
    await guest.expectError('NOT_HOST')
  })

  it('host starts once both seats are taken; game state is authoritative', async () => {
    const { code, guestId } = await createRoom()
    const host = await connect(code)
    host.join('Ann', guestId)
    host.send({ type: 'sit', seat: 'w' })
    host.send({ type: 'start' })
    await host.expectError('NOT_READY')

    const guest = await connect(code)
    guest.join('Ben')
    guest.send({ type: 'sit', seat: 'b' })
    await host.waitRoom((m) => Boolean(m.snapshot.seats.b))
    host.send({ type: 'start' })
    const playing = await guest.waitRoom((m) => m.snapshot.status === 'playing')
    expect(playing.snapshot.gameState?.turn).toBe('w')
    expect(playing.snapshot.gameState?.options.mode).toBe('online')
  })

  it('turns away a third player and reclaims seats on reconnect', async () => {
    const { code, guestId } = await createRoom()
    const host = await connect(code)
    host.join('Ann', guestId)
    host.send({ type: 'sit', seat: 'w' })
    const guest = await connect(code)
    const benId = guest.join('Ben')
    guest.send({ type: 'sit', seat: 'b' })
    await host.waitRoom((m) => Boolean(m.snapshot.seats.b))

    const third = await connect(code)
    third.join('Eve')
    await third.expectError('ROOM_FULL')
    await vi.waitFor(() => expect(third.closes[0]?.code).toBe(4403))

    guest.ws.close()
    await host.waitRoom((m) => m.snapshot.seats.b?.connected === false)
    const back = await connect(code)
    back.join('Ben', benId)
    const reclaimed = await back.waitRoom((m) => m.you.seat === 'b')
    expect(reclaimed.snapshot.seats.b?.connected).toBe(true)
  })

  it('requires join before anything else and a valid name on join', async () => {
    const { code } = await createRoom()
    const client = await connect(code)
    client.send({ type: 'sit', seat: 'w' })
    await client.expectError('NOT_JOINED')
    client.send({ type: 'join', protocol: 1, name: '   ', guestId: crypto.randomUUID() })
    await client.expectError('BAD_MESSAGE')
    client.send({ type: 'join', protocol: 99, name: 'Ann', guestId: crypto.randomUUID() })
    await client.expectError('PROTOCOL_MISMATCH')
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -w backend`
Expected: FAIL — `RoomDO.create` and routes don't exist.

- [ ] **Step 4: Implement RoomDO**

Replace `backend/src/room.ts`:

```ts
import { DurableObject } from 'cloudflare:workers'
import { createGame } from '@games/shared/chess'
import type { GameState } from '@games/shared/chess/types'
import { CLOSE_CODES, PROTOCOL_VERSION } from '@games/shared/protocol'
import type {
  ChessSeat,
  ClientMessage,
  ErrorCode,
  GameId,
  PlayerInfo,
  RoomSnapshot,
  RoomStatus,
  RoomVisibility,
  SeatInfo,
  ServerMessage,
} from '@games/shared/protocol'
import { cleanName, resolveIdentity } from './auth'
import type { Env } from './env'

const ROOM_TTL_MS = 24 * 60 * 60 * 1000
const SEATS: readonly ChessSeat[] = ['w', 'b']

interface StoredSeat {
  player: PlayerInfo
  wantsRematch: boolean
}

export interface RoomRecord {
  code: string
  game: GameId
  visibility: RoomVisibility
  status: RoomStatus
  hostId: string
  hostName: string
  createdAt: number
  seats: Partial<Record<ChessSeat, StoredSeat>>
  gameState: GameState | null
}

interface Attachment {
  player: PlayerInfo
}

export class RoomDO extends DurableObject<Env> {
  private cached: RoomRecord | null | undefined

  private async load(): Promise<RoomRecord | null> {
    if (this.cached === undefined)
      this.cached = (await this.ctx.storage.get<RoomRecord>('room')) ?? null
    return this.cached
  }

  private async save(record: RoomRecord): Promise<void> {
    this.cached = record
    await this.ctx.storage.put('room', record)
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS)
  }

  async create(input: {
    code: string
    game: GameId
    visibility: RoomVisibility
    host: PlayerInfo
  }): Promise<boolean> {
    if (await this.load()) return false
    await this.save({
      code: input.code,
      game: input.game,
      visibility: input.visibility,
      status: 'open',
      hostId: input.host.id,
      hostName: input.host.name,
      createdAt: Date.now(),
      seats: {},
      gameState: null,
    })
    return true
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket')
      return new Response('expected websocket', { status: 426 })
    const pair = new WebSocketPair()
    this.ctx.acceptWebSocket(pair[1])
    if (!(await this.load())) {
      this.fail(pair[1], 'ROOM_NOT_FOUND', 'This room does not exist or has expired.')
      pair[1].close(CLOSE_CODES.notFound, 'ROOM_NOT_FOUND')
    }
    return new Response(null, { status: 101, webSocket: pair[0] })
  }

  private fail(ws: WebSocket, code: ErrorCode, message: string): void {
    const error: ServerMessage = { type: 'error', code, message }
    ws.send(JSON.stringify(error))
  }

  private connectedIds(): Set<string> {
    const ids = new Set<string>()
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null
      if (attachment) ids.add(attachment.player.id)
    }
    return ids
  }

  private seatOf(record: RoomRecord, playerId: string): ChessSeat | null {
    for (const seat of SEATS) if (record.seats[seat]?.player.id === playerId) return seat
    return null
  }

  private snapshot(record: RoomRecord): RoomSnapshot {
    const connected = this.connectedIds()
    const seats: Partial<Record<ChessSeat, SeatInfo>> = {}
    for (const seat of SEATS) {
      const stored = record.seats[seat]
      if (stored) seats[seat] = { ...stored, connected: connected.has(stored.player.id) }
    }
    return {
      protocol: PROTOCOL_VERSION,
      code: record.code,
      game: record.game,
      visibility: record.visibility,
      status: record.status,
      hostId: record.hostId,
      seats,
      gameState: record.gameState,
    }
  }

  private roomMessage(record: RoomRecord, playerId: string): ServerMessage {
    return {
      type: 'room',
      snapshot: this.snapshot(record),
      you: { id: playerId, seat: this.seatOf(record, playerId) },
    }
  }

  private broadcast(record: RoomRecord): void {
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Attachment | null
      if (attachment) ws.send(JSON.stringify(this.roomMessage(record, attachment.player.id)))
    }
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    const record = await this.load()
    if (!record) {
      this.fail(ws, 'ROOM_NOT_FOUND', 'This room does not exist or has expired.')
      ws.close(CLOSE_CODES.notFound, 'ROOM_NOT_FOUND')
      return
    }
    let message: ClientMessage
    try {
      message = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw))
    } catch {
      return this.fail(ws, 'BAD_MESSAGE', 'Messages must be JSON.')
    }
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS)
    if (message.type === 'join') return this.handleJoin(ws, record, message)
    const attachment = ws.deserializeAttachment() as Attachment | null
    if (!attachment) return this.fail(ws, 'NOT_JOINED', 'Send a join message first.')
    switch (message.type) {
      case 'sit':
        return this.handleSit(ws, record, attachment.player, message.seat)
      case 'start':
        return this.handleStart(ws, record, attachment.player)
      default:
        return this.fail(ws, 'BAD_MESSAGE', 'Unknown message type.')
    }
  }

  private async handleJoin(
    ws: WebSocket,
    record: RoomRecord,
    message: Extract<ClientMessage, { type: 'join' }>,
  ): Promise<void> {
    if (message.protocol !== PROTOCOL_VERSION)
      return this.fail(ws, 'PROTOCOL_MISMATCH', 'Please refresh to get the latest version.')
    if (!cleanName(message.name)) return this.fail(ws, 'BAD_MESSAGE', 'A display name is required.')
    const player = await resolveIdentity(message, this.env)
    if (!player) return this.fail(ws, 'BAD_TOKEN', 'Could not verify your identity.')
    const seat = this.seatOf(record, player.id)
    const taken = SEATS.filter((s) => record.seats[s]).length
    if (!seat && taken >= SEATS.length) {
      this.fail(ws, 'ROOM_FULL', 'This room already has two players.')
      ws.close(CLOSE_CODES.full, 'ROOM_FULL')
      return
    }
    ws.serializeAttachment({ player } satisfies Attachment)
    if (seat) {
      record.seats[seat] = { ...record.seats[seat]!, player }
      await this.save(record)
    }
    this.broadcast(record)
  }

  private async handleSit(
    ws: WebSocket,
    record: RoomRecord,
    player: PlayerInfo,
    seat: ChessSeat,
  ): Promise<void> {
    if (!SEATS.includes(seat)) return this.fail(ws, 'BAD_MESSAGE', 'Unknown seat.')
    if (record.status !== 'open')
      return this.fail(ws, 'ALREADY_STARTED', 'The game has already started.')
    const occupant = record.seats[seat]
    if (occupant && occupant.player.id !== player.id)
      return this.fail(ws, 'SEAT_TAKEN', 'That seat is taken.')
    const previous = this.seatOf(record, player.id)
    if (previous && previous !== seat) delete record.seats[previous]
    record.seats[seat] = { player, wantsRematch: false }
    await this.save(record)
    this.broadcast(record)
  }

  private async handleStart(ws: WebSocket, record: RoomRecord, player: PlayerInfo): Promise<void> {
    if (record.status !== 'open')
      return this.fail(ws, 'ALREADY_STARTED', 'The game has already started.')
    if (player.id !== record.hostId)
      return this.fail(ws, 'NOT_HOST', 'Only the room creator can start the game.')
    if (!record.seats.w || !record.seats.b)
      return this.fail(ws, 'NOT_READY', 'Both seats must be taken first.')
    record.status = 'playing'
    record.gameState = createGame({ mode: 'online', human: 'w', difficulty: 'medium', clock: 0 })
    await this.save(record)
    this.broadcast(record)
  }

  async webSocketClose(): Promise<void> {
    const record = await this.load()
    if (record) this.broadcast(record)
  }

  async webSocketError(): Promise<void> {
    const record = await this.load()
    if (record) this.broadcast(record)
  }
}
```

- [ ] **Step 5: Add room routes to index.ts**

In `backend/src/index.ts`, add imports:

```ts
import { generateRoomCode, normalizeRoomCode } from '@games/shared/protocol/codes'
import { resolveIdentity } from './auth'
```

Insert before the 404 fallback:

```ts
    if (url.pathname === '/api/rooms' && request.method === 'POST') {
      let body: Record<string, unknown>
      try {
        body = await request.json()
      } catch {
        return json({ error: 'invalid JSON' }, 400, origin)
      }
      if (body.game !== 'chess') return json({ error: 'unknown game' }, 400, origin)
      const visibility = body.visibility === 'public' ? 'public' : 'private'
      const host = await resolveIdentity(body, env)
      if (!host) return json({ error: 'invalid identity' }, 400, origin)
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = generateRoomCode()
        const created = await env.ROOM.getByName(code).create({ code, game: 'chess', visibility, host })
        if (created) return json({ code }, 201, origin)
      }
      return json({ error: 'could not allocate a room code' }, 500, origin)
    }

    const roomMatch = url.pathname.match(/^\/api\/rooms\/([A-Za-z0-9]+)$/)
    if (roomMatch && request.method === 'GET') {
      const code = normalizeRoomCode(roomMatch[1])
      if (!code) return json({ error: 'invalid room code' }, 404, origin)
      return env.ROOM.getByName(code).fetch(request)
    }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -w backend && npm run typecheck -w backend`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: RoomDO with WebSocket join, seats, start, and reconnect"
```

---

### Task 7: RoomDO game actions — move, resign, rematch

**Files:**
- Modify: `backend/src/room.ts`
- Test: `backend/test/room-game.test.ts`

**Interfaces:**
- Consumes: Task 6's `RoomDO` internals (`fail`, `seatOf`, `save`, `broadcast`); `playMove`, `resign`, `createGame` from `@games/shared/chess`; `ChessAction` from protocol.
- Produces: `action` and `rematch` client messages handled; `record.status` flips to `'finished'` when the engine reports a terminal status; rematch swaps colors when both seats vote.

- [ ] **Step 1: Write failing game-action tests**

`backend/test/room-game.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { connect, createRoom, type Client } from './helpers'

const historyLength = (client: Client) => {
  const rooms = client.messages.filter((m) => m.type === 'room')
  return rooms.at(-1)?.snapshot.gameState?.history.length ?? 0
}

async function play(client: Client, from: string, to: string, promotion?: string) {
  const before = historyLength(client)
  client.send({ type: 'action', action: { kind: 'move', from, to, promotion } })
  return client.waitRoom((m) => (m.snapshot.gameState?.history.length ?? 0) > before)
}

async function startGame() {
  const { code, guestId } = await createRoom()
  const host = await connect(code)
  host.join('Ann', guestId)
  host.send({ type: 'sit', seat: 'w' })
  const guest = await connect(code)
  guest.join('Ben')
  guest.send({ type: 'sit', seat: 'b' })
  await host.waitRoom((m) => Boolean(m.snapshot.seats.b))
  host.send({ type: 'start' })
  await host.waitRoom((m) => m.snapshot.status === 'playing')
  await guest.waitRoom((m) => m.snapshot.status === 'playing')
  return { host, guest, code }
}

describe('chess actions', () => {
  it('validates and broadcasts legal moves; rejects out-of-turn and illegal moves', async () => {
    const { host, guest } = await startGame()
    const after = await play(host, 'e2', 'e4')
    expect(after.snapshot.gameState?.history.at(-1)?.san).toBe('e4')
    await guest.waitRoom((m) => (m.snapshot.gameState?.history.length ?? 0) === 1)

    host.send({ type: 'action', action: { kind: 'move', from: 'd2', to: 'd4' } })
    await host.expectError('NOT_YOUR_TURN')
    guest.send({ type: 'action', action: { kind: 'move', from: 'e7', to: 'e4' } })
    await guest.expectError('ILLEGAL_MOVE')
  })

  it('requires a promotion piece and then promotes', async () => {
    const { host, guest } = await startGame()
    await play(host, 'e2', 'e4')
    await play(guest, 'd7', 'd5')
    await play(host, 'e4', 'd5')
    await play(guest, 'c7', 'c6')
    await play(host, 'd5', 'c6')
    await play(guest, 'g8', 'f6')
    await play(host, 'c6', 'b7')
    await play(guest, 'f6', 'd5')
    host.send({ type: 'action', action: { kind: 'move', from: 'b7', to: 'a8' } })
    await host.expectError('PROMOTION_REQUIRED')
    const after = await play(host, 'b7', 'a8', 'q')
    expect(after.snapshot.gameState?.history.at(-1)?.san).toBe('bxa8=Q')
  })

  it('finishes on checkmate and refuses further moves', async () => {
    const { host, guest } = await startGame()
    await play(host, 'f2', 'f3')
    await play(guest, 'e7', 'e5')
    await play(host, 'g2', 'g4')
    const mate = await play(guest, 'd8', 'h4')
    expect(mate.snapshot.status).toBe('finished')
    expect(mate.snapshot.gameState?.status).toBe('checkmate')
    expect(mate.snapshot.gameState?.winner).toBe('b')
    host.send({ type: 'action', action: { kind: 'move', from: 'a2', to: 'a3' } })
    await host.expectError('NOT_PLAYING')
  })

  it('handles resignation from either seat', async () => {
    const { host, guest } = await startGame()
    guest.send({ type: 'action', action: { kind: 'resign' } })
    const done = await host.waitRoom((m) => m.snapshot.status === 'finished')
    expect(done.snapshot.gameState?.status).toBe('resigned')
    expect(done.snapshot.gameState?.winner).toBe('w')
  })

  it('rejects actions from visitors without a seat and before the game starts', async () => {
    const { code, guestId } = await createRoom()
    const host = await connect(code)
    host.join('Ann', guestId)
    host.send({ type: 'action', action: { kind: 'resign' } })
    await host.expectError('NOT_SEATED')
    host.send({ type: 'sit', seat: 'w' })
    await host.waitRoom((m) => m.you.seat === 'w')
    host.send({ type: 'action', action: { kind: 'resign' } })
    await host.expectError('NOT_PLAYING')
  })

  it('starts a rematch with swapped colors once both players agree', async () => {
    const { host, guest } = await startGame()
    guest.send({ type: 'action', action: { kind: 'resign' } })
    await host.waitRoom((m) => m.snapshot.status === 'finished')

    host.send({ type: 'rematch' })
    const voted = await guest.waitRoom((m) => m.snapshot.seats.w?.wantsRematch === true)
    expect(voted.snapshot.status).toBe('finished')

    guest.send({ type: 'rematch' })
    const fresh = await host.waitRoom((m) => m.snapshot.status === 'playing')
    expect(fresh.snapshot.gameState?.history).toEqual([])
    expect(fresh.you.seat).toBe('b')
    expect(fresh.snapshot.seats.w?.player.name).toBe('Ben')
    expect(fresh.snapshot.seats.b?.player.name).toBe('Ann')
  })

  it('rejects rematch while the game is still going', async () => {
    const { host } = await startGame()
    host.send({ type: 'rematch' })
    await host.expectError('NOT_FINISHED')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w backend`
Expected: FAIL — `action`/`rematch` currently answer `BAD_MESSAGE`.

- [ ] **Step 3: Implement the handlers**

In `backend/src/room.ts`: extend the engine import to `import { createGame, playMove, resign } from '@games/shared/chess'`, add `ChessAction` to the protocol type imports, and add two cases to the `webSocketMessage` switch:

```ts
      case 'action':
        return this.handleAction(ws, record, attachment.player, message.action)
      case 'rematch':
        return this.handleRematch(ws, record, attachment.player)
```

Add the handlers:

```ts
  private async handleAction(
    ws: WebSocket,
    record: RoomRecord,
    player: PlayerInfo,
    action: ChessAction,
  ): Promise<void> {
    const seat = this.seatOf(record, player.id)
    if (!seat) return this.fail(ws, 'NOT_SEATED', 'Take a seat to play.')
    if (record.status !== 'playing' || !record.gameState)
      return this.fail(ws, 'NOT_PLAYING', 'The game is not in progress.')
    if (!action || typeof action !== 'object')
      return this.fail(ws, 'BAD_MESSAGE', 'Malformed action.')

    if (action.kind === 'resign') {
      record.gameState = resign(record.gameState, Date.now(), seat)
      record.status = 'finished'
      await this.save(record)
      this.broadcast(record)
      return
    }

    if (action.kind === 'move') {
      if (record.gameState.turn !== seat) return this.fail(ws, 'NOT_YOUR_TURN', 'It is not your turn.')
      const { from, to, promotion } = action
      if (
        typeof from !== 'string' ||
        typeof to !== 'string' ||
        (promotion !== undefined && !['q', 'r', 'b', 'n'].includes(promotion))
      )
        return this.fail(ws, 'BAD_MESSAGE', 'Malformed move.')
      const next = playMove(record.gameState, from, to, promotion)
      if (next.history.length === record.gameState.history.length) {
        if (next.promotion) return this.fail(ws, 'PROMOTION_REQUIRED', 'Choose a piece to promote to.')
        return this.fail(ws, 'ILLEGAL_MOVE', 'That move is not legal.')
      }
      record.gameState = next
      if (next.status !== 'playing') record.status = 'finished'
      await this.save(record)
      this.broadcast(record)
      return
    }

    return this.fail(ws, 'BAD_MESSAGE', 'Unknown action.')
  }

  private async handleRematch(ws: WebSocket, record: RoomRecord, player: PlayerInfo): Promise<void> {
    const seat = this.seatOf(record, player.id)
    if (!seat) return this.fail(ws, 'NOT_SEATED', 'Take a seat to play.')
    if (record.status !== 'finished')
      return this.fail(ws, 'NOT_FINISHED', 'The game is still going.')
    record.seats[seat] = { ...record.seats[seat]!, wantsRematch: true }
    if (record.seats.w?.wantsRematch && record.seats.b?.wantsRematch) {
      const { w, b } = record.seats
      record.seats = {
        w: { player: b.player, wantsRematch: false },
        b: { player: w.player, wantsRematch: false },
      }
      record.gameState = createGame({ mode: 'online', human: 'w', difficulty: 'medium', clock: 0 })
      record.status = 'playing'
    }
    await this.save(record)
    this.broadcast(record)
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w backend && npm run typecheck -w backend`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: authoritative chess moves, resignation, and rematch in RoomDO"
```

---

### Task 8: Room expiry alarm

**Files:**
- Modify: `backend/src/room.ts` (add `alarm()`)
- Test: `backend/test/expiry.test.ts`

**Interfaces:**
- Consumes: Task 6's `save()` (which already schedules the 24h alarm on every write) and the per-message `setAlarm` bump in `webSocketMessage`.
- Produces: `alarm()` that closes all sockets with code 4408 and wipes storage; subsequent connections get `ROOM_NOT_FOUND`. Task 9 extends `alarm()` with lobby removal.

- [ ] **Step 1: Write failing expiry tests**

`backend/test/expiry.test.ts`:

```ts
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import { connect, createRoom } from './helpers'

describe('room expiry', () => {
  it('schedules an expiry alarm on creation and activity', async () => {
    const { code } = await createRoom()
    const stub = env.ROOM.getByName(code)
    await runInDurableObject(stub, async (_instance, state) => {
      const alarm = await state.storage.getAlarm()
      expect(alarm).not.toBeNull()
      expect(alarm!).toBeGreaterThan(Date.now() + 23 * 60 * 60 * 1000)
    })
  })

  it('expires the room: closes sockets with 4408 and forgets everything', async () => {
    const { code, guestId } = await createRoom()
    const client = await connect(code)
    client.join('Ann', guestId)
    await client.waitRoom(() => true)

    const ran = await runDurableObjectAlarm(env.ROOM.getByName(code))
    expect(ran).toBe(true)
    await vi.waitFor(() => expect(client.closes[0]?.code).toBe(4408))

    const back = await connect(code)
    await back.expectError('ROOM_NOT_FOUND')
    await vi.waitFor(() => expect(back.closes[0]?.code).toBe(4404))
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w backend`
Expected: the second test FAILS (`runDurableObjectAlarm` finds an alarm but no `alarm()` handler wipes state / closes sockets). The first may already pass — that's fine.

- [ ] **Step 3: Implement alarm()**

Add to `RoomDO`:

```ts
  async alarm(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) ws.close(CLOSE_CODES.expired, 'ROOM_EXPIRED')
    this.cached = null
    await this.ctx.storage.deleteAll()
    await this.ctx.storage.deleteAlarm()
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w backend`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: expire idle rooms after 24h via DO alarm"
```

---

### Task 9: LobbyDO and the public-room directory

**Files:**
- Modify: `backend/src/lobby.ts` (replace stub), `backend/src/room.ts` (push updates), `backend/src/index.ts` (`GET /api/lobby`)
- Test: `backend/test/lobby.test.ts`

**Interfaces:**
- Consumes: `PublicRoomSummary`, `GameId` from protocol; `RoomRecord` internals from Task 6; Task 8's `alarm()`.
- Produces: `LobbyDO` RPC — `upsert(summary: PublicRoomSummary): Promise<void>`, `remove(code: string): Promise<void>`, `list(game?: GameId): Promise<PublicRoomSummary[]>`; Worker route `GET /api/lobby?game=chess` → `{ rooms: PublicRoomSummary[] }`. The lobby DO instance name is always `'global'`. Only rooms with `status === 'open'` are listed; RoomDO removes its entry on start/finish/expiry.

- [ ] **Step 1: Write failing lobby tests**

`backend/test/lobby.test.ts`:

```ts
import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { SELF } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import type { PublicRoomSummary } from '@games/shared/protocol'
import { connect, createRoom } from './helpers'

async function lobbyRooms(): Promise<PublicRoomSummary[]> {
  const res = await SELF.fetch('https://api.test/api/lobby?game=chess')
  expect(res.status).toBe(200)
  return (await res.json<{ rooms: PublicRoomSummary[] }>()).rooms
}

describe('public lobby', () => {
  it('lists public rooms with live seat counts and hides them once started', async () => {
    const { code, guestId } = await createRoom('public', 'Ann')
    await vi.waitFor(async () => {
      const rooms = await lobbyRooms()
      expect(rooms.map((r) => r.code)).toContain(code)
      expect(rooms.find((r) => r.code === code)).toMatchObject({
        hostName: 'Ann',
        seatsTaken: 0,
        seatsTotal: 2,
      })
    })

    const host = await connect(code)
    host.join('Ann', guestId)
    host.send({ type: 'sit', seat: 'w' })
    await host.waitRoom((m) => m.you.seat === 'w')
    await vi.waitFor(async () => {
      expect((await lobbyRooms()).find((r) => r.code === code)?.seatsTaken).toBe(1)
    })

    const guest = await connect(code)
    guest.join('Ben')
    guest.send({ type: 'sit', seat: 'b' })
    await host.waitRoom((m) => Boolean(m.snapshot.seats.b))
    host.send({ type: 'start' })
    await host.waitRoom((m) => m.snapshot.status === 'playing')
    await vi.waitFor(async () => {
      expect((await lobbyRooms()).map((r) => r.code)).not.toContain(code)
    })
  })

  it('never lists private rooms', async () => {
    const { code } = await createRoom('private')
    expect((await lobbyRooms()).map((r) => r.code)).not.toContain(code)
  })

  it('drops a room from the lobby when it expires', async () => {
    const { code } = await createRoom('public')
    await vi.waitFor(async () => expect((await lobbyRooms()).map((r) => r.code)).toContain(code))
    await runDurableObjectAlarm(env.ROOM.getByName(code))
    await vi.waitFor(async () => {
      expect((await lobbyRooms()).map((r) => r.code)).not.toContain(code)
    })
  })

  it('purges stale entries on its own alarm', async () => {
    const { code } = await createRoom('public')
    await vi.waitFor(async () => expect((await lobbyRooms()).map((r) => r.code)).toContain(code))
    const lobby = env.LOBBY.getByName('global')
    await runInDurableObject(lobby, async (_instance, state) => {
      state.storage.sql.exec('UPDATE rooms SET updated_at = ?', Date.now() - 7 * 60 * 60 * 1000)
    })
    const ran = await runDurableObjectAlarm(lobby)
    expect(ran).toBe(true)
    expect(await lobbyRooms()).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w backend`
Expected: FAIL — `/api/lobby` 404s.

- [ ] **Step 3: Implement LobbyDO**

Replace `backend/src/lobby.ts`:

```ts
import { DurableObject } from 'cloudflare:workers'
import type { GameId, PublicRoomSummary } from '@games/shared/protocol'
import type { Env } from './env'

const STALE_MS = 6 * 60 * 60 * 1000
const PURGE_INTERVAL_MS = 60 * 60 * 1000

interface Row {
  code: string
  game: string
  host_name: string
  seats_taken: number
  seats_total: number
  created_at: number
}

const toSummary = (row: Row): PublicRoomSummary => ({
  code: row.code,
  game: row.game as GameId,
  hostName: row.host_name,
  seatsTaken: row.seats_taken,
  seatsTotal: row.seats_total,
  createdAt: row.created_at,
})

export class LobbyDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS rooms (
          code TEXT PRIMARY KEY,
          game TEXT NOT NULL,
          host_name TEXT NOT NULL,
          seats_taken INTEGER NOT NULL,
          seats_total INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `)
    })
  }

  async upsert(summary: PublicRoomSummary): Promise<void> {
    this.ctx.storage.sql.exec(
      `INSERT INTO rooms (code, game, host_name, seats_taken, seats_total, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET
         host_name = excluded.host_name,
         seats_taken = excluded.seats_taken,
         updated_at = excluded.updated_at`,
      summary.code,
      summary.game,
      summary.hostName,
      summary.seatsTaken,
      summary.seatsTotal,
      summary.createdAt,
      Date.now(),
    )
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + PURGE_INTERVAL_MS)
  }

  async remove(code: string): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM rooms WHERE code = ?', code)
  }

  async list(game?: GameId): Promise<PublicRoomSummary[]> {
    const cutoff = Date.now() - STALE_MS
    const rows = game
      ? this.ctx.storage.sql.exec<Row>(
          'SELECT code, game, host_name, seats_taken, seats_total, created_at FROM rooms WHERE game = ? AND updated_at > ? ORDER BY created_at DESC LIMIT 50',
          game,
          cutoff,
        )
      : this.ctx.storage.sql.exec<Row>(
          'SELECT code, game, host_name, seats_taken, seats_total, created_at FROM rooms WHERE updated_at > ? ORDER BY created_at DESC LIMIT 50',
          cutoff,
        )
    return rows.toArray().map(toSummary)
  }

  async alarm(): Promise<void> {
    this.ctx.storage.sql.exec('DELETE FROM rooms WHERE updated_at <= ?', Date.now() - STALE_MS)
    const remaining = this.ctx.storage.sql
      .exec<{ n: number }>('SELECT COUNT(*) AS n FROM rooms')
      .one().n
    if (remaining > 0) await this.ctx.storage.setAlarm(Date.now() + PURGE_INTERVAL_MS)
  }
}
```

- [ ] **Step 4: Push lobby updates from RoomDO**

In `backend/src/room.ts` add:

```ts
  /** Fire-and-forget: lobby staleness is tolerable, gameplay latency is not. */
  private pushLobby(record: RoomRecord): void {
    if (record.visibility !== 'public') return
    const lobby = this.env.LOBBY.getByName('global')
    if (record.status === 'open') {
      const seatsTaken = SEATS.filter((s) => record.seats[s]).length
      this.ctx.waitUntil(
        lobby.upsert({
          code: record.code,
          game: record.game,
          hostName: record.hostName,
          seatsTaken,
          seatsTotal: SEATS.length,
          createdAt: record.createdAt,
        }),
      )
    } else {
      this.ctx.waitUntil(lobby.remove(record.code))
    }
  }
```

Call `this.pushLobby(record)` (or the freshly built record) immediately after `await this.save(...)` in: `create`, `handleSit`, and `handleStart`. In `alarm()`, before `deleteAll`:

```ts
    const record = await this.load()
    if (record?.visibility === 'public')
      await this.env.LOBBY.getByName('global').remove(record.code)
```

- [ ] **Step 5: Add the lobby route**

In `backend/src/index.ts`, before the 404 fallback:

```ts
    if (url.pathname === '/api/lobby' && request.method === 'GET') {
      const game = url.searchParams.get('game') === 'chess' ? ('chess' as const) : undefined
      const rooms = await env.LOBBY.getByName('global').list(game)
      return json({ rooms }, 200, origin)
    }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test -w backend && npm run typecheck -w backend`
Expected: PASS (all backend suites).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: public lobby directory with live seat counts and stale purge"
```

---

### Task 10: Frontend online foundation (guest identity, API client, room state, useRoom)

**Files:**
- Create: `frontend/src/online/guest.ts`, `frontend/src/online/api.ts`, `frontend/src/online/roomState.ts`, `frontend/src/online/useRoom.ts`, `frontend/src/vite-env.d.ts`
- Test: `frontend/src/online/guest.test.ts`, `frontend/src/online/roomState.test.ts`

**Interfaces:**
- Consumes: protocol types from `@games/shared/protocol`; `useIdentity` from Task 11 (`useRoom.ts` imports it — Task 11 creates it; if executing strictly in order, write `useRoom.ts` against the `Identity` interface documented in Task 11's Produces block and let the typecheck go green when Task 11 lands; alternatively run Task 11 first — both orders work, Task 11 has no dependency on this task's hook).
- Produces:
  - `guest.ts`: `guestId(): string` (stable per browser), `guestName(): string`, `saveGuestName(name: string): void`.
  - `api.ts`: `API_URL: string` (from `VITE_API_URL`, default `http://127.0.0.1:8787`); `createRoom(game, visibility, credentials): Promise<string>` (returns the room code, throws on failure); `fetchLobby(game): Promise<PublicRoomSummary[]>`; `roomSocketUrl(code): string`.
  - `roomState.ts`: `RoomPhase`, `RoomClientState`, `RoomClientEvent`, `initialRoomState`, `roomReducer(state, event)`, `isFatal(phase)`.
  - `useRoom.ts`: `useRoom(code: string): { room: RoomClientState; api: RoomApi }` with `RoomApi = { sit(seat); start(); move(from, to, promotion?); resign(); rematch(); dismissError() }`.

- [ ] **Step 1: Write failing guest tests**

`frontend/src/online/guest.test.ts` (same localStorage-stubbing pattern as `monopoly/game/storage.test.ts`):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { guestId, guestName, saveGuestName } from './guest'

describe('guest identity', () => {
  let records: Map<string, string>
  beforeEach(() => {
    records = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => records.get(k) ?? null,
      setItem: (k: string, v: string) => records.set(k, v),
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('creates a UUID once and keeps it stable', () => {
    const id = guestId()
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(guestId()).toBe(id)
  })

  it('stores and trims the display name', () => {
    expect(guestName()).toBe('')
    saveGuestName('  Ada Lovelace  ')
    expect(guestName()).toBe('Ada Lovelace')
    saveGuestName('x'.repeat(40))
    expect(guestName()).toHaveLength(24)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail, then implement guest.ts**

Run: `npm test -w frontend` → FAIL. Then:

```ts
const ID_KEY = 'games-guest-id'
const NAME_KEY = 'games-guest-name'

export function guestId(): string {
  let id = localStorage.getItem(ID_KEY)
  if (!id) {
    id = crypto.randomUUID()
    localStorage.setItem(ID_KEY, id)
  }
  return id
}

export function guestName(): string {
  return localStorage.getItem(NAME_KEY) ?? ''
}

export function saveGuestName(name: string): void {
  localStorage.setItem(NAME_KEY, name.trim().slice(0, 24).trim())
}
```

Run: `npm test -w frontend` → PASS.

- [ ] **Step 3: Env typing and api.ts**

`frontend/src/vite-env.d.ts`:

```ts
/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string
  readonly VITE_CLERK_PUBLISHABLE_KEY?: string
}
```

`frontend/src/online/api.ts`:

```ts
import type { GameId, PublicRoomSummary, RoomVisibility } from '@games/shared/protocol'

// `||`, not `??`: CI passes unset repo variables through as empty strings.
export const API_URL: string = import.meta.env.VITE_API_URL || 'http://127.0.0.1:8787'

export interface IdentityCredentials {
  guestId?: string
  clerkToken?: string
  avatar?: string
}

export async function createRoom(
  game: GameId,
  visibility: RoomVisibility,
  name: string,
  credentials: IdentityCredentials,
): Promise<string> {
  const res = await fetch(`${API_URL}/api/rooms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ game, visibility, name, ...credentials }),
  })
  if (!res.ok) throw new Error('Could not create a room right now.')
  const { code } = (await res.json()) as { code: string }
  return code
}

export async function fetchLobby(game: GameId): Promise<PublicRoomSummary[]> {
  const res = await fetch(`${API_URL}/api/lobby?game=${game}`)
  if (!res.ok) throw new Error('Could not load open rooms.')
  return ((await res.json()) as { rooms: PublicRoomSummary[] }).rooms
}

export function roomSocketUrl(code: string): string {
  return `${API_URL.replace(/^http/, 'ws')}/api/rooms/${code}`
}
```

- [ ] **Step 4: Write failing roomState tests**

`frontend/src/online/roomState.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { RoomSnapshot } from '@games/shared/protocol'
import { initialRoomState, isFatal, roomReducer } from './roomState'

const snapshot: RoomSnapshot = {
  protocol: 1,
  code: 'KX3F9M',
  game: 'chess',
  visibility: 'private',
  status: 'open',
  hostId: 'guest:abc',
  seats: {},
  gameState: null,
}
const you = { id: 'guest:abc', seat: null }

describe('roomReducer', () => {
  it('stores snapshots and clears stale errors', () => {
    const errored = roomReducer(initialRoomState, {
      type: 'message',
      message: { type: 'error', code: 'ILLEGAL_MOVE', message: 'nope' },
    })
    expect(errored.error?.code).toBe('ILLEGAL_MOVE')
    const roomed = roomReducer(errored, { type: 'message', message: { type: 'room', snapshot, you } })
    expect(roomed.snapshot?.code).toBe('KX3F9M')
    expect(roomed.you).toEqual(you)
    expect(roomed.error).toBeNull()
    expect(roomed.phase).toBe('connected')
  })

  it('maps terminal errors and close codes to fatal phases', () => {
    expect(
      roomReducer(initialRoomState, {
        type: 'message',
        message: { type: 'error', code: 'ROOM_NOT_FOUND', message: 'gone' },
      }).phase,
    ).toBe('notfound')
    expect(roomReducer(initialRoomState, { type: 'close', code: 4403 }).phase).toBe('full')
    expect(roomReducer(initialRoomState, { type: 'close', code: 4408 }).phase).toBe('expired')
  })

  it('treats other closes as reconnecting and keeps the last snapshot', () => {
    const roomed = roomReducer(initialRoomState, { type: 'message', message: { type: 'room', snapshot, you } })
    const dropped = roomReducer(roomed, { type: 'close', code: 1006 })
    expect(dropped.phase).toBe('reconnecting')
    expect(dropped.snapshot?.code).toBe('KX3F9M')
  })

  it('flags fatal phases', () => {
    expect(isFatal('notfound')).toBe(true)
    expect(isFatal('expired')).toBe(true)
    expect(isFatal('full')).toBe(true)
    expect(isFatal('connected')).toBe(false)
    expect(isFatal('reconnecting')).toBe(false)
  })
})
```

- [ ] **Step 5: Run to verify failure, then implement roomState.ts**

```ts
import { CLOSE_CODES } from '@games/shared/protocol'
import type { ErrorCode, RoomSnapshot, ServerMessage, YouInfo } from '@games/shared/protocol'

export type RoomPhase = 'connecting' | 'connected' | 'reconnecting' | 'notfound' | 'full' | 'expired'

export interface RoomClientState {
  phase: RoomPhase
  snapshot: RoomSnapshot | null
  you: YouInfo | null
  error: { code: ErrorCode; message: string } | null
}

export type RoomClientEvent =
  | { type: 'open' }
  | { type: 'message'; message: ServerMessage }
  | { type: 'close'; code: number }
  | { type: 'dismiss-error' }

export const initialRoomState: RoomClientState = {
  phase: 'connecting',
  snapshot: null,
  you: null,
  error: null,
}

export function roomReducer(state: RoomClientState, event: RoomClientEvent): RoomClientState {
  switch (event.type) {
    case 'open':
      return { ...state, phase: 'connected' }
    case 'message':
      if (event.message.type === 'room')
        return {
          ...state,
          phase: 'connected',
          snapshot: event.message.snapshot,
          you: event.message.you,
          error: null,
        }
      if (event.message.code === 'ROOM_NOT_FOUND') return { ...state, phase: 'notfound' }
      if (event.message.code === 'ROOM_FULL') return { ...state, phase: 'full' }
      return { ...state, error: { code: event.message.code, message: event.message.message } }
    case 'close':
      if (event.code === CLOSE_CODES.notFound) return { ...state, phase: 'notfound' }
      if (event.code === CLOSE_CODES.full) return { ...state, phase: 'full' }
      if (event.code === CLOSE_CODES.expired) return { ...state, phase: 'expired' }
      return { ...state, phase: 'reconnecting' }
    case 'dismiss-error':
      return { ...state, error: null }
  }
}

export const isFatal = (phase: RoomPhase): boolean =>
  phase === 'notfound' || phase === 'full' || phase === 'expired'
```

Run: `npm test -w frontend` → PASS.

- [ ] **Step 6: Implement useRoom.ts**

The hook owns the socket lifecycle; all message interpretation lives in the tested reducer. Identity is read through a ref so a re-rendered provider never tears down the socket.

```ts
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react'
import { PROTOCOL_VERSION } from '@games/shared/protocol'
import type { ChessSeat, ClientMessage } from '@games/shared/protocol'
import { roomSocketUrl } from './api'
import { initialRoomState, isFatal, roomReducer } from './roomState'
import type { RoomClientState } from './roomState'
import { useIdentity } from './identity'

export interface RoomApi {
  sit: (seat: ChessSeat) => void
  start: () => void
  move: (from: string, to: string, promotion?: 'q' | 'r' | 'b' | 'n') => void
  resign: () => void
  rematch: () => void
  dismissError: () => void
}

export function useRoom(code: string): { room: RoomClientState; api: RoomApi } {
  const identity = useIdentity()
  const identityRef = useRef(identity)
  identityRef.current = identity
  const [room, dispatch] = useReducer(roomReducer, initialRoomState)
  const socket = useRef<WebSocket | null>(null)
  const attempts = useRef(0)
  const fatal = isFatal(room.phase)

  useEffect(() => {
    if (fatal) return
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const open = () => {
      const ws = new WebSocket(roomSocketUrl(code))
      socket.current = ws
      ws.onopen = async () => {
        attempts.current = 0
        dispatch({ type: 'open' })
        const me = identityRef.current
        const credentials = await me.credentials()
        ws.send(
          JSON.stringify({ type: 'join', protocol: PROTOCOL_VERSION, name: me.name, ...credentials }),
        )
      }
      ws.onmessage = (event) => dispatch({ type: 'message', message: JSON.parse(event.data as string) })
      ws.onclose = (event) => {
        if (disposed) return
        dispatch({ type: 'close', code: event.code })
        timer = setTimeout(open, Math.min(10000, 1000 * 2 ** attempts.current++))
      }
    }
    open()
    return () => {
      disposed = true
      clearTimeout(timer)
      socket.current?.close()
      socket.current = null
    }
  }, [code, fatal])

  const send = useCallback((message: ClientMessage) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message))
  }, [])

  const api = useMemo<RoomApi>(
    () => ({
      sit: (seat) => send({ type: 'sit', seat }),
      start: () => send({ type: 'start' }),
      move: (from, to, promotion) => send({ type: 'action', action: { kind: 'move', from, to, promotion } }),
      resign: () => send({ type: 'action', action: { kind: 'resign' } }),
      rematch: () => send({ type: 'rematch' }),
      dismissError: () => dispatch({ type: 'dismiss-error' }),
    }),
    [send],
  )

  return { room, api }
}
```

No unit test for the hook itself — the reducer carries the logic and Task 14's two-browser e2e exercises the socket path (including reconnect via the room URL reload).

- [ ] **Step 7: Verify and commit**

Run: `npm test -w frontend && npm run lint -w frontend`
Expected: PASS. (Skip the app-wide `tsc` here: `useRoom.ts` imports `./identity`, which Task 11 creates — nothing executes that import yet, and Task 11's verification runs the full typecheck.)

```bash
git add -A
git commit -m "feat: online foundation - guest identity, API client, room state, useRoom"
```

---

### Task 11: Optional Clerk auth (identity context, provider, header button)

**Files:**
- Create: `frontend/src/online/identity.tsx`
- Modify: `frontend/src/main.tsx`, `frontend/src/pages/HomePage.tsx`, `frontend/src/pages/HomePage.css`, `frontend/package.json` (add `@clerk/react`)

**Interfaces:**
- Consumes: `guestId`, `guestName`, `saveGuestName` (Task 10).
- Produces: `AuthProvider` (wraps the app; uses Clerk only when `VITE_CLERK_PUBLISHABLE_KEY` is set); `useIdentity(): Identity` where `Identity = { name: string; setName(name): void; isSignedIn: boolean; avatar?: string; credentials(): Promise<{ guestId?: string; clerkToken?: string; avatar?: string }> }`; `HeaderAuth` component (renders nothing when Clerk is not configured). Games never import Clerk directly — only this module does.

- [ ] **Step 1: Install Clerk**

```bash
npm install @clerk/react -w frontend
```

- [ ] **Step 2: Implement identity.tsx**

```tsx
import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ClerkProvider, SignInButton, UserButton, useAuth, useUser } from '@clerk/react'
import { guestId, guestName, saveGuestName } from './guest'

export interface IdentityCredentials {
  guestId?: string
  clerkToken?: string
  avatar?: string
}

export interface Identity {
  name: string
  setName: (name: string) => void
  isSignedIn: boolean
  avatar?: string
  credentials: () => Promise<IdentityCredentials>
}

// `|| undefined` so an empty string from CI counts as "not configured".
const CLERK_KEY: string | undefined = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY || undefined
const IdentityContext = createContext<Identity | null>(null)

export function useIdentity(): Identity {
  const identity = useContext(IdentityContext)
  if (!identity) throw new Error('useIdentity must be used inside AuthProvider')
  return identity
}

function useGuestIdentity(): Identity {
  const [name, setNameState] = useState(guestName)
  const setName = useCallback((value: string) => {
    saveGuestName(value)
    setNameState(guestName())
  }, [])
  const credentials = useCallback(async () => ({ guestId: guestId() }), [])
  return useMemo(
    () => ({ name, setName, isSignedIn: false, credentials }),
    [name, setName, credentials],
  )
}

function GuestIdentity({ children }: { children: ReactNode }) {
  const identity = useGuestIdentity()
  return <IdentityContext.Provider value={identity}>{children}</IdentityContext.Provider>
}

function ClerkIdentity({ children }: { children: ReactNode }) {
  const guest = useGuestIdentity()
  const { isLoaded, isSignedIn, getToken } = useAuth()
  const { user } = useUser()
  const identity = useMemo<Identity>(() => {
    if (!isLoaded || !isSignedIn || !user) return guest
    return {
      name: user.fullName || user.username || 'Player',
      setName: () => undefined,
      isSignedIn: true,
      avatar: user.imageUrl,
      credentials: async () => {
        const token = await getToken()
        return token ? { clerkToken: token, avatar: user.imageUrl } : { guestId: guestId() }
      },
    }
  }, [guest, isLoaded, isSignedIn, user, getToken])
  return <IdentityContext.Provider value={identity}>{children}</IdentityContext.Provider>
}

/** Clerk is optional: with no publishable key the whole tree runs guest-only. */
export function AuthProvider({ children }: { children: ReactNode }) {
  if (!CLERK_KEY) return <GuestIdentity>{children}</GuestIdentity>
  return (
    <ClerkProvider publishableKey={CLERK_KEY}>
      <ClerkIdentity>{children}</ClerkIdentity>
    </ClerkProvider>
  )
}

export function HeaderAuth() {
  if (!CLERK_KEY) return null
  return <ClerkHeaderAuth />
}

function ClerkHeaderAuth() {
  const { isLoaded, isSignedIn } = useAuth()
  if (!isLoaded) return null
  if (isSignedIn) return <UserButton />
  return (
    <SignInButton mode="modal">
      <button className="collection-signin">Sign in</button>
    </SignInButton>
  )
}
```

(The `if (!CLERK_KEY)` branches are on a module constant, so hook order is stable within each component.)

- [ ] **Step 3: Wire main.tsx and HomePage**

`frontend/src/main.tsx`:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router'
import './index.css'
import App from './App.tsx'
import { AuthProvider } from './online/identity'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <HashRouter>
        <App />
      </HashRouter>
    </AuthProvider>
  </StrictMode>,
)
```

In `frontend/src/pages/HomePage.tsx`, import `{ HeaderAuth }` from `'../online/identity'` and render `<HeaderAuth />` as the last child inside `<header className="collection-header">`. In `HomePage.css` add a modest button style consistent with the page (match existing button/link colors already used in the file):

```css
.collection-signin {
  border: 1px solid currentColor;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  font: inherit;
  padding: 0.35rem 0.9rem;
  cursor: pointer;
}
```

- [ ] **Step 4: Verify both modes**

Run: `npm run lint -w frontend && npm test -w frontend && npm run build -w frontend && npx tsc --noEmit -p frontend/tsconfig.app.json`
Expected: all pass (Task 10's pending `./identity` import now resolves).

Manual check (optional but recommended): `npm run dev` → home page renders with NO sign-in button (no key configured). Then create `frontend/.env.local` with a Clerk dev `VITE_CLERK_PUBLISHABLE_KEY=pk_test_...` → sign-in button appears and the modal opens. `.env.local` is gitignored by Vite scaffolds; verify `git status` stays clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: optional Clerk login with guest-first identity context"
```

---

### Task 12: ChessGame `online` prop — authoritative gameplay wiring

**Files:**
- Create: `frontend/src/games/chess/online/session.ts`
- Modify: `frontend/src/games/chess/ChessGame.tsx`, `frontend/src/games/chess/ChessGame.css`

**Interfaces:**
- Consumes: engine + types from `@games/shared/chess`.
- Produces: `OnlineChessSession` interface (below); `ChessGame` accepts optional prop `online?: OnlineChessSession`. When set: no localStorage, no clocks, no AI, no undo/draw/restart; moves/resign/rematch go through `online.send`; the rendered `GameState` is always `online.state`. Local and AI play are byte-for-byte unaffected when `online` is undefined. Task 13 constructs the session.

`frontend/src/games/chess/online/session.ts`:

```ts
import type { Color, GameState, PromotionPiece, Square } from '@games/shared/chess/types'

export interface OnlineChessSession {
  state: GameState
  myColor: Color | null
  players: Partial<Record<Color, { name: string; connected: boolean }>>
  rematch: { mine: boolean; theirs: boolean }
  send: {
    move: (from: Square, to: Square, promotion?: PromotionPiece) => void
    resign: () => void
    rematch: () => void
  }
  leave: () => void
}
```

- [ ] **Step 1: Read ChessGame.tsx fully before editing**

The component is ~1040 lines. Read it end to end first; the edits below name their anchors by the code they change. `npm run test:e2e -w frontend -- tests/chess.spec.ts` must pass unchanged at the end — that is the regression net for this task.

- [ ] **Step 2: Apply the online-mode edits**

All edits in `frontend/src/games/chess/ChessGame.tsx`:

1. **Signature + import:**

```tsx
import type { OnlineChessSession } from './online/session'

export default function ChessGame({ online }: { online?: OnlineChessSession }) {
```

2. **State sourcing** (anchor: `const [boot] = useState(storedGame)` block):

```tsx
  const [boot] = useState(() => (online ? null : storedGame()))
  const [localGame, setGame] = useState<GameState>(() => boot || createGame())
  const game = online ? online.state : localGame
  const [menu, setMenu] = useState(online ? false : !boot)
```

(`storedGame` was previously passed by reference — keep the call-form shown here. Every other `game` read in the component keeps working because `game` is still a `GameState` in scope; only the setter paths change below.)

3. **Local promotion picker for online moves** (near the other `useState` calls):

```tsx
  const [onlinePromotion, setOnlinePromotion] = useState<{
    from: Square
    to: Square
    color: Color
  } | null>(null)
  const promotion = online ? onlinePromotion : game.promotion
```

Replace reads of `game.promotion` that drive UI (the `enabled` expression, the promotion modal condition `{!menu && game.promotion && ...}`, and the PromotionGallery props) with `promotion`. Do NOT touch `game.promotion` uses inside engine calls.

4. **Turn gating** (anchor: the `aiTurn` and `enabled` consts):

```tsx
  const aiTurn =
    !online && !menu && game.status === 'playing' && game.options.mode === 'ai' && game.turn !== game.options.human
  const enabled =
    !menu &&
    game.status === 'playing' &&
    !moving &&
    !aiTurn &&
    !promotion &&
    !dialog &&
    (!online || (online.myColor !== null && game.turn === online.myColor))
```

5. **Effect guards:** add `if (online) return` (or include `online` in the early-return condition) at the top of: the clock-ticking effect, the localStorage persistence effect, and the AI-move effect. Add `online` to those dependency arrays if the linter asks.

6. **Move dispatch** (anchor: the square-activation handler that calls `commit(playMove(game, selected, square), game)`): branch before the local commit:

```tsx
      if (online) {
        const candidates = legalMoves(game, selected).filter((m) => m.to === square)
        if (candidates.length === 0) {
          // fall through to the existing "that square doesn't work" notice path
        } else if (candidates.some((m) => m.promotion)) {
          setOnlinePromotion({ from: selected, to: square, color: game.turn })
          setSelected(null)
          return
        } else {
          online.send.move(selected, square)
          setSelected(null)
          return
        }
      }
```

The optimistic board does NOT move — the piece animates when the authoritative snapshot arrives (`online.state` changes), which reuses the existing render path.

7. **Promotion pick** (anchor: the PromotionGallery `onSelect`/confirm handler that calls `promote(game, piece)`):

```tsx
      if (online && onlinePromotion) {
        online.send.move(onlinePromotion.from, onlinePromotion.to, piece)
        setOnlinePromotion(null)
      } else {
        commitOrSetGame(promote(game, piece)) // whatever the existing local call is — keep it
      }
```

8. **Resign** (anchor: the `dialog === 'resign'` confirm button):

```tsx
      if (online) online.send.resign()
      else setGame(resign(game))
```

9. **Hide local-only controls when online:** wrap the Undo button, the draw-offer button, and the restart button/dialog triggers in `{!online && ...}`. The "menu"/back control becomes, when online, a **Leave room** button calling `online.leave()` directly (no confirm dialog).

10. **Result modal** (anchor: the end-of-game overlay around `{!menu && isOver && !resultDismissed ...}`): when online, replace the local "play again / return to menu" actions with:

```tsx
              {online ? (
                <>
                  <button
                    className="ch-result-primary"
                    onClick={online.send.rematch}
                    disabled={online.rematch.mine}
                  >
                    {online.rematch.mine
                      ? 'Waiting for opponent…'
                      : online.rematch.theirs
                        ? 'Accept rematch'
                        : 'Rematch'}
                  </button>
                  <button className="ch-result-menu" onClick={online.leave}>
                    Leave room
                  </button>
                </>
              ) : (
                /* existing local buttons unchanged */
              )}
```

Also reset the dismissal state when a rematch starts, so the next game's board is interactive: add an effect

```tsx
  useEffect(() => {
    if (online && game.status === 'playing') setResultDismissed(false)
  }, [online, game.status])
```

11. **PlayerCard names and presence:** extend `PlayerCard` with optional `label?: string`, `away?: boolean`, `you?: boolean`; render `label ?? COLOR_NAMES[color]` as the strong text, an `AWAY` small-tag when `away`, a `YOU` small-tag when `you`. At the two call sites pass:

```tsx
              label={online?.players[color]?.name}
              away={online ? online.players[color] !== undefined && !online.players[color]!.connected : false}
              you={online?.myColor === color}
```

(adjust `color` to the concrete `'w'`/`'b'` each call site uses).

12. **Board orientation:** the `black` state currently orients the board only for AI games. Online, orient to your seat — including after a color-swapping rematch:

```tsx
  const [black, setBlack] = useState(
    () => (online ? online.myColor === 'b' : boot?.options.mode === 'ai' && boot.options.human === 'b'),
  )
  useEffect(() => {
    if (online) setBlack(online.myColor === 'b')
  }, [online, online?.myColor])
```

- [ ] **Step 3: Styles**

In `ChessGame.css` reuse `.ch-small-tag` for the AWAY/YOU tags; add a muted variant:

```css
.ch-small-tag.ch-tag-away {
  opacity: 0.6;
}
```

- [ ] **Step 4: Verify local play is untouched**

Run: `npm run lint -w frontend && npx tsc --noEmit -p frontend/tsconfig.app.json && npm test -w frontend && npm run test:e2e -w frontend -- tests/chess.spec.ts`
Expected: ALL pass — the local/AI experience must be pixel-identical (no `online` prop on the `/chess` route yet).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: ChessGame accepts an online session for server-authoritative play"
```

---

### Task 13: ChessRoomPage, OnlinePanel, and routes

**Files:**
- Create: `frontend/src/games/chess/ChessRoomPage.tsx`, `frontend/src/games/chess/online/OnlinePanel.tsx`
- Modify: `frontend/src/App.tsx`, `frontend/src/games/chess/ChessGame.tsx` (render `<OnlinePanel />` in the menu), `frontend/src/games/chess/ChessGame.css`

**Interfaces:**
- Consumes: `useRoom`/`RoomApi` (Task 10), `useIdentity` (Task 11), `OnlineChessSession` + `ChessGame online` prop (Task 12), `createRoom`/`fetchLobby` (Task 10), `normalizeRoomCode` (Task 3).
- Produces: route `/chess/room/:code` (hash URL `/#/chess/room/KX3F9M` is the share link); the chess menu's "Play online" panel.

- [ ] **Step 1: OnlinePanel**

`frontend/src/games/chess/online/OnlinePanel.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import type { PublicRoomSummary, RoomVisibility } from '@games/shared/protocol'
import { normalizeRoomCode } from '@games/shared/protocol/codes'
import { createRoom, fetchLobby } from '../../../online/api'
import { useIdentity } from '../../../online/identity'

export default function OnlinePanel() {
  const navigate = useNavigate()
  const identity = useIdentity()
  const [name, setName] = useState(identity.name)
  const [visibility, setVisibility] = useState<RoomVisibility>('private')
  const [joinCode, setJoinCode] = useState('')
  const [rooms, setRooms] = useState<PublicRoomSummary[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const refresh = () =>
    fetchLobby('chess')
      .then(setRooms)
      .catch(() => setRooms(null))
  useEffect(() => {
    fetchLobby('chess')
      .then(setRooms)
      .catch(() => setRooms(null))
  }, [])

  const playerName = identity.isSignedIn ? identity.name : name.trim()

  const rememberName = () => {
    if (!identity.isSignedIn) identity.setName(name)
  }

  const create = async () => {
    setBusy(true)
    setError('')
    try {
      rememberName()
      const code = await createRoom('chess', visibility, playerName, await identity.credentials())
      navigate(`/chess/room/${code}`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  const join = (code: string) => {
    const normalized = normalizeRoomCode(code)
    if (!normalized) {
      setError('Room codes are six letters and numbers.')
      return
    }
    rememberName()
    navigate(`/chess/room/${normalized}`)
  }

  return (
    <section className="ch-online" aria-label="Play online">
      <h3>Play online</h3>
      {!identity.isSignedIn && (
        <label className="ch-online-name">
          Your name
          <input
            value={name}
            maxLength={24}
            onChange={(event) => setName(event.target.value)}
            placeholder="What should we call you?"
          />
        </label>
      )}
      <div className="ch-online-row">
        <label>
          <input
            type="checkbox"
            checked={visibility === 'public'}
            onChange={(event) => setVisibility(event.target.checked ? 'public' : 'private')}
          />{' '}
          List in the public lobby
        </label>
        <button disabled={!playerName || busy} onClick={create}>
          Create room
        </button>
      </div>
      <div className="ch-online-row">
        <input
          value={joinCode}
          maxLength={6}
          onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
          placeholder="Room code"
          aria-label="Room code"
        />
        <button disabled={!playerName || !joinCode.trim() || busy} onClick={() => join(joinCode)}>
          Join
        </button>
      </div>
      <div className="ch-online-lobby">
        <div className="ch-online-lobby-head">
          <span>Open rooms</span>
          <button onClick={() => void refresh()}>Refresh</button>
        </div>
        {rooms === null ? (
          <p>The game server is unreachable right now.</p>
        ) : rooms.length === 0 ? (
          <p>No open rooms right now — create one!</p>
        ) : (
          <ul>
            {rooms.map((room) => (
              <li key={room.code}>
                <span>
                  {room.hostName} · {room.seatsTaken}/{room.seatsTotal} seated
                </span>
                <button disabled={!playerName} onClick={() => join(room.code)}>
                  Join {room.code}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
    </section>
  )
}
```

In `ChessGame.tsx`, render `{!online && <OnlinePanel />}` inside the menu branch of the setup panel, after the existing local/AI mode controls (anchor: the `{menu ? (` block around line 542 — place the panel at the end of the menu content).

- [ ] **Step 2: ChessRoomPage**

`frontend/src/games/chess/ChessRoomPage.tsx`:

```tsx
import { useMemo } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { normalizeRoomCode } from '@games/shared/protocol/codes'
import type { ChessSeat, SeatInfo } from '@games/shared/protocol'
import type { ReactNode } from 'react'
import { useIdentity } from '../../online/identity'
import { useRoom } from '../../online/useRoom'
import ChessGame from './ChessGame'
import type { OnlineChessSession } from './online/session'
import './ChessGame.css'

const other = (seat: ChessSeat): ChessSeat => (seat === 'w' ? 'b' : 'w')
const player = (seat?: SeatInfo) => (seat ? { name: seat.player.name, connected: seat.connected } : undefined)

export default function ChessRoomPage() {
  const { code: raw } = useParams()
  const identity = useIdentity()
  const code = normalizeRoomCode(raw ?? '')
  if (!code)
    return (
      <Notice title="That link looks wrong.">
        <Link to="/chess">Back to Gambit</Link>
      </Notice>
    )
  if (!identity.name) return <NamePrompt />
  return <Room code={code} />
}

function Notice({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <main className="ch-room-notice">
      <h1>{title}</h1>
      {children}
    </main>
  )
}

function NamePrompt() {
  const identity = useIdentity()
  return (
    <Notice title="Pick a name to join the table.">
      <form
        onSubmit={(event) => {
          event.preventDefault()
          const data = new FormData(event.currentTarget)
          identity.setName(String(data.get('name') ?? ''))
        }}
      >
        <input name="name" maxLength={24} placeholder="Your name" aria-label="Your name" />
        <button type="submit">Join room</button>
      </form>
    </Notice>
  )
}

function Room({ code }: { code: string }) {
  const navigate = useNavigate()
  const { room, api } = useRoom(code)
  const { snapshot, you } = room
  const leave = () => navigate('/chess')

  const session = useMemo<OnlineChessSession | null>(() => {
    if (!snapshot?.gameState || !you) return null
    const mySeat = you.seat
    return {
      state: snapshot.gameState,
      myColor: mySeat,
      players: { w: player(snapshot.seats.w), b: player(snapshot.seats.b) },
      rematch: {
        mine: mySeat ? (snapshot.seats[mySeat]?.wantsRematch ?? false) : false,
        theirs: mySeat ? (snapshot.seats[other(mySeat)]?.wantsRematch ?? false) : false,
      },
      send: { move: api.move, resign: api.resign, rematch: api.rematch },
      leave,
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, you, api])

  if (room.phase === 'notfound')
    return (
      <Notice title="This room doesn't exist (or has expired).">
        <Link to="/chess">Back to Gambit</Link>
      </Notice>
    )
  if (room.phase === 'expired')
    return (
      <Notice title="This room has expired.">
        <Link to="/chess">Back to Gambit</Link>
      </Notice>
    )
  if (room.phase === 'full')
    return (
      <Notice title="This room already has two players.">
        <Link to="/chess">Back to Gambit</Link>
      </Notice>
    )
  if (!snapshot) return <p role="status">Joining room {code}…</p>

  if (session)
    return (
      <>
        <ChessGame online={session} />
        {room.error && (
          <button className="ch-room-toast" role="status" onClick={api.dismissError}>
            {room.error.message}
          </button>
        )}
        {room.phase === 'reconnecting' && (
          <div className="ch-room-toast" role="status">
            Reconnecting…
          </div>
        )}
      </>
    )

  const seatButton = (seat: ChessSeat, label: string) => {
    const occupant = snapshot.seats[seat]
    const mine = you?.seat === seat
    return (
      <button
        className={`ch-room-seat ${mine ? 'ch-room-seat-mine' : ''}`}
        disabled={Boolean(occupant) && !mine}
        onClick={() => api.sit(seat)}
      >
        <strong>{label}</strong>
        <span>
          {occupant ? `${occupant.player.name}${occupant.connected ? '' : ' (away)'}` : 'Open seat'}
        </span>
      </button>
    )
  }

  const isHost = you?.id === snapshot.hostId
  const ready = Boolean(snapshot.seats.w && snapshot.seats.b)
  return (
    <main className="ch-room">
      <h1>Room {snapshot.code}</h1>
      <p>
        Share this link with a friend:{' '}
        <button
          className="ch-room-copy"
          onClick={() => void navigator.clipboard.writeText(window.location.href)}
        >
          Copy link
        </button>
      </p>
      <div className="ch-room-seats">
        {seatButton('w', 'Play as White')}
        {seatButton('b', 'Play as Black')}
      </div>
      {isHost ? (
        <button className="ch-room-start" disabled={!ready} onClick={api.start}>
          {ready ? 'Start the game' : 'Waiting for both seats…'}
        </button>
      ) : (
        <p role="status">{ready ? 'Waiting for the host to start…' : 'Waiting for players…'}</p>
      )}
      {room.error && (
        <p role="alert" onClick={api.dismissError}>
          {room.error.message}
        </p>
      )}
      <Link to="/chess">Leave room</Link>
    </main>
  )
}
```

- [ ] **Step 3: Route and page metadata**

In `frontend/src/App.tsx`:

```tsx
const ChessRoomPage = lazy(() => import('./games/chess/ChessRoomPage'))
```

Add inside `<Routes>` before the catch-all:

```tsx
        <Route path="/chess/room/:code" element={<ChessRoomPage />} />
```

Update the game-matching line so the room route inherits chess theming/title:

```tsx
  const game = games.find(
    (entry) => matchPath(entry.path, pathname) || matchPath(`${entry.path}/room/:code`, pathname),
  )
```

- [ ] **Step 4: Styles**

Append to `ChessGame.css` (match the file's existing custom-property palette — reuse its color variables rather than hardcoding new hues where any exist):

```css
.ch-online { display: grid; gap: 0.75rem; border-top: 1px solid rgba(0, 0, 0, 0.12); padding-top: 1rem; }
.ch-online-row { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
.ch-online-lobby ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.4rem; }
.ch-online-lobby li { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; }
.ch-online-lobby-head { display: flex; justify-content: space-between; align-items: center; }
.ch-room, .ch-room-notice { max-width: 32rem; margin: 4rem auto; padding: 0 1.5rem; display: grid; gap: 1rem; }
.ch-room-seats { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
.ch-room-seat { display: grid; gap: 0.25rem; padding: 1rem; }
.ch-room-seat-mine { outline: 2px solid currentColor; }
.ch-room-toast { position: fixed; bottom: 1.25rem; left: 50%; transform: translateX(-50%); padding: 0.6rem 1.2rem; border-radius: 999px; background: rgba(20, 20, 20, 0.85); color: #fff; z-index: 30; }
```

- [ ] **Step 5: Verify**

Run: `npm run lint -w frontend && npx tsc --noEmit -p frontend/tsconfig.app.json && npm test -w frontend && npm run build -w frontend`
Expected: all pass.

Manual smoke (recommended): terminal 1 `npm run dev -w backend`, terminal 2 `npm run dev -w frontend`; open two browser windows on `http://localhost:5173/#/chess`, create a room in one, join by code in the other, sit, start, play a move each way, kill and reopen one window mid-game to watch the reconnect reclaim the seat.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: chess room page, online panel, and lobby-driven join flow"
```

---

### Task 14: Two-browser Playwright e2e

**Files:**
- Create: `frontend/tests/chess-online.spec.ts`
- Modify: `frontend/playwright.config.ts`

**Interfaces:**
- Consumes: the full stack from Tasks 1–13; the `keyboardPlayer` pattern from `frontend/tests/chess.spec.ts`.
- Produces: an e2e that proves create → join → sit → start → alternating moves → live sync → reconnect.

- [ ] **Step 1: Boot both servers from Playwright**

`frontend/playwright.config.ts` — replace the single `webServer` with an array (paths are relative to the config file):

```ts
import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests',
  timeout: 60000,
  fullyParallel: false,
  workers: 1,
  webServer: [
    {
      command: 'npm run dev -w backend',
      cwd: '..',
      url: 'http://127.0.0.1:8787/health',
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
    },
    {
      command: 'npm run dev -- --host 127.0.0.1',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 30000,
    },
  ],
  use: {
    baseURL: 'http://127.0.0.1:5173',
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 960 },
    screenshot: 'only-on-failure',
  },
  reporter: 'list',
})
```

No `VITE_API_URL` needed: the frontend's dev default is exactly `http://127.0.0.1:8787`.

- [ ] **Step 2: Write the failing e2e**

`frontend/tests/chess-online.spec.ts`. Reuse the `keyboardPlayer` helper from `chess.spec.ts`, parameterized for board orientation — read `frontend/src/games/chess/scene/` first to check whether keyboard square navigation is absolute (same arrows regardless of orientation) or view-relative. If absolute, call with `flipped: false` for both players and delete the flip math.

```ts
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

function keyboardPlayer(page: Page, flipped = false) {
  let current = 'e2'
  async function go(square: string) {
    await page.getByRole('group', { name: '3D chessboard', exact: true }).focus()
    const sign = flipped ? -1 : 1
    const dx = (square.charCodeAt(0) - current.charCodeAt(0)) * sign
    const dy = (Number(square[1]) - Number(current[1])) * sign
    for (let i = 0; i < Math.abs(dx); i++) await page.keyboard.press(dx > 0 ? 'ArrowRight' : 'ArrowLeft')
    for (let i = 0; i < Math.abs(dy); i++) await page.keyboard.press(dy > 0 ? 'ArrowUp' : 'ArrowDown')
    current = square
  }
  return async (from: string, to: string) => {
    await go(from)
    await page.keyboard.press('Enter')
    await go(to)
    await page.keyboard.press('Enter')
  }
}

async function newPlayer(browser: import('@playwright/test').Browser) {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.addInitScript(() => {
    localStorage.setItem(
      'gambit-preferences-v1',
      JSON.stringify({ sound: false, reducedMotion: true }),
    )
  })
  return page
}

test('two browsers create, join, and play in the same room', async ({ browser }) => {
  const host = await newPlayer(browser)
  const guest = await newPlayer(browser)

  await host.goto('/#/chess')
  await host.getByLabel('Your name').fill('Ann')
  await host.getByRole('button', { name: 'Create room' }).click()
  await expect(host).toHaveURL(/#\/chess\/room\/[A-Z2-9]{6}$/)
  const code = host.url().match(/room\/([A-Z2-9]{6})/)![1]

  await guest.goto(`/#/chess/room/${code}`)
  await guest.getByLabel('Your name').fill('Ben')
  await guest.getByRole('button', { name: 'Join room' }).click()

  await host.getByRole('button', { name: /Play as White/ }).click()
  await guest.getByRole('button', { name: /Play as Black/ }).click()
  await expect(host.getByRole('button', { name: 'Start the game' })).toBeEnabled()
  await host.getByRole('button', { name: 'Start the game' }).click()

  await expect(host.locator('.ch-canvas canvas')).toBeVisible()
  await expect(guest.locator('.ch-canvas canvas')).toBeVisible()
  await expect(host.getByText('Ben').first()).toBeVisible()

  const hostMove = keyboardPlayer(host)
  const guestMove = keyboardPlayer(guest, true)
  await hostMove('e2', 'e4')
  await expect(host.getByLabel('Move history')).toContainText('e4')
  await expect(guest.getByLabel('Move history')).toContainText('e4')
  await guestMove('e7', 'e5')
  await expect(host.getByLabel('Move history')).toContainText('e5')

  await guest.reload()
  await expect(guest.getByLabel('Move history')).toContainText('e5')
  const guestMoveAgain = keyboardPlayer(guest, true)
  await hostMove('g1', 'f3')
  await expect(guest.getByLabel('Move history')).toContainText('Nf3')
  await guestMoveAgain('b8', 'c6')
  await expect(host.getByLabel('Move history')).toContainText('Nc6')
})
```

- [ ] **Step 3: Run the e2e**

Run: `npm run test:e2e -w frontend -- tests/chess-online.spec.ts`
Expected: FAIL first if any wiring is off — fix forward until green. Selector names above come from Tasks 12–13; if a label differs on the real page, fix the PAGE or the TEST to whichever the design doc intends, not blindly the test.

Then run the full suite: `npm run test:e2e -w frontend`
Expected: ALL specs pass, including the four existing games' suites.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test: two-browser e2e for online chess rooms"
```

---

### Task 15: CI deploy job and setup documentation

**Files:**
- Modify: `.github/workflows/deploy.yml`
- Create: `docs/deployment.md`
- Modify: `frontend/README.md` (pointer to the new doc)

**Interfaces:**
- Consumes: everything.
- Produces: pushes to `main` deploy both the Pages site and the Worker; a written runbook for the one-time account setup the repo owner must do by hand.

- [ ] **Step 1: Add the Worker deploy job**

In `.github/workflows/deploy.yml` add a job (reuse the exact pinned action SHAs already in the file):

```yaml
  deploy-api:
    runs-on: ubuntu-latest
    if: github.ref == 'refs/heads/main'
    steps:
      - name: Check out repository
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7

      - name: Set up Node.js
        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7
        with:
          node-version: '24'
          cache: npm
          cache-dependency-path: package-lock.json

      - name: Install dependencies
        run: npm ci

      - name: Test shared and backend
        run: npm run test -w shared && npm run test -w backend && npm run typecheck -w backend

      - name: Deploy Worker
        working-directory: backend
        run: npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

And extend the existing frontend build step's `env` with:

```yaml
          VITE_API_URL: ${{ vars.API_URL }}
          VITE_CLERK_PUBLISHABLE_KEY: ${{ vars.CLERK_PUBLISHABLE_KEY }}
```

(Unset repo variables arrive as empty strings — the frontend treats empty as absent by design; see `api.ts`/`identity.tsx` which use `||`, not `??`.)

- [ ] **Step 2: Write docs/deployment.md**

```markdown
# Deployment & one-time setup

The site deploys to GitHub Pages; the multiplayer API deploys to Cloudflare
Workers. Pushes to `main` deploy both. Multiplayer works without Clerk —
skipping the Clerk section just means everyone plays as a guest.

## Cloudflare (required for multiplayer)

1. Create a Cloudflare account and an API token using the
   "Edit Cloudflare Workers" template.
2. GitHub repo → Settings → Secrets and variables → Actions:
   - Secret `CLOUDFLARE_API_TOKEN` — the token from step 1.
   - Secret `CLOUDFLARE_ACCOUNT_ID` — Cloudflare dashboard → Workers → Account ID.
3. Push to `main` (or run `npx wrangler deploy` from `backend/` once). Note the
   Worker URL, e.g. `https://games-api.<account>.workers.dev`.
4. Repo variable `API_URL` — that Worker URL. The Pages build bakes it in as
   `VITE_API_URL`.

## Clerk (optional sign-in)

1. Create a Clerk application (clerk.com), enable the sign-in methods you want.
2. Add `https://games.manishbisht.me` (and localhost for dev) to allowed origins.
3. Repo variable `CLERK_PUBLISHABLE_KEY` — the production publishable key
   (`pk_live_…`). Baked into the frontend as `VITE_CLERK_PUBLISHABLE_KEY`.
4. Backend secret: `cd backend && npx wrangler secret put CLERK_SECRET_KEY`
   (the matching secret key). Without it the API rejects Clerk tokens but
   guests are unaffected.

## Local development

- `npm ci` at the repo root.
- `npm run dev -w backend` (Worker + Durable Objects on http://127.0.0.1:8787).
- `npm run dev -w frontend` (Vite on http://localhost:5173 — the frontend
  defaults its API URL to 127.0.0.1:8787, no env needed).
- Optional Clerk in dev: put `VITE_CLERK_PUBLISHABLE_KEY=pk_test_…` in
  `frontend/.env.local` and `CLERK_SECRET_KEY=sk_test_…` in `backend/.dev.vars`.
- Tests: `npm test` (all workspaces) · e2e: `npm run test:e2e -w frontend`
  (boots both dev servers itself).
```

- [ ] **Step 3: Point the existing README at it**

Add a short "Multiplayer & deployment" section to `frontend/README.md` linking to `../docs/deployment.md`.

- [ ] **Step 4: Full verification sweep**

Run: `npm run lint -w frontend && npm test && npm run typecheck -w backend && npm run build -w frontend && npm run test:e2e -w frontend`
Expected: everything green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "ci: deploy games-api worker and document multiplayer setup"
```

---

## Manual steps the repo owner does once (outside this plan)

- Add GitHub secrets `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`, then variables `API_URL` (after first deploy) and optionally `CLERK_PUBLISHABLE_KEY`.
- Optionally create the Clerk app and `wrangler secret put CLERK_SECRET_KEY`.

Until `API_URL` is set, the deployed site's online panel will show "server unreachable" — local/AI play is unaffected.
