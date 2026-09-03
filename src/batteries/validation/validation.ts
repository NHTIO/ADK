/**
 * Runtime validation for ordering guard options.
 *
 * @module @nhtio/adk/batteries/validation/validation
 *
 * @remarks
 * This validates the public, declarative rule shape before middleware resolution. Profile names are
 * deliberately accepted alongside profile objects so consumers can extend the built-in catalog.
 */

import { validator } from '@nhtio/validation'
import { E_INVALID_ORDERING_GUARD_OPTIONS } from './exceptions'
import type { OrderingGuardOptions } from './types'

const primitiveKindSchema = validator.string().valid('message', 'thought', 'toolCall')
const roleSchema = validator.string().valid('user', 'assistant')

const orderRuleSchema = validator
  .object({
    type: validator.string().valid('order').required(),
    id: validator.string().required(),
    before: primitiveKindSchema.required(),
    after: primitiveKindSchema.required(),
    scope: validator.string().valid('adjacent-same-role-group', 'entire-turn').required(),
    onlyLatestGroup: validator.boolean().optional(),
    // Optional; absent means `advisory` for EVERY rule type. See OrderRule.severity.
    severity: validator.string().valid('blocking', 'advisory').optional(),
  })
  .unknown(false)

const requiredMetadataRuleSchema = validator
  .object({
    type: validator.string().valid('requiredMetadata').required(),
    id: validator.string().required(),
    kind: primitiveKindSchema.required(),
    applyTo: validator.string().valid('first-in-group', 'every').required(),
    requiredPayloadKey: validator.string().required(),
    severity: validator.string().valid('blocking', 'advisory').optional(),
    gatedByReplayCompatibility: validator.array().items(validator.string()).optional(),
    fallbackPayloadValue: validator.any().optional(),
    fallbackReplayCompatibility: validator.string().optional(),
    fallbackRepairAuthorized: validator.boolean().optional(),
  })
  .unknown(false)

const alternationRuleSchema = validator
  .object({
    type: validator.string().valid('alternation').required(),
    id: validator.string().required(),
    roles: validator.array().items(roleSchema).required(),
    mode: validator.string().valid('strict').required(),
    maxPerGroup: validator.number().integer().min(0).optional(),
    // Optional; absent means `advisory` for EVERY rule type. See OrderRule.severity.
    severity: validator.string().valid('blocking', 'advisory').optional(),
  })
  .unknown(false)

const adjacencyRuleSchema = validator
  .object({
    type: validator.string().valid('adjacency').required(),
    id: validator.string().required(),
    first: primitiveKindSchema.required(),
    disallowBetween: validator.array().items(primitiveKindSchema).required(),
    // Optional; absent means `advisory` for EVERY rule type. See OrderRule.severity.
    severity: validator.string().valid('blocking', 'advisory').optional(),
  })
  .unknown(false)

const preservationRuleSchema = validator
  .object({
    type: validator.string().valid('preservation').required(),
    id: validator.string().required(),
    kind: primitiveKindSchema.required(),
    invariant: validator
      .string()
      .valid('count-non-decreasing', 'payload-field-stable', 'pruned-after-latest-turn')
      .required(),
    payloadField: validator.string().optional(),
    resetOnModelSwitch: validator.boolean().optional(),
    // Optional; absent means `advisory` for EVERY rule type. See OrderRule.severity.
    severity: validator.string().valid('blocking', 'advisory').optional(),
  })
  .unknown(false)

const roleRemapRuleSchema = validator
  .object({
    type: validator.string().valid('roleRemap').required(),
    id: validator.string().required(),
    kind: primitiveKindSchema.required(),
    variant: validator.string().required(),
    expectedRoleTag: validator.string().required(),
    // Optional; absent means `advisory`. See RoleRemapRule.severity — the tag is a
    // consumer-supplied payload field, so blocking is opt-in rather than the default.
    severity: validator.string().valid('blocking', 'advisory').optional(),
  })
  .unknown(false)

const identifierFormatRuleSchema = validator
  .object({
    type: validator.string().valid('identifierFormat').required(),
    id: validator.string().required(),
    kind: primitiveKindSchema.required(),
    maxLength: validator.number().integer().positive().optional(),
    allowedPattern: validator.string().optional(),
    severity: validator.string().valid('blocking', 'advisory').optional(),
  })
  .unknown(false)

const nonEmptyTurnRuleSchema = validator
  .object({
    type: validator.string().valid('nonEmptyTurn').required(),
    id: validator.string().required(),
    role: validator.string().valid('assistant', 'user').required(),
    onlyTerminal: validator.boolean().optional(),
    severity: validator.string().valid('blocking', 'advisory').optional(),
  })
  .unknown(false)

const toolIdentityRuleSchema = validator
  .object({
    type: validator.string().valid('toolIdentity').required(),
    id: validator.string().required(),
    severity: validator.string().valid('blocking', 'advisory').optional(),
  })
  .unknown(false)

const schemaIntegrityRuleSchema = validator
  .object({
    type: validator.string().valid('schemaIntegrity').required(),
    id: validator.string().required(),
    severity: validator.string().valid('blocking', 'advisory').optional(),
  })
  .unknown(false)

const staleContentAdvisoryRuleSchema = validator
  .object({
    type: validator.string().valid('staleContentAdvisory').required(),
    id: validator.string().required(),
    kind: primitiveKindSchema.required(),
    scope: validator.string().valid('before-latest-user-turn').required(),
    optOutOptionKey: validator.string().required(),
  })
  .unknown(false)

const orderingRuleSchema = validator.alternatives(
  orderRuleSchema,
  requiredMetadataRuleSchema,
  alternationRuleSchema,
  adjacencyRuleSchema,
  preservationRuleSchema,
  roleRemapRuleSchema,
  staleContentAdvisoryRuleSchema,
  identifierFormatRuleSchema,
  nonEmptyTurnRuleSchema,
  toolIdentityRuleSchema,
  schemaIntegrityRuleSchema
)

const orderingProfileSchema = validator
  .object({
    name: validator.string().required(),
    description: validator.string().required(),
    permissive: validator.boolean().optional(),
    rules: validator.array().items(orderingRuleSchema).required(),
  })
  .unknown(false)

const orderingGuardOptionsSchema = validator
  .object({
    profiles: validator
      .array()
      .items(validator.alternatives(validator.string(), orderingProfileSchema))
      .min(1)
      .required(),
    mode: validator.string().valid('union-of-rules', 'each', 'first-match').optional(),
    action: validator.string().valid('enforce', 'mutate').optional(),
    onRepair: validator.string().valid('log', 'silent').optional(),
    onViolation: validator.string().valid('nack', 'throw').optional(),
    snapshotStashKey: validator.string().optional(),
    disableAdvisoryRuleIds: validator.array().items(validator.string()).optional(),
    allowMetadataFallbackRepair: validator.boolean().optional(),
  })
  .unknown(false)

/**
 * Validates and returns ordering guard options.
 *
 * @param options - Candidate guard options.
 * @returns The validated options, preserving the caller's values.
 * @throws E_INVALID_ORDERING_GUARD_OPTIONS when the declarative shape is invalid.
 */
export const validateOptions = (options: OrderingGuardOptions): OrderingGuardOptions => {
  const { value, error } = orderingGuardOptionsSchema.validate(options, {
    abortEarly: false,
    convert: false,
  })
  if (error) {
    const detail = error.details.map((entry) => entry.message).join(' and ')
    throw new E_INVALID_ORDERING_GUARD_OPTIONS([detail], { cause: error })
  }
  return value as OrderingGuardOptions
}
