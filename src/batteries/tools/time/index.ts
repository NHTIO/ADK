/**
 * Pre-constructed tools for current time lookup and timezone-aware time formatting.
 *
 * @module @nhtio/adk/batteries/tools/time
 *
 * @remarks
 * Pre-constructed bundled tools for the `time` category. Import individually, the whole
 * category, or import every tool via `@nhtio/adk/batteries`.
 */

import { Tool } from '@nhtio/adk/common'
import { DateTime, IANAZone } from 'luxon'
import { validator } from '@nhtio/validation'

/**
 * Return the current time formatted in a given timezone.
 *
 * @remarks
 * `timezone` defaults to `UTC` when omitted. The ADK has no notion of a "user local"
 * timezone, so callers should pass an IANA zone (`America/New_York`, `Europe/London`, ...) for
 * non-UTC formatting.
 */
export const getCurrentTimeTool = new Tool({
  name: 'get_current_time',
  description: 'Get current time in an IANA timezone (defaults to UTC).',
  inputSchema: validator.object({
    timezone: validator
      .string()
      .default('UTC')
      .description('IANA timezone (optional, defaults UTC)'),
  }),
  handler: async (args) => {
    const { timezone } = args as { timezone: string }
    if (!IANAZone.isValidZone(timezone)) {
      return `Error: Invalid timezone "${timezone}".`
    }
    const now = DateTime.now().setZone(timezone)
    return `${timezone}: ${now.toFormat('cccc, LLLL d, yyyy h:mm:ss a ZZZZ')}`
  },
})

/**
 * Convert a wall-clock time between two IANA timezones.
 *
 * @remarks
 * `time` must be `HH:MM` in 24-hour format. `target_timezone` defaults to UTC. The conversion
 * uses today's date in the source zone to pick the correct DST offset.
 */
export const convertTimeTool = new Tool({
  name: 'convert_time',
  description: 'Convert time between timezones.',
  inputSchema: validator.object({
    source_timezone: validator.string().required().description('Source IANA timezone'),
    time: validator.string().required().description('HH:MM (24h)'),
    target_timezone: validator
      .string()
      .default('UTC')
      .description('Target IANA timezone (optional, defaults UTC)'),
  }),
  handler: async (args) => {
    const {
      source_timezone: sourceTimezone,
      time,
      target_timezone: targetTimezone,
    } = args as {
      source_timezone: string
      time: string
      target_timezone: string
    }

    if (!IANAZone.isValidZone(sourceTimezone)) {
      return `Error: Invalid source timezone "${sourceTimezone}".`
    }
    if (!IANAZone.isValidZone(targetTimezone)) {
      return `Error: Invalid target timezone "${targetTimezone}".`
    }

    const parsed = DateTime.fromFormat(time, 'HH:mm', { zone: sourceTimezone })
    if (!parsed.isValid) {
      return `Error: Invalid time "${time}". Use HH:MM.`
    }

    const converted = parsed.setZone(targetTimezone)
    return `${time} ${sourceTimezone} = ${converted.toFormat('HH:mm')} ${targetTimezone}`
  },
})
