import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

/**
 * Every game is a lazy import, and a rejected one rejects for good: React
 * re-throws the same failure on every render, so without this the player sits
 * on "Loading game…" with nothing to press, forever.
 *
 * The usual cause is not a broken build but an old tab — the site deploys to
 * Pages, and an `index.html` from the last deploy points at hashed chunks the
 * new one has removed. Reloading fetches the new index and everything works,
 * which is why the way out is a button and not an apology.
 *
 * A class, because this is still the only way to catch a render error in React.
 */
export default class ChunkErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Worth a line in the console: the message names the chunk that went
    // missing, which is the only clue to a bad deploy.
    console.error('A game failed to load.', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <main className="chunk-error" role="alert">
        <h1>This game didn’t load.</h1>
        <p>Part of it went missing on the way over. Reloading usually sorts it out.</p>
        <button onClick={() => window.location.reload()}>Reload</button>
      </main>
    )
  }
}
