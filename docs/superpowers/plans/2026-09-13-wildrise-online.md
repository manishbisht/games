# Wildrise online implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let two to four people play Wildrise together from separate devices, through the same rooms the other four games already use.

**Architecture:** Wildrise's rules move from `frontend/src/games/wildrise/game/` into `shared/src/wildrise/` so a Cloudflare Durable Object can run them authoritatively. A `GameAdapter` gives the room one wire action (`roll`) and holds every timed beat on the server's clock. `WildriseGame.tsx` gains the optional `online` session prop that Hearth, Estate and Prism already take, so one component serves both local and online tables.

**Tech Stack:** TypeScript, React 19, Three.js, Vitest, Playwright, Cloudflare Workers + Durable Objects. npm workspaces: `frontend`, `backend`, `shared`.

**Spec:** `docs/superpowers/specs/2026-09-13-wildrise-online-design.md`

## Global Constraints

- **Local and AI play must not change.** Same rules, same pacing, same setup screen. `frontend/tests/wildrise.spec.ts` passing unmodified is the gate on every task that touches the local game.
- **Follow Hearth.** It is the nearest sibling — dice, two to four seats, timed beats. When this plan and Hearth disagree, read `shared/src/hearth/adapter.ts` and `frontend/src/games/hearth/HearthGame.tsx` and follow Hearth.
- **The server never takes the reduced-motion pace.** `pending()` always passes `reduced: false`; a reduced-motion client finishes early and idles.
- **Wire vocabulary is one action:** `{ kind: 'roll' }`. Nothing else may be sent.
- **No protocol version bump.** `PROTOCOL_VERSION` stays `2`.
- **Never run `git add -A` or `git stash`.** The working tree holds the user's unrelated work in progress. Stage only the exact paths a step names.
- **Verification commands** (from the repo root unless stated): `npm test --workspaces --if-present`, `npm run lint -w frontend`, `npm run build -w frontend`, `npx tsc --noEmit -w shared`, and from `frontend/`: `npx playwright test tests/wildrise.spec.ts`.

---

### Task 1: Unify the walk into one beat

Wildrise's reducer currently advances the token one square per `STEP_DONE`, keeping an animation cursor (`motion.index`) inside game state. A server cannot broadcast that without firing an alarm per square. Make the walk a single action and let the renderer interpolate across it by elapsed time, the way it already rides a snake's curve during `transporting`. Local play must look and time identically.

**Files:**
- Modify: `frontend/src/games/wildrise/game/types.ts` (`Motion`, `Action`)
- Modify: `frontend/src/games/wildrise/game/engine.ts:115-141` (`STEP_DONE` case) and `:103-113` (motion literal)
- Modify: `frontend/src/games/wildrise/game/timing.ts`
- Modify: `frontend/src/games/wildrise/game/useGameClock.ts:16,26-38`
- Modify: `frontend/src/games/wildrise/scene/createScene.ts:201-213` (the `moving` branch)
- Test: `frontend/src/games/wildrise/game/engine.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Motion = { kind: 'walk' | 'snake' | 'ladder'; from: number; to: number; path: number[] }` (no `index`); `Action` member `{ type: 'MOVE_DONE' }` replacing `{ type: 'STEP_DONE' }`; `phaseDuration(state: GameState, reduced: boolean): number` now returning `190 * path.length` for `moving`.

- [ ] **Step 1: Update the failing tests first**

In `engine.test.ts`, change the `finishRoll` helper's `'STEP_DONE'` to `'MOVE_DONE'`, change the guard test's `gameReducer(game, { type: 'STEP_DONE' })` to `'MOVE_DONE'`, and replace the test named `advances one numbered square per completed step` with these two:

```ts
  it('walks the whole roll in one motion and hands the die on', () => {
    const game = gameReducer(gameReducer(createGame(), { type: 'ROLL', value: 3 }), { type: 'DICE_SETTLED' })
    expect(game.players[0].position).toBe(0)
    expect(game.motion).toEqual({ kind: 'walk', from: 0, to: 3, path: [1, 2, 3] })
    const walked = gameReducer(game, { type: 'MOVE_DONE' })
    expect(walked.players[0].position).toBe(3)
    expect(walked.phase).toBe('settling')
    expect(gameReducer(walked, { type: 'NEXT_TURN' }).currentPlayer).toBe(1)
  })
  it('paces a walk by the number of squares it covers', () => {
    const game = gameReducer(gameReducer(createGame(), { type: 'ROLL', value: 4 }), { type: 'DICE_SETTLED' })
    expect(phaseDuration(game, false)).toBe(190 * 4)
    expect(phaseDuration(game, true)).toBe(60 * 4)
  })
```

Add `import { phaseDuration } from './timing'` at the top.

- [ ] **Step 2: Run the tests and watch them fail**

Run: `cd frontend && npx vitest run src/games/wildrise`
Expected: FAIL — `MOVE_DONE` is not an `Action` member and `motion` still carries `index`.

- [ ] **Step 3: Drop the animation cursor from the state contract**

In `types.ts`:

```ts
export interface Motion {
  kind: 'walk' | 'snake' | 'ladder'
  from: number
  to: number
  path: number[]
}
```

and in `Action`, replace `| { type: 'STEP_DONE' }` with `| { type: 'MOVE_DONE' }`.

- [ ] **Step 4: Apply the whole walk in one action**

In `engine.ts`, the `DICE_SETTLED` case's motion literal loses its `index`:

```ts
        motion: {
          kind: 'walk',
          from: player.position,
          to,
          path: Array.from({ length: to - player.position }, (_, i) => player.position + i + 1),
        },
```

Replace the whole `case 'STEP_DONE'` block with:

```ts
    case 'MOVE_DONE': {
      if (state.phase !== 'moving' || !state.motion) return state
      const position = state.motion.to
      const next = {
        ...state,
        players: state.players.map((p, i) => (i === state.currentPlayer ? { ...p, position } : p)),
      }
      const ladder = state.board.ladders.find((r) => r.from === position)
      const snake = state.board.snakes.find((r) => r.from === position)
      const route = ladder || snake
      if (route) {
        const kind = ladder ? 'ladder' : 'snake'
        return log(
          { ...next, phase: 'transporting', motion: { kind, from: route.from, to: route.to, path: [] } },
          kind,
          `${player.name} ${ladder ? 'found a ladder' : 'met a snake'}! ${route.from} → ${route.to}`,
        )
      }
      return landed(log(next, 'move', `${player.name} moved to ${position}.`))
    }
```

