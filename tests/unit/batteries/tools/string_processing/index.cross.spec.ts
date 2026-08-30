import { describe, expect, it } from 'vitest'
import { callTool } from '../../../../_fixtures/tool_ctx_stub'
import { makeToolCtxStub } from '../../../../_fixtures/tool_ctx_stub'
import { E_INVALID_TOOL_ARGS } from '../../../../../src/lib/exceptions/runtime'
import {
  stringExtractTool,
  stringTransformTool,
} from '../../../../../src/batteries/tools/string_processing'

const runT = async (text: string, ops: Array<Record<string, unknown>>): Promise<string> => {
  return (await stringTransformTool.executor(makeToolCtxStub())({
    text,
    operations: ops,
  })) as string
}
const runX = async (args: Record<string, unknown>): Promise<string> => {
  return (await stringExtractTool.executor(makeToolCtxStub())(args)) as string
}

describe('stringTransformTool', () => {
  describe('case conversion', () => {
    it('uppercase', async () => {
      expect(await runT('hello', [{ op: 'uppercase' }])).toBe('HELLO')
    })
    it('lowercase', async () => {
      expect(await runT('HELLO', [{ op: 'lowercase' }])).toBe('hello')
    })
    it('capitalize only uppercases first char', async () => {
      expect(await runT('hello world', [{ op: 'capitalize' }])).toBe('Hello world')
    })
    it('sentence_case', async () => {
      expect(await runT('HELLO world', [{ op: 'sentence_case' }])).toBe('Hello world')
    })
    it('camel_case', async () => {
      expect(await runT('hello world foo', [{ op: 'camel_case' }])).toBe('helloWorldFoo')
    })
    it('pascal_case', async () => {
      expect(await runT('hello world foo', [{ op: 'pascal_case' }])).toBe('HelloWorldFoo')
    })
    it('snake_case', async () => {
      expect(await runT('helloWorld', [{ op: 'snake_case' }])).toBe('hello_world')
    })
    it('kebab_case', async () => {
      expect(await runT('helloWorld', [{ op: 'kebab_case' }])).toBe('hello-world')
    })
    it('constant_case', async () => {
      expect(await runT('helloWorld', [{ op: 'constant_case' }])).toBe('HELLO_WORLD')
    })
  })

  describe('trimming and whitespace', () => {
    it('trim removes both ends', async () => {
      expect(await runT('  hi  ', [{ op: 'trim' }])).toBe('hi')
    })
    it('trim_start only strips leading', async () => {
      expect(await runT('  hi  ', [{ op: 'trim_start' }])).toBe('hi  ')
    })
    it('trim_end only strips trailing', async () => {
      expect(await runT('  hi  ', [{ op: 'trim_end' }])).toBe('  hi')
    })
    it('normalize_whitespace collapses runs', async () => {
      expect(await runT('a   b\t\nc', [{ op: 'normalize_whitespace' }])).toBe('a b c')
    })
  })

  it('reverse flips chars', async () => {
    expect(await runT('abc', [{ op: 'reverse' }])).toBe('cba')
  })

  it('slug strips diacritics, lowercases, dashifies', async () => {
    expect(await runT('Héllo World!', [{ op: 'slug' }])).toBe('hello-world')
  })

  it('strip_html removes tags', async () => {
    expect(await runT('<p>hi <b>there</b></p>', [{ op: 'strip_html' }])).toBe('hi there')
  })

  describe('counters', () => {
    it('count_words', async () => {
      expect(await runT('one two three', [{ op: 'count_words' }])).toBe('3')
    })
    it('count_chars', async () => {
      expect(await runT('hello', [{ op: 'count_chars' }])).toBe('5')
    })
    it('count_lines', async () => {
      expect(await runT('a\nb\nc', [{ op: 'count_lines' }])).toBe('3')
    })
  })

  it('repeat caps at 100', async () => {
    const out = await runT('a', [{ op: 'repeat', count: 5 }])
    expect(out).toBe('aaaaa')
  })

  it('pad_start / pad_end with custom char', async () => {
    expect(await runT('hi', [{ op: 'pad_start', length: 5, char: '*' }])).toBe('***hi')
    expect(await runT('hi', [{ op: 'pad_end', length: 5, char: '*' }])).toBe('hi***')
  })

  it('slice', async () => {
    expect(await runT('hello world', [{ op: 'slice', start: 0, end: 5 }])).toBe('hello')
  })

  it('truncate adds suffix when over length', async () => {
    expect(await runT('hello world', [{ op: 'truncate', length: 8 }])).toBe('hello w…')
  })

  it('truncate leaves short strings alone', async () => {
    expect(await runT('hi', [{ op: 'truncate', length: 8 }])).toBe('hi')
  })

  it('replace replaces first match only', async () => {
    expect(await runT('a a a', [{ op: 'replace', from: 'a', to: 'b' }])).toBe('b a a')
  })

  it('replace_all replaces every occurrence', async () => {
    expect(await runT('a a a', [{ op: 'replace_all', from: 'a', to: 'b' }])).toBe('b b b')
  })

  it('regex_replace applies pattern', async () => {
    expect(
      await runT('hello 123 world 456', [
        { op: 'regex_replace', pattern: '\\d+', replacement: 'N' },
      ])
    ).toBe('hello N world N')
  })

  it('regex_replace rejects invalid regex', async () => {
    const out = await runT('x', [{ op: 'regex_replace', pattern: '[unclosed', replacement: 'y' }])
    expect(out).toMatch(/^Error in operation/)
  })

  it('split produces JSON array (terminal operation)', async () => {
    expect(await runT('a,b,c', [{ op: 'split', delimiter: ',' }])).toBe('["a","b","c"]')
  })

  it('errors when an operation runs on a non-string (after count_*)', async () => {
    const out = await runT('hi', [{ op: 'count_chars' }, { op: 'uppercase' }])
    expect(out).toMatch(/^Error: Operation 2/)
  })

  it('indent prefixes each line', async () => {
    expect(await runT('a\nb', [{ op: 'indent', size: 2 }])).toBe('  a\n  b')
  })

  it('dedent strips common leading whitespace', async () => {
    expect(await runT('    a\n      b', [{ op: 'dedent' }])).toBe('a\n  b')
  })

  it('applies pipeline operations in order', async () => {
    expect(await runT('  Hello World  ', [{ op: 'trim' }, { op: 'kebab_case' }])).toBe(
      'hello-world'
    )
  })

  it('schema requires operations array', async () => {
    await expect(
      stringTransformTool.executor(makeToolCtxStub())({ text: 'x' })
    ).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
  })
})

