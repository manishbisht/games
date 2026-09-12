import { ArrowRight, Bot, Check, Sparkles, Users } from 'lucide-react'
import type { Difficulty } from '../game/types'

export interface SetupOptions {
  mode: 'ai' | 'local'
  count: number
  difficulty: Difficulty
  names: string[]
}
export default function Setup({
  options,
  onChange,
  onStart,
  onHelp,
}: {
  options: SetupOptions
  onChange: (next: SetupOptions) => void
  onStart: () => void
  onHelp: () => void
}) {
  const update = (next: Partial<SetupOptions>) => onChange({ ...options, ...next })
  return (
    <section className="pr-setup" aria-label="Set up your game">
      <p className="pr-eyebrow">
        <span /> THE MORE, THE MERRIER
      </p>
      <h1>
        A little color.
        <br />
        <em>A little chaos.</em>
      </h1>
      <p className="pr-intro">
        Match a color. Make your move.
        <br />
        Bring a little friendly rivalry to the table.
      </p>
      <div className="pr-setup-card">
        <div className="pr-mode-switch" aria-label="Game mode">
          <button aria-pressed={options.mode === 'ai'} onClick={() => update({ mode: 'ai' })}>
            <Bot size={17} /> Play vs AI
          </button>
          <button aria-pressed={options.mode === 'local'} onClick={() => update({ mode: 'local' })}>
            <Users size={17} /> Local friends
          </button>
        </div>
        <div className="pr-setup-field">
          <div className="pr-field-title">
            <span>Seats at the table</span>
            <small>Including you</small>
          </div>
          <div className="pr-seats">
            {[2, 3, 4].map((n) => (
              <button key={n} aria-pressed={options.count === n} onClick={() => update({ count: n })}>
                <Users size={18} />
                <strong>{n} players</strong>
                {options.count === n && <Check size={13} />}
              </button>
            ))}
          </div>
        </div>
        {options.mode === 'ai' ? (
          <div className="pr-setup-field">
            <div className="pr-field-title">
              <span>A little competition?</span>
            </div>
            <div className="pr-difficulty">
              {(['easy', 'medium', 'hard'] as const).map((level) => (
                <button
                  key={level}
                  aria-pressed={options.difficulty === level}
                  onClick={() => update({ difficulty: level })}
                >
                  {level}
                </button>
              ))}
            </div>
            <p className="pr-field-hint">
              {options.difficulty === 'easy'
                ? 'A relaxed table. Find your rhythm.'
                : options.difficulty === 'medium'
                  ? 'Thoughtful moves. A friendly challenge.'
                  : 'A sharper table. Every card counts.'}
            </p>
          </div>
        ) : (
          <div className="pr-name-grid">
            {Array.from({ length: options.count }, (_, i) => (
              <label key={i}>
                Player {i + 1}
                <input
                  value={options.names[i]}
                  maxLength={20}
                  onChange={(e) =>
                    update({ names: options.names.map((n, j) => (j === i ? e.target.value : n)) })
                  }
                />
              </label>
            ))}
          </div>
        )}
        <button className="pr-primary pr-start" onClick={onStart}>
          Let’s play <ArrowRight size={19} />
        </button>
        <div className="pr-setup-foot">
          <span>
            <i /> Classic rules
          </span>
          <span>About 10 minutes</span>
        </div>
      </div>
      <button className="pr-help-link" onClick={onHelp}>
        New to the table?{' '}
        <span>
          Here’s how to play <ArrowRight size={13} />
        </span>
      </button>
      <div className="pr-menu-note">
        <Sparkles size={15} />
        <span>No accounts. No downloads. Just one more round.</span>
      </div>
    </section>
  )
}
