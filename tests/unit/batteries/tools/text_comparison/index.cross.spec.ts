import { describe, expect, it } from 'vitest'
import { makeToolCtxStub } from '../../../../_fixtures/tool_ctx_stub'
import { E_INVALID_TOOL_ARGS } from '../../../../../src/lib/exceptions/runtime'
import {
  stringSimilarityTool,
  textDiffTool,
} from '../../../../../src/batteries/tools/text_comparison'

const runDiff = async (args: Record<string, unknown>): Promise<string> => {
  return (await textDiffTool.executor(makeToolCtxStub())(args)) as string
}
const runSim = async (args: Record<string, unknown>): Promise<string> => {
  return (await stringSimilarityTool.executor(makeToolCtxStub())(args)) as string
}

describe('textDiffTool', () => {
  it('reports identical texts immediately', async () => {
    expect(await runDiff({ text_a: 'same', text_b: 'same' })).toBe(
      'Texts are identical — no differences found.'
    )
  })

  it('shows additions and removals in line mode', async () => {
    const out = await runDiff({
      text_a: 'one\ntwo\nthree',
      text_b: 'one\nTWO\nthree',
    })
    expect(out).toContain('+ TWO')
    expect(out).toContain('- two')
    expect(out).toMatch(/\+1 line added/)
    expect(out).toMatch(/-1 line removed/)
  })

  it('handles pluralisation', async () => {
    const out = await runDiff({
      text_a: 'one\ntwo\nthree',
      text_b: 'one\nfour\nfive',
    })
    expect(out).toMatch(/lines added/)
    expect(out).toMatch(/lines removed/)
  })

  it('reports unchanged count', async () => {
    const out = await runDiff({
      text_a: 'a\nb\nc',
      text_b: 'a\nB\nc',
    })
    expect(out).toMatch(/2 unchanged/)
  })

  it('truncates very long diffs', async () => {
    const longA = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n')
    const longB = Array.from({ length: 100 }, (_, i) => `LINE${i}`).join('\n')
    const out = await runDiff({ text_a: longA, text_b: longB })
    expect(out).toMatch(/more lines truncated/)
  })

  it('word mode detects single-word changes', async () => {
    const out = await runDiff({
      text_a: 'the quick brown fox',
      text_b: 'the slow brown fox',
      mode: 'words',
    })
    expect(out).toMatch(/words? added/)
    expect(out).toContain('+ slow')
  })

  it('schema rejects invalid mode', async () => {
    await expect(runDiff({ text_a: 'a', text_b: 'b', mode: 'chars' })).rejects.toBeInstanceOf(
      E_INVALID_TOOL_ARGS
    )
  })

  it('schema rejects missing text_b', async () => {
    await expect(runDiff({ text_a: 'a' })).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
  })
})

describe('stringSimilarityTool', () => {
  it('reports 100% for identical strings', async () => {
    const out = await runSim({ a: 'hello', b: 'hello' })
    expect(out).toContain('Edit distance: 0')
    expect(out).toContain('Similarity: 100%')
    expect(out).toContain('identical')
  })

  it('reports 100% for two empty strings', async () => {
    const out = await runSim({ a: '', b: '' })
    expect(out).toContain('Similarity: 100%')
  })

  it('computes Levenshtein distance for single-char change', async () => {
    const out = await runSim({ a: 'kitten', b: 'sitten' })
    expect(out).toContain('Edit distance: 1')
  })

  it('classic kitten -> sitting has distance 3', async () => {
    const out = await runSim({ a: 'kitten', b: 'sitting' })
    expect(out).toContain('Edit distance: 3')
  })

  it('labels low similarity as very different', async () => {
    const out = await runSim({ a: 'apple', b: 'xyz' })
    expect(out).toContain('very different')
  })

  it('respects case_insensitive flag', async () => {
    const out = await runSim({ a: 'HELLO', b: 'hello', case_insensitive: true })
    expect(out).toContain('Similarity: 100%')
  })

  it('case-sensitive default treats casing as different', async () => {
    const out = await runSim({ a: 'HELLO', b: 'hello' })
    expect(out).not.toContain('Similarity: 100%')
  })

  it('schema rejects missing b', async () => {
    await expect(runSim({ a: 'x' })).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
  })
})
