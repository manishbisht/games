import { describe, expect, it } from 'vitest'
import { generateRoomCode, normalizeRoomCode, ROOM_CODE_ALPHABET } from './codes'

describe('room codes', () => {
  it('generates 6 chars from the unambiguous alphabet', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateRoomCode()
      expect(code).toHaveLength(6)
      for (const ch of code) expect(ROOM_CODE_ALPHABET).toContain(ch)
    }
  })
  it('is deterministic given a random source', () => {
    expect(generateRoomCode(() => 0)).toBe('AAAAAA')
  })
  it('normalizes case and whitespace', () => {
    expect(normalizeRoomCode('  kx3f9m ')).toBe('KX3F9M')
  })
  it('rejects wrong length and ambiguous characters', () => {
    expect(normalizeRoomCode('KX3F9')).toBeNull()
    expect(normalizeRoomCode('KX3F90')).toBeNull()
    expect(normalizeRoomCode('KX3FO1')).toBeNull()
    expect(normalizeRoomCode('')).toBeNull()
  })
})