- [ ] **Step 5: Pace the walk by its length**

In `timing.ts`, a walk now takes as long as all its squares did:

```ts
export function phaseDuration(state: GameState, reduced: boolean) {
  const control = state.players[state.currentPlayer].control
  // One beat covers the whole walk, so `moving` is priced per square it crosses.
  const steps = Math.max(1, state.motion?.path.length ?? 1)
  if (reduced)
    return { ready: 160, rolling: 180, moving: 60 * steps, transporting: 240, settling: 100, won: 0 }[
      state.phase
    ]
  const speed = control === 'fast' ? 0.55 : 1
  return (
    {
      ready: control === 'fun' ? 1100 : 700,
      rolling: 1100,
      moving: 190 * steps,
      transporting: 1650,
      settling: 650,
      won: 0,
    }[state.phase] * speed
  )
}
```

- [ ] **Step 6: Schedule one timeout per phase**

In `useGameClock.ts`, the clock key no longer needs a step index, and `moving` resolves with `MOVE_DONE`:

```ts
    const key = `${state.turn}:${state.phase}:${reduced}`
```

```ts
              type:
                state.phase === 'rolling'
                  ? 'DICE_SETTLED'
                  : state.phase === 'moving'
                    ? 'MOVE_DONE'
                    : state.phase === 'transporting'
                      ? 'TRANSPORT_DONE'
                      : 'NEXT_TURN',
```

- [ ] **Step 7: Interpolate the walk in the renderer**

In `createScene.ts`, replace the `state.phase === 'moving'` branch. `player.position` now stays at `motion.from` for the whole walk, so each step's start square comes from the path rather than from the player:

```ts
      if (active && state.phase === 'moving' && state.motion) {
        // One beat covers every square, so which two the token is between —
        // and how far along — is the renderer's to work out from the clock.
        const motion = state.motion
        const walked = progress * motion.path.length
        const step = Math.min(motion.path.length - 1, Math.floor(walked))
        const within = Math.min(1, walked - step)
        const last = step === motion.path.length - 1
        const from = step === 0 ? motion.from : motion.path[step - 1]
        token.position
          .copy(tokenPosition(from, index, step === 0))
          .lerp(tokenPosition(motion.path[step], index, last), ease(within))
        token.position.y += reduced.matches ? 0 : Math.sin(within * Math.PI) * 0.27
        const bounce =
          !reduced.matches && last && within > 0.8 ? Math.sin((within - 0.8) * Math.PI * 5) * 0.09 : 0
        token.scale.set(1 + bounce / 2, 1 - bounce, 1 + bounce / 2)
      } else if (active && state.phase === 'transporting' && state.motion) {
```

- [ ] **Step 8: Run the unit tests**

Run: `cd frontend && npx vitest run src/games/wildrise`
Expected: PASS, all rules tests including the seeded 2/3/4-player games.

- [ ] **Step 9: Prove the local game still plays and still looks right**

Run: `cd frontend && npx playwright test tests/wildrise.spec.ts`
Expected: PASS — this suite plays a complete local match through a ladder, a snake, an exact finish and victory.

Then watch a walk with your own eyes: `npm run dev` from the repo root, open `/#/wildrise`, start a two-player local game and roll. The token must hop square by square at the same pace as before, stack on its landing square, and bounce once when it arrives — not glide in one straight slide, and not teleport.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/games/wildrise/game/types.ts frontend/src/games/wildrise/game/engine.ts \
  frontend/src/games/wildrise/game/timing.ts frontend/src/games/wildrise/game/useGameClock.ts \
  frontend/src/games/wildrise/game/engine.test.ts frontend/src/games/wildrise/scene/createScene.ts
git commit -m "refactor(wildrise): walk a whole roll in one beat"
```

---

### Task 2: Move the rules into @games/shared

The server has to run these rules, so they cannot live in the frontend. This is a pure relocation — no behaviour changes.

**Files:**
- Create (by moving): `shared/src/wildrise/types.ts`, `shared/src/wildrise/board.ts`, `shared/src/wildrise/engine.ts`, `shared/src/wildrise/timing.ts`, `shared/src/wildrise/engine.test.ts`
- Delete: the same five files under `frontend/src/games/wildrise/game/`
- Modify: `shared/package.json` (exports map)
- Modify: every frontend file importing them — find them, don't guess

**Interfaces:**
- Consumes: Task 1's `Motion`, `Action` and `phaseDuration`.
- Produces: `@games/shared/wildrise` (engine: `createGame`, `gameReducer`, `rollDie`), `@games/shared/wildrise/types`, `@games/shared/wildrise/board` (`PLAYER_IDS`, `PALETTES`, `SNAKES`, `LADDERS`, `DEFAULT_RULES`, `spaceCoordinates`), `@games/shared/wildrise/timing` (`phaseDuration`).

- [ ] **Step 1: Move the five files**

```bash
mkdir -p shared/src/wildrise
git mv frontend/src/games/wildrise/game/types.ts shared/src/wildrise/types.ts
git mv frontend/src/games/wildrise/game/board.ts shared/src/wildrise/board.ts
git mv frontend/src/games/wildrise/game/engine.ts shared/src/wildrise/engine.ts
git mv frontend/src/games/wildrise/game/timing.ts shared/src/wildrise/timing.ts
git mv frontend/src/games/wildrise/game/engine.test.ts shared/src/wildrise/engine.test.ts
```

`audio.ts` and `useGameClock.ts` stay where they are — they are browser code.

- [ ] **Step 2: Publish them from the package**

In `shared/package.json`, add to `exports`, after the `prism` entries:

```json
    "./wildrise": "./src/wildrise/engine.ts",
    "./wildrise/types": "./src/wildrise/types.ts",
    "./wildrise/board": "./src/wildrise/board.ts",
    "./wildrise/timing": "./src/wildrise/timing.ts",
