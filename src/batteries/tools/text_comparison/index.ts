/**
 * Pre-constructed tools for text diffs, similarity checks, and edit-distance comparisons.
 *
 * @module @nhtio/adk/batteries/tools/text_comparison
 *
 * @remarks
 * Pre-constructed bundled tools for the `text_comparison` category. Import individually, the whole
 * category, or import every tool via `@nhtio/adk/batteries`.
 */

import { Tool } from '@nhtio/adk/common'
import { diffLines, diffWords } from 'diff'
import { validator } from '@nhtio/validation'
import { distance } from 'fastest-levenshtein'

/**
 * Compare two texts and emit a unified-style diff plus an additions/removals summary.
 *
 * @remarks
 * `mode: 'lines'` (default) compares line-by-line; `mode: 'words'` compares word-by-word. The
 * output is clipped at 60 diff lines — the suffix `… (N more lines truncated)` is appended if
 * the diff is larger. Identical inputs short-circuit with `Texts are identical`.
 */
export const textDiffTool = new Tool({
  name: 'text_diff',
  description:
    'Compare two texts and show what changed. Returns a summary of additions, deletions, and a unified-style diff.',
  inputSchema: validator.object({
    text_a: validator.string().required().allow('').description('Original text (before)'),
    text_b: validator.string().required().allow('').description('New text (after)'),
    mode: validator
      .string()
      .valid('lines', 'words')
      .default('lines')
      .description('Compare line-by-line or word-by-word (default: lines)'),
  }),
  handler: async (args) => {
    const {
      text_a: a,
      text_b: b,
      mode,
    } = args as {
      text_a: string
      text_b: string
      mode: 'lines' | 'words'
    }

    if (a === b) return 'Texts are identical — no differences found.'

    const changes = mode === 'words' ? diffWords(a, b) : diffLines(a, b)

    let added = 0
    let removed = 0
    let unchanged = 0
    const diffOutput: string[] = []

    for (const part of changes) {
      const unit = mode === 'words' ? (part.value.match(/\S+/g) ?? []).length : (part.count ?? 1)
      if (part.added) {
        added += unit
        for (const line of part.value.split('\n').filter((l) => l !== '' || mode === 'words')) {
          if (line !== '') diffOutput.push(`+ ${line}`)
        }
      } else if (part.removed) {
        removed += unit
        for (const line of part.value.split('\n').filter((l) => l !== '' || mode === 'words')) {
          if (line !== '') diffOutput.push(`- ${line}`)
        }
      } else {
        unchanged += unit
      }
    }

    const unit = mode === 'lines' ? 'line' : 'word'
    const summary = `+${added} ${unit}${added !== 1 ? 's' : ''} added, -${removed} ${unit}${removed !== 1 ? 's' : ''} removed, ${unchanged} unchanged`

    const MAX_DIFF_LINES = 60
    const truncated =
      diffOutput.length > MAX_DIFF_LINES
        ? `\n… (${diffOutput.length - MAX_DIFF_LINES} more lines truncated)`
        : ''
    return [summary, '', ...diffOutput.slice(0, MAX_DIFF_LINES)].join('\n') + truncated
  },
})

/**
 * Report the Levenshtein edit distance and a similarity percentage between two strings.
 *
 * @remarks
 * Useful for fuzzy matching. The percentage is `(1 - distance / max(len_a, len_b)) * 100`, with
 * a human-readable label appended (`identical` / `very similar` / `similar` / `somewhat
 * similar` / `different` / `very different`).
 */
export const stringSimilarityTool = new Tool({
  name: 'string_similarity',
  description:
    'Calculate edit distance and similarity percentage between two strings using Levenshtein distance. Useful for fuzzy matching.',
  inputSchema: validator.object({
    a: validator.string().required().allow('').description('First string'),
    b: validator.string().required().allow('').description('Second string'),
    case_insensitive: validator
      .boolean()
      .default(false)
      .description('Ignore case when comparing (default: false)'),
  }),
  handler: async (args) => {
    let { a, b } = args as { a: string; b: string }
    const { case_insensitive: ci } = args as { case_insensitive: boolean }

    if (ci) {
      a = a.toLowerCase()
      b = b.toLowerCase()
    }

    const dist = distance(a, b)
    const maxLen = Math.max(a.length, b.length)
    const pct = maxLen === 0 ? 100 : Number.parseFloat(((1 - dist / maxLen) * 100).toFixed(1))

    const label =
      pct === 100
        ? 'identical'
        : pct >= 90
          ? 'very similar'
          : pct >= 70
            ? 'similar'
            : pct >= 50
              ? 'somewhat similar'
              : pct >= 30
                ? 'different'
                : 'very different'

    return `Edit distance: ${dist}\nSimilarity: ${pct}% (${label})`
  },
})
