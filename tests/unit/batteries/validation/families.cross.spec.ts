import { describe, expect, it } from 'vitest'
import { permissive } from '../../../../src/batteries/validation/profiles'
import { E_UNKNOWN_ORDERING_PROFILE } from '../../../../src/batteries/validation/exceptions'
import { resolveFamilyRecipe } from '../../../../src/batteries/validation/profiles/families'

describe('family ordering recipes', () => {
  it('resolves representative confirmed and unconfirmed families', () => {
    const keys = [
      'anthropic-manual-thinking',
      'gemini-3',
      'kimi-k3',
      'grok',
      'granite-3-x',
      'bytedance-seed',
    ] as const

    for (const key of keys) {
      const profile = resolveFamilyRecipe(key)
      expect(profile).toBeDefined()
      expect(profile.name).toBeTypeOf('string')
      expect(profile.description).toBeTypeOf('string')
      if (key !== 'grok') expect(profile.rules.length).toBeGreaterThan(0)
    }
  })

  it('throws E_UNKNOWN_ORDERING_PROFILE for an unknown family key', () => {
    expect(() => resolveFamilyRecipe('not-a-real-family')).toThrow(E_UNKNOWN_ORDERING_PROFILE)
  })

  it('resolves Grok to the permissive profile object', () => {
    const profile = resolveFamilyRecipe('grok')
    expect(profile).toBe(permissive)
    expect(profile.rules).toEqual([])
    expect(profile.permissive).toBe(true)
  })

  it('documents unavailable Gemini functionResponse adjacency enforcement', () => {
    expect(resolveFamilyRecipe('gemini-3').description).toMatch(
      /Gemini function-response adjacency is enforced directly.*Message may not immediately follow a ToolCall/i
    )
  })

  it('returns the cached profile object on repeated resolution', () => {
    const first = resolveFamilyRecipe('anthropic-manual-thinking')
    const second = resolveFamilyRecipe('anthropic-manual-thinking')
    expect(second).toBe(first)
  })
})