```

- [ ] **Step 3: Find every import that just broke**

Run: `grep -rn "game/types\|game/board\|game/engine\|game/timing\|'\./engine'\|'\./timing'\|'\./types'\|'\./board'" frontend/src/games/wildrise`

Rewrite each one to the package path — `../game/board` becomes `@games/shared/wildrise/board`, `./game/engine` becomes `@games/shared/wildrise`, and so on. Expect hits in `WildriseGame.tsx`, `components/Setup.tsx`, `components/TokenPortrait.tsx`, `scene/BoardScene.tsx`, `scene/createScene.ts`, `scene/models.ts` and `game/useGameClock.ts`; verify against the grep rather than this list. Type-only imports keep their `import type`.

- [ ] **Step 4: Run the shared unit tests in their new home**

Run: `npm test -w shared`
Expected: PASS, Wildrise's rules tests now running alongside chess, hearth, estate and prism.

- [ ] **Step 5: Typecheck and build both sides**

Run: `npx tsc --noEmit -w shared && npm run lint -w frontend && npm run build -w frontend`
Expected: clean. A `Cannot find module '@games/shared/wildrise/...'` means the exports map and the import disagree; fix the map, not the import.

- [ ] **Step 6: Prove the game still plays**

Run: `cd frontend && npx playwright test tests/wildrise.spec.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add shared/src/wildrise shared/package.json frontend/src/games/wildrise
git commit -m "refactor(wildrise): move the rules into @games/shared"
```

---

### Task 3: The Wildrise adapter

The seam between the generic room and Wildrise's rules: one wire action, four server-held beats, and a stand-in that rolls for whoever left.

**Files:**
- Create: `shared/src/wildrise/online.ts`
- Create: `shared/src/wildrise/adapter.ts`
- Test: `shared/src/wildrise/adapter.test.ts`
- Modify: `shared/src/protocol/types.ts:3,9` (`GameId`, `GAME_IDS`)
- Modify: `shared/src/online/registry.ts:1-21` (import + map entry)
- Modify: `shared/package.json` (`./wildrise/online` export)

**Interfaces:**
- Consumes: `@games/shared/wildrise` (`createGame`, `gameReducer`), `@games/shared/wildrise/timing` (`phaseDuration`), `GameAdapter`/`Ctx`/`OnlineSeat` from `../online/adapter`.
- Produces: `export type WildriseOnlineAction = { kind: 'roll' }`; `export const wildriseAdapter: GameAdapter<GameState, WildriseOnlineAction>`; `'wildrise'` as a `GameId`.

- [ ] **Step 1: Write the adapter's test**

Create `shared/src/wildrise/adapter.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import type { Ctx } from '../online/adapter'
import { wildriseAdapter } from './adapter'
import { phaseDuration } from './timing'
import type { GameState } from './types'

const SEATS = ['p0', 'p1', 'p2']
const players = [
  { id: 'p0', name: 'Ann' },
  { id: 'p1', name: 'Ben' },
  { id: 'p2', name: 'Cai' },
]
/** `0` draws the first seat and a one on the die; tests that need more say so. */
const ctx = (value = 0, now = 1_700_000_000_000): Ctx => ({ random: () => value, now })

const start = (seats = players, random = 0) => wildriseAdapter.create(seats, {}, ctx(random)) as GameState

function act(state: GameState, seat: string, action: unknown, random = 0) {
  const parsed = wildriseAdapter.validateAction(action)
  if (!parsed) throw new Error('unreadable action')
  const result = wildriseAdapter.apply(state, seat, SEATS, parsed, ctx(random))
  if ('error' in result) throw new Error(`unexpected ${result.error}`)
  return result.state
}

/** Run the timed beat the state is sitting in, the way the room's alarm would. */
function settle(state: GameState) {
  const pending = wildriseAdapter.pending(state)
  if (!pending) throw new Error(`phase ${state.phase} is not a timed beat`)
  return { afterMs: pending.afterMs, state: pending.resolve(state, ctx()) as GameState }
}

describe('wildrise adapter shape', () => {
  it('seats two to four, and does not insist on a full table', () => {
    expect(wildriseAdapter.id).toBe('wildrise')
    expect([wildriseAdapter.minSeats, wildriseAdapter.maxSeats]).toEqual([2, 4])
    expect(wildriseAdapter.requireFull).toBe(false)
    expect(wildriseAdapter.seatIds(3)).toEqual(['p0', 'p1', 'p2'])
    expect(wildriseAdapter.validateOptions({ snakeCount: 99 })).toEqual({})
  })

  it('creates a table of the right size, carrying the seat names in turn order', () => {
    const state = start()
    expect(state.players.map((p) => p.name)).toEqual(['Ann', 'Ben', 'Cai'])
    expect(state.players.map((p) => p.id)).toEqual(['red', 'blue', 'green'])
    expect(state.players.every((p) => p.control === 'human')).toBe(true)
    expect(state.phase).toBe('ready')
    expect(wildriseAdapter.isFinished(state)).toBe(false)
    // A race up a shared board has nothing to hide.
    expect(wildriseAdapter.view(state, 'p1')).toBe(state)
    // The first roll waits on a person, so there is no beat to time yet.
    expect(wildriseAdapter.pending(state)).toBeNull()
    expect(wildriseAdapter.waitingOn(state, SEATS)).toEqual(['p0'])
  })

  it('draws the first player from the room’s randomness', () => {
    expect(start(players, 0).currentPlayer).toBe(0)
    expect(start(players, 0.9).currentPlayer).toBe(2)
  })

  it('reads the one wire action and rejects everything else', () => {
    expect(wildriseAdapter.validateAction({ kind: 'roll' })).toEqual({ kind: 'roll' })
    // Anything riding along on a roll is dropped rather than carried inwards.
    expect(wildriseAdapter.validateAction({ kind: 'roll', value: 6 })).toEqual({ kind: 'roll' })
    for (const raw of [null, undefined, 'roll', 6, {}, { kind: 'move' }, { kind: 'ROLL' }])
      expect(wildriseAdapter.validateAction(raw)).toBeNull()
  })
})

describe('wildrise adapter authorization', () => {
  it('refuses a roll from a seat that is not on turn', () => {
    expect(wildriseAdapter.apply(start(), 'p1', SEATS, { kind: 'roll' }, ctx())).toEqual({
      error: 'NOT_YOUR_TURN',
      message: 'It is not your turn.',
    })
  })

  it('refuses a roll while a beat of the last turn is still running', () => {
    const rolling = act(start(), 'p0', { kind: 'roll' })
    expect(wildriseAdapter.apply(rolling, 'p0', SEATS, { kind: 'roll' }, ctx())).toEqual({
      error: 'NOT_ALLOWED',
      message: 'The die is not waiting on you right now.',
    })
  })

  it('throws the die itself rather than trusting the seat', () => {
    expect(act(start(), 'p0', { kind: 'roll' }, 0).dice).toBe(1)
    expect(act(start(), 'p0', { kind: 'roll' }, 0.99).dice).toBe(6)
  })
})

