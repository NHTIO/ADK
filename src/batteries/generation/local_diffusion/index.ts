/**
 * @module @nhtio/adk/batteries/generation/local_diffusion
 *
 * **Node-only.** This subpath drives a local diffusion subprocess and is not part of the
 * environment-neutral generation aggregate.
 */

export { LocalDiffusionGenerationAdapter } from './adapter'
export { localDiffusionOptionsSchema, validateOptions } from './validation'
export {
  E_INVALID_LOCAL_DIFFUSION_OPTIONS,
  E_LOCAL_DIFFUSION_BACKEND_ERROR,
  E_LOCAL_DIFFUSION_STARTUP_TIMEOUT,
  E_LOCAL_DIFFUSION_REQUEST_TIMEOUT,
  E_LOCAL_DIFFUSION_ABORTED,
  E_LOCAL_DIFFUSION_MALFORMED_FRAME,
  E_LOCAL_DIFFUSION_BUSY,
  E_LOCAL_DIFFUSION_DISPOSED,
} from './exceptions'
export type {
  ReadableLike,
  DiffusionBackendProcess,
  DiffusionBackendSpawner,
  DiffusionFsLike,
  LocalDiffusionCallOptions,
  LocalDiffusionGenerationAdapterOptions,
  GeneratedMediaOutput,
} from './types'
