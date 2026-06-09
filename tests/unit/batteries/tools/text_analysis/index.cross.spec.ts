import { describe, expect, it } from 'vitest'
import { makeToolCtxStub, callTool } from '../../../../_fixtures/tool_ctx_stub'
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

// ─── Oracle helpers ────────────────────────────────────────────────
// Hand-computed reference values for known inputs
const ORACLE_PARAGRAPH =
  'The quick brown fox jumps over the lazy dog. It was a sunny day! Will they succeed? Perhaps.'
// words: The quick brown fox jumps over the lazy dog It was a sunny day Will they succeed Perhaps => 16 words
// chars: count the string directly
// sentences: 4 (by .!? delimiters)

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

// ─── Extended oracle tests: textAnalyzeTool ─────────────────────────

describe('textAnalyzeTool — oracle & edge cases', () => {
  // Oracle: hand-computed known paragraph
  it('oracle: hand-computed paragraph statistics', async () => {
    const text = ORACLE_PARAGRAPH
    const out = await runAnalyze(text)
    expect(out.char_count).toBe(text.length)
    expect(out.char_count_no_spaces).toBe(text.replace(/\s/g, '').length)
    expect(out.word_count).toBe(18)
    expect(out.sentence_count).toBe(4)
  })

  // Empty text is rejected by schema (required string, not allow empty)
  it('schema rejects empty text', async () => {
    await expect(textAnalyzeTool.executor(makeToolCtxStub())({ text: '' })).rejects.toBeInstanceOf(
      E_INVALID_TOOL_ARGS
    )
  })

  // Whitespace-only text
  it('whitespace-only text has 0 words and 0 unique words', async () => {
    const out = await runAnalyze('   \n\n\t  ')
    expect(out.word_count).toBe(0)
    expect(out.unique_word_count).toBe(0)
    expect(out.char_count_no_spaces).toBe(0)
  })

  // Unicode: emoji count
  it('counts emoji characters correctly in char_count', async () => {
    // 💥 is U+1F4A5, which is 2 UTF-16 code units (length 2 in JS)
    const text = '💥a'
    const out = await runAnalyze(text)
    expect(out.char_count).toBe(text.length) // JS string length: 3 (2 for emoji + 1 for 'a')
    expect(out.has_unicode).toBe(true)
    expect(out.is_all_ascii).toBe(false)
  })

  // CJK characters
  it('CJK characters are counted in words by whitespace split', async () => {
    const text = '你好 世界'
    const out = await runAnalyze(text)
    expect(out.word_count).toBe(2)
    expect(out.is_all_ascii).toBe(false)
  })

  // Unicode combining marks
  it('NFC vs NFD text have different char counts in JS', async () => {
    const nfc = 'é' // U+00E9, length 1
    const nfd = '\u0065\u0301' // e + combining acute, length 2
    const outNfc = await runAnalyze(nfc)
    const outNfd = await runAnalyze(nfd)
    // char_count uses .length (UTF-16 code units)
    expect(outNfc.char_count).toBe(1)
    expect(outNfd.char_count).toBe(2)
  })

  // Multiple spaces and newlines
  it('multiple spaces collapsed in word count', async () => {
    const out = await runAnalyze('hello    world')
    expect(out.word_count).toBe(2)
  })

  // Line count with trailing newline
  it('line count with trailing newline', async () => {
    const out = await runAnalyze('line1\nline2\n')
    // text.split('\n') on 'line1\nline2\n' gives ['line1','line2',''] => 3 lines
    expect(out.line_count).toBe(3)
  })

  // Single newline = 2 lines
  it('single newline yields 2 lines', async () => {
    const out = await runAnalyze('a\nb')
    expect(out.line_count).toBe(2)
  })

  // is_all_alpha: text with digits is not all alpha
  it('is_all_alpha is false for text with digits', async () => {
    const out = await runAnalyze('hello 123')
    expect(out.is_all_alpha).toBe(false)
  })

  // is_all_alphanumeric: text with punctuation is not all alnum
  it('is_all_alphanumeric is false for text with punctuation', async () => {
    const out = await runAnalyze('hello!')
    expect(out.is_all_alphanumeric).toBe(false)
  })

  // is_all_uppercase / is_all_lowercase on whitespace-only text
  it('is_all_uppercase is false for whitespace-only text (no letters)', async () => {
    const out = await runAnalyze('   ')
    // Whitespace-only: toUpperCase() === toLowerCase() but no [A-Z] or [a-z]
    expect(out.is_all_uppercase).toBe(false)
    expect(out.is_all_lowercase).toBe(false)
  })

  // Unique words: punctuation stripped, case-insensitive
  it('unique_word_count strips non-alpha and lowercases', async () => {
    const out = await runAnalyze("it's it-s ITS")
    // "it's" -> "its", "it-s" -> "its", "ITS" -> "its"
    expect(out.unique_word_count).toBe(1)
  })

  // avg_word_length
  it('avg_word_length computed correctly on known input', async () => {
    // 'abc de' -> words ['abc', 'de'], total len 5, avg 2.5
    const out = await runAnalyze('abc de')
    expect(out.avg_word_length).toBe(2.5)
  })

  // Token estimate: ceil(len/4)
  it('token_estimate is ceil(char_count / 4)', async () => {
    const text = '12345678' // 8 chars => ceil(8/4) = 2
    const out = await runAnalyze(text)
    expect(out.token_estimate).toBe(2)
    const text2 = '123456789' // 9 chars => ceil(9/4) = 3
    const out2 = await runAnalyze(text2)
    expect(out2.token_estimate).toBe(3)
  })

  // Text with embedded null and tabs
  it('text with tabs and embedded characters', async () => {
    const text = 'a\tb\nc\r\nd'
    const out = await runAnalyze(text)
    expect(out.word_count).toBe(4) // 'a', 'b', 'c', 'd'
    expect(out.char_count).toBe(text.length)
  })

  // Single word
  it('single word text', async () => {
    const out = await runAnalyze('hello')
    expect(out.word_count).toBe(1)
    expect(out.unique_word_count).toBe(1)
    expect(out.sentence_count).toBe(1)
    expect(out.paragraph_count).toBe(1)
    expect(out.avg_word_length).toBe(5)
  })

  // Lone surrogate
  it('lone surrogate character is not ascii', async () => {
    const out = await runAnalyze('\uD800')
    expect(out.is_all_ascii).toBe(false)
    expect(out.has_unicode).toBe(true)
  })

  // Zero-width characters
  it('zero-width characters counted in char_count but may not appear as visible words', async () => {
    const text = 'a\u200Bb' // a + zero-width space + b
    const out = await runAnalyze(text)
    expect(out.char_count).toBe(3)
    expect(out.word_count).toBe(1) // 'ab' is one word after trim+split
  })

  // schema: rejects non-string text
  it('schema rejects numeric text', async () => {
    await expect(
      textAnalyzeTool.executor(makeToolCtxStub())({ text: 123 } as unknown as { text: string })
    ).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
  })
})

