import { describe, expect, it } from 'vitest'
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
