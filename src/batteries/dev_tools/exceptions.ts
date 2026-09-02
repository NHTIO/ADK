import { createException } from '../../factories'

/** Fatal configuration error for a development-tools pipeline. */
export const E_INVALID_DEV_PIPELINE_CONFIG = createException<[string]>(
  'E_INVALID_DEV_PIPELINE_CONFIG',
  'Invalid dev pipeline config: %s',
  'E_INVALID_DEV_PIPELINE_CONFIG',
  529,
  true
)
/** Unknown development step. */
export const E_DEV_UNKNOWN_STEP = createException<[string]>(
  'E_DEV_UNKNOWN_STEP',
  '%s',
  'E_DEV_UNKNOWN_STEP',
  422,
  false
)
/** Invalid development-step argument. */
export const E_DEV_BAD_ARG = createException<[string]>(
  'E_DEV_BAD_ARG',
  '%s',
  'E_DEV_BAD_ARG',
  422,
  false
)
/** A requested engine capability is not configured. */
export const E_DEV_ENGINE_REQUIRED = createException<[string]>(
  'E_DEV_ENGINE_REQUIRED',
  '%s',
  'E_DEV_ENGINE_REQUIRED',
  422,
  false
)
/** A development step failed during execution or validation. */
export const E_DEV_STEP_FAILED = createException<[string, string]>(
  'E_DEV_STEP_FAILED',
  'step "%s" failed: %s',
  'E_DEV_STEP_FAILED',
  500,
  false
)
/** A step implementation is not available. */
export const E_DEV_STEP_UNAVAILABLE = createException<[string]>(
  'E_DEV_STEP_UNAVAILABLE',
  'no step implementation is registered for "%s"',
  'E_DEV_STEP_UNAVAILABLE',
  501,
  false
)
/** Workspace bounds were exceeded. */
export const E_DEV_WORKSPACE_BOUNDS = createException<[string]>(
  'E_DEV_WORKSPACE_BOUNDS',
  '%s',
  'E_DEV_WORKSPACE_BOUNDS',
  422,
  false
)
/** A gate declined a step. */
export const E_DEV_GATE_DECLINED = createException<[string]>(
  'E_DEV_GATE_DECLINED',
  '%s',
  'E_DEV_GATE_DECLINED',
  403,
  false
)
