import { describe, expect, it } from 'vitest'
import { makeToolCtxStub } from '../../../../_fixtures/tool_ctx_stub'
import { E_INVALID_TOOL_ARGS } from '../../../../../src/lib/exceptions/runtime'
import {
  encodeTextTool,
  textEscapeTool,
  unicodeNormalizeTool,
} from '../../../../../src/batteries/tools/encoding'

const runEncode = async (args: Record<string, unknown>): Promise<string> => {
  return (await encodeTextTool.executor(makeToolCtxStub())(args)) as string
}

const runEscape = async (args: Record<string, unknown>): Promise<string> => {
  return (await textEscapeTool.executor(makeToolCtxStub())(args)) as string
}

const runNormalize = async (args: Record<string, unknown>): Promise<string> => {
  return (await unicodeNormalizeTool.executor(makeToolCtxStub())(args)) as string
}

describe('encodeTextTool', () => {
  describe('base64', () => {
    it('encodes "hello" to "aGVsbG8="', async () => {
      const out = await runEncode({ text: 'hello', scheme: 'base64', direction: 'encode' })
      expect(out).toBe('aGVsbG8=')
    })

    it('decodes "aGVsbG8=" to "hello"', async () => {
      const out = await runEncode({ text: 'aGVsbG8=', scheme: 'base64', direction: 'decode' })
      expect(out).toBe('hello')
    })

    it('round-trips UTF-8 text (encoding then decoding returns the original)', async () => {
      const encoded = await runEncode({
        text: 'héllo, 世界',
        scheme: 'base64',
        direction: 'encode',
      })
      const decoded = await runEncode({ text: encoded, scheme: 'base64', direction: 'decode' })
      expect(decoded).toBe('héllo, 世界')
    })

    it('defaults direction to encode when omitted', async () => {
      const out = await runEncode({ text: 'hello', scheme: 'base64' })
      expect(out).toBe('aGVsbG8=')
    })
  })

  describe('url (percent-encoding)', () => {
    it('encodes spaces and special chars', async () => {
      const out = await runEncode({
        text: 'hello world & friends',
        scheme: 'url',
        direction: 'encode',
      })
      expect(out).toBe('hello%20world%20%26%20friends')
    })

    it('decodes percent-encoded text', async () => {
      const out = await runEncode({
        text: 'hello%20world',
        scheme: 'url',
        direction: 'decode',
      })
      expect(out).toBe('hello world')
    })

    it('returns an error string for malformed percent-encoded input', async () => {
      const out = await runEncode({ text: '%ZZ', scheme: 'url', direction: 'decode' })
      expect(out).toMatch(/^Error/)
    })
  })

  describe('html_entities', () => {
    it('encodes <, >, &, ", \'', async () => {
      const out = await runEncode({
        text: '<a href="x">tom & jerry\'s</a>',
        scheme: 'html_entities',
        direction: 'encode',
      })
      expect(out).toBe('&lt;a href=&quot;x&quot;&gt;tom &amp; jerry&#39;s&lt;/a&gt;')
    })

    it('decodes named entities back to their characters', async () => {
      const out = await runEncode({
        text: '&lt;a&gt;tom &amp; jerry&#39;s&lt;/a&gt;',
        scheme: 'html_entities',
        direction: 'decode',
      })
      expect(out).toBe("<a>tom & jerry's</a>")
    })

    it('decodes numeric entities (decimal and hex)', async () => {
      const out = await runEncode({
        text: '&#65;&#x42;',
        scheme: 'html_entities',
        direction: 'decode',
      })
      expect(out).toBe('AB')
    })
  })

  describe('schema rejection', () => {
    it('rejects unknown scheme via schema', async () => {
      await expect(runEncode({ text: 'x', scheme: 'rot13' })).rejects.toBeInstanceOf(
        E_INVALID_TOOL_ARGS
      )
    })

    it('rejects unknown direction via schema', async () => {
      await expect(
        runEncode({ text: 'x', scheme: 'base64', direction: 'invert' })
      ).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
    })

    it('rejects missing text', async () => {
      await expect(runEncode({ scheme: 'base64' })).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
    })
  })
})

