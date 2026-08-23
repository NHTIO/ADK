/**
 * Family recipes compose atomic behaviors without duplicating profile objects. Parameterized
 * entries use `behavior:argument` so the registry remains a plain string catalog.
 */
import { unionOfRules } from '../helpers'
import { E_UNKNOWN_ORDERING_PROFILE } from '../exceptions'
import { getOrderingProfile, permissive, resolveOrderingBehavior } from './index'
import type { OrderingProfile } from '../types'

/**
 * ByteDance Seed is an UNCONFIRMED baseline guess. Do not trust it in `enforce` mode without
 * independent verification against the target's own template documentation.
 */
/**
 * Muse Spark is an UNCONFIRMED baseline guess. Do not trust it in `enforce` mode without
 * independent verification against Meta's own template documentation.
 */
/**
 * Muse Glimmer is an UNCONFIRMED baseline guess. Do not trust it in `enforce` mode without
 * independent verification against Meta's own template documentation.
 */
export const FAMILY_RECIPES: Record<string, readonly string[]> = {
  'anthropic-manual-thinking': ['thinking_before_tool_use', 'payload_field_preservation:signature'],
  'anthropic-adaptive-thinking': ['payload_field_preservation:signature'],
  'gemini-3': ['thought_signature_required', 'function_response_adjacency'],
  'gemini-2-5': ['thought_signature_advisory', 'function_response_adjacency'],
  'nova': ['strict_alternation', 'openai_shape_baseline'],
  'bedrock-converse': ['converse_text_before_tool_use'],
  'deepseek-v3-base': ['strict_alternation', 'openai_shape_baseline'],
  'deepseek-thinking': ['strict_alternation', 'full_history_preservation:thought'],
  'deepseek-v4': ['strict_alternation', 'full_history_preservation:thought'],
  'qwen-2-5': ['openai_shape_baseline'],
  'qwen-3': ['openai_shape_baseline', 'reasoning_pruned_after_latest_turn'],
  'glm-4-5': ['openai_shape_baseline'],
  'glm-4-7': ['openai_shape_baseline', 'payload_field_preservation:clear_thinking'],
  'kimi-k2': ['openai_shape_baseline', 'full_history_preservation:toolCall'],
  'kimi-k3': [
    'openai_shape_baseline',
    'full_history_preservation:toolCall',
    'full_history_preservation:thought',
  ],
  'minimax-m2': [
    'openai_shape_baseline',
    'full_history_preservation:toolCall',
    'full_history_preservation:thought',
  ],
  'minimax-m3': [
    'openai_shape_baseline',
    'full_history_preservation:toolCall',
    'full_history_preservation:thought',
  ],
  'mistral': ['openai_shape_baseline'],
  'llama-3': ['openai_shape_baseline', 'single_tool_call_per_turn'],
  'llama-4': ['openai_shape_baseline'],
  'nemotron': ['openai_shape_baseline'],
  'gemma-3': ['strict_alternation'],
  'gemma-4': ['strict_alternation', 'stale_thinking_advisory'],
  'gpt-oss': ['harmony_commentary_channel'],
  'codex-responses': ['payload_field_preservation:encrypted_content'],
  'cohere-command-r': ['openai_shape_baseline'],
  'phi': ['openai_shape_baseline'],
  'mai': ['openai_shape_baseline'],
  'jamba': ['openai_shape_baseline'],
  'falcon': ['openai_shape_baseline'],
  'palmyra': ['openai_shape_baseline'],
  'ernie': ['openai_shape_baseline'],
  'gpt-4-legacy': ['openai_shape_baseline'],
  /** UNCONFIRMED baseline guess: verify independently before relying on this in `enforce` mode. */
  'bytedance-seed': ['openai_shape_baseline'],
  /** UNCONFIRMED baseline guess: verify independently before relying on this in `enforce` mode. */
  'muse-spark': ['openai_shape_baseline'],
  /** UNCONFIRMED baseline guess: verify independently before relying on this in `enforce` mode. */
  'muse-glimmer': ['openai_shape_baseline'],
  'granite-3-x': ['role_remap_split_tool_roles'],
  'granite-4-x': ['role_remap_inline_tool_call'],
}

const resolved = new Map<string, OrderingProfile>()

/** Resolves and memoizes a family recipe; Grok is a true no-rule baseline, not an empty recipe. */
export const resolveFamilyRecipe = (key: string): OrderingProfile => {
  if (key === 'grok') return permissive
  const cached = resolved.get(key)
  if (cached !== undefined) return cached
  const recipe = FAMILY_RECIPES[key]
  if (recipe === undefined) throw new E_UNKNOWN_ORDERING_PROFILE([key])
  const profile = unionOfRules(recipe.map(resolveOrderingBehavior))
  if (recipe.includes('function_response_adjacency'))
    profile.description +=
      ' Gemini function-response adjacency is enforced directly: a Message may not immediately follow a ToolCall because the ToolCall owns its result.'
  resolved.set(key, profile)
  return profile
}

export { getOrderingProfile }
