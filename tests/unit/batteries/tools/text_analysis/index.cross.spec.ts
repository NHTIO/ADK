import { describe, expect, it } from 'vitest'
import { makeToolCtxStub } from '../../../../_fixtures/tool_ctx_stub'
import { E_INVALID_TOOL_ARGS } from '../../../../../src/lib/exceptions/runtime'
import { SpooledJsonArtifact } from '../../../../../src/lib/classes/spooled_json_artifact'
import { textAnalyzeTool, textLinesTool } from '../../../../../src/batteries/tools/text_analysis'

const runAnalyze = async (text: string): Promise<Record<string, unknown>> => {
  const out = (await textAnalyzeTool.executor(makeToolCtxStub())({ text })) as string
  return JSON.parse(out) as Record<string, unknown>
}

const runLines = async (args: Record<string, unknown>): Promise<string> => {
  return (await textLinesTool.executor(makeToolCtxStub())(args)) as string
}

describe('textAnalyzeTool', () => {
  it('counts characters with and without spaces', async () => {
    const out = await runAnalyze('hello world')
    expect(out.char_count).toBe(11)
    expect(out.char_count_no_spaces).toBe(10)
  })

  it('counts words', async () => {
    const out = await runAnalyze('the quick brown fox')
    expect(out.word_count).toBe(4)
  })

  it('counts unique words (case-insensitive, ignoring punctuation)', async () => {
    const out = await runAnalyze('Hello, hello! Hello.')
    expect(out.unique_word_count).toBe(1)
  })

  it('counts sentences split by .!?', async () => {
    const out = await runAnalyze('First. Second! Third?')
    expect(out.sentence_count).toBe(3)
  })

  it('counts paragraphs separated by blank lines', async () => {
    const out = await runAnalyze('Paragraph one.\n\nParagraph two.\n\nParagraph three.')
    expect(out.paragraph_count).toBe(3)
  })

  it('reports avg_word_length to 2 decimals', async () => {
    const out = await runAnalyze('aa bb cc')
    expect(out.avg_word_length).toBe(2)
  })

  it('flags is_all_alpha for purely-alphabetic text', async () => {
    const out = await runAnalyze('hello world')
    expect(out.is_all_alpha).toBe(true)
    expect(out.is_all_numeric).toBe(false)
  })

  it('flags is_all_numeric for digit-only text', async () => {
    const out = await runAnalyze('12345')
    expect(out.is_all_numeric).toBe(true)
    expect(out.is_all_alpha).toBe(false)
  })

  it('flags is_all_ascii / has_unicode correctly', async () => {
    const ascii = await runAnalyze('plain ASCII')
    expect(ascii.is_all_ascii).toBe(true)
    expect(ascii.has_unicode).toBe(false)
    const uni = await runAnalyze('héllo')
    expect(uni.is_all_ascii).toBe(false)
    expect(uni.has_unicode).toBe(true)
  })

  it('flags is_all_lowercase / is_all_uppercase', async () => {
    const lower = await runAnalyze('hello world')
    expect(lower.is_all_lowercase).toBe(true)
    const upper = await runAnalyze('HELLO WORLD')
    expect(upper.is_all_uppercase).toBe(true)
    const mixed = await runAnalyze('Mixed Case')
    expect(mixed.is_all_lowercase).toBe(false)
  })

  it('approximates token count as ceil(chars / 4)', async () => {
    const out = await runAnalyze('1234567890')
    expect(out.token_estimate).toBe(3)
  })

  it('declares its artifact constructor as SpooledJsonArtifact', () => {
    expect(textAnalyzeTool.artifactConstructor?.()).toBe(SpooledJsonArtifact)
  })

  it('schema rejects missing text', async () => {
    await expect(textAnalyzeTool.executor(makeToolCtxStub())({})).rejects.toBeInstanceOf(
      E_INVALID_TOOL_ARGS
    )
  })
})

describe('textLinesTool', () => {
  describe('sort', () => {
    it('sorts ascending case-sensitively by default', async () => {
      const out = await runLines({ text: 'banana\napple\ncherry', operation: 'sort' })
      expect(out).toBe('apple\nbanana\ncherry')
    })

    it('case_insensitive sort ignores casing', async () => {
      const out = await runLines({
        text: 'Banana\napple\nCherry',
        operation: 'sort',
        case_insensitive: true,
      })
      expect(out).toBe('apple\nBanana\nCherry')
    })
  })

  it('sort_desc returns descending order', async () => {
    const out = await runLines({ text: 'apple\nbanana\ncherry', operation: 'sort_desc' })
    expect(out).toBe('cherry\nbanana\napple')
  })

  it('reverse flips the order without sorting', async () => {
    const out = await runLines({ text: 'first\nsecond\nthird', operation: 'reverse' })
    expect(out).toBe('third\nsecond\nfirst')
  })

  describe('deduplicate', () => {
    it('removes duplicate lines while preserving first-seen order', async () => {
      const out = await runLines({ text: 'a\nb\na\nc\nb', operation: 'deduplicate' })
      expect(out).toBe('a\nb\nc')
    })

    it('case_insensitive deduplicate treats different cases as duplicates', async () => {
      const out = await runLines({
        text: 'Hello\nHELLO\nhello\nWorld',
        operation: 'deduplicate',
        case_insensitive: true,
      })
      expect(out).toBe('Hello\nWorld')
    })
  })

  it('filter_empty drops blank lines', async () => {
    const out = await runLines({ text: 'a\n\nb\n   \nc', operation: 'filter_empty' })
    expect(out).toBe('a\nb\nc')
  })

  it('trim_each strips leading/trailing whitespace on each line', async () => {
    const out = await runLines({ text: '  a  \n  b  ', operation: 'trim_each' })
    expect(out).toBe('a\nb')
  })

  it('number prefixes each line with its 1-based index', async () => {
    const out = await runLines({ text: 'a\nb\nc', operation: 'number' })
    expect(out).toBe('1. a\n2. b\n3. c')
  })

  it('count reports total / non-empty / empty', async () => {
    const out = await runLines({ text: 'a\n\nb\n\nc', operation: 'count' })
    expect(out).toMatch(/5 lines/)
    expect(out).toContain('3 non-empty')
    expect(out).toContain('2 empty')
  })

  it('schema rejects unknown operation', async () => {
    await expect(runLines({ text: 'a', operation: 'shuffle' })).rejects.toBeInstanceOf(
      E_INVALID_TOOL_ARGS
    )
  })
})
