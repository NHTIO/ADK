/**
 * Pre-constructed tools for transforming arrays and objects into tables and tabular text.
 *
 * @module @nhtio/adk/batteries/tools/structured_data
 *
 * @remarks
 * Pre-constructed bundled tools for the `structured_data` category. Import individually, the whole
 * category, or import every tool via `@nhtio/adk/batteries`.
 */

import { Tool } from '@nhtio/adk/common'
import { isError } from '@nhtio/adk/guards'
import { validator } from '@nhtio/validation'

function csvEscape(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value)
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"'
  }
  return str
}

function tsvEscape(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value)
  return str.replace(/\t/g, ' ').replace(/\r?\n/g, ' ')
}

function mdEscape(value: unknown): string {
  return String(value === null || value === undefined ? '' : value)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
}

/**
 * Convert a JSON array of objects into a formatted table.
 *
 * @remarks
 * Supports `markdown`, `csv`, and `tsv` output. Columns default to the keys of the first row;
 * supply `columns` to control which keys appear and in what order.
 */
export const formatTableTool = new Tool({
  name: 'format_table',
  description:
    'Convert a JSON array of objects into a formatted table. Supports Markdown, CSV, and TSV output.',
  inputSchema: validator.object({
    data: validator.string().required().description('JSON array of objects as a string'),
    format: validator
      .string()
      .valid('markdown', 'csv', 'tsv')
      .required()
      .description('Output format'),
    columns: validator
      .array()
      .items(validator.string())
      .optional()
      .description(
        'Column keys to include, in order. If omitted, all keys from the first row are used.'
      ),
  }),
  handler: async (args) => {
    const {
      data,
      format,
      columns: explicitColumns,
    } = args as {
      data: string
      format: 'markdown' | 'csv' | 'tsv'
      columns?: string[]
    }

    let rows: unknown[]
    try {
      rows = JSON.parse(data)
    } catch {
      return 'Error: Invalid JSON input.'
    }

    if (!Array.isArray(rows)) return 'Error: Input must be a JSON array.'
    if (rows.length === 0) return 'Empty array — no data to display.'

    const columns = explicitColumns ?? Object.keys(rows[0] as Record<string, unknown>)

    if (format === 'csv') {
      const lines = [columns.map(csvEscape).join(',')]
      for (const row of rows) {
        const obj = row as Record<string, unknown>
        lines.push(columns.map((col) => csvEscape(obj[col])).join(','))
      }
      return lines.join('\n')
    }

    if (format === 'tsv') {
      const lines = [columns.map(tsvEscape).join('\t')]
      for (const row of rows) {
        const obj = row as Record<string, unknown>
        lines.push(columns.map((col) => tsvEscape(obj[col])).join('\t'))
      }
      return lines.join('\n')
    }

    const header = '| ' + columns.map(mdEscape).join(' | ') + ' |'
    const separator = '| ' + columns.map(() => '---').join(' | ') + ' |'
    const dataRows = rows.map((row) => {
      const obj = row as Record<string, unknown>
      return '| ' + columns.map((col) => mdEscape(obj[col])).join(' | ') + ' |'
    })
    return [header, separator, ...dataRows].join('\n')
  },
})

/**
 * Pretty-print or minify a JSON string.
 *
 * @remarks
 * Validates the input as JSON, then re-serialises it with the requested indentation. `indent` is
 * clamped to the range [0, 8]; `0` produces minified output.
 */
export const jsonFormatTool = new Tool({
  name: 'json_format',
  description: 'Pretty-print or minify a JSON string. Validates JSON and normalises whitespace.',
  inputSchema: validator.object({
    data: validator.string().required().description('JSON string to format'),
    indent: validator
      .number()
      .default(2)
      .description('Indentation spaces (0 = minify, default: 2). Max: 8.'),
  }),
  handler: async (args) => {
    const { data, indent } = args as { data: string; indent: number }
    try {
      const parsed = JSON.parse(data)
      return JSON.stringify(parsed, null, Math.max(0, Math.min(8, Math.floor(indent))))
    } catch (err) {
      return `Error: Invalid JSON — ${isError(err) ? err.message : String(err)}`
    }
  },
})

const FORMAT_PATTERNS: Record<string, { pattern: RegExp; label: string }> = {
  email: {
    pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    label: 'email address',
  },
  uuid: {
    pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    label: 'UUID (v1–v5)',
  },
  ipv4: {
    pattern: /^((25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(25[0-5]|2[0-4]\d|[01]?\d\d?)$/,
    label: 'IPv4 address',
  },
  iso_date: {
    pattern: /^\d{4}-\d{2}-\d{2}$/,
    label: 'ISO 8601 date (YYYY-MM-DD)',
  },
  iso_datetime: {
    pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/,
    label: 'ISO 8601 datetime',
  },
  hex_color: {
    pattern: /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/,
    label: 'CSS hex color',
  },
  phone_e164: {
    pattern: /^\+[1-9]\d{1,14}$/,
    label: 'E.164 phone number',
  },
  semver: {
    pattern: /^\d+\.\d+\.\d+(-[0-9A-Za-z-.]+)?(\+[0-9A-Za-z-.]+)?$/,
    label: 'Semantic Version (SemVer)',
  },
  integer: {
    pattern: /^-?\d+$/,
    label: 'integer',
  },
  decimal: {
    pattern: /^-?\d+(\.\d+)?$/,
    label: 'decimal number',
  },
  alphanumeric: {
    pattern: /^[a-zA-Z0-9]+$/,
    label: 'alphanumeric string',
  },
  slug: {
    pattern: /^[a-z0-9]+(-[a-z0-9]+)*$/,
    label: 'URL slug',
  },
  hex: {
    pattern: /^(0x)?[0-9a-fA-F]+$/,
    label: 'hexadecimal string',
  },
  base64: {
    pattern: /^[A-Za-z0-9+/]*={0,2}$/,
    label: 'base64-encoded string',
  },
}

/**
 * Check whether a string matches a known format.
 *
 * @remarks
 * Supported formats: `email`, `uuid` (v1–v5), `ipv4`, `iso_date`, `iso_datetime`, `hex_color`,
 * `phone_e164`, `semver`, `integer`, `decimal`, `alphanumeric`, `slug`, `hex`, `base64`.
 */
export const validateFormatTool = new Tool({
  name: 'validate_format',
  description:
    'Check whether a string matches a known format (email, UUID, ISO date, hex colour, phone number, semver, slug, etc.).',
  inputSchema: validator.object({
    value: validator.string().required().description('The string to validate'),
    format: validator
      .string()
      .valid(...Object.keys(FORMAT_PATTERNS))
      .required()
      .description(
        `Format to validate against. One of: ${Object.keys(FORMAT_PATTERNS).join(', ')}`
      ),
  }),
  handler: async (args) => {
    const { value, format } = args as { value: string; format: string }
    const def = FORMAT_PATTERNS[format]
    if (!def) {
      return `Error: Unknown format "${format}". Supported: ${Object.keys(FORMAT_PATTERNS).join(', ')}`
    }
    const valid = def.pattern.test(value)
    return valid
      ? `Valid: "${value}" is a valid ${def.label}.`
      : `Invalid: "${value}" is not a valid ${def.label}.`
  },
})
