/**
 * Pre-constructed tools for descriptive statistics, correlation, quantiles, and numeric summaries.
 *
 * @module @nhtio/adk/batteries/tools/statistics
 *
 * @remarks
 * Pre-constructed bundled tools for the `statistics` category. Import individually, the whole
 * category, or import every tool via `@nhtio/adk/batteries`.
 */

import { isError } from '@nhtio/adk/guards'
import { validator } from '@nhtio/validation'
import { Tool, SpooledJsonArtifact } from '@nhtio/adk/common'
import {
  bigSum,
  bigMean,
  formatBig,
  bigToNumber,
  DEFAULT_PRECISION,
} from '@nhtio/adk/lib/helpers/bignum'
import {
  equalIntervalBreaks,
  interquartileRange,
  max,
  mean,
  median,
  min,
  mode,
  quantile,
  sampleCorrelation,
  standardDeviation,
  sum,
  variance,
  zScore,
} from 'simple-statistics'

/**
 * Normalise the `numbers`/`x`/`y` input to a `number[]`.
 *
 * @remarks
 * The input schema is `validator.array().items(validator.number())`, which already rejects
 * `NaN`, `±Infinity`, and magnitudes `> Number.MAX_SAFE_INTEGER` before the handler runs — so by
 * the time a value reaches here it is a finite, in-range float64. This guard only enforces
 * non-emptiness (and defensively re-checks the array shape). It deliberately NO LONGER silently
 * drops non-finite entries: those can't arrive through the typed schema, and a silent filter hid
 * real input errors.
 */
function parseNumbers(input: unknown): number[] | { error: string } {
  if (!Array.isArray(input)) return { error: 'Input must be an array of numbers.' }
  if (input.length === 0) return { error: 'Array must contain at least one number.' }
  return input as number[]
}

/** Shared `precision` schema fragment (significant digits for numeric output, default 8). */
const precisionField = validator
  .number()
  .default(DEFAULT_PRECISION)
  .description(`Significant digits for numeric output (default: ${DEFAULT_PRECISION}).`)

/**
 * Compute descriptive statistics for a JSON array of numbers.
 *
 * @remarks
 * Returns count, sum, min/max/range, mean, median, mode, variance, standard deviation,
 * quartiles (Q1/Q2/Q3), IQR, and key percentiles (P10/P90/P95/P99) as a pretty-printed JSON
 * object. Non-numeric and non-finite entries are silently filtered.
 */
export const statsDescribeTool = new Tool({
  name: 'stats_describe',
  description:
    'Compute descriptive statistics for a numeric array: count, sum, min, max, range, mean, median, mode, variance, standard deviation, quartiles (Q1–Q3), IQR, and key percentiles.',
  inputSchema: validator.object({
    numbers: validator.array().items(validator.number()).required().description('Array of numbers'),
    precision: precisionField,
  }),
  artifactConstructor: () => SpooledJsonArtifact,
  handler: async (args) => {
    const { numbers, precision } = args as { numbers: number[]; precision: number }
    const nums = parseNumbers(numbers)
    if ('error' in nums) return `Error: ${nums.error}`

    const sorted = [...nums].sort((a, b) => a - b)
    const modeVal = mode(nums)
    // Computed aggregates (sum/mean/variance/std_dev) are emitted as `precision`-significant-digit
    // STRINGS via BigNumber: this is lossless (no toPrecision round-trip) and overflow-safe (a sum
    // exceeding float64 stays exact, e.g. 2e308 instead of Infinity). Order statistics
    // (min/max/median/quartiles/range) are always input elements or midpoints — in-range by
    // construction — so they remain numbers.
    const fmt = (n: number): string => formatBig(n, precision)

    return JSON.stringify(
      {
        count: nums.length,
        sum: formatBig(bigSum(nums), precision),
        min: min(nums),
        max: max(nums),
        range: max(nums) - min(nums),
        mean: formatBig(bigMean(nums), precision),
        median: median(nums),
        mode: modeVal,
        variance: fmt(variance(nums)),
        std_dev: fmt(standardDeviation(nums)),
        q1: quantile(sorted, 0.25),
        q2: quantile(sorted, 0.5),
        q3: quantile(sorted, 0.75),
        iqr: interquartileRange(nums),
        p10: quantile(sorted, 0.1),
        p90: quantile(sorted, 0.9),
        p95: quantile(sorted, 0.95),
        p99: quantile(sorted, 0.99),
      },
      null,
      2
    )
  },
})

/**
 * Compute the Pearson correlation coefficient between two numeric arrays.
 *
 * @remarks
 * Returns `r`, `r²` (as a percentage of explained variance), and a plain-English interpretation
 * of strength and direction. Arrays must be the same length and contain at least two points.
 */
