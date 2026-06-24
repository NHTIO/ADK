import { createException } from '../utils/exceptions'

/**
 * Thrown by {@link @nhtio/adk!TurnRunner} when the supplied config object fails schema validation at
 * construction time.
 *
 * @remarks
 * Marked fatal — a misconfigured runner must not be allowed to execute turns.
 *
 * The single printf argument carries the validator's field-level detail (e.g.
 * `"storeMediaBytesCallback is required"`) so a misconfiguration names the offending field
 * instead of failing opaquely. The underlying `ValidationError` is also attached on `cause`.
 *
 * @group Turn Runner Construction
 */
export const E_INVALID_TURN_RUNNER_CONFIG = createException<[string]>(
  'E_INVALID_TURN_RUNNER_CONFIG',
  'The turn runner cannot be instantiated with the provided configuration: %s',
  'E_INVALID_TURN_RUNNER_CONFIG',
  529,
  true
)

/**
 * Thrown by {@link @nhtio/adk!TurnRunner} when the {@link @nhtio/adk!TurnContext} supplied to `run` fails schema
 * validation.
 *
 * @remarks
 * Marked fatal — an invalid context indicates a programming error in the caller, not a
 * recoverable runtime condition. Thrown synchronously out of `run()` before `turnStart` is
 * emitted.
 *
 * @group Turn Input Validation
 */
export const E_INVALID_TURN_CONTEXT = createException(
  'E_INVALID_TURN_CONTEXT',
  'The turn runner received an invalid context object.',
  'E_INVALID_TURN_CONTEXT',
  529,
  true
)

/**
 * Emitted (via the `error` event) when a non-abort error propagates out of the input
 * middleware pipeline during {@link @nhtio/adk!TurnRunner.run}.
 *
 * @remarks
 * Not fatal — the turn runner emits this on the `error` event rather than throwing, so
 * registered listeners can handle or log the failure without crashing the pipeline. Dispatch
 * and output middleware are skipped; `turnEnd` still fires.
 *
 * @group Pipelines
 */
export const E_INPUT_PIPELINE_ERROR = createException(
  'E_INPUT_PIPELINE_ERROR',
  'An error occurred in the input pipeline.',
  'E_INPUT_PIPELINE_ERROR',
  500,
  false
)

/**
 * Emitted (via the `error` event) when a non-abort error propagates out of the output
 * middleware pipeline during {@link @nhtio/adk!TurnRunner.run}.
 *
 * @remarks
 * Not fatal — the turn runner emits this on the `error` event rather than throwing, so
 * registered listeners can handle or log the failure without crashing the pipeline. `turnEnd`
 * still fires.
 *
 * @group Pipelines
 */
export const E_OUTPUT_PIPELINE_ERROR = createException(
  'E_OUTPUT_PIPELINE_ERROR',
  'An error occurred in the output pipeline.',
  'E_OUTPUT_PIPELINE_ERROR',
  500,
  false
)

/**
 * Emitted (via the `error` event) when a middleware pipeline resolves without reaching its
 * terminal handler and without the turn being aborted. Indicates that some middleware
 * returned without calling `next` and without signalling a deliberate refusal via the turn's
 * abort controller.
 *
 * @remarks
 * Not fatal — the runner emits this on the `error` event so the failure is observable, then
 * proceeds to short-circuit the remainder of the turn the same way any other pipeline error
 * would. The constructor takes a single positional argument identifying the pipeline that
 * short-circuited: one of `'turn-input'`, `'turn-output'`, `'dispatch-input'`, or `'dispatch-output'`.
 *
 * Deliberate refusals should call `ctx.abort(reason)`, which sets the `'aborted'` outcome
 * instead of emitting this error.
 *
 * @warning
 * This is a **detection condition**, not a thrown exception. The runner constructs and emits
 * the code itself when it detects a missing `next()` on the unwind — nothing in user code
 * throws it. Upstream post-steps still run normally.
 *
 * @example
 * ```ts
 * throw new E_PIPELINE_SHORT_CIRCUITED(['turn-input'])
 * ```
 *
 * @group Pipelines
 */
