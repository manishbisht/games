# Chess design

Add Gambit, a complete 3D chess game, to the existing React game collection at `/chess` (hash routing). Preserve existing games and ongoing stylesheet edits. The user's detailed brief authorizes the implementation.

Use chess.js for rules, an immutable serializable game state for the source of truth, a replaceable worker AI, and Three.js for presentation. A turn is committed only by the rules engine. Rendering receives positions, legal moves, and the last move; it cannot invent moves. Persist the initial FEN and full move records to preserve repetition and undo semantics. Clock timestamps use elapsed wall time and survive background tabs and reloads.

The opening screen shows the physical board beside a setup panel. Local and AI modes offer optional 10-minute clocks. AI allows either side and three search strengths. During play the panel shows players, clocks, captures, SAN history, and controls. Promotion uses original 3D piece previews. Endings include checkmate, stalemate, repetition, fifty moves, insufficient material, timeout, resignation, and local agreement. Repetition and fifty moves are automatically adjudicated in this casual game.

Visual direction: warm paper, walnut frame, cream and moss board squares, turned ivory and dark walnut pieces, brass accents, studio lighting. Centered orbit camera, zoom, smooth flip, lifted piece travel, castling rook travel, and quiet check indicators. All geometry is procedural and original. Keyboard square navigation, screen reader status, native modal focus, reduced motion, contrast settings, and mobile layouts are required.

Verify rules with position fixtures and full game sequences. Verify browser flows for local moves, illegal rejection, capture, undo, checkmate, AI, setup, orientation, keyboard play, and mobile layout. Build and lint the complete frontend and run existing regression tests.
