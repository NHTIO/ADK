import { describe, expect, it } from 'vitest'
import { makeToolCtxStub } from '../../../../_fixtures/tool_ctx_stub'
import { E_INVALID_TOOL_ARGS } from '../../../../../src/lib/exceptions/runtime'
import {
  formatTableTool,
  jsonFormatTool,
  validateFormatTool,
} from '../../../../../src/batteries/tools/structured_data'

const runTable = async (args: Record<string, unknown>): Promise<string> => {
  return (await formatTableTool.executor(makeToolCtxStub())(args)) as string
}
const runFmt = async (args: Record<string, unknown>): Promise<string> => {
  return (await jsonFormatTool.executor(makeToolCtxStub())(args)) as string
}
const runVal = async (args: Record<string, unknown>): Promise<string> => {
  return (await validateFormatTool.executor(makeToolCtxStub())(args)) as string
}

describe('formatTableTool', () => {
  const rows = [
    { name: 'alice', age: 30 },
    { name: 'bob', age: 25 },
  ]

  describe('markdown', () => {
    it('produces a header row, separator, and data rows', async () => {
      const out = await runTable({ data: JSON.stringify(rows), format: 'markdown' })
      const lines = out.split('\n')
      expect(lines[0]).toBe('| name | age |')
      expect(lines[1]).toBe('| --- | --- |')
      expect(lines[2]).toBe('| alice | 30 |')
      expect(lines[3]).toBe('| bob | 25 |')
    })
    it('escapes pipe characters in cell values', async () => {
      const out = await runTable({
        data: JSON.stringify([{ x: 'a|b' }]),
        format: 'markdown',
      })
      expect(out).toContain('a\\|b')
    })
    it('respects an explicit columns subset', async () => {
      const out = await runTable({
        data: JSON.stringify(rows),
        format: 'markdown',
        columns: ['name'],
      })
      expect(out).toContain('| name |')
      expect(out).not.toContain('age')
    })
  })

  describe('csv', () => {
    it('produces a CSV header and rows', async () => {
      const out = await runTable({ data: JSON.stringify(rows), format: 'csv' })
      expect(out.split('\n')).toEqual(['name,age', 'alice,30', 'bob,25'])
    })
    it('quotes fields containing commas', async () => {
      const out = await runTable({
        data: JSON.stringify([{ name: 'last, first' }]),
        format: 'csv',
      })
      expect(out).toContain('"last, first"')
    })
    it('doubles internal quotes', async () => {
      const out = await runTable({
        data: JSON.stringify([{ msg: 'say "hi"' }]),
        format: 'csv',
      })
      expect(out).toContain('"say ""hi"""')
    })
  })

  describe('tsv', () => {
    it('joins fields with tabs', async () => {
      const out = await runTable({ data: JSON.stringify(rows), format: 'tsv' })
      expect(out.split('\n')[0]).toBe('name\tage')
    })
    it('replaces tabs and newlines in cell values', async () => {
      const out = await runTable({
        data: JSON.stringify([{ x: 'a\tb\nc' }]),
        format: 'tsv',
      })
      expect(out).not.toContain('a\tb')
      expect(out).not.toContain('b\nc')
    })
  })

  describe('error paths', () => {
    it('errors on invalid JSON', async () => {
      const out = await runTable({ data: 'not json', format: 'csv' })
      expect(out).toMatch(/^Error/)
    })
    it('errors when input is not an array', async () => {
      const out = await runTable({ data: '{}', format: 'csv' })
      expect(out).toMatch(/^Error/)
    })
    it('returns documented message for empty arrays', async () => {
      const out = await runTable({ data: '[]', format: 'csv' })
      expect(out).toMatch(/Empty array/)
    })
  })
})

describe('jsonFormatTool', () => {
  it('pretty-prints with default indent of 2', async () => {
    const out = await runFmt({ data: '{"a":1,"b":2}' })
    expect(out).toBe('{\n  "a": 1,\n  "b": 2\n}')
  })
  it('minifies when indent is 0', async () => {
    const out = await runFmt({ data: '{ "a": 1, "b": 2 }', indent: 0 })
    expect(out).toBe('{"a":1,"b":2}')
  })
  it('clamps indent to a max of 8', async () => {
    const out = await runFmt({ data: '{"a":1}', indent: 100 })
    const lines = out.split('\n')
    // Second line is the property — leading spaces should be 8
    expect(lines[1].startsWith('        "a":')).toBe(true)
  })
  it('errors on invalid JSON', async () => {
    const out = await runFmt({ data: 'not json' })
    expect(out).toMatch(/^Error/)
  })
})

describe('validateFormatTool', () => {
  const validCases: Array<[string, string]> = [
    ['email', 'alice@example.com'],
    ['uuid', '550e8400-e29b-41d4-a716-446655440000'],
    ['ipv4', '192.168.1.1'],
    ['iso_date', '2024-01-15'],
    ['iso_datetime', '2024-01-15T12:30:00Z'],
    ['hex_color', '#FF8800'],
    ['phone_e164', '+14155552671'],
    ['semver', '1.2.3'],
    ['integer', '-42'],
    ['decimal', '3.14'],
    ['alphanumeric', 'abc123'],
    ['slug', 'hello-world'],
    ['hex', '0xff'],
    ['base64', 'aGVsbG8='],
  ]

  for (const [format, value] of validCases) {
    it(`accepts ${format}: "${value}"`, async () => {
      const out = await runVal({ value, format })
      expect(out).toMatch(/^Valid/)
    })
  }

  it('rejects clearly invalid input', async () => {
    expect(await runVal({ value: 'not-an-email', format: 'email' })).toMatch(/^Invalid/)
    expect(await runVal({ value: '999.999.999.999', format: 'ipv4' })).toMatch(/^Invalid/)
    expect(await runVal({ value: 'BAD', format: 'uuid' })).toMatch(/^Invalid/)
  })

  it('rejects unknown formats at the schema level', async () => {
    await expect(runVal({ value: 'x', format: 'mystery' })).rejects.toBeInstanceOf(
      E_INVALID_TOOL_ARGS
    )
  })
})