export const E_PIPELINE_SHORT_CIRCUITED = createException<[string]>(
  'E_PIPELINE_SHORT_CIRCUITED',
  "The '%s' middleware pipeline short-circuited without calling next or aborting the turn.",
  'E_PIPELINE_SHORT_CIRCUITED',
  500,
  false
)

/**
 * Thrown when a registry is initialised with a value that is defined but not a plain object.
 *
 * @remarks
 * Registries expect either `undefined` (empty start) or a plain object as their initial value.
 * Passing a primitive, array, class instance, or other non-object signals a programming error
 * in the caller.
 *
 * @group Primitive Validation
 */
export const E_INVALID_INITIAL_REGISTRY_VALUE = createException(
  'E_INVALID_INITIAL_REGISTRY_VALUE',
  'Attempted to initialize a registry with a defined non-object value.',
  'E_INVALID_INITIAL_REGISTRY_VALUE',
  500,
  true
)

/**
 * Thrown when a {@link @nhtio/adk!Memory} is initialised with a value that fails schema validation.
 *
 * @remarks
 * `Memory` requires all fields — `id`, `content`, `confidence`, `importance`, `createdAt`,
 * `updatedAt` — to be present and of the correct type. Passing an incomplete or incorrectly
 * typed object signals a programming error in the caller, not a recoverable runtime condition.
 *
 * @group Primitive Validation
 */
export const E_INVALID_INITIAL_MEMORY_VALUE = createException(
  'E_INVALID_INITIAL_MEMORY_VALUE',
  'Attempted to initialize a memory with an invalid value.',
  'E_INVALID_INITIAL_MEMORY_VALUE',
  500,
  true
)

/**
 * Thrown when a {@link @nhtio/adk!Retrievable} is initialised with a value that fails schema validation.
 *
 * @remarks
 * `Retrievable` requires `id`, `content`, `trustTier`, `createdAt`, and `updatedAt` to be present
 * and of the correct type, and `trustTier` must be one of `'first-party'`, `'third-party-public'`,
 * or `'third-party-private'`. The `trustTier` decision must be made consciously by the retrieval
 * middleware at construction time — there is no default. Passing an incomplete or incorrectly
 * typed object signals a programming error in the caller, not a recoverable runtime condition.
 *
 * @group Primitive Validation
 */
export const E_INVALID_INITIAL_RETRIEVABLE_VALUE = createException(
  'E_INVALID_INITIAL_RETRIEVABLE_VALUE',
  'Invalid initial value supplied to Retrievable constructor.',
  'E_INVALID_INITIAL_RETRIEVABLE_VALUE',
  500,
  true
)

/**
 * Thrown when a {@link @nhtio/adk!Message} is initialised with a value that fails schema validation.
 *
 * @remarks
 * `Message` requires `id`, `role` (`user` or `assistant`), `content`, `createdAt`, and
 * `updatedAt` to be present and of the correct type. Passing an incomplete or incorrectly
 * typed object signals a programming error in the caller, not a recoverable runtime condition.
 *
 * @group Primitive Validation
 */
export const E_INVALID_INITIAL_MESSAGE_VALUE = createException(
  'E_INVALID_INITIAL_MESSAGE_VALUE',
  'Attempted to initialize a message with an invalid value.',
  'E_INVALID_INITIAL_MESSAGE_VALUE',
  500,
  true
)

/**
 * Thrown when an {@link @nhtio/adk!Identity} is initialised with a value that fails schema validation.
 *
 * @remarks
 * `Identity` requires both `identifier` (string or number) and `representation` (string or
 * {@link @nhtio/adk!Tokenizable}) to be present and of the correct type. Passing an incomplete or
 * incorrectly typed object signals a programming error in the caller.
 *
 * @group Primitive Validation
 */
