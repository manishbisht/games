import { ArrowRight, Bot, Check, Leaf, Users } from 'lucide-react'
import type { Control, GameConfig } from '../game/types'
import { PALETTES, PLAYER_IDS } from '../game/board'
import TokenPortrait from './TokenPortrait'

export interface SetupOptions { count: number; mode: 'local' | 'ai'; names: string[]; style: Control; exact: boolean }
export function toConfig(options: SetupOptions): GameConfig {
  return { playerCount: options.count, names: options.names, controls: PLAYER_IDS.slice(0, options.count).map((_, i) => options.mode === 'ai' && i > 0 ? options.style : 'human'), rules: { exactFinish: options.exact } }
}
export default function Setup({ options, onChange, onStart }: { options: SetupOptions; onChange: (options: SetupOptions) => void; onStart: () => void }) {
  return <section className="wr-setup" aria-labelledby="wr-setup-title">
    <div className="wr-eyebrow"><Leaf size={13} /> PULL UP A CHAIR</div>
    <h2 id="wr-setup-title">A little luck.<br /><em>A wild adventure.</em></h2>
    <p className="wr-description">Climb a little higher. Take a little tumble.<br />There’s a story in every roll.</p>
    <div className="wr-segment wr-mode" aria-label="Game mode">
      <button aria-pressed={options.mode === 'local'} onClick={() => onChange({ ...options, mode: 'local' })}><Users size={16} /> Local friends</button>
      <button aria-pressed={options.mode === 'ai'} onClick={() => onChange({ ...options, mode: 'ai' })}><Bot size={16} /> Play with AI</button>
    </div>
    <div className="wr-field-label"><span>How many at the table?</span><small>Including you</small></div>
    <div className="wr-segment wr-count">{[2, 3, 4].map(count => <button key={count} aria-pressed={options.count === count} onClick={() => onChange({ ...options, count })}>{count} players</button>)}</div>
    <div className="wr-setup-players">{PLAYER_IDS.slice(0, options.count).map((id, i) => <div className="wr-setup-player" key={id}>
      <TokenPortrait id={id} size={38} />
      <div><input aria-label={`${PALETTES[id].name} player name`} value={options.names[i]} maxLength={18} placeholder={PALETTES[id].name} onChange={e => onChange({ ...options, names: options.names.map((name, index) => index === i ? e.target.value : name) })} /><span>{PALETTES[id].animal} miniature</span></div>
      <small>{options.mode === 'ai' && i > 0 ? <><Bot size={12} /> AI</> : options.mode === 'ai' ? 'You' : `Player ${i + 1}`}</small>
    </div>)}</div>
    {options.mode === 'ai' && <label className="wr-ai-style"><span>Table personality</span><select value={options.style} onChange={e => onChange({ ...options, style: e.target.value as Control })}><option value="casual">Casual · take it easy</option><option value="fast">Fast · keep it moving</option><option value="fun">Fun · a little expressive</option></select><small>Same fair dice. A different pace.</small></label>}
    <label className="wr-rule-toggle"><input type="checkbox" checked={options.exact} onChange={e => onChange({ ...options, exact: e.target.checked })} /><span>Exact roll to finish</span><span className="wr-switch" aria-hidden="true"><Check size={11} /></span></label>
    <button className="wr-primary wr-start" onClick={onStart}>Start game <ArrowRight size={18} /></button>
    <p className="wr-small-note">{options.mode === 'ai' ? `You + ${options.count - 1} ${options.count === 2 ? 'AI companion' : 'AI companions'}` : 'One device. Good company.'}<span>First player chosen at random.</span></p>
  </section>
}
