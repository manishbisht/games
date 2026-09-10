# Hearth & Home implementation plan

**Goal:** Build the user's complete playable 3D Ludo-inspired game, then add animation, sound, AI and custom rules.

**Architecture:** An immutable TypeScript reducer owns rules, phases, legal moves, statistics and animation descriptions. React owns controls and scheduling. Three.js renders state and reports piece selection; it never decides game rules.

**Stack:** Existing React 19, TypeScript, Three.js, Lucide, Vitest and Playwright. New game at `/#/Ludo`, existing Estate preserved at `/#/Monopoly`.

**Visual design:** Original Hearth & Home branding, cream editorial interface, dark walnut slab, raised ivory perimeter board, lacquer miniature tokens, brass details, four colored garden courts, star safe tiles and four radial home lanes.

## Rules contract

- Two to four players, four pieces in Classic and two in Quick. Human and optional AI controls.
- Perimeter has 52 spaces. Pieces have relative progress -1 in nest, 0–51 on shared track, 52–56 in their private lane, 57 home.
- Red, blue, green and yellow entries are offsets 7, 20, 33 and 46. Safe spaces are entries and corners.
- Six enters a piece or advances one already out; six grants another roll by default, even with no legal move. No three-sixes penalty.
- Shared occupation never blocks passing. Capturing returns all opponents on an unprotected destination to their nests. Safe spaces allow peaceful mixed-color occupation.
- Home normally requires an exact roll. Win after every active piece reaches home.
- Custom rules expose player/piece count, extra turn on six, protection, capture and exact home.
- No network multiplayer in this milestone, per the user's development priority. Local pass-and-play and AI are playable.

## Implementation sequence

- [x] Add rule regression tests for entry, turns, legal moves, capture, safe spaces, home, victory, configuration and illegal actions; watch them fail.
- [x] Implement `src/games/hearth/game/types.ts`, `board.ts`, `engine.ts`; run engine tests.
- [x] Build `scene/models.ts`, `createScene.ts`, `BoardScene.tsx`: physical board, tokens, die, raycasting, camera and disposal.
- [x] Build `HearthGame.tsx`, `components/SetupPanel.tsx`, `components/RulesDialog.tsx`, `HearthGame.css`: setup, turn controls, accessible piece buttons, player progress, feed and winner UI. Integrate `/Ludo` route.
- [x] Add procedural movement, capture/home/victory particles, dice throw, reduced-motion support and optional synthesized audio.
- [x] Add tested Easy/Medium/Hard AI, Quick and Custom settings, then visual polish.
- [x] Run unit tests, TypeScript production build and lint. Browser-test human rolls and selection, mobile setup, all-AI completion, camera and existing game route. Inspect desktop/mobile screenshots.

## Verification commands

`npm test`, `npm run build`, `npm run lint`, `npm run test:e2e` (starts or reuses Vite on port 5173).

## Verification result

Verified September 9, 2026: 60 unit tests and 16 Chrome browser tests passed; TypeScript production build and ESLint passed. Desktop setup/play, mobile setup/play and victory screenshots were inspected. Independent review findings about suspended animation timing, lane-arrow orientation, Medium AI variety and move descriptions were addressed. Networking and saved Hearth sessions remain explicitly outside this milestone.