// ─── Extended oracle tests: textLinesTool ───────────────────────────

describe('textLinesTool — oracle & edge cases', () => {
  // ─── sort ───────────────────────────────────────────────────────────
  describe('sort', () => {
    it('sort then sort is idempotent (INVARIANT)', async () => {
      const text = 'cherry\napple\nbanana'
      const first = await runLines({ text, operation: 'sort' })
      const second = await runLines({ text: first, operation: 'sort' })
      expect(second).toBe(first)
    })

    it('sort_desc with case_insensitive', async () => {
      const out = await runLines({
        text: 'Banana\napple\nCherry',
        operation: 'sort_desc',
        case_insensitive: true,
      })
      // Descending CI sort: cherry > banana > apple
      expect(out).toBe('Cherry\nBanana\napple')
    })
  })

  // ─── reverse ───────────────────────────────────────────────────────
  describe('reverse', () => {
    it('reverse then reverse is identity (INVARIANT)', async () => {
      const text = 'a\nb\nc\nd'
      const rev = await runLines({ text, operation: 'reverse' })
      const revrev = await runLines({ text: rev, operation: 'reverse' })
      expect(revrev).toBe(text)
    })
  })

  // ─── deduplicate ──────────────────────────────────────────────────
  describe('deduplicate', () => {
    it('deduplicate then deduplicate is idempotent (INVARIANT)', async () => {
      const text = 'a\nb\na\nc\nb'
      const first = await runLines({ text, operation: 'deduplicate' })
      const second = await runLines({ text: first, operation: 'deduplicate' })
      expect(second).toBe(first)
    })

    it('preserves first occurrence of each unique line', async () => {
      const out = await runLines({ text: 'zzz\naaa\nzzz\naaa\nbbb', operation: 'deduplicate' })
      expect(out).toBe('zzz\naaa\nbbb')
    })
  })

  // ─── filter_empty ─────────────────────────────────────────────────
  describe('filter_empty', () => {
    it('all lines empty yields empty string', async () => {
      const out = await runLines({ text: '\n\n\n', operation: 'filter_empty' })
      expect(out).toBe('')
    })

    it('keeps lines with only whitespace but non-zero content', async () => {
      // '  ' has .trim() === '' so it should be filtered
      const out = await runLines({ text: 'hello\n   \nworld', operation: 'filter_empty' })
      expect(out).toBe('hello\nworld')
    })
  })

  // ─── trim_each ────────────────────────────────────────────────────
  describe('trim_each', () => {
    it('preserves inner whitespace', async () => {
      const out = await runLines({ text: '  hello world  ', operation: 'trim_each' })
      expect(out).toBe('hello world')
    })

    it('does not collapse multiple lines', async () => {
      const out = await runLines({ text: '  a  \n  b  \n  c  ', operation: 'trim_each' })
      expect(out).toBe('a\nb\nc')
    })
  })

  // ─── number ──────────────────────────────────────────────────────
  describe('number', () => {
    it('numbers each line starting at 1', async () => {
      const out = await runLines({ text: 'x\ny\nz', operation: 'number' })
      expect(out).toBe('1. x\n2. y\n3. z')
    })

    it('numbers empty lines too', async () => {
      const out = await runLines({ text: 'a\n\nb', operation: 'number' })
      expect(out).toBe('1. a\n2. \n3. b')
    })
  })

  // ─── count ───────────────────────────────────────────────────────
  describe('count', () => {
    it('single line: 1 total, 1 non-empty, 0 empty', async () => {
      const out = await runLines({ text: 'hello', operation: 'count' })
      expect(out).toContain('1 lines')
      expect(out).toContain('1 non-empty')
      expect(out).toContain('0 empty')
    })

    it('schema rejects empty text for count', async () => {
      await expect(runLines({ text: '', operation: 'count' })).rejects.toBeInstanceOf(
        E_INVALID_TOOL_ARGS
      )
    })
  })

  // ─── mixed case & unicode ────────────────────────────────────────
  describe('unicode & edge cases', () => {
    it('sort handles unicode characters', async () => {
      const out = await runLines({ text: 'é\na\nü', operation: 'sort' })
      // localeCompare ordering: a, é, ü
      expect(out).toBe('a\né\nü')
    })

    it('deduplicate with case_insensitive on mixed scripts', async () => {
      const out = await runLines({
        text: 'café\nCAFÉ\nCafé',
        operation: 'deduplicate',
        case_insensitive: true,
      })
      expect(out).toBe('café')
    })

    it('reverse preserves each line as-is', async () => {
      const text = 'hello\nworld\n💥'
      const out = await runLines({ text, operation: 'reverse' })
      expect(out).toBe('💥\nworld\nhello')
    })

    it('filter_empty removes whitespace-only lines', async () => {
      const out = await runLines({ text: 'a\n   \n\tb\nc', operation: 'filter_empty' })
      expect(out).toBe('a\n\tb\nc')
    })
  })
})

