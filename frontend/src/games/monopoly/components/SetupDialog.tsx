import { useState } from 'react'
import { ArrowRight, Check, Minus, Plus, Sparkles, Users } from 'lucide-react'
import type { GameState, PlayerConfig } from '@games/shared/estate/types'
import { DEFAULT_PLAYERS, PLAYER_STYLES } from '@games/shared/estate/board'
import TokenIcon from './TokenIcon'
import Dialog from './Dialog'
import PlayOptions from '../../../online/PlayOptions'
import { estateGame } from '../../catalog'

export default function SetupDialog({
  onClose,
  onStart,
  inProgress,
}: {
  onClose: () => void
  onStart: (players: PlayerConfig[], mode: GameState['mode']) => void
  inProgress: boolean
}) {
  const [players, setPlayers] = useState(DEFAULT_PLAYERS),
    [mode, setMode] = useState<GameState['mode']>('classic')
  const update = (id: number, patch: Partial<PlayerConfig>) =>
    setPlayers((p) => p.map((player, i) => (i === id ? { ...player, ...patch } : player)))
  return (
    <Dialog
      title="A seat at the table."
      eyebrow="LET'S PLAY ESTATE"
      onClose={onClose}
      className="setup-dialog"
    >
      <p className="dialog-description">
        A little luck, a good investment, and some friendly rivalry. Make this game your own.
      </p>
      <PlayOptions game="estate" basePath={estateGame.path} seatChoices={[2, 3, 4]}>
        <div className="section-label">
          <span>
            <Users size={16} /> PLAYERS
          </span>
          <div className="stepper">
            <button
              aria-label="Remove player"
              disabled={players.length <= 2}
              onClick={() => setPlayers((p) => p.slice(0, -1))}
            >
              <Minus size={15} />
            </button>
            <strong>{players.length}</strong>
            <button
              aria-label="Add player"
              disabled={players.length >= 4}
              onClick={() => setPlayers((p) => [...p, DEFAULT_PLAYERS[p.length]])}
            >
              <Plus size={15} />
            </button>
          </div>
        </div>
        <div className="setup-players">
          {players.map((p, i) => (
            <div className="setup-player" key={i}>
              <div
                className="token-well"
                style={{ '--player-color': PLAYER_STYLES[i].color } as React.CSSProperties}
              >
                <TokenIcon {...PLAYER_STYLES[i]} size={40} />
              </div>
              <input
                aria-label={`Player ${i + 1} name`}
                value={p.name}
                maxLength={18}
                onChange={(e) => update(i, { name: e.target.value })}
              />
              <span className="play-options-role">{i === 0 ? 'You' : 'Bot'}</span>
            </div>
          ))}
        </div>
        <div className="section-label">
          <span>
            <Sparkles size={16} /> YOUR GAME, YOUR PACE
          </span>
        </div>
        <div className="mode-options">
          {(['classic', 'quick'] as const).map((m) => (
            <button
              key={m}
              className={`mode-option ${mode === m ? 'selected' : ''}`}
              onClick={() => setMode(m)}
            >
              <span>
                {m === 'classic' ? 'The classic' : 'Quick & spirited'}
                {mode === m && <Check size={16} />}
              </span>
              <small>
                {m === 'classic'
                  ? '$1,500 starting cash. The full experience.'
                  : '$1,000 starting cash. Rents rise from round 15.'}
              </small>
            </button>
          ))}
        </div>
        {inProgress && (
          <p className="warning-copy">Starting a new game will replace the saved game at this table.</p>
        )}
        <button className="primary-button full-width" onClick={() => onStart(players, mode)}>
          Start game <ArrowRight size={19} />
        </button>
        <p className="dialog-footnote">2–4 players · You + bot opponents · Automatically saved</p>
      </PlayOptions>
    </Dialog>
  )
}
