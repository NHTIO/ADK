import { describe, expect, it } from 'vitest'
import { validator } from '@nhtio/validation'
import { TurnGate } from '../../../src/lib/classes/turn_gate'
import {
  E_INVALID_INITIAL_TURN_GATE_VALUE,
  E_INVALID_TURN_GATE_RESOLUTION,
  E_TURN_GATE_ABORTED,
  E_TURN_GATE_TIMEOUT,
} from '../../../src/lib/exceptions/runtime'

const validRaw = () => ({
  id: 'gate-1',
  turnId: 'turn-1',
  reason: 'tool_approval',
  payload: { detail: 'awaiting approval' },
  createdAt: '2024-01-01T00:00:00.000Z',
})

describe('TurnGate', () => {
  describe('construction', () => {
    it('accepts valid raw input', () => {
      const g = new TurnGate(validRaw())
      expect(g.id).toBe('gate-1')
      expect(g.turnId).toBe('turn-1')
      expect(g.reason).toBe('tool_approval')
      expect(g.payload).toEqual({ detail: 'awaiting approval' })
      expect(g.isSettled).toBe(false)
    })

    it('throws when id is missing', () => {
      const r = validRaw() as Partial<ReturnType<typeof validRaw>>
      delete r.id
      expect(() => new TurnGate(r as ReturnType<typeof validRaw>)).toThrow(
        E_INVALID_INITIAL_TURN_GATE_VALUE
      )
    })

    it('throws when reason is missing', () => {
      const r = validRaw() as Partial<ReturnType<typeof validRaw>>
      delete r.reason
      expect(() => new TurnGate(r as ReturnType<typeof validRaw>)).toThrow(
        E_INVALID_INITIAL_TURN_GATE_VALUE
      )
    })
  })

  describe('resolve', () => {
    it('settles the internal promise with the resolved value', async () => {
      const g = new TurnGate(validRaw())
      const promise = (g as unknown as { _promise: () => Promise<unknown> })._promise()
      g.resolve('approved')
      await expect(promise).resolves.toBe('approved')
      expect(g.isSettled).toBe(true)
    })

    it('validates the resolution value when a schema was provided', () => {
      const g = new TurnGate({ ...validRaw(), schema: validator.boolean().required() })
      expect(() => g.resolve('not a boolean')).toThrow(E_INVALID_TURN_GATE_RESOLUTION)
      // Gate must remain open since validation failed
      expect(g.isSettled).toBe(false)
    })

    it('accepts a value that passes the schema', async () => {
      const g = new TurnGate({ ...validRaw(), schema: validator.boolean().required() })
      const promise = (g as unknown as { _promise: () => Promise<boolean> })._promise()
      g.resolve(true)
      await expect(promise).resolves.toBe(true)
    })

    it('no-ops when the gate is already settled', async () => {
      const g = new TurnGate(validRaw())
      const promise = (g as unknown as { _promise: () => Promise<unknown> })._promise()
      g.resolve('first')
      g.resolve('second')
      await expect(promise).resolves.toBe('first')
    })
  })

  describe('reject', () => {
    it('rejects the promise with the provided error', async () => {
      const g = new TurnGate(validRaw())
      const promise = (g as unknown as { _promise: () => Promise<unknown> })._promise()
      const err = new Error('explicit rejection')
      g.reject(err)
      await expect(promise).rejects.toBe(err)
      expect(g.isSettled).toBe(true)
    })

    it('no-ops when the gate is already settled', async () => {
      const g = new TurnGate(validRaw())
      const promise = (g as unknown as { _promise: () => Promise<unknown> })._promise()
      g.resolve('ok')
      g.reject(new Error('too late'))
      await expect(promise).resolves.toBe('ok')
    })
  })

  describe('abort', () => {
    it('rejects the promise with E_TURN_GATE_ABORTED', async () => {
      const g = new TurnGate(validRaw())
      const promise = (g as unknown as { _promise: () => Promise<unknown> })._promise()
      g.abort()
      await expect(promise).rejects.toBeInstanceOf(E_TURN_GATE_ABORTED)
      expect(g.isSettled).toBe(true)
    })

    it('no-ops when the gate is already settled', async () => {
      const g = new TurnGate(validRaw())
      const promise = (g as unknown as { _promise: () => Promise<unknown> })._promise()
      g.resolve('ok')
      g.abort()
      await expect(promise).resolves.toBe('ok')
    })
  })

  describe('external abort signal', () => {
    it('rejects with E_TURN_GATE_ABORTED when the external signal fires', async () => {
      const ac = new AbortController()
      const g = new TurnGate({ ...validRaw(), abortSignal: ac.signal })
      const promise = (g as unknown as { _promise: () => Promise<unknown> })._promise()
      ac.abort()
      await expect(promise).rejects.toBeInstanceOf(E_TURN_GATE_ABORTED)
    })

    it('rejects when the external signal is already aborted at construction time', async () => {
      const ac = new AbortController()
      ac.abort()
      const g = new TurnGate({ ...validRaw(), abortSignal: ac.signal })
      const promise = (g as unknown as { _promise: () => Promise<unknown> })._promise()
      await expect(promise).rejects.toBeInstanceOf(E_TURN_GATE_ABORTED)
    })
  })

  describe('timeout', () => {
    it('rejects with E_TURN_GATE_TIMEOUT after the configured duration', async () => {
      const g = new TurnGate({ ...validRaw(), timeout: 25 })
      const promise = (g as unknown as { _promise: () => Promise<unknown> })._promise()
      await expect(promise).rejects.toBeInstanceOf(E_TURN_GATE_TIMEOUT)
    })

    it('does not fire the timeout when the gate is resolved first', async () => {
      const g = new TurnGate({ ...validRaw(), timeout: 200 })
      const promise = (g as unknown as { _promise: () => Promise<unknown> })._promise()
      g.resolve('ok')
      await expect(promise).resolves.toBe('ok')
    })
  })

  describe('TurnGate.isTurnGate', () => {
    it('returns true for TurnGate instances', () => {
      expect(TurnGate.isTurnGate(new TurnGate(validRaw()))).toBe(true)
    })

    it('returns false for plain objects of the same shape', () => {
      expect(TurnGate.isTurnGate(validRaw())).toBe(false)
    })

    it('returns false for null / undefined / primitives', () => {
      expect(TurnGate.isTurnGate(null)).toBe(false)
      expect(TurnGate.isTurnGate(undefined)).toBe(false)
      expect(TurnGate.isTurnGate('gate')).toBe(false)
    })
  })
})
