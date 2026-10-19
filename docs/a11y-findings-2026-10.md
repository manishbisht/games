# Accessibility findings — October 2026

How these were found: `frontend/tests/a11y.spec.ts` runs axe-core 4.13 (`@axe-core/playwright`, tags
`wcag2a wcag2aa wcag21a wcag21aa wcag22aa`) on 14 screens × 2 appearances, with reduced motion emulated and
the page given 600 ms to settle so nothing is measured mid-fade. Run on 2026-10-19 against HEAD `cb5a4a9` (profiles, reactions, push) plus the game agents' working tree (Chrome, 1440×960). To reproduce, with a backend on :8787 and the site on the config's `baseURL`:

```sh
cd frontend
A11Y_ALL=1 A11Y_REPORT=test-results/axe npx playwright test tests/a11y.spec.ts
```

`A11Y_ALL=1` also runs the screens listed in `KNOWN` (which CI skips as `fixme`); `A11Y_REPORT` writes each
screen's full result as JSON.

## Summary

- **Every violation is `color-contrast` (serious).** No other WCAG A/AA rule fired anywhere: names, roles,
  labels, landmarks, focusable controls and ARIA all pass on every screen.
- **14 of 28 screen/appearance pairs fail**, 196 elements in all. Clean: the room waiting screen (both —
  including the reaction bar, a reaction's float and the notification toggle), both profile pages in dark,
  Prism (setup and game, both), chess dark, Hearth setup dark, Estate light, Wildrise setup dark.
- **New UI (profiles, reactions, push):** one finding — the _loss_ result chip on both profile pages in
  light mode (4.36 : 1). `YourTables` on the home page, `ReactionBar`, `ReactionOverlay` and `NotifyToggle`
  are clean in both appearances.
- **Keyboard:** all five games can be set up, started and given a first move with the keyboard alone (Tab to
  reach, Enter to act; chess's board by arrows). Those five tests pass and run in CI.

| Screen         | Light | Dark  | Owner                                                      |
| -------------- | ----- | ----- | ---------------------------------------------------------- |
| Home page      | fixed | fixed | shell (`pages/HomePage.css`)                               |
| Your profile   | fixed | clean | shell (`pages/ProfilePage.css`)                            |
| Player profile | fixed | clean | shell (`pages/ProfilePage.css`)                            |
| Room waiting   | clean | clean | shell (`online/online.css`, `reactions.css`, `notify.css`) |
| Gambit setup   | fixed | clean | chess (`games/chess/ChessGame.css`)                        |
| Gambit game    | fixed | clean | chess                                                      |
| Hearth setup   | fixed | clean | hearth (`games/hearth/HearthGame.css`)                     |
| Hearth game    | fixed | fixed | hearth                                                     |
| Estate setup   | clean | fixed | estate (`games/monopoly/…`)                                |
| Estate game    | clean | fixed | estate                                                     |
| Prism setup    | clean | clean | prism                                                      |
| Prism game     | clean | clean | prism                                                      |
| Wildrise setup | fixed | clean | wildrise (`games/wildrise/WildriseGame.css`)               |
| Wildrise game  | fixed | fixed | wildrise                                                   |

The theme control (Appearance select, Motion button) was checked as part of every screen and has no
violation.

## Root causes and fixes

1. **Hard-coded light-mode greys (≈ 3.4–4.3 : 1 on the cream backgrounds).** Most light failures share one
   pattern: secondary text declared as `light-dark(#7x8x7x, var(--theme-muted))`, where the dark half uses the
   theme token (which passes) and the light half is a lighter, hand-picked grey that does not. The site-wide
   token `--theme-muted` (`theme/theme.css:8`, `#66735e`) is ≈ 4.8 : 1 on `#faf9f5` and passes.
   - Home: `pages/HomePage.css:41, 105, 127, 159, 354, 379, 394` and the plain `#838979` at `:414`.
     **Fixed:** each light grey is now `#6b7263` (4.7 : 1 on the page, 4.9 on a card), dark unchanged.
   - Gambit: `--ch-muted: light-dark(#7d8376, …)` (`games/chess/ChessGame.css:4`).
   - Hearth: `--hh-muted: light-dark(#85897e, …)` (`games/hearth/HearthGame.css:3`, again at `:1217`).
   - Wildrise: `--wr-muted: light-dark(#7c8273, …)` (`games/wildrise/WildriseGame.css:3`).

   **Fix:** use `var(--theme-muted)` for both halves, or darken each light grey to ≥ 4.5 : 1 against the
   lightest surface it sits on (`#fffefa` cards are the hardest case; `#6b7263` or darker passes there).
   Elements that are already faded further with `opacity` (several `small` and footnote lines) need the
   opacity removed — contrast is computed on the blended colour.

2. **Very small text.** Many failing elements are 5–9 px (eyebrows, badges, `kbd` hints, footnotes). They
   fail on contrast, but even at 4.5 : 1 text that small is hard to read; WCAG's large-text exemption never
   applies to it. **Fix:** a floor of 11 px for anything a player needs to read (keep the tiny caps purely
   decorative, or `aria-hidden` them when the same information is said elsewhere).

3. **Profiles.** `.profile-result` (`pages/ProfilePage.css:292`) is `--theme-muted` on the chip's `#eef0e7`
   fill — 4.36 : 1; the _win_ and _draw_ variants override it and pass. Darken the base chip text or lighten
   its fill. **Fixed:** the base chip's light text is `#5f6c58` (4.8 : 1); the replay page's speed buttons,
   the same pair, likewise.

4. **Dark-mode specifics.**
   - Home: the player-count line on every card, `#66745e` on `#202c24` (2.9 : 1) — the light-mode grey is
     used in dark mode (`pages/HomePage.css:404-414`, `.collection-player-info`). Prism's preview card
     (`.collection-preview-caption`, `.collection-preview-note`, `HomePage.css:193, 201`, and the
     `#fff3d6` on `#579975` card face at `:655`). **Fixed:** the player-count line uses the theme token in
     dark; the previews' caption and note are at 0.85 opacity (4.9 : 1 on Prism's felt); the green card is
     `#44775b` (4.7 : 1) in `PrismPreview.css`.
   - Hearth game: the current player's row (`#a8b5a0` on `#444941`, 4.3 : 1) and the roll button's `SPACE`
     hint (`kbd`, 3.45 : 1, `HearthGame.css:810`).
   - Wildrise game: the active player's info line, `#d86b4e` on `#6b6c64` (1.55 : 1,
     `WildriseGame.css:610`) — the turn highlight's background swallows the player colour; and the roll
     button's `kbd` hint (2.8 : 1, `WildriseGame.css:695`).
   - Estate: `.now-label` (3.4 : 1) and `.activity-footer` (3.9 : 1) in `games/monopoly/styles/activity.css:104,
111`; the setup dialog's `.dialog-footnote` at 4.49 : 1 (`games/monopoly/components/Dialog.css:61`) —
     a hair short.

