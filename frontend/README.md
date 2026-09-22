# Games

A React frontend for original 3D tabletop games, using React, TypeScript, Three.js and React Router's `HashRouter`.

## Routes

- `/` or `/#/`: browse the homepage and choose a game.
- `/#/hearth-and-home`: play **Hearth & Home**, the Ludo-inspired game.
- `/#/estate`: play **Estate**, the property game.
- `/#/chess`: play **Gambit**, the 3D chess game. `/#/Gambit` redirects here.
- `/#/prism`: play **Prism**, the 3D color-matching card game. `/#/uno` and `/#/Prism` redirect here.
- `/#/wildrise`: play **Wildrise**, the snakes-and-ladders game. `/#/snakes-and-ladders` and `/#/SnakesAndLadders` redirect here.
- `/#/Ludo` and `/#/Hearth` redirect to `/#/hearth-and-home`; `/#/Monopoly` redirects to `/#/estate`, so existing bookmarks keep working.
- Unknown hash routes return to the homepage. Every game includes an **All games** link back to the collection.

The route path is `/hearth-and-home` or `/estate`; `HashRouter` adds the `#` in the browser URL. Hash routes support direct links and refreshes without requiring server-side route rewrites. Page titles, descriptions, and favicons follow the active game.

The **Appearance** control on the collection, game menus, and room headers offers **System**, **Light**, and **Dark**. System follows the device setting; an explicit choice persists across games and reloads and syncs between tabs. Menus and dialogs follow the selected appearance while boards, cards, and player colors retain their artwork.

## Hearth & Home

An original physical-looking tabletop game with a walnut slab, ivory tiles, four garden courts, lacquer miniatures, brass details, soft shadows and an orbiting 3D camera. Board artwork, piece designs, branding and synthesized sounds are generated locally; there are no downloaded Ludo assets.

Open `http://localhost:5173/#/hearth-and-home`, choose 2–4 players and press **Start game**. That creates a room, fills the other seats with Easy, Medium or Hard bots, and deals — the server plays the bots and the browser plays none of them. To play with people instead, switch to **Play online** and share the room's link.

- **Classic:** four pieces per player.
- **Quick:** two pieces per player.
- **Custom:** one to four pieces, with toggles for bonus rolls, captures, star protection and exact home rolls.

Roll a six to leave the nest, or advance an existing piece by the roll. Click a glowing miniature or its numbered button to move. Hovering or focusing a piece button previews its destination; screen readers announce its location and move outcome. A single legal move is selected automatically. Space also rolls the die.

The shared counterclockwise perimeter has 52 spaces. Complete it to enter your own five-space arrow lane, then reach the central home with an exact roll. The eight star tiles (entries and corners) are safe. Elsewhere, landing on an opponent sends all opposing pieces on that tile back to their nests. Pieces can share spaces and pass each other; there are no blockades. Rolling six grants another roll by default, even if no move is available. Captures grant no bonus roll, and there is no three-sixes penalty. The first player to bring every piece home wins.

Drag to orbit, scroll/pinch or use the camera buttons to zoom. Rule/settings dialogs do not pause the server’s turn. Audio starts muted and can be enabled from the header. Reduced-motion preferences shorten game animations automatically. The victory dialog reports home counts, rolls, captures, elapsed time and offers replay.

`shared/src/hearth/engine.ts` is the immutable source of truth for rules, legal moves, turns, events and victory. `board.ts` defines routes and coordinates; `ai.ts` scores only legal moves with caller-supplied randomness. The server schedules actions; `scene/` renders state and animates recorded movement paths. No game rule depends on WebGL, and the numbered controls remain usable if WebGL is unavailable.

All Hearth & Home games, including bot games, run in online rooms. Reopen the room link to resume within its 24-hour lifetime; there is no offline or pass-and-play mode.

## Gambit / Chess

