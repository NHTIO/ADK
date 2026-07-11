import { describe, expect, it, vi } from 'vitest'
import {
  runWithEstimationWarnings,
  currentEstimationWarnEmitter,
} from '../../../src/lib/utils/estimation_context'
import type { EstimationWarning } from '../../../src/lib/utils/estimation_context'

const warn: EstimationWarning = {
  encoding: 'cl100k_base',
  error: new Error('boom'),
  textPreview: 'preview',
}

describe('estimation_context', () => {
  it('exposes no emitter outside a run scope (the "throw loud" signal)', () => {
    expect(currentEstimationWarnEmitter()).toBeUndefined()
  })

  it('publishes the emitter for the duration of a sync body, then restores', () => {
    const emit = vi.fn()
    const seenInside = runWithEstimationWarnings(emit, () => currentEstimationWarnEmitter())
    expect(seenInside).toBe(emit)
    // Restored to none after the body returns.
    expect(currentEstimationWarnEmitter()).toBeUndefined()
  })

  it('restores the previous emitter even when the body throws', () => {
    const emit = vi.fn()
    expect(() =>
      runWithEstimationWarnings(emit, () => {
        throw new Error('body failed')
      })
    ).toThrow('body failed')
    expect(currentEstimationWarnEmitter()).toBeUndefined()
  })

  it('keeps the emitter active across an async body and pops after it settles', async () => {
    const emit = vi.fn()
    const promise = runWithEstimationWarnings(emit, async () => {
      // Active while the async body runs.
      expect(currentEstimationWarnEmitter()).toBe(emit)
      await Promise.resolve()
      expect(currentEstimationWarnEmitter()).toBe(emit)
      return 'done'
    })
    // Still active until the returned promise settles.
    expect(currentEstimationWarnEmitter()).toBe(emit)
    await expect(promise).resolves.toBe('done')
    // Popped once the async body has settled.
    expect(currentEstimationWarnEmitter()).toBeUndefined()
  })

  it('pops after a rejected async body', async () => {
    const emit = vi.fn()
    const promise = runWithEstimationWarnings(emit, async () => {
      throw new Error('async body failed')
    })
    await expect(promise).rejects.toThrow('async body failed')
    expect(currentEstimationWarnEmitter()).toBeUndefined()
  })

  it('nests LIFO: the innermost (e.g. dispatch) emitter wins, the outer (turn) restores after', () => {
    const outer = vi.fn()
    const inner = vi.fn()
    runWithEstimationWarnings(outer, () => {
      expect(currentEstimationWarnEmitter()).toBe(outer)
      runWithEstimationWarnings(inner, () => {
        // Innermost wins — this is the "prefer dispatch when both active" rule.
        expect(currentEstimationWarnEmitter()).toBe(inner)
      })
      // Outer restored once the inner scope exits.
      expect(currentEstimationWarnEmitter()).toBe(outer)
    })
    expect(currentEstimationWarnEmitter()).toBeUndefined()
  })

  it('forwards the exact warning payload to the active emitter', () => {
    const emit = vi.fn()
    runWithEstimationWarnings(emit, () => {
      currentEstimationWarnEmitter()?.(warn)
    })
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith(warn)
  })
})
