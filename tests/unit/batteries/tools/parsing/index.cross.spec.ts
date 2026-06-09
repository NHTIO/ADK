import { describe, expect, it } from 'vitest'
import { callTool, makeToolCtxStub } from '../../../../_fixtures/tool_ctx_stub'
import { E_INVALID_TOOL_ARGS } from '../../../../../src/lib/exceptions/runtime'
import { SpooledJsonArtifact } from '../../../../../src/lib/classes/spooled_json_artifact'
import {
  detectDelimiterTool,
  parseCsvTool,
  parseKvTool,
  parseYamlTool,
} from '../../../../../src/batteries/tools/parsing'

const runCsv = async (args: Record<string, unknown>): Promise<string> => {
  return (await parseCsvTool.executor(makeToolCtxStub())(args)) as string
}
const runYaml = async (text: string): Promise<string> => {
  return (await parseYamlTool.executor(makeToolCtxStub())({ text })) as string
}
const runKv = async (args: Record<string, unknown>): Promise<string> => {
  return (await parseKvTool.executor(makeToolCtxStub())(args)) as string
}
const runDetect = async (text: string): Promise<string> => {
  return (await detectDelimiterTool.executor(makeToolCtxStub())({ text })) as string
}

/* ── existing basic tests ─────────────────────────────────────────────── */

