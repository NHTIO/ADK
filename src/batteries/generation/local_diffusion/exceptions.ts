/** Local diffusion battery exceptions.
 * @module @nhtio/adk/batteries/generation/local_diffusion/exceptions
 */
import { createException } from '@nhtio/adk/factories'

/** Invalid adapter configuration. */
export const E_INVALID_LOCAL_DIFFUSION_OPTIONS = createException<[string]>(
  'E_INVALID_LOCAL_DIFFUSION_OPTIONS',
  'Invalid local diffusion options: %s',
  'E_INVALID_LOCAL_DIFFUSION_OPTIONS',
  529,
  true
)
/** Backend process failure. Optional printf args: `[detail, exitCode?, signal?]`. */
export const E_LOCAL_DIFFUSION_BACKEND_ERROR = createException<[string, number?, string?]>(
  'E_LOCAL_DIFFUSION_BACKEND_ERROR',
  'Local diffusion backend error: %s (exit %s, signal %s)',
  'E_LOCAL_DIFFUSION_BACKEND_ERROR',
  502,
  false
)
/** Startup exceeded its deadline. */
export const E_LOCAL_DIFFUSION_STARTUP_TIMEOUT = createException<[number]>(
  'E_LOCAL_DIFFUSION_STARTUP_TIMEOUT',
  'Local diffusion startup timed out after %dms',
  'E_LOCAL_DIFFUSION_STARTUP_TIMEOUT',
  504,
  false
)
/** Request exceeded its deadline. */
export const E_LOCAL_DIFFUSION_REQUEST_TIMEOUT = createException<[number]>(
  'E_LOCAL_DIFFUSION_REQUEST_TIMEOUT',
  'Local diffusion request timed out after %dms',
  'E_LOCAL_DIFFUSION_REQUEST_TIMEOUT',
  504,
  false
)
/** Request was cancelled. */
export const E_LOCAL_DIFFUSION_ABORTED = createException<[]>(
  'E_LOCAL_DIFFUSION_ABORTED',
  'Local diffusion request aborted',
  'E_LOCAL_DIFFUSION_ABORTED',
  499,
  false
)
/** Backend emitted malformed protocol data. */
export const E_LOCAL_DIFFUSION_MALFORMED_FRAME = createException<[string]>(
  'E_LOCAL_DIFFUSION_MALFORMED_FRAME',
  'Malformed local diffusion frame: %s',
  'E_LOCAL_DIFFUSION_MALFORMED_FRAME',
  502,
  false
)
/** Another request is active. */
export const E_LOCAL_DIFFUSION_BUSY = createException<[]>(
  'E_LOCAL_DIFFUSION_BUSY',
  'Local diffusion backend is busy',
  'E_LOCAL_DIFFUSION_BUSY',
  409,
  false
)
/** Adapter has been disposed. */
export const E_LOCAL_DIFFUSION_DISPOSED = createException<[]>(
  'E_LOCAL_DIFFUSION_DISPOSED',
  'Local diffusion adapter is disposed',
  'E_LOCAL_DIFFUSION_DISPOSED',
  409,
  false
)