describe('textEscapeTool', () => {
  describe('json_string', () => {
    it('escapes a string with quotes and newlines', async () => {
      const out = await runEscape({
        text: 'line1\nline with "quote"',
        target: 'json_string',
        direction: 'escape',
      })
      expect(out).toBe('line1\\nline with \\"quote\\"')
    })

    it('unescapes a json-escaped string', async () => {
      const out = await runEscape({
        text: 'line1\\nquote: \\"x\\"',
        target: 'json_string',
        direction: 'unescape',
      })
      expect(out).toBe('line1\nquote: "x"')
    })
  })

  describe('regex', () => {
    it('escapes regex metacharacters', async () => {
      const out = await runEscape({
        text: 'a.b*c(d)e',
        target: 'regex',
        direction: 'escape',
      })
      expect(out).toBe('a\\.b\\*c\\(d\\)e')
    })

    it('unescapes regex metacharacters', async () => {
      const out = await runEscape({
        text: 'a\\.b\\*c',
        target: 'regex',
        direction: 'unescape',
      })
      expect(out).toBe('a.b*c')
    })
  })

  describe('csv_field', () => {
    it('wraps fields containing commas in quotes', async () => {
      const out = await runEscape({ text: 'a,b', target: 'csv_field', direction: 'escape' })
      expect(out).toBe('"a,b"')
    })

    it('doubles internal quotes when wrapping', async () => {
      const out = await runEscape({
        text: 'she said "hi"',
        target: 'csv_field',
        direction: 'escape',
      })
      expect(out).toBe('"she said ""hi"""')
    })

    it('leaves simple fields untouched', async () => {
      const out = await runEscape({ text: 'hello', target: 'csv_field', direction: 'escape' })
      expect(out).toBe('hello')
    })

    it('unescapes a quoted CSV field', async () => {
      const out = await runEscape({
        text: '"a,b"',
        target: 'csv_field',
        direction: 'unescape',
      })
      expect(out).toBe('a,b')
    })
  })

  describe('sql_like', () => {
    it('escapes percent and underscore', async () => {
      const out = await runEscape({
        text: '50% off_today',
        target: 'sql_like',
        direction: 'escape',
      })
      expect(out).toBe('50\\% off\\_today')
    })
  })

  describe('markdown', () => {
    it('escapes a sampling of markdown chars', async () => {
      const out = await runEscape({
        text: '*bold* _italic_ [link](url)',
        target: 'markdown',
        direction: 'escape',
      })
      expect(out).toMatch(/\\\*bold\\\*/)
      expect(out).toMatch(/\\_italic\\_/)
    })
  })
})

describe('unicodeNormalizeTool', () => {
  describe('strip_accents', () => {
    it('removes combining diacritics from accented Latin characters', async () => {
      const out = await runNormalize({ text: 'café résumé', operation: 'strip_accents' })
      expect(out).toBe('cafe resume')
    })

    it('preserves non-accented characters unchanged', async () => {
      const out = await runNormalize({ text: 'hello', operation: 'strip_accents' })
      expect(out).toBe('hello')
    })
  })

  describe('code_points', () => {
    it('produces one U+HHHH per character', async () => {
      const out = await runNormalize({ text: 'AB', operation: 'code_points' })
      expect(out).toMatch(/^U\+0041 \(A\)\nU\+0042 \(B\)$/)
    })

    it('handles non-BMP code points correctly', async () => {
      const out = await runNormalize({ text: '🎉', operation: 'code_points' })
      // 🎉 is U+1F389
      expect(out).toContain('U+1F389')
    })
  })

  describe('normalization forms', () => {
    for (const op of ['nfc', 'nfd', 'nfkc', 'nfkd'] as const) {
      it(`runs ${op} normalization without throwing`, async () => {
        const out = await runNormalize({ text: 'café', operation: op })
        expect(out).not.toMatch(/^Error/)
      })
    }
  })

  describe('error path', () => {
    it('rejects unknown operations via schema', async () => {
      await expect(runNormalize({ text: 'x', operation: 'shake' })).rejects.toBeInstanceOf(
        E_INVALID_TOOL_ARGS
      )
    })
  })
})