describe('wildrise adapter pacing', () => {
  it('holds each presentation beat for as long as the local table does', () => {
    const rolling = act(start(), 'p0', { kind: 'roll' }, 0.5) // a four
    expect(rolling.phase).toBe('rolling')
    const settled = settle(rolling)
    expect(settled.afterMs).toBe(phaseDuration(rolling, false))
    expect(settled.state.phase).toBe('moving')

    const walked = settle(settled.state)
    // The walk carries a beat of slack so its last step lands rather than cuts.
    expect(walked.afterMs).toBe(phaseDuration(settled.state, false) + 300)
    expect(walked.state.players[0].position).toBe(4)

    // Four is a ladder foot, so the token is carried before the turn settles.
    expect(walked.state.phase).toBe('transporting')
    const climbed = settle(walked.state)
    expect(climbed.state.players[0].position).toBe(25)
    expect(climbed.state.phase).toBe('settling')

    const passed = settle(climbed.state)
    expect(passed.state.phase).toBe('ready')
    expect(passed.state.currentPlayer).toBe(1)
  })

  it('leaves the phases that wait on people alone', () => {
    const state = start()
    expect(wildriseAdapter.pending(state)).toBeNull()
    const won = { ...state, phase: 'won', winner: 'red' } as GameState
    expect(wildriseAdapter.pending(won)).toBeNull()
    expect(wildriseAdapter.waitingOn(won, SEATS)).toEqual([])
    expect(wildriseAdapter.isFinished(won)).toBe(true)
    expect(wildriseAdapter.apply(won, 'p0', SEATS, { kind: 'roll' }, ctx())).toEqual({
      error: 'NOT_PLAYING',
      message: 'The game is already won.',
    })
  })
})

