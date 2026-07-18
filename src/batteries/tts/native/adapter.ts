/**
 * OS-native TTS (text-to-speech) adapter battery — shells out to the platform's own speech binary.
 *
 * @module @nhtio/adk/batteries/tts/native/adapter
 *
 * @remarks
 * **Node-only.** This adapter synthesizes by shelling out to the operating system's own speech
 * binary — macOS `say`, Linux `espeak-ng`, or Windows PowerShell `System.Speech` — and reading back
 * the WAV file it writes. It is model-less: it extends the shared {@link BaseTtsAdapterOptions}
 * (`voice`/`rate`) but adds NO `model` field. Every `node:*` import is a LAZY dynamic import inside a
 * method, so constructing and validating the adapter never touches node builtins and unit tests stay
 * hermetic (zero `child_process`, zero `fs`, zero real files).
 *
 * The shell-out and filesystem access are fully injectable: {@link NativeTtsAdapterOptions.executor}
 * (default: a lazy `node:child_process` `execFile` wrapper with an `AbortController` enforcing the
 * timeout), {@link NativeTtsAdapterOptions.fs} (default: `node:fs/promises`), plus
 * {@link NativeTtsAdapterOptions.tmpdir} / {@link NativeTtsAdapterOptions.randomName} seams for the
 * scratch output path. The flow mirrors the media domain's `soffice` engine — build args, exec,
 * read the output file, finally clean up — but this engine controls its own output path directly
 * (it does NOT depend on the media domain's `ScratchWorkspace`).
 *
 * Result classification is from the executor's FLAGS, never inferred from exit code or stderr (a
 * timeout, a signal kill, and a non-zero CLI exit are indistinguishable from those signals alone):
 * `result.timedOut` → `E_NATIVE_TTS_TIMEOUT` (504); else `result.failed` →
 * `E_NATIVE_TTS_ENGINE_ERROR` (502). The read-back WAV is hard-validated against the RIFF/WAVE
 * magic — a payload missing that magic throws `E_NATIVE_TTS_ENGINE_ERROR`.
 */

import { validateOptions } from './validation'
import { buildNativeTtsInvocation } from './helpers'
import { isError, isObject } from '@nhtio/adk/guards'
import {
  E_NATIVE_TTS_ENGINE_ERROR,
  E_NATIVE_TTS_TIMEOUT,
  E_NATIVE_TTS_UNSUPPORTED_PLATFORM,
} from './exceptions'
import type { GeneratedMediaOutput } from '../_shared'
import type {
  NativeTtsAdapterOptions,
  NativeSynthesizeOptions,
  TtsBinaryExecutor,
  TtsBinaryExecutorResult,
  TtsFsLike,
  NativeTtsPlatform,
} from './types'

/** The set of platforms this adapter can synthesize on. */
const SUPPORTED_PLATFORMS: ReadonlySet<NativeTtsPlatform> = new Set(['darwin', 'linux', 'win32'])

/** Clamp `n` into the inclusive `[min, max]` band. */
const clamp = (n: number, min: number, max: number): number => Math.min(Math.max(n, min), max)

/** Round to the nearest integer (half-up). */
const round = (n: number): number => Math.round(n)

/**
 * TTS adapter that shells out to the OS's own speech binary. Reusable: construct once, call
 * {@link NativeTtsAdapter.synthesize} as many times as needed.
 *
 * @remarks
 * A zero-config `new NativeTtsAdapter()` is valid — it auto-detects the platform from
 * `process.platform` at `synthesize` time and resolves the default executor / fs / scratch-path
 * seams lazily.
 */
export class NativeTtsAdapter {
  readonly #options: NativeTtsAdapterOptions

  /**
   * Whether this battery is available. `true` whenever a Node `process` is present on a supported
   * {@link NativeTtsPlatform} — the engine itself is the platform's own binary, so there is no peer
   * dependency to probe.
   */
  public static isAvailable(): boolean {
    return (
      typeof process !== 'undefined' &&
      typeof process.platform === 'string' &&
      SUPPORTED_PLATFORMS.has(process.platform as NativeTtsPlatform)
    )
  }

  /**
   * @param options - Constructor options. **All optional**; validated eagerly against
   *   {@link @nhtio/adk/batteries/tts/native!nativeTtsOptionsSchema}. Pass `undefined` for zero-config.
   * @throws {@link @nhtio/adk/batteries/tts/native!E_INVALID_NATIVE_TTS_OPTIONS} when invalid.
   */
  constructor(options: unknown = {}) {
    this.#options = validateOptions(options ?? {})
  }

