# Device performance

Two parts: a checklist for measuring a real mid-range Android phone over Chrome remote debugging, and the
numbers from a desktop approximation of one (`frontend/tests/device-perf.spec.ts`) to compare against.

## Real-device checklist

**Set up once.** On the phone: Settings → About phone → tap _Build number_ seven times → Developer options →
_USB debugging_ on. Connect by USB, open Chrome on the desktop at `chrome://inspect/#devices`, accept the
prompt on the phone. Note the model, Android and Chrome versions, and the GPU (`chrome://gpu` on the phone,
_GL_RENDERER_). Charge above 50 %, battery saver off, other apps closed.

**Before each game.** Open a new tab on the phone (the stage remembers a slow device for the whole tab session,
see below), click _inspect_ next to it, and in DevTools tick _Network → Disable cache_ and set throttling to
_No throttling_ (the phone's own network is the point). Record each item three times and keep the median.

| #   | What                | How                                                                                                                                                                                                           | Target (mid-range, 4G)                             |
| --- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1   | Load: FCP, LCP      | Performance panel → _Record and reload_ on `/#/<game>`. Read FCP and LCP off the _Timings_ track.                                                                                                             | FCP ≤ 1.8 s, LCP ≤ 2.5 s                           |
| 2   | Board's first frame | Same recording: the first frame in the _Frames_ track that shows the board (hover the screenshots strip).                                                                                                     | ≤ 3 s                                              |
| 3   | Bytes               | Network panel footer: _transferred_ for the load in (1).                                                                                                                                                      | note it; compare release to release                |
| 4   | A turn's frames     | Start a game against a bot. Record ~10 s covering your move and the bot's reply. _Frames_ track: count dropped/partial frames; _Main_: long tasks. Rendering drawer → _Frame rendering stats_ shows live FPS. | ≥ 30 fps throughout, p50 near 60; no task > 200 ms |
| 5   | Quality tier        | Console: `sessionStorage.getItem('games-quality')`. `null` or `'2'` = full; `'1'` = pixel ratio capped at 1.25; `'0'` = pixel ratio 1 and no shadows. Read it after (4), and again after 5 minutes of play.   | stays at 2 (or 1) on a mid-range phone             |
| 6   | Memory              | DevTools → _More tools → Performance monitor_: _JS heap size_ and _DOM nodes_ after (4) and after 5 minutes. A heap snapshot (Memory panel) if it keeps growing.                                              | heap < 100 MB and flat over time                   |
| 7   | Input latency       | Performance panel _Interactions_ track while tapping Roll / Draw / a piece.                                                                                                                                   | INP ≤ 200 ms                                       |
| 8   | Heat                | Five minutes of play, then repeat (4) and (5). A drop in FPS or tier is thermal throttling.                                                                                                                   | no tier drop from heat alone                       |
| 9   | Touch               | Orbit and pinch the board; drag a page scroll that starts on the board (it must scroll the page — `allowPageScroll`); rotate the phone mid-turn.                                                              | no stuck gestures, no blank canvas                 |

**How the tier moves.** The stage only measures frames it actually animated (an idle board renders nothing).
Once it has ~2.5 s of animated frames, if more than 60 % of that time was spent in frames slower than 22 ms it
steps one tier down (`frontend/src/motion/stage.ts`, `measure`/`applyQuality`). It never steps back up within a
tab session, and a new board in the same tab starts at the remembered tier — so to measure full quality again,
open a new tab or run `sessionStorage.removeItem('games-quality')` and reload. A game can also thin its own
extras (particles, ambient motion) when told the tier dropped (`stage.onQuality`).

Paste results into a copy of the table below with the device in the heading.

## Desktop approximation

`npm run test:device` (or `DEVICE_PERF=1 npx playwright test tests/device-perf.spec.ts` from `frontend/`, with
the built site and a backend running). Per game, in a fresh context: Playwright's _Pixel 7_ descriptor (412 ×
915, DPR 2.625, touch, mobile UA), CPU slowed 6× (`Emulation.setCPUThrottlingRate`), DevTools' _Fast 4G_
(9 Mbps × 0.9 down, 1.5 Mbps × 0.9 up, 165 ms RTT) with the cache disabled. It loads `/#/<game>`, then starts
a bot game, makes the first move and watches 8 s of frames (main-thread `requestAnimationFrame` intervals),
then reads the tier and `JSHeapUsedSize`. Results also go to `frontend/test-results/device-perf.json`.

