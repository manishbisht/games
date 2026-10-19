import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'
import { Link } from 'react-router'
import { reportError } from './errorReports'

/**
 * Every game is a lazy import, and a rejected one rejects for good: React
 * re-throws the same failure on every render, so without this the player sits
 * on "Loading game…" with nothing to press, forever.
 *
 * The usual cause is not a broken build but an old tab — the site deploys to
 * Pages, and an `index.html` from the last deploy points at hashed chunks the
 * new one has removed. Reloading fetches the new index and everything works,
 * which is why the way out is a button and not an apology (main.tsx reloads
 * once by itself on Vite's `vite:preloadError`, before this is ever seen).
 *
 * It catches every render error, though, and a game that threw is not a game
 * that went missing — so it says which one happened. `resetKey` is the route:
 * leaving the screen that failed clears the failure, rather than following the
 * player to the home page.
 *
 * A class, because this is still the only way to catch a render error in React.
 */
interface State {
  error: Error | null
  key: string
}

const isChunkError = (error: Error) =>
  error.name === 'ChunkLoadError' ||
  /dynamically imported module|module script failed|preload CSS|Loading (CSS )?chunk/i.test(error.message)

export default class ChunkErrorBoundary extends Component<{ children: ReactNode; resetKey: string }, State> {
  state: State = { error: null, key: this.props.resetKey }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  static getDerivedStateFromProps(props: { resetKey: string }, state: State): Partial<State> | null {
    return props.resetKey === state.key ? null : { key: props.resetKey, error: null }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Worth a line in the console: the message names the chunk that went
    // missing, which is the only clue to a bad deploy.
    console.error('A game failed to load.', error, info.componentStack)
    reportError('boundary', error)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    const missing = isChunkError(error)
    return (
      <main className="chunk-error" role="alert">
        <h1>{missing ? 'This game didn’t load.' : 'Something went wrong at the table.'}</h1>
        <p>
          {missing
            ? 'Part of it went missing on the way over. Reloading usually sorts it out.'
            : 'The game hit a snag it couldn’t recover from. Reloading starts it fresh.'}
        </p>
        <div className="chunk-error-actions">
          <button onClick={() => window.location.reload()}>Reload</button>
          {this.props.resetKey !== '/' && <Link to="/">All games</Link>}
        </div>
      </main>
    )
  }
}
