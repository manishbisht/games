# Online bots design

Bots stop being a thing the browser does. Today "Play vs bot" runs the engine locally in Hearth & Home, Estate, Prism and Wildrise, and chess has no bot mode at all — so a bot game and an online game are two different programs that happen to share an engine. This round makes the server play the bots, which collapses those two programs into one: a bot is a seat in a room, and the room plays it.

Two things come out of that, and both are in scope:

- **Solo vs bots is an online game.** Choosing "Play vs bot" creates a private room, seats you, fills the rest with bot seats, and starts. The in-browser turn loops are deleted; there is no local mode left.
- **Bots fill empty seats in a friends' room.** A host waiting on people who never turned up can add a bot to any empty seat, so a table of two can start as a table of four.

Chess gains a bot mode for the first time.

## The bot seam

Bots are the adapter's business, exactly as the rules are. `GameAdapter` gains one field:

```ts
interface BotSupport<S> {
  /** Skill ids this game accepts. The first is the default. */
  skills: readonly string[]
  /** Display name for the bot taking `seat`; `index` is its position among the room's bots, so names do not collide. */
  name(seat: SeatId, index: number): string
  /** Play one decision for a bot seat. Return `state` unchanged if it has none. */
  decide(state: S, seat: SeatId, seats: SeatId[], skill: string, ctx: Ctx): S
  /** Pause before the decision lands, so a bot reads as thinking. Per-skill, because Wildrise's skills are pace. */
  thinkMs?(skill: string): number
}

interface GameAdapter<S, A> {
  // …existing…
  /** `null` when this game has no bots. */
  bots: BotSupport<S> | null
}
```

`skills` is an opaque list of ids the adapter validates, the same contract `validateOptions` already has, because skill is not one concept across these games. Chess, Hearth and Prism take `easy | medium | hard`. Estate has a single strength — `botAction` accepts no difficulty. Wildrise's `casual | fast | fun` is pace, not strength, because a race has no decisions to be good at. Human-readable labels are presentation and stay in the frontend alongside `seatLabel`.

`decide` is not new behaviour so much as named behaviour: the `resolveAbsent` implementations in the Hearth, Estate, Prism and Wildrise adapters already are this function with `'medium'` hardcoded, and they become one-line delegations to it. Chess is the one adapter where the two genuinely differ, and it keeps both: `resolveAbsent` resigns, which is the right answer for a human who walked out of a chess game, and `decide` plays on, which is the right answer for a bot.

## The room drives them

`StoredSeat` gains `bot?: { skill: string }`, and a bot seat holds a synthetic `PlayerInfo` whose id is prefixed `bot:`. That namespace is closed by construction: `resolveIdentity` only ever mints `clerk:<sub>` or `guest:<uuid>`, so no client can present a bot's id as a credential and no auth change is needed.

`RoomDO` already plays seats nobody is behind — `standInSeat`, `playStandIn` and `STAND_IN_DELAY_MS` do it for abandoned players — so this generalises that machinery rather than adding a second copy. `standInSeat` becomes `autoSeat`, which decides who the room plays for:

```
waiting = adapter.waitingOn(state, seatIds)
a waiting bot seat                → always played
else: every waiting seat abandoned → today's stand-in rule, unchanged
```

Bots are always driven; abandoned seats keep the stricter existing rule, where one away player among present ones is just someone the table is still waiting for. Checking bots first is what makes Estate's trade work, since `waitingOn` there can be `[human, bot]` and the bot must answer while the human is still deciding. The two rules converge when both kinds of seat are waiting: the bot moves on one alarm, the abandoned seat on the next. `playStandIn` becomes `playAuto` and keeps the existing `standInStalls` counter and `MAX_STAND_IN_STALLS` backstop, which already protect against an adapter that never settles.

Pacing comes from `bots.thinkMs(skill)` (default ~900ms when a game does not implement it), separate from `STAND_IN_DELAY_MS`. It takes the skill because Wildrise's `casual | fast | fun` are pace and nothing else. Chess returns `0`, because its search is itself the pause.