export const E_INVALID_INITIAL_IDENTITY_VALUE = createException(
  'E_INVALID_INITIAL_IDENTITY_VALUE',
  'Attempted to initialize an identity with an invalid value.',
  'E_INVALID_INITIAL_IDENTITY_VALUE',
  500,
  true
)

/**
 * Thrown when a {@link @nhtio/adk!Thought} is initialised with a value that fails schema validation.
 *
 * @remarks
 * `Thought` requires `id`, `content`, `createdAt`, and `updatedAt` to be present and of the
 * correct type. Passing an incomplete or incorrectly typed object signals a programming error
 * in the caller, not a recoverable runtime condition.
 *
 * @group Primitive Validation
 */
export const E_INVALID_INITIAL_THOUGHT_VALUE = createException(
  'E_INVALID_INITIAL_THOUGHT_VALUE',
  'Attempted to initialize a thought with an invalid value.',
  'E_INVALID_INITIAL_THOUGHT_VALUE',
  500,
  true
)

/**
 * Thrown when a {@link @nhtio/adk!TurnGate} is constructed with a value that fails schema validation.
 *
 * @remarks
 * Fatal — bad construction arguments indicate a programming error in the caller.
 *
 * @group Gates
 */
export const E_INVALID_INITIAL_TURN_GATE_VALUE = createException(
  'E_INVALID_INITIAL_TURN_GATE_VALUE',
  'Attempted to initialize a turn gate with an invalid value.',
  'E_INVALID_INITIAL_TURN_GATE_VALUE',
  500,
  true
)

/**
 * Thrown synchronously in the caller's context when {@link @nhtio/adk!TurnGate.resolve} is called with a
 * value that fails the gate's schema.
 *
 * @remarks
 * Fatal — passing the wrong type to `resolve()` is a programming error. The internal promise is
 * NOT settled when this is thrown; the gate remains open.
 *
 * @group Gates
 */
export const E_INVALID_TURN_GATE_RESOLUTION = createException(
  'E_INVALID_TURN_GATE_RESOLUTION',
  'The value supplied to TurnGate.resolve() failed schema validation.',
  'E_INVALID_TURN_GATE_RESOLUTION',
  500,
  true
)

/**
 * Thrown (as a rejection reason) when a {@link @nhtio/adk!TurnGate} times out before being resolved.
 *
 * @remarks
 * Not fatal — a timeout is a recoverable runtime condition; the caller may retry or surface it
 * to the user.
 *
 * @warning
 * A timeout does **not** cancel the external event or clear any remote queue. The gate closes
 * locally, but whatever external system was expected to call `gate.resolve()` may still fire
 * later. Orphaned external state must be handled by the caller.
 *
 * @group Gates
 */
export const E_TURN_GATE_TIMEOUT = createException(
  'E_TURN_GATE_TIMEOUT',
  'The turn gate timed out before being resolved.',
  'E_TURN_GATE_TIMEOUT',
  408,
  false
)

/**
 * Thrown (as a rejection reason) when a {@link @nhtio/adk!TurnGate} is aborted — either because the turn's
 * `AbortSignal` fired or because {@link @nhtio/adk!TurnGate.abort} was called directly.
 *
 * @remarks
 * Not fatal — abort is an intentional cancellation, not an error in the caller.
 *
 * @group Gates
 */
export const E_TURN_GATE_ABORTED = createException(
  'E_TURN_GATE_ABORTED',
  'The turn gate was aborted before being resolved.',
  'E_TURN_GATE_ABORTED',
  499,
  false
)

/**
 * Thrown when a {@link @nhtio/adk!SpooledArtifact} is constructed with a value that does not implement the
 * {@link @nhtio/adk!SpoolReader} interface.
 *
 * @remarks
 * Validated at construction time via {@link @nhtio/adk!implementsSpoolReader}. Passing anything that lacks
 * `line`, `byteLength`, or `lineCount` as callable functions signals a programming error in the
 * caller.
 *
 * @group Artifacts
 */
