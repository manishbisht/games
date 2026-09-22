import { lazy, Suspense, useEffect } from 'react'
import { matchPath, Navigate, Route, Routes, useLocation } from 'react-router'
import { games } from './games/catalog'
import { PlayersOnlineProvider } from './online/playersOnline'
import HomePage from './pages/HomePage'
import ChunkErrorBoundary from './ChunkErrorBoundary'
import { useTheme } from './theme/ThemeProvider'

const RoomPage = lazy(() => import('./online/RoomPage'))

export default function App() {
  const { theme } = useTheme()
  const { pathname } = useLocation()
  const game = games.find(
    (entry) => matchPath(entry.path, pathname) || matchPath(`${entry.path}/room/:code`, pathname),
  )

  useEffect(() => {
    document.title = game ? `${game.name} — Games` : 'Games — A little play goes a long way.'
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute(
        'content',
        game?.description ??
          'Play Hearth & Home and Estate, a collection of free tabletop games for your browser. Meet friends in online rooms or challenge the computer. No downloads or accounts needed.',
      )
    document
      .querySelector('link[rel="icon"]')
      ?.setAttribute('href', `${import.meta.env.BASE_URL}${game?.icon ?? 'games.svg'}`)
    window.scrollTo(0, 0)
  }, [game])

  useEffect(() => {
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', game?.themeColor[theme] ?? (theme === 'dark' ? '#18211c' : '#faf9f5'))
  }, [game, theme])

  return (
    <PlayersOnlineProvider game={game?.id}>
      <ChunkErrorBoundary>
        <Suspense fallback={<p role="status">Loading game…</p>}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            {games.map(({ path, Component }) => (
              <Route key={path} path={path} element={<Component />} />
            ))}
            {games.flatMap(({ path, aliases }) =>
              aliases.map((alias) => (
                <Route key={alias} path={alias} element={<Navigate to={path} replace />} />
              )),
            )}
            {games
              .filter((entry) => entry.online)
              .map(({ id, path }) => (
                <Route key={`${path}/room`} path={`${path}/room/:code`} element={<RoomPage game={id} />} />
              ))}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </ChunkErrorBoundary>
    </PlayersOnlineProvider>
  )
}