## What CI does now

`a11y.spec.ts` lists the failing pairs in `KNOWN`; those run as `test.fixme` with a pointer here, and every
clean pair runs for real, so a regression on a clean screen fails CI. **When a screen is fixed, delete its
entry from `KNOWN`** — otherwise it is never checked again. The keyboard tests are not gated.

Not covered by axe (manual follow-ups): the 3D boards themselves (canvas content has no accessible
representation beyond the controls around it — chess's board does expose its squares as labelled
elements), focus visibility on the canvases, live-region announcements of the bots' moves, and
`prefers-reduced-motion` behaviour (covered by the motion specs).

## Every violation, by screen

### home — light (fixed)

| Element                                                                                      | Ratio | Text on background | Size |
| -------------------------------------------------------------------------------------------- | ----- | ------------------ | ---- |
| `.collection-header-note`                                                                    | 4.29  | #717969 on #faf9f5 | 10px |
| `.collection-free`                                                                           | 4.29  | #717969 on #faf9f5 | 11px |
| `.collection-eyebrow`                                                                        | 3.57  | #7e876f on #faf9f5 | 9px  |
| `.collection-intro-copy`                                                                     | 4.26  | #72796d on #faf9f5 | 14px |
| `.collection-section-heading > span`                                                         | 3.76  | #7b8274 on #faf9f5 | 10px |
| `.collection-card-hearth … .collection-card-eyebrow`                                         | 3.72  | #7e876f on #fffefa | 8px  |
| `.collection-card-hearth … .collection-description`                                          | 4.33  | #747b6e on #fffefa | 12px |
| `ul[aria-label="Hearth & Home features"] > li:nth-child(1)`                                  | 4.3   | #747c69 on #fffefa | 9px  |
| `ul[aria-label="Hearth & Home features"] > li:nth-child(2)`                                  | 4.3   | #747c69 on #fffefa | 9px  |
| `.collection-card-hearth … .collection-card-footer > .collection-player-info > span > small` | 3.57  | #838979 on #fffefa | 9px  |
| `.collection-card-estate … .collection-card-eyebrow`                                         | 3.72  | #7e876f on #fffefa | 8px  |
| `.collection-card-estate … .collection-description`                                          | 4.33  | #747b6e on #fffefa | 12px |
| `ul[aria-label="Estate features"] > li:nth-child(1)`                                         | 4.3   | #747c69 on #fffefa | 9px  |
| `ul[aria-label="Estate features"] > li:nth-child(2)`                                         | 4.3   | #747c69 on #fffefa | 9px  |
| `.collection-card-estate … .collection-card-footer > .collection-player-info > span > small` | 3.57  | #838979 on #fffefa | 9px  |
| `.collection-card-chess … .collection-card-eyebrow`                                          | 3.72  | #7e876f on #fffefa | 8px  |
| `.collection-card-chess … .collection-description`                                           | 4.33  | #747b6e on #fffefa | 12px |
| `ul[aria-label="Gambit features"] > li:nth-child(1)`                                         | 4.3   | #747c69 on #fffefa | 9px  |
| `ul[aria-label="Gambit features"] > li:nth-child(2)`                                         | 4.3   | #747c69 on #fffefa | 9px  |
| `.collection-card-chess … .collection-card-footer > .collection-player-info > span > small`  | 3.57  | #838979 on #fffefa | 9px  |
| `aside > p`                                                                                  | 4.47  | #6c7763 on #faf9f5 | 11px |
| `aside > p > span`                                                                           | 3.33  | #848b7d on #faf9f5 | 11px |
| `footer > span:nth-child(1)`                                                                 | 3.13  | #89907f on #faf9f5 | 10px |
| `footer > span:nth-child(2)`                                                                 | 3.13  | #89907f on #faf9f5 | 8px  |