A bot must never read as an absent human. Five call sites need guarding, and each is a real defect if missed:

| Site | Without a guard | Guard |
|---|---|---|
| `handleDeparture` | Stamps `disconnectedAt` on every seat with no socket, so every bot is marked away whenever anyone leaves | Skip bot seats |
| `snapshot` | Bots are absent from `connectedIds()`, so they render as disconnected | `connected: true` for bots, never emit `awaySince`, expose `bot` |
| `handleClaim` | A player could claim the win against a bot for being away | Exclude bot seats from `others` |
| `handleRematch` | `voting` waits on every non-abandoned seat, and a bot never votes, so the table hangs forever | Exclude bots from `voting`; they ride into the next game |
| `handleSit` | A joiner could take a seat the host filled deliberately | Already covered — a bot's id never equals a player's, so the existing occupant check refuses with `SEAT_TAKEN`. Needs a test, not a guard; the host clears the seat with `removeBot` |

`handleStart` needs no change. Bots are occupied seats, so `requireFull` is satisfied — chess can start with one human and one bot — and the existing `seatIds(occupied.length)` compaction already handles them. `PresenceDO` needs none either: bots send no heartbeats, so they cannot inflate the players-online counts.

## Protocol and room creation

`PROTOCOL_VERSION` goes to `3`. Older tabs already get `PROTOCOL_MISMATCH` and a refresh prompt.

```ts
SeatInfo          += bot?: { skill: string }
ClientMessage     += { type: 'addBot'; seat: SeatId; skill?: string }
                   | { type: 'removeBot'; seat: SeatId }
PublicRoomSummary += bots: number
```

No new `ErrorCode`: `NOT_HOST`, `ALREADY_STARTED` and `NOT_ALLOWED` cover every refusal, since both new messages are host-only and valid only while `status === 'open'`. `PublicRoomSummary.bots` lets the lobby say "2 players · 1 bot" rather than a misleading "3/4 taken".

A bot occupies a seat for every purpose, including fullness, so a friends' room whose empty seats were filled with bots refuses late joiners with `ROOM_FULL` until the host removes one. That is the intended behaviour — the host chose to fill the table — and `removeBot` is the way back.

`POST /api/rooms` gains two optional fields:

```ts
bots?: string[]      // one skill id per bot seat, each validated against adapter.bots.skills
autoStart?: boolean
```

Rejected unless the game has `bots`, every skill is a known id, and `bots.length <= seats - 1` so a room can never be all bots. Bot seats are taken from the end of `seatIds`, leaving the earlier ones for people: solo Wildrise is `seats: 4, bots: ['casual', 'casual', 'casual']` and the host lands on `p0`.

`autoStart` is stored on the record and acted on in `handleJoin`: when the room is still `open`, the joiner is the host, and exactly one seat is free, the room seats them and starts. It is therefore only meaningful alongside `bots.length === seats - 1`, which is the solo case; a room with two free seats simply ignores it and waits in the lobby as usual. Server-side rather than a client-side `sit` + `start` pair, so the player lands on a board instead of flickering through the waiting room, and two tabs cannot race into a double start — the `status === 'open'` test sits after the `resolveIdentity` await and the start flips it synchronously.

## The chess bot

Chess's AI lives in `frontend/src/games/chess/game/ai.ts` and is the only bot brain not already in `shared/`. It moves to `shared/src/chess/ai.ts`, exported as `./chess/ai`, taking the chess `GameState` so it can reuse `position()` — replaying the recorded line preserves the repetition counts a bare FEN loses. `chess.js` is already a `shared` dependency, so nothing new is bundled.

One substantive change: **difficulty stops being a wall clock and becomes a node budget.** The search currently bounds itself with `performance.now() > deadline`, and Workers freeze the clock during synchronous execution, so that deadline can never fire inside a Durable Object. Only the `nodes > 45000` cap would survive, and reaching it measured at 25–63 seconds. Measured throughput is ~930 nodes/sec, so today's 200/650/1600ms budgets reach roughly 200/600/1500 nodes; those become the budgets directly, and the bot plays the strength it plays now. `Math.random()` becomes `ctx.random`, which also makes the search reproducible under test.

