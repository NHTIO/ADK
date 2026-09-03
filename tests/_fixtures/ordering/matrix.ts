/**
 * Rule → model assignments for the live half of the ordering-guard audit, plus the four-valued
 * verdict the wire leg records.
 *
 * A cell activates ONE rule's profile against ONE model. A family that carries several rules
 * therefore appears as several independent cells — a verdict is attributable to one rule, never to
 * a recipe.
 */
import type { WireOutcome } from './types'

/** One rule → model assignment. */
export interface MatrixCell {
  /** Scenario id from the corpus registry. */
  scenario: string
  /** Family recipe the rule belongs to, per `families.ts`. */
  family: string
  /** LB model id, or an HF repo id for a locally-run model. */
  model: string
  /** `lb` dispatches through the load balancer; `local` runs in-process via transformers.js. */
  via: 'lb' | 'local'
  /**
   * Which NATIVE API surface this cell must speak, and therefore which battery assembles it.
   *
   * This is the correction the first matrix run forced. Dispatching every cell through an
   * OpenAI-compatible endpoint meant a gateway translated the request into each vendor's native
   * shape — merging consecutive same-role turns for Converse, injecting the thoughtSignature
   * sentinel for Gemini — so several cells measured the GATEWAY's repair rather than the vendor's
   * tolerance. A rule is a claim about a model reached through a specific API; the cell has to
   * speak that API. See docs/batteries/validation/api-surface-scope.md.
   */
  surface:
    | 'bedrock_converse'
    | 'bedrock_mantle'
    | 'bedrock_mantle_openai'
    | 'gemini_generate_content'
    | 'anthropic_messages'
    | 'openai_responses'
    | 'openai_chat_completions'
    | 'ollama'
    | 'transformers_js'
  /** Why this model represents this family, when it is not obvious. */
  note?: string
}

/**
 * The assignments.
 *
 * `openai_shape_baseline` spans 25 families, so it takes two lineages rather than one model
 * standing in for all of them. Everything else is single-family and therefore determined by the
 * recipe.
 */
