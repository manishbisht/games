# Wildrise online design

Give Wildrise the same online play the other four games have: create or join a room, take a seat, and race two to four people up the board from separate devices. Wildrise shipped local-only because its rules lived in the frontend and the game was still settling; both reasons have expired. This round moves its engine into `@games/shared`, adds a server adapter, and teaches `WildriseGame.tsx` the dual local/online mode Hearth, Estate and Prism already use.

Nothing about local or AI play changes. The setup screen, the AI companions, the pace of a turn and every rule stay exactly as they are.

## Why Wildrise is the easy one

Snakes and ladders has exactly one decision: roll. Everything else a turn is made of — the die landing, the token walking, a snake or ladder carrying it away, the turn passing on — is a timed beat with no choice in it. So the wire vocabulary is a single message, and an absent player can always be played for. An online Wildrise table can never deadlock.

## Where the rules live

`frontend/src/games/wildrise/game/` splits the way every other online game's did:

| Moves to `shared/src/wildrise/` | Stays in `frontend/src/games/wildrise/` |
| --- | --- |
| `types.ts`, `board.ts`, `engine.ts`, `timing.ts`, `engine.test.ts` | `scene/`, `components/`, `WildriseGame.tsx`, `game/audio.ts`, `game/useGameClock.ts` |

`board.ts` carries `spaceCoordinates` and `PALETTES` alongside the snake and ladder tables. Those are presentation data, but Hearth's shared `board.ts` already holds `PALETTES`, `COURTS` and `piecePosition` for the same reason: one board definition, read by the renderer and the rules alike. Splitting it would buy nothing and cost a second source of truth.

`shared/package.json` gains five export entries (`./wildrise`, `./wildrise/types`, `./wildrise/board`, `./wildrise/timing`, `./wildrise/online`). Frontend imports change from `./game/x` to `@games/shared/wildrise/x`. No behavioural change comes with the move.

## One walk, one beat

Today the reducer walks the token a square at a time: `moving` phase, `STEP_DONE` every 190 ms, `motion.index` counting up inside game state. That works locally because the reducer and the renderer share a clock. Online they do not — the server would have to fire an alarm and broadcast a snapshot per square, and every square's arrival would carry its own network jitter, so the walk would stutter.

So the walk becomes one beat, the way Hearth's already is:

- `Motion` loses `index`. `Action`'s `STEP_DONE` becomes `MOVE_DONE`, which applies the whole walk at once: the player lands on `motion.to`, the reducer checks for a snake or ladder there, and the phase moves on to `transporting` or `settling`.
- `phaseDuration` returns `path.length * 190 ms` for `moving` instead of a single step's worth, so a turn takes exactly as long as it does today.
- `createScene` derives which square the token is between from elapsed time — `Math.floor(progress * path.length)` and the remainder within that step — instead of reading `motion.index`. The per-step hop, easing and landing bounce are unchanged. This is the same elapsed-driven technique the scene already uses to ride a snake's curve during `transporting`.
- `useGameClock` schedules one timeout for the walk rather than one per square, and keeps its pause-and-resume accounting.

Local play looks and times identically. Game state stops carrying an animation cursor, which is the property that makes it safe to broadcast. One visible difference: a player's number in the sidebar now updates when the walk lands rather than ticking up square by square — matching how Hearth reports a piece's progress.

## The adapter

`shared/src/wildrise/adapter.ts`, modelled on `shared/src/hearth/adapter.ts`.

```ts
id: 'wildrise', minSeats: 2, maxSeats: 4, requireFull: false
seatIds: (count) => ['p0', …, `p${count - 1}`]
```

Two to four can play, so the host starts with whoever turned up. The room compacts seats onto the played headcount before the first roll, so from `create` onwards seat `p<i>` is `state.players[i]` — the same index identity Hearth relies on.

**`create`** builds the table from the seated names, with the first player drawn from `ctx.random()` (locally that draw is `Math.random()` in `WildriseGame`). Online tables use the default rules — exact finish, shared squares, no bonus for a six, six snakes and six ladders. `validateOptions` returns `{}`; the only thing the host chooses is table size, which the room already handles as a seat count. A rules editor for online rooms is out of scope.

**`validateAction`** accepts one shape, `{ kind: 'roll' }`, declared in `shared/src/wildrise/online.ts`.

**`apply`** rejects anything but the seat whose turn it is, in phase `ready`, and then rolls the die server-side: `gameReducer(state, { type: 'ROLL', value: rollDie(ctx) })`. The die is the server's to throw, so one number lands for the whole table. It is visible on the wire the moment the roll starts — as it is locally, where the reducer sets `dice` before the animation — and there is nothing in snakes and ladders to exploit with it.

**`pending`** holds the four presentation phases on the server's clock, at the durations the local table uses, with a grace beat after the walk so the last step lands rather than cuts:

| Phase | After | Resolves with |
| --- | --- | --- |
| `rolling` | `phaseDuration(state, false)` | `DICE_SETTLED` |
| `moving` | `phaseDuration(state, false) + MOTION_GRACE_MS` | `MOVE_DONE` |
| `transporting` | `phaseDuration(state, false)` | `TRANSPORT_DONE` |
| `settling` | `phaseDuration(state, false)` | `NEXT_TURN` |

`ready` waits on a person and `won` waits on nobody, so both return `null`. The server always asks for the full-motion durations; a reduced-motion client finishes its animation early and idles, which is the safe direction.

**`view`** is the identity function — a race up a shared board has nothing to hide. **`waitingOn`** is the seat on turn unless the game is won. **`resolveAbsent`** rolls for a seat that has gone: there is no resigning from a race, and one roll is the only decision there is to settle. **`rematch`** deals a fresh table to the same seats, with a new random first player.

