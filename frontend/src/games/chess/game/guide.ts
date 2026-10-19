/** One coach mark: what it says, and the element on the page it points at. */
export interface GuideStep {
  id: string
  /** A selector for the real thing on screen the step is about. */
  target: string
  title: string
  text: string
}

const KEY = 'games-guide-chess'
/** Whether this browser has already been shown Gambit's first-game guide. */
export function guideSeen() {
  try {
    return localStorage.getItem(KEY) === 'done'
  } catch {
    return false
  }
}
export function rememberGuide() {
  try {
    localStorage.setItem(KEY, 'done')
  } catch {
    /* Shown again next visit; nothing worse. */
  }
}

/**
 * The first-game guide: one step for each thing a newcomer meets, each pointing
 * at it on the table. The clock gets a step only when the game has one.
 */
export function guideSteps(clock: number, increment = 0): GuideStep[] {
  return [
    {
      id: 'select',
      target: '[data-guide="board"]',
      title: 'Pick up a piece.',
      text: 'On your move, tap one of your pieces. Dots mark every square it can reach; rings mark a capture.',
    },
    {
      id: 'move',
      target: '[data-guide="board"]',
      title: 'Make your move.',
      text: 'Tap a marked square, or drag the piece straight to it. It lands on your opponent’s board too.',
    },
    {
      id: 'captures',
      target: '[data-guide="you"]',
      title: 'Taking pieces.',
      text: 'Land on an enemy piece to capture it. It goes to the tray beside the board, and is counted here by your name.',
    },
    {
      id: 'check',
      target: '[data-guide="status"]',
      title: 'Check and checkmate.',
      text: 'A king under attack is in check: it glows red, and your next move must save it. When nothing can, that’s checkmate.',
    },
    ...(clock
      ? [
          {
            id: 'clock',
            target: '[data-guide="you"] .ch-clock',
            title: 'Your clock.',
            text: `Clocks start once both sides have moved, and yours runs only on your move${increment ? `, with ${increment}s back for each one` : ''}. Let it reach zero and the game is lost.`,
          },
        ]
      : []),
    {
      id: 'finish',
      target: '[data-guide="resign"]',
      title: 'Resign and rematch.',
      text: 'Resign here if the position is lost. When a game ends, its result offers a rematch.',
    },
  ]
}