export const MATRIX: readonly MatrixCell[] = [
  // The control, on its ACTUAL family. `permissive` is the xAI Grok recipe — the deliberately empty
  // baseline — so running it on Nova was a stand-in. `xai.grok-4.3` is Mantle-only and served under
  // the `/openai/v1` PREFIX, not the bare `/v1` (AWS's model card documents this per model family;
  // the catalog has no field expressing it, so it cannot be derived — `GET /v1/models/{id}` returns
  // only id/object/created/owned_by/status/data_retention). Hitting the unprefixed path returns
  // "model `xai.grok-4.3` isn't supported on this route", which means the ROUTE, not the model.
  //
  // Reasoning is ALWAYS ON and bills to the output budget: at max_tokens 64 the response came back
  // `finish_reason: length` with null content having spent it all on reasoning. `effort: 'none'`
  // plus a 2048 budget yields real content in ~300 completion tokens.
  {
    scenario: 'permissive',
    family: 'permissive',
    model: 'xai.grok-4.3',
    via: 'lb',
    surface: 'bedrock_mantle_openai',
    note: 'The control, on the Grok family the recipe actually names. A violation here means the harness is wrong, not the model.',
  },

  {
    scenario: 'openai_shape_baseline',
    family: 'nova',
    model: 'us.amazon.nova-2-lite-v1:0',
    via: 'lb',
    surface: 'bedrock_converse',
  },
  {
    scenario: 'openai_shape_baseline',
    family: 'gpt-4-legacy',
    model: 'gpt-4.1',
    via: 'lb',
    surface: 'openai_chat_completions',
  },

  {
    scenario: 'function_response_adjacency',
    family: 'gemini-3',
    model: 'gemini-3.5-flash-lite',
    via: 'lb',
    surface: 'gemini_generate_content',
    note: 'PINNED. Was `gemini-flash-lite-latest`; the matrix run resolved that alias to `gemini-flash-latest` upstream (195 of 196 gemini calls in the run window hit .../models/gemini-flash-latest:generateContent) — i.e. Flash, not Flash-Lite, so both gemini verdicts were recorded against the wrong model. The alias resolves to gemini-3.5-flash-lite when called directly, so the concrete id is pinned here rather than trusted to routing.',
  },
  {
    scenario: 'function_response_adjacency',
    family: 'gemini-2-5',
    model: 'gemini-2.5-flash-lite',
    via: 'lb',
    surface: 'gemini_generate_content',
  },

  {
    scenario: 'strict_alternation',
    family: 'nova',
    model: 'us.amazon.nova-2-lite-v1:0',
    via: 'lb',
    surface: 'bedrock_converse',
  },
  // gemma-3 has NO model on the Gemini API: `/v1beta/models` lists only gemma-4-26b-a4b-it and
  // gemma-4-31b-it, and `gemma-3-27b-it` 404s with "not found for API version v1beta, or is not
  // supported for generateContent". The LB catalog advertises gemma-3 ids under the `gemini`
  // provider, but the vendor does not serve them on this surface. Left in the matrix, marked, so
  // the gap is visible rather than silently dropped — a 404 is not a verdict about the rule.
  {
    scenario: 'strict_alternation',
    family: 'gemma-3',
    model: 'gemma-3-27b-it',
    via: 'lb',
    surface: 'gemini_generate_content',
    note: 'NO MODEL — gemma-3 is not served on generateContent; this cell cannot produce a verdict.',
  },
  {
    scenario: 'strict_alternation',
    family: 'gemma-4',
    model: 'gemma-4-26b-a4b-it',
    via: 'lb',
    surface: 'gemini_generate_content',
  },

  {
    scenario: 'single_tool_call_per_turn',
    family: 'llama-3',
    model: 'onnx-community/Llama-3.2-1B-Instruct-ONNX',
    via: 'local',
    surface: 'transformers_js',
    note: 'A 1B ONNX quant is the right FAMILY but a weak proxy for Meta’s larger models; read a result as local-quant evidence.',
  },

  {
    scenario: 'thinking_before_tool_use',
    family: 'anthropic-manual-thinking',
    model: 'claude-haiku-4-5',
    via: 'lb',
    surface: 'anthropic_messages',
    note: 'MUST record anthropic-beta: interleaved-thinking-2025-05-14 may make this rule conditional rather than absolute.',
  },
  {
    scenario: 'converse_text_before_tool_use',
    family: 'bedrock-converse',
    model: 'us.amazon.nova-2-lite-v1:0',
    via: 'lb',
    surface: 'bedrock_converse',
  },

  {
    scenario: 'thought_signature_required',
    family: 'gemini-3',
    model: 'gemini-3.5-flash-lite',
    via: 'lb',
    surface: 'gemini_generate_content',
    note: 'PINNED for the same reason as the function_response_adjacency/gemini-3 cell above.',
  },
  {
    scenario: 'thought_signature_advisory',
    family: 'gemini-2-5',
    model: 'gemini-2.5-flash-lite',
    via: 'lb',
    surface: 'gemini_generate_content',
    note: 'Severity twin of the rule above, same vendor and field — whichever way the wire rules, one of the pair is mis-specified.',
  },

  {
    scenario: 'harmony_commentary_channel',
    family: 'gpt-oss',
    model: 'gpt-oss:20b',
    via: 'lb',
    surface: 'ollama',
    note: 'Rule declares no fallbackPayloadValue, so mutate-mode repair can never fill it.',
  },

  // MOVED OFF CONVERSE. Converse is itself a TRANSLATION layer: the same generic `{text}` block
  // body is accepted by Nova and by Mistral, whose native prompt formats differ completely
  // (`schemaVersion: messages-v1` vs `<s>[INST]`), which is only possible because AWS translates
  // server-side. So a Converse verdict for a THIRD-PARTY model measured AWS's translator, not the
  // model's own format — the same error this audit documents in api-surface-scope.md, one hop
  // closer to the vendor. Nova cells keep Converse (it is Nova's own home surface); non-Nova ones
  // move to Bedrock Mantle, an OpenAI-compatible pass-through where the body is forwarded rather
  // than reshaped per vendor.
  {
    scenario: 'full_history_preservation',
    family: 'minimax-m2',
    model: 'minimax.minimax-m2.5',
    via: 'lb',
    surface: 'bedrock_mantle',
    note: 'Was bedrock_converse; Converse translates for third-party models. Mantle forwards.',
  },
  {
    scenario: 'payload_field_preservation',
    family: 'glm-4-7',
    model: 'zai.glm-4.7-flash',
    via: 'lb',
    surface: 'bedrock_mantle',
    note: 'Was bedrock_converse; see the minimax cell above for why third-party models moved off it.',
  },
  {
    scenario: 'payload_field_preservation',
    family: 'codex-responses',
    model: 'gpt-5.6-luna',
    via: 'lb',
    surface: 'openai_responses',
  },

  {
    scenario: 'reasoning_pruned_after_latest_turn',
    family: 'qwen-3',
    model: 'qwen3.5:397b',
    via: 'lb',
    surface: 'ollama',
  },
  {
    scenario: 'stale_thinking_advisory',
    family: 'gemma-4',
    model: 'gemma-4-26b-a4b-it',
    via: 'lb',
    surface: 'gemini_generate_content',
  },
  // SECOND gemma-4 sample, on a different SERVING STACK. `gemma4:e4b-it-qat` is the same model
  // family reached through native Ollama `/api/chat` rather than Gemini `generateContent` — a
  // quantised local build vs Google's hosted one. Whether a rule derived from "Gemma 4 guidance"
  // holds across both is a real question: the guidance is about the model, but enforcement lives in
  // whatever stack renders the conversation, and these two render it differently. A disagreement
  // between the two samples IS the finding.
  {
    scenario: 'stale_thinking_advisory',
    family: 'gemma-4',
    model: 'gemma4:e4b-it-qat',
    via: 'lb',
    surface: 'ollama',
    note: 'Same family, different serving stack (Ollama /api/chat, q4 local build) — cross-checks the hosted gemini-3.5 sample.',
  },
  {
    scenario: 'strict_alternation',
    family: 'gemma-4',
    model: 'gemma4:e4b-it-qat',
    via: 'lb',
    surface: 'ollama',
    note: 'Same family, different serving stack — cross-checks the hosted gemma-4-26b-a4b-it sample.',
  },

  // Granite is now reachable: `ibm/granite-4-h-small` on a WatsonX credential. Both cells dispatch
  // there, each rendering ITS OWN convention through ./granite_renderer — which is the only way the
  // tag becomes wire-visible at all (the default renderer ignores payload, so both legs would be
  // byte-identical and the cell would measure nothing).
  //
  // MEASURED against real Granite 4: BOTH conventions are accepted and answered correctly —
  //   4.x inlined  `<|tool_call|>get_file_diff<|/tool_call|>42 lines` -> stop, "contains 42 lines"
  //   3.x split    assistant tool_calls + tool-role result           -> stop, "contains 42 lines"
  // so the model does not enforce a distinction between them on this surface.
  {
    scenario: 'role_remap_split_tool_roles',
    family: 'granite-3-x',
    model: 'ibm/granite-4-h-small',
    via: 'lb',
    surface: 'openai_chat_completions',
    note: 'Renders the 3.x SPLIT-role convention. NOTE the model is Granite 4 — no Granite 3 is provisioned, so this tests whether a 4-series model rejects 3.x-shaped history, not whether Granite 3 requires it.',
  },
  {
    scenario: 'role_remap_inline_tool_call',
    family: 'granite-4-x',
    model: 'ibm/granite-4-h-small',
    via: 'lb',
    surface: 'openai_chat_completions',
    note: 'Renders the 4.x INLINE convention against a matching 4-series model.',
  },

  {
    scenario: 'trailing_assistant_terminal',
    family: '(proposed)',
    model: 'us.amazon.nova-2-lite-v1:0',
    via: 'lb',
    surface: 'bedrock_converse',
    note: 'Observed on Nova (188 empties), claude-opus-5 (108), gpt-5.6-luna (51), deepseek-v3.2 (22).',
  },
  {
    scenario: 'trailing_assistant_terminal',
    family: '(proposed)',
    model: 'gpt-5.6-luna',
    via: 'lb',
    surface: 'openai_responses',
  },
]

