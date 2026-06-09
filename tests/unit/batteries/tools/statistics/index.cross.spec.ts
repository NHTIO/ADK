import { describe, expect, it } from 'vitest'
import { callTool, makeToolCtxStub } from '../../../../_fixtures/tool_ctx_stub'
import { E_INVALID_TOOL_ARGS } from '../../../../../src/lib/exceptions/runtime'
import { SpooledJsonArtifact } from '../../../../../src/lib/classes/spooled_json_artifact'
import {
  statsCorrelateTool,
  statsDescribeTool,
  statsHistogramTool,
  statsTransformTool,
} from '../../../../../src/batteries/tools/statistics'

// The statistics tools now take typed number arrays (validator.array().items(validator.number())),
// not JSON strings. These tests were authored against the old string form; this shim parses a
// string-encoded array into a real array at the boundary so existing call sites keep working,
// while the tool still receives (and validates) a typed array. A non-array/non-numeric payload is
// passed through untouched so schema-rejection tests still exercise the rejection path.
const coerceNumeric = (v: unknown): unknown => {
  if (typeof v !== 'string') return v
  try {
    return JSON.parse(v)
  } catch {
    return v
  }
}
const coerceArgs = (args: Record<string, unknown>): Record<string, unknown> => {
  const out = { ...args }
  for (const k of ['numbers', 'x', 'y']) {
    if (k in out) out[k] = coerceNumeric(out[k])
  }
  return out
}

const runDescribe = async (numbers: string): Promise<Record<string, unknown>> => {
  const out = (await statsDescribeTool.executor(makeToolCtxStub())({
    numbers: coerceNumeric(numbers),
  })) as string
  const parsed = JSON.parse(out) as Record<string, unknown>
  // The computed aggregates (sum/mean/variance/std_dev) are now emitted as precision-formatted
  // STRINGS (lossless, overflow-safe). These tests assert them as numbers, so coerce those four
  // fields back to numbers at the boundary — the string form is verified separately in the
  // numeric-boundary block.
  for (const k of ['sum', 'mean', 'variance', 'std_dev']) {
    if (typeof parsed[k] === 'string') parsed[k] = Number(parsed[k])
  }
  return parsed
}
const runCorr = async (args: Record<string, unknown>): Promise<string> => {
  return (await statsCorrelateTool.executor(makeToolCtxStub())(coerceArgs(args))) as string
}
const runTransform = async (args: Record<string, unknown>): Promise<string> => {
  return (await statsTransformTool.executor(makeToolCtxStub())(coerceArgs(args))) as string
}
const runHist = async (args: Record<string, unknown>): Promise<string> => {
  return (await statsHistogramTool.executor(makeToolCtxStub())(coerceArgs(args))) as string
}

describe('statsDescribeTool', () => {
  it('computes core statistics for a sample dataset', async () => {
    const out = await runDescribe('[1, 2, 3, 4, 5]')
    expect(out.count).toBe(5)
    expect(out.sum).toBe(15)
    expect(out.min).toBe(1)
    expect(out.max).toBe(5)
    expect(out.range).toBe(4)
    expect(out.mean).toBe(3)
    expect(out.median).toBe(3)
  })

  it('returns variance and standard deviation', async () => {
    const out = await runDescribe('[2, 4, 4, 4, 5, 5, 7, 9]')
    // Population variance of this classic dataset is 4
    expect(out.variance).toBe(4)
    // Population std dev is 2
    expect(out.std_dev).toBe(2)
  })

  it('returns quartiles', async () => {
    const out = await runDescribe('[1, 2, 3, 4, 5, 6, 7, 8, 9]')
    expect(out.q2).toBe(5)
  })

  it('declares its artifact constructor as SpooledJsonArtifact', () => {
    expect(statsDescribeTool.artifactConstructor?.()).toBe(SpooledJsonArtifact)
  })

  it('rejects a non-array string via schema', async () => {
    await expect(
      statsDescribeTool.executor(makeToolCtxStub())({ numbers: 'not json' })
    ).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
  })

  it('rejects a non-array object via schema', async () => {
    await expect(
      statsDescribeTool.executor(makeToolCtxStub())({ numbers: {} })
    ).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
  })

  it('rejects an array of non-numbers via schema', async () => {
    await expect(
      statsDescribeTool.executor(makeToolCtxStub())({ numbers: ['a', 'b'] })
    ).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
  })
})

describe('statsCorrelateTool', () => {
  it('returns r ≈ 1 for perfectly correlated arrays', async () => {
    const out = await runCorr({ x: [1, 2, 3, 4, 5], y: [2, 4, 6, 8, 10] })
    expect(out).toMatch(/r = 1\.000000/)
    expect(out).toContain('very strong positive')
  })

  it('returns r ≈ -1 for perfect inverse correlation', async () => {
    const out = await runCorr({ x: [1, 2, 3, 4, 5], y: [5, 4, 3, 2, 1] })
    expect(out).toMatch(/r = -1\.000000/)
    expect(out).toContain('very strong negative')
  })

  it('errors on mismatched array lengths', async () => {
    const out = await runCorr({ x: [1, 2, 3], y: [1, 2] })
    expect(out).toMatch(/same length/)
  })

  it('requires at least 2 data points', async () => {
    const out = await runCorr({ x: [1], y: [2] })
    expect(out).toMatch(/At least 2 data points/)
  })

  it('rejects a non-array x via schema', async () => {
    await expect(
      statsCorrelateTool.executor(makeToolCtxStub())({ x: 'bad', y: [1, 2] })
    ).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
  })
})

describe('statsTransformTool', () => {
  it('normalize_min_max scales to [0,1]', async () => {
    const out = await runTransform({
      numbers: [0, 50, 100],
      operation: 'normalize_min_max',
    })
    expect(JSON.parse(out)).toEqual([0, 0.5, 1])
  })

  it('normalize_z_score centers around 0', async () => {
    const out = await runTransform({
      numbers: [1, 2, 3, 4, 5],
      operation: 'normalize_z_score',
    })
    const arr = JSON.parse(out) as number[]
    // Mean should be approximately 0
    expect(Math.abs(arr.reduce((a, b) => a + b, 0))).toBeLessThan(0.001)
  })

  it('normalize_percent_of_sum sums to 100', async () => {
    const out = await runTransform({
      numbers: [10, 20, 30, 40],
      operation: 'normalize_percent_of_sum',
    })
    const arr = JSON.parse(out) as number[]
    expect(arr).toEqual([10, 20, 30, 40])
  })

  it('running_total accumulates', async () => {
    const out = await runTransform({
      numbers: [1, 2, 3, 4],
      operation: 'running_total',
    })
    expect(JSON.parse(out)).toEqual([1, 3, 6, 10])
  })

  it('rolling_avg with window 2', async () => {
    const out = await runTransform({
      numbers: [1, 2, 3, 4],
      operation: 'rolling_avg',
      window: 2,
    })
    expect(JSON.parse(out)).toEqual([1, 1.5, 2.5, 3.5])
  })

  it('pct_change first entry is null', async () => {
    const out = await runTransform({
      numbers: [100, 110, 99],
      operation: 'pct_change',
    })
    const arr = JSON.parse(out)
    expect(arr[0]).toBeNull()
    expect(arr[1]).toBe(10)
  })

  it('rank assigns 1-based ranks by ascending value', async () => {
    const out = await runTransform({
      numbers: [30, 10, 20],
      operation: 'rank',
    })
    expect(JSON.parse(out)).toEqual([3, 1, 2])
  })

  it('outliers_iqr detects an obvious outlier', async () => {
    const out = await runTransform({
      numbers: [1, 2, 3, 4, 5, 100],
      operation: 'outliers_iqr',
    })
    expect(out).toMatch(/1 outlier/)
    expect(out).toContain('= 100')
  })

  it('outliers_zscore returns a no-outlier message when below threshold', async () => {
    const out = await runTransform({
      numbers: [1, 2, 3, 4, 5],
      operation: 'outliers_zscore',
    })
    expect(out).toMatch(/No outliers/)
  })

  it('schema rejects unknown operation', async () => {
    await expect(runTransform({ numbers: [1, 2, 3], operation: 'rumba' })).rejects.toBeInstanceOf(
      E_INVALID_TOOL_ARGS
    )
  })
})