### home — dark (fixed)

| Element                                                                                                     | Ratio | Text on background | Size |
| ----------------------------------------------------------------------------------------------------------- | ----- | ------------------ | ---- |
| `.collection-card-hearth … .collection-card-footer > .collection-player-info > span:nth-child(2)`           | 2.91  | #66745e on #202c24 | 11px |
| `.collection-card-hearth … .collection-card-footer > .collection-player-info > span:nth-child(2) > small`   | 4.02  | #838979 on #202c24 | 9px  |
| `.collection-card-estate … .collection-card-footer > .collection-player-info > span:nth-child(2)`           | 2.91  | #66745e on #202c24 | 11px |
| `.collection-card-estate … .collection-card-footer > .collection-player-info > span:nth-child(2) > small`   | 4.02  | #838979 on #202c24 | 9px  |
| `.collection-card-chess … .collection-card-footer > .collection-player-info > span:nth-child(2)`            | 2.91  | #66745e on #202c24 | 11px |
| `.collection-card-chess … .collection-card-footer > .collection-player-info > span:nth-child(2) > small`    | 4.02  | #838979 on #202c24 | 9px  |
| `.collection-preview-prism > .collection-preview-caption`                                                   | 3.49  | #8b8c6a on #213b2f | 7px  |
| `.collection-prism-card-3 > small`                                                                          | 3.06  | #fff3d6 on #579975 | 9px  |
| `.collection-prism-card-3 > span`                                                                           | 3.06  | #fff3d6 on #579975 | 5px  |
| `.collection-preview-prism > .collection-preview-note`                                                      | 3.83  | #93936f on #213b2f | 11px |
| `.collection-card-prism … .collection-card-footer > .collection-player-info > span:nth-child(2)`            | 2.91  | #66745e on #202c24 | 11px |
| `.collection-card-prism … .collection-card-footer > .collection-player-info > span:nth-child(2) > small`    | 4.02  | #838979 on #202c24 | 9px  |
| `.collection-card-wildrise … .collection-card-footer > .collection-player-info > span:nth-child(2)`         | 2.91  | #66745e on #202c24 | 11px |
| `.collection-card-wildrise … .collection-card-footer > .collection-player-info > span:nth-child(2) > small` | 4.02  | #838979 on #202c24 | 9px  |

### me — light (fixed)

| Element                | Ratio | Text on background | Size |
| ---------------------- | ----- | ------------------ | ---- |
| `.profile-result-loss` | 4.36  | #66735e on #eef0e7 | 11px |

### player — light (fixed)

| Element                | Ratio | Text on background | Size |
| ---------------------- | ----- | ------------------ | ---- |
| `.profile-result-loss` | 4.36  | #66735e on #eef0e7 | 11px |

