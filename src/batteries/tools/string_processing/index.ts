/**
 * Pre-constructed tools for casing, trimming, normalizing, and transforming strings.
 *
 * @module @nhtio/adk/batteries/tools/string_processing
 *
 * @remarks
 * Pre-constructed bundled tools for the `string_processing` category. Import individually, the whole
 * category, or import every tool via `@nhtio/adk/batteries`.
 */

import { Tool } from '@nhtio/adk/common'
import { isError } from '@nhtio/adk/guards'
import { validator } from '@nhtio/validation'
import { camelCase, capitalCase, kebabCase, pascalCase, snakeCase, trainCase } from 'case-anything'

type StringOp =
  | { op: 'uppercase' }
  | { op: 'lowercase' }
  | { op: 'titlecase' }
  | { op: 'sentence_case' }
  | { op: 'capitalize' }
  | { op: 'camel_case' }
  | { op: 'pascal_case' }
  | { op: 'snake_case' }
  | { op: 'kebab_case' }
  | { op: 'train_case' }
  | { op: 'constant_case' }
  | { op: 'trim' }
  | { op: 'trim_start' }
  | { op: 'trim_end' }
  | { op: 'normalize_whitespace' }
  | { op: 'reverse' }
  | { op: 'slug' }
  | { op: 'strip_html' }
  | { op: 'count_words' }
  | { op: 'count_chars' }
  | { op: 'count_lines' }
  | { op: 'repeat'; count: number }
  | { op: 'pad_start'; length: number; char?: string }
  | { op: 'pad_end'; length: number; char?: string }
  | { op: 'slice'; start: number; end?: number }
  | { op: 'truncate'; length: number; suffix?: string }
  | { op: 'replace'; from: string; to: string }
  | { op: 'replace_all'; from: string; to: string }
  | { op: 'regex_replace'; pattern: string; replacement: string; flags?: string }
  | { op: 'split'; delimiter: string }
  | { op: 'indent'; size?: number; char?: string }
  | { op: 'dedent' }

function applyStringOp(text: string, op: StringOp): string | number | string[] {
  switch (op.op) {
    case 'uppercase':
      return text.toUpperCase()
    case 'lowercase':
      return text.toLowerCase()
    case 'capitalize':
      return text.charAt(0).toUpperCase() + text.slice(1)
    case 'titlecase':
      return capitalCase(text)
    case 'sentence_case':
      return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase()
    case 'camel_case':
      return camelCase(text)
    case 'pascal_case':
      return pascalCase(text)
    case 'snake_case':
      return snakeCase(text)
    case 'kebab_case':
      return kebabCase(text)
    case 'train_case':
      return trainCase(text)
    case 'constant_case':
      return snakeCase(text).toUpperCase()
    case 'trim':
      return text.trim()
    case 'trim_start':
      return text.trimStart()
    case 'trim_end':
      return text.trimEnd()
    case 'normalize_whitespace':
      return text.replace(/\s+/g, ' ').trim()
    case 'reverse':
      // Iterate by code point ([...text]), not UTF-16 code unit, so astral characters / emoji
      // (surrogate pairs) are not split into broken halves. 'A\ud83d\udca5B' \u2192 'B\ud83d\udca5A'.
      return [...text].reverse().join('')
    case 'slug':
      return (
        text
          .toLowerCase()
          // Transliterate common Latin-1 letters/ligatures that do NOT decompose under NFD, so they
          // survive the a-z0-9 filter instead of becoming hyphens (e.g. 'f\u00f8tex' \u2192 'fotex', not 'f-tex').
          .replace(/\u00df/g, 'ss')
          .replace(/\u00e6/g, 'ae')
          .replace(/\u0153/g, 'oe')
          .replace(/\u00f8/g, 'o')
          .replace(/\u0111/g, 'd')
          .replace(/\u0142/g, 'l')
          .replace(/\u00fe/g, 'th')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
      )
    case 'strip_html':
      return text.replace(/<[^>]*>/g, '')
    case 'count_words':
      return text.trim() === '' ? 0 : text.trim().split(/\s+/).length
    case 'count_chars':
      return text.length
    case 'count_lines':
      return text === '' ? 0 : text.split('\n').length
    case 'repeat':
      return text.repeat(Math.max(0, Math.min(100, Math.floor(op.count))))
    case 'pad_start':
      return text.padStart(op.length, op.char ?? ' ')
    case 'pad_end':
      return text.padEnd(op.length, op.char ?? ' ')
    case 'slice':
      return text.slice(op.start, op.end)
    case 'truncate': {
      const suffix = op.suffix ?? '…'
      if (text.length <= op.length) return text
      return text.slice(0, Math.max(0, op.length - suffix.length)) + suffix
    }
    case 'replace':
      return text.replace(op.from, op.to)
    case 'replace_all':
      return text.split(op.from).join(op.to)
    case 'regex_replace': {
      const flags = (op.flags ?? 'g').replace(/[^gimsuy]/g, '')
      let re: RegExp
      try {
        re = new RegExp(op.pattern, flags)
      } catch (e) {
        throw new Error(`Invalid regex: ${isError(e) ? e.message : String(e)}`)
      }
      return text.replace(re, op.replacement)
    }
    case 'split':
      return text.split(op.delimiter)
    case 'indent': {
      const size = op.size ?? 2
      const ch = op.char ?? ' '
      const pad = ch.repeat(size)
      return text
        .split('\n')
        .map((l) => (l === '' ? l : pad + l))
        .join('\n')
    }
    case 'dedent': {
      const lines = text.split('\n')
      const nonEmpty = lines.filter((l) => l.trim() !== '')
      if (nonEmpty.length === 0) return text
      const minIndent = Math.min(...nonEmpty.map((l) => l.match(/^(\s*)/)?.[1].length ?? 0))
      return lines.map((l) => l.slice(minIndent)).join('\n')
    }
    default:
      throw new Error(`Unknown operation: ${(op as { op: string }).op}`)
  }
}

