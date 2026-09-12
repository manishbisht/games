# Multiplayer backend design

Add a Cloudflare Workers backend so people can join the same room and play together live. Server-authoritative architecture: each room is a Durable Object running the real game engine; clients send intents and the server broadcasts the authoritative state. Clerk login is optional — guests play fully, signing in adds persistent identity. Scope for this round: the backend infrastructure plus one game wired end-to-end, Gambit (chess). The other games follow in later rounds using the same pipeline.

## Repo structure and deployment

Restructure into an npm-workspaces monorepo:

```
games/
├─ package.json          # workspaces root: frontend, backend, shared
├─ frontend/             # existing Vite app — stays on GitHub Pages
├─ backend/              # Cloudflare Worker + Durable Objects
│  ├─ wrangler.jsonc     # DO bindings (RoomDO, LobbyDO), migrations
│  └─ src/
└─ shared/               # @games/shared — imported by both sides
   └─ src/
      ├─ chess/          # engine.ts + types.ts moved from frontend
      └─ protocol/       # WebSocket message types, room types
```

The chess engine (`engine.ts`, `types.ts`, `engine.test.ts`) moves from `frontend/src/games/chess/game/` to `shared/`; the frontend imports it from `@games/shared` with no behavioral change. `ai.ts`, `ai.worker.ts`, and `audio.ts` stay in the frontend (client-only). Other engines move to `shared/` only when their game gets multiplayer.

Frontend deployment is untouched (GitHub Pages workflow, gains a `VITE_API_URL` build env). A new GitHub Actions job deploys the backend with `wrangler deploy` using a `CLOUDFLARE_API_TOKEN` repository secret. The backend serves from a `*.workers.dev` URL initially; a custom domain (e.g. `api.games.manishbisht.me`) can be attached later without design changes.

## Identity

One player shape on the server: `{ id, name, avatar?, isGuest }`.

- **Clerk users:** frontend adds `@clerk/react` (`ClerkProvider` plus a sign-in button in the home page header). Requests and WebSocket connections carry the Clerk session JWT; the Worker verifies it networklessly via `@clerk/backend` with cached JWKS. Name and avatar come from the Clerk profile.
- **Guests:** the browser generates a random UUID stored in localStorage and the player picks a display name. The guest ID is the bearer credential, sufficient to reclaim a seat on reconnect. No server-side account records in v1; login gates nothing and purely enriches identity.

## Rooms, lobby, and protocol

`POST /api/rooms` with `{ game: 'chess', visibility: 'private' | 'public' }` creates a room with a 6-character code (unambiguous alphabet, no 0/O/1/I). Each room is one **RoomDO** addressed by that code. Clients connect to `WS /api/rooms/:code`; everything else happens over the socket. Lifecycle: `open` (seats filling) → `playing` → `finished` (rematch returns to `playing`). A DO alarm expires rooms after ~24 hours of inactivity. WebSocket hibernation keeps idle rooms free.

One **LobbyDO** holds the public-room directory. RoomDOs push status updates to it (created, seats filled, started, finished, expired). `GET /api/lobby?game=chess` returns joinable public rooms. Private rooms never appear.

Protocol: versioned JSON over WebSocket, types in `shared/protocol/`.

- Client → server: `join` (identity + name), `sit` (take a color), `start`, `action` (game-specific intent, e.g. `{ move: { from, to, promotion } }`), `rematch`, `leave`.
- Server → client: `room` (full snapshot: seats, status, players, authoritative `GameState` — sent on join, reconnect, and after every accepted action), `presence` (connect/disconnect), `error` (structured code + message).

Full-state sync, not deltas: chess state is tiny and full snapshots make reconnects and late joins trivially correct. Illegal or out-of-turn actions receive an `error` and cause no state change. The engine on the server is the single source of truth.

## Chess frontend integration

The chess game gains an `online` mode alongside local and AI play:

- The chess preview page gets a Play online section: create room (private/public toggle), join by code, and a public lobby list fetched from `/api/lobby`. Creating or joining navigates to `/chess/room/:code` — that URL is the share link.
- In the room, players take a color, the host starts, and the existing 3D board renders the server's `GameState` — same shape it already uses, so board and scene code do not change. Moves are sent as intents; the board updates only on the authoritative `room` message. Opponent presence shows in the UI. Clocks stay disabled online in v1.
- A `useRoom` hook owns the WebSocket: auto-reconnect with backoff, resync from the `room` snapshot, structured errors surfaced as toasts. Reopening the room link reclaims your seat via your identity.

## Error handling

WS errors carry stable codes (`ROOM_FULL`, `ROOM_NOT_FOUND`, `NOT_YOUR_TURN`, `ILLEGAL_MOVE`, `BAD_TOKEN`, …). The client treats unknown or failed sends as resync-and-retry rather than trusting local state. CORS is locked to `games.manishbisht.me` and localhost dev origins.

## Testing

Engine tests move to `shared/` unchanged. The backend uses vitest with `@cloudflare/vitest-pool-workers`: real RoomDO/LobbyDO tests covering create/join, seat claiming, move validation (legal, illegal, out-of-turn), reconnect resync, rematch, lobby listing, and expiry alarms. One Playwright e2e runs two browser contexts against `wrangler dev`: create and join a room, play moves from both sides, assert both boards agree. Existing frontend lint, unit, and e2e suites keep passing.

## Out of scope for this round

Spectators, matchmaking, online clocks, game history/stats, friends, and multiplayer for Hearth & Home, Estate, and Prism. Prism's hidden hands are why the architecture is server-authoritative with per-player views possible later, but no filtered-view code is built now.