/**
 * How a wire leg turned out.
 *
 * `empty` is the outcome production surfaced and the reason a boolean pass/fail would be
 * misleading: an HTTP 200 whose generation is `content: null` with near-zero completion tokens
 * looks like success to any status-code check while producing nothing and burning the whole prompt.
 * `void` covers transport failure (429/503/5xx/timeout) — never scored as a pass, never as a fail.
 */
export type CellVerdict = 'accepted' | 'empty' | 'rejected' | 'void'

/** What one dispatched leg produced. */
export interface LegResult {
  verdict: CellVerdict
  status: number
  /** Completion tokens, when the provider reported them — the `empty` discriminator. */
  completionTokens?: number
  finishReason?: string
  /** Vendor error text on a rejection, verbatim. */
  error?: string
  /** The assembled request captured by `onPromptAssembled`, for shape verification. */
  assembledRoles?: string[]
}

/** One completed cell: both legs, plus whether the wire agreed with the guard. */
export interface CellResult {
  cell: MatrixCell
  /** The model id the alias actually resolved to, when it differs from `cell.model`. */
  resolvedModel?: string
  violating: LegResult
  compliant: LegResult
  /**
   * The finding. `justified` = the forbidden shape really failed and the compliant one worked.
   * `unjustified` = the vendor accepted what the rule forbids. `inconclusive` = a void leg, or an
   * `unknown` prediction where the cell records rather than asserts.
   */
  disposition: 'justified' | 'unjustified' | 'compliant-fails' | 'inconclusive'
}

