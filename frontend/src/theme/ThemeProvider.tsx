/* eslint-disable react-refresh/only-export-components -- the appearance context and hook share one provider. */
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'
import type { ReactNode } from 'react'

type Appearance = 'system' | 'light' | 'dark'
type Theme = Exclude<Appearance, 'system'>
const STORAGE_KEY = 'games-appearance'

function readAppearance(): Appearance {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    return saved === 'light' || saved === 'dark' ? saved : 'system'
  } catch {
    return 'system'
  }
}

const ThemeContext = createContext<{
  appearance: Appearance
  theme: Theme
  setAppearance: (appearance: Appearance) => void
} | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [appearance, setPreference] = useState(readAppearance)
  const [media] = useState(() => window.matchMedia('(prefers-color-scheme: dark)'))
  const system = useMemo(
    () => ({
      subscribe: (onChange: () => void) => {
        media.addEventListener('change', onChange)
        return () => media.removeEventListener('change', onChange)
      },
      getSnapshot: () => media.matches,
    }),
    [media],
  )
  const systemDark = useSyncExternalStore(system.subscribe, system.getSnapshot)
  const theme = appearance === 'system' ? (systemDark ? 'dark' : 'light') : appearance

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.style.colorScheme = theme
  }, [theme])

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY || event.key === null) setPreference(readAppearance())
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  function setAppearance(value: Appearance) {
    setPreference(value)
    try {
      localStorage.setItem(STORAGE_KEY, value)
    } catch {
      // The preference still works for this visit when storage is unavailable.
    }
  }

  return (
    <ThemeContext.Provider value={{ appearance, theme, setAppearance }}>{children}</ThemeContext.Provider>
  )
}

export function useTheme() {
  const theme = useContext(ThemeContext)
  if (!theme) throw new Error('useTheme must be used inside ThemeProvider')
  return theme
}