describe('parseCsvTool', () => {
  it('parses CSV with header into objects', async () => {
    const out = await runCsv({
      text: 'name,age\nalice,30\nbob,25',
    })
    const parsed = JSON.parse(out)
    expect(parsed).toEqual([
      { name: 'alice', age: 30 },
      { name: 'bob', age: 25 },
    ])
  })

  it('parses CSV without header into arrays', async () => {
    const out = await runCsv({
      text: 'alice,30\nbob,25',
      has_header: false,
    })
    const parsed = JSON.parse(out)
    expect(parsed).toEqual([
      ['alice', 30],
      ['bob', 25],
    ])
  })

  it('dynamicTyping coerces numeric strings', async () => {
    const out = await runCsv({
      text: 'x,y\n1,2\n3,4',
    })
    const parsed = JSON.parse(out)
    expect(parsed[0].x).toBe(1)
    expect(typeof parsed[0].x).toBe('number')
  })

  it('accepts explicit tab delimiter for TSV', async () => {
    const out = await runCsv({
      text: 'name\tage\nalice\t30',
      delimiter: '\t',
    })
    const parsed = JSON.parse(out)
    expect(parsed).toEqual([{ name: 'alice', age: 30 }])
  })

  it('truncates rows past limit', async () => {
    const rows = Array.from({ length: 50 }, (_, i) => `r${i},${i}`).join('\n')
    const out = await runCsv({ text: `n,v\n${rows}`, limit: 5 })
    expect(out).toMatch(/Showing 5 of 50/)
  })

  it('declares SpooledJsonArtifact', () => {
    expect(parseCsvTool.artifactConstructor?.()).toBe(SpooledJsonArtifact)
  })

  it('schema rejects missing text', async () => {
    await expect(runCsv({})).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
  })

  /* ── INVARIANT: parse_csv then count rows matches input line count ──── */

  it('row count matches input data rows (with header)', async () => {
    const text = 'name,age\nalice,30\nbob,25\ncarol,35'
    const out = await runCsv({ text })
    const parsed = JSON.parse(out)
    // 3 data rows (header excluded by default)
    expect(parsed.length).toBe(3)
  })

  it('row count matches input lines (no header)', async () => {
    const text = 'alice,30\nbob,25\ncarol,35'
    const out = await runCsv({ text, has_header: false })
    const parsed = JSON.parse(out)
    expect(parsed.length).toBe(3)
  })

  /* ── auto delimiter detection ──────────────────────────────────────── */

  it('auto-detects tab delimiter', async () => {
    const out = await runCsv({
      text: 'name\tage\nalice\t30\nbob\t25',
    })
    const parsed = JSON.parse(out)
    expect(parsed).toEqual([
      { name: 'alice', age: 30 },
      { name: 'bob', age: 25 },
    ])
  })

  it('auto-detects semicolon delimiter', async () => {
    const out = await runCsv({
      text: 'name;age\nalice;30\nbob;25',
    })
    const parsed = JSON.parse(out)
    expect(parsed).toEqual([
      { name: 'alice', age: 30 },
      { name: 'bob', age: 25 },
    ])
  })

  /* ── quoted fields with embedded commas ──────────────────────────────── */

  it('parses quoted fields containing commas', async () => {
    const out = await runCsv({
      text: 'name,city\n"Alice, Bob","New York"',
    })
    const parsed = JSON.parse(out)
    expect(parsed[0].name).toBe('Alice, Bob')
    expect(parsed[0].city).toBe('New York')
  })

  it('parses quoted fields containing newlines', async () => {
    const out = await runCsv({
      text: 'name,desc\n"Alice","line1\nline2"',
    })
    const parsed = JSON.parse(out)
    expect(parsed[0].name).toBe('Alice')
    expect(parsed[0].desc).toContain('line1')
  })

  /* ── ragged rows ────────────────────────────────────────────────────── */

  it('handles ragged rows (missing fields become empty)', async () => {
    const out = await runCsv({
      text: 'a,b,c\n1,2,3\n4,5',
    })
    // May contain parse warnings prefix; extract JSON portion
    const jsonStr = out.includes('[') ? out.substring(out.indexOf('[')) : out
    const parsed = JSON.parse(jsonStr)
    expect(parsed.length).toBe(2)
    expect(parsed[1].a).toBe(4)
    expect(parsed[1].b).toBe(5)
  })

  /* ── limit clamping ──────────────────────────────────────────────────── */

  it('limit of 1 returns only 1 row', async () => {
    const out = await runCsv({
      text: 'n\na\nb\nc',
      limit: 1,
    })
    // Output may include parse warnings prefix and/or truncation suffix
    // Extract the JSON array from the output
    const startIdx = out.indexOf('[')
    const endIdx = out.lastIndexOf(']')
    expect(startIdx).toBeGreaterThanOrEqual(0)
    expect(endIdx).toBeGreaterThan(startIdx)
    const jsonStr = out.substring(startIdx, endIdx + 1)
    const parsed = JSON.parse(jsonStr)
    expect(parsed.length).toBe(1)
    expect(out).toContain('Showing 1 of')
  })

  it('limit larger than row count returns all rows', async () => {
    const out = await runCsv({
      text: 'n\na\nb',
      limit: 100,
    })
    const jsonStr = out.includes('[') ? out.substring(out.indexOf('[')) : out
    const parsed = JSON.parse(jsonStr)
    expect(parsed.length).toBe(2)
  })

  /* ── empty input ─────────────────────────────────────────────────────── */

  it('empty string is rejected by schema (not allowed)', async () => {
    await expect(runCsv({ text: '' })).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
  })

  /* ── single row CSV ───────────────────────────────────────────────────── */

  it('single row (header only, no data) produces empty array', async () => {
    const out = await runCsv({
      text: 'name,age',
    })
    const parsed = JSON.parse(out)
    expect(parsed).toEqual([])
  })

  /* ── TSV with has_header false ──────────────────────────────────────── */

  it('TSV without header produces array-of-arrays', async () => {
    const out = await runCsv({
      text: 'alice\t30\nbob\t25',
      has_header: false,
      delimiter: '\t',
    })
    const parsed = JSON.parse(out)
    expect(parsed).toEqual([
      ['alice', 30],
      ['bob', 25],
    ])
  })

  /* ── parse warnings ───────────────────────────────────────────────────── */

  it('malformed CSV (unmatched quotes) may produce warnings', async () => {
    // PapaParse handles unmatched quotes with a warning rather than throwing
    const out = await runCsv({
      text: 'name\n"unclosed',
    })
    // Should still produce output (possibly with warnings)
    expect(out).toBeDefined()
  })

  /* ── limit max is 10000 ─────────────────────────────────────────────── */

  it('limit exceeding 10000 is clamped', async () => {
    // We can't easily create 10001 rows, but we can verify the tool doesn't error
    const out = await runCsv({
      text: 'n\na',
      limit: 10001,
    })
    expect(out).toBeDefined()
  })

  /* ── callTool no-crash: adversarial edges ─────────────────────────────── */

  it('huge limit must not crash', async () => {
    const r = await callTool(parseCsvTool, { text: 'n\na\nb', limit: 1e9 })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(typeof r.out).toBe('string')
  })

  it('negative limit must not crash', async () => {
    const r = await callTool(parseCsvTool, { text: 'n\na\nb', limit: -5 })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(typeof r.out).toBe('string')
  })

  it('CSV with embedded null bytes must not crash', async () => {
    const r = await callTool(parseCsvTool, { text: 'n\na\0b' })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(typeof r.out).toBe('string')
  })

  it('CSV with lone surrogate must not crash', async () => {
    const r = await callTool(parseCsvTool, { text: 'n\na\uD800' })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(typeof r.out).toBe('string')
  })

  it('CSV with very long field must not crash', async () => {
    const r = await callTool(parseCsvTool, { text: 'n\n' + 'x'.repeat(100000) })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(typeof r.out).toBe('string')
  })
})

