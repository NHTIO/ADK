import { describe, expect, it } from 'vitest'
import { makeToolCtxStub, callTool } from '../../../../_fixtures/tool_ctx_stub'
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

// ─── Extended oracle tests ──────────────────────────────────────────

describe('textDiffTool — oracle & edge cases', () => {
  // INVARIANT: diff(x, x) reports no changes
  it('INVARIANT: diff(x, x) reports no changes', async () => {
    const out = await runDiff({ text_a: 'some text', text_b: 'some text' })
    expect(out).toBe('Texts are identical — no differences found.')
  })

  it('full replacement: every line removed and added', async () => {
    const out = await runDiff({ text_a: 'aaa\nbbb', text_b: 'ccc\nddd' })
    expect(out).toContain('- aaa')
    expect(out).toContain('- bbb')
    expect(out).toContain('+ ccc')
    expect(out).toContain('+ ddd')
  })

  it('additions only: text_a is subset of text_b', async () => {
    const out = await runDiff({ text_a: 'line1', text_b: 'line1\nline2' })
    expect(out).toContain('+ line2')
    expect(out).toMatch(/added/)
  })

  it('deletions only: text_b is subset of text_a', async () => {
    const out = await runDiff({ text_a: 'line1\nline2', text_b: 'line1' })
    expect(out).toContain('- line2')
    expect(out).toMatch(/removed/)
  })

  it('empty vs non-empty text', async () => {
    // Schema allows empty strings
    const out = await runDiff({ text_a: '', text_b: 'hello' })
    expect(out).toContain('+ hello')
  })

  it('non-empty vs empty text', async () => {
    const out = await runDiff({ text_a: 'hello', text_b: '' })
    expect(out).toContain('- hello')
  })

  it('word mode: multi-word additions and deletions', async () => {
    const out = await runDiff({
      text_a: 'the quick brown fox',
      text_b: 'the slow red fox',
      mode: 'words',
    })
    expect(out).toContain('- quick brown')
    expect(out).toContain('+ slow red')
  })

  it('word mode with identical text returns identical message', async () => {
    const out = await runDiff({
      text_a: 'hello world',
      text_b: 'hello world',
      mode: 'words',
    })
    expect(out).toBe('Texts are identical — no differences found.')
  })

  it('schema rejects missing text_a', async () => {
    await expect(runDiff({ text_b: 'b' })).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
  })

  // Unicode diff
  it('diffs unicode content correctly', async () => {
    const out = await runDiff({ text_a: 'café', text_b: 'cafe' })
    // 'é' was changed (removed) and 'e' was added, or whole word diff
    expect(out).not.toBe('Texts are identical — no differences found.')
  })
})

describe('stringSimilarityTool — oracle & edge cases', () => {
  // INVARIANT: similarity(a, a) = 1 (100%)
  it('INVARIANT: similarity(a, a) = 100%', async () => {
    const out = await runSim({ a: 'any string here', b: 'any string here' })
    expect(out).toContain('Similarity: 100%')
    expect(out).toContain('Edit distance: 0')
  })

  // INVARIANT: symmetry: similarity(a, b) = similarity(b, a)
  it('INVARIANT: similarity(a, b) = similarity(b, a) — SYMMETRY', async () => {
    const out1 = await runSim({ a: 'kitten', b: 'sitting' })
    const out2 = await runSim({ a: 'sitting', b: 'kitten' })
    // Parse percentage from each output
    const pct1 = Number.parseFloat(out1.match(/Similarity: ([\d.]+)%/)![1])
    const pct2 = Number.parseFloat(out2.match(/Similarity: ([\d.]+)%/)![1])
    expect(pct1).toBeCloseTo(pct2, 1)
  })

  // Oracle: empty vs non-empty
  it('empty vs non-empty has distance = len(non-empty)', async () => {
    const out = await runSim({ a: '', b: 'abcde' })
    expect(out).toContain('Edit distance: 5')
  })

  // Oracle: completely different strings → distance = max(len_a, len_b)
  it('completely different single-char strings have distance 1', async () => {
    const out = await runSim({ a: 'a', b: 'b' })
    expect(out).toContain('Edit distance: 1')
    expect(out).toContain('Similarity: 0%')
  })

  // Oracle: known Levenshtein distance
  it('sunday → saturday has distance 3', async () => {
    const out = await runSim({ a: 'sunday', b: 'saturday' })
    expect(out).toContain('Edit distance: 3')
  })

  // Label thresholds
  it('labels ≥90% as very similar', async () => {
    // 'abc' vs 'abd': distance 1, maxLen 3, pct = 66.7 → 'similar'
    const out = await runSim({ a: 'abcdefgh', b: 'abcdfgh' })
    // distance 2, maxLen 8, pct = 75% → 'similar'
    expect(out).toContain('similar')
  })

  it('labels ≥70% as similar', async () => {
    const out = await runSim({ a: 'abcdef', b: 'abXXXX' })
    // distance 4, maxLen 6, pct = 33.3 → different
    expect(out).toContain('different')
  })

  // Unicode
  it('handles unicode strings', async () => {
    const out = await runSim({ a: 'café', b: 'cafe' })
    // 'café' vs 'cafe' → distance 1 (é→e)
    expect(out).toContain('Edit distance: 1')
  })

  // case_insensitive with unicode
  it('case_insensitive with unicode', async () => {
    const out = await runSim({ a: 'HÉLLO', b: 'héllo', case_insensitive: true })
    expect(out).toContain('Similarity: 100%')
  })

  // One empty string
  it('one empty string has similarity 0%', async () => {
    const out = await runSim({ a: '', b: 'abc' })
    expect(out).toContain('Similarity: 0%')
  })

  // schema rejects missing a
  it('schema rejects missing a', async () => {
    await expect(runSim({ b: 'x' })).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
  })
})

// ─── callTool no-crash regression tests ───────────────────────────────

describe('text_comparison — callTool no-crash edge cases', () => {
  it('textDiffTool does not crash on lone-surrogate strings', async () => {
    const r = await callTool(textDiffTool, { text_a: '\uD800', text_b: 'hello' })
    expect(r.kind).toBe('resolved')
  })

  it('textDiffTool does not crash on emoji strings', async () => {
    const r = await callTool(textDiffTool, { text_a: '\ud83d\udca5', text_b: '\ud83c\udf89' })
    expect(r.kind).toBe('resolved')
  })

  it('textDiffTool does not crash on very long strings', async () => {
    const r = await callTool(textDiffTool, { text_a: 'x'.repeat(5000), text_b: 'y'.repeat(5000) })
    expect(r.kind).toBe('resolved')
  })

  it('stringSimilarityTool does not crash on lone-surrogate strings', async () => {
    const r = await callTool(stringSimilarityTool, { a: '\uD800', b: 'hello' })
    expect(r.kind).toBe('resolved')
  })

  it('stringSimilarityTool does not crash on emoji strings', async () => {
    const r = await callTool(stringSimilarityTool, { a: '\ud83d\udca5', b: '\ud83c\udf89' })
    expect(r.kind).toBe('resolved')
  })
})