`ai.ts`, `ai.worker.ts` and `ai.test.ts` are deleted from the frontend, with the test ported to `shared`.

At those budgets a `hard` move costs roughly 1.6s of billable Durable Object CPU, measured on Node rather than workerd. The budgets are three constants, so the plan is to measure them in the backend's `@cloudflare/vitest-pool-workers` suite before enabling `hard`. If it proves too expensive, chess bots cap at `medium` and the UI says so, rather than shipping a bot that burns a second and a half per move.

## Frontend

Deleting local mode is the largest piece of work, because the five game components are dual-mode throughout — `const state = online ? online.state : localState`, repeated the length of each file — so this collapses a ternary rather than trimming an edge.

| File | Lines | Change |
|---|---|---|
| `ChessGame.tsx` | 1,207 | Already room-only in practice; dead local code (storage, clock, difficulty) removed |
| `MonopolyGame.tsx` | 1,092 | Local turn loop and autosave removed; splits into lobby and room view |
| `HearthGame.tsx` | 847 | `localState`/`localStarted` and the `setTimeout` AI scheduler removed |
| `PrismGame.tsx` | 840 | Local AI effect removed |
| `WildriseGame.tsx` | 749 | Local roll loop removed |

Each game ends up shaped like chess already is: a lobby at the game's own path owning setup, and a room-only view behind `${path}/room/:code`. `PlayOptions` survives nearly intact — its bot branch keeps rendering the same setup children, and only the start handler changes, from beginning a local game to creating a room and navigating to it. `frontend/src/online/games.ts` gains per-game bot skill labels and a default bot count, next to the `seatLabel` config it already holds.

`monopoly/game/storage.ts` and `storage.test.ts` are deleted along with the resume UI. The room URL replaces them: a room is resumable for 24 hours by reopening its link, which is shorter than the autosave's lifetime and is the tradeoff being accepted.

The waiting room gains a host-only control: an "Add bot" affordance with a skill picker on each empty seat, and a remove control on each bot seat.

## Testing

- **shared** — a `bots.decide` test per adapter, deterministic through injected `ctx.random`; a chess node-budget test asserting a fixed position and seed yield a fixed move.
- **backend** — extends `room.test.ts` using the existing `registerAdapter` seam: a bot plays on its alarm; a bot is never stamped away; a claim cannot target a bot; a rematch does not wait on a bot's vote; bots satisfy `requireFull`; `addBot`/`removeBot` are host-only and open-only; `autoStart` starts exactly once.
- **frontend** — the `*-online.spec.ts` Playwright specs stay and gain a bot-room spec each. `chess.spec.ts` and the other local-mode specs are rewritten, since the mode they cover will not exist.

## Landing order

Four steps, each shippable alone.

1. **Server bots.** Adapter `bots` for Hearth, Estate, Prism and Wildrise; `autoSeat`/`playAuto` in `RoomDO`; the five guards; protocol v3; `addBot`/`removeBot`; `bots`/`autoStart` on room creation. Fully tested, nothing user-visible.
2. **Bots in friends' rooms.** Waiting-room UI only. Ships the smaller half of the feature without touching a local game loop.
3. **Solo bot rooms.** Setup panels create rooms; the local loops and Estate's storage come out; the five components split into lobby and room view.
4. **Chess bots.** AI to `shared` with node budgets, workerd CPU measured, the option added to `ChessLobby`.

Step 2 before step 3 is deliberate. It exercises the whole server-bot path with real players while local mode is still present as a fallback, so bad bot pacing or unaffordable Durable Object cost surfaces before the fallback is deleted.

## Out of scope

Bot difficulty that adapts to the player, bots in public matchmaking, spectating a bot game, and offline play. Offline play is not deferred but deliberately given up: every bot game now needs the network, which is the accepted cost of a single code path.
