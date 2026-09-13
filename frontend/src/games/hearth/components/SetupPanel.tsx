import { ArrowRight, Users, Sparkles, SlidersHorizontal } from 'lucide-react'
import { PALETTES, PLAYER_IDS } from '@games/shared/hearth/board'
import type { Control, GameConfig, Mode, Rules } from '@games/shared/hearth/types'
import { useState } from 'react'
import PlayOptions from '../../../online/PlayOptions'
import { hearthGame } from '../../catalog'

export default function SetupPanel({
  initialConfig,
  onStart,
  onPreview,
}: {
  initialConfig: GameConfig
  onStart: (config: GameConfig) => void
  onPreview?: (config: GameConfig) => void
}) {
  const [config, setConfig] = useState<GameConfig>(() => ({
    ...initialConfig,
    controls: PLAYER_IDS.map((_, index) =>
      index === 0
        ? 'human'
        : initialConfig.controls?.[index] === 'human'
          ? 'medium'
          : initialConfig.controls?.[index] || 'medium',
    ),
  }))
  function update(next: Partial<GameConfig>) {
    const merged = { ...config, ...next }
    setConfig(merged)
    onPreview?.(merged)
  }
  function rule<K extends keyof Rules>(key: K, value: Rules[K]) {
    update({ rules: { ...config.rules, [key]: value } })
  }
  const count = config.playerCount || 4,
    mode = config.mode || 'classic'
  return (
    <div className="hh-setup">
      <div className="hh-eyebrow">
        <span className="hh-tiny-star">✦</span> THERE’S ROOM AT THE TABLE
      </div>
      <h2>Gather around.</h2>
      <p className="hh-setup-intro">A familiar favorite. A new way home.</p>
      <PlayOptions game="hearth" basePath={hearthGame.path} seatChoices={[2, 3, 4]}>
        <div className="hh-field-title">
          Your kind of game <span>01</span>
        </div>
        <div className="hh-mode-options">
          {(['classic', 'quick', 'custom'] as Mode[]).map((item, i) => {
            const Icon = [Users, Sparkles, SlidersHorizontal][i]
            return (
              <button
                key={item}
                aria-pressed={mode === item}
                className={mode === item ? 'selected' : ''}
                onClick={() => update({ mode: item, rules: item === 'custom' ? config.rules : undefined })}
              >
                <Icon size={15} />
                {item[0].toUpperCase() + item.slice(1)}
              </button>
            )
          })}
        </div>
        <p className="hh-field-note">
          {mode === 'classic'
            ? 'The full journey. Four pieces, one way home.'
            : mode === 'quick'
              ? 'A little quicker. Two pieces, all the fun.'
              : 'Your table, your rules. Make it your own.'}
        </p>
        <div className="hh-field-title">
          A seat for everyone <span>02</span>
        </div>
        <div className="hh-player-count">
          {[2, 3, 4].map((n) => (
            <button
              key={n}
              aria-label={`${n} players`}
              aria-pressed={count === n}
              onClick={() => update({ playerCount: n })}
            >
              {n} players
            </button>
          ))}
        </div>
        <div className="hh-setup-players">
          {PLAYER_IDS.slice(0, count).map((id, index) => (
            <div
              key={id}
              className="hh-setup-player"
              style={{ '--player-color': PALETTES[id].color } as React.CSSProperties}
            >
              <span className="hh-piece-mini" aria-hidden="true">
                <i />
              </span>
              <label className="hh-name-input">
                <span className="sr-only">{PALETTES[id].name} player name</span>
                <input
                  maxLength={20}
                  aria-label={`${PALETTES[id].name} player name`}
                  value={config.names?.[index] ?? PALETTES[id].name}
                  onChange={(e) => {
                    const names = PLAYER_IDS.map((id, i) => config.names?.[i] ?? PALETTES[id].name)
                    names[index] = e.target.value
                    update({ names })
                  }}
                />
              </label>
              {index === 0 ? (
                <span className="play-options-role">You</span>
              ) : (
                <select
                  aria-label={`${PALETTES[id].name} player type`}
                  value={config.controls?.[index] || 'medium'}
                  onChange={(e) => {
                    const controls = PLAYER_IDS.map(
                      (_, i) => config.controls?.[i] || (i === 0 ? 'human' : 'medium'),
                    )
                    controls[index] = e.target.value as Control
                    update({ controls })
                  }}
                >
                  <option value="easy">Bot · Easy</option>
                  <option value="medium">Bot · Medium</option>
                  <option value="hard">Bot · Hard</option>
                </select>
              )}
            </div>
          ))}
        </div>
        {mode === 'custom' && (
          <div className="hh-custom-rules">
            <label>
              Pieces per player
              <select
                aria-label="Pieces per player"
                value={config.rules?.piecesPerPlayer || 4}
                onChange={(e) => rule('piecesPerPlayer', Number(e.target.value))}
              >
                {[1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            {(
              [
                ['extraTurnOnSix', 'Bonus roll on 6'],
                ['safeSpaces', 'Protect star spaces'],
                ['captures', 'Allow captures'],
                ['exactHome', 'Exact roll to finish'],
              ] as const
            ).map(([key, title]) => (
              <label key={key}>
                {title}
                <input
                  type="checkbox"
                  checked={config.rules?.[key] ?? true}
                  onChange={(e) => rule(key, e.target.checked)}
                />
              </label>
            ))}
          </div>
        )}
        <button className="hh-primary" onClick={() => onStart(config)}>
          Start game <ArrowRight size={18} />
        </button>
        <p className="hh-local-note">
          <Users size={13} /> You and {count - 1} {count === 2 ? 'bot opponent' : 'bot opponents'}.
        </p>
      </PlayOptions>
    </div>
  )
}
