import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { Bot, Globe2 } from 'lucide-react'
import OnlinePanel from './OnlinePanel'
import type { OnlinePanelProps } from './OnlinePanel'
import { useIdentity } from './identity'
import './PlayOptions.css'

/**
 * One person against bots, or a shared room with people on their own devices.
 * Both are rooms now — the bot tab's setup children describe the table and the
 * server deals it — which is why the name is asked for once, up here, rather
 * than by whichever tab happens to need it.
 */
export default function PlayOptions({ children, ...room }: OnlinePanelProps & { children: ReactNode }) {
  const [mode, setMode] = useState<'bot' | 'online'>('bot')
  const identity = useIdentity()
  const [name, setName] = useState(identity.name)
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
      {!identity.isReady ? (
        <p className="play-options-identity" role="status">
          Loading your player profile…
        </p>
      ) : identity.isSignedIn ? (
        <p className="play-options-identity">
          Playing as <strong>{identity.name}</strong>
        </p>
      ) : (
        <div>
          <label className="play-options-name">
            Your name
            <input
              value={name}
              maxLength={24}
              autoComplete="nickname"
              placeholder="What should we call you?"
              aria-describedby={`${panelId}-guest-note`}
              onChange={(event) => {
                setName(event.target.value)
                identity.setName(event.target.value)
              }}
            />
          </label>
          <p className="play-options-guest-note" id={`${panelId}-guest-note`}>
            Play as a guest. No account needed.
          </p>
        </div>
      )}
      <p className="play-options-description">
        {mode === 'bot'
          ? 'Your own room with bot opponents. Internet required.'
          : 'Create a room or join friends on their own devices. Internet required.'}
      </p>
      <div id={panelId}>
        {mode === 'bot' ? children : <OnlinePanel {...room} nameAsked={!identity.isSignedIn} />}
      </div>
    </div>
  )
}