### chess-setup — light

**Fixed.** Every light-mode text grey in `games/chess/ChessGame.css` and `ChessLobby.css` under 4.5 : 1 was darkened, hue and saturation kept, to ≥ 4.6 : 1 on the page (`#f8f7f2`) — or on the tinted fill it sits on where that is darker (the online badge, the clock choice, the lobby's heading tag). Large decorative type (the edition numeral, the empty-history glyph, the rules' piece glyphs) only needed 3 : 1. Out of `KNOWN`; the Settings, How to play, Resign and result dialogs were also checked and pass in both appearances.

| Element                                      | Ratio | Text on background | Size |
| -------------------------------------------- | ----- | ------------------ | ---- |
| `.ch-brand > small`                          | 3.03  | #8b917f on #f8f7f2 | 8px  |
| `.ch-online-badge`                           | 2.78  | #8b957b on #f0f2e9 | 10px |
| `.ch-all-games`                              | 4.08  | #727c68 on #f8f7f2 | 12px |
| `button[aria-label="How to play"] > span`    | 4.08  | #727c68 on #f8f7f2 | 12px |
| `.ch-eyebrow`                                | 4.4   | #6c775f on #f8f7f2 | 10px |
| `.ch-lobby-intro > p:nth-child(3)`           | 4.2   | #71796c on #f8f7f2 | 14px |
| `.ch-clock-choice-title`                     | 4.37  | #6d7764 on #f8f7f2 | 10px |
| `.selected > small`                          | 2.87  | #8a917f on #eef2e6 | 9px  |
| `button[type="button"]:nth-child(2) > small` | 3.23  | #8a917f on #fffefa | 9px  |
| `button[type="button"]:nth-child(3) > small` | 3.23  | #8a917f on #fffefa | 9px  |
| `button[type="button"]:nth-child(4) > small` | 3.23  | #8a917f on #fffefa | 9px  |
| `button[type="button"]:nth-child(5) > small` | 3.23  | #8a917f on #fffefa | 9px  |
| `.ch-online-heading > div > p`               | 3.5   | #858a7d on #fffefa | 11px |
| `.ch-online-create > p`                      | 3.5   | #858a7d on #fffefa | 12px |
| `.ch-online-visibility > span`               | 4.49  | #707969 on #fffefa | 12px |
| `.ch-online-privacy`                         | 3.32  | #8a8e80 on #fffefa | 9px  |
| `h3 > span`                                  | 2.78  | #8b957b on #f0f2e9 | 10px |
| `button[aria-label="Refresh rooms"]`         | 3.89  | #7a846c on #fffefa | 10px |
| `li:nth-child(1) > span > small`             | 3.24  | #89917d on #fffefa | 10px |
| `li:nth-child(2) > span > small`             | 3.24  | #89917d on #fffefa | 10px |
| `li:nth-child(3) > span > small`             | 3.24  | #89917d on #fffefa | 10px |
| `li:nth-child(4) > span > small`             | 3.24  | #89917d on #fffefa | 10px |
| `.ch-lobby-guest-note`                       | 3.7   | #7b8273 on #f8f7f2 | 11px |
| `.ch-lobby-details > span:nth-child(1)`      | 4.1   | #737b6b on #f8f7f2 | 11px |
| `.ch-lobby-details > span:nth-child(2)`      | 4.1   | #737b6b on #f8f7f2 | 11px |
| `footer > span:nth-child(1)`                 | 2.79  | #929786 on #f8f7f2 | 10px |
| `footer > span:nth-child(2)`                 | 2.79  | #929786 on #f8f7f2 | 10px |

### chess-game — light

