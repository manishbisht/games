# Security review — October 2026

Scope: the Worker (`backend/src`: `index.ts`, `auth.ts`, `room.ts`, `limits.ts`, `clientErrors.ts`,
`presence.ts`, `lobby.ts`, `cors.ts`, and — from `989c3c1`, `4499459`, `cb5a4a9` — `player.ts`, `push.ts`,
`handles.ts`, `ledger.ts`, `outcome.ts`, `analytics.ts`, reactions in `room.ts`, `frontend/public/sw.js`), the game adapters it trusts (`shared/src/*/adapter.ts`,
`shared/src/online/registry.ts`), and the browser's handling of identity (`frontend/src/online/identity.tsx`,
`clerkAuth.tsx`, `guest.ts`, `api.ts`, `useRoom.ts`, `playersOnline.tsx`, `frontend/src/errorReports.ts`).
Reviewed at `cdb207b` plus the working tree of 2026-10-19 (line numbers re-checked against `52b9c80`; every finding
also names the function, in case they drift). Report only: no code was changed. **Update 2026-10-20:** the server-side
findings (1–10, 13, 16–20) are fixed in the working tree, each with tests; every section below opens with its status.

**Summary.** No critical or high-severity issue, including in the profiles, reactions and push work added
during the review (findings 15–20). The identity model is sound (the verified Clerk `sub` or a
UUID guest id is the identity; seat ids are stripped from snapshots; bot ids live in a namespace a client
cannot mint), every client message is shape-checked before it reaches a rules engine, hidden information is
redacted per viewer, and no secret is in the repository or its history. The findings are almost all about
**cost and abuse at scale**: places where one client (or one IPv6 subnet) can make the server do unbounded
work, and the two global Durable Objects every visitor shares.

| #   | Severity | Finding                                                                                   |
| --- | -------- | ----------------------------------------------------------------------------------------- |
| 1   | Medium   | A forged Clerk token forces an outbound JWKS fetch per message (amplification, no limit)  |
| 2   | Medium   | No per-socket message rate limit in a room                                                |
| 3   | Medium   | Sockets that never join are unlimited per room and never timed out                        |
| 4   | Medium   | Per-address rate limits key on the full IPv6 address                                      |
| 5   | Medium   | `/api/presence` and `/api/lobby` are unthrottled and both hit one global Durable Object   |
| 6   | Low–Med  | Public rooms are listed before anyone sits in them; lobby can be flooded with names       |
| 7   | Low      | The guest id (a bearer credential) doubles as the presence `clientId` and is stored there |
| 8   | Low      | Display names accept bidi overrides, zero-width and control characters                    |
| 9   | Low      | Clerk tokens are accepted without `authorizedParties`                                     |
| 10  | Low      | `/api/errors` reads an unbounded body when no `Content-Length` is sent                    |
| 11  | Low      | A signed-in player's name is not scrubbed from error reports                              |
| 12  | Low      | No Content-Security-Policy on the site                                                    |
| 13  | Info     | No `Origin` check on the WebSocket upgrade; CORS admits any localhost port                |
| 14  | Info     | Dev-only dependency advisories (`npm audit`: 7 high, 0 in production deps)                |
| 15  | Low      | The guest id now also travels as an `X-Guest-Id` header — keep it out of platform logs    |
| 16  | Low      | Push delivery follows redirects and accepts any port on an allowed host                   |
| 17  | Low      | Reaction allowance is per socket, so extra sockets or reconnects multiply it              |
| 18  | Low      | Public profiles publish opponents' handles and exact game times; no opt-out               |
| 19  | Low      | Chess ratings can be farmed with throwaway guest identities                               |
| 20  | Low      | A joiner's free-text name reaches the host's lock screen in a push notification           |

---

## 1. Medium — forged Clerk tokens force a JWKS fetch each time

**Status (2026-10-20).** Fixed (server, commit-ready). Tokens verify against Clerk's key set fetched once per isolate and cached for an hour (`ClerkKeys` in `auth.ts`); a token naming a key the set lacks may refresh it at most once per 5 minutes, and concurrent misses share one fetch. With the new optional `CLERK_JWT_KEY` secret (PEM) verification never touches the network. A socket gets one successful join and at most three attempts, then is closed (1008). Tests: `auth.test.ts` (forged-kid storm → one fetch), `room-hardening.test.ts`. **Deploy:** `wrangler secret put CLERK_JWT_KEY` is recommended.

