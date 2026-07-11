// Node-only AdapterFactory that backs the portable agent harness with the ADK Ollama battery instead of
// LiteRt/WebGPU. Same sampler as the flagship (temp 1.0 / top_p 0.95), thinking OFF (the flagship's default
// — thinking burns the tool loop). Tools are NATIVE to Ollama (no prompt-delivery parser), so the loop
// still receives ctx.turnToolCalls the same way.
//
// FIDELITY NOTE: Ollama GGUF-QAT weights + Ollama chat templating are NOT byte-identical to the flagship's
// LiteRt `.litertlm` + createConversation preface. Use this to measure RELATIVE pre/post-fix behaviour and
// which-gate-fires-on-what — not to reproduce absolute browser numbers. Final confirmation stays in-browser.
import { isError, isInstanceOf } from '@nhtio/adk/guards'
import { InMemorySpoolStore } from '@nhtio/adk/batteries/storage/in_memory'
import {
  OllamaAdapter,
  ollamaToolsFromTools,
  renderOllamaToolCallResult,
  defaultRenderTrustedContent,
  defaultRenderUntrustedContent,
  defaultDescriptionToChatCompletionsJsonSchema,
} from '@nhtio/adk/batteries/llm/ollama'
import type {
  AdapterFactory,
  HarnessAdapter,
} from '../../../docs/.vitepress/theme/components/agent/agent_runtime'

export interface OllamaFactoryConfig {
  /** Ollama model tag. Default matches the flagship tier: Gemma 4 E2B, QAT. */
  model?: string
  baseURL?: string
  /** Bearer API key for a hosted/cloud Ollama-compatible endpoint (local daemon needs none). */
  apiKey?: string
  /**
   * Token-count encoding. Default 'gemma' (the flagship tier). Use the matching family for a different
   * model — e.g. 'gemini' for gemini-3-flash-preview (gemma's counter would mis-count and mis-drive the
   * thrift budget). One of the canonical TokenEncoding identifiers.
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
  /** Fallback text tool-call parser family. Default 'gemma'. Set 'auto' for a mixed/unknown family. */
  localToolCallParser?: 'gemma' | 'auto' | 'none'
  /**
   * Dispatch-level retry on transport flakes (429/502/503/504) — absorbs an LB hiccup at the transport
   * layer so it never contaminates a turn's strategy measurement (the qwen lesson). The battery defaults
   * maxAttempts:1 (off); pass a real config to enable backoff-retry. Forwarded to the OllamaAdapter's
   * own `retry` option (chat_common RetryConfig shape).
   */
  retry?: {
    maxAttempts?: number
    baseDelayMs?: number
    maxDelayMs?: number
    retriableStatuses?: number[]
    honorRetryAfter?: boolean
  }
  // NOTE: there is deliberately NO guard-ceiling override. THE DECLARED CONTEXT WINDOW IS THE WALL — the
  // guard is (declared window − output reserve), full stop. A "wide open" run just declares a larger window
  // via setContextWindow(N); the guard follows it. No engine-cap backstop, no silent overshoot escape hatch.
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
  /** Optional tap over each /api/chat request body actually sent to Ollama (proves what hit the wire). */
  onRequestBody?: (body: Record<string, unknown>) => void
  /**
   * SPOOL-WRITE TAP. Fires every time a tool RESULT is spooled to the store, with the callId it's keyed
   * under and the byte length. This is the ADK-side view the HTTP dump is blind to: it shows exactly when a
   * result handle is (re-)minted and under which callId — the ground truth for callId-stability /
   * unread-handle-loop diagnosis. Records a monotonically increasing `writeSeq` so re-spools are visible.
   */
  onSpoolWrite?: (o: { callId: string; bytes: number; writeSeq: number }) => void
  /**
   * FULL DISPATCH DUMP. Fires once per /api/chat round-trip with the COMPLETE request body and the COMPLETE
   * response (the reassembled final message + the raw NDJSON chunks). This is the ground-truth evidence for
   * diagnostics — never infer from a truncated answer; read the dispatch. Wire it to a JSONL sink.
   */
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

// Wrap an InMemorySpoolStore so every write(callId, bytes) is reported before delegating. Captures the
// ADK-side spool events the HTTP dump can't see (when/which-callId a result handle is minted or re-minted).
function makeTappedSpoolStore(
  onSpoolWrite: NonNullable<OllamaFactoryConfig['onSpoolWrite']>
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
          : -1 // stream: length unknown until consumed
    try {
      onSpoolWrite({ callId, bytes: len, writeSeq: writeSeq++ })
    } catch {
      /* tap must never break a spool write */
    }
    return (origWrite as (c: string, b: unknown) => unknown)(callId, bytes)
  }
  return inner
}

