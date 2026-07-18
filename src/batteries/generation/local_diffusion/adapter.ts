/** Node-only local diffusion generation adapter.
 * @module @nhtio/adk/batteries/generation/local_diffusion/adapter
 */
import { toBytes } from '../_shared'
import { isError } from '@nhtio/adk/guards'
import { validateOptions } from './validation'
import { emitLifecycle } from '../../llm/chat_common/lifecycle'
import { decodeBase64, encodeBase64 } from '../../../lib/helpers/base64'
import {
  DEFAULT_PROTOCOL,
  buildEditCommand,
  buildGenerateCommand,
  buildShutdownCommand,
  buildStopCommand,
  createFrameReader,
} from './protocol'
import {
  E_LOCAL_DIFFUSION_ABORTED,
  E_LOCAL_DIFFUSION_BACKEND_ERROR,
  E_LOCAL_DIFFUSION_BUSY,
  E_LOCAL_DIFFUSION_DISPOSED,
  E_LOCAL_DIFFUSION_MALFORMED_FRAME,
  E_LOCAL_DIFFUSION_REQUEST_TIMEOUT,
  E_LOCAL_DIFFUSION_STARTUP_TIMEOUT,
} from './exceptions'
import type { GenerationImageInput } from '../_shared'
import type { GeneratedMediaOutput } from '../openai/types'
import type { ParsedFrame, ProtocolConfig } from './protocol'
import type {
  DiffusionBackendProcess,
  DiffusionFsLike,
  LocalDiffusionCallOptions,
  LocalDiffusionGenerationAdapterOptions,
} from './types'

const BATTERY = 'local_diffusion_generation' as const
const DEFAULT_MAX_DECODED_BYTES = 50 * 1024 * 1024

type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void }

/** How a request ended, so {@link LocalDiffusionGenerationAdapter} settles it exactly once. */
type Outcome = { kind: 'success' } | { kind: 'error'; error: unknown } | { kind: 'aborted' }

/** The rejection error for a non-success outcome (an aborted outcome maps to the typed abort error). */
const outcomeError = (outcome: Exclude<Outcome, { kind: 'success' }>): unknown =>
  outcome.kind === 'aborted' ? new E_LOCAL_DIFFUSION_ABORTED() : outcome.error