/**
 * Upstream error text that indicates the PAYLOAD was refused, even when wrapped in a 5xx.
 * Deliberately narrow: anything not matched here stays a transport void.
 */
const SHAPE_REJECTION =
  /toolConfig|must be defined|invalid[_ ]request|invalid argument|must have either|not supported|malformed|unsupported/i

/** Classify a dispatched leg against what the corpus predicted. */
export const classifyLeg = (
  status: number,
  _completionTokens: number | undefined,
  hasContent: boolean,
  hasToolCall: boolean,
  errorText?: string
): CellVerdict => {
  // A 5xx that names a REQUEST-SHAPE problem is the vendor rejecting our payload, not the transport
  // failing. The LB wraps some upstream 4xx as 503 (Bedrock's "The toolConfig field must be defined
  // when using toolUse and toolResult content blocks." arrives that way), and scoring those as void
  // would silently discard real verdicts — and, worse, hide a malformed request behind an
  // infrastructure-shaped excuse.
  if (status >= 500 && errorText !== undefined && SHAPE_REJECTION.test(errorText)) return 'rejected'
  if (status === 429 || status === 503 || status >= 500 || status === 0) return 'void'
  if (status >= 400) return 'rejected'
  // A 200 that generated nothing: no content, no tool call. `completionTokens` corroborates but is
  // not required — some gateways omit usage entirely.
  if (!hasContent && !hasToolCall) return 'empty'
  return 'accepted'
}

/** Does a leg's observed verdict satisfy what the corpus predicted? */
export const satisfies = (predicted: WireOutcome, observed: CellVerdict): boolean => {
  if (observed === 'void') return false
  switch (predicted) {
    case 'accepted':
      return observed === 'accepted'
    case 'empty':
      return observed === 'empty'
    case 'rejected':
      return observed === 'rejected'
    case 'rejected-or-empty':
      return observed === 'rejected' || observed === 'empty'
    case 'unknown':
      // The cell RECORDS rather than asserts — but a leg the vendor did not actually SERVE is
      // never a satisfied prediction. `unknown` means "we cannot predict which success shape the
      // vendor wants", not "any outcome counts".
      //
      // Both non-success verdicts are excluded, and `empty` had to be added after it produced a
      // wrong label: the gemma-4 stale-thinking cell's compliant leg came back `empty`
      // (MALFORMED_RESPONSE) and the cell still read `justified`, i.e. it claimed the rule was
      // vendor-enforced while the shape the rule DEMANDS was returning nothing. That is
      // `compliant-fails` by definition.
      return observed === 'accepted'
  }
}
