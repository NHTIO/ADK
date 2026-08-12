import { createException } from '../../lib/utils/exceptions'
/** Invalid sandbox configuration. */
export const E_INVALID_SANDBOX_CONFIG = createException<[string]>(
  'E_INVALID_SANDBOX_CONFIG',
  '%s',
  'E_INVALID_SANDBOX_CONFIG',
  400,
  false
)
/** Sandbox environment is unsupported. */
export const E_SANDBOX_UNSUPPORTED_ENV = createException<[string]>(
  'E_SANDBOX_UNSUPPORTED_ENV',
  '%s',
  'E_SANDBOX_UNSUPPORTED_ENV',
  400,
  false
)
/** Sandbox dependency is missing or unavailable at assembly time. */
export const E_SANDBOX_DEPENDENCY_MISSING = createException<[string]>(
  'E_SANDBOX_DEPENDENCY_MISSING',
  '%s',
  'E_SANDBOX_DEPENDENCY_MISSING',
  424,
  false
)
/** Sandbox operation was attempted before initialization. */
export const E_SANDBOX_NOT_INITIALIZED = createException<[string]>(
  'E_SANDBOX_NOT_INITIALIZED',
  '%s',
  'E_SANDBOX_NOT_INITIALIZED',
  500,
  false
)
/** Requested policy conflicts with another enforced policy. */
export const E_SANDBOX_POLICY_CONFLICT = createException<[string]>(
  'E_SANDBOX_POLICY_CONFLICT',
  '%s',
  'E_SANDBOX_POLICY_CONFLICT',
  409,
  false
)
/** A requested policy narrowing cannot be represented by the backend. */
export const E_SANDBOX_NARROWING_UNSUPPORTED = createException<[string]>(
  'E_SANDBOX_NARROWING_UNSUPPORTED',
  '%s',
  'E_SANDBOX_NARROWING_UNSUPPORTED',
  422,
  false
)
/** A required approval gate was not supplied. */
export const E_SANDBOX_GATE_REQUIRED = createException<[string]>(
  'E_SANDBOX_GATE_REQUIRED',
  '%s',
  'E_SANDBOX_GATE_REQUIRED',
  428,
  false
)
/** Sandbox refusal presented to the model. */
export const E_SANDBOX_REFUSED = createException<[string]>(
  'E_SANDBOX_REFUSED',
  '%s',
  'E_SANDBOX_REFUSED',
  403,
  false
)
/** Sandbox operational failure presented to the model. */
export const E_SANDBOX_FAILED = createException<[string]>(
  'E_SANDBOX_FAILED',
  '%s',
  'E_SANDBOX_FAILED',
  500,
  false
)
/**
 * Thrown when a model-supplied path is an UNAMBIGUOUS escape or an unsupported form.
 *
 * @remarks
 * Only the refuse-outright set of LLM-operator rule 1 reaches this: a NUL byte anywhere, a leading
 * `~`, any leading drive letter, a device/verbatim prefix, a UNC form, and a `../` that still escapes
 * after lexical resolution. A leading `/` does NOT — it normalises to the sandbox root, because the
 * model's world IS the sandbox and refusing it would punish the model for a distinction we
 * deliberately hid from it. Message template is bare `'%s'` so the narrator text arrives unprefixed.
 */
export const E_SANDBOX_PATH_ESCAPE = createException<[string]>(
  'E_SANDBOX_PATH_ESCAPE',
  '%s',
  'E_SANDBOX_PATH_ESCAPE',
  400,
  false
)
