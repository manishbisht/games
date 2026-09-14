import { describe, expect, it } from 'vitest'
import { getAdapter } from '@games/shared/online'
import type { GameId } from '@games/shared/protocol'
import { games } from '../games/catalog'
import { onlineGame } from './games'

/**
 * Skill ids are duplicated on purpose: the frontend cannot import the adapter
 * registry, because pulling it into the bundle would drag every game's rules
 * along with it. The server is the only thing that validates a skill, so this
 * is what stops the two lists drifting — vitest runs in Node and bundles
 * nothing, so importing the registry here is free.
 */
describe('bot skills the room will actually accept', () => {
  const online = games.filter((game) => game.online)

  it('covers every game the catalog says is online', () => {
    expect(online.map((game) => game.id)).toEqual(['hearth', 'estate', 'chess', 'prism', 'wildrise'])
  })

  for (const game of online) {
    it(`${game.id} offers exactly the skills its adapter knows`, () => {
      const adapter = getAdapter(game.id as GameId)
      const config = onlineGame(game.id)
      expect(adapter).toBeDefined()
      expect(config).toBeDefined()
      const labelled = config!.botSkills?.map((skill) => skill.id) ?? []
      // A game with no bots on the server must not offer any here: the room
      // would answer NOT_ALLOWED and the control would be a dead end.
      expect(labelled).toEqual([...(adapter!.bots?.skills ?? [])])
    })

    it(`${game.id} labels every skill it offers, and none twice`, () => {
      const skills = onlineGame(game.id)!.botSkills ?? []
      for (const skill of skills) expect(skill.label.trim()).not.toBe('')
      expect(new Set(skills.map((s) => s.label)).size).toBe(skills.length)
    })
  }

  it('leads with the skill the server would have picked by itself', () => {
    // `addBot` without a skill takes `skills[0]`, so the first one listed here
    // is what an unchanged picker sends — they have to be the same one.
    for (const game of online) {
      const adapter = getAdapter(game.id as GameId)
      const first = onlineGame(game.id)!.botSkills?.[0]?.id
      if (adapter?.bots) expect(first).toBe(adapter.bots.skills[0])
    }
  })
})
