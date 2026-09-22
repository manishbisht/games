import { lazy } from 'react'
import type { ComponentType, LazyExoticComponent } from 'react'

export interface GameEntry {
  id: string
  name: string
  path: string
  aliases: string[]
  category: string
  description: string
  tags: string[]
  icon: string
  themeColor: { light: string; dark: string }
  /** Has an online mode, so `${path}/room/:code` routes to the shared room page. */
  online?: boolean
  Component: LazyExoticComponent<ComponentType>
}

export const hearthGame: GameEntry = {
  id: 'hearth',
  name: 'Hearth & Home',
  path: '/hearth-and-home',
  aliases: ['/Ludo', '/Hearth'],
  category: 'A little luck. A long way home.',
  description:
    'Race your pieces around a colorful board, send rivals back to their nests, and bring everyone home. A familiar favorite with a cozy twist.',
  tags: ['Race & strategy', 'Classic, quick & custom'],
  icon: 'hearth.svg',
  themeColor: { light: '#faf9f5', dark: '#18211c' },
  online: true,
  Component: lazy(() => import('./hearth/HearthGame')),
}

export const estateGame: GameEntry = {
  id: 'estate',
  name: 'Estate',
  path: '/estate',
  aliases: ['/Monopoly'],
  category: 'A little luck. A lot of strategy.',
  description:
    'Build a property empire, strike a deal, and make every roll count. Gather your friends and see who ends up owning the neighborhood.',
  tags: ['Property & trading', 'Classic & quick'],
  icon: 'estate.svg',
  themeColor: { light: '#faf9f5', dark: '#111722' },
  online: true,
  Component: lazy(() => import('./monopoly/MonopolyGame')),
}

export const chessGame: GameEntry = {
  id: 'chess',
  name: 'Gambit',
  path: '/chess',
  aliases: ['/Gambit'],
  category: 'A quiet moment. A world of possibility.',
  description:
    'A timeless game in a new dimension. Meet at a beautiful 3D chessboard, invite a friend to your room or join an open table, and find your next great move.',
  tags: ['Chess & strategy', 'Online with friends'],
  icon: 'chess.svg',
  themeColor: { light: '#f8f7f2', dark: '#18211c' },
  online: true,
  Component: lazy(() => import('./chess/ChessLobby')),
}

export const prismGame: GameEntry = {
  id: 'prism',
  name: 'Prism',
  path: '/prism',
  aliases: ['/uno', '/Prism'],
  category: 'A little color. A little chaos.',
  description:
    'Match a color, change the direction, and keep your friends guessing. A colorful 3D card game with a little friendly rivalry in every hand.',
  tags: ['Cards & color', 'Bots & online rooms'],
  icon: 'prism.svg',
  themeColor: { light: '#faf9f5', dark: '#142b24' },
  online: true,
  Component: lazy(() => import('./prism/PrismGame')),
}

export const wildriseGame: GameEntry = {
  id: 'wildrise',
  name: 'Wildrise',
  path: '/wildrise',
  aliases: ['/snakes-and-ladders', '/SnakesAndLadders'],
  category: 'A little luck. A long way up.',
  description:
    'Take the scenic route across a beautiful woodland board. Climb ladders, slide down friendly snakes, and race your miniature to the top. Play against bots or invite friends to your own room.',
  tags: ['Snakes & ladders', 'Bots & online rooms'],
  icon: 'wildrise.svg',
  themeColor: { light: '#f7f6ef', dark: '#18211c' },
  online: true,
  Component: lazy(() => import('./wildrise/WildriseGame')),
}

export const games: GameEntry[] = [hearthGame, estateGame, chessGame, prismGame, wildriseGame]
