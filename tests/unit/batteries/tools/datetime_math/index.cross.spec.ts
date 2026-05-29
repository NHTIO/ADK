import { describe, expect, it } from 'vitest'
import { makeToolCtxStub } from '../../../../_fixtures/tool_ctx_stub'
import { E_INVALID_TOOL_ARGS } from '../../../../../src/lib/exceptions/runtime'
import {
  dateAddTool,
  dateDiffTool,
  durationFormatTool,
} from '../../../../../src/batteries/tools/datetime_math'

const runAdd = async (args: Record<string, unknown>): Promise<string> => {
  return (await dateAddTool.executor(makeToolCtxStub())(args)) as string
}
const runDiff = async (args: Record<string, unknown>): Promise<string> => {
  return (await dateDiffTool.executor(makeToolCtxStub())(args)) as string
}
const runFmt = async (args: Record<string, unknown>): Promise<string> => {
  return (await durationFormatTool.executor(makeToolCtxStub())(args)) as string
}

describe('dateAddTool', () => {
  it('adds days', async () => {
    const out = await runAdd({ date: '2026-03-15', direction: 'add', days: 7 })
    expect(out).toContain('2026')
    expect(out).toContain('March 22, 2026')
  })

  it('subtracts months', async () => {
    const out = await runAdd({ date: '2026-03-15', direction: 'subtract', months: 1 })
    expect(out).toContain('February 15, 2026')
  })

  it('adds combined years + months + days', async () => {
    const out = await runAdd({
      date: '2026-01-01',
      direction: 'add',
      years: 1,
      months: 2,
      days: 3,
    })
    expect(out).toContain('March 4, 2027')
  })

  it('includes time component when input has time', async () => {
    const out = await runAdd({
      date: '2026-03-15T10:30:00',
      direction: 'add',
      hours: 2,
    })
    expect(out).toMatch(/at \d+:\d+:\d+/)
  })

  it('includes time when duration has sub-day component', async () => {
    const out = await runAdd({ date: '2026-03-15', direction: 'add', hours: 1 })
    expect(out).toMatch(/at \d+:\d+:\d+/)
  })

  it('schema rejects invalid direction', async () => {
    await expect(
      runAdd({ date: '2026-03-15', direction: 'shift', days: 7 })
    ).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
  })

  it('errors on invalid date', async () => {
    const out = await runAdd({ date: 'not-iso', direction: 'add', days: 1 })
    expect(out).toMatch(/^Error/)
  })
})

describe('dateDiffTool', () => {
  it('reports day difference', async () => {
    const out = await runDiff({ from: '2026-03-01', to: '2026-03-15', unit: 'days' })
    expect(out).toContain('14 days after')
  })

  it('reports zero for same dates', async () => {
    const out = await runDiff({ from: '2026-03-15', to: '2026-03-15', unit: 'days' })
    expect(out).toContain('0 days')
  })

  it('reports negative direction when to < from', async () => {
    const out = await runDiff({ from: '2026-03-15', to: '2026-03-01', unit: 'days' })
    expect(out).toContain('14 days before')
  })

  it('computes hour difference within a day', async () => {
    const out = await runDiff({
      from: '2026-03-15T08:00:00Z',
      to: '2026-03-15T14:30:00Z',
      unit: 'hours',
    })
    expect(out).toContain('6.5 hours after')
  })

  it('computes month difference (calendar arithmetic)', async () => {
    const out = await runDiff({ from: '2026-01-15', to: '2026-04-15', unit: 'months' })
    expect(out).toContain('3 months after')
  })

  it('schema rejects unknown unit', async () => {
    await expect(
      runDiff({ from: '2026-01-01', to: '2026-02-01', unit: 'fortnights' })
    ).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
  })

  it('errors on invalid date', async () => {
    const out = await runDiff({ from: 'bad', to: '2026-02-01', unit: 'days' })
    expect(out).toMatch(/^Error/)
  })
})

describe('durationFormatTool', () => {
  it('formats 0 seconds', async () => {
    expect(await runFmt({ seconds: 0 })).toBe('0 seconds')
  })

  it('formats a single second', async () => {
    expect(await runFmt({ seconds: 1 })).toBe('1 second')
  })

  it('formats minutes and seconds', async () => {
    expect(await runFmt({ seconds: 125 })).toBe('2 minutes and 5 seconds')
  })

  it('formats hours, minutes, and seconds', async () => {
    expect(await runFmt({ seconds: 3725 })).toBe('1 hour, 2 minutes and 5 seconds')
  })

  it('formats days', async () => {
    const out = await runFmt({ seconds: 86400 })
    expect(out).toContain('1 day')
  })

  it('prefixes negative durations with -', async () => {
    expect(await runFmt({ seconds: -125 })).toBe('-2 minutes and 5 seconds')
  })

  it('schema rejects missing seconds', async () => {
    await expect(runFmt({})).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
  })
})
