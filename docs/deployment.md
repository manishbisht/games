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
5. Recommended before going live: add Cloudflare Rate Limiting rules on the
   two unauthenticated write endpoints:
   - `POST /api/rooms` (e.g. 10 requests per minute per IP) — room creation.
   - `POST /api/presence` (e.g. 30 requests per minute per IP) — the
     players-online heartbeat; each open tab beats twice a minute, so this
     tolerates several tabs behind one NAT while capping abuse.

## Clerk (optional sign-in)

1. Create a Clerk application (clerk.com), and enable the Google social connection for sign-in and sign-up. The frontend uses Clerk’s sign-in modal with Google shown among the social buttons.
2. Add `https://games.manishbisht.me` (and localhost for dev) to allowed origins.
3. Repo variable `CLERK_PUBLISHABLE_KEY` — the production publishable key
   (`pk_live_…`). Baked into the frontend as `VITE_CLERK_PUBLISHABLE_KEY`.
4. Backend secret: `cd backend && npx wrangler secret put CLERK_SECRET_KEY`
   (the matching secret key). Without it the API rejects Clerk tokens but
   guests are unaffected.

The Google sign-in button appears on the collection and all five game menus when
`VITE_CLERK_PUBLISHABLE_KEY` is present at build time. Without that key, the UI
shows a guest identity and games remain playable as guests. If a deployed build
is missing the button, check the `CLERK_PUBLISHABLE_KEY` Actions variable and
rebuild the Pages site; changing it does not update an already-built bundle.
Google OAuth also requires the Google connection and production credentials to
be configured in the matching Clerk instance.

## Local development

- Node ≥ 22 required for local dev and e2e suite (wrangler's floor; use `nvm use 22` if your default is older).
- `npm ci` at the repo root.
- `npm run dev -w backend` (Worker + Durable Objects on http://127.0.0.1:8787).
- `npm run dev -w frontend` (Vite on http://localhost:5173 — the frontend
  defaults its API URL to 127.0.0.1:8787, no env needed).
- Optional Clerk in dev: put `VITE_CLERK_PUBLISHABLE_KEY=pk_test_…` in
  `frontend/.env.local` and `CLERK_SECRET_KEY=sk_test_…` in `backend/.dev.vars`.
- Tests: `npm test` (all workspaces) · e2e: `npm run test:e2e -w frontend`
  (starts the local backend and serves a production frontend build).
- Longer bot gameplay checks: `npm run test:smoke -w frontend`.
