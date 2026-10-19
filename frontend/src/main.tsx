import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { unstable_HistoryRouter as HistoryRouter } from 'react-router'
import './index.css'
import './motion/motion.css'
// Sets <html data-motion> before the first paint, so CSS sees the preference.
import './motion/preference'
import App from './App.tsx'
import { createAppHistory } from './navigation'
import { AuthProvider } from './online/identity'
import { ThemeProvider } from './theme/ThemeProvider'

/**
 * A chunk that 404s is almost always an old tab after a deploy (see
 * ChunkErrorBoundary). Reload once to pick up the new index; if it happens
 * again straight away, something else is wrong and the boundary's message is
 * the honest answer, so don't loop.
 */
const RELOADED_AT = 'games-chunk-reload'
window.addEventListener('vite:preloadError', () => {
  try {
    if (Date.now() - Number(sessionStorage.getItem(RELOADED_AT) ?? 0) < 10_000) return
    sessionStorage.setItem(RELOADED_AT, String(Date.now()))
  } catch {
    return
  }
  window.location.reload()
})

const history = createAppHistory()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <AuthProvider>
        <HistoryRouter history={history} useTransitions={false}>
          <App />
        </HistoryRouter>
      </AuthProvider>
    </ThemeProvider>
  </StrictMode>,
)
