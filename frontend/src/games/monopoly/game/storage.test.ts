import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGame, gameReducer } from '@games/shared/estate'
import { loadGame, saveGame } from './storage'

describe('saved game recovery', () => {
  let records: Map<string, string>
  beforeEach(() => {
    records = new Map()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => records.get(k) ?? null,
      setItem: (k: string, v: string) => records.set(k, v),
    })
  })
  afterEach(() => vi.unstubAllGlobals())
  const started = () =>
    gameReducer(createGame(), {
      type: 'START',
      players: [
        { name: 'Alex', isBot: false },
        { name: 'Sam', isBot: true },
      ],
      mode: 'classic',
      seed: 42,
    })
  it('restores a stable game exactly', () => {
    const s = started()
    saveGame(s)
    expect(loadGame()).toEqual(s)
  })
  it('returns old same-device multiplayer to setup without replacing the save', () => {
    const s = started()
    s.players[1].isBot = false
    saveGame(s)
    expect(loadGame().status).toBe('setup')
    expect(JSON.parse(records.get('estate-game-v1')!).players[1].isBot).toBe(false)
  })
  it('refreshes legacy token colors without losing saved progress', () => {
    const s = started()
    s.players[0].color = '#e9ad72'
    s.players[0].cash = 1234
    s.players[0].position = 15
    saveGame(s)
    const restored = loadGame()
    expect(restored.players[0].color).toBe('#eca04e')
    expect(restored.players[0].cash).toBe(1234)
    expect(restored.players[0].position).toBe(15)
    expect(restored.seed).toBe(s.seed)
  })
  it('keeps the last stable snapshot during movement', () => {
    const s = started()
    saveGame(s)
    const moving = { ...s, phase: 'moving' as const, stepsRemaining: 7 }
    saveGame(moving)
    expect(loadGame()).toEqual(s)
  })
  it('recovers from malformed JSON and unsupported versions', () => {
    records.set('estate-game-v1', '{')
    expect(loadGame().status).toBe('setup')
    records.set('estate-game-v1', JSON.stringify({ ...started(), version: 99 }))
    expect(loadGame().status).toBe('setup')
  })
  it('rejects an invalid winner and invalid property owners', () => {
    saveGame({ ...started(), status: 'finished', winner: null })
    expect(loadGame().status).toBe('setup')
    saveGame({ ...started(), properties: { 1: { owner: 7, level: 0, mortgaged: false } } })
    expect(loadGame().status).toBe('setup')
  })
  it('works when storage is blocked', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    })
    expect(() => saveGame(started())).not.toThrow()
    expect(loadGame().status).toBe('setup')
  })
})
