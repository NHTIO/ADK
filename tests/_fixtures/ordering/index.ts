/**
 * The ordering-guard audit registry — one scenario per registered ordering profile, plus one
 * proposed rule discovered in production traffic.
 *
 * Scenarios live in per-rule-type modules because a rule's corpus has to be shaped by the thing it
 * tests: an alternation violation is a message sequence, a metadata violation is a payload field,
 * a preservation violation is a delta against a prior snapshot. See `./types` for the audit's
 * structure and the step-1 / step-2 contract.
 */
import { permissiveScenario } from './permissive'
import { staleThinkingAdvisoryScenario } from './advisory'
import { trailingAssistantScenario } from './trailing_assistant'
import { strictAlternationScenario, singleToolCallPerTurnScenario } from './alternation'
import { thinkingBeforeToolUseScenario, converseTextBeforeToolUseScenario } from './order'
import { openaiShapeBaselineScenario, functionResponseAdjacencyScenario } from './adjacency'
import { roleRemapSplitToolRolesScenario, roleRemapInlineToolCallScenario } from './role_remap'
import {
  thoughtSignatureRequiredScenario,
  thoughtSignatureAdvisoryScenario,
  harmonyCommentaryChannelScenario,
} from './required_metadata'
import {
  fullHistoryPreservationScenario,
  payloadFieldPreservationScenario,
  reasoningPrunedAfterLatestTurnScenario,
} from './preservation'
import type { OrderingScenario } from './types'

export * from './types'
export {
  openaiShapeBaselineScenario,
  functionResponseAdjacencyScenario,
  strictAlternationScenario,
  singleToolCallPerTurnScenario,
  thinkingBeforeToolUseScenario,
  converseTextBeforeToolUseScenario,
  thoughtSignatureRequiredScenario,
  thoughtSignatureAdvisoryScenario,
  harmonyCommentaryChannelScenario,
  fullHistoryPreservationScenario,
  payloadFieldPreservationScenario,
  reasoningPrunedAfterLatestTurnScenario,
  staleThinkingAdvisoryScenario,
  permissiveScenario,
  roleRemapSplitToolRolesScenario,
  roleRemapInlineToolCallScenario,
  trailingAssistantScenario,
}

/** Every scenario in the audit, in registry order. */
export const ORDERING_SCENARIOS: readonly OrderingScenario[] = [
  permissiveScenario,
  openaiShapeBaselineScenario,
  functionResponseAdjacencyScenario,
  strictAlternationScenario,
  singleToolCallPerTurnScenario,
  thinkingBeforeToolUseScenario,
  converseTextBeforeToolUseScenario,
  thoughtSignatureRequiredScenario,
  thoughtSignatureAdvisoryScenario,
  harmonyCommentaryChannelScenario,
  fullHistoryPreservationScenario,
  payloadFieldPreservationScenario,
  reasoningPrunedAfterLatestTurnScenario,
  staleThinkingAdvisoryScenario,
  roleRemapSplitToolRolesScenario,
  roleRemapInlineToolCallScenario,
  trailingAssistantScenario,
]

/** Scenarios whose wire leg can run now. */
export const liveScenarios = (): readonly OrderingScenario[] =>
  ORDERING_SCENARIOS.filter((scenario) => scenario.skip === undefined)

/** Scenarios whose wire leg must be `.skip`ped, each carrying its reason. */
export const skippedScenarios = (): readonly OrderingScenario[] =>
  ORDERING_SCENARIOS.filter((scenario) => scenario.skip !== undefined)

/** Look one up by id. */
export const scenarioById = (id: string): OrderingScenario | undefined =>
  ORDERING_SCENARIOS.find((scenario) => scenario.id === id)
