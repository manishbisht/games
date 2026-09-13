import { createGame, validTrade } from '@games/shared/estate'
import { BOARD, PLAYER_STYLES } from '@games/shared/estate/board'
import type { GameState } from '@games/shared/estate/types'

const KEY = 'estate-game-v1'
export function loadGame(): GameState {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return createGame()
    const s = JSON.parse(raw) as GameState
    if (
      s.version !== 1 ||
      !['playing', 'finished'].includes(s.status) ||
      !Array.isArray(s.players) ||
      s.players.length < 2 ||
      s.players.length > 4
    )
      return createGame()
    if (
      !['ready', 'purchase', 'card', 'debt', 'end'].includes(s.phase) ||
      !Number.isInteger(s.current) ||
      !s.players[s.current]
    )
      return createGame()
    if (
      !s.players.every(
        (p, i) =>
          p.id === i &&
          typeof p.name === 'string' &&
          p.name.length > 0 &&
          typeof p.color === 'string' &&
          PLAYER_STYLES.some((style) => style.token === p.token) &&
          typeof p.isBot === 'boolean' &&
          typeof p.bankrupt === 'boolean' &&
          typeof p.jailed === 'boolean' &&
          Number.isInteger(p.jailTurns) &&
          p.jailTurns >= 0 &&
          Number.isFinite(p.cash) &&
          p.cash >= 0 &&
          Number.isInteger(p.position) &&
          p.position >= 0 &&
          p.position < 40,
      )
    )
      return createGame()
    if (
      !['classic', 'quick'].includes(s.mode) ||
      !Number.isSafeInteger(s.turn) ||
      s.turn < 1 ||
      !Number.isSafeInteger(s.eventId) ||
      !Number.isInteger(s.rollId) ||
      typeof s.extraRoll !== 'boolean'
    )
      return createGame()
    if (
      !s.properties ||
      !Array.isArray(s.events) ||
      !Array.isArray(s.dice) ||
      s.dice.length !== 2 ||
      !s.dice.every((d) => Number.isInteger(d) && d >= 1 && d <= 6) ||
      !Number.isInteger(s.seed)
    )
      return createGame()
    if (
      !Object.entries(s.properties).every(
        ([id, p]) =>
          BOARD[Number(id)]?.price &&
          s.players[p.owner] &&
          !s.players[p.owner].bankrupt &&
          Number.isInteger(p.level) &&
          p.level >= 0 &&
          p.level <= 5 &&
          typeof p.mortgaged === 'boolean',
      )
    )
      return createGame()
    if ((s.phase === 'debt' && (!s.debt || !(s.debt.amount > 0))) || (s.phase === 'card' && !s.card))
      return createGame()
    if (s.trade && (!['ready', 'end'].includes(s.phase) || !validTrade(s, s.trade))) return createGame()
    if (
      s.status === 'finished' &&
      (s.winner === null ||
        !s.players[s.winner] ||
        s.players[s.winner].bankrupt ||
        s.players.filter((p) => !p.bankrupt).length !== 1)
    )
      return createGame()
    // Same-device multiplayer is no longer a playable mode. Keep the old save
    // untouched until the player starts a new bot game, but return to setup.
    if (s.players[0].isBot || s.players.slice(1).some((p) => !p.isBot)) return createGame()
    // Palette updates are presentation changes; preserve all saved gameplay progress.
    s.players = s.players.map((p) => ({
      ...p,
      color: PLAYER_STYLES.find((style) => style.token === p.token)!.color,
    }))
    return s
  } catch {
    return createGame()
  }
}
export function saveGame(s: GameState) {
  if (s.status === 'setup' || ['rolling', 'moving'].includes(s.phase)) return
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* Storage may be unavailable in private browsing. Gameplay is still usable. */
  }
}
