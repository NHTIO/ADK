// Node-only AdapterFactory that backs the portable agent harness with the ADK OpenAI-Chat-Completions
// battery. Sibling of makeOllamaAdapterFactory — same shape, same executor-override translation, same
// two measurement shims — but routes through the OpenAI battery so a cloud model reachable over the LB's
// OpenAI-compatible surface (e.g. gemini-flash-latest) exercises the REAL OpenAI battery code path rather
// than the Ollama-compat shim.
//
// FIDELITY NOTE (same caveat as the Ollama factory): cloud weights + OpenAI-Chat templating are NOT
// byte-identical to the flagship's LiteRt `.litertlm` preface. Use for RELATIVE pre/post-fix behaviour and
// cross-model band membership — not absolute browser numbers.
import { isError, isInstanceOf } from '@nhtio/adk/guards'
import { InMemorySpoolStore } from '@nhtio/adk/batteries/storage/in_memory'
import {
  OpenAIChatCompletionsAdapter,
  toolsToChatCompletionsTools,
  renderChatCompletionsToolCallResult,
  defaultDescriptionToChatCompletionsJsonSchema,
  defaultRenderUntrustedContent,
  defaultRenderTrustedContent,
} from '@nhtio/adk/batteries/llm/openai_chat_completions'
import type {
  AdapterFactory,
  HarnessAdapter,
} from '../../../docs/.vitepress/theme/components/agent/agent_runtime'

export interface OpenAiFactoryConfig {
  /** OpenAI-compatible model id (e.g. 'gemini-flash-latest' on the nht LB). */
  model?: string
  /** LB base URL, e.g. 'https://your-lb.example.com/v1'. */
  baseURL?: string
  /** Bearer API key for the LB. */
  apiKey?: string
  /**
   * Token-count encoding for the thrift budget. The floor denominator + subtractive pass count with this,
   * so use the matching family ('gemini' for gemini-*, 'o200k_base'/'cl100k_base' for GPT, 'claude' for
   * Anthropic). A mismatched counter mis-drives the window-pressure floor.
   */
  tokenEncoding?:
    | 'gpt2'
    | 'r50k_base'
    | 'p50k_base'
    | 'p50k_edit'
    | 'cl100k_base'
    | 'o200k_base'
    | 'gemini'
    | 'gemma'
    | 'llama2'
    | 'claude'
  /**
   * Dispatch-level retry on transport flakes. A 429/502/503/504 hits a SINGLE dispatch, not a turn, so we
   * absorb it here and let the turn continue intact — a turn only errors if a dispatch fails TERMINALLY
   * after retries. The battery defaults maxAttempts:1 (off); the head-to-head passes a real config so an
   * LB hiccup never contaminates a strategy measurement (the qwen lesson: don't count flakes as failures).
   */
  retry?: {
    maxAttempts?: number
    baseDelayMs?: number
    maxDelayMs?: number
    retriableStatuses?: number[]
    honorRetryAfter?: boolean
  }
  /** Idle timeout (ms) on a stalled stream before aborting — a hosted endpoint can hold a stream half-open. */
  streamIdleTimeoutMs?: number
  /** Whole-request timeout (ms) — aborts a dispatch that never returns, so one hang doesn't wedge the run. */
  requestTimeoutMs?: number
  /**
   * Ordered reasoning-field precedence. Reasoning models on the LB surface CoT on a non-spec channel:
   * Ollama's `/v1` + current vLLM emit `reasoning`; legacy vLLM/DeepSeek emit `reasoning_content`. Default
   * tries both so a reasoning model's thinking isn't silently lost.
   */
  reasoningFieldPrecedence?: ReadonlyArray<'reasoning' | 'reasoning_content'>
  /**
   * Request-body `reasoning_effort` — forces reasoning mode on providers that gate it behind this
   * param (e.g. GLM-5.2 on DigitalOcean: no reasoning_content at all without it). OpenAI Chat has no
   * generic thinking toggle otherwise, so this is opt-in per cell rather than a harness-wide default.
   */
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high'
  /** Capture each raw generation (dogfoods the same seam the LiteRt path taps). */
  onRawGeneration?: (o: {
    rawText: string
    cleanedText: string
    toolCalls: ReadonlyArray<{ name: string }>
  }) => void
  onPromptAssembled?: (o: {
    battery: string
    kind: string
    messages: unknown
    tools?: unknown
  }) => void
  /** Tap over each request body actually sent (proves what hit the wire). */
  onRequestBody?: (body: Record<string, unknown>) => void
  /** Spool-write tap — same ADK-side view the HTTP dump is blind to (callId + bytes per (re-)mint). */
  onSpoolWrite?: (o: { callId: string; bytes: number; writeSeq: number }) => void
  /** Full dispatch dump — one record per request round-trip (request + reassembled response). Wire to JSONL. */
  onDispatch?: (d: {
    seq: number
    request: Record<string, unknown>
    responseText: string
    finalMessage: Record<string, unknown> | null
    doneReason: string | null
    chunks: number
    error?: string
  }) => void
}