Run 2026-10-19 on an Apple M3 Pro, Chrome 155 (headless), production build (`vite build` + `vite preview`)
against a local `wrangler dev` backend. Two runs:

| Game     | Run | FCP ms | LCP ms | Board ms | Frames (8 s) | p50 ms | p95 ms | p99 ms | Max ms | Frames > 33 ms | Tier reached | JS heap MB |
| -------- | --- | -----: | -----: | -------: | -----------: | -----: | -----: | -----: | -----: | -------------: | ------------ | ---------: |
| Gambit   | 1   |   1260 |   2644 |     2590 |          466 |   16.7 |   33.3 |   33.4 |     67 |              5 | 2            |       16.5 |
|          | 2   |   1088 |   2344 |     1434 |          468 |   16.7 |   16.8 |   50.0 |     50 |              8 | 2            |       18.5 |
| Hearth   | 1   |   1156 |   1788 |     1748 |          468 |   16.7 |   33.3 |   66.6 |    167 |             12 | 2            |       13.0 |
|          | 2   |    992 |   1664 |     1634 |          514 |   16.7 |   16.8 |   33.3 |     50 |              1 | 2            |       10.7 |
| Estate   | 1   |   1080 |   1708 |     1656 |          492 |   16.7 |   33.3 |   50.0 |    250 |             10 | 2            |       13.8 |
|          | 2   |    988 |   1536 |     1511 |          508 |   16.7 |   16.8 |   33.3 |     50 |              3 | 2            |       13.3 |
| Prism    | 1   |   1020 |   2684 |     1499 |          459 |   16.7 |   16.7 |   16.8 |    517 |              3 | 2            |       13.0 |
|          | 2   |   1032 |   2356 |     1393 |          486 |   16.7 |   16.7 |   16.8 |     33 |              0 | 2            |       11.9 |
| Wildrise | 1   |   1180 |   1688 |     1670 |          434 |   16.7 |   33.4 |   33.5 |    183 |             14 | **0**        |   **49.2** |
|          | 2   |    996 |   1448 |     1440 |          339 |   16.7 |   33.4 |   50.1 |    200 |             28 | **0**        |   **49.8** |

_Board ms_ is when the first `<canvas>` appeared (not when it first drew). _Tier reached_ `2` means
`games-quality` was never written.

**Reading it.**

- **Load is fine on Fast 4G**: FCP ≈ 1.0–1.3 s everywhere; LCP is inside 2.5 s for Hearth, Estate and Wildrise
  and borderline for Gambit and Prism (2.3–2.7 s). Both paint their largest element late — check which element
  the LCP entry names on a real device (Performance panel → LCP marker) before optimising.
- **Turns hold 60 fps at the median** in every game; the tail differs. Prism is the smoothest (p99 16.8 ms).
- **Wildrise is the outlier on both runs**: the only game whose stage stepped down — all the way to tier 0
  (no shadows, DPR 1) within one turn — with 2–4× the long frames of the others and a ~50 MB heap against
  11–18 MB elsewhere. Worth a profile by its owner: something allocates heavily or keeps large buffers alive.
- What this cannot show: the phone's GPU. WebGL here ran on the M3's GPU through ANGLE/Metal, so fill-rate
  and shader cost (pixel ratio 2.6, shadows) are much cheaper than on a Mali/Adreno mid-ranger, and frame
  numbers are an optimistic CPU story. That is what the real-device checklist is for; expect the tier to drop
  sooner there.
