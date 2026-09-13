import { describe, expect, it } from 'vitest'
import { validateOptions } from '../../../../../src/batteries/llm/gemini_generate_content/validation'
import { E_INVALID_GEMINI_GENERATE_CONTENT_OPTIONS } from '../../../../../src/batteries/llm/gemini_generate_content/exceptions'

const baseOptions = (): Record<string, unknown> => ({
  model: 'gemini-2.5-flash',
  apiKey: 'test-key',
})

describe('gemini_generate_content validation — unsupportedMediaPolicy', () => {
  it('defaults to "throw" when omitted', () => {
    const resolved = validateOptions(baseOptions())
    expect(resolved.unsupportedMediaPolicy).toBe('throw')
  })

  it('accepts each enum member', () => {
    for (const policy of ['throw', 'fallback-stash', 'synthetic-description'] as const) {
      const resolved = validateOptions({ ...baseOptions(), unsupportedMediaPolicy: policy })
      expect(resolved.unsupportedMediaPolicy).toBe(policy)
    }
  })

  it('accepts the { mode: "fallback-stash", stashKeys } object form the type permits', () => {
    // The bare-string schema used to reject this valid value; it must now pass, matching the other
    // LLM batteries and the UnsupportedMediaPolicy union.
    const resolved = validateOptions({
      ...baseOptions(),
      unsupportedMediaPolicy: { mode: 'fallback-stash', stashKeys: ['caption', 'alt'] },
    })
    expect(resolved.unsupportedMediaPolicy).toEqual({
      mode: 'fallback-stash',
      stashKeys: ['caption', 'alt'],
    })
  })

  it('rejects an arbitrary string that is not an enum member', () => {
    // The bare-string schema accepted any string; the constrained union must refuse this.
    expect(() =>
      validateOptions({ ...baseOptions(), unsupportedMediaPolicy: 'not-a-policy' })
    ).toThrow(E_INVALID_GEMINI_GENERATE_CONTENT_OPTIONS)
  })

  it('rejects an object with an unknown mode or missing stashKeys', () => {
    expect(() =>
      validateOptions({ ...baseOptions(), unsupportedMediaPolicy: { mode: 'throw' } })
    ).toThrow(E_INVALID_GEMINI_GENERATE_CONTENT_OPTIONS)
    expect(() =>
      validateOptions({ ...baseOptions(), unsupportedMediaPolicy: { mode: 'fallback-stash' } })
    ).toThrow(E_INVALID_GEMINI_GENERATE_CONTENT_OPTIONS)
  })
})