**Fixed** with the same greys: the player cards and their tags, the untimed clocks (now ≥ 4.6 : 1 on the active clock's `#e7ecde`), the session panel and history, the "little space to think" card and the footer. An away tag is now set apart by a dashed outline instead of `opacity: 0.6`. Out of `KNOWN`.

| Element                                                              | Ratio | Text on background | Size |
| -------------------------------------------------------------------- | ----- | ------------------ | ---- |
| `.ch-brand > small`                                                  | 3.03  | #8b917f on #f8f7f2 | 8px  |
| `.ch-online-badge`                                                   | 2.78  | #8b957b on #f0f2e9 | 10px |
| `.ch-all-games`                                                      | 4.08  | #727c68 on #f8f7f2 | 11px |
| `button:nth-child(4) > span`                                         | 4.08  | #727c68 on #f8f7f2 | 11px |
| `.ch-page-heading > div:nth-child(1) > .ch-eyebrow`                  | 3.29  | #828c71 on #f8f7f2 | 8px  |
| `div:nth-child(1) > p:nth-child(3)`                                  | 3.21  | #878c7f on #f8f7f2 | 12px |
| `.ch-edition > span`                                                 | 1.65  | #c0c4b4 on #f8f7f2 | 39px |
| `.ch-edition > div`                                                  | 2.92  | #8d9482 on #f8f7f2 | 7px  |
| `.ch-edition > div > small`                                          | 4.05  | #717d65 on #f8f7f2 | 13px |
| `.ch-player:nth-child(1) > .ch-player-details > div > .ch-small-tag` | 2.96  | #858e77 on #edf0e4 | 6px  |
| `.ch-player:nth-child(1) > .ch-player-details > span`                | 2.95  | #8d9383 on #f8f7f2 | 10px |
| `div[aria-label="Black clock: no time limit"] > .ch-untimed`         | 1.98  | #a7ad9c on #efeee7 | 14px |
| `.ch-player-active > .ch-player-details > div > .ch-small-tag`       | 2.96  | #858e77 on #edf0e4 | 6px  |
| `.ch-player-active > .ch-player-details > span`                      | 4.34  | #657b52 on #f8f7f2 | 10px |
| `div[aria-label="White clock: no time limit"] > .ch-untimed`         | 1.91  | #a7ad9c on #e7ecde | 14px |
| `.ch-board-footnote > span:nth-child(1)`                             | 2.53  | #9a9f8f on #f8f7f2 | 8px  |
| `.ch-board-footnote > span:nth-child(2)`                             | 2.53  | #9a9f8f on #f8f7f2 | 8px  |
| `.ch-session-label > .ch-eyebrow`                                    | 3.5   | #828c71 on #fffefa | 8px  |
| `.ch-panel-copy`                                                     | 3.28  | #8b8f81 on #fffefa | 11px |
| `.ch-session-tags > span:nth-child(1)`                               | 2.83  | #8b947e on #f2f3ea | 8px  |
| `.ch-session-tags > span:nth-child(2)`                               | 2.83  | #8b947e on #f2f3ea | 8px  |
| `.ch-history-heading > span`                                         | 2.36  | #a5aa98 on #fffefa | 8px  |
| `.ch-empty-history > p`                                              | 2.82  | #929d81 on #fffefa | 16px |
| `.ch-empty-history > small`                                          | 2.04  | #b1b7a4 on #fffefa | 8px  |
| `.ch-game-actions > button`                                          | 3.67  | #7c8970 on #fffefa | 9px  |
| `div:nth-child(2) > h3`                                              | 3.97  | #697c59 on #eff1e7 | 17px |
| `.ch-thought > div:nth-child(2) > p`                                 | 2.52  | #929c82 on #eff1e7 | 10px |
| `.ch-learn-link > span`                                              | 2.51  | #9aa08e on #f8f7f2 | 9px  |
| `.ch-learn-link > span > strong`                                     | 3.63  | #76866a on #f8f7f2 | 9px  |
| `footer > span:nth-child(1)`                                         | 2.44  | #9ba38e on #f8f7f2 | 9px  |
| `footer > span:nth-child(2)`                                         | 2.44  | #9ba38e on #f8f7f2 | 7px  |
| `footer > span:nth-child(3)`                                         | 2.44  | #9ba38e on #f8f7f2 | 9px  |

### hearth-setup — light

**Fixed.** Every light-mode grey in `games/hearth/HearthGame.css` that sat under 4.5 : 1 was darkened, hue kept, to ≥ 4.6 : 1 on the darkest cream it is drawn on (`#f4f3ec`); `--hh-muted` is now `#6b6f65`. The screen is out of `KNOWN` and passes.

| Element                                             | Ratio | Text on background | Size |
| --------------------------------------------------- | ----- | ------------------ | ---- |
| `.hh-brand > span > small`                          | 3.23  | #898d7d on #faf9f5 | 8px  |
| `nav > button:nth-child(2)`                         | 3.46  | #828879 on #faf9f5 | 12px |
| `.hh-online-badge`                                  | 3.61  | #7e8577 on #faf9f5 | 10px |
| `.hh-local-badge`                                   | 3.61  | #7e8577 on #faf9f5 | 10px |
| `.hh-page-heading > div:nth-child(1) > .hh-eyebrow` | 3.04  | #8d927f on #faf9f5 | 8px  |
| `.hh-table-meta`                                    | 3.11  | #8b907f on #faf9f5 | 9px  |
| `.hh-setup > .hh-eyebrow`                           | 3.12  | #8d927f on #fdfcf8 | 8px  |
| `.hh-setup-intro`                                   | 3.03  | #929385 on #fdfcf8 | 11px |
| `.hh-field-title:nth-child(1) > span`               | 2.07  | #b1b3a6 on #fdfcf8 | 9px  |
| `.hh-mode-options > button:nth-child(2)`            | 3.5   | #828877 on #fbfaf6 | 10px |
| `.hh-mode-options > button:nth-child(3)`            | 3.5   | #828877 on #fbfaf6 | 10px |
| `.hh-field-note`                                    | 2.67  | #9a9e8c on #fdfcf8 | 9px  |
| `.hh-field-title:nth-child(4) > span`               | 2.07  | #b1b3a6 on #fdfcf8 | 9px  |
| `button[aria-label="2 players"]`                    | 2.43  | #999d8e on #f0f1e9 | 10px |
| `button[aria-label="3 players"]`                    | 2.43  | #999d8e on #f0f1e9 | 10px |
| `select[aria-label="Blue player type"]`             | 3.05  | #8d9382 on #fcfbf7 | 9px  |
| `select[aria-label="Green player type"]`            | 3.05  | #8d9382 on #fcfbf7 | 9px  |
| `select[aria-label="Yellow player type"]`           | 3.05  | #8d9382 on #fcfbf7 | 9px  |
| `.hh-local-note`                                    | 2.58  | #9da18f on #fdfcf8 | 9px  |
| `.hh-legend > span:nth-child(1)`                    | 2.8   | #929982 on #faf9f5 | 9px  |
| `.hh-legend > span:nth-child(2)`                    | 2.8   | #929982 on #faf9f5 | 9px  |
| `.hh-legend > button`                               | 3.05  | #89937c on #faf9f5 | 9px  |
| `.hh-below-table > p`                               | 2.3   | #a3a993 on #faf9f5 | 9px  |
| `footer > span:nth-child(1)`                        | 2.79  | #909a80 on #faf9f5 | 12px |
| `footer > span:nth-child(2)`                        | 2.57  | #9b9f8e on #faf9f5 | 7px  |
| `.hh-game-picker > button`                          | 2.95  | #8b967d on #faf9f5 | 9px  |

### hearth-game — light

**Fixed** with the same greys as the setup screen — the turn panel, the player cards (current and not), the event log and the footer all pass now. Out of `KNOWN`.

| Element                                                                    | Ratio | Text on background | Size |
| -------------------------------------------------------------------------- | ----- | ------------------ | ---- |
| `.hh-brand > span > small`                                                 | 3.23  | #898d7d on #faf9f5 | 8px  |
| `nav > button:nth-child(2)`                                                | 3.46  | #828879 on #faf9f5 | 12px |
| `.hh-online-badge`                                                         | 3.61  | #7e8577 on #faf9f5 | 10px |
| `.hh-local-badge`                                                          | 3.61  | #7e8577 on #faf9f5 | 10px |
| `.hh-page-heading > div:nth-child(1) > .hh-eyebrow`                        | 3.04  | #8d927f on #faf9f5 | 8px  |
| `.hh-table-meta`                                                           | 3.11  | #8b907f on #faf9f5 | 9px  |
| `.hh-turn-heading > .hh-eyebrow`                                           | 3.12  | #8d927f on #fdfcf8 | 8px  |
| `.hh-time`                                                                 | 2.45  | #a2a594 on #fdfcf8 | 9px  |
| `.hh-turn-subtitle`                                                        | 2.88  | #949887 on #fdfcf8 | 10px |
| `.hh-roll-hint`                                                            | 2.51  | #a0a390 on #fdfcf8 | 9px  |
| `.hh-players-section > .hh-section-title > span`                           | 2.47  | #a0a590 on #fdfcf8 | 7px  |
| `.current > .hh-player-info > strong > .hh-ai-badge`                       | 2.42  | #9aa38d on #faf5f0 | 6px  |
| `.current > .hh-player-info > small`                                       | 2.4   | #a0a290 on #faf5f0 | 8px  |
| `.current > .hh-player-progress > span > small`                            | 2.38  | #a0a38e on #faf5f0 | 9px  |
| `div[data-testid="player-blue"] > .hh-player-info > strong > .hh-ai-badge` | 2.53  | #9aa38d on #fcfbf7 | 6px  |
| `div[data-testid="player-blue"] > .hh-player-info > small`                 | 2.51  | #a0a290 on #fcfbf7 | 8px  |
| `div[data-testid="player-blue"] > .hh-player-progress > span > small`      | 2.49  | #a0a38e on #fcfbf7 | 9px  |
| `.hh-live-label`                                                           | 2.47  | #a0a590 on #fdfcf8 | 7px  |
| `.hh-event > small`                                                        | 2.05  | #b0b5a0 on #fdfcf8 | 8px  |
| `.hh-legend > span:nth-child(1)`                                           | 2.8   | #929982 on #faf9f5 | 9px  |
| `.hh-legend > span:nth-child(2)`                                           | 2.8   | #929982 on #faf9f5 | 9px  |
| `.hh-legend > button`                                                      | 3.05  | #89937c on #faf9f5 | 9px  |
| `.hh-game-actions > button`                                                | 3.05  | #89937c on #faf9f5 | 9px  |
| `footer > span:nth-child(1)`                                               | 2.79  | #909a80 on #faf9f5 | 12px |
| `footer > span:nth-child(2)`                                               | 2.57  | #9b9f8e on #faf9f5 | 7px  |
| `.hh-game-picker > button`                                                 | 2.95  | #8b967d on #faf9f5 | 9px  |

### hearth-game — dark

**Fixed.** The current player's card redefines `--theme-muted` to `#c2ccbb` in dark mode, so the quiet text on its tinted fill clears 5.4 : 1 for every colour; the roll button's `SPACE` hint is `#d2ddcb` in both appearances (5.3 : 1 on the green). Out of `KNOWN`.

| Element                                              | Ratio | Text on background | Size |
| ---------------------------------------------------- | ----- | ------------------ | ---- |
| `kbd`                                                | 3.45  | #a8b5a0 on #435b48 | 7px  |
| `.current > .hh-player-info > strong > .hh-ai-badge` | 4.29  | #a8b5a0 on #444941 | 6px  |
| `.current > .hh-player-info > small`                 | 4.29  | #a8b5a0 on #444941 | 8px  |
| `.current > .hh-player-progress > span > small`      | 4.29  | #a8b5a0 on #444941 | 9px  |

### estate-setup — dark

**Fixed:** the footnote's dark grey is now `#8291a4` (4.9 : 1); `estate-setup/dark` is checked in CI again.

| Element            | Ratio | Text on background | Size |
| ------------------ | ----- | ------------------ | ---- |
| `.dialog-footnote` | 4.49  | #7b8a9d on #1a2330 | 9px  |

### estate-game — dark

**Fixed:** `.now-label` is now `#7f8ca0` (4.9 : 1) and the activity footer `#8592a5` (5.3 : 1), both in
`games/monopoly/styles/activity.css`; `estate-game/dark` is checked in CI again.

| Element                   | Ratio | Text on background | Size |
| ------------------------- | ----- | ------------------ | ---- |
| `.now-label`              | 3.39  | #657285 on #171f2b | 8px  |
| `.activity-footer > span` | 3.9   | #6f7c8e on #171f2b | 8px  |

### wildrise-setup — light

**Fixed.** Every light-mode text grey in `games/wildrise/WildriseGame.css` under 4.5 : 1 was darkened, hue and saturation kept, to ≥ 4.6 : 1 on the fill it is actually drawn on — the header and sidebar creams, the segmented control's `#f1f2e9`, the setup cards' `#f6f7ee`, and the table's own `#e9e5d8` for the subtitle, badge, camera hint and board footer; `--wr-muted` is now `#6f7467`. Out of `KNOWN`; the guide, How to play and win dialogs were also checked and pass in both appearances.

| Element                                      | Ratio | Text on background | Size |
| -------------------------------------------- | ----- | ------------------ | ---- |
| `a > span`                                   | 4.25  | #737b69 on #fcfbf5 | 11px |
| `.wr-header-note`                            | 2.9   | #929782 on #fcfbf5 | 10px |
| `.wr-online-badge`                           | 3.87  | #7a826a on #fcfbf5 | 10px |
| `.wr-help > span`                            | 4.21  | #737c67 on #fcfbf5 | 11px |
| `.wr-setup > .wr-eyebrow`                    | 3.26  | #85906e on #fcfbf6 | 10px |
| `.wr-setup > .wr-description`                | 3.52  | #828878 on #fcfbf6 | 11px |
| `.wr-field-label > small`                    | 2.97  | #909581 on #fcfbf6 | 10px |
| `.wr-segment > button:nth-child(2)`          | 3.12  | #858b79 on #f1f2e9 | 10px |
| `.wr-segment > button:nth-child(3)`          | 3.12  | #858b79 on #f1f2e9 | 10px |
| `.wr-setup-player:nth-child(1) > div > span` | 2.96  | #919582 on #fcfbf6 | 10px |
| `.wr-setup-player:nth-child(1) > small`      | 2.91  | #919783 on #fcfbf6 | 10px |
| `.wr-setup-player:nth-child(2) > div > span` | 2.96  | #919582 on #fcfbf6 | 10px |
| `.wr-setup-player:nth-child(2) > small`      | 2.91  | #919783 on #fcfbf6 | 10px |
| `.wr-ai-style > small`                       | 3.2   | #899077 on #fcfbf6 | 10px |
| `.wr-rule-toggle > span:nth-child(2)`        | 3.66  | #7e866f on #fcfbf6 | 10px |
| `.wr-small-note`                             | 2.91  | #919780 on #fcfbf6 | 10px |
| `.wr-small-note > span`                      | 2.91  | #919780 on #fcfbf6 | 10px |
| `footer > span:nth-child(1)`                 | 2.87  | #91957f on #f8f7f0 | 10px |
| `footer > span:nth-child(2)`                 | 2.87  | #91957f on #f8f7f0 | 10px |

### wildrise-game — light

**Fixed** with the same greys — the player cards, seat badges, roll panel, event log and footer. The current player's line is the player's colour deepened (mixed 40 % with `#24301f`), ≥ 4.8 : 1 for all four colours, and the roll button's `SPACE` hint is `#eef2e6` (5.4 : 1 on the green). Out of `KNOWN`.

| Element                                                            | Ratio | Text on background | Size |
| ------------------------------------------------------------------ | ----- | ------------------ | ---- |
| `a > span`                                                         | 4.25  | #737b69 on #fcfbf5 | 11px |
| `.wr-header-note`                                                  | 2.9   | #929782 on #fcfbf5 | 10px |
| `.wr-online-badge`                                                 | 3.87  | #7a826a on #fcfbf5 | 10px |
| `.wr-help > span`                                                  | 4.21  | #737c67 on #fcfbf5 | 11px |
| `.wr-players > .wr-section-title > span`                           | 2.9   | #929781 on #fcfbf6 | 10px |
| `.wr-player-active > .wr-player-info > span`                       | 3.14  | #d86b4e on #fcf4ec | 10px |
| `div[data-testid="wildrise-player-blue"] > .wr-player-info > span` | 2.72  | #949982 on #f6f7ee | 10px |
| `.wr-roll-top > div > .wr-eyebrow`                                 | 3.26  | #85906e on #fcfbf6 | 10px |
| `.wr-roll-copy`                                                    | 3.2   | #899078 on #fcfbf6 | 10px |
| `kbd`                                                              | 4.44  | #d7dfcb on #536849 | 10px |
| `.wr-roll-hint`                                                    | 2.95  | #90967f on #fcfbf6 | 10px |
| `.wr-events > .wr-section-title > span`                            | 2.9   | #929781 on #fcfbf6 | 10px |
| `li > p`                                                           | 3.72  | #7c856e on #fcfbf6 | 10px |
| `p > small`                                                        | 2.27  | #a6ab98 on #fcfbf6 | 10px |
| `.wr-new-game`                                                     | 2.79  | #959a85 on #fcfbf6 | 10px |
| `footer > span:nth-child(1)`                                       | 2.87  | #91957f on #f8f7f0 | 10px |
| `footer > span:nth-child(2)`                                       | 2.87  | #91957f on #f8f7f0 | 10px |

### wildrise-game — dark

**Fixed.** In the dark the current player's card is washed with a deep share of the player's colour instead of its pale (which greyed the card out to `#6b6c64`), and its line is the colour lifted 55 % toward white — ≥ 5.6 : 1 for every colour, with the card's quiet text still ≥ 4.5 : 1; the `SPACE` hint is `#eef2e6` in both appearances. Out of `KNOWN`.

| Element                                      | Ratio | Text on background | Size |
| -------------------------------------------- | ----- | ------------------ | ---- |
| `.wr-player-active > .wr-player-info > span` | 1.55  | #d86b4e on #6b6c64 | 10px |
| `kbd`                                        | 2.84  | #a8b5a0 on #536849 | 10px |
