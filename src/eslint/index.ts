/**
 * @module @nhtio/adk/eslint
 *
 * The `@nhtio/adk` ESLint plugin: machine-checkable enforcement of the harness contracts that
 * implementors of bring-your-own batteries, tools, and primitives are most likely to get wrong.
 *
 * @remarks
 * These rules turn documented footguns into lint errors. They are report-only (no autofix) — each
 * names the contract it enforces and the fix; carve out a deliberate exception with an inline
 * `// eslint-disable-next-line adk/<rule> -- <reason>` comment.
 *
 * `@typescript-eslint/utils` and `eslint` are OPTIONAL peer dependencies of `@nhtio/adk` — installed
 * only by consumers who lint with this plugin. The main library never imports this module.
 *
 * @example Flat config
 * ```ts
 * import adk from '@nhtio/adk/eslint'
 *
 * export default [
 *   { plugins: { adk: adk.plugin }, rules: adk.configs.recommended.rules },
 * ]
 * ```
 */

import { default as noModelInToolHandler } from './rules/no_model_in_tool_handler'
import { default as requireValidatorAnyRequired } from './rules/require_validator_any_required'
import { default as requireStringEmptyDisposition } from './rules/require_string_empty_disposition'
import { default as thoughtPayloadRequiresReplayTag } from './rules/thought_payload_requires_replay_tag'
import { default as tokenEncodingRequiresContextWindow } from './rules/token_encoding_requires_context_window'
import { default as artifactToolForbidsArtifactConstructor } from './rules/artifact_tool_forbids_artifact_constructor'
import type { FlatConfig } from '@typescript-eslint/utils/ts-eslint'

/**
 * Map of rule id (without the `adk/` plugin prefix) to its rule object. Registered on the plugin as
 * `rules`, so configs reference them as `adk/<id>`.
 */
export const rules = {
  'require-validator-any-required': requireValidatorAnyRequired,
  'require-string-empty-disposition': requireStringEmptyDisposition,
  'no-model-in-tool-handler': noModelInToolHandler,
  'thought-payload-requires-replay-tag': thoughtPayloadRequiresReplayTag,
  'token-encoding-requires-context-window': tokenEncodingRequiresContextWindow,
  'artifact-tool-forbids-artifact-constructor': artifactToolForbidsArtifactConstructor,
} satisfies FlatConfig.Plugin['rules']

/**
 * The ESLint plugin object. Register under the `adk` namespace: `plugins: { adk: plugin }`.
 */
export const plugin: FlatConfig.Plugin = {
  meta: { name: '@nhtio/adk/eslint', version: __VERSION__ },
  rules,
}

/** Every rule enabled at `error`, keyed `adk/<id>` (assumes the plugin is registered as `adk`). */
const recommendedRules: NonNullable<FlatConfig.Config['rules']> = Object.fromEntries(
  Object.keys(rules).map((id) => [`adk/${id}`, 'error'])
)

/**
 * Named config presets. `recommended` enables every rule at `error` and registers the plugin under
 * the `adk` namespace — spread it into a flat config to adopt the full set.
 */
export const configs = {
  recommended: {
    name: '@nhtio/adk/eslint/recommended',
    plugins: { adk: plugin },
    rules: recommendedRules,
  } satisfies FlatConfig.Config,
}

/**
 * Default export bundles the plugin and its config presets, mirroring the shape ESLint flat configs
 * expect from a plugin module.
 */
export default { plugin, rules, configs }