export const E_NOT_A_SPOOL_READER = createException(
  'E_NOT_A_SPOOL_READER',
  'The provided value does not implement the SpoolReader interface.',
  'E_NOT_A_SPOOL_READER',
  500,
  true
)

/**
 * Thrown when a Media is constructed with a value that does not implement the MediaReader
 * interface.
 *
 * @remarks
 * Validated at construction time. Passing anything that lacks `stream` or `byteLength` as
 * callable functions signals a programming error in the caller.
 *
 * @group Artifacts
 */
export const E_NOT_A_MEDIA_READER = createException(
  'E_NOT_A_MEDIA_READER',
  'The provided value does not implement the MediaReader interface.',
  'E_NOT_A_MEDIA_READER',
  500,
  true
)

/**
 * Thrown when a Media is initialised with a value that fails schema validation.
 *
 * @remarks
 * Fatal — bad construction arguments indicate a programming error in the caller.
 *
 * @group Artifacts
 */
export const E_INVALID_INITIAL_MEDIA_VALUE = createException(
  'E_INVALID_INITIAL_MEDIA_VALUE',
  'Attempted to initialize a media with an invalid value.',
  'E_INVALID_INITIAL_MEDIA_VALUE',
  500,
  true
)

/**
 * Thrown when a {@link @nhtio/adk!ToolCall} is initialised with a value that fails schema validation.
 *
 * @remarks
 * `ToolCall` requires `id`, `tool`, `args`, `checksum`, `isComplete`, `isError`, `createdAt`,
 * and `updatedAt` to be present and of the correct type. Passing an incomplete or incorrectly
 * typed object signals a programming error in the caller, not a recoverable runtime condition.
 *
 * @group Primitive Validation
 */
export const E_INVALID_INITIAL_TOOL_CALL_VALUE = createException(
  'E_INVALID_INITIAL_TOOL_CALL_VALUE',
  'Attempted to initialize a tool call with an invalid value.',
  'E_INVALID_INITIAL_TOOL_CALL_VALUE',
  500,
  true
)

/**
 * Thrown when a {@link @nhtio/adk!Tool} is constructed with a value that fails schema validation.
 *
 * @remarks
 * Fatal — bad construction arguments indicate a programming error in the caller.
 *
 * @group Tools
 */
export const E_INVALID_INITIAL_TOOL_VALUE = createException(
  'E_INVALID_INITIAL_TOOL_VALUE',
  'Attempted to initialize a tool with an invalid value.',
  'E_INVALID_INITIAL_TOOL_VALUE',
  500,
  true
)

/**
 * Thrown synchronously when {@link @nhtio/adk!Tool.validate} is called with arguments that fail the tool's
 * input schema.
 *
 * @remarks
 * Not fatal — an arg validation failure in the tool call loop is a caller mistake that can be
 * surfaced as an error response. The tool handler is NOT called when this is thrown.
 *
 * @group Tools
 */
export const E_INVALID_TOOL_ARGS = createException(
  'E_INVALID_TOOL_ARGS',
  'The arguments supplied to the tool failed input schema validation.',
  'E_INVALID_TOOL_ARGS',
  422,
  false
)

/**
 * Thrown (as a rejection reason) when a {@link @nhtio/adk!Tool}'s handler throws during execution.
 *
 * @remarks
 * Not fatal — a downstream tool failure is a recoverable runtime condition. The tool call loop
 * catches this error specifically to report the failure back to the model rather than crashing
 * the pipeline.
 *
 * @group Tools
 */
export const E_TOOL_DOWNSTREAM_ERROR = createException(
  'E_TOOL_DOWNSTREAM_ERROR',
  'The tool handler threw an error during execution.',
  'E_TOOL_DOWNSTREAM_ERROR',
  500,
  false
)