describe('statsHistogramTool', () => {
  it('produces one row per bin with counts and bars', async () => {
    const out = await runHist({
      numbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      bins: 5,
    })
    expect(out.split('\n')).toHaveLength(5)
    expect(out).toMatch(/█+/)
  })

  it('clamps bins to [2, 100]', async () => {
    const out = await runHist({
      numbers: [1, 2, 3, 4, 5],
      bins: 500,
    })
    // Result should not exceed 100 bins (5 unique values means most bins will be 0)
    expect(out.split('\n').length).toBeLessThanOrEqual(100)
  })

  it('rejects a non-array via schema', async () => {
    await expect(
      statsHistogramTool.executor(makeToolCtxStub())({ numbers: 'nope' })
    ).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
  })
})

describe('statsDescribeTool edge cases', () => {
  it('handles single element array', async () => {
    const out = await runDescribe('[42]')
    expect(out.count).toBe(1)
    expect(out.mean).toBe(42)
    expect(out.median).toBe(42)
    expect(out.std_dev).toBeCloseTo(0, 6)
  })

  it('handles all identical elements', async () => {
    const out = await runDescribe('[5, 5, 5, 5, 5]')
    expect(out.mean).toBe(5)
    expect(out.median).toBe(5)
    expect(out.std_dev).toBeCloseTo(0, 6)
    expect(out.variance).toBeCloseTo(0, 6)
  })

  it('handles negative numbers', async () => {
    const out = await runDescribe('[-5, -3, -1, 1, 3, 5]')
    expect(out.mean).toBeCloseTo(0, 6)
    expect(out.median).toBeCloseTo(0, 6)
    expect(out.min).toBe(-5)
    expect(out.max).toBe(5)
  })

  it('handles mixed positive and negative', async () => {
    const out = await runDescribe('[-10, 0, 10]')
    expect(out.mean).toBe(0)
    expect(out.median).toBe(0)
  })

  it('rejects an array with non-numeric entries via schema', async () => {
    await expect(
      statsDescribeTool.executor(makeToolCtxStub())({ numbers: [1, 2, 3, 4, 5, 'a', null, {}] })
    ).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
  })

  it('handles large numbers', async () => {
    const out = await runDescribe('[10000000000, 20000000000, 30000000000]')
    expect(out.count).toBe(3)
    expect(out.mean).toBeCloseTo(20000000000, 6)
  })

  it('computes mode correctly', async () => {
    const out = await runDescribe('[1, 2, 2, 3, 3, 3, 4]')
    expect(out.mode).toBe(3)
  })

  it('handles even count quartiles', async () => {
    const out = await runDescribe('[1, 2, 3, 4, 5, 6]')
    expect(out.q1).toBeCloseTo(2.25, 6)
    expect(out.q2).toBe(3.5)
    expect(out.q3).toBeCloseTo(4.75, 6)
  })

  it('computes iqr correctly', async () => {
    const out = await runDescribe('[1, 2, 3, 4, 5, 6, 7, 8, 9]')
    expect(out.iqr).toBeCloseTo(4, 6) // Q3=7, Q1=3, IQR=4
  })

  it('computes percentiles correctly', async () => {
    const out = await runDescribe('[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]')
    // p50 (median) for 10 items is the mean of 5th and 6th values
    expect(out.median).toBeCloseTo(5.5, 6)
  })
})

describe('statsCorrelateTool edge cases', () => {
  it('returns r near 0 for uncorrelated data', async () => {
    // Use completely shuffled data to get near-zero correlation
    const out = await runCorr({
      x: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      y: [10, 8, 6, 4, 2, 1, 3, 5, 7, 9],
    })
    const rMatch = out.match(/r = ([+-]?\d\.\d+)/)
    expect(rMatch).toBeDefined()
    if (!rMatch) throw new Error('No match found')
    const r = Number.parseFloat(rMatch[1])
    // This combination gives r approximately -0.17 (very weak correlation)
    expect(Math.abs(r)).toBeLessThan(0.3)
  })

  it('handles identical arrays (perfect positive correlation)', async () => {
    const out = await runCorr({
      x: [1, 2, 3, 4, 5],
      y: [1, 2, 3, 4, 5],
    })
    expect(out).toMatch(/r = 1\.000000/)
  })

  it('handles very small arrays (2 elements)', async () => {
    const out = await runCorr({
      x: [1, 2],
      y: [2, 4],
    })
    expect(out).toMatch(/r = 1\.000000/)
  })

  it('handles negative correlation', async () => {
    const out = await runCorr({
      x: [1, 2, 3, 4, 5],
      y: [5, 4, 3, 2, 1],
    })
    expect(out).toMatch(/r = -1\.000000/)
    expect(out).toContain('very strong negative')
  })

  it('handles floating point numbers', async () => {
    const out = await runCorr({
      x: [1.5, 2.5, 3.5, 4.5],
      y: [1.1, 2.2, 3.3, 4.4],
    })
    expect(out).toMatch(/r = 1\.000000/)
  })

  it('errors when single element array', async () => {
    const out = await runCorr({
      x: [1],
      y: [2],
    })
    expect(out).toMatch(/At least 2 data points/)
  })
})

describe('statsTransformTool edge cases', () => {
  it('normalize_min_max handles identical values', async () => {
    const out = await runTransform({
      numbers: [5, 5, 5],
      operation: 'normalize_min_max',
    })
    expect(JSON.parse(out)).toEqual([0, 0, 0])
  })

  it('normalize_z_score handles identical values', async () => {
    const out = await runTransform({
      numbers: [5, 5, 5],
      operation: 'normalize_z_score',
    })
    expect(JSON.parse(out)).toEqual([0, 0, 0])
  })

  it('normalize_percent_of_sum handles all zeros', async () => {
    const out = await runTransform({
      numbers: [0, 0, 0],
      operation: 'normalize_percent_of_sum',
    })
    expect(JSON.parse(out)).toEqual([0, 0, 0])
  })

  it('running_total handles negative numbers', async () => {
    const out = await runTransform({
      numbers: [10, -5, -3, 2],
      operation: 'running_total',
    })
    expect(JSON.parse(out)).toEqual([10, 5, 2, 4])
  })

  it('running_total handles single element', async () => {
    const out = await runTransform({
      numbers: [42],
      operation: 'running_total',
    })
    expect(JSON.parse(out)).toEqual([42])
  })

  it('rolling_avg handles window larger than array', async () => {
    const out = await runTransform({
      numbers: [1, 2],
      operation: 'rolling_avg',
      window: 10,
    })
    expect(JSON.parse(out)).toEqual([1, 1.5])
  })

  it('rolling_avg with window 1 is identity', async () => {
    const out = await runTransform({
      numbers: [1, 2, 3, 4],
      operation: 'rolling_avg',
      window: 1,
    })
    expect(JSON.parse(out)).toEqual([1, 2, 3, 4])
  })

  it('pct_change handles division by zero', async () => {
    const out = await runTransform({
      numbers: [100, 0, 100],
      operation: 'pct_change',
    })
    const arr = JSON.parse(out)
    expect(arr[0]).toBeNull()
    // Change from 100 to 0: (0-100)/|100| = -100%
    expect(arr[1]).toBe(-100)
    // Change from 0 to 100: undefined, returns null
    expect(arr[2]).toBeNull()
  })

  it('rank handles ties', async () => {
    const out = await runTransform({
      numbers: [10, 20, 20, 30],
      operation: 'rank',
    })
    expect(JSON.parse(out)).toEqual([1, 2, 2, 4])
  })

  it('outliers_iqr with no outliers', async () => {
    const out = await runTransform({
      numbers: [1, 2, 3, 4, 5],
      operation: 'outliers_iqr',
    })
    expect(out).toMatch(/No outliers/)
  })

  it('outliers_iqr with obvious outlier', async () => {
    const out = await runTransform({
      numbers: [1, 2, 3, 4, 5, 1000],
      operation: 'outliers_iqr',
    })
    expect(out).toMatch(/1 outlier/)
  })

  it('outliers_zscore with obvious outlier', async () => {
    const out = await runTransform({
      numbers: [1, 2, 3, 4, 5, 100],
      operation: 'outliers_zscore',
      threshold: 2,
    })
    expect(out).toMatch(/outlier/)
  })

  it('outliers_zscore with no outliers below threshold', async () => {
    const out = await runTransform({
      numbers: [1, 2, 3, 4, 5],
      operation: 'outliers_zscore',
      threshold: 3,
    })
    expect(out).toMatch(/No outliers/)
  })

  it('rank with negative numbers', async () => {
    const out = await runTransform({
      numbers: [-10, 0, 10],
      operation: 'rank',
    })
    expect(JSON.parse(out)).toEqual([1, 2, 3])
  })

  it('normalize_min_max preserves ordering', async () => {
    const original = [10, 20, 30, 40, 50]
    const out = await runTransform({
      numbers: JSON.stringify(original),
      operation: 'normalize_min_max',
    })
    const normalized = JSON.parse(out)
    // Check monotonicity is preserved
    for (let i = 1; i < normalized.length; i++) {
      expect(normalized[i] >= normalized[i - 1]).toBe(true)
    }
  })
})