describe('wildrise adapter absence and rematch', () => {
  it('rolls for a seat that has gone, and leaves every other seat alone', () => {
    const state = start()
    expect(wildriseAdapter.resolveAbsent(state, 'p0', SEATS, ctx(0.99))).toMatchObject({
      phase: 'rolling',
      dice: 6,
    })
    // Being away is not itself a move: a seat that is not on turn has nothing outstanding.
    expect(wildriseAdapter.resolveAbsent(state, 'p1', SEATS, ctx())).toBe(state)
    const rolling = act(state, 'p0', { kind: 'roll' })
    // A beat is already running; the room's alarm will carry it, not the stand-in.
    expect(wildriseAdapter.resolveAbsent(rolling, 'p0', SEATS, ctx())).toBe(rolling)
  })

  it('deals a fresh table to the same seats', () => {
    const played = act(start(), 'p0', { kind: 'roll' })
    const { state, seatRemap } = wildriseAdapter.rematch(played, players, {}, ctx(0.5))
    const fresh = state as GameState
    expect(seatRemap).toBeUndefined()
    expect(fresh.players.map((p) => p.name)).toEqual(['Ann', 'Ben', 'Cai'])
    expect(fresh.players.every((p) => p.position === 0)).toBe(true)
    expect(fresh.phase).toBe('ready')
    expect(fresh.currentPlayer).toBe(1)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npm test -w shared`
Expected: FAIL — `./adapter` does not exist.

- [ ] **Step 3: Declare the wire vocabulary**

Create `shared/src/wildrise/online.ts`:

```ts
/**
 * The only decision a seat makes over the wire. Everything else a turn is made
 * of — the die landing, the token walking, a snake or a ladder carrying it
 * away, the turn passing on — is a timed beat the server paces for the whole
 * table (see `./adapter`). Snakes and ladders asks nothing else of a player,
 * which is why an online table can never deadlock on one.
 */
export type WildriseOnlineAction = { kind: 'roll' }
```

- [ ] **Step 4: Write the adapter**

Create `shared/src/wildrise/adapter.ts`:

```ts
import type { Ctx, GameAdapter, OnlineSeat } from '../online/adapter'
import type { SeatId } from '../protocol/types'
import { createGame, gameReducer } from './engine'
import type { WildriseOnlineAction } from './online'
import { phaseDuration } from './timing'
import type { GameState } from './types'

/** A beat of slack after the board's animation so the last step lands, not cuts. */
const MOTION_GRACE_MS = 300

/**
 * `random()` is `[0, 1)`, so the clamp is only insurance against an injected
 * source that isn't: `ROLL` ignores a value outside 1–6, which would leave the
 * game stuck in `ready` with a seat that has already spent its turn.
 */
const rollDie = (ctx: Ctx) => Math.min(6, Math.max(1, Math.floor(ctx.random() * 6) + 1))

/**
 * The room compacts its seats onto `seatIds(headcount)` before the first roll,
 * so from `create` onwards seat `p<i>` is simply `state.players[i]`.
 */
const seatedPlayer = (state: GameState, seats: SeatId[]) => seats[state.currentPlayer]

const table = (seats: OnlineSeat[], ctx: Ctx) =>
  createGame({
    playerCount: seats.length,
    names: seats.map((seat) => seat.name),
    firstPlayer: Math.floor(ctx.random() * seats.length),
  })

export const wildriseAdapter: GameAdapter<GameState, WildriseOnlineAction> = {
  id: 'wildrise',
  minSeats: 2,
  maxSeats: 4,
  /** Two to four can play, so a table starts with whoever actually turned up. */
  requireFull: false,
  seatIds: (count) => Array.from({ length: count }, (_, index) => `p${index}`),
  /** The board is the board: an online table plays the printed rules. */
  validateOptions: () => ({}),

  validateAction(raw) {
    if (!raw || typeof raw !== 'object') return null
    return (raw as { kind?: unknown }).kind === 'roll' ? { kind: 'roll' } : null
  },

  create: (seats, _options, ctx) => table(seats, ctx),

  /** The die is the server's to throw, so one number lands for the whole table. */
  apply(state, seat, seats, _action, ctx) {
    if (state.phase === 'won') return { error: 'NOT_PLAYING', message: 'The game is already won.' }
    if (seatedPlayer(state, seats) !== seat)
      return { error: 'NOT_YOUR_TURN', message: 'It is not your turn.' }
    if (state.phase !== 'ready')
      return { error: 'NOT_ALLOWED', message: 'The die is not waiting on you right now.' }
    return { state: gameReducer(state, { type: 'ROLL', value: rollDie(ctx) }) }
  },

  /**
   * The pacing core. Four of the six phases are pure presentation, and online
   * the server rather than each browser holds them — so the die lands on one
   * number for everyone, at one moment, at the speed the local table plays.
   */
  pending(state) {
    const beat = (type: 'DICE_SETTLED' | 'MOVE_DONE' | 'TRANSPORT_DONE' | 'NEXT_TURN', grace = 0) => ({
      afterMs: phaseDuration(state, false) + grace,
      resolve: (current: GameState) => gameReducer(current, { type }),
    })
    if (state.phase === 'rolling') return beat('DICE_SETTLED')
    if (state.phase === 'moving') return beat('MOVE_DONE', MOTION_GRACE_MS)
    if (state.phase === 'transporting') return beat('TRANSPORT_DONE')
    if (state.phase === 'settling') return beat('NEXT_TURN')
    // `ready` waits on a person; `won` waits on nobody.
    return null
  },

  /** A race up a shared board: every seat sees the same table. */
  view: (state) => state,
  isFinished: (state) => state.phase === 'won',

  waitingOn(state, seats) {
    const seat = state.phase === 'won' ? undefined : seatedPlayer(state, seats)
    return seat ? [seat] : []
  },

  /**
   * There is no resigning from a race, and there is only one decision in it —
   * so a player who leaves is simply rolled for, one turn at a time, until they
   * come back. Every other phase is already on the room's alarm.
   */
  resolveAbsent(state, seat, seats, ctx) {
    if (state.phase !== 'ready' || seatedPlayer(state, seats) !== seat) return state
    return gameReducer(state, { type: 'ROLL', value: rollDie(ctx) })
  },

  /** Same table, same colours: a seat in a race carries no advantage to rotate. */
  rematch: (_prev, seats, _options, ctx) => ({ state: table(seats, ctx) }),
}
```

- [ ] **Step 5: Put Wildrise on the guest list**

In `shared/src/protocol/types.ts`:

```ts
export type GameId = 'chess' | 'hearth' | 'estate' | 'prism' | 'wildrise'
```
```ts
export const GAME_IDS: readonly GameId[] = ['chess', 'hearth', 'estate', 'prism', 'wildrise']
```

In `shared/src/online/registry.ts`, add `import { wildriseAdapter } from '../wildrise/adapter'` with the other adapter imports and `wildrise: wildriseAdapter,` to the `adapters` map.

In `shared/package.json`, add `"./wildrise/online": "./src/wildrise/online.ts",` to the exports map.

- [ ] **Step 6: Run the shared and backend suites**

Run: `npm test -w shared && npm test -w backend`
Expected: PASS. The backend suite exercises the real room against the registry, so a broken adapter contract shows up there.

- [ ] **Step 7: Commit**

```bash
git add shared/src/wildrise/online.ts shared/src/wildrise/adapter.ts shared/src/wildrise/adapter.test.ts \
  shared/src/protocol/types.ts shared/src/online/registry.ts shared/package.json
git commit -m "feat(wildrise): serve a table from the room"
```

---

### Task 4: The frontend room session

Translate a room snapshot into the terms the board already thinks in: seats become colours, and the wire becomes three callbacks.

**Files:**
- Create: `frontend/src/games/wildrise/online/session.ts`
- Test: `frontend/src/games/wildrise/online/session.test.ts`

**Interfaces:**
- Consumes: `@games/shared/wildrise/board` (`PLAYER_IDS`), `@games/shared/wildrise/types` (`GameState`, `PlayerId`), `@games/shared/wildrise/online` (`WildriseOnlineAction`), `RoomApi` from `frontend/src/online/useRoom.ts`.
- Produces: `interface WildriseSeatPlayer { name: string; connected: boolean; awaySince?: number; abandoned?: boolean }`; `interface OnlineWildriseSession { state; mySeat; players; rematch; send; leave }`; `wildriseSession(snapshot, you, api, leave): OnlineWildriseSession`; `claimTarget(session): WildriseSeatPlayer | null`.

- [ ] **Step 1: Write the test**

Create `frontend/src/games/wildrise/online/session.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { createGame } from '@games/shared/wildrise'
import type { RoomSnapshot, SeatInfo, YouInfo } from '@games/shared/protocol'
import type { RoomApi } from '../../../online/useRoom'
import { claimTarget, wildriseSession } from './session'

const api = (): RoomApi => ({
  sit: vi.fn(),
  leaveSeat: vi.fn(),
  start: vi.fn(),
  action: vi.fn(),
  rematch: vi.fn(),
  claim: vi.fn(),
  dismissError: vi.fn(),
})

const seat = (name: string, over: Partial<SeatInfo> = {}): SeatInfo => ({
  player: { name, isGuest: true },
  connected: true,
  wantsRematch: false,
  ...over,
})

/** A three-seat table mid-game, with whatever the test wants true of its seats. */
function table(seats: Partial<Record<string, SeatInfo>>, you: Partial<YouInfo> = {}) {
  const snapshot: RoomSnapshot = {
    protocol: 2,
    code: 'ABC234',
    game: 'wildrise',
    visibility: 'private',
    status: 'playing',
    seatIds: ['p0', 'p1', 'p2'],
    seats,
    gameState: createGame({ playerCount: 3, names: ['Ann', 'Ben', 'Cai'] }),
  }
  const info: YouInfo = { id: 'ann', seat: 'p0', isHost: true, ...you }
  return wildriseSession(snapshot, info, api(), () => {})
}

const seated = { p0: seat('Ann'), p1: seat('Ben'), p2: seat('Cai') }

describe('wildriseSession', () => {
  it('maps seats onto the colours they were dealt, in seat order', () => {
    const session = table(seated)
    expect(session.mySeat).toBe('red')
    expect(session.players.red?.name).toBe('Ann')
    expect(session.players.blue?.name).toBe('Ben')
    expect(session.players.green?.name).toBe('Cai')
    expect(session.players.yellow).toBeUndefined()
  })

  it('gives a spectator no colour of their own', () => {
    expect(table(seated, { id: 'eve', seat: null }).mySeat).toBeNull()
  })

  it('carries a seat’s presence and abandonment through to the table', () => {
    const session = table({
      ...seated,
      p1: seat('Ben', { connected: false, awaySince: 1_700_000_000_000, abandoned: true }),
    })
    expect(session.players.blue).toEqual({
      name: 'Ben',
      connected: false,
      awaySince: 1_700_000_000_000,
      abandoned: true,
    })
    expect(session.players.red?.abandoned).toBeUndefined()
  })

  it('counts a rematch as everyone else having asked', () => {
    expect(table(seated).rematch).toEqual({ mine: false, theirs: false })
    const asked = table({
      p0: seat('Ann', { wantsRematch: true }),
      p1: seat('Ben', { wantsRematch: true }),
      p2: seat('Cai'),
    })
    // Cai has not asked, so the table has not agreed.
    expect(asked.rematch).toEqual({ mine: true, theirs: false })
    const all = table({
      p0: seat('Ann'),
      p1: seat('Ben', { wantsRematch: true }),
      p2: seat('Cai', { wantsRematch: true }),
    })
    expect(all.rematch).toEqual({ mine: false, theirs: true })
  })

  it('sends the one wire action the adapter accepts', () => {
    const snapshot: RoomSnapshot = {
      protocol: 2,
      code: 'ABC234',
      game: 'wildrise',
      visibility: 'private',
      status: 'playing',
      seatIds: ['p0', 'p1'],
      seats: { p0: seat('Ann'), p1: seat('Ben') },
      gameState: createGame({ playerCount: 2 }),
    }
    const wire = api()
    const session = wildriseSession(snapshot, { id: 'ann', seat: 'p0', isHost: true }, wire, () => {})
    session.send.roll()
    expect(wire.action).toHaveBeenCalledExactlyOnceWith({ kind: 'roll' })
  })
})

describe('claimTarget', () => {
  /** Red opens the game, so Ben in seat p1 is never the one on turn. */
  const onTurnAway = { ...seated, p0: seat('Ann', { connected: false, awaySince: 1 }) }

  it('names the away player the table is stuck on', () => {
    // Ben is at the table watching Ann's turn go unplayed.
    expect(claimTarget(table(onTurnAway, { id: 'ben', seat: 'p1' }))?.name).toBe('Ann')
  })

  it('offers nobody to a spectator, who has no seat to claim with', () => {
    expect(claimTarget(table(onTurnAway, { id: 'eve', seat: null }))).toBeNull()
  })

  it('offers nobody once the claim has already been granted', () => {
    const session = table(
      { ...seated, p0: seat('Ann', { connected: false, awaySince: 1, abandoned: true }) },
      { id: 'ben', seat: 'p1' },
    )
    // The room is rolling for Ann now; asking again would settle nothing.
    expect(claimTarget(session)).toBeNull()
  })

  it('offers nobody while the player on turn is still here, or when it is your own turn', () => {
    expect(claimTarget(table(seated, { id: 'ben', seat: 'p1' }))).toBeNull()
    // Ann is away, but it is Ann's own browser asking — she is not blocked on herself.
    expect(claimTarget(table(onTurnAway))).toBeNull()
  })

  it('offers nobody once the game has been won', () => {
    const session = table(onTurnAway, { id: 'ben', seat: 'p1' })
    const won = { ...session, state: { ...session.state, phase: 'won' as const, winner: 'red' as const } }
    expect(claimTarget(won)).toBeNull()
  })
})
```

If `toHaveBeenCalledExactlyOnceWith` is not available in this Vitest version, use `toHaveBeenCalledTimes(1)` plus `toHaveBeenCalledWith`.

- [ ] **Step 2: Run it and watch it fail**

Run: `cd frontend && npx vitest run src/games/wildrise/online`
Expected: FAIL — `./session` does not exist.

- [ ] **Step 3: Write the session**

Create `frontend/src/games/wildrise/online/session.ts`, mirroring `frontend/src/games/hearth/online/session.ts` line for line — the two games have the same seat model. The differences are the imports (`@games/shared/wildrise/*`), the type names (`WildriseSeatPlayer`, `OnlineWildriseSession`, `wildriseSession`), and `send`, which has no `move`:

```ts
    send: {
      roll: () => send({ kind: 'roll' }),
      rematch: api.rematch,
      claim: api.claim,
    },
```

`claimTarget` is Hearth's unchanged: a claim needs the table genuinely stuck on someone who has gone, a seat of this browser's own to claim with — a spectator has no standing, and the server would only answer `NOT_SEATED` — and no claim granted yet, because after one the room plays that seat and there is nothing to ask.

- [ ] **Step 4: Run the test**

Run: `cd frontend && npx vitest run src/games/wildrise/online`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/games/wildrise/online
git commit -m "feat(wildrise): read a room snapshot as a table"
```

---

### Task 5: Dual-mode WildriseGame

One component, two modes — the pattern Hearth and Prism already use. Online, the snapshot replaces the reducer, the local clock and the AI switch off, and the roll button sends instead of dispatching.

**Files:**
- Modify: `frontend/src/games/wildrise/WildriseGame.tsx`
- Modify: `frontend/src/games/wildrise/WildriseGame.css` (badge and claim-banner styles)

**Interfaces:**
- Consumes: Task 4's `OnlineWildriseSession` and `claimTarget`.
- Produces: `export default function WildriseGame({ online }: { online?: OnlineWildriseSession })`.

Read `frontend/src/games/hearth/HearthGame.tsx` alongside this task; every branch below has a working counterpart there.

- [ ] **Step 1: Thread the session down**

`WildriseGame` takes `{ online }: { online?: OnlineWildriseSession }` and passes it to `Table`, which adds `online?: OnlineWildriseSession` to its props. Key the table so an online mount is its own: `key={online ? 'online' : (match?.id ?? 'menu')}`.

- [ ] **Step 2: Let the snapshot be the state**

Inside `Table`, destructure the `menu` prop under another name, rename the reducer's state, and derive the rest:

```ts
  const [localState, dispatch] = useReducer(gameReducer, config, createGame)
  // Online the room is the only source of truth: the reducer above never runs,
  // and the table is already under way by the time this component mounts.
  const state = online ? online.state : localState
  // The room's own lobby has already set the table, so there is no menu to show.
  const menu = online ? false : menuProp
```

`Table`'s prop list changes `menu: boolean` to `menu: menuProp`; everything downstream that read `state` or `menu` keeps working, and `game` stays `menu ? preview : state`.

- [ ] **Step 3: Hand the clock to the server**

```ts
  useGameClock(state, paused || Boolean(online), reduced, dispatch)
```

The AI lives inside that clock, and online every seat is `control: 'human'`, so the AI goes with it.

- [ ] **Step 4: Gate input on the seat rather than the control**

```ts
  const current = game.players[game.currentPlayer]
  /** Whose inputs this browser may make: its own seat online, the shared one locally. */
  const myTurn = online ? online.mySeat === current.id : current.control === 'human'
  const canRoll = !paused && game.phase === 'ready' && myTurn
```

Replace the existing `isHuman` uses: the `ready` phase text becomes `myTurn ? 'Your next adventure is one roll away.' : online ? `Waiting for ${current.name} to roll…` : `${current.name} is getting ready to roll…``, and the roll button's `ready` label becomes `myTurn ? 'Roll dice' : online ? 'Waiting…' : 'AI is getting ready…'`.

- [ ] **Step 5: Send the roll instead of throwing it**

```ts
  const doRoll = useCallback(() => {
    if (!canRoll) return
    if (soundOn) unlockAudio()
    if (online) online.send.roll()
    else dispatch({ type: 'ROLL', value: rollDie() })
  }, [canRoll, soundOn, online])
```

- [ ] **Step 6: Say who is who**

In the player card's `<strong>`, after the name and the existing `<Bot />`, add the online badges:

```tsx
                          {online?.mySeat === player.id && <span className="wr-seat-badge">YOU</span>}
                          {online?.players[player.id]?.connected === false && (
                            <span className="wr-seat-badge wr-away-badge">AWAY</span>
                          )}
                          {/* Away and claimed: the room is taking their turns for them. */}
                          {online?.players[player.id]?.abandoned && (
                            <span className="wr-seat-badge">AUTO</span>
                          )}
```

- [ ] **Step 7: Offer the claim when the table is stuck**

Add a module-level component above `Table`, with `import { CLAIM_WIN_AFTER_MS } from '@games/shared/protocol'`:

```tsx
/**
 * The countdown before an away player's seat can be claimed, and the claim
 * itself. The server stamps `awaySince` and re-validates the claim, so drift
 * here only shifts what the banner says, never what the room allows.
 */
function AbandonmentNotice({
  name,
  awaySince,
  onClaim,
}: {
  name: string
  awaySince?: number
  onClaim: () => void
}) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const ticker = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(ticker)
  }, [])
  const remaining = Math.max(0, CLAIM_WIN_AFTER_MS - (now - (awaySince ?? now)))
  const seconds = Math.ceil(remaining / 1000)
  return (
    <div className="wr-abandon" role="status">
      {remaining > 0 ? (
        <span>
          {name} stepped away — the table can carry on without them in {Math.floor(seconds / 60)}:
          {String(seconds % 60).padStart(2, '0')}.
        </span>
      ) : (
        <>
          <span>{name} seems to be gone.</span>
          <button onClick={onClaim}>Carry on without them</button>
        </>
      )}
    </div>
  )
}
```

Render it from `Table`:

```tsx
      {awayBlocking && (
        <AbandonmentNotice
          name={awayBlocking.name}
          awaySince={awayBlocking.awaySince}
          onClaim={() => online?.send.claim()}
        />
      )}
```

with, above the return:

```ts
  // The player the table is stuck on, while there is still something to ask for.
  const awayBlocking = online ? claimTarget(online) : null
```

- [ ] **Step 8: A table nobody owns cannot be paused or restarted**

Online, hide the header Pause button, make the brand button inert instead of opening the restart dialog, and replace `Start a new adventure` with a `Leave room` button calling `online.leave`. Do not render the `restart` or `pause` dialogs online.

- [ ] **Step 9: Offer a rematch instead of a replay**

In the victory dialog, branch the two footer buttons:

```tsx
          {online ? (
            <>
              <button className="wr-primary" onClick={online.send.rematch} disabled={online.rematch.mine}>
                <RotateCcw size={17} />
                {online.rematch.mine
                  ? 'Waiting for the table…'
                  : online.rematch.theirs
                    ? 'Accept rematch'
                    : 'Rematch'}
              </button>
              <button className="wr-secondary" onClick={online.leave}>
                Leave room
              </button>
            </>
          ) : (
            /* the existing Play again / Return to menu pair */
          )}
```

- [ ] **Step 10: Let a rematch clear the last result**

Online there is no local restart to reset `dismissedVictory`, so the arrival of a fresh state has to do it:

```ts
  // Online every fresh game shows its own result — a rematch arrives as a new
  // state rather than through the local restart that would have cleared this.
  const [wasWon, setWasWon] = useState(game.phase === 'won')
  if (online && wasWon !== (game.phase === 'won')) {
    setWasWon(game.phase === 'won')
    if (game.phase !== 'won') setDismissedVictory(false)
  }
```

- [ ] **Step 11: Offer the room from the setup sidebar**

In the `menu` branch of the sidebar, directly after `<Setup … />`:

```tsx
              {!online && (
                <OnlinePanel game="wildrise" basePath={wildriseGame.path} seatChoices={[2, 3, 4]} />
              )}
```

with `import OnlinePanel from '../../online/OnlinePanel'` and `import { wildriseGame } from '../catalog'`. (`!online` is belt and braces — the menu never renders online — but it matches Hearth and states the intent.)

- [ ] **Step 12: Style the new pieces**

Add `.wr-seat-badge`, `.wr-away-badge` and `.wr-abandon` to `WildriseGame.css`, in Wildrise's own woodland palette. Read `.hh-ai-badge`, `.hh-away-badge` and `.hh-abandon` in `HearthGame.css` for the shape — a fixed centred pill at `bottom: 20px`, `z-index: 60` for the banner — then use Wildrise's colours and radii rather than Hearth's.

- [ ] **Step 13: Typecheck, lint, and prove local play is untouched**

Run: `npm run lint -w frontend && npm run build -w frontend && cd frontend && npx playwright test tests/wildrise.spec.ts`
Expected: PASS on all three.

- [ ] **Step 14: Commit**

```bash
git add frontend/src/games/wildrise/WildriseGame.tsx frontend/src/games/wildrise/WildriseGame.css
git commit -m "feat(wildrise): play a room from the same table"
```

---

### Task 6: Wire the room up end to end

The last few lines that make `/wildrise/room/:code` a real address, proved by two browsers playing through it.

**Files:**
- Create: `frontend/src/games/wildrise/online/WildriseRoomView.tsx`
- Modify: `frontend/src/online/games.ts:39-66` (`CONFIGS`)
- Modify: `frontend/src/games/catalog.ts:79-91` (`wildriseGame`)
- Modify: `backend/src/presence.ts:7-9` (the comment)
- Test: `frontend/tests/wildrise-online.spec.ts`

**Interfaces:**
- Consumes: Task 4's `wildriseSession`, Task 5's `WildriseGame` online prop, `RoomViewProps` from `frontend/src/online/games.ts`.
- Produces: `/wildrise/room/:code` as a live route.

- [ ] **Step 1: Write the room view**

Create `frontend/src/games/wildrise/online/WildriseRoomView.tsx`:

```tsx
import { useMemo } from 'react'
import type { RoomViewProps } from '../../../online/games'
import WildriseGame from '../WildriseGame'
import { wildriseSession } from './session'

/** Wildrise's half of a room: the room's snapshot becomes the table's session. */
export default function WildriseRoomView({ snapshot, you, api, leave }: RoomViewProps) {
  const session = useMemo(
    () => wildriseSession(snapshot, you, api, leave),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snapshot, you, api],
  )
  return <WildriseGame online={session} />
}
```

- [ ] **Step 2: Register the room config**

In `frontend/src/online/games.ts`, add to `CONFIGS`:

```ts
  wildrise: {
    minSeats: 2,
    // Colours are handed out at the start, once the room knows who turned up, so
    // a seat taken beforehand cannot promise one.
    seatLabel: (_seat, index) => `Take seat ${index + 1}`,
    RoomView: lazy(() => import('../games/wildrise/online/WildriseRoomView')),
  },
