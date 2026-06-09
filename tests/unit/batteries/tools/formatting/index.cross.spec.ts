import { describe, expect, it } from 'vitest'
import { callTool, makeToolCtxStub } from '../../../../_fixtures/tool_ctx_stub'
import { E_INVALID_TOOL_ARGS } from '../../../../../src/lib/exceptions/runtime'
import { formatListTool, formatNumberTool } from '../../../../../src/batteries/tools/formatting'

const runNum = async (args: Record<string, unknown>): Promise<string> => {
  return (await formatNumberTool.executor(makeToolCtxStub())(args)) as string
}
const runList = async (args: Record<string, unknown>): Promise<string> => {
  return (await formatListTool.executor(makeToolCtxStub())(args)) as string
}

describe('formatNumberTool', () => {
  describe('decimal (default)', () => {
    it('uses en-US grouping by default', async () => {
      const out = await runNum({ value: 1234567.89 })
      // en-US default formatting: "1,234,567.89"
      expect(out).toContain('1,234,567')
    })

    it('respects min_decimals', async () => {
      const out = await runNum({ value: 1, min_decimals: 3 })
      expect(out).toBe('1.000')
    })

    it('respects max_decimals', async () => {
      const out = await runNum({ value: 1.23456789, max_decimals: 2 })
      expect(out).toBe('1.23')
    })

    it('respects a custom locale (German uses dot as thousands separator)', async () => {
      const out = await runNum({ value: 1234.5, locale: 'de-DE' })
      // de-DE: "1.234,5"
      expect(out).toMatch(/1\.234/)
    })
  })

  describe('currency', () => {
    it('formats USD by default locale', async () => {
      const out = await runNum({ value: 100, style: 'currency', currency: 'USD' })
      expect(out).toContain('$100')
    })

    it('errors when currency is missing for currency style', async () => {
      const out = await runNum({ value: 100, style: 'currency' })
      expect(out).toMatch(/^Error/)
      expect(out).toContain('currency')
    })

    it('upper-cases the currency code (usd → USD)', async () => {
      const out = await runNum({ value: 100, style: 'currency', currency: 'usd' })
      expect(out).toContain('$100')
    })
  })

  describe('percent', () => {
    it('formats 0.5 as 50%', async () => {
      const out = await runNum({ value: 0.5, style: 'percent' })
      expect(out).toMatch(/50\.0%/)
    })
  })

  describe('compact', () => {
    it('formats 1500 as 1.5K (en-US compact)', async () => {
      const out = await runNum({ value: 1500, style: 'compact' })
      expect(out).toMatch(/1\.5K/)
    })
  })

  describe('scientific', () => {
    it('formats 1234 in scientific notation as 1.234e+3 (mantissa × 10^exp)', async () => {
      const out = await runNum({ value: 1234, style: 'scientific' })
      expect(out).toMatch(/^1\.23\d+e\+3$/)
    })

    it('handles zero', async () => {
      const out = await runNum({ value: 0, style: 'scientific' })
      expect(out).toMatch(/e\+0$/)
    })
  })

  describe('ordinal', () => {
    it('1 → 1st (en-US)', async () => {
      const out = await runNum({ value: 1, style: 'ordinal' })
      expect(out).toBe('1st')
    })
    it('2 → 2nd (en-US)', async () => {
      const out = await runNum({ value: 2, style: 'ordinal' })
      expect(out).toBe('2nd')
    })
    it('3 → 3rd (en-US)', async () => {
      const out = await runNum({ value: 3, style: 'ordinal' })
      expect(out).toBe('3rd')
    })
    it('4 → 4th (en-US)', async () => {
      const out = await runNum({ value: 4, style: 'ordinal' })
      expect(out).toBe('4th')
    })
    it('21 → 21st (en-US)', async () => {
      const out = await runNum({ value: 21, style: 'ordinal' })
      expect(out).toBe('21st')
    })
  })

  describe('error path', () => {
    it('rejects Infinity via schema (validator.number() forbids Infinity)', async () => {
      await expect(runNum({ value: Number.POSITIVE_INFINITY })).rejects.toBeInstanceOf(
        E_INVALID_TOOL_ARGS
      )
    })

    it('rejects unknown style via schema', async () => {
      await expect(runNum({ value: 1, style: 'roman' })).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
    })
  })
})

