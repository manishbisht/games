import { cardImage } from '../scene/artwork'
import { cardName } from '../game/engine'
import type { Card } from '../game/types'

export default function CardFace({ card }: { card: Card }) {
  return <img className="pr-card-image" src={cardImage(card)} alt={cardName(card)} draggable={false} />
}
