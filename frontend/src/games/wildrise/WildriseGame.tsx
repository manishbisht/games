import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Link } from 'react-router'
import { ArrowDownRight, ArrowLeft, ArrowRight, ArrowUpRight, Bot, Check, CircleHelp, Dices, Flag, Leaf, Maximize2, Pause, Play, RotateCcw, RotateCw, Sparkles, Trophy, Users, Volume2, VolumeX, ZoomIn, ZoomOut } from 'lucide-react'
import Setup, { toConfig } from './components/Setup'
import type { SetupOptions } from './components/Setup'
import Dialog from './components/Dialog'
import TokenPortrait from './components/TokenPortrait'
import { PALETTES } from './game/board'
import { createGame, gameReducer, rollDie } from './game/engine'
import { sound, unlockAudio } from './game/audio'
import { useGameClock } from './game/useGameClock'
import type { GameConfig } from './game/types'
import BoardScene from './scene/BoardScene'
import type { BoardControls } from './scene/BoardScene'
import './WildriseGame.css'

function DieFace({ value }: { value: number | null }) {
  const active = value === 1 ? [4] : value === 2 ? [0, 8] : value === 3 ? [0, 4, 8] : value === 4 ? [0, 2, 6, 8] : value === 5 ? [0, 2, 4, 6, 8] : [0, 2, 3, 5, 6, 8]
  return <span className="wr-die-face" aria-hidden="true">{Array.from({ length: 9 }, (_, i) => <i key={i} className={value !== null && active.includes(i) ? 'filled' : ''} />)}</span>
}

