/**
 * Pre-constructed tools for parsing natural-language dates and business-calendar calculations.
 *
 * @module @nhtio/adk/batteries/tools/datetime_extended
 *
 * @remarks
 * Pre-constructed bundled tools for the `datetime_extended` category. Import individually, the whole
 * category, or import every tool via `@nhtio/adk/batteries`.
 */

import * as chrono from 'chrono-node'
import { Tool } from '@nhtio/adk/common'
import { DateTime, IANAZone } from 'luxon'
import { validator } from '@nhtio/validation'

function resolveZone(timezone: string | undefined): { zone: string; error?: string } {
  if (!timezone) return { zone: 'UTC' }
  if (!IANAZone.isValidZone(timezone)) return { zone: '', error: `Invalid timezone "${timezone}".` }
  return { zone: timezone }
}

function countBusinessDays(from: DateTime, to: DateTime): number {
  const forward = to >= from
  const start = forward ? from.startOf('day') : to.startOf('day')
  const end = forward ? to.startOf('day') : from.startOf('day')

  const totalDays = Math.round(end.diff(start, 'days').days)
  const fullWeeks = Math.floor(totalDays / 7)
  let bdays = fullWeeks * 5

  let cursor = start.plus({ days: fullWeeks * 7 })
  while (cursor < end) {
    cursor = cursor.plus({ days: 1 })
    if (cursor.weekday <= 5) bdays++
  }

  return forward ? bdays : -bdays
}

/**
 * Find the Nth occurrence of a weekday in a given month.
 *
 * @remarks
 * Examples: "2nd Friday of March 2026", "last Monday of January 2025". Accepts 1st–5th and
 * `last`. Returns an error if the month does not contain that many occurrences of the weekday.
 */
export const dateNthWeekdayTool = new Tool({
  name: 'date_nth_weekday',
  description:
    'Find the Nth occurrence of a weekday in a given month (e.g., "2nd Friday of March 2026", "last Monday of next month"). Supports 1st–5th and "last".',
  inputSchema: validator.object({
    nth: validator
      .string()
      .required()
      .description('Which occurrence: "1st", "2nd", "3rd", "4th", "5th", or "last".'),
    weekday: validator
      .string()
      .valid('monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday')
      .required()
      .description('Day of the week.'),
    month: validator.number().required().description('Month number (1–12).'),
    year: validator.number().optional().description('Year (defaults to current year).'),
    timezone: validator.string().optional().description('IANA timezone (optional, defaults UTC).'),
  }),
  handler: async (args) => {
    const {
      nth,
      weekday,
      month: rawMonth,
      year: rawYear,
      timezone,
    } = args as {
      nth: string
      weekday: string
      month: number
      year?: number
      timezone?: string
    }
    const { zone, error: zoneError } = resolveZone(timezone)
    if (zoneError) return `Error: ${zoneError}`

    const weekdayNames: Record<string, number> = {
      monday: 1,
      tuesday: 2,
      wednesday: 3,
      thursday: 4,
      friday: 5,
      saturday: 6,
      sunday: 7,
    }

    const targetWeekday = weekdayNames[weekday.toLowerCase()]
    const month = Math.floor(rawMonth)
    if (month < 1 || month > 12) return `Error: Month must be 1–12, got ${rawMonth}.`

    const year = Math.floor(rawYear ?? DateTime.now().setZone(zone).year)
    const nthRaw = nth.toLowerCase().replace(/\s/g, '')

    const firstOfMonth = DateTime.fromObject({ year, month, day: 1 }, { zone })
    if (!firstOfMonth.isValid) return `Error: Invalid date for ${year}-${month}.`

    const occurrences: DateTime[] = []
    let cursor = firstOfMonth
    while (cursor.weekday !== targetWeekday) {
      cursor = cursor.plus({ days: 1 })
    }
    while (cursor.month === month) {
      occurrences.push(cursor)
      cursor = cursor.plus({ weeks: 1 })
    }

    let result: DateTime | undefined

    if (nthRaw === 'last') {
      result = occurrences[occurrences.length - 1]
    } else {
      const nthMap: Record<string, number> = {
        '1st': 1,
        '1': 1,
        'first': 1,
        '2nd': 2,
        '2': 2,
        'second': 2,
        '3rd': 3,
        '3': 3,
        'third': 3,
        '4th': 4,
        '4': 4,
        'fourth': 4,
        '5th': 5,
        '5': 5,
        'fifth': 5,
      }
      const n = nthMap[nthRaw]
      if (!n) return `Error: Invalid nth value "${nth}". Use 1st–5th or "last".`
      if (n > occurrences.length) {
        return `Error: There is no ${nth} ${weekday} in ${firstOfMonth.toFormat('LLLL yyyy')} (only ${occurrences.length} occurrence${occurrences.length !== 1 ? 's' : ''}).`
      }
      result = occurrences[n - 1]
    }

    if (!result) return 'Error: Could not compute the date.'

    return `${nth} ${weekday} of ${result.toFormat('LLLL yyyy')}: ${result.toISODate()}\nFormatted: ${result.toFormat('cccc, LLLL d, yyyy')}`
  },
})

