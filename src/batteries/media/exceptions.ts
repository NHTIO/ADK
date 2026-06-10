/**
 * Battery-scoped exceptions for the media pipeline battery.
 *
 * @remarks
 * Internal sibling of the `@nhtio/adk/batteries/media` entry — re-exported from the battery's
 * own barrel per the battery-scoped-exceptions rule. These are the typed errors the
 * implementor-facing API throws; the agent-facing forge catches them and renders readable
 * failure strings the model can act on.
 *
 * Error layering (see the design doc, frozen section 0):
 *
 * - Config errors (`E_INVALID_MEDIA_PIPELINE_CONFIG`) throw at pipeline construction or first
 *   engine-resolver resolution. Fatal — a programmer mistake, not a runtime condition.
 * - Syntactic pipe errors (`E_MEDIA_PIPE_SYNTAX`) carry line/col position plus a
 *   "write it like:" exemplar, because models repair from instructions, not carets.
 * - Semantic plan errors (`E_MEDIA_UNKNOWN_VERB`, `E_MEDIA_UNKNOWN_ARG`, `E_MEDIA_BAD_ARG`,
 *   `E_MEDIA_MISSING_ARG`, `E_MEDIA_UNSUPPORTED_OP`, `E_MEDIA_ENGINE_REQUIRED`) are produced by
 *   the plan validator walking the AST against the full verb table and the configured engines.
 * - Render errors (`E_MEDIA_NOT_PIPE_EXPRESSIBLE`) come from `toPipe()` on plans containing
 *   builder-only constructs.
 * - Execution errors (`E_MEDIA_STEP_FAILED`, `E_MEDIA_STEP_UNAVAILABLE`) surface step-runtime
 *   failures with the original error as `cause`.
 */

import { createException } from '@nhtio/adk/factories'

/**
 * Thrown when `createMediaPipeline` receives an invalid configuration — a malformed engine,
 * a resolver that resolved to a value failing its contract guard, or an invalid option shape.
 */
export const E_INVALID_MEDIA_PIPELINE_CONFIG = createException<[string]>(
  'E_INVALID_MEDIA_PIPELINE_CONFIG',
  'Invalid media pipeline config: %s',
  'E_INVALID_MEDIA_PIPELINE_CONFIG',
  529,
  true
)

/**
 * Thrown by `parsePipe` when the pipe expression fails to tokenize or parse. The message carries
 * line/col position and a corrective exemplar.
 */
export const E_MEDIA_PIPE_SYNTAX = createException<[string]>(
  'E_MEDIA_PIPE_SYNTAX',
  'pipe parse error: %s',
  'E_MEDIA_PIPE_SYNTAX',
  422,
  false
)

/**
 * Thrown when a statement names a verb that does not exist in the verb table. The message
 * includes a did-you-mean suggestion (Levenshtein over folded verb forms, including suffix-word
 * matches) and the list of verbs available in this deployment.
 */
export const E_MEDIA_UNKNOWN_VERB = createException<[string]>(
  'E_MEDIA_UNKNOWN_VERB',
  '%s',
  'E_MEDIA_UNKNOWN_VERB',
  422,
  false
)

/**
 * Thrown when a statement passes an arg a verb does not declare. The message includes a
 * did-you-mean suggestion and the verb's declared args.
 */
export const E_MEDIA_UNKNOWN_ARG = createException<[string]>(
  'E_MEDIA_UNKNOWN_ARG',
  '%s',
  'E_MEDIA_UNKNOWN_ARG',
  422,
  false
)

/**
 * Thrown when an arg value fails its declared type/enum/constraint — including descending
 * ranges, invalid regex sources, malformed embedded JSON, and out-of-enum values.
 */
export const E_MEDIA_BAD_ARG = createException<[string]>(
  'E_MEDIA_BAD_ARG',
  '%s',
  'E_MEDIA_BAD_ARG',
  422,
  false
)

/** Thrown when a verb's required arg is absent from the statement. */
export const E_MEDIA_MISSING_ARG = createException<[string]>(
  'E_MEDIA_MISSING_ARG',
  '%s',
  'E_MEDIA_MISSING_ARG',
  422,
  false
)

/**
 * Thrown at plan validation when a verb cannot apply to the input's format family (e.g. a
 * `sheet.*` verb on a PDF), or a namespace verb is used on the wrong media kind.
 */
export const E_MEDIA_UNSUPPORTED_OP = createException<[string]>(
  'E_MEDIA_UNSUPPORTED_OP',
  '%s',
  'E_MEDIA_UNSUPPORTED_OP',
  422,
  false
)

/**
 * Thrown at plan validation when a verb (or the specific input it is applied to) requires an
 * engine that is not configured on this pipeline. The message states which engine slot is
 * missing and — when the failure is input-specific — that the verb should not be retried on
 * this media in this deployment.
 */
export const E_MEDIA_ENGINE_REQUIRED = createException<[string]>(
  'E_MEDIA_ENGINE_REQUIRED',
  '%s',
  'E_MEDIA_ENGINE_REQUIRED',
  422,
  false
)

/**
 * Thrown by `toPipe()` when the plan contains constructs the flat pipe grammar cannot express —
 * currently only nested-builder media refs. Quoted-JSON structured args DO render; use `toOps()`
 * for a total serialization.
 */
export const E_MEDIA_NOT_PIPE_EXPRESSIBLE = createException<[string]>(
  'E_MEDIA_NOT_PIPE_EXPRESSIBLE',
  'plan is not expressible as a pipe string: %s',
  'E_MEDIA_NOT_PIPE_EXPRESSIBLE',
  422,
  false
)

/**
 * Thrown by the step runtime when a step implementation fails mid-execution (corrupt input,
 * engine error). Carries the underlying error as `cause`.
 */
export const E_MEDIA_STEP_FAILED = createException<[string, string]>(
  'E_MEDIA_STEP_FAILED',
  'step "%s" failed: %s',
  'E_MEDIA_STEP_FAILED',
  500,
  false
)

/**
 * Thrown by the step runtime when a plan step has no registered implementation. Distinct from
 * `E_MEDIA_ENGINE_REQUIRED`: this indicates the battery itself does not (yet) implement the
 * verb, not that the consumer omitted an engine.
 */
export const E_MEDIA_STEP_UNAVAILABLE = createException<[string]>(
  'E_MEDIA_STEP_UNAVAILABLE',
  'no step implementation is registered for verb "%s"',
  'E_MEDIA_STEP_UNAVAILABLE',
  501,
  false
)
