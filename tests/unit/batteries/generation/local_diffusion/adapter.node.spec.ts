import { describe, expect, it } from 'vitest'
import { LocalDiffusionGenerationAdapter } from '../../../../../src/batteries/generation/local_diffusion/adapter'
import {
  E_LOCAL_DIFFUSION_ABORTED,
  E_LOCAL_DIFFUSION_BACKEND_ERROR,
  E_LOCAL_DIFFUSION_BUSY,
  E_LOCAL_DIFFUSION_DISPOSED,
  E_LOCAL_DIFFUSION_MALFORMED_FRAME,
  E_LOCAL_DIFFUSION_REQUEST_TIMEOUT,
  E_LOCAL_DIFFUSION_STARTUP_TIMEOUT,
} from '../../../../../src/batteries/generation/local_diffusion/exceptions'
import type {
  DiffusionBackendProcess,
  DiffusionFsLike,
  LocalDiffusionCallOptions,
} from '../../../../../src/batteries/generation/local_diffusion/types'

type Listener = (...args: unknown[]) => void

const addListener = (target: Map<string, Listener[]>, event: string, listener: Listener): void => {
  target.set(event, [...(target.get(event) ?? []), listener])
}
const removeListener = (
  target: Map<string, Listener[]>,
  event: string,
  listener: Listener
): void => {
  target.set(
    event,
    (target.get(event) ?? []).filter((candidate) => candidate !== listener)
  )
}

/**
 * A hermetic {@link DiffusionBackendProcess} double: records stdin writes + kills, replays canned
 * stdout frames, and fires process events on demand. Cast to the process duck at the spawn seam.
 */