describe('stringExtractTool', () => {
  it('extracts all matches', async () => {
    const out = await runX({ text: 'one 1 two 22 three 333', pattern: '\\d+' })
    expect(out).toBe('["1","22","333"]')
  })

  it('returns "No matches found." when nothing matches', async () => {
    const out = await runX({ text: 'hello', pattern: '\\d+' })
    expect(out).toBe('No matches found.')
  })

  it('returns a specific capture group when group > 0', async () => {
    const out = await runX({
      text: 'name=alice age=30',
      pattern: '(\\w+)=(\\w+)',
      group: 2,
    })
    expect(out).toBe('["alice","30"]')
  })

  it('rejects invalid regex with an error string', async () => {
    const out = await runX({ text: 'x', pattern: '[unclosed' })
    expect(out).toMatch(/^Error: Invalid regex/)
  })

  it('respects case-insensitive flag', async () => {
    const out = await runX({ text: 'ABC abc', pattern: '[a-z]+', flags: 'i' })
    expect(out).toBe('["ABC","abc"]')
  })

  it('schema rejects missing pattern', async () => {
    await expect(runX({ text: 'x' })).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
  })
})

// ============================================================
// ADDITIONAL COMPREHENSIVE TESTS
// ============================================================

describe('stringTransformTool comprehensive operation tests', () => {
  describe('all operations with edge cases', () => {
    it('titlecase produces title-cased output', async () => {
      const out = await runT('hello world from mars', [{ op: 'titlecase' }])
      expect(out).toBe('Hello World From Mars')
    })

    it('sentence_case capitalizes first char and lowercases rest', async () => {
      const out = await runT('hELLO WORLD', [{ op: 'sentence_case' }])
      expect(out).toBe('Hello world')
    })

    it('train_case converts camelCase to Train-Case', async () => {
      const out = await runT('helloWorld', [{ op: 'train_case' }])
      expect(out).toBe('Hello-World')
    })

    it('trim on string with only whitespace returns empty', async () => {
      const out = await runT('   \t\n  ', [{ op: 'trim' }])
      expect(out).toBe('')
    })

    it('normalize_whitespace handles mixed whitespace types', async () => {
      const out = await runT('a\t\t\n\n  b\r\nc', [{ op: 'normalize_whitespace' }])
      expect(out).toBe('a b c')
    })

    it('reverse on single char returns same', async () => {
      const out = await runT('x', [{ op: 'reverse' }])
      expect(out).toBe('x')
    })

    it('reverse on empty string returns empty', async () => {
      const out = await runT('', [{ op: 'reverse' }])
      expect(out).toBe('')
    })

    it('slug on empty string returns empty', async () => {
      const out = await runT('', [{ op: 'slug' }])
      expect(out).toBe('')
    })

    it('slug on already-slugged string', async () => {
      const out = await runT('hello-world', [{ op: 'slug' }])
      expect(out).toBe('hello-world')
    })

    it('strip_html on text with no tags returns original', async () => {
      const out = await runT('just plain text', [{ op: 'strip_html' }])
      expect(out).toBe('just plain text')
    })

    it('count_words on empty string returns 0', async () => {
      const out = await runT('', [{ op: 'count_words' }])
      expect(out).toBe('0')
    })

    it('count_lines handles final newline correctly', async () => {
      const out1 = await runT('a\n', [{ op: 'count_lines' }])
      expect(out1).toBe('2')
      const out2 = await runT('a', [{ op: 'count_lines' }])
      expect(out2).toBe('1')
    })

    it('repeat with count 1', async () => {
      const out = await runT('x', [{ op: 'repeat', count: 1 }])
      expect(out).toBe('x')
    })

    it('repeat with count exactly at cap (100)', async () => {
      const out = await runT('x', [{ op: 'repeat', count: 100 }])
      expect(out.length).toBe(100)
      expect(out).toBe('x'.repeat(100))
    })

    it('pad_start with default space', async () => {
      const out = await runT('hi', [{ op: 'pad_start', length: 5 }])
      expect(out).toBe('   hi')
    })

    it('pad_end with default space', async () => {
      const out = await runT('hi', [{ op: 'pad_end', length: 5 }])
      expect(out).toBe('hi   ')
    })

    it('pad_start with char repeated to fill', async () => {
      const out = await runT('x', [{ op: 'pad_start', length: 5, char: 'ab' }])
      expect(out).toBe('ababx')
    })

    it('pad_end with char repeated to fill', async () => {
      const out = await runT('x', [{ op: 'pad_end', length: 5, char: 'ab' }])
      expect(out).toBe('xabab')
    })

    it('slice with start only goes to end', async () => {
      const out = await runT('hello world', [{ op: 'slice', start: 6 }])
      expect(out).toBe('world')
    })

    it('slice with start > end returns empty', async () => {
      const out = await runT('hello', [{ op: 'slice', start: 4, end: 2 }])
      expect(out).toBe('')
    })

    it('truncate with length 0 returns suffix only', async () => {
      const out = await runT('hello', [{ op: 'truncate', length: 0 }])
      expect(out).toBe('…')
    })

    it('replace handles special regex chars literally', async () => {
      const out = await runT('a.b.c', [{ op: 'replace', from: '.', to: '-' }])
      expect(out).toBe('a-b.c')
    })

    it('replace_all handles special regex chars literally', async () => {
      const out = await runT('a.b.c', [{ op: 'replace_all', from: '.', to: '-' }])
      expect(out).toBe('a-b-c')
    })

    it('indent with size 0 returns original', async () => {
      const out = await runT('a\nb', [{ op: 'indent', size: 0 }])
      expect(out).toBe('a\nb')
    })

    it('indent with size 1', async () => {
      const out = await runT('a\nb', [{ op: 'indent', size: 1 }])
      expect(out).toBe(' a\n b')
    })

    it('dedent with no common indent returns original', async () => {
      const out = await runT('a\n  b', [{ op: 'dedent' }])
      expect(out).toBe('a\n  b')
    })

    it('dedent with all identical indent', async () => {
      const out = await runT('  a\n  b', [{ op: 'dedent' }])
      expect(out).toBe('a\nb')
    })

    it('replace with overlapping pattern matches first only', async () => {
      const out = await runT('aaa', [{ op: 'replace', from: 'aa', to: 'X' }])
      expect(out).toBe('Xa')
    })

    it('replace_all with overlapping pattern matches', async () => {
      const out = await runT('aaa', [{ op: 'replace_all', from: 'aa', to: 'X' }])
      expect(out).toBe('Xa')
    })

    it('regex_replace with multiline flag', async () => {
      const out = await runT('a\nb\nc', [
        { op: 'regex_replace', pattern: '^b$', replacement: 'X', flags: 'm' },
      ])
      expect(out).toBe('a\nX\nc')
    })

    it('split with single char delimiter', async () => {
      const out = await runT('a,b,c', [{ op: 'split', delimiter: ',' }])
      expect(JSON.parse(out)).toEqual(['a', 'b', 'c'])
    })

    it('split with multi-char delimiter', async () => {
      const out = await runT('a::b::c', [{ op: 'split', delimiter: '::' }])
      expect(JSON.parse(out)).toEqual(['a', 'b', 'c'])
    })

    it('count_chars with unicode characters', async () => {
      const out = await runT('A💥B', [{ op: 'count_chars' }])
      expect(out).toBe('4')
    })

    it('count_words with various whitespace', async () => {
      const out = await runT('a  \t\n  b  ', [{ op: 'count_words' }])
      expect(out).toBe('2')
    })
  })

  describe('callTool with huge values', () => {
    it('pad_start with huge length does not crash (callTool)', async () => {
      const r = await callTool(stringTransformTool, {
        text: 'x',
        operations: [{ op: 'pad_start', length: 1e7 }],
      })
      expect(r.kind).toBe('resolved')
    })

    it('pad_end with huge length does not crash (callTool)', async () => {
      const r = await callTool(stringTransformTool, {
        text: 'x',
        operations: [{ op: 'pad_end', length: 1e7 }],
      })
      expect(r.kind).toBe('resolved')
    })

    it('indent with huge size does not crash (callTool)', async () => {
      const r = await callTool(stringTransformTool, {
        text: 'a\nb',
        operations: [{ op: 'indent', size: 1e6 }],
      })
      expect(r.kind).toBe('resolved')
    })

    it('repeat with count 0 clamps to 0', async () => {
      const r = await callTool(stringTransformTool, {
        text: 'x',
        operations: [{ op: 'repeat', count: 0 }],
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') expect(r.out).toBe('')
    })

    it('repeat with negative count clamps to 0', async () => {
      const r = await callTool(stringTransformTool, {
        text: 'x',
        operations: [{ op: 'repeat', count: -5 }],
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') expect(r.out).toBe('')
    })

    it('repeat with huge count clamps to 100', async () => {
      const r = await callTool(stringTransformTool, {
        text: 'x',
        operations: [{ op: 'repeat', count: 1e9 }],
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') {
        expect(r.out.length).toBe(100)
        expect(r.out).toBe('x'.repeat(100))
      }
    })
  })

  describe('non-string flow-through errors', () => {
    it('count_chars then uppercase returns error via callTool', async () => {
      const r = await callTool(stringTransformTool, {
        text: 'hi',
        operations: [{ op: 'count_chars' }, { op: 'uppercase' }],
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') expect(r.out).toMatch(/^Error: Operation 2/)
    })

    it('count_words then trim returns error via callTool', async () => {
      const r = await callTool(stringTransformTool, {
        text: 'hi there',
        operations: [{ op: 'count_words' }, { op: 'trim' }],
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') expect(r.out).toMatch(/^Error: Operation 2/)
    })

    it('split then uppercase returns error via callTool', async () => {
      const r = await callTool(stringTransformTool, {
        text: 'a,b',
        operations: [{ op: 'split', delimiter: ',' }, { op: 'uppercase' }],
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') expect(r.out).toMatch(/^Error: Operation 2.*requires a string/)
    })
  })

  describe('idempotence invariants', () => {
    it('slug is idempotent', async () => {
      const r1 = await runT('Hello World! 123', [{ op: 'slug' }])
      const r2 = await runT(r1, [{ op: 'slug' }])
      expect(r2).toBe(r1)
    })

    it('trim is idempotent', async () => {
      const r1 = await runT('  hello world  ', [{ op: 'trim' }])
      const r2 = await runT(r1, [{ op: 'trim' }])
      expect(r2).toBe(r1)
    })

    it('reverse is involutive: reverse(reverse(s)) = s', async () => {
      const r1 = await runT('hello', [{ op: 'reverse' }])
      const r2 = await runT(r1, [{ op: 'reverse' }])
      expect(r2).toBe('hello')
    })

    it('uppercase then lowercase returns same as origin', async () => {
      const out = await runT('HeLLo', [{ op: 'uppercase' }, { op: 'lowercase' }])
      expect(out).toBe('hello')
    })
  })
})

describe('stringExtractTool comprehensive tests', () => {
  describe('capture groups and flags', () => {
    it('group 1 extracts first capture group from multiple groups', async () => {
      const out = await runX({
        text: 'foo=bar baz=qux',
        pattern: '([a-z]+)=([a-z]+)',
        group: 1,
      })
      expect(JSON.parse(out)).toEqual(['foo', 'baz'])
    })

    it('group 2 extracts second capture group', async () => {
      const out = await runX({
        text: 'foo=bar baz=qux',
        pattern: '([a-z]+)=([a-z]+)',
        group: 2,
      })
      expect(JSON.parse(out)).toEqual(['bar', 'qux'])
    })

    it('flags=i makes pattern case-insensitive', async () => {
      const out = await runX({
        text: 'ABC def',
        pattern: '[a-z]+',
        flags: 'i',
      })
      expect(JSON.parse(out)).toEqual(['ABC', 'def'])
    })

    it('flags=m enables multiline mode', async () => {
      const out = await runX({
        text: 'a\nb\nc',
        pattern: '^.',
        flags: 'm',
      })
      expect(JSON.parse(out)).toEqual(['a', 'b', 'c'])
    })

    it('flags=s enables dotAll mode', async () => {
      const out = await runX({
        text: 'a\nb',
        pattern: 'a.b',
        flags: 's',
      })
      expect(JSON.parse(out)).toEqual(['a\nb'])
    })

    it('flags=u enables unicode mode', async () => {
      const out = await runX({
        text: 'A💥B',
        pattern: '.',
        flags: 'u',
      })
      expect(JSON.parse(out)).toEqual(['A', '💥', 'B'])
    })

    it('multiple flags combined work', async () => {
      const out = await runX({
        text: 'A\nB',
        pattern: '.',
        flags: 'is',
      })
      expect(JSON.parse(out)).toEqual(['A', '\n', 'B'])
    })

    it('group 0 returns full match with multiple groups', async () => {
      const out = await runX({
        text: 'foo=bar',
        pattern: '([a-z]+)=([a-z]+)',
        group: 0,
      })
      expect(JSON.parse(out)).toEqual(['foo=bar'])
    })

    it('group index beyond available groups returns no matches', async () => {
      const out = await runX({
        text: 'abc',
        pattern: 'a',
        group: 5,
      })
      expect(out).toBe('No matches found.')
    })

    it('flags: "" passes validation and behaves identically to omitting flags (both end up with "g")', async () => {
      const outEmpty = await runX({ text: 'a a a', pattern: 'a', flags: '' })
      const outOmitted = await runX({ text: 'a a a', pattern: 'a' })
      expect(outEmpty).toBe(outOmitted)
      expect(JSON.parse(outEmpty)).toEqual(['a', 'a', 'a'])
    })
  })

  describe('edge cases and error handling', () => {
    it('invalid regex pattern returns error string', async () => {
      const out = await runX({
        text: 'test',
        pattern: '[unclosed',
      })
      expect(out).toMatch(/^Error: Invalid regex/)
    })

    it('invalid regex via callTool returns error', async () => {
      const r = await callTool(stringExtractTool, {
        text: 'test',
        pattern: '[invalid',
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') {
        expect(r.out).toMatch(/^Error: Invalid regex/)
      }
    })

    it('empty text returns no matches', async () => {
      const out = await runX({
        text: '',
        pattern: 'a',
      })
      expect(out).toBe('No matches found.')
    })

    it('pattern with no groups returns full matches', async () => {
      const out = await runX({
        text: 'abc123def',
        pattern: '123',
        group: 0,
      })
      expect(JSON.parse(out)).toEqual(['123'])
    })

    it('overlapping matches are all captured', async () => {
      const out = await runX({
        text: 'aaa',
        pattern: 'a',
      })
      expect(JSON.parse(out)).toEqual(['a', 'a', 'a'])
    })

    it('zero-width match at start (^)', async () => {
      const out = await runX({
        text: 'abc',
        pattern: '^',
      })
      expect(JSON.parse(out)).toEqual([''])
    })

    it('zero-width match at end ($))', async () => {
      const out = await runX({
        text: 'abc',
        pattern: '$',
      })
      expect(JSON.parse(out)).toEqual([''])
    })

    it('catastrophic backtracking times out or errors gracefully', async () => {
      const r = await callTool(stringExtractTool, {
        text: 'aaaaaaaaaaaaaaaaab',
        pattern: '(a+)+$',
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') {
        expect(r.out).toMatch(/^(No matches found.|\[.*\].*truncated.*)/)
      }
    }, 3000)
  })

  describe('truncation behavior', () => {
    it('exactly 500 matches triggers truncation suffix', async () => {
      const text = Array(500).fill('x').join(' ')
      const r = await callTool(stringExtractTool, { text, pattern: 'x' })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') {
        expect(r.out).toContain('(truncated at 500)')
        const jsonEnd = r.out.indexOf(' (truncated')
        expect(JSON.parse(r.out.substring(0, jsonEnd))).toHaveLength(500)
      }
    })

    it('550 matches returns 500 with truncation', async () => {
      const text = Array(550).fill('x').join(' ')
      const r = await callTool(stringExtractTool, { text, pattern: 'x' })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') {
        expect(r.out).toContain('(truncated at 500)')
        const jsonEnd = r.out.indexOf(' (truncated')
        expect(JSON.parse(r.out.substring(0, jsonEnd))).toHaveLength(500)
      }
    })
  })

  describe('independent oracle validation', () => {
    it('extract with capture group matches independent JS', async () => {
      const text = 'name=alice&age=30'
      const pattern = '([a-z]+)=[a-z]+'
      const group = 1
      const matches: string[] = []
      const regex = new RegExp(pattern, 'g')
      let m
      while ((m = regex.exec(text)) !== null) {
        matches.push(m[group] ?? '')
      }
      const out = await runX({ text, pattern, group })
      expect(JSON.parse(out)).toEqual(matches)
    })
  })
})

// ── Edge case surfaced by an independent model review (verified against the source) ──────
describe('stringTransformTool — slug with non-decomposing Latin-1 characters', () => {
  // EXPECTED-RED: slug normalizes NFD + strips /[^a-z0-9]+/, but æ/ø/ß do NOT decompose, so they
  // become hyphens — 'føtex' → 'f-tex' (data destroyed). A correct slug transliterates or at least
  // preserves the alphanumeric content.
  it('does not mangle "føtex" into "f-tex"', async () => {
    const r = await callTool(stringTransformTool, { text: 'føtex', operations: [{ op: 'slug' }] })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(r.out).not.toBe('f-tex')
  })

  it('does not mangle "mælk" by dropping the æ', async () => {
    const r = await callTool(stringTransformTool, { text: 'mælk', operations: [{ op: 'slug' }] })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(r.out).not.toBe('m-lk')
  })
})
