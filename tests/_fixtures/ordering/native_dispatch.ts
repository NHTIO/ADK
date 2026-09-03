/**
 * Per-surface native dispatch for the ordering audit.
 *
 * WHY THIS EXISTS
 *
 * The first matrix run sent every cell through one OpenAI-compatible endpoint. That made the
 * results uninterpretable: a gateway in front of a non-OpenAI vendor has to translate the request
 * into the vendor's native shape, and those translations perform the very normalisations the rules
 * check for — merging consecutive same-role turns for Converse, injecting the `thoughtSignature`
 * sentinel for Gemini. Several cells therefore measured the GATEWAY's repair and reported it as the
 * vendor accepting a violation.
 *
 * Each cell now assembles through the battery that speaks its own surface, and dispatches to that
 * surface directly. Nothing sits between the corpus and the vendor except the battery whose
 * translation we can read.
 *
 * See `docs/batteries/validation/api-surface-scope.md`.
 */
import { Tokenizable } from '@nhtio/adk/common'
import { renderGraniteToolCall } from './granite_renderer'
import {
  buildConverseRequest,
  toolsToConverseTools,
} from '../../../src/batteries/llm/bedrock_converse/helpers'
import {
  buildGeminiRequest,
  toolsToGeminiTools,
} from '../../../src/batteries/llm/gemini_generate_content/helpers'
import type { OrderingLeg } from './types'
import type { MatrixCell } from './matrix'
import type { GraniteVariant } from './granite_renderer'

/** An empty registry: the audit declares tools from the transcript, never offers new ones. */
const emptyRegistry = { visible: () => [], all: () => [], get: () => undefined } as never

/** What a dispatched leg produced, before verdict classification. */
export interface NativeDispatchResult {
  status: number
  /** The body actually POSTed — the `onPromptAssembled` equivalent for this harness. */
  requestBody: unknown
  responseBody: string
  /** Roles as they appear on the wire, for asserting the leg assembled as intended. */
  wireRoles: string[]
  hasContent: boolean
  hasToolCall: boolean
  completionTokens?: number
  finishReason?: string
  errorText?: string
}

/** Shared build input every assembler needs. */
const buildInput = (leg: OrderingLeg) => ({
  systemPrompt: new Tokenizable('You are a code reviewer.'),
  standingInstructions: [],
  memories: [],
  retrievables: [],
  messages: leg.state.messages,
  thoughts: leg.state.thoughts,
  toolCalls: leg.state.toolCalls,
  tools: emptyRegistry,
  bucketOrder: undefined,
  selfIdentity: 'assistant',
  thoughtSurfacing: 'all-self' as const,
  replayCompatibility: [],
})

/**
 * Assemble a leg through its surface's own battery.
 *
 * Only the two surfaces whose gateway translation corrupted the first run are assembled natively
 * here (Converse and Gemini). The rest already speak an OpenAI-shaped wire, where the gateway is
 * a passthrough rather than a translator — for those the harness builds the same shape the
 * `openai_chat_completions` battery would.
 */
