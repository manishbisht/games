/**
 * Gambit's ratings: plain Elo, the system chess players already read.
 *
 * Everyone starts at 1200. The K-factor is 40 for a player's first
 * `PROVISIONAL_GAMES` rated games and 20 after — the FIDE shape: a newcomer's
 * number moves quickly to roughly where they belong, then settles. Until then
 * the rating is shown as provisional.
 *
 * Only games between two people are rated. A bot's strength is a setting, not a
 * rating, and a game against one is recorded but leaves the number alone.
 */
export const START_RATING = 1200
export const PROVISIONAL_GAMES = 10
const K_NEW = 40,
  K_SETTLED = 20

/** The score `rating` is expected to take off `opponent`: 0..1. */
export const expectedScore = (rating: number, opponent: number) => 1 / (1 + 10 ** ((opponent - rating) / 400))

export const kFactor = (gamesPlayed: number) => (gamesPlayed < PROVISIONAL_GAMES ? K_NEW : K_SETTLED)

/**
 * The rating after one game. `score` is 1 for a win, 0.5 for a draw, 0 for a
 * loss; `gamesPlayed` is how many rated games came before this one. Rounded,
 * since nobody wants to read a rating of 1213.6.
 */
export function nextRating(rating: number, opponent: number, score: number, gamesPlayed: number): number {
  return Math.round(rating + kFactor(gamesPlayed) * (score - expectedScore(rating, opponent)))
}