/**
 * Thrown when {@link @nhtio/adk!ToolRegistry.register} is called for a tool name that is already registered
 * and `overwrite` is not `true`.
 *
 * @remarks
 * Fatal — accidentally overwriting a registered tool indicates a programming error. Pass
 * `overwrite: true` to replace an existing tool intentionally.
 *
 * @group Tools
 */
export const E_TOOL_ALREADY_REGISTERED = createException(
  'E_TOOL_ALREADY_REGISTERED',
  'A tool with this name is already registered. Pass overwrite: true to replace it.',
  'E_TOOL_ALREADY_REGISTERED',
  409,
  true
)

/**
 * Thrown when {@link @nhtio/adk!DispatchContext} is constructed with a value that fails schema validation.
 *
 * @remarks
 * Fatal — bad construction arguments indicate a programming error in the caller.
 *
 * @group Dispatch
 */
export const E_INVALID_LLM_EXECUTION_CONTEXT = createException(
  'E_INVALID_LLM_EXECUTION_CONTEXT',
  'The LLM execution context cannot be instantiated with the provided value.',
  'E_INVALID_LLM_EXECUTION_CONTEXT',
  529,
  true
)

/**
 * Thrown (as a rejection reason) when {@link @nhtio/adk!DispatchContext.waitFor} is called on a
 * standalone context that was constructed without a `waitFor` function.
 *
 * @remarks
 * Not fatal — the caller can catch this and handle the case where gate suspension is not
 * supported for this execution context.
 *
 * @group Dispatch
 */
export const E_LLM_EXECUTION_GATE_NOT_SUPPORTED = createException(
  'E_LLM_EXECUTION_GATE_NOT_SUPPORTED',
  'waitFor was called on a standalone DispatchContext with no gate function provided.',
  'E_LLM_EXECUTION_GATE_NOT_SUPPORTED',
  501,
  false
)

/**
 * Thrown when {@link @nhtio/adk!DispatchContext.ack} or {@link @nhtio/adk!DispatchContext.nack} is called on a
 * context that has already been signalled.
 *
 * @remarks
 * Fatal — signalling twice is a programming error in the caller. The first signal wins; the
 * second call is rejected loudly so callers cannot accidentally race between ack and nack.
 *
 * @danger
 * Signalling is **not** silently idempotent. The first `ack()` or `nack()` wins; the second
 * throws immediately. Guard with `if (!ctx.isSignalled)` when more than one seam may signal.
 *
 * @group Dispatch
 */
export const E_LLM_EXECUTION_ALREADY_SIGNALLED = createException(
  'E_LLM_EXECUTION_ALREADY_SIGNALLED',
  'ack() or nack() was called on an DispatchContext that has already been signalled.',
  'E_LLM_EXECUTION_ALREADY_SIGNALLED',
  500,
  true
)

/**
 * Thrown when {@link @nhtio/adk!DispatchRunner.dispatch} receives an input that fails schema validation.
 *
 * @remarks
 * Fatal — invalid dispatch input indicates a programming error in the caller.
 *
 * @group Dispatch
 */
export const E_INVALID_LLM_DISPATCH_INPUT = createException(
  'E_INVALID_LLM_DISPATCH_INPUT',
  'The LLM execution runner received an invalid dispatch input.',
  'E_INVALID_LLM_DISPATCH_INPUT',
  529,
  true
)

/**
 * Emitted (via the observability `error` hook) and re-thrown when a non-abort error propagates
 * out of the input or output middleware pipeline during {@link @nhtio/adk!DispatchRunner.dispatch}.
 *
 * @remarks
 * Not fatal — pipeline errors are recoverable runtime conditions. `dispatch()` rejects with this
 * exception so callers can handle the failure via try/catch. Both `dispatchInputPipeline` and
 * `dispatchOutputPipeline` share this one code — the runner does not split input vs. output at
 * this layer.
 *
 * @group Pipelines
 */