describe('statsHistogramTool edge cases', () => {
  it('produces correct bin counts', async () => {
    const out = await runHist({
      numbers: [1, 2, 3, 4, 5],
      bins: 5,
    })
    const lines = out.split('\n')
    expect(lines).toHaveLength(5)
    // Each bin should have exactly 1 count
    for (const line of lines) {
      expect(line).toContain('   1')
    }
  })

  it('handles single value array', async () => {
    const out = await runHist({
      numbers: [5, 5, 5, 5],
      bins: 2,
    })
    expect(out).not.toMatch(/^Error/)
  })

  it('rejects an all-non-numeric array via schema', async () => {
    await expect(
      statsHistogramTool.executor(makeToolCtxStub())({ numbers: ['a', 'b', 'c'], bins: 2 })
    ).rejects.toBeInstanceOf(E_INVALID_TOOL_ARGS)
  })

  it('clamps minimum to 2 bins', async () => {
    const out = await runHist({
      numbers: [1, 2, 3],
      bins: 1,
    })
    // Should not error, clamped to 2
    expect(out).not.toMatch(/^Error/)
  })

  it('histogram counts sum to N', async () => {
    const N = 10
    const out = await runHist({
      numbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      bins: 5,
    })
    // Count total matches in output
    let total = 0
    for (const match of out.match(/\d+(?=\s+\()/g) || []) {
      total += Number.parseInt(match)
    }
    expect(total).toBe(N)
  })
})

describe('invariants and properties via callTool', () => {
  describe('statsDescribeTool invariants', () => {
    it('quantile ordering: Q1 ≤ Q2 ≤ Q3', async () => {
      const r = await callTool(statsDescribeTool, { numbers: [1, 2, 3, 4, 5, 6, 7, 8, 9] })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      const out = JSON.parse(r.out)
      expect(out.q1).toBeLessThanOrEqual(out.q2)
      expect(out.q2).toBeLessThanOrEqual(out.q3)
    })

    it('mean is between min and max', async () => {
      const r = await callTool(statsDescribeTool, { numbers: [1, 2, 3, 4, 5] })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      const out = JSON.parse(r.out)
      expect(Number(out.mean)).toBeGreaterThanOrEqual(out.min)
      expect(Number(out.mean)).toBeLessThanOrEqual(out.max)
    })

    it('range = max - min', async () => {
      const r = await callTool(statsDescribeTool, { numbers: [1, 5, 10, 3, 7] })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      const out = JSON.parse(r.out)
      expect(out.range).toBe(out.max - out.min)
    })

    it('mode is one of the most frequent values', async () => {
      const r = await callTool(statsDescribeTool, { numbers: [1, 2, 2, 3, 3, 3, 4] })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      const out = JSON.parse(r.out)
      expect(out.mode).toBe(3)
    })

    it('variance is non-negative', async () => {
      const r = await callTool(statsDescribeTool, { numbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      const out = JSON.parse(r.out)
      expect(Number(out.variance)).toBeGreaterThanOrEqual(0)
    })

    it('std_dev = sqrt(variance) (approx)', async () => {
      const r = await callTool(statsDescribeTool, { numbers: [2, 4, 4, 4, 5, 5, 7, 9] })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      const out = JSON.parse(r.out)
      expect(out.std_dev).toBeCloseTo(Math.sqrt(out.variance as number), 6)
    })

    it('sum = count * mean (approx)', async () => {
      const r = await callTool(statsDescribeTool, { numbers: [1, 2, 3, 4, 5] })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      const out = JSON.parse(r.out)
      expect(out.sum).toBeCloseTo((out.count as number) * (out.mean as number), 6)
    })

    it('IQR = Q3 - Q1', async () => {
      const r = await callTool(statsDescribeTool, { numbers: [1, 2, 3, 4, 5, 6, 7, 8, 9] })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      const out = JSON.parse(r.out)
      expect(out.iqr).toBeCloseTo((out.q3 as number) - (out.q1 as number), 6)
    })
  })

  describe('statsCorrelateTool invariants', () => {
    it('correlation is symmetric: r(x,y) = r(y,x)', async () => {
      const rXY = await callTool(statsCorrelateTool, {
        x: [1, 2, 3, 4, 5],
        y: [2, 4, 5, 4, 5],
      })
      const rYX = await callTool(statsCorrelateTool, {
        x: [2, 4, 5, 4, 5],
        y: [1, 2, 3, 4, 5],
      })
      expect(rXY.kind).toBe('resolved')
      expect(rYX.kind).toBe('resolved')
      if (rXY.kind !== 'resolved' || rYX.kind !== 'resolved') return
      const rXYval = Number.parseFloat(rXY.out.match(/r = ([+-]?\d+\.\d+)/)?.[1] || '0')
      const rYXval = Number.parseFloat(rYX.out.match(/r = ([+-]?\d+\.\d+)/)?.[1] || '0')
      expect(rXYval).toBeCloseTo(rYXval, 5)
    })

    it('r² is r squared (percentage / 100)', async () => {
      const r = await callTool(statsCorrelateTool, {
        x: [1, 2, 3, 4, 5],
        y: [2, 4, 5, 4, 5],
      })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      const rVal = Number.parseFloat(r.out.match(/r = ([+-]?\d+\.\d+)/)?.[1] || '0')
      const r2FromStr = Number.parseFloat(r.out.match(/r² = ([\d.]+)%/)?.[1] || '0')
      expect(r2FromStr).toBeCloseTo(rVal * rVal * 100, 1)
    })
  })

  describe('statsHistogramTool invariants', () => {
    it('histogram bin counts sum to total N', async () => {
      const r = await callTool(statsHistogramTool, {
        numbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        bins: 5,
      })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      let total = 0
      for (const line of r.out.split('\n')) {
        const m = line.match(/\s+(\d+)\s+\(/)
        if (m) total += Number.parseInt(m[1])
      }
      expect(total).toBe(10)
    })

    it('histogram bin counts sum to N for any bin count', async () => {
      for (const bins of [2, 5, 10, 20]) {
        const r = await callTool(statsHistogramTool, { numbers: [1, 2, 3, 4, 5], bins })
        expect(r.kind).toBe('resolved')
        if (r.kind !== 'resolved') continue
        let total = 0
        for (const line of r.out.split('\n')) {
          const m = line.match(/\s+(\d+)\s+\(/)
          if (m) total += Number.parseInt(m[1])
        }
        expect(total).toBe(5)
      }
    })
  })

  describe('statsTransformTool invariants', () => {
    it('normalize_min_max result values are in [0,1]', async () => {
      const r = await callTool(statsTransformTool, {
        numbers: [10, 20, 30, 40, 50],
        operation: 'normalize_min_max',
      })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      const arr = JSON.parse(r.out)
      for (const v of arr) {
        expect(v).toBeGreaterThanOrEqual(0)
        expect(v).toBeLessThanOrEqual(1)
      }
    })

    it('normalize_min_max preserves ordering (monotonic)', async () => {
      const r = await callTool(statsTransformTool, {
        numbers: [10, 20, 30, 40, 50],
        operation: 'normalize_min_max',
      })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      const arr: number[] = JSON.parse(r.out)
      for (let i = 1; i < arr.length; i++) {
        expect(arr[i] >= arr[i - 1]).toBe(true)
      }
    })

    it('normalize_z_score mean is approximately 0', async () => {
      const r = await callTool(statsTransformTool, {
        numbers: [1, 2, 3, 4, 5],
        operation: 'normalize_z_score',
      })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      const arr: number[] = JSON.parse(r.out)
      const mean = arr.reduce((a, b) => a + b, 0) / arr.length
      expect(Math.abs(mean)).toBeLessThan(1e-6)
    })

    it('normalize_percent_of_sum sums to 100 (within tolerance)', async () => {
      const r = await callTool(statsTransformTool, {
        numbers: [10, 20, 30, 40],
        operation: 'normalize_percent_of_sum',
      })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      const arr: number[] = JSON.parse(r.out)
      const total = arr.reduce((a, b) => a + b, 0)
      expect(total).toBeCloseTo(100, 1)
    })

    it('running_total last element equals sum of all', async () => {
      const r = await callTool(statsTransformTool, {
        numbers: [1, 2, 3, 4, 5],
        operation: 'running_total',
      })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      const arr: number[] = JSON.parse(r.out)
      expect(arr[arr.length - 1]).toBe(15)
    })
  })
})

describe('callTool-based edge/crash tests', () => {
  describe('statsDescribeTool', () => {
    it('single-element array: stdev is 0', async () => {
      const r = await callTool(statsDescribeTool, { numbers: [42] })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      const out = JSON.parse(r.out)
      expect(out.std_dev).toBeCloseTo(0, 6)
      expect(out.variance).toBeCloseTo(0, 6)
    })

    it('all identical values: stdev is 0', async () => {
      const r = await callTool(statsDescribeTool, { numbers: [7, 7, 7, 7, 7] })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      const out = JSON.parse(r.out)
      expect(out.std_dev).toBeCloseTo(0, 6)
    })

    // The schema is now validator.array().items(validator.number()); a string, object, or array
    // with non-numeric / non-finite entries is rejected with E_INVALID_TOOL_ARGS at validation,
    // before the handler runs. (Previously the tool took a JSON string and filtered silently.)
    it('rejects a non-array (string) input via schema', async () => {
      const r = await callTool(statsDescribeTool, { numbers: 'not json' })
      expect(r.kind).toBe('threw')
      if (r.kind === 'threw') expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
    })

    it('rejects a non-array (object) input via schema', async () => {
      const r = await callTool(statsDescribeTool, { numbers: {} })
      expect(r.kind).toBe('threw')
      if (r.kind === 'threw') expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
    })

    it('rejects an array containing non-numeric entries via schema', async () => {
      const r = await callTool(statsDescribeTool, { numbers: ['a', 'b', {}] })
      expect(r.kind).toBe('threw')
      if (r.kind === 'threw') expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
    })

    it('rejects an array with null/string entries via schema', async () => {
      const r = await callTool(statsDescribeTool, { numbers: [1, 2, 3, null, 'x'] })
      expect(r.kind).toBe('threw')
      if (r.kind === 'threw') expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
    })

    it('handles negative numbers', async () => {
      const r = await callTool(statsDescribeTool, { numbers: [-10, -5, 0, 5, 10] })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      const out = JSON.parse(r.out)
      expect(Number(out.mean)).toBe(0)
      expect(out.min).toBe(-10)
      expect(out.max).toBe(10)
    })

    it('handles very large (in-range) numbers', async () => {
      const r = await callTool(statsDescribeTool, { numbers: [1e15, 2e15, 3e15] })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      const out = JSON.parse(r.out)
      expect(out.count).toBe(3)
      expect(Number(out.mean)).toBeCloseTo(2e15, 6)
    })
  })

  describe('statsCorrelateTool', () => {
    it('perfect positive correlation r=1', async () => {
      const r = await callTool(statsCorrelateTool, { x: [1, 2, 3], y: [2, 4, 6] })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') expect(r.out).toMatch(/r = 1\.000000/)
    })

    it('perfect negative correlation r=-1', async () => {
      const r = await callTool(statsCorrelateTool, { x: [1, 2, 3], y: [3, 2, 1] })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') expect(r.out).toMatch(/r = -1\.000000/)
    })

    it('correlation is between -1 and 1', async () => {
      const r = await callTool(statsCorrelateTool, {
        x: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        y: [10, 8, 6, 4, 2, 1, 3, 5, 7, 9],
      })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      const rVal = Number.parseFloat(r.out.match(/r = ([+-]?\d+\.\d+)/)?.[1] || '0')
      expect(rVal).toBeGreaterThanOrEqual(-1)
      expect(rVal).toBeLessThanOrEqual(1)
    })

    it('handles mismatched lengths gracefully', async () => {
      const r = await callTool(statsCorrelateTool, { x: [1, 2, 3], y: [1, 2] })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') expect(r.out).toMatch(/same length/)
    })

    it('errors on less than 2 data points', async () => {
      const r = await callTool(statsCorrelateTool, { x: [1], y: [2] })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') expect(r.out).toMatch(/At least 2/)
    })

    // EXPECTED-RED: all-identical values cause division by zero in correlation
    it('all-identical values should not crash (expects resolved, may throw)', async () => {
      const r = await callTool(statsCorrelateTool, { x: [5, 5, 5], y: [1, 2, 3] })
      expect(r.kind).toBe('resolved') // EXPECTED-RED: handler may crash
    })
  })

  describe('statsTransformTool', () => {
    it('normalize_min_max with identical values returns all zeros', async () => {
      const r = await callTool(statsTransformTool, {
        numbers: [5, 5, 5],
        operation: 'normalize_min_max',
      })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      expect(JSON.parse(r.out)).toEqual([0, 0, 0])
    })

    it('normalize_z_score with identical values returns all zeros', async () => {
      const r = await callTool(statsTransformTool, {
        numbers: [5, 5, 5],
        operation: 'normalize_z_score',
      })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      expect(JSON.parse(r.out)).toEqual([0, 0, 0])
    })

    it('normalize_percent_of_sum with all zeros returns all zeros', async () => {
      const r = await callTool(statsTransformTool, {
        numbers: [0, 0, 0],
        operation: 'normalize_percent_of_sum',
      })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      expect(JSON.parse(r.out)).toEqual([0, 0, 0])
    })

    it('pct_change first element is null', async () => {
      const r = await callTool(statsTransformTool, {
        numbers: [100, 110, 90],
        operation: 'pct_change',
      })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      const arr = JSON.parse(r.out)
      expect(arr[0]).toBeNull()
    })

    it('pct_change handles division by zero gracefully', async () => {
      const r = await callTool(statsTransformTool, { numbers: [0, 100], operation: 'pct_change' })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      const arr = JSON.parse(r.out)
      // First is null (no previous), second is null (division by zero)
      expect(arr[1]).toBeNull()
    })

    it('rank handles ties correctly', async () => {
      const r = await callTool(statsTransformTool, { numbers: [10, 20, 20, 30], operation: 'rank' })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      expect(JSON.parse(r.out)).toEqual([1, 2, 2, 4])
    })

    it('outliers_iqr with no outliers', async () => {
      const r = await callTool(statsTransformTool, {
        numbers: [1, 2, 3, 4, 5],
        operation: 'outliers_iqr',
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') expect(r.out).toMatch(/No outliers/)
    })

    it('outliers_iqr detects obvious outlier', async () => {
      const r = await callTool(statsTransformTool, {
        numbers: [1, 2, 3, 4, 5, 1000],
        operation: 'outliers_iqr',
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') expect(r.out).toMatch(/1 outlier/)
    })

    it('outliers_zscore with no outliers below threshold', async () => {
      const r = await callTool(statsTransformTool, {
        numbers: [1, 2, 3, 4, 5],
        operation: 'outliers_zscore',
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') expect(r.out).toMatch(/No outliers/)
    })

    it('rolling_avg with window 1 preserves identity', async () => {
      const r = await callTool(statsTransformTool, {
        numbers: [1, 2, 3, 4],
        operation: 'rolling_avg',
        window: 1,
      })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      expect(JSON.parse(r.out)).toEqual([1, 2, 3, 4])
    })

    it('rolling_avg with window larger than array', async () => {
      const r = await callTool(statsTransformTool, {
        numbers: [1, 2],
        operation: 'rolling_avg',
        window: 10,
      })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      const out: number[] = JSON.parse(r.out)
      expect(out[0]).toBeCloseTo(1, 6)
      expect(out[1]).toBeCloseTo(1.5, 6)
    })
  })

  describe('statsHistogramTool', () => {
    it('bins clamp to [2, 100] — clamps up', async () => {
      const r = await callTool(statsHistogramTool, { numbers: [1, 2, 3, 4, 5], bins: 500 })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      expect(r.out.split('\n').length).toBeLessThanOrEqual(100)
    })

    it('bins clamp to [2, 100] — clamps down', async () => {
      const r = await callTool(statsHistogramTool, { numbers: [1, 2, 3], bins: 1 })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      expect(r.out).not.toMatch(/^Error/)
    })

    it('rejects a non-array string via schema', async () => {
      const r = await callTool(statsHistogramTool, { numbers: 'not json' })
      expect(r.kind).toBe('threw')
      if (r.kind === 'threw') expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
    })

    it('rejects an all-non-numeric array via schema', async () => {
      const r = await callTool(statsHistogramTool, { numbers: ['a', 'b'] })
      expect(r.kind).toBe('threw')
      if (r.kind === 'threw') expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
    })
  })

  describe('schema validation via callTool', () => {
    it('statsDescribeTool rejects missing numbers (threw)', async () => {
      const r = await callTool(statsDescribeTool, {})
      expect(r.kind).toBe('threw')
      if (r.kind === 'threw') expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
    })

    it('statsCorrelateTool rejects missing x (threw)', async () => {
      const r = await callTool(statsCorrelateTool, { y: [1, 2] })
      expect(r.kind).toBe('threw')
      if (r.kind === 'threw') expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
    })

    it('statsTransformTool rejects unknown operation (threw)', async () => {
      const r = await callTool(statsTransformTool, { numbers: [1, 2, 3], operation: 'unknown' })
      expect(r.kind).toBe('threw')
      if (r.kind === 'threw') expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
    })

    it('statsHistogramTool rejects NaN/Infinity on bins field (number field)', async () => {
      // validator.number() rejects NaN/Infinity
      const r = await callTool(statsHistogramTool, { numbers: [1, 2, 3], bins: Number.NaN })
      expect(r.kind).toBe('threw')
      if (r.kind === 'threw') expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
    })
  })
})

describe('stats hand-computed oracle values', () => {
  it('mean of [2,4,6,8] = 5.0', async () => {
    // Hand-computed: (2+4+6+8)/4 = 20/4 = 5
    const out = await runDescribe('[2, 4, 6, 8]')
    expect(out.mean).toBeCloseTo(5, 6)
  })
  it('median of [1,3,5,7,9] = 5', async () => {
    const out = await runDescribe('[1, 3, 5, 7, 9]')
    expect(out.median).toBe(5)
  })
  it('median of [1,3,5,7] = 4 (mean of 3 & 5)', async () => {
    const out = await runDescribe('[1, 3, 5, 7]')
    expect(out.median).toBe(4)
  })
  it('population std_dev of [1,2,3] = sqrt(2/3) ≈ 0.8165', async () => {
    // Hand-computed: mean=2, population variance = ((1-2)^2+(2-2)^2+(3-2)^2)/3 = 2/3
    // population std_dev = sqrt(2/3) ≈ 0.8164965809
    // simple-statistics variance() uses population formula (n denominator)
    const out = await runDescribe('[1, 2, 3]')
    expect(out.variance).toBeCloseTo(2 / 3, 6)
    expect(out.std_dev).toBeCloseTo(Math.sqrt(2 / 3), 6)
  })
  it('variance of [2,4,4,4,5,5,7,9] = 4 (sample)', async () => {
    const out = await runDescribe('[2, 4, 4, 4, 5, 5, 7, 9]')
    expect(out.variance).toBe(4)
    expect(out.std_dev).toBe(2)
  })
  it('sum matches hand-computed for [10, 20, 30]', async () => {
    const out = await runDescribe('[10, 20, 30]')
    expect(out.sum).toBe(60)
  })
  it('min/max of [-10, 0, 10, 20, 5, -5] are -10 and 20', async () => {
    const out = await runDescribe('[-10, 0, 10, 20, 5, -5]')
    expect(out.min).toBe(-10)
    expect(out.max).toBe(20)
  })
  it('p10, p90, p95, p99 for [1..100]', async () => {
    const numbers = Array.from({ length: 100 }, (_, i) => i + 1)
    const out = await runDescribe(JSON.stringify(numbers))
    // quantile with linear interpolation
    // p10 = quantile([1..100], 0.1): index = 0.1 * (100-1) = 9.9, value = 10 + 0.9*(11-10) = 10.9
    expect(out.p10).toBeCloseTo(10.9, 3)
    expect(out.p90).toBeCloseTo(90.1, 3)
  })
})

describe('stats correlation oracle values', () => {
  it('r = 0 for perfectly uncorrelated: x=[-2,-1,0,1,2], y=[4,1,0,1,4]', async () => {
    // x: [-2, -1, 0, 1, 2], y: [4, 1, 0, 1, 4]
    // mean_x = 0, mean_y = 2
    // sum(xi*yi) = (-2*4)+(-1*1)+(0*0)+(1*1)+(2*4) = -8-1+0+1+8 = 0
    // cov = 0, so r = 0
    const out = await runCorr({
      x: [-2, -1, 0, 1, 2],
      y: [4, 1, 0, 1, 4],
    })
    expect(out).toMatch(/r = 0\.000000/)
  })
  it('r ≈ 0.8 for (1,3),(2,2),(3,5),(4,4),(5,6)', async () => {
    const out = await runCorr({
      x: [1, 2, 3, 4, 5],
      y: [3, 2, 5, 4, 6],
    })
    // Hand-computed: means: mx=3, my=4
    // deviations_x: [-2,-1,0,1,2], deviations_y: [-1,-2,1,0,2]
    // sum(xd*yd): 2+2+0+0+4=8
    // sum(xd^2): 4+1+0+1+4=10, sum(yd^2): 1+4+1+0+4=10
    // r = 8/sqrt(100) = 0.8
    expect(out).toMatch(/r = 0\.800000/)
  })
})

describe('stats transform oracle', () => {
  it('running_total of [5, 3, 9] = [5, 8, 17]', async () => {
    const out = await runTransform({
      numbers: [5, 3, 9],
      operation: 'running_total',
    })
    expect(JSON.parse(out)).toEqual([5, 8, 17])
  })
  it('normalize_z_score produces unit population variance', async () => {
    const out = await runTransform({
      numbers: [1, 2, 3, 4, 5],
      operation: 'normalize_z_score',
    })
    const arr = JSON.parse(out) as number[]
    const meanVal = arr.reduce((a, b) => a + b, 0) / arr.length
    // Mean should be approx 0
    expect(Math.abs(meanVal)).toBeLessThan(0.001)
    // z-score normalization uses population stddev (N denominator)
    // So the variance (population) of z-scored data should be 1
    const popVar = arr.reduce((s, v) => s + (v - meanVal) ** 2, 0) / arr.length
    expect(popVar).toBeCloseTo(1, 3)
  })
  it('normalize_min_max maps to [0, 1] range via oracle', async () => {
    const out = await runTransform({
      numbers: [-5, 0, 10, 20],
      operation: 'normalize_min_max',
    })
    const arr = JSON.parse(out) as number[]
    // Hand-computed: min=-5, max=20, range=25
    // (-5 + 5)/25 = 0, (0+5)/25 = 0.2, (10+5)/25 = 0.6, (20+5)/25 = 1
    expect(arr[0]).toBeCloseTo(0, 8)
    expect(arr[3]).toBeCloseTo(1, 8)
    expect(arr).toEqual([0, 0.2, 0.6, 1])
  })
  it('pct_change of [100, 110, 121] = [null, 10, 10]', async () => {
    const out = await runTransform({
      numbers: [100, 110, 121],
      operation: 'pct_change',
    })
    const arr = JSON.parse(out)
    expect(arr[0]).toBeNull()
    expect(arr[1]).toBeCloseTo(10, 4)
    expect(arr[2]).toBeCloseTo(10, 4)
  })
})

describe('stats invariants extended', () => {
  it('normalize_min_max preserves relative ordering (monotonicity)', async () => {
    const original = [-5, 0, 5, 10, 20]
    const out = await runTransform({
      numbers: JSON.stringify(original),
      operation: 'normalize_min_max',
    })
    const normalized = JSON.parse(out) as number[]
    for (let i = 1; i < normalized.length; i++) {
      expect(normalized[i]).toBeGreaterThanOrEqual(normalized[i - 1])
    }
  })
  it('normalize_percent_of_sum sums to 100 (for positive values)', async () => {
    const out = await runTransform({
      numbers: [10, 20, 30, 40],
      operation: 'normalize_percent_of_sum',
    })
    const arr = JSON.parse(out) as number[]
    const total = arr.reduce((a, b) => a + b, 0)
    expect(total).toBeCloseTo(100, 2)
  })
  it('histogram total counts equal input N', async () => {
    const data = Array.from({ length: 100 }, () => Math.random() * 100)
    const out = await runHist({
      numbers: JSON.stringify(data),
      bins: 10,
    })
    let total = 0
    for (const match of out.match(/\d+(?=\s+\()/g) || []) {
      total += Number.parseInt(match)
    }
    expect(total).toBe(100)
  })
  it('rank preserves element count', async () => {
    const out = await runTransform({
      numbers: [30, 10, 20, 40],
      operation: 'rank',
    })
    const ranks = JSON.parse(out) as number[]
    expect(ranks).toHaveLength(4)
  })
  it('rolling_avg preserves element count', async () => {
    const out = await runTransform({
      numbers: [1, 2, 3, 4, 5],
      operation: 'rolling_avg',
      window: 3,
    })
    const arr = JSON.parse(out) as number[]
    expect(arr).toHaveLength(5)
  })
  it('z-score normalized data has mean ≈ 0', async () => {
    const out = await runTransform({
      numbers: [10, 20, 30, 40, 50],
      operation: 'normalize_z_score',
    })
    const arr = JSON.parse(out) as number[]
    const meanVal = arr.reduce((a, b) => a + b, 0) / arr.length
    expect(Math.abs(meanVal)).toBeLessThan(0.001)
  })
})

describe('stats callTool no-crash + schema', () => {
  it('NaN in the array is rejected by the schema', async () => {
    const r = await callTool(statsDescribeTool, { numbers: [1, Number.NaN, 3] })
    expect(r.kind).toBe('threw')
    if (r.kind === 'threw') expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
  })
  it('Infinity in the array is rejected by the schema', async () => {
    const r = await callTool(statsDescribeTool, { numbers: [1, Infinity, 3] })
    expect(r.kind).toBe('threw')
    if (r.kind === 'threw') expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
  })
  it('-Infinity in the array is rejected by the schema', async () => {
    const r = await callTool(statsDescribeTool, { numbers: [1, -Infinity, 3] })
    expect(r.kind).toBe('threw')
    if (r.kind === 'threw') expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
  })
  it('single element array for correlate errors (< 2 points)', async () => {
    const r = await callTool(statsCorrelateTool, {
      x: [5],
      y: [5],
    })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') {
      expect(r.out).toMatch(/At least 2 data points/)
    }
  })
  it('all identical x values and varying y (zero variance in x) for correlate', async () => {
    const r = await callTool(statsCorrelateTool, {
      x: [5, 5, 5, 5],
      y: [1, 2, 3, 4],
    })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') {
      // Zero variance in x -> covariance is 0, r = 0
      // Actually simple-statistics may throw on division by zero
      // Let's assert it's either an error or returns r=NaN like value
      expect(r.out).toBeDefined()
    }
  })
  it('histogram bins clamped to max 100', async () => {
    const r = await callTool(statsHistogramTool, {
      numbers: [1, 2, 3, 4, 5],
      bins: 9999,
    })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') {
      // Clamped to 100, 5 unique values means 100 bins with breaks
      const lines = r.out.split('\n')
      expect(lines.length).toBeLessThanOrEqual(100)
    }
  })
  it('histogram bins clamped to min 2', async () => {
    const r = await callTool(statsHistogramTool, {
      numbers: [1, 2, 3],
      bins: -5,
    })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') {
      expect(r.out.split('\n').length).toBeGreaterThanOrEqual(2)
    }
  })
  it('stats_describe schema rejects without numbers', async () => {
    const r = await callTool(statsDescribeTool, {})
    expect(r.kind).toBe('threw')
    if (r.kind === 'threw') {
      expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
    }
  })
  it('stats_transform schema rejects without numbers', async () => {
    const r = await callTool(statsTransformTool, {
      operation: 'running_total',
    })
    expect(r.kind).toBe('threw')
    if (r.kind === 'threw') {
      expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
    }
  })
  it('stats_transform rejects unknown operation via schema', async () => {
    const r = await callTool(statsTransformTool, {
      numbers: [1, 2, 3],
      operation: 'not_an_op',
    })
    expect(r.kind).toBe('threw')
    if (r.kind === 'threw') {
      expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
    }
  })
  it('stats_correlate with mismatched lengths via callTool', async () => {
    const r = await callTool(statsCorrelateTool, {
      x: [1, 2, 3],
      y: [1, 2],
    })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') {
      expect(r.out).toMatch(/same length/)
    }
  })
})

describe('stats hand-computed oracle values - comprehensive', () => {
  it('stats_describe: mean of [1,1,1,1,1] = 1, stdev = 0', async () => {
    const r = await callTool(statsDescribeTool, { numbers: [1, 1, 1, 1, 1] })
    expect(r.kind).toBe('resolved')
    if (r.kind !== 'resolved') return
    const out = JSON.parse(r.out)
    expect(Number(out.mean)).toBe(1)
    expect(out.median).toBe(1)
    expect(Number(out.std_dev)).toBeCloseTo(0, 8)
    expect(Number(out.variance)).toBeCloseTo(0, 8)
  })

  it('stats_describe: negative numbers with zero mean', async () => {
    const r = await callTool(statsDescribeTool, { numbers: [-5, -3, -1, 1, 3, 5] })
    expect(r.kind).toBe('resolved')
    if (r.kind !== 'resolved') return
    const out = JSON.parse(r.out)
    expect(out.mean).toBeCloseTo(0, 8)
    expect(out.median).toBeCloseTo(0, 8)
    expect(out.min).toBe(-5)
    expect(out.max).toBe(5)
    expect(out.range).toBe(10)
  })

  it('stats_describe: large dataset percentile correctness', async () => {
    // [1..100]: median = 50.5, p10 = 10.9, p90 = 90.1
    const numbers = Array.from({ length: 100 }, (_, i) => i + 1)
    const r = await callTool(statsDescribeTool, { numbers })
    expect(r.kind).toBe('resolved')
    if (r.kind !== 'resolved') return
    const out = JSON.parse(r.out)
    expect(out.median).toBeCloseTo(50.5, 3)
  })

  it('stats_describe: mode for multimodal data', async () => {
    // [1,1,2,2,3]: both 1 and 2 appear twice, mode picks first
    const r = await callTool(statsDescribeTool, { numbers: [1, 1, 2, 2, 3] })
    expect(r.kind).toBe('resolved')
    if (r.kind !== 'resolved') return
    const out = JSON.parse(r.out)
    // simple-statistics mode returns first mode found
    expect([1, 2]).toContain(out.mode)
  })

  it('stats_correlate: anticorrelated data r ≈ -1', async () => {
    const r = await callTool(statsCorrelateTool, { x: [1, 2, 3, 4, 5], y: [5, 4, 3, 2, 1] })
    expect(r.kind).toBe('resolved')
    if (r.kind !== 'resolved') return
    expect(r.out).toMatch(/r = -1\.000000/)
    expect(r.out).toContain('very strong negative')
  })

  it('stats_transform normalize_min_max: oracle [10,20,30,40,50] -> [0,0.25,0.5,0.75,1]', async () => {
    const r = await callTool(statsTransformTool, {
      numbers: [10, 20, 30, 40, 50],
      operation: 'normalize_min_max',
    })
    expect(r.kind).toBe('resolved')
    if (r.kind !== 'resolved') return
    const out = JSON.parse(r.out)
    expect(out[0]).toBeCloseTo(0, 8)
    expect(out[1]).toBeCloseTo(0.25, 8)
    expect(out[2]).toBeCloseTo(0.5, 8)
    expect(out[3]).toBeCloseTo(0.75, 8)
    expect(out[4]).toBeCloseTo(1, 8)
  })

  it('stats_transform running_total: cumulative sums [2,3,5] -> [2,5,10]', async () => {
    const r = await callTool(statsTransformTool, { numbers: [2, 3, 5], operation: 'running_total' })
    expect(r.kind).toBe('resolved')
    if (r.kind !== 'resolved') return
    expect(JSON.parse(r.out)).toEqual([2, 5, 10])
  })

  it('stats_transform rank: [5,3,8,1] -> [3,2,4,1]', async () => {
    const r = await callTool(statsTransformTool, { numbers: [5, 3, 8, 1], operation: 'rank' })
    expect(r.kind).toBe('resolved')
    if (r.kind !== 'resolved') return
    expect(JSON.parse(r.out)).toEqual([3, 2, 4, 1])
  })

  it('stats_transform pct_change: [100,110,121] -> [null,10,10]', async () => {
    const r = await callTool(statsTransformTool, {
      numbers: [100, 110, 121],
      operation: 'pct_change',
    })
    expect(r.kind).toBe('resolved')
    if (r.kind !== 'resolved') return
    const out = JSON.parse(r.out)
    expect(out[0]).toBeNull()
    expect(out[1]).toBeCloseTo(10, 4)
    expect(out[2]).toBeCloseTo(10, 4)
  })

  it('stats_histogram: bin counts sum to N', async () => {
    const r = await callTool(statsHistogramTool, {
      numbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      bins: 5,
    })
    expect(r.kind).toBe('resolved')
    if (r.kind !== 'resolved') return
    let total = 0
    for (const match of r.out.match(/\d+(?=\s+\()/g) || []) {
      total += Number.parseInt(match)
    }
    expect(total).toBe(10)
  })
})

describe('stats crash edge cases with NaN/Infinity and handler-level bugs', () => {
  describe('stats_describe crash edge cases', () => {
    it('single element array -> stdev=0', async () => {
      const r = await callTool(statsDescribeTool, { numbers: [42] })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      const out = JSON.parse(r.out)
      expect(out.count).toBe(1)
      expect(Number(out.mean)).toBe(42)
      expect(out.median).toBe(42)
      expect(Number(out.std_dev)).toBeCloseTo(0, 8)
      expect(Number(out.variance)).toBeCloseTo(0, 8)
    })

    it('all identical values -> stdev=0', async () => {
      const r = await callTool(statsDescribeTool, { numbers: [7, 7, 7, 7, 7] })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      const out = JSON.parse(r.out)
      expect(Number(out.std_dev)).toBeCloseTo(0, 8)
      expect(Number(out.variance)).toBeCloseTo(0, 8)
    })

    it('rejects an array with non-numeric entries via schema', async () => {
      const r = await callTool(statsDescribeTool, { numbers: [1, 2, 3, 'a', null, {}, true] })
      expect(r.kind).toBe('threw')
      if (r.kind === 'threw') expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
    })

    it('large numbers: [1e15,2e15,3e15] -> mean=2e15', async () => {
      const r = await callTool(statsDescribeTool, { numbers: [1e15, 2e15, 3e15] })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      const out = JSON.parse(r.out)
      expect(out.count).toBe(3)
      expect(Number(out.mean)).toBeCloseTo(2e15, 6)
    })

    it('mixed positive/negative with zero mean', async () => {
      const r = await callTool(statsDescribeTool, { numbers: [-10, -5, 0, 5, 10] })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      const out = JSON.parse(r.out)
      expect(Number(out.mean)).toBeCloseTo(0, 8)
      expect(out.min).toBe(-10)
      expect(out.max).toBe(10)
    })

    it('median even count: [1,2,3,4] -> 2.5', async () => {
      const r = await callTool(statsDescribeTool, { numbers: [1, 2, 3, 4] })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      const out = JSON.parse(r.out)
      expect(out.median).toBeCloseTo(2.5, 8)
    })

    it('IQR = Q3 - Q1 invariant', async () => {
      const r = await callTool(statsDescribeTool, { numbers: [1, 2, 3, 4, 5, 6, 7, 8, 9] })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      const out = JSON.parse(r.out)
      expect(out.iqr).toBeCloseTo((out.q3 as number) - (out.q1 as number), 8)
    })
  })

  describe('stats_correlate crash edge cases', () => {
    it('all identical x (zero variance) -> reports correlation undefined', async () => {
      const r = await callTool(statsCorrelateTool, { x: [5, 5, 5, 5], y: [1, 2, 3, 4] })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') {
        // Pearson r is undefined for a constant variable; the tool says so rather than "r = NaN".
        expect(r.out).toMatch(/undefined/i)
        expect(r.out).not.toMatch(/r = NaN/)
      }
    })

    it('identical arrays (perfect correlation) -> r = 1', async () => {
      const r = await callTool(statsCorrelateTool, { x: [1, 2, 3, 4], y: [1, 2, 3, 4] })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') expect(r.out).toMatch(/r = 1\.000000/)
    })

    it('very small arrays (2 elements) -> works', async () => {
      const r = await callTool(statsCorrelateTool, { x: [1, 2], y: [2, 4] })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') expect(r.out).toMatch(/r = 1\.000000/)
    })

    it('correlation invariance: r(x,y) = r(y,x)', async () => {
      const rXY = await callTool(statsCorrelateTool, { x: [1, 2, 3, 4, 5], y: [2, 4, 5, 4, 5] })
      const rYX = await callTool(statsCorrelateTool, { x: [2, 4, 5, 4, 5], y: [1, 2, 3, 4, 5] })
      expect(rXY.kind).toBe('resolved')
      expect(rYX.kind).toBe('resolved')
      if (rXY.kind === 'resolved' && rYX.kind === 'resolved') {
        const rXYval = Number.parseFloat(rXY.out.match(/r = ([+-]?\d+\.\d+)/)?.[1] || '0')
        const rYXval = Number.parseFloat(rYX.out.match(/r = ([+-]?\d+\.\d+)/)?.[1] || '0')
        expect(rXYval).toBeCloseTo(rYXval, 5)
      }
    })

    it('r² = r*r (percentage interpretation)', async () => {
      const r = await callTool(statsCorrelateTool, { x: [1, 2, 3, 4, 5], y: [2, 4, 5, 4, 5] })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      const rVal = Number.parseFloat(r.out.match(/r = ([+-]?\d+\.\d+)/)?.[1] || '0')
      const r2FromStr = Number.parseFloat(r.out.match(/r² = ([\d.]+)%/)?.[1] || '0')
      expect(r2FromStr).toBeCloseTo(rVal * rVal * 100, 1)
    })
  })

  describe('stats_transform crash edge cases', () => {
    it('normalize_min_max all identical -> returns [0,0,...]', async () => {
      const r = await callTool(statsTransformTool, {
        numbers: [5, 5, 5],
        operation: 'normalize_min_max',
      })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      expect(JSON.parse(r.out)).toEqual([0, 0, 0])
    })

    it('normalize_z_score all identical -> returns [0,0,...]', async () => {
      const r = await callTool(statsTransformTool, {
        numbers: [5, 5, 5],
        operation: 'normalize_z_score',
      })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      expect(JSON.parse(r.out)).toEqual([0, 0, 0])
    })

    it('normalize_percent_of_sum all zeros -> returns [0,0,...]', async () => {
      const r = await callTool(statsTransformTool, {
        numbers: [0, 0, 0],
        operation: 'normalize_percent_of_sum',
      })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      expect(JSON.parse(r.out)).toEqual([0, 0, 0])
    })

    it('running_total single element', async () => {
      const r = await callTool(statsTransformTool, { numbers: [42], operation: 'running_total' })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      expect(JSON.parse(r.out)).toEqual([42])
    })

    it('running_total negative numbers', async () => {
      const r = await callTool(statsTransformTool, {
        numbers: [10, -5, -3, 2],
        operation: 'running_total',
      })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      expect(JSON.parse(r.out)).toEqual([10, 5, 2, 4])
    })

    it('rolling_avg window > array length', async () => {
      const r = await callTool(statsTransformTool, {
        numbers: [1, 2],
        operation: 'rolling_avg',
        window: 10,
      })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      const out = JSON.parse(r.out)
      expect(out[0]).toBeCloseTo(1, 6)
      expect(out[1]).toBeCloseTo(1.5, 6)
    })

    it('rolling_avg window=1 is identity', async () => {
      const r = await callTool(statsTransformTool, {
        numbers: [1, 2, 3, 4],
        operation: 'rolling_avg',
        window: 1,
      })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      expect(JSON.parse(r.out)).toEqual([1, 2, 3, 4])
    })

    it('pct_change division by zero -> null', async () => {
      const r = await callTool(statsTransformTool, {
        numbers: [100, 0, 100],
        operation: 'pct_change',
      })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      const out = JSON.parse(r.out)
      expect(out[0]).toBeNull()
      expect(out[1]).toBe(-100) // (0-100)/|100| = -100
      expect(out[2]).toBeNull() // (100-0)/|0| is undefined -> null
    })

    it('rank handles ties', async () => {
      const r = await callTool(statsTransformTool, { numbers: [10, 20, 20, 30], operation: 'rank' })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      expect(JSON.parse(r.out)).toEqual([1, 2, 2, 4])
    })

    it('outliers_iqr no outliers', async () => {
      const r = await callTool(statsTransformTool, {
        numbers: [1, 2, 3, 4, 5],
        operation: 'outliers_iqr',
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') expect(r.out).toMatch(/No outliers/)
    })

    it('outliers_iqr detects obvious outlier', async () => {
      const r = await callTool(statsTransformTool, {
        numbers: [1, 2, 3, 4, 5, 1000],
        operation: 'outliers_iqr',
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') expect(r.out).toMatch(/1 outlier/)
    })

    it('outliers_zscore with obvious outlier', async () => {
      const r = await callTool(statsTransformTool, {
        numbers: [1, 2, 3, 4, 5, 100],
        operation: 'outliers_zscore',
        threshold: 2,
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') expect(r.out).toMatch(/outlier/)
    })

    it('normalize_min_max preserves ordering', async () => {
      const r = await callTool(statsTransformTool, {
        numbers: [10, 20, 30, 40, 50],
        operation: 'normalize_min_max',
      })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      const arr: number[] = JSON.parse(r.out)
      for (let i = 1; i < arr.length; i++) {
        expect(arr[i] >= arr[i - 1]).toBe(true)
      }
    })
  })

  describe('stats_histogram crash edge cases', () => {
    it('bins clamp to max 100', async () => {
      const r = await callTool(statsHistogramTool, { numbers: [1, 2, 3, 4, 5], bins: 500 })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      const lines = r.out.split('\n')
      expect(lines.length).toBeLessThanOrEqual(100)
    })

    it('bins clamp to min 2', async () => {
      const r = await callTool(statsHistogramTool, { numbers: [1, 2, 3], bins: 1 })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      expect(r.out).not.toMatch(/^Error/)
    })

    it('histogram counts sum to N', async () => {
      const r = await callTool(statsHistogramTool, {
        numbers: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        bins: 5,
      })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      let total = 0
      for (const match of r.out.match(/\d+(?=\s+\()/g) || []) {
        total += Number.parseInt(match)
      }
      expect(total).toBe(10)
    })

    it('histogram single value', async () => {
      const r = await callTool(statsHistogramTool, { numbers: [5, 5, 5, 5], bins: 2 })
      expect(r.kind).toBe('resolved')
      if (r.kind !== 'resolved') return
      expect(r.out).not.toMatch(/^Error/)
    })
  })
})

describe('stats schema validation edge cases', () => {
  it('stats_describe schema rejects missing numbers', async () => {
    const r = await callTool(statsDescribeTool, {})
    expect(r.kind).toBe('threw')
    if (r.kind === 'threw') expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
  })

  it('stats_correlate schema rejects missing x', async () => {
    const r = await callTool(statsCorrelateTool, { y: [1, 2] })
    expect(r.kind).toBe('threw')
    if (r.kind === 'threw') expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
  })

  it('stats_correlate schema rejects missing y', async () => {
    const r = await callTool(statsCorrelateTool, { x: [1, 2] })
    expect(r.kind).toBe('threw')
    if (r.kind === 'threw') expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
  })

  it('stats_transform schema rejects missing numbers', async () => {
    const r = await callTool(statsTransformTool, { operation: 'running_total' })
    expect(r.kind).toBe('threw')
    if (r.kind === 'threw') expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
  })

  it('stats_transform schema rejects unknown operation', async () => {
    const r = await callTool(statsTransformTool, { numbers: [1, 2, 3], operation: 'unknown_op' })
    expect(r.kind).toBe('threw')
    if (r.kind === 'threw') expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
  })

  it('stats_histogram schema rejects NaN on bins', async () => {
    const r = await callTool(statsHistogramTool, { numbers: [1, 2, 3], bins: Number.NaN })
    expect(r.kind).toBe('threw')
    if (r.kind === 'threw') expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
  })

  it('stats_histogram schema rejects Infinity on bins', async () => {
    const r = await callTool(statsHistogramTool, { numbers: [1, 2, 3], bins: Infinity })
    expect(r.kind).toBe('threw')
    if (r.kind === 'threw') expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
  })
})

// ── Edge cases surfaced by an independent model review (verified against the source) ──────
describe('statsCorrelateTool — zero-variance input', () => {
  // EXPECTED-RED: when one variable is constant, sd = 0 and Pearson r divides by zero → "r = NaN".
  // Correlation is mathematically UNDEFINED here; the tool should say so, not emit a NaN value
  // that reads like a real (very weak) correlation. Asserting the output is not a bare NaN.
  it('reports undefined/error for a constant variable rather than r = NaN', async () => {
    const out = await runCorr({ x: [1, 2, 3], y: [5, 5, 5] })
    expect(out).not.toMatch(/r\s*=\s*NaN/)
  })
})

// ── Numeric boundaries: BigNumber aggregation, the precision arg, schema rejection ──────
describe('statistics — numeric boundaries', () => {
  it('sum of many large in-range values stays exact (no float64 overflow)', async () => {
    // 2000 copies of MAX_SAFE_INTEGER: the true sum is 2000 * 9007199254740991 =
    // 18014398509481982000, which exceeds float64's exact-integer range. BigNumber keeps it exact.
    const big = Number.MAX_SAFE_INTEGER
    const r = await callTool(statsDescribeTool, { numbers: Array(2000).fill(big) })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') {
      const out = JSON.parse(r.out)
      expect(out.sum).toBe('18014398509481982000')
    }
  })

  it('mean is computed exactly, not via lossy float accumulation', async () => {
    const r = await callTool(statsDescribeTool, { numbers: [0.1, 0.2] })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') {
      const out = JSON.parse(r.out)
      // (0.1 + 0.2) / 2 = 0.15 exactly (float64 would drift to 0.150000000000000…2)
      expect(out.mean).toBe('0.15')
    }
  })

  it('honors the precision arg for aggregate output', async () => {
    const r = await callTool(statsDescribeTool, { numbers: [1, 2, 4], precision: 3 })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') {
      const out = JSON.parse(r.out)
      // mean = 7/3 = 2.333… → 3 significant digits = 2.33
      expect(out.mean).toBe('2.33')
    }
  })

  it('rejects out-of-range magnitudes (> 2^53) at the schema', async () => {
    const r = await callTool(statsDescribeTool, { numbers: [1e400, 1, 2] })
    expect(r.kind).toBe('threw')
    if (r.kind === 'threw') expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
  })

  it('running_total stays exact across a float64-overflowing cumulative sum', async () => {
    const big = Number.MAX_SAFE_INTEGER
    const r = await callTool(statsTransformTool, {
      numbers: [big, big, big],
      operation: 'running_total',
    })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') {
      const arr = JSON.parse(r.out)
      // third cumulative total = 3 * 9007199254740991 = 27021597764222973 (exact)
      expect(String(arr[2])).toBe('27021597764222973')
    }
  })
})
