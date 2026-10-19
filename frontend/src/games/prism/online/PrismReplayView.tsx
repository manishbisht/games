import { useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { ArrowRightLeft, Bot, Check, Hand, Layers, Sparkles, Trophy, Volume2, VolumeX } from 'lucide-react'
import { cardName } from '@games/shared/prism'
import { COLOR_HEX } from '@games/shared/prism/types'
import type { GameState } from '@games/shared/prism/types'
import type { ReplayViewProps } from '../../../online/games'
import { replayHoldMs } from '../../../online/replayTiming'
import { useSound } from '../../../motion/sound'
import { sound } from '../game/audio'
import { seatSide, TOKEN_COLORS, TOKENS } from '../game/seats'
import { cueFor, withCue } from '../components/cues'
import type { Cues } from '../components/cues'
import TableScene from '../scene/TableScene'
import { tableView } from '../scene/createScene'
import type { TableHost, TableState, TableView } from '../scene/createScene'
import '../PrismGame.css'

/**
 * A finished round, watched again from the rail. Every state in a replay is
 * the spectator's view, so no hand is ever face up: the table is the one a
 * watcher sees live — fans of backs at every seat, each play lifted off its
 * fan and flipped onto the pile, draws dealt off the deck, effects, the call,
 * the winning rosette — and the badges round it count the cards.
 *
 * The next state, while playing, is told the way the live table tells it, at
 * the page's speed and fitted into the time that state is on screen. Anything
 * else — a scrub, a step, a jump — lands at once.
 */
export default function PrismReplayView({
  states,
  index,
  playing,
  speed,
  players,
  onReady,
}: ReplayViewProps) {
  const game = states[index].state as GameState
  // Told only when it follows on from the state before it during playback.
  const [at, setAt] = useState({ index, told: false })
  if (at.index !== index) setAt({ index, told: playing && index === at.index + 1 })
  const within = replayHoldMs(states, index, speed)
  const table = useMemo<TableState>(
    () => ({ game, viewer: 0, menu: false, watching: true, instant: !at.told, tempo: { speed, within } }),
    [game, at.told, speed, within],
  )

  const [view, setView] = useState<TableView | null>(null)
  const [cues, setCues] = useState<Cues>({})
  const [soundOn, setSoundOn] = useSound('prism', true)
  const host: TableHost = {
    view: setView,
    // Nobody's hand is on screen: every card flies to and from the felt.
    slot: () => null,
    cue: (cue) => {
      if (cue.kind === 'sound') {
        if (soundOn) sound(cue.sound, cue.pan)
      } else setCues((current) => withCue(current, cue))
    },
    ready: onReady,
  }

  // What the table is showing, which trails `game` until its story has landed.
  const shown = view && view.game.round === game.round ? view : tableView(game)
  const now = shown.game,
    top = shown.top,
    count = now.players.length,
    last = now.events.at(-1)
  const nameOf = (player: number) => players[player]?.name ?? now.players[player]?.name ?? ''
  const winner = now.status === 'won' && now.winner !== null ? now.winner : null

  return (
    <div className="pr-replay" aria-busy={shown.busy || undefined} data-sequence={shown.sequence}>
      <div className="pr-scene-wrap">
        <TableScene state={table} host={host} />
      </div>
      <div className="pr-round">
        <span className="pr-live-dot" /> ROUND {String(now.round).padStart(2, '0')}
        <span className="pr-round-separator">/</span> REPLAY
      </div>
      <div className="pr-direction">
        <ArrowRightLeft size={15} className={shown.direction === -1 ? 'pr-reverse' : ''} />
        <span key={cues.reverse?.key} className={cues.reverse ? 'motion-pop' : ''}>
          {shown.direction === 1 ? 'Clockwise' : 'Counterclockwise'}
        </span>
      </div>
      {now.players.map((p) => {
        const held = shown.counts[p.id] ?? p.hand.length,
          current = now.status === 'playing' && !shown.dealing && now.currentPlayer === p.id,
          skip = cueFor(cues, 'skip', p.id),
          penalty = cueFor(cues, 'penalty', p.id)
        return (
          <div
            key={p.id}
            className={`pr-opponent pr-opponent-${seatSide(p.id, 0, count)} ${current ? 'pr-current' : ''} ${penalty ? `pr-hit-${penalty.key % 2}` : ''}`}
            data-player={p.id}
            aria-label={`${nameOf(p.id)}, ${held} ${held === 1 ? 'card' : 'cards'}${current ? ', current turn' : ''}${p.id === winner ? ', winner' : ''}`}
          >
            <span className="pr-avatar" style={{ '--token': TOKEN_COLORS[p.id] } as CSSProperties}>
              {TOKENS[p.id]}
              {current && <i />}
              {skip && <b key={skip.key} className="pr-stamp" aria-hidden="true" />}
            </span>
            <div className="pr-opponent-info">
              <strong>
                {nameOf(p.id)} {players[p.id]?.bot && <Bot size={12} aria-label="bot" />}
                {p.id === winner && <Trophy size={12} aria-label="winner" />}
              </strong>
              <span>
                {held === 1 ? (
                  <b>1 CARD LEFT</b>
                ) : (
                  <>
                    <Layers size={11} /> {held} cards
                  </>
                )}
                {p.called && <Check size={12} />}
              </span>
            </div>
            {penalty && (
              <span key={penalty.key} className="pr-penalty" aria-hidden="true">
                <span key={penalty.landed}>+{penalty.count}</span>
              </span>
            )}
          </div>
        )
      })}
      <div className="pr-center-info">
        <span className="pr-pile-name">
          DRAW PILE <small>{shown.deck} cards</small>
        </span>
        <span className="pr-pile-name">
          IN PLAY <small>{top ? cardName(top) : '—'}</small>
        </span>
      </div>
      <div className="pr-active-color" style={{ '--active-color': COLOR_HEX[shown.color] } as CSSProperties}>
        <i />
        {cues.wild && <b key={cues.wild.key} className="pr-color-wave" aria-hidden="true" />}
        <span>
          Active color <strong>{shown.color}</strong>
        </span>
        {top?.isWild && <Sparkles size={13} />}
      </div>
      {cues.call && (
        <div key={cues.call.key} className="pr-callout" aria-hidden="true">
          <strong>Prism!</strong>
          <span>{'player' in cues.call && nameOf(cues.call.player)} called it</span>
        </div>
      )}
      {now.status === 'playing' ? (
        last && <p className="pr-replay-event">{last.text}</p>
      ) : (
        <p className="pr-replay-result">
          {winner === null ? <Hand size={16} /> : <Trophy size={16} />}
          <strong>{winner === null ? 'A table well matched.' : `${nameOf(winner)} wins!`}</strong>
          {winner !== null && now.roundScore > 0 && <span>+{now.roundScore} points</span>}
        </p>
      )}
      <button
        className="pr-icon pr-replay-sound"
        aria-label={soundOn ? 'Mute sound' : 'Turn sound on'}
        onClick={() => setSoundOn(!soundOn)}
      >
        {soundOn ? <Volume2 size={16} /> : <VolumeX size={16} />}
      </button>
    </div>
  )
}
