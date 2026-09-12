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

export const chessGame = {
  id: 'chess',
  name: 'Gambit',
  path: '/chess',
  aliases: ['/Gambit'],
  category: 'A quiet moment. A world of possibility.',
  description:
    'A timeless game in a new dimension. Settle in at a beautiful 3D chessboard, challenge a friend or the computer, and find your next great move.',
  tags: ['Chess & strategy', 'Local & three AI levels'],
  icon: 'chess.svg',
  themeColor: '#f8f7f2',
  Component: lazy(() => import('./chess/ChessGame')),
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

export const wildriseGame = {
  id: 'wildrise',
  name: 'Wildrise',
  path: '/wildrise',
  aliases: ['/snakes-and-ladders', '/SnakesAndLadders'],
  category: 'A little luck. A long way up.',
  description:
    'Take the scenic route across a beautiful woodland board. Climb ladders, slide down friendly snakes, and race your miniature to the top. Every roll is a new adventure.',
  tags: ['Snakes & ladders', 'Local & fair-play AI'],
  icon: 'wildrise.svg',
  themeColor: '#f7f6ef',
  Component: lazy(() => import('./wildrise/WildriseGame')),
}

export const games = [hearthGame, estateGame, chessGame, prismGame, wildriseGame]
