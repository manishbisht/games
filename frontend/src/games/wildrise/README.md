# Wildrise

An original 3D woodland take on snakes and ladders. Open `/#/wildrise` or choose Wildrise from the game collection.

## Play

The setup offers two ways in. **Play vs bot** creates a private online room against 1–3 bot companions: choose your name and a table personality, then start. **Play online** creates or joins a room so 2–4 people play the same board from their own devices. The first player is chosen randomly either way. Click **Roll dice**, tap the physical die, or press Space; the game completes movement and passes the turn automatically.

## Online tables

A room is a Durable Object on the backend running the same reducer this folder ships, so the rules and the pacing are the ones described here — not a second implementation. Create a room from the setup, share the link, take a numbered seat, and the host starts with whoever turned up. Colours are dealt at the start, in seat order.

The one thing a seat sends is `{ kind: 'roll' }`. Everything else a turn is made of — the die landing, the token walking, a snake or ladder carrying it away, the turn passing on — is a timed beat the server holds on its own clock, so the die shows one number to the whole table at one moment. A player who drops out is rolled for until they come back, and once they have been gone two minutes anyone still at the table can carry on without them. Snakes and ladders has only the one decision in it, so a room can never sit deadlocked on an absent player.

Default rules: start off the board, exact roll to 100, shared spaces, no bonus turn for a six. The setup can disable exact finish. Landing on a ladder bottom climbs; landing on a snake head slides. Passing over either does nothing. Victory shows the winner's position, turns and ladder count, with replay and menu actions.

Drag to rotate, scroll/pinch to zoom, or use the labeled camera controls. The roll control stays visible on mobile. The server keeps turns moving while rules dialogs or background tabs are open. Sound is synthesized locally and the mute preference survives starting or replaying a match. Reduced motion shortens transitions, removes spinning/bouncing and disables confetti.

## Structure and configuration

The rules live in `shared/src/wildrise/` so the browser and the room server can run the same ones; the renderer, the React UI and the sound stay here.

- `@games/shared/wildrise/types`: JSON-serializable state and action contracts. No renderer objects, timers or callbacks in state — and no animation cursor either, which is what makes the state safe to broadcast.
- `@games/shared/wildrise/board`: all 100 serpentine spaces, snake/ladder endpoints, token palettes and `DEFAULT_RULES`. Change the route arrays to change the board.
- `@games/shared/wildrise/engine`: pure reducer and injectable random source. Guards phase transitions, commits a single roll, applies a whole walk in one action, resolves the landing and declares the winner.
- `@games/shared/wildrise/timing`: shared presentation durations, priced per square for a walk. Casual, Fast and Fun bots differ in pacing; all use the same roll function and rules.
- `shared/src/wildrise/adapter.ts`: the room's seam — seat rules, the server-thrown die, the timed beats, and what happens when a seat goes quiet.
- `online/session.ts` and `online/WildriseRoomView.tsx`: turn a room snapshot into the colours and callbacks the table already speaks.
- `scene/models.ts`: original procedural geometry, animal miniatures, artwork, die and transport curves.
- `scene/createScene.ts`: lighting, camera, interaction and state-driven animation. The renderer never decides a move, dice result or winner; its resources are disposed on navigation.
- `WildriseGame.tsx` and `components/`: setup, accessible dialogs, live text status, event history and winner UI.

The reducer can also configure starting on square 1, extra turns for sixes, blocking occupied destinations, and the number of configured snakes/ladders. These remain code options rather than a full custom-rules editor, and an online room plays the printed defaults — the only thing a host chooses is the table size. All games live in server rooms for 24 hours and can be resumed from their links. There is no offline or local play mode.

## Verify

From `frontend/`:

```sh
npx vitest run src/games/wildrise
npx playwright test tests/wildrise.spec.ts tests/wildrise-online.spec.ts
npm run build
npm run lint
```

The rules and the room adapter are tested from the repository root with `npm test -w shared`.

The repository's browser configuration uses installed Google Chrome and starts the frontend and shared test backend. Use Node 22 or newer for that backend. Wildrise requires the backend, including when playing against bots. WebGL is required for the tabletop; a failure message preserves access to text positions and turn controls.

Tests cover phase guards, the one-beat walk, both transport types, finish variants, occupancy, bonus turns, immutable/serializable state, fair dice and completed seeded games. The adapter suite covers seat rules, off-turn and wrong-phase rejection, the server-thrown die, each timed beat's action and delay, rolling for an absent seat, and rematch. Browser coverage checks bot rooms, setup choices, keyboard and mobile controls, navigation, and two browsers joining a shared board. Screenshots go to the ignored `frontend/test-results/` directory.
