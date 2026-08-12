import { describe, expect, it, vi } from 'vitest'
import { guestLimitFloors } from '../../../../src/batteries/sandbox/types'
import { E_INVALID_SANDBOX_CONFIG } from '../../../../src/batteries/sandbox/exceptions'
import { createEvaluateJavascriptTool } from '../../../../src/batteries/sandbox/js/tool'
import { E_SES_EVALUATION_TIMEOUT } from '../../../../src/batteries/sandbox/js/exceptions'
import { createCompartmentRuntime } from '../../../../src/batteries/sandbox/js/compartment'
import {
  resolveGuestLimits,
  resolveHostcallQuotas,
} from '../../../../src/batteries/sandbox/js/validation'

const gate = async () => {}

describe('sandbox JavaScript B1 configuration', () => {
  it('resolves all seven guest limits and accepts logDrainMs zero', () => {
    const limits = resolveGuestLimits({ logDrainMs: 0, maxLogEvents: 2 })
    expect(Object.keys(limits)).toHaveLength(7)
    expect(limits.logDrainMs).toBe(0)
    expect(limits.maxLogEvents).toBe(2)
  })
  it('rejects every guest-limit floor and non-finite/non-integer values with field details', () => {
    for (const [field, floor] of Object.entries(guestLimitFloors)) {
      for (const value of [floor - 1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
        expect(() => resolveGuestLimits({ [field]: value })).toThrow(
          new RegExp(`limits\\.${field}`)
        )
      }
    }
    expect(() => resolveGuestLimits({ logDrainMs: -1 })).toThrow(/0/)
  })
  it('resolves and validates all three hostcall quotas independently', () => {
    const q = resolveHostcallQuotas({
      hostcallTimeoutMs: 11,
      maxHostcallsPerEvaluation: 2,
      maxConcurrentHostcalls: 3,
    })
    expect(q).toEqual({
      hostcallTimeoutMs: 11,
      maxHostcallsPerEvaluation: 2,
      maxConcurrentHostcalls: 3,
    })
    for (const field of [
      'hostcallTimeoutMs',
      'maxHostcallsPerEvaluation',
      'maxConcurrentHostcalls',
    ]) {
      for (const value of [0, Number.NaN, Number.POSITIVE_INFINITY, 1.5])
        expect(() => resolveHostcallQuotas({ [field]: value })).toThrow(
          new RegExp(`hostcallQuotas\\.${field}`)
        )
    }
  })
})

describe('SES guest realm', () => {
  it('has only injected globals and no ambient authority', async () => {
    const runtime = await createCompartmentRuntime({ answer: () => 42 }, resolveGuestLimits())
    const out = await runtime.evaluate(
      '({ answer: answer(), fetch: typeof fetch, process: typeof process, require: typeof require })',
      { timeoutMs: 1000 }
    )
    expect(out.ok).toBe(true)
    if (out.ok)
      expect(out.result).toMatchObject({
        answer: 42,
        fetch: 'undefined',
        process: 'undefined',
        require: 'undefined',
      })
  })
  it('runs lockdown before evaluation and returns typed guest throws', async () => {
    const runtime = await createCompartmentRuntime({}, resolveGuestLimits())
    const out = await runtime.evaluate('throw undefined', { timeoutMs: 1000 })
    expect(out.ok).toBe(false)
    if (!out.ok) expect(out.thrown.kind).toBe('error')
  })
  it('logs before a throw and retains the authoritative thrown result', async () => {
    const runtime = await createCompartmentRuntime({}, resolveGuestLimits())
    const out = await runtime.evaluate(
      "(()=>{ console.log('success'); throw new Error('boom') })()",
      {
        timeoutMs: 1000,
      }
    )
    expect(out.ok).toBe(false)
    expect(out.logs.map((x) => x.text)).toEqual(['success'])
    if (!out.ok) expect(out.thrown).toMatchObject({ kind: 'error', message: 'boom' })
  })
  it('truncates received log events in the guest with the pinned suffix', async () => {
    const runtime = await createCompartmentRuntime({}, resolveGuestLimits({ maxLogEventBytes: 32 }))
    const out = await runtime.evaluate("(()=>{ console.log('x'.repeat(100)); return 1 })()", {
      timeoutMs: 1000,
    })
    expect(out.logs[0].truncated).toBe(true)
    expect(out.logs[0].text.endsWith('… [cut]')).toBe(true)
  })
  it('kills an infinite loop and reports narrated timed-out without hanging the test process', async () => {
    const killed = vi.fn()
    const tool = createEvaluateJavascriptTool({
      gate,
      runtime: {
        async spawn() {
          return {
            async evaluate(source: string) {
              expect(source).toContain('while(1)')
              await killed()
              throw new E_SES_EVALUATION_TIMEOUT(['runtime timeout'])
            },
            async kill() {
              killed()
            },
          }
        },
      },
    })
    const ctx = {
      abortSignal: new AbortController().signal,
      id: 'timeout-test',
      emitToolExecutionStart: () => {},
      emitToolExecutionEnd: () => {},
    } as never
    await expect(
      tool.executor(ctx)({ source: 'while(1){}', timeout_seconds: 1 })
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        code: 'E_SANDBOX_FAILED',
        message: expect.stringMatching(/1 seconds.*timed-out/),
      }),
    })
    expect(killed).toHaveBeenCalled()
    expect(JSON.stringify(killed.mock.calls)).not.toContain('E_SES_EVALUATION_TIMEOUT')
  }, 1000)
  it('tool catches runtime timeout and narrates the argument without leaking runtime code', async () => {
    const tool = createEvaluateJavascriptTool({
      gate,
      runtime: {
        async spawn() {
          return {
            async evaluate() {
              throw new E_SES_EVALUATION_TIMEOUT(['runtime timeout'])
            },
            async kill() {},
          }
        },
      },
    })
    const ctx = {
      abortSignal: new AbortController().signal,
      id: 'test',
      emitToolExecutionStart: () => {},
      emitToolExecutionEnd: () => {},
    } as never
    await expect(
      tool.executor(ctx)({ source: 'while(1){}', timeout_seconds: 3 })
    ).rejects.toMatchObject({
      message: 'The tool handler threw an error during execution.',
      cause: expect.objectContaining({ message: expect.stringMatching(/3 seconds.*timed-out/) }),
    })
  })
  it('does not invent the old bespoke codec vocabulary', async () => {
    const runtime = await createCompartmentRuntime({}, resolveGuestLimits())
    for (const source of ['123n', 'undefined', 'new Map([ [1, 2] ])', 'Symbol()']) {
      const out = await runtime.evaluate(source, { timeoutMs: 1000 })
      expect(out.ok).toBe(true)
      if (out.ok) expect(['encoder', 'partial']).toContain(out.encoding)
      expect(JSON.stringify(out)).not.toContain('__adk')
    }
  })
  it('requires a gate', () => {
    expect(() => createEvaluateJavascriptTool({ gate: undefined as never })).toThrow(
      /requires a gate/
    )
  })
  it('uses the typed config exception', () => {
    expect(() => resolveGuestLimits({ maxHostcallBytes: 4095 })).toThrow(E_INVALID_SANDBOX_CONFIG)
  })
})
