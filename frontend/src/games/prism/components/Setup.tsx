import { ArrowRight, Check, Sparkles, Users } from 'lucide-react'
import type { Difficulty } from '@games/shared/prism/types'
import PlayOptions from '../../../online/PlayOptions'
import { prismGame } from '../../catalog'

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
  disabled = false,
}: {
  options: SetupOptions
  onChange: (next: SetupOptions) => void
  onStart: () => void
  onHelp: () => void
  /** True while the identity is still settling: starting would do nothing. */
  disabled?: boolean
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
        <PlayOptions game="prism" basePath={prismGame.path} seatChoices={[2, 3, 4]}>
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
          <button className="pr-primary pr-start" onClick={onStart} disabled={disabled}>
            Let’s play <ArrowRight size={19} />
          </button>
          <div className="pr-setup-foot">
            <span>
              <i /> Classic rules
            </span>
            <span>About 10 minutes</span>
          </div>
        </PlayOptions>
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
