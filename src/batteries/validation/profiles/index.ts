/**
 * Registry of atomic ordering behaviors; family names belong in `families.ts`, not here.
 */
import { permissive } from './permissive'
import { toolIdentity } from './tool_identity'
import { nonEmptyTurn } from './non_empty_turn'
import { schemaIntegrity } from './schema_integrity'
import { toolCallIdFormat } from './tool_call_id_format'
import { strictAlternation } from './strict_alternation'
import { E_UNKNOWN_ORDERING_PROFILE } from '../exceptions'
import { openaiShapeBaseline } from './openai_shape_baseline'
import { toolCallIdUniqueness } from './tool_call_id_uniqueness'
import { staleThinkingAdvisory } from './stale_thinking_advisory'
import { thinkingBeforeToolUse } from './thinking_before_tool_use'
import { singleToolCallPerTurn } from './single_tool_call_per_turn'
import { fullHistoryPreservation } from './full_history_preservation'
import { thoughtSignatureRequired } from './thought_signature_required'
import { thoughtSignatureAdvisory } from './thought_signature_advisory'
import { payloadFieldPreservation } from './payload_field_preservation'
import { roleRemapSplitToolRoles } from './role_remap_split_tool_roles'
import { roleRemapInlineToolCall } from './role_remap_inline_tool_call'
import { harmonyCommentaryChannel } from './harmony_commentary_channel'
import { functionResponseAdjacency } from './function_response_adjacency'
import { converseTextBeforeToolUse } from './converse_text_before_tool_use'
import { reasoningPrunedAfterLatestTurn } from './reasoning_pruned_after_latest_turn'
import type { OrderingProfile, OrderingPrimitiveKind } from '../types'

export {
  fullHistoryPreservation,
  payloadFieldPreservation,
  nonEmptyTurn,
  toolCallIdFormat,
  toolCallIdUniqueness,
  roleRemapSplitToolRoles,
  roleRemapInlineToolCall,
}

export type OrderingProfileFactory = (...args: never[]) => OrderingProfile
export type RegisteredOrderingProfile = OrderingProfile | OrderingProfileFactory

/** The names are deliberately the behavior/file names used by family recipes. */
export const ORDERING_PROFILES: Readonly<Record<string, RegisteredOrderingProfile>> = {
  permissive,
  openai_shape_baseline: openaiShapeBaseline,
  strict_alternation: strictAlternation,
  single_tool_call_per_turn: singleToolCallPerTurn,
  thinking_before_tool_use: thinkingBeforeToolUse,
  thought_signature_required: thoughtSignatureRequired,
  thought_signature_advisory: thoughtSignatureAdvisory,
  function_response_adjacency: functionResponseAdjacency,
  full_history_preservation: fullHistoryPreservation as unknown as OrderingProfileFactory,
  payload_field_preservation: payloadFieldPreservation as unknown as OrderingProfileFactory,
  reasoning_pruned_after_latest_turn: reasoningPrunedAfterLatestTurn,
  stale_thinking_advisory: staleThinkingAdvisory,
  role_remap_split_tool_roles: roleRemapSplitToolRoles as unknown as OrderingProfileFactory,
  role_remap_inline_tool_call: roleRemapInlineToolCall as unknown as OrderingProfileFactory,
  harmony_commentary_channel: harmonyCommentaryChannel,
  converse_text_before_tool_use: converseTextBeforeToolUse,
  // MEASURED rules — added from live vendor behaviour rather than vendor documentation. The first
  // two catch the SILENT failure class: a provider answering 200 with nothing, or with a field
  // quietly missing. See each profile's remarks for the evidence.
  tool_identity: toolIdentity,
  schema_integrity: schemaIntegrity,
  non_empty_turn: nonEmptyTurn as unknown as OrderingProfileFactory,
  tool_call_id_format: toolCallIdFormat as unknown as OrderingProfileFactory,
  tool_call_id_uniqueness: toolCallIdUniqueness,
}

/** Resolves a non-parameterized behavior by its registry name. */
export const getOrderingProfile = (name: string): OrderingProfile => {
  const registered = ORDERING_PROFILES[name]
  if (registered === undefined || typeof registered === 'function')
    throw new E_UNKNOWN_ORDERING_PROFILE([name])
  return registered
}

/** Resolves a parameterized behavior token used by `FAMILY_RECIPES`. */
export const resolveOrderingBehavior = (name: string): OrderingProfile => {
  const [behavior, ...args] = name.split(':')
  if (behavior === 'full_history_preservation' && args.length === 1)
    return fullHistoryPreservation(args[0] as OrderingPrimitiveKind)
  if (behavior === 'payload_field_preservation' && args.length >= 1)
    return payloadFieldPreservation(args.join(':'), 'thought')
  // `role_remap_*[:field[:variant[:severity]]]` — the tag is a consumer-supplied payload field that
  // nothing in the ADK writes, so the recipe says which field carries it and what value to require.
  // Bare `role_remap_split_tool_roles` keeps the documented Granite defaults.
  if (behavior === 'non_empty_turn')
    return nonEmptyTurn(args[0] === 'terminal', (args[1] as 'assistant' | 'user') ?? 'assistant')
  if (behavior === 'tool_call_id_format')
    return toolCallIdFormat(args[0] ? Number(args[0]) : undefined, args[1])
  if (behavior === 'role_remap_split_tool_roles')
    return roleRemapSplitToolRoles(...(args as [string?, string?, ('blocking' | 'advisory')?]))
  if (behavior === 'role_remap_inline_tool_call')
    return roleRemapInlineToolCall(...(args as [string?, string?, ('blocking' | 'advisory')?]))
  return getOrderingProfile(name)
}

export {
  permissive,
  toolIdentity,
  schemaIntegrity,
  openaiShapeBaseline,
  strictAlternation,
  singleToolCallPerTurn,
  thinkingBeforeToolUse,
  thoughtSignatureRequired,
  thoughtSignatureAdvisory,
  functionResponseAdjacency,
  reasoningPrunedAfterLatestTurn,
  staleThinkingAdvisory,
  harmonyCommentaryChannel,
  converseTextBeforeToolUse,
}