// ─── callTool no-crash regression tests ───────────────────────────────

describe('text_analysis — callTool no-crash edge cases', () => {
  it('textAnalyzeTool does not crash on lone surrogate', async () => {
    const r = await callTool(textAnalyzeTool, { text: '\uD800' })
    expect(r.kind).toBe('resolved')
  })

  it('textAnalyzeTool does not crash on emoji-heavy text', async () => {
    const r = await callTool(textAnalyzeTool, { text: '\ud83d\udca5\ud83c\udf89\ud83c\udf8a' })
    expect(r.kind).toBe('resolved')
  })

  it('textAnalyzeTool does not crash on BOM text', async () => {
    const r = await callTool(textAnalyzeTool, { text: '\uFEFFhello' })
    expect(r.kind).toBe('resolved')
  })

  it('textAnalyzeTool does not crash on very long text', async () => {
    const r = await callTool(textAnalyzeTool, { text: 'x'.repeat(50000) })
    expect(r.kind).toBe('resolved')
  })

  it('textLinesTool does not crash on lone surrogate lines', async () => {
    const r = await callTool(textLinesTool, { text: '\uD800\nhello', operation: 'sort' })
    expect(r.kind).toBe('resolved')
  })

  it('textLinesTool does not crash on emoji lines', async () => {
    const r = await callTool(textLinesTool, { text: '\ud83d\udca5\nworld', operation: 'reverse' })
    expect(r.kind).toBe('resolved')
  })

  it('textLinesTool does not crash on whitespace-only text with sort', async () => {
    const r = await callTool(textLinesTool, { text: '   \n\t  ', operation: 'sort' })
    expect(r.kind).toBe('resolved')
  })
})
