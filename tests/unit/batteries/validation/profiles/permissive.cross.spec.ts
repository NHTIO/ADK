import { DateTime } from 'luxon'
import { describe, expect, it } from 'vitest'
import { Message, Thought, ToolCall, Tokenizable } from '@nhtio/adk/common'
import { permissive } from '../../../../../src/batteries/validation/profiles/permissive'
import {
  buildOrderingTimeline,
  evaluateOrderingProfile,
  repairViolations,
} from '../../../../../src/batteries/validation/helpers'

const at = (second: number): DateTime => DateTime.fromMillis(second * 1000)
const message = (id: string, role: 'user' | 'assistant', second: number): Message =>
  new Message({
    id,
    role,
    content: id,
    createdAt: at(second),
    updatedAt: at(second),
  })
const thought = (id: string, second: number): Thought =>
  new Thought({
    id,
    content: id,
    createdAt: at(second),
    updatedAt: at(second),
  })
const toolCall = (id: string, second: number): ToolCall =>
  new ToolCall({
    id,
    tool: 'sample',
    args: {},
    checksum: id,
    isComplete: true,
    isError: false,
    results: new Tokenizable('result'),
    createdAt: at(second),
    updatedAt: at(second),
    completedAt: at(second),
  })
const timeline = (messages: Message[], thoughts: Thought[], calls: ToolCall[]) =>
  buildOrderingTimeline(messages, thoughts, calls)

describe('permissive profile', () => {
  describe('happy path', () => {
    it('accepts a normal user, thought, tool-call, and assistant timeline', () => {
      const result = evaluateOrderingProfile(
        timeline(
          [message('u1', 'user', 1), message('a1', 'assistant', 4)],
          [thought('t1', 2)],
          [toolCall('c1', 3)]
        ),
        permissive
      )
      expect(result.blocking).toHaveLength(0)
      expect(result.advisories).toHaveLength(0)
    })
  })

  describe('sabotage', () => {
    it('accepts an aggressively disordered timeline because no rules are checked', () => {
      const result = evaluateOrderingProfile(
        timeline(
          [message('a1', 'assistant', 1), message('a2', 'assistant', 5), message('u1', 'user', 3)],
          [thought('t1', 2)],
          [toolCall('c1', 4), toolCall('c2', 0)]
        ),
        permissive
      )
      expect(result.blocking).toHaveLength(0)
      expect(result.advisories).toHaveLength(0)
    })
  })

  describe('mutation', () => {
    it('has nothing to repair because the permissive profile produces no violations', () => {
      const violations = evaluateOrderingProfile(
        timeline(
          [message('a1', 'assistant', 1), message('a2', 'assistant', 2)],
          [thought('t1', 3)],
          [toolCall('c1', 0)]
        ),
        permissive
      ).blocking
      const result = repairViolations(
        timeline(
          [message('a1', 'assistant', 1), message('a2', 'assistant', 2)],
          [thought('t1', 3)],
          [toolCall('c1', 0)]
        ),
        violations
      )
      expect(result.repaired).toHaveLength(0)
      expect(result.unrepaired).toHaveLength(0)
    })
  })
})