Open `http://localhost:5173/#/chess`. Gambit opens directly to online rooms: create one and share its link, or join an open table from the lobby. Hosts can also fill an empty seat with an Easy or Medium bot; the server plays its moves.

Click or tap a piece and then a marked destination. Filled dots indicate ordinary moves and rings indicate captures. Drag to orbit, scroll or pinch to zoom, and use the board toolbar to flip, reset, or view from above. Focus the board with Tab, use arrow keys to explore from e2, and press Enter or Space to select and move; Escape deselects. A functional 2D board is available if WebGL fails.

All legal movement, check restrictions, castling, en passant, promotion, checkmate, stalemate, repetition, the fifty-move rule, and insufficient material use [chess.js](https://jhlywa.github.io/chess.js/). This casual version automatically ends games on threefold repetition or fifty moves rather than requiring a claim. Resignation requires confirmation. Promotion offers four original 3D piece previews. Clocks continue through dialogs, promotion, background tabs, and reloads. Undo restores the complete prior position, capture list, special-move rights, and clocks.

The immutable engine is `shared/src/chess/engine.ts`, shared with the server. It replays the full move line to preserve repetition counts; FEN alone is insufficient. Preferences save locally under `gambit-preferences-v1`, with validation on restore. React coordinates interaction, while `scene/` only renders positions, indicators, and animations. All board and piece geometry is original and procedural.

Walnut and marble sets, synthesized move sounds, higher contrast, and reduced motion are available in Settings. Clocks are outside this milestone online. Playing needs the backend but never an account (see Multiplayer & deployment below).

## Monopoly / Estate

A playable 3D property game for 2–4 players. Built with React, TypeScript, Three.js, and Vite. All property names, card text, tokens, and board artwork are original.

## Prism

Open `http://localhost:5173/#/prism`, choose 2–4 players and select **Let’s play**. That creates a room and deals a table against one to three bots on Easy, Medium or Hard. Every hand but yours lives on the server and is redacted before the snapshot leaves it, so there is nothing to hide from you and nothing for you to peek at.

Match the active color, number or action. Select a highlighted card, then tap it again or use **Play card**. **Draw card** takes one card; if it matches, play that card or **Keep & pass**. Wild cards open a color chooser. **Pause** skips, **Turn** reverses (and skips in two-player games), **Take Two** and **Take Four** draw penalties and skip the recipient. Take Four is legal only without another card of the active color. The 108-card deck uses Fisher–Yates shuffling and a numbered opening discard. Used cards recycle when the draw pile runs out, preserving the top discard.

**Call Prism!** with two cards before playing, or with one before the next accepted play/draw. Another player can catch a missed call during that window for two cards. AI allows 2.4 seconds before catching; this timer only schedules the opponent, while the engine's deadline is defined by accepted actions. Calls are sent to the room and validated by the server. Final-card penalties resolve before scoring: numbers are face value, actions 20 and wilds 50. **Play again** retains cumulative scores. A fully blocked table with no recyclable cards ends in a draw.

The pure command engine lives in `shared/src/prism/engine.ts`; centralized defaults and state types are in `shared/src/prism/types.ts`. `handView()` derives playability from authoritative state rather than persisting stale flags. AI uses legal cards, its own hand and public opponent counts. `scene/` renders physical mesh cards, an oval felt table and event-based card animations; the accessible hand controls work even without WebGL. Original card textures and sounds are generated locally.

Settings include sound, reduced motion and AI pace. Classic rules are the initial UI; stacking, immediate drawn-card play, draw-until-playable, Draw Four restrictions, call penalties and scoring are engine options. Jump-in and 7–0 cannot be enabled until implemented. Custom-rule UI, tournament formats, music and saved sessions are outside this milestone. All Prism rounds run in online rooms, including bot games. Refreshing the room link reconnects to the same game during its 24-hour lifetime.

Verification: `npx vitest run src/games/prism` and `npx playwright test tests/prism.spec.ts`. Browser tests check server-backed bot rooms, setup options, mobile controls and multiplayer play. Seeded engine simulations verify card conservation across complete rounds.

## Run

Use Node.js 22 or newer for the local backend and browser tests; CI uses Node.js 24.

```sh
npm install
npm run dev -w backend
# In another terminal:
npm run dev -w frontend
```

Open the printed local address and choose a game from the homepage, or go directly to `http://localhost:5173/#/estate` and choose **Start game**. Choose a guest name, select bot opponents or an online room, and choose classic or quick mode. Every game needs the backend and a network connection; an account is optional.

## Multiplayer & deployment

**Every game is played on the server**, including a game against bots. Choosing "Play vs bot" creates a private room, seats you, fills the rest with bots and deals — so a bot game and a game with friends are one program with the same room at the end of both. A bot is a seat the room takes the turns for, not something the browser simulates.

From a game's page you can also create a room to share — private, or listed in the public lobby for anyone to find — and pass on its six-character code or invite link, or join an open table straight from the lobby. A host waiting on someone who never turned up can fill the empty seats with bots and start anyway. Playing only ever needs a name: as a guest, or optionally through Google sign-in with Clerk so your identity carries across sessions. The collection and all five game menus show the account control. In a live room, the header displays your player identity; return to the game menu to change accounts.

A room is resumable from its link for 24 hours. There is no offline play: every move, including a bot's, needs the network.

For Clerk/Cloudflare setup and deployment instructions, see [Deployment & setup](../docs/deployment.md).

## Deploy to GitHub Pages

The repository's [deployment workflow](../.github/workflows/deploy.yml) installs dependencies with `npm ci`, runs lint and unit tests, builds the frontend using Node.js 24, and deploys `frontend/dist` to GitHub Pages.

1. In the GitHub repository, open **Settings → Pages** and set **Build and deployment → Source** to **GitHub Actions**. See [GitHub's custom workflow guide](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
2. Under **Custom domain**, enter `games.manishbisht.me` and click **Save**.
3. At the DNS provider for `manishbisht.me`, create a **CNAME** record with name `games` and target `manishbisht.github.io`.
4. Commit and push the frontend (including `package-lock.json`) and `.github/workflows/deploy.yml` to `main`.
5. Open **Actions → pages** to watch the deployment. Later pushes to `main` deploy automatically; you can also choose **Run workflow** on `main` to deploy manually.
6. Once GitHub has issued the domain's certificate, enable **Enforce HTTPS** in **Settings → Pages**.

After deployment and HTTPS setup, the site address is <https://games.manishbisht.me/>. Direct game links are <https://games.manishbisht.me/#/hearth-and-home> and <https://games.manishbisht.me/#/estate>.

The workflow reads the custom domain from GitHub Pages metadata and builds with `/` as the asset base path. Hash routes continue to support direct links and refreshes. No personal access token or additional repository secrets are required for deployment. With a custom GitHub Actions workflow, GitHub ignores `CNAME` files in the repository; the domain must be configured in Pages settings. See [GitHub's custom domain guide](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site).

To preview the Pages build locally, run these commands from `frontend/`:

```sh
npm run build -- --base /
npm run preview -- --base /
```

Open `http://localhost:4173/`.

## Play

- Roll, move, buy properties, collect rent, and finish your turn. Computer opponents play automatically.
- Click a board space or open **My properties** for rent and ownership details.
- Complete a color group to build evenly. Four houses upgrade to a hotel. Sell buildings for half cost, mortgage for half the purchase price, and unmortgage for 55% of the purchase price.
- Trade cash and properties. The offer confirms the initiator's consent; the recipient must accept before assets change hands. Computer recipients evaluate offers by asset value. Buildings in a group must be sold before its properties can be traded.
- Pay $50 to leave jail or try rolling doubles. The third failed attempt requires the fee. Three consecutive doubles send a player to jail.
- If cash runs short, raise money through selling and mortgages. Bankruptcy occurs only when assets cannot cover a required payment. The last active player wins.

Classic games start with $1,500. Quick games start with $1,000 and increase rent to 2× in round 15, 3× in round 20, then another 1× every five rounds. This prevents the low-rent stalemates that can happen when groups remain split among players.

House rules: passed properties remain available (no auctions), free parking has no jackpot, building supply is unlimited, and a hotel sells back to four houses for half an upgrade's price. These rules keep the first version approachable.

## Controls

| Input | Action |
| --- | --- |
| Space | Start, roll, or finish your turn |
| M | Property portfolio |
| R | Reset camera |
| ? | Rules |
| Escape | Close the active dialog |
| Drag / touch drag | Rotate board |
| Scroll / pinch / + / − | Zoom |

The camera also has top-down and reset buttons. Native dialogs support keyboard focus and touch input. Game sounds are synthesized locally and can be muted. Settings can speed up computer decisions.

Estate game state is stored in its server room. Reload the room link to reconnect; the old `estate-game-v1` local save is no longer used. Guest identity remains tied to this browser, so clearing site data can prevent reclaiming a guest seat.

## Structure

- `src/main.tsx`: shared React entry point and `HashRouter`.
- `src/App.tsx`: game routes, page metadata, and legacy redirects.
- `src/games/catalog.ts`: shared game names, paths, card details, and lazy imports.
- `src/pages/HomePage.tsx`: responsive game collection and play links.
- `src/games/monopoly/MonopolyGame.tsx`: state orchestration, turn scheduling, controls, status, and events.
- `src/games/monopoly/MonopolyGame.css`: Monopoly styles.
- `shared/src/estate/board.ts`: board definitions and original card decks.
- `shared/src/estate/engine.ts`: pure reducer, seeded randomness, financial rules, trades, and computer decisions.
- `shared/src/estate/types.ts`: central game state and action contracts.
- `src/games/monopoly/scene/`: procedural geometry, textures, lighting, camera, dice, token movement, and resource cleanup.
- `src/games/monopoly/components/`: setup, portfolios, property management, trading, and accessible dialogs.

The 3D layer consumes state and renders it. All money, ownership, movement destinations, dice outcomes, and winners are decided by the reducer. Tests can inject a seed without rendering a scene.

## Add another game

Create its component and supporting files in `src/games/<game-name>/`, then add an entry to `games` in `src/games/catalog.ts` with its name, canonical path, legacy aliases (if any), description, card tags, icon, theme color, and lazy component import. The homepage card and route are generated from that catalog. Add the game's board illustration in `src/pages/HomePage.tsx` and its styles in `HomePage.css`.

Use the catalog's canonical path with React Router's `<Link>` for navigation between games. Register the game’s server adapter and room view so its state and actions are validated on the backend.

## Verify

```sh
npm test
npm run lint
npm run build
npm run test:e2e -w frontend
# Longer gameplay checks against server-controlled bots:
npm run test:smoke -w frontend
```

The browser suite starts the local backend and builds and serves the frontend at `http://127.0.0.1:5173`, reusing existing servers when available. It uses an installed Google Chrome. It checks the homepage, canonical game links, legacy redirects, direct-link refreshes, return navigation, mobile layout, page titles, and appearance settings across games and dialogs. Game coverage is what a browser is responsible for: each setup panel, the table it asks the server for, a bot's turn arriving, and the table settings surviving the crossing. The separate smoke suite plays multiple turns against bots in all five games and checks browser and network errors. The rules themselves — a game played to victory, trades, bankruptcies, redacted hands — are covered where they run, in `shared/` and `backend/`. Screenshots are written to the ignored `test-results/` directory. Unit tests exercise rule boundaries, invalid actions, AI strategy, and complete deterministic games without loading a renderer.

The 3D boards require WebGL. Google Fonts are an optional enhancement with local font fallbacks. Every game needs the backend, bots included, and none of them need an account (see Multiplayer & deployment above).
