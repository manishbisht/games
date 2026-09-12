import { cardImage } from '../scene/artwork'
import { cardName } from '@games/shared/prism'
import type { Card } from '@games/shared/prism/types'

export default function CardFace({ card }: { card: Card }) {
  return <img className="pr-card-image" src={cardImage(card)} alt={cardName(card)} draggable={false} />
}