/**
 * Get calendar metadata for a date.
 *
 * @remarks
 * Reports ISO week number, day of year, calendar quarter, fiscal quarter/year (configurable via
 * `fiscal_year_start_month`), week of month, and whether the date is a weekend. Accepts ISO
 * dates, natural-language ("next Tuesday"), and `now`.
 */
export const dateCalendarInfoTool = new Tool({
  name: 'date_calendar_info',
  description:
    'Get calendar metadata for a date: ISO week number, day of year, calendar quarter, fiscal quarter/year, week of month, and whether it is a weekend or weekday.',
  inputSchema: validator.object({
    date: validator
      .string()
      .required()
      .description('ISO 8601 date, natural language date, or "now".'),
    timezone: validator.string().optional().description('IANA timezone (optional, defaults UTC).'),
    fiscal_year_start_month: validator
      .number()
      .default(1)
      .description('Month when fiscal year starts (1–12, default: 1 = calendar year).'),
  }),
  handler: async (args) => {
    const {
      date: dateStr,
      timezone,
      fiscal_year_start_month: rawFyStart,
    } = args as {
      date: string
      timezone?: string
      fiscal_year_start_month: number
    }
    const { zone, error: zoneError } = resolveZone(timezone)
    if (zoneError) return `Error: ${zoneError}`

    let dt: DateTime

    if (dateStr.toLowerCase() === 'now') {
      dt = DateTime.now().setZone(zone)
    } else {
      dt = DateTime.fromISO(dateStr, { zone })
      if (!dt.isValid) {
        const parsed = chrono.parseDate(dateStr, new Date())
        if (!parsed) return `Error: Could not parse date "${dateStr}".`
        dt = DateTime.fromJSDate(parsed).setZone(zone)
      }
    }

    const fyStart = Math.max(1, Math.min(12, Math.floor(rawFyStart)))

    const calendarQuarter = Math.ceil(dt.month / 3)

    const monthInFY = (dt.month - fyStart + 12) % 12
    const fiscalQuarter = Math.floor(monthInFY / 3) + 1
    const fiscalYear = dt.month >= fyStart ? dt.year : dt.year - 1

    const firstOfMonth = dt.startOf('month')
    const weekOfMonth = Math.ceil((dt.day + firstOfMonth.weekday - 1) / 7)

    const dayOfYear = Math.floor(dt.diff(dt.startOf('year'), 'days').days) + 1

    const isWeekend = dt.weekday >= 6

    const lines = [
      `Date: ${dt.toISODate()} (${dt.toFormat('cccc, LLLL d, yyyy')})`,
      '',
      `ISO week number: ${dt.weekNumber} (ISO year: ${dt.weekYear})`,
      `Day of year: ${dayOfYear} / ${dt.daysInYear}`,
      `Day of week: ${dt.weekday} (${dt.toFormat('cccc')})`,
      `Week of month: ${weekOfMonth}`,
      `Weekend: ${isWeekend ? 'Yes' : 'No'}`,
      '',
      `Calendar quarter: Q${calendarQuarter}`,
      `Fiscal quarter: FQ${fiscalQuarter} (FY${fiscalYear}${fyStart !== 1 ? `, starts month ${fyStart}` : ''})`,
    ]

    return lines.join('\n')
  },
})