describe('formatNumberTool no-crash adversarial cases (callTool)', () => {
  // NaN / Infinity / 1e308 all fail validator.number() (not-a-number / infinity / not-safe),
  // so the CORRECT, non-crashing behaviour is a clean E_INVALID_TOOL_ARGS schema rejection —
  // not a resolved result. (A clean rejection is acceptable; an E_TOOL_DOWNSTREAM_ERROR is not.)
  it('formatNumber: NaN is rejected cleanly by the schema', async () => {
    const result = await callTool(formatNumberTool, { value: Number.NaN })
    expect(result.kind).toBe('threw')
    if (result.kind === 'threw') expect(result.errorName).toBe('E_INVALID_TOOL_ARGS')
  })

  it('formatNumber: Infinity is rejected cleanly by the schema', async () => {
    const result = await callTool(formatNumberTool, { value: Number.POSITIVE_INFINITY })
    expect(result.kind).toBe('threw')
    if (result.kind === 'threw') expect(result.errorName).toBe('E_INVALID_TOOL_ARGS')
  })

  it('formatNumber: 1e308 (not a safe integer) is rejected cleanly by the schema', async () => {
    const result = await callTool(formatNumberTool, { value: 1e308 })
    expect(result.kind).toBe('threw')
    if (result.kind === 'threw') expect(result.errorName).toBe('E_INVALID_TOOL_ARGS')
  })

  it('formatNumber: missing currency for currency style returns graceful error', async () => {
    const result = await callTool(formatNumberTool, { value: 100, style: 'currency' })
    expect(result.kind).toBe('resolved')
    if (result.kind === 'resolved') {
      expect(result.out).toMatch(/^Error:/)
    }
  })
})

describe('formatListTool', () => {
  describe('bullet', () => {
    it('joins items with bullet prefix', async () => {
      const out = await runList({ items: ['a', 'b', 'c'] })
      expect(out).toBe('• a\n• b\n• c')
    })
    it('respects indent', async () => {
      const out = await runList({ items: ['a'], indent: 4 })
      expect(out).toBe('    • a')
    })

    it('clamps a large indent to the 100-space maximum', async () => {
      const out = await runList({ items: ['a'], indent: 10000 })
      expect(out).toBe(' '.repeat(100) + '• a')
    })

    // An enormous finite indent (which passes the number schema) must not reach an unbounded
    // `' '.repeat(indent)` (RangeError). It clamps to 100 and renders normally.
    it('does not crash on an enormous indent (1e9) — clamps to 100', async () => {
      const result = await callTool(formatListTool, { items: ['a'], indent: 1e9 })
      expect(result.kind).toBe('resolved')
      if (result.kind === 'resolved') expect(result.out).toBe(' '.repeat(100) + '• a')
    })
  })

  describe('numbered', () => {
    it('produces 1., 2., 3.', async () => {
      const out = await runList({ items: ['a', 'b', 'c'], style: 'numbered' })
      expect(out).toBe('1. a\n2. b\n3. c')
    })
  })

  describe('newline', () => {
    it('joins items with newlines and no prefix', async () => {
      const out = await runList({ items: ['x', 'y', 'z'], style: 'newline' })
      expect(out).toBe('x\ny\nz')
    })
  })

  describe('inline_and', () => {
    it('joins 3+ items as "a, b, and c"', async () => {
      const out = await runList({ items: ['a', 'b', 'c'], style: 'inline_and' })
      expect(out).toBe('a, b, and c')
    })
    it('joins 2 items as "a and b"', async () => {
      const out = await runList({ items: ['a', 'b'], style: 'inline_and' })
      expect(out).toBe('a and b')
    })
    it('a single item is returned unchanged', async () => {
      const out = await runList({ items: ['only'], style: 'inline_and' })
      expect(out).toBe('only')
    })
  })

  describe('inline_or', () => {
    it('joins 3+ items as "a, b, or c"', async () => {
      const out = await runList({ items: ['a', 'b', 'c'], style: 'inline_or' })
      expect(out).toBe('a, b, or c')
    })
  })

  describe('empty input', () => {
    it('returns empty string for empty array', async () => {
      const out = await runList({ items: [] })
      expect(out).toBe('')
    })
  })

  describe('schema rejection', () => {
    it('rejects when items is missing', async () => {
      await expect(runList({})).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
    })
    it('rejects items containing non-strings', async () => {
      await expect(runList({ items: ['ok', 42] })).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
    })
  })
})
