/** Node-only option and process contracts for local diffusion generation.
 *
 * @module @nhtio/adk/batteries/generation/local_diffusion/types
 */

import type { ProtocolConfig } from './protocol'
import type { BatteryLifecycleHooks } from '../../llm/chat_common/lifecycle'
import type {
  BaseGenerationAdapterOptions,
  EditOptions,
  GenerateOptions,
  GeneratedMediaOutput,
} from '../openai/types'

/** A readable stream surface used by a diffusion backend. */
export interface ReadableLike {
  /** Register a stream listener. */
  on(event: 'data', listener: (chunk: Uint8Array) => void): void
  /** Register an end listener. */
  on(event: 'end', listener: () => void): void
  /** Register an error listener. */
  on(event: 'error', listener: (error: Error) => void): void
  /** Remove a previously registered listener. */
  off(event: string, listener: (...args: any[]) => void): void
}

/** The observable child-process surface required by the adapter. */
export interface DiffusionBackendProcess {
  /** Writable backend stdin, when available. */
  stdin: { write(value: string): void } | null
  /** Backend stdout, when available. */
  stdout: ReadableLike | null
  /** Diagnostic stderr, never parsed as protocol. */
  stderr?: ReadableLike | null
  /** Register a process listener. */
  on(event: 'error', listener: (error: Error) => void): void
  /** Register an exit listener. */
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
  /** Register a close listener. */
  on(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void
  /** Remove a process listener. */
  off(event: string, listener: (...args: any[]) => void): void
  /** Terminate the backend. */
  kill(signal?: NodeJS.Signals | number): void
}

/** Factory seam for starting one backend process. */
export type DiffusionBackendSpawner = (context: {
  /** Executable to start. */
  command: string
  /** Executable arguments. */
  args: string[]
  /** Configured checkpoint. */
  model: string
}) => DiffusionBackendProcess | Promise<DiffusionBackendProcess>

/** Injectable filesystem operations used for backend-written images. */
export interface DiffusionFsLike {
  /** Read an image before cleanup. */
  readFile(path: string): Promise<Uint8Array>
  /** Remove a backend-written image. */
  unlink(path: string): Promise<void>
}

/** Per-call local diffusion controls. */
export interface LocalDiffusionCallOptions extends GenerateOptions, EditOptions {
  /** Abort this request. */
  signal?: AbortSignal
  /** Override negative prompt. */
  negativePrompt?: string
  /** Override denoising steps. */
  steps?: number
  /** Override classifier-free guidance scale. */
  cfgScale?: number
  /** Override sampler. */
  sampler?: string
  /** Override random seed. */
  seed?: number
  /** Override output width. */
  width?: number
  /** Override output height. */
  height?: number
}

/** Constructor options for {@link LocalDiffusionGenerationAdapter}. */
export interface LocalDiffusionGenerationAdapterOptions
  extends BaseGenerationAdapterOptions, BatteryLifecycleHooks {
  /** Backend executable. */
  command: string
  /** Backend arguments before the model context. */
  args?: string[]
  /** Process factory seam. */
  spawn?: DiffusionBackendSpawner
  /** Filesystem seam. */
  fs?: DiffusionFsLike
  /** Directory within which backend output files may be deleted. */
  outputDir?: string
  /** Maximum decoded inline image size. */
  maxDecodedBytes?: number
  /** Maximum protocol line size. */
  maxLineBytes?: number
  /** Protocol tag overrides. */
  protocol?: Partial<ProtocolConfig>
  /** Command prefix override. */
  commandPrefix?: string
  /** Event prefix override. */
  eventPrefix?: string
  /** Operation and event tag overrides. */
  ops?: Partial<ProtocolConfig['ops']>
  /** Control tag overrides. */
  control?: Partial<ProtocolConfig['control']>
  /** Event tag overrides. */
  events?: Partial<ProtocolConfig['events']>
  /** Startup deadline in milliseconds. */
  startupTimeoutMs?: number
  /** Request deadline in milliseconds; zero disables it. */
  requestTimeoutMs?: number
  /** Grace period after cancellation. */
  abortGraceMs?: number
  /** Grace period for graceful disposal. */
  disposeGraceMs?: number
  /** Default negative prompt. */
  negativePrompt?: string
  /** Default denoising steps. */
  steps?: number
  /** Default classifier-free guidance scale. */
  cfgScale?: number
  /** Default sampler. */
  sampler?: string
  /** Default random seed. */
  seed?: number
  /** Default output width. */
  width?: number
  /** Default output height. */
  height?: number
  /** Runtime availability override. */
  isAvailable?: () => boolean
}

/** Shared result type re-export. */
export type { GeneratedMediaOutput }
