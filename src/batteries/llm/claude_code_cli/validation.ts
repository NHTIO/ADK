/**
 * Runtime validation schema and wrapper for Claude Code CLI adapter options.
 *
 * @module @nhtio/adk/batteries/llm/claude_code_cli/validation
 *
 * @remarks
 * Schema and call-site wrapper for validating `ClaudeCodeCliAdapterOptions`. Used at construction
 * time and at the start of every iteration against the merged options shape (stash > executor >
 * constructor). Throws `E_INVALID_CLAUDE_CODE_CLI_OPTIONS` on failure — same hard-fail policy as
 * every other ADK contract.
 *
 * Three invariants enforced here that have no equivalent in the other LLM batteries:
 * - `apiKey`/`authToken` are mutually exclusive AND at least one is required (`.xor`).
 * - `extraArgs` entries are validated against a strict six-flag allowlist, with per-flag value
 *   arity, and every value string is rejected if it starts with `-` — the fix for the `--betas`
 *   variadic-value injection hazard (a value string spelling another flag would otherwise reach
 *   the CLI's own argv parser as a distinct token).
 * - `process.platform` is checked at validation time: this battery is POSIX-only in v1 (reliable
 *   process-group control requires POSIX process groups), mirroring
 *   `src/batteries/sandbox/node/srt_enforcer.ts`'s own platform-boundary precedent.
 */

import { isError } from '@nhtio/adk/guards'
import { byteStoreSchema } from '@nhtio/adk/common'
import { validator, ValidationError } from '@nhtio/validation'
import { E_INVALID_CLAUDE_CODE_CLI_OPTIONS } from './exceptions'
import type { ClaudeCodeCliAdapterOptions } from './types'

// ─── Sub-schemas ──────────────────────────────────────────────────────────────

const bucketLabelSchema = validator
  .string()
  .valid('standingInstructions', 'memories', 'retrievables', 'timeline')

const bucketOrderSchema = validator
  .array()
  .items(bucketLabelSchema)
  .unique()
  .default(['standingInstructions', 'memories', 'retrievables', 'timeline'])

const unsupportedMediaPolicySchema = validator
  .alternatives(
    validator.string().valid('throw', 'fallback-stash', 'synthetic-description'),
    validator
      .object({
        mode: validator.string().valid('fallback-stash').required(),
        stashKeys: validator.array().items(validator.string().min(1)).required(),
      })
      .unknown(false)
  )
  .default('throw')

const helperSchema = validator.function()

const helpersSchema = validator
  .object({
    descriptionToChatCompletionsJsonSchema: helperSchema.optional(),
    renderUntrustedContent: helperSchema.optional(),
    renderTrustedContent: helperSchema.optional(),
    renderStandingInstructions: helperSchema.optional(),
    renderMemories: helperSchema.optional(),
    renderRetrievables: helperSchema.optional(),
    renderRetrievableHandleBody: helperSchema.optional(),
    renderRetrievableSafetyDirective: helperSchema.optional(),
    renderFirstPartyRetrievables: helperSchema.optional(),
    renderThirdPartyPublicRetrievables: helperSchema.optional(),
    renderThirdPartyPrivateRetrievables: helperSchema.optional(),
    renderThought: helperSchema.optional(),
    filterThoughts: helperSchema.optional(),
    toolsToChatCompletionsTools: helperSchema.optional(),
    renderChatCompletionsSystemPrompt: helperSchema.optional(),
    renderClaudeCodeCliTimelineMessage: helperSchema.optional(),
    renderClaudeCodeCliToolCallResult: helperSchema.optional(),
    buildClaudeCodeCliPrompt: helperSchema.optional(),
  })
  .unknown(false)

// `extraArgs`: a structured allowlist, not a flat string[]. Every value string, in every
// position, is rejected if it starts with `-` — the fix for the --betas injection hazard.
const NOT_A_FLAG_RE = /^(?!-).+$/

const singleValueSchema = validator.string().min(1).pattern(NOT_A_FLAG_RE)
const multiValueSchema = validator
  .array()
  .items(validator.string().min(1).pattern(NOT_A_FLAG_RE))
  .min(1)

const extraArgSchema = validator
  .alternatives(
    // --betas is the only flag accepting a string[] value.
    validator
      .object({
        flag: validator.string().valid('--betas').required(),
        value: multiValueSchema.required(),
      })
      .unknown(false),
    // --prompt-suggestions is the only flag with an OPTIONAL value.
    validator
      .object({
        flag: validator.string().valid('--prompt-suggestions').required(),
        value: singleValueSchema.optional(),
      })
      .unknown(false),
    // Every remaining allowlisted flag requires a single non-empty, non-flag-shaped string value.
    validator
      .object({
        flag: validator.string().valid('--effort', '--agent', '--json-schema', '--name').required(),
        value: singleValueSchema.required(),
      })
      .unknown(false)
  )
  .required()

