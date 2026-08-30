import { describe, expect, it } from 'vitest'
import { callTool, makeToolCtxStub } from '../../../../_fixtures/tool_ctx_stub'
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
    it('ne filters by non-equality', async () => {
      const out = await runTransform(fruits, [
        { op: 'filter', key: 'name', operator: 'ne', value: 'apple' },
      ])
      expect(JSON.parse(out)).toHaveLength(2)
    })
    it('lt filters by less-than', async () => {
      const out = await runTransform(fruits, [
        { op: 'filter', key: 'price', operator: 'lt', value: 1.0 },
      ])
      expect(JSON.parse(out)).toHaveLength(1)
      expect(JSON.parse(out)[0].name).toBe('banana')
    })
    it('lte filters by less-than-or-equal', async () => {
      const out = await runTransform(fruits, [
        { op: 'filter', key: 'price', operator: 'lte', value: 0.5 },
      ])
      expect(JSON.parse(out)).toHaveLength(1)
      expect(JSON.parse(out)[0].name).toBe('banana')
    })
    it('starts_with filters prefix', async () => {
      const out = await runTransform(fruits, [
        { op: 'filter', key: 'name', operator: 'starts_with', value: 'ap' },
      ])
      expect(JSON.parse(out)).toHaveLength(1)
      expect(JSON.parse(out)[0].name).toBe('apple')
    })
    it('ends_with filters suffix', async () => {
      const out = await runTransform(fruits, [
        { op: 'filter', key: 'name', operator: 'ends_with', value: 'e' },
      ])
      // Only 'apple' ends with 'e' among the fruit names
      expect(JSON.parse(out)).toHaveLength(1)
      expect(JSON.parse(out)[0].name).toBe('apple')
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
    it('sorts alphabetically by string key ascending', async () => {
      const out = await runTransform(fruits, [{ op: 'sort', key: 'name' }])
      const result = JSON.parse(out)
      expect(result.map((f: { name: string }) => f.name)).toEqual(['apple', 'banana', 'cherry'])
    })
    it('sorts with null values last in ascending', async () => {
      const data = [{ name: 'a', val: 1 }, { name: 'b' }, { name: 'c', val: 2 }]
      const out = await runTransform(data, [{ op: 'sort', key: 'val' }])
      const result = JSON.parse(out)
      expect(result[0].name).toBe('a')
      expect(result[1].name).toBe('c')
      expect(result[2].name).toBe('b')
    })
    it('sorts with null values at end in descending', async () => {
      const data = [{ name: 'a', val: 1 }, { name: 'b' }, { name: 'c', val: 2 }]
      const out = await runTransform(data, [{ op: 'sort', key: 'val', direction: 'desc' }])
      const result = JSON.parse(out)
      expect(result[0].name).toBe('c')
      expect(result[1].name).toBe('a')
      expect(result[2].name).toBe('b')
    })
    it('sorts by dot-path nested keys', async () => {
      const data = [
        { id: 1, meta: { score: 80 } },
        { id: 2, meta: { score: 90 } },
      ]
      const out = await runTransform(data, [{ op: 'sort', key: 'meta.score' }])
      const result = JSON.parse(out)
      expect(result.map((f: { id: number }) => f.id)).toEqual([1, 2])
    })
    it('sort is stable - preserves order of equal elements', async () => {
      const data = [
        { id: 1, score: 100 },
        { id: 2, score: 100 },
        { id: 3, score: 100 },
      ]
      const out = await runTransform(data, [{ op: 'sort', key: 'score' }])
      const result = JSON.parse(out)
      expect(result.map((f: { id: number }) => f.id)).toEqual([1, 2, 3])
    })
  })

  describe('aggregation', () => {
    it('sum totals a numeric field', async () => {
      const out = await runTransform(fruits, [{ op: 'sum', key: 'qty' }])
      expect(out).toBe('35')
    })
    it('sum totals all elements without key', async () => {
      const out = await runTransform([1, 2, 3, 4, 5], [{ op: 'sum' }])
      expect(out).toBe('15')
    })
    it('sum handles non-numeric values as 0', async () => {
      const out = await runTransform([1, 'a', 2, null, 3], [{ op: 'sum' }])
      expect(out).toBe('6')
    })
    it('avg averages a numeric field', async () => {
      const out = await runTransform([1, 2, 3, 4, 5], [{ op: 'avg' }])
      expect(out).toBe('3')
    })
    it('avg returns null for empty array without key', async () => {
      const out = await runTransform([], [{ op: 'avg' }])
      expect(out).toBe('null')
    })
    it('avg handles non-numeric values by filtering them', async () => {
      const out = await runTransform([1, 'a', 3], [{ op: 'avg' }])
      expect(out).toBe('2')
    })
    it('median computes correctly for odd count', async () => {
      const out = await runTransform([1, 5, 3, 2, 4], [{ op: 'median' }])
      expect(out).toBe('3')
    })
    it('median computes the mean of the two middle values for even count', async () => {
      const out = await runTransform([1, 2, 3, 4], [{ op: 'median' }])
      expect(out).toBe('2.5')
    })
    it('median returns null for empty array', async () => {
      const out = await runTransform([], [{ op: 'median' }])
      expect(out).toBe('null')
    })
    it('min/max find extremes', async () => {
      expect(await runTransform([5, 2, 8, 1, 9], [{ op: 'min' }])).toBe('1')
      expect(await runTransform([5, 2, 8, 1, 9], [{ op: 'max' }])).toBe('9')
    })
    it('min/max return null for empty array', async () => {
      expect(await runTransform([], [{ op: 'min' }])).toBe('null')
      expect(await runTransform([], [{ op: 'max' }])).toBe('null')
    })
    it('count returns array length', async () => {
      const out = await runTransform(fruits, [{ op: 'count' }])
      expect(out).toBe('3')
    })
    it('count returns object key count', async () => {
      const out = await runTransform({ a: 1, b: 2, c: 3 }, [{ op: 'count' }])
      expect(out).toBe('3')
    })
    it('count returns 0 for scalar', async () => {
      const out = await runTransform(42, [{ op: 'count' }])
      expect(out).toBe('0')
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
    it('pluck handles missing key with null values', async () => {
      const data = [{ a: 1 }, { a: 2 }, { b: 3 }]
      const out = await runTransform(data, [{ op: 'pluck', key: 'a' }])
      expect(JSON.parse(out)).toEqual([1, 2, null])
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
    it('unique handles objects with JSON.stringify comparison', async () => {
      const data = [
        { a: 1, b: 2 },
        { a: 1, b: 2 },
        { a: 1, b: 3 },
      ]
      const out = await runTransform(data, [{ op: 'unique' }])
      expect(JSON.parse(out)).toHaveLength(2)
    })
    it('unique_by respects dot-path nested keys', async () => {
      const data = [
        { id: 1, meta: { type: 'a' } },
        { id: 2, meta: { type: 'a' } },
        { id: 3, meta: { type: 'b' } },
      ]
      const out = await runTransform(data, [{ op: 'unique_by', key: 'meta.type' }])
      const result = JSON.parse(out)
      expect(result).toHaveLength(2)
      expect(result[0].id).toBe(1)
      expect(result[1].id).toBe(3)
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
    it('chunk handles size 0 by using minimum size 1', async () => {
      const out = await runTransform([1, 2, 3], [{ op: 'chunk', size: 0 }])
      expect(JSON.parse(out)).toEqual([[1], [2], [3]])
    })
    it('chunk handles negative size by using minimum size 1', async () => {
      const out = await runTransform([1, 2, 3], [{ op: 'chunk', size: -5 }])
      expect(JSON.parse(out)).toEqual([[1], [2], [3]])
    })
    it('chunk handles empty array', async () => {
      const out = await runTransform([], [{ op: 'chunk', size: 2 }])
      expect(JSON.parse(out)).toEqual([])
    })
    it('slice handles out-of-bounds start', async () => {
      const out = await runTransform([1, 2, 3], [{ op: 'slice', start: 10 }])
      expect(JSON.parse(out)).toEqual([])
    })
    it('slice handles negative start (relative from end)', async () => {
      const out = await runTransform([1, 2, 3, 4, 5], [{ op: 'slice', start: -3 }])
      expect(JSON.parse(out)).toEqual([3, 4, 5])
    })
    it('first returns single item when n omitted', async () => {
      const out = await runTransform([1, 2, 3], [{ op: 'first' }])
      expect(JSON.parse(out)).toBe(1)
    })
    it('last returns single item when n omitted', async () => {
      const out = await runTransform([1, 2, 3], [{ op: 'last' }])
      expect(JSON.parse(out)).toBe(3)
    })
    it('first returns all items when n exceeds array length', async () => {
      const out = await runTransform([1, 2], [{ op: 'first', n: 10 }])
      expect(JSON.parse(out)).toEqual([1, 2])
    })
  })

  describe('top_n / frequency_count', () => {
    it('top_n with explicit direction=desc returns the highest-valued items by key', async () => {
      const out = await runTransform(fruits, [
        { op: 'top_n', n: 2, key: 'price', direction: 'desc' },
      ])
      const result = JSON.parse(out)
      expect(result).toHaveLength(2)
      // desc = highest first: cherry(3.0), apple(1.5)
      expect(result[0].name).toBe('cherry')
    })
    it('top_n with direction=asc returns the lowest-valued items by key', async () => {
      const out = await runTransform(fruits, [
        { op: 'top_n', n: 2, key: 'price', direction: 'asc' },
      ])
      const result = JSON.parse(out)
      expect(result).toHaveLength(2)
      // asc = lowest first: banana(0.5), apple(1.5)
      expect(result[0].name).toBe('banana')
    })
    it('top_n with n=1 returns single highest item', async () => {
      const out = await runTransform(fruits, [
        { op: 'top_n', n: 1, key: 'price', direction: 'desc' },
      ])
      const result = JSON.parse(out)
      expect(result).toHaveLength(1)
      expect(result[0].name).toBe('cherry') // desc → highest is cherry(3.0)
    })
    it('frequency_count tallies primitive occurrences', async () => {
      const out = await runTransform(['a', 'b', 'a', 'c', 'a', 'b'], [{ op: 'frequency_count' }])
      const freq = JSON.parse(out)
      expect(freq.a).toBe(3)
      expect(freq.b).toBe(2)
      expect(freq.c).toBe(1)
    })
    it('frequency_count tallies by key path', async () => {
      const out = await runTransform(fruits, [{ op: 'frequency_count', key: 'name' }])
      const freq = JSON.parse(out)
      expect(freq.apple).toBe(1)
      expect(freq.banana).toBe(1)
      expect(freq.cherry).toBe(1)
    })
    it('frequency_count with missing key uses __undefined__', async () => {
      const data = [{ a: 1 }, { b: 2 }, {}]
      const out = await runTransform(data, [{ op: 'frequency_count', key: 'a' }])
      const freq = JSON.parse(out)
      expect(freq['1']).toBe(1)
      expect(freq.__undefined__).toBe(2)
    })
    it('frequency_count on empty array returns empty object', async () => {
      const out = await runTransform([], [{ op: 'frequency_count' }])
      expect(JSON.parse(out)).toEqual({})
    })
    it('frequency_count with null values', async () => {
      const out = await runTransform(['a', null, 'a', null, 'b'], [{ op: 'frequency_count' }])
      const freq = JSON.parse(out)
      expect(freq.a).toBe(2)
      expect(freq.b).toBe(1)
      expect(freq.null).toBe(2)
    })
  })

  describe('top_n oracle', () => {
    it('top_n desc on price picks the 2 highest values (cherry 3.0, apple 1.5)', async () => {
      const out = await runTransform(fruits, [
        { op: 'top_n', n: 2, key: 'price', direction: 'desc' },
      ])
      const result = JSON.parse(out)
      // desc = highest first: cherry(3.0), apple(1.5)
      expect(result).toHaveLength(2)
      expect(result.map((f: { name: string }) => f.name)).toEqual(['cherry', 'apple'])
    })
    it('top_n asc on price picks the 2 lowest values (banana 0.5, apple 1.5)', async () => {
      const out = await runTransform(fruits, [
        { op: 'top_n', n: 2, key: 'price', direction: 'asc' },
      ])
      const result = JSON.parse(out)
      // asc = lowest first: banana(0.5), apple(1.5)
      expect(result).toHaveLength(2)
      expect(result.map((f: { name: string }) => f.name)).toEqual(['banana', 'apple'])
    })
    it('top_n with n exceeding array length returns all items in order', async () => {
      const out = await runTransform(fruits, [
        { op: 'top_n', n: 100, key: 'price', direction: 'desc' },
      ])
      expect(JSON.parse(out)).toHaveLength(3)
    })
    it('top_n with single item array', async () => {
      const out = await runTransform(
        [{ k: 42 }],
        [{ op: 'top_n', n: 1, key: 'k', direction: 'desc' }]
      )
      expect(JSON.parse(out)).toEqual([{ k: 42 }])
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
    it('map_template handles missing path as empty string', async () => {
      const data = [{ a: 1 }, { b: 2 }]
      const out = await runTransform(data, [{ op: 'map_template', template: '{{a}}-{{b}}' }])
      expect(JSON.parse(out)).toEqual(['1-', '-2'])
    })
    it('map_template handles nested paths', async () => {
      const data = [
        { id: 1, meta: { name: 'alice' } },
        { id: 2, meta: { name: 'bob' } },
      ]
      const out = await runTransform(data, [
        { op: 'map_template', template: '{{id}}-{{meta.name}}' },
      ])
      expect(JSON.parse(out)).toEqual(['1-alice', '2-bob'])
    })
  })

  describe('reverse / flatten', () => {
    it('reverse reverses the array', async () => {
      const out = await runTransform([1, 2, 3], [{ op: 'reverse' }])
      expect(JSON.parse(out)).toEqual([3, 2, 1])
    })
    it('reverse on single-element array is identity', async () => {
      const out = await runTransform([42], [{ op: 'reverse' }])
      expect(JSON.parse(out)).toEqual([42])
    })
    it('reverse on empty array returns empty', async () => {
      const out = await runTransform([], [{ op: 'reverse' }])
      expect(JSON.parse(out)).toEqual([])
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
    it('flatten with depth=2 unnests two levels', async () => {
      const out = await runTransform(
        [
          [
            [1, 2],
            [3, 4],
          ],
          [
            [5, 6],
            [7, 8],
          ],
        ],
        [{ op: 'flatten', depth: 2 }]
      )
      expect(JSON.parse(out)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    })
    it('flatten handles depth=0 (no flattening)', async () => {
      const out = await runTransform(
        [
          [1, 2],
          [3, 4],
        ],
        [{ op: 'flatten', depth: 0 }]
      )
      expect(JSON.parse(out)).toEqual([
        [1, 2],
        [3, 4],
      ])
    })
    it('flatten handles negative depth (Array.flat with negative = no flatten)', async () => {
      const out = await runTransform(
        [
          [1, 2],
          [3, 4],
        ],
        [{ op: 'flatten', depth: -1 }]
      )
      // Array.prototype.flat with negative depth returns shallow copy (no flatten)
      expect(JSON.parse(out)).toEqual([
        [1, 2],
        [3, 4],
      ])
    })
    it('flatten handles mixed nesting depths', async () => {
      const out = await runTransform([1, [2, 3], [[4]]], [{ op: 'flatten', depth: 1 }])
      expect(JSON.parse(out)).toEqual([1, 2, 3, [4]])
    })
  })

  describe('aggregation with key', () => {
    it('sum with key totals the specified numeric field', async () => {
      // Hand-computed: 1.5 + 0.5 + 3.0 = 5.0
      const out = await runTransform(fruits, [{ op: 'sum', key: 'price' }])
      expect(out).toBe('5')
    })
    it('avg with key computes mean of specified field', async () => {
      // Hand-computed: (1.5 + 0.5 + 3.0) / 3 = 5/3 ≈ 1.6666666666666667
      const out = await runTransform(fruits, [{ op: 'avg', key: 'price' }])
      expect(Number(out)).toBeCloseTo(5 / 3, 10)
    })
    it('median with key returns the middle value', async () => {
      // Hand-computed: sorted prices: 0.5, 1.5, 3.0 → median = 1.5
      const out = await runTransform(fruits, [{ op: 'median', key: 'price' }])
      expect(out).toBe('1.5')
    })
    it('min with key finds minimum field value', async () => {
      // Hand-computed: min price = 0.5
      const out = await runTransform(fruits, [{ op: 'min', key: 'price' }])
      expect(out).toBe('0.5')
    })
    it('max with key finds maximum field value', async () => {
      // Hand-computed: max price = 3.0
      const out = await runTransform(fruits, [{ op: 'max', key: 'price' }])
      expect(out).toBe('3')
    })
    it('sum, avg, median, min, max with key that is missing on some elements', async () => {
      const data = [{ price: 10 }, { name: 'no-price' }, { price: 20 }]
      // sum: 10 + 0 + 20 = 30
      expect(await runTransform(data, [{ op: 'sum', key: 'price' }])).toBe('30')
      // avg: (10 + 20) / 2 = 15 (non-numeric filtered out)
      expect(Number(await runTransform(data, [{ op: 'avg', key: 'price' }]))).toBeCloseTo(15, 10)
      // median of [10, 20] = 15
      expect(await runTransform(data, [{ op: 'median', key: 'price' }])).toBe('15')
      // min = 10
      expect(await runTransform(data, [{ op: 'min', key: 'price' }])).toBe('10')
      // max = 20
      expect(await runTransform(data, [{ op: 'max', key: 'price' }])).toBe('20')
    })
    it('avg, median, min, max return null when all values non-numeric via key', async () => {
      const data = [{ a: 'x' }, { a: 'y' }]
      expect(await runTransform(data, [{ op: 'avg', key: 'a' }])).toBe('null')
      expect(await runTransform(data, [{ op: 'median', key: 'a' }])).toBe('null')
      expect(await runTransform(data, [{ op: 'min', key: 'a' }])).toBe('null')
      expect(await runTransform(data, [{ op: 'max', key: 'a' }])).toBe('null')
    })
  })

  describe('count oracle', () => {
    it('count on array returns array length', async () => {
      expect(await runTransform([1, 2, 3], [{ op: 'count' }])).toBe('3')
      expect(await runTransform(['a', 'b', 'c', 'd'], [{ op: 'count' }])).toBe('4')
    })
    it('count on object returns number of keys', async () => {
      expect(await runTransform({ a: 1, b: 2 }, [{ op: 'count' }])).toBe('2')
      expect(await runTransform({}, [{ op: 'count' }])).toBe('0')
    })
    it('count on string scalar returns 0', async () => {
      expect(await runTransform('hello', [{ op: 'count' }])).toBe('0')
    })
    it('count on number scalar returns 0', async () => {
      expect(await runTransform(42, [{ op: 'count' }])).toBe('0')
    })
    it('count on null scalar returns 0', async () => {
      expect(await runTransform(null, [{ op: 'count' }])).toBe('0')
    })
  })

  describe('first / last extended', () => {
    it('first with n=0 returns empty', async () => {
      const out = await runTransform([1, 2, 3], [{ op: 'first', n: 0 }])
      expect(JSON.parse(out)).toEqual([])
    })
    it('last with n=0 returns whole array (slice(-0) = slice(0))', async () => {
      const out = await runTransform([1, 2, 3], [{ op: 'last', n: 0 }])
      // JavaScript: -0 === 0, so slice(-0) = slice(0) = entire array
      expect(JSON.parse(out)).toEqual([1, 2, 3])
    })
    it('first without n returns single element, not array', async () => {
      const out = await runTransform([1, 2, 3], [{ op: 'first' }])
      // Oracle: first element is 1, returned as a scalar
      expect(JSON.parse(out)).toBe(1)
    })
    it('first without n on empty array returns null', async () => {
      const out = await runTransform([], [{ op: 'first' }])
      // arr[0] on empty = undefined; JSON.stringify(undefined) = undefined (the JS value)
      // The handler serialises via JSON.stringify(current, null, 2)
      // which returns undefined for undefined; tool executor converts to 'undefined' string or similar
      expect(out === undefined || out === 'undefined' || out === 'null').toBe(true)
    })
  })

  describe('select_keys on non-objects', () => {
    it('select_keys passes through non-object items', async () => {
      const data = [1, { a: 2, b: 3 }, 'str']
      const out = await runTransform(data, [{ op: 'select_keys', keys: ['a'] }])
      const result = JSON.parse(out)
      expect(result[0]).toBe(1)
      expect(result[1]).toEqual({ a: 2 })
      expect(result[2]).toBe('str')
    })
    it('select_keys with null items', async () => {
      const data = [null, { a: 1 }]
      const out = await runTransform(data, [{ op: 'select_keys', keys: ['a'] }])
      const result = JSON.parse(out)
      expect(result[0]).toBeNull()
      expect(result[1]).toEqual({ a: 1 })
    })
  })

  describe('unique with edge values', () => {
    it('unique handles null duplicates (undefined serializes as null in JSON)', async () => {
      // JSON does not have undefined; [null, null, undefined, undefined] parses as [null, null, null, null]
      const data = [null, null, 1, 2, 1]
      const out = await runTransform(data, [{ op: 'unique' }])
      // String(null) = "null" (1 element), String(1) = "1", String(2) = "2"
      expect(JSON.parse(out)).toEqual([null, 1, 2])
    })
    it('unique handles boolean values', async () => {
      const out = await runTransform([true, false, true, false], [{ op: 'unique' }])
      expect(JSON.parse(out)).toEqual([true, false])
    })
    it('unique handles mixed types', async () => {
      const out = await runTransform([0, '0', 0], [{ op: 'unique' }])
      // String(0) = "0", String('0') = "0" → they collide!
      // So 0 and '0' are considered the same
      expect(JSON.parse(out)).toHaveLength(1)
    })
  })

  describe('unique_by edge cases', () => {
    it('unique_by handles null key values as distinct key', async () => {
      const data = [{ id: 1, name: 'a' }, { id: 1, name: 'b' }, { name: 'c' }, { name: 'd' }]
      const out = await runTransform(data, [{ op: 'unique_by', key: 'id' }])
      // Items with id=1 dedup to 1st; items without id both have key=undefined
      // seen Set has undefined after first, so second undefined-keyed item is filtered
      expect(JSON.parse(out)).toHaveLength(2)
    })
  })

  describe('group_by edge cases', () => {
    it('group_by with null key values coalesces to __undefined__', async () => {
      // null ?? '__undefined__' = '__undefined__' because null is nullish
      const data = [{ team: 'red' }, { team: null }, { notTeam: 'blue' }, { team: 'red' }]
      const out = await runTransform(data, [{ op: 'group_by', key: 'team' }])
      const groups = JSON.parse(out)
      expect(groups.red).toHaveLength(2)
      // Both null and undefined (missing key) become __undefined__
      expect(groups.__undefined__).toHaveLength(2)
    })
  })

  describe('sort oracle values', () => {
    it('sort numeric descending computes correct order', async () => {
      // Hand-computed: prices: 0.5, 1.5, 3.0 → desc: 3.0, 1.5, 0.5 → cherry, apple, banana
      const out = await runTransform(fruits, [{ op: 'sort', key: 'price', direction: 'desc' }])
      const result = JSON.parse(out)
      expect(result.map((f: { name: string }) => f.name)).toEqual(['cherry', 'apple', 'banana'])
    })
    it('sort equal numeric keys preserves stability', async () => {
      const data = [
        { id: 1, v: 0 },
        { id: 2, v: 0 },
        { id: 3, v: 0 },
        { id: 4, v: 1 },
        { id: 5, v: 1 },
      ]
      const out = await runTransform(data, [{ op: 'sort', key: 'v' }])
      const result = JSON.parse(out)
      // v=0 items first, v=1 items after; within each group, original order preserved
      const ids = result.map((x: { id: number }) => x.id)
      expect(ids).toEqual([1, 2, 3, 4, 5])
    })
    it('sort string sort with mixed cases uses localeCompare', async () => {
      const data = [{ n: 'a' }, { n: 'A' }, { n: 'b' }]
      const out = await runTransform(data, [{ op: 'sort', key: 'n' }])
      const result = JSON.parse(out)
      // localeCompare default may sort 'a' and 'A' adjacent (order depends on locale)
      // Both should be before 'b'
      const names = result.map((x: { n: string }) => x.n)
      expect(names.indexOf('b')).toBe(2)
    })
  })

  describe('oracle invariant tests for json_transform', () => {
    it('filter gt + lt partitioning: gt(a, b) and lt(a, b) are disjoint', async () => {
      const data = [1, 3, 5, 7, 9, 11]
      const objData = data.map((v) => ({ v }))
      const gtOut = await runTransform(objData, [
        { op: 'filter', key: 'v', operator: 'gt', value: 6 },
      ])
      const ltOut = await runTransform(objData, [
        { op: 'filter', key: 'v', operator: 'lt', value: 6 },
      ])
      const gtVals = JSON.parse(gtOut).map((x: { v: number }) => x.v)
      const ltVals = JSON.parse(ltOut).map((x: { v: number }) => x.v)
      // All gt values > 6, all lt values < 6, no overlap
      for (const v of gtVals) expect(v).toBeGreaterThan(6)
      for (const v of ltVals) expect(v).toBeLessThan(6)
    })
    it('sum of chunks equals sum of original', async () => {
      const data = [10, 20, 30, 40, 50]
      const originalSum = 150
      const chunked = await runTransform(data, [{ op: 'chunk', size: 2 }])
      const chunks = JSON.parse(chunked) as number[][]
      let total = 0
      for (const chunk of chunks) {
        for (const val of chunk) total += val
      }
      expect(total).toBe(originalSum)
    })
    it('reverse is involutive: reverse(reverse(arr)) === arr', async () => {
      const original = [1, 2, 3, 4, 5]
      const once = await runTransform(original, [{ op: 'reverse' }])
      const twice = await runTransform(JSON.parse(once), [{ op: 'reverse' }])
      expect(JSON.parse(twice)).toEqual(original)
    })
    it('sort then filter = filter then sort (commutativity)', async () => {
      const data = [{ v: 3 }, { v: 1 }, { v: 5 }, { v: 2 }, { v: 4 }]
      const sortedThenFiltered = await runTransform(data, [
        { op: 'sort', key: 'v' },
        { op: 'filter', key: 'v', operator: 'gt', value: 2 },
      ])
      const filteredThenSorted = await runTransform(data, [
        { op: 'filter', key: 'v', operator: 'gt', value: 2 },
        { op: 'sort', key: 'v' },
      ])
      const r1 = JSON.parse(sortedThenFiltered).map((x: { v: number }) => x.v)
      const r2 = JSON.parse(filteredThenSorted).map((x: { v: number }) => x.v)
      expect(r1).toEqual(r2)
    })
    it('pipeline with count on final array gives correct element count', async () => {
      const out = await runTransform(fruits, [
        { op: 'filter', key: 'price', operator: 'gte', value: 1 },
        { op: 'count' },
      ])
      // fruits with price >= 1: apple(1.5), cherry(3.0) = 2
      expect(out).toBe('2')
    })
  })

  describe('map_template extended', () => {
    it('map_template with empty template', async () => {
      const out = await runTransform(fruits, [{ op: 'map_template', template: '' }])
      expect(JSON.parse(out)).toEqual(['', '', ''])
    })
    it('map_template with literal text (no placeholders)', async () => {
      const out = await runTransform(fruits, [{ op: 'map_template', template: 'fixed' }])
      expect(JSON.parse(out)).toEqual(['fixed', 'fixed', 'fixed'])
    })
    it('map_template with same key repeated', async () => {
      const out = await runTransform(fruits, [
        { op: 'map_template', template: '{{name}}-{{name}}' },
      ])
      expect(JSON.parse(out)).toEqual(['apple-apple', 'banana-banana', 'cherry-cherry'])
    })
    it('map_template with unknown placeholder becomes empty', async () => {
      const out = await runTransform(fruits, [
        { op: 'map_template', template: '{{name}}:{{unknown}}' },
      ])
      expect(JSON.parse(out)).toEqual(['apple:', 'banana:', 'cherry:'])
    })
    it('map_template with special regex chars in template', async () => {
      const data = [{ a: 'x' }]
      const out = await runTransform(data, [{ op: 'map_template', template: '$1 {{a}} $2' }])
      expect(JSON.parse(out)).toEqual(['$1 x $2'])
    })
  })

  describe('filter operator full coverage', () => {
    it('eq with numeric values', async () => {
      const data = [{ v: 1 }, { v: 2 }, { v: 1 }]
      const out = await runTransform(data, [{ op: 'filter', key: 'v', operator: 'eq', value: 1 }])
      expect(JSON.parse(out)).toHaveLength(2)
    })
    it('ne with numeric values', async () => {
      const data = [{ v: 1 }, { v: 2 }, { v: 3 }]
      const out = await runTransform(data, [{ op: 'filter', key: 'v', operator: 'ne', value: 2 }])
      expect(JSON.parse(out)).toHaveLength(2)
    })
    it('gte includes equal value', async () => {
      const data = [{ v: 1 }, { v: 2 }, { v: 3 }]
      const out = await runTransform(data, [{ op: 'filter', key: 'v', operator: 'gte', value: 2 }])
      expect(JSON.parse(out)).toHaveLength(2)
    })
    it('lte includes equal value', async () => {
      const data = [{ v: 1 }, { v: 2 }, { v: 3 }]
      const out = await runTransform(data, [{ op: 'filter', key: 'v', operator: 'lte', value: 2 }])
      expect(JSON.parse(out)).toHaveLength(2)
    })
    it('contains with empty search string matches all strings', async () => {
      const data = [{ s: 'abc' }, { s: '' }, { s: 'xyz' }]
      const out = await runTransform(data, [
        { op: 'filter', key: 's', operator: 'contains', value: '' },
      ])
      // Every string contains ''
      expect(JSON.parse(out)).toHaveLength(3)
    })
    it('starts_with with empty prefix matches all strings', async () => {
      const data = [{ s: 'abc' }, { s: '' }, { s: 'xyz' }]
      const out = await runTransform(data, [
        { op: 'filter', key: 's', operator: 'starts_with', value: '' },
      ])
      expect(JSON.parse(out)).toHaveLength(3)
    })
    it('ends_with with empty suffix matches all strings', async () => {
      const data = [{ s: 'abc' }, { s: '' }, { s: 'xyz' }]
      const out = await runTransform(data, [
        { op: 'filter', key: 's', operator: 'ends_with', value: '' },
      ])
      expect(JSON.parse(out)).toHaveLength(3)
    })
    it('exists returns false for explicitly null value', async () => {
      const data = [{ a: 1 }, { a: null }, { a: undefined }, {}]
      const out = await runTransform(data, [{ op: 'filter', key: 'a', operator: 'exists' }])
      expect(JSON.parse(out)).toEqual([{ a: 1 }])
    })
    it('filter on nested path', async () => {
      const data = [{ meta: { score: 80 } }, { meta: { score: 90 } }, { meta: {} }]
      const out = await runTransform(data, [
        { op: 'filter', key: 'meta.score', operator: 'gt', value: 85 },
      ])
      expect(JSON.parse(out)).toHaveLength(1)
      expect(JSON.parse(out)[0].meta.score).toBe(90)
    })
  })

  describe('select_keys / pluck extended', () => {
    it('pluck with dot-notation nested key', async () => {
      const data = [
        { id: 1, meta: { score: 80 } },
        { id: 2, meta: { score: 90 } },
      ]
      const out = await runTransform(data, [{ op: 'pluck', key: 'meta.score' }])
      expect(JSON.parse(out)).toEqual([80, 90])
    })
    it('pluck on non-object elements returns null for those', async () => {
      const data = [{ a: 1 }, 42, { a: 2 }]
      const out = await runTransform(data, [{ op: 'pluck', key: 'a' }])
      const result = JSON.parse(out)
      expect(result[0]).toBe(1)
      expect(result[1]).toBeNull()
      expect(result[2]).toBe(2)
    })
  })

  describe('slice oracle', () => {
    it('slice with only start (no end) slices to end', async () => {
      const out = await runTransform([10, 20, 30, 40, 50], [{ op: 'slice', start: 2 }])
      expect(JSON.parse(out)).toEqual([30, 40, 50])
    })
    it('slice with negative end', async () => {
      const out = await runTransform([10, 20, 30, 40, 50], [{ op: 'slice', start: 0, end: -1 }])
      expect(JSON.parse(out)).toEqual([10, 20, 30, 40])
    })
    it('slice with both negative', async () => {
      const out = await runTransform([10, 20, 30, 40, 50], [{ op: 'slice', start: -3, end: -1 }])
      expect(JSON.parse(out)).toEqual([30, 40])
    })
  })

  describe('callTool no-crash extended', () => {
    it('object input to array op filter returns error string', async () => {
      const r = await callTool(jsonTransformTool, {
        data: JSON.stringify({ a: 1 }),
        operations: [{ op: 'filter', key: 'a', operator: 'eq', value: 1 }],
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') {
        expect(r.out).toMatch(/^Error in operation 1/)
      }
    })
    it('array op on null literal does not crash', async () => {
      const r = await callTool(jsonTransformTool, {
        data: JSON.stringify(null),
        operations: [{ op: 'sort', key: 'x' }],
      })
      expect(r.kind).toBe('resolved')
    })
    it('deeply nested structure with flatten 10 does not crash', async () => {
      const deep = [1, [2, [3, [4, [5, [6, [7, [8, [9, [10]]]]]]]]]]
      const r = await callTool(jsonTransformTool, {
        data: JSON.stringify(deep),
        operations: [{ op: 'flatten', depth: 10 }],
      })
      expect(r.kind).toBe('resolved')
    })
    it('operations array with a null entry is rejected cleanly by the schema', async () => {
      const r = await callTool(jsonTransformTool, {
        data: JSON.stringify([1, 2, 3]),
        operations: [null as unknown as Record<string, unknown>],
      })
      // A null op is not a valid object → E_INVALID_TOOL_ARGS at validation (not a downstream
      // crash). And an empty op object {} resolves with a graceful "Error in operation" string.
      expect(r.kind).toBe('threw')
      if (r.kind === 'threw') expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
    })
    it('large array with many operations does not crash', async () => {
      const largeData = Array.from({ length: 1000 }, (_, i) => ({ v: i }))
      const r = await callTool(jsonTransformTool, {
        data: JSON.stringify(largeData),
        operations: [{ op: 'sum', key: 'v' }],
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') {
        // Sum of 0..999 = 999*1000/2 = 499500
        expect(r.out).toBe('499500')
      }
    })
    it('boolean data array does not crash', async () => {
      const r = await callTool(jsonTransformTool, {
        data: JSON.stringify([true, false, true]),
        operations: [{ op: 'count' }],
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') {
        expect(r.out).toBe('3')
      }
    })
  })

  describe('schema rejection via callTool', () => {
    it('missing data field throws E_INVALID_TOOL_ARGS', async () => {
      const r = await callTool(jsonTransformTool, {
        operations: [{ op: 'count' }],
      })
      expect(r.kind).toBe('threw')
      if (r.kind === 'threw') {
        expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
      }
    })
    it('missing operations field throws E_INVALID_TOOL_ARGS', async () => {
      const r = await callTool(jsonTransformTool, {
        data: JSON.stringify([1, 2, 3]),
      })
      expect(r.kind).toBe('threw')
      if (r.kind === 'threw') {
        expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
      }
    })
  })

  describe('callTool no-crash cases (adversarial inputs)', () => {
    it('chunk size=0 does not crash', async () => {
      const r = await callTool(jsonTransformTool, {
        data: JSON.stringify([1, 2, 3]),
        operations: [{ op: 'chunk', size: 0 }],
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') {
        expect(JSON.parse(r.out)).toEqual([[1], [2], [3]])
      }
    })
    it('chunk negative size does not crash', async () => {
      const r = await callTool(jsonTransformTool, {
        data: JSON.stringify([1, 2, 3]),
        operations: [{ op: 'chunk', size: -100 }],
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') {
        expect(JSON.parse(r.out)).toEqual([[1], [2], [3]])
      }
    })
    it('non-array input to array op returns error string', async () => {
      const r = await callTool(jsonTransformTool, {
        data: JSON.stringify({ a: 1 }),
        operations: [{ op: 'sort', key: 'a' }],
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') {
        expect(r.out).toMatch(/^Error in operation 1/)
      }
    })
    it('invalid JSON input returns error string', async () => {
      const r = await callTool(jsonTransformTool, {
        data: 'not json {',
        operations: [],
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') {
        expect(r.out).toMatch(/^Error/)
      }
    })
    it('deeply nested array does not crash', async () => {
      const deeplyNested = [1, [2, [3, [4, [5]]]]]
      const r = await callTool(jsonTransformTool, {
        data: JSON.stringify(deeplyNested),
        operations: [{ op: 'flatten', depth: 4 }],
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') {
        // After flattening with depth 4, all elements should be at top level
        const flat = JSON.parse(r.out)
        expect(flat).toEqual([1, 2, 3, 4, 5])
      }
    })
    it('[null] array elements do not crash', async () => {
      const r = await callTool(jsonTransformTool, {
        data: JSON.stringify([1, null, 2, null, 3]),
        operations: [{ op: 'sum' }],
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') {
        // null is treated as 0 in sum
        expect(r.out).toBe('6') // 1 + 0 + 2 + 0 + 3
      }
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
    it('returns error when object input to array-only operation', async () => {
      const out = (await jsonTransformTool.executor(makeToolCtxStub())({
        data: '{"a":1}',
        operations: [{ op: 'filter', key: 'a', operator: 'eq', value: 1 }],
      })) as string
      expect(out).toMatch(/^Error in operation 1/)
    })
  })
})

describe('setOperationsTool extended invariants', () => {
  it('intersection ⊆ A (every element of intersection is in A)', async () => {
    const A = [1, 2, 3, 4, 5]
    const B = [4, 5, 6, 7]
    const out = await runSet({
      data_a: JSON.stringify(A),
      data_b: JSON.stringify(B),
      operation: 'intersection',
    })
    const result: unknown[] = JSON.parse(out)
    for (const elem of result) {
      expect(A).toContain(elem)
    }
  })
  it('intersection ⊆ B (every element of intersection is in B)', async () => {
    const A = [1, 2, 3, 4, 5]
    const B = [4, 5, 6, 7]
    const out = await runSet({
      data_a: JSON.stringify(A),
      data_b: JSON.stringify(B),
      operation: 'intersection',
    })
    const result: unknown[] = JSON.parse(out)
    for (const elem of result) {
      expect(B).toContain(elem)
    }
  })
  it('union order-invariant: union(A,B) as set = union(B,A) as set', async () => {
    const A = [1, 2, 3]
    const B = [3, 4, 5]
    const outAB = await runSet({
      data_a: JSON.stringify(A),
      data_b: JSON.stringify(B),
      operation: 'union',
    })
    const outBA = await runSet({
      data_a: JSON.stringify(B),
      data_b: JSON.stringify(A),
      operation: 'union',
    })
    const ab = JSON.parse(outAB).sort()
    const ba = JSON.parse(outBA).sort()
    expect(ab).toEqual(ba)
  })
  it('|union| ≥ |A| and |union| ≥ |B|', async () => {
    const out = await runSet({
      data_a: '[1, 2, 3]',
      data_b: '[3, 4, 5]',
      operation: 'union',
    })
    const union = JSON.parse(out)
    expect(union.length).toBeGreaterThanOrEqual(3)
  })
  it('symmetric_difference is empty when A = B', async () => {
    const out = await runSet({
      data_a: '[1, 2, 3]',
      data_b: '[1, 2, 3]',
      operation: 'symmetric_difference',
    })
    expect(JSON.parse(out)).toEqual([])
  })
  it('union with duplicate elements in A/B keeps duplicates from A', async () => {
    const out = await runSet({
      data_a: '[1, 1, 2]',
      data_b: '[2, 3]',
      operation: 'union',
    })
    const result = JSON.parse(out)
    // A has [1, 1, 2]; B adds 3 (2 is already from A)
    expect(result.sort()).toEqual([1, 1, 2, 3])
  })
  it('all 7 operations return defined results', async () => {
    const ops = [
      'intersection',
      'union',
      'difference',
      'symmetric_difference',
      'is_member',
      'is_subset',
      'is_superset',
    ]
    for (const op of ops) {
      const args: Record<string, unknown> = {
        data_a: '[1, 2, 3]',
        data_b: '[2, 3, 4]',
        operation: op,
      }
      if (op === 'is_member') {
        args.item = 2
        delete args.data_b
      }
      const result = await runSet(args)
      expect(result).toBeDefined()
      expect(result).not.toMatch(/^Error: Unknown operation/)
    }
  })
  it('is_member works with just data_a (no data_b)', async () => {
    const out = await runSet({
      data_a: '[1, 2, 3]',
      operation: 'is_member',
      item: 2,
    })
    expect(out).toMatch(/^Found/)
  })
  it('missing data_b defaults to empty array (intersection with empty = empty)', async () => {
    const out = await runSet({
      data_a: '[1, 2, 3]',
      operation: 'intersection',
    })
    // data_b is optional; when omitted, b defaults to []
    expect(JSON.parse(out)).toEqual([])
  })
  it('empty-string data_b passes schema validation and behaves like omitting it', async () => {
    const r = await callTool(setOperationsTool, {
      data_a: '[1, 2, 3]',
      data_b: '',
      operation: 'intersection',
    })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') {
      expect(JSON.parse(r.out)).toEqual([])
    }
    const omitted = await runSet({
      data_a: '[1, 2, 3]',
      operation: 'intersection',
    })
    const withEmptyString = await runSet({
      data_a: '[1, 2, 3]',
      data_b: '',
      operation: 'intersection',
    })
    expect(withEmptyString).toBe(omitted)
  })
  it('compare_key with null values handled', async () => {
    const out = await runSet({
      data_a: JSON.stringify([{ id: 1 }, { id: null }, { id: 1 }]),
      data_b: JSON.stringify([{ id: null }, { id: 2 }]),
      operation: 'intersection',
      compare_key: 'id',
    })
    const result = JSON.parse(out)
    // Intersection: only null-keyed elements match
    expect(result).toHaveLength(1)
    expect(result[0].id).toBeNull()
  })
  it('empty-string compare_key passes schema validation and behaves like omitting it', async () => {
    const r = await callTool(setOperationsTool, {
      data_a: JSON.stringify([{ id: 1 }, { id: 1 }]),
      data_b: JSON.stringify([{ id: 1 }]),
      operation: 'intersection',
      compare_key: '',
    })
    expect(r.kind).toBe('resolved')
    const omitted = await runSet({
      data_a: JSON.stringify([{ id: 1 }, { id: 1 }]),
      data_b: JSON.stringify([{ id: 1 }]),
      operation: 'intersection',
    })
    const withEmptyString = await runSet({
      data_a: JSON.stringify([{ id: 1 }, { id: 1 }]),
      data_b: JSON.stringify([{ id: 1 }]),
      operation: 'intersection',
      compare_key: '',
    })
    expect(withEmptyString).toBe(omitted)
  })
  it('compare_key with undefined key values', async () => {
    const out = await runSet({
      data_a: JSON.stringify([{ id: 1 }, { name: 'no-id' }]),
      data_b: JSON.stringify([{ id: 2 }, { name: 'no-id' }]),
      operation: 'intersection',
      compare_key: 'id',
    })
    const result = JSON.parse(out)
    // Only items with id=undefined match (String(undefined)=undefined, both map to 'undefined')
    expect(result).toHaveLength(1)
  })
  it('intersection with duplicate elements preserves first occurrence', async () => {
    const out = await runSet({
      data_a: JSON.stringify([1, 1, 2]),
      data_b: '[1, 3]',
      operation: 'intersection',
    })
    // intersection returns first occurrence from A for each matching key
    const result = JSON.parse(out)
    expect(result).toHaveLength(1)
    expect(result[0]).toBe(1)
  })
  it('difference of A∖A = ∅', async () => {
    const out = await runSet({
      data_a: '[1, 2, 3]',
      data_b: '[1, 2, 3]',
      operation: 'difference',
    })
    expect(JSON.parse(out)).toEqual([])
  })
  it('union of A∖B and B∖A and A∩B = A∪B (partition)', async () => {
    const A = [1, 2, 3, 4]
    const B = [3, 4, 5]
    const diff = JSON.parse(
      await runSet({
        data_a: JSON.stringify(A),
        data_b: JSON.stringify(B),
        operation: 'difference',
      })
    )
    const revDiff = JSON.parse(
      await runSet({
        data_a: JSON.stringify(B),
        data_b: JSON.stringify(A),
        operation: 'difference',
      })
    )
    const intersection = JSON.parse(
      await runSet({
        data_a: JSON.stringify(A),
        data_b: JSON.stringify(B),
        operation: 'intersection',
      })
    )
    const partition = [...diff, ...revDiff, ...intersection].sort()
    const union = JSON.parse(
      await runSet({ data_a: JSON.stringify(A), data_b: JSON.stringify(B), operation: 'union' })
    ).sort()
    expect(partition).toEqual(union)
  })
})

describe('setOperationsTool callTool no-crash extended', () => {
  it('malformed JSON in data_a returns error string', async () => {
    const r = await callTool(setOperationsTool, {
      data_a: '{{{bad json',
      data_b: '[1, 2, 3]',
      operation: 'intersection',
    })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') {
      expect(r.out).toContain('Error')
    }
  })
  it('malformed JSON in data_b returns error string', async () => {
    const r = await callTool(setOperationsTool, {
      data_a: '[1, 2, 3]',
      data_b: 'not-json',
      operation: 'intersection',
    })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') {
      expect(r.out).toContain('Error')
    }
  })
  it('null elements in data_a do not crash', async () => {
    const r = await callTool(setOperationsTool, {
      data_a: JSON.stringify([null, 1, null, 2]),
      data_b: '[2, 3]',
      operation: 'intersection',
    })
    expect(r.kind).toBe('resolved')
  })
  it('undefined in operation value does not crash', async () => {
    const r = await callTool(setOperationsTool, {
      data_a: '[1, 2, 3]',
      data_b: '[2, 3]',
      operation: undefined as unknown as string,
    })
    expect(r.kind).toBe('threw')
    if (r.kind === 'threw') {
      expect(r.errorName).toBe('E_INVALID_TOOL_ARGS')
    }
  })
  it('very large arrays do not crash', async () => {
    const largeA = Array.from({ length: 5000 }, (_, i) => i)
    const largeB = Array.from({ length: 5000 }, (_, i) => i + 2500)
    const r = await callTool(setOperationsTool, {
      data_a: JSON.stringify(largeA),
      data_b: JSON.stringify(largeB),
      operation: 'intersection',
    })
    expect(r.kind).toBe('resolved')
    if (r.kind === 'resolved') {
      const result = JSON.parse(r.out)
      // Intersection of [0..4999] and [2500..7499] = [2500..4999] = 2500 elements
      expect(result).toHaveLength(2500)
    }
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
    it('returns empty when no overlap', async () => {
      const out = await runSet({
        data_a: '[1, 2]',
        data_b: '[3, 4]',
        operation: 'intersection',
      })
      expect(JSON.parse(out)).toEqual([])
    })
    it('handles empty arrays', async () => {
      const out = await runSet({
        data_a: '[]',
        data_b: '[1, 2, 3]',
        operation: 'intersection',
      })
      expect(JSON.parse(out)).toEqual([])
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
    it('returns A when B is empty', async () => {
      const out = await runSet({
        data_a: '[1, 2, 3]',
        data_b: '[]',
        operation: 'union',
      })
      expect(JSON.parse(out)).toEqual([1, 2, 3])
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
    it('returns A when B is empty', async () => {
      const out = await runSet({
        data_a: '[1, 2, 3]',
        data_b: '[]',
        operation: 'difference',
      })
      expect(JSON.parse(out)).toEqual([1, 2, 3])
    })
    it('returns empty when A is subset of B', async () => {
      const out = await runSet({
        data_a: '[1, 2]',
        data_b: '[1, 2, 3, 4]',
        operation: 'difference',
      })
      expect(JSON.parse(out)).toEqual([])
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
    it('symmetric difference is symmetric - A△B = B△A', async () => {
      const outAB = await runSet({
        data_a: '[1, 2, 3]',
        data_b: '[3, 4, 5]',
        operation: 'symmetric_difference',
      })
      const outBA = await runSet({
        data_a: '[3, 4, 5]',
        data_b: '[1, 2, 3]',
        operation: 'symmetric_difference',
      })
      const ab = JSON.parse(outAB).sort()
      const ba = JSON.parse(outBA).sort()
      expect(ab).toEqual(ba)
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
    it('finds object by deep equality', async () => {
      const out = await runSet({
        data_a: JSON.stringify([{ id: 1, name: 'a' }]),
        operation: 'is_member',
        item: { id: 1, name: 'a' },
      })
      expect(out).toMatch(/^Found/)
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
    it('A is always a subset of itself', async () => {
      const out = await runSet({
        data_a: '[1, 2, 3]',
        data_b: '[1, 2, 3]',
        operation: 'is_subset',
      })
      expect(out).toMatch(/^Yes/)
    })
    it('A is always a superset of itself', async () => {
      const out = await runSet({
        data_a: '[1, 2, 3]',
        data_b: '[1, 2, 3]',
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
    it('compare_key works with union', async () => {
      const out = await runSet({
        data_a: JSON.stringify([
          { id: 1, n: 'a' },
          { id: 2, n: 'b' },
        ]),
        data_b: JSON.stringify([
          { id: 2, n: 'B' },
          { id: 3, n: 'c' },
        ]),
        operation: 'union',
        compare_key: 'id',
      })
      const result = JSON.parse(out)
      expect(result).toHaveLength(3)
    })
  })
  describe('invariants', () => {
    it('intersection ⊆ A and intersection ⊆ B', async () => {
      const out = await runSet({
        data_a: '[1, 2, 3, 4]',
        data_b: '[2, 3, 5]',
        operation: 'intersection',
      })
      const result = JSON.parse(out)
      for (const elem of result) {
        const outA = await runSet({ data_a: '[1, 2, 3, 4]', operation: 'is_member', item: elem })
        const outB = await runSet({ data_a: '[2, 3, 5]', operation: 'is_member', item: elem })
        expect(outA).toMatch(/^Found/)
        expect(outB).toMatch(/^Found/)
      }
    })
    it('|union| ≥ max(|A|, |B|)', async () => {
      const out = await runSet({
        data_a: '[1, 2]',
        data_b: '[3, 4]',
        operation: 'union',
      })
      const result = JSON.parse(out)
      expect(result.length).toBeGreaterThanOrEqual(2)
    })
    it('A∖B then ∪ (A∩B) = A (set union with complement)', async () => {
      const outDiff = await runSet({
        data_a: '[1, 2, 3]',
        data_b: '[2]',
        operation: 'difference',
      })
      const outIntersect = await runSet({
        data_a: '[1, 2, 3]',
        data_b: '[2]',
        operation: 'intersection',
      })
      const diff = JSON.parse(outDiff)
      const intersect = JSON.parse(outIntersect)
      const union = [...diff, ...intersect]
      // Should reconstruct original A (order doesn't matter)
      expect(union.sort()).toEqual([1, 2, 3])
    })
  })
  describe('callTool no-crash cases (adversarial inputs)', () => {
    it('null elements in arrays do not crash', async () => {
      const r = await callTool(setOperationsTool, {
        data_a: JSON.stringify([1, null, 2]),
        data_b: JSON.stringify([null, 2, 3]),
        operation: 'intersection',
      })
      expect(r.kind).toBe('resolved')
    })
    it('empty array data_a does not crash', async () => {
      const r = await callTool(setOperationsTool, {
        data_a: '[]',
        data_b: '[1, 2, 3]',
        operation: 'intersection',
      })
      expect(r.kind).toBe('resolved')
    })
    it('non-array data_a returns error string', async () => {
      const r = await callTool(setOperationsTool, {
        data_a: '{}',
        data_b: '[]',
        operation: 'intersection',
      })
      expect(r.kind).toBe('resolved')
      if (r.kind === 'resolved') {
        expect(r.out).toMatch(/^Error/)
      }
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
    it('errors when data_b is invalid JSON', async () => {
      const out = await runSet({ data_a: '[]', operation: 'intersection', data_b: 'not json' })
      expect(out).toMatch(/^Error/)
      expect(out).toContain('data_b')
    })
    it('errors when data_b is not an array', async () => {
      const out = await runSet({ data_a: '[]', operation: 'intersection', data_b: '{}' })
      expect(out).toMatch(/^Error/)
    })
    it('rejects unknown operation via schema', async () => {
      await expect(runSet({ data_a: '[]', operation: 'mystery' })).rejects.toBeInstanceOf(
        E_INVALID_TOOL_ARGS
      )
    })
  })
})

// ── Edge cases surfaced by an independent model review (verified against the source) ──────
describe('jsonTransformTool — review-surfaced correctness bugs', () => {
  // EXPECTED-RED: top_n with direction 'desc' returns the BOTTOM n. The comparator is
  // `(bv - av) * dir` with dir=-1 for desc → that equals `av - bv` (ascending), so .slice(0,n)
  // takes the smallest. Asserting the PROMISED behaviour (largest first) → red.
  it('top_n desc returns the largest n (currently returns the smallest)', async () => {
    const out = await runTransform(
      [{ v: 10 }, { v: 5 }, { v: 7 }, { v: 1 }],
      [{ op: 'top_n', n: 2, key: 'v', direction: 'desc' }]
    )
    const vals = JSON.parse(out).map((o: { v: number }) => o.v)
    expect(vals).toEqual([10, 7]) // top 2 by value
  })

  // top_n asc is the natural complement — documents the intended low-end behaviour.
  it('top_n asc returns the smallest n', async () => {
    const out = await runTransform(
      [{ v: 10 }, { v: 5 }, { v: 7 }, { v: 1 }],
      [{ op: 'top_n', n: 2, key: 'v', direction: 'asc' }]
    )
    const vals = JSON.parse(out).map((o: { v: number }) => o.v)
    expect(vals).toEqual([1, 5])
  })

  // EXPECTED-RED: sum without a `key` over an array of OBJECTS treats each object as non-numeric
  // and silently returns 0. The tool should require a key for object arrays (or error), not
  // report a misleading 0. Asserting it does NOT silently return "0".
  it('sum without key over object array should not silently return 0', async () => {
    const out = await runTransform([{ v: 1 }, { v: 2 }], [{ op: 'sum' }])
    // A correct tool reports an error/guidance for object arrays without a key, OR sums via an
    // inferred key — but "0" is silently wrong. This pins the defect.
    expect(out).not.toBe('0')
  })
})

describe('jsonTransformTool — unique_by on nested objects', () => {
  // EXPECTED-RED: unique_by uses new Set<unknown>() and stores the raw value from getPath. For an
  // object-valued key, JSON.parse makes distinct references, so seen.has() never matches → nothing
  // is deduplicated. unique (the sibling op) stringifies; unique_by should too.
  it('deduplicates rows whose key resolves to a deep-equal object', async () => {
    const out = await runTransform(
      [{ u: { id: 1 } }, { u: { id: 1 } }, { u: { id: 2 } }],
      [{ op: 'unique_by', key: 'u' }]
    )
    expect(JSON.parse(out)).toHaveLength(2) // currently 3 — no dedup
  })
})
