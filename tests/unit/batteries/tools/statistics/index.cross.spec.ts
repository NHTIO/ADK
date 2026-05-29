import { describe, expect, it } from 'vitest'
import { makeToolCtxStub } from '../../../../_fixtures/tool_ctx_stub'
import { E_INVALID_TOOL_ARGS } from '../../../../../src/lib/exceptions/runtime'
import { SpooledJsonArtifact } from '../../../../../src/lib/classes/spooled_json_artifact'
import {
  statsCorrelateTool,
  statsDescribeTool,
  statsHistogramTool,
  statsTransformTool,
} from '../../../../../src/batteries/tools/statistics'

const runDescribe = async (numbers: string): Promise<Record<string, unknown>> => {
  const out = (await statsDescribeTool.executor(makeToolCtxStub())({
    numbers,
  })) as string
  return JSON.parse(out) as Record<string, unknown>
}
const runCorr = async (args: Record<string, unknown>): Promise<string> => {
  return (await statsCorrelateTool.executor(makeToolCtxStub())(args)) as string
}
const runTransform = async (args: Record<string, unknown>): Promise<string> => {
  return (await statsTransformTool.executor(makeToolCtxStub())(args)) as string
}
const runHist = async (args: Record<string, unknown>): Promise<string> => {
  return (await statsHistogramTool.executor(makeToolCtxStub())(args)) as string
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

  it('errors on invalid JSON', async () => {
    const out = (await statsDescribeTool.executor(makeToolCtxStub())({
      numbers: 'not json',
    })) as string
    expect(out).toMatch(/^Error/)
  })

  it('errors on non-array input', async () => {
    const out = (await statsDescribeTool.executor(makeToolCtxStub())({
      numbers: '{}',
    })) as string
    expect(out).toMatch(/^Error/)
  })

  it('errors when no finite numbers are present', async () => {
    const out = (await statsDescribeTool.executor(makeToolCtxStub())({
      numbers: '["a", "b"]',
    })) as string
    expect(out).toMatch(/No finite numbers/)
  })
})

describe('statsCorrelateTool', () => {
  it('returns r ≈ 1 for perfectly correlated arrays', async () => {
    const out = await runCorr({ x: '[1,2,3,4,5]', y: '[2,4,6,8,10]' })
    expect(out).toMatch(/r = 1\.000000/)
    expect(out).toContain('very strong positive')
  })

  it('returns r ≈ -1 for perfect inverse correlation', async () => {
    const out = await runCorr({ x: '[1,2,3,4,5]', y: '[5,4,3,2,1]' })
    expect(out).toMatch(/r = -1\.000000/)
    expect(out).toContain('very strong negative')
  })

  it('errors on mismatched array lengths', async () => {
    const out = await runCorr({ x: '[1,2,3]', y: '[1,2]' })
    expect(out).toMatch(/same length/)
  })

  it('requires at least 2 data points', async () => {
    const out = await runCorr({ x: '[1]', y: '[2]' })
    expect(out).toMatch(/At least 2 data points/)
  })

  it('propagates parse errors with prefix', async () => {
    const out = await runCorr({ x: 'bad', y: '[1,2]' })
    expect(out).toMatch(/^Error in x/)
  })
})

describe('statsTransformTool', () => {
  it('normalize_min_max scales to [0,1]', async () => {
    const out = await runTransform({
      numbers: '[0, 50, 100]',
      operation: 'normalize_min_max',
    })
    expect(JSON.parse(out)).toEqual([0, 0.5, 1])
  })

  it('normalize_z_score centers around 0', async () => {
    const out = await runTransform({
      numbers: '[1, 2, 3, 4, 5]',
      operation: 'normalize_z_score',
    })
    const arr = JSON.parse(out) as number[]
    // Mean should be approximately 0
    expect(Math.abs(arr.reduce((a, b) => a + b, 0))).toBeLessThan(0.001)
  })

  it('normalize_percent_of_sum sums to 100', async () => {
    const out = await runTransform({
      numbers: '[10, 20, 30, 40]',
      operation: 'normalize_percent_of_sum',
    })
    const arr = JSON.parse(out) as number[]
    expect(arr).toEqual([10, 20, 30, 40])
  })

  it('running_total accumulates', async () => {
    const out = await runTransform({
      numbers: '[1, 2, 3, 4]',
      operation: 'running_total',
    })
    expect(JSON.parse(out)).toEqual([1, 3, 6, 10])
  })

  it('rolling_avg with window 2', async () => {
    const out = await runTransform({
      numbers: '[1, 2, 3, 4]',
      operation: 'rolling_avg',
      window: 2,
    })
    expect(JSON.parse(out)).toEqual([1, 1.5, 2.5, 3.5])
  })

  it('pct_change first entry is null', async () => {
    const out = await runTransform({
      numbers: '[100, 110, 99]',
      operation: 'pct_change',
    })
    const arr = JSON.parse(out)
    expect(arr[0]).toBeNull()
    expect(arr[1]).toBe(10)
  })

  it('rank assigns 1-based ranks by ascending value', async () => {
    const out = await runTransform({
      numbers: '[30, 10, 20]',
      operation: 'rank',
    })
    expect(JSON.parse(out)).toEqual([3, 1, 2])
  })

  it('outliers_iqr detects an obvious outlier', async () => {
    const out = await runTransform({
      numbers: '[1, 2, 3, 4, 5, 100]',
      operation: 'outliers_iqr',
    })
    expect(out).toMatch(/1 outlier/)
    expect(out).toContain('= 100')
  })

  it('outliers_zscore returns a no-outlier message when below threshold', async () => {
    const out = await runTransform({
      numbers: '[1, 2, 3, 4, 5]',
      operation: 'outliers_zscore',
    })
    expect(out).toMatch(/No outliers/)
  })

  it('schema rejects unknown operation', async () => {
    await expect(runTransform({ numbers: '[1,2,3]', operation: 'rumba' })).rejects.toBeInstanceOf(
      E_INVALID_TOOL_ARGS
    )
  })
})

describe('statsHistogramTool', () => {
  it('produces one row per bin with counts and bars', async () => {
    const out = await runHist({
      numbers: '[1,2,3,4,5,6,7,8,9,10]',
      bins: 5,
    })
    expect(out.split('\n')).toHaveLength(5)
    expect(out).toMatch(/█+/)
  })

  it('clamps bins to [2, 100]', async () => {
    const out = await runHist({
      numbers: '[1,2,3,4,5]',
      bins: 500,
    })
    // Result should not exceed 100 bins (5 unique values means most bins will be 0)
    expect(out.split('\n').length).toBeLessThanOrEqual(100)
  })

  it('errors on invalid JSON', async () => {
    const out = await runHist({ numbers: 'nope' })
    expect(out).toMatch(/^Error/)
  })
})
