/**
 * Pre-constructed tools for ISO datetime arithmetic, differences, and timezone-aware formatting.
 *
 * @module @nhtio/adk/batteries/tools/datetime_math
 *
 * @remarks
 * Pre-constructed bundled tools for the `datetime_math` category. Import individually, the whole
 * category, or import every tool via `@nhtio/adk/batteries`.
 */

import { Tool } from '@nhtio/adk/common'
import { validator } from '@nhtio/validation'
import { DateTime, Duration, IANAZone } from 'luxon'

function resolveZone(timezone: string | undefined): { zone: string; error?: string } {
  if (!timezone) return { zone: 'UTC' }
  if (!IANAZone.isValidZone(timezone)) return { zone: '', error: `Invalid timezone "${timezone}".` }
  return { zone: timezone }
}

function parseDate(input: string, zone: string): DateTime | { error: string } {
  if (input.toLowerCase() === 'now') return DateTime.now().setZone(zone)
  const dt = DateTime.fromISO(input, { zone })
  if (!dt.isValid)
    return {
      error: `Invalid date "${input}". Use ISO 8601 format (e.g. "2025-06-15" or "2025-06-15T14:30:00") or "now".`,
    }
  return dt
}

/**
 * Add or subtract a duration from a date/time.
 *
 * @remarks
 * All duration components (years/months/weeks/days/hours/minutes/seconds) are optional and
 * combined into a single Duration. Output formatting includes a time component when the input
 * itself has one or when any sub-day component is non-zero.
 */
export const dateAddTool = new Tool({
  name: 'date_add',
  description:
    'Add or subtract a duration from a date/time. Useful for "what date is 90 days from now?" or "when was 6 months before X?"',
  inputSchema: validator.object({
    date: validator.string().required().description('ISO 8601 date/datetime string or "now"'),
    direction: validator
      .string()
      .valid('add', 'subtract')
      .required()
      .description('"add" to move forward in time, "subtract" to move backward'),
    years: validator.number().default(0).description('Years component (optional)'),
    months: validator.number().default(0).description('Months component (optional)'),
    weeks: validator.number().default(0).description('Weeks component (optional)'),
    days: validator.number().default(0).description('Days component (optional)'),
    hours: validator.number().default(0).description('Hours component (optional)'),
    minutes: validator.number().default(0).description('Minutes component (optional)'),
    seconds: validator.number().default(0).description('Seconds component (optional)'),
    timezone: validator
      .string()
      .optional()
      .allow('')
      .description(
        'IANA timezone for interpreting the date. Omit or send an empty string to use UTC.'
      ),
  }),
  handler: async (args) => {
    const { date, direction, years, months, weeks, days, hours, minutes, seconds, timezone } =
      args as {
        date: string
        direction: 'add' | 'subtract'
        years: number
        months: number
        weeks: number
        days: number
        hours: number
        minutes: number
        seconds: number
        timezone?: string
      }
    const { zone, error: zoneError } = resolveZone(timezone)
    if (zoneError) return `Error: ${zoneError}`

    const parsed = parseDate(date, zone)
    if ('error' in parsed) return `Error: ${parsed.error}`

    const durObj = { years, months, weeks, days, hours, minutes, seconds }
    const dur = Duration.fromObject(durObj)
    const result = direction === 'subtract' ? parsed.minus(dur) : parsed.plus(dur)

    const inputHasTime = date.includes('T') || date.toLowerCase() === 'now'
    const durationHasTime = durObj.hours !== 0 || durObj.minutes !== 0 || durObj.seconds !== 0
    const showTime = inputHasTime || durationHasTime

    const formatted = showTime
      ? result.toFormat("cccc, LLLL d, yyyy 'at' h:mm:ss a ZZZZ")
      : result.toFormat('cccc, LLLL d, yyyy')

    const durParts = Object.entries(durObj)
      .filter(([, v]) => v !== 0)
      .map(([k, v]) => `${v} ${k}`)
      .join(', ')

    const verb = direction === 'subtract' ? 'Subtracting' : 'Adding'
    const prep = direction === 'subtract' ? 'from' : 'to'
    return `${verb} ${durParts || '0'} ${prep} ${date}: ${formatted}`
  },
})

