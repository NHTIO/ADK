import { describe, expect, it } from 'vitest'
import { evaluateOrderingProfile } from '../../../../../src/batteries/validation/helpers'
import { toolCallIdUniqueness } from '../../../../../src/batteries/validation/profiles/tool_call_id_uniqueness'
import type { OrderingTimelineEntry } from '../../../../../src/batteries/validation/types'

const call = (
  id: unknown,
  seq: number,
  kind: OrderingTimelineEntry['kind'] = 'toolCall'
): OrderingTimelineEntry => ({
  kind,
  at: seq,
  seq,
  value: { id } as OrderingTimelineEntry['value'],
})

describe('tool-call-id-uniqueness', () => {
  it('fires once for a cross-turn collision', () => {
    const result = evaluateOrderingProfile(
      [call('call_0', 0), call('call_0', 1)],
      toolCallIdUniqueness
    )
    expect(result.blocking).toHaveLength(1)
    expect(result.blocking[0]?.primitiveIds).toEqual(['call_0', 'call_0'])
  })

  it('is silent for correctly numbered parallel calls in one response', () => {
    const result = evaluateOrderingProfile(
      [call('call_0', 0), call('call_1', 1), call('call_2', 2), call('call_3', 3)],
      toolCallIdUniqueness
    )
    expect(result.blocking).toHaveLength(0)
  })

  it('reports one finding for a group of three', () => {
    const result = evaluateOrderingProfile(
      [call('call_0', 0), call('call_0', 1), call('call_0', 2)],
      toolCallIdUniqueness
    )
    expect(result.blocking).toHaveLength(1)
    expect(result.blocking[0]?.primitiveIds).toHaveLength(3)
  })

  it('does not collide non-string ids through the idOf fallback', () => {
    const result = evaluateOrderingProfile([call(42, 0), call(42, 1)], toolCallIdUniqueness)
    expect(result.blocking).toHaveLength(0)
  })

  it('ignores a different primitive kind', () => {
    const result = evaluateOrderingProfile(
      [call('call_0', 0), call('call_0', 1, 'thought')],
      toolCallIdUniqueness
    )
    expect(result.blocking).toHaveLength(0)
  })
})
