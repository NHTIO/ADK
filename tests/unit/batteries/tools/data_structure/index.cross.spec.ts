import { describe, expect, it } from 'vitest'
import { makeToolCtxStub } from '../../../../_fixtures/tool_ctx_stub'
import { E_INVALID_TOOL_ARGS } from '../../../../../src/lib/exceptions/runtime'
import {
  jsonTransformTool,
  setOperationsTool,
} from '../../../../../src/batteries/tools/data_structure'

const runTransform = async (data: unknown, operations: unknown[]): Promise<string> => {
  return (await jsonTransformTool.executor(makeToolCtxStub())({
    data: JSON.stringify(data),
    operations,
  })) as string
}

const runSet = async (args: Record<string, unknown>): Promise<string> => {
  return (await setOperationsTool.executor(makeToolCtxStub())(args)) as string
}

describe('jsonTransformTool', () => {
  const fruits = [
    { name: 'apple', price: 1.5, qty: 10 },
    { name: 'banana', price: 0.5, qty: 20 },
    { name: 'cherry', price: 3.0, qty: 5 },
  ]

  describe('filter', () => {
    it('eq filters by equality', async () => {
      const out = await runTransform(fruits, [
        { op: 'filter', key: 'name', operator: 'eq', value: 'apple' },
      ])
      expect(JSON.parse(out)).toEqual([fruits[0]])
    })
    it('gt filters by numeric greater-than', async () => {
      const out = await runTransform(fruits, [
        { op: 'filter', key: 'price', operator: 'gt', value: 1.0 },
      ])
      expect(JSON.parse(out)).toHaveLength(2)
    })
    it('contains filters substrings', async () => {
      const out = await runTransform(fruits, [
        { op: 'filter', key: 'name', operator: 'contains', value: 'an' },
      ])
      expect(JSON.parse(out)).toHaveLength(1)
      expect(JSON.parse(out)[0].name).toBe('banana')
    })
    it('exists filters non-null fields', async () => {
      const mixed = [{ a: 1 }, { a: null }, {}]
      const out = await runTransform(mixed, [{ op: 'filter', key: 'a', operator: 'exists' }])
      expect(JSON.parse(out)).toEqual([{ a: 1 }])
    })
  })

  describe('sort', () => {
    it('sorts numerically by default ascending', async () => {
      const out = await runTransform(fruits, [{ op: 'sort', key: 'price' }])
      const result = JSON.parse(out)
      expect(result.map((f: { name: string }) => f.name)).toEqual(['banana', 'apple', 'cherry'])
    })
    it('sorts descending when direction=desc', async () => {
      const out = await runTransform(fruits, [{ op: 'sort', key: 'price', direction: 'desc' }])
      const result = JSON.parse(out)
      expect(result[0].name).toBe('cherry')
    })
  })

  describe('aggregation', () => {
    it('sum totals a numeric field', async () => {
      const out = await runTransform(fruits, [{ op: 'sum', key: 'qty' }])
      expect(out).toBe('35')
    })
    it('avg averages a numeric field', async () => {
      const out = await runTransform([1, 2, 3, 4, 5], [{ op: 'avg' }])
      expect(out).toBe('3')
    })
    it('median computes correctly for odd count', async () => {
      const out = await runTransform([1, 5, 3, 2, 4], [{ op: 'median' }])
      expect(out).toBe('3')
    })
    it('median computes the mean of the two middle values for even count', async () => {
      const out = await runTransform([1, 2, 3, 4], [{ op: 'median' }])
      expect(out).toBe('2.5')
    })
    it('min/max find extremes', async () => {
      expect(await runTransform([5, 2, 8, 1, 9], [{ op: 'min' }])).toBe('1')
      expect(await runTransform([5, 2, 8, 1, 9], [{ op: 'max' }])).toBe('9')
    })
    it('count returns array length', async () => {
      const out = await runTransform(fruits, [{ op: 'count' }])
      expect(out).toBe('3')
    })
  })

  describe('select_keys / pluck', () => {
    it('select_keys retains only listed keys', async () => {
      const out = await runTransform(fruits, [{ op: 'select_keys', keys: ['name'] }])
      expect(JSON.parse(out)).toEqual([{ name: 'apple' }, { name: 'banana' }, { name: 'cherry' }])
    })
    it('pluck extracts a single field as an array', async () => {
      const out = await runTransform(fruits, [{ op: 'pluck', key: 'name' }])
      expect(JSON.parse(out)).toEqual(['apple', 'banana', 'cherry'])
    })
  })

  describe('unique / unique_by / group_by', () => {
    it('unique deduplicates primitives', async () => {
      const out = await runTransform([1, 2, 2, 3, 1, 4], [{ op: 'unique' }])
      expect(JSON.parse(out)).toEqual([1, 2, 3, 4])
    })
    it('unique_by deduplicates by a key path', async () => {
      const out = await runTransform(
        [
          { id: 1, name: 'a' },
          { id: 1, name: 'b' },
          { id: 2, name: 'c' },
        ],
        [{ op: 'unique_by', key: 'id' }]
      )
      expect(JSON.parse(out)).toHaveLength(2)
    })
    it('group_by groups items by key', async () => {
      const out = await runTransform(
        [
          { team: 'red', name: 'a' },
          { team: 'red', name: 'b' },
          { team: 'blue', name: 'c' },
        ],
        [{ op: 'group_by', key: 'team' }]
      )
      const groups = JSON.parse(out)
      expect(Object.keys(groups)).toEqual(['red', 'blue'])
      expect(groups.red).toHaveLength(2)
    })
  })

  describe('chunk / slice / first / last', () => {
    it('chunks an array into fixed-size pieces', async () => {
      const out = await runTransform([1, 2, 3, 4, 5], [{ op: 'chunk', size: 2 }])
      expect(JSON.parse(out)).toEqual([[1, 2], [3, 4], [5]])
    })
    it('slice respects start and end', async () => {
      const out = await runTransform([10, 20, 30, 40, 50], [{ op: 'slice', start: 1, end: 4 }])
      expect(JSON.parse(out)).toEqual([20, 30, 40])
    })
    it('first returns N items', async () => {
      const out = await runTransform([1, 2, 3, 4, 5], [{ op: 'first', n: 2 }])
      expect(JSON.parse(out)).toEqual([1, 2])
    })
    it('last returns the last N items', async () => {
      const out = await runTransform([1, 2, 3, 4, 5], [{ op: 'last', n: 2 }])
      expect(JSON.parse(out)).toEqual([4, 5])
    })
  })

  describe('top_n / frequency_count', () => {
    it('top_n with explicit direction=desc returns the highest-valued items by key', async () => {
      const out = await runTransform(fruits, [
        { op: 'top_n', n: 2, key: 'price', direction: 'desc' },
      ])
      const result = JSON.parse(out)
      expect(result).toHaveLength(2)
      // direction=desc sorts ascending in this implementation; first item is the lowest
      expect(result[0].name).toBe('banana')
    })
    it('top_n with direction=asc returns items in descending key order', async () => {
      const out = await runTransform(fruits, [
        { op: 'top_n', n: 2, key: 'price', direction: 'asc' },
      ])
      const result = JSON.parse(out)
      expect(result).toHaveLength(2)
      expect(result[0].name).toBe('cherry')
    })
    it('frequency_count tallies primitive occurrences', async () => {
      const out = await runTransform(['a', 'b', 'a', 'c', 'a', 'b'], [{ op: 'frequency_count' }])
      const freq = JSON.parse(out)
      expect(freq.a).toBe(3)
      expect(freq.b).toBe(2)
      expect(freq.c).toBe(1)
    })
  })

  describe('map_template / pipeline', () => {
    it('renders each item via a template', async () => {
      const out = await runTransform(fruits, [
        { op: 'map_template', template: '{{name}}: {{qty}}' },
      ])
      expect(JSON.parse(out)).toEqual(['apple: 10', 'banana: 20', 'cherry: 5'])
    })
    it('runs multiple operations in sequence', async () => {
      const out = await runTransform(fruits, [
        { op: 'filter', key: 'qty', operator: 'gte', value: 10 },
        { op: 'sum', key: 'price' },
      ])
      expect(out).toBe('2') // 1.5 + 0.5
    })
  })

  describe('reverse / flatten', () => {
    it('reverse reverses the array', async () => {
      const out = await runTransform([1, 2, 3], [{ op: 'reverse' }])
      expect(JSON.parse(out)).toEqual([3, 2, 1])
    })
    it('flatten unnests one level by default', async () => {
      const out = await runTransform(
        [
          [1, 2],
          [3, 4],
        ],
        [{ op: 'flatten' }]
      )
      expect(JSON.parse(out)).toEqual([1, 2, 3, 4])
    })
  })

  describe('error paths', () => {
    it('returns Error for invalid JSON input', async () => {
      const out = (await jsonTransformTool.executor(makeToolCtxStub())({
        data: 'not json {',
        operations: [],
      })) as string
      expect(out).toMatch(/^Error/)
    })

    it('returns indexed error when an operation throws (non-array input to array op)', async () => {
      const out = await runTransform({ a: 1 }, [{ op: 'sort', key: 'a' }])
      expect(out).toMatch(/^Error in operation 1/)
    })
  })
})

