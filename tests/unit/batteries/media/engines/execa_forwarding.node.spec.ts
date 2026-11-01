import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { execaExecutor } from '../../../../../src/batteries/media/engines/execa_executor'
import type { BinaryInvocation } from '../../../../../src/batteries/media/contracts'
import type {
  ExecaLike,
  ExecaResultLike,
} from '../../../../../src/batteries/media/engines/execa_executor'

/**
 * execaExecutor option-forwarding and kill-control semantics, against a BYO `ExecaLike` fake.
 *
 * @remarks
 * The fake tests inspect forwarded options and executor-owned termination timing;
 * real-execa tests measure process behaviour separately. The fake mimics execa's returned
 * shape (a promise carrying `pid`/`kill`) so the executor's group-kill seam is exercisable, and
 * records the options object verbatim for per-case assertions.
 */

/** What the fake recorded for one call. */
type Recorded = {
  cmd: string
  args: readonly string[]
  options: ExecaParameters
}

type ExecaParameters = Parameters<ExecaLike>[2]

/** Build an `ExecaLike` that records calls and settles like a killed/successful subprocess. */
const recordingExeca = (
  settle: (subprocess: {
    pid?: number
    kill: (s?: string) => boolean
  }) => Partial<ExecaResultLike> | Promise<Partial<ExecaResultLike>> = () => ({
    exitCode: 0,
    failed: false,
  })
): { execa: ExecaLike; calls: Recorded[] } => {
  const calls: Recorded[] = []
  const execa: ExecaLike = (cmd, args, options) => {
    calls.push({ cmd, args, options })
    const subprocess = {
      pid: 4242,
      kill: vi.fn(() => true) as (s?: string) => boolean,
    }
    const promise = Promise.resolve(settle(subprocess)).then((partial) => ({
      exitCode: 0,
      stdout: '',
      stderr: '',
      failed: false,
      ...partial,
    })) as Promise<ExecaResultLike>
    return Object.assign(promise, subprocess) as unknown as ReturnType<ExecaLike>
  }
  // execa's own function carries helper methods (`execa.exec`, `execaCommand`, …) — the executor's
  // resolver heuristic distinguishes a resolver thunk from the module by exactly that, so a BYO
  // substitute has to keep one helper method too.
  return { execa: Object.assign(execa, { exec: execa }) as ExecaLike, calls }
}