```

- [ ] **Step 3: Open the route and tell the truth on the home page**

In `frontend/src/games/catalog.ts`, `wildriseGame` gains `online: true,` before its `Component`, and its `tags` stop saying local-only:

```ts
  tags: ['Snakes & ladders', 'Local, AI & online'],
```

Extend the description's last sentence to mention playing together — keep the voice of the other entries.

- [ ] **Step 4: Correct the presence comment**

`backend/src/presence.ts` says Wildrise "has no online play". Rewrite the comment so it still explains why presence keys on catalog ids rather than `GameId` — because it counts page visitors, not players — without the stale claim.

- [ ] **Step 5: Write the browser test**

Create `frontend/tests/wildrise-online.spec.ts`, modelled on `frontend/tests/hearth-online.spec.ts`. Wildrise is the simpler game: every turn is one click, and there is never a choice to make. Two contexts, `reducedMotion: 'reduce'`, collecting `pageerror`s into an array asserted empty at the end.

**Selector gotcha, read before writing:** the roll button carries a fixed `aria-label="Roll dice"`, so `getByRole('button', { name: 'Roll dice' })` matches it in every phase and cannot tell your turn from theirs. Assert on its text instead — `page.locator('.wr-roll')` — which is where the turn state actually shows (`Roll dice`, `Waiting…`, `Rolling…`, `On the move…`, `Climbing…`, `Sliding…`, `Passing the die…`).

Useful anchors: the turn heading is an `h1` reading `Ann’s turn.` (note the typographic apostrophe); player cards are `[data-testid="wildrise-player-red"]` and friends, each showing its position; the board is `.wr-canvas canvas`; the room lobby's controls are `Your name`, `Table size` → `2`, `Create room`, `Take seat 1`, `Take seat 2`, `Start the game`.

The flow:

1. Host opens `/#/wildrise`, fills `Your name` with `Ann`, picks table size `2`, clicks `Create room`; assert the URL matches `/#\/wildrise\/room\/[A-Z2-9]{6}$/` and capture the code.
2. Guest opens `/#/wildrise/room/<code>`, fills the name prompt with `Ben`, joins; assert the `Room <code>` heading on both.
3. Host takes seat 1, guest takes seat 2; assert the host's `Take seat 2` button shows `Ben` — only the broadcast snapshot could have told it.
4. Host clicks `Start the game`. Both assert `.wr-canvas canvas` is visible and that the player cards carry `Ann` and `Ben` rather than `Red` and `Blue`.
5. A `takeTurn(page)` helper: wait for `.wr-roll` to read `Roll dice` and be enabled, click it, wait for it to stop reading `Roll dice`, then wait for the table to come back to rest (`Roll dice` or `Waiting…`). Never wait on a duration — the server owns every beat, and how long a walk takes depends on the die.
6. Alternate `takeTurn` between the two pages for several turns, then assert both pages report the same turn number in `.wr-table-badge` and the same position for the same player card.
7. Assert both error arrays are empty.

