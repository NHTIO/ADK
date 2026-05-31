import { describe, expect, it } from 'vitest'
import { DispatchRunner } from '../../../src/lib/dispatch_runner'
import type { RawDispatchContext } from '../../../src/lib/contracts/dispatch_context'
import type {
  DispatchExecutorFn,
  LogEvent,
  DispatchExecutorLogLevel,
} from '../../../src/lib/types/dispatch_runner'

const makeRaw = (): Omit<RawDispatchContext, 'hooks'> => ({
  systemPrompt: 'test',
  fetchMemories: async () => [],
  fetchMessages: async () => [],
  fetchThoughts: async () => [],
  fetchToolCalls: async () => [],
  fetchTools: async () => [],
  refreshStandingInstructions: async () => [],
  storeStandingInstruction: async () => {},
  mutateStandingInstruction: async () => {},
  deleteStandingInstruction: async () => {},
  storeMemory: async () => {},
  mutateMemory: async () => {},
  deleteMemory: async () => {},
  fetchRetrievables: async () => [],
  storeRetrievable: async () => {},
  mutateRetrievable: async () => {},
  deleteRetrievable: async () => {},
  storeMessage: async () => {},
  mutateMessage: async () => {},
  deleteMessage: async () => {},
  storeThought: async () => {},
  mutateThought: async () => {},
  deleteThought: async () => {},
  storeToolCall: async () => {},
  mutateToolCall: async () => {},
  deleteToolCall: async () => {},
  storeMediaBytes: () => {
    throw new Error('storeMediaBytes not used in this test')
  },
  storeRetrievableBytes: () => {
    throw new Error('storeRetrievableBytes not used in this test')
  },
})

describe('DispatchExecutorHelpers.log — structured observability channel', () => {
  it('exposes trace/debug/info/warn/error methods', async () => {
    const captured: DispatchExecutorLogLevel[] = []
    const executor: DispatchExecutorFn = (ctx, helpers) => {
      const levels: DispatchExecutorLogLevel[] = ['trace', 'debug', 'info', 'warn', 'error']
      for (const level of levels) {
        expect(typeof helpers.log[level]).toBe('function')
      }
      // Sanity: invoking each method does NOT throw, even if there are no listeners.
      helpers.log.trace({ kind: 't', message: 'trace msg' })
      helpers.log.debug({ kind: 'd', message: 'debug msg' })
      helpers.log.info({ kind: 'i', message: 'info msg' })
      helpers.log.warn({ kind: 'w', message: 'warn msg' })
      helpers.log.error({ kind: 'e', message: 'error msg' })
      ctx.ack()
    }
    await DispatchRunner.dispatch({
      raw: makeRaw(),
      executor,
      observers: {
        log: (event: LogEvent) => {
          captured.push(event.level)
        },
      },
    })
    expect(captured).toEqual(['trace', 'debug', 'info', 'warn', 'error'])
  })

  it('routes structured log entries to the observability bus with dispatchId + iteration + emittedAt', async () => {
    const captured: LogEvent[] = []
    const executor: DispatchExecutorFn = (ctx, helpers) => {
      helpers.log.warn({
        kind: 'retry-attempt',
        message: 'retrying after 429',
        payload: { attempt: 2, delayMs: 250 },
      })
      ctx.ack()
    }
    await DispatchRunner.dispatch({
      raw: makeRaw(),
      executor,
      observers: {
        log: (event: LogEvent) => {
          captured.push(event)
        },
      },
    })
    expect(captured).toHaveLength(1)
    const ev = captured[0]
    expect(ev.level).toBe('warn')
    expect(ev.kind).toBe('retry-attempt')
    expect(ev.message).toBe('retrying after 429')
    expect(ev.payload).toEqual({ attempt: 2, delayMs: 250 })
    expect(typeof ev.dispatchId).toBe('string')
    expect(ev.dispatchId.length).toBeGreaterThan(0)
    expect(ev.iteration).toBe(0)
    expect(ev.emittedAt).toBeDefined()
  })

  it('omits the payload property when none is supplied', async () => {
    const captured: LogEvent[] = []
    const executor: DispatchExecutorFn = (ctx, helpers) => {
      helpers.log.info({ kind: 'phase', message: 'starting' })
      ctx.ack()
    }
    await DispatchRunner.dispatch({
      raw: makeRaw(),
      executor,
      observers: {
        log: (event: LogEvent) => {
          captured.push(event)
        },
      },
    })
    expect(captured).toHaveLength(1)
    expect('payload' in captured[0]).toBe(false)
  })

  it('threads the current 0-based iteration index into every event', async () => {
    const captured: LogEvent[] = []
    let iterationsRun = 0
    const executor: DispatchExecutorFn = (ctx, helpers) => {
      helpers.log.debug({ kind: 'tick', message: `iter ${ctx.iteration}` })
      iterationsRun += 1
      if (iterationsRun >= 3) {
        ctx.ack()
      }
    }
    await DispatchRunner.dispatch({
      raw: makeRaw(),
      executor,
      observers: {
        log: (event: LogEvent) => {
          captured.push(event)
        },
      },
    })
    expect(captured.map((e) => e.iteration)).toEqual([0, 1, 2])
  })

  it('does not throw when no `log` observer is registered (silent egress)', async () => {
    const executor: DispatchExecutorFn = (ctx, helpers) => {
      helpers.log.error({ kind: 'failure', message: 'boom' })
      ctx.ack()
    }
    await expect(
      DispatchRunner.dispatch({
        raw: makeRaw(),
        executor,
      })
    ).resolves.toBeUndefined()
  })

  it('supports multiple observers receiving the same event (Hooks bus semantics)', async () => {
    const a: LogEvent[] = []
    const b: LogEvent[] = []
    const executor: DispatchExecutorFn = (ctx, helpers) => {
      helpers.log.info({ kind: 'broadcast', message: 'both should see this' })
      ctx.ack()
    }
    await DispatchRunner.dispatch({
      raw: makeRaw(),
      executor,
      observers: {
        log: [
          (event: LogEvent) => {
            a.push(event)
          },
          (event: LogEvent) => {
            b.push(event)
          },
        ],
      },
    })
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    expect(a[0].kind).toBe('broadcast')
    expect(b[0].kind).toBe('broadcast')
  })
})