  /** Instance availability probe (honours an injected `isAvailable`). */
  isAvailable(): boolean {
    return (this.#options.isAvailable ?? NativeTtsAdapter.isAvailable)()
  }

  /** No-op. The native engine has nothing to preload — the binary is invoked fresh per call. */
  async preload(): Promise<void> {
    // intentionally empty: no cached model/session to warm.
  }

  /** No-op. The native engine holds no state between calls to reset. */
  reset(): void {
    // intentionally empty: no cached state to drop.
  }

  /**
   * Resolve the default binary executor lazily: a `node:child_process` `execFile` wrapper that runs
   * the invocation WITHOUT a shell (no interpolation) and aborts the child via an `AbortController`
   * when `timeoutMs` elapses, setting `timedOut: true` on the result.
   */
  async #getDefaultExecutor(): Promise<TtsBinaryExecutor> {
    const { execFile } = await import('node:child_process')
    return {
      exec(invocation): Promise<TtsBinaryExecutorResult> {
        return new Promise((resolve) => {
          const controller = new AbortController()
          const timeoutMs = invocation.timeoutMs
          let timer: ReturnType<typeof setTimeout> | undefined
          if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
            timer = setTimeout(() => controller.abort(), timeoutMs)
          }
          const stdoutChunks: Buffer[] = []
          const stderrChunks: Buffer[] = []
          let settled = false
          const finish = (result: TtsBinaryExecutorResult): void => {
            if (settled) return
            settled = true
            if (timer) clearTimeout(timer)
            resolve(result)
          }
          const child = execFile(
            invocation.cmd,
            invocation.args,
            { signal: controller.signal, maxBuffer: 1024 * 1024 * 64, windowsHide: true },
            (err, stdout, stderr) => {
              const timedOut = Boolean(controller.signal.aborted)
              const failed = timedOut || err !== null
              finish({
                exitCode:
                  isObject(err) && 'status' in err
                    ? (err as { status?: number }).status
                    : undefined,
                stdout: typeof stdout === 'string' ? stdout : String(stdout ?? ''),
                stderr: typeof stderr === 'string' ? stderr : String(stderr ?? ''),
                failed,
                timedOut,
              })
            }
          )
          child.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c))
          child.stderr?.on('data', (c: Buffer) => stderrChunks.push(c))
          if (invocation.signal) {
            if (invocation.signal.aborted) controller.abort()
            else
              invocation.signal.addEventListener('abort', () => controller.abort(), {
                once: true,
              })
          }
        })
      },
    }
  }

  /** Resolve the default filesystem seam lazily: `node:fs/promises`. */
  async #getDefaultFs(): Promise<TtsFsLike> {
    const fs = await import('node:fs/promises')
    return {
      readFile: (path: string) => fs.readFile(path),
      unlink: (path: string) => fs.unlink(path),
    }
  }

  /** Resolve the default scratch directory lazily: `node:os` `tmpdir()`. */
  async #getDefaultTmpdir(): Promise<() => string> {
    const os = await import('node:os')
    return () => os.tmpdir()
  }

  /** Resolve the default scratch filename stem lazily: `crypto.randomUUID()`. */
  async #getDefaultRandomName(): Promise<() => string> {
    const crypto = await import('node:crypto')
    return () => crypto.randomUUID()
  }

  /**
   * Synthesizes text into a WAV audio clip.
   *
   * @remarks
   * Resolves the platform (constructor `platform` or `process.platform`), the effective
   * voice/rate/pitch (per-call overrides ctor), the words-per-minute (for `say`/`espeak-ng`) and
   * the `-10..10` PowerShell rate (for win32), then shells out via the executor, reads the scratch
   * WAV back, hard-validates the RIFF/WAVE magic, and unlinks the scratch file in a `finally`.
   *
   * @param text - The text to speak. Passed verbatim as the final positional arg / PowerShell literal.
   * @param opts - Per-call options; each field overrides the constructor default of the same name.
   * @returns A {@link GeneratedMediaOutput} descriptor with `kind: 'audio'`, `mimeType: 'audio/wav'`,
   *   the WAV bytes, and `filename: 'speech.wav'`.
   * @throws {@link @nhtio/adk/batteries/tts/native!E_NATIVE_TTS_UNSUPPORTED_PLATFORM} when the
   *   resolved platform is not `darwin`/`linux`/`win32`.
   * @throws {@link @nhtio/adk/batteries/tts/native!E_NATIVE_TTS_TIMEOUT} when the binary is aborted
   *   for exceeding `timeoutMs` (default 60_000 ms).
   * @throws {@link @nhtio/adk/batteries/tts/native!E_NATIVE_TTS_ENGINE_ERROR} when the binary fails,
   *   produces no output, or yields bytes that are not a RIFF/WAVE file.
   */
  async synthesize(text: string, opts?: NativeSynthesizeOptions): Promise<GeneratedMediaOutput> {
    const ctor = this.#options

    // 1. Resolve platform. Auto-detect from process.platform when the ctor did not pin one.
    let platform: NativeTtsPlatform
    if (ctor.platform !== undefined) {
      platform = ctor.platform
    } else {
      const detected =
        typeof process !== 'undefined' && typeof process.platform === 'string'
          ? process.platform
          : ''
      if (!SUPPORTED_PLATFORMS.has(detected as NativeTtsPlatform)) {
        throw new E_NATIVE_TTS_UNSUPPORTED_PLATFORM([detected || 'unknown'])
      }
      platform = detected as NativeTtsPlatform
    }

    // 2. Resolve effective voice/rate/pitch (per-call overrides ctor).
    const effectiveVoice = opts?.voice ?? ctor.voice
    const effectiveRate = opts?.rate ?? ctor.rate
    const effectivePitch = opts?.pitch ?? ctor.pitch

    // wpm for say/espeak-ng; win32 rate int for PowerShell. Computed HERE (not in the helper).
    const wpm = ctor.wordsPerMinute ?? clamp(round(175 * (effectiveRate ?? 1)), 80, 500)
    const win32Rate = clamp(round(((effectiveRate ?? 1) - 1) * 10), -10, 10)

    // 3. Mint the scratch outPath via the tmpdir/randomName seams.
    const tmpdir = ctor.tmpdir ?? (await this.#getDefaultTmpdir())
    const randomName = ctor.randomName ?? (await this.#getDefaultRandomName())
    const { join } = await import('node:path')
    const outPath = join(tmpdir(), `adk-tts-${randomName()}.wav`)

    // 4. Build the invocation.
    const invocation = buildNativeTtsInvocation({
      platform,
      outPath,
      text,
      command: ctor.command,
      voice: effectiveVoice,
      wordsPerMinute: wpm,
      pitch: effectivePitch,
      rate: win32Rate,
      extraArgs: ctor.extraArgs,
    })

    // 5. Resolve the executor + fs seams BEFORE running anything, so that once the binary has
    // (potentially) written the scratch file, EVERY exit path — including an executor rejection or a
    // flag-based failure — reaches the `finally` unlink. Defaults are created lazily only when no
    // seam was injected.
    const executor: TtsBinaryExecutor = ctor.executor ?? (await this.#getDefaultExecutor())
    const fs: TtsFsLike = ctor.fs ?? (await this.#getDefaultFs())
    const timeoutMs = ctor.timeoutMs ?? 60_000

    // 6. The scratch file is ALWAYS unlinked — on success, on executor rejection, on a flag-based
    // failure, on a read failure, and on an invalid-WAV throw. The executor invocation is INSIDE the
    // `try` so a rejecting executor (which may have left a partial file) still hits the cleanup.
    try {
      let result: TtsBinaryExecutorResult
      try {
        result = await executor.exec({ cmd: invocation.cmd, args: invocation.args, timeoutMs })
      } catch (err) {
        throw new E_NATIVE_TTS_ENGINE_ERROR([
          `synthesis executor failed: ${isError(err) ? err.message : String(err)}`,
        ])
      }

      // Classify from the FLAGS — never from exit code/stderr.
      if (result.timedOut) {
        throw new E_NATIVE_TTS_TIMEOUT([timeoutMs])
      }
      if (result.failed) {
        throw new E_NATIVE_TTS_ENGINE_ERROR([result.stderr || 'synthesis failed'])
      }

      // 7. Read the bytes and hard-assert the RIFF/WAVE magic.
      let bytes: Uint8Array
      try {
        bytes = await fs.readFile(outPath)
      } catch (err) {
        throw new E_NATIVE_TTS_ENGINE_ERROR([
          `failed to read synthesized output: ${isError(err) ? err.message : String(err)}`,
        ])
      }
      if (bytes.length < 12) {
        throw new E_NATIVE_TTS_ENGINE_ERROR(['expected a RIFF/WAVE file'])
      }
      const ascii = (start: number, end: number): string =>
        String.fromCharCode(...bytes.subarray(start, end))
      const isRiff = ascii(0, 4) === 'RIFF'
      const isWave = ascii(8, 12) === 'WAVE'
      if (!isRiff || !isWave) {
        throw new E_NATIVE_TTS_ENGINE_ERROR(['expected a RIFF/WAVE file'])
      }
      return {
        kind: 'audio',
        mimeType: 'audio/wav',
        bytes,
        filename: 'speech.wav',
      }
    } finally {
      try {
        await fs.unlink(outPath)
      } catch {
        // swallow — teardown must not throw
      }
    }
  }
}
