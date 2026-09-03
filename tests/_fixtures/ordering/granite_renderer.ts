/**
 * A roleTag-aware `buildTransformersJsMessages` override — the REFERENCE IMPLEMENTATION of what a
 * `roleRemap` consumer must supply.
 *
 * WHY THIS EXISTS
 *
 * The `role_remap_*` profiles validate that a ToolCall carries a wire-role tag (`payload.roleTag`
 * by default). Nothing in the ADK writes or reads that tag — which initially looked like the rule
 * was checking a field no provider could ever observe.
 *
 * That reading was wrong, and this file is the proof. Every LLM battery exposes its message
 * assembly as an INJECTABLE helper (`buildTransformersJsMessages` here; the Chat-Completions,
 * Anthropic, Ollama and LiteRT batteries expose equivalents). The default renderer collapses a
 * ToolCall to `{ role: 'tool', content: <result> }` and therefore ignores the tag — but a consumer
 * targeting Granite overrides it, and the tag becomes the thing that decides how history is
 * rendered:
 *
 *   granite-3.x  → split roles:  assistant `<tool_call>…</tool_call>` + a separate tool_response
 *   granite-4.x  → inlined:      one assistant turn carrying `<|tool_call|>…<|/tool_call|>` + result
 *
 * Those are different bytes, so the model sees different input, so step 1 of the audit (does the
 * forbidden shape actually fail?) is testable after all — it just requires the renderer the rule
 * presupposes.
 *
 * WHAT THE RULE ACTUALLY POLICES
 *
 * Read together with the renderer, `roleRemap` is not a vendor-wire assertion at all: it is a
 * CONSISTENCY check between two things the CONSUMER owns — the tag they stamped on the ToolCall,
 * and the renderer they installed. It catches the drift case: history assembled for 3.x being
 * dispatched through a 4.x renderer, or vice versa. That is why the profile is parameterized (the
 * consumer names the field and the value) and why it defaults to advisory (a consumer who has not
 * adopted a tagging convention must not be blocked).
 *
 * SCOPE. This is a fixture, deliberately minimal: it renders the tool-call portion of the timeline
 * only, exactly enough to make the tag observable to a model. It is NOT a complete Granite adapter
 * and must not be read as one — a production consumer's renderer would also handle messages,
 * thoughts, media and bucket ordering, which the default helper already does.
 */
import type { ToolCall } from '@nhtio/adk/common'

/** The two Granite conventions this fixture can render. */
export type GraniteVariant = 'granite-3.x' | 'granite-4.x'

/** One rendered chat turn, in the shape transformers.js consumes. */
export interface RenderedTurn {
  role: string
  content: string
}

/**
 * Read the consumer's wire-role tag off a ToolCall payload.
 *
 * `payloadField` mirrors the profile's `expectedRoleTag` parameter — a consumer who names the field
 * `wireRole` passes `'wireRole'` to BOTH, and the renderer and the guard stay in agreement. That
 * pairing is the whole contract.
 */
export const readRoleTag = (tc: ToolCall, payloadField = 'roleTag'): string | undefined => {
  const payload = (tc as { payload?: unknown }).payload
  if (payload === null || typeof payload !== 'object') return undefined
  const value = (payload as Record<string, unknown>)[payloadField]
  return typeof value === 'string' ? value : undefined
}

/**
 * Render one ToolCall according to its tag.
 *
 * An ABSENT tag falls back to the 4.x inline form — the same bytes a 4.x-tagged call produces. That
 * fallback is deliberate and is what makes the guard's advisory meaningful: without the tag the
 * renderer cannot know which convention was intended, so it guesses, and the advisory tells the
 * consumer their history is being rendered on an assumption rather than a declaration.
 */
export const renderGraniteToolCall = (
  tc: ToolCall,
  result: string,
  payloadField = 'roleTag'
): RenderedTurn[] => {
  const tag = readRoleTag(tc, payloadField)
  if (tag === 'granite-3.x') {
    return [
      { role: 'assistant', content: `<tool_call>${tc.tool}</tool_call>` },
      { role: 'tool_response', content: result },
    ]
  }
  return [{ role: 'assistant', content: `<|tool_call|>${tc.tool}<|/tool_call|>${result}` }]
}

/**
 * Build a `buildTransformersJsMessages` override that renders tool calls per their role tag and
 * otherwise defers to the battery's default assembly.
 *
 * Install it as `helpers.buildTransformersJsMessages` on `TransformersJsAdapter`; pair it with the
 * matching profile token (e.g. `role_remap_inline_tool_call:roleTag:granite-4.x`).
 */
export const graniteAwareMessageBuilder =
  (defaultBuilder: (input: never) => Promise<never>, payloadField = 'roleTag') =>
  async (input: never): Promise<never> => {
    const typed = input as unknown as {
      toolCalls: Iterable<ToolCall>
      renderedToolCallResults: Map<string, string>
    }
    const built = (await defaultBuilder(input)) as unknown as { messages: RenderedTurn[] }
    // Replace each default `{ role: 'tool' }` turn with the tag-directed rendering, in timeline
    // order. Everything else the default builder produced is left untouched.
    const rerendered: RenderedTurn[] = []
    const calls = [...typed.toolCalls].sort(
      (a, b) => a.createdAt.toMillis() - b.createdAt.toMillis()
    )
    let callIndex = 0
    for (const turn of built.messages) {
      if (turn.role !== 'tool') {
        rerendered.push(turn)
        continue
      }
      const tc = calls[callIndex++]
      if (tc === undefined) {
        rerendered.push(turn)
        continue
      }
      rerendered.push(
        ...renderGraniteToolCall(tc, typed.renderedToolCallResults.get(tc.id) ?? '', payloadField)
      )
    }
    return { ...built, messages: rerendered } as unknown as never
  }