**Where.** `backend/src/auth.ts:33-41` (`resolvePlayerId`) calls `verifyToken(token, { secretKey })`. In `@clerk/backend` 2.33.6
(`node_modules/@clerk/backend/dist/index.js:1399-1419`, `loadClerkJWKFromRemote`), a token whose header `kid`
is not in the in-memory cache triggers a fresh fetch of the instance's JWKS from Clerk's Backend API — with
retries — before the token is rejected. The call sites are `POST /api/rooms` (`index.ts:104`), `GET /api/me` and the push subscription
endpoints (an `Authorization: Bearer` header, `index.ts:58-61`) — all rate-limited per address — and
**every `join` message** (`room.ts:777`), which is not rate-limited (see #2) and can be sent repeatedly on one
socket (`handleJoin` never refuses an already-joined socket).

**Exploit.** Open a socket to any room code, then loop `{"type":"join","protocol":N,"name":"x","clerkToken":"<any
well-formed JWT with a random kid>"}`. Each message makes the Worker call `api.clerk.com` with the secret key.
Hundreds per second from one socket burn subrequests and Durable Object wall time, and can push the Clerk
instance into Backend API rate limiting — at which point real players' JWKS refreshes fail and signed-in joins
break site-wide.

**Fix.** Verify networklessly: set a `CLERK_JWT_KEY` secret (the instance's PEM public key from the Clerk
dashboard) and pass `jwtKey: env.CLERK_JWT_KEY` to `verifyToken`; with it the library never fetches. Also
refuse a second `join` on a socket that already has an attachment (or count join attempts per socket and close
after a few failures).

## 2. Medium — no per-socket message rate limit in a room

**Status (2026-10-20).** Fixed (server, commit-ready). Token bucket per socket (`MESSAGE_LIMITS`: burst 30, refill 10/s); the first frame over is answered `RATE_LIMITED` (new additive `ErrorCode`), and a socket that sends another full burst into the empty bucket is closed with 1008. Frames over 8 KB are refused before `JSON.parse`. Lobby updates are throttled to one per 250 ms per room. Test: `room-hardening.test.ts`.

**Where.** `room.ts:723-768` (`webSocketMessage`). Every message is parsed and dispatched; every mutating
handler ends in `save()` (`room.ts:232-238`: a full `storage.put` of the record, `setAlarm`, a possible
PresenceDO RPC) and `broadcast()` (`room.ts:700-721`: a snapshot built per distinct seat and sent to up to 24
sockets). Only the platform's own per-message size cap applies; there is no frequency cap.

**Exploit.** A seated player in an open room alternates `sit` A / `sit` B (or `leaveSeat`/`sit`) in a tight loop:
each message is a storage write plus a 24-way broadcast, and public rooms also fire a LobbyDO `upsert`
(`room.ts:831`) per message. The room becomes unusable for everyone in it and the account pays for the writes.
`action` spam is cheaper (the adapter refuses out-of-turn moves before any write) but still parsed and answered.

**Fix.** A token bucket per socket, kept in memory on the DO (e.g. 20 messages/second burst, 5/s sustained),
closing the socket with a policy-violation code when exceeded; drop messages larger than a few KB before
`JSON.parse` (`typeof raw === 'string' && raw.length > 8192`). Debounce `pushLobby` so a burst of seat changes
is one upsert.

## 3. Medium — sockets that never join are unlimited and never time out

**Status (2026-10-20).** Fixed (server, commit-ready). Each socket's attachment records when it was accepted; sockets that have not joined within 15 s are closed (1013) by a per-room sweep timer (and on the next upgrade), and at most 32 unjoined sockets are held — the oldest is let go for the newest, so a whole room reconnecting at once still fits. Test: `room-hardening.test.ts`.

**Where.** `room.ts:618-628` accepts every upgrade; `MAX_ROOM_SOCKETS` (`room.ts:50`) is only checked inside
`handleJoin` (`room.ts:783`) and `joinedSockets` (`room.ts:645-649`) counts only sockets with an attachment.
The edge answers `ping` without waking the object (`room.ts:169`), so an idle unjoined socket lives forever.

**Exploit.** Open thousands of sockets to one room (or to codes that do not exist — those are closed, but
existing rooms are not) and never send `join`. Each is held by the DO (up to the platform's per-object limit);
every `broadcast`, `connectedIds` and `handleDeparture` iterates `getWebSockets()` and deserializes each
attachment, so the room's per-move cost grows with the attacker's socket count. The 120/min/address socket limit
is the only brake, and see #4.

**Fix.** In `fetch`, refuse the upgrade (or accept and immediately close) when `getWebSockets().length` is
already above, say, `MAX_ROOM_SOCKETS * 2`. Give unjoined sockets a deadline: record the accept time in the
attachment (`{ acceptedAt }`) and close sockets with no `player` older than ~10 s on the next alarm or message.

## 4. Medium — rate limits key on the full IPv6 address

**Status (2026-10-20).** Fixed (server, commit-ready). `clientKey` keys IPv6 on its /64 (IPv4-mapped addresses on their IPv4 form, IPv4 unchanged), for every limiter. Test: `limits.test.ts` (rotation within a /64 is one key).

**Where.** `limits.ts:31-35` uses `CF-Connecting-IP` verbatim as the key for `ROOMS_LIMITER`,
`SOCKETS_LIMITER`, `ERRORS_LIMITER` and `PROFILES_LIMITER` (`backend/wrangler.jsonc` `ratelimits`).

**Exploit.** Any IPv6 host normally owns at least a /64 — 2^64 addresses. Rotating the source address per
request makes every per-address limit meaningless: unlimited room creation (20/min intended), socket opens and
error-log writes. It also makes private-room code enumeration (31^6 ≈ 8.9 × 10^8 codes,
`shared/src/protocol/codes.ts`) cheaper than the limit implies — still impractical against a small number of
live rooms, but no longer bounded by the limiter.

**Fix.** Key IPv6 on its /64 prefix (first four hextets after expanding `::`), IPv4 on the full address.
Consider a coarser second limiter (per /48) for room creation.

## 5. Medium — presence and lobby are unthrottled and global

**Status (2026-10-20).** Fixed (server, commit-ready). New `PRESENCE_LIMITER` (40/min) and `LOBBY_LIMITER` (60/min). `PresenceDO` now does a point lookup and an upsert per beat: counts are reused for 2 s unless the beat changed who is here, pruning runs at most every 15 s on new indexes (`presence(last_seen)`, `room_bots(updated_at)`), and one address (`sourceTag`, a hash — never the address) can add at most 20 browsers to the count. Tests: `limits.test.ts`, `presence-counts.test.ts`.

**Where.** `index.ts:138-147` (`POST /api/presence`) and `index.ts:208-212` (`GET /api/lobby`) have no
`overLimit` check. Both route to a single object named `'global'` (`PresenceDO`, `LobbyDO`). `PresenceDO.beat`
(`presence.ts:101-142`) runs two DELETEs, an upsert and three aggregate queries per call.

**Exploit.** (a) Availability: a few hundred requests a second to either endpoint saturates the one
single-threaded object, and every visitor's players-online badge and every lobby list stalls with it. (b)
Integrity: `clientId` is any 8–64 character string (`presence.ts:22`), so a script posting beats with fresh
ids every 30 s inflates the public "players online" counts arbitrarily.

**Fix.** Add a `PRESENCE_LIMITER` (e.g. 10/min/address — a tab beats twice a minute) and a `LOBBY_LIMITER`;
serve `/api/lobby` through the Cache API for a few seconds so bursts collapse to one DO call; cap distinct
`client_id`s per address if the count matters.

## 6. Low–Medium — ghost public rooms and lobby flooding

**Status (2026-10-20).** Fixed (server, commit-ready). A public room is listed only while it is open and its host, or a seated person, is connected; it is no longer listed at creation and is removed when the last such person leaves. The lobby lists at most 3 rooms per address tag (`MAX_LISTED_PER_SOURCE`); extra rooms still work by code. Test: `lobby.test.ts`.

**Where.** `room.ts:613-614` calls `pushLobby` at creation, before the host has connected or sat; `lobby.ts:87-101`
lists anything updated in the last 6 hours (`STALE_MS`) with a free seat. Host names are free text (`auth.ts:17-21`).

**Exploit.** `POST /api/rooms` with `visibility: "public"` and an offensive `name` 50 times (the lobby shows 50,
`lobby.ts:93`); nobody ever joins, yet every visitor of that game's lobby sees the names for six hours. With #4,
the per-address creation limit does not slow this down.

**Fix.** Only list a public room once its host is seated and connected (push from `handleJoin`/`handleSit`
instead of `create`), drop it from the lobby when the last person leaves (`handleDeparture`), and shorten
`STALE_MS` for rooms with no connected sockets. Cap public rooms per address/identity.

## 7. Low — the guest id is also the presence `clientId`

**Status (2026-10-20).** Fixed. Server: whatever id a browser sends is hashed (`presenceKey`) before it reaches `PresenceDO`, so no guest id is stored, from old clients or new. Client (shell agent, `01b10bf`): `playersOnline.tsx` sends its own random `games-presence-id`. Test: `presence-counts.test.ts`.

**Where.** `frontend/src/online/playersOnline.tsx:29` sends `guestId()` as `clientId`; `presence.ts:107-117`
stores it as `client_id` in the global PresenceDO's SQLite table (aged out after 90 s, `presence.ts:5`).

**Why it matters.** The guest UUID is the only credential a guest has — whoever knows it can rejoin as them,
take their seat and act as host. Everywhere else it is handled well: sent only in POST bodies and the first
socket frame (`api.ts:35-48`, `useRoom.ts:146`), never in URLs; stripped from seat info in snapshots
(`room.ts:667`); echoed only to its own socket (`room.ts:713-717`); scrubbed from error reports
(`errorReports.ts:70`); never logged by the Worker. Presence is the one place it is persisted for a purpose that
does not need it, widening who could ever read it (a future debug endpoint, a storage dump, a log line).

**Fix.** Send a separate random id for presence (a second `localStorage` UUID, or `SHA-256(guestId)` truncated).
The count only needs a stable, distinct per-browser value.

## 8. Low — names accept bidi overrides, zero-width and control characters

**Status (2026-10-20).** Fixed (server, commit-ready). `cleanName` normalises to NFC, collapses whitespace, strips `Cc`, `Cf` and other default-ignorable characters (keeping ZWJ/ZWNJ between characters and emoji variation selectors), the braille blank, stacks of more than three combining marks, and caps at 24 code points without splitting a grapheme; a name with nothing printable left is refused. Every name enters through it (join, room creation), and profiles and push payloads clean again on the way out. Test: `auth.test.ts`. Client mirror in `saveGuestName` remains a frontend follow-up.

**Where.** `auth.ts:17-21` (`cleanName`) collapses whitespace and truncates to 24 UTF-16 units.

**Exploit.** No XSS: names are rendered as React text and canvas `fillText`, and the frontend has no
`dangerouslySetInnerHTML`/`innerHTML` sinks. But a name containing U+202E (right-to-left override), U+200B or
other `Cc`/`Cf` characters can render as someone else's name, reverse the text around it in the lobby, or be
invisible. Truncation at 24 units can also split a surrogate pair.

**Fix.** Strip `\p{Cc}` and `\p{Cf}` (`value.replace(/[\p{Cc}\p{Cf}]/gu, '')`), normalize to NFC, and truncate
by code points (`[...name].slice(0, 24).join('')`). Mirror it in `saveGuestName` (`guest.ts:17-19`).

## 9. Low — Clerk tokens accepted without `authorizedParties`

**Status (2026-10-20).** Fixed (server, commit-ready). After verification, an `azp` claim must be the site origin — or a localhost origin when the Worker itself is a local dev server. Test: `auth.test.ts`.

**Where.** `auth.ts:36`. `verifyToken` checks signature, `exp`/`nbf` (5 s skew) and the issuer's keys, but
without `authorizedParties` it does not check the `azp` claim, and no `audience` is set.

**Exploit.** A session token minted by the same Clerk instance for another origin (another app sharing the
instance, a dev site) is accepted here. Tokens are bearer values in a JSON body rather than cookies, so this is
not CSRF — it widens which tokens count, nothing more. Also note a joined socket keeps its identity for its
lifetime: a revoked session is only noticed on the next reconnect.

**Fix.** `verifyToken(token, { jwtKey, authorizedParties: ['https://games.manishbisht.me'] })` (plus the local
origins in development).

## 10. Low — `/api/errors` reads an unbounded body without `Content-Length`

**Status (2026-10-20).** Fixed (server, commit-ready). The body is read through a byte counter (`readCapped`) and cut off with 413 past 8 KB, whatever `Content-Length` says. Test: `limits.test.ts` (chunked body).

**Where.** `index.ts:152-155`: the size check uses the declared `content-length`; a chunked request has none,
so `request.text()` buffers whatever arrives before `parseReport` checks `text.length` (`clientErrors.ts:30`,
which also counts UTF-16 units rather than bytes).

**Fix.** Read through `request.body` with a byte counter and abort past `MAX_REPORT_BYTES`, or refuse requests
with no `Content-Length` (`sendBeacon` and `fetch` with a string body always send one).

## 11. Low — a signed-in player's name is not scrubbed from error reports

**Status (2026-10-20).** Open — frontend (`errorReports.ts`), outside the server work.

**Where.** `frontend/src/errorReports.ts:80-89` takes the name to scrub from `localStorage['games-guest-name']`
only. A signed-in player's Clerk display name (`clerkAuth.tsx:24-25`) — often a full real name — is not
scrubbed if it appears in an error message (e.g. a render error quoting a seat label). Guest UUIDs, emails, URL
queries and the room code are scrubbed (`errorReports.ts:68-78`).

**Fix.** Have the identity provider register the current display name with the reporter (a small
`setReportScrub({ name })` called from `ClerkIdentity`), or scrub every seated player's name from the latest
snapshot.

## 12. Low — no Content-Security-Policy

**Status (2026-10-20).** Open — frontend (`index.html`).

**Where.** `frontend/index.html`. GitHub Pages cannot set response headers, and there is no `<meta
http-equiv="Content-Security-Policy">`. There is currently no XSS sink, so this is defence in depth: today an
injected script could read `games-guest-id` from `localStorage` and take over that guest.

**Fix.** A meta CSP: `default-src 'self'; script-src 'self' 'sha256-<hash of the theme script>'
https://*.clerk.accounts.dev https://clerk.<domain>; connect-src 'self' <API origin> wss://<API host>
https://*.clerk.accounts.dev https://api.clerk.com; img-src 'self' data: https://img.clerk.com; style-src 'self'
'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-src
https://*.clerk.accounts.dev`. Verify Clerk's hosts for the production instance before shipping, and run the e2e
suite with it.

## 13. Info — no `Origin` check on the WebSocket upgrade; CORS admits any localhost port

**Status (2026-10-20).** Fixed (server, commit-ready). A WebSocket upgrade with an `Origin` that is not allowed is refused (403); scripts that send none are held to the socket limit. Localhost origins (CORS and upgrades) are only admitted when the Worker is itself served from loopback (`isLocalWorker`) — `wrangler dev`, tests and CI keep working with no configuration. Tests: `worker.test.ts`, `room-hardening.test.ts`.

**Where.** `index.ts:128-136` forwards the upgrade regardless of `Origin`; `cors.ts:8` allows any
`http(s)://localhost:*` or `127.0.0.1:*` origin.

**Assessment.** Not exploitable as cross-site WebSocket hijacking: there are no ambient credentials (no
cookies) — identity arrives inside the `join` frame, which a foreign page does not have. A foreign page can
still open sockets or create rooms _from its visitors' browsers_, borrowing their addresses against the
per-address limits. CORS here only governs reading responses, none of which are sensitive.

**Fix (optional).** Refuse upgrades whose `Origin` is present and not `allowedOrigin(...)`; restrict localhost
origins to `import.meta.env`-style dev builds of the Worker (e.g. an `ALLOW_LOCAL_ORIGINS` var off in production).

## 14. Info — dependency advisories are dev-only

**Status (2026-10-20).** Open — dependency updates.

`npm audit` (2026-10-19): 7 high-severity advisories, all in development tooling — `undici` 7.29 (via
`miniflare`/`wrangler` and `@cloudflare/vitest-pool-workers`), `sharp` (via `miniflare`), `source-map-js` (via
`postcss`/`vite`), `brace-expansion`. `npm audit --omit=dev` reports **0**. Fix by updating `wrangler` and
`@cloudflare/vitest-pool-workers` when releases with patched `miniflare` land; `.github/dependabot.yml` now
raises these weekly.

---

## New surface: profiles, reactions, push (`989c3c1`, `4499459`, `cb5a4a9`)

What was added: `GET /api/me` and `GET /api/players/:handle` (per-player `PlayerDO`, keyed by a handle),
`POST`/`DELETE /api/push/subscription` and `GET /api/push/key` (Web Push with VAPID), `react` client frames
broadcast as `reaction` server frames, Analytics Engine events, a service worker and manifest. The
foundations are sound:

- **Credentials on plain HTTP** (`auth.ts:74-79`, `requestCredentials`): a signed-in player sends
  `Authorization: Bearer`, a guest `X-Guest-Id` — never the query string. Custom headers force a CORS
  preflight, which only `allowedOrigin` passes (`cors.ts`). `/api/me` answers `Cache-Control: no-store`
  (`index.ts:47-51`). The Worker logs neither header.
- **Handles** (`handles.ts`) are the first 80 bits of `SHA-256("games-player:" + id)`: a profile link reveals
  nothing about the guest UUID behind it, and handles are not enumerable. Public profiles are rebuilt field by
  field and drop room codes and active tables (`player.ts:250-340`).
- **Push SSRF** (`push.ts:184-215`, `validSubscription`): endpoints must be `https:` on an allowlist of the
  browsers' push services (FCM, Mozilla, Apple, WNS), ≤ 1024 chars, with a 65-byte P-256 key and a 16-byte
  auth secret. A player keeps at most 8 subscriptions (`player.ts:50`), and each kind of notification fires at
  most once per 5 minutes per room (`NOTIFY_EVERY_MS`). Payloads are RFC 8291-encrypted; the VAPID private
  key is a secret, only the public half is served. The service worker opens only `#<path>` on its own origin
  (`sw.js:128`), so a notification cannot be turned into an open redirect, and it never caches cross-origin
  (API) responses.
- **Reactions** (`room.ts:934-958`, `shared/src/protocol/reactions.ts`): a fixed set of six ids, a token
  bucket per socket (seated: burst 3, one per 1.5 s; watching: burst 2, one per 4 s), never stored.
- **Analytics** (`analytics.ts`): event name, game, a fixed detail and two numbers — no ids, handles, names,
  room codes or addresses.

## 15. Low — the guest id as an `X-Guest-Id` header

**Status (2026-10-20).** Open — check Workers Logs for recorded headers (an operational check).

**Where.** `auth.ts:74-79`; `frontend/src/online/api.ts:94-95`.

**Risk.** The Worker never logs it, but Cloudflare's own request logging (Workers Logs invocation records,
Logpush, Trace) can capture request headers, and a guest id in a log is a session anyone with log access can
replay — including taking the guest's seats and push subscriptions.

**Fix.** Check one live invocation log for `/api/me` in the dashboard; if headers are recorded, either exclude
them (Logpush field selection) or send the guest credential in a POST body instead. Longer term, exchange the
guest id once for a short-lived signed token, so the long-lived secret is sent only to that one endpoint.

## 16. Low — push delivery follows redirects and allows any port

**Status (2026-10-20).** Fixed (server, commit-ready). Push `fetch` uses `redirect: 'manual'` (a 3xx is a failure), endpoints must be https on the default port with no credentials, and the check (`deliverable`) runs again as each push leaves, for rows stored under the old rule. Test: `push.test.ts`.

**Where.** `push.ts:204` (host and scheme checked, port not); `push.ts:238` (`fetch` with the default
`redirect: 'follow'`).

**Risk.** Small: the hosts are the browser vendors' push services. But a redirect from one of them (or a
vendor host on an unusual port) would carry the Worker's POST somewhere the allowlist never approved.

