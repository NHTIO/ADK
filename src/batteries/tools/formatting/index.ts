/**
 * Pre-constructed tools for locale-aware number, list, table, and text formatting.
 *
 * @module @nhtio/adk/batteries/tools/formatting
 *
 * @remarks
 * Pre-constructed bundled tools for the `formatting` category. Import individually, the whole
 * category, or import every tool via `@nhtio/adk/batteries`.
 */

import { Tool } from '@nhtio/adk/common'
import { isError } from '@nhtio/adk/guards'
import { validator } from '@nhtio/validation'

/**
 * Format a number using locale-aware styles.
 *
 * @remarks
 * Supported styles: `decimal`, `currency`, `percent`, `compact` (e.g. `1.2K`), `scientific`
 * (e.g. `1.2e+3`), and `ordinal` (`1st`, `2nd`, `3rd`). Uses `Intl.NumberFormat` and
 * `Intl.PluralRules` from the JS standard library. Returns an error string for non-finite values
 * or invalid currency-without-currency-code.
 */
export const formatNumberTool = new Tool({
  name: 'format_number',
  description:
    'Format a number using locale-aware styles: decimal, currency, percent, compact (1.2K), scientific (1.2e3), or ordinal (1st/2nd/3rd). Supports locale and precision options.',
  inputSchema: validator.object({
    value: validator.number().required().description('The number to format'),
    style: validator
      .string()
      .valid('decimal', 'currency', 'percent', 'compact', 'scientific', 'ordinal')
      .default('decimal')
      .description('Formatting style (default: decimal)'),
    currency: validator
      .string()
      .optional()
      .allow('')
      .description(
        'ISO 4217 currency code — required when style is "currency" (e.g. "USD", "EUR"). An empty string is treated as not provided.'
      ),
    // eslint-disable-next-line adk/require-string-empty-disposition -- an empty locale is not a valid BCP 47 tag and should keep failing validation, unlike an omitted one which falls back to the default
    locale: validator.string().default('en-US').description('BCP 47 locale tag (default: "en-US")'),
    min_decimals: validator
      .number()
      .optional()
      .description('Minimum fraction digits (default: style-dependent)'),
    max_decimals: validator
      .number()
      .optional()
      .description('Maximum fraction digits (default: style-dependent)'),
  }),
  handler: async (args) => {
    const {
      value,
      style,
      locale,
      currency,
      min_decimals: minDec,
      max_decimals: maxDec,
    } = args as {
      value: number
      style: string
      locale: string
      currency?: string
      min_decimals?: number
      max_decimals?: number
    }

    if (!Number.isFinite(value)) return `Error: Value must be a finite number (got ${value}).`

    try {
      if (style === 'ordinal') {
        const pr = new Intl.PluralRules(locale, { type: 'ordinal' })
        const suffixes: Record<string, string> = { one: 'st', two: 'nd', few: 'rd', other: 'th' }
        const rule = pr.select(value)
        const suffix = suffixes[rule] ?? 'th'
        return `${new Intl.NumberFormat(locale).format(value)}${suffix}`
      }

      if (style === 'scientific') {
        const exp = value === 0 ? 0 : Math.floor(Math.log10(Math.abs(value)))
        const mantissa = value / Math.pow(10, exp)
        const mFormatted = new Intl.NumberFormat(locale, {
          minimumFractionDigits: minDec ?? 2,
          maximumFractionDigits: maxDec ?? 6,
        }).format(mantissa)
        return `${mFormatted}e${exp >= 0 ? '+' : ''}${exp}`
      }

      const opts: Intl.NumberFormatOptions = {}

      if (style === 'currency') {
        if (!currency) return 'Error: "currency" parameter is required when style is "currency".'
        opts.style = 'currency'
        opts.currency = currency.toUpperCase()
      } else if (style === 'percent') {
        opts.style = 'percent'
        opts.minimumFractionDigits = minDec ?? 1
        opts.maximumFractionDigits = maxDec ?? 2
      } else if (style === 'compact') {
        opts.notation = 'compact'
        opts.compactDisplay = 'short'
      } else {
        opts.style = 'decimal'
      }

      if (minDec !== undefined && style !== 'percent') opts.minimumFractionDigits = minDec
      if (maxDec !== undefined && style !== 'percent') opts.maximumFractionDigits = maxDec

      return new Intl.NumberFormat(locale, opts).format(value)
    } catch (err) {
      return `Error: ${isError(err) ? err.message : String(err)}`
    }
  },
})

/**
 * Format an array of items as a list.
 *
 * @remarks
 * Supported styles: `bullet` (`• item`), `numbered` (`1. item`), `inline_and`
 * (`a, b, and c`), `inline_or` (`a, b, or c`), `newline` (one per line).
 */
export const formatListTool = new Tool({
  name: 'format_list',
  description:
    'Format an array of items as a list. Styles: bullet (• item), numbered (1. item), inline_and ("a, b, and c"), inline_or ("a, b, or c"), newline (one per line).',
  inputSchema: validator.object({
    items: validator
      .array()
      .items(validator.string())
      .required()
      .description('Array of items to format'),
    style: validator
      .string()
      .valid('bullet', 'numbered', 'inline_and', 'inline_or', 'newline')
      .default('bullet')
      .description('List format style (default: bullet)'),
    indent: validator.number().default(0).description('Spaces to indent each item (default: 0)'),
  }),
  handler: async (args) => {
    const {
      items,
      style,
      indent: rawIndent,
    } = args as {
      items: string[]
      style: string
      indent: number
    }
    // Clamp indent to a sane maximum: an unbounded value reaches `' '.repeat(indent)` and throws
    // RangeError (Invalid string length). 100 spaces is far past any real formatting need.
    const indent = Math.min(100, Math.max(0, Math.floor(rawIndent)))
    const pad = ' '.repeat(indent)

    if (items.length === 0) return ''

    switch (style) {
      case 'bullet':
        return items.map((item) => `${pad}• ${item}`).join('\n')
      case 'numbered':
        return items.map((item, i) => `${pad}${i + 1}. ${item}`).join('\n')
      case 'newline':
        return items.map((item) => `${pad}${item}`).join('\n')
      case 'inline_and':
      case 'inline_or': {
        const conj = style === 'inline_and' ? 'and' : 'or'
        if (items.length === 1) return items[0]
        if (items.length === 2) return `${items[0]} ${conj} ${items[1]}`
        const last = items[items.length - 1]
        const rest = items.slice(0, -1)
        return `${rest.join(', ')}, ${conj} ${last}`
      }
      default:
        return `Error: Unknown style "${style}".`
    }
  },
})