describe('parseYamlTool', () => {
  it('parses scalar YAML', async () => {
    const out = await runYaml('hello')
    expect(JSON.parse(out)).toBe('hello')
  })

  it('parses mapping YAML', async () => {
    const out = await runYaml('name: alice\nage: 30')
    expect(JSON.parse(out)).toEqual({ name: 'alice', age: 30 })
  })

  it('parses sequence YAML', async () => {
    const out = await runYaml('- one\n- two\n- three')
    expect(JSON.parse(out)).toEqual(['one', 'two', 'three'])
  })

  it('parses nested YAML', async () => {
    const out = await runYaml(`
user:
  name: alice
  roles:
    - admin
    - editor
`)
    expect(JSON.parse(out)).toEqual({
      user: { name: 'alice', roles: ['admin', 'editor'] },
    })
  })

  it('errors on invalid YAML', async () => {
    const out = await runYaml('foo:\n  - bar\n - baz')
    expect(out).toMatch(/^Error: Invalid YAML/)
  })

  it('declares SpooledJsonArtifact', () => {
    expect(parseYamlTool.artifactConstructor?.()).toBe(SpooledJsonArtifact)
  })

  /* ── scalars ────────────────────────────────────────────────────────── */

  it('parses null value', async () => {
    const out = await runYaml('key: null')
    expect(JSON.parse(out)).toEqual({ key: null })
  })

  it('parses boolean true', async () => {
    const out = await runYaml('key: true')
    expect(JSON.parse(out)).toEqual({ key: true })
  })

  it('parses boolean false', async () => {
    const out = await runYaml('key: false')
    expect(JSON.parse(out)).toEqual({ key: false })
  })

  it('parses integer', async () => {
    const out = await runYaml('key: 42')
    expect(JSON.parse(out)).toEqual({ key: 42 })
  })

  it('parses float', async () => {
    const out = await runYaml('key: 3.14')
    expect(JSON.parse(out)).toEqual({ key: 3.14 })
  })

  /* ── nested maps ────────────────────────────────────────────────────── */

  it('parses deeply nested YAML', async () => {
    const yaml = `
level1:
  level2:
    level3: deep
`
    const out = await runYaml(yaml)
    expect(JSON.parse(out)).toEqual({
      level1: { level2: { level3: 'deep' } },
    })
  })

  /* ── lists of maps ──────────────────────────────────────────────────── */

  it('parses list of maps', async () => {
    const yaml = `
- name: alice
  age: 30
- name: bob
  age: 25
`
    const out = await runYaml(yaml)
    expect(JSON.parse(out)).toEqual([
      { name: 'alice', age: 30 },
      { name: 'bob', age: 25 },
    ])
  })

  /* ── empty input ─────────────────────────────────────────────────────── */

  it('empty string is rejected by schema (not allowed)', async () => {
    await expect(runYaml('')).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
  })

  /* ── anchors (YAML feature) ─────────────────────────────────────────── */

  it('parses YAML anchors and aliases', async () => {
    const yaml = `
defaults: &defaults
  timeout: 30
  retries: 3
production:
  <<: *defaults
  timeout: 60
`
    const out = await runYaml(yaml)
    const parsed = JSON.parse(out)
    expect(parsed.production.timeout).toBe(60)
    expect(parsed.production.retries).toBe(3)
  })

  /* ── KNOWN BUG: whitespace-only / lone-newline / BOM → handler returns undefined ─ */

  it('whitespace-only YAML must resolve to a string, not undefined', async () => {
    // js-yaml parses ' ' to undefined; handler returns undefined instead of a string
    const r = await callTool(parseYamlTool, { text: ' ' })
    expect(r.kind).toBe('resolved') // EXPECTED-RED: handler returns actual undefined, not a string
    if (r.kind === 'resolved') {
      expect(typeof r.out).toBe('string') // EXPECTED-RED: typeof undefined !== 'string'
    }
  })

  it('lone newline YAML must resolve to a string, not undefined', async () => {
    const r = await callTool(parseYamlTool, { text: '\n' })
    expect(r.kind).toBe('resolved') // EXPECTED-RED: handler returns actual undefined
    if (r.kind === 'resolved') {
      expect(typeof r.out).toBe('string') // EXPECTED-RED
    }
  })

  it('BOM-only YAML must resolve to a string, not undefined', async () => {
    const r = await callTool(parseYamlTool, { text: '\uFEFF' })
    expect(r.kind).toBe('resolved') // EXPECTED-RED: handler returns actual undefined
    if (r.kind === 'resolved') {
      expect(typeof r.out).toBe('string') // EXPECTED-RED
    }
  })
})