- [ ] **Step 6: Run the whole verification set**

Run from the repo root:

```bash
npm test --workspaces --if-present && npm run lint -w frontend && npm run build -w frontend
```

Then from `frontend/`:

```bash
npx playwright test tests/wildrise.spec.ts tests/wildrise-online.spec.ts tests/routing.spec.ts tests/players-online-home.spec.ts
```

Expected: all PASS. `routing.spec.ts` covers the catalog entry; `players-online-home.spec.ts` touches the Wildrise card.

- [ ] **Step 7: Play it yourself**

`npm run dev` at the root starts the frontend; `npm run dev -w backend` starts the room server. Open `/#/wildrise` in two windows, create a room in one, join from the other, seat both, start, and play several turns. Watch for: the die showing the same number on both screens at the same moment, the token walking rather than teleporting, a ladder or snake animating on both sides, and the turn passing without either window getting stuck.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/games/wildrise/online/WildriseRoomView.tsx frontend/src/online/games.ts \
  frontend/src/games/catalog.ts backend/src/presence.ts frontend/tests/wildrise-online.spec.ts
git commit -m "feat(wildrise): open the room to two to four players"
```

---

### Task 7: Documentation

**Files:**
- Modify: `frontend/src/games/wildrise/README.md`
- Modify: `docs/superpowers/plans/2026-09-12-wildrise.md`

- [ ] **Step 1: Update the Wildrise README**

Three things are now wrong in it:

- The structure list points at `game/types.ts`, `game/board.ts`, `game/engine.ts` and `game/timing.ts`. They live in `shared/src/wildrise/` now; `game/audio.ts` and `game/useGameClock.ts` stayed.
- `game/engine.ts` no longer "advances one square per step" — it walks a whole roll in one action and the renderer paces it.
- "There is no Wildrise networking" is false. Replace that sentence with how an online table works: create or join a room from the setup sidebar, two to four seats, the server throws the die and holds every beat, an absent player is rolled for, and a stuck table can be claimed.

Add the online suites to the Verify section: `npm test -w shared` for the rules and adapter, and `npx playwright test tests/wildrise-online.spec.ts`.

- [ ] **Step 2: Close out the original Wildrise plan**

`docs/superpowers/plans/2026-09-12-wildrise.md` ends with "Custom networking … remain deferred as requested." Add a short line under the verification section recording that online play landed on 2026-09-13 and pointing at this plan and its spec. Leave the original tasks and their verification notes as they are — that record is still true.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/games/wildrise/README.md docs/superpowers/plans/2026-09-12-wildrise.md
git commit -m "docs(wildrise): describe the online table"
```
