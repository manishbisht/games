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