const invocation = (extra: Partial<BinaryInvocation> = {}): BinaryInvocation => ({
  cmd: 'echo',
  args: ['hi'],
  ...extra,
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('execaExecutor forwards invocation options', () => {
  it('chunks oversized escalation timers without firing before the monotonic deadline', async () => {
    vi.useFakeTimers()
    try {
      const groupKill = vi.spyOn(process, 'kill').mockReturnValue(true)
      const controller = new AbortController()
      const calls: Recorded[] = []
      const fn: ExecaLike = (cmd, args, options) => {
        calls.push({ cmd, args, options })
        return Object.assign(new Promise<ExecaResultLike>(() => {}), {
          pid: 4242,
          kill: vi.fn(() => true),
        }) as unknown as ReturnType<ExecaLike>
      }
      const execa = Object.assign(fn, { exec: fn }) as ExecaLike
      const promise = execaExecutor({ execa }).exec(
        invocation({
          signal: controller.signal,
          forceKillAfterDelay: 3_000_000_000,
        })
      )
      controller.abort()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(vi.getTimerCount()).toBeLessThanOrEqual(2)
      expect(groupKill).not.toHaveBeenCalledWith(-4242, 'SIGKILL')
      await vi.advanceTimersByTimeAsync(2_147_483_647 - 1_000)
      expect(groupKill).not.toHaveBeenCalledWith(-4242, 'SIGKILL')
      await vi.advanceTimersByTimeAsync(3_000_000_000 - 2_147_483_647)
      expect(groupKill.mock.calls.filter((call) => call[1] === 'SIGKILL')).toHaveLength(1)
      void promise
    } finally {
      vi.useRealTimers()
    }
  })
  it('owns the timeout and kills the detached group before settlement', async () => {
    vi.useFakeTimers()
    try {
      const groupKill = vi.spyOn(process, 'kill').mockReturnValue(true)
      let settle!: (result: ExecaResultLike) => void
      const calls: Recorded[] = []
      const fn: ExecaLike = (cmd, args, options) => {
        calls.push({ cmd, args, options })
        const promise = new Promise<ExecaResultLike>((resolve) => {
          settle = resolve
        })
        const childKill = vi.fn((_signal?: string) => true)
        // Faithful execa timeout behavior: its own timeout kills only the direct child
        // and settles the subprocess. The executor must not delegate this deadline.
        if (options.timeout !== undefined) {
          setTimeout(() => {
            childKill(options.killSignal)
            settle({ exitCode: -1, failed: true, signal: options.killSignal })
          }, options.timeout)
        }
        return Object.assign(promise, {
          pid: 4242,
          kill: childKill,
        }) as unknown as ReturnType<ExecaLike>
      }
      const execa = Object.assign(fn, { exec: fn }) as ExecaLike
      const pending = execaExecutor({ execa }).exec(
        invocation({ timeoutMs: 100, forceKillAfterDelay: false })
      )
      let settled = false
      void pending.then(() => {
        settled = true
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(calls[0]!.options.timeout).toBeUndefined()
      await vi.advanceTimersByTimeAsync(100)
      expect(groupKill).toHaveBeenCalledWith(-4242, 'SIGTERM')
      expect(settled).toBe(false)
      settle({ exitCode: -1, failed: true, signal: 'SIGTERM' })
      await pending
    } finally {
      vi.useRealTimers()
    }
  })
  it('defaults: no cwd/env keys, extendEnv true, SIGTERM, 5s escalation, detached', async () => {
    const { execa, calls } = recordingExeca()
    await execaExecutor({ execa }).exec(invocation())
    expect(calls).toHaveLength(1)
    const { options } = calls[0]!
    expect('cwd' in options).toBe(false)
    expect('env' in options).toBe(false)
    expect(options.extendEnv).toBe(true)
    expect(options.killSignal).toBe('SIGTERM')
    expect(options.forceKillAfterDelay).toBe(5_000)
    expect(options.detached).toBe(true)
    expect('timeout' in options).toBe(false)
    expect(options.reject).toBe(false)
    expect(options.stripFinalNewline).toBe(true)
  })

  it('rejects invalid settlement policies before spawn', async () => {
    const { execa, calls } = recordingExeca()
    const invalid = 'unknown' as BinaryInvocation['settleEscalation']
    await expect(
      execaExecutor({ execa }).exec(invocation({ settleEscalation: invalid }))
    ).rejects.toThrow(TypeError)
    await expect(
      execaExecutor({ execa, defaultSettleEscalation: invalid }).exec(invocation())
    ).rejects.toThrow(TypeError)
    expect(calls).toHaveLength(0)
  })

  it('forwards cwd and env verbatim', async () => {
    const { execa, calls } = recordingExeca()
    await execaExecutor({ execa }).exec(
      invocation({ cwd: '/workspace/x', env: { FOO: 'bar', PATH: '/own' } })
    )
    const { options } = calls[0]!
    expect(options.cwd).toBe('/workspace/x')
    expect(options.env).toEqual({ FOO: 'bar', PATH: '/own' })
  })

  it('maps extendEnv:false so a sandbox allow-list cannot be defeated', async () => {
    const { execa, calls } = recordingExeca()
    await execaExecutor({ execa }).exec(invocation({ env: { PATH: '/only' }, extendEnv: false }))
    expect(calls[0]!.options.extendEnv).toBe(false)
  })

  it('omits env when the invocation carries none (never an empty-object merge)', async () => {
    const { execa, calls } = recordingExeca()
    await execaExecutor({ execa }).exec(invocation({ extendEnv: false }))
    expect('env' in calls[0]!.options).toBe(false)
    expect(calls[0]!.options.extendEnv).toBe(false)
  })

  it.each([
    { value: Infinity, forwarded: false },
    { value: 3_000_000_000, forwarded: false },
    { value: 2_000, forwarded: 2_000 },
  ])('normalizes forceKillAfterDelay $value for execa', async ({ value, forwarded }) => {
    const { execa, calls } = recordingExeca()
    await execaExecutor({ execa }).exec(invocation({ forceKillAfterDelay: value }))
    expect(calls[0]!.options.forceKillAfterDelay).toBe(forwarded)
  })

  it('reports an executor-owned timeout as failure when the process exits 0 after SIGTERM', async () => {
    vi.useFakeTimers()
    try {
      const groupKill = vi.spyOn(process, 'kill').mockReturnValue(true)
      let settle!: (result: ExecaResultLike) => void
      const fn: ExecaLike = () =>
        Object.assign(
          new Promise<ExecaResultLike>((resolve) => {
            settle = resolve
          }),
          {
            pid: 4242,
            kill: vi.fn(() => true),
          }
        ) as unknown as ReturnType<ExecaLike>
      const execa = Object.assign(fn, { exec: fn }) as ExecaLike
      const pending = execaExecutor({ execa }).exec(
        invocation({ timeoutMs: 100, forceKillAfterDelay: false })
      )
      await vi.advanceTimersByTimeAsync(100)
      expect(groupKill).toHaveBeenCalledWith(-4242, 'SIGTERM')
      settle({ exitCode: 0, failed: false })
      await expect(pending).resolves.toMatchObject({ exitCode: 0, failed: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('runs real execa with forceKillAfterDelay: Infinity', async () => {
    const executor = execaExecutor()
    const result = await executor.exec({
      cmd: 'true',
      args: [],
      forceKillAfterDelay: Infinity,
    })
    expect(result.exitCode).toBe(0)
  })

  it('reports a handled abort as failure when the process exits 0', async () => {
    const controller = new AbortController()
    let settle!: (result: ExecaResultLike) => void
    const fn: ExecaLike = () =>
      Object.assign(
        new Promise<ExecaResultLike>((resolve) => {
          settle = resolve
        }),
        {
          pid: 4242,
          kill: vi.fn(() => true),
        }
      ) as unknown as ReturnType<ExecaLike>
    const execa = Object.assign(fn, { exec: fn }) as ExecaLike
    const pending = execaExecutor({ execa }).exec(
      invocation({ signal: controller.signal, forceKillAfterDelay: false })
    )
    while (!settle) await Promise.resolve()
    controller.abort()
    settle({ exitCode: 0, failed: true })
    await expect(pending).resolves.toMatchObject({ exitCode: 0, failed: true })
  })

  it('reports a normal exit 0 as success', async () => {
    const { execa } = recordingExeca()
    await expect(execaExecutor({ execa }).exec(invocation())).resolves.toMatchObject({
      exitCode: 0,
      failed: false,
    })
  })

  it('runs real execa with handled TERM after timeout as failure', async () => {
    const result = await execaExecutor().exec({
      cmd: 'sh',
      args: ['-c', "trap 'exit 0' TERM; sleep 5 & wait"],
      timeoutMs: 100,
      forceKillAfterDelay: false,
    })
    expect(result.failed).toBe(true)
  })

  it('forwards killSignal and forceKillAfterDelay, including forceKillAfterDelay: false', async () => {
    const { execa, calls } = recordingExeca()
    await execaExecutor({ execa }).exec(
      invocation({ killSignal: 'SIGINT', forceKillAfterDelay: false })
    )
    expect(calls[0]!.options.killSignal).toBe('SIGINT')
    // `false` is a MEANINGFUL value (never escalate); only `undefined` falls back to the default.
    expect(calls[0]!.options.forceKillAfterDelay).toBe(false)
  })

  it('executor-level defaults apply when the invocation omits the kill controls', async () => {
    const { execa, calls } = recordingExeca()
    await execaExecutor({
      execa,
      defaultKillSignal: 'SIGHUP',
      defaultForceKillAfterDelay: 250,
    }).exec(invocation())
    expect(calls[0]!.options.killSignal).toBe('SIGHUP')
    expect(calls[0]!.options.forceKillAfterDelay).toBe(250)
  })

  it('executor-level defaults do not override per-invocation values', async () => {
    const { execa, calls } = recordingExeca()
    await execaExecutor({
      execa,
      defaultKillSignal: 'SIGHUP',
      defaultForceKillAfterDelay: 250,
    }).exec(invocation({ killSignal: 'SIGQUIT', forceKillAfterDelay: 9 }))
    expect(calls[0]!.options.killSignal).toBe('SIGQUIT')
    expect(calls[0]!.options.forceKillAfterDelay).toBe(9)
  })

  it('never forwards default or per-invocation timeouts to execa', async () => {
    const { execa, calls } = recordingExeca()
    const executor = execaExecutor({ execa, defaultTimeoutMs: 1234 })
    await executor.exec(invocation())
    await executor.exec(invocation({ timeoutMs: 567 }))
    expect(calls.every(({ options }) => !('timeout' in options))).toBe(true)
  })

  it.each([
    { name: 'timeoutMs: 0', timeoutMs: 0, defaultTimeoutMs: 100 },
    { name: 'defaultTimeoutMs: 0', timeoutMs: undefined, defaultTimeoutMs: 0 },
    { name: 'timeoutMs: Infinity', timeoutMs: Infinity, defaultTimeoutMs: 100 },
    {
      name: 'timeoutMs above timer limit',
      timeoutMs: 2_147_483_648,
      defaultTimeoutMs: 100,
    },
    {
      name: 'defaultTimeoutMs: Infinity',
      timeoutMs: undefined,
      defaultTimeoutMs: Infinity,
    },
    {
      name: 'defaultTimeoutMs above timer limit',
      timeoutMs: undefined,
      defaultTimeoutMs: 2_147_483_648,
    },
  ])(
    'arms no deadline for $name and waits for settlement',
    async ({ timeoutMs, defaultTimeoutMs }) => {
      vi.useFakeTimers()
      try {
        const groupKill = vi.spyOn(process, 'kill').mockReturnValue(true)
        const childKill = vi.fn(() => true)
        let settle!: (result: ExecaResultLike) => void
        const fn: ExecaLike = () =>
          Object.assign(
            new Promise<ExecaResultLike>((resolve) => {
              settle = resolve
            }),
            { pid: 4242, kill: childKill }
          ) as unknown as ReturnType<ExecaLike>
        const execa = Object.assign(fn, { exec: fn })
        const pending = execaExecutor({ execa, defaultTimeoutMs }).exec(
          invocation({ timeoutMs, forceKillAfterDelay: false })
        )
        let settled = false
        void pending.then(() => {
          settled = true
        })
        await vi.advanceTimersByTimeAsync(0)
        expect(vi.getTimerCount()).toBe(0)
        await vi.advanceTimersByTimeAsync(10_000)
        expect(groupKill).not.toHaveBeenCalled()
        expect(childKill).not.toHaveBeenCalled()
        expect(settled).toBe(false)
        expect(vi.getTimerCount()).toBe(0)
        settle({ exitCode: 0, failed: false })
        await expect(pending).resolves.toMatchObject({
          exitCode: 0,
          failed: false,
        })
        expect(settled).toBe(true)
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it.each([-1, -Infinity, Number.NaN])(
    'rejects invalid timeout %s before spawning',
    async (timeout) => {
      const { execa, calls } = recordingExeca()
      await expect(
        execaExecutor({ execa }).exec(invocation({ timeoutMs: timeout }))
      ).rejects.toThrow('Expected timeoutMs to be a non-negative number')
      await expect(
        execaExecutor({ execa, defaultTimeoutMs: timeout }).exec(invocation())
      ).rejects.toThrow(TypeError)
      expect(calls).toHaveLength(0)
    }
  )

  it.each([true, false])(
    'owns the timeout before settlement (detached: %s), using invocation or default deadline',
    async (detached) => {
      vi.useFakeTimers()
      try {
        const groupKill = vi.spyOn(process, 'kill').mockReturnValue(true)
        let settle!: (result: ExecaResultLike) => void
        const childKill = vi.fn(() => true)
        const fn: ExecaLike = () =>
          Object.assign(
            new Promise<ExecaResultLike>((resolve) => {
              settle = resolve
            }),
            { pid: 4242, kill: childKill }
          ) as unknown as ReturnType<ExecaLike>
        const execa = Object.assign(fn, { exec: fn })
        const pending = execaExecutor({
          execa,
          detached,
          defaultTimeoutMs: 200,
        }).exec(
          invocation({
            ...(detached ? { timeoutMs: 100 } : {}),
            killSignal: 'SIGINT',
            forceKillAfterDelay: false,
          })
        )
        let settled = false
        void pending.then(() => {
          settled = true
        })
        const timeout = detached ? 100 : 200
        await vi.advanceTimersByTimeAsync(timeout - 1)
        expect(groupKill).not.toHaveBeenCalled()
        expect(childKill).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(settled).toBe(false)
        if (detached) {
          expect(groupKill).toHaveBeenCalledExactlyOnceWith(-4242, 'SIGINT')
          expect(childKill).not.toHaveBeenCalled()
        } else {
          expect(childKill).toHaveBeenCalledExactlyOnceWith('SIGINT')
          expect(groupKill).not.toHaveBeenCalled()
        }
        settle({ failed: true, signal: 'SIGINT' })
        await expect(pending).resolves.toMatchObject({
          failed: true,
          signalCode: 'SIGINT',
        })
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it('falls back to per-process kill when the BYO ExecaLike exposes no pid', async () => {
    // Group kill needs the pid; a BYO implementation without one must degrade to execa's own
    // kill on the DIRECT child, never throw.
    const calls: Recorded[] = []
    let killArg: string | undefined
    const fn = ((cmd: string, args: readonly string[], options: ExecaParameters) => {
      calls.push({ cmd, args, options })
      const kill = vi.fn((signal?: string) => {
        killArg = signal
        return true
      })
      const promise = Promise.resolve({ exitCode: 0, failed: false })
      return Object.assign(promise, {
        kill,
        pid: undefined,
      }) as unknown as ReturnType<ExecaLike>
    }) as ExecaLike
    const execa: ExecaLike = Object.assign(fn, { exec: fn }) as ExecaLike
    const controller = new AbortController()
    const pending = execaExecutor({ execa }).exec(
      invocation({ signal: controller.signal, forceKillAfterDelay: false })
    )
    controller.abort()
    await pending
    expect(killArg).toBe('SIGTERM')
  })

  it('aborts via the process-group kill and escalates to SIGKILL after the delay', async () => {
    vi.useFakeTimers()
    try {
      const groupKills: Array<{ pid: number; signal: string }> = []
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
        pid: number,
        signal?: string
      ) => {
        groupKills.push({ pid: Math.abs(pid), signal: String(signal) })
        return true
      }) as never)
      let resolve!: (value: ExecaResultLike) => void
      const execa = ((cmd: string, args: readonly string[], options: ExecaParameters) => {
        void cmd
        void args
        void options
        const promise = new Promise<ExecaResultLike>((r) => {
          resolve = r
        })
        return Object.assign(promise, {
          pid: 4242,
          kill: () => true,
        }) as unknown as ReturnType<ExecaLike>
      }) as ExecaLike
      Object.assign(execa, { exec: execa })
      const calls = [1]
      const controller = new AbortController()
      const pending = execaExecutor({ execa }).exec(
        invocation({ signal: controller.signal, forceKillAfterDelay: 250 })
      )
      controller.abort()
      await vi.advanceTimersByTimeAsync(0)
      // First kill: the whole group with the invocation's signal.
      expect(groupKills[0]).toEqual({ pid: 4242, signal: 'SIGTERM' })
      expect(calls).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(250)
      // Then the escalation, on the SAME group.
      expect(groupKills.some((k) => k.signal === 'SIGKILL' && k.pid === 4242)).toBe(true)
      expect(killSpy).toHaveBeenCalled()
      resolve({
        stdout: '',
        stderr: '',
        failed: true,
        exitCode: undefined,
        signal: 'SIGTERM',
      })
      await pending
    } finally {
      vi.useRealTimers()
    }
  })

  describe('settlement escalation policies', () => {
    /**
     * An `ExecaLike` whose subprocess stays alive after settlement. Liveness answers and process
     * calls are recorded to prove cancellation prevents post-return probes and signals.
     */
    const pollableExeca = (): {
      execa: ExecaLike
      /** Every group/child process call, in order: the pid VERBATIM plus the signal. */
      processKills: Array<{ pid: number; signal: string }>
      /** Queue of group-liveness answers; one is consumed per probe (`signal` 0). */
      liveness: Array<boolean>
      spawned: Promise<void>
      settle: (partial?: Partial<ExecaResultLike>) => void
    } => {
      const processKills: Array<{ pid: number; signal: string }> = []
      const liveness: Array<boolean> = []
      let resolve!: (value: ExecaResultLike) => void
      let announce!: () => void
      const spawned = new Promise<void>((r) => {
        announce = r
      })
      // `signal 0` consumes a queued liveness answer; all signals are recorded.
      vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string) => {
        const name = String(signal)
        processKills.push({ pid, signal: name })
        if (name !== '0') return true
        const alive = liveness.length > 0 ? liveness.shift()! : true
        if (alive) return true
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
      }) as never)
      const execa = ((cmd: string, args: readonly string[], options: ExecaParameters) => {
        void cmd
        void args
        void options
        const promise = new Promise<ExecaResultLike>((r) => {
          resolve = r
        })
        const subprocess = {
          pid: 4242,
          kill: () => true,
        }
        announce()
        return Object.assign(promise, subprocess) as unknown as ReturnType<ExecaLike>
      }) as ExecaLike
      return {
        execa: Object.assign(execa, { exec: execa }) as ExecaLike,
        processKills,
        liveness,
        spawned,
        settle: (partial = { exitCode: 0, failed: false }) =>
          resolve({ stdout: '', stderr: '', failed: false, ...partial }),
      }
    }

    it.each(['abort', 'timeout'] as const)(
      'default wait holds settlement until SIGKILL after %s',
      async (trigger) => {
        vi.useFakeTimers()
        try {
          const { execa, processKills, spawned, settle } = pollableExeca()
          const controller = new AbortController()
          let returned = false
          const pending = execaExecutor({ execa }).exec(
            invocation({
              signal: controller.signal,
              timeoutMs: trigger === 'timeout' ? 10 : 0,
              forceKillAfterDelay: 300,
            })
          )
          void pending.then(() => {
            returned = true
          })
          await spawned
          if (trigger === 'abort') controller.abort()
          else await vi.advanceTimersByTimeAsync(10)
          settle({ failed: true, signal: 'SIGTERM' })
          await vi.advanceTimersByTimeAsync(0)
          expect(returned).toBe(false)
          await vi.advanceTimersByTimeAsync(299)
          expect(returned).toBe(false)
          await vi.advanceTimersByTimeAsync(1)
          await expect(pending).resolves.toMatchObject({
            failed: true,
            signalCode: 'SIGTERM',
          })
          expect(processKills.filter((k) => k.signal === 'SIGKILL')).toEqual([
            { pid: -4242, signal: 'SIGKILL' },
          ])
          expect(vi.getTimerCount()).toBe(0)
        } finally {
          vi.useRealTimers()
        }
      }
    )

    it('default wait resolves at the next empty probe without SIGKILL', async () => {
      vi.useFakeTimers()
      try {
        const { execa, processKills, liveness, spawned, settle } = pollableExeca()
        const controller = new AbortController()
        let returned = false
        const pending = execaExecutor({ execa }).exec(
          invocation({ signal: controller.signal, forceKillAfterDelay: 300 })
        )
        void pending.then(() => {
          returned = true
        })
        await spawned
        controller.abort()
        settle({ failed: true, signal: 'SIGTERM' })
        await vi.advanceTimersByTimeAsync(0)
        expect(returned).toBe(false)
        liveness.push(false)
        await vi.advanceTimersByTimeAsync(100)
        await pending
        expect(returned).toBe(true)
        expect(processKills.filter((k) => k.signal === 'SIGKILL')).toEqual([])
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })

    it.each(['wait', 'poll'] as const)(
      '%s cancels immediately for detached:false',
      async (settleEscalation) => {
        vi.useFakeTimers()
        try {
          const { execa, processKills, spawned, settle } = pollableExeca()
          const controller = new AbortController()
          const pending = execaExecutor({ execa, detached: false }).exec(
            invocation({
              signal: controller.signal,
              forceKillAfterDelay: 300,
              settleEscalation,
            })
          )
          await spawned
          controller.abort()
          settle({ failed: true })
          await pending
          expect(vi.getTimerCount()).toBe(0)
          expect(processKills).toEqual([])
        } finally {
          vi.useRealTimers()
        }
      }
    )

    it.each([false, true])('poll returns immediately and latches empty=%s', async (empty) => {
      vi.useFakeTimers()
      try {
        const { execa, processKills, liveness, spawned, settle } = pollableExeca()
        const controller = new AbortController()
        // Per-call poll must beat the executor-level wait default.
        const pending = execaExecutor({
          execa,
          defaultSettleEscalation: 'wait',
        }).exec(
          invocation({
            signal: controller.signal,
            forceKillAfterDelay: 300,
            settleEscalation: 'poll',
          })
        )
        await spawned
        controller.abort()
        settle({ failed: true })
        await pending
        expect(vi.getTimerCount()).toBe(2)
        if (empty) {
          liveness.push(false)
          await vi.advanceTimersByTimeAsync(100)
          expect(vi.getTimerCount()).toBe(0)
          liveness.push(true) // recycled group must never be probed or signalled
        }
        await vi.advanceTimersByTimeAsync(300)
        expect(processKills.filter((k) => k.signal === 'SIGKILL')).toHaveLength(empty ? 0 : 1)
        if (empty) expect(liveness).toEqual([true])
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })

    it.each([true, false])(
      'does not SIGKILL an alive target after settle when detached=%s',
      async (detached) => {
        vi.useFakeTimers()
        try {
          const { execa, processKills, liveness, spawned, settle } = pollableExeca()
          const controller = new AbortController()
          // The target is deliberately still alive at settlement. Cancel-on-return means no probe
          // or signal may run after settlement.
          liveness.push(true, true, true)
          const pending = execaExecutor({ execa, detached }).exec(
            invocation({
              signal: controller.signal,
              forceKillAfterDelay: 250,
              settleEscalation: 'cancel',
            })
          )
          await spawned
          controller.abort()
          settle({ exitCode: undefined, failed: true, signal: 'SIGTERM' })
          await pending
          expect(processKills).toEqual(detached ? [{ pid: -4242, signal: 'SIGTERM' }] : [])
          expect(vi.getTimerCount()).toBe(0)
          // Well past the deadline, no target is signalled or probed again.
          await vi.advanceTimersByTimeAsync(60_000)
          expect(processKills).toEqual(detached ? [{ pid: -4242, signal: 'SIGTERM' }] : [])
          expect(liveness).toHaveLength(3)
        } finally {
          vi.useRealTimers()
        }
      }
    )

    it('cancels group escalation on settle even when the target remains alive', async () => {
      vi.useFakeTimers()
      try {
        const { execa, processKills, liveness, spawned, settle } = pollableExeca()
        const controller = new AbortController()
        // Alive throughout: settlement, not liveness, cancels the pending escalation.
        liveness.push(true, true, true, true)
        const pending = execaExecutor({
          execa,
          defaultSettleEscalation: 'cancel',
        }).exec(invocation({ signal: controller.signal, forceKillAfterDelay: 250 }))
        await spawned
        // The deadline is fixed by the abort: settling at 200ms must NOT re-base it to 450ms.
        controller.abort()
        await vi.advanceTimersByTimeAsync(200)
        settle({ exitCode: undefined, failed: true, signal: 'SIGTERM' })
        await pending
        expect(processKills).toEqual([{ pid: -4242, signal: 'SIGTERM' }])
        expect(vi.getTimerCount()).toBe(0)
        await vi.advanceTimersByTimeAsync(60_000)
        expect(processKills).toEqual([{ pid: -4242, signal: 'SIGTERM' }])
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('detached: false — direct-child termination only, never a group signal', () => {
    /**
     * An `ExecaLike` whose subprocess stays alive until the test resolves it, so the escalation
     * timer can be observed while the child is genuinely still running. Records every `kill`.
     */
    const controllableExeca = (): {
      execa: ExecaLike
      kills: Array<string | undefined>
      /** Resolves once the executor has handed the invocation to execa (its listener is attached). */
      spawned: Promise<void>
      settle: (partial?: Partial<ExecaResultLike>) => void
    } => {
      const kills: Array<string | undefined> = []
      let resolve!: (value: ExecaResultLike) => void
      let announce!: () => void
      const spawned = new Promise<void>((r) => {
        announce = r
      })
      const execa = ((cmd: string, args: readonly string[], options: ExecaParameters) => {
        // Keep the recorded options reachable for the assertions below without a second spy.
        void cmd
        void args
        void options
        const promise = new Promise<ExecaResultLike>((r) => {
          resolve = r
        })
        const subprocess = {
          pid: 4242,
          kill: (signal?: string) => {
            kills.push(signal)
            return true
          },
        }
        announce()
        return Object.assign(promise, subprocess) as unknown as ReturnType<ExecaLike>
      }) as ExecaLike
      return {
        execa: Object.assign(execa, { exec: execa }) as ExecaLike,
        kills,
        spawned,
        settle: (partial = { exitCode: 0, failed: false }) =>
          resolve({ stdout: '', stderr: '', failed: false, ...partial }),
      }
    }

    it('signals ONLY the direct child via subprocess.kill on abort — never process.kill(-pid)', async () => {
      // `detached: false` means the child leads no group, so `-pid` names nothing. A negative-pid
      // signal here would be a semantic error even if it happened to fall back.
      const killSpy = vi.spyOn(process, 'kill')
      const { execa, kills, spawned, settle } = controllableExeca()
      const controller = new AbortController()
      const pending = execaExecutor({ execa, detached: false }).exec(
        invocation({ signal: controller.signal, forceKillAfterDelay: false })
      )
      await spawned
      controller.abort()
      expect(kills).toEqual(['SIGTERM'])
      expect(killSpy).not.toHaveBeenCalled()
      settle({ exitCode: undefined, failed: true, signal: 'SIGTERM' })
      await pending
      expect(killSpy).not.toHaveBeenCalled()
    })

    it('escalates SIGKILL to the still-alive DIRECT child, probing it with a positive pid', async () => {
      vi.useFakeTimers()
      try {
        const probed: Array<{ pid: number; signal: string }> = []
        vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string) => {
          probed.push({ pid, signal: String(signal) })
          return true
        }) as never)
        const { execa, kills, spawned, settle } = controllableExeca()
        const controller = new AbortController()
        const pending = execaExecutor({ execa, detached: false }).exec(
          invocation({ signal: controller.signal, forceKillAfterDelay: 250 })
        )
        await spawned
        controller.abort()
        expect(kills).toEqual(['SIGTERM'])
        await vi.advanceTimersByTimeAsync(250)
        // The escalation went to the SAME single child through its own handle — this is the kill
        // that a group probe would have skipped (the group is dead, the child is not).
        expect(kills).toEqual(['SIGTERM', 'SIGKILL'])
        // The only process-level call was the positive-pid liveness probe; no group signalling.
        expect(probed).toEqual([{ pid: 4242, signal: '0' }])
        settle({ exitCode: undefined, failed: true, signal: 'SIGKILL' })
        await pending
        expect(kills).toEqual(['SIGTERM', 'SIGKILL'])
      } finally {
        vi.useRealTimers()
      }
    })

    it('cancels the escalation timer on settle, so a recycled pid is never signalled', async () => {
      // After settlement the direct child is reaped: there is nothing left to escalate against.
      vi.useFakeTimers()
      try {
        const killed: number[] = []
        vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
          killed.push(pid)
          return true
        }) as never)
        const { execa, kills, spawned, settle } = controllableExeca()
        const controller = new AbortController()
        const pending = execaExecutor({ execa, detached: false }).exec(
          invocation({ signal: controller.signal, forceKillAfterDelay: 250 })
        )
        await spawned
        controller.abort()
        settle({ exitCode: undefined, failed: true, signal: 'SIGTERM' })
        await pending
        // `getTimerCount` distinguishes cancelled from merely guarded.
        expect(vi.getTimerCount()).toBe(0)
        await vi.advanceTimersByTimeAsync(999_999)
        expect(kills).toEqual(['SIGTERM'])
        expect(killed).toEqual([])
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('forceKillAfterDelay: false never schedules the SIGKILL escalation', async () => {
    vi.useFakeTimers()
    try {
      const signals: string[] = []
      vi.spyOn(process, 'kill').mockImplementation(((_pid: number, signal?: string) => {
        signals.push(String(signal))
        return true
      }) as never)
      const { execa } = recordingExeca(() => ({
        failed: true,
        signal: 'SIGTERM',
      }))
      const controller = new AbortController()
      const pending = execaExecutor({ execa }).exec(
        invocation({ signal: controller.signal, forceKillAfterDelay: false })
      )
      controller.abort()
      await vi.advanceTimersByTimeAsync(0)
      await pending
      // The first (graceful) signal still goes to the group; escalation never does.
      expect(signals).toContain('SIGTERM')
      expect(signals).not.toContain('SIGKILL')
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['wait', 'cancel', 'poll'] as const)(
    'normal exit in %s leaves no timer or probe',
    async (settleEscalation) => {
      // The deadline timer is per-call state: a successful run must clear it, or a short `timeoutMs`
      // on a long-finished call would later fire `terminate` into a possibly-recycled pid. With fake
      // timers, a surviving timer would fire during `advanceTimersByTimeAsync(timeout)` and hit the
      // recorded group kill; the spy proves it never does.
      vi.useFakeTimers()
      try {
        const groupKills: Array<{ pid: number; signal: string }> = []
        vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string) => {
          groupKills.push({ pid: Math.abs(pid), signal: String(signal) })
          return true
        }) as never)
        const { execa } = recordingExeca()
        const result = await execaExecutor({ execa }).exec(
          invocation({ timeoutMs: 500, settleEscalation })
        )
        expect(result.failed).toBe(false)
        // No deadline timer (and no escalation timer) may outlive the call: `getTimerCount` is the
        // assertion that actually distinguishes cleared from merely-guarded, since the `terminating`/
        // `settled` guards would mask a surviving timer's effects on `process.kill`.
        expect(vi.getTimerCount()).toBe(0)
        await vi.advanceTimersByTimeAsync(999_999)
        expect(groupKills).toEqual([])
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it('removes the abort listener when the process settles on its own', async () => {
    // A settled invocation must not fire a group kill into a reaped process group later. The
    // listener is removed on settle, so aborting the (still-referenced) controller must not
    // call `process.kill` again.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation((() => true) as never)
    const { execa } = recordingExeca()
    const controller = new AbortController()
    await execaExecutor({ execa }).exec(invocation({ signal: controller.signal }))
    controller.abort()
    expect(killSpy).not.toHaveBeenCalled()
  })

  it('aborts an already-aborted signal before waiting on the process', async () => {
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((
      pid: number,
      signal?: string
    ) => {
      expect(pid).toBe(-4242)
      expect(signal).toBe('SIGTERM')
      return true
    }) as never)
    const { execa } = recordingExeca(() => ({
      failed: true,
      signal: 'SIGTERM',
    }))
    const controller = new AbortController()
    controller.abort()
    await execaExecutor({ execa }).exec(
      invocation({ signal: controller.signal, forceKillAfterDelay: false })
    )
    expect(killSpy).toHaveBeenCalledTimes(1)
  })

  it('surfaces the terminating signal as signalCode on the settled result', async () => {
    const { execa } = recordingExeca(() => ({
      exitCode: undefined,
      failed: true,
      signal: 'SIGKILL',
    }))
    const result = await execaExecutor({ execa }).exec(invocation())
    expect(result.failed).toBe(true)
    expect(result.signalCode).toBe('SIGKILL')
  })

  it('omits signalCode on a normal exit', async () => {
    const { execa } = recordingExeca()
    const result = await execaExecutor({ execa }).exec(invocation())
    expect('signalCode' in result).toBe(false)
  })

  it('treats a non-zero exit as data, never a rejection', async () => {
    const { execa } = recordingExeca(() => ({ exitCode: 7, failed: true }))
    await expect(execaExecutor({ execa }).exec(invocation())).resolves.toMatchObject({
      exitCode: 7,
      failed: true,
    })
  })

  it('escapes nothing: stdout is forwarded verbatim from the fake', async () => {
    const { execa } = recordingExeca(() => ({ stdout: 'out', stderr: 'err' }))
    const result = await execaExecutor({ execa }).exec(invocation())
    expect(result.stdout).toBe('out')
    expect(result.stderr).toBe('err')
    expect(result.failed).toBe(false)
  })
})

describe('execaExecutor against the real optional peer', () => {
  it('honors cwd and the env allow-list (extendEnv:false)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adk-execa-'))
    try {
      const executor = execaExecutor()
      const withEnv = await executor.exec({
        cmd: 'sh',
        args: ['-c', 'echo $ADK_PROBE_VAR | tr -d "[:space:]"'],
        cwd: dir,
        env: { ADK_PROBE_VAR: 'hello' },
        extendEnv: false,
      })
      expect(withEnv.stdout).toBe('hello')
      // With the overlay only, nothing else from the host arrives — the allow-list is the whole env.
      const absent = await executor.exec({
        cmd: 'sh',
        args: ['-c', 'echo ${HOME-unset}'],
        cwd: dir,
        env: {},
        extendEnv: false,
      })
      expect(absent.stdout).toBe('unset')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
describe('execaExecutor process-group kill (REAL execa, real processes)', () => {
  /** Whether a pid exists (signal 0 probes without delivering). */
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  /** Poll until `pid` is gone, or the deadline passes. */
  const eventuallyGone = async (pid: number, ms = 5000): Promise<boolean> => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (!alive(pid)) return true
      await new Promise((r) => setTimeout(r, 25))
    }
    return false
  }

  it.each(['wait', 'cancel'] as const)(
    'real %s: handles a TERM-ignoring no-pipe grandchild at return',
    async (mode) => {
      const dir = await mkdtemp(join(tmpdir(), 'adk-settle-'))
      const pidFile = join(dir, 'pid')
      const controller = new AbortController()
      let pid: number | undefined
      let pending: ReturnType<ReturnType<typeof execaExecutor>['exec']> | undefined
      try {
        pending = execaExecutor().exec({
          cmd: 'sh',
          args: [
            '-c',
            `trap 'exit 0' TERM; sh -c 'trap "" TERM; echo $$ > "${pidFile}"; exec sleep 30' </dev/null >/dev/null 2>&1 & wait`,
          ],
          signal: controller.signal,
          forceKillAfterDelay: 300,
          ...(mode === 'cancel' ? { settleEscalation: 'cancel' as const } : {}),
        })
        const deadline = Date.now() + 3000
        while (Date.now() < deadline) {
          try {
            const raw = await readFile(pidFile, 'utf8')
            pid = Number(raw.trim())
            if (pid > 0) break
          } catch {
            /* not ready */
          }
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        expect(pid).toBeGreaterThan(0)
        controller.abort()
        await pending
        // SIGKILL delivery may precede OS reaping by a scheduler tick.
        if (mode === 'wait')
          expect(await eventuallyGone(pid!, 500), `grandchild ${pid} survived wait`).toBe(true)
        else expect(alive(pid!)).toBe(true)
      } finally {
        controller.abort()
        if (pid !== undefined && alive(pid)) {
          process.kill(pid, 'SIGKILL')
          await eventuallyGone(pid, 500)
        }
        await pending
        await rm(dir, { recursive: true, force: true })
      }
    }
  )

  it('leaves a no-pipe TERM-ignoring grandchild alive after return (cancel-on-return trade-off)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adk-timeout-groupkill-'))
    const pidFile = join(dir, 'pid')
    let grandchildPid: number | undefined
    try {
      const result = await execaExecutor({
        detached: true,
        defaultSettleEscalation: 'cancel',
      }).exec({
        cmd: 'sh',
        // No inherited pipes: the wrapper exits while the detached grandchild ignores TERM.
        args: ['-c', `sleep 60 </dev/null >/dev/null 2>&1 & echo $! > "${pidFile}"; exit 0`],
        forceKillAfterDelay: 100,
      })
      const pidContent = await readFile(pidFile, 'utf8')
      grandchildPid = Number(pidContent.trim())
      expect(Number.isInteger(grandchildPid) && grandchildPid > 0).toBe(true)
      expect(result.failed).toBe(false)
      // A descendant is not signalled after exec returns; clean it up explicitly below.
      expect(alive(grandchildPid)).toBe(true)
    } finally {
      if (grandchildPid !== undefined && alive(grandchildPid)) {
        process.kill(grandchildPid, 'SIGKILL')
        await eventuallyGone(grandchildPid)
      }
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('kills the spawned child AND its sleeping grandchild when the signal aborts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adk-groupkill-'))
    const pidFile = join(dir, 'pids')
    try {
      const executor = execaExecutor()
      const controller = new AbortController()
      // The wrapper shells out to a grandchild and waits. Killing only the direct child leaves the
      // `sleep` running, which is the exact leak group-kill exists to close. The shell records both
      // pids so the assertion names real processes rather than guessing at a tree walk.
      const pending = executor.exec({
        cmd: 'sh',
        args: ['-c', `sleep 60 & echo "$$ $!" > ${pidFile}; wait`],
        signal: controller.signal,
        forceKillAfterDelay: 500,
      })
      // Both levels must exist before the abort means anything.
      const deadline = Date.now() + 5000
      let pids: number[] = []
      while (Date.now() < deadline) {
        try {
          const text = await readFile(pidFile, 'utf8')
          pids = text.trim().split(/\s+/).map(Number).filter(Number.isInteger)
          if (pids.length === 2) break
        } catch {
          // Not written yet.
        }
        await new Promise((r) => setTimeout(r, 25))
      }
      expect(pids).toHaveLength(2)
      const childPid = pids[0]!
      const grandchildPid = pids[1]!
      expect(alive(childPid)).toBe(true)
      expect(alive(grandchildPid)).toBe(true)

      controller.abort()
      const result = await pending
      expect(result.failed).toBe(true)

      // Both levels are gone: the group kill reached the grandchild that a direct-child kill would
      // have left running.
      expect(await eventuallyGone(childPid), `child ${childPid} survived`).toBe(true)
      expect(await eventuallyGone(grandchildPid), `grandchild ${grandchildPid} survived`).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('execaExecutor direct-child kill (REAL execa, detached: false)', () => {
  /** Whether a pid exists (signal 0 probes without delivering). */
  const alive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  /** Poll until `pid` is gone, or the deadline passes. */
  const eventuallyGone = async (pid: number, ms = 5000): Promise<boolean> => {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (!alive(pid)) return true
      await new Promise((r) => setTimeout(r, 25))
    }
    return false
  }

  it('SIGKILLs a TERM-ignoring child via the escalation path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'adk-directkill-'))
    const pidFile = join(dir, 'pid')
    try {
      // No process group to lean on: the child is spawned `detached: false`, so the ONLY thing that
      // can end it is the direct-child escalation. `trap '' TERM` makes the first signal a no-op.
      const executor = execaExecutor({ detached: false })
      const controller = new AbortController()
      const started = Date.now()
      const pending = executor.exec({
        cmd: 'sh',
        args: ['-c', `trap '' TERM; echo $$ > ${pidFile}; exec sleep 30`],
        signal: controller.signal,
        forceKillAfterDelay: 200,
      })
      // The pid must exist (and the trap must be installed) before the abort means anything.
      const deadline = Date.now() + 5000
      let pid: number | undefined
      while (Date.now() < deadline) {
        try {
          const text = await readFile(pidFile, 'utf8')
          const parsed = Number(text.trim())
          if (Number.isInteger(parsed) && parsed > 0) {
            pid = parsed
            break
          }
        } catch {
          // Not written yet.
        }
        await new Promise((r) => setTimeout(r, 25))
      }
      expect(pid).toBeDefined()
      expect(alive(pid!)).toBe(true)

      controller.abort()
      const result = await pending
      // Escalation, not the graceful signal, is what killed it: SIGTERM was ignored.
      expect(result.failed).toBe(true)
      expect(result.signalCode).toBe('SIGKILL')
      expect(Date.now() - started).toBeLessThan(15_000)
      expect(await eventuallyGone(pid!), `child ${pid} survived`).toBe(true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('execaExecutor escalation clock (issue #37: monotonic deadline, early-fire re-arm)', () => {
  /**
   * A group-kill `ExecaLike` whose result promise is HELD, so the invocation can be driven
   * through clock tampering: `process.kill` is both the group signal and the liveness probe
   * (every `signal 0` reads ALIVE and is recorded), and the test decides when the subprocess
   * settles.
   */
  const clockableExeca = (): {
    execa: ExecaLike
    /** Every group call, in order: pid verbatim (negative = group probe/signal) plus signal. */
    processKills: Array<{ pid: number; signal: string }>
    /** Resolves once execa has been handed the invocation (the abort listener is attached). */
    spawned: Promise<void>
    settle: (partial?: Partial<ExecaResultLike>) => void
  } => {
    const processKills: Array<{ pid: number; signal: string }> = []
    let resolve!: (value: ExecaResultLike) => void
    let announce!: () => void
    const spawned = new Promise<void>((r) => {
      announce = r
    })
    vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string) => {
      processKills.push({ pid, signal: String(signal) })
      // Every probe reads ALIVE: the escalation is only ever stopped by the deadline or by the
      // test settling the invocation — never by an empty observation.
      return true
    }) as never)
    const execa = ((cmd: string, args: readonly string[], options: ExecaParameters) => {
      void cmd
      void args
      void options
      const promise = new Promise<ExecaResultLike>((r) => {
        resolve = r
      })
      const subprocess = { pid: 4242, kill: () => true }
      announce()
      return Object.assign(promise, subprocess) as unknown as ReturnType<ExecaLike>
    }) as ExecaLike
    return {
      execa: Object.assign(execa, { exec: execa }) as ExecaLike,
      processKills,
      spawned,
      settle: (partial = { exitCode: 0, failed: false }) =>
        resolve({ stdout: '', stderr: '', failed: false, ...partial }),
    }
  }

  /** Fake timers AND the clock, so `Date` can be pinned while the monotonic clock ticks with the timers. */
  const fakeClocks = (): void => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'],
    })
  }

  it('cancels group escalation at settle with the WALL CLOCK FROZEN far behind', async () => {
    fakeClocks()
    try {
      const { execa, processKills, spawned, settle } = clockableExeca()
      const controller = new AbortController()
      const pending = execaExecutor({
        execa,
        defaultSettleEscalation: 'cancel',
      }).exec(invocation({ signal: controller.signal, forceKillAfterDelay: 250 }))
      await spawned
      controller.abort()
      await vi.advanceTimersByTimeAsync(0)
      // Pin the wall clock 10s BEFORE it was when the escalation armed: a deadline computed as
      // `Date.now() + delay` now sits in the future forever (a backwards NTP step, the extreme
      // version of the 1ms-early fire). The monotonic clock keeps ticking with the timers.
      const frozen = Date.now() - 10_000
      vi.setSystemTime(frozen)
      expect(Date.now()).toBe(frozen)

      // In flight at 40ms: the graceful group signal only — the deadline is 250ms away.
      await vi.advanceTimersByTimeAsync(40)
      expect(processKills).toEqual([{ pid: -4242, signal: 'SIGTERM' }])

      // Settle with the group still alive: cancellation clears the deadline immediately.
      settle({ exitCode: undefined, failed: true, signal: 'SIGTERM' })
      await pending
      expect(processKills[0]).toEqual({ pid: -4242, signal: 'SIGTERM' })
      expect(processKills.filter((k) => k.signal === 'SIGKILL')).toEqual([])
      expect(processKills).toEqual([{ pid: -4242, signal: 'SIGTERM' }])
      expect(vi.getTimerCount()).toBe(0)

      await vi.advanceTimersByTimeAsync(60_000)
      expect(processKills).toEqual([{ pid: -4242, signal: 'SIGTERM' }])
      expect(vi.getTimerCount()).toBe(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('SIGKILLs the group at the monotonic deadline while the invocation is STILL IN FLIGHT with the wall clock frozen behind (the hang the poll never recovers)', async () => {
    fakeClocks()
    try {
      const { execa, processKills, spawned } = clockableExeca()
      const controller = new AbortController()
      void execaExecutor({ execa })
        .exec(invocation({ signal: controller.signal, forceKillAfterDelay: 100 }))
        // Never settles: the group ignores the first signal, which is exactly the case where the
        // deadline timer is the ONLY thing that can end it. Nothing re-arms or re-checks after a
        // bounce here, so a wall-clock deadline that cannot be re-passed dead-ends the SIGKILL.
        .then(() => {
          throw new Error('the invocation must not settle in this test')
        })
        .catch(() => undefined)
      await spawned
      controller.abort()
      await vi.advanceTimersByTimeAsync(0)
      vi.setSystemTime(Date.now() - 10_000)
      expect(processKills).toEqual([{ pid: -4242, signal: 'SIGTERM' }])
      // 1ms short of the deadline: the timer must not have signalled the group.
      await vi.advanceTimersByTimeAsync(99)
      expect(processKills.filter((k) => k.signal === 'SIGKILL')).toEqual([])
      // Due: probe the group, then the one SIGKILL — still in flight, wall clock still behind.
      await vi.advanceTimersByTimeAsync(1)
      expect(processKills).toEqual([
        { pid: -4242, signal: 'SIGTERM' },
        { pid: -4242, signal: '0' },
        { pid: -4242, signal: 'SIGKILL' },
      ])
      // Fired: the escalation holds nothing any more — only the per-call timeout timer remains,
      // and its late fire is a no-op (the invocation is already terminating).
      expect(vi.getTimerCount()).toBe(1)
      await vi.advanceTimersByTimeAsync(200_000)
      expect(processKills.filter((k) => k.signal === 'SIGKILL')).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('RE-ARMS the deadline timer when it fires 1ms EARLY (monotonic clock still 1ms short) instead of dropping out, then fires the ONE SIGKILL once due', async () => {
    fakeClocks()
    try {
      const monotonic = performance.now.bind(performance)
      const reads: number[] = []
      let short = false
      // The monotonic clock is a test-controlled variable: `monotonic()` advances with the fake
      // timers, and `short` makes it read exactly 1ms behind the timer schedule.
      vi.spyOn(performance, 'now').mockImplementation(() => {
        const value = monotonic() - (short ? 1 : 0)
        reads.push(value)
        return value
      })
      const { execa, processKills, spawned, settle } = clockableExeca()
      const controller = new AbortController()
      const pending = execaExecutor({ execa }).exec(
        invocation({ signal: controller.signal, forceKillAfterDelay: 50 })
      )
      await spawned
      controller.abort()
      await vi.advanceTimersByTimeAsync(0)
      // Wall clock pinned behind its own deadline too, so nothing here can be satisfied by Date.
      vi.setSystemTime(Date.now() - 10_000)
      expect(processKills).toEqual([{ pid: -4242, signal: 'SIGTERM' }])
      // `arm()` read the monotonic clock exactly once, so its deadline is that read + 50ms.
      const armedAt = reads[0]!
      expect(reads).toHaveLength(1)

      // The 1ms-early fire: the deadline timer fires at its scheduled instant while the
      // monotonic clock still reads 1ms short of the deadline.
      short = true
      await vi.advanceTimersByTimeAsync(50)
      // The group was probed exactly once (the check ran), with no SIGKILL yet.
      expect(processKills).toEqual([
        { pid: -4242, signal: 'SIGTERM' },
        { pid: -4242, signal: '0' },
      ])
      // THE DISCRIMINATOR: the deadline timer was RE-ARMED, not dropped out. The fired timer
      // left the fake heap and a replacement took its place, so the count is the per-call
      // timeout timer PLUS the re-armed deadline timer. Dropping out leaves only the timeout
      // timer — 1 — and then nothing would ever check the deadline again.
      expect(vi.getTimerCount()).toBe(2)
      // The early-fire read really was 1ms short of the deadline (`arm()` + 50ms).
      expect(reads[reads.length - 1]).toBe(armedAt + 49)

      // Once the deadline is actually reached the re-armed timer fires: exactly one SIGKILL.
      short = false
      await vi.advanceTimersByTimeAsync(1)
      expect(processKills).toEqual([
        { pid: -4242, signal: 'SIGTERM' },
        { pid: -4242, signal: '0' },
        { pid: -4242, signal: '0' },
        { pid: -4242, signal: 'SIGKILL' },
      ])
      // Fired: the deadline timer is cleared; only the in-flight timeout timer remains.
      expect(vi.getTimerCount()).toBe(1)

      // Settling afterwards changes nothing: one SIGKILL in total, no timers left behind.
      settle({ exitCode: undefined, failed: true, signal: 'SIGKILL' })
      await pending
      expect(vi.getTimerCount()).toBe(0)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(processKills.filter((k) => k.signal === 'SIGKILL')).toHaveLength(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