## Wiring a fifth game in

- `shared/src/protocol/types.ts`: `'wildrise'` joins `GameId` and `GAME_IDS`. No protocol version bump — a client that does not know the name never asks for it.
- `shared/src/online/registry.ts`: `wildrise: wildriseAdapter`.
- `frontend/src/games/catalog.ts`: `online: true` on `wildriseGame`, so `App.tsx` mounts `/wildrise/room/:code`, plus tags and description that stop saying local-only.
- `frontend/src/online/games.ts`: `minSeats: 2`, numbered seat labels (colours are dealt at the start, so a seat taken beforehand cannot promise one), and a lazily-imported `WildriseRoomView`.
- `backend/src/presence.ts`: the comment explaining that Wildrise has no online play stops being true.

## The frontend session

`frontend/src/games/wildrise/online/session.ts` translates a room snapshot into the terms the board already thinks in, mirroring Hearth's:

```ts
interface OnlineWildriseSession {
  state: GameState
  mySeat: PlayerId | null          // null for a spectator
  players: Partial<Record<PlayerId, WildriseSeatPlayer>>
  rematch: { mine: boolean; theirs: boolean }
  send: { roll(): void; rematch(): void; claim(): void }
  leave(): void
}
```

Seat `p<i>` maps to colour `PLAYER_IDS[i]`. `claimTarget(session)` returns the player a win can be claimed against right now — the table is stuck on someone who has gone, this browser holds a seat of its own, and no claim has been granted yet — or `null`. `WildriseRoomView.tsx` is the four-line adapter that memoises the session per snapshot and renders `<WildriseGame online={session} />`.

## Dual-mode WildriseGame

`WildriseGame` takes an optional `online` session and passes it to `Table`. Inside `Table`:

- `const game = online ? online.state : localState`, and `menu` is forced false online — the room's lobby has already chosen the table.
- `useGameClock` is inert online (`paused || Boolean(online)`); the server keeps every beat. The AI branches live inside that clock, and online every seat is `control: 'human'` anyway, so AI disappears with it.
- `myTurn` is `online ? online.mySeat === current.id : current.control === 'human'`, and it gates the roll button, the Space shortcut and the clickable die exactly as `isHuman` does today.
- `doRoll` sends `online.send.roll()` instead of dispatching a locally-rolled value.
- Online-only UI: `YOU` and `AWAY` badges on the player cards, a claim-win banner ticking down `CLAIM_WIN_AFTER_MS` locally while the server re-validates, `Rematch` / `Waiting for the table…` / `Accept rematch` in the victory dialog, and `Leave room` in place of Pause and Start a new adventure — a table belongs to the room, so there is nothing one player can pause or restart for everyone else. The brand button stops offering a restart.
- A latch resets the dismissed-victory flag when a rematch arrives, since online there is no local restart to clear it.
- The way in sits in the setup, alongside the local one. This shipped as a shared `PlayOptions` component rather than the per-game `OnlinePanel` call this design first sketched: `PlayOptions` wraps each game's local setup as its children and offers two tabs — **Play vs bot** (the children) and **Play online** (an `OnlinePanel`) — and Hearth, Estate, Prism and Wildrise all adopted it in the same pass. For Wildrise that also retired local hot-seat play: the local tab is you against 1–3 bots, and playing with people is what a room is for. Room creation, the invite link, seat picking and presence toasts all belong to `RoomPage` and need no Wildrise-specific work.

A spectator has `mySeat: null`, which makes `myTurn` permanently false and every control inert. That is the whole of spectator support, as it is for Hearth.

The claim banner is Wildrise's own, in `wr-` classes, rather than a component lifted out of Hearth and Prism. The three are the same twenty lines of countdown logic but each is styled to its game's own hand-built design language, and pulling them apart would mean restyling two shipped games to buy one shared file. Worth revisiting if a sixth game wants one.

## Error handling

Nothing new. The adapter answers with the protocol's existing codes — `NOT_PLAYING` once the game is won, `NOT_YOUR_TURN` off-turn, `NOT_ALLOWED` when the dice are not waiting on you — and `RoomPage` already surfaces them as toasts, along with reconnects, disconnects and expiry. A malformed action fails `validateAction` and is rejected as `BAD_MESSAGE` by the room.

## Testing

- **Engine** (`shared/src/wildrise/engine.test.ts`): the existing 15 rules tests move with the engine, updated for the single-beat walk — a walk applies in one action, both transports still fire, exact finish still refuses, state stays serializable.
- **Adapter** (`shared/src/wildrise/adapter.test.ts`, new): action validation; off-turn and wrong-phase rejection; the die coming from `ctx.random()`; each pending beat firing the right action after the right delay; `resolveAbsent` rolling for a departed seat; rematch dealing a fresh table to the same seats.
- **Session** (`frontend/src/games/wildrise/online/session.test.ts`, new): seat-to-colour mapping, spectators, the three rematch states, and every branch of `claimTarget`.
- **Browser** (`frontend/tests/wildrise-online.spec.ts`, new): two contexts create and join a room, take seats, start, and play server-paced turns until the board moves for both — waiting on UI the room has sent, never on a duration, the way `hearth-online.spec.ts` does.
- **Regression**: `frontend/tests/wildrise.spec.ts` keeps passing, including its full local match through victory — that is the guard on the walk change. Plus the existing unit suites, `tsc`, build and lint across all three workspaces.

`frontend/src/games/wildrise/README.md` and `docs/superpowers/plans/2026-09-12-wildrise.md` get their "no networking" paragraphs replaced with how an online table works.