// Wrap an InMemorySpoolStore so every write(callId, bytes) is reported before delegating (same as the
// Ollama factory's tap — the ADK-side spool view the HTTP dump can't see).
function makeTappedSpoolStore(
  onSpoolWrite: NonNullable<OpenAiFactoryConfig['onSpoolWrite']>
): InstanceType<typeof InMemorySpoolStore> {
  const inner = new InMemorySpoolStore()
  let writeSeq = 0
  const origWrite = inner.write.bind(inner)
  ;(inner as unknown as { write: (callId: string, bytes: unknown) => unknown }).write = (
    callId: string,
    bytes: unknown
  ) => {
    const len =
      typeof bytes === 'string'
        ? bytes.length
        : isInstanceOf(bytes, 'Uint8Array', Uint8Array)
          ? bytes.byteLength
          : -1
    try {
      onSpoolWrite({ callId, bytes: len, writeSeq: writeSeq++ })
    } catch {
      /* tap must never break a spool write */
    }
    return (origWrite as (c: string, b: unknown) => unknown)(callId, bytes)
  }
  return inner
}

export function makeOpenAiAdapterFactory(cfg: OpenAiFactoryConfig = {}): AdapterFactory {
  const model = cfg.model ?? 'gemini-flash-latest'
  const baseURL =
    cfg.baseURL ??
    (process.env.ADK_LB_BASE
      ? `${process.env.ADK_LB_BASE}/v1`
      : (() => {
          throw new Error(
            'makeOpenAiAdapterFactory: no LB base URL configured — pass cfg.baseURL or set the ADK_LB_BASE env var'
          )
        })())
  const apiKey = cfg.apiKey
  const tokenEncoding = cfg.tokenEncoding ?? 'o200k_base'
  const tapping = !!(cfg.onRequestBody || cfg.onDispatch)
  let dispatchSeq = 0

  // Fetch tap: capture the exact request + response so diagnostics read ground truth. OpenAI Chat
  // Completions streams SSE (`data: {json}\n\n` lines, terminated by `data: [DONE]`) when stream:true, or
  // a single JSON object when stream:false. Tee the response so the adapter consumes the original untouched.
  const tapFetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    let reqBody: Record<string, unknown> | null = null
    if (url.includes('/chat/completions') && typeof init?.body === 'string') {
      try {
        reqBody = JSON.parse(init.body) as Record<string, unknown>
      } catch {
        /* leave null */
      }
    }
    if (reqBody && cfg.onRequestBody) cfg.onRequestBody(reqBody)
    const res = await fetch(input as never, init as never)
    if (!reqBody || !cfg.onDispatch || !res.body) return res
    const seq = dispatchSeq++
    const [toAdapter, toTap] = res.body.tee()
    void (async () => {
      const rec = {
        seq,
        request: reqBody as Record<string, unknown>,
        responseText: '',
        finalMessage: null as Record<string, unknown> | null,
        toolCalls: [] as unknown[],
        doneReason: null as string | null,
        chunks: 0,
        streaming: reqBody.stream !== false,
        raw: '',
        error: undefined as string | undefined,
      }
      try {
        const reader = toTap.getReader()
        const dec = new TextDecoder()
        let full = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          full += dec.decode(value, { stream: true })
        }
        rec.raw = full
        const contentParts: string[] = []
        let lastMsg: Record<string, unknown> | null = null
        // Non-streaming: one JSON object with choices[0].message. Streaming SSE: `data: {json}` lines whose
        // choices[0].delta accumulates content; `data: [DONE]` terminates. Parse both.
        if (!rec.streaming) {
          try {
            const obj = JSON.parse(full) as Record<string, unknown>
            rec.chunks = 1
            const choice = (obj.choices as Array<Record<string, unknown>> | undefined)?.[0]
            const msg = choice?.message as { content?: string; tool_calls?: unknown[] } | undefined
            if (msg) {
              lastMsg = msg as Record<string, unknown>
              if (typeof msg.content === 'string') contentParts.push(msg.content)
              if (Array.isArray(msg.tool_calls)) rec.toolCalls.push(...msg.tool_calls)
            }
            if (choice?.finish_reason) rec.doneReason = String(choice.finish_reason)
          } catch {
            /* leave */
          }
        } else {
          for (const line of full.split('\n')) {
            const s = line.trim()
            if (!s.startsWith('data:')) continue
            const payload = s.slice(5).trim()
            if (payload === '[DONE]') continue
            let obj: Record<string, unknown>
            try {
              obj = JSON.parse(payload) as Record<string, unknown>
            } catch {
              continue
            }
            rec.chunks++
            const choice = (obj.choices as Array<Record<string, unknown>> | undefined)?.[0]
            const delta = choice?.delta as { content?: string; tool_calls?: unknown[] } | undefined
            if (delta) {
              if (typeof delta.content === 'string' && delta.content)
                contentParts.push(delta.content)
              if (Array.isArray(delta.tool_calls)) rec.toolCalls.push(...delta.tool_calls)
              lastMsg = delta as Record<string, unknown>
            }
            if (choice?.finish_reason) rec.doneReason = String(choice.finish_reason)
          }
        }
        rec.responseText = contentParts.join('')
        rec.finalMessage = lastMsg
      } catch (e) {
        rec.error = isError(e) ? e.message : String(e)
      }
      cfg.onDispatch!(rec)
    })()
    return new Response(toAdapter, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    })
  }

  return (_model, opts): HarnessAdapter => {
    const adapter = new OpenAIChatCompletionsAdapter({
      model,
      baseURL,
      ...(apiKey ? { apiKey } : {}),
      fetch: tapping ? tapFetch : undefined,
      stream: process.env.ADK_OLLAMA_STREAM !== '0',
      ...(cfg.retry ? { retry: cfg.retry } : {}),
      ...(cfg.streamIdleTimeoutMs ? { streamIdleTimeoutMs: cfg.streamIdleTimeoutMs } : {}),
      ...(cfg.requestTimeoutMs ? { requestTimeoutMs: cfg.requestTimeoutMs } : {}),
      ...(cfg.reasoningFieldPrecedence
        ? { reasoningFieldPrecedence: cfg.reasoningFieldPrecedence as never }
        : {}),
      ...(cfg.reasoningEffort ? { reasoning_effort: cfg.reasoningEffort } : {}),
      tokenEncoding,
      // THE WALL: overflow guard = declared window − output reserve (NOT any engine cap). Same discipline
      // as the Ollama factory — a prompt that doesn't fit the declared window overflows honestly.
      contextWindow: Math.max(2048, opts.contextWindow - opts.maxTokens),
      spoolStore: cfg.onSpoolWrite
        ? makeTappedSpoolStore(cfg.onSpoolWrite)
        : new InMemorySpoolStore(),
      onRawGeneration: cfg.onRawGeneration as never,
      onPromptAssembled: cfg.onPromptAssembled as never,
    })

    // PORTABILITY SHIM (identical rationale to the Ollama factory). The harness's per-dispatch executor()
    // overrides are LiteRt-shaped ({sampler, toolCallParser, maxTokens, maxNumTokens, stream, autoAck}).
    // OpenAIChatCompletionsAdapter's options schema is `.unknown(false)` strict, so LiteRt-only keys throw
    // E_INVALID and the fail-open catch makes the planner silently return null → no plan → compute tools
    // never routed → the model can't call them. Translate the shape: keep valid OpenAI keys, map
    // maxTokens→num_predict-equivalent (the OpenAI adapter takes max output via its own option), drop the
    // LiteRt-only ones.
    const rawExecutor = adapter.executor.bind(adapter)
    const translateOverrides = (o: unknown): Record<string, unknown> => {
      if (!o || typeof o !== 'object') return {}
      const src = o as Record<string, unknown>
      const out: Record<string, unknown> = {}
      // Valid OpenAI-adapter top-level keys pass straight through — including contextWindow so the
      // overflow-retry ladder's per-dispatch window tightening reaches the adapter.
      for (const k of [
        'stream',
        'autoAck',
        'tokenEncoding',
        'contextWindow',
        'maxTokens',
      ] as const) {
        if (k in src) out[k] = src[k]
      }
      // Dropped (LiteRt-only, no OpenAI analogue): sampler, toolCallParser, reasoningParser, maxNumTokens,
      // toolDelivery, think/enableThinking (OpenAI Chat has no thinking toggle — reasoning models decide
      // themselves; we read their CoT via reasoningFieldPrecedence), helpers.renderArtifactHandleBody.
      return out
    }
    const shimmed = adapter as unknown as HarnessAdapter
    shimmed.executor = ((overrides?: unknown) =>
      rawExecutor(translateOverrides(overrides) as never)) as HarnessAdapter['executor']

    // MEASURE TOOLS AS THE WIRE SEES THEM. The subtractive pass measures the tools bucket via this renderer
    // so it agrees with THIS adapter's overflow guard. The OpenAI guard tallies
    // JSON.stringify(toolsToChatCompletionsTools(visible, {descriptionToChatCompletionsJsonSchema})) —
    // mirror it EXACTLY (same fn, same default description helper).
    shimmed.measureToolsAsText = (tools) =>
      JSON.stringify(
        toolsToChatCompletionsTools(tools as never, {
          descriptionToChatCompletionsJsonSchema: defaultDescriptionToChatCompletionsJsonSchema,
        })
      )
    // MEASURE TOOL RESULTS AS THE GUARD DOES — via renderChatCompletionsToolCallResult (wraps the body in
    // the tool + trust envelope), matching the guard's timeline tool-result contribution exactly. The
    // helper is ASYNC and may return a ChatCompletionsContentBlock[] (multimodal) rather than a plain
    // string; coerce to the string the pass measures by concatenating text-block `.text` (mirrors the
    // LiteRt path's measureToolResultAsText coercion). The measurement only needs a faithful token count.
    shimmed.measureToolResultAsText = async (tc: unknown): Promise<string> => {
      const rendered = await renderChatCompletionsToolCallResult({
        toolCall: tc as never,
        results: (tc as { results?: unknown }).results as never,
        tool: undefined,
        renderUntrustedContent: defaultRenderUntrustedContent,
        renderTrustedContent: defaultRenderTrustedContent,
        unsupportedMediaPolicy: 'synthetic-description',
        warn: () => undefined,
      })
      if (typeof rendered === 'string') return rendered
      // ChatCompletionsContentBlock[] → concatenate text parts (the token-bearing content the guard tallies).
      return (rendered as Array<{ type?: string; text?: string }>)
        .map((b) => (typeof b?.text === 'string' ? b.text : ''))
        .join('')
    }
    return shimmed
  }
}