**Fix.** `redirect: 'manual'` on the push `fetch` (treat 3xx as failure) and require `url.port === ''`.

## 17. Low — reaction allowance is per socket

**Status (2026-10-20).** Fixed (server, commit-ready). The reaction bucket is keyed by player id (a second tab or a reconnect shares it), cleared when the room empties. Test: `room-hardening.test.ts`.

**Where.** `room.ts` `reactionBuckets` (a `WeakMap<WebSocket, …>`) and `handleReact`.

**Exploit.** One person opens several sockets to the room (spectators up to `MAX_ROOM_SOCKETS`), or
reconnects (each new socket starts with a full bucket), and multiplies the allowance; each reaction is a
frame to every socket. Bounded by the socket limits, so a nuisance rather than a DoS.

**Fix.** Key the bucket by `player.id` (a `Map` cleared when the room empties) instead of by socket.

## 18. Low — public profiles publish opponents' handles and exact times

**Status (2026-10-20).** Fixed (server, commit-ready). Public profiles round `at` and `since` to the UTC day and drop every opponent's handle; names are kept. The owner's own `/api/me` keeps exact times and opponent links (only to people they actually played; this keeps the profile e2e's click-through working). There is still no opt-out toggle — a product decision. Test: `profiles.test.ts`.

**Where.** `room.ts` `recordFinish` (stores each opponent's `handle`), `player.ts` `profile` (public `recent`
keeps `opponents[].handle` and `at`).

**Risk.** Privacy, not access: anyone who has played you once can follow your handle from their own profile
to your full public record, including when you play (to the millisecond). Guests cannot opt out.

**Fix.** Make profiles private until the player shares their link (or a toggle), coarsen `at` to the day on
public views, and omit opponents' handles unless that opponent's profile is public.

## 19. Low — chess ratings can be farmed

**Status (2026-10-20).** Fixed (server, commit-ready). A side's rating only moves against an opponent who is signed in or a guest with ≥ 5 finished games — unless that side is still provisional, so two newcomers' first games still count — and at most 3 rated games a day against the same opponent; the rest are recorded unrated. Test: `ratings.test.ts`.

**Where.** `room.ts` `recordFinish`: a game is rated when two people played and the history has ≥ 2 plies.

**Exploit.** Open a second tab in a private window (a fresh guest id), play two plies, resign — repeat. The
throwaway identity costs nothing, so a rating can be pushed up at will.

**Fix.** Rate only games between signed-in players, or require a minimum number of moves and discount
opponents with few rated games.

## 20. Low — a joiner's name on the host's lock screen

**Status (2026-10-20).** Fixed (server, commit-ready). Names are cleaned at entry (#8) and again in `joinedMessage`; a name with nothing printable left reads "Someone joined your table". Test: `auth.test.ts`.

**Where.** `ledger.ts:67` (`joinedMessage`: `${name} joined your table`).

**Risk.** The joiner chooses those 24 characters; they appear in the host's OS notification (at most once per
5 minutes per room). With #8's bidi and control characters, that is a small spoofing/spam channel.

**Fix.** The #8 name cleaning covers it; optionally say "Someone joined your table" for guests.

---

## Checked and found sound

- **Identity.** `resolveIdentity` (`auth.ts:28-63`) requires a name, verifies Clerk tokens server-side, accepts
  only RFC 4122-shaped guest ids, and prefixes ids by source (`clerk:`, `guest:`); bots are `bot:<seat>`
  (`room.ts:607, 901`), a namespace no client can produce. Avatars only from `https://img.clerk.com/`.
- **Guest id handling** (see #7 for the one exception): generated with `crypto.randomUUID()` (`guest.ts:7`),
  never in URLs, never logged, stripped from snapshots, scrubbed from error reports.
- **Authorization.** Host-only `start`/`addBot`/`removeBot` (`room.ts:890, 918, 962`); seat ownership for
  `action`/`rematch`/`claim`; turn legality is the engine's (`adapter.apply`). Claims require the opponent to be
  disconnected for `CLAIM_WIN_AFTER_MS`.
- **Input validation.** Room creation validates game (own-property lookup, `registry.ts:30-32`), seat count,
  bot skills and options (`index.ts:72-105`). Each adapter's `validateAction` rebuilds actions field by field
  (`shared/src/*/adapter.ts`); Estate's `parseTrade` bounds seats, cash (`Number.isSafeInteger`, ≥ 0) and deed
  lists. Non-object JSON is refused (`room.ts:739`, `index.ts:36-45`).
- **Hidden information.** Prism hides other hands, the draw pile and drawn-card events per viewer; Estate and
  Wildrise zero their `seed` in `view`; shuffles and dice use `crypto.getRandomValues` (`room.ts:73-77`).
- **Room codes** come from the CSPRNG (`index.ts:109`) and live in the URL fragment, so they never reach server
  logs or `Referer`; error reports replace them with `:code`.
- **Redirects.** The only redirect is Clerk's `forceRedirectUrl={window.location.href}` (`clerkAuth.tsx:99-102`)
  — the current page, not attacker-controlled input. No other `location` assignment or `window.open`.
- **Secrets.** `.dev.vars` is git-ignored (`backend/.gitignore`); `.dev.vars.example` holds an empty
  `CLERK_SECRET_KEY`; no key-shaped strings in the tree or in `git log -p`. CI pins every action by SHA, uses
  `permissions: contents: read`, `pull_request` (not `pull_request_target`), and keeps the Cloudflare token in a
  named environment.
- **Storage growth.** Event logs are capped (Prism 60, Hearth 40, Estate 70); records expire after 24 h idle.