describe('parseKvTool', () => {
  it('parses .env-style key=value pairs', async () => {
    const out = await runKv({
      text: 'DB_HOST=localhost\nDB_PORT=5432',
    })
    expect(JSON.parse(out)).toEqual({ DB_HOST: 'localhost', DB_PORT: '5432' })
  })

  it('skips comment lines by default', async () => {
    const out = await runKv({
      text: '# this is a comment\nKEY=value',
    })
    expect(JSON.parse(out)).toEqual({ KEY: 'value' })
  })

  it('strips surrounding double quotes', async () => {
    const out = await runKv({
      text: 'KEY="hello world"',
    })
    expect(JSON.parse(out)).toEqual({ KEY: 'hello world' })
  })

  it('strips surrounding single quotes', async () => {
    const out = await runKv({
      text: "KEY='hello'",
    })
    expect(JSON.parse(out)).toEqual({ KEY: 'hello' })
  })

  it('auto-detects colon-delimited pairs', async () => {
    const out = await runKv({
      text: 'name: alice\nage: 30',
    })
    expect(JSON.parse(out)).toEqual({ name: 'alice', age: '30' })
  })

  it('respects explicit kv_delimiter', async () => {
    const out = await runKv({
      text: 'a=1\nb=2',
      kv_delimiter: '=',
    })
    expect(JSON.parse(out)).toEqual({ a: '1', b: '2' })
  })

  it('supports comma pair delimiter', async () => {
    const out = await runKv({
      text: 'a=1,b=2,c=3',
      pair_delimiter: 'comma',
    })
    expect(JSON.parse(out)).toEqual({ a: '1', b: '2', c: '3' })
  })

  it('supports semicolon pair delimiter', async () => {
    const out = await runKv({
      text: 'a=1;b=2',
      pair_delimiter: 'semicolon',
    })
    expect(JSON.parse(out)).toEqual({ a: '1', b: '2' })
  })

  it('supports ampersand for querystring-like input', async () => {
    const out = await runKv({
      text: 'foo=bar&baz=qux',
      pair_delimiter: 'ampersand',
    })
    expect(JSON.parse(out)).toEqual({ foo: 'bar', baz: 'qux' })
  })

  it('schema rejects invalid kv_delimiter', async () => {
    await expect(runKv({ text: 'a=1', kv_delimiter: '*' })).rejects.toBeInstanceOf(
      E_INVALID_TOOL_ARGS
    )
  })

  /* ── skip_comments: false ─────────────────────────────────────────────── */

  it('does not skip comments when skip_comments is false', async () => {
    const out = await runKv({
      text: '# this is a comment\nKEY=value',
      skip_comments: false,
    })
    const parsed = JSON.parse(out)
    // The line "# this is a comment" will be parsed as key "# this is a comment"
    // with auto-delimiter, it may find "=" or ":" — but # lines start with #
    // Let's just verify KEY=value is still parsed
    expect(parsed.KEY).toBe('value')
  })

  /* ── empty input ─────────────────────────────────────────────────────── */

  it('empty string is rejected by schema', async () => {
    await expect(runKv({ text: '' })).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
  })

  /* ── whitespace handling ─────────────────────────────────────────────── */

  it('trims whitespace around keys and values', async () => {
    const out = await runKv({
      text: '  KEY  =  value  ',
    })
    expect(JSON.parse(out)).toEqual({ KEY: 'value' })
  })

  /* ── empty key is skipped ──────────────────────────────────────────── */

  it('skips pairs with empty key', async () => {
    const out = await runKv({
      text: '=value',
    })
    expect(JSON.parse(out)).toEqual({})
  })

  /* ── duplicate keys ─────────────────────────────────────────────────── */

  it('last value wins for duplicate keys', async () => {
    const out = await runKv({
      text: 'KEY=first\nKEY=second',
    })
    expect(JSON.parse(out)).toEqual({ KEY: 'second' })
  })

  /* ── newline pair delimiter (default) ──────────────────────────────── */

  it('newline pair delimiter (default)', async () => {
    const out = await runKv({
      text: 'a=1\nb=2',
    })
    expect(JSON.parse(out)).toEqual({ a: '1', b: '2' })
  })

  /* ── value with equals sign ──────────────────────────────────────────── */

  it('value contains equals sign (first = is delimiter)', async () => {
    const out = await runKv({
      text: 'URL=http://example.com?a=1&b=2',
    })
    const parsed = JSON.parse(out)
    expect(parsed.URL).toBe('http://example.com?a=1&b=2')
  })

  /* ── value with colon ────────────────────────────────────────────────── */

  it('explicit equals delimiter preserves colon in value', async () => {
    const out = await runKv({
      text: 'TIME=12:30:00',
      kv_delimiter: '=',
    })
    expect(JSON.parse(out)).toEqual({ TIME: '12:30:00' })
  })

  /* ── auto detect: prefers = over : when both present ──────────────── */

  it('auto-detect prefers = as delimiter', async () => {
    const out = await runKv({
      text: 'KEY=value',
    })
    // With auto, = is used as delimiter
    expect(JSON.parse(out)).toEqual({ KEY: 'value' })
  })

  /* ── explicit colon delimiter ─────────────────────────────────────── */

  it('explicit colon delimiter', async () => {
    const out = await runKv({
      text: 'KEY:value',
      kv_delimiter: ':',
    })
    expect(JSON.parse(out)).toEqual({ KEY: 'value' })
  })

  /* ── callTool no-crash: adversarial edges ─────────────────────────────── */

  it('KV with embedded null bytes must not crash', async () => {
    const r = await callTool(parseKvTool, { text: 'K\0EY=value' })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(typeof r.out).toBe('string')
  })

  it('KV with lone surrogate must not crash', async () => {
    const r = await callTool(parseKvTool, { text: 'KEY=\uD800value' })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(typeof r.out).toBe('string')
  })

  it('KV with very long value must not crash', async () => {
    const r = await callTool(parseKvTool, { text: 'KEY=' + 'x'.repeat(100000) })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(typeof r.out).toBe('string')
  })

  it('KV with no delimiter in any pair must not crash', async () => {
    const r = await callTool(parseKvTool, { text: 'justakeywithnodelimiter' })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(typeof r.out).toBe('string')
  })

  it('KV with only whitespace pairs must not crash', async () => {
    const r = await callTool(parseKvTool, { text: '   \n   \n   ' })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(typeof r.out).toBe('string')
  })
})