/**
 * Parse a date/time expression from natural language or common formats.
 *
 * @remarks
 * Examples: `"next Monday"`, `"March 5th"`, `"in 2 weeks"`, `"yesterday"`. Uses chrono-node for
 * relative parsing. `reference_date` overrides the "now" anchor.
 */
export const dateParseTool = new Tool({
  name: 'date_parse',
  description:
    'Parse a date/time string from natural language or common formats ("next Monday", "March 5th", "in 2 weeks", "yesterday"). Returns an ISO 8601 date.',
  inputSchema: validator.object({
    text: validator
      .string()
      .required()
      .description('Date/time expression to parse (natural language or structured)'),
    reference_date: validator
      .string()
      .optional()
      .description('ISO date to treat as "now" for relative expressions (default: current time)'),
    timezone: validator
      .string()
      .optional()
      .description('IANA timezone for the result (optional, defaults UTC)'),
  }),
  handler: async (args) => {
    const {
      text,
      reference_date: referenceDate,
      timezone,
    } = args as {
      text: string
      reference_date?: string
      timezone?: string
    }
    const { zone, error: zoneError } = resolveZone(timezone)
    if (zoneError) return `Error: ${zoneError}`

    let refDate = new Date()
    if (referenceDate) {
      refDate = new Date(referenceDate)
      if (Number.isNaN(refDate.getTime()))
        return `Error: Invalid reference_date "${referenceDate}".`
    }

    const parsed = chrono.parseDate(text, refDate)
    if (!parsed) return `Error: Could not parse a date from "${text}".`

    const dt = DateTime.fromJSDate(parsed).setZone(zone)
    return `ISO: ${dt.toISO()}\nFormatted: ${dt.toFormat('cccc, LLLL d, yyyy h:mm a ZZZZ')}`
  },
})

/**
 * Get the start or end of a time period containing a given date.
 *
 * @remarks
 * Periods: `day`, `week`, `isoweek` (Monday-start), `month`, `quarter`, `year`. Quarter and year
 * honour `fiscal_year_start_month` for fiscal calendars (default: 1 = calendar year).
 */
export const datePeriodTool = new Tool({
  name: 'date_period',
  description:
    'Get the start or end of a time period (day, week, month, quarter, year) containing a given date. Supports fiscal year offsets.',
  inputSchema: validator.object({
    date: validator.string().required().description('ISO 8601 date or "now"'),
    period: validator
      .string()
      .valid('day', 'week', 'isoweek', 'month', 'quarter', 'year')
      .required()
      .description('Time period (isoweek = Monday-start week)'),
    boundary: validator
      .string()
      .valid('start', 'end')
      .required()
      .description('"start" for the first moment, "end" for the last moment of the period'),
    timezone: validator.string().optional().description('IANA timezone (optional, defaults UTC)'),
    fiscal_year_start_month: validator
      .number()
      .default(1)
      .description(
        'For quarter/year: month number when the fiscal year starts (1–12, default: 1 = calendar year)'
      ),
  }),
  handler: async (args) => {
    const {
      date: dateStr,
      period,
      boundary,
      timezone,
      fiscal_year_start_month: rawFyStart,
    } = args as {
      date: string
      period: 'day' | 'week' | 'isoweek' | 'month' | 'quarter' | 'year'
      boundary: 'start' | 'end'
      timezone?: string
      fiscal_year_start_month: number
    }
    const { zone, error: zoneError } = resolveZone(timezone)
    if (zoneError) return `Error: ${zoneError}`

    const dt =
      dateStr.toLowerCase() === 'now'
        ? DateTime.now().setZone(zone)
        : DateTime.fromISO(dateStr, { zone })
    if (!dt.isValid) return `Error: Invalid date "${dateStr}".`

    const fyStart = Math.max(1, Math.min(12, Math.floor(rawFyStart)))

    let result: DateTime

    switch (period) {
      case 'day':
        result = boundary === 'start' ? dt.startOf('day') : dt.endOf('day')
        break
      case 'week':
        result = boundary === 'start' ? dt.startOf('week') : dt.endOf('week')
        break
      case 'isoweek':
        result =
          boundary === 'start'
            ? dt.startOf('week').set({ weekday: 1 })
            : dt.startOf('week').set({ weekday: 7 }).endOf('day')
        break
      case 'month':
        result = boundary === 'start' ? dt.startOf('month') : dt.endOf('month')
        break
      case 'quarter': {
        // Months since the fiscal year began (0–11), then the offset into the current quarter.
        // Stepping back that many whole months from the start of `dt`'s month lands on the quarter
        // start — and crucially handles quarters that span the calendar-year boundary (e.g. an
        // FY-Feb Q4 of Nov–Jan): subtracting months rolls the year back correctly, where the old
        // `dt.set({month})` kept the current year and produced a date in the wrong quarter.
        const monthInFY = (dt.month - fyStart + 12) % 12
        const monthsIntoQuarter = monthInFY % 3
        const qStart = dt.startOf('month').minus({ months: monthsIntoQuarter })
        result =
          boundary === 'start' ? qStart : qStart.plus({ months: 3 }).minus({ days: 1 }).endOf('day')
        break
      }
      case 'year':
        if (fyStart === 1) {
          result = boundary === 'start' ? dt.startOf('year') : dt.endOf('year')
        } else {
          const fyStartThis = dt.set({ month: fyStart, day: 1 }).startOf('day')
          const fyBase = dt >= fyStartThis ? fyStartThis : fyStartThis.minus({ years: 1 })
          result =
            boundary === 'start'
              ? fyBase
              : fyBase.plus({ years: 1 }).minus({ days: 1 }).endOf('day')
        }
        break
    }

    return `${boundary === 'start' ? 'Start' : 'End'} of ${period} containing ${dateStr}: ${result.toISO()}\nFormatted: ${result.toFormat('cccc, LLLL d, yyyy h:mm:ss a ZZZZ')}`
  },
})