/**
 * Apply an ordered pipeline of string transformations.
 *
 * @remarks
 * Each operation reads the previous step's output. Most operations return strings; `count_*`
 * return numbers and `split` returns an array — once a non-string flows through, subsequent
 * operations report an error rather than coercing. The result is always serialised to a string
 * (arrays become JSON; numbers/booleans are stringified).
 */
export const stringTransformTool = new Tool({
  name: 'string_transform',
  description:
    'Apply one or more string transformations in sequence. Supports case conversion (camelCase, snake_case, kebab-case, etc.), trimming, truncation, replacement, splitting, indentation, and more.',
  inputSchema: validator.object({
    text: validator.string().required().allow('').description('Input string to transform'),
    operations: validator
      .array()
      .items(validator.object().unknown(true))
      .required()
      .description('Ordered list of operations to apply. Each operation has an "op" field.'),
  }),
  handler: async (args) => {
    const { text, operations } = args as { text: string; operations: StringOp[] }
    let current: string | number | string[] = text

    for (const [i, op] of operations.entries()) {
      if (typeof current !== 'string') {
        return `Error: Operation ${i + 1} ("${op.op}") requires a string input, but the previous operation returned ${Array.isArray(current) ? 'an array' : typeof current}.`
      }
      try {
        current = applyStringOp(current, op)
      } catch (err) {
        return `Error in operation ${i + 1} ("${op.op}"): ${isError(err) ? err.message : String(err)}`
      }
    }

    if (Array.isArray(current)) return JSON.stringify(current)
    return String(current)
  },
})

/**
 * Extract all matches of a regular expression from a string.
 *
 * @remarks
 * The `g` flag is always enabled. `group` selects which capture group to return per match (0 =
 * full match). Output is at most 500 matches; if truncated, the suffix `(truncated at 500)` is
 * appended.
 */
export const stringExtractTool = new Tool({
  name: 'string_extract',
  description:
    'Extract all matches of a regex pattern from text. Returns a JSON array of matched strings. Use capture groups to pull out specific parts.',
  inputSchema: validator.object({
    text: validator.string().required().allow('').description('Input text to search'),
    pattern: validator
      .string()
      .required()
      .description('Regular expression pattern (no surrounding slashes)'),
    flags: validator
      .string()
      .default('g')
      .description('Regex flags (default: "g"). "g" is always included.'),
    group: validator
      .number()
      .default(0)
      .description('Capture group index to return (0 = full match, 1 = first group). Default: 0.'),
  }),
  handler: async (args) => {
    const {
      text,
      pattern,
      flags: rawFlags,
      group,
    } = args as {
      text: string
      pattern: string
      flags: string
      group: number
    }
    const flags = rawFlags.replace(/[^gimsuy]/g, '')
    const flagsWithG = flags.includes('g') ? flags : flags + 'g'

    let regex: RegExp
    try {
      regex = new RegExp(pattern, flagsWithG)
    } catch (err) {
      return `Error: Invalid regex — ${isError(err) ? err.message : String(err)}`
    }

    const matches: string[] = []
    let match: RegExpExecArray | null
    const MAX_MATCHES = 500

    while ((match = regex.exec(text)) !== null && matches.length < MAX_MATCHES) {
      const value = match[group]
      if (value !== undefined) matches.push(value)
      if (match.index === regex.lastIndex) regex.lastIndex++
    }

    if (matches.length === 0) return 'No matches found.'
    const truncated = matches.length === MAX_MATCHES ? ' (truncated at 500)' : ''
    return JSON.stringify(matches) + truncated
  },
})
