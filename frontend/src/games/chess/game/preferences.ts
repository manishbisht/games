import type { Preferences } from '@games/shared/chess/types'

// Preferences only. The game itself lives in its room, which is what makes a
// chess table resumable from its link rather than from this browser. Motion is
// the site's one preference (`motion/preference`), not a chess setting, and
// sound is remembered per game the way every game remembers it (`motion/sound`).
export const PREFS = 'gambit-preferences-v1'
export type TablePreferences = Omit<Preferences, 'sound'>

/** The board's look as this browser last chose it; a replay is set in the same wood. */
export function storedPreferences(): TablePreferences {
  const defaults: TablePreferences = { highContrast: false, theme: 'walnut' }
  try {
    const data = JSON.parse(localStorage.getItem(PREFS) || '{}')
    return {
      highContrast: data.highContrast === true,
      theme: data.theme === 'marble' ? 'marble' : 'walnut',
    }
  } catch {
    return defaults
  }
}
