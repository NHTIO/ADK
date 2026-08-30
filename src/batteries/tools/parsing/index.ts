/**
 * Pre-constructed tools for parsing CSV, TSV, JSON, YAML, and other structured text formats.
 *
 * @module @nhtio/adk/batteries/tools/parsing
 *
 * @remarks
 * Pre-constructed bundled tools for the `parsing` category. Import individually, the whole
 * category, or import every tool via `@nhtio/adk/batteries`.
 */

import { load as parseYaml } from 'js-yaml'
import { default as Papa } from 'papaparse'
import { isError } from '@nhtio/adk/guards'
import { validator } from '@nhtio/validation'
import { Tool, SpooledJsonArtifact } from '@nhtio/adk/common'

/**
 * Parse a CSV or TSV string into a JSON array.
 *
 * @remarks
 * With `has_header: true` (default), each row becomes an object keyed by column name. Without a
 * header, rows are returned as positional arrays. `delimiter` auto-detects when omitted; pass
 * `"\t"` for TSV. Rows are clipped to `limit` (default 1000, max 10000). Parse warnings are
 * prepended to the output.
 */
export const parseCsvTool = new Tool({
  name: 'parse_csv',
  description:
    'Parse a CSV or TSV string into a JSON array. With a header row, returns objects keyed by column name. Without, returns arrays of values.',
  inputSchema: validator.object({
    text: validator.string().required().description('CSV or TSV text to parse'),
    has_header: validator
      .boolean()
      .default(true)
      .description('First row is a header row (default: true)'),
    delimiter: validator
      .string()
      .default('')
      .allow('')
      .description(
        'Field delimiter — auto-detected when omitted or sent as an empty string. Use "\\t" for TSV.'
      ),
    limit: validator.number().default(1000).description('Maximum rows to return (default: 1000)'),
  }),
  artifactConstructor: () => SpooledJsonArtifact,
  handler: async (args) => {
    const {
      text,
      has_header: hasHeader,
      delimiter,
      limit: rawLimit,
    } = args as {
      text: string
      has_header: boolean
      delimiter: string
      limit: number
    }
    const limit = Math.min(10_000, Math.max(1, Math.floor(rawLimit)))

    try {
      const result = Papa.parse<unknown>(text.trim(), {
        header: hasHeader,
        delimiter: delimiter || undefined,
        skipEmptyLines: true,
        dynamicTyping: true,
      })

      const rows = (result.data as unknown[]).slice(0, limit)
      const warnings =
        result.errors.length > 0
          ? `Parse warnings: ${result.errors
              .slice(0, 3)
              .map((e) => e.message)
              .join('; ')}\n\n`
          : ''
      const truncated =
        result.data.length > limit ? `\n\n(Showing ${limit} of ${result.data.length} rows)` : ''

      return warnings + JSON.stringify(rows, null, 2) + truncated
    } catch (err) {
      return `Error: ${isError(err) ? err.message : String(err)}`
    }
  },
})

/**
 * Parse a YAML string into JSON.
 *
 * @remarks
 * Returns a pretty-printed JSON representation of the parsed YAML document. Invalid YAML
 * returns an error string.
 */
export const parseYamlTool = new Tool({
  name: 'parse_yaml',
  description: 'Parse a YAML string and return the equivalent JSON.',
  inputSchema: validator.object({
    text: validator.string().required().description('YAML text to parse'),
  }),
  artifactConstructor: () => SpooledJsonArtifact,
  handler: async (args) => {
    const { text } = args as { text: string }
    try {
      const parsed = parseYaml(text)
      // An empty / whitespace-only / BOM-only document parses to `undefined`, and
      // `JSON.stringify(undefined)` returns the JS value `undefined` (not a string), breaking the
      // tool's string-return contract. Normalise that empty document to JSON `null`.
      if (parsed === undefined) return 'null'
      // YAML permits .NaN / .inf / -.inf, which `JSON.stringify` would silently turn into `null`,
      // losing the value. Render non-finite numbers as their YAML token strings so the information
      // survives the JSON round-trip instead of being corrupted to null.
      return JSON.stringify(
        parsed,
        (_key, value) => {
          if (typeof value === 'number' && !Number.isFinite(value)) {
            return Number.isNaN(value) ? '.NaN' : value > 0 ? '.inf' : '-.inf'
          }
          return value
        },
        2
      )
    } catch (err) {
      return `Error: Invalid YAML — ${isError(err) ? err.message : String(err)}`
    }
  },
})

