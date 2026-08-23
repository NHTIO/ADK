import { describe, expect, it } from 'vitest'
import { openaiShapeBaseline } from '../../../../src/batteries/validation/profiles/openai_shape_baseline'
import { functionResponseAdjacency } from '../../../../src/batteries/validation/profiles/function_response_adjacency'
import {
  evaluateOrderingProfile,
  repairViolations,
  setDotPath,
} from '../../../../src/batteries/validation/helpers'
import type {
  OrderingProfile,
  OrderingTimelineEntry,
} from '../../../../src/batteries/validation/types'

const entry = (
  kind: OrderingTimelineEntry['kind'],
  id: string,
  at: number,
  seq: number,
  role?: 'user' | 'assistant',
  payload?: unknown
): OrderingTimelineEntry => ({
  kind,
  at,
  seq,
  role,
  value: { id, payload } as OrderingTimelineEntry['value'],
})

const profile = (rule: OrderingProfile['rules'][number]): OrderingProfile => ({
  name: 'verification',
  description: 'verification',
  rules: [rule],
})

describe('ordering helper regressions', () => {
  it('groups a tool/thought run with the following assistant turn', () => {
    const timeline = [
      entry('message', 'user', 0, 0, 'user'),
      entry('toolCall', 'call', 1, 3),
      entry('thought', 'thought', 2, 2),
      entry('message', 'assistant', 3, 1, 'assistant'),
    ]
    const result = evaluateOrderingProfile(
      timeline,
      profile({
        type: 'order',
        id: 'thought-before-tool',
        before: 'thought',
        after: 'toolCall',
        scope: 'adjacent-same-role-group',
        onlyLatestGroup: true,
      })
    )
    expect(result.blocking).toHaveLength(1)
  })

  it('checks the first matching kind rather than the literal group leader', () => {
    const result = evaluateOrderingProfile(
      [entry('message', 'user', 0, 0, 'user'), entry('toolCall', 'call', 1, 1)],
      profile({
        type: 'requiredMetadata',
        id: 'signature',
        kind: 'toolCall',
        applyTo: 'first-in-group',
        requiredPayloadKey: 'signature',
      })
    )
    expect(result.blocking.map((violation) => violation.primitiveIds)).toEqual([['call']])
  })

  it('reports a disallowed primitive immediately after an adjacency starter', () => {
    const result = evaluateOrderingProfile(
      [entry('toolCall', 'call', 0, 0), entry('message', 'message', 1, 1, 'assistant')],
      profile({
        type: 'adjacency',
        id: 'message-after-call',
        first: 'toolCall',
        disallowBetween: ['message'],
      })
    )
    expect(result.blocking).toHaveLength(1)
    expect(result.blocking[0].primitiveIds).toEqual(['call', 'message'])
  })

  it('allows a first-kind entry at the end of the timeline', () => {
    const result = evaluateOrderingProfile(
      [entry('message', 'message', 0, 0, 'user'), entry('toolCall', 'call', 1, 1)],
      profile({
        type: 'adjacency',
        id: 'message-after-call',
        first: 'toolCall',
        disallowBetween: ['message'],
      })
    )
    expect(result.blocking).toHaveLength(0)
  })

  it.each([
    ['OpenAI baseline', openaiShapeBaseline],
    ['function response', functionResponseAdjacency],
  ])('flags an immediately wedged Message for the %s profile', (_name, profileToCheck) => {
    const result = evaluateOrderingProfile(
      [entry('toolCall', 'call', 0, 0), entry('message', 'message', 1, 1, 'assistant')],
      profileToCheck
    )
    expect(result.blocking).toHaveLength(1)
  })

  it.each([
    ['OpenAI baseline', openaiShapeBaseline],
    ['function response', functionResponseAdjacency],
  ])('passes an unwedgeable timeline for the %s profile', (_name, profileToCheck) => {
    const result = evaluateOrderingProfile(
      [entry('toolCall', 'call', 0, 0), entry('thought', 'thought', 1, 1)],
      profileToCheck
    )
    expect(result.blocking).toHaveLength(0)
  })

  it('repairs only the implicated order pair and preserves untouched relative order', () => {
    const timeline = [
      entry('message', 'user', 0, 0, 'user'),
      entry('message', 'assistant', 3, 1, 'assistant'),
      entry('toolCall', 'call', 1, 3),
      entry('thought', 'thought', 2, 2),
    ]
    const violation = evaluateOrderingProfile(
      timeline,
      profile({
        type: 'order',
        id: 'thought-before-tool',
        before: 'thought',
        after: 'toolCall',
        scope: 'entire-turn',
      })
    ).blocking
    expect(violation).toHaveLength(1)
    const originalUserIndex = timeline.findIndex((item) => item.value.id === 'user')
    const originalAssistantIndex = timeline.findIndex((item) => item.value.id === 'assistant')
    const result = repairViolations(timeline, violation)
    expect(result.unrepaired).toHaveLength(0)
    expect(result.timeline.map((item) => item.value.id)).toEqual([
      'user',
      'assistant',
      'thought',
      'call',
    ])
    const targetIndex = result.timeline.findIndex((item) => item.value.id === 'thought')
    const blockerIndex = result.timeline.findIndex((item) => item.value.id === 'call')
    expect(targetIndex).toBeLessThan(blockerIndex)
    expect(result.timeline.findIndex((item) => item.value.id === 'user')).toBe(originalUserIndex)
    expect(result.timeline.findIndex((item) => item.value.id === 'assistant')).toBe(
      originalAssistantIndex
    )
    const untouched = ['user', 'assistant']
    expect(
      result.timeline
        .filter((item) => untouched.includes(String(item.value.id)))
        .map((item) => item.value.id)
    ).toEqual(['user', 'assistant'])
    expect(
      evaluateOrderingProfile(
        result.timeline,
        profile({
          type: 'order',
          id: 'thought-before-tool',
          before: 'thought',
          after: 'toolCall',
          scope: 'entire-turn',
        })
      ).blocking
    ).toHaveLength(0)
  })
})