export const E_DISPATCH_PIPELINE_ERROR = createException(
  'E_DISPATCH_PIPELINE_ERROR',
  'An error occurred in an LLM execution pipeline.',
  'E_DISPATCH_PIPELINE_ERROR',
  500,
  false
)

/**
 * Emitted (via the observability `error` hook) and re-thrown when the user-supplied executor
 * callback throws during {@link @nhtio/adk!DispatchRunner.dispatch}.
 *
 * @remarks
 * Not fatal — executor errors are recoverable runtime conditions. `dispatch()` rejects with this
 * exception so callers can handle the failure via try/catch.
 *
 * @group Dispatch
 */
export const E_LLM_EXECUTION_EXECUTOR_ERROR = createException(
  'E_LLM_EXECUTION_EXECUTOR_ERROR',
  'The LLM execution executor callback threw an error.',
  'E_LLM_EXECUTION_EXECUTOR_ERROR',
  500,
  false
)

/**
 * Thrown when `encode()`-ing a reader-backed primitive ({@link @nhtio/adk!Media},
 * {@link @nhtio/adk!SpooledArtifact}) whose underlying reader cannot describe itself.
 *
 * @remarks
 * The encoder serialises reader-backed primitives as **handles**, not bytes: the reader emits a
 * `{ tag, locator }` descriptor (via its optional `describe()` method) and decode re-binds it through a
 * registered resolver. A reader with no `describe()` has no serialisable handle — there is nothing to
 * write down. The single printf argument names the offending field (e.g. `"reader"`).
 *
 * This is deliberately not silent: dropping the reader would yield a `Media`/`SpooledArtifact` that
 * decodes into a handle pointing at nothing. The framework refuses to fabricate that. The canonical
 * trigger is a `fromWebFile`-backed `Media` — a browser `Blob` is not re-openable across a
 * serialisation boundary, and the encoder is synchronous so it cannot drain the bytes inline. Re-wrap
 * the bytes in a describable reader (e.g. persist to a spool/media store) before encoding.
 *
 * Not fatal — an un-encodable value is a caller condition, not a runner failure.
 *
 * @group Primitive Validation
 */
export const E_READER_NOT_DESCRIBABLE = createException<[string]>(
  'E_READER_NOT_DESCRIBABLE',
  'Cannot encode this value: its %s reader does not implement describe(), so it has no serialisable handle. Back it with a describable reader (a spool/media store) before encoding.',
  'E_READER_NOT_DESCRIBABLE',
  422,
  false
)

/**
 * Thrown when `decode()`-ing a reader handle whose `tag` has no registered resolver.
 *
 * @remarks
 * A reader descriptor's `tag` (e.g. `"spool:flydrive"`, `"media:in-memory"`) names the resolver that
 * re-binds the handle to a live reader. In-memory and fetch resolvers auto-register when the
 * `@nhtio/adk/batteries/encoding` battery loads; durable-store resolvers (flydrive, OPFS) must be
 * registered by the consumer **with the live `Disk`/OPFS root** before decoding, because the locator
 * carries only the key — not the binding. The single printf argument is the unresolved `tag`.
 *
 * The fix is always the same: call `registerSpoolReaderResolver(tag, …)` /
 * `registerMediaReaderResolver(tag, …)` (re-exported from the encoding battery) at application startup,
 * supplying the same ambient store the bytes were written to.
 *
 * Not fatal — a missing resolver is a wiring condition the caller can correct and retry.
 *
 * @group Primitive Validation
 */
export const E_NO_READER_RESOLVER = createException<[string]>(
  'E_NO_READER_RESOLVER',
  'No reader resolver registered for tag "%s". Register one (with its live store binding) before decoding — see the @nhtio/adk/batteries/encoding battery.',
  'E_NO_READER_RESOLVER',
  422,
  false
)