export const statsCorrelateTool = new Tool({
  name: 'stats_correlate',
  description:
    'Compute the Pearson correlation coefficient between two numeric arrays. Returns the r value (-1 to 1), r², and a plain-English interpretation.',
  inputSchema: validator.object({
    x: validator
      .array()
      .items(validator.number())
      .required()
      .description('Array of numbers (first variable)'),
    y: validator
      .array()
      .items(validator.number())
      .required()
      .description('Array of numbers (second variable, same length as x)'),
  }),
  handler: async (args) => {
    const { x: rawX, y: rawY } = args as { x: number[]; y: number[] }
    const x = parseNumbers(rawX)
    if ('error' in x) return `Error in x: ${x.error}`
    const y = parseNumbers(rawY)
    if ('error' in y) return `Error in y: ${y.error}`

    if (x.length !== y.length)
      return `Error: Arrays must be the same length (x: ${x.length}, y: ${y.length}).`
    if (x.length < 2) return 'Error: At least 2 data points required.'

    // Pearson r is undefined when either variable has zero variance (constant) — the formula
    // divides by a standard deviation of 0. Report that explicitly instead of emitting `r = NaN`,
    // which reads like a real (negligible) correlation.
    if (standardDeviation(x) === 0 || standardDeviation(y) === 0) {
      return 'Correlation is undefined: at least one variable is constant (zero variance), so Pearson r cannot be computed.'
    }

    try {
      const r = sampleCorrelation(x, y)
      const absR = Math.abs(r)
      const direction = r > 0 ? 'positive' : r < 0 ? 'negative' : 'no'
      const strength =
        absR >= 0.9
          ? 'very strong'
          : absR >= 0.7
            ? 'strong'
            : absR >= 0.5
              ? 'moderate'
              : absR >= 0.3
                ? 'weak'
                : 'very weak / negligible'
      return `r = ${r.toFixed(6)}\nr² = ${(r * r * 100).toFixed(2)}% (explained variance)\nInterpretation: ${strength} ${direction} correlation`
    } catch (err) {
      return `Error: ${isError(err) ? err.message : String(err)}`
    }
  },
})

/**
 * Transform a numeric array — normalise, smooth, rank, or detect outliers.
 *
 * @remarks
 * Supported operations: `normalize_min_max`, `normalize_z_score`, `normalize_percent_of_sum`,
 * `running_total`, `rolling_avg`, `pct_change`, `rank`, `outliers_iqr`, `outliers_zscore`. Most
 * operations return a JSON array of transformed values; outlier operations return a
 * human-readable report.
 */
export const statsTransformTool = new Tool({
  name: 'stats_transform',
  description:
    'Transform a numeric array: normalize (min-max or z-score), compute running totals, rolling averages, percent change between consecutive values, rank each value, or detect outliers.',
  inputSchema: validator.object({
    numbers: validator.array().items(validator.number()).required().description('Array of numbers'),
    operation: validator
      .string()
      .valid(
        'normalize_min_max',
        'normalize_z_score',
        'normalize_percent_of_sum',
        'running_total',
        'rolling_avg',
        'pct_change',
        'rank',
        'outliers_iqr',
        'outliers_zscore'
      )
      .required()
      .description('Transformation to apply'),
    window: validator.number().default(3).description('For rolling_avg: window size (default: 3)'),
    threshold: validator
      .number()
      .default(3.0)
      .description('For outliers_zscore: z-score threshold (default: 3.0)'),
    precision: precisionField,
  }),
  handler: async (args) => {
    const { numbers, operation, window, threshold, precision } = args as {
      numbers: number[]
      operation: string
      window: number
      threshold: number
      precision: number
    }
    const nums = parseNumbers(numbers)
    if ('error' in nums) return `Error: ${nums.error}`

    // Round a float to `precision` significant digits without the toPrecision/parse noise.
    const round = (n: number): number => Number.parseFloat(formatBig(n, precision))

    switch (operation) {
      case 'normalize_min_max': {
        const lo = min(nums)
        const hi = max(nums)
        if (lo === hi) return JSON.stringify(nums.map(() => 0))
        return JSON.stringify(nums.map((v) => round((v - lo) / (hi - lo))))
      }

      case 'normalize_z_score': {
        const m = mean(nums)
        const sd = standardDeviation(nums)
        if (sd === 0) return JSON.stringify(nums.map(() => 0))
        return JSON.stringify(nums.map((v) => round(zScore(v, m, sd))))
      }

      case 'normalize_percent_of_sum': {
        const total = sum(nums)
        if (total === 0) return JSON.stringify(nums.map(() => 0))
        return JSON.stringify(nums.map((v) => round((v / total) * 100)))
      }

      case 'running_total': {
        // Each prefix sum is computed exactly via BigNumber (so a cumulative total exceeding
        // float64 stays exact instead of overflowing to Infinity). Each entry is a plain number
        // when it fits float64 (the common case), or a precise string when it would otherwise
        // overflow to Infinity → JSON null.
        return JSON.stringify(
          nums.map((_, i) => {
            const big = bigSum(nums.slice(0, i + 1))
            const asNum = bigToNumber(big)
            // Number only when exactly representable; otherwise the exact string (covers both
            // overflow and the silent-rounding gap above 2^53).
            if (Number.isFinite(asNum) && Math.abs(asNum) <= Number.MAX_SAFE_INTEGER) {
              return round(asNum)
            }
            return formatBig(big, precision)
          })
        )
      }

      case 'rolling_avg': {
        const w = Math.max(1, Math.floor(window))
        return JSON.stringify(
          nums.map((_, i) => {
            const slice = nums.slice(Math.max(0, i - w + 1), i + 1)
            return round(mean(slice))
          })
        )
      }

      case 'pct_change': {
        const changes: (number | null)[] = [null]
        for (let i = 1; i < nums.length; i++) {
          if (nums[i - 1] === 0) {
            changes.push(null)
          } else {
            changes.push(
              Number.parseFloat(
                (((nums[i] - nums[i - 1]) / Math.abs(nums[i - 1])) * 100).toFixed(4)
              )
            )
          }
        }
        return JSON.stringify(changes)
      }

      case 'rank': {
        const sorted = [...nums].sort((a, b) => a - b)
        return JSON.stringify(nums.map((v) => sorted.indexOf(v) + 1))
      }

      case 'outliers_iqr': {
        const sorted = [...nums].sort((a, b) => a - b)
        const q1 = quantile(sorted, 0.25)
        const q3 = quantile(sorted, 0.75)
        const iqr = q3 - q1
        const lo = q1 - 1.5 * iqr
        const hi = q3 + 1.5 * iqr
        const outliers = nums
          .map((v, i) => ({ index: i, value: v }))
          .filter(({ value }) => value < lo || value > hi)
        if (outliers.length === 0) return 'No outliers detected (IQR method).'
        return `${outliers.length} outlier(s) detected:\n${outliers.map((o) => `  [${o.index}] = ${o.value}`).join('\n')}`
      }

      case 'outliers_zscore': {
        const m = mean(nums)
        const sd = standardDeviation(nums)
        const outliers = nums
          .map((v, i) => ({ index: i, value: v, z: sd === 0 ? 0 : Math.abs(zScore(v, m, sd)) }))
          .filter((o) => o.z > threshold)
        if (outliers.length === 0) return `No outliers detected (|z| > ${threshold}).`
        return `${outliers.length} outlier(s) detected (|z| > ${threshold}):\n${outliers.map((o) => `  [${o.index}] = ${o.value} (z = ${o.z.toFixed(3)})`).join('\n')}`
      }

      default:
        return `Error: Unknown operation "${operation}".`
    }
  },
})