/** Mutable state for the single in-flight request. */
type RequestState = {
  /** The monotonic request id fenced against backend frames. */
  rid: number
  /** The caller-facing settlement. */
  done: Deferred<GeneratedMediaOutput[]>
  /** Accumulated image outputs. */
  outputs: GeneratedMediaOutput[]
  /** Count of in-flight image reads not yet settled. */
  pending: number
  /** The recorded terminal outcome, set once; the request settles when `pending` reaches 0. */
  outcome: Outcome | undefined
  /** Whether the caller's promise has been settled (may precede full termination on abort/timeout). */
  settled: boolean
  /** Whether full terminal settlement (slot release + one lifecycle event) has already run. */
  terminated: boolean
  /** The abort/timeout grace timer holding the slot in `stopping`, if any. */
  stopTimer: ReturnType<typeof setTimeout> | undefined
  /** The request-timeout timer, if any. */
  requestTimer: ReturnType<typeof setTimeout> | undefined
  /** Detaches the caller's abort listener, if any. */
  detachSignal: (() => void) | undefined
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * Whether `candidate` resolves to a location strictly inside `dir` — real containment (resolves `..`
 * and rejects sibling-prefix escapes like `/output2`), not a raw string `startsWith`.
 */
const isContained = (dir: string, candidate: string, sep: string): boolean => {
  const base = dir.endsWith(sep) ? dir.slice(0, -sep.length) : dir
  return candidate === base || candidate.startsWith(base + sep)
}

/** Local diffusion adapter backed by a line-protocol subprocess. */
export class LocalDiffusionGenerationAdapter {
  readonly #options: LocalDiffusionGenerationAdapterOptions
  #process: DiffusionBackendProcess | undefined
  #epoch = 0
  #state: 'idle' | 'starting' | 'ready' | 'running' | 'stopping' | 'disposed' = 'idle'
  #loadPromise: Promise<void> | undefined
  #loadReject: ((error: unknown) => void) | undefined
  #request: RequestState | undefined
  #rid = 0
  #disposePromise: Promise<void> | undefined
  #listeners: Array<{
    target: { off(event: string, listener: (...args: any[]) => void): void }
    event: string
    fn: (...args: any[]) => void
  }> = []

  /** Whether the current host exposes Node's process runtime. */
  public static isAvailable(): boolean {
    return typeof process !== 'undefined' && Boolean(process.versions?.node)
  }

  /** Construct and validate an adapter. */
  constructor(options: unknown) {
    this.#options = validateOptions(options)
  }

  /** Whether this instance can run, honoring its injected probe. */
  public isAvailable(): boolean {
    return (this.#options.isAvailable ?? LocalDiffusionGenerationAdapter.isAvailable)()
  }

  /** Start the backend and wait for its ready event. */
  public async preload(): Promise<void> {
    this.#assertLive()
    if (this.#state === 'ready' || this.#state === 'running' || this.#state === 'stopping') return
    if (this.#loadPromise) return this.#loadPromise
    const loadPromise = this.#start()
    this.#loadPromise = loadPromise
    loadPromise
      .catch(() => undefined)
      .finally(() => {
        // Only clear if this exact load is still the current one (a reset/dispose may have replaced it).
        if (this.#loadPromise === loadPromise) {
          this.#loadPromise = undefined
          this.#loadReject = undefined
        }
      })
    return loadPromise
  }

  /** Synchronously terminate the current process and invalidate all continuations. */
  public reset(): void {
    if (this.#state === 'disposed') return
    this.#retire(new E_LOCAL_DIFFUSION_BACKEND_ERROR(['adapter reset']))
    this.#state = 'idle'
  }

  /** Gracefully stop the backend, then force terminate it. Terminal and idempotent. */
  public dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise
    this.#disposePromise = this.#dispose()
    return this.#disposePromise
  }

  async #dispose(): Promise<void> {
    const process = this.#process
    // Move to the terminal state SYNCHRONOUSLY so any concurrent call sees `disposed` (not `ready`)
    // and every in-flight continuation is fenced by the epoch bump inside #retire. Defer the kill:
    // the two-phase teardown sends `__shutdown__`, waits `disposeGraceMs`, then force-kills once below.
    this.#retire(new E_LOCAL_DIFFUSION_DISPOSED(), false)
    this.#state = 'disposed'
    if (process && process.stdin) {
      try {
        process.stdin.write(buildShutdownCommand(this.#protocol()))
      } catch {
        /* teardown — the process may already be gone */
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.#options.disposeGraceMs ?? 5000)
        const finish = (): void => {
          clearTimeout(timer)
          process.off('close', finish)
          resolve()
        }
        process.on('close', finish)
      })
    }
    process?.kill()
  }

  /** Async-disposal protocol alias. */
  public async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose()
  }

  /** Generate images from text. */
  public async generate(
    prompt: string,
    opts?: LocalDiffusionCallOptions
  ): Promise<GeneratedMediaOutput[]> {
    return this.#call('generate', prompt, undefined, opts)
  }

  /** Edit images with text guidance. */
  public async edit(
    inputs: GenerationImageInput | GenerationImageInput[],
    prompt: string,
    opts?: LocalDiffusionCallOptions
  ): Promise<GeneratedMediaOutput[]> {
    const normalized = await Promise.all((Array.isArray(inputs) ? inputs : [inputs]).map(toBytes))
    return this.#call('edit', prompt, normalized, opts)
  }

  #assertLive(): void {
    if (this.#state === 'disposed' || this.#disposePromise) throw new E_LOCAL_DIFFUSION_DISPOSED()
  }

  #protocol(): ProtocolConfig {
    const o = this.#options
    return {
      ...DEFAULT_PROTOCOL,
      ...(o.protocol ?? {}),
      commandPrefix: o.commandPrefix ?? o.protocol?.commandPrefix ?? DEFAULT_PROTOCOL.commandPrefix,
      eventPrefix: o.eventPrefix ?? o.protocol?.eventPrefix ?? DEFAULT_PROTOCOL.eventPrefix,
      ops: { ...DEFAULT_PROTOCOL.ops, ...o.protocol?.ops, ...o.ops },
      control: { ...DEFAULT_PROTOCOL.control, ...o.protocol?.control, ...o.control },
      events: { ...DEFAULT_PROTOCOL.events, ...o.protocol?.events, ...o.events },
    }
  }

  /**
   * Tear down the current process + request atomically: bump the epoch (fencing every outstanding
   * continuation), detach listeners, reject an in-flight preload, record the request's terminal
   * outcome (which settles once its pending reads drain), and drop cached handles. Kills the child
   * unless `kill` is false — `dispose()` defers the kill until after its graceful-shutdown wait.
   * Leaves `#state` for the caller to set (`idle` for reset, `disposed` for dispose).
   */
  #retire(error: unknown, kill = true): void {
    this.#epoch += 1
    this.#detach()
    this.#loadReject?.(error)
    this.#loadReject = undefined
    this.#loadPromise = undefined
    const request = this.#request
    if (request) this.#settle(request, { kind: 'error', error })
    if (kill) this.#process?.kill()
    this.#process = undefined
  }

  async #start(): Promise<void> {
    this.#assertLive()
    if (!this.isAvailable())
      throw new E_LOCAL_DIFFUSION_BACKEND_ERROR(['Node process is unavailable'])
    const epoch = ++this.#epoch
    const startupTimeoutMs = this.#options.startupTimeoutMs ?? 30_000
    this.#state = 'starting'
    const spawner =
      this.#options.spawn ??
      (async (ctx): Promise<DiffusionBackendProcess> => {
        const { spawn } = await import('node:child_process')
        const child = spawn(ctx.command, ctx.args, {
          stdio: ['pipe', 'pipe', 'pipe'],
        }) as unknown as DiffusionBackendProcess
        if (!child.stdin || !child.stdout)
          throw new E_LOCAL_DIFFUSION_BACKEND_ERROR(['backend stdin/stdout unavailable'])
        return child
      })
    let process: DiffusionBackendProcess
    try {
      process = await spawner({
        command: this.#options.command,
        args: this.#options.args ?? [],
        model: this.#options.model,
      })
    } catch (error) {
      throw new E_LOCAL_DIFFUSION_BACKEND_ERROR([isError(error) ? error.message : String(error)])
    }
    if (epoch !== this.#epoch || (this.#state as string) === 'disposed') {
      process.kill()
      throw new E_LOCAL_DIFFUSION_BACKEND_ERROR(['startup superseded'])
    }
    if (!process.stdin || !process.stdout)
      throw new E_LOCAL_DIFFUSION_BACKEND_ERROR(['backend stdin/stdout unavailable'])
    this.#process = process
    const wait = deferred<void>()
    this.#loadReject = wait.reject
    const reader = createFrameReader({
      maxLineBytes: this.#options.maxLineBytes,
      config: this.#protocol(),
      onFrame: (frame) => this.#onFrame(frame, epoch, wait),
    })
    const onData = (chunk: Uint8Array): void => {
      if (epoch === this.#epoch) reader.push(chunk)
    }
    const onStreamEnd = (): void => {
      if (epoch !== this.#epoch) return
      // Flush any trailing partial line, THEN treat the closed stdout as a terminal transport failure:
      // a backend that closes its stdout can produce no further frames, so a startup or in-flight
      // request would otherwise hang forever (permanent BUSY). failure() retires + settles it.
      reader.end()
      failure('backend stdout closed', null, null)
    }
    const failure = (detail: string, code: number | null, signal: NodeJS.Signals | null): void => {
      if (epoch !== this.#epoch) return
      const error =
        this.#state === 'starting'
          ? new E_LOCAL_DIFFUSION_STARTUP_TIMEOUT([startupTimeoutMs])
          : new E_LOCAL_DIFFUSION_BACKEND_ERROR([detail, code ?? undefined, signal ?? undefined])
      // Fully retire the process so no stale `#request`/`#process`/`ready` survives. Detach + kill the
      // child (a startup-timeout child may still be alive) and bump the epoch so any late frame from
      // it — including `ready` — is fenced out.
      wait.reject(error)
      this.#detach()
      this.#loadReject = undefined
      this.#loadPromise = undefined
      const request = this.#request
      if (request) this.#settle(request, { kind: 'error', error })
      this.#process?.kill()
      this.#process = undefined
      this.#epoch += 1
      this.#state = 'idle'
    }
    const onError = (): void => failure('backend error', null, null)
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
      failure('backend exited', code, signal)
    const onStdoutError = (): void => failure('backend stdout error', null, null)
    process.stdout.on('data', onData)
    process.stdout.on('end', onStreamEnd)
    process.stdout.on('error', onStdoutError)
    process.on('error', onError)
    process.on('exit', onExit)
    process.on('close', onExit)
    this.#listeners.push(
      { target: process.stdout, event: 'data', fn: onData },
      { target: process.stdout, event: 'end', fn: onStreamEnd },
      { target: process.stdout, event: 'error', fn: onStdoutError },
      { target: process, event: 'error', fn: onError },
      { target: process, event: 'exit', fn: onExit },
      { target: process, event: 'close', fn: onExit }
    )
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Route the timeout through failure() so the still-running child is killed + detached + fenced
        // (state → idle, epoch bumped) — a late `ready` from the timed-out child cannot revive it.
        failure('startup timed out', null, null)
      }, startupTimeoutMs)
      wait.promise.then(
        () => {
          clearTimeout(timer)
          resolve()
        },
        (error) => {
          clearTimeout(timer)
          reject(error)
        }
      )
    })
    if (epoch !== this.#epoch) throw new E_LOCAL_DIFFUSION_BACKEND_ERROR(['startup superseded'])
  }

  #onFrame(frame: ParsedFrame, epoch: number, load: Deferred<void>): void {
    if (epoch !== this.#epoch) return
    if (frame.kind === 'modelLoad') {
      emitLifecycle(this.#options, BATTERY, this.#options.model, 'loading', {
        progress: frame.progress,
      })
      return
    }
    if (frame.kind === 'ready') {
      // Only a pending startup transitions to ready; a duplicate/unsolicited `ready` during
      // running/stopping must not reopen the slot or overwrite the active request.
      if (this.#state !== 'starting') return
      this.#state = 'ready'
      emitLifecycle(this.#options, BATTERY, this.#options.model, 'ready')
      load.resolve(undefined)
      return
    }
    const request = this.#request
    if (frame.kind === 'malformed' || frame.kind === 'protocolError') {
      // Record the terminal outcome but hold the slot until pending image reads drain (like `done`).
      if (request) {
        if (!request.outcome)
          request.outcome = {
            kind: 'error',
            error: new E_LOCAL_DIFFUSION_MALFORMED_FRAME([frame.detail]),
          }
        this.#maybeSettle(request)
      }
      return
    }
    // Every remaining frame kind carries a rid; fence it against the current request.
    if (!request || !('rid' in frame) || frame.rid !== request.rid) return
    if (frame.kind === 'progress') {
      emitLifecycle(this.#options, BATTERY, this.#options.model, 'generating', {
        progress: frame.progress,
      })
      return
    }
    if (frame.kind === 'image') {
      request.pending += 1
      void this.#readImage(frame.payload)
        .then((output) => {
          if (this.#request === request) request.outputs.push(output)
        })
        .catch((error) => {
          // Fence against a retired/superseded request: only the current request records an outcome.
          if (this.#request === request && !request.outcome)
            request.outcome = { kind: 'error', error }
        })
        .finally(() => {
          request.pending -= 1
          this.#maybeSettle(request)
        })
      return
    }
    if (frame.kind === 'error') {
      if (!request.outcome)
        request.outcome = {
          kind: 'error',
          error: new E_LOCAL_DIFFUSION_BACKEND_ERROR([frame.message]),
        }
      this.#maybeSettle(request)
      return
    }
    if (frame.kind === 'done') {
      if (!request.outcome) request.outcome = { kind: 'success' }
      this.#maybeSettle(request)
    }
  }

  /** Settle `request` once its recorded terminal outcome is set AND all image reads have drained. */
  #maybeSettle(request: RequestState): void {
    if (request.outcome && request.pending === 0) this.#settle(request, request.outcome)
  }

  async #readImage(payload: {
    path?: string
    b64?: string
    mimeType: string
  }): Promise<GeneratedMediaOutput> {
    const maxDecoded = this.#options.maxDecodedBytes ?? DEFAULT_MAX_DECODED_BYTES
    let bytes: Uint8Array
    let filename: string | undefined
    if (payload.b64 !== undefined) {
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload.b64))
        throw new E_LOCAL_DIFFUSION_MALFORMED_FRAME(['invalid base64'])
      // Bound memory BEFORE allocating: decoded length ≈ 3/4 of the base64 char count.
      const approxDecoded = Math.floor((payload.b64.length * 3) / 4)
      if (approxDecoded > maxDecoded)
        throw new E_LOCAL_DIFFUSION_MALFORMED_FRAME(['inline image exceeds maxDecodedBytes'])
      bytes = decodeBase64(payload.b64)
    } else if (payload.path !== undefined) {
      const requestPath = payload.path
      const fs = this.#options.fs ?? (await this.#defaultFs())
      try {
        bytes = await fs.readFile(requestPath)
      } finally {
        await this.#cleanupPath(fs, requestPath)
      }
      filename = requestPath.split(/[\\/]/).pop()
    } else throw new E_LOCAL_DIFFUSION_MALFORMED_FRAME(['image has no data'])
    if (
      bytes.length === 0 ||
      bytes.length > maxDecoded ||
      !/^image\/(png|jpeg|jpg|webp|gif|avif)$/i.test(payload.mimeType)
    )
      throw new E_LOCAL_DIFFUSION_MALFORMED_FRAME(['invalid image output'])
    return { kind: 'image', mimeType: payload.mimeType, bytes, ...(filename ? { filename } : {}) }
  }

  /**
   * Delete a backend-written result file ONLY when its LEXICALLY-resolved path is strictly inside
   * `outputDir` (resolves `..`, rejects sibling-prefix escapes). Containment is lexical, not
   * realpath-based: a symlink placed inside `outputDir` that points elsewhere is NOT followed-and-checked
   * — this cleanup trusts that the consumer's own `outputDir` does not contain adversarial symlinks.
   * Cleanup failure is diagnostic-only and never fails the generation.
   */
  async #cleanupPath(fs: DiffusionFsLike, filePath: string): Promise<void> {
    const outputDir = this.#options.outputDir
    if (!outputDir) return
    try {
      const path = await import('node:path')
      const resolvedDir = path.resolve(outputDir)
      const resolvedPath = path.resolve(filePath)
      if (!isContained(resolvedDir, resolvedPath, path.sep)) return
      await fs.unlink(filePath)
    } catch {
      /* diagnostic-only cleanup — a failed unlink never fails the generation */
    }
  }

  async #defaultFs(): Promise<DiffusionFsLike> {
    const fs = await import('node:fs/promises')
    return {
      readFile: (path) => fs.readFile(path),
      unlink: (path) => fs.unlink(path).then(() => undefined),
    }
  }

  async #call(
    kind: 'generate' | 'edit',
    prompt: string,
    inputs?: Array<{ bytes: Uint8Array; mimeType?: string }>,
    opts?: LocalDiffusionCallOptions
  ): Promise<GeneratedMediaOutput[]> {
    this.#assertLive()
    if (this.#state === 'running' || this.#state === 'stopping') throw new E_LOCAL_DIFFUSION_BUSY()
    await this.preload()
    this.#assertLive()
    if (this.#state !== 'ready') throw new E_LOCAL_DIFFUSION_BUSY()
    const o = this.#options
    const rid = this.#rid++
    const request: RequestState = {
      rid,
      done: deferred<GeneratedMediaOutput[]>(),
      outputs: [],
      pending: 0,
      outcome: undefined,
      settled: false,
      terminated: false,
      stopTimer: undefined,
      requestTimer: undefined,
      detachSignal: undefined,
    }
    this.#request = request
    this.#state = 'running'
    emitLifecycle(o, BATTERY, o.model, 'generating')
    const args: Record<string, unknown> = {
      prompt,
      ...(kind === 'edit'
        ? {
            images: (inputs ?? []).map((input) => ({
              b64: encodeBase64(input.bytes),
              ...(input.mimeType ? { mimeType: input.mimeType } : {}),
            })),
          }
        : {}),
      ...Object.fromEntries(
        Object.entries({
          negativePrompt: opts?.negativePrompt ?? o.negativePrompt,
          steps: opts?.steps ?? o.steps,
          cfgScale: opts?.cfgScale ?? o.cfgScale,
          sampler: opts?.sampler ?? o.sampler,
          seed: opts?.seed ?? o.seed,
          width: opts?.width ?? o.width,
          height: opts?.height ?? o.height,
        }).filter(([, value]) => value !== undefined)
      ),
    }
    try {
      this.#process?.stdin?.write(
        kind === 'edit'
          ? buildEditCommand(rid, args, this.#protocol())
          : buildGenerateCommand(rid, args, this.#protocol())
      )
    } catch (error) {
      this.#settle(request, {
        kind: 'error',
        error: new E_LOCAL_DIFFUSION_BACKEND_ERROR([
          isError(error) ? error.message : String(error),
        ]),
      })
      return request.done.promise
    }
    if (opts?.signal) {
      const signal = opts.signal
      const abort = (): void => this.#beginStop(request, { kind: 'aborted' })
      if (signal.aborted) abort()
      else {
        signal.addEventListener('abort', abort, { once: true })
        request.detachSignal = () => signal.removeEventListener('abort', abort)
      }
    }
    if (o.requestTimeoutMs)
      request.requestTimer = setTimeout(
        () =>
          this.#beginStop(request, {
            kind: 'error',
            error: new E_LOCAL_DIFFUSION_REQUEST_TIMEOUT([o.requestTimeoutMs as number]),
          }),
        o.requestTimeoutMs
      )
    return request.done.promise
  }

  /**
   * Begin a best-effort stop of `request` (abort or request-timeout): reject the caller now with the
   * terminal `outcome`, but HOLD the single-flight slot in `stopping` (writing advisory `__stop__`)
   * until the cancelled rid's terminal frame arrives OR `abortGraceMs` elapses → kill + respawn.
   */
  #beginStop(request: RequestState, outcome: Exclude<Outcome, { kind: 'success' }>): void {
    if (this.#request !== request || this.#state !== 'running') return
    this.#state = 'stopping'
    try {
      this.#process?.stdin?.write(buildStopCommand(request.rid, this.#protocol()))
    } catch {
      /* advisory — the backend may ignore or never receive __stop__ */
    }
    // Record the terminal outcome + reject the caller immediately, but keep the slot held: the request
    // is not cleared until its reads drain (settle) or the grace timer fires.
    if (!request.outcome) request.outcome = outcome
    if (!request.settled) request.done.reject(outcomeError(outcome))
    request.settled = true
    request.detachSignal?.()
    request.detachSignal = undefined
    if (request.requestTimer) clearTimeout(request.requestTimer)
    request.requestTimer = undefined
    request.stopTimer = setTimeout(() => {
      if (this.#request === request) this.reset()
    }, this.#options.abortGraceMs ?? 5000)
  }

  /**
   * Fully settle `request` exactly once: clear its timers, release the single-flight slot (only if it
   * is still the current request), settle the caller's promise if not already done, and emit exactly
   * ONE terminal lifecycle event. Idempotent — a second call (e.g. a drained pending read after an
   * earlier retirement) is a no-op, so no duplicate lifecycle/promise settlement can occur.
   */
  #settle(request: RequestState, outcome: Outcome): void {
    if (request.terminated) return
    request.terminated = true
    if (request.stopTimer) clearTimeout(request.stopTimer)
    request.stopTimer = undefined
    if (request.requestTimer) clearTimeout(request.requestTimer)
    request.requestTimer = undefined
    request.detachSignal?.()
    request.detachSignal = undefined
    if (this.#request === request) {
      this.#request = undefined
      if (this.#state === 'running' || this.#state === 'stopping') this.#state = 'ready'
    }
    if (!request.settled) {
      request.settled = true
      if (outcome.kind === 'success') request.done.resolve(request.outputs)
      else request.done.reject(outcomeError(outcome))
    }
    // The lifecycle event mirrors the true outcome, never a spurious `complete` after a failure/abort.
    if (outcome.kind === 'success')
      emitLifecycle(this.#options, BATTERY, this.#options.model, 'complete')
    else
      emitLifecycle(this.#options, BATTERY, this.#options.model, 'error', {
        error: outcomeError(outcome),
      })
  }

  #detach(): void {
    for (const listener of this.#listeners) listener.target.off(listener.event, listener.fn)
    this.#listeners = []
  }
}
