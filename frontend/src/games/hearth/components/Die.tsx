const positions: Record<number, number[]> = {
  1: [4],
  2: [0, 8],
  3: [0, 4, 8],
  4: [0, 2, 6, 8],
  5: [0, 2, 4, 6, 8],
  6: [0, 2, 3, 5, 6, 8],
}
function Face({ value, className }: { value: number; className: string }) {
  return (
    <div className={`hh-die-face ${className}`}>
      {Array.from({ length: 9 }, (_, i) => (
        <i key={i} className={positions[value]?.includes(i) ? 'pip' : ''} />
      ))}
    </div>
  )
}
/**
 * The sidebar's die, in step with the one on the board: it tumbles while the
 * board's die is in the air and, when the number lands, drops onto it with a
 * bounce. `throws` counts every roll so far; a new one remounts the cube, so
 * the landing starts mid-tumble and the face never visibly swaps.
 */
export default function Die({ value, rolling, throws }: { value: number; rolling: boolean; throws: number }) {
  const [top, right] = (
    { 1: [3, 2], 2: [3, 6], 3: [5, 1], 4: [2, 1], 5: [3, 1], 6: [3, 5] } as Record<number, number[]>
  )[value]
  return (
    <div className={`hh-die-stage ${rolling ? 'is-rolling' : 'is-landed'}`} aria-hidden="true">
      <div className="hh-die-shadow" key={`shadow-${throws}`} />
      <div className="hh-die-cube" key={throws}>
        <Face value={value} className="front" />
        <Face value={top} className="top" />
        <Face value={right} className="right" />
        <Face value={7 - value} className="back" />
        <Face value={7 - top} className="bottom" />
        <Face value={7 - right} className="left" />
      </div>
    </div>
  )
}
