# Online Bots — Server Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the server play bot seats, so a bot is a seat in a room rather than something the browser simulates.

**Architecture:** `GameAdapter` gains one field, `bots: BotSupport<S> | null`, holding the skill ids a game accepts, a name generator, and a `decide` function that plays one decision. `RoomDO` already plays seats nobody is behind — `standInSeat`/`playStandIn` do it for abandoned players — so this generalises that machinery into `autoSeat`/`playAuto` rather than adding a second copy. Bot seats are ordinary `StoredSeat`s carrying `bot: { skill }` and a synthetic `PlayerInfo` with a `bot:`-prefixed id.

**Tech Stack:** TypeScript, Cloudflare Workers + Durable Objects, `@cloudflare/vitest-pool-workers`, vitest.

**Spec:** `docs/superpowers/specs/2026-09-14-online-bots-design.md`

**Scope:** This plan implements **Step 1 only** — the server foundation. It is fully tested and changes nothing a player can see. Steps 2 (bots in friends' rooms UI), 3 (solo bot rooms + deleting local mode), and 4 (chess bots) get their own plans.

## Global Constraints

- `PROTOCOL_VERSION` becomes `3`. Do not add new `ErrorCode` values — `NOT_HOST`, `ALREADY_STARTED`, `NOT_ALLOWED`, `BAD_MESSAGE` and `SEAT_TAKEN` cover every refusal here.
- Bot `PlayerInfo.id` is always `` `bot:${seat}` ``. `resolveIdentity` only ever mints `clerk:` or `guest:` ids, so this namespace is unforgeable — do not add an auth check for it.
- A room may never be all bots: `bots.length <= seats - 1`.
- Adapters stay pure functions of their state. Randomness comes from `ctx.random`, never `Math.random`.
- Default bot pause is `900ms` when an adapter does not implement `thinkMs`. `STAND_IN_DELAY_MS` (1200) stays as it is and keeps its own meaning.
- Chess gets `bots: null` in this plan. Chess bots are Step 4.
- Every comment in this codebase explains *why*, not *what*. Match that register.

---

### Task 1: The `BotSupport` contract

Adds the type and satisfies it with `null` everywhere, so the codebase compiles before any behaviour changes.

**Files:**
- Modify: `shared/src/online/adapter.ts`
- Modify: `shared/src/chess/adapter.ts`, `shared/src/hearth/adapter.ts`, `shared/src/estate/adapter.ts`, `shared/src/prism/adapter.ts`, `shared/src/wildrise/adapter.ts`
- Modify: `backend/test/alarm.test.ts:35` (`parcelAdapter`), `backend/test/alarm.test.ts:96` (`stubbornAdapter`)
- Create: `shared/src/online/bots.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `BotSupport<S>` interface; `GameAdapter.bots: BotSupport<S> | null`; `BOT_NAMES: readonly string[]` and `botName(index: number): string` from `shared/src/online/bots.ts`.

- [ ] **Step 1: Add the `BotSupport` interface and the adapter field**

In `shared/src/online/adapter.ts`, above `GameAdapter`:

```ts
/**
 * Everything a game needs to play a seat nobody is behind. `skills` is an
 * opaque id list the adapter validates, exactly as `validateOptions` is —
 * skill is not one concept across games. Chess, Hearth and Prism grade
 * strength; Estate has one bot; Wildrise's are pace, because a race has no
 * decisions to be good at. Human-readable labels are presentation and live
 * in the frontend beside `seatLabel`.
 */
export interface BotSupport<S = unknown> {
  /** Skill ids this game accepts. The first is the default. */
  skills: readonly string[]
  /** Display name for the bot taking `seat`; `index` is its position among the room's bots. */
  name(seat: SeatId, index: number): string
  /** Play one decision for a bot seat. Returns `state` unchanged when it has none to make. */
  decide(state: S, seat: SeatId, seats: SeatId[], skill: string, ctx: Ctx): S
  /** How long the room pauses before the decision lands, so a bot reads as thinking. */
  thinkMs?(skill: string): number
}
```

And inside `GameAdapter`, after `resolveAbsent`:

```ts
  /** How this game plays a seat nobody is behind; `null` when it has no bots. */
  bots: BotSupport<S> | null
```

- [ ] **Step 2: Create the shared bot name pool**

Create `shared/src/online/bots.ts`:

```ts
/**
 * Names for seats the room plays. Deliberately people-shaped and not
 * game-specific: a bot is another player at the table, and calling it
 * "Bot 2" is the fastest way to make a table feel like software.
 */
export const BOT_NAMES: readonly string[] = ['Jules', 'Cleo', 'Milo', 'Wren']

/** Cycles, so a name always comes back even past the seat counts games allow. */
export function botName(index: number): string {
  return BOT_NAMES[index % BOT_NAMES.length]
}
```

- [ ] **Step 3: Add `bots: null` to all five shipping adapters**

Add one line to each of `chess`, `hearth`, `estate`, `prism` and `wildrise` adapters, after `resolveAbsent`:

```ts
  /** Filled in by a later task; chess keeps `null` until Step 4. */
  bots: null,
```

For chess, use this comment instead, since chess's stays `null` in this plan:

```ts
  /** Chess bots land in a later round; see the online-bots design. */
  bots: null,
```

- [ ] **Step 4: Add `bots: null` to the two test adapters**

In `backend/test/alarm.test.ts`, add `bots: null,` to both `parcelAdapter` (after its `resolveAbsent`) and `stubbornAdapter` (after its `resolveAbsent`). Without this the file no longer type-checks.

- [ ] **Step 5: Verify everything still compiles and passes**

Run: `npm run typecheck -w shared && npm run typecheck -w backend && npm test -w shared && npm test -w backend`
Expected: PASS, no behaviour change.

- [ ] **Step 6: Commit**

```bash
git add shared/src/online/adapter.ts shared/src/online/bots.ts shared/src/chess/adapter.ts shared/src/hearth/adapter.ts shared/src/estate/adapter.ts shared/src/prism/adapter.ts shared/src/wildrise/adapter.ts backend/test/alarm.test.ts
git commit -m "feat(online): give adapters a seam for seats nobody is behind"
```

---

### Task 2: Hearth bots

**Files:**
- Modify: `shared/src/hearth/adapter.ts`
- Test: `shared/src/hearth/adapter.test.ts`

**Interfaces:**
- Consumes: `BotSupport`, `botName` (Task 1).
- Produces: `hearthAdapter.bots` with `skills: ['easy', 'medium', 'hard']`.

- [ ] **Step 1: Write the failing test**

Append to `shared/src/hearth/adapter.test.ts`:

```ts
describe('bots', () => {
  const ctx = { random: () => 0.5, now: 0 }
  const seats = ['p0', 'p1']

  it('rolls for a bot seat whose turn it is to roll', () => {
    const state = hearthAdapter.create(
      [{ id: 'p0', name: 'Ann' }, { id: 'p1', name: 'Cleo' }],
      {},
      ctx,
    ) as GameState
    const onRoll = { ...state, phase: 'roll' as const, currentPlayer: 1 }
    const after = hearthAdapter.bots!.decide(onRoll, 'p1', seats, 'medium', ctx)
    expect(after.phase).toBe('rolling')
  })

  it('leaves a seat alone when the game is not waiting on it', () => {
    const state = hearthAdapter.create(
      [{ id: 'p0', name: 'Ann' }, { id: 'p1', name: 'Cleo' }],
      {},
      ctx,
    ) as GameState
    const onRoll = { ...state, phase: 'roll' as const, currentPlayer: 0 }
    expect(hearthAdapter.bots!.decide(onRoll, 'p1', seats, 'medium', ctx)).toBe(onRoll)
  })

  it('offers three skills, easiest first, and names its bots', () => {
    expect(hearthAdapter.bots!.skills).toEqual(['easy', 'medium', 'hard'])
    expect(hearthAdapter.bots!.name('p1', 0)).toBe('Jules')
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -w shared -- src/hearth/adapter.test.ts -t "bots"`
Expected: FAIL — `bots` is `null`, so `bots!.decide` throws.

- [ ] **Step 3: Implement**

In `shared/src/hearth/adapter.ts`, import `botName` from `../online/bots` and replace `bots: null` with:

```ts
  /**
   * A seat the room plays. Same decisions a person makes — roll, then choose a
   * piece — which is why `resolveAbsent` below is now just this at a fixed skill.
   */
  bots: {
    skills: ['easy', 'medium', 'hard'],
    name: (_seat, index) => botName(index),
    decide(state, seat, seats, skill, ctx) {
      if (state.phase === 'won' || seatedPlayer(state, seats) !== seat) return state
      if (state.phase === 'roll') return gameReducer(state, { type: 'ROLL_START' })
      if (state.phase !== 'choose') return state
      const move = chooseAIMove(state, skill as Control, ctx.random())
      return move ? gameReducer(state, { type: 'MOVE', pieceId: move.pieceId }) : state
    },
  },
```

Add `Control` to the type import from `./types`. Then collapse `resolveAbsent` to delegate:

```ts
  /**
   * There is no resigning from a race — a player who leaves simply gets played
   * for, one decision at a time, until they come back.
   */
  resolveAbsent: (state, seat, seats, ctx) =>
    hearthAdapter.bots!.decide(state, seat, seats, STAND_IN_SKILL, ctx),
```

- [ ] **Step 4: Run the tests**

Run: `npm test -w shared -- src/hearth/adapter.test.ts`
Expected: PASS, including the pre-existing `resolveAbsent` tests, which now exercise the same code path.

- [ ] **Step 5: Commit**

```bash
git add shared/src/hearth/adapter.ts shared/src/hearth/adapter.test.ts
git commit -m "feat(hearth): let the room play a seat as a bot"
```

---

### Task 3: Prism bots

**Files:**
- Modify: `shared/src/prism/adapter.ts`
- Test: `shared/src/prism/adapter.test.ts`

**Interfaces:**
- Consumes: `BotSupport`, `botName` (Task 1).
- Produces: `prismAdapter.bots` with `skills: ['easy', 'medium', 'hard']`.

- [ ] **Step 1: Write the failing test**

Append to `shared/src/prism/adapter.test.ts`:

```ts
describe('bots', () => {
  const ctx = { random: () => 0.5, now: 0 }

  it('plays a card for the bot whose turn it is', () => {
    const seats = ['p0', 'p1']
    const state = prismAdapter.create(
      [{ id: 'p0', name: 'Ann' }, { id: 'p1', name: 'Cleo' }],
      {},
      ctx,
    ) as GameState
    const onBot = { ...state, currentPlayer: 1 }
    const after = prismAdapter.bots!.decide(onBot, 'p1', seats, 'medium', ctx)
    expect(after).not.toBe(onBot)
  })

  it("leaves a seat alone when it is not that seat's turn", () => {
    const seats = ['p0', 'p1']
    const state = prismAdapter.create(
      [{ id: 'p0', name: 'Ann' }, { id: 'p1', name: 'Cleo' }],
      {},
      ctx,
    ) as GameState
    const onHuman = { ...state, currentPlayer: 0 }
    expect(prismAdapter.bots!.decide(onHuman, 'p1', seats, 'medium', ctx)).toBe(onHuman)
  })

  it('offers three skills, easiest first', () => {
    expect(prismAdapter.bots!.skills).toEqual(['easy', 'medium', 'hard'])
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -w shared -- src/prism/adapter.test.ts -t "bots"`
Expected: FAIL — `bots` is `null`.

- [ ] **Step 3: Implement**

In `shared/src/prism/adapter.ts`, import `botName` from `../online/bots`, import `Difficulty` from `./types`, and replace `bots: null` with:

```ts
  /**
   * A seat the room plays. The policy sees only legal cards, its own hand and
   * public counts — the same information a person at that seat has.
   */
  bots: {
    skills: ['easy', 'medium', 'hard'],
    name: (_seat, index) => botName(index),
    decide(state, seat, seats, skill, ctx) {
      if (state.status !== 'playing' || seats[state.currentPlayer] !== seat) return state
      return act(state, chooseMove(state, skill as Difficulty, ctx.random), ctx.random)
    },
  },
```

Then collapse `resolveAbsent`:

```ts
  /**
   * There is no forfeiting a hand of cards — a player who leaves gets played
   * for, one decision at a time, until they come back.
   */
  resolveAbsent: (state, seat, seats, ctx) =>
    prismAdapter.bots!.decide(state, seat, seats, STAND_IN_SKILL, ctx),
```

- [ ] **Step 4: Run the tests**

Run: `npm test -w shared -- src/prism/adapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/src/prism/adapter.ts shared/src/prism/adapter.test.ts
git commit -m "feat(prism): let the room play a seat as a bot"
```

---

### Task 4: Estate bots

Estate is the one game with a single bot strength — `botAction` takes no difficulty — and the one whose `waitingOn` answers with the trade's recipient rather than the current player when a trade is pending, so a bot can owe the table a decision on someone else's turn.

**Files:**
- Modify: `shared/src/estate/adapter.ts`
- Test: `shared/src/estate/adapter.test.ts`

**Interfaces:**
- Consumes: `BotSupport`, `botName` (Task 1).
- Produces: `estateAdapter.bots` with `skills: ['standard']`.

- [ ] **Step 1: Write the failing test**

Append to `shared/src/estate/adapter.test.ts`:

```ts
describe('bots', () => {
  const ctx = { random: () => 0.5, now: 0 }
  const seats = ['p0', 'p1']
  const table = () =>
    estateAdapter.create(
      [{ id: 'p0', name: 'Ann' }, { id: 'p1', name: 'Cleo' }],
      estateAdapter.validateOptions({}),
      ctx,
    ) as GameState

  it('rolls for the bot whose turn it is', () => {
    const state = { ...table(), current: 1, phase: 'ready' as const }
    const after = estateAdapter.bots!.decide(state, 'p1', seats, 'standard', ctx)
    expect(after).not.toBe(state)
  })

  it('answers a trade aimed at a bot even while another seat is thinking', () => {
    const state = table()
    // A trade offered to p1 leaves the game waiting on p1, not on whoever offered it.
    expect(estateAdapter.waitingOn(state, seats)).toContain(seats[state.current])
  })

  it('has a single strength, since its bot has no difficulty to pick', () => {
    expect(estateAdapter.bots!.skills).toEqual(['standard'])
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -w shared -- src/estate/adapter.test.ts -t "bots"`
Expected: FAIL — `bots` is `null`.

- [ ] **Step 3: Implement**

In `shared/src/estate/adapter.ts`, import `botName` from `../online/bots` and replace `bots: null` with:

```ts
  /**
   * A seat the room plays. `skill` is inert: Estate's bot has one way of
   * playing, so the id exists only so every game answers the same question
   * the same way.
   */
  bots: {
    skills: ['standard'],
    name: (_seat, index) => botName(index),
    decide(state, seat, seats) {
      if (state.status !== 'playing') return state
      const player = seats.indexOf(seat)
      if (player < 0 || !state.players[player]) return state
      // A trade waits on its recipient, who may not be whose turn it is.
      if (state.trade)
        return state.trade.to === player
          ? gameReducer(state, {
              type: botAcceptsTrade(state, state.trade) ? 'ACCEPT_TRADE' : 'REJECT_TRADE',
            })
          : state
      if (state.current !== player) return state
      const action = botAction(asBot(state, player))
      return action ? gameReducer(state, action) : state
    },
  },
```

Then collapse `resolveAbsent`:

```ts
  resolveAbsent: (state, seat, seats, ctx) =>
    estateAdapter.bots!.decide(state, seat, seats, 'standard', ctx),
```

- [ ] **Step 4: Run the tests**

Run: `npm test -w shared -- src/estate/adapter.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/src/estate/adapter.ts shared/src/estate/adapter.test.ts
git commit -m "feat(estate): let the room play a seat as a bot"
```

---

### Task 5: Wildrise bots

Wildrise's skills are pace, not strength — a race has no decisions — so this is the task that uses `thinkMs`.

**Files:**
- Modify: `shared/src/wildrise/adapter.ts`
- Test: `shared/src/wildrise/adapter.test.ts`

**Interfaces:**
- Consumes: `BotSupport`, `botName` (Task 1).
- Produces: `wildriseAdapter.bots` with `skills: ['casual', 'fast', 'fun']` and a `thinkMs(skill)` implementation.

- [ ] **Step 1: Write the failing test**

Append to `shared/src/wildrise/adapter.test.ts`:

```ts
describe('bots', () => {
  const ctx = { random: () => 0.5, now: 0 }
  const seats = ['p0', 'p1']

  it('rolls for the bot whose turn it is', () => {
    const state = wildriseAdapter.create(
      [{ id: 'p0', name: 'Ann' }, { id: 'p1', name: 'Cleo' }],
      {},
      ctx,
    ) as GameState
    const ready = { ...state, phase: 'ready' as const, currentPlayer: 1 }
    const after = wildriseAdapter.bots!.decide(ready, 'p1', seats, 'casual', ctx)
    expect(after).not.toBe(ready)
  })

  it('sets its pace from the skill, because a race has no skill to have', () => {
    const think = wildriseAdapter.bots!.thinkMs!
    expect(think('fast')).toBeLessThan(think('casual'))
    expect(wildriseAdapter.bots!.skills).toEqual(['casual', 'fast', 'fun'])
  })
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -w shared -- src/wildrise/adapter.test.ts -t "bots"`
Expected: FAIL — `bots` is `null`.

- [ ] **Step 3: Implement**

In `shared/src/wildrise/adapter.ts`, import `botName` from `../online/bots` and replace `bots: null` with:

```ts
  /**
   * A seat the room plays. There is nothing to be good at on this board, so the
   * three "skills" are how quickly the companion takes its turn and no more.
   */
  bots: {
    skills: ['casual', 'fast', 'fun'],
    name: (_seat, index) => botName(index),
    thinkMs: (skill) => (skill === 'fast' ? 450 : skill === 'fun' ? 1100 : 900),
    decide(state, seat, seats, _skill, ctx) {
      if (state.phase !== 'ready' || seatedPlayer(state, seats) !== seat) return state
      return gameReducer(state, { type: 'ROLL', value: rollDie(ctx) })
    },
  },
```

Then collapse `resolveAbsent`:

```ts
  resolveAbsent: (state, seat, seats, ctx) =>
    wildriseAdapter.bots!.decide(state, seat, seats, 'casual', ctx),
```

- [ ] **Step 4: Run the tests**

Run: `npm test -w shared -- src/wildrise/adapter.test.ts && npm test -w shared`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add shared/src/wildrise/adapter.ts shared/src/wildrise/adapter.test.ts
git commit -m "feat(wildrise): let the room play a seat as a companion"
```

---

### Task 6: Protocol v3

**Files:**
- Modify: `shared/src/protocol/types.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PROTOCOL_VERSION = 3`; `SeatInfo.bot?: { skill: string }`; `ClientMessage` variants `{ type: 'addBot'; seat: SeatId; skill?: string }` and `{ type: 'removeBot'; seat: SeatId }`; `PublicRoomSummary.bots: number`.

- [ ] **Step 1: Make the changes**

In `shared/src/protocol/types.ts`:

```ts
export const PROTOCOL_VERSION = 3
```

Add to `SeatInfo`, after `abandoned`:

```ts
  /**
   * Nobody is behind this seat: the room plays it. Carries its skill because
   * the table should be able to say how hard a bot is trying.
   */
  bot?: { skill: string }
```

Add to `ClientMessage`:

```ts
  | { type: 'addBot'; seat: SeatId; skill?: string }
  | { type: 'removeBot'; seat: SeatId }
```

Add to `PublicRoomSummary`:

```ts
  /** How many of `seatsTaken` are bots, so the lobby can say "2 players · 1 bot". */
  bots: number
```

- [ ] **Step 2: Find every place the new `bots` field must be supplied**

Run: `npm run typecheck -w backend`
Expected: FAIL at `backend/src/room.ts` `pushLobby` and `backend/src/lobby.ts`, which build `PublicRoomSummary` values. Note the exact lines — Task 11 fills them in properly. For now, add `bots: 0` at the `pushLobby` call site so the tree compiles.

- [ ] **Step 3: Verify**

Run: `npm run typecheck -w shared && npm run typecheck -w backend && npm test -w backend`
Expected: PASS. The protocol bump is invisible to the tests, which build their join messages from `PROTOCOL_VERSION`.

- [ ] **Step 4: Commit**

```bash
git add shared/src/protocol/types.ts backend/src/room.ts
git commit -m "feat(protocol): v3 — seats the room plays, and the messages that make them"
```

---

### Task 7: Bot seats, and the room driving them

The core task. Bot seats cannot be created by any client yet, so the tests build them by patching the record directly — the same technique `alarm.test.ts`'s `stubbornGame` uses for abandonment.

**Files:**
- Modify: `backend/src/room.ts` (`StoredSeat`, `standInSeat` → `autoSeat`, `stampStandIn` → `stampAuto`, `playStandIn` → `playAuto`, `alarm`)
- Create: `backend/test/room-bots.test.ts`

**Interfaces:**
- Consumes: `BotSupport` (Task 1), the four `bots` implementations (Tasks 2–5), `SeatInfo.bot` (Task 6).
- Produces: `StoredSeat.bot?: { skill: string }`; private `autoSeat(record): { seat: SeatId; bot: boolean; skill: string } | null`; private `playAuto(record)`; `BOT_THINK_MS = 900`.

- [ ] **Step 1: Write the failing test**

Create `backend/test/room-bots.test.ts`:

```ts
import { env, runInDurableObject, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import type { Env } from '../src/env'
import type { RoomRecord } from '../src/room'
import { connect } from './helpers'

const testEnv = env as unknown as Env

const patchRecord = (code: string, patch: (record: RoomRecord) => void) =>
  runInDurableObject(testEnv.ROOM.getByName(code), async (instance, state) => {
    const record = (await state.storage.get<RoomRecord>('room'))!
    patch(record)
    await state.storage.put('room', record)
    ;(instance as unknown as { cached: RoomRecord }).cached = record
  })

const readRecord = (code: string) =>
  runInDurableObject(testEnv.ROOM.getByName(code), async (_instance, state) =>
    state.storage.get<RoomRecord>('room'),
  )

/** Backdate `autoAt` and fire, mirroring `fire()` in alarm.test.ts. */
const fire = (code: string) =>
  runInDurableObject(testEnv.ROOM.getByName(code), async (instance, state) => {
    if ((await state.storage.getAlarm()) === null) return false
    const record = await state.storage.get<RoomRecord>('room')
    if (record?.autoAt !== undefined && record.autoAt > Date.now()) {
      record.autoAt = Date.now()
      await state.storage.put('room', record)
      ;(instance as unknown as { cached: RoomRecord }).cached = record
    }
    await state.storage.deleteAlarm()
    await instance.alarm()
    return true
  })

/** A started two-seat Wildrise game whose p1 has been turned into a bot seat. */
async function botGame() {
  const guestId = crypto.randomUUID()
  const res = await SELF.fetch('https://api.test/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ game: 'wildrise', visibility: 'private', name: 'Ann', guestId, seats: 2 }),
  })
  const { code } = await res.json<{ code: string }>()
  const host = await connect(code)
  host.join('Ann', guestId)
  host.send({ type: 'sit', seat: 'p0' })
  const guest = await connect(code)
  guest.join('Ben')
  guest.send({ type: 'sit', seat: 'p1' })
  await host.waitRoom((m) => Boolean(m.snapshot.seats.p1))
  host.send({ type: 'start' })
  await host.waitRoom((m) => m.snapshot.status === 'playing')
  await patchRecord(code, (record) => {
    record.seats.p1 = {
      player: { id: 'bot:p1', name: 'Jules', isGuest: true },
      wantsRematch: false,
      bot: { skill: 'casual' },
    }
  })
  return { code, host }
}

describe('seats the room plays', () => {
  it('takes a bot seat\'s turn when the alarm comes round', async () => {
    const { code } = await botGame()
    // Hand the turn to the bot, then let the room notice it is waiting on one.
    await patchRecord(code, (record) => {
      const state = record.gameState as { currentPlayer: number; phase: string }
      state.currentPlayer = 1
      state.phase = 'ready'
      record.autoAt = Date.now()
    })
    await fire(code)
    const after = await readRecord(code)
    expect((after!.gameState as { phase: string }).phase).not.toBe('ready')
  })

  it('plays a waiting bot without waiting for the person it is also blocked on', async () => {
    const { code } = await councilGame()
    await fire(code)
    // p0 is a present human who has not voted and p1 is a bot; `waitingOn` names
    // both. The bot must move anyway — waiting for the person would deadlock the
    // table. No shipping adapter blocks on two seats today, so this stub is the
    // only thing holding that property; it is here so the rule cannot rot.
    const record = await readRecord(code)
    expect((record!.gameState as CouncilState).votes).toEqual(['p1'])
  })
})
```

The council game above is a test-only adapter, declared alongside the others near the top of the file, in the same spirit as `parcelAdapter` in `alarm.test.ts`:

```ts
import { registerAdapter } from '@games/shared/online'
import type { GameAdapter } from '@games/shared/online/adapter'
import type { GameId } from '@games/shared/protocol'

/**
 * A game blocked on every seat at once. No shipping adapter does this today —
 * each answers `waitingOn` with exactly one seat — which is precisely why the
 * stub exists: `autoSeat` scans the whole waiting list for a bot, and without
 * this nothing would hold that behaviour in place. No shipping game answers to
 * this id, so registering it here cannot reach a real room.
 */
const COUNCIL_GAME = 'council-test' as GameId

interface CouncilState {
  seats: string[]
  votes: string[]
}

const councilAdapter: GameAdapter<CouncilState, 'vote'> = {
  id: COUNCIL_GAME,
  minSeats: 2,
  maxSeats: 2,
  requireFull: true,
  seatIds: (count) => Array.from({ length: count }, (_, i) => `p${i}`),
  validateOptions: () => ({}),
  validateAction: (raw) => (raw === 'vote' ? 'vote' : null),
  create: (seats) => ({ seats: seats.map((seat) => seat.id), votes: [] }),
  apply: (state, seat) => ({ state: { ...state, votes: [...state.votes, seat] } }),
  pending: () => null,
  view: (state) => state,
  isFinished: (state) => state.votes.length >= 2,
  /** Every seat that has not voted, so two seats are waiting at the start. */
  waitingOn: (state) => state.seats.filter((seat) => !state.votes.includes(seat)),
  resolveAbsent: (state) => state,
  bots: {
    skills: ['only'],
    name: () => 'Jules',
    decide: (state, seat) =>
      state.votes.includes(seat) ? state : { ...state, votes: [...state.votes, seat] },
  },
}

registerAdapter(councilAdapter)

/** A started council game whose p1 has been turned into a bot seat. */
async function councilGame() {
  const guestId = crypto.randomUUID()
  const res = await SELF.fetch('https://api.test/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ game: COUNCIL_GAME, visibility: 'private', name: 'Ann', guestId, seats: 2 }),
  })
  const { code } = await res.json<{ code: string }>()
  const host = await connect(code)
  host.join('Ann', guestId)
  host.send({ type: 'sit', seat: 'p0' })
  const guest = await connect(code)
  guest.join('Ben')
  guest.send({ type: 'sit', seat: 'p1' })
  await host.waitRoom((m) => Boolean(m.snapshot.seats.p1))
  host.send({ type: 'start' })
  await host.waitRoom((m) => m.snapshot.status === 'playing')
  await patchRecord(code, (record) => {
    record.seats.p1 = {
      player: { id: 'bot:p1', name: 'Jules', isGuest: true },
      wantsRematch: false,
      bot: { skill: 'only' },
    }
  })
  return { code, host }
}
```

`fire()` works here even though `autoAt` is undefined: the expiry alarm is always armed, and `alarm()` treats an undefined `autoAt` as due, finds the bot via `autoSeat`, and plays it.

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -w backend -- test/room-bots.test.ts`
Expected: FAIL — `StoredSeat` has no `bot` property, so the file does not type-check, and nothing drives the seat.

- [ ] **Step 3: Add `bot` to `StoredSeat` and the snapshot**

In `backend/src/room.ts`, add to `StoredSeat`:

```ts
  /** Set when nobody is behind this seat: the room plays it, turn after turn. */
  bot?: { skill: string }
```

Add the constant beside `STAND_IN_DELAY_MS`:

```ts
/** How long the room pauses before a bot's decision lands, when its game has no opinion. */
const BOT_THINK_MS = 900
```

- [ ] **Step 4: Replace `standInSeat` with `autoSeat`**

```ts
  /**
   * The seat the room plays for, and how. A bot is always driven — the table is
   * never waiting on it in any meaningful sense. An abandoned seat keeps the
   * stricter rule: one away player among present ones is just a player the
   * others are still waiting for, so the room only stands in once every seat the
   * game is blocked on has gone.
   */
  private autoSeat(record: RoomRecord): { seat: SeatId; bot: boolean; skill: string } | null {
    if (record.status !== 'playing' || record.gameState === null) return null
    const waiting = this.adapter(record).waitingOn(record.gameState, record.seatIds)
    if (!waiting.length) return null
    // Bots first, and not only for multi-seat waits: when the single waiting seat
    // is a bot, the abandoned rule below cannot move it — a bot is never
    // `abandoned`, so `every` is false and the table would sit here forever.
    // Scanning the whole list rather than `waiting[0]` also covers an adapter that
    // blocks on several seats at once, should one ever exist.
    const bot = waiting.find((seat) => record.seats[seat]?.bot)
    if (bot) return { seat: bot, bot: true, skill: record.seats[bot]!.bot!.skill }
    if (!waiting.every((seat) => record.seats[seat]?.abandoned)) return null
    return { seat: waiting[0], bot: false, skill: '' }
  }
```

- [ ] **Step 5: Rename `stampStandIn` to `stampAuto` and give bots their own pause**

```ts
  private stampAuto(record: RoomRecord): void {
    if (this.pendingPhase(record)) return
    const next = this.autoSeat(record)
    if (!next) {
      record.autoAt = undefined
      record.standInStalls = undefined
      return
    }
    const bots = this.adapter(record).bots
    const delay = next.bot ? (bots?.thinkMs?.(next.skill) ?? BOT_THINK_MS) : STAND_IN_DELAY_MS
    record.autoAt ??= Date.now() + delay
  }
```

Update the three existing `stampStandIn(` call sites in `setGameState`, `handleJoin` and `handleClaim` to `stampAuto(`.

- [ ] **Step 6: Replace `playStandIn` with `playAuto`**

```ts
  /**
   * A seat the room plays still has to take its turns, or the table sits there
   * forever. One decision per fire: `setGameState` stamps whatever comes next and
   * the alarm comes back around for it.
   */
  private async playAuto(record: RoomRecord): Promise<void> {
    const adapter = this.adapter(record)
    const next = this.autoSeat(record)!
    const before = record.gameState
    const settled = next.bot
      ? adapter.bots!.decide(before, next.seat, record.seatIds, next.skill, this.gameCtx())
      : adapter.resolveAbsent(before, next.seat, record.seatIds, this.gameCtx())
    // `null`: nobody stands in at this game, so it ends where the absence left it.
    // Only `resolveAbsent` may say so — a bot's game is never ended by its bot.
    if (settled === null) record.status = 'finished'
    this.setGameState(record, settled ?? before)
    if (settled !== before) record.standInStalls = undefined
    else if ((record.standInStalls = (record.standInStalls ?? 0) + 1) >= MAX_STAND_IN_STALLS)
      record.autoAt = undefined
    await this.save(record)
    this.broadcast(record)
  }
```

- [ ] **Step 7: Point the alarm at the new names**

In `alarm()`, change `if (this.standInSeat(record)) return this.playStandIn(record)` to:

```ts
      if (this.autoSeat(record)) return this.playAuto(record)
```

- [ ] **Step 8: Surface the bot in the snapshot**

In `snapshot()`, replace the seat construction body so a bot never reads as an absent human:

```ts
      const isConnected = stored.bot ? true : connected.has(id)
      seats[seat] = {
        player,
        connected: isConnected,
        wantsRematch: stored.wantsRematch,
        ...(isConnected || !stored.disconnectedAt ? {} : { awaySince: stored.disconnectedAt }),
        ...(stored.abandoned ? { abandoned: true } : {}),
        ...(stored.bot ? { bot: stored.bot } : {}),
      }
```

- [ ] **Step 9: Run the tests**

Run: `npm test -w backend -- test/room-bots.test.ts && npm test -w backend`
Expected: PASS, including all of `alarm.test.ts` — the stand-in behaviour is unchanged, only renamed.

- [ ] **Step 10: Commit**

```bash
git add backend/src/room.ts backend/test/room-bots.test.ts
git commit -m "feat(room): play the seats nobody is behind"
```

---

### Task 8: The five guards

Each of these is a live defect the moment a bot seat exists. They are one task because they share a single test file and a reviewer would accept or reject them together.

**Files:**
- Modify: `backend/src/room.ts` (`handleDeparture`, `handleClaim`, `handleRematch`, `handleSit`)
- Test: `backend/test/room-bots.test.ts`

**Interfaces:**
- Consumes: everything from Task 7.
- Produces: no new exports.

- [ ] **Step 1: Write the failing tests**

Append to `backend/test/room-bots.test.ts`:

```ts
describe('a bot is not an absent human', () => {
  it('never marks a bot seat as away when someone else leaves', async () => {
    const { code, host } = await botGame()
    host.ws.close()
    // Wait for the departure to actually land rather than racing it on a timer.
    await vi.waitFor(async () => {
      const record = await readRecord(code)
      expect(record!.seats.p0?.disconnectedAt).toBeDefined()
    })
    const record = await readRecord(code)
    expect(record!.seats.p1?.disconnectedAt).toBeUndefined()
  })

  it('shows a bot as connected rather than away', async () => {
    const { code, host } = await botGame()
    // The bot seat was patched in after the last broadcast, so make the room
    // describe itself again — `playAuto` broadcasts once it has moved.
    await patchRecord(code, (record) => {
      const state = record.gameState as { currentPlayer: number; phase: string }
      state.currentPlayer = 1
      state.phase = 'ready'
      record.autoAt = Date.now()
    })
    await fire(code)
    const seen = await host.waitRoom((m) => Boolean(m.snapshot.seats.p1?.bot))
    expect(seen.snapshot.seats.p1?.connected).toBe(true)
    expect(seen.snapshot.seats.p1?.awaySince).toBeUndefined()
  })

  it('refuses a claim aimed at a bot', async () => {
    const { host } = await botGame()
    host.send({ type: 'claim' })
    await host.expectError('CLAIM_REJECTED')
  })

  it('does not wait on a bot to agree to a rematch', async () => {
    const { code, host } = await botGame()
    await patchRecord(code, (record) => {
      record.status = 'finished'
      ;(record.gameState as { phase: string }).phase = 'won'
    })
    host.send({ type: 'rematch' })
    // The only voting seat is the human, so agreeing alone starts the next game.
    await host.waitRoom((m) => m.snapshot.status === 'playing')
    const record = await readRecord(code)
    expect(record!.seats.p1?.bot).toEqual({ skill: 'casual' })
  })

  it('refuses to seat a person on a bot seat', async () => {
    // A four-seat room, so there is somewhere for a latecomer to connect at all.
    const guestId = crypto.randomUUID()
    const res = await SELF.fetch('https://api.test/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ game: 'wildrise', visibility: 'private', name: 'Ann', guestId, seats: 4 }),
    })
    const { code } = await res.json<{ code: string }>()
    const host = await connect(code)
    host.join('Ann', guestId)
    host.send({ type: 'sit', seat: 'p0' })
    await host.waitRoom((m) => m.you.seat === 'p0')
    await patchRecord(code, (record) => {
      record.seats.p1 = {
        player: { id: 'bot:p1', name: 'Jules', isGuest: true },
        wantsRematch: false,
        bot: { skill: 'casual' },
      }
    })
    const late = await connect(code)
    late.join('Cara')
    late.send({ type: 'sit', seat: 'p1' })
    await late.expectError('SEAT_TAKEN')
  })
})
```

Add `vi` to the vitest import at the top of the file: `import { describe, expect, it, vi } from 'vitest'`.

- [ ] **Step 2: Run them to confirm they fail**

Run: `npm test -w backend -- test/room-bots.test.ts -t "not an absent human"`
Expected: FAIL on the away-stamping, claim and rematch cases.

- [ ] **Step 3: Guard `handleDeparture`**

```ts
    for (const seat of record.seatIds) {
      const stored = record.seats[seat]
      // A bot has no socket to lose, so absence means nothing for it.
      if (stored && !stored.bot && !connected.has(stored.player.id) && !stored.disconnectedAt) {
        stored.disconnectedAt = Date.now()
        changed = true
      }
    }
```

- [ ] **Step 4: Guard `handleClaim`**

Change the `others` line so a bot is never a claim target:

```ts
    // A bot is never away, so there is nothing to claim against it.
    const others = record.seatIds.filter((id) => id !== seat && record.seats[id] && !record.seats[id]!.bot)
```

- [ ] **Step 5: Guard `handleRematch`**

Change the `voting` line:

```ts
    // A seat the room plays cannot ask for anything, so waiting on it would
    // strand the table forever — true of an abandoned seat and of a bot alike.
    const voting = seated.filter((s) => !record.seats[s]!.abandoned && !record.seats[s]!.bot)
```

- [ ] **Step 6: Confirm `handleSit` needs no new code**

Do not add a guard here. `handleSit` already refuses with `SEAT_TAKEN` when `occupant.player.id !== player.id`, and a bot's id is always `` `bot:${seat}` `` while a person's is always `guest:` or `clerk:` — so the comparison can never match and the seat is always refused. The test written in Step 1 is what locks that behaviour in; adding an `occupant?.bot` branch would be unreachable code.

Read the existing check to confirm it, then move on:

Run: `grep -n "SEAT_TAKEN" backend/src/room.ts`
Expected: the existing check in `handleSit` is the only one.

- [ ] **Step 7: Run the tests**

Run: `npm test -w backend`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/room.ts backend/test/room-bots.test.ts
git commit -m "fix(room): stop a bot seat reading as a player who walked out"
```

---

### Task 9: `addBot` and `removeBot`

The first way a client can make a bot exist.

**Files:**
- Modify: `backend/src/room.ts` (`webSocketMessage` switch, two new handlers)
- Test: `backend/test/room-bots.test.ts`

**Interfaces:**
- Consumes: Tasks 6–8.
- Produces: private `handleAddBot(ws, record, player, seat, skill)` and `handleRemoveBot(ws, record, player, seat)`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/test/room-bots.test.ts`:

```ts
describe('adding and removing bots', () => {
  /** An open four-seat Wildrise room with only its host seated. */
  async function openRoom() {
    const guestId = crypto.randomUUID()
    const res = await SELF.fetch('https://api.test/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ game: 'wildrise', visibility: 'private', name: 'Ann', guestId, seats: 4 }),
    })
    const { code } = await res.json<{ code: string }>()
    const host = await connect(code)
    host.join('Ann', guestId)
    host.send({ type: 'sit', seat: 'p0' })
    await host.waitRoom((m) => m.you.seat === 'p0')
    return { code, host }
  }

  it('seats a bot on an empty seat and names it', async () => {
    const { host } = await openRoom()
    host.send({ type: 'addBot', seat: 'p1', skill: 'fast' })
    const seen = await host.waitRoom((m) => Boolean(m.snapshot.seats.p1))
    expect(seen.snapshot.seats.p1?.bot).toEqual({ skill: 'fast' })
    expect(seen.snapshot.seats.p1?.player.name).toBe('Jules')
  })

  it('defaults to the first skill the game offers', async () => {
    const { host } = await openRoom()
    host.send({ type: 'addBot', seat: 'p1' })
    const seen = await host.waitRoom((m) => Boolean(m.snapshot.seats.p1))
    expect(seen.snapshot.seats.p1?.bot).toEqual({ skill: 'casual' })
  })

  it('refuses an unknown skill', async () => {
    const { host } = await openRoom()
    host.send({ type: 'addBot', seat: 'p1', skill: 'grandmaster' })
    await host.expectError('BAD_MESSAGE')
  })

  it('refuses a seat someone is already in, and an unknown seat', async () => {
    const { host } = await openRoom()
    host.send({ type: 'addBot', seat: 'p0' })
    await host.expectError('SEAT_TAKEN')
    host.send({ type: 'addBot', seat: 'p9' })
    await host.expectError('BAD_MESSAGE')
  })

  it('lets only the host add a bot', async () => {
    const { code } = await openRoom()
    const guest = await connect(code)
    guest.join('Ben')
    guest.send({ type: 'addBot', seat: 'p1' })
    await guest.expectError('NOT_HOST')
  })

  it('refuses once the game has started', async () => {
    const { code, host } = await openRoom()
    host.send({ type: 'addBot', seat: 'p1' })
    await host.waitRoom((m) => Boolean(m.snapshot.seats.p1))
    host.send({ type: 'start' })
    await host.waitRoom((m) => m.snapshot.status === 'playing')
    host.send({ type: 'addBot', seat: 'p2' })
    await host.expectError('ALREADY_STARTED')
    void code
  })

  it('removes a bot and frees its seat', async () => {
    const { host } = await openRoom()
    host.send({ type: 'addBot', seat: 'p1' })
    await host.waitRoom((m) => Boolean(m.snapshot.seats.p1))
    host.send({ type: 'removeBot', seat: 'p1' })
    await host.waitRoom((m) => !m.snapshot.seats.p1)
  })

  it('will not remove a person with removeBot', async () => {
    const { host } = await openRoom()
    host.send({ type: 'removeBot', seat: 'p0' })
    await host.expectError('NOT_ALLOWED')
  })

  it('turns a latecomer away once bots have filled the table, until one is removed', async () => {
    // The intended behaviour from the design: a bot occupies a seat for every
    // purpose, fullness included, and `removeBot` is the way back.
    const { code, host } = await openRoom()
    for (const seat of ['p1', 'p2', 'p3']) {
      host.send({ type: 'addBot', seat })
      await host.waitRoom((m) => Boolean(m.snapshot.seats[seat]))
    }
    const late = await connect(code)
    late.join('Cara')
    await late.expectError('ROOM_FULL')

    host.send({ type: 'removeBot', seat: 'p3' })
    await host.waitRoom((m) => !m.snapshot.seats.p3)
    const second = await connect(code)
    second.join('Dana')
    await second.waitRoom((m) => m.snapshot.seatIds.includes('p3'))
  })
})
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `npm test -w backend -- test/room-bots.test.ts -t "adding and removing"`
Expected: FAIL — `BAD_MESSAGE` ("Unknown message type") for every case.

- [ ] **Step 3: Route the two messages**

In `webSocketMessage`'s switch, before `default`:

```ts
      case 'addBot':
        return this.handleAddBot(ws, record, attachment.player, message.seat, message.skill)
      case 'removeBot':
        return this.handleRemoveBot(ws, record, attachment.player, message.seat)
```

- [ ] **Step 4: Implement the handlers**

Add after `handleLeaveSeat`:

```ts
  /**
   * Fill an empty seat with a player the room itself takes the turns for. Host
   * only and open only, for the same reason `start` is: a table's shape is the
   * host's to set, and it stops moving once the game does.
   */
  private async handleAddBot(
    ws: WebSocket,
    record: RoomRecord,
    player: PlayerInfo,
    seat: SeatId,
    skill: string | undefined,
  ): Promise<void> {
    if (player.id !== record.hostId)
      return this.fail(ws, 'NOT_HOST', 'Only the room creator can add a bot.')
    if (record.status !== 'open') return this.fail(ws, 'ALREADY_STARTED', 'The game has already started.')
    if (!record.seatIds.includes(seat)) return this.fail(ws, 'BAD_MESSAGE', 'Unknown seat.')
    if (record.seats[seat]) return this.fail(ws, 'SEAT_TAKEN', 'That seat is taken.')
    const bots = this.adapter(record).bots
    if (!bots) return this.fail(ws, 'NOT_ALLOWED', 'This game has no bots.')
    const chosen = skill ?? bots.skills[0]
    if (!bots.skills.includes(chosen)) return this.fail(ws, 'BAD_MESSAGE', 'Unknown bot skill.')
    const index = record.seatIds.filter((id) => record.seats[id]?.bot).length
    record.seats[seat] = {
      // `bot:` is a namespace `resolveIdentity` can never mint, so this id can
      // never arrive from a client claiming to be one.
      player: { id: `bot:${seat}`, name: bots.name(seat, index), isGuest: true },
      wantsRematch: false,
      bot: { skill: chosen },
    }
    await this.save(record)
    this.pushLobby(record)
    this.broadcast(record)
  }

  /** Give a bot's seat back, so a person who turned up late can have it. */
  private async handleRemoveBot(
    ws: WebSocket,
    record: RoomRecord,
    player: PlayerInfo,
    seat: SeatId,
  ): Promise<void> {
    if (player.id !== record.hostId)
      return this.fail(ws, 'NOT_HOST', 'Only the room creator can remove a bot.')
    if (record.status !== 'open') return this.fail(ws, 'ALREADY_STARTED', 'The game has already started.')
    if (!record.seats[seat]?.bot) return this.fail(ws, 'NOT_ALLOWED', 'That seat is not a bot.')
    delete record.seats[seat]
    await this.save(record)
    this.pushLobby(record)
    this.broadcast(record)
  }
```

- [ ] **Step 5: Run the tests**

Run: `npm test -w backend`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/room.ts backend/test/room-bots.test.ts
git commit -m "feat(room): let a host fill empty seats with bots"
```

---

### Task 10: Creating a room with bots, and starting it

**Files:**
- Modify: `backend/src/index.ts` (the `POST /api/rooms` branch)
- Modify: `backend/src/room.ts` (`RoomRecord`, `create`, `handleJoin`)
- Test: `backend/test/room-bots.test.ts`

**Interfaces:**
- Consumes: Tasks 6–9.
- Produces: `RoomRecord.autoStart?: boolean`; `RoomDO.create` input gains `bots: string[]` and `autoStart: boolean`.

- [ ] **Step 1: Write the failing tests**

Append to `backend/test/room-bots.test.ts`:

```ts
describe('rooms created with bots', () => {
  const create = (body: unknown) =>
    SELF.fetch('https://api.test/api/rooms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })

  const solo = (extra: Record<string, unknown> = {}) => ({
    game: 'wildrise',
    visibility: 'private',
    name: 'Ann',
    guestId: crypto.randomUUID(),
    seats: 4,
    bots: ['casual', 'casual', 'casual'],
    ...extra,
  })

  it('seats the bots from the end, leaving the first seat for the host', async () => {
    const res = await create(solo())
    expect(res.status).toBe(201)
    const { code } = await res.json<{ code: string }>()
    const record = await readRecord(code)
    expect(record!.seats.p0).toBeUndefined()
    expect(record!.seats.p1?.bot).toEqual({ skill: 'casual' })
    expect(record!.seats.p3?.bot).toEqual({ skill: 'casual' })
  })

  it('refuses a room with no room for a person in it', async () => {
    const res = await create(solo({ seats: 2, bots: ['casual', 'casual'] }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'unsupported bots' })
  })

  it('refuses an unknown skill and a game with no bots', async () => {
    expect((await create(solo({ bots: ['grandmaster', 'casual', 'casual'] }))).status).toBe(400)
    expect(
      (
        await create({
          game: 'chess',
          visibility: 'private',
          name: 'Ann',
          guestId: crypto.randomUUID(),
          seats: 2,
          bots: ['medium'],
        })
      ).status,
    ).toBe(400)
  })

  it('starts on its own when the host joins the last free seat', async () => {
    const body = solo({ autoStart: true })
    const res = await create(body)
    const { code } = await res.json<{ code: string }>()
    const host = await connect(code)
    host.join('Ann', (body as { guestId: string }).guestId)
    const playing = await host.waitRoom((m) => m.snapshot.status === 'playing')
    expect(playing.you.seat).toBe('p0')
    expect(playing.snapshot.seatIds).toEqual(['p0', 'p1', 'p2', 'p3'])
  })

  it('does not autostart a room that still has seats for people', async () => {
    const body = solo({ autoStart: true, bots: ['casual'] })
    const res = await create(body)
    const { code } = await res.json<{ code: string }>()
    const host = await connect(code)
    host.join('Ann', (body as { guestId: string }).guestId)
    const open = await host.waitRoom(() => true)
    expect(open.snapshot.status).toBe('open')
  })
})
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `npm test -w backend -- test/room-bots.test.ts -t "rooms created with bots"`
Expected: FAIL — `bots` is ignored at creation, so no seat is filled.

- [ ] **Step 3: Validate `bots` and `autoStart` in the router**

In `backend/src/index.ts`, after the seat-count check:

```ts
      // One skill id per bot seat. A room must keep a seat for a person, which is
      // also what stops a table of bots playing itself in a Durable Object.
      const rawBots = body.bots === undefined ? [] : body.bots
      if (
        !Array.isArray(rawBots) ||
        rawBots.length > seats - 1 ||
        rawBots.some((skill) => typeof skill !== 'string') ||
        (rawBots.length > 0 && !adapter.bots) ||
        rawBots.some((skill) => !adapter.bots!.skills.includes(skill as string))
      )
        return json({ error: 'unsupported bots' }, 400, origin)
      const bots = rawBots as string[]
      const autoStart = body.autoStart === true
```

Pass both into the `create` call: `{ code, game, visibility, host, seats, options, bots, autoStart }`.

- [ ] **Step 4: Seat the bots at creation**

In `backend/src/room.ts`, add to `RoomRecord`:

```ts
  /** Seat the host and start as soon as they arrive; only meaningful when bots fill every other seat. */
  autoStart?: boolean
```

Widen `create`'s input with `bots: string[]` and `autoStart: boolean`, and after building `record`, before `save`:

```ts
    // Bots take the seats furthest from the host, so the seats people are meant
    // to take are the ones the room offers first.
    const botSeats = record.seatIds.slice(record.seatIds.length - input.bots.length)
    botSeats.forEach((seat, index) => {
      record.seats[seat] = {
        player: { id: `bot:${seat}`, name: adapter.bots!.name(seat, index), isGuest: true },
        wantsRematch: false,
        bot: { skill: input.bots[index] },
      }
    })
    if (input.autoStart) record.autoStart = true
```

- [ ] **Step 5: Extract the start path so there is only one of it**

In `backend/src/room.ts`, move everything in `handleStart` after its guards into a new private method, so autostart and a host's `start` cannot drift apart:

```ts
  /**
   * Deal the game and tell the room. Split out of `handleStart` because a solo
   * table against bots starts itself on join, and two start paths that settled
   * seats differently would be two games.
   */
  private async startGame(record: RoomRecord): Promise<void> {
    const adapter = this.adapter(record)
    const occupied = record.seatIds.filter((seat) => record.seats[seat])
    // A room made for four that starts with three plays as a three-player game,
    // so the empty seats are dropped and the rest slide onto the ids the
    // adapter would have handed out for that headcount.
    const played = adapter.seatIds(occupied.length)
    const seats: Partial<Record<SeatId, StoredSeat>> = {}
    occupied.forEach((seat, index) => {
      seats[played[index]] = record.seats[seat]!
    })
    record.seats = seats
    record.seatIds = played
    record.status = 'playing'
    this.setGameState(
      record,
      adapter.create(
        played.map((id) => ({ id, name: record.seats[id]!.player.name })),
        record.options,
        this.gameCtx(),
      ),
    )
    await this.save(record)
    this.pushLobby(record)
    this.broadcast(record)
  }
```

`handleStart` keeps its four guards and ends with `return this.startGame(record)`.

- [ ] **Step 6: Start the room when the host takes the last seat**

In `handleJoin`, immediately before the final `this.broadcast(record)`:

```ts
    // A solo table against bots: the host is the only person expected, so there
    // is nothing to wait in a lobby for. The status test sits after
    // `resolveIdentity`'s await and `startGame` flips it synchronously, so two
    // tabs arriving together cannot both start the game.
    const free = record.seatIds.filter((id) => !record.seats[id])
    if (record.autoStart && record.status === 'open' && player.id === record.hostId && free.length === 1) {
      record.seats[free[0]] = { player, wantsRematch: false }
      return this.startGame(record)
    }
```

`ws.serializeAttachment({ player })` has already run above this point, so the socket is attached and `startGame`'s broadcast will address it correctly.

- [ ] **Step 7: Run the tests**

Run: `npm test -w backend && npm test -w shared`
Expected: PASS. `alarm.test.ts`'s "seats fewer players than the room was made for" case is the one that proves the `startGame` extraction preserved seat compaction.

- [ ] **Step 8: Commit**

```bash
git add backend/src/index.ts backend/src/room.ts backend/test/room-bots.test.ts
git commit -m "feat(api): create a room that already has its bots in it"
```

---

### Task 11: Honest lobby counts

**Files:**
- Modify: `backend/src/room.ts` (`pushLobby`)
- Test: `backend/test/lobby.test.ts`

**Interfaces:**
- Consumes: `PublicRoomSummary.bots` (Task 6).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Append to `backend/test/lobby.test.ts`:

```ts
it('says how many of a public room\'s seats are bots', async () => {
  const guestId = crypto.randomUUID()
  const res = await SELF.fetch('https://api.test/api/rooms', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      game: 'wildrise',
      visibility: 'public',
      name: 'Ann',
      guestId,
      seats: 4,
      bots: ['casual'],
    }),
  })
  const { code } = await res.json<{ code: string }>()
  const listed = await SELF.fetch('https://api.test/api/lobby?game=wildrise')
  const { rooms } = await listed.json<{ rooms: { code: string; seatsTaken: number; bots: number }[] }>()
  const room = rooms.find((entry) => entry.code === code)
  expect(room?.seatsTaken).toBe(1)
  expect(room?.bots).toBe(1)
})
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm test -w backend -- test/lobby.test.ts -t "how many"`
Expected: FAIL — `bots` is the hardcoded `0` from Task 6.

- [ ] **Step 3: Count them in `pushLobby`**

```ts
      const seatsTaken = record.seatIds.filter((seat) => record.seats[seat]).length
      // A seat a bot is in is taken, but a table of bots is not a table of
      // people — the lobby says both numbers rather than implying the wrong one.
      const bots = record.seatIds.filter((seat) => record.seats[seat]?.bot).length
```

and pass `bots` in the `lobby.upsert({ … })` call.

- [ ] **Step 4: Run the full suite**

Run: `npm test -w shared && npm test -w backend && npm run typecheck -w shared && npm run typecheck -w backend`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/room.ts backend/test/lobby.test.ts
git commit -m "feat(lobby): count bots apart from people"
```

---

## Done when

- `npm test -w shared && npm test -w backend` passes, plus both `typecheck` scripts.
- A room can be created with bots in it, a host can add and remove bots while the room is open, and the room takes those seats' turns on its alarm.
- Nothing in `frontend/` has changed. No player can reach any of this yet — that is Step 2.