/**
 * Bin a numeric array into equal-width histogram buckets.
 *
 * @remarks
 * Output is a text histogram showing each bin's range, count, percentage of total, and a bar
 * chart. The last bin is inclusive on both ends; preceding bins are half-open. `bins` is clamped
 * to `[2, 100]`.
 */
export const statsHistogramTool = new Tool({
  name: 'stats_histogram',
  description: 'Bin a numeric array into equal-width histogram buckets and display counts.',
  inputSchema: validator.object({
    numbers: validator.array().items(validator.number()).required().description('Array of numbers'),
    bins: validator.number().default(10).description('Number of bins (default: 10, max: 100)'),
    precision: precisionField,
  }),
  handler: async (args) => {
    const { numbers, bins, precision } = args as {
      numbers: number[]
      bins: number
      precision: number
    }
    const nums = parseNumbers(numbers)
    if ('error' in nums) return `Error: ${nums.error}`

    const binCount = Math.max(2, Math.min(100, Math.floor(bins)))

    try {
      const breaks = equalIntervalBreaks(nums, binCount)
      const rows: string[] = []
      const maxCount = (() => {
        let m = 0
        for (let i = 0; i < breaks.length - 1; i++) {
          const isLast = i === breaks.length - 2
          const count = nums.filter((v) =>
            isLast ? v >= breaks[i] && v <= breaks[i + 1] : v >= breaks[i] && v < breaks[i + 1]
          ).length
          if (count > m) m = count
        }
        return m
      })()

      for (let i = 0; i < breaks.length - 1; i++) {
        const isLast = i === breaks.length - 2
        const count = nums.filter((v) =>
          isLast ? v >= breaks[i] && v <= breaks[i + 1] : v >= breaks[i] && v < breaks[i + 1]
        ).length
        const pct = ((count / nums.length) * 100).toFixed(1)
        const bar = '█'.repeat(maxCount > 0 ? Math.round((count / maxCount) * 20) : 0)
        const range = `[${formatBig(breaks[i], precision)}, ${formatBig(breaks[i + 1], precision)}${isLast ? ']' : ')'}`
        rows.push(`${range.padEnd(22)} ${String(count).padStart(4)} (${pct.padStart(5)}%) ${bar}`)
      }

      return rows.join('\n')
    } catch (err) {
      return `Error: ${isError(err) ? err.message : String(err)}`
    }
  },
})
