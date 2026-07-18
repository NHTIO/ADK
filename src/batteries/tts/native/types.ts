/**
 * Option and seam types for the OS-native TTS (text-to-speech) adapter.
 *
 * @module @nhtio/adk/batteries/tts/native/types
 *
 * @remarks
 * **Node-only.** This engine synthesizes by shelling out to the operating system's own speech
 * binary — macOS `say`, Linux `espeak-ng`, or Windows PowerShell `System.Speech` — and reading back
 * the WAV file it writes. It is model-less: it extends the shared {@link BaseTtsAdapterOptions}
 * (`voice`/`rate`) but adds NO `model` field.
 *
 * All shell-out and filesystem access is injectable so unit tests stay hermetic (no real
 * `child_process`, no real files): {@link TtsBinaryExecutor} (default: a lazy `node:child_process`
 * `execFile` wrapper), {@link TtsFsLike} (default: `node:fs/promises`), plus `tmpdir()`/`randomName()`
 * seams for the scratch output path.
 */

import type { BaseTtsAdapterOptions, SynthesizeOptions } from '../_shared'

// Re-export the shared TTS base + result contracts so consumers import them from this engine barrel.
export type {
  BaseTtsAdapterOptions,
  SynthesizeOptions,
  GeneratedMediaOutput,
  TtsSynthesisResult,
} from '../_shared'

/** The operating-system platforms this engine can synthesize on. */
export type NativeTtsPlatform = 'darwin' | 'linux' | 'win32'

/**
 * The result of running a single native TTS binary invocation.
 *
 * @remarks
 * Shaped like the media domain's `BinaryExecutor` result **plus an explicit `timedOut` flag**. The
 * adapter classifies a timeout (→ `E_NATIVE_TTS_TIMEOUT`, 504) versus an ordinary failure (→
 * `E_NATIVE_TTS_ENGINE_ERROR`, 502) from this flag alone — never by inferring a timeout from the exit
 * code or stderr, which are indistinguishable across a timeout, a signal kill, and a non-zero CLI
 * exit. A BYO executor MUST set `timedOut: true` (and typically `failed: true`) when it aborts the
 * process for exceeding the deadline; the default `execFile` wrapper sets it from its own
 * `AbortController`.
 */
export interface TtsBinaryExecutorResult {
  /** Process exit code, when one was produced. */
  exitCode?: number
  /** Captured stdout. */
  stdout?: string
  /** Captured stderr — surfaced in the thrown error detail on failure. */
  stderr?: string
  /** Whether the process failed (non-zero exit, spawn error, signal, or timeout). */
  failed: boolean
  /** Whether the process was aborted for exceeding {@link NativeTtsAdapterOptions.timeoutMs}. */
  timedOut: boolean
}

/**
 * A pluggable runner for the native TTS binary — the seam that lets a consumer swap the default
 * `node:child_process` `execFile` for `execa`, a sandbox, a container shim, or a remote runner.
 *
 * @remarks
 * Structurally compatible with the media domain's `BinaryExecutor` (so a consumer can hand that
 * domain's `execaExecutor()` in), but NOT imported from `media` — this keeps the TTS module graph
 * free of the media domain. The one addition is the mandatory `timedOut` flag on the result (see
 * {@link TtsBinaryExecutorResult}).
 */
export interface TtsBinaryExecutor {
  /**
   * Run the binary. `cmd`/`args` are passed WITHOUT a shell (no interpolation); an implementation
   * MUST enforce `timeoutMs` (aborting the process and setting `timedOut: true`) and honor an
   * upstream `signal`.
   */
  exec(invocation: {
    cmd: string
    args: string[]
    timeoutMs?: number
    signal?: AbortSignal
  }): Promise<TtsBinaryExecutorResult>
}

/**
 * The minimal filesystem surface the native engine needs: read the synthesized WAV, then delete it.
 * Default: `node:fs/promises`. Injectable so unit tests supply canned bytes and record the unlink.
 */
export interface TtsFsLike {
  /** Read the whole synthesized WAV file back as bytes. */
  readFile(path: string): Promise<Uint8Array>
  /** Delete the scratch file (called in a `finally`; errors are swallowed). */
  unlink(path: string): Promise<void>
}

/**
 * Constructor options for the OS-native TTS adapter. **All optional** — a zero-config
 * `new NativeTtsAdapter()` is valid and auto-detects the platform.
 *
 * @remarks
 * Extends the shared {@link BaseTtsAdapterOptions} (`voice`/`rate`) — see that base for the
 * normalization semantics. `rate` maps to `round(175 * rate)` words-per-minute for `say`/`espeak-ng`
 * (clamped to a validated band) and to the `-10..10` PowerShell `SpeechSynthesizer.Rate`.
 */
export interface NativeTtsAdapterOptions extends BaseTtsAdapterOptions {
  /** Target platform. Default: auto-detected from `process.platform`. */
  platform?: NativeTtsPlatform
  /**
   * Override the synthesis **executable only** (e.g. `'espeak'` instead of `'espeak-ng'`). The
   * default platform-specific arguments/script are still built around it; this does NOT replace the
   * whole invocation.
   */
  command?: string
  /** Extra arguments appended before the text/output arguments. Passed verbatim (no shell). */
  extraArgs?: string[]
  /**
   * Exact words-per-minute for `say`/`espeak-ng`, overriding the `rate`→wpm mapping. Ignored on
   * win32 (which uses the `-10..10` rate scale).
   */
  wordsPerMinute?: number
  /** Voice pitch for `espeak-ng` (`0`–`99`, its `-p` flag). Ignored on other platforms. */
  pitch?: number
  /** Per-invocation timeout in ms. Default `60_000`. Exceeding it → `E_NATIVE_TTS_TIMEOUT`. */
  timeoutMs?: number
  /** Override the binary runner. Default: a lazy `node:child_process` `execFile` wrapper. */
  executor?: TtsBinaryExecutor
  /** Override filesystem access. Default: `node:fs/promises`. */
  fs?: TtsFsLike
  /** Override the scratch directory. Default: `node:os` `tmpdir()`. */
  tmpdir?: () => string
  /** Override the scratch filename stem. Default: `crypto.randomUUID()`. */
  randomName?: () => string
  /** Override the availability probe. Default: Node process on a supported {@link NativeTtsPlatform}. */
  isAvailable?: () => boolean
}

/**
 * Per-call options for {@link NativeTtsAdapter.synthesize}. Extends the shared
 * {@link SynthesizeOptions} (`voice`/`rate`) with the native per-call knobs; each field overrides
 * the constructor default of the same name for this one call.
 */
export interface NativeSynthesizeOptions extends SynthesizeOptions {
  /** Voice pitch for this call (`espeak-ng` only); overrides the constructor `pitch`. */
  pitch?: number
}
