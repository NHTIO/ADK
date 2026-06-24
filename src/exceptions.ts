/**
 * Core ADK exception classes and reusable runtime error constructors.
 *
 * Every exception has a stable `E_*` code. The `fatal` flag on each code controls whether it
 * throws synchronously (programming error — no recovery path) or is emitted on the observability
 * `error` bus (runtime failure — `run()` still resolves).
 *
 * @groupDescription Turn Runner Construction
 * Exceptions thrown when a {@link @nhtio/adk!TurnRunner} is misconfigured at construction time. Fatal —
 * a misconfigured runner cannot execute turns.
 *
 * @groupDescription Turn Input Validation
 * Exceptions thrown when the raw turn context supplied to `runner.run()` fails validation. Fatal
 * and synchronous — thrown before `turnStart` is emitted.
 *
 * @groupDescription Pipelines
 * Non-fatal pipeline errors emitted on the observability `error` bus when middleware throws or
 * a pipeline short-circuits. `run()` resolves; `turnEnd` still fires.
 *
 * @groupDescription Dispatch
 * Exceptions from the dispatch loop and its executor. A mix of fatal (programming errors) and
 * non-fatal (runtime failures that nack the dispatch). The loop terminates as `'ack'`, `'nack'`,
 * or `'aborted'` — inspect `dispatchEnd.status` to classify.
 *
 * @groupDescription Gates
 * Exceptions from {@link @nhtio/adk!TurnGate} construction and settlement. All four settlement outcomes
 * (resolved, invalid-resolution, aborted, timed-out) also emit `turnGateClosed` on the
 * observability bus.
 *
 * @groupDescription Tools
 * Exceptions from tool construction, registration, argument validation, and handler execution.
 * `E_TOOL_DOWNSTREAM_ERROR` wraps handler throws — the original error is on `.cause`.
 *
 * @groupDescription Primitive Validation
 * Fatal exceptions thrown at construction time when a primitive ({@link @nhtio/adk!Message}, {@link @nhtio/adk!Memory},
 * {@link @nhtio/adk!Thought}, {@link @nhtio/adk!ToolCall}, {@link @nhtio/adk!Retrievable}, {@link @nhtio/adk!Identity}, {@link @nhtio/adk!Registry})
 * receives an invalid initial value. If a primitive constructed, it is valid.
 *
 * @groupDescription Artifacts
 * Exceptions from spool and media artifact construction. Fatal — wrap-site validation that the
 * supplied value implements the required reader interface.
 *
 * @module @nhtio/adk/exceptions
 */

/**
 * @primaryExport
 */
export { ValidationException } from './lib/utils/validation'

/**
 * @primaryExport
 */
export {
  E_INVALID_TURN_RUNNER_CONFIG,
  E_INVALID_TURN_CONTEXT,
  E_INPUT_PIPELINE_ERROR,
  E_OUTPUT_PIPELINE_ERROR,
  E_PIPELINE_SHORT_CIRCUITED,
  E_INVALID_INITIAL_REGISTRY_VALUE,
  E_INVALID_INITIAL_MEMORY_VALUE,
  E_INVALID_INITIAL_MESSAGE_VALUE,
  E_INVALID_INITIAL_IDENTITY_VALUE,
  E_INVALID_INITIAL_THOUGHT_VALUE,
  E_INVALID_INITIAL_RETRIEVABLE_VALUE,
  E_INVALID_INITIAL_MEDIA_VALUE,
  E_NOT_A_MEDIA_READER,
  E_INVALID_INITIAL_TURN_GATE_VALUE,
  E_INVALID_TURN_GATE_RESOLUTION,
  E_TURN_GATE_TIMEOUT,
  E_TURN_GATE_ABORTED,
  E_NOT_A_SPOOL_READER,
  E_INVALID_INITIAL_TOOL_CALL_VALUE,
  E_INVALID_INITIAL_TOOL_VALUE,
  E_INVALID_TOOL_ARGS,
  E_TOOL_DOWNSTREAM_ERROR,
  E_TOOL_ALREADY_REGISTERED,
  E_INVALID_LLM_EXECUTION_CONTEXT,
  E_LLM_EXECUTION_GATE_NOT_SUPPORTED,
  E_LLM_EXECUTION_ALREADY_SIGNALLED,
  E_INVALID_LLM_DISPATCH_INPUT,
  E_DISPATCH_PIPELINE_ERROR,
  E_LLM_EXECUTION_EXECUTOR_ERROR,
  E_READER_NOT_DESCRIBABLE,
  E_NO_READER_RESOLVER,
} from './lib/exceptions/runtime'
