import { ArrowRight, Layers, Megaphone, Palette, Trophy } from 'lucide-react'
import Dialog from './Dialog'
import CardFace from './CardFace'
import { createDeck } from '@games/shared/prism'

export default function Rules({ onClose }: { onClose: () => void }) {
  const deck = createDeck()
  return (
    <Dialog title="How to play Prism" onClose={onClose}>
      <p className="pr-eyebrow">A SEAT AT THE TABLE</p>
      <h2>A few colorful rules.</h2>
      <p className="pr-dialog-copy">Be the first to play every card in your hand.</p>
      <div className="pr-rules-steps">
        <div>
          <Palette />
          <p>
            <strong>Match & make a move</strong>Play a card matching the active color, number, or action. Tap
            a glowing card to select it, then tap again or press Play card.
          </p>
        </div>
        <div>
          <Layers />
          <p>
            <strong>Draw when you need to</strong>Draw one card. If it’s playable, play that card or keep it.
            Otherwise your turn passes. Penalties skip a turn; there’s no stacking in classic mode.
          </p>
        </div>
        <div>
          <Megaphone />
          <p>
            <strong>One card? Call Prism!</strong>Call with two cards before playing, or call with one before
            the next player plays or draws. Until then, anyone can catch you for two cards. AI gives you a
            short moment before its move.
          </p>
        </div>
        <div>
          <Trophy />
          <p>
            <strong>Clear your hand</strong>Your final card wins the round. Its penalty resolves first. Score
            opponents’ remaining cards: numbers at face value, actions 20, wilds 50.
          </p>
        </div>
      </div>
      <details className="pr-special-rules">
        <summary>Meet the special cards</summary>
        {(['skip', 'reverse', 'draw2', 'wild', 'draw4'] as const).map((value) => {
          const card = deck.find((c) => c.value === value)!
          return (
            <div className="pr-rule-card" key={value}>
              <CardFace card={card} />
              <p>
                <strong>{card.visual.label}</strong>
                {value === 'skip'
                  ? 'Skip the next player’s turn.'
                  : value === 'reverse'
                    ? 'Reverse the direction. With two players, you play again.'
                    : value === 'draw2'
                      ? 'The next player draws two and misses a turn.'
                      : value === 'wild'
                        ? 'Play on any color, then choose the next active color.'
                        : 'Choose a color; the next player draws four and misses a turn. Legal only when you have no card of the active color.'}
              </p>
            </div>
          )
        })}
      </details>
      <p className="pr-fine-print">
        Seven cards per player. A numbered card opens the round; action cards stay in the shuffled deck. Empty
        deck? We recycle the discards, keeping the top card. If all cards are held and nobody can play, the
        round is a draw. Play against bots or meet friends in an online room.
      </p>
      <button className="pr-primary" onClick={onClose}>
        Back to the table <ArrowRight size={17} />
      </button>
    </Dialog>
  )
}
