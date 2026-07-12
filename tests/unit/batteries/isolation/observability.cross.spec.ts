import { describe, expect, it, vi } from 'vitest'
import {
  emitIsolationReport,
  hasIsolationHook,
  type IsolationObservabilityHooks,
  type IsolationReportPhase,
} from '@nhtio/adk/batteries/isolation'

const ALL_PHASES: IsolationReportPhase[] = [
  'spawn:start',
  'spawn:ready',
  'spawn:error',
  'dispose:start',
  'dispose:done',
  'recycle:start',
  'recycle:done',
  'crash',
  'respawn:auto',
  'call:start',
  'call:settle',
  'stream:start',
  'stream:end',
  'stream:error',
  'stream:cancel',
  'abort:sent',
  'wire:out',
  'wire:in',
  'codec:escalate',
]

describe('hasIsolationHook()', () => {
  it('is false for every phase when hooks is undefined', () => {
    for (const phase of ALL_PHASES) {
      expect(hasIsolationHook(undefined, phase)).toBe(false)
    }
  })

  it('is false for every phase when hooks is an empty object', () => {
    for (const phase of ALL_PHASES) {
      expect(hasIsolationHook({}, phase)).toBe(false)
    }
  })

  it('is true for every phase once the firehose onIsolation is registered', () => {
    const hooks: IsolationObservabilityHooks = { onIsolation: vi.fn() }
    for (const phase of ALL_PHASES) {
      expect(hasIsolationHook(hooks, phase)).toBe(true)
    }
  })

  it("is true ONLY for phases in a per-phase-group hook's own group", () => {
    const hooks: IsolationObservabilityHooks = { onCall: vi.fn() }
    expect(hasIsolationHook(hooks, 'call:start')).toBe(true)
    expect(hasIsolationHook(hooks, 'call:settle')).toBe(true)
    expect(hasIsolationHook(hooks, 'spawn:start')).toBe(false)
    expect(hasIsolationHook(hooks, 'stream:start')).toBe(false)
  })

  it('debugPayloads alone (no callback) does not count as a registered hook', () => {
    const hooks: IsolationObservabilityHooks = { debugPayloads: true }
    for (const phase of ALL_PHASES) {
      expect(hasIsolationHook(hooks, phase)).toBe(false)
    }
  })
})

describe('emitIsolationReport() — zero overhead when unhooked', () => {
  it('does not call the `now` clock at all when no hook is registered', () => {
    const now = vi.fn(() => '2024-01-01T00:00:00.000Z')
    emitIsolationReport(undefined, 'spawn:start', { spawnCount: 1 }, undefined, now)
    expect(now).not.toHaveBeenCalled()
  })

  it('does not call the `now` clock when hooks exist but none match the phase', () => {
    const now = vi.fn(() => '2024-01-01T00:00:00.000Z')
    emitIsolationReport({ onCall: vi.fn() }, 'spawn:start', { spawnCount: 1 }, undefined, now)
    expect(now).not.toHaveBeenCalled()
  })
})

describe('emitIsolationReport() — dispatch to firehose + per-phase-group hook', () => {
  it('fires BOTH onIsolation and the matching per-phase-group hook for every phase', () => {
    for (const phase of ALL_PHASES) {
      const onIsolation = vi.fn()
      const groupHook = vi.fn()
      const hookKeyByPhase: Partial<
        Record<IsolationReportPhase, keyof IsolationObservabilityHooks>
      > = {
        'spawn:start': 'onSpawn',
        'spawn:ready': 'onSpawn',
        'spawn:error': 'onSpawn',
        'dispose:start': 'onDispose',
        'dispose:done': 'onDispose',
        'recycle:start': 'onRecycle',
        'recycle:done': 'onRecycle',
        'crash': 'onCrashReport',
        'respawn:auto': 'onRespawnAuto',
        'call:start': 'onCall',
        'call:settle': 'onCall',
        'stream:start': 'onStream',
        'stream:end': 'onStream',
        'stream:error': 'onStream',
        'stream:cancel': 'onStream',
        'abort:sent': 'onAbort',
        'wire:out': 'onWire',
        'wire:in': 'onWire',
        'codec:escalate': 'onCodecEscalate',
      }
      const groupKey = hookKeyByPhase[phase]!
      const hooks: IsolationObservabilityHooks = { onIsolation, [groupKey]: groupHook }
      emitIsolationReport(hooks, phase, { serviceName: 'svc', spawnCount: 2 })
      expect(onIsolation).toHaveBeenCalledTimes(1)
      expect(groupHook).toHaveBeenCalledTimes(1)
      const report = onIsolation.mock.calls[0][0]
      expect(report.phase).toBe(phase)
      expect(report.serviceName).toBe('svc')
      expect(report.spawnCount).toBe(2)
      expect(typeof report.at).toBe('string')
      expect(groupHook.mock.calls[0][0]).toBe(report) // same report object to both
    }
  })

  it('merges `extra` fields onto the report', () => {
    const onIsolation = vi.fn()
    emitIsolationReport(
      { onIsolation },
      'call:settle',
      { serviceName: 'svc', spawnCount: 1 },
      { method: 'add', durationMs: 12, ok: true }
    )
    const report = onIsolation.mock.calls[0][0]
    expect(report.method).toBe('add')
    expect(report.durationMs).toBe(12)
    expect(report.ok).toBe(true)
  })

  it('stamps `at` using the injectable clock', () => {
    const onIsolation = vi.fn()
    emitIsolationReport(
      { onIsolation },
      'spawn:start',
      { spawnCount: 1 },
      undefined,
      () => 'FIXED-TIMESTAMP'
    )
    expect(onIsolation.mock.calls[0][0].at).toBe('FIXED-TIMESTAMP')
  })
})

describe('emitIsolationReport() — throwing-hook containment', () => {
  it('a throwing onIsolation firehose does not prevent the per-phase-group hook from firing', () => {
    const groupHook = vi.fn()
    const hooks: IsolationObservabilityHooks = {
      onIsolation: () => {
        throw new Error('firehose consumer misbehaved')
      },
      onSpawn: groupHook,
    }
    expect(() => emitIsolationReport(hooks, 'spawn:start', { spawnCount: 1 })).not.toThrow()
    expect(groupHook).toHaveBeenCalledTimes(1)
  })

  it('a throwing per-phase-group hook does not propagate out of emitIsolationReport', () => {
    const onIsolation = vi.fn()
    const hooks: IsolationObservabilityHooks = {
      onIsolation,
      onSpawn: () => {
        throw new Error('group hook misbehaved')
      },
    }
    expect(() => emitIsolationReport(hooks, 'spawn:start', { spawnCount: 1 })).not.toThrow()
    expect(onIsolation).toHaveBeenCalledTimes(1)
  })
})
