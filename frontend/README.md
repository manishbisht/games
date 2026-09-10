# Games

A React frontend for original 3D tabletop games, using React, TypeScript, Three.js and React Router's `HashRouter`.

## Routes

- `/` or `/#/`: browse the homepage and choose a game.
- `/#/hearth-and-home`: play **Hearth & Home**, the Ludo-inspired game.
- `/#/estate`: play **Estate**, the property game.
- `/#/Ludo` and `/#/Hearth` redirect to `/#/hearth-and-home`; `/#/Monopoly` redirects to `/#/estate`, so existing bookmarks keep working.
- Unknown hash routes return to the homepage. Both games include an **All games** link back to the collection.

The route path is `/hearth-and-home` or `/estate`; `HashRouter` adds the `#` in the browser URL. Hash routes support direct links and refreshes without requiring server-side route rewrites. Page titles, descriptions, and favicons follow the active game.

## Hearth & Home

An original physical-looking tabletop game with a walnut slab, ivory tiles, four garden courts, lacquer miniatures, brass details, soft shadows and an orbiting 3D camera. Board artwork, piece designs, branding and synthesized sounds are generated locally; there are no downloaded Ludo assets.

Open `http://localhost:5173/#/hearth-and-home`, choose 2–4 players and press **Start game**. Each seat can be a local player or Easy, Medium or Hard AI. The default table is one human with three AI opponents. Set every seat to **Local player** for pass-and-play, or every seat to AI to watch a game.

- **Classic:** four pieces per player.
- **Quick:** two pieces per player.
- **Custom:** one to four pieces, with toggles for bonus rolls, captures, star protection and exact home rolls.

Roll a six to leave the nest, or advance an existing piece by the roll. Click a glowing miniature or its numbered button to move. Hovering or focusing a piece button previews its destination; screen readers announce its location and move outcome. A single legal move is selected automatically. Space also rolls the die.

The shared counterclockwise perimeter has 52 spaces. Complete it to enter your own five-space arrow lane, then reach the central home with an exact roll. The eight star tiles (entries and corners) are safe. Elsewhere, landing on an opponent sends all opposing pieces on that tile back to their nests. Pieces can share spaces and pass each other; there are no blockades. Rolling six grants another roll by default, even if no move is available. Captures grant no bonus roll, and there is no three-sixes penalty. The first player to bring every piece home wins.

Drag to orbit, scroll/pinch or use the camera buttons to zoom. Pause and rule/settings dialogs suspend the turn. Audio starts muted and can be enabled from the header. Reduced-motion preferences shorten game animations automatically. The victory dialog reports home counts, rolls, captures, elapsed time and offers replay.

`src/games/hearth/game/engine.ts` is the immutable source of truth for rules, legal moves, turns, events and victory. `board.ts` defines routes and coordinates; `ai.ts` scores only legal moves with caller-supplied randomness. React schedules actions; `scene/` renders state and animates recorded movement paths. No game rule depends on WebGL, and the numbered controls remain usable if WebGL is unavailable.

This milestone supports local play and AI. Hearth & Home sessions are held in memory; refreshing starts a new setup. Online rooms and saved Hearth sessions are not implemented.

## Monopoly / Estate

A playable 3D property game for 2–4 players. Built with React, TypeScript, Three.js, and Vite. All property names, card text, tokens, and board artwork are original.

## Run

```sh
npm install
npm run dev
```

Open the printed local address and choose a game from the homepage, or go directly to `http://localhost:5173/#/estate` and choose **Start game**. Rename players, choose local humans or computer opponents, and select classic or quick mode. No account or backend is needed.

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

Stable game phases save locally under `estate-game-v1`. Reloading during an animation restores the preceding stable phase; the seeded random state preserves the next roll. Invalid or incompatible saves recover to setup. Storage is local to the browser, so private browsing or clearing site data can remove progress.

## Structure

- `src/main.tsx`: shared React entry point and `HashRouter`.
- `src/App.tsx`: game routes, page metadata, and legacy redirects.
- `src/games/catalog.ts`: shared game names, paths, card details, and lazy imports.
- `src/pages/HomePage.tsx`: responsive game collection and play links.
- `src/games/monopoly/MonopolyGame.tsx`: state orchestration, turn scheduling, controls, status, and events.
- `src/games/monopoly/MonopolyGame.css`: Monopoly styles.
- `src/games/monopoly/game/board.ts`: board definitions and original card decks.
- `src/games/monopoly/game/engine.ts`: pure reducer, seeded randomness, financial rules, trades, and computer decisions.
- `src/games/monopoly/game/types.ts`: central game state and action contracts.
- `src/games/monopoly/game/storage.ts`: stable snapshots and recovery validation.
- `src/games/monopoly/scene/`: procedural geometry, textures, lighting, camera, dice, token movement, and resource cleanup.
- `src/games/monopoly/components/`: setup, portfolios, property management, trading, and accessible dialogs.

The 3D layer consumes state and renders it. All money, ownership, movement destinations, dice outcomes, and winners are decided by the reducer. Tests can inject a seed without rendering a scene.

## Add another game

Create its component and supporting files in `src/games/<game-name>/`, then add an entry to `games` in `src/games/catalog.ts` with its name, canonical path, legacy aliases (if any), description, card tags, icon, theme color, and lazy component import. The homepage card and route are generated from that catalog. Add the game's board illustration in `src/pages/HomePage.tsx` and its styles in `HomePage.css`.

Use the catalog's canonical path with React Router's `<Link>` for navigation between games. Keep each game's state and saved-game storage key separate; Estate continues using `estate-game-v1` so existing saves still load.

## Verify

```sh
npm test
npm run lint
npm run build
npm run test:e2e
```

The browser suite starts or reuses the dev server at `http://127.0.0.1:5173` and uses an installed Google Chrome. It checks the homepage, canonical game links, legacy redirects, direct-link refreshes, return navigation, mobile layout, and page titles. Game coverage includes Hearth setup, human rolls and nest entry, AI-versus-AI victory/replay, custom rules, pause/resume, audio controls and camera controls. Estate's purchase, autosave, trade and bankruptcy regressions remain covered. Screenshots are written to the ignored `test-results/` directory. Unit tests exercise rule boundaries, invalid actions, AI strategy, and complete deterministic games without loading a renderer.

The 3D boards require WebGL. Google Fonts are an optional enhancement with local font fallbacks. Both games run locally without an account or backend; online networking is outside this milestone.
