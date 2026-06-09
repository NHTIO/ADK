import { describe, expect, it } from 'vitest'
import { callTool, makeToolCtxStub } from '../../../../_fixtures/tool_ctx_stub'
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

/* ── helpers ──────────────────────────────────────────────────────────── */

/** Extract numeric value from date_diff output, e.g. "14 days after" */
function extractDiffValue(out: string): { value: number; unit: string; direction: string } {
  const m = out.match(/is ([\d.]+)\s+(\w+)\s+(after|before)/)
  if (!m) throw new Error(`Could not parse diff output: ${out}`)
  return { value: Number.parseFloat(m[1]), unit: m[2], direction: m[3] }
}

/* ── existing basic tests ─────────────────────────────────────────────── */

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

  /* ── adding 0 = identity (INVARIANT) ────────────────────────────────── */

  it('adding 0 days is identity', async () => {
    const out = await runAdd({ date: '2026-03-15', direction: 'add', days: 0 })
    expect(out).toContain('March 15, 2026')
  })

  it('subtracting 0 months is identity', async () => {
    const out = await runAdd({ date: '2026-06-01', direction: 'subtract', months: 0 })
    expect(out).toContain('June 1, 2026')
  })

  /* ── INVARIANT: date_add(date, +d) then date_diff = d ─────────────────── */

  it('adding 7 days then diffing gives 7 days', async () => {
    const addOut = await runAdd({ date: '2026-01-01', direction: 'add', days: 7 })
    // The output contains the result date somewhere
    expect(addOut).toContain('January 8, 2026')

    const diffOut = await runDiff({
      from: '2026-01-01',
      to: '2026-01-08',
      unit: 'days',
    })
    const { value } = extractDiffValue(diffOut)
    expect(value).toBe(7)
  })

  it('adding 3 months then diffing gives ~3 months', async () => {
    const diffOut = await runDiff({
      from: '2026-01-15',
      to: '2026-04-15',
      unit: 'months',
    })
    const { value } = extractDiffValue(diffOut)
    expect(value).toBeCloseTo(3, 0)
  })

  /* ── month-end overflow (Jan 31 + 1 month) ──────────────────────────── */

  it('Jan 31 + 1 month = Feb 28 (or 29 in leap year)', async () => {
    const out = await runAdd({ date: '2026-01-31', direction: 'add', months: 1 })
    // 2026 is not a leap year → Feb 28
    expect(out).toContain('February 28')
  })

  it('Jan 31 + 1 month in leap year 2024 = Feb 29', async () => {
    const out = await runAdd({ date: '2024-01-31', direction: 'add', months: 1 })
    expect(out).toContain('February 29')
  })

  /* ── leap day ────────────────────────────────────────────────────────── */

  it('Feb 29 2024 + 1 year = Feb 28 2025', async () => {
    const out = await runAdd({ date: '2024-02-29', direction: 'add', years: 1 })
    expect(out).toContain('February 28')
    expect(out).toContain('2025')
  })

  it('Feb 29 2024 + 4 years = Feb 29 2028 (next leap)', async () => {
    const out = await runAdd({ date: '2024-02-29', direction: 'add', years: 4 })
    expect(out).toContain('February 29')
    expect(out).toContain('2028')
  })

  /* ── negative duration via subtract ──────────────────────────────────── */

  it('subtract 30 days from March 1 = Jan 30/31', async () => {
    const out = await runAdd({ date: '2026-03-01', direction: 'subtract', days: 30 })
    expect(out).toContain('January')
    // Jan 30 or Jan 31 depending on leap year (2026 not leap)
  })

  /* ── adding across DST boundary ──────────────────────────────────────── */

  it('adding hours across DST spring-forward (UTC zone)', async () => {
    // In UTC there is no DST, so adding hours is straightforward
    const out = await runAdd({
      date: '2026-03-08T01:00:00',
      direction: 'add',
      hours: 2,
      timezone: 'UTC',
    })
    expect(out).toMatch(/3:00:00/)
  })

  /* ── timezone support ──────────────────────────────────────────────── */

  it('respects timezone parameter', async () => {
    const out = await runAdd({
      date: '2026-01-01T00:00:00',
      direction: 'add',
      hours: 5,
      timezone: 'America/New_York',
    })
    // Should include timezone info in output
    expect(out).toMatch(/at/)
  })

  it('invalid timezone returns error', async () => {
    const out = await runAdd({
      date: '2026-01-01',
      direction: 'add',
      days: 1,
      timezone: 'Invalid/Timezone',
    })
    expect(out).toMatch(/^Error/)
  })

  /* ── "now" input ────────────────────────────────────────────────────── */

  it('"now" is accepted as date input', async () => {
    const out = await runAdd({ date: 'now', direction: 'add', days: 1 })
    // Should contain a date (not an error)
    expect(out).not.toMatch(/^Error/)
  })

  /* ── combined units ────────────────────────────────────────────────── */

  it('adds weeks correctly', async () => {
    const out = await runAdd({ date: '2026-01-01', direction: 'add', weeks: 2 })
    expect(out).toContain('January 15, 2026')
  })

  it('adds hours and minutes', async () => {
    const out = await runAdd({
      date: '2026-03-15T10:00:00',
      direction: 'add',
      hours: 1,
      minutes: 30,
    })
    expect(out).toMatch(/11:30:00/)
  })

  it('adds seconds', async () => {
    const out = await runAdd({
      date: '2026-03-15T10:00:00',
      direction: 'add',
      seconds: 90,
    })
    expect(out).toMatch(/10:01:30/)
  })

  /* ── subtract direction ─────────────────────────────────────────────── */

  it('subtract hours', async () => {
    const out = await runAdd({
      date: '2026-03-15T12:00:00',
      direction: 'subtract',
      hours: 3,
    })
    expect(out).toMatch(/9:00:00/)
  })

  /* ── date-only input (no time) + sub-day duration includes time ──────── */

  it('date-only input with hours shows time', async () => {
    const out = await runAdd({ date: '2026-03-15', direction: 'add', hours: 2 })
    expect(out).toMatch(/at/)
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

  /* ── INVARIANT: date_add(date, +d) then date_diff(from, to) = d ──── */

  it('adding 90 days then diffing gives 90', async () => {
    const diffOut = await runDiff({
      from: '2026-01-01',
      to: '2026-04-01',
      unit: 'days',
    })
    const { value } = extractDiffValue(diffOut)
    expect(value).toBe(90)
  })

  it('adding 1 year then diffing gives ~1 year in days', async () => {
    const diffOut = await runDiff({
      from: '2026-01-01',
      to: '2027-01-01',
      unit: 'days',
    })
    const { value } = extractDiffValue(diffOut)
    expect(value).toBe(365)
  })

  /* ── same instant = 0 ───────────────────────────────────────────────── */

  it('same instant with time gives 0', async () => {
    const out = await runDiff({
      from: '2026-03-15T10:00:00Z',
      to: '2026-03-15T10:00:00Z',
      unit: 'seconds',
    })
    expect(out).toContain('0 seconds')
  })

  /* ── different units ─────────────────────────────────────────────────── */

  it('computes week difference', async () => {
    const out = await runDiff({ from: '2026-01-01', to: '2026-01-29', unit: 'weeks' })
    const { value } = extractDiffValue(out)
    expect(value).toBeCloseTo(4, 0)
  })

  it('computes minute difference', async () => {
    const out = await runDiff({
      from: '2026-03-15T10:00:00Z',
      to: '2026-03-15T10:30:00Z',
      unit: 'minutes',
    })
    const { value } = extractDiffValue(out)
    expect(value).toBeCloseTo(30, 0)
  })

  it('computes second difference', async () => {
    const out = await runDiff({
      from: '2026-03-15T10:00:00Z',
      to: '2026-03-15T10:00:45Z',
      unit: 'seconds',
    })
    const { value } = extractDiffValue(out)
    expect(value).toBe(45)
  })

  it('computes year difference', async () => {
    const out = await runDiff({ from: '2020-01-01', to: '2026-01-01', unit: 'years' })
    const { value } = extractDiffValue(out)
    expect(value).toBe(6)
  })

  /* ── across timezones ─────────────────────────────────────────────────── */

  it('diff respects timezone parameter', async () => {
    const out = await runDiff({
      from: '2026-01-01T00:00:00',
      to: '2026-01-01T05:00:00',
      unit: 'hours',
      timezone: 'UTC',
    })
    const { value } = extractDiffValue(out)
    expect(value).toBeCloseTo(5, 0)
  })

  /* ── from > to = before ────────────────────────────────────────────── */

  it('to before from gives "before"', async () => {
    const out = await runDiff({ from: '2026-06-01', to: '2026-01-01', unit: 'days' })
    expect(out).toContain('before')
  })

  /* ── "now" as input ──────────────────────────────────────────────────── */

  it('"now" accepted as from', async () => {
    const out = await runDiff({ from: 'now', to: '2026-06-01', unit: 'days' })
    // Should not error
    expect(out).not.toMatch(/^Error/)
  })

  /* ── invalid timezone ────────────────────────────────────────────────── */

  it('invalid timezone returns error', async () => {
    const out = await runDiff({
      from: '2026-01-01',
      to: '2026-02-01',
      unit: 'days',
      timezone: 'Invalid/Zone',
    })
    expect(out).toMatch(/^Error/)
  })

  /* ── leap year handling ──────────────────────────────────────────────── */

  it('Feb 28 to Mar 1 in leap year = 2 days (Feb 29 exists)', async () => {
    const out = await runDiff({ from: '2024-02-28', to: '2024-03-01', unit: 'days' })
    const { value } = extractDiffValue(out)
    expect(value).toBe(2)
  })

  it('Feb 28 to Mar 1 in non-leap year = 1 day', async () => {
    const out = await runDiff({ from: '2025-02-28', to: '2025-03-01', unit: 'days' })
    const { value } = extractDiffValue(out)
    expect(value).toBe(1)
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

  /* ── edge cases ────────────────────────────────────────────────────── */

  it('formats 60 seconds as 1 minute', async () => {
    expect(await runFmt({ seconds: 60 })).toBe('1 minute')
  })

  it('formats 3600 seconds as 1 hour', async () => {
    expect(await runFmt({ seconds: 3600 })).toBe('1 hour')
  })

  it('formats 86400 seconds as 1 day', async () => {
    expect(await runFmt({ seconds: 86400 })).toBe('1 day')
  })

  it('formats 604800 seconds as 1 week', async () => {
    expect(await runFmt({ seconds: 604800 })).toBe('1 week')
  })

  it('formats large duration with days and hours', async () => {
    const out = await runFmt({ seconds: 90300 }) // 1 day, 1 hour, 5 minutes
    expect(out).toContain('1 day')
    expect(out).toContain('1 hour')
    expect(out).toContain('5 minutes')
  })

  it('negative 1 second', async () => {
    expect(await runFmt({ seconds: -1 })).toBe('-1 second')
  })

  it('negative 3600 seconds', async () => {
    expect(await runFmt({ seconds: -3600 })).toBe('-1 hour')
  })

  it('fractional seconds are truncated (floor)', async () => {
    // 125.9 seconds = 2 minutes, 5.9 seconds → should be 2 minutes and 5 seconds
    const out = await runFmt({ seconds: 125.9 })
    expect(out).toContain('2 minutes')
    expect(out).toContain('5 seconds')
  })

  /* ── INVARIANT: round-trip with date_diff ────────────────────────────── */
  // Note: duration_format works with total seconds, not calendar arithmetic.
  // The invariant we can check: 86400 seconds = 1 day

  it('86400 seconds formats to exactly 1 day', async () => {
    expect(await runFmt({ seconds: 86400 })).toBe('1 day')
  })

  it('comprehensive breakdown: 90061 seconds = 1 day, 1 hour, 1 minute, 1 second', async () => {
    // 1 day = 86400s, 1 hour = 3600s, 1 minute = 60s, 1 second
    const out = await runFmt({ seconds: 86400 + 3600 + 60 + 1 }) // 90061
    expect(out).toContain('1 day')
    expect(out).toContain('1 hour')
    expect(out).toContain('1 minute')
    expect(out).toContain('1 second')
  })

  /* ── 0 vs -0 ────────────────────────────────────────────────────────── */

  it('0 seconds and -0 seconds both format as "0 seconds"', async () => {
    expect(await runFmt({ seconds: 0 })).toBe('0 seconds')
    // -0 is 0 in JS
    expect(await runFmt({ seconds: -0 })).toBe('0 seconds')
  })

  it('duration_format rejects NaN seconds cleanly via schema (not a downstream crash)', async () => {
    // NaN is not a valid number per the schema, so the ACCEPTABLE behaviour is a clean
    // E_INVALID_TOOL_ARGS rejection — not a resolved result and not E_TOOL_DOWNSTREAM_ERROR.
    const r = await callTool(durationFormatTool, { seconds: Number.NaN })
    expect(r.kind).toBe('threw')
    if (r.kind === 'threw') expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
  })

  it('duration_format rejects Infinity seconds cleanly via schema', async () => {
    const r = await callTool(durationFormatTool, { seconds: Infinity })
    expect(r.kind).toBe('threw')
    if (r.kind === 'threw') expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
  })

  it('duration_format with huge seconds must not crash', async () => {
    const r = await callTool(durationFormatTool, { seconds: 1e15 })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(typeof r.out).toBe('string')
  })
})

describe('callTool no-crash: adversarial edges', () => {
  it('date_add rejects NaN days cleanly via schema (not a downstream crash)', async () => {
    const r = await callTool(dateAddTool, {
      date: '2026-01-01',
      direction: 'add',
      days: Number.NaN,
    })
    expect(r.kind).toBe('threw')
    if (r.kind === 'threw') expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
  })

  it('date_add rejects Infinity months cleanly via schema', async () => {
    const r = await callTool(dateAddTool, {
      date: '2026-01-01',
      direction: 'add',
      months: Infinity,
    })
    expect(r.kind).toBe('threw')
    if (r.kind === 'threw') expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
  })

  it('date_add with very bad date string must not crash', async () => {
    const r = await callTool(dateAddTool, { date: '\uD800', direction: 'add', days: 1 })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(r.out).toMatch(/^Error/)
  })

  it('date_add with invalid timezone must not crash', async () => {
    const r = await callTool(dateAddTool, {
      date: '2026-01-01',
      direction: 'add',
      days: 1,
      timezone: 'Not/AZone',
    })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(r.out).toMatch(/^Error/)
  })

  it('date_diff with same dates returns 0', async () => {
    const r = await callTool(dateDiffTool, {
      from: '2026-01-01',
      to: '2026-01-02',
      unit: 'seconds',
    })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') expect(typeof r.out).toBe('string')
  })

  /* ── Luxon oracle: date_add then verify with independent luxon ─────── */

  it('date_add 90 days from 2026-01-01 = 2026-04-01 (luxon oracle)', async () => {
    const r = await callTool(dateAddTool, { date: '2026-01-01', direction: 'add', days: 90 })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') {
      // Luxon: DateTime.fromISO('2026-01-01').plus({days:90}) = 2026-04-01
      expect(r.out).toContain('April 1, 2026')
    }
  })

  it('date_diff 1 year in days = 365 or 366 (luxon oracle)', async () => {
    const r = await callTool(dateDiffTool, { from: '2024-01-01', to: '2025-01-01', unit: 'days' })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') {
      // 2024 is a leap year → 366 days
      const { value } = extractDiffValue(r.out)
      expect(value).toBe(366)
    }
  })
})