describe('setDotPath', () => {
  it('writes a flat key', () => {
    const target: Record<string, unknown> = {}
    setDotPath(target, 'flag', true)
    expect(target).toEqual({ flag: true })
  })

  it('creates missing intermediate objects for a nested path', () => {
    const target: Record<string, unknown> = {}
    setDotPath(target, 'a.b.c', 'value')
    expect(target).toEqual({ a: { b: { c: 'value' } } })
  })

  it('replaces a non-object intermediate segment rather than throwing', () => {
    const target: Record<string, unknown> = { a: 'not-an-object' }
    setDotPath(target, 'a.b', 'value')
    expect(target).toEqual({ a: { b: 'value' } })
  })

  it('replaces a null intermediate segment rather than throwing', () => {
    const target: Record<string, unknown> = { a: null }
    setDotPath(target, 'a.b', 'value')
    expect(target).toEqual({ a: { b: 'value' } })
  })

  it('preserves sibling fields at every level of the path', () => {
    const target: Record<string, unknown> = {
      a: { sibling: 'keep-me', b: { anotherSibling: 'keep-me-too' } },
    }
    setDotPath(target, 'a.b.c', 'value')
    expect(target).toEqual({
      a: { sibling: 'keep-me', b: { anotherSibling: 'keep-me-too', c: 'value' } },
    })
  })

  it('never mutates an object aliased from outside the shallow-copied top level', () => {
    // The realistic hazard this guards against: a caller shallow-copies only the TOP-level
    // object (`{ ...snapshot.payload }`), which still shares every NESTED object with the
    // original by reference. setDotPath must not write through that shared reference.
    const originalNested = { value: 'original' }
    const original: Record<string, unknown> = { signature: originalNested }
    const shallowCopy = { ...original }
    setDotPath(shallowCopy, 'signature.value', 'repaired')
    expect(originalNested.value).toBe('original')
    expect(original.signature).toBe(originalNested)
    expect(shallowCopy).toEqual({ signature: { value: 'repaired' } })
  })
})
