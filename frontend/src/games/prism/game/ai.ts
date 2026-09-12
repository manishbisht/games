import { cardPoints, nextPlayer, playableCards } from './engine'
import { COLORS } from './types'
import type { Color, Command, Difficulty, GameState } from './types'

// Policy deliberately receives only legal cards, our hand and public card counts.
// Neither the shuffled draw pile nor any opponent's card faces enter its decision.
export function chooseMove(state: GameState, difficulty: Difficulty, random = Math.random): Command {
  const player = state.currentPlayer
  const legal = playableCards(state)
  if (!legal.length) return { type: state.drawnCardId ? 'pass' : 'draw', player }
  const hand = state.players[player].hand
  const colorCounts = Object.fromEntries(
    COLORS.map((color) => [color, hand.filter((c) => c.color === color).length]),
  ) as Record<Color, number>
  let chosen = legal[Math.floor(random() * legal.length)]
  if (difficulty !== 'easy') {
    const threat = state.players[nextPlayer(state)].hand.length <= 2
    const score = (card: typeof chosen) => {
      const colorSupport = card.isWild ? 0 : colorCounts[card.color as Color] * 3
      const pressure = ['draw2', 'draw4', 'skip'].includes(String(card.value)) ? (threat ? 30 : 4) : 0
      return (
        colorSupport +
        pressure +
        cardPoints(card) * (difficulty === 'hard' ? 0.22 : 0.1) -
        (card.isWild && hand.length > 3 ? 18 : 0)
      )
    }
    chosen = [...legal].sort((a, b) => score(b) - score(a))[0]
  }
  const color =
    difficulty === 'easy'
      ? COLORS[Math.floor(random() * 4)]
      : [...COLORS].sort((a, b) => colorCounts[b] - colorCounts[a])[0]
  return { type: 'play', player, cardId: chosen.id, color: chosen.isWild ? color : undefined }
}