export const assembleNative = async (
  cell: MatrixCell,
  leg: OrderingLeg
): Promise<{ body: Record<string, unknown>; url: string; wireRoles: string[] }> => {
  if (cell.surface === 'bedrock_converse') {
    const results = new Map<string, Array<{ text?: string }>>()
    for (const tc of leg.state.toolCalls) results.set(tc.id, [{ text: String(tc.results ?? '') }])
    const req = await buildConverseRequest({
      ...buildInput(leg),
      renderedToolCallResults: results as never,
      // 'reject' is the whole point: send the shape the rule forbids UNTOUCHED so Converse's own
      // verdict surfaces. Under 'merge' the battery would repair it and the cell would measure
      // our repair instead of the vendor's tolerance.
      alternationPolicy: 'reject',
      helpers: { toolsToConverseTools } as never,
    })
    const body = { ...req, inferenceConfig: { maxTokens: 96 } } as Record<string, unknown>
    return {
      body,
      url: `/model/${encodeURIComponent(cell.model)}/converse`,
      wireRoles: req.messages.map((m) => m.role),
    }
  }

  if (cell.surface === 'gemini_generate_content') {
    const results = new Map<string, Record<string, unknown>>()
    for (const tc of leg.state.toolCalls) results.set(tc.id, { result: String(tc.results ?? '') })
    const req = await buildGeminiRequest({
      ...buildInput(leg),
      renderedToolCallResults: results as never,
      // `false` opts OUT of the sentinel so Gemini's own signature enforcement is what we measure.
      // With it on, both legs of the thought_signature cells would carry a signature and the cell
      // could not distinguish them — which is precisely how the gateway run went wrong.
      thoughtSignatureSentinel: false,
      helpers: { toolsToGeminiTools } as never,
    })
    // BUDGET FLOOR. Gemini-family reasoning models emit `thought: true` parts that consume the
    // output budget before any visible text is produced — measured on gemma-4: 379–583 reasoning
    // tokens per turn. Under a small cap the leg returns MAX_TOKENS with no visible text and
    // classifies as `empty` for BUDGET reasons, which is indistinguishable from the
    // empty-generation outcome this audit exists to detect. 96 and 512 both starved it; at 2048
    // three consecutive runs all reached STOP with visible text.
    const body = {
      ...req,
      generationConfig: { maxOutputTokens: 2048 },
    } as Record<string, unknown>
    return {
      body,
      url: `/v1beta/models/${cell.model}:generateContent`,
      wireRoles: req.contents.map((c) => c.role),
    }
  }

  if (cell.scenario.startsWith('role_remap')) {
    // The roleRemap rules validate a CONSUMER-SUPPLIED tag against a CONSUMER-SUPPLIED renderer.
    // Under the battery's default renderer the tag is never read, so both legs render to identical
    // bytes and the cell measures nothing. Routing through ./granite_renderer is what makes the
    // two conventions observably different — see granite_renderer.ts for the full rationale.
    const variant: GraniteVariant =
      cell.scenario === 'role_remap_split_tool_roles' ? 'granite-3.x' : 'granite-4.x'
    const msgs: Array<Record<string, unknown>> = []
    const names = new Set<string>()
    for (const m of leg.state.messages) {
      msgs.push({ role: m.role, content: String(m.content ?? '') })
    }
    for (const tc of leg.state.toolCalls) {
      names.add(tc.tool)
      // Stamp the tag the rule expects, then render according to it. A leg whose ToolCall carries
      // no tag falls back to the inline form, which is exactly what the guard's advisory reports.
      const tagged = { ...tc, payload: { roleTag: variant } } as never
      for (const turn of renderGraniteToolCall(tagged, String(tc.results ?? ''), 'roleTag')) {
        if (turn.role !== 'tool_response') {
          msgs.push({ role: turn.role, content: turn.content })
          continue
        }
        // The 3.x convention's separate result turn maps to a `tool`-role message, which the
        // OpenAI wire REQUIRES to carry `tool_call_id` — WatsonX rejects it otherwise
        // (`Field validation for 'tool_call_id' failed on the 'required' tag`). The preceding
        // assistant turn is prose carrying an inline `<tool_call>` marker rather than a structural
        // `tool_calls[]` entry, so there is no id for it to correlate with; one is supplied here so
        // the SHAPE under test reaches the model instead of a schema error.
        msgs.push({ role: 'tool', content: turn.content, tool_call_id: tc.id })
      }
    }
    const decl = [...names].map((name) => ({
      type: 'function' as const,
      function: {
        name,
        description: `Audit corpus tool: ${name}.`,
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    }))
    return {
      body: {
        model: cell.model,
        messages: msgs,
        max_tokens: 256,
        ...(decl.length > 0 ? { tools: decl } : {}),
      },
      url: '/v1/chat/completions',
      wireRoles: msgs.map((m) => String(m.role)),
    }
  }

  if (cell.surface === 'ollama') {
    // Native Ollama `/api/chat`: a flat string `content`, object-form tool-call `arguments`, and
    // `tool_name` on tool-role messages. NOT the `/v1` compat layer — that would put a translator
    // back in the path, which is the thing these native surfaces exist to remove.
    const msgs: Array<Record<string, unknown>> = []
    const seq = [
      ...[...leg.state.messages].map((m) => ({
        at: m.createdAt.toMillis(),
        kind: 'message' as const,
        v: m,
      })),
      ...[...leg.state.thoughts].map((t) => ({
        at: t.createdAt.toMillis(),
        kind: 'thought' as const,
        v: t,
      })),
      ...[...leg.state.toolCalls].map((c) => ({
        at: c.createdAt.toMillis(),
        kind: 'toolCall' as const,
        v: c,
      })),
    ].sort((a, b) => a.at - b.at)
    const names = new Set<string>()
    for (const item of seq) {
      if (item.kind === 'message') {
        msgs.push({ role: item.v.role, content: String(item.v.content ?? '') })
      } else if (item.kind === 'thought') {
        msgs.push({ role: 'assistant', content: String(item.v.content ?? '') })
      } else {
        names.add(item.v.tool)
        msgs.push({
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              function: {
                name: item.v.tool,
                arguments: (item.v.args ?? {}) as Record<string, unknown>,
              },
            },
          ],
        })
        msgs.push({ role: 'tool', content: String(item.v.results ?? ''), tool_name: item.v.tool })
      }
    }
    const decl = [...names].map((name) => ({
      type: 'function' as const,
      function: {
        name,
        description: `Audit corpus tool: ${name}.`,
        parameters: { type: 'object', properties: { path: { type: 'string' } } },
      },
    }))
    return {
      body: {
        model: cell.model,
        stream: false,
        messages: msgs,
        // Same reasoning-budget floor as the Gemini surface: a starved cap makes an empty
        // generation look like a shape verdict.
        options: { num_predict: 2048 },
        ...(decl.length > 0 ? { tools: decl } : {}),
      },
      url: '/api/chat',
      wireRoles: msgs.map((m) => String(m.role)),
    }
  }

  // OpenAI-shaped surfaces: the gateway forwards rather than translates, so the harness builds the
  // same wire shape the openai_chat_completions battery would.
  const messages: Array<Record<string, unknown>> = []
  const ordered = [
    ...[...leg.state.messages].map((m) => ({
      at: m.createdAt.toMillis(),
      kind: 'message' as const,
      v: m,
    })),
    ...[...leg.state.thoughts].map((t) => ({
      at: t.createdAt.toMillis(),
      kind: 'thought' as const,
      v: t,
    })),
    ...[...leg.state.toolCalls].map((c) => ({
      at: c.createdAt.toMillis(),
      kind: 'toolCall' as const,
      v: c,
    })),
  ].sort((a, b) => a.at - b.at)
  const declared = new Set<string>()
  for (const item of ordered) {
    if (item.kind === 'message') {
      messages.push({ role: item.v.role, content: String(item.v.content ?? '') })
    } else if (item.kind === 'thought') {
      messages.push({ role: 'assistant', content: String(item.v.content ?? '') })
    } else {
      declared.add(item.v.tool)
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: item.v.id,
            type: 'function',
            function: { name: item.v.tool, arguments: JSON.stringify(item.v.args ?? {}) },
          },
        ],
      })
      messages.push({
        role: 'tool',
        content: String(item.v.results ?? ''),
        tool_call_id: item.v.id,
      })
    }
  }
  const tools = [...declared].map((name) => ({
    type: 'function' as const,
    function: {
      name,
      description: `Audit corpus tool: ${name}.`,
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  }))
  return {
    body: {
      model: cell.model,
      messages,
      // Reasoning-budget floor, same reason as the Gemini surface: minimax.minimax-m2.5 returns
      // EMPTY content at 24 tokens and real content at 2048, because its reasoning is billed to the
      // same budget. A starved cap turns a healthy generation into a false `empty` verdict.
      max_tokens: 2048,
      // Grok's reasoning is ALWAYS ON and also bills to the output budget — at max_tokens 64 it
      // returned `finish_reason: length` with null content, every token spent reasoning. Disabling
      // it keeps the audit measuring SHAPE rather than reasoning depth.
      ...(cell.surface === 'bedrock_mantle_openai' ? { reasoning: { effort: 'none' } } : {}),
      ...(tools.length > 0 ? { tools } : {}),
    },
    url: '/v1/chat/completions',
    wireRoles: messages.map((m) => String(m.role)),
  }
}
