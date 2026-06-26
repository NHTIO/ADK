// Unit coverage for the shared battery lifecycle contract (emitLifecycle). Env-neutral (node + browser),
// no provider peers — just the firehose/per-phase dispatch logic, the `at` stamp, and the defensive
// swallow-throws guarantee. The names are imported from the transformers.js battery barrel (which
// re-exports the chat_common lifecycle layer, the same way it re-exports the parser layer).

import { describe, expect, it, vi } from 'vitest'
import { emitLifecycle } from '@nhtio/adk/batteries/llm/transformers_js'
import type {
  BatteryLifecycleReport,
  BatteryLifecycleHooks,
} from '@nhtio/adk/batteries/llm/transformers_js'

describe('emitLifecycle', () => {
  it('fires the firehose AND the matching per-phase hook for a phase', () => {
    const seen: BatteryLifecycleReport[] = []
    const onLoading = vi.fn()
    const onReady = vi.fn()
    const hooks: BatteryLifecycleHooks = {
      onLifecycle: (r) => seen.push(r),
      onLoading,
      onReady,
    }
    emitLifecycle(hooks, 'transformers_js', 'some/model', 'loading', {
      progress: 0.5,
      detail: 'dl',
    })

    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      phase: 'loading',
      battery: 'transformers_js',
      model: 'some/model',
      progress: 0.5,
      detail: 'dl',
    })
    expect(onLoading).toHaveBeenCalledOnce()
    expect(onReady).not.toHaveBeenCalled()
    // The per-phase hook receives the same report shape as the firehose.
    expect((onLoading.mock.calls[0][0] as BatteryLifecycleReport).phase).toBe('loading')
  })

  it('stamps an ISO-8601 `at` (injectable clock)', () => {
    let report: BatteryLifecycleReport | undefined
    emitLifecycle(
      { onLifecycle: (r) => (report = r) },
      'litert_lm',
      '<blob>',
      'ready',
      undefined,
      () => '2026-01-02T03:04:05.000Z'
    )
    expect(report?.at).toBe('2026-01-02T03:04:05.000Z')
    expect(report?.model).toBe('<blob>')
  })

  it('routes each phase to its own per-phase hook', () => {
    const calls: string[] = []
    const hooks: BatteryLifecycleHooks = {
      onLoading: () => calls.push('loading'),
      onCompiling: () => calls.push('compiling'),
      onReady: () => calls.push('ready'),
      onGenerating: () => calls.push('generating'),
      onComplete: () => calls.push('complete'),
      onError: () => calls.push('error'),
    }
    for (const phase of [
      'loading',
      'compiling',
      'ready',
      'generating',
      'complete',
      'error',
    ] as const) {
      emitLifecycle(hooks, 'webllm', 'm', phase)
    }
    expect(calls).toEqual(['loading', 'compiling', 'ready', 'generating', 'complete', 'error'])
  })

  it('fires the firehose AND onCompiling for the compiling phase (the WebGPU boot marker)', () => {
    const seen: BatteryLifecycleReport[] = []
    const onCompiling = vi.fn()
    emitLifecycle(
      { onLifecycle: (r) => seen.push(r), onCompiling },
      'litert_lm',
      'gemma',
      'compiling',
      { detail: 'compiling model + WebGPU shaders' }
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      phase: 'compiling',
      detail: 'compiling model + WebGPU shaders',
    })
    expect(onCompiling).toHaveBeenCalledOnce()
    // Coarse marker: no granular progress (the runtimes expose the boundary, not a progress stream).
    expect(seen[0]?.progress).toBeUndefined()
  })

  it('carries `error` only on the error phase', () => {
    let report: BatteryLifecycleReport | undefined
    const boom = new Error('load failed')
    emitLifecycle({ onError: (r) => (report = r) }, 'transformers_js_embed', 'm', 'error', {
      error: boom,
    })
    expect(report?.phase).toBe('error')
    expect(report?.error).toBe(boom)
  })

  it('is a no-op when hooks is undefined', () => {
    expect(() => emitLifecycle(undefined, 'webllm', 'm', 'ready')).not.toThrow()
  })

  it('is a no-op when no relevant callback is registered (firehose absent + that phase hook absent)', () => {
    const onReady = vi.fn()
    // Only onReady registered; emitting `loading` must invoke nothing.
    emitLifecycle({ onReady }, 'litert_lm', 'm', 'loading')
    expect(onReady).not.toHaveBeenCalled()
  })

  it('swallows a throwing consumer hook (never breaks the caller) and still fires the others', () => {
    const after = vi.fn()
    const hooks: BatteryLifecycleHooks = {
      onLifecycle: () => {
        throw new Error('consumer blew up')
      },
      onReady: after,
    }
    // Must NOT throw, and the per-phase hook still runs even though the firehose threw.
    expect(() => emitLifecycle(hooks, 'transformers_js', 'm', 'ready')).not.toThrow()
    expect(after).toHaveBeenCalledOnce()
  })
})
