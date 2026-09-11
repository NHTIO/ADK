import { isError } from '@nhtio/adk/guards'
import { createException } from '@nhtio/adk/factories'

/** Fatal construction error for invalid or unsafe-to-resolve manager configuration. */
export const E_INVALID_SKILLS_CONFIG = createException<[string]>(
  'E_INVALID_SKILLS_CONFIG',
  'Invalid skills config: %s',
  'E_INVALID_SKILLS_CONFIG',
  529,
  true
)
/** Raised when load, refresh, or unload names no winning catalog entry. */
export const E_SKILL_NOT_FOUND = createException<[string]>(
  'E_SKILL_NOT_FOUND',
  'Skill not found: %s',
  'E_SKILL_NOT_FOUND',
  422,
  false
)
/** Raised when load would initialize a skill that is already initialized. */
export const E_SKILL_ALREADY_LOADED = createException<[string]>(
  'E_SKILL_ALREADY_LOADED',
  'Skill already loaded: %s',
  'E_SKILL_ALREADY_LOADED',
  422,
  false
)
/** Raised when unload or a loaded-only operation targets an uninitialized skill. */
export const E_SKILL_NOT_LOADED = createException<[string]>(
  'E_SKILL_NOT_LOADED',
  'Skill not loaded: %s',
  'E_SKILL_NOT_LOADED',
  422,
  false
)
/** Raised when source metadata or a descriptor violates the identity/version contract. */
export const E_SKILL_MANIFEST_INVALID = createException<[string]>(
  'E_SKILL_MANIFEST_INVALID',
  'Invalid skill manifest: %s',
  'E_SKILL_MANIFEST_INVALID',
  422,
  false
)
/** Raised when a skill tool name collides with another registered tool. */
export const E_SKILL_TOOL_COLLISION = createException<[string]>(
  'E_SKILL_TOOL_COLLISION',
  'Skill tool collision: %s',
  'E_SKILL_TOOL_COLLISION',
  422,
  false
)
/** Raised when one skill declares the same tool name more than once. */
export const E_SKILL_TOOL_DUPLICATE = createException<[string]>(
  'E_SKILL_TOOL_DUPLICATE',
  'Duplicate skill tool: %s',
  'E_SKILL_TOOL_DUPLICATE',
  422,
  false
)
/** Raised when a skill tool handler fails during execution. */
export const E_SKILL_TOOL_FAILED = createException<[string, string]>(
  'E_SKILL_TOOL_FAILED',
  'Skill tool "%s" failed: %s',
  'E_SKILL_TOOL_FAILED',
  500,
  false
)
/** Raised when a skill tool returns a value that fails response validation. */
export const E_SKILL_TOOL_BAD_RESPONSE = createException<[string]>(
  'E_SKILL_TOOL_BAD_RESPONSE',
  'Invalid response from skill tool: %s',
  'E_SKILL_TOOL_BAD_RESPONSE',
  422,
  false
)
/** Raised when the selected artifact kind was not registered. */
export const E_SKILL_ARTIFACT_UNAVAILABLE = createException<[string]>(
  'E_SKILL_ARTIFACT_UNAVAILABLE',
  'Skill artifact kind unavailable: %s',
  'E_SKILL_ARTIFACT_UNAVAILABLE',
  422,
  false
)
/** Raised when a requested bundled path is unsafe or outside the source namespace. */
export const E_SKILL_SOURCE_PATH_REJECTED = createException<[string]>(
  'E_SKILL_SOURCE_PATH_REJECTED',
  'Skill source path rejected: %s',
  'E_SKILL_SOURCE_PATH_REJECTED',
  422,
  false
)
/** Explicit 403 refusal by the script policy; this is distinct from a failed gate. */
export const E_SKILL_SCRIPT_DENIED = createException<[string]>(
  'E_SKILL_SCRIPT_DENIED',
  'Skill script denied: %s',
  'E_SKILL_SCRIPT_DENIED',
  403,
  false
)
/** 503 when the script gate fails for any reason other than an explicit denial; never misroutes an engine failure as 403. */
export const E_SKILL_SCRIPT_GATE_UNAVAILABLE = createException<[string]>(
  'E_SKILL_SCRIPT_GATE_UNAVAILABLE',
  'Skill script gate unavailable: %s',
  'E_SKILL_SCRIPT_GATE_UNAVAILABLE',
  503,
  false
)
/** Raised when script policy derivation would widen permissions beyond the declared boundary. */
export const E_SKILL_SCRIPT_POLICY_WIDENED = createException<[string]>(
  'E_SKILL_SCRIPT_POLICY_WIDENED',
  'Skill script policy widened: %s',
  'E_SKILL_SCRIPT_POLICY_WIDENED',
  500,
  false
)
/** Raised when a script exceeds its configured execution deadline. */
export const E_SKILL_SCRIPT_TIMEOUT = createException<[string]>(
  'E_SKILL_SCRIPT_TIMEOUT',
  'Skill script timed out: %s',
  'E_SKILL_SCRIPT_TIMEOUT',
  422,
  false
)
/**
 * Raised when a skill script completes with a nonzero exit code and the deployment leaves
 * `SkillScriptConfig.failOnNonzeroExit` at its default (`true`). The message carries the script
 * name, the exit code, and the retrievable id of the spooled output so the failure is still
 * inspectable. A deployment whose scripts use exit codes as ordinary signalling sets
 * `failOnNonzeroExit: false` and receives the acknowledgement string instead.
 */
export const E_SKILL_SCRIPT_FAILED = createException<[string, string]>(
  'E_SKILL_SCRIPT_FAILED',
  'Skill script "%s" failed: %s',
  'E_SKILL_SCRIPT_FAILED',
  422,
  false
)
/** Raised when materialization or disposal of a skill workspace fails. */
export const E_SKILL_WORKSPACE_FAILED = createException<[string]>(
  'E_SKILL_WORKSPACE_FAILED',
  'Skill workspace failed: %s',
  'E_SKILL_WORKSPACE_FAILED',
  500,
  false
)

const failure = (code: string, message: string): string => `Error (${code}): ${message}`

/** Render skill runtime errors for the model; configuration errors remain fatal. */
export const renderError = (err: unknown): string => {
  if (isError(err) && err.name.startsWith('E_SKILL_')) {
    return failure(err.name.replace(/^E_SKILL_/, ''), err.message)
  }
  throw err
}