class FakeBackend {
  readonly writes: string[] = []
  readonly kills: Array<NodeJS.Signals | number | undefined> = []
  readonly #stdoutListeners = new Map<string, Listener[]>()
  readonly #processListeners = new Map<string, Listener[]>()
  readonly stdin = {
    write: (value: string): void => {
      this.writes.push(value)
    },
  }
  readonly stdout = {
    on: (event: string, listener: Listener): void =>
      addListener(this.#stdoutListeners, event, listener),
    off: (event: string, listener: Listener): void =>
      removeListener(this.#stdoutListeners, event, listener),
  }

  on(event: string, listener: Listener): void {
    addListener(this.#processListeners, event, listener)
  }

  off(event: string, listener: Listener): void {
    removeListener(this.#processListeners, event, listener)
  }

  kill(signal?: NodeJS.Signals | number): void {
    this.kills.push(signal)
  }

  emit(line: string): void {
    for (const listener of this.#stdoutListeners.get('data') ?? [])
      listener(new TextEncoder().encode(`${line}\n`))
  }

  emitProcess(
    event: 'error' | 'exit' | 'close',
    code: number | null = null,
    signal: NodeJS.Signals | null = null
  ): void {
    for (const listener of this.#processListeners.get(event) ?? [])
      event === 'error' ? listener(new Error('child failed')) : listener(code, signal)
  }

  emitStdout(event: 'end' | 'error'): void {
    for (const listener of this.#stdoutListeners.get(event) ?? [])
      event === 'error' ? listener(new Error('stdout failed')) : listener()
  }

  /** The process duck the adapter's spawn seam expects. */
  asProcess(): DiffusionBackendProcess {
    return this as unknown as DiffusionBackendProcess
  }
}

const imageBytes = new Uint8Array([1, 2, 3])
const imageB64 = Buffer.from(imageBytes).toString('base64')

const makeAdapter = (
  fake: FakeBackend,
  extra: Record<string, unknown> = {}
): LocalDiffusionGenerationAdapter =>
  new LocalDiffusionGenerationAdapter({
    model: 'test-model',
    command: 'fake-diffusion',
    spawn: () => fake.asProcess(),
    ...extra,
  })

const start = async (
  adapter: LocalDiffusionGenerationAdapter,
  fake: FakeBackend
): Promise<void> => {
  const loading = adapter.preload()
  await nextTurn()
  fake.emit('sdbk rdy')
  await loading
}

const nextTurn = async (): Promise<void> => {
  await Promise.resolve()
  await Promise.resolve()
}

const generateWithInlineImage = async (
  adapter: LocalDiffusionGenerationAdapter,
  fake: FakeBackend,
  prompt = 'cat',
  options?: LocalDiffusionCallOptions
): Promise<Awaited<ReturnType<LocalDiffusionGenerationAdapter['generate']>>> => {
  const result = adapter.generate(prompt, options)
  await nextTurn()
  fake.emit('sdbk nwim 0 ' + JSON.stringify({ b64: imageB64, mimeType: 'image/png' }))
  fake.emit('sdbk done 0')
  return result
}

describe('local diffusion generation adapter', () => {
  it('preloads on ready and a request joins startup', async () => {
    const fake = new FakeBackend()
    const adapter = makeAdapter(fake)
    const preload = adapter.preload()
    const request = adapter.generate('cat')
    await nextTurn()
    fake.emit('sdbk rdy')
    await preload
    await nextTurn()
    expect(fake.writes[0]).toBe('b2py t2im 0 {"prompt":"cat"}\n')
    fake.emit('sdbk done 0')
    await expect(request).resolves.toEqual([])
  })

  it('times out startup and reports an early exit as startup timeout', async () => {
    const first = new FakeBackend()
    const timed = makeAdapter(first, { startupTimeoutMs: 20 })
    await expect(timed.preload()).rejects.toBeInstanceOf(E_LOCAL_DIFFUSION_STARTUP_TIMEOUT)

    const second = new FakeBackend()
    const exited = makeAdapter(second, { startupTimeoutMs: 100 })
    const loading = exited.preload()
    second.emitProcess('exit', 7, 'SIGTERM')
    await expect(loading).rejects.toBeInstanceOf(E_LOCAL_DIFFUSION_STARTUP_TIMEOUT)
  })

  it('writes generation knobs, reports progress, and returns inline image bytes', async () => {
    const fake = new FakeBackend()
    const progress: number[] = []
    const adapter = makeAdapter(fake, {
      negativePrompt: 'default',
      onGenerating: (report: { progress?: number }) => {
        if (report.progress !== undefined) progress.push(report.progress)
      },
    })
    await start(adapter, fake)
    const result = adapter.generate('cat', {
      negativePrompt: 'bad',
      steps: 12,
      cfgScale: 6.5,
      sampler: 'euler',
      seed: 4,
      width: 64,
      height: 48,
    })
    await nextTurn()
    expect(fake.writes[0]).toContain('b2py t2im 0 ')
    expect(JSON.parse(fake.writes[0].slice('b2py t2im 0 '.length))).toEqual({
      prompt: 'cat',
      negativePrompt: 'bad',
      steps: 12,
      cfgScale: 6.5,
      sampler: 'euler',
      seed: 4,
      width: 64,
      height: 48,
    })
    fake.emit('sdbk dnpr 0 0.5')
    fake.emit(`sdbk nwim 0 ${JSON.stringify({ b64: imageB64, mimeType: 'image/png' })}`)
    fake.emit('sdbk done 0')
    await expect(result).resolves.toEqual([
      { kind: 'image', mimeType: 'image/png', bytes: imageBytes },
    ])
    expect(progress).toContain(0.5)
  })

  it('reads and conditionally cleans path images', async () => {
    const reads: string[] = []
    const unlinks: string[] = []
    const fs: DiffusionFsLike = {
      readFile: async (path) => {
        reads.push(path)
        return imageBytes
      },
      unlink: async (path) => {
        unlinks.push(path)
      },
    }
    const fake = new FakeBackend()
    const adapter = makeAdapter(fake, { fs, outputDir: '/output' })
    await start(adapter, fake)
    const inside = adapter.generate('inside')
    await nextTurn()
    fake.emit('sdbk nwim 0 {"path":"/output/x.png","mimeType":"image/png"}')
    fake.emit('sdbk done 0')
    await expect(inside).resolves.toEqual([
      { kind: 'image', mimeType: 'image/png', bytes: imageBytes, filename: 'x.png' },
    ])
    expect(reads).toEqual(['/output/x.png'])
    expect(unlinks).toEqual(['/output/x.png'])

    const outside = adapter.generate('outside')
    await nextTurn()
    fake.emit('sdbk nwim 1 {"path":"/other/x.png","mimeType":"image/png"}')
    fake.emit('sdbk done 1')
    await outside
    expect(reads).toContain('/other/x.png')
    expect(unlinks).not.toContain('/other/x.png')
  })

  it('rejects malformed images and backend errors with exact exception classes', async () => {
    const fake = new FakeBackend()
    const adapter = makeAdapter(fake)
    await start(adapter, fake)
    const malformed = adapter.generate('bad')
    await nextTurn()
    fake.emit('sdbk nwim 0 {"b64":"not-base64!","mimeType":"image/png"}')
    await expect(malformed).rejects.toBeInstanceOf(E_LOCAL_DIFFUSION_MALFORMED_FRAME)

    const backend = adapter.generate('error')
    await nextTurn()
    fake.emit('sdbk err 1 {"message":"boom"}')
    await expect(backend).rejects.toBeInstanceOf(E_LOCAL_DIFFUSION_BACKEND_ERROR)
  })

  it('writes edit commands with input images as canonical base64', async () => {
    const fake = new FakeBackend()
    const adapter = makeAdapter(fake)
    await start(adapter, fake)
    const result = adapter.edit({ bytes: imageBytes, mimeType: 'image/png' }, 'edit me')
    await nextTurn()
    // Input bytes must be sent as decodable base64 (not a JSON-stringified Uint8Array index object).
    expect(fake.writes[0]).toBe(
      `b2py im2im 0 ${JSON.stringify({
        prompt: 'edit me',
        images: [{ b64: imageB64, mimeType: 'image/png' }],
      })}\n`
    )
    fake.emit('sdbk done 0')
    await expect(result).resolves.toEqual([])
  })

  it('fences late frames and rejects concurrent calls as busy', async () => {
    const fake = new FakeBackend()
    const adapter = makeAdapter(fake)
    await start(adapter, fake)
    const first = generateWithInlineImage(adapter, fake)
    await expect(adapter.generate('second')).rejects.toBeInstanceOf(E_LOCAL_DIFFUSION_BUSY)
    await first
    fake.emit(`sdbk dnpr 0 0.9`)
    fake.emit(`sdbk nwim 0 ${JSON.stringify({ b64: imageB64, mimeType: 'image/png' })}`)
    fake.emit('sdbk done 0')
    const second = adapter.generate('second')
    await nextTurn()
    expect(fake.writes[1]).toContain('b2py t2im 1 ')
    fake.emit('sdbk done 1')
    await expect(second).resolves.toEqual([])
  })

  it('stops and rejects an already or later aborted request', async () => {
    const fake = new FakeBackend()
    const adapter = makeAdapter(fake, { abortGraceMs: 1000 })
    await start(adapter, fake)
    const controller = new AbortController()
    controller.abort()
    await expect(adapter.generate('already', { signal: controller.signal })).rejects.toBeInstanceOf(
      E_LOCAL_DIFFUSION_ABORTED
    )
    expect(fake.writes).toContain('b2py __stop__ 0\n')

    adapter.reset()
    await start(adapter, fake)
    const later = new AbortController()
    const request = adapter.generate('later', { signal: later.signal })
    await nextTurn()
    later.abort()
    await expect(request).rejects.toBeInstanceOf(E_LOCAL_DIFFUSION_ABORTED)
    expect(fake.writes).toContain('b2py __stop__ 0\n')
  })

  it('reset rejects work, kills, and permits a fresh spawn', async () => {
    const fakes = [new FakeBackend(), new FakeBackend()]
    let spawned = 0
    const adapter = new LocalDiffusionGenerationAdapter({
      model: 'm',
      command: 'x',
      spawn: () => fakes[spawned++].asProcess(),
      startupTimeoutMs: 100,
    })
    const loading = adapter.preload()
    adapter.reset()
    await expect(loading).rejects.toBeInstanceOf(E_LOCAL_DIFFUSION_BACKEND_ERROR)
    expect(fakes[0].kills).toHaveLength(1)
    const fresh = adapter.preload()
    await nextTurn()
    fakes[1].emit('sdbk rdy')
    await expect(fresh).resolves.toBeUndefined()
    const request = adapter.generate('x')
    await nextTurn()
    adapter.reset()
    await expect(request).rejects.toBeInstanceOf(E_LOCAL_DIFFUSION_BACKEND_ERROR)
  })

  it('disposes in-flight work, shuts down idempotently, and rejects later calls', async () => {
    const fake = new FakeBackend()
    const adapter = makeAdapter(fake, { disposeGraceMs: 1 })
    const loading = adapter.preload()
    await nextTurn()
    const disposal = adapter.dispose()
    await expect(loading).rejects.toBeInstanceOf(E_LOCAL_DIFFUSION_DISPOSED)
    fake.emitProcess('close')
    await disposal
    expect(fake.writes).toContain('b2py __shutdown__\n')
    expect(fake.kills).toHaveLength(1)
    await adapter.dispose()
    await expect(adapter.generate('after')).rejects.toBeInstanceOf(E_LOCAL_DIFFUSION_DISPOSED)
  })

  it('rejects a request when the child errors or exits mid-request', async () => {
    const errorFake = new FakeBackend()
    const errorAdapter = makeAdapter(errorFake)
    await start(errorAdapter, errorFake)
    const errored = errorAdapter.generate('error')
    await nextTurn()
    errorFake.emitProcess('error')
    await expect(errored).rejects.toBeInstanceOf(E_LOCAL_DIFFUSION_BACKEND_ERROR)

    const exitFake = new FakeBackend()
    const exitAdapter = makeAdapter(exitFake)
    await start(exitAdapter, exitFake)
    const exited = exitAdapter.generate('exit')
    await nextTurn()
    exitFake.emitProcess('exit', 12, 'SIGKILL')
    await expect(exited).rejects.toMatchObject({ code: 'E_LOCAL_DIFFUSION_BACKEND_ERROR' })
  })

  it('reports availability and lifecycle ordering, without completion after backend error', async () => {
    expect(LocalDiffusionGenerationAdapter.isAvailable()).toBe(true)
    const fake = new FakeBackend()
    const phases: string[] = []
    const progress: Array<{ battery: string; progress?: number }> = []
    const adapter = makeAdapter(fake, {
      onLifecycle: (report: { phase: string; battery: string; progress?: number }) => {
        phases.push(report.phase)
        progress.push({ battery: report.battery, progress: report.progress })
      },
      isAvailable: () => false,
    })
    expect(adapter.isAvailable()).toBe(false)
    const unavailable = adapter.preload()
    await expect(unavailable).rejects.toBeInstanceOf(E_LOCAL_DIFFUSION_BACKEND_ERROR)

    const live = makeAdapter(fake, {
      onLifecycle: (report: { phase: string }) => phases.push(report.phase),
    })
    const preload = live.preload()
    await nextTurn()
    fake.emit('sdbk mdld 0.2')
    fake.emit('sdbk rdy')
    await preload
    const request = live.generate('cat')
    await nextTurn()
    fake.emit('sdbk dnpr 0 0.4')
    fake.emit('sdbk done 0')
    await request
    expect(phases).toEqual(['loading', 'ready', 'generating', 'generating', 'complete'])

    const failed = live.generate('bad')
    await nextTurn()
    fake.emit('sdbk err 1 {"message":"nope"}')
    await expect(failed).rejects.toBeInstanceOf(E_LOCAL_DIFFUSION_BACKEND_ERROR)
    expect(phases.slice(-2)).toEqual(['generating', 'error'])
    expect(phases.slice(-2)).not.toContain('complete')
  })

  it('never unlinks a path that escapes outputDir by prefix or traversal', async () => {
    const unlinks: string[] = []
    const fs: DiffusionFsLike = {
      readFile: async () => imageBytes,
      unlink: async (path) => {
        unlinks.push(path)
      },
    }
    const fake = new FakeBackend()
    const adapter = makeAdapter(fake, { fs, outputDir: '/output' })
    await start(adapter, fake)
    // Sibling-prefix escape: '/output-evil' must NOT be treated as inside '/output'.
    const evil = adapter.generate('evil')
    await nextTurn()
    fake.emit('sdbk nwim 0 {"path":"/output-evil/valuable.png","mimeType":"image/png"}')
    fake.emit('sdbk done 0')
    await evil
    // Traversal escape: '/output/../etc/x.png' resolves outside '/output'.
    const traverse = adapter.generate('traverse')
    await nextTurn()
    fake.emit('sdbk nwim 1 {"path":"/output/../etc/x.png","mimeType":"image/png"}')
    fake.emit('sdbk done 1')
    await traverse
    expect(unlinks).toEqual([])
  })

  it('rejects an oversized inline image before decoding it', async () => {
    const fake = new FakeBackend()
    const adapter = makeAdapter(fake, { maxDecodedBytes: 4 })
    await start(adapter, fake)
    const big = adapter.generate('big')
    await nextTurn()
    // 12 base64 chars ≈ 9 decoded bytes, over the 4-byte cap → rejected pre-decode.
    fake.emit(`sdbk nwim 0 {"b64":"${'A'.repeat(12)}","mimeType":"image/png"}`)
    await expect(big).rejects.toBeInstanceOf(E_LOCAL_DIFFUSION_MALFORMED_FRAME)
  })

  it('holds the slot until a pending path-image read settles after done', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fs: DiffusionFsLike = {
      readFile: async () => {
        await gate
        return imageBytes
      },
      unlink: async () => undefined,
    }
    const fake = new FakeBackend()
    const adapter = makeAdapter(fake, { fs, outputDir: '/output' })
    await start(adapter, fake)
    const result = adapter.generate('slow')
    await nextTurn()
    fake.emit('sdbk nwim 0 {"path":"/output/slow.png","mimeType":"image/png"}')
    fake.emit('sdbk done 0')
    await nextTurn()
    // `done` arrived but the read is still pending → the slot is held, a second call is BUSY.
    await expect(adapter.generate('early')).rejects.toBeInstanceOf(E_LOCAL_DIFFUSION_BUSY)
    release()
    await expect(result).resolves.toHaveLength(1)
    // Once the read settled the slot frees, so a fresh call is admitted.
    const next = adapter.generate('after')
    await nextTurn()
    fake.emit('sdbk done 1')
    await expect(next).resolves.toEqual([])
  })

  it('holds the slot after a request-timeout until the timed-out rid settles', async () => {
    const fake = new FakeBackend()
    const adapter = makeAdapter(fake, { requestTimeoutMs: 10, abortGraceMs: 50 })
    await start(adapter, fake)
    const timedOut = adapter.generate('slow')
    await expect(timedOut).rejects.toBeInstanceOf(E_LOCAL_DIFFUSION_REQUEST_TIMEOUT)
    // Caller rejected, but the slot is held in `stopping` (advisory __stop__ written) → next is BUSY.
    expect(fake.writes.some((line) => line.startsWith('b2py __stop__ 0'))).toBe(true)
    await expect(adapter.generate('early')).rejects.toBeInstanceOf(E_LOCAL_DIFFUSION_BUSY)
    // The timed-out rid's terminal frame frees the slot.
    fake.emit('sdbk done 0')
    await nextTurn()
    const next = adapter.generate('after')
    await nextTurn()
    fake.emit('sdbk done 1')
    await expect(next).resolves.toEqual([])
  })

  it('a fresh preload after reset during a pending spawn spawns a new process', async () => {
    const fakes = [new FakeBackend(), new FakeBackend()]
    let spawned = 0
    let resolveSpawn!: (proc: DiffusionBackendProcess) => void
    const adapter = new LocalDiffusionGenerationAdapter({
      model: 'm',
      command: 'x',
      startupTimeoutMs: 1000,
      // First spawn hangs until we resolve it; second resolves immediately.
      spawn: () =>
        spawned++ === 0
          ? new Promise<DiffusionBackendProcess>((resolve) => {
              resolveSpawn = resolve
            })
          : fakes[1].asProcess(),
    })
    const first = adapter.preload()
    await nextTurn()
    adapter.reset() // reset while the first spawn is still pending
    const fresh = adapter.preload() // must NOT join the stale (superseded) load
    await nextTurn()
    resolveSpawn(fakes[0].asProcess()) // the superseded first spawn now resolves — must be killed, not adopted
    fakes[1].emit('sdbk rdy')
    await expect(fresh).resolves.toBeUndefined()
    await expect(first).rejects.toBeInstanceOf(E_LOCAL_DIFFUSION_BACKEND_ERROR)
    expect(spawned).toBe(2)
    expect(fakes[0].kills.length).toBeGreaterThanOrEqual(1)
  })

  it('rejects generate/edit issued during the disposeGraceMs shutdown wait', async () => {
    const fake = new FakeBackend()
    const adapter = makeAdapter(fake, { disposeGraceMs: 50 })
    await start(adapter, fake)
    const disposal = adapter.dispose()
    // State is synchronously `disposed`, so a call during the grace wait is rejected, not admitted.
    await expect(adapter.generate('during')).rejects.toBeInstanceOf(E_LOCAL_DIFFUSION_DISPOSED)
    await expect(adapter.edit(new Uint8Array([1]), 'during')).rejects.toBeInstanceOf(
      E_LOCAL_DIFFUSION_DISPOSED
    )
    fake.emitProcess('close')
    await disposal
  })

  it('ignores a duplicate ready frame while a request is running', async () => {
    const fake = new FakeBackend()
    const adapter = makeAdapter(fake)
    await start(adapter, fake)
    const request = adapter.generate('cat')
    await nextTurn()
    // An unsolicited/duplicate `ready` must NOT reopen the slot or overwrite the active request.
    fake.emit('sdbk rdy')
    await expect(adapter.generate('second')).rejects.toBeInstanceOf(E_LOCAL_DIFFUSION_BUSY)
    fake.emit('sdbk done 0')
    await expect(request).resolves.toEqual([])
  })

  it('emits exactly one terminal lifecycle event when a read drains after reset', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const fs: DiffusionFsLike = {
      readFile: async () => {
        await gate
        return imageBytes
      },
      unlink: async () => undefined,
    }
    const terminal: string[] = []
    const fake = new FakeBackend()
    const adapter = makeAdapter(fake, {
      fs,
      outputDir: '/output',
      onLifecycle: (report: { phase: string }) => {
        if (report.phase === 'complete' || report.phase === 'error') terminal.push(report.phase)
      },
    })
    await start(adapter, fake)
    const request = adapter.generate('slow')
    await nextTurn()
    fake.emit('sdbk nwim 0 {"path":"/output/slow.png","mimeType":"image/png"}')
    fake.emit('sdbk done 0') // success outcome recorded, but the read is still gated (pending)
    await nextTurn()
    adapter.reset() // retire while the read is pending → one terminal 'error'
    await expect(request).rejects.toBeInstanceOf(E_LOCAL_DIFFUSION_BACKEND_ERROR)
    release() // the drained read must NOT emit a second (spurious 'complete') terminal event
    await nextTurn()
    await nextTurn()
    expect(terminal).toEqual(['error'])
  })

  it('fails an in-flight request when stdout closes cleanly while the child stays alive', async () => {
    const fake = new FakeBackend()
    const adapter = makeAdapter(fake)
    await start(adapter, fake)
    const request = adapter.generate('cat')
    await nextTurn()
    // A clean stdout `end` (no process exit/close) must still terminate the hung request — a backend
    // that closes its stdout can emit no further frames, so the slot must be freed, not held forever.
    fake.emitStdout('end')
    await expect(request).rejects.toBeInstanceOf(E_LOCAL_DIFFUSION_BACKEND_ERROR)
    // The slot is freed: a fresh preload + generate is admitted after re-spawn.
    await start(adapter, fake)
    const next = adapter.generate('again')
    await nextTurn()
    fake.emit('sdbk done 1')
    await expect(next).resolves.toEqual([])
  })

  it('rejects an in-flight request on a stdout error', async () => {
    const fake = new FakeBackend()
    const adapter = makeAdapter(fake)
    await start(adapter, fake)
    const request = adapter.generate('cat')
    await nextTurn()
    fake.emitStdout('error')
    await expect(request).rejects.toBeInstanceOf(E_LOCAL_DIFFUSION_BACKEND_ERROR)
  })

  it('fails an in-flight request on a process close', async () => {
    const fake = new FakeBackend()
    const adapter = makeAdapter(fake)
    await start(adapter, fake)
    const request = adapter.generate('cat')
    await nextTurn()
    fake.emitProcess('close', 0, null)
    await expect(request).rejects.toBeInstanceOf(E_LOCAL_DIFFUSION_BACKEND_ERROR)
  })

  it('kills the child and ignores a late ready after a startup timeout', async () => {
    const fake = new FakeBackend()
    const adapter = makeAdapter(fake, { startupTimeoutMs: 20 })
    await expect(adapter.preload()).rejects.toBeInstanceOf(E_LOCAL_DIFFUSION_STARTUP_TIMEOUT)
    // The timed-out child was killed and its listeners detached.
    expect(fake.kills.length).toBeGreaterThanOrEqual(1)
    // A late `ready` from the killed child is epoch-stale AND state-gated → it must not revive readiness.
    fake.emit('sdbk rdy')
    // A fresh preload spawns anew and can still succeed.
    const second = new FakeBackend()
    const adapter2 = makeAdapter(second)
    await start(adapter2, second)
    const request = adapter2.generate('ok')
    await nextTurn()
    second.emit('sdbk done 0')
    await expect(request).resolves.toEqual([])
  })
})
