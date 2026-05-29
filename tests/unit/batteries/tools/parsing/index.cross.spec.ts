import { describe, expect, it } from 'vitest'
import { makeToolCtxStub } from '../../../../_fixtures/tool_ctx_stub'
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
})
