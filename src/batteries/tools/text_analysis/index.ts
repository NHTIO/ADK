/**
 * Pre-constructed tools for extracting counts, token estimates, and character statistics from text.
 *
 * @module @nhtio/adk/batteries/tools/text_analysis
 *
 * @remarks
 * Pre-constructed bundled tools for the `text_analysis` category. Import individually, the whole
 * category, or import every tool via `@nhtio/adk/batteries`.
 */

import { validator } from '@nhtio/validation'
import { Tool, SpooledJsonArtifact } from '@nhtio/adk/common'

/**
 * Analyze text and return statistics as a JSON document.
 *
 * @remarks
 * Reports character counts (with and without spaces), word/sentence/paragraph/line counts,
 * unique word count, average word length, a rough token estimate (4 chars/token), and a set
 * of character-class booleans (`is_all_alpha`, `is_all_ascii`, etc.).
 *
 * Output is JSON, so the artifact constructor is set to {@link @nhtio/adk!SpooledJsonArtifact} — consumer
 * code can read the result back as a parsed record without re-parsing.
 */
export const textAnalyzeTool = new Tool({
  name: 'text_analyze',
  description:
    'Analyze text and return statistics: character counts, word/sentence/paragraph/line counts, unique word count, average word length, token estimate, and character-set properties.',
  inputSchema: validator.object({
    text: validator.string().required().description('The text to analyze'),
  }),
  artifactConstructor: () => SpooledJsonArtifact,
  handler: async (args) => {
    const { text } = args as { text: string }

    const charCount = text.length
    const charCountNoSpaces = text.replace(/\s/g, '').length

    const words = text.trim() === '' ? [] : text.trim().split(/\s+/)
    const wordCount = words.length

    const sentenceMatches = text.match(/[.!?]+(?:\s|$)/g)
    const sentenceCount = sentenceMatches ? sentenceMatches.length : text.trim().length > 0 ? 1 : 0

    const paragraphs = text.split(/\n[ \t]*\n/).filter((p) => p.trim().length > 0)
    const paragraphCount = paragraphs.length || (text.trim().length > 0 ? 1 : 0)

    const lineCount = text === '' ? 0 : text.split('\n').length

    const tokenEstimate = Math.ceil(text.length / 4)

    const uniqueWords = new Set(
      words.map((w) => w.toLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean)
    )
    const uniqueWordCount = uniqueWords.size

    const totalWordLen = words.reduce((sum, w) => sum + w.length, 0)
    const avgWordLength =
      wordCount > 0 ? Number.parseFloat((totalWordLen / wordCount).toFixed(2)) : 0

    const isAllAlpha = text.trim().length > 0 && /^[a-zA-Z\s]*$/.test(text)
    const isAllNumeric = /^\d+$/.test(text.trim())
    const isAllAlphanumeric = text.trim().length > 0 && /^[a-zA-Z0-9\s]*$/.test(text)
    const isAllAscii = [...text].every((c) => c.charCodeAt(0) < 128)
    const isAllLowercase = text === text.toLowerCase() && /[a-z]/.test(text)
    const isAllUppercase = text === text.toUpperCase() && /[A-Z]/.test(text)

    return JSON.stringify(
      {
        char_count: charCount,
        char_count_no_spaces: charCountNoSpaces,
        word_count: wordCount,
        unique_word_count: uniqueWordCount,
        sentence_count: sentenceCount,
        paragraph_count: paragraphCount,
        line_count: lineCount,
        avg_word_length: avgWordLength,
        token_estimate: tokenEstimate,
        is_all_alpha: isAllAlpha,
        is_all_numeric: isAllNumeric,
        is_all_alphanumeric: isAllAlphanumeric,
        is_all_ascii: isAllAscii,
        is_all_lowercase: isAllLowercase,
        is_all_uppercase: isAllUppercase,
        has_unicode: !isAllAscii,
      },
      null,
      2
    )
  },
})

/**
 * Operate on text treated as a list of lines.
 *
 * @remarks
 * Operations: `sort`, `sort_desc`, `reverse`, `deduplicate`, `filter_empty`, `trim_each`,
 * `number` (prefix each line with `1.`, `2.`, …), `count`. Sort and deduplicate respect the
 * optional `case_insensitive` flag.
 */
export const textLinesTool = new Tool({
  name: 'text_lines',
  description:
    'Perform operations on text treated as a list of lines: sort, deduplicate, reverse, filter empty lines, trim each line, number each line, or count.',
  inputSchema: validator.object({
    text: validator.string().required().description('Multi-line text to process'),
    operation: validator
      .string()
      .valid(
        'sort',
        'sort_desc',
        'reverse',
        'deduplicate',
        'filter_empty',
        'trim_each',
        'number',
        'count'
      )
      .required()
      .description('Operation to apply to lines'),
    case_insensitive: validator
      .boolean()
      .default(false)
      .description('For sort / deduplicate: ignore case (default: false)'),
  }),
  handler: async (args) => {
    const {
      text,
      operation,
      case_insensitive: ci,
    } = args as {
      text: string
      operation: string
      case_insensitive: boolean
    }
    const lines = text.split('\n')

    switch (operation) {
      case 'sort':
        return [...lines]
          .sort((a, b) => (ci ? a.toLowerCase() : a).localeCompare(ci ? b.toLowerCase() : b))
          .join('\n')
      case 'sort_desc':
        return [...lines]
          .sort((a, b) => (ci ? b.toLowerCase() : b).localeCompare(ci ? a.toLowerCase() : a))
          .join('\n')
      case 'reverse':
        return [...lines].reverse().join('\n')
      case 'deduplicate': {
        const seen = new Set<string>()
        return lines
          .filter((line) => {
            const key = ci ? line.toLowerCase() : line
            if (seen.has(key)) return false
            seen.add(key)
            return true
          })
          .join('\n')
      }
      case 'filter_empty':
        return lines.filter((l) => l.trim() !== '').join('\n')
      case 'trim_each':
        return lines.map((l) => l.trim()).join('\n')
      case 'number':
        return lines.map((l, i) => `${i + 1}. ${l}`).join('\n')
      case 'count': {
        const nonEmpty = lines.filter((l) => l.trim() !== '').length
        return `${lines.length} lines (${nonEmpty} non-empty, ${lines.length - nonEmpty} empty)`
      }
      default:
        return `Error: Unknown operation "${operation}".`
    }
  },
})
