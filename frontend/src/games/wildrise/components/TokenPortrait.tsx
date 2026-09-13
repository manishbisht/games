import { PALETTES } from '@games/shared/wildrise/board'
import type { PlayerId } from '@games/shared/wildrise/types'

export default function TokenPortrait({ id, size = 42 }: { id: PlayerId; size?: number }) {
  const { color, pale, animal } = PALETTES[id]
  return (
    <span
      className="wr-token-portrait"
      style={{ background: pale, width: size, height: size }}
      title={animal}
    >
      <svg viewBox="0 0 48 48" width={size * 0.83} height={size * 0.83} aria-hidden="true">
        {id === 'red' ? (
          <>
            <path d="m10 23-1-17 14 10L38 6l1 19-15 17Z" fill={color} />
            <path d="m10 23 14 5 15-3-15 16Z" fill="#fff3d7" />
            <path d="m19 29 5 5 5-5" fill="#39443a" />
          </>
        ) : id === 'blue' ? (
          <>
            <path d="M9 8 21 14 38 8 37 34Q24 47 11 34Z" fill={color} />
            <circle cx="17" cy="24" r="8" fill="#fff3d7" />
            <circle cx="31" cy="24" r="8" fill="#fff3d7" />
            <path d="m21 31 3 5 3-5" fill="#dcaa58" />
          </>
        ) : id === 'green' ? (
          <>
            <ellipse cx="16" cy="13" rx="6" ry="13" fill={color} />
            <ellipse cx="32" cy="13" rx="6" ry="13" fill={color} />
            <ellipse cx="16" cy="12" rx="2" ry="8" fill="#fff3d7" />
            <ellipse cx="32" cy="12" rx="2" ry="8" fill="#fff3d7" />
            <ellipse cx="24" cy="31" rx="17" ry="14" fill={color} />
            <ellipse cx="24" cy="37" rx="8" ry="5" fill="#fff3d7" />
          </>
        ) : (
          <>
            <circle cx="11" cy="13" r="8" fill={color} />
            <circle cx="37" cy="13" r="8" fill={color} />
            <circle cx="11" cy="13" r="4" fill="#fff3d7" />
            <circle cx="37" cy="13" r="4" fill="#fff3d7" />
            <circle cx="24" cy="27" r="18" fill={color} />
            <ellipse cx="24" cy="34" rx="9" ry="7" fill="#fff3d7" />
            <ellipse cx="24" cy="32" rx="4" ry="3" fill="#39443a" />
          </>
        )}
        <circle cx={id === 'blue' ? 17 : 17} cy={id === 'green' ? 29 : 24} r="2" fill="#293e35" />
        <circle cx="31" cy={id === 'green' ? 29 : 24} r="2" fill="#293e35" />
      </svg>
    </span>
  )
}
