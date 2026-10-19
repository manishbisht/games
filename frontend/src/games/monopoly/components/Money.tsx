import { useState } from 'react'
import { money } from '@games/shared/estate/board'
import { useCountUp } from '../../../motion/hooks'

/**
 * A balance that counts to its new value, with the change itself floating off
 * it — "+$200" rising in green, "−$350" sinking in red — so a glance at the
 * table says who just paid whom.
 */
export default function CountedMoney({ value }: { value: number }) {
  const shown = useCountUp(value, 900)
  const [last, setLast] = useState(value),
    [deltas, setDeltas] = useState<{ id: number; amount: number }[]>([]),
    [serial, setSerial] = useState(0)
  if (value !== last) {
    setLast(value)
    setSerial(serial + 1)
    setDeltas([...deltas.slice(-2), { id: serial, amount: value - last }])
  }
  return (
    <strong className="counted-money">
      {money(shown)}
      {deltas.map((delta) => (
        <span
          key={delta.id}
          className={`money-delta ${delta.amount > 0 ? 'up' : 'down'}`}
          aria-hidden="true"
          onAnimationEnd={() => setDeltas((all) => all.filter((d) => d.id !== delta.id))}
        >
          {delta.amount > 0 ? '+' : '−'}
          {money(Math.abs(delta.amount))}
        </span>
      ))}
    </strong>
  )
}