/**
 * Extract key-value pairs from text.
 *
 * @remarks
 * Handles `.env` files, config files, and query strings. `kv_delimiter` chooses the
 * key→value separator (`=`, `:`, or `auto`); `pair_delimiter` selects how pairs are separated
 * (`newline`, `comma`, `semicolon`, `ampersand`). Surrounding single or double quotes around
 * values are stripped. Comment lines starting with `#` are skipped by default.
 */
export const parseKvTool = new Tool({
  name: 'parse_kv',
  description:
    'Extract key-value pairs from text (e.g. .env files, config files, query strings). Returns a JSON object.',
  inputSchema: validator.object({
    text: validator.string().required().description('Text containing key-value pairs'),
    kv_delimiter: validator
      .string()
      .valid('=', ':', 'auto')
      .default('auto')
      .description('Separator between key and value (default: auto-detect)'),
    pair_delimiter: validator
      .string()
      .valid('newline', 'comma', 'semicolon', 'ampersand')
      .default('newline')
      .description('Separator between pairs (default: newline)'),
    skip_comments: validator
      .boolean()
      .default(true)
      .description('Skip lines starting with # (default: true)'),
  }),
  artifactConstructor: () => SpooledJsonArtifact,
  handler: async (args) => {
    const {
      text,
      kv_delimiter: kvDelim,
      pair_delimiter: pairDelimKey,
      skip_comments: skipComments,
    } = args as {
      text: string
      kv_delimiter: string
      pair_delimiter: string
      skip_comments: boolean
    }

    const pairDelimMap: Record<string, string> = {
      newline: '\n',
      comma: ',',
      semicolon: ';',
      ampersand: '&',
    }
    const pairDelim = pairDelimMap[pairDelimKey] ?? '\n'

    const result: Record<string, string> = {}

    for (const raw of text.split(pairDelim)) {
      const line = raw.trim()
      if (line === '') continue
      if (skipComments && line.startsWith('#')) continue

      const delim =
        kvDelim === 'auto' ? (line.includes('=') ? '=' : line.includes(':') ? ':' : null) : kvDelim
      if (!delim) continue

      const sepIdx = line.indexOf(delim)
      if (sepIdx === -1) continue

      const key = line.slice(0, sepIdx).trim()
      let value = line.slice(sepIdx + delim.length).trim()

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }

      if (key) result[key] = value
    }

    return JSON.stringify(result, null, 2)
  },
})

/**
 * Detect the most likely field delimiter in a CSV-like text sample.
 *
 * @remarks
 * Tries comma, tab, semicolon, pipe, and colon. Scores each by mean field count divided by
 * variance (so consistent row widths beat noisy splits). Looks at up to the first 20 lines of
 * the first 5000 characters.
 */
export const detectDelimiterTool = new Tool({
  name: 'detect_delimiter',
  description: 'Detect the most likely field delimiter in a CSV-like text sample.',
  inputSchema: validator.object({
    text: validator.string().required().description('Sample of the delimited text to analyze'),
  }),
  handler: async (args) => {
    const { text } = args as { text: string }
    const sample = text.slice(0, 5000)
    const lines = sample
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .slice(0, 20)

    if (lines.length === 0) return 'Error: No lines to analyze.'

    const candidates: Array<{ delim: string; name: string }> = [
      { delim: ',', name: 'comma' },
      { delim: '\t', name: 'tab' },
      { delim: ';', name: 'semicolon' },
      { delim: '|', name: 'pipe' },
      { delim: ':', name: 'colon' },
    ]

    let best = { name: 'comma', delim: ',', score: -1, avgFields: 0 }

    for (const { delim, name } of candidates) {
      const counts = lines.map((l) => l.split(delim).length - 1)
      const avg = counts.reduce((a, b) => a + b, 0) / counts.length
      if (avg === 0) continue
      const fieldVariance = counts.reduce((a, b) => a + (b - avg) ** 2, 0) / counts.length
      const score = avg / (1 + fieldVariance)
      if (score > best.score) {
        best = { name, delim, score, avgFields: Number.parseFloat((avg + 1).toFixed(1)) }
      }
    }

    return `Detected delimiter: ${best.name} ("${best.delim === '\t' ? '\\t' : best.delim}") — ~${best.avgFields} fields per row`
  },
})