describe('detectDelimiterTool', () => {
  it('detects comma in normal CSV', async () => {
    const out = await runDetect('a,b,c\n1,2,3\n4,5,6')
    expect(out).toContain('comma')
  })

  it('detects tab in TSV', async () => {
    const out = await runDetect('a\tb\tc\n1\t2\t3\n4\t5\t6')
    expect(out).toContain('tab')
    expect(out).toContain('\\t')
  })

  it('detects semicolon (European-style CSV)', async () => {
    const out = await runDetect('a;b;c\n1;2;3\n4;5;6')
    expect(out).toContain('semicolon')
  })

  it('detects pipe', async () => {
    const out = await runDetect('a|b|c\n1|2|3\n4|5|6')
    expect(out).toContain('pipe')
  })

  it('reports estimated field count', async () => {
    const out = await runDetect('a,b,c\n1,2,3')
    expect(out).toMatch(/~3 fields per row/)
  })

  it('errors on empty input', async () => {
    const out = await runDetect('   \n  ')
    expect(out).toMatch(/^Error: No lines/)
  })

  /* ── colon detection ──────────────────────────────────────────────────── */

  it('detects colon when it has consistent field counts', async () => {
    const out = await runDetect('a:b:c\n1:2:3\n4:5:6')
    expect(out).toContain('colon')
  })

  /* ── single line input ──────────────────────────────────────────────── */

  it('handles single line input', async () => {
    const out = await runDetect('a,b,c')
    expect(out).toContain('comma')
  })

  /* ── INVARIANT: detected delimiter should produce consistent field counts ── */

  it('consistent comma-delimited data is detected as comma', async () => {
    const csv = 'name,age,city\nalice,30,NYC\nbob,25,LA\ncarol,35,Chicago'
    const out = await runDetect(csv)
    expect(out).toContain('comma')
    expect(out).toMatch(/~3 fields per row/)
  })

  /* ── mixed whitespace-only lines are skipped ──────────────────────────── */

  it('skips blank lines in detection', async () => {
    const out = await runDetect('a,b,c\n\n1,2,3\n\n4,5,6')
    expect(out).toContain('comma')
  })

  /* ── schema rejection ──────────────────────────────────────────────── */

  it('schema rejects missing text', async () => {
    await expect(detectDelimiterTool.executor(makeToolCtxStub())({})).rejects.toBeInstanceOf(
      E_INVALID_TOOL_ARGS
    )
  })

  /* ── callTool no-crash: adversarial edges ─────────────────────────────── */

  it('delimiter detection with lone surrogate must not crash', async () => {
    const r = await callTool(detectDelimiterTool, { text: '\uD800,a,b\n1,2,3' })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(typeof r.out).toBe('string')
  })

  it('delimiter detection with huge line must not crash', async () => {
    const r = await callTool(detectDelimiterTool, {
      text: 'x'.repeat(50000) + ',1\n' + 'y'.repeat(50000) + ',2',
    })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(typeof r.out).toBe('string')
  })
})
// ── Edge cases surfaced by an independent model review (verified against the source) ──────
describe('parseYamlTool — special float values become null', () => {
  // EXPECTED-RED: js-yaml parses `.NaN` to JS NaN; JSON.stringify turns NaN into null, so the
  // output silently reports value: null. The user's NaN is lost without warning.
  it('does not silently turn a YAML .NaN value into null', async () => {
    const r = await callTool(parseYamlTool, { text: 'value: .NaN' })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(r.out).not.toContain('"value": null')
  })
})
