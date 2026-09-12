import type { Player } from '@games/shared/estate/types'

export default function TokenIcon({
  token,
  color,
  size = 42,
}: {
  token: Player['token']
  color: string
  size?: number
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
      className="token-icon"
      style={{ color }}
    >
      <ellipse cx="32" cy="55" rx="20" ry="5" fill="currentColor" opacity=".09" />
      {token === 'rocket' && (
        <g transform="rotate(20 32 32)">
          <path d="M22 36 15 48 24 45M42 36 49 48 40 45" fill="currentColor" opacity=".7" />
          <path d="M32 6C19 18 20 33 25 46H39C44 33 45 18 32 6Z" fill="currentColor" />
          <path d="M32 6C30 20 29 37 32 46H39C44 33 45 18 32 6Z" fill="#fff" opacity=".22" />
          <circle cx="32" cy="26" r="6" fill="#28313e" />
          <circle cx="31" cy="25" r="3.5" fill="#bacad0" />
          <path d="m27 48 5 10 5-10" fill="currentColor" opacity=".45" />
        </g>
      )}
      {token === 'gem' && (
        <g>
          <path d="m12 24 10-13h20l10 13-20 31Z" fill="currentColor" />
          <path d="m12 24 20 31-9-31Z" fill="#172339" opacity=".25" />
          <path d="m32 55 9-31h11Z" fill="#172339" opacity=".4" />
          <path d="m22 11 1 13h18l1-13-10 7Z" fill="#fff" opacity=".2" />
          <path d="m23 24 9-6 9 6-9 31Z" fill="#fff" opacity=".12" />
        </g>
      )}
      {token === 'car' && (
        <g>
          <path d="m10 33 8-6 8-13h20l9 14v15L10 49Z" fill="currentColor" />
          <path d="m21 27 8-10h14l6 9Z" fill="#1c393b" opacity=".7" />
          <path d="m10 33 28 2 17-7v15l-18 9-27-3Z" fill="currentColor" />
          <path d="m38 35 17-7v15l-18 9Z" fill="#162e34" opacity=".3" />
          <ellipse cx="19" cy="47" rx="5" ry="7" fill="#28343c" />
          <ellipse cx="45" cy="45" rx="5" ry="7" fill="#28343c" />
          <ellipse cx="19" cy="47" rx="2" ry="3" fill="#b4c8c4" />
          <ellipse cx="45" cy="45" rx="2" ry="3" fill="#b4c8c4" />
          <path d="m12 36 8 1v4l-8-1Z" fill="#fff" opacity=".6" />
        </g>
      )}
      {token === 'crown' && (
        <g>
          <path d="m12 19 12 11 8-18 9 18 12-11-5 30H17Z" fill="currentColor" />
          <path d="m32 12 9 18 12-11-5 30H32Z" fill="#fff" opacity=".16" />
          <path d="M17 43h31v9H17Z" fill="currentColor" />
          <path d="M17 47h31v5H17Z" fill="#1c2038" opacity=".18" />
          <circle cx="12" cy="18" r="4" fill="currentColor" />
          <circle cx="32" cy="11" r="4" fill="currentColor" />
          <circle cx="53" cy="18" r="4" fill="currentColor" />
          <path d="m32 30 4 6-4 6-4-6Z" fill="#fff" opacity=".55" />
        </g>
      )}
    </svg>
  )
}
