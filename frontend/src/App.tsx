import { Suspense, useEffect, useLayoutEffect } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router'
import { games } from './games/catalog'
import { homeScrollPosition, roomPage, screenOf } from './navigation'
import { PlayersOnlineProvider } from './online/playersOnline'
import HomePage from './pages/HomePage'
import ChunkErrorBoundary from './ChunkErrorBoundary'
import RouteSkeleton from './RouteSkeleton'
import { useTheme } from './theme/ThemeProvider'

const RoomPage = roomPage.Component
const DESCRIPTION = `Play ${new Intl.ListFormat('en', { type: 'conjunction' }).format(
  games.map((game) => game.name),
)}: free tabletop games for your browser. Meet friends in online rooms or challenge the computer. No downloads or accounts needed.`

export default function App() {
  const { theme } = useTheme()
  const { pathname } = useLocation()
  const { game, room } = screenOf(pathname)

  useEffect(() => {
    document.title = game ? `${game.name} — Games` : 'Games — A little play goes a long way.'
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute('content', game?.description ?? DESCRIPTION)
    document
      .querySelector('link[rel="icon"]')
      ?.setAttribute('href', `${import.meta.env.BASE_URL}${game?.icon ?? 'games.svg'}`)
  }, [game])

  // A layout effect, so it lands inside the route transition's commit: the
  // collection comes back where it was left, with the card the game folds
  // into already on screen.
  useLayoutEffect(() => {
    window.scrollTo(0, game ? 0 : homeScrollPosition())
  }, [game])

  useEffect(() => {
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute('content', game?.themeColor[theme] ?? (theme === 'dark' ? '#18211c' : '#faf9f5'))
  }, [game, theme])

  return (
    <PlayersOnlineProvider game={game?.id}>
      <ChunkErrorBoundary resetKey={pathname}>
        <Suspense fallback={<RouteSkeleton game={game} room={room} />}>
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
