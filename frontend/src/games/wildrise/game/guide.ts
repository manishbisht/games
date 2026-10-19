/** Where this browser remembers having been through the first-game guide. */
const KEY = 'games-guide-wildrise'

/** Whether this browser has been through the guide (or skipped it) before. */
export function guideSeen() {
  try {
    return localStorage.getItem(KEY) === 'done'
  } catch {
    return true
  }
}

export function rememberGuide() {
  try {
    localStorage.setItem(KEY, 'done')
  } catch {
    // Private mode: it will simply offer itself again next time.
  }
}