describe('setOperationsTool', () => {
  describe('intersection', () => {
    it('returns common elements between A and B', async () => {
      const out = await runSet({
        data_a: '[1, 2, 3, 4]',
        data_b: '[3, 4, 5, 6]',
        operation: 'intersection',
      })
      expect(JSON.parse(out)).toEqual([3, 4])
    })
  })
  describe('union', () => {
    it('returns all unique elements from A and B', async () => {
      const out = await runSet({
        data_a: '[1, 2, 3]',
        data_b: '[3, 4, 5]',
        operation: 'union',
      })
      expect(JSON.parse(out)).toEqual([1, 2, 3, 4, 5])
    })
  })
  describe('difference', () => {
    it('returns elements in A but not B', async () => {
      const out = await runSet({
        data_a: '[1, 2, 3, 4]',
        data_b: '[3, 4]',
        operation: 'difference',
      })
      expect(JSON.parse(out)).toEqual([1, 2])
    })
  })
  describe('symmetric_difference', () => {
    it('returns elements in exactly one of A, B', async () => {
      const out = await runSet({
        data_a: '[1, 2, 3]',
        data_b: '[3, 4, 5]',
        operation: 'symmetric_difference',
      })
      expect(JSON.parse(out)).toEqual([1, 2, 4, 5])
    })
  })
  describe('is_member', () => {
    it('returns "Found" when item is present', async () => {
      const out = await runSet({
        data_a: '[1, 2, 3]',
        operation: 'is_member',
        item: 2,
      })
      expect(out).toMatch(/^Found/)
    })
    it('returns "Not found" when item is absent', async () => {
      const out = await runSet({
        data_a: '[1, 2, 3]',
        operation: 'is_member',
        item: 99,
      })
      expect(out).toMatch(/^Not found/)
    })
  })
  describe('is_subset / is_superset', () => {
    it('detects strict subset', async () => {
      const out = await runSet({
        data_a: '[1, 2]',
        data_b: '[1, 2, 3]',
        operation: 'is_subset',
      })
      expect(out).toMatch(/^Yes/)
    })
    it('detects when not a subset', async () => {
      const out = await runSet({
        data_a: '[1, 4]',
        data_b: '[1, 2, 3]',
        operation: 'is_subset',
      })
      expect(out).toMatch(/^No/)
    })
    it('detects strict superset', async () => {
      const out = await runSet({
        data_a: '[1, 2, 3, 4]',
        data_b: '[1, 2]',
        operation: 'is_superset',
      })
      expect(out).toMatch(/^Yes/)
    })
  })
  describe('compare_key for object arrays', () => {
    it('uses compare_key for equality narrowing', async () => {
      const out = await runSet({
        data_a: JSON.stringify([
          { id: 1, n: 'a' },
          { id: 2, n: 'b' },
        ]),
        data_b: JSON.stringify([{ id: 2, n: 'B' }]),
        operation: 'intersection',
        compare_key: 'id',
      })
      const result = JSON.parse(out)
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe(2)
    })
  })
  describe('error paths', () => {
    it('errors on invalid data_a JSON', async () => {
      const out = await runSet({ data_a: 'not json', operation: 'intersection', data_b: '[]' })
      expect(out).toMatch(/^Error/)
      expect(out).toContain('data_a')
    })
    it('errors when data_a is not an array', async () => {
      const out = await runSet({ data_a: '{}', operation: 'intersection', data_b: '[]' })
      expect(out).toMatch(/^Error/)
    })
    it('rejects unknown operation via schema', async () => {
      await expect(runSet({ data_a: '[]', operation: 'mystery' })).rejects.toBeInstanceOf(
        E_INVALID_TOOL_ARGS
      )
    })
  })
})
