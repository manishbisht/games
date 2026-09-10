import { Dices, Footprints, House, Shield, Swords, Trophy } from 'lucide-react'
import Modal from './Modal'
import type { Rules } from '../game/types'

export default function RulesDialog({ onClose, rules }: { onClose: () => void; rules: Rules }) {
  const items = [
    {
      Icon: Dices,
      title: 'Roll. Then roam.',
      text: `Roll a 6 to bring a piece out of its nest, or move a piece already on the board.${rules.extraTurnOnSix ? ' A 6 gives you another roll.' : ' A 6 does not grant an extra turn in this game.'}`,
    },
    {
      Icon: Footprints,
      title: 'Take the scenic route.',
      text: 'Choose a highlighted piece and follow the perimeter counterclockwise. Its destination glows on the board. Pieces can share a tile and pass each other; stacks never block the path.',
    },
    {
      Icon: Swords,
      title: rules.captures ? 'A friendly little setback.' : 'A peaceful journey.',
      text: rules.captures
        ? 'Land on an opponent to send their pieces back to the nest. Capturing does not grant an extra turn.'
        : 'Captures are off for this game. Players can share every tile without being sent back.',
    },
    {
      Icon: Shield,
      title: rules.safeSpaces ? 'Stars are a safe haven.' : 'Every space is in play.',
      text: rules.safeSpaces
        ? 'The eight star spaces protect every piece on them, including the four colored entry spaces. Share them safely with friends.'
        : 'Star protection is off. When captures are on, even star spaces can be captured.',
    },
    {
      Icon: House,
      title: 'There’s no place like home.',
      text: `Complete the 52-space loop, then follow your own five colored arrow spaces to the central home.${rules.exactHome ? ' You need the exact number to finish; an oversized roll cannot move that piece.' : ' An oversized roll can finish a piece.'}`,
    },
    {
      Icon: Trophy,
      title: 'Bring everyone together.',
      text: `The first player with all ${rules.piecesPerPlayer} pieces home wins. If no move is possible, your turn passes automatically. No three-sixes penalty.`,
    },
  ]
  return (
    <Modal title="A little luck. A few simple rules." onClose={onClose} className="hh-rules-dialog">
      <div className="hh-eyebrow">THE WAY HOME</div>
      <h2>
        A little luck.
        <br />A few simple rules.
      </h2>
      <div className="hh-rule-list">
        {items.map(({ Icon, title, text }) => (
          <div className="hh-rule" key={title}>
            <span>
              <Icon size={21} />
            </span>
            <div>
              <h3>{title}</h3>
              <p>{text}</p>
            </div>
          </div>
        ))}
      </div>
      <button className="hh-primary" onClick={onClose}>
        Got it. Let’s play.
      </button>
    </Modal>
  )
}
