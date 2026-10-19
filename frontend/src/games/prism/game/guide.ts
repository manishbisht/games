/**
 * Whether this browser has been through Prism's first-table guide. Kept per
 * game, so learning one table does not skip the next game's guide; any value
 * but 'done' shows it again.
 */
export const GUIDE_KEY = 'games-guide-prism'

export const guideDone = () => {
  try {
    return localStorage.getItem(GUIDE_KEY) === 'done'
  } catch {
    // Storage that cannot be read cannot remember either: better no guide than one every visit.
    return true
  }
}
export const rememberGuide = (done: boolean) => {
  try {
    if (done) localStorage.setItem(GUIDE_KEY, 'done')
    else localStorage.removeItem(GUIDE_KEY)
  } catch {
    // A private window keeps no memory; the guide simply shows again next time.
  }
}
