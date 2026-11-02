/**
 * @module @nhtio/adk/eslint/rules
 *
 * Barrel of the individual `@nhtio/adk` ESLint rule objects. Most consumers want the assembled
 * plugin from `@nhtio/adk/eslint` instead; import individual rules from here only when composing a
 * bespoke plugin or testing a single rule.
 *
 * @remarks
 * It also exports the import-binding helpers every name-matching rule resolves a callee through, so
 * the battery-scoped lint plugins can share one resolver instead of keeping private copies: a
 * battery may only reach this package through public subpaths, and this one publishes them.
 */

export { default as requireValidatorAnyRequired } from './require_validator_any_required'
export { default as noModelInToolHandler } from './no_model_in_tool_handler'
export { default as thoughtPayloadRequiresReplayTag } from './thought_payload_requires_replay_tag'
export { default as tokenEncodingRequiresContextWindow } from './token_encoding_requires_context_window'
export { default as artifactToolForbidsArtifactConstructor } from './artifact_tool_forbids_artifact_constructor'
export { default as toolNameProviderSafe } from './tool_name_provider_safe'
export { default as createExceptionArgsArray } from './create_exception_args_array'

/**
 * Collects a file's import bindings (see {@link collectImportBindings} in `./common`).
 *
 * @remarks
 * A rule calls this once from its `Program()` visitor and hands the result to
 * {@link resolveCalleeName} for each callee it inspects.
 */
export { collectImportBindings, resolveCalleeName } from './common'
export type { ImportBindings, ResolvedCalleeName } from './common'
