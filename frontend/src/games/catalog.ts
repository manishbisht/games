import { lazy } from 'react'

export const hearthGame = {
  id: 'hearth',
  name: 'Hearth & Home',
  path: '/hearth-and-home',
  aliases: ['/Ludo', '/Hearth'],
  category: 'A little luck. A long way home.',
  description:
    'Race your pieces around a colorful board, send rivals back to their nests, and bring everyone home. A familiar favorite with a cozy twist.',
  tags: ['Race & strategy', 'Classic, quick & custom'],
  icon: 'hearth.svg',
  themeColor: '#faf9f5',
  Component: lazy(() => import('./hearth/HearthGame')),
}

export const estateGame = {
  id: 'estate',
  name: 'Estate',
  path: '/estate',
  aliases: ['/Monopoly'],
  category: 'A little luck. A lot of strategy.',
  description:
    'Build a property empire, strike a deal, and make every roll count. Gather your friends and see who ends up owning the neighborhood.',
  tags: ['Property & trading', 'Classic & quick'],
  icon: 'estate.svg',
  themeColor: '#111722',
  Component: lazy(() => import('./monopoly/MonopolyGame')),
}

export const prismGame = {
  id: 'prism',
  name: 'Prism',
  path: '/prism',
  aliases: ['/uno', '/Prism'],
  category: 'A little color. A little chaos.',
  description:
    'Match a color, change the direction, and keep your friends guessing. A colorful 3D card game with a little friendly rivalry in every hand.',
  tags: ['Cards & color', 'Local & three AI levels'],
  icon: 'prism.svg',
  themeColor: '#142b24',
  Component: lazy(() => import('./prism/PrismGame')),
}

export const games = [hearthGame, estateGame, prismGame]
