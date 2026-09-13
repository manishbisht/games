import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { Bot, Globe2 } from 'lucide-react'
import OnlinePanel from './OnlinePanel'
import type { OnlinePanelProps } from './OnlinePanel'
import './PlayOptions.css'

/** One person with bots, or a shared room with people on their own devices. */
export default function PlayOptions({
  children,
  ...room
}: Omit<OnlinePanelProps, 'appearance'> & { children: ReactNode }) {
  const [mode, setMode] = useState<'bot' | 'online'>('bot')
  const panelId = useId()
  return (
    <div className="play-options">
      <div className="play-options-modes" role="group" aria-label="How to play">
        <button
          type="button"
          aria-pressed={mode === 'bot'}
          aria-controls={panelId}
          onClick={() => setMode('bot')}
        >
          <Bot size={16} /> Play vs bot
        </button>
        <button
          type="button"
          aria-pressed={mode === 'online'}
          aria-controls={panelId}
          onClick={() => setMode('online')}
        >
          <Globe2 size={16} /> Play online
        </button>
      </div>
      <p className="play-options-description">
        {mode === 'bot'
          ? 'Your seat. A little computer competition.'
          : 'Create a room or join friends on their own devices.'}
      </p>
      <div id={panelId}>{mode === 'bot' ? children : <OnlinePanel {...room} />}</div>
    </div>
  )
}
