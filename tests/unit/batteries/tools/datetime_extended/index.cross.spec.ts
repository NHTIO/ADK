import { describe, expect, it } from 'vitest'
import { makeToolCtxStub } from '../../../../_fixtures/tool_ctx_stub'
import { E_INVALID_TOOL_ARGS } from '../../../../../src/lib/exceptions/runtime'
import {
  dateBusinessDaysTool,
  dateCalendarInfoTool,
  dateNthWeekdayTool,
  dateParseTool,
  datePeriodTool,
} from '../../../../../src/batteries/tools/datetime_extended'

const runNth = async (args: Record<string, unknown>): Promise<string> => {
  return (await dateNthWeekdayTool.executor(makeToolCtxStub())(args)) as string
}
const runCal = async (args: Record<string, unknown>): Promise<string> => {
  return (await dateCalendarInfoTool.executor(makeToolCtxStub())(args)) as string
}
const runParse = async (args: Record<string, unknown>): Promise<string> => {
  return (await dateParseTool.executor(makeToolCtxStub())(args)) as string
}
const runPeriod = async (args: Record<string, unknown>): Promise<string> => {
  return (await datePeriodTool.executor(makeToolCtxStub())(args)) as string
}
const runBiz = async (args: Record<string, unknown>): Promise<string> => {
  return (await dateBusinessDaysTool.executor(makeToolCtxStub())(args)) as string
}

describe('dateNthWeekdayTool', () => {
  it('finds the 2nd Friday of March 2026', async () => {
    const out = await runNth({ nth: '2nd', weekday: 'friday', month: 3, year: 2026 })
    // 2026-03 Fridays: 6, 13, 20, 27 → 2nd is the 13th
    expect(out).toContain('2026-03-13')
  })

  it('finds the last Monday of January 2025', async () => {
    const out = await runNth({ nth: 'last', weekday: 'monday', month: 1, year: 2025 })
    // 2025-01 Mondays: 6, 13, 20, 27 → last is 27th
    expect(out).toContain('2025-01-27')
  })

  it('finds the 1st Sunday of February 2024', async () => {
    const out = await runNth({ nth: '1st', weekday: 'sunday', month: 2, year: 2024 })
    // 2024-02 Sundays: 4, 11, 18, 25 → 1st is 4th
    expect(out).toContain('2024-02-04')
  })

  it('reports error when 5th occurrence does not exist', async () => {
    const out = await runNth({ nth: '5th', weekday: 'monday', month: 2, year: 2026 })
    expect(out).toMatch(/^Error.*no 5th/)
  })

  it('rejects months outside 1-12', async () => {
    const out = await runNth({ nth: '1st', weekday: 'monday', month: 13, year: 2026 })
    expect(out).toMatch(/^Error.*Month must be 1.12/)
  })

  it('schema rejects unknown weekday', async () => {
    await expect(runNth({ nth: '1st', weekday: 'someday', month: 1 })).rejects.toBeInstanceOf(
      E_INVALID_TOOL_ARGS
    )
  })
})

describe('dateCalendarInfoTool', () => {
  it('reports ISO week, day of year, calendar quarter', async () => {
    const out = await runCal({ date: '2026-03-15' })
    expect(out).toContain('2026-03-15')
    expect(out).toContain('ISO week number:')
    expect(out).toContain('Calendar quarter: Q1')
    expect(out).toContain('Day of year:')
  })

  it('flags weekends correctly', async () => {
    // 2026-03-15 was a Sunday
    const out = await runCal({ date: '2026-03-15' })
    expect(out).toContain('Weekend: Yes')
    // 2026-03-16 is a Monday
    const monOut = await runCal({ date: '2026-03-16' })
    expect(monOut).toContain('Weekend: No')
  })

  it('computes fiscal year with a non-January start month', async () => {
    // July-start fiscal year: a March 2026 date is part of FY ending June 2026,
    // so fiscal_year_start_month=7 makes 2026-03 fall in FY2025.
    const out = await runCal({ date: '2026-03-15', fiscal_year_start_month: 7 })
    expect(out).toContain('FY2025')
  })

  it('accepts natural-language dates', async () => {
    const out = await runCal({ date: 'March 15 2026' })
    expect(out).toMatch(/2026-03-15/)
  })

  it('errors on unparseable date', async () => {
    const out = await runCal({ date: 'utter gibberish that nothing can parse @@@' })
    expect(out).toMatch(/^Error/)
  })
})

