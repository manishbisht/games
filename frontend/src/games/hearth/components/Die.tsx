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
export default function Die({ value, rolling }: { value: number; rolling: boolean }) {
  const [top, right] = (
    { 1: [3, 2], 2: [3, 6], 3: [5, 1], 4: [2, 1], 5: [3, 1], 6: [3, 5] } as Record<number, number[]>
  )[value]
  return (
    <div className={`hh-die-stage ${rolling ? 'is-rolling' : ''}`} aria-hidden="true">
      <div className="hh-die-shadow" />
      <div className="hh-die-cube">
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
