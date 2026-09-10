import { Suspense, useEffect } from 'react'
import { matchPath, Navigate, Route, Routes, useLocation } from 'react-router'
import { games } from './games/catalog'
import HomePage from './pages/HomePage'

export default function App() {
  const { pathname } = useLocation()
  const game = games.find((entry) => matchPath(entry.path, pathname))

  useEffect(() => {
    document.title = game ? `${game.name} — Games` : 'Games — A little play goes a long way.'
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute(
        'content',
        game?.description ??
          'Play Hearth & Home and Estate, a collection of free tabletop games for your browser. Gather local friends or challenge the computer. No downloads or accounts needed.',
      )
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', game?.themeColor ?? '#faf9f5')
    document
      .querySelector('link[rel="icon"]')
      ?.setAttribute('href', `${import.meta.env.BASE_URL}${game?.icon ?? 'games.svg'}`)
    window.scrollTo(0, 0)
  }, [game])

  return (
    <Suspense fallback={<p role="status">Loading game…</p>}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        {games.map(({ path, Component }) => (
          <Route key={path} path={path} element={<Component />} />
        ))}
        {games.flatMap(({ path, aliases }) =>
          aliases.map((alias) => <Route key={alias} path={alias} element={<Navigate to={path} replace />} />),
        )}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  )
}