describe('dateParseTool', () => {
  it('parses "yesterday" relative to a reference date', async () => {
    const out = await runParse({ text: 'yesterday', reference_date: '2026-05-15T12:00:00Z' })
    expect(out).toContain('2026-05-14')
  })

  it('parses "in 2 weeks" relative to a reference date', async () => {
    const out = await runParse({ text: 'in 2 weeks', reference_date: '2026-05-15T12:00:00Z' })
    expect(out).toContain('2026-05-29')
  })

  it('parses absolute date strings', async () => {
    const out = await runParse({ text: 'March 5, 2026' })
    expect(out).toContain('2026-03-05')
  })

  it('errors on bogus reference_date', async () => {
    const out = await runParse({ text: 'tomorrow', reference_date: 'not-a-date' })
    expect(out).toMatch(/^Error.*Invalid reference_date/)
  })

  it('errors on unparseable text', async () => {
    const out = await runParse({ text: 'asdfqwerty' })
    expect(out).toMatch(/^Error.*Could not parse/)
  })
})

describe('datePeriodTool', () => {
  it('returns start of month', async () => {
    const out = await runPeriod({ date: '2026-03-15', period: 'month', boundary: 'start' })
    expect(out).toContain('2026-03-01')
  })

  it('returns end of year', async () => {
    const out = await runPeriod({ date: '2026-03-15', period: 'year', boundary: 'end' })
    expect(out).toContain('2026-12-31')
  })

  it('returns start of calendar quarter for date in Q1', async () => {
    const out = await runPeriod({ date: '2026-02-15', period: 'quarter', boundary: 'start' })
    expect(out).toContain('2026-01-01')
  })

  it('isoweek start is always a Monday', async () => {
    // 2026-03-15 is a Sunday, isoweek start = Monday 2026-03-09
    const out = await runPeriod({ date: '2026-03-15', period: 'isoweek', boundary: 'start' })
    expect(out).toContain('2026-03-09')
  })

  it('honours fiscal year start when computing year boundaries', async () => {
    // FY starting July: a March 2026 date sits in the FY that started July 2025
    const out = await runPeriod({
      date: '2026-03-15',
      period: 'year',
      boundary: 'start',
      fiscal_year_start_month: 7,
    })
    expect(out).toContain('2025-07-01')
  })

  it('schema rejects unknown period', async () => {
    await expect(
      runPeriod({ date: '2026-03-15', period: 'fortnight', boundary: 'start' })
    ).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
  })
})

describe('dateBusinessDaysTool', () => {
  it('counts 5 business days in a typical work week', async () => {
    // Monday to Friday of the same week = 4 business days between, but
    // counted from start-of-day Monday to start-of-day Friday is 4 weekdays in between
    const out = await runBiz({ from: '2026-03-02', to: '2026-03-06' })
    expect(out).toMatch(/4/)
  })

  it('returns 0 for same date', async () => {
    const out = await runBiz({ from: '2026-03-15', to: '2026-03-15' })
    expect(out).toContain(': 0')
  })

  it('returns negative count for reversed dates', async () => {
    const out = await runBiz({ from: '2026-03-06', to: '2026-03-02' })
    expect(out).toContain(': -4')
  })

  it('adds business days forward', async () => {
    // 2026-03-02 (Mon) + 5 business days = 2026-03-09 (Mon)
    const out = await runBiz({ from: '2026-03-02', add_days: 5 })
    expect(out).toContain('2026-03-09')
  })

  it('subtracts business days', async () => {
    // 2026-03-09 (Mon) - 5 business days = 2026-03-02 (Mon)
    const out = await runBiz({ from: '2026-03-09', add_days: -5 })
    expect(out).toContain('2026-03-02')
  })

  it('reports an error when neither to nor add_days is provided', async () => {
    const out = await runBiz({ from: '2026-03-02' })
    expect(out).toMatch(/^Error.*either/)
  })
})