const extraArgsSchema = validator.array().items(extraArgSchema).optional()

// ─── Top-level schema ─────────────────────────────────────────────────────────

/**
 * Validator schema for `ClaudeCodeCliAdapterOptions`. Used by `validateOptions` at construction
 * time and again at the start of every iteration after options have been merged (stash > executor
 * > constructor). Rejects unknown top-level keys so typos fail loud.
 */
export const claudeCodeCliOptionsSchema = validator
  .object<ClaudeCodeCliAdapterOptions>({
    // ADK control
    execa: validator.function().optional(),
    wrapperPath: validator.string().optional(),
    claudeBin: validator.string().default('claude'),
    appendSystemPrompt: validator.string().optional(),
    apiKey: validator.string().optional(),
    authToken: validator.string().optional(),
    baseURL: validator.string().optional(),
    cwd: validator.string().optional(),
    addDir: validator.array().items(validator.string().min(1)).optional(),
    disallowedTools: validator.array().items(validator.string().min(1)).default([]),
    maxTurns: validator.number().integer().min(1).optional(),
    maxBudgetUsd: validator.number().min(0).optional(),
    fallbackModel: validator.array().items(validator.string().min(1)).optional(),
    selfIdentity: validator.string().min(1).default('assistant'),
    autoAck: validator.boolean().default(false),
    forwardSubagentText: validator.boolean().default(false),
    bucketOrder: bucketOrderSchema,
    thoughtSurfacing: validator
      .string()
      .valid('all-self', 'latest-self', 'all')
      .default('all-self'),
    replayCompatibility: validator.array().items(validator.string().min(1)).default([]),
    helpers: helpersSchema.optional(),
    spoolStore: byteStoreSchema.optional(),
    unsupportedMediaPolicy: unsupportedMediaPolicySchema,
    unsupportedResultMediaPolicy: unsupportedMediaPolicySchema,
    extraArgs: extraArgsSchema,

    // CLI-native safety caps / timeouts
    streamIdleTimeoutMs: validator.number().integer().min(0).default(60_000),
    startupTimeoutMs: validator.number().integer().min(0).default(45_000),
    disposeGraceMs: validator.number().integer().min(0).default(2_000),
    mcpToolIdleTimeoutMs: validator.number().integer().min(0).optional(),
    disableTelemetry: validator.boolean().optional(),
    disableErrorReporting: validator.boolean().optional(),
    disableNonessentialTraffic: validator.boolean().optional(),

    // Required
    model: validator.string().required(),
  })
  .unknown(false)
  // Exactly one of apiKey/authToken must be set.
  .xor('apiKey', 'authToken')
  // POSIX-only in v1: reliable process-group control requires POSIX process groups, mirroring
  // src/batteries/sandbox/node/srt_enforcer.ts's own platform-boundary precedent — refuse rather
  // than silently degrade.
  .custom((value, helpers) => {
    // POSIX-only in v1: reliable process-group control requires process.kill(-pid, signal),
    // which has no Windows equivalent — refuse rather than silently degrade, mirroring
    // src/batteries/sandbox/node/srt_enforcer.ts's own platform-boundary precedent.
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      return helpers.error('any.invalid')
    }
    return value
  })

const isValidationError = (value: unknown): value is ValidationError =>
  isError(value) && Array.isArray((value as ValidationError).details)

const formatValidationDetails = (err: ValidationError): string =>
  err.details.map((d) => d.message).join(' and ')

/**
 * Validates an arbitrary input against `claudeCodeCliOptionsSchema` and returns the resolved
 * options shape. Throws `E_INVALID_CLAUDE_CODE_CLI_OPTIONS` (carrying the validator's error
 * report on `cause`) on failure.
 *
 * @param input - The raw options object to validate.
 * @returns The resolved options object with defaults filled in.
 */
export const validateOptions = (input: unknown): ClaudeCodeCliAdapterOptions => {
  const { value, error } = claudeCodeCliOptionsSchema.validate(input, {
    abortEarly: false,
    convert: false,
  })
  if (error) {
    throw new E_INVALID_CLAUDE_CODE_CLI_OPTIONS([formatValidationDetails(error)], { cause: error })
  }
  return value as ClaudeCodeCliAdapterOptions
}

// suppress unused import warning when the alias isn't referenced
void isValidationError