/**
 * Calculate the difference between two dates/times in a chosen unit.
 *
 * @remarks
 * Result is signed — positive when `to` is after `from`, negative otherwise — but rendered as
 * `|value| <unit> after/before` for readability. Uses luxon's `diff().as(unit)` which respects
 * calendar arithmetic for months/years.
 */
export const dateDiffTool = new Tool({
  name: 'date_diff',
  description:
    'Calculate the difference between two dates/times in a specified unit. Useful for "how many days until X?" or "how long ago was Y?"',
  inputSchema: validator.object({
    from: validator.string().required().description('Start date (ISO 8601 or "now")'),
    to: validator.string().required().description('End date (ISO 8601 or "now")'),
    unit: validator
      .string()
      .valid('years', 'months', 'weeks', 'days', 'hours', 'minutes', 'seconds')
      .required()
      .description('Unit to express the difference in'),
    timezone: validator
      .string()
      .optional()
      .allow('')
      .description(
        'IANA timezone for interpreting dates. Omit or send an empty string to use UTC.'
      ),
  }),
  handler: async (args) => {
    const { from, to, unit, timezone } = args as {
      from: string
      to: string
      unit: 'years' | 'months' | 'weeks' | 'days' | 'hours' | 'minutes' | 'seconds'
      timezone?: string
    }
    const { zone, error: zoneError } = resolveZone(timezone)
    if (zoneError) return `Error: ${zoneError}`

    const fromParsed = parseDate(from, zone)
    if ('error' in fromParsed) return `Error: ${fromParsed.error}`

    const toParsed = parseDate(to, zone)
    if ('error' in toParsed) return `Error: ${toParsed.error}`

    const diff = toParsed.diff(fromParsed, unit)
    const value = diff.as(unit)
    const rounded = Number.parseFloat(value.toFixed(4))
    const abs = Math.abs(rounded)
    const direction = value >= 0 ? 'after' : 'before'

    return `${to} is ${abs} ${unit} ${direction} ${from}`
  },
})

/**
 * Convert total seconds into a human-readable duration string.
 *
 * @remarks
 * Examples: `3725` → `1 hour, 2 minutes and 5 seconds`. Negative inputs are prefixed with `-`.
 * Zero seconds returns the literal `0 seconds`.
 */
export const durationFormatTool = new Tool({
  name: 'duration_format',
  description:
    'Convert a total number of seconds into a human-readable duration breakdown (e.g. "2 hours, 15 minutes and 30 seconds").',
  inputSchema: validator.object({
    seconds: validator.number().required().description('Total number of seconds (may be negative)'),
  }),
  handler: async (args) => {
    const { seconds: totalSeconds } = args as { seconds: number }
    const sign = totalSeconds < 0 ? '-' : ''
    const absSeconds = Math.abs(totalSeconds)

    const dur = Duration.fromObject({ seconds: absSeconds }).shiftTo(
      'years',
      'months',
      'weeks',
      'days',
      'hours',
      'minutes',
      'seconds'
    )
    const obj = dur.toObject()

    const units: Array<[keyof typeof obj, string, string]> = [
      ['years', 'year', 'years'],
      ['months', 'month', 'months'],
      ['weeks', 'week', 'weeks'],
      ['days', 'day', 'days'],
      ['hours', 'hour', 'hours'],
      ['minutes', 'minute', 'minutes'],
      ['seconds', 'second', 'seconds'],
    ]

    const parts: string[] = []
    for (const [key, singular, plural] of units) {
      const v = Math.floor(obj[key] ?? 0)
      if (v > 0) parts.push(`${v} ${v === 1 ? singular : plural}`)
    }

    if (parts.length === 0) return '0 seconds'
    const formatted =
      parts.length === 1
        ? parts[0]
        : parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1]
    return `${sign}${formatted}`
  },
})