function Table({ config, menu, options, onOptions, onStart, onMenu }: { config: GameConfig; menu: boolean; options: SetupOptions; onOptions: (o: SetupOptions) => void; onStart: () => void; onMenu: () => void }) {
  const [state, dispatch] = useReducer(gameReducer, config, createGame)
  const preview = useMemo(() => createGame(config), [config])
  const game = menu ? preview : state
  const [dialog, setDialog] = useState<'rules' | 'pause' | 'restart' | null>(null)
  const [soundOn, setSoundOn] = useState(true)
  const [dismissedVictory, setDismissedVictory] = useState(false)
  const [hidden, setHidden] = useState(document.hidden)
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const board = useRef<BoardControls>(null)
  const paused = menu || !!dialog || hidden
  const current = game.players[game.currentPlayer]
  const isHuman = current.control === 'human'
  const canRoll = !paused && game.phase === 'ready' && isHuman
  useGameClock(state, paused, reduced, dispatch)
  useEffect(() => {
    const visibility = () => setHidden(document.hidden)
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)')
    const change = () => setReduced(preference.matches)
    document.addEventListener('visibilitychange', visibility); preference.addEventListener('change', change)
    return () => { document.removeEventListener('visibilitychange', visibility); preference.removeEventListener('change', change) }
  }, [])
  const doRoll = useCallback(() => {
    if (!canRoll) return
    if (soundOn) unlockAudio()
    dispatch({ type: 'ROLL', value: rollDie() })
  }, [canRoll, soundOn])
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat || (event.target instanceof HTMLElement && event.target.closest('input,select,textarea,button,a,dialog'))) return
      if (canRoll) { event.preventDefault(); doRoll() }
    }
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key)
  }, [canRoll, doRoll])
  useEffect(() => {
    if (menu || !soundOn) return
    if (state.phase === 'rolling') sound('roll')
    else if (state.phase === 'moving') sound('step')
    else if (state.phase === 'transporting') sound(state.motion?.kind === 'ladder' ? 'ladder' : 'snake')
    else if (state.phase === 'settling') sound('land')
    else if (state.phase === 'won') sound('win')
  }, [state, menu, soundOn])
  const phaseText = game.phase === 'ready' ? isHuman ? 'Your next adventure is one roll away.' : `${current.name} is getting ready to roll…` : game.phase === 'rolling' ? 'A little shake. A little luck.' : game.phase === 'moving' ? `On the move · heading to ${game.motion?.to}` : game.phase === 'transporting' ? `${game.motion?.kind === 'ladder' ? 'A shortcut to the treetops!' : 'A little tumble. A new beginning.'}` : game.phase === 'won' ? 'The summit is yours.' : game.events[0].message
  const winner = game.players.find(p => p.id === game.winner)
  const showVictory = !!winner && !dismissedVictory && !dialog
  const statusText = menu ? 'THE TABLE IS SET' : game.phase === 'won' ? 'ADVENTURE COMPLETE' : dialog || hidden ? 'TAKING A BREATHER' : `TURN ${String(game.turn).padStart(2, '0')}`
  const start = () => { if (soundOn) unlockAudio(); onStart() }
  return <div className="wr-app">
    <header className="wr-header">
      <div className="wr-header-left"><Link to="/" className="wr-back"><ArrowLeft size={15} /><span>All games</span></Link><span className="wr-header-divider" /><a href="#/wildrise" className="wr-brand" aria-label="Wildrise home"><span className="wr-brand-mark"><Leaf size={24} strokeWidth={1.5} /></span>wildrise<span className="wr-brand-dot">.</span></a></div>
      <span className="wr-header-note">A LITTLE LUCK. A LONG WAY UP.</span>
      <nav className="wr-header-actions" aria-label="Game controls"><button className="wr-help" onClick={() => setDialog('rules')}><CircleHelp size={17} /><span>How to play</span></button><button className="wr-icon-button" aria-label={soundOn ? 'Mute sound' : 'Turn sound on'} title={soundOn ? 'Mute sound' : 'Turn sound on'} onClick={() => { if (!soundOn) unlockAudio(); setSoundOn(!soundOn) }}>{soundOn ? <Volume2 size={19} /> : <VolumeX size={19} />}</button>{!menu && <button className="wr-icon-button" aria-label="Pause game" onClick={() => setDialog('pause')}><Pause size={18} /></button>}</nav>
    </header>
    <main className="wr-main">
      <section className="wr-table" aria-label="Woodland game table">
        <div className="wr-table-heading">
          <div><p className="wr-eyebrow"><span className="wr-tiny-line" /> THE WOODLAND COLLECTION</p><h1>{menu ? <>Take the <em>scenic route.</em></> : winner ? <>{winner.name} <em>wins!</em></> : <>{current.name}’s <em>turn.</em></>}</h1><p className="wr-table-subtitle">{menu ? 'Some ups. Some downs. All part of the adventure.' : phaseText}</p></div>
          <div className="wr-table-badge"><i />{statusText}</div>
        </div>
        <div className="wr-stage">
          <BoardScene key={`${menu ? 'preview' : 'game'}-${game.players.length}`} ref={board} state={game} running={!hidden && !dialog} onRoll={doRoll} />
          {!menu && game.phase === 'transporting' && <div className={`wr-transport wr-transport-${game.motion?.kind}`} role="status">{game.motion?.kind === 'ladder' ? <ArrowUpRight size={25} /> : <ArrowDownRight size={25} />}<div><strong>{game.motion?.kind === 'ladder' ? 'CLIMB!' : 'SLIDE!'}</strong><span>{game.motion?.from} → {game.motion?.to}</span></div></div>}
          <div className="wr-camera" aria-label="Camera controls"><button onClick={() => board.current?.zoom(-1)} aria-label="Zoom out" title="Zoom out"><ZoomOut size={17} /></button><button onClick={() => board.current?.zoom(1)} aria-label="Zoom in" title="Zoom in"><ZoomIn size={17} /></button><i /><button onClick={() => board.current?.rotate(-1)} aria-label="Rotate left" title="Rotate left"><RotateCcw size={17} /></button><button onClick={() => board.current?.rotate(1)} aria-label="Rotate right" title="Rotate right"><RotateCw size={17} /></button><i /><button onClick={() => board.current?.top()} aria-label="Top view" title="Top view"><Maximize2 size={16} /></button><button onClick={() => board.current?.reset()} aria-label="Reset camera" title="Reset camera"><span className="wr-reset-label">Reset</span></button></div>
          <span className="wr-camera-hint">Drag to explore · Scroll or pinch to zoom</span>
        </div>
        <div className="wr-board-footer"><span><ArrowUpRight size={15} className="wr-up" /> Find a ladder. Climb higher.</span><span><ArrowDownRight size={15} className="wr-down" /> Meet a snake. Slide back.</span><span><Flag size={14} /> First to 100 wins.</span></div>
      </section>
      <aside className="wr-sidebar">
        {menu ? <Setup options={options} onChange={onOptions} onStart={start} /> : <>
          <section className="wr-players" aria-labelledby="wr-players-title"><div className="wr-section-title"><h2 id="wr-players-title">Around the table</h2><span><Users size={13} /> {game.players.length} players</span></div>
            <div className="wr-player-list">{game.players.map((player, index) => <div className={`wr-player ${index === game.currentPlayer ? 'wr-player-active' : ''}`} key={player.id} data-testid={`wildrise-player-${player.id}`} style={{ '--player-color': PALETTES[player.id].color, '--player-pale': PALETTES[player.id].pale } as React.CSSProperties}>
              <TokenPortrait id={player.id} /><div className="wr-player-info"><strong>{player.name} {player.control !== 'human' && <Bot size={12} />}</strong><span>{index === game.currentPlayer ? winner ? 'The trailblazer' : 'Taking a turn' : PALETTES[player.id].animal + ' miniature'}</span></div><div className="wr-position"><strong>{player.position === 0 ? '—' : player.position}</strong><small>{player.position === 0 ? 'at camp' : 'of 100'}</small></div><div className="wr-progress"><i style={{ width: `${player.position}%` }} /></div>
            </div>)}</div>
          </section>
          <section className="wr-roll-panel" aria-label="Current turn">
            <div className="wr-roll-top"><div><p className="wr-eyebrow">{game.phase === 'won' ? 'WHAT A JOURNEY' : 'LET THE GOOD TIMES ROLL'}</p><h2>{game.phase === 'won' ? 'Made it to the top.' : game.phase === 'rolling' ? 'Here goes…' : game.phase === 'ready' ? isHuman ? 'Your move, explorer.' : `${current.name} is thinking…` : game.phase === 'transporting' ? game.motion?.kind === 'ladder' ? 'Up, up & away.' : 'Enjoy the slide.' : `A ${game.dice}. Let’s go.`}</h2></div><span className={game.phase === 'rolling' && !reduced ? 'wr-die-shake' : ''}><DieFace value={game.phase === 'rolling' ? null : game.dice} /></span></div>
            <p className="wr-roll-copy" role="status" aria-live="polite" aria-atomic="true">{dialog || hidden ? 'Game paused. Your adventure can wait.' : phaseText}</p>
            {winner ? <button className="wr-primary" onClick={() => setDismissedVictory(false)}><Trophy size={18} /> View results</button> : <button className="wr-primary wr-roll" onClick={doRoll} disabled={!canRoll} aria-label="Roll dice"><Dices size={21} />{dialog || hidden ? 'Game paused' : game.phase === 'rolling' ? 'Rolling…' : game.phase === 'moving' ? 'On the move…' : game.phase === 'transporting' ? game.motion?.kind === 'ladder' ? 'Climbing…' : 'Sliding…' : game.phase === 'settling' ? 'Passing the die…' : !isHuman ? 'AI is getting ready…' : 'Roll dice'}{canRoll && <kbd>SPACE</kbd>}</button>}
            <p className="wr-roll-hint">{game.rules.exactFinish ? 'An exact roll brings you home.' : 'Reach or pass 100 to finish.'}</p>
          </section>
          <section className="wr-events" aria-labelledby="wr-events-title"><div className="wr-section-title"><h2 id="wr-events-title">Along the way</h2><span>THE STORY SO FAR</span></div><ol>{game.events.slice(0, 5).map(event => <li key={event.id}><span className={`wr-event-icon wr-event-${event.kind}`}>{event.kind === 'ladder' ? <ArrowUpRight size={14} /> : event.kind === 'snake' ? <ArrowDownRight size={14} /> : event.kind === 'win' ? <Trophy size={14} /> : event.kind === 'roll' ? <Dices size={14} /> : <Leaf size={14} />}</span><p>{event.message}<small>Turn {event.turn}</small></p></li>)}</ol></section>
          <button className="wr-new-game" onClick={() => setDialog('restart')}><RotateCcw size={14} /> Start a new adventure</button>
        </>}
      </aside>
    </main>
    <footer className="wr-footer"><span><Leaf size={13} /> A fresh take on snakes & ladders.</span><span>100 SPACES. ENDLESS POSSIBILITIES. <span aria-hidden="true">✦</span></span></footer>
    <p className="sr-only" aria-live="polite">{!menu ? `${current.name}'s turn. Turn ${game.turn}. Position ${current.position}. ${game.phase !== 'rolling' && game.dice ? `Last roll ${game.dice}.` : ''}` : ''}</p>
    {dialog === 'rules' && <Dialog title="A few simple rules" onClose={() => setDialog(null)}><div className="wr-dialog-emblem"><Leaf size={28} /></div><p className="wr-eyebrow">THE SCENIC ROUTE TO 100</p><h2>A few simple rules.</h2><p className="wr-description">A familiar favorite. A fresh little adventure.</p><ol className="wr-rules"><li><Dices /><div><strong>Take a turn. Roll the die.</strong><p>A randomly chosen player starts. Move forward one space for every pip, then pass the die.</p></div></li><li><ArrowUpRight /><div><strong>A little help along the way.</strong><p>Land at the bottom of a ladder to climb to its top. Passing over it doesn’t count.</p></div></li><li><ArrowDownRight /><div><strong>Every adventure has its tumbles.</strong><p>Land on a snake’s head and slide along its body to the tail. The printed arrow shows your destination.</p></div></li><li><Flag /><div><strong>Be the first to reach 100.</strong><p>{game.rules.exactFinish ? 'You need an exact roll to finish. Roll too many and stay put until your next turn.' : 'Reach or pass square 100 to win.'} Sharing spaces is allowed; a six does not grant an extra turn.</p></div></li></ol><p className="wr-rule-footnote"><Check size={15} /> AI companions use the same fair dice as you.</p><button className="wr-primary" onClick={() => setDialog(null)}>Got it. Let’s play. <ArrowRight size={17} /></button></Dialog>}
    {dialog === 'pause' && <Dialog title="Take a little breather" onClose={() => setDialog(null)}><div className="wr-dialog-emblem"><Pause size={27} /></div><h2>Take a little breather.</h2><p className="wr-description">The table will be right here. Every piece, exactly where you left it.</p><button className="wr-primary" onClick={() => setDialog(null)}><Play size={17} /> Back to the adventure</button><button className="wr-secondary" onClick={() => setDialog('restart')}>Start a new game</button></Dialog>}
    {dialog === 'restart' && <Dialog title="Start a new adventure?" onClose={() => setDialog(null)}><div className="wr-dialog-emblem"><RotateCcw size={27} /></div><h2>A fresh little start?</h2><p className="wr-description">This game will end and all pieces will return to camp.</p><button className="wr-primary" onClick={onMenu}>Return to menu <ArrowRight size={17} /></button><button className="wr-secondary" onClick={() => setDialog(null)}>Keep playing</button></Dialog>}
    {showVictory && winner && <Dialog title={`${winner.name} wins!`} onClose={() => setDismissedVictory(true)} className="wr-victory"><span className="wr-victory-spark"><Sparkles size={25} /></span><TokenPortrait id={winner.id} size={94} /><p className="wr-eyebrow">A TRUE TRAILBLAZER</p><h2>{winner.name} wins!</h2><p className="wr-description">A few climbs. A few tumbles.<br />One wonderful way to the top.</p><div className="wr-victory-stats"><div><strong>100</strong><span>FINAL POSITION</span></div><div><strong>{winner.turns}</strong><span>TURNS TAKEN</span></div><div><strong>{winner.climbs}</strong><span>LADDERS CLIMBED</span></div></div><button className="wr-primary" onClick={start}><RotateCcw size={17} /> Play again</button><button className="wr-secondary" onClick={onMenu}>Return to menu <ArrowRight size={16} /></button></Dialog>}
  </div>
}

export default function WildriseGame() {
  const [options, setOptions] = useState<SetupOptions>({ count: 2, mode: 'local', names: ['Red', 'Blue', 'Green', 'Yellow'], style: 'casual', exact: true })
  const [match, setMatch] = useState<{ config: GameConfig; id: number } | null>(null)
  const sequence = useRef(0)
  const config = useMemo(() => toConfig(options), [options])
  const start = () => { sequence.current++; setMatch({ config: { ...config, firstPlayer: Math.floor(Math.random() * options.count) }, id: sequence.current }) }
  return <Table key={match?.id ?? 'menu'} config={match?.config ?? config} menu={!match} options={options} onOptions={setOptions} onStart={start} onMenu={() => setMatch(null)} />
}