export function makeOllamaAdapterFactory(cfg: OllamaFactoryConfig = {}): AdapterFactory {
  const model = cfg.model ?? 'gemma4:e2b-it-qat'
  const baseURL = cfg.baseURL ?? 'http://localhost:11434'
  const apiKey = cfg.apiKey
  const tokenEncoding = cfg.tokenEncoding ?? 'gemma'
  const localToolCallParser = cfg.localToolCallParser ?? 'gemma'
  const tapping = !!(cfg.onRequestBody || cfg.onDispatch)
  let dispatchSeq = 0
  // Fetch tap: capture the exact /api/chat request AND response so diagnostics read ground truth, not a
  // truncated answer. Ollama streams NDJSON, so we clone the response stream, let the adapter consume the
  // original untouched, and reassemble the full transcript off the clone.
  const tapFetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input as Request).url
    let reqBody: Record<string, unknown> | null = null
    if (url.includes('/api/chat') && typeof init?.body === 'string') {
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
    // tee: one branch back to the adapter, one to our reader.
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
        // Ollama returns NDJSON when stream:true (one object per line) and a SINGLE JSON object when
        // stream:false. Parse both: split into non-empty lines and JSON.parse each; a single-object body is
        // just the one-line case. Accumulate streamed content; capture tool_calls + done_reason from any obj.
        const contentParts: string[] = []
        let lastMsg: Record<string, unknown> | null = null
        for (const line of full.split('\n')) {
          const s = line.trim()
          if (!s) continue
          let obj: Record<string, unknown>
          try {
            obj = JSON.parse(s) as Record<string, unknown>
          } catch {
            continue
          }
          rec.chunks++
          const msg = obj.message as { content?: string; tool_calls?: unknown[] } | undefined
          if (msg) {
            lastMsg = msg as Record<string, unknown>
            if (typeof msg.content === 'string' && msg.content) contentParts.push(msg.content)
            if (Array.isArray(msg.tool_calls)) rec.toolCalls.push(...msg.tool_calls)
          }
          if (obj.done_reason) rec.doneReason = String(obj.done_reason)
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
    const adapter = new OllamaAdapter({
      model,
      baseURL,
      ...(apiKey ? { apiKey } : {}),
      fetch: tapping ? tapFetch : undefined,
      // Streaming (NDJSON) is the default. Set ADK_OLLAMA_STREAM=0 to force a single buffered response
      // (stream:false) — needed for a hosted endpoint that stalls mid-stream on long generations with no
      // client recovery (observed: deepseek-v4-flash think:true on deep corpus turns wedged the run; a
      // non-streamed request returns the full body or errors cleanly, no half-open stream to hang on).
      stream: process.env.ADK_OLLAMA_STREAM !== '0',
      // REQUEST TIMEOUT (ms). 0/unset = no timeout (the battery default). Set ADK_OLLAMA_REQUEST_TIMEOUT_MS
      // for a hosted endpoint that STALLS on long generations without ever returning — the fetch otherwise
      // hangs the whole run on one dispatch (observed: deepseek-v4-flash think:true on deep corpus turns; the
      // LB holds the connection open on a minutes-long think:true+big-prompt generation and neither errors
      // nor completes). With a timeout the battery aborts + surfaces a catchable error, so that TURN fails
      // but the run continues to 94 — turning a silent hang into honest partial data. The battery already
      // supports requestTimeoutMs (adapter Step 7 arms an abort timer); the factory just wires the env.
      ...(process.env.ADK_OLLAMA_REQUEST_TIMEOUT_MS
        ? { requestTimeoutMs: Number(process.env.ADK_OLLAMA_REQUEST_TIMEOUT_MS) }
        : {}),
      // Dispatch-level retry on transport flakes (forwarded from the factory config) — a flaked dispatch
      // retries with backoff so the turn continues intact; a turn only errors on a TERMINAL dispatch failure.
      ...(cfg.retry ? { retry: cfg.retry } : {}),
      // Thinking follows the harness's setEnableThinking() (opts.enableThinking) — same as the LiteRt
      // path (agent_runtime #ensureAdapter passes it through). Flagship DEFAULT is OFF (thinking burns
      // the tool loop), but honoring the opt lets the harness A/B thinking on vs off.
      think: opts.enableThinking,
      autoAck: false,
      tokenEncoding,
      // FIDELITY: the flagship's on-device (LiteRt) path parses tool calls out of TEXT via
      // toolCallParser:'auto', so it recovers Gemma's non-canonical call forms (`<call:name{…}`, a
      // ```json block, bare `name\nkey: value`). Ollama's native template only lifts the canonical form
      // into message.tool_calls and drops the rest into `content` — which made the Node harness LOSE
      // those calls and loop/overflow where the browser would have executed them. The native Ollama
      // battery now takes an opt-in `localToolCallParser` fallback (consulted only when the provider
      // returned no structured call); defaults to 'gemma' so the harness matches the browser's recovery,
      // overridable per-model (e.g. 'auto' for a non-Gemma family, or 'none' if it emits clean native calls).
      localToolCallParser,
      // NOTE: no forgeToolsFilter. Artifact readers are forged into ctx.tools by the CORE before the
      // subtractive pass runs, so the pass sees the full forged set and sheds exotic readers by budget rank —
      // no battery-side pre-narrowing needed on this path either.
      // THE WALL: the overflow guard is the user's DECLARED context window minus the output reserve —
      // full stop. NOT the engine cap. A prompt that doesn't fit the declared window overflows honestly
      // (typed E_OLLAMA_CONTEXT_OVERFLOW) rather than silently running up to the engine limit. The old
      // engine-cap guard (contextWindowMax − maxTokens) left a silent overshoot zone between the declared
      // window and the engine limit; the declared window is the only budget the user asked for.
      contextWindow: Math.max(2048, opts.contextWindow - opts.maxTokens),
      options: {
        temperature: 1.0,
        top_p: 0.95,
        num_predict: opts.maxTokens,
        // Keep the model resident between turns so the A/B isn't paying reload each generation.
        // (keepAlive is sent by the adapter; the value lives under the request, not options — set via
        // the adapter's own default. We rely on Ollama's default keep_alive here.)
      },
      spoolStore: cfg.onSpoolWrite
        ? makeTappedSpoolStore(cfg.onSpoolWrite)
        : new InMemorySpoolStore(),
      onRawGeneration: cfg.onRawGeneration as never,
      onPromptAssembled: cfg.onPromptAssembled as never,
    })
    // OllamaAdapter exposes executor(); it has no preload()/dispose() (no cold-load) — HarnessAdapter
    // treats those as optional.
    //
    // CRITICAL PORTABILITY SHIM. The flagship's per-dispatch executor() overrides are LiteRt-shaped:
    // the planner/classifier/specialist call executor({ sampler, toolCallParser, maxTokens, maxNumTokens,
    // stream, autoAck }). OllamaAdapter.validateOptions is `.unknown(false)` at the top level, so those
    // LiteRt-only keys throw E_INVALID_OLLAMA_OPTIONS — and every such call site is wrapped in a fail-open
    // catch, so the PLANNER silently returns null (no make_plan → no answer_kind → compute tools like
    // get_current_time/calculate never get routed into the worker's visible set → the model can't call
    // them). Translate the override shape here so those dispatches actually run: map maxTokens→
    // options.num_predict, keep the valid Ollama keys (stream/autoAck), drop the LiteRt-only ones.
    const rawExecutor = adapter.executor.bind(adapter)
    const translateOverrides = (o: unknown): Record<string, unknown> => {
      if (!o || typeof o !== 'object') return {}
      const src = o as Record<string, unknown>
      const out: Record<string, unknown> = {}
      // Valid Ollama top-level keys pass straight through — INCLUDING contextWindow, so a per-dispatch
      // guard override (the overflow-retry ladder tightening the declared window) actually reaches the
      // adapter instead of being dropped here.
      for (const k of [
        'stream',
        'autoAck',
        'think',
        'format',
        'tokenEncoding',
        'contextWindow',
      ] as const) {
        if (k in src) out[k] = src[k]
      }
      // enableThinking → think. The LiteRt path names the reasoning toggle `enableThinking`; Ollama's native
      // control is `think`. A PER-DISPATCH enableThinking override (e.g. the classifier forcing thinking OFF
      // for its 1-token verdict, regardless of the turn's global setting) must reach the Ollama adapter, or a
      // thinking model spends its single classifier token on reasoning noise and the loop spins (the observed
      // 307-dispatch qwen spin). Only map when explicitly present so it doesn't override the constructor
      // default on ordinary dispatches. `think` (if also present) wins — it's the native key.
      if ('enableThinking' in src && !('think' in src)) out.think = !!src.enableThinking
      // LiteRt output-cap → Ollama nested num_predict.
      const nested: Record<string, unknown> = {}
      if (typeof src.maxTokens === 'number') nested.num_predict = src.maxTokens
      if (Object.keys(nested).length > 0) out.options = nested
      // Dropped (LiteRt-only, no Ollama analogue): sampler, toolCallParser, reasoningParser,
      // maxNumTokens, toolDelivery, helpers.renderArtifactHandleBody.
      return out
    }
    const shimmed = adapter as unknown as HarnessAdapter
    shimmed.executor = ((overrides?: unknown) =>
      rawExecutor(translateOverrides(overrides) as never)) as HarnessAdapter['executor']
    // MEASURE TOOLS AS THE WIRE SEES THEM. The subtractive pass measures the tools bucket via this renderer
    // so it agrees with THIS adapter's overflow guard. Ollama sends tools as JSON schemas, and its guard
    // tallies `JSON.stringify(ollamaToolsFromTools(visible, {descriptionToChatCompletionsJsonSchema}))` —
    // mirror that EXACTLY here (same fn, same default description helper) so the pass counts the identical
    // string the guard counts. Without this the pass would measure the LiteRt prompt-text form (~half the
    // tokens) and stop shedding before the JSON guard is satisfied → overflow.
    shimmed.measureToolsAsText = (tools) =>
      JSON.stringify(
        ollamaToolsFromTools(tools as never, {
          descriptionToChatCompletionsJsonSchema: defaultDescriptionToChatCompletionsJsonSchema,
        })
      )
    // MEASURE TOOL RESULTS AS THE GUARD DOES. The Ollama overflow guard tallies each prior-turn tool result
    // via renderOllamaToolCallResult (which wraps the body in the tool_name + trust envelope). Mirror it
    // EXACTLY so the pass's toolCalls bucket equals the guard's timeline tool-result contribution. `tool` is
    // passed undefined: the envelope framing derives from the toolCall + results, not the tool definition,
    // and the guard resolves tool from ctx.tools purely for artifact-vs-plain body selection which the
    // result's own shape already determines. warn is a no-op (measurement must never throw).
    shimmed.measureToolResultAsText = (tc) =>
      renderOllamaToolCallResult({
        toolCall: tc as never,
        results: (tc as { results?: unknown }).results as never,
        tool: undefined,
        renderUntrustedContent: defaultRenderUntrustedContent,
        renderTrustedContent: defaultRenderTrustedContent,
        unsupportedMediaPolicy: 'synthetic-description',
        warn: () => undefined,
      })
    return shimmed
  }
}
