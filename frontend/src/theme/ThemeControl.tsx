import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme } from './ThemeProvider'

export default function ThemeControl() {
  const { appearance, setAppearance } = useTheme()
  const Icon = appearance === 'system' ? Monitor : appearance === 'light' ? Sun : Moon
  return (
    <label className="theme-control" title="Appearance">
      <Icon size={16} aria-hidden="true" />
      <select
        className="theme-select"
        aria-label="Appearance"
        value={appearance}
        onChange={(event) => {
          const value = event.target.value
          if (value === 'system' || value === 'light' || value === 'dark') setAppearance(value)
        }}
      >
        <option value="system">System</option>
        <option value="light">Light</option>
        <option value="dark">Dark</option>
      </select>
    </label>
  )
}