/**
 * Count business days between two dates, or compute the date N business days away.
 *
 * @remarks
 * Monday–Friday only; no holiday calendar awareness. Provide either `to` (count between) or
 * `add_days` (compute target date). Negative `add_days` walks backwards.
 */
export const dateBusinessDaysTool = new Tool({
  name: 'date_business_days',
  description:
    'Count business days (Mon–Fri, no holiday awareness) between two dates, or calculate the date that is N business days from a start date.',
  inputSchema: validator.object({
    from: validator.string().required().description('Start date (ISO 8601 or "now")'),
    to: validator
      .string()
      .optional()
      .description('End date (ISO 8601 or "now") — for counting business days between two dates'),
    add_days: validator
      .number()
      .optional()
      .description('Instead of "to": number of business days to add (negative to subtract)'),
    timezone: validator.string().optional().description('IANA timezone (optional, defaults UTC)'),
  }),
  handler: async (args) => {
    const {
      from: fromStr,
      to: toStr,
      add_days: addDays,
      timezone,
    } = args as {
      from: string
      to?: string
      add_days?: number
      timezone?: string
    }
    const { zone, error: zoneError } = resolveZone(timezone)
    if (zoneError) return `Error: ${zoneError}`

    const fromDt = (
      fromStr.toLowerCase() === 'now' ? DateTime.now() : DateTime.fromISO(fromStr)
    ).setZone(zone)
    if (!fromDt.isValid) return `Error: Invalid from date "${fromStr}".`

    if (addDays !== undefined) {
      const n = Math.floor(addDays)
      let cursor = fromDt.startOf('day')
      let remaining = Math.abs(n)
      const dir = n >= 0 ? 1 : -1
      while (remaining > 0) {
        cursor = cursor.plus({ days: dir })
        if (cursor.weekday <= 5) remaining--
      }
      return `${n >= 0 ? '+' : ''}${n} business day${Math.abs(n) !== 1 ? 's' : ''} from ${fromStr}: ${cursor.toISODate()}\nFormatted: ${cursor.toFormat('cccc, LLLL d, yyyy')}`
    }

    if (!toStr) return 'Error: Provide either "to" date or "add_days".'

    const toDt = (toStr.toLowerCase() === 'now' ? DateTime.now() : DateTime.fromISO(toStr)).setZone(
      zone
    )
    if (!toDt.isValid) return `Error: Invalid to date "${toStr}".`

    const count = countBusinessDays(fromDt, toDt)
    return `Business days from ${fromStr} to ${toStr}: ${count}`
  },
})
